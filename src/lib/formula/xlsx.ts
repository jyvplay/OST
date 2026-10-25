/**
 * First-party SpreadsheetML reader/writer for a deliberately bounded workbook
 * profile. Microsoft Learn's Open XML reference (fetched this turn) confirms
 * that formula text lives in <f> and the last cached result in <v>; this reader
 * does NOT trust stale cached formula values, instead re-evaluating them with
 * src/lib/formula before presentation/export.
 *
 * Supported: multi-sheet workbooks; sharedStrings + inlineStr; numeric,
 * string, boolean, error and formula cells; relative/absolute A1 refs; our
 * formula subset. Reader resolves workbook <sheet r:id> through
 * workbook.xml.rels rather than assuming sheet1.xml.
 * TT15: real styles.xml (fonts b/i/u/colour, solid fills, numFmts, alignment,
 * wrap) both directions; <cols> widths; frozen top rows; `_xlfn.`/`_xlws.`
 * future-function prefixes on write, stripped on read; self-closing styled
 * blank cells; shared formulas (t="shared") expanded via reference shifting;
 * spill anchors exported as ECMA-376 array formulas (t="array" ref=…) with
 * cached child values, and array-formula child cells skipped on read so they
 * do not block the re-spill.
 * TT17: borders (per-edge style+rgb), vertical alignment, <mergeCells>, <dataValidations> (list/whole/decimal/
 * textLength/date/custom, operators, error styles, prompts, inverted showDropDown), frozen columns (xSplit).
 * TT50: charts are read (drawing → chart parts) and written (chart + drawing parts with cached values).
 * Unsupported (loss-report items): pivot tables, Excel built-in/hidden names (_xlnm.*),
 * conditional formatting, external links, data validation, drawings, macros,
 * 1904 date system, theme/indexed colours (read as unset), rich text
 * runs, Excel 365 XLDAPR dynamic-array metadata (array formulas open in Excel
 * as legacy {=…} arrays with correct values). Not a claim of modern-suite parity.
 */
import { pivotPartsFor, uniquePivotName, CT_PIVOT_CACHE, CT_PIVOT_RECORDS, CT_PIVOT_TABLE, REL_PIVOT_CACHE, REL_PIVOT_RECORDS, REL_PIVOT_TABLE, type PivotSaveNote } from "./pivotxml";
import { PIVOT_NAME_RE, pivotNames, pivotsFromNames } from "./pivotsheet";
import { posix } from "node:path";
import { writeZip, readCentralDirectory, readEntryVerified } from "../server/zip";
import { canonicalizeNs, RELS_CANON, SML_CANON } from "../office/xml-ns";
import { Sheet, Workbook, a1, textInput, type CellStyle, type CellBorder, type DataValidation, type ExternalBook } from "./engine";
import { isBorderLine, parseRef, rangeRef, intersects, sanitizeValidation } from "./sheetlayout";
import { colToLetters, lettersToCol, isError, err, ERROR_CODES, type ErrorCode, type Scalar } from "./types";
import { shiftFormula, addFuturePrefixes, stripFuturePrefixes } from "./sheetops";
export { workbookToJson, workbookFromJson, type WorkbookJson } from "./workbook-json";
import { workbookToJson, workbookFromJson } from "./workbook-json";
import { periodFormula, TIME_PERIODS, type CondRule, type Cfvo } from "./sheetmeta";
import { autoFilterXml, readAutoFilterXml, xmlAttr } from "./sheetfilter";
import { tableXml, unXstring, headerMismatches, structuredRefsToFileForm, tableColumnNames } from "./sheettables";
/** TT74: rows already marked hidden inside a filter's data area (below its header row) were hidden by the filter. */
function markFiltered(sheet: Sheet, ref: string) {
  const r = parseRef(ref); if (!r) return;
  for (const [row] of sheet.hiddenRows) if (row > r.r0 && row <= r.r1) sheet.hiddenRows.set(row, "filter");
}
import { readSheetCharts, chartSpaceXml, chartAnchorXml, drawingXml, defaultAnchor, seriesOutFor, REL_DRAWING, REL_CHART, CT_DRAWING, CT_CHART, type SeriesOut } from "./chartxml";
import { readLinks, linksXml } from "./sheetlinks";
import { ICON_SETS, MAIN_ICON_SETS, DEFAULT_ICON_PERCENTS } from "./cficons";
import { readThemeColors, readIndexedColors, resolveTag, resolveColorAttrs, EMPTY_COLOR_CONTEXT, type ColorContext } from "./xlsxcolor";

const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
// XML 1.0 forbids C0 controls other than tab/LF/CR; strip them so a pasted control char cannot corrupt the package.
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/**
 * XML text / attribute value → string. TT67: numeric character references (&#10; &#x1F61C;) are decoded too — until
 * TT67 only the five named entities were, so line breaks written as &#10; (Apache POI, .NET, LibreOffice output in the
 * corpus) showed as literal "&#10;" and astral characters as "&#x1f61c;". One pass, so "&amp;lt;" stays "&lt;";
 * a reference to a non-character (surrogate, > U+10FFFF) is left as written.
 */
const NAMED: Record<string, string> = { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" };
const dec = (s: string) => (s.indexOf("&") < 0 ? s : s.replace(/&(?:#([0-9]{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|quot|apos|amp));/g, (m, d: string | undefined, h: string | undefined, n: string | undefined) => {
  if (n) return NAMED[n];
  const cp = d !== undefined ? parseInt(d, 10) : parseInt(h!, 16);
  return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
}));
/** CT_BooleanProperty val (xsd:boolean) off values, plus ST_UnderlineValues "none" */
const OFF_VALS = new Set(["0", "false", "none"]);
/** TT72: XML 1.0 §3.1 — Attribute ::= Name Eq AttValue, Eq ::= S? '=' S?, AttValue is "…" or '…'. TT71 and earlier read
 *  only name="value", so a workbook written with single quotes or spaces around '=' (valid XML, e.g. from hand-written
 *  or XSLT generators) silently lost every attribute: cell refs, types, styles. */
const xmlAttrs = (s: string) => Object.fromEntries([...s.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], dec(m[2] ?? m[3])]));

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
const CORE = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Fusion Shell Web</dc:creator></cp:coreProperties>`;
const APP = `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Fusion Shell Web — Sheet</Application></Properties>`;

/** TT75: cut to `max` characters as Excel counts them — an ST_Xstring escape _xHHHH_ is ONE character and is never split. */
function cutXstring(s: string, max: number): string {
  let out = "", n = 0;
  for (let i = 0; i < s.length && n < max;) {
    const esc = /^_x[0-9A-Fa-f]{4}_/.exec(s.slice(i));
    const cp = s.codePointAt(i)!; const tok = esc ? esc[0] : String.fromCodePoint(cp);
    out += tok; i += tok.length; n++;
  }
  return out;
}
function safeSheetName(name: string, used: Set<string>): string {
  let base = cutXstring(name.replace(/[\\/*?:\[\]]/g, " ").trim(), 31) || "Sheet";
  let candidate = base, n = 2;
  while ([...used].some((x) => x.toLowerCase() === candidate.toLowerCase())) {
    const suffix = ` (${n++})`; candidate = cutXstring(base, 31 - suffix.length) + suffix;
  }
  used.add(candidate); return candidate;
}
/* ------------------------------------------------------------------ styles.xml */
const BUILTIN_NUMFMT: Record<number, string> = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@" };
// Ids 14-17 and 22 are locale-rendered (ECMA-376 lists 14 as "mm-dd-yy", 22 as "m/d/yy h:mm"); reusing them
// for our explicit codes would be lossy, so only locale-independent built-ins are reused on write (oracle-found).
const LOCALE_IDS = new Set([14, 15, 16, 17, 22]);
const BUILTIN_BY_CODE = new Map(Object.entries(BUILTIN_NUMFMT).filter(([id]) => !LOCALE_IDS.has(Number(id))).map(([id, code]) => [code, Number(id)]));
const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;
class StyleTable {
  fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  numFmts = new Map<string, number>();
  borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  dxfs: string[] = [];
  dxf(xml: string): number { return this.intern(this.dxfs, xml); }
  private idx = new Map<string, number>();
  private intern(list: string[], xml: string) { let i = list.indexOf(xml); if (i < 0) { i = list.length; list.push(xml); } return i; }
  xf(style?: CellStyle): number {
    if (!style || !Object.keys(style).length) return 0;
    // Stable deep key (a JSON.stringify key-array replacer would also filter NESTED keys and drop border sides).
    const stable = (v: unknown): string => v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
    const key = stable(style);
    const hit = this.idx.get(key); if (hit !== undefined) return hit;
    const font = style.bold || style.italic || style.underline || style.color
      ? this.intern(this.fonts, `<font>${style.bold ? "<b/>" : ""}${style.italic ? "<i/>" : ""}${style.underline ? "<u/>" : ""}<sz val="11"/>${style.color ? `<color rgb="${argb(style.color)}"/>` : ""}<name val="Calibri"/><family val="2"/></font>`) : 0;
    const fill = style.fill ? this.intern(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(style.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    let numFmt = 0;
    if (style.numFmt && style.numFmt !== "General") {
      numFmt = BUILTIN_BY_CODE.get(style.numFmt) ?? this.numFmts.get(style.numFmt) ?? 164 + this.numFmts.size;
      if (numFmt >= 164) this.numFmts.set(style.numFmt, numFmt);
    }
    const align = style.align || style.wrap || style.valign ? `<alignment${style.align ? ` horizontal="${style.align}"` : ""}${style.valign ? ` vertical="${style.valign}"` : ""}${style.wrap ? ' wrapText="1"' : ""}/>` : "";
    const bd = style.border && Object.keys(style.border).length ? this.intern(this.borders, `<border>${(["left", "right", "top", "bottom"] as const).map((k) => { const b = style.border![k]; return b ? `<${k} style="${b.style}"><color rgb="${argb(b.color ?? "#000000")}"/></${k}>` : `<${k}/>`; }).join("")}<diagonal/></border>`) : 0;
    const xml = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${bd}" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ""}${font ? ' applyFont="1"' : ""}${fill ? ' applyFill="1"' : ""}${bd ? ' applyBorder="1"' : ""}${align ? ' applyAlignment="1">' + align + "</xf>" : "/>"}`;
    const i = this.xfs.length; this.xfs.push(xml); this.idx.set(key, i); return i;
  }
  toXml(): string {
    const nf = this.numFmts.size ? `<numFmts count="${this.numFmts.size}">${[...this.numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join("")}</numFmts>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${nf}<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts><fills count="${this.fills.length}">${this.fills.join("")}</fills><borders count="${this.borders.length}">${this.borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>${this.dxfs.length ? `<dxfs count="${this.dxfs.length}">${this.dxfs.join("")}</dxfs>` : ""}</styleSheet>`;
  }
}
/** Column width: Excel stores characters of the max digit width (7px for Calibri 11) incl. 5px padding. */
const pxToWidth = (px: number) => Math.trunc((px / 7) * 256) / 256;
const widthToPx = (w: number) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);

