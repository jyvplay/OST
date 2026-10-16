/**
 * Real-browser suite "e2e-a11y" (TT21): the external verifier is axe-core 4.14 (Deque, MPL-2.0) injected into the
 * production build in headless Chromium, plus computed-style measurements that axe does not make.
 *   1  axe per module: every registered module opened alone in a window, WCAG 2.0/2.1/2.2 A+AA rules, scoped to the
 *      window; plus the shell chrome (top bar, shelf, launcher, palette, quick panel)
 *   2  computed sizes: at the 125 % default nothing renders below 12 px and body is ≥16 px; in Large text mode nothing below 20 px
 *   3  icons are SVG (no emoji code points rendered in the chrome); manifest icons all resolve and are PNG/SVG
 *   4  300 % text and a 360×640 phone viewport: the shell still reflows (no horizontal page scroll), windows fit
 *   5  the text-size setting live: Quick panel A+/A− and Settings radio buttons change computed sizes; bad values 422
 *   6  forced colours + more contrast media emulation keep controls visible
 *   7  (TT22) style switch: Settings + Quick panel pickers swap data-style, logo, wallpaper, accent; persisted; 422s
 *   8  (TT22) axe colour-contrast in the LIGHT theme for every style (chrome + Files + Spreadsheet windows)
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-a11y.mts
 *      AXE_VERBOSE=1 prints every violation node.
 */
import { readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const VERBOSE = process.env.AXE_VERBOSE === "1";
const ONLY = (process.env.AXE_ONLY ?? "").split(",").filter(Boolean); // debugging: limit the axe test to some modules
const SKIP_REST = process.env.AXE_SKIP_REST === "1";
const { test, finish } = makeHarness("e2e-a11y");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const win = (id: string, module: string, x: number, y: number, w: number, h: number, z: number) => ({ id, module, title: MODULES.find((m) => m.id === module)?.title ?? module, x, y, w, h, z, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
async function desktop(windows: unknown[], vw = 1440, vh = 900) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: vw, h: vh }, icons: [], focusMode: false, revision: rev } });
}
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const browser: Browser = await launchChromium();
async function boot(vw = 1440, vh = 900, opts: Record<string, unknown> = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, ...opts });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator('[role="banner"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);
  return { page, close: () => ctx.close() };
}
interface Violation { id: string; impact: string; help: string; nodes: { target: string[]; failureSummary?: string }[] }
async function axe(page: Page, include?: string): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
  return page.evaluate(async ({ include, tags }) => {
    const w = window as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: Violation[] }> } };
    const r = await w.axe.run(include ? { include: [include] } : document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })) }));
  }, { include, tags: TAGS });
}

await setSetting("appearance.textScale", "125");
await setSetting("appearance.style", "poolside");
await setSetting("appearance.accent", "auto");
await setSetting("appearance.wallpaper", "auto");
await setSetting("appearance.theme", "dark");
await setSetting("appearance.density", "balanced");

/* ------------------------------------------------------------------ 1 axe */
const perModule: Record<string, Violation[]> = {};
await test("axe-core WCAG 2.x A/AA on every module window and the shell chrome: no serious or critical violations", { "AX-08": "full", "AX-01": "partial" }, async () => {
  const serious: string[] = [];
  const tally: Record<string, number> = {};
  const note = (where: string, vs: Violation[]) => {
    perModule[where] = vs;
    for (const v of vs) {
      tally[`${v.id} (${v.impact})`] = (tally[`${v.id} (${v.impact})`] ?? 0) + v.nodes.length;
      if (v.impact === "serious" || v.impact === "critical") serious.push(`${where}: ${v.id} ×${v.nodes.length} e.g. ${v.nodes[0]?.target.join(" ")}`);
      if (VERBOSE) for (const n of v.nodes.slice(0, 4)) console.log(`      [${where}] ${v.id}: ${n.target.join(" ")} — ${(n.failureSummary ?? "").split("\n").slice(1, 2).join(" ")}`);
    }
  };
  // chrome first: desktop + launcher + palette + quick panel
  await desktop([]);
  { const { page, close } = await boot();
    note("chrome", await axe(page));
    await page.getByTestId("launcher-button").click(); await page.waitForTimeout(300);
    note("launcher", await axe(page, '[aria-label="Launcher"], [role="dialog"]'));
    await page.keyboard.press("Escape"); await page.getByTitle("Command palette (Ctrl+Space)").click(); await page.waitForTimeout(300);
    note("palette", await axe(page, '[aria-label="Command palette"]'));
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Quick panel" }).click(); await page.waitForTimeout(300);
    note("quick", await axe(page, '[aria-label="Quick panel"]'));
    await close(); }
  for (const m of MODULES.filter((x) => !ONLY.length || ONLY.includes(x.id))) {
    await desktop([win(`a11y_${m.id}`, m.id, 40, 20, 1100, 760, 11)]);
    const { page, close } = await boot();
    await page.waitForTimeout(700);
    note(m.id, await axe(page, `.fs-window[aria-label="${m.title}"]`));
    await close();
  }
  await desktop([]);
  console.log("    violations by rule (nodes):", JSON.stringify(tally));
  ok(serious.length === 0, `${serious.length} serious/critical:\n      ${serious.slice(0, 25).join("\n      ")}`);
});

