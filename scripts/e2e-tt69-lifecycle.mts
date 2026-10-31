/**
 * TT69 FF-15 document lifecycle in the real UI (Chromium, production build): open → dirty → save → recover → close-confirm.
 *  1. Spreadsheet: closing a dirty window asks "Save changes?" — a MODAL test: Delete / typing / Ctrl+Z / Ctrl+S /
 *     Alt+F4 / Meta+W, a script focusing the grid and a raw mouse click on a cell all fail to reach the workbook behind
 *     it; Tab stays inside; Escape cancels (window open, still unsaved); Save writes the file (openpyxl) and closes.
 *  2. Writer: typing writes a recovery draft (python-docx reads the draft's bytes) with no version snapshots; Close →
 *     Don't save keeps it; reopening offers Restore; Restore brings the text back unsaved; Save clears the draft.
 *  3. Writer New over unsaved work asks (Cancel keeps the text; Don't save starts a new document and keeps a draft).
 *  4. leaving the page with unsaved work raises the browser's beforeunload prompt; a clean page does not.
 *  5. Editor: drafts land INSIDE /System/Recovery (TT68 wrote beside it), Discard deletes the draft.
 *  6. Spreadsheet: a draft older than the file is offered flagged as changed-since; Restore brings the edit back.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt69-lifecycle.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { decodeDraft, draftPathFor } from "../src/lib/doc-lifecycle.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t69${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e69-"));
const { test, finish } = makeHarness("e2e-tt69-lifecycle");
const FULL = { "FF-15": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const readNode = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return r.status === 200 && r.json?.node ? r.json.node as { content: string; encoding?: string } : null; };
const bytesOf = async (path: string) => { const n = await readNode(path); if (!n) throw new Error(`missing ${path}`); return Buffer.from(n.content, n.encoding === "base64" ? "base64" : "utf8"); };
const versions = async (p: string) => ((await api("GET", `/api/fs?op=versions&path=${encodeURIComponent(p)}`)).json?.versions ?? []).length as number;
const purge = async (p: string) => { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); };
const upload = async (path: string, bytes: Uint8Array, mime: string) => { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(r.status < 300, `upload ${r.status}`); };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const py = (code: string, ...args: string[]) => execFileSync(PY, ["-c", code, ...args], { encoding: "utf8" }).trim();
const xlsxCell = (file: string, ref: string) => py("import openpyxl,sys,json; wb=openpyxl.load_workbook(sys.argv[1]); print(json.dumps(wb.active[sys.argv[2]].value))", file, ref);
const docxText = (file: string) => py("import docx,sys; print('\\n'.join(p.text for p in docx.Document(sys.argv[1]).paragraphs))", file);

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const confirmBox = (page: Page) => page.getByTestId("close-confirm");
const cleanup: string[] = [];

/* ------------------------------------------------------------------ 1. Spreadsheet modal close-confirm */
await test("Spreadsheet: closing a dirty window asks Save changes? — MODAL: Delete, typing, Ctrl+Z, Ctrl+S, Alt+F4, Meta+W, a script focusing the grid and a raw click on a cell never reach the workbook; Tab stays inside; Escape cancels; Save writes the file and closes", FULL, async () => {
  const wb = new Workbook(); wb.sheet().setCell(0, 0, "1"); wb.recalculate();
  const src = `/Documents/${RUN}-close.xlsx`; cleanup.push(src); await upload(src, writeXlsxWorkbook(wb), XLSX);
  await putDesktop(); const page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  await cell("B1").click(); await page.keyboard.type("42"); await page.keyboard.press("Enter");
  await poll(async () => (await cell("B1").innerText()).trim() === "42", "B1 edited");
  await poll(async () => /unsaved/.test(await dlg.innerText()), "unsaved badge");
  const box = await cell("B1").boundingBox(); ok(box, "B1 box");
  await dlg.getByRole("button", { name: "Close window" }).first().click();
  await confirmBox(page).waitFor();
  eq(await confirmBox(page).getAttribute("role"), "alertdialog", "role"); eq(await confirmBox(page).getAttribute("aria-modal"), "true", "aria-modal");
  ok(/Save changes to “.*close\.xlsx”\?/.test(await confirmBox(page).innerText()), "names the document");
  eq(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? ""), "close-confirm-save", "Save has focus");
  // TT69 visual check caught pale text on a white fallback surface: assert WCAG AA contrast in dark AND light
  for (const theme of ["dark", "light"]) {
    const ratios = await page.evaluate((th) => {
      document.documentElement.dataset.theme = th;
      type C = [number, number, number, number];
      const parse = (c: string): C => { const m = c.match(/[\d.]+/g)!.map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
      const over = (top: C, under: C): C => [0, 1, 2].map((k) => top[k] * top[3] + under[k] * (1 - top[3])).concat(1) as C; // alpha compositing
      const lum = (c: C) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const box = document.querySelector('[data-testid="close-confirm"]') as HTMLElement;
      const page0: C = [128, 128, 128, 1]; // whatever is behind: the dialog surface must be opaque, so this must not matter
      const boxBg = over(parse(getComputedStyle(box).backgroundColor), page0);
      return [{ t: "(dialog surface alpha)", r: parse(getComputedStyle(box).backgroundColor)[3] === 1 ? 99 : 0 }].concat([...box.querySelectorAll("h2, p, button")].map((el) => {
        const bg = over(parse(getComputedStyle(el).backgroundColor), boxBg); const fg = over(parse(getComputedStyle(el).color), bg);
        const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p); return { t: (el.textContent ?? "").slice(0, 20), r: (x + 0.05) / (y + 0.05) };
      }));
    }, theme);
    for (const { t, r } of ratios) ok(r >= 4.5, `${theme}: "${t}" contrast ${r.toFixed(2)} < 4.5`);
    await page.screenshot({ path: `docs/screens/tt69-close-confirm-${theme}.png` });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  // the attacks
  await page.keyboard.press("Delete"); await page.keyboard.type("zz"); await page.keyboard.press("Backspace");
  for (const k of ["Control+z", "Control+s", "Alt+F4", "Meta+w", "Control+Shift+V", "F7"]) await page.keyboard.press(k);
  const focusedGrid = await dlg.locator('[data-testid="sheet-grid"]').evaluate((el) => { (el as HTMLElement).focus(); return el.contains(document.activeElement); });
  ok(!focusedGrid, "a script cannot focus the grid behind the dialog (inert)");
  await page.keyboard.press("Delete");
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.keyboard.press("Delete");
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    ok(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="close-confirm"]')), `Tab ${i + 1} stayed inside the dialog`);
  }
  await page.waitForTimeout(400);
  eq(await confirmBox(page).count(), 1, "exactly one dialog (Alt+F4 / Meta+W did not stack another)");
  ok(await dlg.isVisible(), "window still open");
  eq((await cell("B1").innerText()).trim(), "42", "B1 unchanged behind the dialog");
  writeFileSync(join(tmp, "before.xlsx"), await bytesOf(src));
  eq(xlsxCell(join(tmp, "before.xlsx"), "B1"), "null", "Ctrl+S behind the dialog saved nothing");
  await page.keyboard.press("Escape");
  await poll(async () => (await confirmBox(page).count()) === 0, "Escape cancelled");
  ok(await dlg.isVisible(), "Cancel keeps the window"); ok(/unsaved/.test(await dlg.innerText()), "still unsaved");
  eq((await cell("B1").innerText()).trim(), "42", "edit kept after Cancel");
  // now Save
  await dlg.getByRole("button", { name: "Close window" }).first().click();
  await confirmBox(page).waitFor(); await page.getByTestId("close-confirm-save").click();
  await poll(async () => (await page.locator('[role=dialog][aria-label="Spreadsheet"]').count()) === 0, "window closed after Save");
  writeFileSync(join(tmp, "after.xlsx"), await bytesOf(src));
  eq(xlsxCell(join(tmp, "after.xlsx"), "B1"), "42", "openpyxl reads the saved edit");
  eq(await readNode(draftPathFor("sheet", src)), null, "no draft left after Save");
  await page.context().close();
});

