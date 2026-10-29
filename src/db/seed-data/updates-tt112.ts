import type { SpecRow, Status } from "./row";

/**
 * TT112 corrections.
 *
 * Most of these rows shipped long ago and had never been measured: the first-run capability report
 * and licence check, the throttle detector, and the four capability probes whose only honest claim
 * is "this is what the browser in front of you exposes". They are measured here against the live
 * browser in the same page, at the same moment, so the register's claim and the product's claim
 * cannot drift apart without a test failing.
 *
 * One entry records a defect this turn's test found and fixed rather than a grade: the load
 * governor pruned its 60-second long-task window only when another long task arrived, so a machine
 * that went quiet stayed throttled. It now prunes on a timer and republishes when the state really
 * changes. Nothing here upgrades a grade that was not earned by a passing assertion.
 */
type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };

export const UPDATES_TT112: Record<string, Patch> = {
  // ---- First run: measured, local, and silent until asked ------------------------------------
  "SH-07": { status: "built", test: "e2e-tt112-shell.mts",
    route: "Settings → Capabilities / Licence",
    nuance: "First run needs no account and no network identity. The capability report is measured in the browser that is running (thread count, device memory, secure context, screen geometry and ~54 feature probes) and is compared in test against the live objects, so it cannot claim support this browser lacks. It stays on the device until a human presses Save report; opening the pane uploads nothing. Licensing is an offline Ed25519 check: the verifying public key is published by the server, an unlicensed install reports tier none with a declared grace period, and a trial is granted locally against a client id the human's browser generates." },

  // ---- The throttle detector, now measured and no longer a latch -----------------------------
  "SH-12": { status: "built", test: "e2e-tt112-shell.mts",
    nuance: "PerformanceObserver('longtask') + an EWMA of rAF intervals sampled only while something animates + battery and Data Saver state, mapped to COOL/WARM/HOT/THROTTLED/CRITICAL. Measured: 59 real long tasks drive the shell to effects=off, and the state recovers to effects=on once the 60 s window drains. TT112 fixed a latch here — the window was pruned only when another long task arrived, so an idle machine stayed throttled; it is now pruned on a 5 s timer and republished only when the state actually changes. The web exposes no thermal headroom or CPU time, so this remains a proxy for cost, not a thermal reading." },
  "RG-01": { status: "built", test: "e2e-tt112-shell.mts",
    nuance: "Load governor: observed cost closes the loop (frame interval EWMA, long-task rate, battery, Data Saver). Effects and background work are gated on the measured state, and the gating is asserted end to end against real long tasks in a real browser. Not a thermal API: the platform has none." },

  // ---- Capability probes: honest about this browser, verified against it ---------------------
  "RG-02": { status: "partial", test: "e2e-tt112-shell.mts",
    nuance: "scheduler.postTask and requestIdleCallback are probed and reported, and the report is verified in test against the live browser (the pane's yes/no must equal 'scheduler' in window). Still partial, and deliberately so: application work is not yet scheduled through postTask priorities, and isInputPending is not consumed anywhere, so the row claims detection and reporting only." },
  "WM-07": { status: "partial", test: "e2e-tt112-shell.mts",
    nuance: "getScreenDetails()/screenschange back per-display layouts, and the capability claim is verified against the live browser. Still partial: per-screen desktop_state keys and hotplug restore are exercised only by hand, because a headless run has one screen and the window-management permission cannot be granted to it." },
  "HW-05": { status: "partial", test: "e2e-tt112-shell.mts",
    nuance: "AudioContext latencyHint:'interactive' with AudioWorklet available is reported from a measurement (AudioWorkletNode present), not asserted. Still partial: no worklet-based processing graph ships yet, and output latency numbers depend on the host audio stack, which a headless container does not represent." },
  "HW-08": { status: "partial", test: "e2e-tt112-shell.mts",
    nuance: "WebCrypto SubtleCrypto is present and is the real key engine behind the vault; the test asserts it is there rather than trusting the register. Honest downgrade kept: these are software keys. No StrongBox/TPM backing exists on the web, and WebAuthn platform-authenticator binding is not available in this environment, so no hardware-backed claim is made." },
  "HW-11": { status: "built", test: "e2e-tt112-shell.mts",
    nuance: "Screen Wake Lock is probed and the pane's answer is verified against navigator.wakeLock in the same browser. Granting it needs the screen-wake-lock permission, which the harness supplies explicitly in the capture suites." },

  // ---- Privacy posture confirmed by the same run ---------------------------------------------
  "PR-02": { status: "built", test: "e2e-tt112-shell.mts",
    nuance: "Nothing leaves the device unless a human asks: measured here for the capability report, where opening the pane adds no row to /api/probe and pressing Save report adds exactly one. The same rule governs Recall receipts, backups and the ledger." },

  // ---- Recall rows the new pathway touches ---------------------------------------------------
  "RC-09": { status: "built", test: "tt111-recall-tap.mts + e2e-tt112-resident.mts",
    nuance: "Every memory carries a receipt: SHA-256, byte count, MIME, method, capture time, a query-redacted source label and, since TT112, an explicit refetched flag so a reader can tell whether the publisher was contacted without knowing the method table. Receipts are integrity records, not authentication; raster pixels are never labelled original bytes." },
  "RC-14": { status: "built", test: "e2e-tt112-resident.mts",
    nuance: "Attribution is bound to method inside the publishing transaction: only the refetch pathway may claim requested-url, the session tap may claim proxy-recorded-response, and everything else — including an object the page was holding (resident-object-url) — must say user-declared-label. A receipt that omits the field is read the conservative way, so an omission cannot launder a claim." },
  "RC-01": { status: "built", test: "e2e-tt100-recall.mts + e2e-tt112-resident.mts",
    nuance: "The original-byte pathway re-requests the URL and is the only method whose receipt may claim requested-url and refetched:true. It is deliberately kept separate from the two pathways that need no request: blob:/data: objects the page holds are not listed to it, and it refuses them as incomplete media." },
};
