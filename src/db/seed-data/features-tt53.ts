import type { SpecRow } from "./row";

/**
 * TT53 register changes — MD-08 gets a lossless cut: from-scratch ISO-BMFF (MP4/MOV/M4A) and Matroska (WebM/MKV)
 * remuxers copy the compressed frames of the range into a new file (no FFmpeg/WASM bundled). Evidence:
 * scripts/tt53-media.mts (FFmpeg via PyAV, test-only, decodes and hashes every frame; Chromium plays the output; a real
 * MediaRecorder recording is trimmed), scripts/tt53-mutants.py, scripts/e2e-tt53-media.mts (real UI).
 */
const NUANCE = "TT53: lossless trim without a bundled muxer — src/lib/media/bmff.ts (ISO-BMFF: progressive and fragmented MP4, MOV, "
  + "M4A; stts/ctts/stss/stsz/stz2/stsc/stco/co64, trex/tfhd/tfdt/trun, size-0 and 64-bit boxes, the source edit list) and "
  + "src/lib/media/ebml.ts (Matroska/WebM incl. unknown-size live recordings from MediaRecorder). Frames are copied byte-for-byte; "
  + "MP4 keeps an exact start with a new edit list (decoding starts at the previous key frame, presentation at the requested time) "
  + "or snaps to the key frame; WebM has no edit list, so its start snaps to the previous video key frame and the status line says "
  + "where; the output gets Duration + Cues so even a live recording becomes seekable. Verified by FFmpeg (PyAV, test-only): "
  + "96 random cuts over H.264 (B-frames) + AAC MP4/faststart/fragmented/MOV/MKV, VP8/VP9 + Opus WebM, audio-only files — every "
  + "displayed frame hash-equal to the source frame, timing exact per sample, every packet byte-identical; Chromium plays the trimmed "
  + "WebM; truncated downloads keep only their gap-free part. Refused with a message: encrypted (CENC/Matroska encryption) tracks, "
  + "multi-edit lists, several sample descriptions inside the range, damaged structure. Other formats (AVI, MPEG-TS, Ogg) and "
  + "frame-accurate WebM starts still use the re-encode path (MediaRecorder at 1×), which stays available.";

export function patchTT53(f: SpecRow): SpecRow {
  if (f.code === "MD-08") {
    return {
      ...f,
      status: "built",
      route: "Media → Trim / export: Lossless cut (src/lib/media/trim.ts → bmff.ts / ebml.ts) or Re-encode (captureStream + MediaRecorder)",
      nuance: NUANCE,
      test: `${f.test ? f.test + "; " : ""}tt53-media.mts; tt53-mutants.py; e2e-tt53-media.mts`,
    };
  }
  return f;
}
