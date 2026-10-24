/**
 * TT52 — PDF fonts (ISO 32000-2 §9.5–9.10), original code from the specification:
 *   simple fonts (Type1, MMType1, TrueType, Type3): base encodings, /Differences, built-in encodings, §9.6.5.4 TrueType
 *   cmap selection, /Widths + /MissingWidth + standard-14 AFM widths;
 *   composite fonts (Type0 → CIDFontType0/2): Identity-H/V, UCS-2/UTF-16 predefined CMaps, embedded CMap streams
 *   (codespace ranges, cidchar/cidrange, usecmap), /W /DW /W2 /DW2, /CIDToGIDMap;
 *   text extraction: ToUnicode CMaps (bfchar/bfrange incl. array form), glyph names (AGL, uniXXXX, uXXXX[XX]), TrueType
 *   (3,1) reverse lookup.
 * Not bundled: Adobe's predefined CJK CMaps (e.g. 90ms-RKSJ-H) — such fonts decode codes by codespace heuristics and
 * use /ToUnicode for text; their glyphs render only when the code is also the CID/GID (disclosed in DESIGN-TT52).
 */
import { PDict, PStr, PStream, Lexer, PKw, isArr, isDict, isName, isNum, isStream, type PObj, type Bytes, type Token } from "./pdfobj";
import type { PdfDoc } from "./pdfdoc";
import { AGL, AGL_ZAPF, ENC_MACROMAN, ENC_STANDARD, ENC_SYMBOL, ENC_WINANSI, ENC_ZAPF, GLYPH_NAMES, STD14 } from "./fontdata";
import { parseCFF, parseSfnt, parseType1, type FontProgram, type Outline } from "./pdfglyph";

export interface Glyph {
  code: number; bytes: number; cid: number; gid: number; name: string | null; unicode: string;
  /** horizontal advance in text space units ×1000 (glyph space for Type 3 is converted) */
  w: number;
  /** vertical writing: displacement and position vector (×1000) */
  vy?: number; vx?: number; vyPos?: number;
  /** true for the single-byte code 32 (word spacing applies, §9.3.3) */
  space: boolean;
}

