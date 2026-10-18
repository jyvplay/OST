/**
 * TT42 live DHCP-WPAD tests (WP-15, TT41 blocker "DHCP WPAD") — needs passwordless sudo (skips honestly without it).
 *  1. Lease files: real-format dhclient and systemd-networkd leases written to the REAL system paths; a fresh server
 *     process (FUSION_WP_WPAD=1, DHCPINFORM off) finds option 252 there (newest file first), loads that PAC file and
 *     https://pypi.org/ is carried by the proxy it names (pproxy). The lease CONTENT is written by this test (no DHCP
 *     client daemon runs in this sandbox) — the reading of the real paths and formats is what is under test.
 *  2. DHCPINFORM: a REAL DHCP exchange — a network namespace joined to the host by a veth pair, busybox udhcpd
 *     (independent implementation, GPL-2.0, test-only) serving option 252 on the host side; a fresh server process run
 *     as root INSIDE the namespace (port 68 is privileged) sends DHCPINFORM, gets the DHCPACK, loads the PAC file from
 *     the URL it carried, and routes by it (the PAC decision is recorded).
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt42-dhcp.mts
 */
import * as http from "node:http";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("tt42-dhcp");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);
const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
const NODE_TS = ["--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"];
const DIR = mkdtempSync(join(tmpdir(), "tt42-dhcp-")); chmodSync(DIR, 0o755);
const sudo = (...a: string[]) => execFileSync("sudo", ["-n", ...a], { stdio: "pipe" }).toString();
let haveSudo = true; try { sudo("true"); } catch { haveSudo = false; }
const P_PAC = 42895, P_PX = 42896, P_PAC2 = 42897, P_PX2 = 42898;
const procs: ChildProcess[] = [];
type Probe = { results: { url: string; status?: number; via?: string; error?: string }[]; systemAfter: { pac?: { discovered?: string | null; tried?: string[] | null; dhcp?: string[] | null; last?: { host: string; result: string; chosen: string } | null; error?: string | null } | null } };
const parse = (out: string): Probe => JSON.parse(out.trim().split("\n").pop()!);

function pacServer(host: string, port: number, body: string) {
  const s = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" }); res.end(body); });
  return new Promise<http.Server>((r) => s.listen(port, host, () => r(s)));
}

