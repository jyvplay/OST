import * as net from "node:net";
import * as tls from "node:tls";
import { createHash, randomBytes } from "node:crypto";

/**
 * TT37: the Private proxy's UPSTREAM ROUTE — how Fusion's server itself reaches the web. Original code, written
 * from the protocol documents (no proxy library):
 *   - SOCKS5, RFC 1928 (CONNECT only), with the target NAME sent to the proxy (ATYP 0x03), so the server does no
 *     DNS lookup of its own: no DNS leak, and .onion names work through Tor;
 *   - username / password sub-negotiation, RFC 1929 — used for Tor-style circuit isolation (IsolateSOCKSAuth:
 *     different credentials → different circuits), one identity per Private proxy session;
 *   - HTTP CONNECT, RFC 9110 §9.3.6, with Basic proxy credentials (RFC 7617).
 * Every read is bounded (sizes and a deadline), so a hostile or broken proxy cannot hang or flood the server.
 */
export type RouteMode = "direct" | "socks5" | "http";
export interface UpstreamRoute { mode: RouteMode; host: string; port: number; username?: string; password?: string; isolate: boolean }
export const DIRECT: UpstreamRoute = { mode: "direct", host: "", port: 0, isolate: true };

/** Parse "direct", "socks5://[user:pass@]host:port", "socks5h://…" (same: names always go to the proxy), "http://[user:pass@]host:port". */
export function parseRoute(spec: string | undefined | null, isolate = true): UpstreamRoute {
  const s = String(spec ?? "").trim();
  if (!s || s === "direct") return { ...DIRECT, isolate };
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`upstream route: not a proxy address: ${s.slice(0, 80)}`); }
  const mode: RouteMode | null = u.protocol === "socks5:" || u.protocol === "socks5h:" ? "socks5" : u.protocol === "http:" ? "http" : null;
  if (!mode) throw new Error("upstream route: only socks5:// and http:// proxies are supported");
  const port = Number(u.port || (mode === "http" ? 8080 : 1080));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("upstream route: bad port");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("upstream route: missing host");
  const username = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  if ((username && Buffer.byteLength(username) > 255) || (password && Buffer.byteLength(password) > 255)) throw new Error("upstream route: credentials longer than 255 bytes");
  if (u.pathname && u.pathname !== "/") throw new Error("upstream route: a proxy address has no path");
  return { mode, host, port, username, password, isolate };
}

/** The route as shown to the user / API: never the password. */
export function describeRoute(r: UpstreamRoute): { mode: RouteMode; host: string; port: number; auth: boolean; isolate: boolean; label: string } {
  const label = r.mode === "direct" ? "Direct" : `${r.mode === "socks5" ? "SOCKS5" : "HTTP proxy"} ${r.host.includes(":") ? `[${r.host}]` : r.host}:${r.port}`;
  return { mode: r.mode, host: r.host, port: r.port, auth: !!r.username, isolate: r.isolate, label };
}

/**
 * Credentials that isolate one Private proxy session from every other (Tor gives each distinct SOCKS username /
 * password pair its own circuit). Derived, not stored: hash(server secret, session id, circuit counter). Fixed
 * credentials configured on the route win (a proxy that needs a real login).
 */
const SECRET = randomBytes(32);
export function isolationCredentials(route: UpstreamRoute, sessionId: string, circuit: number): { username: string; password: string } | undefined {
  if (route.username) return { username: route.username, password: route.password ?? "" };
  if (route.mode !== "socks5" || !route.isolate || !sessionId) return undefined;
  const h = createHash("sha256").update(SECRET).update(sessionId).update(String(circuit)).digest("hex");
  return { username: `fusion-${h.slice(0, 16)}`, password: h.slice(16, 48) };
}

