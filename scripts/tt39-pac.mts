/**
 * TT39 PAC + OS proxy settings tests (WP-12), no Next server needed:
 *  - PAC helpers (src/lib/server/pac.ts) against the Netscape specification's own examples and fixed-clock vectors
 *  - differential against an independent implementation: PyPAC 0.19 (Apache-2.0) in Duktape (dukpy, MIT) —
 *    scripts/fixtures/pac/pac_oracle.py, clock pinned to the same instant. Where PyPAC itself departs from the
 *    specification the disagreement is PREDICTED up front with the reason, and must come out exactly as predicted.
 *  - hostile PAC files, each in its own child process (scripts/fixtures/pac/hostile-child.mts)
 *  - OS settings parsers (src/lib/server/osproxy.ts) on each platform tool's documented output format
 *  - live: a fresh server process picks a PAC file up and an independent proxy (pproxy) carries what the PAC says
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt39-pac.mts
 */
process.env.TZ = "UTC"; // the oracle runs with TZ=UTC too: local-time helpers compare at the same wall clock
import * as http from "node:http";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";

const PAC = await import("../src/lib/server/pac.ts");
const OS = await import("../src/lib/server/osproxy.ts");
const SP = await import("../src/lib/server/sysproxy.ts");

const { test, finish } = makeHarness("tt39-pac");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const run = promisify(execFile);
const NODE_TS = ["--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"];

// Sunday 18 October 2026, 14:30:15 UTC
const NOW = Date.UTC(2026, 9, 18, 14, 30, 15);
const NOW_ISO = new Date(NOW).toISOString();
const stub = (m: Record<string, string>) => async (h: string) => m[h] ?? null;

/** Evaluate a list of JS expressions inside a PAC context (each must be JSON-serialisable). */
async function probe(exprs: string[], o: { url?: string; resolve?: (h: string) => Promise<string | null>; dns?: boolean } = {}): Promise<unknown[]> {
  const p = new PAC.PacScript(`function FindProxyForURL(url, host) { return JSON.stringify([${exprs.join(",\n")}]); }`);
  return JSON.parse(await p.find(new URL(o.url ?? "http://x.example/"), { now: NOW, myIp: "192.0.2.10", dns: o.dns, resolve: o.resolve ?? stub({}) }));
}
function vectors(pairs: [string, unknown][]) { return { exprs: pairs.map((p) => p[0]), want: pairs.map((p) => p[1]) }; }
async function check(pairs: [string, unknown][], o?: Parameters<typeof probe>[1]) {
  const { exprs, want } = vectors(pairs);
  const got = await probe(exprs, o);
  const bad = exprs.map((e, i) => (JSON.stringify(got[i]) === JSON.stringify(want[i]) ? null : `${e} → ${JSON.stringify(got[i])} (want ${JSON.stringify(want[i])})`)).filter(Boolean);
  if (bad.length) throw new Error(bad.join("\n"));
  return exprs.length;
}

// ===================================================================================== helpers
await test("PAC helpers vs the Netscape specification's own examples: isPlainHostName, dnsDomainIs, localHostOrDomainIs, dnsDomainLevels, shExpMatch, isInNet (incl. a name resolved through DNS), dnsResolve, isResolvable, myIpAddress, convert_addr, the …Ex IPv6-extension functions; shell classes [ab] / [a-z] / [!a]", { "WP-12": "full" }, async () => {
  const n = await check([
    ['isPlainHostName("www")', true], ['isPlainHostName("www.netscape.com")', false],
    ['dnsDomainIs("www.netscape.com", ".netscape.com")', true], ['dnsDomainIs("www", ".netscape.com")', false], ['dnsDomainIs("www.mcom.com", ".netscape.com")', false],
    ['localHostOrDomainIs("www.netscape.com", "www.netscape.com")', true], ['localHostOrDomainIs("www", "www.netscape.com")', true],
    ['localHostOrDomainIs("www.mcom.com", "www.netscape.com")', false], ['localHostOrDomainIs("home.netscape.com", "www.netscape.com")', false],
    ['localHostOrDomainIs("www.n", "www.netscape.com")', false],
    ['dnsDomainLevels("www")', 0], ['dnsDomainLevels("www.netscape.com")', 2],
    ['shExpMatch("http://home.netscape.com/people/ari/index.html", "*/ari/*")', true], ['shExpMatch("http://home.netscape.com/people/montulli/index.html", "*/ari/*")', false],
    ['shExpMatch("cdn7.example.net", "cdn?.example.net")', true], ['shExpMatch("cdn77.example.net", "cdn?.example.net")', false],
    ['shExpMatch("a.example", "a.exampl")', false], ['shExpMatch("aXexample", "a.example")', false], ['shExpMatch("a+b", "a+b")', true], ['shExpMatch("(x)", "(x)")', true],
    ['shExpMatch("b.corp", "[ab].corp")', true], ['shExpMatch("c.corp", "[ab].corp")', false], ['shExpMatch("q.corp", "[a-z].corp")', true], ['shExpMatch("a.corp", "[!a].corp")', false], ['shExpMatch("b.corp", "[!a].corp")', true], ['shExpMatch("[x", "[x")', true],
    ['isInNet("198.95.249.79", "198.95.249.79", "255.255.255.255")', true], ['isInNet("198.95.249.80", "198.95.249.79", "255.255.255.255")', false],
    ['isInNet("198.95.6.8", "198.95.0.0", "255.255.0.0")', true], ['isInNet("198.96.6.8", "198.95.0.0", "255.255.0.0")', false],
    ['isInNet("intranet.corp", "10.0.0.0", "255.0.0.0")', true], ['isInNet("10.0.0.1", "10.0.0.0", "bad")', false], ['isInNet("nowhere.invalid", "0.0.0.0", "0.0.0.0")', false],
    ['dnsResolve("intranet.corp")', "10.1.2.3"], ['dnsResolve("nowhere.invalid")', null], ['dnsResolve("8.8.4.4")', "8.8.4.4"],
    ['isResolvable("intranet.corp")', true], ['isResolvable("nowhere.invalid")', false], ['myIpAddress()', "192.0.2.10"],
    ['convert_addr("104.16.41.2")', 1745889538],
    ['isInNetEx("10.1.2.3", "10.0.0.0/8")', true], ['isInNetEx("11.1.2.3", "10.0.0.0/8")', false], ['isInNetEx("10.1.2.3", "10.0.0.0/33")', false],
    ['dnsResolveEx("nowhere.invalid")', ""], ['sortIpAddressList("10.2.0.1;10.1.0.1")', "10.1.0.1;10.2.0.1"], ['getClientVersion()', "1.0"],
  ], { resolve: stub({ "intranet.corp": "10.1.2.3" }) });
  console.log(`     ${n} helper vectors`);
});

