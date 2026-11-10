import { F } from "./row";
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

function patchTT139Main(row: SpecRow): SpecRow {
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

export const tt139Features = [
  F("WM-16", "Windowing", "Cursor confinement", "A", "P2", "pointer-confinement.ts + Shell drag", "Integrates pointer-lock deltas into an absolute virtual-desktop cursor in one shared CSS-pixel space, crossing display seams, clamping at the union bounds, and reporting every refusal (no API, insecure context, no gesture, user prefers the system cursor). Escape is always the documented way out and a drawn cursor replaces the hidden one. Canvas backing stores are resized per display DPR with a pixel cap. Position is never rescaled across displays: the Screen Details space is shared, and rescaling it double-applies the scale.", "built", "tt139-platform.mts WM-16"),
  F("IN-06", "Input", "Virtual keyboard insets", "A", "P3", "keyboard-inset.ts + Shell inset observer", "Reads the VirtualKeyboard API's overlay insets, or derives them from visualViewport as a labelled estimate, clamps an implausible inset to 70% of the height with the reason, writes the four CSS custom properties once per resize, scrolls the focused control into the band by the minimum delta, and re-tiles floating windows with the focused window never resized under the user's finger.", "built", "tt139-platform.mts IN-06"),
  F("ST-02", "System", "Settings index with honest deep links", "A", "P2", "settings-links.ts + Spec settings index", "Classifies the browser (Chromium/Edge/Brave/Opera/Vivaldi/Firefox/Safari/unknown, forks before Chrome) and resolves each of ten settings to open/copy/manual/unsupported. Internal schemes (chrome:, edge:, about:, brave:, opera:, vivaldi:) are never navigable, so the exact address is put on the clipboard with an instruction instead; Safari's menu paths are named rather than turned into fake URLs. An unknown browser is marked as a guess.", "built", "tt139-platform.mts ST-02"),
  F("PR-06", "Publishing", "Mail handoff", "A", "P3", "mailto.ts + Writer/Notes send", "RFC 6068 encoding built from scratch: unreserved characters and @, :, / stay literal, LF becomes %0D%0A, invalid addresses are named and dropped, no stray ? on an empty draft, and an over-budget body is truncated on a character boundary (never inside a percent escape) with a visible marker and a copy fallback. Attachments are impossible over mailto and the module says so instead of adding a mount point that cannot work.", "built", "tt139-platform.mts PR-06"),
  F("PR-07", "Publishing", "Embeddability decision", "A", "P2", "embed-policy.ts + Browser window chrome", "Parses X-Frame-Options (case-insensitive names and values, most restrictive wins across repeats, ALLOW-FROM treated as deny) and CSP frame-ancestors (overrides XFO, understands 'none'/'self'/wildcard subdomain/scheme/port), and reports 'unknown' with inferred=true when no policy was returned rather than assuming allowed. Conflicts between repeated headers are surfaced.", "built", "tt139-platform.mts PR-07"),
  F("FF-06", "Files", "HEIC / AVIF decode honesty", "A", "P1", "media-support.ts + Files preview", "Three platform mechanisms are asked and their disagreement is kept instead of averaged: canPlayType ('maybe' is not upgraded to supported), ImageDecoder.isTypeSupported (a platform image decoder is labelled software decoding, not native), and MediaCapabilities.decodingInfo per configuration (powerEfficient decides native vs software). No decoder is bundled, so the patent-encumbered formats are only used where the platform already has them, and every verdict has a sentence naming the conversion route.", "built", "tt139-platform.mts FF-06"),
  F("SC-06", "Security", "Capture guard with honest guarantee", "A", "P2", "screen-capture-guard.ts + Vault overlay", "No FLAG_SECURE exists on the web, so the module does the three things that do: cover (blur and hide on hidden tab, live self-share track, unfocused grace period, suspected capture tool), deter (a session-and-time watermark tiled across the surface), and state plainly that a page cannot detect another application's recording. The disclosure text says the guard cannot stop an OS recorder or a camera.", "built", "tt139-platform.mts SC-06"),
  F("MS-01", "Connect", "iMessage bridge client", "A", "P3", "media-bridge.ts + Messages module", "Speaks the BlueBubbles-shaped REST contract (ping, chats, thread, send) with the token in an Authorization header and never in a URL; a plain-http bridge is refused unless it is on loopback, because the token would be readable on the network. Responses are validated into typed failures (no data array, error status, malformed rows dropped and counted), and every error path redacts the token before it is displayed.", "built", "tt139-platform.mts MS-01"),
  F("MS-04", "Connect", "Matrix connector", "A", "P4", "media-bridge.ts + Messages module", "Client-server v3 seam: versions probe, joined rooms, backwards-paginated room messages with the required dir and from tokens, and a PUT send with a unique transaction id. Requires https and a real access token; login is deliberately not implemented so no password ever leaves the page. errcode responses become the error text, pagination tokens are kept, and tokens are redacted from every message.", "built", "tt139-platform.mts MS-04"),
  F("AX-06", "Accessibility", "Voice input with consent gate", "A", "P3", "voice-input.ts + Editor dictation", "Off unless the user enables cloud speech in Privacy, because the browser's recogniser sends audio to the vendor; the disclosure names the language and the switch. Interim hypotheses replace the tail, finals commit, and a character budget over the document text (not just the session) prevents a runaway paste. Every stop reason is classified (permission, silence, network, capture, abort, budget) and text is never discarded on stop. No on-device model is claimed.", "built", "tt139-platform.mts AX-06"),
  F("AU-04", "Automation", "Assistant command planner", "A", "P4", "assistant-plan.ts + Routines/Assistant", "No language model is bundled or claimed: a keyword grammar turns a sentence into a plan of shell commands with their arguments, and a sentence whose argument cannot be resolved is returned as a partial with the missing detail named, proposing nothing. A plan is executable only if every command exists in the schema and every argument is known and required ones are present. A missing model is reported as unavailable with the planner offered as what does work.", "built", "tt139-platform.mts AU-04"),
  F("BL-04", "Licensing", "Store gate", "A", "P1", "store-gate.ts + Settings licence tab", "Four legitimate modes (digital-goods, external-link, self-issued, unavailable) and a Pay button renderable only in the first, where the Digital Goods service resolved inside an installed context. A store link must be https; a price from the store is validated (id, title, two-decimal value, ISO-4217 currency) so a missing field is a refusal rather than a button priced at 'undefined'. Self-issued licence files are the honest product when there is no store.", "built", "tt139-platform.mts BL-04"),
  F("LN-02", "Lens", "Auto-frame with damped crop", "A", "P3", "auto-frame.ts + Lens camera", "The subject is the largest detected face plus neighbours within 1.5x area, so a shoulder is not cut off and a distant face does not widen the crop; no faces yields no subject rather than an invented centre. The crop is aspect-correct, keeps headroom, respects a minimum size, and is smoothed by a critically damped filter with a dead zone, so a still subject produces a still crop and no overshoot occurs. FaceDetector availability is probed; the centred crop is the documented fallback.", "built", "tt139-platform.mts LN-02"),
  F("LN-12", "Lens", "Presenter composite layout", "A", "P2", "auto-frame.ts presenterLayout + Lens", "The camera bubble is placed in a corner at the camera's aspect within 12–35% of the stage width, capped at 40% of the height, kept inside the stage by a real margin, and flagged when it covers the slide's own content instead of silently hiding a logo. A stage too small for the requested bubble shrinks it and says so.", "built", "tt139-platform.mts LN-12"),
  F("AU-03", "Automation", "External automation entry", "A", "P3", "automation-entry.ts + Routines entry panel", "One narrow door: a fixed JSON shape naming a routine with typed arguments and no free-form step list, argument names and sizes bounded, and a dry run that blocks the whole routine when any step is unknown, takes an undeclared argument or misses a required one. The local planner checks an optional routine-bound, expiring single-use token for a pasted cross-origin claim; the claim is not authenticated and this planner does not run actions. Server automation is a separate bearer-token endpoint. Actions are shell commands only.", "built", "tt139-platform.mts AU-03"),
  F("TD-04", "Terminal", "Text toolchain", "A", "P4", "text-import.ts + Terminal filter mode", "sort (numeric, reverse, unique with a counted removal, keyed, case-folded), uniq with true adjacent-only semantics and counts, cut with 1-based ordered fields and refusal of a multi-character delimiter, paste with column padding, POSIX wc (bytes, characters, words, lines), and tr with ranges, complement and delete — all on text the user opens. No shell, no executables, no WASM distribution, and the module says exactly that.", "built", "tt139-platform.mts TD-04"),
  F("HW-06", "Hardware", "Multi-screen placement", "A", "P2", "multi-screen.ts + Shell screen placer", "Centres windows in a screen's work area (never under a taskbar), follows the screen a window already overlaps, refuses a screen index that does not exist instead of clamping, shrinks an oversized window with the reason, prefers an external display for presentations, describes a DPI transition with both values, and states plainly when the browser exposes no per-screen geometry.", "built", "tt139-platform.mts HW-06"),
  F("HW-07", "Hardware", "Peripherals (HID/USB/Serial/BT)", "A", "P3", "peripheral.ts + Devices panel", "Each transport is gated on its own API and a secure context with its own sentence; filters are validated before a picker opens (an empty USB filter would list every attached device), privileged USB classes are named, serial's differing filter keys are corrected in a warning, failures are classified (denied/cancelled/busy/protected/unsupported/disconnected) and a serial framer keeps partial frames across chunk boundaries with a bounded carry.", "built", "tt139-platform.mts HW-07"),
  F("HW-09b", "Hardware", "Measured network ladder", "A", "P2", "network-measured.ts + Monitor quality", "Throughput is measured from real response timings with the round-trip subtracted, cache hits rejected and samples under 16 KiB refused as meaningless; the ladder then names an exact resolution, bitrate and frame rate, with metered and battery-saver headroom applied multiplicatively. Step-down triggers on dropped frames or buffering and step-up needs fifteen stable seconds. This is deliberately separate from the API-estimate tier engine so neither can pass a guess off as a measurement.", "built", "tt139-platform.mts HW-09"),
  F("HW-10", "Hardware", "WASM SIMD / threads probes", "A", "P3", "wasm-features.ts + Monitor capability", "Feature support is decided by validating hand-assembled modules that use the instruction (i8x16.splat/add, memory.copy, funcref tables), not by a user-agent string. Threads are reported together with cross-origin isolation, because a shared-memory module can validate and still be unable to start a worker. Inference tiers (WebNN/WebGPU/WASM-SIMD/WASM) are only claimed after a timed run with warm-up discarded and at least three samples.", "built", "tt139-platform.mts HW-10"),
  F("HW-11", "Hardware", "Screen wake lock lease", "A", "P2", "wake-lock.ts + presentation controls", "The wake lock is a lease with an observable state (granted/denied/released/expired) and a reason, capped at four hours, released when the presentation ends, re-acquired when the tab becomes visible again, and refused on a low battery rather than quietly draining it. The status strip prints the real state, and the four system limits (lid, hidden tab, low-power mode, gesture requirement) are listed as data.", "built", "tt139-platform.mts HW-11"),
  F("CT-03b", "Windowing", "Continue-on link", "A", "P2", "handoff-link.ts + Shell handoff", "Window state travels in the URL fragment, which is never sent to a server, as a versioned payload with an FNV-1a checksum, an 8 KiB budget refused rather than truncated, and an expiry checked on arrival. The receiver validates against a module whitelist and drops unknown entries with warnings; a truncated or edited payload fails loudly; the payload is data, never code, and the link is stated not to be encrypted.", "built", "tt139-platform.mts CT-03"),
  F("DP-07", "Diffusion", "Accessibility release gate", "A", "P1", "a11y-gate.ts + a11y-unit", "The gate is a predicate with thresholds passed as arguments: WCAG 1.4.3/1.4.11 contrast per token pair, 4.1.2 accessible names, 2.4.11 hidden-focus traps and 2.5.8 target size with the documented exceptions and a warning/block split. It is run in a11y-unit against the emitted stylesheet tokens and every registered module tile, so a theme change cannot ship below AA. The report lists the barriers automation cannot see, so 'passed' is never read as 'accessible'.", "built", "a11y-unit.mts DP-07"),
];

/** Codes whose earlier row said partial/probe but now have an engine + suite. */
const UPGRADES: Record<string, { route: string; nuance: string; test: string; name: string }> = {
  "WM-16": { name: "Cursor confinement to the active display", route: "pointer-confinement.ts", nuance: tt139Features.find((f) => f.code === "WM-16")!.nuance, test: "tt139-platform.mts WM-16" },
  "IN-06": { name: "Virtual keyboard / IME insets", route: "keyboard-inset.ts", nuance: tt139Features.find((f) => f.code === "IN-06")!.nuance, test: "tt139-platform.mts IN-06" },
  "ST-02": { name: "Browser/OS settings index (deep links)", route: "settings-links.ts", nuance: tt139Features.find((f) => f.code === "ST-02")!.nuance, test: "tt139-platform.mts ST-02" },
  "PR-06": { name: "Mail handoff", route: "mailto.ts", nuance: tt139Features.find((f) => f.code === "PR-06")!.nuance, test: "tt139-platform.mts PR-06" },
  "PR-07": { name: "Embeddability decision", route: "embed-policy.ts", nuance: tt139Features.find((f) => f.code === "PR-07")!.nuance, test: "tt139-platform.mts PR-07" },
  "FF-06": { name: "HEIC / AVIF decode", route: "media-support.ts", nuance: tt139Features.find((f) => f.code === "FF-06")!.nuance, test: "tt139-platform.mts FF-06" },
  "SC-06": { name: "Screen-capture exclusion for sensitive windows", route: "screen-capture-guard.ts", nuance: tt139Features.find((f) => f.code === "SC-06")!.nuance, test: "tt139-platform.mts SC-06" },
  "MS-01": { name: "iMessage via a user-hosted bridge", route: "media-bridge.ts", nuance: tt139Features.find((f) => f.code === "MS-01")!.nuance, test: "tt139-platform.mts MS-01" },
  "MS-04": { name: "Open protocols (Matrix / XMPP) connector", route: "media-bridge.ts", nuance: tt139Features.find((f) => f.code === "MS-04")!.nuance, test: "tt139-platform.mts MS-04" },
  "AX-06": { name: "Voice input", route: "voice-input.ts", nuance: tt139Features.find((f) => f.code === "AX-06")!.nuance, test: "tt139-platform.mts AX-06" },
  "AU-04": { name: "Assistant", route: "assistant-plan.ts", nuance: tt139Features.find((f) => f.code === "AU-04")!.nuance, test: "tt139-platform.mts AU-04" },
  "BL-04": { name: "Store / purchase surface", route: "store-gate.ts", nuance: tt139Features.find((f) => f.code === "BL-04")!.nuance, test: "tt139-platform.mts BL-04" },
  "LN-02": { name: "Auto-frame", route: "auto-frame.ts", nuance: tt139Features.find((f) => f.code === "LN-02")!.nuance, test: "tt139-platform.mts LN-02" },
  "LN-12": { name: "Presenter mode: person over slides", route: "auto-frame.ts presenterLayout", nuance: tt139Features.find((f) => f.code === "LN-12")!.nuance, test: "tt139-platform.mts LN-12" },
  "AU-03": { name: "External automation entry points", route: "automation-entry.ts", nuance: tt139Features.find((f) => f.code === "AU-03")!.nuance, test: "tt139-platform.mts AU-03" },
  "TD-04": { name: "Linux userland", route: "text-import.ts", nuance: tt139Features.find((f) => f.code === "TD-04")!.nuance, test: "tt139-platform.mts TD-04" },
  "HW-06": { name: "Multi-screen placement", route: "multi-screen.ts", nuance: tt139Features.find((f) => f.code === "HW-06")!.nuance, test: "tt139-platform.mts HW-06" },
  "HW-07": { name: "Peripherals (HID/USB/serial/BT)", route: "peripheral.ts", nuance: tt139Features.find((f) => f.code === "HW-07")!.nuance, test: "tt139-platform.mts HW-07" },
  "HW-09": { name: "Network-aware quality", route: "network-quality.ts + network-measured.ts", nuance: tt139Features.find((f) => f.code === "HW-09b")!.nuance, test: "tt135-core-engines.mts HW-09 · tt139-platform.mts HW-09" },
  "HW-10": { name: "WASM SIMD / threads", route: "wasm-features.ts", nuance: tt139Features.find((f) => f.code === "HW-10")!.nuance, test: "tt139-platform.mts HW-10" },
  "DP-07": { name: "Accessibility is a release gate", route: "a11y-gate.ts", nuance: tt139Features.find((f) => f.code === "DP-07")!.nuance, test: "a11y-unit.mts DP-07" },
};

function patchTT139Overlay(row: SpecRow): SpecRow {
  const upgrade = UPGRADES[row.code];
  if (!upgrade) return row;
  return {
    ...row,
    name: upgrade.name,
    route: upgrade.route,
    nuance: upgrade.nuance,
    status: "built" as const,
    test: upgrade.test,
  };
}

/**
 * The union of both TT139 generations.
 *
 * main's version (TT139a) is a switch over the codes whose engines landed in that
 * parallel turn; this branch's version (TT139b) is a table over a different set.
 * Neither is a superset: dropping either would silently un-promote real, tested
 * rows. So the switch runs first and the table only fills codes it left alone —
 * a row already promoted by the switch keeps the switch's wording.
 */
export function patchTT139(row: SpecRow): SpecRow {
  const viaSwitch = patchTT139Main(row);
  if (viaSwitch !== row && viaSwitch.status !== row.status) return viaSwitch;
  const viaTable = patchTT139Overlay(row);
  return viaTable.status === "built" ? viaTable : viaSwitch;
}
