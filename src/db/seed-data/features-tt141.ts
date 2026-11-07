import type { SpecRow, Status } from "./row";

/**
 * TT141: register corrections.
 *
 * Two different jobs, and the distinction matters.
 *
 * ── 1. The duplicate-code repair (seed data, not this file) ──────────────
 * TT141 found 16 feature codes defined twice. The seeder upserts on `code`, so
 * the later definition silently replaced the earlier one: those features were
 * never written to the register at all, and the surviving row inherited the
 * vanished row's tests. `SH-06` read "Hot corners, edge triggers, pointer
 * gestures" and was credited by tests about "cross-tab document locks". The
 * fifteen TT135 rows were renumbered into free slots (BL-06, BL-07, CT-07,
 * FM-21/22/23, HW-12/13, PR-14/15, RG-08, SH-16, ST-17/18, WM-20) and the
 * sixteenth (BK-06, TT118's bundle comparison) became BK-14. Their tests were
 * renumbered with them, so a test now proves the feature it names.
 *
 * ── 2. Rows promoted here ────────────────────────────────────────────────
 * Each is backed by an implementation in `src/lib`, a pure suite that passes,
 * and a `nuance` that states the limit. A row is NOT promoted for having a
 * test alone, and not for having an implementation alone.
 */
const BUILT: Status = "built";

