/**
 * TT56 real-browser suite (Playwright + headless Chromium 143 against the production server):
 *   WM-05 held-chord MRU switcher (window / app / workspace modes, lock-while-held, Esc, Shift, modal ask dialog blocks it)
 *   NC-06 on-screen display (20 volume events → exactly one polite live-region change; text size / focus-mode OSD)
 *   WM-10 focus mode (Meta+Shift+F → one parent CSS variable dims every unfocused window)
 *   ST-05 OS media-query defaults (prefers-reduced-motion → motion token 0 ms; "Match system" theme follows colour scheme live)
 *   ST-07 UI scale independent of the display scale (device scale factor 1 vs 2) and of browser zoom emulation
 *   FF-22 Writer Track Changes through the UI, saved bytes checked by the independent lxml oracle
 * Ground truth: persisted desktop state (/api/state), computed styles, saved bytes — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt56.mts
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
const RUN = `t56${Date.now().toString(36)}`;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e56-"));
const { test, finish } = makeHarness("e2e-tt56");
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

// TT60: these tests use the classic desktop (its right-click menu, the Apps button); an earlier suite may leave the Tabletop on
await setSetting("appearance.desktopView", "classic");
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

await test("WM-05 MRU after 5 focus changes, held-chord switcher: overlay lists MRU order, chord advances, Shift reverses, release commits, Esc cancels", { "WM-05": "full" }, async () => {
  const W = [win("m1", "calculator", 0, 1, "Calc A"), win("m2", "clock", 1), win("m3", "notes", 2), win("m4", "planner", 3), win("m5", "calculator", 4, 1, "Calc B"), win("m6", "editor", 5), win("m7", "terminal", 0, 2)];
  await putDesktop(W);
  const page = await newPage();
  for (const w of W.slice(0, 6)) await page.locator(`.fs-window[aria-label="${w.title}"]`).first().waitFor();
  // 5 focus changes through real title-bar clicks
  const seq = ["Notes", "Calc A", "Calc B", "Clock", "Planner"];
  for (const t of seq) { await focusByTitle(page, t); await page.waitForTimeout(120); }
  const want = ["Planner", "Clock", "Calc B", "Calc A", "Notes"];
  const tid = (t: string) => W.find((w) => w.title === t)!.id;
  await poll(async () => { const s = await server(); return JSON.stringify((s.mru ?? []).filter((id: string) => id !== "m7" && id !== "m6").slice(0, 5)) === JSON.stringify(want.map(tid)); }, "persisted MRU after 5 focus changes = Planner Clock CalcB CalcA Notes");
  // overlay: hold Control, press `
  await page.keyboard.down("Control");
  await page.keyboard.press("Backquote");
  await page.getByTestId("switcher").waitFor();
  const opts = await options(page);
  eq(opts.slice(0, 5), want, "overlay window order (MRU)");
  eq(opts.length, 6, "6 windows on workspace 1 (workspace 2's Terminal excluded)");
  eq(await selected(page), "w:" + tid("Clock"), "previous window preselected");
  ok(((await page.getByTestId("switcher-live").textContent()) ?? "").includes("Clock, 2 of 6"), "live text");
  await page.keyboard.press("Backquote"); eq(await selected(page), "w:" + tid("Calc B"), "chord advances");
  await page.keyboard.press("Shift+Backquote"); eq(await selected(page), "w:" + tid("Clock"), "Shift reverses");
  await page.keyboard.press("Backquote"); await page.keyboard.press("Backquote"); eq(await selected(page), "w:" + tid("Calc A"), "advance twice");
  ok(((await server()).focus) === tid("Planner"), "nothing focused while the switcher is held");
  await page.keyboard.up("Control");
  await page.getByTestId("switcher").waitFor({ state: "detached" });
  await poll(async () => { const s = await server(); return s.focus === tid("Calc A") && s.mru[0] === tid("Calc A") && s.mru[1] === tid("Planner"); }, "release committed Calc A (server focus + MRU head)");
  // Esc cancels
  await page.keyboard.down("Control"); await page.keyboard.press("Backquote"); await page.getByTestId("switcher").waitFor();
  await page.keyboard.press("Escape"); await page.keyboard.up("Control");
  await page.getByTestId("switcher").waitFor({ state: "detached" });
  await page.waitForTimeout(700);
  eq((await server()).focus, tid("Calc A"), "Esc changed nothing");
  // one press + release toggles between the two most recent
  await page.keyboard.down("Control"); await page.keyboard.press("Backquote"); await page.keyboard.up("Control");
  await poll(async () => (await server()).focus === tid("Planner"), "quick Ctrl+` toggles to the previous window");
  await page.context().close();
});

await test("WM-05 modes: app mode groups windows by app (2 calculators → 1 entry), workspace mode switches workspace on release; ←/→ and 1/2/3 change mode", { "WM-05": "full" }, async () => {
  const W = [win("a1", "calculator", 0, 1, "Calc A"), win("a2", "clock", 1), win("a3", "calculator", 2, 1, "Calc B"), win("a4", "terminal", 0, 2)];
  await putDesktop(W);
  const page = await newPage();
  await page.locator('.fs-window[aria-label="Calc B"]').first().waitFor();
  for (const t of ["Calc A", "Clock", "Calc B"]) { await focusByTitle(page, t); await page.waitForTimeout(120); }
  await page.keyboard.down("Control"); await page.keyboard.press("Backquote"); await page.getByTestId("switcher").waitFor();
  await page.keyboard.press("ArrowRight");
  ok(await page.getByRole("button", { name: /Apps/ }).getAttribute("aria-pressed") === "true", "Apps mode pressed");
  eq(await options(page), ["Calculator", "Clock"], "app entries, MRU");
  ok(((await page.getByTestId("switcher-list").locator("[role=option]").first().textContent()) ?? "").includes("2 windows"), "calculator shows 2 windows");
  eq(await selected(page), "a:clock", "previous app preselected");
  await page.keyboard.press("Digit3");
  eq(await options(page), ["Main", "Second"], "workspace entries");
  eq(await selected(page), "s:2", "the other workspace preselected");
  await page.keyboard.up("Control");
  await poll(async () => (await server()).activeWorkspace === 2, "release switched to workspace 2 (server)");
  await page.keyboard.down("Control"); await page.keyboard.press("Backquote"); await page.keyboard.press("Digit3");
  eq(await options(page), ["Second", "Main"], "workspace MRU now Second, Main");
  await page.keyboard.up("Control");
  await poll(async () => (await server()).activeWorkspace === 1, "and back to Main");
  await page.context().close();
});

await test("WM-05 modal failure test: with an ask dialog open the switcher chord does nothing (no overlay, focus unchanged)", { "WM-05": "full" }, async () => {
  await putDesktop([win("b1", "clock", 0), win("b2", "notes", 1)]);
  const page = await newPage();
  await page.locator('.fs-window[aria-label="Notes"]').first().waitFor();
  await focusByTitle(page, "Clock"); await focusByTitle(page, "Notes");
  await poll(async () => (await server()).focus === "b2", "Notes focused");
  await page.mouse.click(1300, 760, { button: "right" });
  await page.getByRole("menuitem", { name: /New text file/ }).click();
  const ask = page.locator(".fs-ask").first(); await ask.waitFor();
  await page.keyboard.down("Control"); await page.keyboard.press("Backquote"); await page.keyboard.up("Control");
  await page.waitForTimeout(600);
  eq(await page.getByTestId("switcher").count(), 0, "no switcher behind the modal");
  eq((await server()).focus, "b2", "focus unchanged");
  await page.keyboard.press("Escape"); await ask.waitFor({ state: "detached" });
  await page.context().close();
});

await test("NC-06 OSD: 20 volume changes in a burst → the pill tracks every step, the polite live region changes exactly once (settled value)", { "NC-06": "full" }, async () => {
  await putDesktop([]);
  const page = await newPage();
  const live = page.getByTestId("osd-live");
  eq(await live.getAttribute("aria-live"), "polite", "aria-live=polite"); eq(await live.getAttribute("role"), "status", "role=status");
  const r = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="osd-live"]')!;
    let changes = 0; const seen: string[] = [];
    const mo = new MutationObserver(() => { changes++; seen.push(el.textContent ?? ""); });
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    const a = document.createElement("audio"); document.body.appendChild(a);
    const bars: string[] = [];
    for (let i = 1; i <= 20; i++) {
      a.volume = i / 20 * 0.9;
      await new Promise((res) => setTimeout(res, 40));
      const bar = document.querySelector('[data-testid="osd-bar"]') as HTMLElement | null; bars.push(bar?.style.width ?? "");
    }
    await new Promise((res) => setTimeout(res, 1200));
    mo.disconnect(); a.remove();
    return { changes, seen, bars, pillKind: document.querySelector('[data-testid="osd"]')?.getAttribute("data-kind") ?? null };
  });
  eq(r.changes, 1, `live-region changes (${JSON.stringify(r.seen)})`);
  eq(r.seen[0], "Volume 90%", "settled announcement");
  eq(r.bars[19], "90%", "pill bar at the final value"); ok(new Set(r.bars).size >= 15, "pill updated on (almost) every step");
  // text size through the real Quick panel → OSD text, also announced once
  await page.keyboard.press("Meta+i");
  const before = Number(((await page.getByTestId("quick-textscale").textContent()) ?? "").replace(/\D+/g, ""));
  await page.getByRole("button", { name: "A+ larger text" }).click();
  await page.getByTestId("osd").waitFor();
  eq(await page.getByTestId("osd").getAttribute("data-kind"), "text", "text-size OSD");
  await poll(async () => /^Text size \d+%$/.test(((await live.textContent()) ?? "").trim()), "text-size announcement");
  const after = Number(((await live.textContent()) ?? "").replace(/\D+/g, ""));
  ok(after > before, `text size grew ${before} → ${after}`);
  await page.getByRole("button", { name: "A− smaller text" }).click();
  await poll(async () => ((await live.textContent()) ?? "").includes(`${before}%`), "restored");
  await page.context().close();
});

await test("WM-10 focus mode: Meta+Shift+F sets ONE parent CSS variable; unfocused windows read it (opacity .45), the focused one stays 1; OSD; toggles back", { "WM-10": "full", "NC-06": "full" }, async () => {
  await putDesktop([win("f1", "clock", 0), win("f2", "notes", 1)]);
  const page = await newPage();
  await page.locator('.fs-window[aria-label="Notes"]').first().waitFor();
  await focusByTitle(page, "Notes");
  const look = () => page.evaluate(() => {
    const root = document.documentElement;
    const op = (t: string) => getComputedStyle(document.querySelector(`.fs-window[aria-label="${t}"]`)!).opacity;
    return { v: root.style.getPropertyValue("--fs-focus-dim").trim(), mode: root.dataset.focusMode, clock: op("Clock"), notes: op("Notes") };
  });
  eq(await look(), { v: "1", mode: "off", clock: "1", notes: "1" }, "off");
  await page.keyboard.press("Meta+Shift+F");
  await poll(async () => JSON.stringify(await look()) === JSON.stringify({ v: "0.45", mode: "on", clock: "0.45", notes: "1" }), "on: variable .45, unfocused dimmed, focused 1");
  await poll(async () => (await server()).focusMode === true, "persisted focusMode");
  await poll(async () => ((await page.getByTestId("osd-live").textContent()) ?? "") === "Focus mode on", "OSD announces focus mode");
  // the dimming is driven by the variable alone: changing it on the root changes every unfocused window
  await page.evaluate(() => document.documentElement.style.setProperty("--fs-focus-dim", "0.3"));
  eq((await look()).clock, "0.3", "single variable drives the dimming");
  await page.keyboard.press("Meta+Shift+F");
  await poll(async () => (await look()).v === "1" && (await look()).clock === "1", "off again");
  await page.context().close();
});

await test("ST-05 OS media queries: prefers-reduced-motion → motion token 0 ms (transitions 0 s); “Match system” theme follows prefers-color-scheme live", { "ST-05": "full" }, async () => {
  await putDesktop([]);
  const page = await newPage({ reducedMotion: "reduce" });
  const tok = () => page.evaluate(() => ({ motion: getComputedStyle(document.documentElement).getPropertyValue("--fs-motion").trim(), btn: getComputedStyle(document.querySelector(".fs-btn")!).transitionDuration }));
  const red = await tok(); eq(ms(red.motion), 0, `reduced motion token (${red.motion})`); ok(red.btn.split(",").every((d) => parseFloat(d) === 0), `button transitions ${red.btn}`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  eq(ms((await tok()).motion), 160, "default motion token (ms)");
  const put = await setSetting("appearance.theme", "system"); eq([put.status, put.json?.ok], [200, true], "server accepts the 'system' theme value");
  try {
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByTestId("launcher-button").waitFor({ timeout: 30_000 });
    const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themeSource, getComputedStyle(document.body).backgroundColor]);
    await poll(async () => (await theme())[0] === "light", "system light");
    const [, src, lightBg] = await theme(); eq(src, "system", "theme source");
    await page.emulateMedia({ colorScheme: "dark" });
    await poll(async () => (await theme())[0] === "dark", "live switch to dark without reload");
    ok((await theme())[2] !== lightBg, "background token changed");
  } finally { await setSetting("appearance.theme", "dark"); }
  await page.context().close();
});

await test("ST-07 UI scale is independent of the display: device scale factor 1 vs 2 (external HiDPI display / browser-zoom emulation) gives the same CSS text size; the app's own scale changes it", { "ST-07": "full" }, async () => {
  await putDesktop([]);
  const measure = async (p: Page) => p.evaluate(() => ({ dpr: devicePixelRatio, ts: getComputedStyle(document.documentElement).getPropertyValue("--fs-ts").trim(), body: getComputedStyle(document.body).fontSize, btn: getComputedStyle(document.querySelector(".fs-btn")!).fontSize }));
  const p1 = await newPage({ dsf: 1 }), p2 = await newPage({ dsf: 2 });
  const a = await measure(p1), b = await measure(p2);
  eq([a.dpr, b.dpr], [1, 2], "device pixel ratios");
  eq([a.ts, a.body, a.btn], [b.ts, b.body, b.btn], "same UI scale and CSS font sizes on both displays");
  // Chromium's page zoom is a device-scale change for layout; emulate it on the live page through CDP
  const cdp = await p1.context().newCDPSession(p1);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
  const z = await measure(p1); eq([z.dpr, z.ts, z.body], [1.5, a.ts, a.body], "zoom emulation leaves the root font token alone");
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  // the app's own text scale (Quick panel) is the only thing that moves it
  await p1.keyboard.press("Meta+i");
  await p1.getByRole("button", { name: "A+ larger text" }).click();
  await poll(async () => (await measure(p1)).ts !== a.ts, "text scale changed --fs-ts");
  const c = await measure(p1); ok(parseFloat(c.body) > parseFloat(a.body) && c.dpr === 1, `app scale grew the text (${a.body} → ${c.body}) without touching DPR`);
  await p1.getByRole("button", { name: "A− smaller text" }).click();
  await poll(async () => (await measure(p1)).ts === a.ts, "restored");
  await p1.context().close(); await p2.context().close();
});

await test("FF-22 Writer Track Changes in the UI: toggle, type, delete, review panel per-change accept; saved bytes verified by the lxml oracle", { "FF-22": "full" }, async () => {
  const d = await blankWord("t"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Alpha beta gamma.");
  const path = `/Documents/${RUN}-track.docx`;
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
  await para.click(); await page.keyboard.press("End"); await page.keyboard.type(" Delta");
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Backspace");
  await poll(async () => (await body.locator(".wrev-ins").count()) >= 1 && (await body.locator(".wrev-del").count()) >= 1, "ins + del rendered");
  eq((await body.locator(".wrev-del").first().textContent())?.trim(), "Alpha", "struck text stays visible");
  const items = dlg.getByTestId("writer-changes").locator("[role=listitem]");
  await poll(async () => (await items.count()) === 2, "two changes listed");
  await page.keyboard.press("Control+s");
  await dlg.getByTestId("writer-status").filter({ hasText: "Saved" }).waitFor({ timeout: 15_000 });
  const read = async () => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };
  const oracle = (buf: Buffer) => { const f = join(tmp, `o${Date.now()}.docx`); writeFileSync(f, buf); return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_track.py", f], { encoding: "utf8" })); };
  const author = String((await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === "profile.name")?.value ?? "Fusion user");
  let o = oracle(await read());
  eq(o.track, true, "trackRevisions saved");
  eq(o.revs.map((r: { kind: string; text: string; author: string }) => [r.kind, r.text, r.author]).sort(), [["del", "Alpha ", author], ["ins", " Delta", author]].sort(), "saved revisions");
  eq([o.accept_text, o.reject_text], ["beta gamma. Delta", "Alpha beta gamma."], "oracle accept/reject views");
  // accept just the deletion
  const delItem = items.filter({ hasText: "Deleted" }).first();
  await delItem.getByRole("button", { name: /^Accept/ }).click();
  await poll(async () => (await body.locator(".wrev-del").count()) === 0 && (await items.count()) === 1, "deletion accepted, insertion still pending");
  // turn tracking off from the keyboard; untracked typing adds no revision
  await para.click(); await page.keyboard.press("Control+Shift+E");
  await dlg.getByTestId("writer-track-chip").waitFor({ state: "detached" });
  await page.keyboard.press("End"); await page.keyboard.type("!");
  await page.keyboard.press("Control+s");
  await poll(async () => { o = oracle(await read()); return o.track === false && o.revs.length === 1; }, "saved: tracking off, one pending insertion");
  eq([o.accept_text, o.reject_text], ["beta gamma. Delta!", "beta gamma.!"], "after per-change accept + untracked edit");
  await page.context().close();
});

await test("FF-20 Spreadsheet Paste Special in the UI: Ctrl+C → Ctrl+Shift+V → Values + Transpose, then Values + Add; Save → openpyxl reads literal values at the transposed cells", { "FF-20": "full" }, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  sh.setCell(0, 0, "2"); sh.setCell(0, 1, "3"); sh.setCell(0, 2, "=A1*A2"); sh.setCell(1, 0, "10"); sh.setCell(1, 2, "20");
  wb.recalculate(); const orig = writeXlsxWorkbook(wb);
  const src = `/Documents/${RUN}-paste.xlsx`;
  const up = await api("POST", "/api/fs", { op: "upload", path: src, content: Buffer.from(orig).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); ok(up.status < 300, `upload ${up.status}`);
  await putDesktop([]);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=sheet&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first(); await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
  const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
  const txt = async (r: string) => (await cell(r).innerText()).trim();
  await cell("A1").click(); await cell("B3").click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  await cell("D1").click(); await page.keyboard.press("Control+Shift+V");
  const ps = dlg.getByTestId("paste-special"); await ps.waitFor();
  await ps.getByLabel("Values").check(); await ps.getByLabel("Transpose").check();
  await page.screenshot({ path: "docs/screens/tt56-paste-special.png" });
  await ps.getByRole("button", { name: "Paste", exact: true }).click();
  eq([await txt("D1"), await txt("E1"), await txt("F1"), await txt("D2"), await txt("E2"), await txt("F2")], ["2", "3", "6", "10", "", "20"], "transposed values in the grid");
  await cell("A1").click(); await cell("A2").click({ modifiers: ["Shift"] }); await page.keyboard.press("Control+c");
  await cell("D1").click(); await page.keyboard.press("Control+Shift+V"); await ps.waitFor();
  await ps.getByLabel("Transpose").uncheck(); await ps.getByLabel("Operation").selectOption("add");
  await ps.getByRole("button", { name: "Paste", exact: true }).click();
  eq([await txt("D1"), await txt("D2")], ["4", "13"], "values added to the targets");
  // modal shortcut: Escape inside the panel closes the panel only — the Spreadsheet window stays open, nothing is pasted
  await page.keyboard.press("Control+Shift+V"); await ps.waitFor(); await ps.getByLabel("Values").focus(); await page.keyboard.press("Escape");
  await poll(async () => (await ps.count()) === 0, "panel closed by Escape"); ok(await dlg.isVisible(), "Spreadsheet window still open after Escape");
  eq([await txt("D1"), await txt("D2")], ["4", "13"], "Escape pasted nothing");
  await dlg.getByRole("button", { name: "Save workbook" }).click();
  let saved = new Uint8Array();
  await poll(async () => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(src)}`); saved = Uint8Array.from(Buffer.from(r.json.node.content, "base64")); return Buffer.compare(Buffer.from(saved), orig) !== 0; }, "saved bytes changed");
  await ctx.close();
  const f = join(tmp, "paste.xlsx"); writeFileSync(f, saved);
  const o = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", "import json,sys,openpyxl; ws=openpyxl.load_workbook(sys.argv[1]).active; print(json.dumps({c: ws[c].value for c in ['D1','E1','F1','D2','E2','F2','A3']}))", f], { encoding: "utf8" }).trim());
  eq(o, { D1: 4, E1: 3, F1: 6, D2: 13, E2: null, F2: 20, A3: "=A1*A2" }, "openpyxl: literal values (F1 is the value 6, not a formula), source formula intact");
  for (const op of ["trash", "purge"]) await api("POST", "/api/fs", { op, path: src });
});

await test("no uncaught page errors during the TT56 session", { "WM-05": "full" }, () => { eq(errors, [], "page errors"); });

await browser.close();
{
  const r = await fetch(`${BASE}/api/fs?op=list&path=/Documents`).then((x) => x.json()) as { nodes?: { path: string }[] };
  for (const n of r.nodes ?? []) if (n.path.startsWith(`/Documents/${RUN}-`)) for (const op of ["trash", "purge"]) await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, path: n.path }) });
}
await putDesktop([]);
await finish();
process.exit(0);
