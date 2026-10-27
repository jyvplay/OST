/**
 * General-backup recovery envelope. This is a new, application-specific format,
 * not an age/restic file. Both slots wrap the same random data key. The complete
 * header is authenticated by the data tag, including the *other* slot, so a
 * damaged slot cannot silently pass when opening via the surviving slot.
 * Browser secrets never need to be sent to the server. JS cannot guarantee zeroization.
 */
import { canonicalJson, MAX_BACKUP_BYTES } from "./bundle";
import { fromB64, toB64 } from "../crypto";

export const RECOVERY_FORMAT = "fusion-recovery-bundle-1" as const;
const ITERATIONS = 600_000;
const MIN_ITERATIONS = 600_000;
const MAX_ITERATIONS = 2_000_000;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const keys = ["format", "cipher", "kdf", "iterations", "salt", "passIv", "passWrapped", "recoveryIv", "recoveryWrapped", "dataIv", "data"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bs = (a: Uint8Array): BufferSource => a as BufferSource;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const passAad = (iterations: number) => enc.encode(`${RECOVERY_FORMAT}|passphrase|PBKDF2-SHA256|${iterations}`);
const recoveryAad = enc.encode(`${RECOVERY_FORMAT}|recovery|AES-GCM-256`);

export interface RecoveryBundle {
  format: typeof RECOVERY_FORMAT;
  cipher: "AES-GCM-256";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  passIv: string;
  passWrapped: string;
  recoveryIv: string;
  recoveryWrapped: string;
  dataIv: string;
  data: string;
}

type Header = Omit<RecoveryBundle, "data">;
const headerOf = (b: RecoveryBundle): Header => ({
  format: b.format, cipher: b.cipher, kdf: b.kdf, iterations: b.iterations, salt: b.salt,
  passIv: b.passIv, passWrapped: b.passWrapped, recoveryIv: b.recoveryIv, recoveryWrapped: b.recoveryWrapped, dataIv: b.dataIv,
});
const headerAad = (b: Header) => enc.encode(canonicalJson(b));

/** 32 random bytes (256 bits), presented in eight human-copyable hex groups. */
export function makeRecoveryKey(): string {
  if (!globalThis.crypto?.subtle) throw new Error("Secure-context Web Crypto is unavailable.");
  const raw = random(32);
  try {
    const hex = Array.from(raw, (n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
    return `FSR1-${hex.match(/.{8}/g)!.join("-")}`;
  } finally { raw.fill(0); }
}

/** Case-insensitive but deliberately rejects missing, extra or malformed groups. */
export function normalizeRecoveryKey(input: string): string {
  const value = input.trim().toUpperCase();
  if (!/^FSR1(?:-[0-9A-F]{8}){8}$/.test(value)) throw new Error("Recovery key must be FSR1 followed by eight groups of eight hexadecimal characters.");
  return value;
}
function recoveryBytes(input: string): Uint8Array {
  const hex = normalizeRecoveryKey(input).slice(5).replaceAll("-", "");
  return Uint8Array.from(hex.match(/../g)!, (n) => parseInt(n, 16));
}
async function aesKey(raw: Uint8Array, usage: KeyUsage[]) {
  return crypto.subtle.importKey("raw", bs(raw), { name: "AES-GCM" }, false, usage);
}
async function passwordKey(pass: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]) {
  if (!pass) throw new Error("A passphrase is required.");
  const base = await crypto.subtle.importKey("raw", bs(enc.encode(pass)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: bs(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, usage);
}
async function encrypt(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad) }, key, bs(bytes)));
}
async function decrypt(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad) }, key, bs(bytes)));
}

