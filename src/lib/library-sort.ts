/** MU-04: stream-library ordering. "added" is the stored order (newest
 *  first, as saved); title/provider are stable sorts so equal keys keep
 *  the stored order instead of shuffling on every render. */
export interface LibraryItemLike { title: string; provider: string }
export type LibrarySort = "added" | "title" | "provider";
export function sortLibrary<T extends LibraryItemLike>(items: T[], sort: LibrarySort): T[] {
  if (sort === "added") return items;
  return items.map((it, i) => ({ it, i })).sort((a, b) =>
    (a.it[sort].localeCompare(b.it[sort], undefined, { sensitivity: "base" }) || a.i - b.i)).map((x) => x.it);
}
