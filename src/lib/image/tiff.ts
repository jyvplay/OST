/**
 * TT54 (FF-13) — baseline TIFF decoder (first IFD → RGBA), written from the TIFF 6.0 specification.
 * Browsers do not decode TIFF; this lets Files / Photos show and edit them.
 *
 *  compression  1 none · 5 LZW (MSB-first, early change) · 8 / 32946 Deflate · 32773 PackBits
 *  photometric  0 WhiteIsZero · 1 BlackIsZero (1/2/4/8/16-bit) · 2 RGB (8/16-bit, + extra samples) · 3 palette (1/2/4/8-bit)
 *  layout       strips, PlanarConfiguration 1 (chunky) and 2 (planar); Predictor 2 (horizontal differencing, 8/16-bit)
 *  alpha        ExtraSamples 2 (unassociated) as is; 1 (associated / premultiplied) is un-premultiplied
 *  refused      tiles, JPEG / CCITT / other compressions, CMYK / YCbCr / Lab, float samples — with a reason, never garbage
 *  guards       40 MP, every strip offset / length bounds-checked, LZW output capped at the expected strip size
 */
import { isTiff } from "../meta/exif";

export interface TiffImage { width: number; height: number; data: Uint8ClampedArray }
export class TiffError extends Error {}
const MAX_PIXELS = 40_000_000;

export async function decodeTiff(b: Uint8Array, inflate: (d: Uint8Array) => Promise<Uint8Array>): Promise<TiffImage> {
  if (!isTiff(b)) throw new TiffError("not a TIFF file");
  const le = b[0] === 0x49; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le), u32 = (o: number) => dv.getUint32(o, le);
  if (u16(2) !== 42) throw new TiffError("BigTIFF is not supported");
  const ifd = u32(4); if (ifd + 2 > b.length) throw new TiffError("IFD offset out of range");
  const n = u16(ifd); const tags = new Map<number, number[]>();
  const SZ = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12; if (e + 12 > b.length) throw new TiffError("IFD truncated");
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4); const sz = SZ[type] ?? 0;
    if (!sz || count > 1 << 24) continue;
    const at = sz * count <= 4 ? e + 8 : u32(e + 8); if (at + sz * count > b.length) continue;
    const vals: number[] = [];
    for (let k = 0; k < count; k++) { const o = at + k * sz; vals.push(type === 3 ? u16(o) : type === 4 ? u32(o) : type === 1 || type === 7 ? b[o] : type === 5 ? u32(o) / (u32(o + 4) || 1) : 0); }
    tags.set(tag, vals);
  }
  const g = (t: number, d?: number) => tags.get(t)?.[0] ?? d;
  const W = g(256, 0)!, H = g(257, 0)!;
  if (!W || !H) throw new TiffError("missing image size");
  if (W * H > MAX_PIXELS) throw new TiffError(`image is larger than ${MAX_PIXELS / 1e6} megapixels`);
  if (tags.has(322) || tags.has(324)) throw new TiffError("tiled TIFF is not supported");
  const comp = g(259, 1)!, photo = g(262, 1)!, spp = g(277, 1)!, planar = g(284, 1)!, pred = g(317, 1)!;
  const bps = tags.get(258) ?? [1]; const bits = bps[0];
  if (bps.some((x) => x !== bits)) throw new TiffError("mixed bits per sample");
  if (![1, 2, 4, 8, 16].includes(bits)) throw new TiffError(`${bits}-bit samples are not supported`);
  if ((tags.get(339) ?? [1]).some((f) => f !== 1)) throw new TiffError("non-integer sample format");
  if (![0, 1, 2, 3].includes(photo)) throw new TiffError(`photometric interpretation ${photo} (CMYK / YCbCr / Lab …) is not supported`);
  if (![1, 5, 8, 32946, 32773].includes(comp)) throw new TiffError(`compression ${comp} is not supported (JPEG / CCITT …)`);
  if (photo === 2 && spp < 3) throw new TiffError("RGB with fewer than 3 samples");
  const offs = tags.get(273), lens = tags.get(279); if (!offs || !lens || offs.length !== lens.length) throw new TiffError("missing strip offsets");
  const rps = Math.min(H, g(278, H)!);
  const planes = planar === 2 ? spp : 1, sppChunk = planar === 2 ? 1 : spp;
  const rowBytes = Math.ceil(W * sppChunk * bits / 8);
  const stripsPerPlane = Math.ceil(H / rps);
  if (offs.length < stripsPerPlane * planes) throw new TiffError("too few strips");
  const plane: Uint8Array[] = [];
  for (let p = 0; p < planes; p++) {
    const out = new Uint8Array(rowBytes * H);
    for (let s = 0; s < stripsPerPlane; s++) {
      const idx = p * stripsPerPlane + s; const o = offs[idx], l = lens[idx];
      if (o + l > b.length) throw new TiffError("strip outside the file");
      const rows = Math.min(rps, H - s * rps); const want = rows * rowBytes; const raw = b.subarray(o, o + l);
      let px: Uint8Array;
      if (comp === 1) px = raw;
      else if (comp === 5) px = lzw(raw, want);
      else if (comp === 32773) px = packbits(raw, want);
      else px = await inflate(raw);
      if (pred === 2) unpredict(px, rows, rowBytes, sppChunk, bits, le);
      else if (pred !== 1) throw new TiffError(`predictor ${pred} is not supported`);
      out.set(px.subarray(0, Math.min(want, px.length)), s * rps * rowBytes);
    }
    plane.push(out);
  }
  const extra = tags.get(338) ?? []; const assoc = extra[0] === 1;
  const map = tags.get(320); const maxv = (1 << bits) - 1;
  const sample = (row: Uint8Array, i: number): number => {
    if (bits === 8) return row[i];
    if (bits === 16) { const v = le ? row[i * 2] | (row[i * 2 + 1] << 8) : (row[i * 2] << 8) | row[i * 2 + 1]; return v; }
    const bit = i * bits; return (row[bit >> 3] >> (8 - bits - (bit & 7))) & maxv;
  };
  const to8 = (v: number) => bits === 8 ? v : bits === 16 ? v >> 8 : Math.round(v * 255 / maxv);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (y * W + x) * 4;
      const get = (c: number) => planar === 2 ? sample(plane[c].subarray(y * rowBytes, (y + 1) * rowBytes), x) : sample(plane[0].subarray(y * rowBytes, (y + 1) * rowBytes), x * spp + c);
      if (photo === 2) {
        data[d] = to8(get(0)); data[d + 1] = to8(get(1)); data[d + 2] = to8(get(2)); data[d + 3] = spp > 3 && extra.length ? to8(get(3)) : 255;
        if (assoc && data[d + 3] && data[d + 3] < 255) { const a = data[d + 3] / 255; data[d] = Math.round(data[d] / a); data[d + 1] = Math.round(data[d + 1] / a); data[d + 2] = Math.round(data[d + 2] / a); }
      } else if (photo === 3) {
        if (!map || map.length < 3 << bits) throw new TiffError("palette image without a colour map");
        const v = get(0), k = 1 << bits; data[d] = map[v] >> 8; data[d + 1] = map[k + v] >> 8; data[d + 2] = map[2 * k + v] >> 8; data[d + 3] = 255;
      } else {
        let v = to8(get(0)); if (photo === 0) v = 255 - v;
        data[d] = data[d + 1] = data[d + 2] = v; data[d + 3] = spp > 1 && extra.length ? to8(get(1)) : 255;
      }
    }
  }
  return { width: W, height: H, data };
}

