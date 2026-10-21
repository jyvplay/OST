/**
 * TT52 — embedded font programs → glyph outlines. Original code from the specifications:
 *   TrueType 'glyf'/'loca'/'cmap'/'post'/'head'/'maxp'/'hmtx' (OpenType spec), simple + composite glyphs;
 *   CFF (Adobe TN 5176) incl. CID-keyed fonts (FDArray/FDSelect) and Type 2 charstrings (Adobe TN 5177);
 *   Type 1 (Adobe Type 1 Font Format): PFB/PFA, eexec + charstring decryption, Subrs, flex / hint-replacement OtherSubrs, seac.
 * Outlines are flat number arrays in font units: 0 x y = moveTo, 1 x y = lineTo, 2 cx cy x y = quadTo, 3 c1x c1y c2x c2y x y
 * = cubicTo, 4 = closePath. Every parser is bounded (recursion depth, operand stack, glyph count, bytes read).
 */
import { CFF_STD, ENC_STANDARD } from "./fontdata";

export type Outline = number[];
export interface FontProgram {
  kind: "truetype" | "cff" | "type1";
  /** glyph-space → text-space (1/unitsPerEm for TrueType; the font's FontMatrix for CFF/Type 1) */
  matrix: [number, number, number, number, number, number];
  numGlyphs: number;
  /** outline of a glyph id (TrueType/CFF gid; CID-keyed CFF: pass the CID via outlineCid) */
  outline(gid: number): Outline | null;
  outlineCid?(cid: number): Outline | null;
  /** glyph id for a glyph name (Type 1 / CFF charset / TrueType post) */
  gidForName(name: string): number;
  /** TrueType cmap lookup: (platform, encoding) subtable → gid; null if the subtable is absent */
  cmapLookup?(platform: number, encoding: number, code: number): number | null;
  hasCmap?(platform: number, encoding: number): boolean;
  /** the font's built-in encoding: code → glyph name (Type 1 / CFF) */
  builtinEncoding?: (string | null)[];
  /** advance width in font units (hmtx / charstring width), for fonts without /Widths */
  advance?(gid: number): number;
  isCID?: boolean;
}

const be16 = (b: Uint8Array, o: number) => ((b[o] << 8) | b[o + 1]) >>> 0;
const bes16 = (b: Uint8Array, o: number) => { const v = be16(b, o); return v & 0x8000 ? v - 0x10000 : v; };
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
let STD_NAMES: string[] | null = null;
const stdStrings = () => (STD_NAMES ??= CFF_STD.split(" "));
let STD_ENC: (string | null)[] | null = null;
export const standardEncoding = () => (STD_ENC ??= ENC_STANDARD.split(" ").map((x) => (x === "." ? null : x)));

