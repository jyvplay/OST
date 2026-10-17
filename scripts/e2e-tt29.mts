/**
 * Real-browser suite "e2e-tt29" (TT29): the Tabletop legibility level of detail, in headless Chromium against the
 * production build, measured (not assumed):
 *   - BEAUTY RULE "no squashed text": every visible text element on the Tabletop renders with an effective font
 *     (computed font-size × the smaller of its projected/laid-out width and height ratios) ≥ 9 px, under the default
 *     slanted camera, at desktop and phone sizes. Decorative miniatures marked aria-hidden (card content peeks) are
 *     excluded and COUNTED in the log, so the exclusion is visible.
 *   - walls too foreshortened for text show glyphs only; each gets a flat tag inside its visible area that names it,
 *     does not collide with the other tags or the switcher, opens the wall on click and accepts a dropped card (pin);
 *   - the straight-down camera keeps the detailed walls (no tags).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt29.mts
 */
import type { Browser, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt29");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const RUN = Date.now().toString(36);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
type Table = { walls?: Record<string, { cards: Record<string, unknown> } | undefined>; camera?: string };
const getTable = async () => (await api("GET", "/api/state?id=default")).json.row?.state?.table as Table | undefined;
async function desktop(table?: unknown) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }], activeWorkspace: 1, nextZ: 10, ...(table ? { table } : {}) } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); }
const browser: Browser = await launchChromium();
async function boot(vw = 1440, vh = 900) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  await page.getByTestId("tabletop").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1400); // never measure mid-transition
  return { page, close: () => ctx.close() };
}
const box = async (l: Locator) => { const b = await l.boundingBox(); if (!b) throw new Error("no box"); return b; };
const WALLS = ["north", "south", "west", "east"] as const;

/** every visible text element on the Tabletop: effective px = font-size × min(projected/laid-out) per axis */
async function textScales(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-testid=tabletop]") as HTMLElement, R = root.getBoundingClientRect();
    const out: { text: string; eff: number; sx: number; sy: number; where: string }[] = [];
    let decorative = 0;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
      if (!own || !el.offsetWidth || !el.offsetHeight) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.right < R.left || r.left > R.right || r.bottom < R.top || r.top > R.bottom) continue;
      if (el.closest("[aria-hidden=true]")) { decorative++; continue; }
      const sx = r.width / el.offsetWidth, sy = r.height / el.offsetHeight;
      const eff = parseFloat(getComputedStyle(el).fontSize) * Math.min(sx, sy);
      const face = el.closest("[data-face]")?.getAttribute("data-face") ?? (el.closest("[data-wall-tag]") ? "tag" : "flat");
      out.push({ text: (el.textContent ?? "").trim().slice(0, 30), eff, sx, sy, where: face });
    }
    return { items: out, decorative };
  });
}

const F = { a: `/Documents/tt29-${RUN}-a.txt`, b: `/Documents/tt29-${RUN}-b.txt` };
await api("POST", "/api/fs", { op: "write", path: F.a, content: "alpha card\n" });
await api("POST", "/api/fs", { op: "write", path: F.b, content: "beta card\n" });
await setSetting("appearance.layout", "fusion"); await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark");
await setSetting("appearance.textScale", "125");
await setSetting("appearance.desktopView", "tabletop");

