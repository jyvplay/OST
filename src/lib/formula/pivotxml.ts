/**
 * TT63 — real PivotTable parts for .xlsx save (original code; written from ECMA-376 Part 1 §18.10
 * (pivotTableDefinition, pivotCacheDefinition, pivotCacheRecords) and MS-XLSX §2.2.4 (x14:pivotField ext).
 *
 * Up to TT62 a PivotTable reached Excel as plain values (+ the hidden `_FusionPivot` definition names). This module
 * turns a PivotDef into the three OPC parts Excel uses, so the saved file holds a REAL PivotTable that Excel (and any
 * consumer that reads §18.10) can refresh, re-pivot and filter:
 *
 *   pivotCacheDefinition — worksheet source (sheet + ref), one cacheField per source column; axis / filter fields
 *                          carry their full sharedItems (one item per case-insensitive value, captioned by its first
 *                          occurrence — the same rule as the engine's cache), the other fields only the type flags
 *                          (containsString / containsBlank / containsNumber / minValue / maxValue …);
 *   pivotCacheRecords    — one <r> per source row (all rows, like Excel), <x v> for shared-item fields, inline
 *                          n / s / b / e / m for the others;
 *   pivotTableDefinition — Tabular Form (compact="0" outline="0" per field + x14 fillDownLabels, because the engine
 *                          repeats outer item labels on every row), location = the cells the last Refresh wrote,
 *                          items in the engine's sort order, filter-excluded items hidden (h="1"), subtotals and the
 *                          two grand totals mapped per §18.10.1.73 (rowGrandTotals = the Grand Total COLUMN,
 *                          colGrandTotals = the Grand Total ROW), Σ Values as field -2 on the column axis.
 *
 * A filter on a field that is on neither Rows nor Columns becomes a Report Filter (page field). Excel draws page
 * fields in the 2 columns × N rows directly above the PivotTable with one blank row between (§18.10.1.73 "page field
 * area"); when those cells are not free the pivot is NOT exported as a PivotTable (the reason is reported and the
 * values + definition names are still saved) — Excel would otherwise draw the filter over the user's data.
 * The cache is flagged refreshOnLoad so Excel recomputes the view from the source on open.
 */
import { compareItems, computePivot, FN_LABEL, itemLabel, keyOf, validateSpec, type PVal, type PivotFn } from "./pivot";
import { readTable, type PivotDef } from "./pivotsheet";
import { parseA1Range, rangeA1, type Range } from "./sheetops";
import type { Sheet, Workbook } from "./engine";

export const NS_SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const NS_X14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main";
export const CT_PIVOT_TABLE = "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml";
export const CT_PIVOT_CACHE = "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml";
export const CT_PIVOT_RECORDS = "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml";
export const REL_PIVOT_TABLE = `${NS_REL}/pivotTable`;
export const REL_PIVOT_CACHE = `${NS_REL}/pivotCacheDefinition`;
export const REL_PIVOT_RECORDS = `${NS_REL}/pivotCacheRecords`;
/** MS-XLSX §2.2.4.? — the x14 pivotField extension (fillDownLabels = "Repeat All Item Labels") */
export const EXT_PIVOT_FIELD = "{2946ED86-A175-432A-8AC1-64E0C546D7DE}";

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isBlank = (v: PVal) => v === null || v === undefined || v === "";
const isErr = (v: PVal): v is { e: string } => typeof v === "object" && v !== null;
/** xsd:double lexical form for a finite number */
const dbl = (n: number) => String(n);

export interface PivotParts {
  /** the PivotTable name actually written (unique on its sheet) */
  name: string;
  cacheXml: string; recordsXml: string; tableXml: string;
  /** the A1 range of the table body (location/@ref) */
  ref: string;
  /** number of Report Filter (page) fields */
  pages: number;
}
export type PivotPartsResult = { ok: true; parts: PivotParts } | { ok: false; why: string };
export interface PivotPartsOpts {
  /** the sheet name as it is written in the package (the fresh writer may sanitise names) */
  sheetName?: (name: string) => string;
  /** relationship id of the records part inside the cache definition's rels (default rId1) */
  recordsRid?: string;
  /** a name override (e.g. de-duplicated against PivotTables already on the sheet) */
  name?: string;
}

