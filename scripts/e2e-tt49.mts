/**
 * TT49 e2e — Spreadsheet conditional formatting in the real UI (Chromium 143 headless):
 *  - imported x14 data bars (automatic bounds, border), x14-only 3Stars and custom icon sets, CF borders and
 *    formula rules are DRAWN in the grid exactly as the evaluator computes them (whose correctness is
 *    established against the independent Python oracle in scripts/tt49-sheet.mts);
 *  - modal-shortcut failure test: while a CF input has focus, Delete / Backspace / typing / Ctrl+Z / Enter never
 *    edit, clear or undo the selected grid cell;
 *  - add a data bar, an icon set and a "formula is true" rule through the panel → drawn at once → Save writes
 *    them into the original .xlsx (lossless patch) → the independent oracle evaluates the saved file and agrees
 *    with what the grid showed; openpyxl sees no cell change.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt49.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { a1, Workbook } from "../src/lib/formula/engine.ts";
import { evalCondFormats, type CondRule } from "../src/lib/formula/sheetmeta.ts";
import { ICON_SETS } from "../src/lib/formula/cficons.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `x${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt49");
const COV = { "FF-29": "full", "FF-20": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python", XCORPUS = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "e2e49-"));
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
  /** the grid virtualises columns: jump with the Name Box (Excel's go-to) when the cell is not rendered */
  const goto = async (ref: string) => { if (await cell(ref).count()) return; const nb = dlg.getByTestId("name-box"); await nb.fill(ref); await nb.press("Enter"); await cell(ref).waitFor({ timeout: 5000 }); };
  return { page, dlg, cell, tab, goto, close: () => ctx.close() };
}
const attr = (l: Locator, sel: string, a: string) => l.evaluate((e, [s, n]) => e.querySelector(s)?.getAttribute(n) ?? null, [sel, a] as const);
const cellText = (l: Locator) => l.evaluate((e) => (e as HTMLElement).innerText.trim());
/** what the grid must draw for one rule, from the evaluator */
function expected(wb: Workbook, sheet: string, rules: CondRule[]) {
  const m = evalCondFormats(wb, sheet, rules); const out = new Map<string, { bar?: string; icon?: string; border?: string }>();
  for (const [k, s] of m) { const [c, r] = k.split(",").map(Number); out.set(a1(c, r), { bar: s.bar ? `${s.bar.from.toFixed(3)}-${s.bar.to.toFixed(3)}` : undefined, icon: s.icon, border: s.border ? (["top", "right", "bottom", "left"] as const).filter((x) => s.border![x]).map((x) => x[0]).join("") : undefined }); }
  return out;
}

await test("imported x14 data bars (automatic bounds + border), x14-only 3Stars and a custom icon mix are drawn cell-for-cell as evaluated", COV, async () => {
  const f = join(XCORPUS, "NewStyleConditionalFormattings.xlsx"); const src = `/Documents/${RUN}-newstyle.xlsx`;
  await upload(src, new Uint8Array(readFileSync(f)));
  const wb = readXlsxWorkbook(readFileSync(f)); wb.recalculate();
  const s = await openSheetFile(src);
  let checked = 0;
  for (const [range, kind] of [["E2:E17", "bar"], ["Q2:Q17", "icons"], ["U2:U17", "icons"]] as const) {
    const rule = wb.condFormats.find((r) => r.sheet === "CF" && r.range === range && r.kind === kind)!; ok(rule, `${range} ${kind} rule`);
    const want = expected(wb, "CF", [rule]);
    for (const [ref, w] of want) {
      await s.goto(ref); const c = s.cell(ref);
      if (kind === "bar") { eq(await attr(c, "[data-cf-bar]", "data-cf-bar"), w.bar, `${ref} bar`); ok((await attr(c, "[data-cf-bar]", "style"))?.includes("border"), `${ref} bar border`); }
      else eq(await attr(c, "[data-cf-icon]", "data-cf-icon"), w.icon, `${ref} icon`);
      checked++;
    }
  }
  ok(checked >= 40, `only ${checked} cells`);
  // the custom set mixes three different sets — check that all three glyph families actually appear
  const glyphs = new Set<string>(); for (let r = 2; r <= 17; r++) { await s.goto(`U${r}`); const g = await attr(s.cell(`U${r}`), "[data-cf-icon]", "data-cf-icon"); if (g) glyphs.add(g); }
  ok([...glyphs].every((g) => [ICON_SETS["3Signs"][0], ICON_SETS["3Flags"][1], ICON_SETS["3Symbols2"][2]].includes(g)) && glyphs.size >= 2, `custom glyphs ${[...glyphs]}`);
  await s.goto("E2"); await s.page.screenshot({ path: join(SHOTS, "e2e49-x14.png") });
  await s.close();
});

