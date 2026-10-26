/**
 * TT79 — PKCS #12 (RFC 7292) reader for signing identities (.p12 / .pfx). Original code for Fusion.
 *
 * PFX ::= SEQUENCE { version 3, authSafe ContentInfo, macData MacData OPTIONAL }
 *   authSafe (id-data) holds an AuthenticatedSafe = SEQUENCE OF ContentInfo, each either id-data (plain SafeContents)
 *   or id-encryptedData (SafeContents encrypted with a password-based scheme). SafeContents = SEQUENCE OF SafeBag:
 *   keyBag (PKCS #8 PrivateKeyInfo), pkcs8ShroudedKeyBag (EncryptedPrivateKeyInfo), certBag (X.509), safeContentsBag.
 * Integrity: HMAC over the authSafe content with a key from the PKCS #12 KDF (RFC 7292 Appendix B, ID 3), any of
 *   SHA-1/256/384/512. The MAC is checked BEFORE anything is decrypted; a mismatch means a wrong password or a damaged
 *   file. Files without a MAC are accepted and say so (`macAlg: null`).
 * Privacy: password-based schemes —
 *   PBES2 (RFC 8018): PBKDF2 (HMAC-SHA1/224/256/384/512) + AES-128/192/256-CBC, DES-EDE3-CBC or RC2-CBC
 *     (OpenSSL 3 and pyca/cryptography default: PBKDF2-HMAC-SHA256 + AES-256-CBC, MAC SHA-256);
 *   PKCS #12 PBE (RFC 7292 Appendix C): SHA-1 KDF + 3-key / 2-key 3DES, RC2-128 / RC2-40, RC4-128 / RC4-40
 *     (Windows and OpenSSL `-legacy`: 3DES keys, RC2-40 certificates, MAC SHA-1).
 * Passwords: BMPString (UTF-16BE + 00 00) for the PKCS #12 KDF, UTF-8 bytes for PBKDF2 — as OpenSSL does.
 * Not supported (refused with a message): public-key integrity/privacy modes (signedData / envelopedData authSafe),
 *   PBMAC1 (RFC 9579), PBES1 DES/MD5 schemes.
 * Limits: input ≤ 1 MiB, ≤ 256 bags, nesting ≤ 4, iteration counts ≤ 10 000 000.
 * Verified against PFX files written by OpenSSL 3.0 (default and -legacy) and pyca/cryptography (scripts/tt79-pdf.mts).
 */
import { der, kids, oid, parseCert, type Der, type Identity } from "./pdfsig";
import { HASHES, hmac, aesCbcDecrypt, type HashName } from "../office/cryptoprims";
import { des3Cbc, rc2Cbc, rc4, unpad } from "./legacyciphers";

type Bytes = Uint8Array;
export interface P12Bag { der: Bytes; localKeyId: Bytes | null; friendlyName: string | null }
export interface P12Contents { keys: P12Bag[]; certs: P12Bag[]; macAlg: string | null; schemes: string[] }
export class P12PasswordError extends Error {}