function unpredict(px: Uint8Array, rows: number, rowBytes: number, spp: number, bits: number, le: boolean) {
  if (bits === 8) {
    for (let r = 0; r < rows; r++) { const o = r * rowBytes; for (let i = spp; i < rowBytes && o + i < px.length; i++) px[o + i] = (px[o + i] + px[o + i - spp]) & 255; }
  } else if (bits === 16) {
    const dv = new DataView(px.buffer, px.byteOffset, px.byteLength);
    for (let r = 0; r < rows; r++) { const o = r * rowBytes; for (let i = spp; i < rowBytes / 2 && o + i * 2 + 1 < px.length; i++) dv.setUint16(o + i * 2, (dv.getUint16(o + i * 2, le) + dv.getUint16(o + (i - spp) * 2, le)) & 0xffff, le); }
  } else throw new TiffError(`predictor 2 with ${bits}-bit samples is not supported`);
}

/** TIFF LZW: MSB-first codes, 9..12 bits, Clear 256 / EOI 257, code width grows one code early (TIFF 6.0 §13) */
export function lzw(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want); let op = 0;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Int32Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
  let next = 258, width = 9, prev = -1, bitPos = 0; const total = src.length * 8;
  const emit = (code: number) => {
    const l = len[code]; if (op + l > want) { const keep = want - op; let c = code; for (let k = l - 1; k >= 0; k--) { if (k < keep) out[op + k] = suffix[c]; c = prefix[c]; } op = want; return; }
    let c = code; for (let k = l - 1; k >= 0; k--) { out[op + k] = suffix[c]; c = prefix[c]; } op += l;
  };
  while (bitPos + width <= total && op < want) {
    let code = 0; for (let k = 0; k < width; k++) { code = (code << 1) | ((src[(bitPos + k) >> 3] >> (7 - ((bitPos + k) & 7))) & 1); } bitPos += width;
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }
    if (prev === -1) { if (code > 255) throw new TiffError("LZW: bad first code"); emit(code); prev = code; continue; }
    if (code < next) { emit(code); if (next < 4096) { prefix[next] = prev; suffix[next] = first[code]; first[next] = first[prev]; len[next] = len[prev] + 1; next++; } }
    else if (code === next && next < 4096) { prefix[next] = prev; suffix[next] = first[prev]; first[next] = first[prev]; len[next] = len[prev] + 1; next++; emit(code); }
    else throw new TiffError("LZW: code out of range");
    prev = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return op === want ? out : out.subarray(0, op);
}

export function packbits(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want); let i = 0, o = 0;
  while (i < src.length && o < want) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { const c = Math.min(n + 1, want - o, src.length - i); out.set(src.subarray(i, i + c), o); i += n + 1; o += c; }
    else if (n !== -128) { const c = Math.min(1 - n, want - o); out.fill(src[i++], o, o + c); o += c; }
  }
  return o === want ? out : out.subarray(0, o);
}
