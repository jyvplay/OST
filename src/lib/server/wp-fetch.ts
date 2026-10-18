import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import { isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import { pipeline, Readable, Transform } from "node:stream";
import { isPrivateAddress, parsePublicWebUrl, resolvePinnedPublicHost } from "./netguard";
import { describeRoute, isolationCredentials, openTunnel, tunnelHostVerdict, type UpstreamRoute } from "./wp-tunnel";
import { getRoute } from "./wp-route";

/**
 * TT35: one upstream HTTP exchange for the proxy — any method, a bounded request body, streamed response.
 *  - SSRF: the host is resolved, every address checked public, and the socket pinned to the checked address
 *    (no DNS rebinding between check and connect); http/https only; no credentials in URLs.
 *  - Redirects are NOT followed here: the route rewrites Location so the browser follows them through the proxy,
 *    and each hop is checked again when it arrives.
 *  - Content-Encoding (gzip / deflate / br) is decoded server-side with a byte cap on the DECODED stream, so a
 *    decompression bomb stops at the cap instead of filling memory.
 */
export interface Upstream { status: number; headers: http.IncomingHttpHeaders; body: Readable; pinned: string }

export const WP_TIMEOUT_MS = 15_000;

export async function upstreamRequest(raw: string, o: { method: string; headers: Record<string, string>; body?: Buffer; maxBytes: number; timeoutMs?: number; session?: { sid: string; circuit: number }; route?: UpstreamRoute }): Promise<Upstream> {
  const url = parsePublicWebUrl(raw);
  const route = o.route ?? getRoute();
  if (route.mode !== "direct") return tunnelRequest(url, route, o);
  if (/\.onion\.?$/i.test(url.hostname)) throw new Error("onion addresses need the Tor (SOCKS5) route");
  const addrs = await resolvePinnedPublicHost(url.hostname);
  const addr = addrs.find((a) => a.family === 4) ?? addrs[0];
  if (!addr) throw new Error("DNS returned no usable public address");
  const timeoutMs = o.timeoutMs ?? WP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const lookup: LookupFunction = (_h, opts, cb) => {
      const a: LookupAddress = { address: addr.address, family: addr.family };
      if (opts.all) (cb as (e: NodeJS.ErrnoException | null, r: LookupAddress[]) => void)(null, [a]);
      else (cb as (e: NodeJS.ErrnoException | null, a: string, f: number) => void)(null, a.address, a.family);
    };
    const headers: Record<string, string> = { ...o.headers, host: url.host, connection: "close" };
    if (o.body && o.body.length) headers["content-length"] = String(o.body.length);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      protocol: url.protocol, hostname, port: url.port ? Number(url.port) : undefined, method: o.method,
      path: `${url.pathname}${url.search}`, lookup, headers,
      ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
    }, (res) => {
      clearTimeout(timer);
      resolve({ status: res.statusCode ?? 502, headers: res.headers, body: responseBody(res, o.maxBytes, () => req.destroy()), pinned: addr.address });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`request timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
}

/**
 * TT37: the same exchange through an upstream proxy (SOCKS5 / HTTP CONNECT). No local DNS: the NAME goes to the
 * proxy (no DNS leak, .onion works through Tor); IP literals are still checked private-or-not here, and local /
 * internal names are refused before anything is sent. Each Private proxy session gets its own SOCKS credentials,
 * so Tor keeps sessions (tabs, profiles) on separate circuits.
 */
function tunnelRequest(url: URL, route: UpstreamRoute, o: { method: string; headers: Record<string, string>; body?: Buffer; maxBytes: number; timeoutMs?: number; session?: { sid: string; circuit: number } }): Promise<Upstream> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && isPrivateAddress(hostname)) return Promise.reject(new Error(`refusing private/reserved address ${hostname}`));
  const verdict = tunnelHostVerdict(route, hostname);
  if (verdict) return Promise.reject(new Error(verdict));
  const secure = url.protocol === "https:";
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const timeoutMs = o.timeoutMs ?? WP_TIMEOUT_MS;
  const cred = isolationCredentials(route, o.session?.sid ?? "", o.session?.circuit ?? 0);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...o.headers, host: url.host, connection: "close" };
    if (o.body && o.body.length) headers["content-length"] = String(o.body.length);
    const createConnection = ((_opts: unknown, cb: (e: Error | null, s?: import("node:net").Socket) => void) => {
      openTunnel(route, hostname, port, { secure, servername: hostname, cred, timeoutMs }).then((s) => cb(null, s), (e) => cb(e));
      return undefined;
    }) as unknown as http.RequestOptions["createConnection"];
    // NO `agent` key: with agent:false Node builds a fresh Agent whose own createConnection (direct TCP + local DNS)
    // wins over ours — every "tunnelled" request would silently go direct (caught by tt37-unit: .onion → ENOTFOUND)
    const req = http.request({ protocol: "http:", hostname, port, method: o.method, path: `${url.pathname}${url.search}`, headers, createConnection }, (res) => {
      clearTimeout(timer);
      resolve({ status: res.statusCode ?? 502, headers: res.headers, body: responseBody(res, o.maxBytes, () => req.destroy()), pinned: `via ${describeRoute(route).label}` });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`request timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    // the tunnel comes back paused (so no byte is lost between handshake and parser); Node emits 'socket' after the
    // HTTP parser has attached its data listener — the right moment to let bytes flow
    req.on("socket", (sk) => sk.resume());
    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
}

/**
 * The response as one readable: decoded (gzip / deflate / br) and byte-capped. Built with stream.pipeline, so
 *  - an upstream reset mid-body ("aborted", ECONNRESET) becomes an error on the RETURNED stream, which the consumer
 *    handles (never an uncaught exception from an unlistened IncomingMessage), and
 *  - a consumer that goes away (the browser cancels a streamed response) tears down every stage AND the socket
 *    instead of leaving the upstream flowing.
 * Removes content-length / content-encoding from res.headers when it decodes.
 */
export function responseBody(res: http.IncomingMessage, maxBytes: number, onFail: () => void): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
  const decoder = enc === "gzip" || enc === "x-gzip" ? zlib.createGunzip() : enc === "deflate" ? zlib.createInflate() : enc === "br" ? zlib.createBrotliDecompress() : null;
  if (decoder) { delete res.headers["content-length"]; delete res.headers["content-encoding"]; }
  const cap = byteCap(maxBytes, onFail);
  const stages: NodeJS.ReadWriteStream[] = decoder ? [decoder, cap] : [cap];
  pipeline([res, ...stages] as unknown as [Readable, Transform], (err) => { if (err) { onFail(); res.destroy(); } });
  return cap;
}