function renderSheet(wb: Workbook, sheet: Sheet, sharedIndex: (s: string) => number, styles: StyleTable, drawingRid?: string, linksMarkup = "", tablePartsXml = "") {
  const positions = new Map<string, { col: number; row: number }>();
  for (const k of sheet.grid.keys()) { const [col, row] = k.split(",").map(Number); positions.set(k, { col, row }); }
  for (const fq of wb.spillOwner.keys()) {
    const bang = fq.lastIndexOf("!"); if (fq.slice(0, bang) !== sheet.name) continue;
    const k = fq.slice(bang + 1); const [col, row] = k.split(",").map(Number); positions.set(k, { col, row });
  }
  const cells = [...positions.values()].sort((a, b) => a.row - b.row || a.col - b.col);
  const rows = new Map<number, string[]>(); let maxCol = -1, maxRow = -1;
  // TT75: a table's header cells are text in Excel (a numeric header 2010 is the column name "2010")
  const headerName = new Map<string, string>();
  for (const t of wb.tables.values()) if (t.sheet === sheet.name && t.headerRows) tableColumnNames(t).forEach((nm, i) => headerName.set(`${t.c0 + i},${t.r0}`, nm));
  for (const { col, row } of cells) {
    const cell = sheet.get(col, row);
    const ref = a1(col, row);
    const s = styles.xf(cell?.style); const sa = s ? ` s="${s}"` : "";
    const hasInput = !!cell && cell.input !== "";
    const v = hasInput ? cell!.value : wb.valueAt(sheet.name, col, row);
    let formula = "";
    if (hasInput && cell!.formula) {
      const body = esc(addFuturePrefixes(structuredRefsToFileForm(cell!.input, wb, sheet.name, col, row).slice(1))); // TT75: file form of structured refs
      const sp = cell!.spill;
      formula = sp && (sp.rows > 1 || sp.cols > 1) ? `<f t="array" ref="${ref}:${a1(col + sp.cols - 1, row + sp.rows - 1)}">${body}</f>` : `<f>${body}</f>`;
    }
    let out: string;
    // TT68 FF-52: a constant empty-text cell (input "'") is NOT blank in Excel — keep it as a shared "" string.
    if (v === undefined || (v === "" && !formula && !hasInput)) { if (!s) continue; out = `<c r="${ref}"${sa}/>`; }
    else if (isError(v)) {
      // #CIRCULAR!/#SPILL!/#CALC! are not ECMA-376 ST_CellError tokens; export as #VALUE! (engine keeps its own code).
      const code = v.error === "#CIRCULAR!" || v.error === "#SPILL!" || v.error === "#CALC!" ? "#VALUE!" : v.error;
      out = `<c r="${ref}"${sa} t="e">${formula}<v>${esc(code)}</v></c>`;
    } else if (!formula && headerName.has(`${col},${row}`) && typeof v !== "string" && String(v) === headerName.get(`${col},${row}`)) out = `<c r="${ref}"${sa} t="s"><v>${sharedIndex(String(v))}</v></c>`;
    else if (typeof v === "boolean") out = `<c r="${ref}"${sa} t="b">${formula}<v>${v ? 1 : 0}</v></c>`;
    else if (typeof v === "number") out = `<c r="${ref}"${sa}>${formula}<v>${v}</v></c>`;
    else if (formula) out = `<c r="${ref}"${sa} t="str">${formula}<v>${esc(v)}</v></c>`;
    else out = `<c r="${ref}"${sa} t="s"><v>${sharedIndex(v)}</v></c>`;
    maxCol = Math.max(maxCol, col); maxRow = Math.max(maxRow, row);
    (rows.get(row) ?? rows.set(row, []).get(row)!).push(out);
  }
  // TT74: hidden rows (Hide or AutoFilter) carry hidden="1", with or without cells
  for (const r of sheet.hiddenRows.keys()) if (r >= 0 && r < 1048576 && !rows.has(r)) rows.set(r, []);
  const data = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => (cs.length ? `<row r="${r + 1}"${sheet.hiddenRows.has(r) ? ' hidden="1"' : ""}>${cs.join("")}</row>` : `<row r="${r + 1}" hidden="1"/>`)).join("");
  const dim = maxRow < 0 ? "A1" : `A1:${colToLetters(maxCol)}${maxRow + 1}`;
  const widths = Object.entries(sheet.colWidths).map(([c, px]) => [Number(c), px] as const).filter(([c]) => c >= 0 && c <= 16383).sort((a, b) => a[0] - b[0]);
  const afXml = autoFilterXml(sheet); // TT74 (TT75: a table's own AutoFilter is written in its table part)
  const colSet = [...new Set([...widths.map(([c]) => c), ...[...sheet.hiddenCols].filter((c) => c >= 0 && c <= 16383)])].sort((a, b) => a - b);
  const colXml = (c: number) => { const px = sheet.colWidths[c]; return `<col min="${c + 1}" max="${c + 1}"${px !== undefined ? ` width="${pxToWidth(px)}" customWidth="1"` : ""}${sheet.hiddenCols.has(c) ? ' hidden="1"' : ""}/>`; };
  const cols = colSet.length ? `<cols>${colSet.map(colXml).join("")}</cols>` : "";
  const fr = sheet.freezeRows, fc = sheet.freezeCols;
  const pane = fr > 0 && fc > 0 ? "bottomRight" : fr > 0 ? "bottomLeft" : "topRight";
  const views = fr > 0 || fc > 0 ? `<sheetViews><sheetView workbookViewId="0"><pane${fc ? ` xSplit="${fc}"` : ""}${fr ? ` ySplit="${fr}"` : ""} topLeftCell="${colToLetters(fc)}${fr + 1}" activePane="${pane}" state="frozen"/><selection pane="${pane}"/></sheetView></sheetViews>` : "";
  // CT_Worksheet order: … sheetData, …, mergeCells, phoneticPr, conditionalFormatting, dataValidations, …
  const merges = sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${rangeRef(m)}"/>`).join("")}</mergeCells>` : "";
  // TT47: conditional formats (one <conditionalFormatting> per rule; first rule = priority 1)
  // TT49: Excel 2010 extensions — a data bar with x14-only properties gets a linked <x14:cfRule>; an x14-only or custom
  // icon set lives only in the worksheet <extLst> (MS-XLSX §2.6.29/§2.6.30), exactly where our reader looks for them.
  const x14Parts: string[] = [];
  const cfs = wb.condFormats.filter((r) => r.sheet === sheet.name).map((r, i) => {
    const x = cfX14Xml(r, i + 1, `${sheet.name}|${i}|${r.range}`);
    if (x) x14Parts.push(`<x14:conditionalFormatting xmlns:xm="${XM_NS}">${x.xml}<xm:sqref>${esc(r.range)}</xm:sqref></x14:conditionalFormatting>`);
    if (x && !x.linked) return "";
    const xmlr = cfRuleXml(r, null, i + 1); if (!xmlr) return ""; const dx = cfDxfXml(r);
    const main = cfRuleXml(r, dx ? styles.dxf(dx) : null, i + 1);
    return `<conditionalFormatting sqref="${esc(r.range)}">${x ? main.replace(/<\/cfRule>$/, `<extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}" xmlns:x14="${X14_NS}"><x14:id>${x.id}</x14:id></ext></extLst></cfRule>`) : main}</conditionalFormatting>`;
  }).join("");
  const ext = x14Parts.length ? `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="${X14_NS}"><x14:conditionalFormattings>${x14Parts.join("")}</x14:conditionalFormattings></ext></extLst>` : "";
  const dvs = sheet.validations.length ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map(dvXml).join("")}</dataValidations>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${drawingRid || linksMarkup || tablePartsXml ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : ""}><dimension ref="${dim}"/>${views}${cols}<sheetData>${data}</sheetData>${afXml}${merges}${cfs}${dvs}${linksMarkup}${drawingRid ? `<drawing r:id="${drawingRid}"/>` : ""}${tablePartsXml}${ext}</worksheet>`;
}

/** Differential format for a CF rule (ECMA-376 §18.8.14, CT_Dxf order font, numFmt, fill); null when the rule draws none. */
function cfDxfXml(r: CondRule): string | null {
  if (r.kind === "scale" || r.kind === "bar" || r.kind === "icons" || (!r.fill && !r.color && !r.bold && !r.italic && !r.underline && !r.strike && !r.numFmt && !r.border)) return null;
  const f = `${r.bold ? "<b/>" : ""}${r.italic ? "<i/>" : ""}${r.strike ? "<strike/>" : ""}${r.underline ? "<u/>" : ""}${r.color ? `<color rgb="${argb(r.color)}"/>` : ""}`;
  // a dxf numFmt is self-contained (formatCode inline); the id only has to be a custom-range number
  const nf = r.numFmt ? `<numFmt numFmtId="${200 + ([...r.numFmt].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 5000)}" formatCode="${esc(r.numFmt)}"/>` : "";
  const fill = r.fill ? `<fill><patternFill><bgColor rgb="${argb(r.fill)}"/></patternFill></fill>` : "";
  const bd = r.border ? `<border>${(["left", "right", "top", "bottom"] as const).map((k) => { const b = r.border![k]; return b ? `<${k} style="${b.style}">${b.color ? `<color rgb="${argb(b.color)}"/>` : '<color auto="1"/>'}</${k}>` : ""; }).join("")}</border>` : "";
  return `<dxf>${f ? `<font>${f}</font>` : ""}${nf}${fill}${bd}</dxf>`;
}
const X14_NS = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main", XM_NS = "http://schemas.microsoft.com/office/excel/2006/main";
const GUID_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
/** Deterministic GUID (same workbook → same bytes): four FNV-1a passes over the seed. */
function stableGuid(seed: string): string {
  const h = [0x811c9dc5, 0x01000193, 0x2545f491, 0x9e3779b9].map((h0, k) => { let h = h0 ^ k; for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h.toString(16).padStart(8, "0").toUpperCase(); }).join("");
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}}`;
}
/**
 * TT49: the Excel 2010 (x14) half of a rule, or null when the main schema carries everything.
 * linked=true → the main <cfRule> stays (Excel 2007 fallback) and points at this part by id; false → x14 only.
 */