/* ------------------------------------------------------------------ shared tables */
let AGL_MAP: Map<string, string> | null = null;
export function aglMap(): Map<string, string> {
  if (AGL_MAP) return AGL_MAP;
  const m = new Map<string, string>();
  for (const e of AGL.split(";")) { const sp = e.indexOf(" "); m.set(e.slice(0, sp), e.slice(sp + 1).split("_").map((h) => String.fromCodePoint(parseInt(h, 16))).join("")); }
  return (AGL_MAP = m);
}
let ZAPF_MAP: Map<string, string> | null = null;
function zapfMap(): Map<string, string> {
  if (!ZAPF_MAP) { ZAPF_MAP = new Map(); for (const e of AGL_ZAPF.split(";")) { const sp = e.indexOf(" "); ZAPF_MAP.set(e.slice(0, sp), String.fromCodePoint(parseInt(e.slice(sp + 1), 16))); } }
  return ZAPF_MAP;
}
/** glyph name → Unicode (AGL specification: components, ligature underscores, uniXXXX, uXXXX…) */
export function nameToUnicode(name: string): string {
  const m = aglMap(); const direct = m.get(name); if (direct) return direct;
  const base = name.split(".")[0]; if (!base) return "";
  if (base !== name) { const d = m.get(base); if (d) return d; }
  if (base.includes("_")) return base.split("_").map(nameToUnicode).join("");
  let r = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (r) { let s = ""; for (let i = 0; i < r[1].length; i += 4) { const c = parseInt(r[1].slice(i, i + 4), 16); if (c < 0xd800 || c > 0xdfff) s += String.fromCharCode(c); } return s; }
  r = /^u([0-9A-F]{4,6})$/.exec(base); if (r) { const c = parseInt(r[1], 16); if (c <= 0x10ffff && (c < 0xd800 || c > 0xdfff)) return String.fromCodePoint(c); }
  // common non-AGL forms produced by font tools: "g123", "cid123", "aXX"/"GXX" hex — no Unicode
  r = /^(?:uni|u)?([0-9a-fA-F]{4})$/.exec(base); if (r && /[a-fA-F]/.test(r[1]) === false && base.startsWith("uni")) return String.fromCharCode(parseInt(r[1], 16));
  return "";
}
const encCache = new Map<string, (string | null)[]>();
function encTable(name: string): (string | null)[] | null {
  const src = name === "StandardEncoding" ? ENC_STANDARD : name === "WinAnsiEncoding" ? ENC_WINANSI : name === "MacRomanEncoding" ? ENC_MACROMAN : name === "Symbol" ? ENC_SYMBOL : name === "ZapfDingbats" ? ENC_ZAPF : name === "MacExpertEncoding" ? ENC_STANDARD : null;
  if (!src) return null;
  let t = encCache.get(name); if (!t) { t = src.split(" ").map((x) => (x === "." ? null : x)); encCache.set(name, t); }
  return t;
}
let GN_IDX: Map<string, number> | null = null;
const glyphIndex = () => (GN_IDX ??= new Map(GLYPH_NAMES.split(" ").map((n, i) => [n, i])));
const std14Widths = new Map<string, Uint16Array>();
/** canonical standard-14 name for a BaseFont (aliases like Arial, TimesNewRoman, CourierNew per common practice) */
export function std14Name(base: string): string | null {
  let n = base.replace(/^[A-Z]{6}\+/, "");
  const alias: Record<string, string> = { Arial: "Helvetica", ArialMT: "Helvetica", "Arial-BoldMT": "Helvetica-Bold", "Arial-ItalicMT": "Helvetica-Oblique", "Arial-BoldItalicMT": "Helvetica-BoldOblique", "Arial,Bold": "Helvetica-Bold", "Arial,Italic": "Helvetica-Oblique", "Arial,BoldItalic": "Helvetica-BoldOblique",
    TimesNewRoman: "Times-Roman", TimesNewRomanPSMT: "Times-Roman", "TimesNewRoman,Bold": "Times-Bold", "TimesNewRoman,Italic": "Times-Italic", "TimesNewRoman,BoldItalic": "Times-BoldItalic", "TimesNewRomanPS-BoldMT": "Times-Bold", "TimesNewRomanPS-ItalicMT": "Times-Italic", "TimesNewRomanPS-BoldItalicMT": "Times-BoldItalic",
    CourierNew: "Courier", CourierNewPSMT: "Courier", "CourierNew,Bold": "Courier-Bold", "CourierNew,Italic": "Courier-Oblique", "CourierNew,BoldItalic": "Courier-BoldOblique", "CourierNewPS-BoldMT": "Courier-Bold", "CourierNewPS-ItalicMT": "Courier-Oblique", "CourierNewPS-BoldItalicMT": "Courier-BoldOblique",
    "Helvetica,Bold": "Helvetica-Bold", "Helvetica,Italic": "Helvetica-Oblique", "Helvetica,BoldItalic": "Helvetica-BoldOblique", "Times-Roman,Bold": "Times-Bold", Symbol: "Symbol", "Symbol,Bold": "Symbol", "Symbol,Italic": "Symbol", ZapfDingbats: "ZapfDingbats", "Times,Bold": "Times-Bold", "Times,Italic": "Times-Italic", Times: "Times-Roman", "Times,BoldItalic": "Times-BoldItalic" };
  if (STD14[n]) return n; if (alias[n]) return alias[n];
  n = n.replace(/-(Roman|Regular)$/, ""); if (STD14[n]) return n;
  return null;
}
export function std14Width(font: string, glyph: string): number | undefined {
  const f = STD14[font]; if (!f) return undefined;
  let w = std14Widths.get(font);
  if (!w) { const bin = atob(f.w); w = new Uint16Array(bin.length / 2); for (let i = 0; i < w.length; i++) w[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); std14Widths.set(font, w); }
  const i = glyphIndex().get(glyph); return i === undefined || !w[i] ? undefined : w[i];
}
export const std14Metrics = (font: string) => STD14[font];

