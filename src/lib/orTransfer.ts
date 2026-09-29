import { clearSession, getChunkIndexes, getChunks, getSession, putChunkAndCount, putSession } from './sessionStore';

export const OR_TRANSFER_PREFIX = 'ORX1:';
// Conservative MVP payload: smaller QR symbols are substantially easier for phone cameras to acquire reliably.
// Throughput optimization comes only after physical transfer is proven.
export const OR_TRANSFER_CHUNK_CHARS = 300;
export const OR_TRANSFER_BYTES_PER_FRAME = Math.floor((OR_TRANSFER_CHUNK_CHARS / 4) * 3);
// High-speed optical transfer: each displayed frame can carry multiple independent QR symbols.
// Keep optical payloads comfortably below QR version 40-L capacity so phone cameras have more decoding margin.
export const OR_TRANSFER_GRID_SIZE = 4;
export const OR_TRANSFER_MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_TRANSFER_FRAMES = Math.ceil(OR_TRANSFER_MAX_FILE_SIZE / OR_TRANSFER_BYTES_PER_FRAME);

function toBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes: Uint8Array) {
  const digestInput = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', digestInput as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
}

function encodeName(name: string) {
  return btoa(unescape(encodeURIComponent(name))).replace(/=/g, '');
}

function decodeName(name: string) {
  return decodeURIComponent(escape(atob(name)));
}

function sessionKey(session: string) {
  return `transfer:${session}`;
}

type TransferSession = {
  key: string;
  type: 'transfer';
  id: string;
  mime: string;
  name: string;
  size: number;
  hash: string;
  total: number;
  createdAt: number;
};

export type TransferFrame = {
  session:string;
  mime:string;
  name:string;
  size:number;
  hash:string;
  index:number;
  total:number;
  data:string;
};

