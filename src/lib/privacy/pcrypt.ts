/**
 * Encrypted Persistent Storage — cryptographic core (TT18, Tails-like privacy).
 *
 * Isomorphic: the same code runs in the browser and in Node ≥ 20 (globalThis.crypto.subtle +
 * hash-wasm's WebAssembly Argon2id), so the suites test exactly what the UI executes.
 *
 * Model (LUKS2 analogue, see docs/PRIVACY.md):
 *  - A random 256-bit volume key (DEK) encrypts everything. It is never stored in clear.
 *  - Keyslots wrap the DEK under a key-encryption key derived from a passphrase or a
 *    user-held recovery key (Argon2id by default — what Tails ≥ 5.14 uses for LUKS2; PBKDF2 is
 *    accepted only as an explicit fallback). Changing the passphrase rewraps one slot; no file is
 *    re-encrypted. Slot parameters are bound as AES-GCM additional data, so editing the header to
 *    downgrade the KDF breaks the tag instead of silently weakening it, and policy floors are
 *    enforced BEFORE any derivation.
 *  - Subkeys come from HKDF-SHA256(DEK, salt = volumeId): content (AES-GCM), names (AES-GCM) and a
 *    synthetic-IV key (HMAC-SHA256). All imported as non-extractable CryptoKeys.
 *  - File content → "FEN1" blob: magic|version|flags|iv|AES-GCM(payload) with payload =
 *    len|mime|encoding|data|zero padding to the Padmé length (Nikitin et al., PETS 2019), so the host
 *    learns only O(log log n) bits of each file's size instead of the exact size.
 *  - File and folder names → "~" + base64url(siv ‖ AES-GCM(name)), siv = HMAC(nameIvKey, name)[0..12).
 *    Deterministic on purpose (the server must be able to look a path up), so the host learns only
 *    name EQUALITY, never content; a repeated nonce only ever repeats for an identical plaintext.
 *
 * What this does NOT give (declared, not hidden): the host still sees the number of entries, the
 * tree shape, timestamps and approximate sizes, and a host that stores the blobs can roll a file
 * back to an older ciphertext or swap two blobs (integrity is per blob, not a whole-volume Merkle
 * root). See the threat model in docs/PRIVACY.md.
 */
import { argon2id } from "hash-wasm";

export const PRIVATE_ROOT = "/Private";
export const KEYSLOT_FILE = ".keyslots.json";
export const KEYSLOT_PATH = `${PRIVATE_ROOT}/${KEYSLOT_FILE}`;
export const HEADER_FORMAT = "fusion-private-1";
export const ENC_MIME = "application/x-fusion-encrypted";

/** RFC 9106 §4 "second recommended option" memory (64 MiB), t = 3, p = 1 (single-threaded WASM). */
export const ARGON2_DEFAULT = { kdf: "argon2id" as const, m: 65536, t: 3, p: 1 };
/** OWASP 2023 minimum for Argon2id is m = 19 MiB, t = 2; refuse anything weaker before deriving. */
export const ARGON2_FLOOR = { m: 19456, t: 2 };
export const PBKDF2_FLOOR = 600_000;

export type KdfParams = { kdf: "argon2id"; m: number; t: number; p: number } | { kdf: "pbkdf2-sha256"; iterations: number };
export interface Keyslot {
  id: string;
  kind: "passphrase" | "recovery";
  kdf: KdfParams;
  salt: string; iv: string; wrapped: string;
  created: string;
}
export interface KeyHeader { format: typeof HEADER_FORMAT; volumeId: string; slots: Keyslot[]; created: string }

