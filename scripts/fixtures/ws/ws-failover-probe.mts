// TT42 test helper (spawned by tt42-proxy): a fresh server-module process that picks its route up from the
// environment (PAC) exactly as at a real computer's start, opens a WebSocket BRIDGE (the code path proxied pages use)
// to PROBE_WS, sends PROBE_MSGS text messages + one binary, collects the echoes, closes, and prints one JSON line.
const { openBridge, sendToBridge, frame, FRAME } = await import("../../../src/lib/server/wp-ws.ts");
const { createSession } = await import("../../../src/lib/server/wp-sessions.ts");
const { systemRouteInfo } = await import("../../../src/lib/server/wp-route.ts");

const s = createSession("desktop");
const t0 = Date.now();
const out: Record<string, unknown> = { frames: [] as unknown[] };
const stream = openBridge(s, { url: process.env.PROBE_WS!, protocols: ["chat"], timeoutMs: 8000 });
const reader = stream.getReader();
let buf = Buffer.alloc(0), id = "";
const msgs = (process.env.PROBE_MSGS ?? "hello").split("|");
const got: string[] = [];
const deadline = Date.now() + 20000;
outer: while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buf = Buffer.concat([buf, Buffer.from(value)]);
  // frames: [type u8][len u32 BE][payload] — same framing the shim parses
  while (buf.length >= 5) {
    const type = buf[0], len = buf.readUInt32BE(1);
    if (buf.length < 5 + len) break;
    const payload = buf.subarray(5, 5 + len); buf = buf.subarray(5 + len);
    if (type === FRAME.KEEPALIVE) continue;
    if (type === FRAME.OPEN) {
      const o = JSON.parse(payload.toString()); id = o.id; out.open = { protocol: o.protocol, ms: Date.now() - t0 };
      for (const m of msgs) sendToBridge(s.sid, id, frame(FRAME.TEXT, m));
      sendToBridge(s.sid, id, frame(FRAME.BINARY, Buffer.from([0, 1, 2, 253, 254, 255])));
    } else if (type === FRAME.TEXT) got.push(payload.toString());
    else if (type === FRAME.BINARY) { got.push(`bin:${payload.toString("hex")}`); if (got.length >= msgs.length + 1) sendToBridge(s.sid, id, frame(FRAME.CLOSE, JSON.stringify({ code: 1000, reason: "done" }))); }
    else if (type === FRAME.CLOSE) { out.close = JSON.parse(payload.toString()); break outer; }
  }
}
const { createHash } = await import("node:crypto");
// echoes as length + SHA-256 (a 70 KB message must not be printed: process.exit can cut a large pipe write short)
out.echoes = got.map((g) => `${g.length}:${createHash("sha256").update(g).digest("hex").slice(0, 16)}`);
out.systemAfter = systemRouteInfo();
process.stdout.write(JSON.stringify(out) + "\n", () => process.exit(0));
