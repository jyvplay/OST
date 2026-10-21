/**
 * TT54 (FF-13) — EXIF / TIFF IFD reader, original code written from the TIFF 6.0 and CIPA DC-008 (Exif 2.32)
 * layouts. Isomorphic (browser, worker, Node). Input: a TIFF stream ("II*\0" / "MM\0*"), as found in a JPEG APP1
 * after "Exif\0\0", a PNG eXIf chunk, a WebP EXIF chunk, a HEIF Exif item (after its 4-byte offset) or a .tif file.
 *
 * Hostile-input guards: every offset is bounds-checked, an IFD visited twice is skipped (cycles), at most
 * MAX_ENTRIES entries per IFD and MAX_IFDS IFDs per stream, values larger than MAX_VALUE bytes are summarised
 * (byte length) rather than copied. A bad entry is skipped with a warning; it never aborts the whole stream.
 */

export type ExifValue = number | string | number[] | Uint8Array;
export interface ExifIfds {
  /** tag id -> value, per IFD; numbers for one-count numeric tags, arrays for counts > 1, rationals as floats */
  ifd0: Map<number, ExifValue>;
  exif: Map<number, ExifValue>;
  gps: Map<number, ExifValue>;
  interop: Map<number, ExifValue>;
  ifd1: Map<number, ExifValue>;
  /** raw TIFF type per tag ("ifd:tag" -> type) so a writer can re-emit faithfully */
  types: Map<string, number>;
  /** raw value bytes per tag ("ifd:tag"), in the stream's byte order (≤ 1 MiB values) — the export writer copies them */
  raw: Map<string, { type: number; count: number; bytes: Uint8Array }>;
  littleEndian: boolean;
  /** JPEG thumbnail in IFD1 (JPEGInterchangeFormat / Length), when present and in bounds */
  thumbnail: Uint8Array | null;
  warnings: string[];
}

const MAX_ENTRIES = 1000, MAX_IFDS = 16, MAX_VALUE = 1 << 20;
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

export const TAG = {
  ImageWidth: 0x0100, ImageLength: 0x0101, Make: 0x010f, Model: 0x0110, Orientation: 0x0112, Software: 0x0131,
  DateTime: 0x0132, Artist: 0x013b, Copyright: 0x8298, ImageDescription: 0x010e, ExifIFD: 0x8769, GPSIFD: 0x8825,
  InteropIFD: 0xa005, JPEGInterchangeFormat: 0x0201, JPEGInterchangeFormatLength: 0x0202,
  ExposureTime: 0x829a, FNumber: 0x829d, ExposureProgram: 0x8822, ISO: 0x8827, DateTimeOriginal: 0x9003,
  DateTimeDigitized: 0x9004, OffsetTimeOriginal: 0x9011, ShutterSpeedValue: 0x9201, ApertureValue: 0x9202,
  ExposureBiasValue: 0x9204, MeteringMode: 0x9207, Flash: 0x9209, FocalLength: 0x920a, MakerNote: 0x927c,
  UserComment: 0x9286, SubSecTimeOriginal: 0x9291, ColorSpace: 0xa001, PixelXDimension: 0xa002, PixelYDimension: 0xa003,
  FocalLengthIn35mm: 0xa405, LensMake: 0xa433, LensModel: 0xa434, BodySerialNumber: 0xa431, WhiteBalance: 0xa403,
  GPSLatitudeRef: 0x0001, GPSLatitude: 0x0002, GPSLongitudeRef: 0x0003, GPSLongitude: 0x0004, GPSAltitudeRef: 0x0005,
  GPSAltitude: 0x0006, GPSTimeStamp: 0x0007, GPSDateStamp: 0x001d,
} as const;

export function isTiff(b: Uint8Array, o = 0): boolean {
  return b.length >= o + 8 && ((b[o] === 0x49 && b[o + 1] === 0x49 && b[o + 2] === 42 && b[o + 3] === 0) || (b[o] === 0x4d && b[o + 1] === 0x4d && b[o + 2] === 0 && b[o + 3] === 42));
}

