/**
 * FF-30 layered raster document — first-party (TT16). Pure TypeScript, no DOM; runs in Node and the browser.
 *
 * Colour contract: straight-alpha sRGB RGBA8 per layer; compositing in float, quantised once at output.
 * Formula: W3C Compositing and Blending Level 1 §5.2 general formula with source-over:
 *     Cs' = (1 − αb)·Cs + αb·B(Cb, Cs)
 *     co  = αs·Cs' + αb·Cb·(1 − αs)        (premultiplied)
 *     αo  = αs + αb·(1 − αs)
 * with the 12 SEPARABLE blend functions B of §9.1 (normal … exclusion). Non-separable modes (hue, saturation,
 * color, luminosity) are not implemented. αs = pixelAlpha × layer opacity × mask/255.
 * Storage order is BOTTOM → TOP. Layers have an integer offset (x, y) and their own size (may exceed the canvas,
 * like Photoshop's "big data" outside the canvas, so cropping is non-destructive to layer pixels).
 *
 * Verified against TWO independent implementations: Chromium/Skia canvas globalCompositeOperation
 * (scripts/e2e-image.mts) and psd-tools' numpy compositor (scripts/oracle-psd.mts).
 */

export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion",
  // TT78: the four non-separable modes (W3C Compositing §10.2 / PDF 32000 §11.3.5.3) — same names as canvas uses
  "hue", "saturation", "color", "luminosity",
  // TT78: Photoshop-only modes (no canvas equivalent) — formulas and edge cases as Photoshop / psd-tools define them
  "linear-burn", "linear-dodge", "vivid-light", "linear-light", "pin-light", "hard-mix", "subtract", "divide",
  "darker-color", "lighter-color",
] as const;
/** the modes canvas' globalCompositeOperation also implements (the Skia oracle covers exactly these) */
export const CANVAS_BLENDS = BLEND_MODES.slice(0, 16);
export type BlendMode = (typeof BLEND_MODES)[number];
export const NONSEPARABLE = ["hue", "saturation", "color", "luminosity", "darker-color", "lighter-color"] as const;
export type NonSeparableBlend = (typeof NONSEPARABLE)[number];
export type SeparableBlend = Exclude<BlendMode, NonSeparableBlend>;
export const isNonSeparable = (m: BlendMode): m is NonSeparableBlend => (NONSEPARABLE as readonly string[]).includes(m);

export interface Layer {
  id: string;
  name: string;
  x: number; y: number;          // integer offset of the layer's top-left in canvas pixels
  w: number; h: number;
  data: Uint8ClampedArray;       // w*h*4 straight RGBA
  opacity: number;               // 0..1
  visible: boolean;
  blend: BlendMode;
  locked?: boolean;              // "lock all": paint / filters refuse
  mask?: Uint8ClampedArray;      // w*h, 255 = reveal (same geometry as the layer)
  maskEnabled?: boolean;         // default true when a mask exists
  /** TT78 clipping mask (PSD "clipping" byte): this layer paints only where the nearest non-clipped layer below
   *  (its base) has coverage, and blends onto the BASE's colour rather than onto what lies under the base. */
  clip?: boolean;
  /** TT78 layer groups (PSD folders), outermost first. Layers that are adjacent in the stack and share a group id
   *  form that group; the group composites as pass-through or isolated with its own opacity / blend / visibility. */
  groups?: LayerGroup[];
}
export interface LayerGroup { id: string; name: string; opacity: number; blend: BlendMode | "pass-through"; visible: boolean; open?: boolean }
export const MAX_GROUP_DEPTH = 16;
export interface ImageDoc { width: number; height: number; layers: Layer[] }
export interface Rect { x: number; y: number; w: number; h: number }

export const LIMITS = { canvasPixels: 36_000_000, layerPixels: 64_000_000, layers: 64 };

