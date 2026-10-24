/**
 * TT47 — open password-protected .docx / .xlsx / .pptx (MS-OFFCRYPTO), written from the published specs:
 *   [MS-CFB]       compound file container (header, DIFAT, FAT, mini FAT, directory red-black tree)
 *   [MS-OFFCRYPTO] §2.3.4.10-15 Agile Encryption (Office 2010+, default SHA-512 / AES-256-CBC, HMAC integrity)
 *                  §2.3.4.5-9   Standard Encryption (Office 2007, SHA-1 x50,000 / AES-ECB)
 * Decryption only; runs in the browser and in Node (pure TS primitives from ./cryptoprims).
 * Guards: sector-chain cycle/bounds checks, 256 MiB package cap, HMAC integrity check for Agile packages.
 */
import { HASHES, aesCbcDecrypt, aesCbcEncrypt as _enc, aesEcbDecrypt, concat, hmac, sha1, sha512 as _sha512, type HashName } from "./cryptoprims";
import { writeCfb, type CfbNode } from "./cfbwrite";

type Bytes = Uint8Array;
export class OfficePasswordError extends Error {
  kind: "required" | "wrong";
  constructor(kind: "required" | "wrong", message: string) { super(message); this.kind = kind; this.name = "OfficePasswordError"; }
}
const MAX_PACKAGE = 256 << 20;
const CFB_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/* ------------------------------------------------------------------ [MS-CFB] reader */
export interface CfbEntry { name: string; type: number; start: number; size: number; left: number; right: number; child: number }
export function readCfb(buf: Bytes): { entries: CfbEntry[]; stream: (e: CfbEntry) => Bytes; rootChildren: () => CfbEntry[] } {
  if (buf.length < 512 || !CFB_SIG.every((b, i) => buf[i] === b)) throw new Error("cfb: not a compound file");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o: number) => { if (o + 4 > buf.length) throw new Error("cfb: read past end"); return dv.getUint32(o, true); };
  const major = dv.getUint16(26, true), shift = dv.getUint16(30, true), miniShift = dv.getUint16(32, true);
  if (dv.getUint16(28, true) !== 0xfffe || !((major === 3 && shift === 9) || (major === 4 && shift === 12)) || miniShift !== 6) throw new Error("cfb: unsupported header");
  const ss = 1 << shift; const nSectors = Math.floor((buf.length - ss) / ss) + 1;
  const off = (s: number) => { if (s >= nSectors || s < 0) throw new Error("cfb: sector out of range"); return (s + 1) * ss; };
  // DIFAT → FAT sector list
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) { const s = u32(76 + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
  let difat = u32(68), guard = 0; const difatSectors: number[] = [];
  while (difat < 0xfffffffa) {
    if (++guard > nSectors) throw new Error("cfb: DIFAT loop");
    difatSectors.push(difat);
    const o = off(difat); for (let i = 0; i < ss / 4 - 1; i++) { const s = u32(o + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
    difat = u32(o + ss - 4);
  }
  // [MS-CFB] 2.2/2.5: header counts must agree with the chains, and the FAT must mark its own and the DIFAT's sectors
  if (fatSectors.length !== u32(44) || difatSectors.length !== u32(72)) throw new Error("cfb: FAT/DIFAT sector count mismatch");
  if (fatSectors.length > nSectors) throw new Error("cfb: FAT larger than the file");
  const fat = new Uint32Array(fatSectors.length * (ss / 4));
  fatSectors.forEach((s, k) => { const o = off(s); for (let i = 0; i < ss / 4; i++) fat[k * (ss / 4) + i] = u32(o + i * 4); });
  if (fatSectors.some((s) => fat[s] !== 0xfffffffd) || difatSectors.some((s) => fat[s] !== 0xfffffffc)) throw new Error("cfb: FAT does not mark FAT/DIFAT sectors");
  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = []; const seen = new Set<number>(); let s = start;
    while (s < 0xfffffffa) { if (seen.has(s) || s >= table.length || out.length > limit) throw new Error("cfb: broken sector chain"); seen.add(s); out.push(s); s = table[s]; }
    return out;
  };
  const readChain = (start: number, size: number): Bytes => {
    const secs = chain(start, fat, nSectors); const out = new Uint8Array(secs.length * ss);
    secs.forEach((s, i) => out.set(buf.subarray(off(s), off(s) + ss), i * ss));
    if (size > out.length) throw new Error("cfb: stream shorter than its size");
    return out.subarray(0, size);
  };
  const dirBytes = readChain(u32(48), chain(u32(48), fat, nSectors).length * ss);
  const entries: CfbEntry[] = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const d = new DataView(dirBytes.buffer, dirBytes.byteOffset + o, 128);
    const nl = Math.min(64, d.getUint16(64, true)); let name = "";
    for (let i = 0; i + 2 <= nl - 2; i += 2) { const c = d.getUint16(i, true); if (!c) break; name += String.fromCharCode(c); }
    const size = major === 3 ? d.getUint32(120, true) : d.getUint32(120, true) + d.getUint32(124, true) * 2 ** 32;
    entries.push({ name, type: d.getUint8(66), left: d.getUint32(68, true), right: d.getUint32(72, true), child: d.getUint32(76, true), start: d.getUint32(116, true), size });
  }
  const root = entries[0]; if (!root || root.type !== 5) throw new Error("cfb: no root entry");
  const cutoff = u32(56) || 4096;
  let mini: Bytes | null = null, minifat: Uint32Array | null = null;
  const stream = (e: CfbEntry): Bytes => {
    if (e.type !== 2) throw new Error("cfb: not a stream");
    if (e.size > MAX_PACKAGE + 4096) throw new Error("cfb: stream too large");
    if (e.size >= cutoff) return readChain(e.start, e.size);
    if (!mini) {
      mini = readChain(root.start, root.size);
      const mf = readChain(u32(60), u32(64) * ss); minifat = new Uint32Array(mf.length / 4); for (let i = 0; i < minifat.length; i++) minifat[i] = new DataView(mf.buffer, mf.byteOffset).getUint32(i * 4, true);
    }
    const secs = chain(e.start, minifat!, mini.length / 64 + 1); const out = new Uint8Array(secs.length * 64);
    secs.forEach((s, i) => { if ((s + 1) * 64 > mini!.length) throw new Error("cfb: mini sector out of range"); out.set(mini!.subarray(s * 64, s * 64 + 64), i * 64); });
    if (e.size > out.length) throw new Error("cfb: mini stream shorter than its size");
    return out.subarray(0, e.size);
  };
  const rootChildren = () => {
    const out: CfbEntry[] = []; const seen = new Set<number>();
    const walk = (i: number) => { if (i >= entries.length || i === 0xffffffff || seen.has(i)) return; seen.add(i); const e = entries[i]; walk(e.left); out.push(e); walk(e.right); };
    walk(root.child); return out;
  };
  return { entries, stream, rootChildren };
}

/** True for an OOXML package wrapped by Office password encryption (CFB with EncryptionInfo + EncryptedPackage). */
export function isEncryptedOffice(buf: Bytes): boolean {
  if (buf.length < 512 || !CFB_SIG.every((b, i) => buf[i] === b)) return false;
  try { const names = readCfb(buf).rootChildren().map((e) => e.name); return names.includes("EncryptionInfo") && names.includes("EncryptedPackage"); }
  catch { return false; }
}

/* ------------------------------------------------------------------ helpers */
const utf16 = (s: string) => { const out = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { out[2 * i] = s.charCodeAt(i) & 0xff; out[2 * i + 1] = s.charCodeAt(i) >> 8; } return out; };
const le32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const b64 = (s: string): Bytes => { const bin = atob(s.replace(/\s+/g, "")); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
/** Truncate, or pad with 0x36, to n bytes (MS-OFFCRYPTO §2.3.4.11/12). */
const fit = (b: Bytes, n: number) => { if (b.length >= n) return b.slice(0, n); const out = new Uint8Array(n).fill(0x36); out.set(b); return out; };
const eqBytes = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i]);
function attrs(tag: string): Record<string, string> { const out: Record<string, string> = {}; for (const m of tag.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].replace(/^\w+:/, "")] = m[2] ?? m[3]; return out; }

