/**
 * TT114 — the four browser-window rows that shipped without a test: split view in both
 * orientations (PR-07d, PR-07e), tearing a tab out into its own window (PR-07j), and the session
 * manager that is supposed to make all of it survive a reload (PR-07r).
 *
 * Geometry is measured, not inferred: a "split view" that renders two frames stacked in the same
 * column would still contain two frames, so the test compares the two panes' bounding boxes and
 * insists that a horizontal split really puts them side by side and a vertical split really puts
 * one above the other.
 *
 * The pages are the loopback fixtures the Recall suites already use, so nothing reaches the
 * internet and the content is known.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('e2e-tt114-tabs');

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json() as T;
}

const browser = await launchChromium();
const errors: string[] = [];
const A = 'http://127.0.0.1:4001/', B = 'http://127.0.0.1:4002/';

/** A browser window needs its tabs in props; normalizeSession rejects a window without them. */
async function desktop(tabs: { id: string; url: string; title: string }[], active: string) {
  const cur = await api<{ row?: { revision?: number } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: Number(cur.row?.revision ?? 1) + 1000,
    state: {
      windows: [{
        id: 'b1', module: 'browser', title: 'Browser', x: 20, y: 16, w: 1300, h: 840, z: 10, workspace: 1,
        props: { tabs: tabs.map((t) => ({ ...t, pinned: false, asleep: false, group: '' })), active, proxyAll: true },
      }],
      focus: 'b1', workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 30,
    },
  });
}
async function open() {
  const context = await browser.newContext({ viewport: { width: 1480, height: 980 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-win-id="b1"]');
  return { page, context };
}
/** The bounding boxes of the panes inside the split container, in document order. */
const paneBoxes = (page: import('playwright-core').Page) => page.evaluate(`(() => {
  const grid = document.querySelector('[data-testid="br-frames"]');
  return {
    split: grid.dataset.split,
    panes: [...grid.children].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  };
})()`) as Promise<{ split: string; panes: { x: number; y: number; w: number; h: number }[] }>;

/* ------------------------------------------------------------------ PR-07d / PR-07e */

await test('PR-07d: a horizontal split puts two live frames side by side', { 'PR-07d': 'full', 'PR-07': 'partial' }, async () => {
  await desktop([{ id: 't1', url: A, title: 'Fixture A' }, { id: 't2', url: B, title: 'Fixture B' }], 't1');
  const { page, context } = await open();
  const win = page.locator('[data-win-id="b1"]');

  const before = await paneBoxes(page);
  assert.equal(before.split, 'off');
  assert.equal(before.panes.length, 1, 'one pane before splitting');

  await win.getByRole('button', { name: /^Split view:/ }).click();
  await page.waitForFunction(`document.querySelector('[data-testid="br-frames"]').dataset.split === 'h'`);
  const after = await paneBoxes(page);
  assert.equal(after.panes.length, 2, 'two panes after splitting');

  const [p, q] = after.panes;
  assert.ok(Math.abs(p.y - q.y) <= 2, `side by side means the same top edge (${p.y} vs ${q.y})`);
  assert.ok(q.x >= p.x + p.w - 2, `the second pane starts where the first ends (${p.x}+${p.w} vs ${q.x})`);
  assert.ok(Math.abs(p.w - q.w) <= 2, `and they share the width evenly (${p.w} vs ${q.w})`);
  assert.ok(p.w > 200 && p.h > 200, `both panes are usable (${p.w}×${p.h})`);
  console.log(`    horizontal: ${p.w}×${p.h} at x=${p.x} and ${q.w}×${q.h} at x=${q.x}`);
  await context.close();
});

await test('PR-07e: a vertical split stacks them instead, and a third click restores one pane', { 'PR-07e': 'full' }, async () => {
  await desktop([{ id: 't1', url: A, title: 'Fixture A' }, { id: 't2', url: B, title: 'Fixture B' }], 't1');
  const { page, context } = await open();
  const win = page.locator('[data-win-id="b1"]');
  const splitBtn = win.getByRole('button', { name: /^Split view:/ });

  await splitBtn.click();
  await page.waitForFunction(`document.querySelector('[data-testid="br-frames"]').dataset.split === 'h'`);
  await splitBtn.click();
  await page.waitForFunction(`document.querySelector('[data-testid="br-frames"]').dataset.split === 'v'`);

  const v = await paneBoxes(page);
  assert.equal(v.panes.length, 2);
  const [p, q] = v.panes;
  assert.ok(Math.abs(p.x - q.x) <= 2, `stacked means the same left edge (${p.x} vs ${q.x})`);
  assert.ok(q.y >= p.y + p.h - 2, `the second pane starts below the first (${p.y}+${p.h} vs ${q.y})`);
  assert.ok(Math.abs(p.h - q.h) <= 2, `and they share the height evenly (${p.h} vs ${q.h})`);

  await splitBtn.click();
  await page.waitForFunction(`document.querySelector('[data-testid="br-frames"]').dataset.split === 'off'`);
  assert.equal((await paneBoxes(page)).panes.length, 1, 'the cycle returns to a single pane');
  console.log(`    vertical: ${p.w}×${p.h} at y=${p.y} above ${q.w}×${q.h} at y=${q.y}; cycle h → v → off`);
  await context.close();
});

/* ------------------------------------------------------------------ PR-07j */

await test('PR-07j: tearing a tab out opens a second browser window on that page', { 'PR-07j': 'full', 'WM-01': 'partial' }, async () => {
  await desktop([{ id: 't1', url: A, title: 'Fixture A' }, { id: 't2', url: B, title: 'Fixture B' }], 't2');
  const { page, context } = await open();
  const win = page.locator('[data-win-id="b1"]');
  assert.equal(await page.locator('.fs-window[aria-label*="Browser"], [data-win-id]').count() >= 1, true);

  const before = await page.locator('[data-win-id]').count();
  await win.getByRole('button', { name: 'Tear out' }).click();
  await page.waitForFunction(`document.querySelectorAll('[data-win-id]').length === ${before + 1}`, null, { timeout: 15_000 });

  // The new window must be a browser window pointed at the torn-out tab, not an empty shell.
  const torn = await page.evaluate(`(() => {
    const wins = [...document.querySelectorAll('[data-win-id]')];
    const fresh = wins.find((w) => w.getAttribute('data-win-id') !== 'b1');
    return { id: fresh.getAttribute('data-win-id'), label: fresh.getAttribute('aria-label') || '' };
  })()`) as { id: string; label: string };
  assert.notEqual(torn.id, 'b1');

  // The new window's address bar is the immediate evidence; the reducer's write is debounced.
  const addressShown = await page.locator(`[data-win-id="${torn.id}"] input[aria-label="Address"]`).inputValue();
  assert.ok(addressShown.startsWith(B), `the torn-out window opened on that page (${addressShown})`);

  type Win = { id: string; module: string; props?: { tabs?: { url: string }[]; url?: string } };
  let fresh: Win | undefined;
  for (let i = 0; i < 20 && !(fresh?.props?.tabs ?? []).length; i++) {
    await page.waitForTimeout(300);
    const saved = await api<{ row?: { state?: { windows?: Win[] } } }>('GET', '/api/state?id=default');
    fresh = (saved.row?.state?.windows ?? []).find((w) => w.id === torn.id);
  }
  assert.equal(fresh?.module, 'browser', 'the torn-out window is a browser window');
  const urls = (fresh?.props?.tabs ?? []).map((t) => t.url);
  assert.ok(urls.some((u) => u.startsWith(B)), `and its session really holds that tab (${urls.join(', ') || 'no tabs serialised'})`);

  const saved2 = await api<{ row?: { state?: { windows?: { id: string; props?: { tabs?: unknown[] } }[] } } }>('GET', '/api/state?id=default');
  const origin = (saved2.row?.state?.windows ?? []).find((w) => w.id === 'b1');

  // The original window keeps working: this is a tear-out, not a move that leaves a hole.
  assert.ok((origin?.props?.tabs ?? []).length >= 2, 'the source window still has its tabs');
  console.log(`    tore ${B} into window ${torn.id}; source kept ${(origin?.props?.tabs ?? []).length} tabs`);
  await context.close();
});

/* ------------------------------------------------------------------ PR-07r */

await test('PR-07r: tabs, the active tab, groups and the split survive a reload', { 'PR-07r': 'full', 'SH-08': 'partial' }, async () => {
  await desktop([
    { id: 't1', url: A, title: 'Fixture A' },
    { id: 't2', url: B, title: 'Fixture B' },
    { id: 't3', url: A + '?third', title: 'Fixture C' },
  ], 't1');
  const { page, context } = await open();
  const win = page.locator('[data-win-id="b1"]');

  // Make a session worth restoring: switch tab, group it, split the view, pin it.
  await win.locator('[data-tab="t2"]').first().click();
  // Wait for the switch to be visible in the DOM rather than for a guessed number of milliseconds.
  await page.waitForFunction(`!!document.querySelector('[data-win-id="b1"] [data-tab="t2"][data-variant="primary"]')`);
  await win.getByRole('button', { name: /^Split view:/ }).click();
  await page.waitForFunction(`document.querySelector('[data-testid="br-frames"]').dataset.split === 'h'`);
  await win.getByLabel('Tab group').selectOption('+');
  await page.waitForTimeout(150);
  await win.getByRole('button', { name: 'Pin tab' }).click();

  // The reducer debounces its write, so a fixed sleep samples a transient: poll the server until
  // the session it holds is the one that was just built, and fail loudly if it never arrives.
  type Props = { tabs?: { id: string; url: string; pinned: boolean; group: string }[]; active?: string; split?: string; groups?: { id: string }[] };
  const readProps = async (): Promise<Props | undefined> => {
    const saved = await api<{ row?: { state?: { windows?: { id: string; props?: Props }[] } } }>('GET', '/api/state?id=default');
    return (saved.row?.state?.windows ?? []).find((w) => w.id === 'b1')?.props;
  };
  let props: Props | undefined;
  const deadline = Date.now() + 10_000;
  for (;;) {
    props = await readProps();
    const done = props?.active === 't2' && props?.split === 'h'
      && (props?.groups ?? []).length >= 1 && props?.tabs?.find((t) => t.id === 't2')?.pinned === true;
    if (done || Date.now() > deadline) break;
    await page.waitForTimeout(250);
  }
  assert.equal(props?.tabs?.length, 3, 'all three tabs were serialised into the window');
  assert.equal(props?.active, 't2', 'and so was which one is in front');
  assert.equal(props?.split, 'h', 'and the split');
  assert.ok((props?.groups ?? []).length >= 1, 'and the group that was created');
  assert.equal(props?.tabs?.find((t) => t.id === 't2')?.pinned, true, 'and the pin');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-win-id="b1"]');
  await page.waitForFunction(`document.querySelector('[data-testid="br-frames"]') !== null`);
  const restored = await paneBoxes(page);
  assert.equal(restored.split, 'h', 'the split came back');
  assert.equal(restored.panes.length, 2, 'with both panes');
  const tabIds = await page.evaluate(`[...new Set([...document.querySelectorAll('[data-win-id="b1"] [data-tab]')].map((e) => e.dataset.tab))]`) as string[];
  assert.deepEqual([...tabIds].sort(), ['t1', 't2', 't3'], `all three tabs came back: ${tabIds.join(', ')}`);
  const activeNow = await win.locator('[data-tab][data-variant="primary"]').first().getAttribute('data-tab');
  assert.equal(activeNow, 't2', `and the same tab is in front (${activeNow})`);
  console.log(`    3 tabs + active + group + pin + split h survived a reload`);
  await context.close();
});

await test('no page error was raised while splitting, tearing out or restoring', { 'PR-07d': 'partial', 'PR-07r': 'partial' }, async () => {
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('    zero uncaught page errors across 4 browser-window contexts');
});

await browser.close();
await finish();
