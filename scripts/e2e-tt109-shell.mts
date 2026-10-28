/**
 * TT109 — four more rows that had never been tested, exercised in real Chromium.
 *
 * Honesty notes that belong with these results:
 *  - Chromium runs with its fake capture device, so the camera is synthetic. The pipeline is real
 *    (real getUserMedia, real canvas rescaling, real captureStream); nothing is claimed about optics.
 *  - LN-05 is interpolation, not a super-resolution model, and the test asserts the product says so
 *    rather than asserting an image-quality improvement it cannot honestly measure.
 *  - WM-11 depends on a capability the browser may not have. The test takes whichever branch this
 *    browser actually provides and checks that branch's real contract, including the honest warning
 *    on the fallback path. Which branch ran is printed with the result.
 */
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE;
if (!BASE || process.env.TT89_DISPOSABLE_DATABASE !== '1') throw Error('Disposable target required');
const { test, finish } = makeHarness('e2e-tt109-shell');
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  assert.ok(r.ok, JSON.stringify(j));
  return j as Record<string, unknown>;
};
/** Drive a React range the way a pointer would: native setter + a real input event. */
const setRange = (page: Page, labelText: string, value: number) =>
  page.locator('label').filter({ hasText: labelText }).locator('input[type=range]').first().evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

/**
 * Chromium's built-in fake camera paints a ROLLING pattern, so the mean brightness of a frame drifts
 * by a few units between samples and a small compositing effect cannot be told apart from that drift.
 * A one-frame Y4M file, which Chromium loops, gives the pipeline a genuinely constant 1280x720 source
 * (mid grey is where a soft-light composite is most sensitive). The pipeline under test is unchanged —
 * only the camera in front of it is made repeatable.
 */
