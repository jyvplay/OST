/**
 * Suite "tt35-unit" (TT35): the Fusion web proxy's core, server pieces and in-page runtime codec, without a browser.
 *   - URL codec (src/lib/wp-core.ts): path-preserving encode/decode round trips (ports, IPv6, trailing slashes,
 *     queries, fragments, unicode), refusals; the in-page runtime (public/wp-shim.js, loaded in a VM) encodes
 *     every URL of a corpus exactly like the server
 *   - HTML / CSS / srcset rewriting: adversarial vectors, then REAL pages fetched live from github.com and pypi.org,
 *     checked by an independent parser (Python html.parser, scripts/oracle/htmlurls.py): no URL-bearing attribute
 *     may still reach the network outside the proxy, and no markup may be lost
 *   - cookie jar against RFC 6265 rules; tracker matching; request / response header hygiene; CSRF verdicts;
 *     sessions (capability ids, idle expiry, cap); network error classes from REAL attempts (private addresses, and
 *     this sandbox's egress filter on yahoo.com / soundcloud.com); a gzip bomb stops at the byte cap; upstream resets
 *     and consumer cancels against a real local socket (no uncaught exception, no leaked upstream)
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt35-unit.mts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync, createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import vm from "node:vm";
import { makeHarness } from "./harness.mts";
import * as W from "../src/lib/wp-core.ts";
import { upstreamRequest, byteCap, readAll, responseBody, toWebStream } from "../src/lib/server/wp-fetch.ts";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createSession, getSession, dropSession, WP_IDLE_MS, WP_MAX_SESSIONS, sessionCount } from "../src/lib/server/wp-sessions.ts";

const { test, finish } = makeHarness("tt35-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const SID = "AbCdEfGhIjKlMnOpQrStUv";
const P = `${W.WP_PREFIX}${SID}/`;

/* ============================================================ codec */
await test("URL codec (WP-01): path-preserving encode → decode round-trips 2 000 generated URLs exactly (ports, IPv6, trailing slashes, queries, unicode); refuses credentials, non-http schemes, bad session ids and smuggled hosts", { "WP-01": "full" }, () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const hosts = ["example.com", "pypi.org", "sub.domain.co.uk", "[2001:db8::1]", "xn--bcher-kva.example", "example.com:8443", "127.0.0.1", "a-b.c-d.io"];
  const segs = ["", "a", "b c", "%2F", "ü", "x.y", "..", "z;p=1", "~u", "(1)"];
  for (let i = 0; i < 2000; i++) {
    const scheme = rnd() < 0.5 ? "http" : "https";
    const path = "/" + Array.from({ length: Math.floor(rnd() * 4) }, () => segs[Math.floor(rnd() * segs.length)]).join("/") + (rnd() < 0.3 ? "/" : "");
    const q = rnd() < 0.5 ? `?q=${encodeURIComponent("a&b=" + i)}&x` : "";
    const u = new URL(`${scheme}://${hosts[Math.floor(rnd() * hosts.length)]}${path}${q}`);
    const e = W.encodeTarget(u, SID)!;
    ok(e.startsWith(P), `prefix ${e}`);
    const hashless = e.split("#")[0]; const qi = hashless.indexOf("?");
    const d = W.decodeTarget(qi < 0 ? hashless : hashless.slice(0, qi), qi < 0 ? "" : hashless.slice(qi));
    eq(d.target.href, u.href, `round trip ${u.href}`);
    eq(d.sid, SID);
  }
  eq(W.encodeTarget("https://u:p@example.com/", SID), null, "credentials");
  eq(W.encodeTarget("ftp://example.com/", SID), null, "ftp");
  eq(W.encodeTarget("javascript:alert(1)", SID), null, "javascript");
  for (const bad of [`${W.WP_PREFIX}short/https/example.com/`, `${P}file/etc/passwd`, `${P}https/ex ample.com/`, `${P}https/a@evil.com/`, `${P}https/evil.com\\@good.com/`, `${W.WP_PREFIX}${SID}`]) {
    let threw = false; try { W.decodeTarget(bad); } catch { threw = true; } ok(threw, `must refuse ${bad}`);
  }
  eq(W.decodeTarget(`${P}https/pypi.org/search/`, "?q=x").target.href, "https://pypi.org/search/?q=x", "trailing slash kept");
});

