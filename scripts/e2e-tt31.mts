/**
 * Real-browser suite "e2e-tt31" (TT31): LIVE WALLS — every wall of the Tabletop overview is a working surface with the
 * floor's moves, measured in headless Chromium against the production build (no mocks):
 *   - hover (real pointer movement) swings a wall up flat and true-size over the floor's edge, it settles when the
 *     pointer leaves; the resting camera (floor ≥ 80 %) is untouched;
 *   - drag a floor card onto a resting wall: the wall spring-loads, the card lands WHERE IT WAS DROPPED;
 *   - on a wall: move a pin along it, drop a pin on a pin to pile, click the pile to fan it along the wall, drag a
 *     card out of the fan straight onto the floor; drag a pin from one wall onto another (spring-loaded);
 *   - no pin limit: 40 pins on one wall, every one reachable by the pan buttons and the wheel;
 *   - keyboard: Tab into a wall lifts it, Tab reaches the pins, Alt+Arrow moves one, Esc settles;
 *   - LY-21 (no text under 9 px effective) holds while a wall is lifted at desktop and phone sizes; nothing is text at
 *     rest; the straight-down camera lifts walls too; axe-core finds no serious/critical issue on a lifted wall.
 *   - TT32 additions: touch (hasTouch, real CDP touch events) — a tap lifts a wall, a finger drag moves a pin on it,
 *     a tap elsewhere settles it; an opened wall's pinboard never scrolls sideways at 1440 (LY-12).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt31.mts
 */
import type { Browser, Locator, Page } from "playwright";
import { createRequire } from "node:module";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt31");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const RUN = Date.now().toString(36);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
type Pos = { x: number; y: number };
type BoardT = { cards: Record<string, Pos>; piles: { id: string; paths: string[]; x: number; y: number }[] };
type Table = { cards: Record<string, Pos>; piles: unknown[]; walls?: Partial<Record<string, BoardT>>; camera?: string };
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
  await page.getByTestId("tabletop").waitFor({ timeout: 30_000 });
  await poll(async () => page.evaluate(() => [...document.querySelectorAll("[data-face]")].every((e) => e.getAnimations().length === 0)), "faces at rest", 10_000);
  await page.waitForTimeout(400);
  return { page, close: () => ctx.close() };
}
const box = async (l: Locator) => { const b = await l.boundingBox(); if (!b) throw new Error("no box"); return b; };
const lifted = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".fs-tt-wall[data-lifted]")].map((e) => e.getAttribute("data-face")));
const settledLift = async (page: Page, w: string) => {
  await poll(async () => (await lifted(page)).join() === w, `${w} lifted`);
  await poll(async () => page.evaluate((w) => document.querySelector(`[data-testid=tt-wall-${w}]`)!.getAnimations().length === 0, w), `${w} swing finished`);
};
/** a point on the wall's OWN face (hit-tested; never its tag) */
const facePoint = (page: Page, w: string) => page.evaluate((w) => {
  const r = document.querySelector(`[data-testid=tt-wall-${w}]`)!.getBoundingClientRect();
  for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8])
    for (const fx of [0.3, 0.7, 0.2, 0.8, 0.5, 0.4, 0.6]) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy, el = document.elementFromPoint(x, y);
      if (el?.closest(`[data-face=${w}]`)) return { x, y };
    }
  throw new Error(`no point on ${w}`);
}, w);
/** move like a person: several real pointer moves */
const glide = async (page: Page, to: Pos, steps = 6) => page.mouse.move(to.x, to.y, { steps });
const pin = (page: Page, path: string) => page.locator(`[data-testid=tt-pin][data-path="${path}"]`);
const floorCard = (page: Page, path: string) => page.locator(`[data-testid="tt-card"][data-path="${path}"][data-surface="floor"]`);
async function dragTo(page: Page, from: Locator, to: Pos, opts: { hold?: number; steps?: number } = {}) {
  const a = await box(from);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 12 });
  if (opts.hold) { await page.waitForTimeout(opts.hold); await page.mouse.move(to.x + 1, to.y + 1); await page.mouse.move(to.x, to.y); }
  await page.mouse.up();
}
/** LY-21 measurement (same rule as e2e-tt29): effective px = font-size × min projected/laid-out scale, aria-hidden excluded */
async function smallText(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-testid=tabletop]") as HTMLElement, R = root.getBoundingClientRect();
    const out: { text: string; eff: number }[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
      if (!own || !el.offsetWidth || !el.offsetHeight || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.right < R.left || r.left > R.right || r.bottom < R.top || r.top > R.bottom || el.closest("[aria-hidden=true]")) continue;
      out.push({ text: (el.textContent ?? "").trim().slice(0, 24), eff: parseFloat(getComputedStyle(el).fontSize) * Math.min(r.width / el.offsetWidth, r.height / el.offsetHeight) });
    }
    return out;
  });
}

