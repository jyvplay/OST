/**
 * TT40: WPAD — "Automatically detect settings". Original implementation of the DNS half of the Web Proxy
 * Auto-Discovery protocol (draft-ietf-wrec-wpad-01 §4.4 "DNS A record" method, as browsers deploy it):
 *
 *   1. http://wpad/wpad.dat            (the resolver's own search list completes the single label — Chrome's behaviour
 *                                       on every desktop platform)
 *   2. http://wpad.<suffix>/wpad.dat   walking DOWN each DNS search domain one label at a time ("devolution", the
 *                                       Windows behaviour) — but never above the REGISTRABLE domain: Microsoft's
 *                                       two-label floor still let "wpad.co.uk"-style names answer for a whole country
 *                                       (the well-known WPAD name-squatting problem); here
 *                                       the floor is the public-suffix-aware site, plus a conservative ccTLD rule.
 *
 * A candidate counts only when it answers 2xx with a script that defines FindProxyForURL (a web server that merely
 * happens to be called "wpad" does not hijack routing with an HTML page). Discovery runs only when the operating
 * system's settings ask for automatic detection (osproxy.ts) or FUSION_WP_WPAD=1 — never by default.
 * TT42: DHCP option 252 (dhcp-wpad.ts — lease files, and DHCPINFORM when port 68 can be bound) is tried FIRST.
 * Not covered (disclosed): mDNS/LLMNR names.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { isPublicSuffix, siteOf } from "../wp-core";

/** The pseudo URL that stands for "discover the PAC file" in SystemProxy.pacUrl. */
export const WPAD_URL = "wpad:auto";
export const WPAD_MAX_CANDIDATES = 8;

const GENERIC_SLD = new Set(["com", "net", "org", "co", "ac", "gov", "edu", "ne", "or", "go", "gob", "nic", "mil", "ltd", "plc", "sch"]);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** The highest name WPAD may devolve to for `domain` (inclusive): its registrable domain, never a public suffix. */
export function wpadFloor(domain: string): string | null {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const labels = d.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) return null;
  if (isPublicSuffix(d)) return null; // a search domain that IS a suffix (github.io): wpad.<it> is anyone's to register
  let floor = siteOf(d);
  // "<generic>.<cc>" (com.mx, co.za, ac.jp, gov.br …) is a public suffix even when the short built-in list lacks it
  const n = labels.length;
  if (labels[n - 1].length === 2 && GENERIC_SLD.has(labels[n - 2])) {
    if (n < 3) return null; // the domain IS a public suffix
    const cc = labels.slice(n - 3).join(".");
    if (cc.length > floor.length) floor = cc;
  }
  if (floor.split(".").length < 2 || (d !== floor && !d.endsWith("." + floor))) return null;
  return floor;
}

/** The ordered candidate URLs for a set of DNS search domains. */
export function wpadCandidates(domains: string[]): string[] {
  const out = ["http://wpad/wpad.dat"];
  for (const raw of domains) {
    const d = raw.trim().toLowerCase().replace(/\.$/, "");
    const floor = wpadFloor(d);
    if (!floor) continue;
    const labels = d.split(".");
    const stop = floor.split(".").length;
    for (let i = 0; labels.length - i >= stop; i++) {
      const u = `http://wpad.${labels.slice(i).join(".")}/wpad.dat`;
      if (!out.includes(u)) out.push(u);
      if (out.length >= WPAD_MAX_CANDIDATES) return out;
    }
  }
  return out;
}

export type Exec = (cmd: string, args: string[]) => string;
export type ReadText = (path: string) => string | null;
const realExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
const realRead: ReadText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** resolv.conf: "search a b c" / "domain x" (the last of either wins in glibc; both are offered here, search first). */
export function parseResolvConf(text: string): string[] {
  let search: string[] = [], domain: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(search|domain)\s+(.+?)\s*$/.exec(line.replace(/[#;].*$/, ""));
    if (!m) continue;
    const v = m[2].split(/\s+/).filter(Boolean);
    if (m[1] === "search") search = v; else domain = v.slice(0, 1);
  }
  return [...new Set([...search, ...domain])];
}
/** `scutil --dns`: "search domain[0] : corp.example.com" and "domain : corp.example.com". */
export function parseScutilDns(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:search domain\[\d+\]|domain)\s*:\s*(\S+)\s*$/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
/** `reg query HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters`: SearchList (comma list), Domain, NV Domain, DhcpDomain. */
export function parseTcpipReg(text: string): string[] {
  const v: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(\S(?:.*?\S)?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s{2,}(.*?)\s*$/.exec(line);
    if (m) v[m[1].toLowerCase()] = m[2];
  }
  const list = [...(v.searchlist ?? "").split(/[,\s]+/), v.domain, v["nv domain"], v.dhcpdomain].map((x) => (x ?? "").trim()).filter(Boolean);
  return [...new Set(list)];
}

/** This machine's DNS search domains (the input to devolution). */
export function searchDomains(platform: string = process.platform, exec: Exec = realExec, read: ReadText = realRead, host: string = osHostname()): string[] {
  const out: string[] = [];
  try {
    if (platform === "win32") out.push(...parseTcpipReg(exec("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters"])));
    else if (platform === "darwin") out.push(...parseScutilDns(exec("scutil", ["--dns"])));
  } catch { /* tool missing: fall through to the files / hostname */ }
  if (platform !== "win32") { const t = read("/etc/resolv.conf"); if (t) out.push(...parseResolvConf(t)); }
  const dot = host.indexOf(".");
  if (dot > 0) out.push(host.slice(dot + 1)); // an FQDN hostname names its domain
  return [...new Set(out.map((d) => d.toLowerCase().replace(/\.$/, "")).filter((d) => d && d !== "local" && !d.endsWith(".local")))];
}

export type WpadResult = { url: string; text: string; tried: string[] };
/** Try each candidate in order (each with its own timeout, all within `budgetMs`); the first real PAC file wins. */
export async function discoverWpad(o: { domains: string[]; load: (url: string, timeoutMs: number) => Promise<string>; perTryMs?: number; budgetMs?: number; first?: string[] }): Promise<WpadResult> {
  const tried: string[] = [];
  const end = Date.now() + (o.budgetMs ?? 12_000);
  const errors: string[] = [];
  for (const url of [...new Set([...(o.first ?? []), ...wpadCandidates(o.domains)])]) {
    const left = end - Date.now();
    if (left <= 50) { errors.push("time budget spent"); break; }
    tried.push(url);
    try {
      const text = await o.load(url, Math.min(o.perTryMs ?? 3000, left));
      if (!/\bfunction\s+FindProxyForURL(?:Ex)?\s*\(|\bFindProxyForURL(?:Ex)?\s*=/.test(text)) { errors.push(`${url}: not a PAC file`); continue; }
      return { url, text, tried };
    } catch (e) { errors.push(`${url}: ${(e as Error).message.slice(0, 80)}`); }
  }
  throw Object.assign(new Error(`WPAD: no PAC file found (${errors.slice(0, 4).join("; ")})`), { tried });
}
