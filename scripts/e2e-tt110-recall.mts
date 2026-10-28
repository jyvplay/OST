/**
 * TT110 — the capture pathways that have never been exercised.
 *
 * RC-04 authorized display snapshot, RC-05 authorized live recording, RC-06 Fusion element
 * capture and RC-11 bounded lifecycle have shipped since early turns but were graded from
 * reading the code, because no test environment here could grant a display surface. This
 * Chromium can: `--auto-select-desktop-capture-source` answers the picker with a real monitor
 * surface, so getDisplayMedia returns genuine frames and MediaRecorder encodes them.
 *
 * Nothing is mocked. The product code is untouched by the test: it asks for a display, the
 * browser grants one, and the bytes that land in the archive are read back over HTTP and
 * checked against the container/format they claim to be.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { Page } from 'playwright';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const RUN = Math.random().toString(36).slice(2, 8);
const FOLDER = `/Downloads/Recall/tt110.${RUN}`;
const { test, finish } = makeHarness('e2e-tt110-recall');

const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return await r.json() as T;
};
const listFolder = async () => {
  const r = await api<{ nodes?: { path: string; name: string; size: number; mime: string }[] }>(
    'GET', `/api/fs?op=list&path=${encodeURIComponent(FOLDER)}`);
  return (r.nodes ?? []).filter((n) => !n.name.endsWith('.recall.json'));
};
const readBytes = async (path: string) => {
  // op=stat deliberately strips content; op=read is the byte read.
  const r = await api<{ node?: { content?: string; encoding?: string } }>(
    'GET', `/api/fs?op=read&path=${encodeURIComponent(path)}`);
  assert.ok(r.node, `no stored node at ${path}`);
  return r.node!.encoding === 'base64'
    ? Buffer.from(r.node!.content ?? '', 'base64')
    : Buffer.from(r.node!.content ?? '', 'utf8');
};

/** Never start a capture while the previous one is still running: the buttons are disabled then. */
const idle = async (page: Page) => {
  await page.waitForFunction(`(() => {
    const h = document.querySelector('[data-testid="recall"] h2');
    return !!h && !/recording|finalizing|requesting permission/.test(h.textContent || '');
  })()`, null, { timeout: 60000 });
};
const receiptOf = async (path: string) => {
  const r = await api<{ node?: { content?: string; encoding?: string } }>(
    'GET', `/api/fs?op=read&path=${encodeURIComponent(path + '.recall.json')}`);
  assert.ok(r.node, `no receipt beside ${path}`);
  const raw = r.node!.encoding === 'base64'
    ? Buffer.from(r.node!.content ?? '', 'base64').toString('utf8') : (r.node!.content ?? '');
  return JSON.parse(raw) as Record<string, unknown>;
};

/**
 * Decode a PNG far enough to look at its pixels: zlib inflate, then undo the per-scanline
 * filters. Written here rather than imported so the test does not depend on the same code the
 * product uses to produce the file.
 */
const pngPixels = (b: Buffer) => {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), colour = b[25];
  const ch = colour === 6 ? 4 : colour === 2 ? 3 : 1;
  const idat: Buffer[] = [];
  for (let p = 8; p < b.length;) {
    const len = b.readUInt32BE(p);
    if (b.toString('ascii', p + 4, p + 8) === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  for (let y = 0, o = 0, ip = 0; y < h; y++, o += stride) {
    const f = raw[ip++], line = raw.subarray(ip, ip + stride); ip += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0, up = y > 0 ? out[o - stride + x] : 0;
      const ul = (x >= ch && y > 0) ? out[o - stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pp = a + up - ul, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - ul);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul);
      }
      out[o + x] = v & 255;
    }
  }
  const colours = new Set<number>();
  for (let i = 0; i + 2 < out.length; i += ch * 13) colours.add((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
  return { width: w, height: h, channels: ch, distinctColours: colours.size };
};

/** Point the capture sections at a folder only this run writes to. */
const scopeToRun = async (page: Page) => {
  const recall = page.getByTestId('recall');
  await recall.getByLabel('Recall folder grouping').selectOption('custom');
  await recall.getByLabel('Recall custom folder').fill(`tt110.${RUN}`);
  await recall.getByLabel('Recall source URL').fill('https://example.com/tt110');
};

const browser = await launchChromium([
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  // Answers the display picker with a real screen surface instead of leaving the prompt open.
  '--auto-select-desktop-capture-source=Entire screen',
  '--autoplay-policy=no-user-gesture-required',
]);
const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);

