/** PD-01 (PDF) and WB-06 (Whiteboard) share one zoom ladder so zoom feels
 *  identical across apps. Stepping snaps to the ladder; free zoom (pinch,
 *  wheel) is clamped to the same ends. */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM: number = ZOOM_STEPS[0];
export const MAX_ZOOM: number = ZOOM_STEPS[ZOOM_STEPS.length - 1];
export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) : 1);
export function stepZoom(current: number, dir: 1 | -1): number {
  const c = clampZoom(current);
  if (dir > 0) { for (const s of ZOOM_STEPS) if (s > c + 1e-9) return s; return MAX_ZOOM; }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < c - 1e-9) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}
export const zoomLabel = (z: number): string => `${Math.round(clampZoom(z) * 100)}%`;