await test("runtime parity (WP-01): the in-page runtime public/wp-shim.js, run in a VM with a proxied location, encodes a 400-URL corpus (relative, root-relative, protocol-relative, absolute, already-proxied, location-built, data:/blob:/javascript:/#) exactly like the server's rewriteUrl", { "WP-01": "full" }, () => {
  const src = readFileSync("public/wp-shim.js", "utf8");
  const page = "https://pypi.org/project/requests/";
  const loc = new URL(`http://localhost:3999${W.encodeTarget(page, SID)}`);
  const win: Record<string, unknown> = { URL, location: { href: loc.href, host: loc.host, protocol: loc.protocol } };
  win.document = { currentScript: { dataset: { fusionWp: "1", sid: SID, url: page, ua: "desktop", cookies: "" } }, baseURI: loc.href };
  vm.runInNewContext(src, { window: win, globalThis: win, URL });
  const enc = (win.__fusionWp as { enc: (s: string) => string }).enc;
  const corpus = ["a.png", "../x/y?z=1", "/static/app.css", "//cdn.example.net/lib.js", "https://files.pythonhosted.org/p/x.whl", "?page=2", "#top", "data:image/png;base64,AAA", "blob:https://x/1",
    "javascript:void 0", "mailto:a@b.c", `${P}https/pypi.org/`, "  /spaced  ", "HTTPS://PyPI.org/Up", "http://example.com:8080/p", "https://u:p@x.com/", "/search/?q=a b&c=ü", ""];
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  while (corpus.length < 400) corpus.push(["", "/", "//h.example/", "https://g.example/"][Math.floor(rnd() * 4)] + ["p", "q/r", "s?t=1", "u#v", "w x"][Math.floor(rnd() * 5)]);
  for (const c of corpus) eq(enc(c), W.rewriteUrl(c, page, SID), `parity for ${JSON.stringify(c)}`);
  // a URL a script builds from location.origin means the TARGET site's root
  eq(enc("http://localhost:3999/api/v2/search"), `${P}https/pypi.org/api/v2/search`, "location-built URL");
});

