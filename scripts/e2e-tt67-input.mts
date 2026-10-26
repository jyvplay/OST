/**
 * TT67 e2e — IN-02 "Learn my mouse" and IN-03 layout-aware shortcuts in Chromium 143 headless, with REAL trusted input
 * through the DevTools protocol (Input.dispatchKeyEvent / Input.dispatchMouseEvent go through the browser's input
 * pipeline; buttons "back" / "forward" / "right").
 *  - IN-03: an AZERTY keyboard is simulated at the EVENT level (code KeyQ produces key "a", KeyA → "q", KeyZ → "w") —
 *    the sandbox has no non-US keyboard, so this exercises the app's handling of what such a keyboard reports, not an
 *    OS layout switch (stated honestly). Meta + the physical Q key opens Overview and NOT the launcher, Meta + physical
 *    A opens the launcher and NOT Overview; labels follow typed keys; a password field teaches nothing.
 *  - IN-02: Learn Back with the device's "forward" button swaps the pair, persists across reload, Files goes Back on
 *    that button, the right button is refused (and its context menu swallowed), Escape cancels, the learn overlay
 *    blocks global shortcuts, the trailing mouseup / auxclick of the learning press never reach the page, Reset.
 * Run: BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt67-input.mts
 */
import { type Browser, type CDPSession, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt67-input");
const IN2 = { "IN-02": "full" } as const, IN3 = { "IN-03": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> }; };
// TT69: these tests need the CLASSIC desktop (icons, hot corner); a suite interrupted in Tabletop view left
// appearance.desktopView = "tabletop" and both suites failed with no app change. Force classic, restore afterwards.
const prevView = (await api("GET", "/api/settings")).json?.rows?.find((r: { key: string }) => r.key === "appearance.desktopView")?.value as string | undefined;
if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
// TT76: the same for the layout — a gate suite earlier in the run left appearance.layout = "business", whose taskbar
// Start menu has no hot corner and maps Meta differently, and IN-03 / SH-06 failed with no app change.
const prevLayout = (await api("GET", "/api/settings")).json?.rows?.find((r: { key: string }) => r.key === "appearance.layout")?.value as string | undefined;
if (prevLayout && prevLayout !== "fusion") await api("PUT", "/api/settings", { key: "appearance.layout", value: "fusion" });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
const win = (id: string, module: string, title: string, x: number, props: Record<string, unknown> = {}, w = 620) => ({ id, module, title, x, y: 60, w, h: 760, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
const setMouse = async (b: string, f: string) => { await api("PUT", "/api/settings", { key: "input.mouseBack", value: b }); await api("PUT", "/api/settings", { key: "input.mouseForward", value: f }); };
const getSetting = async (k: string) => ((await api("GET", "/api/settings")).json.rows as { key: string; value: string }[]).find((r) => r.key === k)?.value;

const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const;
const VK: Record<string, number> = { KeyQ: 81, KeyA: 65, KeyZ: 90, KeyW: 87, Escape: 27 };
async function key(cdp: CDPSession, code: string, k: string, mods: (keyof typeof MOD)[] = []) {
  const modifiers = mods.reduce((a, m) => a | MOD[m], 0);
  const metaDown = mods.includes("Meta");
  if (metaDown) await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: MOD.Meta });
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: VK[code] ?? 0, modifiers });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: VK[code] ?? 0, modifiers });
  if (metaDown) await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 0 });
}
async function press(cdp: CDPSession, x: number, y: number, button: "back" | "forward" | "right" | "left") {
  const buttons = { left: 1, right: 2, back: 8, forward: 16 }[button];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
}
const settle = (p: Page, ms = 700) => p.waitForTimeout(ms);

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openSettings(extra: unknown[] = []) {
  await desktop([win("s1", "settings", "Settings", 40, {}, 760), ...extra]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const s = page.locator('.fs-window[aria-label="Settings"]');
  await s.getByRole("tab", { name: "Shortcuts" }).or(s.getByRole("button", { name: "Shortcuts" })).first().click({ timeout: 30_000 });
  await s.getByTestId("mouse-back").waitFor({ timeout: 15_000 });
  return { ctx, page, cdp, s };
}
const dialogs = async (page: Page) => ({ overview: await page.locator('[role="dialog"][aria-label="Overview"]').count(), launcher: await page.locator('[role="dialog"][aria-label="Launcher"]').count() });
const label = (page: Page, chord: string) => page.locator(`.fs-window[aria-label="Settings"] [data-chord="${chord}"]`).first().innerText();
async function blur(page: Page) { await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); }); }

