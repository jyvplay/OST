/**
 * Real-browser suite for the Spreadsheet v2 UI (TT15): Playwright + headless
 * Chromium against a running production server. Every assertion reads the
 * rendered DOM after real mouse/keyboard input (no component internals).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-office.mts
 */
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `x${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-office");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openSheet(path?: string): Promise<{ page: Page; dlg: Locator; cell: (ref: string) => Locator; close: () => Promise<void> }> {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet${path ? `&path=${encodeURIComponent(path)}` : ""}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
  await dlg.waitFor({ state: "visible", timeout: 20_000 });
  // maximise for room: double-click the title bar if supported; otherwise just use the default rect
  await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 20_000 });
  const cell = (ref: string) => dlg.locator(`[data-cell="${ref}"]`);
  return { page, dlg, cell, close: () => ctx.close() };
}
const text = async (l: Locator) => (await l.innerText()).trim();

await test("sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet", { "FF-28": "full", "FF-26": "partial", "FF-19": "partial" }, async () => {
  const { dlg, cell, close } = await openSheet();
  eq(await text(cell("D2")), "$28.50"); eq(await text(cell("D5")), "$79.00");
  eq([await text(cell("F2")), await text(cell("F3")), await text(cell("F4"))], ["Widget", "Gadget", "Gizmo"], "SORTBY spill");
  eq(await cell("F3").getAttribute("title"), "spilled from F2");
  ok((await cell("F2").evaluate((e) => getComputedStyle(e).borderTopStyle)) === "dashed", "spill outline");
  ok(/rgb\(/.test(await cell("D2").evaluate((e) => getComputedStyle(e).backgroundColor)) && (await cell("D2").evaluate((e) => getComputedStyle(e).backgroundColor)) !== "rgba(0, 0, 0, 0)", "colour-scale fill on D2");
  await dlg.getByRole("button", { name: "TaxRate" }).click();
  eq(await text(cell("B1")), "8.0%");
  await close();
});

await test("autocomplete (Tab inserts NAME( ), point-mode click inserts a reference, Enter commits and recalculates", { "FF-28": "full" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  await cell("A10").click();
  await page.keyboard.type("=SU");
  const assist = dlg.locator('[data-testid="formula-assist"]');
  await assist.waitFor({ timeout: 5000 });
  ok(await assist.locator('[data-ac="SUM"]').count() === 1, "SUM offered");
  await page.keyboard.press("Tab");
  eq(await dlg.getByLabel("Cell editor").inputValue(), "=SUM(");
  ok((await text(dlg.locator('[data-testid="arg-hint"]'))).startsWith("SUM(number1"), "argument hint");
  await cell("B2").click(); // point mode
  eq(await dlg.getByLabel("Cell editor").inputValue(), "=SUM(B2");
  await page.keyboard.type(":B4)"); await page.keyboard.press("Enter");
  eq(await text(cell("A10")), "10");
  eq((await dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!A11");
  await close();
});

await test("drag-select a range → status bar Sum/Count; Ctrl+A selects current region", { "FF-28": "full" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  await cell("B2").hover(); await page.mouse.down(); await cell("B4").hover(); await page.mouse.up();
  eq((await dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!B2:B4");
  eq(await text(dlg.locator('[data-testid="stat-sum"]')), "10"); eq(await text(dlg.locator('[data-testid="stat-count"]')), "3");
  await cell("B3").click(); await page.keyboard.press("Control+a");
  eq((await dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!A1:D5");
  await close();
});

await test("fill handle drag extends 'Item 1' as a series; Ctrl+D copies a formula down with shifted refs", { "FF-28": "full" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  await cell("A12").click(); await page.keyboard.type("Item 1"); await page.keyboard.press("Enter");
  await cell("A12").click();
  const h = dlg.locator('[data-testid="fill-handle"]'); const hb = (await h.boundingBox())!;
  await page.mouse.move(hb.x + 3, hb.y + 3); await page.mouse.down();
  await cell("A13").hover(); await cell("A14").hover(); await page.mouse.up();
  eq([await text(cell("A13")), await text(cell("A14"))], ["Item 2", "Item 3"]);
  await cell("D4").hover(); await page.mouse.down(); await cell("D4").hover(); await page.mouse.up();
  await cell("E2").click(); await page.keyboard.type("=B2*2"); await page.keyboard.press("Enter");
  await cell("E2").click(); await page.keyboard.down("Shift"); await cell("E4").click(); await page.keyboard.up("Shift");
  await page.keyboard.press("Control+d");
  eq([await text(cell("E3")), await text(cell("E4"))], ["4", "10"]);
  await close();
});

await test("Ctrl+B bold → Ctrl+Z undo → Ctrl+Y redo; toolbar number format; fill colour", { "FF-28": "full" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  await cell("A3").click(); await page.keyboard.press("Control+b");
  eq(await cell("A3").evaluate((e) => getComputedStyle(e).fontWeight), "700");
  await page.keyboard.press("Control+z");
  eq(await cell("A3").evaluate((e) => getComputedStyle(e).fontWeight), "400");
  await page.keyboard.press("Control+y");
  eq(await cell("A3").evaluate((e) => getComputedStyle(e).fontWeight), "700");
  await cell("C2").click();
  await dlg.getByLabel("Number format").selectOption("0%");
  eq(await text(cell("C2")), "950%");
  await cell("B3").click();
  await dlg.getByLabel("Fill colour").evaluate((el: HTMLInputElement) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(el, "#336699"); el.dispatchEvent(new Event("input", { bubbles: true })); });
  eq(await cell("B3").evaluate((e) => getComputedStyle(e).backgroundColor), "rgb(51, 102, 153)");
  await close();
});

await test("clipboard: Ctrl+C / Ctrl+V pastes formula with shifted refs + style; external TSV paste fills a block", { "FF-28": "full" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  await cell("D2").click(); await page.keyboard.press("Control+c");
  await cell("E2").click(); await page.keyboard.press("Control+v");
  eq(await text(cell("E2")), "$270.75"); // =C2*D2 = 9.5 × 28.5, currency style carried
  await cell("H10").click();
  await dlg.locator('[data-testid="sheet-grid"]').evaluate((grid) => {
    const dt = new DataTransfer(); dt.setData("text/plain", "1\t2\r\n3\t=H10+I10\r\n");
    grid.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  eq([await text(cell("H10")), await text(cell("I10")), await text(cell("H11")), await text(cell("I11"))], ["1", "2", "3", "3"]);
  eq((await dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!H10:I11");
  await close();
});

await test("sort by active column keeps header + moves row formulas; insert row repairs SUM; find selects match", { "FF-28": "full" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  await cell("C3").click();
  await dlg.getByRole("button", { name: "Sort ascending by the active column" }).click();
  eq([await text(cell("A2")), await text(cell("A3")), await text(cell("A4")), await text(cell("C5"))], ["Gizmo", "Widget", "Gadget", "Sum"]);
  eq(await text(cell("D2")), "$22.00"); eq(await text(cell("A1")), "Item");
  await cell("A3").click();
  await dlg.getByRole("button", { name: "Insert rows above selection" }).click();
  eq(await text(cell("A3")), ""); eq(await text(cell("D6")), "$79.00");
  await page.keyboard.press("Control+f");
  await dlg.getByLabel("Find", { exact: true }).fill("gadget"); await dlg.getByLabel("Find", { exact: true }).press("Enter");
  eq((await dlg.locator('[data-testid="name-box"]').inputValue()), "Sheet1!A5");
  await close();
});

await test("charts panel renders SVG chart images (bar → pie) from a dynamic-array source", { "FF-29": "full" }, async () => {
  const { dlg, close } = await openSheet();
  await dlg.getByRole("button", { name: "Show charts" }).click();
  const img = dlg.locator('[data-testid="charts-panel"] img').first();
  await img.waitFor({ timeout: 5000 });
  ok(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), "chart image decoded");
  eq(await img.getAttribute("alt"), "Total by item");
  await dlg.getByLabel("Chart type").selectOption("pie");
  ok(decodeURIComponent((await img.getAttribute("src")) ?? "").includes("<path"), "pie slices drawn");
  await close();
});

await test("column resize by dragging the header edge; frozen header row stays visible; rows are virtualised", { "FF-28": "full" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  const before = (await cell("A2").boundingBox())!.width;
  const hb = (await dlg.locator('[data-testid="resize-A"]').boundingBox())!;
  await page.mouse.move(hb.x + 3, hb.y + 5); await page.mouse.down(); await page.mouse.move(hb.x + 63, hb.y + 5, { steps: 4 }); await page.mouse.up();
  const after = (await cell("A2").boundingBox())!.width;
  ok(Math.abs(after - before - 60) <= 2, `width ${before} → ${after}`);
  const grid = dlg.locator('[data-testid="sheet-grid"]');
  // TT21: rows grow with the text size, so scroll by measured rows (was a fixed 15000px = row ~680 at 22px rows)
  const rowH = (await cell("A2").boundingBox())!.height;
  await grid.evaluate((g, y) => { g.scrollTop = y; g.dispatchEvent(new Event("scroll")); }, Math.round(680 * rowH));
  await page.waitForTimeout(300);
  const gb = (await grid.boundingBox())!; const ab = (await cell("A1").boundingBox())!;
  ok(ab.y >= gb.y && ab.y < gb.y + 60, `frozen A1 visible (A1 y=${ab.y}, grid y=${gb.y})`);
  ok(await cell("A682").count() === 1, "rows near scroll position are rendered");
  ok(await cell("A5").count() === 0, "rows far above are not in the DOM");
  ok(await dlg.locator("td[data-cell]").count() < 52 * 90, "bounded DOM size");
  await close();
});

await test("save → reopen keeps styles/widths/charts; export .xlsx → server re-import keeps bold, numFmt, widths", { "FF-28": "full", "FF-20": "partial", "FF-21": "partial" }, async () => {
  const { page, dlg, cell, close } = await openSheet();
  await cell("A3").click(); await page.keyboard.press("Control+i");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  await dlg.locator('[data-testid="sheet-status"]').filter({ hasText: "saved" }).waitFor({ timeout: 10_000 });
  const saved = (await text(dlg.locator('[data-testid="sheet-status"]'))).replace(/^saved /, "");
  await dlg.getByRole("button", { name: "Export .xlsx" }).click();
  await dlg.locator('[data-testid="sheet-status"]').filter({ hasText: "exported" }).waitFor({ timeout: 10_000 });
  const xlsxPath = /(?:→| to) (\S+\.xlsx)/.exec(await text(dlg.locator('[data-testid="sheet-status"]')))![1];
  await close();
  const re = await api("POST", "/api/sheet", { op: "importXlsx", path: xlsxPath });
  ok(re.json.ok, JSON.stringify(re.json).slice(0, 200));
  const s1 = re.json.workbook.sheets[0]; const by = (ref: string) => s1.cells.find((c: { ref: string }) => c.ref === ref);
  eq(by("A1").style?.bold, true); eq(by("D2").style?.numFmt, "$#,##0.00"); eq(by("A3").style?.italic, true);
  eq(by("F2").input, "=SORTBY(A2:A4,D2:D4,-1)"); ok(!by("F3"), "spill child not materialised on re-import");
  eq(s1.colWidths?.["0"], 110); eq(s1.freezeRows, 1);
  const again = await openSheet(saved);
  eq(await again.cell("A3").evaluate((e) => getComputedStyle(e).fontStyle), "italic");
  eq(await text(again.cell("D5")), "$79.00");
  await again.dlg.getByRole("button", { name: /Show charts|Charts \(1\)/ }).click();
  ok(await again.dlg.locator('[data-testid="charts-panel"] img').count() === 1, "chart persisted");
  await again.close();
  await api("POST", "/api/fs", { op: "purge", path: saved }); await api("POST", "/api/fs", { op: "purge", path: xlsxPath });
});

await test("no uncaught page errors during the spreadsheet session", { "FF-28": "partial" }, () => { eq(errors, []); });

await browser.close();
void RUN;
finish();