const OID = {
  data: "1.2.840.113549.1.7.1", encryptedData: "1.2.840.113549.1.7.6", signedData: "1.2.840.113549.1.7.2", envelopedData: "1.2.840.113549.1.7.3",
  keyBag: "1.2.840.113549.1.12.10.1.1", shroudedKeyBag: "1.2.840.113549.1.12.10.1.2", certBag: "1.2.840.113549.1.12.10.1.3", safeContentsBag: "1.2.840.113549.1.12.10.1.6",
  x509Cert: "1.2.840.113549.1.9.22.1", friendlyName: "1.2.840.113549.1.9.20", localKeyId: "1.2.840.113549.1.9.21",
  pbes2: "1.2.840.113549.1.5.13", pbkdf2: "1.2.840.113549.1.5.12", pbmac1: "1.2.840.113549.1.5.14",
  aes128: "2.16.840.1.101.3.4.1.2", aes192: "2.16.840.1.101.3.4.1.22", aes256: "2.16.840.1.101.3.4.1.42", desEde3: "1.2.840.113549.3.7", rc2cbc: "1.2.840.113549.3.2",
};
const PRF: Record<string, HashName> = { "1.2.840.113549.2.7": "SHA1", "1.2.840.113549.2.9": "SHA256", "1.2.840.113549.2.10": "SHA384", "1.2.840.113549.2.11": "SHA512" };
const DIGEST: Record<string, HashName> = { "1.3.14.3.2.26": "SHA1", "2.16.840.1.101.3.4.2.1": "SHA256", "2.16.840.1.101.3.4.2.2": "SHA384", "2.16.840.1.101.3.4.2.3": "SHA512" };
/** PKCS #12 PBE: key bytes, IV bytes, cipher */
const P12PBE: Record<string, { name: string; key: number; iv: number; cipher: "3des" | "rc2" | "rc4"; bits?: number }> = {
  "1.2.840.113549.1.12.1.1": { name: "pbeWithSHAAnd128BitRC4", key: 16, iv: 0, cipher: "rc4" },
  "1.2.840.113549.1.12.1.2": { name: "pbeWithSHAAnd40BitRC4", key: 5, iv: 0, cipher: "rc4" },
  "1.2.840.113549.1.12.1.3": { name: "pbeWithSHAAnd3-KeyTripleDES-CBC", key: 24, iv: 8, cipher: "3des" },
  "1.2.840.113549.1.12.1.4": { name: "pbeWithSHAAnd2-KeyTripleDES-CBC", key: 16, iv: 8, cipher: "3des" },
  "1.2.840.113549.1.12.1.5": { name: "pbeWithSHAAnd128BitRC2-CBC", key: 16, iv: 8, cipher: "rc2", bits: 128 },
  "1.2.840.113549.1.12.1.6": { name: "pbeWithSHAAnd40BitRC2-CBC", key: 5, iv: 8, cipher: "rc2", bits: 40 },
};
const MAX_ITER = 10_000_000;

const body = (n: Der): Bytes => {
  if (n.cons && (n.tag === 0x24 || n.tag === 0x04 || n.tag === 0xa0 || n.tag === 0x80)) {
    // constructed OCTET STRING (BER chunking, common in Windows PFX files) — and its IMPLICIT [0] form
    const parts = kids(n).map(body); const o = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let k = 0; for (const x of parts) { o.set(x, k); k += x.length; } return o;
  }
  return n.d.subarray(n.start + n.hlen, n.cend);
};
const whole = (n: Der) => n.d.subarray(n.start, n.end);
const intOf = (n: Der) => { const b = body(n); if (b.length > 6) throw new Error("PKCS#12: integer too large"); let v = 0; for (const x of b) v = v * 256 + x; return v; };
const iterOf = (n: Der | undefined) => { const v = n ? intOf(n) : 1; if (v < 1 || v > MAX_ITER) throw new Error(`PKCS#12: iteration count ${v} out of range`); return v; };
const eq = (a: Bytes, b: Bytes) => a.length === b.length && a.every((v, i) => v === b[i]);

/** the password as a BMPString with its two-byte terminator (RFC 7292 B.1); the empty password is just 00 00 */
export function bmpPassword(pw: string): Bytes { const out: number[] = []; for (const ch of pw) { let c = ch.codePointAt(0)!; if (c > 0xffff) { c -= 0x10000; out.push(0xd8 | (c >> 18), (c >> 10) & 255, 0xdc | ((c >> 8) & 3), c & 255); } else out.push(c >> 8, c & 255); } out.push(0, 0); return Uint8Array.from(out); }

