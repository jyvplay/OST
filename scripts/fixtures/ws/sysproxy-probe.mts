// TT38 test helper (spawned by tt38-unit with proxy variables in its environment): the server modules pick the
// system proxy up on their own, exactly as at a real computer's startup. Prints one JSON line.
const { upstreamRequest, readAll } = await import("../../../src/lib/server/wp-fetch.ts");
const { getRoute, systemRouteInfo } = await import("../../../src/lib/server/wp-route.ts");
const out: Record<string, unknown> = { route: getRoute().mode, system: systemRouteInfo() };
// TT40: PROBE_METHOD / PROBE_BODY (a POST survives failover byte-exact?), PROBE_ECHO=1 returns the body text,
// and `results` keeps every request in order (the same URL twice shows the bad-proxy memory)
const results: unknown[] = [];
const method = process.env.PROBE_METHOD ?? "GET", sent = process.env.PROBE_BODY;
for (const u of (process.env.PROBE_URLS ?? "").split(" ").filter(Boolean)) {
  const t0 = Date.now();
  try {
    const up = await upstreamRequest(u, { method, headers: { "user-agent": "fusion-probe", ...(sent !== undefined ? { "content-type": "text/plain" } : {}) }, body: sent !== undefined ? Buffer.from(sent) : undefined, maxBytes: 4 << 20, timeoutMs: 15000, session: { sid: "probe", circuit: 0 } });
    const body = await readAll(up.body, 4 << 20);
    out[u] = { status: up.status, via: up.pinned, bytes: body.length, ms: Date.now() - t0, ...(process.env.PROBE_ECHO === "1" ? { text: body.toString("utf8").slice(0, 2000) } : {}) };
  } catch (e) { out[u] = { error: (e as Error).message, ms: Date.now() - t0 }; }
  results.push({ url: u, ...(out[u] as object) });
}
out.results = results;
out.systemAfter = systemRouteInfo(); // TT39: includes the PAC file's last decision
console.log(JSON.stringify(out));
process.exit(0);
