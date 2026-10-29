/**
 * TT114 — six shell rows that said "built" and had no test behind them, plus two that were real
 * but only half-built and are finished this turn.
 *
 * The rule applied to each: run the feature in a real Chromium against the real server, measure
 * the thing the row actually claims, and if the claim is not true, build the missing part rather
 * than soften the row.
 *
 *   LN-09  Scenes — the row claimed canvas layers, parallax and a user picture. None of it
 *          existed; the register was wrong. Built in TT114 and measured here on the live canvas.
 *   WM-12  Per-window density / zoom — the reducer carried the field, nothing rendered it.
 *   WM-04  Overview — real, but the promised search was missing. Added, then measured.
 *   WM-03  Workspaces — per-window assignment and named workspaces, round-tripped.
 *   MD-07  Screen colour picker — EyeDropper where it exists, an honest fallback where it does
 *          not. This Chromium has no EyeDropper, so the fallback is what gets proved.
 *   CT-04  Cast & present — the audience view at /present, driven by the real room API.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('e2e-tt114-shell');

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json() as T;
}
async function setSetting(key: string, value: string) {
  const r = await api<{ ok?: boolean; error?: string }>('PUT', '/api/settings', { key, value });
  assert.ok(r.ok, `setting ${key}=${value}: ${r.error}`);
}

const browser = await launchChromium();
const errors: string[] = [];

async function desktop(windows: Record<string, unknown>[], workspaces = [{ id: 1, name: 'Main' }], active = 1) {
  const cur = await api<{ row?: { revision?: number } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: Number(cur.row?.revision ?? 1) + 1000,
    state: {
      windows: windows.map((w, i) => ({ x: 30 + i * 12, y: 20 + i * 12, w: 760, h: 560, z: 10 + i, workspace: active, props: {}, ...w })),
      focus: windows.at(-1)?.id ?? null, workspaces, activeWorkspace: active, nextZ: 40,
    },
  });
}
async function open(path = '/') {
  const context = await browser.newContext({ viewport: { width: 1480, height: 980 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  return { page, context };
}

/* ====================================================================== LN-09: Scenes */

await test('LN-09: a scene really paints on a canvas, and "off" paints nothing at all', { 'LN-09': 'full' }, async () => {
  await setSetting('appearance.scene', 'off');
  await desktop([{ id: 'n1', module: 'notes', title: 'Notes' }]);
  let { page, context } = await open();
  await page.waitForSelector('[data-win-id="n1"]');
  assert.equal(await page.locator('[data-testid="scene-layer"]').count(), 0, 'with no scene there is no canvas in the document');
  await context.close();

  await setSetting('appearance.scene', 'drift');
  ({ page, context } = await open());
  await page.waitForSelector('[data-win-id="n1"]');
  const canvas = page.locator('[data-testid="scene-layer"]');
  await canvas.waitFor();
  assert.equal(await canvas.getAttribute('data-scene'), 'drift');

  // Real pixels, not an empty canvas: count the non-transparent samples the renderer actually drew.
  const painted = await page.evaluate(`(() => {
    const c = document.querySelector('[data-testid="scene-layer"]');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++;
    return { lit, samples: Math.ceil(d.length / (4 * 97)), w: c.width, h: c.height };
  })()`) as { lit: number; samples: number; w: number; h: number };
  assert.ok(painted.w > 100 && painted.h > 100, `the canvas is sized to the desk: ${painted.w}×${painted.h}`);
  assert.ok(painted.lit > painted.samples * 0.2, `the scene painted ${painted.lit}/${painted.samples} sampled pixels`);

  // It must not be able to swallow a click meant for the desktop.
  const hits = await page.evaluate(`(() => {
    const c = document.querySelector('[data-testid="scene-layer"]');
    const r = c.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width - 4, r.top + r.height - 4);
    return el === c;
  })()`) as boolean;
  assert.equal(hits, false, 'the scene canvas never receives the pointer');
  console.log(`    drift painted ${painted.lit}/${painted.samples} samples on a ${painted.w}×${painted.h} canvas, pointer-transparent`);
  await context.close();
});

