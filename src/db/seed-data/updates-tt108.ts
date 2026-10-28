import type { SpecRow, Status } from "./row";

/**
 * TT108 corrections. Two kinds of entry only:
 *   - a row whose recorded nuance was made MORE accurate by a new measurement
 *     (RC-29's honest "power loss unproven" caveat is now partly resolved, and
 *     partly shown to be unmeasurable by this method);
 *   - a row whose first real test this turn exposed something worth recording.
 * Nothing here upgrades a grade that was not earned by a passing test.
 */
type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };

export const UPDATES_TT108: Record<string, Patch> = {
  // TT108: found by running the gate against a PRODUCTION build instead of a development server.
  "WP-06": { status: "built",
    nuance: "Sec-Fetch-Site where sent, else Origin against the request's own host (and the forwarded host behind the preview proxy); safe methods and proxy-session paths are never blocked. A refusal is not answered by the middleware itself but rewritten to /api/refused (TT37: answering in place left an unhandled ECONNRESET when the client hung up). TT108 found that the rewrite target was itself matched by the middleware, so the rewritten request — still carrying the cross-site Origin, or the malformed body — was refused and rewritten again. A development build absorbed the loop; a production build proxies each hop over HTTP, so every CSRF refusal and every malformed-JSON refusal returned 500 after exactly thirty seconds. Reproduced on the TT107 build too, so the defect was old and only a production-mode gate could see it. The repair exempts the refusal target, compared with trailing slashes stripped because a rewrite inherits the original path's trailing slash. The exempt endpoint answers only 400 or 403, writes nothing, bounds its message to 300 characters and cannot be promoted by a forged header.",
    test: "tt35-unit.mts; e2e-tt35.mts; tt108-refusal.mts (every body-taking route refuses in <3s and writes nothing; the exempt path cannot be turned into a bypass, a 200 or a loop; six mid-refusal socket resets leave the server answering)" },
  "RC-29": { status: "partial",
    nuance: "A real production server is SIGKILLed while its publication transaction is parked between the media and receipt writes by a PostgreSQL advisory lock. Durable sequence witnesses prove the media insert executed and the receipt insert was reached; after the kill no media row, receipt row, search entry, journal row or audit row survives, and the restarted server republishes cleanly. TT108 UPDATE: the engine itself is now crashed too (RC-30), which closes the 'application process only' half of this gap. Power-loss/fsync durability stays unproven, and TT108 measured WHY: killing a process cannot discard the operating system page cache, so fsync=off is indistinguishable from fsync=on by any process-level experiment.",
    test: "tt107-crash.mts (application process) + tt108-engine-crash.mts (database engine)" },
  "RC-03": { status: "partial",
    nuance: "Largest viewport-intersecting box among first 200 canvas/video/img candidates, found by streaming traversal; raster PNG, not original bytes or whole-page screenshot. Origin-clean, <=16 MP and <=8 MiB required. Tainted/protected surfaces fail, no refetch fallback. Producer page is not trusted attestation. TT108: the same decoded-pixel discipline now also backs a counted batch of the whole document (RC-31), which reports each refusal by name instead of shrinking the batch silently.",
    test: "e2e-tt103-memory.mts; batch form in tt108-recall.mts" },
  // --- rows that had never been tested until this turn; nuance now records what was
  // --- actually measured, including what the measurement cannot speak for.
  "LN-07": { status: "built",
    nuance: "These are real browser DSP paths (the same WebRTC APM the native spec wanted); we expose them as toggles with a live level meter proving the effect. TT108 first test: Lens is observed asking getUserMedia for echoCancellation, noiseSuppression and autoGainControl together, and the resulting live track reports all three as applied in getSettings(). Measured against Chromium's synthetic capture device, so the constraint path is proven end to end while acoustic quality on real hardware is not.",
    test: "e2e-tt108-shell: requested constraints and applied track settings agree" },
  "LN-08": { status: "built",
    nuance: "Runs on the audio thread so layout cannot cause clicks; 100 ms hold keeps word tails intact; raw-track fallback if worklets are unavailable. TT108 first test: the gate is confirmed to be a real AudioWorkletNode in Lens's own AudioContext, and the shipped processor is fed a 440 Hz tone at amplitude 0.2 — with the threshold below the signal it passes (RMS > 0.05) and with the threshold above it the output falls by more than 10x. A synthesised tone, not a voice, so word-tail behaviour is designed-for rather than measured.",
    test: "e2e-tt108-shell: measured attenuation across the threshold" },
  "LN-04": { status: "built",
    nuance: "The filter chain is built once per settings change, not per frame. TT108 first test: moving the brightness control from 0.5 to 1.8 changes the mean luminance of the real rendered canvas (about 49 to 163 on the synthetic feed) and returns when moved back, so the chain affects actual pixels rather than only a label. The canvas stays readable, which also shows the camera layer does not taint it.",
    test: "e2e-tt108-shell: rendered-pixel luminance follows the control" },
  "WM-15": { status: "partial",
    nuance: "Honest split: Lens/Media/Capture windows can be cast because they own a canvas or MediaStream; arbitrary DOM windows cannot be painted to a canvas without a rasteriser, so the UI offers 'share this screen region' instead of lying. TT108 first test: the stream a canvas-backed window publishes is live, carries an audio track, advances its clock by more than 0.1 s per second and produces pixel-different frames 900 ms apart — a moving picture, not a frozen one. The DOM-only half of the split is still untested.",
    test: "e2e-tt108-shell: published window stream is live and moving" },
  "AP-04": { status: "built",
    nuance: "Never reloads under the user; the update is taken only after explicit consent. TT108 first test: with every ServiceWorker.postMessage observed, a full shell session sends no 'skip-waiting' and leaves no waiting worker unoffered, so nothing is applied without the toast action. This proves the no-silent-update invariant; the consent path itself still needs a second deployed version to exercise.",
    test: "e2e-tt108-shell: no service-worker message without consent" },
  "DP-12": { status: "built",
    nuance: "Native pickers for files, screens and devices. TT108 first test: Recall's media chooser is a genuine input[type=file] with a media accept list and single-select, and clicking it raises a real browser file-chooser event rather than an in-page imitation. Screen and device pickers are permission-gated and are not covered by this test.",
    test: "e2e-tt108-shell: a real filechooser event is raised" },
  "DP-06": { status: "built",
    nuance: "Keyboard completeness, measured rather than asserted. TT108 first test: forty Tab presses from the document body reach at least ten distinct controls (identified by role and position, so repeated slider shapes are not mistaken for one another), include both buttons and inputs, never stick on one element, and Shift+Tab followed by Tab returns to the same control. Reachability and absence of a trap are covered; a full roving-tabindex audit of every module is not.",
    test: "e2e-tt108-shell: Tab traversal reaches controls without a trap" },
  "RC-27": { status: "partial",
    nuance: "Filters every saved memory by save method, page host and capture date entirely in PostgreSQL, over the receipts this app wrote. Returns metadata only, at most 100 rows. Receipts that are not valid JSON are skipped and counted, never aborting the query. Not content search: no OCR, transcript or semantic index, and receipt facts are integrity data, not authenticated provenance. TT108: the same guarded receipt projection now also drives the day-grouped timeline (RC-32), and two further save methods are filterable (batch-loaded-visuals, cropped-preview-region).",
    test: "tt107-recall.mts; timeline reuse in tt108-recall.mts" },
};
