/**
 * TT58 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-22 Writer footnotes / endnotes: Ctrl+Alt+F inserts a footnote at the cursor and focuses its text box in the
 *         Notes panel → type → the page shows the numbered note → Ctrl+S → lxml oracle reads footnotes.xml with the
 *         reference, separators and FootnoteText style → reload the file → the note text is back → Insert endnote
 *         (roman numeral) → Delete the footnote → saved file: endnote only, no orphan, no dangling reference
 *   FF-21 Spreadsheet PivotTable: Data > PivotTable from the current region → Rows / Columns / Values / Sum →
 *         Create → new sheet "Pivot1" with Excel's tabular layout and grand totals → edit the source → Alt+F5 refresh
 *         → numbers follow; Escape closes only the panel (modal-shortcut failure test); a bad source is refused;
 *         Save → openpyxl reads the pivot sheet's values from the saved .xlsx → reopen → Refresh still works
 * Ground truth: saved bytes read by lxml / python-docx / openpyxl, plus a pandas recomputation of the pivot.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt58.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";
import { blankWord, writeWord, allParas } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t58${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e58-"));
const { test, finish } = makeHarness("e2e-tt58");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
const title = (m: string) => MODULES.find((x) => x.id === m)!.title;
// a non-overlapping grid so every title bar is clickable
const win = (id: string, module: string, i: number, workspace = 1, t?: string) => ({ id, module, title: t ?? title(module), x: 20 + (i % 3) * 320, y: 30 + Math.floor(i / 3) * 260, w: 300, h: 220, z: 11 + i, minimized: false, maximized: false, workspace, host: "tab", props: {} });
async function putDesktop(windows: unknown[], extra: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Second" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, ...extra } });
}

const server = async (): Promise<any> => (await api("GET", "/api/state?id=default")).json.row?.state ?? {};
/** CSS <time> → ms (".16s", "160ms", "0s") */
const ms = (t: string) => { const v = t.trim(); return v.endsWith("ms") ? parseFloat(v) : Math.round(parseFloat(v) * 1000); };
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(opts: { dsf?: number; reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: opts.dsf ?? 1, reducedMotion: opts.reducedMotion, colorScheme: opts.colorScheme });
  ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("launcher-button").waitFor({ timeout: 30_000 });
  return page;
}

const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };
const oracle = (script: string, buf: Uint8Array, ext: string, ...args: string[]) => { const f = join(tmp, `o${Date.now()}${Math.random().toString(36).slice(2)}.${ext}`); writeFileSync(f, buf); return JSON.parse(execFileSync(PY, [script, f, ...args], { encoding: "utf8" })); };

await test("FF-22 Writer notes in the UI: Ctrl+Alt+F footnote → type in the Notes panel → numbered note on the page → saved footnotes.xml (lxml oracle) → reopen keeps it → endnote (roman) → delete footnote → no orphan, no dangling reference", { "FF-22": "full" }, async () => {
  const d = await blankWord("t"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Rome was not built in a day.");
  const path = `/Documents/${RUN}-notes.docx`;
  const up = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(await writeWord(d)).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  ok(up.status === 200, "upload");
  let page: Page | null = null;
  const open = async () => {
    // a fresh browser context each time so the reopened document comes only from the saved bytes
    if (page) await page.context().close();
    await putDesktop([]); page = await newPage();
    await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
    const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 25_000 });
    const body = dlg.getByTestId("writer-body"); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
    return { dlg, body };
  };
  let { dlg, body } = await open();
  const para = body.locator("p[data-pid]").first();
  // cursor after "day" (before the full stop)
  await para.click(); await page.keyboard.press("End"); await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+Alt+f");
  const notes = dlg.getByTestId("writer-notes");
  await notes.waitFor();
  const fn1 = notes.getByLabel("Footnote 1 text");
  await poll(async () => await fn1.evaluate((e) => e === document.activeElement), "the new footnote's text box has focus");
  await page.keyboard.type("Attributed to a 12th-century proverb.");
  await page.keyboard.press("Control+Enter");
  await dlg.getByTestId("writer-status").filter({ hasText: "Footnote updated" }).waitFor();
  await poll(async () => (await body.locator(".wnotes .wnote").count()) === 1, "the note is shown on the page");
  ok(((await body.locator(".wnotes").innerText())).includes("Attributed to a 12th-century proverb."), "note text on the page");
  await page.screenshot({ path: "docs/screens/tt58-writer-notes.png" });
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  let o = oracle("scripts/oracle/docx_notes.py", await read(path), "docx");
  eq(o.refs.map((r: string[]) => r[0]), ["footnote"], "one footnote reference in document.xml");
  const id = o.refs[0][1];
  eq(o.notes.footnote[id], "Attributed to a 12th-century proverb.", "footnotes.xml holds the typed text");
  ok(o.ref_mark.footnote[id] && o.opens && o.parts_ok && o.ids_unique, `well-formed package: ${JSON.stringify(o)}`);
  eq(o.separators.footnote.sort(), ["continuationSeparator", "separator"], "Word's separator notes created");
  eq(o.styles.footnote[id], ["FootnoteText"], "FootnoteText paragraph style");
  eq([o.dangling, o.orphans], [[], []], "no dangling reference, no orphan note");
  // reopen: the note comes back from the saved file
  ({ dlg, body } = await open());
  await poll(async () => (await body.locator(".wnotes").innerText().catch(() => "")).includes("12th-century"), "note shown after reopening");
  await dlg.getByRole("button", { name: "Notes", exact: true }).click();
  eq(await dlg.getByTestId("writer-notes").getByLabel("Footnote 1 text").inputValue(), "Attributed to a 12th-century proverb.", "note text in the panel after reopening");
  // endnote at the start of the paragraph via the panel button; delete the footnote
  await body.locator("p[data-pid]").first().click(); await page.keyboard.press("Home");
  await dlg.getByRole("button", { name: "Insert endnote" }).click();
  const en = dlg.getByTestId("writer-notes").getByLabel("Endnote i text");
  await poll(async () => await en.evaluate((e) => e === document.activeElement), "endnote text box focused");
  await page.keyboard.type("See the sources list."); await page.keyboard.press("Control+Enter");
  await dlg.getByRole("button", { name: "Delete Footnote 1" }).click();
  await dlg.getByTestId("writer-status").filter({ hasText: "Footnote deleted" }).waitFor();
  await poll(async () => (await dlg.getByTestId("writer-notes").locator("[role=listitem]").count()) === 1, "one note left in the panel");
  // Escape inside the panel textarea must not close Writer (modal-shortcut failure test)
  await en.focus(); await page.keyboard.press("Escape"); ok(await dlg.isVisible(), "Writer still open after Escape in a note");
  await body.locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+s");
  await poll(async () => { o = oracle("scripts/oracle/docx_notes.py", await read(path), "docx"); return o.refs.length === 1 && o.refs[0][0] === "endnote"; }, "saved: endnote only");
  eq(Object.values(o.notes.endnote), ["See the sources list."], "endnotes.xml text");
  eq([Object.keys(o.notes.footnote).length, o.dangling, o.orphans], [0, [], []], "the deleted footnote is gone from footnotes.xml; no dangling / orphan");
  await page!.context().close();
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path });
});

