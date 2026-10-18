/**
 * Real-browser suite "e2e-tt37" (TT37): Browser → Network route, in headless Chromium against the production
 * build, with pproxy 2.7.9 (MIT, an independent SOCKS5 / HTTP CONNECT server, test-only) as the upstream proxy and
 * real outside pages (pypi.org) behind it:
 *   - the panel tests a candidate route before using it, applies it, and the toolbar / status line follow; Private
 *     proxy tabs then load through it (pproxy's own log shows the requests), "New circuit" appears for SOCKS5,
 *     rotates the tab's isolation and reloads; the Tor check is run and its honest result printed
 *   - a dead route shows "The network route failed" in the tab instead of blaming the site
 *   - with an HTTP proxy route, the legacy reader (direct tabs) goes through it too, and .onion is refused with the
 *     reason; a page cannot re-route the server (cross-site PUT refused)
 * The route is restored to Direct in every case.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt37.mts
 */
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const HOST = new URL(BASE).host;
const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
const { test, finish } = makeHarness("e2e-tt37");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
};
async function poll(fn: () => Promise<boolean>, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const tab = (id: string, url: string) => ({ id, url, title: new URL(url).host, group: "", pinned: false, asleep: false });
const browserWin = (tabs: ReturnType<typeof tab>[]) => ({ id: "b1", module: "browser", title: "Browser", x: 8, y: 8, w: 1420, h: 840, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { tabs, active: tabs[0].id, proxyAll: true } });

// the independent upstream proxy
const pp = spawn(PPROXY, ["-l", "socks5://127.0.0.1:18250", "-l", "http://127.0.0.1:18280", "-v"], { stdio: ["ignore", "pipe", "pipe"] });
let ppLog = ""; pp.stdout!.on("data", (b) => (ppLog += b)); pp.stderr!.on("data", (b) => (ppLog += b));
await new Promise((r) => setTimeout(r, 1500));
const seen = (re: RegExp) => ppLog.split("\n").filter((l) => re.test(l)).length;

let browser: Browser;
const prevState = (await api("GET", "/api/state?id=default")).json.row?.state;
const prevView = (await api("GET", "/api/settings")).json.rows?.find((r: { key: string }) => r.key === "appearance.desktopView")?.value as string | undefined;
const prevLayout = (await api("GET", "/api/settings")).json.rows?.find((r: { key: string }) => r.key === "appearance.layout")?.value as string | undefined;
async function boot(windows: unknown[]): Promise<{ page: Page; ctx: BrowserContext; hosts: Map<string, number> }> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const hosts = new Map<string, number>();
  ctx.on("request", (r) => { const u = r.url(); if (/^https?:/.test(u)) { const h = new URL(u).host; hosts.set(h, (hosts.get(h) ?? 0) + 1); } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  return { page, ctx, hosts };
}
const proxFrame = (page: Page): Frame | undefined => page.frames().find((f) => f.url().includes("/api/wp/s/"));
const direct = () => api("PUT", "/api/wp-route", { spec: "direct" });

try {
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
  browser = await launchChromium();

  await test("Network route panel (WP-07): test a candidate SOCKS5 route on a real page, apply it — toolbar and status line follow, the Private proxy tab loads pypi.org through it (seen in the independent proxy's own log), 'New circuit' rotates the tab's isolation and reloads, the browser itself still contacts only Fusion; the Tor check result is printed as it is", { "WP-07": "full" }, async () => {
    await direct();
    const { page, ctx, hosts } = await boot([browserWin([tab("t1", "https://pypi.org/help/")])]);
    try {
      await poll(async () => /^Help/.test((await proxFrame(page)?.title()) ?? ""), "help page (direct)");
      ok(/Network route: Direct/.test(await page.getByTestId("br-route").innerText()), "toolbar shows Direct");
      await page.getByTestId("br-route").click();
      await poll(async () => (await page.getByTestId("route-choice").getAttribute("data-ready")) === "1", "route presets loaded");
      await page.getByTestId("route-choice").selectOption("custom");
      await page.getByTestId("route-custom").fill("socks5://127.0.0.1:18250");
      await page.getByTestId("route-test-url").fill("https://pypi.org/help/");
      const before = seen(/socks5 .*-> pypi\.org:443/);
      await page.getByTestId("route-test").click();
      await poll(async () => /Reached pypi\.org — HTTP 200 .* via SOCKS5 127\.0\.0\.1:18250/.test(await page.getByTestId("route-result").innerText()), "test result");
      ok(seen(/socks5 .*-> pypi\.org:443/) > before, "the test request went through pproxy");
      ok(/Now: Direct/.test(await page.getByTestId("route-current").innerText()), "testing does not apply");
      // the Tor check (default test address) — printed honestly; this sandbox cannot reach check.torproject.org
      await page.getByTestId("route-test-url").fill("");
      await page.getByTestId("route-test").click();
      await poll(async () => /Reached|Failed/.test(await page.getByTestId("route-result").innerText()), "tor check result");
      console.log(`    Tor check via pproxy: ${(await page.getByTestId("route-result").innerText()).slice(0, 160)}`);
      // apply
      await page.getByTestId("route-apply").click();
      await poll(async () => /Network route: SOCKS5 127\.0\.0\.1:18250/.test(await page.getByTestId("br-route").innerText()), "toolbar follows");
      ok((await api("GET", "/api/wp-route")).json.route.mode === "socks5", "server route applied");
      ok(/circuits isolated/.test(await page.getByTestId("route-current").innerText()), "isolation shown");
      // the tab now goes through the route
      const b2 = seen(/socks5 .*-> pypi\.org:443/);
      await page.getByTestId("wp-reload").click();
      await poll(async () => seen(/socks5 .*-> pypi\.org:443/) > b2 && /^Help/.test((await proxFrame(page)?.title()) ?? ""), "reload through the route");
      await poll(async () => /via SOCKS5 127\.0\.0\.1:18250/.test(await page.getByTestId("wp-via").innerText()), "status line shows the route");
      // new circuit
      const sid = await page.getByTestId("wp-tab").getAttribute("data-sid");
      await page.getByTestId("wp-circuit").click();
      await poll(async () => (await api("GET", `/api/wp-session?sid=${sid}`)).json.circuit === 1, "circuit rotated");
      await poll(async () => /New circuit \(1\)/.test(await page.getByTestId("wp-circuit").innerText()), "button shows the circuit");
      await poll(async () => /^Help/.test((await proxFrame(page)?.title()) ?? ""), "page reloaded on the new circuit");
      const foreign = [...hosts.keys()].filter((h) => h !== HOST);
      ok(foreign.length === 0, `the browser contacted: ${foreign.join(", ")}`);
      console.log(`    pproxy log: ${seen(/-> pypi\.org:443/)} tunnels to pypi.org:443 (names, not addresses)`);
    } finally { await ctx.close(); await direct(); }
  });

  await test("a dead route is named, not blamed on the site (WP-07): with the route pointing at a port where nothing listens, the Private proxy tab shows 'The network route failed' and how to fix it; back on Direct the page loads again", { "WP-07": "full" }, async () => {
    await api("PUT", "/api/wp-route", { spec: "socks5://127.0.0.1:1" });
    const { page, ctx } = await boot([browserWin([tab("t1", "https://pypi.org/security/")])]);
    try {
      await poll(async () => /network route failed/i.test((await proxFrame(page)?.locator("body").innerText()) ?? ""), "route error page");
      const text = (await proxFrame(page)!.locator("body").innerText()).replace(/\s+/g, " ");
      ok(/Network route/.test(text) && !/site refused/i.test(text), text.slice(0, 300));
      console.log(`    error page: ${text.slice(0, 200)}`);
      await direct();
      await page.getByTestId("wp-reload").click();
      await poll(async () => /Security/.test((await proxFrame(page)?.title()) ?? ""), "loads again on Direct");
    } finally { await ctx.close(); await direct(); }
  });

  await test("everything follows the route; pages cannot change it (WP-07): with an HTTP proxy route the legacy reader for direct tabs goes through it (the proxy's log), a .onion address is refused with the reason (Tor route needed), and a cross-site PUT to /api/wp-route is refused by the CSRF guard", { "WP-07": "full" }, async () => {
    try {
      ok((await api("PUT", "/api/wp-route", { spec: "http://127.0.0.1:18280" })).status === 200, "set HTTP route");
      const before = seen(/http .*-> pypi\.org:443/);
      const r = await fetch(`${BASE}/api/webproxy?mode=reader&url=${encodeURIComponent("https://pypi.org/security/")}`);
      const body = await r.text();
      ok(r.status === 200 && /security/i.test(body), `legacy reader ${r.status}`);
      ok(seen(/http .*-> pypi\.org:443/) > before, "legacy reader went through the HTTP proxy");
      const s = await api("POST", "/api/wp-session", { ua: "desktop" });
      const onion = await fetch(`${BASE}/api/wp/s/${s.json.sid}/http/duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/`);
      const ot = await onion.text();
      ok(onion.status >= 400 && /only be opened through the Tor route/.test(ot), `onion over HTTP proxy → ${onion.status}`);
      await api("DELETE", `/api/wp-session?sid=${s.json.sid}`);
      const evil = await api("PUT", "/api/wp-route", { spec: "socks5://203.0.113.9:1080" }, { origin: "null", "sec-fetch-site": "cross-site" });
      ok(evil.status === 403, `cross-site PUT → ${evil.status}`);
      ok((await api("GET", "/api/wp-route")).json.route.label === "HTTP proxy 127.0.0.1:18280", "route unchanged by the refused PUT");
      const bad = await api("PUT", "/api/wp-route", { spec: "ftp://x:1" });
      ok(bad.status === 400 && /supported proxies are socks5:\/\//.test(bad.json.error), `invalid spec → 400 (${bad.status} ${bad.json.error})`); // TT40: wording lists the new SOCKS4 / HTTPS kinds
    } finally { await direct(); }
  });

  await test("gamepad pointer (IN-07) with a scripted W3C-shape pad (no physical controller exists in this sandbox — the hardware is substituted, everything from navigator.getGamepads() on is real): appears on connect, the stick steers it onto the launcher button and A opens the launcher, B (Escape) closes it, X opens the desktop menu, the right stick scrolls the window under it, RB moves keyboard focus and the pointer follows, Start turns it off and on, disconnect removes it; no page errors", { "IN-07": "partial" }, async () => {
    const win = { id: "s1", module: "settings", title: "Settings", x: 820, y: 70, w: 560, h: 330, z: 12, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} };
    await api("PUT", "/api/settings", { key: "appearance.layout", value: "fusion" }); // the Fusion top bar has the launcher button; restored in finally
    await desktop([win]);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      const w = window as unknown as { __pad: unknown; __padOn: boolean };
      w.__pad = { id: "Scripted pad (test)", index: 0, connected: true, mapping: "standard", timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
      w.__padOn = false;
      const f = ((window as unknown as { __focusLog: string[] }).__focusLog = []);
      addEventListener("focusin", (e) => f.push("in " + (e.target as Element).outerHTML.slice(0, 60)), true);
      addEventListener("focusout", (e) => f.push("out " + (e.target as Element).outerHTML.slice(0, 40) + (((e.target as Element).isConnected) ? "" : " [detached]")), true);
      Object.defineProperty(navigator, "getGamepads", { value: () => (w.__padOn ? [w.__pad] : [null]), configurable: true });
    });
    const page = await ctx.newPage();
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    const setAxes = (a: number[]) => page.evaluate((v) => { (window as any).__pad.axes = v; }, a);
    // hold for 3 rendered frames, not a fixed time: the Gamepad API is polled once per frame, so a tap shorter than a
    // (busy) frame is invisible to any web page — real presses last 50–150 ms
    const frames = (n: number) => page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r(0) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    const press = async (i: number) => { await page.evaluate((k) => { (window as any).__pad.buttons[k].pressed = true; }, i); await frames(3); await page.evaluate((k) => { (window as any).__pad.buttons[k].pressed = false; }, i); await frames(3); };
    const cur = () => page.evaluate(() => { const c = document.querySelector("[data-testid=gp-cursor]") as HTMLElement; return { x: Number(c.dataset.x), y: Number(c.dataset.y), shown: c.dataset.shown === "1" }; });
    const moveTo = async (tx: number, ty: number) => {
      for (let i = 0; i < 600; i++) {
        const { x, y } = await cur(); const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
        if (d <= 3) { await setAxes([0, 0, 0, 0]); await page.waitForTimeout(40); return; }
        const m = Math.min(1, 0.3 + d / 350);
        await setAxes([(dx / d) * m, (dy / d) * m, 0, 0]); await page.waitForTimeout(16);
      }
      throw new Error(`could not steer to ${tx},${ty}`);
    };
    const centre = async (sel: string) => { const b = (await page.locator(sel).first().boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as const; };
    try {
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await poll(async () => (await page.getByTestId("launcher-button").count()) > 0, "shell");
      await page.waitForTimeout(800);
      ok(!(await cur()).shown, "no cursor before a pad connects");
      await page.evaluate(() => { (window as any).__padOn = true; dispatchEvent(new Event("gamepadconnected")); });
      await poll(async () => (await cur()).shown && /Gamepad pointer on/.test(await page.getByTestId("gp-live").innerText()), "cursor on connect");
      // launcher: steer + A
      await moveTo(...(await centre("[data-testid=launcher-button]")));
      await press(0);
      await poll(async () => (await page.locator('[aria-label="Launcher"]').count()) > 0, "A opened the launcher");
      await press(1);
      await poll(async () => (await page.locator('[aria-label="Launcher"]').count()) === 0, "B (Escape) closed it");
      // desktop menu: X on empty desktop
      await moveTo(300, 640);
      await press(2);
      await poll(async () => (await page.locator('[role="menu"]').count()) > 0, "X opened the desktop menu");
      await press(1); await page.mouse.click(600, 820); await page.waitForTimeout(200);
      // scroll the Settings window under the pointer
      const [sx, sy] = await centre('[role=dialog][aria-label="Settings"]');
      await moveTo(sx, sy + 40);
      const tops = () => page.evaluate(() => Array.from(document.querySelectorAll('[role=dialog][aria-label="Settings"] *')).reduce((n, e) => n + e.scrollTop, 0));
      const t0 = await tops();
      await setAxes([0, 0, 0, 1]); await page.waitForTimeout(450); await setAxes([0, 0, 0, 0]); await page.waitForTimeout(100);
      const t1 = await tops();
      ok(t1 - t0 > 100, `right stick scrolled ${t1 - t0} px`);
      // RB: focus moves, pointer follows
      const before = await page.evaluate(() => { (window as any).__focusLog.length = 0; return document.activeElement?.outerHTML.slice(0, 80) ?? ""; });
      await press(5);
      const f = await page.evaluate(() => { const a = document.activeElement as HTMLElement; const r = a.getBoundingClientRect(); return { html: a.outerHTML.slice(0, 80), r: { l: r.left, t: r.top, w: r.width, h: r.height } }; });
      const c = await cur();
      const flog = await page.evaluate(() => (window as any).__focusLog.join(" | "));
      ok(f.html !== before && c.x >= f.r.l - 1 && c.x <= f.r.l + f.r.w + 1 && c.y >= f.r.t - 1 && c.y <= f.r.t + f.r.h + 1, `focus ${f.html} @ ${JSON.stringify(f.r)}, cursor ${c.x},${c.y}; before ${before}; focus log: ${flog}`);
      // Start: off (no motion), on again
      await press(9);
      await poll(async () => !(await cur()).shown && /off/.test(await page.getByTestId("gp-live").innerText()), "Start turned it off");
      const p0 = await cur(); await setAxes([1, 0, 0, 0]); await page.waitForTimeout(300); await setAxes([0, 0, 0, 0]);
      const p1 = await cur(); ok(p1.x === p0.x, "no motion while off");
      await press(9);
      await poll(async () => (await cur()).shown, "Start turned it on again");
      // disconnect
      await page.evaluate(() => { (window as any).__padOn = false; dispatchEvent(new Event("gamepaddisconnected")); });
      await poll(async () => !(await cur()).shown, "cursor removed on disconnect");
      ok(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    } finally { await ctx.close(); }
  });

  await test("client resets never become uncaught exceptions (TT36 blocker, root-caused): a second production server of this build runs with an uncaught-exception recorder; cross-site writes refused by the CSRF guard (403) and malformed JSON (400) — the two answers src/proxy.ts gives itself — are reset by the client right after sending, ×3 each; the recorder stays empty (before the fix: 6 of 6 recorded, matching vercel/next.js#99278), and un-reset requests still get exactly 403 'refused: …' and 400 'malformed JSON body'", { "WP-07": "full" }, async () => {
    const port = 3990, log = `/tmp/fusion-uncaught-${process.pid}.log`, reqLog = `/tmp/fusion-requests-${process.pid}.log`;
    fs.rmSync(log, { force: true }); fs.rmSync(reqLog, { force: true });
    // bound exactly like the real server (-H 0.0.0.0): Next keeps a middleware rewrite internal only when its origin
    // matches the bind origin — under -H 127.0.0.1 the same rewrite became an HTTP request to itself (found here)
    const srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(port)], {
      env: { ...process.env, NODE_OPTIONS: `--require ${process.cwd()}/scripts/diag/uncaught-preload.cjs`, FUSION_UNCAUGHT_LOG: log, FUSION_REQUEST_LOG: reqLog }, stdio: "ignore",
    });
    const raw = (req: string, reset: boolean) => new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(req);
        if (reset) setImmediate(() => { s.resetAndDestroy(); resolve(""); });
      });
      let got = ""; s.on("data", (d) => { got += d; }); s.on("end", () => resolve(got)); s.on("close", () => resolve(got)); s.on("error", () => resolve(got));
      setTimeout(() => { s.destroy(); resolve(got); }, 4000);
    });
    const put = (origin: string, body: string, close = false) => `PUT /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${close ? "Connection: close\r\n" : ""}\r\n${body}`;
    try {
      await poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/wp-route`)).ok; } catch { return false; } }, "second server up", 30000);
      for (let i = 0; i < 3; i++) await raw(put("https://evil.test", "{}"), true);
      for (let i = 0; i < 3; i++) await raw(put(`http://127.0.0.1:${port}`, "{{{"), true);
      await new Promise((r) => setTimeout(r, 1500));
      const recorded = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      ok(!/uncaughtException/.test(recorded), `recorded:\n${recorded.slice(0, 800)}`);
      const a = await raw(put("https://evil.test", "{}", true), false), b = await raw(put(`http://127.0.0.1:${port}`, "{{{", true), false);
      ok(/^HTTP\/1\.1 403/.test(a) && /"error":"refused: /.test(a), `cross-site answer: ${a.slice(0, 200)}`);
      ok(/^HTTP\/1\.1 400/.test(b) && /"error":"malformed JSON body"/.test(b), `malformed answer: ${b.slice(0, 200)}`);
      const reqs = fs.readFileSync(reqLog, "utf8").trim().split("\n");
      ok(reqs.filter((l) => l === "PUT /api/state").length === 8 && !reqs.some((l) => l.includes("/api/refused")), `requests seen by the server: ${reqs.slice(-12).join(" | ")}`);
      console.log(`    recorder empty after 6 resets; 403 and 400 bodies unchanged; ${reqs.length} requests seen, none of them a self-proxied /api/refused`);
    } finally { srv.kill("SIGTERM"); fs.rmSync(log, { force: true }); fs.rmSync(reqLog, { force: true }); }
  });
} finally {
  await direct().catch(() => undefined);
  await browser?.close();
  pp.kill();
  if (prevState) await api("PUT", "/api/state", { id: "default", revision: Number((await api("GET", "/api/state?id=default")).json.row?.revision ?? 1) + 1000, state: prevState });
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
  if (prevLayout && prevLayout !== "fusion") await api("PUT", "/api/settings", { key: "appearance.layout", value: prevLayout });
}
await finish();
