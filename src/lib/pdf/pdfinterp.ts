/**
 * TT52 — PDF content-stream interpreter (ISO 32000-2 §8 graphics, §9 text, §8.9 images, §8.10 form XObjects,
 * §8.11 optional content, §9.6.4 Type 3 glyphs, §12.5.5 annotation appearances). Original code from the specification.
 * Painting goes to a Device: pdftext.ts (text extraction / search / text layer) and pdfcanvas.ts (Canvas 2D rendering).
 * Bounded: operator count per page, form/Type 3 recursion depth, q/Q nesting.
 */
import { Lexer, PDict, PKw, PName, PStr, PStream, isArr, isDict, isName, isNum, isRef, isStream, parseObj, type PObj, type Bytes, type Token } from "./pdfobj";
import type { PdfDoc, PdfPage } from "./pdfdoc";
import { PdfFont, type Glyph } from "./pdffont";
import { ccittDecode } from "./pdfccitt";
import { jbig2Decode } from "./pdfjbig2";
import { jpxDecode, type JpxResult } from "./pdfjpx";
import { synthAppearance } from "./pdfappear";
import { DeviceCMYK, DeviceGray, DeviceRGB, loadColorSpace, loadFunction, type ColorSpace, type PdfFn } from "./pdfcolor";
import { applyFilters, filterChain, type FilterSpec } from "./pdffilters";

export type M = [number, number, number, number, number, number];
export const IDENT: M = [1, 0, 0, 1, 0, 0];
/** a then b (row-vector convention: p' = p × a × b) */
export const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
export const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m: M): M | null { const d = m[0] * m[3] - m[1] * m[2]; if (!d || !Number.isFinite(d)) return null; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; }

export type Path = number[]; // same op codes as glyph outlines: 0 m, 1 l, 3 c, 4 h
export interface Paint { cs: ColorSpace; comps: number[]; pattern: PatternRef | null }
export interface PatternRef { kind: "tiling" | "shading"; stream: PStream | PDict; matrix: M; shading?: Shading; doc: PdfDoc; resources: PDict | null; comps?: number[]; under?: ColorSpace }
export interface Shading { type: number; cs: ColorSpace; coords: number[]; domain: number[]; extend: [boolean, boolean]; fn: PdfFn | null; bbox: number[] | null; background: number[] | null; dict: PDict; stream: PStream | null; matrix?: number[] }
/** TT77: an ExtGState soft mask (§11.6.5.2), captured with the CTM in effect when `gs` ran */
export interface SoftMask { subtype: "Alpha" | "Luminosity"; group: PStream; bc: [number, number, number] | null; tr: PdfFn | null; ctm: M; key: object }
/** TT77: transparency group attributes (§11.6.6) */
export interface GroupInfo { isolated: boolean; knockout: boolean; /** an ExtGState in the group's resources sets a non-Normal blend mode */ blends: boolean }
export interface GState {
  ctm: M; fill: Paint; stroke: Paint;
  lw: number; cap: number; join: number; miter: number; dash: number[]; dashPhase: number;
  fillAlpha: number; strokeAlpha: number; blend: string; softMask: SoftMask | null;
  font: PdfFont | null; fontSize: number; tc: number; tw: number; th: number; tl: number; rise: number; mode: number;
}
export interface PdfImage {
  w: number; h: number; bpc: number; cs: ColorSpace | null; decode: number[]; imageMask: boolean; interpolate: boolean;
  /** decoded samples (byte filters applied); `codec` set when an image codec must still run (DCT/JPX/JBIG2/CCITT) */
  data: Bytes; codec: FilterSpec | null; key: object;
  smask: PdfImage | null; stencil: PdfImage | null; colorKey: number[] | null; matte?: number[];
  partial: boolean;
}
export interface Device {
  save(): void; restore(): void;
  fill(p: Path, gs: GState, evenOdd: boolean): void;
  stroke(p: Path, gs: GState): void;
  clip(p: Path, gs: GState, evenOdd: boolean): void;
  /** trm maps 1 text-space unit (em) to user space incl. CTM */
  glyph(g: Glyph, font: PdfFont, trm: M, gs: GState, widthUser: number): void;
  /** Type 3 glyphs are drawn through the interpreter; the text device is told the glyph position */
  type3Glyph?(g: Glyph, font: PdfFont, trm: M, gs: GState, widthUser: number): void;
  textClip?(glyphs: { g: Glyph; font: PdfFont; trm: M }[], gs: GState): void;
  image(img: PdfImage, gs: GState): void;
  shade(sh: Shading, gs: GState): void;
  /** returns true when the device composites the group as a unit (then alpha, blend mode and soft mask reset inside it) */
  beginGroup?(gs: GState, bbox: number[] | null, info?: GroupInfo): boolean | void; endGroup?(gs: GState): void;
  annotBegin?(rect: number[], annot: PDict): void; annotEnd?(): void;
  markedContent?(tag: string, props: PDict | null, begin: boolean): void;
  wantsImages: boolean; wantsPaths: boolean;
}

export interface InterpOptions { maxOps?: number; hiddenOCGs?: Set<string>; fontCache?: Map<object, PdfFont>; warnings?: string[]; deadline?: number }

