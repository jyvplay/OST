import { F, type SpecRow } from "./row";

/**
 * TT67 register additions + changes. USER-DIRECTED EXTENSION ROW (Class A Spreadsheet): the reader matched element names
 * literally, so any workbook not written with Excel's exact prefixes (x:/s: SpreadsheetML from .NET / SAP / report
 * generators, prefixed mc:AlternateContent, x14 under another prefix) was rejected or read empty, and numeric character
 * references (&#10;, &#039;) were shown raw. IN-02 / IN-03 were "built" rows with no code or tests behind them.
 */
export const tt67Features: SpecRow[] = [
  F("FF-51", "FF", "Spreadsheet reads SpreadsheetML by namespace, not by spelling: workbooks written with x: / s: prefixes, prefixed Markup Compatibility, x14 under any prefix, the strict and Excel 2007 beta namespaces, and numeric character references open with every value",
    "A", "P2", "src/lib/office/xml-ns.ts (canonicalizeNs / isCanonicalNs: one tokenising pass at the part-read boundary, canonical prefixes, MCE prefix lists renamed, default namespaces emitted only where needed incl. xmlns=\"\", knownRoot guard) + src/lib/formula/xlsx.ts (get: every part; dec: one-pass numeric references)",
    "Canonicalisation happens once, for READING only: Excel-written parts take a fast path that returns the same string (no copy) and the lossless writer keeps the original bytes. A document whose root is in a namespace nobody knows is read exactly as before (namespace-blind) so the change can only add files that open. Foreign namespaces that borrow a canonical prefix (a custom x14:) are aliased away so they are never mistaken for conditional formatting. References that are not characters (lone surrogates, > U+10FFFF) stay literal.",
    "built", "tt67-sheet-ns.mts (11: lxml equivalence oracle xml_ns_equiv.py over every rewritten part of the 353-file corpus + 13 adversarial shapes; 7 previously unreadable corpus workbooks = an independent lxml namespace-aware cell reader on every non-empty cell and = openpyxl where it opens them (65016: 68 048 cells); whole-corpus differential vs the TT66 reader: 0 worse, 7 newly readable, 3 entity-decoded; x14 under q:/m: confirmed by the MS-XLSX oracle; lossless patch of a prefixed file; cost) ; tt67-sheet-ns-mutants.py"),
];

const UP: Record<string, { note: string; test: string; route?: string; status?: SpecRow["status"] }> = {
  "FF-21": { note: "TT67: namespace-aware reading (FF-51) — 7 corpus workbooks the reader rejected or read empty now open; numeric character references decoded.", test: "tt67-sheet-ns.mts" },
  "SH-06": {
    route: "src/lib/hot-corner.ts (hotCornerTracker) + DesktopSurface (window pointerrawupdate, pointermove fallback; setting shell.hotCorners)",
    status: "partial",
    note: "TT67 correction: what exists is ONE hot corner (top-left 6 × 42 px → launcher) on a window-level pointerrawupdate listener, not a 4 px hit-layer; edge triggers and pointer gestures are not implemented, so the row is partial. Fixed: it now fires once on entry and re-arms after the pointer leaves (macOS behaviour) — TT66 re-fired every 1.2 s while the pointer stayed in the corner, reopening a launcher just closed with Escape.",
    test: "tt67-input.mts (entry-only / re-arm / boundaries; TT66 rule replayed: 3 fires in 3 s at rest vs 1); tt67-input-mutants.py (3 hot-corner mutants); e2e-tt67-input.mts (real CDP pointer moves: opens on entry, 3 s resting jitter after Escape does not reopen, leave + re-enter does, setting off)",
  },
  "IN-02": {
    route: "src/lib/input.ts (mouseConfigFrom / learnButton / guardedButtons / captureNextButton / navActionFor) + src/components/MouseButtonsSettings.tsx (Settings › Shortcuts) + Shell guard + FilesPane + settings-validate",
    note: "TT67: real. Learn Back / Forward records the index the device reports; main (0) and secondary (2) are refused with a reason, learning the other action's index swaps the pair, invalid stored pairs fall back to 3 / 4; the learn overlay is modal (no global shortcut behind it), Escape / Cancel leave it unchanged, the learning press's trailing mouseup / auxclick / contextmenu are swallowed; the shell guard covers 3, 4 and the learned buttons; a test pad shows what each press means.",
    test: "tt67-input.mts (IN-02 config / learning / capture / modal hold); tt67-input-mutants.py; e2e-tt67-input.mts (real CDP presses: swap, persistence across reload, Files Back on the learned button, refusal + context menu swallowed, Escape, Cancel, Reset)",
  },
  "IN-03": {
    route: "src/lib/shortcuts.ts (matchChord physical, chordLabel, learnLayoutPair, mergeLayoutPair) + src/lib/keyboard-layout.ts (getLayoutMap + learned keydowns, memory only) + Settings / cheat sheet labels",
    note: "TT67: real. Letter / digit chords match the PHYSICAL key (KeyboardEvent.code; the produced character only when an event has no code) — until TT67 a chord matched code OR character, so on AZERTY Meta+Q also fired Meta+A and Overview was unreachable. Labels show what the key types: the Keyboard Map API where available, overlaid with keys learned from unmodified typing (never from password / one-time-code fields, shifted symbols or modified presses; a layout switch evicts stale keys).",
    test: "tt67-input.mts (5 layouts × 3 presets property; before-evidence on the TT66 matcher; labels; learner; layout switch); tt67-input-mutants.py; e2e-tt67-input.mts (AZERTY at the event level: Meta+physical Q opens Overview only, Meta+physical A the launcher only; password typing teaches nothing; labels relabel)",
  },
};

export function patchTT67(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
