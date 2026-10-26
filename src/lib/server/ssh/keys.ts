import { createDecipheriv, createCipheriv, createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as csign, type KeyObject } from "node:crypto";
import { SshReader, SshWriter, SshWireError } from "./wire";

/**
 * TT44 (TD-03): user keys for public-key authentication. Original code.
 *
 *  - OpenSSH private keys ("openssh-key-v1", PROTOCOL.key): ssh-ed25519, ecdsa-sha2-nistp256/384/521, ssh-rsa;
 *    unencrypted or encrypted with kdf "bcrypt" (bcrypt_pbkdf) + aes256-ctr / aes128-ctr / aes256-gcm@openssh.com.
 *  - PEM / PKCS#8 keys (BEGIN PRIVATE KEY, RSA, EC, ENCRYPTED PRIVATE KEY) through node:crypto.
 *  - Generation of new ed25519 keys in OpenSSH format (optionally passphrase-encrypted, bcrypt 24 rounds, aes256-ctr).
 *
 * bcrypt_pbkdf needs Blowfish, whose initial P-array and S-boxes are the hexadecimal digits of π's fractional part.
 * They are COMPUTED here (Machin's formula in BigInt fixed point, 64 guard bits) the first time a key needs them —
 * no table is typed in. Checked by tests against ssh-keygen-encrypted keys (decrypt) and ssh-keygen itself (reads ours).
 */

export interface SshPrivateKey {
  type: string; // "ssh-ed25519" | "ecdsa-sha2-nistp256" | … | "ssh-rsa"
  publicBlob: Buffer;
  comment: string;
  /** an SSH signature blob: string alg || string signature */
  sign(alg: string, data: Buffer): Buffer;
}
export type KeyErrorCode = "passphrase-needed" | "bad-passphrase" | "unsupported" | "malformed";
export class KeyError extends Error { code: KeyErrorCode; constructor(msg: string, code: KeyErrorCode) { super(msg); this.code = code; } }

const EC: Record<string, { jwk: string; hash: string; size: number }> = {
  nistp256: { jwk: "P-256", hash: "sha256", size: 32 }, nistp384: { jwk: "P-384", hash: "sha384", size: 48 }, nistp521: { jwk: "P-521", hash: "sha512", size: 66 },
};
const JWK_CURVE: Record<string, string> = { "P-256": "nistp256", "P-384": "nistp384", "P-521": "nistp521" };
const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");
const leftPad = (b: Buffer, n: number) => (b.length >= n ? b.subarray(b.length - n) : Buffer.concat([Buffer.alloc(n - b.length), b]));
const stripZeros = (b: Buffer) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };

// ------------------------------------------------------------------------------------- Blowfish from π
let PI_WORDS: Uint32Array | null = null;
/** the first `n` 32-bit words of π's fractional part in hex (243F6A88 85A308D3 …) */
export function piWords(n = 1042): Uint32Array {
  if (PI_WORDS && PI_WORDS.length >= n) return PI_WORDS;
  const guard = 64, bits = 32 * n + guard;
  const S = BigInt(1) << BigInt(bits);
  const atanInv = (x: number): bigint => {
    const X = BigInt(x), X2 = X * X;
    let term = S / X, sum = term, k = 1, sign = -1;
    while (term !== BigInt(0)) { term /= X2; const t = term / BigInt(2 * k + 1); sum += sign > 0 ? t : -t; sign = -sign; k++; }
    return sum;
  };
  const pi = BigInt(16) * atanInv(5) - BigInt(4) * atanInv(239);
  const frac = (pi - BigInt(3) * S) >> BigInt(guard);
  const out = new Uint32Array(n);
  const mask = BigInt(0xffffffff);
  for (let i = 0; i < n; i++) out[i] = Number((frac >> BigInt(32 * (n - 1 - i))) & mask);
  PI_WORDS = out;
  return out;
}