export interface VolumeKeys {
  volumeId: Uint8Array;
  content: CryptoKey;
  names: CryptoKey;
  nameIv: CryptoKey;
  /** Short public fingerprint of the volume (not of the key) for UI display. */
  fingerprint: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const bs = (u: Uint8Array) => u as BufferSource;

/* ----------------------------------------------------------------- encodings */
// Table-driven base64 (TT18 perf: the old String.fromCharCode+btoa path cost ~14 ms per 256 KiB — 20× the
// AES-GCM itself). Native Uint8Array.toBase64/fromBase64 are used where the engine has them.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64E = new Uint8Array(64); const B64D = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) { B64E[i] = B64.charCodeAt(i); B64D[B64.charCodeAt(i)] = i; }
const ascii = new TextDecoder("latin1");
type NativeB64 = { toBase64?: () => string };
export const toB64 = (u8: Uint8Array) => {
  const nat = (u8 as unknown as NativeB64).toBase64;
  if (typeof nat === "function") return nat.call(u8);
  const n = u8.length; const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0; let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out[o++] = B64E[v >> 18]; out[o++] = B64E[(v >> 12) & 63]; out[o++] = B64E[(v >> 6) & 63]; out[o++] = B64E[v & 63];
  }
  if (i < n) {
    const v = (u8[i] << 16) | ((i + 1 < n ? u8[i + 1] : 0) << 8);
    out[o++] = B64E[v >> 18]; out[o++] = B64E[(v >> 12) & 63];
    out[o++] = i + 1 < n ? B64E[(v >> 6) & 63] : 61; out[o++] = 61;
  }
  return ascii.decode(out);
};
/** Strict decoder: ASCII whitespace ignored (as atob), any other non-alphabet byte or bad padding throws. */
export const fromB64 = (input: string) => {
  const fromNative = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  const s = /[\t\n\f\r ]/.test(input) ? input.replace(/[\t\n\f\r ]+/g, "") : input;
  if (typeof fromNative === "function") return fromNative(s);
  let len = s.length;
  if (len % 4 === 1) throw new Error("invalid base64 (length)");
  if (len % 4 === 0 && len > 0 && s.charCodeAt(len - 1) === 61) { len--; if (s.charCodeAt(len - 1) === 61) len--; }
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0; let acc = 0; let bits = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i); const d = c < 256 ? B64D[c] : -1;
    if (d < 0) throw new Error(`invalid base64 character at ${i}`);
    acc = (acc << 6) | d; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out;
};
export const toB64u = (u8: Uint8Array) => toB64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromB64(b + "=".repeat((4 - (b.length % 4)) % 4));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
/** Best-effort zeroisation of key material we own (JS cannot wipe engine copies — declared). */
export const wipe = (...arrs: (Uint8Array | null | undefined)[]) => { for (const a of arrs) a?.fill(0); };

/* ------------------------------------------------------------ Padmé padding */
/**
 * Padmé (Nikitin, Barman, Lueks, Underwood, Hubaux, Ford — "Reducing Metadata Leakage from Encrypted
 * Files and Communication with PURBs", PETS 2019, Algorithm 1). Max overhead ≈ 11.1% (12% bound),
 * leaks O(log log L) bits.
 */
export function padme(L: number): number {
  if (!Number.isInteger(L) || L < 0) throw new Error("padme: bad length");
  if (L < 2) return L;
  const E = Math.floor(Math.log2(L));
  const S = Math.floor(Math.log2(E)) + 1;
  const lastBits = E - S;
  const mask = 2 ** lastBits - 1;
  // (L + mask) & ~mask, written with arithmetic so it stays exact above 2^31
  return Math.floor((L + mask) / (mask + 1)) * (mask + 1);
}

/* ----------------------------------------------------------------- KDF / slots */
function checkFloor(k: KdfParams) {
  if (k.kdf === "argon2id") {
    if (!Number.isInteger(k.m) || !Number.isInteger(k.t) || !Number.isInteger(k.p) || k.p < 1 || k.p > 16) throw new Error("argon2id parameters malformed");
    if (k.m < ARGON2_FLOOR.m || k.t < ARGON2_FLOOR.t) throw new Error(`argon2id parameters below policy floor (m ≥ ${ARGON2_FLOOR.m} KiB, t ≥ ${ARGON2_FLOOR.t})`);
    if (k.m > 1048576) throw new Error("argon2id memory above 1 GiB refused (denial-of-service guard)");
  } else if (k.kdf === "pbkdf2-sha256") {
    if (!Number.isInteger(k.iterations) || k.iterations < PBKDF2_FLOOR) throw new Error(`PBKDF2 iterations below policy floor (${PBKDF2_FLOOR})`);
    if (k.iterations > 50_000_000) throw new Error("PBKDF2 iterations above guard");
  } else {
    throw new Error(`unknown KDF ${(k as { kdf: string }).kdf}`);
  }
}
const kdfTag = (k: KdfParams) => (k.kdf === "argon2id" ? `argon2id:m=${k.m},t=${k.t},p=${k.p}` : `pbkdf2-sha256:i=${k.iterations}`);
const slotAad = (volumeId: string, s: Pick<Keyslot, "id" | "kind" | "kdf">) => enc.encode(`${HEADER_FORMAT}|${volumeId}|${s.id}|${s.kind}|${kdfTag(s.kdf)}`);

