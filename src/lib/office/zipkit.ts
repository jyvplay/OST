/**
 * TT46 — isomorphic ZIP (PKWARE APPNOTE 6.3.x subset) for OOXML packages, written from the specification. Runs in the
 * browser and in Node ≥ 18 using the platform `DecompressionStream`/`CompressionStream("deflate-raw")`, so office
 * documents can be opened and saved entirely on-device. Methods: stored (0) and deflate (8); ZIP64 and encryption are
 * refused (declared). Guards: ≤ 20 000 entries, ≤ 512 MiB total inflated, per-entry ratio ≤ 1000:1 beyond 1 MiB,
 * CRC-32 verified on read.
 */
export interface ZipEntry { name: string; method: number; crc: number; csize: number; usize: number; offset: number; time: number; date: number }
export interface ZipArchive { entries: ZipEntry[]; read(name: string): Promise<Uint8Array | null>; readText(name: string): Promise<string | null>; has(name: string): boolean }

const MAX_ENTRIES = 20_000, MAX_TOTAL = 512 * 1024 * 1024;
let CRC_TABLE: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) { CRC_TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function pipe(data: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const done = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => { /* surfaced by the reader */ });
  const chunks: Uint8Array[] = []; let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new Error("zip: entry inflates beyond its declared size / ratio guard"); }
    chunks.push(value);
  }
  await done;
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
export const inflateRaw = (d: Uint8Array, limit: number) => pipe(d, new DecompressionStream("deflate-raw"), limit);
export const deflateRaw = (d: Uint8Array) => pipe(d, new CompressionStream("deflate-raw"), Number.MAX_SAFE_INTEGER);

const td = new TextDecoder("utf-8", { ignoreBOM: true }), te = new TextEncoder();
export function openZip(buf: Uint8Array): ZipArchive {
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) throw new Error("zip: this is an OLE/CFB container — an encrypted (password-protected) or legacy binary Office file, not OOXML");
  try { return openZipInner(buf); } catch (e) { if (e instanceof RangeError) throw new Error("zip: truncated or corrupt archive (offset out of bounds)"); throw e; }
}
function openZipInner(buf: Uint8Array): ZipArchive {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip: end of central directory not found (not a ZIP / OOXML package)");
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error("zip: ZIP64 archives are not supported");
  if (count > MAX_ENTRIES) throw new Error("zip: too many entries");
  const entries: ZipEntry[] = [];
  let p = cdOff, total = 0;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip: corrupt central directory");
    const flags = dv.getUint16(p + 8, true);
    if (flags & 1) throw new Error("zip: encrypted entries are not supported (password-protected document)");
    const e: ZipEntry = { method: dv.getUint16(p + 10, true), time: dv.getUint16(p + 12, true), date: dv.getUint16(p + 14, true), crc: dv.getUint32(p + 16, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true), offset: dv.getUint32(p + 42, true), name: "" };
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    e.name = td.decode(buf.subarray(p + 46, p + 46 + nl));
    total += e.usize;
    if (total > MAX_TOTAL) throw new Error("zip: declared inflated size exceeds the 512 MiB guard");
    entries.push(e);
    p += 46 + nl + xl + cl;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = async (name: string): Promise<Uint8Array | null> => {
    const e = byName.get(name) ?? byName.get(name.replace(/^\//, ""));
    if (!e) return null;
    if (e.offset + 30 > buf.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    if (start + e.csize > buf.length) throw new Error(`zip: entry ${name} is truncated`);
    const comp = buf.subarray(start, start + e.csize);
    let data: Uint8Array;
    if (e.method === 0) data = comp.slice();
    else if (e.method === 8) data = await inflateRaw(comp, e.usize > 1 << 20 ? Math.min(e.usize, comp.length * 1000) : Math.max(e.usize, 1 << 20));
    else throw new Error(`zip: compression method ${e.method} not supported`);
    if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`zip: CRC/size mismatch in ${name}`);
    return data;
  };
  return { entries, read, readText: async (n) => { const d = await read(n); return d ? td.decode(d) : null; }, has: (n) => byName.has(n) || byName.has(n.replace(/^\//, "")) };
}

/** Writes entries in the given order ([Content_Types].xml first, as Office does). Fixed DOS timestamp 1980-01-01 for reproducibility. */
export async function writeZip(files: { name: string; data: Uint8Array | string; store?: boolean }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === "string" ? te.encode(f.data) : f.data;
    const crc = crc32(raw);
    const store = f.store || raw.length < 64 || /\.(png|jpe?g|gif|zip|docx|xlsx|pptx)$/i.test(f.name);
    const comp = store ? raw : await deflateRaw(raw);
    const method = store ? 0 : 8;
    const nm = te.encode(f.name);
    const lh = new Uint8Array(30 + nm.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nm.length, true); lv.setUint16(28, 0, true); lh.set(nm, 30);
    const ch = new Uint8Array(46 + nm.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nm.length, true); cv.setUint32(42, offset, true); ch.set(nm, 46);
    parts.push(lh, comp); central.push(ch);
    offset += lh.length + comp.length;
    if (offset > 0xffffffff) throw new Error("zip: archive exceeds 4 GiB (ZIP64 not supported)");
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end]; const out = new Uint8Array(offset + cdSize + 22); let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}
export const utf8 = (s: string) => te.encode(s);
export const fromUtf8 = (b: Uint8Array) => td.decode(b);
