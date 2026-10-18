/**
 * TT39: the operating system's proxy settings — what a user sets in the Windows "Proxy" settings page, macOS
 * Network → Proxies, or GNOME Settings → Network Proxy. Original parsers of each platform's documented tool output:
 *   Windows  `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` (ProxyEnable,
 *            ProxyServer "host:port" or "http=…;https=…;socks=…", ProxyOverride "<local>;*.corp", AutoConfigURL)
 *   macOS    `scutil --proxy` (HTTP/HTTPS/SOCKS Enable/Proxy/Port, ExceptionsList, ExcludeSimpleHostnames,
 *            ProxyAutoConfigEnable / ProxyAutoConfigURLString)
 *   GNOME    `gsettings list-recursively org.gnome.system.proxy` (mode none|manual|auto, autoconfig-url,
 *            ignore-hosts, http/https/socks host+port)
 * Read-only: nothing is ever written to the system settings. Not covered (disclosed): WPAD auto-discovery
 * ("Automatically detect settings" / mode auto without a URL), KDE's kioslaverc, per-network-service settings on
 * macOS other than the active one scutil reports, proxy credentials stored in OS keychains.
 */
import { execFileSync } from "node:child_process";

export interface OsProxy {
  source: "windows-registry" | "macos-scutil" | "gnome-gsettings";
  pacUrl: string | null;
  http: string | null;   // "host:port"
  https: string | null;
  socks: string | null;
  bypass: string[];
  bypassSimple: boolean; // names without a dot go direct ("<local>" / ExcludeSimpleHostnames)
}

const hostPort = (h: string | undefined, p: string | number | undefined): string | null => {
  const host = String(h ?? "").trim(), port = Number(p);
  if (!host || !/^[A-Za-z0-9.\-:[\]]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
};
const hpString = (s: string): string | null => {
  const t = s.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(t);
  return m ? hostPort(m[1].replace(/^\[|\]$/g, ""), m[2] ?? 80) : null;
};

/** Windows: the text `reg query` prints for the Internet Settings key. */
export function parseRegQuery(text: string): OsProxy | null {
  const v: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(\S(?:.*?\S)?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*?))?\s*$/.exec(line);
    if (m) v[m[1].toLowerCase()] = m[2] === "REG_DWORD" ? String(parseInt(m[3] ?? "0", 16)) : (m[3] ?? "");
  }
  const enabled = v.proxyenable === "1", pacUrl = (v.autoconfigurl ?? "").trim() || null;
  const out: OsProxy = { source: "windows-registry", pacUrl, http: null, https: null, socks: null, bypass: [], bypassSimple: false };
  if (enabled && v.proxyserver) {
    const ps = v.proxyserver.trim();
    if (ps.includes("=")) {
      for (const part of ps.split(";")) {
        const [k, val] = part.split("=", 2).map((x) => x.trim());
        if (!val) continue;
        if (/^http$/i.test(k)) out.http = hpString(val);
        else if (/^https$/i.test(k)) out.https = hpString(val);
        else if (/^socks$/i.test(k)) out.socks = hpString(val);
      }
    } else { out.http = out.https = hpString(ps); } // one server for every protocol
    for (const e of (v.proxyoverride ?? "").split(";").map((x) => x.trim()).filter(Boolean)) {
      if (e.toLowerCase() === "<local>") out.bypassSimple = true; else out.bypass.push(e);
    }
  }
  return out.pacUrl || out.http || out.https || out.socks ? out : null;
}

