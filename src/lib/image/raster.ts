// Ported from the competitor TT14 tree (src/lib/raster.ts), additive TT16 merge. Reviewed + covered by scripts/image-engine.mts.
/**
 * FF-05 raster image operations.
 *
 * Deliberately pure: every operation maps {width,height,RGBA} → {width,height,RGBA} with no canvas,
 * no DOM and no GPU. That makes the maths verifiable headlessly in Node (exact pixel assertions in
 * the self-test) and lets the same code run in the browser UI and in a Worker.
 *
 * Colour space: straight (non-premultiplied) sRGB bytes, alpha preserved by every op unless stated.
 */

export type Raster = { width: number; height: number; data: Uint8ClampedArray };

export const MAX_PIXELS = 40_000_000; // guard: ~40 MP before any allocation

export function createRaster(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]): Raster {
  if (width < 1 || height < 1 || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error("invalid raster size");
  if (width * height > MAX_PIXELS) throw new Error("raster exceeds the pixel guard");
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3]; }
  return { width, height, data };
}
export const cloneRaster = (r: Raster): Raster => ({ width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) });
export const pixelAt = (r: Raster, x: number, y: number): [number, number, number, number] => {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
};

export function crop(src: Raster, x: number, y: number, w: number, h: number): Raster {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(y)));
  const w0 = Math.max(1, Math.min(src.width - x0, Math.floor(w)));
  const h0 = Math.max(1, Math.min(src.height - y0, Math.floor(h)));
  const out = createRaster(w0, h0);
  for (let row = 0; row < h0; row++) {
    const from = ((y0 + row) * src.width + x0) * 4;
    out.data.set(src.data.subarray(from, from + w0 * 4), row * w0 * 4);
  }
  return out;
}

/** Bilinear resample. Exact for integral up/down scales at pixel centres. */
export function resize(src: Raster, width: number, height: number): Raster {
  const out = createRaster(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  const sx = src.width / out.width, sy = src.height / out.height;
  for (let y = 0; y < out.height; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(src.height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < out.width; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(src.width - 1, x0 + 1), wx = fx - x0;
      const o = (y * out.width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 4 + c], p10 = src.data[(y0 * src.width + x1) * 4 + c];
        const p01 = src.data[(y1 * src.width + x0) * 4 + c], p11 = src.data[(y1 * src.width + x1) * 4 + c];
        out.data[o + c] = Math.round(p00 * (1 - wx) * (1 - wy) + p10 * wx * (1 - wy) + p01 * (1 - wx) * wy + p11 * wx * wy);
      }
    }
  }
  return out;
}

export function rotate90(src: Raster, turns: number): Raster {
  const t = ((Math.round(turns) % 4) + 4) % 4;
  if (t === 0) return cloneRaster(src);
  const swap = t % 2 === 1;
  const out = createRaster(swap ? src.height : src.width, swap ? src.width : src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const nx = t === 1 ? src.height - 1 - y : t === 2 ? src.width - 1 - x : y;
      const ny = t === 1 ? x : t === 2 ? src.height - 1 - y : src.width - 1 - x;
      const from = (y * src.width + x) * 4, to = (ny * out.width + nx) * 4;
      out.data[to] = src.data[from]; out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2]; out.data[to + 3] = src.data[from + 3];
    }
  }
  return out;
}

export function flip(src: Raster, axis: "horizontal" | "vertical"): Raster {
  const out = createRaster(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const sx = axis === "horizontal" ? src.width - 1 - x : x;
      const sy = axis === "vertical" ? src.height - 1 - y : y;
      const from = (sy * src.width + sx) * 4, to = (y * out.width + x) * 4;
      out.data[to] = src.data[from]; out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2]; out.data[to + 3] = src.data[from + 3];
    }
  }
  return out;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export type Adjustments = { brightness?: number; contrast?: number; saturation?: number; grayscale?: boolean; invert?: boolean };

