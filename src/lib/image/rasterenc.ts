/**
 * TT59 (FF-05) — GIF and BMP export, written from scratch (browsers' canvas encoders produce only PNG / JPEG / WebP).
 *
 * BMP: Windows BITMAPINFOHEADER, 24 bits per pixel, BI_RGB, rows bottom-up, each row padded to 4 bytes. BMP has no
 *      dependable alpha (most readers ignore a 32-bit alpha), so transparent pixels are composited over white —
 *      the same thing Windows Paint does when it saves a transparent image as 24-bit BMP.
 * GIF: GIF89a (W3C/CompuServe spec, 1990): a global colour table of 2…256 entries, at most 255 colours chosen by
 *      median cut over the opaque pixels (exact when the image has ≤ 255 distinct colours), optional Floyd–Steinberg
 *      dithering, one transparent index (Graphic Control Extension) for pixels with alpha < 128, and the image data
 *      LZW-compressed with variable-length codes (min code size = palette bits, clear code reset at 4096 codes),
 *      split into ≤ 255-byte sub-blocks.
 * Pure functions over RGBA bytes, so they run in a worker, on the server or in tests alike.
 */

export interface Rgba { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

/** 24-bit BMP; alpha composited over white */
export function encodeBmp(img: Rgba): Uint8Array {
  const { width: w, height: h, data } = img;
  if (!(w > 0 && h > 0) || data.length < w * h * 4) throw new Error("encodeBmp: bad image");
  const stride = (w * 3 + 3) & ~3, size = 54 + stride * h;
  const out = new Uint8Array(size); const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  dv.setUint32(30, 0, true); dv.setUint32(34, stride * h, true); dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true); // 72 dpi
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * stride, i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const a = data[i + 3];
      const c = (v: number) => (a === 255 ? v : Math.round((v * a + 255 * (255 - a)) / 255));
      out[o++] = c(data[i + 2]); out[o++] = c(data[i + 1]); out[o++] = c(data[i]);
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------------------------- GIF */

type Box = { px: Uint32Array; lo: number; hi: number };
/** median cut: split the box with the widest channel range at its median until `n` boxes (or no box can split) */
function medianCut(colors: Uint32Array, counts: Uint32Array, n: number): number[] {
  const idx = new Uint32Array(colors.length).map((_, i) => i);
  const boxes: Box[] = [{ px: idx, lo: 0, hi: idx.length }];
  const ch = (c: number, k: number) => (c >>> (16 - 8 * k)) & 255;
  const range = (b: Box) => {
    let best = -1, bk = 0;
    for (let k = 0; k < 3; k++) { let mn = 255, mx = 0; for (let i = b.lo; i < b.hi; i++) { const v = ch(colors[b.px[i]], k); if (v < mn) mn = v; if (v > mx) mx = v; } if (mx - mn > best) { best = mx - mn; bk = k; } }
    return { r: best, k: bk };
  };
  while (boxes.length < n) {
    let bi = -1, br = 0, bk = 0;
    for (let i = 0; i < boxes.length; i++) { if (boxes[i].hi - boxes[i].lo < 2) continue; const r = range(boxes[i]); if (r.r > br) { br = r.r; bi = i; bk = r.k; } }
    if (bi < 0) break;
    const b = boxes[bi]; const part = Array.from(b.px.subarray(b.lo, b.hi)).sort((x, y) => ch(colors[x], bk) - ch(colors[y], bk));
    let total = 0; for (const p of part) total += counts[p];
    let acc = 0, cut = 1; for (let i = 0; i < part.length - 1; i++) { acc += counts[part[i]]; if (acc * 2 >= total) { cut = i + 1; break; } cut = i + 1; }
    b.px.set(part, b.lo);
    boxes.splice(bi, 1, { px: b.px, lo: b.lo, hi: b.lo + cut }, { px: b.px, lo: b.lo + cut, hi: b.hi });
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0, t = 0;
    for (let i = b.lo; i < b.hi; i++) { const c = colors[b.px[i]], m = counts[b.px[i]]; r += ((c >>> 16) & 255) * m; g += ((c >>> 8) & 255) * m; bl += (c & 255) * m; t += m; }
    return (Math.round(r / t) << 16) | (Math.round(g / t) << 8) | Math.round(bl / t);
  });
}

/** LZW (GIF variant) of palette indices → sub-blocked bytes */
function lzw(indices: Uint8Array, minCode: number): Uint8Array {
  const clear = 1 << minCode, eoi = clear + 1;
  const out: number[] = []; let cur = 0, bits = 0;
  let size = minCode + 1, next = eoi + 1;
  const dict = new Map<number, number>();
  const emit = (code: number) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  emit(clear);
  let prefix = indices.length ? indices[0] : 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > 1 << size && size < 12) size++; }
    else { emit(clear); dict.clear(); size = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  if (indices.length) emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) { const n = Math.min(255, out.length - i); blocks.push(n); for (let j = 0; j < n; j++) blocks.push(out[i + j]); }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

