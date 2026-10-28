/**
 * TT55 e2e — the Files module as a Class-A file manager, driven through the real UI (Chromium 143, Playwright).
 * Every assertion about an operation is checked against the SERVER (fs API listings, sha256, a recursive walk written
 * here), never against the UI's own state; zip archives are checked with Python's zipfile (test-only oracle).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt55-files.mts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `f${Date.now().toString(36)}`;
const { test: test0, finish } = makeHarness("e2e-tt55-files");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python"; const SHOTS = process.env.SHOTS ?? "/tmp"; mkdirSync(join(SHOTS, "tt55"), { recursive: true });

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
interface N { path: string; name: string; size: number; kind: string; sha256: string; tags: string; trashed: boolean }
const list = async (p: string): Promise<N[]> => (await api("GET", `/api/fs?op=list&path=${encodeURIComponent(p)}`)).json.nodes ?? [];
const stat = async (p: string): Promise<N | null> => { const n = (await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(p)}`)).json?.node ?? null; return n && !n.trashed ? n : null; };
const names = async (p: string) => (await list(p)).map((n) => n.name).sort();
async function write(p: string, content: string) { const r = await api("POST", "/api/fs", { op: "write", path: p, content, reason: "e2e" }); ok(r.status < 300, `write ${p}: ${r.status} ${JSON.stringify(r.json)}`); }
async function mkdir(p: string) { await api("POST", "/api/fs", { op: "mkdir", path: p }); }
/** independent oracle for FM-16 / FM-17: a recursive walk over op=list (not op=find / op=stat) */
async function walk(p: string): Promise<N[]> { const out: N[] = []; for (const n of await list(p)) { out.push(n); if (n.kind === "dir") out.push(...await walk(n.path)); } return out; }
const fmtBytes = (n: number) => { const u = ["B", "KB", "MB", "GB"]; let i = 0, v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`; };
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }

async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openFiles(path: string): Promise<{ page: Page; w: Locator; close: () => Promise<void> }> {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); ctx.setDefaultTimeout(20_000); const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=files&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const w = page.locator('.fs-window[aria-label="Files"]');
  await w.locator(`[data-cwd="${path}"]`).first().waitFor({ timeout: 30_000 });
  return { page, w, close: () => ctx.close() };
}
const row = (scope: Locator, name: string) => scope.locator(`[role="option"][data-path$="/${name}"]`);
const pane = (w: Locator, id: string) => w.locator(`.fs-files-pane[data-pane="${id}"]`);
async function ask(page: Page, value: string | null, okLabel?: string) {
  const dlg = page.getByTestId("ask-dialog"); await dlg.waitFor({ timeout: 8000 });
  if (value !== null) await dlg.locator("input").first().fill(value);
  if (okLabel) await dlg.getByRole("button", { name: okLabel, exact: true }).click(); else await page.keyboard.press("Enter");
  await dlg.waitFor({ state: "detached", timeout: 8000 });
}

const DIR = `/Documents/e2e55-${RUN}`;
await mkdir(DIR);
const sizes: Record<string, number> = {};
for (const [i, n] of ["a1.txt", "a2.txt", "a3.txt", "a4.txt", "a5.txt", "a6.txt"].entries()) { const c = `${n}:${"x".repeat(100 * (i + 1))}`; sizes[n] = Buffer.byteLength(c); await write(`${DIR}/${n}`, c); }
await mkdir(`${DIR}/sub`); await write(`${DIR}/sub/inner.md`, "# inner\n".repeat(40)); await mkdir(`${DIR}/sub/deeper`); await write(`${DIR}/sub/deeper/deep.txt`, "deep".repeat(300));
await mkdir(`${DIR}/dst`);

await test("FM-15 selection toolbar: click, Shift-range, Ctrl-toggle, Ctrl+A, Esc; count and size equal the server's sizes; batch trash then batch restore from Trash", { "FM-15": "full", "FM-01": "partial" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    await row(w, "a1.txt").click();
    await row(w, "a4.txt").click({ modifiers: ["Shift"] });
    const count = w.getByTestId("files-selcount");
    const want = (ns: string[]) => `${ns.length} selected · ${fmtBytes(ns.reduce((a, n) => a + sizes[n], 0))}`;
    ok((await count.innerText()).trim() === want(["a1.txt", "a2.txt", "a3.txt", "a4.txt"]), `range: ${await count.innerText()} vs ${want(["a1.txt", "a2.txt", "a3.txt", "a4.txt"])}`);
    await row(w, "a2.txt").click({ modifiers: ["Control"] });
    ok((await count.innerText()).trim() === want(["a1.txt", "a3.txt", "a4.txt"]), `Ctrl-toggle: ${await count.innerText()}`);
    ok(await row(w, "a2.txt").getAttribute("aria-selected") === "false" && await row(w, "a3.txt").getAttribute("aria-selected") === "true", "aria-selected follows");
    await row(w, "a1.txt").focus(); await page.keyboard.press("Control+a");
    const all = (await list(DIR)).filter((n) => !n.name.startsWith("."));
    await poll(async () => (await count.innerText()).startsWith(`${all.length} selected`), `Ctrl+A selects all ${all.length}`);
    // folder sizes are part of the selection total once their background size lands
    const total = all.reduce((a, n) => a + n.size, 0) + (await walk(DIR)).filter((n) => n.kind === "file" && n.path.split("/").length > DIR.split("/").length + 1).reduce((a, n) => a + n.size, 0);
    await poll(async () => (await count.innerText()).trim() === `${all.length} selected · ${fmtBytes(total)}`, `selection total incl. folder sizes = ${fmtBytes(total)}: ${await count.innerText()}`);
    await page.keyboard.press("Escape");
    await w.getByTestId("files-selbar").waitFor({ state: "detached" });
    // batch trash via the toolbar
    await row(w, "a5.txt").click(); await row(w, "a6.txt").click({ modifiers: ["Shift"] });
    await w.getByTestId("files-selbar").getByRole("button", { name: "Move to trash" }).click();
    await poll(async () => !(await stat(`${DIR}/a5.txt`)) && !(await stat(`${DIR}/a6.txt`)), "a5, a6 trashed on the server");
    await row(w, "a5.txt").waitFor({ state: "detached" });
    await page.screenshot({ path: join(SHOTS, "tt55", "selbar.png") });
    // batch restore from the Trash view
    await w.getByRole("button", { name: "Trash", exact: true }).click();
    await row(w, "a5.txt").first().click(); await row(w, "a6.txt").first().click({ modifiers: ["Control"] });
    await w.getByTestId("files-selbar").getByRole("button", { name: "Restore" }).click();
    await poll(async () => !!(await stat(`${DIR}/a5.txt`)) && !!(await stat(`${DIR}/a6.txt`)), "restored on the server");
  } finally { await close(); }
});

await test("FM-02 + FM-03 dual pane: Ctrl+C / Ctrl+V across panes copies byte-identically, a second paste picks conflict-free names, Ctrl+X moves, F5 copies to the other pane", { "FM-02": "full", "FM-03": "partial" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    await w.getByRole("button", { name: "Dual pane" }).click();
    const A = pane(w, "a"), B = pane(w, "b");
    await B.waitFor();
    await B.getByRole("button", { name: "Edit path" }).click();
    await B.getByLabel("Path").fill(`${DIR}/dst`); await page.keyboard.press("Enter");
    await w.locator(`.fs-files-pane[data-pane="b"][data-cwd="${DIR}/dst"]`).waitFor();
    await row(A, "a1.txt").click(); await row(A, "a2.txt").click({ modifiers: ["Control"] });
    await page.keyboard.press("Control+c");
    await B.getByTestId("files-listing").click({ position: { x: 3, y: 3 } });
    await page.keyboard.press("Control+v");
    await poll(async () => JSON.stringify(await names(`${DIR}/dst`)) === JSON.stringify(["a1.txt", "a2.txt"]), "pasted into dst");
    for (const n of ["a1.txt", "a2.txt"]) ok((await stat(`${DIR}/dst/${n}`))!.sha256 === (await stat(`${DIR}/${n}`))!.sha256, `${n} byte-identical`);
    ok(!!(await stat(`${DIR}/a1.txt`)), "copy keeps the source");
    await B.getByTestId("files-listing").click({ position: { x: 3, y: 3 } });
    await page.keyboard.press("Control+v");
    await poll(async () => JSON.stringify(await names(`${DIR}/dst`)) === JSON.stringify(["a1 copy.txt", "a1.txt", "a2 copy.txt", "a2.txt"]), `second paste → copies: ${JSON.stringify(await names(`${DIR}/dst`))}`);
    // cut + paste = move
    await row(A, "a3.txt").click(); await page.keyboard.press("Control+x");
    await B.getByTestId("files-listing").click({ position: { x: 3, y: 3 } }); await page.keyboard.press("Control+v");
    await poll(async () => !!(await stat(`${DIR}/dst/a3.txt`)) && !(await stat(`${DIR}/a3.txt`)), "cut/paste moved a3");
    // F5 = copy to the other pane
    await row(A, "a4.txt").click(); await page.keyboard.press("F5");
    await poll(async () => !!(await stat(`${DIR}/dst/a4.txt`)) && !!(await stat(`${DIR}/a4.txt`)), "F5 copied a4");
    await page.screenshot({ path: join(SHOTS, "tt55", "dual.png") });
    // put a3 back for the following tests
    await api("POST", "/api/fs", { op: "move", src: `${DIR}/dst/a3.txt`, dst: `${DIR}/a3.txt` });
  } finally { await close(); }
});

await test("FM-02 drag and drop: a row dragged onto the other pane moves it, Ctrl-drag copies, a row dropped on a folder row moves it into that folder (server-verified)", { "FM-02": "full", "FM-03": "partial" }, async () => {
  await write(`${DIR}/drag1.txt`, "drag one"); await write(`${DIR}/drag2.txt`, "drag two");
  const { page, w, close } = await openFiles(DIR);
  try {
    await w.getByRole("button", { name: "Dual pane" }).click();
    const A = pane(w, "a"), B = pane(w, "b");
    await B.getByRole("button", { name: "Edit path" }).click(); await B.getByLabel("Path").fill(`${DIR}/dst`); await page.keyboard.press("Enter");
    await w.locator(`.fs-files-pane[data-pane="b"][data-cwd="${DIR}/dst"]`).waitFor();
    await row(A, "drag1.txt").dragTo(B.getByTestId("files-listing"), { targetPosition: { x: 150, y: 250 } });
    await poll(async () => !!(await stat(`${DIR}/dst/drag1.txt`)) && !(await stat(`${DIR}/drag1.txt`)), "drag moved drag1 into dst");
    await row(A, "drag2.txt").dragTo(row(A, "sub"));
    await poll(async () => !!(await stat(`${DIR}/sub/drag2.txt`)) && !(await stat(`${DIR}/drag2.txt`)), "drop on a folder row moved drag2 into sub");
    // Ctrl-drop = copy. Playwright's native drag hangs while Control is held, so THIS step uses a synthetic drop event
    // (ctrlKey + a DataTransfer carrying the same payload our dragstart writes); the two native drags above are real.
    await B.getByTestId("files-listing").evaluate((el, src) => {
      const dt = new DataTransfer(); dt.setData("application/x-fusion-paths", JSON.stringify([src]));
      const r = el.getBoundingClientRect(), init = { bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: true, clientX: r.left + 100, clientY: r.top + 200 };
      el.dispatchEvent(new DragEvent("dragover", init)); el.dispatchEvent(new DragEvent("drop", init));
    }, `${DIR}/a6.txt`);
    await poll(async () => !!(await stat(`${DIR}/dst/a6.txt`)) && !!(await stat(`${DIR}/a6.txt`)), "Ctrl-drag copied a6");
  } finally { await close(); }
});

await test("SH-09 history: double-click in, breadcrumbs, Back / Forward buttons, Alt+← / Alt+→, Backspace, mouse buttons 4 / 5 navigate the pane and never the browser tab; a new navigation clears Forward", { "SH-09": "full", "FM-01": "partial" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    const P = pane(w, "single");
    const at = (p: string) => poll(async () => (await P.getAttribute("data-cwd")) === p, `at ${p}`).catch(async (e) => { throw new Error(`${(e as Error).message} (now ${await P.getAttribute("data-cwd")})`); });
    const hist0 = await page.evaluate(() => history.length); const url0 = page.url();
    await row(P, "sub").dblclick(); await at(`${DIR}/sub`);
    await row(P, "deeper").dblclick(); await at(`${DIR}/sub/deeper`);
    await P.locator(`[data-crumb="${DIR}"]`).click(); await at(DIR);
    await P.getByRole("button", { name: "Back", exact: true }).click(); await at(`${DIR}/sub/deeper`);
    await P.getByRole("button", { name: "Forward", exact: true }).click(); await at(DIR);
    await P.getByTestId("files-listing").click({ position: { x: 3, y: 3 } });
    await page.keyboard.press("Alt+ArrowLeft"); await at(`${DIR}/sub/deeper`);
    await page.keyboard.press("Alt+ArrowRight"); await at(DIR);
    await page.keyboard.press("Backspace"); await at(`${DIR}/sub/deeper`);
    // mouse buttons 4 / 5 (DOM button 3 / 4): real mouseup + auxclick events, as a mouse produces them
    const mouse = (button: number) => P.getByTestId("files-listing").evaluate((el, b) => {
      for (const type of ["mousedown", "mouseup", "auxclick"]) el.dispatchEvent(new MouseEvent(type, { button: b, buttons: 0, bubbles: true, cancelable: true, composed: true }));
    }, button);
    await mouse(4); await at(DIR);
    await mouse(3); await at(`${DIR}/sub/deeper`);
    ok(page.url() === url0 && await page.evaluate(() => history.length) === hist0, "the browser tab did not navigate");
    await P.getByRole("button", { name: "Up one folder" }).click(); await at(`${DIR}/sub`);
    ok(await P.getByRole("button", { name: "Forward", exact: true }).isDisabled(), "a new navigation clears Forward");
    ok(await P.locator('[data-crumb]').count() === `${DIR}/sub`.split("/").length, "one crumb per level + Home");
    // the old "←" text glyph (tofu in the UI font) is gone: the Back button holds an SVG
    ok(await P.getByRole("button", { name: "Back", exact: true }).locator("svg").count() === 1, "Back is an SVG glyph");
  } finally { await close(); }
});

await test("FM-01 folder tree + column view + tabs: the tree lists the server's folders and navigates; Columns show every ancestor; tabs keep their own folder", { "FM-01": "full" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    await w.getByRole("button", { name: "Folder tree" }).click();
    const tree = w.getByTestId("files-tree");
    const serverDirs = (await api("GET", "/api/fs?op=tree")).json.dirs as string[];
    await tree.locator(`[data-tree-path="${DIR}/sub/deeper"]`).waitFor();
    const shown = await tree.locator("[data-tree-path]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.treePath!));
    const want = ["/", ...serverDirs.filter((d) => d !== "/" && !d.split("/").some((s) => s.startsWith(".")))];
    ok(JSON.stringify(shown) === JSON.stringify(want), `tree = server folders (${shown.length} vs ${want.length})`);
    await tree.locator(`[data-tree-path="${DIR}/sub/deeper"]`).click();
    await poll(async () => (await pane(w, "single").getAttribute("data-cwd")) === `${DIR}/sub/deeper`, "tree navigates");
    await w.getByRole("button", { name: "Columns", exact: true }).click();
    const cols = w.getByTestId("files-columns");
    await cols.locator(`[data-col-path="${DIR}/sub"][aria-current="true"]`).waitFor();
    ok(await cols.locator("nav").count() === `${DIR}/sub/deeper`.split("/").length - 1, "one column per ancestor");
    for (const n of await list(`${DIR}/sub`)) if (!n.name.startsWith(".")) ok(await cols.locator(`[data-col-path="${n.path}"]`).count() === 1, `column lists ${n.name}`);
    await cols.locator(`[data-col-path="${DIR}/sub"]`).click();
    await poll(async () => (await pane(w, "single").getAttribute("data-cwd")) === `${DIR}/sub`, "column click navigates");
    await page.screenshot({ path: join(SHOTS, "tt55", "tree-columns.png") });
    await w.getByRole("button", { name: "List", exact: true }).click();
    // tabs
    await w.getByRole("button", { name: "New tab" }).click();
    ok(await w.getByRole("tab").count() === 2, "two tabs");
    const p2 = w.locator('[role="tabpanel"]:not([hidden]) .fs-files-pane');
    await row(p2, "deeper").dblclick();
    await poll(async () => (await w.getByRole("tab", { selected: true }).innerText()).trim() === "deeper", "tab label follows its folder");
    await w.getByRole("tab", { name: "sub" }).click();
    ok((await w.locator('[role="tabpanel"]:not([hidden]) .fs-files-pane').getAttribute("data-cwd")) === `${DIR}/sub`, "the first tab kept its folder");
    await w.getByRole("tab", { name: "deeper" }).click({ button: "middle" });
    await poll(async () => (await w.getByRole("tab").count()) === 1, "middle-click closes a tab");
  } finally { await close(); }
});

await test("FM-06 context menu: concise vs full sets, type-to-search reaches any action, arrow keys + Enter run it, Esc closes; background menu has New / templates / Paste", { "FM-06": "full" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    await row(w, "a1.txt").click({ button: "right" });
    const menu = page.getByTestId("files-menu");
    await menu.waitFor();
    const concise = await menu.getByRole("menuitem").count();
    await menu.locator('[data-item="more"]').click();
    const full = await menu.getByRole("menuitem").count();
    ok(full > concise && concise >= 5, `full ${full} > concise ${concise}`);
    ok(await menu.getByRole("menuitem", { name: "Encrypt (SC-07)…" }).count() === 1 && await menu.getByRole("menuitem", { name: "Compress to .zip" }).count() === 1, "full set has the TT24–TT54 actions");
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "detached" });
    // type-to-search: focus starts in the search box
    await row(w, "a1.txt").click({ button: "right" }); await menu.waitFor();
    ok(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label")) === "Search actions", "search box focused");
    await page.keyboard.type("label");
    ok(await menu.getByRole("menuitem").count() === 1 && (await menu.getByRole("menuitem").innerText()).trim() === "Tag…", "keyword 'label' finds Tag…");
    await page.keyboard.press("Enter");
    await ask(page, `t-${RUN}`, "Save tags");
    await poll(async () => (await stat(`${DIR}/a1.txt`))!.tags === `t-${RUN}`, "tag saved on the server");
    // arrow keys + typing from an item
    await row(w, "a2.txt").click({ button: "right" }); await menu.waitFor();
    await page.keyboard.press("ArrowDown");
    ok(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.item) === "open", "ArrowDown → first item");
    await page.keyboard.press("ArrowDown");
    ok(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.item) === "edit", "ArrowDown → second item");
    await page.keyboard.type("dup");
    ok(await menu.getByRole("menuitem").count() === 1, "typing on an item searches");
    await page.keyboard.press("Enter");
    await poll(async () => !!(await stat(`${DIR}/a2 copy.txt`)), "Duplicate made 'a2 copy.txt'");
    // background menu
    await row(w, "a3.txt").click(); await page.keyboard.press("Control+c");
    await w.getByTestId("files-listing").evaluate((el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.bottom - 20 })); });
    await menu.waitFor();
    for (const n of ["New folder", "New file", "Paste 1 item(s)", "Select all"]) ok(await menu.getByRole("menuitem", { name: n }).count() === 1, `background menu has ${n}`);
    await poll(async () => (await menu.getByRole("menuitem", { name: /^New from template: / }).count()) >= 2, "template entries");
    await page.screenshot({ path: join(SHOTS, "tt55", "menu.png") });
    await page.keyboard.press("Escape");
  } finally { await close(); }
});

await test("FM-13 New from template: the menu lists /System/Templates from the server; a new file is a byte copy of the template; a second one gets a free name", { "FM-13": "full" }, async () => {
  const tpls = (await list("/System/Templates")).filter((n) => n.kind === "file");
  ok(tpls.length >= 2, `templates on the server: ${tpls.map((t) => t.name)}`);
  const { page, w, close } = await openFiles(`${DIR}/dst`);
  try {
    await w.getByRole("button", { name: "From template" }).click();
    const m = w.getByRole("menu", { name: "New from template" });
    for (const t of tpls) await m.getByRole("menuitem", { name: t.name }).waitFor();
    const t = tpls[0];
    await m.getByRole("menuitem", { name: t.name }).click();
    await poll(async () => !!(await stat(`${DIR}/dst/${t.name}`)), `created ${t.name}`);
    ok((await stat(`${DIR}/dst/${t.name}`))!.sha256 === t.sha256, "byte copy of the template");
    await w.getByRole("button", { name: "From template" }).click();
    await m.getByRole("menuitem", { name: t.name }).click();
    const [stem, ext] = t.name.includes(".") ? [t.name.slice(0, t.name.lastIndexOf(".")), t.name.slice(t.name.lastIndexOf("."))] : [t.name, ""];
    await poll(async () => !!(await stat(`${DIR}/dst/${stem} 2${ext}`)), `second → '${stem} 2${ext}'`);
    void page;
  } finally { await close(); }
});

await test("FM-16 quick filter + Subfolders: deep matches equal a recursive walk of the server; % and _ are literal; dotfiles and /System stay out", { "FM-16": "full" }, async () => {
  await write(`${DIR}/needle-top.txt`, "n"); await write(`${DIR}/sub/deeper/Needle-deep.md`, "n"); await write(`${DIR}/sub/.needle-hidden`, "n");
  await write(`${DIR}/100%_done.txt`, "p"); await write(`${DIR}/100ab.txt`, "p"); await write(`${DIR}/x_y.txt`, "p"); await write(`${DIR}/xzy.txt`, "p");
  const { page, w, close } = await openFiles(DIR);
  try {
    const P = pane(w, "single");
    await P.getByLabel("Quick filter").fill("needle");
    await poll(async () => (await P.locator('[role="option"]').count()) === 1, "shallow filter: only this folder");
    await P.getByRole("button", { name: "Subfolders" }).click();
    const want = (await walk(DIR)).filter((n) => n.name.toLowerCase().includes("needle") && !n.name.startsWith(".")).map((n) => n.path).sort();
    await poll(async () => JSON.stringify((await P.locator('[role="option"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!))).sort()) === JSON.stringify(want), `deep = walk ${JSON.stringify(want)}`);
    await P.getByLabel("Quick filter").fill("100%");
    const want2 = (await walk(DIR)).filter((n) => n.name.includes("100%")).map((n) => n.path);
    await poll(async () => JSON.stringify(await P.locator('[role="option"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!))) === JSON.stringify(want2), "% is literal");
    // server-level: _ literal, System excluded unless searched inside it, trash excluded
    const f = async (q: string, p = DIR) => ((await api("GET", `/api/fs?op=find&path=${encodeURIComponent(p)}&q=${encodeURIComponent(q)}`)).json.nodes as N[]).map((n) => n.name).sort();
    ok(JSON.stringify(await f("x_y")) === JSON.stringify(["x_y.txt"]), `_ literal (an unescaped _ would also match xzy.txt): ${await f("x_y")}`);
    ok(JSON.stringify(await f("%_d")) === JSON.stringify(["100%_done.txt"]), `% literal: ${await f("%_d")}`);
    ok(((await api("GET", `/api/fs?op=find&path=/&q=note.md`)).json.nodes as N[]).every((n) => !n.path.startsWith("/System/")), "/System excluded from a root search");
    ok(((await api("GET", `/api/fs?op=find&path=/System&q=note`)).json.nodes as N[]).some((n) => n.path === "/System/Templates/note.md"), "…but found when searching inside /System");
    await api("POST", "/api/fs", { op: "trash", path: `${DIR}/100ab.txt` });
    ok(!(await f("100")).includes("100ab.txt"), "trash excluded");
    await page.screenshot({ path: join(SHOTS, "tt55", "deep.png") });
  } finally { await close(); }
});

await test("FM-17 folder sizes: every folder row shows the size of its subtree (= a recursive walk of the server), and the cached size refreshes after a write", { "FM-17": "full" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    const sumOf = async (p: string) => (await walk(p)).filter((n) => n.kind === "file").reduce((a, n) => a + n.size, 0);
    for (const d of ["sub", "dst"]) {
      const want = await sumOf(`${DIR}/${d}`);
      await poll(async () => (await row(w, d).locator("[data-size]").getAttribute("data-size")) === String(want), `${d} = ${want}`);
      ok((await row(w, d).locator("[data-size]").innerText()).trim() === fmtBytes(want), "label formatted");
    }
    const before = await sumOf(`${DIR}/sub`);
    await w.getByRole("button", { name: "New file" }).click();
    await ask(page, "grow.txt", "Create");
    // write into sub through the UI path: open sub, paste? simpler: server write + refresh tick from a UI write
    await write(`${DIR}/sub/deeper/grow.bin`, "g".repeat(5000));
    await row(w, "grow.txt").waitFor();
    await w.getByRole("button", { name: "New folder" }).click(); await ask(page, `nf-${RUN}`, "Create"); // a UI write bumps the refresh tick
    const after = await sumOf(`${DIR}/sub`);
    ok(after === before + 5000, `server sum grew: ${before} → ${after}`);
    await poll(async () => (await row(w, "sub").locator("[data-size]").getAttribute("data-size")) === String(after), `refreshed to ${after}`);
    const title = await row(w, "sub").locator("[data-size]").getAttribute("title");
    const files = (await walk(`${DIR}/sub`)).filter((n) => n.kind === "file").length, dirs = (await walk(`${DIR}/sub`)).filter((n) => n.kind === "dir").length;
    const expectedTitle = `${files} file(s) · ${dirs} folder(s) · ${fmtBytes(after)}`;
    // A final UI write can invalidate the size cache after the first byte-count observation.
    // Require both exact independent walk results in the same settled observation, not a fixed delay.
    await poll(async () => await row(w, "sub").locator("[data-size]").getAttribute("data-size") === String(after) && await row(w, "sub").locator("[data-size]").getAttribute("title") === expectedTitle, `size + tooltip settle: ${title} → ${expectedTitle}`);
  } finally { await close(); }
});

await test("FM-09 / DP-03 origin badges: rows say where bytes live; offline, a new file shows as a 'queued' ghost row and becomes a real server row after replay", { "FM-09": "full", "DP-03": "full", "SH-14": "partial" }, async () => {
  await mkdir(`${DIR}/origin`); await write(`${DIR}/origin/here.txt`, "on the server");
  const { page, w, close } = await openFiles(`${DIR}/origin`);
  try {
    const P = pane(w, "single");
    await row(P, "here.txt").waitFor();
    ok(await row(P, "here.txt").locator('[data-origin="server"]').count() === 1, "server badge");
    await page.context().setOffline(true);
    await P.getByRole("button", { name: "New file" }).click();
    await ask(page, `offline-${RUN}.md`, "Create");
    const ghost = P.locator(`[data-ghost="${DIR}/origin/offline-${RUN}.md"]`);
    await ghost.waitFor({ timeout: 10_000 });
    ok(await ghost.locator('[data-origin="queued"]').count() === 1, "queued badge");
    ok(!(await stat(`${DIR}/origin/offline-${RUN}.md`)), "not on the server while offline");
    await page.screenshot({ path: join(SHOTS, "tt55", "queued.png") });
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await poll(async () => !!(await stat(`${DIR}/origin/offline-${RUN}.md`)), "replayed to the server", 20_000);
    await row(P, `offline-${RUN}.md`).waitFor({ timeout: 15_000 });
    await ghost.waitFor({ state: "detached", timeout: 15_000 });
    ok(await row(P, `offline-${RUN}.md`).locator('[data-origin="server"]').count() === 1, "now a server row");
  } finally { await close(); }
});

await test("FM-15 keyboard file operations: F2 renames, Delete trashes, Shift-range compress builds one archive (zipfile-verified), selection batch rename touches only the selection", { "FM-15": "full", "FM-05": "partial" }, async () => {
  const D2 = `${DIR}/kb`; await mkdir(D2);
  for (const n of ["k1.txt", "k2.txt", "k3.txt", "k4.txt"]) await write(`${D2}/${n}`, `${n} body`);
  await mkdir(`${D2}/kd`); await write(`${D2}/kd/inside.txt`, "inside");
  const { page, w, close } = await openFiles(D2);
  try {
    const P = pane(w, "single");
    await row(P, "k1.txt").click(); await page.keyboard.press("F2");
    await ask(page, "k1-renamed.txt", "Rename");
    await poll(async () => !!(await stat(`${D2}/k1-renamed.txt`)) && !(await stat(`${D2}/k1.txt`)), "F2 renamed");
    await row(P, "k4.txt").click(); await page.keyboard.press("Delete");
    await poll(async () => !(await stat(`${D2}/k4.txt`)), "Delete trashed k4");
    // compress kd + k2 + k3 (Ctrl-select) → Archive.zip
    await row(P, "kd").click(); await row(P, "k2.txt").click({ modifiers: ["Control"] }); await row(P, "k3.txt").click({ modifiers: ["Control"] });
    await P.getByTestId("files-selbar").getByRole("button", { name: "Compress" }).click();
    await poll(async () => !!(await stat(`${D2}/Archive.zip`)), "Archive.zip written");
    const zip = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`${D2}/Archive.zip`)}`)).json.node;
    writeFileSync("/tmp/tt55-archive.zip", Buffer.from(zip.content, "base64"));
    const entries = JSON.parse(execFileSync(PY, ["-c", "import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename: z.read(i).decode() for i in z.infolist()}))", "/tmp/tt55-archive.zip"], { encoding: "utf8" }));
    ok(JSON.stringify(entries) === JSON.stringify({ "k2.txt": "k2.txt body", "k3.txt": "k3.txt body", "kd/inside.txt": "inside" }) || JSON.stringify(Object.keys(entries).sort()) === JSON.stringify(["k2.txt", "k3.txt", "kd/inside.txt"]) && entries["kd/inside.txt"] === "inside" && entries["k2.txt"] === "k2.txt body", `zip entries ${JSON.stringify(entries)}`);
    // batch rename of the selection only (k2, k3) — k1-renamed must not change
    await row(P, "k2.txt").click(); await row(P, "k3.txt").click({ modifiers: ["Shift"] });
    await row(P, "k2.txt").click({ button: "right" });
    await page.getByTestId("files-menu").getByRole("menuitem", { name: /^Batch rename 2 files/ }).click();
    await ask(page, "sel-{n}.{ext}", "Rename all");
    await poll(async () => JSON.stringify(await names(D2)) === JSON.stringify(["Archive.zip", "k1-renamed.txt", "kd", "sel-01.txt", "sel-02.txt"]), `only the selection renamed: ${JSON.stringify(await names(D2))}`);
  } finally { await close(); }
});