/** Validate encoded lengths and canonical padding BEFORE base64 decoding or KDF work. */
function checkEncoding(value: unknown, label: string, min: number, max: number): asserts value is string {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || !base64.test(value)) throw new Error(`Invalid ${label}.`);
  if (value.endsWith("==") && alphabet.indexOf(value[value.length - 3]) % 16 !== 0) throw new Error(`Invalid ${label}.`);
  if (value.endsWith("=") && !value.endsWith("==") && alphabet.indexOf(value[value.length - 2]) % 4 !== 0) throw new Error(`Invalid ${label}.`);
  const size = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (size < min || size > max) throw new Error(`Invalid ${label} length.`);
}
function bytes(value: unknown, label: string, min: number, max: number): Uint8Array {
  checkEncoding(value, label, min, max);
  return fromB64(value);
}
function validate(value: unknown): RecoveryBundle {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every((k) => Object.hasOwn(value, k))
    || value.format !== RECOVERY_FORMAT || value.cipher !== "AES-GCM-256" || value.kdf !== "PBKDF2-SHA256"
    || !Number.isSafeInteger(value.iterations) || (value.iterations as number) < MIN_ITERATIONS || (value.iterations as number) > MAX_ITERATIONS) {
    throw new Error("Invalid recovery bundle header.");
  }
  bytes(value.salt, "salt", 16, 16);
  bytes(value.passIv, "passphrase IV", 12, 12);
  bytes(value.passWrapped, "passphrase slot", 48, 48);
  bytes(value.recoveryIv, "recovery IV", 12, 12);
  bytes(value.recoveryWrapped, "recovery slot", 48, 48);
  bytes(value.dataIv, "data IV", 12, 12);
  checkEncoding(value.data, "ciphertext", 16, MAX_BACKUP_BYTES + 16);
  return value as unknown as RecoveryBundle;
}

export async function sealRecoveryBundle(plain: string, pass: string, recovery: string): Promise<RecoveryBundle> {
  const content = enc.encode(plain);
  if (content.length > MAX_BACKUP_BYTES) throw new Error("Snapshot exceeds the backup size limit.");
  if (pass.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const recoveryRaw = recoveryBytes(recovery), dataRaw = random(32);
  try {
    const salt = random(16), passIv = random(12), recoveryIv = random(12), dataIv = random(12);
    const passKey = await passwordKey(pass, salt, ITERATIONS, ["encrypt"]);
    const recoveryKey = await aesKey(recoveryRaw, ["encrypt"]);
    const passWrapped = await encrypt(passKey, passIv, passAad(ITERATIONS), dataRaw);
    const recoveryWrapped = await encrypt(recoveryKey, recoveryIv, recoveryAad, dataRaw);
    const header: Header = { format: RECOVERY_FORMAT, cipher: "AES-GCM-256", kdf: "PBKDF2-SHA256", iterations: ITERATIONS,
      salt: toB64(salt), passIv: toB64(passIv), passWrapped: toB64(passWrapped), recoveryIv: toB64(recoveryIv),
      recoveryWrapped: toB64(recoveryWrapped), dataIv: toB64(dataIv) };
    const dataKey = await aesKey(dataRaw, ["encrypt"]);
    return { ...header, data: toB64(await encrypt(dataKey, dataIv, headerAad(header), content)) };
  } finally { recoveryRaw.fill(0); dataRaw.fill(0); content.fill(0); }
}

export async function openRecoveryBundle(value: unknown, method: "passphrase" | "recovery", secret: string): Promise<string> {
  const b = validate(value);
  let keyBytes: Uint8Array | null = null, rawRecovery: Uint8Array | null = null;
  try {
    if (method === "passphrase") {
      const key = await passwordKey(secret, bytes(b.salt, "salt", 16, 16), b.iterations, ["decrypt"]);
      keyBytes = await decrypt(key, bytes(b.passIv, "passphrase IV", 12, 12), passAad(b.iterations), bytes(b.passWrapped, "passphrase slot", 48, 48));
    } else if (method === "recovery") {
      rawRecovery = recoveryBytes(secret);
      const key = await aesKey(rawRecovery, ["decrypt"]);
      keyBytes = await decrypt(key, bytes(b.recoveryIv, "recovery IV", 12, 12), recoveryAad, bytes(b.recoveryWrapped, "recovery slot", 48, 48));
    } else throw new Error("Unknown unlock method.");
    if (keyBytes.length !== 32) throw new Error("Invalid data key.");
    const dataKey = await aesKey(keyBytes, ["decrypt"]);
    const plain = await decrypt(dataKey, bytes(b.dataIv, "data IV", 12, 12), headerAad(headerOf(b)), bytes(b.data, "ciphertext", 16, MAX_BACKUP_BYTES + 16));
    try { return dec.decode(plain); } finally { plain.fill(0); }
  } catch (e) {
    if (method === "recovery" && !rawRecovery) throw e; // explain a malformed key without echoing it
    throw new Error("Authentication failed: wrong key or modified recovery bundle.");
  } finally { rawRecovery?.fill(0); keyBytes?.fill(0); }
}