class Blowfish {
  P: Uint32Array; S: Uint32Array[];
  constructor() {
    const w = piWords();
    this.P = w.slice(0, 18);
    this.S = [0, 1, 2, 3].map((i) => w.slice(18 + 256 * i, 18 + 256 * (i + 1)));
  }
  private F(x: number): number {
    const S = this.S;
    return (((S[0][x >>> 24] + S[1][(x >>> 16) & 255]) ^ S[2][(x >>> 8) & 255]) + S[3][x & 255]) >>> 0;
  }
  encipher(lr: Uint32Array, o = 0): void {
    let l = lr[o], r = lr[o + 1];
    for (let i = 0; i < 16; i++) { l = (l ^ this.P[i]) >>> 0; r = (r ^ this.F(l)) >>> 0; const t = l; l = r; r = t; }
    const t = l; l = r; r = t;
    r = (r ^ this.P[16]) >>> 0; l = (l ^ this.P[17]) >>> 0;
    lr[o] = l; lr[o + 1] = r;
  }
  /** Eksblowfish key schedule with salt (OpenBSD Blowfish_expandstate); data = null → expand0state */
  expand(data: Buffer | null, key: Buffer): void {
    const kj = { j: 0 }, dj = { j: 0 };
    for (let i = 0; i < 18; i++) this.P[i] = (this.P[i] ^ stream2word(key, kj)) >>> 0;
    const lr = new Uint32Array(2);
    const step = () => { if (data) { lr[0] ^= stream2word(data, dj); lr[1] ^= stream2word(data, dj); } this.encipher(lr); };
    for (let i = 0; i < 18; i += 2) { step(); this.P[i] = lr[0]; this.P[i + 1] = lr[1]; }
    for (let s = 0; s < 4; s++) for (let k = 0; k < 256; k += 2) { step(); this.S[s][k] = lr[0]; this.S[s][k + 1] = lr[1]; }
  }
}
function stream2word(d: Buffer, st: { j: number }): number {
  let w = 0;
  for (let i = 0; i < 4; i++) { w = ((w << 8) | d[st.j]) >>> 0; st.j = (st.j + 1) % d.length; }
  return w;
}
function bcryptHash(sha2pass: Buffer, sha2salt: Buffer): Buffer {
  const bf = new Blowfish();
  bf.expand(sha2salt, sha2pass);
  for (let i = 0; i < 64; i++) { bf.expand(null, sha2salt); bf.expand(null, sha2pass); }
  const magic = Buffer.from("OxychromaticBlowfishSwatDynamite", "latin1");
  const c = new Uint32Array(8); const st = { j: 0 };
  for (let i = 0; i < 8; i++) c[i] = stream2word(magic, st);
  for (let i = 0; i < 64; i++) for (let b = 0; b < 8; b += 2) bf.encipher(c, b);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(c[i], 4 * i);
  return out;
}
/** OpenBSD bcrypt_pbkdf (the KDF of passphrase-protected OpenSSH keys) */
export function bcryptPbkdf(pass: Buffer, salt: Buffer, keyLen: number, rounds: number): Buffer {
  if (rounds < 1 || keyLen < 1 || keyLen > 1024 || salt.length === 0 || salt.length > 1 << 20) throw new KeyError("bad bcrypt parameters", "malformed");
  const key = Buffer.alloc(keyLen);
  const stride = Math.ceil(keyLen / 32);
  let amt = Math.ceil(keyLen / stride);
  const sha2pass = createHash("sha512").update(pass).digest();
  let remaining = keyLen;
  for (let count = 1; remaining > 0; count++) {
    const cs = Buffer.alloc(4); cs.writeUInt32BE(count);
    let sha2salt = createHash("sha512").update(salt).update(cs).digest();
    let tmp = bcryptHash(sha2pass, sha2salt);
    const out = Buffer.from(tmp);
    for (let r = 1; r < rounds; r++) {
      sha2salt = createHash("sha512").update(tmp).digest();
      tmp = bcryptHash(sha2pass, sha2salt);
      for (let i = 0; i < 32; i++) out[i] ^= tmp[i];
    }
    amt = Math.min(amt, remaining);
    let i = 0;
    for (; i < amt; i++) { const dest = i * stride + (count - 1); if (dest >= keyLen) break; key[dest] = out[i]; }
    remaining -= i;
  }
  return key;
}

