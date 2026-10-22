/**
 * TT57 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   FF-22 Writer format-change tracking: tracking on → Ctrl+B → review panel lists "Formatted: Bold" → saved bytes
 *         carry w:rPrChange (lxml oracle) → Reject in the panel → saved run is plain again
 *   FF-21 Spreadsheet hyperlinks: Ctrl+K web link + ScreenTip, in-workbook place link with display text, Ctrl+click
 *         follows the place link, invalid address refused, Escape closes only the panel (modal-shortcut failure test),
 *         Save → openpyxl reads the hyperlinks back from the saved .xlsx
 * Ground truth: saved bytes read by lxml / openpyxl, the server file store — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt57.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";
import { blankWord, writeWord, allParas } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t57${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e57-"));
const { test, finish } = makeHarness("e2e-tt57");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
const focusByTitle = async (page: Page, t: string) => {
  await page.locator(`.fs-window[aria-label="${t}"] .fs-titlebar`).first().click({ position: { x: 60, y: 8 } });
};
const options = async (page: Page) => (await page.getByTestId("switcher-list").locator("[role=option] > div:first-child").allTextContents()).map((s) => s.trim());
const selected = async (page: Page) => page.getByTestId("switcher-list").locator('[role=option][aria-selected="true"]').getAttribute("data-key");


await test("FF-22 Writer format tracking in the UI: Ctrl+B with tracking on → 'Formatted: Bold' listed, saved as w:rPrChange; Reject restores plain text; Align centre → 'Paragraph: Centered' → w:pPrChange → Accept (lxml oracle)", { "FF-22": "full" }, async () => {
  const d = await blankWord("t"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Alpha beta gamma.");
  const path = `/Documents/${RUN}-fmt.docx`;
  const up = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(await writeWord(d)).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  ok(up.status === 200, "upload");
  await putDesktop([]);
  const page = await newPage();
  await page.goto(`${BASE}/?open=writer&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Writer"]').first(); await dlg.waitFor({ timeout: 25_000 });
  const body = dlg.getByTestId("writer-body"); await body.locator("[data-pid]").first().waitFor({ timeout: 25_000 });
  await dlg.getByRole("button", { name: "Review", exact: true }).click();
  await dlg.getByTestId("writer-track").click();
  await dlg.getByTestId("writer-track-chip").waitFor();
  const para = body.locator("p[data-pid]").first();
  await para.click(); await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+b");
  await poll(async () => (await body.locator(".wrev-fmt").count()) >= 1, "formatted run marked");
  eq((await body.locator(".wrev-fmt").first().textContent())?.trim(), "beta", "the marked run is the formatted word");
  const items = dlg.getByTestId("writer-changes").locator("[role=listitem]");
  await poll(async () => (await items.count()) === 1, "one change listed");
  eq((await items.first().getByTestId("writer-change-detail").textContent())?.trim(), ": Bold", "detail names the property");
  await page.screenshot({ path: "docs/screens/tt57-writer-fmt.png" });
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const read = async () => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };
  const oracle = (buf: Buffer) => { const f = join(tmp, `o${Date.now()}.docx`); writeFileSync(f, buf); return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_track.py", f], { encoding: "utf8" })); };
  const author = String((await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === "profile.name")?.value ?? "Fusion user");
  let o = oracle(await read());
  eq(o.revs.map((r: { kind: string; text: string; author: string }) => [r.kind, r.text, r.author]), [["fmt", "beta", author]], "saved: one rPrChange on 'beta'");
  // run segments: [text, b, i, u, strike, sz, color]
  const bold = (runs: unknown[][]) => runs.filter((r) => r[1]).map((r) => r[0]);
  eq(bold(o.accept_runs), ["beta"], "oracle accept view: beta bold");
  eq(bold(o.reject_runs), [], "oracle reject view: nothing bold");
  await items.first().getByRole("button", { name: /^Reject/ }).click();
  await poll(async () => (await body.locator(".wrev-fmt").count()) === 0 && (await items.count()) === 0, "change rejected");
  await page.keyboard.press("Control+s");
  await poll(async () => { o = oracle(await read()); return o.revs.length === 0; }, "saved after reject: no revisions");
  eq(bold(o.accept_runs), [], "rejected: the word is plain in the saved file");
  // TT57 paragraph-property tracking (w:pPrChange): Align centre while recording → "Paragraph: Centered" → saved record → Accept
  await dlg.getByRole("button", { name: "Align center" }).click();
  await poll(async () => (await items.count()) === 1, "one paragraph change listed");
  eq((await items.first().getByTestId("writer-change-detail").textContent())?.trim(), ": Centered", "paragraph change detail");
  ok(await body.locator("p.wrev-para").count() === 1, "change bar on the paragraph");
  await page.screenshot({ path: "docs/screens/tt57-writer-para.png" });
  await page.keyboard.press("Control+s");
  await poll(async () => { o = oracle(await read()); return o.revs.length === 1; }, "saved: one pPrChange");
  eq(o.revs[0].kind, "pfmt", "the record is a paragraph-property change");
  eq([o.accept_paras[0][1], o.reject_paras[0][1]], ["center", null], "oracle: accept centred, reject left");
  await items.first().getByRole("button", { name: /^Accept/ }).click();
  await poll(async () => (await items.count()) === 0 && (await body.locator("p.wrev-para").count()) === 0, "paragraph change accepted");
  await page.keyboard.press("Control+s");
  await poll(async () => { o = oracle(await read()); return o.revs.length === 0; }, "saved after accept: no revisions");
  eq(o.accept_paras[0][1], "center", "accepted: centred in the saved file");
  await page.context().close();
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path });
});

await test("FF-21 Spreadsheet hyperlinks in the UI: Ctrl+K web link + ScreenTip, place link with display text, Ctrl+click follows it, bad address refused, Escape closes only the panel; openpyxl reads the saved links", { "FF-21": "full" }, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); sh.setCell(0, 0, "Site"); sh.setCell(3, 9, "target"); wb.recalculate();
  const orig = writeXlsxWorkbook(wb);
  const src = `/Documents/${RUN}-links.xlsx`;
  const up = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(orig).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(up.status < 300, `upload ${up.status}`);
  await putDesktop([]);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const panel = dlg.getByTestId("link-panel");
  await cell("A1").click(); await page.keyboard.press("Control+k"); await panel.waitFor();
  await panel.getByLabel("Link address").fill("example.com/docs"); await panel.getByLabel("ScreenTip").fill("Example docs");
  await page.keyboard.press("Enter");
  await poll(async () => (await cell("A1").getAttribute("data-link")) === "https://example.com/docs", "A1 linked");
  eq((await cell("A1").innerText()).trim(), "Site", "existing text kept");
  ok((await cell("A1").evaluate((e) => getComputedStyle(e).textDecorationLine)).includes("underline"), "linked cell underlined");
  eq(await cell("A1").getAttribute("title"), "Example docs — Ctrl+click to follow", "ScreenTip shown");
  // in-workbook place link with display text on an empty cell
  await cell("B2").click(); await page.keyboard.press("Control+k"); await panel.waitFor();
  await panel.getByLabel("Link address").fill("Sheet1!D10"); await panel.getByLabel("Text to display").fill("Jump");
  await page.screenshot({ path: "docs/screens/tt57-sheet-link.png" });
  await panel.getByRole("button", { name: "Insert", exact: true }).click();
  await poll(async () => (await cell("B2").innerText()).trim() === "Jump", "display text written");
  // failure shapes: an unusable address is refused (no link, panel stays); Escape closes only the panel
  await cell("C3").click(); await page.keyboard.press("Control+k"); await panel.waitFor();
  await panel.getByLabel("Link address").fill("javascript:alert(1)"); await page.keyboard.press("Enter");
  ok(await panel.isVisible(), "panel stays open after a refused address");
  eq(await cell("C3").getAttribute("data-link"), null, "no link on C3");
  await page.keyboard.press("Escape");
  await poll(async () => (await panel.count()) === 0, "Escape closed the panel"); ok(await dlg.isVisible(), "Spreadsheet window still open after Escape");
  // Ctrl+click the place link → selection jumps to D10
  await cell("B2").click({ modifiers: ["Control"] });
  await poll(async () => (await dlg.getByTestId("name-box").inputValue()) === "Sheet1!D10", "Ctrl+click followed the place link").catch(async (e) => {
    throw new Error(`${(e as Error).message} (name box ${await dlg.getByTestId("name-box").inputValue()}, B2 link ${await cell("B2").getAttribute("data-link")}, status ${await dlg.getByTestId("sheet-status").textContent().catch(() => "-")})`);
  });
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = new Uint8Array();
  await poll(async () => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(src)}`); saved = Uint8Array.from(Buffer.from(r.json.node.content, "base64")); return Buffer.compare(Buffer.from(saved), orig) !== 0; }, "saved bytes changed");
  await ctx.close();
  const f = join(tmp, "links.xlsx"); writeFileSync(f, saved);
  const o = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_links.py", f], { encoding: "utf8" }));
  ok(o.opens && o.rels_ok, `saved package: ${o.errors.join("; ")}`);
  eq(o.cells.Sheet1, [["A1", "https://example.com/docs", null, "Example docs"], ["B2", null, "Sheet1!D10", null]], "openpyxl: both links");
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: src });
});

await test("no uncaught page errors during the TT57 session", { "FF-21": "full" }, () => { eq(errors, [], "page errors"); });

await browser.close();
{
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) if (n.path.startsWith(`/Documents/${RUN}-`)) for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
}
await putDesktop([]);
await finish();
process.exit(0);
