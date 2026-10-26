/**
 * TT77 — JBIG2 decoder (ITU-T T.88) for the PDF /JBIG2Decode filter. Original code written for Fusion from the structure
 * of T.88: segment headers (7.2), MQ arithmetic decoding (Annex E), integer / symbol-ID decoding (Annex A), generic
 * regions with templates 0–3, AT pixels, TPGDON and MMR (6.2), generic refinement with TPGRON (6.3), text regions
 * (6.4), symbol dictionaries incl. refinement/aggregate coding and Huffman collective bitmaps (6.5), halftone regions
 * and pattern dictionaries (6.6, 6.7, C.5), standard and custom Huffman tables (Annex B), page composition with the
 * five combination operators, unknown page height with end-of-stripe, and the file header / random-access layout.
 * MMR data is handed to the first-party CCITT decoder (pdfccitt.ts).
 *
 * Verified bit-exact against PDFium's own decoded image bitmaps (scripts/tt77-pdf.mts, test J1), not just by eye.
 *
 * Output follows the PDF convention for /JBIG2Decode: 1-bit rows, MSB first, 0 = black (T.88 itself uses 1 = black).
 * Bounded: page and region areas are capped (MAX_AREA), every loop is bounded by the data, and a damaged segment
 * stops decoding with `partial` set — the pixels decoded so far are kept.
 */
import { ccittDecode } from "./pdfccitt";

type Bytes = Uint8Array;
const MAX_AREA = 1 << 27; // 134 M pixels (1 byte each while decoding): an A3 page at 600 dpi is ≈ 70 M; larger is refused

/* ------------------------------------------------------------------ bitmaps (1 byte per pixel, 1 = black) */
export class Bitmap {
  readonly w: number; readonly h: number; d: Uint8Array;
  constructor(w: number, h: number, fill = 0) {
    if (w < 0 || h < 0 || w * h > MAX_AREA) throw new Error(`JBIG2 bitmap ${w}×${h} is too large`);
    this.w = w; this.h = h; this.d = new Uint8Array(w * h); if (fill) this.d.fill(1);
  }
  get(x: number, y: number): number { return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.d[y * this.w + x]; }
  /** compose `s` onto this bitmap with its top-left at (x, y) (T.88 6.?/7.4.?: OR, AND, XOR, XNOR, REPLACE) */
  compose(s: Bitmap, x: number, y: number, op: number) {
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(this.w, x + s.w), y1 = Math.min(this.h, y + s.h);
    for (let yy = y0; yy < y1; yy++) {
      const so = (yy - y) * s.w - x, d = yy * this.w;
      for (let xx = x0; xx < x1; xx++) {
        const a = this.d[d + xx], b = s.d[so + xx];
        this.d[d + xx] = op === 0 ? a | b : op === 1 ? a & b : op === 2 ? a ^ b : op === 3 ? 1 - (a ^ b) : b;
      }
    }
  }
  sub(x: number, y: number, w: number, h: number): Bitmap { const r = new Bitmap(w, h); for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) r.d[yy * w + xx] = this.get(x + xx, y + yy); return r; }
}

/* ------------------------------------------------------------------ MQ arithmetic decoder (Annex E) */
// probability estimation table: Qe, next index after MPS, after LPS, switch flag
const QE = [0x5601, 0x3401, 0x1801, 0x0ac1, 0x0521, 0x0221, 0x5601, 0x5401, 0x4801, 0x3801, 0x3001, 0x2401, 0x1c01, 0x1601, 0x5601, 0x5401, 0x5101, 0x4801, 0x3801, 0x3401, 0x3001, 0x2801, 0x2401, 0x2201, 0x1c01, 0x1801, 0x1601, 0x1401, 0x1201, 0x1101, 0x0ac1, 0x09c1, 0x08a1, 0x0521, 0x0441, 0x02a1, 0x0221, 0x0141, 0x0111, 0x0085, 0x0049, 0x0025, 0x0015, 0x0009, 0x0005, 0x0001, 0x5601];
const NMPS = [1, 2, 3, 4, 5, 38, 7, 8, 9, 10, 11, 12, 13, 29, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 45, 46];
const NLPS = [1, 6, 9, 12, 29, 33, 6, 14, 14, 14, 17, 18, 20, 21, 14, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 46];
const SWITCH = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** contexts are bytes: (state index << 1) | MPS */
export class MQDecoder {
  private d: Bytes; private p: number; private end: number; private a = 0x8000; private chigh: number; private clow = 0; private ct = 0;
  constructor(d: Bytes, start = 0, end = d.length) {
    this.d = d; this.p = start; this.end = Math.min(end, d.length);
    this.chigh = this.at(start); this.byteIn();
    this.chigh = ((this.chigh << 7) & 0xffff) | ((this.clow >> 9) & 0x7f); this.clow = (this.clow << 7) & 0xffff; this.ct -= 7;
  }
  /** past the end of the data the decoder reads 0xFF bytes (E.3.4) */
  private at(i: number) { return i < this.end ? this.d[i] : 0xff; }
  private byteIn() {
    if (this.at(this.p) === 0xff) {
      if (this.at(this.p + 1) > 0x8f) { this.clow += 0xff00; this.ct = 8; } // a marker: feed 1-bits, do not advance
      else { this.p++; this.clow += this.at(this.p) << 9; this.ct = 7; } // bit stuffing after 0xFF
    } else { this.p++; this.clow += this.at(this.p) << 8; this.ct = 8; }
    this.chigh += this.clow >>> 16; this.clow &= 0xffff;
  }
  /** bytes consumed so far (used to detect runaway decoding of garbage) */
  get pos() { return this.p; }
  bit(cx: Uint8Array, i: number): number {
    const st = cx[i]; let idx = st >> 1, mps = st & 1; const qe = QE[idx];
    let a = this.a - qe; let d: number;
    if (this.chigh < qe) { // the lower sub-interval (LPS unless the conditional exchange applies)
      if (a < qe) { d = mps; idx = NMPS[idx]; } else { d = 1 - mps; if (SWITCH[idx]) mps = d; idx = NLPS[idx]; }
      a = qe;
    } else {
      this.chigh -= qe;
      if (a & 0x8000) { this.a = a; return mps; }
      if (a < qe) { d = 1 - mps; if (SWITCH[idx]) mps = d; idx = NLPS[idx]; } else { d = mps; idx = NMPS[idx]; }
    }
    do { // RENORMD
      if (this.ct === 0) this.byteIn();
      a <<= 1; this.chigh = ((this.chigh << 1) & 0xffff) | ((this.clow >> 15) & 1); this.clow = (this.clow << 1) & 0xffff; this.ct--;
    } while ((a & 0x8000) === 0);
    this.a = a; cx[i] = (idx << 1) | mps; return d;
  }
}

