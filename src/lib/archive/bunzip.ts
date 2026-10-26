/**
 * TT79 — first-party bzip2 decoder (APPNOTE method 12). Written from the format's structure as documented publicly
 * (stream header "BZh1"–"BZh9", 48-bit block / end-of-stream magics, symbol map, Huffman groups + MTF-coded selectors,
 * RUNA/RUNB zero runs, MTF, inverse Burrows–Wheeler transform, the RLE1 pass) — every block CRC and the stream CRC are
 * verified. Synchronous; output bounded by `limit`. Oracle: Python's bz2 module (scripts/tt79-archive.mts).
 */
import type { Bytes } from "./inflate";

const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; t[i] = c >>> 0; } return t; })();

class Bits {
  pos = 0; buf = 0; cnt = 0; private d: Bytes;
  constructor(d: Bytes) { this.d = d; }
  get(n: number): number { // MSB-first
    let v = 0;
    while (n > 0) {
      if (!this.cnt) { if (this.pos >= this.d.length) throw new Error("bzip2: unexpected end of data"); this.buf = this.d[this.pos++]; this.cnt = 8; }
      const take = Math.min(n, this.cnt);
      v = (v << take) | ((this.buf >>> (this.cnt - take)) & ((1 << take) - 1));
      this.cnt -= take; n -= take;
    }
    return v >>> 0;
  }
  bit() { return this.get(1); }
}

