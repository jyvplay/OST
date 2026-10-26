/**
 * TT45: ML-KEM (FIPS 203, August 2024) — ML-KEM-512 / 768 / 1024. Original code written from the algorithm text of
 * FIPS 203 (Algorithms 3–18 and §7 input checks); no code from any implementation was copied. Node 22's crypto has no
 * ML-KEM, but it has the Keccak functions FIPS 203 needs: SHA3-256 (H), SHA3-512 (G), SHAKE128 (XOF), SHAKE256 (PRF, J).
 *
 * Verified (scripts/tt45-unit.mts) against NIST's ACVP vectors (usnistgov/ACVP-Server, internalProjection.json:
 * keyGen, encapsulation, decapsulation incl. invalid ciphertexts, and the ek / dk input checks) and against OpenSSL's
 * ML-KEM through python `cryptography` (independent encaps/decaps both ways).
 *
 * The NTT constants are computed at load from ζ = 17 (a primitive 256th root of unity mod q = 3329) — nothing typed in.
 *
 * Side channels, disclosed: JavaScript gives no constant-time guarantee. Secret-dependent branches are avoided where
 * it matters (the implicit-rejection select and the re-encryption comparison are branch-free over bytes), but JIT and
 * `%` timing are not controlled. In SSH every ML-KEM key is ephemeral (one decapsulation per key), which removes the
 * repeated-query setting that decapsulation timing attacks need.
 */
import { createHash, randomBytes } from "node:crypto";

const Q = 3329, N = 256;
export interface MlKemParams { name: string; k: number; eta1: number; eta2: number; du: number; dv: number }
export const ML_KEM_512: MlKemParams = { name: "ML-KEM-512", k: 2, eta1: 3, eta2: 2, du: 10, dv: 4 };
export const ML_KEM_768: MlKemParams = { name: "ML-KEM-768", k: 3, eta1: 2, eta2: 2, du: 10, dv: 4 };
export const ML_KEM_1024: MlKemParams = { name: "ML-KEM-1024", k: 4, eta1: 2, eta2: 2, du: 11, dv: 5 };

export const sizes = (p: MlKemParams) => ({ ek: 384 * p.k + 32, dk: 768 * p.k + 96, ct: 32 * (p.du * p.k + p.dv), ss: 32 });

// ------------------------------------------------------------------------------------------- constants from ζ = 17
const bitrev7 = (i: number) => { let r = 0; for (let b = 0; b < 7; b++) r |= ((i >> b) & 1) << (6 - b); return r; };
const powmod = (b: number, e: number) => { let r = 1; b %= Q; while (e > 0) { if (e & 1) r = (r * b) % Q; b = (b * b) % Q; e >>= 1; } return r; };
const ZETAS = Int32Array.from({ length: 128 }, (_, i) => powmod(17, bitrev7(i)));          // ζ^BitRev7(i)
const GAMMAS = Int32Array.from({ length: 128 }, (_, i) => powmod(17, 2 * bitrev7(i) + 1)); // ζ^(2·BitRev7(i)+1)
const N_INV = powmod(128, Q - 2); // 128⁻¹ mod q = 3303

const md = (a: number) => { const r = a % Q; return r < 0 ? r + Q : r; };

// ------------------------------------------------------------------------------------------------ hash functions
const H = (s: Uint8Array) => createHash("sha3-256").update(s).digest();
const G = (s: Uint8Array) => { const o = createHash("sha3-512").update(s).digest(); return [o.subarray(0, 32), o.subarray(32)] as const; };
const J = (s: Uint8Array) => createHash("shake256", { outputLength: 32 }).update(s).digest();
const PRF = (eta: number, s: Uint8Array, b: number) => createHash("shake256", { outputLength: 64 * eta }).update(s).update(Uint8Array.of(b)).digest();
const cat = (...a: Uint8Array[]) => Buffer.concat(a);

