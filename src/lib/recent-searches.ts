/**
 * SR-09 — recent searches for Find (distinct from SV-01 saved searches:
 * these are automatic, unnamed, and capped hard). Stored browser-local,
 * re-validated on load — an entry with an unknown mode cannot be injected
 * by editing storage. Newest first; a repeated search moves to the front
 * instead of duplicating.
 */
export const RECENT_SEARCHES_KEY = "fusion.recent-searches.v1";
export const RECENT_LIMIT = 20;
export interface RecentSearch { q: string; scope: string; mode: "text" | "metadata"; at: number }

export function validateRecents(raw: unknown): RecentSearch[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentSearch[] = [];
  for (const r of raw as RecentSearch[]) {
    if (!r || typeof r.q !== "string" || !r.q.trim() || (r.mode !== "text" && r.mode !== "metadata")) continue;
    out.push({ q: r.q, scope: typeof r.scope === "string" ? r.scope : "", mode: r.mode, at: Number(r.at) || 0 });
    if (out.length >= RECENT_LIMIT) break;
  }
  return out;
}

export function pushRecent(list: RecentSearch[], entry: RecentSearch): RecentSearch[] {
  const rest = list.filter((r) => !(r.q === entry.q && r.scope === entry.scope && r.mode === entry.mode));
  return [entry, ...rest].slice(0, RECENT_LIMIT);
}

export function loadRecents(storage: Pick<Storage, "getItem">): RecentSearch[] {
  try { return validateRecents(JSON.parse(storage.getItem(RECENT_SEARCHES_KEY) ?? "[]")); } catch { return []; }
}

export function storeRecents(storage: Pick<Storage, "setItem">, list: RecentSearch[]): void {
  storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
}
