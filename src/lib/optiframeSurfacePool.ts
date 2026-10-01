import type { OptiFrameDensity } from './optiframe';
import type { OptiLaneCount } from './optiframeLanes';

type SurfaceJob = {
  id: number;
  generation: number;
  key: string;
  baseSequence: number;
  total: number;
  laneCount: OptiLaneCount;
  densityBits: OptiFrameDensity;
  payloads: ArrayBuffer[];
};

type SurfaceResponse = {
  id: number;
  key: string;
  width?: number;
  height?: number;
  bitmap?: ImageBitmap;
  error?: string;
};

type SurfaceWorkerSlot = {
  worker: Worker;
  busy: boolean;
  failed: boolean;
};

export class OptiFrameSurfacePool {
  private readonly workers: SurfaceWorkerSlot[] = [];
  private readonly queue: SurfaceJob[] = [];
  private readonly pending = new Map<number, SurfaceJob>();
  private readonly ready = new Map<string, ImageBitmap>();
  private nextId = 1;
  private generation = 0;

  constructor(
    size = Math.min(2, Math.max(1, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2) - 1)),
    enabled = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined',
  ) {
    if (!enabled) return;

    const count = Math.max(0, Math.min(2, Math.floor(size)));
    for (let index = 0; index < count; index += 1) {
      try {
        const worker = new Worker(
          new URL('../workers/optiframeSurface.worker.ts', import.meta.url),
          { type: 'module' },
        );
        const slot: SurfaceWorkerSlot = { worker, busy: false, failed: false };
        worker.onmessage = (event: MessageEvent<SurfaceResponse>) => {
          const job = this.pending.get(event.data.id);
          if (!job) return;
          this.pending.delete(event.data.id);
          slot.busy = false;

          if (event.data.bitmap) {
            if (job.generation === this.generation) {
              const previous = this.ready.get(job.key);
              previous?.close();
              this.ready.set(job.key, event.data.bitmap);
            } else {
              event.data.bitmap.close();
            }
          }

          this.dispatch();
        };
        worker.onerror = () => {
          slot.failed = true;
          slot.busy = false;
          worker.terminate();
          this.dispatch();
        };
        this.workers.push(slot);
      } catch {
        // Main-thread rendering remains the fallback when workers are blocked.
      }
    }
  }

  get capacity() {
    return this.workers.filter(slot => !slot.failed).length;
  }

  get busyCount() {
    return this.workers.filter(slot => !slot.failed && slot.busy).length;
  }

  get queuedCount() {
    return this.queue.length;
  }

  request(
    key: string,
    baseSequence: number,
    total: number,
    laneCount: OptiLaneCount,
    payloads: readonly Uint8Array[],
    densityBits: OptiFrameDensity = 2,
    transferPayloadOwnership = false,
  ) {
    if (this.capacity === 0 || payloads.length !== laneCount) return false;
    if (this.ready.has(key) || [...this.pending.values()].some(job => job.key === key) || this.queue.some(job => job.key === key)) {
      return false;
    }

    const job: SurfaceJob = {
      id: this.nextId++,
      generation: this.generation,
      key,
      baseSequence,
      total,
      laneCount,
      densityBits,
      payloads: payloads.map(payload =>
        transferPayloadOwnership &&
        payload.byteOffset === 0 &&
        payload.byteLength === payload.buffer.byteLength
          ? payload.buffer
          : payload.slice().buffer,
      ),
    };
    this.queue.push(job);
    this.dispatch();
    return true;
  }

  take(key: string) {
    const bitmap = this.ready.get(key) ?? null;
    if (bitmap) this.ready.delete(key);
    return bitmap;
  }

  has(key: string) {
    if (this.ready.has(key)) return true;
    if ([...this.pending.values()].some(job => job.key === key)) return true;
    return this.queue.some(job => job.key === key);
  }

  clear() {
    this.generation += 1;
    for (const bitmap of this.ready.values()) bitmap.close();
    this.ready.clear();
    this.queue.length = 0;
  }

  terminate() {
    this.clear();
    for (const slot of this.workers) slot.worker.terminate();
    this.workers.length = 0;
    this.pending.clear();
  }

  private dispatch() {
    for (const slot of this.workers) {
      if (slot.failed || slot.busy) continue;
      const job = this.queue.shift();
      if (!job) return;

      slot.busy = true;
      this.pending.set(job.id, job);

      try {
        slot.worker.postMessage(
          {
            id: job.id,
            key: job.key,
            baseSequence: job.baseSequence,
            total: job.total,
            laneCount: job.laneCount,
            densityBits: job.densityBits,
            payloads: job.payloads,
          },
          job.payloads,
        );
      } catch {
        this.pending.delete(job.id);
        slot.busy = false;
      }
    }
  }
}
