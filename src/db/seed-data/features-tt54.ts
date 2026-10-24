import type { SpecRow } from "./row";

/**
 * TT54 register changes — the media metadata / thumbnail / photo stack. FF-13 (metadata readers for images, audio, video
 * and documents + a worker thumbnailer cached in the VFS + a baseline TIFF decoder), FF-07 (export encoder: platform
 * codecs probed, EXIF written by us, AVIF / HEIF container written by us from WebCodecs key frames), MD-03 (Photos:
 * library + non-destructive recipe in a hidden sidecar that follows the file). Evidence: scripts/tt54-meta.mts (Pillow,
 * libavif, libheif, FFmpeg/dav1d, exifread, mutagen, pypdf, python-docx/openpyxl, numpy — all test-only), scripts/tt54-mutants.py
 * (30/30), scripts/e2e-tt54.mts (real Chromium UI).
 */
const SUITES = "tt54-meta.mts; tt54-mutants.py; e2e-tt54.mts";
const N13 = "TT54: src/lib/meta (EXIF/TIFF IFDs, XMP, GPS, embedded thumbnails; JPEG/PNG/GIF/WebP/AVIF/HEIF/BMP/TIFF/SVG size, "
  + "frames, orientation; ID3v1/v2.2-2.4, FLAC/Vorbis/Opus comments, MP4 ilst, Matroska tags, cover art; MP4/MOV/WebM/MKV "
  + "size + duration; PDF pages / Info / XMP / encryption with damaged-file recovery; OOXML/ODF/EPUB core properties) agrees "
  + "with independent readers on 1,783 real files (0 disagreements). Thumbnails: OffscreenCanvas worker (2 at a time, 12 s "
  + "timeout), EXIF orientation applied, edits (recipe) rendered, TIFF via our own baseline decoder (bit-exact to Pillow on 34 "
  + "files; tiles / JPEG-in-TIFF / CMYK refused), embedded covers / document thumbnails / video frames. Cache: memory LRU "
  + "(400) + WebP files in /System/Cache/thumbs keyed by content hash + size + recipe (48 MiB, swept oldest-first — FIFO, not "
  + "LRU, on disk). HEIC thumbnails need an HEVC decoder the browser may not have (absent in the tested Chromium): those show "
  + "the file icon. Dotfiles (sidecars) are hidden in Files (toggle), on the desktop / Tabletop and in `ls` (-a).";
const N07 = "TT54: src/lib/image/encode.ts — PNG / JPEG / WebP through the platform canvas encoder, then our EXIF block "
  + "(camera fields kept, Orientation reset to 1, Software = Fusion Photos, MakerNote and GPS dropped unless 'Keep location' "
  + "is ticked) injected as APP1 / eXIf / VP8X+EXIF; AVIF written by our own HEIF container writer around a WebCodecs AV1 "
  + "key frame (with an Exif item), or the platform AVIF encoder when no EXIF is requested; HEIC only where the platform has "
  + "an HEVC VideoEncoder (probed; the tested Chromium has none, so HEIC is greyed out and our hvc1 writer is verified by "
  + "re-wrapping x265 output). Every result is checked for the MIME the platform really produced — silent PNG fallbacks are "
  + "reported, never mislabelled. Verified by Pillow, exifread, libavif, FFmpeg/dav1d and libheif.";
const N03 = "TT54: Photos module — library (All / Favourites / Edited / Places, grouped by EXIF date, else the file date, "
  + "labelled), editor (rotate / flip / straighten / crop, exposure, contrast, highlights, shadows, saturation, vibrance, "
  + "warmth, tint, vignette, 6 presets, rating, favourite, undo, before/after), Save edit writes a recipe JSON to a hidden "
  + "sidecar `.name.edit.json` beside the photo — the original is never modified — and the sidecar follows the photo through "
  + "rename / copy / move / trash / restore / purge / batch rename. Export re-renders from the full-resolution original "
  + "(≤ 40 MP) to PNG / JPEG / WebP / AVIF as `<name>-edited[-N]`. The same recipe engine renders in Node, the worker and "
  + "the editor (browser PNG export bit-exact to the Node render). Places shows coordinates only (no map tiles fetched).";

export function patchTT54(f: SpecRow): SpecRow {
  const t = (prev: string | null | undefined) => `${prev ? prev + "; " : ""}${SUITES}`;
  if (f.code === "FF-13") return { ...f, status: "built", route: "Files grid / Info panel / Photos (src/lib/meta, src/lib/thumbs, src/lib/image/tiff.ts)", nuance: `${f.nuance ? f.nuance + " " : ""}${N13}`, test: t(f.test) };
  if (f.code === "FF-07") return { ...f, status: "built", route: "Photos → Export (src/lib/image/encode.ts)", nuance: N07, test: t(f.test) };
  if (f.code === "MD-03") return { ...f, status: "built", route: "Photos module (src/components/modules/Photos.tsx, src/lib/photos/recipe.ts)", nuance: `${f.nuance ? f.nuance + " " : ""}${N03}`, test: t(f.test) };
  return f;
}
