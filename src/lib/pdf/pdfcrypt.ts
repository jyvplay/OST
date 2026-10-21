/**
 * TT52 — PDF standard security handler (ISO 32000-2 §7.6.4), original code from the specification:
 *   R2/R3/R4 (RC4 40–128 bit, AESV2 128 bit) — Algorithms 1, 2, 6 (user) and 7 (owner);
 *   R5/R6 (AESV3 256 bit) — Algorithm 2.A (key) and 2.B (R6 hash);
 *   crypt filters (/CF, /StmF, /StrF, /Identity, per-stream /Crypt filters), /EncryptMetadata false.
 * MD5 (RFC 1321) and RC4 are written here; SHA-2 and AES come from office/cryptoprims.ts (FIPS 180-4 / FIPS 197).
 * Passwords: R2–R4 use PDFDocEncoding bytes (≤ 32); R5/R6 use UTF-8 after the SASLprep mapping + NFKC (≤ 127 bytes);
 * SASLprep's prohibited-character checks are not applied.
 */
import { aesCbcDecrypt, aesCbcEncrypt, sha256, sha384, sha512, concat } from "../office/cryptoprims";
import { PDict, PStr, isName, isNum, isDict, isArr, latin1ToBytes, type PObj, type Bytes } from "./pdfobj";

/* ------------------------------------------------------------------ MD5 (RFC 1321) */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5(msg: Bytes): Bytes {
  const total = Math.ceil((msg.length + 9) / 64) * 64; const m = new Uint8Array(total); m.set(msg); m[msg.length] = 0x80;
  const dv = new DataView(m.buffer); const bits = msg.length * 8; dv.setUint32(total - 8, bits >>> 0, true); dv.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const w = new Uint32Array(16);
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = b;
      const x = (a + f + K[i] + w[g]) >>> 0;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) >>> 0; a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16); const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

/* ------------------------------------------------------------------ RC4 */
export function rc4(key: Bytes, data: Bytes): Bytes {
  const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
  return out;
}

/* ------------------------------------------------------------------ AES with PKCS#5 padding (AESV2/AESV3 data) */
function aesDecryptData(key: Bytes, data: Bytes): Bytes {
  if (data.length < 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16); let body = data.subarray(16);
  if (body.length % 16) body = body.subarray(0, body.length - (body.length % 16)); // truncated tail: drop the partial block
  if (!body.length) return new Uint8Array(0);
  const out = aesCbcDecrypt(key, iv, body);
  const pad = out[out.length - 1];
  return pad >= 1 && pad <= 16 && out.length >= pad ? out.subarray(0, out.length - pad) : out;
}
function aesEncryptData(key: Bytes, data: Bytes, iv: Bytes): Bytes {
  const pad = 16 - (data.length % 16); const p = new Uint8Array(data.length + pad); p.set(data); p.fill(pad, data.length);
  return concat(iv, aesCbcEncrypt(key, iv, p));
}

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
const padPw = (pw: Bytes) => { const o = new Uint8Array(32); const n = Math.min(32, pw.length); o.set(pw.subarray(0, n)); o.set(PAD.subarray(0, 32 - n), n); return o; };
const le32 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const eq = (a: Bytes, b: Bytes, n = a.length) => { if (a.length < n || b.length < n) return false; for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };

export type CryptMethod = "None" | "V2" | "AESV2" | "AESV3" | "Identity";
export interface Permissions { print: boolean; modify: boolean; copy: boolean; annotate: boolean; fillForms: boolean; extract: boolean; assemble: boolean; printHigh: boolean; raw: number }

export class SecurityHandler {
  readonly V: number; readonly R: number; readonly lengthBytes: number;
  readonly O: Bytes; readonly U: Bytes; readonly OE: Bytes | null; readonly UE: Bytes | null; readonly P: number;
  readonly id0: Bytes; readonly encryptMetadata: boolean;
  readonly stmMethod: CryptMethod; readonly strMethod: CryptMethod; readonly filters: Map<string, CryptMethod>;
  key: Bytes | null = null;
  /** which password unlocked the file */
  unlockedAs: "user" | "owner" | null = null;

