/**
 * TT79 — ZIP encryption, first-party and synchronous (works in the browser and in Node without WebCrypto's async API):
 *
 *  - Traditional PKWARE encryption ("ZipCrypto", APPNOTE §6.1): three 32-bit keys updated with CRC-32, a 12-byte
 *    encryption header whose last byte checks the password (CRC high byte, or the DOS time high byte when the sizes
 *    are in a data descriptor). Weak by design — offered for compatibility and labelled as such in the UI.
 *  - WinZip AES (AE-1 / AE-2, documented by WinZip in "AES Encryption Information"): PBKDF2-HMAC-SHA1 with 1000
 *    iterations derives an AES key, an HMAC-SHA1 key and a 2-byte password verifier from the password and a salt of
 *    8 / 12 / 16 bytes; data is AES-CTR with a 128-bit LITTLE-endian counter starting at 1 (WebCrypto's AES-CTR counts
 *    big-endian, hence the own AES forward cipher below); a 10-byte truncated HMAC-SHA1 over the ciphertext follows.
 *
 * AES (FIPS-197 forward cipher only — CTR never needs the inverse), SHA-1 (FIPS 180-4), HMAC (RFC 2104) and PBKDF2
 * (RFC 8018) are written from those standards. Verified against pyzipper / Info-ZIP / Python zipfile in
 * scripts/tt79-archive.mts and against published test vectors.
 */
import type { Bytes } from "./inflate";

/* ------------------------------------------------------------------ CRC-32 (reflected, 0xEDB88320) */
export const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(d: Bytes, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/* ------------------------------------------------------------------ ZipCrypto */
class ZipCryptoKeys {
  k0 = 0x12345678; k1 = 0x23456789; k2 = 0x34567890;
  constructor(password: Bytes) { for (const b of password) this.update(b); }
  update(b: number) {
    this.k0 = (CRC_TABLE[(this.k0 ^ b) & 0xff] ^ (this.k0 >>> 8)) >>> 0;
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = (CRC_TABLE[(this.k2 ^ (this.k1 >>> 24)) & 0xff] ^ (this.k2 >>> 8)) >>> 0;
  }
  stream() { const t = (this.k2 | 2) & 0xffff; return (Math.imul(t, t ^ 1) >>> 8) & 0xff; }
}
/** decrypt; `check` = the expected last header byte (CRC >>> 24, or DOS time >>> 8 with a data descriptor) */
export function zipCryptoDecrypt(data: Bytes, password: Bytes, check: number, checkAlt?: number): Bytes {
  if (data.length < 12) throw new Error("ZipCrypto: truncated encryption header");
  const k = new ZipCryptoKeys(password); const out = new Uint8Array(data.length - 12);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i] ^ k.stream(); k.update(c);
    if (i < 12) last = c; else out[i - 12] = c;
  }
  if (last !== check && last !== checkAlt) throw new PasswordError("wrong password");
  return out;
}
export function zipCryptoEncrypt(plain: Bytes, password: Bytes, check: number, random: (n: number) => Bytes): Bytes {
  const k = new ZipCryptoKeys(password); const hdr = random(12); hdr[11] = check & 0xff;
  const out = new Uint8Array(12 + plain.length);
  const enc = (b: number, i: number) => { const t = k.stream(); k.update(b); out[i] = b ^ t; };
  for (let i = 0; i < 12; i++) enc(hdr[i], i);
  for (let i = 0; i < plain.length; i++) enc(plain[i], 12 + i);
  return out;
}

export class PasswordError extends Error { constructor(m: string) { super(m); this.name = "PasswordError"; } }

