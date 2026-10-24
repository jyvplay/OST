/**
 * TT70 — built-but-untested rows given real mechanism tests (Chromium 143, production build, real pointer / real routes).
 *  WM-13  edge-hold: a REAL mouse drag of a title bar held still at the right edge for 600 ms+ moves the window to the
 *         next workspace and switches to it (persisted state read back from /api/state); releasing right after the hop
 *         does NOT also tile it; at the last workspace the edge hop is refused and the normal half-snap still works;
 *         a 300 ms touch of the edge does nothing; holding the left edge hops back.
 *  CT-01  share target: the manifest's share_target (GET, title/text/url) points at a route that serves the app;
 *         /?url=… opens a Browser window on the shared URL and cleans the query; a hostile javascript: URL never runs
 *         (no dialog; the tab falls back to a safe page). Send: Notes' Share calls navigator.share with the note's
 *         title and body — checked with an injected recorder, because headless Linux Chromium has no OS share sheet
 *         (so this row is PARTIAL: the OS half is not exercised).
 *  DP-13  density tokens: compact < balanced < touch for the title bar and --fs-target, no control below 24 px, and the
 *         SAME controls (by accessible name) in every density — density changes size, never capability. (Measured: the
 *         Files toolbar buttons are text-scaled, not density-scaled.)
 * Restores every setting it changes.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt70-rows.mts
 */
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt70-rows");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
const getSetting = async (k: string) => ((await api("GET", "/api/settings")).json.rows as { key: string; value: string }[]).find((r) => r.key === k)?.value;
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
async function putDesktop(workspaces = [{ id: 1, name: "Main" }]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces, activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const desk = async (): Promise<any> => (await api("GET", "/api/state?id=default")).json.row?.state;

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(init?: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const saved: [string, string][] = [];
for (const k of ["appearance.layout", "appearance.desktopView", "appearance.density"]) saved.push([k, (await getSetting(k)) ?? ""]);
await setSetting("appearance.desktopView", "classic");

try {
  await test("WM-13 edge-hold: a real drag held at the right edge ≥600 ms moves the window to the next workspace (no tiling on release); refused at the last workspace (half-snap still works); a 300 ms touch does nothing; the left edge hops back", { "WM-13": "full" }, async () => {
    await putDesktop([{ id: 1, name: "Main" }, { id: 2, name: "Second" }]);
    const page = await newPage();
    await page.goto(`${BASE}/?open=notes`, { waitUntil: "domcontentloaded" });
    const win = page.locator('[role=dialog][aria-label="Notes"]').first(); await win.waitFor({ timeout: 25_000 });
    const bar = win.locator(".fs-titlebar").first();
    const deskBox = await win.evaluate((el) => { const r = el.parentElement!.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, w: r.width }; });
    const grab = async () => { const b = (await bar.boundingBox())!; const x = b.x + Math.min(90, b.width / 4), y = b.y + b.height / 2; await page.mouse.move(x, y); await page.mouse.down(); return { x, y }; };
    const notesWs = async () => (await desk())?.windows?.find((w: { module: string }) => w.module === "notes")?.workspace ?? 1;
    // 1. hold at the right edge
    const w0 = (await win.boundingBox())!.width;
    let p = await grab();
    await page.mouse.move(deskBox.r - 3, p.y, { steps: 12 });
    await poll(async () => (await win.getAttribute("data-edge-hold")) === "right", "armed at the right edge", 2_000);
    await page.waitForTimeout(900);
    await poll(async () => (await desk())?.activeWorkspace === 2, "switched to workspace 2", 8_000);
    eq(await notesWs(), 2, "the dragged window moved with it");
    await page.mouse.up();
    await page.waitForTimeout(400);
    ok(Math.abs((await win.boundingBox())!.width - w0) < 2, `released at the edge right after the hop: not tiled (width ${w0} → ${(await win.boundingBox())!.width})`);
    // 2. last workspace: no hop; release at the edge tiles the right half as before
    p = await grab();
    await page.mouse.move(deskBox.r - 3, p.y, { steps: 12 });
    await page.waitForTimeout(900);
    eq(await win.getAttribute("data-edge-hold"), null, "never armed (no workspace to the right)");
    eq((await desk())?.activeWorkspace, 2, "still on the last workspace");
    await page.mouse.up();
    await poll(async () => Math.abs((await win.boundingBox())!.width - deskBox.w / 2) < 24, "the normal half-snap still works at the last workspace", 5_000);
    // 3. a brief touch of the left edge
    p = await grab();
    await page.mouse.move(deskBox.l + 2, p.y, { steps: 12 });
    await page.waitForTimeout(300);
    await page.mouse.move(deskBox.l + 400, p.y, { steps: 4 });
    await page.waitForTimeout(700);
    eq((await desk())?.activeWorkspace, 2, "300 ms at the edge then away: no hop");
    // 4. hold the left edge: back to workspace 1
    await page.mouse.move(deskBox.l + 2, p.y, { steps: 6 });
    await page.waitForTimeout(900);
    await page.mouse.up();
    await poll(async () => (await desk())?.activeWorkspace === 1 && (await notesWs()) === 1, "held at the left edge: back to workspace 1", 8_000);
    await page.context().close();
  });

  await test("CT-01 share target: manifest share_target → / ; ?url= opens a Browser tab on it and cleans the query; a javascript: URL never runs; Notes Share passes title + body to navigator.share (injected recorder — no OS share sheet in headless Linux)", { "CT-01": "partial" }, async () => {
    const man = await (await fetch(`${BASE}/manifest.webmanifest`)).json() as { share_target?: { action: string; method: string; params: Record<string, string> } };
    eq(man.share_target, { action: "/", method: "GET", params: { title: "title", text: "text", url: "url" } }, "manifest share_target");
    eq((await fetch(`${BASE}/?title=x&url=${encodeURIComponent("https://example.org/a")}`)).status, 200, "the share action route serves the app");
    await putDesktop();
    let page = await newPage();
    await page.goto(`${BASE}/?title=Shared&url=${encodeURIComponent("https://example.org/shared-page")}`, { waitUntil: "domcontentloaded" });
    const bw = page.locator('[role=dialog][aria-label="Shared link"]').first(); await bw.waitFor({ timeout: 25_000 });
    await poll(async () => /example\.org\/shared-page/.test(await bw.getByLabel("Address").inputValue()), "the Browser tab is on the shared URL");
    await poll(async () => (await page.evaluate(() => location.search)) === "", "the query is cleaned (reload does not re-open it)");
    await page.context().close();
    // hostile
    await putDesktop();
    page = await newPage();
    const dialogs: string[] = []; page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto(`${BASE}/?url=${encodeURIComponent("javascript:alert(document.domain)")}`, { waitUntil: "domcontentloaded" });
    const hw = page.locator('[role=dialog][aria-label="Shared link"]').first(); await hw.waitFor({ timeout: 25_000 });
    await page.waitForTimeout(1500);
    eq(dialogs, [], "no script ran");
    const addr = await hw.getByLabel("Address").inputValue();
    ok(!/^javascript:/i.test(addr) && !/alert/.test(addr), `the tab never holds the javascript: URL (got ${addr})`);
    await page.context().close();
    // send: Notes → navigator.share
    const r = await api("POST", "/api/notes", { title: `Share ${Date.now()}`, body: "Body line one\nline two", tags: "" });
    const id = r.json?.row?.id ?? r.json?.id; ok(id, `note created: ${JSON.stringify(r.json).slice(0, 120)}`);
    await putDesktop();
    page = await newPage("Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shared = d; } });");
    await page.goto(`${BASE}/?open=notes`, { waitUntil: "domcontentloaded" });
    const nw = page.locator('[role=dialog][aria-label="Notes"]').first(); await nw.waitFor({ timeout: 25_000 });
    const title = r.json?.row?.title ?? r.json?.title;
    await nw.getByRole("button", { name: new RegExp(title) }).first().click();
    await nw.getByRole("button", { name: "Share", exact: true }).click();
    await poll(async () => !!(await page.evaluate(() => (window as unknown as { __shared?: unknown }).__shared)), "navigator.share called");
    eq(await page.evaluate(() => (window as unknown as { __shared?: unknown }).__shared), { title, text: "Body line one\nline two" }, "shared payload");
    await api("DELETE", `/api/notes?id=${id}`);
    await page.context().close();
  });

  await test("DP-13 density tokens: compact < balanced < touch (title bar, --fs-target), no control under 24 px, and every density offers the SAME controls by accessible name", { "DP-13": "full" }, async () => {
    const out: Record<string, { bar: number; target: number; minBtn: number; names: string[] }> = {};
    for (const d of ["compact", "balanced", "touch"]) {
      await setSetting("appearance.density", d);
      await putDesktop();
      const page = await newPage();
      await page.goto(`${BASE}/?open=files`, { waitUntil: "domcontentloaded" });
      const fw = page.locator('[role=dialog][aria-label="Files"]').first(); await fw.waitFor({ timeout: 25_000 });
      await poll(async () => (await page.evaluate(() => document.documentElement.dataset.density)) === d, `root density ${d}`);
      await page.waitForTimeout(600);
      out[d] = await fw.evaluate((el) => {
        const bar = (el.querySelector(".fs-titlebar") as HTMLElement).getBoundingClientRect().height;
        const probe = document.createElement("div"); probe.style.cssText = "position:absolute;height:var(--fs-target);width:1px"; document.body.appendChild(probe);
        const target = probe.getBoundingClientRect().height; probe.remove();
        const btns = [...el.querySelectorAll("button")].filter((b) => (b as HTMLElement).offsetParent !== null);
        const names = [...new Set(btns.map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim()).filter(Boolean))].sort();
        const minBtn = Math.min(...btns.map((b) => b.getBoundingClientRect().height).filter((h) => h > 0));
        return { bar, target, minBtn, names };
      });
      await page.context().close();
    }
    const { compact: c, balanced: b, touch: t } = out;
    ok(c.bar < b.bar && b.bar < t.bar, `title bar compact ${c.bar} < balanced ${b.bar} < touch ${t.bar}`);
    ok(c.target < b.target && b.target < t.target, `--fs-target compact ${c.target} < balanced ${b.target} < touch ${t.target}`);
    // measured: the Files toolbar's smallest control is text-scaled, not density-scaled (25 px in all three) — so the
    // claim is only that no density shrinks a control below the WCAG 2.5.8 24 px minimum
    ok(Math.min(c.minBtn, b.minBtn, t.minBtn) >= 24, `every density keeps controls ≥ 24 px (${c.minBtn} / ${b.minBtn} / ${t.minBtn})`);
    console.log(`    (title bar ${c.bar}/${b.bar}/${t.bar} px · --fs-target ${c.target}/${b.target}/${t.target} px · smallest Files control ${c.minBtn}/${b.minBtn}/${t.minBtn} px)`);
    eq(c.names, b.names, "compact offers the same controls as balanced");
    eq(t.names, b.names, "touch offers the same controls as balanced");
    ok(b.names.length >= 5, `a real toolbar was compared (${b.names.length} controls)`);
  });
} finally {
  for (const [k, v] of saved) if (v) await setSetting(k, v);
  await putDesktop();
  await browser.close();
}
if (errors.length) console.log("page errors:", errors.slice(0, 5));
finish();
