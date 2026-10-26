/**
 * FF-30 painting + selection engine (TT16, first-party). Pure; mutates only buffers passed in.
 *
 * Brush model: round dabs stamped along a stroke every `spacing × size` px (Photoshop's default spacing is 25 %).
 * Dab profile: 1 inside `hardness × r`, smoothstep fall-off to 0 at r; hard brushes get 1-px analytic
 * anti-aliasing. Per-dab alpha = flow × profile × selection. Paint = straight-alpha source-over; erase multiplies
 * destination alpha by (1 − a); mask-paint lerps the mask toward 0/255.
 * Declared simplification vs Photoshop: there is no separate per-stroke "opacity" cap (overlapping dabs inside one
 * stroke accumulate, i.e. Photoshop's Flow behaviour, with Opacity = 100 %), and no pressure input.
 */
import { clipRect, type ImageDoc, type Layer, type Rect } from "./doc";

export type RGB = [number, number, number];
export interface Selection { width: number; height: number; mask: Uint8ClampedArray; bounds: Rect }
export interface BrushOpts { size: number; hardness: number; flow: number; color: RGB; mode: "paint" | "erase" | "mask-hide" | "mask-reveal"; spacing?: number }

/* --------------------------------------------------------------- selections (canvas-sized masks) */
function boundsOf(mask: Uint8ClampedArray, w: number, h: number): Rect {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
export function selectRect(doc: ImageDoc, r: Rect): Selection {
  const mask = new Uint8ClampedArray(doc.width * doc.height);
  const c = clipRect(r, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (c) for (let y = c.y; y < c.y + c.h; y++) mask.fill(255, y * doc.width + c.x, y * doc.width + c.x + c.w);
  return { width: doc.width, height: doc.height, mask, bounds: c ?? { x: 0, y: 0, w: 0, h: 0 } };
}
export const selectAll = (doc: ImageDoc) => selectRect(doc, { x: 0, y: 0, w: doc.width, h: doc.height });
/** Anti-aliased ellipse inscribed in r (coverage sampled 4×4 per pixel). */
export function selectEllipse(doc: ImageDoc, r: Rect): Selection {
  const mask = new Uint8ClampedArray(doc.width * doc.height);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = r.w / 2, ry = r.h / 2;
  const c = clipRect(r, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (c && rx > 0 && ry > 0) for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) {
    let hit = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + 0.5) / 4 - cx) / rx, py = (y + (sy + 0.5) / 4 - cy) / ry;
      if (px * px + py * py <= 1) hit++;
    }
    mask[y * doc.width + x] = Math.round(hit / 16 * 255);
  }
  return { width: doc.width, height: doc.height, mask, bounds: boundsOf(mask, doc.width, doc.height) };
}
export function invertSelection(sel: Selection): Selection {
  const mask = sel.mask.map((v) => 255 - v);
  return { ...sel, mask, bounds: boundsOf(mask, sel.width, sel.height) };
}
export function combineSelections(a: Selection, b: Selection, op: "add" | "subtract" | "intersect"): Selection {
  const mask = new Uint8ClampedArray(a.mask.length);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = op === "add" ? Math.max(a.mask[i], b.mask[i]) : op === "subtract" ? Math.max(0, a.mask[i] - b.mask[i]) : Math.min(a.mask[i], b.mask[i]);
  }
  return { ...a, mask, bounds: boundsOf(mask, a.width, a.height) };
}
export const selectionEmpty = (s: Selection | null) => !s || s.bounds.w === 0;

/* --------------------------------------------------------------- brush */
export function dabProfile(d: number, r: number, hardness: number): number {
  if (r <= 0.5) return d <= 0.5 ? 1 : 0;
  if (hardness >= 0.999) return Math.max(0, Math.min(1, r - d + 0.5)); // analytic AA edge
  const t = d / r;
  if (t >= 1) return 0;
  const h = Math.max(0, Math.min(0.999, hardness));
  if (t <= h) return 1;
  const u = (t - h) / (1 - h);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * Stamp one dab centred at canvas point (cx, cy) on `layer` (in place). Returns the dirty canvas rect.
 * Pixels outside the layer's bounds are not touched (callers grow the layer first if needed).
 */
export function dab(layer: Layer, cx: number, cy: number, o: BrushOpts, sel: Selection | null): Rect | null {
  const r = Math.max(0.5, o.size / 2);
  const box = clipRect({ x: Math.floor(cx - r - 1), y: Math.floor(cy - r - 1), w: Math.ceil(2 * r + 3), h: Math.ceil(2 * r + 3) }, { x: layer.x, y: layer.y, w: layer.w, h: layer.h });
  if (!box) return null;
  const target = o.mode === "mask-hide" || o.mode === "mask-reveal" ? layer.mask : layer.data;
  if (!target) return null;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    let a = dabProfile(d, r, o.hardness) * o.flow;
    if (a <= 0) continue;
    if (sel) { if (x < 0 || y < 0 || x >= sel.width || y >= sel.height) continue; a *= sel.mask[y * sel.width + x] / 255; if (a <= 0) continue; }
    const li = (y - layer.y) * layer.w + (x - layer.x);
    if (o.mode === "mask-hide" || o.mode === "mask-reveal") {
      const goal = o.mode === "mask-reveal" ? 255 : 0;
      target[li] = Math.round(target[li] + (goal - target[li]) * a);
      continue;
    }
    const p = li * 4;
    const da = layer.data[p + 3] / 255;
    if (o.mode === "erase") { layer.data[p + 3] = Math.round(da * (1 - a) * 255); continue; }
    const oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) layer.data[p + c] = Math.round((o.color[c] * a + layer.data[p + c] * da * (1 - a)) / oa);
    layer.data[p + 3] = Math.round(oa * 255);
  }
  return box;
}

