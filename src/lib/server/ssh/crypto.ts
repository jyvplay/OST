import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, timingSafeEqual, verify as cverify, type Cipher, type Decipher, type KeyObject } from "node:crypto";
import { SshReader, SshWriter, SshWireError } from "./wire";

/**
 * TT44 (TD-03): SSH transport cryptography. Original code over node:crypto primitives.
 *
 * Ciphers (client preference order): aes128-gcm@openssh.com, aes256-gcm@openssh.com (RFC 5647 as deployed:
 * draft-miller-sshm-aes-gcm), chacha20-poly1305@openssh.com (draft-ietf-sshm-chacha20-poly1305: K_1 = first 32 key
 * bytes for the payload, counter 1, Poly1305 key from counter 0; K_2 = second 32 bytes for the length, counter 0; nonce
 * = the 64-bit big-endian sequence number; MAC checked BEFORE decryption), aes128-ctr / aes256-ctr with
 * hmac-sha2-256-etm / hmac-sha2-512-etm (MAC over seq || length || ciphertext, length in clear) or the RFC 4253
 * encrypt-and-MAC hmac-sha2-256 / -512. No CBC, no SHA-1 MACs, no "none" after the first key exchange.
 */

// ------------------------------------------------------------------------------------------------- Poly1305
/**
 * Poly1305 (the message-authentication polynomial mod 2^130 − 5). Limbs are 13 bits wide so every partial product and
 * every column sum stays far below 2^53 and is exact in a JS double (26-bit limbs would overflow). The final 130-bit
 * value is converted once with BigInt.
 */
export function poly1305(key32: Buffer, msg: Buffer): Buffer {
  if (key32.length !== 32) throw new Error("poly1305 key must be 32 bytes");
  const rb = Buffer.from(key32.subarray(0, 16));
  rb[3] &= 15; rb[7] &= 15; rb[11] &= 15; rb[15] &= 15; rb[4] &= 252; rb[8] &= 252; rb[12] &= 252;
  const r = limbs(rb, false);
  const h = new Array<number>(10).fill(0);
  const d = new Array<number>(10);
  const blk = Buffer.alloc(20);
  for (let off = 0; off < msg.length; off += 16) {
    const n = Math.min(16, msg.length - off);
    blk.fill(0); msg.copy(blk, 0, off, off + n); blk[n] = 1; // the 2^(BigInt(8)) bit
    const m = limbs(blk, true);
    for (let i = 0; i < 10; i++) h[i] += m[i];
    for (let k = 0; k < 10; k++) {
      let s = 0;
      for (let i = 0; i <= k; i++) s += h[i] * r[k - i];
      for (let i = k + 1; i < 10; i++) s += 5 * h[i] * r[k + 10 - i]; // 2^(130 + 13j) ≡ 5 · 2^(13j)
      d[k] = s;
    }
    carry(d);
    for (let i = 0; i < 10; i++) h[i] = d[i];
  }
  carry(h); carry(h);
  let hv = BigInt(0);
  for (let i = 9; i >= 0; i--) hv = (hv << BigInt(13)) | BigInt(h[i]);
  const P = (BigInt(1) << BigInt(130)) - BigInt(5);
  hv %= P;
  let sv = BigInt(0);
  for (let i = 15; i >= 0; i--) sv = (sv << BigInt(8)) | BigInt(key32[16 + i]);
  const t = (hv + sv) & ((BigInt(1) << BigInt(128)) - BigInt(1));
  const out = Buffer.alloc(16);
  for (let i = 0, v = t; i < 16; i++, v >>= BigInt(8)) out[i] = Number(v & BigInt("0xff"));
  return out;
}
/** 130 bits of a little-endian byte string as ten 13-bit limbs (bytes beyond 16 carry the high bit for blocks) */
function limbs(b: Buffer, block: boolean): number[] {
  const out = new Array<number>(10);
  for (let i = 0; i < 10; i++) {
    const o = 13 * i, q = o >> 3, s = o & 7;
    const v = (b[q] | ((b[q + 1] ?? 0) << 8) | ((b[q + 2] ?? 0) << 16)) >>> s;
    out[i] = v & 0x1fff;
  }
  if (!block) return out;
  return out;
}
/** carry-propagate column sums back to 13-bit limbs, folding the top carry in as ×5 */
function carry(x: number[]): void {
  let c = 0;
  for (let i = 0; i < 10; i++) { const v = x[i] + c; c = Math.floor(v / 8192); x[i] = v - c * 8192; }
  while (c) { const v = x[0] + c * 5; c = Math.floor(v / 8192); x[0] = v - c * 8192; for (let i = 1; i < 10 && c; i++) { const w = x[i] + c; c = Math.floor(w / 8192); x[i] = w - c * 8192; } }
}

