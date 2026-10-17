import { F, type SpecRow, type Status } from "./row";

/**
 * TT17 register additions: spreadsheet layout (merged cells, borders, data validation, frozen columns).
 * Each claim names its verifying evidence; interpretations and gaps are stated in the nuance.
 */
export const tt17Features: SpecRow[] = [
  F("FF-33", "FF", "Merged cells: Merge & Center / Merge Across / Merge Cells / Unmerge, merge-aware selection and keyboard navigation, structural repair, xlsx <mergeCells> both directions",
    "A", "P2", "src/lib/formula/sheetlayout.ts (pure) + Spreadsheet.tsx (spanning cells in the virtualised grid, clipped per frozen/body segment)",
    "Excel behaviour web-checked: Excel's dialog text says merging keeps only the 'upper-left most data' (implemented as the first non-empty cell in reading order — an interpretation, not verified in Excel); sorting a range with merges is refused (Microsoft Learn: 'requires the merged cells to be identically sized' — we refuse whenever a merge intersects, stricter than Excel's equal-size exception); paste over part of a merge is refused. Selection expands to whole merges (fixed point); arrows leave from the far edge and land on anchors. Insert/delete rows/cols grow/shrink/shift/drop merges. Interop verified with openpyxl 3.1 in both directions and through the full UI → server export → reopen path.",
    "built", "sheet-layout.mts; oracle-xlsx.mts C/D; e2e-sheet-layout.mts"),
  F("FF-34", "FF", "Cell borders: All/Outside/Thick Outside/Inside/Top/Bottom/Bottom Double/Left/Right/No Border presets, 7 line styles, colour; xlsx borders both directions",
    "A", "P2", "CellStyle.border (per-edge, ECMA-376 §18.8.4) + applyBorders/edgeAt; grid overlay draws each shared edge once with the heavier side",
    "openpyxl reads our per-edge style+colour exactly and we read its files (theme colours read as unset; mediumDashed/dashDot/slant styles dropped — declared). Found and fixed a latent writer bug while adding borders: the style-dedup key used a JSON.stringify key-array replacer, which also filters nested keys, so two styles differing only in border sides would have shared one xf. Diagonal borders not supported.",
    "built", "sheet-layout.mts borders; oracle-xlsx.mts C/D; e2e-sheet-layout.mts borders + round trip"),
  F("FF-35", "FF", "Data validation: list (typed ≤255 chars or range source, in-cell dropdown, Alt+↓), whole/decimal/date/text-length with 8 operators, custom formula (relative), ignore-blank, Stop/Warning/Information alerts, input messages, Circle Invalid Data; xlsx <dataValidations> both directions",
    "A", "P2", "sheetlayout.ts validateEntry (set → recalc → test resulting value → roll back) + Spreadsheet.tsx alert bar (Retry/Cancel · Yes/No/Cancel · OK/Cancel) and list menu",
    "Excel semantics web-checked: only Stop blocks; typed list sources are capped at 255 characters (Excel repairs longer lists away); pasting replaces cells without validation (so Circle Invalid audits); OOXML showDropDown=\"1\" HIDES the arrow (inverted name, modelled and tested). Formula entries are validated on their result. List matching is case-insensitive (widely documented; not verified in Excel here). Gaps: x14 extLst validations (cross-sheet lists in some older files) are not read; no Paste Special → Validation; date rules take serial numbers in the panel.",
    "built", "sheet-layout.mts validation tests; oracle-xlsx.mts C/D; e2e-sheet-layout.mts"),
];

type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };
export const UPDATES_TT17: Record<string, Patch> = {
  "FF-20": { status: "partial", route: "src/lib/formula/xlsx.ts writer: styles.xml (fonts, fills, numFmts, alignment incl. vertical, wrap, per-edge borders), <cols>, frozen rows+cols, <mergeCells>, <dataValidations>, _xlfn./_xlws. prefixes, array formulas for spills",
    nuance: "Verified by an independent OOXML implementation (openpyxl 3.1, oracle-xlsx A and C): values, formulas with future-function prefixes, array refs + cached children, fonts, fills, number formats, alignment, widths, freeze rows+cols, merges, borders, data validations. Still partial: no Excel/LibreOffice open/save in this sandbox; charts, conditional formats, defined names, comments are not written.",
    test: "oracle-xlsx.mts A, C; e2e-sheet-layout.mts round trip" },
  "FF-21": { status: "partial", route: "src/lib/formula/xlsx.ts reader: styles (incl. borders, vertical alignment), widths, panes (xSplit/ySplit), merges, data validations, shared formulas, array formulas, _xlfn stripping",
    nuance: "Reads openpyxl-authored files (oracle-xlsx B and D) including Excel-style shared/array formulas, merges, borders and six validation kinds; rules then enforce typed entries. Theme/indexed colours read as unset; x14 extLst validations, defined names, conditional formats, charts, comments are not read. No real Excel file corpus available in the sandbox.",
    test: "oracle-xlsx.mts B, D; e2e-sheet-layout.mts reopen" },
};
