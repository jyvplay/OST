import assert from 'node:assert/strict';
import { expect } from 'playwright/test';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';

const fx = await disposableShell(), {test, finish} = makeHarness('e2e-tt221-browser-probe');
try {
  await test('same URL in two tabs gets a real independent probe', {}, async () => {
    await fx.windows('browser'); const ctx = await fx.context(), page = await ctx.newPage();
    try {
      await fx.ready(page, 'browser'); await page.locator('[data-shell-ready="true"]').waitFor();
      const win = page.locator('[data-win-id="w1"]');
      const target = `https://tt221-${Date.now().toString(36)}.invalid/`;
      async function openAndMeasure() {
        const reply = page.waitForResponse(r => { const u = new URL(r.url()); return u.pathname === '/api/embed-probe' && u.searchParams.get('url') === target; }, {timeout: 5000});
        await win.getByLabel('Address', {exact:true}).fill(target); await win.getByLabel('Address', {exact:true}).press('Enter');
        assert.equal((await (await reply).json()).verdict, 'unknown');
        await expect(win.getByText('Embedding could not be checked', {exact:true})).toBeVisible();
      }
      await openAndMeasure(); await openAndMeasure();
      const twins = win.locator('[data-tab]').filter({hasText: new URL(target).host});
      assert.equal(await twins.count(), 2);
      // Attack the repair: retries must still issue real requests in either tab.
      for (let i = 0; i < 2; i++) {
        await twins.nth(i).click();
        await expect(win.getByText('Embedding could not be checked', {exact:true})).toBeVisible();
        const retry = page.waitForResponse(r => { const u = new URL(r.url()); return u.pathname === '/api/embed-probe' && u.searchParams.get('url') === target; }, {timeout: 5000});
        await win.getByRole('button', {name:'Re-probe', exact:true}).click();
        assert.equal((await (await retry).json()).verdict, 'unknown');
        await expect(win.getByText('Embedding could not be checked', {exact:true})).toBeVisible();
      }
    } finally { await ctx.close(); }
  });
} finally { await fx.close(); finish(); }
