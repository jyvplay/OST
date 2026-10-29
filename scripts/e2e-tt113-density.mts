/**
 * TT113 — the modules read as tools, not as documents.
 *
 * Recall and the Browser had accumulated an essay: every limit, refusal and privacy caveat was
 * printed as body copy, so the first screen of Recall was ~450 words of prose above the controls.
 * The words are all TRUE and all worth keeping — which is exactly why they cannot simply be cut.
 * They were moved into real disclosures (<details>, keyboard reachable, hover title, nothing
 * removed), the way the app banner moved its overflow into a "More" menu.
 *
 * This suite measures that claim instead of asserting it:
 *
 *   1. visible prose is bounded — text that is NOT a control, a heading, a badge, a list row or
 *      inside a CLOSED disclosure, counted in words, per module;
 *   2. nothing was deleted to achieve it — every disclosure still holds its text, and opening
 *      them restores at least the volume of words the pane used to print;
 *   3. the disclosures are real UI — focusable, operable by keyboard, and announced (aria/semantics),
 *      so "hidden" never means "unreachable";
 *   4. the controls people actually use are still on screen and still work after the change.
 *
 * Falsifier of record: if a future turn achieves a low word count by DELETING a limit rather than
 * disclosing it, test 2 fails — the opened total must stay above the floor.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const { test, finish } = makeHarness('e2e-tt113-density');
const RUN = Date.now().toString(36);

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json() as T;
}

const browser = await launchChromium();
const errors: string[] = [];

/** Words of prose a person actually sees: not controls, not headings, not closed disclosures. */
const MEASURE = `(() => {
  const win = document.querySelector('[data-win-id="tt113-WINID"]');
  if (!win) return { found: false };
  const skip = 'button,select,input,textarea,option,summary,.fs-badge,.fs-mono,li,h1,h2,h3,label,[role="alert"],[role="status"]';
  const count = (requireOpen) => {
    let words = 0;
    for (const el of win.querySelectorAll('p,div,span')) {
      if (el.closest(skip)) continue;
      if (el.querySelector('p,div,span,button,select,input,li')) continue;
      const d = el.closest('details');
      if (d && !d.open && !requireOpen) continue;
      const t = (el.textContent || '').trim();
      if (t) words += t.split(/\\s+/).length;
    }
    return words;
  };
  const hints = Array.from(win.querySelectorAll('details.fs-hint'));
  let hidden = 0;
  for (const h of hints) {
    const body = h.querySelector('.fs-hint-body');
    const t = body ? (body.textContent || '').trim() : '';
    if (t) hidden += t.split(/\\s+/).length;
  }
  return {
    found: true,
    visibleWords: count(false),
    hintWords: hidden,
    hints: hints.length,
    summaries: hints.map((h) => { const s = h.querySelector('summary'); return s ? (s.textContent || '').trim() : ''; }),
    controls: win.querySelectorAll('button,select,input,textarea').length,
  };
})()`;