/* ------------------------------------------------------------------ Agile */
const BK_VERIFIER_INPUT = fromHex("fea7d2763b4b9e79"), BK_VERIFIER_VALUE = fromHex("d7aa0f6d3061344e"), BK_KEY = fromHex("146e0be7abacd0d6");
const BK_HMAC_KEY = fromHex("5fb2ad010cb9e1f6"), BK_HMAC_VALUE = fromHex("a0677f02b22c8433");
function agile(xml: string, pkg: Bytes, password: string) {
  const kd = attrs(/<(?:\w+:)?keyData\b[^>]*>/.exec(xml)?.[0] ?? "");
  const ek = attrs(/<(?:\w+:)?encryptedKey\b[^>]*>/.exec(xml)?.[0] ?? "");
  const di = attrs(/<(?:\w+:)?dataIntegrity\b[^>]*>/.exec(xml)?.[0] ?? "");
  if (!kd.saltValue || !ek.encryptedKeyValue) throw new Error("offcrypto: agile EncryptionInfo lacks a password key encryptor");
  for (const x of [kd, ek]) if ((x.cipherAlgorithm ?? "AES") !== "AES" || (x.cipherChaining ?? "ChainingModeCBC") !== "ChainingModeCBC") throw new Error(`offcrypto: unsupported cipher ${x.cipherAlgorithm}/${x.cipherChaining}`);
  const hn = (h: string | undefined) => { const n = (h ?? "SHA1").toUpperCase().replace("-", "") as HashName; if (!HASHES[n]) throw new Error(`offcrypto: unsupported hash ${h}`); return n; };
  const ph = hn(ek.hashAlgorithm), H = HASHES[ph].fn;
  const spin = Number(ek.spinCount); if (!(spin >= 0 && spin <= 10_000_000)) throw new Error("offcrypto: bad spinCount");
  const salt = b64(ek.saltValue), keyLen = Number(ek.keyBits) / 8, block = Number(ek.blockSize) || 16;
  // §2.3.4.11: H0 = H(salt + password); Hn = H(iterator + Hn-1)
  let h = H(concat(salt, utf16(password.slice(0, 255))));
  const buf = new Uint8Array(4 + h.length); const dv = new DataView(buf.buffer);
  for (let i = 0; i < spin; i++) { dv.setUint32(0, i, true); buf.set(h, 4); h = H(buf); }
  const keyFor = (bk: Bytes) => fit(H(concat(h, bk)), keyLen);
  const vInput = aesCbcDecrypt(keyFor(BK_VERIFIER_INPUT), fit(salt, block), b64(ek.encryptedVerifierHashInput)).slice(0, Number(ek.saltSize) || salt.length);
  const vHash = aesCbcDecrypt(keyFor(BK_VERIFIER_VALUE), fit(salt, block), b64(ek.encryptedVerifierHashValue)).slice(0, HASHES[ph].size);
  if (!eqBytes(H(vInput), vHash)) throw new OfficePasswordError("wrong", "The password is not correct.");
  const secret = aesCbcDecrypt(keyFor(BK_KEY), fit(salt, block), b64(ek.encryptedKeyValue)).slice(0, Number(kd.keyBits) / 8);
  // package: u64 size + 4096-byte segments, IV_i = H(keyData.salt + i) fitted to the block size
  const dh = hn(kd.hashAlgorithm), DH = HASHES[dh].fn, kSalt = b64(kd.saltValue), kBlock = Number(kd.blockSize) || 16;
  if (pkg.length < 8) throw new Error("offcrypto: EncryptedPackage truncated");
  const size = new DataView(pkg.buffer, pkg.byteOffset).getUint32(0, true) + new DataView(pkg.buffer, pkg.byteOffset).getUint32(4, true) * 2 ** 32;
  if (size > MAX_PACKAGE || size > pkg.length - 8) throw new Error("offcrypto: EncryptedPackage size field out of range");
  let integrity: "verified" | "absent" = "absent";
  if (di.encryptedHmacKey && di.encryptedHmacValue) {
    const hk = aesCbcDecrypt(secret, fit(DH(concat(kSalt, BK_HMAC_KEY)), kBlock), b64(di.encryptedHmacKey)).slice(0, HASHES[dh].size);
    const hv = aesCbcDecrypt(secret, fit(DH(concat(kSalt, BK_HMAC_VALUE)), kBlock), b64(di.encryptedHmacValue)).slice(0, HASHES[dh].size);
    if (!eqBytes(hmac(dh, hk, pkg), hv)) throw new Error("offcrypto: integrity check failed — the encrypted file was modified or is corrupt");
    integrity = "verified";
  }
  const out = new Uint8Array(size);
  for (let seg = 0, o = 8; o - 8 < size; seg++, o += 4096) {
    let chunk = pkg.subarray(o, Math.min(o + 4096, pkg.length));
    if (chunk.length % kBlock) chunk = chunk.subarray(0, chunk.length - (chunk.length % kBlock));
    const plain = aesCbcDecrypt(secret, fit(DH(concat(kSalt, le32(seg))), kBlock), chunk);
    out.set(plain.subarray(0, Math.min(plain.length, size - (o - 8))), o - 8);
  }
  return { bytes: out, integrity };
}

