/**
 * TT116 — AX-18: the caption row becomes a glyph row.
 *
 * TT113 bounded Recall's prose, TT115 drew the browser chrome, and Recall's filter
 * strip survived both because it is not prose and not chrome: it is six form fields
 * whose captions sat above them in a stack. Measured at the start of this turn Recall
 * still showed 213 visible words.
 *
 * This suite is the contract for the third pass, and it is written so the obvious
 * cheats fail:
 *
 *   - Deleting a filter passes any word count. So every control is addressed by the
 *     exact accessible name the existing suites use, and all of them must resolve.
 *   - Hiding the row inside a disclosure passes any word count. So the controls must
 *     be visible, with a non-zero box, outside any collapsed <details>.
 *   - Replacing a caption with a letter or an arrow character passes a glyph count.
 *     So each mark must be a real <svg>, and the whole app must contain no emoji.
 *   - Reusing one shape for every concept passes all of the above. So the rendered
 *     geometry of the new marks is compared and must be distinct.
 *   - A short visible word that is not inside the control's accessible name is a
 *     WCAG 2.5.3 failure, which e2e-a11y would catch later and this suite catches now.
 *
 * The floor matters as much as the ceiling: a module can always "win" a word count by
 * deleting the sentence that tells the truth about a consequence, so the suite also
 * asserts that the non-cancellable-commit warning is still on screen.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error('Exclusive disposable server/database and BASE required');
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness('tt116-density');

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}

/** Every Recall control whose caption this turn removed, by its unchanged name. */
const NAMED_CONTROLS = [
  'Filter by save method', 'Filter by page host', 'Filter from date', 'Filter to date',
  'Search memories', 'Integrity scope', 'Check pair integrity',
  'Choose resident media', 'Keep one copy of identical pictures',
  'Recall source URL', 'Recall folder grouping', 'Recall page title',
  'Audio-only output (requires shared audio)', 'Choose local streaming file (experimental)',
  'Cancel pending / fetching jobs',
  // RC-13's new control, named the same way from the day it shipped.
  'Keep this many newest memories', 'Plan a tidy-up of this folder',
];

const browser = await launchChromium();
const errors: string[] = [];

