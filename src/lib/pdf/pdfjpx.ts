/**
 * TT77 — JPEG 2000 Part 1 decoder (ITU-T T.800) for the PDF /JPXDecode filter. Original code written for Fusion from the
 * structure of T.800: JP2 boxes (ihdr, colr, pclr, cmap, cdef), the codestream (SIZ, COD/COC, QCD/QCC, RGN, POC,
 * PPM/PPT, SOT/SOD, SOP/EPH), tiles and tile-parts, all five progression orders, precincts and code-blocks, tag trees,
 * Tier-1 EBCOT (significance / refinement / cleanup passes, run-length mode, the code-block style flags: selective
 * bypass, context reset, termination on each pass, vertically causal contexts, segmentation symbols), scalar
 * dequantisation (derived / expounded), the reversible 5/3 and irreversible 9/7 inverse wavelets with symmetric
 * extension, RCT / ICT, DC level shift and component subsampling. The MQ decoder is the one shared with JBIG2.
 *
 * Verified against PDFium's decoded image bitmaps and against OpenJPEG (via Pillow) on generated codestreams
 * (scripts/tt77-pdf.mts, tests J2–J4).
 *
 * Bounded: image area capped (MAX_PIXELS), loops bounded by the data, damaged tiles keep what decoded (`partial`).
 */
import { MQDecoder } from "./pdfjbig2";

type Bytes = Uint8Array;
const MAX_PIXELS = 1 << 26; // 67 M samples per component

export interface JpxResult {
  width: number; height: number;
  /** colour channels, interleaved, 8 bits each */
  comps: number; data: Uint8Array;
  /** opacity channel from cdef (for /SMaskInData) */
  alpha: Uint8Array | null;
  /** colour space announced by the JP2 header: "gray" | "rgb" | "cmyk" | "ycc" | null (raw codestream / ICC) */
  cs: string | null;
  partial: boolean; warnings: string[];
}

/* ------------------------------------------------------------------ JP2 boxes */
interface Jp2Info { code: Bytes | null; enumCs: number | null; palette: { entries: number[][]; depths: number[] } | null; cmap: { cmp: number; mtyp: number; pcol: number }[] | null; cdef: { c: number; typ: number; asoc: number }[] | null }
function readBoxes(d: Bytes): Jp2Info {
  const info: Jp2Info = { code: null, enumCs: null, palette: null, cmap: null, cdef: null };
  const walk = (s: number, e: number, depth: number) => {
    let p = s;
    for (let g = 0; p + 8 <= e && g < 4096; g++) {
      let len = u32(d, p); const type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]); let hdr = 8;
      if (len === 1) { len = u32(d, p + 8) * 2 ** 32 + u32(d, p + 12); hdr = 16; } else if (len === 0) len = e - p;
      if (len < hdr) break;
      const bs = p + hdr, be = Math.min(e, p + len);
      if (type === "jp2h" && depth < 3) walk(bs, be, depth + 1);
      else if (type === "jp2c" && !info.code) info.code = d.subarray(bs, be);
      else if (type === "colr" && d[bs] === 1 && info.enumCs === null) info.enumCs = u32(d, bs + 3);
      else if (type === "pclr") {
        const ne = u16(d, bs), npc = d[bs + 2]; const depths: number[] = []; for (let i = 0; i < npc; i++) depths.push((d[bs + 3 + i] & 0x7f) + 1);
        let q = bs + 3 + npc; const entries: number[][] = [];
        for (let i = 0; i < ne && i < 4096; i++) { const row: number[] = []; for (let j = 0; j < npc; j++) { const nb = Math.ceil(depths[j] / 8); let v = 0; for (let k = 0; k < nb; k++) v = v * 256 + (d[q++] ?? 0); row.push(v); } entries.push(row); }
        info.palette = { entries, depths };
      } else if (type === "cmap") { const out = []; for (let q = bs; q + 4 <= be; q += 4) out.push({ cmp: u16(d, q), mtyp: d[q + 2], pcol: d[q + 3] }); info.cmap = out; }
      else if (type === "cdef") { const n = u16(d, bs); const out = []; for (let i = 0; i < n; i++) out.push({ c: u16(d, bs + 2 + 6 * i), typ: u16(d, bs + 4 + 6 * i), asoc: u16(d, bs + 6 + 6 * i) }); info.cdef = out; }
      p = p + len;
    }
  };
  if (d.length >= 2 && d[0] === 0xff && d[1] === 0x4f) { info.code = d; return info; }
  walk(0, d.length, 0);
  if (!info.code) { const i = findSOC(d); if (i >= 0) info.code = d.subarray(i); } // damaged box structure: find the codestream
  return info;
}
function findSOC(d: Bytes) { for (let i = 0; i + 4 < d.length; i++) if (d[i] === 0xff && d[i + 1] === 0x4f && d[i + 2] === 0xff && d[i + 3] === 0x51) return i; return -1; }
const u32 = (d: Bytes, p: number) => ((d[p] << 24) >>> 0) + (d[p + 1] << 16) + (d[p + 2] << 8) + d[p + 3];
const u16 = (d: Bytes, p: number) => ((d[p] << 8) | d[p + 1]) >>> 0;

/* ------------------------------------------------------------------ codestream parameters */
interface Comp { depth: number; signed: boolean; dx: number; dy: number }
interface CodingStyle { precincts: boolean; levels: number; xcb: number; ycb: number; cbstyle: number; reversible: boolean; ppx: number[]; ppy: number[] }
interface Quant { style: number; guard: number; eps: number[]; mu: number[] }
interface Cod { sop: boolean; eph: boolean; order: number; layers: number; mct: number }
interface Poc { rs: number; cs: number; lye: number; re: number; ce: number; order: number }
interface Siz { X: number; Y: number; X0: number; Y0: number; TW: number; TH: number; TX0: number; TY0: number; comps: Comp[] }
interface Params { cod: Cod; cs: CodingStyle[]; q: Quant[]; roi: number[]; poc: Poc[] }

function parseCodingStyle(d: Bytes, p: number, scod: number): CodingStyle {
  const levels = d[p], xcb = (d[p + 1] & 15) + 2, ycb = (d[p + 2] & 15) + 2, cbstyle = d[p + 3], reversible = d[p + 4] === 1;
  const ppx: number[] = [], ppy: number[] = [];
  for (let r = 0; r <= levels; r++) { if (scod & 1) { const b = d[p + 5 + r] ?? 0xff; ppx.push(b & 15); ppy.push(b >> 4); } else { ppx.push(15); ppy.push(15); } }
  return { precincts: !!(scod & 1), levels: Math.min(levels, 32), xcb, ycb, cbstyle, reversible, ppx, ppy };
}
function parseQuant(d: Bytes, p: number, end: number): Quant {
  const s = d[p]; const style = s & 0x1f, guard = s >> 5; const eps: number[] = [], mu: number[] = [];
  if (style === 0) for (let q = p + 1; q < end; q++) { eps.push(d[q] >> 3); mu.push(0); }
  else for (let q = p + 1; q + 1 < end; q += 2) { const v = u16(d, q); eps.push(v >> 11); mu.push(v & 0x7ff); }
  return { style, guard, eps, mu };
}

