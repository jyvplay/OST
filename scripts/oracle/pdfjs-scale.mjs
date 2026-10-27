#!/usr/bin/env node
/** Independent test-only PDF.js raster oracle. Install pdfjs-dist and its canvas
 * optional dependency under TOOLS_DIR (default /home/user/tools); do not bundle
 * these packages into the PWA. PDF.js is Apache-2.0; @napi-rs/canvas is MIT. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = join(process.env.TOOLS_DIR ?? "/home/user/tools", "node_modules/pdfjs-dist");
const pdfjs = await import(pathToFileURL(join(root, "legacy/build/pdf.mjs")).href);
const data = new Uint8Array(await readFile(process.argv[2]));
const loading = pdfjs.getDocument({ data, standardFontDataUrl: join(root, "standard_fonts") + "/" });
const pdf = await loading.promise;
const pages = [];
try {
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = pdf.canvasFactory.create(viewport.width, viewport.height);
    try {
      await page.render({ canvasContext: canvas.context, viewport }).promise;
      const pixels = canvas.context.getImageData(0, 0, canvas.canvas.width, canvas.canvas.height).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240)) ink++;
      pages.push({ unit: page.userUnit, width: canvas.canvas.width, height: canvas.canvas.height, ink });
    } finally { pdf.canvasFactory.destroy(canvas); page.cleanup(); }
  }
} finally { await loading.destroy(); }
console.log(JSON.stringify(pages));
