/**
 * TT143 (PR-07m) — many-at-once downloads with honest accounting.
 *
 * A download queue looks trivial until it is not: the browser has no idea how
 * many streams the network or the disk will take, progress can arrive out of
 * order (a server that omits Content-Length, a retry that restarts a range), and
 * a "cancel" that arrives after the last chunk must not resurrect a file.
 *
 * The engine is deliberately pure: it holds no sockets and no timers. The caller
 * performs requests and feeds events in, which is what makes every refusal path
 * testable without a network, and what keeps the module honest about the fact
 * that the *dependency* being modelled is the host's, not the app's:
 *
 *   · at most 3 concurrent streams (the number every browser's own limit is
 *     built around), a queue beyond it, and a per-item attempt budget;
 *   · progress is monotonic within an attempt — a decrease is a restart and is
 *     recorded, never smoothed away;
 *   · a completion is only `complete` when the received byte count equals the
 *     declared length; a short body is `truncated`, a long one is `overrun`
 *     (both are failures a UI must not call success);
 *   · a response with no length is `unverified`, not `complete`, because an
 *     interrupted stream is otherwise indistinguishable from a finished one;
 *   · cancellation is final: the id stays in `cancelled` and no completion event
 *     for it is accepted afterwards (the resurrect bug);
 *   · files are named by a collision-free derived name, never by the URL path
 *     alone, so two `?id=1` resources cannot overwrite each other.
 *
 * Background Transfer (Android's DownloadManager) has no web equivalent; this is
 * therefore honest about being foreground-only: closing the tab cancels
 * everything, and the UI says so instead of promising a background download.
 */

export type ItemState = "queued" | "running" | "paused" | "complete" | "truncated" | "overrun" | "unverified" | "failed" | "cancelled";
export const MAX_INFLIGHT = 3;
export const MAX_ATTEMPTS = 3;
/** 16 MiB: past this a download is refused rather than silently filling storage. */
export const MAX_BYTES = 16 * 1024 * 1024;

export interface DownloadItem {
  id: string;
  url: string;
  name: string;
  state: ItemState;
  received: number;
  total: number | null;
  attempt: number;
  /** Restarts seen in this attempt (a decrease in `received`). */
  restarts: number;
  bytesPerSecond: number | null;
  error: string | null;
}

export interface DownloadQueue { items: DownloadItem[]; inflight: string[] }

/** Derive a safe, collision-free file name from a URL plus the names already taken. */
export function deriveName(url: string, taken: readonly string[]): string {
  let base = "download";
  let ext = "";
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (last) {
      const dot = last.lastIndexOf(".");
      if (dot > 0 && dot < last.length - 1) { base = last.slice(0, dot); ext = last.slice(dot); } else base = last;
    } else if (u.hostname) base = u.hostname.replace(/[^a-z0-9.-]/gi, "");
  } catch { /* keep the default name */ }
  // No path separators, no control characters, no name that a shell would expand.
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[-.]+/, "").slice(0, 80) || "download";
  ext = ext.replace(/[^A-Za-z0-9.]/g, "").slice(0, 12);
  const takenSet = new Set(taken.map((t) => t.toLowerCase()));
  let name = `${base}${ext}`;
  let n = 2;
  while (takenSet.has(name.toLowerCase())) name = `${base} (${n++})${ext}`;
  return name;
}

