/** TT125 — density + visual contract for the twenty Class-A additions.
 * One Chromium, ONE shared context (the TT122 warm-context win), readiness
 * waits instead of fixed sleeps. Per-app bounds are caps set this turn for the touched modules (first-run
 * actuals all landed under them; list content that scales with seeded data
 * uses the session-data treatment, as recorded in DESIGN-TT122). */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("tt125-density");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}
const MEASURE = `(sel) => {
  const root = document.querySelector(sel);
  if (!root) return { error: 'no window' };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let words = 0, glyphs = 0, controls = 0;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) {
    const p = n.parentElement;
    if (!p || !vis(p) || p.closest('details:not([open])')) continue;
    const t = (n.textContent || '').trim();
    if (t) words += t.split(/\\s+/).filter(Boolean).length;
  }
  root.querySelectorAll('svg').forEach((el) => { if (vis(el)) glyphs++; });
  root.querySelectorAll('button, input, select, textarea').forEach((el) => { if (vis(el)) controls++; });
  return { words, glyphs, controls, text: (root.textContent || '').length };
}`;

const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);

async function visit(module: string, props: Record<string, unknown> = {}) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"]')?.textContent ?? "").length > 30, null, { timeout: 8_000 }).catch(() => null);
  await page.waitForTimeout(200);
  return await page.evaluate(`(${MEASURE})('[data-win-id="w1"]')`) as { words: number; glyphs: number; controls: number };
}

// BOUNDS_TT125 — first-turn caps for the twenty touched modules (actuals all
// landed under them on this build; list content that scales with seeded data
// keeps the TT120/TT122 session-data treatment).
const APPS: [string, number][] = [
  ["editor", 70], ["files", 260], ["pdf", 90], ["writer", 160], ["beam", 320],
  ["devices", 400], ["vault", 120], ["planner", 160], // task list is session data: e2e leaves one done task behind ["terminal", 48], ["ssh", 80],
  ["recall", 200], ["peek", 200], ["whiteboard", 110], ["lens", 170], ["apps", 980],
  ["clipboard", 180], ["together", 120], ["settings", 1650], ["books", 300], ["capture", 320],
];
const results = new Map<string, { words: number; glyphs: number; controls: number }>();
for (const [id, cap] of APPS) {
  const r = await visit(id) as { words: number; glyphs: number; controls: number; error?: string };
  assert.ok(!r.error, `${id}: ${r.error}`);
  results.set(id, r);
  console.log(`    ${id.padEnd(12)} ${String(r.words).padStart(4)} words (cap ${cap})`);
}

await test("TT125 register: all twenty codes built, register grew past TT124's 587", { "SP-01": "mechanism" }, async () => {
  const j = await api<{ rows: { code: string; status: string }[] }>("GET", "/api/features");
  const codes = ["ED-10", "ED-09", "PD-03", "WR-02", "BM-03", "DV-03", "VA-03", "PL-10", "TM-08", "SSH-04", "RC-43", "PK-04", "WB-08", "LN-19", "LN-20", "AP-08", "CB-03", "TG-03", "ST-16", "BK-13"];
  for (const c of codes) {
    const row = j.rows.find((x) => x.code === c);
    assert.ok(row, `${c} missing`);
    assert.equal(row.status, "built", `${c} status`);
  }
  assert.ok(j.rows.length > 587, `register grew: ${j.rows.length}`);
});

await test("AX-24 bounds: every touched module within its TT125 cap", { "AX-24": "mechanism" }, () => {
  for (const [id, cap] of APPS) {
    const r = results.get(id)!;
    assert.ok(r.words <= cap, `${id}: ${r.words} words > bound ${cap}`);
  }
});

await test("screenshots: editor stamp toolbar + lens capability row", { "ED-10": "mechanism", "LN-19": "mechanism" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/Documents/tt125-case.txt", content: "the iPad's usb-c port stays camelCase here\n", reason: "tt125-density" });
  await visit("editor", { path: "/Documents/tt125-case.txt" });
  await page.screenshot({ path: "docs/screens/tt125-editor.png" });
  await visit("lens");
  await page.screenshot({ path: "docs/screens/tt125-lens.png" });
});

await browser.close();
finish();
