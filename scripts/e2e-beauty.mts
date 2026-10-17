/**
 * Real-browser suite "e2e-beauty" (TT26): the beauty standard over every shell view, measured in headless Chromium
 * against the production build. For each viewport (1440×900, 1280×800, 1920×1080, 390×844) it visits
 *   Fusion desktop (classic icons) · Fusion launcher · Business taskbar · Start · Art menu bar + dock · Launchpad ·
 *   a dock stack popover · Tabletop floor · each Tabletop wall as the main view · a Settings window (largest viewport)
 * measures every visible control / text / icon / panel (getBoundingClientRect + computed style, skipping
 * [data-beauty-skip], aria-hidden and inert subtrees) and runs them through src/lib/beauty-core.ts.
 * HARD violations fail the test; SOFT findings (φ / pleasing proportions, type scale, Ngo balance) are reported only.
 * Writes docs/beauty-report.json and docs/BEAUTY-REPORT.md. A first test proves the pipeline itself catches a seeded
 * violation injected into the live page (a measurer that sees nothing would otherwise pass everything).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-beauty.mts
 */
import { writeFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import * as B from "../src/lib/beauty-core.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-beauty");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
async function desktop(windows: unknown[] = []) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); }

const browser: Browser = await launchChromium();
const retries: string[] = [];
async function boot(vw: number, vh: number, layout = "fusion") {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  const ready = async () => {
    await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
    await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock]").count()) > 0, "shell chrome", 30_000);
    return poll(async () => (await page.locator("[data-layout]").first().getAttribute("data-layout")) === layout, `layout ${layout}`, 6000).then(() => true, () => false);
  };
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  if (!(await ready())) {
    const got = await page.locator("[data-layout]").first().getAttribute("data-layout");
    const stored = (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === "appearance.layout")?.value;
    retries.push(`${vw}×${vh}: asked for ${layout}, page showed ${got}, server has ${stored} — reloaded once`);
    await page.reload({ waitUntil: "domcontentloaded" });
    if (!(await ready())) throw new Error(`layout ${layout} never appeared (page ${got}, server ${stored})`);
  }
  await page.mouse.move(vw / 2, vh * 0.4); // pointer away from the dock: icons at rest
  await page.waitForTimeout(600);
  return { page, close: () => ctx.close() };
}

/** Selectors whose targets are primary shell launch targets (the 32 px chrome floor applies). */
const CHROME = ["[data-testid=dock]", "[data-testid=taskbar]", "[aria-label=Shelf]", "[data-testid=start-menu]", "[data-testid=launchpad]", "[data-testid=tabletop]", "[data-testid=dock-stack-pop]", "[data-testid=desk-icons]"];
const REGION = "[role=toolbar],[role=menu],[role=dialog],nav,[data-testid=desk-icons],.fs-tt-face,.fs-window,header,footer";