/* ------------------------------------------------------------------ tag trees (B.10.2) */
class TagTree {
  private lv: { w: number; h: number; low: Int32Array; val: Int32Array }[] = [];
  constructor(w: number, h: number) {
    for (let g = 0; g < 32; g++) { this.lv.push({ w, h, low: new Int32Array(w * h), val: new Int32Array(w * h).fill(-1) }); if (w <= 1 && h <= 1) break; w = (w + 1) >> 1; h = (h + 1) >> 1; }
  }
  /** decode the leaf (x, y) against `thr`: its value when it is below `thr`, otherwise -1 */
  read(bit: () => number, x: number, y: number, thr: number): number {
    let low = 0;
    for (let k = this.lv.length - 1; k >= 0; k--) {
      const L = this.lv[k]; const i = (y >> k) * L.w + (x >> k);
      if (L.low[i] < low) L.low[i] = low;
      while (L.val[i] < 0 && L.low[i] < thr) { if (bit()) L.val[i] = L.low[i]; else L.low[i]++; }
      if (L.val[i] < 0) return -1;
      low = L.val[i];
    }
    return low;
  }
}

/* ------------------------------------------------------------------ packet header bits (B.10.1) */
class HeaderBits {
  d: Bytes; p: number; end: number; private buf = 0; private n = 0; private ff = false;
  constructor(d: Bytes, p: number, end: number) { this.d = d; this.p = p; this.end = end; }
  bit = (): number => {
    if (this.n === 0) { const b = this.p < this.end ? this.d[this.p] : 0; this.p++; this.n = this.ff ? 7 : 8; this.ff = b === 0xff; this.buf = b; }
    this.n--; return (this.buf >> this.n) & 1;
  };
  bits(k: number) { let v = 0; for (let i = 0; i < k; i++) v = (v << 1) | this.bit(); return v; }
  align() { this.n = 0; if (this.ff) { this.p++; this.ff = false; } }
}

/* ------------------------------------------------------------------ tile structure */
interface CodeBlock { x0: number; y0: number; x1: number; y1: number; included: boolean; zbp: number; lblock: number; passes: number; chunks: { data: Bytes[]; passes: number }[]; segLeft: number }
interface Band { type: number; /* 0 LL, 1 HL, 2 LH, 3 HH */ x0: number; y0: number; x1: number; y1: number; nb: number; cbw: number; cbh: number; eps: number; mu: number; coeffs: Float64Array | Int32Array | null }
interface PrecBand { band: Band; cbs: CodeBlock[]; ncx: number; ncy: number; incl: TagTree; zbp: TagTree }
interface Precinct { bands: PrecBand[]; refX: number; refY: number }
interface Res { x0: number; y0: number; x1: number; y1: number; bands: Band[]; pw: number; ph: number; precincts: Precinct[]; ppx: number; ppy: number }
interface TileComp { x0: number; y0: number; x1: number; y1: number; res: Res[]; cs: CodingStyle; q: Quant; roi: number; data: Float64Array | null }

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);
const LOG2 = (n: number) => Math.floor(Math.log2(n));

function buildTileComp(siz: Siz, c: number, tx0: number, ty0: number, tx1: number, ty1: number, cs: CodingStyle, q: Quant, roi: number): TileComp {
  const C = siz.comps[c];
  const tc: TileComp = { x0: ceilDiv(tx0, C.dx), y0: ceilDiv(ty0, C.dy), x1: ceilDiv(tx1, C.dx), y1: ceilDiv(ty1, C.dy), res: [], cs, q, roi, data: null };
  const NL = cs.levels;
  for (let r = 0; r <= NL; r++) {
    const s = 2 ** (NL - r);
    const res: Res = { x0: ceilDiv(tc.x0, s), y0: ceilDiv(tc.y0, s), x1: ceilDiv(tc.x1, s), y1: ceilDiv(tc.y1, s), bands: [], pw: 0, ph: 0, precincts: [], ppx: cs.ppx[r], ppy: cs.ppy[r] };
    const types = r === 0 ? [0] : [1, 2, 3];
    for (const type of types) {
      const nb = r === 0 ? NL : NL - r + 1; const sb = 2 ** nb; const xo = type & 1 ? 1 : 0, yo = type & 2 ? 1 : 0;
      const sbo = r === 0 ? 0 : 2 ** (nb - 1);
      const b: Band = { type, nb, x0: ceilDiv(tc.x0 - sbo * xo, sb), y0: ceilDiv(tc.y0 - sbo * yo, sb), x1: ceilDiv(tc.x1 - sbo * xo, sb), y1: ceilDiv(tc.y1 - sbo * yo, sb), cbw: 0, cbh: 0, eps: 0, mu: 0, coeffs: null };
      // quantisation parameters of this band (E.1): band index in QCD order is 0 for LL, then 3·(NL−nb) + type
      const bi = r === 0 ? 0 : 3 * (r - 1) + type;
      if (q.style === 1) { b.eps = q.eps[0] - (NL - nb); b.mu = q.mu[0]; } else { b.eps = q.eps[bi] ?? q.eps[q.eps.length - 1] ?? 0; b.mu = q.mu[bi] ?? 0; }
      res.bands.push(b);
    }
    // precinct partition (B.6) on the resolution grid
    const PPx = res.ppx, PPy = res.ppy;
    res.pw = res.x1 > res.x0 ? ceilDiv(res.x1, 2 ** PPx) - Math.floor(res.x0 / 2 ** PPx) : 0;
    res.ph = res.y1 > res.y0 ? ceilDiv(res.y1, 2 ** PPy) - Math.floor(res.y0 / 2 ** PPy) : 0;
    if (res.pw * res.ph > 1 << 20) throw new Error("JPX: too many precincts");
    const xcb = Math.min(cs.xcb, r === 0 ? PPx : PPx - 1), ycb = Math.min(cs.ycb, r === 0 ? PPy : PPy - 1);
    const px0 = Math.floor(res.x0 / 2 ** PPx), py0 = Math.floor(res.y0 / 2 ** PPy);
    for (let j = 0; j < res.ph; j++) for (let i = 0; i < res.pw; i++) {
      const rx0 = Math.max(res.x0, (px0 + i) * 2 ** PPx), ry0 = Math.max(res.y0, (py0 + j) * 2 ** PPy);
      const rx1 = Math.min(res.x1, (px0 + i + 1) * 2 ** PPx), ry1 = Math.min(res.y1, (py0 + j + 1) * 2 ** PPy);
      const prec: Precinct = { bands: [], refX: rx0 * C.dx * 2 ** (NL - r), refY: ry0 * C.dy * 2 ** (NL - r) };
      for (const b of res.bands) {
        // the precinct's area in band coordinates
        const f = r === 0 ? 1 : 2;
        const bx0 = Math.max(b.x0, ceilDiv((px0 + i) * 2 ** PPx, f)), by0 = Math.max(b.y0, ceilDiv((py0 + j) * 2 ** PPy, f));
        const bx1 = Math.min(b.x1, ceilDiv((px0 + i + 1) * 2 ** PPx, f)), by1 = Math.min(b.y1, ceilDiv((py0 + j + 1) * 2 ** PPy, f));
        const cbs: CodeBlock[] = []; let ncx = 0, ncy = 0;
        if (bx1 > bx0 && by1 > by0) {
          const cx0 = Math.floor(bx0 / 2 ** xcb), cy0 = Math.floor(by0 / 2 ** ycb);
          ncx = ceilDiv(bx1, 2 ** xcb) - cx0; ncy = ceilDiv(by1, 2 ** ycb) - cy0;
          for (let v = 0; v < ncy; v++) for (let u = 0; u < ncx; u++) cbs.push({ x0: Math.max(bx0, (cx0 + u) * 2 ** xcb), y0: Math.max(by0, (cy0 + v) * 2 ** ycb), x1: Math.min(bx1, (cx0 + u + 1) * 2 ** xcb), y1: Math.min(by1, (cy0 + v + 1) * 2 ** ycb), included: false, zbp: 0, lblock: 3, passes: 0, chunks: [], segLeft: 0 });
        }
        b.cbw = 2 ** xcb; b.cbh = 2 ** ycb;
        prec.bands.push({ band: b, cbs, ncx, ncy, incl: new TagTree(Math.max(1, ncx), Math.max(1, ncy)), zbp: new TagTree(Math.max(1, ncx), Math.max(1, ncy)) });
      }
      void rx1; void ry1;
      res.precincts.push(prec);
    }
    tc.res.push(res);
  }
  return tc;
}

