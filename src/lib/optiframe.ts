const MAGIC = 0x4f50;
export const OPTIFRAME_SIZE = 180;
export const OPTIFRAME_MAX_PAYLOAD = 8000;
const HEADER_BITS = 72;
const HEADER_VERSION = 2;
const FINDER_SIZE = 9;
const FINDER_OFFSET = 4;
const LUMINANCE_LEVELS = [0, 85, 170, 255] as const;

export type OptiFrame = {
  version: number;
  sequence: number;
  total: number;
  payload: Uint8Array;
};

export type OptiFrameAnchor = {
  x: number;
  y: number;
  score: number;
  scale: number;
  angle: number;
};

export type OptiFramePerspectiveDiagnostics = {
  anchors: [OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor];
  confidence: number;
  sampleWidth: number;
  sampleHeight: number;
  decodeMs: number;
};

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function finderBit(r: number, c: number) {
  const edge = r === 0 || c === 0 || r === FINDER_SIZE - 1 || c === FINDER_SIZE - 1;
  const ring = r === 1 || c === 1 || r === 7 || c === 7;
  const center = r >= 2 && r <= 6 && c >= 2 && c <= 6;
  return edge || (center && !ring);
}

function zones() {
  return [
    [FINDER_OFFSET, FINDER_OFFSET],
    [OPTIFRAME_SIZE - FINDER_OFFSET - FINDER_SIZE, FINDER_OFFSET],
    [FINDER_OFFSET, OPTIFRAME_SIZE - FINDER_OFFSET - FINDER_SIZE],
    [OPTIFRAME_SIZE - FINDER_OFFSET - FINDER_SIZE, OPTIFRAME_SIZE - FINDER_OFFSET - FINDER_SIZE],
  ] as const;
}

function zoneOrigin(r: number, c: number): [number, number] | null {
  const high = OPTIFRAME_SIZE - FINDER_OFFSET - FINDER_SIZE;
  if (r >= FINDER_OFFSET && r < FINDER_OFFSET + FINDER_SIZE && c >= FINDER_OFFSET && c < FINDER_OFFSET + FINDER_SIZE) {
    return [FINDER_OFFSET, FINDER_OFFSET];
  }
  if (r >= FINDER_OFFSET && r < FINDER_OFFSET + FINDER_SIZE && c >= high && c < high + FINDER_SIZE) {
    return [FINDER_OFFSET, high];
  }
  if (r >= high && r < high + FINDER_SIZE && c >= FINDER_OFFSET && c < FINDER_OFFSET + FINDER_SIZE) {
    return [high, FINDER_OFFSET];
  }
  if (r >= high && r < high + FINDER_SIZE && c >= high && c < high + FINDER_SIZE) {
    return [high, high];
  }
  return null;
}

function isFinderCell(r: number, c: number) {
  return zoneOrigin(r, c) !== null;
}

function finderValue(r: number, c: number) {
  const origin = zoneOrigin(r, c);
  return origin ? (finderBit(r - origin[0], c - origin[1]) ? 3 : 0) : -1;
}

// Precompute the immutable protocol raster once. The hot encode/decode paths
// then walk only data cells instead of calling zoneOrigin() for every pixel.
const DATA_CELL_COORDS: Uint16Array = (() => {
  const cells: number[] = [];
  for (let r = 0; r < OPTIFRAME_SIZE; r++) {
    for (let c = 0; c < OPTIFRAME_SIZE; c++) {
      if (!isFinderCell(r, c)) cells.push((r << 8) | c);
    }
  }
  return Uint16Array.from(cells);
})();

const FINDER_CELL_COORDS: Uint16Array = (() => {
  const cells: number[] = [];
  for (let r = 0; r < OPTIFRAME_SIZE; r++) {
    for (let c = 0; c < OPTIFRAME_SIZE; c++) {
      if (isFinderCell(r, c)) cells.push((r << 8) | c);
    }
  }
  return Uint16Array.from(cells);
})();

function capacityBits() {
  return DATA_CELL_COORDS.length * 2 - HEADER_BITS;
}

export function getOptiFrameCapacity() {
  return Math.min(OPTIFRAME_MAX_PAYLOAD, Math.floor(capacityBits() / 8) - 4);
}