export function readExif(t: Uint8Array): ExifIfds {
  const out: ExifIfds = { ifd0: new Map(), exif: new Map(), gps: new Map(), interop: new Map(), ifd1: new Map(), types: new Map(), raw: new Map(), littleEndian: true, thumbnail: null, warnings: [] };
  if (!isTiff(t)) { out.warnings.push("exif: not a TIFF stream"); return out; }
  const le = t[0] === 0x49; out.littleEndian = le;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le), u32 = (o: number) => dv.getUint32(o, le);
  const seen = new Set<number>(); let ifds = 0;

  const readIfd = (off: number, into: Map<number, ExifValue>, name: string): number => {
    if (off < 8 || off + 2 > t.length) { if (off) out.warnings.push(`exif: ${name} offset ${off} out of range`); return 0; }
    if (seen.has(off) || ++ifds > MAX_IFDS) { out.warnings.push(`exif: ${name} at ${off} revisited (cycle) or too many IFDs`); return 0; }
    seen.add(off);
    const n = u16(off);
    if (n > MAX_ENTRIES) { out.warnings.push(`exif: ${name} claims ${n} entries`); return 0; }
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) { out.warnings.push(`exif: ${name} truncated at entry ${i}`); return 0; }
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const sz = TYPE_SIZE[type] ?? 0;
      if (!sz) { out.warnings.push(`exif: ${name} tag 0x${tag.toString(16)} has unknown type ${type}`); continue; }
      const bytes = sz * count;
      if (!Number.isFinite(bytes) || count > 0x7fffffff) continue;
      const vo = bytes <= 4 ? e + 8 : u32(e + 8);
      if (vo + bytes > t.length || vo < 0) { out.warnings.push(`exif: ${name} tag 0x${tag.toString(16)} value out of range`); continue; }
      out.types.set(`${name}:${tag}`, type);
      if (bytes > MAX_VALUE) { into.set(tag, `(${bytes} bytes)`); continue; }
      out.raw.set(`${name}:${tag}`, { type, count, bytes: t.subarray(vo, vo + bytes) });
      into.set(tag, decodeValue(t, dv, le, type, count, vo));
    }
    const nextAt = off + 2 + n * 12;
    return nextAt + 4 <= t.length ? u32(nextAt) : 0;
  };

  const next = readIfd(u32(4), out.ifd0, "ifd0");
  const sub = (m: Map<number, ExifValue>, tag: number) => { const v = m.get(tag); return typeof v === "number" ? v : Array.isArray(v) && v.length ? v[0] : 0; };
  const exifOff = sub(out.ifd0, TAG.ExifIFD); if (exifOff) readIfd(exifOff, out.exif, "exif");
  const gpsOff = sub(out.ifd0, TAG.GPSIFD); if (gpsOff) readIfd(gpsOff, out.gps, "gps");
  const ioOff = sub(out.exif, TAG.InteropIFD); if (ioOff) readIfd(ioOff, out.interop, "interop");
  if (next) readIfd(next, out.ifd1, "ifd1");
  const jo = sub(out.ifd1, TAG.JPEGInterchangeFormat), jl = sub(out.ifd1, TAG.JPEGInterchangeFormatLength);
  if (jo && jl && jo + jl <= t.length && t[jo] === 0xff && t[jo + 1] === 0xd8) out.thumbnail = t.subarray(jo, jo + jl);
  return out;
}

function decodeValue(t: Uint8Array, dv: DataView, le: boolean, type: number, count: number, o: number): ExifValue {
  if (type === 2) { // ASCII: NUL-terminated; several strings are NUL-separated — keep up to the last non-NUL
    let end = o + count; while (end > o && (t[end - 1] === 0 || t[end - 1] === 0x20)) end--;
    return utf8OrLatin1(t.subarray(o, end));
  }
  if (type === 7 || (type === 1 && count > 4) || type === 6 && count > 4) return t.slice(o, o + count);
  const vals: number[] = [];
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1: vals.push(t[o + i]); break;
      case 6: vals.push(dv.getInt8(o + i)); break;
      case 3: vals.push(dv.getUint16(o + i * 2, le)); break;
      case 8: vals.push(dv.getInt16(o + i * 2, le)); break;
      case 4: case 13: vals.push(dv.getUint32(o + i * 4, le)); break;
      case 9: vals.push(dv.getInt32(o + i * 4, le)); break;
      // 0/0 and n/0 are "unknown" (CIPA): NaN, as Pillow and exiftool ("undef") read them
      case 5: { const n = dv.getUint32(o + i * 8, le), d = dv.getUint32(o + i * 8 + 4, le); vals.push(d ? n / d : NaN); break; }
      case 10: { const n = dv.getInt32(o + i * 8, le), d = dv.getInt32(o + i * 8 + 4, le); vals.push(d ? n / d : NaN); break; }
      case 11: vals.push(dv.getFloat32(o + i * 4, le)); break;
      case 12: vals.push(dv.getFloat64(o + i * 8, le)); break;
    }
  }
  return count === 1 ? vals[0] : vals;
}

