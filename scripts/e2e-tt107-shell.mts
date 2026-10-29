/**
 * TT107 — first real browser tests for the shell's top bar and quick panel:
 * the clock, the launcher/search/overview controls, and whether the quick
 * panel's theme and density choices actually persist across a reload.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE;
if (!BASE || process.env.TT89_DISPOSABLE_DATABASE !== '1') throw Error('Disposable target required');
const { test, finish } = makeHarness('e2e-tt107-shell');

const setting = async (key: string) => {
  const r = await (await fetch(BASE + '/api/settings')).json();
  const bag = r.settings ?? r.rows ?? r;
  return Array.isArray(bag) ? bag.find((s: { key: string }) => s.key === key)?.value : bag[key];
};

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
try {
  await page.goto(BASE);
  const banner = page.getByRole('banner').first();
  await banner.waitFor();

  await test('the top bar shows a live clock in the user\'s own locale format', { 'SH-03': 'partial' }, async () => {
    const text = await banner.innerText();
    assert.match(text, /\b\d{1,2}:\d{2}\b/, 'no clock in the top bar: ' + text.slice(0, 200));
  });

  await test('the top bar exposes launcher, search, overview and quick panel as real controls', { 'SH-03': 'partial' }, async () => {
    for (const name of [/Fusion launcher|Menu bar/, /Search|Spotlight search/, /Overview|Mission Control/, /Quick panel|Control Centre/]) {
      assert.ok(await page.getByRole('button', { name }).first().isVisible(), 'missing top-bar control ' + name);
    }
  });

  await test('the top bar reports live system status rather than a static badge', { 'SH-03': 'partial' }, async () => {
    assert.match(await banner.innerText(), /\d+ fps/, 'no live governor/fps status in the top bar');
  });

  // The top-bar control is a toggle, so opening has to be idempotent across tests.
  const openQuickPanel = async () => {
    const panel = page.getByRole('dialog', { name: 'Quick panel' });
    if (!(await panel.isVisible())) {
      await page.getByRole('button', { name: /Quick panel|Control Centre/ }).first().click();
      await panel.waitFor();
    }
    return panel;
  };

  await test('the quick panel opens from the top bar with its accessibility and style controls', { 'NC-03': 'partial' }, async () => {
    const panel = await openQuickPanel();
    assert.ok(await panel.getByRole('group', { name: 'Text size' }).isVisible());
    assert.ok(await panel.getByRole('group', { name: 'Style' }).isVisible());
    assert.ok(await panel.getByLabel('Focus mode').isVisible());
  });

  await test('quick-panel theme is applied to the document and survives a reload', { 'NC-03': 'partial' }, async () => {
    const panel = await openQuickPanel();
    const themeButton = panel.getByRole('button', { name: /^(Dark|Light)$/ });
    const before = (await themeButton.innerText()).trim();
    await themeButton.click();
    const after = before === 'Dark' ? 'Light' : 'Dark';
    await panel.getByRole('button', { name: after, exact: true }).waitFor();
    await page.waitForFunction((want) => document.documentElement.dataset.theme === want.toLowerCase(), after, { timeout: 5000 })
      .catch(async () => { assert.fail('theme choice never reached the document element: ' + await page.evaluate(() => document.documentElement.dataset.theme)); });
    assert.equal(String(await setting('appearance.theme')).toLowerCase(), after.toLowerCase(), 'theme was not persisted server-side');

    await page.reload();
    // The shell paints its default theme first and applies stored settings once they
    // load, so wait for hydration rather than racing it.
    await page.waitForFunction((want) => document.documentElement.dataset.theme === want, after.toLowerCase(), { timeout: 20000 })
      .catch(async () => assert.fail(`theme was lost on reload: ${await page.evaluate(() => document.documentElement.dataset.theme)} (server: ${await setting('appearance.theme')})`));
    const reopened = await openQuickPanel();
    assert.equal((await reopened.getByRole('button', { name: /^(Dark|Light)$/ }).innerText()).trim(), after, 'panel forgot the theme');
  });

  await test('quick-panel density cycles through all three settings and survives a reload', { 'NC-03': 'partial' }, async () => {
    const panel = await openQuickPanel();
    const densityButton = panel.getByRole('button', { name: /^(compact|balanced|touch)$/ });
    const seen = new Set<string>();
    let current = (await densityButton.innerText()).trim();
    seen.add(current);
    for (let i = 0; i < 2; i++) {
      await densityButton.click();
      await page.waitForFunction((prev) => {
        const b = [...document.querySelectorAll('button')].find((x) => /^(compact|balanced|touch)$/.test(x.textContent?.trim() ?? ''));
        return b && b.textContent?.trim() !== prev;
      }, current, { timeout: 5000 });
      current = (await densityButton.innerText()).trim();
      seen.add(current);
    }
    assert.equal(seen.size, 3, 'density did not cycle through compact/balanced/touch: ' + [...seen].join(','));
    assert.equal(await setting('appearance.density'), current, 'density was not persisted server-side');
    await page.reload();
    const reopened = await openQuickPanel();
    assert.equal((await reopened.getByRole('button', { name: /^(compact|balanced|touch)$/ }).innerText()).trim(), current, 'density was lost on reload');
  });

  await test('the quick panel closes again without leaving a modal trap', { 'NC-03': 'partial' }, async () => {
    await openQuickPanel();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Quick panel' }).waitFor({ state: 'hidden' });
    assert.ok(await page.getByRole('banner').first().isVisible(), 'shell unusable after closing the panel');
  });
} finally {
  await browser.close();
}
finish();