// ------------------------------------------------------------------------------------------------ Algorithms 7–11
/** Algorithm 7 SampleNTT: rejection sampling from SHAKE128(ρ‖j‖i). The XOF is prefix-stable, so asking for a longer
 *  output when (rarely) 840 bytes do not yield 256 coefficients continues the same stream. */
function sampleNTT(seed: Uint8Array): Int32Array {
  const a = new Int32Array(N);
  for (let len = 840; ; len += 168 * 4) {
    const B = createHash("shake128", { outputLength: len }).update(seed).digest();
    let j = 0;
    for (let i = 0; i + 3 <= B.length && j < N; i += 3) {
      const d1 = B[i] + 256 * (B[i + 1] & 15), d2 = (B[i + 1] >> 4) + 16 * B[i + 2];
      if (d1 < Q) a[j++] = d1;
      if (d2 < Q && j < N) a[j++] = d2;
    }
    if (j === N) return a;
  }
}
/** Algorithm 8 SamplePolyCBD_η */
function cbd(B: Uint8Array, eta: number): Int32Array {
  const f = new Int32Array(N);
  const bit = (i: number) => (B[i >> 3] >> (i & 7)) & 1;
  for (let i = 0; i < N; i++) {
    let x = 0, y = 0;
    for (let j = 0; j < eta; j++) { x += bit(2 * i * eta + j); y += bit(2 * i * eta + eta + j); }
    f[i] = md(x - y);
  }
  return f;
}
/** Algorithm 9 NTT (in place) */
function ntt(f: Int32Array): Int32Array {
  let i = 1;
  for (let len = 128; len >= 2; len >>= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      const z = ZETAS[i++];
      for (let j = start; j < start + len; j++) { const t = (z * f[j + len]) % Q; f[j + len] = md(f[j] - t); f[j] = (f[j] + t) % Q; }
    }
  }
  return f;
}
/** Algorithm 10 NTT⁻¹ (in place) */
function invntt(f: Int32Array): Int32Array {
  let i = 127;
  for (let len = 2; len <= 128; len <<= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      const z = ZETAS[i--];
      for (let j = start; j < start + len; j++) { const t = f[j]; f[j] = (t + f[j + len]) % Q; f[j + len] = (z * md(f[j + len] - t)) % Q; }
    }
  }
  for (let j = 0; j < N; j++) f[j] = (f[j] * N_INV) % Q;
  return f;
}
/** Algorithms 11/12 MultiplyNTTs + BaseCaseMultiply, accumulated into acc */
function mulAcc(acc: Int32Array, f: Int32Array, g: Int32Array): void {
  for (let i = 0; i < 128; i++) {
    const a0 = f[2 * i], a1 = f[2 * i + 1], b0 = g[2 * i], b1 = g[2 * i + 1];
    acc[2 * i] = (acc[2 * i] + a0 * b0 + ((a1 * b1) % Q) * GAMMAS[i]) % Q;
    acc[2 * i + 1] = (acc[2 * i + 1] + a0 * b1 + a1 * b0) % Q;
  }
}
const add = (a: Int32Array, b: Int32Array) => { for (let i = 0; i < N; i++) a[i] = (a[i] + b[i]) % Q; return a; };

// --------------------------------------------------------------------------------------- Algorithms 5/6 + compress
function byteEncode(F: Int32Array, d: number, out: Uint8Array, off: number): void {
  let acc = 0, bits = 0, o = off;
  for (let i = 0; i < N; i++) {
    acc |= F[i] << bits; bits += d;
    while (bits >= 8) { out[o++] = acc & 255; acc >>>= 8; bits -= 8; }
  }
}
function byteDecode(B: Uint8Array, d: number): Int32Array {
  const F = new Int32Array(N), m = (1 << d) - 1;
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < N; i++) {
    while (bits < d) { acc |= B[o++] << bits; bits += 8; }
    F[i] = acc & m; acc >>>= d; bits -= d;
    if (d === 12) F[i] %= Q;
  }
  return F;
}
/** Compress_d(x) = ⌈(2^d / q)·x⌋ mod 2^d — exact integer rounding (half up) */
const compress = (F: Int32Array, d: number) => F.map((x) => Math.floor(((x * 2 ** (d + 1)) + Q) / (2 * Q)) & ((1 << d) - 1));
/** Decompress_d(y) = ⌈(q / 2^d)·y⌋ */
const decompress = (F: Int32Array, d: number) => F.map((y) => Math.floor((Q * y * 2 + 2 ** d) / 2 ** (d + 1)));

