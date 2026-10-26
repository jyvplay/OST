/**
 * Metadata cleaner (TT18) — the analogue of Tails' "Metadata Cleaner" (MAT2), isomorphic so it runs in
 * the browser on decrypted Persistent Storage files without the plaintext ever reaching the host.
 *
 * Principle: remove metadata at the CONTAINER level and never re-encode content, so pixels / text are
 * bit-identical (verified by the oracle suite decoding before and after with Pillow / python-docx /
 * openpyxl / python-pptx / svgelements).
 *
 *  JPEG  drop APP1 (EXIF/XMP), APP3–APP13, APP15, COM; keep JFIF (APP0), ICC (APP2), Adobe (APP14 —
 *        needed to decode CMYK/YCCK). EXIF Orientation ≠ 1 is RE-EMITTED as a minimal one-tag EXIF block:
 *        `exiftool -all=` drops it and portrait photos then display sideways (documented pitfall).
 *  PNG   drop tEXt, zTXt, iTXt, eXIf, tIME; keep everything needed to render (gAMA/cHRM/sRGB/iCCP/pHYs…).
 *  WebP  drop EXIF and "XMP " chunks, clear the VP8X EXIF/XMP flags, fix the RIFF size.
 *  GIF   drop Comment Extensions and Application Extensions other than NETSCAPE2.0/ANIMEXTS1.0 (looping).
 *  SVG   drop <metadata>, comments, sodipodi:/inkscape: elements and attributes, RDF/CC/DC blocks.
 *  OOXML (docx/xlsx/pptx) empty docProps/core.xml and app.xml, remove custom.xml and the thumbnail
 *        (with their relationships and content types), strip w:rsid* revision-session ids (as MAT2
 *        does), blank comment/revision authors, initials and dates, xlsx absPath (local folder of the
 *        author) and revisionPtr, legacy comment author lists, pptx commentAuthors; then re-zip with
 *        every timestamp at 1980-01-01 and no extra fields (zip extra fields carry mtime/uid/gid).
 *  PDF and anything else: refused with an explanation — never "half cleaned".
 */

export interface CleanReport {
  kind: string;
  removed: string[];
  kept: string[];
  before: number;
  after: number;
  supported: boolean;
}
export interface CleanResult { data: Uint8Array; report: CleanReport }

const td = new TextDecoder();
const te = new TextEncoder();
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/* ================================================================ detect */
export function detectKind(b: Uint8Array, name = ""): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && ascii(b, 1, 3) === "PNG" && b[0] === 0x89) return "png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF89a" || ascii(b, 0, 6) === "GIF87a")) return "gif";
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) {
    const n = name.toLowerCase();
    if (n.endsWith(".docx")) return "docx";
    if (n.endsWith(".xlsx")) return "xlsx";
    if (n.endsWith(".pptx")) return "pptx";
    return "zip";
  }
  const head = td.decode(b.subarray(0, Math.min(b.length, 2048)));
  if (/<svg[\s>]/i.test(head)) return "svg";
  return "unknown";
}

