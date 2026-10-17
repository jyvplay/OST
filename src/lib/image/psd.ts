/**
 * FF-31 PSD codec (TT16, first-party; the competitor TT14 reader was studied, the structure follows Adobe's public
 * "Adobe Photoshop File Formats Specification"). Pure TypeScript: Node ≥ 18 and browsers (ZIP uses the standard
 * CompressionStream / DecompressionStream "deflate" = zlib format, which is what PSD compression 2/3 stores).
 *
 * READ  : version 1 (PSD), 8-bit, RGB (mode 3) or Grayscale (mode 1); compression raw / RLE / ZIP / ZIP+prediction;
 *         layer records (bounds, opacity, visibility, 12 separable blend keys, clipping flag), Unicode names (`luni`),
 *         user layer masks (channel −2, mask rect + default colour + disabled flag), group dividers (`lsct`),
 *         merged image with transparency (negative layer count). Fallback: flattened file → one Background layer.
 * WRITE : the same feature set; RLE (default), ZIP or raw; merged composite (RGBA) so viewers that only read the
 *         composite show the right picture.
 * NOT SUPPORTED (reported in `warnings`, never silently): PSB, 16/32-bit, CMYK/Lab/Indexed/Bitmap, adjustment and
 * fill layers, smart objects, type-layer engine data (rendered from pixels only), layer effects, vector masks,
 * non-separable blend modes, pass-through group blending (groups are flattened into their children), clipping masks.
 */
import { BLEND_MODES, compositeRegion, newId, validateDoc, type BlendMode, type ImageDoc, type Layer } from "./doc";

export const BLEND_KEYS: Record<BlendMode, string> = {
  normal: "norm", multiply: "mul ", screen: "scrn", overlay: "over", darken: "dark", lighten: "lite",
  "color-dodge": "div ", "color-burn": "idiv", "hard-light": "hLit", "soft-light": "sLit", difference: "diff", exclusion: "smud",
};
const KEY_TO_BLEND: Record<string, BlendMode> = Object.fromEntries(Object.entries(BLEND_KEYS).map(([k, v]) => [v, k as BlendMode]));
const MAX_PIXELS = 36_000_000;
/** Mac OS Roman 0x80–0xFF (generated from Python's mac_roman codec). Pascal layer names are MacRoman per the
 *  Adobe spec; psd-tools writes them that way and omits `luni` (found by scripts/oracle-psd.mts B). */
const MAC_ROMAN_HIGH = "\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u03a9\u00e6\u00f8\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4\uf8ff\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7";
export function decodeMacRoman(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : MAC_ROMAN_HIGH[b - 0x80];
  return s;
}
export function encodeMacRoman(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else { const k = MAC_ROMAN_HIGH.indexOf(ch); out.push(k >= 0 ? 0x80 + k : 0x3f); }
  }
  return Uint8Array.from(out);
}

export interface PsdReadResult { doc: ImageDoc; warnings: string[]; info: { mode: number; channels: number; layerRecords: number; compression: number[] } }
export type PsdCompression = "raw" | "rle" | "zip";

/* =============================================================== PackBits */
export function packBits(src: Uint8Array | Uint8ClampedArray, start = 0, end = src.length): Uint8Array {
  const out: number[] = [];
  let i = start;
  while (i < end) {
    // repeat run?
    let run = 1;
    while (i + run < end && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 3 || (run === 2 && i + 2 >= end)) {
      out.push((257 - run) & 0xff, src[i]);
      i += run;
      continue;
    }
    // literal run: until a 3-byte repeat starts or 128 bytes
    const litStart = i;
    while (i < end && i - litStart < 128) {
      if (i + 2 < end && src[i] === src[i + 1] && src[i] === src[i + 2]) break;
      i++;
    }
    if (i === litStart) { i++; } // safety (cannot happen: run<3 case consumed above)
    const n = i - litStart;
    out.push(n - 1);
    for (let k = litStart; k < litStart + n; k++) out.push(src[k]);
  }
  return Uint8Array.from(out);
}

export function unpackBits(src: Uint8Array, s: number, e: number, out: Uint8Array | Uint8ClampedArray, o: number, oEnd: number): number {
  let i = s, k = o;
  while (i < e && k < oEnd) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let j = 0; j <= n && i < e && k < oEnd; j++) out[k++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let j = 0; j < 1 - n && k < oEnd; j++) out[k++] = v; }
  }
  return i;
}

