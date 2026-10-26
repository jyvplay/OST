/**
 * TT79 — the legacy block/stream ciphers PKCS #12 files still use, written for Fusion from the specifications:
 *   DES / Triple-DES (FIPS 46-3, SP 800-67) — "pbeWithSHAAnd3-KeyTripleDES-CBC" protects private keys in most
 *     PFX files made by Windows and by OpenSSL before 3.0 (and by `openssl pkcs12 -legacy`);
 *   RC2 (RFC 2268) — "pbeWithSHAAnd40BitRC2-CBC" protects the certificate bag of those same files;
 *   RC4 (the alleged-RC4 keystream) — the rare "pbeWithSHAAnd128BitRC4" bags.
 * Decryption is what Fusion needs; encryption exists so tests can round-trip and check published vectors.
 * Checked against node:crypto (OpenSSL) for 3DES, against the RFC 2268 §5 vectors for RC2, and end-to-end against
 * PFX files written by OpenSSL 3.0 `-legacy` and by pyca/cryptography (scripts/tt79-pdf.mts).
 * These ciphers are broken; they are implemented only to READ existing files. Fusion never writes them.
 */
type Bytes = Uint8Array;

/* ---------------------------------------------------------------- DES (FIPS 46-3) */
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = (() => { const f = new Array<number>(64); IP.forEach((src, i) => { f[src - 1] = i + 1; }); return f; })();
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
/** the eight S-boxes, row-major (row = outer bits, column = inner four bits) */
export const DES_S = [
  "14 4 13 1 2 15 11 8 3 10 6 12 5 9 0 7 0 15 7 4 14 2 13 1 10 6 12 11 9 5 3 8 4 1 14 8 13 6 2 11 15 12 9 7 3 10 5 0 15 12 8 2 4 9 1 7 5 11 3 14 10 0 6 13",
  "15 1 8 14 6 11 3 4 9 7 2 13 12 0 5 10 3 13 4 7 15 2 8 14 12 0 1 10 6 9 11 5 0 14 7 11 10 4 13 1 5 8 12 6 9 3 2 15 13 8 10 1 3 15 4 2 11 6 7 12 0 5 14 9",
  "10 0 9 14 6 3 15 5 1 13 12 7 11 4 2 8 13 7 0 9 3 4 6 10 2 8 5 14 12 11 15 1 13 6 4 9 8 15 3 0 11 1 2 12 5 10 14 7 1 10 13 0 6 9 8 7 4 15 14 3 11 5 2 12",
  "7 13 14 3 0 6 9 10 1 2 8 5 11 12 4 15 13 8 11 5 6 15 0 3 4 7 2 12 1 10 14 9 10 6 9 0 12 11 7 13 15 1 3 14 5 2 8 4 3 15 0 6 10 1 13 8 9 4 5 11 12 7 2 14",
  "2 12 4 1 7 10 11 6 8 5 3 15 13 0 14 9 14 11 2 12 4 7 13 1 5 0 15 10 3 9 8 6 4 2 1 11 10 13 7 8 15 9 12 5 6 3 0 14 11 8 12 7 1 14 2 13 6 15 0 9 10 4 5 3",
  "12 1 10 15 9 2 6 8 0 13 3 4 14 7 5 11 10 15 4 2 7 12 9 5 6 1 13 14 0 11 3 8 9 14 15 5 2 8 12 3 7 0 4 10 1 13 11 6 4 3 2 12 9 5 15 10 11 14 1 7 6 0 8 13",
  "4 11 2 14 15 0 8 13 3 12 9 7 5 10 6 1 13 0 11 7 4 9 1 10 14 3 5 12 2 15 8 6 1 4 11 13 12 3 7 14 10 15 6 8 0 5 9 2 6 11 13 8 1 4 10 7 9 5 0 15 14 2 3 12",
  "13 2 8 4 6 15 11 1 10 9 3 14 5 0 12 7 1 15 13 8 10 3 7 4 12 5 6 11 0 14 9 2 7 11 4 1 9 12 14 2 0 6 10 13 15 3 5 8 2 1 14 7 4 10 8 13 15 12 9 0 3 5 6 11",
].map((s) => s.split(" ").map(Number));

