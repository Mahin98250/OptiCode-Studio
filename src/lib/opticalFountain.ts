import { getOptiFrameDense4Capacity, OPTIFRAME_MAX_PAYLOAD } from './optiframe';
import { sha256Blob } from './sha256';

const MAGIC0 = 0x4f; // "O"
const MAGIC1 = 0x46; // "F"
const VERSION = 1;
const META_KIND = 0;
const DATA_KIND = 1;
const SYSTEMATIC_MASK = 0x80000000;
const RANDOM_MASK = 0x7fffffff;
const DATA_HEADER_BYTES = 28;
const META_HEADER_BYTES = 58;

export const OPTICAL_FOUNTAIN_BLOCK_BYTES = OPTIFRAME_MAX_PAYLOAD - DATA_HEADER_BYTES;
export const OPTICAL_FOUNTAIN_DENSE4_BLOCK_BYTES = Math.floor((getOptiFrameDense4Capacity() - DATA_HEADER_BYTES) / 4) * 4;
export const OPTICAL_FOUNTAIN_MAX_FILE_SIZE = 512 * 1024 * 1024;
export const OPTICAL_FOUNTAIN_META_INTERVAL_GROUPS = 32;
export const OPTICAL_FOUNTAIN_OVERHEAD = 0.16;

if (OPTICAL_FOUNTAIN_BLOCK_BYTES + DATA_HEADER_BYTES > OPTIFRAME_MAX_PAYLOAD) {
  throw new Error('Optical fountain block size exceeds the OptiFrame payload capacity.');
}

type MetaFrame = {
  kind: 'meta';
  version: number;
  session: string;
  size: number;
  totalBlocks: number;
  blockBytes: number;
  hash: string;
  name: string;
  mime: string;
};

type DataFrame = {
  kind: 'data';
  version: number;
  session: string;
  totalBlocks: number;
  blockBytes: number;
  seed: number;
  degree: number;
  data: Uint8Array;
};

export type OpticalFountainFrame = MetaFrame | DataFrame;

export type OpticalFountainPlan = {
  session: string;
  hash: string;
  name: string;
  mime: string;
  size: number;
  densityBits: 2 | 4;
  totalBlocks: number;
  blockBytes: number;
  cycleGroups: number;
  getCycleGroups: (laneCount?: 1 | 2 | 4 | 6 | 9 | 12 | 16) => number;
  getFrame: (lane: number, group: number, laneCount: 1 | 2 | 4 | 6 | 9 | 12 | 16) => Promise<Uint8Array>;
};

export type OpticalFountainReceiveState = {
  session: string;
  name: string;
  mime: string;
  size: number;
  totalBlocks: number;
  receivedBlocks: number;
  seenPackets: number;
  bytesRecovered: number;
  complete: boolean;
};

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function unhex(value: string) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return hex(new Uint8Array(digest));
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function text(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}

function writeU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, false);
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, false);
}

function writeU64Bytes(view: DataView, offset: number, bytes: Uint8Array) {
  for (let i = 0; i < 8; i += 1) view.setUint8(offset + i, bytes[i] ?? 0);
}

function readU16(view: DataView, offset: number) {
  return view.getUint16(offset, false);
}

function readU32(view: DataView, offset: number) {
  return view.getUint32(offset, false);
}

function readU64Bytes(view: DataView, offset: number) {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) out[i] = view.getUint8(offset + i);
  return out;
}

