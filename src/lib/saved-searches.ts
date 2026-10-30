/** TT118 SV-01 — saved searches for Find.
 * A saved search is (name, query, scope, mode) — the full input, so re-running
 * it reproduces the search rather than approximating it. Stored browser-local;
 * validated on every read so a hand-edited record cannot inject a mode the
 * Find module does not have. Duplicates by name are refused. */
export interface SavedSearch { id: string; name: string; q: string; scope: string; mode: "text" | "metadata"; savedAt: number }
export const SAVED_SEARCH_KEY = "fusion.saved-searches.v1";
export const SAVED_SEARCH_LIMIT = 30;
export function validateSavedSearches(list: unknown): SavedSearch[] {
  if (!Array.isArray(list)) throw new Error("saved searches must be an array");
  if (list.length > SAVED_SEARCH_LIMIT) throw new Error(`at most ${SAVED_SEARCH_LIMIT} saved searches`);
  const out = list.map((raw) => {
    const s = raw as SavedSearch;
    if (!s || typeof s.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(s.id)) throw new Error("saved search id is invalid");
    if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 80) throw new Error("saved search needs a name");
    if (s.mode !== "text" && s.mode !== "metadata") throw new Error(`saved search mode "${String(s.mode)}" is not a Find mode`);
    return { id: s.id, name: s.name.trim(), q: String(s.q ?? "").slice(0, 500), scope: String(s.scope ?? "").slice(0, 300), mode: s.mode, savedAt: Number.isSafeInteger(s.savedAt) ? s.savedAt : 0 };
  });
  if (new Set(out.map((s) => s.name.toLowerCase())).size !== out.length) throw new Error("saved search names must be unique");
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
export function loadSavedSearches(storage: Storage): SavedSearch[] {
  try { return validateSavedSearches(JSON.parse(storage.getItem(SAVED_SEARCH_KEY) ?? "[]")); } catch { return []; }
}
export function storeSavedSearches(storage: Storage, list: SavedSearch[]): void {
  storage.setItem(SAVED_SEARCH_KEY, JSON.stringify(validateSavedSearches(list)));
}
