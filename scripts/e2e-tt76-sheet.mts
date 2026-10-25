/**
 * TT76 real-browser suite (Playwright + headless Chromium 143 against the production server): the AutoFilter
 * Condition dialog. Real clicks / typing; the saved package is read back by openpyxl (scripts/oracle/xlsx_filters.py).
 *  1. modal shortcut: an untouched Condition dialog has OK disabled and Enter applies nothing (no row hidden)
 *  2. Top N → only the N largest rows render; reopening pre-fills the dialog; Below average; Clear shows every row
 *  3. Custom: "contains e" Or "begins with z" on a text column (Excel's wildcard encoding), And across columns
 *  4. Date period (This year, relative to the browser's today) on a date column
 *  5. By colour: the column's fills are offered as swatches; picking one shows only those rows; Save → openpyxl sees a
 *     colorFilter whose dxf resolves to that colour and exactly the rows the UI hid; reopening the saved file in a new
 *     page shows the same rows and the dialog pre-filled with the colour
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt76-sheet.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { dateToSerial } from "../src/lib/formula/dates.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t76s${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt76-sheet");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e76s-"));
const COV = { "FF-19": "full", "FF-62": "full" } as const;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const upload = async (path: string, bytes: Uint8Array, mime: string) => { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(r.status < 300, `upload ${path} ${r.status}`); };
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function open(path: string): Promise<{ page: Page; dlg: Locator }> {
  await putDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator(`[role=dialog][aria-label="Spreadsheet"]`).last(); await dlg.waitFor({ state: "visible", timeout: 25_000 });
  return { page, dlg };
}

/* workbook: A = n (1,3,5,7,9,2,4,6,8; rows 2,4,6,8 filled orange), B = name, C = date (this year / last year alternating) */
const N = [1, 3, 5, 7, 9, 2, 4, 6, 8];
const NAMES = ["bea", "zed", "al", "dee", "cy", "eve", "zoe", "bo", "kim"];
const Y = new Date().getFullYear();
const wb = new Workbook(); const sh = wb.sheet("Sheet1");
sh.setCell(0, 0, "n"); sh.setCell(1, 0, "name"); sh.setCell(2, 0, "when");
N.forEach((v, i) => {
  sh.setCell(0, i + 1, String(v)); sh.setCell(1, i + 1, NAMES[i]);
  sh.setCell(2, i + 1, String(dateToSerial(i % 2 ? Y - 1 : Y, 1 + (i % 6), 3))); sh.setStyle(2, i + 1, { numFmt: "yyyy-mm-dd" });
  if (i % 2 === 0) sh.setStyle(0, i + 1, { fill: "#FFC000" });
});
wb.recalculate();
const xbytes = writeXlsxWorkbook(wb); const xsrc = `/Documents/${RUN}-cond.xlsx`;
const XMIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let page: Page; let dlg: Locator;
const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
/** data rows (2..10) currently rendered, as their column-A values */
const shown = async () => { const out: number[] = []; for (let r = 2; r <= 10; r++) if (await cell(`A${r}`).count()) out.push(Number((await cell(`A${r}`).innerText()).trim())); return out; };
const panel = () => dlg.getByTestId("filter-panel");
const openCond = async (col: string) => { await dlg.getByTestId(`filter-btn-${col}`).click(); await panel().waitFor(); await panel().getByTestId("filter-tab-cond").click(); await panel().getByTestId("filter-cond").waitFor(); };
const status = async () => (await dlg.locator("[role=status], .fs-status").first().innerText().catch(() => "")).trim();

await test("modal shortcut: an untouched Condition dialog has OK disabled; Enter (in the empty value box) applies nothing; Escape closes it", COV, async () => {
  await upload(xsrc, xbytes, XMIME);
  ({ page, dlg } = await open(xsrc));
  await poll(async () => (await cell("A10").count()) === 1, "grid rendered", 20_000);
  await cell("A2").click(); await dlg.getByTestId("sheet-filter").click();
  await dlg.getByTestId("filter-btn-A").waitFor();
  await openCond("A");
  ok(await panel().getByTestId("filter-ok").isDisabled(), "OK must be disabled until the rule has a value");
  await panel().getByTestId("filter-v1").click(); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  ok(await panel().isVisible(), "Enter on an incomplete dialog must not close it");
  eq(await shown(), N, "no row hidden by Enter on an empty dialog");
  await page.keyboard.press("Escape"); await poll(async () => !(await panel().isVisible()), "Escape closes");
  eq(await dlg.getByTestId("filter-btn-A").getAttribute("aria-pressed"), "false", "nothing applied");
});

await test("Top 2 shows only the two largest; reopening pre-fills Top 2; Below average; Clear shows every row", COV, async () => {
  await openCond("A");
  await panel().getByTestId("filter-mode").selectOption("top10"); await panel().getByTestId("filter-n").fill("2");
  await panel().getByTestId("filter-ok").click();
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify([9, 8]), "top 2 = 9, 8");
  eq(await dlg.getByTestId("filter-btn-A").getAttribute("aria-pressed"), "true", "button shows an active filter");
  // reopen: Condition tab first, pre-filled
  await dlg.getByTestId("filter-btn-A").click(); await panel().waitFor();
  eq(await panel().getByTestId("filter-tab-cond").getAttribute("aria-selected"), "true", "reopens on the Condition tab");
  eq(await panel().getByTestId("filter-mode").inputValue(), "top10", "mode pre-filled"); eq(await panel().getByTestId("filter-n").inputValue(), "2", "N pre-filled");
  await panel().getByTestId("filter-mode").selectOption("average"); await panel().getByTestId("filter-below").check();
  await panel().getByTestId("filter-ok").click();
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify([1, 3, 2, 4]), "below average (5) = 1,3,2,4");
  await openCond("A"); await panel().getByTestId("filter-clear").click();
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify(N), "Clear shows every row");
  eq(await dlg.getByTestId("filter-btn-A").getAttribute("aria-pressed"), "false", "cleared");
});

