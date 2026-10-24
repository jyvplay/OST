import { DIRECT, describeRoute, parseRoute, type UpstreamRoute } from "./wp-tunnel";
import { systemProxyFromEnv, systemProxyFromOs, systemRouteFor, type SystemProxy } from "./sysproxy";
import { readOsProxy } from "./osproxy";
import { PacScript, loadPac, parsePacResult, type PacEntry } from "./pac";
import { WPAD_URL, discoverWpad, searchDomains } from "./wpad";
import { dhcpWpadUrls } from "./dhcp-wpad";

/**
 * TT37: the server-wide upstream route of the Private proxy. RAM only (amnesic like the cookie jars): it starts
 * from the FUSION_WP_UPSTREAM environment variable — e.g. "socks5://127.0.0.1:9050" to send everything through a
 * local Tor — and a change made in the Browser lasts until the server restarts. A bad env value falls back to
 * Direct and is reported, never silently ignored.
 */
type PacState = { url: string; script: PacScript | null; error: string | null; at: number; last?: { host: string; result: string; chosen: string }; discovered?: string; tried?: string[]; dhcp?: string[] };
type State = { route: UpstreamRoute; envError: string | null; changed: number; system: SystemProxy | null; useSystem: boolean; pac?: PacState; pacLoading?: Promise<PacState> };
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
      else if (process.env.FUSION_WP_WPAD === "1") system = { https: null, http: null, noProxy: "", source: ["FUSION_WP_WPAD"], errors: [], pacUrl: WPAD_URL };
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
    pac: s.system.pacUrl ? { url: s.system.pacUrl, loaded: !!s.pac?.script, error: s.pac?.error ?? null, last: s.pac?.last ?? null,
      discovered: s.pac?.discovered ?? null, tried: s.pac?.tried ?? null, dhcp: s.pac?.dhcp ?? null } : null, failover: failoverInfo() };
}
/** The route for ONE target: the chosen route, or under system settings the scheme's proxy unless no_proxy says direct. */
export function routeFor(target: URL): UpstreamRoute {
  const s = state();
  if (!s.useSystem || !s.system) return s.route;
  const r = systemRouteFor(s.system, target);
  return r === "direct" || r === null ? { ...DIRECT, isolate: s.route.isolate } : r;
}

const PAC_RELOAD_MS = 5 * 60_000, PAC_RETRY_MS = 30_000, WPAD_RETRY_MS = 5 * 60_000;
/** TT40: the WPAD search domains — FUSION_WP_WPAD_DOMAINS (comma list) overrides the machine's own. */
const wpadDomains = () => { const e = (process.env.FUSION_WP_WPAD_DOMAINS ?? "").trim(); return e ? e.split(/[,\s]+/).filter(Boolean) : searchDomains(); };
async function pacFor(s: State, url: string): Promise<PacState> {
  const now = Date.now(), p = s.pac;
  const retry = url === WPAD_URL ? WPAD_RETRY_MS : PAC_RETRY_MS; // discovery costs seconds: retried less often
  if (p && p.url === url && now - p.at < (p.script ? PAC_RELOAD_MS : retry)) return p;
  if (s.pacLoading) return s.pacLoading; // one load at a time, shared by every request waiting on it
  s.pacLoading = (async () => {
    const next: PacState = { url, script: p?.url === url ? p.script : null, error: null, at: now, discovered: p?.discovered, tried: p?.tried };
    try {
      if (url === WPAD_URL) {
        // TT42: DHCP option 252 first (lease files; DHCPINFORM when port 68 can be bound) — FUSION_WP_WPAD_DHCP=0 skips it
        const dhcp = process.env.FUSION_WP_WPAD_DHCP === "0" ? [] : await dhcpWpadUrls({ inform: process.env.FUSION_WP_WPAD_INFORM !== "0" }).catch(() => []);
        next.dhcp = dhcp.map((x) => `${x.url} (${x.source})`); // recorded even when no candidate answers
        const w = await discoverWpad({ domains: wpadDomains(), load: (u, t) => loadPac(u, t), first: dhcp.map((x) => x.url) });
        next.script = new PacScript(w.text); next.discovered = w.url; next.tried = w.tried;
      } else next.script = new PacScript(await loadPac(url));
    } catch (e) { next.error = (e as Error).message; if (url === WPAD_URL) next.tried = (e as { tried?: string[] }).tried; } // keep the last good script
    s.pac = next;
    return next;
  })().finally(() => { s.pacLoading = undefined; });
  return s.pacLoading;
}

