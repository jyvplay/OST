/** PH-08: a photo's known facts as labelled lines. Anything the index
 *  does not hold is written as "not in index" — the copy never invents
 *  a date, camera or place, and says which storage the sidecar uses. */
export interface PhotoInfoInput { path: string; size: number; mime: string; index?: { date?: string | null; camera?: string; lat?: number; lon?: number } }
export function photoInfoText(p: PhotoInfoInput): string {
  const ix = p.index;
  return [
    `Path: ${p.path}`,
    `Size: ${p.size} bytes · ${p.mime}`,
    `Date: ${ix?.date || "not in index"}`,
    `Camera: ${ix?.camera || "not in index"}`,
    `Place: ${ix?.lat !== undefined && ix?.lon !== undefined ? `${ix.lat.toFixed(4)}, ${ix.lon.toFixed(4)}` : "not in index"}`,
  ].join("\n");
}