/* =============================================================== zlib via web streams */
async function streamBytes(input: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blobStream = new Blob([input as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(blobStream).arrayBuffer());
}
export const zlibDeflate = (b: Uint8Array) => streamBytes(b, new CompressionStream("deflate"));
export const zlibInflate = (b: Uint8Array) => streamBytes(b, new DecompressionStream("deflate"));

/* =============================================================== byte writer */
class Writer {
  private chunks: Uint8Array[] = [];
  private cur = new Uint8Array(65536);
  private pos = 0;
  length = 0;
  private room(n: number) {
    if (this.pos + n <= this.cur.length) return;
    this.chunks.push(this.cur.subarray(0, this.pos));
    this.cur = new Uint8Array(Math.max(65536, n));
    this.pos = 0;
  }
  u8(v: number) { this.room(1); this.cur[this.pos++] = v & 0xff; this.length++; }
  u16(v: number) { this.u8(v >>> 8); this.u8(v); }
  i16(v: number) { this.u16(v & 0xffff); }
  u32(v: number) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); }
  i32(v: number) { this.u32(v >>> 0); }
  bytes(b: ArrayLike<number>) {
    this.room(b.length);
    if (b instanceof Uint8Array) this.cur.set(b, this.pos); else for (let i = 0; i < b.length; i++) this.cur[this.pos + i] = b[i];
    this.pos += b.length; this.length += b.length;
  }
  ascii(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    out.set(this.cur.subarray(0, this.pos), o);
    return out;
  }
}

/* =============================================================== channel encoding */
async function encodePlane(plane: Uint8Array, w: number, h: number, comp: PsdCompression): Promise<Uint8Array> {
  const wr = new Writer();
  if (comp === "raw" || w === 0 || h === 0) { wr.u16(0); wr.bytes(plane); return wr.done(); }
  if (comp === "zip") { wr.u16(2); wr.bytes(await zlibDeflate(plane)); return wr.done(); }
  const rows: Uint8Array[] = [];
  for (let y = 0; y < h; y++) rows.push(packBits(plane, y * w, y * w + w));
  wr.u16(1);
  for (const r of rows) wr.u16(r.length);
  for (const r of rows) wr.bytes(r);
  return wr.done();
}

function planeOf(l: Layer, c: number): Uint8Array {
  const n = l.w * l.h, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = l.data[i * 4 + c];
  return out;
}

