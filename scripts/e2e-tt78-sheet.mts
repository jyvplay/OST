/**
 * TT78 real-browser suite (Playwright + headless Chromium 143 against the production server): outlines and table
 * calculated columns, by real clicks and typing. Saved packages are read back by openpyxl (scripts/oracle/xlsx_outline.py).
 *  1. Subtotal dialog → subtotal rows + 1-2-3 outline; level 2 shows only totals; the gutter +/− expands one group;
 *     Save → openpyxl sees outline levels, the hidden detail rows, the collapsed flag and =SUBTOTAL formulas
 *  2. modal shortcut: Alt+Shift+→ on a cell range opens the Rows/Columns question; while it is open a second
 *     Alt+Shift+→ groups nothing and opens nothing; Escape groups nothing; answering "rows" groups; Alt+Shift+← ungroups
 *  3. calculated column: typing =A2*B2 in a table column fills it; typing below the table grows it and fills the new
 *     row; ONE Ctrl+Z undoes the growth and the fill; Save → openpyxl sees calculatedColumnFormula and the table ref
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt78-sheet.mts
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

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t78s${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt78-sheet");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e78s-"));
const OUT = { "FF-19": "full", "FF-64": "full" } as const;
const CALC = { "FF-19": "full", "FF-65": "full" } as const;
const XMIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const upload = async (path: string, bytes: Uint8Array) => { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: XMIME }); ok(r.status < 300, `upload ${path} ${r.status}`); };
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };
const oracle = (bytes: Buffer, name: string) => { const f = join(tmp, name); writeFileSync(f, bytes); const o = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_outline.py", f], { encoding: "utf8" }))[f]; ok(o && !o.error, `openpyxl ${JSON.stringify(o)}`); return o; };
const formulasOf = (bytes: Buffer, name: string) => { const f = join(tmp, name); writeFileSync(f, bytes); return JSON.parse(execFileSync(PY, ["-c", "import openpyxl,sys,json; ws=openpyxl.load_workbook(sys.argv[1]).active; print(json.dumps({c.coordinate: c.value for r in ws.iter_rows() for c in r if c.value is not None}))", f], { encoding: "utf8" })) as Record<string, string | number>; };

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
const ask = (page: Page) => page.getByTestId("ask-dialog");

/* ------------------------------------------------------------------ 1 Subtotal + outline */
const DATA: [string, number][] = [["East", 10], ["East", 20], ["East", 5], ["North", 7], ["North", 8], ["West", 1], ["West", 2]];
await test("Subtotal dialog → totals + 1-2-3 outline; level 2 shows only totals; +/− expands one group; Save → openpyxl sees levels / hidden / collapsed / SUBTOTAL", OUT, async () => {
  const wb = new Workbook(); const s = wb.sheet("Sheet1"); s.setCell(0, 0, "Region"); s.setCell(1, 0, "Sales");
  DATA.forEach(([r, v], i) => { s.setCell(0, i + 1, r); s.setCell(1, i + 1, String(v)); }); wb.recalculate();
  const src = `/Documents/${RUN}-sub.xlsx`; await upload(src, writeXlsxWorkbook(wb));
  const { page, dlg } = await open(src); const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  await poll(async () => (await cell("A8").innerText()).trim() === "West", "grid rendered", 20_000);
  await cell("A2").click();
  await dlg.getByTestId("sheet-subtotal").click(); await ask(page).waitFor();
  eq(await page.getByTestId("ask-input-by").inputValue(), "Region", "dialog default: at each change in Region");
  eq(await page.getByTestId("ask-input-cols").inputValue(), "Sales", "dialog default: add subtotal to Sales");
  await page.getByTestId("ask-ok").click();
  await poll(async () => (await cell("A5").innerText()).trim() === "East Total", "East Total row");
  ok((await cell("B5").innerText()).trim() === "35", `East total ${await cell("B5").innerText()}`);
  eq((await cell("A12").innerText()).trim(), "Grand Total", "grand total row");
  eq((await cell("B12").innerText()).trim(), "53", "grand total value (nested SUBTOTALs ignored)");
  for (const n of [1, 2, 3]) ok(await dlg.getByTestId(`outline-row-level-${n}`).count(), `level button ${n}`);
  await dlg.getByTestId("outline-row-level-2").click();
  await poll(async () => (await cell("A2").count()) === 0 && (await cell("A5").count()) === 1, "level 2 hides detail");
  const visible: string[] = []; for (let r = 2; r <= 12; r++) if (await cell(`A${r}`).count()) visible.push((await cell(`A${r}`).innerText()).trim());
  eq(visible, ["East Total", "North Total", "West Total", "Grand Total"], "level 2 rows");
  // expand only North (summary row 8 = index 7) with its gutter button
  const btn = dlg.getByTestId("outline-row-2-7"); ok(await btn.count(), "North +/- button"); eq(await btn.getAttribute("aria-expanded"), "false", "North collapsed");
  await btn.click(); await poll(async () => (await cell("A6").count()) === 1 && (await cell("A2").count()) === 0, "North expanded alone");
  await page.screenshot({ path: "docs/screens/tt78-sheet-outline.png" });
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = Buffer.alloc(0); await poll(async () => { saved = await read(src); return saved.length > 0 && Buffer.compare(saved, Buffer.from(writeXlsxWorkbook(wb))) !== 0; }, "saved");
  await poll(async () => { saved = await read(src); const o = oracle(saved, "sub.xlsx"); return Object.keys(o.sheets.Sheet1.rows).length >= 10; }, "saved outline");
  const o = oracle(saved, "sub.xlsx"); const rows = o.sheets.Sheet1.rows as Record<string, [number, boolean, boolean]>;
  eq([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => rows[r]?.[0] ?? 0), [2, 2, 2, 1, 2, 2, 1, 2, 2, 1], "openpyxl outline levels");
  eq([1, 2, 3, 5, 6, 8, 9].map((r) => !!rows[r]?.[1]), [true, true, true, false, false, true, true], "openpyxl hidden detail (North shown)");
  ok(rows[4]?.[2] && !rows[7]?.[2] && rows[10]?.[2], `openpyxl collapsed flags ${JSON.stringify(rows)}`);
  const f = formulasOf(saved, "subf.xlsx"); eq(f.B5, "=SUBTOTAL(9,B2:B4)", "openpyxl East formula"); eq(f.B12, "=SUBTOTAL(9,B2:B11)", "openpyxl grand formula");
  await page.context().close();
});