  constructor(enc: PDict, id0: Bytes) {
    const n = (k: string, d: number) => { const v = enc.get(k); return isNum(v) ? v : d; };
    const s = (k: string) => { const v = enc.get(k); return v instanceof PStr ? v.b : null; };
    if (!isName(enc.get("Filter"), "Standard")) throw new Error(`pdf: unsupported security handler ${(enc.get("Filter") as { n?: string })?.n ?? "?"}`);
    this.V = n("V", 0); this.R = n("R", 2); this.P = n("P", 0) | 0;
    this.O = s("O") ?? new Uint8Array(32); this.U = s("U") ?? new Uint8Array(32); this.OE = s("OE"); this.UE = s("UE");
    this.id0 = id0; this.encryptMetadata = enc.get("EncryptMetadata") !== false;
    this.lengthBytes = this.V === 1 ? 5 : Math.max(5, Math.min(32, Math.floor(n("Length", this.V >= 5 ? 256 : 40) / 8)));
    if (![1, 2, 4, 5].includes(this.V)) throw new Error(`pdf: unsupported encryption V=${this.V}`);
    if (this.R < 2 || this.R > 6) throw new Error(`pdf: unsupported encryption revision R=${this.R}`);
    this.filters = new Map([["Identity", "Identity" as CryptMethod]]);
    if (this.V >= 4) {
      const cf = enc.get("CF");
      if (isDict(cf)) for (const [name, f] of cf.m) {
        if (!isDict(f)) continue; const m = f.get("CFM");
        this.filters.set(name, isName(m, "AESV2") ? "AESV2" : isName(m, "AESV3") ? "AESV3" : isName(m, "V2") ? "V2" : isName(m, "None") ? "None" : "Identity");
        const len = f.get("Length"); if (this.V === 4 && isNum(len) && len > 0) (this as { lengthBytes: number }).lengthBytes = len > 32 ? Math.floor(len / 8) : len;
      }
      const sm = enc.get("StmF"), st = enc.get("StrF");
      this.stmMethod = isName(sm) ? this.filters.get(sm.n) ?? "Identity" : "Identity";
      this.strMethod = isName(st) ? this.filters.get(st.n) ?? "Identity" : "Identity";
    } else { this.stmMethod = "V2"; this.strMethod = "V2"; }
  }

  get permissions(): Permissions {
    const p = this.P >>> 0; const bit = (b: number) => (p & (1 << (b - 1))) !== 0;
    return { print: bit(3), modify: bit(4), copy: bit(5), annotate: bit(6), fillForms: bit(9), extract: bit(10), assemble: bit(11), printHigh: bit(12), raw: this.P };
  }

