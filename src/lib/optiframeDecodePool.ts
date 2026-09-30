import type { OptiFrame, OptiFramePerspectiveDiagnostics } from './optiframe';

export type OptiFrameWorkerResult = {
  frame: OptiFrame;
  diagnostics: OptiFramePerspectiveDiagnostics;
  workerMs: number;
  workerIndex: number;
};

type Pending = {
  workerIndex: number;
  resolve: (result: OptiFrameWorkerResult | null) => void;
  reject: (error: Error) => void;
  startedAt: number;
};

type WorkerResponse = {
  id: number;
  ok: boolean;
  frame?: OptiFrame;
  diagnostics?: OptiFramePerspectiveDiagnostics;
  error?: string;
};

type PoolWorker = {
  worker: Worker;
  busy: boolean;
  failed: boolean;
  index: number;
};

export class OptiFrameDecodePool {
  private readonly workers: PoolWorker[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    size = Math.min(4, Math.max(1, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2) - 1)),
    enabled = typeof Worker !== 'undefined',
  ) {
    if (!enabled) return;

    const count = Math.max(0, Math.min(4, Math.floor(size)));
    for (let index = 0; index < count; index += 1) {
      try {
        const worker = new Worker(
          new URL('../workers/optiframeDecoder.worker.ts', import.meta.url),
          { type: 'module' },
        );
        const poolWorker: PoolWorker = { worker, busy: false, failed: false, index };

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          const pending = this.pending.get(event.data.id);
          if (!pending) return;

          this.pending.delete(event.data.id);
          const slot = this.workers[pending.workerIndex];
          if (slot) slot.busy = false;

          if (!event.data.ok || !event.data.frame || !event.data.diagnostics) {
            pending.resolve(null);
            return;
          }

          pending.resolve({
            frame: event.data.frame,
            diagnostics: event.data.diagnostics,
            workerMs: performance.now() - pending.startedAt,
            workerIndex: pending.workerIndex,
          });
        };

        worker.onerror = () => {
          poolWorker.failed = true;
          poolWorker.busy = false;
          worker.terminate();
          for (const [id, pending] of this.pending) {
            if (pending.workerIndex !== index) continue;
            this.pending.delete(id);
            pending.reject(new Error('OptiFrame decoder worker failed.'));
          }
        };

        this.workers.push(poolWorker);
      } catch {
        // Continue with the workers that the browser allowed us to create.
      }
    }
  }

  get capacity() {
    return this.workers.filter(worker => !worker.failed).length;
  }

  get busyCount() {
    return this.workers.filter(worker => !worker.failed && worker.busy).length;
  }

  get available() {
    return this.workers.some(worker => !worker.failed && !worker.busy);
  }

  decode(
    buffer: ArrayBuffer,
    width: number,
    height: number,
    previousAnchors: OptiFramePerspectiveDiagnostics['anchors'] | null = null,
  ): Promise<OptiFrameWorkerResult | null> | null {
    const slot = this.workers.find(worker => !worker.failed && !worker.busy);
    if (!slot) return null;

    const id = this.nextId++;
    const startedAt = performance.now();
    slot.busy = true;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        workerIndex: slot.index,
        resolve,
        reject,
        startedAt,
      });

      try {
        slot.worker.postMessage({ id, width, height, buffer, previousAnchors }, [buffer]);
      } catch (error) {
        this.pending.delete(id);
        slot.busy = false;
        reject(error instanceof Error ? error : new Error('Unable to dispatch OptiFrame decode.'));
      }
    });
  }

  async decodeBatch(
    jobs: Array<{
      buffer: ArrayBuffer;
      width: number;
      height: number;
      previousAnchors?: OptiFramePerspectiveDiagnostics['anchors'] | null;
    }>,
  ): Promise<Array<OptiFrameWorkerResult | null>> {
    if (jobs.length === 0) return [];

    const results: Array<OptiFrameWorkerResult | null> = Array(jobs.length).fill(null);
    if (this.capacity === 0) return results;

    const queue = jobs.map((job, index) => ({ ...job, index }));
    const runnerCount = Math.min(this.capacity, jobs.length);

    const run = async () => {
      while (queue.length > 0) {
        // If every worker has failed while a batch is in flight, stop the
        // scheduler instead of retrying forever and hanging the receiver.
        if (this.capacity === 0) return;

        const item = queue.shift();
        if (!item) return;

        const job = this.decode(item.buffer, item.width, item.height, item.previousAnchors ?? null);
        if (!job) {
          queue.unshift(item);
          await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));
          continue;
        }

        try {
          results[item.index] = await job;
        } catch {
          results[item.index] = null;
        }
      }
    };

    await Promise.all(Array.from({ length: runnerCount }, run));
    return results;
  }

  terminate() {
    for (const slot of this.workers) slot.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.reject(new Error('OptiFrame decoder pool terminated.'));
    }
    this.pending.clear();
    this.workers.length = 0;
  }
}