await test("CF borders, formula rules and time periods from a workbook our writer produced are drawn as evaluated", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); const S = sh.name;
  for (let r = 0; r < 8; r++) { sh.setCell(0, r, String(r * 3 - 6)); sh.setCell(1, r, String(r)); }
  wb.condFormats = [
    { id: "b1", sheet: S, range: "A1:A8", kind: "expr", formula: "MOD(ROW(),2)=0", border: { bottom: { style: "medium", color: "#c00000" }, left: { style: "thin" } }, italic: true },
    { id: "b2", sheet: S, range: "A1:A8", kind: "bar", barColor: "#638ec6", cfvo: [{ t: "autoMin" }, { t: "autoMax" }], barMinLen: 0, barMaxLen: 100, barAxis: "auto", barNeg: "#ff0000" },
    { id: "b3", sheet: S, range: "B1:B8", kind: "icons", iconSet: "5Rating" },
  ];
  wb.recalculate();
  const src = `/Documents/${RUN}-ours.xlsx`; await upload(src, writeXlsxWorkbook(wb));
  const back = readXlsxWorkbook(Buffer.from(writeXlsxWorkbook(wb))); back.recalculate();
  const want = expected(back, S, back.condFormats);
  const s = await openSheetFile(src);
  for (const [ref, w] of want) {
    const c = s.cell(ref);
    eq(await attr(c, "[data-cf-border]", "data-cf-border"), w.border ?? null, `${ref} border sides`);
    eq(await attr(c, "[data-cf-bar]", "data-cf-bar"), w.bar ?? null, `${ref} bar`);
    eq(await attr(c, "[data-cf-icon]", "data-cf-icon"), w.icon ?? null, `${ref} icon`);
  }
  const bb = await s.cell("A2").evaluate((e) => getComputedStyle(e.querySelector("[data-cf-border]")!).borderBottom);
  ok(/2px solid rgb\(192, 0, 0\)/.test(bb), `A2 CF bottom border ${bb}`);
  eq(await attr(s.cell("A1"), "[data-cf-bar]", "data-cf-bar-color"), "#ff0000", "A1 (−6) uses the negative bar colour");
  await s.page.screenshot({ path: join(SHOTS, "e2e49-border.png") });
  await s.close();
});

await test("modal-shortcut failure test: Delete, Backspace, typing, Ctrl+Z and Enter inside the CF panel never touch the selected grid cell", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); sh.setCell(0, 0, "42"); sh.setCell(1, 0, "keep me"); wb.recalculate();
  const src = `/Documents/${RUN}-keys.xlsx`; await upload(src, writeXlsxWorkbook(wb));
  const s = await openSheetFile(src);
  await s.cell("A1").click(); await s.page.keyboard.type("7"); await s.page.keyboard.press("Enter"); // one real edit so Ctrl+Z has something to undo
  eq(await cellText(s.cell("A1")), "7", "edit applied");
  await s.cell("A1").click();
  await s.dlg.getByRole("button", { name: "Cond. format" }).click();
  const panel = s.dlg.locator('[data-testid="cf-panel"]');
  await panel.getByLabel("Rule type").selectOption("expr");
  const fx = panel.getByLabel("Rule formula"); await fx.click();
  await s.page.keyboard.type("=$A1>5"); await s.page.keyboard.press("Delete"); await s.page.keyboard.press("Backspace"); await s.page.keyboard.press("Backspace");
  await s.page.keyboard.press("Control+z"); await s.page.keyboard.press("Home"); await s.page.keyboard.press("Delete"); await s.page.keyboard.press("Enter");
  eq(await cellText(s.cell("A1")), "7", "A1 neither cleared nor undone nor edited");
  eq(await cellText(s.cell("B1")), "keep me", "B1 untouched");
  eq(await s.dlg.getByLabel("Cell editor").count(), 0, "no cell editor opened");
  await panel.getByLabel("Rule type").selectOption("gt");
  const v = panel.getByLabel("Rule value"); await v.click(); await s.page.keyboard.type("5"); await s.page.keyboard.press("Delete"); await s.page.keyboard.press("Backspace"); await s.page.keyboard.type("x");
  eq(await cellText(s.cell("A1")), "7", "value box keys never reach the grid");
  // the grid still works after leaving the panel
  await s.cell("B1").click(); await s.page.keyboard.press("Delete"); eq(await cellText(s.cell("B1")), "", "Delete on the grid still clears");
  await s.close();
});

