/** TT123 — density + visual contract for the twenty Class-A additions.
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
const { test, finish } = makeHarness("tt123-density");
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

// BOUNDS_TT123
const APPS: [string, number][] = [
  ["whiteboard", 260], ["vector", 320], ["beam", 300], ["privacy", 420], ["ssh", 300],
  ["clock", 320], ["editor", 200], ["notes", 120], ["backup", 470], ["terminal", 260],
  ["calculator", 260], ["messages", 380], ["photos", 220], ["planner", 260], ["find", 320],
  ["devices", 300], ["slides", 380], ["contacts", 220], ["files", 320], ["streams", 380],
];

for (const [module, bound] of APPS) {
  await test(`density ${module}: words<=${bound}`, { "AX-24": "mechanism" }, async () => {
    const m = await visit(module, module === "editor" ? { path: "/tt123.txt" } : {});
    assert.ok(m.words > 0, `${module} rendered no words`);
    assert.ok(m.words <= bound, `${module} words ${m.words} > ${bound}`);
  });
}

await test("TT123 register: all twenty codes built, register grew past TT122's 547", { "WB-07": "full", "FM-19": "full" }, async () => {
  const r = await api<{ rows?: { code: string; status: string }[] }>("GET", "/api/features");
  const byCode = new Map((r.rows ?? []).map((f) => [f.code, f.status]));
  for (const c of ["WB-07", "VT-01", "BM-01", "AL-01", "SSH-01", "CK-07", "ED-07", "NT-07", "BK-11", "TM-06", "CV-03", "MS-05", "PH-07", "PL-08", "SR-12", "DV-02", "SL-01", "CN-09", "AX-25", "FM-19"]) {
    assert.equal(byCode.get(c), "built", `${c} must be built`);
  }
  assert.ok((r.rows ?? []).length >= 567, `register ${r.rows?.length} >= 567`);
});

await test("AX-25: shuffle and wrap glyphs render beside their labels", { "AX-25": "full" }, async () => {
  const png = await import("node:fs").then((fs) => fs.readFileSync("docs/screens/tt123-devices.png").toString("base64"));
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt123-a.png", content: png, encoding: "base64", mime: "image/png", reason: "tt123-density" });
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt123-b.png", content: png, encoding: "base64", mime: "image/png", reason: "tt123-density" });
  await visit("photos");
  await page.waitForSelector('[data-testid="photos-shuffle"]', { timeout: 10_000 });
  const shuffle = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="photos-shuffle"]');
    return btn ? btn.querySelectorAll("svg").length : -1;
  });
  assert.ok(shuffle >= 1, "photos shuffle has a drawn glyph");
  await visit("editor", { path: "/tt123.txt" });
  const wrap = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-win-id="w1"] button')].find((b) => (b.textContent ?? "").includes("Wrap"));
    return btn ? btn.querySelectorAll("svg").length : -1;
  });
  assert.ok(wrap >= 1, "editor wrap has a drawn glyph");
  const carets = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-win-id="w1"] button')].filter((b) => b.getAttribute("aria-label")?.includes("match"));
    return btns.length === 2 && btns.every((b) => b.querySelectorAll("svg").length >= 1);
  });
  assert.ok(carets, "match-step buttons carry drawn carets, not text arrows");
});

await test("screenshots: devices + spec", { "DV-02": "full", "AX-25": "mechanism" }, async () => {
  await visit("devices");
  await page.screenshot({ path: "docs/screens/tt123-devices.png" });
  await visit("spec");
  await page.waitForFunction(() => document.querySelector('[data-testid="spec-family-progress"]') !== null, null, { timeout: 10_000 }).catch(() => null);
  await page.screenshot({ path: "docs/screens/tt123-spec.png" });
});

await context.close();
await browser.close();
finish();
