/**
 * TT47 e2e — Spreadsheet Class-A view/edit/save in the real UI (Chromium 143 headless):
 *  - theme colours and imported conditional formats (cellIs, 3-colour scale) render in the grid;
 *  - a CF rule added through the panel (≥ with its value box; 3-colour scale) shows immediately and is
 *    written into the original .xlsx by Save (lossless patch), verified by the independent oracle
 *    (scripts/oracle/xlsx_cf.py: openpyxl + lxml + colorsys) and by openpyxl's cell diff.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt47.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `x${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt47");
const COV = { "FF-20": "full", "FF-21": "full", "FF-11": "full", "PR-11": "partial" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", XCORPUS = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "e2e47-"));
const SHOTS = process.env.SHOTS ?? "/tmp";
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function upload(path: string, bytes: Uint8Array) { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "base64")); }

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
  return { page, dlg, cell, tab, close: () => ctx.close() };
}
const css = (l: Locator, prop: "backgroundColor" | "color") => l.evaluate((e, p) => getComputedStyle(e)[p as "color"], prop);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

await test("Spreadsheet renders theme colours and imported conditional formats (cellIs on a theme-tinted dxf; 3-colour scale with percentile midpoint)", COV, async () => {
  const src = `/Documents/${RUN}-view.xlsx`;
  await upload(src, new Uint8Array(readFileSync(join(XCORPUS, "ConditionalFormattingSamples.xlsx"))));
  const s = await openSheetFile(src);
  await s.tab("Products1");
  await s.cell("D7").waitFor({ timeout: 15_000 });
  eq(await css(s.cell("D7"), "backgroundColor"), rgb("#dce6f2"), "D7 (192.1 < 500) gets the theme-tinted rule fill");
  ok((await css(s.cell("D3"), "backgroundColor")) !== rgb("#dce6f2"), "D3 (1148) does not match the lt 500 rule");
  await s.tab("Category sales");
  await s.cell("G3").waitFor({ timeout: 15_000 });
  // expected colours from the importer + evaluator, independently checked against openpyxl in tt47-sheet
  const wb = readXlsxWorkbook(readFileSync(join(XCORPUS, "ConditionalFormattingSamples.xlsx"))); wb.recalculate();
  const vals: [string, number][] = []; for (let r = 2; r <= 21; r++) { const v = wb.valueAt("Category sales", 6, r); if (typeof v === "number") vals.push([`G${r + 1}`, v]); }
  vals.sort((a, b) => a[1] - b[1]);
  const lo = vals[0][0], hi = vals[vals.length - 1][0];
  await s.cell(lo).scrollIntoViewIfNeeded(); eq(await css(s.cell(lo), "backgroundColor"), rgb("#c00000"), `${lo} (minimum) is the scale's min colour`);
  await s.cell(hi).scrollIntoViewIfNeeded(); eq(await css(s.cell(hi), "backgroundColor"), rgb("#0070c0"), `${hi} (maximum) is the scale's max colour`);
  const midRef = vals[Math.floor(vals.length / 2)][0];
  await s.cell(midRef).scrollIntoViewIfNeeded();
  const mid = (await css(s.cell(midRef), "backgroundColor")).match(/\d+/g)!.map(Number);
  ok(mid[0] > 150 && mid[1] > 150 && mid[2] < 150, `${midRef} (median) is near the yellow midpoint, got rgb(${mid})`);
  await s.page.screenshot({ path: join(SHOTS, "e2e47-cf-scale.png") });
  await s.close();
  const t = `/Documents/${RUN}-theme.xlsx`;
  await upload(t, new Uint8Array(readFileSync(join(XCORPUS, "Themes2.xlsx"))));
  const s2 = await openSheetFile(t);
  await s2.cell("B6").waitFor({ timeout: 15_000 });
  eq(await css(s2.cell("B6"), "color"), rgb("#4f81bd"), "B6 font <color theme=\"4\"/> = accent1");
  eq(await css(s2.cell("E5"), "backgroundColor"), rgb("#002060"), "E5 fill");
  await s2.page.screenshot({ path: join(SHOTS, "e2e47-theme.png") });
  await s2.close();
});

await test("Spreadsheet: add '≥ 1000' and a 3-colour scale through the panel → shown at once → Save writes them into the original .xlsx (independent CF oracle + openpyxl cell diff)", COV, async () => {
  const src = `/Documents/${RUN}-edit.xlsx`;
  const orig = new Uint8Array(readFileSync(join(XCORPUS, "ConditionalFormattingSamples.xlsx")));
  await upload(src, orig);
  const s = await openSheetFile(src);
  await s.tab("Products1");
  await s.cell("D3").click(); await s.cell("D8").click({ modifiers: ["Shift"] });
  await s.dlg.getByRole("button", { name: "Cond. format" }).click();
  const panel = s.dlg.locator('[data-testid="cf-panel"]');
  await panel.getByLabel("Rule type").selectOption("ge");
  const val = panel.getByLabel("Rule value"); await val.waitFor({ timeout: 3000 }); // the ≥ option has a value box (TT46 bug: it had none)
  await val.fill("1000");
  await panel.getByLabel("Rule fill").evaluate((e) => { const i = e as HTMLInputElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(i, "#14532d"); i.dispatchEvent(new Event("input", { bubbles: true })); });
  await panel.getByRole("button", { name: "Add rule" }).click();
  await panel.locator('[data-testid="cf-rule"][data-range="D3:D8"]').waitFor({ timeout: 5000 });
  eq(await css(s.cell("D3"), "backgroundColor"), rgb("#14532d"), "D3 (1148 ≥ 1000) shows the new rule at once");
  eq(await css(s.cell("D7"), "backgroundColor"), rgb("#dce6f2"), "D7 keeps the imported lt 500 rule");
  // 3-colour scale on F3:F12
  await s.cell("F3").click(); await s.cell("F12").click({ modifiers: ["Shift"] });
  await panel.getByLabel("Rule type").selectOption("scale3");
  await panel.getByLabel("Scale midpoint colour").waitFor({ timeout: 3000 });
  await panel.getByRole("button", { name: "Add rule" }).click();
  await panel.locator('[data-testid="cf-rule"][data-range="F3:F12"]').waitFor({ timeout: 5000 });
  await s.page.screenshot({ path: join(SHOTS, "e2e47-cf-edit.png") });
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  const status = s.dlg.locator('[data-testid="sheet-status"]');
  await status.filter({ hasText: "lossless" }).waitFor({ timeout: 15_000 });
  await s.close();
  const saved = await readBytes(src);
  const a = join(tmp, "orig.xlsx"), b = join(tmp, "saved.xlsx"); writeFileSync(a, orig); writeFileSync(b, saved);
  const cf = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_cf.py"], { input: b, encoding: "utf8" }).trim());
  ok(!cf.error, cf.error);
  ok(cf.rules.some((r: unknown[]) => JSON.stringify(r) === JSON.stringify(["Products1", "D3:D8", "ge", 1000, null, "#14532d", "#bbf7d0"])), `oracle sees the new ≥ rule: ${JSON.stringify(cf.rules.filter((r: unknown[]) => r[0] === "Products1"))}`);
  ok(cf.rules.some((r: unknown[]) => JSON.stringify(r) === JSON.stringify(["Products1", "D3:D23", "lt", 500, null, "#dce6f2", null])), "imported lt 500 rule still there");
  const back = readXlsxWorkbook(Buffer.from(saved));
  const sc = back.condFormats.find((r) => r.sheet === "Products1" && r.range === "F3:F12");
  ok(sc && sc.kind === "scale" && sc.scaleMid && sc.scaleAt === "min|percentile:50|max", `3-colour scale written: ${JSON.stringify(sc)}`);
  const pr = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_patch_probe.py"], { input: `${a}\t${b}\n`, encoding: "utf8" }).trim());
  ok(pr.ok, `openpyxl load: ${pr.error}`);
  eq(pr.diff, [], "no cell changed");
  eq(pr.partsLost, [], "no part lost");
  eq(Object.keys(pr.styleDiff), [], "no cell style drift");
});

await test("no uncaught page errors during the Spreadsheet session", COV, () => { eq(errors, [], "page errors"); });
await browser.close();
await finish();
process.exit(0);