export async function deriveKek(secret: string, salt: Uint8Array, k: KdfParams): Promise<Uint8Array> {
  if (!secret) throw new Error("empty passphrase");
  checkFloor(k);
  if (k.kdf === "argon2id") {
    return argon2id({ password: secret.normalize("NFKC"), salt, iterations: k.t, parallelism: k.p, memorySize: k.m, hashLength: 32, outputType: "binary" });
  }
  const base = await subtle().importKey("raw", bs(enc.encode(secret.normalize("NFKC"))), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "PBKDF2", salt: bs(salt), iterations: k.iterations, hash: "SHA-256" }, base, 256));
}

async function sealSlot(volumeId: string, dek: Uint8Array, secret: string, kind: Keyslot["kind"], kdf: KdfParams): Promise<Keyslot> {
  const id = toB64u(rand(6));
  const salt = rand(16);
  const iv = rand(12);
  const kek = await deriveKek(secret, salt, kdf);
  const key = await subtle().importKey("raw", bs(kek), "AES-GCM", false, ["encrypt"]);
  wipe(kek);
  const wrapped = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(slotAad(volumeId, { id, kind, kdf })) }, key, bs(dek)));
  return { id, kind, kdf, salt: toB64(salt), iv: toB64(iv), wrapped: toB64(wrapped), created: new Date().toISOString() };
}

async function openSlot(h: KeyHeader, s: Keyslot, secret: string): Promise<Uint8Array> {
  const kek = await deriveKek(secret, fromB64(s.salt), s.kdf);
  const key = await subtle().importKey("raw", bs(kek), "AES-GCM", false, ["decrypt"]);
  wipe(kek);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bs(fromB64(s.iv)), additionalData: bs(slotAad(h.volumeId, s)) }, key, bs(fromB64(s.wrapped))));
}

/** Validates header SHAPE (not secrets) — run on every header read from the host. */
export function parseHeader(json: string): KeyHeader {
  const h = JSON.parse(json) as KeyHeader;
  if (h?.format !== HEADER_FORMAT) throw new Error("not a Fusion Persistent Storage header");
  if (typeof h.volumeId !== "string" || fromB64(h.volumeId).length !== 16) throw new Error("header volumeId malformed");
  if (!Array.isArray(h.slots) || h.slots.length === 0 || h.slots.length > 8) throw new Error("header must carry 1–8 keyslots");
  for (const s of h.slots) {
    if (typeof s.id !== "string" || !["passphrase", "recovery"].includes(s.kind)) throw new Error("keyslot malformed");
    checkFloor(s.kdf);
    if (fromB64(s.salt).length !== 16 || fromB64(s.iv).length !== 12 || fromB64(s.wrapped).length !== 48) throw new Error("keyslot sizes malformed");
  }
  return h;
}

/* ------------------------------------------------------- recovery key format */
const B32 = "ABCDEFGHJKMNPQRSTVWXYZ0123456789"; // Crockford-like, no I L O U
export function newRecoveryKey(): string {
  const r = rand(20); // 160 bits
  let bits = 0, val = 0, out = "";
  for (const b of r) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  wipe(r);
  return out.match(/.{4}/g)!.join("-");
}
/** Normalises user input of a recovery key (case, separators, common confusables). */
export const normaliseRecoveryKey = (s: string) => s.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

/* ------------------------------------------------------------- volume life */
export async function createVolume(passphrase: string, opts: { kdf?: KdfParams; withRecovery?: boolean } = {}) {
  if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters (Tails recommends 5+ random words)");
  const kdf = opts.kdf ?? ARGON2_DEFAULT;
  const volumeId = toB64(rand(16));
  const dek = rand(32);
  const slots = [await sealSlot(volumeId, dek, passphrase, "passphrase", kdf)];
  let recoveryKey: string | null = null;
  if (opts.withRecovery !== false) {
    recoveryKey = newRecoveryKey();
    slots.push(await sealSlot(volumeId, dek, normaliseRecoveryKey(recoveryKey), "recovery", kdf));
  }
  const header: KeyHeader = { format: HEADER_FORMAT, volumeId, slots, created: new Date().toISOString() };
  const keys = await importVolumeKeys(dek, fromB64(volumeId));
  wipe(dek);
  return { header, keys, recoveryKey };
}

/** Tries every slot (a recovery key is accepted in any separator/case form). */
export async function unlockVolume(h: KeyHeader, secret: string): Promise<{ keys: VolumeKeys; slot: Keyslot }> {
  parseHeader(JSON.stringify(h));
  for (const s of h.slots) {
    const candidate = s.kind === "recovery" ? normaliseRecoveryKey(secret) : secret;
    try {
      const dek = await openSlot(h, s, candidate);
      const keys = await importVolumeKeys(dek, fromB64(h.volumeId));
      wipe(dek);
      return { keys, slot: s };
    } catch { /* next slot */ }
  }
  throw new Error("wrong passphrase or recovery key (or the header was modified)");
}