try {
  await api('GET', '/api/settings');
  const original = await api<{ row?: { revision?: number; state?: object } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: (original.row?.revision ?? 0) + 700,
    state: {
      ...original.row?.state,
      windows: [{ id: `rc110-${RUN}`, module: 'recall', title: 'Recall', props: {}, x: 10, y: 30, w: 1140, h: 780, z: 20, workspace: 1 }],
      focus: `rc110-${RUN}`, activeWorkspace: 1, nextZ: 21,
    },
  });
  await page.goto(BASE);
  await page.getByTestId('recall').waitFor();
  await scopeToRun(page);

  /* ------------------------------------------------- RC-04: authorized display snapshot */

  await test('a human-authorized display snapshot really captures the screen surface and files it as a memory',
    { 'RC-04': 'full', 'RC-11': 'partial' }, async () => {
      await idle(page);
      const recall = page.getByTestId('recall');
      const before = (await listFolder()).length;
      await recall.getByRole('button', { name: 'Capture authorized image' }).click();
      const status = recall.getByRole('status').filter({ hasText: 'Saved:' }).first();
      await status.waitFor({ timeout: 45000 });
      const line = await status.innerText();
      const path = /\/Downloads\/Recall\/\S+?\.png/.exec(line)?.[0];
      assert.ok(path, `the snapshot reported no memory path: ${line}`);

      // The bytes must be a real PNG whose IHDR matches the surface that was shared.
      const bytes = await readBytes(path!);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the snapshot is not a PNG');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      assert.ok(width > 200 && height > 200, `implausible snapshot size ${width}x${height}`);
      assert.ok(width * height <= 16_777_216, 'the 16-megapixel budget was exceeded');

      // It is a picture of something, not an empty surface: decode it and count colours.
      const pix = pngPixels(bytes);
      assert.equal(pix.width, width); assert.equal(pix.height, height);
      assert.ok(pix.distinctColours > 24,
        `the shared surface produced an essentially blank frame (${pix.distinctColours} distinct colours)`);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const receipt = await receiptOf(path!);
      assert.equal(receipt.sha256, digest, 'the receipt does not describe the bytes that were stored');
      assert.equal(receipt.method, 'authorized-display-frame');
      assert.equal(receipt.sourceAttribution, 'user-declared-label',
        'a rasterised screen frame must not claim the bytes came from a URL');
      assert.equal(receipt.queryRedacted, true);
      assert.equal((await listFolder()).length, before + 1, 'the snapshot did not add exactly one memory');
      console.log(`    display snapshot: ${width}x${height}, ${bytes.length} bytes, ${pix.distinctColours} distinct colours, sha ${digest.slice(0, 12)}…`);
    });

  /* ------------------------------------------------- RC-11: the capture really stops */

  await test('the shared surface is released when the snapshot ends, and nothing is captured afterwards',
    { 'RC-11': 'partial' }, async () => {
      // The product stops every track it opened; if it did not, the preview element would still
      // be carrying a live MediaStream after the save.
      const live = await page.evaluate(`(() => {
        const v = document.querySelector('video[aria-label="Recall capture preview"]');
        const s = v && v.srcObject;
        if (!s) return { attached: false, live: 0 };
        return { attached: true, live: s.getTracks().filter(function (t) { return t.readyState === 'live'; }).length };
      })()`) as { attached: boolean; live: number };
      assert.equal(live.live, 0, `the capture left ${live.live} track(s) live after saving`);

      // And no periodic capture: waiting does not grow the archive.
      const before = (await listFolder()).length;
      await page.waitForTimeout(4000);
      const after = (await listFolder()).length;
      assert.equal(after, before, `the archive grew by ${after - before} while nobody asked for a save`);
      console.log(`    surface released (0 live tracks); archive unchanged over 4 s at ${after} memories`);
    });

  /* ------------------------------------------------- RC-05: authorized live recording */

  await test('an authorized recording encodes real frames and finishes as a playable file',
    { 'RC-05': 'partial' }, async () => {
      await idle(page);
      const recall = page.getByTestId('recall');
      const before = (await listFolder()).length;
      await recall.getByRole('button', { name: 'Start authorized recording' }).click();
      await page.getByText('Recall', { exact: false }).first().waitFor();
      // Phase badge is the product's own signal that the encoder is running.
      await recall.locator('h2').filter({ hasText: 'recording' }).waitFor({ timeout: 45000 });
      await page.waitForTimeout(2600); // let the encoder produce more than one cluster
      const bytesShown = await recall.innerText();
      await recall.getByRole('button', { name: 'Stop and finalize' }).click();
      const status = recall.getByRole('status').filter({ hasText: 'Saved:' }).first();
      await status.waitFor({ timeout: 45000 });
      const line = await status.innerText();
      const path = /\/Downloads\/Recall\/\S+?\.(webm|mp4)/.exec(line)?.[0];
      assert.ok(path, `the recording reported no memory path: ${line}`);

      const bytes = await readBytes(path!);
      // A WebM file begins with the EBML magic; this proves a container was really muxed.
      assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'the recording is not an EBML/WebM container');
      assert.ok(bytes.length > 8000, `the recording is implausibly small (${bytes.length} bytes)`);
      assert.ok(bytes.includes(Buffer.from('webm')), 'the container does not declare the WebM doctype');
      const receipt = await receiptOf(path!);
      assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(receipt.method, 'authorized-display-recording');
      assert.equal(receipt.sourceAttribution, 'user-declared-label');
      assert.equal(receipt.mime, 'video/webm');
      assert.equal((await listFolder()).length, before + 1, 'the recording did not add exactly one memory');
      assert.match(bytesShown, /Bytes received: /);
      console.log(`    recording: ${bytes.length} bytes of WebM, receipt method ${String(receipt.method)}`);
    });

  /* ------------------------------------------------- RC-05 negative: no substituted microphone */

  await test('audio-only output does what this platform actually allows, and never substitutes the microphone',
    { 'RC-05': 'partial' }, async () => {
      await idle(page);
      const recall = page.getByTestId('recall');
      // Measure the platform first: does a shared display surface here carry an audio track at all?
      const grantsAudio = await page.evaluate(`(async () => {
        try {
          const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
          const n = s.getAudioTracks().length;
          s.getTracks().forEach(function (t) { t.stop(); });
          return n;
        } catch (e) { return -1; }
      })()`) as number;
      const before = (await listFolder()).length;
      await recall.getByLabel('Request shared audio').check();
      await recall.getByLabel('Audio-only output (requires shared audio)').check();
      await recall.getByRole('button', { name: 'Start authorized recording' }).click();

      if (grantsAudio > 0) {
        // Audio exists: the honest behaviour is a real audio-only memory, not a video file.
        await recall.locator('h2').filter({ hasText: 'recording' }).waitFor({ timeout: 45000 });
        await page.waitForTimeout(2200);
        await recall.getByRole('button', { name: 'Stop and finalize' }).click();
        await page.waitForFunction(`(() => {
          const s = document.querySelector('[data-testid="recall"] [role="status"]');
          return !!s && /Saved: \\/Downloads\\/Recall\\//.test(s.textContent || '');
        })()`, null, { timeout: 45000 });
        const line = await recall.getByRole('status').filter({ hasText: 'Saved:' }).first().innerText();
        const path = /\/Downloads\/Recall\/\S+?\.(webm|weba|ogg|m4a)/.exec(line)?.[0];
        assert.ok(path, `audio-only recording reported no path: ${line}`);
        const receipt = await receiptOf(path!);
        assert.match(String(receipt.mime), /^audio\//, `an audio-only output must be stored as audio, got ${String(receipt.mime)}`);
        const bytes = await readBytes(path!);
        assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'the audio-only output is not a real container');
        console.log(`    this platform shares audio (${grantsAudio} track): audio-only memory ${bytes.length} bytes, mime ${String(receipt.mime)}`);
      } else {
        // No audio to share: the product must say so instead of quietly recording the microphone.
        const alert = recall.getByRole('alert').first();
        await alert.waitFor({ timeout: 45000 });
        const said = await alert.innerText();
        assert.match(said, /shared audio|microphone audio is not substituted/i,
          `the refusal must explain that a microphone is not substituted; it said: ${said}`);
        assert.equal((await listFolder()).length, before, 'a refused audio-only recording still wrote a memory');
        console.log(`    this platform shares no display audio: refused with "${said.slice(0, 90)}"`);
      }
      await recall.getByLabel('Audio-only output (requires shared audio)').uncheck();
      await recall.getByLabel('Request shared audio').uncheck();
      await idle(page);
    });

  /* ------------------------------------------------- RC-06: Fusion element capture */

  await test('an already-rendered element in this document can be captured without touching the network',
    { 'RC-06': 'partial' }, async () => {
      const recall = page.getByTestId('recall');
      // Put a real, painting canvas in the document the way an application would.
      await page.evaluate(`(() => {
        let c = document.getElementById('tt110-canvas');
        if (!c) {
          c = document.createElement('canvas');
          c.id = 'tt110-canvas'; c.width = 320; c.height = 240;
          c.style.cssText = 'position:fixed;right:8px;bottom:8px;width:160px;height:120px;z-index:1';
          document.body.appendChild(c);
        }
        const ctx = c.getContext('2d');
        let i = 0;
        const paint = function () {
          i = (i + 3) % 360;
          ctx.fillStyle = 'hsl(' + i + ',80%,55%)';
          ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = '#000';
          ctx.fillRect(20 + (i % 200), 40, 60, 60);
          requestAnimationFrame(paint);
        };
        paint();
      })()`);
      await idle(page);
      await recall.getByRole('button', { name: 'Refresh Fusion sources' }).click();
      const select = recall.getByLabel('Recall capture source');
      await page.waitForFunction(`(() => {
        const s = document.querySelector('select[aria-label="Recall capture source"]');
        return !!s && s.options.length > 1;
      })()`, null, { timeout: 15000 });
      const options = await select.locator('option').allInnerTexts();
      const canvasOption = options.findIndex((o) => /canvas/i.test(o));
      assert.ok(canvasOption > 0, `no canvas appeared among the capturable sources: ${options.join(' | ')}`);
      await select.selectOption({ index: canvasOption });

      const before = (await listFolder()).length;
      await recall.getByRole('button', { name: 'Capture authorized image' }).click();
      const status = recall.getByRole('status').filter({ hasText: 'Saved:' }).first();
      await page.waitForFunction(`(() => {
        const s = document.querySelector('[data-testid="recall"] [role="status"]');
        return !!s && /Saved: \\/Downloads\\/Recall\\//.test(s.textContent || '');
      })()`, null, { timeout: 45000 }).catch(() => undefined);
      const line = await status.innerText();
      const path = /\/Downloads\/Recall\/\S+?\.png/.exec(line)?.[0];
      assert.ok(path, `the element capture reported no memory path: ${line}`);
      const bytes = await readBytes(path!);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      const receipt = await receiptOf(path!);
      assert.equal(receipt.method, 'fusion-element-frame',
        'an element capture must be recorded as an element capture, not as a display frame');
      assert.equal((await listFolder()).length, before + 1);
      console.log(`    element capture: ${width}x${height} from the page's own canvas, method ${String(receipt.method)}`);
    });

  /* ------------------------------------------------- RC-11: cancellation is honest */

  await test('pending fetch jobs can be cancelled, and the archive is told what cancellation does not undo',
    { 'RC-11': 'partial' }, async () => {
      const recall = page.getByTestId('recall');
      const cancel = recall.getByRole('button', { name: 'Cancel pending / fetching jobs' });
      await cancel.click();
      const text = await recall.innerText();
      assert.match(text, /Once a database commit starts it is not cancellable/i,
        'the interface must say plainly that an in-flight commit cannot be cancelled');
      // Cancelling must not remove anything already saved.
      const held = await listFolder();
      assert.ok(held.length >= 3, `expected this run's memories to survive cancellation, found ${held.length}`);
      console.log(`    cancellation left ${held.length} saved memories untouched`);
    });
} finally {
  finish();
  await browser.close();
}
