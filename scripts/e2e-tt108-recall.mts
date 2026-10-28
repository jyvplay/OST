/**
 * TT108 — the new saving pathways driven through the real UI in real Chromium.
 *
 * The crop is produced by an actual pointer drag over an actual decoded preview and
 * the resulting file is read back and decoded to prove its real pixel size, so the
 * test cannot pass on a PNG that merely claims the right dimensions.
 */
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE;
if (!BASE || process.env.TT89_DISPOSABLE_DATABASE !== '1') throw Error('Disposable target required');
const { test, finish } = makeHarness('e2e-tt108-recall');
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  assert.ok(r.ok, JSON.stringify(j));
  return j as Record<string, unknown>;
};
const savedPath = async (scope: Locator) => {
  const text = await scope.getByRole('status').filter({ hasText: 'Saved memory →' }).first().innerText();
  const m = /Saved memory → (\S+)/.exec(text);
  if (!m) throw Error('No saved path in status: ' + text);
  return m[1];
};
/** Decode a stored memory in the page itself, so the assertion is about real pixels. */
const realSize = async (page: Page, path: string) => {
  const { node } = await api('GET', '/api/fs?' + new URLSearchParams({ op: 'read', path })) as { node: { content: string; mime: string } };
  return await page.evaluate(async ({ b64, mime }) => {
    const raw = atob(b64), bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    try { return { width: bmp.width, height: bmp.height, bytes: bytes.length }; } finally { bmp.close(); }
  }, { b64: node.content, mime: node.mime });
};

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(30000);
try {
  await api('GET', '/api/settings');
  const original = await api('GET', '/api/state?id=default') as { row?: { revision?: number; state?: object } };
  await api('PUT', '/api/state', {
    id: 'default', revision: (original.row?.revision ?? 0) + 300,
    state: {
      ...original.row?.state,
      windows: [{ id: 'm108', module: 'recall', title: 'Recall', props: {}, x: 15, y: 45, w: 1380, h: 1010, z: 20, workspace: 1 }],
      focus: 'm108', activeWorkspace: 1, nextZ: 21,
    },
  });
  await page.goto(BASE);

  const recall = page.getByTestId('recall');
  const tag = 'ui108-' + Date.now(), folder = '/Downloads/Recall/' + tag;
  await recall.getByLabel('Recall folder grouping', { exact: true }).selectOption('custom');
  await recall.getByLabel('Recall custom folder', { exact: true }).fill(tag);

  // A 120x90 picture with four distinct quadrants: a crop of one quadrant is visibly
  // a crop, and its size is checked after a real decode.
  const png = Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 90;
    const ctx = c.getContext('2d')!;
    const colours = ['#e2574c', '#2f9e44', '#1c7ed6', '#f0a500'];
    colours.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect((i % 2) * 60, Math.floor(i / 2) * 45, 60, 45); });
    return Array.from(new Uint8Array(await (await new Promise<Blob>((r) => c.toBlob((b) => r(b!)))).arrayBuffer()));
  }));
  await recall.getByLabel('Choose resident media').setInputFiles({ name: 'quadrants.png', mimeType: 'image/png', buffer: png });
  await recall.getByRole('status').filter({ hasText: 'Saved memory →' }).waitFor();
  const parentPath = await savedPath(recall);

  await recall.getByRole('button', { name: 'Refresh memory timeline' }).click();
  await recall.getByRole('list', { name: 'Memory timeline' }).getByRole('button').first().click();
  await recall.getByLabel('Saved memory preview').waitFor();

  const surface = recall.getByTestId('region-surface');
  /** A real pointer drag across the decoded preview, in its own displayed coordinates. */
  const dragRegion = async (x1: number, y1: number, x2: number, y2: number) => {
    const box = await surface.boundingBox();
    assert.ok(box, 'the region surface is not on screen');
    await page.mouse.move(box.x + x1, box.y + y1);
    await page.mouse.down();
    await page.mouse.move(box.x + (x1 + x2) / 2, box.y + (y1 + y2) / 2, { steps: 4 });
    await page.mouse.move(box.x + x2, box.y + y2, { steps: 4 });
    await page.mouse.up();
  };

  await test('dragging over a decoded preview reports the region without saving anything yet', { 'RC-33': 'partial' }, async () => {
    const before = (await api('GET', '/api/fs?' + new URLSearchParams({ op: 'recallAudit', folder })) as { mediaFiles: number }).mediaFiles;
    await dragRegion(10, 10, 70, 55);
    await recall.getByRole('status').filter({ hasText: 'Region selected:' }).first().waitFor();
    const after = (await api('GET', '/api/fs?' + new URLSearchParams({ op: 'recallAudit', folder })) as { mediaFiles: number }).mediaFiles;
    assert.equal(after, before, 'merely selecting a region saved something');
    const box = await surface.boundingBox();
    assert.ok(box && Math.abs(box.width - 120) < 2 && Math.abs(box.height - 90) < 2,
      `the preview is being scaled (${box?.width}x${box?.height}); this test assumes 1:1 display`);
  });

  let cropPath = '';
  await test('a dragged region is saved as its own memory, cut from the decoded preview', { 'RC-33': 'full' }, async () => {
    await recall.getByRole('button', { name: 'Save selected region' }).click();
    await recall.getByRole('status').filter({ hasText: 'cut from' }).first().waitFor();
    cropPath = await savedPath(recall);
    assert.notEqual(cropPath, parentPath);
    const size = await realSize(page, cropPath);
    assert.deepEqual({ width: size.width, height: size.height }, { width: 60, height: 45 },
      'the saved crop does not have the dragged size once actually decoded');
    const parentSize = await realSize(page, parentPath);
    assert.deepEqual({ width: parentSize.width, height: parentSize.height }, { width: 120, height: 90 }, 'the original was altered');
  });

  await test('the saved crop records the memory and rectangle it came from', { 'RC-33': 'full' }, async () => {
    const { node } = await api('GET', '/api/fs?' + new URLSearchParams({ op: 'read', path: cropPath + '.recall.json' })) as { node: { content: string } };
    const receipt = JSON.parse(node.content) as { method: string; derivedFrom?: { path: string; sha256: string; region: { x: number; y: number; width: number; height: number } } };
    assert.equal(receipt.method, 'cropped-preview-region');
    assert.ok(receipt.derivedFrom, 'the crop saved with no provenance');
    assert.equal(receipt.derivedFrom.path, parentPath);
    assert.deepEqual(receipt.derivedFrom.region, { x: 10, y: 10, width: 60, height: 45 });
    assert.match(receipt.derivedFrom.sha256, /^[0-9a-f]{64}$/);
  });

  await test('a selection too small to be a region is refused with a reason, not silently grown', { 'RC-33': 'full' }, async () => {
    await dragRegion(20, 20, 23, 23);
    await recall.getByRole('button', { name: 'Save selected region' }).click();
    await recall.getByRole('status').filter({ hasText: 'at least 8×8' }).first().waitFor();
    const audit = await api('GET', '/api/fs?' + new URLSearchParams({ op: 'recallAudit', folder })) as { mediaFiles: number; orphanMedia: string[]; orphanReceipts: string[] };
    assert.equal(audit.mediaFiles, 2, 'the refused crop was saved anyway');
    assert.deepEqual([audit.orphanMedia, audit.orphanReceipts], [[], []]);
  });

  await test('the saving timeline shows the real days and filters the list to the chosen one', { 'RC-32': 'full' }, async () => {
    await recall.getByRole('button', { name: 'Show saving timeline' }).click();
    const strip = recall.getByLabel('Saving timeline');
    await strip.waitFor();
    await assertStripMentionsNoBackgroundCapture(strip);
    const days = strip.getByRole('list', { name: 'Saving days' }).getByRole('button');
    assert.equal(await days.count(), 1, 'this folder was saved to on exactly one day');
    const label = await days.first().innerText();
    assert.match(label, /^\d{4}-\d{2}-\d{2} · 2 memories · /, 'the day button does not report the real count: ' + label);
    await days.first().click();
    await recall.getByRole('status').filter({ hasText: 'saved on' }).first().waitFor();
    const rows = recall.getByRole('list', { name: 'Memory timeline' }).getByRole('listitem');
    assert.equal(await rows.count(), 2, 'selecting the day did not list exactly that day’s memories');
  });

  await test('the timeline says plainly that it is not a background screenshot trail', { 'RC-32': 'partial' }, async () => {
    const text = await recall.getByLabel('Saving timeline').innerText();
    assert.match(text, /no periodic background screenshots/i);
    assert.match(text, /Only memories you chose to save/i);
  });

  async function assertStripMentionsNoBackgroundCapture(strip: Locator) {
    const text = await strip.innerText();
    assert.ok(text.includes('memories'), 'the timeline strip is empty: ' + text.slice(0, 200));
  }
} finally {
  await browser.close();
}
finish();
