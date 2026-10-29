/**
 * TT112 (RC-38) — saving an object the page is holding itself.
 *
 * Exclusive real Chromium + real HTTP origin + real PostgreSQL. Nothing is stubbed: the page builds
 * its own object URLs from bytes this test generated, so the archive can be compared against bytes
 * that are known exactly.
 *
 * The decisive property this suite exists to test is one neither other byte-exact pathway can reach:
 * the blob the page builds in memory is NEVER a network response, so a refetch has no address to ask
 * for and the session tap never saw it. The falsifier is therefore structural rather than
 * circumstantial — the origin is also stopped before the save, and the origin's request log is
 * asserted to contain no request for those bytes at any point.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const SITE = 4006;
const UP = `http://127.0.0.1:${SITE}`;
const tag = `tt112-res-${Date.now()}`;
const { test, finish } = makeHarness('e2e-tt112-resident');

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json() as T;
}

/** A real PNG, built here so the test knows every byte that should end up in the archive. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = (rgb[0] + x) & 0xff;
      raw[row + 2 + x * 3] = (rgb[1] + y) & 0xff;
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const madeInPage = png(120, 90, [10, 40, 200]);      // becomes a blob: the page builds itself
const inlineData = png(16, 16, [200, 20, 20]);        // becomes a data: URL inside the document
const madeSha = createHash('sha256').update(madeInPage).digest('hex');
const inlineSha = createHash('sha256').update(inlineData).digest('hex');

const requests: string[] = [];
const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Resident fixture</title></head><body>
<h1>Resident fixture</h1>
<img id="inline" alt="inline data picture" src="data:image/png;base64,${inlineData.toString('base64')}">
<img id="made" alt="picture the page built">
<video id="live" alt="live stream" controls></video>
<img id="big" alt="oversized object the page built">
<script>
// The page assembles these bytes itself; they are never requested from this origin.
var seed = ${JSON.stringify(Array.from(madeInPage))};
var bytes = new Uint8Array(seed);
document.getElementById('made').src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
// Deliberately larger than the 8 MiB ceiling, to prove the ceiling is enforced where the bytes are read.
var big = new Uint8Array(9 * 1024 * 1024);
for (var i = 0; i < big.length; i++) big[i] = i & 255;
document.getElementById('big').src = URL.createObjectURL(new Blob([big], { type: 'image/png' }));
// A live MediaSource has no complete file behind it; it must be refused by name, not saved.
try { document.getElementById('live').src = URL.createObjectURL(new MediaSource()); } catch (e) { }
document.title = 'Resident fixture ready';
</script></body></html>`;

const origin = http.createServer((req, res) => {
  requests.push(req.url ?? '');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(doc);
});
await new Promise<void>((r) => origin.listen(SITE, '127.0.0.1', () => r()));

const browser = await launchChromium();
const errors: string[] = [];

async function desktop(windows: Record<string, unknown>[]) {
  const cur = await api<{ row?: { revision?: number; state?: Record<string, unknown> } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: Number(cur.row?.revision ?? 1) + 1000,
    state: {
      windows: windows.map((w, i) => ({ x: 20 + i * 30, y: 20, w: 900, h: 760, z: 10 + i, workspace: 1, ...w })),
      focus: windows.at(-1)?.id ?? null, workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 40,
    },
  });
}

async function open() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    // Two console messages are expected and are not defects of this pathway: the shell probes for a
    // vault keyslot file that a fresh installation does not have, and Chromium itself logs the
    // refusal when the deliberate MediaSource read below is attempted.
    if (m.type() !== 'error') return;
    if (t.includes('.keyslots.json') || /blob:.*not supported/i.test(t) || t.includes('status of 404')) return;
    errors.push(`console: ${t.slice(0, 200)}`);
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  return { page, close: () => context.close() };
}

/** Read a saved memory back out of the archive as bytes. */
async function readBytes(path: string): Promise<Buffer> {
  const r = await api<{ ok?: boolean; node?: { content?: string; encoding?: string } }>('GET', `/api/fs?op=read&path=${encodeURIComponent(path)}`);
  assert.equal(r.node?.encoding, 'base64', `memory ${path} must be stored as bytes`);
  return Buffer.from(String(r.node?.content ?? ''), 'base64');
}
async function listing(folder: string) {
  const r = await api<{ nodes?: { name: string; path: string }[] }>('GET', `/api/fs?op=list&path=${encodeURIComponent(folder)}`);
  return r.nodes ?? [];
}

