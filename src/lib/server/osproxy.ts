/**
 * TT39: the operating system's proxy settings — what a user sets in the Windows "Proxy" settings page, macOS
 * Network → Proxies, or GNOME Settings → Network Proxy. Original parsers of each platform's documented tool output:
 *   Windows  `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` (ProxyEnable,
 *            ProxyServer "host:port" or "http=…;https=…;socks=…", ProxyOverride "<local>;*.corp", AutoConfigURL)
 *   macOS    `scutil --proxy` (HTTP/HTTPS/SOCKS Enable/Proxy/Port, ExceptionsList, ExcludeSimpleHostnames,
 *            ProxyAutoConfigEnable / ProxyAutoConfigURLString)
 *   GNOME    `gsettings list-recursively org.gnome.system.proxy` (mode none|manual|auto, autoconfig-url,
 *            ignore-hosts, http/https/socks host+port)
 * Read-only: nothing is ever written to the system settings.
 * TT40: + "Automatically detect settings" on every platform (→ WPAD discovery in wpad.ts): Windows' AutoDetect bit in the
 *   DefaultConnectionSettings blob (Connections key), macOS ProxyAutoDiscoveryEnable, GNOME mode 'auto' with an empty
 *   URL, KDE ProxyType=3; + KDE's ~/.config/kioslaverc ([Proxy Settings]); + Windows "socks=" read as SOCKS v4, as
 *   Chrome's ProxyRules does. Not covered (disclosed): DHCP option 252, macOS services other than the one scutil
 *   reports, proxy credentials in OS keychains, KDE's ReversedException (treated as "proxy everything").
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OsProxy {
  source: "windows-registry" | "macos-scutil" | "gnome-gsettings" | "kde-kioslaverc";
  /** TT40: the user ticked "Automatically detect settings" (WPAD). */
  autoDetect?: boolean;
  /** TT40: SOCKS protocol version of `socks` (Windows' socks= means v4 unless written socks5://). */
  socksVersion?: 4 | 5;
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
/** TT40: the flags byte of the DefaultConnectionSettings REG_BINARY blob (offset 8): 0x01 direct, 0x02 manual proxy,
 *  0x04 auto-config URL, 0x08 automatically detect settings. Returns null when the value is absent or too short. */
export function connectionFlags(regConnections: string): number | null {
  const m = /^\s+DefaultConnectionSettings\s+REG_BINARY\s+([0-9A-Fa-f]+)\s*$/m.exec(regConnections);
  if (!m || m[1].length < 18 || m[1].length % 2) return null;
  return parseInt(m[1].slice(16, 18), 16);
}
export function parseRegQuery(text: string, regConnections = ""): OsProxy | null {
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
        else if (/^socks$/i.test(k)) { out.socks = hpString(val); out.socksVersion = /^socks5h?:\/\//i.test(val) ? 5 : 4; }
      }
    } else { out.http = out.https = hpString(ps); } // one server for every protocol
    for (const e of (v.proxyoverride ?? "").split(";").map((x) => x.trim()).filter(Boolean)) {
      if (e.toLowerCase() === "<local>") out.bypassSimple = true; else out.bypass.push(e);
    }
  }
  const flags = connectionFlags(regConnections);
  if (flags !== null && flags & 0x08) out.autoDetect = true;
  return out.pacUrl || out.http || out.https || out.socks || out.autoDetect ? out : null;
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
    autoDetect: v.ProxyAutoDiscoveryEnable === "1",
  };
  return out.pacUrl || out.http || out.https || out.socks || out.autoDetect ? out : null;
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
  if (mode === "auto") { out.pacUrl = String(v["autoconfig-url"] ?? "").trim() || null; out.autoDetect = !out.pacUrl; } // empty URL = WPAD (GNOME docs)
  else if (mode === "manual") {
    out.http = hostPort(v["http.host"] as string, v["http.port"] as number);
    out.https = hostPort(v["https.host"] as string, v["https.port"] as number);
    out.socks = hostPort(v["socks.host"] as string, v["socks.port"] as number);
    out.bypass = Array.isArray(v["ignore-hosts"]) ? v["ignore-hosts"] : [];
  }
  return out.pacUrl || out.http || out.https || out.socks || out.autoDetect ? out : null;
}

