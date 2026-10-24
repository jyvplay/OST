/**
 * TT52 — PDF object model, lexer, parser and serializer (ISO 32000-2 §7.2–7.3). Original code written from the
 * specification. Tolerant where real files are sloppy (unbalanced parentheses, stray tokens, wrong stream lengths),
 * strict where safety matters (bounded nesting, bounded string/array sizes).
 */
export type Bytes = Uint8Array;

export class PName { readonly n: string; constructor(n: string) { this.n = n; } }
const NAMES = new Map<string, PName>();
/** names are interned so they can be compared with === */
export function N(n: string): PName { let x = NAMES.get(n); if (!x) { x = new PName(n); if (NAMES.size < 200_000) NAMES.set(n, x); } return x; }

export class PStr { b: Bytes; hex: boolean; constructor(b: Bytes, hex = false) { this.b = b; this.hex = hex; } }
export class PRef { readonly num: number; readonly gen: number; constructor(num: number, gen: number) { this.num = num; this.gen = gen; } toString() { return `${this.num} ${this.gen} R`; } }
export class PDict {
  m: Map<string, PObj>;
  constructor(m?: Map<string, PObj>) { this.m = m ?? new Map(); }
  get(k: string): PObj | undefined { return this.m.get(k); }
  set(k: string, v: PObj | undefined) { if (v === undefined) this.m.delete(k); else this.m.set(k, v); return this; }
  has(k: string) { return this.m.has(k); }
  keys() { return [...this.m.keys()]; }
}
export class PStream {
  dict: PDict; raw: Bytes;
  /** object number + generation the stream was read from (needed for decryption); -1 when synthetic */
  num: number; gen: number;
  constructor(dict: PDict, raw: Bytes, num = -1, gen = 0) { this.dict = dict; this.raw = raw; this.num = num; this.gen = gen; }
}
/** the `null` keyword and missing values are both JS null */
export type PObj = null | boolean | number | PName | PStr | PRef | PObj[] | PDict | PStream;

export const isName = (o: unknown, n?: string): o is PName => o instanceof PName && (n === undefined || o.n === n);
export const isDict = (o: unknown): o is PDict => o instanceof PDict;
export const isStream = (o: unknown): o is PStream => o instanceof PStream;
export const isRef = (o: unknown): o is PRef => o instanceof PRef;
export const isNum = (o: unknown): o is number => typeof o === "number" && Number.isFinite(o);
export const isArr = (o: unknown): o is PObj[] => Array.isArray(o);

/* ------------------------------------------------------------------ text helpers */
const latin = new TextDecoder("latin1");
export const bytesToLatin1 = (b: Bytes) => latin.decode(b);
export const latin1ToBytes = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

/** PDFDocEncoding (Annex D) → Unicode, for the 0x18–0x1F and 0x80–0xAD rows that differ from Latin-1 */
const PDFDOC: Record<number, number> = {
  0x18: 0x02d8, 0x19: 0x02c7, 0x1a: 0x02c6, 0x1b: 0x02d9, 0x1c: 0x02dd, 0x1d: 0x02db, 0x1e: 0x02da, 0x1f: 0x02dc,
  0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044, 0x88: 0x2039, 0x89: 0x203a,
  0x8a: 0x2212, 0x8b: 0x2030, 0x8c: 0x201e, 0x8d: 0x201c, 0x8e: 0x201d, 0x8f: 0x2018, 0x90: 0x2019, 0x91: 0x201a, 0x92: 0x2122, 0x93: 0xfb01,
  0x94: 0xfb02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160, 0x98: 0x0178, 0x99: 0x017d, 0x9a: 0x0131, 0x9b: 0x0142, 0x9c: 0x0153, 0x9d: 0x0161,
  0x9e: 0x017e, 0xa0: 0x20ac,
};
/** a text string (§7.9.2.2): UTF-16BE with BOM, UTF-8 with BOM (PDF 2.0), else PDFDocEncoding */
export function textString(o: PObj | undefined): string {
  if (!(o instanceof PStr)) return typeof o === "number" ? String(o) : o instanceof PName ? o.n : "";
  const b = o.b;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { let s = ""; for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { let s = ""; for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s; }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  let s = ""; for (const c of b) s += String.fromCharCode(PDFDOC[c] ?? c); return s;
}
/** encode a JS string as a PDF text string: PDFDocEncoding when it fits in printable Latin-1, else UTF-16BE */
export function makeText(s: string): PStr {
  if (/^[\x20-\x7e\xa1-\xff\n\r\t]*$/.test(s)) return new PStr(latin1ToBytes(s));
  const b = new Uint8Array(2 + s.length * 2); b[0] = 0xfe; b[1] = 0xff;
  for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) >> 8; b[3 + i * 2] = s.charCodeAt(i) & 0xff; }
  return new PStr(b, true);
}