export interface GifOptions { dither?: boolean; /** max palette size incl. the transparent slot (2…256) */ colors?: number }

/** GIF89a still: exact palette for ≤ 255 colours, else median cut (+ optional Floyd–Steinberg); alpha < 128 → transparent */
export function encodeGif(img: Rgba, o: GifOptions = {}): Uint8Array {
  const { width: w, height: h, data } = img;
  if (!(w > 0 && h > 0 && w < 65536 && h < 65536) || data.length < w * h * 4) throw new Error("encodeGif: bad image (1…65535 px per side)");
  const N = w * h;
  let transparent = false;
  const hist = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 3] < 128) { transparent = true; continue; }
    const c = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    hist.set(c, (hist.get(c) ?? 0) + 1);
  }
  const maxColors = Math.max(2, Math.min(256, o.colors ?? 256)) - (transparent ? 1 : 0);
  let distinct = Uint32Array.from(hist.keys()), counts = Uint32Array.from(hist.values());
  const exact = distinct.length <= maxColors;
  if (!exact && distinct.length > 32768) {
    // photos: median cut over a 5-bit-per-channel histogram (≤ 32,768 bins) keeps quantisation well under a second
    const bins = new Map<number, number>();
    for (let i = 0; i < distinct.length; i++) { const c = distinct[i] & 0xf8f8f8 | 0x040404; bins.set(c, (bins.get(c) ?? 0) + counts[i]); }
    distinct = Uint32Array.from(bins.keys()); counts = Uint32Array.from(bins.values());
  }
  const pal: number[] = exact ? Array.from(distinct) : medianCut(distinct, counts, maxColors);
  if (!pal.length) pal.push(0);
  const tIndex = transparent ? pal.length : -1;
  const used = pal.length + (transparent ? 1 : 0);
  let bitsPer = 1; while (1 << bitsPer < used) bitsPer++;
  const tableSize = 1 << bitsPer;
  // nearest palette entry (cached per colour)
  const near = new Map<number, number>();
  if (exact) pal.forEach((c, i) => near.set(c, i));
  const nearest = (r: number, g: number, b: number) => {
    const key = (r << 16) | (g << 8) | b; const hit = near.get(key); if (hit !== undefined) return hit;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) { const c = pal[i]; const dr = ((c >>> 16) & 255) - r, dg = ((c >>> 8) & 255) - g, db = (c & 255) - b; const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db; if (d < bd) { bd = d; best = i; } }
    if (near.size < 1 << 18) near.set(key, best);
    return best;
  };
  const idx = new Uint8Array(N);
  const dither = !exact && o.dither !== false;
  const err = dither ? new Float32Array((w + 2) * 3 * 2) : null; // two rows of RGB error
  for (let y = 0; y < h; y++) {
    if (err) { err.copyWithin(0, (w + 2) * 3); err.fill(0, (w + 2) * 3); }
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (data[p * 4 + 3] < 128) { idx[p] = tIndex; continue; }
      let r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
      if (err) { const e = (x + 1) * 3; r = Math.max(0, Math.min(255, Math.round(r + err[e]))); g = Math.max(0, Math.min(255, Math.round(g + err[e + 1]))); b = Math.max(0, Math.min(255, Math.round(b + err[e + 2]))); }
      const k = nearest(r, g, b); idx[p] = k;
      if (err) {
        const c = pal[k]; const er = r - ((c >>> 16) & 255), eg = g - ((c >>> 8) & 255), eb = b - (c & 255);
        const add = (row: number, xx: number, f: number) => { const e = row * (w + 2) * 3 + (xx + 1) * 3; err[e] += er * f; err[e + 1] += eg * f; err[e + 2] += eb * f; };
        add(0, x + 1, 7 / 16); add(1, x - 1, 3 / 16); add(1, x, 5 / 16); add(1, x + 1, 1 / 16);
      }
    }
  }
  const head: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0x80 | ((bitsPer - 1) << 4) | (bitsPer - 1), 0, 0];
  for (let i = 0; i < tableSize; i++) { const c = i < pal.length ? pal[i] : 0; head.push((c >>> 16) & 255, (c >>> 8) & 255, c & 255); }
  if (transparent) head.push(0x21, 0xf9, 4, 0x01, 0, 0, tIndex, 0);
  head.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0);
  const minCode = Math.max(2, bitsPer);
  const body = lzw(idx, minCode);
  const out = new Uint8Array(head.length + 1 + body.length + 1);
  out.set(head, 0); out[head.length] = minCode; out.set(body, head.length + 1); out[out.length - 1] = 0x3b;
  return out;
}
