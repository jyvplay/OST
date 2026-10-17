/**
 * TT27 colour-scheme beauty checks — pure (unit-tested in scripts/tabletop-unit.mts, run on live screenshots by
 * scripts/e2e-beauty.mts). Original code; the colour space is Björn Ottosson's OKLab (public-domain formulas).
 *
 * What is HARD (pass/fail) and why:
 *   - WCAG 2.2 contrast — text 4.5:1 (1.4.3), non-text UI 3:1 (1.4.11). Still normative in Oct 2026: the WCAG 3 draft
 *     (Sep 2026) says its contrast method is "to be determined", and APCA was withdrawn from the draft in 2023.
 *   - Style intent the user asked for: Silver must be *mostly silver* and Daylight *mostly light* — measured as the
 *     share of screenshot pixels that are light (OKLCH L ≥ 0.80) and near-neutral (C ≤ 0.045). Threshold 55 % is ours.
 * What is SOFT (reported, never fails — the evidence is mixed):
 *   - harmony-template fit (Cohen-Or et al. 2006 hue templates). Large studies find people do NOT reliably prefer
 *     "harmonised" colours (Tan, Echevarria & Gingold, TVCG 2025), so this is descriptive only.
 *   - hue complexity: chroma-weighted hue entropy (O'Donovan, Agarwala & Hertzmann 2011 found simpler hue
 *     distributions rated higher on Kuler/COLOURlovers; Schloss & Palmer: preference rises with hue similarity).
 *   - 60-30-10 area split of the three dominant colour clusters (a practitioner rule, not research).
 */

export type RGB = [number, number, number]; // 0..1 sRGB
export interface OKLCH { L: number; C: number; h: number } // h in degrees (NaN-safe: 0 when C≈0)

export function hex(h: string): RGB {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255) as RGB;
}
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const luminance = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a: RGB, b: RGB): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