/* ------------------------------------------------------------------ AES forward cipher (FIPS-197) */
const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256), T1 = new Uint32Array(256), T2 = new Uint32Array(256), T3 = new Uint32Array(256);
(() => {
  // S-box from the multiplicative inverse in GF(2^8) followed by the affine transform (FIPS-197 §5.1.1)
  const exp = new Uint8Array(512), log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x ^= (x << 1) ^ (x & 0x80 ? 0x1b : 0); x &= 0xff; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  for (let i = 0; i < 256; i++) {
    const inv = i ? exp[255 - log[i]] : 0;
    let s = inv, r = inv;
    for (let k = 0; k < 4; k++) { r = ((r << 1) | (r >>> 7)) & 0xff; s ^= r; }
    SBOX[i] = s ^ 0x63;
  }
  const xt = (v: number) => ((v << 1) ^ (v & 0x80 ? 0x1b : 0)) & 0xff;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i], s2 = xt(s), s3 = s2 ^ s;
    const w = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0; // MixColumns column for byte in row 0
    T0[i] = w; T1[i] = ((w >>> 8) | (w << 24)) >>> 0; T2[i] = ((w >>> 16) | (w << 16)) >>> 0; T3[i] = ((w >>> 24) | (w << 8)) >>> 0;
  }
})();
export function aesExpandKey(key: Bytes): Uint32Array {
  const nk = key.length / 4; if (![4, 6, 8].includes(nk)) throw new Error("AES: key must be 16, 24 or 32 bytes");
  const nr = nk + 6, w = new Uint32Array(4 * (nr + 1));
  for (let i = 0; i < nk; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  let rcon = 1;
  for (let i = nk; i < w.length; i++) {
    let t = w[i - 1];
    if (i % nk === 0) {
      t = ((SBOX[(t >>> 16) & 0xff] << 24) | (SBOX[(t >>> 8) & 0xff] << 16) | (SBOX[t & 0xff] << 8) | SBOX[t >>> 24]) >>> 0;
      t = (t ^ (rcon << 24)) >>> 0; rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
    } else if (nk > 6 && i % nk === 4) {
      t = ((SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
    }
    w[i] = (w[i - nk] ^ t) >>> 0;
  }
  return w;
}
/** encrypt one 16-byte block in place-free form: in[io..io+16) → out[oo..oo+16) */
export function aesEncryptBlock(w: Uint32Array, inp: Bytes, io: number, out: Bytes, oo: number) {
  const nr = w.length / 4 - 1;
  let s0 = (((inp[io] << 24) | (inp[io + 1] << 16) | (inp[io + 2] << 8) | inp[io + 3]) ^ w[0]) >>> 0;
  let s1 = (((inp[io + 4] << 24) | (inp[io + 5] << 16) | (inp[io + 6] << 8) | inp[io + 7]) ^ w[1]) >>> 0;
  let s2 = (((inp[io + 8] << 24) | (inp[io + 9] << 16) | (inp[io + 10] << 8) | inp[io + 11]) ^ w[2]) >>> 0;
  let s3 = (((inp[io + 12] << 24) | (inp[io + 13] << 16) | (inp[io + 14] << 8) | inp[io + 15]) ^ w[3]) >>> 0;
  let k = 4;
  for (let r = 1; r < nr; r++) {
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k];
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k + 1];
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k + 2];
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k + 3];
    s0 = t0 >>> 0; s1 = t1 >>> 0; s2 = t2 >>> 0; s3 = t3 >>> 0; k += 4;
  }
  const f = (a: number, b: number, c: number, d: number, kw: number) =>
    (((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff]) ^ kw) >>> 0;
  const o0 = f(s0, s1, s2, s3, w[k]), o1 = f(s1, s2, s3, s0, w[k + 1]), o2 = f(s2, s3, s0, s1, w[k + 2]), o3 = f(s3, s0, s1, s2, w[k + 3]);
  for (const [i, v] of [o0, o1, o2, o3].entries()) { out[oo + 4 * i] = v >>> 24; out[oo + 4 * i + 1] = (v >>> 16) & 0xff; out[oo + 4 * i + 2] = (v >>> 8) & 0xff; out[oo + 4 * i + 3] = v & 0xff; }
}
/** WinZip AES-CTR: 128-bit little-endian counter starting at 1; XOR is its own inverse */
export function aesCtrLE(key: Bytes, data: Bytes): Bytes {
  const w = aesExpandKey(key), out = new Uint8Array(data.length), ctr = new Uint8Array(16), ks = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    for (let i = 0; i < 16; i++) { ctr[i] = (ctr[i] + 1) & 0xff; if (ctr[i]) break; } // ++ little-endian (first block = 1)
    aesEncryptBlock(w, ctr, 0, ks, 0);
    const n = Math.min(16, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

/* ------------------------------------------------------------------ SHA-1 / HMAC / PBKDF2 */
export function sha1(msg: Bytes): Bytes {
  const ml = msg.length, nBlocks = ((ml + 8) >> 6) + 1, w = new Uint32Array(80);
  const buf = new Uint8Array(nBlocks * 64); buf.set(msg); buf[ml] = 0x80;
  const bits = ml * 8; const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(bits / 0x100000000)); dv.setUint32(buf.length - 4, bits >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let b = 0; b < nBlocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(b * 64 + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((bb << 30) | (bb >>> 2)) >>> 0; bb = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20); const o = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => o.setUint32(i * 4, h));
  return out;
}
export function hmacSha1(key: Bytes, msg: Bytes): Bytes {
  const k = key.length > 64 ? sha1(key) : key; const ipad = new Uint8Array(64 + msg.length), opad = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i++) { const b = k[i] ?? 0; ipad[i] = b ^ 0x36; opad[i] = b ^ 0x5c; }
  ipad.set(msg, 64); opad.set(sha1(ipad), 64); return sha1(opad);
}
export function pbkdf2Sha1(password: Bytes, salt: Bytes, iterations: number, len: number): Bytes {
  const out = new Uint8Array(len); const blk = new Uint8Array(salt.length + 4); blk.set(salt);
  for (let i = 1, o = 0; o < len; i++, o += 20) {
    blk[salt.length] = i >>> 24; blk[salt.length + 1] = (i >>> 16) & 0xff; blk[salt.length + 2] = (i >>> 8) & 0xff; blk[salt.length + 3] = i & 0xff;
    let u = hmacSha1(password, blk); const t = u.slice();
    for (let c = 1; c < iterations; c++) { u = hmacSha1(password, u); for (let k = 0; k < 20; k++) t[k] ^= u[k]; }
    out.set(t.subarray(0, Math.min(20, len - o)), o);
  }
  return out;
}