// ------------------------------------------------------------------------------------------------ byte reader
/** Exact-length reads from a socket with one overall deadline; leftover bytes are pushed back for the next user. */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;
  private sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", this.onData);
    sock.on("error", this.onFail);
    sock.on("close", this.onClose);
  }
  private onData = (b: Buffer) => { this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b; if (this.buf.length > 70_000) this.onFail(new Error("upstream proxy sent too much data during setup")); this.waiter?.(); };
  private onFail = (e: Error) => { this.failure ??= e; this.waiter?.(); };
  private onClose = () => { this.failure ??= new ProxyRouteError("upstream proxy closed the connection during setup"); this.waiter?.(); };
  async take(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.failure) throw this.failure;
      await new Promise<void>((r) => { this.waiter = r; });
      this.waiter = null;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** Read up to and including "\r\n\r\n", at most `max` bytes. */
  async takeHead(max: number): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\r\n\r\n");
      if (i >= 0) { const head = this.buf.subarray(0, i + 4).toString("latin1"); this.buf = this.buf.subarray(i + 4); return head; }
      if (this.buf.length > max) throw new Error("upstream proxy reply header too large");
      if (this.failure) throw this.failure;
      await new Promise<void>((r) => { this.waiter = r; });
      this.waiter = null;
    }
  }
  /** Detach and return any bytes that arrived after the handshake (they belong to the tunnelled stream). */
  release(): Buffer {
    this.sock.off("data", this.onData); this.sock.off("error", this.onFail); this.sock.off("close", this.onClose);
    // stop the flow: without a listener a flowing socket would emit (and lose) bytes that arrive before the next
    // consumer (the HTTP parser) attaches; paused, they wait in the buffer together with the unshifted rest.
    // (TLS reads the native handle, not this buffer — harmless, since a TLS server cannot speak before ClientHello.)
    this.sock.pause();
    const rest = this.buf; this.buf = Buffer.alloc(0); return rest;
  }
}

const SOCKS_REPLY: Record<number, string> = {
  1: "general SOCKS server failure", 2: "connection not allowed by the proxy's rules", 3: "network unreachable",
  4: "host unreachable", 5: "connection refused by the destination", 6: "TTL expired", 7: "command not supported",
  8: "address type not supported",
  // Tor extended errors (Tor proposal 304), only for onion services
  0xf0: "onion service descriptor not found", 0xf1: "onion service descriptor is invalid", 0xf2: "onion service introduction failed",
  0xf3: "onion service rendezvous failed", 0xf4: "onion service needs client authorisation", 0xf5: "onion service client authorisation failed",
  0xf6: "onion address is invalid", 0xf7: "onion service introduction timed out",
};

export class ProxyRouteError extends Error {
  readonly reply?: number;
  constructor(message: string, reply?: number) { super(message); this.name = "ProxyRouteError"; this.reply = reply; }
}

function connectTcp(host: string, port: number, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(Object.assign(new ProxyRouteError(`upstream proxy ${host}:${port} did not answer in time`), { code: "ETIMEDOUT" })); }, Math.max(1, deadline - Date.now()));
    sock.once("connect", () => { clearTimeout(t); resolve(sock); });
    sock.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(t); reject(Object.assign(new ProxyRouteError(`upstream proxy ${host}:${port} unreachable (${e.code ?? e.message})`), { code: e.code === "ECONNREFUSED" ? "EPROXYREFUSED" : e.code })); });
  });
}