/* ------------------------------------------------------------------ 2 group shortcut + modal */
await test("modal shortcut: Alt+Shift+→ asks Rows/Columns; a second Alt+Shift+→ while asked does nothing; Escape groups nothing; 'rows' groups; Alt+Shift+← ungroups", OUT, async () => {
  const wb = new Workbook(); const s = wb.sheet("Sheet1"); for (let r = 0; r < 8; r++) s.setCell(0, r, String(r + 1)); wb.recalculate();
  const src = `/Documents/${RUN}-grp.xlsx`; await upload(src, writeXlsxWorkbook(wb));
  const { page, dlg } = await open(src); const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  await poll(async () => (await cell("A8").innerText()).trim() === "8", "grid", 20_000);
  await cell("A3").click(); await cell("A5").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Alt+Shift+ArrowRight"); await ask(page).waitFor();
  await page.keyboard.press("Alt+Shift+ArrowRight"); await page.waitForTimeout(300);
  eq(await page.getByTestId("ask-dialog").count(), 1, "still exactly one question");
  eq(await dlg.getByTestId("outline-row-level-1").count(), 0, "nothing grouped while asked");
  await page.keyboard.press("Escape"); await poll(async () => (await page.getByTestId("ask-dialog").count()) === 0, "question closed");
  await page.waitForTimeout(200); eq(await dlg.getByTestId("outline-row-level-1").count(), 0, "Escape groups nothing");
  await cell("A4").click(); await cell("A3").click(); await cell("A5").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Alt+Shift+ArrowRight"); await ask(page).waitFor();
  await page.getByTestId("ask-input-axis").fill("rows"); await page.keyboard.press("Enter");
  await poll(async () => (await dlg.getByTestId("outline-row-level-2").count()) === 1, "grouped (level buttons 1, 2)");
  ok(await dlg.getByTestId("outline-row-1-5").count(), "summary button on row 6");
  await dlg.getByTestId("outline-row-1-5").click(); await poll(async () => (await cell("A3").count()) === 0 && (await cell("A6").count()) === 1, "collapsed rows 3-5");
  await dlg.getByTestId("outline-row-1-5").click(); await poll(async () => (await cell("A3").count()) === 1, "expanded");
  await cell("A3").click(); await cell("A5").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Alt+Shift+ArrowLeft"); await ask(page).waitFor(); await page.getByTestId("ask-input-axis").fill("rows"); await page.keyboard.press("Enter");
  await poll(async () => (await dlg.getByTestId("outline-row-level-1").count()) === 0, "ungrouped");
  await page.context().close();
});