/** brightness/contrast/saturation are multipliers around 1 (1 = unchanged). Alpha untouched. */
export function adjust(src: Raster, a: Adjustments): Raster {
  const out = cloneRaster(src);
  const b = a.brightness ?? 1, c = a.contrast ?? 1, s = a.saturation ?? 1;
  for (let i = 0; i < out.data.length; i += 4) {
    let r = out.data[i] * b, g = out.data[i + 1] * b, bl = out.data[i + 2] * b;
    r = (r - 128) * c + 128; g = (g - 128) * c + 128; bl = (bl - 128) * c + 128;
    if (s !== 1) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      r = lum + (r - lum) * s; g = lum + (g - lum) * s; bl = lum + (bl - lum) * s;
    }
    if (a.grayscale) { const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl; r = g = bl = lum; }
    if (a.invert) { r = 255 - r; g = 255 - g; bl = 255 - bl; }
    out.data[i] = clamp255(Math.round(r)); out.data[i + 1] = clamp255(Math.round(g)); out.data[i + 2] = clamp255(Math.round(bl));
  }
  return out;
}

/** Separable box blur, `radius` in pixels; repeated passes approach a Gaussian. */
export function blur(src: Raster, radius: number, passes = 2): Raster {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return cloneRaster(src);
  let cur = cloneRaster(src);
  for (let p = 0; p < passes; p++) {
    cur = boxPass(cur, r, true);
    cur = boxPass(cur, r, false);
  }
  return cur;
}
function boxPass(src: Raster, r: number, horizontal: boolean): Raster {
  const out = createRaster(src.width, src.height);
  const outer = horizontal ? src.height : src.width;
  const inner = horizontal ? src.width : src.height;
  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < inner; i++) {
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const j = i + k;
        if (j < 0 || j >= inner) continue;
        const idx = (horizontal ? o * src.width + j : j * src.width + o) * 4;
        // TT16 fix: premultiplied accumulation. Averaging straight RGB pulled the (0,0,0) colour of
        // fully transparent pixels into edges, leaving dark fringes on layer content.
        const a = src.data[idx + 3];
        sr += src.data[idx] * a; sg += src.data[idx + 1] * a; sb += src.data[idx + 2] * a; sa += a; n++;
      }
      const to = (horizontal ? o * out.width + i : i * out.width + o) * 4;
      if (sa > 0) { out.data[to] = Math.round(sr / sa); out.data[to + 1] = Math.round(sg / sa); out.data[to + 2] = Math.round(sb / sa); }
      out.data[to + 3] = Math.round(sa / n);
    }
  }
  return out;
}

/** 256-bin luminance histogram, useful for the editor readout and for tests. */
export function histogram(src: Raster): number[] {
  const bins = new Array<number>(256).fill(0);
  for (let i = 0; i < src.data.length; i += 4) {
    const lum = Math.round(0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2]);
    bins[clamp255(lum)]++;
  }
  return bins;
}

/* ───────────────── extended filters (all pure, all pixel-tested) ───────────────── */

/** Histogram equalisation on the luminance channel; colour ratios are preserved. */
export function equalize(src: Raster): Raster {
  const out = cloneRaster(src);
  const bins = histogram(src);
  const total = src.width * src.height;
  const cdf: number[] = [];
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += bins[i]; cdf.push(acc); }
  const cdfMin = cdf.find((v) => v > 0) ?? 0;
  const denom = Math.max(1, total - cdfMin);
  const lut = cdf.map((v) => clamp255(Math.round(((v - cdfMin) / denom) * 255)));
  for (let i = 0; i < out.data.length; i += 4) {
    const lum = Math.round(0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2]);
    const before = lum / 255 || 1 / 255;
    const scale = lut[lum] / 255 / before;
    out.data[i] = clamp255(Math.round(src.data[i] * scale));
    out.data[i + 1] = clamp255(Math.round(src.data[i + 1] * scale));
    out.data[i + 2] = clamp255(Math.round(src.data[i + 2] * scale));
  }
  return out;
}

