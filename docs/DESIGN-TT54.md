# TT54 — Metadata, thumbnails, TIFF, export encoder, Photos (FF-13 · FF-07 · MD-03)

Tier-5 ultrareview, protocol A–J. Every number below was produced in this sandbox this turn by the commands named;
nothing here is claimed from memory or from a tool that was not run.

## Runtime honesty
* **Ran:** Node 22 (`--experimental-strip-types`), tsc, ESLint, Next 16 production build, embedded Postgres, headless
  Chromium 143 (Playwright), Python venv with Pillow 13 (libavif, libwebp, libjpeg), pillow-heif (libheif + libde265 + x265),
  exifread, piexif, mutagen, PyAV 18.1 (FFmpeg: libdav1d, libsvtav1), pypdf, python-docx, openpyxl, python-pptx, lxml, numpy.
  All oracles are **test-only** — nothing GPL (mutagen) or native is shipped.
* **Not available:** theorem provers, Safari / Firefox, macOS / Windows / iOS / Android, Photoshop / Lightroom / Apple Photos,
  any HEVC decoder or encoder inside Chromium (probed: `VideoDecoder.isConfigSupported("hvc1…")` = false,
  `ImageDecoder.isTypeSupported("image/heic"|"image/tiff")` = false). HEIC claims are therefore limited (§C).

## A. Formal model
* **Metadata** `readMetadata(bytes, name) → FileMeta` is a total function: it never throws for any byte string; every
  failure becomes a `warnings[]` entry. Fields are present only when the file states them (no invented defaults — unlike
  python-docx / openpyxl, which invent core properties; the oracle skips those).
* **Orientation** `o ∈ 1..8` comes from EXIF only (browsers ignore XMP orientation); `o ∉ 1..8 → 1`. HEIF/AVIF use
  `irot`/`imir`. Display size = stored size with axes swapped for `o ∈ {5,6,7,8}`.
* **Recipe** `R` is a pure value, `parseRecipe(any) → R` total and idempotent; `render(src, R)` =
  rotate → flip → (straighten ∘ crop, one bilinear pass) → linear exposure / white balance → tone curve →
  saturation / vibrance (Rec.709 luma) → vignette `1 − 0.8·v·d²`. Invariants: `render(src, identity) = src` byte-for-byte;
  `rotate⁴ = id`; tone curves monotone; output size = `outputSize(w, h, R)`; resolution independence
  (render(full)↓2 ≈ render(half)).
* **Sidecar** `S(p) = dir/.name.edit.json`; for every VFS op `op ∈ {rename, copy, move, trash, restore, purge, batchRename}`
  the server maintains `S(op(p)) = op(S(p))` (followSidecar), so any client — not only Photos — keeps edits attached.
* **Thumbnail key** `k = H(bytes)[0:32] | "p"+fnv1a(path)` ‖ size ‖ max ‖ recipeKey(R) ‖ **renderer version**.
  Content-addressed ⇒ renames re-use, edits re-key; renderer version ⇒ a renderer change can never be masked by stale bytes.
* **Export** `encode(canvas, fmt) → bytes` with `mime(bytes) = fmt` checked (silent PNG fallbacks are reported, not mislabelled);
  `EXIF_out = curate(EXIF_in)`: Orientation := 1, Software := "Fusion Photos", PixelX/YDimension := output size,
  MakerNote dropped, GPS ⊆ output ⇔ "Keep location".

## B. Hypotheses
* **H+** (expected to hold, tested): 0 oracle disagreements on 1,783 real files; TIFF decode bit-exact to Pillow; browser
  PNG export bit-exact to the Node renderer; exported EXIF readable by Pillow and exifread with exactly one block.
* **H−** (expected to fail, tested as refusals): tiled / JPEG / CCITT / CMYK TIFF; > 40 MP; strips past EOF; LZW garbage;
  non-AV1 bitstreams; injection into the wrong container; hostile sidecars (prototype keys, out-of-range values).
* **H∂** (boundary): 16-bit TIFF (display = top 8 bits; Pillow clips instead — reference semantics differ, disclosed in
  `tiff_fixtures.py`); EXIF rationals 0/0 (= NaN, minutes/seconds treated as 0); ID3 duplicates (merged); FLAC short
  blocks (repaired); fragmented MP4 duration (mehd, else last fragment); PDF incremental updates without /Info (inherit).