/* ------------------------------------------------------------------ 2+3. Writer drafts, Don't save, Restore, New */
const docPath = `/Documents/${RUN}-life.docx`;
await test("Writer: typing writes a recovery draft (python-docx reads its bytes; no version snapshots); Close → Don't save keeps it; reopening offers Restore; Restore brings the text back unsaved; Save writes it and deletes the draft", FULL, async () => {
  const local = join(tmp, "base.docx");
  py("import docx,sys; d=docx.Document(); d.add_paragraph('Alpha base paragraph'); d.save(sys.argv[1])", local);
  cleanup.push(docPath); await upload(docPath, Buffer.from(execFileSync("cat", [local])), DOCX);
  await putDesktop(); let page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(docPath)}`, { waitUntil: "domcontentloaded" });
  let dlg = page.locator('[role=dialog][aria-label="Writer"]').first();
  let body = dlg.locator('[data-testid="writer-body"]'); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  await body.locator("[data-pid]").filter({ hasText: "Alpha base" }).first().click(); await page.keyboard.press("End");
  const mark = ` ZETA${RUN}`; await page.keyboard.type(mark);
  const dp = draftPathFor("writer", docPath);
  await poll(async () => !!(await readNode(dp)), "draft written after the idle debounce", 12_000);
  const d = decodeDraft((await readNode(dp))!.content, "writer"); ok(d, "draft decodes");
  eq(d!.path, docPath, "draft records its document"); ok(/^[0-9a-f]{64}$/.test(d!.baseSha ?? ""), "draft records the opened file's sha");
  writeFileSync(join(tmp, "draft.docx"), Buffer.from(d!.payload, "base64"));
  ok(docxText(join(tmp, "draft.docx")).includes(mark.trim()), "python-docx reads the typed text in the draft's .docx bytes");
  eq(await versions(dp), 0, "draft writes keep no version history");
  await dlg.getByRole("button", { name: "Close window" }).first().click();
  await confirmBox(page).waitFor();
  ok(/recovery draft is kept/.test(await confirmBox(page).innerText()), "the dialog says a draft is kept");
  await page.getByTestId("close-confirm-discard").click();
  await poll(async () => (await page.locator('[role=dialog][aria-label="Writer"]').count()) === 0, "closed without saving");
  ok(await readNode(dp), "the draft survives Don't save");
  writeFileSync(join(tmp, "orig.docx"), await bytesOf(docPath));
  ok(!docxText(join(tmp, "orig.docx")).includes(mark.trim()), "the file itself was not saved");
  await page.context().close();
  // reopen → Restore
  await putDesktop(); page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(docPath)}`, { waitUntil: "domcontentloaded" });
  dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); body = dlg.locator('[data-testid="writer-body"]');
  await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  const banner = dlg.getByTestId("recover-banner"); await banner.waitFor();
  ok(!/changed since/.test(await banner.innerText()), "not stale: the file is the one the draft was based on");
  await dlg.getByTestId("recover-restore").click();
  await poll(async () => (await body.innerText()).includes(mark.trim()), "restored text visible");
  ok(/Save •/.test(await dlg.getByTestId("writer-save").innerText()), "restored = unsaved");
  await dlg.getByTestId("writer-save").click();
  await poll(async () => !(await readNode(dp)), "Save deletes the draft");
  writeFileSync(join(tmp, "saved.docx"), await bytesOf(docPath));
  ok(docxText(join(tmp, "saved.docx")).includes(`Alpha base paragraph${mark}`), "python-docx reads the restored + saved paragraph");
  // 3. New over unsaved work
  await body.locator("[data-pid]").filter({ hasText: "Alpha base" }).first().click(); await page.keyboard.press("End");
  await page.keyboard.type(" NU");
  await poll(async () => /Save •/.test(await dlg.getByTestId("writer-save").innerText()), "dirty again");
  await dlg.getByTestId("writer-new").click();
  await confirmBox(page).waitFor();
  ok(/Starting a new document replaces it/.test(await confirmBox(page).innerText()), "replace wording");
  await page.keyboard.press("Escape");
  await poll(async () => (await confirmBox(page).count()) === 0, "cancelled");
  ok((await body.innerText()).includes("NU"), "Cancel keeps the text (TT68's New discarded it silently)");
  await dlg.getByTestId("writer-new").click(); await confirmBox(page).waitFor();
  await page.getByTestId("close-confirm-discard").click();
  await poll(async () => !(await body.innerText()).includes("Alpha base"), "a new document replaced it");
  const kept = decodeDraft((await readNode(dp))?.content ?? "", "writer"); ok(kept, "Don't save on New keeps a draft of the old document");
  writeFileSync(join(tmp, "kept.docx"), Buffer.from(kept!.payload, "base64"));
  ok(docxText(join(tmp, "kept.docx")).includes(`${mark} NU`), "the kept draft has the last edit (flushed before replacing)");
  cleanup.push(dp);
  await page.context().close();
});