export function bunzip2Sync(src: Bytes, limit = Infinity): Bytes {
  const b = new Bits(src);
  const parts: Uint8Array[] = []; let total = 0;
  let streams = 0;
  while (b.pos < src.length) {
    if (streams && b.pos + 4 > src.length) break; // trailing padding after a complete stream
    if (b.get(8) !== 0x42 || b.get(8) !== 0x5a || b.get(8) !== 0x68) { if (streams) break; throw new Error("bzip2: bad stream header"); }
    const level = b.get(8) - 0x30; if (level < 1 || level > 9) throw new Error("bzip2: bad block size");
    const maxBlock = level * 100000;
    let combined = 0;
    for (;;) {
      const m1 = b.get(24), m2 = b.get(24);
      if (m1 === 0x177245 && m2 === 0x385090) {
        const want = b.get(32);
        if (want !== combined >>> 0) throw new Error("bzip2: stream CRC mismatch");
        b.cnt = 0; // streams are byte-aligned after padding
        break;
      }
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error("bzip2: bad block magic");
      const blockCrc = b.get(32);
      if (b.bit()) throw new Error("bzip2: randomised blocks are not supported (obsolete since bzip2 0.9.5)");
      const origPtr = b.get(24);
      // symbol map
      const used = b.get(16); const seqToUnseq: number[] = [];
      for (let i = 0; i < 16; i++) if (used & (0x8000 >> i)) { const w = b.get(16); for (let j = 0; j < 16; j++) if (w & (0x8000 >> j)) seqToUnseq.push(i * 16 + j); }
      if (!seqToUnseq.length) throw new Error("bzip2: empty symbol map");
      const alpha = seqToUnseq.length + 2;
      const nGroups = b.get(3); if (nGroups < 2 || nGroups > 6) throw new Error("bzip2: bad Huffman group count");
      const nSel = b.get(15); if (!nSel) throw new Error("bzip2: no selectors");
      const mtfG = Array.from({ length: nGroups }, (_, i) => i); const sel = new Uint8Array(nSel);
      for (let i = 0; i < nSel; i++) {
        let j = 0; while (b.bit()) { j++; if (j >= nGroups) throw new Error("bzip2: bad selector"); }
        const v = mtfG[j]; mtfG.splice(j, 1); mtfG.unshift(v); sel[i] = v;
      }
      // code lengths (delta coded) → canonical decoding tables per group
      const tables: { limit: Int32Array; base: Int32Array; perm: Int32Array; minLen: number; maxLen: number }[] = [];
      for (let g = 0; g < nGroups; g++) {
        const len = new Uint8Array(alpha); let cur = b.get(5);
        for (let s = 0; s < alpha; s++) {
          for (;;) { if (cur < 1 || cur > 20) throw new Error("bzip2: bad code length"); if (!b.bit()) break; cur += b.bit() ? -1 : 1; }
          len[s] = cur;
        }
        let minLen = 32, maxLen = 0; for (const l of len) { if (l < minLen) minLen = l; if (l > maxLen) maxLen = l; }
        const perm = new Int32Array(alpha); let pp = 0;
        for (let l = minLen; l <= maxLen; l++) for (let s = 0; s < alpha; s++) if (len[s] === l) perm[pp++] = s;
        const count = new Int32Array(22); for (const l of len) count[l]++;
        const limitA = new Int32Array(22), base = new Int32Array(22);
        let code = 0, idx = 0;
        for (let l = minLen; l <= maxLen; l++) { base[l] = idx - code; code += count[l]; idx += count[l]; limitA[l] = code - 1; code <<= 1; }
        tables.push({ limit: limitA, base, perm, minLen, maxLen });
      }
      // symbols → MTF indices → bytes (pre-BWT), with RUNA/RUNB zero runs
      const tt = new Uint32Array(maxBlock); let n = 0;
      const mtf = seqToUnseq.slice(); const counts = new Uint32Array(256);
      let groupLeft = 0, gi = -1, t = tables[0], run = 0, runBit = 1;
      const flushRun = () => {
        if (!run) return;
        const v = mtf[0]; if (n + run > maxBlock) throw new Error("bzip2: block overflows its declared size");
        counts[v] += run; tt.fill(v, n, n + run); n += run; run = 0; runBit = 1;
      };
      for (;;) {
        if (!groupLeft) { gi++; if (gi >= nSel) throw new Error("bzip2: ran out of selectors"); t = tables[sel[gi]]; groupLeft = 50; }
        groupLeft--;
        let l = t.minLen, code = b.get(l);
        while (l <= t.maxLen && code > t.limit[l]) { l++; code = (code << 1) | b.bit(); }
        if (l > t.maxLen) throw new Error("bzip2: bad Huffman code");
        const sym = t.perm[t.base[l] + code];
        if (sym <= 1) { run += runBit << sym; runBit <<= 1; if (run > maxBlock) throw new Error("bzip2: run too long"); continue; }
        flushRun();
        if (sym === alpha - 1) break; // end of block
        const k = sym - 1; const v = mtf[k]; mtf.splice(k, 1); mtf.unshift(v);
        if (n >= maxBlock) throw new Error("bzip2: block overflows its declared size");
        counts[v]++; tt[n++] = v;
      }
      if (origPtr >= n) throw new Error("bzip2: bad BWT origin pointer");
      // inverse BWT: cumulative counts give each byte's position in the sorted column
      const cum = new Uint32Array(256); for (let i = 0, s = 0; i < 256; i++) { cum[i] = s; s += counts[i]; }
      for (let i = 0; i < n; i++) { const v = tt[i] & 0xff; tt[cum[v]++] |= i << 8; }
      // walk the permutation, undoing RLE1 (4 equal bytes + a count byte) and computing the block CRC
      const block: number[] = []; let crc = 0xffffffff;
      const emit = (v: number) => { block.push(v); crc = (crc << 8) ^ CRC[((crc >>> 24) ^ v) & 0xff]; };
      let p = tt[origPtr] >>> 8, last = -1, rep = 0;
      for (let i = 0; i < n; i++) {
        const e = tt[p]; const v = e & 0xff; p = e >>> 8;
        if (rep === 4) { for (let k = 0; k < v; k++) emit(last); rep = 0; last = -1; continue; }
        if (v === last) rep++; else { rep = 1; last = v; }
        emit(v);
      }
      if ((~crc >>> 0) !== blockCrc) throw new Error("bzip2: block CRC mismatch");
      combined = (((combined << 1) | (combined >>> 31)) ^ blockCrc) >>> 0;
      total += block.length; if (total > limit) throw new Error(`bzip2: output exceeds the ${limit}-byte limit`);
      parts.push(Uint8Array.from(block));
    }
    streams++;
  }
  const out = new Uint8Array(total); let o = 0; for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}
