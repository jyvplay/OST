/**
 * TT108 — seven rows that had never been tested, exercised in real Chromium.
 *
 * Honesty notes that belong with these results:
 *  - Chromium is launched with its fake capture device, so the camera and
 *    microphone are synthetic. That makes the *pipeline* real (real getUserMedia,
 *    real constraint application, real AudioWorklet on the audio thread, real
 *    canvas captureStream) while saying nothing about acoustic quality on real
 *    hardware. Every claim below is phrased in terms of the pipeline only.
 *  - Where the test needs to see an object the UI keeps private, it *observes* by
 *    wrapping a platform constructor and passing the call straight through. No
 *    product behaviour is replaced and no result is synthesised.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE;
if (!BASE || process.env.TT89_DISPOSABLE_DATABASE !== '1') throw Error('Disposable target required');
const { test, finish } = makeHarness('e2e-tt108-shell');
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  assert.ok(r.ok, JSON.stringify(j));
  return j as Record<string, unknown>;
};
/** Drive a React range input the way a pointer would: native setter + real input event. */
const setRange = (page: Page, labelText: string, value: number) =>
  page.locator('label').filter({ hasText: labelText }).locator('input[type=range]').first().evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

const browser = await launchChromium([
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
]);
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.setDefaultTimeout(30000);

// Pure observation, installed before any product code runs: the real platform calls
// still execute and their real results are returned unchanged.
await page.addInitScript(() => {
  const w = window as unknown as Record<string, unknown>;
  w.__seen = { constraints: [] as unknown[], streams: [] as MediaStream[], captured: [] as MediaStream[], swMessages: [] as unknown[], gate: null as unknown };
  const seen = w.__seen as { constraints: unknown[]; streams: MediaStream[]; captured: MediaStream[]; swMessages: unknown[]; gate: unknown };
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
    const s = await gum(c); seen.constraints.push(c); seen.streams.push(s); return s;
  };
  const cap = HTMLCanvasElement.prototype.captureStream;
  if (cap) HTMLCanvasElement.prototype.captureStream = function (this: HTMLCanvasElement, fps?: number) {
    const s = cap.call(this, fps as number); seen.captured.push(s); return s;
  };
  const AWN = window.AudioWorkletNode;
  if (AWN) {
    // @ts-expect-error -- observation wrapper around the real constructor
    window.AudioWorkletNode = function (ctx: BaseAudioContext, name: string, opts?: AudioWorkletNodeOptions) {
      const node = new AWN(ctx, name, opts);
      if (name === 'fusion-gate') seen.gate = { node, ctx };
      return node;
    };
    window.AudioWorkletNode.prototype = AWN.prototype;
  }
  const spm = ServiceWorker.prototype.postMessage;
  ServiceWorker.prototype.postMessage = function (this: ServiceWorker, ...args: Parameters<typeof spm>) {
    seen.swMessages.push(args[0]);
    return spm.apply(this, args);
  };
});

