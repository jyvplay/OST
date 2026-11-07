/**
 * TT143 (SH-14) — a write queue that survives going offline, and says what it
 * cannot promise.
 *
 * The web platform offers no durable outbox: `navigator.onLine` is a hint, a
 * Background Sync tag may never fire (Chromium-only, and throttled), and IndexedDB
 * is the only storage a page has that is not evicted on a whim. So the design is
 * explicit about its three guarantees and its one non-guarantee:
 *
 *   · **ordering** — writes are replayed in the order they were queued, per key;
 *     two writes to one key collapse to the latest, because replaying a stale
 *     edit over a newer one is a data-loss bug dressed as correctness;
 *   · **deduplication** — a write carries a content digest, so a retry of the same
 *     body is not applied twice (the classic duplicate-note bug);
 *   · **bounded** — the queue has a byte and an entry cap, and a write that would
 *     exceed it is refused *at enqueue time* with the reason, never silently
 *     dropped later;
 *   · **not durable** — a page cannot promise the queue survives the browser
 *     being killed mid-write. The honest statement is in `limits()`.
 *
 * Everything is a value: the caller decides when to flush, so a test can drive the
 * whole state machine without a network, and the shell can drive it with `fetch`.
 */

export interface QueuedWrite { key: string; method: "PUT" | "POST" | "DELETE"; path: string; body: string; digest: string; queuedAt: number; attempts: number }
export interface OfflineQueue { writes: QueuedWrite[]; bytes: number; dropped: string[] }
export const MAX_WRITES = 200;
export const MAX_BYTES = 512 * 1024;
/** Attempts before a write is parked as failed rather than retried forever. */
export const MAX_ATTEMPTS = 5;

export const emptyQueue = (): OfflineQueue => ({ writes: [], bytes: 0, dropped: [] });

/** FNV-1a 32-bit, hex. Cheap, and enough to distinguish two edits of one key. */
export function digest(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export type EnqueueResult = { queue: OfflineQueue; status: "queued" | "collapsed" | "duplicate" | "refused"; reason: string };

/**
 * Queue one write. A same-key write collapses to the newest (and the older one is
 * named in `collapsed`, so the UI can say what it replaced). A same-key,
 * same-digest write is a duplicate and is not queued at all.
 */
export function enqueue(q: OfflineQueue, w: Omit<QueuedWrite, "digest" | "queuedAt" | "attempts"> & { queuedAt?: number }): EnqueueResult {
  const d = digest(w.body);
  const existing = q.writes.find((x) => x.key === w.key);
  if (existing && existing.digest === d && existing.method === w.method) {
    return { queue: q, status: "duplicate", reason: `this exact body is already queued for “${w.key}”` };
  }
  const entry: QueuedWrite = { ...w, digest: d, queuedAt: w.queuedAt ?? Date.now(), attempts: 0 };
  let writes: QueuedWrite[];
  let status: EnqueueResult["status"];
  if (existing) {
    writes = q.writes.map((x) => (x.key === w.key ? entry : x));
    status = "collapsed";
  } else {
    writes = [...q.writes, entry];
    status = "queued";
  }
  const bytes = writes.reduce((n, x) => n + x.body.length + x.path.length + 32, 0);
  if (writes.length > MAX_WRITES || bytes > MAX_BYTES) {
    return { queue: q, status: "refused", reason: `the offline queue is full (${q.writes.length}/${MAX_WRITES} writes, ${Math.round(q.bytes / 1024)}/${MAX_BYTES / 1024} KiB); flush it or discard a pending write` };
  }
  return {
    queue: { writes, bytes, dropped: q.dropped },
    status,
    reason: status === "collapsed" ? `this replaces the queued write for “${w.key}”: replaying both would apply an older edit over a newer one` : `queued “${w.key}”`,
  };
}

/** The next write to send: oldest first, skipping anything parked. */
export function next(q: OfflineQueue): QueuedWrite | null {
  return q.writes.filter((w) => w.attempts < MAX_ATTEMPTS).sort((a, b) => a.queuedAt - b.queuedAt)[0] ?? null;
}

export function succeed(q: OfflineQueue, key: string): OfflineQueue {
  const writes = q.writes.filter((w) => w.key !== key);
  return { writes, bytes: writes.reduce((n, x) => n + x.body.length + x.path.length + 32, 0), dropped: q.dropped };
}

/**
 * A failed attempt. `conflict` (HTTP 409) is not retried: the row moved on, and
 * replaying would overwrite a newer state — the caller must re-read and re-apply.
 */
export function fail(q: OfflineQueue, key: string, reason: string, kind: "retryable" | "conflict" | "permanent"): OfflineQueue {
  const writes = q.writes.map((w) => (w.key === key ? { ...w, attempts: w.attempts + 1 } : w));
  const item = writes.find((w) => w.key === key);
  if (!item) return { ...q, writes };
  if (kind === "retryable" && item.attempts < MAX_ATTEMPTS) return { ...q, writes };
  const dropped = [...q.dropped, `${key}: ${reason}`];
  const kept = writes.filter((w) => w.key !== key);
  return { writes: kept, bytes: kept.reduce((n, x) => n + x.body.length + x.path.length + 32, 0), dropped };
}

/** What the queue holds, in one sentence, including what it cannot promise. */
export function describe(q: OfflineQueue): string {
  if (!q.writes.length) return q.dropped.length ? `Nothing waiting; ${q.dropped.length} write${q.dropped.length === 1 ? "" : "s"} could not be saved.` : "Nothing waiting to be sent.";
  const keys = new Set(q.writes.map((w) => w.key));
  return `${q.writes.length} write${q.writes.length === 1 ? "" : "s"} for ${keys.size} item${keys.size === 1 ? "" : "s"} waiting (${Math.round(q.bytes / 1024)} KiB). They are kept in this tab's storage and resent in order when the server answers again.`;
}

/** The limits, stated once, in the place a reader will look for them. */
export function limits(): string[] {
  return [
    "The queue lives in this origin's storage; clearing site data clears it.",
    "A background-sync tag would let Chromium retry after the tab closes; it may never fire, so the queue does not depend on it.",
    "A queued write is not a promise: a 409 means another device changed the same item, and the write is dropped rather than forced.",
  ];
}
