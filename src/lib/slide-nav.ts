/** SL-01: go-to-slide clamping. User input is 1-based; the deck is
 *  0-based; out-of-range input lands on the nearest real slide instead
 *  of an empty stage, and non-numeric input is refused (null). */
export function clampSlide(input: string, total: number): number | null {
  const n = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(n) || total <= 0) return null;
  return Math.min(total - 1, Math.max(0, n - 1));
}
export const slideLabel = (cur: number, total: number): string => (total <= 0 ? "" : `Slide ${cur + 1} of ${total}`);
