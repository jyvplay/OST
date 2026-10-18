/**
 * Suite "tt37-unit" (TT37), no browser: the Private proxy's UPSTREAM ROUTE (src/lib/server/wp-tunnel.ts,
 * wp-route.ts, the tunnel branch of wp-fetch.ts and pinned-http.ts).
 * Independent checks, not self-review:
 *   - curl (an independent RFC 1928 / 1929 / 9110 client) talks to a recording server; our handshake bytes must
 *     equal curl's for the same target and credentials
 *   - pproxy 2.7.9 (MIT, an independent SOCKS5 / HTTP CONNECT server, test-only) carries real requests to
 *     reachable sites (pypi.org, github.com); its log shows the NAME arrived (no DNS at Fusion's side)
 *   - Python's ipaddress module packs the IPv6 addresses our SOCKS encoder is compared with
 *   - hostile proxies (refusals, garbage, silence, floods, early close, 407 / 403, oversize headers, bytes glued
 *     to the reply) must fail fast and clearly — never hang, never crash, never mislabel the site
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt37-unit.mts
 */
import * as net from "node:net";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile); // async: the recording servers live in this process, so curl must not block its event loop
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { parseRoute, describeRoute, socksConnectRequest, isolationCredentials, openTunnel, tunnelHostVerdict, type UpstreamRoute } from "../src/lib/server/wp-tunnel.ts";
import { upstreamRequest, readAll } from "../src/lib/server/wp-fetch.ts";
import { setRoute } from "../src/lib/server/wp-route.ts";
import { getPinnedPublic } from "../src/lib/server/pinned-http.ts";
import { classifyError } from "../src/lib/wp-core.ts";
import * as GP from "../src/lib/gamepad-pointer.ts";

