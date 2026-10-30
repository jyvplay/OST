/** BK-09: dated backup filenames. Local date (not UTC) so the name matches
 *  the day the user made it; parsing is strict so a renamed file is never
 *  mistaken for a dated backup. */
export function backupFilename(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `fusion-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}
export function parseBackupDate(name: string): Date | null {
  const m = /^fusion-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.json$/.exec(name);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isNaN(d.getTime()) ? null : d;
}
