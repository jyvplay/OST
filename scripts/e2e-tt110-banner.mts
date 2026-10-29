/**
 * TT110 — the creative-app chrome in Art layout.
 *
 * Two long-standing complaints, stated as measurements rather than opinions:
 *   1. In Art layout the focused window's menus appear twice — once in the shell menu bar at the
 *      top of the screen and once again inside the window.
 *   2. The second bar (fonts and alignment) does not fit, so controls have to be scrolled to.
 *
 * Both are measured in the real browser at a realistic window size, for every creative app that
 * uses the shared banner.
 */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const RUN = Math.random().toString(36).slice(2, 8);
const { test, finish } = makeHarness('e2e-tt110-banner');

const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json() as T;
};

const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);

try {
  // Art layout is the one with the Mac-style shell menu bar, where the duplication happens.
  await api('PUT', '/api/settings', { key: 'appearance.layout', value: 'art' });

  let currentLayout = 'art';
  const openWindows = async (mods: { id: string; w: number; h: number }[]) => {
    const original = await api<{ row?: { revision?: number; state?: object } }>('GET', '/api/state?id=default');
    await api('PUT', '/api/state', {
      id: 'default', revision: (original.row?.revision ?? 0) + 800,
      state: {
        ...original.row?.state,
        windows: mods.map((m, i) => ({
          id: `tt110b-${m.id}-${RUN}`, module: m.id, title: m.id, props: {},
          x: 8, y: 36, w: m.w, h: m.h, z: 20 + i, workspace: 1,
        })),
        focus: `tt110b-${mods[0].id}-${RUN}`, activeWorkspace: 1, nextZ: 30,
      },
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    // The shell menu bar exists only in Art layout, so waiting for it in Fusion or Business hangs
    // until the timeout. The window itself is the thing every layout has — and the thing measured.
    await page.waitForSelector(`[data-win-id="tt110b-${mods[0].id}-${RUN}"]`, { timeout: 60_000 });
    if (currentLayout === 'art') await page.waitForSelector('[data-testid="menubar"]', { timeout: 60_000 });
    await page.waitForTimeout(1200);
  };

  const measure = (winId: string) => page.evaluate(`(()=>{
    const win=document.querySelector('[data-win-id="${winId}"]');
    if(!win) return {found:false};
    const shellNames=[...document.querySelectorAll('[data-testid="menubar"] [data-testid^="shell-menu-"]')].map(b=>b.textContent.trim());
    const winNav=win.querySelector('.fs-banner-nav');
    const winNames=winNav?[...winNav.querySelectorAll('button')].map(b=>b.textContent.trim()):[];
    const strip=win.querySelector('[data-testid="banner-strip"]');
    const banner=win.querySelector('.fs-banner');
    const dup=shellNames.filter(n=>winNames.includes(n));
    return {found:true, shellNames, winNames, dup,
      overflow: strip?Math.max(0,strip.scrollWidth-strip.clientWidth):-1,
      stripWidth: strip?strip.clientWidth:0,
      needed: strip?strip.scrollWidth:0,
      bannerHeight: banner?Math.round(banner.getBoundingClientRect().height):0,
      controls: strip?strip.querySelectorAll('button,select,input').length:0};
  })()`) as Promise<{
    found: boolean; shellNames: string[]; winNames: string[]; dup: string[];
    overflow: number; stripWidth: number; needed: number; bannerHeight: number; controls: number;
  }>;

  await test('in Art layout a window does not repeat the menus the shell menu bar is already showing',
    { 'WM-02': 'partial', 'AX-05': 'partial' }, async () => {
      const apps = [{ id: 'writer', w: 1000, h: 700 }, { id: 'slides', w: 1000, h: 700 }, { id: 'sheet', w: 1000, h: 700 }, { id: 'photos', w: 1000, h: 700 }];
      for (const app of apps) {
        await openWindows([app]);
        const m = await measure(`tt110b-${app.id}-${RUN}`);
        assert.equal(m.found, true, `${app.id} did not open`);
        assert.ok(m.shellNames.length > 0, `${app.id}: the shell menu bar shows no app menus, so the window must keep its own`);
        assert.deepEqual(m.dup, [],
          `${app.id} repeats ${m.dup.length} menus already in the shell bar: ${m.dup.join(', ')}`);
        console.log(`    ${app.id}: shell shows [${m.shellNames.join(' ')}], window repeats none, banner ${m.bannerHeight}px`);
      }
    });

  await test('an unfocused window keeps its own menus, because the shell bar only shows the focused one',
    { 'WM-02': 'partial' }, async () => {
      await openWindows([{ id: 'writer', w: 640, h: 520 }, { id: 'slides', w: 620, h: 520 }]);
      // The second window in the list is not focused.
      const other = await measure(`tt110b-slides-${RUN}`);
      assert.equal(other.found, true);
      assert.ok(other.winNames.length > 0,
        'an unfocused creative window lost its menus — they are reachable nowhere');
      console.log(`    unfocused slides keeps [${other.winNames.join(' ')}]`);
    });

  await test('the fonts and alignment bar fits inside the window instead of scrolling sideways',
    { 'WM-02': 'partial', 'AX-05': 'partial' }, async () => {
      const cases = [{ id: 'writer', w: 1000, h: 700 }, { id: 'slides', w: 1000, h: 700 }];
      const report: string[] = [];
      for (const app of cases) {
        await openWindows([app]);
        const m = await measure(`tt110b-${app.id}-${RUN}`);
        report.push(`${app.id}: ${m.controls} controls need ${m.needed}px in ${m.stripWidth}px (overflow ${m.overflow}px)`);
        assert.equal(m.overflow, 0,
          `${app.id}: the tool strip still needs ${m.needed}px inside ${m.stripWidth}px — ${m.overflow}px has to be scrolled to`);

        // What fits must be what a person reaches for: the fonts and alignment group stays on the
        // bar, and whatever folded is still one click away in the More tools menu.
        const kept = await page.evaluate(`(()=>{
          const win=document.querySelector('[data-win-id="tt110b-${app.id}-${RUN}"]');
          const g=[...win.querySelectorAll('[data-banner-group]')];
          const vis=g.filter(x=>!x.dataset.folded).map(x=>x.dataset.bannerGroup);
          const folded=g.filter(x=>x.dataset.folded).map(x=>x.dataset.bannerGroup);
          const more=win.querySelector('[data-testid="banner-more"]');
          return {vis,folded,more:!!more};
        })()`) as { vis: string[]; folded: string[]; more: boolean };
        assert.ok(kept.vis.includes('Look'),
          `${app.id}: the fonts and alignment group was folded away instead of kept: visible ${kept.vis.join(',')}`);
        if (kept.folded.length) {
          assert.equal(kept.more, true, `${app.id}: ${kept.folded.length} groups folded with no More tools menu to reach them`);
          const items = await page.locator('[data-testid="banner-more"]').click().then(async () => {
            await page.waitForTimeout(300);
            return page.locator('[role=menu] [role=menuitem], [role=menu] [role=menuitemcheckbox]').count();
          });
          assert.ok(items > 0, `${app.id}: the More tools menu is empty, so the folded controls are unreachable`);
          await page.keyboard.press('Escape');
          report.push(`${app.id}: kept [${kept.vis.join(' ')}], folded [${kept.folded.join(' ')}] → ${items} items in More`);
        }
      }
      console.log(`    ${report.join(' | ')}`);
    });

  /**
   * TT112: the same bar in the layouts people actually use. Folding used to be gated on Art, so
   * Fusion and Business scrolled sideways instead — the complaint this suite was written for was
   * only ever half-fixed. Every layout is measured here, in a window narrow enough that the bar
   * genuinely cannot hold everything, so a regression to "just let it scroll" fails.
   */
  for (const layout of ['fusion', 'business'] as const) {
    await test(`the fonts and alignment bar fits without scrolling in ${layout} layout too`,
      { 'WM-02': 'partial', 'AX-05': 'partial' }, async () => {
        await api('PUT', '/api/settings', { key: 'appearance.layout', value: layout });
        currentLayout = layout;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const report: string[] = [];
        for (const app of [{ id: 'writer', w: 1000, h: 700 }, { id: 'slides', w: 1000, h: 700 }]) {
          await openWindows([app]);
          const m = await measure(`tt110b-${app.id}-${RUN}`);
          assert.ok(m.found, `${app.id}: the window never appeared in ${layout} layout`);
          assert.equal(m.overflow, 0,
            `${layout}/${app.id}: the tool strip needs ${m.needed}px inside ${m.stripWidth}px — ${m.overflow}px can only be reached by scrolling`);
          assert.ok(m.controls > 4, `${layout}/${app.id}: only ${m.controls} controls — the bar did not render`);
          // Folding must not be achieved by throwing the tools away: anything folded is in the menu.
          const folded = await page.evaluate(`(()=>{
            const win=document.querySelector('[data-win-id="tt110b-${app.id}-${RUN}"]');
            return win ? win.querySelectorAll('[data-folded="1"]').length : -1;
          })()`) as number;
          const more = await page.locator(`[data-win-id="tt110b-${app.id}-${RUN}"] [data-testid="banner-more"]`).count();
          if (folded > 0) assert.equal(more, 1, `${layout}/${app.id}: ${folded} controls folded away with no More menu to reach them`);
          report.push(`${layout}/${app.id}: ${m.controls} controls, needed ${m.needed}px in ${m.stripWidth}px, folded ${folded}`);
        }
        console.log(`    ${report.join(' | ')}`);
      });
  }
} finally {
  await api('PUT', '/api/settings', { key: 'appearance.layout', value: 'fusion' }).catch(() => undefined);
  await browser.close();
}
finish();
