/**
 * TT38 end to end, real Chromium against a second production server of THIS build (next start), started with the
 * test-only loopback allowance (FUSION_WP_TEST_LOOPBACK_PORTS) so a local "site" and an independent WebSocket server
 * (Python websockets, scripts/fixtures/ws/ws_server.py) can stand in for the internet this sandbox cannot reach.
 *  WP-08  a proxied page's own `new WebSocket(...)` and `new EventSource(...)` work: spec behaviour seen from page
 *         script, frames intact both ways, the site sees the session's UA and the page's Origin, events arrive
 *         while the stream is still open (no buffering), leaving the page closes the socket upstream (1001)
 *  WP-09  the page's subresources share a few keep-alive connections (counted at the site)
 * Run with the main server up (it only builds the second one from the same .next): BASE is unused here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import type { Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { UA } from "../src/lib/wp-core.ts";

const { test, finish } = makeHarness("e2e-tt38");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const PORT = 3991, SITE = 41811, WSP = 41812;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(fn: () => Promise<boolean> | boolean, what: string, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await Promise.resolve(fn()).catch(() => false)) return; await sleep(100); } throw new Error(`timed out: ${what}`); }

// ------------------------------------------------------------------ the "site"
let conns = 0, reqs = 0;
const sseLog: number[] = [];
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tt38 site</title></head><body>
<h1>tt38</h1>${Array.from({ length: 8 }, (_, i) => `<img src="/img/${i}.png" width="1" height="1">`).join("")}
<pre id="out"></pre>
<script>
window.R = { log: [], done: {} };
const WSU = "ws://127.0.0.1:${WSP}";
function err(f) { try { f(); return "no error"; } catch (e) { return e.name; } }
R.ctor = {
  ftp: err(() => new WebSocket("ftp://x.test/")),
  frag: err(() => new WebSocket("wss://x.test/#a")),
  dup: err(() => new WebSocket("wss://x.test/", ["a", "a"])),
  badtoken: err(() => new WebSocket("wss://x.test/", ["a b"])),
  none: err(() => new WebSocket()),
};
R.consts = [WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED, WebSocket.name];
// echo: order across string / ArrayBuffer / Blob / typed array, binaryType, bufferedAmount, handler + listener order
(function () {
  const ws = new WebSocket(WSU + "/echo", ["chat.v1", "chat.v2"]);
  const seen = [];
  R.echo = { states: [ws.readyState], sendWhileConnecting: err(() => ws.send("x")), badClose: err(() => ws.close(1001)), longReason: err(() => ws.close(4000, "x".repeat(124))) };
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => seen.push("listener-open"));
  ws.onopen = () => {
    seen.push("handler-open");
    R.echo.protocol = ws.protocol; R.echo.url = ws.url; R.echo.states.push(ws.readyState);
    ws.send("one");
    ws.send(new Uint8Array([1, 2, 3]).buffer);
    ws.send(new Blob([new Uint8Array([4, 5])]));
    ws.send("four ✓");
    ws.send(new Uint16Array([0x0706]));
    R.echo.bufferedAfterSend = ws.bufferedAmount;
  };
  const got = [];
  ws.onmessage = (e) => {
    got.push(typeof e.data === "string" ? e.data : (e.data instanceof ArrayBuffer ? "ab:" + Array.from(new Uint8Array(e.data)).join(",") : "other"));
    R.echo.origin = e.origin;
    if (got.length === 5) { R.echo.bufferedAtEnd = ws.bufferedAmount; ws.close(4001, "bye ✓"); R.echo.states.push(ws.readyState); }
  };
  ws.onclose = (e) => { R.echo.got = got; R.echo.seen = seen; R.echo.close = [e.code, e.reason, e.wasClean]; R.echo.states.push(ws.readyState); R.done.echo = true; };
})();
// the site sees what the page would send
(function () {
  const ws = new WebSocket(WSU + "/headers");
  ws.onmessage = (e) => { R.headers = JSON.parse(e.data); ws.close(); R.done.headers = true; };
})();
// 200 messages in order, server-initiated clean close
(function () {
  const ws = new WebSocket(WSU + "/count"); const got = [];
  ws.onmessage = (e) => got.push(e.data);
  ws.onclose = (e) => { R.count = { inOrder: got.join(",") === Array.from({ length: 200 }, (_, i) => i + 1).join(","), n: got.length, close: [e.code, e.reason, e.wasClean] }; R.done.count = true; };
})();
// a server that does not exist: error, then close 1006
(function () {
  const ws = new WebSocket("ws://127.0.0.1:9/"); const ev = [];
  ws.onerror = () => ev.push("error"); ws.onopen = () => ev.push("open");
  ws.onclose = (e) => { ev.push("close:" + e.code + ":" + e.wasClean); R.refused = ev; R.done.refused = true; };
})();
// close() while connecting: error + close 1006, never open
(function () {
  const ws = new WebSocket(WSU + "/echo"); const ev = [];
  ws.onopen = () => ev.push("open"); ws.onerror = () => ev.push("error");
  ws.onclose = (e) => { ev.push("close:" + e.code); R.early = ev; R.done.early = true; };
  ws.close();
  ev.push("state:" + ws.readyState);
})();
// EventSource (relative URL → the site's own origin), arrival times
(function () {
  const t0 = performance.now(); const es = new EventSource("/sse");
  R.sse = { url: es.url, at: [], data: [] };
  es.onmessage = (e) => { R.sse.at.push(Math.round(performance.now() - t0)); R.sse.data.push(e.data); if (R.sse.data.length === 4) { es.close(); R.done.sse = true; } };
})();
// G/I attack from page script: scrape another document's secrets via fetch, then forge an origin at the bridge
(async function () {
  const tag = document.querySelector("script[data-wst]");
  const fetched = await (await fetch("/")).text();
  const shim = new DOMParser().parseFromString(fetched, "text/html").querySelector("script[data-fusion-wp]"); // parse: a regex would match this very script's source
  R.scrape = { ownToken: !!(tag && tag.dataset.wst), ownCookies: tag ? tag.dataset.cookies : null, fetchedToken: !!(shim && shim.dataset.wst), fetchedCookies: !!(shim && shim.dataset.cookies), fetchedHasShim: !!shim };
  const res = await window.__fusionWp.rawFetch.call(window, "/api/wp/s/" + tag.dataset.sid + "/__ws/open", { method: "POST", credentials: "omit", headers: { "content-type": "text/plain" }, body: JSON.stringify({ url: WSU + "/headers", protocols: [], origin: "http://127.0.0.1:41813", token: tag.dataset.wst }) });
  const reader = res.body.getReader(); let buf = new Uint8Array(0);
  for (;;) {
    const r = await reader.read(); if (r.done) break;
    const b = new Uint8Array(buf.length + r.value.length); b.set(buf); b.set(r.value, buf.length); buf = b;
    let got = null;
    while (buf.length >= 5) { const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1); if (buf.length < 5 + len) break; if (buf[0] === 2) got = new TextDecoder().decode(buf.slice(5, 5 + len)); buf = buf.slice(5 + len); }
    if (got) { R.forged = JSON.parse(got); reader.cancel().catch(() => {}); break; }
  }
  R.done.forge = true;
})().catch((e) => { R.forgeError = String(e); R.done.forge = true; });
// a socket that stays open until the page goes away
window.hold = new WebSocket(WSU + "/hold");
hold.onmessage = () => { R.done.hold = true; };
</script></body></html>`;
const site = http.createServer((req, res) => {
  reqs++;
  if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.setHeader("set-cookie", "sc=1; Path=/"); res.end(PAGE); return; }
  if (req.url?.startsWith("/img/")) { res.setHeader("content-type", "image/png"); res.end(PIXEL); return; }
  if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let n = 0;
    const tick = () => { n++; sseLog.push(Date.now()); res.write(`data: e${n}\n\n`); if (n < 4) setTimeout(tick, 500); else setTimeout(() => res.end(), 3000); };
    tick();
    return;
  }
  res.writeHead(404); res.end();
});
site.on("connection", () => { conns++; });
site.keepAliveTimeout = 30_000;

let srv: ChildProcess | null = null, py: ChildProcess | null = null, browser: Browser | null = null;
const pyLines: string[] = [];
try {
  await new Promise<void>((r) => site.listen(SITE, "127.0.0.1", r));
  py = spawn(PY, ["scripts/fixtures/ws/ws_server.py", String(WSP)], { stdio: ["ignore", "pipe", "inherit"] });
  py.stdout!.on("data", (d: Buffer) => pyLines.push(...d.toString().split("\n").filter(Boolean)));
  srv = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(PORT)], {
    env: { ...process.env, FUSION_WP_TEST_LOOPBACK_PORTS: `${SITE},${WSP}`, FUSION_WP_UPSTREAM: "" }, stdio: "ignore",
  });
  await poll(() => pyLines.some((l) => l.startsWith("READY")), "ws server");
  await poll(async () => (await fetch(`${ORIGIN}/api/wp-route`)).ok, "second server up", 40000);
  const sess = await (await fetch(`${ORIGIN}/api/wp-session`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ ua: "desktop" }) })).json() as { sid: string; prefix: string };
  ok(sess.sid, "session");
  browser = await launchChromium();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  conns = 0; reqs = 0;
  await page.goto(`${ORIGIN}${sess.prefix}http/127.0.0.1:${SITE}/`);
  await poll(async () => await page.evaluate(() => { const d = (window as any).R?.done ?? {}; return ["echo", "headers", "count", "refused", "early", "sse", "hold", "forge"].every((k) => d[k]); }), "page results", 25000);
  const R = await page.evaluate(() => (window as any).R);

  await test("WebSocket in a proxied page (WP-08): the page's own `new WebSocket` reaches the site through Fusion — readyState CONNECTING→OPEN→CLOSING→CLOSED, subprotocol chat.v2, string / ArrayBuffer / Blob / typed-array sends echoed in order with binaryType 'arraybuffer', bufferedAmount counts queued bytes and drains to 0, handler and listener fire in registration order, MessageEvent.origin is the socket's origin, close(4001, 'bye ✓') ends clean; 200 server messages arrive in order", { "WP-08": "full" }, () => {
    const e = R.echo;
    ok(JSON.stringify(e.states) === "[0,1,2,3]", `states ${JSON.stringify(e.states)}`);
    ok(e.protocol === "chat.v2" && e.url === `ws://127.0.0.1:${WSP}/echo`, `protocol/url ${e.protocol} ${e.url}`);
    ok(JSON.stringify(e.got) === JSON.stringify(["one", "ab:1,2,3", "ab:4,5", "four ✓", "ab:6,7"]), `order ${JSON.stringify(e.got)}`);
    ok(e.bufferedAfterSend === 3 + 3 + 2 + 8 + 2 && e.bufferedAtEnd === 0, `bufferedAmount ${e.bufferedAfterSend} → ${e.bufferedAtEnd}`);
    ok(JSON.stringify(e.seen) === JSON.stringify(["listener-open", "handler-open"]), `listener order ${JSON.stringify(e.seen)}`);
    ok(e.origin === `ws://127.0.0.1:${WSP}`, `origin ${e.origin}`);
    ok(JSON.stringify(e.close) === JSON.stringify([4001, "bye ✓", true]), `close ${JSON.stringify(e.close)}`);
    ok(R.count.inOrder && R.count.n === 200 && JSON.stringify(R.count.close) === JSON.stringify([1000, "done", true]), `count ${JSON.stringify(R.count)}`);
    ok(errors.length === 0, `page errors: ${errors.join(" | ")}`);
    console.log(`    states 0→1→2→3; 5 mixed sends in order; buffered ${e.bufferedAfterSend}→0; 200/200 in order; close 4001 clean`);
  });

  await test("WebSocket errors exactly where a browser raises them (WP-08): SyntaxError for a non-ws scheme, a fragment, duplicate or invalid subprotocols; TypeError with no argument; InvalidStateError for send() while CONNECTING; InvalidAccessError for close(1001); SyntaxError for a 124-byte reason; an unreachable server → 'error' then close 1006 (not clean); close() while connecting → error + close 1006 and never 'open'; constants and name match the platform", { "WP-08": "full" }, () => {
    ok(JSON.stringify(R.ctor) === JSON.stringify({ ftp: "SyntaxError", frag: "SyntaxError", dup: "SyntaxError", badtoken: "SyntaxError", none: "TypeError" }), `ctor ${JSON.stringify(R.ctor)}`);
    ok(R.echo.sendWhileConnecting === "InvalidStateError" && R.echo.badClose === "InvalidAccessError" && R.echo.longReason === "SyntaxError", `echo errs ${JSON.stringify(R.echo)}`);
    ok(JSON.stringify(R.refused) === JSON.stringify(["error", "close:1006:false"]), `refused ${JSON.stringify(R.refused)}`);
    ok(JSON.stringify(R.early) === JSON.stringify(["state:2", "error", "close:1006"]), `early ${JSON.stringify(R.early)}`);
    ok(JSON.stringify(R.consts) === JSON.stringify([0, 1, 2, 3, "WebSocket"]), `consts ${JSON.stringify(R.consts)}`);
  });

  await test("what the site sees (WP-08): the WebSocket handshake carries the session's User-Agent (not the real browser's) and the PAGE's origin (the site's own, not Fusion's), and the site's own cookie from the session jar", { "WP-08": "full" }, async () => {
    // the session was created as "desktop": the site must see exactly that UA (the test browser's own UA is set by
    // browser-launch, so comparing with navigator.userAgent would prove nothing)
    ok(R.headers.origin === `http://127.0.0.1:${SITE}`, `origin ${R.headers.origin}`);
    ok(R.headers.ua === UA.desktop, `ua ${R.headers.ua}`);
    // the page's own site set sc=1 when the page loaded; cookies are not port-scoped, so the socket on another port
    // of the same host carries it — as in a browser
    ok(R.headers.cookie === "sc=1", `cookie ${R.headers.cookie}`);
  });

  await test("EventSource in a proxied page (WP-08): a relative EventSource URL resolves against the SITE (es.url is the site's address, not the proxy's) and events arrive one by one while the stream is open — each ~500 ms after the last, not all at the end (nothing buffers the stream)", { "WP-08": "full" }, () => {
    ok(R.sse.url === `http://127.0.0.1:${SITE}/sse`, `url ${R.sse.url}`);
    ok(JSON.stringify(R.sse.data) === JSON.stringify(["e1", "e2", "e3", "e4"]), `data ${JSON.stringify(R.sse.data)}`);
    const gaps = R.sse.at.slice(1).map((t: number, i: number) => t - R.sse.at[i]);
    ok(gaps.every((g: number) => g > 300 && g < 900), `arrival gaps ${JSON.stringify(gaps)} (at ${JSON.stringify(R.sse.at)})`);
    console.log(`    SSE arrival ms ${JSON.stringify(R.sse.at)} (gaps ${JSON.stringify(gaps)})`);
  });

  await test("adversary in the page (WP-08, G/I): page script that fetches its own site's HTML through the proxy gets a copy WITHOUT the WebSocket origin token and WITHOUT script cookies (only navigations carry them — Sec-Fetch-Dest, which script cannot set); calling the bridge directly while claiming another origin with its own token makes the site see Origin 'null', not the claimed one", { "WP-08": "full" }, () => {
    ok(!R.forgeError, `forge script error: ${R.forgeError}`);
    ok(R.scrape.ownToken && R.scrape.ownCookies === "sc=1", `own document: ${JSON.stringify(R.scrape)}`);
    ok(R.scrape.fetchedHasShim && !R.scrape.fetchedToken && !R.scrape.fetchedCookies, `fetched copy: ${JSON.stringify(R.scrape)}`);
    ok(R.forged.origin === "null" && R.forged.cookie === null, `forged claim: ${JSON.stringify(R.forged)}`);
  });

  await test("keep-alive through the real server (WP-09): the page and its 8 images and event stream are carried over a few reused connections to the site (counted at the site), not one connection per request", { "WP-09": "full" }, () => {
    ok(reqs >= 10 && conns <= 6 && conns < reqs, `${reqs} requests over ${conns} connections`);
    console.log(`    ${reqs} requests over ${conns} TCP connections`);
  });

  await test("leaving the page closes its sockets upstream (WP-08): navigating away ends the bridge stream and the site's server sees close 1001 (going away) — no orphan socket stays open on the server", { "WP-08": "full" }, async () => {
    const before = pyLines.filter((l) => l === "CLOSED 1001").length;
    await page.goto("about:blank");
    await poll(() => pyLines.filter((l) => l === "CLOSED 1001").length > before, "server saw 1001", 10000);
  });
  await ctx.close();
} finally {
  await browser?.close();
  srv?.kill("SIGTERM");
  py?.kill();
  site.close();
  void net;
}
await finish();
process.exit(process.exitCode ?? 0);