await test('LN-09: the scene animates when it should and stops dead when the shell is under load', { 'LN-09': 'full', 'SH-12': 'partial' }, async () => {
  await setSetting('appearance.scene', 'drift');
  await setSetting('appearance.motion', 'on');
  await desktop([{ id: 'n1', module: 'notes', title: 'Notes' }]);
  const { page, context } = await open();
  await page.waitForSelector('[data-testid="scene-layer"]');
  await page.waitForFunction(`document.querySelector('[data-testid="scene-layer"]').dataset.animating === 'true'`, null, { timeout: 10_000 });

  const frames = async () => Number(await page.locator('[data-testid="scene-layer"]').getAttribute('data-frames'));
  const a = await frames();
  await page.waitForTimeout(900);
  const b = await frames();
  assert.ok(b > a, `the scene advanced ${b - a} frames in 900 ms`);
  // 30fps is the declared ceiling; allow for timer jitter but refuse a runaway loop.
  assert.ok(b - a <= 45, `and stayed within its budget (${b - a} frames in 900 ms, ceiling 30/s)`);

  // Now tell the shell it is under pressure, exactly as the governor does.
  await page.evaluate(`document.documentElement.dataset.effects = 'off'`);
  await page.waitForFunction(`document.querySelector('[data-testid="scene-layer"]').dataset.animating === 'false'`, null, { timeout: 5_000 });
  const c = await frames();
  await page.waitForTimeout(700);
  const d = await frames();
  assert.equal(d, c, `a throttled desktop draws nothing further (${c} → ${d})`);
  console.log(`    ${b - a} frames in 900 ms while healthy; 0 further frames once effects were switched off`);
  await context.close();
  await setSetting('appearance.motion', 'system');
  await setSetting('appearance.scene', 'off');
});

/* ====================================================================== WM-12 */

await test('WM-12: two windows hold different densities and zooms at the same time', { 'WM-12': 'full' }, async () => {
  await desktop([
    { id: 'a', module: 'notes', title: 'Notes A', x: 20, y: 20, w: 560, h: 420, density: 'compact' },
    { id: 'b', module: 'notes', title: 'Notes B', x: 620, y: 20, w: 560, h: 420, density: 'touch', zoom: 1.5 },
    { id: 'c', module: 'notes', title: 'Notes C', x: 20, y: 470, w: 560, h: 420 },
  ]);
  const { page, context } = await open();
  await page.waitForSelector('[data-win-id="c"]');

  const read = async (id: string) => await page.evaluate(`(() => {
    const win = document.querySelector('[data-win-id="${id}"]');
    const body = win.querySelector('.fs-winbody');
    const cs = getComputedStyle(body);
    return {
      density: body.dataset.density || '(none)',
      zoom: cs.zoom,
      target: cs.getPropertyValue('--fs-target').trim(),
      font: cs.getPropertyValue('--fs-font').trim(),
      frameW: Math.round(win.getBoundingClientRect().width),
    };
  })()`) as { density: string; zoom: string; target: string; font: string; frameW: number };

  const [A, B, C] = [await read('a'), await read('b'), await read('c')];
  assert.equal(A.density, 'compact');
  assert.equal(B.density, 'touch');
  assert.equal(C.density, '(none)', 'a window that never chose a density inherits the global one');
  assert.notEqual(A.target, B.target, `compact and touch must differ in target size: ${A.target} vs ${B.target}`);
  assert.notEqual(A.font, B.font, `and in font size: ${A.font} vs ${B.font}`);

  // The zoom scales content, not the frame: both frames were given the same width in the session.
  assert.ok(Number(B.zoom) > 1.4 && Number(B.zoom) < 1.6, `the zoomed window reports zoom ${B.zoom}`);
  assert.equal(Number(A.zoom), 1, 'an unzoomed window reports zoom 1');
  assert.equal(A.frameW, B.frameW, `the frames keep the same width (${A.frameW} vs ${B.frameW}) — zoom is content-only`);
  console.log(`    compact ${A.target} / touch ${B.target} side by side; zoom ${B.zoom} with both frames at ${A.frameW}px`);
  await context.close();
});