await test("FF-21 Spreadsheet PivotTable in the UI: Data > PivotTable → Rows Region, Columns Product, Sum of Units → new sheet with Excel's tabular layout; Alt+F5 refresh follows a source edit; bad source refused; Escape closes only the panel; openpyxl reads the saved pivot values", { "FF-21": "full" }, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  const rows: (string | number)[][] = [["Region", "Product", "Units"], ["East", "Pens", 10], ["West", "Pens", 4], ["East", "Ink", 2], ["West", "Paper", 20], ["East", "Pens", 6], ["West", "Ink", 3]];
  rows.forEach((r, i) => r.forEach((v, j) => sh.setCell(j, i, String(v)))); wb.recalculate();
  const orig = writeXlsxWorkbook(wb);
  const src = `/Documents/${RUN}-pivot.xlsx`;
  const up = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(orig).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(up.status < 300, `upload ${up.status}`);
  await putDesktop([]);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const panel = dlg.getByTestId("pivot-panel");
  await cell("B3").click();
  await dlg.getByRole("button", { name: /^Insert a PivotTable/ }).click(); await panel.waitFor();
  eq(await panel.getByLabel("PivotTable source", { exact: true }).inputValue(), "Sheet1!A1:C7", "source = the current region");
  eq(await panel.getByLabel("Rows field", { exact: true }).inputValue(), "0", "default Rows = first text field");
  eq(await panel.getByLabel("Values field", { exact: true }).inputValue(), "2", "default Values = first numeric field");
  await panel.getByLabel("Columns field", { exact: true }).selectOption({ label: "Product" });
  eq(await panel.getByLabel("Summarize values by", { exact: true }).inputValue(), "sum", "Sum by default");
  // Escape closes only the panel
  await panel.getByLabel("Rows field", { exact: true }).focus(); await page.keyboard.press("Escape");
  await poll(async () => (await panel.count()) === 0, "Escape closed the panel"); ok(await dlg.isVisible(), "Spreadsheet still open");
  // bad source refused (no sheet created)
  await dlg.getByRole("button", { name: /^Insert a PivotTable/ }).click(); await panel.waitFor();
  await panel.getByLabel("PivotTable source", { exact: true }).fill("Nope!A1:C7"); ok(await panel.getByRole("alert").isVisible(), "invalid source flagged");
  await panel.getByRole("button", { name: "Create" }).click();
  await poll(async () => /Enter the source/.test((await dlg.getByTestId("sheet-status").textContent()) ?? ""), "refused with a reason");
  ok(!(await dlg.getByRole("button", { name: "Pivot1", exact: true }).count()), "no sheet created by a refused pivot");
  await panel.getByLabel("PivotTable source", { exact: true }).fill("Sheet1!A1:C7");
  await panel.getByLabel("Columns field", { exact: true }).selectOption({ label: "Product" });
  await page.screenshot({ path: "docs/screens/tt58-pivot-panel.png" });
  await panel.getByRole("button", { name: "Create" }).click();
  await poll(async () => (await dlg.getByRole("button", { name: "Pivot1", exact: true }).count()) === 1, "Pivot1 sheet created");
  const grid = async (r0: number, r1: number, cols: string) => { const out: string[][] = []; for (let r = r0; r <= r1; r++) { const line: string[] = []; for (const c of cols) line.push((await cell(`${c}${r}`).innerText()).trim()); out.push(line); } return out; };
  await poll(async () => (await cell("A3").innerText()).trim() === "Sum of Units", "pivot written at A3");
  eq(await grid(3, 7, "ABCDE"), [["Sum of Units", "Product", "", "", ""], ["Region", "Ink", "Paper", "Pens", "Grand Total"], ["East", "2", "", "16", "18"], ["West", "3", "20", "4", "27"], ["Grand Total", "5", "20", "20", "45"]], "Excel tabular layout");
  ok(/PivotTable1 created on Pivot1 \(A3:E7\) from Sheet1!A1:C7/.test((await dlg.getByTestId("sheet-status").textContent()) ?? ""), "status names the pivot");
  ok(await cell("A7").evaluate((e) => Number(getComputedStyle(e).fontWeight) >= 600), "grand total row bold");
  await page.screenshot({ path: "docs/screens/tt58-pivot.png" });
  // edit the source, refresh with Alt+F5 on the pivot
  await dlg.getByRole("button", { name: "Sheet1", exact: true }).click();
  await cell("C2").click(); await page.keyboard.type("100"); await page.keyboard.press("Enter");
  await cell("A8").click(); await page.keyboard.type("North"); await page.keyboard.press("Tab"); await page.keyboard.type("Ink"); await page.keyboard.press("Tab"); await page.keyboard.type("1"); await page.keyboard.press("Enter");
  await dlg.getByRole("button", { name: "Pivot1", exact: true }).click();
  await cell("B5").click(); await page.keyboard.press("Alt+F5");
  await poll(async () => (await cell("E5").innerText()).trim() === "108", "East total follows the edit (Pens 100+6, Ink 2)");
  eq((await cell("A6").innerText()).trim(), "West", "source range did not grow, so North (row 8) is outside A1:C7");
  // widen the source via the panel (edit mode on the pivot) → North appears
  await dlg.getByRole("button", { name: /^Insert a PivotTable/ }).click(); await panel.waitFor();
  eq(await panel.getByLabel("PivotTable source", { exact: true }).inputValue(), "Sheet1!A1:C7", "edit mode loads the definition");
  await panel.getByLabel("PivotTable source", { exact: true }).fill("Sheet1!A1:C8");
  await panel.getByRole("button", { name: "Update" }).click();
  await poll(async () => (await cell("A6").innerText()).trim() === "North", "North row after widening the source");
  eq(await grid(8, 8, "ABCDE"), [["Grand Total", "6", "20", "110", "136"]], "grand totals after the edit");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = new Uint8Array();
  await poll(async () => { saved = Uint8Array.from(await read(src)); return Buffer.compare(Buffer.from(saved), orig) !== 0; }, "saved bytes changed");
  // reopen the saved .xlsx in a fresh context: the definition came back (hidden names) — Alt+F5 refreshes, the panel edits it
  await ctx.close();
  {
    await putDesktop([]);
    const c2 = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const p2 = await c2.newPage(); p2.on("pageerror", (e) => errors.push(e.message));
    await p2.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
    const d2 = p2.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await d2.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
    await d2.getByRole("button", { name: "Pivot1", exact: true }).click();
    await d2.locator('[data-cell="B5"]').click(); await p2.keyboard.press("Alt+F5");
    await poll(async () => /PivotTable1 refreshed/.test((await d2.getByTestId("sheet-status").textContent()) ?? ""), "refresh works after reopening the .xlsx");
    await d2.getByRole("button", { name: /^Insert a PivotTable/ }).click();
    eq(await d2.getByTestId("pivot-panel").getByLabel("PivotTable source", { exact: true }).inputValue(), "Sheet1!A1:C8", "definition reloaded from the file");
    await c2.close();
  }
  const f = join(tmp, "pivot.xlsx"); writeFileSync(f, saved);
  const vals = JSON.parse(execFileSync(PY, ["-c", "import json,sys,openpyxl\nwb=openpyxl.load_workbook(sys.argv[1])\nws=wb['Pivot1']\nprint(json.dumps([[c for c in r] for r in ws.iter_rows(min_row=3,max_row=8,max_col=5,values_only=True)]))", f], { encoding: "utf8" }));
  eq(vals, [["Sum of Units", "Product", null, null, null], ["Region", "Ink", "Paper", "Pens", "Grand Total"], ["East", 2, null, 106, 108], ["North", 1, null, null, 1], ["West", 3, 20, 4, 27], ["Grand Total", 6, 20, 110, 136]], "openpyxl reads the pivot values");
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: src });
});

await test("no uncaught page errors during the TT58 session", { "FF-21": "full" }, () => { eq(errors, [], "page errors"); });

await browser.close();
{
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) if (n.path.startsWith(`/Documents/${RUN}-`)) for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
}
await putDesktop([]);
await finish();
process.exit(0);
