/**
 * Visual-inspection screenshots for TT29 (not a pass/fail suite). Writes PNGs to scripts/tt29-shots/ (git-ignored).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt29.mts [scene…]
 */
import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const OUT = "scripts/tt29-shots"; mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
const KEYS = ["appearance.layout", "appearance.style", "appearance.theme", "appearance.desktopView", "media.embeds"];
const saved: Record<string, string> = {};
for (const r of (await api("GET", "/api/settings")).rows as { key: string; value: string }[]) if (KEYS.includes(r.key)) saved[r.key] = r.value;
const set = (k: string, v: string) => api("PUT", "/api/settings", { key: k, value: v });
async function desktop(windows: unknown[], extra: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev, ...extra } });
}
const win = (id: string, module: string, r: { x: number; y: number; w: number; h: number }, props: Record<string, unknown> = {}) => ({ id, module, title: module, ...r, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = await launchChromium();
async function boot(windows: unknown[], vw = 1440, vh = 900): Promise<Page> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  await ctx.route(/(youtube|ytimg|vimeo|soundcloud|spotify|openstreetmap)\./i, (r) => r.fulfill({ status: 204, body: "" }));
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await sleep(1800);
  return page;
}
const scenes: Record<string, () => Promise<void>> = {
  async tabletop() {
    await set("appearance.desktopView", "tabletop");
    const page = await boot([win("n", "notes", { x: 300, y: 120, w: 700, h: 460 })]);
    await page.screenshot({ path: `${OUT}/tabletop-with-window.png` });
    await page.locator('[data-win-id="n"] .fs-tl-minimize, [data-win-id="n"] [aria-label^="Minimi"]').first().click().catch(() => undefined);
    await sleep(800);
    await page.screenshot({ path: `${OUT}/tabletop-slant.png` });
    await page.getByTestId("tt-nav-east").click(); await sleep(1200);
    await page.screenshot({ path: `${OUT}/tabletop-east-open.png` });
    await page.getByTestId("tt-back").click(); await sleep(1200);
    await page.getByTestId("tt-camera").click(); await sleep(1600);
    await page.screenshot({ path: `${OUT}/tabletop-top.png` });
    await page.getByTestId("tt-camera").click(); await sleep(800); // leave the default (slanted) camera persisted
    await page.context().close();
  },
};
try {
  for (const [name, fn] of Object.entries(scenes)) if (!only.length || only.includes(name)) { await fn(); console.log("scene", name); }
} finally {
  for (const [k, v] of Object.entries(saved)) await set(k, v);
  await desktop([]);
  await browser.close();
}