await test("PAC date/time helpers at a fixed clock (Sunday 18 Oct 2026 14:30:15 UTC): weekdayRange incl. wrap past Saturday, dateRange in all 9 Netscape forms incl. ranges across the year end, timeRange in its 4 forms incl. wrap past midnight and second-exact bounds, 'GMT' as the last argument", { "WP-12": "full" }, async () => {
  const n = await check([
    ['weekdayRange("SUN")', true], ['weekdayRange("MON")', false], ['weekdayRange("MON", "FRI")', false], ['weekdayRange("SAT", "MON")', true], ['weekdayRange("FRI", "SAT")', false],
    ['weekdayRange("SUN", "GMT")', true], ['weekdayRange("MON", "SUN", "GMT")', true], ['weekdayRange("XYZ")', false],
    ['dateRange(18)', true], ['dateRange(1, 15)', false], ['dateRange(15, 20)', true], ['dateRange(25, 5)', false], ['dateRange(15, 3)', true],
    ['dateRange("OCT")', true], ['dateRange("SEP", "NOV")', true], ['dateRange("NOV", "FEB")', false], ['dateRange("SEP", "FEB")', true],
    ['dateRange(2026)', true], ['dateRange(2025, 2027)', true], ['dateRange(2027, 2030)', false],
    ['dateRange(1, "OCT", 31, "OCT")', true], ['dateRange(20, "OCT", 1, "NOV")', false], ['dateRange(1, "DEC", 20, "OCT")', true], ['dateRange(19, "OCT", 17, "OCT")', false],
    ['dateRange("OCT", 2026, "DEC", 2026)', true], ['dateRange("NOV", 2026, "JAN", 2027)', false], ['dateRange("DEC", 2025, "OCT", 2026)', true],
    ['dateRange(1, "JAN", 2026, 31, "DEC", 2026)', true], ['dateRange(19, "OCT", 2026, 31, "DEC", 2026)', false], ['dateRange(18, "OCT", 2026, 18, "OCT", 2026)', true],
    ['dateRange(18, "OCT", 2026)', true], ['dateRange("OCT", "GMT")', true], ['dateRange(18, "GMT")', true],
    ['timeRange(14)', true], ['timeRange(15)', false], ['timeRange(9, 17)', true], ['timeRange(15, 16)', false], ['timeRange(14, 15)', true], ['timeRange(13, 14)', false],
    ['timeRange(22, 6)', false], ['timeRange(14, 3)', true],
    ['timeRange(14, 0, 14, 31)', true], ['timeRange(14, 0, 14, 30)', false], ['timeRange(14, 30, 15, 14, 30, 15)', true], ['timeRange(14, 30, 16, 14, 31, 0)', false],
    ['timeRange(23, 0, 0, 14, 30, 15)', true], ['timeRange(14, "GMT")', true], ['timeRange(9, 17, "GMT")', true], ['timeRange(1, 2, 3)', false],
  ]);
  console.log(`     ${n} clock vectors`);
});

