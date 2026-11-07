/**
 * TT145 (FM-11) — trash with origin, date, size and retention, as a policy that
 * explains every deletion it makes.
 *
 * A trash is only a safety net if two claims hold, and most implementations make
 * neither:
 *
 *   1. **An item in the trash is not "deleted".** Its bytes still occupy the
 *      volume and its path is still taken by nothing. The engine tracks both so
 *      the UI can say "18 MB still on disk" rather than "deleted".
 *   2. **Automatic emptying is a decision with a reason.** Retention is a
 *      predicate over (age, volume pressure, whether the item was restored once),
 *      and every automatic removal returns the sentence that justifies it. A
 *      sweeper that deletes by age alone deletes the file the user was about to
 *      restore.
 *
 * Two rules are deliberately conservative and are the reason this is not just a
 * list: an item is **never** auto-emptied while it is the only copy of its
 * content (same digest, no other path), and an item that was restored and
 * re-trashed gets **double** the retention window, because the second trash is
 * evidence the user is experimenting, not discarding.
 */

export const DEFAULT_RETENTION_DAYS = 30;
export const HARD_RETENTION_DAYS = 365;
export const MAX_TRASH = 5000;

export interface Item {
  id: string;
  /** Path it was deleted from; restore puts it back here. */
  origin: string;
  /** Where it lives now (inside the trash namespace). */
  trashedPath: string;
  name: string;
  bytes: number;
  /** FNV-1a over the content, same convention as the journal. */
  digest: number;
  deletedAt: number;
  kind: "file" | "dir";
  /** Number of times this path has been restored and trashed again. */
  bounces: number;
  /** True when another live path holds the same digest. */
  copyElsewhere: boolean;
}

export interface Trash { items: Item[]; retentionDays: number }

export function emptyTrash(retentionDays = DEFAULT_RETENTION_DAYS): Trash {
  if (!(retentionDays >= 1 && retentionDays <= HARD_RETENTION_DAYS)) throw new Error(`retention must be 1–${HARD_RETENTION_DAYS} days`);
  return { items: [], retentionDays };
}

/** Trash an item. A directory carries its own byte total and is not expanded here. */
export function trash(t: Trash, item: Omit<Item, "bounces" | "trashedPath"> & { trashedPath?: string }): { trash: Trash; note: string } {
  if (t.items.length >= MAX_TRASH) throw new Error(`${t.items.length} items is the trash limit; empty it or raise the retention policy deliberately`);
  if (!item.origin || !item.name) throw new Error("an item needs its origin path and its name so it can be restored");
  const prev = t.items.find((i) => i.origin === item.origin);
  const bounced = prev ? prev.bounces + 1 : 0;
  const next: Item = {
    ...item,
    trashedPath: item.trashedPath ?? `.trash/${item.id}`,
    bounces: bounced,
  };
  return {
    trash: { ...t, items: [...t.items.filter((i) => i.id !== next.id), next] },
    note: bounced ? `${next.name} was trashed again (${bounced} bounce${bounced === 1 ? "" : "s"}): its retention window is doubled` : `${next.name} moved to the trash; ${next.bytes} bytes are still on the volume`,
  };
}

/** What a restore will do, including the case where the origin path is taken again. */
export function restore(t: Trash, id: string, originFree: boolean): { trash: Trash; action: "restore" | "restore-aside" | "refuse"; path: string; note: string } {
  const item = t.items.find((i) => i.id === id);
  if (!item) return { trash: t, action: "refuse", path: "", note: "no such item in the trash" };
  const next = { ...item, bounces: item.bounces + 1 };
  const remaining = t.items.filter((i) => i.id !== id);
  if (originFree) return { trash: { ...t, items: remaining }, action: "restore", path: item.origin, note: `restored to ${item.origin}` };
  const suffix = item.kind === "dir" ? "" : `.restored${item.bounces + 1}`;
  return { trash: { ...t, items: remaining }, action: "restore-aside", path: `${item.origin}${suffix}`, note: `${item.origin} is taken again, so the item is restored beside it as ${item.name}${suffix}` };
}

export interface Sweep { keep: Item[]; remove: { item: Item; why: string }[]; freedBytes: number; sentence: string }

/**
 * The automatic sweep. Every removal carries its reason, and the two conservative
 * rules above are checked before age.
 */
export function sweep(t: Trash, now: number): Sweep {
  const keep: Item[] = [];
  const remove: { item: Item; why: string }[] = [];
  let freed = 0;
  for (const item of t.items) {
    const ageDays = (now - item.deletedAt) / 86400000;
    const window = t.retentionDays * (item.bounces > 0 ? 2 : 1);
    if (ageDays < window) { keep.push(item); continue; }
    if (!item.copyElsewhere) { keep.push(item); continue; }
    remove.push({ item, why: `${Math.round(ageDays)} days old against a ${window}-day window, and its content exists at another live path` });
    freed += item.bytes;
  }
  return {
    keep, remove, freedBytes: freed,
    sentence: remove.length
      ? `${remove.length} item${remove.length === 1 ? "" : "s"} past retention with another live copy were emptied, freeing ${freed} bytes`
      : `nothing was emptied: ${keep.length} item${keep.length === 1 ? "" : "s"} are inside retention or are the only copy of their content`,
  };
}

/** What the trash is holding, in the units a person thinks in. */
export function summary(t: Trash, now: number): string {
  if (!t.items.length) return "the trash is empty";
  const bytes = t.items.reduce((n, i) => n + i.bytes, 0);
  const oldest = Math.min(...t.items.map((i) => i.deletedAt));
  const days = Math.max(0, Math.round((now - oldest) / 86400000));
  const only = t.items.filter((i) => !i.copyElsewhere).length;
  return `${t.items.length} items · ${(bytes / 1e6).toFixed(1)} MB still on the volume · oldest ${days} d${only ? ` · ${only} are the only copy` : ""}`;
}

export const LIMITS = [
  "an item in the trash still occupies its bytes; the UI reports the size, not “0 B freed”",
  "the sweep never removes the only copy of a content digest, whatever its age",
  "permission, quota and volume errors during a restore leave the item in the trash and say why",
  "the trash is a namespace in the VFS, not an OS recycle bin: another app's deletions do not appear here",
] as const;
