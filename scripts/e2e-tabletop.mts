/**
 * Real-browser suite "e2e-tabletop" (TT26): the Tabletop 3D desktop, piles, micro peeks and rearrangeable desktop
 * icons in headless Chromium against the production build. Driven through the UI (mouse drags, double-clicks,
 * keyboard) and checked by measured geometry, computed styles, the persisted desktop state and axe-core.
 * Creates its own files under /Documents (purged afterwards) and resets to the classic view.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tabletop.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { boxGeometry, PHI } from "../src/lib/tabletop-core.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test: test0, finish } = makeHarness("e2e-tabletop");
/** ONLY="substring" runs just the matching tests (diagnosis); the full suite runs by default */
const ONLY = process.env.ONLY ?? "";
const test: typeof test0 = (name, covers, fn) => (ONLY && !name.includes(ONLY) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const RUN = Date.now().toString(36);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const getSetting = async (key: string) => (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === key)?.value as string | undefined;
const getState = async () => (await api("GET", "/api/state?id=default")).json.row?.state as { table?: { piles: { paths: string[] }[]; cards: Record<string, unknown> }; icons?: { path: string; x: number; y: number }[] } | undefined;
async function desktop(windows: unknown[] = [], extra: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev, ...extra } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); }
const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
async function axe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  });
}
const browser: Browser = await launchChromium();
async function boot(vw = 1440, vh = 900, opts: Record<string, unknown> = {}) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, ...opts });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  await page.waitForTimeout(400);
  return { page, close: () => ctx.close() };
}
const box = async (l: Locator) => { const b = await l.boundingBox(); if (!b) throw new Error("no box"); return b; };
const card = (page: Page, path: string) => page.locator(`[data-testid="tt-card"][data-path="${path}"]`);
/** a visible point on a wall in box pose (avoids the switcher on the south wall) */
async function wallPoint(page: Page, w: string) {
  // the wall is a projected trapezoid: wait until its geometry stops moving (fold / camera transitions), then pick a
  // grid point inside its bounding box whose TOPMOST face really is that wall (hit-tested, not assumed)
  const loc = page.getByTestId(`tt-open-${w}`);
  let prev = "", pt: { x: number; y: number } | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const b = JSON.stringify(await box(loc));
    if (b === prev) {
      pt = await page.evaluate(([wall, bs]) => {
        const r = JSON.parse(bs) as { x: number; y: number; width: number; height: number };
        const order = wall === "north" || wall === "south" ? [[0.25, 0.5], [0.5, 0.5], [0.75, 0.5], [0.5, 0.3], [0.5, 0.7]] : [[0.5, 0.3], [0.5, 0.5], [0.3, 0.4], [0.7, 0.4], [0.5, 0.2], [0.5, 0.7]];
        for (const [fx, fy] of order) {
          const x = r.x + r.width * fx, y = r.y + r.height * fy;
          const top = document.elementsFromPoint(x, y).map((el) => el.closest("[data-face]") as HTMLElement | null).find((f) => f);
          if (top?.dataset.face === wall) return { x, y };
        }
        return null;
      }, [w, b] as const);
      if (pt) return pt;
    }
    prev = b;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`no hit-testable point on the ${w} wall`);
}
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  const a = await box(from);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + ((to.x - a.x - a.width / 2) * i) / 8, a.y + a.height / 2 + ((to.y - a.y - a.height / 2) * i) / 8);
  await page.mouse.up();
}

const F = { md: `/Documents/tt-${RUN}-notes.md`, csv: `/Documents/tt-${RUN}-data.csv`, a: `/Documents/tt-${RUN}-a.txt`, b: `/Documents/tt-${RUN}-b.txt` };
await api("POST", "/api/fs", { op: "write", path: F.md, content: "# Hello Peek\n\nA paragraph of text.\n- alpha item\n- beta item\n" });
await api("POST", "/api/fs", { op: "write", path: F.csv, content: 'city,temp\n"Raleigh, NC",72\nMiami,88\n' });
await api("POST", "/api/fs", { op: "write", path: F.a, content: "alpha card\n" });
await api("POST", "/api/fs", { op: "write", path: F.b, content: "beta card\n" });
await setSetting("appearance.layout", "fusion"); await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark");
await setSetting("appearance.textScale", "125"); await setSetting("appearance.motion", "on").catch(() => undefined);

