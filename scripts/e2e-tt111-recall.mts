/**
 * TT111 (RC-37) — the human-initiated half: a person looks at a page, sees what it loaded, and keeps one.
 *
 * tt111-recall-tap.mts proves the mechanism over HTTP. This proves the ACT: a real Chromium opens the
 * Recall window, browses a real site inside the in-app browsing pane, the picture that page loaded
 * appears in "Media this page already loaded", the human clicks Save, and the bytes that land in the
 * archive are the publisher's original bytes. The origin is stopped before the click, so the save
 * cannot be a download — the fixture server is not even listening when the button is pressed.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Browser } from 'playwright-core';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const RUN = Math.random().toString(36).slice(2, 8);
const SITE = 4004;
const { test, finish } = makeHarness('e2e-tt111-recall');

const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return await r.json() as T;
};
const setTap = async (value: 'on' | 'off') => {
  const r = await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'privacy.recallMediaTap', value }) });
  assert.equal(r.status, 200, `the tap switch did not move to ${value}`);
};
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const readBytes = async (path: string) => {
  const r = await api<{ node?: { content?: string; encoding?: string } }>('GET', `/api/fs?op=read&path=${encodeURIComponent(path)}`);
  assert.ok(r.node, `no stored node at ${path}`);
  return r.node!.encoding === 'base64' ? Buffer.from(r.node!.content ?? '', 'base64') : Buffer.from(r.node!.content ?? '', 'utf8');
};

/** A real PNG whose bytes are unique to this run, so a match cannot be a coincidence. */
function makePng(w: number, h: number, salt: Buffer): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); head.copy(out, 4); out.writeUInt32BE(crc(head), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { const row = y * (1 + w * 3); for (let x = 0; x < w; x++) { const o = row + 1 + x * 3; raw[o] = salt[(x + y) % salt.length]; raw[o + 1] = (x * 3) & 255; raw[o + 2] = (y * 5) & 255; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const PHOTO = makePng(200, 140, randomBytes(64));
const sockets = new Set<import('node:net').Socket>();
let upstreamHits = 0;
const site = http.createServer((req, res) => {
  upstreamHits++;
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Gallery ${RUN}</title><body style="background:#111"><h1 style="color:#eee">Gallery</h1><img src="/art.png" alt="art" width="200"></body>`);
    return;
  }
  if (req.url === '/art.png') { res.setHeader('content-type', 'image/png'); res.setHeader('content-length', String(PHOTO.length)); res.end(PHOTO); return; }
  res.writeHead(404); res.end();
});
site.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

let browser: Browser | null = null;
try {
  await new Promise<void>((r) => site.listen(SITE, '127.0.0.1', r));
  await setTap('on');
  browser = await launchChromium();
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 160)); });

  const original = await api<{ row?: { revision?: number; state?: object } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: (original.row?.revision ?? 0) + 800,
    state: {
      ...original.row?.state,
      windows: [{ id: `rc111-${RUN}`, module: 'recall', title: 'Recall', props: { url: `http://127.0.0.1:${SITE}/` }, x: 10, y: 24, w: 1170, h: 820, z: 20, workspace: 1 }],
      focus: `rc111-${RUN}`, activeWorkspace: 1, nextZ: 21,
    },
  });
  await page.goto(BASE);
  const recall = page.getByTestId('recall');
  await recall.waitFor();

  await test('a page browsed inside Recall lists the media it loaded, with its type and size',
    { 'RC-37': 'full', 'RC-02': 'partial' }, async () => {
      await page.getByRole('button', { name: 'Browse inside Recall' }).click();
      // The pane mints its own proxy session; the page then loads its picture through it.
      await page.locator('[data-testid="recall"] iframe').first().waitFor({ state: 'attached' });
      await page.waitForTimeout(1500);
      const list = page.getByTestId('recall-tap-list');
      await list.waitFor();
      await page.waitForFunction(`document.querySelectorAll('[data-testid="recall-tap-list"] li').length > 0`, undefined, { timeout: 30000 });
      const rowText = await list.locator('li').first().innerText();
      assert.match(rowText, /art\.png/, `the item names the URL the page loaded: ${rowText}`);
      assert.match(rowText, /image\/png/, 'and the type it arrived as');
      const count = await page.getByTestId('tap-count').innerText();
      assert.match(count, /\d+ held/, `the pane says how much is held (${count})`);
      console.log(`    listed: ${rowText.replace(/\s+/g, ' ').slice(0, 90)}`);
    });

  await test('with the origin shut down, the human presses Save and the archive receives the publisher\u2019s exact bytes',
    { 'RC-37': 'full' }, async () => {
      await new Promise<void>((r) => site.close(() => r()));
      for (const s of sockets) s.destroy();
      // Prove the publisher is unreachable before the click, so the save cannot be a download.
      const dead = await fetch(`http://127.0.0.1:${SITE}/art.png`).then((r) => r.status).catch(() => 0);
      assert.equal(dead, 0, `the origin is down before the save (got ${dead})`);
      upstreamHits = 0;

      await page.getByRole('button', { name: /^Save loaded media / }).first().click();
      const status = page.locator('[data-testid="recall"] [role="status"]');
      await status.waitFor();
      await page.waitForFunction(`(document.querySelector('[data-testid="recall"] [role="status"]') || {}).textContent?.includes('Saved: /Downloads/Recall/') === true`, undefined, { timeout: 30000 });
      const text = (await status.innerText()).trim();
      const path = (/Saved:\s*(\/Downloads\/Recall\/\S+)/.exec(text) ?? [])[1];
      assert.ok(path, `the pane reports where it went: ${text}`);
      const bytes = await readBytes(path!);
      assert.equal(bytes.length, PHOTO.length, 'byte count identical to what the publisher served');
      assert.equal(sha(bytes), sha(PHOTO), 'sha256 identical — these are the original bytes, re-encoded by nobody');
      assert.equal(upstreamHits, 0, 'and the origin was never contacted (it was not even listening)');
      const receipt = JSON.parse((await readBytes(`${path}.recall.json`)).toString('utf8')) as Record<string, unknown>;
      assert.equal(receipt.method, 'session-retained-response');
      assert.equal(receipt.sourceAttribution, 'proxy-recorded-response');
      console.log(`    human save → ${path} (${bytes.length} B, sha ${sha(bytes).slice(0, 12)}…, origin down)`);
    });

  await test('Forget removes a held item from the pane immediately, and the switch empties it and says so',
    { 'RC-37': 'full', 'SC-02': 'partial' }, async () => {
      const before = await page.locator('[data-testid="recall-tap-list"] li').count();
      assert.ok(before > 0, 'something is held to forget');
      await page.getByRole('button', { name: /^Forget loaded media / }).first().click();
      try {
        await page.waitForFunction(`document.querySelectorAll('[data-testid="recall-tap-list"] li').length < ${before}`, undefined, { timeout: 15000 });
      } catch (e) {
        const now = await page.locator('[data-testid="recall-tap-list"] li').allInnerTexts();
        throw new Error(`forget left ${now.length} rows (was ${before}): ${JSON.stringify(now).slice(0, 200)}; page errors: ${JSON.stringify(pageErrors.slice(0, 3))}`);
      }

      // The switch is flipped on the server (as an administrator would). The open window holds the
      // settings it loaded with, so it is reloaded here to read the installation's current answer —
      // the same thing that happens when the desktop next boots.
      await setTap('off');
      await page.reload();
      await page.getByTestId('recall').waitFor();
      await page.waitForFunction(`!!document.querySelector('[data-testid="tap-policy-off"]')`, undefined, { timeout: 15000 });
      const note = await page.getByTestId('tap-policy-off').innerText();
      assert.match(note, /Settings → Privacy → Remember media this page loads/, `the note says where the switch is: ${note}`);
      assert.equal(await page.locator('[data-testid="recall-tap-list"] li').count(), 0, 'and nothing is listed while it is off');
      assert.equal((await page.getByTestId('tap-count').innerText()).trim(), 'off');
      // The other pathways are untouched by this switch.
      assert.ok(await page.getByRole('button', { name: 'Save media URL' }).isEnabled(), 'the refetch pathway still works when the tap is off');
      console.log(`    forget → removed; switch off → emptied, note shown, other pathways unaffected`);
    });
} finally {
  await browser?.close().catch(() => undefined);
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => site.close(() => r())).catch(() => undefined);
  await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'privacy.recallMediaTap', value: 'off' }) }).catch(() => undefined);
}

finish();