export function oklab(c: RGB): [number, number, number] {
  const r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklch(c: RGB): OKLCH {
  const [L, a, b] = oklab(c);
  const C = Math.hypot(a, b);
  return { L, C, h: C < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
const angDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/* ------------------------------------------------------------ harmony templates (Cohen-Or et al. 2006) */
/** Sectors as [centre offset°, width°]; a template is rotated to best fit. */
export const TEMPLATES: Record<string, [number, number][]> = {
  i: [[0, 18]], V: [[0, 93.6]], L: [[0, 18], [90, 79.2]], I: [[0, 18], [180, 18]],
  T: [[0, 180]], Y: [[0, 93.6], [180, 18]], X: [[0, 93.6], [180, 93.6]],
};
/** Distance of a hue to the nearest sector edge (0 inside). */
function sectorGap(h: number, rot: number, secs: [number, number][]): number {
  let best = 360;
  for (const [c, w] of secs) best = Math.min(best, Math.max(0, angDist(h, (rot + c) % 360) - w / 2));
  return best;
}
/**
 * Best template + rotation for chroma-weighted hues: score = Σ w·gap / Σ w (degrees; 0 = every hue inside the
 * template). Neutrals (C < 0.03) carry no hue and are ignored. Returns null when there is no chromatic colour.
 */
export function harmonyFit(colors: readonly { c: RGB; w?: number }[]): { template: string; rotation: number; deviation: number } | null {
  const hs = colors.map(({ c, w = 1 }) => { const o = oklch(c); return { h: o.h, w: w * o.C }; }).filter((x) => x.w > 0.03 * 0.5);
  if (!hs.length) return null;
  const tot = hs.reduce((s, x) => s + x.w, 0);
  const width = (secs: [number, number][]) => secs.reduce((a, [, w]) => a + w, 0);
  const fits = Object.entries(TEMPLATES).map(([template, secs]) => {
    let rotation = 0, deviation = Infinity;
    for (let rot = 0; rot < 360; rot += 2) {
      const d = hs.reduce((a, x) => a + x.w * sectorGap(x.h, rot, secs), 0) / tot;
      if (d < deviation) { deviation = d; rotation = rot; }
    }
    return { template, rotation, deviation, width: width(secs) };
  });
  const min = Math.min(...fits.map((f) => f.deviation));
  // the narrowest template that fits (within 1°) describes the scheme best — T (half the wheel) fits almost anything
  const best = fits.filter((f) => f.deviation <= min + 1).sort((a, b) => a.width - b.width)[0];
  return { template: best.template, rotation: best.rotation, deviation: +best.deviation.toFixed(2) };
}

/** Chroma-weighted hue entropy over 12 × 30° bins, normalised to 0..1 (0 = one hue family, 1 = all hues equally). */
export function hueEntropy(colors: readonly { c: RGB; w?: number }[]): number {
  const bins = new Array(12).fill(0);
  for (const { c, w = 1 } of colors) { const o = oklch(c); if (o.C < 0.03) continue; bins[Math.floor(o.h / 30) % 12] += w * o.C; }
  const tot = bins.reduce((s, x) => s + x, 0);
  if (!tot) return 0;
  const H = -bins.reduce((s, x) => (x > 0 ? s + (x / tot) * Math.log(x / tot) : s), 0);
  return +(H / Math.log(12)).toFixed(3);
}

/* ------------------------------------------------------------ screenshot statistics */
export interface PixelStats {
  /** share of light, near-neutral pixels (L ≥ 0.80, C ≤ 0.045) — "silver / light UI" */
  lightNeutral: number;
  /** share of pixels with L ≥ 0.80 regardless of chroma */
  light: number;
  /** mean OKLCH lightness */
  meanL: number;
  /** the three biggest colour clusters (OKLab quantised) as shares, biggest first, + their mean colour */
  top: { share: number; rgb: RGB }[];
  /** distance of the top-3 shares (normalised to sum 1) from 60/30/10, in percentage points (L1 / 2) */
  sixtyThirtyTen: number;
  /** chroma-weighted hue entropy of all pixels */
  entropy: number;
}
/** `data` is RGBA bytes (canvas ImageData order). Every `step`-th pixel is sampled. */
export function pixelStats(data: ArrayLike<number>, step = 1): PixelStats {
  const clusters = new Map<string, { n: number; r: number; g: number; b: number }>();
  const hueBins = new Array(12).fill(0);
  let n = 0, ln = 0, light = 0, sumL = 0;
  for (let i = 0; i + 3 < data.length; i += 4 * step) {
    if (data[i + 3] < 128) continue;
    const c: RGB = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
    const [L, a, b] = oklab(c);
    const C = Math.hypot(a, b);
    n++; sumL += L;
    if (L >= 0.8) { light++; if (C <= 0.045) ln++; }
    if (C >= 0.03) hueBins[Math.floor((((Math.atan2(b, a) * 180) / Math.PI + 360) % 360) / 30) % 12] += C;
    const key = `${Math.round(L * 10)}|${Math.round(a * 20)}|${Math.round(b * 20)}`;
    const k = clusters.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    k.n++; k.r += c[0]; k.g += c[1]; k.b += c[2];
    clusters.set(key, k);
  }
  if (!n) return { lightNeutral: 0, light: 0, meanL: 0, top: [], sixtyThirtyTen: 100, entropy: 0 };
  const top = [...clusters.values()].sort((x, y) => y.n - x.n).slice(0, 3).map((k) => ({ share: +(k.n / n).toFixed(3), rgb: [k.r / k.n, k.g / k.n, k.b / k.n] as RGB }));
  const s = top.reduce((a, t) => a + t.share, 0) || 1;
  const want = [0.6, 0.3, 0.1];
  const d = top.reduce((a, t, i) => a + Math.abs(t.share / s - want[i]), 0) / 2 * 100;
  const tot = hueBins.reduce((a, x) => a + x, 0);
  const ent = tot ? -hueBins.reduce((a, x) => (x > 0 ? a + (x / tot) * Math.log(x / tot) : a), 0) / Math.log(12) : 0;
  return { lightNeutral: +(ln / n).toFixed(3), light: +(light / n).toFixed(3), meanL: +(sumL / n).toFixed(3), top, sixtyThirtyTen: +d.toFixed(1), entropy: +ent.toFixed(3) };
}

/** The style-intent rule: which styles promise a mostly light / silver look in their light theme. */
export const LIGHT_INTENT: Record<string, number> = { silver: 0.55, daylight: 0.55 };