/* ================================================================== JPEG */
const TIFF_TAGS: Record<number, string> = {
  0x010e: "ImageDescription", 0x010f: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x0131: "Software",
  0x0132: "DateTime", 0x013b: "Artist", 0x8298: "Copyright", 0x8769: "ExifIFD", 0x8825: "GPSInfo", 0xa430: "CameraOwnerName", 0xa431: "BodySerialNumber",
};
/** Minimal TIFF IFD0 reader for reporting (no allocation from untrusted counts beyond bounds). */
function readExif(seg: Uint8Array): { tags: Record<string, string>; orientation: number } {
  const tags: Record<string, string> = {};
  let orientation = 1;
  if (ascii(seg, 0, 4) !== "Exif") return { tags, orientation };
  const t = seg.subarray(6);
  if (t.length < 8) return { tags, orientation };
  const le = t[0] === 0x49;
  const r16 = (o: number) => (le ? u16le(t, o) : u16be(t, o));
  const r32 = (o: number) => (le ? u32le(t, o) : u32be(t, o));
  const ifd = r32(4);
  if (ifd + 2 > t.length) return { tags, orientation };
  const n = Math.min(r16(ifd), 256);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = r16(e); const type = r16(e + 2); const count = r32(e + 4);
    const name = TIFF_TAGS[tag];
    if (!name) continue;
    if (tag === 0x0112) { orientation = r16(e + 8); tags[name] = String(orientation); continue; }
    if (tag === 0x8825) { tags[name] = "present (GPS position)"; continue; }
    if (tag === 0x8769) { tags[name] = "present"; continue; }
    if (type === 2) {
      const off = count <= 4 ? e + 8 : r32(e + 8);
      if (off + count <= t.length) tags[name] = ascii(t, off, Math.min(count, 120)).replace(/\0+$/, "");
    }
  }
  return { tags, orientation };
}
/** "Exif\0\0" + big-endian TIFF with ONE IFD0 entry: Orientation (SHORT). */
export function minimalOrientationExif(orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, (orientation >> 8) & 255, orientation & 255, 0, 0, 0, 0, 0, 0];
  return Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}
function cleanJpeg(b: Uint8Array, rep: CleanReport): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let p = 2;
  let orientation = 1;
  let exifInsertAt = -1;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Error(`JPEG: marker expected at ${p}`);
    let m = b[p + 1];
    while (m === 0xff && p + 2 < b.length) { p += 1; m = b[p + 1]; } // fill bytes
    if (m === 0xd9) { out.push(b.subarray(p, p + 2)); p += 2; break; }
    if (m >= 0xd0 && m <= 0xd7) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
    const len = u16be(b, p + 2);
    if (len < 2 || p + 2 + len > b.length) throw new Error("JPEG: segment length out of bounds");
    const seg = b.subarray(p, p + 2 + len);
    const body = b.subarray(p + 4, p + 2 + len);
    if (m === 0xda) { // SOS: copy the rest (entropy-coded data + remaining markers) verbatim
      out.push(b.subarray(p));
      p = b.length;
      break;
    }
    const isApp = m >= 0xe0 && m <= 0xef;
    let keep = true;
    if (m === 0xfe) { keep = false; rep.removed.push(`JPEG comment: "${ascii(body, 0, Math.min(body.length, 60))}"`); }
    else if (m === 0xe1) {
      keep = false;
      if (ascii(body, 0, 4) === "Exif") {
        const ex = readExif(body);
        orientation = ex.orientation;
        for (const [k, v] of Object.entries(ex.tags)) if (k !== "Orientation") rep.removed.push(`EXIF ${k}: ${v}`);
        if (!Object.keys(ex.tags).length) rep.removed.push("EXIF block");
      } else if (ascii(body, 0, 28).startsWith("http://ns.adobe.com/xap/1.0/")) rep.removed.push("XMP packet");
      else rep.removed.push("APP1 segment");
    } else if (isApp && m !== 0xe0 && m !== 0xe2 && m !== 0xee) {
      keep = false; rep.removed.push(`APP${m - 0xe0} segment${m === 0xed ? " (Photoshop IRB / IPTC)" : ""}`);
    }
    if (m === 0xe0 && exifInsertAt < 0) exifInsertAt = out.length + 1; // after JFIF
    if (keep) out.push(seg);
    p += 2 + len;
  }
  if (p < b.length || !out.some((x) => x[0] === 0xff && x[1] === 0xda)) throw new Error("JPEG: truncated (no start-of-scan) — refusing to write a broken file");
  if (orientation !== 1 && orientation >= 2 && orientation <= 8) {
    const ex = minimalOrientationExif(orientation);
    const seg = concat([Uint8Array.of(0xff, 0xe1, ((ex.length + 2) >> 8) & 255, (ex.length + 2) & 255), ex]);
    out.splice(exifInsertAt > 0 ? exifInsertAt : 1, 0, seg);
    rep.kept.push(`EXIF Orientation=${orientation} (re-emitted alone so the photo is not displayed rotated)`);
  }
  rep.kept.push("JFIF/ICC/Adobe colour segments and all image data (not re-encoded)");
  return concat(out);
}

