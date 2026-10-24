import { NextResponse, type NextRequest } from "next/server";
import { readJsonObject } from "@/lib/http-json";
import { classifyError } from "@/lib/wp-core";
import { describeRoute, parseRoute, type UpstreamRoute } from "@/lib/server/wp-tunnel";
import { getRoute, routeEnvError, setRoute, systemRouteInfo, selectSystemRoute } from "@/lib/server/wp-route";
import { readAll, upstreamRequest } from "@/lib/server/wp-fetch";

/**
 * TT37 — the Private proxy's upstream network route (see src/lib/server/wp-tunnel.ts).
 *   GET                       → the route (never its password), the env error if FUSION_WP_UPSTREAM was bad
 *   PUT  {spec, isolate?}     → set it ("direct", "socks5://[user:pass@]host:port", "http://host:port", or "system":
 *                               the computer's https_proxy / http_proxy / all_proxy / no_proxy — TT38); RAM only
 *   POST {spec?, url?}        → test a route (the candidate or the current one) by fetching `url`
 *                               (default: the Tor Project's check service, which reports whether the exit is Tor)
 * Same-origin only for PUT / POST (the CSRF guard in src/proxy.ts), so a proxied page cannot re-route the server.
 */
export const dynamic = "force-dynamic";
const json = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { "cache-control": "no-store" } });
const TOR_CHECK = "https://check.torproject.org/api/ip";

export function GET() {
  return json({ route: describeRoute(getRoute()), system: systemRouteInfo(), envError: routeEnvError(), presets: [...(systemRouteInfo().available ? [{ id: "system", label: "System proxy settings", spec: "system" }] : []), { id: "direct", label: "Direct", spec: "direct" }, { id: "tor", label: "Tor (SOCKS5 127.0.0.1:9050)", spec: "socks5://127.0.0.1:9050" }, { id: "tor-browser", label: "Tor Browser's Tor (SOCKS5 127.0.0.1:9150)", spec: "socks5://127.0.0.1:9150" }] });
}

function routeFrom(b: Record<string, unknown>): UpstreamRoute {
  return parseRoute(typeof b.spec === "string" ? b.spec : "direct", b.isolate === undefined ? true : b.isolate === true);
}

export async function PUT(req: NextRequest) {
  const b = await readJsonObject(req);
  if (b instanceof Response) return b;
  if (b.spec === "system") {
    if (!selectSystemRoute()) return json({ error: "this computer has no proxy settings (https_proxy / http_proxy / all_proxy)" }, 400);
    return json({ route: describeRoute(getRoute()), system: systemRouteInfo() });
  }
  let r: UpstreamRoute;
  try { r = routeFrom(b); } catch (e) { return json({ error: (e as Error).message }, 400); }
  setRoute(r);
  return json({ route: describeRoute(r) });
}

export async function POST(req: NextRequest) {
  const b = await readJsonObject(req);
  if (b instanceof Response) return b;
  let r: UpstreamRoute;
  try { r = typeof b.spec === "string" && b.spec !== "system" ? routeFrom(b) : getRoute(); } catch (e) { return json({ error: (e as Error).message }, 400); }
  const url = typeof b.url === "string" && b.url ? b.url : TOR_CHECK;
  const t0 = Date.now();
  try {
    const up = await upstreamRequest(url, { method: "GET", maxBytes: 256 * 1024, timeoutMs: 20_000, route: r, session: { sid: "route-test", circuit: Date.now() }, headers: { accept: "application/json, text/html;q=0.9, */*;q=0.5", "accept-encoding": "gzip, br" } });
    const body = (await readAll(up.body, 256 * 1024)).toString("utf8");
    let tor: { IsTor?: boolean; IP?: string } | null = null;
    if (url === TOR_CHECK) { try { tor = JSON.parse(body); } catch { /* not JSON */ } }
    return json({ ok: up.status < 500, status: up.status, ms: Date.now() - t0, via: up.pinned, url, isTor: tor?.IsTor ?? null, exitIp: tor?.IP ?? null, bytes: body.length });
  } catch (e) {
    const c = classifyError(e);
    return json({ ok: false, kind: c.kind, message: c.message, ms: Date.now() - t0, url, route: describeRoute(r) });
  }
}
