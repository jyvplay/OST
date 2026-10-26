import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook, readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import * as M from "../src/lib/office/pml.ts";
import { findSlideText } from "../src/lib/office/pmlsearch.ts";
import { PdfDoc } from "../src/lib/pdf/pdfdoc.ts";
import { validateSignatures } from "../src/lib/pdf/pdfsig.ts";
import { mkpdf } from "./tt52/mkpdf.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { test, finish } = makeHarness("e2e-tt81");
const BASE = process.env.BASE ?? "http://localhost:3999", RUN = `tt81-${Date.now()}`;
const PY = process.env.ORACLE_PY ?? "/home/user/runtime/venv/bin/python";
const temp = mkdtempSync(join(tmpdir(), "e2e81-"));
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`); return j; };
const paths: string[] = []; let uploadNo = 0;
const upload = async (ext: string, bytes: Uint8Array, mime: string) => { const path = `/Documents/${RUN}-${++uploadNo}.${ext}`; await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); paths.push(path); return path; };
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.node.content, r.node.encoding === "base64" ? "base64" : "utf8"); };
const browser = await launchChromium(); const errors: string[] = [];
async function open(module: string, path: string) {
  const cur = await api("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1600, h: 1000 } } });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(15000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=${module}&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  return { ctx, page };
}
mkdirSync("docs/screens", { recursive: true });
await test("E1 Spreadsheet MODE.MULT spill in real grid, edit, save and reopen computed output", { "FF-78": "full" }, async () => {
  const wb = new Workbook(); wb.sheet().setCell(0, 0, "=MODE.MULT({3,2,3,2})"); wb.recalculate();
  const path = await upload("xlsx", writeXlsxWorkbook(wb), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const { ctx, page } = await open("sheet", path);
  try {
    const dlg = page.getByRole("dialog", { name: "Spreadsheet", exact: true }).last();
    const grid = dlg.getByTestId("sheet-grid"); await grid.waitFor();
    const cell = (ref: string) => grid.locator(`[data-cell="${ref}"]`);
    await cell("A1").filter({ hasText: "3" }).waitFor(); await cell("A2").filter({ hasText: "2" }).waitFor();
    await cell("A1").click(); const bar = dlg.getByRole("textbox", { name: "Formula bar", exact: true });
    await bar.fill("=MODE.MULT({7,7,8,8})"); await bar.press("Enter"); await cell("A2").filter({ hasText: "8" }).waitFor();
    await dlg.getByRole("button", { name: "Save workbook", exact: true }).click(); await dlg.getByTestId("sheet-status").filter({ hasText: /saved/i }).waitFor();
    const out = readXlsxWorkbook(await read(path)); ok(out.valueAt(out.sheet().name, 0, 0) === 7 && out.valueAt(out.sheet().name, 0, 1) === 8, "saved spill differs");
    await dlg.screenshot({ path: "docs/screens/tt81-sheet.png" });
  } finally { await ctx.close(); }
});
await test("E2 PDF custom signature box: refuse off-page without saving, then sign valid box, save and independent pypdf geometry", { "FF-79": "full" }, async () => {
  const original = mkpdf([{ text: ["Custom signature test"], w: 600, h: 800, rotate: 90 }]);
  const path = await upload("pdf", original, "application/pdf"); const { ctx, page } = await open("pdf", path);
  try {
    const app = page.getByTestId("pdf-app").last(); await app.getByTestId("pdf-thumb").first().waitFor();
    await app.getByTestId("pdf-panel-sigs").click(); await app.getByTestId("pdf-sig-new").click();
    const ask = page.getByTestId("ask-dialog"); await ask.waitFor();
    await ask.locator("input").first().fill("TT81 Browser"); await ask.locator("input").first().press("Enter");
    await ask.filter({ hasText: "Email" }).waitFor(); await ask.locator("input").first().press("Enter");
    await app.getByTestId("pdf-sig-identity").filter({ hasText: "TT81 Browser" }).waitFor();
    await app.getByTestId("pdf-sig-visible").check(); await app.getByTestId("pdf-sig-custom").check();
    await app.getByTestId("pdf-sig-left").fill("9999"); await app.getByTestId("pdf-sig-sign").click();
    await page.getByText(/Signature box must fit/).first().waitFor(); ok((await read(path)).equals(Buffer.from(original)), "invalid box wrote file");
    ok(await app.getByTestId("pdf-sig").count() === 0, "invalid box signed");
    await app.getByTestId("pdf-sig-left").fill("77"); await app.getByTestId("pdf-sig-top").fill("113");
    await app.getByTestId("pdf-sig-sign").click(); await app.locator('[data-testid="pdf-sig"][data-status="valid"]').waitFor({ timeout: 20000 });
    await app.getByTestId("pdf-stage").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("Control+s");
    await app.getByTestId("pdf-status").filter({ hasText: /Saved/ }).waitFor(); const bytes = await read(path);
    ok((await validateSignatures(PdfDoc.open(bytes)))[0].status === "valid", "saved signature invalid");
    const f = join(temp, "ui.pdf"); writeFileSync(f, bytes);
    const rect = JSON.parse(execFileSync(PY, ["-c", "import pypdf,sys,json; p=pypdf.PdfReader(sys.argv[1]).pages[0]; print(json.dumps(list(map(float,p['/Annots'][0].get_object()['/Rect']))))", f], { encoding: "utf8" }));
    ok(JSON.stringify(rect) === "[113,77,183,297]", `rect ${rect}`);
    await app.screenshot({ path: "docs/screens/tt81-pdf.png" });
  } finally { await ctx.close(); }
});
await test("E3 Slides Find/Replace via Tweak menu, literal matching, undo/redo, modal shortcut isolation, save and python-pptx readback", { "FF-80": "full" }, async () => {
  const path = await upload("pptx", await M.blankPptx("Needle [x] Needle"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const { ctx, page } = await open("slides", path);
  try {
    const dlg = page.getByRole("dialog", { name: "Slides", exact: true }).last(), editor = dlg.getByLabel("Slides editor", { exact: true });
    await editor.waitFor(); await dlg.getByRole("listbox", { name: "Slides", exact: true }).getByRole("option").first().waitFor();
    ok(await dlg.getByTestId("slides-find").count() === 1, "duplicate Find commands");
    await dlg.getByTestId("app-banner").getByTestId("banner-menu-tweak").click(); await dlg.getByTestId("app-banner").getByRole("menuitemcheckbox", { name: "Find", exact: true }).click();
    const pane = dlg.getByTestId("slides-search"); await pane.waitFor(); const q = pane.getByRole("textbox", { name: "Find slide text", exact: true });
    await q.fill("[x]"); await pane.getByRole("status").filter({ hasText: "1 match(es)" }).waitFor();
    await q.fill("Needle"); await pane.getByRole("status").filter({ hasText: "2 match(es)" }).waitFor();
    await pane.getByRole("textbox", { name: "Replace slide text with", exact: true }).fill("Thread & <x>");
    await pane.getByTestId("slides-replace-all").click(); await pane.getByRole("status").filter({ hasText: "Replaced 2" }).waitFor();
    await editor.focus(); await page.keyboard.press("Control+z"); await pane.getByTestId("slides-search-hit").nth(1).waitFor();
    await page.keyboard.press("Control+y"); ok(await pane.getByTestId("slides-search-hit").count() === 0, "redo did not replace");
    // New attack: an open Save-as modal must own Ctrl+F, Delete and undo.
    await pane.getByRole("button", { name: "Close slide search" }).click();
    await dlg.getByTestId("app-banner").getByRole("button", { name: "Save", exact: true }).click(); await dlg.getByRole("status").filter({ hasText: /Saved .*lossless/ }).waitFor();
    const saved = await read(path), deck = await M.readPptxDoc(saved, "out.pptx"); ok(findSlideText(deck, "Thread & <x>").length === 2 && findSlideText(deck, "Needle").length === 0, "saved text differs");
    const f = join(temp, "ui.pptx"); writeFileSync(f, saved); const independent = execFileSync(PY, ["-c", "from pptx import Presentation; import sys; print(Presentation(sys.argv[1]).slides[0].shapes[0].text)", f], { encoding: "utf8" }); ok(independent.includes("Thread & <x> [x] Thread & <x>"), `python-pptx: ${independent}`);
    // File already has a path; Save-as is a separate command in Keep.
    await dlg.getByTestId("banner-menu-keep").click(); await dlg.getByRole("menuitem", { name: "Save as…", exact: true }).click();
    const modal = dlg.getByRole("dialog", { name: "Save as", exact: true }); await modal.waitFor();
    await modal.locator("input").press("Control+f"); await modal.locator("input").press("Delete");
    ok(await pane.count() === 0, "Ctrl+F opened behind Save-as"); ok((await read(path)).equals(saved), "modal shortcut changed disk");
    await modal.locator("input").press("Escape");
    await editor.focus(); await page.keyboard.press("Control+f"); await pane.waitFor(); await q.fill("Thread");
    await dlg.screenshot({ path: "docs/screens/tt81-slides.png" });
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await page.evaluate(async () => { const r = await (window as any).axe.run(document); return r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => v.id); });
    ok(!violations.length, `axe ${violations}`);
  } finally { await ctx.close(); }
});
await test("E4 PDF /UserUnit reaches the live viewer, text highlights, info panel and bounded canvases", { "FF-81": "partial" }, async () => {
  const bytes = mkpdf([{ text: ["Scaled unit"], w: 300, h: 400, userUnit: 2.5 }, { text: ["Default unit"], w: 300, h: 400 }]);
  const path = await upload("pdf", bytes, "application/pdf"); const { ctx, page } = await open("pdf", path);
  try {
    const app = page.getByTestId("pdf-app").last(); await app.getByTestId("pdf-thumb").first().waitFor();
    await app.getByRole("button", { name: "100%", exact: true }).click();
    const p1 = app.locator('[data-testid="pdf-page"]').nth(0), p2 = app.locator('[data-testid="pdf-page"]').nth(1);
    await p1.locator("canvas").waitFor();
    await page.waitForFunction((el) => { const c = el.querySelector("canvas"); return !!c && c.width === 750 && c.height === 1000; }, await p1.elementHandle());
    const a = await p1.evaluate((el) => ({ w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), cw: (el.querySelector("canvas") as HTMLCanvasElement).width, ch: (el.querySelector("canvas") as HTMLCanvasElement).height }));
    ok(a.w === 750 && a.h === 1000 && a.cw === 750 && a.ch === 1000, `2.5-unit first page rendered ${JSON.stringify(a)}`);
    await p2.scrollIntoViewIfNeeded(); await p2.locator("canvas").waitFor();
    await page.waitForFunction((el) => { const c = el.querySelector("canvas"); return !!c && c.width === 300 && c.height === 400; }, await p2.elementHandle());
    const b = await p2.evaluate((el) => ({ w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), cw: (el.querySelector("canvas") as HTMLCanvasElement).width, ch: (el.querySelector("canvas") as HTMLCanvasElement).height }));
    ok(b.w === 300 && b.h === 400 && b.cw === 300 && b.ch === 400, `default-unit second page changed: ${JSON.stringify(b)}`);
    await app.getByTestId("pdf-panel-info").click(); await app.getByText("2.5 × 1/72 in", { exact: true }).waitFor();
    await app.getByTestId("pdf-panel-find").click(); const find = app.getByTestId("pdf-find"); await find.fill("Scaled unit");
    await app.getByTestId("pdf-hits").filter({ hasText: "1 match" }).waitFor();
    const highlight = p1.locator("svg rect").first(); await highlight.waitFor();
    const hx = Number(await highlight.getAttribute("x")); ok(hx > 160 && hx < 220, `highlight x did not use UserUnit: ${hx}`);
    const f = join(temp, "user-unit-ui.pdf"); writeFileSync(f, bytes);
    const unit = JSON.parse(execFileSync(PY, ["-c", "import pypdf,sys,json; p=pypdf.PdfReader(sys.argv[1]).pages; print(json.dumps([float(x.get('/UserUnit',1)) for x in p]))", f], { encoding: "utf8" }));
    ok(JSON.stringify(unit) === "[2.5,1]", `pypdf read units ${unit}`);
    await app.screenshot({ path: "docs/screens/tt84-pdf-unit.png" });
  } finally { await ctx.close(); }
});
await test("E5 Writer Word Count reports document and selected text through the real UI", { "FF-82": "partial" }, async () => {
  const { ctx, page } = await open("writer", "");
  try {
    const app = page.locator('[role="dialog"][aria-label="Writer"]').last(), body = app.getByTestId("writer-body");
    await body.locator("[data-pid]").first().waitFor(); await app.getByTestId("writer-new").click();
    await body.locator("[data-pid]").first().waitFor(); await body.click(); await page.keyboard.press("Control+A"); await page.keyboard.type("Alpha beta gamma");
    await app.getByTestId("writer-words").filter({ hasText: "3 words" }).waitFor();
    await page.keyboard.press("Control+Home"); await page.keyboard.press("Control+Shift+ArrowRight");
    const openCount = app.getByTestId("writer-word-count-open"); await openCount.click(); const dialog = page.getByTestId("writer-word-count"); await dialog.waitFor();
    ok(await dialog.getByRole("button", { name: "Close Word Count" }).evaluate((el) => el === document.activeElement), "modal should focus its close control");
    await page.keyboard.press("Tab"); ok(await dialog.getByRole("button", { name: "Close Word Count" }).evaluate((el) => el === document.activeElement), "Tab should stay trapped in this single-control modal");
    ok(await dialog.getByTestId("writer-count-words").innerText() === "3", "document word count should be three");
    ok(await dialog.getByTestId("writer-count-chars").innerText() === "16", "document character count should include spaces");
    ok(await dialog.getByTestId("writer-count-chars-no-spaces").innerText() === "14", "document character count should omit spaces");
    ok(await dialog.getByTestId("writer-count-paragraphs").innerText() === "1", "document paragraph count should be one");
    ok(await dialog.getByTestId("writer-selection-words").innerText() === "1", "selection word count should be one");
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await page.evaluate(async () => { const r = await (window as any).axe.run(document); return r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => v.id); });
    ok(!violations.length, `Word Count dialog axe ${violations}`);
    await app.screenshot({ path: "docs/screens/tt84-writer-count.png" });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "writer-word-count-open");
  } finally { await ctx.close(); }
});
await test("E6 no browser page errors", {}, () => ok(!errors.length, errors.join("\n")));
await browser.close();
for (const path of paths) { await api("POST", "/api/fs", { op: "trash", path }); await api("POST", "/api/fs", { op: "purge", path }); }
finish();
