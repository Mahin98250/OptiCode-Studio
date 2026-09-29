export const OPTICAL_ACK_PREFIX = 'OTACK1:';
export const OPTICAL_ACK_WINDOW_BITS = 64;

export type OpticalAckState = 'streaming' | 'complete';
export type OpticalAckMode = 'compatibility' | 'fountain';

export type OpticalAck = {
  session: string;
  mode: OpticalAckMode;
  total: number;
  received: number;
  base: number;
  windowBits: number;
  bitmap: Uint8Array;
  sequence: number;
  state: OpticalAckState;
};

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
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function setAckBit(bitmap: Uint8Array, index: number, received: boolean) {
  if (index < 1) return;
  const offset = index - 1;
  const byte = offset >>> 3;
  const bit = offset & 7;
  if (byte < 0 || byte >= bitmap.length) return;
  if (received) bitmap[byte] |= (1 << bit);
  else bitmap[byte] &= ~(1 << bit);
}

export function getAckBit(bitmap: Uint8Array, index: number) {
  if (index < 1) return false;
  const offset = index - 1;
  const byte = offset >>> 3;
  const bit = offset & 7;
  return byte >= 0 && byte < bitmap.length && Boolean(bitmap[byte] & (1 << bit));
}

export function createAckPayload(input: {
  session: string;
  mode: OpticalAckMode;
  total: number;
  received: number;
  firstMissing: number;
  bitmap: Uint8Array;
  sequence: number;
  state: OpticalAckState;
}) {
  const total = Math.max(1, Math.floor(input.total));
  const safeReceived = Math.max(0, Math.min(total, Math.floor(input.received)));
  const maxBase = Math.max(1, total - OPTICAL_ACK_WINDOW_BITS + 1);
  const focus = Math.max(1, Math.min(total, Math.floor(input.firstMissing || 1)));
  const base = Math.max(1, Math.min(maxBase, focus - 8));
  const windowBits = Math.min(OPTICAL_ACK_WINDOW_BITS, total - base + 1);
  const windowBytes = new Uint8Array(Math.ceil(windowBits / 8));

  for (let offset = 0; offset < windowBits; offset += 1) {
    const absoluteIndex = base + offset;
    if (getAckBit(input.bitmap, absoluteIndex)) {
      setAckBit(windowBytes, offset + 1, true);
    }
  }

  return [
    OPTICAL_ACK_PREFIX + input.session,
    input.mode,
    total,
    safeReceived,
    base,
    windowBits,
    toBase64(windowBytes),
    Math.max(0, Math.floor(input.sequence)),
    input.state,
  ].join('|');
}

export function parseAckPayload(value: string): OpticalAck | null {
  const parts = value.split('|');
  if (!parts.length || !parts[0].startsWith(OPTICAL_ACK_PREFIX) || parts.length !== 9) return null;

  const session = parts[0].slice(OPTICAL_ACK_PREFIX.length);
  const mode = parts[1] as OpticalAckMode;
  const total = Number(parts[2]);
  const received = Number(parts[3]);
  const base = Number(parts[4]);
  const windowBits = Number(parts[5]);
  const bitmapRaw = parts[6];
  const sequence = Number(parts[7]);
  const state = parts[8] as OpticalAckState;

  if (
    !session ||
    (mode !== 'compatibility' && mode !== 'fountain') ||
    !Number.isInteger(total) ||
    !Number.isInteger(received) ||
    !Number.isInteger(base) ||
    !Number.isInteger(windowBits) ||
    !Number.isInteger(sequence) ||
    total < 1 ||
    received < 0 ||
    received > total ||
    base < 1 ||
    base > total ||
    windowBits < 1 ||
    windowBits > OPTICAL_ACK_WINDOW_BITS ||
    base + windowBits - 1 > total ||
    sequence < 0 ||
    (state !== 'streaming' && state !== 'complete')
  ) return null;

  try {
    const bitmap = fromBase64(bitmapRaw);
    if (bitmap.length !== Math.ceil(windowBits / 8)) return null;
    return { session, mode, total, received, base, windowBits, bitmap, sequence, state };
  } catch {
    return null;
  }
}

export function getAckMissingIndexes(ack: OpticalAck) {
  const missing: number[] = [];
  for (let offset = 0; offset < ack.windowBits; offset += 1) {
    const absoluteIndex = ack.base + offset;
    if (!getAckBit(ack.bitmap, offset + 1)) missing.push(absoluteIndex);
  }
  return missing;
}