await test("PAC results and plumbing: 'PROXY a:1; SOCKS5 [::1]:2; DIRECT' parses (default ports, IPv6, case-insensitive types); 9 malformed entries are skipped; https:// URLs reach the script as scheme://host:port/ only (no path, no query — as Chrome); FindProxyForURLEx is preferred when both exist; DNS answers come back through re-runs (one lookup per name, cached), DNS off answers null with NO lookup; 40 concurrent decisions each get their own answer", { "WP-12": "full" }, async () => {
  eq(PAC.parsePacResult("PROXY a.example:3128; socks5 [::1]:1080 ;DIRECT"), [{ type: "PROXY", host: "a.example", port: 3128 }, { type: "SOCKS5", host: "::1", port: 1080 }, { type: "DIRECT" }]);
  eq(PAC.parsePacResult("PROXY p; HTTPS s; SOCKS k"), [{ type: "PROXY", host: "p", port: 80 }, { type: "HTTPS", host: "s", port: 443 }, { type: "SOCKS", host: "k", port: 1080 }]);
  const junk = ["PROXY", "PROXY a:0", "PROXY a:65536", "PROXY a b", "FTP a:1", "DIRECT x", "PROXY a:1:2", "PROXY a/b:1", "PROXY ::1:80"];
  for (const j of junk) eq(PAC.parsePacResult(j), [], j);
  eq(PAC.parsePacResult(42), []);
  const echo = new PAC.PacScript("function FindProxyForURL(url, host) { return url + ' ' + host; }");
  eq(await echo.find(new URL("https://Bank.Example:8443/acct/123?token=SECRET#f")), "https://bank.example:8443/ bank.example");
  eq(await echo.find(new URL("http://news.example/a/b?q=1#frag")), "http://news.example/a/b?q=1 news.example");
  eq(await echo.find(new URL("wss://chat.example/room?k=1")), "wss://chat.example/ chat.example");
  const ex = new PAC.PacScript("function FindProxyForURL(u, h) { return 'PROXY old:1'; } function FindProxyForURLEx(u, h) { return 'PROXY ex:1'; }");
  eq(await ex.find(new URL("http://a.example/")), "PROXY ex:1");
  let lookups = 0;
  const resolve = async (h: string) => { lookups++; await sleep(5); return h.startsWith("in.") ? "10.0.0.7" : null; };
  const corp = new PAC.PacScript(`function FindProxyForURL(url, host) {
    if (isInNet(host, "10.0.0.0", "255.0.0.0") && isResolvable("in.second.check")) return "DIRECT";
    return "PROXY edge:8080"; }`);
  eq(await corp.find(new URL("http://in.corp/"), { resolve }), "DIRECT");
  eq(lookups, 2, "one lookup per name");
  eq(await corp.find(new URL("http://in.corp/x"), { resolve }), "DIRECT");
  eq(lookups, 2, "cached");
  eq(await corp.find(new URL("http://out.example/"), { resolve }), "PROXY edge:8080");
  eq(lookups, 3, "one more for the new name");
  const before = lookups;
  eq(await corp.find(new URL("http://in.corp/"), { resolve, dns: false }), "PROXY edge:8080", "DNS off → isInNet on a name is false");
  eq(lookups, before, "DNS off makes no lookup");
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => corp.find(new URL(`http://${i % 2 ? "in" : "out"}.n${i}.example/`), { resolve: async (h) => { await sleep(1 + (i % 7)); return h.startsWith("in.") ? "10.1.1.1" : null; } })));
  eq(many, Array.from({ length: 40 }, (_, i) => (i % 2 ? "DIRECT" : "PROXY edge:8080")), "concurrent decisions");
});

