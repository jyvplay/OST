/**
 * TT52 e2e — the PDF app in the real UI (Chromium 143 headless; the browser has NO built-in PDF viewer, so everything
 * on screen comes from the first-party engine in src/lib/pdf):
 *  - a corpus file opens with one thumbnail per page (count checked against PDFium) and ink on the page canvas;
 *  - drag-highlight text, draw a box, add a sticky note, rotate + delete + reorder pages, set the title → Ctrl+S →
 *    PDFium/pypdf (independent readers) see exactly those edits, and the original bytes are an exact prefix;
 *  - form fields filled in the Forms panel are read back by pypdf;
 *  - Find counts matches; encrypted files ask for the password (wrong one refused);
 *  - undo/redo across edits; Ctrl+Z typed inside the Find box never undoes the document;
 *  - modal-shortcut failure test: while the Title dialog owns the keyboard, Ctrl+Z / Ctrl+S / PageDown never reach
 *    the document (no undo, no save, no page change);
 *  - Peek draws the first page itself (no <embed>, which the CSP blocks) and "Open in PDF app" opens the window.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt52-pdf.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { mkpdf } from "./tt52/mkpdf.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `p${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt52-pdf");
const COV = { "FF-03": "full", "PR-08": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/pdf";
const tmp = mkdtempSync(join(tmpdir(), "e2e52-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/pdf", encoding: "base64" }); ok(r.status < 300, `upload ${path}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8")); }
const probe = (mode: string, file: string) => JSON.parse(execFileSync(PY, ["scripts/oracle/pdf_probe.py", mode, file], { encoding: "utf8" }).trim().split("\n")[0]);
const local = (name: string, b: Uint8Array) => { const p = join(tmp, name); writeFileSync(p, b); return p; };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openPdf(path: string, opts: { password?: string } = {}) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=pdf&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const app = page.locator('[data-testid="pdf-app"]').first();
  if (opts.password !== undefined) { const ask = page.locator('[data-testid="ask-dialog"]'); await ask.waitFor({ timeout: 25_000 }); await ask.locator("input").first().fill(opts.password); await ask.locator("input").first().press("Enter"); }
  await app.locator('[data-testid="pdf-thumb"]').first().waitFor({ timeout: 30_000 });
  const status = app.locator('[data-testid="pdf-status"]');
  const save = async () => { await app.locator('[data-testid="pdf-stage"]').click({ position: { x: 5, y: 5 } }); await page.keyboard.press("Control+s"); await status.filter({ hasText: /Saved/ }).waitFor({ timeout: 15_000 }); };
  const pageEl = (i: number) => app.locator('[data-testid="pdf-page"]').nth(i);
  return { page, app, status, save, pageEl, close: () => ctx.close() };
}
/** pixels on the i-th page canvas that are not white (the renderer drew something) */
const inkOf = (page: Page, i: number) => page.locator('[data-testid="pdf-page"] canvas').nth(i).evaluate((c: HTMLCanvasElement) => { const x = c.getContext("2d")!; const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 16) if (d[k] < 200 || d[k + 1] < 200 || d[k + 2] < 200) n++; return n; });
async function waitInk(page: Page, i: number) { for (let t = 0; t < 60; t++) { if (await inkOf(page, i).catch(() => 0) > 50) return; await page.waitForTimeout(250); } throw new Error(`page ${i + 1} never drew`); }

await test("corpus files open: one thumbnail per page (= PDFium page count), page canvases carry ink — tracemonkey.pdf (14 pages), alphatrans.pdf, 160F-2019.pdf (forms)", COV, async () => {
  for (const f of ["tracemonkey.pdf", "alphatrans.pdf", "160F-2019.pdf"]) {
    const src = `/Documents/${RUN}-${f}`; await upload(src, readFileSync(join(CORPUS, f)));
    const s = await openPdf(src); const n = probe("--struct", join(CORPUS, f)).pdfium.n;
    eq(await s.app.locator('[data-testid="pdf-thumb"]').count(), n, `${f} thumbnails`);
    await waitInk(s.page, 0); ok(/page/.test(await s.status.innerText()), "status");
    await s.page.screenshot({ path: join(SHOTS, `e2e52-${f.replace(".pdf", "")}.png`) }); await s.close();
  }
});

