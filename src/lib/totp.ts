/**
 * One-time passwords, with no dependency and no `crypto.subtle`.
 *
 * RFC 4226 (HOTP) and RFC 6238 (TOTP) are small specifications with three traps that
 * every hand-rolled implementation falls into at least once:
 *
 *  1. the dynamic-truncation offset is `digest[19] & 0x0f`, not `digest[19]`,
 *     and the four bytes must be read as *unsigned* after masking bit 31;
 *  2. the counter is a **64-bit big-endian** integer, so a counter above 2^32 must
 *     still encode to 8 bytes (a JS `number` path silently truncates);
 *  3. verification must compare in constant time and must be given a drift window,
 *     because phone clocks and browser clocks disagree by more than one step in
 *     practice.
 *
 * SHA-1 is implemented here rather than borrowed for a mundane reason: `crypto.subtle`
 * is async and unavailable in a non-secure context, and a TOTP field that must be
 * verified on the first keystroke should not be a promise. The implementation is
 * checked against the FIPS 180-4 test vectors, RFC 2202 HMAC vectors, the RFC 4226
 * HOTP vectors and the RFC 6238 TOTP vectors in `scripts/tt151-time.mts`.
 */



function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** SHA-1 of `bytes`, returned as a 20-byte array. */
export function sha1(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  // 64-bit big-endian length; JS numbers keep 53 bits, and inputs here are documents,
  // not files, so the high word is written explicitly rather than assumed zero.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, hi);
  dv.setUint32(withPad.length - 4, lo);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3); odv.setUint32(16, h4);
  return out;
}

/** HMAC-SHA1 per RFC 2104. Keys longer than the block are hashed first. */
export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = 64;
  let k = key.length > block ? sha1(key) : key;
  const padded = new Uint8Array(block);
  padded.set(k);
  const inner = new Uint8Array(block + message.length);
  const outer = new Uint8Array(block + 20);
  for (let i = 0; i < block; i++) { inner[i] = padded[i] ^ 0x36; outer[i] = padded[i] ^ 0x5c; }
  inner.set(message, block);
  outer.set(sha1(inner), block);
  return sha1(outer);
}

/** 64-bit big-endian counter. Takes a number (safe up to 2^53) or a bigint. */
export function counterBytes(counter: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  if (typeof counter === "bigint") {
    dv.setBigUint64(0, counter);
  } else {
    if (!Number.isInteger(counter) || counter < 0) throw new Error("counter must be a non-negative integer");
    dv.setUint32(0, Math.floor(counter / 0x100000000));
    dv.setUint32(4, counter >>> 0);
  }
  return out;
}

const DIGITS = [6, 7, 8] as const;
export type Digits = (typeof DIGITS)[number];

/** RFC 4226 §5.3 dynamic truncation, then mod 10^digits. */
export function hotp(key: Uint8Array, counter: number | bigint, digits: Digits = 6): string {
  const mac = hmacSha1(key, counterBytes(counter));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  const code = binary % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export const TOTP_PERIOD = 30;

export interface TotpNow { code: string; counter: number; periodStartMs: number; remainingMs: number; remainingRatio: number }

/** TOTP code for an instant. `nowMs` is a parameter so this is testable. */
export function totp(key: Uint8Array, nowMs: number, opts: { period?: number; digits?: Digits } = {}): TotpNow {
  const period = opts.period ?? TOTP_PERIOD;
  if (!(period > 0)) throw new Error("period must be positive");
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / period);
  const periodStartMs = counter * period * 1000;
  const remainingMs = periodStartMs + period * 1000 - nowMs;
  return {
    code: hotp(key, counter, opts.digits ?? 6),
    counter,
    periodStartMs,
    remainingMs,
    remainingRatio: remainingMs / (period * 1000),
  };
}

export interface TotpVerify { ok: boolean; drift?: number; reason?: string }

/**
 * Verify a submitted code against a ±`window` step window.
 *
 * The comparison is over all candidates without early exit, so the time taken does not
 * depend on which step matched (the classic timing leak in "check the current code
 * first, return" implementations).
 */
