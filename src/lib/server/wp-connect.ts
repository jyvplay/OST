import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import type { Duplex } from "node:stream";
import { isPrivateAddress, resolvePinnedPublicHost, testLoopbackAllowed, type PinnedAddress } from "./netguard";
import { describeRoute, isolationCredentials, openTunnel, tunnelHostVerdict, type UpstreamRoute } from "./wp-tunnel";
import { onSessionEnd } from "./wp-sessions";

/**
 * TT38 (WP-09): the ONE place the Private proxy opens a connection to the outside world — for HTTP (through the
 * keep-alive pools below) and for WebSockets (src/lib/server/wp-ws.ts). Original code.
 *
 * Direct route, real networks:
 *  - every address DNS returns is validated (netguard: one private answer rejects the name) and only validated
 *    addresses are dialled — the DNS-rebinding guard of TT35 is kept;
 *  - the addresses are RACED, RFC 8305 style ("Happy Eyeballs v2", §4–5): families interleaved starting with the
 *    resolver's first choice, the next attempt starts 250 ms after the previous one or at once when it fails, the
 *    first connection wins and every other attempt is destroyed. A site with a dead IPv6 address, an IPv4-only
 *    phone network, or one of several A records down still loads — the single-address path it replaces did not;
 *  - the address actually used is reported (status line "via …").
 * Proxy routes: SOCKS5 / HTTP CONNECT (TT37, src/lib/server/wp-tunnel.ts): names go to the proxy, never to DNS here.
 *
 * Keep-alive: one pool per (session, route, circuit, scheme) — a page's dozens of subresources reuse a handful of
 * TCP/TLS connections instead of paying a handshake each (the old code sent `Connection: close` on every request),
 * while two sessions (tabs / profiles) never share a connection, so a site cannot link them through connection or
 * TLS-session reuse. "New circuit" and a route change start fresh pools.
 */

export const ATTEMPT_DELAY_MS = 250;

