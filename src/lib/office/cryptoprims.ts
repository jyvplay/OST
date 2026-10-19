/**
 * TT47 — synchronous crypto primitives for MS-OFFCRYPTO password decryption (client + server safe).
 * Written from the specifications: FIPS 180-4 (SHA-1, SHA-256, SHA-384, SHA-512), RFC 2104 (HMAC),
 * FIPS-197 (AES-128/192/256). Synchronous because the Office key derivation spins the hash 100,000
 * times — WebCrypto's async digest takes ~7 s for that, these take a fraction of a second.
 * Verified against node:crypto (OpenSSL) in scripts/tt47-crypto.mts.
 */
type Bytes = Uint8Array;

/* ---------------------------------------------------------------- SHA-1 / SHA-256 (32-bit words) */
function pad64(msg: Bytes, lenBytes: 8 | 16): Bytes {
  const block = lenBytes === 8 ? 64 : 128;
  const total = Math.ceil((msg.length + 1 + lenBytes) / block) * block;
  const out = new Uint8Array(total); out.set(msg); out[msg.length] = 0x80;
  const bits = msg.length * 8; const dv = new DataView(out.buffer);
  dv.setUint32(total - 4, bits >>> 0); dv.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  return out;
}
export function sha1(msg: Bytes): Bytes {
  const m = pad64(msg, 8); const dv = new DataView(m.buffer); const w = new Uint32Array(80);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let o = 0; o < m.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20); const od = new DataView(out.buffer); [h0, h1, h2, h3, h4].forEach((h, i) => od.setUint32(i * 4, h)); return out;
}
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(msg: Bytes): Bytes {
  const m = pad64(msg, 8); const dv = new DataView(m.buffer); const w = new Uint32Array(64);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const r = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < m.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32); const od = new DataView(out.buffer); H.forEach((h, i) => od.setUint32(i * 4, h)); return out;
}

/* ---------------------------------------------------------------- SHA-512 / SHA-384 (hi/lo 32-bit pairs) */
const K512 = (() => {
  const hex = "428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019 923f82a4af194f9b ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2 72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235 c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3 0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725 06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed 53380d139d95b3df 650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b a2bfe8a14cf10364 a81a664bbc423001 c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8 19a4c116b8d2d0c8 1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb 5b9cca4f7763e373 682e6ff3d6b2b8a3 748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec 90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ca273eceea26619c d186b8c721c0c207 eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 113f9804bef90dae 1b710b35131c471b 28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a 5fcb6fab3ad6faec 6c44198c4a475817";
  const k = new Int32Array(160); hex.split(" ").forEach((h, i) => { k[2 * i] = parseInt(h.slice(0, 8), 16) | 0; k[2 * i + 1] = parseInt(h.slice(8), 16) | 0; }); return k;
})();
const IV512 = "6a09e667f3bcc908 bb67ae8584caa73b 3c6ef372fe94f82b a54ff53a5f1d36f1 510e527fade682d1 9b05688c2b3e6c1f 1f83d9abfb41bd6b 5be0cd19137e2179";
const IV384 = "cbbb9d5dc1059ed8 629a292a367cd507 9159015a3070dd17 152fecd8f70e5939 67332667ffc00b31 8eb44a8768581511 db0c2e0d64f98fa7 47b5481dbefa4fa4";
function sha512core(msg: Bytes, iv: string, outLen: number): Bytes {
  const m = pad64(msg, 16); const dv = new DataView(m.buffer);
  const H = new Int32Array(16); iv.split(" ").forEach((h, i) => { H[2 * i] = parseInt(h.slice(0, 8), 16) | 0; H[2 * i + 1] = parseInt(h.slice(8), 16) | 0; });
  const W = new Int32Array(160); const K = K512;
  for (let o = 0; o < m.length; o += 128) {
    for (let i = 0; i < 32; i++) W[i] = dv.getInt32(o + i * 4);
    for (let i = 32; i < 160; i += 2) {
      // σ0(w[t-15]) = rotr1 ^ rotr8 ^ shr7 ; σ1(w[t-2]) = rotr19 ^ rotr61 ^ shr6
      let xh = W[i - 30], xl = W[i - 29];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = W[i - 4]; xl = W[i - 3];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      const lo = (s0l >>> 0) + (s1l >>> 0) + (W[i - 13] >>> 0) + (W[i - 31] >>> 0); // w[t-7] lo, w[t-16] lo
      W[i] = (s0h + s1h + W[i - 14] + W[i - 32] + ((lo / 0x100000000) | 0)) | 0; W[i + 1] = lo | 0;
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7], eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let i = 0; i < 160; i += 2) {
      // Σ1(e) = rotr14 ^ rotr18 ^ rotr41
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      let lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i + 1] >>> 0) + (W[i + 1] >>> 0);
      const t1h = (hh + S1h + chh + K[i] + W[i] + ((lo / 0x100000000) | 0)) | 0, t1l = lo | 0;
      // Σ0(a) = rotr28 ^ rotr34 ^ rotr39
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      lo = (S0l >>> 0) + (mjl >>> 0);
      const t2h = (S0h + mjh + ((lo / 0x100000000) | 0)) | 0, t2l = lo | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      lo = (dl >>> 0) + (t1l >>> 0); eh = (dh + t1h + ((lo / 0x100000000) | 0)) | 0; el = lo | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      lo = (t1l >>> 0) + (t2l >>> 0); ah = (t1h + t2h + ((lo / 0x100000000) | 0)) | 0; al = lo | 0;
    }
    const v = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let k = 0; k < 16; k += 2) { const lo = (H[k + 1] >>> 0) + (v[k + 1] >>> 0); H[k] = (H[k] + v[k] + ((lo / 0x100000000) | 0)) | 0; H[k + 1] = lo | 0; }
  }
  const out = new Uint8Array(64); const od = new DataView(out.buffer); H.forEach((h, i) => od.setInt32(i * 4, h)); return out.slice(0, outLen);
}
export const sha512 = (m: Bytes) => sha512core(m, IV512, 64);
export const sha384 = (m: Bytes) => sha512core(m, IV384, 48);

