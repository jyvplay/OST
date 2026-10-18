/**
 * TT39: WebSocket compression — the permessage-deflate extension (RFC 7692), for the proxy's WebSocket client
 * (ws-client.ts). Original code written from RFC 7692 using Node's built-in zlib (no third-party code).
 *
 * Offer (what browsers send):  Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits
 * The server's answer is validated strictly (§7): exactly one permessage-deflate element; only the four defined
 * parameters, each at most once; window bits 8..15 (a plain or quoted decimal without leading zeros);
 * client_max_window_bits only because we offered it. Anything else fails the handshake.
 *
 * Receiving: a message whose first frame has RSV1 set is compressed. Its payload + 00 00 FF FF is inflated with a
 * context kept across messages (windowBits 15 accepts any server window). The decompressed size is capped while it
 * is produced (a "zip bomb" stops at the cap → 1009); corrupt data → 1007.
 * Sending: deflate with a sync flush and strip the trailing 00 00 FF FF (§7.2.1).
 *
 * TT41 — a server limiting our window to 8 bits (client_max_window_bits=8) now gets COMPRESSED messages. zlib has no
 * raw 256-byte window (deflateInit2 turns raw windowBits 8 into 9, "until 256-byte window bug fixed"), but zlib never
 * emits a distance above MAX_DIST = w_size − MIN_LOOKAHEAD = 2^w − (258 + 3 + 1): every distance it tallies comes
 * from longest_match (chain walk limited by MAX_DIST) after a hash_head ≤ MAX_DIST check, or is 1 (deflate_rle).
 * For w = 9 that is 512 − 262 = 250 ≤ 256, so a 9-bit stream IS a valid 8-bit stream (checked in Node's bundled
 * deps/zlib/deflate.c of v22.22.3: lines 1448–1449, 1969, 2093, 2231; deflate.h 312/317). Verified on the wire by
 * an independent DEFLATE decoder that records every distance (scripts/oracle/deflate-audit.mts): 108 level / memLevel
 * / strategy combinations with context takeover → max distance 240. Guarded: only on the classic zlib lineage the
 * argument was checked on (a zlib-ng build would fall back to uncompressed messages for 8 bits).
 */
import * as zlib from "node:zlib";

export const DEFLATE_OFFER = "permessage-deflate; client_max_window_bits";
/** the zlib whose MAX_DIST bound was checked (madler / Chromium 1.x lineage, not zlib-ng) */
export const ZLIB_MAX_DIST_CHECKED = /^1\.\d/.test(process.versions.zlib ?? "") && !/ng/i.test(process.versions.zlib ?? "");
/** the raw windowBits zlib is given for a negotiated window: 8 → 9, whose distances stay ≤ 250 (see above) */
export function deflateWindowBits(negotiated: number): number { return Math.max(9, negotiated); }
export interface DeflateParams { serverNoContextTakeover: boolean; clientNoContextTakeover: boolean; serverMaxWindowBits: number; clientMaxWindowBits: number }

/** Split a header value into extension elements → [name, params[]], honouring quoted strings. */
function elements(v: string): { name: string; params: [string, string | null][] }[] {
  const out: { name: string; params: [string, string | null][] }[] = [];
  let i = 0;
  const ws = () => { while (i < v.length && (v[i] === " " || v[i] === "\t")) i++; };
  const token = () => { const m = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.exec(v.slice(i)); if (!m) throw new Error(`bad token in extension header at ${i}`); i += m[0].length; return m[0]; };
  while (i < v.length) {
    ws();
    const name = token().toLowerCase(); const params: [string, string | null][] = [];
    ws();
    while (v[i] === ";") {
      i++; ws();
      const k = token().toLowerCase(); ws();
      let val: string | null = null;
      if (v[i] === "=") {
        i++; ws();
        if (v[i] === '"') {
          i++; let s = "";
          while (i < v.length && v[i] !== '"') { if (v[i] === "\\") i++; s += v[i++] ?? ""; }
          if (v[i] !== '"') throw new Error("unterminated quoted string in extension header");
          i++; val = s;
        } else val = token();
        ws();
      }
      params.push([k, val]);
    }
    out.push({ name, params });
    ws();
    if (i < v.length) { if (v[i] !== ",") throw new Error(`unexpected '${v[i]}' in extension header`); i++; }
  }
  return out;
}

