/** BK-10: dated backups found in /Backups. Built on BK-09's strict name
 *  parsing and BK-08's age rules: an undated file in the folder is listed
 *  as unknown, never guessed into a false "fresh". */
import { parseBackupDate } from "./backup-name";
import { backupAge } from "./backup-freshness";
export interface BackupEntry { name: string; at: Date | null; freshness: "never" | "fresh" | "stale" | "unknown" }
export function backupInventory(names: string[], now: Date): BackupEntry[] {
  return names.map((name): BackupEntry => {
    const at = parseBackupDate(name);
    return { name, at, freshness: at ? backupAge(at.getTime(), now.getTime()).state : "unknown" };
  }).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
}
