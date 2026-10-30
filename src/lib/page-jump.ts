/** PD-02: jump-to-page clamping for the PDF viewer. 1-based input,
 *  0-based page index; out-of-range lands on the nearest real page;
 *  non-numeric input is refused (null) rather than guessed. */
export function clampPage(input: string, total: number): number | null {
  const n = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(n) || total <= 0) return null;
  return Math.min(total - 1, Math.max(0, n - 1));
}
