/**
 * TT52 — Canvas 2D rendering device for the PDF interpreter. Original code.
 *   paths (nonzero / even-odd), strokes (width, caps, joins, miter, dashes), clipping (incl. text clip modes);
 *   glyphs drawn from the embedded outlines (Path2D cache); a system font substitutes only when nothing is embedded;
 *   images: 1/2/4/8/16-bit, any colour space, Decode, ImageMask stencils, SMask, stencil /Mask, colour-key /Mask;
 *   DCT via the browser's JPEG decoder (async prepare pass); CCITT by pdfccitt.ts (before this device); JPX/JBIG2: a hatched placeholder (disclosed);
 *   shadings: axial, radial, function-based, free-form/lattice Gouraud triangles, Coons and tensor patches;
 *   tiling patterns (coloured / uncoloured) via an offscreen cell; blend modes and constant alpha; page rotation/crop.
 * Not applied: soft masks from ExtGState, isolated/knockout group compositing, overprint (disclosed in DESIGN-TT52).
 */
import { Interpreter, IDENT, apply, hiddenOCGs, invert, mul, runAnnotations, type Device, type GState, type M, type Paint, type Path, type PdfImage, type Shading, type PatternRef } from "./pdfinterp";
import type { Glyph, PdfFont } from "./pdffont";
import type { PdfDoc, PdfPage } from "./pdfdoc";
import { isNum } from "./pdfobj";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Canv = HTMLCanvasElement | OffscreenCanvas;
const mkCanvas = (w: number, h: number): Canv => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c;
};
const css = (rgb: [number, number, number]) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
export type DecodedImages = Map<object, ImageData | null>;

/** user space → device pixels for a page at `scale` (1 = 72 dpi), honouring CropBox and /Rotate */
export function pageTransform(page: PdfPage, scale: number, extraRotate = 0): { m: M; w: number; h: number } {
  const [x0, y0, x1, y1] = page.crop; const s = scale; const rot = (((page.rotate + extraRotate) % 360) + 360) % 360;
  const W = (x1 - x0) * s, H = (y1 - y0) * s;
  switch (rot) {
    case 90: return { m: [0, s, s, 0, -y0 * s, -x0 * s], w: H, h: W };
    case 180: return { m: [-s, 0, 0, s, x1 * s, -y0 * s], w: W, h: H };
    case 270: return { m: [0, -s, -s, 0, y1 * s, x1 * s], w: H, h: W };
    default: return { m: [s, 0, 0, -s, -x0 * s, y1 * s], w: W, h: H };
  }
}

