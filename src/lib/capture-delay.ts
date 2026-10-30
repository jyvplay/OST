/** CP-01: capture countdown choices. Zero means immediate; the countdown
 *  is a plain delay before the existing capture path runs, so a delayed
 *  capture can never take a different (less safe) route to the VFS. */
export const CAPTURE_DELAYS = [0, 3, 5, 10] as const;
export const delayLabel = (s: number): string => (s <= 0 ? "now" : `${s}s`);
export const snapDelay = (s: number): number => (CAPTURE_DELAYS as readonly number[]).includes(s) ? s : 0;
