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
  await test('late probe for a closed tab cannot overwrite another tab', {}, async () => {
    await fx.windows('browser'); const ctx = await fx.context(), page = await ctx.newPage();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let seen!: () => void;
    const intercepted = new Promise<void>(resolve => { seen = resolve; });
    const first = `https://tt222-held-${Date.now().toString(36)}.invalid/`;
    const second = `https://tt222-live-${Date.now().toString(36)}.invalid/`;
    try {
      await page.route('**/api/embed-probe?*', async route => {
        if (new URL(route.request().url()).searchParams.get('url') === first) { seen(); await held; }
        await route.continue();
      });
      await fx.ready(page, 'browser'); await page.locator('[data-shell-ready="true"]').waitFor();
      const win = page.locator('[data-win-id="w1"]');
      await win.getByLabel('Address', {exact:true}).fill(first); await win.getByLabel('Address', {exact:true}).press('Enter');
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([intercepted, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('held request not observed')), 5000); })]); }
      finally { if (deadline) clearTimeout(deadline); }
      const closedTab = win.locator('[data-tab]').filter({hasText:new URL(first).host});
      await expect(closedTab).toHaveCount(1);
      const liveResponse = page.waitForResponse(r => new URL(r.url()).searchParams.get('url') === second, {timeout:5000});
      await win.getByLabel('Address', {exact:true}).fill(second); await win.getByLabel('Address', {exact:true}).press('Enter');
      assert.equal((await (await liveResponse).json()).verdict, 'unknown');
      await expect(win.getByText('Embedding could not be checked', {exact:true})).toBeVisible();
      await closedTab.click({button:'middle'}); await expect(closedTab).toHaveCount(0);
      const oldResponse = page.waitForResponse(r => new URL(r.url()).searchParams.get('url') === first, {timeout:5000});
      release(); assert.equal((await (await oldResponse).json()).verdict, 'unknown');
      await expect(win.getByLabel('Address', {exact:true})).toHaveValue(second);
      await expect(win.getByText('Embedding could not be checked', {exact:true})).toBeVisible();
      const again = page.waitForResponse(r => new URL(r.url()).searchParams.get('url') === second, {timeout:5000});
      await win.getByRole('button', {name:'Re-probe',exact:true}).click();
      assert.equal((await (await again).json()).verdict, 'unknown');
    } finally { release(); await ctx.close(); }
  });
} finally { await fx.close(); finish(); }
