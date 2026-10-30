import { F } from "./row";

/**
 * TT120 — eleven requirements, each written only because this turn built the
 * mechanism and ran a suite against it (tt120-core.mts, 10 tests; e2e-tt120;
 * tt120-density.mts). The wc/daily-note style bug of TT119 recurred in
 * spirit: note filenames needed two rounds of adversarial input
 * ("../../etc/passwd") before the export could not escape or hide.
 */
export const tt120Features = [
  F("ED-04", "Editor", "Go-to-line and live document statistics", "A", "P2", "src/lib/line-nav.ts + Editor find bar",
    "Line numbers are 1-based where the user types and clamped inside: line 9999 of a 3-line file lands on line 3, never past the end. Statistics (lines, words, chars, ~reading minutes at 200 wpm, labelled an estimate) reuse Terminal wc's counting rules (wc-core) so the Editor and the shell can never disagree about the same document.",
    "built", "tt120-core.mts ED-04 (clamping, line offsets, wc-consistent stats)"),
  F("NT-04", "Notes", "Export note as a self-contained Markdown file", "A", "P2", "src/lib/note-export.ts + Notes Export .md",
    "The filename is derived from the title with separators, control characters and leading dots removed — '../../etc/passwd' exports as 'etc passwd.md', never as a path, never as a hidden file. A front-matter block (title, export instant, tags) makes the file stand on its own outside Fusion.",
    "built", "tt120-core.mts NT-04 (escape attempts, front-matter, untitled fallback)"),
  F("PL-05", "Planner", "Due-date presets (Today / Tomorrow / +1 week) and overdue count", "A", "P2", "src/lib/due-presets.ts + Planner",
    "Presets are whole local days at 23:59, matching the agenda's day buckets: 'tomorrow' means tomorrow the day, not now+24h. Each chip's tooltip states the actual calendar date it will set, and the header counts open overdue tasks so they cannot hide inside a long list.",
    "built", "tt120-core.mts PL-05 (end-of-day, month crossing, labelled dates)"),
  F("WD-04", "Clock", "Business-hours indicator for every world-clock zone", "A", "P2", "src/lib/zone-status.ts + World clock",
    "Open means weekday 09:00–17:00 in that zone right now, computed from the Intl hour at the instant (the platform's DST rules, not a fixed offset table). Each row states either 'work hours' or the zone's current local time, so the verdict is checkable at a glance.",
    "built", "tt120-core.mts WD-04 (Friday open, night closed, Saturday closed)"),
  F("TM-04", "Terminal", "head and tail commands", "A", "P2", "src/lib/text-slice.ts + Terminal",
    "First/last N lines with `-n N` or `-N`, defaulting to 10 like the tools they mirror. Asking for more lines than the file has returns the whole file; a trailing newline does not invent a phantom empty line. Binary files are refused with a pointer to Peek, as cat does.",
    "built", "tt120-core.mts TM-04 (arg forms, whole-file, no phantom line); e2e-tt120 on a real VFS file"),
  F("BK-08", "Backup", "Backup freshness: when was the last bundle built here?", "A", "P2", "src/lib/backup-freshness.ts + Backup Export",
    "Stored browser-local because the server cannot know about a downloaded file kept offline. 'Never built here' is a first-class state, staleness is judged against a 7-day threshold the UI prints next to the label, and building a bundle records the instant.",
    "built", "tt120-core.mts BK-08 (never/fresh/stale boundaries, stated threshold)"),
  F("SR-10", "Find", "Result summary by source (3 file · 1 note)", "A", "P2", "src/lib/result-groups.ts + Find results header",
    "Groups hits by source in first-seen order — the ranking's order, never re-sorted — so where the answers live is visible without scrolling the list. Grouping composes with the pattern filter because it reads the same hit list the user sees.",
    "built", "tt120-core.mts SR-10 (first-seen order preserved, counts)"),
  F("PH-04", "Photos", "Editor prev/next navigation over the shown set", "A", "P2", "src/lib/photo-order.ts + Photos editor",
    "Arrow keys and ‹ › buttons walk the currently shown (filtered, sorted) list — what the user is looking at, not the raw library — with the position stated ('2 of 3'). No silent wrap: at the boundary the button disables (the slideshow wraps; deliberate navigation does not).",
    "built", "tt120-core.mts PH-04 (boundary null, position label); e2e-tt120 walks seeded photos"),
  F("MU-03", "Music", "Library provider facet for Streams", "A", "P2", "src/lib/provider-filter.ts + Streams library",
    "Answers 'show only my YouTube saves', which the title filter cannot. Providers are counted from the library itself; 'all' is explicit; an unknown provider matches nothing (a typo'd facet shows an empty list, not everything).",
    "built", "tt120-core.mts MU-03 (counts, all, unknown-is-empty)"),
  F("CN-06", "Contacts", "Starred contacts (local preference, never written to the vCard)", "A", "P2", "src/lib/contact-stars.ts + Contacts list",
    "vCard has no standard star field, so stars are a browser-local set of contact UIDs, re-validated on load, with a Starred-only filter. The address book file is never rewritten for a view preference — syncing it elsewhere cannot leak Fusion's UI state into shared data.",
    "built", "tt120-core.mts CN-06 (validation, toggle round-trip); e2e-tt120 star persists across windows"),
  F("AX-22", "Design", "Contrast debt closed for Lens and PDF; all apps re-measured", "A", "P2", "scripts/tt120-density.mts + src/components/ui.tsx Toggle",
    "TT119 measured Lens switch toggles at 1.64 and PDF colour swatches at 1.30–1.73 and printed them as baseline. TT120 fixes the real defect (the shared Toggle's off-track was white at 12% over dark — now 28%) and refines the measure to what a sighted user perceives for contentless controls (a swatch or switch is judged by its own background/border/knob against its surroundings, not by text it does not have). Lens and PDF join Browser and Recall in the asserted set; all 47 windows re-measured with tightened bounds.",
    "built", "tt120-density.mts (47/47; contrast asserted for browser/recall/lens/pdf)"),
];