/* ================================================================== TrueType / OpenType */
export function parseSfnt(b: Uint8Array): FontProgram | null {
  if (b.length < 12) return null;
  const tag = be32(b, 0);
  if (tag === 0x74746366) { /* 'ttcf' collection: use the first font */ const off = be32(b, 12); return parseSfntAt(b, off); }
  return parseSfntAt(b, 0);
}
function parseSfntAt(b: Uint8Array, base: number): FontProgram | null {
  const tag = be32(b, base);
  if (tag !== 0x00010000 && tag !== 0x74727565 /* 'true' */ && tag !== 0x4f54544f /* 'OTTO' */ && tag !== 0x00020000) return null;
  const n = be16(b, base + 4); const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n && base + 12 + i * 16 + 16 <= b.length; i++) {
    const r = base + 12 + i * 16; const t = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]);
    const off = be32(b, r + 8), len = be32(b, r + 12);
    if (off < b.length) tables.set(t, { off, len: Math.min(len, b.length - off) });
  }
  if (tag === 0x4f54544f || (tables.has("CFF ") && !tables.has("glyf"))) {
    const c = tables.get("CFF "); if (!c) return null;
    const cff = parseCFF(b.subarray(c.off, c.off + c.len)); if (!cff) return null;
    const cm = readCmaps(b, tables);
    return { ...cff, cmapLookup: cm.lookup, hasCmap: cm.has };
  }
  const head = tables.get("head"); const upem = head && head.len >= 54 ? be16(b, head.off + 18) || 1000 : 1000;
  const locFmt = head && head.len >= 54 ? bes16(b, head.off + 50) : 0;
  const maxp = tables.get("maxp"); let numGlyphs = maxp ? be16(b, maxp.off + 4) : 0;
  const loca = tables.get("loca"), glyf = tables.get("glyf");
  const offsets: number[] = [];
  if (loca && glyf) {
    const cnt = locFmt ? Math.floor(loca.len / 4) : Math.floor(loca.len / 2);
    if (!numGlyphs || numGlyphs + 1 > cnt) numGlyphs = Math.max(0, cnt - 1);
    for (let i = 0; i <= numGlyphs; i++) offsets.push(locFmt ? be32(b, loca.off + i * 4) : be16(b, loca.off + i * 2) * 2);
  }
  const hhea = tables.get("hhea"), hmtx = tables.get("hmtx"); const nLong = hhea && hhea.len >= 36 ? be16(b, hhea.off + 34) : 0;
  const cache = new Map<number, Outline | null>();
  const glyph = (gid: number, depth: number): Outline | null => {
    if (!glyf || gid < 0 || gid >= numGlyphs || depth > 8) return null;
    if (depth === 0 && cache.has(gid)) return cache.get(gid)!;
    let start = offsets[gid], end = offsets[gid + 1];
    if (end < start) end = glyf.len; // some broken fonts: unsorted loca
    const out: Outline = [];
    if (end - start >= 10 && start < glyf.len) {
      const g = glyf.off + start; const nc = bes16(b, g);
      try { if (nc >= 0) simpleGlyph(b, g, Math.min(glyf.off + glyf.len, glyf.off + end), nc, out); else compositeGlyph(b, g + 10, glyf.off + Math.min(end, glyf.len), out, (id) => glyph(id, depth + 1)); }
      catch { /* malformed glyph: keep what decoded */ }
    }
    if (depth === 0) cache.set(gid, out);
    return out;
  };
  const cm = readCmaps(b, tables);
  const names = readPost(b, tables.get("post"), numGlyphs);
  return {
    kind: "truetype", matrix: [1 / upem, 0, 0, 1 / upem, 0, 0], numGlyphs,
    outline: (gid) => glyph(gid, 0),
    gidForName: (name) => names?.get(name) ?? -1,
    cmapLookup: cm.lookup, hasCmap: cm.has,
    advance: (gid) => { if (!hmtx || !nLong) return 0; const i = Math.min(gid, nLong - 1); return hmtx.len >= (i + 1) * 4 ? be16(b, hmtx.off + i * 4) * 1000 / upem : 0; },
  };
}
function simpleGlyph(b: Uint8Array, g: number, lim: number, nc: number, out: Outline) {
  let p = g + 10; const ends: number[] = [];
  for (let i = 0; i < nc; i++) { ends.push(be16(b, p)); p += 2; }
  const n = nc ? ends[nc - 1] + 1 : 0; if (n > 65535) return;
  const ilen = be16(b, p); p += 2 + ilen;
  const flags = new Uint8Array(n);
  for (let i = 0; i < n && p < lim;) { const f = b[p++]; flags[i++] = f; if (f & 8) { let r = b[p++]; while (r-- > 0 && i < n) flags[i++] = f; } }
  const xs = new Int32Array(n), ys = new Int32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) { const f = flags[i]; if (f & 2) { const d = b[p++]; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += bes16(b, p); p += 2; } xs[i] = v; }
  v = 0;
  for (let i = 0; i < n; i++) { const f = flags[i]; if (f & 4) { const d = b[p++]; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += bes16(b, p); p += 2; } ys[i] = v; }
  let s = 0;
  for (const e of ends) {
    if (e < s || e >= n) break;
    contour(xs, ys, flags, s, e, out); s = e + 1;
  }
}
/** one quadratic contour with implied on-curve midpoints */
function contour(xs: Int32Array, ys: Int32Array, fl: Uint8Array, s: number, e: number, out: Outline) {
  const on = (i: number) => (fl[i] & 1) !== 0; const cnt = e - s + 1; if (cnt < 1) return;
  // start at an on-curve point, or at the midpoint of the first two off-curve points
  let startX: number, startY: number, first = s;
  if (on(s)) { startX = xs[s]; startY = ys[s]; first = s + 1; }
  else if (on(e)) { startX = xs[e]; startY = ys[e]; first = s; }
  else { startX = (xs[s] + xs[e]) / 2; startY = (ys[s] + ys[e]) / 2; first = s; }
  out.push(0, startX, startY);
  let cx: number | null = null, cy = 0;
  const last = on(s) ? e : on(e) ? e - 1 : e;
  for (let i = first; i <= last; i++) {
    const x = xs[i], y = ys[i];
    if (on(i)) { if (cx === null) out.push(1, x, y); else { out.push(2, cx, cy, x, y); cx = null; } }
    else { if (cx !== null) { const mx = (cx + x) / 2, my = (cy + y) / 2; out.push(2, cx, cy, mx, my); } cx = x; cy = y; }
  }
  if (cx !== null) out.push(2, cx, cy, startX, startY); else out.push(1, startX, startY);
  out.push(4);
}
function compositeGlyph(b: Uint8Array, p: number, lim: number, out: Outline, sub: (gid: number) => Outline | null) {
  for (let guard = 0; guard < 256 && p + 4 <= lim; guard++) {
    const flags = be16(b, p), gid = be16(b, p + 2); p += 4;
    let dx: number, dy: number;
    if (flags & 1) { dx = bes16(b, p); dy = bes16(b, p + 2); p += 4; } else { dx = (b[p] << 24) >> 24; dy = (b[p + 1] << 24) >> 24; p += 2; }
    let a = 1, bb = 0, c = 0, d = 1;
    const f2 = (o: number) => bes16(b, o) / 16384;
    if (flags & 8) { a = d = f2(p); p += 2; } else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (flags & 0x80) { a = f2(p); bb = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
    if (!(flags & 2)) { dx = 0; dy = 0; } // point-matching (ARGS_ARE_XY_VALUES clear): approximated as no offset
    const o = sub(gid);
    if (o) for (let i = 0; i < o.length;) {
      const op = o[i++]; out.push(op);
      const np = op === 0 || op === 1 ? 1 : op === 2 ? 2 : op === 3 ? 3 : 0;
      for (let k = 0; k < np; k++) { const x = o[i++], y = o[i++]; out.push(a * x + c * y + dx, bb * x + d * y + dy); }
    }
    if (!(flags & 0x20)) break;
  }
}
function readCmaps(b: Uint8Array, tables: Map<string, { off: number; len: number }>) {
  const t = tables.get("cmap"); const subs = new Map<string, number>();
  if (t && t.len >= 4) { const n = be16(b, t.off + 2); for (let i = 0; i < n && 4 + i * 8 + 8 <= t.len; i++) { const r = t.off + 4 + i * 8; subs.set(`${be16(b, r)},${be16(b, r + 2)}`, t.off + be32(b, r + 4)); } }
  const lookups = new Map<string, (c: number) => number>();
  const get = (pl: number, en: number) => {
    const k = `${pl},${en}`; if (lookups.has(k)) return lookups.get(k)!;
    const off = subs.get(k); if (off === undefined || off + 6 > b.length) return null;
    const f = cmapSubtable(b, off); lookups.set(k, f); return f;
  };
  return {
    has: (pl: number, en: number) => subs.has(`${pl},${en}`),
    lookup: (pl: number, en: number, code: number) => { const f = get(pl, en); return f ? f(code) : null; },
  };
}
function cmapSubtable(b: Uint8Array, o: number): (c: number) => number {
  const fmt = be16(b, o);
  if (fmt === 0) return (c) => (c < 256 && o + 6 + c < b.length ? b[o + 6 + c] : 0);
  if (fmt === 4) {
    const segX2 = be16(b, o + 6); const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    return (c) => {
      for (let i = 0; i < segX2; i += 2) {
        if (ranges + i + 2 > b.length) return 0;
        const end = be16(b, ends + i); if (c > end) continue;
        const start = be16(b, starts + i); if (c < start) return 0;
        const delta = be16(b, deltas + i), ro = be16(b, ranges + i);
        if (!ro) return (c + delta) & 0xffff;
        const gp = ranges + i + ro + (c - start) * 2; if (gp + 2 > b.length) return 0;
        const g = be16(b, gp); return g ? (g + delta) & 0xffff : 0;
      }
      return 0;
    };
  }
  if (fmt === 6) { const first = be16(b, o + 6), cnt = be16(b, o + 8); return (c) => (c >= first && c < first + cnt ? be16(b, o + 10 + (c - first) * 2) : 0); }
  if (fmt === 12 || fmt === 13) {
    const n = be32(b, o + 12);
    return (c) => { for (let i = 0; i < n && o + 16 + i * 12 + 12 <= b.length; i++) { const r = o + 16 + i * 12; const s = be32(b, r), e = be32(b, r + 4); if (c >= s && c <= e) return fmt === 12 ? be32(b, r + 8) + (c - s) : be32(b, r + 8); } return 0; };
  }
  return () => 0;
}
function readPost(b: Uint8Array, t: { off: number; len: number } | undefined, numGlyphs: number): Map<string, number> | null {
  if (!t || t.len < 34 || be32(b, t.off) !== 0x00020000) return null;
  const n = be16(b, t.off + 32); const idx: number[] = []; let p = t.off + 34;
  for (let i = 0; i < n && p + 2 <= t.off + t.len; i++, p += 2) idx.push(be16(b, p));
  const custom: string[] = [];
  while (p < t.off + t.len) { const l = b[p++]; custom.push(String.fromCharCode(...b.subarray(p, p + l))); p += l; }
  const mac = MAC_GLYPHS(); const m = new Map<string, number>();
  idx.forEach((v, gid) => { if (gid >= numGlyphs && numGlyphs) return; const name = v < 258 ? mac[v] : custom[v - 258]; if (name && !m.has(name)) m.set(name, gid); });
  return m;
}
// the 258 standard Macintosh glyph names (TrueType 'post' spec): built from the standard Mac ordering
let MACG: string[] | null = null;
function MAC_GLYPHS(): string[] {
  return (MACG ??= (".notdef .null nonmarkingreturn space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ellipsis nonbreakingspace Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron Lslash lslash Scaron scaron Zcaron zcaron brokenbar Eth eth Yacute yacute Thorn thorn minus multiply onesuperior twosuperior threesuperior onehalf onequarter threequarters franc Gbreve gbreve Idotaccent Scedilla scedilla Cacute cacute Ccaron ccaron dcroat").split(" "));
}

/* ================================================================== CFF */
interface Index { count: number; get(i: number): Uint8Array }
function readIndex(b: Uint8Array, p: number): { idx: Index; end: number } {
  const count = be16(b, p); if (!count) return { idx: { count: 0, get: () => new Uint8Array(0) }, end: p + 2 };
  const os = b[p + 2]; const offAt = (i: number) => { let v = 0; const o = p + 3 + i * os; for (let k = 0; k < os; k++) v = v * 256 + b[o + k]; return v; };
  const data = p + 3 + (count + 1) * os - 1; const end = data + offAt(count);
  return { idx: { count, get: (i) => (i < 0 || i >= count ? new Uint8Array(0) : b.subarray(Math.min(b.length, data + offAt(i)), Math.min(b.length, data + offAt(i + 1)))) }, end };
}
function readDict(d: Uint8Array): Map<number, number[]> {
  const m = new Map<number, number[]>(); let ops: number[] = [];
  for (let p = 0; p < d.length;) {
    const b0 = d[p];
    if (b0 <= 21) { let op = b0; p++; if (b0 === 12) op = 1200 + d[p++]; m.set(op, ops); ops = []; }
    else if (b0 === 28) { ops.push(bes16(d, p + 1)); p += 3; }
    else if (b0 === 29) { ops.push(be32(d, p + 1) | 0); p += 5; }
    else if (b0 === 30) { // real number nibbles
      let s = ""; p++;
      outer: while (p < d.length) { const byte = d[p++]; for (const nib of [byte >> 4, byte & 15]) { if (nib === 15) break outer; s += nib < 10 ? String(nib) : nib === 10 ? "." : nib === 11 ? "E" : nib === 12 ? "E-" : nib === 14 ? "-" : ""; } }
      ops.push(parseFloat(s) || 0);
    }
    else if (b0 >= 32 && b0 <= 246) { ops.push(b0 - 139); p++; }
    else if (b0 >= 247 && b0 <= 250) { ops.push((b0 - 247) * 256 + d[p + 1] + 108); p += 2; }
    else if (b0 >= 251 && b0 <= 254) { ops.push(-(b0 - 251) * 256 - d[p + 1] - 108); p += 2; }
    else p++;
  }
  return m;
}
const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

export function parseCFF(b: Uint8Array): FontProgram | null {
  if (b.length < 4 || b[0] !== 1) return null;
  const hdr = b[2]; const names = readIndex(b, hdr); const tops = readIndex(b, names.end); const strs = readIndex(b, tops.end); const gsubrs = readIndex(b, strs.end);
  if (!tops.idx.count) return null;
  const top = readDict(tops.idx.get(0));
  const std = stdStrings();
  const sid = (s: number) => (s < 391 ? std[s] : String.fromCharCode(...strs.idx.get(s - 391)));
  const csOff = top.get(17)?.[0]; if (csOff === undefined) return null;
  const cs = readIndex(b, csOff).idx; const nGlyphs = cs.count;
  const isCID = top.has(1230);
  const fm = top.get(1207); const topExplicit = !!(fm && fm.length === 6); const matrix = (fm && fm.length === 6 ? fm : [0.001, 0, 0, 0.001, 0, 0]) as FontProgram["matrix"];
  // private dicts: one for a name-keyed font; per FD for CID-keyed
  interface Priv { subrs: Index; dflt: number; nominal: number }
  const priv = (dict: Map<number, number[]>): Priv => {
    const pr = dict.get(18); if (!pr || pr.length < 2) return { subrs: { count: 0, get: () => new Uint8Array(0) }, dflt: 0, nominal: 0 };
    const [size, off] = pr; const pd = readDict(b.subarray(off, off + size));
    const so = pd.get(19)?.[0]; const subrs = so !== undefined ? readIndex(b, off + so).idx : { count: 0, get: () => new Uint8Array(0) };
    return { subrs, dflt: pd.get(20)?.[0] ?? 0, nominal: pd.get(21)?.[0] ?? 0 };
  };
  let fdPriv: Priv[] = []; let fdSelect: (gid: number) => number = () => 0; let fdMatrices: (number[] | undefined)[] = [];
  if (isCID) {
    const fda = top.get(1236)?.[0]; const fdsel = top.get(1237)?.[0];
    if (fda !== undefined) { const fi = readIndex(b, fda).idx; for (let i = 0; i < fi.count; i++) { const d = readDict(fi.get(i)); fdPriv.push(priv(d)); fdMatrices.push(d.get(1207)); } }
    if (fdsel !== undefined) {
      const f = b[fdsel];
      if (f === 0) fdSelect = (g) => b[fdsel + 1 + g] ?? 0;
      else if (f === 3) { const n = be16(b, fdsel + 1); fdSelect = (g) => { for (let i = 0; i < n; i++) { const r = fdsel + 3 + i * 3; const next = be16(b, r + 3); if (g >= be16(b, r) && g < next) return b[r + 2]; } return 0; }; }
    }
  } else fdPriv = [priv(top)];
  // charset: gid → SID (or CID)
  const charset = new Uint16Array(nGlyphs); const csetOff = top.get(15)?.[0] ?? 0;
  if (csetOff > 2) {
    const f = b[csetOff]; let p = csetOff + 1, g = 1;
    if (f === 0) for (; g < nGlyphs; g++, p += 2) charset[g] = be16(b, p);
    else if (f === 1 || f === 2) while (g < nGlyphs && p < b.length) { const first = be16(b, p); const n = f === 1 ? b[p + 2] : be16(b, p + 2); p += f === 1 ? 3 : 4; for (let k = 0; k <= n && g < nGlyphs; k++) charset[g++] = first + k; }
  } else for (let g = 0; g < nGlyphs; g++) charset[g] = g; // ISOAdobe (0) — Expert charsets (1,2) are rare in PDFs; treated alike
  const nameToGid = new Map<string, number>(); const cidToGid = new Map<number, number>();
  for (let g = 0; g < nGlyphs; g++) { if (isCID) cidToGid.set(charset[g], g); else { const n = sid(charset[g]); if (!nameToGid.has(n)) nameToGid.set(n, g); } }
  // encoding (name-keyed only)
  let builtin: (string | null)[] | undefined;
  if (!isCID) {
    const eo = top.get(16)?.[0] ?? 0;
    if (eo === 0) builtin = standardEncoding().slice();
    else if (eo === 1) builtin = undefined; // Expert encoding: not tabulated; /Differences in the PDF normally supply it
    else {
      builtin = new Array(256).fill(null); const f = b[eo] & 0x7f; let p = eo + 1;
      if (f === 0) { const n = b[p++]; for (let i = 1; i <= n && i < nGlyphs; i++) builtin[b[p++]] = sid(charset[i]); }
      else if (f === 1) { const nr = b[p++]; let g = 1; for (let r = 0; r < nr; r++) { const first = b[p], left = b[p + 1]; p += 2; for (let k = 0; k <= left && g < nGlyphs; k++) builtin[(first + k) & 255] = sid(charset[g++]); } }
      if (b[eo] & 0x80) { const ns = b[p++]; for (let i = 0; i < ns; i++) { builtin[b[p]] = sid(be16(b, p + 1)); p += 3; } }
    }
  }
  const cache = new Map<number, { o: Outline; w: number }>();
  const run = (gid: number): { o: Outline; w: number } => {
    const c = cache.get(gid); if (c) return c;
    const fd = isCID ? Math.min(fdSelect(gid), fdPriv.length - 1) : 0; const pv = fdPriv[Math.max(0, fd)] ?? { subrs: { count: 0, get: () => new Uint8Array(0) }, dflt: 0, nominal: 0 };
    const r = type2(cs.get(gid), gsubrs.idx, pv.subrs, pv.dflt, pv.nominal, (code) => { const n = standardEncoding()[code]; const g = n ? nameToGid.get(n) : undefined; return g !== undefined ? run(g).o : null; });
    // CID fonts with a per-FD FontMatrix: fold it into the outline (top matrix × FD matrix)
    if (isCID && fdMatrices[fd]?.length === 6) { const m = fdMatrices[fd]!; const s = topExplicit ? 1 : 1000; /* final = FD × top; an absent top matrix contributes nothing (cancel the 0.001 default) */ r.o = xformOutline(r.o, m.map((v, i) => (i < 4 ? v * s : v * s)) as number[]); }
    if (cache.size < 20000) cache.set(gid, r); return r;
  };
  return {
    kind: "cff", matrix, numGlyphs: nGlyphs, isCID,
    outline: (gid) => (gid >= 0 && gid < nGlyphs ? run(gid).o : null),
    outlineCid: (cid) => { const g = isCID ? cidToGid.get(cid) : cid; return g !== undefined && g < nGlyphs ? run(g).o : null; },
    gidForName: (n) => nameToGid.get(n) ?? -1,
    builtinEncoding: builtin,
    advance: (gid) => (gid >= 0 && gid < nGlyphs ? run(gid).w * (matrix[0] * 1000) : 0),
  };
}
function xformOutline(o: Outline, m: number[]): Outline {
  const out: Outline = [];
  for (let i = 0; i < o.length;) { const op = o[i++]; out.push(op); const np = op === 0 || op === 1 ? 1 : op === 2 ? 2 : op === 3 ? 3 : 0; for (let k = 0; k < np; k++) { const x = o[i++], y = o[i++]; out.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]); } }
  return out;
}

