/**
 * TT54 (FF-13) — thumbnail renderer. Runs in the thumbnail Worker (OffscreenCanvas) and, as a fallback, on the main
 * thread. Pure decode + draw: the cache, queue and VFS persistence live in service.ts.
 *
 *  images     createImageBitmap with EXIF orientation applied; > 12 MP photos with an EXIF IFD1 thumbnail use it (rotated
 *             by the main image's orientation, which the IFD1 JPEG does not carry); HEIF / TIFF only via that
 *             embedded thumbnail (the platform cannot decode them — reported, not faked)
 *  photo edit the PhotoRecipe (sidecar) is applied to a 2× working copy, so thumbnails show the edited picture
 *  PDF        page 1 through the first-party engine (TT52), white paper, 4 s budget
 *  audio      embedded cover art (ID3 APIC / FLAC PICTURE / MP4 covr / Matroska attachment)
 *  documents  the package thumbnail (OOXML docProps/thumbnail.*, ODF Thumbnails/thumbnail.png) when PNG / JPEG
 *  text       the first lines drawn on paper (code, markdown, CSV)
 *  video, SVG reported as needing the main thread (HTMLVideoElement / SVG-in-img are DOM-only)
 */
import { readMetadata, inflateZlib, type FileMeta } from "../meta";
import { decodeTiff } from "../image/tiff";
import { renderRecipe, isIdentity, type PhotoRecipe } from "../photos/recipe";

export type ThumbResult = { canvas: OffscreenCanvas | HTMLCanvasElement; source: string; meta: FileMeta } | { needsMain: "video" | "svg"; meta: FileMeta } | { none: string; meta: FileMeta };
type Canv = OffscreenCanvas | HTMLCanvasElement;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const mk = (w: number, h: number): Canv => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c;
};
const ctx2d = (c: Canv) => c.getContext("2d") as Ctx;
const fit = (w: number, h: number, max: number) => { const k = Math.min(1, max / Math.max(w, h)); return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }; };
const blobOf = (b: Uint8Array, type: string) => new Blob([b.slice().buffer as ArrayBuffer], { type });

const BROWSER_IMAGES = new Set(["jpeg", "png", "gif", "webp", "bmp", "avif", "ico"]);

/** draw an EXIF-orientation-less bitmap with orientation `o` applied (EXIF 1..8 semantics) */
function drawOriented(bmp: ImageBitmap, o: number, max: number): Canv {
  const turn = o >= 5; const { w, h } = fit(turn ? bmp.height : bmp.width, turn ? bmp.width : bmp.height, max);
  const c = mk(w, h); const g = ctx2d(c);
  const dw = turn ? h : w, dh = turn ? w : h;
  // x' = a·x + c·y + e, y' = b·x + d·y + f — the EXIF 1..8 display transforms, source drawn at dw×dh
  const M: Record<number, [number, number, number, number, number, number]> = {
    1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, w, 0], 7: [0, -1, -1, 0, w, h], 8: [0, -1, 1, 0, 0, h],
  };
  g.save(); g.setTransform(...(M[o] ?? M[1]));
  g.drawImage(bmp, 0, 0, dw, dh); g.restore();
  return c;
}

async function withRecipe(bmp: ImageBitmap, recipe: PhotoRecipe, max: number): Promise<Canv> {
  const work = fit(bmp.width, bmp.height, max * 2);
  const c = mk(work.w, work.h); const g = ctx2d(c); g.drawImage(bmp, 0, 0, work.w, work.h);
  const id = g.getImageData(0, 0, work.w, work.h);
  const out = renderRecipe({ width: id.width, height: id.height, data: id.data }, recipe);
  const tmp = mk(out.width, out.height); ctx2d(tmp).putImageData(new ImageData(out.data as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0);
  const f = fit(out.width, out.height, max); const res = mk(f.w, f.h); const rg = ctx2d(res);
  rg.imageSmoothingQuality = "high"; rg.drawImage(tmp, 0, 0, f.w, f.h);
  return res;
}

async function decodeTo(bytes: Uint8Array, mime: string, max: number, dims?: { w: number; h: number }): Promise<Canv> {
  const opts: ImageBitmapOptions = { imageOrientation: "from-image" };
  if (dims && Math.max(dims.w, dims.h) > max * 2) { const f = fit(dims.w, dims.h, max * 2); Object.assign(opts, { resizeWidth: f.w, resizeHeight: f.h, resizeQuality: "high" }); }
  const bmp = await createImageBitmap(blobOf(bytes, mime), opts);
  try {
    const f = fit(bmp.width, bmp.height, max); const c = mk(f.w, f.h); const g = ctx2d(c); g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, f.w, f.h); return c;
  } finally { bmp.close(); }
}

