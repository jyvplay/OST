/**
 * TT41 test-only DEFLATE (RFC 1951) decoder that AUDITS a stream: besides inflating it records every back-reference
 * distance, so a test can prove what window a decompressor needs. Written for the tests from the RFC text; never
 * shipped. Decodes permessage-deflate (RFC 7692) message streams: each message is a run of non-final blocks ended by
 * a sync flush; the history (the LZ77 window) is kept across messages unless reset.
 */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** canonical Huffman code (RFC 1951 §3.2.2) → lookup keyed by (length, code) */
function table(lengths: number[]): Map<number, number> {
  const count = new Array(16).fill(0);
  for (const l of lengths) if (l) count[l]++;
  const next = new Array(16).fill(0);
  let code = 0;
  for (let b = 1; b < 16; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  const m = new Map<number, number>();
  lengths.forEach((l, sym) => { if (l) { m.set((l << 16) | next[l], sym); next[l]++; } });
  return m;
}
const FIXED_L = table([...new Array(144).fill(8), ...new Array(112).fill(9), ...new Array(24).fill(7), ...new Array(8).fill(8)]);
const FIXED_D = table(new Array(30).fill(5));

export interface AuditStats { maxDistance: number; matches: number; literals: number; blocks: { stored: number; fixed: number; dynamic: number } }

export class DeflateAuditor {
  private hist: number[] = [];
  readonly stats: AuditStats = { maxDistance: 0, matches: 0, literals: 0, blocks: { stored: 0, fixed: 0, dynamic: 0 } };
  /** the window this auditor allows; a reference farther back throws (Infinity = only record) */
  readonly limit: number;
  constructor(limit = Infinity) { this.limit = limit; }
  reset(): void { this.hist = []; }

  /** one permessage-deflate message payload (the 00 00 ff ff tail already removed, as on the wire) */
  message(payload: Uint8Array): Buffer {
    const data = Buffer.concat([Buffer.from(payload), Buffer.from([0, 0, 0xff, 0xff])]);
    let pos = 0, bit = 0;
    const need = () => { if (pos >= data.length) throw new Error("deflate-audit: input ended inside a block"); };
    const bits = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++) { need(); v |= ((data[pos] >> bit) & 1) << i; if (++bit === 8) { bit = 0; pos++; } }
      return v;
    };
    const sym = (t: Map<number, number>) => {
      let code = 0;
      for (let len = 1; len < 16; len++) {
        need(); code = (code << 1) | ((data[pos] >> bit) & 1); if (++bit === 8) { bit = 0; pos++; }
        const s = t.get((len << 16) | code);
        if (s !== undefined) return s;
      }
      throw new Error("deflate-audit: invalid Huffman code");
    };
    const start = this.hist.length;
    for (;;) {
      if (pos >= data.length || (pos === data.length - 1 && bit > 0 && (data[pos] >> bit) === 0)) break; // only padding left
      const final = bits(1), type = bits(2);
      if (type === 0) {
        this.stats.blocks.stored++;
        if (bit) { bit = 0; pos++; }
        if (pos + 4 > data.length) throw new Error("deflate-audit: truncated stored header");
        const len = data[pos] | (data[pos + 1] << 8), nlen = data[pos + 2] | (data[pos + 3] << 8);
        if ((len ^ 0xffff) !== nlen) throw new Error("deflate-audit: stored LEN/NLEN mismatch");
        pos += 4;
        if (pos + len > data.length) throw new Error("deflate-audit: truncated stored block");
        for (let i = 0; i < len; i++) { this.hist.push(data[pos + i]); this.stats.literals++; }
        pos += len;
      } else if (type === 1 || type === 2) {
        let lt = FIXED_L, dt = FIXED_D;
        if (type === 2) {
          this.stats.blocks.dynamic++;
          const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          const cl = new Array(19).fill(0);
          for (let i = 0; i < hclen; i++) cl[ORDER[i]] = bits(3);
          const ct = table(cl), lens: number[] = [];
          while (lens.length < hlit + hdist) {
            const s = sym(ct);
            if (s < 16) lens.push(s);
            else if (s === 16) { if (!lens.length) throw new Error("deflate-audit: repeat with no previous length"); const p = lens[lens.length - 1]; for (let r = 3 + bits(2); r > 0; r--) lens.push(p); }
            else if (s === 17) for (let r = 3 + bits(3); r > 0; r--) lens.push(0);
            else for (let r = 11 + bits(7); r > 0; r--) lens.push(0);
          }
          if (lens.length !== hlit + hdist) throw new Error("deflate-audit: code lengths overrun");
          lt = table(lens.slice(0, hlit)); dt = table(lens.slice(hlit));
        } else this.stats.blocks.fixed++;
        for (;;) {
          const s = sym(lt);
          if (s < 256) { this.hist.push(s); this.stats.literals++; continue; }
          if (s === 256) break;
          const li = s - 257;
          if (li >= 29) throw new Error("deflate-audit: bad length symbol");
          const len = LBASE[li] + bits(LEXT[li]);
          const di = sym(dt);
          if (di >= 30) throw new Error("deflate-audit: bad distance symbol");
          const dist = DBASE[di] + bits(DEXT[di]);
          if (dist > this.hist.length) throw new Error(`deflate-audit: distance ${dist} before the start of the stream`);
          if (dist > this.limit) throw new Error(`deflate-audit: distance ${dist} exceeds the ${this.limit}-byte window`);
          if (dist > this.stats.maxDistance) this.stats.maxDistance = dist;
          this.stats.matches++;
          for (let i = 0; i < len; i++) this.hist.push(this.hist[this.hist.length - dist]);
        }
      } else throw new Error("deflate-audit: reserved block type 3");
      if (final) throw new Error("deflate-audit: BFINAL set inside a permessage-deflate stream");
    }
    const out = Buffer.from(this.hist.slice(start));
    if (this.hist.length > 1 << 17) this.hist = this.hist.slice(-(1 << 16)); // keep the window bounded (≤ 32 KiB is needed)
    return out;
  }
}
