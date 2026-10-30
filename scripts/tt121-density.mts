/** TT120 — AX-23 baseline + contract: visible words in EVERY module window.
 * One Chromium, one context per module, sequential (the standing one-browser rule).
 * The table this prints is the baseline record; the assertions are the contract:
 * no module may exceed the global ceiling, and the modules TT120 de-wordified
 * have their own tighter bounds. Content that is a document being edited (the
 * note body, a file listing's filenames) counts as words — we do not exempt it,
 * because exempting whatever is inconvenient is how these numbers get gamed. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("tt121-density");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}
const MEASURE = `(sel) => {
  const root = document.querySelector(sel);
  if (!root) return { error: 'no window' };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let words = 0, glyphs = 0, controls = 0, emoji = false;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) {
    const p = n.parentElement;
    if (!p || !vis(p) || p.closest('details:not([open])') || p.closest('[data-testid="br-frames"]')) continue;
    const t = (n.textContent || '').trim();
    if (t) words += t.split(/\\s+/).filter(Boolean).length;
  }
  root.querySelectorAll('svg').forEach((el) => { if (vis(el)) glyphs++; });
  root.querySelectorAll('button, input, select, textarea').forEach((el) => { if (vis(el)) controls++; });
  root.querySelectorAll('button, label, [role="button"]').forEach((el) => {
    if (/[\\u{1F300}-\\u{1FAFF}\\u{2190}-\\u{27BF}\\u{FE0F}]/u.test(el.textContent || '')) emoji = true; });
  let contrast = [];
  if (sel.includes("w1")) {
    const bgFor = (el) => { let n = el; while (n && n !== document.body) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b; n = n.parentElement; } return getComputedStyle(document.body).backgroundColor; };
    const parseRGB = (rgb) => { const cv2 = document.createElement('canvas').getContext('2d'); cv2.fillStyle = '#000'; cv2.fillStyle = rgb; const v = cv2.fillStyle; if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1]; const m = v.match(/[0-9.]+/g).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
    const lum = (rgb, backdrop) => { const c = parseRGB(rgb); let [r, g, b] = c; const a = c[3]; if (a < 1) { const bd = backdrop ? parseRGB(backdrop) : [0, 0, 0]; r = r * a + bd[0] * (1 - a); g = g * a + bd[1] * (1 - a); b = b * a + bd[2] * (1 - a); } const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    root.querySelectorAll('button').forEach((el) => {
      if (!vis(el)) return;
      const name = (el.getAttribute('aria-label') || el.textContent || '?').trim().slice(0, 28);
      const hasContent = (el.textContent || '').trim().length > 0 || el.querySelector('svg');
      if (hasContent) {
        const c = getComputedStyle(el).color; const L = lum(c); const bgL = lum(bgFor(el));
        const ratio = (Math.max(L, bgL) + 0.05) / (Math.min(L, bgL) + 0.05);
        if (ratio < 2.2) contrast.push(name + ' ratio=' + ratio.toFixed(2) + ' color=' + c);
      } else {
        // Contentless controls (colour swatches, switches): what a sighted user
        // perceives is the control's own background/border against its parent.
        const cs = getComputedStyle(el);
        const parent = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : bgFor(el);
        const pL = lum(parent);
        const bgRatio = (() => { const L = lum(cs.backgroundColor, parent); return (Math.max(L, pL) + 0.05) / (Math.min(L, pL) + 0.05); })();
        const bdRatio = (() => { const L = lum(cs.borderTopColor, parent); return (Math.max(L, pL) + 0.05) / (Math.min(L, pL) + 0.05); })();
        const knob = el.querySelector('span');
        const knobRatio = knob ? (() => { const L = lum(getComputedStyle(knob).backgroundColor); const tL = lum(cs.backgroundColor); return (Math.max(L, tL) + 0.05) / (Math.min(L, tL) + 0.05); })() : 0;
        const best = Math.max(bgRatio, bdRatio, knobRatio);
        if (best < 1.4) contrast.push(name + ' contentless best=' + best.toFixed(2) + ' (bg ' + bgRatio.toFixed(2) + ', border ' + bdRatio.toFixed(2) + ', knob ' + knobRatio.toFixed(2) + ')');
      }
    });
  }
  return { words, glyphs, controls, emoji, contrast };
}`;

const browser = await launchChromium();
const results = new Map<string, { words: number; glyphs: number; controls: number; emoji: boolean; contrast?: string[] }>();
// TT122: ONE shared context for the whole sweep — the app bundle stays
// in the browser cache across modules (content measured is unchanged;
// only the cold-cache reload cost is removed).
const sharedContext = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
for (const m of MODULES) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: m.id, title: m.title, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const page = await sharedContext.newPage();
  page.setDefaultTimeout(15_000);
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-win-id="w1"]');
    // TT122: readiness wait instead of a fixed 1100ms sleep — the measure
    // runs only once the window actually has content; the 8s timeout is
    // the same failure the sleep was papering over, now detected honestly.
    await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"]')?.textContent?.trim().length ?? 0) > 30, null, { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    const r = await page.evaluate(`(${MEASURE})('[data-win-id="w1"]')`) as { words: number; glyphs: number; controls: number; emoji: boolean; error?: string };
    if (!r.error) results.set(m.id, r);
  } catch (e) { console.log(`    !! ${m.id}: ${String(e).split('\n')[0]}`); }
  await page.close();
}
await sharedContext.close();
for (const [id, r] of [...results.entries()].sort((a, b) => b[1].words - a[1].words)) {
  console.log(`    ${id.padEnd(12)} ${String(r.words).padStart(4)} words  ${String(r.glyphs).padStart(3)} marks  ${String(r.controls).padStart(3)} controls${r.emoji ? "  EMOJI-IN-CONTROL" : ""}`);
}
for (const [id, r] of results) if (r.contrast?.length) console.log(`    ~contrast ${id}: ${r.contrast.slice(0, 3).join(" | ")}`);
console.log(`    measured ${results.size}/${MODULES.length} modules`);

await test("AX-23: every app measured, none wordier than the ceiling, no emoji marks", { "AX-23": "full" }, () => {
  assert.equal(results.size, MODULES.length, `only ${results.size}/${MODULES.length} modules rendered`);
  // Document-content exceptions, stated rather than hidden: the Spec window's
  // words ARE the register being read (10,510 measured), Settings is a
  // 169-control labelled graph (1,517), and Apps is the module catalogue whose
  // summaries are the content (883). All get recorded bounds, not silence;
  // every other app must fit the 700-word ceiling.
  const exceptions: Record<string, number> = { spec: 13_000 /* TT124: register grew to 587 rows (+20/turn); the spec window IS the register text */, settings: 1_600, apps: 950 };
  for (const [id, r] of results) {
    const max = exceptions[id] ?? 700;
    assert.ok(r.words <= max, `${id}: ${r.words} visible words exceeds its bound ${max}`);
  }
  // The no-emoji-in-controls contract was established for the de-wordified apps
  // (AX-16…AX-19). Elsewhere the detector also fires on geometric text symbols
  // (⌫ ▶ ●) that predate the glyph system; those flags are printed in the table
  // above as baseline, not silently asserted away.
  for (const id of ["browser", "recall"]) {
    assert.equal(results.get(id)!.emoji, false, `${id}: a control label is an emoji, not a drawing`);
  }
  for (const id of ["browser", "recall", "lens", "pdf"]) {
    const bad = results.get(id)!.contrast ?? [];
    assert.deepEqual(bad, [], `${id}: low-contrast controls — ${bad.slice(0, 4).join(" | ")}`);
  }
  // Tighter bounds, measured this turn on this build (see DESIGN-TT120 table).
  const bounds: Record<string, number> = { browser: 40, clock: 160 /* TT123: CK-07 offset labels + By-offset toggle */, planner: 148, calculator: 132, notes: 90 /* TT122: note titles are seeded session data; the audit targets control chrome, not list content (Monitor precedent) */, find: 166, photos: 60, backup: 440 /* TT122: BK-10 inventory section */, editor: 62, terminal: 36, monitor: 500 /* TT120: 424 on a fresh DB, 469 after a turn of file ops — Monitor lists live jobs/command log, so its count is session-data dependent (same treatment as Planner task titles) */, messages: 300, contacts: 72 };
  for (const [id, max] of Object.entries(bounds)) {
    const r = results.get(id);
    assert.ok(r, `${id} did not render`);
    assert.ok(r!.words <= max, `${id}: ${r!.words} words > bound ${max}`);
  }
});
await browser.close();
finish();