if (!haveSudo) {
  await test("DHCP WPAD live (skipped: no passwordless sudo — lease paths and port 68 need it)", { "WP-15": "partial" }, async () => { /* honest skip */ });
} else {
  const px = spawn(PPROXY, ["-l", `http://127.0.0.1:${P_PX}`, "-v"], { stdio: ["ignore", "pipe", "pipe"] }); procs.push(px);
  let pxLog = ""; px.stdout!.on("data", (d) => { pxLog += d; }); px.stderr!.on("data", (d) => { pxLog += d; });
  const pac1 = await pacServer("127.0.0.2", P_PAC, `function FindProxyForURL(u, h) { return h == "pypi.org" ? "PROXY 127.0.0.1:${P_PX}" : "DIRECT"; }`);
  const pacN = await pacServer("127.0.0.2", P_PAC + 10, `function FindProxyForURL(u, h) { return h == "pypi.org" ? "PROXY 127.0.0.1:${P_PX}; DIRECT" : "DIRECT"; }`);
  await sleep(1200);
  const created: string[] = [];
  try {
    await test("DHCP WPAD from LEASE FILES live (WP-15): a dhclient lease in /var/lib/dhcp (two lease blocks — the LAST is the current one — option 252 as dhclient writes an unnamed option: `option unknown-252 \"…\"`) is found by a fresh process with only FUSION_WP_WPAD=1; its PAC file routes https://pypi.org/ through pproxy (200); then a NEWER systemd-networkd lease in /run/systemd/netif/leases (OPTION_252=<hex>) takes precedence — newest lease first, as the machine's current network", { "WP-15": "full" }, async () => {
      sudo("mkdir", "-p", "/var/lib/dhcp", "/run/systemd/netif/leases");
      const dh = `lease {\n  interface "eth0";\n  fixed-address 10.0.0.9;\n  option unknown-252 "http://127.0.0.2:1/stale.pac";\n  renew 1 2026/10/01 00:00:00;\n}\nlease {\n  interface "eth0";\n  fixed-address 10.0.0.9;\n  option subnet-mask 255.255.255.0;\n  option unknown-252 "http://127.0.0.2:${P_PAC}/wpad.dat\\000";\n  renew 1 2026/10/18 00:00:00;\n}\n`;
      writeFileSync(join(DIR, "l1"), dh); sudo("cp", join(DIR, "l1"), "/var/lib/dhcp/dhclient.tt42.leases"); created.push("/var/lib/dhcp/dhclient.tt42.leases");
      const env = { PATH: process.env.PATH ?? "", FUSION_WP_OS_PROXY: "0", FUSION_WP_WPAD: "1", FUSION_WP_WPAD_INFORM: "0", FUSION_WP_WPAD_DOMAINS: "no-such-domain.invalid", PROBE_URLS: "https://pypi.org/" };
      const a = parse((await run(process.execPath, [...NODE_TS, "scripts/fixtures/ws/sysproxy-probe.mts"], { env, timeout: 90000 })).stdout);
      const pa = a.systemAfter.pac!;
      ok(pa.discovered === `http://127.0.0.2:${P_PAC}/wpad.dat`, `discovered from the dhclient lease: ${JSON.stringify(pa)}`);
      ok(a.results[0].status === 200 && a.results[0].via === `via HTTP proxy 127.0.0.1:${P_PX}`, `pypi through the PAC's proxy: ${JSON.stringify(a.results[0])}`);
      ok((pa.dhcp ?? [])[0]?.includes("/var/lib/dhcp/dhclient.tt42.leases"), `source recorded: ${JSON.stringify(pa.dhcp)}`);
      await sleep(1100);
      const hex = Buffer.from(`http://127.0.0.2:${P_PAC + 10}/networkd.pac`).toString("hex").toUpperCase();
      writeFileSync(join(DIR, "l2"), `# This is private data. Do not parse.\nADDRESS=10.0.0.9\nNETMASK=255.255.255.0\nOPTION_252=${hex}\n`);
      sudo("cp", join(DIR, "l2"), "/run/systemd/netif/leases/77"); created.push("/run/systemd/netif/leases/77");
      const b = parse((await run(process.execPath, [...NODE_TS, "scripts/fixtures/ws/sysproxy-probe.mts"], { env, timeout: 90000 })).stdout);
      ok(b.systemAfter.pac!.discovered === `http://127.0.0.2:${P_PAC + 10}/networkd.pac` && b.results[0].status === 200, `newer networkd lease wins: ${JSON.stringify(b.systemAfter.pac)} ${JSON.stringify(b.results[0])}`);
      console.log(`     dhclient lease → ${pa.discovered} → pypi ${a.results[0].status} ${a.results[0].via}; newer networkd lease → ${b.systemAfter.pac!.discovered}`);
    });
  } finally {
    for (const f of created) try { sudo("rm", "-f", f); } catch { /* gone */ }
    pac1.close(); pacN.close();
  }

  // ---- 2. a real DHCPINFORM exchange in a network namespace
  const NS = "tt42dhcp";
  const cleanupNs = () => { try { sudo("ip", "netns", "del", NS); } catch { /* none */ } try { sudo("ip", "link", "del", "tt42s"); } catch { /* none */ } };
  cleanupNs();
  let udhcpd: ChildProcess | null = null, pac2: http.Server | null = null, px2: ChildProcess | null = null;
  try {
    await test("DHCP WPAD by DHCPINFORM live (WP-15): a REAL DHCP exchange — a fresh server process, root inside a network namespace (port 68), sends DHCPINFORM (RFC 2131 §3.4) on its veth interface; busybox udhcpd (an independent DHCP server) answers DHCPACK with option 252; the PAC file at that URL is loaded and decides pypi.org's route (\"PROXY 10.42.0.1:…\", recorded) and the proxy it names receives the CONNECT", { "WP-15": "full" }, async () => {
      sudo("ip", "netns", "add", NS);
      sudo("ip", "link", "add", "tt42s", "type", "veth", "peer", "name", "tt42c");
      sudo("ip", "link", "set", "tt42c", "netns", NS);
      sudo("ip", "addr", "add", "10.42.0.1/24", "dev", "tt42s"); sudo("ip", "link", "set", "tt42s", "up");
      sudo("ip", "netns", "exec", NS, "ip", "addr", "add", "10.42.0.2/24", "dev", "tt42c");
      sudo("ip", "netns", "exec", NS, "ip", "link", "set", "tt42c", "up"); sudo("ip", "netns", "exec", NS, "ip", "link", "set", "lo", "up");
      const url = `http://10.42.0.1:${P_PAC2}/inform.pac`;
      writeFileSync(join(DIR, "udhcpd.conf"), `start 10.42.0.100\nend 10.42.0.150\ninterface tt42s\nlease_file ${DIR}/udhcpd.leases\npidfile ${DIR}/udhcpd.pid\nopt subnet 255.255.255.0\nopt wpad ${url}\n`);
      writeFileSync(join(DIR, "udhcpd.leases"), "");
      udhcpd = spawn("sudo", ["-n", "busybox", "udhcpd", "-f", join(DIR, "udhcpd.conf")], { stdio: ["ignore", "pipe", "pipe"] }); procs.push(udhcpd);
      let dl = ""; udhcpd.stdout!.on("data", (d) => { dl += d; }); udhcpd.stderr!.on("data", (d) => { dl += d; });
      pac2 = await pacServer("10.42.0.1", P_PAC2, `function FindProxyForURL(u, h) { return h == "pypi.org" ? "PROXY 10.42.0.1:${P_PX2}" : "DIRECT"; }`);
      px2 = spawn(PPROXY, ["-l", `http://10.42.0.1:${P_PX2}`, "-v"], { stdio: ["ignore", "pipe", "pipe"] }); procs.push(px2);
      let p2 = ""; px2.stdout!.on("data", (d) => { p2 += d; }); px2.stderr!.on("data", (d) => { p2 += d; });
      await sleep(1800);
      const inner = ["env", `PATH=${process.env.PATH}`, "FUSION_WP_OS_PROXY=0", "FUSION_WP_WPAD=1", "FUSION_WP_WPAD_DOMAINS=no-such-domain.invalid", "PROBE_URLS=https://pypi.org/", process.execPath, ...NODE_TS, "scripts/fixtures/ws/sysproxy-probe.mts"];
      // async: THIS process serves the PAC file — a synchronous exec would block its event loop
      const out = (await run("sudo", ["-n", "ip", "netns", "exec", NS, ...inner], { timeout: 90000 })).stdout;
      const pr = parse(out);
      const pa = pr.systemAfter.pac!;
      ok(pa.discovered === url, `discovered by DHCPINFORM: ${JSON.stringify(pa)}; udhcpd: ${dl.slice(-400)}`);
      ok((pa.dhcp ?? []).some((x) => x.includes("DHCPINFORM on tt42c")), `source: ${JSON.stringify(pa.dhcp)}`);
      ok(pa.last?.host === "pypi.org" && pa.last.result === `PROXY 10.42.0.1:${P_PX2}`, `PAC decision: ${JSON.stringify(pa.last)}`);
      ok(/pypi\.org:443/.test(p2), `the PAC's proxy received the CONNECT: ${p2.slice(-300)} / result ${JSON.stringify(pr.results[0])}`);
      console.log(`     DHCPINFORM on tt42c → ${pa.discovered}; PAC → ${pa.last?.result}; proxy log: ${p2.trim().split("\n").pop()}; request: ${pr.results[0].status ?? pr.results[0].error}`);
    });
  } finally {
    pac2?.close();
    try { sudo("pkill", "-f", `udhcpd -f ${join(DIR, "udhcpd.conf")}`); } catch { /* gone */ }
    cleanupNs();
  }
}
for (const p of procs) p.kill("SIGKILL");
await finish();
process.exit(0);