/** Unsharp mask: src + amount * (src - blur(src)). amount 1 ≈ mild, 3 ≈ strong. */
export function sharpen(src: Raster, amount = 1.5, radius = 1): Raster {
  const soft = blur(src, radius, 1);
  const out = cloneRaster(src);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(Math.round(src.data[i + c] + amount * (src.data[i + c] - soft.data[i + c])));
  }
  return out;
}

export function sepia(src: Raster): Raster {
  const out = cloneRaster(src);
  for (let i = 0; i < out.data.length; i += 4) {
    const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
    out.data[i] = clamp255(Math.round(0.393 * r + 0.769 * g + 0.189 * b));
    out.data[i + 1] = clamp255(Math.round(0.349 * r + 0.686 * g + 0.168 * b));
    out.data[i + 2] = clamp255(Math.round(0.272 * r + 0.534 * g + 0.131 * b));
  }
  return out;
}

/** Luminance threshold at 0..255; output is pure black/white, alpha preserved. */
export function threshold(src: Raster, level = 128): Raster {
  const out = cloneRaster(src);
  for (let i = 0; i < out.data.length; i += 4) {
    const lum = 0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2];
    const v = lum >= level ? 255 : 0;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
  }
  return out;
}

/** Posterize to `levels` evenly spaced bands per channel (levels 2..16). */
export function posterize(src: Raster, levels = 4): Raster {
  const l = Math.max(2, Math.min(16, Math.round(levels)));
  const step = 255 / (l - 1);
  const out = cloneRaster(src);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(Math.round(Math.round(src.data[i + c] / step) * step));
  }
  return out;
}

/** Radial vignette: edges darken toward `strength` (0..1) at the corners. */
export function vignette(src: Raster, strength = 0.6): Raster {
  const out = cloneRaster(src);
  const cx = (src.width - 1) / 2, cy = (src.height - 1) / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD; // 0 centre → 1 corner
      const f = clamp255(Math.round(255 * (1 - strength * d * d)));
      const i = (y * src.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = Math.round((src.data[i + c] * f) / 255);
    }
  }
  return out;
}

/** Deterministic value noise (seeded LCG — no Math.random, so tests are reproducible). */
export function addNoise(src: Raster, amount = 24, seed = 1234): Raster {
  let x = seed >>> 0 || 1;
  const rnd = () => ((x = (1664525 * x + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const out = cloneRaster(src);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = clamp255(Math.round(src.data[i + c] + amount * rnd()));
  }
  return out;
}

/** Sobel edge magnitude → grayscale edges, alpha preserved. */
export function edgeDetect(src: Raster): Raster {
  const out = createRaster(src.width, src.height);
  // Border handling: clamp (replicate the edge pixel). Returning 0 for out-of-bounds manufactured a
  // fake edge along the right/bottom border of any bright image — found by the probe.
  const lum = (x: number, y: number) => {
    const cx = Math.min(src.width - 1, Math.max(0, x));
    const cy = Math.min(src.height - 1, Math.max(0, y));
    const i = (cy * src.width + cx) * 4;
    return 0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2];
  };
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const gx = -lum(x - 1, y - 1) - 2 * lum(x - 1, y) - lum(x - 1, y + 1) + lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1);
      const gy = -lum(x - 1, y - 1) - 2 * lum(x, y - 1) - lum(x + 1, y - 1) + lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1);
      const mag = clamp255(Math.round(Math.hypot(gx, gy) / 4));
      const i = (y * src.width + x) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = mag;
      out.data[i + 3] = src.data[i + 3];
    }
  }
  return out;
}

/* ───────────────── extended filters (production set) ───────────────── */

