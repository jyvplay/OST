/**
 * Real-browser suite "e2e-sheet-layout" (TT17): merged cells, borders, data validation (list dropdown, Stop/Warning
 * alerts, Circle invalid), frozen first column, sort refusal, and the full-stack .xlsx round trip
 * (UI → /api/sheet saveXlsxToVfs → VFS → reopen via importXlsx) — against a production build.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-sheet-layout.mts
 */
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-sheet-layout");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1600, h: 1000 }, icons: [], focusMode: false, revision: rev } });
}
const browser: Browser = await launchChromium();
const errors: string[] = [];
const dialogs: string[] = [];
type S = { page: Page; dlg: Locator; cell: (ref: string) => Locator; close: () => Promise<void> };
async function openSheet(path?: string): Promise<S> {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  await page.goto(`${BASE}/?open=sheet${path ? `&path=${encodeURIComponent(path)}` : ""}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
  await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  return { page, dlg, cell: (ref: string) => dlg.locator(`[data-cell="${ref}"]`), close: () => ctx.close() };
}
const text = async (l: Locator) => (await l.innerText()).trim();
const typeIn = async (s: S, ref: string, v: string) => { await s.cell(ref).click(); await s.page.keyboard.type(v); await s.page.keyboard.press("Enter"); };
const waitFor = async (f: () => Promise<boolean>, m: string, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(m); };

await test("Merge & Center: upper-left-most data kept after the Excel warning, one spanning cell, selection/arrow keys treat it as one; Unmerge restores cells", { "FF-33": "full" }, async () => {
  const s = await openSheet();
  try {
    await typeIn(s, "I10", "kept"); await typeIn(s, "J10", "lost");
    await s.cell("H10").click(); await s.cell("J10").click({ modifiers: ["Shift"] });
    await s.dlg.getByLabel("Merge", { exact: true }).selectOption("center");
    ok(dialogs.some((d) => /only keeps the upper-left value/.test(d)), `Excel warning not shown: ${dialogs}`);
    const m = s.cell("H10");
    eq(await m.getAttribute("colspan"), "3"); eq(await m.getAttribute("data-merge"), "H10:J10"); eq(await text(m), "kept", "upper-left most data moved to the anchor");
    eq(await s.cell("I10").count(), 0, "covered cells are not rendered"); eq(await m.evaluate((e) => getComputedStyle(e).textAlign), "center");
    eq((await s.dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!H10:J10");
    await s.page.keyboard.press("ArrowRight"); eq((await s.dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!K10", "leave from the far edge");
    await s.page.keyboard.press("ArrowLeft"); eq((await s.dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!H10:J10", "re-enter lands on the merge");
    await s.cell("G11").click(); await s.cell("I11").click({ modifiers: ["Shift"] });
    await s.cell("I9").click({ modifiers: ["Shift"] }); eq((await s.dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!G9:J11", "selection grows to include the whole merge");
    await s.cell("H10").click(); await s.dlg.getByLabel("Merge", { exact: true }).selectOption("unmerge");
    await waitFor(async () => (await s.cell("I10").count()) === 1, "unmerge did not restore I10");
    eq(await text(s.cell("I10")), "", "discarded value stays discarded"); eq(await text(s.cell("H10")), "kept");
  } finally { await s.close(); }
});

await test("Borders: Outside (medium, colour) draws the four perimeter edges via the neighbours' shared edges; Inside dotted; No Border clears", { "FF-34": "full" }, async () => {
  const s = await openSheet();
  try {
    await s.cell("H13").click(); await s.cell("I14").click({ modifiers: ["Shift"] });
    await s.dlg.getByLabel("Border line style").selectOption("medium");
    await s.dlg.getByLabel("Border colour").evaluate((el: HTMLInputElement) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(el, "#ff0000"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
    await s.dlg.getByLabel("Borders", { exact: true }).selectOption("outside");
    const edge = async (ref: string) => { const o = s.cell(ref).locator("[data-border]"); return (await o.count()) ? { k: await o.getAttribute("data-border"), w: await o.evaluate((e) => [getComputedStyle(e).borderRightWidth, getComputedStyle(e).borderBottomWidth, getComputedStyle(e).borderBottomColor]) } : null; };
    eq((await edge("H12"))?.k, "b", "top edge of H13 drawn as H12's bottom"); eq((await edge("H12"))?.w[2], "rgb(255, 0, 0)");
    eq((await edge("G13"))?.k, "r", "left edge via G13's right"); eq((await edge("I14"))?.k, "rb"); eq((await edge("I14"))?.w.slice(0, 2), ["2px", "2px"]);
    eq(await edge("H13"), null, "no interior edges yet");
    await s.dlg.getByLabel("Border line style").selectOption("dotted"); await s.dlg.getByLabel("Borders", { exact: true }).selectOption("inside");
    eq((await edge("H13"))?.k, "rb", "inside edges");
    await s.dlg.getByLabel("Borders", { exact: true }).selectOption("none");
    eq(await edge("H12"), null); eq(await edge("I14"), null);
  } finally { await s.close(); }
});

await test("Data validation: list dropdown picks a value; Stop rejects (rolled back, Retry/Cancel); Warning lets you keep it; Circle invalid flags it", { "FF-35": "full" }, async () => {
  const s = await openSheet();
  try {
    await s.cell("K10").click(); await s.cell("K14").click({ modifiers: ["Shift"] });
    await s.dlg.getByRole("button", { name: "Data validation" }).click();
    await s.dlg.getByLabel("List source").fill("Low,Medium,High"); await s.dlg.getByLabel("Input message").fill("pick a priority");
    await s.dlg.getByRole("button", { name: "Apply rule" }).click();
    await s.cell("K10").click();
    ok((await text(s.dlg.locator('[data-testid="input-prompt"]'))).includes("pick a priority"), "input message shown on select");
    await s.dlg.locator('[data-testid="list-arrow"]').click();
    eq(await s.dlg.locator('[data-testid="list-menu"] [role=option]').allInnerTexts(), ["Low", "Medium", "High"]);
    // Hit test: the option must be the topmost element at its own centre (a clipped menu — the bug visual
    // inspection found — still "exists" for Playwright, but elementFromPoint returns the cell underneath).
    for (const name of ["Low", "Medium", "High"]) {
      const box = (await s.dlg.locator('[data-testid="list-menu"] [role=option]', { hasText: name }).boundingBox())!;
      const hit = await s.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.textContent ?? "", [box.x + box.width / 2, box.y + box.height / 2]);
      eq(hit, name, `list option ${name} is not visible on top`);
    }
    await s.dlg.locator('[data-testid="list-menu"] [role=option]', { hasText: "Medium" }).click();
    eq(await text(s.cell("K10")), "Medium");
    await typeIn(s, "K11", "Huge");
    const alert = s.dlg.locator('[data-testid="dv-alert"]'); await alert.waitFor({ timeout: 4000 });
    eq(await alert.getAttribute("data-style"), "stop"); eq(await text(s.cell("K11")), "", "Stop: invalid entry rolled back");
    await alert.getByRole("button", { name: "Retry" }).click(); eq(await s.dlg.getByLabel("Cell editor").inputValue(), "Huge", "Retry reopens the editor with the entry");
    await s.page.keyboard.press("Escape");
    await typeIn(s, "K12", "high"); eq(await text(s.cell("K12")), "high", "list match is case-insensitive");
    // Warning rule on L10
    await s.cell("L10").click(); await s.dlg.getByLabel("Validation type").selectOption("whole");
    await s.dlg.getByLabel("Minimum or value").fill("1"); await s.dlg.getByLabel("Maximum").fill("10"); await s.dlg.getByLabel("Error style").selectOption("warning");
    await s.dlg.getByLabel("Input message").fill(""); await s.dlg.getByRole("button", { name: "Apply rule" }).click();
    await typeIn(s, "L10", "50"); await alert.waitFor({ timeout: 4000 }); eq(await alert.getAttribute("data-style"), "warning");
    await alert.getByRole("button", { name: "Yes" }).click(); eq(await text(s.cell("L10")), "50", "Warning: Yes keeps the entry");
    await s.dlg.getByRole("button", { name: "Circle invalid data" }).click();
    await waitFor(async () => (await s.cell("L10").locator("[data-invalid]").count()) === 1, "L10 not circled");
    eq(await s.cell("K10").locator("[data-invalid]").count(), 0, "valid cell not circled");
  } finally { await s.close(); }
});

await test("Freeze first column stays put on horizontal scroll; sorting a range with a merge is refused with Excel's message", { "FF-33": "full", "FF-28": "partial" }, async () => {
  const s = await openSheet();
  try {
    await s.dlg.getByRole("button", { name: "Freeze first column" }).click();
    const grid = s.dlg.locator('[data-testid="sheet-grid"]');
    const x0 = (await s.cell("A3").boundingBox())!.x;
    await grid.evaluate((e) => { e.scrollLeft = 900; e.dispatchEvent(new Event("scroll")); });
    await s.page.waitForTimeout(150);
    eq(Math.round((await s.cell("A3").boundingBox())!.x), Math.round(x0), "A3 is frozen");
    ok((await s.cell("D3").boundingBox())!.x < x0 + 100, "D3 scrolled away under the frozen column");
    await grid.evaluate((e) => { e.scrollLeft = 0; e.dispatchEvent(new Event("scroll")); });
    await s.cell("A3").click(); await s.cell("B3").click({ modifiers: ["Shift"] });
    await s.dlg.getByLabel("Merge", { exact: true }).selectOption("merge");
    await s.cell("A2").click(); await s.dlg.getByRole("button", { name: "Sort ascending by the active column" }).click();
    await waitFor(async () => /identically sized/.test(await text(s.dlg.locator('[data-testid="sheet-status"]'))), "sort was not refused");
  } finally { await s.close(); }
});

await test("Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader)", { "FF-33": "full", "FF-34": "full", "FF-35": "full", "FF-20": "full", "FF-21": "full" }, async () => {
  const s = await openSheet();
  let dest = "";
  try {
    await s.cell("H10").click(); await s.cell("J11").click({ modifiers: ["Shift"] }); await s.dlg.getByLabel("Merge", { exact: true }).selectOption("merge");
    await s.cell("L13").click(); await s.dlg.getByLabel("Borders", { exact: true }).selectOption("thickOutside");
    await s.cell("K10").click(); await s.dlg.getByRole("button", { name: "Data validation" }).click(); await s.dlg.getByLabel("List source").fill("Yes,No");
    await s.dlg.getByRole("button", { name: "Apply rule" }).click();
    await s.dlg.getByRole("button", { name: "Freeze first column" }).click();
    await s.dlg.getByRole("button", { name: "Export .xlsx" }).click();
    await waitFor(async () => /exported .* → /.test(await text(s.dlg.locator('[data-testid="sheet-status"]'))), "export failed", 10_000);
    dest = /→ (\S+\.xlsx)/.exec(await text(s.dlg.locator('[data-testid="sheet-status"]')))![1];
  } finally { await s.close(); }
  const r = await openSheet(dest);
  try {
    await waitFor(async () => (await r.cell("H10").getAttribute("data-merge")) === "H10:J11", "merge lost in the round trip", 10_000);
    eq(await r.cell("H10").getAttribute("rowspan"), "2");
    eq((await r.cell("L12").locator("[data-border]").getAttribute("data-border")), "b", "thick outside border lost");
    eq(await r.cell("L13").locator("[data-border]").evaluate((e) => getComputedStyle(e).borderRightWidth), "3px");
    await r.cell("K10").click(); await r.dlg.locator('[data-testid="list-arrow"]').click();
    eq(await r.dlg.locator('[data-testid="list-menu"] [role=option]').allInnerTexts(), ["Yes", "No"]);
    eq(await r.cell("A3").evaluate((e) => getComputedStyle(e).position), "sticky", "frozen column lost");
  } finally { await r.close(); }
});

await test("TT19 defined names: Name Box defines a name for the selection and jumps to it; formulas + autocomplete use it; Name Manager lists it; survives Export .xlsx → reopen", { "FF-36": "full", "FF-20": "partial" }, async () => {
  const s = await openSheet();
  let dest = "";
  const box = () => s.dlg.getByLabel("Name Box", { exact: true });
  const status = () => text(s.dlg.locator('[data-testid="sheet-status"]'));
  try {
    await typeIn(s, "B2", "5"); await typeIn(s, "B3", "7"); await typeIn(s, "B4", "9");
    await s.cell("B2").click(); await s.cell("B4").click({ modifiers: ["Shift"] });
    await box().click(); await box().fill("Tax Rate"); await box().press("Enter");
    await waitFor(async () => /Name Box: .*space/i.test(await status()), `invalid name not refused: ${await status()}`);
    await box().click(); await box().fill("Qty"); await box().press("Enter");
    await waitFor(async () => /defined Qty = .*!\$B\$2:\$B\$4/.test(await status()), `define failed: ${await status()}`);
    await waitFor(async () => (await box().inputValue()) === "Qty", "Name Box shows the name for a matching selection");
    await typeIn(s, "D2", "=SUM(Qty)*2");
    // the demo sheet formats column D as currency, so the displayed value may be "$42.00"
    await waitFor(async () => /^\$?42(\.00)?$/.test(await text(s.cell("D2"))), `SUM(Qty)*2 gave ${await text(s.cell("D2"))}`);
    await s.cell("D3").click(); await s.page.keyboard.type("=SUM(q");
    await s.dlg.locator('[data-testid="formula-assist"] [data-ac="Qty"]').waitFor({ timeout: 5000 });
    await s.page.keyboard.press("Escape");
    await s.cell("A1").click(); await box().click(); await box().fill("qty"); await box().press("Enter");
    await waitFor(async () => (await box().inputValue()) === "Qty", "typing a name (any case) selects its range");
    await s.dlg.getByRole("button", { name: /^Name Manager/ }).click();
    const row = s.dlg.locator('[data-testid="names-panel"] tr[data-name="Qty"]');
    await row.waitFor({ timeout: 5000 });
    eq(/\$B\$2:\$B\$4/.test(await row.innerText()), true, "Name Manager shows refers-to");
    await s.dlg.getByRole("button", { name: "Export .xlsx" }).click();
    await waitFor(async () => /exported .* → /.test(await status()), "export failed", 10_000);
    dest = /→ (\S+\.xlsx)/.exec(await status())![1];
  } finally { await s.close(); }
  const r = await openSheet(dest);
  try {
    await waitFor(async () => /^\$?42(\.00)?$/.test(await text(r.cell("D2"))), `name-based formula lost in the .xlsx round trip: ${await text(r.cell("D2"))}`, 10_000);
    const nb = r.dlg.getByRole("button", { name: /^Name Manager/ });
    eq((await nb.innerText()).trim(), "Names (1)", "reopened workbook carries exactly one name");
    await nb.click();
    await r.dlg.locator('[data-testid="names-panel"] tr[data-name="Qty"]').waitFor({ timeout: 5000 });
    await r.dlg.locator('[data-testid="names-panel"] tr[data-name="Qty"]').getByRole("button", { name: "Delete" }).click();
    await waitFor(async () => (await text(r.cell("D2"))) === "#NAME?", "deleting the name gives #NAME?");
  } finally { await r.close(); }
});

await test("no page errors during the layout session", { "FF-33": "partial" }, () => { ok(errors.length === 0, errors.join(" | ")); });
await browser.close();
finish();
