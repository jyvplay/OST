/**
 * TT38 unit + interop tests (no Next server needed):
 *  WP-08  WebSockets — our RFC 6455 client (src/lib/server/ws-client.ts) against the RFC's own vectors, an independent
 *         server (Python `websockets`, BSD-3, scripts/fixtures/ws/ws_server.py), and hostile raw servers; the bridge
 *         registry (src/lib/server/wp-ws.ts) end to end at the module layer.
 *  WP-09  Connection layer (src/lib/server/wp-connect.ts): Happy Eyeballs over validated addresses, TLS verification,
 *         per-session keep-alive pools with the stale-connection retry; system proxy env (src/lib/server/sysproxy.ts)
 *         decided exactly as curl decides (differential against curl 7.88).
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt38-unit.mts
 */
import * as net from "node:net";
import * as http from "node:http";
import * as tls from "node:tls";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeHarness } from "./harness.mts";

// test-only loopback allowance for the module under test (read lazily on first use, so set before anything runs)
const LOOP = [41801, 41802, 41803, 41804];
process.env.FUSION_WP_TEST_LOOPBACK_PORTS = LOOP.join(",");

const WC = await import("../src/lib/server/ws-client.ts");
const CN = await import("../src/lib/server/wp-connect.ts");
const SP = await import("../src/lib/server/sysproxy.ts");
const WS = await import("../src/lib/server/wp-ws.ts");
const { upstreamRequest, readAll } = await import("../src/lib/server/wp-fetch.ts");
const { getPinnedPublic } = await import("../src/lib/server/pinned-http.ts");
const { createSession, dropSession, setUaOverride } = await import("../src/lib/server/wp-sessions.ts");
const { UA } = await import("../src/lib/wp-core.ts");
const { DIRECT } = await import("../src/lib/server/wp-tunnel.ts");

const run = promisify(execFile);
const { test, finish } = makeHarness("tt38-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const hex = (b: Buffer) => b.toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";

// ------------------------------------------------------------------ the independent server
function startPy(port: number): Promise<{ proc: ChildProcess; port: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY, ["scripts/fixtures/ws/ws_server.py", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let err = "";
    proc.stderr!.on("data", (d) => { err += d; });
    proc.stdout!.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n").filter(Boolean)) {
        lines.push(l);
        const m = /^READY (\d+)/.exec(l);
        if (m) resolve({ proc, port: Number(m[1]), lines });
      }
    });
    proc.on("exit", (c) => reject(new Error(`ws_server exited ${c}: ${err.slice(0, 400)}`)));
    setTimeout(() => reject(new Error("ws_server did not start")), 8000);
  });
}
const py = await startPy(LOOP[0]);
const tcp = (host: string, port: number) => new Promise<net.Socket>((res, rej) => { const s = net.connect({ host, port }); s.once("connect", () => res(s)); s.once("error", rej); });
const openLocal = async (h: string, p: number) => tcp(h, p);

interface Got { msgs: { data: string | Buffer; binary: boolean }[]; close: Promise<{ code: number; reason: string; wasClean: boolean }>; protoErr: { code: number; why: string }[] }
function collect(ws: InstanceType<typeof WC.WsClient>): Got {
  const g: Got = { msgs: [], protoErr: [], close: null as never };
  ws.on("message", (data: string | Buffer, binary: boolean) => g.msgs.push({ data, binary }));
  ws.on("protocolError", (code: number, why: string) => g.protoErr.push({ code, why }));
  g.close = new Promise((r) => ws.on("close", (code: number, reason: string, wasClean: boolean) => r({ code, reason, wasClean })));
  return g;
}
const waitFor = async (pred: () => boolean, ms: number, what: string) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(10); } };