/** Pixelate: average each block of `size` px into one flat colour. */
export function pixelate(src: Raster, size = 8): Raster {
  const n = Math.max(1, Math.floor(size));
  const out = createRaster(src.width, src.height);
  for (let by = 0; by < src.height; by += n) {
    for (let bx = 0; bx < src.width; bx += n) {
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let y = by; y < Math.min(by + n, src.height); y++) {
        for (let x = bx; x < Math.min(bx + n, src.width); x++) {
          const i = (y * src.width + x) * 4;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
          cnt++;
        }
      }
      const avg: [number, number, number, number] = [Math.round(r / cnt), Math.round(g / cnt), Math.round(b / cnt), Math.round(a / cnt)];
      for (let y = by; y < Math.min(by + n, src.height); y++) {
        for (let x = bx; x < Math.min(bx + n, src.width); x++) {
          const i = (y * out.width + x) * 4;
          out.data[i] = avg[0]; out.data[i + 1] = avg[1]; out.data[i + 2] = avg[2]; out.data[i + 3] = avg[3];
        }
      }
    }
  }
  return out;
}

/** Duotone: map luminance to a gradient between two colours. */
export function duotone(src: Raster, dark: [number, number, number] = [20, 30, 60], light: [number, number, number] = [240, 220, 180]): Raster {
  const out = cloneRaster(src);
  for (let i = 0; i < out.data.length; i += 4) {
    const lum = (0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2]) / 255;
    out.data[i] = clamp255(Math.round(dark[0] + (light[0] - dark[0]) * lum));
    out.data[i + 1] = clamp255(Math.round(dark[1] + (light[1] - dark[1]) * lum));
    out.data[i + 2] = clamp255(Math.round(dark[2] + (light[2] - dark[2]) * lum));
  }
  return out;
}

/**
 * Hue rotation by `degrees`. Uses the standard luma-preserving hue-rotate matrix from the SVG
 * feColorMatrix spec — the same transform browsers apply. Note: this preserves luminance, not
 * saturation, so pure red at 120° yields a mid-luminance green, not (0,255,0).
 */
export function hueShift(src: Raster, degrees = 180): Raster {
  const out = cloneRaster(src);
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // Luma-preserving hue rotation coefficients (SVG feColorMatrix type="hueRotate").
  const m = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  for (let i = 0; i < out.data.length; i += 4) {
    const r = src.data[i] / 255, g = src.data[i + 1] / 255, b = src.data[i + 2] / 255;
    out.data[i] = clamp255(Math.round((m[0] * r + m[1] * g + m[2] * b) * 255));
    out.data[i + 1] = clamp255(Math.round((m[3] * r + m[4] * g + m[5] * b) * 255));
    out.data[i + 2] = clamp255(Math.round((m[6] * r + m[7] * g + m[8] * b) * 255));
  }
  return out;
}

/** Levels: remap input black/white points and apply gamma. */
export function levels(src: Raster, blackPoint = 0, whitePoint = 255, gamma = 1): Raster {
  const out = cloneRaster(src);
  const bp = clamp255(blackPoint), wp = clamp255(Math.max(blackPoint + 1, whitePoint));
  const g = Math.max(0.01, gamma);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const norm = Math.min(1, Math.max(0, (v - bp) / (wp - bp)));
    lut[v] = clamp255(Math.round(255 * Math.pow(norm, 1 / g)));
  }
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = lut[src.data[i]];
    out.data[i + 1] = lut[src.data[i + 1]];
    out.data[i + 2] = lut[src.data[i + 2]];
  }
  return out;
}

/** Curves: apply a tone curve defined by up to 256 LUT values (identity if shorter). */
export function curves(src: Raster, lut: number[]): Raster {
  const out = cloneRaster(src);
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    if (i < lut.length) table[i] = clamp255(Math.round(lut[i]));
    else table[i] = i; // identity beyond provided points
  }
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = table[src.data[i]];
    out.data[i + 1] = table[src.data[i + 1]];
    out.data[i + 2] = table[src.data[i + 2]];
  }
  return out;
}

