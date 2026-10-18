/**
 * TT39 unit + interop tests (no Next server needed):
 *  WP-10  per-origin isolation rules (src/lib/wp-cors.ts): the session segment codec, CORS-safelisted request headers,
 *         the policy (cookies, Origin, Referer, Sec-Fetch-Site), the CORS check, the preflight check and cache (with
 *         `*` semantics), Set-Cookie storage, readable response headers; Node's TLS identity default for IP literals
 *  WS     permessage-deflate (RFC 7692, src/lib/server/ws-deflate.ts + ws-client.ts): negotiation parsing (valid and
 *         hostile answers), interop with an independent server (Python `websockets` 13.1, BSD-3) with default and
 *         with non-default parameters (no context takeover, 10/9-bit windows) — wire bytes measured — and hostile raw
 *         servers (a decompression bomb, corrupt data, RSV1 where it may not be, ordering behind an inflate)
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt39-unit.mts
 */
import * as net from "node:net";
import * as tls from "node:tls";
import * as https from "node:https";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { makeHarness } from "./harness.mts";

const CORS = await import("../src/lib/wp-cors.ts");
const CORE = await import("../src/lib/wp-core.ts");
const WC = await import("../src/lib/server/ws-client.ts");
const WD = await import("../src/lib/server/ws-deflate.ts");