/* --------------------------------------------------------------- blend functions (W3C §9.1) */
type BlendFn = (cb: number, cs: number) => number;
const multiply: BlendFn = (b, s) => b * s;
const screen: BlendFn = (b, s) => b + s - b * s;
const hardLight: BlendFn = (b, s) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1));
export const BLEND_FN: Record<SeparableBlend, BlendFn> = {
  normal: (_b, s) => s,
  multiply,
  screen,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  "color-dodge": (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  "color-burn": (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  "hard-light": hardLight,
  "soft-light": (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  "linear-burn": (b, s) => Math.max(0, b + s - 1),
  "linear-dodge": (b, s) => Math.min(1, b + s),
  // the SOURCE extreme wins inside vivid light (Cs 0 → 0, Cs 1 → 1), unlike plain colour burn / dodge
  "vivid-light": (b, s) => (s <= 0 ? 0 : s >= 1 ? 1 : s <= 0.5 ? 1 - Math.min(1, (1 - b) / (2 * s)) : Math.min(1, b / (2 * (1 - s)))),
  "linear-light": (b, s) => (s > 0.5 ? Math.min(1, b + 2 * s - 1) : Math.max(0, b + 2 * s - 1)),
  "pin-light": (b, s) => (s > 0.5 ? Math.max(b, 2 * s - 1) : Math.min(b, 2 * s)),
  "hard-mix": (b, s) => (b + s > 1 || (b + s === 1 && b > 0.5) ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s)),
};

/* Non-separable blends (W3C Compositing §10.2; the PDF reference's Lum/ClipColor/SetLum/Sat/SetSat). They take whole
   RGB triples. Written to the spec text; psd-tools and Skia are the external checks (scripts/oracle-psd.mts,
   scripts/e2e-image.mts). */
type RGB = [number, number, number];
const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c: RGB): RGB {
  const l = lum(c), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  const o: RGB = [c[0], c[1], c[2]];
  for (let k = 0; k < 3; k++) {
    if (n < 0) o[k] = l + (o[k] - l) * l / (l - n);
    if (x > 1) o[k] = l + (o[k] - l) * (1 - l) / (x - l);
    o[k] = Math.min(1, Math.max(0, o[k]));
  }
  return o;
}
const setLum = (c: RGB, l: number): RGB => { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]); };
const sat = (c: RGB) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: RGB, s: number): RGB {
  const i = [0, 1, 2].sort((a, b) => c[a] - c[b]); const [mn, md, mx] = i; const o: RGB = [0, 0, 0];
  if (c[mx] > c[mn]) { o[md] = (c[md] - c[mn]) * s / (c[mx] - c[mn]); o[mx] = s; }
  return o;
}
export const NONSEP_FN: Record<NonSeparableBlend, (cb: RGB, cs: RGB) => RGB> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
  "darker-color": (b, s) => (lum(s) < lum(b) ? [s[0], s[1], s[2]] : [b[0], b[1], b[2]]),
  "lighter-color": (b, s) => (lum(s) > lum(b) ? [s[0], s[1], s[2]] : [b[0], b[1], b[2]]),
};

/* --------------------------------------------------------------- construction + validation */
let seq = 0;
export const newId = (prefix = "L") => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function guardSize(w: number, h: number, limit = LIMITS.canvasPixels) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`invalid size ${w}×${h}`);
  if (w * h > limit) throw new Error(`${w}×${h} exceeds the ${Math.round(limit / 1e6)} MP guard`);
}

export function makeLayer(name: string, w: number, h: number, fill?: [number, number, number, number], id = newId()): Layer {
  guardSize(w, h, LIMITS.layerPixels);
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill && fill[3] > 0) for (let i = 0; i < data.length; i += 4) { data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3]; }
  return { id, name, x: 0, y: 0, w, h, data, opacity: 1, visible: true, blend: "normal" };
}

export function newDoc(width: number, height: number, background: [number, number, number, number] | null = [255, 255, 255, 255]): ImageDoc {
  guardSize(width, height);
  return { width, height, layers: [makeLayer(background ? "Background" : "Layer 1", width, height, background ?? undefined)] };
}

