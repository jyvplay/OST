import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connectWebSocket, closeCodeAllowedOnWire, type WsClient } from "./ws-client";
import { openUpstream } from "./wp-connect";
import { parsePublicWebUrl } from "./netguard";
import { routesForAsync, withFailover } from "./wp-route";
import { UA, sameSite } from "../wp-core";
import { onSessionEnd, type WpSession } from "./wp-sessions";

/**
 * TT38 (WP-08): WebSockets for pages in the Private proxy. Original code.
 *
 * A proxied page runs under a CSP sandbox whose connect-src is our own origin only, so a native `new WebSocket(
 * "wss://site")` can never leave the page (by design: nothing in the page talks to the internet directly). The shim
 * (public/wp-shim.js) replaces window.WebSocket with a spec-shaped class that talks to THIS bridge over plain
 * same-origin fetch — which works through every reverse proxy, CDN and mobile network that carries HTTP:
 *
 *   POST /api/wp/s/<sid>/__ws/open  {url, protocols, origin}  → a long streaming response of frames:
 *        [type u8][length u32 BE][payload]   type 0 keep-alive (every 20 s), 1 open {id, protocol, extensions},
 *        2 text (UTF-8), 3 binary, 4 close {code, reason, wasClean, error?}
 *   POST /api/wp/s/<sid>/__ws/<id>  a batch of the same frames, page → site: 2 text, 3 binary, 4 close {code, reason}
 *        → 204, or 410 when that socket is gone.  Ending the open stream (tab closed / navigated) closes upstream (1001).
 *
 * Upstream, the server is a real RFC 6455 client (src/lib/server/ws-client.ts) dialled through the same connection
 * layer as every proxied request (src/lib/server/wp-connect.ts: SSRF guard, Happy Eyeballs, TLS verification, the
 * network route incl. Tor/SOCKS, per-session isolation). The site sees what it would see from the page: the
 * session's User-Agent, the page's own Origin — proven by a per-document token, else "null" — and the session's
 * cookies for that host under SameSite rules (Set-Cookie on the 101 reply goes back into the session jar). Limits: 32 sockets per session, 256 in total, 16 MB per message.
 */

export const FRAME = { KEEPALIVE: 0, OPEN: 1, TEXT: 2, BINARY: 3, CLOSE: 4 } as const;
export const WS_PER_SESSION = 32, WS_TOTAL = 256, WS_MAX_MESSAGE = 16 * 1024 * 1024, KEEPALIVE_MS = 20_000;
const HIGH_WATER = 1024 * 1024; // bytes queued toward the page before upstream reading pauses (TCP backpressure to the site)

export function frame(type: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const p = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const h = Buffer.alloc(5);
  h[0] = type; h.writeUInt32BE(p.length, 1);
  return Buffer.concat([h, p]);
}
/** Split a buffer of frames; throws on a truncated or oversized frame. */
export function parseFrames(buf: Buffer, maxPayload = WS_MAX_MESSAGE): { type: number; payload: Buffer }[] {
  const out: { type: number; payload: Buffer }[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.length - i < 5) throw new Error("truncated frame header");
    const type = buf[i], len = buf.readUInt32BE(i + 1);
    if (len > maxPayload) throw new Error("frame too large");
    if (buf.length - i - 5 < len) throw new Error("truncated frame");
    out.push({ type, payload: buf.subarray(i + 5, i + 5 + len) });
    i += 5 + len;
  }
  return out;
}

interface Bridge { id: string; sid: string; url: string; ws: WsClient | null; end: (code: number, reason: string) => void }
const g = globalThis as unknown as { __fusionWpWs?: Map<string, Bridge> };
const bridges: Map<string, Bridge> = (g.__fusionWpWs ??= new Map());

export function wsStats(sid?: string): { total: number; session: number } {
  let n = 0;
  for (const b of bridges.values()) if (b.sid === sid) n++;
  return { total: bridges.size, session: n };
}
/** Close every socket of a session (session closed or swept). */
export function closeSessionSockets(sid: string): number {
  let n = 0;
  for (const b of [...bridges.values()]) if (b.sid === sid) { b.end(1001, "session closed"); n++; }
  return n;
}

onSessionEnd("ws", closeSessionSockets);

/** ws(s)://… or http(s)://… → the http(s) URL netguard checks (ports 80/443; test loopback allowlist). */
export function wsTarget(raw: string, base?: string): URL {
  let u: URL;
  try { u = new URL(raw, base); } catch { throw new Error("invalid WebSocket URL"); }
  if (u.protocol === "ws:") u.protocol = "http:"; else if (u.protocol === "wss:") u.protocol = "https:";
  if (u.hash) throw new Error("WebSocket URLs cannot have a fragment");
  return parsePublicWebUrl(u.href);
}

// ------------------------------------------------------------------------------------- the page's origin, verified
// A browser stamps a WebSocket handshake with the page's Origin and page script cannot change it — sites rely on that
// against cross-site WebSocket hijacking. Here the page tells the bridge its origin, so the claim must be proven:
// each proxied DOCUMENT gets a token = HMAC(server secret, sid | origin), injected only on navigations. A page that
// claims another origin (or has no valid token) is sent as Origin "null" — what browsers send for opaque initiators.
const gk = globalThis as unknown as { __fusionWsKey?: Buffer };
const KEY: Buffer = (gk.__fusionWsKey ??= randomBytes(32)); // per process: tokens die with the server, like sessions
export function originToken(sid: string, origin: string): string {
  return createHmac("sha256", KEY).update(`ws|${sid}|${origin}`).digest("base64url").slice(0, 32);
}
export function verifiedOrigin(sid: string, claimed: string | undefined, token: string | undefined): string | null {
  if (!claimed || !token) return null;
  let origin: string;
  try { const u = new URL(claimed); if (u.protocol !== "http:" && u.protocol !== "https:") return null; origin = u.origin; } catch { return null; }
  const want = Buffer.from(originToken(sid, origin)), got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got) ? origin : null;
}

