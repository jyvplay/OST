/**
 * TT63 e2e — Spreadsheet PivotTables saved as REAL Excel PivotTables (pivotTable + pivotCache parts), in Chromium:
 *   FF-47  Data > PivotTable (Rows Region, Columns Product, Sum of Units, Filter Flag without FALSE) → Save →
 *          the status says the pivot was written as an Excel PivotTable → the saved bytes pass the ECMA-376 XSD
 *          oracle and the pandas pivot oracle (scripts/oracle/xlsx_pivot.py recomputes the table from ONLY the
 *          definition XML + source cells, and openpyxl's pivot parser round-trips it); the Flag filter is a page field;
 *          reopen → edit the source → Alt+F5 → Save → regenerated in place (same parts, the edit in the records);
 *          Delete PivotTable → Save → no pivot part, no dangling reference.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt63.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t63${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e63-"));
const { test, finish } = makeHarness("e2e-tt63");
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


const xsdOk = (buf: Uint8Array) => { const r = oracle("scripts/oracle/ooxml_xsd.py", buf, "xlsx"); const v = Object.values(r)[0] as { ok: boolean; parts: Record<string, string[]> }; return { ok: v.ok, bad: Object.entries(v.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e[0]}`) }; };
const pivotOracle = (buf: Uint8Array): any => Object.values(oracle("scripts/oracle/xlsx_pivot.py", buf, "xlsx", "--fusion-only"))[0];
const zipNames = async (buf: Uint8Array) => { const { openZip } = await import("../src/lib/office/zipkit.ts"); return openZip(buf).entries.map((e) => e.name); };

await test("FF-47 PivotTable saved as a real Excel PivotTable from the UI: create with a report filter → Save → XSD + pandas + openpyxl oracles; reopen → source edit → Alt+F5 → Save regenerates in place; Delete → Save removes every pivot part", { "FF-47": "full" }, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  const rows: (string | number)[][] = [["Region", "Product", "Units", "Flag"], ["East", "Pens", 10, "TRUE"], ["West", "Pens", 4, "FALSE"], ["East", "Ink", 2, "TRUE"], ["West", "Paper", 20, "TRUE"], ["East", "Pens", 6, "TRUE"], ["West", "Ink", 3, "FALSE"], ["North", "Ink", 1, "TRUE"]];
  rows.forEach((r, i) => r.forEach((v, j) => sh.setCell(j, i, String(v)))); wb.recalculate();
  const orig = writeXlsxWorkbook(wb);
  const src = `/Documents/${RUN}-pivotparts.xlsx`;
  const up = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(orig).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(up.status < 300, `upload ${up.status}`);
  const open = async () => {
    await putDesktop([]);
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
    const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
    return { ctx, page, dlg, cell: (r: string) => dlg.locator(`[data-cell="${r}"]`), status: async () => (await dlg.getByTestId("sheet-status").textContent()) ?? "" };
  };
  const saveAndRead = async (s: Awaited<ReturnType<typeof open>>, before: Uint8Array) => {
    await s.dlg.getByRole("button", { name: "Save workbook" }).click();
    let saved = new Uint8Array();
    await poll(async () => { saved = Uint8Array.from(await read(src)); return Buffer.compare(Buffer.from(saved), Buffer.from(before)) !== 0; }, "saved bytes changed");
    return saved;
  };
  // 1. create with Rows / Columns / Values + a report filter on Flag (FALSE unticked)
  let s = await open();
  await s.cell("B3").click();
  await s.dlg.getByRole("button", { name: /^Insert a PivotTable/ }).click();
  const panel = s.dlg.getByTestId("pivot-panel"); await panel.waitFor();
  ok(/real Excel PivotTable/.test(await panel.innerText()), "the panel says .xlsx save writes a real PivotTable");
  await panel.getByLabel("Columns field", { exact: true }).selectOption({ label: "Product" });
  await panel.getByLabel("Filter field", { exact: true }).selectOption({ label: "Flag" });
  await panel.getByRole("group", { name: "Filter items" }).getByLabel("FALSE").uncheck();
  await panel.getByRole("button", { name: "Create" }).click();
  await poll(async () => (await s.dlg.getByRole("button", { name: "Pivot1", exact: true }).count()) === 1, "Pivot1 sheet created");
  await poll(async () => (await s.cell("A3").innerText()).trim() === "Sum of Units", "pivot written at A3");
  eq((await s.cell("E5").innerText()).trim(), "18", "East total (Flag TRUE only: Pens 10+6, Ink 2)");
  eq((await s.cell("A6").innerText()).trim(), "North", "North row");
  eq((await s.cell("E7").innerText()).trim(), "20", "West total without the FALSE rows (Paper 20)");
  let saved = await saveAndRead(s, orig);
  await poll(async () => /1 PivotTable\(s\) written as Excel PivotTables/.test(await s.status()), "status names the Excel PivotTable");
  await s.page.screenshot({ path: "docs/screens/tt63-pivot-parts.png" });
  let x = xsdOk(saved); ok(x.ok, `XSD: ${x.bad.join(" | ")}`);
  let p = pivotOracle(saved); ok(p.ok, `pivot oracle: ${JSON.stringify(p).slice(0, 600)}`);
  eq([p.tables.length, p.tables[0].pages, p.openpyxl], [1, 1, 1], "one table with one page field, openpyxl sees it");
  ok(p.tables[0].checked >= 12, `cells recomputed: ${p.tables[0].checked}`);
  const parts1 = (await zipNames(saved)).filter((n) => /pivot/i.test(n)).sort();
  ok(parts1.includes("xl/pivotTables/pivotTable1.xml") && parts1.includes("xl/pivotCache/pivotCacheRecords1.xml"), `parts ${parts1}`);
  await s.ctx.close();
  // 2. reopen from the saved bytes → edit the source → Alt+F5 → Save → regenerated in place
  s = await open();
  await s.cell("C2").click(); await s.page.keyboard.type("100"); await s.page.keyboard.press("Enter");
  await s.dlg.getByRole("button", { name: "Pivot1", exact: true }).click();
  await s.cell("B5").click(); await s.page.keyboard.press("Alt+F5");
  await poll(async () => (await s.cell("E5").innerText()).trim() === "108", "East total follows the edit");
  const before2 = saved; saved = await saveAndRead(s, before2);
  const parts2 = (await zipNames(saved)).filter((n) => /pivot/i.test(n)).sort();
  eq(parts2, parts1, "same pivot part names after the lossless save");
  p = pivotOracle(saved); ok(p.ok && p.tables[0].checked >= 12, `pivot oracle after edit: ${JSON.stringify(p).slice(0, 600)}`);
  // 3. Delete PivotTable → Save → nothing left
  await s.cell("B5").click();
  await s.dlg.getByRole("button", { name: /^Insert a PivotTable/ }).click(); await s.dlg.getByTestId("pivot-panel").waitFor();
  s.page.once("dialog", (d) => d.accept());
  await s.dlg.getByTestId("pivot-panel").getByRole("button", { name: "Delete PivotTable" }).click();
  await poll(async () => (await s.cell("A3").innerText()).trim() === "", "pivot cells cleared");
  const before3 = saved; saved = await saveAndRead(s, before3);
  const left = (await zipNames(saved)).filter((n) => /pivot/i.test(n)); eq(left, [], "no pivot part left");
  x = xsdOk(saved); ok(x.ok, `XSD after delete: ${x.bad.join(" | ")}`);
  await s.ctx.close();
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: src });
});

await test("no uncaught page errors during the TT63 session", { "FF-47": "full" }, () => { eq(errors, [], "page errors"); });

// test hygiene (TT64): this run's /Documents files go — left behind, every run's uploads pile up on the Tabletop floor past its
// ~46-card layout and fail e2e-tabletop / e2e-beauty (found in the TT64 gate)
for (const n of ((await api("GET", "/api/fs?op=list&path=/Documents")).json?.nodes ?? []) as { name: string; path: string }[]) if (n.name.startsWith(RUN)) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
await browser.close();
finish();