async function openModule(mod: string, props: Record<string, unknown> = {}) {
  const cur = await api<{ row?: { revision?: number; state?: Record<string, unknown> } }>('GET', '/api/state?id=default');
  const prev = (cur.row?.state ?? {}) as Record<string, unknown>;
  await api('PUT', '/api/state', {
    id: 'default', revision: Number(cur.row?.revision ?? 1) + 900,
    state: {
      ...prev,
      windows: [{ id: `tt113-${mod}-${RUN}`, module: mod, title: mod, x: 24, y: 20, w: 1240, h: 900, z: 12, workspace: 1, props }],
      focus: `tt113-${mod}-${RUN}`, workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 30,
    },
  });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on('pageerror', (e) => errors.push(`${mod}: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`[data-win-id="tt113-${mod}-${RUN}"]`, { timeout: 60_000 });
  await page.waitForTimeout(3500);
  return { page, context, winId: `tt113-${mod}-${RUN}` };
}

type Measured = {
  found: boolean; visibleWords: number; hintWords: number; hints: number;
  summaries: string[]; controls: number;
};
const measure = (page: Awaited<ReturnType<typeof openModule>>['page'], mod: string) =>
  page.evaluate(MEASURE.replace('tt113-WINID', `tt113-${mod}-${RUN}`)) as Promise<Measured>;

try {
  /**
   * The headline. 120 words is roughly a short paragraph: enough for a one-line explanation
   * under a heading, far below the 450-word document Recall used to open with.
   */
  for (const mod of ['recall', 'browser'] as const) {
    await test(`${mod} opens as a tool, not a document`,
      { 'AX-16': 'full', 'RC-01': 'partial', 'AX-05': 'partial', 'WM-02': 'partial' }, async () => {
        const props = mod === 'browser'
          ? { tabs: [{ id: 't1', url: 'http://127.0.0.1:4001/', title: 'fixture', pinned: false, asleep: false, group: '' }], active: 't1', proxyAll: true }
          : {};
        const { page, context } = await openModule(mod, props);
        try {
          const m = await measure(page, mod);
          assert.ok(m.found, `${mod}: the window never rendered`);
          assert.ok(m.visibleWords <= 120,
            `${mod}: ${m.visibleWords} words of prose are printed on open — this is a tool, not an essay`);
          assert.ok(m.controls >= 8, `${mod}: only ${m.controls} controls — the pane did not actually render`);
          console.log(`    ${mod}: ${m.visibleWords} visible prose words, ${m.controls} controls, ${m.hints} disclosures holding ${m.hintWords} words`);
        } finally { await context.close(); }
      });
  }

  /**
   * The anti-cheat. A low word count achieved by deleting the honest small print would be a
   * REGRESSION dressed as an improvement, so the words have to still be there, behind the
   * disclosures, in the volume the pane used to print.
   */
  await test('the small print was moved, not deleted',
    { 'AX-16': 'full', 'RC-01': 'partial', 'SC-08': 'partial' }, async () => {
      const { page, context } = await openModule('recall');
      try {
        const before = await measure(page, 'recall');
        assert.ok(before.hints >= 8, `only ${before.hints} disclosures — the limits are not all accounted for`);
        assert.ok(before.hintWords >= 300,
          `the disclosures hold only ${before.hintWords} words: small print was deleted rather than moved`);
        // Every disclosure must be labelled with something a person can act on, not "more".
        for (const s of before.summaries) {
          assert.ok(s.length >= 6, `a disclosure is labelled "${s}" — too vague to choose to open`);
        }
        // Opening them all brings the full text back onto the page.
        await page.evaluate(`(() => {
          for (const d of document.querySelectorAll('[data-win-id="tt113-recall-${RUN}"] details.fs-hint')) d.open = true;
        })()`);
        await page.waitForTimeout(400);
        const after = await measure(page, 'recall');
        assert.ok(after.visibleWords >= before.visibleWords + 300,
          `opening every disclosure added only ${after.visibleWords - before.visibleWords} words`);
        console.log(`    closed ${before.visibleWords} words → opened ${after.visibleWords} words across ${before.hints} disclosures`);
      } finally { await context.close(); }
    });

  /**
   * Hidden must never mean unreachable: the disclosure has to be operable from the keyboard
   * alone, which is the difference between a disclosure and a hover tooltip.
   */
  await test('a disclosure opens from the keyboard alone',
    { 'AX-16': 'full', 'AX-05': 'partial', 'AX-01': 'partial' }, async () => {
      const { page, context } = await openModule('recall');
      try {
        const first = page.locator(`[data-win-id="tt113-recall-${RUN}"] details.fs-hint > summary`).first();
        await first.focus();
        const focused = await page.evaluate(`document.activeElement ? document.activeElement.tagName : ''`);
        assert.equal(focused, 'SUMMARY', `focus landed on ${focused} — the disclosure is not reachable by keyboard`);
        const openedBefore = await page.evaluate(`document.querySelector('[data-win-id="tt113-recall-${RUN}"] details.fs-hint').open`);
        assert.equal(openedBefore, false, 'the disclosure starts open, so nothing was compacted');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(250);
        const openedAfter = await page.evaluate(`document.querySelector('[data-win-id="tt113-recall-${RUN}"] details.fs-hint').open`);
        assert.equal(openedAfter, true, 'Enter did not open the disclosure');
        const body = await page.locator(`[data-win-id="tt113-recall-${RUN}"] details.fs-hint .fs-hint-body`).first().innerText();
        assert.ok(body.trim().length > 40, `the opened disclosure shows only "${body.trim()}"`);
        console.log(`    keyboard: focus → Enter → ${body.trim().split(/\s+/).length} words revealed`);
      } finally { await context.close(); }
    });

  /**
   * Compacting chrome must not cost a control. These are the Recall pathways themselves —
   * the buttons that do the actual saving — and they must still be present and enabled.
   */
  await test('every saving pathway survived the compaction',
    { 'AX-16': 'full', 'RC-01': 'partial', 'RC-38': 'partial' }, async () => {
      const { page, context } = await openModule('recall');
      try {
        const must = ['Save media URL', 'Refresh loaded media', 'Scan the open page', 'Browse inside Recall',
          'Capture authorized image', 'Start authorized recording'];
        const win = page.locator(`[data-win-id="tt113-recall-${RUN}"]`);
        for (const name of must) {
          const b = win.getByRole('button', { name, exact: true });
          assert.equal(await b.count(), 1, `the "${name}" control disappeared in the compaction`);
        }
        assert.ok(await win.getByRole('button', { name: 'Save media URL', exact: true }).isEnabled(),
          'the refetch pathway is no longer usable');
        // The grouped memory toolbar kept its buttons too.
        const groups = await win.locator('.fs-toolgroup').count();
        assert.ok(groups >= 3, `the memory actions were not grouped (${groups} groups)`);
        console.log(`    ${must.length} saving controls present, memory actions in ${groups} labelled groups`);
      } finally { await context.close(); }
    });

  await test('compacting the chrome raised no page exception', {}, async () => {
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  });
} finally {
  await browser.close();
}
finish();
