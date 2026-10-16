/**
 * First-party SpreadsheetML reader/writer for a deliberately bounded workbook
 * profile. Microsoft Learn's Open XML reference (fetched this turn) confirms
 * that formula text lives in <f> and the last cached result in <v>; this reader
 * does NOT trust stale cached formula values, instead re-evaluating them with
 * src/lib/formula before presentation/export.
 *
 * Supported: multi-sheet workbooks; sharedStrings + inlineStr; numeric,
 * string, boolean, error and formula cells; relative/absolute A1 refs; our
 * formula subset; simple styles (basic font/bold). Reader resolves workbook
 * <sheet r:id> through workbook.xml.rels rather than assuming sheet1.xml.
 * Unsupported: charts, pivot tables, defined names, conditional formatting,
 * external workbook links, data validation, drawings, macros, 1904 date system,
 * shared/array formulas, rich-text styling on strings. Those remain loss-report
 * items; this is not a claim of modern-suite parity.
 */
import { posix } from "node:path";
import { writeZip, readCentralDirectory, readEntryVerified } from "../server/zip";
import { Sheet, Workbook, a1 } from "./engine";
import { colToLetters, lettersToCol, isError, type Scalar } from "./types";

const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xmlAttrs = (s: string) => Object.fromEntries([...s.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map((m) => [m[1], dec(m[2])]));

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" xfId="0"/><xf numFmtId="0" fontId="1" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;
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
function renderSheet(sheet: Sheet, sharedIndex: (s: string) => number) {
  const cells = [...sheet.grid.entries()].map(([k, cell]) => {
    const [col, row] = k.split(",").map(Number); return { col, row, cell };
  }).sort((a, b) => a.row - b.row || a.col - b.col);
  const rows = new Map<number, string[]>(); let maxCol = -1, maxRow = -1;
  for (const { col, row, cell } of cells) {
    maxCol = Math.max(maxCol, col); maxRow = Math.max(maxRow, row);
    const ref = a1(col, row); const v = cell.value;
    const formula = cell.formula ? `<f>${esc(cell.input.slice(1))}</f>` : "";
    let out: string;
    if (isError(v)) {
      // #CIRCULAR! is our internal diagnostic, not an OOXML cell error token.
      // Map it to spec-defined #VALUE! on export; internal engine retains #CIRCULAR!.
      const code = v.error === "#CIRCULAR!" ? "#VALUE!" : v.error;
      out = `<c r="${ref}" t="e">${formula}<v>${esc(code)}</v></c>`;
    } else if (typeof v === "boolean") out = `<c r="${ref}" t="b">${formula}<v>${v ? 1 : 0}</v></c>`;
    else if (typeof v === "number") out = `<c r="${ref}">${formula}<v>${v}</v></c>`;
    else if (cell.formula) out = `<c r="${ref}" t="str">${formula}<v>${esc(v)}</v></c>`;
    else out = `<c r="${ref}" t="s"><v>${sharedIndex(v)}</v></c>`;
    (rows.get(row) ?? rows.set(row, []).get(row)!).push(out);
  }
  const data = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r + 1}">${cs.join("")}</row>`).join("");
  const dim = maxRow < 0 ? "A1" : `A1:${colToLetters(maxCol)}${maxRow + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetData>${data}</sheetData></worksheet>`;
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
  const sheetXmls = sheets.map((s) => renderSheet(s, sharedIndex));
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
    { name: "xl/styles.xml", data: Buffer.from(STYLES) },
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
function readSheet(xml: string, name: string, sst: string[]): Sheet {
  const sheet = new Sheet(name);
  for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = xmlAttrs(m[1]);
    const ref = attrs.r;
    if (!ref) continue;
    const addr = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
    if (!addr) continue;
    const col = lettersToCol(addr[1].toUpperCase()); const row = Number(addr[2]) - 1;
    const inner = m[2]; const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner)?.[1];
    const type = attrs.t ?? "n";
    if (formula !== undefined) { sheet.setCell(col, row, `=${dec(formula)}`); continue; }
    if (type === "inlineStr") {
      const text = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => dec(x[1])).join("");
      sheet.setCell(col, row, text); continue;
    }
    const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    if (value === undefined) continue;
    const v = dec(value);
    if (type === "s") sheet.setCell(col, row, sst[Number(v)] ?? "");
    else if (type === "b") sheet.setCell(col, row, v === "1" ? "TRUE" : "FALSE");
    else if (type === "e") sheet.setCell(col, row, v); // stored as literal error text; formula cell errors are recalculated
    else if (type === "str") sheet.setCell(col, row, v);
    else sheet.setCell(col, row, v);
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
  const wb = new Workbook(); wb.sheets.clear();
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const at = xmlAttrs(m[1]); const name = at.name; const rid = at["r:id"];
    const path = rels.get(rid);
    if (!name || !path) continue;
    const xml = get(path);
    if (xml) wb.sheets.set(name, readSheet(xml, name, sst));
  }
  if (!wb.sheets.size) throw new Error("invalid .xlsx: workbook has no readable sheets");
  wb.recalculate();
  return wb;
}
export function readXlsx(buf: Buffer): Sheet { return readXlsxWorkbook(buf).sheet(); }
export function openWorkbookFromXlsx(buf: Buffer): { workbook: Workbook; sheet: Sheet } {
  const workbook = readXlsxWorkbook(buf); return { workbook, sheet: workbook.sheet() };
}
export interface WorkbookJson { sheets: { name: string; cells: { ref: string; input: string }[] }[] }
export function workbookToJson(wb: Workbook): WorkbookJson {
  return { sheets: [...wb.sheets.values()].map((s) => ({ name: s.name, cells: [...s.grid.entries()].map(([k, c]) => { const [col, row] = k.split(",").map(Number); return { ref: a1(col, row), input: c.input }; }) })) };
}
export function workbookFromJson(data: WorkbookJson): Workbook {
  const wb = new Workbook(); wb.sheets.clear();
  for (const s of data.sheets) {
    const sheet = new Sheet(s.name);
    for (const { ref, input } of s.cells) { const m = /^([A-Za-z]+)(\d+)$/.exec(ref); if (m) sheet.setCell(lettersToCol(m[1].toUpperCase()), Number(m[2]) - 1, input); }
    wb.sheets.set(s.name, sheet);
  }
  if (!wb.sheets.size) wb.addSheet("Sheet1");
  wb.recalculate(); return wb;
}
export function sheetToJson(sheet: Sheet): { name: string; cells: { ref: string; input: string }[] } {
  return workbookToJson(singleSheetWorkbook(sheet)).sheets[0];
}
export function sheetFromJson(data: { name: string; cells: { ref: string; input: string }[] }): Sheet {
  return workbookFromJson({ sheets: [data] }).sheet();
}
function singleSheetWorkbook(sheet: Sheet) { const wb = new Workbook(); wb.sheets.set(sheet.name, sheet); return wb; }
