/**
 * TT52 — PDF stream filters (ISO 32000-2 §7.4), original code from the specifications:
 *   FlateDecode (RFC 1950/1951 — a synchronous inflater that keeps the output decoded before any corruption),
 *   PNG/TIFF predictors (§7.4.4.4), LZWDecode (§7.4.4, EarlyChange), ASCII85Decode, ASCIIHexDecode, RunLengthDecode.
 * Image codecs (DCT, JPX, JBIG2, CCITT) are not byte filters here: DCT goes to the browser's JPEG decoder, CCITT has
 * its own decoder (pdfccitt.ts), JPX/JBIG2 are reported as unsupported.
 */
import { PDict, PName, isArr, isDict, isName, isNum, type PObj, type Bytes } from "./pdfobj";

export class FilterError extends Error {}
export interface Decoded { data: Bytes; partial: boolean }

/* ------------------------------------------------------------------ inflate (RFC 1951) */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** canonical Huffman table: count per length + symbols sorted by code (RFC 1951 §3.2.2) */
interface Huff { count: Uint16Array; sym: Uint16Array }
function huff(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
  return { count, sym };
}
let FIXED_L: Huff | null = null, FIXED_D: Huff | null = null;
function fixed() {
  if (!FIXED_L) {
    const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED_L = huff(l, 288); const d = new Uint8Array(30); d.fill(5); FIXED_D = huff(d, 30);
  }
  return [FIXED_L, FIXED_D!] as const;
}

class Out {
  buf: Uint8Array; n = 0; limit: number;
  constructor(hint: number, limit: number) { this.buf = new Uint8Array(Math.max(1024, Math.min(hint, limit))); this.limit = limit; }
  grow(need: number) {
    if (this.n + need > this.limit) throw new FilterError("pdf: stream inflates beyond the size guard");
    let cap = this.buf.length; while (cap < this.n + need) cap *= 2;
    const b = new Uint8Array(Math.min(cap, this.limit)); b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
  push(c: number) { if (this.n >= this.buf.length) this.grow(1); this.buf[this.n++] = c; }
  result() { return this.buf.subarray(0, this.n); }
}

export function inflate(input: Bytes, limit = 256 << 20): Decoded {
  // zlib wrapper (CMF/FLG check) — many PDFs omit or corrupt it; fall back to raw deflate
  let p = 0;
  if (input.length >= 2 && (input[0] & 0x0f) === 8 && ((input[0] << 8) | input[1]) % 31 === 0) p = 2;
  const out = new Out(input.length * 4, limit);
  let bitbuf = 0, bitcnt = 0;
  const bits = (need: number) => {
    while (bitcnt < need) {
      if (p >= input.length) throw new FilterError("eof");
      bitbuf |= input[p++] << bitcnt; bitcnt += 8;
    }
    const v = bitbuf & ((1 << need) - 1); bitbuf >>>= need; bitcnt -= need; return v;
  };
  const decode = (h: Huff) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1); const count = h.count[len];
      if (code - count < first) return h.sym[index + (code - first)];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new FilterError("bad huffman code");
  };
  try {
    let last = 0;
    do {
      last = bits(1); const type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        if (p + 4 > input.length) throw new FilterError("eof");
        const len = input[p] | (input[p + 1] << 8); p += 4; // NLEN not enforced: some writers get it wrong
        const take = Math.min(len, input.length - p);
        if (out.n + take > out.buf.length) out.grow(take);
        out.buf.set(input.subarray(p, p + take), out.n); out.n += take; p += take;
        if (take < len) throw new FilterError("eof");
      } else if (type === 1 || type === 2) {
        let L: Huff, D: Huff;
        if (type === 1) [L, D] = fixed();
        else {
          const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
          if (nlen > 286 || ndist > 30) throw new FilterError("bad dynamic header");
          const cl = new Uint8Array(19); for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
          const ch = huff(cl, 19); const lens = new Uint8Array(nlen + ndist);
          for (let i = 0; i < nlen + ndist;) {
            const s = decode(ch);
            if (s < 16) lens[i++] = s;
            else {
              let rep = 0, val = 0;
              if (s === 16) { if (i === 0) throw new FilterError("repeat with no previous length"); val = lens[i - 1]; rep = 3 + bits(2); }
              else if (s === 17) rep = 3 + bits(3); else rep = 11 + bits(7);
              if (i + rep > nlen + ndist) throw new FilterError("too many lengths");
              while (rep--) lens[i++] = val;
            }
          }
          L = huff(lens.subarray(0, nlen), nlen); D = huff(lens.subarray(nlen), ndist);
        }
        for (;;) {
          const s = decode(L);
          if (s < 256) out.push(s);
          else if (s === 256) break;
          else {
            const li = s - 257; if (li >= 29) throw new FilterError("bad length symbol");
            const len = LBASE[li] + bits(LEXT[li]);
            const ds = decode(D); if (ds >= 30) throw new FilterError("bad distance symbol");
            const dist = DBASE[ds] + bits(DEXT[ds]);
            if (dist > out.n) throw new FilterError("distance too far back");
            if (out.n + len > out.buf.length) out.grow(len);
            const b = out.buf; let o = out.n; for (let k = 0; k < len; k++, o++) b[o] = b[o - dist]; out.n = o;
          }
        }
      } else throw new FilterError("bad block type");
    } while (!last);
    return { data: out.result(), partial: false };
  } catch (e) {
    if (e instanceof FilterError && /size guard/.test(e.message)) throw e;
    return { data: out.result(), partial: true }; // keep what decoded before the damage (truncated streams are common)
  }
}