export function encodeOptiFrame(payload: Uint8Array, sequence = 0, total = 1) {
  const capacity = getOptiFrameCapacity();
  if (payload.length > capacity) throw new Error('OptiFrame payload is too large.');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65535 || !Number.isInteger(total) || total < 1 || total > 65535) {
    throw new Error('OptiFrame metadata is out of range.');
  }

  // Header v2 is 72 bits: magic16 + version4 + sequence16 + total16 +
  // payloadLength16 + reserved4. The extra length bits unlock the larger
  // 180×180 / 2-bit optical payload without sacrificing CRC protection.
  const header = new Uint8Array(9);
  header[0] = MAGIC >>> 8;
  header[1] = MAGIC & 255;
  header[2] = (HEADER_VERSION << 4) | ((sequence >>> 12) & 0x0f);
  header[3] = (sequence >>> 4) & 255;
  header[4] = ((sequence & 0x0f) << 4) | ((total >>> 12) & 0x0f);
  header[5] = (total >>> 4) & 255;
  header[6] = ((total & 0x0f) << 4) | ((payload.length >>> 12) & 0x0f);
  header[7] = (payload.length >>> 4) & 255;
  header[8] = (payload.length & 0x0f) << 4;

  const body = new Uint8Array(payload.length + 4);
  body.set(payload);
  const crc = crc32(payload);
  body[payload.length] = crc >>> 24;
  body[payload.length + 1] = crc >>> 16;
  body[payload.length + 2] = crc >>> 8;
  body[payload.length + 3] = crc;

  const canvas = document.createElement('canvas');
  canvas.width = OPTIFRAME_SIZE;
  canvas.height = OPTIFRAME_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');

  const image = ctx.createImageData(OPTIFRAME_SIZE, OPTIFRAME_SIZE);
  image.data.fill(255);
  for (const coord of FINDER_CELL_COORDS) {
    const r = coord >>> 8;
    const col = coord & 255;
    const i = (r * OPTIFRAME_SIZE + col) * 4;
    const origin = zoneOrigin(r, col)!;
    const level = finderBit(r - origin[0], col - origin[1]) ? 3 : 0;
    const lum = LUMINANCE_LEVELS[level];
    image.data[i] = lum;
    image.data[i + 1] = lum;
    image.data[i + 2] = lum;
  }

  let cursorBits = 0;
  for (const coord of DATA_CELL_COORDS) {
    const r = coord >>> 8;
    const col = coord & 255;
    const i = (r * OPTIFRAME_SIZE + col) * 4;
    let level: number;
    if (cursorBits < HEADER_BITS) {
      const headerByte = header[cursorBits >>> 3];
      const shift = 6 - (cursorBits & 7);
      level = (headerByte >>> shift) & 3;
    } else {
      const bodyBit = cursorBits - HEADER_BITS;
      const bodyByte = body[bodyBit >>> 3];
      const shift = 6 - (bodyBit & 7);
      level = (bodyByte >>> shift) & 3;
    }
    const lum = LUMINANCE_LEVELS[level as 0 | 1 | 2 | 3];
    image.data[i] = lum;
    image.data[i + 1] = lum;
    image.data[i + 2] = lum;
    image.data[i + 3] = 255;
    cursorBits += 2;
  }
  ctx.putImageData(image, 0, 0);
  return { canvas, frame: { version: HEADER_VERSION, sequence, total, payload } as OptiFrame };
}

function toImageData(source: CanvasImageSource | ImageData) {
  if (source instanceof ImageData) return source;

  const dimensions = source as unknown as { width?: number; height?: number; displayWidth?: number; displayHeight?: number };
  const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : (typeof dimensions.width === 'number' ? dimensions.width : dimensions.displayWidth ?? 0);
  const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : (typeof dimensions.height === 'number' ? dimensions.height : dimensions.displayHeight ?? 0);
  if (!sourceWidth || !sourceHeight) return null;

  // Preserve the high-resolution camera sample; finder detection needs the real module scale.
  const maxDimension = 1440;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // Optical symbols are intentionally hard-edged. Nearest-neighbour rasterization
  // avoids introducing blended gray values while resizing camera frames.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function quantize(v: number) {
  return v < 43 ? 0 : v < 128 ? 1 : v < 213 ? 2 : 3;
}

function decodePackedFrame(packed: Uint8Array) {
  if (packed.length < 9 + 4) return null;

  const magic = (packed[0] << 8) | packed[1];
  const version = packed[2] >>> 4;
  const sequence = ((packed[2] & 0x0f) << 12) | (packed[3] << 4) | (packed[4] >>> 4);
  const total = ((packed[4] & 0x0f) << 12) | (packed[5] << 4) | (packed[6] >>> 4);
  const length = ((packed[6] & 0x0f) << 12) | (packed[7] << 4) | (packed[8] >>> 4);
  if (magic !== MAGIC || version !== HEADER_VERSION || total < 1 || length > OPTIFRAME_MAX_PAYLOAD) return null;

  const payloadStart = 9;
  const end = payloadStart + length + 4;
  if (end > packed.length) return null;
  const payload = packed.slice(payloadStart, payloadStart + length);
  const expected = (
    (packed[payloadStart + length] << 24) |
    (packed[payloadStart + length + 1] << 16) |
    (packed[payloadStart + length + 2] << 8) |
    packed[payloadStart + length + 3]
  ) >>> 0;
  if (crc32(payload) !== expected) return null;
  return { version, sequence, total, payload } as OptiFrame;
}