/** RFC 7292 Appendix B.2 key derivation. `id` 1 = key, 2 = IV, 3 = MAC key */
export function p12kdf(hash: HashName, pw: Bytes, salt: Bytes, id: number, iter: number, n: number): Bytes {
  const { fn, size: u, block: v } = HASHES[hash];
  const D = new Uint8Array(v).fill(id);
  const fill = (x: Bytes) => { if (!x.length) return new Uint8Array(0); const len = v * Math.ceil(x.length / v); const o = new Uint8Array(len); for (let i = 0; i < len; i++) o[i] = x[i % x.length]; return o; };
  const I = (() => { const s = fill(salt), p = fill(pw); const o = new Uint8Array(s.length + p.length); o.set(s); o.set(p, s.length); return o; })();
  const out = new Uint8Array(n); const c = Math.ceil(n / u); const DI = new Uint8Array(v + I.length);
  for (let i = 0; i < c; i++) {
    DI.set(D); DI.set(I, v); let A = fn(DI); for (let r = 1; r < iter; r++) A = fn(A);
    out.set(A.subarray(0, Math.min(u, n - i * u)), i * u);
    if (i === c - 1) break;
    const B = new Uint8Array(v); for (let k = 0; k < v; k++) B[k] = A[k % u];
    for (let j = 0; j < I.length; j += v) { let carry = 1; for (let k = v - 1; k >= 0; k--) { const s = I[j + k] + B[k] + carry; I[j + k] = s & 255; carry = s >> 8; } }
  }
  return out;
}

/** PBKDF2 (RFC 8018 §5.2): WebCrypto when present (fast), the synchronous HMAC loop otherwise */
async function pbkdf2(hash: HashName, pw: Bytes, salt: Bytes, iter: number, len: number): Promise<Bytes> {
  const s = globalThis.crypto?.subtle;
  if (s) {
    const name = ({ SHA1: "SHA-1", SHA256: "SHA-256", SHA384: "SHA-384", SHA512: "SHA-512" } as const)[hash];
    const k = await s.importKey("raw", pw.slice().buffer as ArrayBuffer, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await s.deriveBits({ name: "PBKDF2", hash: name, salt: salt.slice().buffer as ArrayBuffer, iterations: iter }, k, len * 8));
  }
  const { size } = HASHES[hash]; const out = new Uint8Array(len);
  for (let blk = 1, o = 0; o < len; blk++, o += size) {
    const sb = new Uint8Array(salt.length + 4); sb.set(salt); sb[salt.length] = blk >>> 24; sb[salt.length + 1] = (blk >> 16) & 255; sb[salt.length + 2] = (blk >> 8) & 255; sb[salt.length + 3] = blk & 255;
    let u = hmac(hash, pw, sb); const t = u.slice(); for (let r = 1; r < iter; r++) { u = hmac(hash, pw, u); for (let i = 0; i < size; i++) t[i] ^= u[i]; }
    out.set(t.subarray(0, Math.min(size, len - o)), o);
  }
  return out;
}