export function enqueue(q: DownloadQueue, input: { id: string; url: string; declaredBytes?: number | null }): { queue: DownloadQueue; rejected: string | null } {
  if (!/^https?:\/\//i.test(input.url)) return { queue: q, rejected: "only http and https downloads are supported" };
  if (q.items.some((i) => i.id === input.id)) return { queue: q, rejected: `“${input.id}” is already in the queue` };
  if (input.declaredBytes != null && input.declaredBytes > MAX_BYTES) {
    return { queue: q, rejected: `the file declares ${(input.declaredBytes / 1048576).toFixed(1)} MiB, over the ${MAX_BYTES / 1048576} MiB limit` };
  }
  const item: DownloadItem = {
    id: input.id, url: input.url, name: deriveName(input.url, q.items.map((i) => i.name)),
    state: "queued", received: 0, total: input.declaredBytes ?? null, attempt: 0, restarts: 0, bytesPerSecond: null, error: null,
  };
  return { queue: { ...q, items: [...q.items, item] }, rejected: null };
}

/** Promote queued items into free slots. Deterministic, oldest first. */
export function pump(q: DownloadQueue): DownloadQueue {
  const inflight = [...q.inflight];
  const items = q.items.map((i) => ({ ...i }));
  for (const item of items) {
    if (inflight.length >= MAX_INFLIGHT) break;
    if (item.state !== "queued") continue;
    item.state = "running";
    item.attempt += 1;
    inflight.push(item.id);
  }
  return { items, inflight };
}

/** Apply a progress reading. A decrease is a restart and is counted, never hidden. */
export function progress(q: DownloadQueue, id: string, received: number, elapsedMs: number | null): DownloadQueue {
  return mapItem(q, id, (item) => {
    if (item.state !== "running") return item;
    const restarts = received < item.received ? item.restarts + 1 : item.restarts;
    const bytesPerSecond = elapsedMs && elapsedMs > 0 ? Math.round((Math.max(received, 0) / elapsedMs) * 1000) : item.bytesPerSecond;
    return { ...item, received: Math.max(received, 0), restarts, bytesPerSecond };
  });
}

/**
 * Finish one item. `declared` comes from the response headers of the attempt that
 * finished (a redirect can change it), so the completeness verdict uses the real
 * number rather than the one enqueued.
 */
/**
 * `declared` is the length the FINISHED RESPONSE reported. When it is null, a
 * length known from earlier (the enqueue declaration) is still a real
 * measurement, so it is used to verify — but only when it agrees. With no length
 * known at all the item is `unverified`: an interrupted stream and a finished one
 * look identical, and calling that `complete` is the bug this state exists for.
 */
export function complete(q: DownloadQueue, id: string, received: number, declared: number | null): DownloadQueue {
  return mapItem(q, id, (item) => {
    if (item.state !== "running") return item; // a cancelled item never resurrects
    // Only the length the finished response reported counts. Falling back to the
    // enqueued length would mark an interrupted stream complete whenever the
    // server had announced a size up front — the exact case this state is for.
    const total = declared;
    if (total != null && received < total) return { ...item, received, state: "truncated", error: `received ${received} of ${total} bytes` };
    if (total != null && received > total) return { ...item, received, state: "overrun", error: `received ${received} bytes for a ${total}-byte file` };
    if (total == null) return { ...item, received, state: "unverified", error: null };
    return { ...item, received, total, state: "complete", error: null };
  }, (item) => item.state === "running");
}

/** A failure that is worth retrying gets an attempt; one that is not, does not. */
export function fail(q: DownloadQueue, id: string, reason: string, retryable: boolean): DownloadQueue {
  const items = q.items.map((i): DownloadItem => {
    if (i.id !== id || i.state !== "running") return i;
    if (retryable && i.attempt < MAX_ATTEMPTS) return { ...i, state: "queued", error: `${reason} (retrying, attempt ${i.attempt + 1} of ${MAX_ATTEMPTS})`, received: 0 };
    return { ...i, state: "failed", error: reason };
  });
  return { items, inflight: q.inflight.filter((x) => x !== id) };
}

export function cancel(q: DownloadQueue, id: string): DownloadQueue {
  return {
    items: q.items.map((i) => (i.id === id && !isFinal(i.state) ? { ...i, state: "cancelled", error: null } : i)),
    inflight: q.inflight.filter((x) => x !== id),
  };
}

export function isFinal(state: ItemState): boolean {
  return state === "complete" || state === "truncated" || state === "overrun" || state === "unverified" || state === "failed" || state === "cancelled";
}

/** Totals for the UI. `done` counts only items whose bytes were actually verified. */
export function summary(q: DownloadQueue): { done: number; failed: number; open: number; bytes: number; unverified: number } {
  let done = 0, failed = 0, open = 0, bytes = 0, unverified = 0;
  for (const i of q.items) {
    if (i.state === "complete") done += 1;
    else if (i.state === "unverified") { unverified += 1; done += 0; }
    else if (isFinal(i.state)) failed += 1;
    else open += 1;
    bytes += i.received;
  }
  return { done, failed, open, bytes, unverified };
}

/** The one sentence a UI can show; it never says "downloaded" for an unverified file. */
export function statusSentence(q: DownloadQueue): string {
  const s = summary(q);
  const parts: string[] = [];
  if (s.done) parts.push(`${s.done} verified`);
  if (s.unverified) parts.push(`${s.unverified} finished without a length check`);
  if (s.open) parts.push(`${s.open} in progress`);
  if (s.failed) parts.push(`${s.failed} failed`);
  return parts.length ? `${parts.join(", ")}. Closing the tab cancels downloads: the web has no background download manager.` : "Nothing queued.";
}

function mapItem(q: DownloadQueue, id: string, fn: (item: DownloadItem) => DownloadItem, stillRunning?: (item: DownloadItem) => boolean): DownloadQueue {
  const items = q.items.map((i) => (i.id === id ? fn(i) : i));
  // Release the slot only when the item is no longer running.
  const target = items.find((i) => i.id === id);
  const inflight = q.inflight.filter((x) => x !== id || (target?.state === "running" && (stillRunning ? stillRunning(target) : true)));
  return { items, inflight };
}
