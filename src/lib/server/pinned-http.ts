import type * as http from "node:http";
import { parsePublicWebUrl } from "./netguard";
import { readAll, upstreamRequest } from "./wp-fetch";

export interface PinnedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
  pinnedAddress: string;
  redirects: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GET a public HTTP(S) URL for Fusion's own server-side fetchers (reader view of direct tabs, embed probe):
 * bounded redirect chain (each hop re-checked by netguard), bounded response bytes, no credentials or cookies.
 *
 * TT38: one connection layer for everything (src/lib/server/wp-connect.ts via upstreamRequest). The security
 * invariant is unchanged — every connection goes to an address netguard validated a moment before (no DNS
 * rebinding window) — and it gains what this file's old single-address path lacked on real networks: every
 * validated address is tried (IPv6 / IPv4 fallback), and the network route (Tor / proxy / system proxy) applies.
 */
export async function getPinnedPublic(
  raw: string,
  options: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<PinnedResponse> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRedirects = options.maxRedirects ?? 5;
  let current = parsePublicWebUrl(raw);
  const visited = new Set<string>();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (visited.has(current.toString())) throw new Error("redirect loop refused");
    visited.add(current.toString());
    const up = await upstreamRequest(current.href, {
      method: "GET", maxBytes, timeoutMs, session: { sid: "legacy-fetch", circuit: 0 },
      headers: { "user-agent": "Mozilla/5.0 (compatible; FusionShellWeb-Proxy/1.0)", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5", "accept-encoding": "identity" },
    });
    if (REDIRECTS.has(up.status) && up.headers.location) {
      up.body.resume();
      if (hop >= maxRedirects) throw new Error(`redirect limit (${maxRedirects}) exceeded`);
      current = parsePublicWebUrl(new URL(String(up.headers.location), current).toString());
      continue;
    }
    const body = await readAll(up.body, maxBytes);
    return { status: up.status, headers: up.headers, body, finalUrl: current.toString(), pinnedAddress: up.pinned, redirects: hop };
  }
  throw new Error("redirect limit exceeded");
}