const { test, finish } = makeHarness("tt37-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
const hex = (b: Buffer) => b.toString("hex");
const route = (spec: string, isolate = true) => parseRoute(spec, isolate);

/* ---------------------------------------------------------------- a scriptable SOCKS5 / CONNECT test server */
class Conn {
  buf = Buffer.alloc(0); waiters: (() => void)[] = []; closed = false; s: net.Socket;
  constructor(s: net.Socket) { this.s = s; s.on("data", (b) => { this.buf = Buffer.concat([this.buf, b]); this.waiters.splice(0).forEach((w) => w()); }); s.on("close", () => { this.closed = true; this.waiters.splice(0).forEach((w) => w()); }); s.on("error", () => {}); }
  async take(n: number): Promise<Buffer> { while (this.buf.length < n) { if (this.closed) throw new Error("closed"); await new Promise<void>((r) => this.waiters.push(r)); } const o = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return o; }
  async head(): Promise<string> { for (;;) { const i = this.buf.indexOf("\r\n\r\n"); if (i >= 0) { const h = this.buf.subarray(0, i + 4).toString("latin1"); this.buf = this.buf.subarray(i + 4); return h; } if (this.closed) throw new Error("closed"); await new Promise<void>((r) => this.waiters.push(r)); } }
}
async function server(handler: (c: Conn) => Promise<void>): Promise<{ port: number; close: () => void }> {
  const srv = net.createServer((s) => { handler(new Conn(s)).catch(() => s.destroy()); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as net.AddressInfo).port, close: () => srv.close() };
}
/** A well-behaved SOCKS5 server that records each handshake part, then answers the tunnelled HTTP request itself. */
function recordingSocks(rec: { greeting?: string; auth?: string; connect?: string; user?: string; pass?: string; host?: string }[], opt: { glue?: boolean } = {}) {
  return server(async (c) => {
    const r: (typeof rec)[number] = {}; rec.push(r);
    const g = await c.take(2); const m = await c.take(g[1]); r.greeting = hex(Buffer.concat([g, m]));
    if ([...m].includes(2)) {
      c.s.write(Buffer.from([5, 2]));
      const h = await c.take(2); const u = await c.take(h[1]); const pl = await c.take(1); const p = await c.take(pl[0]);
      r.auth = hex(Buffer.concat([h, u, pl, p])); r.user = u.toString(); r.pass = p.toString();
      c.s.write(Buffer.from([1, 0]));
    } else c.s.write(Buffer.from([5, 0]));
    const q = await c.take(4); let rest: Buffer;
    if (q[3] === 3) { const l = await c.take(1); rest = Buffer.concat([l, await c.take(l[0] + 2)]); r.host = rest.subarray(1, 1 + l[0]).toString(); }
    else rest = await c.take(q[3] === 1 ? 6 : 18);
    r.connect = hex(Buffer.concat([q, rest]));
    const reply = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const http = Buffer.from("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello");
    if (opt.glue) { c.s.write(Buffer.concat([reply, http])); c.s.end(); return; } // the destination's first bytes in the same packet as the reply
    c.s.write(reply);
    await c.head().catch(() => "");
    c.s.end(http);
  });
}

/* ================================================================ parsing */
await test("route parsing (WP-07): direct / socks5 / socks5h / http with optional credentials; unsupported schemes, bad ports, paths and oversized credentials are refused; the description never contains the password", { "WP-07": "full" }, () => {
  eq(route("").mode, "direct"); eq(route("direct").mode, "direct");
  const s = route("socks5://alice:p%40ss@127.0.0.1:9050");
  eq([s.mode, s.host, s.port, s.username, s.password], ["socks5", "127.0.0.1", 9050, "alice", "p@ss"]);
  eq(route("socks5h://tor.lan:9150").mode, "socks5"); eq(route("http://[::1]:3128").host, "::1"); eq(route("socks5://h").port, 1080); eq(route("http://h").port, 8080);
  for (const bad of ["ftp://h:1", "socks4://h:1", "http://h:0", "http://h:70000", "socks5://h:1/path", "not a url", `socks5://${"u".repeat(256)}:p@h:1`]) {
    let threw = false; try { route(bad); } catch { threw = true; } ok(threw, `accepted ${bad}`);
  }
  const d = describeRoute(s);
  ok(!JSON.stringify(d).includes("p@ss") && d.auth && d.label === "SOCKS5 127.0.0.1:9050", JSON.stringify(d));
  eq(describeRoute(route("http://[::1]:3128")).label, "HTTP proxy [::1]:3128");
});

await test("SOCKS5 request encoding (WP-07): names go as ATYP 3 (the proxy resolves them), IPv4 as ATYP 1, IPv6 as ATYP 4 — IPv6 bytes identical to Python's ipaddress packing for 8 shapes (compressed, embedded IPv4, zones of zeros)", { "WP-07": "full" }, () => {
  eq(hex(socksConnectRequest("pypi.org", 443)), "050100030870797069" + "2e6f726701bb");
  eq(hex(socksConnectRequest("93.184.216.34", 80)), "05010001" + "5db8d822" + "0050");
  const v6 = ["2001:db8::1", "::1", "::", "fe80::1:2:3:4", "2001:db8:0:0:1:0:0:1", "::ffff:192.0.2.128", "1:2:3:4:5:6:7:8", "2606:4700:4700::1111"];
  const ref = JSON.parse(execFileSync(PY, ["-c", "import sys,json,ipaddress; print(json.dumps([ipaddress.IPv6Address(a).packed.hex() for a in json.load(sys.stdin)]))"], { input: JSON.stringify(v6) }).toString()) as string[];
  v6.forEach((a, i) => eq(hex(socksConnectRequest(a, 443)), `05010004${ref[i]}01bb`, a));
});

/* ================================================================ differential vs curl */
await test("handshake bytes identical to curl's (WP-07): for the same target and credentials, our SOCKS5 greeting, RFC 1929 login and CONNECT — and our HTTP CONNECT request line, Host and Proxy-Authorization — equal what curl sends to the same recording server", { "WP-07": "full" }, async () => {
  for (const withAuth of [true, false]) {
    const recC: Parameters<typeof recordingSocks>[0] = [], recO: typeof recC = [];
    const a = await recordingSocks(recC), b = await recordingSocks(recO);
    const userinfo = withAuth ? "alice:s3cret@" : "";
    await run("curl", ["-s", "-m", "10", "-o", "/dev/null", "--socks5-hostname", `${userinfo}127.0.0.1:${a.port}`, "http://pypi.org/help/"]);
    const r = route(`socks5://${userinfo}127.0.0.1:${b.port}`, false);
    const s = await openTunnel(r, "pypi.org", 80, { secure: false, cred: isolationCredentials(r, "x", 0), timeoutMs: 5000 });
    s.end("GET / HTTP/1.1\r\nHost: pypi.org\r\n\r\n"); s.resume(); await new Promise((res) => s.on("close", res));
    a.close(); b.close();
    // curl may also offer GSSAPI (method 1) when built with it; compare the method SETS plus everything after
    const methods = (g: string) => [...Buffer.from(g, "hex").subarray(2)].filter((x) => x !== 1).sort().join(",");
    eq(methods(recO[0].greeting!), methods(recC[0].greeting!), `greeting methods (auth=${withAuth})`);
    eq([recO[0].auth, recO[0].connect], [recC[0].auth, recC[0].connect], `login + CONNECT bytes (auth=${withAuth})`);
    console.log(`     SOCKS5 auth=${withAuth}: curl greeting ${recC[0].greeting}, ours ${recO[0].greeting}; CONNECT ${recO[0].connect}`);
  }
  // HTTP CONNECT
  const heads: string[] = [];
  const h = await server(async (c) => { heads.push(await c.head()); c.s.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"); });
  await run("curl", ["-s", "-m", "10", "-o", "/dev/null", "-x", `http://bob:pw%3A1@127.0.0.1:${h.port}`, "https://github.com/"]).catch(() => undefined); // curl exits non-zero on 403
  await openTunnel(route(`http://127.0.0.1:${h.port}`), "github.com", 443, { secure: true, servername: "github.com", cred: { username: "bob", password: "pw:1" }, timeoutMs: 5000 }).catch((e) => ok(/403/.test(e.message), e.message));
  h.close();
  const pick = (head: string) => { const lines = head.split("\r\n"); return [lines[0], lines.find((l) => /^host:/i.test(l))?.toLowerCase(), lines.find((l) => /^proxy-authorization:/i.test(l))]; };
  eq(pick(heads[1]), pick(heads[0]), "HTTP CONNECT");
  console.log(`     HTTP CONNECT: ${JSON.stringify(pick(heads[1]))}`);
});

/* ================================================================ live via pproxy */
let pp: ChildProcess | null = null;
await test("live through an independent proxy server (WP-07): pproxy carries the proxy's real requests to pypi.org over SOCKS5 and to github.com over HTTP CONNECT (TLS verified end to end); pproxy logs the NAME it was given — Fusion's server did no DNS lookup of its own; the legacy fetcher (reader / embed probe) follows the route too", { "WP-07": "full" }, async () => {
  pp = spawn(PPROXY, ["-l", "socks5://127.0.0.1:18150", "-l", "http://127.0.0.1:18180", "-v"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; pp.stdout!.on("data", (b) => (log += b)); pp.stderr!.on("data", (b) => (log += b));
  await new Promise((r) => setTimeout(r, 1500));
  const via = async (spec: string, url: string) => {
    const up = await upstreamRequest(url, { method: "GET", maxBytes: 1 << 24, route: route(spec), session: { sid: "s1", circuit: 0 }, headers: { "user-agent": "Mozilla/5.0", "accept-encoding": "gzip" } });
    return { status: up.status, via: up.pinned, text: (await readAll(up.body)).toString() };
  };
  const a = await via("socks5://127.0.0.1:18150", "https://pypi.org/help/");
  ok(a.status === 200 && /<title>Help/.test(a.text) && a.via === "via SOCKS5 127.0.0.1:18150", `${a.status} ${a.via}`);
  const b = await via("http://127.0.0.1:18180", "https://github.com/nodejs/node");
  ok(b.status === 200 && /nodejs\/node/.test(b.text) && b.via === "via HTTP proxy 127.0.0.1:18180", `${b.status} ${b.via}`);
  setRoute(route("socks5://127.0.0.1:18150"));
  try {
    const legacy = await getPinnedPublic("https://pypi.org/security/", { maxBytes: 2 << 20 });
    ok(legacy.status === 200 && legacy.pinnedAddress === "via SOCKS5 127.0.0.1:18150", `${legacy.status} ${legacy.pinnedAddress}`);
  } finally { setRoute(route("direct")); }
  await new Promise((r) => setTimeout(r, 300));
  const lines = log.split("\n").filter((l) => /->/.test(l));
  console.log(`     pproxy saw: ${[...new Set(lines.map((l) => l.replace(/^.*-> /, "").trim()))].join(", ")}`);
  ok(lines.some((l) => /socks5 .*-> pypi\.org:443/.test(l)) && lines.some((l) => /http .*-> github\.com:443/.test(l)), "pproxy log shows the names");
  // the outside sites the user asked for: the route reaches pproxy, pproxy's own egress is cut by this sandbox
  const y = await via("socks5://127.0.0.1:18150", "https://www.yahoo.com/").catch((e) => e as Error);
  ok(y instanceof Error, "yahoo cannot be reached from this sandbox even through the route");
  console.log(`     https://www.yahoo.com/ via pproxy: ${classifyError(y).kind} — ${(y as Error).message.slice(0, 80)} (pproxy log: ${log.includes("www.yahoo.com:443") ? "name received" : "no entry"})`);
});

/* ================================================================ no local DNS, isolation */
await test("no local DNS and per-session circuits (WP-07): a .onion address (which no local resolver can answer) reaches the SOCKS proxy as a name; each Private proxy session sends its own SOCKS login (Tor IsolateSOCKSAuth → separate circuits), the same session keeps it, 'New circuit' changes it, isolation off sends none, fixed route credentials win", { "WP-07": "full" }, async () => {
  const rec: Parameters<typeof recordingSocks>[0] = [];
  const srv = await recordingSocks(rec);
  const r = route(`socks5://127.0.0.1:${srv.port}`);
  const get = async (url: string, sid: string, circuit = 0, rr: UpstreamRoute = r) => { const up = await upstreamRequest(url, { method: "GET", maxBytes: 1e6, route: rr, session: { sid, circuit }, headers: {} }); return (await readAll(up.body)).toString(); };
  eq(await get("http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/", "A"), "hello");
  eq(rec[0].host, "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion", "onion name sent to the proxy");
  await get("http://pypi.org/", "A"); await get("http://pypi.org/", "B"); await get("http://pypi.org/", "A", 1);
  await get("http://pypi.org/", "A", 0, route(`socks5://127.0.0.1:${srv.port}`, false));
  await get("http://pypi.org/", "A", 0, route(`socks5://fixed:pw@127.0.0.1:${srv.port}`));
  srv.close();
  const users = rec.map((x) => x.user ?? null);
  ok(users[0] === users[1] && users[0] !== users[2] && users[0] !== users[3] && users[2] !== users[3], `isolation users ${users}`);
  ok(/^fusion-[0-9a-f]{16}$/.test(users[0]!) && rec[0].pass!.length === 32, "derived credentials shape");
  eq([users[4], rec[4].greeting], [null, "050100"], "isolation off → no login offered");
  eq([users[5], rec[5].pass], ["fixed", "pw"], "configured credentials win");
  // direct mode: .onion is refused with the reason, before any DNS
  const e = await upstreamRequest("http://abc.onion/", { method: "GET", maxBytes: 10, route: route("direct"), headers: {} }).catch((x) => x as Error);
  eq(classifyError(e).kind, "proxy"); ok(/Tor route/.test(classifyError(e).message), "onion message");
});

/* ================================================================ SSRF in tunnel mode */
await test("SSRF guard with a route (WP-07): without local DNS the guard still refuses private / loopback / link-local IP literals, local and single-label names, internal suffixes, non-web ports and .onion over an HTTP proxy — before anything is sent to the proxy", { "WP-07": "full" }, async () => {
  let contacted = 0;
  const srv = await server(async (c) => { contacted++; c.s.destroy(); });
  const socks = route(`socks5://127.0.0.1:${srv.port}`), httpR = route(`http://127.0.0.1:${srv.port}`);
  const cases: [string, UpstreamRoute][] = [["http://10.0.0.1/", socks], ["http://127.0.0.1/", socks], ["http://[::1]/", socks], ["http://169.254.169.254/latest/", socks], ["http://[fd00::1]/", socks], ["http://intranet/", socks], ["http://printer.local/", socks], ["http://db.internal/", socks], ["http://nas.home.arpa/", socks], ["http://localhost/", socks], ["http://pypi.org:8080/", socks], ["http://abc.onion/", httpR]];
  for (const [u, rr] of cases) {
    const e = await upstreamRequest(u, { method: "GET", maxBytes: 10, route: rr, headers: {} }).then(() => null, (x) => x as Error);
    ok(e && ["private", "scheme", "proxy"].includes(classifyError(e).kind), `${u} → ${e ? classifyError(e).kind + " " + e.message : "ALLOWED"}`);
  }
  srv.close();
  eq(contacted, 0, "the proxy was never contacted for a refused address");
  eq([tunnelHostVerdict(socks, "pypi.org"), tunnelHostVerdict(socks, "x.onion"), !!tunnelHostVerdict(httpR, "x.onion")], [null, null, true]);
});

/* ================================================================ hostile proxies */
await test("hostile and broken proxies (WP-07): no acceptable method, every RFC 1928 reply code and Tor's onion codes, a non-SOCKS server, silence (deadline), a 100 KB flood, a close mid-reply, HTTP 407 / 403, an oversized CONNECT reply header — each fails fast with a 'network route' error that never blames the site; bytes glued to the reply reach the page intact", { "WP-07": "full" }, async () => {
  const cases: { name: string; h: (c: Conn) => Promise<void>; mode?: "http"; expect: RegExp }[] = [
    { name: "no acceptable method", h: async (c) => { await c.take(3); c.s.write(Buffer.from([5, 0xff])); }, expect: /none of our authentication methods/ },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((rep) => ({ name: `reply ${rep}`, h: async (c: Conn) => { await c.take(3); c.s.write(Buffer.from([5, 0])); await c.take(4); c.s.write(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0])); }, expect: [/general SOCKS server failure/, /not allowed/, /network unreachable/, /host unreachable/, /connection refused by the destination/, /TTL expired/, /command not supported/, /address type not supported/][rep - 1] })),
    { name: "Tor onion F2", h: async (c) => { await c.take(3); c.s.write(Buffer.from([5, 0])); await c.take(4); c.s.write(Buffer.from([5, 0xf2, 0, 1, 0, 0, 0, 0, 0, 0])); }, expect: /onion service introduction failed/ },
    { name: "not SOCKS", h: async (c) => { await c.take(1); c.s.write("HTTP/1.1 400 Bad Request\r\n\r\n"); }, expect: /not a SOCKS5 server/ },
    { name: "silence", h: async () => { await new Promise((r) => setTimeout(r, 4000)); }, expect: /timed out|did not answer/ },
    { name: "flood", h: async (c) => { await c.take(3); c.s.write(Buffer.alloc(100_000, 5)); }, expect: /too much data|unsupported method|malformed/ },
    { name: "close mid-reply", h: async (c) => { await c.take(3); c.s.write(Buffer.from([5, 0])); await c.take(4); c.s.end(Buffer.from([5, 0, 0])); }, expect: /closed the connection/ },
    { name: "HTTP 407", mode: "http", h: async (c) => { await c.head(); c.s.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); }, expect: /needs credentials/ },
    { name: "HTTP 403", mode: "http", h: async (c) => { await c.head(); c.s.end("HTTP/1.1 403 Forbidden\r\n\r\n"); }, expect: /refused the tunnel \(403\)/ },
    { name: "HTTP huge header", mode: "http", h: async (c) => { await c.head(); c.s.write("HTTP/1.1 200 OK\r\nX: " + "a".repeat(40_000)); }, expect: /too large/ },
  ];
  for (const k of cases) {
    const srv = await server(k.h);
    const t0 = Date.now();
    const e = await upstreamRequest("http://pypi.org/", { method: "GET", maxBytes: 100, timeoutMs: 1500, route: route(`${k.mode ?? "socks5"}://127.0.0.1:${srv.port}`, false), headers: {} }).then(() => null, (x) => x as Error);
    srv.close();
    const ms = Date.now() - t0, c = e ? classifyError(e) : null;
    ok(e && k.expect.test(e.message), `${k.name}: ${e?.message ?? "no error"}`);
    ok(c!.kind === "proxy" || (k.name === "silence" && c!.kind === "timeout"), `${k.name}: classified ${c!.kind}`);
    ok(ms < 2500, `${k.name}: took ${ms} ms`);
  }
  // attacks on the TT37 repair (handshake errors → route errors): an RST mid-handshake is the route's failure; a
  // tunnel that works but whose destination answers garbage instead of TLS is NOT (classified tls, not proxy)
  const rst = await server(async (c) => { await c.take(3); (c.s as net.Socket & { resetAndDestroy(): void }).resetAndDestroy(); });
  const eR = await upstreamRequest("http://pypi.org/", { method: "GET", maxBytes: 100, timeoutMs: 1500, route: route(`socks5://127.0.0.1:${rst.port}`, false), headers: {} }).then(() => null, (x) => x as Error);
  rst.close();
  eq(classifyError(eR).kind, "proxy", `RST mid-handshake (${eR?.message})`);
  const notTls = await server(async (c) => { await c.take(3); c.s.write(Buffer.from([5, 0])); await c.take(4); const l = await c.take(1); await c.take(l[0] + 2); c.s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); await c.take(5); c.s.end("HELLO this is not TLS\r\n".repeat(20)); });
  const eT = await upstreamRequest("https://pypi.org/", { method: "GET", maxBytes: 100, timeoutMs: 1500, route: route(`socks5://127.0.0.1:${notTls.port}`, false), headers: {} }).then(() => null, (x) => x as Error);
  notTls.close();
  ok(eT && classifyError(eT).kind !== "proxy", `destination garbage must not blame the route: ${eT ? classifyError(eT).kind + " " + eT.message : "no error"}`);
  console.log(`     RST mid-handshake → proxy; destination not speaking TLS → ${classifyError(eT).kind} (${eT!.message.slice(0, 70)})`);
  // nothing listening at all
  const dead = await upstreamRequest("http://pypi.org/", { method: "GET", maxBytes: 100, route: route("socks5://127.0.0.1:1"), headers: {} }).then(() => null, (x) => x as Error);
  eq(classifyError(dead).kind, "proxy", "dead proxy");
  // bytes that arrive in the same packet as the SOCKS reply belong to the page
  const rec: Parameters<typeof recordingSocks>[0] = [];
  const glue = await recordingSocks(rec, { glue: true });
  const up = await upstreamRequest("http://pypi.org/", { method: "GET", maxBytes: 100, route: route(`socks5://127.0.0.1:${glue.port}`, false), headers: {} });
  eq([up.status, (await readAll(up.body)).toString()], [200, "hello"], "glued bytes");
  glue.close();
});

/* ================================================================ IN-07 gamepad pointer (pure mapping) */
const pad = (axes: number[] = [0, 0, 0, 0], down: number[] = [], mapping = "standard"): GP.PadSnapshot => ({ axes, mapping, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })) });
const runFrames = (frames: { p: GP.PadSnapshot; dt: number }[], s0 = GP.initialState(1000, 800)) => {
  let s = s0, t = 0; const acts: GP.PadAction[] = [];
  for (const f of frames) { t += f.dt; const r = GP.step(s, f.p, f.dt, t, 1000, 800); s = r.state; acts.push(...r.actions); }
  return { s, acts };
};
await test("gamepad stick shaping and motion (IN-07): radial deadzone 0.15, power curve that keeps the stick's angle, full deflection = 1400 px/s, the same distance at 30 / 60 / 144 Hz, a stalled frame cannot teleport the cursor (dt ≤ 100 ms), the cursor stays inside the viewport, NaN axes are inert", { "IN-07": "partial" }, () => {
  eq(GP.shapeStick(0.1, 0.1), [0, 0]); eq(GP.shapeStick(0.14, 0), [0, 0]);
  eq(GP.shapeStick(1, 0), [1, 0]); eq(GP.shapeStick(2, 0), [1, 0]); eq(GP.shapeStick(Number.NaN, 0.05), [0, 0]);
  const [a, b] = GP.shapeStick(0.6, 0.6); ok(Math.abs(a - b) < 1e-12 && a > 0, "45° stays 45°");
  let prev = 0; for (let m = 0.16; m <= 1; m += 0.01) { const v = GP.shapeStick(m, 0)[0]; ok(v > prev, `monotonic at ${m.toFixed(2)}`); prev = v; }
  ok(GP.shapeStick(0.3, 0)[0] < 0.05, "fine control: 30 % deflection → < 5 % speed");
  const dist = (hz: number) => runFrames(Array.from({ length: hz / 2 }, () => ({ p: pad([0.5, 0]), dt: 1000 / hz }))).s.x - 500;
  const d30 = dist(30), d60 = dist(60), d144 = dist(144);
  ok(Math.abs(d30 - d60) < 1e-6 && Math.abs(d60 - d144) < 1e-6, `${d30} / ${d60} / ${d144}`);
  ok(Math.abs(d60 - 0.5 * 1400 * Math.pow((0.5 - 0.15) / 0.85, 2.2)) < 1e-6, `half a second at half deflection = ${d60}`);
  eq(runFrames([{ p: pad([1, 0]), dt: 5000 }]).s.x, 500 + 140, "dt clamped to 100 ms");
  const far = runFrames(Array.from({ length: 50 }, () => ({ p: pad([-1, 1]), dt: 100 }))).s;
  eq([far.x, far.y], [0, 799], "clamped to the viewport");
});
await test("gamepad buttons (IN-07): A is edge-triggered (one down, one up, no repeat while held), B → Escape, X → context menu, LB / RB → focus back / forward, d-pad nudges 1 px and auto-repeats after 350 ms every 45 ms, Start toggles the mode — while off nothing moves or clicks, and turning it back on with A still held fires no stray 'up'; a non-standard pad gets stick, A and B only; slow scrolling is never lost (sub-pixel carry)", { "IN-07": "partial" }, () => {
  const types = (acts: GP.PadAction[]) => acts.filter((a) => a.type !== "move").map((a) => a.type + (a.type === "focus" ? a.dir : "") + (a.type === "toggle" ? String(a.enabled) : ""));
  eq(types(runFrames([{ p: pad([], [0]), dt: 16 }, { p: pad([], [0]), dt: 16 }, { p: pad([], [0]), dt: 16 }, { p: pad(), dt: 16 }]).acts), ["down", "up"]);
  eq(types(runFrames([{ p: pad([], [1, 2, 5]), dt: 16 }, { p: pad(), dt: 16 }, { p: pad([], [4]), dt: 16 }]).acts), ["escape", "context", "focus1", "focus-1"]);
  // d-pad: press at t=16, held: repeats at 16+350, then every 45 ms
  const held = runFrames([{ p: pad([], [15]), dt: 16 }, ...Array.from({ length: 50 }, () => ({ p: pad([], [15]), dt: 10 }))]);
  // held for 500 ms after the press: 1 (press) + 1 (at +350) + floor((500-350)/45) more
  eq(held.s.x - 500, 1 + 1 + Math.floor((500 - 350) / 45), "nudges");
  const r = runFrames([{ p: pad([], [9]), dt: 16 }, { p: pad(), dt: 16 }, { p: pad([1, 0], [0]), dt: 100 }, { p: pad([1, 0], [0, 9]), dt: 16 }, { p: pad([0, 0], [0]), dt: 16 }, { p: pad(), dt: 16 }]);
  eq(types(r.acts), ["togglefalse", "toggletrue"], "no click while off, no stray up after re-enabling with A held");
  // attack on the repair: turning the mode OFF while A is held must release the owed press (no stuck button)
  const off = runFrames([{ p: pad([], [0]), dt: 16 }, { p: pad([], [0, 9]), dt: 16 }, { p: pad([], [0]), dt: 16 }, { p: pad(), dt: 16 }]);
  eq(types(off.acts), ["down", "up", "togglefalse"], "press released when the mode turns off, and only once");
  eq(r.s.x, 500 + 1400 * 0.016, "no motion while off; moves again once on");
  const ns = runFrames([{ p: pad([0, 0, 0, 1], [0, 1, 2, 9, 12], ""), dt: 16 }, { p: pad([], [], ""), dt: 16 }]);
  eq(types(ns.acts), ["down", "escape", "up"], "non-standard pad");
  const slow = runFrames(Array.from({ length: 200 }, () => ({ p: pad([0, 0, 0, 0.2]), dt: 16 })));
  const total = slow.acts.filter((a) => a.type === "scroll").reduce((n, a) => n + (a as { dy: number }).dy, 0);
  const exact = 200 * 0.016 * 1600 * Math.pow((0.2 - 0.15) / 0.85, 2.2);
  ok(total === Math.trunc(exact) || total === Math.trunc(exact) - 1, `slow scroll ${total} vs continuous ${exact.toFixed(3)}`);
  ok(total > 0, "slow scrolling moves at all");
});

pp?.kill();
await finish();
setTimeout(() => process.exit(), 200).unref(); // test servers with half-open hostile connections must not keep the run alive
void readFileSync;
