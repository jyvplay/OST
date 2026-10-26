/**
 * TT79 — first-party LZMA decoder for ZIP method 14 (APPNOTE §5.8.8: 2-byte SDK version, 2-byte property size = 5,
 * the 5 property bytes lc/lp/pb + dictionary size, then the raw LZMA stream; general-purpose flag bit 1 = the stream
 * ends with an end-of-stream marker). Written from the decoder model in the public-domain LZMA specification
 * (range coder, literal / matched-literal coders, length coders, 6-bit distance slots, reverse bit trees, the 4 rep
 * distances and the 12-state machine). The whole output is the dictionary, so no window wrap is needed.
 * Oracle: Python's lzma module via zipfile (scripts/tt79-archive.mts).
 */
import type { Bytes } from "./inflate";

const PROB_INIT = 1024;

export function unlzmaZipSync(src: Bytes, opts: { size: number; eos?: boolean; limit?: number }): Bytes {
  if (src.length < 9) throw new Error("lzma: truncated header");
  const propSize = src[2] | (src[3] << 8);
  if (propSize !== 5) throw new Error(`lzma: unsupported property size ${propSize}`);
  return unlzmaRaw(src.subarray(4, 9), src.subarray(9), opts);
}

/** decode a raw LZMA stream given its 5 property bytes; `size` = the known uncompressed size (−1 = until EOS) */
export function unlzmaRaw(props: Bytes, d: Bytes, opts: { size: number; eos?: boolean; limit?: number }): Bytes {
  let p0 = props[0]; if (p0 >= 9 * 5 * 5) throw new Error("lzma: bad properties");
  const lc = p0 % 9; p0 = (p0 / 9) | 0; const lp = p0 % 5, pb = (p0 / 5) | 0;
  const limit = opts.limit ?? Infinity;
  const size = opts.size;
  if (size > limit) throw new Error(`lzma: output exceeds the ${limit}-byte limit`);
  let out = new Uint8Array(size >= 0 ? size : Math.min(1 << 20, limit)); let pos = 0;
  const ensure = (n: number) => {
    if (pos + n <= out.length) return;
    if (size >= 0) throw new Error("lzma: data continues past the declared size");
    if (pos + n > limit) throw new Error(`lzma: output exceeds the ${limit}-byte limit`);
    let cap = out.length * 2; while (cap < pos + n) cap *= 2; const b = new Uint8Array(Math.min(cap, limit)); b.set(out.subarray(0, pos)); out = b;
  };
  // range decoder
  let ip = 0;
  const next = () => { if (ip >= d.length) throw new Error("lzma: unexpected end of data"); return d[ip++]; };
  if (next() !== 0) throw new Error("lzma: bad range-coder start");
  let range = 0xffffffff, code = 0;
  for (let i = 0; i < 4; i++) code = ((code << 8) | next()) >>> 0;
  if (code === range) throw new Error("lzma: corrupted stream");
  const bit = (probs: Uint16Array, i: number): number => {
    const pr = probs[i]; const bound = (range >>> 11) * pr >>> 0;
    let b: number;
    if (code < bound) { range = bound; probs[i] = pr + ((2048 - pr) >>> 5); b = 0; }
    else { range = (range - bound) >>> 0; code = (code - bound) >>> 0; probs[i] = pr - (pr >>> 5); b = 1; }
    if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | next()) >>> 0; }
    return b;
  };
  const direct = (n: number): number => {
    let r = 0;
    while (n--) {
      range = range >>> 1;
      let b = 0; if (code >= range) { code = (code - range) >>> 0; b = 1; }
      r = ((r << 1) | b) >>> 0;
      if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | next()) >>> 0; }
    }
    return r;
  };
  const tree = (probs: Uint16Array, base: number, n: number) => { let m = 1; for (let i = 0; i < n; i++) m = (m << 1) | bit(probs, base + m); return m - (1 << n); };
  const rtree = (probs: Uint16Array, base: number, n: number) => { let m = 1, s = 0; for (let i = 0; i < n; i++) { const b = bit(probs, base + m); m = (m << 1) | b; s |= b << i; } return s; };
  // models
  const lit = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
  const isMatch = new Uint16Array(12 << 4).fill(PROB_INIT), isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT);
  const isRep = new Uint16Array(12).fill(PROB_INIT), isRepG0 = new Uint16Array(12).fill(PROB_INIT), isRepG1 = new Uint16Array(12).fill(PROB_INIT), isRepG2 = new Uint16Array(12).fill(PROB_INIT);
  const posSlot = new Uint16Array(4 << 6).fill(PROB_INIT), posDec = new Uint16Array(1 + 114).fill(PROB_INIT), align = new Uint16Array(16).fill(PROB_INIT);
  const lenModel = () => ({ choice: new Uint16Array(2).fill(PROB_INIT), low: new Uint16Array(16 << 3).fill(PROB_INIT), mid: new Uint16Array(16 << 3).fill(PROB_INIT), high: new Uint16Array(256).fill(PROB_INIT) });
  const lenM = lenModel(), repM = lenModel();
  const len = (m: ReturnType<typeof lenModel>, ps: number) => {
    if (!bit(m.choice, 0)) return tree(m.low, ps << 3, 3);
    if (!bit(m.choice, 1)) return 8 + tree(m.mid, ps << 3, 3);
    return 16 + tree(m.high, 0, 8);
  };
  const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;
  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  for (;;) {
    if (size >= 0 && pos === size && !opts.eos) break;
    const ps = pos & pbMask;
    if (!bit(isMatch, (state << 4) + ps)) {
      if (size >= 0 && pos >= size) throw new Error("lzma: data continues past the declared size");
      const prev = pos ? out[pos - 1] : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
      let s = 1;
      if (state >= 7) {
        if (rep0 >= pos) throw new Error("lzma: match distance beyond the output");
        let mb = out[pos - rep0 - 1];
        while (s < 0x100) {
          const m = (mb >>> 7) & 1; mb = (mb << 1) & 0xff;
          const b = bit(lit, base + ((1 + m) << 8) + s); s = (s << 1) | b;
          if (m !== b) break;
        }
      }
      while (s < 0x100) s = (s << 1) | bit(lit, base + s);
      ensure(1); out[pos++] = s & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let l: number;
    if (bit(isRep, state)) {
      if (!pos) throw new Error("lzma: rep match at the start of the stream");
      if (!bit(isRepG0, state)) {
        if (!bit(isRep0Long, (state << 4) + ps)) { // short rep: one byte at distance rep0
          state = state < 7 ? 9 : 11;
          if (size >= 0 && pos >= size) throw new Error("lzma: data continues past the declared size");
          ensure(1); out[pos] = out[pos - rep0 - 1]; pos++;
          continue;
        }
      } else {
        let dist: number;
        if (!bit(isRepG1, state)) dist = rep1;
        else { if (!bit(isRepG2, state)) dist = rep2; else { dist = rep3; rep3 = rep2; } rep2 = rep1; }
        rep1 = rep0; rep0 = dist;
      }
      l = len(repM, ps);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      l = len(lenM, ps);
      state = state < 7 ? 7 : 10;
      // distance
      const slot = tree(posSlot, (l < 4 ? l : 3) << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const nd = (slot >>> 1) - 1; let dist = ((2 | (slot & 1)) << nd) >>> 0;
        if (slot < 14) dist = (dist + rtree(posDec, dist - slot, nd)) >>> 0;
        else { dist = (dist + ((direct(nd - 4) << 4) >>> 0)) >>> 0; dist = (dist + rtree(align, 0, 4)) >>> 0; }
        rep0 = dist;
      }
      if (rep0 === 0xffffffff) { // end-of-stream marker
        if (size >= 0 && pos !== size) throw new Error("lzma: end marker before the declared size");
        break;
      }
    }
    const n = l + 2;
    if (rep0 >= pos) throw new Error("lzma: match distance beyond the output");
    if (size >= 0 && pos + n > size) throw new Error("lzma: match runs past the declared size");
    ensure(n);
    for (let i = 0; i < n; i++) { out[pos] = out[pos - rep0 - 1]; pos++; }
  }
  return size >= 0 ? out : out.slice(0, pos);
}
