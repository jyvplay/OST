# TT53 — MD-08 lossless video/audio trim (from-scratch MP4 and Matroska remuxers)

**Runtime honesty.** Everything in this document was run in the Arena sandbox:
- Node 22, tsc, Next 16, embedded Postgres, and headless Chromium 143 (Playwright);
- a Python venv with **PyAV 18.1.0** (FFmpeg libavformat 62.12): test-only, LGPL, never shipped or imported by Fusion.

What was not available:
- theorem provers, so the "formal model" in §A is a written specification checked by tests, not a proof;
- Safari/QuickTime, Firefox, VLC and real phones, so playback was verified only in FFmpeg and Chromium.

The register previously said: "A lossless cut needs a WASM muxer, which is not bundled." That was the blocker. TT53
removes it without bundling anything, through two original TypeScript remuxers:
- `src/lib/media/bmff.ts` for ISO-BMFF;
- `src/lib/media/ebml.ts` for Matroska/WebM.

Both are written from the container structure (ISO/IEC 14496-12 box layout; RFC 8794 EBML; RFC 9559 Matroska). No
third-party code was copied or translated; see §E for what was surveyed.

## A. Formal model (what a correct cut is)

Let the source track have samples *s₀…sₙ₋₁* in decode order. Each has:
- a decode time *dᵢ* and a composition offset *cᵢ*, giving a presentation time *pᵢ = dᵢ + cᵢ − m + w*, where *m* is the
  source edit's media time and *w* its empty-edit dwell;
- a sync flag *kᵢ*;
- bytes *bᵢ*.

A cut for the requested range [*t₀*, *t₁*) is **correct** when all of these hold:

1. **Losslessness.** Every output sample's bytes equal some source sample's bytes: *b′ⱼ = b_σ(j)*.
2. **Decodability.** The output decode sequence starts at a sync sample *k* with *p_k ≤ t₀* and is the source decode
   sequence from *k* onward, minus only pictures that are shown before *p_k* (open-GOP leading pictures). A decoder
   therefore reaches the same state it would reach in the source.
3. **Display equivalence.** The frames the output displays are exactly the source frames with *T₀ ≤ pᵢ < T₁*, in
   order, with times *pᵢ − T₀*:
   - **MP4 exact mode:** *T₀ = t₀* and *T₁ = t₁*, enforced by an edit list.
   - **MP4 key-frame mode:** *T₀ = p_k*.
   - **Matroska:** *T₀ = p_k*. There is no edit list, so the output may also contain reference frames shown after *t₁*.
     Then *T₁* moves to the next real frame after those references, and the moved end is reported.
4. **Display completeness.** No source frame with *T₀ ≤ pᵢ < T₁* is missing. This forces the B-frame extension in
   Matroska, and the gap-free prefix of a truncated file.
5. **Audio coverage (MP4).** The audio frame that overlaps *T₀* is kept and trimmed by the edit list, so audio starts at 0.
   Matroska block times cannot be negative, so its audio starts at the first frame at or after *T₀* (up to one Opus
   frame, about 20 ms, later). This is disclosed.
6. **Metadata.** Header durations equal *T₁ − T₀*: mvhd and tkhd in MP4, Info/Duration in Matroska. Matroska output
   carries Cues for every key-frame cluster.
7. **Refusal.** Inputs the model cannot represent are refused with a message, never written out wrong:
   - encryption;
   - multi-edit lists;
   - several sample descriptions inside the range;
   - damaged structure.

## B. Hypotheses

- **H+.** A lossless cut can be done in the browser without FFmpeg or WASM by copying samples and rewriting only the
  index structures. *Confirmed:* 96 random cuts plus the edge shapes; every displayed frame is hash-equal under FFmpeg.
- **H−.** A naive cut, which starts at the requested frame rather than its key frame, would also look fine.
  *Refuted:* the modal-shortcut test (§D) marks every frame a key frame, and the oracle catches the result.
- **H∂ (boundary).** Matroska cannot express an exact start or end. *Confirmed and handled:*
  - the start snaps to the key frame;
  - with B-frames (H.264 in MKV) the end can move past *t₁*;
  - both are reported in the status line.
  This boundary is a property of the format, not of the code.

## C. Frontier: what is and is not covered

**Covered:**
- **MP4:** progressive MP4, faststart MP4, fragmented MP4 (moof/traf/tfhd/tfdt/trun with trex defaults) and MOV;
  audio-only M4A.
- **Matroska:** MKV with H.264 B-frames; WebM VP8/VP9 + Opus; Opus-only WebM; unknown-size Segments and Clusters
  (real Chromium MediaRecorder output).
