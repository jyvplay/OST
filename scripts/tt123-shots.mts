/** TT123 visual check: screenshots of the turn's touched surfaces. */
import { launchChromium } from "./browser-launch.mts";
const BASE = process.env.BASE!;
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json();
}
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
async function visit(module: string, props: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForTimeout(1400);
}
await visit("clock");
await page.getByTestId("clock-offset-sort").click().catch(() => undefined);
await page.waitForTimeout(400);
await page.screenshot({ path: "docs/screens/tt123-clock.png" });
await visit("backup");
await page.screenshot({ path: "docs/screens/tt123-backup.png" });
await visit("editor", { path: "/tt123.txt" });
await page.screenshot({ path: "docs/screens/tt123-editor.png" });
await visit("photos");
await page.screenshot({ path: "docs/screens/tt123-photos.png" });
await context.close();
await browser.close();
console.log("shots done");
