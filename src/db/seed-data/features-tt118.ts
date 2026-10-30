import { F } from "./row";

/**
 * TT118 — fourteen requirements, each written only because this turn built the
 * mechanism and ran a suite against it (tt118-core.mts, 12 tests; e2e-tt118).
 * AX-20 extends the de-wordification contract from Recall+Browser to every
 * module window, measured by tt118-density.mts over all registered modules.
 */
export const tt118Features = [
  F("DF-01", "Editor", "Version diff: line and word diff against any saved version", "A", "P2", "src/lib/diff-core.ts diffLines/diffWords + Editor History",
    "Line diff is a longest-common-subsequence over lines (dynamic programming, capped at 4000 lines per side and refused beyond it rather than freezing the window). Changed pairs are word-diffed so a one-word edit reads as one word. The Editor shows +added/−removed/unchanged counts against the current buffer, including unsaved edits — the diff is of what you see, not of the last save.",
    "built", "tt118-core.mts DF-01 (ordered ops, stats, word pair, cap refusal)"),
  F("NT-02", "Notes", "Hashtags, [[wiki-links]] and backlinks", "A", "P2", "src/lib/note-links.ts + Notes footer",
    "A hashtag needs a word character after # and no word character or '/' before it, so headings, URLs and a#b are not tags. Wiki-links [[Title]] / [[Title|label]] resolve by case-insensitive title; unresolved links are badged as such instead of pretending to work. Backlinks are computed over the whole note set, so they cannot disagree with the links they reverse.",
    "built", "tt118-core.mts NT-02 (heading/URL exclusions, exact backlink reversal)"),
  F("PL-03", "Planner", "Agenda view: overdue / today / tomorrow / this week / later", "A", "P2", "src/lib/agenda.ts buildAgenda + Planner Agenda view",
    "Buckets are whole local days: a task due at 23:59 today is 'today' all day and only becomes overdue tomorrow. Done and undated tasks are shown in their own buckets, counted, never silently dropped from the count.",
    "built", "tt118-core.mts PL-03 (all seven buckets, boundary task)"),
  F("WD-01", "Clock", "Meeting overlap across time zones", "A", "P2", "src/lib/zones.ts commonWindows + Clock",
    "Each zone's 09:00–17:00 window is projected onto UTC in 30-minute cells using the real Intl offset at that instant, so DST transition weeks are exact rather than fixed-offset approximations. London and New_York share 14:00–17:00 UTC in winter; London and Tokyo share no working hour, and the UI says so instead of offering a bad slot.",
    "built", "tt118-core.mts WD-01 (180-minute overlap, empty overlap, invalid window)"),
  F("WD-02", "Clock", "Countdowns to named dates", "A", "P2", "src/lib/zones.ts validateCountdowns/daysUntil + Clock",
    "Whole local days to a named YYYY-MM-DD date, persisted browser-local and re-validated on load. Past dates report 'n days ago' rather than a negative number dressed up as a countdown.",
    "built", "tt118-core.mts WD-02 (today/past/future, date validation)"),
  F("CV-01", "Calculator", "Unit converter: 8 categories, exact defined factors", "A", "P2", "src/lib/converter.ts + Calculator Convert panel",
    "Every unit is (factor, offset) to a category base, which makes °C/°F/K affine conversions exact (100 °C = 212 °F, not 211.999…). Factors are the SI definitions (inch = 0.0254 m, US gallon = 3.785411784 L). Data keeps IEC (KiB = 1024) and decimal (kB = 1000) units side by side and never conflates them. Cross-category conversion is refused.",
    "built", "tt118-core.mts CV-01 (exact definitions, affine round-trip, category refusal)"),
  F("UC-01", "Browser", "Clean link: strip tracking parameters, report what was removed", "A", "P2", "src/lib/url-clean.ts cleanUrl + Browser toolbar",
    "Removes utm_* and an explicit list of click ids (fbclid, gclid, msclkid, …) and names every removed parameter in the notice, so 'cleaned' is auditable. Everything else — including opaque tokens that might be load-bearing — is kept, and the fragment survives. A non-URL or non-http(s) input is refused rather than regex-'cleaned'.",
    "built", "tt118-core.mts UC-01 (removed list, load-bearing params kept, refusals)"),
  F("ST-10", "Settings", "Settings export/import with a closed vocabulary", "A", "P2", "src/lib/settings-io.ts + Settings",
    "Import applies only keys the running build already knows, from its own settings graph; unknown keys are skipped and named, locked keys (system.seedVersion) are refused and named, non-string values are refused. Parsing alone never applies anything: the caller applies the accepted map through the normal setSetting path, so history and validation still apply.",
    "built", "tt118-core.mts ST-10 (unknown/locked/non-string all reported, none applied)"),
  F("BK-06", "Backup", "Compare a built bundle with an older bundle", "A", "P2", "src/lib/backup-compare.ts + Backup Export",
    "Set arithmetic over paths with a digest comparison inside each shared path: added / removed / changed / unchanged plus a byte delta, with the first changed paths named in the report. Accepts both manifest JSON and a plain bundle file (bundle entries call the byte count `size`). A malformed older file is refused with the entry number, not partially compared.",
    "built", "tt118-core.mts BK-06 (three buckets, byte delta, invalid entry refusal)"),
  F("TM-02", "Terminal", "Did-you-mean for unknown commands", "A", "P2", "src/lib/suggest.ts editDistance/suggest + Terminal",
    "Optimal-string-alignment Damerau–Levenshtein, written from scratch: a transposition (hlep → help) costs one. Suggestions are offered only within a length-scaled threshold and only for inputs of 3+ characters — a short string gets no confident wrong guess. The candidate list is the terminal's real command set, extracted from its own dispatch.",
    "built", "tt118-core.mts TM-02 (transposition, threshold, short-input silence)"),
  F("PH-02", "Photos", "Library timeline strip: photos per month, undated counted", "A", "P2", "src/lib/photo-timeline.ts photoTimeline + Photos",
    "Groups the loaded library by local capture month (capture-date index first, file date as fallback) and shows count per month above the grid; undated photos are their own badged group, counted, never dropped. Complements the existing month sections with an at-a-glance distribution, including a largest-month figure.",
    "built", "tt118-core.mts PH-02 (local months, undated, largest month)"),
  F("SV-01", "Find", "Saved searches", "A", "P2", "src/lib/saved-searches.ts + Find",
    "A saved search stores the full input (query, scope, mode) so re-running it reproduces the search rather than approximating it. Stored browser-local, re-validated on every load (an unknown mode cannot be injected by editing storage), capped at 30, duplicate names refused.",
    "built", "tt118-core.mts SV-01 (mode validation, duplicate refusal, newest first)"),
  F("AX-20", "Design", "De-wordification measured over every app, not just two", "A", "P2", "scripts/tt118-density.mts over all registered modules",
    "TT116–TT117 measured Recall and Browser. This pass measures visible words, drawn marks, controls and emoji-in-controls in every one of the registered module windows in a real Chromium, prints the full table, and asserts a global ceiling plus tighter bounds for the modules this turn worked on. Document content (a note being edited, filenames) is counted, not exempted. Glyph comprehension remains unmeasured; geometry and naming are measured.",
    "built", "tt118-density.mts (all modules measured; bounds in DESIGN-TT118)"),
];