interface Measured { boxes: B.Box[]; fonts: number[]; panels: B.Box[]; icons: B.Box[]; cards: B.Box[] }
/** Everything visible on screen, measured in the page. */
async function measure(page: Page): Promise<Measured> {
  return page.evaluate(({ CHROME, REGION }) => {
    const vis = (el: Element, decorative = false) => {
      if (el.closest(decorative ? "[data-beauty-skip],[inert]" : "[data-beauty-skip],[aria-hidden=true],[inert]")) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false; // includes .fs-visually-hidden (1×1, clipped by design)
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
    };
    const ids = new Map<Element, string>();
    const idOf = (el: Element) => {
      if (ids.has(el)) return ids.get(el)!;
      const t = el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 24);
      const id = `${el.tagName.toLowerCase()}${t ? `“${t}”` : ""}#${ids.size}`;
      ids.set(el, id); return id;
    };
    const regions = new Map<Element, string>();
    /** the OUTERMOST region container: a menu bar's menus and its status buttons share one region, so a collision between them counts */
    const regionOf = (el: Element) => {
      let r: Element | null = null;
      for (let a = el.parentElement?.closest(REGION) ?? null; a; a = a.parentElement?.closest(REGION) ?? null) r = a;
      if (!r) return "page"; if (!regions.has(r)) regions.set(r, `r${regions.size}`); return regions.get(r)!;
    };
    /** reachable by scrolling: some ancestor scrolls on the axis where the element is cut off, and that ancestor is itself on screen */
    const scrolled = (el: Element) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const sy = /auto|scroll/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1, sx = /auto|scroll/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1;
        // nested scrollers: an off-screen inner scroller inside an on-screen outer one is still reachable
        if (sx || sy) { const r = a.getBoundingClientRect(); if (r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1) return true; }
      }
      return false;
    };
    /** the visible part of an element: its rect clipped by every overflow-clipping ancestor (a scrolled-away item has none) */
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const visBox = (el: Element) => {
      const r = el.getBoundingClientRect();
      let L = r.left, T = r.top, R = r.right, Bm = r.bottom;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
          const c = a.getBoundingClientRect();
          if (cs.overflowX !== "visible") { L = Math.max(L, c.left); R = Math.min(R, c.right); }
          if (cs.overflowY !== "visible") { T = Math.max(T, c.top); Bm = Math.min(Bm, c.bottom); }
        }
      }
      const clippedAway = R - L < 1 || Bm - T < 1;
      // partially scrolled items keep their full size for the size rules but their visible rect for position rules
      return clippedAway ? { x: 0, y: 0, w: 0, h: 0 } : { x: L, y: T, w: R - L, h: Bm - T };
    };
    const boxes: unknown[] = [], fonts: number[] = [], panels: unknown[] = [], icons: unknown[] = [], cards: unknown[] = [];
    const INTER = "button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=switch],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=option]";
    for (const el of document.querySelectorAll(INTER)) {
      if (!vis(el)) continue;
      // a control inside another control (e.g. a labelled switch inside a row button) is measured as its parent
      if (el.parentElement?.closest(INTER)) continue;
      const inline = el.tagName === "A" && !!el.parentElement && ["P", "LI", "SPAN", "TD"].includes(el.parentElement.tagName) && (el.parentElement.textContent ?? "").trim().length > (el.textContent ?? "").trim().length + 8;
      const vb = visBox(el), sc = scrolled(el);
      if (vb.w < 1 && sc) continue; // scrolled out of view inside a scroller: reachable, not on screen now
      boxes.push({ id: idOf(el), ...box(el), vis: vb, interactive: true, chrome: CHROME.some((s) => el.closest(s)), inline, region: regionOf(el), scrolled: sc });
    }
    // text: elements with their own text nodes
    for (const el of document.querySelectorAll("body *")) {
      if (!vis(el) || el.closest("svg")) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
      if (!own) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize); fonts.push(fs);
      const lh = cs.lineHeight === "normal" ? fs * 1.2 : parseFloat(cs.lineHeight);
      const clipX = /hidden|clip/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const clipY = /hidden|clip/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2 && cs.webkitLineClamp === "none";
      const ellipsis = cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none";
      const lines = el.tagName === "P" || el.tagName === "LI" ? Math.round(el.getBoundingClientRect().height / lh) : 1;
      boxes.push({ id: idOf(el), ...box(el), clipped: clipX || clipY, ellipsis: ellipsis && !clipY, fontSize: fs, lineHeight: lh, lines, region: regionOf(el) });
    }
    for (const el of document.querySelectorAll(".fs-panel,[role=dialog]")) if (vis(el)) panels.push({ id: idOf(el), ...box(el), scrolled: scrolled(el) });
    for (const el of document.querySelectorAll("svg[data-icon][data-palette]")) if (vis(el, true)) icons.push({ id: idOf(el), ...box(el), icon: true });
    for (const el of document.querySelectorAll("[data-testid=tt-card]")) if (vis(el) && !el.hasAttribute("data-lifted")) cards.push({ id: idOf(el), ...box(el) });
    return { boxes, fonts, panels, icons, cards } as never;
  }, { CHROME, REGION });
}

