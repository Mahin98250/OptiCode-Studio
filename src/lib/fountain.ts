const FOUNTAIN_PREFIX = 'ORF2:';
const LEGACY_FOUNTAIN_PREFIX = 'ORF1:';

// High-density optical source blocks. The 32-bit seed is deliberately
// deterministic so long-running streams do not depend on Math.random() or
// wrap/repeat after the recommended packet count.
export const FOUNTAIN_BLOCK_BYTES = 1200;
export const FOUNTAIN_GRID_SIZE = 4;
export const FOUNTAIN_MAX_FILE_SIZE = 64 * 1024 * 1024;
export const FOUNTAIN_OVERHEAD = 0.18;

const SYSTEMATIC_SEED_MASK = 0x80000000;
const RANDOM_SEED_MASK = 0x7fffffff;

export type FountainPlan = {
  session: string;
  hash: string;
  name: string;
  mime: string;
  size: number;
  blocks: number;
  blockBytes: number;
  recommended: number;
  getDroplet: (lane?: number, sequence?: number, laneCount?: 1 | 2 | 4) => string;
};

export type FountainDroplet = {
  session: string;
  mime: string;
  name: string;
  size: number;
  hash: string;
  blocks: number;
  blockBytes: number;
  seed: number;
  degree: number;
  data: string;
  version: 1 | 2;
};

type Equation = { indexes: Set<number>; data: Uint8Array };

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crcHex(value: number) {
  return value.toString(16).padStart(8, '0');
}

function withFrameIntegrity(bytes: Uint8Array) {
  return b64(bytes) + '.' + crcHex(crc32(bytes));
}

