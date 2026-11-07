/**
 * TT146 (LN-05, LN-06) — a real resampler and a real lighting model.
 *
 * The previous Lens upscale asked the browser's bitmap pipeline to smooth a
 * frame and called it Lanczos; the previous key light was a brightness and
 * contrast lift. Both were labelled honestly, and both were weaker than the
 * feature's contract. This file replaces the arithmetic with the actual thing:
 *
 *   • **Separable windowed-sinc resampling.** For each output sample the kernel
 *     is evaluated at every contributing input sample, the weights are
 *     normalised to sum to 1, and the two axes are applied one after the other
 *     (the kernel is separable, so this is exact, not an approximation — and it
 *     is O(n·taps) instead of O(n·taps²)).
 *   • **Widening on downscale.** A filter of *fixed* width aliases when the
 *     image shrinks: a 3-lobe kernel reading 2 px on each side cannot average a
 *     10:1 reduction. The support therefore scales as a/max(1, ratio), which is
 *     what every correct implementation (Pillow, ImageMagick, ffmpeg) does and
 *     the single most common mistake in hand-written resize code.
 *   • **Premultiplied alpha.** Filtering straight-alpha colour mixes the RGB of
 *     transparent pixels into the result, which is where dark halos around
 *     cut-outs come from. Colour channels are multiplied by alpha before the
 *     filter and divided out afterwards; fully transparent output stays
 *     transparent and keeps the filtered colour of nothing.
 *   • **A directional light, not a brightness knob.** LN-06 estimates a surface
 *     normal from the luminance gradient, then shades with a Lambert term plus a
 *     Blinn-Phong highlight from a *direction* the user controls. Rotating the
 *     light moves the highlight; brightness does not.
 *
 * Everything is float32/float64 arithmetic over plain typed arrays, so it runs
 * in a Worker unchanged and is compared against a numpy reference in the tests.
 */

export type Kernel = "linear" | "cubic" | "lanczos3";

export interface TapTable {
  /** First source index that contributes to output i. */
  start: Int32Array;
  /** Weights, laid out [dst][tap]; each row sums to 1 within float error. */
  weights: Float64Array;
  taps: number;
  /** How much the kernel was widened for this reduction, 1 on upscale. */
  filterScale: number;
}

const SUPPORT: Record<Kernel, number> = { linear: 1, cubic: 2, lanczos3: 3 };

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

export function kernelValue(kernel: Kernel, x: number): number {
  const ax = Math.abs(x);
  switch (kernel) {
    case "linear":
      return ax < 1 ? 1 - ax : 0;
    case "cubic": {
      // Catmull-Rom (a = -0.5): the classic bicubic, and the one with the
      // sharpening that makes a 2× upscale look like detail rather than mush.
      const a = -0.5;
      if (ax < 1) return (a + 2) * ax ** 3 - (a + 3) * ax ** 2 + 1;
      if (ax < 2) return a * ax ** 3 - 5 * a * ax ** 2 + 8 * a * ax - 4 * a;
      return 0;
    }
    case "lanczos3":
      // Three lobes. Beyond 3 the window is zero, so the weight stops.
      return ax < 3 ? sinc(ax) * sinc(ax / 3) : 0;
  }
}

export const MAX_TAPS = 32;
export const MAX_FILTER_SCALE = 4;

/**
 * Build the weight table for one axis.
 *
 * Centre convention: output pixel i covers [i/s, (i+1)/s) in source space, so
 * its centre maps to (i+0.5)/s - 0.5. Using i/s instead shifts the image half a
 * pixel per step and is invisible on a photo but obvious on a checkerboard.
 */
export function tapTable(srcLen: number, dstLen: number, kernel: Kernel): TapTable {
  if (!Number.isInteger(srcLen) || srcLen < 1) throw new Error("source length must be a positive integer");
  if (!Number.isInteger(dstLen) || dstLen < 1) throw new Error("destination length must be a positive integer");
  const ratio = dstLen / srcLen;
  const filterScale = Math.min(MAX_FILTER_SCALE, Math.max(1, 1 / ratio));
  const support = SUPPORT[kernel] * filterScale;
  // A window can never be wider than the source: with a 1-pixel-high image a
  // 6-tap kernel would read past the end of the buffer and produce NaN.
  const taps = Math.min(MAX_TAPS, srcLen, Math.max(1, Number.isFinite(support) ? Math.ceil(support * 2) : 1));
  const start = new Int32Array(dstLen);
  const weights = new Float64Array(dstLen * taps);

  for (let i = 0; i < dstLen; i++) {
    const centre = (i + 0.5) / ratio - 0.5;
    // The first contributing source sample is clamped so the window never runs
    // off the edge and never silently shifts the image.
    let first = Math.ceil(centre - support);
    if (first + taps - 1 > srcLen - 1) first = srcLen - taps;
    if (first < 0) first = 0;
    start[i] = first;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const srcIndex = first + t;
      const w = kernelValue(kernel, (srcIndex - centre) / filterScale);
      weights[i * taps + t] = w;
      sum += w;
    }
    if (sum === 0) {
      // Degenerate window (can only happen with a NaN centre): fall back to the
      // nearest sample rather than producing a black column.
      const nearest = Math.min(srcLen - 1, Math.max(0, Math.round(centre)));
      first = Math.max(0, Math.min(srcLen - 1, nearest));
      start[i] = first;
      for (let t = 0; t < taps; t++) weights[i * taps + t] = t === 0 ? 1 : 0;
    } else {
      for (let t = 0; t < taps; t++) weights[i * taps + t] /= sum;
    }
  }
  return { start, weights, taps, filterScale };
}