/* ------------------------------------------------------------------ Standard */
function standard(info: Bytes, pkg: Bytes, password: string) {
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const headerSize = dv.getUint32(8, true); const h = 12;
  if (h + headerSize + 4 > info.length) throw new Error("offcrypto: EncryptionInfo truncated");
  const algId = dv.getUint32(h + 8, true), keyBits = dv.getUint32(h + 16, true) || 128;
  if (![0x660e, 0x660f, 0x6610].includes(algId)) throw new Error(`offcrypto: unsupported Standard algorithm 0x${algId.toString(16)} (RC4/CryptoAPI is not supported)`);
  let v = h + headerSize; const saltSize = dv.getUint32(v, true); v += 4;
  const salt = info.slice(v, v + saltSize); v += saltSize;
  const encVerifier = info.slice(v, v + 16); v += 16;
  const hashSize = dv.getUint32(v, true); v += 4;
  const encVerifierHash = info.slice(v, v + 32);
  // §2.3.4.7
  let hh = sha1(concat(salt, utf16(password.slice(0, 255))));
  const buf = new Uint8Array(24); const bd = new DataView(buf.buffer);
  for (let i = 0; i < 50000; i++) { bd.setUint32(0, i, true); buf.set(hh, 4); hh = sha1(buf); }
  const hf = sha1(concat(hh, le32(0)));
  const x = (c: number) => { const b = new Uint8Array(64).fill(c); for (let i = 0; i < hf.length; i++) b[i] ^= hf[i]; return sha1(b); };
  const key = concat(x(0x36), x(0x5c)).slice(0, keyBits / 8);
  const verifier = aesEcbDecrypt(key, encVerifier);
  const vhash = aesEcbDecrypt(key, encVerifierHash).slice(0, hashSize || 20);
  if (!eqBytes(sha1(verifier), vhash)) throw new OfficePasswordError("wrong", "The password is not correct.");
  const size = new DataView(pkg.buffer, pkg.byteOffset).getUint32(0, true) + new DataView(pkg.buffer, pkg.byteOffset).getUint32(4, true) * 2 ** 32;
  if (size > MAX_PACKAGE || size > pkg.length - 8) throw new Error("offcrypto: EncryptedPackage size field out of range");
  const body = pkg.subarray(8, 8 + Math.ceil(size / 16) * 16);
  return { bytes: aesEcbDecrypt(key, body.length % 16 ? body.subarray(0, body.length - (body.length % 16)) : body).slice(0, size), integrity: "absent" as const };
}

