/** TT124 — density + visual contract for the twenty Class-A additions.
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
const { test, finish } = makeHarness("tt124-density");
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

// BOUNDS_TT124
const APPS: [string, number][] = [
  ["editor", 210], ["clock", 340], ["pdf", 400], ["peek", 260], ["lens", 320], ["monitor", 520],
  ["writer", 900], ["imageedit", 320], ["media", 340], ["contacts", 240], ["messages", 400],
  ["photos", 240], ["vector", 340], ["capture", 320], ["together", 340], ["routines", 300],
  ["spec", 12_400], ["beam", 320], ["ssh", 320], ["storage", 480],
];

for (const [module, bound] of APPS) {
  await test(`density ${module}: words<=${bound}`, { "AX-24": "mechanism" }, async () => {
    const m = await visit(module, module === "editor" ? { path: "/tt124.txt" } : {});
    assert.ok(m.words > 0, `${module} rendered no words`);
    assert.ok(m.words <= bound, `${module} words ${m.words} > ${bound}`);
  });
}

await test("TT124 register: all twenty codes built, register grew past TT123's 567", { "ED-08": "full", "SSH-02": "full" }, async () => {
  const r = await api<{ rows?: { code: string; status: string }[] }>("GET", "/api/features");
  const byCode = new Map((r.rows ?? []).map((f) => [f.code, f.status]));
  for (const c of ["ED-08", "CK-08", "PD-02", "PK-02", "LN-17", "MN-02", "WR-01", "IE-01", "MD-12", "CN-10", "MS-06", "PH-08", "VT-02", "CP-02", "TG-01", "RT-03", "SP-03", "BM-02", "SSH-02", "AX-26"]) {
    assert.equal(byCode.get(c), "built", `${c} must be built`);
  }
  assert.ok((r.rows ?? []).length >= 587, `register ${r.rows?.length} >= 587`);
});


await test("AX-26: indent and compare glyphs render on their buttons", { "AX-26": "full" }, async () => {
  await visit("editor", { path: "/tt124.txt" });
  const indents = await page.evaluate(() => {
    const btns = [document.querySelector('[data-testid="editor-indent"]'), document.querySelector('[data-testid="editor-dedent"]')];
    return btns.every((b) => b && b.querySelectorAll("svg").length >= 1);
  });
  assert.ok(indents, "editor indent/dedent carry drawn glyphs");
  const png = await import("node:fs").then((fs) => fs.readFileSync("public/icon-192.png").toString("base64"));
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt124-ie.png", content: png, encoding: "base64", mime: "image/png", reason: "tt124-density" });
  await visit("imageedit", { path: "/Pictures/tt124-ie.png" });
  await page.locator('[data-win-id="w1"] >> text=Quick edit (classic)').first().click({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('[data-win-id="w1"] [data-testid="ie-compare"]') !== null, null, { timeout: 15_000 });
  const cmp = await page.evaluate(() => document.querySelector('[data-testid="ie-compare"]')?.querySelectorAll("svg").length ?? -1);
  assert.ok(cmp >= 1, "image compare carries a drawn glyph");
});


await test("screenshots: writer goal dialog + spec family progress", { "WR-01": "mechanism", "SP-03": "mechanism" }, async () => {
  await visit("writer");
  await page.locator('[data-win-id="w1"] [data-testid="writer-word-count-open"]').click({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="writer-goal-start"]') !== null, null, { timeout: 10_000 });
  await page.screenshot({ path: "docs/screens/tt124-writer.png" });
  await visit("spec");
  await page.waitForFunction(() => document.querySelector('[data-testid="spec-family-progress"]') !== null, null, { timeout: 10_000 }).catch(() => null);
  await page.screenshot({ path: "docs/screens/tt124-spec.png" });
});

await context.close();
await browser.close();
finish();
