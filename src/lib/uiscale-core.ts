/** Text-scale constants and pure maths — no React, safe on the server (settings validation). */
// TT22: the default is 125 % (body text ≈ 16 px, the common readability baseline). The TT21 200 % size is now
// "Large text mode" — an opt-in, not the default (user decision, TT22).
export const DEFAULT_TEXT_SCALE = 125; // percent of the TT20 sizes
export const LARGE_TEXT_SCALE = 200;
export const isLargeText = (percent: number) => percent >= LARGE_TEXT_SCALE;
export const TEXT_SCALE_MIN = 100;
export const TEXT_SCALE_MAX = 300;
export const TEXT_SCALE_STEPS = [100, 125, 150, 175, 200, 250, 300] as const;

export function clampTextScale(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_TEXT_SCALE;
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, n));
}

/** Next/previous preset step from any current value (A−/A+ buttons). */
export function stepTextScale(current: unknown, dir: 1 | -1): number {
  const c = clampTextScale(current);
  const steps = TEXT_SCALE_STEPS as readonly number[];
  if (dir > 0) return steps.find((s) => s > c) ?? TEXT_SCALE_MAX;
  return [...steps].reverse().find((s) => s < c) ?? TEXT_SCALE_MIN;
}
