/** CN-09: contacts by family name. Uses the structured N field when
 *  present and falls back to the last word of the display name, so
 *  imported cards without N still sort sensibly. */
export interface NameSortable { fn: string; n?: { family?: string; given?: string } }
export function familyKey(c: NameSortable): string {
  const fam = (c.n?.family ?? "").trim();
  if (fam) return fam.toLowerCase();
  const parts = c.fn.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? c.fn).toLowerCase();
}
export function sortByFamily<T extends NameSortable>(contacts: T[]): T[] {
  return [...contacts].sort((a, b) => familyKey(a).localeCompare(familyKey(b), undefined, { sensitivity: "base" }) || a.fn.localeCompare(b.fn, undefined, { sensitivity: "base" }));
}
