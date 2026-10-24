/**
 * TT40 live proxy tests — fresh server-module processes (scripts/fixtures/ws/sysproxy-probe.mts) that pick their route
 * up exactly as at a real computer's start, talking to INDEPENDENT proxies (pproxy 2.7.9, MIT) and the real pypi.org:
 *  WP-14  SOCKS4 (names resolved locally through the public-address guard, IPv4 on the wire) and an HTTPS proxy (TLS to
 *         the proxy verified against a CA the computer trusts) live; PAC failover live — a dead proxy first, the next
 *         entry carries the request, the dead one is remembered; a POST survives failover byte-exact and the dead
 *         proxy never saw a byte of it; a proxy that refuses the destination (403) is NOT failed over (no direct leak)
 *  WP-15  WPAD live with the machine's REAL resolver: a search domain in /etc/resolv.conf, names in /etc/hosts, a PAC
 *         file served on port 80 — discovered by devolution (wpad → wpad.eng.… → wpad.corp.…) from GNOME "auto" with
 *         no URL (stand-in gsettings, this sandbox has no GNOME) and from KDE ProxyType=3; KDE manual settings live
 * Needs passwordless sudo for /etc/hosts, /etc/resolv.conf and port 80 (all restored); skips WPAD honestly without it.
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt40-proxy.mts
 */
import * as http from "node:http";
import * as net from "node:net";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("tt40-proxy");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
const NODE_TS = ["--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"];
const P_S4 = 18411, P_HS = 18412, P_KDE = 18413, P_ECHO = 41871, P_PAC = 41872;
const DIR = mkdtempSync(join(tmpdir(), "tt40-proxy-"));
const EMPTY_PATH = mkdtempSync(join(tmpdir(), "tt40-path-")); // a PATH with no gsettings (KDE / env tests)

type Probe = Record<string, unknown> & { results: { url: string; status?: number; via?: string; error?: string; text?: string; ms: number }[]; system: Record<string, unknown>; systemAfter: { pac?: Record<string, unknown> | null; failover?: { recent: { from: string; to: string | null }[] } } };
async function probe(env: Record<string, string>, urls: string[]): Promise<Probe> {
  const { stdout } = await run(process.execPath, [...NODE_TS, "scripts/fixtures/ws/sysproxy-probe.mts"], { env: { PATH: process.env.PATH ?? "", FUSION_WP_OS_PROXY: "0", ...env, PROBE_URLS: urls.join(" ") }, timeout: 90000 });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}
function pproxy(args: string[]): { proc: ChildProcess; log: () => string } {
  const proc = spawn(PPROXY, [...args, "-v"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; proc.stdout!.on("data", (d) => { log += d; }); proc.stderr!.on("data", (d) => { log += d; });
  return { proc, log: () => log };
}

// --- shared fixtures: a test CA + a proxy certificate for 127.0.0.1, pproxy servers, an echo site
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(DIR, "ca.key"), "-out", join(DIR, "ca.pem"), "-days", "1", "-subj", "/CN=Fusion TT40 test CA"], { stdio: "ignore" });
execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(DIR, "px.key"), "-out", join(DIR, "px.csr"), "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
writeFileSync(join(DIR, "ext"), "subjectAltName=IP:127.0.0.1\n");
execFileSync("openssl", ["x509", "-req", "-in", join(DIR, "px.csr"), "-CA", join(DIR, "ca.pem"), "-CAkey", join(DIR, "ca.key"), "-CAcreateserial", "-out", join(DIR, "px.pem"), "-days", "1", "-extfile", join(DIR, "ext")], { stdio: "ignore" });
const S4 = pproxy(["-l", `socks4://127.0.0.1:${P_S4}`]);
const HS = pproxy(["-l", `http+ssl://127.0.0.1:${P_HS}`, "--ssl", `${join(DIR, "px.pem")},${join(DIR, "px.key")}`]);
const KP = pproxy(["-l", `http://127.0.0.1:${P_KDE}`]);
const echo = http.createServer((req, res) => {
  const parts: Buffer[] = []; req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => { const b = Buffer.concat(parts); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ method: req.method, len: b.length, sha: createHash("sha256").update(b).digest("hex") })); });
});
await new Promise<void>((r) => echo.listen(P_ECHO, "127.0.0.1", r));
await sleep(1200);