/** Rewraps the DEK under a new passphrase in place of slot `slotId` (Tails: Change Passphrase). */
export async function changePassphrase(h: KeyHeader, current: string, next: string, kdf: KdfParams = ARGON2_DEFAULT): Promise<KeyHeader> {
  if (next.length < 8) throw new Error("passphrase must be at least 8 characters");
  for (const s of h.slots.filter((x) => x.kind === "passphrase")) {
    let dek: Uint8Array;
    try { dek = await openSlot(h, s, current); } catch { continue; }
    const fresh = await sealSlot(h.volumeId, dek, next, "passphrase", kdf);
    wipe(dek);
    return { ...h, slots: h.slots.map((x) => (x.id === s.id ? fresh : x)) };
  }
  throw new Error("current passphrase is wrong");
}

/** Replaces (or adds) the recovery slot; requires a working passphrase. Returns the new key once. */
export async function rotateRecoveryKey(h: KeyHeader, passphrase: string, kdf: KdfParams = ARGON2_DEFAULT) {
  for (const s of h.slots.filter((x) => x.kind === "passphrase")) {
    let dek: Uint8Array;
    try { dek = await openSlot(h, s, passphrase); } catch { continue; }
    const recoveryKey = newRecoveryKey();
    const slot = await sealSlot(h.volumeId, dek, normaliseRecoveryKey(recoveryKey), "recovery", kdf);
    wipe(dek);
    return { header: { ...h, slots: [...h.slots.filter((x) => x.kind !== "recovery"), slot] }, recoveryKey };
  }
  throw new Error("passphrase is wrong");
}

async function importVolumeKeys(dek: Uint8Array, volumeId: Uint8Array): Promise<VolumeKeys> {
  const ikm = await subtle().importKey("raw", bs(dek), "HKDF", false, ["deriveKey", "deriveBits"]);
  const hk = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: bs(volumeId), info: bs(enc.encode(`${HEADER_FORMAT}/${info}`)) });
  const content = await subtle().deriveKey(hk("content-v1"), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const names = await subtle().deriveKey(hk("names-v1"), ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const nameIv = await subtle().deriveKey(hk("names-siv-v1"), ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const fp = new Uint8Array(await subtle().digest("SHA-256", bs(concat(enc.encode("fusion-volume-fp|"), volumeId))));
  return { volumeId, content, names, nameIv, fingerprint: toB64u(fp.subarray(0, 6)) };
}

/** Test/KAT hook: derive the same subkeys from known DEK bytes (used by the Python cross-check). */
export const importVolumeKeysForTest = importVolumeKeys;

/* ------------------------------------------------------------ content blobs */
const MAGIC = enc.encode("FEN1");
const VERSION = 1;
const contentAad = (k: VolumeKeys, flags: number) => concat(MAGIC, Uint8Array.of(VERSION, flags), k.volumeId);
export const isEncryptedBlob = (u8: Uint8Array) => u8.length >= 4 + 2 + 12 + 16 && u8[0] === 0x46 && u8[1] === 0x45 && u8[2] === 0x4e && u8[3] === 0x31;
/** Fast check on the stored base64 text without decoding the whole blob ("FEN1" → "RkVOMQ"). */
export const looksEncryptedB64 = (b64: string) => b64.startsWith("RkVOMQ");

export interface Plain { data: Uint8Array; mime: string; encoding: "utf8" | "base64" }

export async function encryptContent(k: VolumeKeys, p: Plain): Promise<Uint8Array> {
  const mime = enc.encode(p.mime.slice(0, 200));
  const head = new Uint8Array(4 + 1 + mime.length + 1);
  new DataView(head.buffer).setUint32(0, p.data.length);
  head[4] = mime.length; head.set(mime, 5); head[5 + mime.length] = p.encoding === "base64" ? 1 : 0;
  const bodyLen = head.length + p.data.length;
  const payload = new Uint8Array(padme(bodyLen));
  payload.set(head, 0); payload.set(p.data, head.length);
  const flags = 1; // bit0: Padmé padded
  const iv = rand(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(contentAad(k, flags)) }, k.content, bs(payload)));
  wipe(payload);
  return concat(MAGIC, Uint8Array.of(VERSION, flags), iv, ct);
}