export class CanvasDevice implements Device {
  wantsImages = true; wantsPaths = true;
  private ctx: Ctx; private base: M; private decoded: DecodedImages; private doc: PdfDoc;
  private glyphCache = new Map<PdfFont, Map<number, Path2D | null>>();
  warnings: string[] = [];
  /** interpreter used for tiling-pattern cells (set by renderPage) */
  fontCache = new Map<object, PdfFont>();
  constructor(doc: PdfDoc, ctx: Ctx, base: M, decoded: DecodedImages = new Map()) { this.doc = doc; this.ctx = ctx; this.base = base; this.decoded = decoded; }
  private setT(m: M) { const t = mul(m, this.base); this.ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]); }
  private build(p: Path) {
    const c = this.ctx; c.beginPath();
    for (let i = 0; i < p.length;) {
      const op = p[i++];
      if (op === 0) c.moveTo(p[i++], p[i++]); else if (op === 1) c.lineTo(p[i++], p[i++]);
      else if (op === 3) { c.bezierCurveTo(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]); i += 6; }
      else if (op === 2) { c.quadraticCurveTo(p[i], p[i + 1], p[i + 2], p[i + 3]); i += 4; }
      else if (op === 4) c.closePath();
      else break;
    }
  }
  save() { this.ctx.save(); }
  restore() { this.ctx.restore(); }
  private style(p: Paint, alpha: number, gs: GState): string | CanvasGradient | CanvasPattern | null {
    this.ctx.globalAlpha = alpha; this.ctx.globalCompositeOperation = gs.blend as GlobalCompositeOperation;
    if (p.pattern) return null;
    return css(p.cs.rgb(p.comps));
  }
  fill(p: Path, gs: GState, eo: boolean) {
    const st = this.style(gs.fill, gs.fillAlpha, gs);
    if (st === null && gs.fill.pattern) return this.patternFill(p, gs, eo, gs.fill);
    this.setT(gs.ctm); this.build(p); this.ctx.fillStyle = st!; this.ctx.fill(eo ? "evenodd" : "nonzero");
  }
  private lineSetup(gs: GState) {
    const c = this.ctx; const t = mul(gs.ctm, this.base); const sc = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1;
    // zero-width lines (and anything thinner than a device pixel) render as the thinnest visible line (§8.4.3.2)
    c.lineWidth = Math.max(gs.lw, 0.8 / sc);
    c.lineCap = (["butt", "round", "square"] as const)[gs.cap] ?? "butt";
    c.lineJoin = (["miter", "round", "bevel"] as const)[gs.join] ?? "miter";
    c.miterLimit = Math.max(1, gs.miter);
    const dash = gs.dash.filter((x) => x >= 0); c.setLineDash(dash.length && dash.some((x) => x > 0) ? dash : []); c.lineDashOffset = gs.dashPhase;
  }
  stroke(p: Path, gs: GState) {
    const st = this.style(gs.stroke, gs.strokeAlpha, gs);
    this.setT(gs.ctm); this.lineSetup(gs); this.build(p);
    if (st === null) { // pattern stroke: approximate with the pattern's mean colour
      this.ctx.strokeStyle = this.patternColor(gs.stroke); this.ctx.stroke(); return;
    }
    this.ctx.strokeStyle = st; this.ctx.stroke();
  }
  clip(p: Path, gs: GState, eo: boolean) {
    this.setT(gs.ctm);
    if (!p.length) { this.ctx.beginPath(); this.ctx.rect(0, 0, 0, 0); this.ctx.clip(); return; }
    this.build(p); this.ctx.clip(eo ? "evenodd" : "nonzero");
  }

  /* ---------------------------------------------------------------- text */
  private glyphPath(font: PdfFont, g: Glyph): Path2D | null {
    let m = this.glyphCache.get(font); if (!m) { m = new Map(); this.glyphCache.set(font, m); }
    const key = font.kind === "type0" ? g.cid * 2 + 1 : g.code * 2;
    if (m.has(key)) return m.get(key)!;
    const o = font.outline(g); let p: Path2D | null = null;
    if (o) {
      p = new Path2D();
      for (let i = 0; i < o.length;) {
        const op = o[i++];
        if (op === 0) p.moveTo(o[i++], o[i++]); else if (op === 1) p.lineTo(o[i++], o[i++]);
        else if (op === 2) { p.quadraticCurveTo(o[i], o[i + 1], o[i + 2], o[i + 3]); i += 4; }
        else if (op === 3) { p.bezierCurveTo(o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5]); i += 6; }
        else if (op === 4) p.closePath(); else break;
      }
    }
    if (m.size < 50000) m.set(key, p);
    return p;
  }
  glyph(g: Glyph, font: PdfFont, trm: M, gs: GState) {
    const mode = gs.mode & 3; if (mode === 3) return;
    const c = this.ctx; const path = this.glyphPath(font, g);
    if (path) {
      const om = font.outlineMatrix() as M; this.setT(mul(om, trm));
      if (mode === 0 || mode === 2) { const st = this.style(gs.fill, gs.fillAlpha, gs); c.fillStyle = st ?? this.patternColor(gs.fill); c.fill(path); }
      if (mode === 1 || mode === 2) {
        const st = this.style(gs.stroke, gs.strokeAlpha, gs); c.strokeStyle = st ?? this.patternColor(gs.stroke);
        const scale = Math.sqrt(Math.abs((om[0] * om[3] - om[1] * om[2]) * (trm[0] * trm[3] - trm[1] * trm[2]))) / Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]) || 1);
        this.lineSetup(gs); c.lineWidth = Math.max(gs.lw, 0.5) / (scale || 1); c.stroke(path);
      }
      return;
    }
    // nothing embedded for this glyph: substitute a system font, scaled to the PDF advance width
    const u = g.unicode; if (!u || !u.trim()) return;
    const fam = font.cssFamily(); const fnt = `${font.italic ? "italic " : ""}${font.bold ? "bold " : ""}100px ${fam}`;
    c.font = fnt; const mw = c.measureText(u).width || 100; const want = g.w / 1000 * 100;
    const sx = want > 0 && mw > 0 ? Math.min(3, Math.max(0.3, want / mw)) : 1;
    this.setT(mul([sx / 100, 0, 0, -1 / 100, 0, 0], trm));
    if (mode === 0 || mode === 2) { const st = this.style(gs.fill, gs.fillAlpha, gs); c.fillStyle = st ?? this.patternColor(gs.fill); c.fillText(u, 0, 0); }
    if (mode === 1 || mode === 2) { const st = this.style(gs.stroke, gs.strokeAlpha, gs); c.strokeStyle = st ?? "#000"; c.lineWidth = 2; c.strokeText(u, 0, 0); }
  }
  textClip(glyphs: { g: Glyph; font: PdfFont; trm: M }[]) {
    const all = new Path2D();
    for (const { g, font, trm } of glyphs) {
      const p = this.glyphPath(font, g); if (!p) continue;
      const t = mul(mul(font.outlineMatrix() as M, trm), this.base);
      all.addPath(p, new DOMMatrix([t[0], t[1], t[2], t[3], t[4], t[5]]));
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clip(all);
  }

  /* ---------------------------------------------------------------- images */
  image(img: PdfImage, gs: GState) {
    const c = this.ctx;
    const data = this.pixels(img, gs);
    this.setT(mul([1 / img.w, 0, 0, -1 / img.h, 0, 1], gs.ctm));
    c.globalAlpha = gs.fillAlpha; c.globalCompositeOperation = gs.blend as GlobalCompositeOperation;
    if (!data) { // unsupported codec: hatched placeholder so the gap is visible, not silent
      c.fillStyle = "rgba(200,200,210,0.6)"; c.fillRect(0, 0, img.w, img.h);
      c.strokeStyle = "rgba(120,120,140,0.7)"; c.lineWidth = Math.max(img.w, img.h) / 100; c.beginPath(); c.moveTo(0, 0); c.lineTo(img.w, img.h); c.moveTo(img.w, 0); c.lineTo(0, img.h); c.stroke();
      return;
    }
    const cv = mkCanvas(data.width, data.height); (cv.getContext("2d") as Ctx).putImageData(data, 0, 0);
    // image smoothing when the image is minified or the PDF asks for interpolation (PDFium behaves alike)
    const t = mul(gs.ctm, this.base); const devW = Math.hypot(t[0], t[1]), devH = Math.hypot(t[2], t[3]);
    c.imageSmoothingEnabled = img.interpolate || devW < img.w * 1.5 || devH < img.h * 1.5;
    c.drawImage(cv as CanvasImageSource, 0, 0, img.w, img.h);
  }
  /** RGBA pixels for an image, or null when the codec is unavailable */
  pixels(img: PdfImage, gs: GState): ImageData | null {
    const { w, h } = img;
    let rgba: Uint8ClampedArray<ArrayBuffer>;
    if (img.codec) {
      if (img.codec.name === "DCTDecode") { const d = this.decoded.get(img.key); if (!d) return null; rgba = new Uint8ClampedArray(d.data.length); rgba.set(d.data); if (d.width !== w || d.height !== h) return this.finish(img, new ImageData(rgba, d.width, d.height), gs); }
      else { if (!this.warnings.includes(`image codec ${img.codec.name} is not supported`)) this.warnings.push(`image codec ${img.codec.name} is not supported`); return null; }
    } else {
      if (img.imageMask) {
        rgba = new Uint8ClampedArray(w * h * 4); const [r, g, b] = img.cs ? [0, 0, 0] : gs.fill.pattern ? this.patternRgb(gs.fill) : gs.fill.cs.rgb(gs.fill.comps);
        const inv = img.decode[0] === 1; const row = Math.ceil(w / 8);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const bit = ((img.data[y * row + (x >> 3)] ?? (inv ? 0 : 255)) >> (7 - (x & 7))) & 1; const paint = inv ? bit === 1 : bit === 0; const o = (y * w + x) * 4; if (paint) { rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; } }
        return new ImageData(rgba, w, h);
      }
      rgba = samplesToRGBA(img);
    }
    return this.finish(img, new ImageData(rgba, w, h), gs);
  }
  private finish(img: PdfImage, d: ImageData, gs: GState): ImageData {
    const { width: w, height: h } = d; const px = d.data;
    if (img.colorKey && !img.codec) { // colour-key masking on the raw samples
      const n = img.cs?.n ?? 1; const ck = img.colorKey; const s = rawSamples(img);
      for (let i = 0; i < w * h; i++) { let masked = true; for (let k = 0; k < n; k++) { const v = s[i * n + k]; if (v < ck[2 * k] || v > ck[2 * k + 1]) { masked = false; break; } } if (masked) px[i * 4 + 3] = 0; }
    }
    const applyAlpha = (mask: PdfImage, invertStencil: boolean) => {
      let a: Uint8ClampedArray | null = null; let mw = mask.w, mh = mask.h;
      if (mask.codec?.name === "DCTDecode") { const md = this.decoded.get(mask.key); if (md) { a = new Uint8ClampedArray(md.width * md.height); for (let i = 0; i < a.length; i++) a[i] = md.data[i * 4]; mw = md.width; mh = md.height; } }
      else if (!mask.codec) {
        const g = samplesToRGBA({ ...mask, cs: null }, true); a = new Uint8ClampedArray(mw * mh); for (let i = 0; i < a.length; i++) a[i] = g[i * 4];
      }
      if (!a) return;
      for (let y = 0; y < h; y++) {
        const my = Math.min(mh - 1, Math.floor((y * mh) / h));
        for (let x = 0; x < w; x++) { const mx = Math.min(mw - 1, Math.floor((x * mw) / w)); let v = a[my * mw + mx]; if (invertStencil) v = 255 - v; px[(y * w + x) * 4 + 3] = (px[(y * w + x) * 4 + 3] * v) / 255; }
      }
    };
    if (img.smask) applyAlpha(img.smask, false);
    // stencil /Mask: sample 1 (after Decode) = masked out
    if (img.stencil) { const st = img.stencil; const dec = st.decode[0] === 1; applyAlpha({ ...st, decode: dec ? [1, 0] : [0, 1] }, true); }
    void gs;
    return d;
  }

  /* ---------------------------------------------------------------- shadings & patterns */
  shade(sh: Shading, gs: GState) {
    const c = this.ctx; c.save();
    c.globalAlpha = gs.fillAlpha; c.globalCompositeOperation = gs.blend as GlobalCompositeOperation;
    // BBox is in the shading's target space; a type-1 /Matrix is applied once, inside paintShading
    const m = gs.ctm;
    if (sh.bbox) { this.setT(m); c.beginPath(); c.rect(sh.bbox[0], sh.bbox[1], sh.bbox[2] - sh.bbox[0], sh.bbox[3] - sh.bbox[1]); c.clip(); }
    this.paintShading(sh, m, false);
    c.restore();
  }
  private paintShading(sh: Shading, m: M, background: boolean) {
    const c = this.ctx; this.setT(m);
    const inv = invert(mul(m, this.base)); if (!inv) return;
    // device rectangle (whole canvas) in shading space, to fill "everything" within the clip
    const cw = (c.canvas as Canv).width, ch = (c.canvas as Canv).height;
    const corners = [apply(inv, 0, 0), apply(inv, cw, 0), apply(inv, cw, ch), apply(inv, 0, ch)];
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    const R = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (background && sh.background) { c.fillStyle = css(sh.cs.rgb(sh.background)); c.fillRect(R[0], R[1], R[2] - R[0], R[3] - R[1]); }
    const color = (t: number) => { const v = sh.fn ? sh.fn([t]) : [t]; return sh.cs.rgb(v); };
    if (sh.type === 2 || sh.type === 3) {
      const [t0, t1] = sh.domain; const co = sh.coords;
      const g = sh.type === 2 ? c.createLinearGradient(co[0], co[1], co[2], co[3]) : c.createRadialGradient(co[0], co[1], Math.max(0, co[2]), co[3], co[4], Math.max(0, co[5]));
      const N = 64; for (let i = 0; i <= N; i++) { const s = i / N; g.addColorStop(s, css(color(t0 + s * (t1 - t0)))); }
      c.save();
      if (sh.type === 2 && (!sh.extend[0] || !sh.extend[1])) { // clip to the band between the end lines
        const dx = co[2] - co[0], dy = co[3] - co[1]; const L = Math.hypot(dx, dy) || 1; const nx = -dy / L, ny = dx / L; const B = 1e5;
        const ax = sh.extend[0] ? co[0] - (dx / L) * B : co[0], ay = sh.extend[0] ? co[1] - (dy / L) * B : co[1];
        const bx = sh.extend[1] ? co[2] + (dx / L) * B : co[2], by = sh.extend[1] ? co[3] + (dy / L) * B : co[3];
        c.beginPath(); c.moveTo(ax + nx * B, ay + ny * B); c.lineTo(bx + nx * B, by + ny * B); c.lineTo(bx - nx * B, by - ny * B); c.lineTo(ax - nx * B, ay - ny * B); c.closePath(); c.clip();
      }
      if (sh.type === 3 && !sh.extend[1]) { c.beginPath(); c.arc(co[3], co[4], Math.max(0, co[5]), 0, Math.PI * 2); if (sh.extend[0]) { /* inner extension stays */ } c.clip(); }
      if (sh.type === 3 && !sh.extend[0] && co[2] > 0) { c.beginPath(); c.rect(R[0], R[1], R[2] - R[0], R[3] - R[1]); c.arc(co[0], co[1], co[2], 0, Math.PI * 2, true); c.clip("evenodd"); }
      c.fillStyle = g; c.fillRect(R[0], R[1], R[2] - R[0], R[3] - R[1]); c.restore();
      return;
    }
    if (sh.type === 1) {
      const d = sh.domain; const fm = (sh.dict.get("Matrix") ? this.doc.arr(sh.dict.get("Matrix")).map((x) => this.doc.num(x)) : [1, 0, 0, 1, 0, 0]) as M;
      this.setT(mul(fm, m)); const N = 48; const dx = (d[1] - d[0]) / N, dy = (d[3] - d[2]) / N;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const v = sh.fn ? sh.fn([d[0] + (i + 0.5) * dx, d[2] + (j + 0.5) * dy]) : [0]; c.fillStyle = css(sh.cs.rgb(v)); c.fillRect(d[0] + i * dx, d[2] + j * dy, dx * 1.02, dy * 1.02); }
      return;
    }
    if (sh.type >= 4 && sh.type <= 7) { for (const [p, col] of meshTriangles(this.doc, sh)) { const rgb = css(sh.cs.rgb(sh.fn ? sh.fn([col[0]]) : col)); c.fillStyle = rgb; c.strokeStyle = rgb; c.lineWidth = 0.5 / (Math.hypot(m[0], m[1]) || 1); c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(p[2], p[3]); c.lineTo(p[4], p[5]); c.closePath(); c.fill(); c.stroke(); } }
  }
  private patternFill(p: Path, gs: GState, eo: boolean, paint: Paint) {
    const pat = paint.pattern!; const c = this.ctx;
    c.save(); this.setT(gs.ctm); this.build(p); c.clip(eo ? "evenodd" : "nonzero");
    c.globalAlpha = gs.fillAlpha;
    if (pat.kind === "shading" && pat.shading) this.paintShading(pat.shading, pat.matrix, true);
    else if (pat.kind === "tiling") this.tiling(pat, gs);
    c.restore();
  }
  private tiling(pat: PatternRef, gs: GState) {
    const d = pat.doc; const st = pat.stream as { dict: import("./pdfobj").PDict; raw: Uint8Array };
    const xs = d.num(st.dict.get("XStep"), 0), ys = d.num(st.dict.get("YStep"), 0);
    const bb = d.arr(st.dict.get("BBox")).map((x) => d.num(x)); if (bb.length !== 4 || !xs || !ys) return;
    const M0 = mul(pat.matrix, this.base); const sx = Math.hypot(M0[0], M0[1]), sy = Math.hypot(M0[2], M0[3]);
    let cw = Math.ceil(Math.abs(xs) * sx), ch = Math.ceil(Math.abs(ys) * sy);
    let k = 1; while ((cw * k > 2048 || ch * k > 2048) && k > 1 / 64) k /= 2; cw = Math.max(1, Math.ceil(cw * k)); ch = Math.max(1, Math.ceil(ch * k));
    if (cw * ch > 4_000_000 || cw < 1 || ch < 1) { this.ctx.fillStyle = this.patternColor(gs.fill); this.ctx.fillRect(-1e5, -1e5, 2e5, 2e5); return; }
    const cell = mkCanvas(cw, ch); const cctx = cell.getContext("2d") as Ctx;
    const ksx = cw / Math.abs(xs), ksy = ch / Math.abs(ys);
    const cellBase: M = [ksx, 0, 0, -ksy, -bb[0] * ksx, ch + bb[1] * ksy];
    const dev = new CanvasDevice(d, cctx, cellBase, this.decoded);
    const it = new Interpreter(d, dev, IDENT, { fontCache: this.fontCache, maxOps: 200000 });
    const paintType = d.num(st.dict.get("PaintType"), 1);
    if (paintType === 2) { const under = pat.under; const comps = pat.comps ?? []; if (under) { it.lockColor({ cs: under, comps, pattern: null }); } }
    // draw the cell and its neighbours' overlap (content may extend past the step)
    const cellData = d.decode(st as import("./pdfobj").PStream).data;
    for (const [ox, oy] of [[0, 0], [-xs, 0], [xs, 0], [0, -ys], [0, ys]]) it.runAt(cellData, pat.resources, [1, 0, 0, 1, ox, oy]);
    const cp = this.ctx.createPattern(cell as CanvasImageSource, "repeat"); if (!cp) return;
    const t = mul([1 / ksx, 0, 0, -1 / ksy, bb[0], bb[1] + ch / ksy], M0);
    cp.setTransform(new DOMMatrix([t[0], t[1], t[2], t[3], t[4], t[5]]));
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.fillStyle = cp;
    this.ctx.fillRect(0, 0, (this.ctx.canvas as Canv).width, (this.ctx.canvas as Canv).height);
  }
  private patternRgb(p: Paint): [number, number, number] {
    const pat = p.pattern; if (!pat) return p.cs.rgb(p.comps);
    if (pat.kind === "tiling" && pat.under && pat.comps?.length) return pat.under.rgb(pat.comps);
    if (pat.shading) { const sh = pat.shading; const t = (sh.domain[0] + sh.domain[1]) / 2; return sh.cs.rgb(sh.fn ? sh.fn([t]) : [t]); }
    return [128, 128, 128];
  }
  private patternColor(p: Paint) { return css(this.patternRgb(p)); }
}

