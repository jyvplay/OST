import { F } from "./row";

/**
 * TT117 — thirteen requirements, each written only because this turn built the
 * mechanism and ran a suite against it. The turn's rule is the standing one: a
 * row says "built" only where a suite's assertions address the feature's own
 * mechanism (tt117-core.mts, 12 tests), and every row below is claimed by a
 * module in src/lib/registry.ts so SP-01's health check can see it.
 *
 * Recall also gains its three archive-reporting rows here (RC-40/41/42) and the
 * registry's Recall entry now claims the full RC-01…RC-42 set it implements,
 * which TT116 left as an empty list.
 */
export const tt117Features = [
  F("CK-01", "Clock", "Alarms: daily/weekly schedules, snooze, persisted", "A", "P2", "src/lib/clock-core.ts + alarm-store.ts + ShellDaemons.tsx + Clock alarms section",
    "Weekday controls and validated browser-local schedules feed a shell-owned foreground timer, so closing Clock does not stop it. A frozen or closed page can miss alarms; cross-tab suppression needs Web Locks and storage. Amnesic alarms are page-only and do not use OS notifications. TT132 adds a persistent actionable alarm center, repeat snooze/cancel/dismiss, missed-snooze reporting and identity-preserving schedule editing. Still partial: delivery requires a running page; no native exact-time or physical-wake guarantee.",
    "partial", "e2e-tt132-alarms.mts + tt132-core.mts (actionable activity and occurrence tokens); e2e-tt130-alarms.mts (foreground schedules/privacy/claims); tt117-core.mts (arithmetic)"),
  F("CK-02", "Clock", "Stopwatch lap splits with fastest/slowest", "A", "P2", "src/lib/clock-core.ts lapStats + Clock stopwatch",
    "Laps are cumulative readings; splits are the deltas. Non-monotonic readings are refused rather than silently producing a negative lap. Fastest/slowest/average are computed from the same readings the UI displays, in the Clock module under the lap list.",
    "built", "tt117-core.mts CK-02 (deltas, fastest/slowest, monotonic refusal)"),
  F("CK-03", "Clock", "Date calculator: days and business days between dates", "A", "P2", "src/lib/clock-core.ts daysBetween/addDays/businessDaysBetween + Clock section",
    "Whole local days; time-of-day is discarded on purpose so DST transitions cannot produce fractional answers. Business-day counting is sign-aware: reversing the two dates negates the count. A +30 days shortcut sets the second date from the first.",
    "built", "tt117-core.mts CK-03 (month boundary, sign, integer refusal)"),
  F("NT-01", "Notes", "Note statistics and outline", "A", "P2", "src/lib/notes-stats.ts analyzeNote + Notes footer",
    "Word and reading-time counts exclude fenced and inline code — code is not prose, and counting it inflates reading time. The outline lists Markdown headings with their source line numbers; links and images are counted separately. Reading time is 200 words/minute, minimum one minute for non-empty text.",
    "built", "tt117-core.mts NT-01 (code excluded exactly, outline lines, link/image split)"),
  F("PL-01", "Planner", "Recurrence expansion (daily/weekly/monthly/yearly)", "A", "P2", "src/lib/recurrence.ts expandRecurrence + Planner repeat preview",
    "A strict subset of RFC 5545 RRULE: FREQ, INTERVAL, BYDAY for weekly rules, COUNT and UNTIL. Monthly expansion clamps to the target month but remembers the anchor day, so 31 Jan becomes 28 Feb and then 31 Mar again instead of drifting to the 28th. Expansion is bounded by the caller's window and a 512-occurrence cap; an unbounded rule asked for an inverted window is refused.",
    "built", "tt117-core.mts PL-01 (BYDAY set, monthly clamp, COUNT/UNTIL, round-trip)"),
  F("PL-02", "Planner", "ICS recurrence round-trip", "A", "P2", "src/lib/ics.ts RRULE parse/emit + /api/tasks import/export",
    "An imported .ics carrying RRULE keeps the rule: parseIcs surfaces it, the tasks route stores it in notes as an RRULE line when missing, and toIcs re-emits it as a real RRULE property on export — so a recurring event survives a Planner export/import cycle instead of degrading to one occurrence. The Planner also previews the next occurrences before saving.",
    "built", "tt117-core.mts PL-02 (parse → export → parse identity)"),
  F("CB-01", "Clipboard", "Clipboard history export/import", "A", "P2", "src/lib/clip-io.ts + Clipboard module",
    "Export writes redaction markers for sensitive (Vault) entries, and import refuses sensitive entries outright: a masked secret must never come back as a usable clip. Import dedupes against existing entries, validates every entry before applying any, and refuses a file that would exceed the history cap. Malformed files are refused whole, never partially applied.",
    "built", "tt117-core.mts CB-01 (redaction, sensitive refusal, dedupe, malformed refusal)"),
  F("RT-01", "Routines", "Routine export/import", "A", "P2", "src/lib/routine-io.ts + Routines module",
    "A routine file is data, not code: every imported action is re-validated against the same ROUTINE_COMMANDS whitelist the editor enforces, so an imported routine can do nothing a typed routine could not. Duplicate names are skipped and reported, never silently overwritten.",
    "built", "tt117-core.mts RT-01 (whitelist re-validation, duplicate skip)"),
  F("FN-01", "Find", "Pattern filter over search results (literal/regex)", "A", "P2", "src/lib/find-core.ts compileFind/findInText + Find module",
    "Filters the hits already returned, client-side, so filtering never re-queries the host with a new string. A bad regex is shown as an error, never silently demoted to a literal search. Matches carry line/column positions, overlapping matches are not double-counted, and results are capped at 500 with truncation reported.",
    "built", "tt117-core.mts FN-01 (literal escaping, regex error, whole-word positions)"),
  F("RC-40", "Recall", "Archive manifest export and verification", "A", "P2", "src/lib/recall-report.ts buildManifest/verifyManifest + RecallMemory",
    "The manifest is built from the receipts themselves (path, SHA-256, bytes, MIME, method, capture time), sorted by path with fixed key order, so two exports of the same archive are byte-identical and a diff means the archive changed. Verification reports missing, extra and changed memories separately; it compares receipt facts and does not re-hash media bytes (that is RC-19). Unreadable receipts are excluded and counted by the pair audit, not silently dropped.",
    "built", "tt117-core.mts RC-40 (determinism, three-way diff)"),
  F("RC-41", "Recall", "Archive statistics by folder, method and day", "A", "P2", "src/lib/recall-report.ts archiveStats + RecallMemory report panel",
    "Totals are aggregated over the same receipt fields RC-27 filters on, so the report cannot disagree with the provenance it summarises. Receipts without a readable capture time are counted as undated rather than dropped.",
    "built", "tt117-core.mts RC-41 (totals, undated counted)"),
  F("RC-42", "Recall", "Cross-folder duplicate report", "A", "P2", "src/lib/recall-report.ts duplicateGroups + RecallMemory report panel",
    "Groups memories by receipt SHA-256 across all Recall folders — RC-34's recognition is per-folder at save time; this is the archive-wide view. Wasted bytes are bytes × (copies − 1) per group, sorted largest first. The report names the paths; deleting anything remains the person's explicit act.",
    "built", "tt117-core.mts RC-42 (grouping, wasted bytes)"),
  F("BR-01", "Browser", "Browser session export/import", "A", "P2", "src/lib/browser-io.ts + Browser toolbar",
    "Export carries tabs and groups only: proxy session ids, embed verdicts and runtime state are excluded — a session id would be meaningless on another device and leaking one would be a privacy bug. Import re-runs every address through the same safeBrowserUrl guard session restore uses and reports how many unsafe addresses were dropped instead of silently losing them.",
    "built", "tt117-core.mts BR-01 (unsafe dropped and counted, groups preserved)"),
  F("AX-19", "Design", "Fourth de-wordification pass: Recall and Browser chrome", "A", "P2", "src/components/AppIcon.tsx UiGlyph (manifest/alarm/repeat/stats) + Browser/Recall chrome",
    "Browser chrome measured 132 visible words with the framed content included; the chrome itself (toolbar, tab strip, status line) is now glyph-first: Sleep, Close-others, Close-right, Close-duplicates, Permissions, Pin and Recall are drawn marks whose full phrases survive as aria-label and title, and the network-route control shows its state as one word beside a link glyph. The framed page and its embed-refusal explanation are content, not chrome, and are excluded from the count — the explanation is asserted as a floor instead, so the count cannot be won by deleting it. Recall stays under its TT116 ceiling with the new manifest controls drawn, not worded. Glyph comprehension remains unmeasured; geometry, naming and label-in-name are measured.",
    "built", "tt117-density.mts (AX-19: both modules measured, floors asserted)"),
  F("SP-01", "Spec", "Register health: the register audits itself", "A", "P2", "src/lib/spec-health.ts checkRegister + /api/spec-health + Spec panel",
    "A built row must be claimed by some module's implements list, every suite file a row's test string cites must exist on disk, codes must be unique, and a module may not claim a code the register does not contain. Blocked rows are exempt from the module-claim rule: they are claims about the platform, not about a module. The Spec app renders the live issue list, recomputed per request — including issues in this very register.",
    "built", "tt117-core.mts SP-01 (all four issue kinds, blocked exemption)"),
];