/* ------------------------------------------------------------------ CMaps */
interface Range { lo: number[]; hi: number[] }
export class CMap {
  codespace: Range[] = [];
  /** code (by byte length) → CID */
  cidSingle = new Map<string, number>();
  cidRanges: { n: number; lo: number; hi: number; cid: number }[] = [];
  /** code → Unicode text (ToUnicode) */
  uni = new Map<string, string>();
  uniRanges: { n: number; lo: number; hi: number; dst: Bytes | string[] }[] = [];
  vertical = false;
  identity = false;
  static key(n: number, c: number) { return `${n}:${c}`; }
  /** split a string into codes per the codespace ranges (§9.7.6.2); falls back to 1 byte (or 2 for Identity) */
  next(b: Bytes, p: number): { code: number; n: number } {
    if (this.identity || !this.codespace.length) { const n = this.identity ? 2 : 1; let c = 0; for (let i = 0; i < n; i++) c = c * 256 + (b[p + i] ?? 0); return { code: c, n: Math.min(n, b.length - p) || 1 }; }
    for (let n = 1; n <= 4; n++) {
      if (p + n > b.length) break;
      for (const r of this.codespace) {
        if (r.lo.length !== n) continue;
        let ok = true; for (let i = 0; i < n; i++) if (b[p + i] < r.lo[i] || b[p + i] > r.hi[i]) { ok = false; break; }
        if (ok) { let c = 0; for (let i = 0; i < n; i++) c = c * 256 + b[p + i]; return { code: c, n }; }
      }
    }
    // no match: consume the length of the shortest range that starts with a matching first byte, else 1
    let n = 1; for (const r of this.codespace) if (b[p] >= r.lo[0] && b[p] <= r.hi[0]) { n = r.lo.length; break; }
    n = Math.min(n, b.length - p); let c = 0; for (let i = 0; i < n; i++) c = c * 256 + b[p + i];
    return { code: c, n: Math.max(1, n) };
  }
  cid(code: number, n: number): number | undefined {
    if (this.identity) return code;
    const s = this.cidSingle.get(CMap.key(n, code)); if (s !== undefined) return s;
    for (const r of this.cidRanges) if (r.n === n && code >= r.lo && code <= r.hi) return r.cid + (code - r.lo);
    return undefined;
  }
  unicode(code: number, n: number): string | undefined {
    const s = this.uni.get(CMap.key(n, code)); if (s !== undefined) return s;
    // ToUnicode maps may be written with a different byte length than the font's codes: try any length
    for (const r of this.uniRanges) {
      if (code >= r.lo && code <= r.hi && (r.n === n || this.uniRanges.length < 4096)) {
        if (Array.isArray(r.dst)) return r.dst[code - r.lo] ?? "";
        const d = r.dst.slice(); const inc = code - r.lo; // increment the last byte(s)
        let carry = inc; for (let i = d.length - 1; i >= 0 && carry; i--) { const v = d[i] + carry; d[i] = v & 255; carry = v >> 8; }
        return utf16be(d);
      }
    }
    for (let k = 1; k <= 4; k++) if (k !== n) { const t = this.uni.get(CMap.key(k, code)); if (t !== undefined) return t; }
    return undefined;
  }
}
export function utf16be(b: Bytes): string {
  let s = ""; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]);
  return s;
}
const bytesNum = (b: Bytes) => { let c = 0; for (const x of b) c = c * 256 + x; return c; };
/** parse a CMap program (embedded CMap or ToUnicode); `use` resolves usecmap names */
export function parseCMap(data: Bytes, into = new CMap(), resolveCMap?: (name: string) => CMap | null): CMap {
  const lx = new Lexer(data, 0); const st: PObj[] = []; let mode = ""; let guard = 0;
  const delim = (t: unknown): string | null => (t && typeof t === "object" && "delim" in (t as object) ? (t as { delim: string }).delim : null);
  for (;;) {
    if (++guard > 5_000_000) break;
    let t: Token;
    try { t = lx.next(); } catch { break; }
    if (t === undefined) break;
    const dl = delim(t);
    if (dl === "[") { const arr: PObj[] = []; for (let g = 0; g < 100000; g++) { const u = lx.next(); if (u === undefined || delim(u) === "]") break; if (!(u instanceof PKw) && !delim(u)) arr.push(u as PObj); } st.push(arr); continue; }
    if (dl === "<<") { let depth = 1; for (let g = 0; g < 100000 && depth; g++) { const u = lx.next(); if (u === undefined) break; const d2 = delim(u); if (d2 === "<<") depth++; else if (d2 === ">>") depth--; } continue; }
    if (dl !== null) continue;
    if (!(t instanceof PKw)) { st.push(t as PObj); if (st.length > 100000) st.splice(0, 50000); continue; }
    const k = t.k;
    if (k.startsWith("begin")) { mode = k.slice(5); st.length = 0; continue; }
    if (k.startsWith("end") && mode && k.slice(3) === mode) {
      const s = st.slice(); st.length = 0;
      if (mode === "codespacerange") for (let i = 0; i + 1 < s.length; i += 2) { const a = s[i], b = s[i + 1]; if (a instanceof PStr && b instanceof PStr && a.b.length && a.b.length === b.b.length && a.b.length <= 4) into.codespace.push({ lo: [...a.b], hi: [...b.b] }); }
      else if (mode === "cidchar") for (let i = 0; i + 1 < s.length; i += 2) { const a = s[i], c = s[i + 1]; if (a instanceof PStr && isNum(c)) into.cidSingle.set(CMap.key(a.b.length, bytesNum(a.b)), c); }
      else if (mode === "cidrange") for (let i = 0; i + 2 < s.length; i += 3) { const a = s[i], b = s[i + 1], c = s[i + 2]; if (a instanceof PStr && b instanceof PStr && isNum(c)) into.cidRanges.push({ n: a.b.length, lo: bytesNum(a.b), hi: bytesNum(b.b), cid: c }); }
      else if (mode === "bfchar") for (let i = 0; i + 1 < s.length; i += 2) { const a = s[i], d = s[i + 1]; if (a instanceof PStr) { const txt = d instanceof PStr ? utf16be(d.b) : isName(d) ? nameToUnicode(d.n) : null; if (txt !== null) into.uni.set(CMap.key(a.b.length, bytesNum(a.b)), txt); } }
      else if (mode === "bfrange") for (let i = 0; i + 2 < s.length; i += 3) {
        const a = s[i], b = s[i + 1], d = s[i + 2]; if (!(a instanceof PStr && b instanceof PStr)) continue;
        const lo = bytesNum(a.b), hi = bytesNum(b.b); if (hi < lo || hi - lo > 65535) continue;
        if (d instanceof PStr) into.uniRanges.push({ n: a.b.length, lo, hi, dst: d.b });
        else if (isArr(d)) into.uniRanges.push({ n: a.b.length, lo, hi, dst: d.map((x) => (x instanceof PStr ? utf16be(x.b) : "")) });
      }
      else if (mode === "notdefrange") { /* CID 0 is the default anyway */ }
      mode = ""; continue;
    }
    if (k === "usecmap") { const n = st.pop(); if (isName(n) && resolveCMap) { const u = resolveCMap(n.n); if (u) { into.codespace.push(...u.codespace); u.cidSingle.forEach((v, kk) => into.cidSingle.set(kk, v)); into.cidRanges.push(...u.cidRanges); if (u.identity) into.identity = into.identity || !into.cidRanges.length; } } continue; }
    if (k === "def") { const v = st.pop(), n = st.pop(); if (isName(n, "WMode") && v === 1) into.vertical = true; continue; }
  }
  return into;
}
/** byte encodings behind Adobe's legacy CJK CMap names (CMap names per Adobe TN 5094 and the cmap-resources set) */
export function legacyCMap(name: string): { enc: string; codespace: Range[] } | null {
  const sb = (lo: number, hi: number): Range => ({ lo: [lo], hi: [hi] }); const db = (a: number, b: number, c: number, d: number): Range => ({ lo: [a, c], hi: [b, d] });
  if (/RKSJ/.test(name)) return { enc: "shift_jis", codespace: [sb(0, 0x80), sb(0xa0, 0xdf), db(0x81, 0x9f, 0x40, 0xfc), db(0xe0, 0xfc, 0x40, 0xfc)] };
  if (/^(EUC-[HV]|83pv-RKSJ|Ext-H|Ext-V)$/.test(name)) return { enc: "euc-jp", codespace: [sb(0, 0x80), db(0x8e, 0x8e, 0xa0, 0xdf), db(0xa1, 0xfe, 0xa1, 0xfe)] };
  if (/^GBK2K|^GBKp?-EUC|^GBT-EUC|^GBTpc-EUC/.test(name)) return { enc: "gb18030", codespace: [sb(0, 0x80), db(0x81, 0xfe, 0x40, 0xfe)] };
  if (/^GBp?c?-EUC|^GB-EUC/.test(name)) return { enc: "gbk", codespace: [sb(0, 0x80), db(0xa1, 0xfe, 0xa1, 0xfe)] };
  if (/B5|HKscs|HKdla|HKdlb|HKgccs|HKm3|HKm4/.test(name)) return { enc: "big5", codespace: [sb(0, 0x80), db(0xa1, 0xfe, 0x40, 0xfe)] };
  if (/^KSC(ms|pc)?-(EUC|UHC|HW)|^KSCms-UHC/.test(name)) return { enc: "euc-kr", codespace: [sb(0, 0x80), db(0x81, 0xfe, 0x41, 0xfe)] };
  return null;
}
export function predefinedCMap(name: string): CMap | null {
  const c = new CMap();
  if (name === "Identity-H" || name === "Identity-V") { c.identity = true; c.vertical = name.endsWith("V"); c.codespace.push({ lo: [0, 0], hi: [255, 255] }); return c; }
  // UCS-2 / UTF-16 CMaps: the code is the Unicode value (the CID is not derivable without Adobe's tables)
  if (/^Uni[A-Za-z]+-(UCS2|UTF16)-[HV]$/.test(name)) { c.vertical = name.endsWith("V"); c.codespace.push({ lo: [0, 0], hi: [0xd7, 0xff] }, { lo: [0xe0, 0], hi: [0xff, 0xff] }, { lo: [0xd8, 0, 0xdc, 0], hi: [0xdb, 0xff, 0xdf, 0xff] }); (c as CMap & { ucs2?: boolean }).ucs2 = true; return c; }
  return null;
}

