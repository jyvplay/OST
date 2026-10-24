/**
 * TT54 (FF-07) — image export: PNG / JPEG / WebP through the platform encoder (canvas), AVIF through WebCodecs AV1 +
 * a first-party AVIF (HEIF) container writer, HEIC only when the platform has an HEVC encoder (VideoEncoder
 * isConfigSupported) — never faked: a request the platform cannot honour is refused with the reason.
 *
 * Metadata carry-over (privacy-first: off unless asked): a CURATED EXIF block is rebuilt from the source —
 * camera / lens / exposure / date / author tags copied byte-exactly, Orientation reset to 1 (the exported pixels are
 * upright), PixelX/YDimension set to the output size, Software = "Fusion Photos"; dropped: MakerNote (its internal
 * offsets break when moved), the IFD1 thumbnail (stale after edits), every unknown tag; GPS only with keepLocation.
 * Container placement: JPEG APP1 after SOI / JFIF; PNG eXIf before the first IDAT (PNG 3rd ed. / ext 1.5); WebP EXIF
 * chunk after the image data with a VP8X header (created when the encoder wrote a simple VP8 / VP8L file).
 * Canvas encoders strip all metadata, which is why the block is re-injected rather than "kept".
 */
import { readExif, TAG, type ExifIfds } from "../meta/exif";
import { crc32 } from "../office/zipkit";
import { encodeBmp, encodeGif } from "./rasterenc";

/* ------------------------------------------------------------------ EXIF writer ------ */

interface Entry { tag: number; type: number; count: number; bytes: Uint8Array }
const KEEP_IFD0 = [TAG.Make, TAG.Model, TAG.DateTime, TAG.Artist, TAG.Copyright, TAG.ImageDescription];
const KEEP_EXIF = [TAG.ExposureTime, TAG.FNumber, TAG.ExposureProgram, TAG.ISO, 0x9000, TAG.DateTimeOriginal, TAG.DateTimeDigitized,
  0x9010, TAG.OffsetTimeOriginal, 0x9012, TAG.ShutterSpeedValue, TAG.ApertureValue, TAG.ExposureBiasValue, 0x9205, TAG.MeteringMode, 0x9208,
  TAG.Flash, TAG.FocalLength, TAG.SubSecTimeOriginal, 0x9292, TAG.ColorSpace, 0xa402, TAG.WhiteBalance, TAG.FocalLengthIn35mm, 0xa406,
  TAG.BodySerialNumber, 0xa432, TAG.LensMake, TAG.LensModel];
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

export interface ExportExifOptions { width: number; height: number; keepLocation?: boolean; software?: string }

/** curated EXIF (TIFF stream) for an exported image, or null when the source has none worth keeping.
 * `src`: the parsed IFDs (FileMeta.exif) or a raw TIFF stream (the payload after "Exif\0\0"). */
export function exportExif(src: ExifIfds | Uint8Array | null, o: ExportExifOptions): Uint8Array | null {
  const x = src instanceof Uint8Array ? readExif(src) : src;
  if (!x || !x.raw.size) return null;
  const le = x.littleEndian;
  const pick = (ifd: string, tags: readonly number[]) => tags.flatMap((t) => { const r = x.raw.get(`${ifd}:${t}`); return r ? [{ tag: t, ...r }] : []; });
  const short = (v: number): Uint8Array => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, le); return b; };
  const long = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, le); return b; };
  const ascii = (s: string): Uint8Array => { const e = new TextEncoder().encode(s + "\0"); return e; };
  const ifd0: Entry[] = pick("ifd0", KEEP_IFD0);
  ifd0.push({ tag: TAG.Orientation, type: 3, count: 1, bytes: short(1) });
  const sw = ascii(o.software ?? "Fusion Photos"); ifd0.push({ tag: TAG.Software, type: 2, count: sw.length, bytes: sw });
  const exif: Entry[] = pick("exif", KEEP_EXIF);
  exif.push({ tag: TAG.PixelXDimension, type: 4, count: 1, bytes: long(o.width) }, { tag: TAG.PixelYDimension, type: 4, count: 1, bytes: long(o.height) });
  const gps: Entry[] = o.keepLocation ? [...x.raw.keys()].filter((k) => k.startsWith("gps:")).map((k) => ({ tag: +k.slice(4), ...x.raw.get(k)! })) : [];
  return writeTiff(le, ifd0, exif, gps);
}

