/**
 * TT86 real-input acceptance suite for SH-06. Runs against a built local Fusion Shell in real Chromium and uses trusted
 * DevTools mouse events: four corner entries, four edge flicks, four right-button gestures, the unchanged context menu,
 * the off switch, and a normal top-bar click. All mutated settings/desktop state are restored in finally.
 */
import { type Browser, type CDPSession, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt86-pointer");
const ok = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
};
const getSettings = async () => (await api("GET", "/api/settings")).rows as { key: string; value: string }[];
const getSetting = async (key: string) => (await getSettings()).find((row) => row.key === key)?.value;
const putSetting = async (key: string, value: string) => { await api("PUT", "/api/settings", { key, value }); };
const panels: Record<string, string> = {
  launcher: '[role="dialog"][aria-label="Launcher"]',
  overview: '[role="dialog"][aria-label="Overview"]',
  quickPanel: '[role="dialog"][aria-label="Quick panel"]',
  palette: '[role="dialog"][aria-label="Command palette"]',
};
const openPanel = async (page: Page, action: string) => {
  await page.locator(panels[action]).waitFor({ state: "visible", timeout: 5000 });
};
const closePanels = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(180);
  for (const selector of Object.values(panels)) await page.locator(selector).waitFor({ state: "detached", timeout: 3000 }).catch(() => undefined);
};
const move = (cdp: CDPSession, x: number, y: number, buttons = 0, button: "none" | "right" = "none") =>
  cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button, buttons });
