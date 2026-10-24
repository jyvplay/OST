import { createHmac, timingSafeEqual } from "node:crypto";
import { blobType } from "./crypto";

/**
 * TT44 (TD-03): OpenSSH known_hosts (sshd(8) "SSH_KNOWN_HOSTS FILE FORMAT"), original code.
 * Reads plain and hashed (|1|salt|HMAC-SHA1) host fields, comma lists, `*` / `?` wildcards, `!` negation and
 * "[host]:port" for non-22 ports; honours @revoked. @cert-authority lines are skipped — certificates are not
 * supported (disclosed). Decision: a stored key of the same type that differs is a hard refusal ("changed"), never a
 * prompt; a host with no key of the offered type is "unknown" (the UI asks, showing the SHA256 fingerprint).
 */
export const KNOWN_HOSTS_PATH = "/System/ssh/known_hosts";

export interface KhEntry { marker: "" | "@revoked" | "@cert-authority"; hosts: string; type: string; blob: Buffer; comment: string; line: number }
export type HostKeyStatus = "known" | "unknown" | "changed" | "revoked";

export function hostToken(host: string, port: number): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return port === 22 ? h : `[${h}]:${port}`;
}

export function parseKnownHosts(text: string): { entries: KhEntry[]; bad: number[] } {
  const entries: KhEntry[] = [], bad: number[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const f = line.split(/\s+/);
    let marker: KhEntry["marker"] = "";
    if (f[0].startsWith("@")) { if (f[0] !== "@revoked" && f[0] !== "@cert-authority") { bad.push(i + 1); return; } marker = f.shift() as KhEntry["marker"]; }
    if (f.length < 3) { bad.push(i + 1); return; }
    const [hosts, type, b64, ...rest] = f;
    const blob = Buffer.from(b64, "base64");
    let actual = "";
    try { actual = blobType(blob); } catch { bad.push(i + 1); return; }
    if (actual !== type || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) { bad.push(i + 1); return; }
    entries.push({ marker, hosts, type, blob, comment: rest.join(" "), line: i + 1 });
  });
  return { entries, bad };
}

function wildcard(pat: string, s: string): boolean {
  // iterative glob: * any run, ? one char (case-insensitive like OpenSSH match_pattern on lowercased names)
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < s.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === s[t])) { p++; t++; }
    else if (p < pat.length && pat[p] === "*") { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/** does a known_hosts host field match this host/port? (hashed, lists, wildcards, negation) */
export function hostFieldMatches(field: string, host: string, port: number): boolean {
  const token = hostToken(host, port);
  if (field.startsWith("|1|")) {
    const [, , salt, hash] = field.split("|");
    if (!salt || !hash) return false;
    const want = Buffer.from(hash, "base64");
    const got = createHmac("sha1", Buffer.from(salt, "base64")).update(token).digest();
    return want.length === got.length && timingSafeEqual(want, got);
  }
  let pos = false;
  for (const raw of field.toLowerCase().split(",")) {
    const neg = raw.startsWith("!"); const pat = neg ? raw.slice(1) : raw;
    if (!pat) continue;
    if (wildcard(pat, token)) { if (neg) return false; pos = true; }
  }
  return pos;
}

export function checkHostKey(text: string, host: string, port: number, blob: Buffer): { status: HostKeyStatus; knownTypes: string[]; line?: number } {
  const type = blobType(blob);
  const { entries } = parseKnownHosts(text);
  const mine = entries.filter((e) => e.marker !== "@cert-authority" && hostFieldMatches(e.hosts, host, port));
  const rev = entries.find((e) => e.marker === "@revoked" && e.blob.equals(blob) && (e.hosts === "*" || hostFieldMatches(e.hosts, host, port)));
  const knownTypes = [...new Set(mine.filter((e) => e.marker === "").map((e) => e.type))];
  if (rev) return { status: "revoked", knownTypes, line: rev.line };
  const same = mine.find((e) => e.marker === "" && e.blob.equals(blob));
  if (same) return { status: "known", knownTypes, line: same.line };
  const clash = mine.find((e) => e.marker === "" && e.type === type);
  if (clash) return { status: "changed", knownTypes, line: clash.line };
  return { status: "unknown", knownTypes };
}

export function addHostKey(text: string, host: string, port: number, blob: Buffer, comment = ""): string {
  const line = `${hostToken(host, port)} ${blobType(blob)} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
}

/** removes the plain (non-marker) lines naming exactly this host — "forget host" */
export function forgetHost(text: string, host: string, port: number): { text: string; removed: number } {
  const lines = text.split("\n");
  let removed = 0;
  const keep = lines.filter((raw) => {
    const f = raw.trim().split(/\s+/);
    if (!raw.trim() || raw.trim().startsWith("#") || f[0].startsWith("@") || f.length < 3) return true;
    if (hostFieldMatches(f[0], host, port) && !/[*?!]/.test(f[0])) { removed++; return false; }
    return true;
  });
  return { text: keep.join("\n"), removed };
}
