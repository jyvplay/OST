/** TT125 AP-02: most-recently-opened modules for THIS session only — nothing
 *  is persisted, and the list is capped so it stays a hint, not a log. */
export const RECENT_MAX = 8;
export function pushRecent(list: ReadonlyArray<string>, id: string, cap: number = RECENT_MAX): string[] {
  const next = [id, ...list.filter((x) => x !== id)];
  return next.slice(0, cap);
}

const KEY = "ost-recents-v1";
export function getRecents(): string[] {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as string[]; } catch { return []; }
}
export function pushRecentStore(id: string): string[] {
  const next = pushRecent(getRecents(), id);
  try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: hint only */ }
  return next;
}
