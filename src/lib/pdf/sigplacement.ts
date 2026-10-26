/** Display-space signature placement. Original geometry; no PDF reader dependency.
 * Units: PDF default-user-space units (normally points, 1/72 inch); origin is the
 * TOP LEFT of the rotated CropBox. Invalid boxes are refused, never silently moved.
 */
export interface SignatureBox { left: number; top: number; width: number; height: number }
export interface SignaturePage { crop: number[]; rotate: number }
export function signaturePageSize(page: SignaturePage): { width: number; height: number } {
  if (page.crop.length !== 4 || !page.crop.every(Number.isFinite)) throw new Error("Invalid page crop box");
  const [x0, y0, x1, y1] = page.crop;
  if (x1 <= x0 || y1 <= y0 || !Number.isFinite(page.rotate) || page.rotate % 90 !== 0) throw new Error("Invalid page geometry");
  const sideways = ((page.rotate % 180) + 180) % 180 === 90;
  return { width: sideways ? y1 - y0 : x1 - x0, height: sideways ? x1 - x0 : y1 - y0 };
}
export function signatureRectAt(page: SignaturePage, box: SignatureBox): number[] {
  const { width: dw, height: dh } = signaturePageSize(page);
  const { left, top, width, height } = box;
  if (![left, top, width, height].every(Number.isFinite) || left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > dw || top + height > dh) {
    throw new Error(`Signature box must fit inside the displayed page (${dw} × ${dh} units)`);
  }
  const [x0, y0, x1, y1] = page.crop, rot = ((page.rotate % 360) + 360) % 360;
  const map = (u: number, v: number): [number, number] => rot === 90 ? [x1 - v, y0 + u] : rot === 180 ? [x1 - u, y1 - v] : rot === 270 ? [x0 + v, y1 - u] : [x0 + u, y0 + v];
  const [ax, ay] = map(left, dh - top - height), [bx, by] = map(left + width, dh - top);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}