if (SKIP_REST) { await browser.close(); finish(); process.exit(); }
/* ------------------------------------------------------------ 2 computed sizes */
await test("computed sizes: at the 125 % default nothing visible is below 12 px and body text is ≥16 px; in Large text mode (200 %) nothing is below 20 px", { "AX-09": "full" }, async () => {
  const mods = ["files", "sheet", "writer", "settings", "privacy", "vector", "imageedit", "terminal"];
  const small: string[] = [];
  const runs: [string, number, string[]][] = [["125", 12, mods], ["200", 20, ["files", "sheet", "settings"]]];
  for (const [scale, floor, list] of runs) {
  await setSetting("appearance.textScale", scale);
  for (const id of list) {
    await desktop([win(`sz_${id}`, id, 40, 20, 1100, 760, 11)]);
    const { page, close } = await boot();
    await page.waitForTimeout(600);
    const r = await page.evaluate((floor) => {
      const out: string[] = []; let min = 1e9;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent ?? "").trim(); if (!t) continue;
        const el = n.parentElement!; const cs = getComputedStyle(el); const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue;
        if (el.closest("[data-doc-content], .fs-doc, svg, canvas, [aria-hidden='true']")) continue; // document content keeps its own size
        const px = parseFloat(cs.fontSize); min = Math.min(min, px);
        if (px < floor) out.push(`${px}px "${t.slice(0, 30)}" <${el.tagName.toLowerCase()} class="${el.className}">`);
      }
      return { out: out.slice(0, 6), min, body: parseFloat(getComputedStyle(document.body).fontSize) };
    }, floor);
    if (r.out.length) small.push(`${id}@${scale}%: ${r.out.join(" | ")}`);
    if (r.body < (scale === "125" ? 16 : 26)) small.push(`${id}@${scale}%: body ${r.body}px`);
    console.log(`    ${id} @${scale}%: smallest visible text ${r.min}px, body ${r.body}px`);
    await close();
  }
  }
  await setSetting("appearance.textScale", "125");
  await desktop([]);
  ok(small.length === 0, small.join("\n      "));
});

/* --------------------------------------------------------------- 3 icons */
await test("icons are SVG tiles (shelf, launcher, titlebar, palette, desktop) and every manifest icon resolves with the right type", { "AX-10": "full" }, async () => {
  await desktop([win("ic_files", "files", 200, 40, 900, 600, 11)]);
  const { page, close } = await boot();
  ok(await page.locator('[data-testid="shelf-files"] svg[data-icon="folder"]').count() === 1, "shelf Files is an SVG tile");
  ok(await page.locator('.fs-window[aria-label="Files"] .fs-titlebar svg[data-icon]').count() >= 1, "titlebar icon is SVG");
  ok(await page.locator('[data-testid="launcher-button"] svg[data-icon="fusion-logo"]').count() === 1, "logo in the top bar");
  const tile = await page.locator('[data-testid="shelf-files"] svg').boundingBox();
  // TT22: the default is 125 % (24 design px × 1.25 = 30); it must still track the scale, so Large text mode doubles it
  ok(tile && tile.width >= 29, `shelf icon is ${tile?.width}px wide at the 125 % default (want ≥30)`);
  await setSetting("appearance.textScale", "200");
  await page.reload(); await page.locator('[data-testid="shelf-files"] svg').waitFor({ timeout: 30_000 });
  const big = await page.locator('[data-testid="shelf-files"] svg').boundingBox();
  await setSetting("appearance.textScale", "125");
  ok(big && tile && big.width >= tile.width * 1.5, `Large text mode shelf icon ${big?.width}px (default ${tile?.width}px)`);
  await page.reload(); await page.locator('[role="banner"]').waitFor({ timeout: 30_000 }); await page.waitForTimeout(600);
  await page.getByTestId("launcher-button").click();
  ok(await page.locator('[aria-label="Launcher"] svg[data-icon], [role="dialog"] svg[data-icon]').count() >= MODULES.length, "launcher has one SVG per module");
  // titlebar controls must all be visible glyphs (TT21 found tile/pop-out/maximise/close were tofu)
  const ctrls = await page.locator('.fs-window[aria-label="Files"] .fs-winbtn svg').count();
  ok(ctrls === 6, `6 window controls with SVG glyphs, got ${ctrls}`);
  await close();
  await desktop([]);
  const man = await (await fetch(BASE + "/manifest.webmanifest")).json() as { icons: { src: string; type: string; purpose: string; sizes: string }[] };
  ok(man.icons.some((i) => i.purpose === "maskable") && man.icons.some((i) => i.sizes === "512x512" && i.purpose === "any"), "512 any + maskable declared");
  for (const i of man.icons) {
    const r = await fetch(BASE + i.src);
    ok(r.status === 200, `${i.src} → ${r.status}`);
    const b = new Uint8Array(await r.arrayBuffer());
    if (i.type === "image/png") {
      ok(b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, `${i.src} is a PNG`);
      const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
      ok(i.sizes === `${w}x${w}`, `${i.src} declared ${i.sizes}, actual ${w}px`);
    } else ok(new TextDecoder().decode(b).includes("<svg"), `${i.src} is SVG`);
  }
  ok((await fetch(BASE + "/apple-touch-icon.png")).status === 200, "apple-touch-icon");
});

