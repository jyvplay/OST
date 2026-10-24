/**
 * TT40 end to end (WP-16): cookies on MARKUP SUBRESOURCES (img / script / stylesheet / an image the stylesheet loads)
 * checked against an EXTERNAL ORACLE — Chromium itself. The same page runs twice in real Chromium:
 *   native:  loaded straight from site A, its subresources going to A, A′ (same site) and B (another site);
 *   proxied: the same page through a second production server of this build.
 * What each site SAW (cookies, Sec-Fetch-Site, Referer) for every subresource must be identical, and so must what a
 * cross-site image response was allowed to STORE (a SameSite=Lax cookie must be refused, a SameSite=None one kept).
 *   A  = http://127.0.0.1:41881     A′ = http://127.0.0.1:41882 (same site: cookies are not port-scoped)
 *   B  = https://127.0.0.2:41883    (real TLS from a CA generated for this run)
 * Before TT40 the proxy sent EVERY cookie of B with B's images on A's page (the WP-10 deviation) — the differential
 * would show bl / bd / bs reaching B; the mutation check at the end re-proves that the oracle sees it.
 * Then the adversary: a forged document id, an "r" tag on a script fetch, an "r" tag on a navigation.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import type { Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("e2e-tt40");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PORT = 3991, PA = 41881, PA2 = 41882, PB = 41883;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const A = `http://127.0.0.1:${PA}`, A2 = `http://127.0.0.1:${PA2}`, B = `https://127.0.0.2:${PB}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(100); } throw new Error(`timed out: ${what}`); }

const CD = "/tmp/tt40-certs";
fs.rmSync(CD, { recursive: true, force: true }); fs.mkdirSync(CD, { recursive: true });
const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: CD, stdio: "pipe" });
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Fusion TT40 test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "b.key", "-out", "b.csr", "-subj", "/CN=b");
fs.writeFileSync(`${CD}/b.ext`, "subjectAltName=IP:127.0.0.2\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
ossl("x509", "-req", "-in", "b.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "b.pem", "-days", "2", "-extfile", "b.ext");

type Seen = { n: string; cookie: string; sfs: string | null; referer: string | null; origin: string | null };
const seen: Record<string, Seen[]> = { native: [], proxied: [] };
let run = "native";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt40</title>
<link rel="stylesheet" href="${B}/css?n=css"><script src="${B}/js?n=js"></script></head><body><h1>tt40</h1>
<img src="${A}/img?n=so"><img src="${A2}/img?n=ss"><img src="${B}/img?n=cs">
<img id="done" src="${A}/img?n=last"></body></html>`;
function siteHandler(self: string) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const u = new URL(req.url ?? "/", self), n = u.searchParams.get("n");
    if (n) seen[run].push({ n, cookie: String(req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).sort().join("; "), sfs: (req.headers["sec-fetch-site"] as string) ?? null, referer: (req.headers.referer as string) ?? null, origin: (req.headers.origin as string) ?? null });
    if (u.pathname === "/set") {
      const c = self === B ? ["b=1; SameSite=None; Secure", "bl=1; SameSite=Lax", "bs=1; SameSite=Strict", "bd=1"] : ["a=1", "as=1; SameSite=Strict"];
      res.writeHead(200, { "set-cookie": c, "content-type": "text/html" }); res.end("<p>set</p>"); return;
    }
    if (u.pathname === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE); return; }
    if (u.pathname === "/css") { res.writeHead(200, { "content-type": "text/css" }); res.end(`body { background: url("${B}/img?n=cssimg") }`); return; }
    if (u.pathname === "/js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end("window.__js = 1;"); return; }
    if (u.pathname === "/setimg") { res.writeHead(200, { "content-type": "image/png", "set-cookie": ["nx=1; SameSite=Lax", "ny=1; SameSite=None; Secure"] }); res.end(PNG); return; }
    if (u.pathname === "/img") { res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); return; }
    if (u.pathname === "/echo") { res.writeHead(200, { "content-type": "text/plain" }); res.end(String(req.headers.cookie ?? "")); return; }
    res.writeHead(404); res.end();
  };
}
const sA = http.createServer(siteHandler(A)), sA2 = http.createServer(siteHandler(A2));
const sB = https.createServer({ key: fs.readFileSync(`${CD}/b.key`), cert: fs.readFileSync(`${CD}/b.pem`) }, siteHandler(B));
let srv: ChildProcess | null = null, browser: Browser | null = null;
const NAMES = ["so", "ss", "cs", "css", "cssimg", "js", "setimg"];
const pick = (rows: Seen[]) => Object.fromEntries(NAMES.map((n) => { const r = rows.find((x) => x.n === n); return [n, r ? { cookie: r.cookie, sfs: r.sfs, referer: r.referer, origin: r.origin } : null]; }));

try {
  await Promise.all([new Promise<void>((r) => sA.listen(PA, "127.0.0.1", r)), new Promise<void>((r) => sA2.listen(PA2, "127.0.0.1", r)), new Promise<void>((r) => sB.listen(PB, "127.0.0.2", r))]);
  srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(PORT)], {
    env: { ...process.env, FUSION_WP_TEST_LOOPBACK_PORTS: `${PA},${PA2},${PB}`, FUSION_WP_UPSTREAM: "", FUSION_WP_OS_PROXY: "0", NODE_EXTRA_CA_CERTS: `${CD}/ca.pem` }, stdio: "ignore",
  });
  await poll(async () => (await fetch(`${ORIGIN}/api/wp-route`)).ok, "second server up", 40000);
  browser = await launchChromium();

  // ---- native (the oracle)
  run = "native";
  const nctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const np = await nctx.newPage();
  await np.goto(`${B}/set`); await np.goto(`${A}/set`); await np.goto(`${A}/page`, { waitUntil: "load" });
  await poll(() => ["so", "ss", "cs", "css", "cssimg", "js"].every((n) => seen.native.some((r) => r.n === n)), "native subresources");
  // the cookie-SETTING image only after every other load (no race on what the others saw); created by page script
  await np.evaluate((u) => new Promise<void>((res) => { const i = new Image(); i.onload = i.onerror = () => res(); i.src = u; }), `${B}/setimg?n=setimg`);
  await poll(() => seen.native.some((r) => r.n === "setimg"), "native setimg");
  await sleep(300);
  await np.goto(`${B}/echo?n=after`); // top-level: shows what B's jar holds now (nx refused? ny kept?)
  const nativeAfter = seen.native.find((r) => r.n === "after")!.cookie;
  await nctx.close();

  // ---- proxied
  run = "proxied";
  const sess = await (await fetch(`${ORIGIN}/api/wp-session`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ ua: "desktop" }) })).json() as { sid: string; prefix: string };
  ok(sess.sid, "session");
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  const P = (u: string) => `${ORIGIN}${sess.prefix}${u.replace("://", "/")}`;
  await pp.goto(P(`${B}/set`)); await pp.goto(P(`${A}/set`)); await pp.goto(P(`${A}/page`), { waitUntil: "load" });
  await poll(() => ["so", "ss", "cs", "css", "cssimg", "js"].every((n) => seen.proxied.some((r) => r.n === n)), "proxied subresources");
  // (through the proxy this image's src is set by page script — the shim tags it as a subresource of this document)
  await pp.evaluate((u) => new Promise<void>((res) => { const i = new Image(); i.onload = i.onerror = () => res(); i.src = u; }), `${B}/setimg?n=setimg`);
  await poll(() => seen.proxied.some((r) => r.n === "setimg"), "proxied setimg");
  await sleep(300);
  const html = await pp.evaluate(() => document.documentElement.outerHTML);
  await pp.goto(P(`${B}/echo?n=after`));
  const proxiedAfter = seen.proxied.find((r) => r.n === "after")!.cookie;
  await pp.goto(P(`${A}/page`), { waitUntil: "load" }); // back on the page for the adversary checks

  await test("WP-16 oracle: the cookies, Sec-Fetch-Site and Referer that sites A, A′ and B saw for 7 markup subresources of one page (a same-origin, a same-site and a cross-site image, a cross-site stylesheet AND the image that stylesheet loads, a cross-site script, and — created by page SCRIPT, tagged by the shim — a cross-site image that sets cookies) are IDENTICAL natively in Chromium and through the proxy; so is what that cross-site image could store (SameSite=Lax refused, SameSite=None kept)", { "WP-16": "full" }, async () => {
    const n = pick(seen.native), p = pick(seen.proxied);
    const diffs: string[] = [];
    for (const k of NAMES) {
      const a = n[k], b = p[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${k}\n      native  ${JSON.stringify(a)}\n      proxied ${JSON.stringify(b)}`);
    }
    if (nativeAfter !== proxiedAfter) diffs.push(`B's jar after the cross-site Set-Cookie\n      native  ${nativeAfter}\n      proxied ${proxiedAfter}`);
    ok(diffs.length === 0, `differences:\n    ${diffs.join("\n    ")}`);
    console.log(`     7 subresources identical; cross-site image saw "${p.cs?.cookie}", same-site "${p.ss?.cookie}"; B's jar after: "${proxiedAfter}"`);
  });

  await test("WP-16 oracle is not vacuous: cross-site subresources carried ONLY b=1 (not bl / bs / bd); same-site ones carried the Strict cookie too; the stylesheet's own image counted the PAGE as its initiator; Sec-Fetch-Site took all three values; nx (Lax from a cross-site response) was refused, ny kept; the page's markup really carries the subresource tag on img / link / script and NOT on navigations", { "WP-16": "full" }, async () => {
    const p = pick(seen.proxied);
    for (const k of ["cs", "css", "cssimg", "js"]) ok(p[k]?.cookie === "b=1" && p[k]?.sfs === "cross-site", `${k}: ${JSON.stringify(p[k])}`);
    ok(p.ss?.cookie === "a=1; as=1" && p.ss?.sfs === "same-site", `ss: ${JSON.stringify(p.ss)}`);
    ok(p.so?.cookie === "a=1; as=1" && p.so?.sfs === "same-origin", `so: ${JSON.stringify(p.so)}`);
    ok(/ny=1/.test(proxiedAfter) && !/nx=1/.test(proxiedAfter), `after: ${proxiedAfter}`);
    const imgTag = /<img[^>]*n=cs[^>]*>/.exec(html)?.[0] ?? "(none)";
    ok(/\/api\/wp\/s\/[^/":]+:[A-Za-z0-9_-]{8,32}:r\/https\/127\.0\.0\.2:41883\/img\?n=cs/.test(imgTag), `img tagged: ${imgTag}`);
    ok(/<link[^>]+href="[^"]*:r\/https\/127\.0\.0\.2:41883\/css/.test(html) && /<script[^>]+src="[^"]*:r\/https\/127\.0\.0\.2:41883\/js/.test(html), "link + script tagged");
  });

  await test("WP-16 adversary: a FORGED document id on a subresource gets only SameSite=None cookies (never more than a cross-site load); an \"r\" tag on a script fetch() is re-tagged by the shim and follows the script rules (no cookies with credentials same-origin cross-site); an \"r\" tag on a NAVIGATION is ignored (a top-level-in-frame load keeps its cookies)", { "WP-16": "full" }, async () => {
    const before = seen.proxied.length;
    // forged doc id, image load in the page (the browser says Sec-Fetch-Dest: image)
    await pp.evaluate((u) => new Promise<void>((res) => { const i = new Image(); i.onload = i.onerror = () => res(); i.src = u; }), `${ORIGIN}/api/wp/s/${sess.sid}:FORGEDdoc12345:r/https/127.0.0.2:${PB}/img?n=forged`);
    await poll(() => seen.proxied.some((r) => r.n === "forged"), "forged");
    const f = seen.proxied.find((r) => r.n === "forged")!;
    // every SameSite=None cookie B holds at this point (b, and ny stored by the cross-site image) — none of bl / bs / bd
    ok(f.cookie === "b=1; ny=1" && f.sfs === "cross-site" && f.referer === null, `forged: ${JSON.stringify(f)}`);
    // page script fetches an r-tagged URL: the shim re-tags it as a script request (credentials same-origin → no cookies cross-site)
    const tagged = await pp.evaluate(() => (document.querySelector("img[src*='n=cs']") as HTMLImageElement).getAttribute("src"));
    await pp.evaluate((u) => fetch(u.replace("n=cs", "n=scriptfetch")).then((r) => r.status).catch(() => -1), tagged);
    await poll(() => seen.proxied.some((r) => r.n === "scriptfetch"), "script fetch");
    const sf = seen.proxied.find((r) => r.n === "scriptfetch")!;
    ok(sf.cookie === "" && sf.origin !== null, `script fetch of an r-tagged URL: ${JSON.stringify(sf)}`);
    // navigation with an r tag: treated as a navigation — cookies of a top-level load (the proxy frame is the top)
    await pp.goto(`${ORIGIN}/api/wp/s/${sess.sid}:FORGEDdoc12345:r/https/127.0.0.2:${PB}/echo?n=navr`);
    const nv = seen.proxied.find((r) => r.n === "navr")!;
    ok(/bl=1/.test(nv.cookie) && /b=1/.test(nv.cookie), `navigation keeps cookies: ${JSON.stringify(nv)}`);
    console.log(`     forged → "${f.cookie}"; script fetch → "${sf.cookie}" (origin ${sf.origin}); navigation → "${nv.cookie}" (${seen.proxied.length - before} requests)`);
  });
  await pctx.close();
} finally {
  await browser?.close().catch(() => {});
  srv?.kill();
  sA.close(); sA2.close(); sB.close();
}

await finish();
process.exit(0);