/* ============================================================ rewriting */
await test("HTML rewriting (WP-01): adversarial vectors — unquoted / single-quoted / uppercase attributes, entities in queries, <base>, srcset with commas inside URLs, inline style url(), meta refresh, CSP / XFO meta removed, integrity + ping dropped, use-credentials → anonymous, _top → _self, script / textarea / comment content untouched, runtime injected first in <head>", { "WP-01": "full", "WP-02": "partial" }, () => {
  const url = "https://ex.com/dir/page.html";
  const R = (h: string) => W.rewriteHtml(h, { sid: SID, url, inject: "<!--RT-->" }).html;
  const E = (u: string) => W.encodeTarget(u, SID)!;
  eq(R(`<a href=/x>`), `<!--RT--><a href="${E("https://ex.com/x")}">`, "unquoted, no head → injected first");
  eq(R(`<html><head><title>t</title></head>`), `<html><head><!--RT--><title>t</title></head>`, "injected right after <head>");
  ok(R(`<IMG SRC='a.png?x=1&amp;y=2'>`).includes(`SRC="${E("https://ex.com/dir/a.png?x=1&y=2").replace(/&/g, "&amp;")}"`), "entity-decoded then re-encoded");
  ok(R(`<base href="https://cdn.ex.com/root/"><img src="i.png">`).includes(E("https://cdn.ex.com/root/i.png")), "<base> changes resolution");
  const ss = R(`<img srcset="/a,b.png 1x, https://o.com/c.png 2x">`);
  ok(ss.includes(`${E("https://ex.com/a,b.png")} 1x`) && ss.includes(`${E("https://o.com/c.png")} 2x`), `srcset ${ss}`);
  ok(R(`<div style="background:url('/bg.png')">`).includes(`url(&quot;${E("https://ex.com/bg.png")}&quot;)`), "inline style");
  ok(R(`<meta http-equiv="refresh" content="0; url=/next">`).includes(E("https://ex.com/next")), "meta refresh");
  eq(R(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'"><p>`), `<!--RT--><p>`, "CSP meta removed");
  eq(R(`<script src="/a.js" integrity="sha384-x" crossorigin="use-credentials"></script>`), `<!--RT--><script src="${E("https://ex.com/a.js")}" crossorigin="anonymous"></script>`, "integrity dropped, credentials never");
  eq(R(`<a href="#f" ping="https://t.com/p" target="_top">`), `<!--RT--><a href="#f" target="_self">`, "ping dropped, _top → _self, fragment kept");
  const raw = `<script>var u="/not/an/attr"; if(a<b){}</script><textarea><a href="/no"></textarea><!-- <img src="/no"> -->`;
  eq(R(raw), "<!--RT-->" + raw, "raw text and comments untouched");
  ok(R(`<style>@import "/x.css"; .a{background:url(/y.png)}</style>`).includes(`@import "${E("https://ex.com/x.css")}"`), "@import in <style>");
  ok(R(`<form action="/login" method=post><button formaction="/alt">`).includes(`action="${E("https://ex.com/login")}"`) && R(`<button formaction="/alt">`).includes(E("https://ex.com/alt")), "forms");
  eq(R(`<a href="javascript:void(0)" data-x="/y">`), `<!--RT--><a href="javascript:void(0)" data-x="/y">`, "javascript: and data-* untouched");
  eq(R(`<svg><use xlink:href="/s.svg#i"/></svg>`), `<!--RT--><svg><use xlink:href="${E("https://ex.com/s.svg#i")}" /></svg>`, "xlink:href");
});

await test("CSS + srcset rewriting (WP-01): url() quoted / unquoted / escaped / uppercase, @import string, comments and unrelated strings untouched, data: kept; srcset descriptors (w / x), URLs with commas, empty candidates", { "WP-01": "full" }, () => {
  const base = "https://ex.com/css/main.css"; const E = (u: string) => W.encodeTarget(u, SID)!;
  const C = (s: string) => W.rewriteCss(s, base, SID);
  eq(C(`a{b:url(x.png)}`), `a{b:url("${E("https://ex.com/css/x.png")}")}`);
  eq(C(`a{b:URL( "/y.png" )}`), `a{b:url("${E("https://ex.com/y.png")}")}`);
  eq(C(`a{b:url('d\\.png')}`), `a{b:url("${E("https://ex.com/css/d.png")}")}`, "escape");
  eq(C(`@import '../base.css' screen;`), `@import '${E("https://ex.com/base.css")}' screen;`);
  eq(C(`/* url(/no) */ a{content:"url(/no)"}`), `/* url(/no) */ a{content:"url(/no)"}`);
  eq(C(`a{b:url(data:image/png;base64,AA==)}`), `a{b:url("data:image/png;base64,AA==")}`);
  eq(C(`a{mask:my-url(x)}`), `a{mask:my-url(x)}`, "url( must be its own token");
  eq(W.rewriteSrcset("a.png 480w, b.png 800w", base, SID), `${E("https://ex.com/css/a.png")} 480w, ${E("https://ex.com/css/b.png")} 800w`);
  eq(W.rewriteSrcset(" , x.png,", base, SID), E("https://ex.com/css/x.png"));
});

const live: { url: string; html: string }[] = [];
const CHALLENGE = /<title>\s*(Client Challenge|Just a moment\.\.\.|Attention Required)/i;
// curl uses the OS trust store: in this sandbox github.com is TLS-intercepted by the egress proxy ("E2B Proxy CA",
// trusted by the OS only), pypi.org is end-to-end (GlobalSign). Either way the HTML is the site's.
for (const u of ["https://github.com/", "https://github.com/nodejs/node", "https://pypi.org/", "https://pypi.org/project/requests/"]) {
  try { const html = execFileSync("curl", ["-sfL", "--compressed", "-m", "20", "-A", W.UA.desktop, u], { maxBuffer: 1 << 26 }).toString("utf8"); if (html.length > 1000) live.push({ url: u, html }); } catch { console.log(`    (could not fetch ${u})`); }
}
await test(`real pages + independent parser (WP-01, WP-02): ${live.length} pages fetched live (github.com, pypi.org) are rewritten, then walked by Python's html.parser — zero URL-bearing attributes may still point outside the proxy, and the start-tag sequence must survive except the injected runtime and removed CSP metas`, { "WP-01": "full", "WP-02": "full" }, () => {
  ok(live.filter((p) => !CHALLENGE.test(p.html)).length >= 3, `need ≥ 3 real (non-challenge) live pages, got ${live.length}`);
  const jobs: { html: string; prefix: string }[] = [];
  const reports: W.HtmlRewriteReport[] = [];
  for (const p of live) {
    const r = W.rewriteHtml(p.html, { sid: SID, url: p.url, inject: `<script src="/wp-shim.js" data-fusion-wp="1"></script>` });
    reports.push(r.report);
    jobs.push({ html: r.html, prefix: P }, { html: p.html, prefix: P });
  }
  const out = JSON.parse(execFileSync(PY, ["scripts/oracle/htmlurls.py"], { input: JSON.stringify(jobs), maxBuffer: 1 << 28 }).toString()) as { leaks: string[][]; tags: string[]; urls: number }[];
  for (let i = 0; i < live.length; i++) {
    const after = out[2 * i], before = out[2 * i + 1];
    console.log(`    ${live[i].url}: ${before.urls} URLs, ${before.leaks.length} reach outside before → ${after.leaks.length} after; ${reports[i].rewritten} rewritten`);
    // TT42: a bot-challenge interstitial (seen from this sandbox's IP on pypi.org/project/… since Oct 2026: "Client
    // Challenge", 3 same-site URLs) is still checked for leaks, but cannot satisfy the outside-URL precondition
    if (CHALLENGE.test(live[i].html)) console.log(`    ${live[i].url}: bot-challenge interstitial served — outside-URL precondition waived for this page only (leak / tag checks still run)`);
    else ok(before.leaks.length > 20, "the original page must actually contain outside URLs (else the check proves nothing)");
    eq(after.leaks.filter((l) => !(l[0] === "script" && l[2] === "/wp-shim.js")), [], `leaks in ${live[i].url}`); // our own runtime is the one allowed root path
    eq(after.leaks.length, 1, "exactly one runtime injected");
    const removedMeta = reports[i].removed.filter((x) => x.startsWith("meta")).length;
    const t = after.tags.slice(); const k = t.indexOf("script"); t.splice(k, 1);
    const metasBefore = before.tags.filter((x) => x === "meta").length, metasAfter = t.filter((x) => x === "meta").length;
    eq(metasBefore - metasAfter, removedMeta, "only CSP/XFO metas may disappear");
    eq(t.filter((x) => x !== "meta"), before.tags.filter((x) => x !== "meta"), `tag sequence of ${live[i].url}`);
  }
});

/* ============================================================ cookies */
await test("cookie jar (WP-04): RFC 6265 — host-only vs Domain, public-suffix refusal, domain mismatch, default-path and path matching (/docs vs /docsx), Secure only over https, Max-Age over Expires, deletion, HttpOnly hidden from (and unwritable by) scripts, __Secure- / __Host- prefixes, ordering by path length, per-domain cap", { "WP-04": "full" }, () => {
  const j = new W.CookieJar(); const t0 = 1_700_000_000_000;
  const u = (s: string) => new URL(s);
  eq(j.set("a=1", u("https://www.ex.com/docs/page"), t0), null);
  eq(j.header(u("https://www.ex.com/docs/x"), t0), "a=1", "default-path /docs");
  eq(j.header(u("https://www.ex.com/docsx"), t0), "", "/docsx does not path-match /docs");
  eq(j.header(u("https://sub.www.ex.com/docs/"), t0), "", "host-only");
  eq(j.set("b=2; Domain=.ex.com; Path=/", u("https://www.ex.com/"), t0), null);
  eq(j.header(u("https://api.ex.com/"), t0), "b=2", "Domain cookie reaches subdomains");
  eq(j.set("c=3; Domain=com", u("https://www.ex.com/"), t0), "public suffix");
  eq(j.set("c=3; Domain=co.uk", u("https://ex.co.uk/"), t0), "public suffix");
  eq(j.set("c=3; Domain=other.com", u("https://www.ex.com/"), t0), "domain mismatch");
  eq(j.set("s=1; Secure", u("http://www.ex.com/"), t0), "Secure over http");
  eq(j.set("m=1; Max-Age=10; Expires=Wed, 01 Jan 2099 00:00:00 GMT; Path=/", u("https://www.ex.com/"), t0), null);
  ok(j.header(u("https://www.ex.com/"), t0 + 5_000).includes("m=1"), "alive at 5 s");
  ok(!j.header(u("https://www.ex.com/"), t0 + 11_000).includes("m=1"), "Max-Age wins over Expires");
  j.set("b=; Domain=ex.com; Path=/; Max-Age=0", u("https://www.ex.com/"), t0);
  ok(!j.header(u("https://api.ex.com/"), t0).includes("b="), "deleted");
  eq(j.set("h=1; HttpOnly; Path=/", u("https://www.ex.com/"), t0), null);
  ok(j.header(u("https://www.ex.com/"), t0).includes("h=1") && !j.header(u("https://www.ex.com/"), t0, true).includes("h=1"), "HttpOnly hidden from scripts");
  eq(j.set("h=2; Path=/", u("https://www.ex.com/"), t0, true), "HttpOnly from script");
  eq(j.set("__Secure-x=1", u("https://www.ex.com/"), t0), "__Secure- without Secure");
  eq(j.set("__Host-x=1; Secure; Path=/; Domain=ex.com", u("https://www.ex.com/"), t0), "__Host- rules");
  eq(j.set("__Host-y=1; Secure; Path=/", u("https://www.ex.com/"), t0), null);
  j.set("o=deep; Path=/docs/a", u("https://www.ex.com/docs/a/b"), t0);
  ok(j.header(u("https://www.ex.com/docs/a/b"), t0).startsWith("o=deep"), "longest path first");
  const k = new W.CookieJar();
  for (let i = 0; i < W.CookieJar.MAX_PER_DOMAIN + 15; i++) k.set(`n${i}=v; Path=/`, u("https://flood.ex.com/"), t0 + i);
  eq(k.size, W.CookieJar.MAX_PER_DOMAIN, "per-domain cap");
  ok(!k.header(u("https://flood.ex.com/"), t0 + 999).includes("n0="), "oldest evicted");
});

/* ============================================================ shields, headers, CSRF */
await test("privacy hygiene (WP-03): tracker hosts and their subdomains match (and look-alikes do not); upstream requests carry no cookie / referer / origin / client hints / forwarding headers of the user, one UA and language for everyone, Sec-GPC and an origin-only Referer of the target; responses lose Set-Cookie, CSP, XFO, HSTS, COOP, Alt-Svc; download names are sanitised", { "WP-03": "full" }, () => {
  for (const h of ["www.google-analytics.com", "googletagmanager.com", "stats.g.doubleclick.net", "connect.facebook.net", "static.hotjar.com"]) ok(W.isTracker(h), h);
  for (const h of ["google.com", "facebook.com", "notdoubleclick.net", "doubleclick.net.evil.org", "pypi.org"]) ok(!W.isTracker(h), `false positive ${h}`);
  const inc: [string, string][] = [["cookie", "fusion=secret"], ["referer", "http://localhost:3999/"], ["origin", "null"], ["user-agent", "HeadlessChrome"], ["sec-ch-ua", "x"], ["sec-fetch-site", "cross-site"],
    ["x-forwarded-for", "10.0.0.2"], ["accept-language", "de-CH"], ["content-type", "application/json"], ["range", "bytes=0-99"], ["x-csrf-token", "t"], ["authorization", "Bearer site-token"]];
  const h = W.upstreamHeaders(inc, new URL("https://api.ex.com/v1/x"), { ua: "desktop", cookie: "sid=1", method: "POST" });
  eq(h.cookie, "sid=1", "only the jar's cookie"); eq(h.referer, "https://api.ex.com/"); eq(h.origin, "https://api.ex.com"); eq(h["user-agent"], W.UA.desktop);
  eq(h["accept-language"], "en-US,en;q=0.9"); eq(h["sec-gpc"], "1"); eq(h.range, "bytes=0-99"); eq(h["x-csrf-token"], "t"); eq(h.authorization, "Bearer site-token");
  for (const k of ["sec-ch-ua", "sec-fetch-site", "x-forwarded-for"]) ok(!(k in h), `leaked ${k}`);
  ok(!JSON.stringify(h).includes("localhost") && !JSON.stringify(h).includes("secret") && !JSON.stringify(h).includes("Headless"), "nothing of the user's side crosses");
  const d = W.downstreamHeaders({ "set-cookie": ["a=1"], "content-security-policy": "x", "x-frame-options": "DENY", "strict-transport-security": "max-age=1", "cross-origin-opener-policy": "same-origin", "alt-svc": "h3", "content-type": "image/png", "content-range": "bytes 0-1/2", "content-disposition": 'attachment; filename="../../etc/pa\r\nss wd.txt"' });
  eq(Object.keys(d).sort(), ["content-disposition", "content-range", "content-type"]);
  ok(!d["content-disposition"].includes("/") && !d["content-disposition"].includes("\r") && d["content-disposition"].startsWith("attachment"), d["content-disposition"]);
});

await test("CSRF verdicts (WP-06): POST / PUT / DELETE pass only from the desktop itself (Sec-Fetch-Site same-origin, or an Origin naming one of our hosts) or a non-browser client; refused from other sites, sibling subdomains, and sandboxed / proxied pages (Origin null); safe methods and proxy-session paths are never blocked", { "WP-06": "full" }, () => {
  const v = (method: string, origin: string | null, sfs: string | null, path = "/api/fs") => W.csrfVerdict({ method, path, origin, secFetchSite: sfs, hosts: ["localhost:3999", "3999-x.e2b.app"] }).ok;
  eq([v("POST", "http://localhost:3999", "same-origin"), v("PUT", "https://3999-x.e2b.app", null), v("DELETE", null, null), v("POST", null, "none")], [true, true, true, true], "allowed");
  eq([v("POST", "null", "cross-site"), v("POST", "https://evil.example", "cross-site"), v("POST", "https://a.e2b.app", "same-site"), v("PUT", "null", null), v("POST", "https://evil.example", null)], [false, false, false, false, false], "refused");
  eq([v("GET", "https://evil.example", "cross-site"), v("POST", "null", "cross-site", "/api/wp/s/x/https/a.com/")], [true, true], "safe method / proxy path");
});

/* ============================================================ sessions + network */
await test("sessions (WP-04): 128-bit url-safe capability ids, unique; idle sessions expire after 30 min; the store never exceeds its cap (least recently used goes first); dropping forgets the cookie jar", { "WP-04": "full" }, () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) { const s = createSession("desktop", "p", 1e12 + i); ok(W.isSid(s.sid) && s.sid.length === 22, s.sid); ids.add(s.sid); }
  eq(ids.size, 200, "unique"); ok(sessionCount() <= WP_MAX_SESSIONS, `cap ${sessionCount()}`);
  const a = createSession("mobile", "x", 2e12); a.jar.set("k=v", new URL("https://ex.com/"), 2e12);
  ok(getSession(a.sid, 2e12 + WP_IDLE_MS - 1) !== null, "alive just before idle limit");
  ok(getSession(a.sid, 2e12 + 2 * WP_IDLE_MS + 1) === null, "expired after idle limit");
  const b = createSession("desktop", "y", 3e12); ok(dropSession(b.sid) && getSession(b.sid, 3e12) === null, "dropped");
});

