/**
 * TT42 live proxy tests — fresh server-module processes that pick their route up from a PAC file exactly as at a real
 * computer's start, talking to INDEPENDENT software: pproxy 2.7.9 (MIT) as the live proxies, Python websockets 13.1
 * (BSD-3) as the WebSocket echo site, asyncssh (EPL-2.0 / GPL-2.0+, TEST-ONLY, never shipped) as an SSH server whose
 * client side provides a SOCKS 4/4a/5 listener.
 *  WP-14  WebSocket FAILOVER live: "PROXY <dead>; PROXY <pproxy http>" for ws:// and "PROXY <dead>; SOCKS5 <pproxy>"
 *         for wss:// (real TLS to the echo site) — the bridge proxied pages use opens through the SECOND entry, text +
 *         binary messages echo byte-exact, the failover is recorded, the dead proxy saw only the proxy handshake.
 *  WP-14  SOCKS4a live: "SOCKS4A <asyncssh forward_socks>" — the NAME travels to the proxy (SOCKS4a), which resolves it.
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt42-proxy.mts
 */
import * as http from "node:http";
import * as net from "node:net";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("tt42-proxy");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
const NODE_TS = ["--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"];
const P_WS = 42871, P_WSS = 42872, P_HTTPPX = 42873, P_S5 = 42874, P_PAC = 42875, P_SSH = 42876, P_S4A = 42877, P_TEE = 42878;
const DIR = mkdtempSync(join(tmpdir(), "tt42-proxy-"));
const procs: ChildProcess[] = [];