function decodeAxisAlignedImage(image: ImageData) {
  if (image.width !== OPTIFRAME_SIZE || image.height !== OPTIFRAME_SIZE) return null;
  const packed = new Uint8Array(9 + Math.ceil((capacityBits() + 7) / 8));
  let cursorBits = 0;
  for (const coord of DATA_CELL_COORDS) {
    const r = coord >>> 8;
    const col = coord & 255;
    const i = (r * OPTIFRAME_SIZE + col) * 4;
    const level = quantize((image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3);
    const byteIndex = cursorBits >>> 3;
    packed[byteIndex] = ((packed[byteIndex] << 2) | level) & 255;
    cursorBits += 2;
  }
  return decodePackedFrame(packed);
}

export function decodeOptiFrame(source: CanvasImageSource | ImageData) {
  const canvas = document.createElement('canvas');
  canvas.width = OPTIFRAME_SIZE;
  canvas.height = OPTIFRAME_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // Preserve the four discrete luminance levels when decoding a scaled image.
  ctx.imageSmoothingEnabled = false;

  if (source instanceof ImageData) {
    if (source.width !== OPTIFRAME_SIZE || source.height !== OPTIFRAME_SIZE) return null;
    ctx.putImageData(source, 0, 0);
  } else {
    ctx.drawImage(source, 0, 0, OPTIFRAME_SIZE, OPTIFRAME_SIZE);
  }
  return decodeAxisAlignedImage(ctx.getImageData(0, 0, OPTIFRAME_SIZE, OPTIFRAME_SIZE));
}

function bilinear(image: ImageData, x: number, y: number) {
  const { width, height, data } = image;
  const fx = Math.max(0, Math.min(width - 1.001, x));
  const fy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const dx = fx - x0;
  const dy = fy - y0;
  const sample = (sx: number, sy: number) => {
    const i = (sy * width + sx) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3;
  };
  return (
    sample(x0, y0) * (1 - dx) * (1 - dy) +
    sample(x1, y0) * dx * (1 - dy) +
    sample(x0, y1) * (1 - dx) * dy +
    sample(x1, y1) * dx * dy
  );
}

function expectedFinderLuma(r: number, c: number) {
  return finderBit(r, c) ? 1 : 0;
}

function finderScore(image: ImageData, cx: number, cy: number, moduleScale: number, angle = 0) {
  const points: Array<{ value: number; expected: number; weight: number }> = [];
  const half = (FINDER_SIZE - 1) / 2;
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  let min = 255;
  let max = 0;

  for (let r = 0; r < FINDER_SIZE; r++) {
    for (let c = 0; c < FINDER_SIZE; c++) {
      const dx = (c - half) * moduleScale;
      const dy = (r - half) * moduleScale;
      const x = cx + dx * cos - dy * sin;
      const y = cy + dx * sin + dy * cos;
      const value = bilinear(image, x, y);
      min = Math.min(min, value);
      max = Math.max(max, value);
      points.push({ value, expected: expectedFinderLuma(r, c), weight: finderBit(r, c) ? 1.1 : 1.65 });
    }
  }

  if (max - min < 55) return -1;
  let error = 0;
  let weight = 0;
  for (const point of points) {
    const normalized = (point.value - min) / (max - min);
    error += Math.abs(normalized - point.expected) * point.weight;
    weight += point.weight;
  }
  return 1 - error / weight;
}


const QUICK_FINDER_POINTS = [
  [0, 0], [0, 4], [0, 8],
  [2, 2], [2, 4], [2, 6],
  [4, 0], [4, 2], [4, 4], [4, 6], [4, 8],
  [6, 2], [6, 4], [6, 6],
  [8, 0], [8, 4], [8, 8],
] as const;

function finderCoarseScore(image: ImageData, cx: number, cy: number, moduleScale: number, angle = 0) {
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = [
    [0, 0, 1.4],
    [0, 4, 1.1],
    [0, 8, 1.1],
    [4, 0, 1.1],
    [4, 4, 1.5],
    [4, 8, 1.1],
    [8, 0, 1.1],
    [8, 4, 1.1],
    [8, 8, 1.4],
  ] as const;
  let min = 255;
  let max = 0;
  const samples: Array<{ value: number; expected: number; weight: number }> = [];
  for (const [r, col, weight] of points) {
    const dx = (col - 4) * moduleScale;
    const dy = (r - 4) * moduleScale;
    const x = cx + dx * cos - dy * sin;
    const y = cy + dx * sin + dy * cos;
    const value = bilinear(image, x, y);
    min = Math.min(min, value);
    max = Math.max(max, value);
    samples.push({ value, expected: finderBit(r, col) ? 1 : 0, weight });
  }
  if (max - min < 42) return -1;
  let error = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const normalized = (sample.value - min) / (max - min);
    error += Math.abs(normalized - sample.expected) * sample.weight;
    totalWeight += sample.weight;
  }
  return 1 - error / totalWeight;
}

