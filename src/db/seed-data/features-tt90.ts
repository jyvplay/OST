import type { SpecRow } from "./row";

/** TT90: describe the tested web work without promoting browser analogues to native features. */
export function patchTT90(row: SpecRow): SpecRow {
  if (row.code === "ST-09") return {
    ...row, status: "partial",
    route: "Settings → Context profiles: browser-local pointer/touch/extended-display density and optional text size",
    nuance: "Opt-in profiles apply without changing the shared base settings; primary pointer and screen.isExtended (where supported and permitted) select a profile, and transitions announce the context. The display bit means any multi-display setup, not which physical screen contains the window. Missing or policy-blocked detection falls back to the primary-pointer profile; in amnesia changes last only for the session. Chromium tests used virtual screens and touch emulation; physical hotplug, Android desktop mode and per-physical-display behavior are unverified. The original automatic phone/desktop behavior is not complete.",
    test: "tt90-context-unit.mts checks validation and selection; e2e-tt90-context.mts uses real Chromium, CDP virtual screens and touch emulation, reload, cross-tab and amnesia checks, and axe. This is partial coverage, not a physical-device test.",
  };
  if (row.code === "FF-13") return {
    ...row,
    nuance: `${row.nuance} TT90 bounds the thumbnail worker pool to 1–2 workers, lazily starts and retires them, retains main-thread fallback, and cancels private work on lock. /Private thumbnails no longer use the shared host cache. Earlier versions could have written private previews there; Privacy → Audit & speed offers explicit deletion of current cache and version rows, not secure erasure or cleanup of backups/WAL/replicas.`,
    test: `${row.test}; tt90-worker-pool.mts, e2e-tt90-thumbnails.mts and e2e-tt90-private-thumbnails.mts test workers, fallback, idle retirement, pixels, SQL privacy, lock cancellation and explicit cleanup`,
  };
  if (row.code === "SC-10") return {
    ...row,
    nuance: `${row.nuance} TT90 stops /Private thumbnail previews from entering the shared server cache, revokes their blob URLs on lock and provides an explicit cleanup for old cache rows. Existing backups, database logs, replicas and storage remnants are not securely erased.`,
    test: `${row.test}; e2e-tt90-private-thumbnails.mts verifies real encrypted images, host SQL, stale-cache bypass, lock, cancellation, amnesia and cleanup; tt90-private-thumb-path.mts checks normalized aliases`,
  };
  if (row.code === "HW-02") return {
    ...row, name: "ADPF performance hints", tier: "A", phase: "P2", status: "blocked",
    route: "Android PerformanceHintManager and ThermalHeadroom are unavailable to this PWA",
    nuance: "The canonical HW-02 is Android ADPF hints for compositor/render threads, not the web register's previously named worker pool. A bounded browser thumbnail pool exists under FF-13, but it is not PerformanceHintManager or Android thermal-headroom polling.",
    test: "No Android ADPF implementation or device verification. Browser-worker tests are recorded under FF-13, not HW-02.",
  };
  if (row.code === "FM-10") return {
    ...row, name: "Files as an outgoing DocumentsProvider", status: "blocked",
    route: "Android DocumentsProvider requires a native provider; unavailable to a browser-only PWA",
    nuance: "The canonical feature exposes Fusion's files in other applications' system pickers. Incoming PWA file launches, handled partially under SH-13, are the opposite direction and do not implement an outgoing DocumentsProvider.",
    test: "No native provider or external app picker test; incoming browser launch tests are tagged SH-13.",
  };
  if (row.code === "IN-08") return {
    ...row, name: "External-keyboard IME switcher", status: "blocked",
    route: "Requires Android input-method selection APIs unavailable to a browser-only PWA",
    nuance: "The canonical IN-08 is an external-keyboard input-method switcher. Existing Tabletop gestures and keyboard-label reporting are different web features, not an IME switcher.",
    test: "No native IME switcher or physical keyboard verification.",
  };
  if (row.code === "CA-08") return {
    ...row, name: "Google Cast sender", status: "probe",
    route: "Browser Remote Playback / Presentation capability; no native castv2 sender",
    nuance: "The canonical CA-08 sends files/URLs to Google Cast Default Media Receiver with queue, scrub and volume. A browser capability probe or a second local window is not that sender; Cast receiver behavior and the full queue/scrub/volume contract are unverified. Direct castv2 needs sockets a PWA does not expose.",
    test: "No physical Google Cast receiver, native sender or complete queue/scrub/volume test.",
  };
  return row;
}
