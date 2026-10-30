/**
 * NT-03 — daily note resolution. The daily note is the note titled with
 * today's local date (YYYY-MM-DD). Resolution never guesses: an exact title
 * match wins, a `Daily YYYY-MM-DD` title is accepted as the same convention,
 * anything else is "not found" and the caller creates it. Local date, not
 * UTC — at 23:30 local the daily note is still today's.
 */
export function dailyTitle(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function findDailyNote<T extends { title: string }>(notes: T[], now = new Date()): T | null {
  const title = dailyTitle(now);
  return notes.find((n) => n.title.trim() === title)
    ?? notes.find((n) => n.title.trim().toLowerCase() === `daily ${title}`)
    ?? null;
}