/** a value as a cache item element */
function itemXml(v: PVal): string {
  if (isBlank(v)) return "<m/>";
  if (isErr(v)) return `<e v="${esc(v.e)}"/>`;
  if (typeof v === "boolean") return `<b v="${v ? 1 : 0}"/>`;
  if (typeof v === "number") return Number.isFinite(v) ? `<n v="${dbl(v)}"/>` : `<e v="#NUM!"/>`;
  return `<s v="${esc(String(v))}"/>`;
}
const norm = (v: PVal | undefined): PVal => (v === undefined || v === "" ? null : typeof v === "number" && !Number.isFinite(v) ? { e: "#NUM!" } : v);

/** §18.10.1.90 sharedItems attributes describing the types present in a field */
function sharedAttrs(vals: PVal[]): string {
  let str = false, num = false, bool = false, err = false, blank = false, int = true, long = false, min = Infinity, max = -Infinity;
  for (const v of vals) {
    if (isBlank(v)) blank = true;
    else if (isErr(v)) err = true;
    else if (typeof v === "boolean") bool = true;
    else if (typeof v === "number") { num = true; if (!Number.isInteger(v)) int = false; if (v < min) min = v; if (v > max) max = v; }
    else { str = true; if (String(v).length > 255) long = true; }
  }
  const a: string[] = [];
  // containsSemiMixedTypes (default 1) = "contains text or blank"; containsString (default 1)
  if (!str && !blank) a.push(`containsSemiMixedTypes="0"`);
  if (!str) a.push(`containsString="0"`);
  if ([str, num, bool, err].filter(Boolean).length > 1) a.push(`containsMixedTypes="1"`);
  if (num) { a.push(`containsNumber="1"`); if (int) a.push(`containsInteger="1"`); a.push(`minValue="${dbl(min)}"`, `maxValue="${dbl(max)}"`); }
  if (blank) a.push(`containsBlank="1"`);
  if (long) a.push(`longText="1"`);
  return a.join(" ");
}

const SUBTOTAL: Record<PivotFn, string> = { sum: "sum", count: "count", average: "average", max: "max", min: "min", product: "product", countNums: "countNums", stdDev: "stdDev", stdDevp: "stdDevp", var: "var", varp: "varp" };

/** cache field names must be unique (Excel appends 2, 3, … to a repeated heading) */
export function cacheFieldNames(header: PVal[]): string[] {
  const used = new Set<string>();
  return header.map((h) => {
    const base = itemLabel(h); let n = base, k = 2;
    while (used.has(n.toLowerCase())) n = `${base}${k++}`;
    used.add(n.toLowerCase()); return n;
  });
}

/**
 * The page-field area Excel draws above a PivotTable with N Report Filters: rows anchor-N-1 … anchor-2 hold
 * "field name | (All) / item / (Multiple Items)" in the table's first 2 columns, row anchor-1 stays blank
 * (§18.10.1.73). A cell there may be empty or already hold exactly that caption (the Spreadsheet UI writes it);
 * anything else is user data Excel would draw over → null = fits, else the reason.
 */
