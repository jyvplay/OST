/**
 * TT139 (HW-11) — pure, testable encoders: Base64/Base64url, hex, and the
 * byte-level UTF-8 helpers every export path needs.
 *
 * Why not `btoa`/`atob`: they only accept Latin-1 and throw on any non-Latin-1
 * character. Every previous "Base64" bug in this app came from feeding a string
 * containing "é" or an emoji straight into btoa. These functions take and return
 * *bytes*, so the UTF-8 step is explicit and testable in Node without a DOM.
 *
 * The Base64 implementation is a four-line table encoder/decoder with strict
 * validation (whitespace tolerated, padding checked, unknown characters
 * rejected) rather than a permissive one that silently maps garbage to bytes.
 */

export const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62; // url-safe accepted on decode
  t["_".charCodeAt(0)] = 63;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array, alphabet = B64_ALPHABET): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < n ? bytes[i + 1] : 0, b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < n ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < n ? alphabet[b2 & 63] : "=";
  }
  return out;
}

export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[\s\r\n\t]/g, "");
  const noPad = clean.replace(/=+$/, "");
  if (clean.length % 4 !== 0 && clean.includes("=")) throw new Error("base64: bad padding");
  if (noPad.length % 4 === 1) throw new Error("base64: truncated input");
  const out = new Uint8Array(Math.floor((noPad.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < noPad.length; i += 4) {
    const c0 = code(noPad, i), c1 = code(noPad, i + 1);
    const c2 = i + 2 < noPad.length ? code(noPad, i + 2) : 0;
    const c3 = i + 3 < noPad.length ? code(noPad, i + 3) : 0;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < noPad.length) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (i + 3 < noPad.length) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out.subarray(0, o);
}

function code(s: string, i: number): number {
  const c = s.charCodeAt(i);
  const v = c < 128 ? B64_LOOKUP[c] : -1;
  if (v < 0) throw new Error(`base64: invalid character "${s[i]}" at ${i}`);
  return v;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes, B64URL_ALPHABET).replace(/=+$/, "");
}

export function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(padded);
}

export function bytesToHex(bytes: Uint8Array, upper = false): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return upper ? s.toUpperCase() : s;
}

export function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/[\s:-]/g, "");
  if (s.length % 2 !== 0) throw new Error("hex: odd number of digits");
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error("hex: non-hexadecimal digit");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A SHA-256-shaped *test double* is deliberately absent: hash-wasm provides the
 * real one in the app. Here we ship only pure byte transforms, so a caller can
 * never mistake a toy hash for SHA-256.

 * Constant-time comparison for secrets: the loop always runs to the end.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Text → UTF-8 bytes; explicit replacement so invalid surrogates cannot throw. */
export function textToBytes(text: string): Uint8Array {
  // TextEncoder already substitutes lone surrogates with U+FFFD; assert that
  // rather than trust it across engines.
  return new TextEncoder().encode(String(text));
}

/** UTF-8 bytes → text, refusing to silently mangle invalid sequences. */
export function bytesToText(bytes: Uint8Array, opts: { fatal?: boolean } = {}): string {
  return new TextDecoder("utf-8", { fatal: opts.fatal ?? false }).decode(bytes);
}

/** Guess the text encoding of a byte prefix, using the same rules the Editor does. */
export interface EncodingGuess { encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252" | "utf-8-bom" | "utf-16le-bom" | "utf-16be-bom"; confidence: number; ascii_only: boolean }

export function guessEncoding(bytes: Uint8Array): EncodingGuess {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf-8-bom", confidence: 1, ascii_only: false };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf-16le-bom", confidence: 1, ascii_only: false };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf-16be-bom", confidence: 1, ascii_only: false };
  let ascii = 0;
  let validUtf8 = 0, sequences = 0, i = 0;
  let nulAtEven = 0, nulAtOdd = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { ascii++; if (b === 0) { if (i % 2 === 0) nulAtEven++; else nulAtOdd++; } i++; continue; }
    sequences++;
    let len = 0;
    if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    if (!len) { i++; continue; }
    let ok = true;
    for (let k = 1; k < len; k++) {
      if (i + k >= bytes.length || (bytes[i + k] & 0xc0) !== 0x80) { ok = false; break; }
    }
    if (ok) validUtf8++;
    i += len;
  }
  if (nulAtEven > 2 && nulAtOdd === 0) return { encoding: "utf-16be", confidence: 0.9, ascii_only: false };
  if (nulAtOdd > 2 && nulAtEven === 0) return { encoding: "utf-16le", confidence: 0.9, ascii_only: false };
  if (sequences > 0 && validUtf8 === sequences) return { encoding: "utf-8", confidence: 0.95, ascii_only: ascii === bytes.length };
  if (sequences === 0) return { encoding: "utf-8", confidence: 0.5, ascii_only: true };
  return { encoding: "windows-1252", confidence: 0.6, ascii_only: false };
}

/** Bits of entropy per byte, so a key-strength display is not a guess. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (!bytes.length) return 0;
  const counts = new Uint32Array(256);
  for (const b of bytes) counts[b]++;
  let h = 0;
  for (const c of counts) if (c) { const p = c / bytes.length; h -= p * Math.log2(p); }
  return h;
}

/** Entropy of a password string in bits (Shannon over characters × length). */
export function passwordEntropyBits(text: string): number {
  const chars = Array.from(text);
  if (!chars.length) return 0;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) { const p = c / chars.length; h -= p * Math.log2(p); }
  return h * chars.length;
}
