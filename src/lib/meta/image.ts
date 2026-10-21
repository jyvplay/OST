/**
 * TT54 (FF-13) — still-image container walker, original code from the format specifications:
 * JPEG (ITU T.81 markers, JFIF, Exif APP1, XMP APP1, ICC APP2), PNG (ISO 15948 + eXIf / acTL), GIF89a,
 * WebP (RIFF: VP8 / VP8L / VP8X / ANMF / EXIF / XMP), BMP, TIFF, HEIF / AVIF (ISO 23008-12: meta > pitm / iinf /
 * iloc / iprp > ipco + ipma; ispe, irot, imir), SVG (root attributes), ICO.
 * Output: pixel size (as stored, plus the display size after EXIF / irot rotation), frame count, and the raw
 * EXIF (TIFF stream) / XMP packet / PNG text for the higher layers. Never decodes pixels.
 */
import { isTiff } from "./exif";

export interface ImageInfo {
  format: string; mime: string;
  width: number; height: number;
  frames: number;
  /** HEIF irot (counter-clockwise quarter turns) / imir, applied by every HEIF reader on display */
  heifRotation?: number; heifMirror?: number;
  exif: Uint8Array | null; xmp: string | null; icc: boolean;
  text: Record<string, string>;
  bitDepth?: number; colorType?: string; hasAlpha?: boolean; progressive?: boolean;
  warnings: string[];
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32le = (b: Uint8Array, o: number) => (u24le(b, o) + ((b[o + 3] << 24) >>> 0));
const ascii = (b: Uint8Array, o: number, n: number) => { let s = ""; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
const latin1 = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return s; };
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const startsWith = (b: Uint8Array, s: string, o = 0) => ascii(b, o, s.length) === s;

export function sniffImage(b: Uint8Array, name = ""): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (startsWith(b, "\x89PNG\r\n\x1a\n")) return "png";
  if (startsWith(b, "GIF87a") || startsWith(b, "GIF89a")) return "gif";
  if (startsWith(b, "RIFF") && startsWith(b, "WEBP", 8)) return "webp";
  if (startsWith(b, "BM") && b.length > 26) return "bmp";
  if (isTiff(b)) return "tiff";
  if (startsWith(b, "ftyp", 4)) {
    const brands = [ascii(b, 8, 4)]; const size = u32be(b, 0);
    for (let o = 16; o + 4 <= Math.min(size, b.length, 256); o += 4) brands.push(ascii(b, o, 4));
    if (brands.some((x) => x === "avif" || x === "avis")) return "avif";
    if (brands.some((x) => /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(x))) return "heif";
  }
  if (b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ico";
  const head = utf8(b.subarray(0, 4096)).replace(/^\uFEFF/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head) || (/\.svgz?$/i.test(name) && /<svg[\s>]/i.test(head))) return "svg";
  return null;
}

const MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff", heif: "image/heif", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon" };

export async function readImage(b: Uint8Array, name = "", inflate?: (d: Uint8Array) => Promise<Uint8Array>): Promise<ImageInfo | null> {
  const format = sniffImage(b, name); if (!format) return null;
  const info: ImageInfo = { format, mime: MIME[format], width: 0, height: 0, frames: 1, exif: null, xmp: null, icc: false, text: {}, warnings: [] };
  try {
    switch (format) {
      case "jpeg": jpeg(b, info); break;
      case "png": await png(b, info, inflate); break;
      case "gif": gif(b, info); break;
      case "webp": webp(b, info); break;
      case "bmp": info.width = Math.abs(u32le(b, 18) | 0); info.height = Math.abs(u32le(b, 22) | 0); info.bitDepth = u16le(b, 28); break;
      case "tiff": tiff(b, info); break;
      case "heif": case "avif": heif(b, info); break;
      case "svg": svg(b, info); break;
      case "ico": { const n = u16le(b, 4); info.frames = n; info.width = b[6] || 256; info.height = b[7] || 256; break; }
    }
  } catch (e) { info.warnings.push(`${format}: ${(e as Error).message}`); }
  return info;
}

const XMP_SIG = "http://ns.adobe.com/xap/1.0/\0";