## C. Frontier (what is and is not covered)
| Area | Covered | Not covered (disclosed) |
|---|---|---|
| Metadata | JPEG/PNG/GIF/WebP/AVIF/HEIF/BMP/TIFF/SVG, ID3v1/2.2–2.4, FLAC/Vorbis/Opus, MP4 ilst, Matroska tags, MP4/MOV/WebM/MKV, PDF (+recovery, encryption flag), OOXML/ODF/EPUB | RAW camera formats, IPTC-IIM, Photoshop IRBs beyond XMP, encrypted PDF Info (password needed) |
| Thumbnails | images incl. TIFF (own decoder), covers, PDF p.1, video frame, text, edited photos | **HEIC**: corpus HEICs carry no non-HEVC thumbnail and the tested Chromium has no HEVC decoder → icon. Works only where the browser decodes HEIC natively (not verified here). |
| TIFF | strips; none/LZW/Deflate/PackBits; 1/2/4/8/16-bit gray, palette, RGB(A); planar; predictor 2; assoc/unassoc alpha | tiles, JPEG-in-TIFF, CCITT, CMYK/YCbCr/Lab, float, multi-page (first IFD only) — refused with a reason |
| Export | PNG/JPEG/WebP (+EXIF), AVIF (own HEIF writer + Exif item) | HEIC export greyed out (no HEVC VideoEncoder in Chromium); our hvc1 writer is verified only by re-wrapping x265 output |
| Photos | library, editor, sidecars, export, ratings, favourites, Places (coordinates only) | no map tiles in Places (privacy); HEIC/TIFF export from the HEIC preview disabled |

## D. Negative shapes (≥ 15 + modal shortcut)
`scripts/tt54-meta.mts › Negative shapes` — **22** hostile inputs, all bounded in 11 ms: EXIF IFD self-loop, absurd tag
count, truncated JPEG APP1, PNG chunk length 2³¹, MP4 64-bit box overflow, Matroska zero vint, ID3 size past EOF, FLAC
without STREAMINFO, garbage PDF trailer, fake ZIP docx, XMP billion-laughs (entities not expanded), TIFF strip outside the
file, gigapixel TIFF, tiled TIFF, JPEG-compressed TIFF, CMYK TIFF, LZW bad first code, AV1 forbidden bit, EXIF injection
into PNG-as-JPEG / JPEG-as-PNG / zero-bytes-as-WebP, hostile recipe (rotate 9, crop out of range, string exposure,
`preset: "constructor"`) — plus Orientation 0 / 9 → 1 and empty EXIF → no block. Refusals must name the **right**
reason (an incidental later failure would hide a removed guard — tightened after the "tiles accepted" mutant analysis).
**Modal shortcut failure test:** the e2e deep-link test (`?open=photos&path=`) originally passed only because a stale
Photos window from the previous test swallowed the deep link; `openPage()` now resets the desktop first, and the
shell-singleton behaviour (a deep link to an already-open module window is ignored) is disclosed as a limit.
The fs `op=stat` shortcut (HTTP 200 + `node:null` for missing files) produced `exact-edited-199.png`; the export-name
helper now checks `node`, and the e2e asserts `cam-edited.webp` then `cam-edited-2.webp`.

## E. Mechanism-distinct approaches (≥ 6)
1. **Byte-structure readers** (own code) for every container — no browser decode needed, works in Node / worker / server.
2. **Independent native oracles** (Pillow/libtiff, exifread, mutagen, FFmpeg, pypdf, python-docx) — different code bases.
3. **Hand-built fixtures** byte by byte (planar TIFF, damaged PDF increment, hostile IFDs) where no tool writes the shape.
4. **Pixel-exact differential** (TIFF vs Pillow; browser PNG export vs Node `renderRecipe`).
5. **Perceptual differential** (AVIF: libavif vs FFmpeg/dav1d luma PSNR; straighten vs Pillow rotate ≥ 30 dB).
6. **Property checks** (rotate⁴ = id, monotone tone on 343 slider combos, resolution independence, recipe idempotence).
7. **Mutation analysis** — 30 seeded bugs.
8. **Real-UI e2e** in Chromium with screenshots inspected by eye.
Known prior art, named from general knowledge — **not searched, read or copied this turn**: libtiff / UTIF.js (TIFF),
exifr / ExifReader / piexifjs (EXIF), music-metadata (audio), Lightroom / darktable XMP sidecars (non-destructive edits). Ours is written from the TIFF 6.0,
EXIF 2.32, ISO/IEC 23008-12 (HEIF), AV1-ISOBMFF and PDF 1.7 specifications.

## F. Artifacts
`src/lib/meta/*`, `src/lib/image/tiff.ts`, `src/lib/image/encode.ts`, `src/lib/photos/recipe.ts`, `src/lib/thumbs/*`,
`src/components/Thumb.tsx`, `src/components/modules/Photos.tsx`, Files Info panel / Hidden toggle, `src/app/api/fs/route.ts`
(`op=media`, followSidecar); tests `scripts/tt54-meta.mts`, `scripts/tt54-mutants.py`, `scripts/e2e-tt54.mts`; oracles
`scripts/oracle/{meta_check,meta_fixtures,tiff_fixtures,encode_fixtures,encode_check,recipe_check,photos_fixtures}.py`;
corpus fetcher `scripts/corpus/fetch-meta.py` (pinned tarballs; corpora are test-only and not committed).

## G. Second-order adversary
* **"The oracle and the code share a bug."** Answered by mechanism diversity (§E) and by mutants: 30/30 killed, each
  killed by an *independent* oracle (Pillow, exifread, libavif, FFmpeg, pypdf, numpy reference).
