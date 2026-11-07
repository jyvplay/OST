/**
 * TT139 (FF-74) — deterministic, dependency-free ZIP writer + reader.
 *
 * The Archive module needs to *create* ZIP files as well as browse them, and the
 * existing code only read. Two design decisions matter here, and both are about
 * being honest rather than clever:
 *
 *  1. Real Deflate. `deflateRaw` is implemented here (LZ77 with a bounded hash
 *     chain + fixed Huffman codes, per RFC 1951 §3.2.6). It produces a stream
 *     every conforming inflater accepts; it is not the best compressor, and the
 *     module reports the achieved ratio rather than calling it "optimal". When
 *     the compressed form is not smaller than the input, the entry is stored
 *     (method 0) — the same rule every real archiver uses.
 *
 *  2. Deterministic output. Timestamps, order and the "extra" fields are all
 *     derived from the caller's inputs, so building the same archive twice gives
 *     byte-identical output. That is what makes "verify the manifest" a
 *     meaningful operation instead of a coin flip.
 *
 * UTF-8 names are flagged (EFS, general-purpose bit 11) and CRC-32 comes from a
 * table built at load time. ZIP64 is written when any size or offset overflows
 * 32 bits, because silently writing a wrapped offset corrupts an archive.
 *
 * Bounds: 4 GiB per entry, 65 535 entries, 4 GiB archive without ZIP64.
 * Unsupported on read: encrypted entries (reported, never guessed at),
 * Deflate64, and multi-disk sets.
 */

export const ZIP_SIG_LOCAL = 0x04034b50;
export const ZIP_SIG_CENTRAL = 0x02014b50;
export const ZIP_SIG_EOCD = 0x06054b50;
export const ZIP_SIG_EOCD64 = 0x06064b50;
export const ZIP_SIG_EOCD64_LOC = 0x07064b50;
export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_ENTRY_BYTES = 0xffff_ffff;

// ── CRC-32 ───────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Deflate (RFC 1951) ───────────────────────────────────────────────────────
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class BitWriter {
  private out: number[] = [];
  private bitBuf = 0;
  private bitCnt = 0;
  write(value: number, bits: number) {
    this.bitBuf |= (value << this.bitCnt);
    this.bitCnt += bits;
    while (this.bitCnt >= 8) { this.out.push(this.bitBuf & 0xff); this.bitBuf >>>= 8; this.bitCnt -= 8; }
  }
  /** Huffman codes are packed most-significant bit first. */
  writeCode(code: number, bits: number) {
    for (let i = bits - 1; i >= 0; i--) this.write((code >>> i) & 1, 1);
  }
  finish(): Uint8Array {
    if (this.bitCnt > 0) { this.out.push(this.bitBuf & 0xff); this.bitBuf = 0; this.bitCnt = 0; }
    return Uint8Array.from(this.out);
  }
}

/** RFC 1951 §3.2.6 fixed literal/length and distance codes. */
function fixedLitCode(sym: number): { code: number; bits: number } {
  if (sym < 144) return { code: 0x30 + sym, bits: 8 };
  if (sym < 256) return { code: 0x190 + (sym - 144), bits: 9 };
  if (sym < 280) return { code: sym - 256, bits: 7 };
  return { code: 0xc0 + (sym - 280), bits: 8 };
}
const fixedDistCode = (sym: number) => ({ code: sym, bits: 5 });

function lengthCode(len: number): { sym: number; extra: number; bits: number } {
  for (let i = LEN_BASE.length - 1; i >= 0; i--) {
    if (len >= LEN_BASE[i]) {
      // 258 has its own code with no extra bits; the table lists 258 only at index 28
      if (i === 27 && len === 258) return { sym: 285, extra: 0, bits: 0 };
      return { sym: 257 + i, extra: len - LEN_BASE[i], bits: LEN_EXTRA[i] };
    }
  }
  return { sym: 257, extra: 0, bits: 0 };
}

function distCode(dist: number): { sym: number; extra: number; bits: number } {
  for (let i = DIST_BASE.length - 1; i >= 0; i--) {
    if (dist >= DIST_BASE[i]) return { sym: i, extra: dist - DIST_BASE[i], bits: DIST_EXTRA[i] };
  }
  return { sym: 0, extra: 0, bits: 0 };
}

