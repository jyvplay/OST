/** Force delayed settings hydration in a real browser against a disposable server. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.BASE) throw new Error("Refusing appearance-setting test without a disposable server opt-in and BASE.");
const BASE = process.env.BASE;
const { test, finish } = makeHarness("e2e-tt95-a11y-settings-race");
const read = await fetch(`${BASE}/api/settings`);
assert.equal(read.status, 200);
const old = ((await read.json()) as { rows: { key: string; value: string }[] }).rows.find((row) => row.key === "appearance.textScale")?.value ?? "125";
async function setScale(value: string) {
  const response = await fetch(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "appearance.textScale", value }) });
  assert.equal(response.status, 200, `setting ${value} was refused`);
}
const browser = await launchChromium();
try {
  await test("a delayed settings response can expose default-sized icons before the saved scale is applied", { "AX-10": "partial", "AX-09": "partial" }, async () => {
    await setScale("200");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const seen = new Promise<void>((resolve) => { entered = resolve; });
    const page = await context.newPage();
    try {
      await page.route("**/api/settings", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        entered(); await held; await route.continue();
      });
      const response = await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await Promise.race([seen, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("settings request was not intercepted")), 10_000))]);
      const icon = page.locator('[data-testid="shelf-files"] svg');
      await icon.waitFor({ state: "attached", timeout: 20_000 });
      const before = await icon.boundingBox();
      assert.ok(before && before.width >= 29 && before.width <= 31, `expected default-width icon while settings are held, got ${before?.width}`);
      release();
      await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-ts")) === 2, null, { timeout: 20_000 });
      const after = await icon.boundingBox();
      assert.ok(after && after.width >= before.width * 1.5, `expected saved scale after hydration; before ${before.width}, after ${after?.width}`);
      console.log(`    forced schedule: ${before.width}px before settings, ${after.width}px after saved 200% scale`);
    } finally { release(); await context.close(); }
  });
} finally { await browser.close(); await setScale(old); }
finish();