function utf8OrLatin1(b: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b).replace(/\0+$/, ""); }
  catch { let s = ""; for (const c of b) s += String.fromCharCode(c); return s.replace(/\0+$/, ""); }
}

/** Decimal degrees from a GPS IFD, or null; negative for S / W (and for AltitudeRef 1 = below sea level). */
export function gpsFrom(g: Map<number, ExifValue>): { lat: number; lon: number; alt?: number } | null {
  // an unknown (0/0) minutes / seconds component counts as 0 when the degrees are known — the position is still useful
  const z = (x: number | undefined) => x === undefined || Number.isNaN(x) ? 0 : x;
  const dms = (v: ExifValue | undefined) => Array.isArray(v) && v.length >= 1 ? v[0] + z(v[1]) / 60 + z(v[2]) / 3600 : typeof v === "number" ? v : NaN;
  const lat = dms(g.get(TAG.GPSLatitude)), lon = dms(g.get(TAG.GPSLongitude));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0 && !g.has(TAG.GPSLatitudeRef))) return null;
  if (lat > 90 || lon > 180) return null;
  const sLat = String(g.get(TAG.GPSLatitudeRef) ?? "N").toUpperCase().startsWith("S") ? -1 : 1;
  const sLon = String(g.get(TAG.GPSLongitudeRef) ?? "E").toUpperCase().startsWith("W") ? -1 : 1;
  const out: { lat: number; lon: number; alt?: number } = { lat: sLat * lat, lon: sLon * lon };
  const alt = g.get(TAG.GPSAltitude);
  if (typeof alt === "number" && Number.isFinite(alt)) { const ref = g.get(TAG.GPSAltitudeRef); out.alt = (ref === 1 || (ref instanceof Uint8Array && ref[0] === 1)) ? -alt : alt; }
  return out;
}

/** Human-readable camera fields (the subset Photos and Files' info panel show). */
export function exifSummary(x: ExifIfds): Record<string, string> {
  const r: Record<string, string> = {};
  const s = (m: Map<number, ExifValue>, tag: number) => { const v = m.get(tag); return typeof v === "string" ? v.trim() : undefined; };
  const n = (m: Map<number, ExifValue>, tag: number) => { const v = m.get(tag); return typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : undefined; };
  const put = (k: string, v: string | undefined) => { if (v) r[k] = v; };
  put("make", s(x.ifd0, TAG.Make)); put("model", s(x.ifd0, TAG.Model)); put("software", s(x.ifd0, TAG.Software));
  put("artist", s(x.ifd0, TAG.Artist)); put("copyright", s(x.ifd0, TAG.Copyright)); put("description", s(x.ifd0, TAG.ImageDescription));
  put("lens", s(x.exif, TAG.LensModel));
  const dto = s(x.exif, TAG.DateTimeOriginal) ?? s(x.exif, TAG.DateTimeDigitized) ?? s(x.ifd0, TAG.DateTime);
  const iso = exifDate(dto, s(x.exif, TAG.OffsetTimeOriginal)); if (iso) r.dateTaken = iso;
  const et = n(x.exif, TAG.ExposureTime); if (et && et > 0) r.exposure = et >= 1 ? `${+et.toFixed(1)} s` : `1/${Math.round(1 / et)} s`;
  const fn = n(x.exif, TAG.FNumber); if (fn && fn > 0) r.fNumber = `f/${+fn.toFixed(1)}`;
  const isoV = n(x.exif, TAG.ISO); if (isoV) r.iso = `ISO ${isoV}`;
  const fl = n(x.exif, TAG.FocalLength); if (fl && fl > 0) r.focalLength = `${+fl.toFixed(1)} mm`;
  const fl35 = n(x.exif, TAG.FocalLengthIn35mm); if (fl35) r.focalLength35 = `${fl35} mm`;
  const flash = n(x.exif, TAG.Flash); if (flash !== undefined) r.flash = flash & 1 ? "fired" : "did not fire";
  return r;
}

/** "YYYY:MM:DD HH:MM:SS" (+ optional "+HH:MM" offset) -> ISO-8601, or undefined for blank / all-zero dates */
export function exifDate(s: string | undefined, offset?: string): string | undefined {
  const m = s?.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000" || m[2] === "00") return undefined;
  const off = offset && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`;
}

/** EXIF Orientation (1..8) or 1 */
export function orientationOf(x: ExifIfds): number {
  const v = x.ifd0.get(TAG.Orientation); const o = typeof v === "number" ? v : Array.isArray(v) ? v[0] : 1;
  return o >= 1 && o <= 8 ? o : 1;
}
