import { F } from "./row";
import type { SpecRow } from "./row";

/**
 * TT150 — seven engines that were tested but never *registered*.
 *
 * `scripts/tt139-engines.mts` has been asserting these behaviours for turns
 * (57 cases, 57 passing) under codes the register never contained: SR-26,
 * CSV-01, CG-01, IN-09, CK-09, CV-04, ED-11. A code that exists only as a test
 * tag is a claim with no row — the ledger could not see it, the Spec module could
 * not show it, and `tt131-ledger` failed on the orphan tags rather than hiding
 * them. Registering them is not a new claim: it is the claim the tests already
 * make, written down where the register can audit it.
 *
 * The rule for the nuance text below is the register's usual one: it may state
 * what a case in `tt139-engines.mts` asserts, and it must name the limits that
 * remain. Nothing here is promoted on the strength of a similar row.
 */
export const tt150Features: SpecRow[] = [
  F("SR-26", "SR", "Search grammar, ranking, highlighting and relative dates", "A", "P2",
    "src/lib/search-rank.ts (parseQuery/rankSearch/highlightSpans/parseDateValue) + Find",
    "One grammar for what the search box accepts: pinned-only, after/before dates, conjunctive filters and field-scoped negation, with bad input reported rather than silently dropped. Ranking prefers a title match and length-normalises long bodies, so a long document does not win by weight alone; relative dates resolve against a caller-supplied clock instead of the wall clock, which is what makes them testable, and highlight spans are merged so overlaps never nest (a renderer that assumed nesting would double-wrap). Limits: this is a scorer for the local index only — no stemming, no fuzzy matching, no vector similarity, and the highlight ranges are UTF-16 offsets, not grapheme clusters.",
    "built", "tt139-engines.mts (SR-26: grammar, ranking, conjunctive filters, span merging, clock-injected relative dates)"),

  F("CSV-01", "CSV", "CSV that survives real data: quoted delimiters, formula-injection guard", "A", "P1",
    "src/lib/csv.ts (parseCsv/writeCsv/detectDelimiter/unescapeFormulaCell) + Tables, Spreadsheet import",
    "RFC-4180 in both directions: quoted delimiters, doubled quotes and embedded newlines round-trip unchanged, a BOM or CR-only endings are reported rather than silently repaired, an unbalanced quote is an error rather than a guess, and ragged rows are counted instead of dropped. Delimiter detection scores *consistency* across rows rather than frequency, which is why a comma-heavy quoted field cannot outvote the real separator. Export guards against spreadsheet formula injection and the guard is exactly reversible, so a round trip through this app is lossless. Limits: a field cap is enforced for memory safety (a hostile 1 GB field is refused, not parsed), and the parser is UTF-8 — legacy single-byte encodings must be converted first.",
    "built", "tt139-engines.mts (CSV-01/03/04/05: quoted fields, BOM/CR-only reporting, consistency-scored delimiter, reversible injection guard, ragged-row accounting)"),

  F("CG-01", "CG", "Colour engine: WCAG contrast, vision simulation, perceptual lightness", "A", "P2",
    "src/lib/colour.ts (contrastRatio/contrastLevel/simulateVision/relativeLuminance/deltaE76/bestForeground/generateHarmony) + Appearance settings",
    "WCAG contrast is computed from relative luminance and checked against published extremes (#767676 on white lands within a hair of 4.54:1), and the theme helpers pick a readable foreground rather than the naive black-or-white flip. Colour-vision simulation is deterministic and monotone in severity, and it keeps greys grey — the honest assertion there is that a shift is small and bounded, not that it is zero, because a matrix simulation is not a perceptual model. Lightness is OKLab-style perception, not HSL: a red/blue swap is not 'equal brightness', and deltaE76 confirms the two are perceptually far apart. Limits: deltaE76 is the 1976 Euclidean form, not CIEDE2000; the CVD matrices are the widely published approximations, not per-observer measurements; and contrast is computed from declared sRGB values, so a monitor's actual rendering is not measured.",
    "built", "tt139-engines.mts (CG-01: published contrast extremes and threshold, monotone vision simulation, perceptual lightness order, CSS colour parsing, readable-foreground and palette distinctness)"),

  F("IN-09", "IN", "Shortcut registry: hints, reserved chords, scope precedence", "A", "P2",
    "src/lib/keyboard-shortcuts.ts (ShortcutRegistry/normaliseChord/DEFAULT_BINDINGS/RESERVED_CHORDS) + Settings → Shortcuts",
    "Chord normalisation is order-independent and platform-aware, so Ctrl+Shift+K and Shift+Ctrl+K are the same binding and a macOS preset reports Meta where a Windows preset reports Ctrl. The hints shown in the UI are generated from the same table the dispatcher matches, which is the only way a hint cannot drift from the behaviour it describes. Reserved browser chords and internal conflicts are reported, never silently accepted, and scope precedence resolves a dialog Escape without closing the window behind it. Limits: the browser keeps its own reserved keys outside fullscreen (IN-04 states that path); this engine decides which binding wins among ours, and cannot observe an OS-level shortcut at all.",
    "built", "tt139-engines.mts (IN-09: order-independent normalisation, hints from the dispatcher's own data, reserved/conflict reporting, scope precedence)"),

  F("CK-09", "CK", "Civil calendar and time-zone arithmetic without a zone database", "A", "P2",
    "src/lib/calendar-time.ts (daysFromCivil/civilFromDays/partsInZone/resolveWallTime/isoWeek/callOverlap) + Calendar, Clock",
    "Civil day numbers are computed arithmetically and agree with Date.UTC across four centuries, including the leap-year edges; weekday and ISO week match known calendar facts. Wall times that do not exist (a spring-forward gap) and wall times that happen twice (an autumn overlap) are named as such instead of being silently shifted, and a conversion round-trips through the zone it reports. Overlap search is bounded rather than scanning a day minute by minute, and relative phrasing is honest about what it cannot know. Limits: this is arithmetic over an offset the platform supplies — it does not bundle the IANA database, so historical and future political offset changes come from the engine's own tzdata, and DST rules are whatever that engine reports.",
    "built", "tt139-engines.mts (CK-09: four-century civil-day agreement, gap/overlap naming, zone round-trip, ISO week, bounded overlap search)"),

  F("CV-04", "CV", "Dimensional unit conversion with defined factors", "A", "P2",
    "src/lib/units.ts (convert/findUnit/parseQuantity/compatibleUnits/formatQuantity) + Calculator quick convert",
    "Units carry a dimension vector, so a conversion between dimensions is refused with the reason instead of producing a confident wrong number, and defined factors are exact to double precision because they are definitions (1 in = 2.54 cm, 1 lb = 0.45359237 kg) rather than measurements. Free-text quantities parse the forms people actually type, including a bare number with a unit symbol, and formatting avoids the usual 0.30000000000000004. Limits: only the unit families in the table are convertible (no currency, no arbitrary user-defined units), factors are binary64 so the last bits are rounding, and temperature *differences* and absolute temperatures are distinct concepts this table does not conflate silently.",
    "built", "tt139-engines.mts (CV-04: dimension mismatch refused with a reason, defined factors exact to double, free-text quantity parsing)"),

  F("ED-11", "ED", "Find and replace: bounded regex, Unicode boundaries, literal mode", "A", "P2",
    "src/lib/text-search.ts (findMatches/replaceAll/nextMatch/findStatus) + Editor find bar, Files find",
    "An invalid regular expression is reported as an error rather than thrown into the console, and a zero-width pattern is skipped instead of looping forever — the two failure modes that turn a find bar into a frozen tab. Matching honours case sensitivity, whole-word and Unicode boundaries, and replacement is literal in literal mode and expands capture groups only in regex mode, so a `$&` typed by a user is not silently interpreted. Navigation wraps predictably and the status string is the single source of truth for '3 of 17'. Limits: it is a synchronous scan over the text this app holds; there is no streaming index for multi-megabyte buffers, and replacement is not undoable beyond the editor's own history.",
    "built", "tt139-engines.mts (ED-11: invalid/zero-width regex bounded, case and boundary modes, wrap-around navigation, literal vs group-expanding replace)"),
];

/** The seven codes this patch owns — nothing outside this list is touched. */
const TT150_CODES = new Set(tt150Features.map((f) => f.code));

/**
 * Claims for TT150 are the rows themselves. The patch exists so that a later
 * patch in the chain cannot silently leave a row this file just registered at a
 * weaker status: if the code is ours, it stays `built` with its test named.
 */
export function patchTT150(f: SpecRow): SpecRow {
  if (!TT150_CODES.has(f.code)) return f;
  const own = tt150Features.find((r) => r.code === f.code)!;
  return { ...f, status: own.status, test: own.test || f.test };
}
