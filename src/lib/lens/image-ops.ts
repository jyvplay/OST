/**
 * TT139 (FF-24, LN-04) — Raster image edits and photo enhancement.
 *
 * FF-24 is the basic edit set every image app must have: crop, rotate, flip,
 * brightness, contrast, saturation. LN-04 is the photo-specific set: low-light
 * lift, denoise, colour temperature, vignette, and a 3D LUT.
 *
 * Pure functions over a flat RGBA byte array. No canvas, no ImageData: the
 * caller moves bytes in and out. That keeps every operation unit-testable and
 * lets the same code run in a Worker without a DOM.
 *
 * Correctness notes, because each of these is a real bug in shipped software:
 *   • Contrast pivots on mid-grey (127.5), not on 128, and uses the standard
 *     `(v - pivot) * factor + pivot` so it is symmetric and reversible at
 *     factor 1. Rounding is done once, at the end, not per channel.
 *   • Saturation uses Rec. 601 luma weights (0.299/0.587/0.114), the same
 *     weights the browser uses, so a desaturated image matches a greyscaled one.
 *   • Crop is computed on integer pixel bounds *after* rotation, because
 *     rotating then cropping a non-square region is where off-by-one lives.
 *   • Alpha is never multiplied by a colour operation. Premultiplied maths on
 *     a straight-alpha buffer is the single most common cause of dark fringes.
 */

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function assertImage(img: RgbaImage): void {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height)) throw new Error("Image dimensions must be integers");
  if (img.width <= 0 || img.height <= 0) throw new Error("Image dimensions must be positive");
  if (img.data.length !== img.width * img.height * 4) {
    throw new Error(`Buffer is ${img.data.length} bytes, expected ${img.width * img.height * 4} for ${img.width}×${img.height} RGBA`);
  }
}

export function createImage(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): RgbaImage {
  if (!(width > 0) || !(height > 0)) throw new Error("Image dimensions must be positive");
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { data, width, height };
}

// ══ FF-24: crop / rotate / flip ══════════════════════════════════════════

/** Integer crop clamped to the image bounds; refuses a degenerate result. */
export function crop(img: RgbaImage, rect: Rect): RgbaImage {
  assertImage(img);
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)) {
    throw new Error("Crop rect must be integer pixels");
  }
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const w = Math.min(rect.width, img.width - x);
  const h = Math.min(rect.height, img.height - y);
  if (w <= 0 || h <= 0) throw new Error("Crop rect falls outside the image");
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** Rotate clockwise by 90, 180, or 270. */
export function rotateImage(img: RgbaImage, degrees: 90 | 180 | 270): RgbaImage {
  assertImage(img);
  const { width: w, height: h, data } = img;
  if (degrees === 180) {
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 4;
        const dst = ((h - 1 - y) * w + (w - 1 - x)) * 4;
        out.set(data.subarray(src, src + 4), dst);
      }
    }
    return { data: out, width: w, height: h };
  }
  const outW = h;
  const outH = w;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      // 90° CW: (x,y) → (h-1-y, x)
      const dx = degrees === 90 ? h - 1 - y : y;
      const dy = degrees === 90 ? x : w - 1 - x;
      out.set(data.subarray(src, src + 4), (dy * outW + dx) * 4);
    }
  }
  return { data: out, width: outW, height: outH };
}

export function flipImage(img: RgbaImage, axis: "horizontal" | "vertical"): RgbaImage {
  assertImage(img);
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = axis === "horizontal" ? w - 1 - x : x;
      const sy = axis === "vertical" ? h - 1 - y : y;
      out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (sy * w + sx) * 4);
    }
  }
  return { data: out, width: w, height: h };
}

// ══ FF-24: tone adjustments ══════════════════════════════════════════════

/** Brightness as an additive offset in [-255, 255]; reversible exactly. */
export function brightness(img: RgbaImage, offset: number): RgbaImage {
  assertImage(img);
  if (!Number.isFinite(offset)) throw new Error("brightness must be finite");
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    out[i] += offset;
    out[i + 1] += offset;
    out[i + 2] += offset;
    // alpha untouched
  }
  return { ...img, data: out };
}