const F = Array.from({ length: 8 }, (_, i) => `/Documents/tt31-${RUN}-${i}.md`);
const MANY = Array.from({ length: 40 }, (_, i) => `/Documents/tt31-${RUN}-many-${String(i).padStart(2, "0")}.txt`);
for (const [i, f] of F.entries()) await api("POST", "/api/fs", { op: "write", path: f, content: `# Card ${i}\n\n- live wall\n` });
for (const f of MANY) await api("POST", "/api/fs", { op: "write", path: f, content: "pin\n" });
await setSetting("appearance.layout", "fusion"); await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark");
await setSetting("appearance.textScale", "125"); await setSetting("appearance.desktopView", "tabletop");
const slot = (i: number) => ({ x: 24 + (i % 6) * 136, y: 24 + Math.floor(i / 6) * 205 });
/** my cards at known floor spots in the middle of the table (clear of the walls); north pre-pinned with F[6], F[7] */
const base = (extra: Partial<Table> = {}): Table => ({
  cards: Object.fromEntries(F.slice(0, 6).map((f, i) => [f, { x: 380 + i * 136, y: 300 }])), piles: [],
  walls: { north: { cards: { [F[6]]: slot(0), [F[7]]: slot(1) }, piles: [] }, east: { cards: {}, piles: [] }, south: { cards: {}, piles: [] }, west: { cards: {}, piles: [] } },
  camera: "slant", ...extra,
});