/* ------------------------------------------------------------------ 4. beforeunload */
await test("leaving the page with unsaved work raises the browser's beforeunload prompt (dismiss = stay); a page with nothing unsaved closes without one", FULL, async () => {
  await putDesktop(); const page = await newPage();
  await page.goto(`${BASE}/?open=writer`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); const body = dlg.locator('[data-testid="writer-body"]');
  await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  let seen = "";
  page.on("dialog", async (dl) => { seen = dl.type(); await dl.dismiss(); });
  await page.waitForTimeout(800);
  await page.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 800));
  eq(seen, "", "clean document: no prompt"); ok(page.isClosed(), "the clean page closed");
  await page.context().close();
  const p2 = await newPage();
  await p2.goto(`${BASE}/?open=writer`, { waitUntil: "domcontentloaded" });
  // TT75: the closed page's autosave restores its Writer window; the deep link now opens its own window on top
  // (before the TT75 Shell id fix it collided with the restored id and was dropped) — use the newest window
  const d2 = p2.locator('[role=dialog][aria-label="Writer"]').last(); const b2 = d2.locator('[data-testid="writer-body"]');
  await b2.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  await b2.locator("[data-pid]").first().click(); await p2.keyboard.type("unsaved words");
  await poll(async () => /Save •/.test(await d2.getByTestId("writer-save").innerText()), "dirty");
  let seen2 = "";
  p2.on("dialog", async (dl) => { seen2 = dl.type(); await dl.dismiss(); });
  await p2.close({ runBeforeUnload: true });
  await poll(async () => seen2 === "beforeunload", "beforeunload prompt shown", 5000);
  ok(!p2.isClosed(), "dismissing the prompt keeps the page");
  await p2.context().close();
});

