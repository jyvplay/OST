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
 * Unsupported (loss-report items): charts, pivot tables, defined names,
 * conditional formatting, external links, data validation, drawings, macros,
 * 1904 date system, theme/indexed colours (read as unset), rich text
 * runs, Excel 365 XLDAPR dynamic-array metadata (array formulas open in Excel
 * as legacy {=…} arrays with correct values). Not a claim of modern-suite parity.
 */
import { posix } from "node:path";
import { writeZip, readCentralDirectory, readEntryVerified } from "../server/zip";
import { Sheet, Workbook, a1, type CellStyle, type CellBorder, type DataValidation } from "./engine";
import { isBorderLine, parseRef, rangeRef, intersects, sanitizeValidation } from "./sheetlayout";
import { colToLetters, lettersToCol, isError } from "./types";
import { shiftFormula, addFuturePrefixes, stripFuturePrefixes } from "./sheetops";
export { workbookToJson, workbookFromJson, type WorkbookJson } from "./workbook-json";
import { workbookToJson, workbookFromJson } from "./workbook-json";

const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
// XML 1.0 forbids C0 controls other than tab/LF/CR; strip them so a pasted control char cannot corrupt the package.
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xmlAttrs = (s: string) => Object.fromEntries([...s.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map((m) => [m[1], dec(m[2])]));

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
const CORE = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Fusion Shell Web</dc:creator></cp:coreProperties>`;
const APP = `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Fusion Shell Web — Sheet</Application></Properties>`;

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\\/*?:\[\]]/g, " ").trim().slice(0, 31) || "Sheet";
  let candidate = base, n = 2;
  while ([...used].some((x) => x.toLowerCase() === candidate.toLowerCase())) {
    const suffix = ` (${n++})`; candidate = base.slice(0, 31 - suffix.length) + suffix;
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
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${nf}<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts><fills count="${this.fills.length}">${this.fills.join("")}</fills><borders count="${this.borders.length}">${this.borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
}
/** Column width: Excel stores characters of the max digit width (7px for Calibri 11) incl. 5px padding. */
const pxToWidth = (px: number) => Math.trunc((px / 7) * 256) / 256;
const widthToPx = (w: number) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);

function renderSheet(wb: Workbook, sheet: Sheet, sharedIndex: (s: string) => number, styles: StyleTable) {
  const positions = new Map<string, { col: number; row: number }>();
  for (const k of sheet.grid.keys()) { const [col, row] = k.split(",").map(Number); positions.set(k, { col, row }); }
  for (const fq of wb.spillOwner.keys()) {
    const bang = fq.lastIndexOf("!"); if (fq.slice(0, bang) !== sheet.name) continue;
    const k = fq.slice(bang + 1); const [col, row] = k.split(",").map(Number); positions.set(k, { col, row });
  }
  const cells = [...positions.values()].sort((a, b) => a.row - b.row || a.col - b.col);
  const rows = new Map<number, string[]>(); let maxCol = -1, maxRow = -1;
  for (const { col, row } of cells) {
    const cell = sheet.get(col, row);
    const ref = a1(col, row);
    const s = styles.xf(cell?.style); const sa = s ? ` s="${s}"` : "";
    const hasInput = !!cell && cell.input !== "";
    const v = hasInput ? cell!.value : wb.valueAt(sheet.name, col, row);
    let formula = "";
    if (hasInput && cell!.formula) {
      const body = esc(addFuturePrefixes(cell!.input.slice(1)));
      const sp = cell!.spill;
      formula = sp && (sp.rows > 1 || sp.cols > 1) ? `<f t="array" ref="${ref}:${a1(col + sp.cols - 1, row + sp.rows - 1)}">${body}</f>` : `<f>${body}</f>`;
    }
    let out: string;
    if (v === undefined || (v === "" && !formula)) { if (!s) continue; out = `<c r="${ref}"${sa}/>`; }
    else if (isError(v)) {
      // #CIRCULAR!/#SPILL!/#CALC! are not ECMA-376 ST_CellError tokens; export as #VALUE! (engine keeps its own code).
      const code = v.error === "#CIRCULAR!" || v.error === "#SPILL!" || v.error === "#CALC!" ? "#VALUE!" : v.error;
      out = `<c r="${ref}"${sa} t="e">${formula}<v>${esc(code)}</v></c>`;
    } else if (typeof v === "boolean") out = `<c r="${ref}"${sa} t="b">${formula}<v>${v ? 1 : 0}</v></c>`;
    else if (typeof v === "number") out = `<c r="${ref}"${sa}>${formula}<v>${v}</v></c>`;
    else if (formula) out = `<c r="${ref}"${sa} t="str">${formula}<v>${esc(v)}</v></c>`;
    else out = `<c r="${ref}"${sa} t="s"><v>${sharedIndex(v)}</v></c>`;
    maxCol = Math.max(maxCol, col); maxRow = Math.max(maxRow, row);
    (rows.get(row) ?? rows.set(row, []).get(row)!).push(out);
  }
  const data = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r + 1}">${cs.join("")}</row>`).join("");
  const dim = maxRow < 0 ? "A1" : `A1:${colToLetters(maxCol)}${maxRow + 1}`;
  const widths = Object.entries(sheet.colWidths).map(([c, px]) => [Number(c), px] as const).filter(([c]) => c >= 0 && c <= 16383).sort((a, b) => a[0] - b[0]);
  const cols = widths.length ? `<cols>${widths.map(([c, px]) => `<col min="${c + 1}" max="${c + 1}" width="${pxToWidth(px)}" customWidth="1"/>`).join("")}</cols>` : "";
  const fr = sheet.freezeRows, fc = sheet.freezeCols;
  const pane = fr > 0 && fc > 0 ? "bottomRight" : fr > 0 ? "bottomLeft" : "topRight";
  const views = fr > 0 || fc > 0 ? `<sheetViews><sheetView workbookViewId="0"><pane${fc ? ` xSplit="${fc}"` : ""}${fr ? ` ySplit="${fr}"` : ""} topLeftCell="${colToLetters(fc)}${fr + 1}" activePane="${pane}" state="frozen"/><selection pane="${pane}"/></sheetView></sheetViews>` : "";
  // CT_Worksheet order: … sheetData, …, mergeCells, phoneticPr, conditionalFormatting, dataValidations, …
  const merges = sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${rangeRef(m)}"/>`).join("")}</mergeCells>` : "";
  const dvs = sheet.validations.length ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map(dvXml).join("")}</dataValidations>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/>${views}${cols}<sheetData>${data}</sheetData>${merges}${dvs}</worksheet>`;
}

/** ECMA-376 §18.3.1.32. NB showDropDown="1" HIDES the in-cell arrow. */
function dvXml(v: DataValidation): string {
  const at = [`type="${v.type}"`, v.operator && v.type !== "list" && v.type !== "custom" ? `operator="${v.operator}"` : "", v.allowBlank ? 'allowBlank="1"' : "",
    v.type === "list" && !v.inCellDropdown ? 'showDropDown="1"' : "", v.prompt || v.promptTitle ? 'showInputMessage="1"' : "", v.showError ? 'showErrorMessage="1"' : "",
    v.errorStyle !== "stop" ? `errorStyle="${v.errorStyle}"` : "", v.errorTitle ? `errorTitle="${esc(v.errorTitle)}"` : "", v.error ? `error="${esc(v.error)}"` : "",
    v.promptTitle ? `promptTitle="${esc(v.promptTitle)}"` : "", v.prompt ? `prompt="${esc(v.prompt)}"` : "", `sqref="${esc(v.sqref)}"`].filter(Boolean).join(" ");
  return `<dataValidation ${at}><formula1>${esc(v.formula1)}</formula1>${v.formula2 ? `<formula2>${esc(v.formula2)}</formula2>` : ""}</dataValidation>`;
}

/** Real .xlsx / SpreadsheetML writer, supporting all sheets in a Workbook. */
export function writeXlsxWorkbook(workbook: Workbook, title = "Workbook"): Buffer {
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
  const sheetXmls = sheets.map((s) => renderSheet(workbook, s, sharedIndex, styles));
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  rels.push(`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  rels.push(`<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`);
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
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
  ]);
}