await test("IN-03 AZERTY at the event level: Meta + the physical Q key (types \"a\") opens Overview and NOT the launcher; Meta + physical A (types \"q\") opens the launcher and NOT Overview; Escape closes", IN3, async () => {
  await setMouse("3", "4");
  const { ctx, page, cdp } = await openSettings();
  await blur(page);
  await key(cdp, "KeyQ", "a", ["Meta"]); await settle(page);
  let d = await dialogs(page);
  ok(d.overview === 1 && d.launcher === 0, `Meta+KeyQ("a"): ${JSON.stringify(d)} (TT66 matched it as Meta+A too)`);
  await key(cdp, "Escape", "Escape"); await settle(page);
  d = await dialogs(page); ok(d.overview === 0, "Escape closed Overview");
  await key(cdp, "KeyA", "q", ["Meta"]); await settle(page);
  d = await dialogs(page);
  ok(d.launcher === 1 && d.overview === 0, `Meta+KeyA("q"): ${JSON.stringify(d)}`);
  await key(cdp, "Escape", "Escape"); await settle(page);
  await ctx.close();
});

await test("IN-03 labels: typing in a password field teaches NOTHING (Snap layouts keeps its label); the same AZERTY keys typed elsewhere relabel Meta+Z → Meta+W and Meta+Q → Meta+A", IN3, async () => {
  const { ctx, page, cdp } = await openSettings();
  const z0 = await label(page, "Meta+Z"), q0 = await label(page, "Meta+Q");
  // a real password field in the page; trusted key events go to it
  await page.evaluate(() => { const i = document.createElement("input"); i.type = "password"; i.id = "tt67-pw"; i.style.cssText = "position:fixed;left:4px;bottom:4px;z-index:99999"; document.body.appendChild(i); });
  await page.locator("#tt67-pw").focus();
  await key(cdp, "KeyZ", "w"); await key(cdp, "KeyQ", "a"); await settle(page, 400);
  ok(await label(page, "Meta+Z") === z0 && await label(page, "Meta+Q") === q0, `password typing changed labels: ${await label(page, "Meta+Z")} / ${await label(page, "Meta+Q")} (were ${z0} / ${q0})`);
  await page.evaluate(() => document.getElementById("tt67-pw")?.remove());
  await blur(page);
  await key(cdp, "KeyZ", "w"); await key(cdp, "KeyQ", "a"); await key(cdp, "KeyA", "q"); await settle(page, 400);
  const z1 = await label(page, "Meta+Z"), q1 = await label(page, "Meta+Q"), a1 = await label(page, "Meta+A");
  ok(z1 === "Meta+W" && q1 === "Meta+A" && a1 === "Meta+Q", `labels after AZERTY typing: Meta+Z→${z1}, Meta+Q→${q1}, Meta+A→${a1}`);
  const src = await page.locator('.fs-window[aria-label="Settings"] [data-testid="layout-source"]').innerText();
  ok(/your typing/.test(src), `layout source shows learned typing: ${src}`);
  await ctx.close();
});

