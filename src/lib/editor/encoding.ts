/**
 * TT146 (PR-01) — text encodings, decided by evidence instead of hope.
 *
 * A browser hands you bytes. `TextDecoder("utf-8")` silently replaces every
 * invalid sequence with U+FFFD, so a Windows-1252 file opens as a wall of
 * replacement characters and the user's first keystroke saves it that way —
 * destroying the original. The editor therefore has to answer three questions
 * before it shows anything:
 *
 *   1. **What encoding is this?** BOM first (authoritative), then the
 *      every-other-byte-NUL pattern that is the only reliable tell for BOM-less
 *      UTF-16, then a *strict* UTF-8 validity check (`fatal: true`), and only
 *      then Windows-1252 — which can represent every byte, so it is the floor of
 *      the decision, never a guess made early.
 *   2. **How much was lost?** A decode that replaced characters is reported, and
 *      a re-encode that cannot represent a character reports how many were
 *      replaced. Saving is never allowed to hide that.
 *   3. **Is this file too big to load as one string?** A 200 MiB file read with
 *      `File.text()` freezes the tab and then throws. The plan is stated up
 *      front so the editor can page instead.
 *
 * Windows-1252 is not Latin-1: 0x80–0x9F are printable characters in 1252 and
 * control characters in Latin-1. Treating them as the same is the second most
 * common cause of mojibake after ignoring the BOM.
 */

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export const ENCODING_LABEL: Record<Encoding, string> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "windows-1252": "Windows-1252",
};

/** The 0x80–0x9F block of Windows-1252 (the part that differs from Latin-1). */
const CP1252_HIGH: Record<number, string> = {
  0x80: "\u20AC", 0x82: "\u201A", 0x83: "\u0192", 0x84: "\u201E", 0x85: "\u2026", 0x86: "\u2020", 0x87: "\u2021",
  0x88: "\u02C6", 0x89: "\u2030", 0x8a: "\u0160", 0x8b: "\u2039", 0x8c: "\u0152", 0x8e: "\u017D",
  0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201C", 0x94: "\u201D", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
  0x98: "\u02DC", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203A", 0x9c: "\u0153", 0x9e: "\u017E", 0x9f: "\u0178",
};
const CP1252_REVERSE: Map<string, number> = new Map(
  [...Object.entries(CP1252_HIGH).map(([k, v]) => [v, Number(k)] as [string, number]),
    ...Array.from({ length: 0x80 }, (_, i) => [String.fromCharCode(i), i] as [string, number]),
    ...Array.from({ length: 0x60 }, (_, i) => [String.fromCharCode(0xa0 + i), 0xa0 + i] as [string, number])],
);

const BOM_UTF8 = [0xef, 0xbb, 0xbf];

/** Strict UTF-8 validity, independent of TextDecoder's default leniency. */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function sniffEncoding(bytes: Uint8Array): Encoding {
  if (bytes.length >= 3 && bytes[0] === BOM_UTF8[0] && bytes[1] === BOM_UTF8[1] && bytes[2] === BOM_UTF8[2]) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  // BOM-less UTF-16: text in ASCII range puts a NUL in every other byte. Sample
  // the first 4 KiB, because a file can be large and a prefix is enough.
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let evenNul = 0, oddNul = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) (i % 2 === 0 ? evenNul++ : oddNul++);
  const half = sample.length / 2;
  const threshold = Math.max(2, half * 0.4);
  if (sample.length >= 4 && oddNul >= threshold && evenNul < half * 0.05) return "utf-16le";
  if (sample.length >= 4 && evenNul >= threshold && oddNul < half * 0.05) return "utf-16be";
  if (isValidUtf8(bytes)) return "utf-8";
  return "windows-1252";
}

export interface DecodeResult {
  text: string;
  encoding: Encoding;
  /** A byte-order mark was present and removed from the text. */
  bom: boolean;
  /** U+FFFD characters the decoder had to invent (0 for the 1252 path). */
  replacementChars: number;
}