/**
 * Stamp dabs from `from` to `to` (exclusive of `from` unless carry < 0), spacing in px = max(1, size × spacing).
 * `carry` is the distance already travelled since the last dab; returned so a polyline stroke stays evenly spaced.
 */
export function strokeSegment(layer: Layer, from: { x: number; y: number }, to: { x: number; y: number }, o: BrushOpts, carry: number, sel: Selection | null): { carry: number; dirty: Rect | null } {
  const step = Math.max(1, o.size * (o.spacing ?? 0.25));
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  let dirty: Rect | null = null;
  const add = (r: Rect | null) => { if (!r) return; dirty = dirty ? { x: Math.min(dirty.x, r.x), y: Math.min(dirty.y, r.y), w: Math.max(dirty.x + dirty.w, r.x + r.w) - Math.min(dirty.x, r.x), h: Math.max(dirty.y + dirty.h, r.y + r.h) - Math.min(dirty.y, r.y) } : r; };
  if (carry < 0) { add(dab(layer, from.x, from.y, o, sel)); carry = 0; }
  let t = step - carry;
  while (t <= len) {
    const f = len === 0 ? 0 : t / len;
    add(dab(layer, from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, o, sel));
    t += step;
  }
  return { carry: len - (t - step), dirty };
}

/* --------------------------------------------------------------- flood fill / magic wand */
const near = (d: Uint8ClampedArray, i: number, ref: number[], tol: number) =>
  Math.abs(d[i] - ref[0]) <= tol && Math.abs(d[i + 1] - ref[1]) <= tol && Math.abs(d[i + 2] - ref[2]) <= tol && Math.abs(d[i + 3] - ref[3]) <= tol;

/**
 * Region of an RGBA buffer (w×h) similar to the seed pixel: max per-channel |Δ| ≤ tolerance (RGBA).
 * Contiguous = 4-connected scanline flood; otherwise every matching pixel. Returns a 0/255 mask.
 */
export function regionMask(data: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tolerance: number, contiguous: boolean): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const s = (sy * w + sx) * 4;
  const ref = [data[s], data[s + 1], data[s + 2], data[s + 3]];
  if (!contiguous) { for (let i = 0; i < w * h; i++) if (near(data, i * 4, ref, tolerance)) mask[i] = 255; return mask; }
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    let x = x0;
    while (x >= 0 && !mask[y * w + x] && near(data, (y * w + x) * 4, ref, tolerance)) x--;
    x++;
    let up = false, down = false;
    while (x < w && !mask[y * w + x] && near(data, (y * w + x) * 4, ref, tolerance)) {
      mask[y * w + x] = 255;
      if (y > 0) { const m = !mask[(y - 1) * w + x] && near(data, ((y - 1) * w + x) * 4, ref, tolerance); if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false; }
      if (y < h - 1) { const m = !mask[(y + 1) * w + x] && near(data, ((y + 1) * w + x) * 4, ref, tolerance); if (m && !down) { stack.push(x, y + 1); down = true; } else if (!m) down = false; }
      x++;
    }
  }
  return mask;
}

/** Paint-bucket on a layer at canvas point; samples the layer itself (Photoshop default "Sample: Current Layer"). */
export function floodFill(layer: Layer, cx: number, cy: number, color: RGB, opts: { tolerance: number; contiguous: boolean; opacity?: number }, sel: Selection | null): Rect | null {
  const lx = Math.floor(cx) - layer.x, ly = Math.floor(cy) - layer.y;
  if (lx < 0 || ly < 0 || lx >= layer.w || ly >= layer.h) return null;
  const region = regionMask(layer.data, layer.w, layer.h, lx, ly, opts.tolerance, opts.contiguous);
  return paintMask(layer, region, color, opts.opacity ?? 1, sel);
}