interface ViewResult { view: string; vw: number; vh: number; measured: number; hard: B.Violation[]; soft: B.Violation[]; balance: number; dock?: { icon: number; width: number } }
const results: ViewResult[] = [];
const rowOf = async (page: Page, sel: string): Promise<B.Box[]> => page.locator(sel).evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0)
  .map((e, i) => { const r = e.getBoundingClientRect(); return { id: `${e.getAttribute("data-testid") ?? "item"}#${i}`, x: r.x, y: r.y, w: r.width, h: r.height }; }));
const boxOf = async (page: Page, sel: string): Promise<B.Box | null> => { const b = await page.locator(sel).first().boundingBox().catch(() => null); return b ? { id: sel, x: b.x, y: b.y, w: b.width, h: b.height } : null; };

/** Measure the current screen as `view`, run every rule, record, and return the hard violations. */
async function judge(page: Page, view: string, vw: number, vh: number, extra: (m: Measured) => Promise<B.Violation[]> = async () => []): Promise<B.Violation[]> {
  await page.waitForTimeout(250);
  const m = await measure(page);
  const inter = m.boxes.filter((b) => b.interactive);
  const v: B.Violation[] = [
    ...B.targetSize(inter), ...B.chromeTarget(inter.filter((b) => b.chrome), 32, vw, vh), ...B.overlaps(inter.map((b) => { const v = (b as B.Box & { vis?: B.Box }).vis; return v && v.w > 0 ? { ...b, ...v } : { ...b, w: 0, h: 0 }; })), ...B.clippedText(m.boxes),
    // every control and every floating panel must be reachable: on screen, or inside a scroller that is
    ...B.offscreen([...inter, ...m.panels.map((p) => ({ ...p, interactive: true }))].map((b) => ({ ...b, chrome: true })), vw, vh), ...B.squareIcons(m.icons), ...B.lineHeight(m.boxes), ...B.goldenCards(m.cards),
    ...B.proportion(m.panels), ...B.typeScale(m.fonts, view), ...(await extra(m)),
  ];
  const frame: B.Box = { id: "viewport", x: 0, y: 0, w: vw, h: vh };
  const r: ViewResult = { view, vw, vh, measured: m.boxes.length + m.icons.length + m.panels.length, hard: B.hardOnly(v), soft: v.filter((x) => !x.hard), balance: Math.round(B.balance(inter, frame) * 1000) / 1000 };
  results.push(r);
  return r.hard;
}
const fmt = (v: B.Violation[]) => v.slice(0, 8).map((x) => `${x.rule} ${x.id}: ${x.detail}`).join("; ");

await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark"); await setSetting("appearance.textScale", "125");
await setSetting("appearance.dockMagnify", "on"); await setSetting("appearance.dockSize", "auto");

