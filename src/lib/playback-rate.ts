/** MD-10: playback-rate ladder for the Media player. Rates are the values
 *  HTMLMediaElement accepts portably; snapping keeps a stored preference
 *  from ever setting an unsupported rate. */
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export function snapRate(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 1;
  let best: number = PLAYBACK_RATES[0];
  for (const c of PLAYBACK_RATES) if (Math.abs(c - r) < Math.abs(best - r)) best = c;
  return best;
}
export const rateLabel = (r: number): string => `${snapRate(r)}×`;