// ===================================================================================== differential
await test("differential vs PyPAC 0.19 (Apache-2.0, Duktape engine) at the same pinned instant: 3 realistic PAC files (corporate split routing with isInNet/shExpMatch/dnsDomainIs/localHostOrDomainIs, a working-hours schedule, a helper probe) × 14 hosts × http/https = 84 decisions must be IDENTICAL; 6 cases where PyPAC departs from the Netscape text (one-argument weekdayRange is always false, ranges never wrap, localHostOrDomainIs is a bare prefix test, a failed dnsResolve gives \"\" — Chrome gives null) are predicted beforehand and must differ exactly as predicted", { "WP-12": "full" }, async () => {
  const P1 = `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || dnsDomainIs(host, ".corp.example") || localHostOrDomainIs(host, "intranet.corp.example")) return "DIRECT";
  if (shExpMatch(url, "http://*.media.example/*") || shExpMatch(host, "cdn?.example.net") || shExpMatch(host, "[ab]*.shop.example")) return "PROXY media-proxy:3128";
  if (isInNet(host, "10.0.0.0", "255.0.0.0") || isInNet(host, "192.168.0.0", "255.255.0.0") || isInNet(host, "127.0.0.0", "255.0.0.0")) return "DIRECT";
  if (url.substring(0, 6) == "https:") return "PROXY secure-proxy:8443; DIRECT";
  if (dnsDomainLevels(host) > 3) return "SOCKS5 socks:1080";
  return "PROXY proxy.corp.example:8080; PROXY backup:8080; DIRECT";
}`;
  const P2 = `function FindProxyForURL(url, host) {
  if (weekdayRange("MON", "FRI") && timeRange(9, 17)) return "PROXY work:1";
  if (weekdayRange("SAT", "SUN", "GMT") && timeRange(14, 0, 15, 0, "GMT")) return "PROXY weekend-afternoon:1";
  if (dateRange("OCT", "DEC")) return "PROXY q4:1";
  return "DIRECT";
}`;
  const P3 = `function FindProxyForURL(url, host) {
  return [isPlainHostName(host), dnsDomainIs(host, ".example.com"), dnsDomainLevels(host), shExpMatch(host, "*.example.*"), shExpMatch(url, "*/path/*"),
    isInNet(host, "127.0.0.0", "255.0.0.0"), isInNet(host, "10.0.0.0", "255.255.0.0"), isResolvable(host), dateRange(15, 20), dateRange("OCT", 2026, "DEC", 2026),
    timeRange(14, 0, 0, 14, 59, 59), localHostOrDomainIs(host.split(".")[0], host), dnsResolve("localhost")].join(",");
}`;
  const hosts = ["localhost", "127.0.0.1", "10.1.2.3", "10.2.0.9", "192.168.5.5", "intranet", "intranet.corp.example", "www.corp.example", "a.b.c.d.example.org",
    "cdn1.example.net", "x.media.example", "beta.shop.example", "www.example.com", "198.51.100.7"];
  type C = { pac: string; url: string; host: string };
  const cases: C[] = [];
  for (const pac of [P1, P2, P3]) for (const h of hosts) for (const scheme of ["http", "https"]) {
    const u = new URL(`${scheme}://${h}/path/index.html?q=1`);
    cases.push({ pac, url: PAC.pacUrlFor(u), host: u.hostname });
  }
  const predicted: { pac: string; ours: string; pypac: string; why: string }[] = [
    { pac: 'weekdayRange("SUN")', ours: "true", pypac: "false", why: "PyPAC rejects a missing second argument (None is not a weekday)" },
    { pac: 'timeRange(14, 3)', ours: "true", pypac: "false", why: "hour ranges past midnight wrap (Netscape: 'timeRange(22, 6)' style)" },
    { pac: 'dateRange("SEP", "FEB")', ours: "true", pypac: "false", why: "month ranges across the year end wrap" },
    { pac: 'dateRange(15, 3)', ours: "true", pypac: "false", why: "day ranges across the month end wrap" },
    { pac: 'localHostOrDomainIs("www.n", "www.netscape.com")', ours: "false", pypac: "true", why: "Netscape: the unqualified host must equal the first label" },
    { pac: 'dnsResolve("nowhere.invalid")', ours: "null", pypac: "", why: "Chrome returns null when resolution fails" },
  ];
  for (const p of predicted) cases.push({ pac: `function FindProxyForURL(url, host) { return String(${p.pac}); }`, url: "http://x/", host: "x" });
  const ours: string[] = [];
  const compiled = new Map<string, InstanceType<typeof PAC.PacScript>>();
  for (const c of cases) {
    let p = compiled.get(c.pac); if (!p) { p = new PAC.PacScript(c.pac); compiled.set(c.pac, p); }
    // the same URL string the oracle gets; hosts resolve through the system resolver in both implementations
    ours.push(await p.find(new URL(c.url.replace(/^https:\/\/([^/]+)\/$/, "https://$1/")), { now: NOW }));
  }
  const r = spawnSync(PY, ["scripts/fixtures/pac/pac_oracle.py"], { input: JSON.stringify({ now: NOW_ISO, cases }), env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 60000 });
  ok(r.status === 0, `oracle failed: ${r.stderr}`);
  const theirs = JSON.parse(r.stdout) as string[];
  eq(theirs.length, cases.length, "oracle answered every case");
  const n = cases.length - predicted.length;
  const diffs: string[] = [];
  for (let i = 0; i < n; i++) if (ours[i] !== theirs[i]) diffs.push(`${cases[i].host} ${cases[i].url} [P${1 + Math.floor(i / (hosts.length * 2))}]: ours ${ours[i]} | PyPAC ${theirs[i]}`);
  ok(!diffs.length, `${diffs.length} unexpected differences:\n${diffs.join("\n")}`);
  for (let k = 0; k < predicted.length; k++) {
    const i = n + k, p = predicted[k];
    ok(ours[i] === p.ours && theirs[i] === p.pypac, `predicted difference ${p.pac} (${p.why}): ours ${ours[i]} want ${p.ours}; PyPAC ${theirs[i]} want ${p.pypac}`);
  }
  const distinct = new Set(ours.slice(0, n)).size;
  ok(distinct >= 8, `the corpus exercises many branches (${distinct} distinct answers)`);
  console.log(`     ${n} identical decisions (${distinct} distinct answers), ${predicted.length} predicted PyPAC departures confirmed`);
});

