/**
 * TT21 visual inspection: whole-shell scenes before/after the graphics + text-size upgrade.
 * Scenes: desktop with two windows, launcher, command palette, a phone viewport, and the light theme.
 * Run: TAG=before|after BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt21.mts
 */
import { launchChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const TAG = process.env.TAG ?? "after";
const ONLY = process.env.ONLY ?? "";
const api = (method: string, path: string, body?: unknown) => fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const win = (id: string, module: string, x: number, y: number, w: number, h: number, z: number) => ({ id, module, title: module[0].toUpperCase() + module.slice(1), x, y, w, h, z, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
async function desktop(windows: unknown[], vw = 1440, vh = 900) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: vw, h: vh }, icons: [], focusMode: false, revision: rev } });
}
const browser = await launchChromium();
const shot = async (name: string, vw: number, vh: number, prep: (p: import("playwright").Page) => Promise<void>, init?: (p: import("playwright").Page) => Promise<void>) => {
  if (ONLY && !name.includes(ONLY)) return;
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const page = await ctx.newPage();
  if (init) await init(page);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator('[role="banner"]').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await prep(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/screenshots/tt21-${TAG}-${name}.png` });
  await ctx.close();
};

await desktop([win("w1", "files", 150, 40, 760, 520, 11), win("w2", "sheet", 520, 180, 820, 560, 12)]);
await shot("desktop", 1440, 900, async () => {});
await desktop([]);
await shot("launcher", 1440, 900, async (p) => { await p.getByTestId("launcher-button").click(); });
await shot("palette", 1440, 900, async (p) => { await p.getByTitle("Command palette (Ctrl+Space)").click(); await p.keyboard.type("sp"); });
await desktop([win("w3", "privacy", 10, 10, 360, 640, 11)], 390, 844);
await shot("phone", 390, 844, async () => {});
await desktop([win("w4", "settings", 120, 30, 900, 640, 11)]);
await shot("settings", 1440, 900, async () => {});
await browser.close();
console.log("shots done", TAG);
