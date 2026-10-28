/** A tiny bounded pool for the thumbnail protocol. No jobs execute on the UI
 * thread when workers are available. Deadlines include time waiting in queue. */
export class WorkerUnavailable extends Error {
  constructor() { super("thumbnail worker unavailable"); this.name = "WorkerUnavailable"; }
}

export function thumbnailWorkerLimit(cores: number | undefined, memoryGb?: number): number {
  if (typeof memoryGb === "number" && Number.isFinite(memoryGb) && memoryGb > 0 && memoryGb <= 4) return 1;
  if (typeof cores !== "number" || !Number.isFinite(cores) || cores < 2) return 1;
  return Math.max(1, Math.min(2, Math.floor(cores) - 1));
}

type Job<Q, R> = {
  id: number; input: Q; resolve: (value: R) => void; reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>; slot: Slot<Q, R> | null; signal?: AbortSignal; abort?: () => void;
};
type Slot<Q, R> = { worker: Worker; job: Job<Q, R> | null; idle: ReturnType<typeof setTimeout> | null };

/** Exactly one outstanding message per worker; stale/wrong response IDs are ignored. */
export class ThumbnailWorkerPool<Q extends object, R extends { id: number }> {
  private slots: Slot<Q, R>[] = [];
  private pending: Job<Q, R>[] = [];
  private nextId = 0;
  private capacity: number;
  private closed = false;
  private readonly makeWorker: () => Worker;
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  constructor(makeWorker: () => Worker, limit: number, idleMs = 30_000, timeoutMs = 12_000, maxPending = 64) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2 || !Number.isFinite(idleMs) || idleMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxPending) || maxPending < 1) throw new Error("invalid worker-pool limits");
    this.capacity = limit; this.makeWorker = makeWorker; this.idleMs = idleMs; this.timeoutMs = timeoutMs; this.maxPending = maxPending;
  }

  stats() { return { workers: this.slots.length, busy: this.slots.filter((s) => !!s.job).length, queued: this.pending.length, capacity: this.capacity }; }

  run(input: Q, signal?: AbortSignal): Promise<R> {
    if (this.closed) return Promise.reject(new Error("thumbnail pool closed"));
    if (signal?.aborted) return Promise.reject(new Error("thumbnail cancelled"));
    if (!this.capacity) return Promise.reject(new WorkerUnavailable());
    if (this.pending.length >= this.maxPending) return Promise.reject(new Error("thumbnail queue full"));
    return new Promise<R>((resolve, reject) => {
      const job: Job<Q, R> = { id: ++this.nextId, input, resolve, reject, slot: null, timer: setTimeout(() => this.expire(job), this.timeoutMs), signal };
      if (signal) { job.abort = () => this.cancel(job); signal.addEventListener("abort", job.abort, { once: true }); }
      this.pending.push(job); this.dispatch();
    });
  }

  private cleanup(job: Job<Q, R>) {
    clearTimeout(job.timer);
    if (job.signal && job.abort) job.signal.removeEventListener("abort", job.abort);
  }

  private spawn(): Slot<Q, R> {
    const worker = this.makeWorker();
    const slot: Slot<Q, R> = { worker, job: null, idle: null };
    worker.onmessage = (e: MessageEvent<R>) => {
      const job = slot.job;
      if (!job || !e.data || e.data.id !== job.id) return;
      this.cleanup(job); slot.job = null; job.slot = null;
      job.resolve(e.data);
      this.dispatch(); this.armIdle(slot);
    };
    worker.onerror = (e: ErrorEvent) => { e.preventDefault?.(); this.fail(slot, new Error("thumbnail worker crashed")); };
    worker.onmessageerror = () => this.fail(slot, new Error("thumbnail worker message could not be read"));
    this.slots.push(slot);
    return slot;
  }

  private dispatch() {
    while (!this.closed && this.pending.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.capacity) {
        try { slot = this.spawn(); }
        catch {
          // If a second worker cannot start, continue with the first. If none
          // can start, signal the caller to use its existing main-thread fallback.
          this.capacity = this.slots.length;
          if (!this.capacity) {
            for (const j of this.pending.splice(0)) { this.cleanup(j); j.reject(new WorkerUnavailable()); }
          }
          return;
        }
      }
      if (!slot) return;
      if (slot.idle) { clearTimeout(slot.idle); slot.idle = null; }
      const job = this.pending.shift()!; slot.job = job; job.slot = slot;
      try { slot.worker.postMessage({ ...job.input, id: job.id }); }
      catch { this.fail(slot, new Error("thumbnail worker could not receive the task")); return; }
    }
  }

  private expire(job: Job<Q, R>) { this.cancel(job, new Error("thumbnail timed out")); }

  private cancel(job: Job<Q, R>, error = new Error("thumbnail cancelled")) {
    if (job.slot) this.fail(job.slot, error);
    else {
      const i = this.pending.indexOf(job);
      if (i >= 0) { this.pending.splice(i, 1); this.cleanup(job); job.reject(error); }
    }
  }

  private fail(slot: Slot<Q, R>, error: Error) {
    if (!this.slots.includes(slot)) return;
    const job = slot.job; slot.job = null;
    this.remove(slot);
    if (job) { this.cleanup(job); job.slot = null; job.reject(error); }
    this.dispatch();
  }

  private armIdle(slot: Slot<Q, R>) {
    if (!this.slots.includes(slot) || slot.job || slot.idle) return;
    slot.idle = setTimeout(() => { slot.idle = null; if (!slot.job) this.remove(slot); }, this.idleMs);
  }

  private remove(slot: Slot<Q, R>) {
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    slot.worker.onmessage = null; slot.worker.onerror = null; slot.worker.onmessageerror = null;
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s !== slot);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.pending.splice(0)) { this.cleanup(job); job.reject(new Error("thumbnail pool closed")); }
    for (const slot of [...this.slots]) {
      const job = slot.job; slot.job = null;
      if (job) { this.cleanup(job); job.slot = null; job.reject(new Error("thumbnail pool closed")); }
      this.remove(slot);
    }
  }
}
