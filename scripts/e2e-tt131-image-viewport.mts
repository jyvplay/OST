/** Image Studio keyboard access to an oversized document, in real Chromium.
 * This changes the desktop state on an explicitly disposable server/database. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE;
const { test, finish } = makeHarness("e2e-tt131-image-viewport");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return await r.json() as T;
}
const initial = await api<{ row?: { state?: unknown } }>("GET", "/api/state?id=default");
const latest = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
await api("PUT", "/api/state", { id: "default", revision: Number(latest.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "imageedit", title: "Image Editor", x: 40, y: 20, w: 1100, h: 760, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const studio = page.getByTestId("image-studio");
  await studio.waitFor({ timeout: 30_000 });
  const viewport = studio.locator(":scope > .fs-scroll").first();
  const canvas = studio.getByTestId("studio-canvas");
  await studio.getByLabel("Zoom", { exact: true }).selectOption("8");
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="image-studio"] > .fs-scroll');
    return !!el && el.scrollWidth > el.clientWidth + 100 && el.scrollHeight > el.clientHeight + 100;
  });

  await test("zoomed image viewport exposes a named keyboard focus target and arrow-key panning", { "AX-08": "partial", "IE-01": "partial" }, async () => {
    const info = await viewport.evaluate((el) => ({ tabIndex: (el as HTMLElement).tabIndex, role: el.getAttribute("role"), name: el.getAttribute("aria-label") }));
    assert.equal(info.tabIndex, 0, "the scrollable canvas viewport must be in the tab order");
    assert.equal(info.role, "region"); assert.ok(info.name?.trim(), "the region needs a descriptive accessible name");
    await viewport.evaluate((el) => el.scrollTo(0, 0));
    await studio.getByLabel("Background colour").focus();
    await page.keyboard.press("Tab");
    assert.ok(await viewport.evaluate((el) => document.activeElement === el), "keyboard Tab reaches the actual scroll container");
    const handle = await viewport.elementHandle();
    // Keep each key down until the browser has executed a scroll frame. An
    // immediate synthetic down/up was intermittent in headless Chromium.
    await page.keyboard.down("ArrowRight");
    try { await page.waitForFunction((el) => el.scrollLeft > 0, handle, { timeout: 5_000 }); }
    catch (e) {
      const state = await viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, scrollWidth: el.scrollWidth, active: document.activeElement === el, overflowX: getComputedStyle(el).overflowX, dir: getComputedStyle(el).direction }));
      throw new Error(`ArrowRight did not pan: ${JSON.stringify(state)}: ${String(e)}`);
    } finally { await page.keyboard.up("ArrowRight"); }
    await page.keyboard.down("ArrowDown");
    try { await page.waitForFunction((el) => el.scrollTop > 0, handle, { timeout: 5_000 }); }
    finally { await page.keyboard.up("ArrowDown"); }
    if (process.env.TT131_CAPTURE === "1") await page.screenshot({ path: "docs/screens/tt131-image-viewport.png" });
    const position = await viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(({ el, before }) => el.scrollLeft < before, { el: handle, before: position.left }, { timeout: 5_000 });
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(({ el, before }) => el.scrollTop < before, { el: handle, before: position.top }, { timeout: 5_000 });
    await page.keyboard.press("Tab");
    assert.equal(await viewport.evaluate((el) => document.activeElement === el), false, "Tab can leave the viewport");
  });

  await test("modified arrows are not consumed by the viewport handler", { "IE-01": "partial" }, async () => {
    const result = await viewport.evaluate((el) => {
      const event = new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(result, false, "Ctrl+ArrowRight remains available to browser or shell handlers");
  });

  await test("viewport focus keeps existing editor shortcuts available", { "IE-01": "partial" }, async () => {
    await viewport.focus();
    await page.keyboard.press("e");
    await page.waitForFunction(() => document.querySelector('[data-testid="image-studio"]')?.getAttribute("data-tool") === "eraser");
    await page.keyboard.press("b");
    await page.waitForFunction(() => document.querySelector('[data-testid="image-studio"]')?.getAttribute("data-tool") === "brush");
  });

  await test("oversized canvas reaches both opposite document corners by scrolling", { "IE-01": "partial" }, async () => {
    const corners = await viewport.evaluate((el) => {
      const image = el.querySelector("canvas")!;
      const read = () => { const a = el.getBoundingClientRect(), b = image.getBoundingClientRect(); return { left: b.left - a.left, top: b.top - a.top, right: b.right - a.right, bottom: b.bottom - a.bottom }; };
      el.scrollTo(0, 0); const start = read();
      el.scrollTo(el.scrollWidth, el.scrollHeight); const end = read();
      return { start, end };
    });
    assert.ok(corners.start.left >= -1 && corners.start.top >= -1, `top-left cropped beyond the scroll origin: ${JSON.stringify(corners)}`);
    assert.ok(corners.end.right <= 1 && corners.end.bottom <= 1, `bottom-right unreachable: ${JSON.stringify(corners)}`);
  });

  await test("drawing-kit buttons stay within their rail", { "IE-01": "partial" }, async () => {
    const rail = studio.getByRole("toolbar", { name: "Drawing kit" });
    const overflow = await rail.evaluate((el) => {
      const container = el.getBoundingClientRect();
      return [...el.querySelectorAll("button")].map((button) => {
        const r = button.getBoundingClientRect();
        return { name: button.getAttribute("aria-label"), left: r.left - container.left, right: r.right - container.right };
      }).filter((r) => r.left < -1 || r.right > 1);
    });
    assert.deepEqual(overflow, [], `buttons overlap the canvas: ${JSON.stringify(overflow)}`);
  });

  await test("drawing-kit controls have distinct vector marks, full names, and fit the rail", { "AX-08": "partial", "IE-01": "partial" }, async () => {
    const rail = studio.getByRole("toolbar", { name: "Drawing kit" });
    const names = ["Move", "Rect select", "Ellipse select", "Magic wand", "Brush", "Eraser", "Bucket", "Gradient", "Eyedropper"];
    const marks: string[] = [];
    for (const name of names) {
      const button = rail.getByRole("button", { name, exact: true });
      assert.equal(await button.count(), 1, `missing accessible tool ${name}`);
      assert.equal(await button.locator('svg[aria-hidden="true"]').count(), 1, `missing vector mark for ${name}`);
      marks.push(await button.locator("svg").innerHTML());
      const bounds = await button.evaluate((el) => {
        const a = el.getBoundingClientRect(), b = el.parentElement!.getBoundingClientRect();
        return { left: a.left - b.left, right: a.right - b.right };
      });
      assert.ok(bounds.left >= -1 && bounds.right <= 1, `${name} escapes its rail: ${JSON.stringify(bounds)}`);
    }
    assert.equal(new Set(marks).size, names.length, "tools must not share indistinguishable marks");
  });

  await test("the drawing rail stays usable at doubled text scale", { "AX-08": "partial", "IE-01": "partial" }, async () => {
    const prior = await page.evaluate(() => document.documentElement.style.getPropertyValue("--fs-ts"));
    try {
      await page.evaluate(() => document.documentElement.style.setProperty("--fs-ts", "2"));
      const rail = studio.getByRole("toolbar", { name: "Drawing kit" });
      const last = rail.getByRole("button", { name: "Eyedropper", exact: true });
      await last.focus();
      const geometry = await last.evaluate((el) => {
        const button = el.getBoundingClientRect(), parent = el.parentElement!.getBoundingClientRect();
        return { left: button.left - parent.left, right: button.right - parent.right, top: button.top - parent.top, bottom: button.bottom - parent.bottom, active: document.activeElement === el };
      });
      assert.ok(geometry.active && geometry.left >= -1 && geometry.right <= 1 && geometry.top >= -1 && geometry.bottom <= 1, `focused tool is clipped: ${JSON.stringify(geometry)}`);
    } finally {
      await page.evaluate((value) => { if (value) document.documentElement.style.setProperty("--fs-ts", value); else document.documentElement.style.removeProperty("--fs-ts"); }, prior);
    }
  });

  await test("the Kit menu still lists full tool names and activates the real tool", { "IE-01": "partial" }, async () => {
    await studio.getByTestId("banner-menu-kit").click();
    const menu = studio.getByRole("menu", { name: "Kit" });
    for (const name of ["Move", "Rect select", "Ellipse select", "Magic wand", "Brush", "Eraser", "Bucket", "Gradient", "Eyedropper"]) {
      assert.equal(await menu.getByRole("menuitemcheckbox", { name, exact: true }).count(), 1, `Kit menu lost ${name}`);
    }
    await menu.getByRole("menuitemcheckbox", { name: "Magic wand", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="image-studio"]')?.getAttribute("data-tool") === "wand");
    assert.equal(await studio.getByRole("toolbar", { name: "Drawing kit" }).getByRole("button", { name: "Magic wand", exact: true }).getAttribute("aria-pressed"), "true");
    if (process.env.TT131_CAPTURE === "1") {
      await studio.getByLabel("Zoom", { exact: true }).selectOption("fit");
      await page.waitForFunction(() => { const canvas = document.querySelector('[data-testid="studio-canvas"]'); const el = canvas?.parentElement?.parentElement; return !!canvas && !!el && canvas.getBoundingClientRect().width <= el.clientWidth; });
      await page.screenshot({ path: "docs/screens/tt131-image-editor-fit.png" });
      await studio.getByLabel("Zoom", { exact: true }).selectOption("8");
      await page.waitForFunction(() => { const el = document.querySelector('[data-testid="image-studio"] > .fs-scroll'); return !!el && el.scrollWidth > el.clientWidth + 100; });
    }
  });

  await test("axe-core finds no scrollable-region-focusable issue on the enlarged canvas", { "AX-08": "partial" }, async () => {
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await page.evaluate(async () => {
      const a = (window as unknown as { axe: { run: (root: Element, options: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
      return (await a.run(document.querySelector('[data-testid="image-studio"]')!, { runOnly: { type: "rule", values: ["scrollable-region-focusable"] } })).violations;
    });
    assert.deepEqual(violations, []);
  });

  await test("attack: removing the viewport tab stop is detected by axe", { "AX-08": "partial" }, async () => {
    // A temporary DOM mutation tests the detector; no production source is changed.
    await viewport.evaluate((el) => el.removeAttribute("tabindex"));
    try {
      const violations = await page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (root: Element, options: unknown) => Promise<{ violations: { id: string }[] }> } }).axe;
        return (await a.run(document.querySelector('[data-testid="image-studio"]')!, { runOnly: { type: "rule", values: ["scrollable-region-focusable"] } })).violations.map((v) => v.id);
      });
      assert.ok(violations.includes("scrollable-region-focusable"), `mutation escaped detection: ${JSON.stringify(violations)}`);
    } finally { await viewport.evaluate((el) => el.setAttribute("tabindex", "0")); }
  });
} finally {
  await context.close(); await browser.close();
  if (initial.row?.state) {
    const last = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    await api("PUT", "/api/state", { id: "default", revision: Number(last.row?.revision ?? 1) + 1000, state: initial.row.state });
  }
}
finish();