/* ------------------------------------------------------------------ lexer */
// character classes (§7.2.3): whitespace and delimiters
const WS = new Uint8Array(256); for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256); for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;
export const isWs = (c: number) => WS[c] === 1;
export const isDelim = (c: number) => DELIM[c] === 1;
const isRegular = (c: number) => !WS[c] && !DELIM[c];

export const MAX_DEPTH = 256, MAX_STRING = 64 << 20, MAX_ARRAY = 4 << 20;

/** a keyword/operator token (true/false/null/R/obj/stream/endobj/content operators) */
export class PKw { readonly k: string; constructor(k: string) { this.k = k; } }
const KWS = new Map<string, PKw>(); const KW = (k: string) => { let x = KWS.get(k); if (!x) { x = new PKw(k); if (KWS.size < 10_000) KWS.set(k, x); } return x; };
export type Token = PObj | PKw | { delim: string } | undefined;

export class Lexer {
  b: Bytes; p: number; end: number;
  constructor(b: Bytes, p = 0, end = b.length) { this.b = b; this.p = p; this.end = end; }
  skipWs() {
    const b = this.b;
    for (;;) {
      while (this.p < this.end && WS[b[this.p]]) this.p++;
      if (this.p < this.end && b[this.p] === 0x25) { while (this.p < this.end && b[this.p] !== 10 && b[this.p] !== 13) this.p++; continue; } // % comment
      return;
    }
  }
  peekByte() { this.skipWs(); return this.p < this.end ? this.b[this.p] : -1; }
  /** next token; undefined at end of input */
  next(): Token {
    this.skipWs();
    const b = this.b; if (this.p >= this.end) return undefined;
    const c = b[this.p];
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literal();
    if (c === 0x3c) { if (b[this.p + 1] === 0x3c) { this.p += 2; return { delim: "<<" }; } return this.hex(); }
    if (c === 0x3e) { if (b[this.p + 1] === 0x3e) { this.p += 2; return { delim: ">>" }; } this.p++; return { delim: ">" }; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { this.p++; return { delim: String.fromCharCode(c) }; }
    if (c === 0x29) { this.p++; return { delim: ")" }; } // stray close paren: skip as a delimiter
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) { const n = this.number(); if (n !== null) return n; }
    const s = this.p; while (this.p < this.end && isRegular(b[this.p])) this.p++;
    if (this.p === s) { this.p++; return KW(String.fromCharCode(c)); }
    const w = latin.decode(b.subarray(s, Math.min(this.p, s + 128)));
    if (w === "true") return true; if (w === "false") return false; if (w === "null") return null;
    return KW(w);
  }
  number(): number | null {
    // §7.3.3: [+-]digits[.digits]; tolerate "--5", "4.-2" and trailing junk like other readers do (value of the valid prefix)
    const b = this.b; const s = this.p; let neg = false, seen = false, dot = false, v = 0, scale = 1;
    let p = this.p;
    while (p < this.end && (b[p] === 0x2b || b[p] === 0x2d)) { if (b[p] === 0x2d) neg = !neg; p++; }
    for (; p < this.end; p++) {
      const c = b[p];
      if (c >= 0x30 && c <= 0x39) { seen = true; if (dot) { scale /= 10; v += (c - 0x30) * scale; } else v = v * 10 + (c - 0x30); }
      else if (c === 0x2e && !dot) dot = true;
      else if (c === 0x2d && (seen || dot)) continue; // "4.-2" style garbage inside a number
      else break;
    }
    if (!seen) { if (dot || p > s) { this.p = p; return 0; } return null; }
    // a number glued to regular characters (e.g. "12abc") is a keyword, not a number
    if (p < this.end && isRegular(b[p]) && !(b[p] === 0x2b || b[p] === 0x2d)) { if (/[A-Za-z]/.test(String.fromCharCode(b[p]))) return null; }
    this.p = p; return neg ? -v : v;
  }
  name(): PName {
    const b = this.b; this.p++; let s = "";
    const start = this.p;
    while (this.p < this.end && isRegular(b[this.p])) {
      const c = b[this.p];
      if (c === 0x23 && this.p + 2 < this.end + 0) { // #xx escape
        const h = hexv(b[this.p + 1]), l = hexv(b[this.p + 2]);
        if (h >= 0 && l >= 0) { s += String.fromCharCode(h * 16 + l); this.p += 3; continue; }
      }
      s += String.fromCharCode(c); this.p++;
      if (this.p - start > 4096) break;
    }
    // names are byte sequences: kept as a byte-per-char string so they round-trip exactly (GBK / Shift-JIS font names
    // carry charset hints other readers rely on); nameText() decodes UTF-8 for display
    return N(s);
  }
  literal(): PStr {
    const b = this.b; this.p++; let depth = 1; const out: number[] = [];
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 0x5c) { // backslash escape
        const d = b[this.p++];
        switch (d) {
          case 0x6e: out.push(10); break; case 0x72: out.push(13); break; case 0x74: out.push(9); break;
          case 0x62: out.push(8); break; case 0x66: out.push(12); break;
          case 0x28: case 0x29: case 0x5c: out.push(d); break;
          case 13: if (b[this.p] === 10) this.p++; break; // line continuation
          case 10: break;
          default:
            if (d >= 0x30 && d <= 0x37) { let v = d - 0x30; for (let k = 0; k < 2 && b[this.p] >= 0x30 && b[this.p] <= 0x37; k++) v = v * 8 + (b[this.p++] - 0x30); out.push(v & 0xff); }
            else if (d !== undefined) out.push(d);
        }
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { if (--depth === 0) break; out.push(c); }
      else if (c === 13) { out.push(10); if (b[this.p] === 10) this.p++; } // EOL in a string is LF (§7.3.4.2)
      else out.push(c);
      if (out.length > MAX_STRING) throw new Error("pdf: string too long");
    }
    return new PStr(Uint8Array.from(out));
  }
  hex(): PStr {
    const b = this.b; this.p++; const out: number[] = []; let hi = -1;
    while (this.p < this.end) {
      const c = b[this.p++]; if (c === 0x3e) break;
      const v = hexv(c); if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
      if (out.length > MAX_STRING) throw new Error("pdf: string too long");
    }
    if (hi >= 0) out.push(hi * 16); // odd number of digits: final digit padded with 0
    return new PStr(Uint8Array.from(out), true);
  }
}
export function hexv(c: number) { return c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1; }

