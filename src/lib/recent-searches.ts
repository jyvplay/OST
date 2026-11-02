import { privateSearchScope, searchInput, type SearchInput } from "./search-query";

/** Automatic browser-local history. Full inputs distinguish a literal/file
 * search from a ranked/all-source search with the same query. */
export const RECENT_SEARCHES_KEY = "fusion.recent-searches.v1";
export const RECENT_LIMIT = 20;
export interface RecentSearch extends Partial<Omit<SearchInput, "q" | "scope" | "mode">> { q: string; scope: string; mode: "text" | "metadata"; at: number }
export function validateRecents(raw: unknown): RecentSearch[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentSearch[] = [];
  for (const record of raw) {
    try {
      const input = searchInput(record);
      if (privateSearchScope(input.scope) || !input.q.trim() || (record.mode !== "text" && record.mode !== "metadata")) continue;
      out.push({ ...input, at: Number.isSafeInteger(record.at) && record.at >= 0 ? record.at : 0 });
      if (out.length >= RECENT_LIMIT) break;
    } catch { /* A corrupt entry does not erase valid neighbours. */ }
  }
  return out;
}
const identity = (record: RecentSearch) => JSON.stringify(searchInput(record));
export function pushRecent(list: RecentSearch[], entry: RecentSearch): RecentSearch[] {
  const next = validateRecents([entry])[0]; if (!next) return validateRecents(list);
  const key = identity(next);
  return [next, ...validateRecents(list).filter(record => identity(record) !== key)].slice(0, RECENT_LIMIT);
}
export function loadRecents(storage: Pick<Storage, "getItem">): RecentSearch[] {
  try { return validateRecents(JSON.parse(storage.getItem(RECENT_SEARCHES_KEY) ?? "[]")); } catch { return []; }
}
export function storeRecents(storage: Pick<Storage, "setItem">, list: RecentSearch[]): void {
  storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(validateRecents(list)));
}
export function clearRecents(storage: Pick<Storage, "removeItem">): void { storage.removeItem(RECENT_SEARCHES_KEY); }

/** Remove older versions' automatically recorded Private queries. Never creates
 * an empty history key. Explicit named profiles are separate, opt-in records. */
export function purgePrivateRecents(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): void {
  let text: string | null, raw: unknown;
  try { text = storage.getItem(RECENT_SEARCHES_KEY); } catch { return; }
  try { raw = JSON.parse(text ?? "[]"); } catch {
    // Unreadable JSON cannot be filtered record by record. Keeping it would
    // leave an old Private query on disk despite presenting an empty history.
    clearRecents(storage); return;
  }
  // Validate every legacy record, not just already-canonical /Private paths.
  // Old repeated-slash/dot-segment Private aliases must not remain on disk
  // merely because the current decoder refuses to display them.
  const kept = validateRecents(raw);
  if (Array.isArray(raw) && kept.length === raw.length) return;
  if (kept.length) storeRecents(storage, kept); else clearRecents(storage);
}