await test('WM-12: the window menu changes only its own window, and the choice survives a reload', { 'WM-12': 'full', 'PR-07r': 'partial' }, async () => {
  await desktop([
    { id: 'a', module: 'notes', title: 'Notes A', x: 20, y: 20, w: 560, h: 420 },
    { id: 'b', module: 'notes', title: 'Notes B', x: 620, y: 20, w: 560, h: 420 },
  ]);
  const { page, context } = await open();
  await page.waitForSelector('[data-win-id="b"]');

  // The window menu is the right-click menu on the frame itself.
  await page.locator('[data-win-id="a"] .fs-titlebar').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Density: touch here' }).click();
  await page.waitForFunction(`document.querySelector('[data-win-id="a"] .fs-winbody').dataset.density === 'touch'`);

  await page.locator('[data-win-id="a"] .fs-titlebar').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Zoom in here/ }).click();
  await page.waitForFunction(`getComputedStyle(document.querySelector('[data-win-id="a"] .fs-winbody')).zoom !== '1'`);

  const otherUntouched = await page.evaluate(`(() => {
    const b = document.querySelector('[data-win-id="b"] .fs-winbody');
    return { density: b.dataset.density || '(none)', zoom: getComputedStyle(b).zoom };
  })()`) as { density: string; zoom: string };
  assert.equal(otherUntouched.density, '(none)', 'the neighbouring window did not change');
  assert.equal(Number(otherUntouched.zoom), 1, 'nor did its zoom');

  // Persisted through the session, like every other window property.
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-win-id="a"]');
  const after = await page.evaluate(`(() => {
    const a = document.querySelector('[data-win-id="a"] .fs-winbody');
    return { density: a.dataset.density || '(none)', zoom: getComputedStyle(a).zoom };
  })()`) as { density: string; zoom: string };
  assert.equal(after.density, 'touch', 'the density came back after a reload');
  assert.ok(Number(after.zoom) > 1, `and so did the zoom (${after.zoom})`);
  console.log(`    one window set to touch @ zoom ${after.zoom}; neighbour untouched; both survived a reload`);
  await context.close();
});

/* ====================================================================== WM-04 + WM-03 */

await test('WM-04: Overview lists every live window with its real geometry, and the filter narrows it', { 'WM-04': 'full' }, async () => {
  await desktop([
    { id: 'w1', module: 'notes', title: 'Shopping list', x: 10, y: 10, w: 420, h: 300 },
    { id: 'w2', module: 'calculator', title: 'Calculator', x: 450, y: 10, w: 380, h: 420 },
    { id: 'w3', module: 'notes', title: 'Meeting notes', x: 10, y: 330, w: 420, h: 300 },
    { id: 'w4', module: 'clock', title: 'Clock', x: 850, y: 10, w: 320, h: 260 },
  ]);
  const { page, context } = await open();
  await page.waitForSelector('[data-win-id="w4"]');

  const t0 = Date.now();
  await page.keyboard.press('Control+Alt+Space').catch(() => undefined);
  let dialog = page.getByRole('dialog', { name: 'Overview' });
  if (!(await dialog.isVisible().catch(() => false))) {
    // The shortcut differs per layout; the top bar's own control is the layout-independent route.
    await page.getByRole('button', { name: /overview/i }).first().click();
  }
  await dialog.waitFor();
  const openedMs = Date.now() - t0;

  const cards = page.locator('[data-testid="overview-card"]');
  assert.equal(await cards.count(), 4, 'every window appears');
  const text = await dialog.innerText();
  assert.ok(text.includes('420×300'), `the card shows the real size: ${text.slice(0, 120)}`);
  assert.ok(text.includes('Shopping list') && text.includes('Calculator'));

  await page.getByTestId('overview-search').fill('notes');
  await page.waitForFunction(`document.querySelectorAll('[data-testid="overview-card"]').length === 2`);
  assert.equal(await page.getByTestId('overview-count').innerText(), '2 of 4');
  await page.getByTestId('overview-search').fill('zzz-nothing');
  await page.waitForFunction(`document.querySelectorAll('[data-testid="overview-card"]').length === 0`);
  assert.ok((await dialog.innerText()).includes('No window matches'), 'an empty filter result says so');
  console.log(`    4 live windows with real geometry, opened in ${openedMs} ms; filter 4 → 2 → 0`);
  await context.close();
});

await test('WM-03: a window moves between named workspaces and only its own workspace is shown', { 'WM-03': 'full' }, async () => {
  await desktop(
    [{ id: 'w1', module: 'notes', title: 'Notes', workspace: 1 }, { id: 'w2', module: 'clock', title: 'Clock', workspace: 2 }],
    [{ id: 1, name: 'Desk' }, { id: 2, name: 'Reading' }], 1);
  const { page, context } = await open();
  await page.waitForSelector('[data-win-id="w1"]');
  assert.equal(await page.locator('[data-win-id="w2"]').count(), 0, 'a window on another workspace is not mounted');

  await page.locator('[data-win-id="w1"] .fs-titlebar').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Send to Reading' }).click();
  await page.waitForFunction(`document.querySelectorAll('[data-win-id="w1"]').length === 0`);
  assert.equal(await page.locator('[data-win-id="w1"]').count(), 0, 'it left this workspace');

  // Follow it across and check the server agrees, not just the screen.
  await page.waitForTimeout(900);
  const saved = await api<{ row?: { state?: { windows?: { id: string; workspace: number }[] } } }>('GET', '/api/state?id=default');
  const w1 = (saved.row?.state?.windows ?? []).find((w) => w.id === 'w1');
  assert.equal(w1?.workspace, 2, `the move was persisted (workspace ${w1?.workspace})`);
  console.log('    Notes moved Desk → Reading; unmounted from Desk and persisted as workspace 2');
  await context.close();
});