/* ------------------------------------------------------------------ font */
export type FontKind = "simple" | "type0" | "type3";
export class PdfFont {
  kind: FontKind = "simple"; subtype = ""; dingbats = false; private ordering = ""; baseFont = ""; std14: string | null = null;
  program: FontProgram | null = null; programError: string | null = null;
  flags = 0; italicAngle = 0; ascent = 800; descent = -200; bold = false; serif = false; fixed = false; italic = false;
  vertical = false;
  fontMatrix: number[] = [0.001, 0, 0, 0.001, 0, 0];
  /** simple fonts */
  private enc: (string | null)[] = new Array(256).fill(null);
  private hasEncoding = false; private hasDifferences = false;
  private widths = new Map<number, number>(); private missingWidth = 0;
  /** composite fonts */
  private cmap: CMap | null = null; private cidToGid: Uint8Array | null = null; private cidIdentity = true;
  private dw = 1000; private cidW = new Map<number, number>(); private cidWRanges: { lo: number; hi: number; w: number }[] = [];
  private dw2: [number, number] = [880, -1000]; private cidW2 = new Map<number, [number, number, number]>();
  private toUni: CMap | null = null;
  private ucs2 = false; private toUniIdentity = false;
  /** legacy CJK CMaps named after a byte encoding: text via TextDecoder (CIDs are not derivable without Adobe's tables) */
  private legacy: TextDecoder | null = null;
  /** Type 3 */
  charProcs: PDict | null = null; resources: PDict | null = null;
  private gidUniRev: Map<number, string> | null = null;
  private cache = new Map<number, Glyph>();
  warnings: string[] = [];