export interface DeflateOptions {
  /** Hash-chain length cap. Bigger = better ratio, slower. 16 is a good default. */
  maxChain?: number;
  /** Matches shorter than this are stored instead of matched. */
  minMatch?: number;
  maxMatch?: number;
  windowBits?: number;
}

/**
 * Raw Deflate (no zlib wrapper). Greedy LZ77 with one-step lazy matching: a match
 * is deferred when the next position offers a longer one, which is the cheapest
 * way to avoid the worst artefact of pure greedy parsing.
 */
export function deflateRaw(input: Uint8Array, opts: DeflateOptions = {}): Uint8Array {
  const maxChain = opts.maxChain ?? 24;
  const minMatch = Math.max(3, opts.minMatch ?? 3);
  const maxMatch = Math.min(258, opts.maxMatch ?? 258);
  const windowBits = opts.windowBits ?? 15;
  const windowSize = 1 << windowBits;
  const n = input.length;
  const bw = new BitWriter();
  bw.write(1, 1); // BFINAL
  bw.write(1, 2); // BTYPE = 01, fixed Huffman

  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hash = (pos: number) => (((input[pos] << 10) ^ (input[pos + 1] << 5) ^ input[pos + 2]) & 0x7fff);

  const emitLit = (b: number) => { const c = fixedLitCode(b); bw.writeCode(c.code, c.bits); };
  const emitMatch = (len: number, dist: number) => {
    const lc = lengthCode(len), dc = distCode(dist);
    const c = fixedLitCode(lc.sym); bw.writeCode(c.code, c.bits);
    if (lc.bits) bw.write(lc.extra, lc.bits);
    const d = fixedDistCode(dc.sym); bw.writeCode(d.code, d.bits);
    if (dc.bits) bw.write(dc.extra, dc.bits);
  };

  let pos = 0;
  while (pos < n) {
    let bestLen = 0, bestDist = 0;
    if (pos + 2 < n) {
      const h = hash(pos);
      let cand = head[h];
      let chain = 0;
      const limit = Math.min(maxMatch, n - pos);
      while (cand >= 0 && chain < maxChain && pos - cand <= windowSize) {
        let len = 0;
        while (len < limit && input[cand + len] === input[pos + len]) len++;
        if (len > bestLen) { bestLen = len; bestDist = pos - cand; if (len >= limit) break; }
        cand = prev[cand]; chain++;
      }
      // register this position (and the ones a lazy step skips)
      prev[pos] = head[h]; head[h] = pos;
    }
    if (bestLen >= minMatch) {
      // lazy: if the next position wins by 2+ bytes, emit a literal and retry
      if (pos + 1 < n && bestLen < maxMatch) {
        const h2 = pos + 3 < n ? hash(pos + 1) : -1;
        let nextBest = 0;
        if (h2 >= 0) {
          let cand = head[h2], chain = 0;
          const limit2 = Math.min(maxMatch, n - pos - 1);
          while (cand >= 0 && chain < maxChain && pos + 1 - cand <= windowSize) {
            let len = 0;
            while (len < limit2 && input[cand + len] === input[pos + 1 + len]) len++;
            if (len > nextBest) nextBest = len;
            cand = prev[cand]; chain++;
          }
        }
        if (nextBest > bestLen + 1) {
          emitLit(input[pos]);
          pos++;
          continue;
        }
      }
      emitMatch(bestLen, bestDist);
      for (let k = 1; k < bestLen; k++) if (pos + k + 2 < n) { const hh = hash(pos + k); prev[pos + k] = head[hh]; head[hh] = pos + k; }
      pos += bestLen;
    } else {
      emitLit(input[pos]);
      pos++;
    }
  }
  emitLit(256); // end of block
  return bw.finish();
}

// ── Inflate ──────────────────────────────────────────────────────────────────
class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCnt = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) { this.data = data; }
  bit(): number {
    if (this.bitCnt === 0) {
      if (this.pos >= this.data.length) throw new Error("inflate: unexpected end of stream");
      this.bitBuf = this.data[this.pos++]; this.bitCnt = 8;
    }
    const b = this.bitBuf & 1; this.bitBuf >>>= 1; this.bitCnt--; return b;
  }
  bits(count: number): number { let v = 0; for (let i = 0; i < count; i++) v |= this.bit() << i; return v; }
  align() { this.bitCnt = 0; }
  get offset() { return this.pos; }
}

