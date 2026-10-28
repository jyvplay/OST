/** Real-browser edge placement of the classic desktop menu. Exclusive disposable server only. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Refusing desktop menu test without a disposable database, matching server and BASE.");
const BASE = process.env.BASE, { test, finish } = makeHarness("e2e-tt96-desktop-menu"), browser = await launchChromium();
const api = async (method: string, path: string, body?: object) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json();
};
const settings = (await api("GET", "/api/settings")).rows as { key: string; value: string }[];
const originals = Object.fromEntries(["appearance.layout", "appearance.desktopView", "appearance.textScale"].map((key) => [key, settings.find((x) => x.key === key)?.value]));
async function setup(width: number, height: number, scale: string, layout = "fusion") {
  for (const [key, value] of Object.entries({ "appearance.layout": layout, "appearance.desktopView": "classic", "appearance.textScale": scale })) await api("PUT", "/api/settings", { key, value });
  const old = await api("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(old.row?.revision ?? 1) + 1000, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: width, h: height }, icons: [], focusMode: false } });
  const ctx = await browser.newContext({ viewport: { width, height } }); const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const desk = page.locator('[data-pointer-gesture-surface="classic"]'); await desk.waitFor({ timeout: 30_000 });
  await page.locator(`[data-shell-ready="true"][data-layout="${layout}"]`).waitFor({ timeout: 30_000 });
  await page.waitForFunction((wanted) => Math.abs(Number(getComputedStyle(document.documentElement).getPropertyValue("--fs-ts")) - wanted) < 0.01, Number(scale) / 100, { timeout: 10_000 });
  return { ctx, page, desk };
}
try {
  await test("a lower-right desktop context menu stays within its usable surface and Sort can be clicked", { "LY-06": "partial", "AX-02": "partial" }, async () => {
    const { ctx, page, desk } = await setup(1440, 900, "125");
    try {
      const d = await desk.boundingBox(); assert.ok(d);
      await page.mouse.click(d.x + d.width - 18, d.y + d.height - 18, { button: "right" });
      const menu = page.getByRole("menu"); await menu.waitFor({ timeout: 10_000 }); const m = await menu.boundingBox(); assert.ok(m);
      assert.ok(m.x >= d.x - 1 && m.x + m.width <= d.x + d.width + 1, `menu horizontally escapes surface: ${JSON.stringify({ d, m })}`);
      assert.ok(m.y >= d.y - 1 && m.y + m.height <= d.y + d.height + 1, `menu vertically escapes surface: ${JSON.stringify({ d, m })}`);
      await menu.getByRole("menuitem", { name: "Sort icons by name" }).click({ timeout: 5000 });
      await menu.waitFor({ state: "detached", timeout: 5000 });
    } finally { await ctx.close(); }
  });
  await test("an open edge menu reclamps after the viewport shrinks", { "LY-06": "partial" }, async () => {
    const { ctx, page, desk } = await setup(1440, 900, "125");
    try {
      const d = await desk.boundingBox(); assert.ok(d);
      await page.mouse.click(d.x + d.width - 18, d.y + d.height - 18, { button: "right" });
      const menu = page.getByRole("menu"); await menu.waitFor({ timeout: 10_000 }); await page.setViewportSize({ width: 600, height: 500 });
      await page.waitForFunction(() => {
        const d = document.querySelector('[data-pointer-gesture-surface="classic"]')?.getBoundingClientRect();
        const m = document.querySelector('[role="menu"]')?.getBoundingClientRect();
        return !!d && !!m && m.left >= d.left - 1 && m.top >= d.top - 1 && m.right <= d.right + 1 && m.bottom <= d.bottom + 1;
      }, null, { timeout: 10_000 });
      await menu.getByRole("menuitem", { name: "Sort icons by name" }).click({ timeout: 5000 });
    } finally { await ctx.close(); }
  });
  await test("the geometry and real click checks detect an injected old-style offscreen placement", { "LY-06": "partial", "AX-02": "partial" }, async () => {
    const { ctx, page, desk } = await setup(1440, 900, "125");
    try {
      const d = await desk.boundingBox(); assert.ok(d); await page.mouse.click(d.x + d.width - 18, d.y + d.height - 18, { button: "right" });
      const menu = page.getByRole("menu"); await menu.waitFor({ timeout: 10_000 });
      // A persistent fault is required: the menu's ResizeObserver can legitimately repair a one-shot
      // inline mutation when its expanded action list changes dimensions / starts scrolling.
      const fault = await page.addStyleTag({ content: `[role="menu"] { left: ${d.width - 18}px !important; top: ${d.height - 18}px !important; }` });
      const m = await menu.boundingBox(); assert.ok(m);
      assert.ok(m.x + m.width > d.x + d.width && m.y + m.height > d.y + d.height, "geometry assertion must detect the injected bad placement");
      await assert.rejects(() => menu.getByRole("menuitem", { name: "Sort icons by name" }).click({ timeout: 1200 }), /Timeout/);
      await fault.evaluate(node => node.remove());
      // A fresh actual context-menu invocation must repair the placement.
      await page.mouse.click(d.x + d.width - 18, d.y + d.height - 18, { button: "right" });
      await menu.getByRole("menuitem", { name: "Sort icons by name" }).click({ timeout: 5000 });
    } finally { await ctx.close(); }
  });
  await test("the Art layout's dock does not intercept a bottom-edge desktop menu", { "LY-06": "partial", "LY-03": "partial" }, async () => {
    const { ctx, page, desk } = await setup(1440, 900, "125", "art");
    try {
      const d = await desk.boundingBox(); assert.ok(d);
      await page.mouse.click(d.x + d.width * 0.7, d.y + d.height - 18, { button: "right" });
      const menu = page.getByRole("menu"); await menu.waitFor({ timeout: 10_000 });
      const m = await menu.boundingBox(); assert.ok(m && m.y + m.height <= d.y + d.height + 1);
      await menu.getByRole("menuitem", { name: "Sort icons by name" }).click({ timeout: 5000 });
      await menu.waitFor({ state: "detached", timeout: 5000 });
    } finally { await ctx.close(); }
  });
  await test("at large text on a narrow viewport every menu action remains reachable", { "LY-06": "partial", "AX-02": "partial" }, async () => {
    const { ctx, page, desk } = await setup(390, 640, "200");
    try {
      const d = await desk.boundingBox(); assert.ok(d);
      // At this size the user's desktop widgets cover the right side; use the
      // uncovered lower-left-ish desk, still close enough to force vertical clamping.
      await page.mouse.click(d.x + d.width * 0.35, d.y + d.height - 12, { button: "right" });
      const menu = page.getByRole("menu"); await menu.waitFor({ timeout: 10_000 }); const m = await menu.boundingBox(); assert.ok(m);
      assert.ok(m.y >= d.y - 1 && m.y + m.height <= d.y + d.height + 1, `large menu escapes surface: ${JSON.stringify({ d, m })}`);
      await menu.getByRole("menuitem", { name: "Spec register" }).click({ timeout: 5000 });
      await page.locator('[role="dialog"][aria-label="Spec"]').first().waitFor({ timeout: 10_000 });
    } finally { await ctx.close(); }
  });
} finally {
  await browser.close();
  for (const [key, value] of Object.entries(originals)) if (value !== undefined) await api("PUT", "/api/settings", { key, value });
}
finish();