export function verifyTotp(
  key: Uint8Array,
  submitted: string,
  nowMs: number,
  opts: { period?: number; digits?: Digits; window?: number } = {},
): TotpVerify {
  const digits = opts.digits ?? 6;
  const window = opts.window ?? 1;
  const clean = submitted.replace(/[\s-]/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return { ok: false, reason: `expected ${digits} digits` };
  const period = opts.period ?? TOTP_PERIOD;
  const counter = Math.floor(Math.floor(nowMs / 1000) / period);
  let matched: number | undefined;
  for (let d = -window; d <= window; d++) {
    const candidate = counter + d;
    if (candidate < 0) continue;
    // No early `break`: every step in the window is compared.
    if (constantTimeEqualString(hotp(key, candidate, digits), clean)) matched = d;
  }
  if (matched === undefined) return { ok: false, reason: `no match within ±${window} steps` };
  return { ok: true, drift: matched };
}

function constantTimeEqualString(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. Throws on any character outside the alphabet. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) throw new Error("empty secret");
  let bits = 0, value = 0, pos = 0;
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`"${ch}" is not base32`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out[pos++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  // Leftover bits must be zero padding, otherwise the secret was mistyped.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) throw new Error("trailing bits are not zero padding");
  return out;
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export interface OtpAuthParams {
  secret: Uint8Array;
  account: string;
  issuer?: string;
  digits?: number;
  period?: number;
  algorithm?: "SHA1";
}

export function buildOtpAuthUri(p: OtpAuthParams): string {
  const label = p.issuer ? `${encodeURIComponent(p.issuer)}:${encodeURIComponent(p.account)}` : encodeURIComponent(p.account);
  const q = new URLSearchParams();
  q.set("secret", base32Encode(p.secret));
  if (p.issuer) q.set("issuer", p.issuer);
  if (p.digits && p.digits !== 6) q.set("digits", String(p.digits));
  if (p.period && p.period !== 30) q.set("period", String(p.period));
  if (p.algorithm && p.algorithm !== "SHA1") q.set("algorithm", p.algorithm);
  return `otpauth://totp/${label}?${q.toString()}`;
}

export interface ParsedOtpAuth { ok: true; secret: Uint8Array; account: string; issuer?: string; digits: number; period: number; algorithm: string }

/** Parses the `otpauth://totp/...` form only; HOTP counters are refused rather than guessed. */
export function parseOtpAuthUri(uri: string): ParsedOtpAuth | { ok: false; error: string } {
  let url: URL;
  try { url = new URL(uri); } catch { return { ok: false, error: "not a URI" }; }
  if (url.protocol !== "otpauth:") return { ok: false, error: "not an otpauth: URI" };
  if (url.hostname.toLowerCase() !== "totp") return { ok: false, error: `"${url.hostname}" accounts need a counter; only totp is supported` };
  const secretRaw = url.searchParams.get("secret");
  if (!secretRaw) return { ok: false, error: "no secret parameter" };
  let secret: Uint8Array;
  try { secret = base32Decode(secretRaw); } catch (e) { return { ok: false, error: `secret: ${(e as Error).message}` }; }
  let label: string;
  try { label = decodeURIComponent(url.pathname.replace(/^\//, "")); }
  catch { return { ok: false, error: "invalid label encoding" }; }
  const [labelIssuer, ...rest] = label.includes(":") ? label.split(":") : [undefined, label];
  const account = (label.includes(":") ? rest.join(":") : labelIssuer ?? label).trim();
  if (!account) return { ok: false, error: "no account label" };
  const issuer = url.searchParams.get("issuer") ?? labelIssuer;
  if (labelIssuer && url.searchParams.get("issuer") && labelIssuer !== url.searchParams.get("issuer")) {
    return { ok: false, error: "label issuer and issuer parameter disagree" };
  }
  const digits = Number(url.searchParams.get("digits") ?? 6);
  if (!DIGITS.includes(digits as Digits)) return { ok: false, error: `digits ${digits} is not 6, 7 or 8` };
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!Number.isInteger(period) || period <= 0 || period > 300) return { ok: false, error: `period ${period} is outside 1–300 s` };
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (algorithm !== "SHA1") return { ok: false, error: `${algorithm} needs a digest this build does not carry` };
  return { ok: true, secret, account: account.trim(), issuer: issuer?.trim(), digits, period, algorithm };
}

/** Decodes a secret the way people paste it: spaces, dashes and case are forgiven. */
export function normaliseSecret(pasted: string): { ok: true; bytes: Uint8Array; base32: string } | { ok: false; error: string } {
  try {
    const bytes = base32Decode(pasted);
    return { ok: true, bytes, base32: base32Encode(bytes) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}