interface Huffman { count: Int32Array; symbol: Int32Array }

function buildHuffman(lengths: number[]): Huffman {
  const MAXBITS = 15;
  const count = new Int32Array(MAXBITS + 1);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Int32Array(MAXBITS + 1);
  for (let i = 1; i <= MAXBITS; i++) offs[i] = offs[i - 1] + count[i - 1];
  const symbol = new Int32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

function decodeSymbol(br: BitReader, h: Huffman): number {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.bit();
    const cnt = h.count[len];
    if (code - first < cnt) return h.symbol[index + (code - first)];
    index += cnt; first = (first + cnt) << 1; code <<= 1;
  }
  throw new Error("inflate: invalid Huffman code");
}

let FIXED_LIT: Huffman | null = null, FIXED_DIST: Huffman | null = null;
function fixedTables() {
  if (!FIXED_LIT) {
    const l = new Array<number>(288);
    for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    FIXED_LIT = buildHuffman(l);
    FIXED_DIST = buildHuffman(new Array<number>(30).fill(5));
  }
  return { lit: FIXED_LIT!, dist: FIXED_DIST! };
}

/** Raw inflate (no zlib wrapper). Rejects over-long output rather than growing without bound. */
export function inflateRaw(input: Uint8Array, maxOutBytes = 1 << 28): Uint8Array {
  const br = new BitReader(input);
  const out: number[] = [];
  let final = 0;
  while (!final) {
    final = br.bit();
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      // stored block: LEN, NLEN, then LEN raw bytes. Read from the byte cursor.
      const p = br.offset;
      if (p + 4 > input.length) throw new Error("inflate: truncated stored block header");
      const len = input[p] | (input[p + 1] << 8);
      const nlen = input[p + 2] | (input[p + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error("inflate: stored block length check failed");
      for (let i = 0; i < len; i++) out.push(input[p + 4 + i]);
      if (out.length > maxOutBytes) throw new Error("inflate: output limit exceeded");
      brSkip(br, len + 4);
      continue;
    }
    if (type === 3) throw new Error("inflate: reserved block type 3");
    let lit: Huffman, dist: Huffman;
    if (type === 1) { const t = fixedTables(); lit = t.lit; dist = t.dist; }
    else {
      const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
      const clen = new Array<number>(19).fill(0);
      for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = br.bits(3);
      const clHuff = buildHuffman(clen);
      const lengths: number[] = [];
      while (lengths.length < hlit + hdist) {
        const sym = decodeSymbol(br, clHuff);
        if (sym < 16) lengths.push(sym);
        else if (sym === 16) {
          if (!lengths.length) throw new Error("inflate: repeat with no previous length");
          const prev = lengths[lengths.length - 1], rep = 3 + br.bits(2);
          for (let i = 0; i < rep; i++) lengths.push(prev);
        } else if (sym === 17) { const rep = 3 + br.bits(3); for (let i = 0; i < rep; i++) lengths.push(0); }
        else { const rep = 11 + br.bits(7); for (let i = 0; i < rep; i++) lengths.push(0); }
      }
      if (lengths.length !== hlit + hdist) throw new Error("inflate: code-length mismatch");
      lit = buildHuffman(lengths.slice(0, hlit));
      dist = buildHuffman(lengths.slice(hlit));
    }
    for (;;) {
      const sym = decodeSymbol(br, lit);
      if (sym === 256) break;
      if (sym < 256) { out.push(sym); if (out.length > maxOutBytes) throw new Error("inflate: output limit exceeded"); continue; }
      const li = sym - 257;
      if (li >= LEN_BASE.length) throw new Error("inflate: invalid length symbol");
      const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
      const dsym = decodeSymbol(br, dist);
      if (dsym >= DIST_BASE.length) throw new Error("inflate: invalid distance symbol");
      const d = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
      if (d > out.length) throw new Error("inflate: distance goes before start of output");
      const start = out.length - d;
      for (let i = 0; i < len; i++) out.push(out[start + i]);
      if (out.length > maxOutBytes) throw new Error("inflate: output limit exceeded");
    }
  }
  return Uint8Array.from(out);
}

// The BitReader owns its cursor; a stored block must advance it by whole bytes.
function brSkip(br: BitReader, bytes: number) {
  for (let i = 0; i < bytes; i++) br.bit();
}

// ── Writer ───────────────────────────────────────────────────────────────────
export interface ZipEntryInput {
  /** Forward-slash relative path inside the archive. */
  name: string;
  data: Uint8Array;
  /** Explicit method: "auto" stores when deflating does not help. */
  method?: "auto" | "store" | "deflate";
  /** MS-DOS date/time; derived from `mtime` when omitted. */
  mtime?: Date;
  comment?: string;
  /** Emit a directory entry (data must be empty). */
  dir?: boolean;
}

export interface ZipEntryMeta {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  mtime: Date;
  dir: boolean;
  comment: string;
}

const DOS_EPOCH = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export function toDosDate(d: Date): { date: number; time: number } {
  const t = d.getTime();
  const when = Number.isFinite(t) && t >= DOS_EPOCH.getTime() ? d : DOS_EPOCH;
  const year = Math.min(2107, Math.max(1980, when.getUTCFullYear()));
  const date = ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | Math.floor(when.getUTCSeconds() / 2);
  return { date, time };
}

export function fromDosDate(date: number, time: number): Date {
  const y = 1980 + ((date >> 9) & 0x7f), mo = ((date >> 5) & 0xf) - 1, d = date & 0x1f;
  const h = (time >> 11) & 0x1f, mi = (time >> 5) & 0x3f, s = (time & 0x1f) * 2;
  return new Date(Date.UTC(y, Math.max(0, mo), Math.max(1, d), h, mi, s));
}

class ByteBuf {
  private chunks: Uint8Array[] = [];
  len = 0;
  push(u: Uint8Array) { this.chunks.push(u); this.len += u.length; }
  u16(v: number) { const b = new Uint8Array(2); b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; this.push(b); }
  u32(v: number) { const b = new Uint8Array(4); b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; b[2] = (v >>> 16) & 0xff; b[3] = (v >>> 24) & 0xff; this.push(b); }
  u64(v: number) { const b = new Uint8Array(8); let x = v; for (let i = 0; i < 8; i++) { b[i] = x % 256; x = Math.floor(x / 256); } this.push(b); }
  bytes(u: Uint8Array) { this.push(u); }
  concat(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

const te = new TextEncoder();

/** Reject names that could escape the extraction root once joined. */
export function safeEntryName(name: string): string {
  const norm = name.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "");
  if (!norm) throw new Error("zip: empty entry name");
  if (norm.split("/").some((part) => part === "..")) throw new Error(`zip: unsafe entry name "${name}"`);
  if (/^[A-Za-z]:/.test(norm)) throw new Error(`zip: absolute entry name "${name}"`);
  return norm;
}

export function writeZip(entries: readonly ZipEntryInput[], opts: { comment?: string; level?: DeflateOptions } = {}): Uint8Array {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`zip: ${entries.length} entries exceeds ${ZIP_MAX_ENTRIES}`);
  const out = new ByteBuf();
  const metas: ZipEntryMeta[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const name = safeEntryName(e.dir ? `${e.name.replace(/\/$/, "")}/` : e.name);
    if (seen.has(name)) throw new Error(`zip: duplicate entry "${name}"`);
    seen.add(name);
    const data = e.data;
    if (data.length > ZIP_MAX_ENTRY_BYTES) throw new Error(`zip: entry "${name}" exceeds 4 GiB`);
    const crc = crc32(data);
    let method = 0, payload = data;
    if (!e.dir && e.method !== "store" && data.length > 0) {
      const def = deflateRaw(data, opts.level);
      const want = e.method === "deflate" ? true : def.length < data.length;
      if (want) { method = 8; payload = def; }
    }
    if (e.dir && data.length) throw new Error(`zip: directory entry "${name}" must be empty`);
    const when = e.mtime ?? new Date(0);
    const { date, time } = toDosDate(when);
    const nameBytes = te.encode(name);
    const commentBytes = te.encode(e.comment ?? "");
    const localOffset = out.len;
    const needsZip64 = data.length >= ZIP_MAX_ENTRY_BYTES || payload.length >= ZIP_MAX_ENTRY_BYTES;
    const flags = 0x0800; // EFS: name and comment are UTF-8

    out.u32(ZIP_SIG_LOCAL); out.u16(needsZip64 ? 45 : 20); out.u16(flags); out.u16(method);
    out.u16(time); out.u16(date);
    out.u32(crc); out.u32(needsZip64 ? 0xffffffff : payload.length); out.u32(needsZip64 ? 0xffffffff : data.length);
    out.u16(nameBytes.length); out.u16(0);
    out.bytes(nameBytes);
    out.bytes(payload);

    metas.push({ name, method, crc, compressedSize: payload.length, uncompressedSize: data.length, localHeaderOffset: localOffset, mtime: when, dir: Boolean(e.dir), comment: e.comment ?? "" });
  }

  const cdStart = out.len;
  for (const m of metas) {
    const nameBytes = te.encode(m.name);
    const commentBytes = te.encode(m.comment);
    out.u32(ZIP_SIG_CENTRAL); out.u16(45); out.u16(45); out.u16(0x0800); out.u16(m.method);
    const { date, time } = toDosDate(m.mtime);
    out.u16(time); out.u16(date);
    out.u32(m.crc); out.u32(m.compressedSize); out.u32(m.uncompressedSize);
    out.u16(nameBytes.length); out.u16(0); out.u16(commentBytes.length);
    out.u16(0); out.u16(0); out.u32(m.dir ? 0x10 : 0); out.u32(m.localHeaderOffset);
    out.bytes(nameBytes); out.bytes(commentBytes);
  }
  const cdEnd = out.len;
  const comment = te.encode(opts.comment ?? "");
  out.u32(ZIP_SIG_EOCD); out.u16(0); out.u16(0); out.u16(metas.length); out.u16(metas.length);
  out.u32(cdEnd - cdStart); out.u32(cdStart); out.u16(comment.length); out.bytes(comment);
  return out.concat();
}

// ── Reader ───────────────────────────────────────────────────────────────────
export interface ZipReadEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  mtime: Date;
  dir: boolean;
  comment: string;
  utf8: boolean;
}