/** decrypt with a password-based AlgorithmIdentifier; returns the plaintext and the scheme's name */
async function pbeDecrypt(alg: Der, password: string, data: Bytes): Promise<{ plain: Bytes; scheme: string }> {
  const [o, params] = kids(alg); const id = oid(o);
  const p12 = P12PBE[id];
  if (p12) {
    const [salt, it] = kids(params); const iter = iterOf(it); const pw = bmpPassword(password); const s = body(salt);
    const key = p12kdf("SHA1", pw, s, 1, iter, p12.key), iv = p12.iv ? p12kdf("SHA1", pw, s, 2, iter, p12.iv) : new Uint8Array(0);
    let plain: Bytes;
    try {
      if (p12.cipher === "rc4") plain = rc4(key, data);
      else plain = unpad(p12.cipher === "3des" ? des3Cbc(key, iv, data, true) : rc2Cbc(key, p12.bits!, iv, data, true), 8);
    } catch { throw new P12PasswordError("wrong password (decryption failed)"); }
    return { plain, scheme: p12.name };
  }
  if (id === OID.pbes2) {
    const [kdf, enc] = kids(params); const [ko, kp] = kids(kdf); if (oid(ko) !== OID.pbkdf2) throw new Error(`PKCS#12: key derivation ${oid(ko)} unsupported`);
    const kps = kids(kp); const salt = body(kps[0]); const iter = iterOf(kps[1]); let k = 2; let keyLen = 0;
    if (kps[k] && kps[k].tag === 0x02) keyLen = intOf(kps[k++]);
    let prf: HashName = "SHA1"; if (kps[k]) { const po = oid(kids(kps[k])[0]); prf = PRF[po]; if (!prf) throw new Error(`PKCS#12: PBKDF2 PRF ${po} unsupported`); }
    const [eo, ep] = kids(enc); const e = oid(eo); const pw = new TextEncoder().encode(password);
    const aes = ({ [OID.aes128]: 16, [OID.aes192]: 24, [OID.aes256]: 32 } as Record<string, number>)[e];
    let plain: Bytes; let scheme: string;
    try {
      if (aes) {
        const key = await pbkdf2(prf, pw, salt, iter, keyLen || aes); plain = unpad(aesCbcDecrypt(key, body(ep), data), 16); scheme = `PBES2 PBKDF2-HMAC-${prf} AES-${aes * 8}-CBC`;
      } else if (e === OID.desEde3) {
        const key = await pbkdf2(prf, pw, salt, iter, keyLen || 24); plain = unpad(des3Cbc(key, body(ep), data, true), 8); scheme = `PBES2 PBKDF2-HMAC-${prf} DES-EDE3-CBC`;
      } else if (e === OID.rc2cbc) {
        const rp = kids(ep); let bits = 32, iv: Bytes;
        if (rp.length === 2) { const v = intOf(rp[0]); bits = v === 160 ? 40 : v === 120 ? 64 : v === 58 ? 128 : v >= 256 ? v : 32; iv = body(rp[1]); } else iv = body(rp[0]);
        const key = await pbkdf2(prf, pw, salt, iter, keyLen || Math.ceil(bits / 8)); plain = unpad(rc2Cbc(key, bits, iv, data, true), 8); scheme = `PBES2 PBKDF2-HMAC-${prf} RC2-${bits}-CBC`;
      } else throw new Error(`PKCS#12: cipher ${e} unsupported`);
    } catch (err) { if ((err as Error).message === "bad padding") throw new P12PasswordError("wrong password (decryption failed)"); throw err; }
    return { plain, scheme };
  }
  if (id === "1.2.840.113549.1.5.3" || id === "1.2.840.113549.1.5.10" || id === "1.2.840.113549.1.5.6") throw new Error("PKCS#12: PBES1 (single DES) is not supported — re-export the file with AES or 3DES");
  throw new Error(`PKCS#12: encryption scheme ${id} unsupported`);
}