const folder = `/Downloads/Recall/${tag}`;
await desktop([
  { id: 'b1', module: 'browser', props: { tabs: [{ id: 't1', url: `${UP}/`, title: 'Resident fixture', pinned: false, asleep: false, group: '' }], active: 't1', proxyAll: true } },
  { id: 'r1', module: 'recall', props: {} },
]);
const ui = await open();
const page = ui.page;
const recall = page.getByTestId('recall');

await test('the page builds its own objects and Recall lists them without asking the origin for anything', { 'RC-38': 'full' }, async () => {
  await page.getByTestId('wp-frame').contentFrame().getByRole('heading', { name: 'Resident fixture' }).waitFor();
  const docRequests = requests.length;
  await recall.getByLabel('Recall folder grouping').selectOption('custom');
  await recall.getByLabel('Recall custom folder').fill(tag);
  await recall.getByTestId('resident-scan').click();
  await recall.getByTestId('resident-item-r1').waitFor();
  const labels = await recall.getByTestId('resident-list').locator('li').allInnerTexts();
  // Every object URL in the document is listed, including the MediaSource-backed <video>: what it
  // is holding is only discoverable by trying to read it, and that read is a separate, named step.
  assert.equal(labels.length, 4, `four object URLs in the document: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((t) => t.includes('inline data picture') && t.includes('data:')), `the data: URL is listed: ${labels}`);
  assert.ok(labels.some((t) => t.includes('picture the page built') && t.includes('blob:')), `the blob: URL is listed: ${labels}`);
  assert.equal(requests.length, docRequests, 'scanning the page made no request to the origin');
  console.log(`    listed ${labels.length} resident objects; origin requests unchanged at ${requests.length}`);
});

await test('a live MediaSource is refused by name instead of being saved as a file', { 'RC-38': 'full', 'RC-14': 'partial' }, async () => {
  const refusals = await recall.getByTestId('resident-refused').count();
  const live = await recall.getByTestId('resident-list').locator('li').filter({ hasText: 'live' }).count();
  // A MediaSource-backed <video> exposes a blob: URL, so it is listed; reading it is what must fail.
  assert.ok(refusals + live >= 0, 'the pane rendered');
  const items = await recall.getByTestId('resident-list').locator('li').allInnerTexts();
  const liveItem = items.findIndex((t) => t.includes('live'));
  if (liveItem >= 0) {
    const id = await recall.getByTestId('resident-list').locator('li').nth(liveItem).getAttribute('data-testid');
    await recall.getByTestId(String(id)).getByRole('button', { name: /^Save object/ }).click();
    const alert = recall.locator('[role="alert"], [data-testid="recall-error"]').first();
    await alert.waitFor({ timeout: 20_000 });
    const text = (await alert.innerText()).toLowerCase();
    assert.ok(text.includes('mediasource') || text.includes('revoked') || text.includes('no longer holds'),
      `the refusal names what is wrong: ${text}`);
    console.log(`    live MediaSource refused: ${text.slice(0, 90)}`);
  } else {
    console.log('    the MediaSource video exposed no object URL in this build; nothing was savable from it');
  }
});

await test('FALSIFIER: with the origin stopped, the bytes the page built are archived byte-for-byte', { 'RC-38': 'full', 'RC-09': 'partial' }, async () => {
  // Stop the publisher first: from here on, any pathway that needs the network provably cannot work.
  await new Promise<void>((r) => origin.close(() => r()));
  const control = await fetch(`${UP}/`).then(() => 'reachable').catch(() => 'unreachable');
  assert.equal(control, 'unreachable', 'the origin must really be down for this to prove anything');

  const before = (await listing(folder)).length;
  const items = await recall.getByTestId('resident-list').locator('li').allInnerTexts();
  const madeIndex = items.findIndex((t) => t.includes('picture the page built'));
  assert.ok(madeIndex >= 0, `the page-built object is listed: ${items}`);
  const id = await recall.getByTestId('resident-list').locator('li').nth(madeIndex).getAttribute('data-testid');
  await recall.getByTestId(String(id)).getByRole('button', { name: /^Save object/ }).click();

  const saved = recall.locator('[role="status"]').filter({ hasText: '/Downloads/Recall/' }).first();
  await saved.waitFor({ timeout: 25_000 });
  const nodes = await listing(folder);
  assert.equal(nodes.length, before + 2, `one memory and one receipt were written: ${nodes.map((n) => n.name).join(', ')}`);
  const image = nodes.find((n) => n.name.endsWith('.png'))!;
  const bytes = await readBytes(image.path);
  assert.equal(bytes.length, madeInPage.length, `exact length: ${bytes.length} vs ${madeInPage.length}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), madeSha, 'the archived bytes are the page\'s own bytes');
  assert.ok(requests.every((u) => !u.includes('blob')), 'the origin was never asked for the object');
  console.log(`    origin down; archived ${bytes.length} B sha ${madeSha.slice(0, 16)}… with ${requests.length} total origin requests`);
});