// --------------------------------------------------------------------------------------------- cipher suites
export interface CipherSpec { name: string; keyLen: number; ivLen: number; block: number; aead: "gcm" | "chacha" | null; tagLen: number }
export interface MacSpec { name: string; keyLen: number; macLen: number; hash: "sha256" | "sha512"; etm: boolean }

export const CIPHERS: CipherSpec[] = [
  { name: "aes128-gcm@openssh.com", keyLen: 16, ivLen: 12, block: 16, aead: "gcm", tagLen: 16 },
  { name: "aes256-gcm@openssh.com", keyLen: 32, ivLen: 12, block: 16, aead: "gcm", tagLen: 16 },
  { name: "chacha20-poly1305@openssh.com", keyLen: 64, ivLen: 0, block: 8, aead: "chacha", tagLen: 16 },
  { name: "aes128-ctr", keyLen: 16, ivLen: 16, block: 16, aead: null, tagLen: 0 },
  { name: "aes256-ctr", keyLen: 32, ivLen: 16, block: 16, aead: null, tagLen: 0 },
];
export const MACS: MacSpec[] = [
  { name: "hmac-sha2-256-etm@openssh.com", keyLen: 32, macLen: 32, hash: "sha256", etm: true },
  { name: "hmac-sha2-512-etm@openssh.com", keyLen: 64, macLen: 64, hash: "sha512", etm: true },
  { name: "hmac-sha2-256", keyLen: 32, macLen: 32, hash: "sha256", etm: false },
  { name: "hmac-sha2-512", keyLen: 64, macLen: 64, hash: "sha512", etm: false },
];

/** one direction of an established transport: the packet sealer (send) or the incremental opener (receive) */
export interface DirectionKeys { cipher: CipherSpec; mac: MacSpec | null; key: Buffer; iv: Buffer; macKey: Buffer }

export class SshMacError extends Error {}

/** Sends packets: payload → wire bytes (RFC 4253 §6 framing, padding to the cipher block, ≥ 4 random bytes). */
export class PacketSealer {
  private ctr: Cipher | null = null;
  private gcmIv: Buffer | null = null;
  private k: DirectionKeys | null; private rand: (n: number) => Buffer;
  constructor(k: DirectionKeys | null, rand: (n: number) => Buffer) {
    this.k = k; this.rand = rand;
    if (k && !k.cipher.aead) this.ctr = createCipheriv(k.cipher.name.startsWith("aes128") ? "aes-128-ctr" : "aes-256-ctr", k.key, k.iv);
    if (k?.cipher.aead === "gcm") this.gcmIv = Buffer.from(k.iv);
  }
  seal(seq: number, payload: Buffer): Buffer {
    const k = this.k;
    const block = k ? k.cipher.block : 8;
    // AEAD and EtM keep the 4-byte length out of the cipher, so it is not counted toward block alignment
    const lenOutside = !!k && (!!k.cipher.aead || !!k.mac?.etm);
    const base = (lenOutside ? 0 : 4) + 1 + payload.length;
    let pad = block - (base % block); if (pad < 4) pad += block;
    const packetLen = 1 + payload.length + pad;
    const body = Buffer.concat([Buffer.from([pad]), payload, this.rand(pad)]);
    const lenB = Buffer.alloc(4); lenB.writeUInt32BE(packetLen);
    if (!k) return Buffer.concat([lenB, body]);
    if (k.cipher.aead === "gcm") {
      const c = createCipheriv(k.cipher.keyLen === 16 ? "aes-128-gcm" : "aes-256-gcm", k.key, this.gcmIv!, { authTagLength: 16 });
      c.setAAD(lenB);
      const ct = Buffer.concat([c.update(body), c.final()]);
      const out = Buffer.concat([lenB, ct, c.getAuthTag()]);
      incInvocation(this.gcmIv!);
      return out;
    }
    if (k.cipher.aead === "chacha") {
      const encLen = chachaXor(k.key.subarray(32, 64), seq, 0, lenB);
      const ct = chachaXor(k.key.subarray(0, 32), seq, 1, body);
      const polyKey = chachaXor(k.key.subarray(0, 32), seq, 0, Buffer.alloc(32));
      const enc = Buffer.concat([encLen, ct]);
      return Buffer.concat([enc, poly1305(polyKey, enc)]);
    }
    const mac = k.mac!;
    if (mac.etm) {
      const ct = this.ctr!.update(body);
      const tag = hmac(mac, k.macKey, seq, Buffer.concat([lenB, ct]));
      return Buffer.concat([lenB, ct, tag]);
    }
    const plain = Buffer.concat([lenB, body]);
    const tag = hmac(mac, k.macKey, seq, plain);
    return Buffer.concat([this.ctr!.update(plain), tag]);
  }
}