// ===================================================================================== adversary
const hostile = (src: string, dns = true) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...NODE_TS, "scripts/fixtures/pac/hostile-child.mts"], { input: src, env: { ...process.env, PAC_DNS: dns ? "1" : "0" }, encoding: "utf8", timeout: 20000, maxBuffer: 4 << 20 });
  const wall = Date.now() - t0;
  if (r.error || r.status !== 0) return { hung: true, wall, stderr: `${r.error ? (r.error as Error).message + " " : ""}${String(r.stderr ?? "").slice(0, 300)}` } as Record<string, unknown>;
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()!), wall } as Record<string, unknown>;
};
await test("hostile PAC files (each in its own process; D: 14 shapes): reaching the host through constructors (3 ways), an endless loop at load and in FindProxyForURL, a real Error with an endless message getter thrown at load, an endless PROMISE JOB (would run after the time limit without microtaskMode), a thrown object with an endless getter, a thrown Proxy, a result whose toString never returns, a DNS flood, a >1 MiB script, a syntax error, no FindProxyForURL — every one ends within its time limit with an error or a harmless string, and the process stays alive", { "WP-12": "full" }, async () => {
  const shapes: [string, string, (r: Record<string, unknown>) => boolean][] = [
    ["constructor of a helper", `function FindProxyForURL(u, h) { try { return String(dnsResolve.constructor("return typeof process")()); } catch (e) { return "blocked " + e.name; } }`, (r) => r.result === "blocked EvalError"],
    ["constructor of the global", `function FindProxyForURL(u, h) { try { return String(this.constructor.constructor("return process")()); } catch (e) { return "blocked " + e.name; } }`, (r) => r.result === "blocked EvalError"],
    ["globals of the host", `function FindProxyForURL(u, h) { return [typeof process, typeof require, typeof Buffer, typeof fetch, typeof WebAssembly === "object" ? "wasm-object" : "none"].join(","); }`, (r) => /^undefined,undefined,undefined,undefined,/.test(String(r.result))],
    ["endless loop at load", `for (;;) {} function FindProxyForURL() { return "DIRECT"; }`, (r) => /failed to load \(time limit\)/.test(String(r.error))],
    ["a real Error whose message getter never returns, thrown at load", `var e = new Error("x"); Object.defineProperty(e, "message", { get: function () { for (;;) {} } }); throw e;`, (r) => r.error === "PAC: the script failed to load"],
    ["endless loop in FindProxyForURL", `function FindProxyForURL() { for (;;) {} }`, (r) => /time limit/.test(String(r.error))],
    ["endless promise job", `function FindProxyForURL() { Promise.resolve().then(function spin() { for (;;) {} }); return "DIRECT"; }`, (r) => /time limit/.test(String(r.error)) || r.result === "DIRECT"],
    ["endless getter on a thrown object", `function FindProxyForURL() { throw { get __fusionNeedDns() { for (;;) {} }, get message() { for (;;) {} } }; }`, (r) => /time limit/.test(String(r.error))],
    ["thrown Proxy", `function FindProxyForURL() { throw new Proxy({}, { get: function () { for (;;) {} } }); }`, (r) => /time limit/.test(String(r.error))],
    ["toString that never returns", `function FindProxyForURL() { return { toString: function () { for (;;) {} } }; }`, (r) => /time limit/.test(String(r.error))],
    ["DNS flood", `function FindProxyForURL() { for (var i = 0; i < 100; i++) dnsResolve("n" + i + ".flood.example"); return "DIRECT"; }`, (r) => /more than 16 DNS lookups/.test(String(r.error))],
    ["script over 1 MiB", `// ${"x".repeat((1 << 20) + 10)}\nfunction FindProxyForURL() { return "DIRECT"; }`, (r) => /larger than 1048576/.test(String(r.error))],
    ["syntax error", `function FindProxyForURL( { return "DIRECT"; }`, (r) => /does not parse/.test(String(r.error))],
    ["no FindProxyForURL", `function findProxy() { return "DIRECT"; }`, (r) => /defines no FindProxyForURL/.test(String(r.error))],
  ];
  const lines: string[] = [];
  for (const [name, src, pass] of shapes) {
    const r = hostile(src);
    ok(!r.hung, `${name}: the child hung or crashed (${r.stderr ?? ""})`);
    ok(pass(r), `${name}: ${JSON.stringify(r).slice(0, 300)}`);
    ok((r.ms as number) < 4000, `${name}: took ${r.ms} ms`);
    ok((r.after as { alive?: boolean })?.alive === true, `${name}: process not responsive afterwards`);
    lines.push(`${name}: ${String(r.error ?? r.result).slice(0, 60)} (${r.ms} ms)`);
  }
  console.log("     " + lines.join("\n     "));
});

// ===================================================================================== OS settings
const REG_SINGLE = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    DisableCachingOfSSLPages    REG_DWORD    0x0
    IE5_UA_Backup_Flag    REG_SZ    5.0
    User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    proxy.corp.example:8080
    ProxyOverride    REG_SZ    <local>;*.corp.example;10.*;192.168.1.*
    EnableNegotiate    REG_DWORD    0x1
