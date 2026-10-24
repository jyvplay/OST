import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import type { Duplex } from "node:stream";
import { SshClient, SshError, type HostKeyInfo, type SshChannel } from "./transport";
import { parsePrivateKey, KeyError, type SshPrivateKey } from "./keys";
import { SftpClient } from "./sftp";
import { KNOWN_HOSTS_PATH, addHostKey, checkHostKey, parseKnownHosts, hostFieldMatches } from "./known-hosts";
import { algsForKeyType } from "./crypto";
import { connectPinned, openUpstream } from "../wp-connect";
import { getRoute } from "../wp-route";
import { describeRoute } from "../wp-tunnel";
import { getNode, writeFile, ensureDir } from "../vfs";

/**
 * TT44 (TD-03): the browser ⇄ SSH bridge. The SSH client runs in this server process (a browser cannot open TCP);
 * the browser talks to it over same-origin HTTP only:
 *   GET  /api/ssh/<id>          one long-lived streamed response of frames [type u8][len u32 BE][payload]
 *                               0 keep-alive · 1 event (JSON) · 2 stdout · 3 stderr
 *   POST /api/ssh/<id>          a body of frames: 1 control (JSON: hostkey / auth answers / resize / signal / eof / close)
 *                               · 2 input bytes
 * Terminal output is acknowledged to the SSH channel only when the browser's stream actually takes it, so a slow tab
 * throttles the remote program (channel window) instead of growing memory here. Session ids are 128 random bits.
 * Secrets: a private key / passphrase / password is held in memory for the connection attempt only, never stored.
 * Host keys are never accepted silently: known → go; unknown → the user is asked (SHA256 fingerprint); changed or
 * @revoked → refused outright. Amnesic sessions can accept a key for the session but never write known_hosts.
 */

export const MAX_SESSIONS = 16;
const DETACHED_GRACE_MS = 120_000, KEEPALIVE_MS = 15_000, PROMPT_TIMEOUT_MS = 300_000;
const STREAM_HWM = 256 * 1024;

export interface SessionInit {
  host: string; port: number; username: string; cols: number; rows: number; term: string;
  privateKey?: string; passphrase?: string; direct?: boolean; amnesic: boolean; lang?: string;
}
type Event = Record<string, unknown> & { t: string };
type Pending = { kind: "hostkey"; resolve: (v: { accept: boolean; save: boolean }) => void } | { kind: "auth"; resolve: (v: string[] | null) => void };

const enc = (type: number, payload: Buffer) => { const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(payload.length, 1); return Buffer.concat([h, payload]); };

export class BridgeSession {
  readonly id = randomBytes(16).toString("hex");
  readonly created = Date.now();
  init: SessionInit;
  state: "new" | "connecting" | "hostkey" | "auth" | "ready" | "closed" = "new";
  client: SshClient | null = null;
  shell: SshChannel | null = null;
  private sftpP: Promise<SftpClient> | null = null;
  private frames: { buf: Buffer; ack: number }[] = [];
  private ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private detachedTimer: NodeJS.Timeout | null = null;
  private pending: Pending | null = null;
  private log: Event[] = []; // replayed to a re-attaching stream (status / prompts so far), bounded
  info: { fingerprint?: string; hostKeyAlg?: string; remote?: string; route?: string; authMethod?: string; server?: string } = {};

  constructor(init: SessionInit) { this.init = init; this.armDetached(); }

