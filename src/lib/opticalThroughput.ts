import { getOptiLaneLayout, type OptiLaneCount } from './optiframeLanes';

export const OPTIFRAME_PAYLOAD_BYTES = 8000;

export type OpticalThroughputEstimate = {
  lanes: OptiLaneCount;
  refreshHz: number;
  payloadBytesPerLaneFrame: number;
  idealBytesPerSecond: number;
  goodputBytesPerSecond: number;
  secondsFor300MB: number;
};

export function getOptiSurfacePixels(lanes: OptiLaneCount) {
  const { columns, rows } = getOptiLaneLayout(lanes);
  const renderScale = lanes === 1 ? 5 : lanes === 2 || lanes === 4 ? 3 : 2;
  return {
    width: columns * 180 * renderScale,
    height: rows * 180 * renderScale,
    renderScale,
  };
}

export function estimateOpticalThroughput(
  lanes: OptiLaneCount,
  refreshHz: number,
  efficiency = 1,
  payloadBytesPerLaneFrame = OPTIFRAME_PAYLOAD_BYTES,
): OpticalThroughputEstimate {
  const safeHz = Math.max(0, refreshHz);
  const safeEfficiency = Math.max(0, Math.min(1, efficiency));
  const idealBytesPerSecond = lanes * safeHz * payloadBytesPerLaneFrame;
  const goodputBytesPerSecond = idealBytesPerSecond * safeEfficiency;
  return {
    lanes,
    refreshHz: safeHz,
    payloadBytesPerLaneFrame,
    idealBytesPerSecond,
    goodputBytesPerSecond,
    secondsFor300MB: goodputBytesPerSecond > 0
      ? (300 * 1024 * 1024) / goodputBytesPerSecond
      : Number.POSITIVE_INFINITY,
  };
}

export function recommendOptiLaneCount(
  displayWidth: number,
  displayHeight: number,
  devicePixelRatio = 1,
): OptiLaneCount {
  const widthPx = Math.max(0, Math.floor(displayWidth * Math.max(1, devicePixelRatio)));
  const heightPx = Math.max(0, Math.floor(displayHeight * Math.max(1, devicePixelRatio)));

  const candidates: OptiLaneCount[] = [16, 12, 9, 6, 4, 2, 1];
  for (const lanes of candidates) {
    const surface = getOptiSurfacePixels(lanes);
    if (widthPx >= surface.width && heightPx >= surface.height) return lanes;
  }
  return 1;
}

export function formatRate(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s';
  if (bytesPerSecond >= 1024 * 1024) return (bytesPerSecond / (1024 * 1024)).toFixed(2) + ' MB/s';
  return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
}

export function formatTransferTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds >= 60) return (seconds / 60).toFixed(1) + ' min';
  return seconds.toFixed(seconds < 10 ? 2 : 1) + ' s';
}

/**
 * Measure the actual browser paint cadence rather than assuming 60/120 Hz.
 * This is intentionally a passive measurement; it does not change display
 * refresh rate and does not block the main thread beyond requestAnimationFrame.
 */
export function measureDisplayRefreshRate(samples = 36): Promise<number> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve(60);
  }

  const count = Math.max(8, Math.floor(samples));
  return new Promise(resolve => {
    let previous = 0;
    const deltas: number[] = [];
    const tick = (now: number) => {
      if (previous > 0) {
        const delta = now - previous;
        if (delta >= 2 && delta <= 100) deltas.push(delta);
      }
      previous = now;
      if (deltas.length >= count) {
        const sorted = [...deltas].sort((a, b) => a - b);
        const middle = sorted[Math.floor(sorted.length / 2)];
        resolve(1000 / Math.max(1, middle));
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}
