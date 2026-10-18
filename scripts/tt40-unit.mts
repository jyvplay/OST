/**
 * TT40 unit + interop tests (no Next server needed):
 *  WP-14  proxy route types and failover — SOCKS4 / SOCKS4a request bytes differential against an independent client
 *         (npm `socks` 2.8.10, MIT; test-only, outside the repo), hostile SOCKS4 servers, an HTTPS proxy whose
 *         certificate is not trusted, PAC entry → route mapping (Chrome semantics: "SOCKS" = v4), the bad-proxy memory
 *         (5 min, deprioritised not removed), failover classification over REAL refused connections
 *  WP-15  automatic detection — Windows' DefaultConnectionSettings flags, macOS ProxyAutoDiscoveryEnable, GNOME
 *         auto + empty URL, KDE kioslaverc (all ProxyType values, both value formats, env indirection, KDE markers),
 *         desktop selection; WPAD candidate generation with the registrable-domain floor (squatting negatives),
 *         search-domain readers (resolv.conf, scutil --dns, Tcpip registry), discovery order / validation / budget
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt40-unit.mts
 */
import * as net from "node:net";
import * as tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { makeHarness } from "./harness.mts";

const TUN = await import("../src/lib/server/wp-tunnel.ts");
const CON = await import("../src/lib/server/wp-connect.ts");
const RT = await import("../src/lib/server/wp-route.ts");
const OS = await import("../src/lib/server/osproxy.ts");
const SP = await import("../src/lib/server/sysproxy.ts");
const WP = await import("../src/lib/server/wpad.ts");
const PAC = await import("../src/lib/server/pac.ts");

const { test, finish } = makeHarness("tt40-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const throws = (fn: () => unknown, re: RegExp, m: string) => { let e: unknown = null; try { fn(); } catch (x) { e = x; } ok(e && re.test((e as Error).message), `${m}: ${e ? (e as Error).message : "did not throw"}`); return e as Error; };
const ORACLE = process.env.FUSION_NPM_ORACLE ?? "/home/user/tools/oracle-npm";
const clearBad = () => { (globalThis as unknown as { __fusionBadProxies?: Map<string, number> }).__fusionBadProxies?.clear(); (globalThis as unknown as { __fusionFailovers?: unknown[] }).__fusionFailovers?.splice(0); };

/** A raw TCP server running `onConn`; resolves to its port. */
function rawServer(onConn: (s: net.Socket) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((r) => { const srv = net.createServer(onConn); srv.listen(0, "127.0.0.1", () => r({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() })); });
}

/* ============================================================ WP-14 route types */
await test("route parsing (WP-14): socks4:// socks4a:// https:// are routes now, with Chrome's default ports (1080 / 443) and labels; still refused: unknown schemes, bad ports, paths", { "WP-14": "full" }, () => {
  const r4 = TUN.parseRoute("socks4://alice@10.1.2.3:1081"), r4a = TUN.parseRoute("socks4a://h"), hs = TUN.parseRoute("https://proxy.example");
  eq([r4.mode, r4.host, r4.port, r4.username], ["socks4", "10.1.2.3", 1081, "alice"]);
  eq([r4a.mode, r4a.port], ["socks4a", 1080]); eq([hs.mode, hs.port], ["https", 443]);
  eq(TUN.parseRoute("https://p:8443").port, 8443);
  eq([TUN.describeRoute(r4).label, TUN.describeRoute(r4a).label, TUN.describeRoute(hs).label], ["SOCKS4 10.1.2.3:1081", "SOCKS4a h:1080", "HTTPS proxy proxy.example:443"]);
  for (const bad of ["socks6://h:1", "quic://h:443", "https://h:0", "socks4://h:1/x", "ftp://h"]) throws(() => TUN.parseRoute(bad), /./, `accepted ${bad}`);
  ok(TUN.isSocks4("socks4") && TUN.isSocks4("socks4a") && !TUN.isSocks4("socks5"), "isSocks4");
});

await test("SOCKS4 / SOCKS4a request bytes (WP-14): byte-identical to an independent client (npm `socks` 2.8.10) for IPv4 / name targets, with and without a user id, ports 1 and 65535; IPv6, a name over plain SOCKS4, a NUL in the user id and a 256-byte name are refused before any byte is sent", { "WP-14": "full" }, async () => {
  const req = createRequire(join(ORACLE, "package.json"));
  const { SocksClient } = req("socks") as { SocksClient: { createConnection(o: unknown): Promise<{ socket: net.Socket }> } };
  const captured: Buffer[] = [];
  const srv = await rawServer((s) => {
    let buf = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      // complete when: 8 header bytes + NUL-terminated user id (+ NUL-terminated name when 0.0.0.x with x≠0)
      if (buf.length < 9) return;
      const uidEnd = buf.indexOf(0, 8); if (uidEnd < 0) return;
      const is4a = buf[4] === 0 && buf[5] === 0 && buf[6] === 0 && buf[7] !== 0;
      if (is4a && buf.indexOf(0, uidEnd + 1) < 0) return;
      captured.push(buf); s.end(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
    });
    s.on("error", () => {});
  });
  const vectors: [string, number, string][] = [["93.184.216.34", 443, ""], ["10.0.0.1", 1, "alice"], ["pypi.org", 65535, ""], ["files.pythonhosted.org", 443, "bob-42"]];
  try {
    for (const [host, port, uid] of vectors) {
      captured.length = 0;
      const c = await SocksClient.createConnection({ proxy: { host: "127.0.0.1", port: srv.port, type: 4, ...(uid ? { userId: uid } : {}) }, destination: { host, port }, command: "connect", timeout: 3000 });
      c.socket.destroy();
      await sleep(30);
      const ours = TUN.socks4ConnectRequest(host, port, uid, true);
      eq(ours.toString("hex"), captured[0]?.toString("hex"), `${host}:${port} uid=${uid}`);
    }
  } finally { srv.close(); }
  throws(() => TUN.socks4ConnectRequest("2001:db8::1", 443, "", true), /IPv6/, "IPv6");
  throws(() => TUN.socks4ConnectRequest("pypi.org", 443, "", false), /needs an IPv4/, "name over SOCKS4");
  throws(() => TUN.socks4ConnectRequest("1.2.3.4", 443, "a\u0000b", true), /NUL/, "NUL in user id");
  throws(() => TUN.socks4ConnectRequest("a".repeat(256), 443, "", true), /unusable/, "long name");
  console.log(`     ${vectors.length} vectors identical to npm socks; 4 refusals`);
});

