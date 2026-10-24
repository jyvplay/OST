/**
 * TT21: rasterise public/icon.svg + icon-maskable.svg to the PNG sizes the manifest and iOS need, with the same
 * headless Chromium the suites use (no image library needed). Run: node … scripts/render-icons.mts
 */
import { readFile, writeFile } from "node:fs/promises";
import { launchChromium } from "./browser-launch.mts";

const jobs: [string, string, number][] = [
  ["public/icon.svg", "public/icon-192.png", 192],
  ["public/icon.svg", "public/icon-512.png", 512],
  ["public/icon-maskable.svg", "public/icon-maskable-512.png", 512],
  ["public/icon-maskable.svg", "public/apple-touch-icon.png", 180], // iOS adds its own rounding: use the full-bleed art
];
const browser = await launchChromium();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [src, out, px] of jobs) {
  const svg = (await readFile(src, "utf8")).replace(/width="512" height="512"/, `width="${px}" height="${px}"`);
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const buf = await page.locator("svg").screenshot({ omitBackground: true });
  await writeFile(out, buf);
  console.log(out, buf.length, "bytes");
}
await browser.close();
