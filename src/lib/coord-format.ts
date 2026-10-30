/** MP-09: coordinate formatting. Decimal stays the interchange form; DMS
 *  is display-only and always carries hemisphere letters so a copied
 *  coordinate is unambiguous without a sign convention. */
export function formatDecimal(lat: number, lng: number): string {
  const f = (n: number) => (Math.round(n * 1e6) / 1e6).toFixed(6);
  return `${f(lat)}, ${f(lng)}`;
}
function dms(v: number, pos: string, neg: string): string {
  const hemi = v < 0 ? neg : pos;
  const a = Math.abs(v);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60);
  return `${d}°${m}′${s}″${hemi}`;
}
export const formatDMS = (lat: number, lng: number): string => `${dms(lat, "N", "S")} ${dms(lng, "E", "W")}`;