`;
const REG_PER_PROTOCOL = REG_SINGLE.replace("proxy.corp.example:8080", "http=web.corp:3128;https=secure.corp:8443;ftp=ftp.corp:21;socks=socks.corp:1080").replace("<local>;", "");
const REG_PAC_ONLY = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    stale.corp:8080
    AutoConfigURL    REG_SZ    http://wpad.corp.example/proxy.pac
`;
const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : 10.0.0.0/8
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : proxy.example.com
  HTTPSEnable : 1
  HTTPSPort : 3129
  HTTPSProxy : proxy.example.com
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPPort : 9999
      HTTPProxy : scoped.example
    }
  }
}`;
const GSET_MANUAL = `org.gnome.system.proxy autoconfig-url ''
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '::1', '*.lan', '.home.arpa']
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy use-same-proxy true
org.gnome.system.proxy.ftp host ''
org.gnome.system.proxy.ftp port 0
org.gnome.system.proxy.http authentication-password ''
org.gnome.system.proxy.http authentication-user ''
org.gnome.system.proxy.http enabled false
org.gnome.system.proxy.http host 'web.lan'
org.gnome.system.proxy.http port 3128
org.gnome.system.proxy.http use-authentication false
org.gnome.system.proxy.https host 'web.lan'
org.gnome.system.proxy.https port 3128
org.gnome.system.proxy.socks host 'socks.lan'
org.gnome.system.proxy.socks port 1080`;
const GSET_AUTO = GSET_MANUAL.replace("mode 'manual'", "mode 'auto'").replace("autoconfig-url ''", "autoconfig-url 'http://pac.lan/wpad.dat'");
const GSET_NONE = GSET_MANUAL.replace("mode 'manual'", "mode 'none'");

await test("OS proxy settings parsers (documented output formats — sample text written for the tests, NOT captured from real Windows/macOS/GNOME machines): Windows reg query (one server for all, per-protocol 'http=…;https=…;socks=…', disabled manual + AutoConfigURL), macOS scutil --proxy (scoped per-interface dictionaries ignored), GNOME gsettings (manual / auto / none); 8 malformed inputs give nothing; the exception lists (<local>, globs, .suffix, CIDR incl. macOS '169.254/16'); OS settings → the route per URL", { "WP-12": "full" }, async () => {
  const w1 = OS.parseRegQuery(REG_SINGLE)!;
  eq([w1.http, w1.https, w1.socks, w1.pacUrl, w1.bypassSimple, w1.bypass], ["proxy.corp.example:8080", "proxy.corp.example:8080", null, null, true, ["*.corp.example", "10.*", "192.168.1.*"]]);
  const w2 = OS.parseRegQuery(REG_PER_PROTOCOL)!;
  eq([w2.http, w2.https, w2.socks, w2.bypassSimple], ["web.corp:3128", "secure.corp:8443", "socks.corp:1080", false]);
  const w3 = OS.parseRegQuery(REG_PAC_ONLY)!;
  eq([w3.http, w3.https, w3.pacUrl], [null, null, "http://wpad.corp.example/proxy.pac"], "disabled manual proxy is not used; the PAC URL is");
  const m = OS.parseScutil(SCUTIL)!;
  eq([m.http, m.https, m.socks, m.pacUrl, m.bypassSimple, m.bypass], ["proxy.example.com:3128", "proxy.example.com:3129", null, null, true, ["*.local", "169.254/16", "10.0.0.0/8"]]);
  const mPac = OS.parseScutil(SCUTIL.replace("ProxyAutoConfigEnable : 0", "ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://pac.example.com/p.pac").replace(/HTTPS?Enable : 1/g, "HTTPEnable : 0"))!;
  eq([mPac.pacUrl, mPac.http], ["http://pac.example.com/p.pac", null]);
  const g = OS.parseGsettings(GSET_MANUAL)!;
  eq([g.http, g.https, g.socks, g.pacUrl, g.bypass], ["web.lan:3128", "web.lan:3128", "socks.lan:1080", null, ["localhost", "127.0.0.0/8", "::1", "*.lan", ".home.arpa"]]);
  eq(OS.parseGsettings(GSET_AUTO)?.pacUrl, "http://pac.lan/wpad.dat");
  eq(OS.parseGsettings(GSET_NONE), null);
  const malformed = [
    OS.parseRegQuery(""), OS.parseRegQuery(REG_SINGLE.replace("0x1", "0x0")), OS.parseRegQuery(REG_SINGLE.replace("proxy.corp.example:8080", "proxy:99999")),
    OS.parseScutil("garbage"), OS.parseScutil(SCUTIL.replace(/Enable : 1/g, "Enable : 0")), OS.parseScutil(SCUTIL.replace(/HTTPS?Port : \d+/g, "HTTPPort : 0").replace(/HTTPSEnable : 1/, "HTTPSEnable : 0")),
    OS.parseGsettings("org.gnome.system.proxy mode 'manual'"), OS.parseGsettings(GSET_MANUAL.replace(/host '[^']*'/g, "host 'bad host!'")),
  ];
  eq(malformed, [null, null, null, null, null, null, null, null], "malformed inputs");
  const bp = (o: { bypass: string[]; bypassSimple: boolean }, h: string) => OS.osBypassMatch(o, h);
  eq(["intranet", "a.corp.example", "10.9.8.7", "192.168.1.40", "192.168.2.1", "www.example.org", "corp.example"].map((h) => bp(w1, h)), [true, true, true, true, false, false, false], "windows");
  eq(["printer.local", "169.254.3.4", "169.255.0.1", "10.200.0.1", "host", "example.com"].map((h) => bp(m, h)), [true, true, false, true, true, false], "macOS");
  eq(["localhost", "127.8.8.8", "::1", "nas.lan", "home.arpa", "tv.home.arpa", "lan.example"].map((h) => bp(g, h)), [true, true, true, true, true, true, false], "GNOME");
  const sp = SP.systemProxyFromOs(w2);
  const route = (u: string) => { const r = SP.systemRouteFor(sp, new URL(u)); return r === "direct" || r === null ? "direct" : `${r.mode}://${r.host}:${r.port}`; };
  eq([route("https://a.example/"), route("http://a.example/"), route("wss://a.example/")], ["http://secure.corp:8443", "http://web.corp:3128", "http://secure.corp:8443"]);
  const sp1 = SP.systemProxyFromOs(w1);
  eq([SP.systemRouteFor(sp1, new URL("http://intranet/")), SP.systemRouteFor(sp1, new URL("https://x.corp.example/"))], ["direct", "direct"], "exceptions go direct");
  const onlySocks = SP.systemProxyFromOs({ ...g, http: null, https: null, bypass: [] });
  const s2 = SP.systemRouteFor(onlySocks, new URL("https://a.example/"));
  eq(s2 !== "direct" && s2 ? [s2.mode, s2.host, s2.port] : s2, ["socks5", "socks.lan", 1080], "only SOCKS → SOCKS for everything");
  // the reader: the right tool per platform; a missing tool is "no settings", not an error
  const calls: string[] = [];
  const fake = (out: string) => (cmd: string, args: string[]) => { calls.push(`${cmd} ${args.join(" ")}`); return out; };
  eq(OS.readOsProxy("win32", fake(REG_SINGLE)).proxy?.http, "proxy.corp.example:8080");
  eq(OS.readOsProxy("darwin", fake(SCUTIL)).proxy?.https, "proxy.example.com:3129");
  eq(OS.readOsProxy("linux", fake(GSET_AUTO)).proxy?.pacUrl, "http://pac.lan/wpad.dat");
  // TT40 (WP-15): Windows also reads the "Automatically detect settings" flag from DefaultConnectionSettings
  eq(calls, ["reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections /v DefaultConnectionSettings", "scutil --proxy", "gsettings list-recursively org.gnome.system.proxy"]);
  eq(OS.readOsProxy("linux", () => { throw Object.assign(new Error("spawn gsettings ENOENT"), { code: "ENOENT" }); }), { proxy: null, error: null });
  const real = OS.readOsProxy();
  console.log(`     this computer (${process.platform}): ${JSON.stringify(real)}`);
});

