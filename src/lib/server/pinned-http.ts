import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import { parsePublicWebUrl, resolvePinnedPublicHost } from "./netguard";

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
 * GET a public HTTP(S) URL with an IP-pinned socket, bounded redirect chain,
 * bounded response bytes, no credentials/cookies, and an identity encoding.
 *
 * Security invariant: the address passed to the socket's `lookup` callback is
 * the exact address that netguard validated, so DNS cannot change between
 * check and connect (DNS-rebinding guard). Each redirect is independently
 * resolved, validated, and pinned before the next connection.
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
    const addresses = await resolvePinnedPublicHost(current.hostname);
    const addr = addresses.find((a) => a.family === 4) ?? addresses[0];
    if (!addr) throw new Error("DNS returned no usable public address");
    const response = await oneRequest(current, addr, maxBytes, timeoutMs);
    if (REDIRECTS.has(response.status) && response.headers.location) {
      if (hop >= maxRedirects) throw new Error(`redirect limit (${maxRedirects}) exceeded`);
      current = parsePublicWebUrl(new URL(response.headers.location, current).toString());
      continue;
    }
    return { ...response, finalUrl: current.toString(), pinnedAddress: addr.address, redirects: hop };
  }
  throw new Error("redirect limit exceeded");
}

function oneRequest(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  maxBytes: number,
  timeoutMs: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const lookupPinned: LookupFunction = (_host, opts, callback) => {
      const address: LookupAddress = { address: pinned.address, family: pinned.family };
      if (opts.all) (callback as (e: NodeJS.ErrnoException | null, r: LookupAddress[]) => void)(null, [address]);
      else (callback as (e: NodeJS.ErrnoException | null, addr: string, family: number) => void)(null, address.address, address.family);
    };
    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port ? Number(url.port) : undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      lookup: lookupPinned,
      ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
      headers: {
        Host: url.host,
        "User-Agent": "Mozilla/5.0 (compatible; FusionShellWeb-Proxy/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
        "Accept-Encoding": "identity",
        Connection: "close",
      },
    };
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(requestOptions, (res) => {
      const status = res.statusCode ?? 502;
      const headers = res.headers;
      // every exit path keeps an error listener: a reset while a body drains must not become an uncaught exception
      res.on("error", () => undefined);
      if (REDIRECTS.has(status) && headers.location) {
        res.resume();
        resolve({ status, headers, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer | string) => {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += b.length;
        if (bytes > maxBytes) {
          req.destroy(new Error(`response exceeds ${maxBytes}-byte limit`));
          return;
        }
        chunks.push(b);
      });
      res.on("end", () => resolve({ status, headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}