function finderQuickScore(image: ImageData, cx: number, cy: number, moduleScale: number, angle = 0) {
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  let min = 255;
  let max = 0;
  const samples: Array<{ value: number; expected: number; weight: number }> = [];

  for (const [r, col] of QUICK_FINDER_POINTS) {
    const dx = (col - 4) * moduleScale;
    const dy = (r - 4) * moduleScale;
    const x = cx + dx * cos - dy * sin;
    const y = cy + dx * sin + dy * cos;
    const value = bilinear(image, x, y);
    min = Math.min(min, value);
    max = Math.max(max, value);
    samples.push({
      value,
      expected: finderBit(r, col) ? 1 : 0,
      weight: finderBit(r, col) ? 1.1 : 1.5,
    });
  }

  if (max - min < 45) return -1;
  let error = 0;
  let weight = 0;
  for (const sample of samples) {
    const normalized = (sample.value - min) / (max - min);
    error += Math.abs(normalized - sample.expected) * sample.weight;
    weight += sample.weight;
  }
  return 1 - error / weight;
}

type Corner = 'tl' | 'tr' | 'bl' | 'br';

function searchAllFinders(image: ImageData) {
  const width = image.width;
  const height = image.height;
  const minDim = Math.min(width, height);
  const expectedScale = minDim / OPTIFRAME_SIZE;
  const minScale = Math.max(0.75, expectedScale * 0.22);
  const maxScale = Math.min(24, Math.max(minScale + 2, expectedScale * 2.2));
  const coarseScaleStep = Math.max(1.0, expectedScale * 0.16);
  const coarseSpatialStep = Math.max(5, Math.min(12, Math.round(Math.max(2, expectedScale * 0.9))));

  type Candidate = { x: number; y: number; score: number; scale: number; angle: number };
  const buckets: Candidate[][] = [[], [], [], []];
  const retain = (bucket: Candidate[], candidate: Candidate) => {
    if (bucket.length < 8) {
      bucket.push(candidate);
      return;
    }
    let weakest = 0;
    for (let i = 1; i < bucket.length; i += 1) {
      if (bucket[i].score < bucket[weakest].score) weakest = i;
    }
    if (candidate.score > bucket[weakest].score) bucket[weakest] = candidate;
  };

  const scanAngles = (angles: readonly number[]) => {
    for (const angle of angles) {
      for (let scale = minScale; scale <= maxScale; scale += coarseScaleStep) {
        for (let y = 4; y < height - 4; y += coarseSpatialStep) {
          const row = y < height / 2 ? 0 : 2;
          for (let x = 4; x < width - 4; x += coarseSpatialStep) {
            const score = finderCoarseScore(image, x, y, scale, angle);
            if (score <= 0.42) continue;
            const quadrant = row + (x < width / 2 ? 0 : 1);
            retain(buckets[quadrant], { x, y, score, scale, angle });
          }
        }
      }
    }
  };

  scanAngles([0]);

  const refineBucket = (bucket: Candidate[]) => {
    let best: OptiFrameAnchor | null = null;
    for (const candidate of bucket) {
      const score = finderScore(image, candidate.x, candidate.y, candidate.scale, candidate.angle);
      if (score > (best?.score ?? 0)) {
        best = { x: candidate.x, y: candidate.y, score, scale: candidate.scale, angle: candidate.angle };
      }
    }
    return best;
  };

  let anchors = buckets.map(refineBucket) as Array<OptiFrameAnchor | null>;
  const needsRotation = anchors.some(anchor => !anchor || anchor.score < 0.82);
  if (needsRotation) {
    buckets.forEach(bucket => { bucket.length = 0; });
    scanAngles([-20, -10, 10, 20]);
    anchors = buckets.map(refineBucket) as Array<OptiFrameAnchor | null>;
  }

  return {
    tl: anchors[0],
    tr: anchors[1],
    bl: anchors[2],
    br: anchors[3],
  };
}