export async function decryptContent(k: VolumeKeys, blob: Uint8Array): Promise<Plain> {
  if (!isEncryptedBlob(blob)) throw new Error("not an encrypted Fusion blob");
  if (blob[4] !== VERSION) throw new Error(`unsupported blob version ${blob[4]}`);
  const flags = blob[5];
  let payload: Uint8Array;
  try {
    payload = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bs(blob.subarray(6, 18)), additionalData: bs(contentAad(k, flags)) }, k.content, bs(blob.subarray(18))));
  } catch {
    throw new Error("authentication failed — wrong volume key or the file was modified on the host");
  }
  const len = new DataView(payload.buffer, payload.byteOffset).getUint32(0);
  const ml = payload[4];
  if (5 + ml + 1 + len > payload.length) throw new Error("payload length field inconsistent");
  const mime = dec.decode(payload.subarray(5, 5 + ml));
  const encoding = payload[5 + ml] === 1 ? "base64" : "utf8";
  const data = payload.slice(6 + ml, 6 + ml + len);
  wipe(payload);
  return { data, mime, encoding };
}

/* ------------------------------------------------------------------- names */
const NAME_AAD_PREFIX = "FNM1|";
export const isEncName = (seg: string) => seg.startsWith("~") && seg.length > 1;
/**
 * Entries the HOST stored in clear inside /Private (planted, or written by a pre-TT18 client) are shown
 * as "[clear] name" so they stay addressable and visibly unprotected; the prefix is reserved.
 */
export const CLEAR_PREFIX = "[clear] ";

export async function encryptName(k: VolumeKeys, name: string): Promise<string> {
  if (!name || name === "." || name === ".." || name.includes("/")) throw new Error(`illegal name: ${name}`);
  if (name.startsWith(CLEAR_PREFIX)) throw new Error(`names starting with "${CLEAR_PREFIX}" are reserved`);
  const pt = enc.encode(name.normalize("NFC"));
  if (pt.length > 180) throw new Error("name too long for encrypted storage (180 bytes)");
  const siv = new Uint8Array(await subtle().sign("HMAC", k.nameIv, bs(pt))).slice(0, 12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: bs(siv), additionalData: bs(concat(enc.encode(NAME_AAD_PREFIX), k.volumeId)) }, k.names, bs(pt)));
  return `~${toB64u(concat(siv, ct))}`;
}

export async function decryptName(k: VolumeKeys, seg: string): Promise<string> {
  if (!isEncName(seg)) throw new Error("not an encrypted name");
  const raw = fromB64u(seg.slice(1));
  if (raw.length < 12 + 16 + 1) throw new Error("encrypted name too short");
  const siv = raw.subarray(0, 12);
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bs(siv), additionalData: bs(concat(enc.encode(NAME_AAD_PREFIX), k.volumeId)) }, k.names, bs(raw.subarray(12))));
  } catch {
    throw new Error("name authentication failed");
  }
  // SIV consistency: the nonce must be the PRF of the plaintext (rejects host-chosen nonces).
  const expect = new Uint8Array(await subtle().sign("HMAC", k.nameIv, bs(pt))).subarray(0, 12);
  if (!expect.every((b, i) => b === siv[i])) throw new Error("name synthetic-IV mismatch");
  return dec.decode(pt);
}

export const isPrivatePath = (p: string) => p === PRIVATE_ROOT || p.startsWith(`${PRIVATE_ROOT}/`);

/** /Private/a/b.txt → /Private/~x/~y (the keyslot header keeps its reserved clear name). */
export async function encryptPath(k: VolumeKeys, p: string): Promise<string> {
  if (!isPrivatePath(p)) return p;
  const segs = p.slice(PRIVATE_ROOT.length).split("/").filter(Boolean);
  if (segs.length === 1 && segs[0] === KEYSLOT_FILE) return KEYSLOT_PATH;
  const out: string[] = [];
  for (const s of segs) out.push(isEncName(s) ? s : s.startsWith(CLEAR_PREFIX) ? s.slice(CLEAR_PREFIX.length) : await encryptName(k, s));
  return [PRIVATE_ROOT, ...out].join("/");
}

/** Inverse of encryptPath; segments that fail to authenticate are returned as-is and flagged. */
export async function decryptPath(k: VolumeKeys, p: string): Promise<{ path: string; ok: boolean }> {
  if (!isPrivatePath(p)) return { path: p, ok: true };
  const segs = p.slice(PRIVATE_ROOT.length).split("/").filter(Boolean);
  let ok = true;
  const out: string[] = [];
  for (const s of segs) {
    if (!isEncName(s)) { out.push(`${CLEAR_PREFIX}${s}`); ok = false; continue; }
    try { out.push(await decryptName(k, s)); } catch { out.push(s); ok = false; }
  }
  return { path: [PRIVATE_ROOT, ...out].join("/"), ok };
}