// ------------------------------------------------------------------------------------------- K-PKE (13, 14, 15)
function matrix(p: MlKemParams, rho: Uint8Array): Int32Array[][] {
  const A: Int32Array[][] = [];
  for (let i = 0; i < p.k; i++) { A.push([]); for (let j = 0; j < p.k; j++) A[i].push(sampleNTT(cat(rho, Uint8Array.of(j, i)))); }
  return A;
}
function pkeKeyGen(p: MlKemParams, d: Uint8Array): { ek: Buffer; dk: Buffer } {
  const [rho, sigma] = G(cat(d, Uint8Array.of(p.k)));
  const A = matrix(p, rho); let n = 0;
  const s = Array.from({ length: p.k }, () => ntt(cbd(PRF(p.eta1, sigma, n++), p.eta1)));
  const e = Array.from({ length: p.k }, () => ntt(cbd(PRF(p.eta1, sigma, n++), p.eta1)));
  const ek = Buffer.alloc(384 * p.k + 32), dk = Buffer.alloc(384 * p.k);
  for (let i = 0; i < p.k; i++) {
    const t = new Int32Array(N); for (let j = 0; j < p.k; j++) mulAcc(t, A[i][j], s[j]); add(t, e[i]);
    byteEncode(t, 12, ek, 384 * i); byteEncode(s[i], 12, dk, 384 * i);
  }
  Buffer.from(rho).copy(ek, 384 * p.k);
  return { ek, dk };
}
function pkeEncrypt(p: MlKemParams, ek: Uint8Array, m: Uint8Array, r: Uint8Array): Buffer {
  const t = Array.from({ length: p.k }, (_, i) => byteDecode(ek.subarray(384 * i, 384 * (i + 1)), 12));
  const A = matrix(p, ek.subarray(384 * p.k)); let n = 0;
  const y = Array.from({ length: p.k }, () => ntt(cbd(PRF(p.eta1, r, n++), p.eta1)));
  const e1 = Array.from({ length: p.k }, () => cbd(PRF(p.eta2, r, n++), p.eta2));
  const e2 = cbd(PRF(p.eta2, r, n), p.eta2);
  const c = Buffer.alloc(32 * (p.du * p.k + p.dv));
  for (let i = 0; i < p.k; i++) {
    const u = new Int32Array(N); for (let j = 0; j < p.k; j++) mulAcc(u, A[j][i], y[j]); // Âᵀ∘ŷ
    add(invntt(u), e1[i]);
    byteEncode(compress(u, p.du), p.du, c, 32 * p.du * i);
  }
  const v = new Int32Array(N); for (let j = 0; j < p.k; j++) mulAcc(v, t[j], y[j]);
  add(add(invntt(v), e2), decompress(byteDecode(m, 1), 1));
  byteEncode(compress(v, p.dv), p.dv, c, 32 * p.du * p.k);
  return c;
}
function pkeDecrypt(p: MlKemParams, dk: Uint8Array, c: Uint8Array): Buffer {
  const w = new Int32Array(N);
  for (let i = 0; i < p.k; i++) {
    const u = ntt(decompress(byteDecode(c.subarray(32 * p.du * i, 32 * p.du * (i + 1)), p.du), p.du));
    mulAcc(w, byteDecode(dk.subarray(384 * i, 384 * (i + 1)), 12), u);
  }
  invntt(w);
  const v = decompress(byteDecode(c.subarray(32 * p.du * p.k), p.dv), p.dv);
  for (let i = 0; i < N; i++) w[i] = md(v[i] - w[i]);
  const m = Buffer.alloc(32); byteEncode(compress(w, 1), 1, m, 0);
  return m;
}