function searchFinder(image: ImageData, corner: Corner) {
  const width = image.width;
  const height = image.height;
  const minDim = Math.min(width, height);
  // The optical surface may occupy only a fraction of the camera image.
  // Example: a 768 px sender surface inside a 1920 px camera frame is about
  // 6 px/module, while minDim/128 is 15 px/module. Searching from 0.5× that
  // estimate therefore excluded a valid physical frame.
  const expectedScale = minDim / OPTIFRAME_SIZE;
  const minScale = Math.max(0.75, expectedScale * 0.22);
  const maxScale = Math.min(24, Math.max(minScale + 2, expectedScale * 2.2));
  const scaleStep = Math.max(0.75, expectedScale * 0.08);
  // Keep the spatial scan fine enough for small physical frames.
  const step = Math.max(2, Math.min(8, Math.round(Math.max(1, expectedScale * 0.45))));

  const xStart = corner.includes('l') ? 0 : Math.floor(width * 0.58);
  const xEnd = corner.includes('l') ? Math.floor(width * 0.42) : width;
  const yStart = corner.includes('t') ? 0 : Math.floor(height * 0.58);
  const yEnd = corner.includes('t') ? Math.floor(height * 0.42) : height;

  const scan = (angles: readonly number[]) => {
    const candidates: Array<{ x: number; y: number; score: number; scale: number; angle: number }> = [];
    const retain = (candidate: { x: number; y: number; score: number; scale: number; angle: number }) => {
      // Keep only the strongest candidates without sorting a large point cloud.
      if (candidates.length < 8) {
        candidates.push(candidate);
        return;
      }
      let weakestIndex = 0;
      for (let i = 1; i < candidates.length; i += 1) {
        if (candidates[i].score < candidates[weakestIndex].score) weakestIndex = i;
      }
      if (candidate.score > candidates[weakestIndex].score) candidates[weakestIndex] = candidate;
    };

    // Global acquisition is intentionally coarse. Every survivor is then
    // re-scored with the full finder template in the existing refinement pass.
    const coarseScaleStep = Math.max(1.0, expectedScale * 0.16);
    const coarseSpatialStep = Math.max(5, Math.min(12, Math.round(Math.max(2, expectedScale * 0.9))));

    for (const angle of angles) {
      for (let scale = minScale; scale <= maxScale; scale += coarseScaleStep) {
        for (let y = yStart + 4; y < yEnd - 4; y += coarseSpatialStep) {
          for (let x = xStart + 4; x < xEnd - 4; x += coarseSpatialStep) {
            const score = finderCoarseScore(image, x, y, scale, angle);
            if (score > 0.42) retain({ x, y, score, scale, angle });
          }
        }
      }
    }

    let best: OptiFrameAnchor | null = null;
    for (const candidate of candidates) {
      const score = finderScore(image, candidate.x, candidate.y, candidate.scale, candidate.angle);
      if (score > (best?.score ?? 0)) {
        best = {
          x: candidate.x,
          y: candidate.y,
          score,
          scale: candidate.scale,
          angle: candidate.angle,
        };
      }
    }
    return best;
  };

  // Most captures are close to upright. Only test rotation hypotheses when
  // the cheap upright acquisition does not produce a convincing template.
  let best = scan([0]);
  if (!best || best.score < 0.82) {
    const rotated = scan([-20, -10, 10, 20]);
    if (rotated && rotated.score > (best?.score ?? 0)) best = rotated;
  }

  if (!best || best.score < 0.68) return null;

  let refined = best;
  const fineStep = Math.max(1, step / 2);
  const minX = Math.max(xStart + 2, best.x - step * 2);
  const maxX = Math.min(xEnd - 3, best.x + step * 2);
  const minY = Math.max(yStart + 2, best.y - step * 2);
  const maxY = Math.min(yEnd - 3, best.y + step * 2);
  const minS = Math.max(minScale, best.scale - scaleStep * 2);
  const maxS = Math.min(maxScale, best.scale + scaleStep * 2);
  const minA = Math.max(-30, best.angle - 5);
  const maxA = Math.min(30, best.angle + 5);

  for (let angle = minA; angle <= maxA; angle += 1) {
    for (let scale = minS; scale <= maxS; scale += 0.5) {
      for (let y = minY; y <= maxY; y += fineStep) {
        for (let x = minX; x <= maxX; x += fineStep) {
          const score = finderScore(image, x, y, scale, angle);
          if (score > refined.score) refined = { x, y, score, scale, angle };
        }
      }
    }
  }
  return refined;
}


