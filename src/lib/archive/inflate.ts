/**
 * TT79 — first-party inflater for raw DEFLATE (RFC 1951) and PKWARE "Deflate64" (APPNOTE method 9).
 *
 * Written from RFC 1951 §3.2. Deflate64 differs only in three places (APPNOTE 6.3.x §5.5, and the well-documented
 * behaviour of PKZIP / Windows Explorer):
 *   - the window is 65 536 bytes instead of 32 768;
 *   - length code 285 carries 16 extra bits with base 3 (instead of the fixed length 258);
 *   - distance codes 30 and 31 are valid (bases 32 769 and 49 153, 14 extra bits each).
 * Synchronous, allocation-bounded (`limit` caps the output, so a bomb is stopped while decoding), no dependencies.
 */
export type Bytes = Uint8Array;

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** canonical Huffman decoding table: counts per length + symbols sorted by code (RFC 1951 §3.2.2) */
interface Huff { count: Uint16Array; sym: Uint16Array }
function build(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16), sym = new Uint16Array(n), offs = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  // over-subscribed sets are invalid; incomplete sets are allowed (a single distance code is legal)
  let left = 1;
  for (let len = 1; len < 16; len++) { left <<= 1; left -= count[len]; if (left < 0) throw new Error("inflate: over-subscribed Huffman code"); }
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
  return { count, sym };
}

class Out {
  buf: Uint8Array; n = 0; private limit: number;
  constructor(limit: number, hint: number) { this.limit = limit; this.buf = new Uint8Array(Math.max(1024, Math.min(hint, limit))); }
  private grow(need: number) {
    if (need > this.limit) throw new Error(`inflate: output exceeds the ${this.limit}-byte limit`);
    let cap = this.buf.length; while (cap < need) cap *= 2;
    if (cap > this.limit) cap = Math.max(need, this.limit);
    const b = new Uint8Array(cap); b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
  push(v: number) { if (this.n >= this.buf.length) this.grow(this.n + 1); this.buf[this.n++] = v; }
  copy(dist: number, len: number) {
    if (dist > this.n) throw new Error("inflate: distance too far back");
    if (this.n + len > this.buf.length) this.grow(this.n + len);
    const b = this.buf; let o = this.n, s = o - dist;
    for (let i = 0; i < len; i++) b[o++] = b[s++];
    this.n = o;
  }
  bytes(src: Uint8Array) { if (this.n + src.length > this.buf.length) this.grow(this.n + src.length); this.buf.set(src, this.n); this.n += src.length; }
}

/**
 * Inflate raw DEFLATE (`deflate64 = false`) or Deflate64 data. `limit` bounds the output size; `expect` (optional)
 * pre-sizes the buffer. Returns the decoded bytes and how many input bytes were consumed.
 */
export function inflateRawSync(src: Bytes, opts: { deflate64?: boolean; limit?: number; expect?: number } = {}): { data: Bytes; used: number } {
  const d64 = !!opts.deflate64, limit = opts.limit ?? Infinity;
  const out = new Out(limit, opts.expect ?? src.length * 4);
  let pos = 0, bitbuf = 0, bitcnt = 0;
  const need = (n: number) => {
    while (bitcnt < n) {
      if (pos >= src.length) throw new Error("inflate: unexpected end of data");
      bitbuf |= src[pos++] << bitcnt; bitcnt += 8;
    }
  };
  const bits = (n: number) => { if (!n) return 0; need(n); const v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v; };
  const decode = (h: Huff) => {
    // bit-by-bit canonical decode (RFC 1951: codes are packed starting with the most significant bit)
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("inflate: invalid Huffman code");
  };
  const lbase = LBASE.slice(), lext = LEXT.slice();
  if (d64) { lbase[28] = 3; lext[28] = 16; }
  const maxDist = d64 ? 65536 : 32768;
  const ndist = d64 ? 32 : 30;
  let fixedL: Huff | null = null, fixedD: Huff | null = null;
  const codes = (lh: Huff, dh: Huff) => {
    for (;;) {
      const s = decode(lh);
      if (s < 256) out.push(s);
      else if (s === 256) return;
      else {
        const li = s - 257; if (li >= 29) throw new Error("inflate: bad length symbol");
        const len = lbase[li] + bits(lext[li]);
        const ds = decode(dh); if (ds >= ndist) throw new Error("inflate: bad distance symbol");
        const dist = DBASE[ds] + bits(DEXT[ds]);
        if (dist > maxDist) throw new Error("inflate: distance beyond the window");
        out.copy(dist, len);
      }
    }
  };
  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0; bitcnt = 0; // stored: discard the rest of the current byte
      if (pos + 4 > src.length) throw new Error("inflate: truncated stored block");
      const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8); pos += 4;
      if (len !== (~nlen & 0xffff)) throw new Error("inflate: stored block length check failed");
      if (pos + len > src.length) throw new Error("inflate: truncated stored block");
      out.bytes(src.subarray(pos, pos + len)); pos += len;
    } else if (type === 1) {
      if (!fixedL) {
        const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedL = build(l, 288); fixedD = build(new Uint8Array(32).fill(5), 32);
      }
      codes(fixedL, fixedD!);
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      if (hlit > 286 || hdist > (d64 ? 32 : 30)) throw new Error("inflate: bad code counts");
      const cl = new Uint8Array(19); for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
      const ch = build(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist; ) {
        const sym = decode(ch);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep = 0, val = 0;
          if (sym === 16) { if (!i) throw new Error("inflate: repeat with no previous length"); val = lens[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > hlit + hdist) throw new Error("inflate: too many code lengths");
          while (rep--) lens[i++] = val;
        }
      }
      if (!lens[256]) throw new Error("inflate: no end-of-block code");
      codes(build(lens.subarray(0, hlit), hlit), build(lens.subarray(hlit), hdist));
    } else throw new Error("inflate: invalid block type 3");
  } while (!last);
  return { data: out.buf.slice(0, out.n), used: pos };
}