/** Source-over `color` through a layer-local 0..255 mask (× selection). */
export function paintMask(layer: Layer, region: Uint8ClampedArray, color: RGB, opacity: number, sel: Selection | null): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
    const li = y * layer.w + x;
    let a = region[li] / 255 * opacity;
    if (a <= 0) continue;
    if (sel) { const X = x + layer.x, Y = y + layer.y; if (X < 0 || Y < 0 || X >= sel.width || Y >= sel.height) continue; a *= sel.mask[Y * sel.width + X] / 255; if (a <= 0) continue; }
    const p = li * 4, da = layer.data[p + 3] / 255, oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) layer.data[p + c] = Math.round((color[c] * a + layer.data[p + c] * da * (1 - a)) / oa);
    layer.data[p + 3] = Math.round(oa * 255);
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0 + layer.x, y: y0 + layer.y, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Magic wand on an RGBA canvas-sized buffer (usually the composite: "sample all layers"). */
export function magicWand(rgba: Uint8ClampedArray, doc: ImageDoc, x: number, y: number, tolerance: number, contiguous: boolean): Selection {
  const mask = regionMask(rgba, doc.width, doc.height, Math.floor(x), Math.floor(y), tolerance, contiguous);
  return { width: doc.width, height: doc.height, mask, bounds: boundsOf(mask, doc.width, doc.height) };
}

/** Clear (Delete) pixels of a layer inside the selection; partial selection values erase partially. */
export function clearSelection(layer: Layer, sel: Selection): void {
  for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
    const X = x + layer.x, Y = y + layer.y;
    if (X < 0 || Y < 0 || X >= sel.width || Y >= sel.height) continue;
    const s = sel.mask[Y * sel.width + X];
    if (!s) continue;
    const p = (y * layer.w + x) * 4 + 3;
    layer.data[p] = Math.round(layer.data[p] * (1 - s / 255));
  }
}

/** "Layer via Copy": pixels of `layer` under the selection, cropped to the selection bounds. */
export function copySelection(layer: Layer, sel: Selection): { x: number; y: number; w: number; h: number; data: Uint8ClampedArray } | null {
  const b = sel.bounds;
  if (!b.w) return null;
  const data = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    const X = b.x + x, Y = b.y + y, lx = X - layer.x, ly = Y - layer.y;
    if (lx < 0 || ly < 0 || lx >= layer.w || ly >= layer.h) continue;
    const s = (ly * layer.w + lx) * 4, o = (y * b.w + x) * 4;
    data[o] = layer.data[s]; data[o + 1] = layer.data[s + 1]; data[o + 2] = layer.data[s + 2];
    data[o + 3] = Math.round(layer.data[s + 3] * sel.mask[Y * sel.width + X] / 255);
  }
  return { ...b, data };
}

/* --------------------------------------------------------------- gradient */
/** Linear gradient from p0 (colour a) to p1 (colour b), RGBA endpoints, source-over into the layer (× selection). */
export function linearGradient(layer: Layer, p0: { x: number; y: number }, p1: { x: number; y: number }, a: [number, number, number, number], b: [number, number, number, number], sel: Selection | null): Rect {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, L2 = dx * dx + dy * dy || 1;
  for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
    const X = x + layer.x, Y = y + layer.y;
    let s = 1;
    if (sel) { if (X < 0 || Y < 0 || X >= sel.width || Y >= sel.height) continue; s = sel.mask[Y * sel.width + X] / 255; if (!s) continue; }
    const t = Math.max(0, Math.min(1, ((X + 0.5 - p0.x) * dx + (Y + 0.5 - p0.y) * dy) / L2));
    const ga = (a[3] + (b[3] - a[3]) * t) / 255 * s;
    if (ga <= 0) continue;
    const p = (y * layer.w + x) * 4, da = layer.data[p + 3] / 255, oa = ga + da * (1 - ga);
    for (let c = 0; c < 3; c++) {
      const gc = a[c] + (b[c] - a[c]) * t;
      layer.data[p + c] = Math.round((gc * ga + layer.data[p + c] * da * (1 - ga)) / oa);
    }
    layer.data[p + 3] = Math.round(oa * 255);
  }
  return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
}

/* --------------------------------------------------------------- sampling */
/** Eyedropper: average of an n×n block (n = 1, 3, 5) of an RGBA buffer, clamped to the image. */
export function sampleAverage(rgba: Uint8ClampedArray, w: number, h: number, x: number, y: number, n = 1): [number, number, number, number] {
  const r = Math.floor(n / 2);
  const acc = [0, 0, 0, 0]; let count = 0;
  for (let yy = Math.max(0, Math.floor(y) - r); yy <= Math.min(h - 1, Math.floor(y) + r); yy++)
    for (let xx = Math.max(0, Math.floor(x) - r); xx <= Math.min(w - 1, Math.floor(x) + r); xx++) {
      const i = (yy * w + xx) * 4;
      for (let c = 0; c < 4; c++) acc[c] += rgba[i + c];
      count++;
    }
  return count ? (acc.map((v) => Math.round(v / count)) as [number, number, number, number]) : [0, 0, 0, 0];
}
