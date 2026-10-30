/**
 * PH-03 — Photos slideshow mechanics. Pure index arithmetic: advance wraps
 * at the end (a slideshow that stops at the last photo is a viewer, not a
 * show), the interval is clamped to [1s, 60s] so a typo can't spin the CPU
 * or stall for an hour, and an empty library has no next frame.
 */
export const SLIDESHOW_MIN_S = 1;
export const SLIDESHOW_MAX_S = 60;

export function clampInterval(s: number): number {
  if (!Number.isFinite(s)) return 4;
  return Math.min(SLIDESHOW_MAX_S, Math.max(SLIDESHOW_MIN_S, Math.round(s)));
}

export function nextIndex(current: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return 0;
  return (current + 1) % count;
}

export function prevIndex(current: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return count - 1;
  return (current - 1 + count) % count;
}
