/**
 * TT56 — rows whose spec acceptance criteria had never been asserted, checked against ground truth outside the UI:
 *   DP-01 account-free: no login/auth route exists (HTTP), no auth library in the client bundle (.next/static grep)
 *   DP-02 no ads / feeds / upsells: source + client-bundle grep for ad/promo/upsell components and ad SDK markers === 0
 *   RG-03 idle loop suspension: no requestAnimationFrame callbacks while the desktop is static (counted in the page)
 *   RG-07 capability report: ≥ 40 probed APIs, each with degrade text, sampled rows match independent feature detection
 *   SC-03 permission audit: the Settings list covers the full permission-name list and every state equals an independent
 *         navigator.permissions.query in the same page
 *   AX-04 focus not obscured: Tab-focusing a control inside a covered window raises it (server z-order / focus)
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt56-rows.mts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { PERMISSION_NAMES } from "../src/lib/permissions.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt56-rows");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
const walk = (dir: string, out: string[] = []): string[] => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };
const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(init?: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); ctx.setDefaultTimeout(20_000);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("launcher-button").waitFor({ timeout: 30_000 });
  return page;
}

await test("DP-01 account-free: no login / auth route answers, no auth library or sign-in call in the client bundle", { "DP-01": "full" }, async () => {
  for (const p of ["/login", "/signin", "/sign-in", "/signup", "/register", "/account", "/auth", "/api/auth", "/api/auth/session", "/api/login", "/oauth/authorize"]) {
    const r = await fetch(BASE + p, { redirect: "manual" });
    ok(r.status === 404, `${p} answered ${r.status}`);
  }
  ok(!walk("src/app").some((f) => /(^|\/)(login|signin|sign-in|signup|auth|account|register)(\/|$)/i.test(f.slice(8))), "an auth route directory exists in src/app");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")); const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  eq(deps.filter((d) => /next-auth|@auth\/|clerk|auth0|firebase|supabase|passport|lucia|@okta|keycloak/i.test(d)), [], "auth dependencies");
  const js = walk(".next/static").filter((f) => f.endsWith(".js"));
  ok(js.length > 20, `client bundle found (${js.length} files)`);
  const hits = js.filter((f) => /next-auth|signInWithPopup|\/api\/auth\/session|getServerSession/.test(readFileSync(f, "utf8")));
  eq(hits, [], "auth code in the client bundle");
});

await test("DP-02 no ads, feeds or upsells: zero ad/promo/upsell components or strings in src/, zero ad-SDK markers in the client bundle", { "DP-02": "full" }, async () => {
  const AD = /\b(Advert[A-Za-z]*|Promo[A-Za-z]*|Upsell[A-Za-z]*|Sponsor[A-Za-z]*|AdBanner|AdSlot|adsbygoogle|googletag|pagead2)\b|Upgrade to (Pro|Premium)|Go Pro\b|Buy now|Limited[- ]time offer|Sponsored/;
  // the shields block list names ad hosts in order to BLOCK them; feature-table text describes the policy
  const allowed = new Set(["src/lib/wp-core.ts"]);
  const files = walk("src").filter((f) => /\.(tsx?|css)$/.test(f) && !f.includes("seed-data") && !allowed.has(f));
  const hits = files.flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => AD.test(l)).map(([f, n]) => `${f}:${n}`));
  eq(hits, [], "ad/promo/upsell markers in src/");
  eq(walk("src").filter((f) => /(^|\/)(ad|ads|advert|promo|upsell|sponsor)[-_.A-Z]/i.test(f.split("/").pop()!)), [], "ad/promo file names");
  const js = walk(".next/static").filter((f) => f.endsWith(".js"));
  eq(js.filter((f) => /adsbygoogle|googletag\.cmd|pagead2\.googlesyndication|securepubads/.test(readFileSync(f, "utf8"))), [], "ad SDK markers in the client bundle");
});

await test("RG-03 idle: with the desktop static for 3 s, zero requestAnimationFrame callbacks run (rAF counted by an init script)", { "RG-03": "full" }, async () => {
  await putDesktop([]);
  const page = await newPage(`(() => { const raf = window.requestAnimationFrame.bind(window); window.__rafCalls = 0; window.__rafStacks = [];
    window.requestAnimationFrame = (cb) => raf((t) => { window.__rafCalls++; if (window.__rafStacks.length < 5) window.__rafStacks.push(String(cb).slice(0, 120)); cb(t); }); })();`);
  await page.waitForTimeout(4000);                     // boot settles (hydration, first paint work)
  await page.mouse.move(5, 5);
  await page.evaluate(() => { (window as unknown as { __rafCalls: number; __rafStacks: string[] }).__rafCalls = 0; (window as unknown as { __rafStacks: string[] }).__rafStacks = []; });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => ({ n: (window as unknown as { __rafCalls: number }).__rafCalls, who: (window as unknown as { __rafStacks: string[] }).__rafStacks }));
  eq(r.n, 0, `rAF callbacks while static (${JSON.stringify(r.who)})`);
  await page.context().close();
});

await test("RG-07 capability report: ≥ 40 APIs in Settings → Capabilities, each row has detail/degrade text, sampled rows equal independent detection", { "RG-07": "full" }, async () => {
  await putDesktop([]);
  const page = await newPage();
  await page.goto(BASE + "/?open=settings", { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Settings"]').first(); await dlg.waitFor({ timeout: 25_000 });
  await dlg.getByRole("tab", { name: /capabilities/i }).click();
  const rows = dlg.locator(".fs-row:has(> span > div.fs-mono)");
  await poll(async () => (await rows.count()) >= 40, "≥ 40 capability rows");
  const all = await rows.evaluateAll((els) => els.map((e) => ({ label: e.querySelector("span > div")?.textContent ?? "", text: e.querySelector(".fs-mono")?.textContent ?? "", yes: (e.querySelector(".fs-badge, [class*=badge]")?.textContent ?? e.lastElementChild?.textContent ?? "").trim() })));
  ok(all.every((r) => r.text.trim().length > 5), "every row has detail/degrade text");
  const truth = await page.evaluate(() => ({
    "Fullscreen": !!document.documentElement.requestFullscreen,
    "Keyboard Lock (system chords)": "keyboard" in navigator && "lock" in ((navigator as unknown as { keyboard: object }).keyboard ?? {}),
    "Document Picture-in-Picture": "documentPictureInPicture" in window,
    "Multi-screen window placement": "getScreenDetails" in window,
  }));
  for (const [label, want] of Object.entries(truth)) {
    const row = all.find((r) => r.label === label); ok(row, `row ${label}`);
    eq(row!.yes, want ? "yes" : "no", label);
  }
  await page.context().close();
});

await test("SC-03 permission audit: Settings lists every name of the full permission list, each state equals an independent permissions.query", { "SC-03": "full" }, async () => {
  await putDesktop([]);
  const page = await newPage();
  await page.goto(BASE + "/?open=settings", { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Settings"]').first(); await dlg.waitFor({ timeout: 25_000 });
  await dlg.getByRole("tab", { name: /capabilities/i }).click();
  const list = dlg.getByTestId("perm-audit");
  await poll(async () => (await list.locator("[data-perm]").count()) === PERMISSION_NAMES.length, `${PERMISSION_NAMES.length} permission rows`);
  const ui = await list.locator("[data-perm]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-perm"), e.getAttribute("data-state"), e.getAttribute("data-used")]));
  eq(ui.map((r) => r[0]), [...PERMISSION_NAMES], "full name list, registry order");
  const truth = await page.evaluate(async (names) => Promise.all(names.map(async (name) => {
    try { const s = await navigator.permissions.query((name === "push" ? { name, userVisibleOnly: true } : { name }) as PermissionDescriptor); return s.state; } catch { return "not queryable"; }
  })), [...PERMISSION_NAMES]);
  eq(ui.map((r) => r[1]), truth, "states equal independent queries");
  ok(ui.filter((r) => r[2] === "0").length >= 15, "most names are never requested by Fusion");
  ok(!ui.some((r) => r[2] === "0" && r[1] === "granted"), "nothing Fusion never requests is granted");
  await page.context().close();
});

await test("AX-04 focus not obscured: Tab into a control of a covered window raises that window (server focus + top z); programmatic focus does not", { "AX-04": "full" }, async () => {
  // Clock fully covers Calculator; Clock's title bar is clickable outside Calculator's rectangle whatever the initial z
  const w = (id: string, module: string, title: string, x: number, y: number, ww: number, hh: number, z: number) => ({ id, module, title, x, y, w: ww, h: hh, z, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
  await putDesktop([w("x1", "calculator", "Calculator", 160, 140, 340, 380, 11), w("x2", "clock", "Clock", 60, 60, 760, 560, 12)]);
  const page = await newPage();
  await page.locator('.fs-window[aria-label="Calculator"]').first().waitFor();
  await page.locator('.fs-window[aria-label="Clock"] .fs-titlebar').click({ position: { x: 620, y: 8 } });
  const st = async () => (await api("GET", "/api/state?id=default")).json.row.state;
  await poll(async () => (await st()).focus === "x2", "Clock focused and on top");
  // programmatic focus into the covered window: no raise
  await page.evaluate(() => (document.querySelector('.fs-window[aria-label="Calculator"] button') as HTMLButtonElement).focus());
  await page.waitForTimeout(800);
  eq((await st()).focus, "x2", "programmatic focus did not raise");
  // keyboard: focus the last control of Clock, then Tab until focus lands inside Calculator
  let inside = false;
  for (let i = 0; i < 80 && !inside; i++) {
    await page.keyboard.press("Tab");
    inside = await page.evaluate(() => !!document.activeElement?.closest('.fs-window[aria-label="Calculator"]'));
  }
  ok(inside, "Tab reached a control inside the covered Calculator window");
  await poll(async () => { const s = await st(); const z = Object.fromEntries(s.windows.map((x: { id: string; z: number }) => [x.id, x.z])); return s.focus === "x1" && z.x1 > z.x2; }, "covered window raised on keyboard focus");
  const covered = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement; const r = a.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (top === a || a.contains(top) || !!top.closest('.fs-window[aria-label="Calculator"]'));
  });
  ok(covered, "the focused control is the topmost element at its own centre");
  await page.context().close();
});

await test("no uncaught page errors", { "DP-01": "full" }, () => { eq(errors, [], "page errors"); });
await browser.close();
await putDesktop([]);
void existsSync;
await finish();
process.exit(0);