export type HashName = "SHA1" | "SHA256" | "SHA384" | "SHA512";
export const HASHES: Record<HashName, { fn: (m: Bytes) => Bytes; size: number; block: number }> = {
  SHA1: { fn: sha1, size: 20, block: 64 }, SHA256: { fn: sha256, size: 32, block: 64 }, SHA384: { fn: sha384, size: 48, block: 128 }, SHA512: { fn: sha512, size: 64, block: 128 },
};
export function hmac(name: HashName, key: Bytes, data: Bytes): Bytes {
  const { fn, block } = HASHES[name];
  let k = key.length > block ? fn(key) : key; const kk = new Uint8Array(block); kk.set(k); k = kk;
  const ipad = new Uint8Array(block + data.length), opad = new Uint8Array(block + HASHES[name].size);
  for (let i = 0; i < block; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
  ipad.set(data, block); opad.set(fn(ipad), block); return fn(opad);
}
export const concat = (...parts: Bytes[]): Bytes => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/* ---------------------------------------------------------------- AES (FIPS-197) */
const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
(() => {
  // generate the S-box from GF(2^8) inverses + the affine transform (FIPS-197 §5.1.1)
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0); // p *= 3
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09; // q /= 3
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63; for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();
const xt = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
export function aesExpandKey(key: Bytes): Uint8Array[] {
  if (![16, 24, 32].includes(key.length)) throw new Error(`AES key must be 16/24/32 bytes, got ${key.length}`);
  const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1)); w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice(4 * (i - 1), 4 * i);
    if (i % nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = xt(rcon); }
    else if (nk > 6 && i % nk === 4) t = t.map((b) => SBOX[b]);
    for (let j = 0; j < 4; j++) w[4 * i + j] = w[4 * (i - nk) + j] ^ t[j];
  }
  return Array.from({ length: nr + 1 }, (_, r) => w.slice(16 * r, 16 * r + 16));
}
export function aesEncryptBlock(rk: Uint8Array[], inp: Bytes, out: Bytes, o = 0) {
  const s = inp.slice(o, o + 16); const nr = rk.length - 1;
  for (let i = 0; i < 16; i++) s[i] ^= rk[0][i];
  for (let r = 1; r <= nr; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    const t = s.slice(); for (let c = 0; c < 4; c++) for (let rr = 1; rr < 4; rr++) s[4 * c + rr] = t[4 * ((c + rr) % 4) + rr]; // ShiftRows
    if (r < nr) for (let c = 0; c < 4; c++) { const [a, b, cc, d] = [s[4 * c], s[4 * c + 1], s[4 * c + 2], s[4 * c + 3]]; s[4 * c] = xt(a) ^ xt(b) ^ b ^ cc ^ d; s[4 * c + 1] = a ^ xt(b) ^ xt(cc) ^ cc ^ d; s[4 * c + 2] = a ^ b ^ xt(cc) ^ xt(d) ^ d; s[4 * c + 3] = xt(a) ^ a ^ b ^ cc ^ xt(d); }
    for (let i = 0; i < 16; i++) s[i] ^= rk[r][i];
  }
  out.set(s, o);
}
const M9 = new Uint8Array(256), M11 = new Uint8Array(256), M13 = new Uint8Array(256), M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) { M9[i] = mul(i, 9); M11[i] = mul(i, 11); M13[i] = mul(i, 13); M14[i] = mul(i, 14); }
export function aesDecryptBlock(rk: Uint8Array[], inp: Bytes, out: Bytes, o = 0) {
  const s = inp.slice(o, o + 16); const nr = rk.length - 1;
  for (let i = 0; i < 16; i++) s[i] ^= rk[nr][i];
  for (let r = nr - 1; r >= 0; r--) {
    const t = s.slice(); for (let c = 0; c < 4; c++) for (let rr = 1; rr < 4; rr++) s[4 * ((c + rr) % 4) + rr] = t[4 * c + rr]; // InvShiftRows
    for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
    for (let i = 0; i < 16; i++) s[i] ^= rk[r][i];
    if (r > 0) for (let c = 0; c < 4; c++) { const [a, b, cc, d] = [s[4 * c], s[4 * c + 1], s[4 * c + 2], s[4 * c + 3]]; s[4 * c] = M14[a] ^ M11[b] ^ M13[cc] ^ M9[d]; s[4 * c + 1] = M9[a] ^ M14[b] ^ M11[cc] ^ M13[d]; s[4 * c + 2] = M13[a] ^ M9[b] ^ M14[cc] ^ M11[d]; s[4 * c + 3] = M11[a] ^ M13[b] ^ M9[cc] ^ M14[d]; }
  }
  out.set(s, o);
}
/** AES-CBC decrypt without padding removal (MS-OFFCRYPTO pads to the block size itself). */
export function aesCbcDecrypt(key: Bytes, iv: Bytes, data: Bytes): Bytes {
  if (data.length % 16) throw new Error("AES-CBC data is not a whole number of blocks");
  const rk = aesExpandKey(key), out = new Uint8Array(data.length); let prev = iv.slice(0, 16);
  for (let o = 0; o < data.length; o += 16) { aesDecryptBlock(rk, data, out, o); for (let i = 0; i < 16; i++) out[o + i] ^= prev[i]; prev = data.slice(o, o + 16); }
  return out;
}
export function aesCbcEncrypt(key: Bytes, iv: Bytes, data: Bytes): Bytes {
  if (data.length % 16) throw new Error("AES-CBC data is not a whole number of blocks");
  const rk = aesExpandKey(key), out = new Uint8Array(data.length); let prev = iv.slice(0, 16);
  const blk = new Uint8Array(16);
  for (let o = 0; o < data.length; o += 16) { const b = data.slice(o, o + 16); for (let i = 0; i < 16; i++) b[i] ^= prev[i]; aesEncryptBlock(rk, b, blk, 0); out.set(blk, o); prev = blk.slice(); }
  return out;
}
export function aesEcbDecrypt(key: Bytes, data: Bytes): Bytes {
  if (data.length % 16) throw new Error("AES-ECB data is not a whole number of blocks");
  const rk = aesExpandKey(key), out = new Uint8Array(data.length);
  for (let o = 0; o < data.length; o += 16) aesDecryptBlock(rk, data, out, o);
  return out;
}
