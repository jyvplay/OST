/**
 * BK-08 — backup freshness. Records when the last bundle was built
 * (browser-local: the server cannot know about a file the user downloaded
 * and kept offline) and judges staleness against a 7-day threshold the UI
 * states out loud. "Never" is a first-class state, not an epoch date.
 */
export const LAST_BACKUP_KEY = "fusion.last-backup.v1";
export const STALE_DAYS = 7;

export function backupAge(lastMs: number | null, now = Date.now()): { state: "never" | "fresh" | "stale"; days: number } {
  if (lastMs === null || !Number.isFinite(lastMs)) return { state: "never", days: 0 };
  const days = Math.floor((now - lastMs) / 86_400_000);
  return { state: days >= STALE_DAYS ? "stale" : "fresh", days: Math.max(0, days) };
}

export function freshnessLabel(lastMs: number | null, now = Date.now()): string {
  const a = backupAge(lastMs, now);
  if (a.state === "never") return "No backup built yet in this browser";
  if (a.days === 0) return "Last backup built today";
  return `Last backup built ${a.days} day${a.days === 1 ? "" : "s"} ago${a.state === "stale" ? ` — older than ${STALE_DAYS} days` : ""}`;
}