// =====================================================================================================================
await test("RFC 6455 vectors (WP-08): §1.3 accept key; §5.7 frames byte for byte — unmasked and masked 'Hello', a fragmented text message, ping / masked pong, 256-byte (16-bit length) and 64 KiB (64-bit length) binary — encoded and parsed back; the parser refuses a 64-bit length with the top bit set and a control frame over 125 bytes", { "WP-08": "partial" }, () => {
  eq(WC.acceptFor("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "§1.3");
  const key = Buffer.from("37fa213d", "hex"), hello = Buffer.from("Hello");
  eq(hex(WC.encodeFrame(WC.OP.TEXT, hello, { mask: false })), "810548656c6c6f", "unmasked Hello");
  eq(hex(WC.encodeFrame(WC.OP.TEXT, hello, { mask: true, maskKey: key })), "818537fa213d7f9f4d5158", "masked Hello");
  eq(hex(WC.encodeFrame(WC.OP.TEXT, Buffer.from("Hel"), { fin: false, mask: false })) + hex(WC.encodeFrame(WC.OP.CONT, Buffer.from("lo"), { mask: false })), "010348656c80026c6f", "fragments");
  eq(hex(WC.encodeFrame(WC.OP.PING, hello, { mask: false })), "890548656c6c6f", "ping");
  eq(hex(WC.encodeFrame(WC.OP.PONG, hello, { mask: true, maskKey: key })), "8a8537fa213d7f9f4d5158", "masked pong");
  eq(hex(WC.encodeFrame(WC.OP.BINARY, Buffer.alloc(256), { mask: false }).subarray(0, 4)), "827e0100", "256 B");
  eq(hex(WC.encodeFrame(WC.OP.BINARY, Buffer.alloc(65536), { mask: false }).subarray(0, 10)), "827f0000000000010000", "64 KiB");
  // parse the RFC's own bytes back
  const p = new WC.FrameParser(1 << 20);
  const fr = p.push(Buffer.from("010348656c80026c6f818537fa213d7f9f4d5158", "hex"));
  eq(fr.map((f) => [f.opcode, f.fin, f.masked, f.payload.toString()]), [[1, false, false, "Hel"], [0, true, false, "lo"], [1, true, true, "Hello"]]);
  // split anywhere: same frames
  const all = Buffer.from("010348656c80026c6f818537fa213d7f9f4d5158", "hex"), q = new WC.FrameParser(1 << 20), got: string[] = [];
  for (const b of all) for (const f of q.push(Buffer.from([b]))) got.push(f.payload.toString());
  eq(got, ["Hel", "lo", "Hello"], "byte-at-a-time");
  let threw = "";
  try { new WC.FrameParser(1 << 20).push(Buffer.from("827f8000000000000001", "hex")); } catch (e) { threw = String((e as { code?: number }).code); }
  eq(threw, "1002", "64-bit MSB");
  threw = "";
  try { new WC.FrameParser(1 << 20).push(Buffer.concat([Buffer.from("897e007e", "hex"), Buffer.alloc(126)])); } catch (e) { threw = String((e as { code?: number }).code); }
  eq(threw, "1002", "control > 125");
});

await test("interop with an independent server (WP-08): Python websockets 13.1 echoes text and binary of 0 / 125 / 126 / 65535 / 65536 / 1 MiB bytes intact (both length boundaries), picks the offered subprotocol, sends fragmented messages we reassemble, pings us (we pong), closes with 4001 'bye ✓' and 1011, and receives our clean 1000 close", { "WP-08": "full" }, async () => {
  const c = await WC.connectWebSocket({ url: `ws://127.0.0.1:${py.port}/echo`, protocols: ["chat.v1", "chat.v2"], open: openLocal });
  eq(c.protocol, "chat.v2", "subprotocol");
  const g = collect(c.ws);
  const sizes = [0, 125, 126, 65535, 65536, 1 << 20];
  for (const n of sizes) {
    const bin = Buffer.alloc(n); for (let i = 0; i < n; i++) bin[i] = (i * 7) & 255;
    c.ws.send(bin, true);
    c.ws.send("é".repeat(Math.floor(n / 2)) + (n % 2 ? "x" : ""), false); // n UTF-8 bytes
  }
  await waitFor(() => g.msgs.length === sizes.length * 2, 10000, "echoes");
  sizes.forEach((n, i) => {
    const b = g.msgs[2 * i], t = g.msgs[2 * i + 1];
    ok(b.binary && (b.data as Buffer).length === n && createHash("sha1").update(b.data as Buffer).digest("hex") === createHash("sha1").update(Buffer.from(Array.from({ length: n }, (_, k) => (k * 7) & 255))).digest("hex"), `binary ${n}`);
    ok(!t.binary && Buffer.byteLength(t.data as string) === n, `text ${n}`);
  });
  c.ws.close(1000, "done");
  const cl = await g.close;
  eq([cl.code, cl.wasClean], [1000, true], "our clean close");

  const f = await WC.connectWebSocket({ url: `ws://127.0.0.1:${py.port}/frag`, open: openLocal });
  const fg = collect(f.ws);
  await waitFor(() => fg.msgs.length === 2, 3000, "fragments");
  eq([fg.msgs[0].data, fg.msgs[0].binary], ["fragmented ✓", false]);
  eq(hex(fg.msgs[1].data as Buffer), "000102ff");
  f.ws.close(1000);

  const p = await WC.connectWebSocket({ url: `ws://127.0.0.1:${py.port}/ping`, open: openLocal });
  const pg = collect(p.ws); let pinged = "";
  p.ws.on("ping", (b: Buffer) => { pinged = b.toString(); });
  await waitFor(() => pg.msgs.length === 1, 6000, "pong-ok");
  eq([pinged, pg.msgs[0].data], ["probe", "pong-ok"]);
  p.ws.close(1000);

  for (const [path, code, reason] of [["close4001", 4001, "bye ✓"], ["close1011", 1011, ""]] as const) {
    const x = await WC.connectWebSocket({ url: `ws://127.0.0.1:${py.port}/${path}`, open: openLocal });
    const r = await collect(x.ws).close;
    eq([r.code, r.reason, r.wasClean], [code, reason, true], path);
  }
  console.log(`     sizes ${sizes.join("/")} both ways; subprotocol chat.v2; 3+2 fragments; ping 'probe'; 4001/1011 clean`);
});

await test("limits and close semantics (WP-08): a message over the client's cap fails with 1009 without buffering it; a close reason over 123 bytes is cut on a UTF-8 boundary (the far side accepts it — no 1007); the server sees the client's code", { "WP-08": "partial" }, async () => {
  const c = await WC.connectWebSocket({ url: `ws://127.0.0.1:${py.port}/big?n=5000`, open: openLocal, maxMessage: 1000 });
  const g = collect(c.ws);
  const r = await g.close;
  eq([r.code, g.msgs.length], [1009, 0], "1009");
  const h = await WC.connectWebSocket({ url: `ws://127.0.0.1:${py.port}/hold`, open: openLocal });
  const hg = collect(h.ws);
  await waitFor(() => hg.msgs.length === 1, 3000, "hi");
  h.ws.close(4000, "é".repeat(80)); // 160 bytes → cut to 122 (61 × 'é'), never a half character
  const hr = await hg.close;
  eq([hr.code, hr.wasClean], [4000, true], "clean 4000 with a long reason");
  await waitFor(() => py.lines.some((l) => l === "CLOSED 4000"), 3000, "server saw 4000");
});

// ------------------------------------------------------------------ hostile raw servers
type Script = (sock: net.Socket, key: string, head: string) => void;
async function hostile(script: Script, o: { protocols?: string[]; maxMessage?: number; timeoutMs?: number } = {}): Promise<{ stage: "handshake" | "open"; error?: string; close?: { code: number; wasClean: boolean }; protoErr?: number; ms: number }> {
  const srv = net.createServer((s) => {
    let buf = "";
    s.on("data", (d) => {
      if (buf.includes("\r\n\r\n")) return;
      buf += d.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf)?.[1] ?? "";
      script(s, key, buf);
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port, t0 = Date.now();
  try {
    const c = await WC.connectWebSocket({ url: `ws://127.0.0.1:${port}/`, open: openLocal, protocols: o.protocols, maxMessage: o.maxMessage, timeoutMs: o.timeoutMs ?? 2000, closeTimeoutMs: 1000 });
    const g = collect(c.ws);
    const r = await Promise.race([g.close, sleep(4000).then(() => ({ code: -1, reason: "", wasClean: false }))]);
    return { stage: "open", close: { code: r.code, wasClean: r.wasClean }, protoErr: g.protoErr[0]?.code, ms: Date.now() - t0 };
  } catch (e) { return { stage: "handshake", error: (e as Error).message, ms: Date.now() - t0 }; }
  finally { srv.close(); }
}
const ok101 = (key: string, extra = "") => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${WC.acceptFor(key)}\r\n${extra}\r\n`;
const rawFrame = (b0: number, payload: Buffer, b1extra = 0) => Buffer.concat([Buffer.from([b0, payload.length | b1extra]), payload]);

await test("hostile servers (WP-08, D: 17 negative shapes): wrong accept, 200 instead of 101, no Upgrade, a subprotocol we did not offer, an extension we did not offer, a header flood, silence → each refuses the handshake; then masked server frames, RSV bits, a reserved opcode, invalid UTF-8 text, an oversized / fragmented control frame, a continuation with nothing to continue, a new message inside a fragmented one, close code 1005 on the wire, a 1-byte close payload → each fails the connection with the right status (1002 / 1007), never a hang or a crash", { "WP-08": "full" }, async () => {
  const cases: [string, Script, (r: Awaited<ReturnType<typeof hostile>>) => boolean, object?][] = [
    ["wrong accept", (s) => s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n`), (r) => r.stage === "handshake"],
    ["200 not 101", (s) => s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"), (r) => r.stage === "handshake"],
    ["no Upgrade header", (s, k) => s.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${WC.acceptFor(k)}\r\n\r\n`), (r) => r.stage === "handshake"],
    ["unoffered subprotocol", (s, k) => s.write(ok101(k, "Sec-WebSocket-Protocol: evil\r\n")), (r) => r.stage === "handshake", { protocols: ["chat"] }],
    // TT39: permessage-deflate IS offered now (and its answer validated: scripts/tt39-unit.mts) — an extension we never offer
    ["unoffered extension", (s, k) => s.write(ok101(k, "Sec-WebSocket-Extensions: x-webkit-deflate-frame\r\n")), (r) => r.stage === "handshake"],
    ["header flood", (s) => { s.write("HTTP/1.1 101 Switching Protocols\r\n"); for (let i = 0; i < 40; i++) s.write(`X-Pad-${i}: ${"a".repeat(1000)}\r\n`); }, (r) => r.stage === "handshake"],
    ["silence", () => {}, (r) => r.stage === "handshake" && r.ms < 2600, { timeoutMs: 500 }],
    ["masked server frame", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), Buffer.from("818537fa213d7f9f4d5158", "hex")])), (r) => r.close?.code === 1002],
    ["RSV1 set", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0xc1, Buffer.from("x"))])), (r) => r.close?.code === 1002],
    ["reserved opcode 3", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0x83, Buffer.from("x"))])), (r) => r.close?.code === 1002],
    ["invalid UTF-8 text", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0x81, Buffer.from([0xc3, 0x28]))])), (r) => r.close?.code === 1007],
    ["control frame 126 bytes", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), Buffer.from("897e007e", "hex"), Buffer.alloc(126)])), (r) => r.close?.code === 1002],
    ["fragmented ping", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0x09, Buffer.from("x"))])), (r) => r.close?.code === 1002],
    ["orphan continuation", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0x80, Buffer.from("x"))])), (r) => r.close?.code === 1002],
    ["new message inside a fragmented one", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0x01, Buffer.from("a")), rawFrame(0x81, Buffer.from("b"))])), (r) => r.close?.code === 1002],
    ["close 1005 on the wire", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0x88, Buffer.from([0x03, 0xed]))])), (r) => r.close?.code === 1002],
    ["1-byte close payload", (s, k) => s.write(Buffer.concat([Buffer.from(ok101(k)), rawFrame(0x88, Buffer.from([0x03]))])), (r) => r.close?.code === 1002],
  ];
  const report: string[] = [];
  for (const [name, script, pass, opt] of cases) {
    const r = await hostile(script, opt);
    report.push(`${name} → ${r.stage === "handshake" ? `refused (${(r.error ?? "").slice(0, 50)})` : `close ${r.close?.code}`} ${r.ms}ms`);
    ok(pass(r), `${name}: ${JSON.stringify(r)}`);
  }
  console.log("     " + report.join("\n     "));
});

// ------------------------------------------------------------------ connection layer
await test("Happy Eyeballs (WP-09, RFC 8305): families interleave from the resolver's first choice; a refused address hands over AT ONCE (no 250 ms wait) to a live one on real sockets; a blackholed first address loses to the second, started 250 ms later; every loser is destroyed; all refused → one error listing every address with the first code; nothing answering → ETIMEDOUT at the deadline", { "WP-09": "full" }, async () => {
  eq(CN.orderAddresses([{ address: "a6", family: 6 }, { address: "b6", family: 6 }, { address: "c4", family: 4 }, { address: "d4", family: 4 }, { address: "e4", family: 4 }]).map((x) => x.address), ["a6", "c4", "b6", "d4", "e4"]);
  eq(CN.orderAddresses([{ address: "c4", family: 4 }, { address: "a6", family: 6 }]).map((x) => x.address), ["c4", "a6"]);
  // real sockets: 127.0.0.1 refuses this port, 127.0.0.2 (also loopback on Linux) listens
  const srv = net.createServer((s) => s.end());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.2", r));
  const port = (srv.address() as net.AddressInfo).port;
  const t0 = Date.now();
  const r = await CN.connectPinned([{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }], port, { timeoutMs: 3000 });
  const fast = Date.now() - t0;
  eq(r.address, "127.0.0.2"); ok(fast < 200, `refused should hand over at once, took ${fast} ms`);
  eq(r.attempts.map((a) => [a.address, a.error ?? "ok"]), [["127.0.0.1", "ECONNREFUSED"], ["127.0.0.2", "ok"]]);
  r.socket.destroy();
  // blackhole: a socket that never connects (what a dead IPv6 route looks like)
  const made: net.Socket[] = [];
  const dial = (a: { address: string }, p: number) => {
    if (a.address === "dead") { const s = new net.Socket(); made.push(s); return s; }
    const s = net.connect({ host: "127.0.0.2", port: p }); made.push(s); return s;
  };
  const t1 = Date.now();
  const b = await CN.connectPinned([{ address: "dead", family: 6 }, { address: "live", family: 4 }], port, { timeoutMs: 3000, dial });
  const took = Date.now() - t1;
  eq(b.address, "live"); ok(took >= 240 && took < 600, `second attempt at ~250 ms, won at ${took} ms`);
  ok(made[0].destroyed, "the blackholed attempt is destroyed");
  b.socket.destroy();
  // all refused
  const srv2 = net.createServer(); await new Promise<void>((r2) => srv2.listen(0, "127.0.0.1", r2)); const closedPort = (srv2.address() as net.AddressInfo).port; srv2.close();
  let err: { code?: string; message?: string } = {};
  try { await CN.connectPinned([{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.3", family: 4 }], closedPort, { timeoutMs: 3000 }); } catch (e) { err = e as typeof err; }
  ok(err.code === "ECONNREFUSED" && /127\.0\.0\.1 ECONNREFUSED; 127\.0\.0\.3 ECONNREFUSED/.test(err.message ?? ""), `all refused: ${err.code} ${err.message}`);
  // nothing answers
  const hung: net.Socket[] = [];
  const t2 = Date.now(); err = {};
  try { await CN.connectPinned([{ address: "x", family: 6 }, { address: "y", family: 4 }], 1, { timeoutMs: 700, dial: () => { const s = new net.Socket(); hung.push(s); return s; } }); } catch (e) { err = e as typeof err; }
  const tt = Date.now() - t2;
  ok(err.code === "ETIMEDOUT" && tt >= 690 && tt < 1000 && hung.every((s) => s.destroyed), `timeout ${err.code} at ${tt} ms`);
  srv.close();
  console.log(`     refused→live ${fast} ms; blackhole→live ${took} ms; all-refused: ${err.code ? "" : ""}${"ECONNREFUSED listing both"}; deadline 700 → ${tt} ms`);
});

await test("TLS stays verified on the new path (WP-09): github.com:443 over connectPinned + tlsOver negotiates http/1.1 with a valid chain; a self-signed local server is refused (rejectUnauthorized never turned off)", { "WP-09": "partial" }, async () => {
  const { resolvePinnedPublicHost } = await import("../src/lib/server/netguard.ts");
  const addrs = await resolvePinnedPublicHost("github.com");
  const c = await CN.connectPinned(addrs, 443, { timeoutMs: 8000 });
  const t = await CN.tlsOver(c.socket, "github.com", 8000);
  ok(t.authorized && t.alpnProtocol === "http/1.1", `github: authorized=${t.authorized} alpn=${t.alpnProtocol}`);
  t.destroy();
  const dir = mkdtempSync(join(tmpdir(), "tt38-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const srv = tls.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (s) => s.end());
  srv.on("tlsClientError", () => {});
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const sock = await tcp("127.0.0.1", (srv.address() as net.AddressInfo).port);
  let why = "";
  try { await CN.tlsOver(sock, "localhost", 3000); } catch (e) { why = (e as { code?: string }).code ?? (e as Error).message; }
  srv.close();
  ok(/SELF_SIGNED|DEPTH_ZERO/.test(why), `self-signed must be refused, got '${why}'`);
  console.log(`     github.com via ${c.address}: authorized, ALPN http/1.1; self-signed → ${why}`);
});

// keep-alive server on an allowlisted loopback port: counts TCP connections; /stale makes the NEXT request on a reused
// connection die before any response (the race a real server's idle timeout causes)
let conns = 0;
const killNextOn = new Set<net.Socket>();
const ka = http.createServer((req, res) => {
  const s = req.socket;
  if (killNextOn.has(s)) { killNextOn.delete(s); s.destroy(); return; }
  if (req.url === "/stale") killNextOn.add(s);
  res.setHeader("content-type", "text/plain");
  res.end(`conn ${(s as net.Socket & { n?: number }).n} ${req.method} ${req.url}`);
});
ka.on("connection", (s: net.Socket & { n?: number }) => { s.n = ++conns; });
ka.keepAliveTimeout = 10_000;
await new Promise<void>((r) => ka.listen(LOOP[1], "127.0.0.1", r));
const KA = `http://127.0.0.1:${LOOP[1]}`;
const get = async (path: string, session?: { sid: string; circuit: number }, method = "GET") => {
  const up = await upstreamRequest(KA + path, { method, headers: {}, maxBytes: 1 << 20, session, body: method === "POST" ? Buffer.from("x") : undefined });
  return (await readAll(up.body, 1 << 20)).toString();
};

await test("keep-alive pools (WP-09): a session's sequential requests reuse ONE connection (the old code opened one per request); another session never shares it; a new circuit gets a fresh one; 12 parallel requests use at most 6; a connection the server dropped while idle is retried for GET but never for POST", { "WP-09": "full" }, async () => {
  conns = 0;
  const A = { sid: "unit-A", circuit: 0 }, B = { sid: "unit-B", circuit: 0 };
  const a = [await get("/1", A), await get("/2", A), await get("/3", A), await get("/4", A), await get("/5", A)];
  ok(a.every((x) => x.startsWith("conn 1 ")), `A reuses: ${a.join(" | ")}`);
  const b = await get("/1", B);
  ok(b.startsWith("conn 2 "), `B separate: ${b}`);
  const a2 = await get("/6", { sid: "unit-A", circuit: 1 });
  ok(a2.startsWith("conn 3 "), `new circuit fresh: ${a2}`);
  const before = conns;
  const par = await Promise.all(Array.from({ length: 12 }, (_, i) => get(`/p${i}`, { sid: "unit-P", circuit: 0 })));
  const used = new Set(par.map((x) => x.split(" ")[1]));
  ok(used.size <= 6 && conns - before <= 6, `parallel used ${used.size} connections`);
  // stale connection: GET retried on a fresh connection
  const C = { sid: "unit-C", circuit: 0 };
  await get("/stale", C);
  const r = await get("/after", C);
  ok(/^conn \d+ GET \/after$/.test(r), `GET retried: ${r}`);
  await get("/stale", C);
  let postErr = "";
  try { await get("/after-post", C, "POST"); } catch (e) { postErr = (e as { code?: string }).code ?? (e as Error).message; }
  ok(/ECONNRESET|socket hang up/.test(postErr), `POST must not be retried, got '${postErr}'`);
  const st = CN.poolStats();
  ok(st.pools >= 4, `pools ${JSON.stringify(st)}`);
  ok(CN.dropPools("unit-A") === 2, "dropPools closes both of A's pools (circuits 0 and 1)");
  console.log(`     A: 5 requests on conn 1; B conn 2; new circuit conn 3; 12 parallel → ${used.size} conns; stale GET retried, POST → ${postErr}`);
});

await test("one connection layer (WP-09): the legacy fetcher (reader of direct tabs, embed probe) goes through the same pools and reports the address it used; redirects stay bounded and re-checked", { "WP-09": "partial" }, async () => {
  const r = await getPinnedPublic(`${KA}/legacy`, { timeoutMs: 3000 });
  ok(r.status === 200 && r.pinnedAddress === "127.0.0.1" && /GET \/legacy$/.test(r.body.toString()), `${r.status} ${r.pinnedAddress} ${r.body}`);
  let refused = "";
  try { await getPinnedPublic(`http://127.0.0.1:${LOOP[3] + 1}/`); } catch (e) { refused = (e as Error).message; }
  ok(/port/.test(refused), `non-allowlisted loopback port still refused: ${refused}`);
});

// ------------------------------------------------------------------ system proxy, decided as curl decides
await test("system proxy (WP-09): for 22 environment × URL cases our route decision equals curl 7.88's — https_proxy / HTTPS_PROXY, http_proxy lowercase only (curl ignores HTTP_PROXY), ALL_PROXY fallback, no_proxy '*', suffix with and without the leading dot, exact IP, CIDR, :port, case; malformed proxy values are reported, never used", { "WP-09": "full" }, async () => {
  // a recording proxy (answers 502 after logging) and a direct target that logs; curl's choice = which one saw the request
  const seen: string[] = [];
  const prox = http.createServer((req, res) => { seen.push(`proxy ${req.method}`); res.writeHead(502); res.end(); });
  prox.on("connect", (_req, sock) => { seen.push("proxy CONNECT"); sock.end("HTTP/1.1 502 no\r\n\r\n"); });
  const direct = http.createServer((req, res) => { seen.push("direct"); res.end("d"); });
  await new Promise<void>((r) => prox.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => direct.listen(0, "127.0.0.1", r));
  const PP = (prox.address() as net.AddressInfo).port, DP = (direct.address() as net.AddressInfo).port;
  const P = `127.0.0.1:${PP}`;
  const cases: [Record<string, string>, string][] = [
    [{ http_proxy: P }, `http://site.test:${DP}/`],
    [{ HTTP_PROXY: P }, `http://site.test:${DP}/`],
    [{ https_proxy: P }, `http://site.test:${DP}/`],
    [{ https_proxy: P }, `https://site.test:${DP}/`],
    [{ HTTPS_PROXY: P }, `https://site.test:${DP}/`],
    [{ ALL_PROXY: P }, `http://site.test:${DP}/`],
    [{ all_proxy: P }, `https://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "*" }, `http://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "site.test" }, `http://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "site.test" }, `http://api.site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: ".site.test" }, `http://api.site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: ".site.test" }, `http://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "te.test" }, `http://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "other.test, site.test" }, `http://site.test:${DP}/`],
    [{ http_proxy: P, NO_PROXY: "site.test" }, `http://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "SITE.test" }, `http://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "127.0.0.1" }, `http://127.0.0.1:${DP}/`],
    [{ http_proxy: P, no_proxy: "127.0.0.0/8" }, `http://127.0.0.1:${DP}/`],
    [{ http_proxy: P, no_proxy: "10.0.0.0/8" }, `http://127.0.0.1:${DP}/`],
    [{ http_proxy: P, no_proxy: "127.0.0.2" }, `http://127.0.0.1:${DP}/`],
    [{ http_proxy: P, no_proxy: `site.test:${DP}` }, `http://site.test:${DP}/`],
    [{ http_proxy: P, no_proxy: "site.test:1" }, `http://site.test:${DP}/`],
  ];
  const rows: string[] = [], mismatch: string[] = [];
  for (const [env, url] of cases) {
    seen.length = 0;
    const host = new URL(url).hostname;
    const clean: Record<string, string> = { PATH: process.env.PATH ?? "" };
    await run("curl", ["-s", "-k", "-o", "/dev/null", "--max-time", "3", "--resolve", `site.test:${DP}:127.0.0.1`, "--resolve", `api.site.test:${DP}:127.0.0.1`, url], { env: { ...clean, ...env } }).catch(() => {});
    const curl = seen.some((x) => x.startsWith("proxy")) ? "proxy" : seen.includes("direct") || /^https/.test(url) ? "direct" : "none";
    const sp = SP.systemProxyFromEnv(env);
    const d = sp ? SP.systemRouteFor(sp, new URL(url)) : null;
    const ours = d && d !== "direct" ? "proxy" : "direct";
    rows.push(`${JSON.stringify(env).replace(String(PP), "P").replace(String(DP), "D")} ${url.replace(String(DP), "D")} curl=${curl} ours=${ours}`);
    if (curl !== ours) mismatch.push(rows[rows.length - 1]);
    void host;
  }
  prox.close(); direct.close();
  const bad = SP.systemProxyFromEnv({ https_proxy: "ftp://nope:21", http_proxy: "http://ok.test:3128" });
  ok(bad && bad.https === null && bad.errors.length === 1 && bad.http?.host === "ok.test", `malformed reported: ${JSON.stringify(bad)}`);
  console.log("     " + rows.join("\n     "));
  eq(mismatch, [], "curl differential");
});

await test("system proxy, live (WP-09): a fresh server process whose environment has https_proxy (an independent proxy, pproxy) and no_proxy=127.0.0.1 uses the system route by itself — https://pypi.org/ is carried by the proxy (pproxy logs the NAME; no local DNS) while the no_proxy site goes direct; a WebSocket runs over a SOCKS5 tunnel (the Tor route) intact", { "WP-09": "full", "WP-08": "partial" }, async () => {
  const PPROXY = process.env.FUSION_PPROXY ?? "/home/user/tools/venv/bin/pproxy";
  const pp = spawn(PPROXY, ["-l", "http://127.0.0.1:18381", "-l", "socks5://127.0.0.1:18382", "-v"], { stdio: ["ignore", "pipe", "pipe"] });
  let ppLog = ""; pp.stdout!.on("data", (d) => { ppLog += d; }); pp.stderr!.on("data", (d) => { ppLog += d; });
  await sleep(1200);
  try {
    const { stdout } = await run(process.execPath, ["--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/fixtures/ws/sysproxy-probe.mts"], {
      env: { PATH: process.env.PATH ?? "", https_proxy: "http://127.0.0.1:18381", no_proxy: "127.0.0.1", FUSION_WP_TEST_LOOPBACK_PORTS: String(LOOP[1]), PROBE_URLS: `https://pypi.org/ ${KA}/np` }, timeout: 40000,
    });
    const j = JSON.parse(stdout.trim().split("\n").pop()!);
    const py1 = j["https://pypi.org/"], lo = j[`${KA}/np`];
    ok(j.system.active === true && j.route === "http", `system route active: ${JSON.stringify(j.system)}`);
    ok(py1.status === 200 && /via/.test(py1.via) && py1.bytes > 1000, `pypi via proxy: ${JSON.stringify(py1)}`);
    ok(/pypi\.org/.test(ppLog), `pproxy saw the name: ${ppLog.slice(0, 300)}`);
    ok(lo.status === 200 && lo.via === "127.0.0.1", `no_proxy direct: ${JSON.stringify(lo)}`);
    ok(!/127\.0\.0\.1:41802/.test(ppLog), "the no_proxy site never reached the proxy");
    // WebSocket over a SOCKS5 tunnel (what the Tor route does): the tunnel socket comes back paused and the client
    // takes it from there (the guard's private-address refusal is bypassed here only because we call the tunnel directly)
    const { openTunnel, parseRoute } = await import("../src/lib/server/wp-tunnel.ts");
    const route = parseRoute("socks5://127.0.0.1:18382", false);
    const c = await WC.connectWebSocket({ url: `ws://127.0.0.1:${py.port}/echo`, open: (h, p2) => openTunnel(route, h, p2, { secure: false, timeoutMs: 5000 }) });
    const g = collect(c.ws);
    c.ws.send("over socks ✓"); c.ws.send(Buffer.alloc(70000, 9), true);
    await waitFor(() => g.msgs.length === 2, 4000, "echo over socks");
    ok(g.msgs[0].data === "over socks ✓" && (g.msgs[1].data as Buffer).length === 70000, "socks echo");
    c.ws.close(1000);
    ok((await g.close).wasClean, "clean close over socks");
    ok(new RegExp(`socks5 127\\.0\\.0\\.1:\\d+ -> 127\\.0\\.0\\.1:${py.port}`).test(ppLog), `pproxy carried the socket: ${ppLog.slice(-300)}`);
    console.log(`     pypi.org ${py1.status} ${py1.via} (${py1.bytes} B); pproxy: ${ppLog.trim().split("\n").filter((l) => /pypi/.test(l)).slice(0, 1).join("")}; loopback direct via ${lo.via}; WebSocket echo over SOCKS5 (text + 70 KB) clean`);
  } finally { pp.kill(); }
});

// ------------------------------------------------------------------ the bridge registry
function readFrames(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const frames: { type: number; payload: Buffer }[] = [];
  let buf = Buffer.alloc(0), done = false;
  (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) { done = true; return; }
      buf = Buffer.concat([buf, Buffer.from(r.value!)]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
        const len = buf.readUInt32BE(1);
        frames.push({ type: buf[0], payload: buf.subarray(5, 5 + len) });
        buf = buf.subarray(5 + len);
      }
    }
  })();
  return { frames, reader, isDone: () => done };
}
const WSU = `ws://127.0.0.1:${py.port}`;

await test("bridge (WP-08, PR-07h): opening through the registry reaches the independent server via the connection layer; WebSocket User-Agent comes from the target-host override rather than the session default; text and binary go both ways in order; the site sees the page's own Origin and session cookie, a 101 cookie lands in the jar, another session cannot write (410), and clean close arrives as {code, reason, wasClean}", { "WP-08": "full", "PR-07h": "full" }, async () => {
  const s = createSession("mobile");
  ok(setUaOverride(s, `127.0.0.1:${py.port}`, "desktop"), "target-host WebSocket override accepted");
  s.jar.set("sess=jar1; Path=/", new URL(`http://127.0.0.1:${py.port}/`));
  const pageOrigin = `http://127.0.0.1:${py.port}`; // the page is on the socket's own site: Lax cookies go along
  const h = readFrames(WS.openBridge(s, { url: `${WSU}/headers`, protocols: [], origin: `${pageOrigin}/room/1`, token: WS.originToken(s.sid, pageOrigin) }));
  await waitFor(() => h.frames.length >= 2, 4000, "open + headers");
  eq(h.frames[0].type, WS.FRAME.OPEN);
  const hdr = JSON.parse(h.frames[1].payload.toString());
  ok(hdr.ua === UA.desktop && hdr.origin === pageOrigin && hdr.cookie === "sess=jar1", `WebSocket target-host override must beat the session's mobile default: ${JSON.stringify(hdr)}`);
  ok(/wsck=from101/.test(s.jar.header(new URL(`http://127.0.0.1:${py.port}/`))), "101 Set-Cookie stored in the session jar");
  await h.reader.cancel();

  const e = readFrames(WS.openBridge(s, { url: `${WSU}/echo`, protocols: ["chat.v2"] }));
  await waitFor(() => e.frames.length >= 1, 4000, "open");
  const open = JSON.parse(e.frames[0].payload.toString());
  eq(open.protocol, "chat.v2");
  const batch = Buffer.concat([WS.frame(WS.FRAME.TEXT, "one"), WS.frame(WS.FRAME.BINARY, Buffer.from([1, 2, 3])), WS.frame(WS.FRAME.TEXT, "three ✓")]);
  eq(WS.sendToBridge(s.sid, open.id, batch), 204);
  const other = createSession();
  eq(WS.sendToBridge(other.sid, open.id, WS.frame(WS.FRAME.TEXT, "intruder")), 410, "cross-session");
  eq(WS.sendToBridge(s.sid, "f".repeat(32), WS.frame(WS.FRAME.TEXT, "x")), 410, "unknown id");
  eq(WS.sendToBridge(s.sid, open.id, Buffer.from([2, 0, 0, 0, 9, 1])), 400, "truncated frame");
  await waitFor(() => e.frames.length >= 4, 3000, "echoes");
  eq(e.frames.slice(1, 4).map((f) => [f.type, f.type === 3 ? hex(f.payload) : f.payload.toString()]), [[2, "one"], [3, "010203"], [2, "three ✓"]]);
  eq(WS.sendToBridge(s.sid, open.id, WS.frame(WS.FRAME.CLOSE, JSON.stringify({ code: 4100, reason: "bye" }))), 204);
  await waitFor(() => e.isDone(), 3000, "stream end");
  const cl = JSON.parse(e.frames[e.frames.length - 1].payload.toString());
  eq([e.frames[e.frames.length - 1].type, cl.code, cl.reason, cl.wasClean], [4, 4100, "bye", true]);
  dropSession(s.sid); dropSession(other.sid);
});

await test("I — repair against a new attack, cross-site WebSocket hijacking (WP-08): a page that claims another site's origin (with its own token, a made-up one, or none) is sent as Origin 'null' and gets no Lax cookies; a genuine cross-site page keeps its true Origin but also gets no Lax cookies; the jar learns SameSite (default Lax, None needs Secure, Strict/Lax withheld cross-site); siteOf handles public suffixes and IPs", { "WP-08": "full" }, async () => {
  const s = createSession();
  const host = new URL(`http://127.0.0.1:${py.port}/`);
  s.jar.set("sess=lax1; Path=/", host);
  const attempt = async (origin: string, token: string) => {
    const h = readFrames(WS.openBridge(s, { url: `${WSU}/headers`, protocols: [], origin, token }));
    await waitFor(() => h.frames.length >= 2, 4000, "headers");
    await h.reader.cancel();
    return JSON.parse(h.frames[1].payload.toString()) as { origin: string | null; cookie: string | null };
  };
  const victim = `http://127.0.0.1:${py.port}`;
  const forged1 = await attempt(victim, WS.originToken(s.sid, "https://evil.test"));        // evil's own token, victim's name
  const forged2 = await attempt(victim, "A".repeat(32));                                       // made up
  const forged3 = await attempt(victim, "");                                                   // none
  const otherSid = await attempt(victim, WS.originToken("another-session", victim));           // a token from another session
  const cross = await attempt("https://chat.example", WS.originToken(s.sid, "https://chat.example")); // honest cross-site page
  const same = await attempt(victim, WS.originToken(s.sid, victim));
  for (const [n, r] of [["evil token", forged1], ["made-up", forged2], ["none", forged3], ["other session", otherSid]] as const) ok(r.origin === "null" && r.cookie === null, `${n}: ${JSON.stringify(r)}`);
  ok(cross.origin === "https://chat.example" && cross.cookie === null, `cross-site: ${JSON.stringify(cross)}`);
  // the five cross-site / unverified handshakes above could not plant the 101 reply's Lax cookie; this same-site one did,
  // and the next same-site handshake carries it
  ok(same.origin === victim && same.cookie === "sess=lax1", `same-site: ${JSON.stringify(same)}`);
  const again = await attempt(victim, WS.originToken(s.sid, victim));
  ok(again.cookie === "sess=lax1; wsck=from101", `101 cookie stored only from the same-site handshake: ${JSON.stringify(again)}`);
  // jar SameSite semantics
  const { CookieJar, siteOf } = await import("../src/lib/wp-core.ts");
  const j = new CookieJar(), u = new URL("https://shop.example.co.uk/");
  eq([j.set("a=1", u), j.set("b=2; SameSite=Strict", u), j.set("c=3; SameSite=None; Secure", u), j.set("d=4; SameSite=None", u)], [null, null, null, "SameSite=None without Secure"]);
  eq([j.header(u), j.header(u, Date.now(), false, true)], ["a=1; b=2; c=3", "c=3"]);
  eq([siteOf("a.b.example.co.uk"), siteOf("x.github.io"), siteOf("www.example.com"), siteOf("10.0.0.1"), siteOf("deep.a.b.c.test")], ["example.co.uk", "x.github.io", "example.com", "10.0.0.1", "c.test"]);
  dropSession(s.sid);
  console.log(`     forged ×4 → Origin null, no cookie; cross-site → true Origin, no Lax cookie; same-site → Origin + cookie`);
});

await test("bridge lifecycle and guards (WP-08): closing the session closes its sockets (server sees 1001); cancelling the stream (tab gone) closes upstream 1001; 32 sockets per session then 429; private, non-web-port, fragment and non-ws URLs are refused before any connection, a private IP behind the URL ends as close 1006 with the reason", { "WP-08": "full" }, async () => {
  const s = createSession();
  const a = readFrames(WS.openBridge(s, { url: `${WSU}/hold`, protocols: [] }));
  await waitFor(() => a.frames.length >= 2, 4000, "hold open");
  const n0 = py.lines.filter((l) => l === "CLOSED 1001").length;
  dropSession(s.sid);
  await waitFor(() => py.lines.filter((l) => l === "CLOSED 1001").length === n0 + 1, 3000, "session close → 1001");
  const s2 = createSession();
  const b = readFrames(WS.openBridge(s2, { url: `${WSU}/hold`, protocols: [] }));
  await waitFor(() => b.frames.length >= 2, 4000, "hold open 2");
  await b.reader.cancel();
  await waitFor(() => py.lines.filter((l) => l === "CLOSED 1001").length === n0 + 2, 3000, "cancel → 1001");
  // limit
  const many = [];
  for (let i = 0; i < WS.WS_PER_SESSION; i++) many.push(readFrames(WS.openBridge(s2, { url: `${WSU}/hold`, protocols: [] })));
  let status = 0;
  try { WS.openBridge(s2, { url: `${WSU}/hold`, protocols: [] }); } catch (e) { status = (e as { status?: number }).status ?? -1; }
  eq(status, 429, "33rd socket");
  eq(WS.closeSessionSockets(s2.sid), 32);
  for (const bad of ["ws://127.0.0.1:9/", "ws://localhost/", "wss://x.test/#frag", "ftp://x.test/", "ws://user:pw@x.test/"]) {
    let msg = "";
    try { WS.openBridge(s2, { url: bad, protocols: [] }); } catch (e) { msg = (e as Error).message; }
    ok(msg, `${bad} must be refused`);
  }
  const p = readFrames(WS.openBridge(s2, { url: "ws://10.1.2.3/", protocols: [] }));
  await waitFor(() => p.isDone(), 4000, "private IP close");
  const c = JSON.parse(p.frames[p.frames.length - 1].payload.toString());
  ok(c.code === 1006 && /private|reserved/.test(c.error), `private → ${JSON.stringify(c)}`);
  dropSession(s2.sid);
});

await test("bridge frame codec (WP-08): frames round-trip; a truncated header, a truncated payload and a declared length over the cap are refused", { "WP-08": "partial" }, () => {
  const b = Buffer.concat([WS.frame(2, "héllo"), WS.frame(3, Buffer.alloc(70000, 7)), WS.frame(0)]);
  eq(WS.parseFrames(b).map((f) => [f.type, f.payload.length]), [[2, 6], [3, 70000], [0, 0]]);
  for (const bad of [Buffer.from([2, 0, 0]), Buffer.from([2, 0, 0, 0, 5, 1]), Buffer.from([2, 0xff, 0xff, 0xff, 0xff])]) {
    let threw = false; try { WS.parseFrames(bad); } catch { threw = true; }
    ok(threw, `refused ${hex(bad)}`);
  }
});

await test("modal shortcuts fail (D): the obvious implementations are measurably wrong — a stock http.Agent with maxSockets 6 and an asynchronous createConnection opens one socket per parallel request; slicing a close reason at 123 bytes yields invalid UTF-8 (a conforming server answers 1007); our versions hold", { "WP-09": "partial", "WP-08": "partial" }, async () => {
  let opened = 0;
  const srv = http.createServer((_q, r) => setTimeout(() => r.end("x"), 50));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  class Stock extends http.Agent {
    createConnection(_o: http.ClientRequestArgs, cb: (e: Error | null, s?: net.Socket) => void) { opened++; const s = net.connect({ host: "127.0.0.1", port }, () => cb(null, s)); return undefined; }
  }
  const stock = new Stock({ keepAlive: true, maxSockets: 6 });
  await Promise.all(Array.from({ length: 12 }, () => new Promise<void>((res) => http.get({ host: "127.0.0.1", port, agent: stock }, (r) => { r.resume(); r.on("end", () => res()); }))));
  stock.destroy(); srv.close();
  ok(opened > 6, `the shortcut should overshoot, opened ${opened}`);
  const naive = Buffer.from("é".repeat(80)).subarray(0, 123);
  let invalid = false; try { new TextDecoder("utf-8", { fatal: true }).decode(naive); } catch { invalid = true; }
  ok(invalid, "byte slice must break UTF-8");
  console.log(`     stock Agent(maxSockets 6): ${opened} sockets for 12 parallel requests (ours: 6 — keep-alive test); naive reason slice: invalid UTF-8 (ours: cut at a character, server accepted 4000)`);
});

ka.close();
py.proc.kill();
void DIRECT;
await finish();
process.exit(process.exitCode ?? 0);
