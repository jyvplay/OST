/**
 * TT145 (FM-08) — what "local disk + removable volumes" can mean from a page.
 *
 * A page cannot enumerate volumes. There is no API that lists `/Volumes`, `D:\`
 * or a phone's internal storage, and `navigator.storage.estimate()` reports one
 * opaque quota for the origin, not free space on a device. What a page has is
 * three *granted handles* and one *storage estimate*, and the honest model is a
 * registry of what was granted, with the three ways a handle can go stale.
 *
 * The mechanism that makes this more than a list is **recovery**:
 *
 *   · a handle from the File System Access API survives a reload (IndexedDB), but
 *     it does **not** survive the file being moved, renamed or deleted, and it does
 *     not survive a permission change. `queryPermission` answers `prompt`,
 *     `granted` or `denied`, and a page must re-request inside a user gesture.
 *   · a handle from `<input type="file">` is a *snapshot copy* with no write path,
 *     so it is registered read-only and its permission never returns `granted`.
 *   · a directory handle can be enumerated with `values()`, which may throw
 *     `NotFoundError` mid-iteration when the volume is unplugged — the engine
 *     treats that as a *partial* listing, not as an empty folder, because an empty
 *     folder is a very different message.
 *
 * Pure: the engine takes plain facts (`kind`, permission, last error) and returns
 * decisions, so the test can simulate an unplugged USB stick without one.
 */

export const MAX_VOLUMES = 24;
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export type Kind = "directory" | "file" | "snapshot";
export type Permission = "granted" | "prompt" | "denied";

export interface Volume {
  /** Stable client id (a random name at grant time; never the OS path). */
  id: string;
  /** What the user called it, or the handle's own name. */
  label: string;
  kind: Kind;
  permission: Permission;
  /** Epoch ms of the last successful read. */
  lastSeenAt: number;
  /** Files seen in the last successful listing; null if never listed. */
  entries: number | null;
  /** The last error this handle produced, verbatim, or null. */
  lastError: string | null;
}

export interface Listing {
  kind: "complete" | "partial" | "refused";
  /** Names read before the failure, in handle order. */
  names: string[];
  /** Set when the listing stopped early. */
  stoppedBy: string | null;
  sentence: string;
}

/**
 * One enumeration. The distinction that matters: an empty directory and an
 * unreadable directory must never produce the same sentence, because "this folder
 * is empty" is the message that makes a user believe their files are gone.
 */
export function listing(names: string[], error: string | null, permission: Permission, kind: Kind): Listing {
  if (kind === "snapshot") return { kind: "refused", names, stoppedBy: "snapshot", sentence: "this entry came from a file picker: it is a copy, so there is no directory to enumerate" };
  if (permission === "denied") return { kind: "refused", names: [], stoppedBy: "denied", sentence: "permission was denied; nothing was read, and asking again needs a click from you" };
  if (permission === "prompt") return { kind: "refused", names: [], stoppedBy: "prompt", sentence: "permission lapsed (a reload does this); reopen to re-grant, nothing was read" };
  if (error) return { kind: "partial", names, stoppedBy: error, sentence: `${names.length} entr${names.length === 1 ? "y" : "ies"} read before ${error}; the rest was not reached, so this is not the whole folder` };
  return { kind: "complete", names, stoppedBy: null, sentence: names.length ? `${names.length} entries` : "this folder is empty (the handle was readable, which is how we know)" };
}

/**
 * A handle whose permission was granted but whose read now throws. The volume is
 * not removed: the user's grant is still theirs, and silently forgetting it makes
 * the next visit re-ask. It is *marked*, and the mark is what the UI shows.
 */
export function withError(v: Volume, error: string): Volume {
  return { ...v, lastError: error };
}

export interface Health { status: "ok" | "lapsed" | "stale" | "broken" | "read-only"; why: string }

export function health(v: Volume, now: number): Health {
  if (v.kind === "snapshot") return { status: "read-only", why: "a file-picker entry is a copy; it can be read and never written" };
  if (v.permission === "denied") return { status: "lapsed", why: "permission was denied; the entry stays listed so you can see what was revoked" };
  if (v.permission === "prompt") return { status: "lapsed", why: "permission needs a click after a reload; the files are still on the device" };
  if (v.lastError) return { status: "broken", why: `the last read failed: ${v.lastError}. A moved, renamed or unplugged volume looks exactly like this` };
  if (now - v.lastSeenAt > STALE_AFTER_MS) return { status: "stale", why: `not read for ${Math.round((now - v.lastSeenAt) / 86400000)} days; it may have moved` };
  return { status: "ok", why: v.entries === null ? "granted, never listed" : `${v.entries} entries at the last read` };
}

/**
 * What the page can say about *space*. `storage.estimate()` is the origin's quota,
 * which is not the disk's free space; a browser may also report 0 for a quota
 * without a usage, or omit the call entirely. This function refuses to turn any of
 * those into a number that looks like a disk.
 */
export function spaceSentence(estimate: { usage: number | null; quota: number | null } | null): string {
  if (!estimate) return "this browser exposes no storage estimate; the disk's free space is not available to a page";
  if (estimate.usage === null || estimate.quota === null) return "the estimate is partial; a missing field is reported as unknown, not as zero";
  if (estimate.quota <= 0) return "the browser reports a quota of 0, which means “unknown” here, not “full”";
  const pct = (estimate.usage / estimate.quota) * 100;
  return `${(estimate.usage / 1e6).toFixed(1)} MB of a ${(estimate.quota / 1e9).toFixed(2)} GB origin quota (${pct.toFixed(1)} %) — quota, not disk`;
}

/** Add or replace by id, bounded. A grant the user made is never silently duplicated. */
export function upsert(list: Volume[], next: Volume): { list: Volume[]; note: string } {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(next.id)) throw new Error(`volume id “${next.id}” must be a generated lowercase id, not an OS path`);
  if (next.label.length > 60) throw new Error("a volume label longer than 60 characters will not fit the shelf");
  if (list.some((v) => v.id === next.id)) {
    const replaced = list.map((v) => (v.id === next.id ? { ...next, lastSeenAt: Math.max(v.lastSeenAt, next.lastSeenAt) } : v));
    return { list: replaced, note: `replaced the grant for ${next.label}` };
  }
  if (list.length >= MAX_VOLUMES) throw new Error(`${list.length} volumes is the limit; remove one first`);
  return { list: [...list, next], note: `granted ${next.label} (${next.kind})` };
}

export const LIMITS = [
  "a page cannot enumerate volumes: every entry here came from a picker or a previous grant",
  "a handle does not survive the file being moved, renamed or deleted, only a reload",
  "a file-picker entry is a copy with no write path",
  "storage.estimate() is the origin's quota, not the disk's free space",
  "removable media reads fail mid-iteration when the device is unplugged; that is reported as partial, never as empty",
] as const;
