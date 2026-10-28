/** Read-only host-data preview check; ordinary shell window state is allowed to persist. */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { mkdirSync } from 'node:fs';
const base = process.env.PREVIEW_BASE ?? 'http://127.0.0.1:3000';
const browser = await launchChromium();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  assert.equal((await page.goto(base + '/?open=files&path=/Documents'))?.status(), 200);
  const win = page.locator('.fs-window[aria-label="Files"]').last(); await win.getByTestId('files-status').first().waitFor({ timeout: 30000 });
  await win.getByTestId('files-status').first().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Orbit actions' }); await menu.waitFor(); assert.ok(await menu.getByRole('menuitem', { name: 'Tile left (Meta+Left)', exact: true }).count());
  mkdirSync('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/tt98-orbit-preview.png' });
  await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0);
  assert.deepEqual(errors, []);
  for (const path of ['/manifest.webmanifest', '/api/settings', '/api/features']) assert.equal((await page.request.get(base + path)).status(), 200);
  console.log('Production preview: HTTP 200, Files listing, Orbit menu, Escape, manifest/settings/features, no page exceptions.');
  await context.close();
} finally { await browser.close(); }