type PerspectiveAnchorSet = readonly [OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor];

function searchFinderNear(image: ImageData, previous: OptiFrameAnchor) {
  const width = image.width;
  const height = image.height;
    const step = Math.max(1, Math.min(4, Math.round(Math.max(1, previous.scale * 0.3))));
  const radius = Math.max(12, Math.round(previous.scale * 5));
  const scaleRadius = Math.max(1, previous.scale * 0.35);
  const scaleStep = Math.max(0.35, previous.scale * 0.08);
  const angleRadius = Math.max(3, Math.min(12, Math.abs(previous.angle) + 3));
  const candidates: Array<{ x: number; y: number; score: number; scale: number; angle: number }> = [];
  const retain = (candidate: { x: number; y: number; score: number; scale: number; angle: number }) => {
    if (candidates.length < 4) {
      candidates.push(candidate);
      return;
    }
    let weakest = 0;
    for (let index = 1; index < candidates.length; index += 1) {
      if (candidates[index].score < candidates[weakest].score) weakest = index;
    }
    if (candidate.score > candidates[weakest].score) candidates[weakest] = candidate;
  };

  for (let angle = previous.angle - angleRadius; angle <= previous.angle + angleRadius; angle += 2) {
    for (let scale = Math.max(0.75, previous.scale - scaleRadius); scale <= previous.scale + scaleRadius; scale += scaleStep) {
      for (let y = Math.max(4, previous.y - radius); y <= Math.min(height - 5, previous.y + radius); y += step) {
        for (let x = Math.max(4, previous.x - radius); x <= Math.min(width - 5, previous.x + radius); x += step) {
          const score = finderQuickScore(image, x, y, scale, angle);
          if (score > 0.55) retain({ x, y, score, scale, angle });
        }
      }
    }
  }

  let best: OptiFrameAnchor | null = null;
  for (const candidate of candidates) {
    const score = finderScore(image, candidate.x, candidate.y, candidate.scale, candidate.angle);
    if (score > (best?.score ?? 0)) {
      best = { x: candidate.x, y: candidate.y, score, scale: candidate.scale, angle: candidate.angle };
    }
  }
  return best && best.score >= 0.68 ? best : null;
}

function decodePerspectiveFromAnchors(image: ImageData, anchors: PerspectiveAnchorSet) {
  const edge = OPTIFRAME_SIZE - 9;
  const target: Array<[number, number]> = [[8, 8], [edge, 8], [8, edge], [edge, edge]];
  const homography = solveHomography(anchors.map(anchor => [anchor.x, anchor.y]), target);
  if (!homography) return null;
  const reverse = solveHomography(target, anchors.map(anchor => [anchor.x, anchor.y]));
  if (!reverse) return null;

  const calibration = estimateCalibration(image, anchors);
  if (!calibration) return null;

  const moduleScale = anchors.reduce((sum, anchor) => sum + anchor.scale, 0) / anchors.length;
  const topWidth = Math.hypot(anchors[1].x - anchors[0].x, anchors[1].y - anchors[0].y);
  const bottomWidth = Math.hypot(anchors[3].x - anchors[2].x, anchors[3].y - anchors[2].y);
  const leftHeight = Math.hypot(anchors[2].x - anchors[0].x, anchors[2].y - anchors[0].y);
  const rightHeight = Math.hypot(anchors[3].x - anchors[1].x, anchors[3].y - anchors[1].y);
  const longest = Math.max(topWidth, bottomWidth, leftHeight, rightHeight);
  const shortest = Math.max(1, Math.min(topWidth, bottomWidth, leftHeight, rightHeight));
  if (longest / shortest > 2.75) return null;

  const packed = new Uint8Array(9 + Math.ceil((capacityBits() + 7) / 8));
  let cursorBits = 0;
  for (const coord of DATA_CELL_COORDS) {
    const r = coord >>> 8;
    const col = coord & 255;
    const [sx, sy] = project(reverse, col, r);
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return null;
      const raw = sampleModule(image, sx, sy, moduleScale);
      const normalized = Math.max(0, Math.min(255, (raw - calibration.dark) * 255 / (calibration.light - calibration.dark)));
      const level = quantize(normalized);
      const byteIndex = cursorBits >>> 3;
      packed[byteIndex] = ((packed[byteIndex] << 2) | level) & 255;
      cursorBits += 2;
    }
  return decodePackedFrame(packed);
}