export const MAX_OUTPUT_PIXELS = 16_000_000;

export interface RgbaImage { data: Uint8ClampedArray; width: number; height: number }

function assertImage(img: RgbaImage): void {
  if (!img || !img.data) throw new Error("image data is required");
  if (!Number.isInteger(img.width) || img.width < 1) throw new Error("image width must be a positive integer");
  if (!Number.isInteger(img.height) || img.height < 1) throw new Error("image height must be a positive integer");
  if (img.data.length !== img.width * img.height * 4) throw new Error("image data length does not match width × height × 4");
}

/**
 * Resample RGBA8. Colour is filtered premultiplied; the alpha channel is
 * filtered on its own. Output rounds half away from zero and clamps, which is
 * what a canvas putImageData does with a Uint8ClampedArray.
 */
export function resample(img: RgbaImage, dstW: number, dstH: number, kernel: Kernel = "lanczos3"): RgbaImage {
  assertImage(img);
  if (!Number.isInteger(dstW) || dstW < 1) throw new Error("destination width must be a positive integer");
  if (!Number.isInteger(dstH) || dstH < 1) throw new Error("destination height must be a positive integer");
  if (dstW * dstH > MAX_OUTPUT_PIXELS) throw new Error(`output of ${dstW}×${dstH} exceeds the ${MAX_OUTPUT_PIXELS}-pixel cap`);
  const { width: sw, height: sh, data: src } = img;

  const hTab = tapTable(sw, dstW, kernel);
  const vTab = tapTable(sh, dstH, kernel);

  // Horizontal pass into a float buffer, premultiplied.
  const mid = new Float32Array(dstW * sh * 4);
  for (let y = 0; y < sh; y++) {
    const rowIn = y * sw * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const base = x * hTab.taps;
      for (let t = 0; t < hTab.taps; t++) {
        const w = hTab.weights[base + t];
        if (w === 0) continue;
        const i = rowIn + (hTab.start[x] + t) * 4;
        const alpha = src[i + 3] / 255;
        r += src[i] * alpha * w;
        g += src[i + 1] * alpha * w;
        b += src[i + 2] * alpha * w;
        a += src[i + 3] * w;
      }
      const o = (y * dstW + x) * 4;
      mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
    }
  }

  // Vertical pass, then un-premultiply.
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const base = y * vTab.taps;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = 0; t < vTab.taps; t++) {
        const w = vTab.weights[base + t];
        if (w === 0) continue;
        const i = ((vTab.start[y] + t) * dstW + x) * 4;
        r += mid[i] * w;
        g += mid[i + 1] * w;
        b += mid[i + 2] * w;
        a += mid[i + 3] * w;
      }
      const o = (y * dstW + x) * 4;
      const alpha = Math.max(0, Math.min(255, a));
      // A transparent pixel has no defined colour, and dividing by an almost-zero
      // alpha (ringing can leave 1e-14) turns a rounding artefact into a white
      // speck. Below half a level the sample is treated as fully transparent.
      if (alpha < 0.5) {
        // Fully transparent: colour is undefined, so do not invent a halo.
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
        continue;
      }
      const inv = 255 / alpha;
      out[o] = Math.round(r * inv);
      out[o + 1] = Math.round(g * inv);
      out[o + 2] = Math.round(b * inv);
      out[o + 3] = Math.round(alpha);
    }
  }
  return { data: out, width: dstW, height: dstH };
}

/* ------------------------------------------------------------------ LN-06 */

export interface RelightOptions {
  /** 0 = light from +x (right of the image), 90 = from +y (up the image). Degrees. */
  azimuthDeg: number;
  /** 0 = straight at the surface (no shading), 90 = grazing. Degrees, clamped to 0…85. */
  elevationDeg: number;
  /** 0 = identity. 1 = a strong key light. */
  intensity: number;
  /** How much the luminance gradient is trusted as slope. 0 disables normal estimation. */
  relief?: number;
  /** Size of the Blinn-Phong highlight, 4…256. */
  shininess?: number;
  /** Strength of the highlight relative to the diffuse term. */
  specular?: number;
}

