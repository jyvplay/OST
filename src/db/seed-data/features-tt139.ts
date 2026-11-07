import type { SpecRow, Status } from "./row";

/**
 * TT139: the register rows for the engines built this turn.
 *
 * Every row here names a real module, a real suite, and — in `nuance` — the
 * specific thing it does NOT guarantee. That last part is the point: a row that
 * says "built" without a stated limit is the row that turns out to be false six
 * months later.
 *
 * Only rows whose implementations actually landed this turn are patched. Rows
 * whose seed value was already honest (FF-09 and FF-11 already had a real
 * forge.ts behind them; SC-05, PR-10, FM-13, BK-03 and LN-04 were already
 * graded correctly in earlier turns) are left alone even where this turn added
 * to them, because a status is a floor, not a prize.
 */
const BUILT: Status = "built";

export function patchTT139(row: SpecRow): SpecRow {
  const formulas = "tt139-formulas.mts";
  const documents = "tt139-documents.mts";
  const systems = "tt139-systems.mts";
  const media = "tt139-media.mts";
  const cast = "tt139-cast-governor.mts";

  switch (row.code) {
    // ── Formulae and spreadsheets ────────────────────────────────────────
    case "FF-19":
      return { ...row, status: BUILT, route: "src/lib/formulas/formula-engine.ts + Sheets", nuance:
        "Lexer, precedence-climbing parser and evaluator for 68 functions, plus a dependency graph. Excel's operator order is implemented deliberately, not accidentally: unary minus binds tighter than ^, so =-2^2 is 4 and =0-2^2 is -4, which is what Excel and Sheets return and the opposite of standard mathematics — the engine implements the spreadsheet convention because that is the thing being compatible with. Cycles are found structurally with an iterative Tarjan SCC, not by watching values wobble, so a cycle is reported even when its members happen to evaluate equal. Text that is not a formula is never silently coerced into one. Limits: no array formulas, no volatile-function caching across recalculation, no defined names, and no locale-specific function names.", test: formulas };

    case "FF-20":
      return { ...row, status: BUILT, route: "src/lib/formulas/spreadsheet-io.ts writeWorkbook", nuance:
        "Writes SpreadsheetML with multiple sheets, formulas AND their cached values, so a reader that does not calculate still shows the right number. Column letters past Z are computed, not tabled. The writer refuses a cell whose formula would make the file unreadable rather than emitting a broken file that Excel then silently repairs. Limits: no styles, no merged cells, no charts, and no pivot tables — those live in the spreadsheet surface, not this I/O layer.", test: formulas };

    case "FF-21":
      return { ...row, status: BUILT, route: "src/lib/formulas/spreadsheet-io.ts readWorkbook + recalculateWorkbook", nuance:
        "Reads multi-sheet workbooks by following relationships rather than guessing sheet names, keeps R1C1 formulas in their original form when converting to A1 (dropping a $ would change what the formula means), and recalculates through the dependency graph in topological order. A value-wobble test was rejected during development because it missed two-cell cycles; the check is structural. Limits: reads the first relationship of each type, does not honour calcChain ordering, and ignores conditional formatting.", test: formulas };

    case "FF-22":
      return { ...row, status: BUILT, route: "src/lib/formats/office-models.ts (WordprocessingML) + Writer", nuance:
        "Paragraph and run model with a real WordprocessingML writer and reader. Leading, trailing and double spaces force xml:space=\"preserve\" on the run that needs it, which is the difference between a document that keeps its spacing and one that does not. Justified alignment is emitted as `both` because `justify` is not a legal OOXML value. Write → read → write is a fixed point. Limits: no headers/footers, no fields, no numbering definitions beyond a list level, no tracked changes, and no embedded images.", test: documents };

    case "FF-23":
      return { ...row, status: BUILT, route: "src/lib/formats/office-models.ts (PresentationML) + Slides", nuance:
        "Slide order is an explicit list, so moving a slide cannot renumber the others. Geometry is in EMU with the 16:9 default of 12192000×6858000. A remote image URL is refused and only a data URI is accepted, because a slide that fetches a URL leaks the reader's address to whoever hosts it. A deck with no slides round-trips; a deck with no slideIdLst is an error rather than a guess. Limits: no transitions, no animations, no speaker notes, and no theme/master editing.", test: documents };

    case "FF-25":
      return { ...row, status: BUILT, route: "src/lib/formats/svg-editor.ts + Whiteboard", nuance:
        "Primitive editing plus a sanitiser that removes script, foreignObject, iframe, embed, object, use, animate*, set, handler, image, audio, video and style, and also flags on*= attributes, javascript:/vbscript:/data: URLs and any DOCTYPE with an entity list. The latter matters because a billion-laughs entity expansion is a denial of service that no element allowlist catches. Non-finite geometry is coerced to 0. Limits: the sanitiser is an allowlist over elements and attributes but is not a complete XML security review; external stylesheets referenced by @import inside a style attribute are refused outright, not rewritten.", test: documents };

    case "FF-08":
      return { ...row, status: BUILT, route: "src/lib/formats/psd-reader.ts + Forge", nuance:
        "Parses the PSD header (both versions, channel count, dimensions, depth), colour-mode data, image resources, layer records with names including the Unicode `luni` name, rectangles, blend keys, opacity, visibility, clipping, channel data and group markers, and the composite. A layer whose length field runs past the end of the file is a hard error, not a short read — a truncated PSD used to parse as a success and that was a real bug. Up to four bytes of padding disagreement is tolerated with a warning, because some writers pad differently. RLE and ZIP composites are reported as null with a warning instead of being invented. Limits: no vector masks, no shape layers, no adjustment layers, and no to-raster output.", test: documents };

    // ── Browser surfaces ─────────────────────────────────────────────────
    case "PR-07n":
      return { ...row, status: BUILT, route: "src/lib/find/page-find.ts + Browser find bar", nuance:
        "Four modes with explicit rules: the three literal modes choose case for the user, while regex mode is case-SENSITIVE and adds no `i` flag, because the pattern is the user's own expression and silently changing it would change what they asked for — case-insensitivity is spelled [Qq] in the pattern. Whole-word uses Unicode-aware lookarounds rather than \\b, because \\b splits café and naïve at the accent boundary. An invalid pattern is reported as an error with zero matches, never thrown. Matches never overlap and are returned in order. Replacement text is inserted literally, so $& is not special. A valid query after an invalid one clears the stale error. Limits: no cross-iframe search, no PDF text search, and no regex time-limit guard against catastrophic backtracking.", test: systems };

    case "PR-08":
      return { ...row, status: BUILT, route: "src/lib/viewer/viewer-engine.ts + Viewer", nuance:
        "View state for PDF, image and SVG: page, zoom, rotation, pan and fit. Zoom is about the cursor, so the point under the pointer stays under the pointer — the maths is pinned by a test that transforms a point before and after and compares. Rotation swaps the effective width and height at 90° and 270° and re-applies an active fit, because a fit computed before rotating is wrong after. Pan is clamped so at least part of the page is always on screen: an irreversible blank viewport is the classic viewer dead end. Limits: this is the state machine only — the caller renders; there is no text extraction here (that is FF-03), no annotation, and no continuous-scroll virtualisation.", test: media };

    // ── Time and alarms ──────────────────────────────────────────────────
    case "CK-01":
      return { ...row, status: BUILT, route: "src/lib/timers/timer-engine.ts + Clock", nuance:
        "Daily and weekly alarms are computed in local wall-clock time from a caller-supplied UTC offset, so a 09:00 alarm stays 09:00 across a DST change instead of drifting to 08:00. A machine that slept through several days fires once on wake and reschedules from now, rather than firing every missed occurrence in a burst. Snooze is bounded to 1–1440 minutes and the fire log is capped at 200 entries. Limits: the offset is supplied by the caller; this module does not contain the IANA time-zone database and cannot resolve historical or future DST rules on its own, and there is no notification permission handling here.", test: systems };

    // ── Privacy ──────────────────────────────────────────────────────────
    case "SC-07":
      return { ...row, status: BUILT, route: "src/lib/privacy/dashboard.ts + Vault", nuance:
        "Sealed → unlocked → locked → destroyed, with the policy this module actually owns rather than a claim about the platform's crypto. Rate limiting counts FAILURES only; a throwing verifier counts as a failure, and a success resets the counter — an earlier version counted successes too, which locked a user out after five good unlocks. A destroyed container is terminal and its hash is cleared. containerCaveats() states plainly what is not claimed, including that deleting a record is not flash-level erasure. Limits: the key derivation and the storage layer are the caller's; this module does not claim to be audited, does not claim protection against a hostile extension reading the page, and does not hide the fact that a container exists.", test: systems };

    // ── Scheduling and memory ────────────────────────────────────────────
    case "RG-02":
      return { ...row, status: BUILT, route: "src/lib/governor/load-governor.ts + Scheduler", nuance:
        "Heavy work is deferred by 1500 ms times a multiplier that runs from 1 at COOL to 8 at THROTTLED, and is refused outright at CRITICAL unless the user initiated it. Every deferral carries the reason so the UI can explain itself. Limits: this is a policy layer, the actual timer is the caller's, and nothing here can interrupt work that has already started.", test: systems };

    case "RG-06":
      return { ...row, status: BUILT, route: "src/lib/governor/load-governor.ts memoryPolicy", nuance:
        "Low-memory mode names exactly what degrades (thumbnail resolution, cache sizes, prefetch depth, animation) and exactly what is unaffected (input latency, already-open documents, save correctness). A mode that cannot say what it protects is indistinguishable from a placebo. Limits: it cannot force the browser to release memory, cannot override another tab's usage, and does not predict an OOM crash.", test: systems };

    case "HW-02":
      return { ...row, status: BUILT, route: "src/lib/workers/pool-planner.ts + worker pool", nuance:
        "Pool size depends on the work: cores-1 for CPU-bound (leaving the main thread a core), min(16, 2×cores) for I/O-bound, round(0.75×cores) for mixed, and exactly 1 FIFO worker for work that cannot be parallelised. A memory budget and a load level can both shrink the pool, and the plan says which one did and by how much. Speedup is Amdahl-honest: 1/(serial + (1-serial)/poolSize) with serial = (1-cpuShare)+0.05, so it never claims perfect scaling. Pool statistics compute the mean from summed durations rather than averaging per-worker means, which would weight a busy worker equally with an idle one. Limits: this plans a pool, it does not create threads; hardwareConcurrency is a hint the browser may lie about, and a Worker is not a preemptive thread.", test: systems };

    case "HW-05":
      return { ...row, status: BUILT, route: "src/lib/workers/pool-planner.ts audioBudget + Share", nuance:
        "Total latency is base + output + bufferFrames/sampleRate, and the result is classified against perceptual bands: tight at or under 10 ms, acceptable at or under 40 ms, otherwise laggy. Convolvers are charged about 12% of the callback budget each. A 15% safety margin is applied rather than filling the budget exactly. The sample-rate floor is 22.05 kHz: 8 kHz is telephony and cannot carry music, and accepting it was a real bug. Limits: these are engineering budgets, not measurements — the module cannot observe the driver's real buffer, and on some platforms the reported hardware latency is wrong in the optimistic direction.", test: systems };

    // ── Accessibility ────────────────────────────────────────────────────
    case "AX-07":
      return { ...row, status: BUILT, route: "src/lib/a11y/captions.ts + Captions", nuance:
        "Cue model in integer milliseconds with a 700 ms floor and a 12 s ceiling, and overlaps rejected rather than resolved — silently trimming one of two overlapping cues throws away someone's words. Wrapping allows two lines of 42 characters and hard-splits a word longer than a line while dropping what will not fit, because spilling past the width is the worse failure. auditTrack flags reading rates above 25 chars/s (17 for children's content), sub-700 ms cues, past-the-end cues, gaps under 34 ms that read as flicker, and adjacent cues from the same speaker that should have been merged. WebVTT round-trips including <v Speaker> voice spans. Limits: no auto-transcription, no speaker diarisation, no SRT styling, and the reading-rate thresholds are guidance, not a conformance claim.", test: systems };

    // ── Media ────────────────────────────────────────────────────────────
    case "FF-24":
      return { ...row, status: BUILT, route: "src/lib/lens/image-ops.ts + Lens", nuance:
        "Crop, 90/180/270 rotation, flips, and brightness/contrast/saturation/gamma over straight-alpha RGBA. Four 90° rotations are byte-identical to the original. Contrast pivots on 127.5 and is symmetric about it; saturation uses Rec.601 luma so a desaturated image matches a browser greyscale. Alpha is never touched by a colour operation, which is the usual cause of dark fringes. Every function validates the buffer length first, so a short buffer is an error instead of an out-of-bounds read. Limits: no resampling on rotation (90° multiples are lossless, arbitrary angles are not offered), no 16-bit or CMYK data, and the whole buffer is in memory so a 100 MP image is not supported.", test: media };

    case "MD-08":
      return { ...row, status: BUILT, route: "src/lib/lens/image-ops.ts planTrim + Lens", nuance:
        "A trim is planned, not performed: the start is aligned back to the nearest keyframe at or before the requested point, and the cost is reported as a number of frames that must be decoded and discarded. A cut under one frame is refused; a cut past the end of the media is refused with the actual duration in the message; a clip under 500 ms warns because it is easy to mistake for a mis-click. Export presets are filtered to those that do not upscale the source. Limits: the caller does the muxing and this module cannot verify the keyframe list it is given; the bitrate figures are labelled estimates and are not a measurement of an encoder.", test: media };

    // ── Storage and files ────────────────────────────────────────────────
    case "FM-07":
      return { ...row, status: BUILT, route: "src/lib/files/storage-overview.ts + Storage", nuance:
        "Category buckets, the largest files, the heaviest folders, and tiered duplicate detection: group by size, then by a cheap fingerprint, then confirm with a full hash. Only a confirmed group claims reclaimable bytes — an unconfirmed match is reported as possible and is not deletable, because deleting on a size match is how a file manager destroys data. The scan cost is returned so a caller can see what it spent. Fixed in this pass: 'openxmlformats' contains the substring 'xml', so every .docx used to bucket as text. Limits: it analyses a list the caller supplies and reads nothing itself; it cannot see inside archives, and empty files are excluded from duplicate detection because freeing them frees nothing.", test: media };

    // ── Casting ──────────────────────────────────────────────────────────
    case "CA-13":
      return { ...row, status: BUILT, route: "src/lib/cast/quality-governor.ts + Share", nuance:
        "A six-rung ladder from 1080p60 to 360p10 with a weighted badness score (drops 45%, bandwidth 30%, latency 15%, loss 10%) where bandwidth is judged against the current rung's need rather than an absolute number. Asymmetric thresholds plus a dwell count stop a constant borderline link from oscillating. One catastrophic sample never moves the ladder; a collapse skips two rungs. scaleResolutionDownBy is computed as source height over target height — writing the target height directly, which is the common mistake, produces a two-pixel video. Bitrate keeps 15% headroom and is only re-applied when it moves more than 10%. Fixed in this pass: the streak was counted from the smoothed average, so the governor reacted to its own memory and stepped down while every current sample was good; and applySample returned a bare state, losing the caller's policy on the next call. Limits: RUNTIME HONESTY — the field names read from RTCStatsReport could not be verified against a live Chromium in this environment, so the policy is tested and the stats extraction is not; there is no congestion-control integration and no simulcast layer selection.", test: cast };

    default:
      return row;
  }
}