try {
  await test("the pipeline catches seeded violations in the live page (tiny crowded buttons, clipped text, an off-centre dock, an un-golden card)", { "LY-10": "full" }, async () => {
    await setSetting("appearance.layout", "fusion"); await setSetting("appearance.desktopView", "classic"); await desktop([]);
    const { page, close } = await boot(1440, 900);
    try {
      await page.evaluate(() => {
        const d = document.createElement("div");
        d.setAttribute("role", "toolbar"); d.style.cssText = "position:fixed;left:300px;top:300px;z-index:99999;display:flex;gap:2px";
        d.innerHTML = '<button aria-label="seed-a" style="width:12px;height:12px;padding:0">a</button><button aria-label="seed-b" style="width:12px;height:12px;padding:0">b</button>'
          + '<span id="seed-clip" style="display:block;width:30px;overflow:hidden;white-space:nowrap">a long label that cannot fit</span>';
        document.body.appendChild(d);
      });
      const m = await measure(page);
      const hard = [...B.targetSize(m.boxes.filter((b) => b.interactive)), ...B.clippedText(m.boxes)];
      ok(hard.some((v) => v.rule === "target-size" && /seed-a/.test(v.id)), `tiny crowded button caught: ${fmt(hard)}`);
      ok(hard.some((v) => v.rule === "clipped-text" && /a long label/.test(v.id)), "clipped text caught");
      ok(B.equilibrium({ id: "d", x: 100, y: 0, w: 400, h: 60 }, { id: "f", x: 0, y: 0, w: 1440, h: 900 }, "dock").length === 1, "off-centre dock caught");
      ok(B.goldenCards([{ id: "c", x: 0, y: 0, w: 112, h: 140 }]).length === 1, "un-golden card caught");
      await page.evaluate(() => document.querySelector("[aria-label=seed-a]")?.parentElement?.setAttribute("data-beauty-skip", ""));
      const m2 = await measure(page);
      ok(!B.targetSize(m2.boxes.filter((b) => b.interactive)).some((v) => /seed/.test(v.id)), "[data-beauty-skip] removes a subtree");
      ok(m.boxes.filter((b) => b.interactive).length > 10 && m.icons.length > 3, `measured the real page (${m.boxes.length} boxes, ${m.icons.length} icons)`);
    } finally { await close(); }
  });

  const VIEWPORTS = ([[1440, 900], [1280, 800], [1920, 1080], [390, 844]] as const).filter(([w]) => !process.env.VIEWPORTS || process.env.VIEWPORTS.split(",").includes(String(w)));
  for (const [vw, vh] of VIEWPORTS) {
    await test(`${vw}×${vh}: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations`, { "LY-10": "full", "LY-05": "full" }, async () => {
      const fails: string[] = [];
      const note = (view: string, v: B.Violation[]) => { if (v.length) fails.push(`[${view}] ${fmt(v)}`); };
      // Fusion + classic desktop (desktop icons) and its launcher
      await setSetting("appearance.layout", "fusion"); await setSetting("appearance.desktopView", "classic"); await desktop([]);
      let s = await boot(vw, vh);
      try {
        note("fusion", await judge(s.page, "fusion", vw, vh, async () => {
          const icons = await rowOf(s.page, "[data-testid=desk-icon]");
          // the first icon column is one aligned column with one rhythm (Ngo regularity, vertical)
          const col0 = icons.filter((b) => Math.abs(b.x - icons[0]?.x) < 1).map((b) => ({ ...b, x: b.y, y: b.x, w: b.h, h: b.w }));
          return B.rhythm(col0, "desktop icons column");
        }));
        await s.page.getByTestId("launcher-button").click();
        await s.page.getByRole("dialog", { name: "Launcher" }).waitFor();
        note("fusion launcher", await judge(s.page, "fusion launcher", vw, vh));
        if (vw >= 1440 && vh >= 900) {
          await s.page.keyboard.press("Escape");
          await s.page.getByTestId("launcher-button").click();
          await s.page.getByRole("dialog", { name: "Launcher" }).getByRole("button", { name: /^Settings/ }).first().click();
          await s.page.locator(".fs-window").first().waitFor();
          await s.page.waitForTimeout(500);
          note("settings window", await judge(s.page, "settings window", vw, vh));
        }
      } finally { await s.close(); }
      // Business
      await setSetting("appearance.layout", "business"); await desktop([]);
      s = await boot(vw, vh, "business");
      try {
        note("business", await judge(s.page, "business", vw, vh, async () => B.rhythm(await rowOf(s.page, "[data-testid=taskbar] [role=group][aria-label=Apps] > button"), "taskbar apps")));
        await s.page.getByTestId("launcher-button").click();
        await s.page.getByTestId("start-menu").waitFor();
        note("start", await judge(s.page, "start", vw, vh));
      } finally { await s.close(); }
      // Art
      await setSetting("appearance.layout", "art"); await desktop([]);
      s = await boot(vw, vh, "art");
      try {
        const dockExtra = async () => {
          const icons = await rowOf(s.page, "[data-testid=dock] .fs-dock-item");
          const dock = await boxOf(s.page, "[data-testid=dock]");
          // rhythm per group: the separators between Core | Create | … are deliberate breaks (macOS draws them too)
          const seps = await rowOf(s.page, "[data-testid=dock] .fs-dock-sep");
          const groups: B.Box[][] = [[]];
          for (const b of [...icons].sort((a, c) => a.x - c.x)) {
            const prev = groups.at(-1)!.at(-1);
            if (prev && seps.some((sp) => sp.x >= prev.x + prev.w - 1 && sp.x + sp.w <= b.x + 1)) groups.push([]);
            groups.at(-1)!.push(b);
          }
          const v = [...B.dockBand(icons, dock, vw), ...groups.flatMap((g, i) => B.rhythm(g, `dock icons, group ${i + 1}`))];
          // one separator rhythm too: every separator gap is the same
          if (groups.length > 2) {
            const sepGaps = groups.slice(1).map((g, i) => g[0].x - (groups[i].at(-1)!.x + groups[i].at(-1)!.w));
            if (Math.max(...sepGaps) - Math.min(...sepGaps) > 1) v.push({ rule: "rhythm", id: "dock separators", detail: `separator gaps ${sepGaps.join(",")}`, hard: true });
          }
          if (dock) v.push(...B.equilibrium(dock, { id: "vp", x: 0, y: 0, w: vw, h: vh }, "dock"));
          const last = results.at(-1);
          if (last && icons[0] && dock) last.dock = { icon: Math.round(icons[0].w), width: Math.round(dock.w) };
          return v;
        };
        const hardArt = [...await judge(s.page, "art", vw, vh)];
        const dockV = await dockExtra();
        results.at(-1)!.hard.push(...B.hardOnly(dockV));
        note("art", [...hardArt, ...B.hardOnly(dockV)]);
        const folded = ((await s.page.getByTestId("dock").getAttribute("data-folded")) ?? "").split(",").filter(Boolean);
        if (folded.length) {
          await s.page.getByTestId(`dock-stack-${folded[0]}`).click();
          await s.page.getByTestId("dock-stack-pop").waitFor();
          note(`dock stack ${folded[0]}`, await judge(s.page, `dock stack ${folded[0]}`, vw, vh));
          await s.page.keyboard.press("Escape");
        }
        await s.page.getByTestId("dock-launchpad").click();
        await s.page.getByTestId("launchpad").waitFor();
        await s.page.waitForTimeout(400);
        note("launchpad", await judge(s.page, "launchpad", vw, vh, async () => {
          const items = await rowOf(s.page, "[data-testid=launchpad] .fs-lp-item");
          const row1 = items.filter((b) => Math.abs(b.y - items[0]?.y) < 2);
          if (!items.length) return [{ rule: "launchpad", id: "launchpad", detail: "no items", hard: true }];
          const grid = { id: "grid", x: Math.min(...items.map((b) => b.x)), y: items[0].y, w: Math.max(...items.map((b) => b.x + b.w)) - Math.min(...items.map((b) => b.x)), h: 1 };
          return [...B.rhythm(row1, "launchpad row"), ...B.equilibrium(grid, { id: "vp", x: 0, y: 0, w: vw, h: vh }, "launchpad grid")];
        }));
      } finally { await s.close(); }
      // Tabletop (Fusion chrome)
      await setSetting("appearance.layout", "fusion"); await setSetting("appearance.desktopView", "tabletop"); await desktop([]);
      s = await boot(vw, vh);
      try {
        await s.page.getByTestId("tabletop").waitFor();
        await s.page.waitForTimeout(900);
        note("tabletop floor", await judge(s.page, "tabletop floor", vw, vh, async () => {
          const nav = await rowOf(s.page, "[data-testid=tt-nav] > button");
          const rows = [...new Set(nav.map((b) => Math.round(b.y)))]; // the switcher may wrap to two rows on a phone
          return rows.flatMap((y) => B.rhythm(nav.filter((b) => Math.round(b.y) === y), `tabletop switcher row ${y}`));
        }));
        for (const w of ["north", "east", "south", "west"]) {
          await s.page.getByTestId(`tt-nav-${w}`).focus(); await s.page.keyboard.press("Enter");
          await poll(async () => (await s.page.getByTestId("tabletop").getAttribute("data-main")) === w, `${w} main`);
          // fully unfolded: the wall face fills the table (fixed waits caught it mid-transition in the sandbox)
          await poll(async () => {
            const [f, t] = await Promise.all([s.page.getByTestId(`tt-wall-${w}`).boundingBox(), s.page.getByTestId("tabletop").boundingBox()]);
            return !!f && !!t && Math.abs(f.width - t.width) < 2 && Math.abs(f.height - t.height) < 2;
          }, `${w} wall unfolded`, 10_000);
          await s.page.waitForTimeout(150);
          note(`tabletop ${w} wall`, await judge(s.page, `tabletop ${w} wall`, vw, vh));
          await s.page.keyboard.press("Escape");
          await poll(async () => (await s.page.getByTestId("tabletop").getAttribute("data-main")) === "floor", "floor");
          await s.page.waitForTimeout(900);
        }
      } finally { await s.close(); }
      ok(fails.length === 0, fails.join("\n"));
    });
  }
} finally {
  await setSetting("appearance.layout", "fusion"); await setSetting("appearance.desktopView", "classic"); await desktop([]);
  await browser.close();
  if (results.length) {
    writeFileSync("docs/beauty-report.json", JSON.stringify({ generated: new Date().toISOString(), rules: "src/lib/beauty-core.ts", retries, views: results }, null, 2) + "\n");
    const softBy = new Map<string, number>();
    for (const r of results) for (const v of r.soft) softBy.set(v.rule, (softBy.get(v.rule) ?? 0) + 1);
    const md = [
      "# Beauty report (generated by scripts/e2e-beauty.mts)", "",
      `Generated ${new Date().toISOString()} against the production build at ${BASE}. Rules and their sources: src/lib/beauty-core.ts and docs/DESIGN-TABLETOP-TT26.md.`,
      "HARD rules fail the suite; SOFT findings are reported only (the evidence for φ is mixed — see the design doc).", "",
      "| View | Viewport | Measured | Hard | Soft | Ngo balance | Dock icon / width |", "|---|---|---|---|---|---|---|",
      ...results.map((r) => `| ${r.view} | ${r.vw}×${r.vh} | ${r.measured} | ${r.hard.length} | ${r.soft.length} | ${r.balance} | ${r.dock ? `${r.dock.icon} px / ${r.dock.width} px` : ""} |`), "",
      "## Hard violations", "", ...(results.some((r) => r.hard.length) ? results.flatMap((r) => r.hard.map((v) => `- ${r.view} ${r.vw}×${r.vh}: **${v.rule}** ${v.id} — ${v.detail}`)) : ["None."]), "",
      "## Harness retries", "", ...(retries.length ? retries.map((r) => `- ${r}`) : ["None."]), "",
      "## Soft findings (counts by rule)", "", ...[...softBy].map(([k, n]) => `- ${k}: ${n}`), "",
      "Examples:", "", ...results.flatMap((r) => r.soft.slice(0, 2).map((v) => `- ${r.view} ${r.vw}×${r.vh}: ${v.rule} ${v.id} — ${v.detail}`)).slice(0, 24), "",
    ].join("\n");
    writeFileSync("docs/BEAUTY-REPORT.md", md);
  }
}
finish();