export function pageAreaProblem(host: Sheet, anchor: { col: number; row: number }, pages: { label: string; value: string }[] | number): string | null {
  const list = typeof pages === "number" ? Array.from({ length: pages }, () => ({ label: "", value: "" })) : pages;
  const np = list.length; if (!np) return null;
  if (anchor.row < np + 1) return `its ${np} report filter${np > 1 ? "s need" : " needs"} ${np + 1} empty rows above the PivotTable (Excel draws the filter there)`;
  const shown = (c: number, r: number) => { const v = host.get(c, r)?.value; return v === undefined || v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "object" ? "\u0000" : String(v); };
  for (let k = 0; k <= np; k++) {
    const r = anchor.row - np - 1 + k, want = k < np ? list[k] : { label: "", value: "" };
    for (const [c, txt] of [[anchor.col, want.label], [anchor.col + 1, want.value]] as const) {
      if (!host.occupied(c, r)) continue;
      if (txt && shown(c, r) === txt) continue;
      return `the report-filter cells above the PivotTable (${rangeA1({ c0: anchor.col, r0: anchor.row - np - 1, c1: anchor.col + 1, r1: anchor.row - 1 })}) hold other data`;
    }
  }
  return null;
}

/**
 * Build the three parts for one PivotTable. `cacheId` is the workbook-level pivotCache id the table points at.
 * Returns {ok:false, why} when the definition cannot be expressed faithfully (the caller saves values only).
 */