function jpeg(b: Uint8Array, info: ImageInfo) {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { info.warnings.push(`jpeg: marker expected at ${o}`); return; }
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (m === 0xd9 || m === 0xda) return;
    const len = u16be(b, o + 2); const s = o + 4, e = o + 2 + len;
    if (len < 2 || e > b.length) { info.warnings.push("jpeg: segment overruns the file"); return; }
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      info.bitDepth = b[s]; info.height = u16be(b, s + 1); info.width = u16be(b, s + 3);
      const nc = b[s + 5]; info.colorType = nc === 1 ? "gray" : nc === 3 ? "YCbCr" : nc === 4 ? "CMYK" : `${nc} components`;
      info.progressive = m === 0xc2 || m === 0xc6 || m === 0xca || m === 0xce;
    } else if (m === 0xe1 && !info.exif && startsWith(b, "Exif\0", s) && isTiff(b, s + 6)) info.exif = b.subarray(s + 6, e);
    else if (m === 0xe1 && !info.xmp && startsWith(b, XMP_SIG, s)) info.xmp = utf8(b.subarray(s + XMP_SIG.length, e));
    else if (m === 0xe2 && startsWith(b, "ICC_PROFILE\0", s)) info.icc = true;
    else if (m === 0xfe) info.text.comment = (info.text.comment ? info.text.comment + "\n" : "") + latin1(b.subarray(s, e)).replace(/\0+$/, "");
    o = e;
  }
}

async function png(b: Uint8Array, info: ImageInfo, inflate?: (d: Uint8Array) => Promise<Uint8Array>) {
  let o = 8;
  while (o + 12 <= b.length) {
    const len = u32be(b, o), type = ascii(b, o + 4, 4), s = o + 8, e = s + len;
    if (e + 4 > b.length) { info.warnings.push(`png: ${type} chunk overruns the file`); return; }
    const d = b.subarray(s, e);
    if (type === "IHDR") {
      info.width = u32be(d, 0); info.height = u32be(d, 4); info.bitDepth = d[8];
      const ct = d[9]; info.colorType = ["gray", "", "RGB", "palette", "gray+alpha", "", "RGBA"][ct] ?? `type ${ct}`; info.hasAlpha = ct === 4 || ct === 6;
    } else if (type === "acTL") info.frames = u32be(d, 0) || 1;
    else if (type === "tRNS") info.hasAlpha = true;
    else if (type === "iCCP") info.icc = true;
    else if (type === "eXIf" && isTiff(d)) info.exif = d;
    else if (type === "tEXt") { const z = d.indexOf(0); if (z > 0) info.text[latin1(d.subarray(0, z))] = latin1(d.subarray(z + 1)); }
    else if (type === "zTXt" && inflate) {
      const z = d.indexOf(0); if (z > 0 && d[z + 1] === 0) {
        try { info.text[latin1(d.subarray(0, z))] = latin1(await inflate(d.subarray(z + 2))); } catch { info.warnings.push("png: bad zTXt"); }
      }
    } else if (type === "iTXt") {
      const z = d.indexOf(0); if (z > 0) {
        const key = latin1(d.subarray(0, z)), comp = d[z + 1];
        const l = d.indexOf(0, z + 3), t2 = l >= 0 ? d.indexOf(0, l + 1) : -1;
        if (t2 >= 0) {
          let txt: string | null = null;
          if (!comp) txt = utf8(d.subarray(t2 + 1));
          else if (inflate) { try { txt = utf8(await inflate(d.subarray(t2 + 1))); } catch { info.warnings.push("png: bad iTXt"); } }
          if (txt !== null) { if (key === "XML:com.adobe.xmp") info.xmp = txt; else info.text[key] = txt; }
        }
      }
    } else if (type === "IEND") return;
    o = e + 4;
  }
}

function gif(b: Uint8Array, info: ImageInfo) {
  info.width = u16le(b, 6); info.height = u16le(b, 8);
  let o = 13; const f = b[10]; if (f & 0x80) o += 3 * (1 << ((f & 7) + 1));
  let frames = 0;
  const skipSub = (p: number) => { while (p < b.length) { const n = b[p]; p++; if (!n) return p; p += n; } return p; };
  while (o < b.length) {
    const c = b[o];
    if (c === 0x3b) break;
    if (c === 0x2c) {
      frames++; const lf = b[o + 9]; o += 10; if (lf & 0x80) o += 3 * (1 << ((lf & 7) + 1));
      o = skipSub(o + 1);
    } else if (c === 0x21) {
      const label = b[o + 1];
      if (label === 0xfe) { let p = o + 2, t = ""; while (p < b.length && b[p]) { t += latin1(b.subarray(p + 1, p + 1 + b[p])); p += b[p] + 1; } info.text.comment = t; o = p + 1; }
      else if (label === 0xff && startsWith(b, "XMP DataXMP", o + 3)) {
        // XMP application extension: raw bytes up to the 257-byte "magic trailer", not sub-blocked
        const s = o + 14; let e = s; while (e < b.length && b[e] !== 0x01) e++;
        info.xmp = utf8(b.subarray(s, e)); o = skipSub(o + 2);
      } else o = skipSub(o + 2);
    } else { info.warnings.push(`gif: unknown block 0x${c.toString(16)} at ${o}`); break; }
  }
  info.frames = Math.max(1, frames);
}