await test("annotate + page ops + title → Ctrl+S → PDFium/pypdf see exactly those edits; original bytes are an exact prefix (incremental update)", COV, async () => {
  const orig = mkpdf([{ text: ["Highlight this sentence for the test"] }, { text: ["Second page"] }, { text: ["Third page"] }]);
  const src = `/Documents/${RUN}-edit.pdf`; await upload(src, orig); const s = await openPdf(src); await waitInk(s.page, 0);
  const box = (await s.pageEl(0).boundingBox())!; const k = box.width / 612; const at = (x: number, y: number) => [box.x + x * k, box.y + (792 - y) * k] as const;
  // highlight: drag across the first line (baseline y=720, 14 pt)
  await s.app.locator('[data-testid="pdf-tool-highlight"]').click();
  let [x0, y0] = at(70, 732), [x1, y1] = at(200, 716); await s.page.mouse.move(x0, y0); await s.page.mouse.down(); await s.page.mouse.move(x1, y1, { steps: 5 }); await s.page.mouse.up();
  await s.status.filter({ hasText: /Highlight/ }).waitFor({ timeout: 10_000 });
  // box
  await s.app.locator('[data-testid="pdf-tool-box"]').click();
  [x0, y0] = at(100, 500); [x1, y1] = at(250, 400); await s.page.mouse.move(x0, y0); await s.page.mouse.down(); await s.page.mouse.move(x1, y1, { steps: 5 }); await s.page.mouse.up();
  await s.status.filter({ hasText: /Box/ }).waitFor({ timeout: 10_000 });
  // sticky note
  await s.app.locator('[data-testid="pdf-tool-note"]').click(); [x0, y0] = at(450, 650); await s.page.mouse.click(x0, y0); // keep inside the viewport at fit-width zoom
  const ask = s.page.locator('[data-testid="ask-dialog"]'); await ask.waitFor(); await ask.locator("input, textarea").first().fill("Check the numbers"); await ask.locator('[data-testid="ask-ok"]').click();
  await s.status.filter({ hasText: /note/i }).waitFor({ timeout: 10_000 });
  await s.app.locator('[data-testid="pdf-tool-select"]').click();
  // page ops: page 3 → rotate right, move up; then delete (now) page 3 = "Second page"
  await s.app.locator('[data-testid="pdf-thumb"]').nth(2).click(); await s.app.locator('[data-testid="pdf-rot-right"]').click();
  await s.status.filter({ hasText: /Rotat/ }).waitFor({ timeout: 10_000 });
  await s.app.locator('[data-testid="pdf-move-up"]').click(); await s.status.filter({ hasText: /Move/ }).waitFor({ timeout: 10_000 });
  await s.app.locator('[data-testid="pdf-thumb"]').nth(2).click(); await s.app.locator('[data-testid="pdf-delete"]').click();
  const confirm = s.page.locator('[data-testid="ask-dialog"]'); if (await confirm.isVisible().catch(() => false)) await confirm.locator('[data-testid="ask-ok"]').click();
  await s.status.filter({ hasText: /Delete/ }).waitFor({ timeout: 10_000 });
  // title
  await s.app.locator('[data-testid="pdf-panel-info"]').click(); await s.app.locator('[data-testid="pdf-info-Title"]').click();
  await ask.waitFor(); await ask.locator("input").first().fill("Reviewed report"); await ask.locator('[data-testid="ask-ok"]').click();
  await s.status.filter({ hasText: /title/i }).waitFor({ timeout: 10_000 });
  await s.page.screenshot({ path: join(SHOTS, "e2e52-edit.png") });
  await s.save(); await s.close();
  const out = await readBytes(src); ok(out.length > orig.length && Buffer.from(out.subarray(0, orig.length)).equals(Buffer.from(orig)), "original bytes are not an exact prefix");
  const p = local("edit.pdf", out); const st = probe("--struct", p); const tx = probe("--text", p); const an = probe("--annots", p);
  eq(st.pdfium.n, 2, "pages"); eq(st.pdfium.rot, [0, 90], "rotation");
  eq(tx.pages.map((t: string) => t.trim()), ["Highlight this sentence for the test", "Third page"], "PDFium page text/order");
  eq(an.pages[0].map((a: { subtype: string }) => a.subtype).sort(), ["/Highlight", "/Square", "/Text"], "annotations");
  ok(an.pages[0].every((a: { ap: boolean }) => a.ap), "every annotation has an appearance stream");
  ok(an.pages[0].find((a: { subtype: string; contents: string }) => a.subtype === "/Text").contents === "Check the numbers", "note text");
  eq(st.info["/Title"], "Reviewed report", "title (pypdf)");
});

