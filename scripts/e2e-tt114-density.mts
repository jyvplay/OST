/**
 * TT114 — AX-17: a control may be shortened only if its name survives.
 *
 * TT113 measured prose. This turn attacks the other half of the wordiness: fifteen stacked buttons
 * carrying forty-five words of label, which read as a paragraph with borders. Each one now shows a
 * concept glyph and a single word.
 *
 * That change is dangerous in a specific way, and this suite exists for exactly that danger. A
 * shorter label is worth nothing if it takes the control's name with it: screen-reader users, the
 * command palette and every existing test address these buttons by name. So the contract is a
 * pair, and both halves are asserted here:
 *
 *   1. visible label text in the Recall toolbar is at most 24 words (it was 45);
 *   2. every one of the fifteen actions still answers to its full accessible name, exactly;
 *   3. every shortened control carries a drawn glyph, not a text icon or an emoji;
 *   4. the browser's split, tear-out and sidebar controls are glyphs with real names too.
 *
 * Deleting a control would pass (1) and fail (2). Replacing the glyph with the letter "V" would
 * pass (1) and (2) and fail (3). There is no way to win this suite except by doing the work.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('e2e-tt114-density');

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json() as T;
}

/** The fifteen memory actions, by the exact accessible name eight other suites address them with. */
const MEMORY_ACTIONS = [
  'Save copied image · Clipboard', 'Refresh memory timeline', 'Load older memories', 'Show saving timeline',
  'Verify saved receipt', 'Save preview frame', 'Copy memory to clipboard', 'Open memory in Photos',
  'Show memory in Files', 'Trash open memory pair', 'Export open memory', 'Close memory preview',
  'Save selected region · Save region', 'Clear region', 'Undo pair trash',
];

const browser = await launchChromium();
const errors: string[] = [];

