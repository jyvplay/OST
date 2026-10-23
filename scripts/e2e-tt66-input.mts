/**
 * TT66 e2e — IN-01 desktopMouse contract in Chromium 143 headless, with REAL input through the DevTools protocol
 * (Input.dispatchMouseEvent: trusted events through the browser's input pipeline, buttons "back" / "forward").
 *  - positive control: on a page without the shell, a CDP Back press really navigates the tab back (so the guard test
 *    below cannot pass vacuously);
 *  - the desktop: a Back / Forward press over the wallpaper never leaves the page, while Files (its own history)
 *    still goes back / forward on the same buttons (second-order check of the guard);
 *  - wheel: Whiteboard pans by the same distance for a real pixel-mode notch (CDP mouseWheel deltaY 100) and for
 *    line- and page-mode events. Chromium itself never emits deltaMode 1/2, so those two are constructed WheelEvents
 *    dispatched on the canvas (stated honestly: they exercise the app's handling, not a browser's line mode).
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt66-input.mts
 */
import { type Browser, type CDPSession, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt66-input");
const COV = { "IN-01": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
const win = (id: string, module: string, title: string, x: number, props: Record<string, unknown> = {}) => ({ id, module, title, x, y: 60, w: 620, h: 520, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
async function press(cdp: CDPSession, x: number, y: number, button: "back" | "forward") {
  const buttons = button === "back" ? 8 : 16;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
}
const settle = (p: Page) => p.waitForTimeout(1200);

const browser: Browser = await launchChromium();
const errors: string[] = [];

await test("positive control: a real CDP Back press on a page WITHOUT the shell navigates the tab back (the guard test is not vacuous)", COV, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } }); const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}/api/features?first=1`); await page.goto(`${BASE}/api/features?second=1`);
  await press(cdp, 300, 300, "back"); await settle(page);
  ok(page.url().includes("first=1"), `Back navigated: ${page.url()}`);
  await press(cdp, 300, 300, "forward"); await settle(page);
  ok(page.url().includes("second=1"), `Forward navigated: ${page.url()}`);
  await ctx.close();
});

await test("desktop: Back / Forward over the wallpaper never leave the page; Files still goes back / forward in its own history on the same buttons", COV, async () => {
  await desktop([win("f1", "files", "Files", 640, { path: "/" })]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/api/features?before=1`);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const files = page.locator('.fs-window[aria-label="Files"]');
  const docs = files.locator('.fs-list-item[data-path="/Documents"]');
  await docs.waitFor({ timeout: 30_000 });
  const app = page.url();
  // wallpaper (left of the Files window)
  for (const b of ["back", "forward", "back"] as const) { await press(cdp, 200, 700, b); await settle(page); ok(page.url() === app, `${b} over the wallpaper left the page: ${page.url()}`); }
  ok(await files.isVisible(), "the desktop is still mounted");
  // Files: open /Documents, then Back → "/", Forward → "/Documents", and the tab never moves
  await docs.dblclick();
  const crumbs = files.getByTestId("files-crumbs");
  await crumbs.filter({ hasText: "Documents" }).waitFor({ timeout: 10_000 });
  const listing = await files.getByTestId("files-listing").boundingBox();
  const cx = listing!.x + listing!.width / 2, cy = listing!.y + listing!.height - 30;
  await press(cdp, cx, cy, "back"); await settle(page);
  ok(!(await crumbs.innerText()).includes("Documents") && page.url() === app, `Files Back: crumbs "${await crumbs.innerText()}", url ${page.url()}`);
  await press(cdp, cx, cy, "forward"); await settle(page);
  ok((await crumbs.innerText()).includes("Documents") && page.url() === app, `Files Forward: crumbs "${await crumbs.innerText()}", url ${page.url()}`);
  await ctx.close();
});

await test("wheel: Whiteboard pans the same distance for a real pixel notch (CDP deltaY 100), a 3-line event and (page mode) one canvas height", COV, async () => {
  await desktop([win("w1", "whiteboard", "Whiteboard", 200)]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const wb = page.locator('.fs-window[aria-label="Whiteboard"]');
  const pat = wb.locator('pattern[id^="wbdots-"]'); await pat.waitFor({ state: "attached", timeout: 30_000 });
  const svg = pat.locator("xpath=ancestor::*[local-name()='svg'][1]");
  const y = async () => Number(await pat.getAttribute("y"));
  const box = (await svg.boundingBox())!; const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const y0 = await y();
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: 100 });
  await page.waitForFunction(([sel, v]) => Number(document.querySelector(sel as string)?.getAttribute("y")) !== v, [`[aria-label="Whiteboard"] pattern[id^="wbdots-"]`, y0] as const, { timeout: 5000 });
  const px = y0 - (await y());
  const fire = (deltaMode: number, deltaY: number) => svg.evaluate((e, [m, d]) => { e.dispatchEvent(new WheelEvent("wheel", { deltaMode: m, deltaY: d, bubbles: true, cancelable: true })); }, [deltaMode, deltaY] as const);
  const y1 = await y(); await fire(1, 3); await page.waitForTimeout(200); const lines = y1 - (await y());
  const y2 = await y(); await fire(2, 1); await page.waitForTimeout(200); const pageD = y2 - (await y());
  const h = await svg.evaluate((e) => (e as SVGSVGElement).clientHeight);
  ok(Math.abs(px - 100) < 1, `pixel notch pans 100 px (got ${px})`);
  ok(Math.abs(lines - px) <= 0.1 * px, `3 lines pan like one pixel notch ±10% (${lines} vs ${px})`);
  ok(Math.abs(pageD - h) < 1, `page mode pans one canvas height (${pageD} vs ${h})`);
  await ctx.close();
});

await test("no uncaught page errors", COV, async () => { ok(errors.length === 0, errors.join(" | ")); });
await browser.close();
await finish();