export function validateDoc(doc: ImageDoc): void {
  guardSize(doc.width, doc.height);
  if (doc.layers.length > LIMITS.layers) throw new Error(`at most ${LIMITS.layers} layers`);
  const ids = new Set<string>();
  for (const l of doc.layers) {
    if (!l.id || ids.has(l.id)) throw new Error("layer ids must be unique");
    ids.add(l.id);
    guardSize(l.w, l.h, LIMITS.layerPixels);
    if (l.data.length !== l.w * l.h * 4) throw new Error(`layer ${l.name}: pixel buffer length mismatch`);
    if (l.mask && l.mask.length !== l.w * l.h) throw new Error(`layer ${l.name}: mask length mismatch`);
    if (!Number.isInteger(l.x) || !Number.isInteger(l.y)) throw new Error(`layer ${l.name}: offset must be integral`);
    if (!(l.opacity >= 0 && l.opacity <= 1)) throw new Error(`layer ${l.name}: opacity out of range`);
    if (!(BLEND_MODES as readonly string[]).includes(l.blend)) throw new Error(`layer ${l.name}: unknown blend ${l.blend}`);
    if (l.groups) {
      if (l.groups.length > MAX_GROUP_DEPTH) throw new Error(`layer ${l.name}: groups nested deeper than ${MAX_GROUP_DEPTH}`);
      for (const g of l.groups) {
        if (!g.id || !(g.opacity >= 0 && g.opacity <= 1)) throw new Error(`layer ${l.name}: invalid group`);
        if (g.blend !== "pass-through" && !(BLEND_MODES as readonly string[]).includes(g.blend)) throw new Error(`group ${g.name}: unknown blend ${g.blend}`);
      }
    }
  }
}

/* --------------------------------------------------------------- compositing */
/**
 * Composite `rect` of the canvas (default: whole canvas) into a straight-alpha RGBA8 buffer of rect size.
 * `skip` lets the UI hide a layer during e.g. a floating move without copying the doc.
 */
