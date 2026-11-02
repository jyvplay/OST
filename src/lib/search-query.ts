/** Shared, explicit Find inputs. Saving/replaying a search never substitutes
 * the current field/phrase/source controls for the saved ones. */
export const SEARCH_SOURCES = ["", "file", "note", "spec", "setting"] as const;
export type SearchSource = typeof SEARCH_SOURCES[number];
export type SearchSort = "relevance" | "title" | "reference";
export interface SearchInput {
  q: string; scope: string; mode: "text" | "metadata"; field: string; phrase: boolean;
  source: SearchSource; match: "ranked" | "literal"; extension: string; sort: SearchSort;
  filter: string; regex: boolean; caseSensitive: boolean;
}
export const EMPTY_SEARCH: SearchInput = { q: "", scope: "", mode: "text", field: "", phrase: false, source: "", match: "ranked", extension: "", sort: "relevance", filter: "", regex: false, caseSensitive: false };
/** URLSearchParams replaces unpaired surrogates; reject instead of silently
 * searching for a different string. This also protects portable profiles. */
export const validSearchText = (value: string): boolean => !value.includes("\0") && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
export const privateSearchScope = (scope: string): boolean => scope === "/Private" || scope.startsWith("/Private/");
export function searchScope(value: string): string {
  if (!validSearchText(value)) throw new Error("Scope must contain valid Unicode without NUL");
  if (value.trim().includes("//")) throw new Error("Scope must not contain repeated slashes");
  const scope = value.trim().replace(/\/+$/, "") || (value.trim() ? "/" : "");
  if (scope.length > 4096 || /[\x00-\x1f\x7f\\]/.test(scope) || (scope && !scope.startsWith("/")) || scope.split("/").some(p => p === "." || p === "..") || scope.includes("//")) throw new Error("Scope must be an absolute folder path without dot segments");
  return scope;
}
export function searchExtension(value: string): string {
  let extension = value.trim().toLowerCase(); if (extension && !extension.startsWith(".")) extension = `.${extension}`;
  if (extension && !/^\.[a-z0-9][a-z0-9._-]{0,30}$/.test(extension)) throw new Error("File extension must be a literal suffix such as .md or .tar.gz (up to 32 characters)");
  return extension;
}
export function searchInput(raw: unknown): SearchInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("search inputs must be an object");
  const data = raw as Record<string, unknown>, result = { ...EMPTY_SEARCH };
  for (const key of ["q", "scope", "field", "extension", "filter"] as const) if (Object.hasOwn(data, key)) {
    if (typeof data[key] !== "string" || !validSearchText(data[key] as string)) throw new Error(`${key} must be valid Unicode text without NUL`);
    result[key] = data[key] as string;
  }
  if (result.q.length > 512 || result.field.length > 256 || result.filter.length > 512 || result.extension.length > 32) throw new Error("Search text/field/filter exceeds its limit");
  result.scope = searchScope(result.scope); result.extension = searchExtension(result.extension);
  for (const key of ["phrase", "regex", "caseSensitive"] as const) if (Object.hasOwn(data, key)) {
    if (typeof data[key] !== "boolean") throw new Error(`${key} must be boolean`);
    result[key] = data[key] as boolean;
  }
  if (Object.hasOwn(data, "mode")) { if (data.mode !== "text" && data.mode !== "metadata") throw new Error("mode is not a Find mode"); result.mode = data.mode; }
  if (Object.hasOwn(data, "source")) { if (!SEARCH_SOURCES.includes(data.source as SearchSource)) throw new Error("Unknown search source"); result.source = data.source as SearchSource; }
  if (Object.hasOwn(data, "match")) { if (data.match !== "ranked" && data.match !== "literal") throw new Error("Unknown match strategy"); result.match = data.match; }
  if (Object.hasOwn(data, "sort")) { if (!["relevance", "title", "reference"].includes(String(data.sort))) throw new Error("Unknown result order"); result.sort = data.sort as SearchSort; }
  if (result.extension && result.source && result.source !== "file") throw new Error("A file extension requires file sources");
  if (result.mode === "metadata" && result.source && result.source !== "file") throw new Error("Live metadata supports file sources only");
  return result;
}
export function searchOptions(params: URLSearchParams): Pick<SearchInput, "q" | "scope" | "source" | "match" | "extension"> {
  const input = searchInput({ mode: params.get("mode") ?? "text", q: params.get("q") ?? "", scope: params.get("scope") ?? "", source: params.get("source") ?? "", match: params.get("match") ?? "ranked", extension: params.get("extension") ?? "" });
  return { q: input.q.trim(), scope: input.scope, source: input.source, match: input.match, extension: input.extension };
}
export function hasSearchExtension(path: string, extension: string): boolean { return !extension || path.toLowerCase().endsWith(extension); }
export function orderSearchHits<T extends { source: string; ref: string; title: string; rank: number }>(hits: readonly T[], sort: SearchSort): T[] {
  const key = (s: string) => s.normalize("NFKC").toLowerCase();
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...hits].sort((a, b) => {
    if (sort === "relevance") { const delta = Number(b.rank) - Number(a.rank); if (Number.isFinite(delta) && delta) return delta; }
    const primary = sort === "reference" ? compare(key(a.ref), key(b.ref)) : compare(key(a.title), key(b.title));
    return primary || compare(a.source, b.source) || compare(a.ref, b.ref);
  });
}

export function diagnosticFilePath(path: string): string {
  if (!path || path.length > 4096 || !path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(path) || path.includes("//") || (path !== "/" && path.endsWith("/")) || path.split("/").some(p => p === "." || p === "..")) throw new Error("Use a canonical absolute file path (up to 4096 characters)");
  return path;
}