  /** try a password as user, then as owner; sets the file key. Empty string = the common "no user password" case. */
  authenticate(password: string): boolean {
    if (this.R >= 5) {
      const pw = new TextEncoder().encode(saslprepMap(password)).subarray(0, 127);
      const U48 = this.U.subarray(0, 48);
      if (eq(this.hash(pw, this.O.subarray(32, 40), U48), this.O, 32) && this.OE) { this.key = aesCbcDecrypt(this.hash(pw, this.O.subarray(40, 48), U48), new Uint8Array(16), this.OE.subarray(0, 32)); this.unlockedAs = "owner"; return true; }
      if (eq(this.hash(pw, this.U.subarray(32, 40), new Uint8Array(0)), this.U, 32) && this.UE) { this.key = aesCbcDecrypt(this.hash(pw, this.U.subarray(40, 48), new Uint8Array(0)), new Uint8Array(16), this.UE.subarray(0, 32)); this.unlockedAs = "user"; return true; }
      return false;
    }
    const pw = latin1ToBytes(password).subarray(0, 32);
    const k = this.userKey(pw); if (k) { this.key = k; this.unlockedAs = "user"; return true; }
    // Algorithm 7: owner password → RC4 key → decrypt /O to recover the user password
    let h = md5(padPw(pw)); if (this.R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
    const okey = h.subarray(0, this.R === 2 ? 5 : this.lengthBytes);
    let up = this.O.subarray(0, 32);
    if (this.R === 2) up = rc4(okey, up);
    else for (let i = 19; i >= 0; i--) up = rc4(okey.map((b) => b ^ i), up);
    const k2 = this.userKey(up, true); if (k2) { this.key = k2; this.unlockedAs = "owner"; return true; }
    return false;
  }
  /** Algorithm 2 (file key) + Algorithm 6 (check against /U) */
  private userKey(pw: Bytes, padded = false): Bytes | null {
    const n = this.R === 2 ? 5 : this.lengthBytes;
    const parts = [padded ? padPw(pw) : padPw(pw), this.O.subarray(0, 32), le32(this.P), this.id0];
    if (this.R >= 4 && !this.encryptMetadata) parts.push(Uint8Array.from([255, 255, 255, 255]));
    let h = md5(concat(...parts));
    if (this.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    const key = h.slice(0, n);
    if (this.R === 2) return eq(rc4(key, PAD), this.U, 32) ? key : null;
    let x = md5(concat(PAD, this.id0));
    x = rc4(key, x); for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    return eq(x, this.U, 16) ? key : null;
  }
  /** R5: SHA-256; R6: Algorithm 2.B */
  private hash(pw: Bytes, salt: Bytes, udata: Bytes): Bytes {
    let k = sha256(concat(pw, salt, udata));
    if (this.R === 5) return k;
    for (let i = 0; ; i++) {
      const one = concat(pw, k, udata); const k1 = new Uint8Array(one.length * 64); for (let r = 0; r < 64; r++) k1.set(one, r * one.length);
      const e = aesCbcEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1);
      let sum = 0; for (let j = 0; j < 16; j++) sum += e[j];
      const m = sum % 3; k = m === 0 ? sha256(e) : m === 1 ? sha384(e) : sha512(e);
      if (i >= 63 && e[e.length - 1] <= i - 32) break;
      if (i > 2000) break; // cannot happen for valid inputs; bounds a hostile loop
    }
    return k.subarray(0, 32);
  }

  /** Algorithm 1: per-object key (not used by AESV3, which uses the file key directly) */
  private objKey(num: number, gen: number, aes: boolean): Bytes {
    const k = this.key!; const parts = [k, Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255])];
    if (aes) parts.push(Uint8Array.from([0x73, 0x41, 0x6c, 0x54])); // "sAlT"
    return md5(concat(...parts)).subarray(0, Math.min(16, k.length + 5));
  }
  private run(method: CryptMethod, num: number, gen: number, data: Bytes, encrypt: boolean, iv?: Bytes): Bytes {
    if (!this.key || method === "Identity" || method === "None") return data;
    if (method === "AESV3") return encrypt ? aesEncryptData(this.key, data, iv ?? randomIv()) : aesDecryptData(this.key, data);
    if (method === "AESV2") { const k = this.objKey(num, gen, true); return encrypt ? aesEncryptData(k, data, iv ?? randomIv()) : aesDecryptData(k, data); }
    return rc4(this.objKey(num, gen, false), data); // V2 (RC4) is symmetric
  }
  decryptString(num: number, gen: number, b: Bytes) { return this.run(this.strMethod, num, gen, b, false); }
  encryptString(num: number, gen: number, b: Bytes, iv?: Bytes) { return this.run(this.strMethod, num, gen, b, true, iv); }
  /** `cryptName` is the /Name of a per-stream /Crypt filter, if any */
  decryptStream(num: number, gen: number, b: Bytes, cryptName?: string) { return this.run(cryptName ? this.filters.get(cryptName) ?? "Identity" : this.stmMethod, num, gen, b, false); }
  encryptStream(num: number, gen: number, b: Bytes, cryptName?: string, iv?: Bytes) { return this.run(cryptName ? this.filters.get(cryptName) ?? "Identity" : this.stmMethod, num, gen, b, true, iv); }
}
/** SASLprep (RFC 4013) mapping + NFKC: B.1 characters map to nothing, C.1.2 non-ASCII spaces map to U+0020.
 *  (The prohibited-output and bidi checks of §2.3/2.4 are not enforced: a password that fails them simply won't match.) */
export function saslprepMap(s: string): string {
  const out: string[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0xad || c === 0x34f || c === 0x1806 || (c >= 0x180b && c <= 0x180d) || (c >= 0x200b && c <= 0x200d) || c === 0x2060 || (c >= 0xfe00 && c <= 0xfe0f) || c === 0xfeff) continue;
    if (c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) { out.push(" "); continue; }
    out.push(ch);
  }
  return out.join("").normalize("NFKC");
}
function randomIv(): Bytes { const b = new Uint8Array(16); (globalThis.crypto as Crypto).getRandomValues(b); return b; }

/** the /Name of a per-stream Crypt filter, if the stream uses one (§7.6.6) */
export function streamCryptName(dict: PDict, resolve: (o: PObj | undefined) => PObj | undefined): string | undefined {
  const f = resolve(dict.get("Filter")); const p = resolve(dict.get("DecodeParms"));
  const fs = isArr(f) ? f : [f]; const ps = isArr(p) ? p : [p];
  for (let i = 0; i < fs.length; i++) if (isName(resolve(fs[i]), "Crypt")) { const pp = resolve(ps[i]); const nm = isDict(pp) ? pp.get("Name") : undefined; return isName(nm) ? nm.n : "Identity"; }
  return undefined;
}