try {
  await test("beauty rule 'no squashed text' (TT29): under the default slanted camera every visible Tabletop text renders at an effective ≥ 9 px (font-size × projected scale, measured per element) at 1440×900 and 390×800; walls below the legibility rule show glyphs only", { "LY-21": "full", "LY-20": "full" }, async () => {
    for (const [vw, vh] of [[1440, 900], [390, 800]] as const) {
      await desktop({ v: 2, cards: {}, piles: [], walls: { west: { cards: { [F.a]: { x: 24, y: 24 } }, piles: [] } } });
      const { page, close } = await boot(vw, vh);
      ok(await page.getByTestId("tabletop").getAttribute("data-camera") === "slant", "slanted by default");
      const { items, decorative } = await textScales(page);
      const worst = [...items].sort((a, b) => a.eff - b.eff).slice(0, 3);
      console.log(`    ${vw}×${vh}: ${items.length} text elements, smallest ${worst.map((w) => `${w.eff.toFixed(1)}px "${w.text}" (${w.where})`).join(", ")}; ${decorative} decorative aria-hidden miniatures excluded`);
      const bad = items.filter((i) => i.eff < 9);
      ok(bad.length === 0, `squashed text: ${JSON.stringify(bad.slice(0, 5))}`);
      for (const w of WALLS) {
        const g = page.getByTestId(`tt-glyphs-${w}`);
        ok(await g.count() === 1, `${w}: glyph LOD`);
        ok(((await g.textContent()) ?? "").trim() === "", `${w}: no text on a foreshortened wall`);
      }
      ok(await page.locator("[data-testid=tt-glyphs-west] .fs-tt-glyph").count() === 1, "the pinned card is drawn as a glyph");
      await close();
    }
  });

  await test("wall tags (TT29): one per foreshortened wall, inside the frame, centred on the wall's VISIBLE area (hit-test finds that wall under the centre), ≥ 24 px targets, no overlaps with each other or the switcher; counts in the label", { "LY-20": "full" }, async () => {
    await desktop({ v: 2, cards: {}, piles: [], walls: { east: { cards: { [F.a]: { x: 24, y: 24 } }, piles: [] } } });
    for (const [vw, vh] of [[1440, 900], [390, 800]] as const) {
      const { page, close } = await boot(vw, vh);
      const tt = await box(page.getByTestId("tabletop"));
      const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const w of WALLS) {
        const t = page.getByTestId(`tt-tag-${w}`);
        const b = await box(t); boxes[w] = b;
        ok(b.x >= tt.x - 0.5 && b.y >= tt.y - 0.5 && b.x + b.width <= tt.x + tt.width + 0.5 && b.y + b.height <= tt.y + tt.height + 0.5, `${w} tag inside the frame at ${vw}: ${JSON.stringify(b)}`);
        ok(b.width >= 24 && b.height >= 24, `${w} tag ≥ 24 px (WCAG 2.5.8)`);
        // under the tag (tags hidden), the topmost face is that wall: at the CENTRE on desktop; on a phone the side
        // sliver is narrower than a 24 px target, so there the spine must OVERLAP its sliver (outer edge on the wall)
        const pts = vw >= 1000 || !(w === "west" || w === "east") ? [[b.x + b.width / 2, b.y + b.height / 2]] : Array.from({ length: Math.floor(b.width / 2) }, (_, i) => [b.x + 1 + i * 2, b.y + b.height / 2]); // every 2 px across the spine
        const faces = await page.evaluate((ps) => {
          const tags = Array.from(document.querySelectorAll<HTMLElement>("[data-wall-tag]")); tags.forEach((e) => (e.style.visibility = "hidden"));
          const f = ps.map(([x, y]) => document.elementsFromPoint(x, y).map((e) => e.closest("[data-face]")).find(Boolean)?.getAttribute("data-face"));
          tags.forEach((e) => (e.style.visibility = "")); return f;
        }, pts);
        ok(faces.includes(w), `${w} tag sits on its wall (found ${[...new Set(faces)].join("/")}) at ${vw}`);
      }
      const nav = await page.getByTestId("tt-nav").boundingBox();
      const all = Object.entries(boxes);
      const hit = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) ok(!hit(all[i][1], all[j][1]), `${all[i][0]} and ${all[j][0]} tags overlap at ${vw}`);
        if (nav) ok(!hit(all[i][1], nav), `${all[i][0]} tag under the switcher at ${vw}`);
      }
      ok(/^Widgets · 1 pinned$/.test(((await page.getByTestId("tt-tag-east").textContent()) ?? "").trim()), "east label carries the pin count");
      ok(await page.getByTestId("tt-tag-west").getAttribute("data-vertical") !== null, "side wall tag is a vertical spine");
      await close();
    }
  });

  await test("wall tags are the click AND drop targets the slivers could not be (TT29): clicking the Apps spine opens the Apps wall; dragging a floor card onto the Widgets spine highlights it and pins the card there (persisted)", { "LY-20": "full", "LY-12": "full" }, async () => {
    await desktop({ v: 2, cards: {}, piles: [] });
    const { page, close } = await boot();
    await page.getByTestId("tt-tag-west").click();
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "west", "Apps spine → Apps wall");
    ok(await page.getByTestId("tt-tag-west").count() === 0, "tags leave with the overview");
    await page.keyboard.press("Escape");
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "floor", "Esc → floor");
    await page.waitForTimeout(1300);
    const c = page.locator(`[data-testid="tt-card"][data-path="${F.b}"]`);
    await c.waitFor();
    const a = await box(c), t = await box(page.getByTestId("tt-tag-east"));
    const to = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + a.width / 2 + ((to.x - a.x - a.width / 2) * i) / 10, a.y + a.height / 2 + ((to.y - a.y - a.height / 2) * i) / 10);
    ok(await page.getByTestId("tt-tag-east").getAttribute("data-drop") !== null, "the tag lights up as a drop target");
    await page.mouse.up();
    await poll(async () => !!(await getTable())?.walls?.east?.cards[F.b], "pinned to the Widgets wall in the saved state");
    await poll(async () => /1 pinned/.test((await page.getByTestId("tt-tag-east").textContent()) ?? ""), "tag count updates");
    ok(await page.locator(`[data-testid="tt-card"][data-path="${F.b}"][data-surface="floor"]`).count() === 0, "left the floor");
    await close();
  });

  await test("straight-down camera obeys the same rule: its walls are below the legibility scale too (computed), so they show glyphs + tags; no visible text under 9 px effective; the computed box model matches the DOM (each wall face's measured box = its quad's box ± 2 px)", { "LY-20": "full", "LY-21": "full" }, async () => {
    await desktop({ v: 2, cards: {}, piles: [], camera: "top" });
    const { page, close } = await boot();
    ok(await page.getByTestId("tabletop").getAttribute("data-camera") === "top", "top camera");
    const tt = await box(page.getByTestId("tabletop"));
    const D = Number(await page.getByTestId("tabletop").getAttribute("data-depth")), s = Number(await page.getByTestId("tabletop").getAttribute("data-floor-scale"));
    const W = tt.width, H = tt.height, l = W / 2 - (W * s) / 2, r = W / 2 + (W * s) / 2, t = H / 2 - (H * s) / 2, b = H / 2 + (H * s) / 2;
    const expect: Record<string, [number, number, number, number]> = { north: [0, 0, W, t], south: [0, b, W, H], west: [0, 0, l, H], east: [r, 0, W, H] };
    for (const w of WALLS) {
      const m = await box(page.getByTestId(`tt-wall-${w}`)), [x0, y0, x1, y1] = expect[w];
      ok(Math.abs(m.x - tt.x - x0) <= 2 && Math.abs(m.y - tt.y - y0) <= 2 && Math.abs(m.x + m.width - tt.x - x1) <= 2 && Math.abs(m.y + m.height - tt.y - y1) <= 2,
        `${w}: DOM box ${JSON.stringify(m)} vs model [${[x0, y0, x1, y1].map((v) => v.toFixed(1))}] (D=${D}, s=${s})`);
      ok(await page.getByTestId(`tt-glyphs-${w}`).count() === 1 && await page.getByTestId(`tt-tag-${w}`).count() === 1, `${w}: glyphs + tag`);
    }
    // found by visual review: the south tag landed under the switcher in this camera
    const nav = await box(page.getByTestId("tt-nav"));
    for (const w of WALLS) { const b = await box(page.getByTestId(`tt-tag-${w}`)); ok(!(b.x < nav.x + nav.width && nav.x < b.x + b.width && b.y < nav.y + nav.height && nav.y < b.y + b.height), `${w} tag under the switcher (top camera): ${JSON.stringify(b)} vs ${JSON.stringify(nav)}`); }
    const { items, decorative } = await textScales(page);
    const bad = items.filter((i) => i.eff < 9);
    console.log(`    top camera: ${items.length} text elements, smallest ${Math.min(...items.map((h) => h.eff)).toFixed(1)} px; ${decorative} decorative excluded`);
    ok(bad.length === 0, `squashed text: ${JSON.stringify(bad.slice(0, 5))}`);
    await page.getByTestId("tt-tag-north").click();
    await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "north", "tag opens the wall in the top camera too");
    await close();
  });
} finally {
  await desktop({ v: 2, cards: {}, piles: [] });
  await setSetting("appearance.desktopView", "classic");
  for (const p of Object.values(F)) { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); }
  await browser.close();
}
finish();