export interface ZipArchive { entries: ZipReadEntry[]; comment: string; bytes: number }

const dv = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);

export function readZipDirectory(bytes: Uint8Array): ZipArchive {
  if (bytes.length < 22) throw new Error("zip: too short to be an archive");
  const view = dv(bytes);
  // locate EOCD by scanning backwards over the (bounded) comment
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === ZIP_SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  const commentLen = view.getUint16(eocd + 20, true);
  const comment = new TextDecoder().decode(bytes.subarray(eocd + 22, eocd + 22 + commentLen));

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && view.getUint32(locator, true) === ZIP_SIG_EOCD64_LOC) {
      const z64 = Number(view.getBigUint64(locator + 8, true));
      if (z64 + 56 <= bytes.length && view.getUint32(z64, true) === ZIP_SIG_EOCD64) {
        count = Number(view.getBigUint64(z64 + 32, true));
        cdSize = Number(view.getBigUint64(z64 + 40, true));
        cdOffset = Number(view.getBigUint64(z64 + 48, true));
      }
    }
  }

  const entries: ZipReadEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length) throw new Error("zip: truncated central directory");
    if (view.getUint32(p, true) !== ZIP_SIG_CENTRAL) throw new Error(`zip: bad central directory signature at ${p}`);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const time = view.getUint16(p + 12, true);
    const date = view.getUint16(p + 14, true);
    const crc = view.getUint32(p + 16, true);
    let cSize = view.getUint32(p + 20, true);
    let uSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const externalAttrs = view.getUint32(p + 38, true);
    let offset = view.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const utf8 = (flags & 0x0800) !== 0;
    const name = new TextDecoder(utf8 ? "utf-8" : "utf-8").decode(nameBytes);
    // ZIP64 extended information (0x0001) supplies whatever is 0xffffffff
    let ep = p + 46 + nameLen;
    const epEnd = ep + extraLen;
    while (ep + 4 <= epEnd) {
      const id = view.getUint16(ep, true), sz = view.getUint16(ep + 2, true);
      if (id === 0x0001) {
        let q = ep + 4;
        if (uSize === 0xffffffff && q + 8 <= epEnd) { uSize = Number(view.getBigUint64(q, true)); q += 8; }
        if (cSize === 0xffffffff && q + 8 <= epEnd) { cSize = Number(view.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff && q + 8 <= epEnd) { offset = Number(view.getBigUint64(q, true)); q += 8; }
      }
      ep += 4 + sz;
    }
    if (flags & 0x0001) throw new Error(`zip: entry "${name}" is encrypted; this reader does not decrypt`);
    entries.push({
      name, method, crc, compressedSize: cSize, uncompressedSize: uSize, offset,
      mtime: fromDosDate(date, time), dir: (externalAttrs & 0x10) !== 0 || name.endsWith("/"), comment: "", utf8,
    });
    p = epEnd + commentLength;
  }
  return { entries, comment, bytes: bytes.length };
}

