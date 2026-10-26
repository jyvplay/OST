import { EventEmitter } from "node:events";
import { ML_KEM_768, ML_KEM_1024, keyGen as mlkemKeyGen, decaps as mlkemDecaps, sizes as mlkemSizes, type MlKemParams } from "./mlkem";
import { createECDH, createHash, createPublicKey, diffieHellman, generateKeyPairSync, getDiffieHellman, randomBytes, type KeyObject } from "node:crypto";
import type { Duplex } from "node:stream";
import { MSG, DISCONNECT_REASON, SshReader, SshWriter, SshWireError, mpintBytes } from "./wire";
import { CIPHERS, MACS, HOSTKEY_ALGS, PacketOpener, PacketSealer, SshMacError, deriveKey, fingerprint, blobType, verifySignature, type DirectionKeys } from "./crypto";
import type { SshPrivateKey } from "./keys";

/**
 * TT44 (TD-03): an SSH-2 CLIENT — transport (RFC 4253), user authentication (RFC 4252, RFC 4256 keyboard-interactive,
 * RFC 8332 / RFC 8308 server-sig-algs), connection protocol (RFC 4254). Original code; no SSH library is used.
 *
 * Key exchange: curve25519-sha256 (+ the @libssh.org alias; RFC 8731 — an all-zero shared secret aborts),
 * ecdh-sha2-nistp256/384/521 (RFC 5656), diffie-hellman-group16-sha512 / group14-sha256 (RFC 8268; groups from
 * RFC 3526 as built into OpenSSL — no constants typed in here). Strict KEX (draft-miller-sshm-strict-kex, the Terrapin
 * fix) is offered under both names and enforced when the server agrees: only KEX messages before the first NEWKEYS,
 * KEXINIT must be the first packet, sequence numbers reset after every NEWKEYS. Rekeying works in both directions
 * (client-initiated after 1 GiB or 1 h); non-KEX packets sent meanwhile are queued, never sent under stale keys.
 *
 * The host key is NEVER accepted silently: `verifyHostKey` (the caller's known_hosts / user decision) must resolve
 * true, and the exchange-hash signature must verify, before NEWKEYS is sent.
 */

// TT45: the post-quantum hybrids (draft-ietf-sshm-mlkem-hybrid-kex-10) come first, as in OpenSSH 10
export const KEX_ALGS = ["mlkem768x25519-sha256", "curve25519-sha256", "curve25519-sha256@libssh.org", "mlkem768nistp256-sha256", "mlkem1024nistp384-sha384", "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521", "diffie-hellman-group16-sha512", "diffie-hellman-group14-sha256"];
const KEX_MARKERS = ["ext-info-c", "kex-strict-c-v00@openssh.com", "kex-strict-c"];
const KEX_HASH: Record<string, string> = {
  "mlkem768x25519-sha256": "sha256", "mlkem768nistp256-sha256": "sha256", "mlkem1024nistp384-sha384": "sha384",
  "curve25519-sha256": "sha256", "curve25519-sha256@libssh.org": "sha256", "ecdh-sha2-nistp256": "sha256", "ecdh-sha2-nistp384": "sha384",
  "ecdh-sha2-nistp521": "sha512", "diffie-hellman-group16-sha512": "sha512", "diffie-hellman-group14-sha256": "sha256",
};
const KEX_PERMITTED_INITIAL = new Set<number>([MSG.KEXINIT, MSG.NEWKEYS, MSG.KEX_ECDH_INIT, MSG.KEX_ECDH_REPLY]);
export const CLIENT_VERSION = "SSH-2.0-FusionSSH_1.0";
export const WINDOW = 2 * 1024 * 1024, MAX_CHANNEL_PACKET = 32768;

export interface HostKeyInfo { alg: string; type: string; blob: Buffer; fingerprint: string }
export interface KbdRequest { name: string; instruction: string; prompts: { prompt: string; echo: boolean }[] }
export interface AuthHandlers {
  keys?: SshPrivateKey[];
  /** lazily supplies keys the first time the server offers "publickey" — i.e. AFTER the host key was verified, so
   *  a passphrase is never asked for on behalf of an unverified server (OpenSSH's order) */
  loadKeys?: () => Promise<SshPrivateKey[]>;
  password?: (o: { attempt: number; message?: string }) => Promise<string | null>;
  keyboardInteractive?: (r: KbdRequest) => Promise<string[] | null>;
  banner?: (text: string) => void;
}
export interface SshClientOptions {
  username: string;
  verifyHostKey: (k: HostKeyInfo) => Promise<boolean>;
  auth: AuthHandlers;
  /** host-key algorithms to put first (the types already in known_hosts for this host, like OpenSSH does) */
  preferHostKeyAlgs?: string[];
  kex?: string[]; ciphers?: string[]; macs?: string[]; hostKeyAlgs?: string[];
  /** test hooks: disable the strict-KEX offer; rekey after this many bytes */
  offerStrict?: boolean; rekeyBytes?: number; rekeyMs?: number;
  /** test hook: host-key algorithm list for REKEYS only (lets a test make an honest server present a different key mid-session) */
  rekeyHostKeyAlgs?: string[];
  keepaliveMs?: number; timeoutMs?: number;
  log?: (s: string) => void;
}
export interface Negotiated { kex: string; hostKey: string; c2s: string; s2c: string; macC2s: string | null; macS2c: string | null; strict: boolean }

export class SshError extends Error { code: string; constructor(msg: string, code: string) { super(msg); this.code = code; } }

interface KexState {
  ourKexinit: Buffer; theirKexinit: Buffer | null; neg: Negotiated | null; initial: boolean;
  ecdh?: { kind: "x25519"; priv: KeyObject; pub: Buffer } | { kind: "nist"; ecdh: ReturnType<typeof createECDH>; pub: Buffer } | { kind: "dh"; dh: ReturnType<typeof getDiffieHellman>; e: Buffer }
    | { kind: "hybrid"; kem: MlKemParams; dk: Buffer; cl: { x: KeyObject } | { e: ReturnType<typeof createECDH>; size: number }; pub: Buffer };
  sentNewkeys: boolean; gotNewkeys: boolean; pendingKeys: { c2s: DirectionKeys; s2c: DirectionKeys } | null; ignoreNextKexPacket: boolean;
}

