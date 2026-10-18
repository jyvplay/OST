/**
 * Real-browser suite "e2e-tt36" (TT36) in headless Chromium against the production build, on REAL outside pages:
 *   - Reader view in a Private proxy tab (PR-07k): pypi.org/help/ becomes Fusion's reader page (article text, title,
 *     reading time; no script but the runtime; still an opaque origin; nothing contacted but Fusion); find in page
 *     works in the reader; an in-article link stays in the reader and the address follows; Back returns; "Original
 *     page" leaves the reader and the Reader button follows the page; Reader off returns to the normal page
 *   - Named profiles (PR-07o): two tabs in profile "Work" share one session and its cookies; a third tab on the same
 *     site ("this tab only") does not; switching that tab to Work joins the jar, switching a Work tab to "this tab
 *     only" leaves it; the profile is saved with the window; when the last Work tab closes, the session is deleted
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt36.mts
 */
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const HOST = new URL(BASE).host;
const { test: run, finish } = makeHarness("e2e-tt36");
const ONLY = process.env.ONLY ?? "";
const test: typeof run = ((name: string, rows: Record<string, string>, fn: () => Promise<void>) => (!ONLY || name.includes(ONLY) ? run(name, rows as never, fn) : Promise.resolve())) as typeof run;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
async function poll(fn: () => Promise<boolean>, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const tab = (id: string, url: string, profile?: string) => ({ id, url, title: new URL(url).host, group: "", pinned: false, asleep: false, ...(profile ? { profile } : {}) });
const browserWin = (tabs: ReturnType<typeof tab>[]) => ({ id: "b1", module: "browser", title: "Browser", x: 8, y: 8, w: 1420, h: 840, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { tabs, active: tabs[0].id, proxyAll: true } });

let browser: Browser;
const prevState = (await api("GET", "/api/state?id=default")).json.row?.state;
const prevView = (await api("GET", "/api/settings")).json.rows?.find((r: { key: string }) => r.key === "appearance.desktopView")?.value as string | undefined;

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
async function frameReady(page: Page, check: (f: Frame) => Promise<boolean>, what: string, ms = 30000): Promise<Frame> {
  let fr: Frame | undefined;
  await poll(async () => { fr = proxFrame(page); return !!fr && (await check(fr)); }, what, ms);
  return fr!;
}
const tabUrl = (page: Page) => page.getByTestId("wp-tab").getAttribute("data-url");
const isReader = (f: Frame) => f.url().includes("/__reader?u=");

try {
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
  browser = await launchChromium();

  await test("Reader view in a Private proxy tab (PR-07k): pypi.org/help/ as Fusion's reader page — article text, title and reading time, no script but the runtime, opaque origin, nothing contacted but Fusion; find works in the reader; an in-article link stays in the reader with the address following; Back; 'Original page' leaves the reader and the Reader button follows; Reader off returns to the normal page", { "PR-07k": "partial", "WP-05": "full" }, async () => {
    const { page, ctx, hosts } = await boot([browserWin([tab("t1", "https://pypi.org/help/")])]);
    try {
      await frameReady(page, async (f) => /^Help/.test(await f.title()), "help page (normal)");
      ok((await page.getByTestId("wp-reader").getAttribute("aria-pressed")) === "false", "reader off at first");
      await page.getByTestId("wp-reader").click();
      const rd = await frameReady(page, async (f) => isReader(f) && (await f.locator("article[data-reader]").count()) > 0, "reader page");
      const info = await rd.evaluate(() => ({
        title: document.querySelector("h1.reader-title")?.textContent ?? "", meta: document.querySelector("[data-reader-meta]")?.textContent ?? "",
        text: document.querySelector("article")!.textContent!.replace(/\s+/g, " ").slice(0, 400), scripts: [...document.scripts].map((s) => s.getAttribute("src")),
        origin: self.origin, inlineHandlers: document.querySelectorAll("[onclick],[onload],[onerror],[style]").length,
        links: [...document.querySelectorAll("article a[href]")].map((a) => a.getAttribute("href")!),
      }));
      console.log(`    reader: "${info.title}" — ${info.meta.replace(/\s+/g, " ").trim()}`);
      ok(/Help/.test(info.title) && /min read/.test(info.meta) && /Common questions/.test(info.text), JSON.stringify(info).slice(0, 300));
      ok(info.scripts.length === 1 && info.scripts[0] === "/wp-shim.js", `scripts: ${info.scripts}`);
      ok(info.origin === "null" && info.inlineHandlers === 0, "sandboxed, no inline handlers or styles");
      ok((await page.getByTestId("wp-reader").getAttribute("aria-pressed")) === "true", "Reader button pressed");
      ok(((await tabUrl(page)) ?? "") === "https://pypi.org/help/", "address unchanged by the reader");
      // find inside the reader
      await page.getByTestId("wp-find").fill("package");
      await page.getByTestId("wp-find").press("Enter");
      await poll(async () => /^1\/\d+$/.test((await page.getByTestId("wp-find-count").innerText()).trim()), "find in the reader");
      // an in-article link to another pypi page that is not bot-challenged
      const target = info.links.map((h) => ({ h, u: decodeURIComponent(/__reader\?u=([^&]+)/.exec(h)?.[1] ?? "") })).find((x) => /^https:\/\/pypi\.org\/(security|sponsors|stats|account\/login)\/?$/.test(x.u))
        ?? info.links.map((h) => ({ h, u: decodeURIComponent(/__reader\?u=([^&]+)/.exec(h)?.[1] ?? "") })).find((x) => /^https:\/\/(docs\.)?pypi\.org\//.test(x.u) && !/search|project/.test(x.u));
      ok(target, `an in-article pypi link among ${info.links.length}`);
      console.log(`    following ${target!.u}`);
      await rd.locator(`article a[href="${target!.h}"]`).first().click();
      await poll(async () => ((await tabUrl(page)) ?? "").startsWith(target!.u.replace(/\/$/, "")), "address follows the reader link");
      const rd2 = await frameReady(page, async (f) => isReader(f) && f.url().includes(encodeURIComponent(target!.u)) && (await f.locator("article[data-reader]").count()) > 0, "still in the reader on the new page");
      ok((await page.getByTestId("wp-reader").getAttribute("aria-pressed")) === "true", "still reader");
      await page.getByTestId("wp-back").click();
      await poll(async () => ((await tabUrl(page)) ?? "") === "https://pypi.org/help/", "Back to help");
      await frameReady(page, async (f) => isReader(f) && f.url().includes(encodeURIComponent("https://pypi.org/help/")), "help in the reader after Back");
      // "Original page" leaves the reader; the button follows the page
      const rd3 = proxFrame(page)!;
      await rd3.locator("[data-reader-original]").click();
      await frameReady(page, async (f) => !isReader(f) && /^Help/.test(await f.title()), "original page");
      await poll(async () => (await page.getByTestId("wp-reader").getAttribute("aria-pressed")) === "false", "Reader button follows the page");
      // and back on, then off via the button
      await page.getByTestId("wp-reader").click();
      await frameReady(page, async (f) => isReader(f), "reader again");
      await page.getByTestId("wp-reader").click();
      await frameReady(page, async (f) => !isReader(f) && /^Help/.test(await f.title()), "Reader off → normal page");
      void rd2;
      const foreign = [...hosts.keys()].filter((h) => h !== HOST);
      ok(foreign.length === 0, `direct contact: ${foreign.join(", ")}`);
    } finally { await ctx.close(); }
  });

  await test("reader endpoint headers (PR-07k): the reader page is served with a CSP sandbox (no same-origin), scripts only from Fusion (no inline script), no forms; a non-page address gets a plain refusal; a private address is refused (SSRF)", { "PR-07k": "partial" }, async () => {
    const s = await api("POST", "/api/wp-session", { ua: "desktop" });
    try {
      const r = await fetch(`${BASE}/api/wp/s/${s.json.sid}/__reader?u=${encodeURIComponent("https://pypi.org/security/")}`);
      const csp = r.headers.get("content-security-policy") ?? "";
      const body = await r.text();
      ok(r.status === 200 && /^sandbox /.test(csp) && !/allow-same-origin/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) && /form-action 'none'/.test(csp), `${r.status} ${csp}`);
      ok(/Reporting a security issue/.test(body) && (body.match(/<script/g) ?? []).length === 1, "content + one script (the runtime)");
      const bin = await fetch(`${BASE}/api/wp/s/${s.json.sid}/__reader?u=${encodeURIComponent("https://pypi.org/static/images/logo-small.8998e9d1.svg")}`);
      ok(bin.status === 415 || bin.status === 502 || bin.status === 404, `non-page → ${bin.status}`);
      const priv = await fetch(`${BASE}/api/wp/s/${s.json.sid}/__reader?u=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`);
      ok(priv.status === 403, `metadata address → ${priv.status}`);
    } finally { await api("DELETE", `/api/wp-session?sid=${s.json.sid}`); }
  });

  await test("named profiles (PR-07o): two tabs in profile Work share one session and its cookies, a third tab on the same site (this tab only) does not; switching it to Work joins the jar, switching a Work tab to 'this tab only' leaves it; the profile is saved with the window; closing the last Work tab deletes the Work session", { "PR-07o": "partial" }, async () => {
    const { page, ctx } = await boot([browserWin([tab("t1", "https://pypi.org/", "Work"), tab("t2", "https://pypi.org/help/", "Work"), tab("t3", "https://pypi.org/security/")])]);
    const sidNow = () => page.getByTestId("wp-tab").getAttribute("data-sid");
    const frameOf = (sid: string) => page.frames().find((f) => f.url().includes(`/api/wp/s/${sid}/`));
    const cookieIn = async (sid: string) => (await frameOf(sid)?.evaluate(() => document.cookie).catch(() => "")) ?? "";
    try {
      await frameReady(page, async (f) => (await f.locator("input[name=q]").count()) > 0, "tab 1 (Work)");
      ok((await page.getByTestId("wp-profile").inputValue()) === "Work", "tab 1 shows its profile");
      const badge = (id: string) => page.locator(`[data-tab=${id}] [data-tab-profile]`);
      ok((await badge("t1").textContent()) === "Work" && (await badge("t2").textContent()) === "Work" && (await badge("t3").count()) === 0, "tab chips show the profile");
      const work = (await sidNow())!;
      await frameOf(work)!.evaluate(() => { document.cookie = "fwp_work=signed-in; path=/; max-age=3600"; });
      await poll(async () => (await api("GET", `/api/wp-session?sid=${work}`)).json.cookies >= 1, "cookie in the Work jar");
      // tab 2, same profile: same session, sees the cookie on load
      await page.locator("[data-tab=t2]").click();
      await poll(async () => (await sidNow()) === work, "tab 2 uses the Work session");
      await poll(async () => /fwp_work=signed-in/.test(await cookieIn(work)), "tab 2 sees the Work cookie");
      // tab 3, this tab only: its own session, no cookie
      await page.locator("[data-tab=t3]").click();
      await poll(async () => { const s = await sidNow(); return !!s && s !== work && !!frameOf(s); }, "tab 3 has its own session");
      const own = (await sidNow())!;
      await poll(async () => (await frameOf(own)!.locator("h1").count()) > 0, "tab 3 loaded");
      ok(!/fwp_work/.test(await cookieIn(own)), "tab 3 must not see Work's cookie");
      // tab 3 joins Work
      await page.getByTestId("wp-profile").selectOption("Work");
      await poll(async () => (await sidNow()) === work, "tab 3 switched to the Work session");
      await poll(async () => (await badge("t3").textContent().catch(() => "")) === "Work", "tab 3's chip shows Work");
      await poll(async () => /fwp_work=signed-in/.test(await cookieIn(work)), "tab 3 now sees the Work cookie");
      await poll(async () => (await api("GET", `/api/wp-session?sid=${own}`)).status === 404, "tab 3's private session is gone once nothing uses it");
      // saved with the window
      await poll(async () => {
        const st = (await api("GET", "/api/state?id=default")).json.row?.state;
        const tabs = st?.windows?.find((w: { id: string }) => w.id === "b1")?.props?.tabs as { id: string; profile?: string }[] | undefined;
        return !!tabs && tabs.find((t) => t.id === "t3")?.profile === "Work";
      }, "profile saved in the window state", 15000);
      // tab 1 leaves Work
      await page.locator("[data-tab=t1]").click();
      await poll(async () => (await sidNow()) === work, "tab 1 on Work");
      await page.getByTestId("wp-profile").selectOption("");
      await poll(async () => { const s = await sidNow(); return !!s && s !== work; }, "tab 1 left Work");
      const t1own = (await sidNow())!;
      await poll(async () => !!frameOf(t1own) && (await frameOf(t1own)!.locator("input[name=q]").count()) > 0, "tab 1 reloaded on its own session");
      ok(!/fwp_work/.test(await cookieIn(t1own)), "tab 1 no longer has Work's cookie");
      ok((await api("GET", `/api/wp-session?sid=${work}`)).status === 200, "Work lives on (tabs 2 and 3 use it)");
      // close tabs 2 and 3 → Work is deleted
      await page.locator("[data-tab=t2]").click({ button: "middle" });
      await page.locator("[data-tab=t3]").click({ button: "middle" });
      await poll(async () => (await page.locator("[data-tab=t2], [data-tab=t3]").count()) === 0, "tabs closed");
      await poll(async () => (await api("GET", `/api/wp-session?sid=${work}`)).status === 404, "Work session deleted with its last tab");
    } finally { await ctx.close(); }
  });
} finally {
  await browser?.close();
  if (prevState) await api("PUT", "/api/state", { id: "default", revision: Number((await api("GET", "/api/state?id=default")).json.row?.revision ?? 1) + 1000, state: prevState });
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
}
await finish();