* **"The cache hides a renderer fix."** It did: after SVGs moved onto white paper, the e2e still showed the old transparent
  thumbnail, served from `/System/Cache/thumbs` for identical bytes. Repaired (§I).
* **"Stale entries waste the budget forever."** The FIFO sweep ran only after 25 writes; a fully cached session never
  swept. Repaired (§I).
* **"Refused, but for the wrong reason."** Negative tests now check the reason string.
* **"Coverage hole."** The first mutant run left *out-of-range orientation* alive (no corpus file has 0 or 9) — new
  targeted case added, now killed.

## H. External verification
| Check | Result |
|---|---|
| Metadata vs independent readers, 1,783 files | **0** disagreements (exif.tag 3,193 · xmp 616 · pdf.pages 931 · pdf.info 1,086 · ooxml.core 1,028 · audio.tag 116 · image.size 115 · video 11) in 3.1 s |
| TIFF decoder vs Pillow, 34 files | **34/34 bit-exact** |
| Export encoder (22 EXIF outputs, 4 AVIF, 1 HEIC re-wrap, 9 negatives) | fails [] |
| Recipe engine, 117 renders + 14 properties | fails []; tone max diff 1 level |
| PDF damaged-increment recovery | title / author / newest MediaBox equal to pypdf (strict=False) |
| Mutation analysis | **30/30** killed |
| e2e-tt54 (real Chromium UI) | **8/8** incl. TIFF thumbnail, SVG on paper, stale-renderer sweep, PNG export bit-exact to Node, AVIF/JPEG/WebP decoded by Pillow |

## I. Repairs, and a new attack on each patch
| Defect found this turn | Repair | Attack on the patch |
|---|---|---|
| SVG thumbnails invisible (black on transparent) | white paper under SVGs | e2e: ≥ 50 % opaque-white pixels in the vector.svg thumbnail |
| Renderer fix masked by cached thumbnails | renderer version `r2` in the key | e2e plants an old-format entry → must be gone; all keys must match `-rN.webp` |
| Stale entries never swept in fully-cached sessions | sweep once per session on first use; other-renderer entries always purged first | same planted entry; 17 real stale entries removed on the next session (33 → 16) |
| Photos preview clipped (grid auto row) | `minmax(0,1fr)` tracks + `object-fit: contain` | visual inspection of the e2e screenshot (3:4 portrait letterboxed) |
| Tofu glyphs (★ ♥ ↔ ↕) | inline SVG icons, text labels | visual inspection |
| Export name `-199` (op=stat 200 + null) | check `node` | e2e unique names `-edited` then `-edited-2` |
| Out-of-range orientation untested | targeted negative case | mutant re-run: killed |
| (found by the full run-all, finished in TT55) 4 a11y regressions hidden by stale result JSONs: literal font sizes in Pdf / Slides / slide placeholders, an unlabelled `svg role=img`, non-tab children in a tablist, muted text inside a primary button | `fz()` / named constants, `aria-hidden` decorative icons, tab roles, `.fs-dim` inherits colour inside primary buttons | a11y-unit + e2e-a11y re-run on the rebuilt app (TT55 subset run) |
| e2e-ai asserted an exact pixel count that a font change broke | pixel *contract* (non-blank, inside the frame, deterministic between two renders) | same suite, two builds |
| axe target-size flagged desktop icons only because windows covered them | windows pass excludes `desk-icons`; a second pass with windows hidden audits the icons unobscured | both passes must be clean — a real undersized icon still fails the second pass |

## J. Stopping
Stopped when: all oracles report 0 failures, 30/30 mutants are killed, e2e 8/8 on the final build, screenshots inspected,
and every remaining gap is a platform blocker listed in §C (HEVC in Chromium) or an out-of-scope format refused with a
reason. Repair spend stayed within the ~1/10 budget (all repairs were on TT54 code, found by this turn's own tests).

## Policies
Orientation EXIF-only; EXIF 0/0 = NaN; ASCII decoded as UTF-8; audio TYER honoured; FLAC short blocks repaired; duplicate
ID3 frames merged; PDF page size = CropBox ∩ MediaBox; `/Encrypt null` = not encrypted; fragmented MP4 duration = mehd,
else last fragment; AVIF: our writer when EXIF is requested; straighten positive = clockwise; recipe presets must be own
keys, rotate exactly 1/2/3, crop x/y ≤ 0.99 and w/h ≥ 0.01. Dotfiles hidden in Files (toggle), desktop, Tabletop
(code-only — not exercised by the e2e) and `ls` (`-a`). Photos: image double-click still opens the Image Editor; Places
shows coordinates only; date index in localStorage; photos without EXIF use the file date, labelled; export re-renders from
the full-resolution original (≤ 40 MP), never upscales, names `<stem>-edited[-N].<ext>`. Thumbnail disk cache: 48 MiB,
**FIFO by write time, not LRU** (the spec row says LRU; the in-memory layer is LRU, the disk layer is not — reads do not
rewrite entries, to avoid a write per view). Files > 96 MiB are not thumbnailed.