export class SshClient extends EventEmitter {
  private sock: Duplex;
  private o: SshClientOptions;
  private sealer = new PacketSealer(null, randomBytes);
  private opener = new PacketOpener(null);
  private sendSeq = 0; private recvSeq = 0;
  private serverVersion = ""; private versionBuf = Buffer.alloc(0); private versionDone = false;
  private sessionId: Buffer | null = null;
  private kex: KexState | null = null;
  private strict = false; private firstKexDone = false; private packetsBeforeKexinit = 0; private kexinitSeen = false;
  private queued: Buffer[] = [];
  private closed = false;
  private bytesSinceKex = 0; private kexAt = Date.now();
  private authWaiters: ((p: Buffer) => void)[] = [];
  private authInbox: Buffer[] = [];
  private globalReplies: ((ok: boolean, p: SshReader) => void)[] = [];
  private channels = new Map<number, SshChannel>();
  private nextChannelId = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null; private keepaliveMissed = 0;
  serverSigAlgs: string[] | null = null;
  negotiated: Negotiated | null = null;
  hostKey: HostKeyInfo | null = null;
  authenticated = false;
  authMethod = "";
  /** counters for tests and the UI */
  stats = { kexCount: 0, packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0 };

  constructor(sock: Duplex, o: SshClientOptions) {
    super();
    this.sock = sock; this.o = o;
    sock.on("data", (d: Buffer) => { try { this.onData(d); } catch (e) { this.fail(e); } });
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.teardown(new SshError("connection closed by the server", "closed")));
  }

  /** version exchange → key exchange → host key check → user authentication; resolves once authenticated */
  async connect(): Promise<void> {
    const timeoutMs = this.o.timeoutMs ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new SshError(`no SSH handshake within ${timeoutMs / 1000} s`, "timeout")), timeoutMs);
      const done = (e?: unknown) => { clearTimeout(t); this.off("authenticated", ok); this.off("close", bad); if (e) reject(e); else resolve(); };
      const ok = () => done(); const bad = (e: unknown) => done(e ?? new SshError("closed", "closed"));
      this.once("authenticated", ok); this.once("close", bad);
      this.sock.write(`${CLIENT_VERSION}\r\n`);
      this.sendKexinit(true);
    });
  }

  get server(): string { return this.serverVersion; }

  // ------------------------------------------------------------------------------------------- input
  private onData(d: Buffer): void {
    if (this.closed) return;
    this.stats.bytesIn += d.length; this.bytesSinceKex += d.length;
    if (!this.versionDone) {
      this.versionBuf = Buffer.concat([this.versionBuf, d]);
      // RFC 4253 §4.2: the server MAY send other lines first; the version line starts with "SSH-"
      for (;;) {
        const nl = this.versionBuf.indexOf(10);
        if (nl < 0) { if (this.versionBuf.length > 8192) throw new SshError("no SSH version line", "protocol"); return; }
        const line = this.versionBuf.subarray(0, nl).toString("latin1").replace(/\r$/, "");
        this.versionBuf = this.versionBuf.subarray(nl + 1);
        if (!line.startsWith("SSH-")) continue;
        if (line.length > 253) throw new SshError("version line too long", "protocol");
        if (!/^SSH-(2\.0|1\.99)-/.test(line)) throw new SshError(`unsupported protocol version: ${line}`, "version");
        this.serverVersion = line; this.versionDone = true;
        const rest = this.versionBuf; this.versionBuf = Buffer.alloc(0);
        if (rest.length) this.opener.feed(rest);
        break;
      }
    } else this.opener.feed(d);
    this.pump();
  }

  /** processes whole packets in order; stops while a host-key decision is pending (later packets wait their turn) */
  private paused = false;
  private pump(): void {
    for (;;) {
      if (this.closed || this.paused) return;
      let p: Buffer | null;
      try { p = this.opener.next(this.recvSeq); } catch (e) { if (e instanceof SshMacError) { this.sendDisconnect(5, e.message); throw new SshError(e.message, "mac"); } throw e; }
      if (!p) return;
      this.recvSeq = (this.recvSeq + 1) >>> 0;
      this.stats.packetsIn++;
      this.dispatch(p);
    }
  }

  private dispatch(p: Buffer): void {
    if (p.length === 0) throw new SshError("empty packet", "protocol");
    const t = p[0];
    if (!this.kexinitSeen && t !== MSG.KEXINIT) this.packetsBeforeKexinit++;
    // DISCONNECT is always honoured first (as OpenSSH packet.c does), so the user sees the server's own reason; it ends
    // the session, so letting it through cannot smuggle state past strict KEX
    if (t === MSG.DISCONNECT) { const r0 = new SshReader(p.subarray(1)); const code = r0.u32(); const desc = r0.utf8(4096); throw new SshError(`server disconnected: ${desc || DISCONNECT_REASON[code] || code}`, "disconnect"); }
    // strict KEX: during the INITIAL key exchange only KEX messages are allowed (checked once strictness is known)
    if (this.strict && !this.firstKexDone && !KEX_PERMITTED_INITIAL.has(t)) {
      this.sendDisconnect(2, `strict KEX violation: message ${t} during the initial key exchange`);
      throw new SshError(`strict KEX violation: unexpected message ${t} during the initial key exchange`, "strict-kex");
    }
    const r = new SshReader(p.subarray(1));
    switch (t) {
      case MSG.DISCONNECT: { const code = r.u32(); const desc = r.utf8(4096); throw new SshError(`server disconnected: ${desc || DISCONNECT_REASON[code] || code}`, "disconnect"); }
      case MSG.IGNORE: case MSG.DEBUG: case MSG.UNIMPLEMENTED: case MSG.PONG: return;
      case MSG.PING: { this.send(new SshWriter().byte(MSG.PONG).string(r.string()).build()); return; }
      case MSG.KEXINIT: return this.onKexinit(p);
      case MSG.KEX_ECDH_REPLY: {
        this.paused = true;
        void this.onKexReply(r).then(() => { this.paused = false; try { this.pump(); } catch (e) { this.fail(e); } }, (e) => this.fail(e));
        return;
      }
      case MSG.NEWKEYS: return this.onNewkeys();
      case MSG.EXT_INFO: return this.onExtInfo(r);
      case MSG.SERVICE_ACCEPT: { const s = r.utf8(64); if (s === "ssh-userauth") void this.runAuth().catch((e) => this.fail(e)); return; }
      case MSG.USERAUTH_BANNER: { const text = r.utf8(65536); this.o.auth.banner?.(text); this.emit("banner", text); return; }
      case MSG.USERAUTH_FAILURE: case MSG.USERAUTH_SUCCESS: case MSG.USERAUTH_60:
        if (this.authenticated) throw new SshError("authentication message after success", "protocol");
        return this.authDeliver(p);
      case MSG.GLOBAL_REQUEST: { const name = r.utf8(256); const want = r.bool(); this.emit("global-request", name); if (want) this.send(Buffer.from([MSG.REQUEST_FAILURE])); return; }
      case MSG.REQUEST_SUCCESS: case MSG.REQUEST_FAILURE: { const w = this.globalReplies.shift(); w?.(t === MSG.REQUEST_SUCCESS, r); return; }
      case MSG.CHANNEL_OPEN: { // the server opening a channel to us (agent / X11 / forwarded ports): refused — none is requested
        r.utf8(256); const sender = r.u32();
        this.send(new SshWriter().byte(MSG.CHANNEL_OPEN_FAILURE).u32(sender).u32(1).string("not supported by this client").string("").build()); return;
      }
      case MSG.CHANNEL_OPEN_CONFIRMATION: case MSG.CHANNEL_OPEN_FAILURE: case MSG.CHANNEL_WINDOW_ADJUST: case MSG.CHANNEL_DATA:
      case MSG.CHANNEL_EXTENDED_DATA: case MSG.CHANNEL_EOF: case MSG.CHANNEL_CLOSE: case MSG.CHANNEL_REQUEST: case MSG.CHANNEL_SUCCESS: case MSG.CHANNEL_FAILURE: {
        if (!this.authenticated) throw new SshError(`channel message ${t} before authentication`, "protocol");
        const id = r.u32(); const ch = this.channels.get(id);
        if (!ch) throw new SshError(`message ${t} for unknown channel ${id}`, "protocol");
        ch.handle(t, r); return;
      }
      default: { // RFC 4253 §11.4
        const w = new SshWriter().byte(MSG.UNIMPLEMENTED).u32((this.recvSeq - 1) >>> 0); this.send(w.build()); return;
      }
    }
  }

  // ------------------------------------------------------------------------------------------- output
  /** queue-aware send: during a key exchange only transport / KEX messages go out (RFC 4253 §7.1) */
  send(payload: Buffer): void {
    if (this.closed) return;
    const t = payload[0];
    const kexMsg = (t >= 1 && t <= 4) || (t >= 20 && t <= 49);
    if (this.kex && !this.kex.sentNewkeys && !kexMsg) { this.queued.push(payload); return; }
    this.rawSend(payload);
  }
  private rawSend(payload: Buffer): void {
    const pkt = this.sealer.seal(this.sendSeq, payload);
    this.sendSeq = (this.sendSeq + 1) >>> 0;
    this.stats.packetsOut++; this.stats.bytesOut += pkt.length; this.bytesSinceKex += pkt.length;
    this.sock.write(pkt);
    if (this.firstKexDone && !this.kex && (this.bytesSinceKex > (this.o.rekeyBytes ?? 1 << 30) || Date.now() - this.kexAt > (this.o.rekeyMs ?? 3_600_000))) this.sendKexinit(false);
  }

  // ------------------------------------------------------------------------------------------- key exchange
  private lists() {
    const pref = this.o.preferHostKeyAlgs ?? [];
    const hk = (this.firstKexDone && this.o.rekeyHostKeyAlgs) || (this.o.hostKeyAlgs ?? HOSTKEY_ALGS);
    return {
      kex: this.o.kex ?? KEX_ALGS,
      hostKey: [...pref.filter((a) => hk.includes(a)), ...hk.filter((a) => !pref.includes(a))],
      ciphers: this.o.ciphers ?? CIPHERS.map((c) => c.name),
      macs: this.o.macs ?? MACS.map((m) => m.name),
    };
  }
  private sendKexinit(initial: boolean): void {
    if (this.kex) return;
    const L = this.lists();
    const markers = initial ? KEX_MARKERS.filter((m) => this.o.offerStrict !== false || !m.startsWith("kex-strict")) : [];
    const w = new SshWriter().byte(MSG.KEXINIT).raw(randomBytes(16))
      .nameList([...L.kex, ...markers]).nameList(L.hostKey).nameList(L.ciphers).nameList(L.ciphers)
      .nameList(L.macs).nameList(L.macs).nameList(["none"]).nameList(["none"]).string("").string("").bool(false).u32(0);
    const kexinit = w.build();
    this.kex = { ourKexinit: kexinit, theirKexinit: null, neg: null, initial, sentNewkeys: false, gotNewkeys: false, pendingKeys: null, ignoreNextKexPacket: false };
    this.rawSend(kexinit);
  }

  private onKexinit(p: Buffer): void {
    const first = !this.kexinitSeen;
    this.kexinitSeen = true;
    if (!this.kex) this.sendKexinit(false); // server-initiated rekey
    const k = this.kex!;
    if (k.theirKexinit) throw new SshError("second KEXINIT during a key exchange", "protocol");
    k.theirKexinit = Buffer.from(p);
    const r = new SshReader(p.subarray(17));
    const s = { kex: r.nameList(), hostKey: r.nameList(), c2s: r.nameList(), s2c: r.nameList(), macC2s: r.nameList(), macS2c: r.nameList(), compC2s: r.nameList(), compS2c: r.nameList() };
    r.nameList(); r.nameList(); const follows = r.bool(); r.u32();
    const L = this.lists();
    if (first) {
      // both names must pair: standard with standard, pre-standard with pre-standard (draft §3.1)
      const offered = this.o.offerStrict !== false;
      this.strict = offered && (s.kex.includes("kex-strict-s-v00@openssh.com") || s.kex.includes("kex-strict-s"));
      if (this.strict && this.packetsBeforeKexinit > 0) {
        this.sendDisconnect(2, "strict KEX violation: KEXINIT was not the first packet");
        throw new SshError("strict KEX violation: KEXINIT was not the first packet", "strict-kex");
      }
      if (s.kex.includes("ext-info-s")) { /* we only receive EXT_INFO */ }
    }
    const pick = (ours: string[], theirs: string[], what: string): string => {
      const c = ours.find((a) => theirs.includes(a));
      if (!c) { this.sendDisconnect(3, `no common ${what}`); throw new SshError(`no common ${what} algorithm (server offers: ${theirs.join(", ") || "none"})`, "negotiation"); }
      return c;
    };
    const kexAlg = pick(L.kex, s.kex.filter((a) => !a.startsWith("kex-strict-") && !a.startsWith("ext-info-")), "key exchange");
    const hostKey = pick(L.hostKey, s.hostKey, "host key");
    const c2s = pick(L.ciphers, s.c2s, "client-to-server cipher"), s2c = pick(L.ciphers, s.s2c, "server-to-client cipher");
    const aeadC = !!CIPHERS.find((c) => c.name === c2s)?.aead, aeadS = !!CIPHERS.find((c) => c.name === s2c)?.aead;
    const macC2s = aeadC ? null : pick(L.macs, s.macC2s, "client-to-server MAC"), macS2c = aeadS ? null : pick(L.macs, s.macS2c, "server-to-client MAC");
    pick(["none"], s.compC2s, "compression"); pick(["none"], s.compS2c, "compression");
    k.neg = { kex: kexAlg, hostKey, c2s, s2c, macC2s, macS2c, strict: this.strict };
    // RFC 4253 §7: a guessed first KEX packet that guessed wrong is ignored
    if (follows && (s.kex[0] !== kexAlg || s.hostKey[0] !== hostKey)) k.ignoreNextKexPacket = true;
    this.sendKexInit2(k);
  }

  private sendKexInit2(k: KexState): void {
    const alg = k.neg!.kex;
    let pub: Buffer;
    if (alg.startsWith("mlkem")) {
      // C_INIT = C_PK2 (ML-KEM encapsulation key) ‖ C_PK1 (X25519 / NIST point), both ephemeral, per connection
      const kem = alg.startsWith("mlkem1024") ? ML_KEM_1024 : ML_KEM_768;
      const { ek, dk } = mlkemKeyGen(kem);
      let cpk: Buffer, cl: { x: KeyObject } | { e: ReturnType<typeof createECDH>; size: number };
      if (alg.includes("x25519")) { const kp = generateKeyPairSync("x25519"); cpk = Buffer.from(kp.publicKey.export({ format: "jwk" }).x as string, "base64url"); cl = { x: kp.privateKey }; }
      else { const e = createECDH(alg.includes("nistp384") ? "secp384r1" : "prime256v1"); cpk = e.generateKeys(); cl = { e, size: alg.includes("nistp384") ? 48 : 32 }; }
      pub = Buffer.concat([ek, cpk]);
      k.ecdh = { kind: "hybrid", kem, dk, cl, pub };
    } else if (alg.startsWith("curve25519")) {
      const kp = generateKeyPairSync("x25519");
      pub = Buffer.from(kp.publicKey.export({ format: "jwk" }).x as string, "base64url");
      k.ecdh = { kind: "x25519", priv: kp.privateKey, pub };
    } else if (alg.startsWith("ecdh-sha2-")) {
      const curve = { "ecdh-sha2-nistp256": "prime256v1", "ecdh-sha2-nistp384": "secp384r1", "ecdh-sha2-nistp521": "secp521r1" }[alg]!;
      const ecdh = createECDH(curve); pub = ecdh.generateKeys();
      k.ecdh = { kind: "nist", ecdh, pub };
    } else {
      const dh = getDiffieHellman(alg.includes("group16") ? "modp16" : "modp14"); dh.generateKeys();
      pub = dh.getPublicKey(); k.ecdh = { kind: "dh", dh, e: pub };
      this.rawSend(new SshWriter().byte(MSG.KEX_ECDH_INIT).mpint(pub).build());
      return;
    }
    this.rawSend(new SshWriter().byte(MSG.KEX_ECDH_INIT).string(pub).build());
  }

  private async onKexReply(r: SshReader): Promise<void> {
    const k = this.kex;
    if (!k || !k.neg || !k.ecdh) throw new SshError("unexpected key exchange reply", "protocol");
    if (k.ignoreNextKexPacket) { k.ignoreNextKexPacket = false; return; }
    const ks = r.string(16384);
    const isDh = k.ecdh.kind === "dh";
    const qs = isDh ? r.mpint() : r.string(4096);
    const sig = r.string(16384); r.end();
    let shared: Buffer; let kEncHybrid: Buffer | null = null;
    if (k.ecdh.kind === "hybrid") {
      // S_REPLY = S_CT2 ‖ S_PK1; the length must be exactly ct + one valid encoding of the classical key (draft §2.1)
      const h = k.ecdh, ctLen = mlkemSizes(h.kem).ct, rest = qs.length - ctLen;
      const okLen = "x" in h.cl ? rest === 32 : rest === 2 * h.cl.size + 1 || rest === h.cl.size + 1;
      if (!okLen) { this.sendDisconnect(3, "bad hybrid reply length"); throw new SshError(`hybrid key exchange reply has the wrong length (${qs.length})`, "kex"); }
      const ct = qs.subarray(0, ctLen), spk = qs.subarray(ctLen);
      let kcl: Buffer;
      if ("x" in h.cl) {
        try { kcl = diffieHellman({ privateKey: h.cl.x, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: spk.toString("base64url") }, format: "jwk" }) }); }
        catch { this.sendDisconnect(3, "bad X25519 value"); throw new SshError("the server's X25519 value is a low-order point (RFC 8731 §3): refused", "kex"); }
        if (kcl.every((b) => b === 0)) { this.sendDisconnect(3, "all-zero X25519 shared secret"); throw new SshError("all-zero X25519 shared secret (RFC 8731 §3): refused", "kex"); }
      } else {
        try { kcl = h.cl.e.computeSecret(spk); } catch { this.sendDisconnect(3, "bad ECDH point"); throw new SshError("server's ECDH public value is not a valid curve point", "kex"); }
        if (kcl.length !== h.cl.size) throw new SshError("ECDH secret has an unexpected size", "kex");
      }
      const kpq = mlkemDecaps(h.kem, h.dk, ct); // implicit rejection: a forged ct yields an unrelated key → the signature check fails
      // K = HASH(K_PQ ‖ K_CL), both fixed-length byte arrays; K is then encoded as a STRING (not an mpint) in H and the KDF
      shared = createHash(KEX_HASH[k.neg.kex]).update(kpq).update(kcl).digest();
      kEncHybrid = new SshWriter().string(shared).build();
      h.dk.fill(0); kpq.fill(0); kcl.fill(0);
    } else if (k.ecdh.kind === "x25519") {
      if (qs.length !== 32) throw new SshError("bad X25519 public value length", "kex");
      // OpenSSL itself refuses a low-order point (all-zero result); either way it is the RFC 8731 §3 abort
      try { shared = diffieHellman({ privateKey: k.ecdh.priv, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: qs.toString("base64url") }, format: "jwk" }) }); }
      catch { throw new SshError("the server's X25519 value is a low-order point (all-zero shared secret, RFC 8731 §3): refused", "kex"); }
      if (shared.every((b) => b === 0)) { this.sendDisconnect(3, "all-zero X25519 shared secret"); throw new SshError("all-zero X25519 shared secret (RFC 8731 §3): refused", "kex"); }
    } else if (k.ecdh.kind === "nist") {
      try { shared = k.ecdh.ecdh.computeSecret(qs); } catch { throw new SshError("server's ECDH public value is not a valid curve point", "kex"); }
    } else {
      const p = BigInt(`0x${k.ecdh.dh.getPrime("hex")}`), f = BigInt(`0x${qs.toString("hex") || "0"}`);
      if (f <= BigInt(1) || f >= p - BigInt(1)) throw new SshError("server's DH public value out of range", "kex");
      shared = k.ecdh.dh.computeSecret(qs);
    }
    const hashAlg = KEX_HASH[k.neg.kex];
    const kEnc = kEncHybrid ?? new SshWriter().mpint(shared).build();
    const hw = new SshWriter().string(CLIENT_VERSION).string(this.serverVersion).string(k.ourKexinit).string(k.theirKexinit!).string(ks);
    if (isDh) hw.mpint((k.ecdh as { e: Buffer }).e).mpint(qs); else hw.string((k.ecdh as { pub: Buffer }).pub).string(qs);
    hw.raw(kEnc);
    const H = createHash(hashAlg).update(hw.build()).digest();
    // the host key: its type must suit the negotiated algorithm, the signature over H must verify, and the caller must accept it
    const type = blobType(ks);
    const okType = k.neg.hostKey === type || (type === "ssh-rsa" && k.neg.hostKey.startsWith("rsa-sha2-"));
    if (!okType) { this.sendDisconnect(9, "host key type mismatch"); throw new SshError(`host key type ${type} does not match the negotiated ${k.neg.hostKey}`, "hostkey"); }
    let sigOk = false;
    try { sigOk = verifySignature(k.neg.hostKey, ks, H, sig); } catch (e) { throw new SshError(`host key unusable: ${(e as Error).message}`, "hostkey"); }
    if (!sigOk) { this.sendDisconnect(9, "bad host key signature"); throw new SshError("the server's signature over the key exchange does not verify — possible man-in-the-middle", "hostkey-signature"); }
    const info: HostKeyInfo = { alg: k.neg.hostKey, type, blob: Buffer.from(ks), fingerprint: fingerprint(ks) };
    if (!this.hostKey) {
      const accepted = await this.o.verifyHostKey(info);
      if (this.closed) return;
      if (!accepted) { this.sendDisconnect(9, "host key not accepted"); throw new SshError("host key not accepted", "hostkey-rejected"); }
      this.hostKey = info;
    } else if (!this.hostKey.blob.equals(ks)) {
      // a rekey must present the SAME host key
      this.sendDisconnect(9, "host key changed during rekey");
      throw new SshError("the server presented a different host key during a rekey", "hostkey-changed");
    }
    if (!this.sessionId) this.sessionId = H;
    const kdf = (letter: string, len: number) => deriveKey(hashAlg, kEnc, H, letter, this.sessionId!, len);
    const dir = (cipher: string, mac: string | null, ivL: string, keyL: string, macL: string): DirectionKeys => {
      const c = CIPHERS.find((x) => x.name === cipher)!, m = mac ? MACS.find((x) => x.name === mac)! : null;
      return { cipher: c, mac: m, iv: c.ivLen ? kdf(ivL, c.ivLen) : Buffer.alloc(0), key: kdf(keyL, c.keyLen), macKey: m ? kdf(macL, m.keyLen) : Buffer.alloc(0) };
    };
    k.pendingKeys = { c2s: dir(k.neg.c2s, k.neg.macC2s, "A", "C", "E"), s2c: dir(k.neg.s2c, k.neg.macS2c, "B", "D", "F") };
    this.negotiated = k.neg;
    // NEWKEYS: our outgoing direction switches immediately after it
    this.rawSend(Buffer.from([MSG.NEWKEYS]));
    this.sealer = new PacketSealer(k.pendingKeys.c2s, randomBytes);
    if (this.strict) this.sendSeq = 0;
    k.sentNewkeys = true; this.bytesSinceKex = 0;
    this.finishKexIfDone();
    // through send(): if flushing crosses the rekey threshold and starts a NEW exchange, the rest re-queues behind it
    // (RFC 4253 §7.1 — nothing but KEX messages between our KEXINIT and our NEWKEYS)
    const q = this.queued; this.queued = [];
    for (const p of q) this.send(p);
  }

  private onNewkeys(): void {
    const k = this.kex;
    if (!k || !k.pendingKeys) throw new SshError("NEWKEYS before the key exchange completed", "protocol");
    const rest = this.opener.takeRemainder();
    this.opener = new PacketOpener(k.pendingKeys.s2c);
    if (this.strict) this.recvSeq = 0;
    if (rest.length) this.opener.feed(rest);
    k.gotNewkeys = true;
    this.finishKexIfDone();
  }

  private finishKexIfDone(): void {
    const k = this.kex;
    if (!k || !k.sentNewkeys || !k.gotNewkeys) return;
    const wasInitial = !this.firstKexDone;
    // bytes are counted from OUR NEWKEYS (when the new keys started protecting output), not reset again here
    this.kex = null; this.firstKexDone = true; this.kexAt = Date.now(); this.stats.kexCount++;
    this.emit("kex", this.negotiated);
    if (wasInitial) this.send(new SshWriter().byte(MSG.SERVICE_REQUEST).string("ssh-userauth").build());
    else if (this.bytesSinceKex > (this.o.rekeyBytes ?? 1 << 30)) this.sendKexinit(false); // crossed again mid-exchange
  }

  private onExtInfo(r: SshReader): void {
    const n = r.u32();
    for (let i = 0; i < n && i < 64; i++) {
      const name = r.utf8(256), value = r.string(65536).toString("latin1");
      if (name === "server-sig-algs") this.serverSigAlgs = value.split(",").filter(Boolean);
    }
  }

  // ------------------------------------------------------------------------------------------- user auth
  private authDeliver(p: Buffer): void { const w = this.authWaiters.shift(); if (w) w(p); else this.authInbox.push(p); }
  private nextAuth(): Promise<Buffer> {
    const p = this.authInbox.shift();
    if (p) return Promise.resolve(p);
    return new Promise((res) => this.authWaiters.push(res));
  }
  private userauth(method: string, f?: (w: SshWriter) => void): void {
    const w = new SshWriter().byte(MSG.USERAUTH_REQUEST).string(this.o.username).string("ssh-connection").string(method);
    f?.(w); this.send(w.build());
  }

  private async runAuth(): Promise<void> {
    const A = this.o.auth;
    this.userauth("none");
    let res = await this.nextAuth();
    const tried: string[] = [];
    let keyIdx = 0, kbdTries = 0, pwTries = 0;
    let lastMessage: string | undefined;
    for (;;) {
      if (res[0] === MSG.USERAUTH_SUCCESS) { this.authenticated = true; this.authMethod = tried[tried.length - 1] ?? "none"; this.startKeepalive(); this.emit("authenticated"); return; }
      if (res[0] !== MSG.USERAUTH_FAILURE) throw new SshError(`unexpected authentication reply ${res[0]}`, "protocol");
      const fr = new SshReader(res.subarray(1)); const methods = fr.nameList(); const partial = fr.bool();
      this.emit("auth-methods", { methods, partial });
      if (methods.includes("publickey") && A.loadKeys && !A.keys) A.keys = await A.loadKeys();
      if (methods.includes("publickey") && A.keys && keyIdx < A.keys.length) {
        const key = A.keys[keyIdx++];
        const alg = key.type === "ssh-rsa" ? this.rsaAlg() : key.type;
        const sigData = new SshWriter().string(this.sessionId!).byte(MSG.USERAUTH_REQUEST).string(this.o.username).string("ssh-connection")
          .string("publickey").bool(true).string(alg).string(key.publicBlob).build();
        const sig = key.sign(alg, sigData);
        this.userauth("publickey", (w) => w.bool(true).string(alg).string(key.publicBlob).string(sig));
        tried.push("publickey");
        res = await this.nextAuthSkipping60();
        continue;
      }
      if (methods.includes("keyboard-interactive") && A.keyboardInteractive && kbdTries < 3) {
        kbdTries++; tried.push("keyboard-interactive");
        this.userauth("keyboard-interactive", (w) => w.string("").string(""));
        for (;;) {
          res = await this.nextAuth();
          if (res[0] !== MSG.USERAUTH_60) break;
          const ir = new SshReader(res.subarray(1));
          const name = ir.utf8(1024), instruction = ir.utf8(4096); ir.string(256);
          const n = ir.u32(); if (n > 32) throw new SshError("too many keyboard-interactive prompts", "protocol");
          const prompts = Array.from({ length: n }, () => ({ prompt: ir.utf8(4096), echo: ir.bool() }));
          const answers = n === 0 ? [] : await A.keyboardInteractive({ name, instruction, prompts });
          if (answers === null) { this.sendDisconnect(13, "authentication cancelled"); throw new SshError("authentication cancelled", "auth-cancelled"); }
          const w = new SshWriter().byte(MSG.USERAUTH_INFO_RESPONSE).u32(n);
          for (let i = 0; i < n; i++) w.string(answers[i] ?? "");
          this.send(w.build());
        }
        continue;
      }
      if (methods.includes("password") && A.password && pwTries < 3) {
        pwTries++; tried.push("password");
        const pw = await A.password({ attempt: pwTries, message: lastMessage });
        if (pw === null) { this.sendDisconnect(13, "authentication cancelled"); throw new SshError("authentication cancelled", "auth-cancelled"); }
        this.userauth("password", (w) => w.bool(false).string(pw));
        res = await this.nextAuth();
        if (res[0] === MSG.USERAUTH_60) { // PASSWD_CHANGEREQ
          const cr = new SshReader(res.subarray(1)); lastMessage = cr.utf8(4096);
          throw new SshError(`the server requires a password change first${lastMessage ? `: ${lastMessage}` : ""} (not supported here)`, "auth-password-change");
        }
        continue;
      }
      this.sendDisconnect(14, "no more authentication methods");
      throw new SshError(`authentication failed (server accepts: ${methods.join(", ") || "nothing"}${tried.length ? `; tried: ${[...new Set(tried)].join(", ")}` : ""})`, "auth-failed");
    }
  }
  /** a PK_OK can only answer a query (we never send queries), so it is a protocol error here */
  private async nextAuthSkipping60(): Promise<Buffer> {
    const p = await this.nextAuth();
    if (p[0] === MSG.USERAUTH_60) throw new SshError("unexpected PK_OK", "protocol");
    return p;
  }
  /** RFC 8332: the strongest RSA SHA-2 signature the server lists (rsa-sha2-256 when it lists nothing) */
  private rsaAlg(): string {
    const s = this.serverSigAlgs;
    if (s?.includes("rsa-sha2-512")) return "rsa-sha2-512";
    if (s?.includes("rsa-sha2-256")) return "rsa-sha2-256";
    return s ? "ssh-rsa" : "rsa-sha2-256";
  }

  // ------------------------------------------------------------------------------------------- global requests
  globalRequest(name: string, wantReply: boolean, extra?: (w: SshWriter) => void): Promise<boolean> {
    const w = new SshWriter().byte(MSG.GLOBAL_REQUEST).string(name).bool(wantReply); extra?.(w);
    this.send(w.build());
    if (!wantReply) return Promise.resolve(true);
    return new Promise((res) => this.globalReplies.push((ok) => res(ok)));
  }
  private startKeepalive(): void {
    const ms = this.o.keepaliveMs ?? 30_000;
    if (!ms) return;
    this.keepaliveTimer = setInterval(() => {
      if (++this.keepaliveMissed > 3) { this.fail(new SshError("server stopped answering keepalives", "timeout")); return; }
      void this.globalRequest("keepalive@openssh.com", true).then(() => { this.keepaliveMissed = 0; });
    }, ms);
    this.keepaliveTimer.unref?.();
  }

  // ------------------------------------------------------------------------------------------- channels
  /** opens a "session" channel (RFC 4254 §6.1) */
  openSession(): Promise<SshChannel> {
    if (!this.authenticated) return Promise.reject(new SshError("not authenticated", "state"));
    const id = this.nextChannelId++;
    const ch = new SshChannel(this, id);
    this.channels.set(id, ch);
    this.send(new SshWriter().byte(MSG.CHANNEL_OPEN).string("session").u32(id).u32(WINDOW).u32(MAX_CHANNEL_PACKET).build());
    return new Promise((res, rej) => { ch.once("open", () => res(ch)); ch.once("open-failed", (e) => { this.channels.delete(id); rej(e); }); });
  }
  /** @internal */ releaseChannel(id: number): void { this.channels.delete(id); }

  // ------------------------------------------------------------------------------------------- teardown
  /** best-effort DISCONNECT before an abort; the error that follows tears the connection down WITH its reason */
  private sendDisconnect(reason: number, desc: string): void {
    if (this.closed) return;
    try { this.rawSend(new SshWriter().byte(MSG.DISCONNECT).u32(reason).string(desc).string("").build()); } catch { /* best effort */ }
  }
  disconnect(reason = 11, desc = "bye"): void {
    if (this.closed) return;
    try { this.rawSend(new SshWriter().byte(MSG.DISCONNECT).u32(reason).string(desc).string("").build()); } catch { /* best effort */ }
    this.sock.end();
    this.teardown(null);
  }
  end(): void { this.disconnect(11, "user closed the session"); }
  private fail(e: unknown): void {
    const err = e instanceof SshError ? e : e instanceof SshWireError ? new SshError(`malformed message: ${e.message}`, "protocol") : new SshError((e as Error)?.message ?? String(e), "error");
    if (!this.closed) { try { this.sock.destroy(); } catch { /* */ } }
    this.teardown(err);
  }
  private teardown(err: SshError | null): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    for (const ch of this.channels.values()) ch.gone();
    this.channels.clear();
    for (const w of this.globalReplies) w(false, new SshReader(Buffer.alloc(0)));
    this.globalReplies = [];
    if (err) this.emit("error-final", err);
    this.emit("close", err);
  }
  get isClosed(): boolean { return this.closed; }
}

