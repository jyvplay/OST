import { osBypassMatch, type OsProxy } from "./osproxy";
import { isIP } from "node:net";
import { parseRoute, type UpstreamRoute } from "./wp-tunnel";

/**
 * TT38 (WP-09): the computer's own proxy settings — the environment variables every command-line tool honours —
 * so Fusion's Private proxy works on networks that only allow traffic through a corporate / school proxy.
 * Original code; the semantics follow curl's documented behaviour (and are checked against curl itself in
 * tt38-unit):
 *  - https targets: https_proxy, then HTTPS_PROXY; http targets: http_proxy ONLY (the upper-case HTTP_PROXY is
 *    ignored, as curl does: in CGI it can be set by a request header — "httpoxy"); then all_proxy / ALL_PROXY.
 *  - no_proxy / NO_PROXY: comma- or space-separated; "*" alone bypasses everything; a name matches itself and its
 *    subdomains (a leading dot is optional, a trailing dot ignored); an entry with a port ("name:port") never matches, exactly as in curl 7.88; an IP literal
 *    matches itself; "a.b.c.d/nn" and "v6::/nn" match a CIDR range.
 * Proxy schemes: http://, socks5://, socks5h:// (an https:// proxy — TLS to the proxy itself — is reported as
 * unsupported rather than silently used in clear).
 */
export interface SystemProxy {
  https: UpstreamRoute | null; http: UpstreamRoute | null; noProxy: string; source: string[]; errors: string[];
  /** TT39: OS exception list (Windows ProxyOverride, macOS ExceptionsList, GNOME ignore-hosts) */
  bypass?: (host: string, port: number) => boolean;
  /** TT39: a proxy auto-config file decides per URL (OS setting or FUSION_WP_PAC_URL) */
  pacUrl?: string | null;
}

type Env = Record<string, string | undefined>;
const pick = (env: Env, ...names: string[]): [string, string] | null => {
  for (const n of names) { const v = env[n]; if (v && v.trim()) return [n, v.trim()]; }
  return null;
};

function routeOf(name: string, spec: string, errors: string[]): UpstreamRoute | null {
  // curl accepts a bare "host:port" and treats it as http://
  const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(spec) ? spec : `http://${spec}`;
  try { return parseRoute(s.replace(/\/+$/, "")); } catch (e) { errors.push(`${name}: ${(e as Error).message}`); return null; }
}

export function systemProxyFromEnv(env: Env = process.env): SystemProxy | null {
  const errors: string[] = [], source: string[] = [];
  const hs = pick(env, "https_proxy", "HTTPS_PROXY"), hp = pick(env, "http_proxy"), all = pick(env, "all_proxy", "ALL_PROXY");
  const https = hs ? routeOf(hs[0], hs[1], errors) : all ? routeOf(all[0], all[1], errors) : null;
  const http = hp ? routeOf(hp[0], hp[1], errors) : all ? routeOf(all[0], all[1], errors) : null;
  for (const x of [hs, hp, all]) if (x) source.push(x[0]);
  if (!https && !http && !errors.length) return null;
  const np = pick(env, "no_proxy", "NO_PROXY");
  if (np) source.push(np[0]);
  return { https, http, noProxy: np ? np[1] : "", source, errors };
}

function ipToBig(ip: string): { v: bigint; bits: number } | null {
  const f = isIP(ip);
  if (f === 4) return { v: ip.split(".").reduce((a, o) => (a << BigInt(8)) | BigInt(Number(o)), BigInt(0)), bits: 32 };
  if (f !== 6) return null;
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) { const n = ipToBig(v4[1])!.v; s = s.slice(0, -v4[1].length) + `${(n >> BigInt(16)).toString(16)}:${(n & BigInt(0xffff)).toString(16)}`; }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [], t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return { v: groups.reduce((a, g) => (a << BigInt(16)) | BigInt(parseInt(g || "0", 16)), BigInt(0)), bits: 128 };
}

/** Does `no_proxy` say "go direct" for this host (and port)? */
export function noProxyMatch(noProxy: string, host: string, port: number): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!h) return false;
  const entries = noProxy.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  for (const raw of entries) {
    if (raw === "*") return true;
    let e = raw.toLowerCase(), ePort: number | null = null;
    // "[v6]:port", "name:port", "v4:port" — but a bare IPv6 literal (many colons) has no port
    const b = /^\[([^\]]+)\](?::(\d+))?$/.exec(e);
    if (b) { e = b[1]; ePort = b[2] ? Number(b[2]) : null; }
    else if ((e.match(/:/g) ?? []).length === 1) { const i = e.lastIndexOf(":"); const p = e.slice(i + 1); if (/^\d+$/.test(p)) { ePort = Number(p); e = e.slice(0, i); } }
    // curl (7.88, measured by tt38-unit's differential) never matches an entry that carries a port — "intranet:8080"
    // does NOT bypass the proxy there, so it does not here either: one tool's rules, not a mix
    if (ePort !== null) { void port; continue; }
    const slash = e.indexOf("/");
    if (slash > 0) {
      const net = ipToBig(e.slice(0, slash)), me = ipToBig(h), len = Number(e.slice(slash + 1));
      if (!net || !me || net.bits !== me.bits || !Number.isInteger(len) || len < 0 || len > net.bits) continue;
      const shift = BigInt(net.bits - len);
      if ((net.v >> shift) === (me.v >> shift)) return true;
      continue;
    }
    if (isIP(e) || isIP(h)) { const a = ipToBig(e), c = ipToBig(h); if (a && c && a.bits === c.bits && a.v === c.v) return true; continue; }
    const name = e.replace(/^\*?\./, "").replace(/\.$/, "");
    if (name && (h === name || h.endsWith("." + name))) return true;
  }
  return false;
}

/** The route for one target under the system settings: the scheme's proxy unless no_proxy says direct. */
export function systemRouteFor(sp: SystemProxy, target: URL): UpstreamRoute | "direct" | null {
  const secure = target.protocol === "https:" || target.protocol === "wss:";
  const port = target.port ? Number(target.port) : secure ? 443 : 80;
  if (sp.noProxy && noProxyMatch(sp.noProxy, target.hostname, port)) return "direct";
  if (sp.bypass?.(target.hostname, port)) return "direct";
  return (secure ? sp.https : sp.http) ?? "direct";
}

/**
 * TT39: the OS settings (src/lib/server/osproxy.ts) as a SystemProxy. Like Chrome's manual rules, a protocol with no
 * proxy of its own uses the SOCKS proxy when one is set. A SOCKS entry is spoken as SOCKS5 (the only SOCKS version
 * Fusion's tunnel implements — Windows' "socks=" historically means SOCKS4; servers like Tor or `ssh -D` speak both).
 */
export function systemProxyFromOs(o: OsProxy): SystemProxy {
  const errors: string[] = [];
  const r = (name: string, hp: string | null, scheme: string) => (hp ? routeOf(name, `${scheme}://${hp}`, errors) : null);
  const socks = r(`${o.source} socks`, o.socks, "socks5");
  return {
    https: r(`${o.source} https`, o.https, "http") ?? socks,
    http: r(`${o.source} http`, o.http, "http") ?? socks,
    noProxy: "", source: [o.source], errors,
    bypass: o.bypass.length || o.bypassSimple ? (host) => osBypassMatch(o, host) : undefined,
    pacUrl: o.pacUrl,
  };
}
