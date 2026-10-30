/** TT125 LN-19: the zoom levels a camera actually offers, from its
 *  capabilities. No capability → no choices, stated by the caller. */
export interface ZoomCap { min?: number; max?: number; step?: number; }
export function zoomOptions(cap: ZoomCap | null | undefined): number[] {
  if (!cap || cap.min == null || cap.max == null || cap.max <= cap.min) return [];
  const step = cap.step && cap.step > 0 ? cap.step : 1;
  const out: number[] = [];
  for (let z = cap.min; z <= cap.max + 1e-9; z += step) out.push(Number(z.toFixed(2)));
  if (!out.includes(cap.max)) out.push(Number(cap.max.toFixed(2)));
  return out.length > 12 ? out.filter((_, i) => i % Math.ceil(out.length / 12) === 0 || i === out.length - 1) : out;
}
export function torchSupported(cap: { torch?: boolean } | null | undefined): boolean {
  return !!cap?.torch;
}