// ------------------------------------------------------------------------------------- key objects
function makeKey(type: string, kobj: KeyObject, publicBlob: Buffer, comment: string, ec?: { hash: string; size: number }): SshPrivateKey {
  return {
    type, publicBlob, comment,
    sign(alg: string, data: Buffer): Buffer {
      let sig: Buffer;
      if (type === "ssh-ed25519") { if (alg !== type) throw new KeyError(`cannot sign ${alg} with ${type}`, "unsupported"); sig = csign(null, data, kobj); }
      else if (type.startsWith("ecdsa-")) {
        if (alg !== type) throw new KeyError(`cannot sign ${alg} with ${type}`, "unsupported");
        const raw = csign(ec!.hash, data, { key: kobj, dsaEncoding: "ieee-p1363" });
        sig = new SshWriter().mpint(raw.subarray(0, ec!.size)).mpint(raw.subarray(ec!.size)).build();
      } else {
        const h = alg === "rsa-sha2-512" ? "sha512" : alg === "rsa-sha2-256" ? "sha256" : alg === "ssh-rsa" ? "sha1" : "";
        if (!h) throw new KeyError(`cannot sign ${alg} with an RSA key`, "unsupported");
        sig = csign(h, data, kobj);
      }
      return new SshWriter().string(alg).string(sig).build();
    },
  };
}
/** the SSH public blob and type for a node private KeyObject */
function blobFromKeyObject(k: KeyObject): { type: string; blob: Buffer; ec?: { hash: string; size: number } } {
  const j = k.export({ format: "jwk" }) as { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string };
  if (j.kty === "OKP" && j.crv === "Ed25519") return { type: "ssh-ed25519", blob: new SshWriter().string("ssh-ed25519").string(fromB64u(j.x!)).build() };
  if (j.kty === "EC" && j.crv && JWK_CURVE[j.crv]) {
    const c = JWK_CURVE[j.crv], e = EC[c];
    const q = Buffer.concat([Buffer.from([4]), leftPad(fromB64u(j.x!), e.size), leftPad(fromB64u(j.y!), e.size)]);
    return { type: `ecdsa-sha2-${c}`, blob: new SshWriter().string(`ecdsa-sha2-${c}`).string(c).string(q).build(), ec: e };
  }
  if (j.kty === "RSA") return { type: "ssh-rsa", blob: new SshWriter().string("ssh-rsa").mpint(fromB64u(j.e!)).mpint(fromB64u(j.n!)).build() };
  throw new KeyError(`unsupported key type ${j.kty}${j.crv ? ` ${j.crv}` : ""}`, "unsupported");
}

/** parses a private key file (OpenSSH or PEM). Throws KeyError("passphrase-needed") when encrypted and none given. */
export function parsePrivateKey(text: string, passphrase?: string): SshPrivateKey {
  const t = text.trim();
  if (t.includes("BEGIN OPENSSH PRIVATE KEY")) return parseOpenSsh(t, passphrase);
  if (/BEGIN (RSA |EC |ENCRYPTED |)PRIVATE KEY/.test(t)) {
    if (/ENCRYPTED|Proc-Type: 4,ENCRYPTED/.test(t) && !passphrase) throw new KeyError("this key is protected by a passphrase", "passphrase-needed");
    let k: KeyObject;
    try { k = createPrivateKey({ key: t, format: "pem", passphrase: passphrase ?? undefined }); }
    catch (e) { const m = (e as Error).message; throw new KeyError(/decrypt|bad decrypt|passphrase/i.test(m) ? "wrong passphrase" : `unreadable key: ${m}`, /decrypt|passphrase/i.test(m) ? "bad-passphrase" : "malformed"); }
    const { type, blob, ec } = blobFromKeyObject(k);
    return makeKey(type, k, blob, "", ec);
  }
  if (t.includes("PuTTY-User-Key-File")) throw new KeyError("PuTTY .ppk keys are not supported — export it in OpenSSH format (PuTTYgen ▸ Conversions)", "unsupported");
  throw new KeyError("not a private key (expected an OpenSSH or PEM private key)", "malformed");
}

