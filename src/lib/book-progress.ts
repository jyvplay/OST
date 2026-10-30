/** EB-01: reading progress for Books. Chapter progress is spine position;
 *  book progress weights the current chapter fraction so the number moves
 *  smoothly instead of jumping per chapter. Inputs are clamped — a stale
 *  remembered position past the spine end reports 100%, never 140%. */
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
export function bookProgress(spineIndex: number, spineTotal: number, chapterFraction = 0): number {
  if (spineTotal <= 0) return 0;
  const idx = Math.min(Math.max(0, spineIndex), spineTotal - 1);
  return Math.round(clamp01((idx + clamp01(chapterFraction)) / spineTotal) * 100);
}
export const chapterLabel = (spineIndex: number, spineTotal: number): string =>
  spineTotal <= 0 ? "" : `Chapter ${Math.min(spineIndex + 1, spineTotal)} of ${spineTotal}`;