/* ------------------------------------------------------------------ packets (B.9, B.10) */
const BYPASS = 1, RESET = 2, TERMALL = 4, VCAUSAL = 8, SEGSYM = 0x20;
/** passes a new codeword segment may hold, given the passes already in the block */
function segCapacity(style: number, passesSoFar: number): number {
  if (style & TERMALL) return 1;
  if (style & BYPASS) { if (passesSoFar < 10) return 10 - passesSoFar; return (passesSoFar - 10) % 3 === 2 ? 1 : 2 - ((passesSoFar - 10) % 3); }
  return Infinity;
}
function readPacket(hb: HeaderBits, body: { d: Bytes; p: number; end: number }, prec: Precinct, layer: number, cod: Cod, cbstyle: number, sepHeaders: boolean): void {
  const d = body.d;
  if (cod.sop && body.p + 6 <= body.end && d[body.p] === 0xff && d[body.p + 1] === 0x91) body.p += 6; // SOP stays in the body
  if (!sepHeaders) hb.p = body.p;
  const contrib: { cb: CodeBlock; lens: number[]; passes: number[] }[] = [];
  if (hb.bit()) {
    for (const pb of prec.bands) {
      for (let k = 0; k < pb.cbs.length; k++) {
        const cb = pb.cbs[k]; const u = k % pb.ncx, v = Math.floor(k / pb.ncx);
        let inc: boolean;
        if (!cb.included) { const iv = pb.incl.read(hb.bit, u, v, layer + 1); inc = iv >= 0 && iv <= layer; }
        else inc = hb.bit() === 1;
        if (!inc) continue;
        if (!cb.included) { let z = -1; for (let t = 1; t < 80 && z < 0; t++) z = pb.zbp.read(hb.bit, u, v, t); cb.zbp = Math.max(0, z); cb.included = true; }
        // number of coding passes (Table B.4)
        let n: number;
        if (!hb.bit()) n = 1; else if (!hb.bit()) n = 2; else { const a = hb.bits(2); if (a < 3) n = 3 + a; else { const b = hb.bits(5); n = b < 31 ? 6 + b : 37 + hb.bits(7); } }
        while (hb.bit()) cb.lblock++;
        const lens: number[] = [], passes: number[] = []; let left = n; let done = cb.passes;
        while (left > 0) {
          const cap = segCapacity(cbstyle, done); const take = Math.min(left, cap === Infinity ? left : cap);
          lens.push(hb.bits(cb.lblock + LOG2(take))); passes.push(take); left -= take; done += take;
        }
        contrib.push({ cb, lens, passes });
      }
    }
  }
  hb.align();
  if (cod.eph && hb.d[hb.p] === 0xff && hb.d[hb.p + 1] === 0x92) hb.p += 2; // EPH follows the header wherever it lives
  if (!sepHeaders) body.p = hb.p;
  for (const { cb, lens, passes } of contrib) {
    for (let s = 0; s < lens.length; s++) {
      const len = Math.min(lens[s], Math.max(0, body.end - body.p)); const chunk = d.subarray(body.p, body.p + len); body.p += lens[s];
      // continue the open segment when it still has room, otherwise start a new one
      const last = cb.chunks[cb.chunks.length - 1];
      if (last && cb.segLeft > 0) { last.data.push(chunk); last.passes += passes[s]; cb.segLeft -= passes[s]; }
      else { const cap = segCapacity(cbstyle, cb.passes); cb.chunks.push({ data: [chunk], passes: passes[s] }); cb.segLeft = cap === Infinity ? Infinity : cap - passes[s]; }
      cb.passes += passes[s];
    }
  }
}