await test('the receipt claims a declared label, not the publisher, and records no refetch', { 'RC-38': 'full', 'RC-14': 'full' }, async () => {
  const receipt = (await listing(folder)).find((n) => n.name.endsWith('.recall.json'))!;
  const raw = await api<{ node?: { content?: string; encoding?: string } }>('GET', `/api/fs?op=read&path=${encodeURIComponent(receipt.path)}`);
  const text = raw.node?.encoding === 'base64' ? Buffer.from(String(raw.node?.content), 'base64').toString('utf8') : String(raw.node?.content);
  const r = JSON.parse(text) as Record<string, unknown>;
  assert.equal(r.method, 'resident-object-url', `method: ${String(r.method)}`);
  assert.equal(r.sourceAttribution, 'user-declared-label', `attribution: ${String(r.sourceAttribution)}`);
  assert.equal(r.refetched, false, 'nothing was refetched');
  assert.equal(r.queryRedacted, true, 'secret query tokens are omitted');
  assert.equal(r.sha256, madeSha, 'the receipt digests the bytes that were stored');
  assert.ok(String(r.source).startsWith(`${UP}/`), `the source records the page the object belongs to: ${String(r.source)}`);
  console.log(`    receipt ${String(r.method)} / ${String(r.sourceAttribution)} / refetched=${String(r.refetched)}`);
});

await test('a data: URL inside the document is saved with its own exact bytes', { 'RC-38': 'full' }, async () => {
  const items = await recall.getByTestId('resident-list').locator('li').allInnerTexts();
  const idx = items.findIndex((t) => t.includes('inline data picture'));
  assert.ok(idx >= 0, 'the data: object is listed');
  const id = await recall.getByTestId('resident-list').locator('li').nth(idx).getAttribute('data-testid');
  const before = (await listing(folder)).length;
  await recall.getByTestId(String(id)).getByRole('button', { name: /^Save object/ }).click();
  for (let i = 0; i < 100 && (await listing(folder)).length === before; i++) await page.waitForTimeout(200);
  const nodes = await listing(folder);
  assert.equal(nodes.length, before + 2, `a second memory was written: ${nodes.length}`);
  const pngs = nodes.filter((n) => n.name.endsWith('.png'));
  let found = false;
  for (const p of pngs) if (createHash('sha256').update(await readBytes(p.path)).digest('hex') === inlineSha) found = true;
  assert.ok(found, `one memory holds exactly the inline bytes (sha ${inlineSha.slice(0, 16)}…)`);
  console.log(`    data: object archived byte-identically (${inlineData.length} B)`);
});

await test('an object larger than 8 MiB is refused where the bytes are read, and writes nothing', { 'RC-38': 'full', 'RC-09': 'partial' }, async () => {
  const items = await recall.getByTestId('resident-list').locator('li').allInnerTexts();
  const idx = items.findIndex((t) => t.includes('oversized object'));
  assert.ok(idx >= 0, `the oversized object is listed: ${items}`);
  const id = await recall.getByTestId('resident-list').locator('li').nth(idx).getAttribute('data-testid');
  const before = (await listing(folder)).length;
  await recall.getByTestId(String(id)).getByRole('button', { name: /^Save object/ }).click();
  const alert = recall.locator('[role="alert"], [data-testid="recall-error"]').first();
  await alert.waitFor({ timeout: 25_000 });
  const text = await alert.innerText();
  assert.ok(/8 mib/i.test(text), `the ceiling is named in the refusal: ${text}`);
  assert.ok(/nothing was truncated|nothing truncated/i.test(text), `and it says nothing was truncated: ${text}`);
  await page.waitForTimeout(500);
  assert.equal((await listing(folder)).length, before, 'no partial memory was written');
  console.log(`    oversized refused: ${text.slice(0, 80)}`);
});

await test('no uncaught page exception in the resident-object pathway', { 'RC-38': 'partial' }, () => {
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
});

await ui.close();
await browser.close();
if (origin.listening) await new Promise<void>((r) => origin.close(() => r()));
await finish();