/** RFC 8305 §4: interleave address families, starting with the family of the resolver's first answer. */
export function orderAddresses(addrs: PinnedAddress[]): PinnedAddress[] {
  if (!addrs.length) return [];
  const first = addrs[0].family;
  const a = addrs.filter((x) => x.family === first), b = addrs.filter((x) => x.family !== first);
  const out: PinnedAddress[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
  return out;
}

export interface Attempt { address: string; startedMs: number; endedMs?: number; error?: string; won?: boolean }

/** Race TCP connections to already-validated addresses (see the header). Rejects with the first attempt's error code. */
export function connectPinned(addrs: PinnedAddress[], port: number, o: { timeoutMs: number; attemptDelayMs?: number; maxAttempts?: number; dial?: (a: PinnedAddress, port: number) => net.Socket }): Promise<{ socket: net.Socket; address: string; attempts: Attempt[] }> {
  const list = orderAddresses(addrs).slice(0, o.maxAttempts ?? 8);
  const delay = o.attemptDelayMs ?? ATTEMPT_DELAY_MS;
  const dial = o.dial ?? ((a: PinnedAddress, p: number) => net.connect({ host: a.address, port: p, family: a.family }));
  return new Promise((resolve, reject) => {
    if (!list.length) { reject(Object.assign(new Error("no address to connect to"), { code: "ENOTFOUND" })); return; }
    const t0 = Date.now(), attempts: Attempt[] = [], live = new Set<net.Socket>();
    let next = 0, failed = 0, settled = false, stagger: NodeJS.Timeout | null = null;
    const finish = (err: Error | null, win?: { socket: net.Socket; address: string }) => {
      if (settled) return; settled = true;
      clearTimeout(overall); if (stagger) clearTimeout(stagger);
      for (const s of live) if (s !== win?.socket) s.destroy();
      live.clear();
      if (err) reject(err); else resolve({ ...win!, attempts });
    };
    const overall = setTimeout(() => finish(Object.assign(new Error(`connect timed out after ${o.timeoutMs} ms (${attempts.map((a) => a.address).join(", ")})`), { code: "ETIMEDOUT", attempts })), o.timeoutMs);
    const start = () => {
      if (stagger) { clearTimeout(stagger); stagger = null; }
      if (settled || next >= list.length) return;
      const a = list[next++];
      const rec: Attempt = { address: a.address, startedMs: Date.now() - t0 };
      attempts.push(rec);
      const s = dial(a, port);
      live.add(s);
      s.once("connect", () => { rec.endedMs = Date.now() - t0; rec.won = true; s.removeAllListeners("error"); finish(null, { socket: s, address: a.address }); });
      s.once("error", (e: NodeJS.ErrnoException) => {
        rec.endedMs = Date.now() - t0; rec.error = e.code ?? e.message; live.delete(s); failed++;
        if (settled) return;
        if (failed === list.length) {
          const first = attempts.find((x) => x.error)!;
          finish(Object.assign(new Error(`could not connect to any of ${list.length} address${list.length > 1 ? "es" : ""}: ${attempts.map((x) => `${x.address} ${x.error}`).join("; ")}`), { code: first.error, attempts }));
        } else start(); // RFC 8305 §5: a failed attempt starts the next one at once
      });
      if (next < list.length) stagger = setTimeout(start, delay);
    };
    start();
  });
}

/** TLS over an established socket; the certificate is verified against `servername` (rejectUnauthorized stays on). */
export function tlsOver(sock: net.Socket, servername: string, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername: net.isIP(servername) ? undefined : servername, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => { t.destroy(); reject(Object.assign(new Error(`TLS handshake timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })); }, timeoutMs);
    t.once("secureConnect", () => { clearTimeout(timer); t.removeAllListeners("error"); resolve(t); });
    t.once("error", (e) => { clearTimeout(timer); sock.destroy(); reject(e); });
  });
}

export interface Opened { socket: Duplex; remote: string; attempts?: Attempt[] }

/**
 * A connected (and, for `secure`, TLS-verified) socket to host:port under `route`, or a classified error.
 * Direct: resolve + validate + race (above). Proxy: the TT37 tunnel (remote DNS at the proxy).
 */
export async function openUpstream(host: string, port: number, o: { secure: boolean; route: UpstreamRoute; session?: { sid: string; circuit: number }; timeoutMs: number }): Promise<Opened> {
  const h = host.replace(/^\[|\]$/g, "");
  if (o.route.mode !== "direct") {
    if (net.isIP(h) && isPrivateAddress(h)) throw new Error(`refusing private/reserved address ${h}`);
    const verdict = tunnelHostVerdict(o.route, h);
    if (verdict) throw new Error(verdict);
    const cred = isolationCredentials(o.route, o.session?.sid ?? "", o.session?.circuit ?? 0);
    const socket = await openTunnel(o.route, h, port, { secure: o.secure, servername: h, cred, timeoutMs: o.timeoutMs });
    return { socket, remote: `via ${describeRoute(o.route).label}` };
  }
  if (/\.onion\.?$/i.test(h)) throw new Error("onion addresses need the Tor (SOCKS5) route");
  const addrs: PinnedAddress[] = testLoopbackAllowed(h, port) ? [{ address: "127.0.0.1", family: 4 }] : await resolvePinnedPublicHost(h);
  const t0 = Date.now();
  const { socket, address, attempts } = await connectPinned(addrs, port, { timeoutMs: o.timeoutMs });
  if (!o.secure) return { socket, remote: address, attempts };
  const t = await tlsOver(socket, h, Math.max(1000, o.timeoutMs - (Date.now() - t0)));
  return { socket: t, remote: address, attempts };
}

// ------------------------------------------------------------------------------------------- keep-alive pools
export const PER_HOST = 6;

/** An http.Agent whose connections come from openUpstream (TLS already done for secure pools). */
export class UpstreamAgent extends http.Agent {
  lastUsed = Date.now();
  // Node's Agent counts a connection only once an ASYNCHRONOUS createConnection has called back, so its maxSockets
  // does not hold while connections are being opened (12 parallel requests → 12 sockets, measured). The limit is
  // therefore enforced here, per host, as browsers do for HTTP/1.1: a request waits for one of 6 slots.
  private slots = new Map<string, { active: number; wait: (() => void)[] }>();
  acquire(hostKey: string): Promise<() => void> {
    let s = this.slots.get(hostKey);
    if (!s) { s = { active: 0, wait: [] }; this.slots.set(hostKey, s); }
    const slot = s;
    const grant = (): (() => void) => {
      slot.active++;
      let done = false;
      return () => {
        if (done) return; done = true;
        slot.active--;
        const next = slot.wait.shift();
        if (next) next(); else if (!slot.active) this.slots.delete(hostKey);
      };
    };
    if (slot.active < PER_HOST) return Promise.resolve(grant());
    return new Promise((r) => slot.wait.push(() => r(grant())));
  }
  private readonly open: (host: string, port: number) => Promise<Opened>;
  constructor(open: (host: string, port: number) => Promise<Opened>) {
    super({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: PER_HOST, maxFreeSockets: 4, timeout: 30_000, scheduling: "lifo" });
    this.open = open;
  }
  // Node's Agent accepts an asynchronous createConnection (callback form) — used by every pooled request
  createConnection(options: http.ClientRequestArgs, cb: (err: Error | null, s?: Duplex) => void): Duplex | undefined {
    this.lastUsed = Date.now();
    this.open(String(options.host ?? options.hostname), Number(options.port)).then((r) => {
      (r.socket as Duplex & { fusionRemote?: string }).fusionRemote = r.remote;
      cb(null, r.socket);
    }, (e) => cb(e as Error));
    return undefined;
  }
}

type Pools = Map<string, UpstreamAgent>;
const gp = globalThis as unknown as { __fusionWpPools?: Pools };
const pools: Pools = (gp.__fusionWpPools ??= new Map());
const MAX_POOLS = 256, POOL_IDLE_MS = 5 * 60_000;

function sweepPools(now: number) {
  for (const [k, a] of pools) if (now - a.lastUsed > POOL_IDLE_MS) { a.destroy(); pools.delete(k); }
  while (pools.size >= MAX_POOLS) {
    let oldest: [string, UpstreamAgent] | null = null;
    for (const e of pools) if (!oldest || e[1].lastUsed < oldest[1].lastUsed) oldest = e;
    if (!oldest) break;
    oldest[1].destroy(); pools.delete(oldest[0]);
  }
}

/** The pool for one session under one route (a different route or circuit is a different pool). */
export function agentFor(route: UpstreamRoute, secure: boolean, session: { sid: string; circuit: number } | undefined, timeoutMs: number): UpstreamAgent {
  const sid = session?.sid ?? "anonymous";
  const key = JSON.stringify([sid, session?.circuit ?? 0, secure, route.mode, route.host, route.port, route.username ?? "", route.isolate]);
  let a = pools.get(key);
  if (!a) {
    sweepPools(Date.now());
    a = new UpstreamAgent((host, port) => openUpstream(host, port, { secure, route, session, timeoutMs }));
    pools.set(key, a);
  }
  a.lastUsed = Date.now();
  return a;
}

/** Close every pooled connection of a session (session closed, "New circuit"). */
export function dropPools(sid: string): number {
  let n = 0;
  for (const [k, a] of pools) if ((JSON.parse(k) as unknown[])[0] === sid) { a.destroy(); pools.delete(k); n++; }
  return n;
}
onSessionEnd("pools", (sid) => { dropPools(sid); });
export function poolStats(): { pools: number; sockets: number; free: number } {
  let sockets = 0, free = 0;
  for (const a of pools.values()) {
    for (const l of Object.values(a.sockets)) sockets += l?.length ?? 0;
    for (const l of Object.values(a.freeSockets)) free += l?.length ?? 0;
  }
  return { pools: pools.size, sockets, free };
}
