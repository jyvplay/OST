import { DIRECT, describeRoute, parseRoute, type UpstreamRoute } from "./wp-tunnel";
import { systemProxyFromEnv, systemProxyFromOs, systemRouteFor, type SystemProxy } from "./sysproxy";
import { readOsProxy } from "./osproxy";
import { PacScript, loadPac, parsePacResult } from "./pac";

/**
 * TT37: the server-wide upstream route of the Private proxy. RAM only (amnesic like the cookie jars): it starts
 * from the FUSION_WP_UPSTREAM environment variable — e.g. "socks5://127.0.0.1:9050" to send everything through a
 * local Tor — and a change made in the Browser lasts until the server restarts. A bad env value falls back to
 * Direct and is reported, never silently ignored.
 */
type PacState = { url: string; script: PacScript | null; error: string | null; at: number; last?: { host: string; result: string; chosen: string } };
type State = { route: UpstreamRoute; envError: string | null; changed: number; system: SystemProxy | null; useSystem: boolean; pac?: PacState };
const usable = (sp: SystemProxy | null) => !!(sp && (sp.https || sp.http || sp.pacUrl));
const g = globalThis as unknown as { __fusionWpRoute?: State };
function state(): State {
  if (!g.__fusionWpRoute) {
    let route = DIRECT, envError: string | null = null;
    const explicit = !!(process.env.FUSION_WP_UPSTREAM ?? "").trim();
    try { route = parseRoute(process.env.FUSION_WP_UPSTREAM); } catch (e) { envError = (e as Error).message; }
    // TT38 (WP-09): with no explicit Fusion setting, honour the computer's own proxy settings (https_proxy / no_proxy …)
    // the way browsers do — on a network that only lets traffic out through a proxy, Direct would simply fail
    let system = systemProxyFromEnv();
    // TT39: then a PAC file named for Fusion, then the operating system's own proxy page (Windows / macOS / GNOME)
    if (!explicit && !usable(system)) {
      const pacEnv = (process.env.FUSION_WP_PAC_URL ?? "").trim();
      if (pacEnv) system = { https: null, http: null, noProxy: "", source: ["FUSION_WP_PAC_URL"], errors: [], pacUrl: pacEnv };
      else if (process.env.FUSION_WP_OS_PROXY !== "0") {
        const os = readOsProxy();
        if (os.error) envError = [envError, os.error].filter(Boolean).join("; ");
        if (os.proxy) system = systemProxyFromOs(os.proxy);
      }
    }
    if (system?.errors.length) envError = [envError, ...system.errors].filter(Boolean).join("; ");
    g.__fusionWpRoute = { route, envError, changed: 0, system, useSystem: !explicit && usable(system) };
  }
  return g.__fusionWpRoute;
}
export function getRoute(): UpstreamRoute { const s = state(); return s.useSystem && s.system ? (s.system.https ?? s.system.http ?? DIRECT) : s.route; }
export function routeEnvError(): string | null { return state().envError; }
export function setRoute(r: UpstreamRoute): void { const s = state(); s.route = r; s.useSystem = false; s.changed = Date.now(); }
/** Switch to the computer's proxy settings; false when the environment has none. */
export function selectSystemRoute(): boolean { const s = state(); if (!usable(s.system)) return false; s.useSystem = true; s.changed = Date.now(); return true; }
export function systemRouteInfo() {
  const s = state();
  if (!s.system) return { available: false, active: false };
  return { available: usable(s.system), active: s.useSystem, source: s.system.source, noProxy: s.system.noProxy,
    https: s.system.https ? describeRoute(s.system.https) : null, http: s.system.http ? describeRoute(s.system.http) : null, errors: s.system.errors,
    pac: s.system.pacUrl ? { url: s.system.pacUrl, loaded: !!s.pac?.script, error: s.pac?.error ?? null, last: s.pac?.last ?? null } : null };
}
/** The route for ONE target: the chosen route, or under system settings the scheme's proxy unless no_proxy says direct. */
export function routeFor(target: URL): UpstreamRoute {
  const s = state();
  if (!s.useSystem || !s.system) return s.route;
  const r = systemRouteFor(s.system, target);
  return r === "direct" || r === null ? { ...DIRECT, isolate: s.route.isolate } : r;
}

const PAC_RELOAD_MS = 5 * 60_000, PAC_RETRY_MS = 30_000;
async function pacFor(s: State, url: string): Promise<PacState> {
  const now = Date.now(), p = s.pac;
  if (p && p.url === url && now - p.at < (p.script ? PAC_RELOAD_MS : PAC_RETRY_MS)) return p;
  const next: PacState = { url, script: p?.url === url ? p.script : null, error: null, at: now };
  try { next.script = new PacScript(await loadPac(url)); }
  catch (e) { next.error = (e as Error).message; } // keep the last good script (if any) when a reload fails
  s.pac = next;
  return next;
}

/**
 * TT39: the route for ONE target, consulting a PAC file when the system settings name one. Browser behaviour: a PAC
 * file that cannot be fetched or that throws means DIRECT; an empty / unparsable answer means DIRECT; the first entry
 * Fusion can speak wins (DIRECT, PROXY/HTTP, SOCKS5). Entries Fusion cannot speak (HTTPS-to-proxy, SOCKS4, QUIC) are
 * skipped; if nothing usable is left the request is REFUSED rather than sent direct against the administrator's choice.
 */
export async function routeForAsync(target: URL): Promise<UpstreamRoute> {
  const s = state();
  if (!s.useSystem || !s.system?.pacUrl) return routeFor(target);
  const direct = { ...DIRECT, isolate: s.route.isolate };
  const pac = await pacFor(s, s.system.pacUrl);
  if (!pac.script) return direct;
  let result: string;
  try { result = await pac.script.find(target, { dns: process.env.FUSION_WP_PAC_DNS !== "0" }); }
  catch (e) { pac.error = (e as Error).message; return direct; }
  const entries = parsePacResult(result);
  const note = (chosen: string) => { pac.last = { host: target.hostname, result: result.slice(0, 200), chosen }; };
  if (!entries.length) { note("DIRECT (no usable answer)"); return direct; }
  for (const e of entries) {
    if (e.type === "DIRECT") { note("DIRECT"); return direct; }
    const hp = `${e.host!.includes(":") ? `[${e.host}]` : e.host}:${e.port}`;
    if (e.type === "PROXY" || e.type === "HTTP") { note(`PROXY ${hp}`); return parseRoute(`http://${hp}`, s.route.isolate); }
    if (e.type === "SOCKS5") { note(`SOCKS5 ${hp}`); return parseRoute(`socks5://${hp}`, s.route.isolate); }
  }
  note("refused");
  throw new Error(`the PAC file chose only proxies Fusion cannot use (${result.slice(0, 120)})`);
}
