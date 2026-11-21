/** BK-11: which dated backups to prune from /Backups. Only strictly
 *  dated files are eligible — an undated file is never deleted by a
 *  policy it cannot be evaluated against. Keeps the N newest. */
import { backupInventory } from "./backup-inventory";
import { parseBackupDate } from "./backup-name";

/** Future dates can displace known-good copies from the retention set after a
 * clock correction. Refuse the whole plan rather than guess which copy is new. */
export function pruneClockUncertain(names: string[], now: Date): boolean {
  const time = now.getTime();
  return !Number.isFinite(time) || names.some((name) => {
    const date = parseBackupDate(name);
    return date !== null && date.getTime() > time;
  });
}
export function prunePlan(names: string[], keep: number, now: Date): string[] {
  if (pruneClockUncertain(names, now)) return [];
  const dated = backupInventory(names, now).filter((e) => e.at !== null);
  return dated.slice(Math.max(0, keep)).map((e) => e.name);
}
