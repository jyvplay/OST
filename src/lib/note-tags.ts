/** NT-07: note tag facets. Tags are the stored comma list, split and
 *  trimmed exactly as the editor writes them; a note with no tags is
 *  only visible under "all" (or the explicit untagged facet). */
export interface TaggedNote { tags: string }
export const tagsOf = (n: TaggedNote): string[] => (n.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
export function allTags<T extends TaggedNote>(notes: T[]): string[] {
  return [...new Set(notes.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
export function filterByTag<T extends TaggedNote>(notes: T[], tag: string): T[] {
  if (tag === "all") return notes;
  if (tag === "untagged") return notes.filter((n) => tagsOf(n).length === 0);
  return notes.filter((n) => tagsOf(n).includes(tag));
}
