import { F, type SpecRow } from "./row";

/**
 * TT74 register additions + changes (user-directed: "turn both the writer and spreadsheet apps to Class A features this
 * turn … complete one other core feature into class A" → FF-02 extract / convert; "increase the number of features in a
 * testable state" → five new rows, each with a passing headless gate AND a real-browser test).
 * Class A is raised ONLY on a passing, measurable whole-corpus gate whose oracle is independent of the app (mammoth,
 * markdown-it-py, python-docx, python-pptx, openpyxl / Excel's own cached values) — docs/DESIGN-TT74.md §Class A.
 * Microsoft Office / LibreOffice are not available in this sandbox; "A" means ordinary-app grade on the measurable
 * corpus, not "verified in Excel / Word".
 */
const T74 = "tt74-office.mts";
const E74 = "e2e-tt74-office.mts";
export const tt74Features: SpecRow[] = [
  F("FF-53", "FF", "Spreadsheet Hide / Unhide rows and columns and AutoFilter value lists (header ▾ list with counts, Select all, Blanks, Clear), kept through open, Save (new package and in-place lossless save), JSON autosave and row / column insert / delete",
    "A", "P2", "src/lib/formula/sheetfilter.ts (model: manual vs filter-hidden rows, case-insensitive criteria, foreign criteria kept) + xlsx.ts (reader: row / col hidden, sheet + table autoFilter; writer) + xlsx-patch.ts (row hidden attribute, autoFilter element, hidden column spans, the no-edit shortcut compares hidden state) + workbook-json.ts + sheetops.ts insertDelete + sheetlayout.ts stepCell (arrows skip hidden rows / columns) + Spreadsheet.tsx (visible-row index, Filter / Hide rows / Hide cols / Unhide, filter list dialog)",
    "Excel semantics: Unhide shows only hand-hidden rows (filtered rows return when the criteria change or the filter is turned off); criteria are the displayed texts, case-insensitive, \"\" = (Blanks). Value lists only: custom / top-10 / dynamic / colour / icon / date-group criteria read from a file are kept and keep the file's hidden rows, but are not re-applied or editable (marked foreign). The file format has one hidden flag per row: inside an AutoFilter WITH criteria every hidden row reads back as filtered (a criteria-less filter: hand-hidden — Excel's own reading of POI ConditionalFormattingSamples). Export .xlsx (new package) does not write Excel tables, so a TABLE's own filter is not exported (the in-place Save keeps it). Grouping / outline levels are not modelled.",
    "built", `${T74} U4 (model), U5 (new package re-read by us + openpyxl), U6 (in-place save: hide-only save is not mistaken for no-edit, openpyxl sees hide / unhide / AutoFilter, table-filter rows keep Excel's SUBTOTALs), U7 (JSON), U8 (insert / delete), U9 (keyboard), N10 / N11 / N13; tt74-mutants.py H1–H15; ${E74} 1 (filter list, Hide rows, arrows, Save → openpyxl, Unhide, Clear) and 2 (modal shortcut: filter list keys / clipboard never reach the grid)`),
  F("FF-54", "FF", "SUBTOTAL / AGGREGATE hidden-row semantics: 1–11 skip filtered rows, 101–111 skip every hidden row, AGGREGATE options 1 / 3 / 5 / 7 skip hidden rows, nested SUBTOTAL / AGGREGATE never counted, hidden columns never skipped, Excel's all-excluded results",
    "A", "P2", "src/lib/formula/engine.ts (rowHidden in both evaluation contexts; evalSubtotal passes ranges as references so blanks and hidden rows are known)",
    "Matches Excel's cached values in the corpus (POI ConditionalFormattingSamples: table icon filter → SUBTOTAL 9 = 1,469,066; criteria-less table filter with a hand-hidden row → SUBTOTAL 9 = 9,071,953 and 109 = 8,171,954). AGGREGATE's error-ignoring options are as before.",
    "built", `${T74} U3 (16 cases), U6 (corpus SUBTOTALs after an in-place save), N12; tt74-mutants.py H4 / H5; ${E74} 1 (SUBTOTAL 9 / 109 in the UI after the filter and Hide rows)`),
  F("FF-55", "FF", "Spreadsheet CSV export (active sheet, displayed text of the used range, CRLF, RFC 4180 quoting, optional UTF-8 BOM) and import (delimiter sniffing, Excel typing of numbers / dates / times / booleans / errors, formula-injection guard, 2 M-cell cap)",
    "A", "P2", "src/lib/formula/csv.ts + Spreadsheet.tsx (Export CSV with the itemised loss dialog; Import CSV into a new sheet) + /api/forge op convert (xlsx → csv / tsv, csv / tsv → xlsx)",
    "Excel semantics from Microsoft's CSV pages: only the active sheet, values as displayed, conditional formats not applied, number formats applied. Declared differences: Excel's 16-row trailing-delimiter quirk is not copied; fields starting with = + - @ are imported as text (never formulas) — Excel would evaluate them; typing is en-US (M/D/Y dates). X1 allowlist (77 cells, each with evidence) = TODAY() caches, add-ins, iterative calculation, stale POI caches, oracle limits; 14 POI EverythingTests edge cells remain our open bugs (listed in DESIGN-TT74).",
    "built", `${T74} X1 (446,489 / 446,580 corpus cells = openpyxl's view of Excel's cached values; 0 disagreements outside the evidence allowlist), X2 (783 / 783 raw round trips; 780 / 783 display fixpoints — the 3 are Excel's own 6-digit General rendering), U1, N1–N5, N14; tt74-mutants.py C1 / C2; ${E74} 3 (download, cancel, import)`),
  F("FF-56", "FF", "Writer Markdown / plain text / HTML export and Markdown import (CommonMark + GFM tables, task lists, strikethrough, footnotes, autolinks) with an itemised loss report before anything is written",
    "A", "P2", "src/lib/office/convert-word.ts (docx → Markdown / HTML / text, wordConversionLoss) + md2docx.ts (Markdown → docx; unsafe link targets dropped; raw HTML literal except <sup> <sub> <br>) + export-ask.ts + Writer.tsx (Markdown / HTML / Text / From Markdown…)",
    "Gate oracles: mammoth 1.13 (docx → Markdown, BSD-2, test-only) and markdown-it-py (CommonMark / GFM, MIT, test-only); both are only oracles — the converters are original code. Declared prep rewrites for mammoth comparisons are listed in DESIGN-TT74 (math, ruby, fields, VML, list levels 6–9 …). What Markdown cannot carry (fonts, colours, page layout, comments, tracked changes, headers / footers, text boxes) is itemised in the export dialog.",
    "built", `${T74} D1 (111 / 111 corpus documents agree with mammoth on 7 axes), M1 (386 / 386 corpus Markdown files agree with markdown-it-py on 7 axes; python-docx opens 386 / 386), U9, N6–N9; tt74-mutants.py C3 / C4; ${E74} 4`),
  F("FF-57", "FF", "Slides outline export (Markdown or plain text: slide titles, bullet levels, tables, notes, hidden slides optional) with the loss report",
    "A", "P2", "src/lib/office/convert-slides.ts (deckToIR / deckToMarkdown / deckToText) + Slides.tsx (Outline…) + /api/forge op convert (pptx → md / txt)",
    "Gate oracle: python-pptx (MIT, test-only). Shape positions, fonts, colours, backgrounds, layouts / masters, transitions and animations are not carried (declared in the dialog). Picture alt text is excluded from the comparison where python-pptx cannot resolve it (300 shapes, counted).",
    "built", `${T74} K1 (83 / 83 corpus decks, 551 / 551 slides agree with python-pptx); ${E74} 5`),
];