  static load(doc: PdfDoc, dict: PDict): PdfFont {
    const f = new PdfFont(); try { f.init(doc, dict); } catch (e) { f.warnings.push(`font: ${(e as Error).message}`); }
    return f;
  }
  private init(doc: PdfDoc, d: PDict) {
    const sub = doc.get(d, "Subtype"); this.subtype = isName(sub) ? sub.n : "Type1";
    const bf = doc.get(d, "BaseFont"); this.baseFont = isName(bf) ? bf.n : "";
    const tu = doc.resolve(d.get("ToUnicode"));
    if (isStream(tu)) { try { this.toUni = parseCMap(doc.decode(tu).data); } catch { /* ignore broken ToUnicode */ } }
    else if (isName(tu) && /^Identity-[HV]$/.test(tu.n)) this.toUniIdentity = true; // code = UCS-2 (common writer shortcut)
    if (this.subtype === "Type0") return this.initType0(doc, d);
    if (this.subtype === "Type3") return this.initType3(doc, d);
    this.std14 = std14Name(this.baseFont);
    this.dingbats = this.std14 === "ZapfDingbats" || /dingbats/i.test(this.baseFont);
    const fd = doc.dict(d.get("FontDescriptor"));
    this.readDescriptor(doc, fd);
    this.loadProgram(doc, fd, false);
    // encoding
    const symbolicStd = this.std14 === "Symbol" || this.std14 === "ZapfDingbats";
    let base: (string | null)[] | null = null;
    const e = doc.resolve(d.get("Encoding"));
    const builtin = this.program?.builtinEncoding ?? (symbolicStd ? encTable(this.std14!) : null);
    if (isName(e)) { base = encTable(e.n); this.hasEncoding = !!base; }
    else if (isDict(e)) {
      const be = doc.resolve(e.get("BaseEncoding")); if (isName(be)) base = encTable(be.n);
      this.hasEncoding = true;
      if (!base) base = (this.subtype === "TrueType" ? null : builtin) ?? (this.isSymbolic() && this.subtype !== "TrueType" ? null : encTable("StandardEncoding"));
      this.enc = (base ?? new Array(256).fill(null)).slice();
      const diffs = doc.arr(e.get("Differences")); let code = 0;
      for (const x of diffs) { const v = doc.resolve(x); if (isNum(v)) code = v; else if (isName(v)) { if (code >= 0 && code < 256) this.enc[code] = v.n; code++; this.hasDifferences = true; } }
      base = null;
    }
    if (base) this.enc = base.slice();
    else if (!this.hasEncoding) {
      if (builtin) this.enc = builtin.slice();
      else if (this.subtype !== "TrueType" || !this.isSymbolic()) this.enc = encTable("StandardEncoding")!.slice();
    }
    // a font program with a built-in encoding fills codes the encoding leaves undefined
    if (builtin && this.subtype !== "TrueType") for (let c = 0; c < 256; c++) if (!this.enc[c] && builtin[c]) this.enc[c] = builtin[c];
    // widths
    const fc = doc.num(d.get("FirstChar"), 0); const ws = doc.arr(d.get("Widths"));
    ws.forEach((w, i) => this.widths.set(fc + i, doc.num(w, 0)));
    this.missingWidth = fd ? doc.num(fd.get("MissingWidth"), 0) : 0;
  }
  private isSymbolic() { return (this.flags & 4) !== 0 && (this.flags & 32) === 0; }
  private readDescriptor(doc: PdfDoc, fd: PDict | null) {
    if (this.std14) { const m = STD14[this.std14]; this.ascent = m.asc; this.descent = m.desc; this.italicAngle = m.italic; this.fixed = m.fixed; this.bold = m.bold; this.serif = this.std14.startsWith("Times"); this.flags = this.std14 === "Symbol" || this.std14 === "ZapfDingbats" ? 4 : 32; }
    if (!fd) return;
    this.flags = doc.num(fd.get("Flags"), this.flags);
    this.italicAngle = doc.num(fd.get("ItalicAngle"), this.italicAngle);
    const a = doc.num(fd.get("Ascent"), 0), de = doc.num(fd.get("Descent"), 0);
    if (a) this.ascent = a; if (de) this.descent = de < 0 ? de : -de;
    this.fixed = (this.flags & 1) !== 0; this.serif = (this.flags & 2) !== 0; this.italic = (this.flags & 64) !== 0 || this.italicAngle !== 0;
    this.bold = (this.flags & (1 << 18)) !== 0 || doc.num(fd.get("FontWeight"), 400) >= 600 || /bold|black|heavy/i.test(this.baseFont);
  }
  private loadProgram(doc: PdfDoc, fd: PDict | null, cid: boolean) {
    if (!fd) return;
    const ff = doc.resolve(fd.get("FontFile")), ff2 = doc.resolve(fd.get("FontFile2")), ff3 = doc.resolve(fd.get("FontFile3"));
    try {
      if (isStream(ff2)) this.program = parseSfnt(doc.decode(ff2).data);
      else if (isStream(ff3)) {
        const data = doc.decode(ff3).data; const st = doc.resolve(ff3.dict.get("Subtype"));
        this.program = isName(st, "OpenType") ? parseSfnt(data) : parseCFF(data) ?? parseSfnt(data);
      } else if (isStream(ff)) { const data = doc.decode(ff).data; this.program = parseType1(data, doc.num(ff.dict.get("Length1"), 0)) ?? parseCFF(data); }
      if ((isStream(ff) || isStream(ff2) || isStream(ff3)) && !this.program) this.programError = "embedded font program could not be parsed";
    } catch (e) { this.programError = (e as Error).message; this.program = null; }
    if (this.program && this.program.kind !== "truetype") this.fontMatrix = this.program.matrix.slice();
    void cid;
  }
  private initType3(doc: PdfDoc, d: PDict) {
    this.kind = "type3";
    const fm = doc.arr(d.get("FontMatrix")).map((x) => doc.num(x, 0)); if (fm.length === 6) this.fontMatrix = fm;
    this.charProcs = doc.dict(d.get("CharProcs")); this.resources = doc.dict(d.get("Resources"));
    const e = doc.resolve(d.get("Encoding"));
    if (isDict(e)) { let code = 0; for (const x of doc.arr(e.get("Differences"))) { const v = doc.resolve(x); if (isNum(v)) code = v; else if (isName(v)) { if (code >= 0 && code < 256) this.enc[code] = v.n; code++; } } }
    const fc = doc.num(d.get("FirstChar"), 0); doc.arr(d.get("Widths")).forEach((w, i) => this.widths.set(fc + i, doc.num(w, 0)));
    this.readDescriptor(doc, doc.dict(d.get("FontDescriptor")));
  }
  private initType0(doc: PdfDoc, d: PDict) {
    this.kind = "type0";
    const e = doc.resolve(d.get("Encoding"));
    if (isName(e)) {
      this.cmap = predefinedCMap(e.n);
      if (!this.cmap) {
        const lg = legacyCMap(e.n);
        this.cmap = new CMap(); this.cmap.vertical = /-V$/.test(e.n);
        if (lg) { this.cmap.codespace.push(...lg.codespace); try { this.legacy = new TextDecoder(lg.enc); } catch { /* not supported */ } }
        else this.cmap.codespace.push({ lo: [0], hi: [0x80] }, { lo: [0x81, 0x40], hi: [0xfe, 0xfe] });
        this.warnings.push(`predefined CMap ${e.n}: CID tables are not bundled${this.legacy ? " (text decoded via " + lg!.enc + ")" : ""}`);
      }
    }
    else if (isStream(e)) { this.cmap = parseCMap(doc.decode(e).data, new CMap(), (n) => predefinedCMap(n)); const wm = doc.resolve(e.dict.get("WMode")); if (wm === 1) this.cmap.vertical = true; }
    else this.cmap = predefinedCMap("Identity-H");
    this.ucs2 = !!(this.cmap as CMap & { ucs2?: boolean }).ucs2;
    this.vertical = this.cmap!.vertical;
    const df = doc.dict(doc.arr(d.get("DescendantFonts"))[0]); if (!df) return;
    const st = doc.resolve(df.get("Subtype")); this.subtype = isName(st) ? st.n : "CIDFontType2";
    const si = doc.dict(df.get("CIDSystemInfo")); const ord = si ? doc.resolve(si.get("Ordering")) : null; const reg = si ? doc.resolve(si.get("Registry")) : null;
    if (ord instanceof PStr && reg instanceof PStr && new TextDecoder("latin1").decode(reg.b) === "Adobe") this.ordering = new TextDecoder("latin1").decode(ord.b);
    const fd = doc.dict(df.get("FontDescriptor"));
    this.readDescriptor(doc, fd); this.loadProgram(doc, fd, true);
    this.dw = doc.num(df.get("DW"), 1000);
    const W = doc.arr(df.get("W"));
    for (let i = 0; i < W.length && i < 200000;) {
      const a = doc.num(W[i]); const nx = doc.resolve(W[i + 1]);
      if (isArr(nx)) { nx.forEach((w, k) => this.cidW.set(a + k, doc.num(w))); i += 2; }
      else { const b = doc.num(nx), w = doc.num(W[i + 2]); if (b >= a && b - a < 1_000_000) this.cidWRanges.push({ lo: a, hi: b, w }); i += 3; }
    }
    const dw2 = doc.arr(df.get("DW2")).map((x) => doc.num(x)); if (dw2.length === 2) this.dw2 = [dw2[0], dw2[1]];
    const W2 = doc.arr(df.get("W2"));
    for (let i = 0; i < W2.length && i < 200000;) {
      const a = doc.num(W2[i]); const nx = doc.resolve(W2[i + 1]);
      if (isArr(nx)) { for (let k = 0; k + 2 < nx.length; k += 3) this.cidW2.set(a + k / 3, [doc.num(nx[k]), doc.num(nx[k + 1]), doc.num(nx[k + 2])]); i += 2; }
      else { const b = doc.num(nx); const v: [number, number, number] = [doc.num(W2[i + 2]), doc.num(W2[i + 3]), doc.num(W2[i + 4])]; for (let c = a; c <= b && c - a < 65536; c++) this.cidW2.set(c, v); i += 5; }
    }
    const c2g = doc.resolve(df.get("CIDToGIDMap"));
    if (isStream(c2g)) { this.cidToGid = doc.decode(c2g).data; this.cidIdentity = false; }
  }

