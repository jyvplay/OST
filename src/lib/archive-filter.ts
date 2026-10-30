/** AR-01: archive entry filtering. Matches the entry name and its folder
 *  prefix, so "docs/" lists a folder's contents; directories stay visible
 *  as context when a child matches. */
export interface EntryLike { name: string; dir?: boolean }
export function filterEntries<T extends EntryLike>(entries: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  const hit = entries.filter((e) => e.name.toLowerCase().includes(needle));
  const dirs = new Set(hit.map((e) => { const i = e.name.lastIndexOf("/"); return i > 0 ? e.name.slice(0, i + 1) : ""; }).filter(Boolean));
  return entries.filter((e) => hit.includes(e) || (e.dir && dirs.has(e.name)) || dirs.has(e.name));
}
