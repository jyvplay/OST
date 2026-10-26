/**
 * Visual-inspection screenshots for TT30 Narrator (not a pass/fail suite). Writes PNGs to scripts/tt30-shots/ (git-ignored).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt30.mts
 */
import { mkdirSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
const BASE = process.env.BASE ?? "http://localhost:3999";
const OUT = "scripts/tt30-shots"; mkdirSync(OUT, { recursive: true });
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
const KEYS = ["appearance.layout", "accessibility.narrator"];
const saved: Record<string, string> = {};
for (const r of (await api("GET", "/api/settings")).rows as { key: string; value: string }[]) if (KEYS.includes(r.key)) saved[r.key] = r.value;
const set = (k: string, v: string) => api("PUT", "/api/settings", { key: k, value: v });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
}
const browser = await launchChromium();
try {
  for (const layout of ["fusion", "business", "art"]) {
    await set("appearance.layout", layout); await set("accessibility.narrator", "on");
    await desktop([{ id: "s1", module: "settings", title: "Settings", x: 220, y: 60, w: 860, h: 620, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} }]);
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(BASE + "/"); await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30000 }).catch(() => 0); await page.waitForTimeout(2500);
    await page.locator('[data-win-id="s1"]').locator("button").first().focus(); await page.waitForTimeout(300);
    await page.keyboard.down("Insert"); await page.keyboard.press("KeyH"); await page.keyboard.up("Insert"); await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${layout}-cursor.png` });
    if (layout === "fusion") {
      await page.keyboard.down("Insert"); await page.keyboard.press("F1"); await page.keyboard.up("Insert"); await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${layout}-help.png` });
    }
    await page.context().close();
  }
} finally { for (const [k, v] of Object.entries(saved)) await set(k, v); await desktop([]); await browser.close(); }