await test("FM-02 terminal pane: the real Terminal docks under the panes, follows the active pane's folder, and runs commands there", { "FM-02": "full" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    await w.getByRole("button", { name: "Terminal pane" }).click();
    const t = w.getByTestId("files-terminal");
    await t.waitFor();
    await row(w, "sub").dblclick();
    await t.getByText(new RegExp(`cd ${DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sub\\s+\\(following the Files pane\\)`)).waitFor({ timeout: 10_000 });
    await t.locator("input").first().fill("pwd"); await page.keyboard.press("Enter");
    await poll(async () => (await t.innerText()).split("\n").some((l) => l.trim() === `${DIR}/sub`), "pwd prints the pane's folder");
    await t.locator("input").first().fill("ls"); await page.keyboard.press("Enter");
    await poll(async () => (await t.innerText()).includes("inner.md"), "ls lists the folder");
    await page.screenshot({ path: join(SHOTS, "tt55", "terminal.png") });
  } finally { await close(); }
});

await test("regressions: one roving tab stop in the listing, one file input, Space selects / Enter opens, axe finds no serious violations in the new chrome (tabs, toolbar, menu, tree)", { "FM-01": "full", "AX-02": "partial" }, async () => {
  const { page, w, close } = await openFiles(DIR);
  try {
    await row(w, "a1.txt").waitFor();
    ok(await w.locator('[role="listbox"] [role="option"][tabindex="0"]').count() === 1, "one tab stop");
    ok(await w.locator("input[type=file]").count() === 1, "one file input");
    await w.getByRole("button", { name: "Folder tree" }).click();
    await row(w, "a1.txt").click();
    await row(w, "a2.txt").click({ button: "right" });
    await page.getByTestId("files-menu").waitFor();
    const { readFileSync } = await import("node:fs");
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const res = await page.evaluate(async () => {
      // @ts-expect-error injected
      const r = await window.axe.run({ include: [['.fs-window[aria-label="Files"]'], ['[data-testid="files-menu"]']] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
      return r.violations.filter((v: { impact: string }) => v.impact === "serious" || v.impact === "critical").map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    });
    ok(res.length === 0, `axe: ${res.join("\n")}`);
    await page.keyboard.press("Escape");
  } finally { await close(); }
});

await browser.close();
await api("POST", "/api/fs", { op: "purge", path: DIR });
ok(true, "");
if (errors.length) console.log("page errors:", errors.slice(0, 5));
finish();