try {
  await api('GET', '/api/settings');
  const original = await api('GET', '/api/state?id=default') as { row?: { revision?: number; state?: object } };
  await api('PUT', '/api/state', {
    id: 'default', revision: (original.row?.revision ?? 0) + 400,
    state: {
      ...original.row?.state,
      windows: [
        { id: 'lens108', module: 'lens', title: 'Lens', props: {}, x: 12, y: 40, w: 940, h: 950, z: 20, workspace: 1 },
        { id: 'rec108', module: 'recall', title: 'Recall', props: {}, x: 960, y: 40, w: 520, h: 600, z: 19, workspace: 1 },
      ],
      focus: 'lens108', activeWorkspace: 1, nextZ: 21,
    },
  });
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.waitForFunction(() => (window as unknown as { __seen: { streams: MediaStream[] } }).__seen.streams.length > 0, null, { timeout: 30000 });

  await test('the microphone is opened with the real WebRTC processing constraints, and the track reports them applied', { 'LN-07': 'full' }, async () => {
    const result = await page.evaluate(() => {
      const seen = (window as unknown as { __seen: { constraints: MediaStreamConstraints[]; streams: MediaStream[] } }).__seen;
      const audio = seen.constraints[0]?.audio as Record<string, unknown> | undefined;
      const track = seen.streams[0]?.getAudioTracks()[0];
      return { requested: audio, settings: track?.getSettings() as Record<string, unknown> | undefined, live: track?.readyState, label: track?.label };
    });
    assert.deepEqual(result.requested, { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      'Lens did not ask for the three WebRTC audio-processing paths');
    assert.equal(result.live, 'live', 'no live audio track was produced');
    for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
      assert.ok(key in (result.settings ?? {}), `the track does not report ${key} at all`);
      assert.equal(result.settings![key], true, `${key} was requested but the applied settings say ${String(result.settings![key])}`);
    }
  });

  await test('the voice gate really runs on the audio thread and silences a signal below its threshold', { 'LN-08': 'full' }, async () => {
    const gatePresent = await page.evaluate(() => {
      const g = (window as unknown as { __seen: { gate: { node: AudioWorkletNode; ctx: BaseAudioContext } | null } }).__seen.gate;
      return g ? { params: [...g.node.parameters.keys()], state: g.ctx.state, rate: g.ctx.sampleRate } : null;
    });
    assert.ok(gatePresent, 'Lens did not create its fusion-gate AudioWorkletNode (it fell back to the raw track)');
    assert.ok(gatePresent.params.includes('threshold'), 'the gate exposes no threshold parameter');

    // Feed the product's own worklet processor a known tone and measure what comes out.
    // Passed as source text on purpose: the TypeScript transform injects helper
    // symbols into compiled closures that do not exist inside the page.
    const measured = await page.evaluate(`(async () => {
      const g = window.__seen.gate, ctx = g.ctx;
      await ctx.resume();
      const node = new AudioWorkletNode(ctx, 'fusion-gate');
      const osc = ctx.createOscillator(); osc.frequency.value = 440;
      const amp = ctx.createGain(); amp.gain.value = 0.2;
      const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      const mute = ctx.createGain(); mute.gain.value = 0;
      osc.connect(amp).connect(node).connect(analyser).connect(mute).connect(ctx.destination);
      osc.start();
      node.parameters.get('threshold').value = 0.01;
      await new Promise(r => setTimeout(r, 700));
      const a = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(a);
      let sa = 0; for (let i = 0; i < a.length; i++) sa += a[i] * a[i];
      const open = Math.sqrt(sa / a.length);
      node.parameters.get('threshold').value = 0.9;
      await new Promise(r => setTimeout(r, 1500));
      const b = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(b);
      let sb = 0; for (let i = 0; i < b.length; i++) sb += b[i] * b[i];
      const closed = Math.sqrt(sb / b.length);
      osc.stop(); node.disconnect();
      return { open, closed };
    })()`) as { open: number; closed: number };
    assert.ok(measured.open > 0.05, `the gate did not pass audio when open (RMS ${measured.open.toFixed(4)})`);
    assert.ok(measured.closed < measured.open / 10, `the gate did not attenuate below threshold (open ${measured.open.toFixed(4)} → closed ${measured.closed.toFixed(4)})`);
  });

  await test('the colour and light chain changes the rendered frame, not just a label', { 'LN-04': 'full' }, async () => {
    const meanLuma = () => page.locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
      const ctx = c.getContext('2d')!;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4);
    });
    await page.waitForFunction(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null;
      return !!c && c.width > 0 && c.height > 0;
    }, null, { timeout: 20000 });
    // The governor rescales the canvas while the feed settles, so each reading is the
    // median of three samples taken after the slider's own label confirms the state.
    const settled = async (value: number) => {
      await setRange(page, 'brightness', value);
      await page.locator('label').filter({ hasText: 'brightness' }).getByText(`brightness — ${value}`).waitFor();
      await page.waitForTimeout(900);
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) { samples.push(await meanLuma()); await page.waitForTimeout(150); }
      return samples.sort((a, b) => a - b)[1];
    };
    const dark = await settled(0.5);
    const bright = await settled(1.8);
    assert.ok(bright > dark + 25, `the brightness filter did not change the frame (dark ${dark.toFixed(1)} → bright ${bright.toFixed(1)})`);
    const back = await settled(0.5);
    assert.ok(Math.abs(back - dark) < 25, `the filter did not return to its earlier appearance (${dark.toFixed(1)} → ${back.toFixed(1)})`);
    // the canvas is readable, i.e. the pipeline did not taint it with a cross-origin source
    assert.ok(dark >= 0 && bright <= 255);
  });

  await test('a canvas-backed window really is a live video source', { 'WM-15': 'partial' }, async () => {
    const frames = await page.evaluate(`(async () => {
      const stream = window.__seen.captured[0];
      if (!stream) return { error: 'the window published no captureStream' };
      const track = stream.getVideoTracks()[0];
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      v.style.position = 'fixed'; v.style.left = '-9999px'; v.style.width = '160px';
      document.body.appendChild(v);
      await v.play();
      const probe = document.createElement('canvas');
      const snap = function () {
        probe.width = v.videoWidth || 2; probe.height = v.videoHeight || 2;
        const c = probe.getContext('2d'); c.drawImage(v, 0, 0, probe.width, probe.height);
        const d = c.getImageData(0, 0, probe.width, probe.height).data;
        let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
        return h;
      };
      await new Promise(r => setTimeout(r, 300));
      const t0 = v.currentTime, h0 = snap();
      await new Promise(r => setTimeout(r, 900));
      const t1 = v.currentTime, h1 = snap();
      const settings = track.getSettings();
      v.pause(); v.srcObject = null; v.remove();
      return { advanced: t1 - t0, changed: h0 !== h1, state: track.readyState,
               width: settings.width, height: settings.height, audio: stream.getAudioTracks().length };
    })()`) as { error?: string; advanced: number; changed: boolean; state: string; width?: number; height?: number; audio: number };
    assert.ok(!('error' in frames), (frames as { error?: string }).error);
    const f = frames;
    assert.equal(f.state, 'live');
    assert.ok(f.advanced > 0.1, `the published window stream did not advance in 900 ms (${f.advanced?.toFixed(3)}s)`);
    assert.ok(f.changed, 'two samples 900 ms apart were pixel-identical, so the stream is a still image, not a live window');
    assert.ok((f.width ?? 0) > 0 && (f.height ?? 0) > 0, 'the published stream has no frame size');
    assert.ok(f.audio >= 1, 'the window stream carries no audio track');
  });

  await test('the shell never takes a service-worker update without being asked', { 'AP-04': 'partial' }, async () => {
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const seen = (window as unknown as { __seen: { swMessages: unknown[] } }).__seen;
      return { registered: !!reg, waiting: !!reg?.waiting, messages: seen.swMessages, controller: !!navigator.serviceWorker.controller };
    });
    assert.equal(state.registered, true, 'no service worker is registered, so update management cannot exist');
    assert.deepEqual(state.messages, [], 'the shell sent a service-worker message without a human asking: ' + JSON.stringify(state.messages));
    assert.equal(state.waiting, false, 'a waiting worker was left unoffered');
  });

  await test('choosing a file opens the real platform picker rather than an in-page imitation', { 'DP-12': 'partial' }, async () => {
    const recall = page.getByTestId('recall');
    const input = recall.getByLabel('Choose resident media');
    const shape = await input.evaluate((el: HTMLInputElement) => ({ tag: el.tagName, type: el.type, accept: el.accept, multiple: el.multiple }));
    assert.deepEqual(shape, { tag: 'INPUT', type: 'file', accept: 'image/*,video/*,audio/*', multiple: false });
    const chooser = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), input.click()]);
    assert.equal(chooser[0].isMultiple(), false, 'the platform picker was opened in multi-select mode');
    await page.keyboard.press('Escape');
  });

  await test('every control of a window is reachable by keyboard alone, with no focus trap', { 'DP-06': 'partial' }, async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const seenFocus: string[] = [];
    let repeats = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      // Identity must include the element's position: seven unlabelled sliders would
      // otherwise look like one control focused seven times, i.e. a phantom trap.
      const here = await page.evaluate(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'body';
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('type') || '').trim().slice(0, 24);
        return el.tagName + ':' + label + '@' + Math.round(r.x) + ',' + Math.round(r.y);
      })()`) as string;
      if (seenFocus.length && here === seenFocus[seenFocus.length - 1]) repeats++;
      seenFocus.push(here);
    }
    const distinct = new Set(seenFocus.filter((f) => f !== 'body'));
    assert.ok(distinct.size >= 10, `only ${distinct.size} distinct controls were reachable by Tab: ${[...distinct].slice(0, 8).join(', ')}`);
    assert.ok(repeats <= 1, `focus stuck on the same control ${repeats} times — that is a focus trap`);
    assert.ok(seenFocus.some((f) => f.startsWith('BUTTON')), 'no button was reachable by keyboard');
    assert.ok(seenFocus.some((f) => f.startsWith('INPUT')), 'no input was reachable by keyboard');
    // and focus can come back the other way
    const forward = await page.evaluate(() => (document.activeElement as HTMLElement)?.outerHTML.slice(0, 60) ?? '');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const returned = await page.evaluate(() => (document.activeElement as HTMLElement)?.outerHTML.slice(0, 60) ?? '');
    assert.equal(returned, forward, 'Shift+Tab then Tab did not return to the same control');
  });
} finally {
  await browser.close();
}
finish();