/* ------------------------------------------------------------------ parser */
export interface StreamResolver {
  /** resolve an indirect /Length; return null when unknown */
  length(o: PObj): number | null;
}

/** parse one object at the lexer position. `refs` turns "n g R" into PRef. Streams need `allowStream`. */
export function parseObj(lx: Lexer, depth = 0, sr?: StreamResolver, objNum = -1, objGen = 0): PObj {
  if (depth > MAX_DEPTH) throw new Error("pdf: objects nested too deeply");
  const t = lx.next();
  return fromToken(lx, t, depth, sr, objNum, objGen);
}
function fromToken(lx: Lexer, t: Token, depth: number, sr: StreamResolver | undefined, objNum: number, objGen: number): PObj {
  if (t === undefined) return null;
  if (typeof t === "number") {
    // look ahead for "gen R"
    const save = lx.p; const t2 = lx.next();
    if (typeof t2 === "number" && Number.isInteger(t) && Number.isInteger(t2) && t >= 0 && t2 >= 0) {
      const save2 = lx.p; const t3 = lx.next();
      if (t3 instanceof PKw && t3.k === "R") return new PRef(t, t2);
      lx.p = save2;
    }
    lx.p = save; return t;
  }
  if (t === null || typeof t === "boolean" || t instanceof PName || t instanceof PStr) return t;
  if (t instanceof PKw) return null; // stray keyword where an object was expected
  if ("delim" in (t as object)) {
    const d = (t as { delim: string }).delim;
    if (d === "[") {
      const arr: PObj[] = [];
      for (;;) {
        const x = lx.next(); if (x === undefined) break;
        if (x && typeof x === "object" && "delim" in x && (x as { delim: string }).delim === "]") break;
        if (x instanceof PKw && (x.k === "endobj" || x.k === "stream" || x.k === "obj")) { lx.p -= x.k.length; break; }
        arr.push(fromToken(lx, x, depth + 1, sr, objNum, objGen));
        if (arr.length > MAX_ARRAY) throw new Error("pdf: array too long");
      }
      return arr;
    }
    if (d === "<<") {
      const dict = new PDict();
      for (;;) {
        const k = lx.next(); if (k === undefined) break;
        if (k && typeof k === "object" && "delim" in k && (k as { delim: string }).delim === ">>") break;
        if (k instanceof PKw && (k.k === "endobj" || k.k === "stream" || k.k === "obj")) { lx.p -= k.k.length; break; }
        if (!(k instanceof PName)) continue; // junk key: skip
        const vt = lx.next();
        if (vt && typeof vt === "object" && "delim" in vt && (vt as { delim: string }).delim === ">>") { dict.set(k.n, null); break; }
        const v = fromToken(lx, vt, depth + 1, sr, objNum, objGen);
        if (v !== null) dict.set(k.n, v); // a null value means the key is absent (§7.3.7)
        if (dict.m.size > MAX_ARRAY) throw new Error("pdf: dictionary too large");
      }
      // stream?
      const save = lx.p; const s = lx.next();
      if (s instanceof PKw && s.k === "stream" && sr) return readStream(lx, dict, sr, objNum, objGen);
      lx.p = save; return dict;
    }
    return null; // stray ] >> ) }
  }
  return null;
}