/** integer arithmetic decoding (A.2); null = OOB */
function decInt(mq: MQDecoder, cx: Uint8Array): number | null {
  let prev = 1;
  const b = () => { const v = mq.bit(cx, prev); prev = prev < 256 ? (prev << 1) | v : (((prev << 1) | v) & 511) | 256; return v; };
  const s = b(); let n: number, off: number;
  if (!b()) { n = 2; off = 0; } else if (!b()) { n = 4; off = 4; } else if (!b()) { n = 6; off = 20; } else if (!b()) { n = 8; off = 84; } else if (!b()) { n = 12; off = 340; } else { n = 32; off = 4436; }
  let v = 0; for (let i = 0; i < n; i++) v = v * 2 + b();
  v += off;
  if (s) return v === 0 ? null : -v;
  return v;
}
/** symbol-ID arithmetic decoding (A.3) */
function decId(mq: MQDecoder, cx: Uint8Array, len: number): number {
  let prev = 1; for (let i = 0; i < len; i++) prev = (prev << 1) | mq.bit(cx, prev);
  return prev - (1 << len);
}
const ceilLog2 = (n: number) => { let r = 0; while ((1 << r) < n && r < 31) r++; return r; };

/* ------------------------------------------------------------------ bit reader (MSB first) for Huffman data */
class BitReader {
  d: Bytes; pos: number; end: number; // bit position, byte end
  constructor(d: Bytes, start: number, end: number) { this.d = d; this.pos = start * 8; this.end = Math.min(end, d.length); }
  bit(): number { const p = this.pos++; if ((p >> 3) >= this.end) throw new Error("JBIG2: Huffman data ends early"); return (this.d[p >> 3] >> (7 - (p & 7))) & 1; }
  bits(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  align() { this.pos = (this.pos + 7) & ~7; }
  get byte() { return this.pos >> 3; }
}

/* ------------------------------------------------------------------ Huffman tables (Annex B) */
/** a table line: prefix length, range length, range low, kind (0 normal, 1 lower range, 2 OOB) */
type Line = [number, number, number, number];
interface HTable { byLen: Map<number, Line>[]; maxLen: number }
/** canonical code assignment (B.3) in line order */
function buildTable(lines: Line[]): HTable {
  const maxLen = Math.max(0, ...lines.map((l) => l[0]));
  const count = new Array(maxLen + 2).fill(0); for (const l of lines) if (l[0] > 0) count[l[0]]++;
  const byLen: Map<number, Line>[] = Array.from({ length: maxLen + 1 }, () => new Map());
  let first = 0;
  for (let len = 1; len <= maxLen; len++) {
    first = (first + count[len - 1]) * 2; let code = first;
    for (const l of lines) if (l[0] === len) byLen[len].set(code++, l);
  }
  return { byLen, maxLen };
}
/** null = OOB */
function decHuff(br: BitReader, t: HTable): number | null {
  let code = 0;
  for (let len = 1; len <= t.maxLen; len++) {
    code = code * 2 + br.bit(); const l = t.byLen[len].get(code);
    if (l) { if (l[3] === 2) return null; const off = br.bits(l[1]); return l[3] === 1 ? l[2] - off : l[2] + off; }
  }
  throw new Error("JBIG2: invalid Huffman code");
}
const decHuffNum = (br: BitReader, t: HTable) => { const v = decHuff(br, t); if (v === null) throw new Error("JBIG2: unexpected OOB"); return v; };
// Standard tables B.1–B.15 as [PREFLEN, RANGELEN, RANGELOW, kind], in the line order of Annex B
const N = 0, LO = 1, OOB = 2;
const STD_LINES: Line[][] = [
  /* A */ [[1, 4, 0, N], [2, 8, 16, N], [3, 16, 272, N], [3, 32, 65808, N]],
  /* B */ [[1, 0, 0, N], [2, 0, 1, N], [3, 0, 2, N], [4, 3, 3, N], [5, 6, 11, N], [6, 32, 75, N], [6, 0, 0, OOB]],
  /* C */ [[8, 8, -256, N], [1, 0, 0, N], [2, 0, 1, N], [3, 0, 2, N], [4, 3, 3, N], [5, 6, 11, N], [8, 32, -257, LO], [7, 32, 75, N], [6, 0, 0, OOB]],
  /* D */ [[1, 0, 1, N], [2, 0, 2, N], [3, 0, 3, N], [4, 3, 4, N], [5, 6, 12, N], [5, 32, 76, N]],
  /* E */ [[7, 8, -255, N], [1, 0, 1, N], [2, 0, 2, N], [3, 0, 3, N], [4, 3, 4, N], [5, 6, 12, N], [7, 32, -256, LO], [6, 32, 76, N]],
  /* F */ [[5, 10, -2048, N], [4, 9, -1024, N], [4, 8, -512, N], [4, 7, -256, N], [5, 6, -128, N], [5, 5, -64, N], [4, 5, -32, N], [2, 7, 0, N], [3, 7, 128, N], [3, 8, 256, N], [4, 9, 512, N], [4, 10, 1024, N], [6, 32, -2049, LO], [6, 32, 2048, N]],
  /* G */ [[4, 9, -1024, N], [3, 8, -512, N], [4, 7, -256, N], [5, 6, -128, N], [5, 5, -64, N], [4, 5, -32, N], [4, 5, 0, N], [5, 5, 32, N], [5, 6, 64, N], [4, 7, 128, N], [3, 8, 256, N], [3, 9, 512, N], [3, 10, 1024, N], [5, 32, -1025, LO], [5, 32, 2048, N]],
  /* H */ [[8, 3, -15, N], [9, 1, -7, N], [8, 1, -5, N], [9, 0, -3, N], [7, 0, -2, N], [4, 0, -1, N], [2, 1, 0, N], [5, 0, 2, N], [6, 0, 3, N], [3, 4, 4, N], [6, 1, 20, N], [4, 4, 22, N], [4, 5, 38, N], [5, 6, 70, N], [5, 7, 134, N], [6, 7, 262, N], [7, 8, 390, N], [6, 10, 646, N], [9, 32, -16, LO], [9, 32, 1670, N], [2, 0, 0, OOB]],
  /* I */ [[8, 4, -31, N], [9, 2, -15, N], [8, 2, -11, N], [9, 1, -7, N], [7, 1, -5, N], [4, 1, -3, N], [3, 1, -1, N], [3, 1, 1, N], [5, 1, 3, N], [6, 1, 5, N], [3, 5, 7, N], [6, 2, 39, N], [4, 5, 43, N], [4, 6, 75, N], [5, 7, 139, N], [5, 8, 267, N], [6, 8, 523, N], [7, 9, 779, N], [6, 11, 1291, N], [9, 32, -32, LO], [9, 32, 3339, N], [2, 0, 0, OOB]],
  /* J */ [[7, 4, -21, N], [8, 0, -5, N], [7, 0, -4, N], [5, 0, -3, N], [2, 2, -2, N], [5, 0, 2, N], [6, 0, 3, N], [7, 0, 4, N], [8, 0, 5, N], [2, 6, 6, N], [5, 5, 70, N], [6, 5, 102, N], [6, 6, 134, N], [6, 7, 198, N], [6, 8, 326, N], [6, 9, 582, N], [6, 10, 1094, N], [7, 11, 2118, N], [8, 32, -22, LO], [8, 32, 4166, N], [2, 0, 0, OOB]],
  /* K */ [[1, 0, 1, N], [2, 1, 2, N], [4, 0, 4, N], [4, 1, 5, N], [5, 1, 7, N], [5, 2, 9, N], [6, 2, 13, N], [7, 2, 17, N], [7, 3, 21, N], [7, 4, 29, N], [7, 5, 45, N], [7, 6, 77, N], [7, 32, 141, N]],
  /* L */ [[1, 0, 1, N], [2, 0, 2, N], [3, 1, 3, N], [5, 0, 5, N], [5, 1, 6, N], [6, 1, 8, N], [7, 0, 10, N], [7, 1, 11, N], [7, 2, 13, N], [7, 3, 17, N], [7, 4, 25, N], [8, 5, 41, N], [8, 32, 73, N]],
  /* M */ [[1, 0, 1, N], [3, 0, 2, N], [4, 0, 3, N], [5, 0, 4, N], [4, 1, 5, N], [3, 3, 7, N], [6, 1, 15, N], [6, 2, 17, N], [6, 3, 21, N], [6, 4, 29, N], [6, 5, 45, N], [7, 6, 77, N], [7, 32, 141, N]],
  /* N */ [[3, 0, -2, N], [3, 0, -1, N], [1, 0, 0, N], [3, 0, 1, N], [3, 0, 2, N]],
  /* O */ [[7, 4, -24, N], [6, 2, -8, N], [5, 1, -4, N], [4, 0, -2, N], [3, 0, -1, N], [1, 0, 0, N], [3, 0, 1, N], [4, 0, 2, N], [5, 1, 3, N], [6, 2, 5, N], [7, 4, 9, N], [7, 32, -25, LO], [7, 32, 25, N]],
];
const STD: HTable[] = STD_LINES.map(buildTable);
/** standard table B.n (1-based, as in the spec) */
const B = (n: number) => STD[n - 1];
/** exported for the test suite: every standard table is a complete prefix code (Kraft sum = 1) */
export const _stdTables = STD_LINES;

/** custom table segment (7.4.13 / B.2) */
function parseTable(d: Bytes, p: number, end: number): HTable {
  const fl = d[p]; const oob = fl & 1, ps = ((fl >> 1) & 7) + 1, rs = ((fl >> 4) & 7) + 1;
  const low = i32(d, p + 1), high = i32(d, p + 5);
  const br = new BitReader(d, p + 9, end); const lines: Line[] = [];
  let cur = low;
  for (let g = 0; cur < high && g < 1 << 16; g++) { const pl = br.bits(ps), rl = br.bits(rs); lines.push([pl, rl, cur, N]); cur += 2 ** rl; }
  lines.push([br.bits(ps), 32, low - 1, LO]);
  lines.push([br.bits(ps), 32, high, N]);
  if (oob) lines.push([br.bits(ps), 0, 0, OOB]);
  return buildTable(lines);
}

/* ------------------------------------------------------------------ generic region decoding (6.2) */
type AT = number[]; // [x1, y1, x2, y2, …]
function genericArith(mq: MQDecoder, cx: Uint8Array, w: number, h: number, tpl: number, tpgdon: boolean, at: AT, skip: Bitmap | null = null): Bitmap {
  const bm = new Bitmap(w, h); const d = bm.d;
  const g = (x: number, y: number) => (x < 0 || y < 0 || x >= w ? 0 : d[y * w + x]); // y < current row only for template pixels
  // typical-prediction contexts (Figures 8–11), expressed in this file's bit order (bit 0 = the pixel to the left)
  const sltp = [0x9b25, 0x0795, 0x00e5, 0x0195][tpl];
  let ltp = 0;
  const [a1x, a1y, a2x, a2y, a3x, a3y, a4x, a4y] = at;
  for (let y = 0; y < h; y++) {
    if (tpgdon) {
      ltp ^= mq.bit(cx, sltp);
      if (ltp) { if (y > 0) d.copyWithin(y * w, (y - 1) * w, y * w); continue; }
    }
    const r = y * w;
    for (let x = 0; x < w; x++) {
      if (skip && skip.d[r + x]) { d[r + x] = 0; continue; }
      let c: number;
      if (tpl === 0) {
        c = g(x - 1, y) | (g(x - 2, y) << 1) | (g(x - 3, y) << 2) | (g(x - 4, y) << 3) | (g(x + a1x, y + a1y) << 4)
          | (g(x + 2, y - 1) << 5) | (g(x + 1, y - 1) << 6) | (g(x, y - 1) << 7) | (g(x - 1, y - 1) << 8) | (g(x - 2, y - 1) << 9)
          | (g(x + a2x, y + a2y) << 10) | (g(x + a3x, y + a3y) << 11) | (g(x + 1, y - 2) << 12) | (g(x, y - 2) << 13) | (g(x - 1, y - 2) << 14) | (g(x + a4x, y + a4y) << 15);
      } else if (tpl === 1) {
        c = g(x - 1, y) | (g(x - 2, y) << 1) | (g(x - 3, y) << 2) | (g(x + a1x, y + a1y) << 3)
          | (g(x + 2, y - 1) << 4) | (g(x + 1, y - 1) << 5) | (g(x, y - 1) << 6) | (g(x - 1, y - 1) << 7) | (g(x - 2, y - 1) << 8)
          | (g(x + 2, y - 2) << 9) | (g(x + 1, y - 2) << 10) | (g(x, y - 2) << 11) | (g(x - 1, y - 2) << 12);
      } else if (tpl === 2) {
        c = g(x - 1, y) | (g(x - 2, y) << 1) | (g(x + a1x, y + a1y) << 2)
          | (g(x + 1, y - 1) << 3) | (g(x, y - 1) << 4) | (g(x - 1, y - 1) << 5) | (g(x - 2, y - 1) << 6)
          | (g(x + 1, y - 2) << 7) | (g(x, y - 2) << 8) | (g(x - 1, y - 2) << 9);
      } else {
        c = g(x - 1, y) | (g(x - 2, y) << 1) | (g(x - 3, y) << 2) | (g(x - 4, y) << 3) | (g(x + a1x, y + a1y) << 4)
          | (g(x + 1, y - 1) << 5) | (g(x, y - 1) << 6) | (g(x - 1, y - 1) << 7) | (g(x - 2, y - 1) << 8) | (g(x - 3, y - 1) << 9);
      }
      d[r + x] = mq.bit(cx, c);
    }
  }
  return bm;
}
const genericContexts = (tpl: number) => new Uint8Array(tpl === 0 ? 65536 : tpl === 1 ? 8192 : 1024);
/** MMR-coded generic region (6.2.6): T.6 with 1 = black; returns the bitmap and the bytes consumed */
function genericMMR(d: Bytes, p: number, end: number, w: number, h: number): { bm: Bitmap; used: number; partial: boolean } {
  const bm = new Bitmap(w, h); if (!w || !h) return { bm, used: 0, partial: false };
  const r = ccittDecode(d.subarray(p, end), { K: -1, Columns: w, Rows: h, BlackIs1: true, EndOfBlock: true });
  const rb = (w + 7) >> 3;
  for (let y = 0; y < Math.min(h, r.rows); y++) for (let x = 0; x < w; x++) bm.d[y * w + x] = (r.data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
  return { bm, used: r.consumed, partial: r.partial };
}

/* ------------------------------------------------------------------ generic refinement (6.3) */
function refineArith(mq: MQDecoder, cx: Uint8Array, w: number, h: number, tpl: number, ref: Bitmap, dx: number, dy: number, tpgron: boolean, at: AT): Bitmap {
  const bm = new Bitmap(w, h); const d = bm.d;
  const c = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  const R = (x: number, y: number) => ref.get(x, y);
  const sltp = tpl === 0 ? 0x100 : 0x80; // the reference centre pixel alone (Figures 14, 15) in this file's bit order
  let ltp = 0;
  const ctx = (x: number, y: number) => {
    const rx = x - dx, ry = y - dy;
    return tpl === 0
      ? c(x - 1, y) | (c(x + 1, y - 1) << 1) | (c(x, y - 1) << 2) | (c(x + at[0], y + at[1]) << 3)
        | (R(rx + 1, ry + 1) << 4) | (R(rx, ry + 1) << 5) | (R(rx - 1, ry + 1) << 6) | (R(rx + 1, ry) << 7) | (R(rx, ry) << 8)
        | (R(rx - 1, ry) << 9) | (R(rx + 1, ry - 1) << 10) | (R(rx, ry - 1) << 11) | (R(rx + at[2], ry + at[3]) << 12)
      : c(x - 1, y) | (c(x + 1, y - 1) << 1) | (c(x, y - 1) << 2) | (c(x - 1, y - 1) << 3)
        | (R(rx + 1, ry + 1) << 4) | (R(rx, ry + 1) << 5) | (R(rx + 1, ry) << 6) | (R(rx, ry) << 7) | (R(rx - 1, ry) << 8) | (R(rx, ry - 1) << 9);
  };
  for (let y = 0; y < h; y++) {
    if (tpgron) ltp ^= mq.bit(cx, sltp);
    for (let x = 0; x < w; x++) {
      if (ltp) { // TPGRPIX: a uniform 3×3 reference neighbourhood predicts the pixel
        const rx = x - dx, ry = y - dy; const v = R(rx - 1, ry - 1); let same = true;
        for (let j = -1; j <= 1 && same; j++) for (let i = -1; i <= 1; i++) if (R(rx + i, ry + j) !== v) { same = false; break; }
        if (same) { d[y * w + x] = v; continue; }
      }
      d[y * w + x] = mq.bit(cx, ctx(x, y));
    }
  }
  return bm;
}
const refineContexts = (tpl: number) => new Uint8Array(tpl === 0 ? 8192 : 1024);

/* ------------------------------------------------------------------ text region (6.4) */
interface ArithCx { IADT: Uint8Array; IAFS: Uint8Array; IADS: Uint8Array; IAIT: Uint8Array; IARI: Uint8Array; IARDW: Uint8Array; IARDH: Uint8Array; IARDX: Uint8Array; IARDY: Uint8Array; IAID: Uint8Array }
const newArithCx = (idLen: number): ArithCx => ({ IADT: new Uint8Array(512), IAFS: new Uint8Array(512), IADS: new Uint8Array(512), IAIT: new Uint8Array(512), IARI: new Uint8Array(512), IARDW: new Uint8Array(512), IARDH: new Uint8Array(512), IARDX: new Uint8Array(512), IARDY: new Uint8Array(512), IAID: new Uint8Array(1 << Math.min(30, idLen + 1)) });
interface TextHuff { fs: HTable; ds: HTable; dt: HTable; rdw: HTable; rdh: HTable; rdx: HTable; rdy: HTable; rsize: HTable; ids: HTable | null }
interface TextP {
  w: number; h: number; n: number; strips: number; syms: Bitmap[]; idLen: number; defPixel: number; op: number; transposed: boolean; corner: number;
  dsOffset: number; refine: boolean; rtpl: number; rat: AT;
  mq?: MQDecoder; cx?: ArithCx; grcx: Uint8Array | null; br?: BitReader; huff?: TextHuff; data?: Bytes;
}
const BOTTOMLEFT = 0, TOPLEFT = 1, BOTTOMRIGHT = 2, TOPRIGHT = 3;
function decodeText(p: TextP): Bitmap {
  const out = new Bitmap(p.w, p.h, p.defPixel); const H = p.huff; const br = p.br; const mq = p.mq; const cx = p.cx;
  const num = (v: number | null) => { if (v === null) throw new Error("JBIG2: unexpected OOB in a text region"); return v; };
  const dt = () => (H ? decHuffNum(br!, H.dt) : num(decInt(mq!, cx!.IADT))) * p.strips;
  let stript = -dt(); let firsts = 0; let ninst = 0;
  while (ninst < p.n) {
    stript += dt();
    firsts += H ? decHuffNum(br!, H.fs) : num(decInt(mq!, cx!.IAFS));
    let curs = firsts; let first = true;
    // a strip always ends with an OOB delta-S, even after the last instance (6.4.5 step 3c): it must be read, or a text
    // region embedded in a symbol dictionary leaves the shared decoder out of step
    for (let guard = 0; guard < 1 << 24; guard++) {
      if (!first) { const ids = H ? decHuff(br!, H.ds) : decInt(mq!, cx!.IADS); if (ids === null) break; curs += ids + p.dsOffset; }
      first = false;
      const curt = p.strips === 1 ? 0 : H ? br!.bits(ceilLog2(p.strips)) : num(decInt(mq!, cx!.IAIT));
      const t = stript + curt;
      const id = H ? decHuffNum(br!, H.ids!) : decId(mq!, cx!.IAID, p.idLen);
      if (id < 0 || id >= p.syms.length) throw new Error(`JBIG2: symbol id ${id} out of range`);
      if (ninst >= p.n) throw new Error("JBIG2: more symbol instances than declared");
      let ib = p.syms[id];
      const ri = p.refine ? (H ? br!.bit() : num(decInt(mq!, cx!.IARI))) : 0;
      if (ri) {
        const rdw = H ? decHuffNum(br!, H.rdw) : num(decInt(mq!, cx!.IARDW)); const rdh = H ? decHuffNum(br!, H.rdh) : num(decInt(mq!, cx!.IARDH));
        const rdx = H ? decHuffNum(br!, H.rdx) : num(decInt(mq!, cx!.IARDX)); const rdy = H ? decHuffNum(br!, H.rdy) : num(decInt(mq!, cx!.IARDY));
        let rmq = mq!;
        if (H) { const size = decHuffNum(br!, H.rsize); br!.align(); const s = br!.byte; rmq = new MQDecoder(p.data!, s, s + size); br!.pos = (s + size) * 8; }
        const gw = ib.w + rdw, gh = ib.h + rdh; if (gw < 0 || gh < 0) throw new Error("JBIG2: negative refinement size");
        ib = refineArith(rmq, p.grcx!, gw, gh, p.rtpl, ib, Math.floor(rdw / 2) + rdx, Math.floor(rdh / 2) + rdy, false, p.rat);
      }
      const wi = ib.w, hi = ib.h;
      if (!p.transposed) { if (p.corner === TOPRIGHT || p.corner === BOTTOMRIGHT) curs += wi - 1; }
      else if (p.corner === BOTTOMLEFT || p.corner === BOTTOMRIGHT) curs += hi - 1;
      const s = curs;
      let x: number, y: number;
      if (!p.transposed) { x = p.corner === TOPRIGHT || p.corner === BOTTOMRIGHT ? s - wi + 1 : s; y = p.corner === BOTTOMLEFT || p.corner === BOTTOMRIGHT ? t - hi + 1 : t; }
      else { x = p.corner === TOPRIGHT || p.corner === BOTTOMRIGHT ? t - wi + 1 : t; y = p.corner === BOTTOMLEFT || p.corner === BOTTOMRIGHT ? s - hi + 1 : s; }
      out.compose(ib, x, y, p.op);
      if (!p.transposed) { if (p.corner === TOPLEFT || p.corner === BOTTOMLEFT) curs += wi - 1; }
      else if (p.corner === TOPLEFT || p.corner === TOPRIGHT) curs += hi - 1;
      ninst++;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ segments (7.2) */
interface Seg { num: number; type: number; refs: number[]; page: number; start: number; end: number; rows?: number }
const u32 = (d: Bytes, p: number) => ((d[p] << 24) >>> 0) + (d[p + 1] << 16) + (d[p + 2] << 8) + d[p + 3];
const i32 = (d: Bytes, p: number) => (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
const u16 = (d: Bytes, p: number) => (d[p] << 8) | d[p + 1];
const i8 = (v: number) => (v << 24) >> 24;

function readHeader(d: Bytes, p: number): { seg: Omit<Seg, "start" | "end">; len: number; p: number } | null {
  if (p + 11 > d.length) return null;
  const num = u32(d, p); const fl = d[p + 4]; p += 5;
  let nref = d[p] >> 5;
  if (nref === 7) { nref = u32(d, p) & 0x1fffffff; p += 4 + Math.ceil((nref + 1) / 8); }
  else if (nref > 4) throw new Error("JBIG2: bad referred-to segment count");
  else p += 1;
  const refs: number[] = []; const rs = num <= 256 ? 1 : num <= 65536 ? 2 : 4;
  if (nref > 1 << 16) throw new Error("JBIG2: too many referred-to segments");
  for (let i = 0; i < nref; i++) { refs.push(rs === 1 ? d[p] : rs === 2 ? u16(d, p) : u32(d, p)); p += rs; }
  const page = fl & 0x40 ? u32(d, p) : d[p]; p += fl & 0x40 ? 4 : 1;
  if (p + 4 > d.length) return null;
  const len = u32(d, p); p += 4;
  return { seg: { num, type: fl & 0x3f, refs, page }, len, p };
}
/** data length 0xFFFFFFFF on an immediate generic region: find the end marker and the row count after it (7.2.7) */
function unknownLength(d: Bytes, p: number): { end: number; rows: number } {
  const flags = d[p + 17]; const mmr = flags & 1; const tpl = (flags >> 1) & 3;
  const q0 = p + 18 + (mmr ? 0 : tpl === 0 ? 8 : 2);
  for (let q = q0; q + 6 <= d.length; q++) {
    if (mmr ? d[q] === 0 && d[q + 1] === 0 : d[q] === 0xff && d[q + 1] === 0xac) return { end: q + 6, rows: u32(d, q + 2) };
  }
  return { end: d.length, rows: -1 };
}
function parseSegments(d: Bytes): Seg[] {
  let p = 0; let random = false;
  if (d.length >= 9 && d[0] === 0x97 && d[1] === 0x4a && d[2] === 0x42 && d[3] === 0x32 && d[4] === 0x0d && d[5] === 0x0a && d[6] === 0x1a && d[7] === 0x0a) {
    const fl = d[8]; random = (fl & 1) === 0; p = 9 + (fl & 2 ? 0 : 4);
  }
  const segs: Seg[] = [];
  if (random) { // all headers first, then the data parts in the same order
    const hs: { seg: Omit<Seg, "start" | "end">; len: number }[] = [];
    for (let g = 0; g < 1 << 16; g++) { const h = readHeader(d, p); if (!h) break; p = h.p; hs.push(h); if (h.seg.type === 51) break; }
    for (const h of hs) { const len = h.len === 0xffffffff ? d.length - p : h.len; segs.push({ ...h.seg, start: p, end: Math.min(d.length, p + len) }); p += len; }
    return segs;
  }
  for (let g = 0; g < 1 << 20 && p < d.length; g++) {
    const h = readHeader(d, p); if (!h) break;
    let end: number, rows: number | undefined;
    if (h.len === 0xffffffff) { const u = unknownLength(d, h.p); end = u.end; rows = u.rows >= 0 ? u.rows : undefined; }
    else end = h.p + h.len;
    segs.push({ ...h.seg, start: h.p, end: Math.min(end, d.length), rows });
    p = end;
    if (h.seg.type === 51) break;
  }
  return segs;
}

/* ------------------------------------------------------------------ the decoder */
interface SymDict { syms: Bitmap[]; gb?: Uint8Array; gr?: Uint8Array; retained: boolean; params: string }
export interface Jbig2Out { data: Bytes; width: number; height: number; partial: boolean; warnings: string[] }

class Decoder {
  results = new Map<number, { syms?: Bitmap[]; dict?: SymDict; table?: HTable; pats?: Bitmap[]; region?: Bitmap }>();
  page: Bitmap | null = null; pageH = 0; pageKnown = true; defOp = 0; override = false; defPixel = 0; stripeEnd = -1;
  warnings: string[] = []; partial = false;
  regionInfo(d: Bytes, p: number) { return { w: u32(d, p), h: u32(d, p + 4), x: u32(d, p + 8), y: u32(d, p + 12), op: d[p + 16] & 7 }; }
  /** grow an unknown-height page so a region at rows [y, y+h) fits */
  ensure(rows: number) {
    if (!this.page || this.pageKnown || rows <= this.page.h) return;
    const nh = Math.max(rows, this.page.h * 2 > rows ? Math.min(this.page.h * 2, rows + 4096) : rows);
    const np = new Bitmap(this.page.w, nh, this.defPixel); np.d.set(this.page.d); this.page = np;
  }
  place(bm: Bitmap, x: number, y: number, op: number, refinement = false) {
    if (!this.page) return;
    this.ensure(y + bm.h);
    // a page whose "combination operator overridden" bit is 0 requires every direct region to carry the page default
    // (7.4.8.5), so a conforming file gives the same result either way; the region's own operator is used
    void refinement;
    this.page.compose(bm, x, y, op);
    this.pageH = Math.max(this.pageH, y + bm.h);
  }
  symbolsOf(refs: number[]): Bitmap[] { const out: Bitmap[] = []; for (const r of refs) { const x = this.results.get(r); if (x?.syms) for (const s of x.syms) out.push(s); } return out; }
  tablesOf(refs: number[]): HTable[] { const out: HTable[] = []; for (const r of refs) { const x = this.results.get(r); if (x?.table) out.push(x.table); } return out; }

  segment(s: Seg, d: Bytes) {
    const p = s.start, e = s.end;
    switch (s.type) {
      case 48: { // page information (7.4.8)
        const w = u32(d, p), h = u32(d, p + 4), fl = d[p + 16];
        this.defPixel = (fl >> 2) & 1; this.defOp = (fl >> 3) & 3; this.override = !!(fl & 0x40);
        this.pageKnown = h !== 0xffffffff;
        const h0 = this.pageKnown ? h : Math.min(1024, Math.max(1, Math.floor(MAX_AREA / Math.max(1, w))));
        this.page = new Bitmap(w, this.pageKnown ? h : Math.min(h0, 64), this.defPixel); this.pageH = this.pageKnown ? h : 0;
        return;
      }
      case 50: this.stripeEnd = Math.max(this.stripeEnd, u32(d, p)); this.ensure(this.stripeEnd + 1); return; // end of stripe
      case 49: case 51: case 52: case 62: return; // end of page / file, profiles, extensions
      case 53: this.results.set(s.num, { table: parseTable(d, p, e) }); return;
      case 0: this.symbolDict(s, d); return;
      case 4: case 6: case 7: this.textRegion(s, d); return;
      case 16: this.patternDict(s, d); return;
      case 20: case 22: case 23: this.halftone(s, d); return;
      case 36: case 38: case 39: this.generic(s, d); return;
      case 40: case 42: case 43: this.refinement(s, d); return;
      default: this.warnings.push(`JBIG2 segment type ${s.type} ignored`);
    }
  }

  generic(s: Seg, d: Bytes) {
    const ri = this.regionInfo(d, s.start); let p = s.start + 17; const fl = d[p++];
    const mmr = fl & 1, tpl = (fl >> 1) & 3, tpgdon = !!(fl & 8);
    const at: AT = [];
    if (!mmr) { const n = tpl === 0 ? 4 : 1; for (let i = 0; i < n; i++) { at.push(i8(d[p]), i8(d[p + 1])); p += 2; } }
    const h = s.rows !== undefined ? s.rows : ri.h;
    let bm: Bitmap;
    if (mmr) { const r = genericMMR(d, p, s.end, ri.w, h); bm = r.bm; if (r.partial) this.partial = true; }
    else bm = genericArith(new MQDecoder(d, p, s.end), genericContexts(tpl), ri.w, h, tpl, tpgdon, at);
    if (s.type === 36) this.results.set(s.num, { region: bm });
    else this.place(bm, ri.x, ri.y, ri.op);
  }

  refinement(s: Seg, d: Bytes) {
    const ri = this.regionInfo(d, s.start); let p = s.start + 17; const fl = d[p++];
    const tpl = fl & 1, tpgron = !!(fl & 2); const at: AT = [];
    if (tpl === 0) { at.push(i8(d[p]), i8(d[p + 1]), i8(d[p + 2]), i8(d[p + 3])); p += 4; }
    let ref: Bitmap | null = null;
    for (const r of s.refs) { const x = this.results.get(r); if (x?.region) { ref = x.region; this.results.delete(r); break; } }
    if (!ref) { if (!this.page) throw new Error("JBIG2: refinement without a page"); ref = this.page.sub(ri.x, ri.y, ri.w, ri.h); }
    const bm = refineArith(new MQDecoder(d, p, s.end), refineContexts(tpl), ri.w, ri.h, tpl, ref, 0, 0, tpgron, at);
    if (s.type === 40) this.results.set(s.num, { region: bm });
    else this.place(bm, ri.x, ri.y, ri.op, true);
  }

  symbolDict(s: Seg, d: Bytes) {
    let p = s.start; const fl = u16(d, p); p += 2;
    const huff = !!(fl & 1), refagg = !!(fl & 2), sdhdh = (fl >> 2) & 3, sdhdw = (fl >> 4) & 3, sdbm = (fl >> 6) & 1, sdagg = (fl >> 7) & 1;
    const ctxUsed = !!(fl & 0x100), ctxRetained = !!(fl & 0x200), tpl = (fl >> 10) & 3, rtpl = (fl >> 12) & 1;
    const at: AT = []; const rat: AT = [];
    if (!huff) { const n = tpl === 0 ? 4 : 1; for (let i = 0; i < n; i++) { at.push(i8(d[p]), i8(d[p + 1])); p += 2; } }
    if (refagg && rtpl === 0) { rat.push(i8(d[p]), i8(d[p + 1]), i8(d[p + 2]), i8(d[p + 3])); p += 4; }
    const nEx = u32(d, p), nNew = u32(d, p + 4); p += 8;
    if (nNew > 1 << 20 || nEx > (1 << 20) + 65536) throw new Error("JBIG2: absurd symbol counts");
    const inSyms = this.symbolsOf(s.refs); const custom = this.tablesOf(s.refs); let ci = 0;
    const pick = (sel: number, a: HTable, b2: HTable | null) => (sel === 3 || (b2 === null && sel === 1) ? custom[ci++] : sel === 1 ? b2! : a);
    let tDH: HTable | null = null, tDW: HTable | null = null, tBM: HTable | null = null, tAGG: HTable | null = null;
    if (huff) {
      tDH = pick(sdhdh, B(4), B(5)); tDW = pick(sdhdw, B(2), B(3)); tBM = sdbm ? custom[ci++] : B(1); tAGG = sdagg ? custom[ci++] : B(1);
      if (!tDH || !tDW || !tBM || !tAGG) throw new Error("JBIG2: missing custom Huffman table");
    }
    const params = `${huff}|${refagg}|${tpl}|${rtpl}|${at}|${rat}`;
    let gb: Uint8Array | undefined, gr: Uint8Array | undefined;
    if (ctxUsed) {
      let last: SymDict | undefined; for (const r of s.refs) { const x = this.results.get(r); if (x?.dict) last = x.dict; }
      if (last?.retained && last.params === params) { gb = last.gb ? last.gb.slice() : undefined; gr = last.gr ? last.gr.slice() : undefined; }
      else this.warnings.push("JBIG2: 'context used' without a matching retained dictionary");
    }
    if (!huff && !gb) gb = genericContexts(tpl);
    if (refagg && !gr) gr = refineContexts(rtpl);
    const mq = huff ? undefined : new MQDecoder(d, p, s.end);
    const br = huff ? new BitReader(d, p, s.end) : undefined;
    const symLen = ceilLog2(inSyms.length + nNew);
    const cx = newArithCx(symLen); const IADH = new Uint8Array(512), IADW = new Uint8Array(512), IAEX = new Uint8Array(512), IAAI = new Uint8Array(512);
    const newSyms: Bitmap[] = []; let hcHeight = 0;
    const num = (v: number | null) => { if (v === null) throw new Error("JBIG2: unexpected OOB in a symbol dictionary"); return v; };
    while (newSyms.length < nNew) {
      hcHeight += huff ? decHuffNum(br!, tDH!) : num(decInt(mq!, IADH));
      if (hcHeight < 0 || hcHeight > 1 << 16) throw new Error("JBIG2: bad height class");
      let symW = 0, totW = 0; const first = newSyms.length; const widths: number[] = [];
      for (let g = 0; g < 1 << 20; g++) {
        const dw = huff ? decHuff(br!, tDW!) : decInt(mq!, IADW);
        if (dw === null) break;
        if (newSyms.length >= nNew) throw new Error("JBIG2: more symbols than declared");
        symW += dw; totW += symW; if (symW < 0 || totW > 1 << 24) throw new Error("JBIG2: bad symbol width");
        if (huff && !refagg) { widths.push(symW); newSyms.push(new Bitmap(0, 0)); continue; } // filled from the collective bitmap
        if (!refagg) { newSyms.push(genericArith(mq!, gb!, symW, hcHeight, tpl, false, at)); continue; }
        const nInst = huff ? decHuffNum(br!, tAGG!) : num(decInt(mq!, IAAI));
        const all = inSyms.concat(newSyms);
        if (nInst === 1) {
          let id: number, rdx: number, rdy: number; let rmq = mq!;
          if (huff) {
            id = br!.bits(Math.max(1, symLen)); rdx = decHuffNum(br!, B(15)); rdy = decHuffNum(br!, B(15)); const size = decHuffNum(br!, B(1)); br!.align();
            const st = br!.byte; rmq = new MQDecoder(d, st, st + size); br!.pos = (st + size) * 8;
          } else { id = decId(mq!, cx.IAID, symLen); rdx = num(decInt(mq!, cx.IARDX)); rdy = num(decInt(mq!, cx.IARDY)); }
          if (id < 0 || id >= all.length) throw new Error("JBIG2: refinement symbol id out of range");
          newSyms.push(refineArith(rmq, gr!, symW, hcHeight, rtpl, all[id], rdx, rdy, false, rat));
        } else {
          const ids = huff ? buildTable(Array.from({ length: inSyms.length + nNew }, (_, i) => [Math.max(1, symLen), 0, i, N] as Line)) : null;
          newSyms.push(decodeText({ w: symW, h: hcHeight, n: nInst, strips: 1, syms: all, idLen: symLen, defPixel: 0, op: 0, transposed: false, corner: TOPLEFT, dsOffset: 0,
            refine: true, rtpl, rat, mq, cx, grcx: gr!, br, data: d,
            huff: huff ? { fs: B(6), ds: B(8), dt: B(11), rdw: B(15), rdh: B(15), rdx: B(15), rdy: B(15), rsize: B(1), ids } : undefined }));
        }
      }
      if (huff && !refagg) { // collective bitmap of the height class (6.5.9)
        const bmSize = decHuffNum(br!, tBM!); br!.align(); const st = br!.byte;
        let coll: Bitmap;
        if (bmSize === 0) {
          coll = new Bitmap(totW, hcHeight); const rb = (totW + 7) >> 3;
          for (let y = 0; y < hcHeight; y++) for (let x = 0; x < totW; x++) { const b = d[st + y * rb + (x >> 3)]; coll.d[y * totW + x] = b === undefined ? 0 : (b >> (7 - (x & 7))) & 1; }
          br!.pos = (st + rb * hcHeight) * 8;
        } else { coll = genericMMR(d, st, Math.min(s.end, st + bmSize), totW, hcHeight).bm; br!.pos = (st + bmSize) * 8; }
        let x = 0; for (let k = 0; k < widths.length; k++) { newSyms[first + k] = coll.sub(x, 0, widths[k], hcHeight); x += widths[k]; }
      }
    }
    // export flags (6.5.10)
    const all = inSyms.concat(newSyms); const ex: Bitmap[] = []; let idx = 0, flag = 0;
    for (let g = 0; idx < all.length && g < 1 << 22; g++) {
      const run = huff ? decHuffNum(br!, B(1)) : num(decInt(mq!, IAEX));
      if (run < 0 || idx + run > all.length) throw new Error("JBIG2: bad export run");
      if (flag) for (let k = idx; k < idx + run; k++) ex.push(all[k]);
      idx += run; flag ^= 1;
    }
    if (ex.length !== nEx) this.warnings.push(`JBIG2: ${ex.length} symbols exported, ${nEx} declared`);
    this.results.set(s.num, { syms: ex, dict: { syms: ex, gb, gr, retained: ctxRetained, params } });
  }

  textRegion(s: Seg, d: Bytes) {
    const ri = this.regionInfo(d, s.start); let p = s.start + 17;
    const fl = u16(d, p); p += 2;
    const huff = !!(fl & 1), refine = !!(fl & 2), logStrips = (fl >> 2) & 3, corner = (fl >> 4) & 3, transposed = !!(fl & 0x40);
    const op = (fl >> 7) & 3, defPixel = (fl >> 9) & 1, dsOffset = ((fl >> 10) & 0x1f) << 27 >> 27, rtpl = (fl >> 15) & 1;
    let hfl = 0; if (huff) { hfl = u16(d, p); p += 2; }
    const rat: AT = []; if (refine && rtpl === 0) { rat.push(i8(d[p]), i8(d[p + 1]), i8(d[p + 2]), i8(d[p + 3])); p += 4; }
    const n = u32(d, p); p += 4;
    const syms = this.symbolsOf(s.refs); const custom = this.tablesOf(s.refs); let ci = 0;
    const nextCustom = () => { const t = custom[ci++]; if (!t) throw new Error("JBIG2: missing custom Huffman table"); return t; };
    if (n > 1 << 24) throw new Error("JBIG2: absurd instance count");
    let bm: Bitmap;
    const grcx = refine ? refineContexts(rtpl) : null;
    if (huff) {
      const sel = (v: number, opts: (HTable | null)[]) => (v === 3 ? nextCustom() : opts[v] ?? nextCustom());
      const fs = sel(hfl & 3, [B(6), B(7), null]); const ds = sel((hfl >> 2) & 3, [B(8), B(9), B(10)]); const dtT = sel((hfl >> 4) & 3, [B(11), B(12), B(13)]);
      const rdw = sel((hfl >> 6) & 3, [B(14), B(15), null]), rdh = sel((hfl >> 8) & 3, [B(14), B(15), null]), rdx = sel((hfl >> 10) & 3, [B(14), B(15), null]), rdy = sel((hfl >> 12) & 3, [B(14), B(15), null]);
      const rsize = (hfl >> 14) & 1 ? nextCustom() : B(1);
      // symbol ID Huffman table (7.4.3.1.7): run-code lengths, then code lengths for every symbol
      const br = new BitReader(d, p, s.end);
      const rc: Line[] = []; for (let i = 0; i < 35; i++) rc.push([br.bits(4), 0, i, N]);
      const rct = buildTable(rc); const lens: number[] = [];
      while (lens.length < syms.length) {
        const v = decHuffNum(br, rct);
        if (v < 32) lens.push(v);
        else if (v === 32) { if (!lens.length) throw new Error("JBIG2: repeat with no previous length"); const k = 3 + br.bits(2); const prev = lens[lens.length - 1]; for (let i = 0; i < k; i++) lens.push(prev); }
        else if (v === 33) { const k = 3 + br.bits(3); for (let i = 0; i < k; i++) lens.push(0); }
        else { const k = 11 + br.bits(7); for (let i = 0; i < k; i++) lens.push(0); }
      }
      br.align();
      const ids = buildTable(lens.slice(0, syms.length).map((l, i) => [l, 0, i, N] as Line));
      bm = decodeText({ w: ri.w, h: ri.h, n, strips: 1 << logStrips, syms, idLen: 0, defPixel, op, transposed, corner, dsOffset, refine, rtpl, rat, grcx, br, data: d,
        huff: { fs, ds, dt: dtT, rdw, rdh, rdx, rdy, rsize, ids } });
    } else {
      const idLen = ceilLog2(syms.length);
      bm = decodeText({ w: ri.w, h: ri.h, n, strips: 1 << logStrips, syms, idLen, defPixel, op, transposed, corner, dsOffset, refine, rtpl, rat, grcx,
        mq: new MQDecoder(d, p, s.end), cx: newArithCx(idLen) });
    }
    if (s.type === 4) this.results.set(s.num, { region: bm });
    else this.place(bm, ri.x, ri.y, ri.op);
  }

  patternDict(s: Seg, d: Bytes) {
    const p = s.start; const fl = d[p]; const mmr = fl & 1, tpl = (fl >> 1) & 3; const pw = d[p + 1], ph = d[p + 2]; const grayMax = u32(d, p + 3);
    if (!pw || !ph || grayMax > 1 << 16) throw new Error("JBIG2: bad pattern dictionary");
    const w = (grayMax + 1) * pw; const q = p + 7;
    const at: AT = tpl === 0 ? [-pw, 0, -3, -1, 2, -2, -2, -2] : [-pw, 0];
    const coll = mmr ? genericMMR(d, q, s.end, w, ph).bm : genericArith(new MQDecoder(d, q, s.end), genericContexts(tpl), w, ph, tpl, false, at);
    const pats: Bitmap[] = []; for (let g = 0; g <= grayMax; g++) pats.push(coll.sub(g * pw, 0, pw, ph));
    this.results.set(s.num, { pats });
  }

  halftone(s: Seg, d: Bytes) {
    const ri = this.regionInfo(d, s.start); let p = s.start + 17; const fl = d[p++];
    const mmr = fl & 1, tpl = (fl >> 1) & 3, enableSkip = !!(fl & 8), op = (fl >> 4) & 7, defPixel = (fl >> 7) & 1;
    const gw = u32(d, p), gh = u32(d, p + 4), gx = i32(d, p + 8), gy = i32(d, p + 12), rx = u16(d, p + 16), ry = u16(d, p + 18); p += 20;
    let pats: Bitmap[] = []; for (const r of s.refs) { const x = this.results.get(r); if (x?.pats) { pats = x.pats; break; } }
    if (!pats.length) throw new Error("JBIG2: halftone region without patterns");
    if (gw * gh > MAX_AREA / 8) throw new Error("JBIG2: halftone grid too large");
    const out = new Bitmap(ri.w, ri.h, defPixel); const pw = pats[0].w, ph = pats[0].h;
    const cellX = (m: number, n: number) => Math.floor((gx + m * ry + n * rx) / 256), cellY = (m: number, n: number) => Math.floor((gy + m * rx - n * ry) / 256);
    let skip: Bitmap | null = null;
    if (enableSkip) {
      skip = new Bitmap(gw, gh);
      for (let m = 0; m < gh; m++) for (let n = 0; n < gw; n++) { const x = cellX(m, n), y = cellY(m, n); if (x + pw <= 0 || x >= ri.w || y + ph <= 0 || y >= ri.h) skip.d[m * gw + n] = 1; }
    }
    const bpp = Math.max(1, ceilLog2(pats.length)); // HBPP
    // gray-scale image decoding (C.5): bit planes from the most significant, Gray-coded
    const planes: Bitmap[] = new Array(bpp);
    const at: AT = [tpl <= 1 ? 3 : 2, -1, -3, -1, 2, -2, -2, -2];
    const mq = mmr ? null : new MQDecoder(d, p, s.end); const cx = mmr ? null : genericContexts(tpl); let q = p;
    for (let j = bpp - 1; j >= 0; j--) {
      if (mmr) { const r = genericMMR(d, q, s.end, gw, gh); planes[j] = r.bm; q += r.used; if (r.partial) this.partial = true; }
      else planes[j] = genericArith(mq!, cx!, gw, gh, tpl, false, at, skip);
      if (j < bpp - 1) { const a = planes[j].d, b = planes[j + 1].d; for (let i = 0; i < a.length; i++) a[i] ^= b[i]; }
    }
    for (let m = 0; m < gh; m++) for (let n = 0; n < gw; n++) {
      let v = 0; for (let j = bpp - 1; j >= 0; j--) v = (v << 1) | planes[j].d[m * gw + n];
      v = Math.min(v, pats.length - 1);
      out.compose(pats[v], cellX(m, n), cellY(m, n), op);
    }
    if (s.type === 20) this.results.set(s.num, { region: out });
    else this.place(out, ri.x, ri.y, ri.op);
  }
}

/** decode a /JBIG2Decode stream (with its optional /JBIG2Globals) to PDF 1-bit samples (0 = black) */
export function jbig2Decode(data: Bytes, globals: Bytes | null, want?: { width: number; height: number }): Jbig2Out {
  const dec = new Decoder();
  const run = (bytes: Bytes) => {
    let segs: Seg[];
    try { segs = parseSegments(bytes); } catch (e) { dec.partial = true; dec.warnings.push(String((e as Error).message)); return false; }
    for (const s of segs) {
      try { dec.segment(s, bytes); }
      catch (e) { dec.partial = true; dec.warnings.push(`segment ${s.num} (type ${s.type}): ${(e as Error).message}`); if (/too large|absurd/.test((e as Error).message)) return false; }
    }
    return true;
  };
  if (globals && globals.length) run(globals);
  run(data);
  let page = dec.page;
  if (page && !dec.pageKnown) { const h = Math.max(dec.pageH, dec.stripeEnd + 1); page = page.sub(0, 0, page.w, Math.max(1, h)); }
  const W = want?.width ?? page?.w ?? 0, H = want?.height ?? page?.h ?? 0;
  const rb = (W + 7) >> 3; const out = new Uint8Array(rb * H).fill(0xff);
  if (page) {
    for (let y = 0; y < Math.min(H, page.h); y++) {
      const r = y * page.w, o = y * rb;
      for (let x = 0; x < Math.min(W, page.w); x++) if (page.d[r + x]) out[o + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  } else { dec.partial = true; dec.warnings.push("JBIG2: no page information segment"); }
  return { data: out, width: W, height: H, partial: dec.partial, warnings: dec.warnings };
}
