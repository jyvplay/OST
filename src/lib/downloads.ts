/**
 * TT136 (PR-07m) — the download queue behind "Save to Files".
 *
 * The Browser proxy could already copy bytes into /Downloads once. A download
 * *manager* needs the parts a single copy lacks and that this module owns:
 * a queue, monotonic progress, bounded retries with backoff, cancellation that
 * cannot resurrect, a completion check against a declared length/digest, and
 * collision-free names in one folder.
 *
 * Scope: entries describe HTTP(S) resources the private proxy fetched. Bytes
 * are held by the caller; nothing here performs network I/O.
 */

export const DOWNLOAD_LIMIT = 200;
export const DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const URL_MAX = 4096;
export const RETRY_LIMIT = 3;

export type DownloadState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface DownloadEntry {
  id: string;
  url: string;
  name: string;
  /** Declared total bytes, or null when the response did not say. */
  size: number | null;
  /** Bytes received so far; monotonic within an attempt. */
  received: number;
  state: DownloadState;
  attempts: number;
  /** Epoch ms when the last attempt failed; null when it never failed. */
  lastErrorAt: number | null;
  error?: string;
  /** Lower-case hex digest of the completed bytes, when the caller verified it. */
  sha256?: string;
}

const HEX = /^[0-9a-f]{64}$/;

export function validUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > URL_MAX) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.username || u.password) return false; // credentials never enter a queue entry
    return true;
  } catch { return false; }
}

/** Filesystem-safe name from a URL path; never empty, never a traversal segment. */
export function nameFromUrl(raw: string): string {
  if (!validUrl(raw)) throw new Error("Only http(s) URLs without credentials can be downloaded");
  const u = new URL(raw);
  let last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
  last = last.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  if (!last) last = `download-${u.hostname.replace(/[^a-z0-9.-]/gi, "_")}.bin`;
  if (new TextEncoder().encode(last).byteLength > 200) {
    const dot = last.lastIndexOf(".");
    const ext = dot > 0 ? last.slice(dot) : "";
    last = last.slice(0, 200 - ext.length) + ext;
  }
  return last;
}

/** "report.pdf" → "report (2).pdf" until the name is unused (case-insensitive). */
export function uniqueName(existing: readonly string[], name: string): string {
  const lower = new Set(existing.map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("No free name available in this folder");
}

export function createEntry(id: string, url: string, existing: readonly string[], declaredSize?: number | null): DownloadEntry {
  if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id)) throw new Error("Download ids are 1…40 lowercase alphanumerics or dashes");
  if (declaredSize != null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > DOWNLOAD_MAX_BYTES)) {
    throw new Error(`A download is limited to ${DOWNLOAD_MAX_BYTES} bytes`);
  }
  return { id, url, name: uniqueName(existing, nameFromUrl(url)), size: declaredSize ?? null, received: 0, state: "queued", attempts: 0, lastErrorAt: null };
}

export function start(entry: DownloadEntry): DownloadEntry {
  if (entry.state !== "queued" && entry.state !== "failed") throw new Error(`Cannot start a ${entry.state} download`);
  if (entry.state === "failed" && entry.attempts > RETRY_LIMIT) throw new Error("Retry limit reached");
  return { ...entry, state: "running", attempts: entry.attempts + 1, received: 0, error: undefined };
}

export function progress(entry: DownloadEntry, received: number): DownloadEntry {
  if (entry.state !== "running") throw new Error(`A ${entry.state} download cannot receive bytes`);
  if (!Number.isSafeInteger(received) || received < entry.received) throw new Error("Progress must be a non-decreasing safe integer");
  if (received > DOWNLOAD_MAX_BYTES) throw new Error("Download exceeds the 8 MiB VFS limit");
  if (entry.size !== null && received > entry.size) throw new Error("Received more bytes than the declared length");
  return { ...entry, received };
}

export interface RetryPlan { retry: boolean; delayMs: number; reason: string }

/** Exponential backoff: 2 s, 8 s, 32 s, then give up (bounded, deterministic). */
export function planRetry(entry: DownloadEntry, now: number): RetryPlan {
  if (entry.state !== "failed") return { retry: false, delayMs: 0, reason: "not failed" };
  if (entry.attempts >= RETRY_LIMIT) return { retry: false, delayMs: 0, reason: `${entry.attempts} attempts used` };
  const delay = 2_000 * 4 ** Math.max(0, entry.attempts - 1);
  const readyAt = (entry.lastErrorAt ?? now) + delay;
  return { retry: true, delayMs: Math.max(0, readyAt - now), reason: `attempt ${entry.attempts + 1} of ${RETRY_LIMIT}` };
}

export function fail(entry: DownloadEntry, now: number, error: string): DownloadEntry {
  if (entry.state !== "running") throw new Error(`A ${entry.state} download cannot fail`);
  if (!Number.isFinite(now) || now < 0) throw new Error("now must be a finite timestamp");
  return { ...entry, state: "failed", lastErrorAt: now, error: String(error).slice(0, 300) };
}

export function cancel(entry: DownloadEntry): DownloadEntry {
  if (entry.state === "done" || entry.state === "cancelled") return entry;
  return { ...entry, state: "cancelled", received: 0 };
}

/** Completion is refused unless the declared length and (when supplied) digest match. */
export function complete(entry: DownloadEntry, sha256?: string): DownloadEntry {
  if (entry.state !== "running") throw new Error(`A ${entry.state} download cannot complete`);
  if (entry.size !== null && entry.received !== entry.size) throw new Error(`Received ${entry.received} of ${entry.size} bytes`);
  if (entry.received === 0) throw new Error("An empty download is not saved");
  if (sha256 !== undefined && !HEX.test(sha256)) throw new Error("A digest must be 64 lowercase hex characters");
  return { ...entry, state: "done", sha256 };
}

/** Queue order preserved; running first, then queued, then history (stable). */
export function sortQueue(entries: readonly DownloadEntry[]): DownloadEntry[] {
  const weight: Record<DownloadState, number> = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 };
  return entries.map((e, i) => ({ e, i })).sort((a, b) => weight[a.e.state] - weight[b.e.state] || a.i - b.i).map((x) => x.e);
}

/** Next entry the scheduler should start: the first queued item, if nothing is running. */
export function nextToStart(entries: readonly DownloadEntry[]): DownloadEntry | null {
  if (entries.some((e) => e.state === "running")) return null;
  return entries.find((e) => e.state === "queued") ?? null;
}

export function summary(entries: readonly DownloadEntry[]): string {
  const done = entries.filter((e) => e.state === "done").length;
  const active = entries.filter((e) => e.state === "running" || e.state === "queued").length;
  const failed = entries.filter((e) => e.state === "failed").length;
  return `${done} saved · ${active} active · ${failed} failed`;
}
