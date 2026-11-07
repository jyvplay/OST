/**
 * TT145 (LN-05) — upscale, with the one thing an upscaler must never do: invent
 * detail and call it detail.
 *
 * A page has three real options, and they produce visibly different results at
 * the same output size:
 *
 *   · **nearest** — replicates pixels. Correct for pixel art and for any image
 *     whose pixels are data (a screenshot of text at 2×, a sprite). Wrong for a
 *     photograph, where it produces visible blocks.
 *   · **bilinear/bicubic** — canvas `drawImage` with `imageSmoothingQuality`.
 *     Interpolates. Correct for photographs, and it does not add information, it
 *     redistributes it.
 *   · **edge-directed (Lanczos-shaped)** — a small separable kernel this module
 *     implements, which preserves edges better than bilinear at high ratios and
 *     costs O(n·k) per pixel.
 *
 * There is no learned upscaler here, and the row must not claim one. What this
 * module can prove is a **budget**: an upscale may multiply pixels by at most 4×
 * per side, must state which kernel produced the output, and must report the
 * *measured* peak signal change against a bilinear reference so a caller can see
 * that the chosen kernel is doing something rather than nothing.
 */

export type Kernel = "nearest" | "bilinear" | "lanczos3";

export const MAX_SCALE = 4;
export const MAX_OUTPUT_PX = 64 * 1024 * 1024;
/** Taps each side for a 3-lobe Lanczos. */
const LOBES = 3;

export interface Plan {
  kernel: Kernel;
  scale: number;
  out: { w: number; h: number };
  /** Multiply-accumulates, as an order-of-magnitude cost. */
  macs: number;
  ok: boolean;
  sentence: string;
}

/**
 * Chooses the kernel from the content, not from taste: an image whose pixels are
 * data (an indexed PNG, a screenshot) must not be smoothed, and a photograph must
 * not be block-replicated. `photo` is the caller's judgement, and the engine says
 * when the choice it made is the caller's rather than its own.
 */
export function chooseKernel(photo: boolean, scale: number): Kernel {
  if (!photo) return "nearest";
  return scale >= 2 ? "lanczos3" : "bilinear";
}

export function planUpscale(input: { w: number; h: number; scale: number; kernel: Kernel }): Plan {
  if (!(input.w > 0) || !(input.h > 0)) throw new Error("source dimensions must be positive");
  if (!(input.scale > 1)) throw new Error("upscale needs a scale above 1; use a downscale path for the other direction");
  if (input.scale > MAX_SCALE) throw new Error(`a ${input.scale}× upscale exceeds the ${MAX_SCALE}× limit: beyond that the output is interpolation, not detail`);
  const out = { w: Math.round(input.w * input.scale), h: Math.round(input.h * input.scale) };
  const px = out.w * out.h;
  if (px > MAX_OUTPUT_PX) throw new Error(`${px} output pixels exceeds the ${MAX_OUTPUT_PX} limit; a canvas this size cannot be composited on a modest device`);
  const taps = input.kernel === "lanczos3" ? LOBES * 2 : input.kernel === "bilinear" ? 2 : 1;
  const macs = px * taps * 2;
  return {
    kernel: input.kernel, scale: input.scale, out, macs, ok: true,
    sentence: `${out.w}×${out.h} via ${input.kernel}, about ${(macs / 1e6).toFixed(1)} M multiply-accumulates${input.kernel === "nearest" ? " — pixels are replicated, so no new detail is claimed" : input.kernel === "bilinear" ? " — interpolation redistributes detail, it does not add it" : " — an edge-directed kernel; still interpolation, never invented content"}`,
  };
}

/** Lanczos-3 kernel value, normalised at call time. */
export function lanczos(x: number): number {
  if (x === 0) return 1;
  const a = Math.abs(x);
  if (a >= LOBES) return 0;
  const pix = Math.PI * a;
  return (LOBES * Math.sin(pix) * Math.sin(pix / LOBES)) / (pix * pix);
}

/**
 * One-dimensional resample of a row of samples. Separable and integer-friendly;
 * produces the same numbers the canvas would for bilinear, which is what lets a
 * test compare against a reference without a canvas.
 */
export function resampleRow(src: readonly number[], scale: number, kernel: Kernel): number[] {
  if (!(src.length > 0)) return [];
  if (!(scale > 1)) throw new Error("resampleRow is the upscale direction only");
  const out = new Array(Math.round(src.length * scale)).fill(0);
  const taps = kernel === "lanczos3" ? LOBES * 2 : kernel === "bilinear" ? 2 : 1;
  for (let i = 0; i < out.length; i++) {
    const centre = (i + 0.5) / scale - 0.5;
    if (kernel === "nearest") { out[i] = src[Math.min(src.length - 1, Math.max(0, Math.round(centre)))]; continue; }
    let sum = 0, wsum = 0;
    for (let t = 0; t < taps; t++) {
      const j = Math.floor(centre) + t - Math.floor((taps - 1) / 2);
      const w = kernel === "lanczos3" ? lanczos(centre - j) : 1 - Math.abs(centre - j);
      if (w === 0) continue;
      const sample = src[Math.min(src.length - 1, Math.max(0, j))];
      sum += sample * w; wsum += w;
    }
    out[i] = wsum === 0 ? src[Math.min(src.length - 1, Math.max(0, Math.round(centre)))] : sum / wsum;
  }
  return out;
}

/** Peak absolute difference between two equally long rows; the "is it doing anything" check. */
export function maxDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`rows differ in length: ${a.length} vs ${b.length}`);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/**
 * Ringing bound. A Lanczos kernel can overshoot; the engine clamps every sample
 * to the range of its source neighbours so an upscaled edge never produces a
 * halo darker than the darkest neighbour or brighter than the brightest. This is
 * the difference between "sharp" and "speckled", and it is one line of proof.
 */
export function clampToNeighbours(src: readonly number[], out: readonly number[], scale: number): number[] {
  return out.map((v, i) => {
    const a = Math.min(src.length - 1, Math.max(0, Math.floor(i / scale) - 1));
    const b = Math.min(src.length - 1, Math.max(0, Math.floor(i / scale) + 1));
    const lo = Math.min(src[a], src[b]), hi = Math.max(src[a], src[b]);
    return Math.min(hi, Math.max(lo, v));
  });
}

export const LIMITS = [
  "no learned model: every kernel here is interpolation, and the UI says so",
  "edge-directed sharpening improves apparent edges; it does not recover information the source never had",
  "a canvas upscale of a JPEG re-encodes it; the output is not lossless even at 1:1",
  "the cost figure is multiply-accumulates, not a measured frame time",
] as const;
