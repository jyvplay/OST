/** Actual production-browser initial views, wide + compact, of ALL registered
 * modules. A review aid, not proof of all features or device/peer capabilities. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { MODULES } from "../src/lib/registry.ts";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("tt132-visual");
const records: any[] = [];
let capabilities: unknown;
try {
  for (const [mode, width] of [["wide", 1500], ["compact", 900]] as const) {
    const context = await fx.context({ viewport: { width, height: 960 } });
    mkdirSync(`docs/screens/tt132-visual/${mode}`, { recursive: true });
    try {
      for (const entry of MODULES) {
        await test(`${mode} initial view: ${entry.title}`, {}, async () => {
          await fx.windows(entry.id, 1, width); const page = await context.newPage(), errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await fx.ready(page, entry.id);
            if (!capabilities) capabilities = await page.evaluate(() => ({
              secureContext: isSecureContext, hardwareConcurrency: navigator.hardwareConcurrency,
              webLocks: typeof navigator.locks?.request === "function", notificationConstructor: typeof Notification,
              timestampTrigger: typeof (window as unknown as { TimestampTrigger?: unknown }).TimestampTrigger,
              serviceWorker: "serviceWorker" in navigator, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }));
            // Initial API data/worker startup must settle before reviewing the
            // screen; a continuously active transport is recorded, not faked.
            let settled = true;
            try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch { settled = false; }
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            const window = page.locator('[data-win-id="w1"]'), body = window.locator(".fs-winbody");
            const text = await body.innerText(), path = `docs/screens/tt132-visual/${mode}/${entry.id}.png`;
            await window.screenshot({ path, animations: "disabled" });
            const bounds = await body.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
            records.push({ mode, id: entry.id, title: entry.title, path, settled, words: text.trim().split(/\s+/).length, horizontalOverflow: bounds.scroll - bounds.client, errors, text });
            assert.ok(text.trim().length > 3 && !/^Loading[.…\s]*$/.test(text.trim()), `${entry.id} has no real entry view`);
            assert.deepEqual(errors, [], "no unhandled page errors during the initial view");
          } finally { await page.close(); }
        });
      }
    } finally { await context.close(); }
  }
} finally {
  writeFileSync("docs/evidence/tt132-visual.json", JSON.stringify({ browser: fx.browser.version(), capabilities, views: records }, null, 2) + "\n");
  await fx.close(); finish();
}