export function compositeRegion(doc: ImageDoc, rect: Rect = { x: 0, y: 0, w: doc.width, h: doc.height }, opts: { skip?: string } = {}): Uint8ClampedArray {
  const r = clipRect(rect, { x: 0, y: 0, w: doc.width, h: doc.height });
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  if (!r) return out;
  const acc = new Float32Array(r.w * r.h * 4); // premultiplied rgb + alpha, 0..1
  const cb: RGB = [0, 0, 0], cs: RGB = [0, 0, 0];
  const live = (l: Layer) => l.visible && l.opacity > 0 && l.id !== opts.skip;
  /** blend straight colour (sr, sg, sb) at alpha `as` over the premultiplied pixel A[d..d+3] with mode `m`, in place.
   *  Allocation-free for normal and the separable modes (this runs per pixel on up to 36 MP). */
  /** the blend function of a mode, resolved once per layer (not per pixel): null = normal */
  type Bf = { sep: BlendFn | null; non: ((b: RGB, s: RGB) => RGB) | null } | null;
  const bfOf = (m: BlendMode): Bf => (m === "normal" ? null : isNonSeparable(m) ? { sep: null, non: NONSEP_FN[m] } : { sep: BLEND_FN[m], non: null });
  const over = (A: Float32Array, d: number, sr: number, sg: number, sb: number, as: number, bf: Bf) => {
    const ab = A[d + 3];
    let mr = sr, mg = sg, mb = sb;
    if (bf && ab > 0) {
      const br = A[d] / ab, bg = A[d + 1] / ab, bb = A[d + 2] / ab;
      let fr: number, fg: number, fb: number;
      if (bf.non) { cb[0] = br; cb[1] = bg; cb[2] = bb; cs[0] = sr; cs[1] = sg; cs[2] = sb; [fr, fg, fb] = bf.non(cb, cs); }
      else { const fn = bf.sep!; fr = fn(br, sr); fg = fn(bg, sg); fb = fn(bb, sb); }
      mr = (1 - ab) * sr + ab * fr; mg = (1 - ab) * sg + ab * fg; mb = (1 - ab) * sb + ab * fb;
    }
    A[d] = as * mr + A[d] * (1 - as); A[d + 1] = as * mg + A[d + 1] * (1 - as); A[d + 2] = as * mb + A[d + 2] * (1 - as);
    A[d + 3] = as + ab * (1 - as);
  };
  const alphaAt = (l: Layer, li: number) => {
    let a = l.data[li * 4 + 3] / 255;
    if (l.mask && l.maskEnabled !== false) a *= l.mask[li] / 255;
    return a;
  };
  const N = r.w * r.h * 4;
  /** paint the run `L` (all sharing the same groups above `depth`) into the premultiplied buffer A */
  const paint = (L: Layer[], depth: number, A: Float32Array) => {
    for (let i = 0; i < L.length; ) {
      const g = L[i].groups?.[depth];
      if (g) {
        let j = i + 1; while (j < L.length && L[j].groups?.[depth]?.id === g.id) j++;
        const run = L.slice(i, j); i = j;
        if (!g.visible || g.opacity <= 0) continue;
        if (g.blend === "pass-through") {
          // children composite onto the backdrop itself; group opacity interpolates backdrop → result
          const B = A.slice(); paint(run, depth + 1, B);
          const o = g.opacity; for (let k = 0; k < N; k++) A[k] += (B[k] - A[k]) * o;
        } else {
          // isolated: children on transparent, then the group as one layer with its blend and opacity
          const T = new Float32Array(N); paint(run, depth + 1, T); const gbf = bfOf(g.blend);
          for (let k = 0; k < N; k += 4) { const ta = T[k + 3]; if (ta > 0) over(A, k, T[k] / ta, T[k + 1] / ta, T[k + 2] / ta, ta * g.opacity, gbf); }
        }
        continue;
      }
      let j = i + 1; while (j < L.length && !L[j].groups?.[depth]) j++;
      paintLayers(L.slice(i, j), A); i = j;
    }
  };
  const paintLayers = (L: Layer[], acc: Float32Array) => {
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      // a clipped layer is painted by its base (below); a clipped layer with no base at all paints as an ordinary one
      if (l.clip && L.slice(0, i).some((b) => !b.clip)) continue;
      let j = i + 1; while (j < L.length && L[j].clip) j++;
      const clips = l.clip ? [] : L.slice(i + 1, j).filter(live); const lbf = bfOf(l.blend), cbf = clips.map((k) => bfOf(k.blend));
      if (!live(l)) continue; // a hidden base hides its whole clipping group (Photoshop)
      const ov = clipRect(r, { x: l.x, y: l.y, w: l.w, h: l.h });
      if (!ov) continue;
      const sub = new Float32Array(4);
      const data = l.data, op = l.opacity, lw = l.w, lx = l.x, mask = l.mask && l.maskEnabled !== false ? l.mask : null, nClip = clips.length;
      for (let y = ov.y; y < ov.y + ov.h; y++) {
        const ly = y - l.y; const row = ((y - r.y) * r.w - r.x) * 4;
        for (let x = ov.x; x < ov.x + ov.w; x++) {
          const li = ly * lw + (x - lx);
          const so = li * 4;
          const a0 = data[so + 3] / 255; // the base's own pixel coverage (before its mask and opacity)
          let as = a0 * op;
          if (mask) as *= mask[li] / 255;
          if (as <= 0) continue;
          let pr = data[so] / 255, pg = data[so + 1] / 255, pb = data[so + 2] / 255;
          if (nClip) {
            // clipped layers composite onto the base's colour, seeded with the base's coverage (psd-tools' model:
            // Compositor seeded with (colour, alpha) of the base; the base keeps its own coverage afterwards)
            sub[0] = pr * a0; sub[1] = pg * a0; sub[2] = pb * a0; sub[3] = a0;
            for (let ci = 0; ci < clips.length; ci++) { const k = clips[ci];
              const kx = x - k.x, ky = y - k.y;
              if (kx < 0 || ky < 0 || kx >= k.w || ky >= k.h) continue;
              const ki = ky * k.w + kx; const ka = alphaAt(k, ki) * k.opacity;
              if (ka <= 0) continue;
              over(sub, 0, k.data[ki * 4] / 255, k.data[ki * 4 + 1] / 255, k.data[ki * 4 + 2] / 255, ka, cbf[ci]);
            }
            if (sub[3] > 0) { pr = sub[0] / sub[3]; pg = sub[1] / sub[3]; pb = sub[2] / sub[3]; }
          }
          const d = row + x * 4;
          if (lbf && acc[d + 3] > 0) over(acc, d, pr, pg, pb, as, lbf);
          else { const ia = 1 - as; acc[d] = as * pr + acc[d] * ia; acc[d + 1] = as * pg + acc[d + 1] * ia; acc[d + 2] = as * pb + acc[d + 2] * ia; acc[d + 3] = as + acc[d + 3] * ia; } // normal: inline fast path
        }
      }
    }
  };
  paint(doc.layers, 0, acc);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const s = (y * r.w + x) * 4;
    const o = ((y + r.y - rect.y) * rect.w + (x + r.x - rect.x)) * 4;
    const a = acc[s + 3];
    if (a <= 0) continue;
    out[o] = Math.round(acc[s] / a * 255); out[o + 1] = Math.round(acc[s + 1] / a * 255); out[o + 2] = Math.round(acc[s + 2] / a * 255);
    out[o + 3] = Math.round(a * 255);
  }
  return out;
}
export const composite = (doc: ImageDoc) => compositeRegion(doc);