await test("SOCKS4 hostile servers (WP-14): a SOCKS5 answer, a refusal (91), a 3-byte reply then close, silence past the deadline — each a classified ProxyRouteError (proxy-down only where the proxy itself is broken); VN=4 echo is accepted and bytes that arrive WITH the grant are not lost", { "WP-14": "full" }, async () => {
  const shapes: [string, (s: net.Socket) => void, RegExp, boolean | null][] = [
    ["socks5 reply", (s) => s.once("data", () => s.end(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0]))), /not a SOCKS4 server/, true],
    ["refused 91", (s) => s.once("data", () => s.end(Buffer.from([0, 91, 0, 0, 0, 0, 0, 0]))), /rejected or failed/, false],
    ["short + close", (s) => s.once("data", () => s.end(Buffer.from([0, 90, 0]))), /closed the connection during setup|setup/, true],
    ["silent", () => {}, /timed out|did not answer/, true],
    ["vn4 + early data", (s) => s.once("data", () => s.write(Buffer.concat([Buffer.from([4, 90, 0, 0, 0, 0, 0, 0]), Buffer.from("HELLO")]))), /^$/, null],
  ];
  for (const [name, fn, re, down] of shapes) {
    const srv = await rawServer((s) => { s.on("error", () => {}); fn(s); });
    try {
      const route = TUN.parseRoute(`socks4://127.0.0.1:${srv.port}`);
      try {
        const sock = await TUN.openTunnel(route, "93.184.216.34", 80, { secure: false, servername: "x", cred: undefined, timeoutMs: 800 });
        ok(down === null, `${name}: connected unexpectedly`);
        const got = await new Promise<string>((r) => { sock.once("data", (d: Buffer) => r(d.toString())); sock.resume(); setTimeout(() => r("(nothing)"), 1000); });
        eq(got, "HELLO", `${name}: early bytes`); sock.destroy();
      } catch (e) {
        ok(down !== null, `${name}: ${(e as Error).message}`);
        ok(re.test((e as Error).message), `${name}: message ${(e as Error).message}`);
        eq((e as { proxyDown?: boolean }).proxyDown, down, `${name}: proxyDown`);
      }
    } finally { srv.close(); }
  }
});