function randomSession() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function hashSession(session: string) {
  let hash = 2166136261;
  for (let i = 0; i < session.length; i += 1) {
    hash ^= session.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function xorshift32(seed: number) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function robustSolitonCdf(blocks: number) {
  const n = Math.max(1, blocks);
  if (n <= 2) return [1];

  const c = 0.10;
  const delta = 0.05;
  const r = c * Math.log(Math.max(2, n) / delta) * Math.sqrt(n);
  const pivot = Math.max(1, Math.floor(n / Math.max(1, r)));
  const tau = new Float64Array(n);

  for (let degree = 1; degree < pivot && degree <= n; degree += 1) {
    tau[degree - 1] = r / (degree * n);
  }
  if (pivot >= 1 && pivot <= n) {
    tau[pivot - 1] = r * Math.log(Math.max(1, r / delta)) / n;
  }

  const weights = new Float64Array(n);
  weights[0] = 1 / n + tau[0];
  for (let degree = 2; degree <= n; degree += 1) {
    weights[degree - 1] = 1 / (degree * (degree - 1)) + tau[degree - 1];
  }

  let total = 0;
  for (const weight of weights) total += weight;
  const cdf = new Float64Array(n);
  let running = 0;
  for (let i = 0; i < n; i += 1) {
    running += weights[i] / total;
    cdf[i] = running;
  }
  cdf[n - 1] = 1;
  return cdf;
}

function degreeFromSeed(seed: number, blocks: number, cdf: ArrayLike<number>) {
  if (blocks <= 2) return 1;
  const u = xorshift32(seed)();
  let low = 0;
  let high = cdf.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (u <= cdf[mid]) high = mid;
    else low = mid + 1;
  }
  return Math.min(blocks, low + 1);
}

function indexesFor(seed: number, blocks: number, degree: number) {
  if (degree === 1 && (seed >>> 0) >= SYSTEMATIC_MASK) return [seed & RANDOM_MASK];

  const random = xorshift32(seed);
  const chosen = new Set<number>();
  const target = Math.min(Math.max(1, degree), blocks);
  while (chosen.size < target) chosen.add(Math.floor(random() * blocks));
  return [...chosen];
}

function xorInto(target: Uint8Array, source: Uint8Array) {
  const words = Math.min(target.byteLength, source.byteLength) >>> 2;
  if (words > 0) {
    const target32 = new Uint32Array(target.buffer, target.byteOffset, words);
    const source32 = new Uint32Array(source.buffer, source.byteOffset, words);
    for (let index = 0; index < words; index += 1) target32[index] ^= source32[index];
  }
  for (let index = words * 4; index < Math.min(target.byteLength, source.byteLength); index += 1) {
    target[index] ^= source[index];
  }
}

function createDataPacket(
  sessionBytes: Uint8Array,
  totalBlocks: number,
  blockBytes: number,
  seed: number,
  degree: number,
  data: Uint8Array,
) {
  const packet = new Uint8Array(DATA_HEADER_BYTES + data.length);
  const view = new DataView(packet.buffer);
  packet[0] = MAGIC0;
  packet[1] = MAGIC1;
  packet[2] = VERSION;
  packet[3] = DATA_KIND;
  packet[4] = 0;
  packet[5] = 0;
  writeU64Bytes(view, 6, sessionBytes);
  writeU32(view, 14, totalBlocks);
  writeU16(view, 18, blockBytes);
  writeU32(view, 20, seed);
  writeU16(view, 24, degree);
  writeU16(view, 26, data.length);
  packet.set(data, DATA_HEADER_BYTES);
  return packet;
}

function createMetaPacket(
  sessionBytes: Uint8Array,
  size: number,
  totalBlocks: number,
  blockBytes: number,
  hash: Uint8Array,
  name: Uint8Array,
  mime: Uint8Array,
) {
  const packet = new Uint8Array(META_HEADER_BYTES + name.length + mime.length);
  const view = new DataView(packet.buffer);
  packet[0] = MAGIC0;
  packet[1] = MAGIC1;
  packet[2] = VERSION;
  packet[3] = META_KIND;
  writeU64Bytes(view, 4, sessionBytes);
  writeU32(view, 12, size);
  writeU32(view, 16, totalBlocks);
  writeU16(view, 20, blockBytes);
  packet.set(hash.subarray(0, 32), 22);
  writeU16(view, 54, name.length);
  writeU16(view, 56, mime.length);
  packet.set(name, META_HEADER_BYTES);
  packet.set(mime, META_HEADER_BYTES + name.length);
  return packet;
}

export function parseOpticalFountainFrame(packet: Uint8Array): OpticalFountainFrame | null {
  if (packet.length < 4 || packet[0] !== MAGIC0 || packet[1] !== MAGIC1 || packet[2] !== VERSION) return null;
  const kind = packet[3];
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  try {
    if (kind === DATA_KIND) {
      if (packet.length < DATA_HEADER_BYTES) return null;
      const sessionBytes = readU64Bytes(view, 6);
      const totalBlocks = readU32(view, 14);
      const blockBytes = readU16(view, 18);
      const seed = readU32(view, 20);
      const degree = readU16(view, 24);
      const dataLength = readU16(view, 26);
      if (
        blockBytes !== OPTICAL_FOUNTAIN_BLOCK_BYTES && blockBytes !== OPTICAL_FOUNTAIN_DENSE4_BLOCK_BYTES ||
        totalBlocks < 1 ||
        dataLength !== blockBytes ||
        degree < 1 ||
        degree > totalBlocks ||
        packet.length !== DATA_HEADER_BYTES + dataLength
      ) return null;

      return {
        kind: 'data',
        version: VERSION,
        session: hex(sessionBytes),
        totalBlocks,
        blockBytes,
        seed,
        degree,
        data: packet.slice(DATA_HEADER_BYTES),
      };
    }

    if (kind === META_KIND) {
      if (packet.length < META_HEADER_BYTES) return null;
      const session = hex(readU64Bytes(view, 4));
      const size = readU32(view, 12);
      const totalBlocks = readU32(view, 16);
      const blockBytes = readU16(view, 20);
      const hash = hex(packet.subarray(22, 54));
      const nameLength = readU16(view, 54);
      const mimeLength = readU16(view, 56);
      const payloadStart = META_HEADER_BYTES;
      if (
        blockBytes !== OPTICAL_FOUNTAIN_BLOCK_BYTES && blockBytes !== OPTICAL_FOUNTAIN_DENSE4_BLOCK_BYTES ||
        totalBlocks < 1 ||
        totalBlocks > Math.ceil(OPTICAL_FOUNTAIN_MAX_FILE_SIZE / OPTICAL_FOUNTAIN_BLOCK_BYTES) ||
        size > OPTICAL_FOUNTAIN_MAX_FILE_SIZE ||
        packet.length !== payloadStart + nameLength + mimeLength ||
        totalBlocks !== Math.max(1, Math.ceil(size / blockBytes))
      ) return null;

      const name = text(packet.subarray(payloadStart, payloadStart + nameLength));
      const mime = text(packet.subarray(payloadStart + nameLength, payloadStart + nameLength + mimeLength));
      if (!name || !mime || hash.length !== 64) return null;
      return {
        kind: 'meta',
        version: VERSION,
        session,
        size,
        totalBlocks,
        blockBytes,
        hash,
        name,
        mime,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export async function createOpticalFountainTransfer(
  file: File,
  options: { densityBits?: 2 | 4 } = {},
): Promise<OpticalFountainPlan> {
  if (file.size > OPTICAL_FOUNTAIN_MAX_FILE_SIZE) {
    throw new Error('High-speed OptiFrame fountain mode supports files up to 512 MB.');
  }

  const densityBits = options.densityBits === 4 ? 4 : 2;
  const blockBytes = densityBits === 4 ? OPTICAL_FOUNTAIN_DENSE4_BLOCK_BYTES : OPTICAL_FOUNTAIN_BLOCK_BYTES;
  // Keep the source file browser-backed. The transfer plan no longer materializes
  // the complete file into a second Uint8Array; packets read only the source
  // blocks needed for the current optical frame.
  const digest = await sha256Blob(file);
  const session = randomSession();
  const sessionBytes = unhex(session);
  const sessionSeed = hashSession(session);
  const name = file.name || 'received-file';
  const mime = file.type || 'application/octet-stream';
  const nameBytes = utf8(name);
  const mimeBytes = utf8(mime);

  if (nameBytes.length > 2000 || mimeBytes.length > 512) throw new Error('File metadata is too large.');

  const totalBlocks = Math.max(1, Math.ceil(file.size / blockBytes));
  const degreeCdf = robustSolitonCdf(totalBlocks);

  const recommendedPackets = Math.max(
    totalBlocks + 4,
    Math.ceil(totalBlocks * (1 + OPTICAL_FOUNTAIN_OVERHEAD)),
  );

  const getCycleGroups = (laneCount: 1 | 2 | 4 | 6 | 9 | 12 | 16 = 4) => {
    const activeLanes = laneCount === 1 || laneCount === 2 || laneCount === 4 || laneCount === 6 || laneCount === 9 || laneCount === 12 || laneCount === 16 ? laneCount : 4;
    return Math.max(1, Math.ceil(recommendedPackets / activeLanes));
  };

  const packetCache = new Map<string, Uint8Array>();
  const packetInFlight = new Map<string, Promise<Uint8Array>>();
  const sourceBlockCache = new Map<number, Uint8Array>();
  const sourceBlockInFlight = new Map<number, Promise<Uint8Array>>();
  const SOURCE_BLOCK_CACHE_LIMIT = 96;

  const cacheBlock = (index: number, block: Uint8Array) => {
    sourceBlockCache.delete(index);
    sourceBlockCache.set(index, block);
    while (sourceBlockCache.size > SOURCE_BLOCK_CACHE_LIMIT) {
      const oldest = sourceBlockCache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      sourceBlockCache.delete(oldest);
    }
    return block;
  };

  const readSourceBlock = async (index: number) => {
    const cached = sourceBlockCache.get(index);
    if (cached) {
      sourceBlockCache.delete(index);
      sourceBlockCache.set(index, cached);
      return cached;
    }

    const pending = sourceBlockInFlight.get(index);
    if (pending) return pending;

    const promise = (async () => {
      const block = new Uint8Array(blockBytes);
      const start = index * blockBytes;
      const end = Math.min(file.size, start + blockBytes);
      if (end > start) {
        const source = new Uint8Array(await file.slice(start, end).arrayBuffer());
        block.set(source);
      }
      return cacheBlock(index, block);
    })().finally(() => {
      sourceBlockInFlight.delete(index);
    });

    sourceBlockInFlight.set(index, promise);
    return promise;
  };

  const cachePacket = (key: string, packet: Uint8Array) => {
    packetCache.delete(key);
    packetCache.set(key, packet);
    while (packetCache.size > 64) {
      const oldest = packetCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      packetCache.delete(oldest);
    }
    return packet;
  };

  const getFrame = (lane = 0, group = 0, laneCount: 1 | 2 | 4 | 6 | 9 | 12 | 16 = 4): Promise<Uint8Array> => {
    const activeLanes = laneCount === 1 || laneCount === 2 || laneCount === 4 || laneCount === 6 || laneCount === 9 || laneCount === 12 || laneCount === 16 ? laneCount : 4;
    const normalizedLane = ((lane % activeLanes) + activeLanes) % activeLanes;
    const normalizedGroup = Math.max(0, Math.floor(group));
    const cacheKey = normalizedGroup + ':' + normalizedLane + ':' + activeLanes;
    const cachedPacket = packetCache.get(cacheKey);
    if (cachedPacket) return Promise.resolve(cachedPacket);

    const existing = packetInFlight.get(cacheKey);
    if (existing) return existing;

    const promise = (async () => {
      const groupsPerCycle = getCycleGroups(activeLanes);
      const cycleIndex = Math.floor(normalizedGroup / groupsPerCycle);
      const groupInCycle = normalizedGroup % groupsPerCycle;
      const cyclePacketCount = groupsPerCycle * activeLanes;
      const slot = groupInCycle * activeLanes + normalizedLane;

      // Every cycle starts with the same systematic source sweep so a receiver
      // can join at any time. The repair tail gets fresh deterministic droplets
      // on every cycle instead of replaying the same repair groups forever.
      const systematic = slot < totalBlocks;
      let seed: number;
      let degree: number;
      if (systematic) {
        seed = (SYSTEMATIC_MASK | slot) >>> 0;
        degree = 1;
      } else {
        const repairOrdinal = cycleIndex * Math.max(1, cyclePacketCount - totalBlocks) + (slot - totalBlocks);
        seed = (Math.imul(repairOrdinal & RANDOM_MASK, 0x45d9f3b) ^ (sessionSeed & RANDOM_MASK)) & RANDOM_MASK;
        if (seed === 0) seed = 0x1f123bb5;
        degree = degreeFromSeed(seed, totalBlocks, degreeCdf);

        if (
          normalizedLane === 0 &&
          (slot - totalBlocks) % OPTICAL_FOUNTAIN_META_INTERVAL_GROUPS === 0
        ) {
          return cachePacket(
            cacheKey,
            createMetaPacket(sessionBytes, file.size, totalBlocks, blockBytes, digest, nameBytes, mimeBytes),
          );
        }
      }

      const packet = createDataPacket(
        sessionBytes,
        totalBlocks,
        blockBytes,
        seed,
        degree,
        new Uint8Array(blockBytes),
      );
      const payload = packet.subarray(DATA_HEADER_BYTES);

      if (systematic) {
        payload.set(await readSourceBlock(slot));
      } else {
        const indexes = indexesFor(seed, totalBlocks, degree);
        const blocks = await Promise.all(indexes.map(index => readSourceBlock(index)));
        for (const block of blocks) xorInto(payload, block);
      }

      return cachePacket(cacheKey, packet);
    })().finally(() => {
      packetInFlight.delete(cacheKey);
    });

    packetInFlight.set(cacheKey, promise);
    return promise;
  };

  return {
    session,
    hash: hex(digest),
    name,
    mime,
    size: file.size,
    totalBlocks,
    blockBytes,
    densityBits,
    cycleGroups: getCycleGroups(4),
    getCycleGroups,
    getFrame,
  };
}

type Equation = { indexes: Set<number>; data: Uint8Array };

type MetaState = {
  session: string;
  name: string;
  mime: string;
  size: number;
  totalBlocks: number;
  blockBytes: number;
  hash: string;
};

export class OpticalFountainDecoder {
  private meta: MetaState | null = null;
  private activeSession = '';
  private totalBlocks = 0;
  private blockBytes = OPTICAL_FOUNTAIN_BLOCK_BYTES;
  private readonly equations = new Map<number, Equation>();
  private readonly blockToEquations = new Map<number, Set<number>>();
  // Store solved source blocks in one contiguous allocation rather than one
  // Uint8Array per block. This removes tens of thousands of JS map/object
  // entries for large transfers and lets reconstruction return a zero-copy
  // view instead of allocating a second full-size file.
  private solvedBytes: Uint8Array | null = null;
  private solvedBits = new Uint8Array(0);
  private solvedCount = 0;
  private readonly seenSeeds = new Set<number>();
  // Bound repair-equation memory separately from solved source blocks. A fixed
  // byte budget scales naturally between 2-bit and 4-bit blocks.
  private maxBufferedEquations = 2048;

  reset() {
    this.meta = null;
    this.activeSession = '';
    this.totalBlocks = 0;
    this.blockBytes = OPTICAL_FOUNTAIN_BLOCK_BYTES;
    this.equations.clear();
    this.blockToEquations.clear();
    this.solvedBytes = null;
    this.solvedBits = new Uint8Array(0);
    this.solvedCount = 0;
    this.seenSeeds.clear();
    this.maxBufferedEquations = 2048;
  }

  add(frame: OpticalFountainFrame) {
    if (frame.kind === 'meta') {
      if (frame.size > OPTICAL_FOUNTAIN_MAX_FILE_SIZE) throw new Error('Optical fountain file is too large.');
      if (this.activeSession && this.activeSession !== frame.session) {
        return { ...this.snapshot(false), metaConflict: true };
      }
      this.activeSession = frame.session;
      this.meta = frame;
      this.totalBlocks = frame.totalBlocks;
      this.blockBytes = frame.blockBytes;
      this.maxBufferedEquations = Math.min(16384, Math.max(512, Math.floor((32 * 1024 * 1024) / this.blockBytes)));
      this.ensureSolvedStorage();
      return this.snapshot(false);
    }

    if ((frame.blockBytes !== OPTICAL_FOUNTAIN_BLOCK_BYTES && frame.blockBytes !== OPTICAL_FOUNTAIN_DENSE4_BLOCK_BYTES) || frame.totalBlocks < 1 || frame.totalBlocks > Math.ceil(OPTICAL_FOUNTAIN_MAX_FILE_SIZE / Math.min(OPTICAL_FOUNTAIN_BLOCK_BYTES, OPTICAL_FOUNTAIN_DENSE4_BLOCK_BYTES))) {
      return this.snapshot(false);
    }

    if (this.activeSession && this.activeSession !== frame.session) {
      return { ...this.snapshot(false), metaConflict: true };
    }

    if (this.meta && (this.meta.session !== frame.session || this.meta.totalBlocks !== frame.totalBlocks || this.meta.blockBytes !== frame.blockBytes)) {
      return { ...this.snapshot(false), metaConflict: true };
    }

    if (!this.totalBlocks) {
      this.activeSession = frame.session;
      this.totalBlocks = frame.totalBlocks;
      this.blockBytes = frame.blockBytes;
      this.meta = null;
      this.maxBufferedEquations = Math.min(16384, Math.max(512, Math.floor((32 * 1024 * 1024) / this.blockBytes)));
      this.ensureSolvedStorage();
    }

    if (this.seenSeeds.has(frame.seed)) return this.snapshot(true);
    this.seenSeeds.add(frame.seed);

    const indexes = new Set(indexesFor(frame.seed, frame.totalBlocks, frame.degree));
    if (indexes.size !== frame.degree) return this.snapshot(false);

    const equation: Equation = { indexes, data: frame.data.slice() };
    this.reduce(equation);

    if (equation.indexes.size === 0) return this.snapshot(false);

    if (equation.indexes.size === 1) {
      const index = [...equation.indexes][0];
      this.solve(index, equation.data);
    } else if (this.equations.size < this.maxBufferedEquations || equation.indexes.size <= 2) {
      this.equations.set(frame.seed, equation);
      for (const index of equation.indexes) {
        let set = this.blockToEquations.get(index);
        if (!set) {
          set = new Set<number>();
          this.blockToEquations.set(index, set);
        }
        set.add(frame.seed);
      }
    }

    return this.snapshot(false);
  }

  private ensureSolvedStorage() {
    const requiredBytes = Math.max(
      this.blockBytes,
      this.totalBlocks * this.blockBytes,
    );
    if (
      this.solvedBytes &&
      this.solvedBytes.byteLength >= requiredBytes &&
      this.solvedBits.length >= Math.ceil(this.totalBlocks / 8)
    ) return;

    const previousBytes = this.solvedBytes;
    const previousBits = this.solvedBits;
    const nextBytes = new Uint8Array(requiredBytes);
    if (previousBytes) nextBytes.set(previousBytes.subarray(0, Math.min(previousBytes.length, nextBytes.length)));
    const nextBits = new Uint8Array(Math.ceil(this.totalBlocks / 8));
    nextBits.set(previousBits.subarray(0, Math.min(previousBits.length, nextBits.length)));
    this.solvedBytes = nextBytes;
    this.solvedBits = nextBits;
  }

  private isSolved(index: number) {
    if (index < 0 || index >= this.totalBlocks) return false;
    return Boolean(this.solvedBits[index >>> 3] & (1 << (index & 7)));
  }

  private getSolved(index: number) {
    if (!this.solvedBytes || !this.isSolved(index)) return null;
    const start = index * this.blockBytes;
    return this.solvedBytes.subarray(start, start + this.blockBytes);
  }

  private solve(index: number, block: Uint8Array) {
    if (this.isSolved(index)) return;
    this.ensureSolvedStorage();
    const target = this.solvedBytes!.subarray(
      index * this.blockBytes,
      index * this.blockBytes + this.blockBytes,
    );
    target.fill(0);
    target.set(block.subarray(0, target.length));
    this.solvedBits[index >>> 3] |= 1 << (index & 7);
    this.solvedCount += 1;

    const connected = [...(this.blockToEquations.get(index) ?? [])];
    for (const seed of connected) {
      const equation = this.equations.get(seed);
      if (!equation) continue;
      xorInto(equation.data, target);
      equation.indexes.delete(index);
      if (equation.indexes.size === 0) {
        this.detach(seed, equation);
      } else if (equation.indexes.size === 1) {
        const only = [...equation.indexes][0];
        const candidate = equation.data.slice();
        this.detach(seed, equation);
        this.solve(only, candidate);
      }
    }
    this.blockToEquations.delete(index);
  }

  private reduce(equation: Equation) {
    for (const index of [...equation.indexes]) {
      const block = this.getSolved(index);
      if (!block) continue;
      xorInto(equation.data, block);
      equation.indexes.delete(index);
    }
  }

  private detach(seed: number, equation: Equation) {
    this.equations.delete(seed);
    for (const index of equation.indexes) {
      const set = this.blockToEquations.get(index);
      if (!set) continue;
      set.delete(seed);
      if (set.size === 0) this.blockToEquations.delete(index);
    }
  }

  snapshot(duplicate = false): OpticalFountainReceiveState & { duplicate: boolean; metaConflict?: boolean } {
    return {
      session: this.activeSession,
      name: this.meta?.name ?? 'OptiFrame transfer',
      mime: this.meta?.mime ?? 'application/octet-stream',
      size: this.meta?.size ?? this.totalBlocks * this.blockBytes,
      totalBlocks: this.totalBlocks,
      receivedBlocks: this.solvedCount,
      seenPackets: this.seenSeeds.size,
      bytesRecovered: Math.min(this.meta?.size ?? this.solvedCount * this.blockBytes, this.solvedCount * this.blockBytes),
      complete: Boolean(this.meta && this.totalBlocks > 0 && this.solvedCount === this.totalBlocks),
      duplicate,
    };
  }

  async reconstruct() {
    if (!this.meta || this.solvedCount !== this.totalBlocks || !this.solvedBytes) return null;
    const bytes = this.solvedBytes.subarray(0, this.meta.size);
    for (let index = 0; index < this.totalBlocks; index += 1) {
      if (!this.isSolved(index)) return null;
    }
    const hash = await sha256(bytes);
    if (hash !== this.meta.hash) throw new Error('Optical fountain integrity verification failed.');
    return {
      name: this.meta.name,
      mime: this.meta.mime,
      size: this.meta.size,
      hash,
      bytes,
    };
  }
}

export function opticalFountainTheoreticalBytesPerGroup(laneCount: 1 | 2 | 4 | 6) {
  return OPTICAL_FOUNTAIN_BLOCK_BYTES * laneCount;
}

export function opticalFountainFrameCrc(frame: Uint8Array) {
  return crc32(frame);
}