/** Composite onto an opaque colour (for JPEG export / eyedropper "sample merged" over the checkerboard). */
export function flattenOnto(rgba: Uint8ClampedArray, bg: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(rgba[i + c] * a + bg[c] * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/* --------------------------------------------------------------- geometry helpers */
export function clipRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.floor(Math.min(x0, x1)), y = Math.floor(Math.min(y0, y1));
  return { x, y, w: Math.max(1, Math.ceil(Math.max(x0, x1)) - x), h: Math.max(1, Math.ceil(Math.max(y0, y1)) - y) };
}

/* --------------------------------------------------------------- structural operations (immutable doc, shared buffers) */
const replace = (doc: ImageDoc, id: string, f: (l: Layer) => Layer): ImageDoc =>
  ({ ...doc, layers: doc.layers.map((l) => (l.id === id ? f(l) : l)) });

export function patchLayer(doc: ImageDoc, id: string, patch: Partial<Omit<Layer, "id">>): ImageDoc {
  const next = replace(doc, id, (l) => ({ ...l, ...patch }));
  validateDoc(next);
  return next;
}

export function addLayer(doc: ImageDoc, layer: Layer, aboveId?: string): ImageDoc {
  if (doc.layers.length >= LIMITS.layers) throw new Error(`at most ${LIMITS.layers} layers`);
  const i = aboveId ? doc.layers.findIndex((l) => l.id === aboveId) : doc.layers.length - 1;
  const layers = [...doc.layers];
  layers.splice(i + 1, 0, layer);
  return { ...doc, layers };
}

export function removeLayer(doc: ImageDoc, id: string): ImageDoc {
  if (doc.layers.length <= 1) throw new Error("a document keeps at least one layer");
  return { ...doc, layers: doc.layers.filter((l) => l.id !== id) };
}

export function duplicateLayer(doc: ImageDoc, id: string): { doc: ImageDoc; id: string } {
  const src = doc.layers.find((l) => l.id === id);
  if (!src) throw new Error("no such layer");
  const copy: Layer = { ...src, id: newId(), name: `${src.name} copy`, data: new Uint8ClampedArray(src.data), mask: src.mask ? new Uint8ClampedArray(src.mask) : undefined };
  return { doc: addLayer(doc, copy, id), id: copy.id };
}

/** direction +1 = up (towards the top of the stack). */
export function reorderLayer(doc: ImageDoc, id: string, direction: 1 | -1): ImageDoc {
  const layers = [...doc.layers];
  const i = layers.findIndex((l) => l.id === id), j = i + direction;
  if (i < 0 || j < 0 || j >= layers.length) return doc;
  [layers[i], layers[j]] = [layers[j], layers[i]];
  return { ...doc, layers };
}

/** Render a sub-stack (bottom→top) into a new normal layer covering `bounds`. */
function renderStack(doc: ImageDoc, layers: Layer[], bounds: Rect, name: string): Layer {
  const tmp: ImageDoc = { width: bounds.x + bounds.w, height: bounds.y + bounds.h, layers: layers.map((l) => ({ ...l, x: l.x, y: l.y })) };
  // compositeRegion clips to the canvas; shift so the bounds start at ≥ 0.
  const dx = -Math.min(0, bounds.x), dy = -Math.min(0, bounds.y);
  tmp.width += dx; tmp.height += dy;
  tmp.layers = tmp.layers.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
  const data = compositeRegion(tmp, { x: bounds.x + dx, y: bounds.y + dy, w: bounds.w, h: bounds.h });
  return { id: newId(), name, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h, data, opacity: 1, visible: true, blend: "normal" };
}

/** Merge `id` into the visible layer below it (Photoshop "Merge Down"); result keeps the lower layer's name. */
export function mergeDown(doc: ImageDoc, id: string): ImageDoc {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i <= 0) throw new Error("nothing below to merge into");
  const lower = doc.layers[i - 1], upper = doc.layers[i];
  const bounds = unionRect({ x: lower.x, y: lower.y, w: lower.w, h: lower.h }, { x: upper.x, y: upper.y, w: upper.w, h: upper.h })!;
  // The lower layer's own opacity/blend must still apply to the merged result relative to what is under it,
  // so render lower at full opacity/normal, then upper with its settings, and carry lower's settings.
  const merged = renderStack(doc, [{ ...lower, opacity: 1, blend: "normal", visible: true }, upper], bounds, lower.name);
  merged.id = lower.id; merged.opacity = lower.opacity; merged.blend = lower.blend; merged.visible = lower.visible; if (lower.clip) merged.clip = true;
  const layers = [...doc.layers];
  layers.splice(i - 1, 2, merged);
  return { ...doc, layers };
}