/** decode raw samples to RGBA (alphaGray: treat as a gray mask, ignoring the colour space) */
export function samplesToRGBA(img: Pick<PdfImage, "w" | "h" | "bpc" | "cs" | "decode" | "data">, alphaGray = false): Uint8ClampedArray<ArrayBuffer> {
  const { w, h, bpc } = img; const cs = alphaGray ? null : img.cs; const n = cs ? cs.n : 1;
  const out = new Uint8ClampedArray(w * h * 4); const s = rawSamples(img as PdfImage, n);
  const maxv = (1 << bpc) - 1 || 65535; const dec = img.decode.length >= 2 * n ? img.decode : cs ? cs.defaultDecode(bpc) : [0, 1];
  const indexed = cs?.name === "Indexed";
  // fast paths
  const lut: Float32Array[] = []; for (let k = 0; k < n; k++) { const L = new Float32Array(maxv + 1); for (let v = 0; v <= maxv; v++) L[v] = indexed ? dec[2 * k] + (v * (dec[2 * k + 1] - dec[2 * k])) / maxv : dec[2 * k] + (v * (dec[2 * k + 1] - dec[2 * k])) / maxv; lut.push(L); }
  const cache = new Map<number, [number, number, number]>(); const comps = new Array(n).fill(0);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (!cs || cs.name === "DeviceGray") { const v = Math.round(Math.max(0, Math.min(1, lut[0][s[i]] ?? 0)) * 255); out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; continue; }
    if (cs.name === "DeviceRGB" && bpc === 8 && dec[0] === 0 && dec[1] === 1) { out[o] = s[i * 3]; out[o + 1] = s[i * 3 + 1]; out[o + 2] = s[i * 3 + 2]; out[o + 3] = 255; continue; }
    let key = 0; for (let k = 0; k < n; k++) { key = key * (maxv + 1) + s[i * n + k]; }
    let rgb = n <= 4 && maxv <= 255 ? cache.get(key) : undefined;
    if (!rgb) { for (let k = 0; k < n; k++) comps[k] = lut[k][s[i * n + k]] ?? 0; rgb = cs.rgb(comps); if (cache.size < 65536) cache.set(key, rgb); }
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
  }
  return out;
}
/** unpack samples (rows are byte-aligned) into one number per component */
export function rawSamples(img: Pick<PdfImage, "w" | "h" | "bpc" | "cs" | "data">, nComp?: number): Uint16Array | Uint8Array {
  const n = nComp ?? (img.cs ? img.cs.n : 1); const { w, h, bpc, data } = img;
  if (bpc === 8) { const need = w * h * n; if (data.length >= need) return data.subarray(0, need); const o = new Uint8Array(need); o.set(data.subarray(0, need)); return o; }
  const out = bpc === 16 ? new Uint16Array(w * h * n) : new Uint8Array(w * h * n); const rowBits = w * n * bpc; const rowBytes = Math.ceil(rowBits / 8);
  for (let y = 0; y < h; y++) {
    const r0 = y * rowBytes;
    for (let k = 0; k < w * n; k++) {
      if (bpc === 16) { out[y * w * n + k] = ((data[r0 + k * 2] ?? 0) << 8) | (data[r0 + k * 2 + 1] ?? 0); continue; }
      const bit = k * bpc; const byte = data[r0 + (bit >> 3)] ?? 0; out[y * w * n + k] = (byte >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
    }
  }
  return out;
}

/** mesh shadings (types 4–7) → small flat triangles (Gouraud approximated by subdivision) */
function meshTriangles(doc: PdfDoc, sh: Shading): [number[], number[]][] {
  const s = sh.stream; if (!s) return [];
  const d = sh.dict; const data = doc.decode(s).data;
  const bpc = doc.num(d.get("BitsPerCoordinate"), 16), bpcomp = doc.num(d.get("BitsPerComponent"), 8), bpf = doc.num(d.get("BitsPerFlag"), 8);
  const dec = doc.arr(d.get("Decode")).map((x) => doc.num(x)); const nc = sh.fn ? 1 : sh.cs.n;
  let bit = 0; const total = data.length * 8;
  const read = (n: number) => { let v = 0; for (let i = 0; i < n; i++, bit++) v = v * 2 + (((data[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1); return v; };
  const align = () => { bit = (bit + 7) & ~7; };
  const cmax = Math.pow(2, bpc) - 1, kmax = Math.pow(2, bpcomp) - 1;
  const pt = () => { const x = read(bpc), y = read(bpc); return [dec[0] + (x * (dec[1] - dec[0])) / cmax, dec[2] + (y * (dec[3] - dec[2])) / cmax]; };
  const col = () => { const c: number[] = []; for (let k = 0; k < nc; k++) { const v = read(bpcomp); c.push(dec[4 + 2 * k] + (v * (dec[5 + 2 * k] - dec[4 + 2 * k])) / kmax); } return c; };
  const out: [number[], number[]][] = [];
  const tri = (a: number[], b: number[], c: number[], ca: number[], cb: number[], cc: number[], depth: number) => {
    const diff = Math.max(...ca.map((v, i) => Math.max(Math.abs(v - cb[i]), Math.abs(v - cc[i]))));
    if (depth >= 4 || diff < 0.02 || out.length > 200000) { out.push([[...a, ...b, ...c], ca.map((v, i) => (v + cb[i] + cc[i]) / 3)]); return; }
    const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; const mc = (p: number[], q: number[]) => p.map((v, i) => (v + q[i]) / 2);
    const ab = mid(a, b), bc = mid(b, c), ca2 = mid(c, a); const cab = mc(ca, cb), cbc = mc(cb, cc), cca = mc(cc, ca);
    tri(a, ab, ca2, ca, cab, cca, depth + 1); tri(ab, b, bc, cab, cb, cbc, depth + 1); tri(ca2, bc, c, cca, cbc, cc, depth + 1); tri(ab, bc, ca2, cab, cbc, cca, depth + 1);
  };
  if (sh.type === 4) {
    const vs: { p: number[]; c: number[] }[] = [];
    while (bit + bpf + 2 * bpc <= total && out.length < 200000) {
      const f = read(bpf); const p = pt(); const c = col(); align();
      if (f === 0 || vs.length < 2) { vs.push({ p, c }); if (vs.length > 3) vs.splice(0, vs.length - 3); if (f === 0 && vs.length === 3) { tri(vs[0].p, vs[1].p, vs[2].p, vs[0].c, vs[1].c, vs[2].c, 0); vs.length = 0; } continue; }
      const [va, vb] = f === 1 ? [vs[1], vs[2] ?? vs[1]] : [vs[0], vs[2] ?? vs[1]];
      tri(va.p, vb.p, p, va.c, vb.c, c, 0); vs.splice(0, vs.length, va, vb, { p, c });
    }
  } else if (sh.type === 5) {
    const per = Math.max(2, doc.num(d.get("VerticesPerRow"), 2)); const rows: { p: number[]; c: number[] }[][] = [];
    while (bit + 2 * bpc <= total) { const row: { p: number[]; c: number[] }[] = []; for (let i = 0; i < per && bit + 2 * bpc <= total; i++) { row.push({ p: pt(), c: col() }); align(); } if (row.length === per) rows.push(row); else break; }
    for (let r = 0; r + 1 < rows.length; r++) for (let i = 0; i + 1 < per; i++) { const a = rows[r][i], b = rows[r][i + 1], c2 = rows[r + 1][i], e = rows[r + 1][i + 1]; tri(a.p, b.p, c2.p, a.c, b.c, c2.c, 0); tri(b.p, e.p, c2.p, b.c, e.c, c2.c, 0); }
  } else {
    // Coons (6) / tensor (7) patches → evaluate on a grid (Coons treated as tensor with derived interior points)
    let prev: { P: number[][]; C: number[][] } | null = null;
    while (bit + bpf <= total && out.length < 200000) {
      const f = read(bpf); const np = sh.type === 6 ? (f ? 8 : 12) : f ? 12 : 16; const nc2 = f ? 2 : 4;
      if (bit + np * 2 * bpc > total) break;
      const pts: number[][] = []; for (let i = 0; i < np; i++) pts.push(pt()); const cols: number[][] = []; for (let i = 0; i < nc2; i++) cols.push(col()); align();
      // boundary points in the order of §8.7.4.5.7 (12 boundary points, counter-clockwise from the corner)
      let B: number[][]; let C: number[][];
      if (!f || !prev) { B = pts.slice(0, 12); C = cols.length === 4 ? cols : [cols[0], cols[1], cols[0], cols[1]]; }
      else {
        const pB = prev.P, pC = prev.C;
        const shared = f === 1 ? [pB[3], pB[4], pB[5], pB[6]] : f === 2 ? [pB[6], pB[7], pB[8], pB[9]] : [pB[9], pB[10], pB[11], pB[0]];
        const sc = f === 1 ? [pC[1], pC[2]] : f === 2 ? [pC[2], pC[3]] : [pC[3], pC[0]];
        B = [...shared, ...pts.slice(0, 8)]; C = [sc[0], sc[1], cols[0], cols[1]];
      }
      prev = { P: B, C };
      const interior = sh.type === 7 ? (f ? pts.slice(8, 12) : pts.slice(12, 16)) : null;
      patchGrid(B, C, interior, (a, b, c, ca, cb, cc) => tri(a, b, c, ca, cb, cc, 2));
    }
  }
  return out;
}
function patchGrid(B: number[][], C: number[][], interior: number[][] | null, tri: (a: number[], b: number[], c: number[], ca: number[], cb: number[], cc: number[]) => void) {
  // control net P[i][j] (i = u along the first edge, j = v), corners per §8.7.4.5.7: B0=P00, B3=P03, B6=P33, B9=P30
  const P: number[][][] = [[B[0], B[1], B[2], B[3]], [B[11], [], [], B[4]], [B[10], [], [], B[5]], [B[9], B[8], B[7], B[6]]];
  if (interior) { P[1][1] = interior[0]; P[1][2] = interior[1]; P[2][2] = interior[2]; P[2][1] = interior[3]; }
  else {
    // Coons → tensor interior points (ISO 32000-2 §8.7.4.5.7)
    const q = (i: number, j: number) => P[i][j];
    const comb = (t: [number, number[]][]) => [0, 1].map((k) => t.reduce((acc, [w, pnt]) => acc + w * pnt[k], 0) / 9);
    P[1][1] = comb([[-4, q(0, 0)], [6, q(0, 1)], [6, q(1, 0)], [-2, q(0, 3)], [-2, q(3, 0)], [3, q(3, 1)], [3, q(1, 3)], [-1, q(3, 3)]]);
    P[1][2] = comb([[-4, q(0, 3)], [6, q(0, 2)], [6, q(1, 3)], [-2, q(0, 0)], [-2, q(3, 3)], [3, q(3, 2)], [3, q(1, 0)], [-1, q(3, 0)]]);
    P[2][2] = comb([[-4, q(3, 3)], [6, q(3, 2)], [6, q(2, 3)], [-2, q(3, 0)], [-2, q(0, 3)], [3, q(2, 0)], [3, q(0, 2)], [-1, q(0, 0)]]);
    P[2][1] = comb([[-4, q(3, 0)], [6, q(3, 1)], [6, q(2, 0)], [-2, q(3, 3)], [-2, q(0, 0)], [3, q(0, 1)], [3, q(2, 3)], [-1, q(0, 3)]]);
  }
  const bern = (t: number) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
  const N = 8; const grid: number[][][] = [];
  for (let a = 0; a <= N; a++) { const row: number[][] = []; const bu = bern(a / N); for (let b = 0; b <= N; b++) { const bv = bern(b / N); let x = 0, y = 0; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const w = bu[i] * bv[j]; x += w * P[i][j][0]; y += w * P[i][j][1]; } row.push([x, y]); } grid.push(row); }
  // colours: C0 at P00, C1 at P03, C2 at P33, C3 at P30 — bilinear
  const colAt = (u: number, v: number) => C[0].map((_, k) => (1 - u) * (1 - v) * C[0][k] + (1 - u) * v * C[1][k] + u * v * C[2][k] + u * (1 - v) * C[3][k]);
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
    const p00 = grid[a][b], p01 = grid[a][b + 1], p10 = grid[a + 1][b], p11 = grid[a + 1][b + 1];
    const c00 = colAt(a / N, b / N), c01 = colAt(a / N, (b + 1) / N), c10 = colAt((a + 1) / N, b / N), c11 = colAt((a + 1) / N, (b + 1) / N);
    tri(p00, p01, p11, c00, c01, c11); tri(p00, p11, p10, c00, c11, c10);
  }
}

/* ------------------------------------------------------------------ page rendering */
export interface RenderOptions { scale: number; rotate?: number; annotations?: boolean; background?: string; deadline?: number; skipAnnot?: (a: import("./pdfobj").PDict) => boolean }
/** collect DCT images (and DCT soft masks) of a page and decode them with the browser's JPEG decoder */
export async function prepareImages(doc: PdfDoc, page: PdfPage, cache: DecodedImages): Promise<void> {
  const found: PdfImage[] = [];
  const dev: Device = { wantsImages: true, wantsPaths: false, save() {}, restore() {}, fill() {}, stroke() {}, clip() {}, glyph() {}, shade() {},
    image(img) { for (const i of [img, img.smask, img.stencil]) if (i?.codec?.name === "DCTDecode" && !cache.has(i.key)) found.push(i); } };
  const it = new Interpreter(doc, dev, IDENT, { hiddenOCGs: hiddenOCGs(doc), maxOps: 2_000_000 });
  try { it.runPage(page); runAnnotations(doc, page, it, dev); } catch { /* best effort */ }
  await Promise.all(found.map(async (img) => {
    if (cache.has(img.key)) return; cache.set(img.key, null);
    try {
      const bmp = await createImageBitmap(new Blob([img.data as BlobPart], { type: "image/jpeg" }));
      const cv = mkCanvas(bmp.width, bmp.height); const cx = cv.getContext("2d") as Ctx; cx.drawImage(bmp as CanvasImageSource, 0, 0);
      const d = cx.getImageData(0, 0, bmp.width, bmp.height); bmp.close?.();
      // /Decode [1 0] on a gray DCT image inverts it
      if (img.decode[0] === 1 && img.decode[1] === 0 && (img.cs?.n ?? 1) === 1) for (let i = 0; i < d.data.length; i += 4) { d.data[i] = 255 - d.data[i]; d.data[i + 1] = 255 - d.data[i + 1]; d.data[i + 2] = 255 - d.data[i + 2]; }
      cache.set(img.key, d);
    } catch { cache.set(img.key, null); }
  }));
}
export async function renderPage(doc: PdfDoc, page: PdfPage, canvas: Canv, opts: RenderOptions, cache: DecodedImages = new Map()): Promise<{ warnings: string[]; ms: number }> {
  const t0 = Date.now();
  await prepareImages(doc, page, cache);
  const { m, w, h } = pageTransform(page, opts.scale, opts.rotate ?? 0);
  canvas.width = Math.max(1, Math.round(w)); canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d") as Ctx;
  ctx.save(); ctx.fillStyle = opts.background ?? "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
  const dev = new CanvasDevice(doc, ctx, m, cache); const warnings: string[] = [];
  const it = new Interpreter(doc, dev, IDENT, { hiddenOCGs: hiddenOCGs(doc), warnings, fontCache: dev.fontCache, deadline: opts.deadline });
  try { it.runPage(page); } catch (e) { warnings.push(`render: ${(e as Error).message}`); }
  if (opts.annotations !== false) { try { runAnnotations(doc, page, it, dev, false, opts.skipAnnot); } catch (e) { warnings.push(`annotations: ${(e as Error).message}`); } }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { warnings: [...new Set([...warnings, ...dev.warnings])], ms: Date.now() - t0 };
}
export { isNum };
