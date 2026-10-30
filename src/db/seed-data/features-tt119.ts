import { F } from "./row";

/**
 * TT119 — eleven requirements, each written only because this turn built the
 * mechanism and ran a suite against it (tt119-core.mts, 11 tests; e2e-tt119;
 * tt119-density.mts). Two TT118 candidates were dropped mid-turn when the
 * codebase turned out to already have them — Files folder sizes (FM-17,
 * server-side) and Backup restore preview (BK-05) — and one wc bug
 * (newline counting) was caught by the new unit test and fixed in the
 * engine, not in the test.
 */
export const tt119Features = [
  F("ED-03", "Editor", "Find & replace: literal matches, counted, nth-only replace", "A", "P2", "src/lib/editor-find.ts + Editor find bar",
    "Matches are literal substrings (a query `a.b` never matches `axb`), counted with line/column before anything changes, and replace-one touches exactly the match it claims to. An empty query is refused instead of matching at every position and freezing the editor.",
    "built", "tt119-core.mts ED-03 (literal dot, line/column, nth replace, empty refusal)"),
  F("NT-03", "Notes", "Daily note: open or create today's note by local date", "A", "P2", "src/lib/daily-note.ts + Notes Daily button",
    "The daily note is titled with today's local date (YYYY-MM-DD); a `Daily YYYY-MM-DD` title is accepted as the same convention. Resolution never guesses — a similarly-named note is not picked, and creation happens only when nothing matches. Local date, not UTC, so 23:30 local is still today.",
    "built", "tt119-core.mts NT-03 (both conventions, null instead of a guess)"),
  F("PL-04", "Planner", "Task filter: text query + open/done status", "A", "P2", "src/lib/task-filter.ts + Planner filter bar",
    "The query matches title and notes; status narrows without reordering — filtering a list the user arranged must never re-sort it. The same filtered set drives list, week and agenda, so the three views cannot disagree about what matched.",
    "built", "tt119-core.mts PL-04 (notes match, order preserved, status narrowing)"),
  F("CK-04", "Clock", "Custom world-clock zones, persisted and re-validated", "A", "P2", "src/lib/zone-list.ts + World clock",
    "Zones are validated by the platform's own database: an Intl constructor throws on an unknown zone, so the persisted list can never contain a zone the clock cannot render. UTC is always present and cannot be removed; the list is capped at 12.",
    "built", "tt119-core.mts CK-04 (Mars/Olympus rejected, UTC pinned, cap enforced)"),
  F("WD-03", "Clock", "Time-in-another-zone converter with day shift", "A", "P2", "src/lib/zone-convert.ts + Clock converter",
    "Converts a stated local date/time between zones via Intl offsets resolved at the instant (two-pass, so DST transition days are right). The result includes the target date and the day shift, so a +1-day answer across the dateline is never silently read as same-day.",
    "built", "tt119-core.mts WD-03 (09:00 NY = 22:00 Tokyo, 23:00 crosses a day, invalid refused)"),
  F("TM-03", "Terminal", "wc and du commands with POSIX counting", "A", "P2", "src/lib/wc-core.ts + Terminal",
    "`wc` counts newline characters (POSIX), words, and UTF-8 bytes — an emoji is 4 bytes, not 2 UTF-16 units, and the first version of the engine got the line rule wrong and was caught by its own test. `du` reports immediate-entry sizes and says they are stored entry sizes rather than pretending to re-read every file.",
    "built", "tt119-core.mts TM-03 (POSIX lines, emoji bytes); e2e-tt119 wc on a real VFS file"),
  F("BK-07", "Backup", "Bundle contents explorer: where a backup's bytes live", "A", "P2", "src/lib/bundle-tree.ts + folder-size.ts + Backup Export",
    "Turns a built bundle's flat entry list into a folder tree and rolls sizes up it, in the browser, before anyone downloads. Directory entries contribute structure, not bytes; the largest folders come first. Complements (does not duplicate) the server restore preview, which answers a different question: what would change.",
    "built", "tt119-core.mts BK-07 (tree build, byte rollup, intermediate dirs)"),
  F("SR-09", "Find", "Recent searches: automatic, capped, mode-validated", "A", "P2", "src/lib/recent-searches.ts + Find",
    "Distinct from saved searches (SV-01): automatic, unnamed, capped at 20, newest first, and a repeat moves to the front instead of duplicating. Re-validated on load so a mode the build does not know cannot be injected by editing storage.",
    "built", "tt119-core.mts SR-09 (dedup-to-front, unknown mode dropped, cap)"),
  F("PH-03", "Photos", "Slideshow: auto-advance that wraps, clamped interval", "A", "P2", "src/lib/slideshow.ts + Photos library",
    "Advances through the currently shown set and wraps at the end — a show that stops at the last photo is a viewer. The interval is clamped to 1–60 s so a typo can neither spin the CPU nor stall for an hour; an empty library has no next frame and says nothing.",
    "built", "tt119-core.mts PH-03 (wrap, clamp, empty); e2e-tt119 play control"),
  F("MU-02", "Music", "Recently played: front-deduped play history", "A", "P2", "src/lib/recent-plays.ts + Streams player",
    "Playing a track again moves it to the front instead of duplicating it; the list is capped at 50 and titles are stored with ids so the list still reads correctly after the library changes. Distinct from the queue and from shuffle's back-stack, which are playback mechanics, not history.",
    "built", "tt119-core.mts MU-02 (front-dedup, validation, cap)"),
  F("AX-21", "Design", "De-wordification round 3: every app re-measured, contrast measured too", "A", "P2", "scripts/tt119-density.mts over all registered modules",
    "All 47 module windows re-measured (words, marks, controls, emoji) with tightened bounds for eleven modules; explanatory prose in Messages and Monitor moved behind one-line summaries following the TT116 Recall pattern, while safety-critical and limitation text stays visible. TT119 also measures what TT118 could only observe: computed-colour contrast of every visible Browser and Recall control against the window background, asserted at ratio ≥ 2.2 — the near-black toolbar glyphs photographed in TT118 are now a failing test, not an anecdote, wherever they exist.",
    "built", "tt119-density.mts (47/47 measured; bounds + contrast in DESIGN-TT119)"),
];