export async function renderThumbnail(bytes: Uint8Array, name: string, max = 256, recipe?: PhotoRecipe | null, known?: FileMeta): Promise<ThumbResult> {
  const meta = known ?? await readMetadata(bytes, name);
  const edited = recipe && !isIdentity(recipe) ? recipe : null;
  if (meta.kind === "image") {
    if (meta.format === "svg") return { needsMain: "svg", meta };
    const big = (meta.width ?? 0) * (meta.height ?? 0) > 12_000_000;
    const canDecode = BROWSER_IMAGES.has(meta.format);
    if (meta.picture && !edited && (big || !canDecode)) {
      const bmp = await createImageBitmap(blobOf(meta.picture.data, "image/jpeg"), { imageOrientation: "none" });
      try { return { canvas: drawOriented(bmp, meta.orientation ?? 1, max), source: meta.picture.source, meta }; } finally { bmp.close(); }
    }
    if (meta.format === "tiff") {
      // browsers do not decode TIFF: our baseline decoder (LZW / Deflate / PackBits, strips) → canvas → bitmap
      const t = await decodeTiff(bytes, inflateZlib);
      const full = mk(t.width, t.height); ctx2d(full).putImageData(new ImageData(t.data as Uint8ClampedArray<ArrayBuffer>, t.width, t.height), 0, 0);
      const bmp = await createImageBitmap(full);
      try {
        if (edited) {
          const up = drawOriented(bmp, meta.orientation ?? 1, max * 2); const ub = await createImageBitmap(up);
          try { return { canvas: await withRecipe(ub, edited, max), source: "TIFF (Fusion decoder), edited", meta }; } finally { ub.close(); }
        }
        return { canvas: drawOriented(bmp, meta.orientation ?? 1, max), source: "TIFF (Fusion decoder)", meta };
      } finally { bmp.close(); }
    }
    if (!canDecode) return { none: `${meta.format.toUpperCase()} cannot be decoded by this browser and has no embedded thumbnail`, meta };
    if (edited) {
      const bmp = await createImageBitmap(blobOf(bytes, meta.mime), { imageOrientation: "from-image" });
      try { return { canvas: await withRecipe(bmp, edited, max), source: "edited (recipe applied)", meta }; } finally { bmp.close(); }
    }
    return { canvas: await decodeTo(bytes, meta.mime, max, meta.displayWidth && meta.displayHeight ? { w: meta.displayWidth, h: meta.displayHeight } : undefined), source: "decoded image", meta };
  }
  if (meta.kind === "video") return { needsMain: "video", meta };
  if (meta.picture && /^image\/(jpeg|png|gif|webp)$/.test(meta.picture.mime)) {
    return { canvas: await decodeTo(meta.picture.data, meta.picture.mime, max), source: meta.picture.source, meta };
  }
  if (meta.format === "pdf" && !meta.encrypted) {
    const { PdfDoc } = await import("../pdf/pdfdoc");
    const { renderPage, pageTransform } = await import("../pdf/pdfcanvas");
    const doc = PdfDoc.open(bytes); const page = doc.pages()[0];
    if (!page) return { none: "PDF without pages", meta };
    const t1 = pageTransform(page, 1); const scale = max / Math.max(t1.w, t1.h);
    const c = mk(1, 1);
    await renderPage(doc, page, c as never, { scale, background: "#ffffff", deadline: Date.now() + 4000 });
    return { canvas: c, source: "PDF page 1", meta };
  }
  if (meta.kind === "text") {
    const text = new TextDecoder().decode(bytes.subarray(0, 8192)).split(/\r\n|\r|\n/).slice(0, 18);
    const w = Math.round(max * 0.78), h = max; const c = mk(w, h); const g = ctx2d(c);
    g.fillStyle = "#fffdf8"; g.fillRect(0, 0, w, h); g.fillStyle = "#2b3440";
    const fs = Math.max(7, Math.round(max / 24)); g.font = `${fs}px ui-monospace, Menlo, Consolas, monospace`;
    text.forEach((l, i) => g.fillText(l.slice(0, 60), fs * 0.6, fs * 1.4 + i * fs * 1.3));
    return { canvas: c, source: "text preview", meta };
  }
  return { none: meta.kind === "audio" ? "no embedded cover art" : meta.kind === "document" ? "no embedded thumbnail" : "no preview for this type", meta };
}

/** main-thread renderers for the two DOM-only kinds */
export async function renderVideoThumb(bytes: Uint8Array, mime: string, max = 256, timeoutMs = 6000): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blobOf(bytes, mime || "video/mp4"));
  try {
    const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = url;
    await race(new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error("this browser cannot decode the video")); }), timeoutMs);
    const t = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(1, v.duration * 0.1) : 0;
    await race(new Promise<void>((res, rej) => { v.onseeked = () => res(); v.onerror = () => rej(new Error("seek failed")); v.currentTime = t; }), timeoutMs);
    if (!v.videoWidth) throw new Error("no video frame");
    const f = fit(v.videoWidth, v.videoHeight, max); const c = document.createElement("canvas"); c.width = f.w; c.height = f.h;
    c.getContext("2d")!.drawImage(v, 0, 0, f.w, f.h);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
export async function renderSvgThumb(bytes: Uint8Array, max = 256, meta?: FileMeta): Promise<HTMLCanvasElement> {
  // an SVG in an <img> never runs scripts nor fetches external resources (HTML spec "secure static mode")
  const url = URL.createObjectURL(blobOf(bytes, "image/svg+xml"));
  try {
    const img = new Image(); img.decoding = "async"; img.src = url; await race(img.decode(), 4000);
    const w0 = img.naturalWidth || meta?.width || max, h0 = img.naturalHeight || meta?.height || max;
    const f = fit(w0, h0, max); const c = document.createElement("canvas"); c.width = f.w; c.height = f.h;
    // vector art is usually drawn for a light page: paper behind it keeps dark strokes visible on dark themes
    const g = c.getContext("2d")!; g.fillStyle = "#ffffff"; g.fillRect(0, 0, f.w, f.h); g.drawImage(img, 0, 0, f.w, f.h); return c;
  } finally { URL.revokeObjectURL(url); }
}
const race = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);

export async function canvasToWebp(c: Canv): Promise<Blob> {
  const b = "convertToBlob" in c ? await c.convertToBlob({ type: "image/webp", quality: 0.82 }) : await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((x) => x ? res(x) : rej(new Error("encode failed")), "image/webp", 0.82));
  return b;
}
