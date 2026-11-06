import { F } from "./row";
/** TT135: 17 features moved to Class A with pure engines + UI + tests.
 * Every row below has a real implementation, a test suite that passes, and
 * an honest nuance describing what it does and does not guarantee. */
export const tt135Features = [
  F("HW-09", "Devices", "Network-aware media quality", "A", "P1", "network-quality.ts + Monitor NetworkSection",
    "Classifies the Network Information API's coarse estimates (effectiveType, downlink, rtt, saveData) into quality tiers with a two-sample confirmation rule and one-step-per-change cap. Unknown signals default to the ordinary connection, never to 'fast'. Tier changes require two consecutive agreeing samples. No measured throughput; the browser's own estimates are used and labelled as such.", "built", "tt135-core-engines.mts HW-09"),

  F("RG-02", "System", "Scheduling hints applied", "A", "P1", "scheduler-hints.ts + Monitor SchedulerSection",
    "Routs background work through scheduler.postTask priorities, requestIdleCallback for hidden documents, and input-pending checks for slice boundaries. Degrades to setTimeout(0) when postTask is unavailable, labelled as a downgrade. Slice budget is bounded (4–50ms). The demo button runs a real 100-step sliced task. No claim of parity with native priority scheduling.", "built", "tt135-core-engines.mts RG-02"),

  F("HW-05", "Devices", "Low-latency audio worklet graph", "A", "P1", "audio-latency.ts + Devices AudioLatencyCard",
    "Profiles (low/balanced/stable) map to latencyHint values and per-quantum limiter plans. A real AudioWorkletProcessor limiter is registered from a Data URL (no bundled ffmpeg). Latency is reported from the live AudioContext's own baseLatency/outputLatency, labelled as host-dependent estimates. Suspended/closed contexts report not-ok. The limiter gain step is a one-pole approach, not a broadcast-quality limiter.", "built", "tt135-core-engines.mts HW-05"),

  F("PR-01", "Editor", "Honest text decoding", "A", "P1", "text-encoding.ts + Editor encoding badge",
    "BOM detection first, then UTF-16 without BOM via NUL-byte pattern, then strict UTF-8, then Latin-1 as an explicitly lossy fallback. Binary-looking data (many control bytes) is refused, not shown as mojibake. Corrupt BOMs throw rather than guess. Files over 8 MiB are refused. Line-ending inventory is shown in the Editor banner. No silent repair; the encoding choice and its confidence are always visible.", "built", "tt135-text-encoding.mts PR-01"),

  F("FM-03", "Files", "Collision-free batch rename plan", "A", "P1", "files/batch-rename.ts + FilesPane batchRename",
    "Token patterns ({name} {ext} {n} {nn} {nnn} {date} {time} {upper} {lower}) expand to new names with full validation. Plans detect collisions between batch members and with untouched siblings (case-insensitive). Two-phase atomic rename via unique temporary names. Whole-plan refusal on any error. No expressions, regex, or eval. Up to 500 entries per batch.", "built", "tt135-files-engines.mts FM-03"),

  F("FM-11", "Files", "Trash retention plan", "A", "P1", "trash-retention.ts + FilesPane Trash view",
    "Retention policy combines age (days), size (bytes), and pins. Items with unknown timestamps are never purged and are reported. Pinned items are always kept. The size rule adds oldest unpinned items until the byte budget is met. The plan is reviewable before any deletion. No automatic deletion occurs in the engine; the caller confirms.", "built", "tt135-files-engines.mts FM-11"),

  F("PR-07m", "Files", "Download manager with retries", "A", "P1", "downloads.ts + FilesPane",
    "Queue with monotonic progress, bounded retries (3 attempts, 2s/8s/32s backoff), cancellation that cannot resurrect, completion check against declared length, and collision-free naming. URLs with credentials are rejected. Progress must be non-decreasing. A GET with a body is rejected. POST body capped at 256 KiB. Digest verification requires 64 lowercase hex chars. No network I/O in the engine; the caller performs fetches.", "built", "tt135-files-engines.mts PR-07m"),

  F("CT-03", "Windowing", "Cross-tab window handoff", "A", "P1", "handoff.ts + Shell handoff modal",
    "Window state is validated, bounded (8 KiB props), and packed into a compact code (8+1+1 chars, FNV-1a checksum). BroadcastChannel carries the full payload between same-origin tabs. The code alone cannot reconstruct the payload — it only finds the tab that holds it. Expiry is 10 minutes. Payloads from the future (>60s skew) are refused. Typed-code input is normalised (IL→1, O→0, U→V).", "built", "tt135-system-engines.mts CT-03"),

  F("BL-02", "Store", "Offline cache verification", "A", "P1", "crypto-sign.ts + Store verification UI",
    "Local Ed25519 certificate verification against embedded public key. Manifest digest covers the canonical body (deterministic key order). File digests use crypto.subtle (SHA-256/384/512). Mixed algorithms per manifest are refused. Missing, extra, and mismatched files are reported separately. No DID, no namespace, no signature scheme — those need a server and are not claimed. The claim is local and per-user.", "built", "tt135-system-engines.mts BL-02"),

  F("RH-04", "Routines", "Actionable routines with dry-run", "A", "P1", "routines/alert-db.ts + RoutinesModule",
    "Routines fire when their trigger time is past, with bounded steps (≤40) and opaque payloads (≤1 KiB). Safe actions reject shell metacharacters. Dry-run reports exactly which steps would run and which would fail. Steps that fail do not abort the routine. Plan-day filters to due routines. No arbitrary command execution; all effects go through the caller's whitelisted action executor.", "built", "tt135-system-engines.mts RH-04"),

  F("CO-03", "Network", "Routing decisions with refusal reasons", "A", "P1", "connectivity/routing.ts + Browser/Monitor",
    "Default-deny router: protocol check, credentials check, host allowlist from manifest, body-size cap, redirect chain limit (5 hops). Cross-origin HTTPS routes through the trusted proxy; same-origin goes direct. Refusals carry the specific reason (protocol/credentials/unsafe-redirect/not-in-manifest/size-limit). No silent drops. Credentials in URLs are always refused.", "built", "tt135-system-engines.mts CO-03"),

  F("BL-01", "System", "Headless test harness", "A", "P1", "stats/headless.ts + Monitor TestsFasterSection",
    "Node/TypeScript cores (VFS, converter, triage, thresholds) tested at ~20× wall-clock vs Python oracles. Measured benchmarks are recorded and displayed. Suites report pass/fail counts and wall time. No CPython parse, no venv boot. The Python oracles remain authoritative for their engine; this is a differentiator, not a replacement.", "built", "tt135-system-engines.mts BL-01"),

  F("WM-02", "Windowing", "Window groups", "A", "P1", "shell/window-groups.ts + WindowGroupsPanel",
    "Groups of windows (≤32 members, ≤64 groups) that minimise, close, focus, and layout together. Layout positions members inside a viewport without moving non-members. Focus raises all members to a given z-order. Close removes all members. Minimize sets minimised on every member. Group operations are deterministic and window-identity based. No I/O in the engine.", "built", "tt135-system-engines.mts WM-02"),

  F("SH-06", "System", "Cross-tab document locks", "A", "P1", "crosstab/locks.ts + CrossTabLocksPanel",
    "Cooperative leases with 15-second TTL and heartbeat-based liveness. A lease can only be renewed by its current holder. Expired leases can be claimed by any tab. Non-holder renewals are denied. Heartbeat identity must match the lease identity. Idle TTL is 60 seconds. No central server; cross-device locking is a different feature not claimed here.", "built", "tt135-system-engines.mts SH-06"),

  F("ST-09", "Accessibility", "Input profiles", "A", "P1", "input-profiles.ts + InputProfilesPanel",
    "Four profiles (precision/pointer-large/touch/keyboard-only) with hit targets ≥44px, optional hold and timed delays, and visible hints. Touch profiles are refused on mouse pointers; mouse profiles are refused on touch pointers. Profile selection reports the exact target size and whether a timed gesture is required. Profiles reduce precision demands but do not change what controls do.", "built", "tt135-system-engines.mts ST-09"),

  F("FM-14", "Files", "Extension file permissions", "A", "P1", "files/permissions.ts",
    "Grants root at a specific folder; path traversal is normalised away and never escapes. Reads are byte-bounded (≤8 MiB). Streaming requires a separate permission. App metadata (/.fusion) is never exposed. File-only grants are scoped to one path. Every access carries a reason (granted or denied). The caller still enforces its own quota.", "built", "tt135-files-engines.mts FM-14"),

  F("ST-04", "Streaming", "Playlist parser with live advance", "A", "P1", "m3u8.ts",
    "M3U/M3U8 parser with byte-range support, EXTINF durations, and live playlist advance by index. Byte ranges require version ≥3. Unrecognised lines are flagged, not silently dropped. Live playlists advance by the next segment after the one already played, not by restarting. No network I/O, no ffmpeg/WebCodecs (privacy + size). The module reports what a segment contains and its byte budget.", "built", "tt135-files-engines.mts ST-04"),
];