const bitsOf = (b: Bytes, o: number, n: number) => { const r = new Uint8Array(n * 8); for (let i = 0; i < n * 8; i++) r[i] = (b[o + (i >> 3)] >> (7 - (i & 7))) & 1; return r; };
const perm = (src: Uint8Array, table: number[]) => { const r = new Uint8Array(table.length); for (let i = 0; i < table.length; i++) r[i] = src[table[i] - 1]; return r; };

/** the 16 round subkeys (48 bits each) of one DES key */
function desSchedule(key: Bytes, o: number): Uint8Array[] {
  const k = perm(bitsOf(key, o, 8), PC1); let c = k.slice(0, 28), d = k.slice(28); const out: Uint8Array[] = [];
  for (const s of SHIFTS) {
    const rot = (x: Uint8Array) => { const y = new Uint8Array(28); for (let i = 0; i < 28; i++) y[i] = x[(i + s) % 28]; return y; };
    c = rot(c); d = rot(d); const cd = new Uint8Array(56); cd.set(c); cd.set(d, 28); out.push(perm(cd, PC2));
  }
  return out;
}
function desBlock(sched: Uint8Array[], inp: Bytes, io: number, out: Bytes, oo: number, decrypt: boolean) {
  const x = perm(bitsOf(inp, io, 8), IP); let l = x.slice(0, 32), r = x.slice(32);
  for (let round = 0; round < 16; round++) {
    const k = sched[decrypt ? 15 - round : round]; const er = perm(r, E); const f = new Uint8Array(32);
    for (let s = 0; s < 8; s++) {
      const b = er.subarray(s * 6, s * 6 + 6).map((v, i) => v ^ k[s * 6 + i]);
      const row = (b[0] << 1) | b[5], col = (b[1] << 3) | (b[2] << 2) | (b[3] << 1) | b[4]; const v = DES_S[s][row * 16 + col];
      for (let i = 0; i < 4; i++) f[s * 4 + i] = (v >> (3 - i)) & 1;
    }
    const pf = perm(f, P); const nr = new Uint8Array(32); for (let i = 0; i < 32; i++) nr[i] = l[i] ^ pf[i];
    l = r; r = nr;
  }
  const rl = new Uint8Array(64); rl.set(r); rl.set(l, 32); const y = perm(rl, FP);
  for (let i = 0; i < 8; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | y[i * 8 + j]; out[oo + i] = v; }
}
/** Triple-DES EDE (keying option 1: 24-byte key; option 2: 16-byte key, K3 = K1) in CBC mode, no padding handling */
export function des3Cbc(key: Bytes, iv: Bytes, data: Bytes, decrypt: boolean): Bytes {
  if (key.length !== 24 && key.length !== 16 && key.length !== 8) throw new Error("3DES: key must be 8, 16 or 24 bytes");
  if (data.length % 8) throw new Error("3DES-CBC: data is not a whole number of blocks");
  const k1 = desSchedule(key, 0), k2 = key.length >= 16 ? desSchedule(key, 8) : k1, k3 = key.length === 24 ? desSchedule(key, 16) : k1;
  const out = new Uint8Array(data.length); let prev = iv.slice(0, 8); const t = new Uint8Array(8), u = new Uint8Array(8);
  for (let o = 0; o < data.length; o += 8) {
    if (decrypt) {
      desBlock(k3, data, o, t, 0, true); desBlock(k2, t, 0, u, 0, false); desBlock(k1, u, 0, t, 0, true);
      for (let i = 0; i < 8; i++) out[o + i] = t[i] ^ prev[i]; prev = data.slice(o, o + 8);
    } else {
      for (let i = 0; i < 8; i++) u[i] = data[o + i] ^ prev[i];
      desBlock(k1, u, 0, t, 0, false); desBlock(k2, t, 0, u, 0, true); desBlock(k3, u, 0, out, o, false); prev = out.slice(o, o + 8);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- RC2 (RFC 2268) */
/** PITABLE, RFC 2268 §2 (a permutation of 0..255 derived from the digits of pi) */
const PI_HEX = "d978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb6266fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052eef784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731" +
  "2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad";
export const RC2_PI = Uint8Array.from(PI_HEX.match(/../g)!.map((h) => parseInt(h, 16)));
function rc2Keys(key: Bytes, effectiveBits: number): Uint16Array {
  const T = key.length; if (T < 1 || T > 128) throw new Error("RC2: key must be 1–128 bytes");
  const T1 = effectiveBits, T8 = Math.ceil(T1 / 8), TM = 0xff >> (8 * T8 - T1);
  const L = new Uint8Array(128); L.set(key);
  for (let i = T; i < 128; i++) L[i] = RC2_PI[(L[i - 1] + L[i - T]) & 255];
  L[128 - T8] = RC2_PI[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i--) L[i] = RC2_PI[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64); for (let i = 0; i < 64; i++) K[i] = L[2 * i] | (L[2 * i + 1] << 8); return K;
}
const S = [1, 2, 3, 5];
function rc2Block(K: Uint16Array, inp: Bytes, io: number, out: Bytes, oo: number, decrypt: boolean) {
  const R = [0, 1, 2, 3].map((i) => inp[io + 2 * i] | (inp[io + 2 * i + 1] << 8));
  if (!decrypt) {
    let j = 0;
    const mix = () => { for (let i = 0; i < 4; i++) { R[i] = (R[i] + K[j++] + (R[(i + 3) & 3] & R[(i + 2) & 3]) + (~R[(i + 3) & 3] & 0xffff & R[(i + 1) & 3])) & 0xffff; R[i] = ((R[i] << S[i]) | (R[i] >> (16 - S[i]))) & 0xffff; } };
    const mash = () => { for (let i = 0; i < 4; i++) R[i] = (R[i] + K[R[(i + 3) & 3] & 63]) & 0xffff; };
    for (let n = 0; n < 5; n++) mix(); mash(); for (let n = 0; n < 6; n++) mix(); mash(); for (let n = 0; n < 5; n++) mix();
  } else {
    let j = 63;
    const rmix = () => { for (let i = 3; i >= 0; i--) { R[i] = ((R[i] >> S[i]) | (R[i] << (16 - S[i]))) & 0xffff; R[i] = (R[i] - K[j--] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & 0xffff & R[(i + 1) & 3])) & 0xffff; } };
    const rmash = () => { for (let i = 3; i >= 0; i--) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff; };
    for (let n = 0; n < 5; n++) rmix(); rmash(); for (let n = 0; n < 6; n++) rmix(); rmash(); for (let n = 0; n < 5; n++) rmix();
  }
  for (let i = 0; i < 4; i++) { out[oo + 2 * i] = R[i] & 255; out[oo + 2 * i + 1] = R[i] >> 8; }
}
/** RC2 single block (tests use this for the RFC 2268 §5 vectors) */
export function rc2Ecb(key: Bytes, effectiveBits: number, block: Bytes, decrypt = false): Bytes { const out = new Uint8Array(8); rc2Block(rc2Keys(key, effectiveBits), block, 0, out, 0, decrypt); return out; }
export function rc2Cbc(key: Bytes, effectiveBits: number, iv: Bytes, data: Bytes, decrypt: boolean): Bytes {
  if (data.length % 8) throw new Error("RC2-CBC: data is not a whole number of blocks");
  const K = rc2Keys(key, effectiveBits); const out = new Uint8Array(data.length); let prev = iv.slice(0, 8); const t = new Uint8Array(8);
  for (let o = 0; o < data.length; o += 8) {
    if (decrypt) { rc2Block(K, data, o, t, 0, true); for (let i = 0; i < 8; i++) out[o + i] = t[i] ^ prev[i]; prev = data.slice(o, o + 8); }
    else { for (let i = 0; i < 8; i++) t[i] = data[o + i] ^ prev[i]; rc2Block(K, t, 0, out, o, false); prev = out.slice(o, o + 8); }
  }
  return out;
}

/* ---------------------------------------------------------------- RC4 */
export function rc4(key: Bytes, data: Bytes): Bytes {
  const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) { i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; out[n] = data[n] ^ s[(s[i] + s[j]) & 255]; }
  return out;
}

/** strip and check PKCS #7 padding; a wrong password almost always fails here */
export function unpad(b: Bytes, block: number): Bytes {
  const n = b[b.length - 1]; if (!b.length || n < 1 || n > block || n > b.length) throw new Error("bad padding");
  for (let i = b.length - n; i < b.length; i++) if (b[i] !== n) throw new Error("bad padding");
  return b.subarray(0, b.length - n);
}
