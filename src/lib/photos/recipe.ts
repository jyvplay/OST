/**
 * TT54 (MD-03) — Photos' non-destructive edit recipe. The original file is never modified: the recipe is a small JSON
 * sidecar stored beside the photo (".<name>.edit.json"), applied on the fly to thumbnails, the viewer and exports.
 *
 * Resolution independence is the design rule: crop is in fractions of the frame, straighten in degrees, tone values
 * are dimensionless, vignette uses the normalised radius — so the same recipe renders the same picture on a 256 px
 * thumbnail and on the 48 MP original (up to resampling).
 *
 * Pipeline (fixed order, like photo editors): quarter turns -> flips -> straighten (rotate + crop to fill, bilinear) ->
 * crop -> exposure + white balance in LINEAR light -> shadows / highlights -> contrast -> saturation / vibrance
 * (encoded sRGB) -> vignette. All curves are monotonic for every slider value (asserted by tests).
 */
import type { Raster } from "../image/raster";

export interface PhotoRecipe {
  v: 1;
  /** clockwise quarter turns */
  rotate?: 0 | 1 | 2 | 3;
  flipH?: boolean; flipV?: boolean;
  /** degrees, -45..45; the frame is cropped to the largest same-aspect rectangle inside the rotated picture */
  straighten?: number;
  /** fractions of the (rotated, straightened) frame */
  crop?: { x: number; y: number; w: number; h: number };
  /** EV stops, -3..3 */
  exposure?: number;
  /** -1..1 each */
  contrast?: number; highlights?: number; shadows?: number; saturation?: number; vibrance?: number; warmth?: number; tint?: number;
  /** 0..1 */
  vignette?: number;
  preset?: PresetName | null;
  /** star rating 0..5 and favourite flag live in the same sidecar (Photos library metadata) */
  rating?: number; favorite?: boolean;
}
export type PresetName = "vivid" | "warm" | "cool" | "mono" | "noir" | "fade";
export const PRESETS: Record<PresetName, Partial<PhotoRecipe>> = {
  vivid: { saturation: 0.35, contrast: 0.2, vibrance: 0.2 },
  warm: { warmth: 0.4, saturation: 0.1 },
  cool: { warmth: -0.4 },
  mono: { saturation: -1 },
  noir: { saturation: -1, contrast: 0.6, vignette: 0.45, shadows: -0.2 },
  fade: { contrast: -0.4, shadows: 0.3, saturation: -0.2 },
};
const TONE_KEYS = ["exposure", "contrast", "highlights", "shadows", "saturation", "vibrance", "warmth", "tint", "vignette"] as const;

export const sidecarPath = (path: string) => { const i = path.lastIndexOf("/"); return `${path.slice(0, i + 1)}.${path.slice(i + 1)}.edit.json`; };
/** accepts a bare name or a full path */
export const isSidecar = (nameOrPath: string) => /^\..+\.edit\.json$/.test(nameOrPath.slice(nameOrPath.lastIndexOf("/") + 1));
export const photoOfSidecar = (path: string) => { const i = path.lastIndexOf("/"); const n = path.slice(i + 1); return isSidecar(n) ? path.slice(0, i + 1) + n.slice(1, -".edit.json".length) : null; };

const clampN = (x: unknown, lo: number, hi: number, d = 0) => typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;

/** Validate untrusted JSON (a sidecar is a file anyone can edit) into a well-formed recipe. */
export function parseRecipe(json: unknown): PhotoRecipe {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const r: PhotoRecipe = { v: 1 };
  if (o.rotate === 1 || o.rotate === 2 || o.rotate === 3) r.rotate = o.rotate; // anything else (7, 2.5, "1") is not a quarter turn: dropped, not clamped
  if (o.flipH === true) r.flipH = true; if (o.flipV === true) r.flipV = true;
  const st = clampN(o.straighten, -45, 45); if (st) r.straighten = st;
  const c = o.crop as Record<string, unknown> | undefined;
  if (c && typeof c === "object") {
    // x / y ≤ 0.99 leaves ≥ 1 % so the crop never collapses to zero
    const x = clampN(c.x, 0, 0.99), y = clampN(c.y, 0, 0.99); const w = clampN(c.w, 0.01, 1 - x, 1 - x), h = clampN(c.h, 0.01, 1 - y, 1 - y);
    if (!(x === 0 && y === 0 && w >= 0.9999 && h >= 0.9999)) r.crop = { x, y, w, h };
  }
  const ex = clampN(o.exposure, -3, 3); if (ex) r.exposure = ex;
  for (const k of ["contrast", "highlights", "shadows", "saturation", "vibrance", "warmth", "tint"] as const) { const v = clampN(o[k], -1, 1); if (v) r[k] = v; }
  const vg = clampN(o.vignette, 0, 1); if (vg) r.vignette = vg;
  if (typeof o.preset === "string" && Object.prototype.hasOwnProperty.call(PRESETS, o.preset)) r.preset = o.preset as PresetName; // own keys only: "toString" / "__proto__" are not presets
  const rt = clampN(o.rating, 0, 5); if (Number.isInteger(rt) && rt) r.rating = rt;
  if (o.favorite === true) r.favorite = true;
  return r;
}

