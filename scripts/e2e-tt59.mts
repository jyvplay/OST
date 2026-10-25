/**
 * TT59 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-38 Writer proofing: a python-docx fixture opens with wavy underlines painted through the CSS Custom Highlight API
 *         (misspellings + a repeated word; w:noProof / fr-FR / URLs / UPPERCASE skipped) → F7 Spelling pane → Change,
 *         Change to (typed), Ignore All, Delete repeated word → right-click menu on a misspelling → suggestion →
 *         typed new word → Add to Dictionary (persisted per browser) → Escape closes only the menu / pane → Ctrl+S →
 *         lxml reads the saved document.xml
 *   FF-39 Spreadsheet spelling: F7 → Not in dictionary 1 of 3 (row-major) → Change / typed Change / Delete repeated
 *         word → "Spelling check complete" → formulas never touched → Escape closes only the panel
 *   FF-05 Photos ▸ Export GIF / BMP (our encoders) → Pillow decodes bit-exact; Chromium re-opens the GIF
 *   FF-28 Paste Special ▸ Paste Link → =$C$1 in the target, follows a source edit → openpyxl reads the saved formula
 * Ground truth: saved bytes read by lxml (docx_spell.py) and openpyxl; expected strings written out by hand.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt59.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t59${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e59-"));
const { test, finish } = makeHarness("e2e-tt59");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Second" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}

await test("FF-38 Writer spell check in the UI: highlights painted → F7 pane Change / typed Change / Ignore All / Delete repeated word → right-click menu suggestion → Add to Dictionary persists → Escape closes only menu/pane → saved document.xml (lxml)", { "FF-38": "full" }, async () => {
  const fx = join(tmp, "spell.docx"); execFileSync(PY, ["scripts/oracle/docx_spell.py", "make", fx]);
  const path = `/Documents/${RUN}-spell.docx`;
  const up = await api("POST", "/api/fs", { op: "upload", path, content: readFileSync(fx).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  ok(up.status === 200, "upload");
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 30_000 });
  const body = dlg.getByTestId("writer-body"); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  const doc = dlg.locator(".wdoc");
  const nIssues = async () => Number(await doc.getAttribute("data-spell-issues"));
  await poll(async () => (await nIssues()) === 5, "5 issues (Teh, jumpd, recieve, repeated 'is', Tabel)", 25_000);
  const hl = () => page.evaluate(() => { const H = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights; const w = (k: string) => [...(H.get(k) ?? [])].map((r) => r.toString()); return { spell: w("fusion-spell"), repeat: w("fusion-repeat") }; });
  const h0 = await hl();
  eq(h0.spell.sort(), ["Tabel", "Teh", "jumpd", "recieve"], "wavy underlines on exactly the misspellings (URL, e-mail, ordinals, noProof, fr-FR, NASA/XYZZY skipped)");
  eq(h0.repeat.map((s) => s.trim()), ["is"], "repeated word highlighted");
  await page.screenshot({ path: "docs/screens/tt59-writer-underlines.png" });
  // F7: the Spelling pane starting at the first issue
  await body.locator("p[data-pid]").first().click(); await page.keyboard.press("Control+Home");
  await page.keyboard.press("F7");
  const pane = dlg.getByTestId("writer-spell-panel"); await pane.waitFor();
  await poll(async () => /Issue 1 of 5/.test(await pane.getByTestId("spell-count").innerText()), "Issue 1 of 5");
  eq(await pane.getByTestId("spell-word").innerText(), "Teh", "first issue");
  eq((await pane.getByTestId("spell-suggestions").getByRole("option").allInnerTexts())[0], "The", "top suggestion");
  await page.screenshot({ path: "docs/screens/tt59-writer-spell-pane.png" });
  await pane.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => (await nIssues()) === 4, "4 left");
  eq(await pane.getByTestId("spell-word").innerText(), "jumpd", "next issue");
  await pane.getByLabel("Change to").fill("jumped"); await pane.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => (await pane.getByTestId("spell-word").innerText()) === "recieve", "recieve next");
  // modal-shortcut failure test: Escape in the pane's text box must not close Writer
  await pane.getByLabel("Change to").focus(); await page.keyboard.press("Escape"); ok(await dlg.isVisible(), "Writer still open after Escape in the pane");
  await pane.getByRole("button", { name: "Ignore All" }).click();
  await poll(async () => (await nIssues()) === 2, "ignored for the session");
  await poll(async () => /Repeated word/.test(await pane.innerText()), "repeated word shown");
  await pane.getByRole("button", { name: "Delete repeated word" }).click();
  await poll(async () => (await nIssues()) === 1, "one issue left (Tabel)");
  // right-click the table-cell misspelling → Word-style menu → pick the suggestion
  const where = () => page.evaluate(() => {
    const root = document.querySelector(".wdoc")!; const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { const k = n.textContent!.indexOf("Tabel"); if (k >= 0) { const r = document.createRange(); r.setStart(n, k + 1); r.setEnd(n, k + 3); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } }
    return null;
  });
  let rect = await where(); ok(rect, "Tabel on the page");
  const newBtn = dlg.getByRole("button", { name: "New", exact: true }).first(); const docTop = (await newBtn.boundingBox())!.y;
  await page.mouse.click(rect!.x, rect!.y, { button: "right" });
  const menu = page.getByTestId("spell-menu"); await menu.waitFor();
  eq(await menu.getAttribute("aria-label"), "Spelling: Tabel", "menu for the word under the pointer");
  // regression (found in this suite's screenshot): the menu opens AT the pointer and focusing it does not scroll the window
  const mb = (await menu.boundingBox())!; ok(Math.abs(mb.x - rect!.x) < 2 && (Math.abs(mb.y - rect!.y) < 2 || (mb.y < rect!.y && mb.y + mb.height <= 1000)), `menu at the pointer (or lifted to stay on screen): ${JSON.stringify(mb)} vs ${JSON.stringify(rect)}`);
  eq((await newBtn.boundingBox())!.y, docTop, "window body did not scroll (toolbar stays put; a table toolbar row may appear below it)");
  await page.screenshot({ path: "docs/screens/tt59-writer-spell-menu.png" });
  await page.keyboard.press("Escape"); await poll(async () => (await menu.count()) === 0, "Escape closes the menu only"); ok(await dlg.isVisible(), "Writer open");
  rect = await where(); // the caret entered the table, so its toolbar row now shows and the text moved down
  await page.mouse.click(rect!.x, rect!.y, { button: "right" }); await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Table", exact: true }).click();
  await poll(async () => (await nIssues()) === 0, "all fixed");
  await poll(async () => /Spelling check complete/.test(await pane.innerText()), "complete");
  // a new coinage → Add to Dictionary → stays accepted after a reload (per-browser user dictionary)
  await body.locator("p[data-pid]").first().click(); await page.keyboard.press("End"); await page.keyboard.type(" Zorbleflux");
  await poll(async () => (await nIssues()) === 1, "new word flagged as you type");
  await pane.getByRole("button", { name: "Add to Dictionary" }).click();
  await poll(async () => (await nIssues()) === 0, "accepted");
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.spell.user") ?? "[]")), ["Zorbleflux"], "user dictionary stored on this device");
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const f = join(tmp, "saved.docx"); writeFileSync(f, await read(path));
  const o = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_spell.py", "read", f], { encoding: "utf8" }));
  const texts = o.paras.map((p: { text: string }) => p.text);
  eq(texts[0], "The quick brown fox jumped over the lazy dog. Zorbleflux", "first paragraph saved with the fixes");
  ok(texts.includes("This is a repeated word and NASA plus XYZZY."), "repeated word deleted");
  ok(texts.includes("Table cell"), "table cell fixed via the menu");
  ok(texts.some((t: string) => t.includes("and recieve this.")), "Ignore All leaves the text");
  // reload: the word added to the dictionary is still accepted
  await page.reload({ waitUntil: "domcontentloaded" });
  const d2 = page.locator('[role=dialog][aria-label="Writer"]').first(); await d2.locator(".wdoc[data-spell-issues]").waitFor({ timeout: 30_000 });
  await poll(async () => Number(await d2.locator(".wdoc").getAttribute("data-spell-issues")) === 1, "after reload only 'recieve' (Ignore All was per session) is flagged; Zorbleflux stays accepted", 25_000);
  await page.context().close();
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path });
});

await test("FF-39 Spreadsheet spelling + FF-28 Paste Link in the UI: F7 → 1 of 3 row-major → Change / typed Change / Delete repeated word → complete; formula untouched; Escape closes the panel only; Paste Link =$C$1 follows the source; openpyxl reads the save", { "FF-39": "full", "FF-28": "full" }, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  sh.setCell(0, 0, "Teh report"); sh.setCell(1, 0, "Recieved payments"); sh.setCell(2, 0, "10");
  sh.setCell(0, 1, '=CONCATENATE("Teh", " sum")'); sh.setCell(1, 1, "go go now"); wb.recalculate();
  const orig = writeXlsxWorkbook(wb); const src = `/Documents/${RUN}-spell.xlsx`;
  const up = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(orig).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(up.status < 300, `upload ${up.status}`);
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const txt = async (r: string) => (await cell(r).innerText()).trim();
  await cell("A1").click(); await page.keyboard.press("F7");
  const panel = dlg.getByTestId("sheet-spell-panel"); await panel.waitFor();
  const status = panel.getByTestId("sheet-spell-status");
  await poll(async () => /Not in dictionary 1 of 3: Teh in Sheet1!A1/.test(await status.innerText()), "first issue A1", 25_000);
  eq(await panel.getByTestId("sheet-spell-suggestions").inputValue(), "The", "top suggestion");
  await page.screenshot({ path: "docs/screens/tt59-sheet-spell.png" });
  await panel.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => (await txt("A1")) === "The report", "A1 fixed");
  await poll(async () => /1 of 2: Recieved in Sheet1!B1/.test(await status.innerText()), "row-major: B1 next");
  await panel.getByLabel("Change to").fill("Received"); await panel.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => /Repeated word 1 of 1: go in Sheet1!B2/.test(await status.innerText()), "repeated word in B2");
  await panel.getByRole("button", { name: "Delete repeated word" }).click();
  await poll(async () => /Spelling check complete/.test(await status.innerText()), "complete");
  eq([await txt("A1"), await txt("B1"), await txt("A2"), await txt("B2")], ["The report", "Received payments", "Teh sum", "go now"], "grid: formula result untouched");
  await page.keyboard.press("F7"); await panel.waitFor(); await panel.getByRole("button", { name: "Close" }).focus(); await page.keyboard.press("Escape");
  await poll(async () => (await panel.count()) === 0, "Escape closed the panel"); ok(await dlg.isVisible(), "Spreadsheet still open");
  // Paste Link
  await cell("C1").click(); await page.keyboard.press("Control+c");
  await cell("E5").click(); await page.keyboard.press("Control+Shift+V");
  const ps = dlg.getByTestId("paste-special"); await ps.waitFor();
  await ps.getByRole("button", { name: "Paste Link", exact: true }).click();
  await poll(async () => (await txt("E5")) === "10", "linked value");
  await cell("C1").click(); await page.keyboard.type("25"); await page.keyboard.press("Enter");
  await poll(async () => (await txt("E5")) === "25", "follows the source edit");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = new Uint8Array();
  await poll(async () => { saved = Uint8Array.from(await read(src)); return Buffer.compare(Buffer.from(saved), orig) !== 0; }, "saved bytes changed");
  await page.context().close();
  const f = join(tmp, "spell.xlsx"); writeFileSync(f, saved);
  const o = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", "import json,sys,openpyxl; ws=openpyxl.load_workbook(sys.argv[1]).active; print(json.dumps({c: ws[c].value for c in ['A1','B1','C1','A2','B2','E5']}))", f], { encoding: "utf8" }).trim());
  eq(o, { A1: "The report", B1: "Received payments", C1: 25, A2: '=CONCATENATE("Teh", " sum")', B2: "go now", E5: "=$C$1" }, "openpyxl");
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: src });
});

await test("FF-05 Photos exports GIF and BMP (our encoders): Pillow decodes both bit-exact to the source pixels; Chromium re-opens the GIF", { "FF-05": "full" }, async () => {
  const src = join(tmp, "flat.png");
  execFileSync(PY, ["-c", `
from PIL import Image
import random
random.seed(5); pal = [(random.randrange(256), random.randrange(256), random.randrange(256)) for _ in range(12)]
im = Image.new("RGB", (64, 48))
for y in range(48):
    for x in range(64): im.putpixel((x, y), pal[(x // 8 + y // 6 * 3) % 12])
im.save("${src}")`]);
  const path = `/Documents/${RUN}-flat.png`;
  const up = await api("POST", "/api/fs", { op: "upload", path, content: readFileSync(src).toString("base64"), mime: "image/png" }); ok(up.status < 300, "upload");
  const made: string[] = [path];
  for (const fmt of ["gif", "bmp"] as const) {
    await putDesktop([]); const page = await newPage();
    await page.goto(`${BASE}/?open=photos&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="photos-editor"]').waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Export…" }).click();
    const dlg = page.locator('[data-testid="photos-export"]');
    ok(!(await dlg.locator(`option[value="${fmt}"]`).isDisabled()), `${fmt} offered`);
    await dlg.locator("select").first().selectOption(fmt);
    ok((await dlg.getByRole("slider").count()) === 0, "no quality slider for a lossless palette / 24-bit format");
    const meta = dlg.getByLabel("Include camera metadata"); if (await meta.count()) await meta.uncheck();
    if (fmt === "gif") await page.screenshot({ path: "docs/screens/tt59-photos-export-gif.png" });
    await dlg.getByRole("button", { name: "Export", exact: true }).click();
    const toast = page.getByText(new RegExp(`Exported ${RUN}-flat-edited[^ ]*\\.${fmt}`)).first(); await toast.waitFor({ timeout: 30_000 });
    const name = new RegExp(`Exported (${RUN}-flat-edited[^ ]*\\.${fmt})`).exec(await toast.innerText())![1]; const out = `/Documents/${name}`; made.push(out);
    const local = join(tmp, name); writeFileSync(local, await read(out));
    const r = JSON.parse(execFileSync(PY, ["-c", `
import sys, json, numpy as np
from PIL import Image
a = Image.open(sys.argv[1]); fmt = a.format; a = np.asarray(a.convert("RGB")).astype(int); b = np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(int)
print(json.dumps({"fmt": fmt, "shape": list(a.shape), "max": int(np.abs(a - b).max()) if a.shape == b.shape else -1}))`, local, src], { encoding: "utf8" }));
    eq(r, { fmt: fmt.toUpperCase(), shape: [48, 64, 3], max: 0 }, `${fmt}: Pillow decodes the export bit-exact`);
    if (fmt === "gif") {
      // Chromium decodes our GIF: open it in Photos
      await page.goto(`${BASE}/?open=photos&path=${encodeURIComponent(out)}`, { waitUntil: "domcontentloaded" });
      // TT75: the PNG's Photos window is restored and the GIF opens in a second window (before the Shell id fix the
      // deep-linked window collided with the restored id and was silently dropped)
      await page.locator('[data-testid="photos-editor"]').last().waitFor({ timeout: 30_000 });
      const dims = await page.evaluate(async (u) => { const b = await (await fetch(u)).json(); const bytes = Uint8Array.from(atob(b.node.content), (c) => c.charCodeAt(0)); const bm = await createImageBitmap(new Blob([bytes], { type: "image/gif" })); return [bm.width, bm.height]; }, `/api/fs?op=read&path=${encodeURIComponent(out)}`);
      eq(dims, [64, 48], "Chromium's GIF decoder reads it");
    }
    await page.context().close();
  }
  for (const p of made) for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: p });
});

await test("no uncaught page errors during the TT59 session", { "WM-05": "full" }, () => { eq(errors, [], "page errors"); });

await browser.close();
finish();