await test("network failures are named, from REAL attempts (WP-02): loopback, private, link-local metadata and localhost names are refused before any connection (SSRF); yahoo.com and soundcloud.com are attempted for real and classified — in this sandbox the egress filter cuts the TLS handshake, reported as a network block, not a broken site", { "WP-02": "full" }, async () => {
  const kinds: Record<string, string> = {};
  for (const u of ["http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/latest/meta-data/", "http://localhost/api/fs", "http://[::1]/", "http://[fd00::1]/", "http://localhost:3999/api/fs", "https://example.com:8443/", "file:///etc/passwd"]) {
    try { await upstreamRequest(u, { method: "GET", headers: {}, maxBytes: 1000, timeoutMs: 3000 }); kinds[u] = "REACHED"; } catch (e) { kinds[u] = W.classifyError(e).kind; }
  }
  console.log("    ", JSON.stringify(kinds));
  for (const u of ["http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/latest/meta-data/", "http://localhost/api/fs", "http://[::1]/", "http://[fd00::1]/"]) eq(kinds[u], "private", u);
  eq(kinds["http://localhost:3999/api/fs"], "scheme", "non-standard port refused first"); eq(kinds["https://example.com:8443/"], "scheme"); eq(kinds["file:///etc/passwd"], "scheme");
  for (const u of ["https://www.yahoo.com/", "https://soundcloud.com/"]) {
    let kind = "REACHED", status = 0;
    try { const r = await upstreamRequest(u, { method: "GET", headers: W.upstreamHeaders([], new URL(u), { ua: "desktop", cookie: "", method: "GET" }), maxBytes: 1 << 20, timeoutMs: 8000 }); status = r.status; r.body.resume(); } catch (e) { kind = W.classifyError(e).kind; console.log(`     ${u}: ${(e as Error).message} → ${kind}`); }
    ok(kind === "reset" || kind === "REACHED", `${u}: unexpected ${kind}`);
    if (kind === "REACHED") console.log(`     ${u}: reached, HTTP ${status}`);
  }
  // and a real outside site this sandbox does allow, through the same client
  const g = await upstreamRequest("https://pypi.org/", { method: "GET", headers: W.upstreamHeaders([], new URL("https://pypi.org/"), { ua: "desktop", cookie: "", method: "GET" }), maxBytes: 8 << 20 });
  const html = (await readAll(g.body)).toString("utf8");
  eq(g.status, 200, "pypi.org"); ok(/<title>[^<]*PyPI/i.test(html), "decoded (gzip/br) PyPI HTML");
});

