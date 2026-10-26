/**
 * TT46 real-browser suite (Playwright + headless Chromium 143 against the production server) for the Writer.
 * Every assertion reads the rendered DOM after real keyboard/mouse input, or the bytes the UI saved — which are then
 * checked by python-docx (independent oracle). Corpus files: Apache POI test-data (Apache-2.0, test-only).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt46.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { openZip } from "../src/lib/office/zipkit.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `w${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt46");
const COV = { "FF-22": "full", "PR-11": "partial", "FF-11": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/docx";
const tmp = mkdtempSync(join(tmpdir(), "e2e46-"));
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }); ok(r.status === 200, `upload ${path}: ${JSON.stringify(r.json).slice(0, 200)}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8")); }
const probe = (file: string) => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_probe.py", file], { encoding: "utf8" }).trim());

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openWriter(path?: string): Promise<{ page: Page; dlg: Locator; body: Locator; close: () => Promise<void> }> {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=writer${path ? `&path=${encodeURIComponent(path)}` : ""}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first();
  await dlg.waitFor({ state: "visible", timeout: 25_000 });
  const body = dlg.locator('[data-testid="writer-body"]');
  await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  return { page, dlg, body, close: () => ctx.close() };
}
const pagesOf = async (dlg: Locator) => Number((await dlg.locator('[data-testid="writer-pages"]').innerText()).replace(/\D+/g, ""));

await test("welcome document renders as a paged Word document (title style, bullet markers, bordered table, page box)", COV, async () => {
  const { dlg, body, close } = await openWriter();
  const title = body.locator("[data-pid]").first();
  eq((await title.innerText()).trim(), "Welcome to Writer", "title text");
  ok(Number((await title.evaluate((e) => getComputedStyle(e).fontSize)).toString().replace("px", "")) || parseFloat(await title.evaluate((e) => getComputedStyle(e).fontSize)) > 30, "title is large");
  eq(await body.locator(".wmark").first().innerText(), "•", "bullet marker");
  const docx = body.locator("span[data-ri]").filter({ hasText: /^\.docx$/ });
  eq(await docx.evaluate((e) => getComputedStyle(e).fontWeight), "700", "only .docx is bold");
  eq(await docx.evaluate((e) => getComputedStyle(e.nextElementSibling!).fontWeight), "400", "following run is not bold");
  eq(await body.locator("table.wtbl td").count(), 6, "table cells");
  ok(await dlg.locator(".wpage").count() >= 1, "page box");
  await close();
});
await test("typing with the real keyboard: text, Enter, Shift+Arrow selection + Ctrl+B, Ctrl+Z undo, Backspace join", COV, async () => {
  const { page, dlg, body, close } = await openWriter();
  const last = body.locator("p[data-pid]").last();
  await last.click(); await page.keyboard.press("End");
  await page.keyboard.type("Typed by a test.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line here");
  ok((await body.innerText()).includes("Typed by a test."), "typed text visible");
  // select "here" and bold it
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Control+b");
  const bold = body.locator("span[data-ri]").filter({ hasText: /^here$/ });
  eq(await bold.evaluate((e) => getComputedStyle(e).fontWeight), "700", "bold applied");
  await page.keyboard.press("Control+z");
  eq(await body.locator("span[data-ri]", { hasText: /^here$/ }).count(), 0, "undo removed the bold split");
  // Backspace at start of the second line joins it to the first
  await page.keyboard.press("Home");
  const n0 = await body.locator("p[data-pid]").count();
  await page.keyboard.press("Backspace");
  eq(await body.locator("p[data-pid]").count(), n0 - 1, "paragraphs joined");
  ok((await body.innerText()).includes("Typed by a test.Second line here"), "joined text");
  ok(Number((await dlg.locator('[data-testid="writer-words"]').innerText()).split(" ")[0]) > 20, "word count");
  await close();
});
await test("Save as .docx from the UI → python-docx reads the typed text, Heading 1 style, bold run and bullet list", COV, async () => {
  const { page, dlg, body, close } = await openWriter();
  const first = body.locator("p[data-pid]").first();
  await first.click(); await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Saved heading");
  await dlg.getByLabel("Paragraph style").selectOption("Heading1");
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.keyboard.press("Control+b"); await page.keyboard.type("bold words"); await page.keyboard.press("Control+b"); await page.keyboard.type(" plain");
  await dlg.getByRole("button", { name: "Save as…" }).click();
  const dest = `/Documents/${RUN}-saved.docx`;
  await dlg.getByLabel("Save path").fill(dest);
  ok(/lossless/.test(await dlg.locator('[data-testid="writer-fidelity"]').innerText()), "fidelity note shown on Save-As (FF-11)");
  await dlg.getByRole("button", { name: "Save .docx" }).click();
  await dlg.locator('[data-testid="writer-status"]', { hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const f = join(tmp, "saved.docx"); writeFileSync(f, await readBytes(dest));
  const pr = probe(f);
  const h = pr.paras.find((p: { text: string }) => p.text === "Saved heading"); ok(h, "heading paragraph"); eq(h.style, "Heading 1", "heading style");
  const b = pr.paras.find((p: { text: string }) => p.text === "bold words plain"); ok(b, "bold paragraph: " + JSON.stringify(pr.paras.map((p: { text: string }) => p.text)));
  eq(b.runs.map((r: { text: string; b: boolean | null }) => [r.text, !!r.b]), [["bold words", true], [" plain", false]], "runs");
  ok(pr.paras.filter((p: { numId: number | null }) => p.numId !== null).length >= 3, "bullet list kept");
  eq(pr.tables[0][0], ["Feature", "Saved to .docx"], "table");
  await close();
});
await test("real Word file (POI bug57031.docx): tables, header on every page, multiple pages; edit+save keeps all other parts byte-identical", COV, async () => {
  const src = new Uint8Array(readFileSync(join(CORPUS, "bug57031.docx")));
  const path = `/Documents/${RUN}-57031.docx`; await upload(path, src);
  const { page, dlg, body, close } = await openWriter(path);
  ok(await body.locator("table.wtbl").count() >= 10, "tables rendered");
  const pages = await pagesOf(dlg); ok(pages >= 2, `pages=${pages}`);
  eq(await dlg.locator(".wpage .whdr").count(), pages, "a header on every page");
  const p = body.locator("p[data-pid]").filter({ hasText: /\w{4,}/ }).first();
  await p.click(); await page.keyboard.press("Home"); await page.keyboard.type("ZQX ");
  await page.keyboard.press("Control+s");
  await dlg.locator('[data-testid="writer-status"]', { hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const out = await readBytes(path);
  const z0 = openZip(src), z1 = openZip(out);
  const diff: string[] = [];
  for (const e of z0.entries) { if (e.name.endsWith("/")) continue; const a = await z0.read(e.name), b = await z1.read(e.name); if (!b || Buffer.compare(Buffer.from(a!), Buffer.from(b)) !== 0) diff.push(e.name); }
  eq(diff.filter((n) => n !== "docProps/core.xml"), ["word/document.xml"], "only the main part changed");
  ok((await z1.readText("word/document.xml"))!.includes("ZQX "), "edit saved");
  const f = join(tmp, "57031.docx"); writeFileSync(f, out); const a = probe(join(CORPUS, "bug57031.docx")), b = probe(f);
  eq(b.tables.length, a.tables.length, "python-docx table count"); eq(b.paras.length, a.paras.length, "python-docx paragraph count");
  await close();
});
await test("pictures from a real file render as images; Ctrl+Enter adds a page; find & replace through the panel", COV, async () => {
  const path = `/Documents/${RUN}-pics.docx`; await upload(path, new Uint8Array(readFileSync(join(CORPUS, "issue_51265_3.docx"))));
  const { page, dlg, body, close } = await openWriter(path);
  const imgs = body.locator("img.wtok-image");
  ok(await imgs.count() >= 1, "images present");
  await imgs.first().evaluate((i: HTMLImageElement) => i.decode().catch(() => undefined));
  ok(await imgs.first().evaluate((i: HTMLImageElement) => i.naturalWidth > 0), "image decoded");
  const p0 = await pagesOf(dlg);
  const lastP = body.locator("p[data-pid]").last(); await lastP.click(); await page.keyboard.press("End");
  await page.keyboard.press("Control+Enter"); await page.keyboard.type("After the break");
  await page.waitForTimeout(400);
  eq(await pagesOf(dlg), p0 + 1, "page added by Ctrl+Enter");
  await dlg.getByRole("button", { name: "Find" }).click();
  await dlg.getByLabel("Find", { exact: true }).fill("After the break");
  await dlg.getByLabel("Replace with").fill("Replaced text");
  await dlg.getByRole("button", { name: "Replace all" }).click();
  ok((await body.innerText()).includes("Replaced text") && !(await body.innerText()).includes("After the break"), "replace all");
  await page.screenshot({ path: "/tmp/tt46-writer.png" });
  await close();
});
/* ---------------------------------------------------------------- Spreadsheet: lossless .xlsx (TT46) */
const XCORPUS = "/home/user/tools/corpus/xlsx";
async function openSheetFile(path: string) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
  await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (ref: string) => dlg.locator(`[data-cell="${ref}"]`);
  return { page, dlg, cell, close: () => ctx.close() };
}
const XCOV = { "FF-20": "full", "FF-11": "full", "PR-11": "partial" } as const;
await test("Spreadsheet: real Excel file with a table + conditional formats — structured refs evaluate in the UI; keyboard edit + Save keeps the package (openpyxl-verified)", XCOV, async () => {
  const src = `/Documents/${RUN}-cf.xlsx`;
  const orig = new Uint8Array(readFileSync(join(XCORPUS, "ConditionalFormattingSamples.xlsx")));
  await upload(src, orig);
  const { page, dlg, cell, close } = await openSheetFile(src);
  await dlg.locator('button[title="Double-click to rename"]').filter({ hasText: /^Regional sales$/ }).click();
  await cell("B12").waitFor({ timeout: 20_000 });
  const subtotal = await cell("B12").innerText();
  ok(/\d/.test(subtotal) && !/#REF|#NAME|#VALUE/.test(subtotal), `=SUBTOTAL(109,Table6[Sales]) shows "${subtotal}"`);
  let target = "";
  for (const ref of ["H3", "H5", "G3", "I3", "H8", "F14"]) if (await cell(ref).count() === 1 && (await cell(ref).innerText()).trim() === "") { target = ref; break; }
  ok(target, "a visible empty cell");
  await cell(target).click(); await page.keyboard.type("Fusion edit"); await page.keyboard.press("Enter");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  const status = dlg.locator('[data-testid="sheet-status"]');
  await status.filter({ hasText: "lossless" }).waitFor({ timeout: 15_000 });
  ok(/kept byte-identical/.test(await status.innerText()), await status.innerText());
  await close();
  const saved = await readBytes(src);
  const a = join(tmp, "cf-orig.xlsx"), b = join(tmp, "cf-saved.xlsx"); writeFileSync(a, orig); writeFileSync(b, saved);
  const r = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_patch_probe.py"], { input: `${a}\t${b}\n`, encoding: "utf8" }).trim());
  ok(r.ok, `openpyxl load: ${r.error}`);
  eq(r.diff, [`Regional sales!${target}`], "only the typed cell changed");
  eq(r.extras, {}, "conditional formats / validations / merges / names unchanged");
  eq(r.partsLost, [], "no part lost");
  eq(Object.keys(r.styleDiff), [], "no style drift");
});

await test("Spreadsheet: no-edit Save of a chart workbook leaves it byte-identical; rename a sheet + Save keeps the chart part and openpyxl sees the new name", XCOV, async () => {
  const src = `/Documents/${RUN}-chart.xlsx`;
  const orig = new Uint8Array(readFileSync(join(XCORPUS, "WithChart.xlsx")));
  await upload(src, orig);
  let s = await openSheetFile(src);
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.dlg.locator('[data-testid="sheet-status"]').filter({ hasText: "byte-identical" }).waitFor({ timeout: 15_000 });
  await s.close();
  eq(Buffer.compare(Buffer.from(await readBytes(src)), Buffer.from(orig)), 0, "untouched save is byte-identical");
  // rename through the API-equivalent UI path: double-click the tab opens the rename dialog
  s = await openSheetFile(src);
  const tab = s.dlg.locator('button[title="Double-click to rename"]').first();
  const oldName = (await tab.innerText()).trim();
  await tab.dblclick();
  const input = s.page.getByTestId("ask-dialog").locator("input").first();
  await input.fill("Renamed"); await input.press("Enter");
  await s.dlg.locator('button[title="Double-click to rename"]', { hasText: "Renamed" }).waitFor({ timeout: 5000 });
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.dlg.locator('[data-testid="sheet-status"]').filter({ hasText: "lossless" }).waitFor({ timeout: 15_000 });
  await s.close();
  const saved = await readBytes(src);
  const b = join(tmp, "chart-renamed.xlsx"); writeFileSync(b, saved);
  const r = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", `import openpyxl,zipfile,json
w=openpyxl.load_workbook(${JSON.stringify(b)});z=zipfile.ZipFile(${JSON.stringify(b)}).namelist()
print(json.dumps({"names":w.sheetnames,"charts":[n for n in z if n.startswith("xl/charts/")]}))`], { encoding: "utf8" }));
  ok(r.names.includes("Renamed") && !r.names.includes(oldName), `sheet names ${JSON.stringify(r.names)}`);
  const origCharts = openZip(orig).entries.filter((e) => e.name.startsWith("xl/charts/")).map((e) => e.name);
  eq(r.charts.sort(), origCharts.sort(), "chart parts kept");
});

await test("no uncaught page errors during the Writer session", COV, () => { eq(errors, [], "page errors"); });

await browser.close();
// hygiene: remove this run's uploads/saves so repeated runs don't pile up desktop icons and tabletop cards
{
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) if (n.path.startsWith(`/Documents/${RUN}-`)) {
    for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
  }
}
await finish();
process.exit(0);
