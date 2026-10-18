import { DIRECT, parseRoute, type UpstreamRoute } from "./wp-tunnel";

/**
 * TT37: the server-wide upstream route of the Private proxy. RAM only (amnesic like the cookie jars): it starts
 * from the FUSION_WP_UPSTREAM environment variable — e.g. "socks5://127.0.0.1:9050" to send everything through a
 * local Tor — and a change made in the Browser lasts until the server restarts. A bad env value falls back to
 * Direct and is reported, never silently ignored.
 */
type State = { route: UpstreamRoute; envError: string | null; changed: number };
const g = globalThis as unknown as { __fusionWpRoute?: State };
function state(): State {
  if (!g.__fusionWpRoute) {
    let route = DIRECT, envError: string | null = null;
    try { route = parseRoute(process.env.FUSION_WP_UPSTREAM); } catch (e) { envError = (e as Error).message; }
    g.__fusionWpRoute = { route, envError, changed: 0 };
  }
  return g.__fusionWpRoute;
}
export function getRoute(): UpstreamRoute { return state().route; }
export function routeEnvError(): string | null { return state().envError; }
export function setRoute(r: UpstreamRoute): void { const s = state(); s.route = r; s.changed = Date.now(); }