/* ------------------------------------------------------------------ WinZip AES framing */
export const AES_SALT = { 1: 8, 2: 12, 3: 16 } as const; // strength code → salt length (key 16 / 24 / 32 bytes)
function aesKeys(password: Bytes, salt: Bytes, strength: 1 | 2 | 3) {
  const kl = 8 + 8 * strength; const dk = pbkdf2Sha1(password, salt, 1000, 2 * kl + 2);
  return { key: dk.subarray(0, kl), mac: dk.subarray(kl, 2 * kl), verify: dk.subarray(2 * kl) };
}
export function winzipAesDecrypt(data: Bytes, password: Bytes, strength: 1 | 2 | 3): Bytes {
  const sl = AES_SALT[strength]; if (data.length < sl + 2 + 10) throw new Error("AES: truncated encrypted entry");
  const salt = data.subarray(0, sl), pv = data.subarray(sl, sl + 2), body = data.subarray(sl + 2, data.length - 10), tag = data.subarray(data.length - 10);
  const k = aesKeys(password, salt, strength);
  if (pv[0] !== k.verify[0] || pv[1] !== k.verify[1]) throw new PasswordError("wrong password");
  const mac = hmacSha1(k.mac, body);
  let diff = 0; for (let i = 0; i < 10; i++) diff |= mac[i] ^ tag[i];
  if (diff) throw new Error("AES: authentication code mismatch — the entry was modified or is corrupt");
  return aesCtrLE(k.key, body);
}
export function winzipAesEncrypt(plain: Bytes, password: Bytes, strength: 1 | 2 | 3, random: (n: number) => Bytes): Bytes {
  const sl = AES_SALT[strength], salt = random(sl), k = aesKeys(password, salt, strength);
  const body = aesCtrLE(k.key, plain), mac = hmacSha1(k.mac, body);
  const out = new Uint8Array(sl + 2 + body.length + 10);
  out.set(salt); out.set(k.verify, sl); out.set(body, sl + 2); out.set(mac.subarray(0, 10), sl + 2 + body.length);
  return out;
}