// ----------------------------------------------------------------------------------- ML-KEM (16, 17, 18) + checks
export function keyGenInternal(p: MlKemParams, d: Uint8Array, z: Uint8Array): { ek: Buffer; dk: Buffer } {
  if (d.length !== 32 || z.length !== 32) throw new Error("ML-KEM: d and z must be 32 bytes");
  const { ek, dk: dkPke } = pkeKeyGen(p, d);
  return { ek, dk: cat(dkPke, ek, H(ek), z) };
}
export function keyGen(p: MlKemParams): { ek: Buffer; dk: Buffer } { return keyGenInternal(p, randomBytes(32), randomBytes(32)); }

/** §7.2 encapsulation key check: type (length) and modulus (every 12-bit coefficient < q) */
export function checkEncapsulationKey(p: MlKemParams, ek: Uint8Array): boolean {
  if (ek.length !== 384 * p.k + 32) return false;
  const re = Buffer.alloc(384);
  for (let i = 0; i < p.k; i++) {
    const seg = ek.subarray(384 * i, 384 * (i + 1));
    byteEncode(byteDecode(seg, 12), 12, re, 0);
    if (!re.equals(seg)) return false;
  }
  return true;
}
/** §7.3 decapsulation key check: length and the hash check H(ek) == h (the ciphertext length is checked in decaps) */
export function checkDecapsulationKey(p: MlKemParams, dk: Uint8Array): boolean {
  if (dk.length !== 768 * p.k + 96) return false;
  return H(dk.subarray(384 * p.k, 768 * p.k + 32)).equals(dk.subarray(768 * p.k + 32, 768 * p.k + 64));
}

export function encapsInternal(p: MlKemParams, ek: Uint8Array, m: Uint8Array): { ss: Buffer; ct: Buffer } {
  if (!checkEncapsulationKey(p, ek)) throw new Error("ML-KEM: encapsulation key fails the FIPS 203 §7.2 check");
  if (m.length !== 32) throw new Error("ML-KEM: m must be 32 bytes");
  const [K, r] = G(cat(m, H(ek)));
  return { ss: Buffer.from(K), ct: pkeEncrypt(p, ek, m, r) };
}
export function encaps(p: MlKemParams, ek: Uint8Array): { ss: Buffer; ct: Buffer } { return encapsInternal(p, ek, randomBytes(32)); }

/** Algorithm 18 with implicit rejection: a ciphertext that does not re-encrypt to itself yields J(z‖c), not an error */
export function decaps(p: MlKemParams, dk: Uint8Array, c: Uint8Array): Buffer {
  if (c.length !== 32 * (p.du * p.k + p.dv)) throw new Error("ML-KEM: ciphertext has the wrong length");
  if (!checkDecapsulationKey(p, dk)) throw new Error("ML-KEM: decapsulation key fails the FIPS 203 §7.3 check");
  const dkPke = dk.subarray(0, 384 * p.k), ekPke = dk.subarray(384 * p.k, 768 * p.k + 32);
  const h = dk.subarray(768 * p.k + 32, 768 * p.k + 64), z = dk.subarray(768 * p.k + 64);
  const m2 = pkeDecrypt(p, dkPke, c);
  const [K2, r2] = G(cat(m2, h));
  const Kbar = J(cat(z, c));
  const c2 = pkeEncrypt(p, ekPke, m2, r2);
  let diff = 0; for (let i = 0; i < c.length; i++) diff |= c[i] ^ c2[i];
  const keep = ((diff - 1) >> 8) & 255; // 255 when c == c', else 0 — no branch on the comparison
  const out = Buffer.alloc(32); for (let i = 0; i < 32; i++) out[i] = (K2[i] & keep) | (Kbar[i] & ~keep & 255);
  return out;
}
