/**
 * TT74 real-browser suite (Playwright + headless Chromium 143 against the production server): Spreadsheet hide /
 * AutoFilter, CSV export / import, Writer Markdown export / import, Slides outline export. Real clicks, real file
 * inputs, real browser downloads; saved packages are read back by openpyxl.
 *  1. AutoFilter through the header ▾ list: unticking a value hides its rows (not rendered), SUBTOTAL 9 / 109 follow
 *     Excel; Hide rows hides by hand (109 changes, 9 does not); arrow keys skip hidden rows; Save → openpyxl sees the
 *     hidden rows and the AutoFilter with its value list; Unhide shows hand-hidden rows only; Clear shows the rest
 *  2. modal shortcut: while the filter list is open, typing / Delete / Ctrl+V / Enter-less keys never edit the cell behind
 *     it; Escape closes it and the grid gets the keyboard back
 *  3. Export CSV shows the loss report in the export dialog; OK downloads the displayed text; Cancel downloads nothing;
 *     Import CSV adds a sheet with Excel typing and keeps a formula-like field as text
 *  4. Writer → Markdown download (heading, bold, list) and From Markdown → a new document with the converted content
 *  5. Slides → Outline download (slide titles, bullets, notes)
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt74-office.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t74o${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt74-office");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e74o-"));
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const upload = async (path: string, bytes: Uint8Array, mime: string) => { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(r.status < 300, `upload ${path} ${r.status}`); };
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };
const py = (code: string, ...args: string[]) => JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", code, ...args], { encoding: "utf8" }));

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function open(app: string, path: string, label: string): Promise<{ page: Page; dlg: Locator }> {
  await putDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=${app}&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator(`[role=dialog][aria-label="${label}"]`).first(); await dlg.waitFor({ state: "visible", timeout: 25_000 });
  return { page, dlg };
}
/** click `trigger`, accept the export dialog (checking its loss text), and return the downloaded text */
async function exportVia(page: Page, trigger: Locator, name: string, lossRe: RegExp): Promise<{ text: string; detail: string }> {
  await trigger.click();
  const ask = page.getByTestId("ask-dialog"); await ask.waitFor();
  const detail = (await ask.locator(".fs-ask-detail").innerText().catch(() => "")) ?? "";
  ok(lossRe.test(detail), `export dialog detail: ${JSON.stringify(detail)}`);
  await ask.getByTestId("ask-input-name").fill(name);
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), ask.getByTestId("ask-ok").click()]);
  eq(dl.suggestedFilename(), name, "download name");
  const f = join(tmp, `${Date.now()}-${name}`); await dl.saveAs(f);
  return { text: readFileSync(f, "utf8"), detail };
}

/* ------------------------------------------------------------------ 1 + 2: hide / AutoFilter */
const wb = new Workbook(); const sh = wb.sheet();
sh.setCell(0, 0, "n"); sh.setCell(1, 0, "k");
["10", "20", "30", "40", "50"].forEach((v, i) => sh.setCell(0, i + 1, v)); ["a", "b", "a", "c", "a"].forEach((v, i) => sh.setCell(1, i + 1, v));
sh.setCell(3, 0, "=SUBTOTAL(109,A2:A6)"); sh.setCell(3, 1, "=SUBTOTAL(9,A2:A6)"); wb.recalculate();
const xbytes = writeXlsxWorkbook(wb); const xsrc = `/Documents/${RUN}-filter.xlsx`;
const XMIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let sheetPage: Page; let sheetDlg: Locator;