/** true when the recipe changes no pixel (rating / favourite only) */
export function isIdentity(r: PhotoRecipe | null | undefined): boolean {
  if (!r) return true;
  return !r.rotate && !r.flipH && !r.flipV && !r.straighten && !r.crop && !r.preset && TONE_KEYS.every((k) => !r[k]);
}
/** stable key of the pixel-affecting part (thumbnail cache key) */
export function recipeKey(r: PhotoRecipe | null | undefined): string {
  if (!r || isIdentity(r)) return "orig";
  const p: Record<string, unknown> = {}; for (const k of ["rotate", "flipH", "flipV", "straighten", "crop", "preset", ...TONE_KEYS] as const) if (r[k] !== undefined) p[k] = r[k];
  const s = JSON.stringify(p); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** effective tone values: preset base + slider offsets, clamped */
export function effectiveTone(r: PhotoRecipe): Record<(typeof TONE_KEYS)[number], number> {
  const base = r.preset ? PRESETS[r.preset] : {};
  const out = {} as Record<(typeof TONE_KEYS)[number], number>;
  for (const k of TONE_KEYS) {
    const v = ((base as Record<string, number>)[k] ?? 0) + (r[k] ?? 0);
    out[k] = k === "exposure" ? clampN(v, -3, 3) : k === "vignette" ? clampN(v, 0, 1) : clampN(v, -1, 1);
  }
  return out;
}

/* ------------------------------------------------------------------ geometry ------ */

export function rotateQuarter(src: Raster, turns: number): Raster {
  const t = ((turns % 4) + 4) % 4; if (!t) return src;
  const { width: w, height: h, data } = src; const W = t % 2 ? h : w, H = t % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = t === 1 ? h - 1 - y : t === 2 ? w - 1 - x : y, ny = t === 1 ? x : t === 2 ? h - 1 - y : w - 1 - x;
    const si = (y * w + x) * 4, di = (ny * W + nx) * 4;
    out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
  }
  return { width: W, height: H, data: out };
}
export function flipRaster(src: Raster, h: boolean, v: boolean): Raster {
  if (!h && !v) return src;
  const { width: W, height: H, data } = src; const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = h ? W - 1 - x : x, sy = v ? H - 1 - y : y; const si = (sy * W + sx) * 4, di = (y * W + x) * 4;
    out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
  }
  return { width: W, height: H, data: out };
}
/** scale of the largest centred same-aspect rectangle inside a w×h picture rotated by `deg` */
export function straightenScale(w: number, h: number, deg: number): number {
  const a = Math.abs(deg) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return Math.min(w / (w * c + h * s), h / (w * s + h * c));
}
/** straighten (rotate about the centre, crop to fill) and crop, in one bilinear resampling pass */
export function straightenCrop(src: Raster, deg: number, crop?: { x: number; y: number; w: number; h: number }): Raster {
  const { width: w, height: h, data } = src;
  const k = deg ? straightenScale(w, h, deg) : 1;
  const fw = w * k, fh = h * k; // straightened frame, centred on the picture centre
  const cx = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const W = Math.max(1, Math.round(fw * cx.w)), H = Math.max(1, Math.round(fh * cx.h));
  if (!deg && W === w && H === h) return src;
  const out = new Uint8ClampedArray(W * H * 4);
  const a = -deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const ox = -fw / 2 + cx.x * fw, oy = -fh / 2 + cx.y * fh; const sx0 = fw * cx.w / W, sy0 = fh * cx.h / H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // output pixel centre in frame coordinates (origin = picture centre), rotated back into the source
    const fx = ox + (x + 0.5) * sx0, fy = oy + (y + 0.5) * sy0;
    const px = (deg ? fx * ca - fy * sa : fx) + w / 2 - 0.5, py = (deg ? fx * sa + fy * ca : fy) + h / 2 - 0.5;
    const di = (y * W + x) * 4;
    if (!deg && Number.isInteger(px) && Number.isInteger(py)) { const si = (py * w + px) * 4; out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3]; continue; }
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(px))), y0 = Math.max(0, Math.min(h - 1, Math.floor(py)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1); const tx = Math.max(0, Math.min(1, px - x0)), ty = Math.max(0, Math.min(1, py - y0));
    for (let c = 0; c < 4; c++) {
      const p00 = data[(y0 * w + x0) * 4 + c], p10 = data[(y0 * w + x1) * 4 + c], p01 = data[(y1 * w + x0) * 4 + c], p11 = data[(y1 * w + x1) * 4 + c];
      out[di + c] = Math.round((p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty);
    }
  }
  return { width: W, height: H, data: out };
}