  /** decode a string operand into glyphs */
  decode(b: Bytes): Glyph[] {
    const out: Glyph[] = [];
    if (this.kind !== "type0") {
      for (let i = 0; i < b.length; i++) out.push(this.simpleGlyph(b[i]));
      return out;
    }
    for (let p = 0; p < b.length && out.length < 1_000_000;) {
      const { code, n } = this.cmap!.next(b, p); p += n;
      out.push(this.cidGlyph(code, n));
    }
    return out;
  }
  private simpleGlyph(code: number): Glyph {
    const c = this.cache.get(code); if (c) return c;
    const name = this.enc[code] ?? null;
    let gid = -1;
    const pr = this.program;
    if (pr && this.kind === "simple") {
      if (pr.kind === "truetype" || (pr.cmapLookup && !pr.builtinEncoding)) gid = this.trueTypeGid(code, name);
      else { if (name) gid = pr.gidForName(name); if (gid < 0 && pr.builtinEncoding?.[code]) gid = pr.gidForName(pr.builtinEncoding[code]!); if (gid < 0 && name) { const u = nameToUnicode(name); if (u.length === 1) gid = pr.gidForName(`uni${u.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`); } }
    }
    let unicode = this.toUni?.unicode(code, 1);
    if (unicode === undefined) {
      unicode = name ? (this.dingbats ? zapfMap().get(name) ?? nameToUnicode(name) : nameToUnicode(name)) : "";
      // unknown or missing glyph name (TeX /a12, /g3, /square…): the code itself, read as WinAnsi — what PDFium and
      // other extractors do; symbolic fonts without names are the usual source of such codes
      if (!unicode && code >= 32) { const wn = encTable("WinAnsiEncoding")![code]; unicode = wn ? nameToUnicode(wn) : ""; }
    }
    let w = this.widths.get(code);
    if (w === undefined) {
      if (this.std14 && name) w = std14Width(this.std14, name);
      if (w === undefined && this.widths.size === 0 && pr?.advance && gid >= 0) w = pr.advance(gid) || undefined;
      if (w === undefined) w = this.missingWidth || (this.std14 && name ? 0 : this.widths.size ? this.missingWidth : 500);
    }
    if (this.kind === "type3") w = w * this.fontMatrix[0] * 1000; // glyph space → text space ×1000
    const g: Glyph = { code, bytes: 1, cid: code, gid, name, unicode, w, space: code === 32 };
    this.cache.set(code, g); return g;
  }
  /** §9.6.5.4: glyph selection in TrueType fonts */
  private trueTypeGid(code: number, name: string | null): number {
    const pr = this.program!; const lk = pr.cmapLookup!;
    const nonSym = !this.isSymbolic() || this.hasEncoding;
    if (nonSym && pr.hasCmap!(3, 1) && name) {
      const u = nameToUnicode(name); if (u) { const g = lk(3, 1, u.codePointAt(0)!); if (g) return g; }
    }
    if (nonSym && pr.hasCmap!(1, 0) && name) {
      const mc = macRomanCode(name); if (mc >= 0) { const g = lk(1, 0, mc); if (g) return g; }
    }
    if (name) { const g = pr.gidForName(name); if (g > 0) return g; }
    if (pr.hasCmap!(3, 0)) for (const off of [0, 0xf000, 0xf100, 0xf200]) { const g = lk(3, 0, off + code); if (g) return g; }
    if (pr.hasCmap!(1, 0)) { const g = lk(1, 0, code); if (g) return g; }
    if (pr.hasCmap!(3, 1)) { const g = lk(3, 1, code); if (g) return g; const g2 = lk(3, 1, 0xf000 + code); if (g2) return g2; }
    if (!pr.hasCmap!(3, 1) && !pr.hasCmap!(1, 0) && !pr.hasCmap!(3, 0)) return code; // no cmap at all: code = gid
    return 0;
  }
  private cidGlyph(code: number, n: number): Glyph {
    const key = code * 8 + n; const c = this.cache.get(key); if (c) return c;
    let cid = this.ucs2 ? code : this.cmap!.cid(code, n) ?? (this.cmap!.identity ? code : 0);
    let gid = cid;
    const pr = this.program;
    if (this.subtype === "CIDFontType2") {
      if (this.ucs2 && pr?.cmapLookup) gid = pr.cmapLookup(3, 1, code) ?? 0;
      else if (!this.cidIdentity && this.cidToGid) gid = cid * 2 + 1 < this.cidToGid.length ? (this.cidToGid[cid * 2] << 8) | this.cidToGid[cid * 2 + 1] : 0;
    } else if (this.ucs2) { gid = -1; cid = 0; }
    let unicode = this.toUni?.unicode(code, n);
    if (unicode === undefined && this.toUniIdentity) unicode = String.fromCharCode(code);
    if (unicode === undefined && this.legacy) { const bs = n === 1 ? [code] : n === 2 ? [code >> 8, code & 255] : [code >>> 24, (code >> 16) & 255, (code >> 8) & 255, code & 255]; const t = this.legacy.decode(Uint8Array.from(bs)); if (t && !t.includes("\ufffd")) unicode = t; }
    if (unicode === undefined) {
      if (this.ucs2) unicode = code > 0xffff ? utf16be(Uint8Array.from([code >>> 24, (code >>> 16) & 255, (code >>> 8) & 255, code & 255])) : String.fromCharCode(code);
      else if (pr?.kind === "truetype" && pr.hasCmap?.(3, 1)) unicode = this.reverseUni(gid);
      else unicode = "";
      // Adobe-Japan1/GB1/CNS1/Korea1 all start with the same 95 proportional ASCII glyphs: CID 1–95 = U+0020–U+007E
      if (!unicode && cid >= 1 && cid <= 95 && /^(Japan1|GB1|CNS1|Korea1)$/.test(this.ordering)) unicode = String.fromCharCode(cid + 31);
    }
    let w = this.cidW.get(cid);
    if (w === undefined) { for (const r of this.cidWRanges) if (cid >= r.lo && cid <= r.hi) { w = r.w; break; } }
    if (w === undefined) w = this.dw;
    const g: Glyph = { code, bytes: n, cid, gid, name: null, unicode, w, space: n === 1 && code === 32 };
    if (this.vertical) { const v = this.cidW2.get(cid); if (v) { g.vy = v[0]; g.vx = v[1]; g.vyPos = v[2]; } else { g.vy = this.dw2[1]; g.vx = w / 2; g.vyPos = this.dw2[0]; } }
    if (this.cache.size < 100000) this.cache.set(key, g);
    return g;
  }
  private reverseUni(gid: number): string {
    if (!this.gidUniRev) {
      this.gidUniRev = new Map(); const lk = this.program!.cmapLookup!;
      for (let u = 0x20; u < 0xfffe; u++) { if (u >= 0xd800 && u <= 0xdfff) continue; const g = lk(3, 1, u); if (g && !this.gidUniRev.has(g)) this.gidUniRev.set(g, String.fromCharCode(u)); }
    }
    return this.gidUniRev.get(gid) ?? "";
  }

