import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) throw new Error('Refusing Orbit tests without explicit disposable database and matching BASE.');
const BASE = process.env.BASE;
const { test, finish } = makeHarness('e2e-tt98-orbit');
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(r.ok, `${method} ${path}: ${r.status}`); return r.json();
}
const folder = `/Documents/tt98-${Date.now()}`;
await api('POST', '/api/fs', { op: 'mkdir', path: folder });
for (let i = 0; i < 6; i++) await api('POST', '/api/fs', { op: 'write', path: `${folder}/item-${i}.txt`, content: `item ${i}` });
await api('PUT', '/api/settings', { key: 'appearance.desktopView', value: 'classic' });
const state = await api('GET', '/api/state?id=default');
await api('PUT', '/api/state', { id: 'default', revision: (state.row?.revision ?? 1) + 1000, state: { windows: [], focus: null, workspaces: [{ id: 1, name: 'Main' }, { id: 2, name: 'Studio' }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } });
await page.goto(`${BASE}/?open=files&path=${encodeURIComponent(folder)}`);
const pane = page.locator('.fs-files-pane').first();
await pane.locator('[role=option]').first().waitFor({ timeout: 60000 });
const listing = pane.getByTestId('files-listing');
const rows = pane.locator('[role=option]');
const menu = page.getByRole('menu', { name: 'Orbit actions' });
async function drag(x1: number, y1: number, x2: number, y2: number) {
  await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 12 }); await page.mouse.up();
}
await test('Files rectangle selects intersecting rows without opening or clearing on release', { 'FM-15': "partial" }, async () => {
  const r = await rows.first().boundingBox(), b = await listing.boundingBox(); assert.ok(r && b);

  await drag(b.x + b.width - 5, r.y + r.height * 2.8, r.x + 10, r.y + 2);
  assert.equal(await rows.count(), 6);
  assert.equal(await listing.evaluate(el => document.activeElement === el), true, "blank-space drag focuses its own pane for subsequent keyboard commands");
  assert.equal(await pane.locator('[role=option][aria-selected=true]').count(), 3);
  assert.match(await pane.getByTestId('files-selcount').innerText(), /^3 selected/);
  assert.equal(await page.getByTestId('orbit-marquee').count(), 0);
});
await test('Files context Copy preserves all rectangle-selected paths', { 'FM-06': "partial", 'FM-15': "partial" }, async () => {
  await rows.first().click({ button: 'right' });
  const copy = page.locator('[data-testid=files-menu] [data-item=copy]'); assert.match(await copy.innerText(), /3/); await copy.click();
  const clip = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fusion.files.clip')!)); assert.equal(clip.paths.length, 3);
});
await test('Ctrl rectangle adds to the previous selection', { 'FM-15': "partial" }, async () => {
  const r = await rows.last().boundingBox(), b = await listing.boundingBox(); assert.ok(r && b);
  await page.keyboard.down('Control'); await drag(b.x + b.width - 5, r.y + r.height - 1, r.x + 10, r.y + 1); await page.keyboard.up('Control');
  assert.equal(await pane.locator('[role=option][aria-selected=true]').count(), 4);
});
await test('Non-modified rectangle replaces selection', { 'FM-15': "partial" }, async () => {
  const r = await rows.last().boundingBox(), b = await listing.boundingBox(); assert.ok(r && b);
  await drag(b.x + b.width - 5, r.y + r.height - 1, r.x + 10, r.y + 1);
  assert.equal(await pane.locator('[role=option][aria-selected=true]').count(), 1);
});
await test('Escape cancels an active rectangle and restores the prior selection', { 'FM-15': 'partial' }, async () => {
  const r = await rows.first().boundingBox(), b = await listing.boundingBox(); assert.ok(r && b);
  const before = await pane.locator('[role=option][aria-selected=true]').getAttribute('data-path');
  await page.mouse.move(b.x + b.width - 5, r.y + 2); await page.mouse.down(); await page.mouse.move(r.x + 10, r.y + r.height * 2.8, { steps: 8 });
  assert.equal(await page.getByTestId('orbit-marquee').count(), 1);
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await pane.locator('[role=option][aria-selected=true]').getAttribute('data-path'), before);
  assert.equal(await page.getByTestId('orbit-marquee').count(), 0);
});
await test('Empty rectangle clears selection', { 'FM-15': "partial" }, async () => {
  const b = await listing.boundingBox(); assert.ok(b); await drag(b.x + 20, b.y + b.height - 20, b.x + 80, b.y + b.height - 60);
  assert.equal(await pane.locator('[role=option][aria-selected=true]').count(), 0);
});
await test('App fallback opens, keyboard navigates, Escape restores invoking control', { 'WM-01': "partial" }, async () => {
  await pane.locator('button').first().focus(); 
  await pane.getByTestId('files-status').click({ button: 'right' }); await menu.waitFor();
  await page.keyboard.press('End'); assert.match(await page.evaluate(() => document.activeElement?.textContent), /Send to Studio/);
  await page.keyboard.press('Home'); assert.match(await page.evaluate(() => document.activeElement?.textContent), /Tile left/);
  await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "dialog");
});
await test('Existing file menu takes precedence over app fallback', { 'FM-06': "partial" }, async () => {
  await rows.first().click({ button: 'right' }); await page.getByTestId('files-menu').waitFor(); assert.equal(await menu.count(), 0); await page.keyboard.press('Escape');
});
await test('Native text context is not intercepted', { 'WM-01': "partial" }, async () => {
  const input = pane.locator('input').first(); await input.click({ button: 'right' }); assert.equal(await menu.count(), 0); await page.keyboard.press('Escape');
});
await test('Window action Tile left executes real reducer geometry', { 'WM-01': "partial" }, async () => {
  await pane.getByTestId('files-status').click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Tile left (Meta+Left)', exact: true }).click();
  await page.waitForTimeout(300); const b = await page.locator('.fs-window').first().boundingBox(); assert.ok(b && b.width < 800);
});
await test('Desktop rectangle selects visible icons', { 'SH-04': "partial" }, async () => {
  await page.locator('.fs-window').first().getByRole('button', { name: 'Minimise', exact: true }).click();
  const icons = page.getByTestId('desk-icon'); await icons.first().waitFor();
  const r = await icons.first().boundingBox(); assert.ok(r);
  await drag(r.x - 3, r.y - 3, r.x + r.width + 2, r.y + r.height + 2);
  assert.ok(await page.locator('[data-testid=desk-icon][aria-pressed=true]').count() >= 1);
});
await test('Desktop item menu copies real VFS paths and does not open background menu', { 'SH-04': "partial", 'FM-03': "partial" }, async () => {
  await page.getByTestId('desk-icon').first().click({ button: 'right' }); await menu.waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Clean up icons', exact: true }).count(), 0);
  await menu.getByRole('menuitem', { name: /^Copy \d+ item/ }).click();
  const clip = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fusion.files.clip')!)); assert.ok(clip.paths.every((p: string) => p.startsWith('/Documents/')));
});
await test('Desktop Select all and Clear selection work through Orbit', { 'SH-04': "partial" }, async () => {
  const icons = page.getByTestId('desk-icon'); await icons.first().click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Select all', exact: true }).click();
  assert.equal(await page.locator('[data-testid=desk-icon][aria-pressed=true]').count(), await icons.count());
  await icons.first().click({ button: 'right' }); await menu.getByRole('menuitem', { name: 'Clear selection', exact: true }).click(); assert.equal(await page.locator('[data-testid=desk-icon][aria-pressed=true]').count(), 0);
});
await test('Orbit stays inside viewport and closes on outside pointer', { 'SH-04': "partial" }, async () => {
  await page.getByTestId('desk-icon').last().click({ button: 'right' }); const b = await menu.boundingBox(); assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 1440 && b.y + b.height <= 1000);
  await page.mouse.click(1200, 800); assert.equal(await menu.count(), 0);
});
const desktopFile = `/Documents/orbit-${Date.now()}.txt`;
let currentFile = desktopFile;
const iconFor = (path: string) => page.locator(`[data-testid="desk-icon"][data-path="${path}"]`);
async function desktopAction(path: string, name: string) { await iconFor(path).click({ button: 'right' }); await menu.getByRole('menuitem', { name, exact: true }).click(); }
async function submitAsk(value: string, label: string) { const ask = page.locator('.fs-ask'); await ask.getByTestId('ask-input-value').fill(value); await ask.getByRole('button', { name: label, exact: true }).click(); }
await test('Desktop rename writes actual filesystem and refreshes the icon', { 'SH-04': 'partial', 'FM-03': 'partial' }, async () => {
  await api('POST', '/api/fs', { op: 'write', path: desktopFile, content: 'untouched original' });
  await page.reload(); await iconFor(desktopFile).waitFor();
  await desktopAction(desktopFile, 'Rename…'); currentFile = desktopFile.replace('.txt', '-renamed.txt'); await submitAsk(currentFile.split('/').at(-1)!, 'Rename');
  await iconFor(currentFile).waitFor(); assert.equal(await iconFor(desktopFile).count(), 0);
  const r = await api('GET', `/api/fs?op=read&path=${encodeURIComponent(currentFile)}`); assert.equal(r.node.content, 'untouched original');
});
await test('Rename collision refuses overwrite and preserves both files', { 'FM-03': 'partial' }, async () => {
  await api('POST', '/api/fs', { op: 'write', path: desktopFile, content: 'collision sentinel' });
  await desktopAction(currentFile, 'Rename…'); await submitAsk(desktopFile.split('/').at(-1)!, 'Rename');
  await page.getByText(/exists|conflict/i).first().waitFor();
  assert.equal((await api('GET', `/api/fs?op=read&path=${encodeURIComponent(desktopFile)}`)).node.content, 'collision sentinel');
  assert.equal((await api('GET', `/api/fs?op=read&path=${encodeURIComponent(currentFile)}`)).node.content, 'untouched original');
});
await test('Duplicate creates a distinct file with identical content', { 'FM-03': 'partial' }, async () => {
  await desktopAction(currentFile, 'Duplicate selection');
  const copy = currentFile.replace('.txt', ' copy.txt'); await iconFor(copy).waitFor();
  assert.equal((await api('GET', `/api/fs?op=read&path=${encodeURIComponent(copy)}`)).node.content, 'untouched original');
});
await test('Desktop copy then Paste creates a collision-safe copy', { 'FM-03': 'partial' }, async () => {
  await desktopAction(currentFile, 'Copy 1 item(s)');
  await page.mouse.click(1200, 700, { button: 'right' }); await page.getByRole('menuitem', { name: 'Paste into desktop', exact: true }).click();
  const copy = currentFile.replace('.txt', ' copy 2.txt'); await iconFor(copy).waitFor();
  assert.equal((await api('GET', `/api/fs?op=read&path=${encodeURIComponent(copy)}`)).node.content, 'untouched original');
});
await test('Desktop trash requires confirmation, cancellation has no effect, confirmation is recoverable', { 'FM-03': 'partial' }, async () => {
  await desktopAction(currentFile, 'Move selection to trash…'); await page.locator('.fs-ask').getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await iconFor(currentFile).count(), 1);
  await desktopAction(currentFile, 'Move selection to trash…'); await page.locator('.fs-ask').getByRole('button', { name: 'Move to trash', exact: true }).click(); await iconFor(currentFile).waitFor({ state: 'detached' });
  const r = await api('GET', '/api/fs?op=trash'); assert.ok(r.nodes.some((n: {path: string}) => n.path === currentFile));
  await api('POST', '/api/fs', { op: 'restore', path: currentFile });
});
await test('New desktop folder is backed by a real directory', { 'FM-13': 'partial' }, async () => {
  const name = `orbit-folder-${Date.now()}`;
  await page.mouse.click(1200, 700, { button: 'right' }); await page.getByRole('menuitem', { name: 'New folder…', exact: true }).click(); await submitAsk(name, 'Create');
  await iconFor(`/Documents/${name}`).waitFor(); assert.equal((await api('GET', `/api/fs?op=stat&path=${encodeURIComponent('/Documents/' + name)}`)).node.kind, 'dir');
});
await test('New text file collision cannot truncate an existing document', { 'FM-13': 'partial' }, async () => {
  await page.mouse.click(1200, 700, { button: 'right' }); await page.getByRole('menuitem', { name: 'New text file…', exact: true }).click(); await submitAsk(desktopFile.split('/').at(-1)!, 'Create');
  await page.getByText(/conflict|exists/i).first().waitFor();
  assert.equal((await api('GET', `/api/fs?op=read&path=${encodeURIComponent(desktopFile)}`)).node.content, 'collision sentinel');
});
await test('No uncaught browser exceptions', { 'SH-04': "partial" }, async () => { assert.deepEqual(errors, []); });
await page.screenshot({ path: '/tmp/tt98-desktop.png' });
await ctx.close(); await browser.close(); await finish();