const UP: Record<string, { note: string; test: string; tier?: SpecRow["tier"]; status?: SpecRow["status"]; route?: string }> = {
  "FF-02": {
    tier: "A", status: "built",
    note: "TT74 class A: every conversion pair the app offers passes a whole-corpus gate with an independent oracle — docx → Markdown 111 / 111 documents (mammoth, 7 axes), Markdown → docx 386 / 386 (markdown-it-py, 7 axes; python-docx opens all), pptx → outline 83 / 83 decks and 551 / 551 slides (python-pptx), xlsx → CSV 446,489 / 446,580 cells (openpyxl on Excel's cached values; the other 91 are an evidence allowlist of 77 + 14 disclosed open cells) and CSV round trips 783 / 783. Every export shows an itemised loss report first (in-app dialog; Cancel writes nothing). The API keeps reporting fidelity honestly (grade D for extraction-only formats; docx / xlsx / pptx A). Not converted: PDF (FF-03), legacy .doc / .xls / .ppt, OOXML Strict WordprocessingML.",
    test: `${T74} D1 M1 K1 X1 X2 U1 U9 N1–N9 N14; ${E74} 3–5`,
  },
  "PR-11": {
    tier: "A", status: "built",
    note: "TT74: raised to A — the Office documents family is now Writer (FF-22 A), Slides (FF-23 A), Spreadsheet (FF-19 / FF-21 A), charts / CF (FF-29 A) and extract / convert (FF-02 A), each on a whole-corpus independent-oracle gate. Office itself was not run (not available in the sandbox).",
    test: `${T74}; tt73-office.mts; ${E74}`,
  },
  "FF-21": {
    note: "TT74: Hide / Unhide and AutoFilter (FF-53), SUBTOTAL / AGGREGATE hidden rows (FF-54), CSV (FF-55); cached external-workbook link values now survive the JSON autosave (TT73 limit removed); CSE array formulas fill exactly their range (POI Matrix: 167 cells fixed); ROUND on the 15-digit decimal (2.675 → 2.68); A-family text arguments; XLOOKUP binary search lands like Excel; LEFT / RIGHT / MID / REPLACE / SUBSTITUTE truncate and range-check their counts; DATE truncates; YEAR / MONTH / DAY / WEEKDAY of a negative serial are #NUM!; SUMPRODUCT returns an error found in its arrays. A save whose only change was hiding rows used to be treated as no edit and returned the original bytes — found by the TT74 adversary, fixed, and now a gate case.",
    test: `${T74} U2 U3 U6 U7 X1; tt74-mutants.py (25 / 25 killed)`,
  },
  "FF-52": {
    note: "TT74: the corpus CSV gate X1 (446,580 Excel-cached cells — every cell, not only formulas) agrees on 446,489 (TT74 start: 446,295); the held-out formula floor is re-checked by tt73-office H1.",
    test: `${T74} X1; tt73-office.mts H1`,
  },
};

export function patchTT74(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, tier: u.tier ?? f.tier, status: u.status ?? f.status, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
