/** PH-06: slideshow shuffle. A seeded Fisher-Yates over indices (RNG
 *  injected, as in SC-19) so the order is uniform, testable, and never
 *  mutates the library order other views rely on. */
export function shuffleOrder(n: number, rng: () => number): number[] {
  const out = Array.from({ length: Math.max(0, n) }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
export const isShuffledOrder = (order: number[]): boolean => order.some((v, i) => v !== i);
