import type { SpecRow } from "./row";

/**
 * TT50 register changes — Spreadsheet charts become real Excel charts: read from .xlsx, edited, drawn, and written
 * both into new workbooks and (surgically) into edited originals. Evidence: scripts/tt50-charts.mts (openpyxl reader
 * oracle scripts/oracle/xlsx_charts.py over 25 POI corpus workbooks / 30 charts, 0 mismatches; numpy trendline oracle
 * scripts/oracle/trend_np.py over 120 datasets; patch writer re-read on 24 workbooks / 36 charts), 12/12 mutants killed
 * by scripts/tt50-mutants.py, and scripts/e2e-tt50-charts.mts (real UI, Chromium 143).
 */
const CHARTS = "TT50: charts are REAL Excel charts. Read from .xlsx (bar/column, line, area, pie, doughnut, scatter; worksheets and chartsheets; "
  + "one-cell/two-cell/absolute anchors; series name/category/value references with their caches; titles incl. rich and formula titles and Excel's "
  + "automatic title; axis titles; clustered/stacked/100 % grouping; trendlines; legend; blanks as gap/zero/span) — openpyxl agrees field by field on 30 "
  + "charts in 25 real workbooks. Drawn with Excel semantics (negatives stack below zero, 100 % by Σ|v|, horizontal bars bottom-up), live from cells. "
  + "Edited in the Charts panel: title, type, stacking, both axis titles, trendline (linear, exponential, logarithmic, polynomial 2–6, power, moving "
  + "average) with equation and R², legend, placement over a selection, delete; a new chart comes from the selection. All six trendline fits agree with "
  + "numpy on 120 datasets. Saved two ways: new workbooks get chart + drawing parts that openpyxl and our reader read back identically; edited originals "
  + "are patched in place (only the touched chart/drawing parts change, untouched files stay byte-identical; delete removes frame, relationship, part and "
  + "content type; renaming a sheet rewrites the chart references). Limits: 3-D charts are drawn flat; a combo chart draws its first type only; "
  + "radar/stock/surface are drawn as lines and bubble as scatter; one trendline per series; multi-level categories use the innermost level; changing "
  + "a chart's type or series regenerates its part (custom styling of that chart is lost and reported); Excel itself is not available here for a pixel "
  + "comparison.";

export function patchTT50(f: SpecRow): SpecRow {
  if (f.code === "FF-29") {
    const cf = f.nuance.indexOf("TT49: conditional formats");
    return {
      ...f,
      status: "built",
      nuance: CHARTS + " " + (cf >= 0 ? f.nuance.slice(cf) : f.nuance),
      test: `${f.test}; tt50-charts.mts; tt50-mutants.py; e2e-tt50-charts.mts`,
    };
  }
  return f;
}
