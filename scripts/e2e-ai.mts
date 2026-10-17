/**
 * Real-browser suite "e2e-ai" (TT24, FF-04): .ai / .eps files written to the VFS and opened in Peek, in headless
 * Chromium against the production build. Uses the committed fixtures in scripts/fixtures/ai/ (file-type, MIT;
 * Apache Tika, Apache-2.0) and constructed hostile files from scripts/fixtures/ai/build.mts.
 * The PDF view is checked structurally (an <iframe> on a blob: URL that the CSP allows). Whether pixels appear depends
 * on the browser's PDF viewer: the suite records navigator.pdfViewerEnabled and does not claim a rendering it cannot see.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-ai.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import * as B from "./fixtures/ai/build.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-ai");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const RUN = Date.now().toString(36);
const made: string[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
async function put(name: string, bytes: Uint8Array) {
  const p = `/Art/e2e-${RUN}-${name}`; made.push(p);
  const r = await api("POST", "/api/fs", { op: "write", path: p, content: Buffer.from(bytes).toString("base64"), encoding: "base64" });
  ok(r.status === 200, `write ${p}: ${r.status} ${JSON.stringify(r.json)}`);
  return p;
}
const fixture = (f: string) => new Uint8Array(readFileSync(`scripts/fixtures/ai/${f}`));
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const browser: Browser = await launchChromium();
const downloads: string[] = [];
async function peek(path: string, forceViewer = false): Promise<{ page: Page; box: Locator; csp: string[]; close: () => Promise<void> }> {
  await desktop([{ id: "pk1", module: "peek", title: "Peek", x: 20, y: 10, w: 1000, h: 820, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { path } }]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (forceViewer) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", { get: () => true }));
  const page = await ctx.newPage();
  if (!forceViewer) page.on("download", (d) => downloads.push(d.suggestedFilename()));
  const csp: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const box = page.getByTestId("peek-ai");
  await box.waitFor({ timeout: 30_000 });
  const t0 = Date.now();
  while ((await box.getAttribute("data-kind")) === "pending") { if (Date.now() - t0 > 8000) throw new Error("sniff never finished"); await page.waitForTimeout(100); }
  return { page, box, csp, close: () => ctx.close() };
}
const facts = async (box: Locator) => box.getByTestId("peek-ai-facts").innerText();

let pdfViewer = "unknown";

await test("PDF-compatible .ai (constructed, Illustrator 28.5 + /AIPrivateData1): kind ai-pdf, facts shown; PDF part framed only when the browser has a PDF viewer, else an explicit download link (never an automatic download); no CSP violation", { "FF-04": "full" }, async () => {
  const p = await put("art.ai", B.aiWithPdf());
  const { page, box, csp, close } = await peek(p);
  ok(await box.getAttribute("data-kind") === "ai-pdf", `kind ${await box.getAttribute("data-kind")}`);
  ok((await box.getByTestId("peek-ai-label").innerText()).length > 10, "label");
  ok((await facts(box)).includes("Adobe Illustrator 28.5"), `facts: ${await facts(box)}`);
  pdfViewer = String(await page.evaluate(() => (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled));
  console.log(`    note: navigator.pdfViewerEnabled = ${pdfViewer} in this Chromium`);
  if (pdfViewer === "false") {
    // no viewer: no frame (a framed PDF would be downloaded), an explicit download link instead
    ok(await box.getByTestId("peek-ai-pdf").count() === 0, "no frame without a PDF viewer");
    const link = box.getByTestId("peek-ai-nopdf").locator("a");
    ok((await link.getAttribute("href"))!.startsWith("blob:") && (await link.getAttribute("download")) === `e2e-${RUN}-art.pdf`, "download link");
    ok(downloads.length === 0, `opening Peek downloaded something: ${downloads}`);
  } else {
    const frame = box.getByTestId("peek-ai-pdf");
    await frame.waitFor();
    const src = (await frame.getAttribute("src"))!;
    ok(await frame.evaluate((e) => e.tagName) === "IFRAME" && src.startsWith("blob:"), "an iframe on a blob: URL, not <embed> (object-src 'none')");
    ok(page.frames().some((f) => f.url() === src), "the frame navigated to the blob URL");
  }
  ok(csp.length === 0, `CSP violations: ${csp.join(" | ")}`);
  await close();
});

await test("with a PDF viewer present (navigator.pdfViewerEnabled forced true): the artwork is framed on a blob: URL, never <embed>, and the CSP allows it", { "FF-04": "partial" }, async () => {
  const p = await put("art2.ai", B.aiWithPdf());
  const { box, csp, close } = await peek(p, true);
  const frame = box.getByTestId("peek-ai-pdf");
  await frame.waitFor();
  ok(await frame.evaluate((e) => e.tagName) === "IFRAME" && (await frame.getAttribute("src"))!.startsWith("blob:"), "iframe on a blob: URL");
  ok(await box.locator("embed, object").count() === 0, "no embed/object");
  ok(csp.length === 0, `CSP violations: ${csp.join(" | ")}`);
  await close();
});

await test("real Illustrator-made PDF (file-type fixture): kind illustrator-pdf, version 24.1, renderable", { "FF-04": "full" }, async () => {
  const p = await put("ft.ai", fixture("ft-fixture-adobe-illustrator.pdf"));
  const { box, close } = await peek(p);
  ok(await box.getAttribute("data-kind") === "illustrator-pdf", `kind ${await box.getAttribute("data-kind")}`);
  ok((await facts(box)).includes("24.1"), `facts: ${await facts(box)}`);
  await box.locator('[data-testid="peek-ai-pdf"], [data-testid="peek-ai-nopdf"]').first().waitFor();   // whichever this browser supports
  await close();
});

await test("PostScript-era .ai (Apache Tika testAI_PS.ai) and an Illustrator EPS (file-type fixture): metadata only, no PDF view, 'limited' badge", { "FF-04": "full" }, async () => {
  for (const [name, bytes, want] of [["tika.ai", fixture("tika-testAI_PS.ai"), "FreeHand 8.0"], ["ft.eps", fixture("ft-fixture.eps"), "24.1"]] as const) {
    const p = await put(name, bytes);
    const { box, close } = await peek(p);
    ok(await box.getAttribute("data-kind") === "ai-ps", `${name} kind ${await box.getAttribute("data-kind")}`);
    ok((await facts(box)).includes(want), `${name} facts: ${await facts(box)}`);
    ok(await box.getByTestId("peek-ai-pdf").count() === 0, `${name}: no PDF view`);
    ok((await box.innerText()).includes("limited"), `${name}: limited badge`);
    await close();
  }
});

await test("hostile/edge files: Illustrator data without a PDF part is not rendered; an inflate bomb and 2000+ streams finish inside the 5 s watchdog", { "FF-04": "full", "FM-04": "partial" }, async () => {
  const p1 = await put("nopdf.ai", B.aiWithoutPdf());
  let v = await peek(p1);
  ok(await v.box.getAttribute("data-kind") === "ai-no-pdf", `kind ${await v.box.getAttribute("data-kind")}`);
  ok(await v.box.getByTestId("peek-ai-pdf").count() === 0, "no PDF view for ai-no-pdf");
  await v.close();
  for (const [name, bytes] of [["bomb.ai", B.inflateBomb()], ["many.ai", B.manyStreams()]] as const) {
    const p = await put(name, bytes);
    const t0 = Date.now(); v = await peek(p);
    ok(Date.now() - t0 < 15_000, `${name} took ${Date.now() - t0} ms`);
    ok(!(await v.page.getByText(/watchdog fired/).count()), `${name}: watchdog did not fire`);
    await v.close();
  }
});

await test("Files routing: double-clicking an .ai in Files opens Peek with the Illustrator panel", { "FF-04": "partial" }, async () => {
  const p = await put("route.ai", B.aiWithPdf());
  await desktop([{ id: "f1", module: "files", title: "Files", x: 20, y: 10, w: 900, h: 600, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { path: "/Art" } }]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const row = page.locator('.fs-window[aria-label="Files"] .fs-list-item', { hasText: p.split("/").pop()! });
  await row.waitFor({ timeout: 30_000 });
  await row.dblclick();
  await page.getByTestId("peek-ai").waitFor({ timeout: 15_000 });
  await ctx.close();
});

await desktop([]);
for (const p of made) await api("POST", "/api/fs", { op: "trash", path: p });
await browser.close();
console.log(`  pdfViewerEnabled=${pdfViewer}`);
finish();
