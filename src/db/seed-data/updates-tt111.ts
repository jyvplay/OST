import type { SpecRow, Status } from "./row";

/**
 * TT111 corrections. Every row below shipped without a test and is measured here for the first
 * time, or had a nuance that this turn's measurements made more accurate.
 *
 * Two entries record a measurement that contradicted what the test author (me) assumed, and the
 * product turned out to be right: shortcut presets deliberately bind chords the browser reserves
 * and DECLARE them rather than avoiding them (because they work under Keyboard Lock), and a trashed
 * file is still readable by exact path — that is what makes undo possible, while the folder listing
 * correctly hides it. Those assumptions were corrected in the tests, not in the product.
 *
 * Nothing here upgrades a grade that was not earned by a passing assertion.
 */
type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };

export const UPDATES_TT111: Record<string, Patch> = {
  // ---- Recall: the loaded-media pathway's effect on neighbouring rows ------------------------
  "RC-09": { status: "built", test: "tt111-recall-tap.mts",
    nuance: "SHA-256/byte count/method and query-redacted source labels. Explicit saved-byte receipt check detects mismatches; not authentication. Raster pixels are not labeled original bytes. Unsigned; TT105 new saves publish media+receipt atomically in one database transaction. Existing orphan legacy files are reported, not rewritten. TT111 measured the receipt end to end for a third time and on a third pathway: a memory saved from retained bytes carries version 1, the exact byte count, the sha256 of the stored bytes, capturedAt from when the response arrived (not when it was saved), a query-redacted source, and method session-retained-response — read back from the archive and compared against the bytes the origin served." },
  "RC-14": { status: "built", test: "tt109-recall.mts + tt111-recall-tap.mts",
    nuance: "The legacy pathway that asks the network for the original bytes again is kept separate from every pathway that saves what the browser had already decoded, and TT109 made that separation enforceable rather than conventional. The server binds attribution to method: only method original-response may claim requested-url. TT111 added a third class rather than blurring the first two — method session-retained-response must claim proxy-recorded-response, meaning this server read those bytes off the wire itself and never decoded them. The binding is one-to-one and was attacked from all three directions: a retained save claiming requested-url, a screen capture claiming proxy-recorded-response and a refetch claiming proxy-recorded-response are each refused with 400 and write nothing." },

  // ---- rows that shipped without a test, measured for the first time -------------------------
  "IN-05": { status: "built", test: "tt111-core.mts",
    nuance: "The conflict detector also checks against browser-reserved chords (Ctrl+T, Ctrl+W, Meta+N …). TT111 measured the shipped table: 21 bindings across the hybrid, Windows-like and Mac-like presets contain zero internal collisions, and all 4 chords that the browser reserves carry a written explanation of who takes them, which is what the warning badge shows. Reserved chords are deliberately NOT avoided — several are the right chord and do reach the app under Keyboard Lock in fullscreen — so the contract is disclosure, not evasion. The detector itself was shown to detect by running the same rule over a table with a planted duplicate." },
  "ST-06": { status: "built", test: "tt111-core.mts",
    nuance: "Also marks browser-reserved chords as unavailable. Shares IN-05's table and detector, and is covered by the same measurement: no preset binds two actions to one chord, and every browser-reserved chord ships with the reason it is reserved. Chords are compared by physical key code (KeyT, Digit1), not by the character a layout happens to produce." },
  "FF-14": { status: "built", test: "tt111-core.mts",
    nuance: "Single source of truth consumed by Files, Peek, Editor, terminal `open`. TT111 measured the registry as a contract: 26 formats covering 47 extensions, no extension claimed by two formats, every entry naming an engine, a grade the UI can explain and a boundary where support stops; an unknown extension resolves to null rather than a guess, lookups are case-insensitive through a path, and a lossy conversion answers with the list of what it drops (Word → txt drops 10 things)." },
  "AX-07": { status: "built", test: "tt111-core.mts",
    nuance: "Browsers only render WebVTT; SRT is converted (comma→dot timestamps, header) instead of failing silently. TT111 measured the conversion: cue numbers removed, 00:00:01,250 becomes 00:00:01.250, no cue text lost, and a file that is already WebVTT is returned byte for byte rather than being wrapped twice." },
  "PR-04": { status: "built", test: "tt111-core.mts",
    nuance: "Re-importing the same .ics never duplicates (dedup by UID). TZID is respected. TT111 measured the reader and writer together: escaped commas and newlines survive parsing, DTSTART in UTC lands on the exact instant, every written line is folded to the 75-octet limit RFC 5545 §3.1 requires, a 150-character summary unfolds back to itself exactly, and two copies of one event in a single file remain one UID." },
  "BK-04": { status: "built", test: "tt111-core.mts",
    nuance: "The migration checklist is a diff of two measured probe reports, because on the web capability varies by browser as much as by device. TT111 measured the diff: a capability that went from available to unavailable is reported as a loss WITH what it costs, one that gained is reported as a gain, unchanged ones are counted, and a capability the old report never knew about is not announced as a gain — which is what keeps the checklist readable after a browser update adds entries to the probe." },
  "RG-06": { status: "built", test: "tt111-core.mts",
    nuance: "Absent deviceMemory (Firefox/Safari) is treated as unknown → normal limits, because absence is not evidence of a small machine. TT111 measured every branch: null, undefined and NaN all give the unknown tier with the normal 24-window cap; 2 GB gives the low tier (6 windows, effects off), 4 GB gives 12, 8 GB gives 24, and each answer quotes the measurement it acted on." },
  "DP-04": { status: "built", test: "tt111-core.mts",
    nuance: "Every write is journalled where a human can read it. TT111 measured both halves of the claim: listing a folder adds no audit row at all, while a file write appears in the log with an actor, an action naming the subsystem (fs.write) and the path it touched. The log has no editing endpoint — an attempt to rewrite it over the API is refused — so it is append-only from everything outside the database." },
  "DP-05": { status: "built", test: "tt111-core.mts",
    nuance: "Reversible by default: trash, versions, settings history, undo. TT111 measured the two paths a person actually uses. A trashed file leaves its folder listing but keeps its row, its bytes and a trashed marker — which is exactly what makes restore possible — and restoring puts it back where it was. A settings write answers with the value it replaced (undoFrom), so undo does not have to guess what the previous value was." },
  "AU-02": { status: "built", test: "tt111-core.mts",
    nuance: "AUDIT: previously over-claimed. Restore keeps the CURRENT viewport and bumps the revision, so a preset saved on a big monitor re-clamps correctly on a laptop and cannot be overwritten by a stale tab. TT111 measured the storage contract: a preset is its own state row under the preset: prefix, reads back exactly what was saved, and a tab holding an older revision is refused with 409 while the newer preset is left untouched — the refusal does not empty it." },
  "PR-02": { status: "built", test: "tt111-core.mts",
    nuance: "Notes are indexed in the same index_docs table as files, so one search covers both; most apps keep a separate note search that disagrees with the file search. TT111 measured it: one query for a string written into both a note and a file returns both, each tagged with its source and carrying the matching text rather than a bare id, and a query for a string in neither returns nothing." },
  "NC-05": { status: "built", test: "tt111-core.mts",
    nuance: "Progress appears at 250 ms (not immediately — avoids flash) and cancel acknowledges in <100 ms by flipping journal state before the work unwinds. TT111 measured the record a progress bar is drawn from: a copy is journalled as an operation row with its byte count and its steps, every row in the store is in one of the five declared states, and a finished copy reports COMPLETE rather than being left running for ever." },
  "ST-04": { status: "built", test: "tt111-core.mts",
    nuance: "The capability report is the primary support artifact and is exportable as JSON with the UA string optional, so bug reports carry measured facts instead of guesses. TT111 measured the redaction a support artifact needs: the exported report contains no filesystem paths, no database URL, no credentials and no authorization header, and a stored report can be read back for the new-device diff." },

  // ---- the dock rows whose e2e assertions were repaired this turn ----------------------------
  "LY-02": { status: "built", test: "layout-unit.mts 'dock magnification' x2; e2e-layout.mts (repaired TT111)",
    nuance: "Art layout after macOS: menu bar, centred dock, traffic lights. TT111 repaired two e2e assertions that had rotted against a product measured correct. Focus after opening a dock stack is now compared with whatever app the registry lists FIRST in that group — Recall joined Create after the assertion was written, so a hard-coded id was failing a dock that was behaving. The magnified icon's name bubble is judged at its resting position (the rule this suite already applies to the stack popover) because the bubble springs up with the icon and can be behind it mid-animation; measured at rest it sits 12 px clear above a 1.75x icon." },
};
