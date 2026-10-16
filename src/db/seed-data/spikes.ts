export interface SpikeRow {
  code: string;
  question: string;
  pass: string;
  fallback: string;
  status: "open" | "running" | "passed" | "failed" | "n/a";
  result: string;
}

/**
 * Web-platform spikes. These replace S1..S28 of the Android spec; the ones that
 * can be executed inside the running app are wired to the Perf/Capability panel,
 * the rest are declared open rather than silently assumed.
 */
export const spikeRows: SpikeRow[] = [
  { code: "WS-01", question: "Does the DOM compositor hold 60/120 Hz with 8 windows dragging?",
    pass: "p95 frame cost <= 8.3 ms, no layout during drag", fallback: "cap effects, reduce live previews",
    status: "running", result: "Measurable in Settings → Performance on the user's own hardware (DP-08)." },
  { code: "WS-02", question: "Which transports does Beam actually get on this browser (Remote Playback / Presentation / PiP / multi-screen)?",
    pass: "at least one real transport with a reachable receiver", fallback: "second-window cast only",
    status: "running", result: "Probe result shown live in Beam; blocked transports list their missing primitive." },
  { code: "WS-03", question: "Can Document Picture-in-Picture host a styled, interactive compositor window?",
    pass: "portalled window renders with adopted stylesheets and keeps state", fallback: "popup window host",
    status: "running", result: "Implemented with stylesheet adoption; Firefox/Safari fall back to window.open." },
  { code: "WS-04", question: "How many popular sites refuse framing (X-Frame-Options / CSP frame-ancestors)?",
    pass: "probe answers before a window is offered", fallback: "handoff tab mode",
    status: "passed", result: "/api/embed-probe returns the real headers; broker picks the host from them." },
  { code: "WS-05", question: "Does Together hold <100 ms drift between two clients over the Postgres-backed clock?",
    pass: "|drift| <= 100 ms over 2 minutes with rate-nudge correction", fallback: "leader-follow with periodic seek",
    status: "running", result: "Measured and displayed per participant in the Together panel." },
  { code: "WS-06", question: "Is the journaled move atomic under a mid-operation abort?",
    pass: "source intact before DEST_PUBLISHED; no orphan after", fallback: "copy-only mode",
    status: "passed", result: "Single SQL transaction with SHA verify; journal row records the last state." },
  { code: "WS-07", question: "Can the camera pipeline hit 24 fps at 720p with blur on integrated graphics?",
    pass: ">=24 fps with the heuristic matte", fallback: "540p, effects off",
    status: "running", result: "Lens shows live fps and the ladder state." },
  { code: "WS-08", question: "Does the service worker shell survive offline and replay queued writes?",
    pass: "shell loads offline; queued ops replay with identical journal semantics", fallback: "read-only offline",
    status: "running", result: "Network-first API with a replay queue; verify in Settings → Offline." },
  { code: "WS-09", question: "Is navigator.keyboard.lock() sufficient for shell-level shortcuts?",
    pass: "Meta/Tab/Esc chords reach the shell in fullscreen", fallback: "non-reserved chords only",
    status: "running", result: "Probed; the shortcut editor marks reserved chords per browser." },
  { code: "WS-10", question: "Does Postgres full-text ranking meet the <150 ms palette budget at 100k docs?",
    pass: "p95 <= 150 ms without pg_trgm", fallback: "prefix index + narrowed sources",
    status: "open", result: "Needs a 100k-row corpus; current corpus is seed-scale." },
  { code: "WS-11", question: "Does WebCodecs report hardware encode for screen capture on target devices?",
    pass: "isConfigSupported(hardwareAcceleration:'prefer-hardware') true", fallback: "MediaRecorder default path",
    status: "running", result: "Reported in the capability panel." },
  { code: "WS-12", question: "Does File System Access survive reload with persisted handles?",
    pass: "re-grant flow restores the mount", fallback: "upload/download only",
    status: "open", result: "Requires IndexedDB handle storage; currently probe + session mount." },
];