function cfX14Xml(r: CondRule, priority: number, seed: string): { xml: string; id: string; linked: boolean } | null {
  const id = r.x14 && GUID_RE.test(r.x14) ? r.x14 : stableGuid(seed);
  const cfvo = (c: Cfvo, icon: boolean) => `<x14:cfvo type="${c.t}"${icon && c.gt ? ' gte="0"' : ""}${c.v !== undefined && c.t !== "min" && c.t !== "max" && c.t !== "autoMin" && c.t !== "autoMax" ? `><xm:f>${esc(c.v)}</xm:f></x14:cfvo>` : "/>"}`;
  // TT66: a threshold formula that refers to another sheet cannot sit in a 2007 <cfvo val> either → x14-only rule
  const xcv = (r.kind === "bar" || r.kind === "icons") && (r.cfvo ?? []).some((c) => c.v !== undefined && crossSheet(c.v));
  if (r.kind === "bar") {
    const auto = r.cfvo?.some((c) => c.t === "autoMin" || c.t === "autoMax");
    if (!(r.x14 || r.barAxis || r.barNeg || r.barBorder || r.barSolid || r.barAxisColor || auto || xcv)) return null;
    const cv = r.cfvo?.length === 2 ? r.cfvo : [{ t: "autoMin" as const }, { t: "autoMax" as const }];
    const at = ` minLength="${r.barMinLen ?? 10}" maxLength="${r.barMaxLen ?? 90}"${r.barSolid ? ' gradient="0"' : ""}${r.barBorder ? ' border="1"' : ""}${r.barNeg ? ' negativeBarColorSameAsPositive="0"' : ""}${r.barAxis === "middle" ? ' axisPosition="middle"' : r.barAxis === "auto" ? "" : ' axisPosition="none"'}`;
    // x14-only (no 2007 fallback to inherit from): the bar colour, priority, stopIfTrue and showValue live here (MS-XLSX
    // CT_DataBar child order cfvo, cfvo, fillColor, borderColor, negativeFillColor, negativeBorderColor, axisColor)
    const fill = xcv ? `<x14:fillColor rgb="${argb(r.barColor ?? "#638ec6")}"/>` : "";
    const kids = `${cv.map((c) => cfvo(c, false)).join("")}${fill}${r.barBorder ? `<x14:borderColor rgb="${argb(r.barBorder)}"/>` : ""}${r.barNeg ? `<x14:negativeFillColor rgb="${argb(r.barNeg)}"/>` : ""}${r.barAxisColor ? `<x14:axisColor rgb="${argb(r.barAxisColor)}"/>` : ""}`;
    if (xcv) return { xml: `<x14:cfRule type="dataBar" priority="${priority}"${r.stop ? ' stopIfTrue="1"' : ""} id="${id}"><x14:dataBar${at}${r.hideValue ? ' showValue="0"' : ""}>${kids}</x14:dataBar></x14:cfRule>`, id, linked: false };
    return { xml: `<x14:cfRule type="dataBar" id="${id}"><x14:dataBar${at}>${kids}</x14:dataBar></x14:cfRule>`, id, linked: true };
  }
  if (r.kind === "icons") {
    const set = r.iconSet ?? "3TrafficLights1"; if (!ICON_SETS[set]) return null;
    const custom = r.icons?.filter((g) => /^([0-9A-Za-z]+):(\d)$/.test(g)) ?? [];
    if (MAIN_ICON_SETS.includes(set) && !custom.length && !xcv) return null;
    const n = ICON_SETS[set].length;
    const cv = r.cfvo?.length === n ? r.cfvo : DEFAULT_ICON_PERCENTS[n].map((p) => ({ t: "percent" as const, v: String(p) }));
    const at = `${set !== "3TrafficLights1" ? ` iconSet="${set}"` : ""}${custom.length ? ' custom="1"' : ""}${r.hideValue ? ' showValue="0"' : ""}${r.reverse ? ' reverse="1"' : ""}`;
    const icons = custom.map((g) => { const [cs, k] = g.split(":"); return `<x14:cfIcon iconSet="${esc(cs)}" iconId="${k}"/>`; }).join("");
    return { xml: `<x14:cfRule type="iconSet" priority="${priority}"${r.stop ? ' stopIfTrue="1"' : ""} id="${id}"><x14:iconSet${at}>${cv.map((c) => cfvo(c, true)).join("")}${icons}</x14:iconSet></x14:cfRule>`, id, linked: false };
  }
  // TT59: a formula rule that refers to another sheet is x14-only, as Excel 2010+ writes it (the 2007 <cfRule> cannot
  // carry cross-sheet references): <xm:f> operands and an inline <x14:dxf> (MS-XLSX: xm:f*, dxf, extLst order)
  if (r.kind !== "scale" && [r.af, r.bf, r.formula].some((f) => !!f && crossSheet(f))) {
    const main = cfRuleXml(r, null, priority); if (!main.endsWith("</cfRule>")) return null;
    const dx = cfDxfXml(r);
    const xml = main.replace(/^<cfRule([^>]*)>/, `<x14:cfRule$1 id="${id}">`).replace(/<(\/?)formula>/g, "<$1xm:f>")
      .replace(/<\/cfRule>$/, `${dx ? `<x14:dxf>${dx.replace(/^<dxf>|<\/dxf>$/g, "")}</x14:dxf>` : ""}</x14:cfRule>`);
    return { xml, id, linked: false };
  }
  return null;
}
/** a formula refers to another sheet: a "!" outside string literals */
function crossSheet(f: string): boolean { return f.replace(/"(?:[^"]|"")*"/g, "").includes("!"); }
/** One <cfRule> (ECMA-376 §18.3.1.10) for a modelled CondRule; "" when the main schema cannot carry it (x14-only icon sets). */
function cfRuleXml(r: CondRule, dxfId: number | null, priority: number): string {
  const d = dxfId === null ? "" : ` dxfId="${dxfId}"`;
  const head = (type: string, extra = "") => `<cfRule type="${type}"${d} priority="${priority}"${r.stop ? ' stopIfTrue="1"' : ""}${extra}>`;
  const lit = (v: string | undefined) => { const t = (v ?? "").trim(); return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t) ? t : `"${t.replace(/"/g, '""')}"`; };
  const fx = (f: string) => `<formula>${esc(f)}</formula>`;
  const q = (t: string) => `"${t.replace(/"/g, '""')}"`;
  const top = r.range.trim().split(/[\s:]/)[0].replace(/\$/g, "");
  const op: Partial<Record<CondRule["kind"], string>> = { gt: "greaterThan", lt: "lessThan", ge: "greaterThanOrEqual", le: "lessThanOrEqual", eq: "equal", ne: "notEqual", between: "between", notBetween: "notBetween" };
  const cfvoXml = (c: Cfvo, main: boolean, icon: boolean) => {
    const t = main && c.t === "autoMin" ? "min" : main && c.t === "autoMax" ? "max" : c.t;
    return `<cfvo type="${t}"${c.v !== undefined && t !== "min" && t !== "max" ? ` val="${esc(c.v)}"` : ""}${icon && c.gt ? ' gte="0"' : ""}/>`;
  };
  const t = r.a ?? "";
  switch (r.kind) {
    case "gt": case "lt": case "ge": case "le": case "eq": case "ne":
      return `${head("cellIs", ` operator="${op[r.kind]}"`)}${fx(r.af ?? lit(r.a))}</cfRule>`;
    case "between": case "notBetween":
      return `${head("cellIs", ` operator="${op[r.kind]}"`)}${fx(r.af ?? lit(r.a))}${fx(r.bf ?? lit(r.b))}</cfRule>`;
    case "contains": return `${head("containsText", ` operator="containsText" text="${esc(t)}"`)}${fx(`NOT(ISERROR(SEARCH(${q(t)},${top})))`)}</cfRule>`;
    case "notContains": return `${head("notContainsText", ` operator="notContains" text="${esc(t)}"`)}${fx(`ISERROR(SEARCH(${q(t)},${top}))`)}</cfRule>`;
    case "begins": return `${head("beginsWith", ` operator="beginsWith" text="${esc(t)}"`)}${fx(`LEFT(${top},LEN(${q(t)}))=${q(t)}`)}</cfRule>`;
    case "ends": return `${head("endsWith", ` operator="endsWith" text="${esc(t)}"`)}${fx(`RIGHT(${top},LEN(${q(t)}))=${q(t)}`)}</cfRule>`;
    case "blanks": return `${head("containsBlanks")}${fx(`LEN(TRIM(${top}))=0`)}</cfRule>`;
    case "noBlanks": return `${head("notContainsBlanks")}${fx(`LEN(TRIM(${top}))>0`)}</cfRule>`;
    case "errors": return `${head("containsErrors")}${fx(`ISERROR(${top})`)}</cfRule>`;
    case "noErrors": return `${head("notContainsErrors")}${fx(`NOT(ISERROR(${top}))`)}</cfRule>`;
    case "duplicate": return `${head("duplicateValues")}</cfRule>`.replace("></cfRule>", "/>");
    case "unique": return `${head("uniqueValues")}</cfRule>`.replace("></cfRule>", "/>");
    case "top": return `${head("top10", `${r.pct ? ' percent="1"' : ""}${r.bottom ? ' bottom="1"' : ""} rank="${Math.max(1, Math.min(1000, Math.trunc(Number(r.a)) || 10))}"`)}</cfRule>`.replace("></cfRule>", "/>");
    case "aboveAvg": return `${head("aboveAverage", `${r.below ? ' aboveAverage="0"' : ""}${r.equal ? ' equalAverage="1"' : ""}${r.stdDev ? ` stdDev="${r.stdDev}"` : ""}`)}</cfRule>`.replace("></cfRule>", "/>");
    case "period": { const f = r.formula ?? periodFormula(r.period ?? "", top); return f ? `${head("timePeriod", ` timePeriod="${esc(r.period ?? "today")}"`)}${fx(f)}</cfRule>` : ""; }
    case "expr": return r.formula ? `${head("expression")}${fx(r.formula)}</cfRule>` : "";
    case "scale": {
      const cols = [r.scaleMin ?? "#f8696b", ...(r.scaleMid ? [r.scaleMid] : []), r.scaleMax ?? "#63be7b"];
      const parts = r.scaleAt?.split("|").length === cols.length ? r.scaleAt!.split("|") : cols.length === 3 ? ["min", "percentile:50", "max"] : ["min", "max"];
      const cfvo = parts.map((p) => { const [t, v] = p.split(":"); return v === undefined ? `<cfvo type="${t}"/>` : `<cfvo type="${t}" val="${esc(v)}"/>`; }).join("");
      return `<cfRule type="colorScale" priority="${priority}"><colorScale>${cfvo}${cols.map((c) => `<color rgb="${argb(c)}"/>`).join("")}</colorScale></cfRule>`;
    }
    case "bar": {
      // Excel 2007 data bar (main schema); x14-only properties (axis, solid fill, border, autoMin/Max) go to the linked x14 part
      const cv = r.cfvo?.length === 2 ? r.cfvo : [{ t: "min" as const }, { t: "max" as const }];
      const at = `${r.barMinLen !== undefined && r.barMinLen !== 10 ? ` minLength="${r.barMinLen}"` : ""}${r.barMaxLen !== undefined && r.barMaxLen !== 90 ? ` maxLength="${r.barMaxLen}"` : ""}${r.hideValue ? ' showValue="0"' : ""}`;
      return `<cfRule type="dataBar" priority="${priority}"><dataBar${at}>${cv.map((c) => cfvoXml(c, true, false)).join("")}<color rgb="${argb(r.barColor ?? "#638ec6")}"/></dataBar></cfRule>`;
    }
    case "icons": {
      const set = r.iconSet ?? "3TrafficLights1"; if (!MAIN_ICON_SETS.includes(set)) return "";
      const n = ICON_SETS[set].length;
      const cv = r.cfvo?.length === n ? r.cfvo : DEFAULT_ICON_PERCENTS[n].map((p) => ({ t: "percent" as const, v: String(p) }));
      const at = `${set !== "3TrafficLights1" ? ` iconSet="${set}"` : ""}${r.hideValue ? ' showValue="0"' : ""}${r.reverse ? ' reverse="1"' : ""}`;
      return `<cfRule type="iconSet" priority="${priority}"><iconSet${at}>${cv.map((c) => cfvoXml(c, true, true)).join("")}</iconSet></cfRule>`;
    }
  }
  return "";
}

