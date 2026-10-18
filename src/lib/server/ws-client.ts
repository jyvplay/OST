import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

/**
 * TT38 (WP-08): a WebSocket CLIENT (RFC 6455), original code, no dependencies — the upstream half of the Private
 * proxy's WebSocket bridge. It runs over whatever transport the proxy's connection layer hands it (a pinned direct
 * TCP/TLS socket, or a SOCKS5 / HTTP CONNECT tunnel), so a proxied page's WebSockets follow the same SSRF rules,
 * the same network route and the same per-session isolation as its HTTP requests.
 *
 * Receive-side rules enforced (each failure closes with the code RFC 6455 §7.4.1 assigns):
 *  - server frames must not be masked; RSV1-3 must be 0 (we never offer an extension)          → 1002
 *  - only opcodes 0, 1, 2, 8, 9, 10; continuation only inside a fragmented message, and a new
 *    data frame never inside one                                                                → 1002
 *  - control frames: payload ≤ 125 bytes and never fragmented                                   → 1002
 *  - 64-bit lengths with the most significant bit set                                           → 1002
 *  - close payload of 1 byte, or a close code that may not appear on the wire                   → 1002
 *  - text messages and close reasons must be valid UTF-8                                        → 1007
 *  - a message larger than the configured cap                                                   → 1009
 * Handshake (§4.1): status 101, `Upgrade: websocket`, `Connection: upgrade`, Sec-WebSocket-Accept =
 * base64(SHA-1(key + GUID)), no extension we did not offer, no subprotocol we did not offer.
 */

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const OP = { CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 } as const;

export class WsProtocolError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.name = "WsProtocolError"; this.code = code; }
}

export function acceptFor(key: string): string { return createHash("sha1").update(key + WS_GUID).digest("base64"); }

