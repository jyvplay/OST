/**
 * TT79 — isomorphic ZIP engine (browser + Node), written from PKWARE APPNOTE.TXT 6.3.x.
 *
 * Reading: EOCD (with archive comment) → ZIP64 end-of-central-directory locator/record (§4.3.14–15) → central
 * directory; ZIP64 extended information extra field 0x0001 (§4.5.3); names decoded per general-purpose bit 11
 * (UTF-8) or IBM code page 437 (Appendix D), with the Info-ZIP Unicode Path extra 0x7075 honoured only when its CRC
 * matches the header name; Info-ZIP extended timestamp 0x5455 and NTFS 0x000a times; Unix modes from the external
 * attributes (symlinks are listed but never extracted); data descriptors (bit 3, sizes taken from the central
 * directory); self-extractor / prepended-data offset correction; multi-volume archives refused.
 * Methods: 0 stored, 8 deflate (native DecompressionStream when present, else the own inflater), 9 Deflate64,
 * 12 bzip2, 14 LZMA — the last three first-party (inflate.ts, bunzip.ts, unlzma.ts).
 * Encryption: traditional PKWARE (ZipCrypto) and WinZip AES AE-1/AE-2 (128/192/256), read and write (zipcrypt.ts).
 * Guards: entry count, declared total, per-entry size, compression ratio, decoder output capped at the declared
 * size, overlapping local entries (the non-recursive "overlapped files" bomb), local/central name mismatch,
 * duplicate names, zip-slip (absolute, drive-letter, "..", NUL), CRC-32 / AES authentication on every read.
 * Writing: UTF-8 names, DOS + UTC timestamps, Unix modes, store/deflate, ZIP64 when needed (or forced), optional
 * WinZip AES-256 (AE-2) or ZipCrypto; editing copies untouched entries' raw bytes (no recompression, no password).
 */
import { inflateRawSync, type Bytes } from "./inflate";
import { bunzip2Sync } from "./bunzip";
import { unlzmaZipSync } from "./unlzma";
import { crc32, zipCryptoDecrypt, zipCryptoEncrypt, winzipAesDecrypt, winzipAesEncrypt, PasswordError } from "./zipcrypt";

export { PasswordError, crc32 };

const SIG_LOC = 0x04034b50, SIG_CEN = 0x02014b50, SIG_EOCD = 0x06054b50, SIG_Z64EOCD = 0x06064b50, SIG_Z64LOC = 0x07064b50, SIG_DD = 0x08074b50;

export const METHOD_NAMES: Record<number, string> = { 0: "Stored", 8: "Deflate", 9: "Deflate64", 12: "BZip2", 14: "LZMA", 93: "Zstandard", 95: "XZ", 98: "PPMd", 99: "AES (wrapper)" };
export const SUPPORTED_METHODS = new Set([0, 8, 9, 12, 14]);

export interface ArchiveLimits { maxEntries: number; maxTotalBytes: number; maxEntryBytes: number; maxRatio: number }
/** FF-12 / FF-69 guards. Ratio applies only to entries above 1 MiB (small highly-compressible files are normal). */
export const DEFAULT_LIMITS: ArchiveLimits = { maxEntries: 100_000, maxTotalBytes: 4 * 1024 ** 3, maxEntryBytes: 1024 ** 3, maxRatio: 1100 };

export interface ArchiveEntry {
  index: number;
  name: string;              // decoded, "/"-separated
  rawName: Bytes;
  nameEncoding: "utf8" | "cp437" | "unicode-path" | "utf8-unflagged";
  safePath: string | null;   // null = refused by the zip-slip guard
  dir: boolean;
  symlink: boolean;
  method: number;            // real compression method (AES entries: from the 0x9901 extra)
  methodName: string;
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  localOffset: number;
  dataOffset: number;        // first byte of the (possibly encrypted) data
  mtime: Date;
  unixMode: number | null;
  encryption: "none" | "zipcrypto" | "aes" | "strong";
  aesStrength?: 1 | 2 | 3;
  aesVersion?: 1 | 2;
  comment: string;
  madeBy: number;
  versionNeeded: number;
  externalAttr: number;
  zip64: boolean;
  dosTime: number;
  extraCentral: Bytes;
  duplicate: boolean;
}
export interface Archive { entries: ArchiveEntry[]; comment: string; zip64: boolean; prefix: number; issues: string[] }