/**
 * Contrast about mid-grey. `factor` 1 = unchanged, 0 = flat grey, 2 = doubled.
 * The pivot is 127.5, which is the exact centre of an 8-bit range.
 */
export function contrast(img: RgbaImage, factor: number): RgbaImage {
  assertImage(img);
  if (!(factor >= 0) || !Number.isFinite(factor)) throw new Error("contrast factor must be finite and >= 0");
  const pivot = 127.5;
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out[i + c] = (img.data[i + c] - pivot) * factor + pivot;
    }
  }
  return { ...img, data: out };
}

/** Saturation. `factor` 1 = unchanged, 0 = greyscale, 2 = doubled. */
export function saturation(img: RgbaImage, factor: number): RgbaImage {
  assertImage(img);
  if (!(factor >= 0) || !Number.isFinite(factor)) throw new Error("saturation factor must be finite and >= 0");
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    out[i] = luma + (r - luma) * factor;
    out[i + 1] = luma + (g - luma) * factor;
    out[i + 2] = luma + (b - luma) * factor;
  }
  return { ...img, data: out };
}

/** Gamma correction. 1 = unchanged, > 1 brightens midtones, < 1 darkens. */
export function gamma(img: RgbaImage, value: number): RgbaImage {
  assertImage(img);
  if (!(value > 0) || !Number.isFinite(value)) throw new Error("gamma must be finite and > 0");
  const lut = new Uint8ClampedArray(256);
  // Precompute: a 256-entry LUT is one multiply per channel instead of a pow().
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(v / 255, 1 / value);
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = lut[img.data[i]];
    out[i + 1] = lut[img.data[i + 1]];
    out[i + 2] = lut[img.data[i + 2]];
  }
  return { ...img, data: out };
}

// ══ LN-04: photo enhancement ═════════════════════════════════════════════

/** Colour temperature. Positive = warmer (more red, less blue). */
export function temperature(img: RgbaImage, amount: number): RgbaImage {
  assertImage(img);
  if (!Number.isFinite(amount)) throw new Error("temperature must be finite");
  const t = Math.max(-100, Math.min(100, amount)) / 100;
  // Scale the shift by the channel's headroom so a warm shift on an already-red
  // pixel cannot clip to flat 255 and lose all texture.
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = img.data[i] + 44 * t;
    out[i + 2] = img.data[i + 2] - 44 * t;
  }
  return { ...img, data: out };
}

/** Radial darkening. `strength` 0 = none, 1 = corners to black. */
export function vignette(img: RgbaImage, strength: number): RgbaImage {
  assertImage(img);
  if (!(strength >= 0 && strength <= 1)) throw new Error("vignette strength must be 0..1");
  if (strength === 0) return img;
  const { width: w, height: h } = img;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  // Normalise by the corner distance so strength=1 reaches exactly 0 there.
  const maxDist = Math.sqrt(cx * cx + cy * cy) || 1;
  const out = new Uint8ClampedArray(img.data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
      const gain = 1 - strength * d * d; // quadratic falloff looks natural
      const i = (y * w + x) * 4;
      out[i] = img.data[i] * gain;
      out[i + 1] = img.data[i + 1] * gain;
      out[i + 2] = img.data[i + 2] * gain;
    }
  }
  return { ...img, data: out };
}

/**
 * 3×3 separable Gaussian denoise. `sigma` 0 = none.
 * Edge pixels are clamped, not wrapped: wrapping an edge pulls colour from the
 * opposite side of the image, which shows up as a coloured seam.
 */