await test("add a data bar, an icon set and a formula rule in the panel → drawn at once → Save → the independent oracle evaluates the saved .xlsx exactly as the grid showed", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); const S = sh.name;
  for (let r = 0; r < 10; r++) { sh.setCell(0, r, String([5, 12, 3, 20, 8, 15, 1, 9, 18, 11][r])); sh.setCell(1, r, String(r * 10)); sh.setCell(2, r, String(r % 3)); }
  wb.recalculate(); const orig = writeXlsxWorkbook(wb);
  const src = `/Documents/${RUN}-add.xlsx`; await upload(src, orig);
  const s = await openSheetFile(src);
  await s.dlg.getByRole("button", { name: "Cond. format" }).click();
  const panel = s.dlg.locator('[data-testid="cf-panel"]');
  const add = async (from: string, to: string, kind: string, setup?: () => Promise<void>) => {
    await s.cell(from).click(); await s.cell(to).click({ modifiers: ["Shift"] });
    await panel.getByLabel("Rule type").selectOption(kind); if (setup) await setup();
    await panel.getByRole("button", { name: "Add rule" }).click();
  };
  await add("A1", "A10", "bar");
  await add("B1", "B10", "icons", async () => { await panel.getByLabel("Icon set").selectOption("3Arrows"); });
  await add("C1", "C10", "expr", async () => { await panel.getByLabel("Rule formula").fill("=$C1=0"); });
  const labels = await panel.locator('[data-testid="cf-rule-label"]').allInnerTexts();
  eq(labels, ["data bar", "icon set 3Arrows", "formula =$C1=0"], "rule list labels");
  const shown = { bar: {} as Record<string, string | null>, icon: {} as Record<string, string | null>, fill: {} as Record<string, string> };
  for (let r = 1; r <= 10; r++) {
    shown.bar[`A${r}`] = await attr(s.cell(`A${r}`), "[data-cf-bar]", "data-cf-bar");
    shown.icon[`B${r}`] = await attr(s.cell(`B${r}`), "[data-cf-icon]", "data-cf-icon");
    shown.fill[`C${r}`] = await s.cell(`C${r}`).evaluate((e) => getComputedStyle(e).backgroundColor);
  }
  ok(Object.values(shown.bar).every(Boolean) && Object.values(shown.icon).every(Boolean), "every A cell has a bar and every B cell an icon");
  await s.page.screenshot({ path: join(SHOTS, "e2e49-add.png") });
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.dlg.locator('[data-testid="sheet-status"]').filter({ hasText: "lossless" }).waitFor({ timeout: 15_000 });
  await s.close();
  const saved = await readBytes(src); const a = join(tmp, "orig.xlsx"), b = join(tmp, "saved.xlsx"); writeFileSync(a, orig); writeFileSync(b, saved);
  const o = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_cf_eval.py"], { input: b, encoding: "utf8" }).trim());
  ok(!o.error, o.error);
  const byType = (t: string) => o.rules.find((r: { type: string }) => r.type === t);
  const bar = byType("dataBar"), icons = byType("iconSet"), expr = byType("expression");
  ok(bar && icons && expr, `oracle sees the three rules: ${o.rules.map((r: { type: string }) => r.type)}`);
  for (let r = 1; r <= 10; r++) {
    const [f, t] = shown.bar[`A${r}`]!.split("-").map(Number); ok(Math.abs((t - f) - bar.cells[`A${r}`]) < 1e-3, `A${r}: grid bar ${t - f} oracle ${bar.cells[`A${r}`]}`);
    eq(ICON_SETS["3Arrows"].indexOf(shown.icon[`B${r}`]!), icons.cells[`B${r}`], `B${r} icon index`);
    eq(expr.cells[`C${r}`] === true, (r - 1) % 3 === 0, `C${r} oracle formula result`);
    eq(shown.fill[`C${r}`] !== "rgba(0, 0, 0, 0)" && shown.fill[`C${r}`] !== shown.fill["C2"], (r - 1) % 3 === 0, `C${r} grid fill shown iff the formula is true`);
  }
  const pr = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_patch_probe.py"], { input: `${a}\t${b}\n`, encoding: "utf8" }).trim());
  ok(pr.ok, `openpyxl load: ${pr.error}`); eq(pr.diff, [], "no cell changed"); eq(pr.partsLost, [], "no part lost");
});

await test("no uncaught page errors during the conditional-formatting session", COV, async () => { await purge(); eq(errors, [], "page errors"); });

await browser.close();
await finish();