function parseOpenSsh(t: string, passphrase?: string): SshPrivateKey {
  const b64 = t.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const raw = Buffer.from(b64, "base64");
  const MAGIC = Buffer.from("openssh-key-v1\0", "latin1");
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new KeyError("not an openssh-key-v1 file", "malformed");
  try {
    const r = new SshReader(raw.subarray(MAGIC.length));
    const cipher = r.utf8(64), kdf = r.utf8(64), kdfOpts = r.string(1024), n = r.u32();
    if (n !== 1) throw new KeyError(`files holding ${n} keys are not supported`, "unsupported");
    const pub = r.string(16384);
    let priv = Buffer.from(r.string(1 << 20));
    if (cipher !== "none") {
      if (kdf !== "bcrypt") throw new KeyError(`unsupported key KDF ${kdf}`, "unsupported");
      if (!passphrase) throw new KeyError("this key is protected by a passphrase", "passphrase-needed");
      const kr = new SshReader(kdfOpts); const salt = kr.string(1024), rounds = kr.u32();
      const spec = ({ "aes256-ctr": { alg: "aes-256-ctr", k: 32, iv: 16, tag: 0 }, "aes128-ctr": { alg: "aes-128-ctr", k: 16, iv: 16, tag: 0 }, "aes256-gcm@openssh.com": { alg: "aes-256-gcm", k: 32, iv: 12, tag: 16 } } as Record<string, { alg: string; k: number; iv: number; tag: number }>)[cipher];
      if (!spec) throw new KeyError(`unsupported key cipher ${cipher}`, "unsupported");
      if (rounds > 1 << 16) throw new KeyError("absurd bcrypt round count", "malformed");
      const km = bcryptPbkdf(Buffer.from(passphrase, "utf8"), salt, spec.k + spec.iv, rounds);
      if (spec.tag) {
        const tag = r.raw(16);
        const d = createDecipheriv(spec.alg as "aes-256-gcm", km.subarray(0, spec.k), km.subarray(spec.k), { authTagLength: 16 });
        d.setAuthTag(tag);
        try { priv = Buffer.concat([d.update(priv), d.final()]); } catch { throw new KeyError("wrong passphrase", "bad-passphrase"); }
      } else {
        const d = createDecipheriv(spec.alg, km.subarray(0, spec.k), km.subarray(spec.k));
        priv = Buffer.concat([d.update(priv), d.final()]);
      }
    }
    const pr = new SshReader(priv);
    if (pr.u32() !== pr.u32()) throw new KeyError(cipher === "none" ? "corrupt key (check words differ)" : "wrong passphrase", cipher === "none" ? "malformed" : "bad-passphrase");
    const type = pr.utf8(64);
    let kobj: KeyObject, ec: { hash: string; size: number } | undefined;
    if (type === "ssh-ed25519") {
      const pk = pr.string(64), sk = pr.string(128);
      if (pk.length !== 32 || sk.length !== 64 || !sk.subarray(32).equals(pk)) throw new KeyError("malformed ed25519 key", "malformed");
      kobj = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64u(sk.subarray(0, 32)), x: b64u(pk) }, format: "jwk" });
    } else if (type.startsWith("ecdsa-sha2-")) {
      const curve = pr.utf8(64), q = pr.string(256), d = pr.mpint();
      const e = EC[curve];
      if (!e || type !== `ecdsa-sha2-${curve}` || q[0] !== 4 || q.length !== 1 + 2 * e.size) throw new KeyError("malformed ECDSA key", "malformed");
      kobj = createPrivateKey({ key: { kty: "EC", crv: e.jwk, x: b64u(q.subarray(1, 1 + e.size)), y: b64u(q.subarray(1 + e.size)), d: b64u(leftPad(d, e.size)) }, format: "jwk" });
      ec = e;
    } else if (type === "ssh-rsa") {
      const nn = pr.mpint(), e = pr.mpint(), d = pr.mpint(), iqmp = pr.mpint(), p = pr.mpint(), q = pr.mpint();
      const big = (b: Buffer) => BigInt(`0x${b.toString("hex") || "0"}`);
      const toBuf = (v: bigint) => { let h = v.toString(16); if (h.length % 2) h = `0${h}`; return Buffer.from(h, "hex"); };
      const D = big(d), P = big(p), Q = big(q);
      kobj = createPrivateKey({ key: { kty: "RSA", n: b64u(nn), e: b64u(e), d: b64u(d), p: b64u(p), q: b64u(q), dp: b64u(toBuf(D % (P - BigInt(1)))), dq: b64u(toBuf(D % (Q - BigInt(1)))), qi: b64u(iqmp) }, format: "jwk" });
    } else throw new KeyError(`unsupported key type ${type}`, "unsupported");
    const comment = pr.utf8(4096);
    // padding 1, 2, 3, … (PROTOCOL.key §3) — a wrong passphrase on CTR also shows up here
    const pad = pr.rest();
    for (let i = 0; i < pad.length; i++) if (pad[i] !== ((i + 1) & 0xff)) throw new KeyError("corrupt key padding", "malformed");
    const derived = blobFromKeyObject(kobj);
    if (!derived.blob.equals(pub)) throw new KeyError("private key does not match its public key", "malformed");
    return makeKey(type, kobj, Buffer.from(pub), comment, ec ?? derived.ec);
  } catch (e) {
    if (e instanceof KeyError) throw e;
    if (e instanceof SshWireError) throw new KeyError(`malformed key: ${e.message}`, "malformed");
    throw new KeyError(`unreadable key: ${(e as Error).message}`, "malformed");
  }
}