function solveHomography(
  source: Array<[number, number]>,
  target: Array<[number, number]>,
) {
  const matrix: number[][] = [];
  const vector: number[] = [];

  for (let i = 0; i < 4; i++) {
    const [x, y] = source[i];
    const [u, v] = target[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }

  for (let pivot = 0; pivot < 8; pivot++) {
    let best = pivot;
    for (let row = pivot + 1; row < 8; row++) {
      if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row;
    }
    if (Math.abs(matrix[best][pivot]) < 1e-9) return null;
    [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];
    [vector[pivot], vector[best]] = [vector[best], vector[pivot]];

    const divisor = matrix[pivot][pivot];
    for (let col = pivot; col < 8; col++) matrix[pivot][col] /= divisor;
    vector[pivot] /= divisor;

    for (let row = 0; row < 8; row++) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      if (Math.abs(factor) < 1e-12) continue;
      for (let col = pivot; col < 8; col++) matrix[row][col] -= factor * matrix[pivot][col];
      vector[row] -= factor * vector[pivot];
    }
  }

  return [...vector, 1];
}

function project(h: number[], u: number, v: number): [number, number] {
  const w = h[6] * u + h[7] * v + 1;
  return [
    (h[0] * u + h[1] * v + h[2]) / w,
    (h[3] * u + h[4] * v + h[5]) / w,
  ];
}

function estimateCalibration(image: ImageData, anchors: ReadonlyArray<OptiFrameAnchor>) {
  const values: { dark: number; light: number }[] = [];
  for (const anchor of anchors) {
    const { x: cx, y: cy, scale, angle } = anchor;
    const radians = angle * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const ring: number[] = [];
    const center: number[] = [];
    for (let r = 0; r < FINDER_SIZE; r++) {
      for (let c = 0; c < FINDER_SIZE; c++) {
        const dx = (c - 4) * scale;
        const dy = (r - 4) * scale;
        const x = cx + dx * cos - dy * sin;
        const y = cy + dx * sin + dy * cos;
        const value = bilinear(image, x, y);
        if (finderBit(r, c)) center.push(value);
        else ring.push(value);
      }
    }
    values.push({
      dark: ring.reduce((sum, v) => sum + v, 0) / Math.max(1, ring.length),
      light: center.reduce((sum, v) => sum + v, 0) / Math.max(1, center.length),
    });
  }

  const dark = values.reduce((sum, value) => sum + value.dark, 0) / values.length;
  const light = values.reduce((sum, value) => sum + value.light, 0) / values.length;
  if (light - dark < 35) return null;
  return { dark, light };
}

function sampleModule(image: ImageData, x: number, y: number, moduleScale: number) {
  let total = 0;
  let count = 0;
  // Keep the sampling footprint inside the current optical module. Once the
  // footprint reaches neighboring modules, four-level symbols become harder
  // to separate, especially around 384 px lanes.
  const radius = moduleScale >= 8 ? 2 : moduleScale >= 4 ? 1 : 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      total += bilinear(image, x + dx, y + dy);
      count++;
    }
  }
  return total / count;
}

export type OptiFrameAcquisitionStage = 'image' | 'searching' | 'anchors' | 'geometry' | 'calibration' | 'ready';

export type OptiFrameAcquisitionDiagnostics = {
  stage: OptiFrameAcquisitionStage;
  anchors: OptiFrameAnchor[];
  confidence: number;
  moduleScale: number;
  angle: number;
  geometryRatio: number;
  sampleWidth: number;
  sampleHeight: number;
  elapsedMs: number;
};

