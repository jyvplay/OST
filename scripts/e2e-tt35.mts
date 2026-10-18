/**
 * Real-browser suite "e2e-tt35" (TT35) — Fusion's private web proxy against REAL outside sites, in headless Chromium
 * against the production build:
 *   - pypi.org in a proxied Browser tab: the page renders with its own CSS and images while the browser contacts NO
 *     host but the Fusion server; the page lives in an opaque origin (cannot read the desktop's APIs, cannot write
 *     files via CSRF), its cookies / storage work through the runtime; the search FORM, a result LINK, Back /
 *     Forward, find in page, the Mobile identity and Save to Files all work
 *   - a proxied document opened top-level is still sandboxed (CSP sandbox → opaque origin)
 *   - yahoo.com / soundcloud.com: this sandbox's egress filter blocks them; the tab says so in plain words
 *   - github.com through the proxy (in this sandbox github is TLS-intercepted by the egress proxy; the server
 *     trusts the OS store via --use-system-ca, as browsers do)
 * Honesty: pypi.org and github.com are the outside sites this sandbox can reach. yahoo.com and soundcloud.com are
 * attempted for real; the result is the network block, which is what is asserted.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt35.mts
 */
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const HOST = new URL(BASE).host;
const { test: run, finish } = makeHarness("e2e-tt35");
const ONLY = process.env.ONLY ?? "";
const test: typeof run = ((name: string, rows: Record<string, string>, fn: () => Promise<void>) => (!ONLY || name.includes(ONLY) ? run(name, rows as never, fn) : Promise.resolve())) as typeof run;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const readNode = async (p: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(p)}`); return r.status === 200 ? r.json.node as { content: string; encoding?: string; mime?: string } : null; };
const removeFile = async (p: string) => { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); };
async function poll(fn: () => Promise<boolean>, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const tab = (id: string, url: string) => ({ id, url, title: new URL(url).host, group: "", pinned: false, asleep: false });
const browserWin = (tabs: ReturnType<typeof tab>[], extra: Record<string, unknown> = {}) => ({ id: "b1", module: "browser", title: "Browser", x: 8, y: 8, w: 1420, h: 840, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { tabs, active: tabs[0].id, proxyAll: true, ...extra } });

let browser: Browser;
const prevState = (await api("GET", "/api/state?id=default")).json.row?.state;
const prevView = (await api("GET", "/api/settings")).json.rows?.find((r: { key: string }) => r.key === "appearance.desktopView")?.value as string | undefined;

async function boot(windows: unknown[], withholdRuntime = false): Promise<{ page: Page; ctx: BrowserContext; hosts: Map<string, number> }> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (withholdRuntime) await ctx.route("**/wp-shim.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: NO_RUNTIME }));
  const hosts = new Map<string, number>();
  ctx.on("request", (r) => { const u = r.url(); if (/^https?:/.test(u)) { const h = new URL(u).host; hosts.set(h, (hosts.get(h) ?? 0) + 1); } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  return { page, ctx, hosts };
}
const proxFrame = (page: Page): Frame | undefined => page.frames().find((f) => f.url().includes("/api/wp/s/"));
async function frameReady(page: Page, test: (f: Frame) => Promise<boolean>, what: string, ms = 30000): Promise<Frame> {
  let fr: Frame | undefined;
  await poll(async () => { fr = proxFrame(page); return !!fr && (await test(fr)); }, what, ms);
  return fr!;
}
/** What a hostile page would do: aim the browser's own fetch at the desktop's origin. Fusion's in-page runtime would
 *  route such a call to the remote site instead, so the hostile-page tests WITHHOLD the runtime (wp-shim.js) — the
 *  isolation must hold on the browser's sandbox + CORS + the server's CSRF guard alone. */
const NO_RUNTIME = "/* runtime withheld: hostile-page model */";
const attack = async (base: string) => {
  const nf = fetch; // the runtime is withheld in the hostile-page tests, so this is the browser's own fetch
  const read = await nf(base + "/api/settings").then((r) => r.text()).then((t) => (t.includes('"rows"') ? "READ" : "other:" + t.slice(0, 60)), () => "blocked");
  await nf(base + "/api/fs", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ op: "write", path: "/Documents/csrf-probe.txt", content: "pwned" }) }).catch(() => undefined);
  return read;
};
const tabUrl = (page: Page) => page.getByTestId("wp-tab").getAttribute("data-url");

try {
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
  browser = await launchChromium();

  await test("pypi.org through the private proxy (WP-01, WP-02, WP-05): renders with its own CSS and images, every request the browser makes goes to the Fusion server only, the page is an opaque origin, cookies + storage work through the runtime; search FORM → site answer → Back → real LINK → Back → Forward, address bar follows", { "WP-01": "full", "WP-02": "full", "WP-05": "full" }, async () => {
    const { page, ctx, hosts } = await boot([browserWin([tab("t1", "https://pypi.org/")])]);
    try {
      const fr = await frameReady(page, async (f) => (await f.locator("input[name=q]").count()) > 0, "pypi home in the proxied frame");
      await poll(async () => (await fr.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length)) > 0, "an image decoded through the proxy");
      const look = await fr.evaluate(() => ({
        origin: self.origin, header: getComputedStyle(document.querySelector("header") ?? document.body).backgroundColor,
        font: getComputedStyle(document.body).fontFamily, sheets: document.styleSheets.length,
        cookie: (() => { document.cookie = "fwp_probe=1; path=/"; return document.cookie.includes("fwp_probe=1"); })(),
        storage: (() => { localStorage.setItem("k", "v"); return localStorage.getItem("k"); })(),
        ua: navigator.userAgent,
      }));
      console.log("    pypi look", JSON.stringify(look));
      ok(look.origin === "null", "opaque origin"); ok(look.sheets >= 2, "stylesheets attached"); ok(!/Times New Roman/.test(look.font) && look.font !== "", `site font applied (${look.font})`);
      ok(look.header !== "rgba(0, 0, 0, 0)", "header styled by the site's CSS"); ok(look.cookie, "document.cookie works in the opaque origin"); ok(look.storage === "v", "localStorage works (in memory)");
      ok(/Windows NT 10.0/.test(look.ua), "desktop identity");
      // the site's own same-origin fetches work from the opaque origin; a same-origin fetch to ANOTHER site still fails
      const so = await fr.evaluate(async () => ({
        own: await fetch("/_includes/unauthed/flash-messages/", { mode: "same-origin" }).then((r) => r.status, (e) => String(e)),
        ownReq: await fetch(new Request("/_includes/unauthed/flash-messages/", { mode: "same-origin", headers: { "x-probe": "1" } })).then((r) => r.status, (e) => String(e)),
        other: await fetch("https://github.com/robots.txt", { mode: "same-origin" }).then((r) => r.status, () => "refused"),
      }));
      ok(so.own === 200 && so.ownReq === 200 && so.other === "refused", `same-origin fetch semantics ${JSON.stringify(so)}`);
      // form → the site's answer (results, or Fastly's bot challenge, which pypi now serves this sandbox's address)
      await fr.locator("input[name=q]").first().fill("leaflet");
      await fr.locator("input[name=q]").first().press("Enter");
      await poll(async () => /\/search\/\?q=leaflet/.test((await tabUrl(page)) ?? ""), "address follows the form submission");
      ok((await page.getByLabel("Address").inputValue()).includes("pypi.org/search/?q=leaflet"), "omnibox shows the target address");
      const fr2 = await frameReady(page, async (f) => (await f.locator("a.package-snippet").count()) > 0 || /Client Challenge/.test(await f.title()), "search response");
      console.log(`    search answered with: ${(await fr2.locator("a.package-snippet").count()) ? "results" : "Fastly bot challenge (site-side; not bypassed)"}`);
      // Back to the home page, then a real link
      await page.getByTestId("wp-back").click();
      await poll(async () => ((await tabUrl(page)) ?? "") === "https://pypi.org/", "Back to home");
      const fr3 = await frameReady(page, async (f) => (await f.locator('a[href*="/help/"]').count()) > 0, "home again after Back");
      await fr3.locator('a[href*="/help/"]').first().click();
      await poll(async () => /pypi\.org\/help\/$/.test((await tabUrl(page)) ?? ""), "Help link followed");
      await frameReady(page, async (f) => /^Help/.test(await f.title()), "help page");
      await page.getByTestId("wp-back").click();
      await poll(async () => ((await tabUrl(page)) ?? "") === "https://pypi.org/", "Back");
      await page.getByTestId("wp-forward").click();
      await poll(async () => /\/help\/$/.test((await tabUrl(page)) ?? ""), "Forward");
      await frameReady(page, async (f) => /^Help/.test(await f.title()), "help page after Forward");
      const foreign = [...hosts.keys()].filter((h) => h !== HOST);
      console.log(`    requests by host: ${JSON.stringify(Object.fromEntries(hosts))}`);
      ok(foreign.length === 0, `the browser contacted other hosts directly: ${foreign.join(", ")}`);
      ok((hosts.get(HOST) ?? 0) > 20, "the page's subresources came through the proxy");
    } finally { await ctx.close(); }
  });

  await test("find in page, identity and Save to Files on a real site (WP-05; PR-07h, PR-07n, PR-07m): find counts and steps through matches inside the proxied page; Mobile makes the server AND the page present a mobile browser; Save to Files writes the page's original HTML into /Downloads", { "WP-05": "full", "PR-07h": "partial", "PR-07n": "partial", "PR-07m": "partial" }, async () => {
    const { page, ctx } = await boot([browserWin([tab("t1", "https://pypi.org/help/")])]);
    let savedPath = "";
    try {
      await frameReady(page, async (f) => /^Help/.test(await f.title()), "help page");
      await page.getByTestId("wp-find").fill("package");
      await page.getByTestId("wp-find").press("Enter");
      await poll(async () => /^1\/\d+$/.test((await page.getByTestId("wp-find-count").innerText()).trim()), "find: first of N");
      const n = Number((await page.getByTestId("wp-find-count").innerText()).split("/")[1]);
      ok(n > 5, `many matches expected, got ${n}`);
      await page.getByTestId("wp-find").press("Enter");
      await poll(async () => (await page.getByTestId("wp-find-count").innerText()).trim() === `2/${n}`, "find: next");
      const sel = await proxFrame(page)!.evaluate(() => String(getSelection()).toLowerCase());
      ok(sel === "package", `the match is selected in the page (got "${sel}")`);
      await page.getByTestId("wp-find").fill("zzqqxx-no-such-text");
      await page.getByTestId("wp-find").press("Enter");
      await poll(async () => (await page.getByTestId("wp-find-count").innerText()).trim() === "no matches", "find: no matches");
      // identity
      await page.getByTestId("wp-ua").selectOption("mobile");
      await frameReady(page, async (f) => /Mobile/.test(await f.evaluate(() => navigator.userAgent)), "page sees a mobile browser after reload");
      const sid = await page.getByTestId("wp-tab").getAttribute("data-sid");
      ok((await api("GET", `/api/wp-session?sid=${sid}`)).json.ua === "mobile", "server sends the mobile identity");
      // save
      await page.getByTestId("wp-save").click();
      await poll(async () => /Saved to Files/.test(await page.getByTestId("wp-note").innerText().catch(() => "")), "saved note");
      savedPath = /→ (\S+)/.exec(await page.getByTestId("wp-note").innerText())![1];
      const node = await readNode(savedPath);
      ok(node, `file exists at ${savedPath}`);
      const text = node!.encoding === "base64" ? Buffer.from(node!.content, "base64").toString("utf8") : node!.content;
      ok(/<html/i.test(text) && text.includes("Help") && !text.includes("/api/wp/s/"), "the ORIGINAL page HTML (not the rewritten copy) was saved");
    } finally { await ctx.close(); if (savedPath) await removeFile(savedPath); }
  });

  await test("per-tab private profiles (WP-04, PR-07o): a cookie a page sets lives in that tab's own jar — it survives a reload and a navigation inside the tab, a second tab on the SAME site never sees it, the Cookies counter shows it, and Clear cookies forgets it; closing the tab deletes the session on the server", { "WP-04": "full", "PR-07o": "partial" }, async () => {
    const { page, ctx } = await boot([browserWin([tab("t1", "https://pypi.org/"), tab("t2", "https://pypi.org/")])]);
    const frameOf = (sid: string) => page.frames().find((f) => f.url().includes(`/api/wp/s/${sid}/`));
    try {
      await frameReady(page, async (f) => (await f.locator("input[name=q]").count()) > 0, "tab 1");
      const sid1 = (await page.getByTestId("wp-tab").getAttribute("data-sid"))!;
      await frameOf(sid1)!.evaluate(() => { document.cookie = "fwp_profile=alpha; path=/; max-age=3600"; });
      await poll(async () => (await api("GET", `/api/wp-session?sid=${sid1}`)).json.cookieDomains?.includes("pypi.org"), "cookie reached tab 1's jar");
      await poll(async () => /Cookies: [1-9]/.test(await page.getByTestId("wp-cookies").innerText()), "Cookies counter");
      await page.getByTestId("wp-reload").click();
      await poll(async () => /fwp_profile=alpha/.test(await frameOf(sid1)!.evaluate(() => document.cookie).catch(() => "")), "cookie survives reload (served from the jar)");
      await frameOf(sid1)!.locator('a[href*="/help/"]').first().click();
      await poll(async () => /\/help\/$/.test((await tabUrl(page)) ?? ""), "navigate inside tab 1");
      await poll(async () => /fwp_profile=alpha/.test(await frameOf(sid1)!.evaluate(() => document.cookie).catch(() => "")), "cookie on another page of the site");
      await page.locator("[data-tab=t2]").click();
      await poll(async () => { const s2 = await page.getByTestId("wp-tab").getAttribute("data-sid"); return !!s2 && s2 !== sid1 && !!frameOf(s2) && (await frameOf(s2)!.locator("input[name=q]").count()) > 0; }, "tab 2 with its own session");
      const sid2 = (await page.getByTestId("wp-tab").getAttribute("data-sid"))!;
      ok(!/fwp_profile/.test(await frameOf(sid2)!.evaluate(() => document.cookie)), "tab 2 must not see tab 1's cookie");
      const j2 = (await api("GET", `/api/wp-session?sid=${sid2}`)).json;
      ok(!JSON.stringify(j2).includes("fwp_profile") && (await frameOf(sid2)!.evaluate(() => !document.cookie.includes("fwp_profile"))), "tab 2's jar is separate");
      await page.locator("[data-tab=t1]").click();
      await poll(async () => (await page.getByTestId("wp-tab").getAttribute("data-sid")) === sid1, "back on tab 1 (same session)");
      await page.getByTestId("wp-clear").click();
      await poll(async () => (await api("GET", `/api/wp-session?sid=${sid1}`)).json.cookies === 0, "Clear cookies empties the jar");
      // close tab 2: its server session goes away
      await page.locator("[data-tab=t2]").click({ button: "middle" });
      await poll(async () => (await page.locator("[data-tab=t2]").count()) === 0, "tab 2 closed");
      await poll(async () => (await api("GET", `/api/wp-session?sid=${sid2}`)).status === 404, "closed tab's session deleted on the server");
      ok((await api("GET", `/api/wp-session?sid=${sid1}`)).status === 200, "the open tab keeps its session");
    } finally { await ctx.close(); }
  });

  await test("hostile-page model (WP-02, WP-06): with Fusion's in-page runtime WITHHELD, a proxied document — opened top-level, and inside Fusion's Browser frame — is an opaque origin that can neither read the desktop's API nor write a file by CSRF; an unknown session id is refused", { "WP-02": "full", "WP-06": "full" }, async () => {
    const s = await api("POST", "/api/wp-session", { ua: "desktop" });
    const ctx = await browser.newContext();
    await ctx.route("**/wp-shim.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: NO_RUNTIME }));
    try {
      const page = await ctx.newPage();
      await page.goto(`${BASE}/api/wp/s/${s.json.sid}/https/pypi.org/`, { waitUntil: "domcontentloaded" });
      const r = { origin: await page.evaluate(() => self.origin), read: await page.evaluate(attack, BASE) };
      ok(r.origin === "null" && r.read === "blocked", JSON.stringify(r));
      ok((await readNode("/Documents/csrf-probe.txt")) === null, "top-level: no file written (CSRF guard)");
      // the same hostile page inside Fusion's Browser frame
      const inFrame = await boot([browserWin([tab("t1", "https://pypi.org/")])], true);
      try {
        const fr = await frameReady(inFrame.page, async (f) => (await f.locator("input[name=q]").count()) > 0, "hostile pypi in the frame");
        const r2 = { origin: await fr.evaluate(() => self.origin), read: await fr.evaluate(attack, BASE) };
        ok(r2.origin === "null" && r2.read === "blocked", "in frame: " + JSON.stringify(r2));
        ok((await readNode("/Documents/csrf-probe.txt")) === null, "in frame: no file written (CSRF guard)");
      } finally { await inFrame.ctx.close(); }
      const bad = await page.goto(`${BASE}/api/wp/s/AAAAAAAAAAAAAAAAAAAAAA/https/pypi.org/`);
      ok(bad?.status() === 403, `unknown session → ${bad?.status()}`);
    } finally { await ctx.close(); await api("DELETE", `/api/wp-session?sid=${s.json.sid}`); }
  });

  await test("large downloads and media ranges through the proxy (WP-02, PR-07m): a real file bigger than the 8 MB page limit (a numpy wheel from files.pythonhosted.org) streams through whole — byte-identical to a direct download (SHA-256) — and a Range request returns 206 with exactly the requested bytes; a 9 MB upload is refused (413)", { "WP-02": "full", "PR-07m": "partial" }, async () => {
    const { createHash } = await import("node:crypto");
    const { execFileSync } = await import("node:child_process");
    const meta = JSON.parse(execFileSync("curl", ["-s", "https://pypi.org/pypi/numpy/json"], { maxBuffer: 1 << 26 }).toString());
    const file = (meta.urls as { url: string; size: number; digests: { sha256: string } }[]).filter((u) => u.size > 9 * 1048576 && u.size < 40 * 1048576).sort((a, b) => a.size - b.size)[0];
    ok(file, "a wheel between 9 and 40 MB");
    const s = await api("POST", "/api/wp-session", { ua: "desktop" });
    try {
      const via = `${BASE}/api/wp/s/${s.json.sid}/${file.url.replace("://", "/")}`;
      const r = await fetch(via, { headers: { "sec-fetch-dest": "document" } });
      const buf = Buffer.from(await r.arrayBuffer());
      const sha = createHash("sha256").update(buf).digest("hex");
      console.log(`    ${file.url.split("/").pop()}: ${buf.length} B via proxy, sha256 ${sha.slice(0, 16)}… (PyPI says ${file.digests.sha256.slice(0, 16)}…)`);
      ok(r.status === 200 && buf.length === file.size && sha === file.digests.sha256, "byte-identical to PyPI's published digest");
      const rr = await fetch(via, { headers: { range: "bytes=1000000-1000099" } });
      const part = Buffer.from(await rr.arrayBuffer());
      ok(rr.status === 206 && part.length === 100 && part.equals(buf.subarray(1000000, 1000100)) && /bytes 1000000-1000099\//.test(rr.headers.get("content-range") ?? ""), `range → ${rr.status} ${part.length} B ${rr.headers.get("content-range")}`);
      // uploads are bounded: 9 MB to the site is refused before anything is sent upstream
      const up = await fetch(`${BASE}/api/wp/s/${s.json.sid}/https/pypi.org/`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(9 * 1048576) });
      ok(up.status === 413, `9 MB upload → ${up.status}`);
    } finally { await api("DELETE", `/api/wp-session?sid=${s.json.sid}`); }
  });

  await test("yahoo.com and soundcloud.com (WP-02): attempted for real through the proxy; this sandbox's egress filter cuts the connection, and the tab says so in plain words (network block, not a broken site) — no request leaves the browser for those hosts", { "WP-02": "full" }, async () => {
    const { page, ctx, hosts } = await boot([browserWin([tab("t1", "https://www.yahoo.com/"), tab("t2", "https://soundcloud.com/")])]);
    try {
      const fr = await frameReady(page, async (f) => (await f.locator("[data-fusion-wp-error]").count()) > 0, "yahoo diagnostic");
      const t = await fr.locator("main").innerText();
      console.log(`    yahoo: ${t.replace(/\s+/g, " ").slice(0, 200)}`);
      ok(/Could not reach www\.yahoo\.com/.test(t) && /firewall or egress policy/.test(t), t);
      await page.locator("[data-tab=t2]").click();
      const fr2 = await frameReady(page, async (f) => f.url().includes("soundcloud.com") && (await f.locator("[data-fusion-wp-error]").count()) > 0, "soundcloud diagnostic");
      ok(/Could not reach soundcloud\.com/.test(await fr2.locator("main").innerText()), "soundcloud diagnostic");
      ok(![...hosts.keys()].some((h) => /yahoo|soundcloud/.test(h)), "no direct request to the sites");
    } finally { await ctx.close(); }
  });

  await test("github.com through the private proxy (WP-01): its HTML renders (title, repository README) in the proxied tab; this sandbox blocks GitHub's asset CDN (github.githubassets.com), so the page is unstyled here — the toolbar names the unreachable host and why; shields count; nothing but the Fusion server is contacted", { "WP-01": "full", "WP-03": "full" }, async () => {
    const { page, ctx, hosts } = await boot([browserWin([tab("t1", "https://github.com/nodejs/node")])]);
    try {
      const fr = await frameReady(page, async (f) => /node/i.test(await f.title()) && (await f.locator("text=README").count()) > 0, "github repository page", 40000);
      console.log(`    github title: ${await fr.title()}`);
      // this sandbox's egress filter lets github.com through but not its asset CDN: the page arrives without its CSS,
      // and the toolbar must say where it went (asserted), instead of a silently broken page
      await poll(async () => /github\.githubassets\.com/.test((await page.getByTestId("wp-unreachable").getAttribute("data-hosts")) ?? ""), "unreachable asset host named in the toolbar");
      const why = await page.getByTestId("wp-unreachable").getAttribute("title");
      ok(/github\.githubassets\.com — connection cut \(firewall \/ egress policy\)/.test(why ?? ""), `reason shown: ${why}`);
      console.log(`    unreachable: ${await page.getByTestId("wp-unreachable").getAttribute("data-hosts")}`);
      await poll(async () => /\d+ blocked/.test(await page.getByTestId("wp-shields").innerText()), "shields counter live");
      const foreign = [...hosts.keys()].filter((h) => h !== HOST);
      ok(foreign.length === 0, `direct contact: ${foreign.join(", ")}`);
    } finally { await ctx.close(); }
  });
} finally {
  await browser?.close();
  if (prevState) await api("PUT", "/api/state", { id: "default", revision: Number((await api("GET", "/api/state?id=default")).json.row?.revision ?? 1) + 1000, state: prevState });
  if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
}
await finish();