await test("HTTPS proxy, negative (WP-14): a proxy whose certificate no trusted CA signed is refused at the TLS step (never sends CONNECT in the clear), classified proxy-down; a proxy that is plain HTTP on a https:// route fails the same way", { "WP-14": "full" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt40-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  let sawConnect = false;
  const tsrv = tls.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (s) => { s.on("data", (d: Buffer) => { if (/CONNECT/.test(d.toString())) sawConnect = true; }); s.on("error", () => {}); });
  tsrv.on("tlsClientError", () => {});
  await new Promise<void>((r) => tsrv.listen(0, "127.0.0.1", r));
  const plain = await rawServer((s) => { s.on("error", () => {}); s.once("data", () => s.end("HTTP/1.1 400 Bad Request\r\n\r\n")); });
  try {
    for (const [name, port, re] of [["self-signed", (tsrv.address() as net.AddressInfo).port, /TLS failed/], ["plain http", plain.port, /TLS failed|closed|setup/]] as const) {
      let err: unknown = null;
      try { await TUN.openTunnel(TUN.parseRoute(`https://127.0.0.1:${port}`), "pypi.org", 443, { secure: true, servername: "pypi.org", cred: undefined, timeoutMs: 3000 }); } catch (e) { err = e; }
      ok(err && re.test((err as Error).message), `${name}: ${(err as Error)?.message}`);
      eq((err as { proxyDown?: boolean }).proxyDown, true, `${name}: proxyDown`);
    }
    ok(!sawConnect, "CONNECT reached an untrusted proxy");
  } finally { tsrv.close(); plain.close(); }
});

/* ============================================================ WP-14 PAC mapping + failover */
await test("PAC entries → routes (WP-14): DIRECT, PROXY / HTTP → http, HTTPS → https (default 443), SOCKS and SOCKS4 → socks4 (Chrome's reading), SOCKS5 → socks5; QUIC → none; an unparsable host → none", { "WP-14": "full" }, () => {
  const got = PAC.parsePacResult("DIRECT; PROXY a:1; HTTP b:2; HTTPS c:3; HTTPS d; SOCKS e:4; SOCKS4 f:5; SOCKS5 g:6; QUIC h:7")
    .map((e) => RT.pacEntryRoute(e, false)).map((r) => (r ? `${r.mode}${r.mode === "direct" ? "" : ` ${r.host}:${r.port}`}` : null));
  eq(got, ["direct", "http a:1", "http b:2", "https c:3", "https d:443", "socks4 e:4", "socks4 f:5", "socks5 g:6", null]);
});

await test("bad-proxy memory (WP-14): a failed proxy is moved BEHIND the healthy candidates (incl. DIRECT) for exactly 5 minutes, then restored to its place; when every candidate is bad they are all still tried, in their order", { "WP-14": "full" }, () => {
  clearBad();
  const a = TUN.parseRoute("http://a:1"), b = TUN.parseRoute("socks4://b:2"), d = { ...TUN.DIRECT, isolate: false };
  const t0 = 1_000_000;
  RT.markProxyBad(a, t0);
  const lab = (l: { mode: string; host: string }[]) => l.map((r) => r.host || r.mode);
  eq(lab(RT.orderCandidates([a, b, d], t0 + 1)), ["b", "direct", "a"], "deprioritised");
  eq(lab(RT.orderCandidates([a, b, d], t0 + RT.BAD_PROXY_MS - 1)), ["b", "direct", "a"], "still bad at 4:59.999");
  eq(lab(RT.orderCandidates([a, b, d], t0 + RT.BAD_PROXY_MS)), ["a", "b", "direct"], "restored at 5:00");
  RT.markProxyBad(a, t0); RT.markProxyBad(b, t0);
  eq(lab(RT.orderCandidates([a, b], t0 + 5)), ["a", "b"], "all bad → original order");
  RT.markProxyBad(d, t0); eq(lab(RT.orderCandidates([d], t0 + 5)), ["direct"], "DIRECT is never marked");
  clearBad();
});

