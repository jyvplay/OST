/** TT52 — render differential: our canvas renderer (in headless Chromium) vs PDFium PNGs (scripts/oracle/pdf_probe.py --render). */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { build } from "esbuild";
import { launchChromium } from "./browser-launch.mts";
const DIR = process.env.PDFDIR ?? "/home/user/tools/corpus/pdf", REF = process.env.REFDIR ?? "/tmp/ref";
const PW: Record<string, string> = { "issue15893_reduced.pdf": "test", "issue3371.pdf": "ELXRTQWS", "issue6010_1.pdf": "abc", "issue6010_2.pdf": "æøå", "bug1782186.pdf": "Hello", "issue21579.pdf": "pässwört", "saslprep-r6.pdf": "SªSL\u00adprep" };
const bundle = await build({ entryPoints: [process.env.ENTRY ?? "scripts/tt52/render-entry.ts"], bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent" });
const js = bundle.outputFiles[0].text;
const browser = await launchChromium(); let page = await browser.newPage();
await page.setContent("<html><body></body></html>"); await page.addScriptTag({ content: js });
const files = readFileSync("/tmp/render.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((o) => o.pngs?.length && (!process.env.ONLY || o.file === process.env.ONLY));
const res: { file: string; sim?: number; ink?: number; error?: string; warnings?: string[]; ms?: number }[] = [];
const keep = async () => { if (process.env.KEEP) { mkdirSync("/tmp/ours", { recursive: true }); await page.evaluate(() => { (window as unknown as { __keep: boolean }).__keep = true; }); } };
await keep();
for (const o of files) {
  const pdf = readFileSync(`${DIR}/${o.file}`).toString("base64"); const ref = "data:image/png;base64," + readFileSync(o.pngs[0].path).toString("base64");
  let r: any;
  try { r = await Promise.race([page.evaluate(([a, b, c]) => (window as any).__pdf.run(a, b, c), [pdf, ref, PW[o.file]]), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 30s")), 30000))]); }
  catch (e) { r = { error: (e as Error).message }; try { await page.close(); } catch {} page = await browser.newPage(); await page.setContent("<html></html>"); await page.addScriptTag({ content: js }); await keep(); }
  if (r?.png) writeFileSync(`/tmp/ours/${o.file}.png`, Buffer.from(r.png.split(",")[1], "base64"));
  res.push({ file: o.file, ...r, png: undefined });
}
await browser.close();
const ok = res.filter((r) => r.sim !== undefined); const mean = (k: "sim" | "ink") => ok.reduce((a, r) => a + (r[k] ?? 0), 0) / ok.length;
const bucket = (t: number) => ok.filter((r) => (r.ink ?? 0) >= t).length;
console.log({ pages: res.length, rendered: ok.length, errors: res.length - ok.length, meanSim: mean("sim").toFixed(4), meanInk: mean("ink").toFixed(4), ink90: bucket(0.9), ink80: bucket(0.8), ink50: bucket(0.5) });
const worst = ok.sort((a, b) => (a.ink ?? 0) - (b.ink ?? 0)).slice(0, Number(process.env.N ?? 30));
console.log(worst.map((r) => `${(r.ink ?? 0).toFixed(3)} ${(r.sim ?? 0).toFixed(3)} ${r.file} ${r.ms}ms ${JSON.stringify(r.warnings ?? []).slice(0, 140)}`).join("\n"));
console.log("ERRORS", res.filter((r) => r.error).map((r) => `${r.file}: ${r.error?.slice(0, 160)}`).slice(0, 15));
writeFileSync("/tmp/tt52-render.json", JSON.stringify(res));
