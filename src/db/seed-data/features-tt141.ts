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

    default:
      return row;
  }
}
