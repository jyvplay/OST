/**
 * TT123 PH-07: the "no date" view is the photos whose index entry carries no
 * capture date — files never indexed, formats without readable EXIF, and scans
 * whose date pass found nothing. The view never guesses a date for them.
 * The index records the date under `date` (and older builds `capturedAt`);
 * either counts only when it is a non-empty string.
 * Original code.
 */
export interface PhotoEntry { path: string; sha256: string }
export interface PhotoIndexEntry { capturedAt?: string | null; date?: string | null; dateSource?: "exif" | "file" }

export function undatedPhotos<T extends PhotoEntry>(items: readonly T[], index: Record<string, PhotoIndexEntry | undefined>): T[] {
  return items.filter((item) => {
    if (!item.sha256) return true;
    const entry = index[item.sha256];
    if (!entry) return true;
    // The cache's file-date fallback is not a capture date, including entries
    // written by older releases that persisted that fallback in `date`.
    if (entry.dateSource === "file") return true;
    const when = entry.date ?? entry.capturedAt;
    return !(typeof when === "string" && when.length > 0);
  });
}