- **Container details:** size-0 boxes (to end of file), 64-bit largesize boxes (mdat and moov), co64 offsets,
  stz2 sample sizes.
- **Edits:** a source edit list with one media edit plus an empty edit.
- **Damage:** truncated downloads, of which only the gap-free part is kept.

**Not covered:**
- Other containers (AVI, MPEG-TS, Ogg, MP3/ADTS): these use the re-encode path.
- Frame-accurate WebM starts.
- Multi-edit source edit lists, and several sample descriptions inside the range (refused).
- Encrypted media (refused).
- Subtitle and timecode tracks: these are copied by the same sample rules but not verified.
- Files over 8 MB are downloaded rather than stored in the VFS (an existing app limit). The whole file is held in
  memory, so very large files depend on the browser's memory.
- Large inputs with a version-0 header whose duration would exceed 2³² ticks (refused).

## D. Negative shapes and the modal-shortcut test

`scripts/tt53-media.mts` checks 18 refusals and outcomes, each asserting the *message*, not just that something threw.
A refusal must be a MediaError; a raw RangeError fails the test.
- **Ranges:**
  1. *t₁ = t₀*;
  2. *t₁ < t₀*;
  3. a range past the end of an MP4;
  4. a range past the end of a WebM.
- **MP4 damage:**
  5. truncated moov;
  6. box size past the end of the file;
  7. box size under 8.
- **MP4 unsupported content:**
  8. an encv (CENC) sample entry;
  9. a two-media-edit elst;
  10. two sample descriptions used inside the range;
  11. an stsz claiming 40 M four-byte samples in a 200 kB file (memory bomb);
  12. an stco count running past its box;
  13. no moov.
- **EBML damage:**
  14. damaged EBML header;
  15. WebM without Tracks;
  16. a Matroska ContentEncryption track.
- **Truncation:**
  17. a truncated fragmented MP4: keeps the gap-free part, reports the true end, decodes cleanly;
  18. a range entirely in the lost part of the file.

**Unusual but valid shapes** (each trimmed and verified): size-0 mdat, largesize mdat, largesize moov, co64, a live
recording truncated mid-cluster, a 100 s Matroska needing int16 cluster splits, and irregular recorder timestamps.

**Modal-shortcut failure test.** The tempting shortcut is to cut at the requested frame without its key frame. The
test produces exactly that (every SimpleBlock flagged as a key frame) and asserts that the FFmpeg oracle reports decode
errors or different pictures. It does, so the oracle can tell a shortcut from a correct cut.

## E. Approaches considered (mechanism-distinct)

1. **Re-encode via MediaRecorder** (the existing path). Takes real time and loses quality. It stays available.
2. **WebCodecs decode + encode.** Lossy, and slow for long clips; it needs a muxer anyway.
3. **Bundle FFmpeg.wasm.** LGPL and about 25 MB; rejected because of the licence rules and the lightweight constraint.
4. **Use a library:**
   - Mediabunny (MPL-2.0, a full toolkit that documents lossless remux);
   - mp4box.js (BSD-3, parse and segment only);
   - mp4-muxer / webm-muxer (MIT, muxers for WebCodecs chunks only; no demuxing or trimming).
   None is a drop-in lossless *trimmer*, and only the MIT/BSD ones meet the "permissive" rule. Surveyed through their
   public descriptions (web search, Oct 21 2026); no code was read or copied.
5. **Byte-range slicing** of the source (cut mdat ranges in place). Rejected: sample tables and fragment offsets would
   all need rewriting anyway, and Matroska clusters do not align with arbitrary times.
6. **Sample-copy remux with rebuilt indexes.** *Chosen.* MP4 gets a progressive layout with interleaved 0.5 s chunks
   and a new edit list. Matroska gets new clusters at key frames plus Cues.
7. **MP4 output as a fragmented file.** Simpler to write, but some players handle fragmented edit lists poorly.
   Progressive output was chosen.

## F. Artifacts

- **Engine:** `src/lib/media/bmff.ts`, `src/lib/media/ebml.ts`, `src/lib/media/trim.ts` (magic-byte routing, file
  extension and MIME type).
- **UI:** `src/components/modules/Media.tsx`:
  - "Lossless cut (instant)" and "Re-encode (real time)" buttons, and an "exact start (MP4)" toggle;
  - a status line that states the actual start and end;
  - Unicode arrows replaced by words (they rendered as missing-glyph boxes).
- **Tests:**
  - `scripts/tt53-media.mts` (11 tests);
  - `scripts/e2e-tt53-media.mts` (6 tests, real UI);
  - `scripts/tt53-mutants.py` (25 mutants);
  - `scripts/tt53/bmffedit.ts` (test-only box rewriter for hostile shapes).
