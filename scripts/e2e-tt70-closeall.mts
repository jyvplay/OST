/**
 * TT70 FF-15 "Close all windows" over SEVERAL dirty documents, in the real UI (Business taskbar jump list → one close
 * command per window → the shell's single ask queue). TT69 tested one dirty window per close.
 *  1. two dirty Spreadsheet windows (a file and an untitled workbook) → Close all windows asks about the FIRST, naming it
 *     and saying one more document follows; Save writes it (openpyxl) and closes it; the question moves to the second
 *     (no "more" note); Don't save closes it and keeps an untitled recovery draft; no Spreadsheet window is left.
 *  2. Cancel stops the whole queue: Escape on the first question leaves BOTH windows open and unsaved, and no second
 *     question appears.
 *  3. a clean window among dirty ones closes at once without a question.
 * Restores the layout setting it changes (gate pollution is how TT69's flakes started).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt70-closeall.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { draftPathFor, UNTITLED_RE } from "../src/lib/doc-lifecycle.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t70c${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e70c-"));
const { test, finish } = makeHarness("e2e-tt70-closeall");
const FULL = { "FF-15": "full", "LY-01": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const getSetting = async (k: string) => ((await api("GET", "/api/settings")).json.rows as { key: string; value: string }[]).find((r) => r.key === k)?.value;
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const readNode = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return r.status === 200 && r.json?.node ? r.json.node as { content: string; encoding?: string } : null; };
const bytesOf = async (path: string) => { const n = await readNode(path); if (!n) throw new Error(`missing ${path}`); return Buffer.from(n.content, n.encoding === "base64" ? "base64" : "utf8"); };
const purge = async (p: string) => { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); };
const upload = async (path: string, bytes: Uint8Array) => { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(r.status < 300, `upload ${r.status}`); };
const untitledSheetDrafts = async () => (((await api("GET", `/api/fs?path=${encodeURIComponent("/System/Recovery")}`)).json?.nodes ?? []) as { name: string }[]).map((n) => n.name).filter((n) => UNTITLED_RE.test(n) && n.startsWith("sheet_"));
const xlsxCell = (file: string, ref: string) => execFileSync(PY, ["-c", "import openpyxl,sys,json; wb=openpyxl.load_workbook(sys.argv[1]); print(json.dumps(wb.active[sys.argv[2]].value))", file, ref], { encoding: "utf8" }).trim();

const browser: Browser = await launchChromium();
const errors: string[] = [];
const cleanup: string[] = [];
const layout0 = await getSetting("appearance.layout") ?? "fusion";
const view0 = await getSetting("appearance.desktopView") ?? "classic";
await setSetting("appearance.layout", "business"); await setSetting("appearance.desktopView", "classic");

async function twoDirtySheets(src: string, val: string): Promise<{ page: Page; wins: ReturnType<Page["locator"]> }> {
  await putDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const wins = page.locator('[role=dialog][aria-label="Spreadsheet"]');
  await wins.first().locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  await wins.first().locator('[data-cell="B1"]').click(); await page.keyboard.type(val); await page.keyboard.press("Enter");
  await poll(async () => /unsaved/.test(await wins.first().innerText()), "first window dirty");
  const tb = page.getByTestId("taskbar-sheet"); await tb.waitFor();
  await tb.click({ modifiers: ["Shift"] });
  await poll(async () => (await wins.count()) === 2, "Shift+click → a second Spreadsheet window");
  const second = wins.nth(1); await second.locator('[data-testid="sheet-grid"]').waitFor();
  await second.locator('[data-cell="A1"]').click(); await page.keyboard.type("22"); await page.keyboard.press("Enter");
  await poll(async () => /unsaved/.test(await second.innerText()), "second window dirty");
  return { page, wins };
}
const confirmBox = (page: Page) => page.getByTestId("close-confirm");
async function closeAll(page: Page) {
  await page.getByTestId("taskbar-sheet").click({ button: "right" });
  await page.getByTestId("jump-close-sheet").click();
}

try {
  await test("Close all windows over two dirty workbooks asks about each in window order: Save writes + closes the first, Don't save closes the second and keeps its draft", FULL, async () => {
    const wb = new Workbook(); wb.sheet().setCell(0, 0, "1"); wb.recalculate();
    const src = `/Documents/${RUN}-a.xlsx`; cleanup.push(src, draftPathFor("sheet", src)); await upload(src, writeXlsxWorkbook(wb));
    const before = new Set(await untitledSheetDrafts());
    const { page, wins } = await twoDirtySheets(src, "11");
    await closeAll(page);
    await confirmBox(page).waitFor();
    const q1 = await confirmBox(page).innerText();
    ok(new RegExp(`Save changes to “${RUN}-a\\.xlsx”\\?`).test(q1), `first question names the file: ${q1.slice(0, 120)}`);
    ok(/1 more document with unsaved changes after this one/.test(q1), "says one more document follows");
    await page.getByTestId("close-confirm-save").click();
    await poll(async () => (await wins.count()) === 1, "the saved window closed");
    await poll(async () => (await confirmBox(page).count()) === 1 && /Untitled/.test(await confirmBox(page).innerText()), "the question moved to the untitled workbook");
    ok(!/more document/.test(await confirmBox(page).innerText()), "no 'more' note on the last question");
    writeFileSync(join(tmp, "a.xlsx"), await bytesOf(src));
    eq(xlsxCell(join(tmp, "a.xlsx"), "B1"), "11", "openpyxl reads the saved edit of the first workbook");
    await page.getByTestId("close-confirm-discard").click();
    await poll(async () => (await wins.count()) === 0 && (await confirmBox(page).count()) === 0, "all Spreadsheet windows closed, no question left");
    await poll(async () => (await untitledSheetDrafts()).some((n) => !before.has(n)), "Don't save kept an untitled recovery draft");
    for (const n of await untitledSheetDrafts()) if (!before.has(n)) cleanup.push(`/System/Recovery/${n}`);
    await page.context().close();
  });

  await test("Cancel (Escape) on the first question stops the whole queue: both windows stay open and unsaved, no second question", FULL, async () => {
    const wb = new Workbook(); wb.sheet().setCell(0, 0, "1"); wb.recalculate();
    const src = `/Documents/${RUN}-b.xlsx`; cleanup.push(src, draftPathFor("sheet", src)); await upload(src, writeXlsxWorkbook(wb));
    const before = new Set(await untitledSheetDrafts());
    const { page, wins } = await twoDirtySheets(src, "33");
    await closeAll(page);
    await confirmBox(page).waitFor();
    await page.keyboard.press("Escape");
    await poll(async () => (await confirmBox(page).count()) === 0, "question dismissed");
    await page.waitForTimeout(800);
    eq(await confirmBox(page).count(), 0, "no second question after Cancel");
    eq(await wins.count(), 2, "both windows still open");
    ok(/unsaved/.test(await wins.nth(0).innerText()) && /unsaved/.test(await wins.nth(1).innerText()), "both still unsaved");
    writeFileSync(join(tmp, "b.xlsx"), await bytesOf(src));
    eq(xlsxCell(join(tmp, "b.xlsx"), "B1"), "null", "nothing was saved");
    for (const n of await untitledSheetDrafts()) if (!before.has(n)) cleanup.push(`/System/Recovery/${n}`);
    await page.context().close();
  });

  await test("a clean window among dirty ones closes at once; only the dirty one is asked about", FULL, async () => {
    const wb = new Workbook(); wb.sheet().setCell(0, 0, "1"); wb.recalculate();
    const src = `/Documents/${RUN}-c.xlsx`; cleanup.push(src, draftPathFor("sheet", src)); await upload(src, writeXlsxWorkbook(wb));
    await putDesktop();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
    const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
    const wins = page.locator('[role=dialog][aria-label="Spreadsheet"]');
    await wins.first().locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
    await wins.first().locator('[data-cell="B1"]').click(); await page.keyboard.type("44"); await page.keyboard.press("Enter");
    await poll(async () => /unsaved/.test(await wins.first().innerText()), "dirty");
    await page.getByTestId("taskbar-sheet").click({ modifiers: ["Shift"] });
    await poll(async () => (await wins.count()) === 2, "a second, clean window");
    await closeAll(page);
    await confirmBox(page).waitFor();
    eq(await wins.count(), 1, "the clean window closed immediately");
    ok(!/more document/.test(await confirmBox(page).innerText()), "only one document is asked about");
    await page.getByTestId("close-confirm-discard").click();
    await poll(async () => (await wins.count()) === 0, "closed");
    await page.context().close();
  });
} finally {
  await setSetting("appearance.layout", layout0); await setSetting("appearance.desktopView", view0);
  for (const p of cleanup) await purge(p).catch(() => undefined);
  await browser.close();
}
if (errors.length) console.log("page errors:", errors.slice(0, 5));
finish();