await test("AutoFilter list hides rows (SUBTOTAL 9 and 109 skip them), Hide rows hides by hand (only 109 skips), arrows skip hidden rows; Save → openpyxl sees hidden rows + the filter; Unhide shows hand-hidden rows only; Clear shows the rest", { "FF-53": "full", "FF-54": "full", "FF-21": "partial" }, async () => {
  await upload(xsrc, xbytes, XMIME);
  ({ page: sheetPage, dlg: sheetDlg } = await open("sheet", xsrc, "Spreadsheet"));
  const page = sheetPage, dlg = sheetDlg;
  await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const txt = async (r: string) => (await cell(r).innerText()).trim();
  await poll(async () => (await txt("D1")) === "150", "SUBTOTALs computed", 20_000);
  await cell("A2").click(); await dlg.getByTestId("sheet-filter").click();
  await dlg.getByTestId("filter-btn-B").click();
  const panel = dlg.getByTestId("filter-panel"); await panel.waitFor();
  eq(await panel.locator("[data-filter-value]").evaluateAll((ls) => ls.map((l) => l.getAttribute("data-filter-value"))), ["a", "b", "c"], "value list");
  await panel.locator('[data-filter-value="c"] input').uncheck(); await panel.getByTestId("filter-ok").click();
  await poll(async () => (await cell("A5").count()) === 0, "row 5 hidden (not rendered)");
  await poll(async () => (await txt("D1")) === "110" && (await txt("D2")) === "110", "SUBTOTAL 109 / 9 after the filter");
  eq(await dlg.getByTestId("filter-btn-B").getAttribute("aria-pressed"), "true", "the filtered column's button shows it is active");
  await cell("A3").click(); await dlg.getByTestId("sheet-hide-rows").click();
  await poll(async () => (await cell("A3").count()) === 0, "row 3 hidden");
  await poll(async () => (await txt("D1")) === "90" && (await txt("D2")) === "110", "109 skips the hand-hidden row, 9 does not");
  const nameBox = () => dlg.getByRole("textbox", { name: /Name box/i }).inputValue().then((v) => v.replace(/^.*!/, ""));
  await cell("A2").click(); await page.keyboard.press("ArrowDown"); eq(await nameBox(), "A4", "ArrowDown skips hidden row 3");
  await page.keyboard.press("ArrowDown"); eq(await nameBox(), "A6", "ArrowDown skips filtered row 5");
  await page.keyboard.press("ArrowUp"); eq(await nameBox(), "A4", "ArrowUp skips row 5");
  await page.screenshot({ path: "docs/screens/tt74-sheet-filter.png" });
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = Buffer.alloc(0);
  await poll(async () => { saved = await read(xsrc); return Buffer.compare(saved, Buffer.from(xbytes)) !== 0; }, "saved bytes changed");
  const f = join(tmp, "saved.xlsx"); writeFileSync(f, saved);
  const o = py(`import openpyxl,sys,json
ws=openpyxl.load_workbook(sys.argv[1]).active
af=ws.auto_filter
print(json.dumps({"rows":sorted(r for r,d in ws.row_dimensions.items() if d.hidden),"ref":af.ref,"vals":[sorted(fc.filters.filter) for fc in af.filterColumn],"ids":[fc.colId for fc in af.filterColumn]}))`, f);
  eq(o, { rows: [3, 5], ref: "A1:B6", vals: [["a", "b"]], ids: [1] }, "openpyxl");
  await cell("A2").click(); await dlg.getByTestId("sheet-unhide").click();
  await poll(async () => (await cell("A3").count()) === 1, "row 3 back");
  ok((await cell("A5").count()) === 0, "Unhide must not show the filtered row");
  await dlg.getByTestId("filter-btn-B").click(); await dlg.getByTestId("filter-clear").click();
  await poll(async () => (await cell("A5").count()) === 1 && (await txt("D1")) === "150", "Clear shows every row");
});

await test("modal shortcut: with the filter list open, typing, Delete, Backspace, Ctrl+V / Z / X never edit the cell behind it; Escape closes the list and the grid has the keyboard again", { "FF-53": "full" }, async () => {
  const page = sheetPage, dlg = sheetDlg;
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const txt = async (r: string) => (await cell(r).innerText()).trim();
  await cell("B3").click(); await page.keyboard.press("Control+c");
  await cell("A4").click(); const before = await txt("A4");
  await dlg.getByTestId("filter-btn-B").click(); const panel = dlg.getByTestId("filter-panel"); await panel.waitFor();
  ok(await panel.evaluate((el) => el.contains(document.activeElement)), "the list takes the keyboard when it opens");
  await page.keyboard.type("zz9");
  for (const k of ["Delete", "Backspace", "Control+v", "Control+z", "Control+x", "F2"]) await page.keyboard.press(k);
  await page.waitForTimeout(300);
  eq(await txt("A4"), before, "A4 unchanged");
  ok(await panel.isVisible(), "list still open");
  await page.keyboard.press("Escape");
  await poll(async () => !(await panel.isVisible()), "Escape closes the list");
  ok(await dlg.getByTestId("sheet-grid").evaluate((el) => el.contains(document.activeElement)), "grid has the keyboard back");
  await page.keyboard.press("ArrowDown"); eq(await dlg.getByRole("textbox", { name: /Name box/i }).inputValue().then((v) => v.replace(/^.*!/, "")), "A5", "arrows work again");
});