/** TIFF writer: IFD0 (+ Exif / GPS sub-IFDs), entries sorted by tag, values word-aligned after each IFD */
export function writeTiff(le: boolean, ifd0: Entry[], exif: Entry[], gps: Entry[]): Uint8Array {
  const sortU = (a: Entry[]) => a.filter((e, i, arr) => arr.findIndex((f) => f.tag === e.tag) === i).sort((p, q) => p.tag - q.tag);
  const I0 = sortU(ifd0), IE = sortU(exif), IG = sortU(gps);
  if (IE.length) I0.push({ tag: TAG.ExifIFD, type: 4, count: 1, bytes: new Uint8Array(4) });
  if (IG.length) I0.push({ tag: TAG.GPSIFD, type: 4, count: 1, bytes: new Uint8Array(4) });
  I0.sort((p, q) => p.tag - q.tag);
  const ifdSize = (es: Entry[]) => 2 + es.length * 12 + 4 + es.reduce((a, e) => a + (e.bytes.length > 4 ? (e.bytes.length + 1) & ~1 : 0), 0);
  const off0 = 8, offE = off0 + ifdSize(I0), offG = offE + (IE.length ? ifdSize(IE) : 0);
  const total = offG + (IG.length ? ifdSize(IG) : 0);
  const out = new Uint8Array(total); const dv = new DataView(out.buffer);
  out.set(le ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]); dv.setUint32(4, off0, le);
  const put = (es: Entry[], at: number) => {
    dv.setUint16(at, es.length, le); let val = at + 2 + es.length * 12 + 4;
    es.forEach((e, i) => {
      const p = at + 2 + i * 12; dv.setUint16(p, e.tag, le); dv.setUint16(p + 2, e.type, le);
      dv.setUint32(p + 4, e.bytes.length / (TYPE_SIZE[e.type] || 1), le);
      if (e.tag === TAG.ExifIFD) dv.setUint32(p + 8, offE, le);
      else if (e.tag === TAG.GPSIFD) dv.setUint32(p + 8, offG, le);
      else if (e.bytes.length <= 4) out.set(e.bytes, p + 8);
      else { dv.setUint32(p + 8, val, le); out.set(e.bytes, val); val += (e.bytes.length + 1) & ~1; }
    });
    dv.setUint32(at + 2 + es.length * 12, 0, le);
  };
  put(I0, off0); if (IE.length) put(IE, offE); if (IG.length) put(IG, offG);
  return out;
}

/* ------------------------------------------------------------------ container injection ------ */

