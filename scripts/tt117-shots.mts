import { launchChromium } from "./browser-launch.mts";
const BASE = "http://127.0.0.1:3999";
async function api(m: string, p: string, b?: unknown) { const r = await fetch(BASE + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return r.json(); }
const browser = await launchChromium();
for (const mod of ["recall", "browser", "clock"]) {
  const cur = await api("GET", "/api/state?id=default") as { row?: { revision?: number } };
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: mod, title: mod, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `docs/screens/tt117-${mod}.png` });
  await ctx.close();
}
await browser.close();
console.log("shots done");