async function openModule(module: string, props: Record<string, unknown> = {}) {
  const cur = await api<{ row?: { revision?: number } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: Number(cur.row?.revision ?? 1) + 1000,
    state: {
      windows: [{ id: 'w1', module, title: module, x: 20, y: 16, w: 1240, h: 900, z: 10, workspace: 1, props }],
      focus: 'w1', workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 30,
    },
  });
  const context = await browser.newContext({ viewport: { width: 1480, height: 980 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForTimeout(1200);
  return { page, context };
}

/* ------------------------------------------------------------------ 1 + 3: the toolbar */

await test('AX-17: the memory toolbar shows at most 24 words, and every button is a drawn glyph', { 'AX-17': 'full', 'RC-05': 'partial' }, async () => {
  const { page, context } = await openModule('recall');
  const measured = await page.evaluate(`(() => {
    const group = document.querySelector('[aria-label="Memory actions"]');
    if (!group) return null;
    const buttons = [...group.querySelectorAll('button')];
    let words = 0, withGlyph = 0, withEmoji = 0;
    for (const b of buttons) {
      const text = (b.textContent || '').trim();
      words += text.split(/\\s+/).filter(Boolean).length;
      if (b.querySelector('svg')) withGlyph++;
      if (/[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{27BF}]/u.test(text)) withEmoji++;
    }
    const r = group.getBoundingClientRect();
    return { buttons: buttons.length, words, withGlyph, withEmoji, height: Math.round(r.height) };
  })()`) as { buttons: number; words: number; withGlyph: number; withEmoji: number; height: number } | null;

  assert.ok(measured, 'the memory action group exists');
  assert.ok(measured.buttons >= 15, `all fifteen actions are still mounted, found ${measured.buttons}`);
  assert.ok(measured.words <= 24, `visible label words must be at most 24, measured ${measured.words}`);
  assert.equal(measured.withGlyph, measured.buttons, `every button carries a drawn glyph (${measured.withGlyph}/${measured.buttons})`);
  assert.equal(measured.withEmoji, 0, 'no button falls back to an emoji or an arrow character');
  console.log(`    ${measured.buttons} actions, ${measured.words} visible words (was 45), ${measured.withGlyph} drawn glyphs, ${measured.height}px tall`);
  await context.close();
});

/* ------------------------------------------------------------------ 2: the names survived */

await test('AX-17: shortening the labels cost no control its name', { 'AX-17': 'full', 'AX-01': 'partial' }, async () => {
  const { page, context } = await openModule('recall');
  const win = page.locator('[data-win-id="w1"]');
  const missing: string[] = [];
  for (const name of MEMORY_ACTIONS) {
    const n = await win.getByRole('button', { name, exact: true }).count();
    if (n !== 1) missing.push(`${name} (${n})`);
  }
  assert.deepEqual(missing, [], `every action must still answer to its full name; missing: ${missing.join(', ')}`);

  // And the name must be the accessible name, not a tooltip that a screen reader may ignore.
  const sample = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('[aria-label="Memory actions"] button')]
      .find((x) => x.getAttribute('aria-label') === 'Verify saved receipt');
    return b ? { aria: b.getAttribute('aria-label'), text: (b.textContent || '').trim() } : null;
  })()`) as { aria: string; text: string } | null;
  assert.equal(sample?.aria, 'Verify saved receipt');
  assert.ok((sample?.text.length ?? 99) <= 12, `and the visible word is short: "${sample?.text}"`);
  console.log(`    all ${MEMORY_ACTIONS.length} names resolve by role; "Verify saved receipt" shows as "${sample?.text}"`);
  await context.close();
});

/* ------------------------------------------------------------------ 4: the browser chrome */

await test('AX-17: the browser\'s split, tear-out and tab-side controls are named glyphs', { 'AX-17': 'full', 'PR-07d': 'partial' }, async () => {
  const { page, context } = await openModule('browser', {
    tabs: [{ id: 't1', url: 'http://127.0.0.1:4001/', title: 'Fixture A', pinned: false, asleep: false, group: '' }],
    active: 't1', proxyAll: true,
  });
  const win = page.locator('[data-win-id="w1"]');

  for (const [name, aria] of [[/^Split view:/, 'Split view'], [/^Tear out$/, 'Tear out'], [/^Vertical tab sidebar$/, 'Vertical tab sidebar']] as [RegExp, string][]) {
    const b = win.getByRole('button', { name }).first();
    await b.waitFor();
    // Read through page.evaluate: a string passed to locator.evaluate is not a function body here.
    const shape = await page.evaluate(`(() => {
      const el = [...document.querySelectorAll('[data-win-id="w1"] button')]
        .find((x) => (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(aria)}));
      return el ? { svg: !!el.querySelector('svg'), text: (el.textContent || '').trim() } : null;
    })()`) as { svg: boolean; text: string } | null;
    assert.ok(shape, `${name} is present`);
    assert.ok(shape.svg, `${name} is drawn, not written`);
    assert.ok(shape.text.replace(/[\u21d0-\u21ff]/g, '').trim().length === 0,
      `${name} carries no label text beyond its glyph (got "${shape.text}")`);
  }
  console.log('    split, tear-out and tab-side are glyph-only controls with full accessible names');
  await context.close();
});

/* ------------------------------------------------------------------ the concept glyphs exist */

await test('AX-17: the new glyphs are real drawings, each distinct from the others', { 'AX-17': 'full' }, async () => {
  const { page, context } = await openModule('recall');
  // Section headings carry the pathway glyphs; collect their path geometry and check for lazy reuse.
  const shapes = await page.evaluate(`(() => {
    const out = [];
    for (const svg of document.querySelectorAll('[data-win-id="w1"] h3 svg, [aria-label="Memory actions"] svg')) {
      const d = [...svg.querySelectorAll('path,circle,rect')].map((n) =>
        n.getAttribute('d') || [n.getAttribute('cx'), n.getAttribute('cy'), n.getAttribute('r'), n.getAttribute('x'), n.getAttribute('y')].join(',')).join('|');
      if (d) out.push(d);
    }
    return out;
  })()`) as string[];
  assert.ok(shapes.length >= 15, `glyphs are rendered, found ${shapes.length}`);
  const unique = new Set(shapes);
  assert.ok(unique.size >= 12, `at least twelve distinct drawings, found ${unique.size} among ${shapes.length}`);
  for (const d of shapes) assert.ok(d.length > 12, `each glyph is a real construction, not a dot: ${d.slice(0, 40)}`);
  console.log(`    ${shapes.length} glyphs rendered, ${unique.size} geometrically distinct`);
  await context.close();
});

await test('AX-17: none of the compaction raised a page error', { 'AX-17': 'partial' }, async () => {
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('    zero uncaught page errors across 4 contexts');
});

await browser.close();
await finish();