/**
 * Merge Down preserves the picture only when the lower layer is normal/100 %/unmasked AND (the upper layer is normal
 * or the lower layer is opaque wherever the upper layer has pixels): otherwise the upper layer's blend was computed
 * against layers further down, which merging replaces by the lower layer alone (Photoshop behaves the same way).
 * The UI uses this to warn before merging.
 */
export function mergeChangesAppearance(doc: ImageDoc, id: string): boolean {
  const i = doc.layers.findIndex((l) => l.id === id);
  if (i <= 0) return false;
  const lower = doc.layers[i - 1], upper = doc.layers[i];
  if (!lower.visible || lower.blend !== "normal" || lower.opacity < 1 || (lower.mask && lower.maskEnabled !== false)) return true;
  if (lower.clip || doc.layers.slice(i + 1).some((l, k, a) => l.clip && a.slice(0, k).every((m) => m.clip))) return true; // clipping groups: conservative
  if (upper.blend === "normal") return false;
  for (let y = 0; y < upper.h; y++) for (let x = 0; x < upper.w; x++) {
    if (!upper.data[(y * upper.w + x) * 4 + 3]) continue;
    const X = x + upper.x, Y = y + upper.y;
    if (X < 0 || Y < 0 || X >= doc.width || Y >= doc.height) continue;
    const lx = X - lower.x, ly = Y - lower.y;
    if (lx < 0 || ly < 0 || lx >= lower.w || ly >= lower.h || lower.data[(ly * lower.w + lx) * 4 + 3] < 255) return true;
  }
  return false;
}

