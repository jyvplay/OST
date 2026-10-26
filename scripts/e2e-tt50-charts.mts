/**
 * TT50 e2e — Spreadsheet charts in the real UI (Chromium 143 headless):
 *  - a corpus workbook with three Excel charts on two sheets opens with every chart drawn, positioned and titled
 *    as in the file;
 *  - edit title / stacking / axis title of an imported chart and insert a new chart → Save (lossless patch) →
 *    openpyxl (independent reader) sees exactly those edits, the untouched chart unchanged and no cell changed;
 *  - a chart made in the UI with a linear trendline + equation + R² draws them and saves a real c:trendline;
 *  - modal-shortcut failure test: while a chart input has focus, Delete / Backspace / typing / Ctrl+Z never touch
 *    the selected grid cell.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt50-charts.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { Workbook } from "../src/lib/formula/engine.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `x${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt50-charts");
const COV = { "FF-29": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", XCORPUS = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "e2e50-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, "base64")); }
async function purge() {
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) if (n.path.includes(`/${RUN}-`)) for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
}
type OChart = { sheet: string; type: string; grouping: string | null; title: string | null; x_axis: string | null; y_axis: string | null; series: { val: string | null; trend: string | null }[]; anchor: [number, number] | null };
const oracle = (p: string) => JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_charts.py", p], { encoding: "utf8" }).trim()) as { error?: string; charts?: OChart[] };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openSheetFile(path: string) {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
  await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (ref: string) => dlg.locator(`[data-cell="${ref}"]`);
  const tab = async (name: string) => { await dlg.locator('button[title="Double-click to rename"]').filter({ hasText: new RegExp(`^${name}$`) }).click(); };
  const charts = async () => { const p = dlg.locator('[data-testid="charts-panel"]'); if (!(await p.count())) await dlg.getByRole("button", { name: /Show charts/ }).click(); await p.waitFor({ timeout: 5000 }); return p; };
  const save = async () => { await dlg.getByRole("button", { name: "Save workbook" }).click(); await dlg.locator('[data-testid="sheet-status"]').filter({ hasText: "lossless" }).waitFor({ timeout: 15_000 }); };
  return { page, dlg, cell, tab, charts, save, close: () => ctx.close() };
}
const imgSvg = async (img: import("playwright").Locator) => decodeURIComponent((await img.getAttribute("src"))!.replace(/^data:image\/svg\+xml[^,]*,/, ""));

await test("imported Excel charts are drawn where and as the file says: WithThreeCharts.xlsx — line + pie on Sheet2, area on Sheet3, titles, anchors, legends", COV, async () => {
  const src = `/Documents/${RUN}-three.xlsx`; await upload(src, readFileSync(join(XCORPUS, "WithThreeCharts.xlsx")));
  const s = await openSheetFile(src);
  await s.tab("Sheet2"); const panel = await s.charts();
  const cards = panel.locator("[data-chart]"); eq(await cards.count(), 2, "Sheet2 chart cards");
  eq(await cards.locator('input[aria-label="Chart title"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), ["", "Pie Chart Title Thingy"], "titles");
  eq(await cards.locator('select[aria-label="Chart type"]').evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value)), ["line", "pie"], "types");
  eq(await panel.getByTestId("chart-anchor").allInnerTexts(), ["at A1:I16", "at A17:I31"], "anchors from the drawing part");
  const line = await imgSvg(cards.nth(0).locator("img"));
  ok((line.match(/<polyline points/g) ?? []).length >= 3 && /1st Column/.test(line), "line chart: two series polylines + legend with the file's series name");
  await s.page.screenshot({ path: join(SHOTS, "e2e50-import.png") });
  await s.tab("Sheet3"); eq(await (await s.charts()).locator("[data-chart]").count(), 1, "Sheet3 has the area chart");
  ok(/<polygon/.test(await imgSvg((await s.charts()).locator("[data-chart] img").first())), "area drawn as polygons");
  await s.close();
});

await test("edit an imported chart (title, stacked, value-axis title) and insert a new one → Save → openpyxl sees exactly those edits; the other charts and every cell unchanged", COV, async () => {
  const orig = readFileSync(join(XCORPUS, "WithThreeCharts.xlsx")); const src = `/Documents/${RUN}-edit.xlsx`; await upload(src, orig);
  const s = await openSheetFile(src);
  await s.tab("Sheet2"); const panel = await s.charts(); const first = panel.locator("[data-chart]").nth(0);
  await first.getByLabel("Chart title").fill("Sales TT50");
  await first.getByLabel("Stacking").selectOption("stacked");
  await first.getByLabel("Vertical axis title").fill("Units");
  ok(/data-axis-title="val">Units</.test(await imgSvg(first.locator("img"))), "value-axis title drawn at once");
  // a new chart from a selection on Sheet1
  await s.tab("Sheet1"); await s.cell("A1").click(); await s.cell("B6").click({ modifiers: ["Shift"] });
  await s.dlg.getByRole("button", { name: /Insert a chart from the selection/ }).click();
  const p1 = await s.charts(); eq(await p1.locator("[data-chart]").count(), 1, "new chart card");
  await p1.locator("[data-chart]").first().getByLabel("Chart title").fill("Fresh");
  await s.save(); await s.close();
  const saved = await readBytes(src); const a = join(tmp, "orig.xlsx"), b = join(tmp, "saved.xlsx"); writeFileSync(a, orig); writeFileSync(b, saved);
  const o0 = oracle(a), o1 = oracle(b); ok(!o1.error, `oracle: ${o1.error}`);
  const by = (o: typeof o1, sheet: string) => o.charts!.filter((c) => c.sheet === sheet);
  const e = by(o1, "Sheet2")[0];
  eq([e.title, e.grouping, e.y_axis], ["Sales TT50", "stacked", "Units"], "edited chart");
  eq(JSON.stringify(by(o1, "Sheet2")[1]), JSON.stringify(by(o0, "Sheet2")[1]), "pie untouched");
  eq(JSON.stringify(by(o1, "Sheet3")), JSON.stringify(by(o0, "Sheet3")), "Sheet3 chart untouched");
  const f = by(o1, "Sheet1"); eq(f.length, 1, "new chart on Sheet1"); eq(f[0].title, "Fresh", "new chart title"); ok(f[0].series.length >= 1 && /^Sheet1!\$[AB]\$/.test(f[0].series[0].val ?? ""), `new chart refs ${f[0].series[0]?.val}`);
  const pr = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_patch_probe.py"], { input: `${a}\t${b}\n`, encoding: "utf8" }).trim());
  ok(pr.ok, `openpyxl load: ${pr.error}`); eq(pr.diff, [], "no cell changed"); eq(pr.partsLost, [], "no part lost");
});

await test("a chart made in the UI with a linear trendline, equation and R² draws them and saves a real c:trendline (openpyxl)", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  [["Month", "Sales"], ["Jan", 3], ["Feb", 5], ["Mar", 7], ["Apr", 9], ["May", 11]].forEach((row, r) => row.forEach((v, c) => sh.setCell(c, r, String(v)))); wb.recalculate();
  const src = `/Documents/${RUN}-trend.xlsx`; await upload(src, writeXlsxWorkbook(wb));
  const s = await openSheetFile(src);
  await s.cell("A1").click(); await s.cell("B6").click({ modifiers: ["Shift"] });
  await s.dlg.getByRole("button", { name: /Insert a chart from the selection/ }).click();
  const card = (await s.charts()).locator("[data-chart]").first();
  await card.getByLabel("Chart type").selectOption("line");
  await card.getByLabel("Trendline").selectOption("linear");
  await card.getByText("equation").click(); await card.getByText("R²").click();
  const svg = await imgSvg(card.locator("img"));
  ok(/data-trend="linear"/.test(svg) && /y = 2x \+ 1/.test(svg) && /R² = 1/.test(svg) && /Linear \(Sales\)/.test(svg), "trendline, label and legend entry drawn");
  // Excel offers no trendline on stacked charts: the control is disabled and the line disappears
  await card.getByLabel("Stacking").selectOption("stacked");
  ok(await card.getByLabel("Trendline").isDisabled() && !/data-trend=/.test(await imgSvg(card.locator("img"))), "stacked: trendline disabled and not drawn");
  await card.getByLabel("Stacking").selectOption("clustered");
  await s.page.screenshot({ path: join(SHOTS, "e2e50-trend.png") });
  await s.save(); await s.close();
  const b = join(tmp, "trend.xlsx"); writeFileSync(b, await readBytes(src));
  const o = oracle(b); ok(!o.error, `oracle: ${o.error}`);
  eq(o.charts!.length, 1, "one chart"); eq([o.charts![0].type, o.charts![0].series[0].trend], ["lineChart", "linear"], "line chart with linear trendline");
});

await test("modal-shortcut failure test: Delete, Backspace, typing and Ctrl+Z inside the chart panel never touch the selected grid cell", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  [["Item", "Qty"], ["a", 4], ["b", 6]].forEach((row, r) => row.forEach((v, c) => sh.setCell(c, r, String(v)))); wb.recalculate();
  const src = `/Documents/${RUN}-modal.xlsx`; await upload(src, writeXlsxWorkbook(wb));
  const s = await openSheetFile(src);
  await s.cell("A1").click(); await s.cell("B3").click({ modifiers: ["Shift"] });
  await s.dlg.getByRole("button", { name: /Insert a chart from the selection/ }).click();
  await s.cell("B2").click();
  const card = (await s.charts()).locator("[data-chart]").first();
  const t = card.getByLabel("Horizontal axis title"); await t.click();
  for (const k of ["Delete", "Backspace"]) await s.page.keyboard.press(k);
  await s.page.keyboard.type("Zz9"); await s.page.keyboard.press("Control+z");
  eq(await s.cell("B2").innerText(), "4", "B2 unchanged");
  ok((await t.inputValue()).length <= 3, "typing went to the input");
  await s.cell("B3").click(); await s.page.keyboard.type("8"); await s.page.keyboard.press("Enter");
  eq(await s.cell("B3").innerText(), "8", "grid still editable after leaving the panel");
  await s.close();
});

await test("no uncaught page errors during the charts session", COV, async () => { await purge(); eq(errors, [], "page errors"); });

await browser.close();
await finish();