export function writeXlsx(sheet: Sheet, title = "Sheet1"): Buffer {
  const wb = new Workbook(); wb.sheets.set(sheet.name, sheet); return writeXlsxWorkbook(wb, title);
}

function resolveTarget(target: string): string {
  const raw = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  return posix.normalize(raw).replace(/^\.\.\//, "");
}

function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    dec([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
}
/** styles.xml → CellStyle per cellXfs index. Theme/indexed colours are read as unset (declared gap). */
function readStyles(xml: string | null): (CellStyle | undefined)[] {
  if (!xml) return [];
  const numFmts = new Map<number, string>(Object.entries(BUILTIN_NUMFMT).map(([k, v]) => [Number(k), v]));
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) { const at = xmlAttrs(m[1]); if (at.numFmtId && at.formatCode !== undefined) numFmts.set(Number(at.numFmtId), at.formatCode); }
  const section = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "";
  const items = (body: string, tag: string) => [...body.matchAll(new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "g"))].map((m) => ({ attrs: xmlAttrs(m[1]), inner: m[2] ?? "" }));
  const rgb = (inner: string, tag: string) => { const m = new RegExp(`<${tag}\\b[^>]*\\brgb="([0-9A-Fa-f]{8})"`).exec(inner); return m ? `#${m[1].slice(2).toLowerCase()}` : undefined; };
  const flag = (inner: string, tag: string) => { const m = new RegExp(`<${tag}(\\s[^>]*)?/?>`).exec(inner); return !!m && !/val="(0|false|none)"/.test(m[1] ?? ""); };
  const fonts = items(section("fonts"), "font").map(({ inner }) => ({ bold: flag(inner, "b"), italic: flag(inner, "i"), underline: flag(inner, "u"), color: rgb(inner, "color") }));
  const fills = items(section("fills"), "fill").map(({ inner }) => (/patternType="solid"/.test(inner) ? rgb(inner, "fgColor") : undefined));
  const borders = items(section("borders"), "border").map(({ inner }) => {
    const b: CellBorder = {};
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const m = new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`).exec(inner); if (!m) continue;
      const style = xmlAttrs(m[1]).style; if (!isBorderLine(style)) continue; // none / unsupported styles (mediumDashed, slantDashDot…) dropped
      const c = /<color\b[^>]*\brgb="([0-9A-Fa-f]{8})"/.exec(m[2] ?? "")?.[1];
      b[side] = c ? { style, color: `#${c.slice(2).toLowerCase()}` } : { style };
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
function readSheet(xml: string, name: string, sst: string[], xfs: (CellStyle | undefined)[]): Sheet {
  const sheet = new Sheet(name);
  const shared = new Map<string, { body: string; col: number; row: number }>();
  const arrayChildren = new Set<string>();
  // Self-closing <c …/> (styled blanks) must not swallow the following cell's content.
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = xmlAttrs(m[1]);
    const pos = attrs.r ? parseA1(attrs.r) : null;
    if (!pos) continue;
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
      if (body) { sheet.setCell(col, row, `=${stripFuturePrefixes(body)}`); applyStyle(); continue; }
    }
    if (arrayChildren.has(`${col},${row}`)) { applyStyle(); continue; } // cached spill value: the anchor re-spills on recalc
    const type = attrs.t ?? "n";
    if (type === "inlineStr") {
      const text = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => dec(x[1])).join("");
      sheet.setCell(col, row, text); applyStyle(); continue;
    }
    const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    if (value === undefined) { applyStyle(); continue; }
    const v = dec(value);
    if (type === "s") sheet.setCell(col, row, sst[Number(v)] ?? "");
    else if (type === "b") sheet.setCell(col, row, v === "1" ? "TRUE" : "FALSE");
    else sheet.setCell(col, row, v); // e (literal error text), str, n
    applyStyle();
  }
  for (const m of xml.matchAll(/<col\b([^>]*)\/?>/g)) {
    const at = xmlAttrs(m[1]); const min = Number(at.min), max = Number(at.max), w = Number(at.width);
    if (!(min >= 1 && max >= min && max - min <= 256 && w > 0) || at.customWidth === "0") continue;
    for (let c = min; c <= max; c++) sheet.colWidths[c - 1] = Math.min(1200, Math.max(16, widthToPx(w)));
  }
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

/** Read every workbook sheet by following workbook.xml relationship IDs. */
export function readXlsxWorkbook(buf: Buffer): Workbook {
  const entries = readCentralDirectory(buf);
  const get = (n: string) => { const e = entries.find((x) => x.name === n); return e ? readEntryVerified(buf, e).toString("utf8") : null; };
  const workbookXml = get("xl/workbook.xml");
  if (!workbookXml) throw new Error("invalid .xlsx: xl/workbook.xml missing");
  const relsXml = get("xl/_rels/workbook.xml.rels") ?? "";
  const rels = new Map<string, string>();
  for (const r of relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const at = xmlAttrs(r[1]); if (at.Id && at.Target) rels.set(at.Id, resolveTarget(at.Target));
  }
  const sst = readSharedStrings(get("xl/sharedStrings.xml"));
  const stylesTarget = [...relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((r) => xmlAttrs(r[1])).find((a) => /\/styles$/.test(a.Type ?? ""))?.Target;
  const xfs = readStyles(get(stylesTarget ? resolveTarget(stylesTarget) : "xl/styles.xml"));
  const wb = new Workbook(); wb.sheets.clear();
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const at = xmlAttrs(m[1]); const name = at.name; const rid = at["r:id"];
    const path = rels.get(rid);
    if (!name || !path) continue;
    const xml = get(path);
    if (xml) wb.sheets.set(name, readSheet(xml, name, sst, xfs));
  }
  if (!wb.sheets.size) throw new Error("invalid .xlsx: workbook has no readable sheets");
  wb.recalculate();
  return wb;
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
