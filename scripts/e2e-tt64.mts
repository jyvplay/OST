/**
 * TT64 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-48 Writer tracked column insert / delete through the UI: Track changes → Column right → every new cell tinted as an
 *         inserted cell, ONE "[Table column]" change in Review; Delete column → the column tinted as deleted, a second
 *         change; Reject the deletion, Accept the insertion → Save → the saved bytes are checked by the independent lxml
 *         oracle (docx_tblrev.py: tables, grid_ok, no markers / grid change left) and the ECMA-376 XSDs. A table with a
 *         w:gridBefore row renders aligned to the grid (the cell under column 2 sits under column 2).
 *   FF-28 (TT64) Paste Link of a RANGE writes relative references (Excel's rule; a single cell stays absolute): copy A1:B2 →
 *         Paste Special ▸ Paste Link at D1 → openpyxl reads =A1 / =B1 / =A2 / =B2 from the saved file, values follow edits.
 * Ground truth: saved bytes read back through /api/fs and parsed by lxml / openpyxl — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt64.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { blankWord, writeWord, allParas, rowsOf, cellsOf, type Table } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { el } from "../src/lib/office/xmltree.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t64${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e64-"));
const { test, finish } = makeHarness("e2e-tt64");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
const upload = async (path: string, bytes: Uint8Array, mime: string) => { const up = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(up.status === 200, "upload " + path); };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const put = (b: Uint8Array, ext: string) => { const f = join(tmp, `o${Date.now()}${Math.random().toString(36).slice(2)}.${ext}`); writeFileSync(f, b); return f; };

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const views = (await api("GET", "/api/settings")).json.rows as { key: string; value: string }[];
const prevView = views.find((r) => r.key === "appearance.desktopView")?.value ?? "classic";
await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });

await test("FF-48 Writer tracked columns in the UI: Track changes → Column right (3 inserted cells, one '[Table column]' change) → Delete column (3 deleted cells, a second change) → Reject the deletion, Accept the insertion → Save → lxml oracle + XSD; a gridBefore row renders on the grid", { "FF-48": "full" }, async () => {
  const d = await blankWord("cols"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Columns below.");
  const t = E.insertTableAfter(d, p0.id, 3, 3)!;
  rowsOf(t).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `R${ri}C${ci}`)));
  // a second table whose row 1 starts with an empty grid column (w:gridBefore 1)
  const after = allParas(d.blocks).at(-1)!;
  const g = E.insertTableAfter(d, after.id, 2, 3)!;
  rowsOf(g).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `G${ri}C${ci}`)));
  const g1 = rowsOf(g)[1]; g1.items.splice(g1.items.indexOf(cellsOf(g1)[0]), 1); g1.items.unshift(el("w:trPr", {}, [el("w:gridBefore", { "w:val": "1" })]));
  const path = `/Documents/${RUN}-cols.docx`; await upload(path, await writeWord(d), DOCX);
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 30_000 });
  const body = dlg.getByTestId("writer-body"); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  const td = (txt: string) => body.locator("td").filter({ hasText: new RegExp(`^${txt}$`) }).first();
  // gridBefore rendering: G1C1 sits under G0C1 (same grid column), not under G0C0
  const [a, b0, b] = [await td("G0C1").boundingBox(), await td("G0C0").boundingBox(), await td("G1C1").boundingBox()];
  ok(a && b && b0 && Math.abs(a.x - b.x) < 3 && Math.abs(b0.x - b.x) > 20, `gridBefore row aligned: G0C1 x=${a?.x} G1C1 x=${b?.x} G0C0 x=${b0?.x}`);
  // tracked insert
  await td("R1C1").click();
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  await dlg.getByTestId("writer-track").click();
  await dlg.getByTestId("writer-track-chip").waitFor();
  await dlg.getByRole("button", { name: "Column right", exact: true }).click();
  await dlg.getByTestId("writer-status").filter({ hasText: "Column inserted as a tracked change" }).waitFor();
  await poll(async () => (await body.locator("td.wcell-ins").count()) === 3, "three inserted cells tinted");
  const items = dlg.getByTestId("writer-changes").locator("[role=listitem]").filter({ hasText: "[Table column]" });
  await poll(async () => (await items.count()) === 1, "one column change listed");
  // tracked delete of the first column
  await td("R0C0").click();
  await dlg.getByRole("button", { name: "Delete column", exact: true }).click();
  await dlg.getByTestId("writer-status").filter({ hasText: "Column marked deleted" }).waitFor();
  await poll(async () => (await body.locator("td.wcell-del").count()) === 3, "three deleted cells tinted");
  eq(await body.locator("td.wcell-del").allInnerTexts(), ["R0C0", "R1C0", "R2C0"], "the deleted column is tinted on the page");
  await poll(async () => (await items.count()) === 2, "two column changes listed");
  // visual check: maximised so the whole table (deleted column 1 AND inserted column 3) is on screen, then restored
  const maxBtn = dlg.getByRole("button", { name: /^Maximise/ }).first();
  await maxBtn.click(); await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/screens/tt64-writer-tracked-columns.png" });
  await maxBtn.click(); await page.waitForTimeout(400);
  // reject the deletion, accept the insertion
  await items.filter({ hasText: "Deleted" }).first().getByRole("button", { name: /^Reject/ }).click();
  await poll(async () => (await body.locator("td.wcell-del").count()) === 0 && (await items.count()) === 1, "deletion rejected: the column stays, unmarked");
  await items.first().getByRole("button", { name: /^Accept/ }).click();
  await poll(async () => (await body.locator("td.wcell-ins").count()) === 0 && (await items.count()) === 0, "insertion accepted");
  await body.locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const saved = await read(path);
  const o = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", put(saved, "docx")], { encoding: "utf8" }));
  eq(o.accept[0], [["R0C0", "R0C1", "", "R0C2"], ["R1C0", "R1C1", "", "R1C2"], ["R2C0", "R2C1", "", "R2C2"]], "the kept column sits right of column 2, the first column survives");
  ok(o.grid_ok && o.tcpr_ok && o.order_ok && o.opens === true && o.ids_unique, `oracle soundness ${JSON.stringify([o.grid_errors, o.tcpr_errors, o.order_errors, o.opens])}`);
  eq(o.cells, [], "no cell markers left"); eq(o.grids.map((x: { change: unknown }) => x.change), [null, null], "no grid change left");
  eq(o.grids[0].asis.length, 4, "4 grid columns");
  const x = Object.values(JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", put(saved, "docx")], { encoding: "utf8" })))[0] as { ok: boolean; parts: Record<string, string[]> };
  ok(x.ok, `XSD: ${JSON.stringify(Object.entries(x.parts).filter(([, e]) => e.length))}`);
  await page.context().close();
});

await test("FF-28 (TT64) Paste Link of a range in the UI writes relative references, a single cell absolute — openpyxl reads the saved formulas; the links follow a source edit", { "FF-28": "full" }, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  [["1", "2"], ["3", "4"]].forEach((r, i) => r.forEach((v, j) => sh.setCell(j, i, v))); sh.setCell(0, 4, "9"); wb.recalculate();
  const src = `/Documents/${RUN}-link.xlsx`; const orig = writeXlsxWorkbook(wb); await upload(src, orig, XLSX);
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const txt = async (r: string) => (await cell(r).innerText()).trim();
  // range A1:B2 → D1
  await cell("A1").click(); await cell("B2").click({ modifiers: ["Shift"] }); await page.keyboard.press("Control+c");
  await cell("D1").click(); await page.keyboard.press("Control+Shift+V");
  const ps = dlg.getByTestId("paste-special"); await ps.waitFor();
  await ps.getByRole("button", { name: "Paste Link", exact: true }).click();
  await poll(async () => (await txt("E2")) === "4", "linked range values");
  // single cell A5 → D5
  await cell("A5").click(); await page.keyboard.press("Control+c");
  await cell("D5").click(); await page.keyboard.press("Control+Shift+V"); await ps.waitFor();
  await ps.getByRole("button", { name: "Paste Link", exact: true }).click();
  await poll(async () => (await txt("D5")) === "9", "linked single value");
  await cell("B1").click(); await page.keyboard.type("20"); await page.keyboard.press("Enter");
  await poll(async () => (await txt("E1")) === "20", "follows the source edit");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = new Uint8Array();
  await poll(async () => { saved = Uint8Array.from(await read(src)); return Buffer.compare(Buffer.from(saved), Buffer.from(orig)) !== 0; }, "saved bytes changed");
  const o = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", "import json,sys,openpyxl; ws=openpyxl.load_workbook(sys.argv[1]).active; print(json.dumps({c: ws[c].value for c in ['D1','E1','D2','E2','D5']}))", put(saved, "xlsx")], { encoding: "utf8" }).trim());
  eq(o, { D1: "=A1", E1: "=B1", D2: "=A2", E2: "=B2", D5: "=$A$5" }, "openpyxl reads relative links for the range, absolute for the single cell");
  await page.context().close();
});

await test("no page errors during the TT64 session", { "FF-48": "full" }, async () => { eq(errors, [], "page errors"); });

await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
// test hygiene (TT64): this run's /Documents files go — left behind, every run's uploads pile up on the Tabletop floor past its
// ~46-card layout and fail e2e-tabletop / e2e-beauty (found in the TT64 gate)
for (const n of ((await api("GET", "/api/fs?op=list&path=/Documents")).json?.nodes ?? []) as { name: string; path: string }[]) if (n.name.startsWith(RUN)) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
await browser.close();
await finish();
process.exit(0);