await test("failover classification (WP-14): over REAL connections — an unreachable proxy (refused port) and a broken one (not SOCKS) fail over and are marked bad; a proxy that ANSWERED (SOCKS4 91, HTTP 403 to CONNECT, 407) does not fail over (Chrome ≥ M67); a non-proxy error and a DIRECT failure never fail over; all-down throws the last error", { "WP-14": "full" }, async () => {
  clearBad();
  const target = new URL("https://pypi.org/");
  const http403 = await rawServer((s) => { s.on("error", () => {}); s.once("data", () => s.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")); });
  const http407 = await rawServer((s) => { s.on("error", () => {}); s.once("data", () => s.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")); });
  const s91 = await rawServer((s) => { s.on("error", () => {}); s.once("data", () => s.end(Buffer.from([0, 91, 0, 0, 0, 0, 0, 0]))); });
  const notSocks = await rawServer((s) => { s.on("error", () => {}); s.once("data", () => s.end("SSH-2.0-OpenSSH\r\n")); });
  const okSrv = await rawServer((s) => { s.on("error", () => {}); s.once("data", () => s.write("HTTP/1.1 200 Connection established\r\n\r\n")); });
  const open = (r: ReturnType<typeof TUN.parseRoute>) => CON.openUpstream("93.184.216.34", 80, { secure: false, route: r, timeoutMs: 1500 }).then((o) => { o.socket.destroy(); return o.remote; });
  try {
    const dead = TUN.parseRoute("http://127.0.0.1:1"), broken = TUN.parseRoute(`socks4://127.0.0.1:${notSocks.port}`), good = TUN.parseRoute(`http://127.0.0.1:${okSrv.port}`);
    eq(await RT.withFailover(target, [dead, broken, good], open), `via HTTP proxy 127.0.0.1:${okSrv.port}`, "reached the third");
    ok(RT.isProxyBad(dead) && RT.isProxyBad(broken) && !RT.isProxyBad(good), "dead + broken marked bad");
    eq(RT.failoverInfo().recent.length, 2, "two failovers noted");
    for (const [name, r] of [["403", TUN.parseRoute(`http://127.0.0.1:${http403.port}`)], ["407", TUN.parseRoute(`http://127.0.0.1:${http407.port}`)], ["91", TUN.parseRoute(`socks4://127.0.0.1:${s91.port}`)]] as const) {
      let reached = false, err: unknown = null;
      try { await RT.withFailover(target, [r, good], async (x) => { if (x === good) { reached = true; return "good"; } return open(x); }); } catch (e) { err = e; }
      ok(err && !reached && !RT.isProxyBad(r), `${name}: answered proxy must not fail over (${(err as Error)?.message}, reached=${reached})`);
    }
    let n = 0;
    await RT.withFailover(target, [good, dead], async () => { n++; throw new Error("site said no"); }).catch(() => {});
    eq(n, 1, "a non-proxy error is not retried elsewhere");
    n = 0;
    await RT.withFailover(target, [{ ...TUN.DIRECT, isolate: false }, good], async () => { n++; throw Object.assign(new TUN.ProxyRouteError("x"), {}); }).catch(() => {});
    eq(n, 1, "DIRECT failure is final");
    clearBad();
    const dead2 = TUN.parseRoute("socks4://127.0.0.1:2");
    let last: unknown = null; try { await RT.withFailover(target, [dead, dead2], open); } catch (e) { last = e; }
    ok(last && /127\.0\.0\.1:2/.test((last as Error).message), `all down → last error: ${(last as Error)?.message}`);
  } finally { for (const s of [http403, http407, s91, notSocks, okSrv]) s.close(); clearBad(); }
});

/* ============================================================ WP-15 OS auto-detect + KDE */
const REG_IE = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=proxy.corp:8080;socks=sox.corp:1080
    ProxyOverride    REG_SZ    <local>;*.corp
`;
const regConn = (flags: number) => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections
    DefaultConnectionSettings    REG_BINARY    4600000014000000${flags.toString(16).padStart(2, "0").toUpperCase()}00000000000000000000000000000000
`;
await test("Windows (WP-15): the AutoDetect bit (0x08) of DefaultConnectionSettings byte 8 is read from the Connections key; other bits do not set it; an absent / short value is no flag; socks= is SOCKS v4 unless written socks5:// (Chrome's ProxyRules); auto-detect alone is a usable setting", { "WP-15": "full" }, () => {
  eq(OS.connectionFlags(regConn(0x09)), 9); eq(OS.connectionFlags(regConn(0x03)), 3); eq(OS.connectionFlags(""), null); eq(OS.connectionFlags("    DefaultConnectionSettings    REG_BINARY    4600"), null);
  const a = OS.parseRegQuery(REG_IE, regConn(0x0b))!, b = OS.parseRegQuery(REG_IE, regConn(0x03))!;
  eq([a.autoDetect, b.autoDetect ?? false, a.socksVersion, a.socks, a.http], [true, false, 4, "sox.corp:1080", "proxy.corp:8080"]);
  eq(OS.parseRegQuery(REG_IE.replace("socks=sox.corp:1080", "socks=socks5://sox.corp:1080"))!.socksVersion, 5);
  const only = OS.parseRegQuery(REG_IE.replace("0x1", "0x0"), regConn(0x09))!;
  ok(only && only.autoDetect && !only.http, "auto-detect alone");
  eq(OS.parseRegQuery(REG_IE.replace("0x1", "0x0"), regConn(0x01)), null, "nothing set");
  const sp = SP.systemProxyFromOs(a);
  eq([sp.pacUrl, sp.http?.mode, SP.systemProxyFromOs(OS.parseRegQuery(REG_IE.replace("http=proxy.corp:8080;", ""))!).https?.mode], [WP.WPAD_URL, "http", "socks4"]);
});

await test("macOS + GNOME (WP-15): ProxyAutoDiscoveryEnable : 1 sets auto-detect; GNOME mode 'auto' with an EMPTY autoconfig-url means WPAD (with a URL it means that URL); a configured script URL wins over auto-detect", { "WP-15": "full" }, () => {
  const mac = OS.parseScutil("<dictionary> {\n  ProxyAutoDiscoveryEnable : 1\n  HTTPEnable : 0\n}\n")!;
  ok(mac && mac.autoDetect === true, "mac auto-discovery");
  eq(OS.parseScutil("<dictionary> {\n  ProxyAutoDiscoveryEnable : 0\n}\n"), null);
  const g = (url: string) => OS.parseGsettings(`org.gnome.system.proxy mode 'auto'\norg.gnome.system.proxy autoconfig-url '${url}'\n`);
  eq([g("")!.autoDetect, g("")!.pacUrl, g("http://p/x.pac")!.autoDetect, g("http://p/x.pac")!.pacUrl], [true, null, false, "http://p/x.pac"]);
  eq(SP.systemProxyFromOs({ ...g("http://p/x.pac")!, autoDetect: true }).pacUrl, "http://p/x.pac", "script URL wins");
});

const KIO = (body: string) => `[General]\nProxyType=9\n\n[Proxy Settings]\n${body}\n[Other]\nhttpProxy=http://wrong:1\n`;
await test("KDE kioslaverc (WP-15): ProxyType 0 none · 1 manual (\"http://h:p\" and KDE 5's \"http://h p\") · 2 script URL · 3 WPAD · 4 environment-variable NAMES; NoProxyFor lists; KDE's [$e] markers; keys outside [Proxy Settings] ignored; comments; SOCKS is v5", { "WP-15": "full" }, () => {
  eq(OS.parseKioslaverc(KIO("ProxyType=0\nhttpProxy=http://p:1")), null);
  const m = OS.parseKioslaverc(KIO("# c\nProxyType=1\nhttpProxy=http://proxy.corp 3128\nhttpsProxy=http://sec.corp:8443\nsocksProxy=socks://sox 1080\nNoProxyFor=localhost, .corp,10.0.0.0/8"))!;
  eq([m.source, m.http, m.https, m.socks, m.socksVersion, m.bypass], ["kde-kioslaverc", "proxy.corp:3128", "sec.corp:8443", "sox:1080", 5, ["localhost", ".corp", "10.0.0.0/8"]]);
  eq(OS.parseKioslaverc(KIO("ProxyType=2\nProxy Config Script=http://wpad.corp/p.pac"))!.pacUrl, "http://wpad.corp/p.pac");
  eq(OS.parseKioslaverc(KIO("ProxyType=3"))!.autoDetect, true);
  const e = OS.parseKioslaverc(KIO("ProxyType=4\nhttpProxy=HTTP_PROXY\nhttpsProxy=HTTPS_PROXY\nNoProxyFor=NO_PROXY"), { HTTP_PROXY: "http://envp:81", HTTPS_PROXY: "", NO_PROXY: "a.b,c.d" })!;
  eq([e.http, e.https, e.bypass], ["envp:81", null, ["a.b", "c.d"]]);
  eq(OS.parseKioslaverc(KIO("ProxyType[$e]=1\nhttpsProxy[$e]=http://m:9"))!.https, "m:9");
  eq(OS.parseKioslaverc("[Other]\nProxyType=1\nhttpProxy=http://x:1\n"), null, "outside the group");
});

await test("desktop selection (WP-15): a KDE session reads kioslaverc first; GNOME reads gsettings; without gsettings (ENOENT) kioslaverc is the fallback; Windows reads BOTH registry keys; XDG_CONFIG_HOME is honoured", { "WP-15": "full" }, () => {
  const kfile = "[Proxy Settings]\nProxyType=1\nhttpsProxy=http://kde.p 3128\n";
  const gs = "org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy.https host 'gnome.p'\norg.gnome.system.proxy.https port 8080\n";
  const reads: string[] = [];
  const read = (p: string) => { reads.push(p); return p.endsWith("kioslaverc") ? kfile : null; };
  const exGs = (cmd: string) => { if (cmd === "gsettings") return gs; throw Object.assign(new Error("no"), { code: "ENOENT" }); };
  const exNone = () => { throw Object.assign(new Error("no"), { code: "ENOENT" }); };
  eq(OS.readOsProxy("linux", exGs, read, { XDG_CURRENT_DESKTOP: "KDE", XDG_CONFIG_HOME: "/cfg" }).proxy?.https, "kde.p:3128");
  eq(reads[0], "/cfg/kioslaverc");
  eq(OS.readOsProxy("linux", exGs, read, { XDG_CURRENT_DESKTOP: "GNOME" }).proxy?.https, "gnome.p:8080");
  eq(OS.readOsProxy("linux", exNone, read, { HOME: "/h" }).proxy?.source, "kde-kioslaverc");
  eq(OS.kioslavercPath({ HOME: "/h" }), "/h/.config/kioslaverc");
  const calls: string[][] = [];
  const exWin = (cmd: string, args: string[]) => { calls.push(args); return args[1].endsWith("Connections") ? regConn(0x09) : REG_IE; };
  const w = OS.readOsProxy("win32", exWin).proxy!;
  ok(w.autoDetect && calls.length === 2 && calls[1].includes("DefaultConnectionSettings"), JSON.stringify(calls));
});

/* ============================================================ WP-15 WPAD */
await test("WPAD candidates (WP-15): wpad first, then devolution of each search domain DOWN TO the registrable domain and never above it — squatting negatives: co.uk, com.mx, ac.jp, a public suffix as the search domain, single labels, numeric TLDs, bad labels; duplicates merged; at most 8", { "WP-15": "full" }, () => {
  eq(WP.wpadCandidates(["eng.corp.example.com"]), ["http://wpad/wpad.dat", "http://wpad.eng.corp.example.com/wpad.dat", "http://wpad.corp.example.com/wpad.dat", "http://wpad.example.com/wpad.dat"]);
  eq(WP.wpadCandidates(["dept.example.co.uk"]), ["http://wpad/wpad.dat", "http://wpad.dept.example.co.uk/wpad.dat", "http://wpad.example.co.uk/wpad.dat"]);
  eq(WP.wpadCandidates(["a.b.example.com.mx"]).slice(-1), ["http://wpad.example.com.mx/wpad.dat"], "com.mx floor (not in the short list)");
  eq(WP.wpadCandidates(["x.univ.ac.jp"]).slice(-1), ["http://wpad.univ.ac.jp/wpad.dat"]);
  for (const d of ["co.uk", "com.mx", "github.io", "com", "localhost", "10.0.0.1", "bad_label.example.com", "-x.example.com"]) eq(WP.wpadCandidates([d]), ["http://wpad/wpad.dat"], d);
  eq(WP.wpadFloor("corp.example.de"), "example.de");
  const many = WP.wpadCandidates(["a.b.c.d.e.f.g.h.example.com"]);
  eq(many.length, WP.WPAD_MAX_CANDIDATES); ok(!many.some((u) => /wpad\.com\//.test(u)), "never wpad.com");
  eq(WP.wpadCandidates(["corp.example.com", "eng.corp.example.com"]).length, 4, "merged");
});

await test("search domains (WP-15): resolv.conf search + domain (comments ignored), scutil --dns search domain[n] / domain, the Tcpip registry SearchList / Domain / NV Domain / DhcpDomain; an FQDN hostname adds its domain; .local mDNS names dropped", { "WP-15": "full" }, () => {
  eq(WP.parseResolvConf("# x\nnameserver 1.1.1.1\nsearch eng.corp.example.com corp.example.com ; tail\ndomain corp.example.com\n"), ["eng.corp.example.com", "corp.example.com"]);
  eq(WP.parseScutilDns("resolver #1\n  search domain[0] : eng.example.org\n  search domain[1] : example.org\n  domain   : example.org\n"), ["eng.example.org", "example.org"]);
  eq(WP.parseTcpipReg("\n    Domain    REG_SZ    corp.example.net\n    SearchList    REG_SZ    a.example.net,b.example.net\n    NV Domain    REG_SZ    corp.example.net\n    DhcpDomain    REG_SZ    dhcp.example.net\n"), ["a.example.net", "b.example.net", "corp.example.net", "dhcp.example.net"]);
  eq(WP.searchDomains("linux", () => "", () => "search home.local corp.example.com\n", "pc1.lab.example.com"), ["corp.example.com", "lab.example.com"]);
  eq(WP.searchDomains("win32", () => "    Domain    REG_SZ    w.example.com\n", () => { throw new Error("read on windows"); }, "pc"), ["w.example.com"]);
});

await test("discovery (WP-15): candidates tried strictly in order; a 2xx that is not a PAC file (an HTML page on a host that happens to be called wpad) is skipped; the first real script wins and later names are never contacted; the overall budget stops the walk; total failure lists what was tried", { "WP-15": "full" }, async () => {
  const seen: string[] = [];
  const pac = "function FindProxyForURL(u, h) { return 'DIRECT'; }";
  const r = await WP.discoverWpad({ domains: ["eng.corp.example.com"], load: async (u) => { seen.push(u); if (u.includes("//wpad/")) throw new Error("ENOTFOUND"); if (u.includes("eng.")) return "<html>hello</html>"; return pac; } });
  eq([r.url, r.tried.length, seen.length], ["http://wpad.corp.example.com/wpad.dat", 3, 3]);
  let err: { message: string; tried?: string[] } | null = null;
  try { await WP.discoverWpad({ domains: ["eng.corp.example.com"], load: async () => { await sleep(120); throw new Error("timeout"); }, budgetMs: 300 }); } catch (e) { err = e as typeof err; }
  ok(err && /time budget|no PAC file/.test(err.message) && (err.tried?.length ?? 9) <= 3, `budget: ${err?.message} ${err?.tried?.length}`);
  const ms = await WP.discoverWpad({ domains: [], load: async () => "var FindProxyForURL = function(u,h){return 'DIRECT'}" });
  eq(ms.url, "http://wpad/wpad.dat", "assignment form accepted");
});

/* ============================================================ WP-16 subresource SameSite */
const CORS = await import("../src/lib/wp-cors.ts");
const CORE = await import("../src/lib/wp-core.ts");
await test("subresource segment (WP-16): \"<sid>:<doc>:r\" parses as a markup subresource of that document; malformed doc ids and unknown codes still refuse; decodeTarget carries the flag", { "WP-16": "full" }, () => {
  eq(CORS.parseSidSegment("S1:abcdefgh12:r"), { sid: "S1", doc: "abcdefgh12", resource: true });
  eq(CORS.parseSidSegment("S1:abcdefgh12:i"), { sid: "S1", doc: "abcdefgh12", cred: "include" });
  for (const bad of ["S1:short:r", "S1:abcdefgh12:x", "S1:abcdefgh12:r:extra", "S1::r"]) eq(CORS.parseSidSegment(bad), null, bad);
  const sid = "a".repeat(20);
  const d = CORE.decodeTarget(`/api/wp/s/${sid}:abcdefgh12:r/https/img.example.com/x.png`);
  eq([d.sid, d.doc, d.resource, d.cred, d.target.href], [sid, "abcdefgh12", true, undefined, "https://img.example.com/x.png"]);
});

await test("subresource policy (WP-16): same-site (incl. a sibling subdomain) gets every cookie, cross-site only SameSite=None, schemeful (http vs https = cross-site); Sec-Fetch-Site same-origin / same-site / cross-site from the DOCUMENT; Referer = the document's origin, none https→http; an unknown document = cross-site with no Referer; cross-site Set-Cookie keeps only SameSite=None", { "WP-16": "full" }, () => {
  const so = (h: string) => CORE.siteOf(h);
  const P = (init: string | null, t: string) => CORS.resourcePolicy({ initiator: init, target: new URL(t), siteOf: so });
  eq(P("https://www.shop.example", "https://www.shop.example/a.png"), { crossSite: false, secFetchSite: "same-origin", referer: "https://www.shop.example/" });
  eq(P("https://www.shop.example", "https://cdn.shop.example/a.png"), { crossSite: false, secFetchSite: "same-site", referer: "https://www.shop.example/" });
  eq(P("https://www.shop.example", "https://tracker.example/p.gif"), { crossSite: true, secFetchSite: "cross-site", referer: "https://www.shop.example/" });
  eq(P("https://www.shop.example", "http://cdn.shop.example/a.png"), { crossSite: true, secFetchSite: "cross-site", referer: null });
  eq(P(null, "https://x.example/a.png"), { crossSite: true, secFetchSite: "cross-site", referer: null });
  eq(P("https://a.github.io", "https://b.github.io/x.js").crossSite, true, "public-suffix siblings are different sites");
  // the referrer URL (page or stylesheet) — strict-origin-when-cross-origin
  const R = (ref: string, t: string) => CORS.resourcePolicy({ initiator: "https://www.shop.example", target: new URL(t), siteOf: so, referrerUrl: ref }).referer;
  eq(R("https://www.shop.example/p?q=1#frag", "https://www.shop.example/a.png"), "https://www.shop.example/p?q=1", "same origin: full URL, no fragment");
  eq(R("https://u:pw@cdn.other.example/s.css", "https://cdn.other.example/i.png"), "https://cdn.other.example/s.css", "stylesheet same-origin with its image: no credentials");
  eq(R("https://cdn.other.example/s.css", "https://www.shop.example/i.png"), "https://cdn.other.example/", "cross-origin: origin only");
  eq(R("https://cdn.other.example/s.css", "http://cdn.other.example/i.png"), null, "downgrade");
  eq(CORS.resourcePolicy({ initiator: "https://www.shop.example", target: new URL("https://cdn.other.example/i.png"), siteOf: so, referrerUrl: "https://cdn.other.example/s.css" }).secFetchSite, "cross-site", "Sec-Fetch-Site still follows the PAGE");
  const lines = ["a=1; Path=/", "b=2; SameSite=Lax", "c=3; SameSite=None; Secure", "d=4; samesite = none ; Secure"];
  eq(CORS.storableForResource(true, lines), [lines[2], lines[3]]); eq(CORS.storableForResource(false, lines), lines);
});

await test("markup tagging (WP-16): img / script / link / source / track / audio / video / input[type=image] / poster / background / srcset / style attribute / <style> get the subresource segment; a / area / form / iframe / frame / object / embed / base / meta refresh keep the plain one (a new page must never inherit this document's id); without resSid nothing changes", { "WP-16": "full" }, () => {
  const sid = "s".repeat(20), res = `${sid}:abcdefgh12:r`;
  const html = `<html><head><link rel=stylesheet href="/c.css"><style>body{background:url(/bg.png)}</style><meta http-equiv="refresh" content="5; url=/next"></head><body background="/b.png">
<img src="/i.png" srcset="/i2.png 2x"><script src="/s.js"></script><video src="/v.mp4" poster="/p.jpg"><source src="/v.webm"><track src="/t.vtt"></video><audio src="/a.mp3"></audio><input type=image src="/btn.png">
<div style="background:url(/d.png)"></div><a href="/page">x</a><area href="/map"><form action="/post"></form><iframe src="/f.html"></iframe><object data="/o.pdf"></object><embed src="/e.swf"></body></html>`;
  const { html: out } = CORE.rewriteHtml(html, { sid, url: "https://www.shop.example/", resSid: res });
  const segOf = (path: string) => { const m = new RegExp(`/api/wp/s/([^/]+)/https/www\\.shop\\.example${path.replace(/[.]/g, "\\.")}["' )&\\s]`).exec(out); return m ? m[1] : "(missing)"; };
  for (const p of ["/c.css", "/bg.png", "/b.png", "/i.png", "/i2.png", "/s.js", "/v.mp4", "/p.jpg", "/v.webm", "/t.vtt", "/a.mp3", "/btn.png", "/d.png"]) eq(segOf(p), res, `resource ${p}`);
  for (const p of ["/page", "/map", "/post", "/f.html", "/o.pdf", "/e.swf", "/next"]) eq(segOf(p), sid, `navigation ${p}`);
  const { html: plain } = CORE.rewriteHtml(html, { sid, url: "https://www.shop.example/" });
  ok(!plain.includes(":r/"), "no tag without resSid");
});

await finish();
process.exit(0);
