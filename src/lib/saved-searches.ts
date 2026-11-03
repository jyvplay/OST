import { EMPTY_SEARCH, searchInput, validSearchText, type SearchInput } from "./search-query";

/** Legacy v1 browser records remain readable. Missing controls receive explicit
 * defaults; new saves keep every Find input rather than only query/scope/mode. */
export interface SavedSearch extends Partial<Omit<SearchInput, "q" | "scope" | "mode">> {
  id: string; name: string; q: string; scope: string; mode: "text" | "metadata"; savedAt: number;
}
export const SAVED_SEARCH_KEY = "fusion.saved-searches.v1";
export const SAVED_SEARCH_LIMIT = 30;
export const SEARCH_EXPORT_LIMIT = 512 * 1024;
export function validateSavedSearches(list: unknown): SavedSearch[] {
  if (!Array.isArray(list)) throw new Error("saved searches must be an array");
  if (list.length > SAVED_SEARCH_LIMIT) throw new Error(`at most ${SAVED_SEARCH_LIMIT} saved searches`);
  const out = list.map(raw => {
    const s = raw as SavedSearch;
    const keys = new Set([...Object.keys(EMPTY_SEARCH), "id", "name", "savedAt"]);
    if (s && typeof s === "object" && Object.keys(s).some(key => !keys.has(key))) throw new Error("Unsupported saved-search field");
    if (!s || typeof s.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(s.id)) throw new Error("saved search id is invalid");
    if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 80 || !validSearchText(s.name) || /[\x00-\x1f\x7f]/.test(s.name)) throw new Error("saved search needs a name of at most 80 characters");
    if (s.mode !== "text" && s.mode !== "metadata") throw new Error(`saved search mode "${String(s.mode)}" is not a Find mode`);
    if (!Number.isSafeInteger(s.savedAt) || s.savedAt < 0) throw new Error("saved search date must be a nonnegative integer");
    return { ...searchInput(s), id: s.id, name: s.name.trim(), savedAt: s.savedAt };
  });
  if (new Set(out.map(s => s.name.normalize("NFKC").toLowerCase())).size !== out.length) throw new Error("saved search names must be unique");
  if (new Set(out.map(s => s.id)).size !== out.length) throw new Error("saved search ids must be unique");
  return out.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
}
export function loadSavedSearches(storage: Pick<Storage, "getItem">): SavedSearch[] {
  try { return validateSavedSearches(JSON.parse(storage.getItem(SAVED_SEARCH_KEY) ?? "[]")); } catch { return []; }
}
export function storeSavedSearches(storage: Pick<Storage, "setItem">, list: SavedSearch[]): void {
  // Validation finishes before the one atomic Storage.setItem call.
  storage.setItem(SAVED_SEARCH_KEY, JSON.stringify(validateSavedSearches(list)));
}
export function exportSavedSearches(list: SavedSearch[]): string {
  return JSON.stringify({ kind: "fusion.saved-searches.v2", searches: validateSavedSearches(list) }, null, 2) + "\n";
}
export function importSavedSearches(text: string): SavedSearch[] {
  if (new TextEncoder().encode(text).byteLength > SEARCH_EXPORT_LIMIT) throw new Error("Saved-search import is limited to 512 KiB");
  let data: { kind?: unknown; searches?: unknown };
  try { data = JSON.parse(text); } catch { throw new Error("Invalid saved-search JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.kind !== "fusion.saved-searches.v2") throw new Error("Not a supported Fusion saved-search export");
  if (Object.keys(data).some(key => key !== "kind" && key !== "searches")) throw new Error("Unsupported saved-search export field");
  return validateSavedSearches(data.searches);
}
