/**
 * MD-08 lossless trim front door: picks the container by magic bytes and runs the matching from-scratch remuxer.
 * No decoding and no re-encoding — compressed samples are copied byte-for-byte, so it is instant and lossless.
 *   MP4 / MOV / M4A / M4V (ISO-BMFF, progressive or fragmented) → bmff.ts; "exact" start via an edit list.
 *   WebM / MKV / MKA (Matroska) → ebml.ts; the start snaps to the previous video key frame (Matroska has no edit list).
 */
import { trimMp4, MediaError as BmffError } from "./bmff";
import { trimWebm, MediaError as EbmlError } from "./ebml";

export type Container = "mp4" | "webm";
export function detectContainer(b: Uint8Array): Container | null {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.length >= 8) {
    const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (["ftyp", "moov", "mdat", "free", "skip", "wide", "styp", "pnot"].includes(t)) return "mp4";
  }
  return null;
}
export interface LosslessResult { bytes: Uint8Array; container: Container; ext: string; mime: string; start: number; end: number; snapped: boolean; note: string }
export function isTrimError(e: unknown): boolean { return e instanceof BmffError || e instanceof EbmlError; }

/** from/to in seconds; exact=true keeps the exact start on MP4 (edit list), ignored for WebM */
export function losslessTrim(b: Uint8Array, from: number, to: number, exact: boolean, nameHint = ""): LosslessResult {
  const c = detectContainer(b);
  if (!c) throw new BmffError("not an MP4/MOV or WebM/MKV file — use the re-encode path");
  if (c === "mp4") {
    const r = trimMp4(b, from, to, { mode: exact ? "exact" : "keyframe" });
    const audioOnly = r.tracks.every((t) => t.handler !== "vide");
    const ext = /\.mov$/i.test(nameHint) ? "mov" : audioOnly ? "m4a" : "mp4";
    return { bytes: r.bytes, container: c, ext, mime: ext === "mov" ? "video/quicktime" : audioOnly ? "audio/mp4" : "video/mp4", start: r.start, end: r.end, snapped: !exact,
      note: exact ? `exact start via an edit list (decoding begins at the key frame at ${r.keyframe.toFixed(3)} s)` : `start snapped to the key frame at ${r.start.toFixed(3)} s` };
  }
  const r = trimWebm(b, from, to);
  const ext = /\.mkv$/i.test(nameHint) ? "mkv" : "webm";
  return { bytes: r.bytes, container: c, ext, mime: ext === "mkv" ? "video/x-matroska" : "video/webm", start: r.start, end: r.end, snapped: Math.abs(r.start - from) > 1e-3,
    note: Math.abs(r.start - from) > 1e-3 ? `WebM has no edit list: the start snapped to the key frame at ${r.start.toFixed(3)} s` : "starts on a key frame" };
}