try {
  await test("toggle: Quick panel switch replaces the desktop with the Tabletop (persisted); Settings → Desktop view brings Classic back", { "LY-07": "full" }, async () => {
    await setSetting("appearance.desktopView", "classic");
    await desktop([]);
    const { page, close } = await boot();
    ok(await page.getByTestId("desk-icons").count() === 1 && await page.getByTestId("tabletop").count() === 0, "starts classic");
    await page.getByRole("button", { name: "Quick panel" }).click();
    await page.getByRole("switch", { name: "Tabletop 3D desktop" }).click();
    await page.getByTestId("tabletop").waitFor({ timeout: 10_000 });
    ok(await page.getByTestId("desk-icons").count() === 0, "classic desktop surface replaced");
    await poll(async () => (await getSetting("appearance.desktopView")) === "tabletop", "persisted");
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("tabletop").waitFor({ timeout: 30_000 });
    await page.getByTestId("tt-nav").getByTestId("tt-classic").click();
    await page.getByTestId("desk-icons").waitFor({ timeout: 10_000 });
    await poll(async () => (await getSetting("appearance.desktopView")) === "classic", "classic persisted");
    await desktop([{ id: "set1", module: "settings", title: "Settings", x: 20, y: 10, w: 1200, h: 760, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("settings-view-tabletop").waitFor({ timeout: 30_000 });
    await page.getByTestId("settings-view-tabletop").check();
    await page.getByTestId("tabletop").waitFor({ timeout: 10_000 });
    await page.getByTestId("settings-view-classic").check();
    await page.getByTestId("desk-icons").waitFor({ timeout: 10_000 });
    ok((await setSetting("appearance.desktopView", "3d")).status === 422, "unknown view refused");
    await close();
  });

  await test("box geometry (straight-down camera): floor projected at p/(p+depth) and centred; four walls hinge on the screen edges (measured)", { "LY-07": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([], { table: { v: 2, cards: {}, piles: [], camera: "top" } });
    const { page, close } = await boot();
    const tt = await box(page.getByTestId("tabletop"));
    const g = boxGeometry(tt.width, tt.height);
    let fl = await box(page.getByTestId("tt-floor"));
    // the floor eases from its first-paint size once the ResizeObserver reports the real one: wait until it rests
    await poll(async () => { fl = await box(page.getByTestId("tt-floor")); return Math.abs(fl.width - tt.width * g.floorScale) <= 1.5 && Math.abs(fl.height - tt.height * g.floorScale) <= 1.5; }, "floor settled", 8000).catch(() => {});
    ok(Math.abs(fl.width - tt.width * g.floorScale) <= 3 && Math.abs(fl.height - tt.height * g.floorScale) <= 3, `floor ${fl.width}×${fl.height} vs ${tt.width * g.floorScale}`);
    ok(Math.abs(fl.x + fl.width / 2 - (tt.x + tt.width / 2)) <= 2 && Math.abs(fl.y + fl.height / 2 - (tt.y + tt.height / 2)) <= 2, "floor centred");
    const band = (tt.height / 2) * (1 - g.floorScale), side = (tt.width / 2) * (1 - g.floorScale);
    const walls = async () => Promise.all(["north", "south", "west", "east"].map((x) => box(page.getByTestId(`tt-wall-${x}`))));
    let [n, s, w, e] = await walls();
    // settle: under load the first frames can still be laying out
    await poll(async () => { [n, s, w, e] = await walls(); return Math.abs(s.y + s.height - (tt.y + tt.height)) <= 2 && Math.abs(s.height - band) <= 4 && Math.abs(n.height - band) <= 4; }, "walls settled", 5000).catch(() => {});
    ok(Math.abs(n.y - tt.y) <= 2 && Math.abs(n.height - band) <= 4, `north band at the top edge ${JSON.stringify(n)} ≈ ${band}`);
    ok(Math.abs(s.y + s.height - (tt.y + tt.height)) <= 2 && Math.abs(s.height - band) <= 4, `south band ${JSON.stringify(s)}`);
    ok(Math.abs(w.x - tt.x) <= 2 && Math.abs(w.width - side) <= 4 && Math.abs(e.x + e.width - (tt.x + tt.width)) <= 2 && Math.abs(e.width - side) <= 4, `side walls ${w.width} / ${e.width} ≈ ${side}`);
    const m = await page.getByTestId("tt-wall-north").evaluate((el) => getComputedStyle(el).transform);
    ok(m.startsWith("matrix3d("), `north wall is a 3D transform: ${m.slice(0, 40)}`);
    // the floor's content is counter-scaled: a card is 112 px wide on screen and golden
    const c = await box(page.getByTestId("tt-card").first());
    ok(Math.abs(c.width - 112) <= 1.5 && Math.abs(c.height / c.width - PHI) < 0.02, `card on screen ${c.width}×${c.height}`);
    // hits go to faces (the scene plane does not swallow them)
    const hit = await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest("[data-face]")?.getAttribute("data-face"), [tt.x + 30, tt.y + tt.height / 2]);
    ok(hit === "west", `point on the left wall hits the west face (${hit})`);
    await close();
  });

  await test("a wall becomes the main view: double-click unfolds it to fill the desk (others fold away, inert), Back / Esc / double-click its background return; switcher works too", { "LY-07": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([], { table: { v: 2, cards: {}, piles: [], camera: "top" } }); // side walls are slivers on the slant; this test is about the unfold mechanics
    const { page, close } = await boot();
    const tt = await box(page.getByTestId("tabletop"));
    const p = await wallPoint(page, "north");
    await page.mouse.dblclick(p.x, p.y);
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "north", "north is main");
    await poll(async () => { const b = await box(page.getByTestId("tt-wall-north")); return Math.abs(b.width - tt.width) <= 2 && Math.abs(b.height - tt.height) <= 2 && Math.abs(b.y - tt.y) <= 2; }, "north fills the desk", 6000);
    await poll(async () => (await page.getByTestId("tt-floor").evaluate((el) => getComputedStyle(el).opacity)) === "0", "floor faded away");
    ok(await page.getByTestId("tt-wall-west").getAttribute("aria-hidden") === "true" && await page.getByTestId("tt-wall-west").evaluate((el) => (el as HTMLElement).inert), "other walls hidden + inert");
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "tt-back", "focus on Back");
    await page.keyboard.press("Escape");
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "floor", "Esc → floor");
    await page.waitForTimeout(1200); // let the walls fold back before aiming at one
    const pw = await wallPoint(page, "west");
    await page.mouse.dblclick(pw.x, pw.y);
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "west", "west is main");
    await poll(async () => { const f = await box(page.getByTestId("tt-wall-west")); return Math.abs(f.width - tt.width) < 2; }, "west wall fully unfolded", 8000);
    await page.mouse.dblclick(tt.x + tt.width - 30, tt.y + tt.height - 140);
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "floor", "double-click on the wall background → floor");
    await page.getByTestId("tt-nav-east").click();
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "east", "switcher → east");
    ok(await page.getByTestId("tt-nav-east").getAttribute("aria-pressed") === "true", "switcher pressed state");
    await page.getByTestId("tt-back").click();
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "floor", "Back → floor");
    // keyboard: Tab to a wall's open button and press Enter
    await page.getByTestId("tt-open-south").focus();
    await page.keyboard.press("Enter");
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "south", "Enter on a wall → main");
    await close();
  });

  await test("walls work: Apps wall launches an app (and returns to the table), Windows wall lists and restores windows, Widgets shows the time, Recent opens a file", { "LY-07": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([{ id: "cm", module: "calculator", title: "Calculator", x: 200, y: 100, w: 340, h: 440, z: 11, minimized: true, maximized: false, workspace: 1, host: "tab", props: {} }]);
    const { page, close } = await boot();
    await page.getByTestId("tt-nav-west").click();
    await page.getByTestId("tt-app-clock").click();
    await poll(async () => (await page.locator(".fs-window").count()) >= 1 && (await page.getByTestId("tabletop").getAttribute("data-main")) === "floor", "clock opened, back on the table");
    await page.getByTestId("tt-nav-south").focus(); await page.keyboard.press("Enter");
    ok(await page.getByTestId("tt-recent-item").count() >= 4, "recent files listed");
    const first = page.getByTestId("tt-recent-item").first();
    const name = (await first.locator("strong").innerText()).trim();
    const before = await page.locator(".fs-window").count();
    // windows float above the box (by design), so activate from the keyboard rather than aim past them
    await first.focus(); await page.keyboard.press("Enter");
    await poll(async () => (await page.locator(".fs-window").count()) === before + 1, `recent file ${name} opened`);
    await page.getByTestId("tt-nav-north").focus(); await page.keyboard.press("Enter");
    ok(await page.getByTestId("tt-win-cm").count() === 1, "minimised calculator listed");
    ok(/minimised/.test(await page.getByTestId("tt-win-cm").innerText()), "shows minimised");
    await page.getByTestId("tt-win-cm").focus(); await page.keyboard.press("Enter");
    await poll(async () => (await page.locator('.fs-window:has-text("Calculator")').count()) === 1, "calculator restored");
    await page.getByTestId("tt-nav-east").focus(); await page.keyboard.press("Enter");
    ok(/\d:\d\d/.test(await page.getByTestId("tt-time").innerText()), "clock shows a time");
    await close();
  });

  await test("micro peek shows the real contents (Markdown heading + bullets, CSV grid with a quoted comma) and enlarges on hover / focus", { "LY-09": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([]);
    const { page, close } = await boot();
    const md = card(page, F.md);
    await md.waitFor({ timeout: 10_000 });
    await poll(async () => (await md.locator(".fs-tt-peek").getAttribute("data-peek")) === "text", "peek loaded");
    ok((await md.locator(".fs-tt-peek-h").first().innerText()).trim() === "Hello Peek", "heading");
    ok((await md.locator(".fs-tt-peek-li").allInnerTexts()).map((t) => t.trim()).join("|") === "alpha item|beta item", "bullets");
    const csv = card(page, F.csv);
    await poll(async () => (await csv.locator(".fs-tt-peek").getAttribute("data-peek")) === "grid", "csv peek");
    ok((await csv.locator(".fs-tt-peek-grid > span").allInnerTexts()).map((t) => t.trim()).includes("Raleigh, NC"), "quoted comma kept in one cell");
    const small = await md.locator(".fs-tt-peek").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    ok(small > 3 && small < 6, `miniature (${small}px)`);
    ok(await md.locator(".fs-tt-peek").getAttribute("aria-hidden") === "true" && /text preview/.test((await md.getAttribute("title")) ?? "") && await md.getAttribute("aria-describedby") === "tt-card-hint", "peek decorative; the card says what it is");
    await md.hover();
    await page.getByTestId("tt-zoom").waitFor({ timeout: 5000 });
    const big = await page.getByTestId("tt-zoom").locator(".fs-tt-peek").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    ok(Math.abs(big / small - 2.3) < 0.05, `enlarged ×2.3 (${small} → ${big})`);
    ok((await page.getByTestId("tt-zoom").locator(".fs-tt-peek-h").innerText()).trim() === "Hello Peek", "same contents enlarged");
    await page.mouse.move(700, 600);
    await poll(async () => (await page.getByTestId("tt-zoom").count()) === 0, "leaves → gone");
    await csv.focus();
    await page.getByTestId("tt-zoom").waitFor({ timeout: 5000 });
    await close();
  });

  await test("drag a card onto a card makes a pile (persisted, survives reload); click fans it out on an arc; drag a card out of the fan takes it out and the pile dissolves", { "LY-08": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([]);
    const { page, close } = await boot();
    const A = card(page, F.a), Bc = card(page, F.b);
    await A.waitFor({ timeout: 10_000 }); await Bc.waitFor();
    const tb = await box(Bc);
    await drag(page, A, { x: tb.x + tb.width / 2 + 6, y: tb.y + tb.height / 2 + 6 });
    const pile = page.locator('[data-testid="tt-pile"]');
    await poll(async () => (await pile.count()) === 1 && (await pile.getAttribute("data-count")) === "2", "pile of 2");
    await poll(async () => (await getState())?.table?.piles.some((p) => p.paths.includes(F.a) && p.paths.includes(F.b)) ?? false, "pile persisted");
    const pb = await box(pile);
    ok(Math.abs(pb.x - tb.x) <= 8 && Math.abs(pb.y - tb.y) <= 8, "pile sits where the target card was");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("tabletop").waitFor({ timeout: 30_000 });
    await poll(async () => (await pile.count()) === 1, "pile after reload");
    await pile.click();
    await poll(async () => (await pile.getAttribute("data-fanned")) !== null, "fanned");
    await poll(async () => { const ba = await box(card(page, F.a)), bb = await box(card(page, F.b)); return Math.abs(ba.x - bb.x) > 60; }, "cards spread apart on the arc", 6000);
    const rots = await page.locator('[data-testid="tt-card"][data-lifted]').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.getPropertyValue("--rot")));
    ok(rots.length === 2 && rots[0] !== rots[1], `fanned with opposite tilts ${rots}`);
    ok(await card(page, F.a).getAttribute("tabindex") === "0", "fanned cards are interactive");
    const fl = await box(page.getByTestId("tt-floor"));
    await drag(page, card(page, F.a), { x: fl.x + fl.width - 120, y: fl.y + fl.height - 160 });
    await poll(async () => (await pile.count()) === 0, "pile of one dissolves");
    await poll(async () => { const st = await getState(); return !!st?.table && st.table.piles.length === 0 && !!st.table.cards[F.a]; }, "both loose again, persisted");
    await close();
  });

  await test("keyboard pile (WCAG 2.5.7 alternative to dragging): Shift+F10 on a card → 'Pile with …'; Enter fans the pile, Esc gathers; Alt+Arrow moves a card", { "LY-08": "full", "LY-07": "partial" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([], { table: { v: 1, cards: { [F.a]: { x: 24, y: 24 }, [F.b]: { x: 160, y: 24 } }, piles: [] } });
    const { page, close } = await boot();
    const A = card(page, F.a);
    await A.waitFor({ timeout: 10_000 });
    await A.focus();
    await page.waitForTimeout(500);
    const a0 = await box(A);
    await page.keyboard.press("Alt+ArrowDown");
    // 24 floor px; on the slanted floor that is foreshortened on screen (≈ 14 px near the far edge)
    // the floor coordinate moves exactly 24 px (persisted); on screen it moves less (foreshortened near the far edge)
    await poll(async () => ((await getState())?.table?.cards[F.a] as { y?: number } | undefined)?.y === 48, "Alt+ArrowDown moved the card 24 floor px");
    await poll(async () => (await box(card(page, F.a))).y > a0.y + 2, "Alt+ArrowDown moved the card on screen");
    await card(page, F.a).focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByTestId("tt-menu");
    await menu.waitFor();
    await menu.getByRole("menuitem", { name: /^Pile with/ }).click();
    const pile = page.locator('[data-testid="tt-pile"]');
    await poll(async () => (await pile.count()) === 1, "pile created from the keyboard");
    await pile.focus();
    await page.keyboard.press("Enter");
    await poll(async () => (await pile.getAttribute("aria-expanded")) === "true", "Enter fans out");
    await page.keyboard.press("Escape");
    await poll(async () => (await pile.getAttribute("aria-expanded")) === "false", "Esc gathers");
    await pile.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Unstack" }).click();
    await poll(async () => (await pile.count()) === 0, "Unstack");
    await close();
  });

  await test("desktop icons (classic): drag snaps to another grid cell and persists; Alt+Arrow moves; 'Sort icons by name' and 'Clean up icons' rearrange", { "LY-06": "full" }, async () => {
    await setSetting("appearance.desktopView", "classic");
    await desktop([]);
    const { page, close } = await boot();
    const icons = page.getByTestId("desk-icon");
    await poll(async () => (await icons.count()) >= 4, "icons");
    const first = icons.first();
    const path = (await first.getAttribute("data-path"))!;
    const c0 = await first.getAttribute("data-cell");
    const area = await box(page.getByTestId("desk-icons"));
    await drag(page, first, { x: area.x + area.width * 0.45, y: area.y + area.height * 0.5 });
    const moved = page.locator(`[data-testid="desk-icon"][data-path="${path}"]`);
    await poll(async () => (await moved.getAttribute("data-cell")) !== c0, "moved to another cell");
    const cell = (await moved.getAttribute("data-cell"))!;
    ok(Number(cell.split(",")[0]) >= 2, `dropped mid-screen (cell ${cell})`);
    await poll(async () => (await getState())?.icons?.some((i) => i.path === path && `${i.x},${i.y}` === cell) ?? false, "persisted as a grid cell");
    // snapped: the icon sits exactly on its cell (cell size from the grid probe, 10 px margin)
    const g = await page.getByTestId("desk-icons").evaluate((e) => { const r = e.previousElementSibling!.getBoundingClientRect(); return { cw: r.width, ch: r.height }; });
    await page.waitForTimeout(400);
    const b = await box(moved);
    const [sc, sr] = cell.split(",").map(Number);
    ok(Math.abs(b.y - (area.y + 10 + sr * g.ch)) <= 1 && Math.abs(b.x + b.width / 2 - (area.x + 10 + sc * g.cw + g.cw / 2)) <= 1.5, `snapped to the cell ${JSON.stringify(b)} ${JSON.stringify(g)}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await poll(async () => (await page.locator(`[data-testid="desk-icon"][data-path="${path}"]`).getAttribute("data-cell").catch(() => null)) === cell, "same cell after reload", 30_000);
    const m2 = page.locator(`[data-testid="desk-icon"][data-path="${path}"]`);
    await m2.focus();
    await page.keyboard.press("Alt+ArrowDown");
    const [cx, cy] = cell.split(",").map(Number);
    await poll(async () => (await m2.getAttribute("data-cell")) === `${cx},${cy + 1}`, "Alt+ArrowDown → next row");
    ok(await m2.evaluate((e) => e === document.activeElement), "keeps focus");
    await page.getByTestId("desk-icons").click({ button: "right", position: { x: area.width * 0.7, y: area.height * 0.8 }, force: true });
    await page.getByRole("menuitem", { name: "Sort icons by name" }).click();
    let last = "";
    await poll(async () => {
      const cells = await icons.evaluateAll((els) => els.map((e) => ({ n: e.getAttribute("data-path")!.split("/").pop()!, c: e.getAttribute("data-cell")! })));
      const order = [...cells].sort((p, q) => { const [a1, a2] = p.c.split(",").map(Number), [b1, b2] = q.c.split(",").map(Number); return a1 - b1 || a2 - b2; }).map((x) => x.n);
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      last = JSON.stringify(cells);
      return order.join("|") === [...order].sort(coll.compare).join("|") && cells.some((x) => x.c === "0,0");
    }, "sorted by name, column-major from the top-left").catch((e) => { throw new Error(`${e.message} ${last}`); });
    // open a gap: move the top-left icon one column right, then Clean up must close every gap, keeping reading order
    const rows = Math.max(1, Math.floor((area.height - 20) / g.ch));
    const atCell = async (c: string) => page.locator(`[data-testid="desk-icon"][data-cell="${c}"]`);
    const topLeft = await atCell("0,0"); const tlPath = (await topLeft.getAttribute("data-path"))!;
    await topLeft.focus(); await page.keyboard.press("Alt+ArrowRight");
    await poll(async () => (await page.locator(`[data-testid="desk-icon"][data-path="${tlPath}"]`).getAttribute("data-cell")) !== "0,0", "gap opened at 0,0");
    const cellsNow = async () => icons.evaluateAll((els) => els.map((e) => ({ p: e.getAttribute("data-path")!, c: e.getAttribute("data-cell")! })));
    const readOrder = (cs: { p: string; c: string }[]) => [...cs].sort((x, y) => { const [a1, a2] = x.c.split(",").map(Number), [b1, b2] = y.c.split(",").map(Number); return a1 - b1 || a2 - b2; }).map((x) => x.p);
    const before = readOrder(await cellsNow());
    await page.getByTestId("desk-icons").click({ button: "right", position: { x: area.width * 0.7, y: area.height * 0.8 }, force: true });
    await page.getByRole("menuitem", { name: "Clean up icons" }).click();
    await poll(async () => {
      const cs = await cellsNow();
      const want = new Set(cs.map((_, i) => `${Math.floor(i / rows)},${i % rows}`));
      return cs.every((x) => want.has(x.c)) && readOrder(cs).join("|") === before.join("|");
    }, "clean up: gap-free column-major prefix, reading order kept");
    await close();
  });

  /** fraction of a grid of sample points over the Tabletop whose hit stack includes the floor face (measured, not computed) */
  const floorShare = (page: Page) => page.evaluate(() => {
    const r = document.querySelector("[data-testid=tabletop]")!.getBoundingClientRect();
    let on = 0, n = 0;
    for (let i = 0; i < 48; i++) for (let j = 0; j < 30; j++) {
      const x = r.left + ((i + 0.5) / 48) * r.width, y = r.top + ((j + 0.5) / 30) * r.height; n++;
      // the TOPMOST face at the point (overlays such as the switcher are not faces and are skipped; the floor hidden behind the lip does not count)
      const top = document.elementsFromPoint(x, y).map((el) => el.closest("[data-face]") as HTMLElement | null).find((f) => f);
      if (top?.dataset.face === "floor") on++;
    }
    return on / n;
  });

  await test("slanted camera is the default: floor ≥ 80 % of the Tabletop by hit-sampling 1440 points (desktop + phone), the near lip is a ≥ 24 px target, Camera toggles top ↔ slant and persists", { "LY-11": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    for (const [vw, vh] of [[1440, 900], [390, 844]]) {
      await desktop([]);
      const { page, close } = await boot(vw, vh);
      const tt = page.getByTestId("tabletop");
      ok(await tt.getAttribute("data-camera") === "slant", `default camera at ${vw}`);
      const cov = Number(await tt.getAttribute("data-coverage"));
      ok(cov >= 0.8, `computed coverage ${cov}`);
      let share = 0;
      await poll(async () => { share = await floorShare(page); return share >= 0.8 && Math.abs(share - cov) < 0.04; }, "floor share settled", 8000).catch(() => {});
      ok(share >= 0.8 && Math.abs(share - cov) < 0.04, `${vw}×${vh}: measured floor share ${share.toFixed(3)} (computed ${cov})`);
      const lip = await box(page.getByTestId("tt-open-south"));
      ok(lip.height >= 23, `south lip target ${lip.height.toFixed(1)} px`);
      const m = await page.getByTestId("tt-floor").evaluate((el) => getComputedStyle(el).transform);
      ok(m.startsWith("matrix3d("), "floor is tilted in 3D");
      // a card on the slanted floor is still a usable target (≥ 44 px on its short side)
      const c = await box(page.getByTestId("tt-card").first());
      ok(c.width >= 44 && c.height >= 44, `card on the slant ${c.width.toFixed(0)}×${c.height.toFixed(0)}`);
      if (vw === 1440) {
        await page.getByTestId("tt-camera").click();
        await poll(async () => (await tt.getAttribute("data-camera")) === "top", "camera top");
        await poll(async () => (await getState())?.table && (await getState() as { table: { camera?: string } }).table.camera === "top", "camera persisted");
        await page.getByTestId("tt-camera").click();
        await poll(async () => (await tt.getAttribute("data-camera")) === "slant", "camera back");
        // the far (north) wall is a large target on the slant: double-click unfolds it, Esc folds it back
        const nb = await wallPoint(page, "north");
        await page.mouse.dblclick(nb.x, nb.y);
        await poll(async () => (await tt.getAttribute("data-main")) === "north", "north main from the slant");
        await page.keyboard.press("Escape");
        await poll(async () => (await tt.getAttribute("data-main")) === "floor", "back to the floor");
      }
      await close();
    }
  });

  await test("walls are pinboards: drag a card onto a wall pins it (persisted, leaves the floor); the open wall shows it with a count; drag moves it on the wall; 'Put back on the table' returns it", { "LY-12": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([]);
    const { page, close } = await boot();
    const c = card(page, F.md);
    await c.waitFor();
    const north = await box(page.getByTestId("tt-open-north"));
    await drag(page, c, { x: north.x + north.width * 0.3, y: north.y + north.height / 2 });
    await poll(async () => { const t = (await getState())?.table as { walls?: { north?: { cards: Record<string, unknown> } } } | undefined; return !!t?.walls?.north?.cards[F.md]; }, "pinned in state");
    ok(await page.locator(`[data-testid="tt-card"][data-path="${F.md}"][data-surface="floor"]`).count() === 0, "left the floor");
    await page.getByTestId("tt-nav-north").click();
    const pinned = page.locator(`[data-testid="tt-pinboard-north"] [data-testid="tt-card"][data-path="${F.md}"]`);
    await pinned.waitFor({ timeout: 8000 });
    ok((await page.getByTestId("tt-pincount-north").textContent())?.startsWith("1"), "count chip");
    // wait for the unfold transition to finish (the card's box stops moving) before measuring and dragging
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "north", "north is main");
    // TT48: equal boxes 100 ms apart can occur mid-transition; wait for the app's own settle signal first
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-settled")) === "true", "unfold finished");
    let prev = "";
    await poll(async () => { const b = JSON.stringify(await box(pinned)); const same = b === prev; prev = b; return same; }, "wall settled");
    const before = await box(pinned);
    const target = { x: before.x + before.width / 2 + 160, y: before.y + before.height / 2 + 30 };
    console.log("DEBUG wall drag before", JSON.stringify({
      before,
      target,
      card: await pinned.evaluate((el) => ({
        html: el.outerHTML.slice(0, 200),
        pointer: getComputedStyle(el).pointerEvents,
        face: el.closest("[data-face]")?.getAttribute("data-face"),
      })),
      state: await getState(),
    }));
    await drag(page, pinned, target);
    await page.waitForTimeout(300);
    console.log("DEBUG wall drag after", JSON.stringify({
      state: await getState(),
      card: await pinned.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, ds: el.getAttribute("data-dragging") };
      }).catch((e) => String(e)),
    }));
    await poll(async () => { const t = (await getState())?.table as { walls?: { north?: { cards: Record<string, { x: number }> } } } | undefined; return (t?.walls?.north?.cards[F.md]?.x ?? 0) >= 120; }, "moved on the wall");
    await pinned.focus(); await page.keyboard.press("Shift+F10");
    await page.getByTestId("tt-menu").getByRole("menuitem", { name: "Put back on the table" }).click();
    await poll(async () => { const t = (await getState())?.table as { walls?: { north?: unknown } } | undefined; return !t?.walls?.north; }, "back on the floor");
    await close();
  });

  await test("TT48 fast flick: pointerdown, eight pointermoves and pointerup in ONE task (no render in between) still move the card — the release must not read a stale drag", { "LY-12": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([], { table: { v: 1, cards: { [F.a]: { x: 24, y: 24 } }, piles: [] } });
    const { page, close } = await boot();
    const A = card(page, F.a); await A.waitFor({ timeout: 10_000 });
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-settled")) === "true", "settled");
    const b = await box(A);
    const moved = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null; if (!el) return "no element";
      const ev = (type: string, cx: number, buttons: number) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons, clientX: cx, clientY: y });
      el.dispatchEvent(ev("pointerdown", x, 1));
      for (let i = 1; i <= 8; i++) el.dispatchEvent(ev("pointermove", x + 30 * i, 1));
      el.dispatchEvent(ev("pointerup", x + 240, 0));
      return "ok";
    }, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    ok(moved === "ok", moved);
    // the release must act: the card either moved (x ≥ 100) or, landing on another /Documents card, piled with it.
    // The pre-fix handler returned on its stale moved=false, leaving the card loose at x = 24 (this test, in its first
    // x ≥ 100 form, failed on the pre-fix build and passes on the fixed one).
    await poll(async () => { const t = (await getState())?.table; if (!t) return false; const c = t.cards[F.a] as { x?: number } | undefined; return (c?.x ?? 0) >= 100 || t.piles.some((p) => p.paths.includes(F.a)); }, "flicked card moved (or piled) and persisted");
    await close();
  });

  await test("wall piles by menu (keyboard path): 'Pin to the Apps wall' ×2, pile them on the wall, fan the wall pile, take one out; pins survive reload", { "LY-12": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([]);
    const { page, close } = await boot();
    for (const f of [F.a, F.b]) {
      const c = card(page, f); await c.waitFor(); await c.focus(); await page.keyboard.press("Shift+F10");
      await page.getByTestId("tt-menu").getByRole("menuitem", { name: "Pin to the Apps wall" }).click();
      await poll(async () => (await page.locator(`[data-testid="tt-card"][data-path="${f}"][data-surface="floor"]`).count()) === 0, `${f} pinned`);
    }
    await page.getByTestId("tt-nav-west").click();
    const a = page.locator(`[data-testid="tt-pinboard-west"] [data-testid="tt-card"][data-path="${F.a}"]`);
    await a.waitFor({ timeout: 8000 });
    await a.focus(); await page.keyboard.press("Shift+F10");
    await page.getByTestId("tt-menu").getByRole("menuitem", { name: /^Pile with/ }).click();
    const pile = page.locator('[data-testid="tt-pinboard-west"] [data-testid="tt-pile"][data-surface="west"]');
    await pile.waitFor({ timeout: 8000 });
    ok(await pile.getAttribute("data-count") === "2", "wall pile of 2");
    await pile.click();
    await poll(async () => (await pile.getAttribute("data-fanned")) !== null, "wall pile fans");
    const { page: p2, close: c2 } = await (async () => { await close(); return boot(); })();
    await p2.getByTestId("tt-nav-west").click();
    await p2.locator('[data-testid="tt-pinboard-west"] [data-testid="tt-pile"]').waitFor({ timeout: 8000 });
    ok((await p2.getByTestId("tt-pincount-west").textContent())?.startsWith("2"), "2 pinned after reload");
    await c2();
  });

  await test("saved tabletop views: save (camera + face + pins), change everything, load restores it, survives reload, delete", { "LY-13": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([]);
    const { page, close } = await boot();
    const c = card(page, F.csv); await c.waitFor(); await c.focus(); await page.keyboard.press("Shift+F10");
    await page.getByTestId("tt-menu").getByRole("menuitem", { name: "Pin to the Windows wall" }).click();
    await poll(async () => (await page.locator(`[data-testid="tt-card"][data-path="${F.csv}"][data-surface="floor"]`).count()) === 0, "pinned");
    await page.getByTestId("tt-nav-north").click();
    await page.getByTestId("tt-views").click();
    await page.getByTestId("tt-view-name").fill(`Focus ${RUN}`);
    await page.getByTestId("tt-view-save").click();
    await page.getByTestId("tt-view").first().waitFor();
    ok(/saved/i.test((await page.getByTestId("tt-view-msg").textContent()) ?? ""), "status says saved");
    // change everything: unpin, top camera, back to the floor
    await page.getByTestId("tt-views").click();
    await poll(async () => (await page.getByTestId("tt-views-panel").count()) === 0, "views panel closed");
    ok(await page.getByTestId("tabletop").getAttribute("data-main") === "north", "still on the north wall");
    const pinned = page.locator(`[data-testid="tt-pinboard-north"] [data-testid="tt-card"][data-path="${F.csv}"]`);
    await pinned.focus(); await page.keyboard.press("Shift+F10");
    await page.getByTestId("tt-menu").getByRole("menuitem", { name: "Put back on the table" }).click();
    await page.getByTestId("tt-nav-floor").click();
    await page.getByTestId("tt-camera").click();
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-camera")) === "top", "top");
    await poll(async () => (((await getState())?.table as { camera?: string } | undefined)?.camera) === "top", "camera saved");
    await close();
    const { page: p2, close: c2 } = await boot();
    ok(await p2.getByTestId("tabletop").getAttribute("data-camera") === "top", "camera persisted across reload");
    await p2.getByTestId("tt-views").click();
    const load = p2.locator('[data-testid^="tt-view-load-"]').first();
    await load.click();
    await poll(async () => (await p2.getByTestId("tabletop").getAttribute("data-camera")) === "slant" && (await p2.getByTestId("tabletop").getAttribute("data-main")) === "north", "camera + face restored");
    await p2.locator(`[data-testid="tt-pinboard-north"] [data-testid="tt-card"][data-path="${F.csv}"]`).waitFor({ timeout: 8000 });
    await p2.getByTestId("tt-views").click().catch(() => {});
    if (!(await p2.getByTestId("tt-views-panel").count())) await p2.getByTestId("tt-views").click();
    await p2.locator('[data-testid^="tt-view-delete-"]').first().click();
    await poll(async () => (await p2.getByTestId("tt-view").count()) === 0, "deleted");
    await poll(async () => (((await getState())?.table as { views?: unknown[] } | undefined)?.views?.length ?? 0) === 0, "deleted in state");
    await c2();
  });

  await test("reduced motion: every Tabletop transition is instant (computed durations 0) and a wall is main immediately", { "LY-07": "full", "AX-09": "partial" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    await desktop([]);
    const { page, close } = await boot(1440, 900, { reducedMotion: "reduce" });
    const durs = await page.locator(".fs-tt-face, .fs-tt-card").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).transitionDuration))]);
    ok(durs.every((d) => d.split(",").every((x) => parseFloat(x) === 0)), `durations ${durs}`);
    const tt = await box(page.getByTestId("tabletop"));
    await page.getByTestId("tt-nav-north").click();
    await page.waitForTimeout(60);
    const b = await box(page.getByTestId("tt-wall-north"));
    ok(Math.abs(b.height - tt.height) <= 2, `instantly full height (${b.height})`);
    await close();
  });

  await test("axe-core: Tabletop floor (dark + light) and each wall as the main view — no serious or critical violations", { "LY-07": "full", "AX-08": "partial" }, async () => {
    const bad: string[] = [];
    for (const theme of ["dark", "light"]) {
      await setSetting("appearance.theme", theme); await setSetting("appearance.desktopView", "tabletop");
      await desktop([]);
      const { page, close } = await boot();
      await page.waitForTimeout(800);
      bad.push(...(await axe(page)).map((v) => `${theme}/floor ${v}`));
      for (const w of ["north", "east", "south", "west"]) {
        await page.getByTestId(`tt-nav-${w}`).click();
        await page.waitForTimeout(1000);
        bad.push(...(await axe(page)).map((v) => `${theme}/${w} ${v}`));
      }
      await close();
    }
    await setSetting("appearance.theme", "dark");
    ok(bad.length === 0, bad.slice(0, 8).join("\n"));
  });
} finally {
  await setSetting("appearance.desktopView", "classic"); await setSetting("appearance.theme", "dark");
  await desktop([]);
  for (const p of Object.values(F)) { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); }
  await browser.close();
}
finish();