/**
 * A channel (RFC 4254 §5): flow-controlled both ways. Outgoing data is split to the peer's maximum packet size and
 * queued while the peer's window is exhausted; incoming data is counted against our window and re-opened (WINDOW_ADJUST)
 * only as the consumer acknowledges it (`ack`), so a slow browser applies TCP backpressure to the server.
 */
export class SshChannel extends EventEmitter {
  remoteId = -1;
  private remoteWindow = 0; private remoteMax = 0;
  private localWindow = WINDOW; private unacked = 0;
  private out: { data: Buffer; ext: boolean }[] = [];
  private reqWaiters: ((ok: boolean) => void)[] = [];
  private eofSent = false; private closeSent = false; private closed = false;
  exitStatus: number | null = null; exitSignal: string | null = null;
  autoAck = true;
  private c: SshClient; localId: number;
  constructor(c: SshClient, localId: number) { super(); this.c = c; this.localId = localId; }

  /** @internal */
  handle(t: number, r: SshReader): void {
    switch (t) {
      case MSG.CHANNEL_OPEN_CONFIRMATION: { this.remoteId = r.u32(); this.remoteWindow = r.u32(); this.remoteMax = Math.max(1, Math.min(r.u32(), MAX_CHANNEL_PACKET)); this.emit("open"); return; }
      case MSG.CHANNEL_OPEN_FAILURE: { const code = r.u32(); const desc = r.utf8(4096); this.emit("open-failed", new SshError(`channel refused (${code}): ${desc}`, "channel")); return; }
      case MSG.CHANNEL_WINDOW_ADJUST: { const n = r.u32(); this.remoteWindow = Math.min(this.remoteWindow + n, 0xffffffff); this.flush(); return; }
      case MSG.CHANNEL_DATA: case MSG.CHANNEL_EXTENDED_DATA: {
        const ext = t === MSG.CHANNEL_EXTENDED_DATA; if (ext) r.u32();
        const d = r.string(MAX_CHANNEL_PACKET + 1024);
        if (d.length > this.localWindow) throw new SshError("server sent more data than the channel window allows", "protocol");
        this.localWindow -= d.length; this.unacked += d.length;
        this.emit(ext ? "stderr" : "data", d);
        if (this.autoAck) this.ack(d.length);
        return;
      }
      case MSG.CHANNEL_EOF: this.emit("eof"); return;
      case MSG.CHANNEL_CLOSE: { if (!this.closeSent) { this.closeSent = true; this.c.send(new SshWriter().byte(MSG.CHANNEL_CLOSE).u32(this.remoteId).build()); } this.gone(); return; }
      case MSG.CHANNEL_REQUEST: {
        const name = r.utf8(256), want = r.bool();
        if (name === "exit-status") { this.exitStatus = r.u32(); this.emit("exit", { code: this.exitStatus, signal: null }); }
        else if (name === "exit-signal") { this.exitSignal = r.utf8(64); const core = r.bool(); const msg = r.utf8(4096); this.emit("exit", { code: null, signal: this.exitSignal, core, message: msg }); }
        if (want) this.c.send(new SshWriter().byte(MSG.CHANNEL_FAILURE).u32(this.remoteId).build());
        return;
      }
      case MSG.CHANNEL_SUCCESS: case MSG.CHANNEL_FAILURE: { this.reqWaiters.shift()?.(t === MSG.CHANNEL_SUCCESS); return; }
    }
  }
  /** the consumer has processed n bytes: reopen the window once half of it is free */
  ack(n: number): void {
    this.unacked = Math.max(0, this.unacked - n);
    const free = WINDOW - this.localWindow - this.unacked;
    if (!this.closed && free >= WINDOW / 2) { this.localWindow += free; this.c.send(new SshWriter().byte(MSG.CHANNEL_WINDOW_ADJUST).u32(this.remoteId).u32(free).build()); }
  }
  request(name: string, wantReply: boolean, f?: (w: SshWriter) => void): Promise<boolean> {
    const w = new SshWriter().byte(MSG.CHANNEL_REQUEST).u32(this.remoteId).string(name).bool(wantReply); f?.(w);
    this.c.send(w.build());
    if (!wantReply) return Promise.resolve(true);
    return new Promise((res) => this.reqWaiters.push(res));
  }
  /** pty-req: TERM, size, and encoded terminal modes (RFC 4254 §8): VERASE = DEL, IUTF8 on, 38400 baud */
  pty(term: string, cols: number, rows: number): Promise<boolean> {
    const modes = new SshWriter().byte(3).u32(127).byte(42).u32(1).byte(128).u32(38400).byte(129).u32(38400).byte(0).build();
    return this.request("pty-req", true, (w) => w.string(term).u32(cols).u32(rows).u32(0).u32(0).string(modes));
  }
  shell(): Promise<boolean> { return this.request("shell", true); }
  exec(cmd: string): Promise<boolean> { return this.request("exec", true, (w) => w.string(cmd)); }
  subsystem(name: string): Promise<boolean> { return this.request("subsystem", true, (w) => w.string(name)); }
  env(name: string, value: string): Promise<boolean> { return this.request("env", true, (w) => w.string(name).string(value)); }
  resize(cols: number, rows: number): void { void this.request("window-change", false, (w) => w.u32(cols).u32(rows).u32(0).u32(0)); }
  signal(name: string): void { void this.request("signal", false, (w) => w.string(name.replace(/^SIG/, ""))); }
  write(data: Buffer | string): void {
    if (this.eofSent || this.closed) return;
    this.out.push({ data: typeof data === "string" ? Buffer.from(data, "utf8") : data, ext: false });
    this.flush();
  }
  /** bytes waiting for the peer's window (for backpressure toward the browser) */
  get pendingOut(): number { return this.out.reduce((s, x) => s + x.data.length, 0); }
  private flush(): void {
    while (this.out.length && this.remoteWindow > 0 && !this.closed) {
      const head = this.out[0];
      const n = Math.min(head.data.length, this.remoteWindow, this.remoteMax);
      const chunk = head.data.subarray(0, n);
      this.c.send(new SshWriter().byte(MSG.CHANNEL_DATA).u32(this.remoteId).string(chunk).build());
      this.remoteWindow -= n;
      if (n === head.data.length) this.out.shift(); else head.data = head.data.subarray(n);
    }
    if (!this.out.length) {
      if (this.eofPending && !this.closed) { this.eofPending = false; this.c.send(new SshWriter().byte(MSG.CHANNEL_EOF).u32(this.remoteId).build()); }
      this.emit("drain");
    }
  }
  private eofPending = false;
  /** EOF after everything already written has been sent (never ahead of queued data) */
  eof(): void { if (this.eofSent || this.closed) return; this.eofSent = true; this.eofPending = true; this.flush(); }
  close(): void {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    if (this.remoteId >= 0) this.c.send(new SshWriter().byte(MSG.CHANNEL_CLOSE).u32(this.remoteId).build());
  }
  /** @internal */
  gone(): void {
    if (this.closed) return;
    this.closed = true; this.c.releaseChannel(this.localId);
    for (const w of this.reqWaiters) w(false);
    this.reqWaiters = [];
    this.emit("close");
  }
  get isClosed(): boolean { return this.closed; }
}

export { mpintBytes };
