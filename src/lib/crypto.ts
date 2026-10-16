/**
 * Shared WebCrypto envelope (SC-07 encrypted containers, BK-01 encrypted bundles).
 * Same code runs in the browser and in Node ≥ 20 (globalThis.crypto.subtle), so
 * the unit suite tests exactly what the UI executes.
 *
 * Format "fusion-envelope-1": PBKDF2-HMAC-SHA256 (600 000 iterations, 16-byte
 * random salt) → AES-GCM-256 (12-byte random IV). The header fields (format,
 * kdf, iterations) are bound as AES-GCM additional data, so changing the
 * declared iteration count or format invalidates the tag — a downgrade attack
 * on the header is detected, not silently accepted.
 */
export interface Envelope {
  format: "fusion-envelope-1";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  cipher: "AES-GCM-256";
  salt: string;
  iv: string;
  data: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const DEFAULT_ITERATIONS = 600_000;

export const toB64 = (u8: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const aad = (iterations: number) => enc.encode(`fusion-envelope-1|PBKDF2-SHA256|${iterations}|AES-GCM-256`);

async function derive(pass: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]) {
  if (!pass) throw new Error("empty passphrase");
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, usage,
  );
}

export async function seal(plain: Uint8Array, pass: string, iterations = DEFAULT_ITERATIONS): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(pass, salt, iterations, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(iterations) as BufferSource }, key, plain as BufferSource,
  ));
  return { format: "fusion-envelope-1", kdf: "PBKDF2-SHA256", iterations, cipher: "AES-GCM-256", salt: toB64(salt), iv: toB64(iv), data: toB64(ct) };
}

export async function open(env: Envelope, pass: string): Promise<Uint8Array> {
  if (env.format !== "fusion-envelope-1") throw new Error(`unknown envelope format ${String(env.format)}`);
  // Floor on the work factor: an attacker-edited header asking for 1 iteration
  // is refused before any key derivation, independent of the AAD check.
  if (!Number.isInteger(env.iterations) || env.iterations < 100_000) throw new Error("iteration count below policy floor");
  const key = await derive(pass, fromB64(env.salt), env.iterations, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(env.iv) as BufferSource, additionalData: aad(env.iterations) as BufferSource },
      key, fromB64(env.data) as BufferSource,
    ));
  } catch {
    throw new Error("authentication failed — wrong passphrase or the envelope was modified");
  }
}

export const sealText = (text: string, pass: string, it?: number) => seal(enc.encode(text), pass, it);
export const openText = async (env: Envelope, pass: string) => dec.decode(await open(env, pass));