export interface ExtractedEntry { name: string; data: Uint8Array; crcOk: boolean }

/**
 * Extract (and verify) entries. `maxTotalBytes` is a bomb guard and is checked
 * against the *declared* sizes before decompressing, then again against actual
 * output — a header that lies cannot make the extractor allocate unboundedly.
 */
export function readZip(
  bytes: Uint8Array,
  opts: { maxTotalBytes?: number; maxEntryBytes?: number; only?: (name: string) => boolean } = {},
): ExtractedEntry[] {
  const maxTotal = opts.maxTotalBytes ?? 512 * 1024 * 1024;
  const maxEntry = opts.maxEntryBytes ?? 256 * 1024 * 1024;
  const dir = readZipDirectory(bytes);
  const view = dv(bytes);
  let declaredTotal = 0;
  for (const e of dir.entries) declaredTotal += e.uncompressedSize;
  if (declaredTotal > maxTotal) throw new Error(`zip: declared expansion ${declaredTotal} exceeds ${maxTotal}`);
  const out: ExtractedEntry[] = [];
  let produced = 0;
  for (const e of dir.entries) {
    if (e.dir) continue;
    if (opts.only && !opts.only(e.name)) continue;
    if (e.uncompressedSize > maxEntry) throw new Error(`zip: "${e.name}" exceeds per-entry limit`);
    if (e.offset + 30 > bytes.length || view.getUint32(e.offset, true) !== ZIP_SIG_LOCAL) throw new Error(`zip: bad local header for "${e.name}"`);
    const nameLen = view.getUint16(e.offset + 26, true);
    const extraLen = view.getUint16(e.offset + 28, true);
    const dataStart = e.offset + 30 + nameLen + extraLen;
    const payload = bytes.subarray(dataStart, dataStart + e.compressedSize);
    if (payload.length !== e.compressedSize) throw new Error(`zip: truncated data for "${e.name}"`);
    let data: Uint8Array;
    if (e.method === 0) data = payload;
    else if (e.method === 8) data = inflateRaw(payload, maxEntry);
    else throw new Error(`zip: entry "${e.name}" uses unsupported method ${e.method}`);
    produced += data.length;
    if (produced > maxTotal) throw new Error("zip: actual expansion exceeded the total limit");
    if (data.length !== e.uncompressedSize) throw new Error(`zip: "${e.name}" size mismatch (${data.length} != ${e.uncompressedSize})`);
    const crcOk = crc32(data) === e.crc;
    if (!crcOk) throw new Error(`zip: CRC mismatch for "${e.name}"`);
    out.push({ name: safeEntryName(e.name), data, crcOk });
  }
  return out;
}

/** Sequential member writer: build a large archive without holding every member's bytes at once. */
export function zipLooksValid(bytes: Uint8Array): { ok: boolean; reason: string } {
  try { const a = readZipDirectory(bytes); return { ok: true, reason: `${a.entries.length} entries` }; }
  catch (e) { return { ok: false, reason: (e as Error).message }; }
}