/* ------------------------------------------------------------------ 3 calculated column */
await test("calculated column: =A2*B2 fills the column; typing below grows the table and fills; one Ctrl+Z undoes both; Save → openpyxl calculatedColumnFormula + ref", CALC, async () => {
  const wb = new Workbook(); const s = wb.sheet("Sheet1"); ["Price", "Qty", "Total"].forEach((h, c) => s.setCell(c, 0, h));
  [[2, 3], [4, 5], [6, 7]].forEach(([p, q], i) => { s.setCell(0, i + 1, String(p)); s.setCell(1, i + 1, String(q)); });
  wb.tables.set("SALES", { name: "Sales", sheet: "Sheet1", c0: 0, r0: 0, c1: 2, r1: 3, headerRows: 1, totalsRows: 0, columns: ["Price", "Qty", "Total"] }); wb.recalculate();
  const bytes = writeXlsxWorkbook(wb); const src = `/Documents/${RUN}-calc.xlsx`; await upload(src, bytes);
  const { page, dlg } = await open(src); const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  await poll(async () => (await cell("B4").innerText()).trim() === "7", "grid", 20_000);
  await cell("C3").click(); await page.keyboard.type("=A3*B3"); await page.keyboard.press("Enter");
  await poll(async () => (await cell("C2").innerText()).trim() === "6" && (await cell("C4").innerText()).trim() === "42", "column filled");
  await cell("A5").click(); await page.keyboard.type("10"); await page.keyboard.press("Enter");
  await poll(async () => (await cell("C5").innerText()).trim() === "0", "new row filled (B5 empty → 0)");
  await cell("B5").click(); await page.keyboard.type("2"); await page.keyboard.press("Enter");
  await poll(async () => (await cell("C5").innerText()).trim() === "20", "new row computes");
  await page.keyboard.press("Control+z"); await poll(async () => (await cell("B5").innerText()).trim() === "", "undo B5");
  await page.keyboard.press("Control+z"); await poll(async () => (await cell("A5").innerText()).trim() === "" && (await cell("C5").innerText()).trim() === "", "ONE undo removes the growth and the fill");
  eq((await cell("C4").innerText()).trim(), "42", "fill before the growth kept");
  await page.screenshot({ path: "docs/screens/tt78-sheet-calc.png" });
  await page.keyboard.press("Control+y"); await poll(async () => (await cell("C5").innerText()).trim() === "0", "redo restores growth + fill");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = Buffer.alloc(0); await poll(async () => { saved = await read(src); return Buffer.compare(saved, Buffer.from(bytes)) !== 0; }, "saved");
  const o = oracle(saved, "calc.xlsx"); const t = o.sheets.Sheet1.tables[0];
  eq(t.ref, "A1:C5", "openpyxl table ref grew"); eq(t.cols[2].calc, "A2*B2", "openpyxl calculatedColumnFormula");
  const f = formulasOf(saved, "calcf.xlsx"); eq([f.C2, f.C3, f.C4, f.C5], ["=A2*B2", "=A3*B3", "=A4*B4", "=A5*B5"], "openpyxl cell formulas");
  await page.context().close();
});

await browser.close();
// hygiene: remove everything this run wrote under /Documents (files and folders named with this run's prefix) so the
// next suites (the tabletop draws every Documents file as a card) see the same desk every time
{
  const l = await fetch(`${BASE}/api/fs?op=list&path=%2FDocuments`).then((r) => r.json()).catch(() => ({})) as { nodes?: { name: string; path: string }[] };
  for (const n of l.nodes ?? []) if (n.name.startsWith(RUN)) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
}
if (errors.length) console.log("page errors:", errors.slice(0, 5));
finish();