async function openModule(module: string, props: Record<string, unknown> = {}) {
  const cur = await api<{ row?: { revision?: number } }>('GET', '/api/state?id=default');
  await api('PUT', '/api/state', {
    id: 'default', revision: Number(cur.row?.revision ?? 1) + 1000,
    state: {
      windows: [{ id: 'w1', module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props }],
      focus: 'w1', workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 30,
    },
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForTimeout(1200);
  return { page, context };
}

/** One normaliser for BOTH sides of a label-in-name comparison. Using two is how a
 *  checker invents violations that are not there (TT115 learned this the hard way). */
const NORM = `(s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()`;

await test('AX-18: Recall shows fewer than 170 visible words and more than 45 drawn marks', { 'AX-18': 'full', 'RC-05': 'partial' }, async () => {
  const { page, context } = await openModule('recall');
  const m = await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="recall"]');
    if (!root) return { error: 'Recall did not render' };
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    let words = 0, longest = '';
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (!p || !vis(p) || p.closest('details:not([open])')) continue;
      const t = (n.textContent || '').trim();
      if (!t) continue;
      words += t.split(/\\s+/).filter(Boolean).length;
      if (t.length > longest.length) longest = t;
    }
    let glyphs = 0, controls = 0;
    root.querySelectorAll('svg').forEach((el) => { if (vis(el)) glyphs++; });
    root.querySelectorAll('button, input, select, textarea').forEach((el) => { if (vis(el)) controls++; });
    // Scope the emoji check to CONTROL labels. Prose is allowed its arrows — the
    // cheat this guards against is a control whose mark is a character, and running
    // the range over the whole module only finds the arrow in "Settings → Privacy".
    let emoji = false;
    root.querySelectorAll('button, label, [role="button"]').forEach((el) => {
      if (/[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{27BF}\\u{FE0F}]/u.test(el.textContent || '')) emoji = true;
    });
    return { words, glyphs, controls, emoji, longest: longest.slice(0, 120) };
  })()`) as { error?: string; words: number; glyphs: number; controls: number; emoji: boolean; longest: string };
  assert.ok(!m.error, m.error);
  // Measured before this turn's pass: 213 words, 32 marks. The bound is the claim.
  assert.ok(m.words < 170, `Recall still shows ${m.words} visible words`);
  assert.ok(m.glyphs > 45, `Recall draws only ${m.glyphs} marks`);
  assert.ok(m.controls >= 40, `only ${m.controls} controls are visible — did the pass delete some?`);
  assert.equal(m.emoji, false, 'a concept mark was replaced by an emoji');
  console.log(`    Recall: ${m.words} words, ${m.glyphs} marks, ${m.controls} controls`);
  await context.close();
});

await test('every control whose caption was removed still answers to its full name', { 'AX-18': 'full', 'DP-07': 'partial' }, async () => {
  const { page, context } = await openModule('recall');
  const recall = page.getByTestId('recall');
  const missing: string[] = [];
  for (const name of NAMED_CONTROLS) {
    const byLabel = recall.getByLabel(name, { exact: true });
    const byRole = recall.getByRole('button', { name, exact: true });
    const count = (await byLabel.count()) + (await byRole.count());
    if (count === 0) missing.push(name);
  }
  assert.deepEqual(missing, [], `the pass took these names with it: ${missing.join(', ')}`);
  await context.close();
});

await test('no shortened word sits outside the name its control answers to', { 'AX-18': 'full', 'DP-07': 'partial' }, async () => {
  const { page, context } = await openModule('recall');
  const bad = await page.evaluate(`(() => {
    const norm = ${NORM};
    const root = document.querySelector('[data-testid="recall"]');
    const out = [];
    root.querySelectorAll('button, [role="button"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const name = norm(el.getAttribute('aria-label') || el.textContent);
      const shown = norm(el.textContent);
      if (!shown) return;
      // WCAG 2.5.3: the words a person sees must appear in the name speech uses.
      if (!name.includes(shown)) out.push({ shown, name });
    });
    return out;
  })()`) as { shown: string; name: string }[];
  assert.deepEqual(bad, [], `label-in-name violations: ${JSON.stringify(bad)}`);
  await context.close();
});

await test('the new marks are real drawings and no two of them are the same shape', { 'AX-18': 'full' }, async () => {
  const { page, context } = await openModule('recall');
  const shapes = await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="recall"]');
    const seen = new Map();
    let total = 0, empty = 0;
    root.querySelectorAll('svg').forEach((svg) => {
      const r = svg.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      total++;
      // The geometry itself, not the element: two <use> of one shape collapse here.
      const geom = [...svg.querySelectorAll('path, rect, circle, line, polyline, polygon')]
        .map((n) => n.tagName + ':' + (n.getAttribute('d') || [n.getAttribute('x'), n.getAttribute('y'), n.getAttribute('width'), n.getAttribute('height'), n.getAttribute('cx'), n.getAttribute('cy'), n.getAttribute('r')].join(',')))
        .join('|');
      if (!geom) { empty++; return; }
      seen.set(geom, (seen.get(geom) || 0) + 1);
    });
    return { total, empty, distinct: seen.size, mostReused: Math.max(0, ...seen.values()) };
  })()`) as { total: number; empty: number; distinct: number; mostReused: number };
  assert.equal(shapes.empty, 0, 'an svg with no geometry is a placeholder, not a glyph');
  assert.ok(shapes.distinct >= 20, `only ${shapes.distinct} distinct shapes across ${shapes.total} marks`);
  console.log(`    ${shapes.total} marks rendered, ${shapes.distinct} geometrically distinct`);
  await context.close();
});

await test('the floor holds: the consequence of an uncancellable commit is still on screen', { 'AX-18': 'full', 'RC-11': 'partial' }, async () => {
  const { page, context } = await openModule('recall');
  const text = await page.getByTestId('recall').innerText();
  assert.match(text, /Once a database commit starts it is not cancellable/i,
    'the word count was won by deleting a consequence, which is the cheat this floor exists to catch');
  assert.match(text, /Paste a copied media file here, or drop one/i, 'a drop target lost its label');
  assert.match(text, /1 · Original bytes/i, 'a pathway heading disappeared');
  assert.equal(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  await context.close();
});

await test('RC-13 is reachable by a person, and its first click only ever plans', { 'RC-13': 'full', 'AX-18': 'full' }, async () => {
  const { page, context } = await openModule('recall');
  const recall = page.getByTestId('recall');
  const tidy = recall.getByRole('button', { name: 'Plan a tidy-up of this folder', exact: true });
  await tidy.waitFor();
  assert.equal(await tidy.isVisible(), true);
  // An Apply control must NOT exist before a plan has been reviewed.
  assert.equal(await recall.getByRole('button', { name: /^Apply the planned tidy-up$/ }).count(), 0,
    'the apply control exists before anything has been planned');
  const keep = recall.getByLabel('Keep this many newest memories', { exact: true });
  assert.equal(await keep.inputValue(), '100');
  await context.close();
});

await browser.close();
finish();