export const MAX_PACKET = 256 * 1024 + 64; // generous over the 35 000 bytes RFC 4253 §6.1 requires; OpenSSH's own cap

/**
 * Receives packets incrementally. feed() appends bytes; next() returns the next whole payload or null (need more).
 * Every authenticated mode verifies the tag BEFORE using the decrypted payload; any failure throws SshMacError.
 */
export class PacketOpener {
  private buf: Buffer = Buffer.alloc(0);
  private ctr: Decipher | null = null;
  private gcmIv: Buffer | null = null;
  private pendingLen = -1; // encrypt-and-MAC (non-EtM CTR): the decrypted first block, kept until the packet completes
  private firstPlain: Buffer | null = null;
  private k: DirectionKeys | null;
  constructor(k: DirectionKeys | null) {
    this.k = k;
    if (k && !k.cipher.aead) this.ctr = createDecipheriv(k.cipher.name.startsWith("aes128") ? "aes-128-ctr" : "aes-256-ctr", k.key, k.iv);
    if (k?.cipher.aead === "gcm") this.gcmIv = Buffer.from(k.iv);
  }
  feed(b: Buffer): void { this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b; }
  /** bytes received but not yet consumed (they belong to the NEXT key set after NEWKEYS) */
  takeRemainder(): Buffer { const r = this.buf; this.buf = Buffer.alloc(0); return r; }
  next(seq: number): Buffer | null {
    const k = this.k;
    const checkLen = (n: number, block: number, lenOutside: boolean) => {
      if (n < 5 || n > MAX_PACKET) throw new SshMacError(`bad packet length ${n}`);
      if (((lenOutside ? 0 : 4) + n) % block !== 0) throw new SshMacError(`packet length ${n} not a multiple of the block size`);
    };
    const finish = (plain: Buffer): Buffer => { // plain = padding_length || payload || padding
      const pad = plain[0];
      if (pad < 4 || pad > plain.length - 1) throw new SshMacError(`bad padding length ${pad}`);
      return plain.subarray(1, plain.length - pad);
    };
    if (!k) {
      if (this.buf.length < 4) return null;
      const n = this.buf.readUInt32BE(0); checkLen(n, 8, false);
      if (this.buf.length < 4 + n) return null;
      const plain = this.buf.subarray(4, 4 + n); this.buf = this.buf.subarray(4 + n);
      return finish(Buffer.from(plain));
    }
    if (k.cipher.aead === "gcm") {
      if (this.buf.length < 4) return null;
      const n = this.buf.readUInt32BE(0); checkLen(n, 16, true);
      if (this.buf.length < 4 + n + 16) return null;
      const lenB = this.buf.subarray(0, 4), ct = this.buf.subarray(4, 4 + n), tag = this.buf.subarray(4 + n, 4 + n + 16);
      const d = createDecipheriv(k.cipher.keyLen === 16 ? "aes-128-gcm" : "aes-256-gcm", k.key, this.gcmIv!, { authTagLength: 16 });
      d.setAAD(lenB); d.setAuthTag(tag);
      let plain: Buffer;
      try { plain = Buffer.concat([d.update(ct), d.final()]); } catch { throw new SshMacError("AES-GCM authentication failed"); }
      this.buf = this.buf.subarray(4 + n + 16); incInvocation(this.gcmIv!);
      return finish(plain);
    }
    if (k.cipher.aead === "chacha") {
      if (this.buf.length < 4) return null;
      const n = chachaXor(k.key.subarray(32, 64), seq, 0, this.buf.subarray(0, 4)).readUInt32BE(0);
      checkLen(n, 8, true);
      if (this.buf.length < 4 + n + 16) return null;
      const enc = this.buf.subarray(0, 4 + n), tag = this.buf.subarray(4 + n, 4 + n + 16);
      const polyKey = chachaXor(k.key.subarray(0, 32), seq, 0, Buffer.alloc(32));
      if (!timingSafeEqual(poly1305(polyKey, enc), tag)) throw new SshMacError("chacha20-poly1305 authentication failed");
      const plain = chachaXor(k.key.subarray(0, 32), seq, 1, enc.subarray(4));
      this.buf = this.buf.subarray(4 + n + 16);
      return finish(plain);
    }
    const mac = k.mac!;
    if (mac.etm) {
      if (this.buf.length < 4) return null;
      const n = this.buf.readUInt32BE(0); checkLen(n, 16, true);
      if (this.buf.length < 4 + n + mac.macLen) return null;
      const signed = this.buf.subarray(0, 4 + n), tag = this.buf.subarray(4 + n, 4 + n + mac.macLen);
      if (!timingSafeEqual(hmac(mac, k.macKey, seq, signed), tag)) throw new SshMacError("MAC verification failed");
      const plain = this.ctr!.update(signed.subarray(4));
      this.buf = this.buf.subarray(4 + n + mac.macLen);
      return finish(plain);
    }
    // encrypt-and-MAC: the length is inside the first encrypted block (RFC 4253 §6). Decrypt that block once, keep it.
    if (this.pendingLen < 0) {
      if (this.buf.length < 16) return null;
      this.firstPlain = this.ctr!.update(this.buf.subarray(0, 16));
      const n = this.firstPlain.readUInt32BE(0); checkLen(n, 16, false);
      this.pendingLen = n;
    }
    const n = this.pendingLen;
    if (this.buf.length < 4 + n + mac.macLen) return null;
    const rest = this.ctr!.update(this.buf.subarray(16, 4 + n));
    const plain = Buffer.concat([this.firstPlain!, rest]);
    const tag = this.buf.subarray(4 + n, 4 + n + mac.macLen);
    if (!timingSafeEqual(hmac(mac, k.macKey, seq, plain), tag)) throw new SshMacError("MAC verification failed");
    this.buf = this.buf.subarray(4 + n + mac.macLen); this.pendingLen = -1; this.firstPlain = null;
    return finish(plain.subarray(4));
  }
}