/** Validate the server's Sec-WebSocket-Extensions answer to DEFLATE_OFFER. Throws with a plain reason. */
export function parseDeflateResponse(value: string): DeflateParams {
  const els = elements(value);
  if (els.length !== 1 || els[0].name !== "permessage-deflate") throw new Error(`the server chose an extension that was not offered (${value.slice(0, 60)})`);
  const p: DeflateParams = { serverNoContextTakeover: false, clientNoContextTakeover: false, serverMaxWindowBits: 15, clientMaxWindowBits: 15 };
  const seen = new Set<string>();
  for (const [k, v] of els[0].params) {
    if (seen.has(k)) throw new Error(`permessage-deflate: duplicate parameter ${k}`);
    seen.add(k);
    const bits = () => { if (v === null || !/^(8|9|1[0-5])$/.test(v)) throw new Error(`permessage-deflate: ${k} must be 8..15 (got ${v === null ? "no value" : JSON.stringify(v.slice(0, 10))})`); return Number(v); };
    if (k === "server_no_context_takeover" || k === "client_no_context_takeover") {
      if (v !== null) throw new Error(`permessage-deflate: ${k} takes no value`);
      if (k === "server_no_context_takeover") p.serverNoContextTakeover = true; else p.clientNoContextTakeover = true;
    } else if (k === "server_max_window_bits") p.serverMaxWindowBits = bits();
    else if (k === "client_max_window_bits") p.clientMaxWindowBits = bits(); // a value is required in a response (§7.1.2.2)
    else throw new Error(`permessage-deflate: unknown parameter ${k}`);
  }
  return p;
}

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
export class DeflateError extends Error { code: number; constructor(code: number, m: string) { super(m); this.code = code; } }

/** One connection's compression state. Calls are serialised by the caller (one at a time per direction). */
export class PerMessageDeflate {
  readonly params: DeflateParams;
  private inflater: zlib.InflateRaw | null = null;
  private deflater: zlib.DeflateRaw | null = null;
  private readonly maxMessage: number;
  /** messages shorter than this go uncompressed (the header overhead would outweigh the saving) */
  readonly threshold: number;
  constructor(params: DeflateParams, maxMessage: number, threshold = 64) { this.params = params; this.maxMessage = maxMessage; this.threshold = threshold; }
  get canCompress(): boolean { return this.params.clientMaxWindowBits >= 9 || ZLIB_MAX_DIST_CHECKED; }

  /** Inflate one compressed message (the concatenated frame payloads). */
  inflate(data: Buffer): Promise<Buffer> {
    if (!this.inflater || this.params.serverNoContextTakeover) { this.inflater?.close(); this.inflater = zlib.createInflateRaw({ windowBits: 15 }); }
    const inf = this.inflater, max = this.maxMessage;
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = []; let size = 0, settled = false;
      const end = (e: Error | null) => {
        if (settled) return; settled = true;
        inf.off("data", onData); inf.off("error", onErr);
        if (e) { inf.close(); if (this.inflater === inf) this.inflater = null; reject(e); } else resolve(Buffer.concat(parts, size));
      };
      const onData = (c: Buffer) => {
        size += c.length;
        if (size > max) { end(new DeflateError(1009, `decompressed message exceeds the ${max}-byte cap`)); return; }
        parts.push(c);
      };
      const onErr = (e: Error) => end(new DeflateError(1007, `invalid compressed data: ${e.message}`));
      inf.on("data", onData); inf.on("error", onErr);
      inf.write(data);
      inf.write(TAIL);
      inf.flush(zlib.constants.Z_SYNC_FLUSH, () => end(null));
    });
  }

  /** Deflate one outgoing message → the frame payload to send with RSV1. */
  deflate(data: Buffer): Promise<Buffer> {
    if (!this.deflater) this.deflater = zlib.createDeflateRaw({ windowBits: deflateWindowBits(this.params.clientMaxWindowBits), memLevel: 8 });
    const def = this.deflater;
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      const onData = (c: Buffer) => parts.push(c);
      const onErr = (e: Error) => { def.off("data", onData); this.deflater = null; reject(e); };
      def.on("data", onData); def.once("error", onErr);
      def.write(data);
      def.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        def.off("data", onData); def.off("error", onErr);
        let out = Buffer.concat(parts);
        if (out.length >= 4 && out.subarray(out.length - 4).equals(TAIL)) out = out.subarray(0, out.length - 4);
        if (this.params.clientNoContextTakeover) { def.close(); this.deflater = null; }
        resolve(out);
      });
    });
  }
  close(): void { this.inflater?.close(); this.deflater?.close(); this.inflater = this.deflater = null; }
}