/** read stream data after the `stream` keyword: trust /Length when it lands on `endstream`, else search for it */
function readStream(lx: Lexer, dict: PDict, sr: StreamResolver, objNum: number, objGen: number): PStream {
  const b = lx.b;
  if (b[lx.p] === 13 && b[lx.p + 1] === 10) lx.p += 2; else if (b[lx.p] === 10 || b[lx.p] === 13) lx.p++;
  const start = lx.p;
  const len = sr.length(dict.get("Length") ?? null);
  const at = (p: number) => { let q = p; while (q < lx.end && WS[b[q]]) q++; return matchAt(b, q, "endstream"); };
  let end = -1;
  if (len !== null && len >= 0 && start + len <= lx.end && at(start + len)) end = start + len;
  else {
    const k = indexOf(b, "endstream", start, lx.end);
    end = k < 0 ? lx.end : k;
    // drop the EOL that precedes endstream
    if (end > start && b[end - 1] === 10) end--; if (end > start && b[end - 1] === 13) end--;
  }
  const raw = b.subarray(start, end);
  lx.p = end; const k2 = indexOf(b, "endstream", end, Math.min(lx.end, end + 64)); if (k2 >= 0) lx.p = k2 + 9;
  return new PStream(dict, raw, objNum, objGen);
}

export function matchAt(b: Bytes, p: number, s: string) { if (p + s.length > b.length) return false; for (let i = 0; i < s.length; i++) if (b[p + i] !== s.charCodeAt(i)) return false; return true; }
export function indexOf(b: Bytes, s: string, from = 0, to = b.length) {
  const c0 = s.charCodeAt(0); const lim = Math.min(to, b.length) - s.length;
  for (let i = Math.max(0, from); i <= lim; i++) if (b[i] === c0 && matchAt(b, i, s)) return i;
  return -1;
}
export function lastIndexOf(b: Bytes, s: string, from = b.length - s.length, to = 0) {
  const c0 = s.charCodeAt(0);
  for (let i = Math.min(from, b.length - s.length); i >= to; i--) if (b[i] === c0 && matchAt(b, i, s)) return i;
  return -1;
}

/* ------------------------------------------------------------------ serializer */
/** numbers: integers as-is; reals with ≤ 6 decimals and no exponent (PDF has no exponent syntax) */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}
const NAME_OK = /^[!-~]$/;
/** display form of a name: UTF-8 when the bytes are valid UTF-8 (PDF 2.0 §7.3.5), else the bytes as Latin-1 */
export function nameText(n: string): string { if (!/[\x80-\xff]/.test(n) || /[^\x00-\xff]/.test(n)) return n; try { return new TextDecoder("utf-8", { fatal: true }).decode(latin1ToBytes(n)); } catch { return n; } }
export function fmtName(n: string): string {
  // byte-per-char names (parsed) are written as their bytes; programmatic names with characters > U+00FF as UTF-8
  const b = /[^\x00-\xff]/.test(n) ? new TextEncoder().encode(n) : latin1ToBytes(n); let s = "/";
  for (const c of b) { const ch = String.fromCharCode(c); s += NAME_OK.test(ch) && !DELIM[c] && ch !== "#" ? ch : "#" + c.toString(16).padStart(2, "0"); }
  return s;
}
export function fmtStr(b: Bytes, hex = false): string {
  if (hex) { let s = "<"; for (const c of b) s += c.toString(16).padStart(2, "0"); return s + ">"; }
  let s = "(";
  for (const c of b) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += "\\" + String.fromCharCode(c);
    else if (c === 10) s += "\\n"; else if (c === 13) s += "\\r";
    else if (c < 32 || c > 126) s += "\\" + c.toString(8).padStart(3, "0");
    else s += String.fromCharCode(c);
  }
  return s + ")";
}
/** serialize an object (no streams — those are written by the writer, which owns the stream bytes) */
export function serialize(o: PObj | undefined, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error("pdf: object too deep to write");
  if (o === null || o === undefined) return "null";
  if (typeof o === "boolean") return o ? "true" : "false";
  if (typeof o === "number") return fmtNum(o);
  if (o instanceof PName) return fmtName(o.n);
  if (o instanceof PStr) return fmtStr(o.b, o.hex);
  if (o instanceof PRef) return `${o.num} ${o.gen} R`;
  if (Array.isArray(o)) return "[" + o.map((x) => serialize(x, depth + 1)).join(" ") + "]";
  if (o instanceof PDict) { let s = "<<"; for (const [k, v] of o.m) s += fmtName(k) + " " + serialize(v, depth + 1); return s + ">>"; }
  if (o instanceof PStream) return serialize(o.dict, depth);
  return "null";
}
