import * as http from "node:http";
import * as zlib from "node:zlib";
import { isIP } from "node:net";
import { pipeline, Readable, Transform } from "node:stream";
import { isPrivateAddress, parsePublicWebUrl, testLoopbackAllowed } from "./netguard";
import { describeRoute, tunnelHostVerdict, type UpstreamRoute } from "./wp-tunnel";
import { routesForAsync, withFailover } from "./wp-route";
import { agentFor } from "./wp-connect";

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

type UpstreamOpts = { method: string; headers: Record<string, string>; body?: Buffer; maxBytes: number; timeoutMs?: number; session?: { sid: string; circuit: number }; route?: UpstreamRoute };
/** TT40: with no explicit route, every candidate the system settings / PAC file give is tried in order (failover). */
export async function upstreamRequest(raw: string, o: UpstreamOpts): Promise<Upstream> {
  if (o.route) return upstreamVia(raw, o.route, o);
  const url = parsePublicWebUrl(raw);
  return withFailover(url, await routesForAsync(url), (r) => upstreamVia(raw, r, o));
}
async function upstreamVia(raw: string, route: UpstreamRoute, o: UpstreamOpts): Promise<Upstream> {
  const url = parsePublicWebUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // refusals that need no connection come first, with the same messages as before TT38
  if (route.mode === "direct" && /\.onion\.?$/i.test(hostname)) throw new Error("onion addresses need the Tor (SOCKS5) route");
  if (route.mode !== "direct") {
    if (isIP(hostname) && isPrivateAddress(hostname) && !testLoopbackAllowed(hostname, Number(url.port || (url.protocol === "https:" ? 443 : 80)))) throw new Error(`refusing private/reserved address ${hostname}`);
    const verdict = tunnelHostVerdict(route, hostname);
    if (verdict) throw new Error(verdict);
  }
  const secure = url.protocol === "https:";
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const timeoutMs = o.timeoutMs ?? WP_TIMEOUT_MS;
  const agent = agentFor(route, secure, o.session, timeoutMs);
  const idempotent = /^(GET|HEAD|OPTIONS|PUT|DELETE|TRACE)$/i.test(o.method);
  const once = async (): Promise<Upstream> => {
    const release = await agent.acquire(`${hostname}:${port}`); // ≤ 6 connections per host and session, as browsers
    try { return await attempt(release); } catch (e) { release(); throw e; }
  };
  const attempt = (release: () => void): Promise<Upstream> => new Promise((resolve, reject) => {
    // keep-alive (TT38): no "Connection: close" — the session's pool reuses the connection for the next request
    const headers: Record<string, string> = { ...o.headers, host: url.host };
    if (o.body && o.body.length) headers["content-length"] = String(o.body.length);
    // TLS (when secure) is already done by the pool's connection (src/lib/server/wp-connect.ts), so plain "http:"
    // framing is right here. NO `agent: false` anywhere: Node would then ignore the custom connection (TT37 finding).
    const req = http.request({ protocol: "http:", hostname, port, method: o.method, path: `${url.pathname}${url.search}`, headers, agent }, (res) => {
      clearTimeout(timer);
      const remote = (res.socket as unknown as { fusionRemote?: string } | null)?.fusionRemote ?? (route.mode === "direct" ? "" : `via ${describeRoute(route).label}`);
      resolve({ status: res.statusCode ?? 502, headers: res.headers, body: responseBody(res, o.maxBytes, () => req.destroy()), pinned: remote });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`request timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // a pooled connection the server closed while idle fails at once on reuse: retry an idempotent request on a fresh one
      // (what browsers do; Node documents req.reusedSocket for exactly this race)
      reject(Object.assign(e, { fusionRetry: req.reusedSocket && idempotent && (e.code === "ECONNRESET" || e.code === "EPIPE" || e.code === "ECONNABORTED") }));
    });
    // a tunnel comes back paused (no byte lost between handshake and parser); 'socket' fires after the parser attached
    req.on("socket", (sk) => sk.resume());
    req.once("close", release); // the exchange is over (body read, or failed): the slot goes to the next request
    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
  try { return await once(); }
  catch (e) { if ((e as { fusionRetry?: boolean }).fusionRetry) return once(); throw e; }
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