export async function createTransfer(file: File) {
  if (file.size > OR_TRANSFER_MAX_FILE_SIZE) throw new Error('Choose a file smaller than 100 MB.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256(bytes);
  const session = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  // Generate frames on demand so the sender does not hold every QR payload
  // in memory at once.
  const bytesPerFrame = OR_TRANSFER_BYTES_PER_FRAME;
  const total = Math.max(1, Math.ceil(file.size / bytesPerFrame));

  if (total > MAX_TRANSFER_FRAMES) {
    throw new Error('This file would require too many QR frames. Choose a smaller file.');
  }

  const encodedName = encodeName(file.name);
  const mime = encodeURIComponent(file.type || 'application/octet-stream');

  return {
    session,
    hash,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    total,
    getFrame: (index: number) => {
      if (!Number.isInteger(index) || index < 1 || index > total) {
        throw new Error('Transfer frame index is out of range.');
      }

      const start = (index - 1) * bytesPerFrame;
      const end = Math.min(file.size, start + bytesPerFrame);
      // The full file bytes are already resident from createTransfer().
      // Avoid a second Blob/File read for every optical frame; this removes an
      // async storage-style round trip from the sender's hot path.
      const chunk = bytes.subarray(start, end);
      const encoded = toBase64(chunk);

      return `${OR_TRANSFER_PREFIX}${session}|${mime}|${encodedName}|${file.size}|${hash}|${index}|${total}|${encoded}`;
    },
  };
}

export function isTransferFrame(value:string) {
  return value.startsWith(OR_TRANSFER_PREFIX);
}

export function parseTransferFrame(value:string): TransferFrame | null {
  const parts=value.split('|');
  if (!isTransferFrame(value) || parts.length !== 8) return null;

  const [sessionRaw,mimeRaw,nameRaw,sizeRaw,hash,indexRaw,totalRaw,data]=parts;
  const session=sessionRaw.slice(OR_TRANSFER_PREFIX.length);
  const index=Number(indexRaw);
  const total=Number(totalRaw);
  const size=Number(sizeRaw);

  if (
    !session ||
    !mimeRaw ||
    !nameRaw ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    !Number.isInteger(size) ||
    index < 1 ||
    total < 1 ||
    index > total ||
    total > MAX_TRANSFER_FRAMES ||
    size < 0 ||
    size > OR_TRANSFER_MAX_FILE_SIZE ||
    (data.length > OR_TRANSFER_CHUNK_CHARS) ||
    (data.length === 0 && !(total === 1 && index === 1))
  ) return null;

  const expectedTotal = Math.max(1, Math.ceil(size / OR_TRANSFER_BYTES_PER_FRAME));
  if (total !== expectedTotal) return null;

  const expectedBytes = Math.min(
    OR_TRANSFER_BYTES_PER_FRAME,
    Math.max(0, size - (index - 1) * OR_TRANSFER_BYTES_PER_FRAME),
  );
  const expectedBase64Length = expectedBytes === 0 ? 0 : 4 * Math.ceil(expectedBytes / 3);
  if (data.length !== expectedBase64Length) return null;

  try {
    return {
      session,
      mime:decodeURIComponent(mimeRaw),
      name:decodeName(nameRaw),
      size,
      hash,
      index,
      total,
      data,
    };
  } catch {
    return null;
  }
}

export async function getTransferMissingFrames(session:string) {
  const key=sessionKey(session);
  const stored=await getSession(key);
  if (!stored || stored.type !== 'transfer') return [];

  const received=await getChunkIndexes(key);
  const have=new Set(received);
  const missing:number[]=[];
  for(let i=1;i<=stored.total;i++) {
    if(!have.has(i)) missing.push(i);
  }
  return missing;
}

export async function getTransferReceivedFrames(session:string) {
  const key=sessionKey(session);
  const stored=await getSession(key);
  if (!stored || stored.type !== 'transfer') return [];
  return getChunkIndexes(key);
}

export async function clearTransfer(session:string) {
  await clearSession(sessionKey(session));
}

export async function addTransferFrame(frame:TransferFrame) {
  const key=sessionKey(frame.session);
  const current=await getSession(key) as TransferSession | undefined;

  const compatible=current &&
    current.type === 'transfer' &&
    current.hash===frame.hash &&
    current.total===frame.total &&
    current.size===frame.size &&
    current.mime===frame.mime &&
    current.name===frame.name;

  const session:TransferSession = compatible
    ? current
    : {
      key,
      type:'transfer',
      id:frame.session,
      mime:frame.mime,
      name:frame.name,
      size:frame.size,
      hash:frame.hash,
      total:frame.total,
      createdAt:Date.now(),
    };

  if (current && !compatible) {
    throw new Error('This frame conflicts with an existing transfer session. Reset that session before starting another transfer.');
  }

  if (!compatible) await putSession(session);

  let storedChunk;
  try {
    // Write + count in one IndexedDB transaction. The optical receiver can
    // deliver several frames per camera cycle; avoiding a second transaction
    // removes avoidable storage round-trips from the hot path.
    storedChunk=await putChunkAndCount(key,frame.index,frame.data);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Unable to save the transfer frame.');
  }

  return {
    ...frame,
    received:storedChunk.received,
    complete:storedChunk.received===session.total,
    duplicate:storedChunk.duplicate,
    missingCount:Math.max(0,session.total-storedChunk.received),
  };
}

export async function reconstructTransfer(session:string) {
  const key=sessionKey(session);
  const state=await getSession(key) as TransferSession | undefined;
  if(!state || state.type !== 'transfer') return null;

  const chunks=await getChunks(key);
  if(chunks.length!==state.total) return null;

  chunks.sort((a,b)=>a.index-b.index);
  for(let i=0;i<chunks.length;i++) {
    if(chunks[i].index!==i+1) return null;
  }

  const bytes=new Uint8Array(state.size);
  let offset=0;

  for(const chunk of chunks) {
    let decoded:Uint8Array;
    try {
      decoded=fromBase64(chunk.data);
    } catch {
      throw new Error('The reconstructed file data is invalid. Rescan the missing frame(s).');
    }

    if(offset+decoded.length>bytes.length) {
      throw new Error('The reconstructed file is larger than expected. Restart the transfer.');
    }

    bytes.set(decoded,offset);
    offset+=decoded.length;
  }

  if(offset!==state.size || await sha256(bytes)!==state.hash) {
    throw new Error('Integrity verification failed. Rescan the missing frame(s).');
  }

  await clearSession(key);

  return {
    url:URL.createObjectURL(new Blob([bytes],{type:state.mime})),
    name:state.name,
    size:state.size,
    mime:state.mime,
  };
}