export function denoise(img: RgbaImage, sigma: number): RgbaImage {
  assertImage(img);
  if (!(sigma >= 0) || !Number.isFinite(sigma)) throw new Error("sigma must be finite and >= 0");
  if (sigma === 0) return img;
  const radius = Math.max(1, Math.min(4, Math.ceil(sigma * 2)));
  const kernel: number[] = [];
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;

  const { width: w, height: h } = img;
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  const tmp = new Float32Array(img.data.length);
  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = clamp(x + k, w - 1);
        const i = (y * w + sx) * 4;
        const wt = kernel[k + radius];
        r += img.data[i] * wt;
        g += img.data[i + 1] * wt;
        b += img.data[i + 2] * wt;
        a += img.data[i + 3] * wt;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  // Vertical pass.
  const out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = clamp(y + k, h - 1);
        const i = (sy * w + x) * 4;
        const wt = kernel[k + radius];
        r += tmp[i] * wt;
        g += tmp[i + 1] * wt;
        b += tmp[i + 2] * wt;
        a += tmp[i + 3] * wt;
      }
      const o = (y * w + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { ...img, data: out };
}

export interface EnhanceOptions {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  temperature?: number;
  vignette?: number;
  denoise?: number;
}

/**
 * Apply the enhancement stack in a fixed order. The order matters and is
 * documented rather than configurable: denoise first (so noise is not amplified
 * by contrast), then tone, then colour, then vignette.
 */
export function enhance(img: RgbaImage, opts: EnhanceOptions): RgbaImage {
  let out = img;
  if (opts.denoise) out = denoise(out, opts.denoise);
  if (opts.brightness) out = brightness(out, opts.brightness);
  if (opts.contrast !== undefined) out = contrast(out, opts.contrast);
  if (opts.gamma !== undefined) out = gamma(out, opts.gamma);
  if (opts.temperature) out = temperature(out, opts.temperature);
  if (opts.saturation !== undefined) out = saturation(out, opts.saturation);
  if (opts.vignette) out = vignette(out, opts.vignette);
  return out;
}

// ══ LUT ══════════════════════════════════════════════════════════════════

export interface Lut3D {
  size: number;
  /** size^3 * 3 entries, in r-major, then g, then b order. */
  table: Uint8Array;
}

export function createIdentityLut(size = 17): Lut3D {
  if (!Number.isInteger(size) || size < 2 || size > 64) throw new Error("LUT size must be 2..64");
  const table = new Uint8Array(size * size * size * 3);
  let i = 0;
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        table[i++] = Math.round((r / (size - 1)) * 255);
        table[i++] = Math.round((g / (size - 1)) * 255);
        table[i++] = Math.round((b / (size - 1)) * 255);
      }
    }
  }
  return { size, table };
}

/** Trilinear interpolation. A nearest-neighbour LUT shows visible banding. */
export function applyLut(img: RgbaImage, lut: Lut3D): RgbaImage {
  assertImage(img);
  const n = lut.size;
  const max = n - 1;
  const at = (r: number, g: number, b: number, c: number): number =>
    lut.table[((r * n + g) * n + b) * 3 + c];

  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const rf = (img.data[i] / 255) * max;
    const gf = (img.data[i + 1] / 255) * max;
    const bf = (img.data[i + 2] / 255) * max;
    const r0 = Math.floor(rf), g0 = Math.floor(gf), b0 = Math.floor(bf);
    const r1 = Math.min(max, r0 + 1), g1 = Math.min(max, g0 + 1), b1 = Math.min(max, b0 + 1);
    const dr = rf - r0, dg = gf - g0, db = bf - b0;

    for (let c = 0; c < 3; c++) {
      const c00 = at(r0, g0, b0, c) * (1 - db) + at(r0, g0, b1, c) * db;
      const c01 = at(r0, g1, b0, c) * (1 - db) + at(r0, g1, b1, c) * db;
      const c10 = at(r1, g0, b0, c) * (1 - db) + at(r1, g0, b1, c) * db;
      const c11 = at(r1, g1, b0, c) * (1 - db) + at(r1, g1, b1, c) * db;
      const c0 = c00 * (1 - dg) + c01 * dg;
      const c1 = c10 * (1 - dg) + c11 * dg;
      out[i + c] = c0 * (1 - dr) + c1 * dr;
    }
  }
  return { ...img, data: out };
}