/** Flatten all visible layers into one canvas-sized layer (hidden layers are discarded, as in Photoshop). */
export function flatten(doc: ImageDoc): ImageDoc {
  const data = compositeRegion(doc);
  return { ...doc, layers: [{ id: newId(), name: "Background", x: 0, y: 0, w: doc.width, h: doc.height, data, opacity: 1, visible: true, blend: "normal" }] };
}

/** Canvas crop: only the canvas window moves; layer pixels are kept (offsets shift). */
export function cropCanvas(doc: ImageDoc, r: Rect): ImageDoc {
  const c = clipRect(r, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (!c) throw new Error("crop rectangle is outside the canvas");
  return { width: c.w, height: c.h, layers: doc.layers.map((l) => ({ ...l, x: l.x - c.x, y: l.y - c.y })) };
}

/** Resize canvas with an anchor (0..1 in each axis); layer pixels untouched. */
export function resizeCanvas(doc: ImageDoc, w: number, h: number, ax = 0.5, ay = 0.5): ImageDoc {
  guardSize(w, h);
  const dx = Math.round((w - doc.width) * ax), dy = Math.round((h - doc.height) * ay);
  return { width: w, height: h, layers: doc.layers.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })) };
}

function mapPixels(l: Layer, nw: number, nh: number, src: (x: number, y: number) => number): Layer {
  const data = new Uint8ClampedArray(nw * nh * 4);
  const mask = l.mask ? new Uint8ClampedArray(nw * nh) : undefined;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const si = src(x, y), o = y * nw + x;
    data[o * 4] = l.data[si * 4]; data[o * 4 + 1] = l.data[si * 4 + 1]; data[o * 4 + 2] = l.data[si * 4 + 2]; data[o * 4 + 3] = l.data[si * 4 + 3];
    if (mask && l.mask) mask[o] = l.mask[si];
  }
  return { ...l, w: nw, h: nh, data, mask };
}

/** Whole-image rotate by quarter turns (clockwise), layers + offsets + canvas, lossless. */
export function rotateDoc(doc: ImageDoc, turns: number): ImageDoc {
  const t = ((Math.round(turns) % 4) + 4) % 4;
  if (t === 0) return doc;
  const W = doc.width, H = doc.height;
  const layers = doc.layers.map((l) => {
    if (t === 2) return { ...mapPixels(l, l.w, l.h, (x, y) => (l.h - 1 - y) * l.w + (l.w - 1 - x)), x: W - l.x - l.w, y: H - l.y - l.h };
    if (t === 1) return { ...mapPixels(l, l.h, l.w, (x, y) => (l.h - 1 - x) * l.w + y), x: H - l.y - l.h, y: l.x };
    return { ...mapPixels(l, l.h, l.w, (x, y) => x * l.w + (l.w - 1 - y)), x: l.y, y: W - l.x - l.w };
  });
  return { width: t === 2 ? W : H, height: t === 2 ? H : W, layers };
}

export function flipDoc(doc: ImageDoc, axis: "horizontal" | "vertical", onlyId?: string): ImageDoc {
  const W = doc.width, H = doc.height;
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (onlyId && l.id !== onlyId) return l;
      const f = axis === "horizontal"
        ? mapPixels(l, l.w, l.h, (x, y) => y * l.w + (l.w - 1 - x))
        : mapPixels(l, l.w, l.h, (x, y) => (l.h - 1 - y) * l.w + x);
      // whole-image flip mirrors offsets across the canvas; a single-layer flip mirrors in place.
      if (onlyId) return f;
      return axis === "horizontal" ? { ...f, x: W - l.x - l.w } : { ...f, y: H - l.y - l.h };
    }),
  };
}

