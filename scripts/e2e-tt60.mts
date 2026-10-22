/**
 * TT60 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-40 Writer table revisions through the UI: Track Changes on → Row below / Delete row → change bars on the rows, the
 *         Review pane lists "[Table row]" changes, Column right is refused with a message, Ctrl+S → the saved bytes are
 *         checked by the independent lxml oracle (scripts/oracle/docx_tblrev.py), per-change Accept removes the row
 *   FF-41 Spreadsheet spelling in all sheets: F7 → "All sheets" → issues in tab order from the active sheet, Show cell
 *         switches sheets, Change All covers every sheet, openpyxl reads the saved workbook
 *   FF-42 Writer spelling in headers / footers / notes: F7 walks the body, then the header ("in Header") and the footnote;
 *         Change fixes inside the header run; the saved file is read by python-docx (docx_hf.py) and lxml (docx_notes.py)
 *   RG-05 battery awareness: navigator.getBattery() answers are injected by the test (no real battery in the sandbox) —
 *         Backup refuses a bundle at 12 % discharging and says so, "Build anyway" builds it; charging builds directly
 * Ground truth: saved bytes read back through /api/fs and parsed by lxml / python-docx — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt60.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t60${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e60-"));
const { test, finish } = makeHarness("e2e-tt60");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
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
import { blankWord, readWord, writeWord, allParas, rowsOf, cellsOf } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const oracle = (buf: Buffer) => { const f = join(tmp, `o${Date.now()}.docx`); writeFileSync(f, buf); return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", f], { encoding: "utf8" })); };

await test("FF-40 Writer table revisions in the UI: tracked Row below + Delete row → change bars + Review list; Column right refused; saved trPr ins/del verified by lxml; per-change Accept removes the row", { "FF-40": "full" }, async () => {
  const d = await blankWord("t"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Rows below.");
  const t = E.insertTableAfter(d, p0.id, 3, 2)!;
  rowsOf(t).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `R${ri}C${ci}`)));
  const path = `/Documents/${RUN}-rows.docx`;
  const up = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(await writeWord(d)).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  ok(up.status === 200, "upload");
  // the classic desktop (its right-click menu opens the modal used below); an earlier suite may have left the Tabletop on
  const views = (await api("GET", "/api/settings")).json.rows as { key: string; value: string }[];
  const prevView = views.find((r) => r.key === "appearance.desktopView")?.value ?? "classic";
  await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 30_000 });
  const body = dlg.getByTestId("writer-body"); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  await dlg.getByTestId("writer-track").click();
  await dlg.getByTestId("writer-track-chip").waitFor();
  const cell = (text: string) => body.locator("td").filter({ hasText: new RegExp(`^${text}$`) }).first();
  await cell("R0C0").click();
  await dlg.getByRole("button", { name: "Row below", exact: true }).click();
  await poll(async () => (await body.locator("tr.wrow-ins").count()) === 1, "inserted row has a change bar");
  await cell("R2C0").click();
  await dlg.getByRole("button", { name: "Delete row", exact: true }).click();
  await poll(async () => (await body.locator("tr.wrow-del").count()) === 1, "deleted row stays, marked");
  eq((await body.locator("tr.wrow-del .wrev-del").allInnerTexts()).map((s) => s.trim()), ["R2C0", "R2C1"], "the deleted row's text is struck through");
  eq(await body.locator("tr.wtr").count(), 4, "4 rows on screen (one pending deletion)");
  const items = dlg.getByTestId("writer-changes").locator("[role=listitem]");
  await poll(async () => (await items.filter({ hasText: "[Table row]" }).count()) === 2, "two row changes listed");
  // columns can't be tracked: refused with a message, grid unchanged
  await cell("R0C1").click();
  await dlg.getByRole("button", { name: "Column right", exact: true }).click();
  await page.getByTestId("toasts").filter({ hasText: "Column changes can't be tracked" }).waitFor({ timeout: 10_000 });
  eq(await body.locator("tr.wtr").first().locator("td").count(), 2, "still 2 columns");
  await page.screenshot({ path: "docs/screens/tt60-writer-table-revisions.png" });
  // modal-shortcut failure test: with the shell's modal ask dialog open, Writer shortcuts (Ctrl+Shift+E Track Changes,
  // F7 Spelling) must not reach the document behind it
  const bb = (await dlg.boundingBox())!; const mx = bb.x + bb.width + 60 < 1580 ? bb.x + bb.width + 60 : Math.max(20, bb.x - 60);
  await page.mouse.click(mx, 420, { button: "right" });
  await page.getByRole("menuitem", { name: /New text file/ }).click();
  const ask = page.locator(".fs-ask").first(); await ask.waitFor();
  await page.keyboard.press("Control+Shift+E"); await page.keyboard.press("F7"); await page.waitForTimeout(500);
  eq(await dlg.getByTestId("writer-spell-panel").count(), 0, "F7 inert behind the modal");
  eq(await dlg.getByTestId("writer-track-chip").count(), 1, "Track Changes not toggled behind the modal");
  await page.keyboard.press("Escape"); await ask.waitFor({ state: "detached" });
  await cell("R0C0").click();
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  let o = oracle(await read(path));
  ok(o.order_ok && o.ids_unique && o.opens === true, `schema ${o.order_errors} ids ${o.ids}`);
  eq(o.rows.map((r: { row: number; marks: { kind: string }[] }) => [r.row, r.marks.map((m) => m.kind)]), [[1, ["ins"]], [3, ["del"]]], "saved row marks");
  eq(o.accept, [[["R0C0", "R0C1"], ["", ""], ["R1C0", "R1C1"]]], "oracle accept view");
  eq(o.reject, [[["R0C0", "R0C1"], ["R1C0", "R1C1"], ["R2C0", "R2C1"]]], "oracle reject view");
  // accept only the row deletion: the row goes, the insertion stays pending
  await items.filter({ hasText: "Deleted" }).filter({ hasText: "[Table row]" }).first().getByRole("button", { name: /^Accept/ }).click();
  await poll(async () => (await body.locator("tr.wtr").count()) === 3 && (await body.locator("tr.wrow-del").count()) === 0 && (await body.locator("tr.wrow-ins").count()) === 1, "deleted row accepted");
  await body.locator("td").first().click();
  await page.keyboard.press("Control+s");
  await poll(async () => { o = oracle(await read(path)); return o.rows.length === 1; }, "saved after accept");
  eq(o.tables, [[["R0C0", "R0C1"], ["", ""], ["R1C0", "R1C1"]]], "python-docx table after accept");
  await page.context().close();
  await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
});

await test("FF-41 Spreadsheet spelling in all sheets: F7 → All sheets → tab order from the active sheet; Change switches to the issue's sheet; Change All covers every sheet; openpyxl reads the save", { "FF-41": "full" }, async () => {
  const wb = new Workbook(); const s1 = wb.sheet(); const s2 = wb.addSheet("Feb");
  s1.setCell(0, 0, "Recieved"); s1.setCell(1, 0, "fine");
  s2.setCell(0, 0, "Teh total"); s2.setCell(0, 1, "Recieved"); wb.recalculate();
  const orig = writeXlsxWorkbook(wb); const src = `/Documents/${RUN}-spellall.xlsx`;
  const up = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(orig).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(up.status < 300, `upload ${up.status}`);
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  // shortcut-scope test: Paste Special is a non-modal bar (the grid keeps the keyboard so the target can still move);
  // F7 then switches cleanly — Spelling replaces the bar, never two bars stacked, and nothing is pasted
  await cell("B1").click(); await page.keyboard.press("Control+c");
  await cell("C3").click(); await page.keyboard.press("Control+Shift+V");
  const ps = dlg.getByTestId("paste-special"); await ps.waitFor();
  await page.keyboard.press("F7");
  const panel = dlg.getByTestId("sheet-spell-panel"); await panel.waitFor();
  eq(await ps.count(), 0, "Paste Special closed when Spelling opened");
  eq((await cell("C3").innerText()).trim(), "", "nothing pasted");
  const status = panel.getByTestId("sheet-spell-status");
  await poll(async () => /1 of 1: Recieved in Sheet1!A1/.test(await status.innerText()), "active sheet only by default", 25_000);
  await panel.getByLabel("All sheets").check();
  await poll(async () => /Not in dictionary 1 of 3: Recieved in Sheet1!A1/.test(await status.innerText()), "3 issues across sheets");
  ok(/in all sheets/.test(await panel.innerText()), "title says all sheets");
  await panel.getByRole("button", { name: "Next", exact: true }).click();
  await poll(async () => /2 of 3: Teh in Feb!A1/.test(await status.innerText()), "next issue is on Feb");
  await poll(async () => /Feb!A1/.test(await dlg.getByRole("textbox", { name: /Name box/i }).inputValue().catch(() => "")) || (await cell("A1").innerText()).includes("Teh"), "Show cell switched to Feb");
  await page.screenshot({ path: "docs/screens/tt60-sheet-spell-all.png" });
  await panel.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => /Recieved/.test(await status.innerText()) && /of 2/.test(await status.innerText()), "Teh fixed; two Recieved left");
  await panel.getByLabel("Change to").fill("Received");
  await panel.getByRole("button", { name: "Change All", exact: true }).click();
  await poll(async () => /Spelling check complete/.test(await status.innerText()), "complete across sheets");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = new Uint8Array();
  await poll(async () => { saved = Uint8Array.from(await read(src)); return Buffer.compare(Buffer.from(saved), orig) !== 0; }, "saved bytes changed");
  await page.context().close();
  const f = join(tmp, "spellall.xlsx"); writeFileSync(f, saved);
  const o = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", "import json,sys,openpyxl; wb=openpyxl.load_workbook(sys.argv[1]); print(json.dumps([wb['Sheet1']['A1'].value, wb['Feb']['A1'].value, wb['Feb']['A2'].value]))", f], { encoding: "utf8" }).trim());
  eq(o, ["Received", "The total", "Received"], "openpyxl reads every sheet");
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: src });
});

await test("FF-42 Writer spelling in headers and notes: F7 lists body → Header → Footnote 1 issues; Change fixes them in place; saved file verified by python-docx and lxml", { "FF-42": "full" }, async () => {
  const fx = join(tmp, "stories.docx");
  execFileSync(PY, ["-c", `import docx
d = docx.Document(); d.add_paragraph("Body is fien.")
d.sections[0].header.paragraphs[0].add_run("Quarterly headr")
d.save("${fx}")`]);
  const d0 = await readWord(new Uint8Array(readFileSync(fx)));
  const bp = allParas(d0.blocks)[0]; E.insertNote(d0, { pid: bp.id, off: E.plen(bp) }, "footnote", "We recieve it.");
  const path = `/Documents/${RUN}-stories.docx`;
  const up = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(await writeWord(d0)).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  ok(up.status === 200, "upload");
  await putDesktop([]); const page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 30_000 });
  const body = dlg.getByTestId("writer-body"); await body.locator("p[data-pid]").first().waitFor({ timeout: 25_000 });
  await poll(async () => Number(await dlg.locator(".wdoc").getAttribute("data-spell-issues")) === 3, "3 issues (body + header + footnote)", 25_000);
  await body.locator("p[data-pid]").first().click(); await page.keyboard.press("Control+Home"); await page.keyboard.press("F7");
  const pane = dlg.getByTestId("writer-spell-panel"); await pane.waitFor();
  await poll(async () => /Issue 1 of 3/.test(await pane.getByTestId("spell-count").innerText()), "1 of 3");
  eq(await pane.getByTestId("spell-word").innerText(), "fien", "body first");
  await pane.getByLabel("Change to").fill("fine"); await pane.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => /Issue 1 of 2 . in Header/.test(await pane.getByTestId("spell-count").innerText()), "header issue next, labelled");
  eq(await pane.getByTestId("spell-word").innerText(), "headr", "header word");
  await page.screenshot({ path: "docs/screens/tt60-writer-spell-header.png" });
  await pane.getByLabel("Change to").fill("header"); await pane.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => /in Footnote 1/.test(await pane.getByTestId("spell-count").innerText()), "footnote issue next");
  await pane.getByLabel("Change to").fill("receive"); await pane.getByRole("button", { name: "Change", exact: true }).click();
  await poll(async () => /Spelling check complete/.test(await pane.getByTestId("spell-count").innerText()), "complete");
  await body.locator("p[data-pid]").first().click();
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const f = join(tmp, "stories-out.docx"); writeFileSync(f, await read(path));
  const hf = execFileSync(PY, ["scripts/oracle/docx_hf.py", f], { encoding: "utf8" });
  ok(hf.includes("Quarterly header"), "python-docx header: " + hf.slice(0, 300));
  const n = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_notes.py", f], { encoding: "utf8" }));
  eq(Object.values(n.notes.footnote), ["We receive it."], "lxml footnote");
  const body2 = execFileSync(PY, ["-c", "import docx,sys; print(docx.Document(sys.argv[1]).paragraphs[0].text)", f], { encoding: "utf8" }).trim();
  eq(body2, "Body is fine.", "body");
  await page.context().close();
});

async function batteryPage(level: number, charging: boolean): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  await ctx.addInitScript(([lv, ch]) => {
    Object.defineProperty(Navigator.prototype, "getBattery", { configurable: true, value: () => Promise.resolve({ level: lv, charging: ch, addEventListener() {} }) });
  }, [level, charging] as [number, boolean]);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
await test("RG-05 Backup refuses on a low discharging battery (injected getBattery 12%) with the reason, Build anyway works; Monitor shows background work paused; charging builds directly", { "RG-05": "full" }, async () => {
  await putDesktop([]);
  let page = await batteryPage(0.12, false);
  await page.goto(`${BASE}/?open=backup`, { waitUntil: "domcontentloaded" });
  let dlg = page.locator('[role=dialog][aria-label="Backup"]').first(); await dlg.waitFor({ timeout: 30_000 });
  await dlg.getByRole("button", { name: "Build data bundle" }).click();
  const held = dlg.getByTestId("backup-held"); await held.waitFor();
  ok(/12% and discharging/.test(await held.innerText()), "reason with the level: " + await held.innerText());
  ok(!/entries/.test(await dlg.innerText()), "nothing built yet");
  await page.screenshot({ path: "docs/screens/tt60-backup-battery.png" });
  await held.getByRole("button", { name: "Build anyway" }).click();
  await poll(async () => /\d+ entries/.test(await dlg.innerText()), "built after override", 30_000);
  ok((await held.count()) === 0, "notice cleared");
  await page.goto(`${BASE}/?open=monitor`, { waitUntil: "domcontentloaded" });
  const mon = page.locator('[role=dialog][aria-label="Monitor"]').first(); await mon.waitFor({ timeout: 30_000 });
  await poll(async () => /background work paused/.test(await mon.innerText()), "Monitor states the pause");
  // the stated reason is the battery unless the loaded 2-core sandbox pushed the frame cost into HOT, which outranks it
  ok(/Battery below 20%|ms, \d+ long tasks|above 34 ms|above 60 ms/.test(await mon.innerText()), "reason shown");
  await page.context().close();
  page = await batteryPage(0.12, true);
  await putDesktop([]);
  await page.goto(`${BASE}/?open=backup`, { waitUntil: "domcontentloaded" });
  dlg = page.locator('[role=dialog][aria-label="Backup"]').first(); await dlg.waitFor({ timeout: 30_000 });
  await dlg.getByRole("button", { name: "Build data bundle" }).click();
  await poll(async () => /\d+ entries/.test(await dlg.innerText()), "charging: built directly", 30_000);
  ok((await dlg.getByTestId("backup-held").count()) === 0, "no refusal while charging");
  await page.context().close();
});

await test("no uncaught page errors during the TT60 session", { "WM-05": "full" }, () => { eq(errors, [], "page errors"); });
await browser.close();
finish();