/* ------------------------------------------------------------------ Tier-1 (D) */
const ZC_LL = new Uint8Array(256), ZC_HL = new Uint8Array(256), ZC_HH = new Uint8Array(256);
(() => {
  for (let h = 0; h <= 2; h++) for (let v = 0; v <= 2; v++) for (let dd = 0; dd <= 4; dd++) {
    const i = (h << 5) | (v << 3) | dd;
    const zl = (H: number, V: number) => (H === 2 ? 8 : H === 1 ? (V >= 1 ? 7 : dd >= 1 ? 6 : 5) : V === 2 ? 4 : V === 1 ? 3 : dd >= 2 ? 2 : dd === 1 ? 1 : 0);
    ZC_LL[i] = zl(h, v); ZC_HL[i] = zl(v, h);
    const hv = h + v; ZC_HH[i] = dd >= 3 ? 8 : dd === 2 ? (hv >= 1 ? 7 : 6) : dd === 1 ? (hv >= 2 ? 5 : hv === 1 ? 4 : 3) : hv >= 2 ? 2 : hv === 1 ? 1 : 0;
  }
})();
const freshCx = () => { const c = new Uint8Array(19); c[0] = 4 << 1; c[17] = 3 << 1; c[18] = 46 << 1; return c; };
class RawBits {
  private d: Bytes; private p: number; private end: number; private buf = 0; private n = 0; private ff = false;
  constructor(d: Bytes) { this.d = d; this.p = 0; this.end = d.length; }
  bit(): number { if (this.n === 0) { const b = this.p < this.end ? this.d[this.p] : 0xff; this.p++; this.n = this.ff ? 7 : 8; this.ff = b === 0xff; this.buf = b; } this.n--; return (this.buf >> this.n) & 1; }
}
const concat = (parts: Bytes[]) => { if (parts.length === 1) return parts[0]; let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };

/** decode one code-block into signed magnitudes (at plane resolution) plus the lowest plane reached per sample */
function decodeBlock(cb: CodeBlock, bandType: number, mb: number, style: number): { mag: Int32Array; neg: Uint8Array; lp: Int8Array } | null {
  const w = cb.x1 - cb.x0, h = cb.y1 - cb.y0; if (w <= 0 || h <= 0 || !cb.passes) return null;
  const W = w + 2; const sig = new Uint8Array(W * (h + 2)); const neg = new Uint8Array(w * h); const mag = new Int32Array(w * h);
  const vis = new Uint8Array(w * h), refd = new Uint8Array(w * h), newSig = new Uint8Array(w * h);
  const lp = new Int8Array(w * h); // the lowest bit-plane decoded for each coefficient (its reconstruction precision)
  const zc = bandType === 1 ? ZC_HL : bandType === 3 ? ZC_HH : ZC_LL;
  let plane = mb - 1 - cb.zbp; if (plane < 0 || plane > 30) return { mag, neg, lp };
  let cx = freshCx();
  const vc = !!(style & VCAUSAL);
  const S = (x: number, y: number) => sig[(y + 1) * W + x + 1];
  // neighbourhood code: h (0–2), v (0–2), d (0–4); vertically causal mode ignores the row below a stripe
  const nbr = (x: number, y: number) => {
    const below = !(vc && (y & 3) === 3);
    const hh = S(x - 1, y) + S(x + 1, y), vv = S(x, y - 1) + (below ? S(x, y + 1) : 0), dd = S(x - 1, y - 1) + S(x + 1, y - 1) + (below ? S(x - 1, y + 1) + S(x + 1, y + 1) : 0);
    return (hh << 5) | (vv << 3) | dd;
  };
  const signOf = (x: number, y: number) => (S(x, y) ? (neg[y * w + x] ? -1 : 1) : 0);
  const decodeSign = (mq: MQDecoder, x: number, y: number) => {
    const below = !(vc && (y & 3) === 3);
    let H = signOf(x - 1, y) + signOf(x + 1, y); let V = signOf(x, y - 1) + (below && y + 1 < h ? signOf(x, y + 1) : 0);
    H = H > 0 ? 1 : H < 0 ? -1 : 0; V = V > 0 ? 1 : V < 0 ? -1 : 0;
    let ctx: number, xr: number;
    if (H === 1) { ctx = V === 1 ? 13 : V === 0 ? 12 : 11; xr = 0; }
    else if (H === 0) { ctx = V === 0 ? 9 : 10; xr = V === -1 ? 1 : 0; }
    else { ctx = V === 1 ? 11 : V === 0 ? 12 : 13; xr = 1; }
    return mq.bit(cx, ctx) ^ xr;
  };
  const setSig = (x: number, y: number, negative: number) => { sig[(y + 1) * W + x + 1] = 1; neg[y * w + x] = negative; mag[y * w + x] = 1 << plane; newSig[y * w + x] = 1; lp[y * w + x] = plane; };
  // segment bookkeeping
  let seg = 0, segPassLeft = cb.chunks[0]?.passes ?? 0; let mq: MQDecoder | null = null; let raw: RawBits | null = null;
  const openSegment = (isRaw: boolean) => { const data = concat(cb.chunks[seg]?.data ?? [new Uint8Array(0)]); if (isRaw) { raw = new RawBits(data); mq = null; } else { mq = new MQDecoder(data); raw = null; } };
  for (let pass = 0; pass < cb.passes && plane >= 0; pass++) {
    const type = pass === 0 ? 2 : (pass - 1) % 3; // 0 SPP, 1 MRP, 2 cleanup
    const isRaw = !!(style & BYPASS) && pass >= 10 && type !== 2;
    if (pass === 0 || segPassLeft === 0) {
      if (pass > 0) { seg++; segPassLeft = cb.chunks[seg]?.passes ?? 0; if (!cb.chunks[seg]) break; }
      openSegment(isRaw);
    } else if (isRaw && !raw) openSegment(true); // (cannot happen with valid segmentation; defensive)
    segPassLeft--;
    const M = mq as MQDecoder | null, R = raw as RawBits | null;
    const rd = (ctxI: number) => (R ? R.bit() : M!.bit(cx, ctxI));
    if (type === 0) { // significance propagation
      for (let y0 = 0; y0 < h; y0 += 4) for (let x = 0; x < w; x++) for (let y = y0; y < Math.min(h, y0 + 4); y++) {
        const i = y * w + x; if (S(x, y)) continue; const n = nbr(x, y); if (!n) continue;
        vis[i] = 1;
        if (rd(zc[n])) { const s = R ? R.bit() : decodeSign(M!, x, y); setSig(x, y, s); }
      }
    } else if (type === 1) { // magnitude refinement
      for (let y0 = 0; y0 < h; y0 += 4) for (let x = 0; x < w; x++) for (let y = y0; y < Math.min(h, y0 + 4); y++) {
        const i = y * w + x; if (!S(x, y) || vis[i] || newSig[i]) continue;
        const ctxI = refd[i] ? 16 : nbr(x, y) ? 15 : 14;
        if (rd(ctxI)) mag[i] |= 1 << plane;
        refd[i] = 1; lp[i] = plane;
      }
    } else { // cleanup
      const m = M!;
      for (let y0 = 0; y0 < h; y0 += 4) for (let x = 0; x < w; x++) {
        let y = y0; const y1 = Math.min(h, y0 + 4);
        if (y1 - y0 === 4) {
          let runOk = true; for (let k = y0; k < y1 && runOk; k++) { const i = k * w + x; if (S(x, k) || vis[i] || nbr(x, k)) runOk = false; }
          if (runOk) {
            if (!m.bit(cx, 17)) continue;
            const r = (m.bit(cx, 18) << 1) | m.bit(cx, 18); y = y0 + r;
            setSig(x, y, decodeSign(m, x, y)); y++;
          }
        }
        for (; y < y1; y++) {
          const i = y * w + x; if (S(x, y) || vis[i]) continue;
          if (m.bit(cx, zc[nbr(x, y)])) setSig(x, y, decodeSign(m, x, y));
        }
      }
      if (style & SEGSYM) for (let k = 0; k < 4; k++) m.bit(cx, 18);
      vis.fill(0); newSig.fill(0); plane--;
    }
    if (style & RESET) cx = freshCx();
  }
  return { mag, neg, lp };
}