/** Close codes a peer may send on the wire (RFC 6455 §7.4 + the IANA registry: 1012-1014; 3000-4999 private / registered). */
export function closeCodeAllowedOnWire(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true;
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
function strictUtf8(b: Buffer): string | null { try { return utf8.decode(b); } catch { return null; } }

/** One frame. Client frames are masked (mask key from crypto unless given, for test vectors). */
export function encodeFrame(opcode: number, payload: Buffer, o: { fin?: boolean; mask?: boolean; maskKey?: Buffer } = {}): Buffer {
  const fin = o.fin ?? true, mask = o.mask ?? true;
  const n = payload.length;
  const lenBytes = n < 126 ? 0 : n < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  head[1] = (mask ? 0x80 : 0) | (n < 126 ? n : n < 65536 ? 126 : 127);
  if (lenBytes === 2) head.writeUInt16BE(n, 2);
  else if (lenBytes === 8) head.writeBigUInt64BE(BigInt(n), 2);
  if (!mask) return Buffer.concat([head, payload]);
  const key = o.maskKey ?? randomBytes(4);
  key.copy(head, 2 + lenBytes);
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([head, out]);
}

export interface WsFrame { fin: boolean; opcode: number; payload: Buffer; masked: boolean; rsv: number }

/**
 * Incremental frame parser: push bytes as they arrive, get complete frames. Holds at most one partial frame;
 * a declared length above `maxFrame` fails before the payload is buffered (no memory blow-up from a lying header).
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxFrame: number;
  constructor(maxFrame: number) { this.maxFrame = maxFrame; }
  push(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: WsFrame[] = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0, rsv = (b[0] >> 4) & 0x07, opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big >> BigInt(63)) throw new WsProtocolError(1002, "64-bit payload length with the most significant bit set");
        if (big > BigInt(this.maxFrame)) throw new WsProtocolError(1009, `frame of ${big} bytes exceeds the ${this.maxFrame}-byte cap`);
        len = Number(big); off = 10;
      }
      if (len > this.maxFrame) throw new WsProtocolError(1009, `frame of ${len} bytes exceeds the ${this.maxFrame}-byte cap`);
      if (opcode >= 8 && len > 125) throw new WsProtocolError(1002, "control frame longer than 125 bytes"); // §5.5 — refused before buffering
      const maskOff = off; if (masked) off += 4;
      if (b.length < off + len) break;
      let payload = b.subarray(off, off + len);
      if (masked) { const k = b.subarray(maskOff, maskOff + 4); const p = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) p[i] = payload[i] ^ k[i & 3]; payload = p; }
      else payload = Buffer.from(payload); // own the bytes: the buffer is reused below
      out.push({ fin, opcode, payload, masked, rsv });
      this.buf = b.subarray(off + len);
    }
    return out;
  }
}

export interface HandshakeResult { protocol: string; extensions: string; setCookies: string[]; leftover: Buffer }

/** The opening handshake request (§4.1). `path` includes the query. */
export function handshakeRequest(o: { host: string; path: string; key: string; protocols: string[]; origin?: string; headers?: Record<string, string> }): string {
  const lines = [`GET ${o.path} HTTP/1.1`, `Host: ${o.host}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${o.key}`, "Sec-WebSocket-Version: 13"];
  if (o.origin) lines.push(`Origin: ${o.origin}`);
  if (o.protocols.length) lines.push(`Sec-WebSocket-Protocol: ${o.protocols.join(", ")}`);
  for (const [k, v] of Object.entries(o.headers ?? {})) if (!/[\r\n]/.test(k + v)) lines.push(`${k}: ${v}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

/** Validate the server's reply head (everything before the blank line). Throws with a plain reason on any violation. */
export function verifyHandshake(head: string, key: string, offered: string[]): Omit<HandshakeResult, "leftover"> {
  const lines = head.split("\r\n");
  const m = /^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "");
  if (!m) throw new Error(`not an HTTP/1.1 response: ${JSON.stringify((lines[0] ?? "").slice(0, 60))}`);
  if (m[1] !== "101") throw new Error(`the server answered ${m[1]} instead of switching protocols`);
  const h = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":"); if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    h.set(k, [...(h.get(k) ?? []), v]);
  }
  const one = (k: string) => (h.get(k) ?? []).join(", ");
  if (one("upgrade").toLowerCase() !== "websocket") throw new Error("missing 'Upgrade: websocket'");
  if (!one("connection").toLowerCase().split(/\s*,\s*/).includes("upgrade")) throw new Error("missing 'Connection: Upgrade'");
  if ((h.get("sec-websocket-accept") ?? []).length !== 1 || one("sec-websocket-accept") !== acceptFor(key)) throw new Error("wrong Sec-WebSocket-Accept");
  if (one("sec-websocket-extensions")) throw new Error(`the server chose an extension that was not offered (${one("sec-websocket-extensions").slice(0, 60)})`);
  const proto = one("sec-websocket-protocol");
  if (proto && (!offered.includes(proto) || (h.get("sec-websocket-protocol") ?? []).length !== 1)) throw new Error(`the server chose a subprotocol that was not offered (${proto.slice(0, 60)})`);
  return { protocol: proto, extensions: "", setCookies: h.get("set-cookie") ?? [] };
}

export interface WsClientOptions { maxMessage?: number; closeTimeoutMs?: number }

/**
 * An open connection. Events: 'message' (data: string | Buffer, binary: boolean), 'close' (code, reason, wasClean),
 * 'ping' / 'pong' (payload). `close()` runs the closing handshake; a protocol violation by the server sends the
 * right close code, then ends the transport.
 */
export class WsClient extends EventEmitter {
  readonly maxMessage: number;
  private parser: FrameParser;
  private frag: { opcode: number; parts: Buffer[]; size: number } | null = null;
  private sentClose = false;
  private gotClose: { code: number; reason: string } | null = null;
  private done = false;
  private closeTimer: NodeJS.Timeout | null = null;
  private readonly closeTimeoutMs: number;
  private readonly sock: Duplex;
  constructor(sock: Duplex, o: WsClientOptions = {}, leftover?: Buffer) {
    super();
    this.sock = sock;
    this.maxMessage = o.maxMessage ?? 16 * 1024 * 1024;
    this.closeTimeoutMs = o.closeTimeoutMs ?? 5000;
    this.parser = new FrameParser(this.maxMessage);
    sock.on("data", (c: Buffer) => this.onData(c));
    sock.on("error", () => this.finish(1006, "", false));
    sock.on("close", () => this.finish(this.gotClose?.code ?? 1006, this.gotClose?.reason ?? "", !!this.gotClose && this.sentClose));
    // Bytes glued to the handshake reply are frames. Deliver them on the next macrotask — after the caller's `await`
    // continuation has attached its listeners (a microtask would run first and drop them) — and only then resume
    // reading, so no newer bytes can overtake them.
    setImmediate(() => { if (leftover && leftover.length) this.onData(leftover); if (!this.done) sock.resume(); });
  }
  get closed(): boolean { return this.done; }
  get closing(): boolean { return this.sentClose || !!this.gotClose; }
  /** Pause / resume reading from the server (backpressure from a slow downstream reader). */
  pause(): void { this.sock.pause(); }
  resume(): void { this.sock.resume(); }

  send(data: string | Buffer, binary = typeof data !== "string"): void {
    if (this.sentClose || this.done) return;
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.sock.write(encodeFrame(binary ? OP.BINARY : OP.TEXT, payload));
  }
  ping(payload: Buffer = Buffer.alloc(0)): void { if (!this.sentClose && !this.done && payload.length <= 125) this.sock.write(encodeFrame(OP.PING, payload)); }

  /** Start (or answer) the closing handshake. code undefined → an empty close frame (status 1005 on the far side). */
  close(code?: number, reason = ""): void {
    if (this.sentClose || this.done) return;
    this.sentClose = true;
    let payload = Buffer.alloc(0);
    if (code !== undefined) {
      let r = Buffer.from(reason, "utf8");
      if (r.length > 123) { let n = 123; while (n > 0 && (r[n] & 0xc0) === 0x80) n--; r = r.subarray(0, n); } // never split a UTF-8 sequence (the far side would fail with 1007)
      payload = Buffer.alloc(2 + r.length); payload.writeUInt16BE(code, 0); r.copy(payload, 2);
    }
    this.sock.write(encodeFrame(OP.CLOSE, payload));
    if (this.gotClose) { this.sock.end(); this.arm(); return; } // we answered: the server closes TCP first, or we do after the timeout
    this.arm();
  }
  /** Drop the transport now (no handshake): 1006 to listeners. */
  terminate(): void { this.sock.destroy(); this.finish(1006, "", false); }

  private arm() {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => { this.sock.destroy(); this.finish(this.gotClose?.code ?? 1006, this.gotClose?.reason ?? "", !!this.gotClose); }, this.closeTimeoutMs);
    this.closeTimer.unref?.();
  }
  private fail(code: number, why: string) {
    this.emit("protocolError", code, why);
    if (!this.sentClose) {
      this.sentClose = true;
      const r = Buffer.from(why.slice(0, 120), "utf8").subarray(0, 123);
      const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
      try { this.sock.write(encodeFrame(OP.CLOSE, p)); } catch { /* transport already gone */ }
    }
    this.sock.end(); this.arm();
    this.finish(code, why, false);
  }
  private finish(code: number, reason: string, wasClean: boolean) {
    if (this.done) return;
    this.done = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.emit("close", code, reason, wasClean);
  }
  private onData(chunk: Buffer) {
    if (this.done) return;
    let frames: WsFrame[];
    try { frames = this.parser.push(chunk); } catch (e) { const pe = e as WsProtocolError; this.fail(pe.code ?? 1002, pe.message); return; }
    for (const f of frames) { if (this.done) return; this.onFrame(f); }
  }
  private onFrame(f: WsFrame) {
    if (f.masked) return this.fail(1002, "the server masked a frame");
    if (f.rsv) return this.fail(1002, "reserved bits set without a negotiated extension");
    const control = f.opcode >= 8;
    if (control) {
      if (f.opcode !== OP.CLOSE && f.opcode !== OP.PING && f.opcode !== OP.PONG) return this.fail(1002, `unknown control opcode ${f.opcode}`);
      if (!f.fin) return this.fail(1002, "fragmented control frame");
      if (f.payload.length > 125) return this.fail(1002, "control frame longer than 125 bytes");
      if (f.opcode === OP.PING) { this.emit("ping", f.payload); if (!this.sentClose) this.sock.write(encodeFrame(OP.PONG, f.payload)); return; }
      if (f.opcode === OP.PONG) { this.emit("pong", f.payload); return; }
      // close
      if (f.payload.length === 1) return this.fail(1002, "close frame with a 1-byte payload");
      let code = 1005, reason = "";
      if (f.payload.length >= 2) {
        code = f.payload.readUInt16BE(0);
        if (!closeCodeAllowedOnWire(code)) return this.fail(1002, `close code ${code} may not be sent`);
        const r = strictUtf8(f.payload.subarray(2));
        if (r === null) return this.fail(1007, "close reason is not valid UTF-8");
        reason = r;
      }
      this.gotClose = { code, reason };
      if (!this.sentClose) this.close(code === 1005 ? undefined : code, ""); // echo (§5.5.1), then wait for the server to close TCP
      else { this.sock.end(); this.arm(); }
      return;
    }
    if (this.gotClose) return; // data after the server's close frame is ignored
    if (f.opcode === OP.CONT) {
      if (!this.frag) return this.fail(1002, "continuation frame without a message to continue");
      this.frag.size += f.payload.length;
      if (this.frag.size > this.maxMessage) return this.fail(1009, `message exceeds the ${this.maxMessage}-byte cap`);
      this.frag.parts.push(f.payload);
      if (f.fin) { const { opcode, parts } = this.frag; this.frag = null; this.deliver(opcode, Buffer.concat(parts)); }
      return;
    }
    if (f.opcode !== OP.TEXT && f.opcode !== OP.BINARY) return this.fail(1002, `unknown data opcode ${f.opcode}`);
    if (this.frag) return this.fail(1002, "new message started inside a fragmented one");
    if (!f.fin) { this.frag = { opcode: f.opcode, parts: [f.payload], size: f.payload.length }; return; }
    this.deliver(f.opcode, f.payload);
  }
  private deliver(opcode: number, data: Buffer) {
    if (opcode === OP.TEXT) {
      const s = strictUtf8(data);
      if (s === null) return this.fail(1007, "text message is not valid UTF-8");
      this.emit("message", s, false);
    } else this.emit("message", data, true);
  }
}

export interface ConnectOptions extends WsClientOptions {
  /** ws:, wss:, http: or https: (the last two map to ws / wss, as browsers do since 2023) */
  url: string;
  protocols?: string[];
  origin?: string;
  headers?: Record<string, string>;
  /** the transport: a connected socket (TLS already established for secure URLs) */
  open: (host: string, port: number, secure: boolean) => Promise<Duplex>;
  timeoutMs?: number;
  maxHeaderBytes?: number;
}

/** Subprotocol tokens (RFC 7230 token), no duplicates — the WebSocket constructor's own rule (WHATWG). */
export function validProtocols(list: string[]): boolean {
  const seen = new Set<string>();
  for (const p of list) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p) || seen.has(p)) return false;
    seen.add(p);
  }
  return true;
}

/** Open a WebSocket: transport → handshake → WsClient. Rejects with a plain-language Error on any failure. */
export async function connectWebSocket(o: ConnectOptions): Promise<{ ws: WsClient } & HandshakeResult> {
  const u = new URL(o.url);
  const scheme = u.protocol === "http:" ? "ws:" : u.protocol === "https:" ? "wss:" : u.protocol;
  if (scheme !== "ws:" && scheme !== "wss:") throw new Error(`not a WebSocket URL (${u.protocol})`);
  if (u.hash) throw new Error("WebSocket URLs cannot have a fragment");
  const protocols = o.protocols ?? [];
  if (!validProtocols(protocols)) throw new Error("invalid or duplicate subprotocol");
  const secure = scheme === "wss:";
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  const timeoutMs = o.timeoutMs ?? 15_000, maxHeader = o.maxHeaderBytes ?? 16 * 1024;
  const sock = await o.open(u.hostname.replace(/^\[|\]$/g, ""), port, secure);
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0), settled = false;
    const done = (e: Error | null, r?: HandshakeResult) => {
      if (settled) return; settled = true;
      clearTimeout(timer); sock.off("data", onData); sock.off("error", onErr); sock.off("close", onClose);
      if (e) { sock.destroy(); reject(e); return; }
      sock.pause();
      resolve({ ws: new WsClient(sock, o, r!.leftover), ...r! });
    };
    const onData = (c: Buffer) => {
      head = Buffer.concat([head, c]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > maxHeader) done(new Error(`handshake reply header exceeds ${maxHeader} bytes`)); return; }
      try {
        const r = verifyHandshake(head.subarray(0, end).toString("latin1"), key, protocols);
        done(null, { ...r, leftover: head.subarray(end + 4) });
      } catch (e) { done(e as Error); }
    };
    const onErr = (e: Error) => done(new Error(`connection failed during the WebSocket handshake: ${e.message}`));
    const onClose = () => done(new Error("the server closed the connection during the WebSocket handshake"));
    const timer = setTimeout(() => done(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`)), timeoutMs);
    sock.on("data", onData); sock.on("error", onErr); sock.on("close", onClose);
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    sock.write(handshakeRequest({ host, path: `${u.pathname || "/"}${u.search}`, key, protocols, origin: o.origin, headers: o.headers }));
    sock.resume();
  });
}