await test("decompression bomb (WP-02): 64 MB of zeros gzipped to a few dozen KB is decoded through the same gunzip → byte-cap chain the proxy uses, and stops at the 8 MB cap with a size error instead of inflating", { "WP-02": "full" }, async () => {
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
  ok(bomb.length < 200_000, `bomb is ${bomb.length} bytes`);
  let err = "";
  const before = process.memoryUsage().rss;
  try { await readAll(Readable.from([bomb]).pipe(createGunzip()).pipe(byteCap(8 * 1024 * 1024))); } catch (e) { err = (e as Error).message; }
  ok(/exceeds the 8 MB limit/.test(err), `got "${err}"`);
  eq(W.classifyError(new Error(err)).kind, "too-large");
  console.log(`     bomb ${bomb.length} B; RSS grew ${((process.memoryUsage().rss - before) / 1048576).toFixed(1)} MB`);
});

/* ============================================================ stream failure plumbing (TT35 repair) */
await test("upstream resets and cancelled consumers (WP-02): against a real local socket — a reset mid-body (plain and gzip) rejects the reader with no uncaught exception; a consumer that cancels tears down the upstream socket; the pre-repair .pipe() plumbing fails (hangs / leaks; run here as the mutant)", { "WP-02": "full" }, async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => { uncaught.push(e); };
  process.on("uncaughtException", onUncaught);
  let serverSawClose = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === "/reset" || req.url === "/reset-gz") {
      res.writeHead(200, req.url === "/reset-gz" ? { "content-encoding": "gzip", "content-length": "100000" } : { "content-length": "100000" });
      res.write(req.url === "/reset-gz" ? gzipSync(Buffer.alloc(50000, 97)).subarray(0, 200) : Buffer.alloc(1000, 97));
      setTimeout(() => res.socket?.destroy(), 50);
    } else { // endless
      res.writeHead(200);
      const t = setInterval(() => res.write(Buffer.alloc(16384, 98)), 5);
      res.socket?.on("close", () => { clearInterval(t); serverSawClose++; });
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const get = (path: string) => new Promise<{ res: http.IncomingMessage; req: http.ClientRequest }>((resolve, reject) => { const req = http.get({ host: "127.0.0.1", port, path }, (res) => resolve({ res, req })); req.on("error", () => undefined); req.on("error", reject); });
  // the pre-repair plumbing, kept here only as the mutant
  const oldBody = (res: http.IncomingMessage, onFail: () => void) => {
    const gz = /gzip/.test(String(res.headers["content-encoding"] ?? "")) ? createGunzip() : null;
    let b: Readable = res;
    if (gz) { res.on("error", (e) => gz.destroy(e)); b = res.pipe(gz); }
    return b.pipe(byteCap(1e7, onFail));
  };
  const scenario = async (make: (res: http.IncomingMessage, req: http.ClientRequest) => Readable) => {
    uncaught.length = 0; serverSawClose = 0;
    const out: Record<string, string> = {};
    for (const path of ["/reset", "/reset-gz"]) {
      const { res, req } = await get(path);
      const body = make(res, req);
      out[path] = await Promise.race([
        readAll(body).then(() => "resolved", (e) => "rejected:" + String((e as Error).message).slice(0, 30)),
        new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
      ]);
      if (out[path] === "hung") { body.destroy(); res.destroy(); }
    }
    const { res, req } = await get("/endless");
    const body = make(res, req);
    await new Promise<void>((r) => body.once("data", () => r()));
    body.destroy();
    await new Promise((r) => setTimeout(r, 400));
    return { ...out, uncaught: uncaught.length, upstreamClosed: serverSawClose };
  };
  try {
    const now = await scenario((res, req) => responseBody(res, 1e7, () => req.destroy()));
    console.log(`     repaired: ${JSON.stringify(now)}`);
    ok(/^rejected/.test(now["/reset"]!) && /^rejected/.test(now["/reset-gz"]!), "resets must reject the reader");
    eq(now.uncaught, 0, "uncaught exceptions");
    eq(now.upstreamClosed, 1, "the upstream socket must close when the consumer cancels");
    const old = await scenario((res, req) => oldBody(res, () => req.destroy()));
    console.log(`     mutant (.pipe): ${JSON.stringify(old)}`);
    ok(old.uncaught > 0 || old.upstreamClosed === 0 || !/^rejected/.test(old["/reset"]!) || !/^rejected/.test(old["/reset-gz"]!), "the mutant must fail at least one check");
  } finally { process.off("uncaughtException", onUncaught); srv.closeAllConnections(); srv.close(); }
});