/** ECMA-376 §18.3.1.32. NB showDropDown="1" HIDES the in-cell arrow. */
function dvXml(v: DataValidation): string {
  const at = [`type="${v.type}"`, v.operator && v.type !== "list" && v.type !== "custom" ? `operator="${v.operator}"` : "", v.allowBlank ? 'allowBlank="1"' : "",
    v.type === "list" && !v.inCellDropdown ? 'showDropDown="1"' : "", v.prompt || v.promptTitle ? 'showInputMessage="1"' : "", v.showError ? 'showErrorMessage="1"' : "",
    v.errorStyle === "warning" || v.errorStyle === "information" ? `errorStyle="${v.errorStyle}"` : "", v.errorTitle ? `errorTitle="${esc(v.errorTitle)}"` : "", v.error ? `error="${esc(v.error)}"` : "",
    v.promptTitle ? `promptTitle="${esc(v.promptTitle)}"` : "", v.prompt ? `prompt="${esc(v.prompt)}"` : "", `sqref="${esc(v.sqref)}"`].filter(Boolean).join(" ");
  return `<dataValidation ${at}><formula1>${esc(v.formula1)}</formula1>${v.formula2 ? `<formula2>${esc(v.formula2)}</formula2>` : ""}</dataValidation>`;
}

/** Real .xlsx / SpreadsheetML writer, supporting all sheets in a Workbook. */
/** TT19: <definedNames> (ECMA-376 §18.2.5) — after <sheets>, before <calcPr>; sheet scope → localSheetId. */
function definedNamesXml(wb: Workbook, order: string[]): string {
  const list = wb.listNames().filter((d) => d.scope === null || order.includes(d.scope));
  // TT58: PivotTable definitions as hidden sheet-scoped string names
  const piv = order.flatMap((n, i) => pivotNames(wb.sheets.get(n)?.pivots ?? []).map((x) => `<definedName name="${x.name}" localSheetId="${i}" hidden="1">${esc(x.text)}</definedName>`));
  if (!list.length && !piv.length) return "";
  return `<definedNames>${list.map((d) => {
    const local = d.scope !== null ? ` localSheetId="${order.indexOf(d.scope)}"` : "";
    const comment = d.comment ? ` comment="${esc(d.comment)}"` : "";
    return `<definedName name="${esc(d.name)}"${local}${comment}>${esc(addFuturePrefixes(d.ref))}</definedName>`;
  }).join("")}${piv.join("")}</definedNames>`;
}

/** Reads <definedNames>; Excel built-ins (_xlnm.Print_Area, _FilterDatabase…) are skipped and counted. */
function readDefinedNames(workbookXml: string, wb: Workbook, order: string[]) {
  const skipped: string[] = [];
  const piv = new Map<string, { name: string; text: string }[]>();
  for (const m of workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const at = xmlAttrs(m[1]);
    const name = at.name ? dec(at.name) : "";
    if (PIVOT_NAME_RE.test(name) && at.localSheetId !== undefined) { const host = order[Number(at.localSheetId)]; if (host) { if (!piv.has(host)) piv.set(host, []); piv.get(host)!.push({ name, text: dec(m[2]) }); } continue; }
    if (!name || name.startsWith("_xlnm.") || at.hidden === "1" || at.hidden === "true") { skipped.push(name); continue; }
    const scope = at.localSheetId !== undefined ? order[Number(at.localSheetId)] ?? null : null;
    try { wb.defineName(name, stripFuturePrefixes(dec(m[2]).trim()), scope, at.comment ? dec(at.comment) : undefined); }
    catch { skipped.push(name); }
  }
  for (const [host, items] of piv) { const sh = wb.sheets.get(host); if (sh) sh.pivots = pivotsFromNames(items); }
  return skipped;
}