/* ------------------------------------------------------------------ inverse wavelet (F.3) */
function idwt1d(y: Float64Array, n: number, i0: number, rev: boolean, tmp: Float64Array) {
  if (n === 1) { if (i0 & 1) y[0] = y[0] / 2; return; }
  const P = 4; const x = tmp; // x[k + P] = sample at absolute i0 + k, with symmetric extension
  for (let k = 0; k < n; k++) x[k + P] = y[k];
  // periodic symmetric extension (F.3.7): mirror about the first and last sample
  const mirror = (k: number) => { const period = 2 * (n - 1); let m = ((k % period) + period) % period; if (m >= n) m = period - m; return m; };
  for (let k = 1; k <= P; k++) { x[P - k] = y[mirror(-k)]; x[P + n - 1 + k] = y[mirror(n - 1 + k)]; }
  const even = (k: number) => ((i0 + k) & 1) === 0; // low-pass samples sit at even absolute positions
  if (rev) {
    for (let k = -2; k < n + 2; k++) if (even(k)) x[k + P] = x[k + P] - Math.floor((x[k + P - 1] + x[k + P + 1] + 2) / 4);
    for (let k = 0; k < n; k++) if (!even(k)) x[k + P] = x[k + P] + Math.floor((x[k + P - 1] + x[k + P + 1]) / 2);
  } else {
    const K = 1.230174104914001, a = -1.586134342059924, b = -0.052980118572961, g = 0.882911075530934, dl = 0.443506852043971;
    for (let k = -P; k < n + P; k++) x[k + P] *= even(k) ? K : 1 / K;
    for (let k = -3; k < n + 3; k++) if (even(k)) x[k + P] -= dl * (x[k + P - 1] + x[k + P + 1]);
    for (let k = -2; k < n + 2; k++) if (!even(k)) x[k + P] -= g * (x[k + P - 1] + x[k + P + 1]);
    for (let k = -1; k < n + 1; k++) if (even(k)) x[k + P] -= b * (x[k + P - 1] + x[k + P + 1]);
    for (let k = 0; k < n; k++) if (!even(k)) x[k + P] -= a * (x[k + P - 1] + x[k + P + 1]);
  }
  for (let k = 0; k < n; k++) y[k] = x[k + P];
}

/** reconstruct a tile-component from its bands */
function reconstruct(tc: TileComp): Float64Array {
  const rev = tc.cs.reversible;
  let cur = tc.res[0].bands[0].coeffs as Float64Array ?? new Float64Array(0);
  let cw = tc.res[0].x1 - tc.res[0].x0, ch = tc.res[0].y1 - tc.res[0].y0;
  if (!cur || cur.length !== cw * ch) cur = new Float64Array(cw * ch);
  for (let r = 1; r < tc.res.length; r++) {
    const R = tc.res[r]; const w = R.x1 - R.x0, h = R.y1 - R.y0; const out = new Float64Array(w * h);
    const place = (src: Float64Array | null, b: Band, xo: number, yo: number) => {
      const bw = b.x1 - b.x0, bh = b.y1 - b.y0; if (!src || bw <= 0 || bh <= 0) return;
      for (let v = 0; v < bh; v++) { const Y = 2 * (b.y0 + v) + yo - R.y0; if (Y < 0 || Y >= h) continue; for (let u = 0; u < bw; u++) { const X = 2 * (b.x0 + u) + xo - R.x0; if (X >= 0 && X < w) out[Y * w + X] = src[v * bw + u]; } }
    };
    const LL: Band = { type: 0, nb: 0, x0: tc.res[r - 1].x0, y0: tc.res[r - 1].y0, x1: tc.res[r - 1].x0 + cw, y1: tc.res[r - 1].y0 + ch, cbw: 0, cbh: 0, eps: 0, mu: 0, coeffs: null };
    place(cur, LL, 0, 0);
    for (const b of R.bands) place(b.coeffs as Float64Array | null, b, b.type & 1, b.type & 2 ? 1 : 0);
    const tmp = new Float64Array(Math.max(w, h) + 16); const line = new Float64Array(Math.max(w, h));
    if (w > 0) for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) line[x] = out[y * w + x]; idwt1d(line, w, R.x0, rev, tmp); for (let x = 0; x < w; x++) out[y * w + x] = line[x]; }
    if (h > 0) for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) line[y] = out[y * w + x]; idwt1d(line, h, R.y0, rev, tmp); for (let y = 0; y < h; y++) out[y * w + x] = line[y]; }
    cur = out; cw = w; ch = h;
  }
  return cur;
}