/** Motion blur: directional blur along an angle. */
export function motionBlur(src: Raster, length = 10, angleDegrees = 0): Raster {
  const len = Math.max(1, Math.floor(length));
  const rad = (angleDegrees * Math.PI) / 180;
  const dx = Math.round(Math.cos(rad)), dy = Math.round(Math.sin(rad));
  const out = createRaster(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let k = 0; k < len; k++) {
        const sx = x - dx * k, sy = y - dy * k;
        if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
        const i = (sy * src.width + sx) * 4;
        r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
        n++;
      }
      const o = (y * src.width + x) * 4;
      out.data[o] = Math.round(r / n); out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n); out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Oil paint effect: quantise colours within a radius to the most frequent neighbour. */
export function oilPaint(src: Raster, radius = 4, levels = 20): Raster {
  const r = Math.max(1, Math.floor(radius));
  const lv = Math.max(2, Math.floor(levels));
  const out = createRaster(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const counts = new Map<number, number>();
      const sums = new Map<number, [number, number, number, number]>();
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const sx = x + dx, sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
          const i = (sy * src.width + sx) * 4;
          const lum = Math.floor((0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2]) / (256 / lv));
          counts.set(lum, (counts.get(lum) ?? 0) + 1);
          const s = sums.get(lum) ?? [0, 0, 0, 0];
          s[0] += src.data[i]; s[1] += src.data[i + 1]; s[2] += src.data[i + 2]; s[3] += src.data[i + 3];
          sums.set(lum, s);
        }
      }
      let best = 0, bestC = -1;
      for (const [k, c] of counts) if (c > bestC) { best = k; bestC = c; }
      const s = sums.get(best)!;
      const o = (y * src.width + x) * 4;
      out.data[o] = Math.round(s[0] / bestC); out.data[o + 1] = Math.round(s[1] / bestC);
      out.data[o + 2] = Math.round(s[2] / bestC); out.data[o + 3] = Math.round(s[3] / bestC);
    }
  }
  return out;
}

/** Frame/border: draw a solid colour border of `thickness` px inside the image. */
export function frame(src: Raster, thickness = 10, color: [number, number, number] = [255, 255, 255]): Raster {
  const t = Math.max(0, Math.floor(thickness));
  const out = cloneRaster(src);
  if (t === 0) return out;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (x < t || y < t || x >= src.width - t || y >= src.height - t) {
        const i = (y * src.width + x) * 4;
        out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2];
      }
    }
  }
  return out;
}

/** Arbitrary rotation by any angle (radians), with optional background fill. */
export function rotate(src: Raster, radians: number, fill: [number, number, number, number] = [0, 0, 0, 0]): Raster {
  const turns = Math.round(radians / (Math.PI / 2));
  // Fast path for 90-degree multiples
  if (Math.abs(radians - turns * (Math.PI / 2)) < 1e-9) return rotate90(src, turns);
  const cos = Math.cos(radians), sin = Math.sin(radians);
  // Compute new bounding box
  const w = src.width, h = src.height;
  const newW = Math.round(Math.abs(w * cos) + Math.abs(h * sin));
  const newH = Math.round(Math.abs(w * sin) + Math.abs(h * cos));
  const out = createRaster(Math.max(1, newW), Math.max(1, newH), fill);
  const cx = w / 2, cy = h / 2, ncx = newW / 2, ncy = newH / 2;
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      // Inverse map
      const sx = Math.round((x - ncx) * cos + (y - ncy) * sin + cx);
      const sy = Math.round(-(x - ncx) * sin + (y - ncy) * cos + cy);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const from = (sy * w + sx) * 4, to = (y * newW + x) * 4;
      out.data[to] = src.data[from]; out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2]; out.data[to + 3] = src.data[from + 3];
    }
  }
  return out;
}

