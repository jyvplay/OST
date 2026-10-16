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
interface Queued { path: string; body: unknown; at: number }

const readQueue = (): Queued[] => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as Queued[]; } catch { return []; }
};
const writeQueue = (q: Queued[]) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* quota */ } };
export const queuedCount = () => (typeof localStorage === "undefined" ? 0 : readQueue().length);

export async function replayQueue(): Promise<{ replayed: number; failed: number }> {
  if (typeof localStorage === "undefined" || (typeof navigator !== "undefined" && !navigator.onLine)) return { replayed: 0, failed: 0 };
  const q = readQueue();
  let replayed = 0;
  while (q.length) {
    try {
      await api(q[0].path, { method: "POST", body: JSON.stringify(q[0].body) });
      q.shift(); replayed += 1; writeQueue(q);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 0 || status === 503) break; // still offline — keep everything
      return { replayed, failed: q.length };       // server rejected: stop, keep order
    }
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
      const q = readQueue(); q.push({ path, body, at: Date.now() }); writeQueue(q);
      throw Object.assign(new Error(`Offline — queued for replay (${q.length} pending). Nothing was lost.`), { queued: true, status });
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