export function decodeText(bytes: Uint8Array, encoding: Encoding = sniffEncoding(bytes)): DecodeResult {
  let body = bytes;
  let bom = false;
  if (encoding === "utf-8" && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { body = bytes.subarray(3); bom = true; }
  else if (encoding === "utf-16le" && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { body = bytes.subarray(2); bom = true; }
  else if (encoding === "utf-16be" && bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { body = bytes.subarray(2); bom = true; }

  if (encoding === "windows-1252") {
    let out = "";
    for (const b of body) out += CP1252_HIGH[b] ?? String.fromCharCode(b);
    return { text: out, encoding, bom, replacementChars: 0 };
  }
  const label = encoding === "utf-16le" ? "utf-16le" : encoding === "utf-16be" ? "utf-16be" : "utf-8";
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: false }).decode(body);
  } catch {
    // An engine without UTF-16 decoding degrades to a byte-preserving read.
    text = Array.from(body).map((b) => String.fromCharCode(b)).join("");
  }
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  return { text, encoding, bom, replacementChars };
}

export interface EncodeResult {
  bytes: Uint8Array;
  encoding: Encoding;
  /** At least one character could not be represented and was replaced with "?". */
  lossy: boolean;
  replaced: number;
}

/**
 * Encode for saving. `windows-1252` is the interesting case: it cannot hold
 * most of Unicode, so the count of replaced characters is returned and the
 * caller must show it before writing.
 */
export function encodeText(text: string, encoding: Encoding): EncodeResult {
  if (encoding === "utf-8") return { bytes: new TextEncoder().encode(text), encoding, lossy: false, replaced: 0 };
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (encoding === "utf-16le") { bytes[i * 2] = code & 0xff; bytes[i * 2 + 1] = code >> 8; }
      else { bytes[i * 2] = code >> 8; bytes[i * 2 + 1] = code & 0xff; }
    }
    return { bytes, encoding, lossy: false, replaced: 0 };
  }
  const out: number[] = [];
  let replaced = 0;
  for (const ch of text) {
    const b = CP1252_REVERSE.get(ch);
    if (b === undefined) { out.push(0x3f); replaced++; }
    else out.push(b);
  }
  return { bytes: new Uint8Array(out), encoding, lossy: replaced > 0, replaced };
}

/* ------------------------------------------------------------------ large files */

export const WHOLE_LIMIT = 2 << 20;
export const CHUNKED_LIMIT = 128 << 20;
export const CHUNK_BYTES = 1 << 20;

export interface LargeFilePlan {
  strategy: "whole" | "chunked" | "refuse";
  chunkBytes: number;
  /** How many chunks a chunked load would make (0 for whole, -1 for refuse). */
  chunks: number;
  reason: string;
}

/**
 * Decide how to open a file before opening it. The numbers are deliberately
 * conservative: a 2 MiB string is trivial, a 128 MiB one is not, and the editor
 * has no virtualised text model, so it says so instead of pretending.
 */
export function planLargeFile(size: number): LargeFilePlan {
  if (!Number.isFinite(size) || size < 0) throw new Error("size must be a non-negative number of bytes");
  if (size <= WHOLE_LIMIT) return { strategy: "whole", chunkBytes: size, chunks: 1, reason: `${size} bytes read in one piece` };
  if (size <= CHUNKED_LIMIT) {
    const chunks = Math.ceil(size / CHUNK_BYTES);
    return { strategy: "chunked", chunkBytes: CHUNK_BYTES, chunks, reason: `${size} bytes read in ${chunks} × ${CHUNK_BYTES}-byte chunks` };
  }
  return { strategy: "refuse", chunkBytes: 0, chunks: -1, reason: `${size} bytes exceeds the ${CHUNKED_LIMIT}-byte editor limit; use Files to split or Peek to inspect` };
}