export function writeXlsxWorkbook(workbook: Workbook, title = "Workbook", report?: { pivots: PivotSaveNote[]; tables?: string[] }): Buffer {
  const sheets = [...workbook.sheets.values()];
  if (!sheets.length) throw new Error("workbook must contain at least one sheet");
  if (sheets.length > 255) throw new Error("workbook sheet limit in this engine is 255");
  workbook.recalculate();
  const used = new Set<string>();
  const names = sheets.map((s) => safeSheetName(s.name, used));
  const strings: string[] = [];
  const sharedIndex = (s: string) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  // Render sheets first so their literals populate the shared string table.
  const styles = new StyleTable();
  // TT50: charts → one drawing part per sheet that has charts + one chart part per chart (with cached values)
  const chartParts: { name: string; data: Buffer }[] = []; const chartTypes: string[] = [];
  let chartNo = 0, drawingNo = 0;
  const drawingOf = sheets.map((s) => {
    const list = workbook.charts.filter((c) => c.sheet === s.name);
    if (!list.length) return undefined;
    const d = ++drawingNo; const anchors: string[] = []; const drels: string[] = [];
    list.forEach((c, k) => {
      let series: SeriesOut[]; try { series = seriesOutFor(workbook, c); } catch { return; }
      if (!series.length) return;
      const n = ++chartNo;
      chartParts.push({ name: `xl/charts/chart${n}.xml`, data: Buffer.from(chartSpaceXml(c, series)) });
      chartTypes.push(`<Override PartName="/xl/charts/chart${n}.xml" ContentType="${CT_CHART}"/>`);
      drels.push(`<Relationship Id="rId${k + 1}" Type="${REL_CHART}" Target="../charts/chart${n}.xml"/>`);
      anchors.push(chartAnchorXml(c.anchor ?? defaultAnchor(c.range, k), `rId${k + 1}`, k + 2, c.title || `Chart ${n}`));
    });
    if (!anchors.length) return undefined;
    chartParts.push({ name: `xl/drawings/drawing${d}.xml`, data: Buffer.from(drawingXml(anchors)) });
    chartParts.push({ name: `xl/drawings/_rels/drawing${d}.xml.rels`, data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drels.join("")}</Relationships>`) });
    chartTypes.push(`<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="${CT_DRAWING}"/>`);
    return d;
  });
  // TT63: PivotTables → pivotCacheDefinition + pivotCacheRecords + pivotTableDefinition (pivotxml.ts); one cache per table
  const pivotRels: string[][] = sheets.map(() => []); const pivotCaches: number[] = [];
  sheets.forEach((s, i) => {
    const taken = new Set<string>();
    for (const def of s.pivots) {
      const n = pivotCaches.length + 1;
      const r = pivotPartsFor(workbook, s, def, n, { sheetName: (x) => names[sheets.findIndex((y) => y.name === x)] ?? x, name: uniquePivotName(def.name, taken) });
      if (!r.ok) { report?.pivots.push({ sheet: s.name, name: def.name, native: false, why: r.why }); continue; }
      pivotCaches.push(n);
      chartParts.push({ name: `xl/pivotCache/pivotCacheDefinition${n}.xml`, data: Buffer.from(r.parts.cacheXml) });
      chartParts.push({ name: `xl/pivotCache/_rels/pivotCacheDefinition${n}.xml.rels`, data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_PIVOT_RECORDS}" Target="pivotCacheRecords${n}.xml"/></Relationships>`) });
      chartParts.push({ name: `xl/pivotCache/pivotCacheRecords${n}.xml`, data: Buffer.from(r.parts.recordsXml) });
      chartParts.push({ name: `xl/pivotTables/pivotTable${n}.xml`, data: Buffer.from(r.parts.tableXml) });
      chartParts.push({ name: `xl/pivotTables/_rels/pivotTable${n}.xml.rels`, data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_PIVOT_CACHE}" Target="../pivotCache/pivotCacheDefinition${n}.xml"/></Relationships>`) });
      chartTypes.push(`<Override PartName="/xl/pivotCache/pivotCacheDefinition${n}.xml" ContentType="${CT_PIVOT_CACHE}"/>`, `<Override PartName="/xl/pivotCache/pivotCacheRecords${n}.xml" ContentType="${CT_PIVOT_RECORDS}"/>`, `<Override PartName="/xl/pivotTables/pivotTable${n}.xml" ContentType="${CT_PIVOT_TABLE}"/>`);
      pivotRels[i].push(`<Relationship Id="rIdPt${n}" Type="${REL_PIVOT_TABLE}" Target="../pivotTables/pivotTable${n}.xml"/>`);
      report?.pivots.push({ sheet: s.name, name: r.parts.name, native: true });
    }
  });
  // sheet rels: rId1 = drawing (when charts), then one external relationship per linked address (TT57), then PivotTables
  const linkOf = sheets.map((s) => { let n = 1; return linksXml(s.links, () => `rId${++n}`); });
  // TT75: Excel tables → xl/tables/tableN.xml (ids unique in the workbook) + <tableParts> in their sheet, so structured
  // references still resolve after the new package is reopened (TT74 blocker)
  const tableRels: string[][] = sheets.map(() => []); const tablePartsOf: string[] = sheets.map(() => ""); let tableNo = 0;
  sheets.forEach((s, i) => {
    const list = [...workbook.tables.values()].filter((t) => t.sheet === s.name && t.c1 >= t.c0 && t.r1 > t.r0 - (t.headerRows ? 0 : 1));
    const ids: string[] = [];
    for (const t of list) {
      const n = ++tableNo;
      chartParts.push({ name: `xl/tables/table${n}.xml`, data: Buffer.from(tableXml(t, n)) });
      chartTypes.push(`<Override PartName="/xl/tables/table${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`);
      tableRels[i].push(`<Relationship Id="rIdTb${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${n}.xml"/>`);
      ids.push(`<tablePart r:id="rIdTb${n}"/>`);
      const mis = headerMismatches(workbook, t); if (mis.length) report?.tables?.push(`table ${t.name}: header cell(s) ${mis.join(", ")} differ from the column names written (Excel shows the column names)`);
      if (t.filter?.foreign) report?.tables?.push(`table ${t.name}: custom / top-10 / dynamic / colour filter criteria are not written (its hidden rows are kept)`);
    }
    if (ids.length) tablePartsOf[i] = `<tableParts count="${ids.length}">${ids.join("")}</tableParts>`;
  });
  sheets.forEach((_, i) => {
    const d = drawingOf[i]; const rs = [...(d ? [`<Relationship Id="rId1" Type="${REL_DRAWING}" Target="../drawings/drawing${d}.xml"/>`] : []), ...linkOf[i].rels, ...pivotRels[i], ...tableRels[i]];
    if (rs.length) chartParts.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rs.join("")}</Relationships>`) });
  });
  const sheetXmls = sheets.map((s, i) => renderSheet(workbook, s, sharedIndex, styles, drawingOf[i] ? "rId1" : undefined, linkOf[i].xml, tablePartsOf[i]));
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  rels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  rels.push(`<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`);
  for (const n of pivotCaches) rels.push(`<Relationship Id="rIdPc${n}" Type="${REL_PIVOT_CACHE}" Target="pivotCache/pivotCacheDefinition${n}.xml"/>`);
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${definedNamesXml(workbook, sheets.map((x) => x.name))}<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>${pivotCaches.length ? `<pivotCaches>${pivotCaches.map((n) => `<pivotCache cacheId="${n}" r:id="rIdPc${n}"/>`).join("")}</pivotCaches>` : ""}</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${chartTypes.join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS) },
    { name: "docProps/core.xml", data: Buffer.from(CORE.replace("<dc:creator>", `<dc:title>${esc(title)}</dc:title><dc:creator>`)) },
    { name: "docProps/app.xml", data: Buffer.from(APP) },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels) },
    { name: "xl/styles.xml", data: Buffer.from(styles.toXml()) },
    { name: "xl/sharedStrings.xml", data: Buffer.from(sst) },
    ...sheetXmls.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(x) })),
    ...chartParts,
  ]);
}

export function writeXlsx(sheet: Sheet, title = "Sheet1"): Buffer {
  const wb = new Workbook(); wb.sheets.set(sheet.name, sheet); return writeXlsxWorkbook(wb, title);
}

function resolveTarget(target: string): string {
  const raw = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  return posix.normalize(raw).replace(/^\.\.\//, "");
}

/** Excel's hard limit is 32,767 characters per cell; longer text only appears in malformed or amplification-bomb files. */
export const MAX_CELL_TEXT = 32767;
function cellText(t: string): string {
  if (t.length > MAX_CELL_TEXT) throw new Error(`invalid .xlsx: cell text of ${t.length} characters exceeds Excel's ${MAX_CELL_TEXT}-character limit`);
  return t;
}
/** TT74: <rPh> phonetic runs (§18.4.6, furigana reading aids) are not cell text — Excel's cell value excludes them */
const noPhonetic = (s: string) => (s.includes("<rPh") ? s.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "") : s);
function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    cellText(dec([...noPhonetic(m[1]).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""))),
  );
}
/** styles.xml → CellStyle per cellXfs index. Theme/indexed colours are read as unset (declared gap). */
/** Theme + indexed palette for a package (theme part found through the workbook rels). */
export function colorContext(stylesXml: string | null, themeXml: string | null): ColorContext {
  return { theme: readThemeColors(themeXml), indexed: readIndexedColors(stylesXml) };
}
function readStyles(xml: string | null, ctx: ColorContext = EMPTY_COLOR_CONTEXT): (CellStyle | undefined)[] {
  if (!xml) return [];
  const numFmts = new Map<number, string>(Object.entries(BUILTIN_NUMFMT).map(([k, v]) => [Number(k), v]));
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) { const at = xmlAttrs(m[1]); if (at.numFmtId && at.formatCode !== undefined) numFmts.set(Number(at.numFmtId), at.formatCode); }
  const section = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "";
  const items = (body: string, tag: string) => [...body.matchAll(new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "g"))].map((m) => ({ attrs: xmlAttrs(m[1]), inner: m[2] ?? "" }));
  const rgb = (inner: string, tag: string) => resolveTag(inner, tag, ctx); // TT47: rgb, theme+tint, indexed
  const flag = (inner: string, tag: string) => { const m = new RegExp(`<${tag}(\\s[^>]*)?/?>`).exec(inner); return !!m && !OFF_VALS.has(xmlAttrs(m[1] ?? "").val ?? ""); };
  const fonts = items(section("fonts"), "font").map(({ inner }) => ({ bold: flag(inner, "b"), italic: flag(inner, "i"), underline: flag(inner, "u"), color: rgb(inner, "color") }));
  const fills = items(section("fills"), "fill").map(({ inner }) => (xmlAttrs(/<patternFill\b([^>]*)/.exec(inner)?.[1] ?? "").patternType === "solid" ? rgb(inner, "fgColor") : undefined));
  const borders = items(section("borders"), "border").map(({ inner }) => {
    const b: CellBorder = {};
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const m = new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`).exec(inner); if (!m) continue;
      const style = xmlAttrs(m[1]).style; if (!isBorderLine(style)) continue; // none / unsupported styles (mediumDashed, slantDashDot…) dropped
      const c = resolveTag(m[2] ?? "", "color", ctx);
      b[side] = c ? { style, color: c } : { style };
    }
    return Object.keys(b).length ? b : undefined;
  });
  return items(section("cellXfs"), "xf").map(({ attrs, inner }) => {
    const st: CellStyle = {};
    const f = fonts[Number(attrs.fontId ?? 0)];
    if (f && Number(attrs.fontId ?? 0) !== 0) { if (f.bold) st.bold = true; if (f.italic) st.italic = true; if (f.underline) st.underline = true; if (f.color && f.color !== "#000000") st.color = f.color; }
    const fill = fills[Number(attrs.fillId ?? 0)]; if (fill) st.fill = fill;
    const border = borders[Number(attrs.borderId ?? 0)]; if (border) st.border = border;
    const nf = numFmts.get(Number(attrs.numFmtId ?? 0)); if (nf && nf !== "General") st.numFmt = nf;
    const al = /<alignment\b([^>]*)\/?>/.exec(inner); if (al) { const a = xmlAttrs(al[1]); if (a.horizontal === "left" || a.horizontal === "center" || a.horizontal === "right") st.align = a.horizontal; if (a.wrapText === "1" || a.wrapText === "true") st.wrap = true; if (a.vertical === "top" || a.vertical === "center" || a.vertical === "bottom") st.valign = a.vertical; }
    return Object.keys(st).length ? st : undefined;
  });
}
const parseA1 = (ref: string) => { const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref); return m ? { col: lettersToCol(m[1].toUpperCase()), row: Number(m[2]) - 1 } : null; };
/**
 * TT68 FF-52: text input for a STRING cell read from a file. Excel keeps a string cell whose text is ""
 * (shared string "", empty inlineStr) as a NON-blank empty-text cell — ISBLANK FALSE, counted by COUNTA and
 * COUNTBLANK alike. `textInput("")` would delete the cell, so keep it as the bare quote prefix `'`.
 */
const keepText = (text: string) => text === "" ? "'" : textInput(text);
function readSheet(xml: string, name: string, sst: string[], xfs: (CellStyle | undefined)[]): Sheet {
  const sheet = new Sheet(name);
  const shared = new Map<string, { body: string; col: number; row: number }>();
  const arrayChildren = new Set<string>();
  // Self-closing <c …/> (styled blanks) must not swallow the following cell's content.
  // TT47: <row r> and <c r> are optional (ECMA-376 §18.3.1.73/§18.3.1.4) — an omitted reference means
  // "next row" / "next column after the previous cell", so rows and cells are scanned together with cursors.
  let rowCursor = -1, colCursor = -1;
  for (const m of xml.matchAll(/<row\b([^>]*?)(\/?)>|<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (m[1] !== undefined) {
      const ra = xmlAttrs(m[1]); const rn = Number(ra.r);
      rowCursor = Number.isInteger(rn) && rn >= 1 ? rn - 1 : rowCursor + 1; colCursor = -1;
      if (ra.hidden === "1" || ra.hidden === "true") sheet.hiddenRows.set(rowCursor, "manual"); // TT74 (re-classed below)
      continue;
    }
    m[1] = m[3]; m[2] = m[4];
    const attrs = xmlAttrs(m[1]);
    const pos = attrs.r ? parseA1(attrs.r) : rowCursor >= 0 ? { col: colCursor + 1, row: rowCursor } : null;
    if (!pos) continue;
    colCursor = pos.col; if (attrs.r) rowCursor = pos.row;
    const { col, row } = pos;
    const style = attrs.s !== undefined ? xfs[Number(attrs.s)] : undefined;
    const applyStyle = () => { if (style) sheet.setStyle(col, row, style); };
    const inner = m[2] ?? "";
    const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
    if (fm) {
      const fa = xmlAttrs(fm[1]); let body = fm[2] !== undefined ? dec(fm[2]) : "";
      if (fa.t === "shared" && fa.si !== undefined) {
        if (body) shared.set(fa.si, { body, col, row });
        else { const master = shared.get(fa.si); if (master) body = shiftFormula(`=${master.body}`, col - master.col, row - master.row).slice(1); }
      }
      if (fa.t === "array" && fa.ref) {
        const [a, b] = fa.ref.split(":").map(parseA1);
        if (a && b) for (let r = a.row; r <= b.row; r++) for (let c = a.col; c <= b.col; c++) if (r !== row || c !== col) arrayChildren.add(`${c},${r}`);
      }
      if (body) {
        sheet.setCell(col, row, `=${stripFuturePrefixes(body)}`); applyStyle();
        // TT46: no dynamic-array cell metadata (cm) and not a CSE array → Excel evaluates it with legacy semantics.
        if (fa.t !== "array" && attrs.cm === undefined) { const c = sheet.get(col, row); if (c?.formula) c.legacy = true; }
        // TT74: a CSE array (no dynamic-array metadata) keeps the shape it was entered with
        if (fa.t === "array" && fa.ref && attrs.cm === undefined) {
          const [a, b] = fa.ref.split(":").map(parseA1); const c = sheet.get(col, row);
          if (a && b && c?.formula) c.cse = { rows: b.row - a.row + 1, cols: b.col - a.col + 1 };
        }
        continue;
      }
    }
    if (arrayChildren.has(`${col},${row}`)) { applyStyle(); continue; } // cached spill value: the anchor re-spills on recalc
    const type = attrs.t ?? "n";
    if (type === "inlineStr") {
      if (!/<is[\s>/]/.test(inner)) { applyStyle(); continue; } // TT68: no <is> → no value (not empty text)
      const text = cellText([...noPhonetic(inner).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => dec(x[1])).join(""));
      sheet.setCell(col, row, keepText(text)); applyStyle(); continue; // TT47: string cells stay text
    }
    const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    if (value === undefined) { applyStyle(); continue; }
    const v = dec(value);
    if (type === "s") { const sv = /^\s*\d+\s*$/.test(v) ? sst[Number(v)] : undefined; if (sv !== undefined) sheet.setCell(col, row, keepText(sv)); } // TT47: "0.00", "00123", "TRUE", "=x" stay TEXT
    else if (type === "str") sheet.setCell(col, row, textInput(v)); // a constant t="str" with <v></v> is no value (Excel writes str only with <f>)
    else if (type === "b") sheet.setCell(col, row, v === "1" ? "TRUE" : "FALSE");
    else sheet.setCell(col, row, v); // e (literal error text), str, n
    applyStyle();
  }
  for (const m of xml.matchAll(/<col\b([^>]*)\/?>/g)) {
    const at = xmlAttrs(m[1]); const min = Number(at.min), max = Number(at.max), w = Number(at.width);
    if ((at.hidden === "1" || at.hidden === "true") && min >= 1 && max >= min) for (let c = min; c <= Math.min(max, 16384); c++) sheet.hiddenCols.add(c - 1); // TT74
    if (!(min >= 1 && max >= min && max - min <= 256 && w > 0) || at.customWidth === "0") continue;
    for (let c = min; c <= max; c++) sheet.colWidths[c - 1] = Math.min(1200, Math.max(16, widthToPx(w)));
  }
  // TT74: the sheet AutoFilter; hidden rows inside its data area are hidden BY the filter
  const af = readAutoFilterXml(xml.replace(/<extLst>[\s\S]*$/, ""));
  // only a filter with criteria hides rows; hidden rows under a criteria-less filter were hidden by hand (Excel: POI
  // ConditionalFormattingSamples "Regional sales3" SUBTOTAL(9) counts them, "Regional sales2" with an icon filter does not)
  if (af) { sheet.autoFilter = af; if (Object.keys(af.cols).length || af.foreign) markFiltered(sheet, af.ref); }
  const pane = /<pane\b([^>]*)\/?>/.exec(xml);
  if (pane) {
    const at = xmlAttrs(pane[1]);
    if (at.state === "frozen" || at.state === "frozenSplit") {
      if (Number(at.ySplit) > 0) sheet.freezeRows = Math.min(50, Math.trunc(Number(at.ySplit)));
      if (Number(at.xSplit) > 0) sheet.freezeCols = Math.min(26, Math.trunc(Number(at.xSplit)));
    }
  }
  for (const m of xml.matchAll(/<mergeCell\b([^>]*)\/?>/g)) {
    const r = parseRef(xmlAttrs(m[1]).ref ?? "");
    if (r && !(r.c0 === r.c1 && r.r0 === r.r1) && !sheet.merges.some((x) => intersects(x, r)) && sheet.merges.length < 5000) sheet.merges.push(r);
  }
  let n = 0;
  for (const m of xml.matchAll(/<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
    const at = xmlAttrs(m[1]); const inner = m[2] ?? "";
    const f = (tag: string) => { const x = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(inner)?.[1]; return x === undefined ? undefined : dec(x); };
    const v = sanitizeValidation({ id: `v${++n}`, sqref: at.sqref, type: at.type ?? "none", operator: at.operator ?? "between", formula1: f("formula1"), formula2: f("formula2"),
      allowBlank: at.allowBlank === "1" || at.allowBlank === "true", errorStyle: at.errorStyle, showError: at.showErrorMessage === "1" || at.showErrorMessage === "true",
      inCellDropdown: !(at.showDropDown === "1" || at.showDropDown === "true"), errorTitle: at.errorTitle, error: at.error, promptTitle: at.promptTitle, prompt: at.prompt }, `v${n}`);
    if (v && sheet.validations.length < 1000) sheet.validations.push(v);
  }
  return sheet;
}

/** TT46: Excel tables of one sheet (sheet rels → xl/tables/tableN.xml) — targets of structured references. */
function readTables(sheetXml: string, sheetPath: string, sheetName: string, wb: Workbook, get: (n: string) => string | null) {
  const parts = [...sheetXml.matchAll(/<tablePart\b([^>]*)\/?>/g)].map((m) => xmlAttrs(m[1])["r:id"]).filter(Boolean);
  if (!parts.length) return;
  const dir = sheetPath.slice(0, sheetPath.lastIndexOf("/") + 1);
  const rels = get(`${dir}_rels/${sheetPath.slice(dir.length)}.rels`) ?? "";
  for (const rid of parts) {
    const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((r) => xmlAttrs(r[1])).find((x) => x.Id === rid);
    if (!rel?.Target) continue;
    const target = rel.Target.startsWith("/") ? rel.Target.slice(1) : normPath(dir + rel.Target);
    const tx = get(target); if (!tx) continue;
    const at = xmlAttrs(/<table\b([^>]*)>/.exec(tx)?.[1] ?? "");
    const r = parseRef(at.ref ?? ""); const name = at.displayName ?? at.name;
    if (!r || !name) continue;
    const columns = [...tx.matchAll(/<tableColumn\b([^>]*?)(?:\/>|>)/g)].map((m) => unXstring(dec(xmlAttrs(m[1]).name ?? "")));
    wb.tables.set(name.toUpperCase(), { name, sheet: sheetName, c0: r.c0, r0: r.r0, c1: r.c1, r1: r.r1, headerRows: at.headerRowCount === "0" ? 0 : 1, totalsRows: Number(at.totalsRowCount ?? 0) > 0 ? 1 : 0, columns });
    // TT74: a table's own AutoFilter hides rows the same way (SUBTOTAL 9 skips them; POI ConditionalFormattingSamples)
    const tafm = /<(?:\w+:)?autoFilter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?autoFilter>)/.exec(tx); const tref = tafm ? xmlAttr(tafm[1], "ref") : undefined;
    const sh = wb.sheets.get(sheetName); if (tref && sh && /<(?:\w+:)?filterColumn\b/.test(tafm![2] ?? "")) markFiltered(sh, tref);
    // TT75: keep the value-list criteria (column offsets inside the table) so a new package can write them back
    const taf = tafm ? readAutoFilterXml(tafm[0]) : null; const tdef = wb.tables.get(name.toUpperCase());
    if (taf && tdef && (Object.keys(taf.cols).length || taf.foreign)) tdef.filter = { cols: taf.cols, ...(taf.foreign ? { foreign: true } : {}), ...(taf.raw ? { raw: taf.raw } : {}) };
  }
}
const normPath = (p: string) => { const out: string[] = []; for (const seg of p.split("/")) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); } return out.join("/"); };

/** Read every workbook sheet by following workbook.xml relationship IDs. */
export function readXlsxWorkbook(buf: Buffer): Workbook {
  const entries = readCentralDirectory(buf);
  // XML 1.0 §2.11: CR LF / lone CR in the raw text are normalised to LF before parsing (escaped &#13; survives).
  // OPC part names compare case-insensitively (ECMA-376 Part 2 §6.2.2.3): exact match first, then ignoring case
  const get = (n: string) => { const e = entries.find((x) => x.name === n) ?? entries.find((x) => x.name.toLowerCase() === n.toLowerCase()); if (!e) return null;
    // TT67: element / attribute prefixes resolved to the canonical ones the readers below match (x:worksheet → worksheet,
    // a foreign prefix bound to the x14 namespace → x14:); unchanged (same string) for Excel's own output
    const raw = readEntryVerified(buf, e).toString("utf8").replace(/\r\n?/g, "\n");
    return /\.rels$/i.test(e.name) ? canonicalizeNs(raw, RELS_CANON, { knownRoot: true }) : /\.xml$/i.test(e.name) ? canonicalizeNs(raw, SML_CANON, { knownRoot: true }) : raw;
  };
  const workbookXml = get("xl/workbook.xml");
  if (!workbookXml) throw new Error("invalid .xlsx: xl/workbook.xml missing");
  const relsXml = get("xl/_rels/workbook.xml.rels") ?? "";
  const rels = new Map<string, string>();
  for (const r of relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const at = xmlAttrs(r[1]); if (at.Id && at.Target) rels.set(at.Id, resolveTarget(at.Target));
  }
  const sst = readSharedStrings(get("xl/sharedStrings.xml"));
  const stylesTarget = [...relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((r) => xmlAttrs(r[1])).find((a) => /\/styles$/.test(a.Type ?? ""))?.Target;
  const stylesXml = get(stylesTarget ? resolveTarget(stylesTarget) : "xl/styles.xml");
  const themeTarget = [...relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((r) => xmlAttrs(r[1])).find((a) => /\/theme$/.test(a.Type ?? ""))?.Target;
  const colors = colorContext(stylesXml, themeTarget ? get(resolveTarget(themeTarget)) : null);
  const xfs = readStyles(stylesXml, colors);
  const dxfs = readDxfs(stylesXml, colors);
  const wb = new Workbook(); wb.sheets.clear(); let chartSeq = 0;
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const at = xmlAttrs(m[1]); const name = at.name; const rid = at["r:id"];
    const path = rels.get(rid);
    if (!name || !path) continue;
    const xml = get(path);
    if (xml) {
      wb.sheets.set(name, readSheet(xml, name, sst, xfs)); readTables(xml, path, name, wb, get); readCondFormats(xml, name, wb, dxfs, colors);
      // TT57: cell hyperlinks (<hyperlinks> + this sheet's relationship part)
      if (/<(?:\w+:)?hyperlinks\b/.test(xml)) { const dir = path.slice(0, path.lastIndexOf("/") + 1); wb.sheets.get(name)!.links = readLinks(xml, get(`${dir}_rels/${path.slice(dir.length)}.rels`) ?? ""); }
      // TT50: charts (drawing → chart parts) on worksheets and chartsheets
      try { wb.charts.push(...readSheetCharts(get, path, xml, name, () => `x${++chartSeq}`)); } catch { /* unreadable drawing: charts skipped, file still opens */ }
    }
  }
  const wbPr = /<workbookPr\b([^>]*)\/?>/.exec(workbookXml);
  if (wbPr) { const d = xmlAttrs(wbPr[1]).date1904; wb.date1904 = d === "1" || d === "true"; }
  if (!wb.sheets.size) throw new Error("invalid .xlsx: workbook has no readable sheets");
  const order = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map((m) => xmlAttrs(m[1]).name ?? "");
  readDefinedNames(workbookXml, wb, order);
  wb.externals = readExternalLinks(workbookXml, rels, get);
  wb.recalculate();
  return wb;
}
/**
 * TT73: <externalReferences> (ECMA-376 §18.2.9) in order → each externalLink part's cached <sheetDataSet> (§18.14.13)
 * and <definedNames>. Cell types per ST_CellType: str/s text (inline <v>), b logical, e error, else number.
 */
function readExternalLinks(workbookXml: string, rels: Map<string, string>, get: (n: string) => string | null): ExternalBook[] {
  const out: ExternalBook[] = [];
  for (const m of workbookXml.matchAll(/<externalReference\b([^>]*)\/?>/g)) {
    const path = rels.get(xmlAttrs(m[1])["r:id"] ?? "");
    const xml = path ? get(path) : null;
    const book: ExternalBook = { target: "", sheetNames: [], sheets: new Map(), names: new Map() };
    out.push(book);
    if (!xml || !path) continue;
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    const lrels = get(`${dir}_rels/${path.slice(dir.length)}.rels`) ?? "";
    const rid = /<externalBook\b([^>]*)>/.exec(xml); const id = rid ? xmlAttrs(rid[1])["r:id"] : undefined;
    for (const r of lrels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) { const at = xmlAttrs(r[1]); if (at.Id === id) book.target = at.Target ?? ""; }
    book.sheetNames = [...xml.matchAll(/<sheetName\b([^>]*)\/?>/g)].map((x) => xmlAttrs(x[1]).val ?? "");
    for (const d of xml.matchAll(/<definedName\b([^>]*)\/?>/g)) { const at = xmlAttrs(d[1]); if (at.name && at.refersTo) book.names.set(at.sheetId !== undefined ? `${at.sheetId}|${at.name.toUpperCase()}` : at.name.toUpperCase(), at.refersTo); }
    for (const sd of xml.matchAll(/<sheetData\b([^>]*?)(?:\/>|>([\s\S]*?)<\/sheetData>)/g)) {
      const name = book.sheetNames[Number(xmlAttrs(sd[1]).sheetId ?? -1)]; if (name === undefined) continue;
      const cells = new Map<string, Scalar>();
      for (const c of (sd[2] ?? "").matchAll(/<cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cell>)/g)) {
        const at = xmlAttrs(c[1]); const a = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(at.r ?? ""); if (!a) continue;
        const ref = { col: lettersToCol(a[1].toUpperCase()), row: Number(a[2]) - 1 };
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? ""); if (!v) continue;
        const raw = dec(v[1]); const t = at.t ?? "n";
        cells.set(`${ref.col},${ref.row}`, t === "str" || t === "s" || t === "inlineStr" ? raw : t === "b" ? raw === "1" || raw === "true" : t === "e" ? ((ERROR_CODES as readonly string[]).includes(raw) ? err(raw as ErrorCode) : raw) : Number(raw));
      }
      book.sheets.set(name.toUpperCase(), cells);
    }
  }
  return out;
}
export function readXlsx(buf: Buffer): Sheet { return readXlsxWorkbook(buf).sheet(); }
export function openWorkbookFromXlsx(buf: Buffer): { workbook: Workbook; sheet: Sheet } {
  const workbook = readXlsxWorkbook(buf); return { workbook, sheet: workbook.sheet() };
}
export function sheetToJson(sheet: Sheet): { name: string; cells: { ref: string; input: string }[] } {
  return workbookToJson(singleSheetWorkbook(sheet)).sheets[0];
}
export function sheetFromJson(data: { name: string; cells: { ref: string; input: string }[] }): Sheet {
  return workbookFromJson({ sheets: [data] }).sheet();
}
function singleSheetWorkbook(sheet: Sheet) { const wb = new Workbook(); wb.sheets.set(sheet.name, sheet); return wb; }
type Dxf = { fill?: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; numFmt?: string; border?: CellBorder };
/** styles.xml <dxfs> → the differential formats conditional-format rules point at (font b/i/strike/u/colour, numFmt, solid fill). */
function readDxfs(xml: string | null, ctx: ColorContext = EMPTY_COLOR_CONTEXT): Dxf[] {
  const body = xml ? /<dxfs\b[^>]*>([\s\S]*?)<\/dxfs>/.exec(xml)?.[1] ?? "" : "";
  return [...body.matchAll(/<dxf\b[^>]*>([\s\S]*?)<\/dxf>|<dxf\b[^>]*\/>/g)].map((m) => dxfFrom(m[1] ?? "", ctx));
}
/** one CT_Dxf body → Dxf (TT59: shared with inline <x14:dxf> of x14-only rules) */
function dxfFrom(inner: string, ctx: ColorContext = EMPTY_COLOR_CONTEXT): Dxf {
  const on = (font: string, tag: string) => { const m = new RegExp(`<${tag}(\\s[^>]*)?\\/?>`).exec(font); return !!m && !OFF_VALS.has(xmlAttrs(m[1] ?? "").val ?? ""); };
  {
    const out: Dxf = {};
    const font = /<font\b[^>]*>([\s\S]*?)<\/font>/.exec(inner)?.[1] ?? "";
    const fc = resolveTag(font, "color", ctx); if (fc) out.color = fc;
    if (on(font, "b")) out.bold = true;
    if (on(font, "i")) out.italic = true;
    if (on(font, "strike")) out.strike = true;
    if (on(font, "u")) out.underline = true;
    const nf = /<numFmt\b([^>]*?)\/?>/.exec(inner); const code = nf ? xmlAttrs(nf[1]).formatCode : undefined; if (code) out.numFmt = code.slice(0, 255);
    // in a dxf the solid fill colour is bgColor (ECMA-376 §18.8.17); fall back to fgColor
    const fill = /<fill\b[^>]*>([\s\S]*?)<\/fill>/.exec(inner)?.[1] ?? "";
    const fl = resolveTag(fill, "bgColor", ctx) ?? resolveTag(fill, "fgColor", ctx);
    if (fl) out.fill = fl;
    // TT49: CF borders (a dxf <border> with styled sides; color auto → the default line colour)
    const bd = /<border\b[^>]*>([\s\S]*?)<\/border>/.exec(inner)?.[1] ?? "";
    const b: CellBorder = {};
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const sm = new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`).exec(bd); if (!sm) continue;
      const style = xmlAttrs(sm[1]).style; if (!isBorderLine(style)) continue;
      const c = resolveTag(sm[2] ?? "", "color", ctx); b[side] = c ? { style, color: c } : { style };
    }
    if (Object.keys(b).length) out.border = b;
    return out;
  }
}
/**
 * <conditionalFormatting> → workbook CondRules for DISPLAY (TT46; TT49 every cfRule type). Rules are sorted by
 * their sheet-wide priority (array order = priority). Linked x14 extension rules supply data-bar extras (autoMin/
 * autoMax, lengths, solid fill, border, negative axis); x14-only icon sets (3Stars, 3Triangles, 5Boxes, custom
 * icons) are modelled with provenance "x<n>". Other x14-only rules (cross-sheet expressions) are not displayed;
 * the lossless save keeps every rule verbatim either way.
 */
function readCondFormats(xml: string, sheet: string, wb: Workbook, dxfs: Dxf[], ctx: ColorContext = EMPTY_COLOR_CONTEXT) {
  const num = (f: string | undefined) => (f !== undefined && /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(f.trim()) ? f.trim() : undefined);
  const strConst = (f: string | undefined) => { const m = f ? /^"((?:[^"]|"")*)"$/.exec(f.trim()) : null; return m ? m[1].replace(/""/g, "\"") : undefined; };
  let cfIndex = -1;
  // x14 extension rules (MS-XLSX 2.6.2): collected by id; the main rule links to one through <x14:id>
  // TT49: the WORKSHEET-level extLst starts at the first <extLst> outside every <cfRule> — a data-bar cfRule carries
  // its own inner <extLst> (the x14 link), and a greedy match from there used to swallow every rule that followed it
  let cut = xml.length, depth = 0;
  for (const m of xml.matchAll(/<(\/?)(?:\w+:)?(cfRule|extLst)\b[^>]*?(\/?)>/g)) {
    if (m[2] === "cfRule") { if (m[3]) continue; depth += m[1] ? -1 : 1; continue; }
    if (!m[1] && depth <= 0) { cut = m.index!; break; }
  }
  const ext = xml.slice(cut);
  type X14 = { at: Record<string, string>; inner: string; sqref: string; index: number };
  const x14: X14[] = []; const x14ById = new Map<string, X14>();
  for (const m of ext.matchAll(/<x14:conditionalFormatting\b[^>]*>([\s\S]*?)<\/x14:conditionalFormatting>/g)) {
    const sqref = (/<xm:sqref>([^<]*)<\/xm:sqref>/.exec(m[1])?.[1] ?? "").trim();
    for (const r of m[1].matchAll(/<x14:cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/x14:cfRule>)/g)) {
      const e: X14 = { at: xmlAttrs(r[1]), inner: r[2] ?? "", sqref, index: x14.length }; x14.push(e); if (e.at.id) x14ById.set(e.at.id, e);
    }
  }
  const x14Cfvo = (inner: string): Cfvo[] => [...inner.matchAll(/<x14:cfvo\b([^>]*?)(?:\/>|>([\s\S]*?)<\/x14:cfvo>)/g)].flatMap((c) => {
    const a = xmlAttrs(c[1]); const f = /<xm:f>([\s\S]*?)<\/xm:f>/.exec(c[2] ?? "")?.[1];
    if (!CFVO_TYPES.includes(a.type)) return [];
    return [{ t: a.type as Cfvo["t"], ...(f !== undefined ? { v: dec(f) } : {}), ...(a.gte === "0" || a.gte === "false" ? { gt: true } : {}) }];
  });
  const mainCfvo = (inner: string): Cfvo[] => [...inner.matchAll(/<cfvo\b([^>]*?)\/?>/g)].flatMap((c) => {
    const a = xmlAttrs(c[1]); if (!CFVO_TYPES.includes(a.type)) return [];
    return [{ t: a.type as Cfvo["t"], ...(a.val !== undefined && a.type !== "min" && a.type !== "max" ? { v: a.val } : {}), ...(a.gte === "0" || a.gte === "false" ? { gt: true } : {}) }];
  });
  /** x14 data-bar properties (MS-XLSX CT_DataBar) into r; shared by linked bars and (TT66) x14-only bars */
  const x14Bar = (r: Partial<CondRule>, x: { inner: string }) => {
    const yes = (v: string | undefined) => v === "1" || v === "true";
    const len = (v: string | undefined) => { const n = Math.trunc(Number(v)); return v !== undefined && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined; };
    const xb = /<x14:dataBar\b([^>]*?)\/?>/.exec(x.inner); const xa = xb ? xmlAttrs(xb[1]) : {};
    if (xa.gradient === "0" || xa.gradient === "false") r.barSolid = true;
    const tagColor = (tag: string) => { const m = new RegExp(`<x14:${tag}\\b([^>]*?)\\/?>`).exec(x.inner); return m ? resolveColorAttrs(m[1], ctx) : null; };
    if (yes(xa.border)) { const bc = tagColor("borderColor"); if (bc) r.barBorder = bc; }
    r.barAxis = xa.axisPosition === "middle" ? "middle" : xa.axisPosition === "none" ? "none" : "auto";
    const neg = tagColor("negativeFillColor"); if (neg) r.barNeg = neg;
    const ax = tagColor("axisColor"); if (ax) r.barAxisColor = ax;
    return { cfvo: x14Cfvo(x.inner), minL: len(xa.minLength) ?? 10, maxL: len(xa.maxLength) ?? 90, fill: tagColor("fillColor"), hide: xa.showValue === "0" || xa.showValue === "false" };
  };
  const linked = new Set<string>();
  const pending: { prio: number; seq: number; rules: CondRule[] }[] = [];
  let seq = 0;
  const push = (rule: Partial<CondRule>, ranges: string[], fmt: Dxf, src: string, prio: number) => {
    const visual = rule.kind === "scale" || rule.kind === "bar" || rule.kind === "icons";
    if (!visual && !Object.values(fmt).some(Boolean) && !rule.stop) return; // nothing visible and no stopIfTrue
    // one rule per cfRule over the whole sqref (a union): splitting a 200-range sqref per range multiplied rules past the cap
    pending.push({ prio, seq: seq++, rules: [{ id: "", sheet, range: ranges.join(" "), ...rule, ...(visual ? {} : fmt), src } as CondRule] });
  };
  /** TT59: the non-visual rule kinds, shared by main-schema <cfRule> and x14-only <x14:cfRule> (MS-XLSX 2.6.x: same
   *  attributes, operands in <xm:f>, formatting in an inline <x14:dxf>) */
  const decodeBasic = (t: string | undefined, at: Record<string, string>, formulas: string[]): Partial<CondRule> | null => {
    const yes = (v: string | undefined) => v === "1" || v === "true";
    let rule: Partial<CondRule> | null = null;
    if (t === "cellIs") {
      const kind = ({ greaterThan: "gt", lessThan: "lt", greaterThanOrEqual: "ge", lessThanOrEqual: "le", equal: "eq", notEqual: "ne", between: "between", notBetween: "notBetween" } as Record<string, CondRule["kind"]>)[at.operator ?? ""];
      const operand = (f: string | undefined, textOk: boolean): { v?: string; f?: string } | null => {
        if (f === undefined || f.trim() === "") return null;
        const n = num(f); if (n !== undefined) return { v: n };
        const s = strConst(f); if (s !== undefined && textOk && !/^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(s)) return { v: s };
        return { f: f.trim().replace(/^=/, "") };
      };
      const two = kind === "between" || kind === "notBetween";
      const p = operand(formulas[0], kind === "eq" || kind === "ne"), q = two ? operand(formulas[1], false) : null;
      if (kind && p && (!two || q)) rule = { kind, ...(p.v !== undefined ? { a: p.v } : { af: p.f }), ...(q ? (q.v !== undefined ? { b: q.v } : { bf: q.f }) : {}) };
    } else if (t === "containsText" || t === "notContainsText" || t === "beginsWith" || t === "endsWith") {
      const kind = ({ containsText: "contains", notContainsText: "notContains", beginsWith: "begins", endsWith: "ends" } as const)[t];
      if (at.text !== undefined) rule = { kind, a: at.text };
      else if (formulas[0]) rule = { kind: "expr", formula: formulas[0] };
    } else if (t === "containsBlanks") rule = { kind: "blanks" };
    else if (t === "notContainsBlanks") rule = { kind: "noBlanks" };
    else if (t === "containsErrors") rule = { kind: "errors" };
    else if (t === "notContainsErrors") rule = { kind: "noErrors" };
    else if (t === "duplicateValues") rule = { kind: "duplicate" };
    else if (t === "uniqueValues") rule = { kind: "unique" };
    else if (t === "top10") rule = { kind: "top", a: at.rank ?? "10", ...(yes(at.percent) ? { pct: true } : {}), ...(yes(at.bottom) ? { bottom: true } : {}) };
    else if (t === "aboveAverage") {
      const sd = Math.trunc(Number(at.stdDev ?? 0));
      rule = { kind: "aboveAvg", ...(at.aboveAverage === "0" || at.aboveAverage === "false" ? { below: true } : {}), ...(yes(at.equalAverage) ? { equal: true } : {}), ...(sd >= 1 && sd <= 3 ? { stdDev: sd } : {}) };
    } else if (t === "timePeriod") {
      if ((TIME_PERIODS as readonly string[]).includes(at.timePeriod ?? "")) rule = { kind: "period", period: at.timePeriod, ...(formulas[0] ? { formula: formulas[0] } : {}) };
    } else if (t === "expression") {
      if (formulas[0]) rule = { kind: "expr", formula: formulas[0] };
    }
    return rule;
  };
  // extLst may redeclare a default namespace around x14 <conditionalFormatting> — not main-namespace rules; skipping it
  // keeps the provenance index aligned with the patcher's count of top-level elements
  const top = xml.slice(0, cut);
  for (const cf of top.matchAll(/<conditionalFormatting\b([^>]*?)(?:\/>|>([\s\S]*?)<\/conditionalFormatting>)/g)) {
    cfIndex++;
    const sqref = xmlAttrs(cf[1]).sqref; if (!sqref) continue;
    const ranges = sqref.trim().split(/\s+/).map((r) => r.replace(/\$/g, "")).filter((r) => parseRef(r));
    if (!ranges.length) continue;
    const rules = [...(cf[2] ?? "").matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)].map((r, ri) => ({ at: xmlAttrs(r[1]), inner: r[2] ?? "", ri }));
    for (const { at, inner: rawInner, ri } of rules) {
      const x14id = /<x14:id>([^<]*)<\/x14:id>/.exec(rawInner)?.[1]?.trim();
      const inner = rawInner.replace(/<extLst\b[\s\S]*<\/extLst>/, "");
      const formulas = [...inner.matchAll(/<formula>([\s\S]*?)<\/formula>/g)].map((f) => dec(f[1]));
      const fmt = at.dxfId !== undefined ? dxfs[Number(at.dxfId)] ?? {} : {};
      const prio = Number(at.priority ?? 0) || 0;
      const yes = (v: string | undefined) => v === "1" || v === "true";
      let rule: Partial<CondRule> | null = null;
      const t = at.type;
      rule = decodeBasic(t, at, formulas);
      if (rule) { /* decoded */ } else if (t === "colorScale") {
        // TT47: 2- and 3-colour scales with their cfvo thresholds; formula thresholds are not modelled → rule skipped
        const cols = [...inner.matchAll(/<color\b([^>]*?)\/?>/g)].map((c) => resolveColorAttrs(c[1], ctx));
        const cfvo = [...inner.matchAll(/<cfvo\b([^>]*?)\/?>/g)].map((c) => xmlAttrs(c[1]));
        const sat = cfvo.map((c) => (c.type === "min" || c.type === "max" ? c.type : ["num", "percent", "percentile"].includes(c.type ?? "") && c.val !== undefined && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(c.val.trim()) ? `${c.type}:${c.val.trim()}` : null));
        if ((cols.length === 2 || cols.length === 3) && cfvo.length === cols.length && cols.every(Boolean) && sat.every(Boolean))
          rule = { kind: "scale", scaleMin: cols[0]!, scaleMax: cols[cols.length - 1]!, ...(cols.length === 3 ? { scaleMid: cols[1]! } : {}), scaleAt: sat.join("|") };
      } else if (t === "dataBar") {
        const db = /<dataBar\b([^>]*?)>/.exec(inner); const dat = db ? xmlAttrs(db[1]) : {};
        const colorTag = /<color\b([^>]*?)\/?>/.exec(inner); const color = colorTag ? resolveColorAttrs(colorTag[1], ctx) : null;
        let cfvo = mainCfvo(inner);
        const len = (v: string | undefined) => { const n = Math.trunc(Number(v)); return v !== undefined && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined; };
        const r: Partial<CondRule> = { kind: "bar", barColor: color ?? "#638ec6" };
        let minL = len(dat.minLength), maxL = len(dat.maxLength);
        const x = x14id ? x14ById.get(x14id) : undefined;
        if (x && x.at.type === "dataBar") {
          linked.add(x14id!); r.x14 = x14id;
          const b = x14Bar(r, x); if (b.cfvo.length === 2) cfvo = b.cfvo;
          minL = b.minL; maxL = b.maxL;
        }
        if (cfvo.length === 2) r.cfvo = cfvo;
        if (minL !== undefined && minL !== 10) r.barMinLen = minL;
        if (maxL !== undefined && maxL !== 90) r.barMaxLen = maxL;
        if (dat.showValue === "0" || dat.showValue === "false") r.hideValue = true;
        rule = r;
      } else if (t === "iconSet") {
        const is = /<iconSet\b([^>]*?)\/?>/.exec(inner); const ia = is ? xmlAttrs(is[1]) : {};
        const set = ia.iconSet ?? "3TrafficLights1";
        if (ICON_SETS[set]) {
          const cfvo = mainCfvo(inner);
          rule = { kind: "icons", iconSet: set, ...(cfvo.length ? { cfvo } : {}), ...(yes(ia.reverse) ? { reverse: true } : {}), ...(ia.showValue === "0" || ia.showValue === "false" ? { hideValue: true } : {}) };
        }
      }
      if (!rule) continue;
      if (yes(at.stopIfTrue) && rule.kind !== "scale" && rule.kind !== "bar" && rule.kind !== "icons") rule.stop = true;
      push(rule, ranges, fmt, `${cfIndex}.${ri}`, prio);
    }
  }
  // x14-only icon sets (Excel 2010+: 3Stars, 3Triangles, 5Boxes, custom icon mixes) — no main-schema counterpart
  for (const x of x14) {
    if (x.at.type !== "iconSet" || (x.at.id && linked.has(x.at.id))) continue;
    const is = /<x14:iconSet\b([^>]*?)\/?>/.exec(x.inner); const ia = is ? xmlAttrs(is[1]) : {};
    const set = ia.iconSet ?? "3TrafficLights1"; if (!ICON_SETS[set]) continue;
    const ranges = x.sqref.split(/\s+/).map((r) => r.replace(/\$/g, "")).filter((r) => parseRef(r)); if (!ranges.length) continue;
    const cfvo = x14Cfvo(x.inner);
    const icons = [...x.inner.matchAll(/<x14:cfIcon\b([^>]*?)\/?>/g)].map((c) => { const a = xmlAttrs(c[1]); return `${a.iconSet}:${Math.trunc(Number(a.iconId) || 0)}`; });
    const yes = (v: string | undefined) => v === "1" || v === "true";
    const rule: Partial<CondRule> = { kind: "icons", iconSet: set, ...(cfvo.length ? { cfvo } : {}), ...(yes(ia.custom) && icons.length ? { icons } : {}), ...(yes(ia.reverse) ? { reverse: true } : {}), ...(ia.showValue === "0" || ia.showValue === "false" ? { hideValue: true } : {}) };
    push(rule, ranges, {}, `x${x.index}`, Number(x.at.priority ?? 0) || 0);
  }
  // TT66: x14-only data bars — Excel 2010+ writes one when a threshold formula refers to another sheet (a 2007 <cfvo val>
  // cannot); with no 2007 fallback the bar colour (<x14:fillColor>), priority and showValue all live in the x14 rule
  for (const x of x14) {
    if (x.at.type !== "dataBar" || (x.at.id && linked.has(x.at.id))) continue;
    const ranges = x.sqref.split(/\s+/).map((r) => r.replace(/\$/g, "")).filter((r) => parseRef(r)); if (!ranges.length) continue;
    const r: Partial<CondRule> = { kind: "bar" };
    const b = x14Bar(r, x);
    r.barColor = b.fill ?? "#638ec6";
    if (r.barAxis === "none") delete r.barAxis; // = an Excel 2007 bar (no axis); the writer spells an unset axis "none"
    if (b.cfvo.length === 2) r.cfvo = b.cfvo;
    if (b.minL !== 10) r.barMinLen = b.minL;
    if (b.maxL !== 90) r.barMaxLen = b.maxL;
    if (b.hide) r.hideValue = true;
    if (x.at.id && GUID_RE.test(x.at.id)) r.x14 = x.at.id;
    push(r, ranges, {}, `x${x.index}`, Number(x.at.priority ?? 0) || 0);
  }
  // TT59: x14-only non-visual rules — Excel 2010+ writes a rule whose formulas refer to another sheet here (2007's
  // <cfRule> cannot); operands are <xm:f> children and the format is an inline <x14:dxf> (CT_Dxf, main namespace)
  for (const x of x14) {
    const t = x.at.type; if (!t || t === "iconSet" || t === "dataBar" || t === "colorScale" || (x.at.id && linked.has(x.at.id))) continue;
    const ranges = x.sqref.split(/\s+/).map((r) => r.replace(/\$/g, "")).filter((r) => parseRef(r)); if (!ranges.length) continue;
    const formulas = [...x.inner.replace(/<x14:dxf\b[\s\S]*?<\/x14:dxf>/g, "").matchAll(/<xm:f>([\s\S]*?)<\/xm:f>/g)].map((f) => dec(f[1]));
    const rule = decodeBasic(t, x.at, formulas); if (!rule) continue;
    const dxfInner = /<x14:dxf\b[^>]*>([\s\S]*?)<\/x14:dxf>/.exec(x.inner)?.[1] ?? "";
    const fmt = dxfInner ? dxfFrom(dxfInner.replace(/<(\/?)x:/g, "<$1"), ctx) : {};
    if (x.at.stopIfTrue === "1" || x.at.stopIfTrue === "true") rule.stop = true;
    push(rule, ranges, fmt, `x${x.index}`, Number(x.at.priority ?? 0) || 0);
  }
  pending.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
  for (const p of pending) for (const r of p.rules) {
    if (wb.condFormats.length >= 2000) return;
    wb.condFormats.push({ ...r, id: `x${wb.condFormats.length + 1}` });
  }
}
const CFVO_TYPES = ["min", "max", "num", "percent", "percentile", "formula", "autoMin", "autoMax"];
/** Internals shared with the lossless patch writer (xlsx-patch.ts). */
export const xlsxInternals = { BUILTIN_BY_CODE, argb, dvXml, pxToWidth, readStyles, cfRuleXml, cfDxfXml, cfX14Xml, stableGuid, X14_NS, XM_NS, GUID_RE };