/** macOS: the text `scutil --proxy` prints. */
export function parseScutil(text: string): OsProxy | null {
  const v: Record<string, string> = {}, arrays: Record<string, string[]> = {};
  let arr: string | null = null, depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "}") { depth--; if (depth <= 1) arr = null; continue; }
    const m = /^(\S+)\s*:\s*(.*)$/.exec(line);
    if (/^<dictionary>\s*\{$/.test(line)) { depth++; continue; }
    if (!m) continue;
    if (/^<array>\s*\{$/.test(m[2])) { depth++; if (depth === 2) { arr = m[1]; arrays[arr] = []; } continue; }
    if (/^<dictionary>\s*\{$/.test(m[2])) { depth++; continue; }
    if (arr && depth === 2) arrays[arr].push(m[2]);
    else if (depth === 1) v[m[1]] = m[2];
  }
  const on = (k: string) => v[`${k}Enable`] === "1";
  const out: OsProxy = {
    source: "macos-scutil",
    pacUrl: v.ProxyAutoConfigEnable === "1" ? (v.ProxyAutoConfigURLString ?? "").trim() || null : null,
    http: on("HTTP") ? hostPort(v.HTTPProxy, v.HTTPPort) : null,
    https: on("HTTPS") ? hostPort(v.HTTPSProxy, v.HTTPSPort) : null,
    socks: on("SOCKS") ? hostPort(v.SOCKSProxy, v.SOCKSPort) : null,
    bypass: arrays.ExceptionsList ?? [],
    bypassSimple: v.ExcludeSimpleHostnames === "1",
  };
  return out.pacUrl || out.http || out.https || out.socks ? out : null;
}

/** A GVariant text value as gsettings prints it: 'str', 123, true, ['a', 'b'], @as []. */
function gvariant(s: string): string | number | boolean | string[] {
  const t = s.trim().replace(/^@\w+\s+/, "");
  if (t.startsWith("[")) {
    const items: string[] = [], re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) items.push((m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
    return items;
  }
  const q = /^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (q) return (q[1] ?? q[2]).replace(/\\(.)/g, "$1");
  if (t === "true" || t === "false") return t === "true";
  const n = Number(t.replace(/^(?:uint32|int32)\s+/, ""));
  return Number.isFinite(n) ? n : t;
}

/** GNOME: the text `gsettings list-recursively org.gnome.system.proxy` prints. */
export function parseGsettings(text: string): OsProxy | null {
  const v: Record<string, ReturnType<typeof gvariant>> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^org\.gnome\.system\.proxy(\.[a-z]+)?\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (m) v[`${m[1] ? m[1].slice(1) + "." : ""}${m[2]}`] = gvariant(m[3]);
  }
  const mode = String(v.mode ?? "none");
  const out: OsProxy = { source: "gnome-gsettings", pacUrl: null, http: null, https: null, socks: null, bypass: [], bypassSimple: false };
  if (mode === "auto") out.pacUrl = String(v["autoconfig-url"] ?? "").trim() || null;
  else if (mode === "manual") {
    out.http = hostPort(v["http.host"] as string, v["http.port"] as number);
    out.https = hostPort(v["https.host"] as string, v["https.port"] as number);
    out.socks = hostPort(v["socks.host"] as string, v["socks.port"] as number);
    out.bypass = Array.isArray(v["ignore-hosts"]) ? v["ignore-hosts"] : [];
  }
  return out.pacUrl || out.http || out.https || out.socks ? out : null;
}

function v4(s: string): number | null {
  const p = s.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((a, x) => a * 256 + Number(x), 0);
}
/** Does one of the OS exception entries cover this host? (`<local>`/simple names, globs, ".suffix", CIDR incl. macOS "169.254/16".) */
export function osBypassMatch(p: Pick<OsProxy, "bypass" | "bypassSimple">, host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const ip = v4(h);
  if (p.bypassSimple && ip === null && !h.includes(".") && !h.includes(":")) return true;
  for (const raw of p.bypass) {
    const e = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (!e) continue;
    const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(e);
    if (cidr) {
      if (ip === null) continue;
      const parts = cidr[1].split(".").filter(Boolean);
      if (parts.length < 1 || parts.length > 4) continue;
      const base = v4([...parts, "0", "0", "0"].slice(0, 4).join(".")), bits = Number(cidr[2]);
      if (base === null || bits > 32) continue;
      const span = 2 ** (32 - bits);
      if (Math.floor(ip / span) === Math.floor(base / span)) return true;
      continue;
    }
    if (e.startsWith(".")) { if (h.endsWith(e) || h === e.slice(1)) return true; continue; }
    if (e.includes("*") || e.includes("?")) {
      const re = new RegExp("^" + e.replace(/[.+^${}()|[\]\\/-]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      if (re.test(h)) return true;
      continue;
    }
    if (h === e) return true;
  }
  return false;
}

export type Exec = (cmd: string, args: string[]) => string;
const realExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });

/** Read this computer's proxy settings (null when none are set or the platform tool is missing). */
export function readOsProxy(platform: string = process.platform, exec: Exec = realExec): { proxy: OsProxy | null; error: string | null } {
  try {
    if (platform === "win32") return { proxy: parseRegQuery(exec("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"])), error: null };
    if (platform === "darwin") return { proxy: parseScutil(exec("scutil", ["--proxy"])), error: null };
    if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return { proxy: parseGsettings(exec("gsettings", ["list-recursively", "org.gnome.system.proxy"])), error: null };
    return { proxy: null, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { proxy: null, error: code === "ENOENT" ? null : `reading the system proxy settings failed: ${(e as Error).message.slice(0, 160)}` };
  }
}