function hmac(m: MacSpec, key: Buffer, seq: number, data: Buffer): Buffer {
  const s = Buffer.alloc(4); s.writeUInt32BE(seq >>> 0);
  return createHmac(m.hash, key).update(s).update(data).digest();
}
/** the GCM invocation counter: the last 8 IV bytes, a big-endian uint64 incremented per packet */
function incInvocation(iv: Buffer): void { iv.writeBigUInt64BE((iv.readBigUInt64BE(4) + BigInt(1)) & BigInt("0xffffffffffffffff"), 4); }
/** ChaCha20 (64-bit counter, 64-bit nonce = the sequence number, big-endian) XORed over data */
export function chachaXor(key: Buffer, seq: number, counter: number, data: Buffer): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(counter, 0); // state words 12–13: the block counter, little-endian
  iv.writeUInt32BE(seq >>> 0, 12); // words 14–15: nonce bytes = uint64 BE sequence number (high word 0)
  const c = createCipheriv("chacha20", key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

// ------------------------------------------------------------------------------------------ key derivation
/** RFC 4253 §7.2: HASH(K || H || letter || session_id), extended by HASH(K || H || K1 || … ) to `len` bytes */
export function deriveKey(hash: string, kEnc: Buffer, h: Buffer, letter: string, sessionId: Buffer, len: number): Buffer {
  let out = createHash(hash).update(kEnc).update(h).update(letter).update(sessionId).digest();
  while (out.length < len) out = Buffer.concat([out, createHash(hash).update(kEnc).update(h).update(out).digest()]);
  return out.subarray(0, len);
}

// ------------------------------------------------------------------------------------------ host keys
export const HOSTKEY_ALGS = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256"];
const EC: Record<string, { curve: string; jwk: string; hash: string; size: number }> = {
  nistp256: { curve: "nistp256", jwk: "P-256", hash: "sha256", size: 32 },
  nistp384: { curve: "nistp384", jwk: "P-384", hash: "sha384", size: 48 },
  nistp521: { curve: "nistp521", jwk: "P-521", hash: "sha512", size: 66 },
};
const b64u = (b: Buffer) => b.toString("base64url");
const leftPad = (b: Buffer, n: number) => (b.length >= n ? b.subarray(b.length - n) : Buffer.concat([Buffer.alloc(n - b.length), b]));

/** the key TYPE inside a public key blob ("ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa") */
export function blobType(blob: Buffer): string { return new SshReader(blob).string(64).toString("latin1"); }
/** OpenSSH's SHA256 fingerprint: base64 (unpadded) of SHA-256 over the key blob */
export function fingerprint(blob: Buffer): string { return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`; }

/** a node KeyObject for an SSH public key blob (ed25519 / ecdsa nistp* / rsa); throws on anything else or malformed */
export function publicKeyFromBlob(blob: Buffer): { type: string; key: KeyObject; ec?: (typeof EC)[string]; bits?: number } {
  const r = new SshReader(blob);
  const type = r.string(64).toString("latin1");
  if (type === "ssh-ed25519") {
    const pk = r.string(64); r.end();
    if (pk.length !== 32) throw new SshWireError("ed25519 key must be 32 bytes");
    return { type, key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(pk) }, format: "jwk" }) };
  }
  if (type.startsWith("ecdsa-sha2-")) {
    const curveName = r.string(64).toString("latin1"), q = r.string(256); r.end();
    const ec = EC[curveName];
    if (!ec || type !== `ecdsa-sha2-${curveName}`) throw new SshWireError(`unsupported ECDSA curve ${curveName}`);
    if (q.length !== 1 + 2 * ec.size || q[0] !== 4) throw new SshWireError("ECDSA point must be uncompressed and of the curve's size");
    return { type, ec, key: createPublicKey({ key: { kty: "EC", crv: ec.jwk, x: b64u(q.subarray(1, 1 + ec.size)), y: b64u(q.subarray(1 + ec.size)) }, format: "jwk" }) };
  }
  if (type === "ssh-rsa") {
    const e = r.mpint(), n = r.mpint(); r.end();
    const bits = n.length * 8 - Math.clz32(n[0]) + 24;
    if (bits < 2048) throw new SshWireError(`RSA key of ${bits} bits refused (minimum 2048)`);
    return { type, bits, key: createPublicKey({ key: { kty: "RSA", n: b64u(n), e: b64u(e) }, format: "jwk" }) };
  }
  throw new SshWireError(`unsupported key type ${type}`);
}

/**
 * Verifies an SSH signature blob over `data` by `keyBlob` for the negotiated signature algorithm `alg`
 * (RFC 8709 ed25519, RFC 5656 §3.1.2 ECDSA (r, s) mpints, RFC 8332 rsa-sha2-256/512). The algorithm name inside the
 * signature must equal `alg` (a server may not substitute another hash).
 */
export function verifySignature(alg: string, keyBlob: Buffer, data: Buffer, sigBlob: Buffer): boolean {
  const pk = publicKeyFromBlob(keyBlob);
  const sr = new SshReader(sigBlob);
  const sigAlg = sr.string(64).toString("latin1"), sig = sr.string(2048); sr.end();
  if (sigAlg !== alg) return false;
  if (alg === "ssh-ed25519") return pk.type === "ssh-ed25519" && sig.length === 64 && cverify(null, data, pk.key, sig);
  if (alg.startsWith("ecdsa-sha2-")) {
    if (pk.type !== alg || !pk.ec) return false;
    const rr = new SshReader(sig); const r = rr.mpint(), s = rr.mpint(); rr.end();
    if (r.length > pk.ec.size || s.length > pk.ec.size) return false;
    return cverify(pk.ec.hash, data, { key: pk.key, dsaEncoding: "ieee-p1363" }, Buffer.concat([leftPad(r, pk.ec.size), leftPad(s, pk.ec.size)]));
  }
  if (alg === "rsa-sha2-256" || alg === "rsa-sha2-512") {
    if (pk.type !== "ssh-rsa") return false;
    const modLen = Math.ceil(pk.bits! / 8);
    if (sig.length > modLen) return false;
    return cverify(alg === "rsa-sha2-256" ? "sha256" : "sha512", data, pk.key, leftPad(sig, modLen));
  }
  return false;
}

/** which host-key signature algorithms a stored key TYPE can satisfy (an RSA key: either SHA-2 variant) */
export function algsForKeyType(type: string): string[] { return type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256"] : [type]; }

export function writerBlob(f: (w: SshWriter) => void): Buffer { const w = new SshWriter(); f(w); return w.build(); }