/* =================================================================== PNG */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function cleanPng(b: Uint8Array, rep: CleanReport): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let p = 8;
  const DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  let sawEnd = false;
  while (p + 12 <= b.length) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    if (p + 12 + len > b.length) throw new Error("PNG: chunk length out of bounds");
    if (DROP.has(type)) {
      const data = b.subarray(p + 8, p + 8 + len);
      const kw = type === "tEXt" || type === "zTXt" || type === "iTXt" ? ascii(data, 0, Math.max(0, data.indexOf(0))) : "";
      const val = type === "tEXt" ? `: ${ascii(data, data.indexOf(0) + 1, Math.min(60, len - data.indexOf(0) - 1))}` : "";
      rep.removed.push(`PNG ${type}${kw ? ` "${kw}"` : ""}${val}`);
    } else out.push(b.subarray(p, p + 12 + len));
    p += 12 + len;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd) throw new Error("PNG: truncated (no IEND chunk) — refusing to write a broken file");
  rep.kept.push("all critical and rendering chunks (IHDR/PLTE/IDAT/gAMA/sRGB/iCCP/pHYs…)");
  return concat(out);
}

/* ================================================================== WebP */
function cleanWebp(b: Uint8Array, rep: CleanReport): Uint8Array {
  const out: Uint8Array[] = [];
  if (u32le(b, 4) + 8 !== b.length) throw new Error("WebP: RIFF size does not match the file (truncated or padded)");
  let p = 12;
  while (p + 8 <= b.length) {
    const fourcc = ascii(b, p, 4);
    const len = u32le(b, p + 4);
    const total = 8 + len + (len & 1);
    if (p + 8 + len > b.length) throw new Error("WebP: chunk length out of bounds");
    if (fourcc === "EXIF" || fourcc === "XMP ") rep.removed.push(`WebP ${fourcc.trim()} chunk (${len} bytes)`);
    else {
      const c = b.slice(p, p + total);
      if (fourcc === "VP8X") c[8] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
      out.push(c);
    }
    p += total;
  }
  const body = concat(out);
  const hdr = new Uint8Array(12);
  hdr.set(te.encode("RIFF"), 0);
  const size = body.length + 4;
  hdr[4] = size & 255; hdr[5] = (size >> 8) & 255; hdr[6] = (size >> 16) & 255; hdr[7] = (size >>> 24) & 255;
  hdr.set(te.encode("WEBP"), 8);
  rep.kept.push("VP8/VP8L/ALPH/ANIM/ICCP chunks unchanged");
  return concat([hdr, body]);
}

/* =================================================================== GIF */
function cleanGif(b: Uint8Array, rep: CleanReport): Uint8Array {
  const out: Uint8Array[] = [];
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  out.push(b.subarray(0, p));
  const skipSub = (q: number) => { while (q < b.length && b[q] !== 0) q += b[q] + 1; if (q >= b.length) throw new Error("GIF: sub-block runs past the end"); return q + 1; };
  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) { out.push(b.subarray(p, p + 1)); break; }
    if (t === 0x2c) {
      let q = p + 10;
      if (b[p + 9] & 0x80) q += 3 * (1 << ((b[p + 9] & 7) + 1));
      q = skipSub(q + 1);
      out.push(b.subarray(p, q)); p = q; continue;
    }
    if (t === 0x21) {
      const label = b[p + 1];
      const end = skipSub(p + 2);
      if (label === 0xfe) { rep.removed.push(`GIF comment: "${ascii(b, p + 3, Math.min(b[p + 2], 60))}"`); p = end; continue; }
      if (label === 0xff) {
        const app = ascii(b, p + 3, 11);
        if (app !== "NETSCAPE2.0" && app !== "ANIMEXTS1.0") { rep.removed.push(`GIF application extension "${app.trim()}"${app.startsWith("XMP Data") ? " (XMP)" : ""}`); p = end; continue; }
      }
      out.push(b.subarray(p, end)); p = end; continue;
    }
    throw new Error(`GIF: unexpected block 0x${t.toString(16)} at ${p}`);
  }
  if (out[out.length - 1]?.[0] !== 0x3b || out[out.length - 1].length !== 1) throw new Error("GIF: truncated (no trailer) — refusing to write a broken file");
  rep.kept.push("frames, palettes, graphic control and looping extensions");
  return concat(out);
}