const { test, finish } = makeHarness("tt39-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const throwsMsg = (f: () => unknown): string => { try { f(); return ""; } catch (e) { return (e as Error).message; } };

// ===================================================================================== WP-10: the rules
const SID = "AbCdEfGhIjKlMnOp";
await test("session segment codec (WP-10): '<sid>' and '<sid>:<doc>:<i|s|o>' decode; 9 malformed shapes are refused (extra colon, empty doc, short doc, bad doc chars, unknown credentials code, upper-case code, missing code, bad sid, colon in the target part is just path)", { "WP-10": "full" }, () => {
  eq(CORS.parseSidSegment(SID), { sid: SID });
  eq(CORS.parseSidSegment(`${SID}:abcdEFGH12345678:i`), { sid: SID, doc: "abcdEFGH12345678", cred: "include" });
  eq(CORS.parseSidSegment(`${SID}:abcdEFGH:o`)?.cred, "omit");
  const d = CORE.decodeTarget(`/api/wp/s/${SID}:abcdEFGH12345678:s/https/a.example/x:y`, "?q=1");
  eq([d.sid, d.doc, d.cred, d.target.href], [SID, "abcdEFGH12345678", "same-origin", "https://a.example/x:y?q=1"]);
  for (const bad of [`${SID}:abcdEFGH12345678:i:x`, `${SID}::i`, `${SID}:abc:i`, `${SID}:abcd$FGH12345678:i`, `${SID}:abcdEFGH12345678:x`, `${SID}:abcdEFGH12345678:I`, `${SID}:abcdEFGH12345678`]) eq(CORS.parseSidSegment(bad), null, bad);
  ok(/bad session id/.test(throwsMsg(() => CORE.decodeTarget(`/api/wp/s/sh:abcdEFGH12345678:i/https/a.example/`))), "short sid");
  ok(/bad session id/.test(throwsMsg(() => CORE.decodeTarget(`/api/wp/s/${SID}:abcdEFGH12345678:q/https/a.example/`))), "bad cred");
});

await test("CORS-safelisted request headers (Fetch §2.2.2 vectors): text/plain;charset=UTF-8, multipart with boundary and form-urlencoded are safe; application/json, a '(' in Accept, a value over 128 bytes, 'bytes=5-1' and multi-range are not; forbidden / browser-added names never count; >1024 bytes of safelisted values makes them all unsafe", { "WP-10": "full" }, () => {
  ok(CORS.isSafelistedHeader("content-type", "text/plain;charset=UTF-8"), "text/plain");
  ok(CORS.isSafelistedHeader("Content-Type", "multipart/form-data; boundary=----WebKitFormBoundaryAb12"), "multipart");
  ok(CORS.isSafelistedHeader("content-type", "application/x-www-form-urlencoded"), "form");
  ok(!CORS.isSafelistedHeader("content-type", "application/json"), "json");
  ok(!CORS.isSafelistedHeader("content-type", "text/plain; x=\"(\""), "unsafe byte in content-type");
  ok(CORS.isSafelistedHeader("accept", "text/html, */*;q=0.8") && !CORS.isSafelistedHeader("accept", "a(b"), "accept");
  ok(!CORS.isSafelistedHeader("accept", "x".repeat(129)), "length");
  ok(CORS.isSafelistedHeader("range", "bytes=0-") && CORS.isSafelistedHeader("range", "bytes=5-10") && !CORS.isSafelistedHeader("range", "bytes=5-1") && !CORS.isSafelistedHeader("range", "bytes=0-1,3-4"), "range");
  ok(CORS.isSafelistedHeader("accept-language", "en-US,en;q=0.9") && !CORS.isSafelistedHeader("accept-language", "en_US"), "accept-language");
  eq(CORS.unsafeHeaderNames([["X-B", "1"], ["x-a", "2"], ["cookie", "a=b"], ["sec-fetch-mode", "cors"], ["user-agent", "u"], ["cache-control", "no-cache"], ["content-type", "text/plain"], ["Authorization", "t"]]), ["authorization", "x-a", "x-b"]);
  const nine = Array.from({ length: 9 }, (_, i) => ["accept" + (i ? "-language" : ""), "a".repeat(120)] as [string, string]).slice(0, 2);
  eq(CORS.unsafeHeaderNames(nine), []);
  const big: [string, string][] = [["accept", "a".repeat(128)], ["accept-language", "b".repeat(128)], ["content-language", "c".repeat(128)], ["content-type", "text/plain;" + "d".repeat(100)], ...Array.from({ length: 6 }, () => ["accept", "e".repeat(110)] as [string, string])];
  eq(CORS.unsafeHeaderNames(big), ["accept", "accept-language", "content-language", "content-type"], "1024-byte rule");
});

const siteOf = CORE.siteOf;
const A = "http://127.0.0.1:41811";
const pol = (initiator: string | null, target: string, cred: "include" | "same-origin" | "omit", method = "GET", headers: [string, string][] = []) =>
  CORS.policyFor({ initiator, target: new URL(target), cred, method, headers, siteOf });

await test("policy (WP-10): same-origin GET sends cookies but no Origin; same-origin POST sends Origin; cross-origin same-site and cross-site send Origin, origin-only Referer and the right Sec-Fetch-Site; credentials only for include (or same-origin mode on the same origin); http↔https is cross-site (schemeful); https→http drops Referer; an unknown initiator is 'null' with no cookies", { "WP-10": "full" }, () => {
  let p = pol(A, `${A}/x`, "same-origin");
  ok(p.sameOrigin && p.sendCookies && p.origin === null && p.secFetchSite === "same-origin" && !p.needsPreflight, `so ${JSON.stringify(p)}`);
  p = pol(A, `${A}/x`, "same-origin", "POST"); eq(p.origin, A);
  p = pol(A, `${A}/x`, "omit"); ok(!p.sendCookies, "omit");
  p = pol(A, "http://127.0.0.1:41813/x", "same-origin"); ok(!p.sameOrigin && p.sameSite && !p.sendCookies && p.secFetchSite === "same-site" && p.origin === A && p.referer === `${A}/`, `ss ${JSON.stringify(p)}`);
  p = pol(A, "http://127.0.0.1:41813/x", "include"); ok(p.sendCookies && !p.crossSite, "ss include");
  p = pol("https://www.example.co.uk", "https://api.example.co.uk/x", "include"); ok(p.sameSite && p.secFetchSite === "same-site", "registrable domain");
  p = pol("http://example.com", "https://example.com/x", "include"); ok(!p.sameSite && p.crossSite && p.secFetchSite === "cross-site", "schemeful");
  p = pol("https://a.example", "http://b.example/x", "include"); eq(p.referer, null, "https→http");
  p = pol(null, `${A}/x`, "include"); ok(!p.sendCookies && p.origin === "null" && p.referer === null && p.secFetchSite === "cross-site", `null ${JSON.stringify(p)}`);
  p = pol(A, "https://b.example/x", "same-origin", "PUT"); ok(p.needsPreflight, "PUT cross-origin preflights");
  p = pol(A, "https://b.example/x", "same-origin", "POST", [["content-type", "application/json"]]); ok(p.needsPreflight && p.unsafeHeaders.join() === "content-type", "json");
  p = pol(A, `${A}/x`, "same-origin", "PUT", [["x-y", "1"]]); ok(!p.needsPreflight, "same-origin never preflights");
});

await test("CORS check (WP-10, Fetch §4.10): ACAO * passes without credentials and fails with them; an echoed origin passes; a different origin, 'null' for a real origin, a missing header and a comma list fail; with credentials ACAC must be exactly 'true'; an unknown initiator matches only 'null' or *", { "WP-10": "full" }, () => {
  const P = pol(A, "https://b.example/x", "same-origin"), I = pol(A, "https://b.example/x", "include"), N = pol(null, "https://b.example/x", "same-origin");
  ok(CORS.corsCheck(P, { "access-control-allow-origin": "*" }).ok, "* no creds");
  ok(!CORS.corsCheck(I, { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" }).ok, "* with creds");
  ok(CORS.corsCheck(P, { "access-control-allow-origin": A }).ok, "echo");
  ok(!CORS.corsCheck(P, { "access-control-allow-origin": "http://127.0.0.1:41813" }).ok, "other origin");
  ok(!CORS.corsCheck(P, { "access-control-allow-origin": "null" }).ok, "null for a real origin");
  ok(!CORS.corsCheck(P, {}).ok, "missing");
  ok(!CORS.corsCheck(P, { "access-control-allow-origin": `${A}, *` }).ok, "list");
  ok(CORS.corsCheck(I, { "access-control-allow-origin": A, "access-control-allow-credentials": "true" }).ok, "creds ok");
  ok(!CORS.corsCheck(I, { "access-control-allow-origin": A, "access-control-allow-credentials": "TRUE" }).ok, "ACAC case");
  ok(!CORS.corsCheck(I, { "access-control-allow-origin": A }).ok, "no ACAC");
  ok(CORS.corsCheck(N, { "access-control-allow-origin": "null" }).ok && CORS.corsCheck(N, { "access-control-allow-origin": "*" }).ok && !CORS.corsCheck(N, { "access-control-allow-origin": A }).ok, "null initiator");
});

await test("preflight check + cache (WP-10, Fetch §4.8/§4.9): methods compare case-sensitively; `*` covers methods and headers only without credentials; Authorization under `*` follows deployed browsers by default and the spec text in strict mode; default Max-Age 5 s, capped at 7200 s; cache entries match per method / header name, `*` entries without credentials only, and expire", { "WP-10": "full" }, () => {
  const T = "https://b.example/x";
  const P = pol(A, T, "same-origin", "PUT", [["x-custom", "1"]]);
  let r = CORS.preflightCheck(P, "PUT", 204, { "access-control-allow-origin": A, "access-control-allow-methods": "PUT", "access-control-allow-headers": "X-Custom" });
  ok(r.ok && r.maxAge === 5, `ok ${JSON.stringify(r)}`);
  ok(!CORS.preflightCheck(P, "PUT", 204, { "access-control-allow-origin": A, "access-control-allow-methods": "put", "access-control-allow-headers": "x-custom" }).ok, "method case");
  ok(!CORS.preflightCheck(P, "PUT", 500, { "access-control-allow-origin": A, "access-control-allow-methods": "PUT", "access-control-allow-headers": "x-custom" }).ok, "status");
  ok(CORS.preflightCheck(P, "PUT", 200, { "access-control-allow-origin": A, "access-control-allow-methods": "*", "access-control-allow-headers": "*" }).ok, "wildcards");
  const I = pol(A, T, "include", "PUT", [["x-custom", "1"]]);
  ok(!CORS.preflightCheck(I, "PUT", 200, { "access-control-allow-origin": A, "access-control-allow-credentials": "true", "access-control-allow-methods": "*", "access-control-allow-headers": "x-custom" }).ok, "* methods with creds");
  ok(!CORS.preflightCheck(I, "PUT", 200, { "access-control-allow-origin": A, "access-control-allow-credentials": "true", "access-control-allow-methods": "PUT", "access-control-allow-headers": "*" }).ok, "* headers with creds");
  const Au = pol(A, T, "same-origin", "GET", [["authorization", "Bearer t"]]);
  const star = { "access-control-allow-origin": A, "access-control-allow-headers": "*" };
  ok(CORS.preflightCheck(Au, "GET", 200, star).ok, "Authorization under * (browsers)");
  ok(!CORS.preflightCheck(Au, "GET", 200, star, true).ok, "Authorization under * (strict spec)");
  ok(CORS.preflightCheck(Au, "GET", 200, { ...star, "access-control-allow-headers": "*, Authorization" }, true).ok, "listed explicitly");
  r = CORS.preflightCheck(P, "PUT", 204, { "access-control-allow-origin": A, "access-control-allow-methods": "PUT", "access-control-allow-headers": "x-custom", "access-control-max-age": "86400" });
  ok(r.ok && r.maxAge === 7200, "cap");
  // cache
  const c = new CORS.PreflightCache(), now = 1_000_000;
  ok(c.needs(P, T, "PUT", now), "empty cache");
  c.store(P, T, { maxAge: 10, methods: ["PUT"], headers: ["x-custom"] }, now);
  ok(!c.needs(P, T, "PUT", now + 1000), "hit");
  ok(c.needs(pol(A, T, "same-origin", "PUT", [["x-other", "1"]]), T, "PUT", now + 1000), "other header misses");
  ok(c.needs(P, T, "DELETE", now + 1000), "other method misses");
  ok(c.needs(P, T + "?2", "PUT", now + 1000), "other URL misses");
  ok(c.needs(P, T, "PUT", now + 10_001), "expired");
  c.store(P, T, { maxAge: 10, methods: ["*"], headers: ["*"] }, now);
  ok(!c.needs(pol(A, T, "same-origin", "PATCH", [["x-z", "1"]]), T, "PATCH", now + 1), "* entries without credentials");
  ok(c.needs(pol(A, T, "include", "PATCH", [["x-z", "1"]]), T, "PATCH", now + 1), "credentials never use another mode's entries");
});

await test("cookie storage, readable headers (WP-10): a script request stores Set-Cookie only if it could send cookies, cross-site only SameSite=None; same-origin reads every header, cross-origin only exposed ones (ACEH * only without credentials); a script response never carries headers that would act on Fusion's own origin (Set-Cookie, Clear-Site-Data, WWW-Authenticate, CSP, HSTS, Link, Refresh, Service-Worker-Allowed, ACAO from the site)", { "WP-10": "full" }, () => {
  const lines = ["a=1; SameSite=None; Secure", "b=2; SameSite=Lax", "c=3"];
  eq(CORS.storableSetCookies(pol(A, `${A}/x`, "same-origin"), lines), lines);
  eq(CORS.storableSetCookies(pol(A, `${A}/x`, "omit"), lines), []);
  eq(CORS.storableSetCookies(pol(A, "https://b.example/x", "same-origin"), lines), []);
  eq(CORS.storableSetCookies(pol(A, "https://b.example/x", "include"), lines), ["a=1; SameSite=None; Secure"]);
  eq(CORS.storableSetCookies(pol(null, `${A}/x`, "include"), lines), []);
  eq(CORS.exposeHeaders(pol(A, `${A}/x`, "same-origin"), {}), "*");
  eq(CORS.exposeHeaders(pol(A, "https://b.example/x", "same-origin"), { "access-control-expose-headers": "X-Total, Link" }), "x-total, link, x-fusion-wp-target");
  eq(CORS.exposeHeaders(pol(A, "https://b.example/x", "same-origin"), { "access-control-expose-headers": "*" }), "*");
  eq(CORS.exposeHeaders(pol(A, "https://b.example/x", "include"), { "access-control-expose-headers": "*" }), "x-fusion-wp-target");
  const h = CORS.scriptResponseHeaders({ "x-total-count": "7", "content-type": "application/json", "set-cookie": ["a=1"], "clear-site-data": "\"*\"", "www-authenticate": "Basic", "content-security-policy": "x", "strict-transport-security": "max-age=1", link: "</a>; rel=preload", refresh: "0;url=/", "service-worker-allowed": "/", "access-control-allow-origin": "*", "cross-origin-resource-policy": "same-site", "x-evil\r\ninjected": "1", etag: "\"e\"" });
  eq(Object.keys(h).sort(), ["content-type", "etag", "x-total-count"]);
});

// ===================================================================================== TLS identity (the TT39 fix)
const CD = "/tmp/tt39-unit-certs";
fs.rmSync(CD, { recursive: true, force: true }); fs.mkdirSync(CD, { recursive: true });
const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: CD, stdio: "pipe" });
ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=tt39 unit CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "l.key", "-out", "l.csr", "-subj", "/CN=l");
fs.writeFileSync(`${CD}/l.ext`, "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
ossl("x509", "-req", "-in", "l.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "l.pem", "-days", "2", "-extfile", "l.ext");

await test("TLS identity for IP-literal sites — why the TT39 fix is needed: Node's tls.connect over an existing socket WITHOUT `host` checks the certificate against \"localhost\" (a localhost-only certificate is ACCEPTED for 127.0.0.2); WITH host 127.0.0.2 (what wp-connect / wp-tunnel now pass) the same certificate is refused (ERR_TLS_CERT_ALTNAME_INVALID)", { "WP-09": "partial" }, async () => {
  const srv = https.createServer({ key: fs.readFileSync(`${CD}/l.key`), cert: fs.readFileSync(`${CD}/l.pem`) }, (q, r) => { r.end("x"); });
  await new Promise<void>((r) => srv.listen(41831, "127.0.0.2", r));
  const ca = fs.readFileSync(`${CD}/ca.pem`);
  const attempt = (host?: string) => new Promise<string>((resolve) => {
    const sock = net.connect(41831, "127.0.0.2", () => {
      const t = tls.connect({ socket: sock, ca, ...(host ? { host } : {}) });
      t.once("secureConnect", () => { t.destroy(); resolve("accepted"); });
      t.once("error", (e: NodeJS.ErrnoException) => { sock.destroy(); resolve(e.code ?? e.message); });
    });
  });
  try {
    const before = await attempt(), after = await attempt("127.0.0.2");
    console.log(`    without host: ${before}; with host 127.0.0.2: ${after}`);
    eq(before, "accepted", "Node default (the bug)");
    eq(after, "ERR_TLS_CERT_ALTNAME_INVALID", "with host");
  } finally { srv.close(); }
});

// ===================================================================================== permessage-deflate
await test("permessage-deflate negotiation (RFC 7692 §7): the client offers 'permessage-deflate; client_max_window_bits'; valid answers parse (defaults 15/15, both no_context_takeover flags, quoted \"10\"); 12 hostile answers fail the handshake (another extension, two elements, unknown parameter, duplicate, value on a flag, bits 7 / 16 / 08 / missing value, unterminated quote, garbage)", { "WP-13": "full" }, () => {
  ok(WC.handshakeRequest({ host: "h", path: "/", key: "k", protocols: [], deflate: true }).includes("\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n"), "offer");
  ok(!WC.handshakeRequest({ host: "h", path: "/", key: "k", protocols: [] }).includes("Extensions"), "no offer when off");
  eq(WD.parseDeflateResponse("permessage-deflate"), { serverNoContextTakeover: false, clientNoContextTakeover: false, serverMaxWindowBits: 15, clientMaxWindowBits: 15 });
  eq(WD.parseDeflateResponse("Permessage-Deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=\"10\"; client_max_window_bits=9"), { serverNoContextTakeover: true, clientNoContextTakeover: true, serverMaxWindowBits: 10, clientMaxWindowBits: 9 });
  const bad = ["x-webkit-deflate-frame", "permessage-deflate, permessage-deflate", "permessage-deflate; foo", "permessage-deflate; server_no_context_takeover; server_no_context_takeover",
    "permessage-deflate; server_no_context_takeover=1", "permessage-deflate; server_max_window_bits=7", "permessage-deflate; server_max_window_bits=16", "permessage-deflate; server_max_window_bits=08",
    "permessage-deflate; client_max_window_bits", "permessage-deflate; server_max_window_bits=\"10", "permessage-deflate; ;;", "permessage-deflate x"];
  for (const b of bad) ok(throwsMsg(() => WD.parseDeflateResponse(b)) !== "", `accepted hostile answer: ${b}`);
  const head = (ext: string) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${WC.acceptFor("k")}\r\nSec-WebSocket-Extensions: ${ext}`;
  ok(/not offered/.test(throwsMsg(() => WC.verifyHandshake(head("permessage-deflate"), "k", [], false))), "not offered → refused");
  eq(WC.verifyHandshake(head("permessage-deflate; server_max_window_bits=12"), "k", [], true).deflate?.serverMaxWindowBits, 12);
});

function startPy(port: number, mode?: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, ["scripts/fixtures/ws/ws_server.py", String(port), ...(mode ? [mode] : [])], { stdio: ["ignore", "pipe", "inherit"] });
    const t = setTimeout(() => reject(new Error("python ws server did not start")), 15000);
    p.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("READY")) { clearTimeout(t); resolve(p); } });
  });
}
function tapOpen(tap: { r: number; w: number }) {
  return (host: string, port: number) => new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(s));
    s.once("error", reject);
    s.on("data", (c: Buffer) => { tap.r += c.length; });
    const w = s.write.bind(s) as (c: Buffer | string, ...a: unknown[]) => boolean;
    (s as unknown as { write: typeof w }).write = (c: Buffer | string, ...a: unknown[]) => { tap.w += typeof c === "string" ? Buffer.byteLength(c) : c.length; return w(c, ...a); };
  });
}
type Got = { msgs: (string | Buffer)[]; close?: [number, string, boolean] };
function collect(ws: InstanceType<typeof WC.WsClient>): Got {
  const g: Got = { msgs: [] };
  ws.on("message", (d: string | Buffer) => g.msgs.push(d));
  ws.on("close", (c: number, r: string, w: boolean) => { g.close = [c, r, w]; });
  return g;
}
async function until(f: () => boolean, ms = 10000, what = "condition") { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(10); } }

let pyDef: ChildProcess | null = null, pySmall: ChildProcess | null = null;
try {
  pyDef = await startPy(41832); pySmall = await startPy(41833, "small");

  await test("permessage-deflate interop, defaults (Python websockets 13.1 server): negotiated; text and binary messages from 0 B to 1 MiB round-trip intact; a 1 MiB repetitive text message crosses the wire COMPRESSED in both directions (bytes counted on the socket); 50 similar messages in a row (context takeover) all decode", { "WP-13": "full" }, async () => {
    const tap = { r: 0, w: 0 };
    const c = await WC.connectWebSocket({ url: "ws://127.0.0.1:41832/echo", open: tapOpen(tap) });
    const g = collect(c.ws);
    ok(c.deflate && c.ws.deflate, `deflate not negotiated (extensions: ${c.extensions})`);
    console.log(`    negotiated: ${c.extensions}`);
    const samples: (string | Buffer)[] = ["", "a", "héllo ✓", "x".repeat(200), Buffer.alloc(0), randomBytes(5000), Buffer.from(randomBytes(70000))];
    for (const s of samples) c.ws.send(s);
    await until(() => g.msgs.length === samples.length, 10000, "echoes");
    for (let i = 0; i < samples.length; i++) ok(Buffer.isBuffer(samples[i]) ? Buffer.isBuffer(g.msgs[i]) && (g.msgs[i] as Buffer).equals(samples[i] as Buffer) : g.msgs[i] === samples[i], `sample ${i}`);
    const r0 = tap.r, w0 = tap.w;
    const big = "The quick brown fox jumps over the lazy dog. ".repeat(23302).slice(0, 1 << 20);
    c.ws.send(big);
    await until(() => g.msgs.length === samples.length + 1, 15000, "big echo");
    ok(g.msgs[samples.length] === big, "1 MiB text intact");
    const sent = tap.w - w0, recv = tap.r - r0;
    console.log(`    1 MiB text: ${sent} bytes written, ${recv} bytes read on the wire`);
    ok(sent < 64 * 1024 && recv < 64 * 1024, `not compressed: wrote ${sent}, read ${recv}`);
    const before = g.msgs.length;
    for (let i = 0; i < 50; i++) c.ws.send(`{"type":"tick","seq":${i},"payload":"${"abc".repeat(40)}"}`);
    await until(() => g.msgs.length === before + 50, 10000, "50 ticks");
    ok(g.msgs.slice(before).every((m, i) => m === `{"type":"tick","seq":${i},"payload":"${"abc".repeat(40)}"}`), "ticks in order and intact");
    c.ws.close(1000, "done");
    await until(() => !!g.close, 5000, "close");
    eq(g.close, [1000, "done", true]);
  });

  await test("permessage-deflate interop, non-default parameters (server_no_context_takeover, client_no_context_takeover, server_max_window_bits=10, client_max_window_bits=9 — the server requires our offer of client_max_window_bits): negotiated as such; repeated identical messages (back-references across messages would break the server's fresh-context inflater) and a message repeating a 600-byte random block (a distance a 9-bit window may not use) all round-trip", { "WP-13": "full" }, async () => {
    const tap = { r: 0, w: 0 };
    const c = await WC.connectWebSocket({ url: "ws://127.0.0.1:41833/echo", open: tapOpen(tap) });
    const g = collect(c.ws);
    eq(c.deflate, { serverNoContextTakeover: true, clientNoContextTakeover: true, serverMaxWindowBits: 10, clientMaxWindowBits: 9 }, "params");
    const rep = "repeat me please, I am a message that compresses well ".repeat(4);
    for (let i = 0; i < 20; i++) c.ws.send(rep);
    const block = randomBytes(600).toString("base64").slice(0, 600);
    const far = block + "-".repeat(10) + block;
    c.ws.send(far);
    await until(() => g.msgs.length === 21 || !!g.close, 10000, "echoes");
    ok(!g.close, `closed: ${JSON.stringify(g.close)}`);
    ok(g.msgs.slice(0, 20).every((m) => m === rep) && g.msgs[20] === far, "intact");
    c.ws.close(1000);
    await until(() => !!g.close, 5000, "close");
  });

  await test("permessage-deflate off when the server does not compress: no extension is negotiated against a server with compression disabled, and messages go uncompressed (wire bytes ≥ payload)", { "WP-13": "partial" }, async () => {
    const py = await startPy(41834, "plain");
    try {
      const tap = { r: 0, w: 0 };
      const c = await WC.connectWebSocket({ url: "ws://127.0.0.1:41834/echo", open: tapOpen(tap) });
      const g = collect(c.ws);
      ok(!c.deflate && c.extensions === "", "no extension");
      const w0 = tap.w; c.ws.send("y".repeat(10000));
      await until(() => g.msgs.length === 1, 5000, "echo");
      ok(tap.w - w0 >= 10000, "uncompressed");
      c.ws.close(1000); await until(() => !!g.close, 5000, "close");
    } finally { py.kill(); }
  });
} finally { pyDef?.kill(); pySmall?.kill(); }

// ---- hostile raw servers
type Script = (sock: net.Socket) => void;
async function rawServer(port: number, ext: string | null, script: Script): Promise<net.Server> {
  const srv = net.createServer((sock) => {
    let head = Buffer.alloc(0);
    sock.on("data", function onData(c: Buffer) {
      head = Buffer.concat([head, c]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      sock.off("data", onData);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head.toString("latin1"))![1];
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${WC.acceptFor(key)}\r\n${ext ? `Sec-WebSocket-Extensions: ${ext}\r\n` : ""}\r\n`);
      sock.on("data", () => { /* client frames */ });
      sock.on("error", () => {});
      script(sock);
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  return srv;
}
const deflateMsg = (b: Buffer) => { const z = zlib.deflateRawSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); return z.subarray(0, z.length - 4); };
const frame = (op: number, payload: Buffer, o: { fin?: boolean; rsv1?: boolean; rsv2?: boolean } = {}) => {
  const f = WC.encodeFrame(op, payload, { mask: false, fin: o.fin, rsv1: o.rsv1 });
  if (o.rsv2) f[0] |= 0x20;
  return f;
};
async function against(port: number, ext: string | null, script: Script, opts: { maxMessage?: number } = {}): Promise<Got & { protocolError?: [number, string] }> {
  const srv = await rawServer(port, ext, script);
  try {
    const c = await WC.connectWebSocket({ url: `ws://127.0.0.1:${port}/`, open: (h, p) => new Promise((res, rej) => { const s = net.connect(p, h, () => res(s)); s.once("error", rej); }), ...opts });
    const g = collect(c.ws) as Got & { protocolError?: [number, string] };
    c.ws.on("protocolError", (code: number, why: string) => { g.protocolError = [code, why]; });
    await until(() => !!g.close, 15000, "close");
    return g;
  } finally { srv.close(); }
}

await test("permessage-deflate hostile servers: a decompression bomb (64 MiB of zeros compressed to ~64 KiB) stops at the 1 MiB cap → close 1009 without inflating it all; corrupt compressed data → 1007; RSV1 on a ping, on a continuation frame, or without negotiation → 1002; RSV2 → 1002", { "WP-13": "full" }, async () => {
  const bomb = deflateMsg(Buffer.alloc(64 * 1024 * 1024));
  console.log(`    bomb: ${bomb.length} compressed bytes for 64 MiB`);
  const rss0 = process.memoryUsage().rss, t0 = Date.now();
  let g = await against(41835, "permessage-deflate", (s) => s.write(frame(2, bomb, { rsv1: true })), { maxMessage: 1 << 20 });
  const grew = Math.round((process.memoryUsage().rss - rss0) / 1048576);
  console.log(`    bomb → ${JSON.stringify(g.protocolError)} in ${Date.now() - t0} ms, RSS +${grew} MiB`);
  eq(g.protocolError?.[0], 1009, "bomb"); ok(g.msgs.length === 0, "nothing delivered"); ok(grew < 48, `memory grew ${grew} MiB`);
  g = await against(41836, "permessage-deflate", (s) => s.write(frame(1, Buffer.from([0xff, 0xff, 0xff, 0x00, 0x13, 0x37]), { rsv1: true })));
  eq(g.protocolError?.[0], 1007, `corrupt ${JSON.stringify(g.protocolError)}`);
  g = await against(41837, "permessage-deflate", (s) => s.write(frame(9, Buffer.from("x"), { rsv1: true })));
  ok(g.protocolError?.[0] === 1002 && /control/.test(g.protocolError[1]), `ping ${JSON.stringify(g.protocolError)}`);
  g = await against(41838, "permessage-deflate", (s) => s.write(Buffer.concat([frame(1, deflateMsg(Buffer.from("ab")), { fin: false, rsv1: true }), frame(0, Buffer.from("cd"), { rsv1: true })])));
  ok(g.protocolError?.[0] === 1002 && /continuation/.test(g.protocolError[1]), `cont ${JSON.stringify(g.protocolError)}`);
  g = await against(41839, null, (s) => s.write(frame(1, deflateMsg(Buffer.from("hi")), { rsv1: true })));
  ok(g.protocolError?.[0] === 1002 && /without a negotiated/.test(g.protocolError[1]), `unnegotiated ${JSON.stringify(g.protocolError)}`);
  g = await against(41840, "permessage-deflate", (s) => s.write(frame(1, Buffer.from("hi"), { rsv2: true })));
  ok(g.protocolError?.[0] === 1002 && /RSV2/.test(g.protocolError[1]), `rsv2 ${JSON.stringify(g.protocolError)}`);
});

await test("permessage-deflate ordering and fragments: one write carrying [1 MiB compressed text][a small uncompressed text][a compressed message in 3 fragments][close 1000] is delivered strictly in that order (nothing overtakes an inflate, not even the close); a context-takeover back-reference into the previous message decodes; a server window of 8 bits (client_max_window_bits=8) gets COMPRESSED messages whose every distance fits a 256-byte window (TT41; was: uncompressed)", { "WP-13": "full" }, async () => {
  const big = Buffer.from("ordering ".repeat(120000).slice(0, 1 << 20));
  const frag = deflateMsg(Buffer.from("fragmented and compressed ✓"));
  const third = Math.ceil(frag.length / 3);
  const closeP = Buffer.from([0x03, 0xe8]);
  let g = await against(41841, "permessage-deflate", (s) => s.write(Buffer.concat([
    frame(1, deflateMsg(big), { rsv1: true }), frame(1, Buffer.from("small")),
    frame(1, frag.subarray(0, third), { fin: false, rsv1: true }), frame(0, frag.subarray(third, 2 * third), { fin: false }), frame(0, frag.subarray(2 * third)),
    frame(8, closeP)])));
  eq(g.msgs.map((m) => (typeof m === "string" ? (m.length > 50 ? `text:${m.length}` : m) : "bin")), [`text:${1 << 20}`, "small", "fragmented and compressed ✓"], "order");
  ok(g.msgs[0] === big.toString(), "big intact"); eq(g.close?.[0], 1000, "close last");
  // context takeover: the second message is compressed by the same deflate stream, so it back-references the first
  const d = zlib.createDeflateRaw();
  const part = (b: Buffer) => new Promise<Buffer>((res) => { const out: Buffer[] = []; const on = (c: Buffer) => out.push(c); d.on("data", on); d.write(b); d.flush(zlib.constants.Z_SYNC_FLUSH, () => { d.off("data", on); const z = Buffer.concat(out); res(z.subarray(0, z.length - 4)); }); });
  const m1 = await part(Buffer.from("context takeover: a sentence that will be repeated")), m2 = await part(Buffer.from("context takeover: a sentence that will be repeated"));
  ok(m2.length < 12, `second message should be a back-reference (${m2.length} bytes)`);
  g = await against(41842, "permessage-deflate", (s) => s.write(Buffer.concat([frame(1, m1, { rsv1: true }), frame(1, m2, { rsv1: true }), frame(8, closeP)])));
  eq(g.msgs, ["context takeover: a sentence that will be repeated", "context takeover: a sentence that will be repeated"], "takeover");
  // TT41: client window 8 → compressed (RSV1 set), and an auditing decoder limited to a 256-byte window inflates it
  let seen: Buffer = Buffer.alloc(0);
  const srv = await rawServer(41843, "permessage-deflate; client_max_window_bits=8", (s) => { s.on("data", (c: Buffer) => { seen = Buffer.concat([seen, c]); }); });
  try {
    const c = await WC.connectWebSocket({ url: "ws://127.0.0.1:41843/", open: (h, p) => new Promise((res, rej) => { const s = net.connect(p, h, () => res(s)); s.once("error", rej); }) });
    eq(c.deflate?.clientMaxWindowBits, 8);
    const text = Array.from({ length: 60 }, (_, i) => `row ${i % 7} ${"abcdefghij".repeat(30).slice(i % 10, 280 + (i % 10))}`).join("|");
    c.ws.send(text);
    await until(() => seen.length >= 2 && seen.length >= 2 + ((seen[1] & 0x7f) === 126 ? 2 : 0) + 4 + ((seen[1] & 0x7f) === 126 ? seen.readUInt16BE(2) : seen[1] & 0x7f), 5000, "frame at server");
    ok((seen[0] & 0x40) !== 0 && (seen[0] & 0x0f) === 1, `RSV1 must be SET (byte0 ${seen[0].toString(16)})`);
    const ext = (seen[1] & 0x7f) === 126, len = ext ? seen.readUInt16BE(2) : seen[1] & 0x7f, at = ext ? 4 : 2;
    const key = seen.subarray(at, at + 4), pay = Buffer.from(seen.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ key[i % 4]);
    const { DeflateAuditor } = await import("./oracle/deflate-audit.mts");
    const aud = new DeflateAuditor(256);
    eq(aud.message(pay).toString(), text, "inflated by a 256-byte-window decoder");
    ok(len < text.length / 3, `compressed ${text.length} → ${len} B`);
    // second, EXTERNAL oracle — zlib itself (Python's binding), raw inflate with windowBits 8, forced to emit one byte
    // per call so every back-reference must come from its real 256-byte window (a large output buffer lets zlib's
    // fast path read further back, hiding a too-far distance). Negative control: a stream that reaches 600 bytes back
    // MUST be refused, proving the check is live.
    const blk = randomBytes(300).toString("hex"); // 600 random-looking chars
    const control = zlib.deflateRawSync(Buffer.from(`${blk}----${blk}`), { windowBits: 15 });
    const py = `import sys, zlib
def strict(data):
    d = zlib.decompressobj(-8); out = b""; buf = data
    try:
        while buf:
            out += d.decompress(buf, 1); buf = d.unconsumed_tail
        while True:
            more = d.decompress(b"", 1)
            if not more: break
            out += more
    except zlib.error as e:
        return "ERR " + str(e)
    return "OK " + out.decode("latin-1")
a, b = sys.stdin.read().split()
print(strict(bytes.fromhex(a) + b"\\x00\\x00\\xff\\xff")[:3] + str(len(strict(bytes.fromhex(a) + b"\\x00\\x00\\xff\\xff"))))
print(strict(bytes.fromhex(a) + b"\\x00\\x00\\xff\\xff")[3:] == ${JSON.stringify(text)})
print(strict(bytes.fromhex(b))[:90])
`;
    const pyOut = execFileSync(PY, ["-c", py], { input: `${pay.toString("hex")} ${control.toString("hex")}` }).toString().trim().split("\n");
    ok(pyOut[0].startsWith("OK ") && pyOut[1] === "True", `zlib strict 8-bit inflate of our message: ${pyOut.slice(0, 2).join(" | ")}`);
    ok(pyOut[2].startsWith("ERR ") && /too far back/.test(pyOut[2]), `negative control must be refused: ${pyOut[2]}`);
    console.log(`     8-bit window: ${text.length} B → ${len} B, max distance ${aud.stats.maxDistance}; zlib (windowBits 8, 1 byte/call) inflates it; control (distance 604): "${pyOut[2].slice(4)}"`);
    c.ws.terminate();
  } finally { srv.close(); }
});

await finish();
process.exit(0);