/** SOCKS5 CONNECT bytes for a target (the same encoding every RFC 1928 client uses). Exported for the tests. */
export function socksConnectRequest(host: string, port: number): Buffer {
  const fam = net.isIP(host);
  let addr: Buffer;
  if (fam === 4) addr = Buffer.from([0x01, ...host.split(".").map(Number)]);
  else if (fam === 6) addr = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)]);
  else {
    const name = Buffer.from(host, "ascii"); // hostnames reach here already IDNA-encoded by URL parsing
    if (name.length < 1 || name.length > 255) throw new ProxyRouteError("host name too long for SOCKS5");
    addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
  }
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, Buffer.from([port >> 8, port & 0xff])]);
}
function ipv6Bytes(h: string): Buffer {
  const [head, tail] = h.includes("::") ? h.split("::") : [h, ""];
  const parse = (s: string) => (s ? s.split(":") : []).flatMap((p) => (p.includes(".") ? (() => { const b = p.split(".").map(Number); return [((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)]; })() : [p]));
  const a = parse(head), b = parse(tail);
  const groups = [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}

async function socks5Handshake(sock: net.Socket, host: string, port: number, cred: { username: string; password: string } | undefined): Promise<void> {
  const rd = new Reader(sock);
  let ok = false;
  try {
    sock.write(cred ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    const [ver, method] = await rd.take(2);
    if (ver !== 0x05) throw new ProxyRouteError("upstream proxy is not a SOCKS5 server");
    if (method === 0xff) throw new ProxyRouteError("SOCKS5 proxy accepted none of our authentication methods (it may need a username and password)");
    if (method === 0x02) {
      if (!cred) throw new ProxyRouteError("SOCKS5 proxy asked for a password that was never offered");
      const u = Buffer.from(cred.username), p = Buffer.from(cred.password);
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const [aver, status] = await rd.take(2);
      if (aver !== 0x01 || status !== 0x00) throw new ProxyRouteError("SOCKS5 proxy rejected the username / password");
    } else if (method !== 0x00) throw new ProxyRouteError(`SOCKS5 proxy chose an unsupported method (${method})`);
    sock.write(socksConnectRequest(host, port));
    const [rver, rep, , atyp] = await rd.take(4);
    if (rver !== 0x05) throw new ProxyRouteError("malformed SOCKS5 reply");
    if (rep !== 0x00) throw new ProxyRouteError(`SOCKS5 proxy: ${SOCKS_REPLY[rep] ?? `error ${rep}`}`, rep);
    const alen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await rd.take(1))[0] : -1;
    if (alen < 0) throw new ProxyRouteError("malformed SOCKS5 reply (address type)");
    await rd.take(alen + 2);
    ok = true;
  } finally {
    const rest = rd.release();
    if (ok && rest.length) sock.unshift(rest); // bytes after the handshake belong to the tunnelled stream
  }
}

async function httpConnectHandshake(sock: net.Socket, host: string, port: number, cred: { username: string; password: string } | undefined): Promise<void> {
  const rd = new Reader(sock);
  let ok = false;
  try {
    const authority = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
    const auth = cred ? `Proxy-Authorization: Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}\r\n` : "";
    sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
    const head = await rd.takeHead(16_384);
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
    if (!m) throw new ProxyRouteError("upstream HTTP proxy sent a malformed reply");
    const code = Number(m[1]);
    if (code === 407) throw new ProxyRouteError("HTTP proxy needs credentials (407)");
    if (code < 200 || code > 299) throw new ProxyRouteError(`HTTP proxy refused the tunnel (${code})`);
    ok = true;
  } finally {
    const rest = rd.release();
    if (ok && rest.length) sock.unshift(rest); // bytes after the handshake belong to the tunnelled stream
  }
}

/**
 * A connected stream to host:port through the route (TLS on top when `secure`). The caller hands it to
 * http.request via createConnection. Deadline covers TCP + proxy handshake + TLS.
 */
export async function openTunnel(route: UpstreamRoute, host: string, port: number, o: { secure: boolean; servername?: string; cred?: { username: string; password: string }; timeoutMs: number }): Promise<net.Socket> {
  if (route.mode === "direct") throw new Error("openTunnel needs a proxy route");
  const deadline = Date.now() + o.timeoutMs;
  const sock = await connectTcp(route.host, route.port, deadline);
  const t = setTimeout(() => sock.destroy(Object.assign(new ProxyRouteError("upstream proxy handshake timed out"), { code: "ETIMEDOUT" })), Math.max(1, deadline - Date.now()));
  try {
    try {
      if (route.mode === "socks5") await socks5Handshake(sock, host, port, o.cred);
      else await httpConnectHandshake(sock, host, port, o.cred);
    } catch (e) {
      // during the handshake only the proxy is involved: whatever went wrong is the route's failure, not the site's
      if (e instanceof ProxyRouteError) throw e;
      throw Object.assign(new ProxyRouteError(`upstream proxy failed during setup (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`), { code: (e as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "ETIMEDOUT" : undefined });
    }
    if (!o.secure) return sock;
    return await new Promise<net.Socket>((resolve, reject) => {
      const s = tls.connect({ socket: sock, servername: o.servername && !net.isIP(o.servername) ? o.servername : undefined, ALPNProtocols: ["http/1.1"] });
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
    });
  } catch (e) {
    sock.destroy();
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Host names that must not be sent to an upstream proxy even though we no longer resolve them ourselves: a proxy
 * inside a network could reach internal names. Local / single-label / internal-suffix names are refused; .onion is
 * allowed only through SOCKS5 (Tor). IP literals are still checked by the caller's private-address guard.
 */
export function tunnelHostVerdict(route: UpstreamRoute, host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (net.isIP(h)) return null;
  if (!h.includes(".")) return "local/internal host names are refused (SSRF guard): single-label name";
  if (/\.(local|localhost|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/.test(h)) return "local/internal host names are refused (SSRF guard)";
  if (h.endsWith(".onion") && route.mode !== "socks5") return "onion addresses need the Tor (SOCKS5) route";
  return null;
}
