/**
 * SpreadsheetML colour resolution (TT47): rgb / theme+tint / indexed / auto → "#rrggbb".
 *
 * ECMA-376 Part 1 §18.8.3 (color), §18.8.27 (indexedColors default palette), §20.1.6.2 (clrScheme).
 * Theme index order used by SpreadsheetML colour references swaps the first two pairs relative to
 * the clrScheme element order: 0=lt1, 1=dk1, 2=lt2, 3=dk2, 4..9=accent1..6, 10=hlink, 11=folHlink.
 * Tint (§18.8.19 / MS-OI29500 2.1.1648): convert to HLS, then
 *   tint < 0 : L' = L·(1+tint)          tint > 0 : L' = L·(1−tint) + tint      (L in 0..1)
 * Client-safe: no node imports.
 */

/** Default legacy palette, indices 0..63 (+64 system foreground, +65 system background). */
export const INDEXED_PALETTE: readonly string[] = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
  "000000", "FFFFFF",
];

export interface ColorContext { theme: string[]; indexed: readonly string[] }
export const EMPTY_COLOR_CONTEXT: ColorContext = { theme: [], indexed: INDEXED_PALETTE };

/** TT72: XML 1.0 §3.1 — single or double quotes, optional spaces around "=" (TT71 read name="value" only) */
const attr = (s: string, name: string) => { const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(s); return m ? m[1] ?? m[2] : undefined; };

/** theme1.xml → 12 colours in SpreadsheetML index order (hex without '#', upper-case). */
export function readThemeColors(xml: string | null | undefined): string[] {
  if (!xml) return [];
  const scheme = /<(?:\w+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:\w+:)?clrScheme>/.exec(xml)?.[1];
  if (!scheme) return [];
  const slot = (name: string): string => {
    const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(scheme)?.[1] ?? "";
    const srgb = /<(?:\w+:)?srgbClr\b[^>]*\bval\s*=\s*["']([0-9A-Fa-f]{6})["']/.exec(m)?.[1];
    if (srgb) return srgb.toUpperCase();
    const sys = /<(?:\w+:)?sysClr\b([^>]*)/.exec(m)?.[1];
    if (sys) { const last = attr(sys, "lastClr"); if (last && /^[0-9A-Fa-f]{6}$/.test(last)) return last.toUpperCase(); const v = attr(sys, "val"); return v === "window" ? "FFFFFF" : "000000"; }
    return "";
  };
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  return order.map(slot);
}

/** styles.xml <colors><indexedColors> overrides the default palette when present. */
export function readIndexedColors(stylesXml: string | null | undefined): readonly string[] {
  const body = stylesXml ? /<indexedColors\b[^>]*>([\s\S]*?)<\/indexedColors>/.exec(stylesXml)?.[1] : undefined;
  if (!body) return INDEXED_PALETTE;
  const list = [...body.matchAll(/<rgbColor\b[^>]*\brgb\s*=\s*["']([0-9A-Fa-f]{8})["']/g)].map((m) => m[1].slice(2).toUpperCase());
  return list.length ? [...list, ...INDEXED_PALETTE.slice(list.length)] : INDEXED_PALETTE;
}

function rgbToHls(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, l, 0];
  const d = mx - mn, s = l <= 0.5 ? d / (mx + mn) : d / (2 - mx - mn);
  const rc = (mx - r) / d, gc = (mx - g) / d, bc = (mx - b) / d;
  let h = r === mx ? bc - gc : g === mx ? 2 + rc - bc : 4 + gc - rc;
  h = (h / 6) % 1; if (h < 0) h += 1;
  return [h, l, s];
}
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
  const v = (hue: number) => { hue = ((hue % 1) + 1) % 1; return hue < 1 / 6 ? m1 + (m2 - m1) * hue * 6 : hue < 0.5 ? m2 : hue < 2 / 3 ? m1 + (m2 - m1) * (2 / 3 - hue) * 6 : m1; };
  return [v(h + 1 / 3), v(h), v(h - 1 / 3)];
}
/** Apply an ECMA tint (−1..1) to "RRGGBB". */
export function applyTint(hex: string, tint: number): string {
  if (!tint || !Number.isFinite(tint)) return hex.toUpperCase();
  const t = Math.max(-1, Math.min(1, tint));
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [h, l, s] = rgbToHls(r, g, b);
  const l2 = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  return hlsToRgb(h, Math.max(0, Math.min(1, l2)), s).map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Attribute text of a <color>/<fgColor>/<bgColor> element → "#rrggbb", or undefined for "auto"/unknown
 * (the caller then keeps the application default).
 */
export function resolveColorAttrs(attrs: string, ctx: ColorContext): string | undefined {
  if (attr(attrs, "auto") === "1" || attr(attrs, "auto") === "true") return undefined;
  let hex: string | undefined;
  const rgb = attr(attrs, "rgb");
  if (rgb && /^[0-9A-Fa-f]{8}$/.test(rgb)) hex = rgb.slice(2);
  else if (rgb && /^[0-9A-Fa-f]{6}$/.test(rgb)) hex = rgb;
  else if (attr(attrs, "theme") !== undefined) { const i = Number(attr(attrs, "theme")); hex = ctx.theme[i] || undefined; }
  else if (attr(attrs, "indexed") !== undefined) { const i = Number(attr(attrs, "indexed")); hex = ctx.indexed[i]; }
  if (!hex) return undefined;
  const tint = Number(attr(attrs, "tint") ?? 0);
  return `#${applyTint(hex, tint).toLowerCase()}`;
}
/** First <tag …> in `inner` resolved through `ctx`. */
export function resolveTag(inner: string, tag: string, ctx: ColorContext): string | undefined {
  const m = new RegExp(`<${tag}\\b([^>]*?)/?>`).exec(inner);
  return m ? resolveColorAttrs(m[1], ctx) : undefined;
}