export const RELIGHT_LIMITS = {
  minIntensity: 0,
  maxIntensity: 1.5,
  maxElevation: 85,
  maxRelief: 8,
  maxShininess: 256,
  maxSpecular: 2,
} as const;

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Rec. 601 luma, the same weights the rest of Fusion uses. */
export const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function normaliseOptions(o: RelightOptions): Required<RelightOptions> {
  if (!Number.isFinite(o.azimuthDeg)) throw new Error("azimuth must be a number");
  if (!Number.isFinite(o.elevationDeg)) throw new Error("elevation must be a number");
  if (!Number.isFinite(o.intensity)) throw new Error("intensity must be a number");
  return {
    azimuthDeg: ((o.azimuthDeg % 360) + 360) % 360,
    elevationDeg: clampNum(o.elevationDeg, 0, RELIGHT_LIMITS.maxElevation),
    intensity: clampNum(o.intensity, RELIGHT_LIMITS.minIntensity, RELIGHT_LIMITS.maxIntensity),
    relief: clampNum(o.relief ?? 2, 0, RELIGHT_LIMITS.maxRelief),
    shininess: clampNum(o.shininess ?? 32, 4, RELIGHT_LIMITS.maxShininess),
    specular: clampNum(o.specular ?? 0.25, 0, RELIGHT_LIMITS.maxSpecular),
  };
}

export function lightVector(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  // Image space: +x right, +y *down* the rows, +z towards the viewer.
  return [Math.cos(el) * Math.cos(az), -Math.cos(el) * Math.sin(az), Math.sin(el)];
}

/**
 * Apply a directional key light.
 *
 * Normals come from the luminance gradient (Sobel), so a flat region is a flat
 * surface facing the viewer and an edge is a slope. That is a *relief* estimate,
 * not a depth camera: it cannot separate a dark edge from a real crease, and a
 * texture with no shading detail yields no normal, which is why `relief: 0`
 * reduces the effect to a uniform frontal light.
 *
 * The identity property is exact: with `intensity` 0 every byte is returned
 * unchanged, so the control can be switched off without recompressing anything.
 */
export function applyRelight(img: RgbaImage, options: RelightOptions): RgbaImage {
  assertImage(img);
  const o = normaliseOptions(options);
  const { width: w, height: h, data: src } = img;
  const out = new Uint8ClampedArray(src.length);
  if (o.intensity === 0) { out.set(src); return { data: out, width: w, height: h }; }

  const [lx, ly, lz] = lightVector(o.azimuthDeg, o.elevationDeg);
  // Half vector between the light and the viewer (0,0,1).
  const hx = lx, hy = ly, hz = lz + 1;
  const hl = Math.hypot(hx, hy, hz) || 1;
  const HX = hx / hl, HY = hy / hl, HZ = hz / hl;

  // Precompute luminance so the Sobel pass does not touch the source twice per pixel.
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) lum[i] = luma(src[p], src[p + 1], src[p + 2]);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Clamped replicate-border sampling. An earlier version clamped the whole
      // *index* at the edge, which silently substituted the middle-row value for
      // the diagonal neighbour and made the last column shade differently — the
      // numpy reference caught it, and the fix is to clamp the coordinates, not
      // the flattened offset.
      const at = (yy: number, xx: number) => lum[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))];
      // Sobel, normalised by 8 so the gradient is per-pixel average slope.
      const gx = ((at(y - 1, x + 1) + 2 * at(y, x + 1) + at(y + 1, x + 1))
        - (at(y - 1, x - 1) + 2 * at(y, x - 1) + at(y + 1, x - 1))) / 8;
      const gy = ((at(y + 1, x - 1) + 2 * at(y + 1, x) + at(y + 1, x + 1))
        - (at(y - 1, x - 1) + 2 * at(y - 1, x) + at(y - 1, x + 1))) / 8;
      // Scale gradient (0…255 units) into a slope, then build and normalise n.
      const sx = (-gx * o.relief) / 64;
      const sy = (-gy * o.relief) / 64;
      const nl = Math.hypot(sx, sy, 1);
      const nx = sx / nl, ny = sy / nl, nz = 1 / nl;

      const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
      const specBase = Math.max(0, nx * HX + ny * HY + nz * HZ);
      const specular = Math.pow(specBase, o.shininess) * o.specular;

      const p = i * 4;
      const alpha = src[p + 3];
      if (alpha === 0) { out[p] = 0; out[p + 1] = 0; out[p + 2] = 0; out[p + 3] = 0; continue; }
      const gain = 1 + o.intensity * diffuse;
      const add = o.intensity * specular * 255;
      out[p] = src[p] * gain + add;
      out[p + 1] = src[p + 1] * gain + add;
      out[p + 2] = src[p + 2] * gain + add;
      out[p + 3] = alpha;
    }
  }
  return { data: out, width: w, height: h };
}

/** Mean luma, used by the UI's live read-out and by the tests as an energy probe. */
export function meanLuma(img: RgbaImage): number {
  assertImage(img);
  let sum = 0;
  for (let p = 0; p < img.data.length; p += 4) sum += luma(img.data[p], img.data[p + 1], img.data[p + 2]);
  return sum / (img.width * img.height);
}

/** Where the brightest pixel is, as a fraction of width/height — proves the light moved. */
export function brightestAt(img: RgbaImage): { x: number; y: number } {
  assertImage(img);
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      const v = luma(img.data[p], img.data[p + 1], img.data[p + 2]);
      if (v > best) { best = v; bx = x; by = y; }
    }
  }
  return { x: (bx + 0.5) / img.width, y: (by + 0.5) / img.height };
}