await test("IN-02 learn: Learn Back + the device's FORWARD button → Back = 4, Forward = 3 (swapped), stored, survives reload; Files then goes Back on that button and the tab never navigates; the trailing mouseup / auxclick never reach the page", IN2, async () => {
  await setMouse("3", "4");
  const { ctx, page, cdp, s } = await openSettings([win("f1", "files", "Files", 820, { path: "/" }, 600)]);
  await page.evaluate(() => { const w = window as unknown as { __seen: string[] }; w.__seen = []; for (const t of ["mouseup", "auxclick", "click", "contextmenu"]) document.addEventListener(t, (e) => w.__seen.push(`${t}:${(e as MouseEvent).button}`)); });
  await s.getByRole("button", { name: "Learn Back" }).click();
  const dlg = page.getByTestId("mouse-learn-dialog"); await dlg.waitFor({ timeout: 5000 });
  await page.evaluate(() => { (window as unknown as { __seen: string[] }).__seen = []; });
  await press(cdp, 700, 450, "forward"); await settle(page, 900);
  ok(await dlg.count() === 0, "the learn dialog closed after an accepted press");
  const msg = await s.getByTestId("mouse-learn-msg").innerText();
  ok(/Back is now button 4/.test(msg) && /swapped/.test(msg), `message: ${msg}`);
  ok(/button 4/.test(await s.getByTestId("mouse-back").innerText()) && /button 3/.test(await s.getByTestId("mouse-forward").innerText()), "pair shown 4 / 3");
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  ok(seen.length === 0, `trailing events of the learning press reached the page: ${seen.join(", ")}`);
  ok(await getSetting("input.mouseBack") === "4" && await getSetting("input.mouseForward") === "3", "stored server-side");
  await page.reload({ waitUntil: "domcontentloaded" });
  const s2 = page.locator('.fs-window[aria-label="Settings"]');
  await s2.getByRole("tab", { name: "Shortcuts" }).or(s2.getByRole("button", { name: "Shortcuts" })).first().click({ timeout: 30_000 });
  ok(/button 4/.test(await s2.getByTestId("mouse-back").innerText()), "persisted across reload");
  // Files: /Documents, then the device's forward button (now Back) goes back; the browser tab stays
  const files = page.locator('.fs-window[aria-label="Files"]');
  const docs = files.locator('.fs-list-item[data-path="/Documents"]'); await docs.waitFor({ timeout: 30_000 });
  const app = page.url();
  await docs.dblclick();
  const crumbs = files.getByTestId("files-crumbs"); await crumbs.filter({ hasText: "Documents" }).waitFor({ timeout: 10_000 });
  const lb = await files.getByTestId("files-listing").boundingBox();
  const cx = lb!.x + lb!.width / 2, cy = lb!.y + lb!.height - 30;
  await press(cdp, cx, cy, "forward"); await settle(page, 1200);
  ok(!(await crumbs.innerText()).includes("Documents") && page.url() === app, `Files Back on button 4: crumbs "${await crumbs.innerText()}", url ${page.url()}`);
  await press(cdp, cx, cy, "back"); await settle(page, 1200);
  ok((await crumbs.innerText()).includes("Documents") && page.url() === app, `Files Forward on button 3: crumbs "${await crumbs.innerText()}"`);
  // test pad reports the learned meaning
  await s2.getByTestId("mouse-probe").scrollIntoViewIfNeeded();
  const pad = await s2.getByTestId("mouse-probe").boundingBox();
  await press(cdp, pad!.x + 20, pad!.y + pad!.height / 2, "forward"); await settle(page, 300);
  ok(/button 4 → Back/.test(await s2.getByTestId("mouse-probe-out").innerText()), `test pad: ${await s2.getByTestId("mouse-probe-out").innerText()}`);
  await s2.getByRole("button", { name: "Reset" }).click(); await settle(page, 600);
  ok(await getSetting("input.mouseBack") === "3" && await getSetting("input.mouseForward") === "4", "Reset restored 3 / 4");
  await ctx.close();
});