const rightDrag = async (cdp: CDPSession, x: number, y: number, dx: number, dy: number) => {
  await move(cdp, x, y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
  await move(cdp, x + dx, y + dy, 2, "right");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "right", buttons: 0, clickCount: 1 });
};
const edgeFlick = async (cdp: CDPSession, edge: "left" | "right" | "top" | "bottom") => {
  if (edge === "left") { await move(cdp, 400, 300); await move(cdp, 3, 300); await move(cdp, 21, 300); }
  else if (edge === "right") { await move(cdp, 400, 300); await move(cdp, 1438, 300); await move(cdp, 1420, 300); }
  else if (edge === "top") { await move(cdp, 700, 300); await move(cdp, 700, 3); await move(cdp, 700, 21); }
  else { await move(cdp, 700, 300); await move(cdp, 700, 897); await move(cdp, 700, 879); }
};
const clickRight = async (cdp: CDPSession, x: number, y: number) => {
  await move(cdp, x, y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
};

const beforeSettings = await getSettings();
const oldSettings = Object.fromEntries(["shell.hotCorners", "appearance.layout", "appearance.desktopView"].map((key) => [key, beforeSettings.find((row) => row.key === key)?.value]));
const initialDesktop = await api("GET", "/api/state?id=default");
const oldDesktop = initialDesktop.row?.state;
const browser: Browser = await launchChromium();
let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
let page: Page | null = null;
let cdp: CDPSession | null = null;
const pageErrors: string[] = [];

try {
  await putSetting("shell.hotCorners", "on");
  await putSetting("appearance.layout", "fusion");
  await putSetting("appearance.desktopView", "classic");
  const current = await api("GET", "/api/state?id=default");
  const currentRevision = Number(current.row?.revision ?? 1);
  await api("PUT", "/api/state", { id: "default", revision: currentRevision + 1000,
    state: { ...(current.row?.state ?? {}), windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });

  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-pointer-gesture-surface="classic"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);

  await test("SH-06 all four hot corners open their mapped shell panels once per entry", { "SH-06": "full" }, async () => {
    // A reload while the trusted pointer is already inside a corner is not a new entry.
    await move(cdp!, 700, 450); await move(cdp!, 2, 20); await openPanel(page!, "launcher"); await closePanels(page!);
    await page!.reload({ waitUntil: "domcontentloaded" });
    await page!.locator('[data-pointer-gesture-surface="classic"]').waitFor({ timeout: 30_000 });
    await page!.waitForTimeout(450);
    await move(cdp!, 3, 20); await move(cdp!, 2, 21); await page!.waitForTimeout(180);
    ok(await page!.locator(panels.launcher).count() === 0, "a pointer already resting in the corner opened the launcher after reload");
    await move(cdp!, 700, 450); await page!.waitForTimeout(80);
    const cases: [number, number, string][] = [[2, 20, "launcher"], [1438, 20, "overview"], [3, 878, "quickPanel"], [1438, 878, "palette"]];
    for (const [x, y, action] of cases) {
      await move(cdp!, 700, 450); await page!.waitForTimeout(80);
      await move(cdp!, x, y); await openPanel(page!, action);
      await closePanels(page!);
      // Resting/jittering in the same corner is not another entry.
      if (action === "launcher") {
        for (let i = 0; i < 5; i++) await move(cdp!, 2 + (i % 2), 20 + (i % 2));
        await page!.waitForTimeout(180);
        ok(await page!.locator(panels.launcher).count() === 0, "jitter inside a dismissed corner reopened the launcher");
        await move(cdp!, 700, 450); await page!.waitForTimeout(80);
        await move(cdp!, 2, 20); await openPanel(page!, "launcher"); await closePanels(page!);
      }
    }
    await move(cdp!, 6, 20); await page!.waitForTimeout(100);
    ok(await page!.locator(panels.launcher).count() === 0, "x=6 boundary fired the top-left corner");
  });

  await test("SH-06 all four viewport edges require an inward flick and open the matching panel", { "SH-06": "full" }, async () => {
    const cases: ["left" | "right" | "top" | "bottom", string][] = [["left", "launcher"], ["right", "overview"], ["top", "quickPanel"], ["bottom", "palette"]];
    for (const [edge, action] of cases) {
      await move(cdp!, 700, 450); await page!.waitForTimeout(80);
      await edgeFlick(cdp!, edge); await openPanel(page!, action);
      await closePanels(page!);
    }
    // Touching the four-pixel left rail is only an arm; without an inward flick it must not open anything.
    await move(cdp!, 400, 300); await move(cdp!, 3, 300); await page!.waitForTimeout(150);
    ok(await page!.locator("[role=dialog]").count() === 0, "entering the edge rail alone opened a panel");
    await move(cdp!, 400, 300);
  });

  await test("SH-06 right-button gestures map all four directions on both desktop surfaces; context-menu and short-drag behavior is preserved", { "SH-06": "full" }, async () => {
    const cases: [number, number, string][] = [[-90, 0, "launcher"], [90, 0, "overview"], [0, -90, "quickPanel"], [0, 90, "palette"]];
    for (const [dx, dy, action] of cases) {
      await closePanels(page!); await move(cdp!, 700, 450); await page!.waitForTimeout(80);
      await rightDrag(cdp!, 700, 450, dx, dy);
      await openPanel(page!, action);
      await page!.waitForTimeout(120);
      ok(await page!.locator('[role="menu"]').count() === 0, "recognized right-drag also opened the desktop context menu");
    }
    await closePanels(page!);
    await clickRight(cdp!, 700, 450);
    await page!.locator('[role="menu"]').waitFor({ state: "visible", timeout: 4000 });
    ok(await page!.locator(panels.launcher).count() === 0, "ordinary right-click was mistaken for a launcher gesture");
    await page!.mouse.click(700, 450); await page!.waitForTimeout(120);

    // A short right drag is not a gesture; the established desktop context menu remains available.
    await rightDrag(cdp!, 700, 450, -20, 0);
    await page!.locator('[role="menu"]').waitFor({ state: "visible", timeout: 4000 });
    ok(await page!.locator("[role=dialog]").count() === 0, "sub-threshold right drag opened a shell panel");
    await page!.mouse.click(700, 450); await page!.waitForTimeout(120);

    // The existing menu item is a real interactive target; right-dragging it must not open a shell panel.
    await clickRight(cdp!, 700, 450);
    const item = page!.getByRole("menuitem", { name: "Open Files" });
    await item.waitFor({ timeout: 3000 });
    const box = await item.boundingBox();
    ok(!!box, "desktop menu item has a box");
    await rightDrag(cdp!, box!.x + box!.width / 2, box!.y + box!.height / 2, -90, 0);
    await page!.waitForTimeout(220);
    ok(await page!.locator("[role=dialog]").count() === 0, "right-drag on an interactive menu item triggered a gesture");

    // The same recognizer is mounted at Shell level in Tabletop; only its blank face is a gesture target.
    await putSetting("appearance.desktopView", "tabletop");
    try {
      await page!.reload({ waitUntil: "domcontentloaded" });
      await page!.locator('[data-pointer-gesture-surface="tabletop"]').waitFor({ timeout: 30_000 });
      await page!.waitForFunction(() => document.querySelector('[data-testid="tabletop"]')?.getAttribute("data-settled") === "true", undefined, { timeout: 15_000 });
      const floor = await page!.locator('[data-testid="tt-floor"]').boundingBox();
      ok(!!floor, "Tabletop floor is visible");
      const center = { x: floor!.x + floor!.width / 2, y: floor!.y + floor!.height / 2 };
      for (const [dx, dy, action] of cases) {
        await move(cdp!, center.x, center.y);
        await rightDrag(cdp!, center.x, center.y, dx, dy);
        await openPanel(page!, action); await closePanels(page!);
      }
    } finally {
      await putSetting("appearance.desktopView", "classic");
      await page!.reload({ waitUntil: "domcontentloaded" });
      await page!.locator('[data-pointer-gesture-surface="classic"]').waitFor({ timeout: 30_000 });
    }
  });

  await test("SH-06 trigger preference gates corner, edge and drag actions without stealing ordinary shell control clicks", { "SH-06": "full" }, async () => {
    await putSetting("shell.hotCorners", "off");
    await page!.reload({ waitUntil: "domcontentloaded" });
    await page!.locator('[data-pointer-gesture-surface="classic"]').waitFor({ timeout: 30_000 });
    await page!.waitForTimeout(700);
    await move(cdp!, 700, 450); await move(cdp!, 2, 20); await page!.waitForTimeout(180);
    ok(await page!.locator("[role=dialog]").count() === 0, "corner fired with the preference off");
    await move(cdp!, 400, 300); await move(cdp!, 3, 300); await move(cdp!, 21, 300); await page!.waitForTimeout(180);
    ok(await page!.locator("[role=dialog]").count() === 0, "edge fired with the preference off");
    await rightDrag(cdp!, 700, 450, -90, 0); await page!.waitForTimeout(150);
    ok(await page!.locator("[role=dialog]").count() === 0, "mouse gesture fired with the preference off");
    await clickRight(cdp!, 700, 450);
    await page!.locator('[role="menu"]').waitFor({ state: "visible", timeout: 4000 });
    await page!.mouse.click(700, 450); await page!.waitForTimeout(100);
    // No hit layer or preventDefault path: an actual TopBar control still receives its normal click.
    await page!.getByRole("button", { name: "Quick panel" }).click();
    await openPanel(page!, "quickPanel");
    await closePanels(page!);

    // The same persisted off setting gates the Tabletop gesture surface too.
    await putSetting("appearance.desktopView", "tabletop");
    try {
      await page!.reload({ waitUntil: "domcontentloaded" });
      await page!.locator('[data-pointer-gesture-surface="tabletop"]').waitFor({ timeout: 30_000 });
      await page!.waitForFunction(() => document.querySelector('[data-testid="tabletop"]')?.getAttribute("data-settled") === "true", undefined, { timeout: 15_000 });
      const floor = await page!.locator('[data-testid="tt-floor"]').boundingBox();
      ok(!!floor, "Tabletop floor is visible with triggers disabled");
      const x = floor!.x + floor!.width / 2, y = floor!.y + floor!.height / 2;
      await rightDrag(cdp!, x, y, -90, 0); await page!.waitForTimeout(150);
      await move(cdp!, 2, 20); await page!.waitForTimeout(150);
      ok(await page!.locator("[role=dialog]").count() === 0, "Tabletop gesture/corner fired with the preference off");
    } finally {
      await putSetting("appearance.desktopView", "classic");
      await page!.reload({ waitUntil: "domcontentloaded" });
      await page!.locator('[data-pointer-gesture-surface="classic"]').waitFor({ timeout: 30_000 });
    }
  });

  await test("SH-06 pointer listeners report no uncaught page errors", { "SH-06": "partial" }, () => {
    ok(pageErrors.length === 0, `uncaught browser errors: ${pageErrors.slice(0, 5).join(" | ")}`);
  });
} finally {
  await context?.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  // Restore the exact server-side desktop/settings state even if a browser assertion failed.
  if (oldDesktop) {
    try {
      const current = await api("GET", "/api/state?id=default");
      const revision = Number(current.row?.revision ?? 1);
      await api("PUT", "/api/state", { id: "default", revision: revision + 1000, state: oldDesktop });
    } catch { /* the assertion record above is the useful failure; cleanup is best effort */ }
  }
  for (const [key, value] of Object.entries(oldSettings)) {
    if (typeof value === "string") await putSetting(key, value).catch(() => undefined);
  }
}

await finish();