/** "type base64 comment" (authorized_keys / .pub line) for a public blob */
export function publicLine(blob: Buffer, comment = ""): string {
  const type = new SshReader(blob).utf8(64);
  return `${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
}

/** a new ed25519 key in OpenSSH format; with a passphrase: bcrypt (24 rounds, 16-byte salt) + aes256-ctr */
export function generateEd25519(comment: string, passphrase?: string): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const j = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const seed = fromB64u(j.d), pk = fromB64u(j.x);
  const blob = new SshWriter().string("ssh-ed25519").string(pk).build();
  const check = randomBytes(4).readUInt32BE(0);
  const block = passphrase ? 16 : 8;
  const body = new SshWriter().u32(check).u32(check).string("ssh-ed25519").string(pk).string(Buffer.concat([seed, pk])).string(comment);
  let privSection = body.build();
  const padN = (block - (privSection.length % block)) % block;
  privSection = Buffer.concat([privSection, Buffer.from(Array.from({ length: padN }, (_, i) => i + 1))]);
  let cipher = "none", kdf = "none", kdfOpts: Buffer = Buffer.alloc(0);
  if (passphrase) {
    const salt = randomBytes(16), rounds = 24;
    const km = bcryptPbkdf(Buffer.from(passphrase, "utf8"), salt, 48, rounds);
    const c = createCipheriv("aes-256-ctr", km.subarray(0, 32), km.subarray(32));
    privSection = Buffer.concat([c.update(privSection), c.final()]);
    cipher = "aes256-ctr"; kdf = "bcrypt"; kdfOpts = new SshWriter().string(salt).u32(rounds).build();
  }
  const file = new SshWriter().raw(Buffer.from("openssh-key-v1\0", "latin1")).string(cipher).string(kdf).string(kdfOpts).u32(1).string(blob).string(privSection).build();
  const b64 = file.toString("base64").replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  return { privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`, publicKey: `${publicLine(blob, comment)}\n` };
}

export { stripZeros };