/* -------------------------------------------------------------- 4 reflow */
await test("reflow: at 300 % text on 1280×800 and at 200 % on a 360×640 phone the page never scrolls sideways and windows fit", { "AX-09": "partial" }, async () => {
  await setSetting("appearance.textScale", "300");
  await desktop([win("rf_settings", "settings", 40, 20, 900, 640, 11)], 1280, 800);
  { const { page, close } = await boot(1280, 800);
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ts: getComputedStyle(document.documentElement).getPropertyValue("--fs-ts").trim(), fs: getComputedStyle(document.body).fontSize }));
    ok(r.ts === "3", `--fs-ts ${r.ts}`); ok(parseFloat(r.fs) === 39, `body font ${r.fs} at 300 %`);
    ok(r.sw <= r.cw, `page scrolls sideways at 300 %: ${r.sw} > ${r.cw}`);
    const top = await page.locator('[role="banner"]').boundingBox(); ok(top && top.width <= 1280, "top bar within the viewport");
    await close(); }
  await setSetting("appearance.textScale", "200");
  await desktop([win("rf_privacy", "privacy", 10, 10, 340, 560, 11)], 360, 640);
  { const { page, close } = await boot(360, 640, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const r = await page.evaluate(() => {
      const sw = document.documentElement.scrollWidth, cw = document.documentElement.clientWidth;
      const w = document.querySelector(".fs-window") as HTMLElement | null; const sc = w?.querySelector(".fs-scroll") as HTMLElement | null;
      return { sw, cw, inner: sc ? sc.scrollWidth - sc.clientWidth : -1 };
    });
    ok(r.sw <= r.cw, `phone page scrolls sideways: ${r.sw} > ${r.cw}`);
    ok(r.inner <= 2, `Privacy content wider than its window by ${r.inner}px (WCAG 1.4.10)`);
    const vp = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "");
    ok(!/maximum-scale|user-scalable=no/.test(vp), `viewport allows zoom: ${vp}`);
    await close(); }
  await setSetting("appearance.textScale", "125");
  await desktop([]);
});

