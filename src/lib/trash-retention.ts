/**
 * TT136 (FM-11) — trash retention as an explicit, reviewable plan.
 *
 * The Trash already recorded origin, date and size. What was missing is a
 * retention decision a person can inspect before anything is destroyed:
 *
 *   • age  — items deleted at or before `now - days` are eligible;
 *   • size — while the eligible set is larger than `maxBytes`, the oldest
 *            unpinned items are added until the budget is met;
 *   • pins — never purged, and they count towards the bytes that remain;
 *   • unknown timestamps are never purged (they are reported instead).
 *
 * Nothing is deleted here; the module returns a plan the caller confirms.
 */

export const TRASH_PLAN_LIMIT = 20_000;

export interface RetentionPolicy {
  /** 0 disables the age rule; 1…3650 days otherwise. */
  days: number;
  /** 0 disables the size rule; otherwise bytes. */
  maxBytes: number;
}

export interface TrashItem {
  path: string;
  bytes: number;
  /** Epoch milliseconds when the item was deleted; null/undefined when unknown. */
  deletedAt?: number | null;
  /** A pin protects the item from every rule. */
  pinned?: boolean;
}

export interface PurgePlan {
  purge: TrashItem[];
  kept: TrashItem[];
  /** Items whose timestamp was unusable; never purged, always reported. */
  unknown: TrashItem[];
  reclaimedBytes: number;
  remainingBytes: number;
  reasons: string[];
}

export function validatePolicy(policy: RetentionPolicy): RetentionPolicy {
  const { days, maxBytes } = policy;
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error("Retention days must be an integer 0…3650");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1e15) throw new Error("Retention size must be a safe integer 0…1 PB");
  return { days, maxBytes };
}

const dayMs = 86_400_000;

export function planTrashPurge(items: readonly TrashItem[], policy: RetentionPolicy, now: number): PurgePlan {
  const { days, maxBytes } = validatePolicy(policy);
  if (!Number.isFinite(now) || now < 0) throw new Error("now must be a finite epoch millisecond value");
  if (items.length > TRASH_PLAN_LIMIT) throw new Error(`At most ${TRASH_PLAN_LIMIT} trash entries can be planned at once`);

  const reasons: string[] = [];
  const known: TrashItem[] = [];
  const unknown: TrashItem[] = [];
  for (const item of items) {
    if (!item || typeof item.path !== "string" || !item.path.startsWith("/") || item.path.includes("\u0000")) throw new Error("Every trash entry needs an absolute path");
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error(`"${item.path}" has an invalid byte count`);
    const t = item.deletedAt;
    if (typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= now + dayMs) known.push(item);
    else unknown.push(item);
  }

  const cutoff = days === 0 ? -Infinity : now - days * dayMs;
  const pinned = known.filter((i) => i.pinned === true);
  const eligible = known.filter((i) => i.pinned !== true);
  const chosen = new Set<TrashItem>();

  if (days > 0) {
    for (const item of eligible) if ((item.deletedAt as number) <= cutoff) chosen.add(item);
    if (chosen.size) reasons.push(`${chosen.size} item(s) older than ${days} day(s)`);
  }

  // Size rule: work out what remains after the age rule, then add oldest unpinned items.
  let remaining = known.reduce((sum, i) => sum + (chosen.has(i) ? 0 : i.bytes), 0);
  if (maxBytes > 0 && remaining > maxBytes) {
    const candidates = eligible.filter((i) => !chosen.has(i)).sort((a, b) => (a.deletedAt as number) - (b.deletedAt as number));
    for (const item of candidates) {
      if (remaining <= maxBytes) break;
      chosen.add(item);
      remaining -= item.bytes;
    }
    reasons.push(`size budget ${maxBytes} bytes exceeded; oldest items added`);
  }

  const purge = known.filter((i) => chosen.has(i));
  const kept = known.filter((i) => !chosen.has(i));
  if (unknown.length) reasons.push(`${unknown.length} item(s) have no usable deletion date and are kept`);
  if (pinned.length) reasons.push(`${pinned.length} pinned item(s) are kept`);
  return {
    purge,
    kept,
    unknown,
    reclaimedBytes: purge.reduce((sum, i) => sum + i.bytes, 0),
    remainingBytes: kept.reduce((sum, i) => sum + i.bytes, 0),
    reasons,
  };
}

/** Compact confirmation text; the caller still asks before deleting. */
export function describePurge(plan: PurgePlan): string {
  if (!plan.purge.length) return `Nothing to purge · ${plan.kept.length} kept`;
  return `Purge ${plan.purge.length} item(s), ${plan.reclaimedBytes} bytes · ${plan.kept.length} kept`;
}
