// TT38 test helper (spawned by tt38-unit with proxy variables in its environment): the server modules pick the
// system proxy up on their own, exactly as at a real computer's startup. Prints one JSON line.
const { upstreamRequest, readAll } = await import("../../../src/lib/server/wp-fetch.ts");
const { getRoute, systemRouteInfo } = await import("../../../src/lib/server/wp-route.ts");
const out: Record<string, unknown> = { route: getRoute().mode, system: systemRouteInfo() };
for (const u of (process.env.PROBE_URLS ?? "").split(" ").filter(Boolean)) {
  try {
    const up = await upstreamRequest(u, { method: "GET", headers: { "user-agent": "fusion-probe" }, maxBytes: 4 << 20, timeoutMs: 15000, session: { sid: "probe", circuit: 0 } });
    const body = await readAll(up.body, 4 << 20);
    out[u] = { status: up.status, via: up.pinned, bytes: body.length };
  } catch (e) { out[u] = { error: (e as Error).message }; }
}
console.log(JSON.stringify(out));
process.exit(0);
