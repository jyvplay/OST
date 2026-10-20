import type { SpecRow } from "./row";

/**
 * TT49 register changes — Spreadsheet conditional formatting is DRAWN for every ECMA-376 cfRule type (plus the
 * Excel 2010 x14 extensions), authored for 30 rule kinds in the panel, and written both into new workbooks and into
 * edited originals. Evidence: scripts/tt49-sheet.mts (independent Python evaluator scripts/oracle/xlsx_cf_eval.py —
 * openpyxl + Translator + the `formulas` engine on Excel-cached values — over the 19 POI corpus workbooks with CF:
 * 124 rules / 7,571 cells, 0 mismatches; Apache POI's TestConditionalFormattingEval assertions; documented answers;
 * 9/9 mutants killed by scripts/tt49-mutants.py) and scripts/e2e-tt49.mts (real UI, Chromium 143).
 */
const CF_DRAWN = "TT49: conditional formats are drawn for every rule type — cellIs (8 operators, constant or formula operands, blank = 0), "
  + "expression, text contains/not/begins/ends, blanks/errors, duplicate/unique, top/bottom N and N% (rounded down), above/below average ± 1–3 sample σ, "
  + "10 time periods, 2/3-colour scales, data bars (Excel 2007 10–90 % and Excel 2010 automatic bounds, negative colour, axis, border, solid) and "
  + "icon sets (17 main + 3Stars/3Triangles/5Boxes + custom mixes) — in priority order with stopIfTrue; dxf font, fill, number format and borders. "
  + "An independent Python evaluator agrees on 124 rules / 7,571 cells in 19 real workbooks (0 mismatches; 1 rule it cannot translate, 1 file it cannot open); "
  + "Apache POI's asserted answers hold (33 cells, including after edits).";
const OLD_FF21 = "Conditional formats are rendered for cellIs and colour scales; iconSet/dataBar/formula rules are preserved but not drawn.";
const OLD_FF20 = "new and edited CF rules (cellIs, 2/3-colour scales) are written into <conditionalFormatting> with dxfs.";
const NEW_FF20 = "new and edited CF rules of every kind are written into <conditionalFormatting> with dxfs (a deleted data bar also removes its linked x14 rule); "
  + "the new-file writer emits Excel 2010 x14 parts for data-bar extras and x14-only/custom icon sets (our reader and the independent oracle agree on "
  + "all 25 rule kinds after a write; lxml checks the x14 structure).";

export function patchTT49(f: SpecRow): SpecRow {
  if (f.code === "FF-21") return { ...f, nuance: f.nuance.replace(OLD_FF21, CF_DRAWN), test: `${f.test}; tt49-sheet.mts; e2e-tt49.mts` };
  if (f.code === "FF-20") return { ...f, nuance: f.nuance.replace(OLD_FF20, NEW_FF20), test: `${f.test}; tt49-sheet.mts; e2e-tt49.mts` };
  if (f.code === "FF-29") return {
    ...f,
    nuance: "Charts: engine ported from the competitor TT14 tree (single-series bar/line/pie) and extended with multi-series, nice ticks, legends, scatter and gap "
      + "handling; no axis titles, stacked series or trendlines yet (why this row stays partial). " + CF_DRAWN
      + " The panel authors 30 rule kinds (all of the above except custom icon mixes and per-threshold cfvo editing), each shown at once; while a panel "
      + "input has focus, Delete/typing/Ctrl+Z never reach the grid (e2e). Limits: x14-only expression/cellIs rules (rare) are kept but not drawn; "
      + "Excel's own rendering is not available in this sandbox for a pixel comparison.",
    test: "office-engine.mts; tt49-sheet.mts; tt49-mutants.py; e2e-tt49.mts; e2e-office chart panel",
  };
  return f;
}