// ------------------------------------------------------------------ TT40: candidate lists, failover, bad proxies
/** Chrome keeps a failed proxy aside for 5 minutes ("proxy retry info") and tries it only after the healthy ones. */
export const BAD_PROXY_MS = 5 * 60_000;
const badKey = (r: UpstreamRoute) => `${r.mode}://${r.host}:${r.port}`;
const bad = (): Map<string, number> => ((globalThis as unknown as { __fusionBadProxies?: Map<string, number> }).__fusionBadProxies ??= new Map());
type FailoverNote = { at: number; host: string; from: string; to: string | null; error: string };
const failovers = (): FailoverNote[] => ((globalThis as unknown as { __fusionFailovers?: FailoverNote[] }).__fusionFailovers ??= []);
export function markProxyBad(r: UpstreamRoute, now = Date.now()): void { if (r.mode !== "direct") bad().set(badKey(r), now + BAD_PROXY_MS); }
export function isProxyBad(r: UpstreamRoute, now = Date.now()): boolean { const t = bad().get(badKey(r)); if (t === undefined) return false; if (t <= now) { bad().delete(badKey(r)); return false; } return true; }
export function noteFailover(host: string, from: UpstreamRoute, to: UpstreamRoute | null, error: string): void {
  const f = failovers(); f.push({ at: Date.now(), host, from: describeRoute(from).label, to: to ? describeRoute(to).label : null, error: error.slice(0, 160) }); if (f.length > 20) f.shift();
}
export function failoverInfo() { return { recent: failovers().slice(-5), bad: [...bad().entries()].filter(([, t]) => t > Date.now()).map(([k, t]) => ({ proxy: k, retryInMs: t - Date.now() })) }; }
/** Healthy candidates first in their own order, bad ones after (Chrome's DeprioritizeBadProxies). */
export function orderCandidates(list: UpstreamRoute[], now = Date.now()): UpstreamRoute[] {
  return [...list.filter((r) => !isProxyBad(r, now)), ...list.filter((r) => isProxyBad(r, now))];
}
/** PAC entry → route. PAC "SOCKS" means SOCKS4 (as in Chrome); QUIC is not spoken. */
export function pacEntryRoute(e: PacEntry, isolate: boolean): UpstreamRoute | null {
  if (e.type === "DIRECT") return { ...DIRECT, isolate };
  const hp = `${e.host!.includes(":") ? `[${e.host}]` : e.host}:${e.port}`;
  const scheme = e.type === "PROXY" || e.type === "HTTP" ? "http" : e.type === "HTTPS" ? "https" : e.type === "SOCKS5" ? "socks5" : e.type === "SOCKS" || e.type === "SOCKS4" ? "socks4" : null;
  if (!scheme) return null;
  try { return parseRoute(`${scheme}://${hp}`, isolate); } catch { return null; }
}

/**
 * TT39/TT40: every route to try for ONE target, in order. Without a PAC file: the single configured / system route.
 * With one — browser behaviour: a PAC file that cannot be fetched or that throws means DIRECT; an empty / unparsable
 * answer means DIRECT; otherwise every entry Fusion speaks (DIRECT, PROXY/HTTP, HTTPS, SOCKS/SOCKS4, SOCKS5), healthy
 * ones first. Only QUIC entries are skipped; a list of nothing usable is REFUSED (not sent direct against the
 * administrator's choice). Callers fail over to the next candidate when a proxy itself is down (ProxyRouteError.proxyDown).
 */
export async function routesForAsync(target: URL): Promise<UpstreamRoute[]> {
  const s = state();
  if (!s.useSystem || !s.system?.pacUrl) return [routeFor(target)];
  const direct = { ...DIRECT, isolate: s.route.isolate };
  const pac = await pacFor(s, s.system.pacUrl);
  // Chrome: when the automatic configuration (WPAD / PAC URL) cannot be used, the manual proxy settings apply; with
  // none, DIRECT. routeFor() is exactly that: the manual http/https proxy for the scheme, or direct.
  if (!pac.script) return [routeFor(target)];
  let result: string;
  try { result = await pac.script.find(target, { dns: process.env.FUSION_WP_PAC_DNS !== "0" }); }
  catch (e) { pac.error = (e as Error).message; return [direct]; }
  const entries = parsePacResult(result);
  const note = (chosen: string) => { pac.last = { host: target.hostname, result: result.slice(0, 200), chosen }; };
  if (!entries.length) { note("DIRECT (no usable answer)"); return [direct]; }
  const routes = entries.map((e) => pacEntryRoute(e, s.route.isolate)).filter((r): r is UpstreamRoute => r !== null);
  if (!routes.length) { note("refused"); throw new Error(`the PAC file chose only proxies Fusion cannot use (${result.slice(0, 120)})`); }
  const ordered = orderCandidates(routes);
  note(ordered.map((r) => (r.mode === "direct" ? "DIRECT" : describeRoute(r).label)).join(" → "));
  return ordered;
}
/** The first candidate (kept for callers that need one route). */
export async function routeForAsync(target: URL): Promise<UpstreamRoute> { return (await routesForAsync(target))[0]; }

/**
 * TT40: run `attempt` over the candidates; when a PROXY is down (unreachable, silent, broken handshake / TLS — never
 * when it answered about the destination or wants credentials) mark it bad for BAD_PROXY_MS and try the next. Safe for
 * any method: a proxy-setup failure happens before a single byte of the request reaches the site.
 */
export async function withFailover<T>(target: URL, candidates: UpstreamRoute[], attempt: (r: UpstreamRoute) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    try { return await attempt(r); }
    catch (e) {
      last = e;
      const down = (e as { name?: string; proxyDown?: boolean }).name === "ProxyRouteError" && (e as { proxyDown?: boolean }).proxyDown === true;
      if (!down || r.mode === "direct") throw e;
      markProxyBad(r);
      noteFailover(target.hostname, r, candidates[i + 1] ?? null, (e as Error).message);
    }
  }
  throw last;
}