// ===================================================================================== live
await test("PAC live (WP-12): a fresh server process with FUSION_WP_PAC_URL fetches the PAC file ONCE over HTTP from the local network and follows it per request — https://pypi.org/ through the PROXY it names (an independent proxy, pproxy, logs the name), github.com DIRECT even though its PATH contains the PAC's trigger word (https paths are hidden from the script), a host whose entries are all unusable (QUIC; HTTPS / SOCKS4 became usable in TT40) is REFUSED, never sent direct; an unreachable PAC file → DIRECT with the error reported; https_proxy in the environment takes precedence over the PAC file", { "WP-12": "full" }, async () => {
  const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
  const pacSrc = `function FindProxyForURL(url, host) {
    if (url.indexOf("trigger") >= 0) return "PROXY 127.0.0.1:1";
    if (host == "pypi.org") return "PROXY 127.0.0.1:18391; DIRECT";
    if (dnsDomainIs(host, "pythonhosted.org")) return "QUIC 127.0.0.1:1; QUIC 127.0.0.1:2"; /* TT40: HTTPS / SOCKS4 entries are spoken now (tt40-proxy); QUIC stays unusable */
    return "DIRECT"; }`;
  let pacHits = 0;
  const pacServer = http.createServer((req, res) => { pacHits++; res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" }); res.end(pacSrc); });
  await new Promise<void>((r) => pacServer.listen(41851, "127.0.0.2", r));
  const pp = spawn(PPROXY, ["-l", "http://127.0.0.1:18391", "-v"], { stdio: ["ignore", "pipe", "pipe"] });
  let ppLog = ""; pp.stdout!.on("data", (d) => { ppLog += d; }); pp.stderr!.on("data", (d) => { ppLog += d; });
  await sleep(1200);
  const probe = async (env: Record<string, string>, urls: string[]) => {
    const { stdout } = await run(process.execPath, [...NODE_TS, "scripts/fixtures/ws/sysproxy-probe.mts"], { env: { PATH: process.env.PATH ?? "", FUSION_WP_OS_PROXY: "0", ...env, PROBE_URLS: urls.join(" ") }, timeout: 60000 });
    return JSON.parse(stdout.trim().split("\n").pop()!);
  };
  try {
    const j = await probe({ FUSION_WP_PAC_URL: "http://127.0.0.2:41851/proxy.pac" }, ["https://pypi.org/", "https://github.com/trigger-word-in-path?trigger=1", "https://files.pythonhosted.org/"]);
    const py = j["https://pypi.org/"], gh = j["https://github.com/trigger-word-in-path?trigger=1"], fh = j["https://files.pythonhosted.org/"];
    ok(j.system.active === true && j.system.pac?.url === "http://127.0.0.2:41851/proxy.pac", `PAC active: ${JSON.stringify(j.system)}`);
    ok(py.status === 200 && py.bytes > 1000, `pypi through the PAC's proxy: ${JSON.stringify(py)}`);
    ok(/pypi\.org/.test(ppLog), `pproxy carried pypi.org: ${ppLog.slice(0, 300)}`);
    ok(typeof gh.status === "number" && !/github/.test(ppLog), `github direct despite the path: ${JSON.stringify(gh)}`);
    ok(/chose only proxies Fusion cannot use/.test(String(fh.error)) && !/pythonhosted/.test(ppLog), `all-unusable refused: ${JSON.stringify(fh)}`);
    eq(pacHits, 1, "the PAC file was fetched once");
    ok(j.systemAfter.pac.loaded === true && j.systemAfter.pac.last?.chosen === "refused", `last decision: ${JSON.stringify(j.systemAfter.pac)}`);
    const dead = await probe({ FUSION_WP_PAC_URL: "http://127.0.0.2:41859/none.pac" }, ["https://pypi.org/"]);
    ok(dead["https://pypi.org/"].status === 200 && /ECONNREFUSED|refused/i.test(String(dead.systemAfter.pac.error)), `unreachable PAC → direct + error: ${JSON.stringify(dead.systemAfter.pac)} ${JSON.stringify(dead["https://pypi.org/"])}`);
    const both = await probe({ FUSION_WP_PAC_URL: "http://127.0.0.2:41851/proxy.pac", https_proxy: "http://127.0.0.1:18391" }, []);
    ok(both.system.pac === null && both.system.source.includes("https_proxy"), `env proxy wins: ${JSON.stringify(both.system)}`);
    console.log(`     pypi.org ${py.status} via the PAC's proxy (${py.bytes} B); github.com ${gh.status} direct; pythonhosted: ${fh.error}; unreachable PAC: ${dead.systemAfter.pac.error}`);
  } finally { pp.kill(); pacServer.close(); }
});

await test("OS settings live (WP-12): a fresh server process with NO proxy variables reads the system proxy page through the platform tool — here a stand-in `gsettings` executable on PATH that prints GNOME's documented output (this sandbox has no GNOME) naming pproxy as the HTTPS proxy and 127.0.0.0/8 as an exception — and https://pypi.org/ is carried by pproxy while FUSION_WP_OS_PROXY=0 turns the reading off", { "WP-12": "partial" }, async () => {
  const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
  const dir = mkdtempSync(join(tmpdir(), "tt39-gs-"));
  const out = GSET_MANUAL.replace(/https host '[^']*'/, "https host '127.0.0.1'").replace(/https port \d+/, "https port 18392");
  writeFileSync(join(dir, "gsettings"), `#!/bin/sh\n[ "$1" = "list-recursively" ] && [ "$2" = "org.gnome.system.proxy" ] || exit 1\ncat <<'EOF'\n${out}\nEOF\n`);
  chmodSync(join(dir, "gsettings"), 0o755);
  const pp = spawn(PPROXY, ["-l", "http://127.0.0.1:18392", "-v"], { stdio: ["ignore", "pipe", "pipe"] });
  let ppLog = ""; pp.stdout!.on("data", (d) => { ppLog += d; }); pp.stderr!.on("data", (d) => { ppLog += d; });
  await sleep(1200);
  try {
    const go = async (extra: Record<string, string>) => JSON.parse((await run(process.execPath, [...NODE_TS, "scripts/fixtures/ws/sysproxy-probe.mts"], { env: { PATH: `${dir}:${process.env.PATH ?? ""}`, PROBE_URLS: "https://pypi.org/", ...extra }, timeout: 60000 })).stdout.trim().split("\n").pop()!);
    const j = await go({});
    ok(j.system.active === true && j.system.source[0] === "gnome-gsettings", `OS settings active: ${JSON.stringify(j.system)}`);
    ok(j["https://pypi.org/"].status === 200 && /pypi\.org/.test(ppLog), `pypi via the OS proxy: ${JSON.stringify(j["https://pypi.org/"])} ${ppLog.slice(0, 200)}`);
    const before = ppLog.length;
    const off = await go({ FUSION_WP_OS_PROXY: "0" });
    ok(off.system.available === false || off.system.active === false, `off: ${JSON.stringify(off.system)}`);
    ok(off["https://pypi.org/"].status === 200 && ppLog.length === before, "with the reading off pypi goes direct");
    console.log(`     route ${j.route} from ${j.system.source[0]}; pypi.org ${j["https://pypi.org/"].status} through pproxy`);
  } finally { pp.kill(); }
});

await finish();
process.exit(0);