export function pivotPartsFor(wb: Workbook, host: Sheet, def: PivotDef, cacheId: number, opts: PivotPartsOpts = {}): PivotPartsResult {
  if (!def.out) return { ok: false, why: "it was never refreshed" };
  let table: PVal[][];
  try { table = readTable(wb, def.src); } catch (e) { return { ok: false, why: (e as Error).message }; }
  table = table.map((r) => r.map(norm));
  const header = table[0] ?? [];
  const bad = validateSpec(header, def.spec); if (bad) return { ok: false, why: bad };
  const src = parseA1Range(def.src.ref); if (!src) return { ok: false, why: "the source range is not valid" };
  let result;
  try { result = computePivot(table, def.spec); } catch (e) { return { ok: false, why: (e as Error).message }; }
  const spec = def.spec, nf = header.length, recs = table.slice(1);
  const names = cacheFieldNames(header);
  // filters: the include lists of every filter on a field, intersected
  const inc = new Map<number, Set<string>>();
  for (const f of spec.filters ?? []) { const s = new Set(f.include); const was = inc.get(f.field); inc.set(f.field, was ? new Set([...was].filter((x) => s.has(x))) : s); }
  const onAxis = new Set([...spec.rows, ...spec.cols]);
  const pages = [...inc.keys()].filter((f) => !onAxis.has(f)).sort((a, b) => a - b);
  const pageWhy = pageAreaProblem(host, def.anchor, pages.map((f) => { const keep = [...inc.get(f)!]; return { label: itemLabel(header[f]), value: keep.length === 1 ? keep[0] : "(Multiple Items)" }; }));
  if (pageWhy) return { ok: false, why: pageWhy };
  const itemFields = new Set([...onAxis, ...pages]);

  // shared items (first-occurrence order, case-insensitive identity) for axis / page fields
  const items = new Map<number, { vals: PVal[]; index: Map<string, number> }>();
  for (const f of itemFields) {
    const vals: PVal[] = [], index = new Map<string, number>();
    for (const r of recs) { const v = r[f] ?? null; const k = keyOf(v); if (!index.has(k)) { index.set(k, vals.length); vals.push(v); } }
    items.set(f, { vals, index });
  }
  // a "(blank)" item that only comes from all-blank source rows: the engine drops those rows, Excel shows the item → hide it
  const nonEmpty = recs.filter((r) => r.some((v) => !isBlank(v)));

  // ---- cache definition
  const cacheFields = header.map((_, f) => {
    const col = recs.map((r) => r[f] ?? null);
    const it = items.get(f);
    const attrs = sharedAttrs(col);
    const body = it ? `<sharedItems${attrs ? " " + attrs : ""} count="${it.vals.length}">${it.vals.map(itemXml).join("")}</sharedItems>` : `<sharedItems${attrs ? " " + attrs : ""}/>`;
    return `<cacheField name="${esc(names[f])}" numFmtId="0">${body}</cacheField>`;
  });
  const sheetName = (opts.sheetName ?? ((n: string) => n))(def.src.sheet);
  const rid = opts.recordsRid ?? "rId1";
  const cacheXml = `${XML_HEAD}<pivotCacheDefinition xmlns="${NS_SML}" xmlns:r="${NS_REL}" r:id="${rid}" refreshOnLoad="1" refreshedBy="Fusion" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="${recs.length}"><cacheSource type="worksheet"><worksheetSource ref="${rangeA1(src)}" sheet="${esc(sheetName)}"/></cacheSource><cacheFields count="${nf}">${cacheFields.join("")}</cacheFields></pivotCacheDefinition>`;

  // ---- records
  const recXml = recs.map((r) => `<r>${header.map((_, f) => { const v = r[f] ?? null; const it = items.get(f); return it ? `<x v="${it.index.get(keyOf(v))}"/>` : itemXml(v); }).join("")}</r>`);
  const recordsXml = `${XML_HEAD}<pivotCacheRecords xmlns="${NS_SML}" xmlns:r="${NS_REL}" count="${recs.length}">${recXml.join("")}</pivotCacheRecords>`;

  // ---- table definition
  const vals = spec.values.length ? spec.values : [{ field: spec.rows[0] ?? spec.cols[0], fn: "count" as PivotFn }];
  const nv = vals.length, nr = spec.rows.length;
  const subtotals = spec.subtotals !== false, grandRows = spec.grandRows !== false, grandCols = spec.grandCols !== false;
  const dataFieldSet = new Set(vals.map((v) => v.field));
  const fillDown = `<extLst><ext uri="${EXT_PIVOT_FIELD}" xmlns:x14="${NS_X14}"><x14:pivotField fillDownLabels="1"/></ext></extLst>`;
  const pivotFields = header.map((_, f) => {
    const a: string[] = [];
    const axis = spec.rows.includes(f) ? "axisRow" : spec.cols.includes(f) ? "axisCol" : pages.includes(f) ? "axisPage" : "";
    if (axis) a.push(`axis="${axis}"`);
    if (dataFieldSet.has(f)) a.push(`dataField="1"`);
    a.push(`compact="0"`, `outline="0"`, `showAll="0"`);
    if (!axis) return `<pivotField ${a.join(" ")}/>`;
    const it = items.get(f)!;
    const keep = inc.get(f);
    const blankOnlyFromEmptyRows = it.index.has("b:") && !nonEmpty.some((r) => isBlank(r[f] ?? null));
    const order = it.vals.map((v, x) => ({ v, x })).sort((p, q) => compareItems(p.v, q.v));
    // column subtotals are not drawn by the engine; row subtotals follow the "subtotals" switch (§18.10.1.69 defaultSubtotal)
    const withDefault = axis === "axisRow" ? subtotals : axis === "axisPage";
    if (axis === "axisPage") a.push(`multipleItemSelectionAllowed="1"`);
    else a.push(`sortType="ascending"`);
    if (!withDefault) a.push(`defaultSubtotal="0"`);
    const its = order.map(({ v, x }) => `<item${(keep && !keep.has(itemLabel(v))) || (isBlank(v) && blankOnlyFromEmptyRows) ? ` h="1"` : ""} x="${x}"/>`);
    if (withDefault) its.push(`<item t="default"/>`);
    return `<pivotField ${a.join(" ")}><items count="${its.length}">${its.join("")}</items>${axis === "axisRow" ? fillDown : ""}</pivotField>`;
  });
  // every item of a row/column field hidden → Excel refuses the definition ("at least one item must be visible")
  for (const f of onAxis) {
    const it = items.get(f)!, keep = inc.get(f);
    if (keep && !it.vals.some((v) => keep.has(itemLabel(v)) && !(isBlank(v) && !nonEmpty.some((r) => isBlank(r[f] ?? null))))) return { ok: false, why: `its filter on "${names[f]}" hides every item` };
  }
  // data field names are unique and never equal a field name (Excel then appends a space: "Sum of Sales ")
  const fieldNames = new Set(names.map((n) => n.toLowerCase())), usedData = new Set<string>();
  const dataFields = vals.map((v) => {
    const base = `${FN_LABEL[v.fn]} of ${itemLabel(header[v.field])}`;
    const pad = (x: string) => (fieldNames.has(x.toLowerCase()) ? `${x} ` : x);
    let n = pad(base), k = 2;
    while (usedData.has(n.toLowerCase())) n = pad(`${base}${k++}`);
    usedData.add(n.toLowerCase());
    return `<dataField name="${esc(n)}" fld="${v.field}" subtotal="${SUBTOTAL[v.fn]}" baseField="0" baseItem="0"/>`;
  });
  const h = result.grid.length, w = Math.max(...result.grid.map((r) => r.length));
  const loc: Range = { c0: def.anchor.col, r0: def.anchor.row, c1: def.anchor.col + w - 1, r1: def.anchor.row + h - 1 };
  const firstHeaderRow = spec.cols.length ? result.colHeaderStart : nv > 1 ? 0 : 1;
  const locXml = `<location ref="${rangeA1(loc)}" firstHeaderRow="${firstHeaderRow}" firstDataRow="${result.headerRows}" firstDataCol="${Math.max(nr, 1)}"${pages.length ? ` rowPageCount="${pages.length}" colPageCount="1"` : ""}/>`;
  const colList = [...spec.cols, ...(nv > 1 ? [-2] : [])];
  const name = opts.name ?? def.name;
  const tableAttrs = [`xmlns="${NS_SML}"`, `name="${esc(name)}"`, `cacheId="${cacheId}"`, `applyNumberFormats="0"`, `applyBorderFormats="0"`, `applyFontFormats="0"`, `applyPatternFormats="0"`, `applyAlignmentFormats="0"`, `applyWidthHeightFormats="1"`, `dataCaption="Values"`, `updatedVersion="6"`, `minRefreshableVersion="3"`, `createdVersion="6"`, `useAutoFormatting="1"`, `itemPrintTitles="1"`, `indent="0"`, `compact="0"`, `compactData="0"`, `multipleFieldFilters="0"`];
  if (!grandCols) tableAttrs.push(`rowGrandTotals="0"`);
  if (!grandRows) tableAttrs.push(`colGrandTotals="0"`);
  const tableXml = XML_HEAD + `<pivotTableDefinition ${tableAttrs.join(" ")}>` + locXml
    + `<pivotFields count="${nf}">${pivotFields.join("")}</pivotFields>`
    + (nr ? `<rowFields count="${nr}">${spec.rows.map((f) => `<field x="${f}"/>`).join("")}</rowFields>` : "")
    + (colList.length ? `<colFields count="${colList.length}">${colList.map((f) => `<field x="${f}"/>`).join("")}</colFields>` : "")
    + (pages.length ? `<pageFields count="${pages.length}">${pages.map((f) => `<pageField fld="${f}" hier="-1"/>`).join("")}</pageFields>` : "")
    + `<dataFields count="${nv}">${dataFields.join("")}</dataFields>`
    + `<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/>`
    + `</pivotTableDefinition>`;
  return { ok: true, parts: { name, cacheXml, recordsXml, tableXml, ref: rangeA1(loc), pages: pages.length } };
}

/** what happened to each PivotTable on save (shown to the user) */
export interface PivotSaveNote { sheet: string; name: string; native: boolean; why?: string }

/** a PivotTable name unique (case-insensitively) among `taken` on one sheet */
export function uniquePivotName(name: string, taken: Set<string>): string {
  let n = name, k = 2; while (taken.has(n.toLowerCase())) n = `${name} (${k++})`;
  taken.add(n.toLowerCase()); return n;
}

/** relative OPC target from a part to another part (both package paths without a leading "/") */
export function relTarget(fromPart: string, toPart: string): string {
  const a = fromPart.split("/").slice(0, -1), b = toPart.split("/");
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}