  // ----------------------------------------------------------------------------------------------- stream
  attach(): ReadableStream<Uint8Array> {
    if (this.ctl) { try { this.ctl.close(); } catch { /* the old tab went away */ } this.ctl = null; }
    if (this.detachedTimer) { clearTimeout(this.detachedTimer); this.detachedTimer = null; }
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        self.ctl = c;
        for (const e of self.log) c.enqueue(enc(1, Buffer.from(JSON.stringify(e))));
        if (self.state === "new") void self.connect();
      },
      pull() { self.drain(); },
      cancel() { if (self.ctl) { self.ctl = null; self.armDetached(); } },
    }, { highWaterMark: STREAM_HWM, size: (ch) => ch.byteLength });
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = setInterval(() => { if (this.ctl) this.frames.push({ buf: enc(0, Buffer.alloc(0)), ack: 0 }); this.drain(); }, KEEPALIVE_MS);
    this.keepalive.unref?.();
    return stream;
  }
  private armDetached(): void {
    if (this.detachedTimer) clearTimeout(this.detachedTimer);
    this.detachedTimer = setTimeout(() => { if (!this.ctl) this.close("no browser attached for 2 minutes"); }, DETACHED_GRACE_MS);
    this.detachedTimer.unref?.();
  }
  private drain(): void {
    const c = this.ctl;
    if (!c) return;
    while (this.frames.length && (c.desiredSize ?? 1) > 0) {
      const f = this.frames.shift()!;
      try { c.enqueue(f.buf); } catch { this.ctl = null; this.frames.unshift(f); this.armDetached(); return; }
      if (f.ack && this.shell) this.shell.ack(f.ack);
    }
  }
  event(e: Event, keep = false): void {
    if (keep) { this.log.push(e); if (this.log.length > 50) this.log.splice(0, this.log.length - 50); }
    this.frames.push({ buf: enc(1, Buffer.from(JSON.stringify(e))), ack: 0 });
    this.drain();
  }
  private output(type: 2 | 3, d: Buffer): void { this.frames.push({ buf: enc(type, d), ack: d.length }); this.drain(); }

  // ----------------------------------------------------------------------------------------------- prompts
  private ask<T extends Pending["kind"]>(kind: T, e: Record<string, unknown>): Promise<T extends "hostkey" ? { accept: boolean; save: boolean } : string[] | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (this.pending) { this.pending = null; (resolve as (v: unknown) => void)(kind === "hostkey" ? { accept: false, save: false } : null); } }, PROMPT_TIMEOUT_MS);
      this.pending = { kind, resolve: (v: unknown) => { clearTimeout(t); this.pending = null; this.log = this.log.filter((x) => x.t !== "prompt"); (resolve as (v: unknown) => void)(v); } } as Pending;
      this.event({ ...e, t: "prompt", kind }, true);
    });
  }
  /** a control frame from the browser */
  control(m: Record<string, unknown>): string | null {
    switch (m.t) {
      case "hostkey": if (this.pending?.kind !== "hostkey") return "no host-key question is pending"; this.pending.resolve({ accept: m.accept === true, save: m.save === true }); return null;
      case "auth": {
        if (this.pending?.kind !== "auth") return "no authentication question is pending";
        const a = m.answers === null ? null : Array.isArray(m.answers) ? m.answers.map((x) => String(x ?? "")) : null;
        if (a && a.some((x) => x.length > 8192)) return "answer too long";
        this.pending.resolve(a); return null;
      }
      case "resize": { const cols = Math.max(2, Math.min(1000, Number(m.cols) | 0)), rows = Math.max(1, Math.min(500, Number(m.rows) | 0)); this.init.cols = cols; this.init.rows = rows; this.shell?.resize(cols, rows); return null; }
      case "signal": { const n = String(m.name ?? ""); if (!/^(INT|TERM|HUP|KILL|QUIT|USR1|USR2)$/.test(n)) return "unknown signal"; this.shell?.signal(n); return null; }
      case "eof": this.shell?.eof(); return null;
      case "close": this.close("closed by the user"); return null;
      default: return "unknown control message";
    }
  }
  input(d: Buffer): void { if (this.shell && !this.shell.isClosed) this.shell.write(d); }

  // ----------------------------------------------------------------------------------------------- connect
  private async connect(): Promise<void> {
    this.state = "connecting";
    const { host, port, username } = this.init;
    try {
      this.event({ t: "status", text: `Connecting to ${host}:${port}…` }, true);
      const sock = await this.dial();
      this.event({ t: "status", text: `Connected (${this.info.remote}); exchanging keys…` }, true);
      const khText = await readKnownHosts();
      const prefer = [...new Set(parseKnownHosts(khText).entries.filter((e) => e.marker === "" && hostFieldMatches(e.hosts, host, port)).flatMap((e) => algsForKeyType(e.type)))];
      const c = new SshClient(sock, {
        username, preferHostKeyAlgs: prefer, verifyHostKey: (k) => this.verifyHostKey(k),
        auth: {
          loadKeys: this.init.privateKey ? async () => [await this.loadKey()] : undefined,
          password: async ({ attempt, message }) => {
            this.state = "auth";
            const a = await this.ask("auth", { method: "password", name: "", instruction: message ?? "", attempt, prompts: [{ prompt: `${username}@${host}'s password:`, echo: false }] });
            return a ? a[0] ?? "" : null;
          },
          keyboardInteractive: async (r) => {
            if (!r.prompts.length) return [];
            this.state = "auth";
            return this.ask("auth", { method: "keyboard-interactive", name: r.name, instruction: r.instruction, prompts: r.prompts });
          },
          banner: (text) => this.event({ t: "banner", text: text.slice(0, 8192) }, true),
        },
      });
      this.client = c;
      c.on("close", (err: SshError | null) => this.onClientClose(err));
      await c.connect();
      this.info.authMethod = c.authMethod; this.info.server = c.server;
      const ch = await c.openSession();
      ch.autoAck = false; // acknowledged as the browser takes the bytes (drain)
      this.shell = ch;
      ch.on("data", (d: Buffer) => this.output(2, d));
      ch.on("stderr", (d: Buffer) => this.output(3, d));
      ch.on("exit", (x: Record<string, unknown>) => this.event({ t: "exit", ...x }, true));
      ch.on("close", () => this.close("the remote shell ended"));
      if (this.init.lang) await ch.env("LANG", this.init.lang); // servers commonly refuse env (AcceptEnv); harmless
      if (!(await ch.pty(this.init.term, this.init.cols, this.init.rows))) this.event({ t: "status", text: "The server refused a terminal (pty); continuing without one." }, true);
      if (!(await ch.shell())) throw new SshError("the server refused to start a shell", "channel");
      this.state = "ready";
      this.log = this.log.filter((e) => e.t === "banner");
      this.event({ t: "ready", server: c.server, negotiated: c.negotiated, authMethod: c.authMethod, fingerprint: this.info.fingerprint, hostKeyAlg: this.info.hostKeyAlg, remote: this.info.remote, route: this.info.route }, true);
    } catch (e) {
      const err = e as SshError & KeyError;
      this.event({ t: "error", code: err.code ?? "error", message: err.message ?? String(e) }, true);
      this.close(err.message ?? "failed");
    } finally {
      // the secrets are not needed after the attempt
      this.init.privateKey = undefined; this.init.passphrase = undefined;
    }
  }
  private async loadKey(): Promise<SshPrivateKey> {
    let pass = this.init.passphrase;
    for (let attempt = 1; ; attempt++) {
      try { return parsePrivateKey(this.init.privateKey!, pass || undefined); }
      catch (e) {
        if (!(e instanceof KeyError) || (e.code !== "passphrase-needed" && e.code !== "bad-passphrase") || attempt > 3) throw e;
        const a = await this.ask("auth", { method: "passphrase", name: "Key passphrase", instruction: e.code === "bad-passphrase" ? "Wrong passphrase — try again." : "The private key is protected by a passphrase.", attempt, prompts: [{ prompt: "Passphrase:", echo: false }] });
        if (a === null) throw new SshError("authentication cancelled", "auth-cancelled");
        pass = a[0] ?? "";
      }
    }
  }
  private async dial(): Promise<Duplex> {
    const { host, port } = this.init;
    const route = getRoute();
    if (route.mode !== "direct" && !this.init.direct) {
      this.info.route = describeRoute(route).label;
      const o = await openUpstream(host, port, { secure: false, route, timeoutMs: 20_000 });
      this.info.remote = o.remote;
      return o.socket;
    }
    // Direct: SSH's normal targets include LAN and this machine, so private addresses are allowed here (the
    // endpoint answers only the Fusion window itself — same-origin, see the routes)
    this.info.route = "Direct";
    const h = host.replace(/^\[|\]$/g, "");
    if (/\.onion\.?$/i.test(h)) throw new SshError("onion addresses need the Tor (SOCKS5) route — set it in the Browser's network settings", "dial");
    const addrs = net.isIP(h) ? [{ address: h, family: (net.isIPv6(h) ? 6 : 4) as 4 | 6 }] : (await lookup(h, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
    if (!addrs.length) throw new SshError(`${h} did not resolve`, "dial");
    const { socket, address } = await connectPinned(addrs, port, { timeoutMs: 20_000 });
    socket.setNoDelay(true); socket.setKeepAlive(true, 30_000);
    this.info.remote = `${address}:${port}`;
    return socket;
  }
  private async verifyHostKey(k: HostKeyInfo): Promise<boolean> {
    const { host, port } = this.init;
    this.info.fingerprint = k.fingerprint; this.info.hostKeyAlg = k.alg;
    const kh = await readKnownHosts();
    const v = checkHostKey(kh, host, port, k.blob);
    if (v.status === "known") return true;
    if (v.status === "revoked") { this.event({ t: "hostkey-refused", why: "revoked", fingerprint: k.fingerprint, alg: k.alg, line: v.line, path: KNOWN_HOSTS_PATH }, true); return false; }
    if (v.status === "changed") { this.event({ t: "hostkey-refused", why: "changed", fingerprint: k.fingerprint, alg: k.alg, line: v.line, path: KNOWN_HOSTS_PATH }, true); return false; }
    this.state = "hostkey";
    const d = await this.ask("hostkey", { host, port, fingerprint: k.fingerprint, alg: k.alg, keyType: k.type, knownTypes: v.knownTypes, canSave: !this.init.amnesic, path: KNOWN_HOSTS_PATH });
    if (!d.accept) return false;
    if (d.save && !this.init.amnesic) {
      // re-read right before writing: another session may have added a line meanwhile
      const fresh = await readKnownHosts();
      if (checkHostKey(fresh, host, port, k.blob).status !== "known") {
        await ensureDir("/System/ssh");
        await writeFile({ path: KNOWN_HOSTS_PATH, content: addHostKey(fresh, host, port, k.blob), mime: "text/plain", reason: `ssh: trusted ${host}:${port} (${k.fingerprint})` });
      }
    }
    // not saved ("Trust once", or an amnesic session): this connection only — the next one asks again
    return true;
  }

  // ----------------------------------------------------------------------------------------------- SFTP
  sftp(): Promise<SftpClient> {
    if (this.state !== "ready" || !this.client) return Promise.reject(new SshError("not connected", "state"));
    if (!this.sftpP) {
      this.sftpP = SftpClient.open(this.client);
      this.sftpP.catch(() => { this.sftpP = null; });
    } else {
      this.sftpP = this.sftpP.then((s) => (s.closed ? SftpClient.open(this.client!) : s));
    }
    return this.sftpP;
  }

  // ----------------------------------------------------------------------------------------------- end
  private onClientClose(err: SshError | null): void {
    if (this.state === "closed") return;
    if (err && this.state === "ready") this.event({ t: "error", code: err.code, message: err.message }, true);
    this.close(err?.message ?? "connection closed");
  }
  close(why: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.pending?.kind === "hostkey") this.pending.resolve({ accept: false, save: false }); else this.pending?.resolve(null);
    try { this.client?.end(); } catch { /* */ }
    this.event({ t: "closed", why }, true);
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.detachedTimer) clearTimeout(this.detachedTimer);
    // let the browser read the final frames, then end its stream
    setTimeout(() => { try { this.drain(); this.ctl?.close(); } catch { /* */ } this.ctl = null; sessions().delete(this.id); }, 250).unref?.();
  }
  summary() { return { id: this.id, host: this.init.host, port: this.init.port, username: this.init.username, state: this.state, created: this.created, ...this.info }; }
}

