/** PH-05: photo ordering beyond capture date. Sorts a copy; the library
 *  array order (capture date from the index) is never mutated, so other
 *  views keep their canonical order. Missing sizes/dates sort last. */
export interface PhotoLike { path: string; size?: number; capturedAt?: string | null }
export type PhotoSort = "captured" | "name" | "size";
export function sortPhotos<T extends PhotoLike>(items: T[], sort: PhotoSort, desc = false): T[] {
  const name = (p: T) => p.path.split("/").pop() ?? p.path;
  const key = (p: T): string | number => sort === "name" ? name(p).toLowerCase() : sort === "size" ? (p.size ?? -1) : (p.capturedAt ?? "");
  const out = [...items].sort((a, b) => { const ka = key(a), kb = key(b); return typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb)); });
  return desc ? out.reverse() : out;
}