/** Type 2 charstring interpreter (TN 5177). Returns the outline and the advance width. */
function type2(code: Uint8Array, gsubrs: Index, lsubrs: Index, dflt: number, nominal: number, seac: (c: number) => Outline | null): { o: Outline; w: number } {
  const out: Outline = []; const st: number[] = []; let x = 0, y = 0, nStems = 0, width: number | null = null, open = false, ops = 0;
  const trans: number[] = new Array(32).fill(0);
  const gb = bias(gsubrs.count), lb = bias(lsubrs.count);
  const move = (dx: number, dy: number) => { if (open) out.push(4); x += dx; y += dy; out.push(0, x, y); open = true; };
  const line = (dx: number, dy: number) => { x += dx; y += dy; out.push(1, x, y); };
  const curve = (a: number, b: number, c: number, d: number, e: number, f: number) => { const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d; x = x2 + e; y = y2 + f; out.push(3, x1, y1, x2, y2, x, y); };
  const takeWidth = (even: boolean) => { if (width === null) { width = (st.length % 2 === 1) === even ? nominal + st.shift()! : dflt; } };
  let done = false;
  const exec = (cs: Uint8Array, depth: number) => {
    if (depth > 10) return;
    for (let p = 0; p < cs.length && !done;) {
      if (++ops > 200000) { done = true; return; }
      const b0 = cs[p];
      if (b0 >= 32 || b0 === 28) {
        if (st.length >= 96) { done = true; return; }
        if (b0 === 28) { st.push(bes16(cs, p + 1)); p += 3; }
        else if (b0 <= 246) { st.push(b0 - 139); p++; }
        else if (b0 <= 250) { st.push((b0 - 247) * 256 + cs[p + 1] + 108); p += 2; }
        else if (b0 <= 254) { st.push(-(b0 - 251) * 256 - cs[p + 1] - 108); p += 2; }
        else { st.push((be32(cs, p + 1) | 0) / 65536); p += 5; }
        continue;
      }
      p++;
      switch (b0) {
        case 1: case 3: case 18: case 23: takeWidth(true); nStems += st.length >> 1; st.length = 0; break; // stems
        case 19: case 20: takeWidth(true); nStems += st.length >> 1; st.length = 0; p += (nStems + 7) >> 3; break; // hintmask/cntrmask
        case 21: takeWidth(false); move(st[st.length - 2] ?? 0, st[st.length - 1] ?? 0); st.length = 0; break; // rmoveto
        case 22: takeWidth(true); move(st[st.length - 1] ?? 0, 0); st.length = 0; break;
        case 4: takeWidth(true); move(0, st[st.length - 1] ?? 0); st.length = 0; break;
        case 5: for (let i = 0; i + 1 < st.length; i += 2) line(st[i], st[i + 1]); st.length = 0; break;
        case 6: case 7: { let h = b0 === 6; for (let i = 0; i < st.length; i++, h = !h) h ? line(st[i], 0) : line(0, st[i]); st.length = 0; break; }
        case 8: for (let i = 0; i + 5 < st.length; i += 6) curve(st[i], st[i + 1], st[i + 2], st[i + 3], st[i + 4], st[i + 5]); st.length = 0; break;
        case 24: { let i = 0; for (; i + 7 < st.length; i += 6) curve(st[i], st[i + 1], st[i + 2], st[i + 3], st[i + 4], st[i + 5]); line(st[i] ?? 0, st[i + 1] ?? 0); st.length = 0; break; }
        case 25: { let i = 0; for (; i + 7 < st.length; i += 2) line(st[i], st[i + 1]); curve(st[i] ?? 0, st[i + 1] ?? 0, st[i + 2] ?? 0, st[i + 3] ?? 0, st[i + 4] ?? 0, st[i + 5] ?? 0); st.length = 0; break; }
        case 26: { let i = 0; let dx1 = 0; if (st.length % 2) dx1 = st[i++]; for (; i + 3 < st.length; i += 4) { curve(dx1, st[i], st[i + 1], st[i + 2], 0, st[i + 3]); dx1 = 0; } st.length = 0; break; } // vvcurveto
        case 27: { let i = 0; let dy1 = 0; if (st.length % 2) dy1 = st[i++]; for (; i + 3 < st.length; i += 4) { curve(st[i], dy1, st[i + 1], st[i + 2], st[i + 3], 0); dy1 = 0; } st.length = 0; break; } // hhcurveto
        case 30: case 31: { // vhcurveto / hvcurveto
          let h = b0 === 31; let i = 0;
          while (i + 3 < st.length) {
            const last = st.length - i === 5;
            if (h) curve(st[i], 0, st[i + 1], st[i + 2], last ? st[i + 4] : 0, st[i + 3]);
            else curve(0, st[i], st[i + 1], st[i + 2], st[i + 3], last ? st[i + 4] : 0);
            i += last ? 5 : 4; h = !h;
          }
          st.length = 0; break;
        }
        case 10: case 29: { const idx = st.pop()!; const s = b0 === 10 ? lsubrs : gsubrs; const sub = s.get(idx + (b0 === 10 ? lb : gb)); if (sub.length) exec(sub, depth + 1); break; }
        case 11: return;
        case 14: // endchar (4 args = seac-style accented char)
          takeWidth(true);
          if (st.length >= 4) { const [adx, ady, bc, ac] = st.slice(-4); const base = seac(bc), acc = seac(ac); if (base) out.push(...base); if (acc) out.push(...xformOutline(acc, [1, 0, 0, 1, adx, ady])); }
          if (open) out.push(4); open = false; done = true; return;
        case 12: {
          const b1 = cs[p++];
          switch (b1) {
            case 35: { const a = st; curve(a[0], a[1], a[2], a[3], a[4], a[5]); curve(a[6], a[7], a[8], a[9], a[10], a[11]); break; } // flex
            case 34: { const a = st; const y0 = y; curve(a[0], 0, a[1], a[2], a[3], 0); curve(a[4], 0, a[5], y0 - y, a[6], 0); break; } // hflex
            case 36: { const a = st; const y0 = y; curve(a[0], a[1], a[2], a[3], a[4], 0); curve(a[5], 0, a[6], a[7], a[8], y0 - y - a[7]); break; } // hflex1
            case 37: { const a = st; const x0 = x, y0 = y; let dx = 0, dy = 0; for (let i = 0; i < 10; i += 2) { dx += a[i]; dy += a[i + 1]; }
              curve(a[0], a[1], a[2], a[3], a[4], a[5]); const lx = Math.abs(dx) > Math.abs(dy); curve(a[6], a[7], a[8], a[9], lx ? a[10] : x0 - x - a[6] - a[8], lx ? y0 - y - a[7] - a[9] : a[10]); break; } // flex1
            case 3: { const b = st.pop()!, a = st.pop()!; st.push(a && b ? 1 : 0); break; }
            case 4: { const b = st.pop()!, a = st.pop()!; st.push(a || b ? 1 : 0); break; }
            case 5: st.push(st.pop() ? 0 : 1); break;
            case 9: st.push(Math.abs(st.pop()!)); break;
            case 10: { const b = st.pop()!, a = st.pop()!; st.push(a + b); break; }
            case 11: { const b = st.pop()!, a = st.pop()!; st.push(a - b); break; }
            case 12: { const b = st.pop()!, a = st.pop()!; st.push(b ? a / b : 0); break; }
            case 14: st.push(-st.pop()!); break;
            case 15: { const b = st.pop()!, a = st.pop()!; st.push(a === b ? 1 : 0); break; }
            case 18: st.pop(); break;
            case 20: { const i = st.pop()!, v = st.pop()!; if (i >= 0 && i < 32) trans[i] = v; break; }
            case 21: { const i = st.pop()!; st.push(i >= 0 && i < 32 ? trans[i] : 0); break; }
            case 22: { const v2 = st.pop()!, v1 = st.pop()!, s2 = st.pop()!, s1 = st.pop()!; st.push(v1 <= v2 ? s1 : s2); break; }
            case 23: st.push(0.5); break;
            case 24: { const b = st.pop()!, a = st.pop()!; st.push(a * b); break; }
            case 26: st.push(Math.sqrt(Math.abs(st.pop()!))); break;
            case 27: st.push(st[st.length - 1] ?? 0); break;
            case 28: { const b = st.pop()!, a = st.pop()!; st.push(b, a); break; }
            case 29: { const i = st.pop()!; st.push(st[st.length - 1 - Math.max(0, i)] ?? 0); break; }
            case 30: { const j = st.pop()!, n = st.pop()!; if (n > 0 && n <= st.length) { const part = st.splice(st.length - n, n); const s = ((j % n) + n) % n; st.push(...part.slice(n - s), ...part.slice(0, n - s)); } break; }
            default: break; // dotsection & reserved
          }
          if (![3, 4, 5, 9, 10, 11, 12, 14, 15, 18, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30].includes(b1)) st.length = 0;
          break;
        }
        default: st.length = 0;
      }
    }
  };
  exec(code, 0);
  if (open) out.push(4);
  return { o: out, w: width ?? dflt };
}

