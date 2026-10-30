/** WB-07/VT-01: PNG raster sizing for SVG-based exports. The raster is
 *  rendered at a chosen scale with a hard pixel cap, so a huge canvas
 *  cannot allocate an unbounded bitmap; hitting the cap scales DOWN and
 *  the UI states the effective size. */
export interface RasterSize { w: number; h: number; scale: number; capped: boolean }
export const MAX_RASTER_PIXELS = 16_000_000;
export function rasterSize(naturalW: number, naturalH: number, wantScale = 2): RasterSize {
  const w0 = Math.max(1, Math.round(naturalW)), h0 = Math.max(1, Math.round(naturalH));
  let scale = Math.max(0.25, wantScale);
  let w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const px = w * h;
  if (px > MAX_RASTER_PIXELS) {
    scale = scale * Math.sqrt(MAX_RASTER_PIXELS / px);
    w = Math.max(1, Math.round(w0 * scale)); h = Math.max(1, Math.round(h0 * scale));
    return { w, h, scale, capped: true };
  }
  return { w, h, scale, capped: false };
}
