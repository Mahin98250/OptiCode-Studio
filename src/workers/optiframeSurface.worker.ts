import { rasterizeOptiFrame } from '../lib/optiframe';
import { getOptiLaneLayout } from '../lib/optiframeLanes';
import type { OptiLaneCount } from '../lib/optiframeLanes';

type Request = {
  id: number;
  key: string;
  baseSequence: number;
  total: number;
  laneCount: OptiLaneCount;
  payloads: ArrayBuffer[];
};

type Response = {
  id: number;
  key: string;
  width?: number;
  height?: number;
  bitmap?: ImageBitmap;
  error?: string;
};

const scope = self as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage: (message: Response, transfer?: Transferable[]) => void;
};

function getRenderScale(laneCount: OptiLaneCount) {
  return laneCount === 1 ? 4 : laneCount === 2 || laneCount === 4 ? 3 : 2;
}

scope.onmessage = async (event) => {
  const { id, key, baseSequence, total, laneCount, payloads } = event.data;
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas unavailable.');

    const layout = getOptiLaneLayout(laneCount);
    const renderScale = getRenderScale(laneCount);
    const laneSize = 180 * renderScale;
    const surface = new OffscreenCanvas(layout.columns * laneSize, layout.rows * laneSize);
    const ctx = surface.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Offscreen canvas context unavailable.');

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, surface.width, surface.height);

    const tile = new OffscreenCanvas(180, 180);
    const tileCtx = tile.getContext('2d', { alpha: false });
    if (!tileCtx) throw new Error('OptiFrame tile context unavailable.');
    tileCtx.imageSmoothingEnabled = false;

    for (let lane = 0; lane < laneCount; lane += 1) {
      const buffer = payloads[lane];
      if (!buffer) continue;
      const raster = rasterizeOptiFrame(
        new Uint8Array(buffer),
        total > 0 ? (baseSequence + lane) % total : baseSequence + lane,
        total,
      );
      tileCtx.putImageData(new ImageData(raster.pixels, raster.width, raster.height), 0, 0);
      const x = (lane % layout.columns) * laneSize;
      const y = Math.floor(lane / layout.columns) * laneSize;
      ctx.drawImage(tile, x, y, laneSize, laneSize);
    }

    const bitmap = surface.transferToImageBitmap();
    scope.postMessage(
      { id, key, width: surface.width, height: surface.height, bitmap },
      [bitmap],
    );
  } catch (error) {
    scope.postMessage({
      id,
      key,
      error: error instanceof Error ? error.message : 'OptiFrame surface render failed.',
    });
  }
};
