/**
 * SSRF guard for server-side URL fetches.
 *
 * Critical design point: hostname validation alone is NOT sufficient. A
 * check-then-fetch using Node's ordinary fetch has a DNS-rebinding window
 * between lookup() and connect(). The caller must use the returned pinned
 * address in its socket lookup callback. Every DNS answer is checked; any
 * private/loopback/link-local/benchmark/documentation/reserved answer rejects
 * the whole hostname (mixed public+private is not accepted).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface PinnedAddress { address: string; family: 4 | 6 }

const ipv4Private = (addr: string): boolean => {
  const p = addr.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224; // multicast, reserved, broadcast
};

export function isPrivateAddress(addr: string): boolean {
  const v = addr.toLowerCase().split("%")[0];
  const family = isIP(v);
  if (family === 4) return ipv4Private(v);
  if (family !== 6) return true; // malformed/unknown -> deny
  if (v.startsWith("::ffff:")) return ipv4Private(v.slice(7));
  if (v === "::" || v === "::1") return true;
  // Only IPv6 global-unicast 2000::/3 is allowed. Reject ULA, link-local,
  // site-local, multicast, unspecified, NAT64 and all unassigned ranges.
  return !/^2[0-9a-f]{3}:/i.test(v);
}

/**
 * TT38 TEST-ONLY allowance: FUSION_WP_TEST_LOOPBACK_PORTS="18601,18602" lets the Private proxy reach 127.0.0.1 on
 * exactly those ports, so the test suites can run real local servers (WebSocket, SSE, slow / hostile peers) through
 * the full proxy path. Unset (the default, and every real deployment) it does nothing. Only 127.x literals are
 * allowed — no names, no other loopback or private address — and a server that has it set says so on stderr.
 */
let testPorts: Set<number> | null = null;
function loopbackTestPorts(): Set<number> {
  if (testPorts) return testPorts;
  const raw = process.env.FUSION_WP_TEST_LOOPBACK_PORTS ?? "";
  testPorts = new Set(raw.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 1024 && n < 65536));
  if (testPorts.size) console.warn(`[fusion] TEST-ONLY: the Private proxy may reach 127.0.0.1 on ports ${[...testPorts].join(", ")} (FUSION_WP_TEST_LOOPBACK_PORTS). Never set this outside tests.`);
  return testPorts;
}
export function testLoopbackAllowed(host: string, port: number): boolean {
  // TT39: any 127.x.y.z literal (127.0.0.2 is a different SITE from 127.0.0.1 — the cross-site isolation tests need
  // two); still no names, no ::1, no other private range, and only the listed ports
  return /^127\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host.replace(/^\[|\]$/g, "")) && loopbackTestPorts().has(port);
}

export function parsePublicWebUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid URL"); }
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.port && testLoopbackAllowed(url.hostname, Number(url.port))) return url;
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("credentials in URLs are refused");
  if ((url.protocol === "http:" && url.port && url.port !== "80") || (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new Error("only ports 80 and 443 are permitted by the URL-fetch policy");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new Error("local/internal hostnames are refused (SSRF guard)");
  }
  return url;
}

export async function resolvePinnedPublicHost(rawHost: string): Promise<PinnedAddress[]> {
  // TT35 fix: URL.hostname keeps the brackets of an IPv6 literal ("[::1]"); unbracketed, it is checked as an
  // ADDRESS (refused if private) instead of falling through to a DNS lookup that happened to fail.
  const host = rawHost.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family) {
    if (isPrivateAddress(host)) throw new Error(`refusing private/reserved address ${host}`);
    return [{ address: host, family: family as 4 | 6 }];
  }
  const rows = await lookup(host, { all: true, verbatim: true }).catch(() => [] as { address: string; family: number }[]);
  if (!rows.length) throw new Error(`DNS lookup failed for ${host}`);
  const bad = rows.find((r) => isPrivateAddress(r.address));
  if (bad) throw new Error(`refusing ${host}: at least one DNS answer is private/reserved (${bad.address})`);
  return rows.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}

export async function isPrivateHostGuard(rawUrl: string): Promise<string | null> {
  try {
    const url = parsePublicWebUrl(rawUrl);
    await resolvePinnedPublicHost(url.hostname);
    return null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}