/* ------------------------------------------------------------------ helpers */
const u16 = (b: Bytes, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Bytes, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Bytes, o: number) => { const lo = u32(b, o), hi = u32(b, o + 4); if (hi >= 0x200000) throw new Error("zip: 64-bit value beyond 2^53"); return hi * 0x100000000 + lo; };
const td = new TextDecoder("utf-8", { fatal: false }), te = new TextEncoder();
const CP437_HI = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
export function decodeCp437(b: Bytes): string { let s = ""; for (const c of b) s += c < 128 ? String.fromCharCode(c) : CP437_HI[c - 128]; return s; }
const isAscii = (s: string) => { for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 126 || s.charCodeAt(i) < 32) return false; return true; };

/** FF-12 zip-slip: the relative path an entry may be extracted to, or null if it must be refused. */
export function safeEntryPath(name: string): string | null {
  if (!name || name.includes("\0")) return null;
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split("/").filter((p, i, a) => p !== "" || i === a.length - 1);
  const out: string[] = [];
  for (const p of parts) { if (p === "..") return null; if (p === "." || p === "") continue; out.push(p); }
  if (!out.length) return null;
  return out.join("/") + (n.endsWith("/") ? "/" : "");
}

function dosToDate(time: number, date: number): Date {
  return new Date(((date >> 9) & 0x7f) + 1980, Math.max(0, ((date >> 5) & 0xf) - 1), date & 0x1f || 1, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}
function dateToDos(d: Date): { time: number; date: number } {
  const y = d.getFullYear();
  if (y < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.min(y, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function* extras(b: Bytes): Generator<[number, Bytes]> {
  let p = 0;
  while (p + 4 <= b.length) { const id = u16(b, p), n = u16(b, p + 2); if (p + 4 + n > b.length) return; yield [id, b.subarray(p + 4, p + 4 + n)]; p += 4 + n; }
}

/* ------------------------------------------------------------------ reading */
/**
 * Names without bit 11 are CP437 per APPNOTE Appendix D — but Unix/macOS zippers (Info-ZIP, Archive Utility) store
 * the local charset, which today is UTF-8, without setting the bit. "auto" (the default) therefore decodes an
 * unflagged name as UTF-8 only when the host is Unix (3) or OS X (19) AND the bytes are valid UTF-8 with non-ASCII
 * content (what Info-ZIP unzip does in a UTF-8 locale); everything else is CP437. The user can force either.
 */
export type NameMode = "auto" | "cp437" | "utf8";
const tdStrict = new TextDecoder("utf-8", { fatal: true });
function decodeName(raw: Bytes, flagged: boolean, host: number, mode: NameMode): { s: string; enc: ArchiveEntry["nameEncoding"] } {
  if (flagged) return { s: td.decode(raw), enc: "utf8" };
  if (mode === "utf8") return { s: td.decode(raw), enc: "utf8-unflagged" };
  if (mode === "auto" && (host === 3 || host === 19) && raw.some((v) => v > 127)) { try { return { s: tdStrict.decode(raw), enc: "utf8-unflagged" }; } catch { /* not UTF-8 → CP437 */ } }
  return { s: decodeCp437(raw), enc: "cp437" };
}

export function readArchive(buf: Bytes, limits: ArchiveLimits = DEFAULT_LIMITS, nameMode: NameMode = "auto"): Archive {
  const issues: string[] = [];
  if (buf.length < 22) throw new Error("not a zip archive (too short)");
  // EOCD: last signature whose comment length reaches the end exactly; else the last signature found
  let eocd = -1, loose = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (u32(buf, i) !== SIG_EOCD) continue;
    if (loose < 0) loose = i;
    if (i + 22 + u16(buf, i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) eocd = loose;
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");
  const disk = u16(buf, eocd + 4), cdDisk = u16(buf, eocd + 6);
  let count = u16(buf, eocd + 10), cdSize = u32(buf, eocd + 12), cdOff = u32(buf, eocd + 16);
  const commentLen = Math.min(u16(buf, eocd + 20), buf.length - eocd - 22);
  const commentBytes = buf.subarray(eocd + 22, eocd + 22 + commentLen);
  let zip64 = false, z64Pos = -1;
  if (eocd >= 20 && u32(buf, eocd - 20) === SIG_Z64LOC) {
    const totalDisks = u32(buf, eocd - 20 + 16);
    if (u32(buf, eocd - 20 + 4) !== 0 || totalDisks > 1) throw new Error("multi-volume (split) zip archives are not supported");
    z64Pos = u64(buf, eocd - 20 + 8);
    if (z64Pos + 56 > buf.length || u32(buf, z64Pos) !== SIG_Z64EOCD) {
      // prepended data shifts every offset: the ZIP64 record sits immediately before the locator
      const guess = eocd - 20 - 56;
      if (guess >= 0 && u32(buf, guess) === SIG_Z64EOCD) z64Pos = guess; else throw new Error("zip64: end-of-central-directory record not found");
    }
    if (u32(buf, z64Pos + 16) !== 0 || u32(buf, z64Pos + 20) !== 0) throw new Error("multi-volume (split) zip archives are not supported");
    count = u64(buf, z64Pos + 32); cdSize = u64(buf, z64Pos + 40); cdOff = u64(buf, z64Pos + 48);
    zip64 = true;
  } else if (disk !== 0 || cdDisk !== 0) throw new Error("multi-volume (split) zip archives are not supported");
  if (count > limits.maxEntries) throw new Error(`zip guard: ${count} entries exceed the ${limits.maxEntries}-entry limit`);
  // prepended data (self-extractors, polyglots): the directory ends where the EOCD/ZIP64 record begins
  const cdEnd = zip64 ? z64Pos : eocd;
  const prefix = cdEnd - cdSize - cdOff;
  if (prefix < 0) throw new Error("zip: central directory offsets point past the end-of-central-directory record");
  if (prefix > 0) issues.push(`${prefix} bytes of data precede the archive (self-extractor or prepended file); offsets corrected`);
  let p = cdOff + prefix;
  const entries: ArchiveEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || u32(buf, p) !== SIG_CEN) throw new Error(`zip: central directory entry ${i} is damaged`);
    const madeBy = u16(buf, p + 4), versionNeeded = u16(buf, p + 6), flags = u16(buf, p + 8);
    let method = u16(buf, p + 10); const dosTime = u16(buf, p + 12), dosDate = u16(buf, p + 14);
    const crc = u32(buf, p + 16); let csize = u32(buf, p + 20), usize = u32(buf, p + 24);
    const nl = u16(buf, p + 28), xl = u16(buf, p + 30), cl = u16(buf, p + 32);
    const diskStart = u16(buf, p + 34), externalAttr = u32(buf, p + 38);
    let localOffset = u32(buf, p + 42);
    if (p + 46 + nl + xl + cl > buf.length) throw new Error(`zip: central directory entry ${i} runs past the end`);
    const rawName = buf.subarray(p + 46, p + 46 + nl), extra = buf.subarray(p + 46 + nl, p + 46 + nl + xl);
    const commentRaw = buf.subarray(p + 46 + nl + xl, p + 46 + nl + xl + cl);
    const utf8 = !!(flags & 0x800);
    const dn = decodeName(rawName, utf8, madeBy >> 8, nameMode);
    let name = dn.s;
    let nameEncoding: ArchiveEntry["nameEncoding"] = dn.enc;
    let comment = decodeName(commentRaw, utf8, madeBy >> 8, nameMode).s;
    let mtime = dosToDate(dosTime, dosDate);
    let entryZip64 = false, encryption: ArchiveEntry["encryption"] = flags & 1 ? (flags & 0x40 ? "strong" : "zipcrypto") : "none";
    let aesStrength: 1 | 2 | 3 | undefined, aesVersion: 1 | 2 | undefined;
    for (const [id, d] of extras(extra)) {
      if (id === 0x0001) {
        let q = 0; entryZip64 = true;
        if (usize === 0xffffffff) { usize = u64(d, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(d, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(d, q); q += 8; }
        if (diskStart === 0xffff && q + 4 <= d.length && u32(d, q) !== 0) throw new Error("multi-volume (split) zip archives are not supported");
      } else if (id === 0x7075 && d.length >= 5 && d[0] === 1 && !utf8) {
        if (u32(d, 1) === crc32(rawName)) { name = td.decode(d.subarray(5)); nameEncoding = "unicode-path"; }
        else issues.push(`entry ${i}: stale Info-ZIP Unicode Path ignored (its CRC does not match the header name)`);
      } else if (id === 0x6375 && d.length >= 5 && d[0] === 1 && !utf8) {
        if (u32(d, 1) === crc32(commentRaw)) comment = td.decode(d.subarray(5));
      } else if (id === 0x5455 && d.length >= 5 && d[0] & 1) {
        mtime = new Date((u32(d, 1) | 0) * 1000);
      } else if (id === 0x000a && d.length >= 32) {
        // NTFS: reserved(4) then tag 1 (size 24): mtime, atime, ctime as 100 ns ticks since 1601
        if (u16(d, 4) === 1 && u16(d, 6) >= 24) { const ticks = u32(d, 8) + u32(d, 12) * 0x100000000; mtime = new Date(ticks / 10000 - 11644473600000); }
      } else if (id === 0x9901 && d.length >= 7 && method === 99) {
        aesVersion = u16(d, 0) === 2 ? 2 : 1; const s = d[4]; if (s < 1 || s > 3) throw new Error(`zip: bad AES strength in entry ${i}`);
        aesStrength = s as 1 | 2 | 3; method = u16(d, 5); encryption = "aes";
      }
    }
    if (diskStart !== 0 && diskStart !== 0xffff) throw new Error("multi-volume (split) zip archives are not supported");
    if (u16(buf, p + 10) === 99 && !aesStrength) throw new Error(`zip: entry ${i} uses method 99 without a WinZip AES extra field`);
    const host = madeBy >> 8, mode = host === 3 || host === 19 ? externalAttr >>> 16 : null;
    const symlink = mode !== null && (mode & 0o170000) === 0o120000;
    const dir = name.endsWith("/") || name.endsWith("\\") || (mode !== null && (mode & 0o170000) === 0o040000) || (!!(externalAttr & 0x10) && usize === 0 && host !== 3);
    total += usize;
    if (usize > limits.maxEntryBytes) throw new Error(`zip guard: "${name}" declares ${usize} bytes (limit ${limits.maxEntryBytes})`);
    if (total > limits.maxTotalBytes) throw new Error(`zip guard: the archive declares more than ${limits.maxTotalBytes} bytes in total`);
    if (usize > 1 << 20 && usize / Math.max(csize, 1) > limits.maxRatio) throw new Error(`zip bomb guard: "${name}" expands ${Math.round(usize / Math.max(csize, 1))}:1 (limit ${limits.maxRatio}:1)`);
    // local header (needed for the data offset; its name must match — a mismatch is a parser-differential attack)
    const lo = localOffset + prefix;
    if (lo + 30 > buf.length || u32(buf, lo) !== SIG_LOC) throw new Error(`zip: local header of "${name}" is missing or damaged`);
    const lnl = u16(buf, lo + 26), lxl = u16(buf, lo + 28);
    const lname = buf.subarray(lo + 30, lo + 30 + lnl);
    if (lnl !== nl || lname.some((v, k) => v !== rawName[k])) throw new Error(`zip: local and central names differ for "${name}" (refused: ambiguous archive)`);
    const dataOffset = lo + 30 + lnl + lxl;
    if (dataOffset + csize > buf.length) throw new Error(`zip: data of "${name}" runs past the end`);
    entries.push({
      index: i, name: name.replace(/\\/g, "/"), rawName, nameEncoding, safePath: safeEntryPath(name), dir, symlink, method, methodName: METHOD_NAMES[method] ?? `method ${method}`,
      flags, crc, csize, usize, localOffset: lo, dataOffset, mtime, unixMode: mode, encryption, aesStrength, aesVersion, comment, madeBy, versionNeeded, externalAttr,
      zip64: entryZip64, dosTime: (dosDate << 16) | dosTime, extraCentral: extra, duplicate: false,
    });
    p += 46 + nl + xl + cl;
  }
  // overlapping entries (Fifield's non-recursive bomb reuses one compressed kernel for many entries)
  const spans = entries.map((e) => [e.localOffset, e.dataOffset + e.csize, e.index] as const).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < spans.length; k++) if (spans[k][0] < spans[k - 1][1]) throw new Error(`zip bomb guard: entries ${spans[k - 1][2]} and ${spans[k][2]} overlap (overlapped-file construction refused)`);
  if (spans.length && spans[spans.length - 1][1] > cdOff + prefix) throw new Error("zip: entry data overlaps the central directory");
  // duplicates (case-sensitive, after normalisation): listed, never extracted
  const seen = new Map<string, ArchiveEntry>();
  for (const e of entries) { const k = e.safePath ?? e.name; const o = seen.get(k); if (o) { o.duplicate = true; e.duplicate = true; } else seen.set(k, e); }
  if (entries.some((e) => e.duplicate)) issues.push("the archive contains duplicate names — those entries are listed but not extracted");
  if (entries.some((e) => !e.safePath)) issues.push("some names are absolute or climb out of the folder (zip-slip) — those entries are blocked");
  const nonUtf = !!entries.find((e) => e.nameEncoding === "cp437" && e.rawName.some((v) => v > 127));
  if (nonUtf) issues.push("some names are not marked UTF-8 and were decoded as IBM code page 437 (APPNOTE Appendix D)");
  if (entries.some((e) => e.nameEncoding === "utf8-unflagged")) issues.push("some names are not marked UTF-8 but were made on Unix/macOS and are valid UTF-8 — decoded as UTF-8");
  return { entries, comment: td.decode(commentBytes), zip64, prefix, issues };
}

export interface ReadOptions { password?: string; limits?: ArchiveLimits; native?: boolean }

async function nativeInflate(raw: Bytes, limit: number): Promise<Bytes> {
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) return inflateRawSync(raw, { limit, expect: limit }).data;
  const ds = new DS("deflate-raw"); const w = ds.writable.getWriter(); const r = ds.readable.getReader();
  const done = w.write(raw).then(() => w.close()).catch(() => undefined);
  const chunks: Uint8Array[] = []; let n = 0;
  try {
    for (;;) {
      const { value, done: end } = await r.read(); if (end) break;
      n += value.length; if (n > limit) { await r.cancel(); throw new Error(`inflate: output exceeds the declared ${limit} bytes`); }
      chunks.push(value);
    }
  } catch (e) { if (e instanceof Error && e.message.startsWith("inflate:")) throw e; throw new Error(`inflate: ${(e as Error).message}`); }
  await done;
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Decrypt + decompress + verify one entry. Throws PasswordError when a password is needed or wrong. */
export async function readEntry(buf: Bytes, e: ArchiveEntry, opts: ReadOptions = {}): Promise<Bytes> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  if (e.dir) return new Uint8Array(0);
  if (e.encryption === "strong") throw new Error(`"${e.name}" uses PKWARE Strong Encryption, which is not supported`);
  if (!SUPPORTED_METHODS.has(e.method)) throw new Error(`"${e.name}" uses ${e.methodName}, which is not supported`);
  let raw = buf.subarray(e.dataOffset, e.dataOffset + e.csize);
  if (e.encryption !== "none") {
    if (opts.password === undefined) throw new PasswordError(`"${e.name}" is encrypted — a password is needed`);
    const pw = te.encode(opts.password);
    if (e.encryption === "zipcrypto") raw = zipCryptoDecrypt(raw, pw, e.flags & 8 ? (e.dosTime >>> 8) & 0xff : e.crc >>> 24, e.crc >>> 24);
    else raw = winzipAesDecrypt(raw, pw, e.aesStrength!);
  }
  const limit = Math.min(e.usize, limits.maxEntryBytes);
  let data: Bytes;
  switch (e.method) {
    case 0: data = raw.slice(); break;
    case 8: data = opts.native === false ? inflateRawSync(raw, { limit, expect: e.usize }).data : await nativeInflate(raw, limit); break;
    case 9: data = inflateRawSync(raw, { deflate64: true, limit, expect: e.usize }).data; break;
    case 12: data = bunzip2Sync(raw, limit); break;
    case 14: data = unlzmaZipSync(raw, { size: e.usize, eos: !!(e.flags & 2), limit }); break;
    default: throw new Error(`unsupported method ${e.method}`);
  }
  if (data.length !== e.usize) throw new Error(`"${e.name}": size mismatch (directory says ${e.usize}, data gives ${data.length}) — archive is corrupt`);
  const crcChecked = !(e.encryption === "aes" && e.aesVersion === 2);
  if (crcChecked && crc32(data) !== e.crc) throw new Error(`"${e.name}": CRC-32 mismatch — archive is corrupt`);
  return data;
}

/** Does this password open the entry? (cheap for AES/ZipCrypto: the verifier/check byte, then a full read) */
export async function checkPassword(buf: Bytes, e: ArchiveEntry, password: string): Promise<boolean> {
  try { await readEntry(buf, e, { password }); return true; } catch (err) { if (err instanceof PasswordError) return false; throw err; }
}

/* ------------------------------------------------------------------ writing */
export interface WriteItem { name: string; data?: Bytes; dir?: boolean; mtime?: Date; comment?: string; unixMode?: number; method?: 0 | 8 }
export interface WriteOptions {
  password?: string;
  encryption?: "aes256" | "aes128" | "aes192" | "zipcrypto";
  comment?: string;
  forceZip64?: boolean;
  level?: "store" | "deflate";
  deflate?: (d: Bytes) => Promise<Bytes> | Bytes;
  random?: (n: number) => Bytes;
}
const defaultRandom = (n: number) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };
async function defaultDeflate(d: Bytes): Promise<Bytes> {
  const CS = (globalThis as unknown as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS) return d;
  const s = new Blob([d as BlobPart]).stream().pipeThrough(new CS("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

class Sink {
  parts: Bytes[] = []; n = 0;
  push(b: Bytes) { this.parts.push(b); this.n += b.length; }
  out() { const o = new Uint8Array(this.n); let k = 0; for (const p of this.parts) { o.set(p, k); k += p.length; } return o; }
}
const le = (n: number, bytes: number) => { const b = new Uint8Array(bytes); let v = n; for (let i = 0; i < bytes; i++) { b[i] = v % 256; v = Math.floor(v / 256); } return b; };
const cat = (...a: Bytes[]) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const extra = (id: number, d: Bytes) => cat(le(id, 2), le(d.length, 2), d);

/** A prepared entry: everything needed to emit its local header, data and central record. */
interface Prepared {
  name: Bytes; utf8: boolean; method: number; flags: number; crc: number; csize: number; usize: number; dos: { time: number; date: number };
  body: Bytes; localExtra: Bytes; centralExtra: Bytes; externalAttr: number; madeBy: number; versionNeeded: number; comment: Bytes; descriptor: boolean;
}

function emit(items: Prepared[], comment: string, forceZip64: boolean): Bytes {
  const sink = new Sink(); const cens: Bytes[] = [];
  const M = 0xffffffff;
  for (const it of items) {
    const offset = sink.n;
    const big = forceZip64 || it.csize >= M || it.usize >= M;
    const localZ64 = big ? extra(0x0001, cat(le(it.usize, 8), le(it.csize, 8))) : new Uint8Array(0);
    const vn = Math.max(it.versionNeeded, big ? 45 : 20);
    const lh = cat(le(SIG_LOC, 4), le(vn, 2), le(it.flags, 2), le(it.method, 2), le(it.dos.time, 2), le(it.dos.date, 2),
      le(it.descriptor ? 0 : it.crc, 4), le(it.descriptor ? 0 : big ? M : it.csize, 4), le(it.descriptor ? 0 : big ? M : it.usize, 4),
      le(it.name.length, 2), le(localZ64.length + it.localExtra.length, 2), it.name, localZ64, it.localExtra);
    sink.push(lh); sink.push(it.body);
    if (it.descriptor) sink.push(big ? cat(le(SIG_DD, 4), le(it.crc, 4), le(it.csize, 8), le(it.usize, 8)) : cat(le(SIG_DD, 4), le(it.crc, 4), le(it.csize, 4), le(it.usize, 4)));
    // central: ZIP64 fields only for values that overflow (or all three when forced, so readers exercise the path)
    const zf: Bytes[] = [];
    const bu = forceZip64 || it.usize >= M, bc = forceZip64 || it.csize >= M, bo = forceZip64 || offset >= M;
    if (bu) zf.push(le(it.usize, 8)); if (bc) zf.push(le(it.csize, 8)); if (bo) zf.push(le(offset, 8));
    const cz = zf.length ? extra(0x0001, cat(...zf)) : new Uint8Array(0);
    cens.push(cat(le(SIG_CEN, 4), le(it.madeBy, 2), le(Math.max(vn, zf.length ? 45 : 20), 2), le(it.flags, 2), le(it.method, 2), le(it.dos.time, 2), le(it.dos.date, 2),
      le(it.crc, 4), le(bc ? M : it.csize, 4), le(bu ? M : it.usize, 4), le(it.name.length, 2), le(cz.length + it.centralExtra.length, 2), le(it.comment.length, 2),
      le(0, 2), le(0, 2), le(it.externalAttr, 4), le(bo ? M : offset, 4), it.name, cz, it.centralExtra, it.comment));
  }
  const cdOff = sink.n; for (const c of cens) sink.push(c); const cdSize = sink.n - cdOff;
  const cbytes = te.encode(comment).subarray(0, 65535);
  const needZ64 = forceZip64 || items.length >= 0xffff || cdOff >= M || cdSize >= M;
  if (needZ64) {
    const z64 = sink.n;
    sink.push(cat(le(SIG_Z64EOCD, 4), le(44, 8), le((3 << 8) | 63, 2), le(45, 2), le(0, 4), le(0, 4), le(items.length, 8), le(items.length, 8), le(cdSize, 8), le(cdOff, 8)));
    sink.push(cat(le(SIG_Z64LOC, 4), le(0, 4), le(z64, 8), le(1, 4)));
  }
  sink.push(cat(le(SIG_EOCD, 4), le(0, 2), le(0, 2), le(needZ64 ? 0xffff : items.length, 2), le(needZ64 ? 0xffff : items.length, 2),
    le(needZ64 ? M : cdSize, 4), le(needZ64 ? M : cdOff, 4), le(cbytes.length, 2), cbytes));
  return sink.out();
}

function utExtra(d: Date) { return extra(0x5455, cat(new Uint8Array([1]), le(Math.floor(d.getTime() / 1000) >>> 0, 4))); }

async function prepareNew(it: WriteItem, o: WriteOptions): Promise<Prepared> {
  const dir = !!it.dir || it.name.endsWith("/");
  let nm = it.name.replace(/\\/g, "/").replace(/^\/+/, ""); if (dir && !nm.endsWith("/")) nm += "/";
  if (!safeEntryPath(nm)) throw new Error(`zip writer: unsafe entry name "${it.name}"`);
  const name = te.encode(nm), utf8 = !isAscii(nm);
  const data = dir ? new Uint8Array(0) : it.data ?? new Uint8Array(0);
  const mtime = it.mtime ?? new Date();
  const crc = crc32(data);
  let method = 0, body = data;
  if (!dir && data.length && (it.method ?? (o.level === "store" ? 0 : 8)) === 8) {
    const z = await (o.deflate ?? defaultDeflate)(data);
    if (z !== data && z.length < data.length) { method = 8; body = z; }
  }
  let flags = utf8 ? 0x800 : 0, versionNeeded = method === 8 ? 20 : 10;
  let localExtra = utExtra(mtime), centralExtra = utExtra(mtime);
  const enc = o.password !== undefined && !dir ? o.encryption ?? "aes256" : null;
  const random = o.random ?? defaultRandom;
  let crcField = crc;
  if (enc && o.password !== undefined) {
    const pw = te.encode(o.password); flags |= 1;
    if (enc === "zipcrypto") body = zipCryptoEncrypt(body, pw, crc >>> 24, random);
    else {
      const strength = enc === "aes128" ? 1 : enc === "aes192" ? 2 : 3;
      body = winzipAesEncrypt(body, pw, strength, random);
      const ae = extra(0x9901, cat(le(2, 2), te.encode("AE"), new Uint8Array([strength]), le(method, 2)));
      localExtra = cat(localExtra, ae); centralExtra = cat(centralExtra, ae);
      method = 99; versionNeeded = 51; crcField = 0; // AE-2: CRC omitted, the HMAC authenticates
    }
  }
  const mode = it.unixMode ?? (dir ? 0o040755 : 0o100644);
  return { name, utf8, method, flags, crc: crcField, csize: body.length, usize: data.length, dos: dateToDos(mtime), body, localExtra, centralExtra,
    externalAttr: ((mode << 16) | (dir ? 0x10 : 0)) >>> 0, madeBy: (3 << 8) | 63, versionNeeded, comment: te.encode(it.comment ?? ""), descriptor: false };
}

export async function writeArchive(items: WriteItem[], o: WriteOptions = {}): Promise<Bytes> {
  const seen = new Set<string>(); const prepared: Prepared[] = [];
  for (const it of items) {
    const p = await prepareNew(it, o); const k = td.decode(p.name);
    if (seen.has(k)) throw new Error(`zip writer: duplicate entry name "${k}"`); seen.add(k);
    prepared.push(p);
  }
  return emit(prepared, o.comment ?? "", !!o.forceZip64);
}

/* ------------------------------------------------------------------ editing (raw copy — no recompression, no password needed) */
export type EditOp =
  | { op: "delete"; name: string }
  | { op: "rename"; from: string; to: string }
  | { op: "add"; item: WriteItem };

function stripExtras(b: Bytes, drop: number[]): Bytes {
  const keep: Bytes[] = []; for (const [id, d] of extras(b)) if (!drop.includes(id)) keep.push(extra(id, d)); return cat(...keep);
}

/** Apply delete / rename / add to an archive. Untouched entries keep their exact compressed (and encrypted) bytes. */
export async function editArchive(buf: Bytes, ops: EditOp[], o: WriteOptions & { limits?: ArchiveLimits } = {}): Promise<Bytes> {
  const a = readArchive(buf, o.limits);
  const rows = a.entries.map((e) => ({ e, name: e.name }));
  let list = rows.slice();
  const adds: WriteItem[] = [];
  const isUnder = (n: string, dir: string) => dir.endsWith("/") && n.startsWith(dir);
  for (const op of ops) {
    if (op.op === "delete") list = list.filter((r) => r.name !== op.name && !isUnder(r.name, op.name));
    else if (op.op === "rename") {
      if (!safeEntryPath(op.to)) throw new Error(`zip editor: unsafe name "${op.to}"`);
      for (const r of list) { if (r.name === op.from) r.name = op.to; else if (isUnder(r.name, op.from)) r.name = (op.to.endsWith("/") ? op.to : op.to + "/") + r.name.slice(op.from.length); }
    } else adds.push(op.item);
  }
  const prepared: Prepared[] = [];
  const names = new Set<string>();
  for (const r of list) {
    const e = r.e; if (names.has(r.name)) throw new Error(`zip editor: duplicate entry name "${r.name}"`); names.add(r.name);
    const renamed = r.name !== e.name;
    const nameBytes = renamed ? te.encode(r.name) : e.rawName;
    let flags = e.flags; if (renamed) flags = isAscii(r.name) ? flags & ~0x800 : flags | 0x800;
    const ex = stripExtras(e.extraCentral, renamed ? [0x0001, 0x7075] : [0x0001]);
    // the local header's own extra (AES 0x9901 must be present there too)
    const llx = u16(buf, e.localOffset + 28), lnl = u16(buf, e.localOffset + 26);
    const lex = stripExtras(buf.subarray(e.localOffset + 30 + lnl, e.localOffset + 30 + lnl + llx), renamed ? [0x0001, 0x7075] : [0x0001]);
    prepared.push({
      name: nameBytes, utf8: !!(flags & 0x800), method: e.encryption === "aes" ? 99 : e.method, flags, crc: e.crc, csize: e.csize, usize: e.usize,
      dos: { time: e.dosTime & 0xffff, date: e.dosTime >>> 16 }, body: buf.subarray(e.dataOffset, e.dataOffset + e.csize), localExtra: lex, centralExtra: ex,
      externalAttr: e.externalAttr, madeBy: e.madeBy, versionNeeded: Math.min(e.versionNeeded, 63), comment: te.encode(e.comment), descriptor: !!(flags & 8),
    });
  }
  for (const it of adds) {
    const p = await prepareNew(it, o); const k = td.decode(p.name);
    if (names.has(k)) throw new Error(`zip editor: "${k}" already exists`); names.add(k); prepared.push(p);
  }
  return emit(prepared, o.comment ?? a.comment, !!o.forceZip64);
}

/** Entries that may be extracted as files (blocked: unsafe paths, symlinks, duplicates). */
export function extractable(e: ArchiveEntry): boolean { return !!e.safePath && !e.symlink && !e.duplicate; }