/* =============================================================== writer */
export async function writePsd(doc: ImageDoc, opts: { compression?: PsdCompression } = {}): Promise<Uint8Array> {
  validateDoc(doc);
  const comp = opts.compression ?? "rle";
  const W = doc.width, H = doc.height;

  type Rec = { layer: Layer; channels: { id: number; blob: Uint8Array }[] };
  const recs: Rec[] = [];
  for (const l of doc.layers) {
    const chans: { id: number; blob: Uint8Array }[] = [];
    for (const [id, c] of [[-1, 3], [0, 0], [1, 1], [2, 2]] as const) chans.push({ id, blob: await encodePlane(planeOf(l, c), l.w, l.h, comp) });
    if (l.mask) chans.push({ id: -2, blob: await encodePlane(new Uint8Array(l.mask), l.w, l.h, comp) });
    recs.push({ layer: l, channels: chans });
  }

  const li = new Writer();
  li.i16(-doc.layers.length); // negative: first alpha channel of the merged image = merged transparency
  for (const { layer: l, channels } of recs) {
    li.i32(l.y); li.i32(l.x); li.i32(l.y + l.h); li.i32(l.x + l.w);
    li.u16(channels.length);
    for (const c of channels) { li.i16(c.id); li.u32(c.blob.length); }
    li.ascii("8BIM"); li.ascii(BLEND_KEYS[l.blend]);
    li.u8(Math.round(l.opacity * 255)); li.u8(0);
    li.u8((l.visible ? 0 : 2) | 8); li.u8(0);
    const extra = new Writer();
    if (l.mask) {
      extra.u32(20);
      extra.i32(l.y); extra.i32(l.x); extra.i32(l.y + l.h); extra.i32(l.x + l.w);
      extra.u8(255); extra.u8(l.maskEnabled === false ? 2 : 0); extra.u16(0);
    } else extra.u32(0);
    extra.u32(0); // blending ranges
    const pascal = encodeMacRoman(l.name).slice(0, 255);
    extra.u8(pascal.length); extra.bytes(pascal);
    for (let k = (1 + pascal.length) % 4; k && k < 4; k++) extra.u8(0);
    // luni: Unicode layer name
    const name = l.name.slice(0, 255);
    extra.ascii("8BIM"); extra.ascii("luni");
    const uniLen = 4 + name.length * 2, uniPad = uniLen % 4 ? 4 - (uniLen % 4) : 0;
    extra.u32(uniLen + uniPad); extra.u32(name.length);
    for (let k = 0; k < name.length; k++) extra.u16(name.charCodeAt(k));
    for (let k = 0; k < uniPad; k++) extra.u8(0);
    const eb = extra.done();
    li.u32(eb.length); li.bytes(eb);
  }
  for (const r of recs) for (const c of r.channels) li.bytes(c.blob);
  if (li.length % 2) li.u8(0);
  const liBytes = li.done();

  const lm = new Writer();
  lm.u32(liBytes.length); lm.bytes(liBytes);
  lm.u32(0); // global layer mask info
  const lmBytes = lm.done();

  const out = new Writer();
  out.ascii("8BPS"); out.u16(1); out.bytes([0, 0, 0, 0, 0, 0]);
  out.u16(4); out.u32(H); out.u32(W); out.u16(8); out.u16(3);
  out.u32(0); // colour mode data
  out.u32(0); // image resources
  out.u32(lmBytes.length); out.bytes(lmBytes);

  // merged image: planar R,G,B,A of the composite
  const merged = compositeRegion(doc);
  const planes = [0, 1, 2, 3].map((c) => { const p = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) p[i] = merged[i * 4 + c]; return p; });
  if (comp === "rle") {
    const rows: Uint8Array[] = [];
    for (const p of planes) for (let y = 0; y < H; y++) rows.push(packBits(p, y * W, y * W + W));
    out.u16(1);
    for (const r of rows) out.u16(r.length);
    for (const r of rows) out.bytes(r);
  } else if (comp === "zip") {
    const all = new Uint8Array(W * H * 4);
    planes.forEach((p, i) => all.set(p, i * W * H));
    out.u16(2); out.bytes(await zlibDeflate(all));
  } else {
    out.u16(0);
    for (const p of planes) out.bytes(p);
  }
  return out.done();
}

/* =============================================================== reader */
const ascii4 = (u8: Uint8Array, o: number) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

async function decodePlanes(payload: Uint8Array, compression: number, n: number, w: number, h: number, warnings: string[]): Promise<Uint8Array[]> {
  const size = w * h;
  if (compression === 0) return Array.from({ length: n }, (_, c) => payload.slice(c * size, (c + 1) * size));
  if (compression === 1) {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let p = n * h * 2;
    const planes: Uint8Array[] = [];
    for (let c = 0; c < n; c++) {
      const out = new Uint8Array(size);
      for (let y = 0; y < h; y++) {
        const rl = dv.getUint16((c * h + y) * 2);
        const end = Math.min(payload.length, p + rl);
        unpackBits(payload, p, end, out, y * w, y * w + w);
        p = end;
      }
      planes.push(out);
    }
    return planes;
  }
  if (compression === 2 || compression === 3) {
    const raw = await zlibInflate(payload);
    const planes = Array.from({ length: n }, (_, c) => raw.slice(c * size, (c + 1) * size));
    if (compression === 3) for (const pl of planes) for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) pl[y * w + x] = (pl[y * w + x] + pl[y * w + x - 1]) & 0xff;
    return planes;
  }
  warnings.push(`unknown compression ${compression}; channel left empty`);
  return Array.from({ length: n }, () => new Uint8Array(size));
}

