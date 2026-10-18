import { DIRECT, describeRoute, parseRoute, type UpstreamRoute } from "./wp-tunnel";
import { systemProxyFromEnv, systemRouteFor, type SystemProxy } from "./sysproxy";

/**
 * TT37: the server-wide upstream route of the Private proxy. RAM only (amnesic like the cookie jars): it starts
 * from the FUSION_WP_UPSTREAM environment variable — e.g. "socks5://127.0.0.1:9050" to send everything through a
 * local Tor — and a change made in the Browser lasts until the server restarts. A bad env value falls back to
 * Direct and is reported, never silently ignored.
 */
type State = { route: UpstreamRoute; envError: string | null; changed: number; system: SystemProxy | null; useSystem: boolean };
const g = globalThis as unknown as { __fusionWpRoute?: State };
function state(): State {
  if (!g.__fusionWpRoute) {
    let route = DIRECT, envError: string | null = null;
    const explicit = !!(process.env.FUSION_WP_UPSTREAM ?? "").trim();
    try { route = parseRoute(process.env.FUSION_WP_UPSTREAM); } catch (e) { envError = (e as Error).message; }
    // TT38 (WP-09): with no explicit Fusion setting, honour the computer's own proxy settings (https_proxy / no_proxy …)
    // the way browsers do — on a network that only lets traffic out through a proxy, Direct would simply fail
    const system = systemProxyFromEnv();
    if (system?.errors.length) envError = [envError, ...system.errors].filter(Boolean).join("; ");
    g.__fusionWpRoute = { route, envError, changed: 0, system, useSystem: !explicit && !!(system && (system.https || system.http)) };
  }
  return g.__fusionWpRoute;
}
export function getRoute(): UpstreamRoute { const s = state(); return s.useSystem && s.system ? (s.system.https ?? s.system.http ?? DIRECT) : s.route; }
export function routeEnvError(): string | null { return state().envError; }
export function setRoute(r: UpstreamRoute): void { const s = state(); s.route = r; s.useSystem = false; s.changed = Date.now(); }
/** Switch to the computer's proxy settings; false when the environment has none. */
export function selectSystemRoute(): boolean { const s = state(); if (!s.system || (!s.system.https && !s.system.http)) return false; s.useSystem = true; s.changed = Date.now(); return true; }
export function systemRouteInfo() {
  const s = state();
  if (!s.system) return { available: false, active: false };
  return { available: !!(s.system.https || s.system.http), active: s.useSystem, source: s.system.source, noProxy: s.system.noProxy,
    https: s.system.https ? describeRoute(s.system.https) : null, http: s.system.http ? describeRoute(s.system.http) : null, errors: s.system.errors };
}
/** The route for ONE target: the chosen route, or under system settings the scheme's proxy unless no_proxy says direct. */
export function routeFor(target: URL): UpstreamRoute {
  const s = state();
  if (!s.useSystem || !s.system) return s.route;
  const r = systemRouteFor(s.system, target);
  return r === "direct" || r === null ? { ...DIRECT, isolate: s.route.isolate } : r;
}
