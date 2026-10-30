/** TT125 LN-19: the zoom levels a camera actually offers, from its
 *  capabilities. No capability → no choices, stated by the caller. */
export interface ZoomCap { min?: number; max?: number; step?: number; }
export function zoomOptions(cap: ZoomCap | null | undefined): number[] {
  const min = cap?.min, max = cap?.max;
  if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  // When a step is reported, offer only points on its grid. Sample indices
  // rather than materializing potentially millions of device capabilities.
  const step = cap?.step;
  if (step != null && (!Number.isFinite(step) || step <= 0)) return [];
  if (step == null) return [min, max];
  const count = Math.floor((max - min) / step + 1e-9);
  if (!Number.isSafeInteger(count) || count < 1) return [];
  const sampleCount = Math.min(12, count + 1);
  const result: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const index = Math.round(i * count / (sampleCount - 1));
    const value = Number((min + index * step).toPrecision(15));
    if (value <= max + Math.abs(step) * 1e-9 && value >= min && !result.includes(value)) result.push(value);
  }
  return result;
}
export function torchSupported(cap: { torch?: boolean } | null | undefined): boolean {
  return !!cap?.torch;
}