export async function readPsd(input: Uint8Array): Promise<PsdReadResult> {
  const u8 = input;
  if (u8.length < 26 || ascii4(u8, 0) !== "8BPS") throw new Error("not a PSD file (missing 8BPS signature)");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint16(4);
  if (version === 2) throw new Error("PSB (large document format) is not supported");
  if (version !== 1) throw new Error(`unknown PSD version ${version}`);
  const channels = dv.getUint16(12), H = dv.getUint32(14), W = dv.getUint32(18), depth = dv.getUint16(22), mode = dv.getUint16(24);
  if (depth !== 8) throw new Error(`${depth}-bit PSD is not supported (8-bit only)`);
  if (mode !== 3 && mode !== 1) throw new Error(`colour mode ${mode} is not supported (RGB and Grayscale only)`);
  if (W < 1 || H < 1 || W * H > MAX_PIXELS) throw new Error(`canvas ${W}×${H} outside the supported range`);
  const gray = mode === 1;
  const warnings: string[] = [];
  const compressions = new Set<number>();
  let p = 26;
  p += 4 + dv.getUint32(p); // colour mode data
  p += 4 + dv.getUint32(p); // image resources
  const lmLen = dv.getUint32(p), lmStart = p + 4, lmEnd = lmStart + lmLen;
  const layers: Layer[] = [];
  let records = 0;
  let groupDepth = 0;

  if (lmLen > 0) {
    const liLen = dv.getUint32(lmStart);
    if (liLen > 0) {
      let q = lmStart + 6;
      const count = dv.getInt16(lmStart + 4);
      const n = Math.abs(count);
      records = n;
      type Rec = { top: number; left: number; bottom: number; right: number; opacity: number; clipping: number; flags: number; blendKey: string; name: string; ch: { id: number; len: number }[]; mask?: { top: number; left: number; bottom: number; right: number; def: number; flags: number }; section?: number };
      const recs: Rec[] = [];
      for (let i = 0; i < n; i++) {
        const top = dv.getInt32(q), left = dv.getInt32(q + 4), bottom = dv.getInt32(q + 8), right = dv.getInt32(q + 12);
        q += 16;
        const nch = dv.getUint16(q); q += 2;
        const ch: { id: number; len: number }[] = [];
        for (let c = 0; c < nch; c++) { ch.push({ id: dv.getInt16(q), len: dv.getUint32(q + 2) }); q += 6; }
        if (ascii4(u8, q) !== "8BIM") throw new Error(`layer record ${i}: bad blend signature`);
        const blendKey = ascii4(u8, q + 4), opacity = u8[q + 8], clipping = u8[q + 9], flags = u8[q + 10];
        q += 12;
        const extraLen = dv.getUint32(q); q += 4;
        const extraStart = q, extraEnd = q + extraLen;
        let e = extraStart;
        const maskLen = dv.getUint32(e);
        let mask: Rec["mask"];
        if (maskLen >= 18) mask = { top: dv.getInt32(e + 4), left: dv.getInt32(e + 8), bottom: dv.getInt32(e + 12), right: dv.getInt32(e + 16), def: u8[e + 20], flags: u8[e + 21] };
        e += 4 + maskLen;
        e += 4 + dv.getUint32(e); // blending ranges
        const nameLen = u8[e];
        let name = decodeMacRoman(u8.subarray(e + 1, e + 1 + nameLen));
        e += Math.ceil((1 + nameLen) / 4) * 4;
        let section: number | undefined;
        // additional layer information (tagged blocks)
        while (e + 12 <= extraEnd) {
          const sig = ascii4(u8, e);
          if (sig !== "8BIM" && sig !== "8B64") break;
          const key = ascii4(u8, e + 4), len = dv.getUint32(e + 8), d = e + 12;
          if (key === "luni" && len >= 4) {
            const cnt = dv.getUint32(d);
            let s = "";
            for (let k = 0; k < cnt && d + 4 + k * 2 + 1 < d + len; k++) s += String.fromCharCode(dv.getUint16(d + 4 + k * 2));
            name = s.replace(/\u0000+$/, "");
          } else if (key === "lsct" || key === "lsdk") {
            section = dv.getUint32(d);
          } else if (["TySh", "SoLd", "SoLE", "PlLd", "lfx2", "lrFX", "vmsk", "vsms", "levl", "curv", "hue2", "brit", "blnc", "SoCo", "GdFl", "PtFl"].includes(key)) {
            warnings.push(`layer "${name}": ${key} data not rendered (pixels used as stored)`);
          }
          e = d + len + (len % 2);
        }
        q = extraEnd;
        recs.push({ top, left, bottom, right, opacity, clipping, flags, blendKey, name, ch, mask, section });
      }
      for (const r of recs) {
        const w = r.right - r.left, h = r.bottom - r.top;
        const planes: Record<number, Uint8Array> = {};
        for (const c of r.ch) {
          const isMask = c.id === -2 && r.mask;
          const cw = isMask ? r.mask!.right - r.mask!.left : w, chh = isMask ? r.mask!.bottom - r.mask!.top : h;
          const compression = c.len >= 2 ? dv.getUint16(q) : 0;
          if (cw > 0 && chh > 0 && c.len >= 2) {
            compressions.add(compression);
            planes[c.id] = (await decodePlanes(u8.subarray(q + 2, q + c.len), compression, 1, cw, chh, warnings))[0];
          }
          q += c.len;
        }
        if (r.section === 1 || r.section === 2) { groupDepth--; continue; }       // folder (records are stored top→bottom reversed, so this closes)
        if (r.section === 3) { groupDepth++; warnings.push("layer groups are flattened into their children (group opacity/blend ignored)"); continue; }
        if (w <= 0 || h <= 0) continue; // empty layer (no pixels)
        if (w * h > MAX_PIXELS) { warnings.push(`layer "${r.name}" too large; skipped`); continue; }
        const data = new Uint8ClampedArray(w * h * 4);
        const R = planes[0], G = gray ? planes[0] : planes[1], B = gray ? planes[0] : planes[2], A = planes[-1];
        for (let i = 0; i < w * h; i++) {
          data[i * 4] = R ? R[i] : 0; data[i * 4 + 1] = G ? G[i] : 0; data[i * 4 + 2] = B ? B[i] : 0; data[i * 4 + 3] = A ? A[i] : 255;
        }
        let blend = KEY_TO_BLEND[r.blendKey];
        if (!blend) { warnings.push(`layer "${r.name}": blend "${r.blendKey.trim()}" not supported; shown as normal`); blend = "normal"; }
        if (r.clipping) warnings.push(`layer "${r.name}": clipping mask not supported; rendered unclipped`);
        const layer: Layer = { id: newId(), name: r.name || `Layer ${layers.length + 1}`, x: r.left, y: r.top, w, h, data, opacity: r.opacity / 255, visible: !(r.flags & 2), blend };
        if (r.mask && planes[-2]) {
          const m = r.mask, mw = m.right - m.left, mask = new Uint8ClampedArray(w * h).fill(m.def);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const X = x + r.left - m.left, Y = y + r.top - m.top;
            if (X >= 0 && Y >= 0 && X < mw && Y < m.bottom - m.top) mask[y * w + x] = planes[-2][Y * mw + X];
          }
          layer.mask = mask;
          layer.maskEnabled = !(m.flags & 2);
        }
        layers.push(layer);
      }
    }
  }
  void groupDepth;

  if (layers.length === 0) {
    // Flattened document: use the merged image data.
    if (lmEnd + 2 > u8.length) throw new Error("PSD has neither layers nor merged image data");
    const compression = dv.getUint16(lmEnd);
    compressions.add(compression);
    const nPlanes = Math.min(channels, gray ? 2 : 4);
    const planes = await decodePlanes(u8.subarray(lmEnd + 2), compression, nPlanes, W, H, warnings);
    const data = new Uint8ClampedArray(W * H * 4);
    const alpha = gray ? planes[1] : planes[3];
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = planes[0][i]; data[i * 4 + 1] = gray ? planes[0][i] : planes[1][i]; data[i * 4 + 2] = gray ? planes[0][i] : planes[2][i];
      data[i * 4 + 3] = alpha ? alpha[i] : 255;
    }
    layers.push({ id: newId(), name: "Background", x: 0, y: 0, w: W, h: H, data, opacity: 1, visible: true, blend: "normal" });
  }
  // dedupe warnings
  const uniq = [...new Set(warnings)];
  const doc: ImageDoc = { width: W, height: H, layers };
  validateDoc(doc);
  return { doc, warnings: uniq, info: { mode, channels, layerRecords: records, compression: [...compressions] } };
}

export const SUPPORTED_BLENDS = BLEND_MODES;