/* ================================================================== Type 1 */
function decrypt(data: Uint8Array, r: number, skip: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, data.length - skip));
  for (let i = 0; i < data.length; i++) { const c = data[i]; const p = c ^ (r >> 8); r = ((c + r) * 52845 + 22719) & 0xffff; if (i >= skip) out[i - skip] = p; }
  return out;
}
const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
export function parseType1(input: Uint8Array, len1?: number): FontProgram | null {
  let b = input;
  if (b[0] === 0x80) { // PFB segments
    const parts: Uint8Array[] = []; let p = 0;
    while (p + 6 <= b.length && b[p] === 0x80 && (b[p + 1] === 1 || b[p + 1] === 2)) { const l = b[p + 2] | (b[p + 3] << 8) | (b[p + 4] << 16) | (b[p + 5] << 24); parts.push(b.subarray(p + 6, p + 6 + l)); p += 6 + l; }
    const t = parts.reduce((n, x) => n + x.length, 0); const o = new Uint8Array(t); let q = 0; for (const x of parts) { o.set(x, q); q += x.length; } b = o;
  }
  const latin = new TextDecoder("latin1");
  const head = latin.decode(b.subarray(0, Math.min(b.length, 65536)));
  let ee = head.indexOf("eexec"); if (ee < 0) return null;
  let p = ee + 5; while (p < b.length && (b[p] === 13 || b[p] === 10 || b[p] === 32 || b[p] === 9)) p++;
  if (len1 && len1 > ee && len1 < b.length && Math.abs(len1 - p) < 8) p = len1; // trust Length1 when it is close
  let enc = b.subarray(p);
  if (enc.length >= 4 && isHex(enc[0]) && isHex(enc[1]) && isHex(enc[2]) && isHex(enc[3])) { // hex eexec
    const o: number[] = []; let hi = -1;
    for (const c of enc) { if (!isHex(c)) continue; const v = c <= 57 ? c - 48 : (c | 32) - 87; if (hi < 0) hi = v; else { o.push(hi * 16 + v); hi = -1; } }
    enc = Uint8Array.from(o);
  }
  const priv = decrypt(enc, 55665, 4);
  const ptext = latin.decode(priv);
  const lenIVm = /\/lenIV\s+(\d+)/.exec(ptext); const lenIV = lenIVm ? Number(lenIVm[1]) : 4;
  // FontMatrix
  const fmm = /\/FontMatrix\s*[[{]\s*([-\d.eE\s]+)[\]}]/.exec(head); const fmv = fmm ? fmm[1].trim().split(/\s+/).map(Number) : [];
  const matrix = (fmv.length === 6 && fmv.every(Number.isFinite) ? fmv : [0.001, 0, 0, 0.001, 0, 0]) as FontProgram["matrix"];
  // encoding
  let builtin: (string | null)[] | undefined;
  if (/\/Encoding\s+StandardEncoding\s+def/.test(head)) builtin = standardEncoding().slice();
  else { builtin = new Array(256).fill(null); const re = /dup\s+(\d+)\s*\/([^\s/[\]{}()<>]+)\s+put/g; let m: RegExpExecArray | null; const encPart = head.slice(head.indexOf("/Encoding"), head.indexOf("eexec")); while ((m = re.exec(encPart))) { const c = Number(m[1]); if (c < 256) builtin[c] = m[2]; } }
  // Subrs and CharStrings: "<n> <len> RD <bytes>" — RD/-| tokens vary
  const subrs: Uint8Array[] = []; const chars = new Map<string, Uint8Array>();
  const readTok = (q: number) => { while (q < priv.length && priv[q] <= 32) q++; const s = q; while (q < priv.length && priv[q] > 32) q++; return { t: ptext.slice(s, q), end: q }; };
  const si = ptext.indexOf("/Subrs");
  if (si >= 0) {
    let q = si + 6; const cnt = readTok(q); q = cnt.end; const n = Math.min(Number(cnt.t) || 0, 65536);
    for (let i = 0; i < n; i++) {
      const d = ptext.indexOf("dup", q); if (d < 0) break;
      const a = readTok(d + 3), l = readTok(a.end), rd = readTok(l.end);
      const len = Number(l.t); if (!Number.isFinite(len) || len < 0) break; const start = rd.end + 1;
      subrs[Number(a.t)] = lenIV >= 0 ? decrypt(priv.subarray(start, start + len), 4330, lenIV) : priv.subarray(start, start + len);
      q = start + len;
    }
  }
  const ci = ptext.indexOf("/CharStrings");
  if (ci >= 0) {
    let q = ci + 12;
    for (let guard = 0; guard < 65536; guard++) {
      const sl = ptext.indexOf("/", q); if (sl < 0) break;
      // stop at the end of the CharStrings dict
      const endIdx = ptext.indexOf("end", q); if (endIdx >= 0 && endIdx < sl && /\bend\b/.test(ptext.slice(endIdx, endIdx + 4))) break;
      const nm = readTok(sl); const l = readTok(nm.end), rd = readTok(l.end);
      const len = Number(l.t); if (!Number.isFinite(len) || len < 0) { q = nm.end; continue; }
      const start = rd.end + 1;
      chars.set(nm.t.slice(1), lenIV >= 0 ? decrypt(priv.subarray(start, start + len), 4330, lenIV) : priv.subarray(start, start + len));
      q = start + len;
    }
  }
  if (!chars.size) return null;
  const names = [...chars.keys()]; const gidOf = new Map(names.map((n, i) => [n, i]));
  const cache = new Map<string, { o: Outline; w: number }>();
  const run = (name: string, depth = 0): { o: Outline; w: number } => {
    const c = cache.get(name); if (c) return c;
    const cs = chars.get(name); const r = cs ? type1cs(cs, subrs, (code) => { const n = standardEncoding()[code]; return n && depth < 2 ? run(n, depth + 1) : null; }) : { o: [], w: 0 };
    cache.set(name, r); return r;
  };
  return {
    kind: "type1", matrix, numGlyphs: names.length,
    outline: (gid) => (gid >= 0 && gid < names.length ? run(names[gid]).o : null),
    gidForName: (n) => gidOf.get(n) ?? -1,
    builtinEncoding: builtin,
    advance: (gid) => (gid >= 0 && gid < names.length ? run(names[gid]).w * matrix[0] * 1000 : 0),
  };
}
function type1cs(code: Uint8Array, subrs: Uint8Array[], seac: (c: number) => { o: Outline; w: number } | null): { o: Outline; w: number } {
  const out: Outline = []; const st: number[] = []; const ps: number[] = [];
  let x = 0, y = 0, sbx = 0, w = 0, open = false, flex = false; const flexPts: number[] = []; let ops = 0, done = false;
  const move = (nx: number, ny: number) => { if (flex) { flexPts.push(nx, ny); x = nx; y = ny; return; } if (open) out.push(4); x = nx; y = ny; out.push(0, x, y); open = true; };
  const line = (nx: number, ny: number) => { if (!open) { out.push(0, x, y); open = true; } x = nx; y = ny; out.push(1, x, y); };
  const curve = (a: number, b: number, c: number, d: number, e: number, f: number) => { if (!open) { out.push(0, x, y); open = true; } out.push(3, a, b, c, d, e, f); x = e; y = f; };
  const exec = (cs: Uint8Array, depth: number) => {
    if (depth > 10) return;
    for (let p = 0; p < cs.length && !done;) {
      if (++ops > 100000) { done = true; return; }
      const v = cs[p];
      if (v >= 32) {
        if (st.length >= 64) { done = true; return; }
        if (v <= 246) { st.push(v - 139); p++; } else if (v <= 250) { st.push((v - 247) * 256 + cs[p + 1] + 108); p += 2; } else if (v <= 254) { st.push(-(v - 251) * 256 - cs[p + 1] - 108); p += 2; } else { st.push(be32(cs, p + 1) | 0); p += 5; }
        continue;
      }
      p++;
      switch (v) {
        case 13: sbx = st[0] ?? 0; w = st[1] ?? 0; x = sbx; y = 0; st.length = 0; break; // hsbw
        case 21: move(x + (st[0] ?? 0), y + (st[1] ?? 0)); st.length = 0; break;
        case 22: move(x + (st[0] ?? 0), y); st.length = 0; break;
        case 4: move(x, y + (st[0] ?? 0)); st.length = 0; break;
        case 5: line(x + (st[0] ?? 0), y + (st[1] ?? 0)); st.length = 0; break;
        case 6: line(x + (st[0] ?? 0), y); st.length = 0; break;
        case 7: line(x, y + (st[0] ?? 0)); st.length = 0; break;
        case 8: { const [a, b, c, d, e, f] = st; const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d; curve(x1, y1, x2, y2, x2 + e, y2 + f); st.length = 0; break; }
        case 30: { const [a, b, c, d] = st; const x1 = x, y1 = y + a, x2 = x1 + b, y2 = y1 + c; curve(x1, y1, x2, y2, x2 + d, y2); st.length = 0; break; }
        case 31: { const [a, b, c, d] = st; const x1 = x + a, y1 = y, x2 = x1 + b, y2 = y1 + c; curve(x1, y1, x2, y2, x2, y2 + d); st.length = 0; break; }
        case 9: if (open) { out.push(4); open = false; } st.length = 0; break; // closepath
        case 10: { const i = st.pop()!; const s = subrs[i]; if (s) exec(s, depth + 1); break; }
        case 11: return;
        case 14: if (open) out.push(4); open = false; done = true; return; // endchar
        case 1: case 3: st.length = 0; break; // hstem vstem
        case 12: {
          const b1 = cs[p++];
          if (b1 === 6) { // seac
            const [, adx, ady, bc, ac] = st; const base = seac(bc), acc = seac(ac);
            if (base) out.push(...base.o);
            if (acc) out.push(...xformOutline(acc.o, [1, 0, 0, 1, adx - (st[0] ?? 0) + sbx, ady]));
            done = true; return;
          } else if (b1 === 7) { sbx = st[0] ?? 0; w = st[2] ?? 0; x = sbx; y = st[1] ?? 0; st.length = 0; } // sbw
          else if (b1 === 12) { const b2 = st.pop()!, a2 = st.pop()!; st.push(b2 ? a2 / b2 : 0); } // div
          else if (b1 === 16) { // callothersubr
            const n = st.pop()!, cnt = st.pop()!; const args = st.splice(Math.max(0, st.length - cnt), cnt);
            if (n === 1) { flex = true; flexPts.length = 0; }
            else if (n === 0 && flex) {
              flex = false; // flexPts: reference point + 6 control/end points (7 pairs)
              const f = flexPts; if (f.length >= 14) { curve(f[2], f[3], f[4], f[5], f[6], f[7]); curve(f[8], f[9], f[10], f[11], f[12], f[13]); }
              ps.push(y, x); // "pop pop setcurrentpoint" follows: x is popped first, then y
            } else if (n === 2) { /* flex point collected by the moveto */ }
            else if (n === 3) ps.push(3); // hint replacement: pushes subr 3 → callsubr is a no-op
            else for (let i = args.length - 1; i >= 0; i--) ps.push(args[i]);
          } else if (b1 === 17) { st.push(ps.pop() ?? 0); } // pop
          else if (b1 === 33) { x = st[0] ?? x; y = st[1] ?? y; st.length = 0; } // setcurrentpoint
          else st.length = 0; // dotsection, vstem3, hstem3
          break;
        }
        default: st.length = 0;
      }
    }
  };
  exec(code, 0);
  if (open) out.push(4);
  return { o: out, w };
}