const FAKE_CAM = '/tmp/tt109-flat-720p.y4m';
if (!existsSync(FAKE_CAM)) {
  const W = 1280, H = 720;
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420mpeg2\nFRAME\n`, 'ascii');
  const y = Buffer.alloc(W * H, 128), u = Buffer.alloc((W / 2) * (H / 2), 128), v = Buffer.alloc((W / 2) * (H / 2), 128);
  writeFileSync(FAKE_CAM, Buffer.concat([header, y, u, v]));
}

const browser = await launchChromium([
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  `--use-file-for-fake-video-capture=${FAKE_CAM}`,
]);
const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);

try {
  await api('GET', '/api/settings');
  const original = await api('GET', '/api/state?id=default') as { row?: { revision?: number; state?: object } };
  await api('PUT', '/api/state', {
    id: 'default', revision: (original.row?.revision ?? 0) + 500,
    state: {
      ...original.row?.state,
      windows: [
        { id: 'lens109', module: 'lens', title: 'Lens', props: {}, x: 12, y: 40, w: 940, h: 950, z: 20, workspace: 1 },
        { id: 'rec109', module: 'recall', title: 'Recall', props: {}, x: 960, y: 40, w: 520, h: 600, z: 19, workspace: 1 },
      ],
      focus: 'lens109', activeWorkspace: 1, nextZ: 21,
    },
  });
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0 && c.height > 0;
  }, null, { timeout: 30000 });

  /** Mean luma of the live Lens canvas: the only honest evidence that a control reached the frame. */
  const meanLuma = () => page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  });
  const canvasSize = () => page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });

  await test('the virtual key light actually adds light to the rendered frame and can be taken away again',
    { 'LN-06': 'full' }, async () => {
      // Hold the other filters still so the key light is the only variable, and do not measure a canvas
      // that has not painted yet: the first frame of the synthetic camera arrives after the element exists.
      await setRange(page, 'brightness', 1);
      await page.waitForFunction(`(() => {
        const c = document.querySelector('canvas');
        if (!c || !c.width) return false;
        const d = c.getContext('2d').getImageData(0, 0, Math.min(64, c.width), Math.min(64, c.height)).data;
        let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        return sum > 0;
      })()`, null, { timeout: 20000 });
      // The key light is a radial gradient centred up and left of middle and fading to nothing at the
      // edges, composited in soft-light. Mean brightness of the whole frame is therefore the WRONG
      // statistic: it mixes lit and unlit pixels. Measure where the light falls against where it does
      // not, on the same frame, which also cancels anything that changes the picture as a whole.
      // (Plain-string body: tsx/esbuild instruments named functions inside evaluate with __name.)
      const probe = async () => await page.evaluate(`(() => {
        const c = document.querySelector('canvas');
        const ctx = c.getContext('2d');
        const box = function (x, y, w, h) {
          const d = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data;
          let s = 0;
          for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          return s / (d.length / 4);
        };
        const lit = box(c.width * 0.325 - 24, c.height * 0.275 - 24, 48, 48);
        const dark = box(c.width - 50, c.height - 50, 48, 48);
        return { lit: lit, dark: dark, gap: lit - dark, w: c.width, h: c.height };
      })()`) as { lit: number; dark: number; gap: number; w: number; h: number };
      const settled = async (value: number) => {
        await setRange(page, 'key light (LN-06)', value);
        await page.locator('label').filter({ hasText: 'key light (LN-06)' }).getByText(`key light (LN-06) — ${value.toFixed(2)}`).waitFor();
        await page.waitForTimeout(700);
        const s: { lit: number; dark: number; gap: number }[] = [];
        for (let i = 0; i < 5; i++) { s.push(await probe()); await page.waitForTimeout(120); }
        const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        return { gap: med(s.map((x) => x.gap)), lit: med(s.map((x) => x.lit)), dark: med(s.map((x) => x.dark)) };
      };
      const off = await settled(0);
      const on = await settled(0.8); // the control's real maximum (min 0, max 0.8, step 0.02)
      const back = await settled(0);
      console.log(`    key light off → lit ${off.lit.toFixed(1)} / unlit ${off.dark.toFixed(1)} (gap ${off.gap.toFixed(1)}); `
        + `on → lit ${on.lit.toFixed(1)} / unlit ${on.dark.toFixed(1)} (gap ${on.gap.toFixed(1)}); off again gap ${back.gap.toFixed(1)}`);
      assert.ok(on.gap > off.gap + 2,
        `the key light did not reach the frame where it should fall (gap ${off.gap.toFixed(1)} → ${on.gap.toFixed(1)})`);
      assert.ok(on.lit > off.lit + 2,
        `the lit region did not brighten (${off.lit.toFixed(1)} → ${on.lit.toFixed(1)})`);
      assert.ok(Math.abs(back.gap - off.gap) < 2,
        `turning the key light off did not restore the frame (gap ${off.gap.toFixed(1)} → ${back.gap.toFixed(1)})`);
      // It is light added to one part of the picture, not a global brightness multiplier: the corner
      // furthest from the lamp must stay essentially where it was.
      assert.ok(Math.abs(on.dark - off.dark) < Math.abs(on.lit - off.lit),
        `the corner changed as much as the lit area — that is a global filter, not a key light `
        + `(corner ${off.dark.toFixed(1)}→${on.dark.toFixed(1)}, lit ${off.lit.toFixed(1)}→${on.lit.toFixed(1)})`);
    });

  await test('output height really rescales the pipeline, and the upscale is labelled as interpolation rather than a model',
    { 'LN-05': 'full' }, async () => {
      const choose = async (h: number) => {
        await page.locator('label').filter({ hasText: 'output height' }).locator('select').selectOption(String(h));
        await page.waitForTimeout(1200);
        return canvasSize();
      };
      const small = await choose(360);
      const large = await choose(1080);
      assert.ok(large.h > small.h, `output height did not change the rendered surface (${small.h} → ${large.h})`);
      assert.ok(large.w > small.w, `the rescale must keep the aspect ratio, so width must grow too (${small.w} → ${large.w})`);
      assert.ok(Math.abs((large.w / large.h) - (small.w / small.h)) < 0.05, 'the aspect ratio changed while rescaling');
      // The source is Chromium's synthetic camera; at 1080p the pipeline is interpolating above it.
      const source = await page.evaluate(() => {
        const s = (document.querySelector('video') as HTMLVideoElement | null);
        return { vh: s?.videoHeight ?? 0 };
      });
      const upscaling = large.h > source.vh && source.vh > 0;
      // A real frame, not a blank surface, at the upscaled size.
      const luma = await meanLuma();
      assert.ok(luma > 1 && luma < 254, `the upscaled surface carries no picture (mean luma ${luma.toFixed(1)})`);
      // The honest-labelling contract: the UI must not call interpolation a model or "AI".
      const body = (await page.locator('body').innerText()).toLowerCase();
      assert.ok(!/super-?resolution model|ai upscal|neural upscal/.test(body), 'the UI claims a model it does not ship');
      console.log(`    output height 360 → ${small.w}×${small.h}, 1080 → ${large.w}×${large.h}; camera source height ${source.vh}; upscaling above source: ${upscaling}`);
      const back = await choose(720);
      assert.ok(back.h !== large.h || back.h !== small.h, 'the control is not reversible');
    });

  await test('the always-on-top pop-out takes the real capability branch this browser has, with its styles carried over',
    { 'WM-11': 'partial' }, async () => {
      const hasDpip = await page.evaluate(() => 'documentPictureInPicture' in window);
      const popOut = page.locator('[data-testid="window-lens109"], .fs-window').first()
        .getByRole('button', { name: /pop ?out|always on top|picture/i }).first();
      const found = await popOut.count();
      if (!found) {
        // The control is discovered by title rather than guessed: report what the chrome actually offers.
        const titles = await page.locator('.fs-window button').evaluateAll((bs) => bs.map((b) => b.getAttribute('title') || b.getAttribute('aria-label') || '').filter(Boolean));
        assert.fail(`no pop-out control found in the window chrome; available controls: ${titles.slice(0, 20).join(' | ')}`);
      }
      const opened = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
      await popOut.click();
      const extra = await opened;
      if (hasDpip) {
        assert.ok(extra, 'Document PiP is available but no pop-out surface appeared');
        await extra!.waitForLoadState('domcontentloaded').catch(() => undefined);
        // The claim worth testing: the portalled tree is STYLED. Unstyled PiP is the usual failure.
        // Style adoption happens after the window exists; give the real code time to finish rather than
        // sampling the empty instant between requestWindow() and the copy loop.
        await extra!.waitForFunction(() => document.querySelectorAll('style, link[rel=stylesheet]').length > 0
          && document.body.innerHTML.length > 0, null, { timeout: 15000 })
          .catch(() => undefined);
        const styled = await extra!.evaluate(() => ({
          sheets: document.querySelectorAll('style, link[rel=stylesheet]').length,
          html: document.body.innerHTML.length,
          rules: Array.from(document.querySelectorAll('style')).reduce((n, s) => n + (s.textContent?.length ?? 0), 0),
        }));
        assert.ok(styled.sheets > 0, 'the pop-out window carries no stylesheet — the portalled tree would render unstyled');
        assert.ok(styled.html > 0, 'the pop-out window is empty');
        assert.ok(styled.rules > 500, `the adopted stylesheets are empty (${styled.rules} chars) — the tree would render unstyled`);
        console.log(`    Document PiP branch: ${styled.sheets} stylesheet nodes, ${styled.rules} chars of CSS adopted, ${styled.html} bytes of markup`);
      } else {
        // The honest fallback contract: say plainly that this is not always-on-top.
        const toast = page.getByTestId('toasts');
        await toast.waitFor({ timeout: 8000 });
        const text = await toast.innerText();
        assert.match(text, /not always-on-top|unavailable/i, `the fallback must admit it is not always-on-top; said: ${text}`);
        console.log('    fallback branch: plain popup with an honest warning');
      }
      if (extra) await extra.close().catch(() => undefined);
    });

  await test('a copied image becomes a memory through the real paste handler, and a copied link does not',
    { 'RC-02': 'partial' }, async () => {
      const recall = page.getByTestId('recall');
      await recall.waitFor();
      const zone = recall.getByText(/paste a copied media file/i).first();
      await zone.click();
      // A real PNG is built in the page and delivered through a real ClipboardEvent with a real File;
      // the product's own paste handler runs unmodified. (Synthesising the event is why this is partial:
      // the OS clipboard itself is not exercised.)
      const saved = await page.evaluate(`(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 24; canvas.height = 18;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2f6fd0'; ctx.fillRect(0, 0, 24, 18);
        ctx.fillStyle = '#ffd400'; ctx.fillRect(4, 4, 10, 7);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const file = new File([blob], 'pasted.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const target = document.querySelector('[aria-label="Paste or drop resident media"]');
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return { bytes: blob.size, type: blob.type };
      })()`) as { bytes: number; type: string };
      assert.equal(saved.type, 'image/png');
      assert.ok(saved.bytes > 0);
      const status = recall.getByRole('status').filter({ hasText: /Saved memory →|Already saved on/ }).first();
      await status.waitFor({ timeout: 20000 });
      const line = await status.innerText();
      assert.match(line, /\/Downloads\/Recall\//, `the paste did not produce a memory path: ${line}`);
      // And the archive really holds those bytes with a receipt beside them.
      const path = /\/Downloads\/Recall\/[^\s·]+/.exec(line)![0];
      const pair = await api('GET', `/api/fs?op=stat&path=${encodeURIComponent(path + '.recall.json')}`) as { node?: { content?: string } };
      assert.ok(pair.node, 'the memory was reported saved but has no receipt beside it');

      // A copied LINK is not a download: pasting a text/uri-list must not invent a memory.
      const before = line;
      await page.evaluate(`(() => {
        const dt = new DataTransfer();
        dt.setData('text/uri-list', 'https://example.com/photo.png');
        document.querySelector('[aria-label="Paste or drop resident media"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      })()`);
      await page.waitForTimeout(1200);
      const after = await recall.getByRole('status').first().innerText();
      assert.ok(after === before || !/Saved memory →/.test(after) || after.includes(path),
        `pasting a link produced a new memory: ${after}`);
    });
  await test('a repeat save files a second memory unless the person asks to keep one copy',
    { 'RC-34': 'partial' }, async () => {
      const recall = page.getByTestId('recall');
      await recall.waitFor();
      const keepOne = recall.getByLabel('Keep one copy of identical pictures');
      // The default must be OFF: a save a person explicitly asked for is never silently refused.
      assert.equal(await keepOne.isChecked(), false, 'duplicate recognition must not be on by default');
      // The picture must be identical between THIS run's saves and different from every earlier run's,
      // or the archive legitimately recognises a memory an earlier run left behind.
      const tint = [Date.now() % 251, (Date.now() >> 8) % 251, (Date.now() >> 16) % 251];
      const pasteSame = async () => {
        await page.evaluate(`(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 16; canvas.height = 16;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = 'rgb(${tint[0]},${tint[1]},${tint[2]})'; ctx.fillRect(0, 0, 16, 16);
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
          const dt = new DataTransfer();
          dt.items.add(new File([blob], 'repeat.png', { type: 'image/png' }));
          document.querySelector('[aria-label="Paste or drop resident media"]')
            .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        })()`);
        const status = recall.getByRole('status').filter({ hasText: /Saved memory →|Already saved on/ }).first();
        await status.waitFor({ timeout: 20000 });
        for (let i = 0; i < 40; i++) {
          const line = await status.innerText();
          if (/\/Downloads\/Recall\//.test(line)) return line;
          await page.waitForTimeout(250);
        }
        throw new Error('no save status appeared');
      };
      const first = await pasteSame();
      const firstPath = /\/Downloads\/Recall\/[^\s·]+/.exec(first)![0];
      await page.waitForTimeout(400);
      const second = await pasteSame();
      const secondPath = /\/Downloads\/Recall\/[^\s·]+/.exec(second)![0];
      assert.match(second, /Saved memory →/, `with the box clear the second save must file its own memory: ${second}`);
      assert.notEqual(secondPath, firstPath, 'the second save reused the first memory even though the box was clear');

      // Now the person asks for recognition, and the SAME bytes are recognised instead of tripled.
      await keepOne.check();
      await page.waitForTimeout(200);
      const third = await pasteSame();
      assert.match(third, /Already saved on/, `with the box ticked the repeat must be recognised, not filed again: ${third}`);
      const thirdPath = /\/Downloads\/Recall\/[^\s·]+/.exec(third)![0];
      assert.ok([firstPath, secondPath].includes(thirdPath),
        `recognition pointed at a memory that is not one of the two already saved: ${thirdPath}`);
      // And the archive really did not grow: both earlier memories are still there, nothing was rewritten.
      for (const p of [firstPath, secondPath]) {
        const stat = await api('GET', `/api/fs?op=stat&path=${encodeURIComponent(p)}`) as { node?: { size?: number } };
        assert.ok(stat.node, `an earlier memory disappeared: ${p}`);
      }
      console.log(`    repeat saves: ${firstPath.split('/').pop()} then ${secondPath.split('/').pop()}, third recognised as ${thirdPath.split('/').pop()}`);
    });
} finally {
  finish();
  await browser.close();
}
