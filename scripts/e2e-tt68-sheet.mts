/**
 * TT68 — FF-52 in the real Spreadsheet UI (Chromium): empty cells vs empty text, error constants, *IF criteria.
 *   1. a workbook with a constant empty-text cell and an error constant opens with Excel's results
 *      (ISBLANK FALSE for "", COUNTA counts it, COUNTIF "#N/A" counts the error, "=" counts only the empty cell);
 *   2. typing ' (empty text) and #n/a (an error constant) in the grid behaves the same; Save writes them so that lxml
 *      (scripts/oracle/xlsx_values_lxml.py --empty-text) and openpyxl see empty text / an error cell;
 *   3. modal-shortcut test: with Paste Special open, typed characters, Delete and Enter must not edit the grid behind
 *      it; Escape closes only the dialog.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt68-sheet.mts
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

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t68${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e68-"));
const { test, finish } = makeHarness("e2e-tt68-sheet");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}

const wb = new Workbook(); const sh = wb.sheet();
// A1 empty text · A2 empty · A3 #N/A constant · A4 1
sh.setCell(0, 0, "'"); sh.setCell(0, 2, "#N/A"); sh.setCell(0, 3, "1");
const F = ["=ISBLANK(A1)", "=ISBLANK(A2)", '=COUNTIF(A1:A4,"#N/A")', "=COUNTA(A1:A4)", '=COUNTIF(A1:A4,"=")', '=COUNTIF(A1:A4,"<>")', "=ISNA(A3)"];
F.forEach((f, i) => sh.setCell(1, i, f)); wb.recalculate();
const orig = writeXlsxWorkbook(wb); const src = `/Documents/${RUN}-blank.xlsx`;
let page: Page;

await test("FF-52 in the UI: an opened workbook shows Excel's results for empty text and an error constant (ISBLANK FALSE / TRUE, COUNTIF \"#N/A\" 1, COUNTA 3, \"=\" 1, \"<>\" 3, ISNA TRUE)", { "FF-52": "full", "FF-28": "partial" }, async () => {
  const up = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(orig).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(up.status < 300, `upload ${up.status}`);
  await putDesktop([]); page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const txt = async (r: string) => (await dlg.locator(`[data-cell="${r}"]`).innerText()).trim();
  await poll(async () => (await txt("B7")) === "TRUE", "recalculated", 20_000);
  eq([await txt("B1"), await txt("B2"), await txt("B3"), await txt("B4"), await txt("B5"), await txt("B6"), await txt("B7")], ["FALSE", "TRUE", "1", "3", "1", "3", "TRUE"], "B1:B7");
  eq([await txt("A1"), await txt("A3")], ["", "#N/A"], "A1 shows nothing, A3 shows the error");
});

await test("FF-52 typing: ' makes empty text (ISBLANK FALSE), #n/a makes an error constant (ISNA TRUE); Save → lxml lists A1 and C1 as empty text, openpyxl reads C2 as an error cell", { "FF-52": "full", "FF-28": "partial" }, async () => {
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const txt = async (r: string) => (await cell(r).innerText()).trim();
  const typeIn = async (r: string, s: string) => { await cell(r).click(); await page.keyboard.type(s); await page.keyboard.press("Enter"); };
  await typeIn("C1", "'"); await typeIn("D1", "=ISBLANK(C1)"); await typeIn("C2", "#n/a"); await typeIn("D2", "=ISNA(C2)"); await typeIn("D3", "=COUNTA(C1:C3)");
  await poll(async () => (await txt("D3")) === "2", "COUNTA(C1:C3) = 2");
  eq([await txt("C1"), await txt("D1"), await txt("C2"), await txt("D2")], ["", "FALSE", "#N/A", "TRUE"], "typed cells");
  await page.screenshot({ path: "docs/screens/tt68-sheet-blank.png" });
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = Buffer.alloc(0);
  await poll(async () => { saved = await read(src); return Buffer.compare(saved, orig) !== 0; }, "saved bytes changed");
  const f = join(tmp, "saved.xlsx"); writeFileSync(f, saved);
  const lx = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", f, "--empty-text"], { encoding: "utf8" })) as Record<string, string[]>;
  eq(Object.values(lx)[0], ["A1", "C1"], "lxml empty-text cells");
  const o = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", "import json,sys,openpyxl; ws=openpyxl.load_workbook(sys.argv[1]).active; print(json.dumps({c: [ws[c].value, ws[c].data_type] for c in ['A2','A3','C2','D1']}))", f], { encoding: "utf8" }).trim());
  eq(o, { A2: [null, "n"], A3: ["#N/A", "e"], C2: ["#N/A", "e"], D1: ["=ISBLANK(C1)", "f"] }, "openpyxl");
});

await test("shortcut scope: Paste Special is a non-modal bar (TT60) — the grid keeps the keyboard and ArrowRight still moves the target, but typing, Delete, Backspace, F2, Enter, Ctrl+X / V / Z / D / B never edit the cell behind it, nor do keys typed into the bar's own controls; Escape closes only the bar (Spreadsheet stays open)", { "FF-52": "partial", "FF-28": "partial" }, async () => {
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const txt = async (r: string) => (await cell(r).innerText()).trim();
  const nameBox = () => dlg.getByRole("textbox", { name: /Name box/i }).inputValue().catch(() => "");
  await cell("A4").click(); await page.keyboard.press("Control+c");
  await cell("B4").click(); await page.keyboard.press("Control+Shift+V");
  const ps = dlg.getByTestId("paste-special"); await ps.waitFor();
  const before = await txt("B4"); const weight = () => cell("B4").evaluate((el) => getComputedStyle(el).fontWeight);
  const w0 = await weight();
  ok(await dlg.getByTestId("sheet-grid").evaluate((el) => el.contains(document.activeElement)), "the grid keeps the keyboard (non-modal bar, as TT60 designed)");
  await page.keyboard.type("zz");
  for (const k of ["Delete", "Backspace", "F2", "Enter", "Control+x", "Control+v", "Control+z", "Control+d", "Control+b"]) await page.keyboard.press(k);
  await page.waitForTimeout(300);
  ok(await ps.isVisible(), "bar still open after the editing keys");
  eq(await txt("B4"), before, "B4 unchanged by editing keys sent while Paste Special is open");
  eq(await weight(), w0, "Ctrl+B did not bold B4 behind the bar");
  ok(/(^|!)B4$/.test(await nameBox()), `Name box shows the paste target B4 (${await nameBox()})`);
  await page.keyboard.press("ArrowRight");
  await poll(async () => /(^|!)C4$/.test(await nameBox()), "ArrowRight moved the paste target to C4");
  ok(await ps.isVisible(), "bar still open after moving the target");
  await page.keyboard.press("ArrowLeft");
  // keys typed inside the bar's own controls stay there
  await ps.locator("input").first().focus();
  await page.keyboard.type("q"); await page.keyboard.press("Delete"); await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  eq(await txt("B4"), before, "B4 unchanged by keys typed into the bar");
  ok(await ps.isVisible(), "bar still open");
  await page.keyboard.press("Escape");
  await poll(async () => (await ps.count()) === 0, "Escape closed Paste Special");
  ok(await dlg.isVisible(), "Spreadsheet still open");
  eq(await txt("B4"), before, "B4 unchanged after Escape");
  await page.context().close();
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: src });
});

eq(errors, [], "page errors");
await browser.close();
finish();
