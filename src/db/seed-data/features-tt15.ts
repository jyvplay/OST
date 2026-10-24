import { F, type SpecRow, type Status } from "./row";

/**
 * TT15 register additions and corrections. New rows FF-26..FF-29 describe
 * capabilities that existed only in tests/docs before (FF-26/27 were referenced
 * by test `covers` but missing from the register, so the ledger could not count
 * them). Status words follow row.ts definitions; verification evidence is named
 * in each nuance so the claim can be checked.
 */
export const tt15Features: SpecRow[] = [
  F("FF-26", "FF", "Dynamic arrays: spill ranges, #SPILL! blocking, broadcasting, array-aware IF/IFERROR, SEQUENCE/FILTER/SORT/SORTBY/UNIQUE",
    "A", "P2", "src/lib/formula/engine.ts v3.4: bounded fixed-point spill resolution (8 passes, 20,000-cell cap), spill ownership map, Workbook.valueAt",
    "Every spilled cell is asserted, not just the anchor (scripts/office-engine.mts). SORTBY was documented but missing (→ #NAME?) until the TT15 real-browser run caught it; SORT now uses Excel ordering (numbers < text (case-insensitive) < logicals < errors, blanks last). Export: spill anchors are written as ECMA-376 array formulas (t=\"array\" ref) with cached child values — verified by openpyxl reading our file; Excel 365 XLDAPR dynamic-array metadata is NOT emitted (no Excel available to verify), so Excel shows them as legacy {=…} arrays with correct values.",
    "built", "office-engine.mts dynamic-array + SORTBY tests; oracle-xlsx A (array ref + cached children); e2e-office SORTBY spill outline"),
  F("FF-27", "FF", "Extended function library (~309 functions: financial, statistical, engineering, text, lookup, date)",
    "A", "P2", "src/lib/formula/ext/* via the callExt adapter; first-party functions.ts keeps precedence",
    "Second independent oracle: PyPI `formulas` 1.3.4 — 129 agree, 0 disagree, 5 unsupported by the oracle, 7 documented cases where the oracle contradicts Microsoft documentation (not 'fixed' toward it). It caught real bugs: IPMT/PPMT sign, DATEDIF comma-operator bug, engineering conversions. Functions without an oracle vector are implemented to Microsoft documentation but unverified individually.",
    "built", "oracle-parity.mts oracle 2; office-engine.mts library tests"),
  F("FF-28", "FF", "Spreadsheet editing UX: range selection, fill handle/AutoFill, clipboard, undo/redo, formatting & number formats, sort, insert/delete rows/cols, resize, freeze, find/replace, autocomplete",
    "A", "P2", "Spreadsheet module v2 over src/lib/formula/{sheetops,sheetui,numfmt}.ts; virtualised A..AZ × 1000 grid",
    "Pure logic is headless-tested (reference shifting with $ anchors, structural #REF! repair, least-squares AutoFill, stable sort with blanks last, TSV quoting, Excel format codes incl. sections/[Red]/dates/E+/scaling). UI verified in real Chromium (e2e-office.mts, 11 tests) with real mouse/keyboard. Gaps: grid bounded to 52 columns × 1000 rows; wrapped text is clipped (fixed row height); cut-paste does not re-point formulas that referenced the moved cells; no merged cells, borders, data validation or comments.",
    "built", "office-engine-2 sheetops/numfmt/sheetui tests; e2e-office.mts"),
  F("FF-29", "FF", "Charts (bar/line/pie/scatter, multi-series) and conditional formatting rules",
    "B", "P2", "src/lib/formula/sheetmeta.ts → SVG via <img src=data:> (script-inert); rules evaluated on computed values; persisted in workbook JSON",
    "Chart engine ported from the competitor TT14 tree (single-series bar/line/pie) and extended with multi-series, nice ticks, legends, scatter, gap handling. Conditional formats: >, <, =, between, contains, duplicate, top-N, 2-colour scale with Excel priority order. NOT exported to .xlsx (loss reported in the UI on export); no axis titles, stacked series, trendlines, icon sets or data bars.",
    "partial", "office-engine-2 chart/cond-format tests; e2e-office chart panel"),
];

type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };
export const UPDATES_TT15: Record<string, Patch> = {
  "FF-20": { status: "partial", route: "src/lib/formula/xlsx.ts writer: styles.xml (fonts b/i/u/colour, solid fills, numFmts, alignment, wrap), <cols> widths, frozen panes, _xlfn./_xlws. prefixes, array formulas for spills",
    nuance: "TT15: verified by an independent OOXML implementation (openpyxl 3.1, scripts/oracle-xlsx.mts A): values, formulas with future-function prefixes, array refs + cached children, fonts, fills, number formats, alignment, widths, freeze. The oracle found and we fixed a lossy mapping (date codes onto locale-dependent built-in ids 14/22). Still partial: no Excel/LibreOffice open/save in this sandbox; charts, conditional formats, borders, merged cells, defined names are not written." },
  "FF-21": { status: "partial", route: "src/lib/formula/xlsx.ts reader: styles, widths, panes, shared formulas (expanded by reference shifting), array formulas (stale children skipped), _xlfn stripping",
    nuance: "TT15: reads an openpyxl-authored file with Excel-style shared and array formulas injected at XML level (oracle-xlsx B). Fixed a real reader bug: self-closing styled blank cells (<c r=… s=…/>) swallowed the next cell's content. Theme/indexed colours read as unset; borders, merged cells, defined names, conditional formats, charts are not read." },
};
