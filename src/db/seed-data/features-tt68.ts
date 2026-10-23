import { F, type SpecRow } from "./row";

/**
 * TT68 register additions + changes. USER-DIRECTED EXTENSION ROW (Class A Spreadsheet): the engine could not tell an
 * EMPTY cell from EMPTY TEXT "" (both read as ""), so ISBLANK / COUNTA / ISTEXT / ISNONTEXT / TYPE / COUNTIF "<>" were
 * wrong for formulas returning "", constant empty strings were dropped by the reader / writer / patcher, typed error
 * literals (#N/A) were text, and any error cell inside a criteria range made COUNTIF / SUMIF / COUNTIFS fail.
 */
export const tt68Features: SpecRow[] = [
  F("FF-52", "FF", "Spreadsheet tells empty cells from empty text, keeps error constants and evaluates *IF criteria like Excel: ISBLANK / COUNTA / ISTEXT / ISNONTEXT / TYPE / COUNTIF \"<>\" for formulas returning \"\", constant empty-text cells kept through open, save and lossless save, #N/A typed or stored is an error, error cells in COUNTIF / SUMIF / AVERAGEIF / *IFS ranges are matched instead of failing",
    "A", "P2", "src/lib/formula/engine.ts (blankMask / toArg: a per-element 'truly empty cell' mask for references and ranges, all-false for computed arrays; callExt maps only empty cells to null; parseLiteral: ST_CellError constants) + src/lib/formula/functions.ts (blankAt, COUNTA, ISBLANK, ISTEXT; one blank-aware criteria matcher makeCriteria for COUNTIF / SUMIF / AVERAGEIF / SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS) + src/lib/formula/xlsx.ts (reader keepText, writer) + src/lib/formula/xlsx-patch.ts (empty inline string) + Spreadsheet.tsx (Paste Special modal)",
    "Semantics are Microsoft's (IS functions, COUNTA, COUNTBLANK reference pages) and, for criteria, secondary sources (ablebits, exceljet, MrExcel): \"\" matches empty cells AND empty text, \"=\" only empty cells, \"<>\" every non-empty cell, wildcards only text (~ escapes), an empty cell is not 0 for numeric criteria (\"<>0\" counts it). A criterion that refers to an empty cell means 0 (Microsoft COUNTIFS remarks); Z1&\"\" matches empty cells. Not source-confirmed and left as before: criterion 5 vs text \"5\". A constant t=\"str\" cell with <v></v> and an inlineStr without <is> stay no value (lxml oracle agrees). Paste Values of a formula returning \"\" still writes nothing (Excel writes empty text) — not changed this tier. No Excel available: Excel itself was not run; its CACHED results in the corpus are the held-out oracle.",
    "built", "tt68-blank.mts (8: 27-case Microsoft table — TT67 got 13 wrong; 30-case criteria table — TT67 got 26 wrong; error constants; reader = lxml empty-text oracle on all 6 190 empty-text cells of 8 corpus workbooks (TT67 kept 0); 18 hostile cell shapes with lxml verdicts; writer read back by openpyxl + lxml; lossless patch keeps original <c> byte-for-byte; held-out: Excel's cached results for 26 946 corpus formula cells — TT67 26 287 agree, TT68 26 294, 0 regressions); tt68-blank-mutants.py (29/29 killed); e2e-tt68-sheet.mts (UI values, typing ' and #n/a, save read by lxml + openpyxl, modal-shortcut)"),
];

const UP: Record<string, { note: string; test: string; route?: string; status?: SpecRow["status"] }> = {
  "FF-21": { note: "TT68: constant empty-text string cells (shared string \"\", empty inline string) are read as non-blank empty text (6 190 cells in 8 corpus workbooks, = lxml); an invalid shared-string index (empty, negative, fractional) is no value instead of string #0; t=\"e\" constants are error values.", test: "tt68-blank.mts; tt67-sheet-ns.mts (differential knows the intended empty-text change)" },
  "FF-20": { note: "TT68: the writer saves a constant empty-text cell as a shared \"\" string instead of dropping it.", test: "tt68-blank.mts (writer)" },
  "FF-19": { note: "TT68: empty cell vs empty text (FF-52); error literals typed in a cell are error constants.", test: "tt68-blank.mts" },
  "FF-27": { note: "TT68: COUNTIF / SUMIF / AVERAGEIF / SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS share one criteria matcher — error cells no longer make them fail; *IFS size mismatch → #VALUE!.", test: "tt68-blank.mts (criteria)" },
  "FF-28": { note: "TT68 modal-shortcut fix: Paste Special is modal — focus moves into it and the grid takes no keys while it is open (Delete / Backspace / typing used to edit the selected cell behind it).", test: "e2e-tt68-sheet.mts (modal-shortcut)" },
};

export function patchTT68(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