/* ------------------------------------------------------------------ predictors (§7.4.4.4) */
export function unpredict(data: Bytes, parms: PDict | null): Bytes {
  if (!parms) return data;
  const pred = num(parms.get("Predictor"), 1); if (pred <= 1) return data;
  const colors = Math.max(1, Math.min(64, num(parms.get("Colors"), 1)));
  const bpc = num(parms.get("BitsPerComponent"), 8);
  const cols = Math.max(1, Math.min(1 << 24, num(parms.get("Columns"), 1)));
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * cols) / 8);
  if (pred === 2) { // TIFF predictor 2 (only 8-bit components are common; 1/2/4/16-bit handled bitwise)
    const out = Uint8Array.from(data);
    if (bpc === 8) for (let r = 0; r * rowLen < out.length; r++) { const o = r * rowLen; for (let i = bpp; i < rowLen && o + i < out.length; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 0xff; }
    else if (bpc === 16) for (let r = 0; r * rowLen < out.length; r++) { const o = r * rowLen; for (let i = colors * 2; i + 1 < rowLen && o + i + 1 < out.length; i += 2) { const v = ((out[o + i] << 8) | out[o + i + 1]) + ((out[o + i - colors * 2] << 8) | out[o + i - colors * 2 + 1]); out[o + i] = (v >> 8) & 0xff; out[o + i + 1] = v & 0xff; } }
    else {
      const bitsRow = colors * bpc * cols; const mask = (1 << bpc) - 1;
      for (let r = 0; r * rowLen < out.length; r++) {
        const o = r * rowLen; const prev = new Array(colors).fill(0);
        for (let k = 0; k < bitsRow / bpc; k++) {
          const bit = k * bpc; const byte = o + (bit >> 3); if (byte >= out.length) break; const shift = 8 - bpc - (bit & 7);
          const v = ((out[byte] >> shift) & mask); const c = k % colors; const nv = (v + prev[c]) & mask; prev[c] = nv;
          out[byte] = (out[byte] & ~(mask << shift)) | (nv << shift);
        }
      }
    }
    return out;
  }
  // PNG predictors: every row starts with a filter-type byte
  const rows = Math.floor(data.length / (rowLen + 1)); const out = new Uint8Array(rows * rowLen);
  const prior = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)]; const src = r * (rowLen + 1) + 1; const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i]; const a = i >= bpp ? out[dst + i - bpp] : 0; const b = prior[i]; const c = i >= bpp ? (r > 0 ? out[dst - rowLen + i - bpp] : 0) : 0;
      let v: number;
      switch (ft) {
        case 0: v = x; break; case 1: v = x + a; break; case 2: v = x + b; break; case 3: v = x + ((a + b) >> 1); break;
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = x; // unknown filter type: copy (other readers do the same)
      }
      out[dst + i] = v & 0xff;
    }
    prior.set(out.subarray(dst, dst + rowLen));
  }
  return out;
}

/* ------------------------------------------------------------------ LZW (§7.4.4.2) */
export function lzw(data: Bytes, earlyChange = 1, limit = 256 << 20): Decoded {
  const out = new Out(data.length * 3, limit);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), lens = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; lens[i] = 1; }
  let next = 258, width = 9, prev = -1, bitbuf = 0, bitcnt = 0, p = 0;
  const tmp = new Uint8Array(4096);
  const emit = (code: number) => { let n = lens[code]; let c = code; const L = n; while (n > 0) { tmp[--n] = suffix[c]; c = prefix[c]; } for (let i = 0; i < L; i++) out.push(tmp[i]); };
  const first = (code: number) => { let c = code; while (prefix[c] >= 0) c = prefix[c]; return suffix[c]; };
  try {
    for (;;) {
      while (bitcnt < width) { if (p >= data.length) return { data: out.result(), partial: false }; bitbuf = ((bitbuf << 8) | data[p++]) >>> 0; bitcnt += 8; }
      const code = (bitbuf >>> (bitcnt - width)) & ((1 << width) - 1); bitcnt -= width;
      if (code === 256) { next = 258; width = 9; prev = -1; continue; }
      if (code === 257) break;
      if (prev < 0) { if (code > 255) throw new FilterError("bad first LZW code"); emit(code); prev = code; continue; }
      let k: number;
      if (code < next) { emit(code); k = first(code); }
      else if (code === next) { k = first(prev); emit(prev); out.push(k); }
      else throw new FilterError("bad LZW code");
      if (next < 4096) { prefix[next] = prev; suffix[next] = k; lens[next] = lens[prev] + 1; next++; }
      prev = code;
      if (next + earlyChange >= (1 << width) && width < 12) width++;
    }
    return { data: out.result(), partial: false };
  } catch (e) {
    if (e instanceof FilterError && /size guard/.test(e.message)) throw e;
    return { data: out.result(), partial: true };
  }
}