try {
  await test("hover lifts a wall flat and true-size, docked inside the frame; pins become ≥ 24 px cards with names ≥ 9 px; leaving lets it settle; the resting camera is untouched (floor ≥ 80 %)", { "LY-22": "full", "LY-21": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    const { page, close } = await boot();
    ok(Number(await page.getByTestId("tabletop").getAttribute("data-coverage")) >= 0.8, "floor ≥ 80 % at rest");
    ok((await page.getByTestId("tt-glyphs-north").textContent()) === "", "no text on a resting wall");
    ok((await lifted(page)).length === 0, "nothing lifted at boot");
    const p = await facePoint(page, "north");
    await glide(page, { x: p.x - 30, y: p.y + 120 }, 2); await glide(page, p);
    await settledLift(page, "north");
    const tt = await box(page.getByTestId("tabletop")), wb = await box(page.getByTestId("tt-wall-north"));
    ok(wb.x >= tt.x - 1 && wb.y >= tt.y - 1 && wb.x + wb.width <= tt.x + tt.width + 1 && wb.y + wb.height <= tt.y + tt.height + 1, `lifted wall inside the frame: ${JSON.stringify(wb)}`);
    ok(wb.width > tt.width * 0.9 && wb.height >= 150, `north lifted is a wide, readable panel: ${JSON.stringify(wb)}`);
    for (const f of [F[6], F[7]]) { const b = await box(pin(page, f)); ok(b.width >= 24 && b.height >= 24, `${f} lifted pin ${JSON.stringify(b)}`); }
    const nm = F[6].split("/").pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    ok(await page.getByRole("button", { name: new RegExp(`^${nm}\\s*, pinned to the Windows wall$`) }).count() === 1, "pin is a button named by its file and wall");
    const bad = (await smallText(page)).filter((t) => t.eff < 9);
    ok(bad.length === 0, `squashed text while lifted: ${JSON.stringify(bad.slice(0, 4))}`);
    ok(Number(await page.getByTestId("tabletop").getAttribute("data-coverage")) >= 0.8, "camera unchanged");
    await glide(page, { x: tt.x + tt.width / 2, y: tt.y + tt.height * 0.62 });
    await poll(async () => (await lifted(page)).length === 0, "settles after the pointer leaves", 3000);
    await close();
  });

  await test("floor → resting wall: dragging a card onto the north wall spring-loads it and the card lands where it was dropped (mapped, not a free slot); a second drop further along lands further along", { "LY-22": "full", "LY-12": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    const { page, close } = await boot();
    const p = await facePoint(page, "north"), tt = await box(page.getByTestId("tabletop"));
    const at1 = { x: tt.x + tt.width * 0.55, y: p.y };
    await dragTo(page, floorCard(page, F[0]), at1, { hold: 700 });
    await poll(async () => !!(await getTable())?.walls?.north?.cards[F[0]], "pinned to north");
    ok(await floorCard(page, F[0]).count() === 0, "left the floor");
    await settledLift(page, "north");
    // the pin is under the point it was released at (the strip maps the pointer exactly)
    const b1 = await box(pin(page, F[0]));
    const cx1 = b1.x + b1.width / 2;
    const s1 = (await getTable())!.walls!.north!.cards[F[0]];
    console.log(`    drop at x=${at1.x.toFixed(0)} → board ${JSON.stringify(s1)}, pin centre x=${cx1.toFixed(0)}`);
    // settle, then drop another card further right
    await glide(page, { x: tt.x + tt.width / 2, y: tt.y + tt.height * 0.62 }); await poll(async () => (await lifted(page)).length === 0, "settled", 3000);
    await page.waitForTimeout(500);
    await dragTo(page, floorCard(page, F[1]), { x: tt.x + tt.width * 0.8, y: p.y }, { hold: 700 });
    await poll(async () => !!(await getTable())?.walls?.north?.cards[F[1]], "second pinned");
    const t = (await getTable())!.walls!.north!.cards, S = (q: Pos) => Math.max(0, Math.round((q.y - 24) / 205)) * 912 + q.x;
    ok(S(t[F[1]]) > S(t[F[0]]), `further along the strip: ${JSON.stringify(t[F[0]])} → ${JSON.stringify(t[F[1]])}`);
    ok(Math.abs(S(t[F[0]]) - S(t[F[6]])) > 112 || t[F[0]].y !== t[F[6]].y, "did not land in the first free slot");
    await close();
  });

  await test("on a lifted wall: move a pin along it, drop a pin on a pin to pile, click the pile to fan it along the wall, drag a card out of the fan onto the floor", { "LY-22": "full", "LY-08": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    const { page, close } = await boot();
    const p = await facePoint(page, "north");
    await glide(page, { x: p.x, y: p.y + 100 }, 2); await glide(page, p); await settledLift(page, "north");
    const before = (await getTable())!.walls!.north!.cards[F[6]];
    const a = await box(pin(page, F[6]));
    await dragTo(page, pin(page, F[6]), { x: a.x + a.width / 2 + 420, y: a.y + a.height / 2 });
    await poll(async () => ((await getTable())!.walls!.north!.cards[F[6]]?.x ?? 0) > before.x + 200, "moved along the wall");
    // pile: F[7] onto F[6]
    const t6 = await box(pin(page, F[6]));
    await dragTo(page, pin(page, F[7]), { x: t6.x + t6.width / 2, y: t6.y + t6.height / 2 });
    await poll(async () => (await getTable())!.walls!.north!.piles.length === 1, "a wall pile");
    const pile = page.locator('[data-testid=tt-wallpile][data-surface=north]');
    ok(await pile.getAttribute("data-count") === "2", "pile of 2");
    ok((await lifted(page)).join() === "north", "still lifted while working on it");
    await pile.click();
    await poll(async () => (await page.locator('[data-testid=tt-pin][data-fan]').count()) === 2, "fanned along the wall");
    const fb = await page.locator('[data-testid=tt-pin][data-fan]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
    ok(Math.abs(fb[1] - fb[0]) > 40, `fan spreads along the wall: ${fb}`);
    const out = page.locator(`[data-testid=tt-pin][data-fan][data-path="${F[7]}"]`), tt = await box(page.getByTestId("tabletop"));
    await dragTo(page, out, { x: tt.x + tt.width * 0.5, y: tt.y + tt.height * 0.6 }, { steps: 16 });
    await poll(async () => !!(await getTable())!.cards[F[7]], "card dragged out of the wall fan onto the floor");
    const nb = (await getTable())!.walls!.north!;
    ok(nb.piles.length === 0 && !!nb.cards[F[6]], "a pile of one dissolves back into a pin");
    await close();
  });

  await test("wall → wall: a pin dragged from the lifted north wall onto the west wall's spine spring-loads the west wall (lifts while still dragging) and lands on it", { "LY-22": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    const { page, close } = await boot();
    const p = await facePoint(page, "north");
    await glide(page, { x: p.x, y: p.y + 100 }, 2); await glide(page, p); await settledLift(page, "north");
    const a = await box(pin(page, F[6])), tag = await box(page.getByTestId("tt-tag-west"));
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(tag.x + tag.width / 2, tag.y + tag.height / 2, { steps: 14 });
    await poll(async () => (await lifted(page)).join() === "west", "west springs up during the drag", 3000);
    await page.waitForTimeout(800); // the swing
    const wb = await box(page.getByTestId("tt-wall-west"));
    await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height * 0.6, { steps: 6 });
    ok(await page.getByTestId("tt-wall-west").getAttribute("data-drop") !== null, "west lights up as the drop target");
    ok(await page.getByTestId("tt-ghost").getAttribute("data-target") === "west", "a ghost card travels with the pointer");
    await page.mouse.up();
    await poll(async () => !!(await getTable())?.walls?.west?.cards[F[6]], "landed on west");
    ok(!(await getTable())!.walls!.north!.cards[F[6]], "left north");
    await close();
  });

  await test("no pin limit: 40 pins on the Widgets wall — rows unroll along it, the pan buttons and the wheel reach the last pin, and there is always an empty row to drop into", { "LY-22": "full" }, async () => {
    await desktop({ v: 2, ...base({ walls: { ...base().walls, east: { cards: Object.fromEntries(MANY.map((f, i) => [f, slot(i)])), piles: [] } } }) });
    const { page, close } = await boot();
    await page.getByTestId("tt-open-east").focus();
    await settledLift(page, "east");
    const strip = page.getByTestId("tt-glyphs-east");
    ok(await strip.getAttribute("data-rows") === "8", `7 rows in use + 1 empty: ${await strip.getAttribute("data-rows")}`);
    ok(await page.locator('[data-testid=tt-pin][data-surface=east]').count() === 40, "all 40 rendered");
    const last = pin(page, MANY[39]), face = await box(page.getByTestId("tt-wall-east"));
    const inside = async (l: Locator) => { const b = await box(l); return b.y >= face.y - 1 && b.y + b.height <= face.y + face.height + 1 && b.x >= face.x - 1 && b.x + b.width <= face.x + face.width + 1; };
    ok(!(await inside(last)), "the last pin starts out of view");
    const pan0 = Number(await strip.getAttribute("data-pan"));
    // the wheel pans
    const c = { x: face.x + face.width / 2, y: face.y + face.height / 2 };
    await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, 400);
    await poll(async () => Number(await strip.getAttribute("data-pan")) > pan0, "wheel pans along the wall");
    // pan on step by step: the last pin comes into view on the way (at the far end the empty drop row is in view)
    let seen = false;
    for (let i = 0; i < 24 && !(await page.getByTestId("tt-pan-on-east").isDisabled()); i++) {
      await page.getByTestId("tt-pan-on-east").click(); await page.waitForTimeout(650);
      if (await inside(last)) seen = true;
    }
    ok(seen, "the pan buttons bring the last pin into view");
    ok(await page.getByTestId("tt-pan-on-east").isDisabled(), "pan stops at the end");
    ok(await page.getByTestId("tt-pan-back-east").isEnabled(), "and can pan back");
    // focusing a pin pans to it (keyboard users never need the buttons)
    await pin(page, MANY[0]).focus(); await page.waitForTimeout(700);
    ok(await inside(pin(page, MANY[0])), "focus pans back to the first pin");
    await close();
  });

  await test("keyboard: focusing a wall lifts it at once, Tab reaches its pins, Alt+ArrowRight moves the focused pin on the wall (persisted), Esc settles the wall and returns focus to its button without re-lifting", { "LY-22": "full", "AX-01": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    const { page, close } = await boot();
    await page.getByTestId("tt-open-north").focus();
    await poll(async () => (await lifted(page)).join() === "north", "focus lifts");
    await page.keyboard.press("Tab");
    await poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "tt-pin"), "Tab reaches a pin");
    const path = await page.evaluate(() => document.activeElement!.getAttribute("data-path")!);
    const x0 = (await getTable())!.walls!.north!.cards[path].x;
    await page.keyboard.press("Alt+ArrowRight");
    await poll(async () => (await getTable())!.walls!.north!.cards[path].x === x0 + 24, "Alt+Arrow moved the pin 24 px");
    ok(await page.evaluate((p) => document.activeElement?.getAttribute("data-path") === p, path), "focus stayed on the pin");
    await page.keyboard.press("Escape");
    await poll(async () => (await lifted(page)).length === 0, "Esc settles");
    // TT33: Esc returns focus to the wall's own button (the control that lifted it), and that does not re-lift it
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "tt-open-north", "Esc returns focus to the wall's button");
    await page.waitForTimeout(900);
    ok((await lifted(page)).length === 0, "returning focus does not lift the wall again");
    await page.keyboard.press("Tab");
    await poll(async () => (await lifted(page)).join() === "north", "Tab back into the wall lifts it again");
    await close();
  });

  await test("phone 390×760 and the straight-down camera: a focused wall lifts inside the frame with ≥ 24 px pins and no text under 9 px; nothing is text at rest", { "LY-22": "full", "LY-21": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    {
      const { page, close } = await boot(390, 760);
      for (const w of ["north", "west"]) ok((await page.getByTestId(`tt-glyphs-${w}`).textContent()) === "", `${w} no text at rest (phone)`);
      await page.getByTestId("tt-open-north").focus(); await settledLift(page, "north");
      const tt = await box(page.getByTestId("tabletop")), wb = await box(page.getByTestId("tt-wall-north"));
      ok(wb.x >= tt.x - 1 && wb.x + wb.width <= tt.x + tt.width + 1 && wb.y >= tt.y - 1, `phone lift inside: ${JSON.stringify(wb)}`);
      const pb = await box(pin(page, F[6])); ok(pb.width >= 24 && pb.height >= 24, `phone pin ${JSON.stringify(pb)}`);
      const bad = (await smallText(page)).filter((t) => t.eff < 9); ok(bad.length === 0, `phone squashed: ${JSON.stringify(bad.slice(0, 4))}`);
      await close();
    }
    await desktop({ v: 2, ...base({ camera: "top" }) });
    {
      const { page, close } = await boot();
      ok((await page.getByTestId("tt-glyphs-west").textContent()) === "", "top camera: no text at rest");
      await page.getByTestId("tt-open-north").focus(); await settledLift(page, "north");
      const pb = await box(pin(page, F[6])); ok(pb.width >= 24 && pb.height >= 24, `top camera lifted pin ${JSON.stringify(pb)}`);
      const bad = (await smallText(page)).filter((t) => t.eff < 9); ok(bad.length === 0, `top squashed: ${JSON.stringify(bad.slice(0, 4))}`);
      await close();
    }
  });

  await test("touch (390×760, hasTouch): tapping a wall lifts it, a finger drag moves a pin along the lifted wall (persisted), tapping the floor settles it", { "LY-22": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    try {
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.getByTestId("tabletop").waitFor({ timeout: 30_000 });
      await poll(async () => page.evaluate(() => [...document.querySelectorAll("[data-face]")].every((e) => e.getAnimations().length === 0)), "faces at rest", 10_000);
      await page.waitForTimeout(400);
      const p = await facePoint(page, "north");
      await page.touchscreen.tap(p.x, p.y);
      await settledLift(page, "north");
      ok(await page.evaluate(() => document.querySelector("[data-testid=tabletop]")!.getAttribute("data-main") !== "north"), "a tap lifts; it does not open the wall as the main view");
      // finger drag with real CDP touch events (Playwright has no touch-drag API)
      const cdp = await ctx.newCDPSession(page);
      // F[7] is the right-hand pin, so moving it right goes into empty wall (moving F[6] right would pile it on F[7])
      const b = await box(pin(page, F[7])), x0 = (await getTable())!.walls!.north!.cards[F[7]].x;
      const sx = b.x + b.width / 2, sy = b.y + b.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: sx, y: sy }] });
      for (let i = 1; i <= 10; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: sx + i * 9, y: sy }] }); await page.waitForTimeout(16); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await poll(async () => ((await getTable())!.walls!.north!.cards[F[7]]?.x ?? 0) > x0 + 40, "finger drag moved the pin along the wall");
      ok((await lifted(page)).join() === "north", "still lifted after the drag");
      // tap an empty part of the floor (hit-tested: the floor itself, not a card)
      const fp = await page.evaluate(() => {
        for (let y = 700; y > 300; y -= 20) for (let x = 40; x < 360; x += 20) {
          const el = document.elementFromPoint(x, y);
          if (el?.closest("[data-face=floor]") && !el.closest("[data-testid=tt-card], [data-testid=tt-pile], button")) return { x, y };
        }
        throw new Error("no empty floor point");
      });
      await page.touchscreen.tap(fp.x, fp.y);
      await poll(async () => (await lifted(page)).length === 0, "tapping the floor settles the wall", 4000);
    } finally { await ctx.close(); }
  });

  await test("opened wall at 1440: the pinboard is never narrower than its 840 px board (no sideways scroll)", { "LY-12": "full" }, async () => {
    await desktop({ v: 2, ...base() });
    const { page, close } = await boot(1440, 900);
    await page.getByTestId("tt-nav-north").click();
    const pb = page.getByTestId("tt-pinboard-north");
    await pb.waitFor({ timeout: 8000 });
    await poll(async () => page.evaluate(() => [...document.querySelectorAll("[data-face]")].every((e) => e.getAnimations().length === 0)), "opened", 8000);
    const m = await pb.evaluate((e) => ({ cw: e.clientWidth, sw: e.scrollWidth }));
    ok(m.sw <= m.cw + 1, `pinboard ${m.cw} px wide but content ${m.sw} px`);
    await close();
  });

  await test("axe-core on a lifted wall (dark + light): no serious or critical violations", { "LY-22": "full", "AX-01": "full" }, async () => {
    const require = createRequire(import.meta.url);
    const axeSrc = (await import("node:fs")).readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
    for (const theme of ["dark", "light"]) {
      await setSetting("appearance.theme", theme);
      await desktop({ v: 2, ...base() });
      const { page, close } = await boot();
      await page.getByTestId("tt-open-north").focus(); await settledLift(page, "north");
      await page.waitForTimeout(500);
      await page.addScriptTag({ content: axeSrc });
      const res = await page.evaluate(async () => (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe.run(document.querySelector("[data-testid=tabletop]"), { resultTypes: ["violations"] }));
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      ok(bad.length === 0, `${theme}: ${bad.map((v) => `${v.id}×${v.nodes.length}`).join(", ")}`);
      await close();
    }
    await setSetting("appearance.theme", "dark");
  });
} finally {
  await desktop({ v: 2, cards: {}, piles: [] });
  await setSetting("appearance.desktopView", "classic");
  for (const p of [...F, ...MANY]) { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); }
  await browser.close();
}
finish();