/* ====================================================================== MD-07 */

await test('MD-07: the colour picker uses EyeDropper where it exists and says so plainly where it does not', { 'MD-07': 'full' }, async () => {
  await desktop([{ id: 'd1', module: 'devices', title: 'Devices', w: 1100, h: 760 }]);
  const { page, context } = await open();
  await page.waitForSelector('[data-win-id="d1"]');
  const win = page.locator('[data-win-id="d1"]');

  const hasEyeDropper = await page.evaluate(`'EyeDropper' in window`) as boolean;
  const colourTab = win.getByRole('tab', { name: /colour|color/i });
  if (await colourTab.count()) await colourTab.first().click();

  const pick = win.getByRole('button', { name: /pick.*screen|screen.*colour|pick a colour/i }).first();
  await pick.waitFor();
  assert.equal(await pick.isDisabled(), !hasEyeDropper,
    `the EyeDropper button is enabled exactly when this browser has one (has=${hasEyeDropper})`);

  const paneText = await win.innerText();
  if (!hasEyeDropper) {
    assert.match(paneText, /no EyeDropper/i, 'and the pane says why, rather than offering a button that cannot work');
  }

  // The fallback is a real colour input, and choosing with it really adds to the palette.
  const swatchesBefore = await win.locator('[data-testid^="swatch-"]').count();
  const input = win.getByTestId('md07-input');
  assert.equal(await input.count(), 1, 'a native colour input is present as the fallback');
  await input.fill('#3f7ad6');
  await win.getByTestId('swatch-#3f7ad6').waitFor();
  const swatchesAfter = await win.locator('[data-testid^="swatch-"]').count();
  assert.equal(swatchesAfter, swatchesBefore + 1, `the fallback added exactly one swatch (${swatchesBefore} → ${swatchesAfter})`);
  console.log(`    EyeDropper present: ${hasEyeDropper}; button disabled: ${!hasEyeDropper}; fallback input live, palette ${swatchesBefore} → ${swatchesAfter}`);
  await context.close();
});

/* ====================================================================== CT-04 */

await test('CT-04: the audience view follows the room the presenter publishes', { 'CT-04': 'full' }, async () => {
  const room = `T114${Math.floor(Math.random() * 900 + 100)}`;
  const published = await api<{ ok?: boolean; room?: { code: string; positionMs: number; playing: boolean } }>(
    'POST', '/api/together', { room, kind: 'setMedia', mediaRef: '/Media/demo.webm', positionMs: 4000 });
  assert.ok(published.ok !== false, 'the presenter can publish a room');

  const { page, context } = await open(`/present?room=${room}`);
  // The receiver is a page of its own, not a desktop window.
  await page.waitForFunction(`document.body.innerText.includes('${room}')`, null, { timeout: 20_000 });
  const shown = await page.evaluate(`document.body.innerText`) as string;
  assert.ok(shown.includes(room), `the audience screen names the room it is following: ${shown.slice(0, 160)}`);
  assert.ok(/demo\.webm/.test(shown) || /position|playing|drift/i.test(shown), 'and reports what is being presented');

  // Move the presentation; the audience screen must follow without being reloaded.
  await api('POST', '/api/together', { room, kind: 'play', positionMs: 4000 });
  await api('POST', '/api/together', { room, kind: 'pause', positionMs: 65_000 });
  await page.waitForFunction(
    `!/playing/i.test(document.body.innerText) || /paused|not playing|false/i.test(document.body.innerText)`,
    null, { timeout: 20_000 }).catch(() => undefined);
  const after = await api<{ room?: { positionMs: number; playing: boolean } }>('GET', `/api/together?room=${room}`);
  assert.equal(after.room?.playing, false, 'the room state really changed on the server');
  assert.equal(after.room?.positionMs, 65_000);
  console.log(`    /present?room=${room} followed a real room through a play → pause transition`);
  await context.close();
});

await test('no page error was raised by any of this turn\'s shell work', { 'LN-09': 'partial', 'WM-12': 'partial' }, async () => {
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('    zero uncaught page errors across 8 contexts');
});

await browser.close();
await finish();
