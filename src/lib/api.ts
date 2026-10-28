"use client";
import { privacy } from "./privacy/session";
import { isPrivatePath } from "./privacy/pcrypt";

// TT18: the privacy layer must wrap fetch before any module issues a request.
if (typeof window !== "undefined") privacy.install();

const CLIENT_KEY = "fusion.clientId";

export function clientId(): string {
  if (typeof localStorage === "undefined") return "server";
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { ok: false, error: text.slice(0, 200) }; }
  if (!res.ok && (data as { ok?: boolean } | null)?.ok !== true) {
    const err = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(err), { status: res.status, data });
  }
  return data as T;
}

/* ---------------------------------------------------------------- SH-14
 * Offline write queue. Only idempotent-enough, journaled endpoints are queued
 * (VFS writes and note creation); anything else fails loudly. Replay is strictly
 * ordered and stops at the first server rejection so a later write can never be
 * applied on top of an earlier one that failed.
 */
const QUEUE_KEY = "fusion.queue";
const QUEUEABLE = new Set(["/api/fs", "/api/notes"]);
interface Queued { path: string; body: unknown; at: number; id?: string }

// Mutators never replace unreadable/corrupt stored work with an empty queue.
const readQueueStrict = (): Queued[] => {
  const value: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  if (!Array.isArray(value) || value.some((q: unknown) => !q || typeof q !== "object" || typeof (q as Queued).path !== "string" || !("body" in q))) {
    throw new Error("Offline queue storage is unreadable");
  }
  return value as Queued[];
};
const readQueue = (): Queued[] => { try { return readQueueStrict(); } catch { return []; } };
// A failed localStorage write must not be reported as a durable queued operation.
const writeQueue = (q: Queued[]) => { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); };

// Lock network replay separately from short queue mutations: an offline enqueue
// must not wait for a slow server request. Older/nonparticipating tabs and
// browsers without Web Locks retain only per-tab best effort coordination.
const STORAGE_LOCK = "fusion.queue.storage.v1", REPLAY_LOCK = "fusion.queue.replay.v1";
const withQueueLock = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") return await navigator.locks.request(name, fn);
  return await fn();
};
const queueId = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const sameQueued = (a: Queued, b: Queued) => (a.id && b.id ? a.id === b.id : JSON.stringify(a) === JSON.stringify(b));
export const queuedCount = () => (typeof localStorage === "undefined" ? 0 : readQueue().length);
/** TT55 (FM-09 / DP-03): VFS writes still waiting in the offline queue — Files shows them as "queued" ghost rows */
export const queuedFsWrites = (): { op: string; path: string; at: number }[] => (typeof localStorage === "undefined" ? [] : readQueue()
  .filter((q) => q.path === "/api/fs").map((q) => ({ ...(q.body as { op?: string; path?: string; dst?: string }), at: q.at }))
  .map((b) => ({ op: String(b.op ?? "write"), path: String(b.path ?? b.dst ?? ""), at: b.at })).filter((b) => b.path));

// TT55: one replay at a time — mount + "online" (or two "online" events) used to run two replays that both read the
// queue before either shifted it, applying the head write twice
type ReplayResult = { replayed: number; failed: number; storageError?: "read" | "dequeue" };
let replaying: Promise<ReplayResult> | null = null;
export function replayQueue(): Promise<ReplayResult> {
  if (!replaying) replaying = withQueueLock(REPLAY_LOCK, replayOnce).finally(() => { replaying = null; });
  return replaying;
}
async function replayOnce(): Promise<ReplayResult> {
  if (typeof localStorage === "undefined" || (typeof navigator !== "undefined" && !navigator.onLine)) return { replayed: 0, failed: 0 };
  let q: Queued[];
  try { q = await withQueueLock(STORAGE_LOCK, readQueueStrict); } catch { return { replayed: 0, failed: 0, storageError: "read" }; }
  let replayed = 0;
  while (q.length) {
    const head = q[0];
    try {
      await api(head.path, { method: "POST", body: JSON.stringify(head.body) });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 0 || status === 503) break; // still offline — keep everything
      try { q = await withQueueLock(STORAGE_LOCK, readQueueStrict); } catch { return { replayed, failed: 0, storageError: "read" }; }
      return { replayed, failed: q.length }; // server rejected: stop, retain the current queue
    }
    try {
      // Re-read under the storage lock so enqueues made during the network
      // request survive; never delete a different head changed by another actor.
      q = await withQueueLock(STORAGE_LOCK, () => {
        const latest = readQueueStrict();
        if (!latest.length || !sameQueued(latest[0], head)) throw new Error("Offline queue changed during replay");
        latest.shift(); writeQueue(latest); return latest;
      });
    } catch {
      // The server may already have committed; replaying blindly can duplicate it.
      return { replayed, failed: 0, storageError: "dequeue" };
    }
    replayed += 1;
  }
  return { replayed, failed: 0 };
}

export const post = async <T = unknown>(path: string, body: unknown): Promise<T> => {
  try {
    return await api<T>(path, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    const offline = status === 503 || (typeof navigator !== "undefined" && !navigator.onLine) || e instanceof TypeError;
    const b = (body ?? {}) as Record<string, unknown>;
    const touchesPrivate = [b.path, b.src, b.dst].some((x) => typeof x === "string" && isPrivatePath(x));
    if (offline && touchesPrivate) {
      // never park Persistent Storage plaintext in the browser profile's offline queue
      throw Object.assign(new Error("Offline — Persistent Storage writes are not queued on the host; retry when online."), { status });
    }
    if (offline && QUEUEABLE.has(path) && typeof localStorage !== "undefined") {
      let count: number;
      try {
        count = await withQueueLock(STORAGE_LOCK, () => {
          const q = readQueueStrict(); q.push({ path, body, at: Date.now(), id: queueId() }); writeQueue(q); return q.length;
        });
      } catch {
        throw Object.assign(new Error("Offline — this operation could not be queued in browser storage. Keep your work open and retry when online."), { status });
      }
      throw Object.assign(new Error(`Offline — queued for replay (${count} pending); not yet saved to the server.`), { queued: true, status });
    }
    throw e;
  }
};
export const put = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const fmtBytes = (n: number) => {
  if (!Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

export const fmtTime = (d: string | number | Date) => new Date(d).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