await test("IN-02 refusals and modality: the overlay covers the screen; the right button is refused with a reason, the dialog stays and its context menu never reaches the page; Meta+Q behind the overlay opens nothing; Escape cancels without changing the pair", IN2, async () => {
  await setMouse("3", "4");
  const { ctx, page, cdp, s } = await openSettings();
  await page.evaluate(() => { const w = window as unknown as { __cm: number }; w.__cm = 0; document.addEventListener("contextmenu", () => { w.__cm++; }); });
  await s.getByRole("button", { name: "Learn Forward" }).click();
  const dlg = page.getByTestId("mouse-learn-dialog"); await dlg.waitFor({ timeout: 5000 });
  const box = await dlg.boundingBox();
  ok(box && box.x <= 0 && box.y <= 0 && box.width >= 1440 && box.height >= 900, `the overlay covers the whole viewport, not just the Settings window: ${JSON.stringify(box)}`);
  await press(cdp, 700, 450, "right"); await settle(page);
  ok(await dlg.count() === 1, "still learning after a refused press");
  ok(/secondary/.test(await dlg.innerText()), `reason shown: ${await dlg.innerText()}`);
  ok(await page.evaluate(() => (window as unknown as { __cm: number }).__cm) === 0, "the right press's contextmenu reached the page");
  await key(cdp, "KeyQ", "q", ["Meta"]); await settle(page);
  const d = await dialogs(page); ok(d.overview === 0 && d.launcher === 0, `a global shortcut acted behind the learn overlay: ${JSON.stringify(d)}`);
  await key(cdp, "Escape", "Escape"); await settle(page);
  ok(await dlg.count() === 0, "Escape closed the overlay");
  ok(/Cancelled/.test(await s.getByTestId("mouse-learn-msg").innerText()), "cancel message");
  ok(await getSetting("input.mouseBack") === "3" && await getSetting("input.mouseForward") === "4", "pair unchanged");
  // Cancel button path: a left click on Cancel is not learned as button 0
  await s.getByRole("button", { name: "Learn Back" }).click(); await dlg.waitFor({ timeout: 5000 });
  const cb = await dlg.locator("[data-learn-cancel]").boundingBox();
  await press(cdp, cb!.x + cb!.width / 2, cb!.y + cb!.height / 2, "left"); await settle(page);
  ok(await dlg.count() === 0 && await getSetting("input.mouseBack") === "3", "Cancel button closes without learning");
  await ctx.close();
});

await test("SH-06 hot corner with real pointer moves: entering the top-left corner opens the launcher; after Escape, a pointer resting / jittering in the corner for 3 s does NOT reopen it; leaving and re-entering does; with Hot corners off nothing opens", { "SH-06": "full" }, async () => {
  await api("PUT", "/api/settings", { key: "shell.hotCorners", value: "on" });
  await desktop([]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator("html[data-focus-mode]").waitFor({ state: "attached", timeout: 30_000 });
  await settle(page, 1500);
  const move = (x: number, y: number) => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  const launcher = () => page.locator('[role="dialog"][aria-label="Launcher"]').count();
  await move(400, 400); await settle(page, 200);
  ok(await launcher() === 0, "launcher closed at start");
  await move(2, 20); await settle(page, 500);
  ok(await launcher() === 1, "entering the corner opened the launcher");
  await key(cdp, "Escape", "Escape"); await settle(page, 300);
  ok(await launcher() === 0, "Escape closed it");
  for (let i = 0; i < 30; i++) { await move(2 + (i % 3), 20 + (i % 2)); await page.waitForTimeout(100); }
  ok(await launcher() === 0, "resting / jittering in the corner for 3 s reopened the launcher (TT66 re-fired every 1.2 s)");
  await move(400, 400); await settle(page, 200); await move(1, 10); await settle(page, 500);
  ok(await launcher() === 1, "leaving and re-entering re-armed the corner");
  await key(cdp, "Escape", "Escape"); await settle(page, 300);
  await api("PUT", "/api/settings", { key: "shell.hotCorners", value: "off" });
  await page.reload({ waitUntil: "domcontentloaded" }); await settle(page, 2500);
  await move(400, 400); await settle(page, 200); await move(2, 20); await settle(page, 600);
  ok(await launcher() === 0, "Hot corners off: nothing opens");
  await api("PUT", "/api/settings", { key: "shell.hotCorners", value: "on" });
  await ctx.close();
});

await browser.close();
if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
if (prevLayout && prevLayout !== "fusion") await api("PUT", "/api/settings", { key: "appearance.layout", value: prevLayout });
await finish();