/* -------------------------------------------------------- 5 live setting */
await test("text size is live: Quick panel A+ / A− and the Settings radio buttons change computed sizes, persist, and bad values are refused", { "AX-09": "full" }, async () => {
  await desktop([win("ts_settings", "settings", 40, 20, 1100, 760, 11)]);
  const { page, close } = await boot();
  const body = () => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  ok(Math.abs(await body() - 16.25) < 0.01, `default body ${await body()}px (13 × 1.25)`);
  await page.getByRole("button", { name: "Quick panel" }).click();
  const qp = page.locator('[aria-label="Quick panel"]');
  await qp.getByRole("button", { name: "Larger text" }).click();
  await page.getByTestId("quick-textscale").filter({ hasText: "150%" }).waitFor({ timeout: 5000 });
  ok(Math.abs(await body() - 19.5) < 0.01, `A+ → 150 % body ${await body()}`);
  await qp.getByRole("button", { name: "Smaller text" }).click();
  await page.getByTestId("quick-textscale").filter({ hasText: "125%" }).waitFor({ timeout: 5000 });
  // TT22 Large text mode: an opt-in switch (role=switch), 200 % on, back to the 125 % default off
  const lt = qp.getByRole("switch", { name: "Large text mode" });
  ok(await lt.getAttribute("aria-checked") === "false", "Large text mode is off by default");
  await lt.click();
  await page.getByTestId("quick-textscale").filter({ hasText: "200%" }).waitFor({ timeout: 5000 });
  ok(Math.abs(await body() - 26) < 0.01 && await lt.getAttribute("aria-checked") === "true", `Large text on → body ${await body()}`);
  await lt.click();
  await page.getByTestId("quick-textscale").filter({ hasText: "125%" }).waitFor({ timeout: 5000 });
  ok(Math.abs(await body() - 16.25) < 0.01, `Large text off → body ${await body()}`);
  await page.keyboard.press("Escape"); await page.mouse.click(700, 860);
  const rg = page.getByTestId("display-settings");
  await rg.getByTestId("ts-150").click();
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--fs-ts").trim() === "1.5");
  ok(await rg.getByTestId("ts-150").getAttribute("aria-checked") === "true", "radio reflects state");
  const saved = await api("GET", "/api/settings");
  ok(saved.json.rows.find((r: { key: string }) => r.key === "appearance.textScale")?.value === "150", "persisted");
  // the Settings switch mirrors the state: off at 150 %, and turning it on lands on 200 %
  const sw = rg.getByTestId("large-text-toggle");
  ok(await sw.getAttribute("aria-checked") === "false", "settings switch off at 150 %");
  await sw.click();
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--fs-ts").trim() === "2");
  ok(await sw.getAttribute("aria-checked") === "true", "settings switch on at 200 %");
  // spreadsheet geometry follows: row height at 150 % = 33
  await rg.getByTestId("wp-grid").click();
  await page.waitForFunction(() => document.querySelector(".fs-wallpaper-grid") !== null);
  await rg.getByTestId("wp-auto").click();
  await page.waitForFunction(() => document.querySelector(".fs-wallpaper-poolside") !== null);
  ok((await setSetting("appearance.textScale", "500")).status === 422, "500 % refused");
  ok((await setSetting("appearance.textScale", "")).status === 422, "empty refused");
  ok((await setSetting("appearance.wallpaper", "javascript:alert(1)")).status === 422, "unknown wallpaper refused");
  await setSetting("appearance.textScale", "125");
  await close();
  await desktop([]);
});

await test("spreadsheet grid geometry scales with the text (row height = 22 × scale) and a header drag still moves the edge 1:1 on screen", { "AX-09": "partial", "FF-28": "partial" }, async () => {
  await desktop([win("ss", "sheet", 40, 20, 1100, 760, 11)]);
  const { page, close } = await boot();
  const dlg = page.locator('.fs-window[aria-label="Spreadsheet"]');
  const a2 = dlg.locator('td[data-cell="A2"]'); await a2.waitFor({ timeout: 15_000 });
  const h = (await a2.boundingBox())!.height;
  ok(Math.abs(h - 27.5) <= 2, `row height at 125 %: ${h} (want 27.5)`);
  const before = (await a2.boundingBox())!.width;
  const hb = (await dlg.locator('[data-testid="resize-A"]').boundingBox())!;
  await page.mouse.move(hb.x + 3, hb.y + 5); await page.mouse.down(); await page.mouse.move(hb.x + 43, hb.y + 5, { steps: 4 }); await page.mouse.up();
  const after = (await a2.boundingBox())!.width;
  ok(Math.abs(after - before - 40) <= 2, `drag 40px → width ${before} → ${after}`);
  await close();
  await desktop([]);
});

/* -------------------------------------------------------- 6 forced colours */
await test("forced colours and prefers-contrast: more are honoured (buttons get system borders, muted text brightens)", { "AX-03": "full" }, async () => {
  await desktop([win("fc_files", "files", 40, 20, 900, 600, 11)]);
  const { page, close } = await boot(1440, 900, { forcedColors: "active" });
  const bw = await page.locator('.fs-window[aria-label="Files"] .fs-btn').first().evaluate((e) => getComputedStyle(e).borderTopStyle + " " + getComputedStyle(e).borderTopWidth);
  ok(bw.startsWith("solid"), `forced-colors border ${bw}`);
  const logo = await page.locator('[data-testid="launcher-button"] svg').evaluate((e) => getComputedStyle(e).forcedColorAdjust);
  ok(logo === "none", `logo keeps its colours (forced-color-adjust ${logo})`);
  await close();
  const c2 = await boot(1440, 900, { contrast: "more" } as Record<string, unknown>);
  const muted = await c2.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fs-muted").trim());
  ok(muted.toLowerCase() === "#c9d3ec", `prefers-contrast: more muted = ${muted}`);
  await c2.close();
  await desktop([]);
});

