/** Actual final-build views of the two new original app marks, plus native
 * compact toolbar reachability. No mocked transport, state injection or fake
 * device. Window setup uses the application's public disposable state API.
 * Graphic/layout checks are not additional Class A feature completions. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "playwright/test";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";

const fx = await disposableShell(), { test, finish } = makeHarness("tt134-icon-review");
const records: { app: string; mode: string; path: string; width: number; height: number }[] = [];
mkdirSync("docs/screens/tt134-polish", { recursive: true });
try {
  for (const [mode, width] of [["wide", 1500], ["compact", 900]] as const) {
    const context = await fx.context({ viewport: { width, height: 960 } });
    try {
      for (const [app, glyph] of [["notes", "note"], ["find", "search"]] as const) {
        await test(`${mode}: ${app} original mark renders in the real window without an external asset or page error`, {}, async () => {
          await fx.windows(app, 1, width); const page = await context.newPage(), errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          try {
            await fx.ready(page, app);
            const window = page.locator('[data-win-id="w1"]'), icon = window.locator(`svg[data-icon="${glyph}"]`).first();
            await expect(icon).toBeVisible(); await page.evaluate(() => document.fonts.ready);
            assert.equal(await icon.getAttribute("viewBox"), "0 0 48 48");
            assert.equal(await icon.locator("image, use").count(), 0, "the mark has no fetched/reference artwork");
            const box = await icon.boundingBox(); assert.ok(box && box.width > 10 && box.height > 10);
            const path = `docs/screens/tt134-polish/${app}-${mode}.png`;
            await window.screenshot({ path, animations: "disabled" });
            records.push({ app, mode, path, width: box.width, height: box.height });
            assert.deepEqual(errors, []);
          } finally { await page.close(); }
        });
      }
    } finally { await context.close(); }
  }
  await test("compact Contacts: the initially clipped Duplicates command scrolls into view and actually opens its panel", {}, async () => {
    await fx.windows("contacts", 1, 900);
    const context = await fx.context({ viewport: { width: 900, height: 960 } }), page = await context.newPage();
    try {
      await fx.ready(page, "contacts"); const win = page.locator('[data-win-id="w1"]'), button = win.getByTestId("ct-dupes");
      await expect(button).toBeVisible(); await button.click();
      await expect(button).toHaveAttribute("data-variant", "primary");
      const toolbar = win.locator(".fs-toolbar").first();
      const geometry = await button.evaluate(el => {
        const b = el.getBoundingClientRect(), bar = el.closest(".fs-toolbar")!.getBoundingClientRect();
        return { left: b.left, right: b.right, toolbarLeft: bar.left, toolbarRight: bar.right };
      });
      assert.ok(geometry.left >= geometry.toolbarLeft - 1 && geometry.right <= geometry.toolbarRight + 1, "the real browser made the clipped command reachable");
      assert.ok(await toolbar.evaluate(el => el.scrollWidth > el.clientWidth), "compact overflow is intentional toolbar scrolling");
      await win.screenshot({ path: "docs/screens/tt134-polish/contacts-compact-scrolled.png", animations: "disabled" });
    } finally { await context.close(); }
  });
} finally {
  writeFileSync("docs/evidence/tt134-icon-review.json", JSON.stringify({
    scope: "Five actual final-build graphic/layout checks; not new feature registrations or universal visual acceptance",
    sourceSha256: createHash("sha256").update(readFileSync("src/components/AppIcon.tsx")).digest("hex"), records,
  }, null, 2) + "\n");
  await fx.close(); finish();
}