/** parse a PFX: verify the MAC, decrypt every bag, return the private keys (PKCS #8 DER) and certificates (X.509 DER) */
export async function parsePkcs12(file: Bytes, password: string): Promise<P12Contents> {
  if (file.length > 1 << 20) throw new Error("PKCS#12: file larger than 1 MiB");
  let pfx: Der[]; try { pfx = kids(der(file)); } catch (e) { throw new Error(`not a PKCS#12 file (${(e as Error).message})`); }
  if (pfx.length < 2 || pfx[0].tag !== 2 || intOf(pfx[0]) !== 3) throw new Error("not a PKCS#12 v3 file");
  const [ctype, wrapped] = kids(pfx[1]); const ct = oid(ctype);
  if (ct === OID.signedData || ct === OID.envelopedData) throw new Error("PKCS#12: public-key integrity/privacy modes are not supported");
  if (ct !== OID.data || !wrapped) throw new Error("PKCS#12: authSafe is not id-data");
  const authSafe = body(kids(wrapped)[0]);
  const out: P12Contents = { keys: [], certs: [], macAlg: null, schemes: [] };
  // ---- integrity
  if (pfx[2]) {
    const md = kids(pfx[2]); const [digestInfo, macSalt, iterN] = md; const [algId, digest] = kids(digestInfo); const ao = oid(kids(algId)[0]);
    if (ao === OID.pbmac1) throw new Error("PKCS#12: PBMAC1 (RFC 9579) integrity is not supported yet");
    const h = DIGEST[ao]; if (!h) throw new Error(`PKCS#12: MAC digest ${ao} unsupported`);
    const iter = iterOf(iterN); const salt = body(macSalt); const want = body(digest);
    const tryPw = (pw: Bytes) => eq(hmac(h, p12kdf(h, pw, salt, 3, iter, HASHES[h].size), authSafe), want);
    // the empty password: OpenSSL writes 00 00, some tools hash nothing at all
    if (!tryPw(bmpPassword(password)) && !(password === "" && tryPw(new Uint8Array(0)))) throw new P12PasswordError("wrong password or damaged file (the integrity MAC does not match)");
    out.macAlg = `HMAC-${h}`;
  }
  // ---- privacy
  let bags = 0;
  const safeContents = async (b: Bytes, depth: number) => {
    if (depth > 4) throw new Error("PKCS#12: bags nested too deeply");
    for (const bag of kids(der(b))) {
      if (++bags > 256) throw new Error("PKCS#12: too many bags");
      const parts = kids(bag); const type = oid(parts[0]); const val = kids(parts[1])[0];
      let localKeyId: Bytes | null = null, friendlyName: string | null = null;
      if (parts[2]) for (const at of kids(parts[2])) {
        const [ao, vals] = kids(at); const a = oid(ao); const v = kids(vals)[0]; if (!v) continue;
        if (a === OID.localKeyId) localKeyId = body(v);
        if (a === OID.friendlyName) { const x = body(v); friendlyName = String.fromCharCode(...Array.from({ length: x.length >> 1 }, (_, i) => (x[2 * i] << 8) | x[2 * i + 1])); }
      }
      if (type === OID.keyBag) out.keys.push({ der: whole(val), localKeyId, friendlyName });
      else if (type === OID.shroudedKeyBag) {
        const [alg, enc] = kids(val); const r = await pbeDecrypt(alg, password, body(enc)); out.schemes.push(r.scheme);
        try { der(r.plain); } catch { throw new P12PasswordError("wrong password (the decrypted key is not DER)"); }
        out.keys.push({ der: r.plain, localKeyId, friendlyName });
      } else if (type === OID.certBag) {
        const [co, cv] = kids(val); if (oid(co) !== OID.x509Cert) continue; // SDSI certificates and CRL bags are skipped
        out.certs.push({ der: body(kids(cv)[0]), localKeyId, friendlyName });
      } else if (type === OID.safeContentsBag) await safeContents(whole(val), depth + 1);
      // secretBag / crlBag: not needed for signing
    }
  };
  for (const ci of kids(der(authSafe))) {
    const [t, w] = kids(ci); const k = oid(t);
    if (k === OID.data) await safeContents(body(kids(w)[0]), 0);
    else if (k === OID.encryptedData) {
      const ed = kids(kids(w)[0]); const eci = kids(ed[1]); const alg = eci[1]; const enc = eci[2]; if (!enc) continue;
      const r = await pbeDecrypt(alg, password, body(enc)); out.schemes.push(r.scheme);
      try { der(r.plain); } catch { throw new P12PasswordError("wrong password (decrypted certificates are not DER)"); }
      await safeContents(r.plain, 0);
    } else throw new Error("PKCS#12: public-key privacy mode (envelopedData) is not supported");
  }
  return out;
}

/* ---------------------------------------------------------------- signing identity */
export interface P12Identity extends Identity { chain: Uint8Array[]; macAlg: string | null; schemes: string[] }
/** a signing identity from a PFX: the private key (imported NON-extractable into WebCrypto), the certificate that
 *  pairs with it (proved by signing a random challenge and verifying it with the certificate's public key — a
 *  localKeyId alone is not trusted), and the issuer chain ordered leaf → root from the remaining certificates */
