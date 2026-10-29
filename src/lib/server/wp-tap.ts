/**
 * TT111 (RC-37) — the loaded-media tap.
 *
 * Recall's first use case is saving a picture, a track or a clip that the browser ALREADY has, at the
 * moment the human decides to keep it. Every pathway before this one either re-asked the network for
 * the bytes (`original-response`) or saved something the page had handed to this app directly (a
 * resident file, the clipboard, a canvas, a capture). Media inside the Fusion browser was the gap: the
 * bytes arrive at the proxy, stream through to an opaque-origin frame, and are then out of reach — the
 * desktop cannot read that frame's DOM, and proxied responses are deliberately `no-store`, so they are
 * not in the browser's disk cache either. Asking the publisher again is a different act with a
 * different result (a signed URL expires, a CDN rotates, a live image changes, the host goes down).
 *
 * So the bytes are kept where they already passed: in this server's memory, for the life of the proxy
 * session, and only when the human has switched the tap on. A save then reads RAM. No second request
 * is made, and the test for that is brutal — stop the origin, then save.
 *
 * Deliberate bounds, because "remember everything" is how a convenience becomes a liability:
 *  - OFF by default. The switch is `privacy.recallMediaTap`, read from the database (§ wp-tap-policy).
 *  - Media only (image/audio/video), complete 200 responses only. A 206 range is a slice of a file,
 *    not the file; retaining one and calling it the resource would be a lie.
 *  - Per item 8 MiB (RECALL_LIMIT), per session 24 items / 48 MiB, whole process 192 MiB. Oldest out
 *    first. Nothing is ever written to disk by the tap itself.
 *  - Dropped when the session ends, when the switch goes off, or when the human says forget.
 *  - It holds what the page loaded while it was open; it is not a history, and it survives nothing.
 */
import { onSessionEnd } from './wp-sessions';
import { RECALL_LIMIT } from '../recall-core';

export const TAP_ITEM_MAX = RECALL_LIMIT; // 8 MiB — the same ceiling a memory may occupy
export const TAP_SESSION_ITEMS = 24;
export const TAP_SESSION_BYTES = 48 * 1024 * 1024;
export const TAP_GLOBAL_BYTES = 192 * 1024 * 1024;
export const TAP_POLICY_KEY = 'privacy.recallMediaTap';
export const TAP_OFF_MESSAGE =
  'Keeping media the page loads is switched off (Settings → Privacy → Remember media this page loads)';

/** What the proxy saw: the bytes, and enough about the response to describe it honestly later. */
export interface TapEntry {
  id: string;
  url: string;
  mime: string;
  bytes: Buffer;
  at: number;
  /** the document the subresource was loaded for, when the proxy knew it */
  page: string | null;
  status: number;
}

/** Everything a listing may show. The bytes are not in it: a list is not a download. */
export type TapListing = Omit<TapEntry, 'bytes'> & { size: number };

const store = new Map<string, TapEntry[]>();
let globalBytes = 0;
let counter = 0;

const sizeOf = (list: TapEntry[]) => list.reduce((n, e) => n + e.bytes.length, 0);

function evict(sid: string): void {
  const list = store.get(sid);
  if (!list) return;
  while (list.length > TAP_SESSION_ITEMS || sizeOf(list) > TAP_SESSION_BYTES) {
    const gone = list.shift();
    if (!gone) break;
    globalBytes -= gone.bytes.length;
  }
  // A single runaway session must not starve the others, so pressure is relieved globally too:
  // oldest-first across every session, which is the same rule, one level up.
  while (globalBytes > TAP_GLOBAL_BYTES) {
    let oldest: { sid: string; at: number } | null = null;
    for (const [k, v] of store) if (v[0] && (!oldest || v[0].at < oldest.at)) oldest = { sid: k, at: v[0].at };
    if (!oldest) break;
    const victim = store.get(oldest.sid)!;
    const gone = victim.shift();
    if (!gone) { store.delete(oldest.sid); continue; }
    globalBytes -= gone.bytes.length;
    if (!victim.length) store.delete(oldest.sid);
  }
}

/** Only whole media responses are worth keeping, and only ones small enough to be a memory. */
export function tappableResponse(status: number, mime: string, headers: Record<string, string | string[] | undefined>): boolean {
  if (status !== 200) return false; // 206 is a slice, 3xx has no body of its own, errors are not media
  if (!/^(image|audio|video)\//i.test(mime)) return false;
  if (headers['content-range']) return false;
  const len = Number(headers['content-length'] ?? NaN);
  if (Number.isFinite(len) && len > TAP_ITEM_MAX) return false;
  return true;
}

/** Record a response the proxy has just finished delivering. Returns the entry id, or null if it did not fit. */
export function tapPut(sid: string, url: string, mime: string, bytes: Buffer, page: string | null, status = 200): string | null {
  if (!bytes.length || bytes.length > TAP_ITEM_MAX) return null;
  const list = store.get(sid) ?? [];
  // The same URL loaded twice is one memory of it: the newest bytes win, the slot is not doubled.
  const prior = list.findIndex((e) => e.url === url);
  if (prior >= 0) { globalBytes -= list[prior].bytes.length; list.splice(prior, 1); }
  const id = `t${(++counter).toString(36)}${Date.now().toString(36)}`;
  list.push({ id, url, mime, bytes, at: Date.now(), page, status });
  globalBytes += bytes.length;
  store.set(sid, list);
  evict(sid);
  return store.get(sid)?.some((e) => e.id === id) ? id : null;
}

export function tapList(sid: string): TapListing[] {
  return (store.get(sid) ?? []).map(({ bytes, ...rest }) => ({ ...rest, size: bytes.length }));
}

export function tapGet(sid: string, id: string): TapEntry | null {
  return (store.get(sid) ?? []).find((e) => e.id === id) ?? null;
}

/** The human's "forget this": the bytes leave memory now, not at some later sweep. */
export function tapForget(sid: string, id?: string): number {
  const list = store.get(sid);
  if (!list) return 0;
  const keep = id ? list.filter((e) => e.id !== id) : [];
  const dropped = list.length - keep.length;
  for (const e of list) if (!keep.includes(e)) globalBytes -= e.bytes.length;
  if (keep.length) store.set(sid, keep); else store.delete(sid);
  return dropped;
}

/** The switch went off: every session's retained bytes go now, not when each session happens to end. */
export function tapForgetAll(): number {
  let dropped = 0;
  for (const sid of [...store.keys()]) dropped += tapForget(sid);
  return dropped;
}

export function tapStats(): { sessions: number; items: number; bytes: number } {
  let items = 0;
  for (const v of store.values()) items += v.length;
  return { sessions: store.size, items, bytes: globalBytes };
}

/** A closed browser session keeps nothing: the tap dies with it. */
onSessionEnd('recall-tap', (sid) => { tapForget(sid); });
