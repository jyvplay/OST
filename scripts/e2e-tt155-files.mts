import assert from "node:assert/strict";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt155-files");
try {
  await test("Files mechanics is keyboard-focusable and its overflowing content scrolls", {}, async () => {
    await fx.windows("files"); const ctx = await fx.context({ viewport: { width: 1100, height: 700 } });
    try {
      const page = await ctx.newPage(); await fx.ready(page, "files");
      const section = page.getByTestId("files-mechanics"); await section.waitFor();
      assert.equal(await section.getAttribute("tabindex"), "0");
      assert.equal(await section.evaluate(e => e.scrollHeight > e.clientHeight), true, "this test must exercise actual overflow");
      await section.focus(); assert.equal(await section.evaluate(e => e === document.activeElement), true);
      await page.keyboard.press("End");
      await page.waitForFunction(() => (document.querySelector('[data-testid="files-mechanics"]')?.scrollTop ?? 0) > 0);
    } finally { await ctx.close(); }
  });
} finally { await fx.close(); finish(); }