/* ------------------------------------------------------------------ 3: CSV */
await test("Export CSV: the dialog lists what CSV drops; OK downloads the displayed text of the used range; Cancel downloads nothing; Import CSV adds a typed sheet and keeps =… as text", { "FF-02": "full", "FF-55": "full" }, async () => {
  const page = sheetPage, dlg = sheetDlg;
  const { text } = await exportVia(page, dlg.getByTestId("sheet-export-csv"), `${RUN}.csv`, /drops|formulas|formatting|sheet/i);
  eq(text.split("\r\n").slice(0, 3), ["n,k,,150", "10,a,,150", "20,b,,"], "CSV rows (CRLF, displayed values, used range)");
  // cancel → no download
  let got = false; page.once("download", () => { got = true; });
  await dlg.getByTestId("sheet-export-csv").click(); await page.getByTestId("ask-dialog").waitFor(); await page.getByTestId("ask-cancel").click();
  await page.waitForTimeout(1500); ok(!got, "Cancel must not download");
  const csv = join(tmp, "people.csv"); writeFileSync(csv, 'name,joined,score,note\r\nAda,1/2/2024,007,"=HYPERLINK(""http://x"")"\r\nBo,3/4/2024,12.5,plain\r\n');
  await dlg.getByTestId("sheet-import-csv").setInputFiles(csv);
  await poll(async () => (await dlg.getByRole("tab", { name: /people/ }).count()) > 0 || (await dlg.locator("text=people").count()) > 0, "new sheet tab");
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  await poll(async () => (await cell("A2").innerText()).trim() === "Ada", "imported values");
  eq([(await cell("C2").innerText()).trim(), (await cell("D2").innerText()).trim()], ["7", '=HYPERLINK("http://x")'], "Excel typing + formula guard");
  await page.screenshot({ path: "docs/screens/tt74-sheet-csv.png" });
});

/* ------------------------------------------------------------------ 4: Writer Markdown */
await test("Writer: Export Markdown downloads heading / bold / list Markdown after the loss dialog; From Markdown opens a new document with the converted heading and list", { "FF-02": "full", "FF-56": "full", "FF-22": "partial" }, async () => {
  const f = join(tmp, "w.docx");
  execFileSync(PY, ["-c", `import docx,sys
d=docx.Document(); d.add_heading("Quarterly plan",1)
p=d.add_paragraph("Ship the "); p.add_run("beta").bold=True; p.add_run(" by Friday.")
d.add_paragraph("first item", style="List Bullet"); d.add_paragraph("second item", style="List Bullet")
d.save(sys.argv[1])`, f]);
  const src = `/Documents/${RUN}-w.docx`; await upload(src, new Uint8Array(readFileSync(f)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { page, dlg } = await open("writer", src, "Writer");
  await dlg.locator('[data-testid="writer-body"] [data-pid]').first().waitFor({ timeout: 25_000 });
  const { text } = await exportVia(page, dlg.getByTestId("writer-export-md"), `${RUN}.md`, /drops|Nothing is dropped/i);
  ok(/^# Quarterly plan$/m.test(text) && text.includes("**beta**") && /^[-*] first item$/m.test(text) && /^[-*] second item$/m.test(text), `markdown ${JSON.stringify(text)}`);
  const md = join(tmp, "in.md"); writeFileSync(md, "# Imported title\n\nSome *emphasis* here.\n\n1. one\n2. two\n\n<span>raw</span>\n");
  await dlg.getByTestId("writer-md-file").setInputFiles(md);
  const body = dlg.getByTestId("writer-body");
  await poll(async () => (await body.innerText()).includes("Imported title"), "imported document shown");
  const t = await body.innerText(); ok(t.includes("one") && t.includes("two") && t.includes("emphasis"), `body ${JSON.stringify(t.slice(0, 300))}`);
  ok(await dlg.getByTestId("writer-status").innerText().then((s) => /Converted in\.md/.test(s) && /raw HTML/.test(s)), "status reports the conversion and the raw-HTML loss");
  await page.screenshot({ path: "docs/screens/tt74-writer-md.png" });
  await page.context().close();
});

/* ------------------------------------------------------------------ 5: Slides outline */
await test("Slides: Outline downloads the deck's titles, bullets and notes as Markdown after the loss dialog", { "FF-02": "full", "FF-57": "full", "FF-23": "partial" }, async () => {
  const f = join(tmp, "d.pptx");
  execFileSync(PY, ["-c", `import pptx,sys
p=pptx.Presentation()
s=p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text="Roadmap"; s.placeholders[1].text_frame.text="Alpha"; s.placeholders[1].text_frame.add_paragraph().text="Beta"
s.notes_slide.notes_text_frame.text="say hello"
s2=p.slides.add_slide(p.slide_layouts[0]); s2.shapes.title.text="Thanks"
p.save(sys.argv[1])`, f]);
  const src = `/Documents/${RUN}-d.pptx`; await upload(src, new Uint8Array(readFileSync(f)), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const { page, dlg } = await open("slides", src, "Slides");
  await dlg.locator('[role=listbox][aria-label="Slides"] [role=option]').first().waitFor({ timeout: 25_000 });
  const { text } = await exportVia(page, dlg.getByTestId("slides-export-outline"), `${RUN}.md`, /drops|positions|layouts/i);
  ok(/Roadmap/.test(text) && /Alpha/.test(text) && /Beta/.test(text) && /say hello/.test(text) && /Thanks/.test(text), `outline ${JSON.stringify(text)}`);
  ok(text.indexOf("Roadmap") < text.indexOf("Thanks"), "slide order");
  await page.context().close();
});

await test("no page errors during the suite", { "FF-02": "partial" }, async () => { ok(!errors.length, errors.slice(0, 5).join(" | ")); });
await browser.close();
finish();
