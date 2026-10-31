/** PH-05: photo ordering beyond capture date. Sorts a copy, keeps ties stable,
 * and always places missing/invalid sizes or capture dates last. */
export interface PhotoLike { path: string; size?: number; capturedAt?: string | null }
export type PhotoSort = "captured" | "name" | "size";
export function sortPhotos<T extends PhotoLike>(items: T[], sort: PhotoSort, desc = false): T[] {
  const key = (p: T): string | number | null => {
    if (sort === "name") return (p.path.split("/").pop() ?? p.path).toLowerCase();
    if (sort === "size") return typeof p.size === "number" && Number.isFinite(p.size) && p.size >= 0 ? p.size : null;
    const time = p.capturedAt ? Date.parse(p.capturedAt) : NaN;
    return Number.isFinite(time) ? time : null;
  };
  return [...items].sort((a, b) => {
    const x = key(a), y = key(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    const comparison = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return desc ? -comparison : comparison;
  });
}

/** Descending instant comparison used for the library's EXIF/file-date view. */
export function compareNewestPhotoDate(a: string, b: string): number {
  const x = Date.parse(a), y = Date.parse(b), xValid = Number.isFinite(x), yValid = Number.isFinite(y);
  if (!xValid) return yValid ? 1 : 0;
  if (!yValid) return -1;
  return y - x;
}