/* ------------------------------------------------------------------ the decoder */
export function jpxDecode(input: Bytes, opts: { indexed?: boolean } = {}): JpxResult {
  const warnings: string[] = []; let partial = false;
  const info = readBoxes(input);
  const d = info.code; if (!d || d.length < 4 || d[0] !== 0xff || d[1] !== 0x4f) throw new Error("JPX: no codestream");
  let p = 2; let siz: Siz | null = null;
  const main: Params = { cod: { sop: false, eph: false, order: 0, layers: 1, mct: 0 }, cs: [], q: [], roi: [], poc: [] };
  let mainCod: CodingStyle | null = null; let mainQ: Quant | null = null; const cocMain = new Map<number, CodingStyle>(); const qccMain = new Map<number, Quant>();
  const ppm: Bytes[] = [];
  // tile state
  interface Tile { idx: number; params: Params | null; cod: CodingStyle | null; q: Quant | null; coc: Map<number, CodingStyle>; qcc: Map<number, Quant>; roi: Map<number, number>; poc: Poc[]; data: Bytes[]; ppt: Bytes[]; codSet: Cod | null; ppmHeaders: Bytes[] }
  const tiles = new Map<number, Tile>();
  const csIndex = (q: number) => (siz && siz.comps.length >= 257 ? [u16(d, q), 2] : [d[q], 1]);
  for (let g = 0; g < 1 << 20 && p + 4 <= d.length; g++) {
    if (d[p] !== 0xff) { p++; continue; }
    const m = d[p + 1]; p += 2;
    if (m === 0xd9) break; // EOC
    if (m >= 0x30 && m <= 0x3f) continue; // reserved, no length
    const len = u16(d, p); const s = p + 2, e = Math.min(d.length, p + len);
    if (m === 0x51) { // SIZ
      const nc = u16(d, s + 34); const comps: Comp[] = [];
      for (let i = 0; i < nc; i++) { const b = d[s + 36 + 3 * i]; comps.push({ depth: (b & 0x7f) + 1, signed: !!(b & 0x80), dx: Math.max(1, d[s + 37 + 3 * i]), dy: Math.max(1, d[s + 38 + 3 * i]) }); }
      siz = { X: u32(d, s + 2), Y: u32(d, s + 6), X0: u32(d, s + 10), Y0: u32(d, s + 14), TW: u32(d, s + 18), TH: u32(d, s + 22), TX0: u32(d, s + 26), TY0: u32(d, s + 30), comps };
      if ((siz.X - siz.X0) * (siz.Y - siz.Y0) > MAX_PIXELS || !siz.TW || !siz.TH || !nc) throw new Error("JPX: image too large or invalid SIZ");
    } else if (m === 0x52) { const sc = d[s]; main.cod = { sop: !!(sc & 2), eph: !!(sc & 4), order: d[s + 1], layers: u16(d, s + 2), mct: d[s + 4] }; mainCod = parseCodingStyle(d, s + 5, sc); }
    else if (m === 0x53) { const [c, k] = csIndex(s); cocMain.set(c, parseCodingStyle(d, s + k + 1, d[s + k])); }
    else if (m === 0x5c) mainQ = parseQuant(d, s, e);
    else if (m === 0x5d) { const [c, k] = csIndex(s); qccMain.set(c, parseQuant(d, s + k, e)); }
    else if (m === 0x5e) { const [c, k] = csIndex(s); main.roi[c] = d[s + k + 1]; }
    else if (m === 0x5f) main.poc.push(...parsePoc(d, s, e, siz));
    else if (m === 0x60) ppm.push(d.subarray(s + 1, e));
    else if (m === 0x90) { // SOT: one tile-part
      const ti = u16(d, s), psot = u32(d, s + 2);
      const tpEnd = psot ? Math.min(d.length, p - 2 + psot) : (() => { for (let q = e; q + 1 < d.length; q++) if (d[q] === 0xff && d[q + 1] === 0xd9) return q; return d.length; })();
      let t = tiles.get(ti);
      if (!t) { t = { idx: ti, params: null, cod: null, q: null, coc: new Map(), qcc: new Map(), roi: new Map(), poc: [], data: [], ppt: [], codSet: null, ppmHeaders: [] }; tiles.set(ti, t); }
      // tile-part header markers until SOD
      let q = e;
      for (let gg = 0; gg < 4096 && q + 4 <= tpEnd; gg++) {
        if (d[q] !== 0xff) { q++; continue; }
        const mk = d[q + 1]; q += 2; if (mk === 0x93) break; // SOD
        const l2 = u16(d, q); const s2 = q + 2, e2 = Math.min(d.length, q + l2);
        if (mk === 0x52) { const sc = d[s2]; t.codSet = { sop: !!(sc & 2), eph: !!(sc & 4), order: d[s2 + 1], layers: u16(d, s2 + 2), mct: d[s2 + 4] }; t.cod = parseCodingStyle(d, s2 + 5, sc); }
        else if (mk === 0x53) { const [c, k] = csIndex(s2); t.coc.set(c, parseCodingStyle(d, s2 + k + 1, d[s2 + k])); }
        else if (mk === 0x5c) t.q = parseQuant(d, s2, e2);
        else if (mk === 0x5d) { const [c, k] = csIndex(s2); t.qcc.set(c, parseQuant(d, s2 + k, e2)); }
        else if (mk === 0x5e) { const [c, k] = csIndex(s2); t.roi.set(c, d[s2 + k + 1]); }
        else if (mk === 0x5f) t.poc.push(...parsePoc(d, s2, e2, siz));
        else if (mk === 0x61) t.ppt.push(d.subarray(s2 + 1, e2));
        q = e2;
      }
      t.data.push(d.subarray(q, tpEnd));
      p = tpEnd; continue;
    }
    p = e;
  }
  if (!siz || !mainCod || !mainQ) throw new Error("JPX: missing SIZ/COD/QCD");
  // PPM: a stream of (Nppm, headers) per tile-part, in codestream order
  const ppmAll = ppm.length ? concat(ppm) : null; let ppmPos = 0;
  const nTX = Math.max(1, ceilDiv(siz.X - siz.TX0, siz.TW)), nTY = Math.max(1, ceilDiv(siz.Y - siz.TY0, siz.TH));
  const W = siz.X - siz.X0, H = siz.Y - siz.Y0; const nc = siz.comps.length;
  const planes: Float64Array[] = siz.comps.map((c) => new Float64Array(ceilDiv(siz!.X, c.dx) - ceilDiv(siz!.X0, c.dx) > 0 ? (ceilDiv(siz!.X, c.dx) - ceilDiv(siz!.X0, c.dx)) * (ceilDiv(siz!.Y, c.dy) - ceilDiv(siz!.Y0, c.dy)) : 0));
  const sorted = [...tiles.values()].sort((a, b) => a.idx - b.idx);
  for (const t of sorted) {
    try {
      const pi = t.idx % nTX, qi = Math.floor(t.idx / nTX); if (qi >= nTY) continue;
      const tx0 = Math.max(siz.TX0 + pi * siz.TW, siz.X0), ty0 = Math.max(siz.TY0 + qi * siz.TH, siz.Y0), tx1 = Math.min(siz.TX0 + (pi + 1) * siz.TW, siz.X), ty1 = Math.min(siz.TY0 + (qi + 1) * siz.TH, siz.Y);
      const cod = t.codSet ?? main.cod;
      const tcs: TileComp[] = [];
      for (let c = 0; c < nc; c++) {
        const cs = t.coc.get(c) ?? (t.cod ? t.cod : cocMain.get(c) ?? mainCod);
        const q = t.qcc.get(c) ?? t.q ?? qccMain.get(c) ?? mainQ;
        tcs.push(buildTileComp(siz, c, tx0, ty0, tx1, ty1, cs, q, t.roi.get(c) ?? main.roi[c] ?? 0));
      }
      // packet headers: in-stream, PPT or PPM
      const body = { d: concat(t.data), p: 0, end: 0 }; body.end = body.d.length;
      let hb: HeaderBits; let sep = false;
      if (t.ppt.length) { const hd = concat(t.ppt); hb = new HeaderBits(hd, 0, hd.length); sep = true; }
      else if (ppmAll) {
        const parts: Bytes[] = [];
        for (let k = 0; k < t.data.length && ppmPos + 4 <= ppmAll.length; k++) { const n = u32(ppmAll, ppmPos); parts.push(ppmAll.subarray(ppmPos + 4, ppmPos + 4 + n)); ppmPos += 4 + n; }
        const hd = concat(parts); hb = new HeaderBits(hd, 0, hd.length); sep = true;
      } else hb = new HeaderBits(body.d, 0, body.end);
      const order = packetOrder(tcs, siz, cod, t.poc.length ? t.poc : main.poc);
      for (const [l, r, c, k] of order) {
        if (body.p >= body.end && !sep) break;
        const tc = tcs[c]; const prec = tc.res[r]?.precincts[k]; if (!prec) continue;
        readPacket(hb, body, prec, l, cod, tc.cs.cbstyle, sep);
      }
      // Tier-1 + dequantisation
      for (let c = 0; c < nc; c++) {
        const tc = tcs[c]; const C = siz.comps[c];
        for (let r = 0; r < tc.res.length; r++) for (const b of tc.res[r].bands) {
          const bw = b.x1 - b.x0, bh = b.y1 - b.y0; if (bw <= 0 || bh <= 0) continue;
          const out = new Float64Array(bw * bh); b.coeffs = out;
          const gain = b.type === 0 ? 0 : b.type === 3 ? 2 : 1;
          const mb = tc.q.guard + b.eps - 1;
          const delta = tc.cs.reversible ? 1 : 2 ** (C.depth + gain - b.eps) * (1 + b.mu / 2048);
          for (const prec of tc.res[r].precincts) for (const pb of prec.bands) {
            if (pb.band !== b) continue;
            for (const cb of pb.cbs) {
              const res = decodeBlock(cb, b.type, mb + tc.roi, tc.cs.cbstyle); if (!res) continue;
              const cw = cb.x1 - cb.x0;
              for (let v = 0; v < cb.y1 - cb.y0; v++) for (let u = 0; u < cw; u++) {
                const i = v * cw + u; let mg = res.mag[i]; if (!mg) continue;
                // ROI max-shift (H.1): coefficients at or above 2^s belong to the region and were scaled up by s planes
                let lowp = res.lp[i];
                if (tc.roi && mg >= 2 ** tc.roi) { mg = mg / 2 ** tc.roi; lowp = Math.max(0, lowp - tc.roi); }
                // mid-point reconstruction of the undecoded planes (E.1.1.2); a fully decoded reversible value is exact
                const val = mg + (lowp > 0 ? 2 ** (lowp - 1) : tc.cs.reversible ? 0 : 0.5);
                out[(cb.y0 - b.y0 + v) * bw + (cb.x0 - b.x0 + u)] = (res.neg[i] ? -val : val) * delta;
              }
            }
          }
        }
        tc.data = reconstruct(tc);
      }
      // multiple component transform (G.2, G.3)
      if (cod.mct && nc >= 3) {
        const [a, b2, c2] = [tcs[0].data!, tcs[1].data!, tcs[2].data!];
        if (a.length === b2.length && a.length === c2.length) {
          if (tcs[0].cs.reversible) for (let i = 0; i < a.length; i++) { const y = a[i], u = b2[i], v = c2[i]; const G = y - Math.floor((u + v) / 4); a[i] = v + G; b2[i] = G; c2[i] = u + G; }
          else for (let i = 0; i < a.length; i++) { const y = a[i], cb = b2[i], cr = c2[i]; a[i] = y + 1.402 * cr; b2[i] = y - 0.344136 * cb - 0.714136 * cr; c2[i] = y + 1.772 * cb; }
        }
      }
      // place into the component planes
      for (let c = 0; c < nc; c++) {
        const tc = tcs[c]; const C = siz.comps[c]; const src = tc.data!; const tw = tc.x1 - tc.x0;
        const ox = ceilDiv(siz.X0, C.dx), oy = ceilDiv(siz.Y0, C.dy); const pw = ceilDiv(siz.X, C.dx) - ox;
        for (let y = tc.y0; y < tc.y1; y++) for (let x = tc.x0; x < tc.x1; x++) planes[c][(y - oy) * pw + (x - ox)] = src[(y - tc.y0) * tw + (x - tc.x0)];
      }
    } catch (e) { partial = true; warnings.push(`tile ${t.idx}: ${(e as Error).message}`); }
  }
  if (tiles.size < nTX * nTY) { partial = true; warnings.push(`${nTX * nTY - tiles.size} tiles missing`); }
  // DC shift, clamp, scale to 8 bits, upsample subsampled components
  const comps8: Uint8Array[] = siz.comps.map((C, c) => {
    const ox = ceilDiv(siz!.X0, C.dx), oy = ceilDiv(siz!.Y0, C.dy); const pw = ceilDiv(siz!.X, C.dx) - ox, ph = ceilDiv(siz!.Y, C.dy) - oy;
    const out = new Uint8Array(W * H); const max = 2 ** C.depth - 1; const shift = C.signed ? 0 : 2 ** (C.depth - 1);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(ph - 1, Math.floor(y / C.dy)); void oy; // image-relative, as OpenJPEG-based readers upsample
      for (let x = 0; x < W; x++) {
        const sx = Math.min(pw - 1, Math.floor(x / C.dx)); void ox;
        let v = Math.round((planes[c][sy * pw + sx] ?? 0) + shift); if (C.signed) v += 2 ** (C.depth - 1);
        v = v < 0 ? 0 : v > max ? max : v;
        out[y * W + x] = C.depth === 8 || (opts.indexed && C.depth < 8) ? v : C.depth > 8 ? v >> (C.depth - 8) : Math.round((v * 255) / max);
      }
    }
    return out;
  });
  // JP2 channel mapping: palette (pclr + cmap), channel definitions (cdef)
  let chans: Uint8Array[] = comps8;
  if (info.palette && info.cmap && !opts.indexed) { // a PDF /Indexed space supplies its own lookup: indices pass through
    const pal = info.palette;
    chans = info.cmap.map((m) => {
      const src = comps8[m.cmp] ?? comps8[0]; if (m.mtyp !== 1) return src;
      const out = new Uint8Array(W * H); let dep = pal.depths[m.pcol] ?? 8;
      if (dep < 8 && pal.entries.some((e) => (e[m.pcol] ?? 0) > 2 ** dep - 1)) dep = 8;
      // palette indices use the component's full precision; the 8-bit plane is rescaled back to an index
      const C = siz!.comps[m.cmp] ?? siz!.comps[0]; const max = 2 ** C.depth - 1;
      for (let i = 0; i < out.length; i++) { const idx = C.depth === 8 ? src[i] : Math.round((src[i] * max) / 255); const e = pal.entries[Math.min(pal.entries.length - 1, idx)]; const v = e ? e[m.pcol] : 0; out[i] = dep === 8 ? v : dep > 8 ? v >> (dep - 8) : Math.round((v * 255) / (2 ** dep - 1)); }
      return out;
    });
  }
  let alpha: Uint8Array | null = null;
  if (info.cdef) {
    const color: { ch: Uint8Array; asoc: number }[] = [];
    for (const def of info.cdef) { const ch = chans[def.c]; if (!ch) continue; if (def.typ === 1 || def.typ === 2) alpha = ch; else if (def.typ === 0) color.push({ ch, asoc: def.asoc }); }
    if (color.length) chans = color.sort((a, b) => (a.asoc || 0) - (b.asoc || 0)).map((x) => x.ch);
  }
  const csName = info.enumCs === 16 ? "rgb" : info.enumCs === 17 ? "gray" : info.enumCs === 12 ? "cmyk" : info.enumCs === 18 ? "ycc" : null;
  // sYCC without the codestream's own transform: convert to RGB. Three components with subsampled chroma and no colour
  // box are also taken as YCbCr (the convention OpenJPEG-based readers such as PDFium follow)
  const c3 = siz.comps;
  const yccGuess = csName === null && !info.palette && c3.length === 3 && c3[0].dx === 1 && c3[0].dy === 1 && (c3[1].dx > 1 || c3[1].dy > 1 || c3[2].dx > 1 || c3[2].dy > 1);
  if ((csName === "ycc" || yccGuess) && chans.length >= 3 && !main.cod.mct) {
    const [Y, Cb, Cr] = chans; const R = new Uint8Array(W * H), G = new Uint8Array(W * H), Bc = new Uint8Array(W * H);
    for (let i = 0; i < R.length; i++) { const y = Y[i], cb = Cb[i] - 128, cr = Cr[i] - 128; R[i] = clamp8(y + Math.trunc(1.402 * cr)); G[i] = clamp8(y - Math.trunc(0.344 * cb + 0.714 * cr)); Bc[i] = clamp8(y + Math.trunc(1.772 * cb)); }
    chans = [R, G, Bc, ...chans.slice(3)];
  }
  const n = chans.length; const data = new Uint8Array(W * H * n);
  for (let k = 0; k < n; k++) { const ch = chans[k]; for (let i = 0; i < W * H; i++) data[i * n + k] = ch[i]; }
  return { width: W, height: H, comps: n, data, alpha, cs: csName === "ycc" || yccGuess ? "rgb" : csName, partial, warnings };
}
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function parsePoc(d: Bytes, s: number, e: number, siz: Siz | null): Poc[] {
  const big = !!siz && siz.comps.length >= 257; const step = big ? 9 : 7; const out: Poc[] = [];
  for (let q = s; q + step <= e; q += step) {
    if (big) out.push({ rs: d[q], cs: u16(d, q + 1), lye: u16(d, q + 3), re: d[q + 5], ce: u16(d, q + 6), order: d[q + 8] });
    else out.push({ rs: d[q], cs: d[q + 1], lye: u16(d, q + 2), re: d[q + 4], ce: d[q + 5] || 256, order: d[q + 6] });
  }
  return out;
}