/* ------------------------------------------------------------------ 5. Editor */
await test("Editor: the draft lands INSIDE /System/Recovery (TT68 wrote /System/Recovery_… beside it); Don't save keeps it; reopening offers it; Discard deletes it and leaves the file as it was", FULL, async () => {
  const p = `/Documents/${RUN}-notes.md`; cleanup.push(p);
  ok((await api("POST", "/api/fs", { op: "write", path: p, content: "original line", reason: "test" })).status === 200, "seed file");
  await putDesktop(); let page = await newPage();
  await page.goto(`${BASE}/?open=editor&path=${encodeURIComponent(p)}`, { waitUntil: "domcontentloaded" });
  let ta = page.getByRole("textbox", { name: `Editing ${p}` }); await ta.waitFor({ timeout: 25_000 });
  await poll(async () => (await ta.inputValue()) === "original line", "loaded");
  await ta.click(); await page.keyboard.press("End"); await page.keyboard.type(" plus draft");
  const dp = draftPathFor("editor", p); ok(dp.startsWith("/System/Recovery/editor-"), dp);
  await poll(async () => decodeDraft((await readNode(dp))?.content ?? "", "editor")?.payload === "original line plus draft", "editor draft", 12_000);
  eq(await readNode(`/System/Recovery${p.replace(/\//g, "_")}.draft`), null, "nothing at the legacy path");
  const win = page.locator('[role=dialog][aria-label="Editor"]').first();
  await (win.getByRole("button", { name: "Close window" }).first()).click(); await confirmBox(page).waitFor();
  await page.getByTestId("close-confirm-discard").click();
  await poll(async () => (await page.locator('[role=dialog][aria-label="Editor"]').count()) === 0, "closed");
  await page.context().close();
  await putDesktop(); page = await newPage();
  await page.goto(`${BASE}/?open=editor&path=${encodeURIComponent(p)}`, { waitUntil: "domcontentloaded" });
  ta = page.getByRole("textbox", { name: `Editing ${p}` }); await ta.waitFor({ timeout: 25_000 });
  await page.getByTestId("recover-banner").waitFor();
  await page.getByTestId("recover-discard").click();
  await poll(async () => !(await readNode(dp)), "Discard deleted the draft");
  eq(await ta.inputValue(), "original line", "the file's text is untouched");
  eq((await readNode(p))?.content, "original line", "the file on the server is untouched");
  await page.context().close();
});