- **Oracles (test-only):** `scripts/oracle/media_fixtures.py` (PyAV fixtures with visually unique frames) and
  `scripts/oracle/media_check.py` (decode, hash, timing and packet-identity check).
- **Ledger:** `src/db/seed-data/features-tt53.ts` (MD-08 → built); seed 3.39.0.

## G. Second-order adversary: mutation testing

`scripts/tt53-mutants.py` has **25 mutants; all 25 are killed**. On the first run 22 were killed. Each of the 3
survivors exposed a gap in the *oracle*, which was then fixed:
- **"mvhd keeps the source duration."** FFmpeg ignores mvhd, so a structural check now requires the mvhd and tkhd
  durations to equal the cut length.
- **"largesize header misread."** For mdat this mutant is equivalent, because samples use absolute offsets. A 64-bit
  *moov* shape now kills it.
- **"reported end overshoots the next frame."** Only random recorder jitter exercised it. A deterministic
  irregular-timestamp test now kills it.

The mutants cover:
- **MP4 sample selection:** sync search, end prefix, the source edit offset, audio overlap;
- **MP4 tables:** ctts, stss, mvhd;
- **MP4 writing:** chunk offsets;
- **MP4 guards:** encv, multi-edit, sample descriptions, the stsz bound, truncation, largesize;
- **EBML parsing:** unknown-size order, the key-frame flag, the unknown-cluster end rule;
- **EBML writing:** the B-frame extension, the int16 split, timestamp patching, Duration, the Cues position, the end
  overshoot, audio before the key frame;
- **EBML guards:** encryption.

## H. External verification

| Check | Result |
|---|---|
| FFmpeg decode + frame hashes, MP4 family (6 fixtures × 6 random ranges × exact/key-frame) | 72 / 72 cuts: 0 decode errors, displayed frames hash-equal to the source in order, all packets byte-identical, per-sample timing exact (own parser, ≤ 1 tick) |
| FFmpeg, Matroska family (4 fixtures × 6 ranges) | 24 / 24 |
| Frames verified by hash | 4,390 |
| Real Chromium MediaRecorder recording (unknown sizes, no Cues) | trimmed, FFmpeg-verified, **played back in Chromium** (finite duration, seek, no media error) |
| FFmpeg seek through our Cues | lands at or before the requested time |
| Real UI e2e (Chromium 143) | 6 / 6: MP4 exact start, MP4 key-frame start, WebM, MOV and M4A extensions, a non-media refusal, no page errors; each saved file re-verified by FFmpeg. A 2.25 s MP4 cut completes in well under 10 s (an instant remux, not real time) |

## I. Repairs found during this tier, and the attack aimed at each patch

1. **EBML unknown sizes were rejected** (all-ones 8-byte vint > 2⁵³). Every MediaRecorder file failed.
   - Repair: detect all-ones before the range test.
   - Attack: the real-recording test and a mutant.
2. **MKV with B-frames showed a gap at the end.** A reference frame shown after the end was kept, but the B-frames
   shown before it were not.
   - Repair: extend the decode prefix until it is display-complete; report the moved end.
   - Attack: the MKV sweep and a mutant.
3. **The reported WebM end overshot the next real frame** with irregular recorder timestamps.
   - Repair: end = max(requested, min(next real frame, last + step)).
   - Attack: a synthetic 40/10 ms-gap test and a mutant.
4. **Truncated fragmented MP4s** kept a decode prefix whose display had gaps.
   - Repair: the lost samples' times are still in the tables, so the prefix is shortened until it is gap-free.
   - Attack: negative shapes 17 and 18, and a mutant.
5. **Memory bomb.** A fixed-size stsz could claim 50 M samples. It is now bounded by the file size, and samples past
   the end of the file are refused at copy time.
   - Attack: negative shape 11 and a mutant.
6. **The version-0 → 1 header widening** in the draft was convoluted and untested. It was replaced by a clear refusal,
   since it is needed only past 2³² ticks.
7. **TT52 carry-over.** Embedded-file-only PDF encryption: see DESIGN-TT52 §I-9.

## J. Stopping

I stopped when:
- all 11 unit tests, 6 e2e tests and 25 mutants passed;
- every survivor had been turned into a kill by strengthening the oracle, not by weakening the mutant;
- the remaining limits (§C) were format-level (no WebM edit list) or explicit refusals.

Next steps for MD-08, if wanted:
- a frame-accurate WebM start, by re-encoding only the first GOP with WebCodecs and copying the rest;
- MPEG-TS and Ogg trimmers.
