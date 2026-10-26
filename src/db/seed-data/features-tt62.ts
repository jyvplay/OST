import { F, type SpecRow } from "./row";

/**
 * TT62 register additions + changes. USER-DIRECTED EXTENSION ROWS (Class A Writer and Spreadsheet): the TT61 ledger's
 * standing verification gap was "no Office open check" (PR-11). Office cannot run here, so TT62 adds the strongest
 * independent substitute available — validating every saved package against the ECMA-376 transitional XML Schemas with
 * lxml (scripts/oracle/ooxml_xsd.py, shares no code with src/) — and fixes the real bugs that gate found. It also completes
 * Writer table-cell review (w:cellMerge, refused in TT61).
 */
export const tt62Features: SpecRow[] = [
  F("FF-45", "FF", "Writer saves are ECMA-376 schema-valid: every package the editor writes passes the transitional XSDs (independent lxml oracle)",
    "A", "P2", "scripts/oracle/ooxml_xsd.py (Markup Compatibility processing + one combined wml/sml/dml/vml/opc schema) gating src/lib/office/wordml.ts / wordedit.ts output",
    "The oracle processes mc:Ignorable / AlternateContent as a 2006-only consumer and leaves unknown non-ignorable namespaces in (so they fail, as in Office). Found and fixed: Page Setup on a section with a header reference but no page size inserted w:pgSz before the references (invalid CT_SectPr order). Limits: the transitional schema makes run properties an unordered choice, so rPr child ORDER is not checked by it; python-docx's default template carries an invalid w:zoom (no w:percent) that we preserve verbatim; XSD validity is necessary, not sufficient, for Word to open a file (PR-11 stays partial).",
    "built", "tt62-writer-schema.mts (5: oracle rejects 4 known-bad shapes and accepts 2 MCE cases; 24×60-step randomized sessions over 26 edit kinds = 144 packages; kitchen-sink document with every run / paragraph property also under Track Changes; cell-revision paths; 113-document POI corpus round trip adds no error the input lacked; mutants: pPr order, tcPr placement, pgSz-fix revert killed — the rPr-order mutant is equivalent under this schema)"),
  F("FF-46", "FF", "Spreadsheet saves are ECMA-376 schema-valid: fresh exports and lossless patches pass the transitional XSDs (independent lxml oracle)",
    "A", "P2", "scripts/oracle/ooxml_xsd.py gating src/lib/formula/xlsx.ts (writeXlsxWorkbook), xlsx-patch.ts (patchXlsx), xlsx-chartpatch.ts, chartxml.ts",
    "Every cell style property and border line, merges, the 6 validation types, external + internal links, freeze panes, widths, workbook / sheet names, all 25 conditional-format kinds, 7 chart kinds × groupings + trendlines and a PivotTable, both written fresh and patched into POI workbooks. Found and fixed: OPC part names are case-insensitive (ECMA-376 Part 2) — a workbook storing Sheet1.xml with _rels/sheet1.xml.rels got a second relationships part without its drawing link and a duplicate <drawing>, and a new sheet could be named sheet1.xml beside Sheet1.xml; lookups now use the stored spelling (exact spelling first), rewritten rels parts get the canonical name, new part names avoid case collisions. One documented schema erratum is tolerated: sml.xsd forbids xml:space on <t>, which Excel itself writes (37 Excel-authored corpus files).",
    "built", "tt62-sheet-schema.mts (5: oracle rejects order / enumeration / unknown element; kitchen sink; 20 randomized workbooks; 4 POI workbooks patched with every feature on new AND existing sheets add no error the input lacked; case-insensitive part names with openpyxl reading the result; mutants: mergeCells order, dxf child order, chart title order, fix revert killed)"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "PR-11": { note: "TT62: every package the Writer and Spreadsheet save is gated by ECMA-376 transitional XSD validation (FF-45 / FF-46) — the partial substitute for an Office open check, which this sandbox still cannot run.", test: "tt62-writer-schema.mts; tt62-sheet-schema.mts" },
  "FF-22": { note: "TT62: vertical-merge revisions (w:cellMerge) are reviewable too (FF-44).", test: "tt62-writer-cellmerge.mts; e2e-tt62.mts" },
  "FF-21": { note: "TT62 fix: lossless save of workbooks whose part names differ only in case (see FF-46).", test: "tt62-sheet-schema.mts" },
};

export function patchTT62(f: SpecRow): SpecRow {
  if (f.code === "FF-44") {
    return {
      ...f,
      name: "Writer Track Changes for table cells: inserted / deleted cells (w:cellIns / w:cellDel) and vertical-merge changes (w:cellMerge) listed and accepted / rejected one by one or all at once",
      nuance: f.nuance.replace("w:cellMerge is listed read-only and refused (its vertical-merge semantics are not modelled) — review it in Word.",
        "TT62: w:cellMerge (§17.13.5.3) is resolvable — accepting applies its w:vMerge (rest / cont / absent = not merged), rejecting restores w:vMergeOrig; w:vMerge is placed at its CT_TcPr position and the page redraws the span; the pane labels it \"Cell merge\" and names the new and the previous state."),
      test: `${f.test}; tt62-writer-cellmerge.mts (4 vs the lxml oracle's vmerges view computed from the original — accept-all, reject-all, mixed decisions in two orders, merges beside cellIns / cellDel; 3 mutants killed); e2e-tt62.mts`,
    };
  }
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