/** Decrypt a password-protected OOXML file → the plain .docx/.xlsx/.pptx package bytes. */
export function decryptOffice(buf: Bytes, password: string): { bytes: Bytes; method: "agile" | "standard"; integrity: "verified" | "absent" } {
  const cfb = readCfb(buf); const kids = cfb.rootChildren();
  const infoE = kids.find((e) => e.name === "EncryptionInfo"), pkgE = kids.find((e) => e.name === "EncryptedPackage");
  if (!infoE || !pkgE) throw new Error("offcrypto: not an encrypted Office package");
  const info = cfb.stream(infoE), pkg = cfb.stream(pkgE);
  const iv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const major = iv.getUint16(0, true), minor = iv.getUint16(2, true);
  let r: { bytes: Bytes; integrity: "verified" | "absent" }; let method: "agile" | "standard";
  if (major === 4 && minor === 4) { r = agile(new TextDecoder().decode(info.subarray(8)), pkg, password); method = "agile"; }
  else if ((major === 2 || major === 3 || major === 4) && minor === 2) { r = standard(info, pkg, password); method = "standard"; }
  else throw new Error(`offcrypto: unsupported encryption version ${major}.${minor}`);
  if (!(r.bytes[0] === 0x50 && r.bytes[1] === 0x4b)) throw new Error("offcrypto: decrypted data is not a ZIP package");
  return { ...r, method };
}