/** the packet sequence (B.12): [layer, resolution, component, precinct] */
function packetOrder(tcs: TileComp[], siz: Siz, cod: Cod, poc: Poc[]): [number, number, number, number][] {
  const L = cod.layers; const nc = tcs.length; const maxR = Math.max(...tcs.map((t) => t.res.length));
  const out: [number, number, number, number][] = [];
  const next = tcs.map((t) => t.res.map((r) => new Int32Array(r.precincts.length)));
  const emit = (l: number, r: number, c: number, k: number) => { const n = next[c][r]; if (n[k] !== l) return; n[k]++; out.push([l, r, c, k]); };
  const run = (order: number, rs: number, re: number, cs: number, ce: number, lye: number) => {
    const comps = [] as number[]; for (let c = cs; c < Math.min(ce, nc); c++) comps.push(c);
    const resOf = (c: number) => { const a: number[] = []; for (let r = rs; r < Math.min(re, tcs[c].res.length); r++) a.push(r); return a; };
    if (order === 0) { for (let l = 0; l < lye; l++) for (let r = rs; r < Math.min(re, maxR); r++) for (const c of comps) if (r < tcs[c].res.length) for (let k = 0; k < tcs[c].res[r].precincts.length; k++) emit(l, r, c, k); return; }
    if (order === 1) { for (let r = rs; r < Math.min(re, maxR); r++) for (let l = 0; l < lye; l++) for (const c of comps) if (r < tcs[c].res.length) for (let k = 0; k < tcs[c].res[r].precincts.length; k++) emit(l, r, c, k); return; }
    // position-driven orders: precincts ordered by their reference-grid origin (B.12.1.3–5)
    const items: { r: number; c: number; k: number; y: number; x: number }[] = [];
    for (const c of comps) for (const r of resOf(c)) tcs[c].res[r].precincts.forEach((pr, k) => items.push({ r, c, k, y: pr.refY, x: pr.refX }));
    const key = order === 2 ? (a: typeof items[0]) => [a.r, a.y, a.x, a.c] : order === 3 ? (a: typeof items[0]) => [a.y, a.x, a.c, a.r] : (a: typeof items[0]) => [a.c, a.y, a.x, a.r];
    items.sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return a.k - b.k; });
    for (const it of items) for (let l = 0; l < lye; l++) emit(l, it.r, it.c, it.k);
  };
  if (poc.length) for (const pc of poc) run(pc.order, pc.rs, pc.re, pc.cs, pc.ce, Math.min(pc.lye, L));
  run(cod.order, 0, maxR, 0, nc, L); // anything a POC did not cover, in the default order
  void siz;
  return out;
}