function parseFrameIntegrity(value: string) {
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator >= value.length - 1) return null;
  const encoded = value.slice(0, separator);
  const crc = value.slice(separator + 1).toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(crc)) return null;
  try {
    const bytes = unb64(encoded);
    return crcHex(crc32(bytes)) === crc ? bytes : null;
  } catch {
    return null;
  }
}

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(value: string) {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256(bytes: Uint8Array) {
  const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', input as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
}

function encodeName(name: string) {
  return btoa(unescape(encodeURIComponent(name))).replace(/=/g, '');
}

function decodeName(name: string) {
  return decodeURIComponent(escape(atob(name)));
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

function hashSession(session: string) {
  let hash = 2166136261;
  for (let i = 0; i < session.length; i += 1) {
    hash ^= session.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function mix32(value: number) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function randomSeed(sessionHash: number, sequence: number, lane: number) {
  // Multiplication by an odd number is a permutation modulo 2^31.
  // The stream therefore has deterministic, non-repeating seeds for the
  // practical sequence range used by browser transfers.
  const slot = (sequence * FOUNTAIN_GRID_SIZE + lane) >>> 0;
  return (Math.imul(slot & RANDOM_SEED_MASK, 0x45d9f3b) ^ (sessionHash & RANDOM_SEED_MASK)) & RANDOM_SEED_MASK;
}

function robustSolitonCdf(blocks: number) {
  const n = Math.max(1, blocks);
  if (n <= 2) return [1];

  // Robust soliton distribution:
  // rho(1)=1/n, rho(d)=1/[d(d-1)] for d>1,
  // tau adds the stabilization spike around R = c*ln(n/delta)*sqrt(n).
  const c = 0.10;
  const delta = 0.05;
  const r = c * Math.log(Math.max(2, n) / delta) * Math.sqrt(n);
  const pivot = Math.max(1, Math.floor(n / Math.max(1, r)));
  const tau = new Array<number>(n).fill(0);

  for (let d = 1; d < pivot && d <= n; d += 1) {
    tau[d - 1] = r / (d * n);
  }
  if (pivot >= 1 && pivot <= n) {
    tau[pivot - 1] = r * Math.log(Math.max(1, r / delta)) / n;
  }

  const weights = new Array<number>(n);
  weights[0] = 1 / n + tau[0];
  for (let d = 2; d <= n; d += 1) {
    weights[d - 1] = 1 / (d * (d - 1)) + tau[d - 1];
  }

  const total = weights.reduce((sum, value) => sum + value, 0);
  const cdf = new Array<number>(n);
  let running = 0;
  for (let i = 0; i < n; i += 1) {
    running += weights[i] / total;
    cdf[i] = running;
  }
  cdf[n - 1] = 1;
  return cdf;
}

function degreeFromSeed(seed: number, blocks: number, cdf: number[]) {
  if (blocks <= 2) return 1;
  const random = xorshift32(seed);
  const u = random();
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
  if (degree === 1 && (seed >>> 0) >= SYSTEMATIC_SEED_MASK) return [seed & RANDOM_SEED_MASK];
  const random = xorshift32(seed);
  const chosen = new Set<number>();
  const target = Math.min(Math.max(1, degree), blocks);
  while (chosen.size < target) chosen.add(Math.floor(random() * blocks));
  return [...chosen];
}

function xorInto(target: Uint8Array, source: Uint8Array) {
  for (let i = 0; i < target.length; i += 1) target[i] ^= source[i] || 0;
}

function normalizeBlock(bytes: Uint8Array, blockBytes: number) {
  const out = new Uint8Array(blockBytes);
  out.set(bytes.subarray(0, blockBytes));
  return out;
}

export async function createFountainTransfer(file: File): Promise<FountainPlan> {
  if (file.size > FOUNTAIN_MAX_FILE_SIZE) {
    throw new Error('High-speed fountain mode supports files up to 64 MB. Use compatibility mode for larger files.');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256(bytes);
  const session = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const blocks = Math.max(1, Math.ceil(file.size / FOUNTAIN_BLOCK_BYTES));
  const encodedName = encodeName(file.name);
  const mime = encodeURIComponent(file.type || 'application/octet-stream');
  const sessionHash = hashSession(session);
  const degreeCdf = robustSolitonCdf(blocks);
  const recommended = Math.max(blocks + 4, Math.ceil(blocks * (1 + FOUNTAIN_OVERHEAD)));

  return {
    session,
    hash,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    blocks,
    blockBytes: FOUNTAIN_BLOCK_BYTES,
    recommended,

    getDroplet: (lane = 0, sequence = 0, laneCount = FOUNTAIN_GRID_SIZE) => {
      const normalizedLane = ((lane % FOUNTAIN_GRID_SIZE) + FOUNTAIN_GRID_SIZE) % FOUNTAIN_GRID_SIZE;
      const normalizedSequence = Math.max(0, Math.floor(sequence));
      const activeLaneCount: 1 | 2 | 4 = laneCount === 1 || laneCount === 2 || laneCount === 4
        ? laneCount
        : FOUNTAIN_GRID_SIZE;

      // With fewer than four display lanes, keep every visible lane
      // systematic so a phone can always make forward progress. The sender
      // loops forever, so missed blocks are re-sent with the same source seed
      // until the receiver gets them. Four-lane desktop streams retain the
      // higher-throughput systematic + coded split.
      const compactDisplay = activeLaneCount < FOUNTAIN_GRID_SIZE;
      const systematic = compactDisplay || normalizedLane < 2;
      if (systematic) {
        const slot = activeLaneCount < FOUNTAIN_GRID_SIZE
          ? normalizedSequence * activeLaneCount + normalizedLane
          : normalizedSequence * 2 + normalizedLane;
        const target = (slot % blocks) >>> 0;
        const seed = (SYSTEMATIC_SEED_MASK | target) >>> 0;
        const degree = 1;
        const start = target * FOUNTAIN_BLOCK_BYTES;
        const payload = normalizeBlock(
          bytes.subarray(start, Math.min(bytes.length, start + FOUNTAIN_BLOCK_BYTES)),
          FOUNTAIN_BLOCK_BYTES,
        );
        return [
          FOUNTAIN_PREFIX + session,
          mime,
          encodedName,
          file.size,
          hash,
          blocks,
          FOUNTAIN_BLOCK_BYTES,
          seed,
          degree,
          withFrameIntegrity(payload),
        ].join('|');
      }

      const seed = randomSeed(sessionHash, normalizedSequence, normalizedLane);
      const degree = degreeFromSeed(seed, blocks, degreeCdf);
      const indexes = indexesFor(seed, blocks, degree);
      const payload = new Uint8Array(FOUNTAIN_BLOCK_BYTES);
      for (const index of indexes) {
        const start = index * FOUNTAIN_BLOCK_BYTES;
        xorInto(
          payload,
          bytes.subarray(start, Math.min(bytes.length, start + FOUNTAIN_BLOCK_BYTES)),
        );
      }

      return [
        FOUNTAIN_PREFIX + session,
        mime,
        encodedName,
        file.size,
        hash,
        blocks,
        FOUNTAIN_BLOCK_BYTES,
        seed,
        degree,
        withFrameIntegrity(payload),
      ].join('|');
    },
  };
}

export function isFountainFrame(value: string) {
  return value.startsWith(FOUNTAIN_PREFIX) || value.startsWith(LEGACY_FOUNTAIN_PREFIX);
}

export function parseFountainFrame(value: string): FountainDroplet | null {
  const p = value.split('|');
  if (p.length !== 10 || !isFountainFrame(value)) return null;

  const [sessionRaw, mimeRaw, nameRaw, sizeRaw, hashRaw, blocksRaw, blockBytesRaw, seedRaw, degreeRaw, data] = p;
  const version: 1 | 2 = sessionRaw.startsWith(FOUNTAIN_PREFIX) ? 2 : 1;
  const prefixLength = version === 2 ? FOUNTAIN_PREFIX.length : LEGACY_FOUNTAIN_PREFIX.length;
  const session = sessionRaw.slice(prefixLength);
  const size = Number(sizeRaw);
  const blocks = Number(blocksRaw);
  const blockBytes = Number(blockBytesRaw);
  const seed = Number(seedRaw);
  const degree = Number(degreeRaw);

  if (
    !session ||
    !mimeRaw ||
    !nameRaw ||
    !/^[a-f0-9]{64}$/i.test(hashRaw) ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > FOUNTAIN_MAX_FILE_SIZE ||
    !Number.isInteger(blocks) ||
    blocks < 1 ||
    blocks > Math.ceil(FOUNTAIN_MAX_FILE_SIZE / FOUNTAIN_BLOCK_BYTES) ||
    blockBytes !== FOUNTAIN_BLOCK_BYTES ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isInteger(degree) ||
    degree < 1 ||
    degree > Math.min(blocks, blocks <= 2 ? 1 : blocks) ||
    blocks !== Math.max(1, Math.ceil(size / FOUNTAIN_BLOCK_BYTES)) ||
    !data
  ) return null;

  try {
    const bytes = version === 2 ? parseFrameIntegrity(data) : unb64(data);
    if (!bytes || bytes.length !== blockBytes) return null;
    return {
      session,
      mime: decodeURIComponent(mimeRaw),
      name: decodeName(nameRaw),
      size,
      hash: hashRaw.toLowerCase(),
      blocks,
      blockBytes,
      seed: seed >>> 0,
      degree,
      data: b64(bytes),
      version,
    };
  } catch {
    return null;
  }
}

export type FountainDecoder = {
  add: (frame: FountainDroplet) => { duplicate: boolean; solved: number; total: number; complete: boolean };
  reconstruct: () => Promise<{ bytes: Uint8Array; hash: string } | null>;
  seen: () => number;
};

export function createFountainDecoder(
  meta: Pick<FountainDroplet, 'size' | 'hash' | 'blocks' | 'blockBytes' | 'session' | 'mime' | 'name'>,
): FountainDecoder {
  const equations = new Map<number, Equation>();
  const blockToEquations = new Map<number, Set<number>>();
  const solved = new Map<number, Uint8Array>();
  const seenSeeds = new Set<number>();
  // Keep the Gaussian-elimination working set bounded. A sender can keep
  // broadcasting after a receiver stalls, so retaining every unsolved
  // equation forever would make memory usage grow with wall-clock time.
  const maxBufferedEquations = Math.min(
    16_384,
    Math.max(512, Math.ceil(meta.blocks * 0.75)),
  );

  function detach(seed: number, eq: Equation) {
    equations.delete(seed);
    for (const index of eq.indexes) {
      const set = blockToEquations.get(index);
      if (!set) continue;
      set.delete(seed);
      if (set.size === 0) blockToEquations.delete(index);
    }
  }

  function solve(index: number, block: Uint8Array) {
    if (solved.has(index)) return;
    solved.set(index, block);

    const connected = [...(blockToEquations.get(index) ?? [])];
    for (const seed of connected) {
      const eq = equations.get(seed);
      if (!eq) continue;
      xorInto(eq.data, block);
      eq.indexes.delete(index);

      if (eq.indexes.size === 0) {
        detach(seed, eq);
      } else if (eq.indexes.size === 1) {
        const only = [...eq.indexes][0];
        const candidate = eq.data.slice();
        detach(seed, eq);
        solve(only, candidate);
      }
    }
    blockToEquations.delete(index);
  }

  function reduce(eq: Equation) {
    for (const index of [...eq.indexes]) {
      const block = solved.get(index);
      if (!block) continue;
      xorInto(eq.data, block);
      eq.indexes.delete(index);
    }
  }

  return {
    add(frame) {
      if (
        frame.session !== meta.session ||
        frame.hash !== meta.hash ||
        frame.blocks !== meta.blocks ||
        frame.size !== meta.size ||
        frame.blockBytes !== meta.blockBytes
      ) {
        throw new Error('This fountain frame conflicts with the active transfer.');
      }

      if (seenSeeds.has(frame.seed)) {
        return {
          duplicate: true,
          solved: solved.size,
          total: meta.blocks,
          complete: solved.size === meta.blocks,
        };
      }

      seenSeeds.add(frame.seed);

      const indexes = new Set(indexesFor(frame.seed, frame.blocks, frame.degree));
      if (indexes.size !== frame.degree) {
        throw new Error('Invalid fountain degree/index mapping.');
      }

      const eq: Equation = { indexes, data: unb64(frame.data) };
      reduce(eq);

      if (eq.indexes.size === 0) {
        return { duplicate: false, solved: solved.size, total: meta.blocks, complete: solved.size === meta.blocks };
      }

      if (eq.indexes.size === 1) {
        const index = [...eq.indexes][0];
        solve(index, eq.data);
      } else if (
        equations.size < maxBufferedEquations ||
        eq.indexes.size <= 2
      ) {
        equations.set(frame.seed, eq);
        for (const index of eq.indexes) {
          let set = blockToEquations.get(index);
          if (!set) {
            set = new Set<number>();
            blockToEquations.set(index, set);
          }
          set.add(frame.seed);
        }
      }

      return { duplicate: false, solved: solved.size, total: meta.blocks, complete: solved.size === meta.blocks };
    },

    async reconstruct() {
      if (solved.size !== meta.blocks) return null;
      const bytes = new Uint8Array(meta.size);
      for (let i = 0; i < meta.blocks; i += 1) {
        const block = solved.get(i);
        if (!block) return null;
        bytes.set(block.subarray(0, Math.min(meta.blockBytes, meta.size - i * meta.blockBytes)), i * meta.blockBytes);
      }

      const hash = await sha256(bytes);
      if (hash !== meta.hash) {
        throw new Error('Fountain integrity verification failed. The optical stream was incomplete or corrupted.');
      }
      return { bytes, hash };
    },

    seen: () => seenSeeds.size,
  };
}