await test("forms: Tx + checkbox + choice filled in the Forms panel → pypdf reads the values", COV, async () => {
  const orig = mkpdf([{ text: ["Application"] }], { fields: [{ name: "fullname", type: "Tx", rect: [72, 600, 300, 620] }, { name: "agree", type: "Btn", rect: [72, 560, 86, 574] }, { name: "colour", type: "Ch", rect: [72, 520, 200, 540], options: ["Red", "Green", "Blue"] }] });
  const src = `/Documents/${RUN}-form.pdf`; await upload(src, orig); const s = await openPdf(src);
  await s.app.locator('[data-testid="pdf-panel-forms"]').click(); const fl = s.app.locator('[data-testid="pdf-field"]'); eq(await fl.count(), 3, "fields listed");
  await fl.nth(0).fill("Grace Hopper"); await fl.nth(0).press("Enter"); await s.status.filter({ hasText: /fullname/ }).waitFor({ timeout: 10_000 });
  await s.app.locator('[data-testid="pdf-field"]').nth(1).check(); await s.status.filter({ hasText: /agree/ }).waitFor({ timeout: 10_000 });
  await s.app.locator('[data-testid="pdf-field"]').nth(2).selectOption("Blue"); await s.status.filter({ hasText: /colour/ }).waitFor({ timeout: 10_000 });
  await waitInk(s.page, 0); await s.page.screenshot({ path: join(SHOTS, "e2e52-forms.png") });
  await s.save(); await s.close();
  const f = probe("--forms", local("form.pdf", await readBytes(src))).fields; eq([f.fullname, f.agree, f.colour], ["Grace Hopper", "/Yes", "Blue"], "pypdf field values");
});

await test("find + undo/redo: matches counted; Ctrl+Z inside the Find box edits the box, not the document; toolbar undo/redo restore the rotation", COV, async () => {
  const orig = mkpdf([{ text: ["apple banana apple"] }, { text: ["cherry apple"] }]);
  const src = `/Documents/${RUN}-find.pdf`; await upload(src, orig); const s = await openPdf(src);
  await s.app.locator('[data-testid="pdf-rot-right"]').click(); await s.status.filter({ hasText: /Rotat/ }).waitFor();
  await s.app.locator('[data-testid="pdf-stage"]').click({ position: { x: 5, y: 5 } }); await s.page.keyboard.press("Control+f");
  const find = s.app.locator('[data-testid="pdf-find"]'); await find.waitFor(); await find.fill("apple");
  await s.app.locator('[data-testid="pdf-hits"]').filter({ hasText: /^3 matches/ }).waitFor({ timeout: 10_000 });
  await find.press("Control+z"); ok(await s.app.locator('[data-testid="pdf-undo"]').isEnabled(), "Ctrl+Z in the Find box undid the document");
  await s.app.locator('[data-testid="pdf-undo"]').click(); ok(await s.app.locator('[data-testid="pdf-redo"]').isEnabled(), "redo not available");
  ok(!(await s.app.locator('[data-testid="pdf-undo"]').isEnabled()), "undo still enabled after undoing the only edit");
  await s.app.locator('[data-testid="pdf-redo"]').click(); ok(await s.app.locator('[data-testid="pdf-undo"]').isEnabled(), "redo did not re-apply");
  await s.close();
});

