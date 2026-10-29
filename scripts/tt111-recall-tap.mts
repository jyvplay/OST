/**
 * TT111 (RC-37) — saving media the browser ALREADY loaded, with the refetch made impossible.
 *
 * The whole point of this pathway is that the save does not ask the publisher again. A test that
 * leaves the origin running cannot tell the two apart, so this one **stops the origin server** after
 * the page has loaded the media and before the human saves it. The control assertion proves the
 * origin is really gone (a fresh proxy fetch fails); the save then still produces bytes identical,
 * sha256 for sha256, to the file the origin used to serve.
 *
 * A real Chromium loads the media as a real page subresource (<img> and a media fetch), through the
 * Fusion proxy, in an opaque origin — i.e. the production path, not a server-side simulation of it.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Browser } from 'playwright-core';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SITE = 4005;
const { test, finish } = makeHarness('tt111-recall-tap');

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* bytes or html */ }
  return { status: r.status, json, text };
};
const setTap = async (value: 'on' | 'off') => {
  // A silently-failed precondition is worse than a failed test: assert the switch actually moved.
  const r = await call('PUT', '/api/settings', { key: 'privacy.recallMediaTap', value });
  if (r.status !== 200) throw new Error(`could not set the tap to ${value}: ${r.status} ${r.text.slice(0, 120)}`);
  return r;
};
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const poll = async (fn: () => Promise<boolean> | boolean, what: string, ms = 15000) => {
  const until = Date.now() + ms;
  for (;;) { if (await fn()) return; if (Date.now() > until) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 150)); }
};

/** A real PNG of a given size: signature + IHDR + IDAT (stored deflate) + IEND, so the bytes are a file a browser renders. */
function makePng(w: number, h: number, tint: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); head.copy(out, 4); out.writeUInt32BE(crc(head), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { const row = y * (1 + w * 3); raw[row] = 0; for (let x = 0; x < w; x++) { const o = row + 1 + x * 3; raw[o] = (x * 7 + tint) & 255; raw[o + 1] = (y * 5 + tint) & 255; raw[o + 2] = tint; } }
  const z = deflateSync(raw, { level: 6 });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', Buffer.alloc(0))]);
}

const PHOTO = makePng(240, 160, 90);        // the picture the page shows
const TRACK = Buffer.concat([Buffer.from('OggS'), Buffer.from(makePng(60, 40, 10).subarray(8))]); // audio/ogg octets, fetched by the page
const CSS = Buffer.from('body{color:#123456}', 'utf8');
// Over the 8 MiB per-item cap. Random octets, because a smooth gradient deflates to a few hundred KB and
// would not test the cap at all; the tap bounds RESPONSE size and never parses the picture.
const BIG = Buffer.concat([makePng(8, 8, 1), randomBytes(9 * 1024 * 1024)]);
let requests: string[] = [];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Loaded media</title></head><body>
<img id="shot" src="/photo.png" alt="">
<script>
  window.R = { img: false, track: 0, css: false };
  const i = document.getElementById('shot');
  i.decode ? i.decode().then(() => { R.img = i.naturalWidth > 0; }, () => {}) : i.onload = () => { R.img = true; };
  fetch('/track.ogg').then((r) => r.arrayBuffer()).then((b) => { R.track = b.byteLength; });
  fetch('/style.css').then((r) => r.text()).then(() => { R.css = true; });