export class WsOpenError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Validate synchronously (bad URL / limits → WsOpenError with an HTTP status), then return the frame stream.
 * `signal` is the page request's abort signal (tab gone → close upstream 1001).
 */
export function openBridge(s: WpSession, o: { url: string; protocols: string[]; origin?: string; token?: string; signal?: AbortSignal; timeoutMs?: number }): ReadableStream<Uint8Array> {
  const target = wsTarget(o.url);
  const st = wsStats(s.sid);
  if (st.session >= WS_PER_SESSION) throw new WsOpenError(429, `too many WebSockets in this tab (${WS_PER_SESSION})`);
  if (st.total >= WS_TOTAL) throw new WsOpenError(503, `too many WebSockets open (${WS_TOTAL})`);
  const verified = verifiedOrigin(s.sid, o.origin, o.token);
  const origin = verified ?? "null";
  // SameSite, as browsers apply it to the handshake: a cross-site (or unverified) page gets SameSite=None cookies only
  const crossSite = !verified || !sameSite(new URL(verified).hostname, target.hostname);
  const id = randomBytes(16).toString("hex");
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false, keep: NodeJS.Timeout | null = null;
  const b: Bridge = { id, sid: s.sid, url: target.href, ws: null, end: () => {} };
  const push = (buf: Buffer) => { if (!finished) try { ctrl.enqueue(new Uint8Array(buf)); } catch { /* stream already gone */ } };
  const finish = (code: number, reason: string, wasClean: boolean, error?: string) => {
    if (finished) return;
    push(frame(FRAME.CLOSE, JSON.stringify(error ? { code, reason, wasClean, error } : { code, reason, wasClean })));
    finished = true;
    bridges.delete(id);
    if (keep) clearInterval(keep);
    try { ctrl.close(); } catch { /* cancelled */ }
  };
  b.end = (code, reason) => { if (b.ws) b.ws.close(code, reason); else finish(1006, "", false, reason); };
  bridges.set(id, b);
  return new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      keep = setInterval(() => push(frame(FRAME.KEEPALIVE)), KEEPALIVE_MS);
      o.signal?.addEventListener("abort", () => { if (b.ws) b.ws.close(1001, ""); finished = true; bridges.delete(id); if (keep) clearInterval(keep); }, { once: true });
      const wsUrl = target.href.replace(/^http/, "ws");
      const headers: Record<string, string> = { "user-agent": UA[s.ua], "accept-language": "en-US,en;q=0.9", "sec-gpc": "1" };
      const cookie = s.jar.header(target, Date.now(), false, crossSite);
      if (cookie) headers.cookie = cookie;
      connectWebSocket({
        url: wsUrl, protocols: o.protocols, origin, headers, maxMessage: WS_MAX_MESSAGE, timeoutMs: o.timeoutMs ?? 15_000,
        open: async (host, port, secure) => (await withFailover(target, await routesForAsync(target), (route) => openUpstream(host, port, { secure, route, session: { sid: s.sid, circuit: s.circuit }, timeoutMs: o.timeoutMs ?? 15_000 }))).socket,
      }).then((r) => {
        // a cross-site handshake may only set SameSite=None cookies (Chrome blocks Lax / Strict from cross-site responses)
        for (const line of r.setCookies) if (!crossSite || /;\s*samesite\s*=\s*none\b/i.test(line)) s.jar.set(line, target);
        if (finished) { r.ws.close(1001, ""); return; } // the page gave up while we were connecting
        b.ws = r.ws;
        push(frame(FRAME.OPEN, JSON.stringify({ id, protocol: r.protocol, extensions: r.extensions })));
        r.ws.on("message", (data: string | Buffer, binary: boolean) => {
          s.lastUsed = Date.now();
          push(binary ? frame(FRAME.BINARY, data as Buffer) : frame(FRAME.TEXT, data as string));
          if ((ctrl.desiredSize ?? 0) <= 0) r.ws.pause();
        });
        r.ws.on("close", (code: number, reason: string, wasClean: boolean) => finish(code, reason, wasClean));
      }, (e: Error) => finish(1006, "", false, e.message));
    },
    pull() { b.ws?.resume(); },
    cancel() { if (b.ws) b.ws.close(1001, ""); finished = true; bridges.delete(id); if (keep) clearInterval(keep); },
  }, { highWaterMark: HIGH_WATER, size: (chunk) => chunk.byteLength });
}

/** Page → site frames for an open bridge. Returns the HTTP status for the reply. */
export function sendToBridge(sid: string, id: string, body: Buffer): number {
  const b = bridges.get(id);
  if (!b || b.sid !== sid) return 410; // another session's id is indistinguishable from a closed one
  if (!b.ws) return 409; // not open yet: the shim only sends after "open"
  let frames;
  try { frames = parseFrames(body); } catch { return 400; }
  for (const f of frames) {
    if (f.type === FRAME.TEXT) b.ws.send(f.payload.toString("utf8"), false);
    else if (f.type === FRAME.BINARY) b.ws.send(f.payload, true);
    else if (f.type === FRAME.CLOSE) {
      let j: { code?: number; reason?: string } = {};
      try { j = JSON.parse(f.payload.toString("utf8")); } catch { /* bare close */ }
      const code = typeof j.code === "number" && (j.code === 1000 || (j.code >= 3000 && j.code <= 4999)) && closeCodeAllowedOnWire(j.code) ? j.code : undefined;
      b.ws.close(code, code ? String(j.reason ?? "").slice(0, 123) : "");
    } else return 400;
  }
  return 204;
}
