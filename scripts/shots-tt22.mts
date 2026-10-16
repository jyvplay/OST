/**
 * TT22 visual inspection: the four styles (poolside default, vice, ocean drive, bubbly) on the same desktop, the
 * Settings style picker, the quick panel, the light theme, Large text mode and a phone viewport.
 * Leaves the settings at their defaults (poolside / dark / 125 % / auto wallpaper) when done.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt22.mts
 */
import { launchChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const ONLY = process.env.ONLY ?? "";
const api = (method: string, path: string, body?: unknown) => fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const set = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const win = (id: string, module: string, x: number, y: number, w: number, h: number, z: number) => ({ id, module, title: module[0].toUpperCase() + module.slice(1), x, y, w, h, z, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
async function desktop(windows: unknown[], vw = 1440, vh = 900) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: vw, h: vh }, icons: [], focusMode: false, revision: rev } });
}
const browser = await launchChromium();
const shot = async (name: string, vw: number, vh: number, prep: (p: import("playwright").Page) => Promise<void> = async () => {}) => {
  if (ONLY && !name.includes(ONLY)) return;
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator('[role="banner"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await prep(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: name.startsWith("tt23-") ? `docs/screenshots/${name}.png` : `docs/screenshots/tt22-${name}.png` });
  await ctx.close();
};

try {
  await set("appearance.textScale", "125"); await set("appearance.theme", "dark"); await set("appearance.wallpaper", "auto");
  const two = [win("w1", "files", 120, 40, 720, 500, 11), win("w2", "sheet", 560, 200, 800, 520, 12)];
  for (const s of ["poolside", "vice", "oceandrive", "bubbly"]) {
    await set("appearance.style", s);
    await desktop(two);
    await shot(`desktop-${s}`, 1440, 900);
  }
  // TT23: the five reach-backed styles — dark desktop, light desktop, and the launcher grid (icons up close)
  for (const s of ["liquidglass", "expressive", "fluent", "clouddancer", "teal"]) {
    if (ONLY && !`tt23-style-${s}`.includes(ONLY)) continue;
    await set("appearance.style", s);
    await desktop(two);
    await shot(`tt23-style-${s}-dark`, 1440, 900);
    await set("appearance.theme", "light");
    await shot(`tt23-style-${s}-light`, 1440, 900);
    await set("appearance.theme", "dark");
    await desktop([]);
    await shot(`tt23-style-${s}-launcher`, 1440, 900, async (p) => { await p.getByTestId("launcher-button").click(); });
  }
  await set("appearance.style", "poolside");
  await desktop([win("w4", "settings", 100, 20, 980, 820, 11)]);
  await shot("tt23-style-picker", 1440, 900);
  // TT23 Whiteboard: default text and Large text mode (layout must hold at 200 %)
  await desktop([win("w7", "whiteboard", 20, 10, 1380, 800, 11)]);
  await shot("tt23-whiteboard", 1440, 900, async (p) => { await p.getByRole("button", { name: /^Ellipse: Next step/ }).click(); });
  await set("appearance.textScale", "200");
  await shot("tt23-whiteboard-large", 1440, 900);
  await set("appearance.textScale", "125");
  await desktop([]);
  await shot("launcher", 1440, 900, async (p) => { await p.getByTestId("launcher-button").click(); });
  await shot("quick", 1440, 900, async (p) => { await p.getByRole("button", { name: /quick/i }).first().click().catch(async () => { await p.locator('[title*="Quick"]').first().click(); }); });
  await desktop([win("w4", "settings", 100, 20, 980, 720, 11)]);
  await shot("settings", 1440, 900);
  await set("appearance.theme", "light");
  await desktop(two);
  await shot("light-poolside", 1440, 900);
  await set("appearance.theme", "dark");
  await set("appearance.textScale", "200");
  await desktop([win("w5", "writer", 60, 30, 1100, 700, 11)]);
  await shot("large-text", 1440, 900);
  await set("appearance.textScale", "125");
  await desktop([win("w6", "notes", 8, 8, 370, 640, 11)], 390, 844);
  await shot("phone", 390, 844);
} finally {
  await set("appearance.style", "poolside"); await set("appearance.theme", "dark"); await set("appearance.textScale", "125"); await set("appearance.wallpaper", "auto");
  await desktop([]);
  await browser.close();
}
console.log("shots done");