function webp(b: Uint8Array, info: ImageInfo) {
  let o = 12; let frames = 0; const end = Math.min(b.length, 8 + u32le(b, 4));
  while (o + 8 <= end) {
    const type = ascii(b, o, 4), len = u32le(b, o + 4), s = o + 8;
    if (s + len > b.length) { info.warnings.push(`webp: ${type} overruns`); break; }
    if (type === "VP8X") { info.width = u24le(b, s + 4) + 1; info.height = u24le(b, s + 7) + 1; info.hasAlpha = !!(b[s] & 0x10); }
    else if (type === "VP8 " && !info.width) { if (b[s + 3] === 0x9d && b[s + 4] === 0x01 && b[s + 5] === 0x2a) { info.width = u16le(b, s + 6) & 0x3fff; info.height = u16le(b, s + 8) & 0x3fff; } }
    else if (type === "VP8L" && !info.width && b[s] === 0x2f) { const v = u32le(b, s + 1); info.width = (v & 0x3fff) + 1; info.height = ((v >>> 14) & 0x3fff) + 1; info.hasAlpha = !!((v >>> 28) & 1); }
    else if (type === "ANMF") frames++;
    else if (type === "ICCP") info.icc = true;
    else if (type === "EXIF") { let d = b.subarray(s, s + len); if (startsWith(d, "Exif\0\0")) d = d.subarray(6); if (isTiff(d)) info.exif = d; }
    else if (type === "XMP ") info.xmp = utf8(b.subarray(s, s + len));
    o = s + len + (len & 1);
  }
  info.frames = Math.max(1, frames);
}

function tiff(b: Uint8Array, info: ImageInfo) {
  info.exif = b;
  const le = b[0] === 0x49; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const off = dv.getUint32(4, le); if (off + 2 > b.length) return;
  const n = dv.getUint16(off, le);
  for (let i = 0; i < n && off + 2 + i * 12 + 12 <= b.length; i++) {
    const e = off + 2 + i * 12, tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le);
    const v = type === 3 ? dv.getUint16(e + 8, le) : dv.getUint32(e + 8, le);
    if (tag === 0x100) info.width = v; else if (tag === 0x101) info.height = v;
    else if (tag === 0x2bc) { const c = dv.getUint32(e + 4, le), vo = dv.getUint32(e + 8, le); if (vo + c <= b.length) info.xmp = utf8(b.subarray(vo, vo + c)); }
    else if (tag === 0x8773) info.icc = true;
  }
  let frames = 0, p = off; const seen = new Set<number>();
  while (p && p + 2 <= b.length && !seen.has(p) && frames < 10000) { seen.add(p); frames++; const k = dv.getUint16(p, le); const nx = p + 2 + k * 12; p = nx + 4 <= b.length ? dv.getUint32(nx, le) : 0; }
  info.frames = Math.max(1, frames);
}

interface Bx { type: string; s: number; e: number }
function boxesIn(b: Uint8Array, s: number, e: number): Bx[] {
  const out: Bx[] = []; let o = s;
  while (o + 8 <= e && out.length < 10000) {
    let size = u32be(b, o); const type = ascii(b, o + 4, 4); let h = 8;
    if (size === 1) { size = u32be(b, o + 8) * 2 ** 32 + u32be(b, o + 12); h = 16; } else if (size === 0) size = e - o;
    if (size < h || o + size > e) break;
    out.push({ type, s: o + h, e: o + size }); o += size;
  }
  return out;
}