/**
 * TT40: KDE Plasma — the [Proxy Settings] group of ~/.config/kioslaverc as System Settings writes it.
 *   ProxyType   0 none · 1 manual · 2 "Proxy Config Script" URL · 3 automatic detection (WPAD) · 4 from environment
 *   httpProxy / httpsProxy / socksProxy   "http://host:port" or KDE 5's "http://host port"; with ProxyType=4 they
 *               hold the NAMES of environment variables (e.g. "HTTP_PROXY")
 *   NoProxyFor  comma-separated (spaces tolerated)  ·  ReversedException  true = proxy only those (not representable)
 */
export function parseKioslaverc(text: string, env: Record<string, string | undefined> = process.env): OsProxy | null {
  const v: Record<string, string> = {};
  let inGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const g = /^\[(.*)\]$/.exec(line);
    if (g) { inGroup = g[1] === "Proxy Settings"; continue; }
    if (!inGroup) continue;
    const m = /^([^=\[]+?)(?:\[\$[a-z]+\])?\s*=\s*(.*)$/.exec(line); // KDE's "[$e]" (expand) / "[$i]" (immutable) markers
    if (m) v[m[1].trim()] = m[2].trim();
  }
  const type = Number(v.ProxyType ?? 0);
  const out: OsProxy = { source: "kde-kioslaverc", pacUrl: null, http: null, https: null, socks: null, bypass: [], bypassSimple: false, socksVersion: 5 };
  const kdeHp = (val: string | undefined): string | null => {
    if (!val) return null;
    let t = val.trim();
    if (type === 4) { t = (env[t] ?? env[t.toUpperCase()] ?? env[t.toLowerCase()] ?? "").trim(); if (!t) return null; }
    const sp = /^(\S+)\s+(\d{1,5})$/.exec(t); // "http://proxy 8080"
    if (sp) t = `${sp[1].replace(/\/+$/, "")}:${sp[2]}`;
    return hpString(t);
  };
  if (type === 1 || type === 4) {
    out.http = kdeHp(v.httpProxy); out.https = kdeHp(v.httpsProxy); out.socks = kdeHp(v.socksProxy);
    const list = type === 4 ? (env[v.NoProxyFor ?? ""] ?? env.no_proxy ?? env.NO_PROXY ?? "") : (v.NoProxyFor ?? "");
    out.bypass = list.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  } else if (type === 2) out.pacUrl = (v["Proxy Config Script"] ?? "").trim() || null;
  else if (type === 3) out.autoDetect = true;
  return out.pacUrl || out.http || out.https || out.socks || out.autoDetect ? out : null;
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
export type ReadText = (path: string) => string | null;
const realRead: ReadText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
export function kioslavercPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "kioslaverc");
}
export function readOsProxy(platform: string = process.platform, exec: Exec = realExec, read: ReadText = realRead, env: Record<string, string | undefined> = process.env): { proxy: OsProxy | null; error: string | null } {
  try {
    if (platform === "win32") {
      const ie = exec("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]);
      let conn = "";
      try { conn = exec("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections", "/v", "DefaultConnectionSettings"]); } catch { /* value absent: no auto-detect bit */ }
      return { proxy: parseRegQuery(ie, conn), error: null };
    }
    if (platform === "darwin") return { proxy: parseScutil(exec("scutil", ["--proxy"])), error: null };
    if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
      // KDE sessions use kioslaverc (as Chrome's KDE path does); others GNOME's gsettings, with kioslaverc as fallback
      const kde = /KDE/i.test(env.XDG_CURRENT_DESKTOP ?? "") || env.KDE_FULL_SESSION === "true";
      const kfile = () => { const t = read(kioslavercPath(env)); return t === null ? null : parseKioslaverc(t, env); };
      if (kde) { const k = kfile(); if (k) return { proxy: k, error: null }; }
      let gnome: OsProxy | null = null;
      try { gnome = parseGsettings(exec("gsettings", ["list-recursively", "org.gnome.system.proxy"])); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      return { proxy: gnome ?? (kde ? null : kfile()), error: null };
    }
    return { proxy: null, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { proxy: null, error: code === "ENOENT" ? null : `reading the system proxy settings failed: ${(e as Error).message.slice(0, 160)}` };
  }
}
