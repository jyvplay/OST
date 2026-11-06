/**
 * TT136 (PR-01) — honest text decoding for the Editor and Peek.
 *
 * Before this module the reader assumed UTF-8 and produced replacement
 * characters for anything else. Here: BOM detection first, then a strict
 * decode attempt with a fatal decoder, then a bounded Latin-1 fallback that is
 * *labelled* as a guess. Nothing is silently repaired; an ambiguous file tells
 * the reader which encoding was chosen and why.
 *
 * Bounds: 8 MiB for decode (the VFS write cap), with a warning band before it.
 */

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "latin1";
export type Confidence = "bom" | "strict" | "heuristic";

export interface DecodeResult {
  text: string;
  encoding: Encoding;
  confidence: Confidence;
  bom: boolean;
  /** Characters the fallback had to interpret as single bytes. */
  lossy: boolean;
}

export const DECODE_LIMIT = 8 * 1024 * 1024;
export const WARN_BYTES = 2 * 1024 * 1024;

export function sizeClass(bytes: number): "ok" | "warn" | "refuse" {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("size must be a finite byte count");
  return bytes > DECODE_LIMIT ? "refuse" : bytes >= WARN_BYTES ? "warn" : "ok";
}

function strictDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bomOf(bytes: Uint8Array): { encoding: Encoding; length: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf-8", length: 3 };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf-16le", length: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf-16be", length: 2 };
  return null;
}

/**
 * BOM, then UTF-16 without a BOM when the NUL-byte pattern is unambiguous, then
 * strict UTF-8, then Latin-1 as an explicitly lossy last resort.
 */
export function decodeText(bytes: Uint8Array): DecodeResult {
  if (sizeClass(bytes.length) === "refuse") throw new Error("File is larger than the 8 MiB text limit");
  if (bytes.length === 0) return { text: "", encoding: "utf-8", confidence: "strict", bom: false, lossy: false };

  const bom = bomOf(bytes);
  if (bom) {
    const body = bytes.subarray(bom.length);
    const label = bom.encoding === "utf-8" ? "utf-8" : bom.encoding;
    const text = strictDecode(body, label);
    if (text !== null) return { text, encoding: bom.encoding, confidence: "bom", bom: true, lossy: false };
    // A BOM that its own decoder rejects is a truncated/corrupt file, not a guess opportunity.
    throw new Error("A byte-order mark was found but the rest of the file is not valid in that encoding");
  }

  // UTF-16 without BOM: count NULs in the even/odd positions of the first 4 KiB.
  const probe = Math.min(bytes.length, 4096);
  let evenZero = 0, oddZero = 0;
  for (let i = 0; i < probe; i++) { if (bytes[i] === 0) { if (i % 2 === 0) evenZero++; else oddZero++; } }
  const half = probe / 2;
  if (half >= 8 && oddZero > half * 0.3 && evenZero < half * 0.05) {
    const text = strictDecode(bytes, "utf-16le");
    if (text !== null && !text.includes("\uFFFD")) return { text, encoding: "utf-16le", confidence: "heuristic", bom: false, lossy: false };
  }
  if (half >= 8 && evenZero > half * 0.3 && oddZero < half * 0.05) {
    const text = strictDecode(bytes, "utf-16be");
    if (text !== null && !text.includes("\uFFFD")) return { text, encoding: "utf-16be", confidence: "heuristic", bom: false, lossy: false };
  }

  const utf8 = strictDecode(bytes, "utf-8");
  if (utf8 !== null) return { text: utf8, encoding: "utf-8", confidence: "strict", bom: false, lossy: false };

  // Latin-1 maps every byte to a code point; that is why it can never fail and
  // why its output must be flagged. Control bytes outside tab/newline suggest a
  // binary file rather than text, and we refuse instead of showing mojibake.
  const control = bytes.subarray(0, Math.min(bytes.length, 8192)).filter((b) => b < 0x09 || (b > 0x0d && b < 0x20)).length;
  if (control > 8) throw new Error("This looks like binary data, not text in a supported encoding");
  let text = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    text += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 4096)));
  }
  return { text, encoding: "latin1", confidence: "heuristic", bom: false, lossy: true };
}

export function encodeText(text: string, encoding: Encoding, withBom = false): Uint8Array {
  let body: Uint8Array;
  if (encoding === "latin1") {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0xff) throw new Error("Latin-1 can only store characters U+0000…U+00FF");
      out[i] = code;
    }
    body = out;
  } else if (encoding === "utf-8") {
    body = new TextEncoder().encode(text);
  } else {
    const view = new DataView(new ArrayBuffer(text.length * 2));
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), encoding === "utf-16le");
    body = new Uint8Array(view.buffer);
  }
  if (!withBom) return body;
  const prefix = encoding === "utf-8" ? [0xef, 0xbb, 0xbf] : encoding === "utf-16le" ? [0xff, 0xfe] : encoding === "utf-16be" ? [0xfe, 0xff] : [];
  if (!prefix.length) throw new Error("Latin-1 has no byte-order mark");
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0); out.set(body, prefix.length);
  return out;
}

/** Line-ending inventory: the Editor must not silently rewrite CRLF files. */
export function lineEndings(text: string): { crlf: number; lf: number; cr: number; dominant: "crlf" | "lf" | "cr" } {
  let crlf = 0, lf = 0, cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) { if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++; }
    else if (c === 10) lf++;
  }
  const dominant = crlf >= lf && crlf >= cr ? "crlf" : lf >= cr ? "lf" : "cr";
  return { crlf, lf, cr, dominant };
}

export function describeDecode(r: DecodeResult): string {
  const how = r.confidence === "bom" ? "byte-order mark" : r.confidence === "strict" ? "strict decode" : "guess";
  return `${r.encoding.toUpperCase()} via ${how}${r.lossy ? " — lossy, one byte per character" : ""}`;
}