/* =================================================================== SVG */
function cleanSvg(text: string, rep: CleanReport): string {
  let s = text;
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  const drop = (re: RegExp, label: string) => { const n = count(re); if (n) { rep.removed.push(`${label} ×${n}`); s = s.replace(re, ""); } };
  drop(/<!--[\s\S]*?-->/g, "XML comment");
  drop(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, "<metadata> block");
  drop(/<metadata\b[^>]*\/>/gi, "<metadata/> element");
  drop(/<(sodipodi|inkscape):[\w-]+\b[^>]*\/>/g, "editor element (sodipodi/inkscape)");
  drop(/<(sodipodi|inkscape):([\w-]+)\b[^>]*>[\s\S]*?<\/\1:\2\s*>/g, "editor element (sodipodi/inkscape)");
  drop(/<rdf:RDF\b[\s\S]*?<\/rdf:RDF\s*>/g, "RDF block");
  drop(/\s(sodipodi|inkscape):[\w-]+="[^"]*"/g, "editor attribute");
  drop(/\sxmlns:(sodipodi|inkscape|rdf|cc|dc)="[^"]*"/g, "unused editor namespace");
  rep.kept.push("all drawing elements, styles and <title>/<desc> (content, not metadata)");
  return s;
}

/* =================================================================== ZIP */
export interface ZipItem { name: string; data: Uint8Array }
const ZIP_GUARD = { entries: 4000, total: 64 * 1024 * 1024, ratio: 200 };
async function pipeThrough(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const res = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export async function readZip(b: Uint8Array): Promise<ZipItem[]> {
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65535; i--) if (u32le(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (no end of central directory)");
  const count = u16le(b, eocd + 10);
  if (count > ZIP_GUARD.entries) throw new Error("zip has too many entries");
  let p = u32le(b, eocd + 16);
  const items: ZipItem[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (u32le(b, p) !== 0x02014b50) throw new Error("zip central directory corrupt");
    const method = u16le(b, p + 10); const crc = u32le(b, p + 16);
    const csize = u32le(b, p + 20); const usize = u32le(b, p + 24);
    const nl = u16le(b, p + 28); const xl = u16le(b, p + 30); const cl = u16le(b, p + 32);
    const loc = u32le(b, p + 42);
    const name = td.decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    if (name.includes("..") || name.startsWith("/")) throw new Error(`zip entry escapes: ${name}`);
    total += usize;
    if (total > ZIP_GUARD.total || (csize > 0 && usize / csize > ZIP_GUARD.ratio)) throw new Error("zip bomb guard tripped");
    if (u32le(b, loc) !== 0x04034b50) throw new Error("zip local header corrupt");
    const start = loc + 30 + u16le(b, loc + 26) + u16le(b, loc + 28);
    const comp = b.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = comp.slice();
    else if (method === 8) data = await pipeThrough(comp, new DecompressionStream("deflate-raw"));
    else throw new Error(`zip method ${method} unsupported`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip entry ${name} failed its size/CRC check`);
    if (!name.endsWith("/")) items.push({ name, data });
  }
  return items;
}
/** Deterministic zip: fixed 1980-01-01 00:00 timestamps, no extra fields, no comments. */
export async function writeZip(items: ZipItem[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []; const central: Uint8Array[] = [];
  let off = 0;
  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const it of items) {
    const name = te.encode(it.name);
    const comp = await pipeThrough(it.data, new CompressionStream("deflate-raw"));
    const crc = crc32(it.data);
    const lh = new Uint8Array(30); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 8, true);
    dv.setUint16(10, DOS_TIME, true); dv.setUint16(12, DOS_DATE, true); dv.setUint32(14, crc, true);
    dv.setUint32(18, comp.length, true); dv.setUint32(22, it.data.length, true); dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    parts.push(lh, name, comp);
    const ch = new Uint8Array(46); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 8, true);
    cv.setUint16(12, DOS_TIME, true); cv.setUint16(14, DOS_DATE, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true); cv.setUint32(24, it.data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, off, true);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = concat(central);
  const e = new Uint8Array(22); const ev = new DataView(e.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true);
  ev.setUint32(12, cd.length, true); ev.setUint32(16, off, true);
  return concat([...parts, cd, e]);
}

/* ================================================================= OOXML */
const CORE_EMPTY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`;
const APP_EMPTY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>`;
function coreFields(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(dc|cp|dcterms):(\w+)\b[^>]*>([^<]{1,200})<\/\1:\2>/g)) out.push(`${m[2]}: ${m[3]}`);
  return out;
}
async function cleanOoxml(b: Uint8Array, kind: string, rep: CleanReport): Promise<Uint8Array> {
  const items = await readZip(b);
  const removedParts = new Set<string>();
  const out: ZipItem[] = [];
  for (const it of items) {
    const n = it.name;
    if (n === "docProps/custom.xml" || /^docProps\/thumbnail\.\w+$/.test(n)) { removedParts.add(n); rep.removed.push(`part ${n}`); continue; }
    if (!/\.(xml|rels)$/i.test(n)) { out.push(it); continue; }
    let x = td.decode(it.data);
    const before = x;
    if (n === "docProps/core.xml") { for (const f of coreFields(x)) rep.removed.push(`core property ${f}`); x = CORE_EMPTY; }
    else if (n === "docProps/app.xml") {
      for (const m of x.matchAll(/<(Company|Manager|Application|AppVersion|Template|HyperlinkBase)>([^<]{1,120})<\/\1>/g)) rep.removed.push(`app property ${m[1]}: ${m[2]}`);
      x = APP_EMPTY;
    } else {
      const rsidAttr = (x.match(/\sw:rsid\w*="[^"]*"/g) ?? []).length;
      if (rsidAttr) { x = x.replace(/\sw:rsid\w*="[^"]*"/g, ""); rep.removed.push(`${n}: ${rsidAttr} revision-session ids (w:rsid*)`); }
      const rsidEl = (x.match(/<w:rsid\w*\b[^>]*\/>/g) ?? []).length;
      if (rsidEl && !/<w:rsids>/.test(x)) { x = x.replace(/<w:rsid\w*\b[^>]*\/>/g, ""); rep.removed.push(`${n}: ${rsidEl} revision-session id elements (<w:rsid>)`); }
      if (/<w:rsids>[\s\S]*?<\/w:rsids>/.test(x)) { x = x.replace(/<w:rsids>[\s\S]*?<\/w:rsids>/g, ""); rep.removed.push(`${n}: <w:rsids> table`); }
      const authors = new Set([...x.matchAll(/\sw:author="([^"]+)"/g)].map((m) => m[1]).filter((a) => a !== "Author"));
      if (authors.size) { x = x.replace(/\sw:author="[^"]*"/g, ' w:author="Author"').replace(/\sw:initials="[^"]*"/g, ' w:initials="A"'); rep.removed.push(`${n}: author names ${[...authors].join(", ")}`); }
      if (/\sw:date="[^"]*"/.test(x)) { x = x.replace(/\sw:date="[^"]*"/g, ""); rep.removed.push(`${n}: revision/comment timestamps`); }
      const abs = x.match(/<x15ac:absPath\b[^>]*url="([^"]*)"/);
      if (abs) { x = x.replace(/<mc:AlternateContent\b(?:(?!<\/mc:AlternateContent>)[\s\S])*?x15ac:absPath[\s\S]*?<\/mc:AlternateContent>/g, ""); rep.removed.push(`${n}: author's local folder ${abs[1]}`); }
      if (/<xr:revisionPtr\b[^>]*\/>/.test(x)) { x = x.replace(/<xr:revisionPtr\b[^>]*\/>/g, ""); rep.removed.push(`${n}: revision pointer (document GUID)`); }
      if (/^xl\/(comments\d*|comments\/comment\d+)\.xml$/.test(n)) {
        const names = [...x.matchAll(/<author>([^<]*)<\/author>/g)].map((m) => m[1]).filter((a) => a !== "Author");
        if (names.length) { x = x.replace(/<author>[^<]*<\/author>/g, "<author>Author</author>"); rep.removed.push(`${n}: comment authors ${names.join(", ")}`); }
      }
      if (/^xl\/persons\/person\.xml$/.test(n) || /^ppt\/commentAuthors\.xml$/.test(n)) {
        const names = [...x.matchAll(/\s(?:displayName|name)="([^"]*)"/g)].map((m) => m[1]).filter((a) => a !== "Author");
        if (names.length) {
          x = x.replace(/\s(displayName|name)="[^"]*"/g, ' $1="Author"').replace(/\s(userId|initials|providerId)="[^"]*"/g, ' $1=""');
          rep.removed.push(`${n}: people ${names.join(", ")}`);
        }
      }
    }
    out.push(x === before ? it : { name: n, data: te.encode(x) });
  }
  // drop references to removed parts
  for (const it of out) {
    if (it.name === "[Content_Types].xml" || it.name.endsWith(".rels")) {
      let x = td.decode(it.data);
      for (const part of removedParts) {
        const esc = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        x = x.replace(new RegExp(`<Override\\b[^>]*PartName="/${esc}"[^>]*/>`, "g"), "");
        x = x.replace(new RegExp(`<Relationship\\b[^>]*Target="/?${esc}"[^>]*/>`, "g"), "");
      }
      it.data = te.encode(x);
    }
  }
  rep.removed.push("zip timestamps and extra fields (normalised to 1980-01-01, none)");
  rep.kept.push(`all ${kind} content parts (text, styles, media, relationships)`);
  return writeZip(out);
}

/* ================================================================ public */
/** Cleans `data` (bytes of `name`). Never throws for unsupported types — reports supported:false. */
export async function cleanMetadata(data: Uint8Array, name = ""): Promise<CleanResult> {
  const kind = detectKind(data, name);
  const rep: CleanReport = { kind, removed: [], kept: [], before: data.length, after: data.length, supported: true };
  let out: Uint8Array = data;
  switch (kind) {
    case "jpeg": out = cleanJpeg(data, rep); break;
    case "png": out = cleanPng(data, rep); break;
    case "webp": out = cleanWebp(data, rep); break;
    case "gif": out = cleanGif(data, rep); break;
    case "svg": out = te.encode(cleanSvg(td.decode(data), rep)); break;
    case "docx": case "xlsx": case "pptx": out = await cleanOoxml(data, kind, rep); break;
    case "pdf":
      rep.supported = false;
      rep.kept.push("PDF not cleaned: its metadata can live in the Info dictionary, XMP streams, incremental updates and embedded fonts/images; MAT2 rasterises the pages to be sure. Refusing rather than half-cleaning.");
      break;
    default:
      rep.supported = false;
      rep.kept.push(`no cleaner for type "${kind}" — file left unchanged`);
  }
  rep.after = out.length;
  return { data: out, report: rep };
}
