/**
 * TT59 FF-05: GIF and BMP export (src/lib/image/rasterenc.ts, from scratch — canvases only encode PNG / JPEG / WebP).
 * Ground truth: Pillow (independent C decoders for GIF LZW and BMP) decodes every file we write; the expected pixels
 * are the source pixels (exact palette / 24-bit) or the hand-written composite-over-white formula for BMP alpha.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt59-raster.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { encodeBmp, encodeGif } from "../src/lib/image/rasterenc.ts";

const { test, finish } = makeHarness("tt59-raster");
const COV = { "FF-05": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const dir = "/tmp/tt59raster"; mkdirSync(dir, { recursive: true });
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
/** Pillow: decode → RGBA bytes → compare with want.rgba; returns {format, size, max, mean, diffpx, transparency} */
const pil = (file: string, want: Uint8Array, w: number, h: number) => {
  writeFileSync(`${file}.want`, want);
  return JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
from PIL import Image
im = Image.open(sys.argv[1]); im.load(); fmt = im.format; info = {k: (v if isinstance(v, (int, str)) else str(v)) for k, v in im.info.items() if k in ("transparency", "version")}
a = np.asarray(im.convert("RGBA")).astype(int); w, h = int(sys.argv[3]), int(sys.argv[4])
want = np.frombuffer(open(sys.argv[2], "rb").read(), np.uint8).reshape(h, w, 4).astype(int)
# compare colour only where the pixel is visible; alpha compared as visible / invisible
vis = want[:, :, 3] >= 128
d = np.abs(a[:, :, :3] - want[:, :, :3]) * vis[:, :, None]
print(json.dumps({"format": fmt, "size": [im.width, im.height], "max": int(d.max()), "mean": float(d.sum() / max(1, vis.sum() * 3)), "alpha_ok": bool(((a[:, :, 3] >= 128) == vis).all()), "info": info}))`, file, `${file}.want`, String(w), String(h)], { encoding: "utf8" }));
};
const img = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4); return { width: w, height: h, data: d };
};

await test("BMP: 24-bit bottom-up rows with 4-byte padding (odd widths 1, 2, 3, 37) decode bit-exact in Pillow; alpha composited over white by the documented formula", COV, () => {
  for (const [w, h] of [[1, 1], [2, 3], [3, 2], [37, 23]]) {
    const im = img(w, h, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]);
    const f = `${dir}/o${w}x${h}.bmp`; writeFileSync(f, encodeBmp(im));
    const r = pil(f, im.data, w, h); ok(r.format === "BMP" && r.size[0] === w && r.size[1] === h && r.max === 0, `${w}x${h}: ${JSON.stringify(r)}`);
  }
  const im = img(16, 9, (x, y) => [200, 40, 10, (x * 16 + y * 7) % 256]);
  const want = new Uint8Array(im.data.length);
  for (let i = 0; i < im.data.length; i += 4) { const a = im.data[i + 3]; for (let k = 0; k < 3; k++) want[i + k] = Math.round((im.data[i + k] * a + 255 * (255 - a)) / 255); want[i + 3] = 255; }
  const f = `${dir}/alpha.bmp`; writeFileSync(f, encodeBmp(im));
  const r = pil(f, want, 16, 9); ok(r.max === 0, `alpha over white: ${JSON.stringify(r)}`);
});

await test("GIF: ≤ 255 colours are exact (2-, 16-, 200-colour images incl. 1×1 and 600×400 noise past the 4096-code LZW reset) and Pillow decodes them bit-exact", COV, () => {
  for (const [w, h, n] of [[1, 1, 1], [7, 5, 2], [64, 48, 16], [600, 400, 200], [300, 300, 255]]) {
    const pal = Array.from({ length: n }, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
    const im = img(w, h, () => { const c = pal[Math.floor(rnd() * n)]; return [c[0], c[1], c[2], 255]; });
    const f = `${dir}/p${n}_${w}x${h}.gif`; const bytes = encodeGif(im); writeFileSync(f, bytes);
    const r = pil(f, im.data, w, h); ok(r.format === "GIF" && String(r.info.version).includes("GIF89a") && r.max === 0 && r.size[0] === w, `${n} colours ${w}x${h}: ${JSON.stringify(r)}`);
  }
});

await test("GIF transparency: alpha < 128 → the transparent index (Graphic Control Extension), visible pixels exact; an all-transparent image is valid", COV, () => {
  const im = img(40, 30, (x, y) => ((x - 20) ** 2 + (y - 15) ** 2 < 140 ? [30, 160, 90, 255] : (x + y) % 2 ? [250, 250, 250, 0] : [10, 10, 10, 100]));
  const f = `${dir}/t.gif`; writeFileSync(f, encodeGif(im));
  const r = pil(f, im.data, 40, 30); ok(r.max === 0 && r.alpha_ok && r.info.transparency !== undefined, JSON.stringify(r));
  const empty = img(5, 4, () => [0, 0, 0, 0]); writeFileSync(`${dir}/e.gif`, encodeGif(empty));
  const r2 = pil(`${dir}/e.gif`, empty.data, 5, 4); ok(r2.alpha_ok && r2.size[0] === 5, JSON.stringify(r2));
});

await test("GIF photo (> 256 colours): median cut + Floyd–Steinberg — mean error per channel ≤ 6 and 8×8 block-mean error ≤ 0.8 (no diffusion: 2.7; no right-hand term: 0.95) on a smooth 256×256 gradient, ≤ 12 on noise; quantising 1 MP stays < 4 s", COV, () => {
  const grad = img(256, 256, (x, y) => [x, y, (x + y) >> 1, 255]);
  writeFileSync(`${dir}/g.gif`, encodeGif(grad)); const r = pil(`${dir}/g.gif`, grad.data, 256, 256);
  // dithering keeps LOCAL averages right: compare 8×8 block means (a quantiser without error diffusion bands visibly)
  const blk = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(float)
x = np.arange(256)[None, :].repeat(256, 0); y = x.T; want = np.stack([x, y, (x + y) // 2], 2)
B = lambda m: m.reshape(32, 8, 32, 8, 3).mean((1, 3))
print(json.dumps(float(np.abs(B(a) - B(want)).mean())))`, `${dir}/g.gif`], { encoding: "utf8" }));
  console.log(`    gradient: mean ${r.mean.toFixed(2)} max ${r.max}; 8×8 block-mean error ${blk.toFixed(3)}`); ok(r.mean <= 6 && blk <= 0.8, JSON.stringify({ ...r, blk }));
  const noise = img(1000, 1000, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]);
  const t = performance.now(); const b = encodeGif(noise); const ms = performance.now() - t;
  writeFileSync(`${dir}/n.gif`, b); const r2 = pil(`${dir}/n.gif`, noise.data, 1000, 1000);
  console.log(`    1 MP noise: ${ms.toFixed(0)} ms, ${b.length} bytes, mean error ${r2.mean.toFixed(2)}`); ok(ms < 4000 && r2.mean <= 12, JSON.stringify({ ms, ...r2 }));
});

await test("refusals: zero / oversized dimensions and short pixel buffers throw instead of writing a broken file", COV, () => {
  const bad = [{ width: 0, height: 1, data: new Uint8Array(0) }, { width: 2, height: 2, data: new Uint8Array(3) }, { width: 70000, height: 1, data: new Uint8Array(280000) }];
  for (const b of bad.slice(0, 2)) { let t = 0; try { encodeBmp(b); } catch { t++; } try { encodeGif(b); } catch { t++; } ok(t === 2, `refused ${b.width}x${b.height}`); }
  let t = 0; try { encodeGif(bad[2]); } catch { t++; } ok(t === 1, "GIF > 65535 px refused");
});

finish();