/** Bilinear image resize (all layers scaled about the origin; offsets scaled). */
export function resizeImage(doc: ImageDoc, w: number, h: number): ImageDoc {
  guardSize(w, h);
  const sx = w / doc.width, sy = h / doc.height;
  return {
    width: w, height: h,
    layers: doc.layers.map((l) => {
      const nw = Math.max(1, Math.round(l.w * sx)), nh = Math.max(1, Math.round(l.h * sy));
      return { ...l, x: Math.round(l.x * sx), y: Math.round(l.y * sy), w: nw, h: nh, data: resample(l.data, l.w, l.h, nw, nh, 4), mask: l.mask ? resample(l.mask, l.w, l.h, nw, nh, 1) : undefined };
    }),
  };
}

/** Bilinear resample with premultiplied alpha for 4-channel data (no dark halos). */
export function resample(src: Uint8ClampedArray, w: number, h: number, nw: number, nh: number, ch: 1 | 4): Uint8ClampedArray {
  const out = new Uint8ClampedArray(nw * nh * ch);
  const fx = w / nw, fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const syf = Math.min(h - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(syf), y1 = Math.min(h - 1, y0 + 1), wy = syf - y0;
    for (let x = 0; x < nw; x++) {
      const sxf = Math.min(w - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sxf), x1 = Math.min(w - 1, x0 + 1), wx = sxf - x0;
      const ws = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy];
      const idx = [y0 * w + x0, y0 * w + x1, y1 * w + x0, y1 * w + x1];
      const o = (y * nw + x) * ch;
      if (ch === 1) { let v = 0; for (let k = 0; k < 4; k++) v += src[idx[k]] * ws[k]; out[o] = Math.round(v); continue; }
      let a = 0, r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        const p = idx[k] * 4, al = src[p + 3] * ws[k];
        a += al; r += src[p] * al; g += src[p + 1] * al; b += src[p + 2] * al;
      }
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a);
    }
  }
  return out;
}

/** Make a layer cover at least `r` (canvas coords) so painting outside its current bounds works. */
export function growLayerTo(l: Layer, r: Rect): Layer {
  const want = unionRect({ x: l.x, y: l.y, w: l.w, h: l.h }, r)!;
  if (want.x === l.x && want.y === l.y && want.w === l.w && want.h === l.h) return l;
  guardSize(want.w, want.h, LIMITS.layerPixels);
  const data = new Uint8ClampedArray(want.w * want.h * 4);
  const mask = l.mask ? new Uint8ClampedArray(want.w * want.h).fill(255) : undefined;
  const dx = l.x - want.x, dy = l.y - want.y;
  for (let y = 0; y < l.h; y++) {
    data.set(l.data.subarray(y * l.w * 4, (y + 1) * l.w * 4), ((y + dy) * want.w + dx) * 4);
    if (mask && l.mask) mask.set(l.mask.subarray(y * l.w, (y + 1) * l.w), (y + dy) * want.w + dx);
  }
  return { ...l, ...want, data, mask };
}

/** Bounding box of non-transparent pixels in canvas coords (null if empty). */
export function contentBounds(l: Layer): Rect | null {
  let x0 = l.w, y0 = l.h, x1 = -1, y1 = -1;
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) if (l.data[(y * l.w + x) * 4 + 3]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: l.x + x0, y: l.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Pixel read in canvas coords from a layer (transparent outside). */
export function layerPixel(l: Layer, x: number, y: number): [number, number, number, number] {
  const lx = x - l.x, ly = y - l.y;
  if (lx < 0 || ly < 0 || lx >= l.w || ly >= l.h) return [0, 0, 0, 0];
  const i = (ly * l.w + lx) * 4;
  return [l.data[i], l.data[i + 1], l.data[i + 2], l.data[i + 3]];
}

export const hex = (c: [number, number, number] | number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
export function parseHex(s: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
