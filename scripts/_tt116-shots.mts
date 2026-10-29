/** TT116 visual check: what a person actually sees in Recall and Browser. */
import { launchChromium } from './browser-launch.mts';
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const seed = async (module: string, props: Record<string, unknown> = {}) => {
  const cur = await (await fetch(`${BASE}/api/state?id=default`)).json() as { row?: { revision?: number } };
  await fetch(`${BASE}/api/state`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'default', revision: Number(cur.row?.revision ?? 1) + 1000, state: {
      windows: [{ id: 'w1', module, title: module, x: 20, y: 16, w: 1440, h: 980, z: 10, workspace: 1, props }],
      focus: 'w1', workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 30 } }) });
};
const measure = async (sel: string, label: string) => {
  const m = await page.evaluate(`(() => {
    const root = document.querySelector('${sel}');
    if (!root) return { error: 'not found' };
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    let words = 0, controls = 0, glyphs = 0, longest = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) {
      const p = n.parentElement; if (!p || !vis(p)) continue;
      if (p.closest('details:not([open])')) continue;
      const t = (n.textContent || '').trim(); if (!t) continue;
      const w = t.split(/\\s+/).filter(Boolean).length; words += w;
      if (t.length > longest.length) longest = t;
    }
    root.querySelectorAll('button, input, select, textarea, a[href]').forEach((el) => { if (vis(el)) controls++; });
    root.querySelectorAll('svg').forEach((el) => { if (vis(el)) glyphs++; });
    return { words, controls, glyphs, longest: longest.slice(0, 120) };
  })()`);
  console.log(label, JSON.stringify(m));
  return m;
};
await seed('recall');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-win-id="w1"]', { timeout: 30000 });
await page.waitForTimeout(2500);
await measure('[data-testid="recall"]', 'RECALL');
await page.screenshot({ path: 'docs/evidence/tt116-recall-after.png' });
await seed('browser', { tabs: [{ id: 't1', url: 'about:blank', title: 'New tab' }], active: 't1', proxyAll: true });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-win-id="w1"]', { timeout: 30000 });
await page.waitForTimeout(2500);
await measure('[data-testid="browser"]', 'BROWSER');
await page.screenshot({ path: 'docs/evidence/tt116-browser-after.png' });
await browser.close();