/** HEIF / AVIF: primary item size + rotation, Exif item, XMP item. Shared with the AVIF writer's self-check. */
export function heif(b: Uint8Array, info: ImageInfo) {
  const top = boxesIn(b, 0, b.length);
  const meta = top.find((x) => x.type === "meta"); if (!meta) { info.warnings.push("heif: no meta box"); return; }
  const kids = boxesIn(b, meta.s + 4, meta.e);
  const pitm = kids.find((x) => x.type === "pitm");
  const primary = pitm ? (b[pitm.s] === 0 ? u16be(b, pitm.s + 4) : u32be(b, pitm.s + 4)) : 1;
  const items = new Map<number, { type: string; mime: string }>();
  const iinf = kids.find((x) => x.type === "iinf");
  if (iinf) {
    const v = b[iinf.s]; const first = iinf.s + 4 + (v === 0 ? 2 : 4);
    for (const infe of boxesIn(b, first, iinf.e)) {
      if (infe.type !== "infe") continue;
      const iv = b[infe.s]; if (iv < 2) continue;
      let p = infe.s + 4; const id = iv === 2 ? u16be(b, p) : u32be(b, p); p += iv === 2 ? 2 : 4; p += 2;
      const type = ascii(b, p, 4); p += 4;
      while (p < infe.e && b[p]) p++; p++;
      let mime = ""; if (type === "mime") { const q = p; while (p < infe.e && b[p]) p++; mime = ascii(b, q, p - q); }
      items.set(id, { type, mime });
    }
  }
  const locs = new Map<number, { method: number; ext: [number, number][] }>();
  const iloc = kids.find((x) => x.type === "iloc"); const idat = kids.find((x) => x.type === "idat");
  if (iloc) {
    const v = b[iloc.s]; let p = iloc.s + 4;
    const os = b[p] >> 4, ls = b[p] & 15, bs = b[p + 1] >> 4, is = v >= 1 ? b[p + 1] & 15 : 0; p += 2;
    const rd = (n: number) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + b[p + i]; p += n; return x; };
    const count = v < 2 ? rd(2) : rd(4);
    for (let i = 0; i < count && p < iloc.e; i++) {
      const id = v < 2 ? rd(2) : rd(4); const method = v >= 1 ? rd(2) & 15 : 0; rd(2);
      const base = rd(bs); const n = rd(2); const ext: [number, number][] = [];
      for (let k = 0; k < n; k++) { if (is) rd(is); ext.push([base + rd(os), rd(ls)]); }
      locs.set(id, { method, ext });
    }
  }
  const itemBytes = (id: number): Uint8Array | null => {
    const l = locs.get(id); if (!l || !l.ext.length) return null;
    const src = l.method === 1 && idat ? b.subarray(idat.s, idat.e) : b;
    const parts = l.ext.map(([o, n]) => src.subarray(o, n ? o + n : src.length));
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0)); let q = 0; for (const x of parts) { out.set(x, q); q += x.length; } return out;
  };
  const iprp = kids.find((x) => x.type === "iprp");
  if (iprp) {
    const ip = boxesIn(b, iprp.s, iprp.e); const ipco = ip.find((x) => x.type === "ipco"); const ipma = ip.find((x) => x.type === "ipma");
    const props = ipco ? boxesIn(b, ipco.s, ipco.e) : [];
    if (ipma) {
      const v = b[ipma.s], flags = b[ipma.s + 3]; let p = ipma.s + 4; const n = u32be(b, p); p += 4;
      for (let i = 0; i < n && p < ipma.e; i++) {
        const id = v < 1 ? u16be(b, p) : u32be(b, p); p += v < 1 ? 2 : 4; const k = b[p++];
        for (let j = 0; j < k; j++) {
          const idx = flags & 1 ? u16be(b, p) & 0x7fff : b[p] & 0x7f; p += flags & 1 ? 2 : 1;
          if (id !== primary) continue;
          const pr = props[idx - 1]; if (!pr) continue;
          if (pr.type === "ispe") { info.width = u32be(b, pr.s + 4); info.height = u32be(b, pr.s + 8); }
          else if (pr.type === "irot") info.heifRotation = b[pr.s] & 3;
          else if (pr.type === "imir") info.heifMirror = b[pr.s] & 1;
          else if (pr.type === "colr" && ascii(b, pr.s, 4) !== "nclx") info.icc = true;
          else if (pr.type === "pixi") info.bitDepth = b[pr.s + 5];
        }
      }
    }
  }
  for (const [id, it] of items) {
    if (it.type === "Exif" && !info.exif) { const d = itemBytes(id); if (d && d.length > 4) { const off = u32be(d, 0); if (isTiff(d, 4 + off)) info.exif = d.subarray(4 + off); } }
    else if (it.type === "mime" && /rdf\+xml/.test(it.mime) && !info.xmp) { const d = itemBytes(id); if (d) info.xmp = utf8(d); }
  }
  const prim = items.get(primary); if (prim?.type === "grid") info.colorType = "grid";
}

function svg(b: Uint8Array, info: ImageInfo) {
  const s = utf8(b.subarray(0, Math.min(b.length, 1 << 20)));
  const tag = s.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const attr = (n: string) => tag.match(new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const len = (v?: string) => { if (!v) return NaN; const m = v.trim().match(/^([\d.]+)\s*(px|pt|mm|cm|in)?$/i); if (!m) return NaN; const k = { px: 1, pt: 4 / 3, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[(m[2] ?? "px").toLowerCase() as "px"] ?? 1; return parseFloat(m[1]) * k; };
  const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  let w = len(attr("width")), h = len(attr("height"));
  if (vb && vb.length === 4 && vb.every(Number.isFinite)) { if (!Number.isFinite(w) && !Number.isFinite(h)) { w = vb[2]; h = vb[3]; } else if (!Number.isFinite(w)) w = h * vb[2] / vb[3]; else if (!Number.isFinite(h)) h = w * vb[3] / vb[2]; }
  info.width = Number.isFinite(w) ? Math.round(w) : 0; info.height = Number.isFinite(h) ? Math.round(h) : 0;
  const title = s.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]; if (title?.trim()) info.text.title = title.trim();
  const md = s.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>|<rdf:RDF[\s\S]*?<\/rdf:RDF>/); if (md) info.xmp = md[0];
}
