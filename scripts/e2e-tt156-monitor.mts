import assert from "node:assert/strict";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt156-monitor");
try {
  await test("Monitor disclosures retain keyboard access and interactive diagnostics", {}, async () => {
    await fx.windows("monitor"); const ctx = await fx.context({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await ctx.newPage(); await fx.ready(page, "monitor");
      const win = page.locator('[data-win-id="w1"]');
      await win.getByTestId("monitor-inflight").waitFor();
      const system = win.getByText("Window, performance and media", { exact: true });
      await system.waitFor(); await system.focus(); await page.keyboard.press("Enter");
      await win.getByTestId("rg02-sentence").waitFor();
      for (const id of ["rg02-sentence", "ct03-sentence", "sh10-sentence", "wm11-surface", "wm06-sentence", "hw05-measure", "hw03-sentence", "ln05-sentence"]) assert.equal(await win.getByTestId(id).isVisible(), true, id);
      const privacy = win.getByText("Privacy, storage and alarms", { exact: true });
      await privacy.click(); await win.getByTestId("pr07p-rules").waitFor();
      for (const id of ["fm08-tone", "fm14-led", "pr07p-rules", "rc15-decision", "bl02-run", "bk05-sentence", "fm11-tone", "ck01-preview"]) assert.equal(await win.getByTestId(id).isVisible(), true, id);
      const editor = win.getByTestId("pr07p-rules"); const original = await editor.inputValue();
      await editor.fill("@@||example.com^$"); assert.notEqual(await editor.inputValue(), original, "real form editing remains available");
      await system.focus(); await page.keyboard.press("Enter");
      assert.equal(await win.getByTestId("rg02-sentence").isVisible(), false, "keyboard collapses the disclosure");
      await system.focus(); await page.keyboard.press("Enter");
      assert.equal(await win.getByTestId("rg02-sentence").isVisible(), true, "keyboard reopens it");
      await privacy.click(); await privacy.click();
      assert.equal(await editor.inputValue(), "@@||example.com^$", "collapse preserves unsaved input");
      const platform = win.getByText("Platform, scheduling and tests", { exact: true });
      await platform.focus(); await page.keyboard.press("Space");
      assert.equal(await platform.locator("xpath=..").evaluate(el => (el as HTMLDetailsElement).open), true);
      await page.screenshot({ path: "docs/screens/tt156-monitor-open.png", animations: "disabled" });
    } finally { await ctx.close(); }
  });
} finally { await fx.close(); finish(); }
