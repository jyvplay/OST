/**
 * TT107 — the receipt-indexed search and the pair-integrity audit driven through
 * the real Recall UI in a real browser, including trashing an unpaired file.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Locator } from 'playwright';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE;
if (!BASE || process.env.TT89_DISPOSABLE_DATABASE !== '1') throw Error('Disposable target required');
const { test, finish } = makeHarness('e2e-tt107-memory');
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  assert.ok(r.ok, JSON.stringify(j));
  return j;
};
const savedPath = async (scope: Locator) => {
  const text = await scope.getByRole('status').filter({ hasText: 'Saved memory →' }).first().innerText();
  const m = /Saved memory → (\S+)/.exec(text);
  if (!m) throw Error('No saved path in status: ' + text);
  return m[1];
};

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(30000);
try {
  await api('GET', '/api/settings');
  const original = await api('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: (original.row?.revision ?? 0) + 200,
    state: {
      ...original.row?.state,
      windows: [{ id: 'm107', module: 'recall', title: 'Recall', props: {}, x: 15, y: 45, w: 1380, h: 1010, z: 20, workspace: 1 }],
      focus: 'm107', activeWorkspace: 1, nextZ: 21,
    },
  });
  await page.goto(BASE);

  const recall = page.getByTestId('recall');
  const tag = 'ui107-' + Date.now(), folder = '/Downloads/Recall/' + tag;
  await recall.getByLabel('Recall folder grouping', { exact: true }).selectOption('custom');
  await recall.getByLabel('Recall custom folder', { exact: true }).fill(tag);

  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const ctx = c.getContext('2d')!; ctx.fillStyle = 'magenta'; ctx.fillRect(0, 0, 8, 8);
    return Array.from(new Uint8Array(await (await new Promise<Blob>((r) => c.toBlob((b) => r(b!)))).arrayBuffer()));
  }));
  await recall.getByLabel('Choose resident media').setInputFiles({ name: 'chosen.png', mimeType: 'image/png', buffer: png });
  await recall.getByRole('status').filter({ hasText: 'Saved memory →' }).waitFor();
  const chosen = await savedPath(recall);
  const chosenName = chosen.split('/').pop()!;

  const timeline = recall.getByRole('list', { name: 'Memory timeline' });

  await test('searching by save method finds the memory through the real UI', { 'RC-27': 'partial' }, async () => {
    await recall.getByLabel('Filter by save method').selectOption('human-selected-file');
    await recall.getByRole('button', { name: 'Search memories', exact: true }).click();
    await recall.getByRole('status').filter({ hasText: 'memories match' }).waitFor();
    await timeline.getByRole('button', { name: chosenName, exact: true }).waitFor();
  });

  await test('a filter that matches nothing reports an honest empty result, not an error', { 'RC-27': 'partial' }, async () => {
    await recall.getByLabel('Filter by page host').fill('nothing-here.invalid');
    await recall.getByRole('button', { name: 'Search memories', exact: true }).click();
    await recall.getByRole('status').filter({ hasText: '0 memories match' }).waitFor();
    assert.equal(await timeline.getByRole('button').count(), 0, 'stale results left on screen after an empty search');
    await recall.getByLabel('Filter by page host').fill('');
    await recall.getByLabel('Filter by save method').selectOption('');
  });

  await test('the integrity report shows a healthy pair with no orphans', { 'RC-28': 'partial' }, async () => {
    await recall.getByRole('button', { name: 'Check pair integrity', exact: true }).click();
    const report = recall.getByLabel('Pair integrity report');
    await report.waitFor();
    await report.getByText(new RegExp('Scope: ' + folder + ' . 1 healthy pair ')).waitFor();
    assert.match(await report.innerText(), /0 media files without receipt/);
  });

  await test('an unpaired file is listed by the audit and can be trashed from the UI', { 'RC-28': 'partial' }, async () => {
    const orphan = `${folder}/${randomUUID()}.png`;
    await api('POST', '/api/fs', { op: 'write', path: orphan, content: png.toString('base64'), encoding: 'base64', mime: 'image/png' });
    await recall.getByRole('button', { name: 'Check pair integrity', exact: true }).click();
    const report = recall.getByLabel('Pair integrity report');
    await report.getByText(/1 media file without receipt/).waitFor();
    const row = report.getByRole('listitem').filter({ hasText: orphan.split('/').pop()! });
    await row.getByRole('button', { name: 'Trash unpaired file' }).click();
    await recall.getByRole('status').filter({ hasText: 'Unpaired file moved to Trash' }).waitFor();
    await report.getByText(/0 media files without receipt/).waitFor();
    const node = await api('GET', '/api/fs?' + new URLSearchParams({ op: 'stat', path: orphan }));
    assert.equal(node.node.trashed, true, 'file was reported cleaned but is still active');
  });

  await test('widening the scope to every folder is an explicit, visible choice', { 'RC-28': 'partial' }, async () => {
    await recall.getByLabel('Integrity scope').selectOption('all');
    await recall.getByRole('button', { name: 'Check pair integrity', exact: true }).click();
    const report = recall.getByLabel('Pair integrity report');
    await report.getByText(/Scope: all Recall folders/).waitFor();
    await recall.getByLabel('Integrity scope').selectOption('folder');
  });

  await test('the audit never invents a receipt for a memory that lost one', { 'RC-28': 'partial' }, async () => {
    const receipt = chosen + '.recall.json';
    const before = await api('GET', '/api/fs?' + new URLSearchParams({ op: 'read', path: receipt }));
    await recall.getByRole('button', { name: 'Check pair integrity', exact: true }).click();
    // Wait for the refreshed, folder-scoped report rather than whatever text the
    // previous audit left on screen.
    await recall.getByLabel('Pair integrity report').getByText(new RegExp('Scope: ' + folder + ' .*healthy pair')).waitFor();
    const after = await api('GET', '/api/fs?' + new URLSearchParams({ op: 'read', path: receipt }));
    assert.equal(after.node.content, before.node.content, 'the audit rewrote a receipt');
    assert.equal(after.node.version, before.node.version, 'the audit bumped a receipt version');
  });
} finally {
  await browser.close();
}
finish();
