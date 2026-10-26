// TT52 test-only browser entry: bundled by esbuild into a page so Chromium runs the real engine on canvas.
import { PdfDoc } from "../../src/lib/pdf/pdfdoc";
import { renderPage } from "../../src/lib/pdf/pdfcanvas";
declare global { interface Window { __pdf: unknown } }
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function loadImg(url: string) { const im = new Image(); im.src = url; await im.decode(); const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const x = c.getContext("2d")!; x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height); }
/** fraction of pixels matching within `tol` against any pixel of the 3×3 neighbourhood of the other image (both ways) */
function similarity(a: ImageData, b: ImageData, tol = 40) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height); if (!w || !h) return { sim: 0, ink: 0 };
  const match = (p: ImageData, q: ImageData, x: number, y: number) => {
    const o = (y * p.width + x) * 4;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const k = (Y * q.width + X) * 4;
      if (Math.abs(p.data[o] - q.data[k]) <= tol && Math.abs(p.data[o + 1] - q.data[k + 1]) <= tol && Math.abs(p.data[o + 2] - q.data[k + 2]) <= tol) return true;
    }
    return false;
  };
  let ok = 0, n = 0, inkN = 0, inkOk = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * b.width + x) * 4; const ink = b.data[o] < 230 || b.data[o + 1] < 230 || b.data[o + 2] < 230 || a.data[(y * a.width + x) * 4] < 230;
    const m = match(a, b, x, y) && match(b, a, x, y); n++; if (m) ok++; if (ink) { inkN++; if (m) inkOk++; }
  }
  return { sim: ok / n, ink: inkN ? inkOk / inkN : 1 };
}
window.__pdf = {
  /** TT77: render page 1 at `scale` and return [r,g,b,a] at each device-pixel point (y down) */
  async probe(pdfB64: string, points: [number, number][], scale = 1) {
    try {
      const doc = PdfDoc.open(b64(pdfB64)); const c = document.createElement("canvas");
      const r = await renderPage(doc, doc.pages()[0], c, { scale, annotations: true, deadline: Date.now() + 20000 });
      const x = c.getContext("2d")!;
      return { w: c.width, h: c.height, warnings: r.warnings, px: points.map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data)) };
    } catch (e) { return { error: String((e as Error).stack ?? e).slice(0, 400) }; }
  },
  async run(pdfB64: string, refUrl: string, password?: string) {
    const t0 = performance.now();
    try {
      const doc = PdfDoc.open(b64(pdfB64), password);
      const page = doc.pages()[0]; if (!page) return { error: "no pages" };
      const c = document.createElement("canvas");
      const r = await renderPage(doc, page, c, { scale: 1, annotations: true, deadline: Date.now() + 20000 });
      const ours = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
      const ref = await loadImg(refUrl);
      const s = similarity(ours, ref);
      return { ...s, w: c.width, h: c.height, rw: ref.width, rh: ref.height, warnings: r.warnings.slice(0, 6), ms: Math.round(performance.now() - t0), png: (window as unknown as { __keep?: boolean }).__keep ? c.toDataURL() : undefined };
    } catch (e) { return { error: String((e as Error).stack ?? e).slice(0, 400) }; }
  },
};
