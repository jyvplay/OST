/** BK-11: which dated backups to prune from /Backups. Only strictly
 *  dated files are eligible — an undated file is never deleted by a
 *  policy it cannot be evaluated against. Keeps the N newest. */
import { backupInventory } from "./backup-inventory";
export function prunePlan(names: string[], keep: number, now: Date): string[] {
  const dated = backupInventory(names, now).filter((e) => e.at !== null);
  return dated.slice(Math.max(0, keep)).map((e) => e.name);
}