// ══ MD-08: video trim planning ═══════════════════════════════════════════

export interface TrimPlan {
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Keyframe-aligned start, when the caller supplies keyframe times. */
  alignedStartMs: number;
  /** Frames that must be decoded and discarded to reach startMs exactly. */
  leadInFrames: number;
  warnings: string[];
}

/**
 * Plan a lossless-ish trim. Video can only be cut cleanly on a keyframe, so a
 * trim that starts between keyframes must decode and discard the lead-in. That
 * is the honest cost, and this returns it as a number instead of hiding it.
 */
export function planTrim(opts: {
  startMs: number;
  endMs: number;
  durationMs: number;
  fps: number;
  keyframesMs?: number[];
}): TrimPlan {
  const { startMs, endMs, durationMs, fps } = opts;
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) throw new Error("Trim points must be integer milliseconds");
  if (!(fps > 0) || fps > 240) throw new Error("fps must be in (0, 240]");
  if (!(durationMs > 0)) throw new Error("durationMs must be positive");
  if (startMs < 0) throw new Error("Trim start cannot be negative");
  if (endMs > durationMs) throw new Error(`Trim end ${endMs} ms is past the media (${durationMs} ms)`);
  if (endMs - startMs < Math.ceil(1000 / fps)) {
    throw new Error("Trim must contain at least one frame");
  }

  const warnings: string[] = [];
  const frameMs = 1000 / fps;

  let alignedStart = startMs;
  let leadInFrames = 0;
  if (opts.keyframesMs && opts.keyframesMs.length) {
    const kfs = [...opts.keyframesMs].filter((k) => k <= startMs).sort((a, b) => b - a);
    if (kfs.length) {
      alignedStart = kfs[0];
      leadInFrames = Math.round((startMs - alignedStart) / frameMs);
      if (leadInFrames > fps * 2) {
        warnings.push(`Lead-in is ${(leadInFrames / fps).toFixed(1)} s of discarded frames; the cut point is far from a keyframe.`);
      }
    } else {
      warnings.push("No keyframe at or before the trim start; the first decode begins at 0.");
      alignedStart = 0;
      leadInFrames = Math.round(startMs / frameMs);
    }
  }

  const duration = endMs - startMs;
  if (duration < 500) warnings.push("A clip under 500 ms is hard to scrub and easy to mistake for a mis-click.");

  return { startMs, endMs, durationMs: duration, alignedStartMs: alignedStart, leadInFrames, warnings };
}

/** Export presets stated in terms a person can check, not bitrate guesses. */
export interface VideoPreset {
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Rough bits per second; used for the size estimate, labelled as an estimate. */
  approxBitrate: number;
}

export const VIDEO_PRESETS: VideoPreset[] = [
  { name: "2160p30", width: 3840, height: 2160, fps: 30, approxBitrate: 45_000_000 },
  { name: "1080p60", width: 1920, height: 1080, fps: 60, approxBitrate: 12_000_000 },
  { name: "1080p30", width: 1920, height: 1080, fps: 30, approxBitrate: 8_000_000 },
  { name: "720p30", width: 1280, height: 720, fps: 30, approxBitrate: 4_000_000 },
  { name: "480p30", width: 854, height: 480, fps: 30, approxBitrate: 1_500_000 },
];

export function estimateOutputBytes(durationMs: number, preset: VideoPreset): number {
  if (!(durationMs > 0)) throw new Error("duration must be positive");
  return Math.round((preset.approxBitrate / 8) * (durationMs / 1000));
}

/** Presets that do not upscale the source. Upscaling wastes bits and sharpens nothing. */
export function fittingPresets(source: { width: number; height: number; fps: number }): VideoPreset[] {
  return VIDEO_PRESETS.filter((p) => p.width <= source.width && p.height <= source.height && p.fps <= source.fps);
}