/** A pass-through that errors once more than `max` bytes have flowed. */
export function byteCap(max: number, onTrip?: () => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      seen += chunk.length;
      if (seen > max) { onTrip?.(); cb(new Error(`response exceeds the ${Math.round(max / 1048576)} MB limit`)); return; }
      cb(null, chunk);
    },
  });
}

/** Buffer a whole body; past `max` bytes the source is destroyed and a size error thrown (memory stays bounded). */
export async function readAll(s: Readable, max = Infinity): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of s) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    n += b.length;
    if (n > max) { s.destroy(); throw new Error(`response exceeds the ${Math.round(max / 1048576)} MB limit`); }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/**
 * A node stream as a web ReadableStream for a Response body — pull-based (one chunk per pull, so a slow client
 * slows the upstream instead of filling memory). A client that goes away cancels: the source is destroyed and
 * nothing is enqueued afterwards (Readable.toWeb can throw "Controller is already closed" in that race). An
 * upstream failure mid-body errors the stream, so the client sees a cut connection, never a clean short file.
 */
export function toWebStream(src: Readable, onChunk?: (bytes: number) => void, onEnd?: () => void): ReadableStream<Uint8Array> {
  const it = src[Symbol.asyncIterator]();
  let over = false;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let r: IteratorResult<Buffer>;
      try { r = await it.next(); } catch (e) { if (!over) { over = true; ctrl.error(e); } return; }
      if (over) return;
      if (r.done) { over = true; onEnd?.(); ctrl.close(); return; }
      const b = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
      onChunk?.(b.length);
      ctrl.enqueue(new Uint8Array(b.buffer, b.byteOffset, b.length));
    },
    cancel() { over = true; src.destroy(); },
  }, { highWaterMark: 0 });
}

/** Decode a text body: charset from the header, else a <meta charset> sniff in the first 2 KB, else UTF-8. */
export function decodeText(buf: Buffer, contentType: string): string {
  let cs = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!cs && /html/i.test(contentType)) cs = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(buf.subarray(0, 2048).toString("latin1"))?.[1];
  try { return new TextDecoder(cs ?? "utf-8").decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}