/* ------------------------------------------------------------------ ASCII filters, RunLength */
export function ascii85(data: Bytes): Decoded {
  const out: number[] = []; let tuple = 0, n = 0; let partial = false;
  let i = 0; if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // optional "<~"
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // "~>"
    if (c <= 32) continue;
    if (c === 0x7a && n === 0) { out.push(0, 0, 0, 0); continue; } // "z"
    if (c < 0x21 || c > 0x75) { partial = true; continue; }
    tuple = tuple * 85 + (c - 33); n++;
    if (n === 5) { out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255); tuple = 0; n = 0; }
  }
  if (n > 1) { for (let k = n; k < 5; k++) tuple = tuple * 85 + 84; for (let k = 0; k < n - 1; k++) out.push((tuple >>> (24 - 8 * k)) & 255); }
  return { data: Uint8Array.from(out), partial };
}
export function asciiHex(data: Bytes): Decoded {
  const out: number[] = []; let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = c >= 0x30 && c <= 0x39 ? c - 48 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) continue; if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return { data: Uint8Array.from(out), partial: false };
}
export function runLength(data: Bytes, limit = 256 << 20): Decoded {
  const out = new Out(data.length * 2, limit);
  for (let i = 0; i < data.length;) {
    const L = data[i++]; if (L === 128) break;
    if (L < 128) { for (let k = 0; k <= L && i < data.length; k++) out.push(data[i++]); }
    else { const c = data[i++]; for (let k = 0; k < 257 - L; k++) out.push(c); }
  }
  return { data: out.result(), partial: false };
}

/* ------------------------------------------------------------------ chain */
const num = (o: PObj | undefined, d: number) => (isNum(o) ? o : d);
export const IMAGE_FILTERS = new Set(["DCTDecode", "DCT", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "CCF"]);
const ALIAS: Record<string, string> = { Fl: "FlateDecode", LZW: "LZWDecode", A85: "ASCII85Decode", AHx: "ASCIIHexDecode", RL: "RunLengthDecode", DCT: "DCTDecode", CCF: "CCITTFaxDecode" };
export interface FilterSpec { name: string; parms: PDict | null }
/** the filter chain of a stream dictionary (/Filter + /DecodeParms, abbreviations expanded); `resolve` derefs */
export function filterChain(dict: PDict, resolve: (o: PObj | undefined) => PObj | undefined): FilterSpec[] {
  const f = resolve(dict.get("Filter") ?? dict.get("F")); const p = resolve(dict.get("DecodeParms") ?? dict.get("DP"));
  const names = isArr(f) ? f.map((x) => resolve(x)) : f ? [f] : [];
  const parms = isArr(p) ? p.map((x) => resolve(x)) : [p];
  return names.filter((x): x is PName => isName(x)).map((n, i) => ({ name: ALIAS[n.n] ?? n.n, parms: (isDict(parms[i]) ? parms[i] : null) as PDict | null }));
}
/** apply byte filters in order; stops (without error) at the first image codec, returning it for the image decoder */
export function applyFilters(raw: Bytes, chain: FilterSpec[], limit = 256 << 20): { data: Bytes; partial: boolean; image: FilterSpec | null; unsupported?: string; ccitt?: boolean } {
  let data = raw, partial = false;
  for (const f of chain) {
    let r: Decoded;
    switch (f.name) {
      case "FlateDecode": r = inflate(data, limit); r = { data: unpredict(r.data, f.parms), partial: r.partial }; break;
      case "LZWDecode": r = lzw(data, f.parms ? num(f.parms.get("EarlyChange"), 1) : 1, limit); r = { data: unpredict(r.data, f.parms), partial: r.partial }; break;
      case "ASCII85Decode": r = ascii85(data); break;
      case "ASCIIHexDecode": r = asciiHex(data); break;
      case "RunLengthDecode": r = runLength(data, limit); break;
      case "Crypt": r = { data, partial: false }; break; // handled by the security handler (Identity or the default filter)
      default:
        if (IMAGE_FILTERS.has(f.name)) return { data, partial, image: f };
        return { data, partial: true, image: null, unsupported: f.name };
    }
    data = r.data; partial ||= r.partial;
  }
  return { data, partial, image: null };
}
