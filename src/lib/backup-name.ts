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
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  // Date normalizes overflow (including DST gaps) and its multi-argument
  // constructor maps years 0–99 to 1900–1999. Never let a normalized date
  // make an unknown filename eligible for destructive retention decisions.
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(hour, minute, 0, 0);
  return Number.isFinite(d.getTime()) && d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day && d.getHours() === hour && d.getMinutes() === minute ? d : null;
}