export async function identityFromPkcs12(file: Bytes, password: string): Promise<P12Identity> {
  const c = await parsePkcs12(file, password);
  if (!c.keys.length) throw new Error("this PKCS#12 file holds no private key");
  if (!c.certs.length) throw new Error("this PKCS#12 file holds no certificate");
  const s = globalThis.crypto?.subtle; if (!s) throw new Error("WebCrypto unavailable");
  const ab = (b: Bytes) => b.slice().buffer as ArrayBuffer;
  const certs = c.certs.map((b) => ({ bag: b, cert: parseCert(b.der) }));
  const keys = [...c.keys].sort((a, b) => Number(!!b.localKeyId && certs.some((x) => x.bag.localKeyId && eq(x.bag.localKeyId, b.localKeyId!))) - Number(!!a.localKeyId && certs.some((x) => x.bag.localKeyId && eq(x.bag.localKeyId, a.localKeyId!))));
  for (const k of keys) {
    // PrivateKeyInfo ::= SEQUENCE { version, AlgorithmIdentifier, OCTET STRING, ... }
    let algOid = "", curve = ""; try { const ai = kids(kids(der(k.der))[1]); algOid = oid(ai[0]); if (ai[1]?.tag === 6) curve = oid(ai[1]); } catch { throw new Error("the private key is not PKCS#8"); }
    let alg: Identity["alg"], params: RsaHashedImportParams | EcKeyImportParams, signP: AlgorithmIdentifier | EcdsaParams;
    if (algOid === "1.2.840.113549.1.1.1") { alg = "RSA"; params = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }; signP = "RSASSA-PKCS1-v1_5"; }
    else if (algOid === "1.2.840.10045.2.1" && curve === "1.2.840.10045.3.1.7") { alg = "ECDSA-P256"; params = { name: "ECDSA", namedCurve: "P-256" }; signP = { name: "ECDSA", hash: "SHA-256" }; }
    else throw new Error(algOid === "1.2.840.10045.2.1" ? "only the P-256 curve is supported for EC keys" : "only RSA and EC P-256 keys are supported");
    const key = await s.importKey("pkcs8", ab(k.der), params, false, ["sign"]);
    const challenge = crypto.getRandomValues(new Uint8Array(32)); const sig = await s.sign(signP, key, ab(challenge));
    const ordered = [...certs].sort((a, b) => Number(!!k.localKeyId && !!b.bag.localKeyId && eq(b.bag.localKeyId, k.localKeyId)) - Number(!!k.localKeyId && !!a.bag.localKeyId && eq(a.bag.localKeyId, k.localKeyId)));
    for (const cand of ordered) {
      if (cand.cert.keyAlg !== algOid) continue;
      let ok = false; try { const pub = await s.importKey("spki", ab(cand.cert.spki), params, false, ["verify"]); ok = await s.verify(signP, pub, sig, ab(challenge)); } catch { ok = false; }
      if (!ok) continue;
      // issuer chain from the other certificates (subject = issuer), leaf → root, bounded
      const chain: Uint8Array[] = []; let cur = cand.cert; const used = new Set([cand]);
      for (let g = 0; g < 10 && !eq(cur.issuer, cur.subject); g++) { const nx = certs.find((x) => !used.has(x) && eq(x.cert.subject, cur.issuer)); if (!nx) break; used.add(nx); chain.push(nx.cert.der); cur = nx.cert; }
      return { name: cand.cert.subjectName.match(/CN=([^,]+)/)?.[1] ?? k.friendlyName ?? cand.cert.subjectName, key, certDer: cand.cert.der, alg, chain, macAlg: c.macAlg, schemes: c.schemes };
    }
  }
  throw new Error("no certificate in this file matches its private key");
}