await test("modal-shortcut failure test: while the Title dialog is open, Ctrl+Z / Ctrl+S / PageDown never reach the document", COV, async () => {
  const orig = mkpdf([{ text: ["one"] }, { text: ["two"] }, { text: ["three"] }]);
  const src = `/Documents/${RUN}-modal.pdf`; await upload(src, orig); const s = await openPdf(src);
  await s.app.locator('[data-testid="pdf-rot-right"]').click(); await s.status.filter({ hasText: /Rotat/ }).waitFor();
  await s.app.locator('[data-testid="pdf-panel-info"]').click(); await s.app.locator('[data-testid="pdf-info-Title"]').click();
  const ask = s.page.locator('[data-testid="ask-dialog"]'); await ask.waitFor();
  const pageNo = async () => /page (\d+) \//.exec(await s.status.innerText())?.[1]; const before = await pageNo(); eq(before, "1", "starts on page 1");
  for (const k of ["Control+z", "Control+s", "PageDown", "Control+y"]) await s.page.keyboard.press(k);
  // the dialog's own input may receive the keys; the document must not
  await ask.locator("input").first().press("Escape"); await ask.waitFor({ state: "hidden" });
  ok(await s.app.locator('[data-testid="pdf-undo"]').isEnabled(), "Ctrl+Z behind the modal undid the rotation");
  ok(!(await s.app.locator('[data-testid="pdf-redo"]').isEnabled()), "redo became available → an undo happened");
  eq(await pageNo(), before, "PageDown behind the modal changed the page");
  ok(!/Saved/.test(await s.status.innerText()), "Ctrl+S behind the modal saved");
  eq(Buffer.from(await readBytes(src)).equals(Buffer.from(orig)), true, "file changed on disk");
  await s.close();
});

await test("encrypted: issue6010_1.pdf asks for a password; a wrong one is refused, 'abc' opens it and the page draws", COV, async () => {
  const src = `/Documents/${RUN}-enc.pdf`; await upload(src, readFileSync(join(CORPUS, "issue6010_1.pdf")));
  await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=pdf&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const ask = page.locator('[data-testid="ask-dialog"]'); await ask.waitFor({ timeout: 25_000 }); eq(await ask.locator("input").first().getAttribute("type"), "password", "masked");
  await ask.locator("input").first().fill("nope"); await ask.locator("input").first().press("Enter");
  await ask.waitFor({ timeout: 10_000 }); await page.waitForTimeout(300); ok(await ask.isVisible(), "wrong password accepted");
  await ask.locator("input").first().fill("abc"); await ask.locator("input").first().press("Enter");
  await page.locator('[data-testid="pdf-thumb"]').first().waitFor({ timeout: 20_000 }); await waitInk(page, 0);
  ok(/encrypted/.test(await page.locator('[data-testid="pdf-status"]').innerText()), "status mentions encryption"); await ctx.close();
});

await test("Peek: first page drawn by the first-party renderer (no <embed>/<object>); 'Open in PDF app' opens the PDF window", COV, async () => {
  const src = `/Documents/${RUN}-peek.pdf`; await upload(src, mkpdf([{ text: ["Peek preview text"] }, { text: ["two"] }]));
  await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=peek&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const pv = page.locator('[data-testid="peek-pdf"]'); await pv.waitFor({ timeout: 25_000 });
  for (let t = 0; t < 40; t++) { const w = await pv.locator("canvas").evaluate((c: HTMLCanvasElement) => c.width).catch(() => 0); if (w > 0) break; await page.waitForTimeout(250); }
  const ink = await pv.locator("canvas").evaluate((c: HTMLCanvasElement) => { const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 16) if (d[k] < 200) n++; return n; });
  ok(ink > 20, `preview blank (${ink})`); eq(await page.locator("embed, object").count(), 0, "embed/object present");
  await page.screenshot({ path: join(SHOTS, "e2e52-peek.png") });
  await pv.locator('[data-testid="peek-pdf-open"]').click(); await page.locator('[data-testid="pdf-app"] [data-testid="pdf-thumb"]').nth(1).waitFor({ timeout: 25_000 });
  await ctx.close();
});

await test("no uncaught page errors during the run", COV, () => { ok(errors.length === 0, errors.slice(0, 5).join("\n")); });
await browser.close();
// TT55: remove this run's files (left behind they piled up in /Documents and crowded the desktop / Tabletop of later suites)
{
  const post = (body: unknown) => fetch(BASE + "/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ls = await (await fetch(`${BASE}/api/fs?op=list&path=/Documents`)).json() as { nodes?: { name: string; path: string }[] };
  for (const n of ls.nodes ?? []) if (n.name.startsWith(`${RUN}-`)) { await post({ op: "trash", path: n.path }); await post({ op: "purge", path: n.path }); }
}
finish();