try {
  await test("SOCKS4 + HTTPS proxy live (WP-14): https://pypi.org/ through pproxy's SOCKS4 server (it logs an IPv4 address — the NAME never reached the proxy, it was resolved here through the guard) and through pproxy as an HTTPS proxy (TLS to the proxy verified against a CA in NODE_EXTRA_CA_CERTS, pypi.org named only inside that TLS); without that CA the proxy is refused at TLS and never learns the destination", { "WP-14": "full" }, async () => {
    const a = await probe({ FUSION_WP_UPSTREAM: `socks4://127.0.0.1:${P_S4}` }, ["https://pypi.org/"]);
    const s4 = a.results[0];
    ok(s4.status === 200 && s4.via === `via SOCKS4 127.0.0.1:${P_S4}`, `socks4: ${JSON.stringify(s4)}`);
    const line = S4.log().split("\n").find((l) => /->/.test(l)) ?? "";
    ok(/-> \d+\.\d+\.\d+\.\d+:443/.test(line) && !/pypi/.test(S4.log()), `pproxy saw an IPv4 only: ${S4.log().slice(0, 300)}`);
    const b = await probe({ FUSION_WP_UPSTREAM: `https://127.0.0.1:${P_HS}`, NODE_EXTRA_CA_CERTS: join(DIR, "ca.pem") }, ["https://pypi.org/"]);
    ok(b.results[0].status === 200 && b.results[0].via === `via HTTPS proxy 127.0.0.1:${P_HS}`, `https proxy: ${JSON.stringify(b.results[0])}`);
    ok(/pypi\.org:443/.test(HS.log()), `pproxy (TLS) carried pypi.org: ${HS.log().slice(0, 300)}`);
    const before = (HS.log().match(/pypi\.org/g) ?? []).length;
    const c = await probe({ FUSION_WP_UPSTREAM: `https://127.0.0.1:${P_HS}` }, ["https://pypi.org/"]);
    ok(/TLS failed/.test(String(c.results[0].error)) && (HS.log().match(/pypi\.org/g) ?? []).length === before, `untrusted proxy refused at TLS: ${JSON.stringify(c.results[0])}`);
    console.log(`     SOCKS4 ${s4.status} (${line.trim()}); HTTPS proxy ${b.results[0].status}; untrusted: ${c.results[0].error}`);
  });

  await test("PAC failover live (WP-14): \"PROXY <dead>; SOCKS <pproxy>; DIRECT\" — pypi.org is carried by the SECOND entry (SOCKS = v4, Chrome's reading), the failover is recorded, and a repeat request goes straight to the healthy proxy (the dead one is remembered for 5 min, no second failover); a POST of 70 KB of mixed UTF-8 / binary-safe text fails over byte-exact (echo site's SHA-256) and the dead proxy received only the proxy handshake, never a byte of the body; a proxy that ANSWERS 403 for the destination is not failed over — no DIRECT leak", { "WP-14": "full" }, async () => {
    // a "dead" proxy: accepts, records what it gets, hangs up — the proxy itself is broken
    let deadGot = Buffer.alloc(0);
    const dead = net.createServer((s) => { s.on("data", (d: Buffer) => { deadGot = Buffer.concat([deadGot, d]); s.destroy(); }); s.on("error", () => {}); });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const forbid = net.createServer((s) => { s.on("error", () => {}); s.once("data", () => s.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")); });
    await new Promise<void>((r) => forbid.listen(0, "127.0.0.1", r));
    const dp = (dead.address() as net.AddressInfo).port, fp = (forbid.address() as net.AddressInfo).port;
    const pacSrc = `function FindProxyForURL(url, host) {
      if (host == "pypi.org") return "PROXY 127.0.0.1:1; SOCKS 127.0.0.1:${P_S4}; DIRECT";
      if (host == "127.0.0.1") return "PROXY 127.0.0.1:${dp}; SOCKS4 127.0.0.1:${P_S4}";
      if (host == "files.pythonhosted.org") return "PROXY 127.0.0.1:${fp}; DIRECT";
      return "DIRECT"; }`;
    const pacSrv = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" }); res.end(pacSrc); });
    await new Promise<void>((r) => pacSrv.listen(P_PAC, "127.0.0.2", r));
    const PAC_ENV = { FUSION_WP_PAC_URL: `http://127.0.0.2:${P_PAC}/p.pac`, FUSION_WP_TEST_LOOPBACK_PORTS: String(P_ECHO) };
    try {
      const a = await probe(PAC_ENV, ["https://pypi.org/", "https://pypi.org/"]);
      const [r1, r2] = a.results;
      ok(r1.status === 200 && r1.via === `via SOCKS4 127.0.0.1:${P_S4}`, `first: ${JSON.stringify(r1)}`);
      ok(r2.status === 200 && r2.via === r1.via, `second: ${JSON.stringify(r2)}`);
      const rec = a.systemAfter.failover!.recent;
      eq(rec.length, 1, `one failover only: ${JSON.stringify(rec)}`);
      eq([rec[0].from, rec[0].to], ["HTTP proxy 127.0.0.1:1", `SOCKS4 127.0.0.1:${P_S4}`]);
      // POST through failover
      const body = ("Grüße, 世界 — façade ✓ " + "0123456789abcdef".repeat(4)).repeat(800);
      const want = createHash("sha256").update(Buffer.from(body)).digest("hex");
      const p = await probe({ ...PAC_ENV, PROBE_METHOD: "POST", PROBE_BODY: body, PROBE_ECHO: "1" }, [`http://127.0.0.1:${P_ECHO}/echo`]);
      const e = JSON.parse(p.results[0].text ?? "{}");
      eq([p.results[0].status, e.method, e.len, e.sha], [200, "POST", Buffer.byteLength(body), want], `POST: ${JSON.stringify(p.results[0]).slice(0, 300)}`);
      const seen = deadGot.toString("latin1");
      ok(/^CONNECT 127\.0\.0\.1:41871 HTTP\/1\.1/.test(seen) && !seen.includes("façade".slice(0, 3)) && !seen.includes("0123456789abcdef"), `dead proxy saw only the handshake: ${JSON.stringify(seen.slice(0, 200))}`);
      // answered refusal: no failover, no direct
      const f = await probe(PAC_ENV, ["https://files.pythonhosted.org/"]);
      ok(/refused the tunnel \(403\)/.test(String(f.results[0].error)) && f.results[0].status === undefined, `403 not failed over: ${JSON.stringify(f.results[0])}`);
      eq(f.systemAfter.failover!.recent.length, 0, "no failover recorded for an answered refusal");
      console.log(`     pypi ${r1.status} via ${r1.via} after failover (${r1.ms} ms), repeat ${r2.ms} ms; POST ${e.len} B sha ok; 403: ${f.results[0].error}`);
    } finally { dead.close(); forbid.close(); pacSrv.close(); }
  });

  await test("KDE live (WP-15): a fresh process in a KDE session (XDG_CURRENT_DESKTOP=KDE), with no proxy variables and no gsettings, reads ~/.config/kioslaverc (here via XDG_CONFIG_HOME) written in KDE 5's \"http://host port\" form and sends https://pypi.org/ through the proxy it names (pproxy logs it); ProxyType=0 means direct", { "WP-15": "full" }, async () => {
    const cfg = mkdtempSync(join(tmpdir(), "tt40-kde-"));
    writeFileSync(join(cfg, "kioslaverc"), `[Proxy Settings]\nProxyType=1\nhttpsProxy=http://127.0.0.1 ${P_KDE}\nNoProxyFor=localhost\n`);
    const a = await probe({ FUSION_WP_OS_PROXY: "1", PATH: EMPTY_PATH, XDG_CURRENT_DESKTOP: "KDE", XDG_CONFIG_HOME: cfg }, ["https://pypi.org/"]);
    ok(a.results[0].status === 200 && a.results[0].via === `via HTTP proxy 127.0.0.1:${P_KDE}` && /pypi\.org/.test(KP.log()), `KDE manual: ${JSON.stringify(a.results[0])} ${JSON.stringify(a.system)}`);
    ok((a.system.source as string[]).includes("kde-kioslaverc"), `source: ${JSON.stringify(a.system)}`);
    writeFileSync(join(cfg, "kioslaverc"), `[Proxy Settings]\nProxyType=0\nhttpsProxy=http://127.0.0.1 ${P_KDE}\n`);
    const n = (KP.log().match(/pypi/g) ?? []).length;
    const b = await probe({ FUSION_WP_OS_PROXY: "1", PATH: EMPTY_PATH, XDG_CURRENT_DESKTOP: "KDE", XDG_CONFIG_HOME: cfg }, ["https://pypi.org/"]);
    ok(b.results[0].status === 200 && (KP.log().match(/pypi/g) ?? []).length === n && b.route === "direct", `ProxyType=0 direct: ${JSON.stringify(b.results[0])}`);
  });

  const sudoOk = (() => { try { execFileSync("sudo", ["-n", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();
  await test(`WPAD live (WP-15): the machine's REAL resolver — "search eng.corp.fusion-test.example" in /etc/resolv.conf, wpad.corp.fusion-test.example in /etc/hosts, the PAC file on port 80 — GNOME "auto" with an empty URL (stand-in gsettings) and KDE ProxyType=3 each DISCOVER it by devolution (wpad → wpad.eng.… fail, wpad.corp.… answers; wpad.fusion-test.example is never needed) and pypi.org goes through the SOCKS proxy it names; with nothing to discover, auto-detect falls back to DIRECT with the tried list reported${sudoOk ? "" : " [SKIPPED: no passwordless sudo]"}`, { "WP-15": sudoOk ? "full" : "partial" }, async () => {
    if (!sudoOk) { console.log("     no passwordless sudo — WPAD live not run (unit coverage only)"); return; }
    const BK = "/tmp/tt40-etc-backup";
    const sh = (cmd: string) => execFileSync("sudo", ["-n", "sh", "-c", cmd], { stdio: "pipe" }).toString();
    // a crashed earlier run may have left its changes: restore first
    if (existsSync(`${BK}.hosts`)) sh(`cat ${BK}.hosts > /etc/hosts && cat ${BK}.resolv > /etc/resolv.conf && rm -f ${BK}.hosts ${BK}.resolv`);
    sh(`cp /etc/hosts ${BK}.hosts && cp /etc/resolv.conf ${BK}.resolv`);
    const web = mkdtempSync(join(tmpdir(), "tt40-wpad-"));
    writeFileSync(join(web, "wpad.dat"), `function FindProxyForURL(url, host) { if (host == "pypi.org") return "SOCKS 127.0.0.1:${P_S4}"; return "DIRECT"; }`);
    chmodSync(web, 0o755);
    const srv = spawn("sudo", ["-n", process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python", "-m", "http.server", "80", "--bind", "127.0.0.1", "--directory", web], { stdio: ["ignore", "pipe", "pipe"] });
    let srvLog = ""; srv.stderr!.on("data", (d) => { srvLog += d; }); srv.stdout!.on("data", (d) => { srvLog += d; });
    try {
      sh(`printf '\\n127.0.0.1 wpad.corp.fusion-test.example\\n' >> /etc/hosts && printf '\\nsearch eng.corp.fusion-test.example\\n' >> /etc/resolv.conf`);
      await sleep(1500);
      const gdir = mkdtempSync(join(tmpdir(), "tt40-gs-"));
      writeFileSync(join(gdir, "gsettings"), `#!/bin/sh\n[ "$1" = "list-recursively" ] || exit 1\nprintf "org.gnome.system.proxy mode 'auto'\\norg.gnome.system.proxy autoconfig-url ''\\n"\n`);
      chmodSync(join(gdir, "gsettings"), 0o755);
      const g = await probe({ FUSION_WP_OS_PROXY: "1", PATH: gdir }, ["https://pypi.org/"]);
      const pac = g.systemAfter.pac as { url: string; discovered: string; tried: string[] };
      ok(g.results[0].status === 200 && g.results[0].via === `via SOCKS4 127.0.0.1:${P_S4}`, `GNOME auto → WPAD → SOCKS: ${JSON.stringify(g.results[0])} ${JSON.stringify(pac)}`);
      eq([pac.url, pac.discovered], ["wpad:auto", "http://wpad.corp.fusion-test.example/wpad.dat"]);
      eq(pac.tried, ["http://wpad/wpad.dat", "http://wpad.eng.corp.fusion-test.example/wpad.dat", "http://wpad.corp.fusion-test.example/wpad.dat"]);
      ok(/GET \/wpad\.dat/.test(srvLog), `port-80 server served it: ${srvLog.slice(0, 200)}`);
      const cfg = mkdtempSync(join(tmpdir(), "tt40-kde3-"));
      writeFileSync(join(cfg, "kioslaverc"), "[Proxy Settings]\nProxyType=3\n");
      const k = await probe({ FUSION_WP_OS_PROXY: "1", PATH: EMPTY_PATH, XDG_CURRENT_DESKTOP: "KDE", XDG_CONFIG_HOME: cfg }, ["https://pypi.org/"]);
      ok(k.results[0].status === 200 && k.results[0].via === `via SOCKS4 127.0.0.1:${P_S4}` && (k.systemAfter.pac as { discovered: string }).discovered === pac.discovered, `KDE type 3: ${JSON.stringify(k.results[0])}`);
      // nothing to discover: hosts entry removed → every candidate fails → DIRECT, tried list reported
      sh(`cat ${BK}.hosts > /etc/hosts`);
      await sleep(300);
      const n = await probe({ FUSION_WP_OS_PROXY: "1", PATH: gdir }, ["https://pypi.org/"]);
      const np = n.systemAfter.pac as { error: string; tried: string[] };
      ok(n.results[0].status === 200 && !n.results[0].via?.startsWith("via ") && /no PAC file found/.test(np.error) && np.tried.length === 4, `nothing found → direct: ${JSON.stringify(n.results[0])} ${JSON.stringify(np)}`);
      console.log(`     discovered ${pac.discovered} after ${pac.tried.length} candidates; GNOME + KDE → ${g.results[0].via}; none found → direct (${np.tried.length} tried)`);
    } finally {
      try { execFileSync("sudo", ["-n", "kill", String(srv.pid)], { stdio: "ignore" }); } catch { /* gone */ }
      sh(`cat ${BK}.hosts > /etc/hosts && cat ${BK}.resolv > /etc/resolv.conf && rm -f ${BK}.hosts ${BK}.resolv`);
      ok(!readFileSync("/etc/hosts", "utf8").includes("fusion-test") && !readFileSync("/etc/resolv.conf", "utf8").includes("fusion-test"), "system files restored");
    }
  });
} finally {
  for (const p of [S4, HS, KP]) p.proc.kill();
  echo.close();
}

await finish();
process.exit(0);
