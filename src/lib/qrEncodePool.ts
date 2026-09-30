export type QrMatrix = {
  size: number;
  data: Uint8Array;
};

export type QrEncodeResult = {
  matrices: QrMatrix[];
  cacheHits: number;
  workerJobs: number;
  encodeMs: number;
};

type WorkerEncodeResult = {
  id: number;
  size: number;
  data: ArrayBuffer;
  processingMs: number;
};

type Pending = {
  value: string;
  resolve: (matrix: QrMatrix) => void;
  reject: (error: Error) => void;
};

type WorkerJob = {
  id: number;
  workerIndex: number;
  value: string;
  resolve: (matrix: QrMatrix) => void;
  reject: (error: Error) => void;
};

const CACHE_LIMIT = 48;

export class QrEncodePool {
  private readonly workers: Worker[] = [];
  private readonly busy = new Set<number>();
  private readonly queue: Pending[] = [];
  private readonly jobs = new Map<number, WorkerJob>();
  private readonly cache = new Map<string, QrMatrix>();
  private nextId = 1;

  constructor(size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))) {
    if (typeof Worker === 'undefined') return;
    const count = Math.max(1, Math.min(4, size));
    for (let index = 0; index < count; index += 1) this.addWorker(index);
  }

  get capacity() {
    return this.workers.length;
  }

  async encode(values: string[]): Promise<QrEncodeResult> {
    const started = performance.now();
    const pending = new Map<string, Promise<QrMatrix>>();
    const slots: Array<Promise<QrMatrix>> = [];
    let cacheHits = 0;

    for (const value of values) {
      const cached = this.cache.get(value);
      if (cached) {
        this.touch(value, cached);
        slots.push(Promise.resolve(cached));
        cacheHits += 1;
        continue;
      }

      let job = pending.get(value);
      if (!job) {
        job = this.enqueue(value);
        pending.set(value, job);
      }
      slots.push(job);
    }

    const matrices = await Promise.all(slots);
    return {
      matrices,
      cacheHits,
      workerJobs: pending.size,
      encodeMs: performance.now() - started,
    };
  }

  dispose() {
    const error = new Error('QR encoder pool disposed.');
    for (const pending of this.queue.splice(0)) pending.reject(error);
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
    this.busy.clear();
    for (const worker of this.workers) worker.terminate();
    this.cache.clear();
  }

  private enqueue(value: string) {
    const cached = this.cache.get(value);
    if (cached) {
      this.touch(value, cached);
      return Promise.resolve(cached);
    }

    return new Promise<QrMatrix>((resolve, reject) => {
      this.queue.push({ value, resolve, reject });
      this.pump();
    });
  }

  private addWorker(index: number) {
    try {
      const worker = new Worker(new URL('../workers/qrEncoder.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerEncodeResult>) => {
        const job = this.jobs.get(event.data.id);
        if (!job) return;

        this.jobs.delete(event.data.id);
        this.busy.delete(job.workerIndex);

        if (!event.data.size || !event.data.data.byteLength) {
          job.reject(new Error('QR encoder worker could not encode the payload.'));
          this.pump();
          return;
        }

        const matrix: QrMatrix = {
          size: event.data.size,
          data: new Uint8Array(event.data.data),
        };
        this.touch(job.value, matrix);
        job.resolve(matrix);
        this.pump();
      };

      worker.onerror = () => {
        const affected = [...this.jobs.values()].find(job => job.workerIndex === index);
        if (affected) {
          this.jobs.delete(affected.id);
          this.busy.delete(index);
          affected.reject(new Error('QR encoder worker failed.'));
        }
        this.pump();
      };

      this.workers.push(worker);
    } catch {
      // The Transfer page keeps a synchronous renderer as a browser fallback.
    }
  }

  private pump() {
    while (true) {
      const workerIndex = this.workers.findIndex((_, index) => !this.busy.has(index));
      const next = this.queue.shift();
      if (workerIndex < 0 || !next) {
        if (next) this.queue.unshift(next);
        return;
      }

      const worker = this.workers[workerIndex];
      const id = this.nextId++;
      this.busy.add(workerIndex);
      this.jobs.set(id, {
        id,
        workerIndex,
        value: next.value,
        resolve: next.resolve,
        reject: next.reject,
      });

      try {
        worker.postMessage({ id, value: next.value });
      } catch (error) {
        this.jobs.delete(id);
        this.busy.delete(workerIndex);
        next.reject(error instanceof Error ? error : new Error('QR encoder worker could not start.'));
      }
    }
  }

  private touch(value: string, matrix: QrMatrix) {
    this.cache.delete(value);
    this.cache.set(value, matrix);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}