/* ------------------------------------------------------------------ tone ------ */

const TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; TO_LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
export const toLinear = (v: number) => TO_LIN[v];
export const toSrgb = (l: number) => { const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055; return c; };

/** the per-value tone curve after exposure / white balance: shadows, highlights, contrast (encoded 0..1 -> 0..1) */
export function toneCurve(v: number, shadows: number, highlights: number, contrast: number): number {
  let x = v + shadows * 0.9 * x3(v);
  x = Math.min(1, Math.max(0, x));
  x = x + highlights * 0.9 * x * x * (1 - x);
  x = Math.min(1, Math.max(0, x));
  if (contrast >= 0) x = x + contrast * (x * x * (3 - 2 * x) - x);
  else x = 0.5 + (x - 0.5) * (1 + contrast * 0.5);
  return Math.min(1, Math.max(0, x));
}
const x3 = (v: number) => v * (1 - v) * (1 - v);

export function applyTone(src: Raster, r: PhotoRecipe): Raster {
  const t = effectiveTone(r);
  if (TONE_KEYS.every((k) => !t[k])) return src;
  const { width: W, height: H, data } = src; const out = new Uint8ClampedArray(data.length);
  const gain = 2 ** t.exposure; const wr = gain * (1 + 0.25 * t.warmth), wg = gain * (1 + 0.15 * t.tint), wb = gain * (1 - 0.25 * t.warmth);
  // per channel: linear gain -> encode -> tone curve, tabulated (exact for 8-bit input)
  const lut = (g: number) => { const L = new Float32Array(256); for (let i = 0; i < 256; i++) L[i] = toneCurve(Math.min(1, toSrgb(Math.min(1, TO_LIN[i] * g))), t.shadows, t.highlights, t.contrast); return L; };
  const LR = lut(wr), LG = lut(wg), LB = lut(wb);
  const sat = 1 + t.saturation, vib = t.vibrance, vg = t.vignette;
  const cx = (W - 1) / 2, cy = (H - 1) / 2, rmax = Math.hypot(cx, cy) || 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let rr = LR[data[i]], gg = LG[data[i + 1]], bb = LB[data[i + 2]];
    if (sat !== 1 || vib) {
      const l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      const chroma = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
      const f = Math.max(0, sat * (1 + vib * (1 - chroma)));
      rr = l + (rr - l) * f; gg = l + (gg - l) * f; bb = l + (bb - l) * f;
    }
    if (vg) { const d = Math.hypot(x - cx, y - cy) / rmax; const m = 1 - vg * 0.8 * d * d; rr *= m; gg *= m; bb *= m; }
    out[i] = Math.round(Math.min(1, Math.max(0, rr)) * 255); out[i + 1] = Math.round(Math.min(1, Math.max(0, gg)) * 255); out[i + 2] = Math.round(Math.min(1, Math.max(0, bb)) * 255); out[i + 3] = data[i + 3];
  }
  return { width: W, height: H, data: out };
}

/** the whole pipeline; the input is the upright (EXIF-oriented) picture at any resolution */
export function renderRecipe(src: Raster, r: PhotoRecipe): Raster {
  let o = rotateQuarter(src, r.rotate ?? 0);
  o = flipRaster(o, !!r.flipH, !!r.flipV);
  if (r.straighten || r.crop) o = straightenCrop(o, r.straighten ?? 0, r.crop);
  return applyTone(o, r);
}

/** output size for a w×h upright source (exports report it before rendering) */
export function outputSize(w: number, h: number, r: PhotoRecipe): { width: number; height: number } {
  let W = r.rotate && r.rotate % 2 ? h : w, H = r.rotate && r.rotate % 2 ? w : h;
  if (r.straighten) { const k = straightenScale(W, H, r.straighten); W *= k; H *= k; }
  if (r.crop) { W *= r.crop.w; H *= r.crop.h; }
  return { width: Math.max(1, Math.round(W)), height: Math.max(1, Math.round(H)) };
}