await test("Response streaming (WP-02): the web stream is pull-based (a waiting reader stops the source after its bounded buffer), a cancelled reader destroys the source with nothing thrown even when data arrives late, an upstream failure mid-body errors the reader instead of ending cleanly; buffered reads stop at their limit", { "WP-02": "full" }, async () => {
  const uncaught: unknown[] = []; const on = (e: unknown) => uncaught.push(e); process.on("uncaughtException", on);
  try {
    // pull-based: an endless source is read only as far as the reader asks
    let produced = 0;
    const endless = new Readable({ read() { produced++; this.push(Buffer.alloc(1024, 1)); } });
    const r1 = toWebStream(endless).getReader();
    for (let i = 0; i < 3; i++) await r1.read();
    await new Promise((r) => setTimeout(r, 50));
    const p1 = produced;
    await new Promise((r) => setTimeout(r, 300));
    console.log(`     3 reads → source produced ${p1} KB, then ${produced} KB after waiting (its own high-water buffer, then nothing)`);
    ok(produced === p1 && produced <= 128, `the source must stop while the reader waits: ${p1} → ${produced} chunks`);
    await r1.cancel();
    ok(endless.destroyed, "cancel destroys the source");
    // late data after cancel
    const late = new Readable({ read() {} });
    const r2 = toWebStream(late).getReader();
    const pending = r2.read();
    await r2.cancel();
    late.push(Buffer.from("late"));
    await pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    ok(late.destroyed, "late source destroyed");
    // failure mid-body
    const failing = new Readable({ read() {} });
    const r3 = toWebStream(failing).getReader();
    failing.push(Buffer.from("partial"));
    ok(!(await r3.read()).done, "first chunk delivered");
    failing.destroy(new Error("aborted"));
    const end = await r3.read().then((x) => (x.done ? "clean end" : "more data"), (e) => "error:" + (e as Error).message);
    eq(end, "error:aborted", "mid-body failure");
    // buffered limit
    const big = Readable.from([Buffer.alloc(600_000), Buffer.alloc(600_000)]);
    const lim = await readAll(big, 1024 * 1024).then(() => "read", (e) => (e as Error).message);
    eq(lim, "response exceeds the 1 MB limit");
    eq(uncaught.length, 0, "uncaught exceptions");
  } finally { process.off("uncaughtException", on); }
});

await finish();