/* ------------------------------------------------------------------ 7. Editor Ctrl+S scope */
await test("Editor: Ctrl+S saves only from inside its own window — not under the Save dialog, not with focus outside the window (TT68's listener saved from anywhere)", FULL, async () => {
  const p = `/Documents/${RUN}-scope.md`; cleanup.push(p);
  await api("POST", "/api/fs", { op: "write", path: p, content: "v1", reason: "test" });
  await putDesktop(); const page = await newPage();
  await page.goto(`${BASE}/?open=editor&path=${encodeURIComponent(p)}`, { waitUntil: "domcontentloaded" });
  const ta = page.getByRole("textbox", { name: `Editing ${p}` }); await ta.waitFor({ timeout: 25_000 });
  await poll(async () => (await ta.inputValue()) === "v1", "loaded");
  await ta.click(); await page.keyboard.press("End"); await page.keyboard.type("+x");
  const win = page.locator('[role=dialog][aria-label="Editor"]').first();
  await win.getByRole("button", { name: "Close window" }).first().click(); await confirmBox(page).waitFor();
  await page.keyboard.press("Control+s"); await page.keyboard.press("Meta+s"); await page.waitForTimeout(900);
  eq((await readNode(p))?.content, "v1", "Ctrl+S under the dialog saved nothing");
  await page.keyboard.press("Escape"); await poll(async () => (await confirmBox(page).count()) === 0, "cancelled");
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  await page.keyboard.press("Control+s"); await page.waitForTimeout(900);
  eq((await readNode(p))?.content, "v1", "Ctrl+S with focus outside the Editor saved nothing");
  await ta.click(); await page.keyboard.press("Control+s");
  await poll(async () => (await readNode(p))?.content === "v1+x", "Ctrl+S inside the Editor saves");
  await page.context().close();
});

/* ------------------------------------------------------------------ 6. stale spreadsheet draft */
await test("Spreadsheet: a draft whose file changed since is offered flagged as changed-since; Restore brings the drafted edit back as unsaved (the newer file is not overwritten until Save)", FULL, async () => {
  const wb = new Workbook(); wb.sheet().setCell(0, 0, "1"); wb.recalculate();
  const src = `/Documents/${RUN}-stale.xlsx`; cleanup.push(src); await upload(src, writeXlsxWorkbook(wb), XLSX);
  await putDesktop(); let page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  let dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  await dlg.locator('[data-cell="C3"]').click(); await page.keyboard.type("drafted"); await page.keyboard.press("Enter");
  const dp = draftPathFor("sheet", src);
  await poll(async () => !!(await readNode(dp)), "sheet draft", 12_000);
  await page.context().close(); // the tab dies without a close (no question was asked: a crash / killed tab)
  const wb2 = new Workbook(); wb2.sheet().setCell(0, 0, "2"); wb2.recalculate(); await upload(src, writeXlsxWorkbook(wb2), XLSX);
  await putDesktop(); page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const banner = dlg.getByTestId("recover-banner"); await banner.waitFor();
  ok(/changed since this draft/.test(await banner.innerText()), "flagged as changed since");
  eq((await dlg.locator('[data-cell="A1"]').innerText()).trim(), "2", "before Restore the newer file is shown");
  await dlg.getByTestId("recover-restore").click();
  await poll(async () => (await dlg.locator('[data-cell="C3"]').innerText()).trim() === "drafted", "drafted edit restored");
  ok(/unsaved/.test(await dlg.innerText()), "restored = unsaved");
  writeFileSync(join(tmp, "stale.xlsx"), await bytesOf(src));
  eq(xlsxCell(join(tmp, "stale.xlsx"), "A1"), "2", "the newer file is untouched until Save");
  cleanup.push(dp);
  await page.context().close();
});

for (const p of cleanup) await purge(p);
eq(errors, [], "page errors");
await browser.close();
finish();