export function inspectOptiFrameAcquisition(source: CanvasImageSource | ImageData): OptiFrameAcquisitionDiagnostics {
  const started = performance.now();
  const image = toImageData(source);
  if (!image) return { stage: 'image', anchors: [], confidence: 0, moduleScale: 0, angle: 0, geometryRatio: 0, sampleWidth: 0, sampleHeight: 0, elapsedMs: performance.now() - started };
  const all = searchAllFinders(image);
  const found: OptiFrameAnchor[] = [
    all.tl,
    all.tr,
    all.bl,
    all.br,
  ].filter((anchor): anchor is OptiFrameAnchor => Boolean(anchor));
  const confidence = found.length ? found.reduce((sum, anchor) => sum + anchor.score, 0) / found.length : 0;
  const moduleScale = found.length ? found.reduce((sum, anchor) => sum + anchor.scale, 0) / found.length : 0;
  const angle = found.length ? found.reduce((sum, anchor) => sum + anchor.angle, 0) / found.length : 0;
  if (found.length < 4) return { stage: found.length ? 'anchors' : 'searching', anchors: found, confidence, moduleScale, angle, geometryRatio: 0, sampleWidth: image.width, sampleHeight: image.height, elapsedMs: performance.now() - started };
  const [tl, tr, bl, br] = found;
  const widths = [Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y)];
  const heights = [Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y)];
  const geometryRatio = Math.max(...widths, ...heights) / Math.max(1, Math.min(...widths, ...heights));
  if (geometryRatio > 2.75) return { stage: 'geometry', anchors: found, confidence, moduleScale, angle, geometryRatio, sampleWidth: image.width, sampleHeight: image.height, elapsedMs: performance.now() - started };
  if (!estimateCalibration(image, found)) return { stage: 'calibration', anchors: found, confidence, moduleScale, angle, geometryRatio, sampleWidth: image.width, sampleHeight: image.height, elapsedMs: performance.now() - started };
  return { stage: 'ready', anchors: found, confidence, moduleScale, angle, geometryRatio, sampleWidth: image.width, sampleHeight: image.height, elapsedMs: performance.now() - started };
}

export function decodeOptiFramePerspective(
  source: CanvasImageSource | ImageData,
  previousAnchors: PerspectiveAnchorSet | null = null,
): { frame: OptiFrame; diagnostics: OptiFramePerspectiveDiagnostics } | null {
  const started = performance.now();
  const image = toImageData(source);
  if (!image) return null;

  // Fast tracking path: search each known finder in a tiny neighborhood first.
  // The caller owns the state, so workers no longer cross-contaminate lanes.
  if (previousAnchors) {
    const tracked = previousAnchors.map((anchor) => searchFinderNear(image, anchor));
    if (tracked.every(Boolean)) {
      const anchors: PerspectiveAnchorSet = [tracked[0]!, tracked[1]!, tracked[2]!, tracked[3]!];
      const frame = decodePerspectiveFromAnchors(image, anchors);
      if (frame) {
        return {
          frame,
          diagnostics: {
            anchors: [anchors[0], anchors[1], anchors[2], anchors[3]] as [OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor],
            confidence: anchors.reduce((sum, anchor) => sum + anchor.score, 0) / anchors.length,
            sampleWidth: image.width,
            sampleHeight: image.height,
            decodeMs: performance.now() - started,
          },
        };
      }
    }
  }

  // Full acquisition fallback is required for first lock and after tracker loss.
  const all = searchAllFinders(image);
  if (!all.tl || !all.tr || !all.bl || !all.br) return null;

  const anchors: PerspectiveAnchorSet = [all.tl, all.tr, all.bl, all.br];
  const frame = decodePerspectiveFromAnchors(image, anchors);
  if (!frame) return null;

  return {
    frame,
    diagnostics: {
      anchors: [anchors[0], anchors[1], anchors[2], anchors[3]] as [OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor, OptiFrameAnchor],
      confidence: anchors.reduce((sum, anchor) => sum + anchor.score, 0) / anchors.length,
      sampleWidth: image.width,
      sampleHeight: image.height,
      decodeMs: performance.now() - started,
    },
  };
}

export function optiFrameSelfTest() {
  const payload = new TextEncoder().encode('OptiCode experimental optical frame');
  const encoded = encodeOptiFrame(payload, 7, 19);
  const decoded = decodeOptiFrame(encoded.canvas);
  if (!decoded || decoded.sequence !== 7 || decoded.total !== 19 || decoded.payload.length !== payload.length || decoded.payload.some((v, i) => v !== payload[i])) {
    throw new Error('OptiFrame round trip failed.');
  }

  const warped = document.createElement('canvas');
  warped.width = 900;
  warped.height = 780;
  const ctx = warped.getContext('2d');
  if (!ctx) throw new Error('Perspective self-test canvas unavailable.');
  ctx.fillStyle = '#777';
  ctx.fillRect(0, 0, warped.width, warped.height);
  ctx.setTransform(1, 0.16, -0.08, 1, 150, 120);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(encoded.canvas, 0, 0, 768, 768);
  const perspective = decodeOptiFramePerspective(warped);
  if (!perspective || perspective.frame.sequence !== 7 || perspective.frame.total !== 19 || perspective.frame.payload.length !== payload.length || perspective.frame.payload.some((v, i) => v !== payload[i])) {
    throw new Error('OptiFrame perspective self-test failed.');
  }

  return { payloadBytes: payload.length, capacityBytes: getOptiFrameCapacity() };
}