await test("Custom: contains \"e\" Or begins with \"z\" (wildcards) on the name column; And with a second column's Top 5", COV, async () => {
  await openCond("B");
  await panel().getByTestId("filter-op1").selectOption("ct"); await panel().getByTestId("filter-v1").fill("e");
  await panel().getByTestId("filter-or").check();
  await panel().getByTestId("filter-op2").selectOption("bw"); await panel().getByTestId("filter-v2").fill("z");
  await page.screenshot({ path: "docs/screens/tt76-sheet-filter-dialog.png", clip: { x: 0, y: 0, width: 1200, height: 760 } });
  await panel().getByTestId("filter-ok").click();
  // names with e or starting z: bea(1) zed(3) dee(7) eve(2) zoe(4)
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify([1, 3, 7, 2, 4]), "contains e or begins with z");
  await openCond("A"); await panel().getByTestId("filter-mode").selectOption("top10"); await panel().getByTestId("filter-n").fill("5"); await panel().getByTestId("filter-ok").click();
  // top 5 of A = 9,8,7,6,5 → intersect: 7 only
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify([7]), "both columns apply (And)");
  for (const c of ["A", "B"]) { await openCond(c); await panel().getByTestId("filter-clear").click(); }
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify(N), "both cleared");
});

await test("Date period: This year on the date column (relative to today)", COV, async () => {
  await openCond("C"); await panel().getByTestId("filter-mode").selectOption("date"); await panel().getByTestId("filter-date").selectOption("thisYear");
  await panel().getByTestId("filter-ok").click();
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify(N.filter((_, i) => i % 2 === 0)), "this year's rows");
  await openCond("C"); await panel().getByTestId("filter-clear").click();
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify(N), "cleared");
});

await test("By colour: swatches come from the column; orange shows only the filled rows; Save → openpyxl sees the colour filter + the same hidden rows; reopening the file keeps them and pre-fills the colour", COV, async () => {
  await openCond("A"); await panel().getByTestId("filter-mode").selectOption("color");
  const sw = panel().locator('[data-testid^="filter-colour-"]');
  eq(await sw.evaluateAll((ls) => ls.map((l) => l.getAttribute("aria-label"))), ["#FFC000", "No fill"], "swatches = the column's fills + No fill");
  ok(await panel().getByTestId("filter-ok").isDisabled(), "OK disabled until a colour is picked");
  await panel().getByTestId("filter-colour-FFC000").click(); await panel().getByTestId("filter-ok").click();
  const want = N.filter((_, i) => i % 2 === 0);
  await poll(async () => JSON.stringify(await shown()) === JSON.stringify(want), "only the orange rows");
  await page.screenshot({ path: "docs/screens/tt76-sheet-filter-colour.png" });
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = Buffer.alloc(0);
  await poll(async () => { saved = await read(xsrc); return Buffer.compare(saved, Buffer.from(xbytes)) !== 0; }, "saved bytes changed");
  const f = join(tmp, "saved.xlsx"); writeFileSync(f, saved);
  const o = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_filters.py", f], { encoding: "utf8" }))[f];
  ok(o && !o.error, `openpyxl: ${JSON.stringify(o)}`);
  const s1 = o.sheets.Sheet1; const c0 = s1.autoFilter?.columns?.find((c: { colId: number }) => c.colId === 0);
  ok(c0?.color?.rgb === "#FFC000" && c0.color.cell === true, `openpyxl colour filter ${JSON.stringify(s1.autoFilter)}`);
  eq(s1.hidden, [2, 4, 6, 8], "openpyxl hidden rows (0-based) = the rows the UI hid");
  // a fresh page on the saved file
  const again = await open(xsrc); const p2 = again.page; const d2 = again.dlg;
  const cell2 = (r: string) => d2.locator(`[data-cell="${r}"]`);
  await poll(async () => (await cell2("A2").count()) === 1 && (await cell2("A3").count()) === 0, "saved filter applied on reopen", 20_000);
  eq(await d2.getByTestId("filter-btn-A").getAttribute("aria-pressed"), "true", "reopened column shows its filter");
  await d2.getByTestId("filter-btn-A").click(); const pn = d2.getByTestId("filter-panel"); await pn.waitFor();
  eq(await pn.getByTestId("filter-mode").inputValue(), "color", "reopened dialog: By colour");
  eq(await pn.getByTestId("filter-colour-FFC000").getAttribute("aria-pressed"), "true", "reopened dialog: orange picked");
  await p2.context().close();
});

await test("no page errors", { "FF-19": "full" }, async () => { eq(errors, [], "page errors"); });
await browser.close();
finish();
void status;