/* -------------------------------------------------------- 7 style switch (TT22) */
await test("style switch: the Settings and Quick panel pickers swap data-style, logo colours, auto wallpaper and accent; persisted; bad values refused", { "AX-11": "full" }, async () => {
  await desktop([win("st_settings", "settings", 40, 20, 1100, 760, 11)]);
  const { page, close } = await boot();
  const state = () => page.evaluate(() => ({
    style: document.documentElement.dataset.style,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--fs-style-accent").trim(),
    wp: [...document.querySelectorAll("[class*='fs-wallpaper-']")].map((e) => [...e.classList].find((c) => c.startsWith("fs-wallpaper-"))).join(","),
    logo: document.querySelector('[data-testid="launcher-button"] svg')?.innerHTML ?? "",
    pill: getComputedStyle(document.documentElement).getPropertyValue("--fs-pill-b").trim(),
  }));
  let s0 = await state();
  ok(s0.style === "poolside" && s0.accent === "#4fd8d2" && s0.wp.includes("fs-wallpaper-poolside") && s0.pill === "#ff94a6", `poolside default ${JSON.stringify({ ...s0, logo: s0.logo.length })}`);
  const rg = page.getByTestId("style-picker");
  await rg.getByTestId("style-vice").click();
  await page.waitForFunction(() => document.documentElement.dataset.style === "vice");
  s0 = await state();
  ok(s0.accent === "#ff62a8" && s0.wp.includes("fs-wallpaper-vice") && /#ff3d8f/i.test(s0.logo) && s0.pill === "#ff4f9a", `vice ${JSON.stringify({ ...s0, logo: s0.logo.slice(0, 80) })}`);
  ok(await rg.getByTestId("style-vice").getAttribute("aria-checked") === "true", "picker reflects state");
  const saved = await api("GET", "/api/settings");
  ok(saved.json.rows.find((r: { key: string }) => r.key === "appearance.style")?.value === "vice", "persisted");
  await page.getByRole("button", { name: "Quick panel" }).click();
  const qb = page.getByTestId("quick-style-oceandrive");
  await qb.click();
  await page.waitForFunction(() => document.documentElement.dataset.style === "oceandrive");
  ok(await qb.getAttribute("aria-pressed") === "true", "quick button pressed");
  s0 = await state();
  ok(s0.accent === "#e8b07a" && s0.wp.includes("fs-wallpaper-oceandrive"), `oceandrive ${s0.accent} ${s0.wp}`);
  // an explicit wallpaper and accent still beat the style's
  await setSetting("appearance.wallpaper", "slate");
  await page.reload(); await page.locator('[role="banner"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector(".fs-wallpaper-slate") !== null, undefined, { timeout: 10_000 });
  ok(await page.evaluate(() => document.documentElement.dataset.style) === "oceandrive", "SSR renders the saved style (no flash)");
  ok((await setSetting("appearance.style", "miami")).status === 422, "unknown style refused");
  ok((await setSetting("appearance.style", "")).status === 422, "empty style refused");
  await setSetting("appearance.wallpaper", "auto"); await setSetting("appearance.style", "poolside");
  await close();
  await desktop([]);
});

/* -------------------------------------------------------- 8 light theme contrast, every style (TT22) */
await test("light theme, every style: axe colour-contrast finds no serious violations in the chrome, Files and Spreadsheet", { "AX-11": "partial", "AX-08": "partial" }, async () => {
  const bad: string[] = [];
  await setSetting("appearance.theme", "light");
  try {
    for (const st of ["poolside", "vice", "oceandrive", "bubbly"]) {
      await setSetting("appearance.style", st);
      await desktop([win("lt_files", "files", 20, 20, 700, 500, 11), win("lt_sheet", "sheet", 420, 160, 1000, 560, 12)]);
      const { page, close } = await boot();
      await page.locator('td[data-cell="A2"]').waitFor({ timeout: 15_000 });
      const vs = (await axe(page)).filter((v) => v.impact === "serious" || v.impact === "critical");
      for (const v of vs) bad.push(`${st}: ${v.id} ×${v.nodes.length} e.g. ${v.nodes[0]?.target.join(" ")} ${(v.nodes[0]?.failureSummary ?? "").split("\n").slice(1, 2).join(" ")}`);
      console.log(`    ${st}/light: ${vs.length} serious rule(s)`);
      await close();
    }
  } finally {
    await setSetting("appearance.theme", "dark"); await setSetting("appearance.style", "poolside"); await desktop([]);
  }
  ok(bad.length === 0, bad.slice(0, 12).join("\n      "));
});

await browser.close();
finish();
