import { F, type SpecRow } from "./row";

/**
 * TT63 register additions + changes. USER-DIRECTED EXTENSION ROWS (Class A Spreadsheet): the TT62 ledger's standing
 * Spreadsheet gap was "PivotTables reach Excel as values only" — the definition survived only in hidden names this app
 * reads. TT63 writes REAL PivotTable parts (pivotTableDefinition + pivotCacheDefinition + pivotCacheRecords, ECMA-376
 * Part 1 §18.10) on both the fresh export and the lossless save, so Excel and any §18.10 consumer get a live pivot.
 */
export const tt63Features: SpecRow[] = [
  F("FF-47", "FF", "Spreadsheet PivotTables are saved as real Excel PivotTables (pivotTable + pivotCache + records parts) on export and lossless save; native PivotTables are never touched",
    "A", "P2", "src/lib/formula/pivotxml.ts (parts from a PivotDef), xlsx.ts writeXlsxWorkbook (fresh export), xlsx-pivotpatch.ts + xlsx-patch.ts (lossless save), Spreadsheet.tsx save / export status",
    "Tabular Form with Excel's semantics: one cacheField per source column; row / column / filter fields carry their shared items (one per case-insensitive value, first occurrence's caption, like the engine); records hold every source row; items in the engine's sort order; filter-excluded items and a \"(blank)\" item that only comes from empty source rows are hidden; Σ Values as field -2 on columns; subtotals per row field, no column subtotals (the engine draws none); rowGrandTotals = the Grand Total COLUMN and colGrandTotals = the Grand Total ROW (ISO/IEC 29500-1 §18.10.1.73); x14 fillDownLabels (MS-XLSX) because outer labels repeat; refreshOnLoad. A filter on a field that is on neither axis becomes a Report Filter (page field) — written only when Excel's page area above the table is empty or holds exactly the caption the UI writes; otherwise, and when a filter hides every item, that pivot is saved as values + definition and the status names the reason. Lossless save: the app's own tables (matched by sheet + name AND unchanged rowFields / colFields / dataFields / source since load) are regenerated in place (same part names, same cacheId), deleted ones lose table + cache + records + rels + overrides + <pivotCache>; tables re-pivoted in Excel, Excel-made tables and caches shared with another table are never rewritten (ours then gets its own cache or a \"Name (2)\" name); part names referenced by dangling relationships are never reused. Limits: Excel itself was not run (no Office in the sandbox) — validated by the ECMA-376 XSDs, a pandas recomputation and openpyxl's pivot parser; rowItems / colItems are omitted (optional; Excel rebuilds them on refresh); with several value fields AND column fields our grid has no \"Column Labels\" caption row, so Excel's refreshed layout is one row taller; number formats of value fields are not written.",
    "built", "tt63-sheet-pivotparts.mts (10: 13 shapes fresh — rows / cols / 3 values / cols only / 6 + varp functions / boolean rows / 2 col fields without grand column / axis + page filters / mixed-type items / 3 row fields × col + 2 page filters / duplicate headings; 60 randomized pivots; values-only refusals with reasons incl. caption accepted vs wrong caption; lossless regenerate-in-place; delete + add; 5 POI workbooks with native pivots byte-identical; name collision → \"(2)\"; re-pivoted-in-Excel table never overwritten; shared cache → own cache; dangling relationship target not reused — every package XSD-valid, every Fusion table recomputed by pandas from its XML (scripts/oracle/xlsx_pivot.py) and round-tripped by openpyxl's pivot parser; 22 mutants killed: grand-total swap, hidden items, blank-row item, column subtotals, item order, record index, recordCount, stdDev mapping, firstDataRow, page axis, page-area check ×3, fillDownLabels, case-insensitive items, Σ values field, ours-detection, shared-cache, dangling targets, delete, cache drop, name de-dup); e2e-tt63.mts (UI: create with a report filter → Save → XSD + pandas + openpyxl; reopen → edit → Alt+F5 → Save in place; Delete → Save removes every part)"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "FF-21": { note: "TT63: on .xlsx save the pivot is also written as a real Excel PivotTable (FF-47) — no longer values-only in Excel.", test: "tt63-sheet-pivotparts.mts; e2e-tt63.mts" },
  "FF-46": { note: "TT63: the schema gate now covers pivotTable / pivotCacheDefinition / pivotCacheRecords parts (FF-47).", test: "tt63-sheet-pivotparts.mts" },
};

const OLD_FF21 = "Limits: no pivotCache / pivotTable parts — Excel shows the values as an ordinary range, not an Excel PivotTable (not verified in Excel: none in the sandbox).";
const NEW_FF21 = "TT63: the .xlsx also carries real pivotTable / pivotCache / records parts, so Excel opens an Excel PivotTable (FF-47; not opened in Excel here — none in the sandbox — but XSD-, pandas- and openpyxl-verified).";

export function patchTT63(f: SpecRow): SpecRow {
  if (f.code === "FF-21" && f.nuance.includes(OLD_FF21)) f = { ...f, nuance: f.nuance.replace(OLD_FF21, NEW_FF21) };
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