function spawnLogged(cmd: string, args: string[], env: Record<string, string> = {}): { proc: ChildProcess; log: () => string } {
  const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  procs.push(proc);
  let log = ""; proc.stdout!.on("data", (d) => { log += d; }); proc.stderr!.on("data", (d) => { log += d; });
  return { proc, log: () => log };
}
async function waitPort(port: number, host = "127.0.0.1", ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const up = await new Promise<boolean>((r) => { const s = net.connect(port, host, () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (up) return; await sleep(150);
  }
  throw new Error(`port ${host}:${port} never opened`);
}
type WsProbe = { open?: { protocol: string; ms: number }; echoes: string[]; close?: { code: number; reason: string; wasClean: boolean; error?: string }; systemAfter: { failover?: { recent: { from: string; to: string | null; error?: string }[] } } };
async function wsProbe(env: Record<string, string>, url: string, msgs: string[]): Promise<WsProbe> {
  const { stdout } = await run(process.execPath, [...NODE_TS, "scripts/fixtures/ws/ws-failover-probe.mts"], { env: { PATH: process.env.PATH ?? "", FUSION_WP_OS_PROXY: "0", ...env, PROBE_WS: url, PROBE_MSGS: msgs.join("|") }, timeout: 60000 });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

// --- fixtures: test CA + a certificate for 127.0.0.1 (the wss echo site)
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(DIR, "ca.key"), "-out", join(DIR, "ca.pem"), "-days", "1", "-subj", "/CN=Fusion TT42 test CA"], { stdio: "ignore" });
execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(DIR, "s.key"), "-out", join(DIR, "s.csr"), "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
writeFileSync(join(DIR, "ext"), "subjectAltName=IP:127.0.0.1\n");
execFileSync("openssl", ["x509", "-req", "-in", join(DIR, "s.csr"), "-CA", join(DIR, "ca.pem"), "-CAkey", join(DIR, "ca.key"), "-CAcreateserial", "-out", join(DIR, "s.pem"), "-days", "1", "-extfile", join(DIR, "ext")], { stdio: "ignore" });
// the echo site: Python websockets, independent of our client; records each handshake's path + subprotocol
const ECHO_PY = `
import asyncio, ssl, sys, websockets
async def echo(ws):
    print("HANDSHAKE", getattr(ws, "path", None) or ws.request.path, ws.subprotocol, flush=True)
    async for m in ws:
        await ws.send(m)
async def main():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[3], sys.argv[4])
    async with websockets.serve(echo, "127.0.0.1", int(sys.argv[1]), subprotocols=["chat"]), websockets.serve(echo, "127.0.0.1", int(sys.argv[2]), ssl=ctx, subprotocols=["chat"]):
        print("READY", flush=True); await asyncio.Future()
asyncio.run(main())
`;
writeFileSync(join(DIR, "echo.py"), ECHO_PY);
const ECHO = spawnLogged(PY, [join(DIR, "echo.py"), String(P_WS), String(P_WSS), join(DIR, "s.pem"), join(DIR, "s.key")]);
const HPX = spawnLogged(PPROXY, ["-l", `http://127.0.0.1:${P_HTTPPX}`, "-v"]);
const S5 = spawnLogged(PPROXY, ["-l", `socks5://127.0.0.1:${P_S5}`, "-v"]);
const SSH = spawnLogged(PY, ["scripts/fixtures/ssh-socks.py", String(P_SSH), String(P_S4A)]);
// a byte tee in front of the asyncssh SOCKS listener: records exactly what our client put on the wire
let teeBytes: Buffer[] = [];
const tee = net.createServer((c) => {
  const up = net.connect(P_S4A, "127.0.0.1"); let first = true;
  c.on("data", (d: Buffer) => { if (first) { teeBytes.push(Buffer.from(d)); first = false; } up.write(d); });
  up.on("data", (d) => c.write(d)); c.on("end", () => up.end()); up.on("end", () => c.end());
  c.on("error", () => up.destroy()); up.on("error", () => c.destroy());
});
await new Promise<void>((r) => tee.listen(P_TEE, "127.0.0.1", r));
type HttpProbe = { results: { url: string; status?: number; via?: string; error?: string; ms: number }[] };
async function httpProbe(env: Record<string, string>, urls: string[]): Promise<HttpProbe> {
  const { stdout } = await run(process.execPath, [...NODE_TS, "scripts/fixtures/ws/sysproxy-probe.mts"], { env: { PATH: process.env.PATH ?? "", FUSION_WP_OS_PROXY: "0", ...env, PROBE_URLS: urls.join(" ") }, timeout: 90000 });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

try {
  await Promise.all([waitPort(P_WS), waitPort(P_WSS), waitPort(P_HTTPPX), waitPort(P_S5), waitPort(P_S4A, "127.0.0.1", 30000)]);

  await test("WebSocket failover live (WP-14, TT41 blocker): a fresh process reads a PAC file whose first entry is a DEAD proxy — ws:// is carried by the second entry (pproxy HTTP CONNECT) and wss:// by the second entry (pproxy SOCKS5, real TLS to the echo site verified against the test CA); the bridge proxied pages use gets OPEN with the negotiated subprotocol, 3 text messages (UTF-8) and 1 binary message echo byte-exact from an independent server (Python websockets), a clean 1000 close, one failover recorded per run, and the dead proxy received only the proxy handshake, never a WebSocket byte", { "WP-14": "full" }, async () => {
    const deadGot: string[] = [];
    const dead = net.createServer((s) => { s.on("data", (d: Buffer) => { deadGot.push(d.toString("latin1")); s.destroy(); }); s.on("error", () => {}); });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const dp = (dead.address() as net.AddressInfo).port;
    const pac = `function FindProxyForURL(url, host) {
      if (shExpMatch(url, "https://127.0.0.1:${P_WSS}/*")) return "PROXY 127.0.0.1:${dp}; SOCKS5 127.0.0.1:${P_S5}";
      if (shExpMatch(url, "http://127.0.0.1:${P_WS}/*")) return "PROXY 127.0.0.1:${dp}; PROXY 127.0.0.1:${P_HTTPPX}";
      return "DIRECT"; }`;
    const pacSrv = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" }); res.end(pac); });
    await new Promise<void>((r) => pacSrv.listen(P_PAC, "127.0.0.2", r));
    const env = { FUSION_WP_PAC_URL: `http://127.0.0.2:${P_PAC}/p.pac`, FUSION_WP_TEST_LOOPBACK_PORTS: `${P_WS},${P_WSS}`, NODE_EXTRA_CA_CERTS: join(DIR, "ca.pem") };
    const msgs = ["hello", "Grüße 世界 ✓", "x".repeat(70000)];
    try {
      const rows: string[] = [];
      for (const [url, via, pxLog] of [[`ws://127.0.0.1:${P_WS}/chat?a=1`, `HTTP proxy 127.0.0.1:${P_HTTPPX}`, HPX], [`wss://127.0.0.1:${P_WSS}/secure`, `SOCKS5 127.0.0.1:${P_S5}`, S5]] as const) {
        const before = deadGot.length;
        const p = await wsProbe(env, url, msgs);
        ok(p.open?.protocol === "chat", `${url}: open ${JSON.stringify(p).slice(0, 400)}`);
        const digest = (g: string) => `${g.length}:${createHash("sha256").update(g).digest("hex").slice(0, 16)}`;
        ok(JSON.stringify(p.echoes) === JSON.stringify([...msgs, "bin:000102fdfeff"].map(digest)), `${url}: echoes ${JSON.stringify(p.echoes.map((e) => e.slice(0, 30)))} close ${JSON.stringify(p.close)} failover ${JSON.stringify(p.systemAfter.failover)}`);
        ok(p.close?.code === 1000 && p.close.wasClean, `${url}: close ${JSON.stringify(p.close)}`);
        const rec = p.systemAfter.failover?.recent ?? [];
        ok(rec.length === 1 && rec[0].from === `HTTP proxy 127.0.0.1:${dp}` && rec[0].to === via, `${url}: failover ${JSON.stringify(rec)}`);
        const seen = deadGot.slice(before).join("");
        ok(/^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1/.test(seen) && !/Upgrade: websocket/i.test(seen) && !seen.includes("Grüße"), `dead proxy saw only the handshake: ${JSON.stringify(seen.slice(0, 160))}`);
        ok(pxLog.log().includes(`127.0.0.1:${url.startsWith("wss") ? P_WSS : P_WS}`), `the live proxy carried it: ${pxLog.log().slice(-300)}`);
        rows.push(`${url.slice(0, 5)} via ${rec[0].to} after failover from ${rec[0].from} (open ${p.open?.ms} ms)`);
      }
      ok((ECHO.log().match(/HANDSHAKE \/chat\?a=1 chat/g) ?? []).length === 1 && (ECHO.log().match(/HANDSHAKE \/secure chat/g) ?? []).length === 1, `echo site handshakes: ${ECHO.log()}`);
      console.log(rows.map((r) => "     " + r).join("\n"));
    } finally { dead.close(); pacSrv.close(); }
  });

  await test("SOCKS4a live (WP-14, TT41 blocker): https://pypi.org/ through an INDEPENDENT SOCKS4a server (asyncssh's forward_socks over a real SSH connection to an in-process asyncssh server): the bytes on the wire are a SOCKS4a CONNECT — VN 4, CD 1, port 443, DSTIP 0.0.0.x (x ≠ 0), userid, then the NAME \"pypi.org\" — and the SSH server was asked to dial \"pypi.org\" by name; control: SOCKS4 to the same server puts a public IPv4 address on the wire (resolved locally through the public-address guard) and the SSH server dials that address, never the name", { "WP-14": "full" }, async () => {
    teeBytes = [];
    const a = await httpProbe({ FUSION_WP_UPSTREAM: `socks4a://127.0.0.1:${P_TEE}` }, ["https://pypi.org/"]);
    const r = a.results[0];
    ok(r.status === 200 && r.via === `via SOCKS4a 127.0.0.1:${P_TEE}`, `socks4a: ${JSON.stringify(r)}`);
    const b = teeBytes[0];
    ok(b && b[0] === 4 && b[1] === 1 && b.readUInt16BE(2) === 443 && b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] !== 0, `SOCKS4a header: ${b?.subarray(0, 8).toString("hex")}`);
    const nul = b.indexOf(0, 8), name = b.subarray(nul + 1, b.indexOf(0, nul + 1)).toString("latin1");
    ok(name === "pypi.org", `name on the wire: ${JSON.stringify(name)} (${b.toString("hex")})`);
    ok(/DIRECT-TCPIP pypi\.org 443/.test(SSH.log()), `ssh server dialled the name: ${SSH.log()}`);
    teeBytes = [];
    const before = SSH.log().length;
    const c = await httpProbe({ FUSION_WP_UPSTREAM: `socks4://127.0.0.1:${P_TEE}` }, ["https://pypi.org/"]);
    ok(c.results[0].status === 200 && c.results[0].via === `via SOCKS4 127.0.0.1:${P_TEE}`, `socks4 control: ${JSON.stringify(c.results[0])}`);
    const cb = teeBytes[0], ip = `${cb[4]}.${cb[5]}.${cb[6]}.${cb[7]}`;
    ok(cb[0] === 4 && cb[4] !== 0 && !cb.includes(Buffer.from("pypi.org")), `SOCKS4 carries an address, not the name: ${cb.toString("hex")}`);
    const later = SSH.log().slice(before);
    ok(later.includes(`DIRECT-TCPIP ${ip} 443`) && !later.includes("pypi.org"), `ssh server dialled the address: ${later}`);
    console.log(`     SOCKS4a: ${r.status} ${r.via}, wire ${b.subarray(0, 8).toString("hex")}… name "${name}", server dialled pypi.org; SOCKS4 control: wire address ${ip}`);
  });
} catch (e) {
  await test("tt42-proxy setup", {}, async () => { throw e; });
} finally {
  for (const p of procs) p.kill("SIGKILL");
  tee.close();
}
await finish();
process.exit(0);
