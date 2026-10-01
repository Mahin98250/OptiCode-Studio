import { encodeOptiFrame, encodeOptiFrameDense4, OPTIFRAME_SIZE, type OptiFrame, type OptiFrameDensity } from './optiframe';

export type OptiLaneCount = 1 | 2 | 4 | 6 | 9 | 12 | 16;

export type OptiLaneLayout = {
  columns: number;
  rows: number;
};

export function getOptiLaneLayout(count: OptiLaneCount): OptiLaneLayout {
  if (count === 16) return { columns: 4, rows: 4 };
  if (count === 12) return { columns: 4, rows: 3 };
  if (count === 9) return { columns: 3, rows: 3 };
  if (count === 6) return { columns: 3, rows: 2 };
  if (count === 4) return { columns: 2, rows: 2 };
  if (count === 2) return { columns: 2, rows: 1 };
  return { columns: 1, rows: 1 };
}

export function getOptiLaneSequence(baseSequence: number, lane: number, total: number): number {
  const sequence = baseSequence + lane;
  return total > 0 ? sequence % total : sequence;
}

export type OptiFrameCanvasCache = {
  get(payload: Uint8Array, sequence: number, total: number): HTMLCanvasElement;
  clear(): void;
  size(): number;
};

export function createOptiFrameCanvasCache(maxEntries = 96): OptiFrameCanvasCache {
  const limit = Math.max(1, Math.floor(maxEntries));
  const entries = new Map<string, HTMLCanvasElement>();

  const payloadKey = (payload: Uint8Array, sequence: number, total: number) => {
    // Sequence alone is not a valid cache key: different lanes can reuse the
    // same sequence while carrying different payloads. Encode the complete
    // payload into the key so a reused sequence can never return another
    // lane's optical frame.
    let binary = '';
    for (let i = 0; i < payload.length; i += 0x8000) {
      binary += String.fromCharCode(...payload.subarray(i, Math.min(i + 0x8000, payload.length)));
    }
    return sequence + ':' + total + ':' + btoa(binary);
  };

  return {
    get(payload, sequence, total) {
      const key = payloadKey(payload, sequence, total);
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }

      const encoded = encodeOptiFrame(payload, sequence, total);
      entries.set(key, encoded.canvas);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return encoded.canvas;
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

export function createOptiLaneSurface(
  payloads: readonly Uint8Array[],
  baseSequence: number,
  total: number,
  laneCount: OptiLaneCount,
  frameCache?: OptiFrameCanvasCache,
  densityBits: OptiFrameDensity = 2,
) {
  if (payloads.length !== laneCount) {
    throw new Error(`Expected ${laneCount} lane payloads.`);
  }

  const layout = getOptiLaneLayout(laneCount);
  // Physical profiles: 1×=5 px/module, 2×/4×=3 px/module, and
  // 6×/9×/12×/16×=2 px/module. The single-lane profile deliberately gets
  // more physical pixels per optical module because it is the baseline camera
  // acquisition mode and has no parallelism to trade against module size.
  const renderScale = laneCount === 1 ? 5 : laneCount === 2 || laneCount === 4 ? 3 : 2;
  const laneRenderSize = OPTIFRAME_SIZE * renderScale;
  const canvas = document.createElement('canvas');
  canvas.width = layout.columns * laneRenderSize;
  canvas.height = layout.rows * laneRenderSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const frames: OptiFrame[] = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    const sequence = getOptiLaneSequence(baseSequence, lane, total);
    const canvas = densityBits === 4
      ? encodeOptiFrameDense4(payloads[lane], sequence, total).canvas
      : frameCache
        ? frameCache.get(payloads[lane], sequence, total)
        : encodeOptiFrame(payloads[lane], sequence, total).canvas;
    frames.push({
      version: densityBits === 4 ? 3 : 2,
      sequence,
      total,
      payload: payloads[lane],
    });
    const x = (lane % layout.columns) * laneRenderSize;
    const y = Math.floor(lane / layout.columns) * laneRenderSize;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, x, y, laneRenderSize, laneRenderSize);
  }

  return { canvas, frames, layout };
}

export function cropOptiLaneGrid(source: ImageData, laneCount: OptiLaneCount) {
  const layout = getOptiLaneLayout(laneCount);
  const targetAspect = layout.columns / layout.rows;
  let gridWidth = source.width;
  let gridHeight = Math.floor(gridWidth / targetAspect);

  if (gridHeight > source.height) {
    gridHeight = source.height;
    gridWidth = Math.floor(gridHeight * targetAspect);
  }

  if (gridWidth < OPTIFRAME_SIZE * layout.columns || gridHeight < OPTIFRAME_SIZE * layout.rows) return [];

  const gridX = Math.floor((source.width - gridWidth) / 2);
  const gridY = Math.floor((source.height - gridHeight) / 2);
  const laneWidth = Math.floor(gridWidth / layout.columns);
  const laneHeight = Math.floor(gridHeight / layout.rows);
  if (laneWidth < OPTIFRAME_SIZE || laneHeight < OPTIFRAME_SIZE) return [];

  return Array.from({ length: laneCount }, (_, lane) => {
    const col = lane % layout.columns;
    const row = Math.floor(lane / layout.columns);
    const x = gridX + col * laneWidth;
    const y = gridY + row * laneHeight;
    const width = col === layout.columns - 1 ? gridWidth - col * laneWidth : laneWidth;
    const height = row === layout.rows - 1 ? gridHeight - row * laneHeight : laneHeight;
    const image = new ImageData(width, height);
    for (let line = 0; line < height; line += 1) {
      const sourceStart = ((y + line) * source.width + x) * 4;
      image.data.set(source.data.subarray(sourceStart, sourceStart + width * 4), line * width * 4);
    }
    return { lane, image, offsetX: x, offsetY: y };
  });
}