</script></body></html>`;

const sockets = new Set<import('node:net').Socket>();
const site = http.createServer((req, res) => {
  requests.push(req.url ?? '');
  const u = req.url ?? '';
  if (u === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); return; }
  if (u === '/photo.png') { res.setHeader('content-type', 'image/png'); res.setHeader('content-length', String(PHOTO.length)); res.end(PHOTO); return; }
  if (u === '/track.ogg') { res.setHeader('content-type', 'audio/ogg'); res.setHeader('content-length', String(TRACK.length)); res.end(TRACK); return; }
  if (u === '/style.css') { res.setHeader('content-type', 'text/css'); res.end(CSS); return; }
  if (u === '/huge.png') { res.setHeader('content-type', 'image/png'); res.setHeader('content-length', String(BIG.length)); res.end(BIG); return; }
  if (u === '/half.png') { // promises a whole picture, delivers half and hangs up
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PHOTO.length) });
    res.write(PHOTO.subarray(0, Math.floor(PHOTO.length / 2)));
    setTimeout(() => res.destroy(), 120); return;
  }
  if (u.startsWith('/slice.png')) { // a byte range: a slice of a file is not the file
    res.writeHead(206, { 'content-type': 'image/png', 'content-range': `bytes 0-99/${PHOTO.length}`, 'content-length': '100' });
    res.end(PHOTO.subarray(0, 100)); return;
  }
  res.writeHead(404); res.end();
});
site.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

let browser: Browser | null = null;
let sid = '';
let prefix = '';
const held = () => call('GET', `/api/recall-tap?sid=${sid}`).then((r) => r.json as { enabled: boolean; items: { id: string; url: string; mime: string; size: number; page: string | null }[] });
const proxyUrl = (path: string) => `${BASE}${prefix}http/127.0.0.1:${SITE}${path}`;

try {
  await new Promise<void>((r) => site.listen(SITE, '127.0.0.1', r));
  await setTap('on');
  const sess = (await call('POST', '/api/wp-session', { ua: 'desktop' })).json as { sid: string; prefix: string };
  assert.ok(sess.sid, 'proxy session');
  sid = sess.sid; prefix = sess.prefix;
  browser = await launchChromium();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await test('the page loads a picture and a track through the proxy; both land in the tap, the stylesheet does not',
    { 'RC-37': 'partial' }, async () => {
    await page.goto(proxyUrl('/'), { waitUntil: 'domcontentloaded' });
    await poll(async () => await page.evaluate('R.img === true && R.track > 0 && R.css === true') as boolean, 'page finished loading its media');
    await poll(async () => (await held()).items.length >= 2, 'tap holds the two media responses');
    const { enabled, items } = await held();
    assert.equal(enabled, true);
    const img = items.find((i) => i.url.endsWith('/photo.png'))!;
    const trk = items.find((i) => i.url.endsWith('/track.ogg'))!;
    assert.ok(img && trk, 'both media items are held');
    assert.equal(img.mime, 'image/png'); assert.equal(img.size, PHOTO.length);
    assert.equal(trk.mime, 'audio/ogg'); assert.equal(trk.size, TRACK.length);
    assert.equal(items.some((i) => i.url.endsWith('/style.css')), false, 'a stylesheet is not media and is never retained');
    assert.ok(img.page?.includes(`127.0.0.1:${SITE}`), `the item knows the page it loaded for (${img.page})`);
    console.log(`    held ${items.length}: ${items.map((i) => `${i.mime} ${i.size}B`).join(', ')}`);
  });

  await test('an aborted response and a byte range are not retained; neither is an item over the cap',
    { 'RC-37': 'partial', 'RC-09': 'partial' }, async () => {
    const before = (await held()).items.length;
    await page.evaluate(`fetch('/half.png').then(r=>r.arrayBuffer()).catch(()=>{}); fetch('/slice.png',{headers:{range:'bytes=0-99'}}).then(r=>r.arrayBuffer()).catch(()=>{}); fetch('/huge.png').then(r=>r.arrayBuffer()).catch(()=>{})`);
    await poll(async () => requests.filter((u) => u.startsWith('/half') || u.startsWith('/slice') || u.startsWith('/huge')).length >= 3, 'all three went upstream');
    await new Promise((r) => setTimeout(r, 1200));
    const items = (await held()).items;
    assert.equal(items.some((i) => i.url.includes('/half.png')), false, 'half a picture is never filed as the picture');
    assert.equal(items.some((i) => i.url.includes('/slice.png')), false, 'a 206 slice is not the resource');
    assert.ok(BIG.length > 8 * 1024 * 1024, `the over-cap fixture really is over the cap (${BIG.length} B)`);
    assert.equal(items.some((i) => i.url.includes('/huge.png')), false, `an item over ${8 * 1024 * 1024} B is not retained (it was ${BIG.length} B)`);
    assert.equal(items.length, before, 'the three refusals left the tap exactly as it was');
  });

  await test('THE FALSIFIER: the origin is stopped, a refetch provably fails, and the save still writes the original bytes',
    { 'RC-37': 'full' }, async () => {
    // Tear the origin down hard: close the listener AND destroy the proxy's keep-alive sockets.
    await new Promise<void>((r) => site.close(() => r()));
    for (const s of sockets) s.destroy();
    await poll(async () => {
      try { const r = await fetch(proxyUrl('/photo.png')); return r.status >= 500 || r.status === 502 || r.status === 504; } catch { return true; }
    }, 'the origin is really unreachable through the proxy');
    const control = await fetch(proxyUrl('/photo.png')).then((r) => r.status).catch(() => 0);
    assert.ok(control === 0 || control >= 500, `control: a fresh request for the same URL fails now (${control})`);
    requests = [];

    const item = (await held()).items.find((i) => i.url.endsWith('/photo.png'))!;
    const saved = await call('POST', '/api/recall-tap', { cmd: 'save', sid, id: item.id, grouping: 'host', title: 'Loaded media' });
    assert.equal(saved.status, 200, saved.text.slice(0, 200));
    const path = String(saved.json.path);
    assert.match(path, /^\/Downloads\/Recall\/[^/]+\/\d+-[0-9a-f-]+\.png$/);
    assert.equal(saved.json.refetched, false);
    assert.equal(requests.length, 0, 'the origin received no request during the save (it is not even running)');

    const read = await call('GET', `/api/fs?op=read&path=${encodeURIComponent(path)}`);
    const bytes = Buffer.from(String((read.json as { node: { content: string } }).node.content), 'base64');
    assert.equal(bytes.length, PHOTO.length, 'byte count identical to what the origin served');
    assert.equal(sha(bytes), sha(PHOTO), 'sha256 identical: these are the original response bytes, not a re-encode');
    console.log(`    saved ${bytes.length} B to ${path} with the origin down; sha256 ${sha(bytes).slice(0, 16)}…`);
  });

  await test('the receipt names the pathway and claims proxy-recorded provenance, and the memory survives verification',
    { 'RC-37': 'full', 'RC-09': 'full' }, async () => {
    const item = (await held()).items.find((i) => i.url.endsWith('/track.ogg'))!;
    const saved = await call('POST', '/api/recall-tap', { cmd: 'save', sid, id: item.id, grouping: 'host' });
    assert.equal(saved.status, 200, saved.text.slice(0, 200));
    const path = String(saved.json.path);
    const r = await call('GET', `/api/fs?op=read&path=${encodeURIComponent(`${path}.recall.json`)}`);
    const node = (r.json as { node: { content: string; encoding?: string } }).node;
    const text = node.encoding === 'base64' ? Buffer.from(node.content, 'base64').toString('utf8') : node.content;
    const receipt = JSON.parse(text) as Record<string, unknown>;
    assert.equal(receipt.version, 1);
    assert.equal(receipt.method, 'session-retained-response');
    assert.equal(receipt.sourceAttribution, 'proxy-recorded-response');
    assert.equal(receipt.bytes, TRACK.length);
    assert.equal(receipt.sha256, sha(TRACK));
    assert.equal(receipt.queryRedacted, true);
    assert.match(String(receipt.source), new RegExp(`^http://127\\.0\\.0\\.1:${SITE}/track\\.ogg$`));
    console.log(`    receipt: ${receipt.method} / ${receipt.sourceAttribution} / ${receipt.bytes} B`);
  });

  await test('the provenance binding holds: neither method may borrow the other\u2019s claim',
    { 'RC-37': 'full', 'RC-14': 'partial' }, async () => {
    const bytes = makePng(8, 8, 1);
    const b64 = bytes.toString('base64');
    const mk = (method: string, attribution: string, path: string) => JSON.stringify({
      version: 1, path, bytes: bytes.length, sha256: sha(bytes), mime: 'image/png', method,
      sourceAttribution: attribution, source: 'http://127.0.0.1:4005/photo.png', page: 'http://127.0.0.1:4005/',
      capturedAt: new Date().toISOString(), queryRedacted: true,
    });
    const folder = '/Downloads/Recall/127.0.0.1';
    for (const dir of ['/Downloads', '/Downloads/Recall', folder]) await call('POST', '/api/fs', { op: 'mkdir', path: dir });
    const attempts: [string, string, RegExp][] = [
      ['session-retained-response', 'requested-url', /must be "proxy-recorded-response"/],
      ['authorized-display-frame', 'proxy-recorded-response', /must be "user-declared-label"/],
      ['original-response', 'proxy-recorded-response', /must be "requested-url"/],
    ];
    for (const [method, attribution, expect] of attempts) {
      const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
      const res = await call('POST', '/api/fs', { op: 'recallCommit', path, content: b64, mime: 'image/png', receipt: mk(method, attribution, path) });
      assert.equal(res.status, 400, `${method} claiming ${attribution} must be refused (got ${res.status})`);
      assert.match(String((res.json as { error: string }).error), expect);
      const after = await call('GET', `/api/fs?op=stat&path=${encodeURIComponent(path)}`);
      const node = (after.json as { node?: unknown }).node ?? null;
      assert.ok(after.status === 404 || node === null, `the refused attempt wrote nothing (${after.status} ${after.text.slice(0, 80)})`);
    }
    console.log('    3 cross-claims refused, nothing written');
  });

  await test('the switch is real: off empties the tap, refuses the save, and the proxy stops retaining',
    { 'RC-37': 'full', 'SC-02': 'partial' }, async () => {
    assert.ok((await held()).items.length > 0, 'something is held while the tap is on');
    await setTap('off');
    const list = await held();
    assert.equal(list.enabled, false);
    assert.equal(list.items.length, 0, 'switching off drops what was held, it does not merely hide it');
    const refused = await call('POST', '/api/recall-tap', { cmd: 'save', sid, id: 'anything' });
    assert.equal(refused.status, 403);
    assert.match(String((refused.json as { error: string }).error), /switched off \(Settings → Privacy → Remember media this page loads\)/);

    // And with the switch off, a fresh load retains nothing at all.
    const site2 = http.createServer((_q, res) => { res.setHeader('content-type', 'image/png'); res.end(PHOTO); });
    await new Promise<void>((r) => site2.listen(SITE, '127.0.0.1', r));
    try {
      await fetch(proxyUrl('/photo.png')).then((r) => r.arrayBuffer()).catch(() => null);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal((await held()).items.length, 0, 'nothing is retained while the switch is off');
    } finally { await new Promise<void>((r) => site2.close(() => r())); }
    await setTap('on');
    console.log('    off: emptied, refused (403), and no new retention');
  });

  await test('a closed browser session keeps nothing',
    { 'RC-37': 'full', 'PR-14': 'partial' }, async () => {
    const site3 = http.createServer((_q, res) => { res.setHeader('content-type', 'image/png'); res.setHeader('content-length', String(PHOTO.length)); res.end(PHOTO); });
    await new Promise<void>((r) => site3.listen(SITE, '127.0.0.1', r));
    try {
      // The proxy pools upstream connections, and this fixture is a NEW listener on a port whose old
      // sockets it may still hold: retry until a request really reaches the fresh server.
      // Re-request on every iteration: the fixture is a new listener on a port whose sockets the proxy
      // may still pool, so the first attempt can be answered by a corpse. One loop covers both.
      await poll(async () => {
        try { const r = await fetch(proxyUrl('/photo.png')); if (r.status !== 200 || (await r.arrayBuffer()).byteLength !== PHOTO.length) return false; } catch { return false; }
        await new Promise((r) => setTimeout(r, 250));
        return (await held()).items.length >= 1;
      }, 'the restarted fixture answers and the response is retained again');
      await call('DELETE', `/api/wp-session?sid=${sid}`);
      await poll(async () => (await held()).items.length === 0, 'the tap died with the session');
      const refused = await call('POST', '/api/recall-tap', { cmd: 'save', sid, id: 'x' });
      assert.equal(refused.status, 404);
      console.log('    session ended → 0 items held, save answers 404');
    } finally { await new Promise<void>((r) => site3.close(() => r())); }
  });
} finally {
  await browser?.close().catch(() => undefined);
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => site.close(() => r())).catch(() => undefined);
  await setTap('off').catch(() => undefined);
}

finish();
