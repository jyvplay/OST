/**
 * MU-02 — recently played tracks for Music/Streams. Automatic history,
 * distinct from the queue and from shuffle's back-stack: playing a track
 * again moves it to the front rather than duplicating it, and the list is
 * capped so a long session cannot grow storage without bound. Titles are
 * stored so the list still reads correctly after the library changes.
 */
export const RECENT_PLAYS_KEY = "fusion.recent-plays.v1";
export const RECENT_PLAYS_LIMIT = 50;
export interface RecentPlay { id: string; title: string; at: number }

export function validatePlays(raw: unknown): RecentPlay[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentPlay[] = [];
  const seen = new Set<string>();
  for (const r of raw as RecentPlay[]) {
    if (!r || typeof r.id !== "string" || !r.id || typeof r.title !== "string" || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, title: r.title, at: Number(r.at) || 0 });
    if (out.length >= RECENT_PLAYS_LIMIT) break;
  }
  return out;
}

export function pushPlay(list: RecentPlay[], entry: RecentPlay): RecentPlay[] {
  return [entry, ...list.filter((p) => p.id !== entry.id)].slice(0, RECENT_PLAYS_LIMIT);
}

export function loadPlays(storage: Pick<Storage, "getItem">): RecentPlay[] {
  try { return validatePlays(JSON.parse(storage.getItem(RECENT_PLAYS_KEY) ?? "[]")); } catch { return []; }
}

export function storePlays(storage: Pick<Storage, "setItem">, list: RecentPlay[]): void {
  storage.setItem(RECENT_PLAYS_KEY, JSON.stringify(list.slice(0, RECENT_PLAYS_LIMIT)));
}