/* ------------------------------------------------------------------ TT48: Agile encryption (re-encrypting save) */

const rnd = (n: number) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };
const b64e = (b: Bytes) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const pad16 = (b: Bytes) => { if (b.length % 16 === 0) return b; const o = new Uint8Array(b.length + 16 - (b.length % 16)); o.set(b); return o; };
/** [MS-OFFCRYPTO] 2.1.2 UNICODE-LP-P4: u32 byte length, UTF-16LE, zero-padded to a multiple of 4 */
const lpp4 = (s: string) => { const u = utf16(s); const o = new Uint8Array(4 + u.length + ((4 - (u.length % 4)) % 4)); new DataView(o.buffer).setUint32(0, u.length, true); o.set(u, 4); return o; };
const u32s = (...v: number[]) => { const o = new Uint8Array(v.length * 4); const d = new DataView(o.buffer); v.forEach((x, i) => d.setUint32(i * 4, x, true)); return o; };
const ver = () => { const o = new Uint8Array(4); const d = new DataView(o.buffer); d.setUint16(0, 1, true); d.setUint16(2, 0, true); return o; };

/** The \x06DataSpaces storage Office expects beside an encrypted package ([MS-OFFCRYPTO] 2.1.5-2.1.8, 2.3.4.1). */
export function dataSpacesStorage(): CfbNode {
  const version = concat(lpp4("Microsoft.Container.DataSpaces"), ver(), ver(), ver());
  const entry = concat(u32s(1, 0), lpp4("EncryptedPackage"), lpp4("StrongEncryptionDataSpace"));
  const map = concat(u32s(8, 1), u32s(entry.length + 4), entry);
  const def = concat(u32s(8, 1), lpp4("StrongEncryptionTransform"));
  const id = lpp4("{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}");
  const primary = concat(u32s(8 + id.length, 1), id, lpp4("Microsoft.Container.EncryptionTransform"), ver(), ver(), ver(), u32s(0, 0, 0, 4));
  return { name: "\u0006DataSpaces", children: [
    { name: "Version", data: version },
    { name: "DataSpaceMap", data: map },
    { name: "DataSpaceInfo", children: [{ name: "StrongEncryptionDataSpace", data: def }] },
    { name: "TransformInfo", children: [{ name: "StrongEncryptionTransform", children: [{ name: "\u0006Primary", data: primary }] }] },
  ] };
}

/**
 * Encrypt an OOXML package with a password: Agile Encryption, SHA-512, AES-256-CBC, 100,000-round key derivation,
 * 4096-byte segments and an HMAC-SHA512 integrity record — the parameters Office 2013+ writes by default.
 */