/** Colour balance: shift shadows/midtones/highlights toward a colour. */
export function colorBalance(src: Raster, cyanRed = 0, magentaGreen = 0, yellowBlue = 0): Raster {
  const out = cloneRaster(src);
  for (let i = 0; i < out.data.length; i += 4) {
    const lum = (0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2]) / 255;
    const w = lum < 0.5 ? lum * 2 : (1 - lum) * 2; // weight by proximity to midtones
    out.data[i] = clamp255(Math.round(src.data[i] + cyanRed * w));
    out.data[i + 1] = clamp255(Math.round(src.data[i + 1] + magentaGreen * w));
    out.data[i + 2] = clamp255(Math.round(src.data[i + 2] + yellowBlue * w));
  }
  return out;
}

/** Non-destructive edit recipe: the original pixels are never mutated (MD-03 principle). */
export type EditRecipe = {
  crop?: { x: number; y: number; w: number; h: number };
  resize?: { width: number; height: number };
  rotate?: number;
  rotateArbitrary?: number; // radians
  flip?: "horizontal" | "vertical" | null;
  adjust?: Adjustments;
  blur?: number;
  sharpen?: number;
  equalize?: boolean;
  sepia?: boolean;
  threshold?: number | null;
  posterize?: number | null;
  vignette?: number | null;
  noise?: number | null;
  edges?: boolean;
  pixelate?: number | null;
  duotone?: { dark: [number, number, number]; light: [number, number, number] } | null;
  hueShift?: number | null;
  levels?: { black: number; white: number; gamma: number } | null;
  curves?: number[] | null;
  motionBlur?: { length: number; angle: number } | null;
  oilPaint?: { radius: number; levels: number } | null;
  frame?: { thickness: number; color: [number, number, number] } | null;
  colorBalance?: { cyanRed: number; magentaGreen: number; yellowBlue: number } | null;
};
export function applyRecipe(src: Raster, recipe: EditRecipe): Raster {
  let out = cloneRaster(src);
  if (recipe.crop) out = crop(out, recipe.crop.x, recipe.crop.y, recipe.crop.w, recipe.crop.h);
  if (recipe.resize) out = resize(out, recipe.resize.width, recipe.resize.height);
  if (recipe.rotate) out = rotate90(out, recipe.rotate);
  if (recipe.flip) out = flip(out, recipe.flip);
  if (recipe.adjust) out = adjust(out, recipe.adjust);
  if (recipe.blur) out = blur(out, recipe.blur);
  if (recipe.sharpen) out = sharpen(out, recipe.sharpen);
  if (recipe.equalize) out = equalize(out);
  if (recipe.sepia) out = sepia(out);
  if (recipe.threshold != null) out = threshold(out, recipe.threshold);
  if (recipe.posterize != null) out = posterize(out, recipe.posterize);
  if (recipe.vignette != null) out = vignette(out, recipe.vignette);
  if (recipe.noise != null) out = addNoise(out, recipe.noise);
  if (recipe.edges) out = edgeDetect(out);
  if (recipe.pixelate != null) out = pixelate(out, recipe.pixelate);
  if (recipe.duotone) out = duotone(out, recipe.duotone.dark, recipe.duotone.light);
  if (recipe.hueShift != null) out = hueShift(out, recipe.hueShift);
  if (recipe.levels) out = levels(out, recipe.levels.black, recipe.levels.white, recipe.levels.gamma);
  if (recipe.curves) out = curves(out, recipe.curves);
  if (recipe.motionBlur) out = motionBlur(out, recipe.motionBlur.length, recipe.motionBlur.angle);
  if (recipe.oilPaint) out = oilPaint(out, recipe.oilPaint.radius, recipe.oilPaint.levels);
  if (recipe.frame) out = frame(out, recipe.frame.thickness, recipe.frame.color);
  if (recipe.colorBalance) out = colorBalance(out, recipe.colorBalance.cyanRed, recipe.colorBalance.magentaGreen, recipe.colorBalance.yellowBlue);
  if (recipe.rotateArbitrary != null) out = rotate(out, recipe.rotateArbitrary);
  return out;
}
