/**
 * Visual-inspection screenshots for TT28 (not a pass/fail suite). Writes PNGs to scripts/tt28-shots/.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt28.mts
 */
import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const OUT = "scripts/tt28-shots"; mkdirSync(OUT, { recursive: true });
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
const KEYS = ["appearance.layout", "appearance.style", "appearance.theme", "appearance.dockAutoHide", "media.embeds"];
const saved: Record<string, string> = {};
for (const r of (await api("GET", "/api/settings")).rows as { key: string; value: string }[]) if (KEYS.includes(r.key)) saved[r.key] = r.value;
const set = (k: string, v: string) => api("PUT", "/api/settings", { key: k, value: v });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const win = (id: string, module: string, r: { x: number; y: number; w: number; h: number }, props: Record<string, unknown> = {}) => ({ id, module, title: module, ...r, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = await launchChromium();
async function boot(windows: unknown[]): Promise<Page> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(/(youtube|ytimg|vimeo|soundcloud|spotify|openstreetmap)\./i, (r) => r.fulfill({ status: 204, body: "" }));
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await sleep(1500);
  return page;
}
try {
  // Business / Daylight: snap flyout, assist, drag preview, ask dialog
  await set("appearance.layout", "business"); await set("appearance.style", "daylight"); await set("appearance.theme", "light");
  let page = await boot([win("a", "files", { x: 80, y: 60, w: 760, h: 480 }, { path: "/Documents" }), win("b", "notes", { x: 420, y: 160, w: 700, h: 460 }), win("c", "maps", { x: 600, y: 240, w: 760, h: 520 })]);
  await page.locator('[data-win-id="a"]').getByRole("button", { name: "New folder" }).click();
  await page.getByTestId("ask-dialog").waitFor(); await sleep(300);
  await page.screenshot({ path: `${OUT}/4-ask-business.png` });
  await page.keyboard.press("Escape"); await sleep(200);
  await page.locator('[data-win-id="b"] .fs-cap-maximize').hover();
  await page.getByTestId("snap-flyout").waitFor(); await sleep(300);
  await page.screenshot({ path: `${OUT}/1-snap-flyout.png` });
  await page.locator('[data-testid=snap-zone][data-layout=half-quarters][data-zone=left]').click();
  await page.getByTestId("snap-assist").waitFor(); await sleep(300);
  await page.screenshot({ path: `${OUT}/2-snap-assist.png` });
  await page.getByTestId("snap-assist-skip").click(); await sleep(200);
  const t = (await page.locator('[data-win-id="c"] .fs-titlebar').boundingBox())!;
  await page.mouse.move(t.x + 200, t.y + 15); await page.mouse.down();
  await page.mouse.move(1430, 890, { steps: 10 }); await sleep(350);
  await page.screenshot({ path: `${OUT}/3-snap-preview.png` });
  await page.mouse.up(); await page.keyboard.press("Escape"); await sleep(300);
  await page.context().close();

  // Fusion default (dark poolside): ask form with secret + error
  await set("appearance.layout", "fusion"); await set("appearance.style", saved["appearance.style"] ?? "poolside"); await set("appearance.theme", "dark");
  await api("POST", "/api/fs", { op: "write", path: "/Documents/tt28-shot.txt", content: "x" });
  page = await boot([win("f", "files", { x: 200, y: 80, w: 800, h: 560 }, { path: "/Documents" })]);
  await page.locator('[data-win-id="f"]').getByText("tt28-shot.txt", { exact: true }).click({ button: "right" });
  await page.locator("[role=menu]").getByText(/^Encrypt/).click();
  await page.getByTestId("ask-input-pass").fill("hunter2"); await page.getByTestId("ask-input-again").fill("hunter2"); await page.keyboard.press("Enter");
  await page.getByTestId("ask-error").waitFor(); await sleep(250);
  await page.screenshot({ path: `${OUT}/5-ask-secret-dark.png` });
  await page.keyboard.press("Escape");
  await api("POST", "/api/fs", { op: "trash", path: "/Documents/tt28-shot.txt" }); await api("POST", "/api/fs", { op: "purge", path: "/Documents/tt28-shot.txt" });
  await page.context().close();

  // Maps: city search results + found card (Daylight)
  await set("appearance.style", "daylight"); await set("appearance.theme", "light"); await set("appearance.layout", "business");
  page = await boot([win("m", "maps", { x: 40, y: 20, w: 1200, h: 760 })]);
  await page.getByTestId("mp-search").fill("Spring");
  await page.locator("[data-testid=mp-result][data-kind=city]").first().waitFor(); await sleep(400);
  await page.screenshot({ path: `${OUT}/6-maps-city-results.png` });
  await page.getByTestId("mp-search").fill("Raleigh");
  await page.locator("[data-testid=mp-result][data-kind=city]").first().waitFor();
  await page.locator("[data-testid=mp-result][data-kind=city]").first().click();
  await page.getByTestId("mp-found").waitFor(); await sleep(2500);
  await page.screenshot({ path: `${OUT}/7-maps-found.png` });
  await page.context().close();

  // Streams control row (Video) — player frames are stubbed, so the row shows its connecting state
  page = await boot([win("s", "video", { x: 60, y: 30, w: 1100, h: 760 }, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })]);
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/8-video.png` });
  await page.context().close();

  // Art / Silver: auto-hide revealed, then genie mid-frame
  await set("appearance.layout", "art"); await set("appearance.style", "silver"); await set("appearance.theme", "light"); await set("appearance.dockAutoHide", "on");
  page = await boot([win("w", "notes", { x: 260, y: 90, w: 760, h: 480 })]);
  await page.screenshot({ path: `${OUT}/9-art-dock-hidden.png` });
  await page.mouse.move(720, 899); await sleep(700);
  await page.screenshot({ path: `${OUT}/10-art-dock-revealed.png` });
  await page.context().close();
  await set("appearance.dockAutoHide", "off");
  page = await boot([win("w", "notes", { x: 260, y: 90, w: 760, h: 480 })]);
  await page.locator('[data-win-id="w"] .fs-tl-minimize').click();
  await page.getByTestId("genie-ghost").waitFor({ timeout: 2000 });
  await page.evaluate(() => { for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect | null)?.target instanceof HTMLElement && ((a.effect as KeyframeEffect).target as HTMLElement).dataset.testid === "genie-ghost") { a.pause(); a.currentTime = 160; } });
  await page.screenshot({ path: `${OUT}/11-genie-funnel.png` });
  await page.evaluate(() => { for (const a of document.getAnimations()) { a.currentTime = 340; } });
  await page.screenshot({ path: `${OUT}/12-genie-late.png` });
  await page.context().close();
} finally {
  for (const [k, v] of Object.entries(saved)) await set(k, v);
  await desktop([]);
  await browser.close();
}
console.log("shots written to", OUT);
