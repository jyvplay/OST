/**
 * TT66 e2e — Excel 2010 conditional formatting authored in the real Spreadsheet UI (Chromium 143 headless):
 *  - the CF panel adds a data bar with a middle axis + negative colour + solid fill + border, an x14-only 3Stars icon set
 *    and a custom icon mix (one band "no icon", icon only) → drawn at once → Save (lossless patch) → the saved .xlsx is
 *    checked by the independent x14 oracle (scripts/oracle/xlsx_x14.py: Microsoft's MS-XLSX schemas + structural rules)
 *    and the ECMA-376 XSD oracle → reopened in a fresh browser context: the same rules are listed and drawn the same;
 *  - modal-shortcut failure test: while one of the new panel controls has focus, Delete / Backspace / letters / Ctrl+Z
 *    never edit, clear or undo the selected grid cell.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt66.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { iconLabel } from "../src/lib/formula/cficons.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `x${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt66");
const COV = { "FF-50": "full", "FF-29": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e66-"));
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
  return { page, dlg, cell, close: () => ctx.close() };
}
const attr = (l: Locator, sel: string, a: string) => l.evaluate((e, [s, n]) => e.querySelector(s)?.getAttribute(n) ?? null, [sel, a] as const);
const cellText = (l: Locator) => l.evaluate((e) => (e as HTMLElement).innerText.trim());
const VALS = [-30, -10, 0, 5, 12, 20, 35, 50, 8, 27];
function source(): Uint8Array {
  const wb = new Workbook(); const sh = wb.sheet();
  VALS.forEach((v, r) => { sh.setCell(0, r, String(v)); sh.setCell(1, r, String(r * 10)); sh.setCell(2, r, String(r)); });
  wb.recalculate(); return writeXlsxWorkbook(wb);
}
type Drawn = Record<string, { bar: string | null; barStyle: string | null; icon: string | null; text: string }>;
async function drawn(s: Awaited<ReturnType<typeof openSheetFile>>): Promise<Drawn> {
  const out: Drawn = {};
  for (let r = 1; r <= 10; r++) for (const c of ["A", "B", "C"]) {
    const ref = `${c}${r}`; const l = s.cell(ref);
    out[ref] = { bar: await attr(l, "[data-cf-bar]", "data-cf-bar"), barStyle: await attr(l, "[data-cf-bar]", "style"), icon: await attr(l, "[data-cf-icon]", "data-cf-icon"), text: await cellText(l) };
  }
  return out;
}
const LABELS = ["data bar (negative axis)", "icon set 3Stars", "icon set 3Arrows (custom)"];

await test("CF panel → Excel 2010 rules (axis bar, 3Stars, custom icons) drawn at once → Save → saved .xlsx passes the MS-XLSX x14 schema + structural oracle and the ECMA XSDs → reopen lists and draws the same", COV, async () => {
  const src = `/Documents/${RUN}-x14.xlsx`; await upload(src, source());
  const s = await openSheetFile(src);
  await s.dlg.getByRole("button", { name: "Cond. format" }).click();
  const panel = s.dlg.locator('[data-testid="cf-panel"]');
  const add = async (from: string, to: string, kind: string, setup?: () => Promise<void>) => {
    await s.cell(from).click(); await s.cell(to).click({ modifiers: ["Shift"] });
    await panel.getByLabel("Rule type").selectOption(kind); if (setup) await setup();
    await panel.getByRole("button", { name: "Add rule" }).click();
  };
  await add("A1", "A10", "bar", async () => {
    await panel.getByLabel("Bar axis").selectOption("middle");
    await panel.getByLabel("Negative bar colour").fill("#c00000");
    await panel.getByLabel("solid fill").check(); await panel.getByLabel("border", { exact: true }).check();
    await panel.getByLabel("Bar border colour").fill("#1f4e79");
  });
  // the 2007-only state of the bar options must not leak into the next rule kind
  await add("B1", "B10", "icons", async () => { await panel.getByLabel("Icon set").selectOption("3Stars"); await panel.getByLabel("icon only").uncheck(); });
  await add("C1", "C10", "icons", async () => {
    await panel.getByLabel("Icon set").selectOption("3Arrows");
    await panel.getByLabel("custom icons").check();
    await panel.getByLabel("Icon for band 1").selectOption("3Flags:0");
    await panel.getByLabel("Icon for band 2").selectOption("NoIcons:0");
    await panel.getByLabel("icon only").check();
  });
  eq(await panel.locator('[data-testid="cf-rule-label"]').allInnerTexts(), LABELS, "rule list labels");
  const shown = await drawn(s);
  // A: negatives draw left of the middle axis in the chosen negative colour; positives right of it
  ok(shown.A1.bar && /c00000|192, 0, 0/i.test(shown.A1.barStyle ?? ""), `A1 negative bar colour: ${shown.A1.barStyle}`);
  ok(shown.A8.bar && !/c00000|192, 0, 0/i.test(shown.A8.barStyle ?? ""), "A8 positive bar not in the negative colour");
  const [f1, t1] = shown.A1.bar!.split("-").map(Number), [f8] = shown.A8.bar!.split("-").map(Number);
  ok(Math.abs(t1 - 0.5) < 1e-3 && Math.abs(f8 - 0.5) < 1e-3, `middle axis: A1 ends at 0.5 (${t1}), A8 starts at 0.5 (${f8})`);
  // B: 3Stars (x14-only) glyphs; C: custom — lowest band red flag, middle band no icon, top band the set's up arrow; icon only
  ok(Object.entries(shown).filter(([k]) => k.startsWith("B")).every(([, v]) => /^star[012]:gold$/.test(v.icon ?? "")), "every B cell shows a star");
  eq([shown.C1.icon, shown.C5.icon, shown.C10.icon], ["flag:red", null, "arrowUp:green"], "custom icon bands (C1 low, C5 middle, C10 high)");
  // icon only: the value is hidden on screen but kept for screen readers (visually-hidden span, WCAG 1.3.1)
  const hidden = (ref: string) => s.cell(ref).evaluate((e) => [...e.querySelectorAll(".fs-visually-hidden")].map((h) => [h.textContent?.trim(), h.getBoundingClientRect().width <= 1]));
  eq(await hidden("C10"), [[`${iconLabel("arrowUp:green")}:`, true], ["9", true]], "icon only: the value is hidden visually (the icon label + value stay for screen readers)");
  eq(await hidden("B10"), [[`${iconLabel("star2:gold")}:`, true]], "3Stars (not icon only): only the icon label is screen-reader-only, the value stays visible");
  await s.page.screenshot({ path: join(SHOTS, "e2e66-x14.png") });
  await s.dlg.getByRole("button", { name: "Save workbook" }).click();
  await s.dlg.locator('[data-testid="sheet-status"]').filter({ hasText: "lossless" }).waitFor({ timeout: 15_000 });
  await s.close();
  const saved = await readBytes(src); const b = join(tmp, "saved.xlsx"); writeFileSync(b, saved);
  const rep = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_x14.py", b], { encoding: "utf8" }))[b]["xl/worksheets/sheet1.xml"];
  ok(rep.x14_valid.length && rep.x14_valid.every(Boolean), `x14 schema: ${rep.x14_errors}`); eq(rep.problems, [], "structural problems");
  eq(rep.main.map((m: { type: string; link: string | null }) => [m.type, !!m.link]), [["dataBar", true]], "only the bar has a 2007 fallback (linked)");
  eq(rep.x14.map((x: { type: string; sqref: string }) => [x.type, x.sqref]), [["dataBar", "A1:A10"], ["iconSet", "B1:B10"], ["iconSet", "C1:C10"]], "x14 rules");
  eq(rep.x14[0].bar.attrs, { minLength: "10", maxLength: "90", gradient: "0", border: "1", negativeBarColorSameAsPositive: "0", axisPosition: "middle" }, "bar x14 attributes");
  eq([rep.x14[0].bar.neg, rep.x14[0].bar.border], ["FFC00000", "FF1F4E79"], "bar colours");
  eq(rep.x14[2].icons.custom, [["3Flags", "0"], ["NoIcons", "0"], ["3Arrows", "2"]], "custom icons");
  eq(rep.x14[2].icons.attrs, { iconSet: "3Arrows", custom: "1", showValue: "0" }, "custom set attributes");
  const v = JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", b], { encoding: "utf8" }))[b];
  ok(v.ok, `ECMA XSD: ${JSON.stringify(v.parts).slice(0, 500)}`);
  const s2 = await openSheetFile(src);
  await s2.dlg.getByRole("button", { name: "Cond. format" }).click();
  eq(await s2.dlg.locator('[data-testid="cf-panel"] [data-testid="cf-rule-label"]').allInnerTexts(), LABELS, "reopened rule list");
  const again = await drawn(s2);
  eq(again, shown, "reopened workbook draws exactly the same bars, icons and texts");
  await s2.close();
});

await test("modal-shortcut failure test: keys pressed in the new CF controls (band icon select, bar axis select, colour inputs) never edit, clear or undo the grid cell", COV, async () => {
  const src = `/Documents/${RUN}-keys.xlsx`; await upload(src, source());
  const s = await openSheetFile(src);
  await s.dlg.getByRole("button", { name: "Cond. format" }).click();
  const panel = s.dlg.locator('[data-testid="cf-panel"]');
  await s.cell("B3").click();
  await panel.getByLabel("Rule type").selectOption("icons");
  await panel.getByLabel("custom icons").check();
  for (const l of [panel.getByLabel("Icon for band 1"), panel.getByLabel("Icon set")]) {
    await l.focus(); for (const k of ["Delete", "Backspace", "x", "Control+z", "Enter", "Escape"]) await s.page.keyboard.press(k);
  }
  await panel.getByLabel("Rule type").selectOption("bar");
  for (const l of [panel.getByLabel("Bar axis"), panel.getByLabel("Bar colour")]) {
    await l.focus(); for (const k of ["Delete", "Backspace", "q", "Control+z"]) await s.page.keyboard.press(k);
  }
  eq(await cellText(s.cell("B3")), "20", "B3 untouched");
  eq(await panel.locator('[data-testid="cf-rule-label"]').count(), 0, "no rule was added by Enter in a select");
  await s.cell("B3").click(); await s.page.keyboard.press("Delete");
  eq(await cellText(s.cell("B3")), "", "Delete on the grid still clears");
  await s.close();
});

await test("no uncaught page errors during the session", COV, async () => { await purge(); eq(errors, [], "page errors"); });

await browser.close();
await finish();