const cat = (parts: Uint8Array[]) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const be32 = (v: number) => new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const le32 = (v: number) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]);
const asc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function injectExifJpeg(jpg: Uint8Array, tiff: Uint8Array): Uint8Array {
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error("not a JPEG");
  const payload = cat([asc("Exif\0\0"), tiff]); if (payload.length + 2 > 0xffff) throw new Error("EXIF block too large for one APP1 segment");
  let at = 2; // after SOI, and after a JFIF APP0 when present (JFIF requires APP0 first)
  if (jpg[2] === 0xff && jpg[3] === 0xe0) at = 4 + ((jpg[4] << 8) | jpg[5]);
  // drop any APP1 Exif the encoder may have written so there is exactly one
  const seg = cat([new Uint8Array([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  return cat([jpg.subarray(0, at), seg, stripApp1Exif(jpg.subarray(at))]);
}
function stripApp1Exif(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = []; let o = 0;
  while (o + 4 <= b.length && b[o] === 0xff && b[o + 1] >= 0xe0 && b[o + 1] <= 0xef) {
    const n = 2 + ((b[o + 2] << 8) | b[o + 3]);
    const isExif = b[o + 1] === 0xe1 && String.fromCharCode(...b.subarray(o + 4, o + 9)) === "Exif\0";
    if (!isExif) parts.push(b.subarray(o, o + n)); o += n;
  }
  parts.push(b.subarray(o)); return cat(parts);
}

export function injectExifPng(png: Uint8Array, tiff: Uint8Array): Uint8Array {
  if (png[0] !== 0x89 || png[1] !== 0x50) throw new Error("not a PNG");
  const parts: Uint8Array[] = [png.subarray(0, 8)]; let o = 8; let done = false;
  while (o + 12 <= png.length) {
    const len = (png[o] << 24 >>> 0) + (png[o + 1] << 16) + (png[o + 2] << 8) + png[o + 3]; const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const end = o + 12 + len;
    if (type === "eXIf") { o = end; continue; }
    if (type === "IDAT" && !done) { const body = cat([asc("eXIf"), tiff]); parts.push(be32(tiff.length), body, be32(crc32(body))); done = true; }
    parts.push(png.subarray(o, end)); o = end;
  }
  return cat(parts);
}

export function injectExifWebp(webp: Uint8Array, tiff: Uint8Array, width: number, height: number): Uint8Array {
  if (String.fromCharCode(...webp.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...webp.subarray(8, 12)) !== "WEBP") throw new Error("not a WebP");
  const chunks: { id: string; data: Uint8Array }[] = []; let o = 12;
  while (o + 8 <= webp.length) {
    const id = String.fromCharCode(...webp.subarray(o, o + 4)); const n = webp[o + 4] | (webp[o + 5] << 8) | (webp[o + 6] << 16) | (webp[o + 7] << 24);
    chunks.push({ id, data: webp.subarray(o + 8, o + 8 + n) }); o += 8 + n + (n & 1);
  }
  let vp8x = chunks.find((c) => c.id === "VP8X");
  if (!vp8x) {
    const alpha = chunks.some((c) => c.id === "ALPH") || chunks.some((c) => c.id === "VP8L" && ((c.data[4] >> 4) & 1) === 1);
    // canvas size from the bitstream itself (VP8 key-frame header / VP8L header); the caller's size is a fallback
    const v8 = chunks.find((c) => c.id === "VP8 "), vl = chunks.find((c) => c.id === "VP8L");
    if (v8 && v8.data.length >= 10 && v8.data[3] === 0x9d && v8.data[4] === 0x01 && v8.data[5] === 0x2a) { width = (v8.data[6] | (v8.data[7] << 8)) & 0x3fff; height = (v8.data[8] | (v8.data[9] << 8)) & 0x3fff; }
    else if (vl && vl.data.length >= 5 && vl.data[0] === 0x2f) { const bits = (vl.data[1] | (vl.data[2] << 8) | (vl.data[3] << 16) | (vl.data[4] << 24)) >>> 0; width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    const d = new Uint8Array(10); d[0] = alpha ? 0x10 : 0;
    d[4] = (width - 1) & 255; d[5] = ((width - 1) >> 8) & 255; d[6] = ((width - 1) >> 16) & 255; d[7] = (height - 1) & 255; d[8] = ((height - 1) >> 8) & 255; d[9] = ((height - 1) >> 16) & 255;
    vp8x = { id: "VP8X", data: d }; chunks.unshift(vp8x);
  } else vp8x.data = vp8x.data.slice();
  vp8x.data[0] |= 0x08;
  const kept = chunks.filter((c) => c.id !== "EXIF"); kept.push({ id: "EXIF", data: tiff });
  const body = cat(kept.flatMap((c) => [asc(c.id), le32(c.data.length), c.data, c.data.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]));
  return cat([asc("RIFF"), le32(body.length + 4), asc("WEBP"), body]);
}

/* ------------------------------------------------------------------ AV1 -> AVIF ------ */

export interface Av1Seq { profile: number; level: number; tier: number; highBitdepth: boolean; twelveBit: boolean; mono: boolean; ssx: number; ssy: number; csp: number; primaries: number; transfer: number; matrix: number; fullRange: boolean; width: number; height: number; obu: Uint8Array }

/** split a low-overhead AV1 bitstream into OBUs (type, full bytes incl. header, payload) */
export function obus(b: Uint8Array): { type: number; all: Uint8Array; payload: Uint8Array }[] {
  const out: { type: number; all: Uint8Array; payload: Uint8Array }[] = []; let o = 0;
  while (o < b.length) {
    const h = b[o]; const type = (h >> 3) & 15, ext = (h >> 2) & 1, hasSize = (h >> 1) & 1; let p = o + 1 + ext;
    if (h & 0x80) throw new Error("av1: OBU forbidden bit set (not an AV1 bitstream)");
    let size: number;
    if (hasSize) {
      size = 0; let shift = 0; let fin = false;
      for (let i = 0; i < 8; i++) { if (p >= b.length) break; const c = b[p++]; size += (c & 0x7f) * 2 ** shift; shift += 7; if (!(c & 0x80)) { fin = true; break; } }
      if (!fin) throw new Error("av1: OBU size field truncated");
    }
    else size = b.length - p;
    if (p + size > b.length) throw new Error("av1: OBU overruns the chunk");
    out.push({ type, all: b.subarray(o, p + size), payload: b.subarray(p, p + size) }); o = p + size;
  }
  return out;
}

class Bits {
  p = 0; private b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  f(n: number): number { let v = 0; for (let i = 0; i < n; i++) { const byte = this.b[this.p >> 3]; if (byte === undefined) throw new Error("av1: sequence header truncated"); v = v * 2 + ((byte >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
  uvlc(): number { let lz = 0; while (!this.f(1)) { lz++; if (lz >= 32) return 2 ** 32 - 1; } return lz ? this.f(lz) + 2 ** lz - 1 : 0; }
}

/** AV1 spec §5.5 sequence_header_obu(), as far as color_config() */
export function parseSequenceHeader(obu: Uint8Array, payload: Uint8Array): Av1Seq {
  const r = new Bits(payload);
  const profile = r.f(3); r.f(1); const reduced = r.f(1);
  let level = 0, tier = 0;
  if (reduced) level = r.f(5);
  else {
    const timing = r.f(1); let dmi = 0, bufLen = 0;
    if (timing) { r.f(32); r.f(32); if (r.f(1)) r.uvlc(); dmi = r.f(1); if (dmi) { bufLen = r.f(5) + 1; r.f(32); r.f(5); r.f(5); } }
    const idd = r.f(1); const ops = r.f(5) + 1;
    for (let i = 0; i < ops; i++) {
      r.f(12); const lv = r.f(5); const tr = lv > 7 ? r.f(1) : 0;
      if (i === 0) { level = lv; tier = tr; }
      if (dmi && r.f(1)) { r.f(bufLen); r.f(bufLen); r.f(1); }
      if (idd && r.f(1)) r.f(4);
    }
  }
  const wb = r.f(4) + 1, hb = r.f(4) + 1; const width = r.f(wb) + 1, height = r.f(hb) + 1;
  const fid = reduced ? 0 : r.f(1); if (fid) { r.f(4); r.f(3); }
  r.f(1); r.f(1); r.f(1);
  if (!reduced) {
    r.f(1); r.f(1); r.f(1); r.f(1); const oh = r.f(1); if (oh) { r.f(1); r.f(1); }
    const choose = r.f(1); const force = choose ? 2 : r.f(1);
    if (force > 0) { const ci = r.f(1); if (!ci) r.f(1); }
    if (oh) r.f(3);
  }
  r.f(1); r.f(1); r.f(1);
  const hbd = r.f(1); let twelve = 0; if (profile === 2 && hbd) twelve = r.f(1);
  const bitDepth = profile === 2 && hbd ? (twelve ? 12 : 10) : hbd ? 10 : 8; void bitDepth;
  const mono = profile === 1 ? 0 : r.f(1);
  let cp = 2, tc = 2, mc = 2; if (r.f(1)) { cp = r.f(8); tc = r.f(8); mc = r.f(8); }
  let range = 0, ssx = 1, ssy = 1, csp = 0;
  if (mono) range = r.f(1);
  else if (cp === 1 && tc === 13 && mc === 0) { range = 1; ssx = 0; ssy = 0; }
  else {
    range = r.f(1);
    if (profile === 0) { ssx = 1; ssy = 1; } else if (profile === 1) { ssx = 0; ssy = 0; }
    else if (twelve) { ssx = r.f(1); ssy = ssx ? r.f(1) : 0; } else { ssx = 1; ssy = 0; }
    if (ssx && ssy) csp = r.f(2);
  }
  return { profile, level, tier, highBitdepth: !!hbd, twelveBit: !!twelve, mono: !!mono, ssx, ssy, csp, primaries: cp, transfer: tc, matrix: mc, fullRange: !!range, width, height, obu };
}

/** AV1CodecConfigurationRecord (AV1-ISOBMFF §2.3.3) with the sequence header as its configOBUs */
export function av1C(s: Av1Seq): Uint8Array {
  return cat([new Uint8Array([0x81, (s.profile << 5) | s.level,
    (s.tier << 7) | (+s.highBitdepth << 6) | (+s.twelveBit << 5) | (+s.mono << 4) | (s.ssx << 3) | (s.ssy << 2) | s.csp, 0]), s.obu]);
}

const box = (type: string, ...parts: Uint8Array[]) => { const body = cat(parts); return cat([be32(body.length + 8), asc(type), body]); };
const full = (type: string, v: number, flags: number, ...parts: Uint8Array[]) => box(type, new Uint8Array([v, flags >> 16, (flags >> 8) & 255, flags & 255]), ...parts);
const u16 = (v: number) => new Uint8Array([v >> 8, v & 255]);

/**
 * Still-image HEIF writer (ISO 23008-12 / MIAF): ftyp, meta { hdlr pict, pitm, iloc, iinf { infe }, iprp { ipco, ipma } }, mdat.
 * itemType "av01" + av1C config -> AVIF (AV1 Image File Format 1.1); "hvc1" + hvcC -> HEIC.
 */
export function writeHeifStill(o: { itemType: "av01" | "hvc1"; config: Uint8Array; width: number; height: number; data: Uint8Array; bitDepth?: number; nclx?: { primaries: number; transfer: number; matrix: number; fullRange: boolean }; exif?: Uint8Array | null }): Uint8Array {
  const avif = o.itemType === "av01";
  const ftyp = box("ftyp", asc(avif ? "avif" : "heic"), be32(0), asc("mif1"), asc(avif ? "avif" : "heic"), asc("miaf"));
  const hdlr = full("hdlr", 0, 0, be32(0), asc("pict"), new Uint8Array(12), new Uint8Array([0]));
  const pitm = full("pitm", 0, 0, u16(1));
  const infe = (id: number, type: string) => full("infe", 2, 0, u16(id), u16(0), asc(type), new Uint8Array([0]));
  const items = [infe(1, o.itemType)]; if (o.exif) items.push(infe(2, "Exif"));
  const iinf = full("iinf", 0, 0, u16(items.length), ...items);
  const props = [box("ispe", new Uint8Array(4), be32(o.width), be32(o.height)), box(avif ? "av1C" : "hvcC", o.config),
    box("pixi", new Uint8Array([0, 0, 0, 0, 3, o.bitDepth ?? 8, o.bitDepth ?? 8, o.bitDepth ?? 8]))];
  if (o.nclx) props.push(box("colr", asc("nclx"), u16(o.nclx.primaries), u16(o.nclx.transfer), u16(o.nclx.matrix), new Uint8Array([o.nclx.fullRange ? 0x80 : 0])));
  // ipma: item 1 -> ispe, codec config (essential), pixi, colr; (the Exif item takes no properties)
  const assoc = [1, 0x80 | 2, 3, ...(o.nclx ? [4] : [])];
  const ipma = full("ipma", 0, 0, be32(1), u16(1), new Uint8Array([assoc.length, ...assoc]));
  const iprp = box("iprp", box("ipco", ...props), ipma);
  const exifPayload = o.exif ? cat([be32(0), o.exif]) : null; // ExifDataBlock: 4-byte offset to the TIFF header
  const build = (mdatStart: number) => {
    const iloc = full("iloc", 0, 0, new Uint8Array([0x44, 0x00]), u16(items.length),
      u16(1), u16(0), u16(1), be32(mdatStart), be32(o.data.length),
      ...(exifPayload ? [u16(2), u16(0), u16(1), be32(mdatStart + o.data.length), be32(exifPayload.length)] : []));
    // iref/cdsc: the Exif item "describes" the image item — without it libheif / libavif ignore the metadata (HEIF §8.11.12)
    const iref = exifPayload ? [full("iref", 0, 0, box("cdsc", u16(2), u16(1), u16(1)))] : [];
    return full("meta", 0, 0, hdlr, pitm, iloc, iinf, ...iref, iprp);
  };
  const meta0 = build(0); const mdatStart = ftyp.length + meta0.length + 8;
  const meta = build(mdatStart);
  return cat([ftyp, meta, box("mdat", o.data, ...(exifPayload ? [exifPayload] : []))]);
}

/** AVIF from one AV1 key-frame chunk (as WebCodecs emits it): strips temporal delimiters, derives av1C + colr */
export function avifFromAv1(chunk: Uint8Array, exif?: Uint8Array | null): { bytes: Uint8Array; seq: Av1Seq } {
  const list = obus(chunk);
  const sh = list.find((x) => x.type === 1); if (!sh) throw new Error("av1: no sequence header in the key frame");
  const seq = parseSequenceHeader(sh.all, sh.payload);
  const data = cat(list.filter((x) => x.type !== 2 && x.type !== 8 && x.type !== 15).map((x) => x.all));
  const nclx = { primaries: seq.primaries, transfer: seq.transfer, matrix: seq.matrix, fullRange: seq.fullRange };
  const bytes = writeHeifStill({ itemType: "av01", config: av1C(seq), width: seq.width, height: seq.height, data, bitDepth: seq.twelveBit ? 12 : seq.highBitdepth ? 10 : 8, nclx, exif });
  return { bytes, seq };
}

/* ------------------------------------------------------------------ browser entry ------ */

export type ExportFormat = "png" | "jpeg" | "webp" | "avif" | "heic" | "gif" | "bmp";
export interface EncodeOptions { format: ExportFormat; quality?: number; exif?: Uint8Array | null }
export interface EncodeResult { bytes: Uint8Array; mime: string; format: ExportFormat; note?: string }

type Canv = HTMLCanvasElement | OffscreenCanvas;
const toBlob = (c: Canv, type: string, q?: number): Promise<Blob> => "convertToBlob" in c ? c.convertToBlob({ type, quality: q }) : new Promise((res, rej) => (c as HTMLCanvasElement).toBlob((b) => b ? res(b) : rej(new Error("encoder returned nothing")), type, q));

/** which export formats this browser can really produce (probed, cached) */
let caps: Promise<Record<ExportFormat, boolean>> | null = null;
export function exportCapabilities(): Promise<Record<ExportFormat, boolean>> {
  caps ??= (async () => {
    const c: Canv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(2, 2) : Object.assign(document.createElement("canvas"), { width: 2, height: 2 });
    c.getContext("2d")!.fillRect(0, 0, 2, 2);
    const ok = async (t: string) => { try { return (await toBlob(c, t)).type === t; } catch { return false; } };
    const VE = (globalThis as { VideoEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> } }).VideoEncoder;
    const ve = async (codec: string) => { try { return !!VE && !!(await VE.isConfigSupported({ codec, width: 64, height: 64 })).supported; } catch { return false; } };
    return { gif: true, bmp: true, png: await ok("image/png"), jpeg: await ok("image/jpeg"), webp: await ok("image/webp"), avif: await ok("image/avif") || await ve("av01.0.08M.08"), heic: await ve("hvc1.1.6.L120.B0") };
  })();
  return caps;
}

export async function encodeImage(c: Canv, o: EncodeOptions): Promise<EncodeResult> {
  const q = Math.min(1, Math.max(0.05, o.quality ?? 0.9));
  if (o.format === "png" || o.format === "jpeg" || o.format === "webp") {
    const mime = `image/${o.format}`; const blob = await toBlob(c, mime, o.format === "png" ? undefined : q);
    if (blob.type !== mime) throw new Error(`this browser cannot encode ${o.format.toUpperCase()} (it produced ${blob.type})`);
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
    if (o.exif) bytes = o.format === "jpeg" ? injectExifJpeg(bytes, o.exif) : o.format === "png" ? injectExifPng(bytes, o.exif) : injectExifWebp(bytes, o.exif, c.width, c.height);
    return { bytes, mime, format: o.format };
  }
  if (o.format === "gif" || o.format === "bmp") {
    // TT59 (FF-05): our own encoders (src/lib/image/rasterenc.ts) — canvases only encode PNG / JPEG / WebP. Neither
    // container carries our curated EXIF, so metadata is never embedded (said in the note when it was asked for).
    const ctx = (c as HTMLCanvasElement).getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error("no 2D canvas context to read pixels from");
    const px = ctx.getImageData(0, 0, c.width, c.height);
    const img = { width: c.width, height: c.height, data: px.data };
    const bytes = o.format === "gif" ? encodeGif(img) : encodeBmp(img);
    return { bytes, mime: o.format === "gif" ? "image/gif" : "image/bmp", format: o.format, note: `Fusion ${o.format.toUpperCase()} encoder${o.format === "gif" ? " (256 colours, dithered)" : " (24-bit, transparency over white)"}${o.exif ? "; metadata not embedded" : ""}` };
  }
  if (o.format === "avif") {
    // a platform AVIF encoder cannot embed EXIF: when metadata was asked for, our writer (which can) goes first
    const webcodecs = typeof VideoEncoder !== "undefined";
    const native = o.exif && webcodecs ? null : await toBlob(c, "image/avif", q).catch(() => null);
    if (native?.type === "image/avif") return { bytes: new Uint8Array(await native.arrayBuffer()), mime: "image/avif", format: "avif", note: "platform AVIF encoder" + (o.exif ? " (EXIF not embedded)" : "") };
    const chunk = await encodeKeyframe(c, "av01.0.08M.08", q);
    const { bytes } = avifFromAv1(chunk, o.exif ?? null);
    return { bytes, mime: "image/avif", format: "avif", note: "WebCodecs AV1 + Fusion AVIF writer (no alpha channel)" };
  }
  throw new Error("HEIC export needs a platform HEVC encoder; this browser has none (VideoEncoder rejects hvc1). Choose AVIF, WebP, JPEG or PNG.");
}

/** one AV1 key frame through WebCodecs; quality 0..1 maps to the AV1 quantizer 63..0 */
async function encodeKeyframe(c: Canv, codec: string, q: number): Promise<Uint8Array> {
  type VE = { configure(c: unknown): void; encode(f: unknown, o: unknown): void; flush(): Promise<void>; close(): void };
  const G = globalThis as unknown as { VideoEncoder?: new (i: { output: (ch: { byteLength: number; copyTo(b: Uint8Array): void }) => void; error: (e: Error) => void }) => VE; VideoFrame?: new (c: Canv, i: { timestamp: number }) => { close(): void } };
  if (!G.VideoEncoder || !G.VideoFrame) throw new Error("this browser has no WebCodecs VideoEncoder: AVIF export is unavailable");
  let out: Uint8Array | null = null; let err: Error | null = null;
  const enc = new G.VideoEncoder({ output: (ch) => { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); out ??= b; }, error: (e) => { err = e; } });
  enc.configure({ codec, width: c.width, height: c.height, bitrateMode: "quantizer" });
  const f = new G.VideoFrame(c, { timestamp: 0 });
  enc.encode(f, { keyFrame: true, av1: { quantizer: Math.round((1 - q) * 63) } }); f.close();
  await enc.flush(); enc.close();
  if (err) throw err;
  if (!out) throw new Error("the AV1 encoder produced no frame");
  return out;
}