/** The slow part of a password save: SHA-512 iterated spinCount times over (salt, password) — [MS-OFFCRYPTO] 2.3.4.11. */
export interface AgileKey { salt: Bytes; hash: Bytes; spin: number }
export function deriveAgileKey(password: string, spinCount = 100000): AgileKey {
  if (!password) throw new Error("offcrypto: a password is required");
  if (!(spinCount >= 1 && spinCount <= 10_000_000)) throw new Error("offcrypto: bad spinCount");
  const salt = rnd(16); let h = _sha512(concat(salt, utf16(password.slice(0, 255))));
  const buf = new Uint8Array(4 + 64); const dv = new DataView(buf.buffer);
  for (let i = 0; i < spinCount; i++) { dv.setUint32(0, i, true); buf.set(h, 4); h = _sha512(buf); }
  return { salt, hash: h, spin: spinCount };
}

/**
 * opts.key: a cached deriveAgileKey() result for the same password (a window re-saving the same document). The
 * package key, data salt, segment IVs, verifier and HMAC key are still fresh random values on every call.
 */
export function encryptOffice(plain: Bytes, password: string, opts: { spinCount?: number; key?: AgileKey } = {}): Bytes {
  if (!(plain[0] === 0x50 && plain[1] === 0x4b)) throw new Error("offcrypto: only OOXML (ZIP) packages can be encrypted");
  if (plain.length > MAX_PACKAGE) throw new Error("offcrypto: package too large to encrypt");
  if (!password) throw new Error("offcrypto: a password is required");
  const K = opts.key ?? deriveAgileKey(password, opts.spinCount ?? 100000);
  const H = _sha512, HS = 64, spin = K.spin, pwSalt = K.salt, h = K.hash;
  const kdSalt = rnd(16), secret = rnd(32), verifier = rnd(16), hmacKey = rnd(HS);
  // package: u64 size + AES-256-CBC per 4096-byte segment, IV_i = SHA512(keyData.salt + LE32(i))[0:16]
  const nSeg = Math.ceil(plain.length / 4096);
  const parts: Bytes[] = [concat(le32(plain.length), le32(0))];
  for (let i = 0; i < nSeg; i++) parts.push(_enc(secret, H(concat(kdSalt, le32(i))).slice(0, 16), pad16(plain.subarray(i * 4096, (i + 1) * 4096))));
  const pkg = concat(...parts);
  // password key encryptor (§2.3.4.13)
  const keyFor = (bk: Bytes) => H(concat(h, bk)).slice(0, 32);
  const encVI = _enc(keyFor(BK_VERIFIER_INPUT), pwSalt, verifier);
  const encVH = _enc(keyFor(BK_VERIFIER_VALUE), pwSalt, H(verifier));
  const encKV = _enc(keyFor(BK_KEY), pwSalt, secret);
  // integrity (§2.3.4.14): HMAC over the whole EncryptedPackage stream
  const hmacVal = hmac("SHA512", hmacKey, pkg);
  const encHK = _enc(secret, H(concat(kdSalt, BK_HMAC_KEY)).slice(0, 16), hmacKey);
  const encHV = _enc(secret, H(concat(kdSalt, BK_HMAC_VALUE)).slice(0, 16), hmacVal);
  const common = `blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512"`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password" xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">`
    + `<keyData saltSize="16" ${common} saltValue="${b64e(kdSalt)}"/>`
    + `<dataIntegrity encryptedHmacKey="${b64e(encHK)}" encryptedHmacValue="${b64e(encHV)}"/>`
    + `<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password"><p:encryptedKey spinCount="${spin}" saltSize="16" ${common} saltValue="${b64e(pwSalt)}" encryptedVerifierHashInput="${b64e(encVI)}" encryptedVerifierHashValue="${b64e(encVH)}" encryptedKeyValue="${b64e(encKV)}"/></keyEncryptor></keyEncryptors></encryption>`;
  const info = concat(new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]), new TextEncoder().encode(xml));
  return writeCfb([dataSpacesStorage(), { name: "EncryptionInfo", data: info }, { name: "EncryptedPackage", data: pkg }]);
}