/* ------------------------------------------------------------------ images */
const JBIG2_CACHE = new WeakMap<object, { data: Bytes; partial: boolean }>();
const JPX_CACHE = new WeakMap<object, JpxResult | Error>();
export function loadImage(doc: PdfDoc, s: PStream | { dict: PDict; raw: Bytes }, resources: PDict | null, inline = false, depth = 0): PdfImage | null {
  const d = s.dict; const g = (k: string, ab?: string) => doc.resolve(d.get(k) ?? (inline && ab ? d.get(ab) : undefined));
  let w = Math.floor(doc.num(g("Width", "W"))), h = Math.floor(doc.num(g("Height", "H")));
  if (!(w > 0 && h > 0) || w * h > 100_000_000) return null;
  const imageMask = g("ImageMask", "IM") === true;
  const chain = filterChain(d, (x) => doc.resolve(x)).map((f) => (inline ? { ...f, name: ({ AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", Fl: "FlateDecode", RL: "RunLengthDecode", CCF: "CCITTFaxDecode", DCT: "DCTDecode" } as Record<string, string>)[f.name] ?? f.name } : f));
  const r = applyFilters(s.raw, chain, 256 << 20);
  if (r.image?.name === "CCITTFaxDecode") { // first-party T.4/T.6 decoder: becomes plain 1-bit samples
    const pp = r.image.parms; const pv = (k: string) => (pp ? doc.resolve(pp.get(k)) : undefined); const pn = (k: string, dflt: number) => { const v = pv(k); return typeof v === "number" ? v : dflt; };
    const c = ccittDecode(r.data, { K: pn("K", 0), Columns: pn("Columns", 1728), Rows: pn("Rows", 0) || h, EndOfLine: pv("EndOfLine") === true, EncodedByteAlign: pv("EncodedByteAlign") === true, EndOfBlock: pv("EndOfBlock") !== false, BlackIs1: pv("BlackIs1") === true });
    r.data = c.data; r.image = null; r.partial = r.partial || c.partial; r.ccitt = true;
  } else if (r.image?.name === "JBIG2Decode") { // TT77: first-party T.88 decoder (pdfjbig2.ts), cached per stream
    let j = JBIG2_CACHE.get(s);
    if (!j) {
      const pp = r.image.parms; const go = pp ? doc.resolve(pp.get("JBIG2Globals")) : undefined;
      let glob: Bytes | null = null;
      if (isStream(go)) { const gr = applyFilters(go.raw, filterChain(go.dict, (x) => doc.resolve(x)), 64 << 20); glob = gr.data; }
      const o = jbig2Decode(r.data, glob, { width: w, height: h });
      j = { data: o.data, partial: o.partial }; JBIG2_CACHE.set(s, j);
    }
    r.data = j.data; r.image = null; r.partial = r.partial || j.partial; r.ccitt = true;
  }
  let jpx: JpxResult | null = null;
  if (r.image?.name === "JPXDecode") { // TT77: first-party T.800 decoder (pdfjpx.ts); the codestream's size and colour rule
    let j = JPX_CACHE.get(s);
    if (!j) {
      const cso = doc.resolve(d.get("ColorSpace")); const indexed = isArr(cso) && isName(doc.resolve(cso[0]), "Indexed");
      try { j = jpxDecode(r.data, { indexed }); } catch (e) { j = e as Error; }
      JPX_CACHE.set(s, j);
    }
    if (j instanceof Error) { r.unsupported = "JPXDecode"; r.image = null; r.partial = true; }
    else { jpx = j; w = j.width; h = j.height; r.data = j.data; r.image = null; r.partial = r.partial || j.partial; }
  }
  let cs: ColorSpace | null = null; let bpc = imageMask || r.ccitt ? 1 : Math.floor(doc.num(g("BitsPerComponent", "BPC"), 8));
  if (!imageMask) {
    const cso = g("ColorSpace", "CS");
    if (cso !== undefined && cso !== null) cs = loadColorSpace(doc, inline && isName(cso) ? (({ G: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK", I: "Indexed" } as Record<string, string>)[cso.n] ? new PName(({ G: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK", I: "Indexed" } as Record<string, string>)[cso.n]) : cso) : inline && isArr(cso) && isName(cso[0], "I") ? [new PName("Indexed"), ...cso.slice(1)] : cso, resources);
    else if (jpx) cs = jpx.comps === 1 ? DeviceGray : jpx.comps === 4 || jpx.cs === "cmyk" ? DeviceCMYK : DeviceRGB; // JPX carries its own colour space
    else cs = DeviceGray;
    if (jpx) { // the PDF colour space decides the channel count; extra JPX channels are dropped, missing ones read 0
      bpc = 8; const n = cs!.n;
      if (n !== jpx.comps) { const src = jpx.data, k = jpx.comps, o = new Uint8Array(w * h * n); for (let i = 0; i < w * h; i++) for (let c = 0; c < n && c < k; c++) o[i * n + c] = src[i * k + c]; r.data = o; }
    }
    if (r.image?.name === "JPXDecode" || r.image?.name === "JBIG2Decode") bpc = r.image.name === "JBIG2Decode" ? 1 : 8;
  }
  if (![1, 2, 4, 8, 16].includes(bpc)) bpc = 8;
  const dec = doc.arr(g("Decode", "D")).map((x) => doc.num(x));
  // JPX: /Decode is ignored unless the image is a mask (§8.9.5.1, Table 87)
  const decode = dec.length && !(jpx && !imageMask) ? dec : imageMask ? [0, 1] : cs!.defaultDecode(bpc);
  let smask: PdfImage | null = null, stencil: PdfImage | null = null, colorKey: number[] | null = null; let matte: number[] | undefined;
  if (!inline && depth < 2) {
    const sm = doc.resolve(d.get("SMask"));
    if (isStream(sm)) { smask = loadImage(doc, sm, resources, false, depth + 1); const mt = doc.arr(sm.dict.get("Matte")); if (mt.length) matte = mt.map((x) => doc.num(x)); }
    const mk = doc.resolve(d.get("Mask"));
    if (isStream(mk)) stencil = loadImage(doc, mk, resources, false, depth + 1);
    else if (isArr(mk)) colorKey = mk.map((x) => doc.num(x));
  }
  // /SMaskInData 1|2: the JPX opacity channel is the soft mask when no /SMask is given (§8.9.5.1)
  const smid = jpx?.alpha && !smask ? doc.num(g("SMaskInData"), 0) : 0;
  // 2 = colour premultiplied by opacity: un-premultiply against /Matte (default black) through the matte path
  if (smid === 2) { const mt = doc.arr(d.get("Matte")).map((x) => doc.num(x)); matte = mt.length ? mt : new Array(cs?.n ?? 3).fill(0); }
  if (smid > 0 && jpx?.alpha) smask = { w, h, bpc: 8, cs: DeviceGray, decode: [0, 1], imageMask: false, interpolate: false, data: jpx.alpha, codec: null, key: {}, smask: null, stencil: null, colorKey: null, partial: false };
  return { w, h, bpc, cs, decode, imageMask, interpolate: g("Interpolate", "I") === true, data: r.data, codec: r.image ?? (r.unsupported ? { name: r.unsupported, parms: null } : null), key: s, smask, stencil, colorKey, matte, partial: r.partial };
}

export function loadShading(doc: PdfDoc, o: PObj | undefined, resources: PDict | null): Shading | null {
  const r = doc.resolve(o); const d = isStream(r) ? r.dict : isDict(r) ? r : null; if (!d) return null;
  const type = doc.num(d.get("ShadingType"), 0);
  const cs = loadColorSpace(doc, d.get("ColorSpace"), resources);
  const coords = doc.arr(d.get("Coords")).map((x) => doc.num(x));
  const dom = doc.arr(d.get("Domain")).map((x) => doc.num(x));
  const ext = doc.arr(d.get("Extend")).map((x) => doc.resolve(x) === true);
  const bb = doc.arr(d.get("BBox")).map((x) => doc.num(x));
  const bg = doc.arr(d.get("Background")).map((x) => doc.num(x));
  const mtx = doc.arr(d.get("Matrix")).map((x) => doc.num(x));
  // function arity (§8.7.4.5): type 1 takes 2 inputs, all other types 1 — an invalid shading is not painted (as PDFium)
  const fo = doc.resolve(d.get("Function"));
  if (fo !== undefined && fo !== null) {
    const want = type === 1 ? 4 : 2; const fns = isArr(fo) ? fo.map((x) => doc.resolve(x)) : [fo];
    for (const f of fns) { const fd = isStream(f) ? f.dict : isDict(f) ? f : null; const dm = fd ? doc.arr(fd.get("Domain")) : []; if (!fd || dm.length !== want) return null; }
  }
  return { type, cs, coords, domain: dom.length ? dom : type === 1 ? [0, 1, 0, 1] : [0, 1], extend: [ext[0] ?? false, ext[1] ?? false], fn: loadFunction(doc, d.get("Function")), bbox: bb.length === 4 ? bb : null, background: bg.length ? bg : null, dict: d, stream: isStream(r) ? r : null, matrix: mtx.length === 6 ? mtx : undefined };
}

/* ------------------------------------------------------------------ interpreter */
const OPS_LIMIT = 5_000_000;
export class Interpreter {
  private doc: PdfDoc; private dev: Device; private opts: InterpOptions;
  private gs: GState; private stack: GState[] = [];
  private path: Path = []; private cx = 0; private cy = 0; private sx = 0; private sy = 0;
  private pendingClip: 0 | 1 | 2 = 0;
  private tm: M = IDENT; private tlm: M = IDENT; private inText = false;
  private clipGlyphs: { g: Glyph; font: PdfFont; trm: M }[] = [];
  private ops = 0; private depth = 0;
  private fonts: Map<object, PdfFont>;
  private hiddenDepth = 0; private mcStack: boolean[] = [];
  warnings: string[];
  /** Type 3 glyph-procedure state (d0/d1 — d1 means colour operators are ignored) */
  private t3Uncolored = false;

  constructor(doc: PdfDoc, dev: Device, ctm: M, opts: InterpOptions = {}) {
    this.doc = doc; this.dev = dev; this.opts = opts; this.fonts = opts.fontCache ?? new Map(); this.warnings = opts.warnings ?? [];
    this.gs = Interpreter.initialGS(ctm);
  }
  static initialGS(ctm: M): GState {
    return { ctm, fill: { cs: DeviceGray, comps: [0], pattern: null }, stroke: { cs: DeviceGray, comps: [0], pattern: null }, lw: 1, cap: 0, join: 0, miter: 10, dash: [], dashPhase: 0,
      fillAlpha: 1, strokeAlpha: 1, blend: "source-over", softMask: null, font: null, fontSize: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, mode: 0 };
  }

  private locked = false;
  private colorLocked() { return this.t3Uncolored || this.locked; }
  /** uncoloured tiling patterns (PaintType 2) and d1 glyphs: colour comes from outside; colour operators are ignored */
  lockColor(p: Paint) { this.gs.fill = { ...p }; this.gs.stroke = { ...p }; this.locked = true; }
  /** run content under an extra matrix (pattern cells), restoring the graphics state afterwards */
  runAt(data: Bytes, resources: PDict | null, m: M) { this.save(); this.gs.ctm = mul(m, this.gs.ctm); this.run(data, resources); this.restore(); }
  /** run a page: content streams with the page's resources */
  runPage(page: PdfPage) {
    const data = this.doc.contentBytes(page.dict.get("Contents"));
    this.run(data, page.resources);
  }

  /** save-stack depth at the start of the content stream being run: its Q operators never pop below it (an unbalanced
   *  Q inside a Type 3 glyph, form or appearance must not undo the caller's state — ISO 32000-1 §8.4.2 requires q/Q to
   *  balance within a stream; viewers confine the damage to that stream) */
  private floor = 0;
  run(data: Bytes, resources: PDict | null) {
    const prevFloor = this.floor; this.floor = this.stack.length;
    try { this.runStream(data, resources); } finally { this.floor = prevFloor; }
  }
  private runStream(data: Bytes, resources: PDict | null) {
    const lx = new Lexer(data, 0); const args: PObj[] = [];
    const maxOps = this.opts.maxOps ?? OPS_LIMIT;
    for (;;) {
      let t: Token;
      try { t = lx.next(); } catch { break; }
      if (t === undefined) break;
      if (t instanceof PKw) {
        if (++this.ops > maxOps) { this.warnings.push("operator limit reached; page truncated"); break; }
        if (this.opts.deadline && (this.ops & 1023) === 0 && Date.now() > this.opts.deadline) { this.warnings.push("time limit reached; page truncated"); break; }
        if (t.k === "BI") { this.inlineImage(lx, resources); args.length = 0; continue; }
        try { this.op(t.k, args, resources); } catch (e) { if (this.warnings.length < 50) this.warnings.push(`${t.k}: ${(e as Error).message}`); }
        args.length = 0; continue;
      }
      if (t && typeof t === "object" && "delim" in (t as object)) {
        const dl = (t as { delim: string }).delim;
        if (dl === "[" || dl === "<<") { lx.p -= dl.length; try { args.push(parseObj(lx, 0)); } catch { lx.p += dl.length; } }
        continue;
      }
      if (args.length < 64) args.push(t as PObj);
    }
    // unbalanced q at the end of THIS stream: unwind to the stream's own floor, never into the caller's saved states
    while (this.stack.length > this.floor) this.restore();
  }

  private save() { this.stack.push({ ...this.gs, fill: { ...this.gs.fill }, stroke: { ...this.gs.stroke } }); this.dev.save(); }
  private restore() { const g = this.stack.pop(); if (g) { this.gs = g; this.dev.restore(); } }
  private num(a: PObj | undefined, d = 0) { return isNum(a) ? a : d; }

  private op(k: string, a: PObj[], res: PDict | null) {
    const gs = this.gs; const n = (i: number) => this.num(a[i]);
    switch (k) {
      case "q": if (this.stack.length < 256) this.save(); break;
      case "Q": if (this.stack.length > this.floor) this.restore(); break;
      case "cm": if (a.length >= 6) gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm); break;
      case "w": gs.lw = n(0); break;
      case "J": gs.cap = n(0); break;
      case "j": gs.join = n(0); break;
      case "M": gs.miter = n(0); break;
      case "d": gs.dash = isArr(a[0]) ? (a[0] as PObj[]).map((x) => this.num(x)) : []; gs.dashPhase = n(1); break;
      case "ri": case "i": break;
      case "gs": this.extGState(a[0], res); break;
      // path construction
      case "m": this.cx = this.sx = n(0); this.cy = this.sy = n(1); this.path.push(0, this.cx, this.cy); break;
      case "l": this.cx = n(0); this.cy = n(1); this.path.push(1, this.cx, this.cy); break;
      case "c": this.path.push(3, n(0), n(1), n(2), n(3), n(4), n(5)); this.cx = n(4); this.cy = n(5); break;
      case "v": this.path.push(3, this.cx, this.cy, n(0), n(1), n(2), n(3)); this.cx = n(2); this.cy = n(3); break;
      case "y": this.path.push(3, n(0), n(1), n(2), n(3), n(2), n(3)); this.cx = n(2); this.cy = n(3); break;
      case "h": this.path.push(4); this.cx = this.sx; this.cy = this.sy; break;
      case "re": { const x = n(0), y = n(1), w = n(2), h = n(3); this.path.push(0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4); this.cx = this.sx = x; this.cy = this.sy = y; break; }
      // painting
      case "S": this.paint(false, true, false); break;
      case "s": this.path.push(4); this.paint(false, true, false); break;
      case "f": case "F": this.paint(true, false, false); break;
      case "f*": this.paint(true, false, true); break;
      case "B": this.paint(true, true, false); break;
      case "B*": this.paint(true, true, true); break;
      case "b": this.path.push(4); this.paint(true, true, false); break;
      case "b*": this.path.push(4); this.paint(true, true, true); break;
      case "n": this.paint(false, false, false); break;
      case "W": this.pendingClip = 1; break;
      case "W*": this.pendingClip = 2; break;
      // colour
      case "CS": if (!this.colorLocked()) { gs.stroke = this.paintFor(loadColorSpace(this.doc, a[0], res)); } break;
      case "cs": if (!this.colorLocked()) { gs.fill = this.paintFor(loadColorSpace(this.doc, a[0], res)); } break;
      case "SC": case "SCN": if (!this.colorLocked()) this.setColor(gs.stroke, a, res); break;
      case "sc": case "scn": if (!this.colorLocked()) this.setColor(gs.fill, a, res); break;
      case "G": if (!this.colorLocked()) gs.stroke = { cs: DeviceGray, comps: [n(0)], pattern: null }; break;
      case "g": if (!this.colorLocked()) gs.fill = { cs: DeviceGray, comps: [n(0)], pattern: null }; break;
      case "RG": if (!this.colorLocked()) gs.stroke = { cs: DeviceRGB, comps: [n(0), n(1), n(2)], pattern: null }; break;
      case "rg": if (!this.colorLocked()) gs.fill = { cs: DeviceRGB, comps: [n(0), n(1), n(2)], pattern: null }; break;
      case "K": if (!this.colorLocked()) gs.stroke = { cs: DeviceCMYK, comps: [n(0), n(1), n(2), n(3)], pattern: null }; break;
      case "k": if (!this.colorLocked()) gs.fill = { cs: DeviceCMYK, comps: [n(0), n(1), n(2), n(3)], pattern: null }; break;
      case "sh": { if (this.hiddenDepth || !this.dev.wantsPaths) break; const sd = res ? this.doc.dict(res.get("Shading")) : null; const sh = sd && isName(a[0]) ? loadShading(this.doc, sd.get(a[0].n), res) : null; if (sh) this.dev.shade(sh, gs); break; }
      case "Do": this.xobject(a[0], res); break;
      // text
      case "BT": this.inText = true; this.tm = IDENT; this.tlm = IDENT; this.clipGlyphs = []; break;
      case "ET": this.inText = false; if (this.clipGlyphs.length && this.dev.textClip) this.dev.textClip(this.clipGlyphs, gs); this.clipGlyphs = []; break;
      case "Tc": gs.tc = n(0); break;
      case "Tw": gs.tw = n(0); break;
      case "Tz": gs.th = n(0) / 100; break;
      case "TL": gs.tl = n(0); break;
      case "Ts": gs.rise = n(0); break;
      case "Tr": gs.mode = n(0); break;
      case "Tf": gs.fontSize = n(1); gs.font = this.font(a[0], res); break;
      case "Td": this.tlm = mul([1, 0, 0, 1, n(0), n(1)], this.tlm); this.tm = this.tlm; break;
      case "TD": gs.tl = -n(1); this.tlm = mul([1, 0, 0, 1, n(0), n(1)], this.tlm); this.tm = this.tlm; break;
      case "Tm": if (a.length >= 6) { this.tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; this.tm = this.tlm; } break;
      case "T*": this.tlm = mul([1, 0, 0, 1, 0, -gs.tl], this.tlm); this.tm = this.tlm; break;
      case "Tj": if (a[0] instanceof PStr) this.showText(a[0].b, res); break;
      case "'": this.op("T*", [], res); if (a[0] instanceof PStr) this.showText(a[0].b, res); break;
      case "\"": gs.tw = n(0); gs.tc = n(1); this.op("T*", [], res); if (a[2] instanceof PStr) this.showText(a[2].b, res); break;
      case "TJ": if (isArr(a[0])) for (const e of a[0] as PObj[]) { if (e instanceof PStr) this.showText(e.b, res); else if (isNum(e)) this.adjust(e); } break;
      case "d0": break;
      case "d1": this.t3Uncolored = true; break;
      // marked content / optional content
      case "BMC": this.mcStack.push(false); this.dev.markedContent?.(isName(a[0]) ? a[0].n : "", null, true); break;
      case "BDC": {
        let hidden = false; let props: PDict | null = null;
        if (isName(a[1])) { const pd = res ? this.doc.dict(res.get("Properties")) : null; const pr = pd ? this.doc.resolve(pd.get(a[1].n)) : null; props = isDict(pr) ? pr : null; if (isName(a[0], "OC") && props) hidden = this.ocHidden(pd!.get(a[1].n)); }
        else if (isDict(a[1])) props = a[1];
        this.mcStack.push(hidden); if (hidden) this.hiddenDepth++;
        this.dev.markedContent?.(isName(a[0]) ? a[0].n : "", props, true); break;
      }
      case "EMC": { const h = this.mcStack.pop(); if (h) this.hiddenDepth--; this.dev.markedContent?.("", null, false); break; }
      case "MP": case "DP": case "BX": case "EX": break;
      default: break; // unknown operators are ignored (§7.8.2)
    }
  }

  private paintFor(cs: ColorSpace): Paint { return { cs, comps: cs.initial(), pattern: null }; }
  private setColor(p: Paint, a: PObj[], res: PDict | null) {
    if (p.cs.pattern) {
      const last = a[a.length - 1]; const comps = a.filter(isNum) as number[];
      if (isName(last)) { p.pattern = this.pattern(last.n, res); if (p.pattern) { p.pattern.comps = comps; p.pattern.under = p.cs.base; } }
      return;
    }
    const comps = a.filter(isNum) as number[]; if (comps.length) p.comps = comps.slice(0, Math.max(1, p.cs.n));
  }
  private pattern(name: string, res: PDict | null): PatternRef | null {
    const pd = res ? this.doc.dict(res.get("Pattern")) : null; if (!pd) return null;
    const o = this.doc.resolve(pd.get(name)); const d = isStream(o) ? o.dict : isDict(o) ? o : null; if (!d) return null;
    const mt = this.doc.arr(d.get("Matrix")).map((x) => this.doc.num(x)); const matrix = (mt.length === 6 ? mt : IDENT.slice()) as M;
    const pt = this.doc.num(d.get("PatternType"), 1);
    if (pt === 2) { const sh = loadShading(this.doc, d.get("Shading"), res); return sh ? { kind: "shading", stream: d, matrix, shading: sh, doc: this.doc, resources: res } : null; }
    return isStream(o) ? { kind: "tiling", stream: o, matrix, doc: this.doc, resources: this.doc.dict(d.get("Resources")) ?? res } : null;
  }
  private extGState(name: PObj | undefined, res: PDict | null) {
    if (!isName(name) || !res) return;
    const eg = this.doc.dict(this.doc.dict(res.get("ExtGState"))?.get(name.n)); if (!eg) return;
    const gs = this.gs;
    for (const [k, v0] of eg.m) {
      const v = this.doc.resolve(v0);
      switch (k) {
        case "LW": if (isNum(v)) gs.lw = v; break; case "LC": if (isNum(v)) gs.cap = v; break; case "LJ": if (isNum(v)) gs.join = v; break;
        case "ML": if (isNum(v)) gs.miter = v; break;
        case "D": if (isArr(v)) { gs.dash = this.doc.arr(v[0]).map((x) => this.doc.num(x)); gs.dashPhase = this.doc.num(v[1]); } break;
        case "CA": if (isNum(v)) gs.strokeAlpha = v; break; case "ca": if (isNum(v)) gs.fillAlpha = v; break;
        case "BM": { const bm = isArr(v) ? this.doc.resolve(v[0]) : v; if (isName(bm)) gs.blend = BLEND[bm.n] ?? "source-over"; break; }
        case "SMask": gs.softMask = isDict(v) ? this.softMask(v) : null; break; // /None (or anything else) clears it
        case "Font": if (isArr(v) && v.length >= 2) { const f = this.doc.resolve(v[0]); if (isDict(f)) gs.font = this.fontFromDict(f); gs.fontSize = this.doc.num(v[1]); } break;
      }
    }
  }
  /** TT77: soft-mask dictionary → SoftMask (the group's colour space converts the backdrop BC to RGB) */
  private softMask(d: PDict): SoftMask | null {
    const g = this.doc.resolve(d.get("G")); if (!isStream(g)) return null;
    const st = this.doc.resolve(d.get("S")); const subtype = isName(st, "Alpha") ? "Alpha" : "Luminosity";
    const grp = this.doc.dict(g.dict.get("Group")); const csObj = grp?.get("CS");
    let bc: [number, number, number] | null = null; const bca = this.doc.arr(d.get("BC")).map((x) => this.doc.num(x));
    // BC absent: every component 0 in the group colour space (black for Gray/RGB, white for CMYK) — PDFium's reading
    try { const cs = csObj !== undefined ? loadColorSpace(this.doc, csObj, this.doc.dict(g.dict.get("Resources"))) : null; if (bca.length) bc = (cs ?? (bca.length === 1 ? DeviceGray : bca.length === 4 ? DeviceCMYK : DeviceRGB)).rgb(bca); else if (cs) bc = cs.rgb(new Array(cs.n).fill(0)); } catch { bc = null; }
    const tro = this.doc.resolve(d.get("TR")); let tr: PdfFn | null = null;
    if (tro !== undefined && !isName(tro, "Identity")) { try { tr = loadFunction(this.doc, tro); } catch { tr = null; } }
    return { subtype, group: g, bc, tr, ctm: this.gs.ctm, key: d };
  }
  private ocHidden(o: PObj | undefined): boolean {
    const h = this.opts.hiddenOCGs; if (!h || !h.size) return false;
    const d = this.doc.dict(o); if (!d) return false;
    if (isName(d.get("Type"), "OCMD")) {
      const ocgs = this.doc.resolve(d.get("OCGs")); const list = isArr(ocgs) ? ocgs : [d.get("OCGs")];
      const pol = this.doc.resolve(d.get("P")); const policy = isName(pol) ? pol.n : "AnyOn";
      const states = list.map((x) => !(isRef(x) && h.has(`${x.num}`)));
      if (!states.length) return false;
      if (policy === "AllOn") return !states.every(Boolean); if (policy === "AnyOff") return states.some((s) => !s); if (policy === "AllOff") return !states.every((s) => !s);
      return !states.some(Boolean);
    }
    return isRef(o) && h.has(`${o.num}`);
  }

  private paint(fill: boolean, stroke: boolean, eo: boolean) {
    const p = this.path; this.path = [];
    if (this.hiddenDepth === 0 && this.dev.wantsPaths && p.length) {
      // §11.7.4.4: a path both filled and stroked by one operator is a non-isolated knockout group of the two, so under
      // transparency the stroke composites with the backdrop, not with its own fill
      const gs = this.gs;
      const ko = fill && stroke && !!this.dev.beginGroup && (gs.blend !== "source-over" || gs.fillAlpha < 1 || gs.strokeAlpha < 1);
      const atDo: GState = ko ? { ...gs, fillAlpha: 1, strokeAlpha: 1, blend: "source-over", softMask: null } : gs;
      const open = ko && this.dev.beginGroup!(atDo, null, { isolated: false, knockout: true, blends: gs.blend !== "source-over" }) === true;
      try {
        if (fill) this.dev.fill(p, gs, eo);
        if (stroke) this.dev.stroke(p, gs);
      } finally { if (open && this.dev.endGroup) this.dev.endGroup(atDo); }
    }
    if (this.pendingClip && p.length) this.dev.clip(p, this.gs, this.pendingClip === 2);
    else if (this.pendingClip) this.dev.clip([], this.gs, false);
    this.pendingClip = 0;
  }

  /* -------------------------------------------------------------- fonts & text */
  private font(name: PObj | undefined, res: PDict | null): PdfFont | null {
    if (!isName(name) || !res) return null;
    const fd = this.doc.dict(res.get("Font")); if (!fd) return null;
    const ref = fd.get(name.n); const d = this.doc.dict(ref); if (!d) return null;
    return this.fontFromDict(d);
  }
  private fontFromDict(d: PDict): PdfFont {
    let f = this.fonts.get(d); if (!f) { f = PdfFont.load(this.doc, d); this.fonts.set(d, f); for (const w of f.warnings) if (this.warnings.length < 50 && !this.warnings.includes(w)) this.warnings.push(w); }
    return f;
  }
  private adjust(tj: number) {
    const gs = this.gs; const f = gs.font;
    if (f?.vertical) this.tm = mul([1, 0, 0, 1, 0, (-tj / 1000) * gs.fontSize], this.tm);
    else this.tm = mul([1, 0, 0, 1, (-tj / 1000) * gs.fontSize * gs.th, 0], this.tm);
  }
  private showText(b: Bytes, res: PDict | null) {
    const gs = this.gs; const f = gs.font; if (!f) return;
    const glyphs = f.decode(b); const fs = gs.fontSize;
    for (const g of glyphs) {
      const tw = g.space ? gs.tw : 0;
      let trm: M;
      if (f.vertical) {
        const vx = (g.vx ?? g.w / 2) / 1000, vy = (g.vyPos ?? 880) / 1000;
        trm = mul([fs * gs.th, 0, 0, fs, -vx * fs * gs.th, -vy * fs + gs.rise], mul(this.tm, gs.ctm));
      } else trm = mul([fs * gs.th, 0, 0, fs, 0, gs.rise], mul(this.tm, gs.ctm));
      const adv = f.vertical ? ((g.vy ?? -1000) / 1000) * fs + gs.tc + tw : ((g.w / 1000) * fs + gs.tc + tw) * gs.th;
      // width of the advance in user space (for the text device's word-gap logic)
      const ad = f.vertical ? apply(mul(this.tm, gs.ctm), 0, adv) : apply(mul(this.tm, gs.ctm), adv, 0); const o = apply(mul(this.tm, gs.ctm), 0, 0);
      const wUser = Math.hypot(ad[0] - o[0], ad[1] - o[1]);
      if (this.hiddenDepth === 0) {
        if (f.kind === "type3") this.type3(g, f, trm, wUser);
        else { const mode = gs.mode; if (mode !== 3 && mode !== 7 || !this.dev.wantsPaths) this.dev.glyph(g, f, trm, gs, wUser); }
        if (gs.mode >= 4) this.clipGlyphs.push({ g, font: f, trm });
      }
      this.tm = f.vertical ? mul([1, 0, 0, 1, 0, adv], this.tm) : mul([1, 0, 0, 1, adv, 0], this.tm);
    }
    void res;
  }
  private type3(g: Glyph, f: PdfFont, trm: M, wUser: number) {
    this.dev.type3Glyph?.(g, f, trm, this.gs, wUser);
    if (!this.dev.wantsPaths || !f.charProcs || !g.name || this.depth > 6) return;
    const cp = this.doc.resolve(f.charProcs.get(g.name)); if (!isStream(cp)) return;
    const fm = f.fontMatrix as M;
    const saved = this.saveFull(); this.save();
    this.gs.ctm = mul(fm, trm); this.depth++;
    const prevUn = this.t3Uncolored; this.t3Uncolored = false;
    try { this.run(this.doc.decode(cp).data, f.resources ?? null); } finally { this.depth--; this.t3Uncolored = prevUn; }
    this.restore(); this.loadFull(saved);
  }
  private saveFull() { return { tm: this.tm, tlm: this.tlm, inText: this.inText, path: this.path, stack: this.stack.length }; }
  private loadFull(s: { tm: M; tlm: M; inText: boolean; path: Path; stack: number }) { while (this.stack.length > s.stack) this.restore(); this.tm = s.tm; this.tlm = s.tlm; this.inText = s.inText; this.path = s.path; }

  /* -------------------------------------------------------------- XObjects & images */
  private xobject(name: PObj | undefined, res: PDict | null) {
    if (!isName(name) || !res || this.hiddenDepth) return;
    const xd = this.doc.dict(res.get("XObject")); if (!xd) return;
    const ref = xd.get(name.n); const x = this.doc.resolve(ref); if (!isStream(x)) return;
    const st = this.doc.resolve(x.dict.get("Subtype"));
    if (x.dict.has("OC") && this.ocHidden(x.dict.get("OC"))) return;
    if (isName(st, "Image")) { if (this.dev.wantsImages) { const img = loadImage(this.doc, x, res); if (img) this.dev.image(img, this.gs); } return; }
    if (isName(st, "Form")) this.form(x, res, ref);
  }
  /** run a form XObject (also used for annotation appearances) */
  form(x: PStream, res: PDict | null, ref?: PObj, extra?: M) {
    if (this.depth > 12) { this.warnings.push("form nesting too deep"); return; }
    const id = isRef(ref) ? ref.num : -1;
    if (id >= 0 && this.formStack.includes(id)) { this.warnings.push(`form XObject ${id} draws itself`); return; }
    const mt = this.doc.arr(x.dict.get("Matrix")).map((v) => this.doc.num(v)); const m = (mt.length === 6 ? mt : IDENT) as M;
    const bb = this.doc.arr(x.dict.get("BBox")).map((v) => this.doc.num(v));
    const saved = this.saveFull(); this.save();
    if (extra) this.gs.ctm = mul(extra, this.gs.ctm);
    this.gs.ctm = mul(m, this.gs.ctm);
    if (bb.length === 4) this.dev.clip([0, bb[0], bb[1], 1, bb[2], bb[1], 1, bb[2], bb[3], 1, bb[0], bb[3], 4], this.gs, false);
    const group = this.doc.dict(x.dict.get("Group"));
    if (group && this.dev.beginGroup) {
      const egs = this.doc.dict(this.doc.dict(x.dict.get("Resources"))?.get("ExtGState")); let blends = false;
      if (egs) for (const [, e] of egs.m) { const bm0 = this.doc.dict(e)?.get("BM"); const bm = isArr(this.doc.resolve(bm0)) ? this.doc.resolve((this.doc.resolve(bm0) as PObj[])[0]) : this.doc.resolve(bm0); if (isName(bm) && bm.n !== "Normal" && bm.n !== "Compatible") { blends = true; break; } }
      const info: GroupInfo = { isolated: this.doc.resolve(group.get("I")) === true, knockout: this.doc.resolve(group.get("K")) === true, blends };
      // §11.6.6: the alpha, blend mode and soft mask at Do apply to the group as a whole and are reset inside it
      if (this.dev.beginGroup(this.gs, bb.length === 4 ? bb : null, info) === true) { this.gs.fillAlpha = 1; this.gs.strokeAlpha = 1; this.gs.blend = "source-over"; this.gs.softMask = null; }
    }
    this.depth++; this.formStack.push(id);
    const fres = this.doc.dict(x.dict.get("Resources")) ?? res;
    const t3 = this.t3Uncolored;
    // endGroup runs even when the content throws (deadline), so a compositing device never stays inside a layer
    try { this.run(this.doc.decode(x).data, fres); } finally { this.depth--; this.formStack.pop(); this.t3Uncolored = t3; if (group && this.dev.endGroup) this.dev.endGroup(this.gs); }
    this.restore(); this.loadFull(saved);
  }
  private formStack: number[] = [];
  private inlineImage(lx: Lexer, res: PDict | null) {
    const d = new PDict();
    for (let g = 0; g < 256; g++) {
      const k = lx.next(); if (k === undefined) return;
      if (k instanceof PKw && k.k === "ID") break;
      if (!(k instanceof PName)) continue;
      const save = lx.p; let v: PObj;
      try { v = parseObj(lx, 0); } catch { lx.p = save; v = null; }
      d.set(k.n, v);
    }
    const b = lx.b; let p = lx.p; if (b[p] === 32 || b[p] === 10 || b[p] === 13) p++;
    // find "EI" preceded by whitespace and followed by whitespace/EOF, then sanity-check the next tokens
    let end = -1;
    const L = d.get("L") ?? d.get("Length");
    if (isNum(L) && p + L <= b.length) { let q = p + L; while (q < b.length && (b[q] === 32 || b[q] === 10 || b[q] === 13)) q++; if (b[q] === 0x45 && b[q + 1] === 0x49) end = p + L; }
    for (let q = p; end < 0 && q + 1 < b.length; q++) {
      if (b[q] === 0x45 && b[q + 1] === 0x49 && (q === p || b[q - 1] <= 32) && (q + 2 >= b.length || b[q + 2] <= 32 || b[q + 2] === 0x51 /* Q */)) {
        // the bytes after EI should look like operators (ASCII), not binary image data
        let ok = true; for (let r = q + 2; r < Math.min(b.length, q + 12); r++) if (b[r] > 126 || (b[r] < 32 && b[r] !== 10 && b[r] !== 13 && b[r] !== 9)) { ok = false; break; }
        if (ok) end = q > p && (b[q - 1] === 10 || b[q - 1] === 32 || b[q - 1] === 13) ? q - 1 : q;
      }
    }
    if (end < 0) end = b.length;
    const raw = b.subarray(p, end);
    lx.p = Math.min(b.length, end + 3 + (b[end] === 0x45 ? 0 : 1));
    // move past "EI"
    const ei = indexOfFrom(b, end, 16); if (ei >= 0) lx.p = ei + 2;
    if (this.hiddenDepth || !this.dev.wantsImages) return;
    const img = loadImage(this.doc, { dict: d, raw }, res, true);
    if (img) this.dev.image(img, this.gs);
  }
}
function indexOfFrom(b: Bytes, from: number, span: number) { for (let q = from; q + 1 < b.length && q < from + span; q++) if (b[q] === 0x45 && b[q + 1] === 0x49) return q; return -1; }
const BLEND: Record<string, string> = { Normal: "source-over", Compatible: "source-over", Multiply: "multiply", Screen: "screen", Overlay: "overlay", Darken: "darken", Lighten: "lighten", ColorDodge: "color-dodge", ColorBurn: "color-burn", HardLight: "hard-light", SoftLight: "soft-light", Difference: "difference", Exclusion: "exclusion", Hue: "hue", Saturation: "saturation", Color: "color", Luminosity: "luminosity" };

/** OCGs hidden in the default configuration (§8.11.4.3: /D /BaseState, /ON, /OFF) */
export function hiddenOCGs(doc: PdfDoc): Set<string> {
  const out = new Set<string>(); const ocp = doc.dict(doc.catalog()?.get("OCProperties")); if (!ocp) return out;
  const d = doc.dict(ocp.get("D")); if (!d) return out;
  const base = doc.resolve(d.get("BaseState"));
  if (isName(base, "OFF")) { for (const r of doc.arr(ocp.get("OCGs"))) if (isRef(r)) out.add(`${r.num}`); for (const r of doc.arr(d.get("ON"))) if (isRef(r)) out.delete(`${r.num}`); }
  for (const r of doc.arr(d.get("OFF"))) if (isRef(r)) out.add(`${r.num}`);
  return out;
}

/** annotation appearance placement (§12.5.5): the form's BBox×Matrix is mapped onto the annotation Rect */
export function appearanceMatrix(doc: PdfDoc, ap: PStream, rect: number[]): M {
  const mt = doc.arr(ap.dict.get("Matrix")).map((v) => doc.num(v)); const m = (mt.length === 6 ? mt : IDENT) as M;
  const bb = doc.arr(ap.dict.get("BBox")).map((v) => doc.num(v)); const box = bb.length === 4 ? bb : [0, 0, 1, 1];
  const pts = [apply(m, box[0], box[1]), apply(m, box[2], box[1]), apply(m, box[2], box[3]), apply(m, box[0], box[3])];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const sx = x1 - x0 ? (rx1 - rx0) / (x1 - x0) : 1, sy = y1 - y0 ? (ry1 - ry0) / (y1 - y0) : 1;
  return [sx, 0, 0, sy, rx0 - x0 * sx, ry0 - y0 * sy]; // A = translate/scale; the form Matrix itself is applied by form()
}

/** run the visible annotations' normal appearances on a page (after the page content) */
export function runAnnotations(doc: PdfDoc, page: PdfPage, interp: Interpreter, dev: Device, forPrint = false, skip?: (a: PDict) => boolean) {
  for (const ao of doc.arr(page.dict.get("Annots"))) {
    const a = doc.dict(ao); if (!a) continue;
    if (skip?.(a)) continue;
    const flags = doc.num(a.get("F"), 0);
    if (flags & 2) continue; // Hidden
    if (forPrint ? !(flags & 4) : flags & 32) continue; // Print / NoView
    const st = doc.resolve(a.get("Subtype")); if (isName(st, "Popup")) continue;
    const rect = doc.arr(a.get("Rect")).map((v) => doc.num(v)); if (rect.length !== 4) continue;
    if (a.has("OC") && interp["ocHidden"](a.get("OC"))) continue;
    const apd = doc.dict(a.get("AP"));
    let n = apd ? doc.resolve(apd.get("N")) : undefined;
    if (isDict(n)) { const as = doc.resolve(a.get("AS")); n = isName(as) ? doc.resolve(n.get(as.n)) : null; }
    if (!isStream(n)) {
      if (apd) continue; // an appearance dictionary whose state is off: nothing to draw
      const syn = synthAppearance(doc, a); if (!syn) continue;
      dev.annotBegin?.(rect, a); interp.runAt(new TextEncoder().encode(syn.content), syn.resources, IDENT); dev.annotEnd?.();
      continue;
    }
    dev.annotBegin?.(rect, a);
    interp.form(n, page.resources, undefined, appearanceMatrix(doc, n, rect));
    dev.annotEnd?.();
  }
}
export { PStr, PDict, PStream };