/** process-wide registries (survive Next's module re-evaluation in dev) */
const G = globalThis as unknown as { __fusionSsh?: Map<string, BridgeSession> };
export function sessions(): Map<string, BridgeSession> { return (G.__fusionSsh ??= new Map()); }

export async function readKnownHosts(): Promise<string> {
  const n = await getNode(KNOWN_HOSTS_PATH);
  if (!n || n.kind !== "file" || n.content == null) return "";
  return n.encoding === "base64" ? Buffer.from(n.content, "base64").toString("utf8") : n.content;
}

export function createSession(init: SessionInit): BridgeSession {
  const all = sessions();
  for (const s of all.values()) if (s.state === "closed") all.delete(s.id);
  if (all.size >= MAX_SESSIONS) throw new SshError(`at most ${MAX_SESSIONS} SSH sessions at once — close one first`, "limit");
  const s = new BridgeSession(init);
  all.set(s.id, s);
  return s;
}

/** validates a create request; returns the init or an error string */
export function parseInit(b: Record<string, unknown>, amnesic: boolean): SessionInit | string {
  const host = String(b.host ?? "").trim();
  if (!host || host.length > 255 || /[\s/\\@]/.test(host.replace(/^\[[0-9a-f:.]+\]$/i, "x"))) return "a host name or address is required";
  const port = b.port === undefined || b.port === "" ? 22 : Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be 1–65535";
  const username = String(b.username ?? "").trim();
  if (!username || username.length > 64 || /[\s:@/]/.test(username)) return "a user name is required";
  const cols = Math.max(2, Math.min(1000, Number(b.cols) || 80)), rows = Math.max(1, Math.min(500, Number(b.rows) || 24));
  const term = /^[a-z0-9+_.-]{1,40}$/i.test(String(b.term ?? "")) ? String(b.term) : "xterm-256color";
  const privateKey = typeof b.privateKey === "string" && b.privateKey.trim() ? b.privateKey : undefined;
  if (privateKey && privateKey.length > 64 * 1024) return "the private key is too large";
  const lang = typeof b.lang === "string" && /^[A-Za-z_.@0-9-]{1,40}$/.test(b.lang) ? b.lang : undefined;
  return { host, port, username, cols, rows, term, privateKey, passphrase: typeof b.passphrase === "string" ? b.passphrase : undefined, direct: b.direct === true, amnesic, lang };
}

/** frame reader for POST bodies */
export function* readFrames(buf: Buffer): Generator<{ type: number; payload: Buffer }> {
  let off = 0;
  while (off + 5 <= buf.length) {
    const type = buf[off], len = buf.readUInt32BE(off + 1);
    if (off + 5 + len > buf.length) throw new Error("truncated frame");
    yield { type, payload: buf.subarray(off + 5, off + 5 + len) };
    off += 5 + len;
  }
  if (off !== buf.length) throw new Error("trailing bytes after the last frame");
}

/** same-origin Fusion window only: proxied pages (opaque origin) and cross-site documents are refused */
export function fusionCaller(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site"), origin = req.headers.get("origin");
  if (origin === "null") return false;
  return site === null ? true : site === "same-origin";
}