  /** outline in glyph space; null = nothing embedded for this glyph (the renderer substitutes a system font) */
  outline(g: Glyph): Outline | null {
    const pr = this.program; if (!pr) return null;
    if (this.kind === "type0") {
      if (pr.kind === "cff" && pr.isCID) return pr.outlineCid!(g.cid);
      return g.gid >= 0 ? pr.outline(g.gid) : null;
    }
    return g.gid >= 0 ? pr.outline(g.gid) : pr.kind === "truetype" ? pr.outline(0) : null;
  }
  /** glyph space → text space for outlines (TrueType outlines are in font units / unitsPerEm) */
  outlineMatrix(): number[] { return this.program ? this.program.matrix.slice() : this.fontMatrix; }
  /** CSS font for substitution when nothing is embedded */
  cssFamily(): string {
    const n = (this.std14 ?? this.baseFont).toLowerCase();
    if (this.fixed || /courier|mono|consol/.test(n)) return "\"Courier New\", Courier, monospace";
    if (this.serif || /times|serif|roman|georgia|garamond|minion|book/.test(n) && !/sans/.test(n)) return "\"Times New Roman\", Times, serif";
    return "Helvetica, Arial, sans-serif";
  }
}
let MACR: Map<string, number> | null = null;
function macRomanCode(name: string): number { if (!MACR) { MACR = new Map(); encTable("MacRomanEncoding")!.forEach((n, i) => { if (n && !MACR!.has(n)) MACR!.set(n, i); }); } return MACR.get(name) ?? -1; }
export { PStream };
