/** TT117 — AX-19: the fourth de-wordification pass, now over BOTH Recall and Browser.
 * Same anti-cheat construction as tt116-density: controls are addressed by their
 * unchanged accessible names, marks must be real distinct SVG geometry, no emoji
 * may stand in for a drawing, and label-in-name is checked with ONE normaliser.
 * Thresholds were measured on the TT116 build before this pass (see DESIGN-TT117). */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("tt117-density");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}
const browser = await launchChromium();
async function openModule(module: string) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"]')?.textContent?.trim().length ?? 0) > 30, null, { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  return { page, context };
}
const MEASURE = `(sel) => {
  const root = document.querySelector(sel);
  if (!root) return { error: sel + ' did not render' };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let words = 0;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) {
    const p = n.parentElement;
    if (!p || !vis(p) || p.closest('details:not([open])')) continue;
    const t = (n.textContent || '').trim();
    if (t) words += t.split(/\\s+/).filter(Boolean).length;
  }
  let glyphs = 0, controls = 0, emoji = false;
  const shapes = new Map(); let empty = 0;
  root.querySelectorAll('svg').forEach((el) => { if (!vis(el)) return; glyphs++;
    const geom = [...el.querySelectorAll('path, rect, circle, line, polyline, polygon')]
      .map((x) => x.tagName + ':' + (x.getAttribute('d') || [x.getAttribute('x'), x.getAttribute('y'), x.getAttribute('width'), x.getAttribute('height'), x.getAttribute('cx'), x.getAttribute('cy'), x.getAttribute('r')].join(','))).join('|');
    if (!geom) { empty++; return; } shapes.set(geom, (shapes.get(geom) || 0) + 1); });
  root.querySelectorAll('button, input, select, textarea').forEach((el) => { if (vis(el)) controls++; });
  root.querySelectorAll('button, label, [role="button"]').forEach((el) => {
    if (/[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{27BF}\\u{FE0F}]/u.test(el.textContent || '')) emoji = true; });
  return { words, glyphs, controls, emoji, distinct: shapes.size, empty };
}`;

await test("AX-19: Recall under 160 words, Browser under 90, both drawn not emoji", { "AX-19": "full", "AX-18": "partial" }, async () => {
  const r = await openModule("recall");
  const rm = await r.page.evaluate(`(${MEASURE})('[data-testid="recall"]')`) as { words: number; glyphs: number; controls: number; emoji: boolean; distinct: number; empty: number; error?: string };
  assert.ok(!rm.error, rm.error);
  console.log(`    Recall: ${rm.words} words, ${rm.glyphs} marks, ${rm.controls} controls, ${rm.distinct} distinct shapes`);
  assert.ok(rm.words < 160, `Recall shows ${rm.words} visible words (TT116 ended at 153; TT117 added a manifest control)`);
  assert.equal(rm.emoji, false); assert.equal(rm.empty, 0);
  assert.ok(rm.distinct >= 20, `only ${rm.distinct} distinct shapes`);
  // TT117's new Recall controls answer to their full names.
  for (const name of ["Export archive manifest", "Verify a manifest against this archive"]) {
    assert.ok(await r.page.getByTestId("recall").getByLabel(name, { exact: true }).count() > 0, `missing control: ${name}`);
  }
  await r.context.close();

  const b = await openModule("browser");
  // Chrome only: the framed page (or its refusal panel) is content, not chrome.
  // The refusal explanation is not deleted to win this count — it is asserted
  // as a floor below whenever it is on screen.
  const bm = await b.page.evaluate(`(() => { const m = (${MEASURE})('[data-testid="browser"]'); return m; })()`) as typeof rm;
  const framesText = await b.page.getByTestId("br-frames").innerText().catch(() => "");
  if (/refuses to be embedded/.test(framesText)) {
    assert.match(framesText, /platform rule, not an app bug/, "the embed-refusal explanation was deleted to win the word count");
    assert.match(framesText, /X-Frame-Options/, "the refusal stopped naming the mechanism");
  }
  const chromeOnly = await b.page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="browser"]');
    const frames = root.querySelector('[data-testid="br-frames"]');
    const keep = frames.style.display; frames.style.display = 'none';
    const m = (${MEASURE})('[data-testid="browser"]');
    frames.style.display = keep; return m; })()`) as typeof rm;
  Object.assign(bm, chromeOnly);
  assert.ok(!bm.error, bm.error);
  console.log(`    Browser: ${bm.words} words, ${bm.glyphs} marks, ${bm.controls} controls, ${bm.distinct} distinct shapes`);
  assert.ok(bm.words < 90, `Browser shows ${bm.words} visible words`);
  assert.equal(bm.emoji, false); assert.equal(bm.empty, 0);
  for (const name of ["Export browser session", "Import browser session", "Site permissions", "Sleep other tabs", "Close duplicates"]) {
    const n = await b.page.getByTestId("browser").getByLabel(name, { exact: true }).count()
      + await b.page.getByTestId("browser").getByRole("button", { name, exact: true }).count();
    assert.ok(n > 0, `missing control: ${name}`);
  }
  await b.context.close();
});
await browser.close();
finish();