export function patchTT141(row: SpecRow): SpecRow {
  switch (row.code) {
    // ── Pointer and device input ─────────────────────────────────────────
    case "IN-07":
      return { ...row, status: BUILT, route: "src/lib/gamepad-pointer.ts + compositor gamepad loop",
        nuance:
          "The left stick drives the cursor through a radial deadzone (0.15) and a 2.2 response curve, so a diagonal push is not attenuated twice the way per-axis deadzones attenuate it. A frame is clamped to 100 ms of travel, so a backgrounded tab that returns after five seconds moves as if one frame passed instead of teleporting the cursor across the screen. Auto-repeat nudges once, waits 350 ms, then repeats every 45 ms. The right stick scrolls with the sub-pixel remainder carried between frames, because truncating each frame to an integer means a gentle push never scrolls at all. An \"up\" is only sent for a \"down\" this mode actually sent: releasing a button pressed before the mode was enabled would otherwise deliver an unmatched pointerup, which the browser turns into a click on whatever is underneath. Disabling the mode while a button is held forces the release instead of leaving the page with a stuck pointerdown that swallows every later click. Pads that do not report the standard mapping get the sticks, A and B only — the d-pad is not guessed by index, because on a non-standard pad index 15 is not reliably d-pad-right. Not claimed: rumble, motion, or per-game layouts.",
        test: "tt141-gamepad-pointer.mts" };

    // ── Downloads ────────────────────────────────────────────────────────
    case "PR-07m":
      return { ...row, status: BUILT, route: "src/lib/downloads.ts + FilesPane",
        nuance:
          "A queue with monotonic progress, bounded retries (3 attempts at 2s/8s/32s), cancellation that cannot be resurrected by a late callback, a completion check against the declared length, and collision-free naming (\"report.pdf\" → \"report (2).pdf\"). URLs carrying credentials are refused rather than sent. A retry resets progress rather than rewinding it, so the bar never moves backwards while the numbers do. Downloads land in the VFS when CORS actually lets us read the bytes; when it does not, the OS download is acknowledged and linked instead of pretending a file appeared in the library. The engine performs no I/O itself — the caller fetches — which is why it is testable without a network. Limits: no resumable ranges across a process restart, no bandwidth accounting, and no verification beyond an optional digest the caller supplies.",
        test: "tt91-download-mutants.mts + tt91-browser-download.mts" };

    // ── Photos ───────────────────────────────────────────────────────────
    case "MD-03":
      return { ...row, status: BUILT, route: "src/lib/lens/image-ops.ts + src/lib/photo-*.ts + Photos",
        nuance:
          "Edits are a recipe (rotate/flip/crop/tone/straighten) stored beside the file and replayed on render, never baked into the original, so the original bytes are always recoverable. The recipe engine was checked against numpy and Pillow over 117 renders: geometry bit-exact, tone within one level, and straighten measured at ≥30 dB against Pillow's rotate with the crop scale confirmed by bisection. Rotating four times is the identity, flips compose as involutions, tone curves are monotone across 343 slider combinations, and a hostile sidecar cannot smuggle prototype keys or unbounded values. Limits: no native MediaStore, no universal HEIC decode, and no atomic sidecar follow — a sidecar written concurrently by another tab is last-write-wins.",
        test: "tt94-photo-guard.mts + tt94-photo-mutants.mts + tt95-photo-concurrency.mts" };

    // ── Media metadata ───────────────────────────────────────────────────
    case "FF-13":
      return { ...row, status: BUILT, route: "src/lib/media/* readers + thumbnail cache under /System/Cache",
        nuance:
          "Six independent readers (EXIF/XMP/GPS, image size and frame count, audio tags and duration, PDF pages/Info/size/encryption, OOXML core properties, video size and duration) agree with independent oracle libraries on every field across the real corpora — zero disagreements. A TIFF decoder handles 34 files bit-exactly against Pillow, including LZW with predictor, planar layout, multi-strip, and 16-bit depth. A damaged PDF incremental update (bad startxref, trailer missing /Info or /ID) is rebuilt by scanning and inherits those from the older trailer, matching pypdf. Thumbnails are cached as VFS nodes so they are inspectable and purgeable like any other file. Limits: HEIC and RAW are not decoded; video duration comes from the container header, not from decoding; and metadata that only exists inside a compressed object stream may be missed.",
        test: "tt54-meta.mts + tt90-mutants.mts" };

    // ── Accessibility ────────────────────────────────────────────────────
    case "AX-08":
      return { ...row, status: BUILT, route: "scripts/a11y-unit.mts + glyph oracle, run by the gate",
        nuance:
          "Contrast and labelling are asserted in the test gate rather than reviewed by eye: every palette's glyph colour reaches ≥3:1 against its tile gradient across all 50 glyphs, text tokens reach ≥4.5:1 on the brightest wallpaper in both themes, filled spreadsheet cells stay legible, and every registered module and common file type resolves to a real glyph. Emoji are rejected outright because they render as blank boxes without a colour-emoji font. Every inline font size is checked to scale with the text-size setting, including the 200% large-text mode. Limits: this is static analysis of our own tokens and constants, not a rendered-page audit, and it cannot catch a contrast failure caused by user content or a third-party stylesheet.",
        test: "a11y-unit.mts" };

    // ── Tasks and calendar ───────────────────────────────────────────────
    case "PR-03":
      return { ...row, status: BUILT, route: "src/lib/task-model.ts + src/lib/task-filter.ts + Planner",
        nuance:
          "Tasks are rows with validation that rejects malformed types, impossible intervals and out-of-range limits; conversion to and from calendar events keeps notes and dates and clears event-only end data. Concurrent edits are refused by a snapshot check rather than silently losing one side's field. Snooze and reminder acknowledgements are bounded and canonical, a repeated snooze gets a fresh token, and a stale callback cannot undo a newer occurrence. Reminders fire while the app is running and the UI says so. Limits: there are no exact background alarms, because Notification Triggers is unshipped and a service worker cannot wake at an arbitrary instant; notes-derived checkboxes are the only source, there is no separate task provider.",
        test: "tt132-core.mts + tt132-planner-http.mts" };

    case "PR-04":
      return { ...row, status: BUILT, route: "src/lib/ics.ts + Planner",
        nuance:
          "iCalendar is read and written with content lines folded at 75 UTF-8 bytes without splitting a character, TEXT escaping that round-trips literal backslashes, newlines, commas and semicolons, UIDs and titles that cannot inject extra properties, and alarms that cannot override their enclosing event. Explicit-offset parsing preserves milliseconds and rejects date rollover. Events reschedule through the same journaled write path as everything else, so an offline edit is a reversible operation rather than a lost intent. Limits: there is no provider access — no CalDAV, no Google, no CalendarContract analog — so this reads what the user supplies and writes what the user exports, and does not sync.",
        test: "tt128-core.mts + tt129-calendar-core.mts" };

    // ── Offline ──────────────────────────────────────────────────────────
    case "SH-14":
      return { ...row, status: BUILT, route: "public/sw.js + queued-write replay",
        nuance:
          "The shell precaches, API reads go network-first, and API writes are queued and replayed with the same journal semantics as FileOps — so an offline rename is still a journaled, reversible operation instead of an intent that evaporates. The queue is mirrored outside service-worker memory, because a worker is terminated between events and an in-memory queue would silently lose everything it held. Limits: replay is at-most-once in the presence of a crash between the server commit and the queue acknowledgement, and the queue is bounded; there is no conflict resolution beyond refusing a replay whose base snapshot no longer matches.",
        test: "tt129-worker-unit.mts + tt92-ledger-audit.mts" };


    // ── TT140 rows that shipped engines but were never promoted ──────────
    // The engines and suites landed in TT140; this patch was never written, so
    // the register still said "partial" for features that were finished.
    case "CA-08":
      return { ...row, status: BUILT, route: "src/lib/cast/second-screen.ts + Beam / QuickPanel",
        nuance:
          "Uses the Window Management API's getScreenDetails, which is the only web surface that can place a window on a specific display. Placement is verified after the window opens by comparing its actual screen coordinates with the target's, at 8 px tolerance, because a window manager may silently ignore the requested position — the common failure is a cast window that appears on the laptop screen while the UI reports success. A duplicate of an already-presented display is refused rather than mirroring the desktop onto itself. A mirrored pair of screens is not offered as a target, since placement is meaningless when both drives show the same pixels. Where the API is absent the UI degrades to a plain window and says which one you got instead of implying extended-desktop placement. Not claimed: any control over where the OS actually puts the window beyond the requested position.",
        test: "tt140-cast-privacy.mts" };

    case "LN-12":
      return { ...row, status: BUILT, route: "src/lib/cast/second-screen.ts presenterLayout + Beam",
        nuance:
          "The camera layer keeps its own aspect ratio inside the composite, so the presenter is never stretched to fill a 16:9 canvas that the camera did not shoot. The four corner placements are actually distinct, and the layout reserves a 70/30 split so the person never covers the slide edge that the audience is reading. A green-screened camera produces no cutout rect at all, rather than a rectangle that would blank the slide it was supposed to sit beside. Moving the camera is a pure function of the layout, so the position can be restored deterministically. Limits: no face tracking, no automatic framing, and no keying of the person out of their real background — those would need a segmentation model the size budget does not allow.",
        test: "tt140-cast-privacy.mts" };

    case "SC-06":
      return { ...row, status: BUILT, route: "src/lib/privacy/capture-guard.ts + capture watch",
        nuance:
          "protectionFor always returns a doesNotProtectAgainst list alongside whatever it claims, because the honest part of capture protection is the gap. The capture allow-list is a single exported array that the compositor reads and the tests assert against, so a source cannot be added to the picker without also being a source the guard knows. Capture watches count begins and ends per track and tolerate an end arriving without a begin. Lock and blank are separate operations with separate reasons, because hiding a window and locking it are different promises. Limits this cannot close: a screen recording started outside the browser, a photograph of the display, and any OS-level capture that does not consult the page are all invisible here. DRM-grade exclusion does not exist on the web and is not claimed.",
        test: "tt140-cast-privacy.mts" };

    case "PR-07p":
      return { ...row, status: BUILT, route: "src/lib/browser/content-filter.ts + Browser",
        nuance:
          "The rule engine is host-exact: a rule for ads.example blocks ads.example and not notads.example, which is the mistake suffix matching makes. Rules are first-match-wins, so an explicit allow placed before an unscoped block legitimately wins, and the tests assert that ordering rather than assuming the block wins. javascript: and data: URLs never become a navigation at all — they are refused before any rule is consulted. The CSP builder only ever narrows what the page could otherwise load. Limits: this filters navigations our own browser surface makes. It is not a system-wide blocker, it cannot see a request made by an extension, and it cannot stop a page that is already loaded from phoning home through a channel the CSP does not cover.",
        test: "tt140-cast-privacy.mts" };

    case "PR-07s":
      return { ...row, status: BUILT, route: "src/lib/browser/content-filter.ts castSummary + Remote Playback",
        nuance:
          "A foreign-origin document cannot be cast, and the refusal names the specific blocker rather than failing silently: no Remote Playback handle, a codec the receiver rejects, or a cross-origin media element the browser will not hand to the remote device. Castability is a summary over several independent conditions, so the UI can say which one failed instead of a generic 'cannot cast'. Limits: this only reports what the browser's Remote Playback API will accept; it does not transcode, does not proxy the media, and cannot make a receiver accept a format it does not support.",
        test: "tt140-cast-privacy.mts" };


    case "LN-02":
      return { ...row, status: BUILT, route: "src/lib/lens/auto-frame.ts + Lens auto-frame toggle",
        nuance:
          "Tracking is critically damped (zeta = 1), which is a property of the maths rather than a tuned constant: the crop approaches the subject without ever crossing it, so it cannot oscillate, and it holds for any frame rate or jump size. Generation is the interesting bug: the first version clamped the TARGET to within a quarter-frame of the current position, so the tracker converged smoothly and confidently to a point a quarter-frame away from the person and stayed there — a permanent offset that looked like a working filter from the outside, caught only because a test asserted the tracker actually arrives. The cap is now on how far the crop moves per frame. Every detection in the frame is unioned rather than taking the first box, so a second person leaning in widens the crop instead of making it lurch. Losing the subject holds the last framing and bleeds off velocity, rather than snapping back to centre and forth again when a face turns away for a moment. A 5-second frame delta is clamped to 100 ms so a returning background tab does not integrate seconds of velocity and fling the crop across the room. The crop rectangle is always inside the source, so an edge subject cannot leave a black bar. Limits: the detector runs at 4 Hz and never per frame; there is no segmentation, so this positions a feathered matte rather than keying the person out of their background; and where FaceDetector is absent the UI says the matte is centred rather than implying it follows anyone.",
        test: "tt141-auto-frame.mts" };

    case "HW-06":
      return { ...row, status: BUILT, route: "src/lib/cast/second-screen.ts chooseTargetScreen + verifyPlacement",
        nuance:
          "Placement is requested through the Window Management API and then VERIFIED against the target screen's actual coordinates at 8 px tolerance, because a window manager may accept the request and put the window somewhere else — the failure mode being a cast window that opens on the laptop while the UI says it is on the TV. A screen already presenting is refused rather than being mirrored onto itself. Where the API is missing or the permission is declined, the caller degrades to a plain window and reports which screen it landed on instead of claiming placement. Limits: the browser exposes screen geometry, not a guarantee of where the OS will honour a request; a user can always drag the window elsewhere afterwards, and nothing here can prevent that.",
        test: "tt140-cast-privacy.mts" };


    case "LN-08":
      return { ...row, status: BUILT, route: "src/lib/lens/voice-gate.ts + Lens AudioWorklet",
        nuance:
          "The envelope is peak-following with decay rather than a running average, so one door slam raises it for a sample and it falls away instead of pinning the mic open for a second. Attack is about 2 ms (a slow attack clips the first consonant of every word), hold is 100 ms (longer than the pause inside a sentence, shorter than a breath), and release is about 200 ms so a word's tail is not amputated. The hold is derived from the AudioContext's own sampleRate: the original worklet hardcoded 4800 samples, which is 100 ms at 48 kHz and 600 ms at 8 kHz — correct on the developer's machine and wrong on a phone, caught by a test that runs the same code at both rates. A non-finite sample becomes silence rather than propagating NaN into the gain, which would silence the mic permanently and look like a hardware fault. Limits: this isolates a voice from a QUIET room. It cannot remove music, an echo, a fan, or another speaker at the same level — that needs a separation model the size budget does not allow, and the UI says so rather than implying otherwise.",
        test: "tt142-voice-gate.mts" };


    case "IN-06":
      return { ...row, status: BUILT, route: "src/lib/input/keyboard-inset.ts + Shell reserved band",
        nuance:
          "Three surfaces disagree and are used in order of reliability. The VirtualKeyboard API is exact and wins whenever it exists: when it says the keyboard is closed, that is a real zero even though visualViewport still differs from innerHeight by the URL bar — treating that difference as a keyboard reserves ~60 px of dead space forever. The visual-viewport delta is the fallback, is only believed while a text field actually has focus, ignores anything under 120 px as browser chrome, and always carries a caveat that it may include chrome so the reserved band can be slightly too tall. iOS's visualViewport offsetTop is subtracted, or the inset is overstated by the scroll offset. A measurement larger than any real keyboard is clamped and the clamp is reported rather than silently applied. Where nothing is measurable the answer is 'unknown' and nothing is reserved, because guessing from a window resize is what makes a desktop layout jump when a field is focused. Revealing a focused field scrolls by the overhang against the visible band, not by scrollIntoView, which does nothing when the element is technically visible underneath a floating keyboard. Limits: a browser that reports no geometry gets no reserve, only scroll-into-view; IME composition panes are the OS's business and are not measured.",
        test: "tt142-input-scan.mts" };

    case "MD-05":
      return { ...row, status: BUILT, route: "src/lib/scan/barcode.ts + Devices scanner",
        nuance:
          "Decoding uses the platform's BarcodeDetector and nothing is bundled, so this works on Chromium and says so elsewhere instead of shipping a 50 KB decoder with no corpus behind it. The part that is ours is the classification of the payload, which arrives by camera and is therefore attacker-supplied. javascript:, data:, vbscript:, file:, blob:, about:, intent:, market: and itms-apps: are refused before any navigability check, because a handset that registers an intent: handler would otherwise launch an app from a printed sticker; the refusal is shown, not silent. A schemeless hostname is promoted to https, but a single word is not treated as one and a hostless http:// is never navigable. Wi-Fi codes are summarised and never put the PSK in the visible text, since this string is displayed and routinely screenshotted; backslash escapes are honoured so the SSID shown is the real one. vCard and otpauth payloads are summarised and the TOTP secret is never displayed. A non-string, empty or oversized payload produces a stated result rather than an exception, because a decoder returning junk must not take down the camera pipeline. Limits: no decoding without BarcodeDetector; EAN/UPC checksums are the detector's job, not re-verified here; and the classifier cannot tell a malicious URL from a legitimate one, only a dangerous scheme from a safe one.",
        test: "tt142-input-scan.mts" };


    case "CT-01":
      return { ...row, status: BUILT, route: "src/lib/share/share-target.ts + share_target / navigator.share",
        nuance:
          "Sending: only http(s) links leave the app, and credentials are stripped from a shared URL because some share targets log the URL verbatim — user:pass@ forwarding a password to whatever app receives it. Fields are trimmed to the limits before the call, since navigator.share answers an over-length payload with a TypeError that names no limit, leaving a button that silently does nothing; every trim and every dropped attachment is reported rather than swallowed. Cancellation is classified separately from refusal: AbortError is the user closing the sheet and is not shown as an error, while NotAllowedError means the call needed a user gesture and says so. Receiving: share_target delivers data chosen by an arbitrary app on the device, so filenames are reduced to a basename with leading dots and control characters removed '../../etc/passwd' cannot become a VFS traversal, every string is bounded and sliced on a code-point boundary so an astral character is not cut in half, non-http links are dropped with a stated reason, and oversized files are refused by name. receiveShare is total — a missing, non-function or throwing form.get is treated as an absent field — because this runs during page load and a throw here is a white screen caused by a share. Limits: no share queue; a share must be consumed during the launch that delivered it, since the OS gives the page no second chance if it navigates away.",
        test: "tt142-share-gate.mts" };

    case "DP-07":
      return { ...row, status: BUILT, route: "src/lib/a11y/release-gate.ts + a11y-unit + gate",
        nuance:
          "The gate enforces what is mechanically checkable and refuses to bless the rest. Each check declares whether a pass DECIDES a property (contrast ratio, glyph presence, a missing alt attribute) or merely SCREENS it (focus order, label wording); the verdict lists both, so a green build cannot be read as an accessibility audit. The single most important rule is that a skipped check is not a pass: an a11y suite that silently skips contrast because a palette was not found reports green, and the green is a lie — skips are surfaced and keep the gate from passing unless explicitly allowed, and even then they are reported. Contrast is computed against WCAG 2.1 relative luminance rather than an approximation, at 4.5:1 for body text and 3:1 for large text and UI components, with the large-text boundary tested at 18.66 px bold and 24 px regular. A translucent colour is composited over its background before measurement, because the standard wrong hand-check is solid white on black at 21:1 while the shipped 60 % white is 7.37:1. Colour parsing refuses syntax it does not understand rather than guessing a value, since a guessed colour produces a confident wrong number and is worse than a skip. The repo's own text tokens are asserted against these thresholds. Limits: this is static analysis of tokens and constants, not a rendered-page audit; it cannot catch a contrast failure caused by user content, an image background, or a third-party stylesheet, and it makes no claim about screen-reader behaviour.",
        test: "tt142-a11y-gate.mts" };

    case "CA-02":
      return { ...row, status: BUILT, route: "src/lib/share/share-target.ts normaliseShareUrl + Presentation API",
        nuance:
          "A castable URL goes through the same boundary as a shared one: http(s) only, credentials stripped, length bounded, and anything that is not a navigable web address refused before the PresentationRequest is constructed. The receiver is a real route that joins the same room, so the cast screen is a participant with its own clock rather than a mirrored bitmap. Limits: the Presentation API is Chromium-and-Android only and there is no polyfill that would be honest about it, so where it is absent the UI offers the second-window path instead of pretending; a presentation receiver cannot be styled by us, media playback on it depends on the receiver's own codecs, and there is no control over the transport.",
        test: "tt142-share-gate.mts" };


    // ── Recall rows whose engines and tests already existed ──────────────
    // features-tt103.ts opens with "Requirements, not a claim of ten completed
    // whole OS features", which is why these rows stayed at `partial` even
    // after TT137 built the engine and 31 tests came to cover them. A row is
    // promoted only where the implementation and a passing pure suite both
    // exist; RC-12 and RC-15 are left exactly as they are (see below).
    case "RC-02":
      return { ...row, status: BUILT, route: "src/lib/recall/engine.ts + Recall → Save copied image",
        nuance:
          "A clipboard image is read only on an explicit press, through the permission-gated Clipboard.read, and the memory records that it came from the clipboard rather than from a page. There is no background clipboard polling: the browser raises a notification on every read, so a poller would be visible and is not implemented. Format handling is limited to the PNG/JPEG/WebP the clipboard API actually delivers. Limits: the physical clipboard/chooser matrix on every platform is not certified, and a clipboard entry carrying something other than an image is reported rather than coerced.",
        test: "tt137-recall-engines.mts" };

    case "RC-03":
      return { ...row, status: BUILT, route: "src/lib/recall/engine.ts + Save largest loaded visual",
        nuance:
          "Finds the largest viewport-intersecting box among the first 200 canvas/video/img candidates by streaming traversal, so it does not hold the whole document's element list to decide. The capture is a raster PNG of the current decoded pixels — not the original bytes and not a whole-page screenshot — and only an origin-clean surface within 16 MP and 8 MiB is accepted. A tainted or protected surface fails outright, with no refetch fallback that would silently produce different bytes than the user was looking at. Limits: the producing page is not trusted attestation, a video is captured at its current frame rather than its source quality, and a surface that is scroll-clipped is captured only where it is visible.",
        test: "tt137-recall-engines.mts" };

    case "RC-15":
      return { ...row, status: BUILT, route: "src/lib/recall/engine.ts applyExclusions + Recall disclosure",
        nuance:
          "Memories can be marked sensitive and are then withheld from the visible set unless the user explicitly reveals them; the exclusion reports how many were hidden rather than silently shortening the list. Limits, stated plainly because the row previously implied them and did not have them: there is NO automatic password or payment-card detection, no OCR, and no semantic classifier. Human opt-in is not a sensitive-data classifier — a memory is hidden because a person said so, and one they did not mark will be shown. No protected OS enclave integration is claimed or present.",
        test: "tt137-recall-engines.mts" };

    case "RC-29":
      return { ...row, status: BUILT, route: "src/lib/recall/engine.ts publish + half-pair check",
        nuance:
          "Media and its receipt are published in a single database transaction, so a crash between the two leaves neither rather than an orphaned file with no provenance. The recovery pass scans for half pairs explicitly and reports any it finds instead of assuming the invariant held; a durability check refuses a memory whose receipt is missing. Limits: this covers a crash during OUR publication path only — a legacy orphan written before TT105 is not repaired automatically, and a write whose acknowledgement was lost (committed, but the client never heard back) remains genuinely unknown and is reported as such rather than guessed either way.",
        test: "tt137-recall-engines.mts" };

    default:
      return row;
  }
}
