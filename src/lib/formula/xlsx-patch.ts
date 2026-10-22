/**
 * Lossless .xlsx save (TT46). Instead of regenerating a package (which drops
 * charts, comments, conditional formats, pivot tables, drawings, themes, print
 * setup, custom XML…), the ORIGINAL package is kept and only what the user
 * changed is rewritten:
 *
 *   • untouched parts are copied byte-for-byte;
 *   • in each edited worksheet only <sheetData> (+ <dimension>, and <cols>,
 *     <mergeCells>, <dataValidations>, frozen <pane> when those changed) is
 *     rebuilt — every other child (conditionalFormatting, hyperlinks, drawing,
 *     legacyDrawing, tableParts, pageSetup, extLst…) stays verbatim;
 *   • unchanged cells keep their original <c> element (shared-string index,
 *     style index, attributes); only a stale cached <v> is refreshed;
 *   • changed cells get a style DERIVED from their original xf (font/fill/
 *     border/alignment are cloned and only the edited property is replaced, so
 *     theme colours, font names and sizes survive);
 *   • new strings are written inline (t="inlineStr"), so sharedStrings.xml is
 *     never renumbered;
 *   • shared-formula groups touched by an edit are expanded to explicit
 *     formulas so no child points at a rewritten master;
 *   • calcChain.xml is dropped (Excel rebuilds it) and fullCalcOnLoad is set
 *     when cells changed, so no stale value is ever trusted by a consumer.
 *
 * Sheet add / rename / delete / reorder are applied to workbook.xml, its rels,
 * [Content_Types].xml and definedNames.
 */
import { openZip, writeZip } from "../office/zipkit";
import { patchCharts, chartKey, type ChartPatchIO, type ChartPatchReport } from "./xlsx-chartpatch";
import { parseXml, serializeXml, attr, setAttr, kids, kid, el, textNode, clone, textOf, type XEl, type XDoc, type XNode } from "../office/xmltree";
import { Workbook, a1, type Sheet, type CellStyle, type Cell } from "./engine";
import { colToLetters, lettersToCol, isError } from "./types";
import { readXlsxWorkbook, workbookToJson, workbookFromJson, colorContext, xlsxInternals as X } from "./xlsx";
import { rangeRef } from "./sheetlayout";
import type { CondRule } from "./sheetmeta";
import { addFuturePrefixes } from "./sheetops";
import { linksXml, REL_HYPERLINK } from "./sheetlinks";
import { PIVOT_NAME_RE, pivotNames } from "./pivotsheet";


const ln = (n: string) => n.slice(n.indexOf(":") + 1);
const pre0 = (n: string) => (n.includes(":") ? n.slice(0, n.indexOf(":") + 1) : "");
const kidsL = (e: XEl | undefined, name: string) => kids(e).filter((k) => ln(k.name) === name);
const kidL = (e: XEl | undefined, name: string) => kidsL(e, name)[0];
const REL_WS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const CT_WS = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const stable = (v: unknown): string => v && typeof v === "object" ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== false).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const normStyle = (s?: CellStyle) => { const o = { ...(s ?? {}) } as Record<string, unknown>; if (o.numFmt === "General") delete o.numFmt; if (o.border && !Object.keys(o.border as object).length) delete o.border; return stable(o); };
const pick = (s: CellStyle | undefined, keys: (keyof CellStyle)[]) => stable(Object.fromEntries(keys.map((k) => [k, s?.[k]])));

function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
  return parts.join("/");
}
const relsPathOf = (part: string) => { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };

/** Appends styles derived from an original xf; keeps everything else in styles.xml verbatim. */
class StylePatcher {
  doc: XDoc; root: XEl; p: string; changed = false;
  private cache = new Map<string, number>();
  private readStyle: (i: number) => CellStyle | undefined;
  constructor(xml: string | null, readStyle: (i: number) => CellStyle | undefined) {
    this.readStyle = readStyle;
    this.doc = parseXml(xml ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`);
    this.root = this.doc.root; const n = this.root.name; this.p = n.includes(":") ? n.slice(0, n.indexOf(":") + 1) : "";
    if (!xml) this.changed = true;
  }
  private section(name: string, before: string[]): XEl {
    let s = kidL(this.root, name);
    if (!s) {
      s = el(this.p + name, { count: "0" });
      const idx = this.root.kids.findIndex((k) => k.k === "el" && before.includes(ln(k.name)));
      if (idx < 0) this.root.kids.push(s); else this.root.kids.splice(idx, 0, s);
    }
    return s;
  }
  private append(sectionName: string, item: XEl, before: string[]): number {
    const s = this.section(sectionName, before);
    const list = kids(s); s.kids.push(item); s.selfClose = false;
    setAttr(s, "count", String(list.length + 1)); this.changed = true; return list.length;
  }
  private numFmtId(code: string): number {
    const builtin = X.BUILTIN_BY_CODE.get(code); if (builtin !== undefined) return builtin;
    const nf = kidL(this.root, "numFmts"); let max = 163;
    for (const f of kidsL(nf, "numFmt")) { if (attr(f, "formatCode") === code) return Number(attr(f, "numFmtId")); max = Math.max(max, Number(attr(f, "numFmtId")) || 0); }
    const id = max + 1;
    this.append("numFmts", el(this.p + "numFmt", { numFmtId: String(id), formatCode: code }), ["fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"]);
    return id;
  }
  /** Append a differential format (TT47, conditional formats) → its dxfId. */
  dxf(xml: string): number {
    const key = `dxf|${xml}`; const hit = this.cache.get(key); if (hit !== undefined) return hit;
    const node = parseXml(xml.replace(/^<dxf>/, `<dxf xmlns="${NS_MAIN}">`)).root;
    const strip = (e: XEl) => { e.attrs = e.attrs.filter(([k]) => k !== "xmlns"); e.quote = e.quote.slice(-e.attrs.length); e.name = this.p + ln(e.name); kids(e).forEach(strip); };
    strip(node);
    const i = this.append("dxfs", node, ["tableStyles", "colors", "extLst"]); this.cache.set(key, i); return i;
  }
  /** Index of an xf that looks like `origIdx` with the properties of `want`. */
  derive(origIdx: number, want: CellStyle | undefined): number {
    const have = this.readStyle(origIdx);
    if (normStyle(have) === normStyle(want)) return origIdx;
    const key = `${origIdx}|${normStyle(want)}`; const hit = this.cache.get(key); if (hit !== undefined) return hit;
    const cellXfs = this.section("cellXfs", ["cellStyles", "dxfs", "tableStyles", "colors", "extLst"]);
    const xfs = kids(cellXfs);
    const xf = clone(xfs[origIdx] ?? xfs[0] ?? el(this.p + "xf", { numFmtId: "0", fontId: "0", fillId: "0", borderId: "0", xfId: "0" }));
    const P = this.p;
    if (pick(have, ["bold", "italic", "underline", "color"]) !== pick(want, ["bold", "italic", "underline", "color"])) {
      const fonts = kids(kidL(this.root, "fonts"));
      const font = clone(fonts[Number(attr(xf, "fontId") ?? 0)] ?? el(P + "font", {}, [el(P + "sz", { val: "11" }), el(P + "name", { val: "Calibri" })]));
      const toggle = (tag: string, on: boolean | undefined, attrs: Record<string, string> = {}) => {
        font.kids = font.kids.filter((k) => !(k.k === "el" && ln(k.name) === tag));
        if (on) font.kids.unshift(el(P + tag, attrs));
      };
      toggle("b", want?.bold); toggle("i", want?.italic); toggle("u", want?.underline);
      if (pick(have, ["color"]) !== pick(want, ["color"])) {
        font.kids = font.kids.filter((k) => !(k.k === "el" && ln(k.name) === "color"));
        if (want?.color) { const nameAt = font.kids.findIndex((k) => k.k === "el" && ln(k.name) === "name"); font.kids.splice(nameAt < 0 ? font.kids.length : nameAt, 0, el(P + "color", { rgb: X.argb(want.color) })); }
      }
      font.selfClose = false;
      setAttr(xf, "fontId", String(this.append("fonts", font, ["fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"]))); setAttr(xf, "applyFont", "1");
    }
    if (pick(have, ["fill"]) !== pick(want, ["fill"])) {
      const fill = want?.fill
        ? el(P + "fill", {}, [el(P + "patternFill", { patternType: "solid" }, [el(P + "fgColor", { rgb: X.argb(want.fill) }), el(P + "bgColor", { indexed: "64" })])])
        : null;
      setAttr(xf, "fillId", fill ? String(this.append("fills", fill, ["borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"])) : "0"); setAttr(xf, "applyFill", "1");
    }
    if (pick(have, ["border"]) !== pick(want, ["border"])) {
      const b = want?.border;
      const border = b && Object.keys(b).length
        ? el(P + "border", {}, [...(["left", "right", "top", "bottom"] as const).map((k) => b[k] ? el(P + k, { style: b[k]!.style }, [el(P + "color", { rgb: X.argb(b[k]!.color ?? "#000000") })]) : el(P + k)), el(P + "diagonal")])
        : null;
      setAttr(xf, "borderId", border ? String(this.append("borders", border, ["cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"])) : "0"); setAttr(xf, "applyBorder", "1");
    }
    if (pick(have, ["numFmt"]) !== pick(want, ["numFmt"])) {
      const code = want?.numFmt; setAttr(xf, "numFmtId", String(code && code !== "General" ? this.numFmtId(code) : 0)); setAttr(xf, "applyNumberFormat", "1");
    }
    if (pick(have, ["align", "valign", "wrap"]) !== pick(want, ["align", "valign", "wrap"])) {
      let al = kidL(xf, "alignment");
      if (!al) { al = el(P + "alignment"); xf.kids.unshift(al); xf.selfClose = false; }
      setAttr(al, "horizontal", want?.align); setAttr(al, "vertical", want?.valign); setAttr(al, "wrapText", want?.wrap ? "1" : undefined);
      setAttr(xf, "applyAlignment", "1");
    }
    const idx = this.append("cellXfs", xf, ["cellStyles", "dxfs", "tableStyles", "colors", "extLst"]);
    this.cache.set(key, idx); return idx;
  }
}

interface PatchReport { sheetsPatched: string[]; sheetsAdded: string[]; sheetsRemoved: string[]; sheetsRenamed: [string, string][]; cellsRewritten: number; cellsReused: number; partsCopied: number; partsRewritten: string[]; charts?: ChartPatchReport }

/**
 * The baseline an edit is measured against: the original exactly as the Spreadsheet UI loaded it
 * (reader → workbook JSON → workbook). Anything the UI normalised on load is "unchanged".
 */
export function loadedBaseline(original: Uint8Array): Workbook {
  const w = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(readXlsxWorkbook(Buffer.from(original))))));
  w.recalculate(); return w;
}
/** Value of a cell as the engine sees it (incl. spill children). */
function valueAt(wb: Workbook, sheet: Sheet, col: number, row: number, cell?: Cell) {
  return cell && cell.input !== "" ? cell.value : wb.valueAt(sheet.name, col, row);
}
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a));
  if (isError(a as never) && isError(b as never)) return (a as { error: string }).error === (b as { error: string }).error;
  return (a === undefined || a === "") && (b === undefined || b === "");
}
function cachedEquals(c: XEl, v: unknown): boolean {
  const t = attr(c, "t") ?? "n"; const vEl = kidL(c, "v"); const raw = vEl ? textOf(vEl) : undefined;
  if (v === undefined || v === "") return raw === undefined || (raw === "" && t === "str");
  if (isError(v as never)) return t === "e";
  if (typeof v === "boolean") return t === "b" && raw === (v ? "1" : "0");
  if (typeof v === "number") return t === "n" && raw !== undefined && Number(raw) === v;
  if (typeof v === "string") return (t === "str" || t === "inlineStr") && (raw ?? textOf(kidL(c, "is") ?? el("x"))) === v;
  return false;
}
function setCached(c: XEl, v: unknown, P: string) {
  c.kids = c.kids.filter((k) => !(k.k === "el" && (ln(k.name) === "v" || ln(k.name) === "is")));
  setAttr(c, "t", undefined);
  if (v === undefined || v === "") { setAttr(c, "t", kidL(c, "f") ? "str" : undefined); if (kidL(c, "f")) c.kids.push(el(P + "v")); }
  else if (isError(v as never)) { const code = (v as { error: string }).error; setAttr(c, "t", "e"); c.kids.push(el(P + "v", {}, [textNode(code === "#CIRCULAR!" || code === "#SPILL!" || code === "#CALC!" ? "#VALUE!" : code)])); }
  else if (typeof v === "boolean") { setAttr(c, "t", "b"); c.kids.push(el(P + "v", {}, [textNode(v ? "1" : "0")])); }
  else if (typeof v === "number") c.kids.push(el(P + "v", {}, [textNode(String(v))]));
  else if (kidL(c, "f")) { setAttr(c, "t", "str"); c.kids.push(el(P + "v", {}, [textNode(String(v))])); }
  else { setAttr(c, "t", "inlineStr"); const t = el(P + "t", {}, [textNode(String(v))]); if (/^\s|\s$/.test(String(v))) setAttr(t, "xml:space", "preserve"); c.kids.push(el(P + "is", {}, [t])); }
  c.selfClose = c.kids.length === 0;
}

/**
 * `renames` maps CURRENT sheet name → name in the original file for sheets the user renamed
 * (the UI tracks this). Sheets that match neither by name nor by hint are treated as new, and
 * original sheets nobody claims are removed — never guessed by position.
 */
export async function patchXlsx(original: Uint8Array, workbook: Workbook, renames: Record<string, string> = {}, base?: Workbook): Promise<{ bytes: Uint8Array; report: PatchReport }> {
  const zip = openZip(original);
  // stale hints (e.g. a rename that was undone) must not hide a sheet that kept its original name
  renames = Object.fromEntries(Object.entries(renames).filter(([cur, was]) => workbook.sheets.has(cur) && cur !== was));
  // Readers disagree on which of two same-named entries wins (zipfile: last; others: first) — refuse rather than guess.
  { const seen = new Set<string>(); for (const e of zip.entries) { if (seen.has(e.name)) throw new Error(`ambiguous package: duplicate zip entry ${e.name}`); seen.add(e.name); } }
  // TT62 (found by the XSD gate on POI 123233_charts.xlsx, which stores Sheet1.xml with _rels/sheet1.xml.rels): OPC part
  // names are compared case-insensitively (ECMA-376 Part 2 §6.2.2.3), so every lookup of an EXISTING part goes through the
  // stored spelling, and new parts never collide with an existing name in another case.
  const storedName = new Map(zip.entries.map((e) => [e.name.toLowerCase(), e.name] as const));
  const realName = (p: string) => zip.has(p) ? p : storedName.get(p.toLowerCase()) ?? p; // exact spelling wins (a package can hold both)
  // `base` lets a caller that already parsed the original skip a second parse (it must be untouched).
  const orig = base ?? loadedBaseline(original);
  workbook.recalculate();
  const report: PatchReport = { sheetsPatched: [], sheetsAdded: [], sheetsRemoved: [], sheetsRenamed: [], cellsRewritten: 0, cellsReused: 0, partsCopied: 0, partsRewritten: [] };
  const out = new Map<string, Uint8Array | string>();
  const removed = new Set<string>();

  // --- package map
  const rootRels = parseXml((await zip.readText("_rels/.rels")) ?? "");
  const wbRel = kids(rootRels.root).find((r) => /officeDocument$/.test(attr(r, "Type") ?? ""));
  const wbPart = realName(resolve("", attr(wbRel, "Target") ?? "xl/workbook.xml"));
  const wbDoc = parseXml((await zip.readText(wbPart))!);
  const wbRelsPath = realName(relsPathOf(wbPart));
  const relsDoc = parseXml((await zip.readText(wbRelsPath)) ?? `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  const ctDoc = parseXml((await zip.readText("[Content_Types].xml"))!);
  const P = wbDoc.root.name.includes(":") ? wbDoc.root.name.slice(0, wbDoc.root.name.indexOf(":") + 1) : "";
  const sheetsEl = kidL(wbDoc.root, "sheets")!;
  const relById = new Map(kids(relsDoc.root).map((r) => [attr(r, "Id")!, r]));
  const rAttr = (s: XEl) => s.attrs.find(([k]) => ln(k) === "id" && k.includes(":"))?.[1];
  const allSheets = kidsL(sheetsEl, "sheet").map((s, index) => { const rel = relById.get(rAttr(s) ?? ""); return { el: s, index, name: attr(s, "name")!, part: realName(resolve(wbPart, attr(rel, "Target") ?? "")), isWs: /\/worksheet$/.test(attr(rel, "Type") ?? "") }; });
  const modelled = (s: { name: string; isWs: boolean }) => s.isWs && [...orig.sheets.keys()].some((n) => n.toLowerCase() === s.name.toLowerCase());
  const origSheets = allSheets.filter(modelled);
  const pinned = allSheets.filter((s) => !modelled(s)); // kept verbatim at their original position

  // --- styles
  const stylesRel = kids(relsDoc.root).find((r) => /\/styles$/.test(attr(r, "Type") ?? ""));
  const stylesPart = realName(stylesRel ? resolve(wbPart, attr(stylesRel, "Target")!) : "xl/styles.xml");
  const stylesXml = await zip.readText(stylesPart);
  // same colour context as the reader, or every theme-coloured cell would look "changed"
  const themeRel = kids(relsDoc.root).find((r) => /\/theme$/.test(attr(r, "Type") ?? ""));
  const themeXml = themeRel ? await zip.readText(realName(resolve(wbPart, attr(themeRel, "Target")!))) : null;
  const readStyles = X.readStyles(stylesXml, colorContext(stylesXml, themeXml));
  const styles = new StylePatcher(stylesXml, (i) => readStyles[i]);

  // --- sheet identity: same position+name, or same name, = same sheet (rename detected by position when counts match)
  // model sheets standing for a pinned chartsheet/dialogsheet are that sheet — not a new worksheet
  const pinnedNames = new Set(pinned.map((p) => p.name.toLowerCase()));
  const newSheets = [...workbook.sheets.values()].filter((s) => !pinnedNames.has((renames[s.name] ?? s.name).toLowerCase()));
  const origByName = new Map(origSheets.map((s) => [s.name.toLowerCase(), s]));
  const used = new Set<string>();
  const mapping = newSheets.map((s, i) => {
    const hint = renames[s.name];
    let o = hint !== undefined ? origByName.get(hint.toLowerCase()) : origByName.get(s.name.toLowerCase());
    if (o && hint === undefined && Object.values(renames).some((v) => v.toLowerCase() === o!.name.toLowerCase())) o = undefined; // that original was renamed to something else
    void i;
    if (o && used.has(o.part)) o = undefined;
    if (o) used.add(o.part);
    return { sheet: s, orig: o };
  });
  let anyCellChange = false;
  // TT58: a PivotTable added / edited / deleted changes the hidden definition names even when no cell value changed
  const pivKey = (w: Workbook) => JSON.stringify([...w.sheets.values()].map((sh) => [sh.name, sh.pivots]));
  // TT47: a sheet's modelled conditional formats, compared without sheet name / provenance
  const cfOf = (w: Workbook, name: string) => w.condFormats.filter((r) => r.sheet.toLowerCase() === name.toLowerCase()).map(({ sheet: _s, src: _p, ...r }) => JSON.stringify(r, Object.keys(r).sort())); // flat object: sorted keys = order-independent
  {
    // Nothing the user can change differs from what was loaded → the original bytes ARE the save.
    const eqJ = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const same = mapping.length === origSheets.length && mapping.every((m, i) => {
      const o = m.orig && orig.sheets.get(m.orig.name);
      if (!o || m.orig !== origSheets[i] || m.sheet.name !== m.orig!.name || m.sheet.grid.size !== o.grid.size) return false;
      for (const [k, c] of m.sheet.grid) { const d = o.grid.get(k); if (!d || d.input !== c.input || normStyle(d.style) !== normStyle(c.style)) return false; }
      return eqJ(workbook.charts.filter((c) => c.sheet === m.sheet.name).map(chartKey), orig.charts.filter((c) => c.sheet === o.name).map(chartKey)) && eqJ(cfOf(workbook, m.sheet.name), cfOf(orig, o.name)) && eqJ(m.sheet.links, o.links) && eqJ(m.sheet.merges, o.merges) && eqJ(m.sheet.validations, o.validations) && eqJ(m.sheet.colWidths, o.colWidths) && m.sheet.freezeRows === o.freezeRows && m.sheet.freezeCols === o.freezeCols;
    });
    // charts on pinned chartsheets are not covered by the per-sheet comparison above
    const pinnedCharts = (w: Workbook) => w.charts.filter((c) => pinnedNames.has(c.sheet.toLowerCase())).map((c) => c.sheet.toLowerCase() + chartKey(c));
    // TT61 fix: pivot definitions count too — deleting a pivot whose output cells were already gone changes no cell, and the
    // shortcut used to hand back the original bytes, so the hidden definition names (and the pivot) came back on reopen
    if (same && eqJ(pinnedCharts(workbook), pinnedCharts(orig)) && pivKey(orig) === pivKey(workbook)) return { bytes: original, report };
  }

  for (const { sheet, orig: o } of mapping) {
    const origSheet = o ? orig.sheets.get(o.name) ?? [...orig.sheets.values()].find((x) => x.name.toLowerCase() === o.name.toLowerCase()) : undefined;
    const partXml = o ? (await zip.readText(o.part)) : null;
    const doc = parseXml(partXml ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><dimension ref="A1"/><sheetData/></worksheet>`);
    const SP = doc.root.name.includes(":") ? doc.root.name.slice(0, doc.root.name.indexOf(":") + 1) : "";
    let sd = kidL(doc.root, "sheetData");
    if (!sd) { sd = el(SP + "sheetData"); doc.root.kids.push(sd); }
    // original cells + rows
    const origRows = new Map<number, XEl>(); const origCells = new Map<string, XEl>(); const sharedTouched = new Set<string>();
    let rowCursor = 0;
    for (const r of kidsL(sd, "row")) {
      const rn = Number(attr(r, "r")) || rowCursor + 1; rowCursor = rn; origRows.set(rn - 1, r);
      let colCursor = -1;
      for (const c of kidsL(r, "c")) {
        const ref = attr(c, "r"); let col: number;
        const m = ref ? /^\$?([A-Za-z]+)/.exec(ref) : null;
        col = m ? lettersToCol(m[1].toUpperCase()) : colCursor + 1;
        colCursor = col; origCells.set(`${col},${rn - 1}`, c);
      }
    }
    const isShared = (c?: XEl) => attr(kidL(c, "f"), "t") === "shared";
    // positions: model cells, spill children, original-only cells (e.g. styled blanks the reader skipped)
    const positions = new Set<string>(sheet.grid.keys());
    // spill children are written only when their anchor formula is being regenerated (or the file already had the cell)
    const spillAnchor = new Map<string, string>();
    for (const [fq, claim] of workbook.spillOwner) { const b = fq.lastIndexOf("!"); if (fq.slice(0, b) === sheet.name) spillAnchor.set(fq.slice(b + 1), `${claim.anchorCol},${claim.anchorRow}`); }
    for (const k of origCells.keys()) if (!origSheet?.grid.has(k)) positions.add(k);
    // A cell changes when its input or style differs from what was read.
    const changedKey = (k: string) => {
      const a = sheet.grid.get(k), b = origSheet?.grid.get(k);
      return (a?.input ?? "") !== (b?.input ?? "") || normStyle(a?.style) !== normStyle(b?.style);
    };
    for (const [k, anchor] of spillAnchor) if (origCells.has(k) || changedKey(anchor)) positions.add(k);
    for (const k of positions) { const c = origCells.get(k); if (isShared(c) && changedKey(k)) sharedTouched.add(attr(kidL(c!, "f"), "si") ?? ""); }

    const colOf = new Map<XEl, number>();
    const rows = new Map<number, XEl[]>(); let rewritten = 0, reused = 0, maxCol = -1, maxRow = -1, minCol = Infinity, minRow = Infinity;
    for (const k of positions) {
      const [col, row] = k.split(",").map(Number);
      const cell = sheet.grid.get(k); const oc = origCells.get(k);
      const v = valueAt(workbook, sheet, col, row, cell);
      const inModel = !!cell || spillAnchor.has(k);
      let c: XEl | null = null;
      const keep = oc && !changedKey(k) && !(isShared(oc) && sharedTouched.has(attr(kidL(oc, "f"), "si") ?? "")) && (inModel || !origSheet?.grid.has(k));
      if (keep) {
        c = oc!;
        // Excel's cached result is authoritative; refresh it only when THIS edit moved the result
        // (engine value before the edit ≠ engine value after it), never because our engine disagrees with Excel.
        const before = origSheet ? valueAt(orig, origSheet, col, row, origSheet.grid.get(k)) : undefined;
        if (kidL(c, "f") && !sameValue(before, v) && !cachedEquals(c, v)) { c = clone(c); setCached(c, v, SP); rewritten++; anyCellChange = true; }
        else reused++;
      } else if (inModel && oc && cell && (origSheet?.grid.get(k)?.input ?? "") === cell.input && !(isShared(oc) && sharedTouched.has(attr(kidL(oc, "f"), "si") ?? ""))) {
        // style-only edit: keep the original <c> (formula text, external-link indices, cached value) and swap its xf
        const s = styles.derive(Number(attr(oc, "s") ?? 0), cell.style);
        c = clone(oc); setAttr(c, "s", s ? String(s) : undefined);
        rewritten++; anyCellChange = true;
      } else if (inModel) {
        const s = styles.derive(Number(attr(oc, "s") ?? 0), cell?.style);
        c = el(SP + "c", { r: a1(col, row), s: s ? String(s) : undefined });
        if (cell && cell.input !== "" && cell.formula) {
          const sp = cell.spill;
          const f = el(SP + "f", sp && (sp.rows > 1 || sp.cols > 1) ? { t: "array", ref: `${a1(col, row)}:${a1(col + sp.cols - 1, row + sp.rows - 1)}` } : {}, [textNode(addFuturePrefixes(cell.input.slice(1)))]);
          c.kids.push(f);
        }
        if (v !== undefined && !(v === "" && !c.kids.length)) setCached(c, v, SP);
        else c.selfClose = true;
        if (!s && c.selfClose && !kidL(c, "f")) c = null; // nothing to store
        rewritten++; anyCellChange = true;
      } else { anyCellChange = true; rewritten++; } // deleted by the user
      if (!c) continue;
      colOf.set(c, col);
      (rows.get(row) ?? rows.set(row, []).get(row)!).push(c);
      maxCol = Math.max(maxCol, col); maxRow = Math.max(maxRow, row); minCol = Math.min(minCol, col); minRow = Math.min(minRow, row);
    }
    const rowNums = new Set<number>([...rows.keys()]);
    for (const rn of origRows.keys()) rowNums.add(rn); // every original row shell is kept (heights, hidden, styles, empty rows)
    const newRows: XEl[] = [];
    for (const rn of [...rowNums].sort((a, b) => a - b)) {
      const cs = (rows.get(rn) ?? []).sort((a, b) => colOf.get(a)! - colOf.get(b)!);
      const shell = origRows.get(rn);
      const r = shell ? { ...clone(shell), kids: [] as XNode[] } : el(SP + "row", { r: String(rn + 1) });
      setAttr(r, "r", String(rn + 1));
      const origKids = shell ? kidsL(shell, "c") : [];
      if (origKids.length !== cs.length || origKids.some((c, i) => c !== cs[i])) setAttr(r, "spans", undefined);
      // keep the original inter-element whitespace style if the row was untouched
      if (shell && origKids.length === cs.length && origKids.every((c, i) => c === cs[i])) r.kids = shell.kids;
      else r.kids = cs;
      r.selfClose = r.kids.length === 0;
      newRows.push(r);
    }
    const origRowList = [...origRows.values()];
    const unchangedData = !!o && newRows.length === origRowList.length && newRows.every((r, i) => r.kids === origRowList[i].kids);
    // structural extras
    const extrasChanged: string[] = [];
    const eqJ = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const replaceChild = (name: string, node: XEl | null, after: string[]) => {
      const i = doc.root.kids.findIndex((k) => k.k === "el" && ln(k.name) === name);
      if (i >= 0) { if (node) doc.root.kids[i] = node; else doc.root.kids.splice(i, 1); return; }
      if (!node) return;
      let at = -1; doc.root.kids.forEach((k, j) => { if (k.k === "el" && after.includes(ln(k.name))) at = j; });
      doc.root.kids.splice(at + 1, 0, node);
    };
    if (!origSheet || !eqJ(sheet.merges, origSheet.merges)) {
      extrasChanged.push("mergeCells");
      replaceChild("mergeCells", sheet.merges.length ? el(SP + "mergeCells", { count: String(sheet.merges.length) }, sheet.merges.map((m) => el(SP + "mergeCell", { ref: rangeRef(m) }))) : null, ["sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews"]);
    }
    if (!origSheet || !eqJ(sheet.validations, origSheet.validations)) {
      extrasChanged.push("dataValidations");
      const dv = sheet.validations.length ? parseXml(`<dataValidations xmlns="${NS_MAIN}" count="${sheet.validations.length}">${sheet.validations.map(X.dvXml).join("")}</dataValidations>`).root : null;
      if (dv) { dv.attrs = dv.attrs.filter(([k]) => k !== "xmlns"); dv.quote = dv.quote.slice(-dv.attrs.length); if (SP) { const pre = (e: XEl) => { e.name = SP + e.name; kids(e).forEach(pre); }; pre(dv); } }
      replaceChild("dataValidations", dv, ["sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting"]);
    }
    if (!origSheet || !eqJ(sheet.colWidths, origSheet.colWidths)) {
      extrasChanged.push("cols");
      const prev = kidL(doc.root, "cols"); const prevCols = kidsL(prev, "col");
      const widths = Object.entries(sheet.colWidths).map(([c, px]) => [Number(c), px] as const).filter(([c]) => c >= 0 && c <= 16383).sort((a, b) => a[0] - b[0]);
      const cols: XEl[] = [];
      // keep original <col> attributes (style, hidden, outline) for columns the user did not resize
      for (const pc of prevCols) {
        const min = Number(attr(pc, "min")), max = Number(attr(pc, "max"));
        for (let cc = min; cc <= max && cc - min < 16384; cc++) {
          if (sheet.colWidths[cc - 1] !== undefined && sheet.colWidths[cc - 1] !== origSheet?.colWidths[cc - 1]) continue;
          if (min === max || sheet.colWidths[cc - 1] === origSheet?.colWidths[cc - 1]) { if (cc === min) cols.push(pc); break; }
        }
      }
      for (const [cc, px] of widths) if (px !== origSheet?.colWidths[cc] || !prevCols.length) {
        const ix = cols.findIndex((x) => Number(attr(x, "min")) <= cc + 1 && Number(attr(x, "max")) >= cc + 1); if (ix >= 0) cols.splice(ix, 1);
        cols.push(el(SP + "col", { min: String(cc + 1), max: String(cc + 1), width: String(X.pxToWidth(px)), customWidth: "1" }));
      }
      cols.sort((a, b) => Number(attr(a, "min")) - Number(attr(b, "min")));
      replaceChild("cols", cols.length ? el(SP + "cols", {}, cols) : null, ["sheetPr", "dimension", "sheetViews", "sheetFormatPr"]);
    }
    {
      // TT47 conditional formats: replace only the cfRules the reader modelled (provenance src) that changed;
      // icon sets, data bars, formula rules, x14 extLst rules and untouched modelled rules stay verbatim.
      const before = o ? orig.condFormats.filter((r) => r.sheet.toLowerCase() === o.name.toLowerCase()) : [];
      const after = workbook.condFormats.filter((r) => r.sheet.toLowerCase() === sheet.name.toLowerCase());
      const key = ({ sheet: _s, src: _p, ...r }: CondRule) => JSON.stringify(r, Object.keys(r).sort());
      if (!eqJ(before.map(key), after.map(key))) {
        extrasChanged.push("conditionalFormatting");
        const afterKeys = new Set(after.map(key)); const kept = new Set<string>(); const remove = new Set<string>();
        const bySrc = new Map<string, CondRule[]>(); for (const r of before) if (r.src) bySrc.set(r.src, [...(bySrc.get(r.src) ?? []), r]);
        for (const [src, rs] of bySrc) { if (rs.every((r) => afterKeys.has(key(r)))) rs.forEach((r) => kept.add(key(r))); else remove.add(src); }
        const cfEls = doc.root.kids.filter((k): k is XEl => k.k === "el" && k.name === SP + "conditionalFormatting");
        cfEls.forEach((cf, i) => { let j = -1; cf.kids = cf.kids.filter((k) => { if (!(k.k === "el" && ln(k.name) === "cfRule")) return true; j++; return !remove.has(`${i}.${j}`); }); });
        doc.root.kids = doc.root.kids.filter((k) => !(k.k === "el" && cfEls.includes(k as XEl) && !kidsL(k as XEl, "cfRule").length));
        // TT49: a removed rule takes its linked x14 extension rule with it (else Excel keeps drawing the bar), and an
        // x14-only rule ("x<n>" = n-th x14:cfRule in document order, as the reader counts them) is removed in place
        const x14Ids = new Set<string>(); const x14Idx = new Set<number>();
        for (const src of remove) { if (/^x\d+$/.test(src)) x14Idx.add(Number(src.slice(1))); for (const r of bySrc.get(src) ?? []) if (r.x14) x14Ids.add(r.x14); }
        if (x14Ids.size || x14Idx.size) {
          let xi = -1;
          for (const lst of kids(doc.root).filter((k) => ln(k.name) === "extLst")) {
            for (const ex of kids(lst)) for (const cfs of kids(ex, "x14:conditionalFormattings")) {
              for (const cfx of kids(cfs, "x14:conditionalFormatting")) cfx.kids = cfx.kids.filter((k) => { if (!(k.k === "el" && k.name === "x14:cfRule")) return true; xi++; return !(x14Idx.has(xi) || x14Ids.has(attr(k, "id") ?? "")); });
              cfs.kids = cfs.kids.filter((k) => !(k.k === "el" && k.name === "x14:conditionalFormatting" && !kids(k, "x14:cfRule").length));
            }
            for (const ex of kids(lst)) ex.kids = ex.kids.filter((k) => !(k.k === "el" && k.name === "x14:conditionalFormattings" && !kids(k).length));
            lst.kids = lst.kids.filter((k) => !(k.k === "el" && ln(k.name) === "ext" && !kids(k).length));
          }
          doc.root.kids = doc.root.kids.filter((k) => !(k.k === "el" && ln(k.name) === "extLst" && !kids(k).length));
        }
        let pr = 0; const walk = (e: XEl) => { if (ln(e.name) === "cfRule") pr = Math.max(pr, Number(attr(e, "priority")) || 0); kids(e).forEach(walk); }; walk(doc.root);
        const added: XEl[] = [];
        for (const r of after) {
          if (kept.has(key(r)) || !X.cfRuleXml(r, null, 1)) continue; // "" = not representable in the main schema
          const dx = X.cfDxfXml(r);
          const node = parseXml(`<conditionalFormatting xmlns="${NS_MAIN}" sqref="${r.range.replace(/[<&"]/g, "")}">${X.cfRuleXml(r, dx ? styles.dxf(dx) : null, ++pr)}</conditionalFormatting>`).root;
          const strip = (e: XEl) => { e.attrs = e.attrs.filter(([k]) => k !== "xmlns"); e.quote = e.quote.slice(-e.attrs.length); e.name = SP + ln(e.name); kids(e).forEach(strip); };
          strip(node); added.push(node);
        }
        if (added.length) {
          let at = -1; doc.root.kids.forEach((k, j) => { if (k.k === "el" && ["sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting"].includes(ln(k.name))) at = j; });
          doc.root.kids.splice(at + 1, 0, ...added);
        }
      }
    }
    // TT57: hyperlinks — the <hyperlinks> element and the sheet's external hyperlink relationships are rewritten together
    let sheetRels: string | undefined;
    if (origSheet ? !eqJ(sheet.links, origSheet.links) : sheet.links.length > 0) {
      extrasChanged.push("hyperlinks");
      // read the rels part under its stored spelling, write it under the canonical one (case-sensitive readers such as
      // openpyxl look only there) and drop a differently-cased original so the package never holds both
      const relsPath = o ? relsPathOf(o.part) : "", relsOld = o ? realName(relsPath) : "";
      const relsSrc = o ? await zip.readText(relsOld) : null;
      if (o && relsOld !== relsPath && relsSrc !== null) removed.add(relsOld);
      const rd = parseXml(relsSrc ?? `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
      rd.root.kids = rd.root.kids.filter((k) => !(k.k === "el" && attr(k, "Type") === REL_HYPERLINK));
      const ids = new Set(kids(rd.root).map((r) => attr(r, "Id")));
      let n = 0; const nextId = () => { let id: string; do id = `rIdHl${++n}`; while (ids.has(id)); return id; };
      const lx = linksXml(sheet.links, nextId);
      const RP = rd.root.name.replace(/Relationships$/, "");
      for (const r of lx.rels) { const x = parseXml(r).root; x.name = RP + x.name; rd.root.kids.push(x); }
      rd.root.selfClose = rd.root.kids.length === 0;
      if (lx.rels.length || relsSrc !== null) sheetRels = serializeXml(rd);
      let hl: XEl | null = null;
      if (lx.xml) {
        hl = parseXml(`<hyperlinks xmlns="${NS_MAIN}" xmlns:r="${NS_R}">${lx.xml.replace(/^<hyperlinks>|<\/hyperlinks>$/g, "")}</hyperlinks>`).root;
        hl.attrs = []; hl.quote = [];
        // the r: prefix must resolve on the worksheet root
        const rPre = doc.root.attrs.find(([k, v]) => k.startsWith("xmlns:") && v === NS_R)?.[0].slice(6);
        if (!rPre) { doc.root.attrs.push(["xmlns:r", NS_R]); doc.root.quote.push("\""); }
        const pre = (e: XEl) => { e.name = SP + e.name; if (rPre && rPre !== "r") e.attrs = e.attrs.map(([k, v]) => [k === "r:id" ? `${rPre}:id` : k, v]); kids(e).forEach(pre); };
        pre(hl);
      }
      replaceChild("hyperlinks", hl, ["sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations"]);
      if (o && sheetRels !== undefined) { out.set(relsPath, sheetRels); report.partsRewritten.push(relsPath); }
    }
    if (!origSheet || sheet.freezeRows !== origSheet.freezeRows || sheet.freezeCols !== origSheet.freezeCols) {
      extrasChanged.push("pane");
      let views = kidL(doc.root, "sheetViews");
      if (!views) { views = el(SP + "sheetViews", {}, [el(SP + "sheetView", { workbookViewId: "0" })]); replaceChild("sheetViews", views, ["sheetPr", "dimension"]); }
      const view = kidL(views, "sheetView")!;
      view.kids = view.kids.filter((k) => !(k.k === "el" && (ln(k.name) === "pane" || ln(k.name) === "selection")));
      const fr = sheet.freezeRows, fc = sheet.freezeCols;
      if (fr > 0 || fc > 0) {
        const pane = fr > 0 && fc > 0 ? "bottomRight" : fr > 0 ? "bottomLeft" : "topRight";
        view.kids.unshift(el(SP + "pane", { xSplit: fc ? String(fc) : undefined, ySplit: fr ? String(fr) : undefined, topLeftCell: `${colToLetters(fc)}${fr + 1}`, activePane: pane, state: "frozen" }), el(SP + "selection", { pane }));
      }
      view.selfClose = view.kids.length === 0;
    }
    if (o && unchangedData && !extrasChanged.length && sheet.name === o.name) continue; // byte-identical part
    sd.kids = newRows; sd.selfClose = newRows.length === 0;
    const dim = kidL(doc.root, "dimension");
    const dimRef = maxRow < 0 ? "A1" : `${colToLetters(Math.min(minCol, maxCol))}${minRow + 1}:${colToLetters(maxCol)}${maxRow + 1}`;
    if (dim) setAttr(dim, "ref", dimRef);
    report.cellsRewritten += rewritten; report.cellsReused += reused;
    if (o) { out.set(o.part, serializeXml(doc)); report.sheetsPatched.push(sheet.name); report.partsRewritten.push(o.part); if (sheet.name !== o.name) report.sheetsRenamed.push([o.name, sheet.name]); }
    else { const mm = mapping.find((m) => m.sheet === sheet) as { xml?: string; rels?: string }; mm.xml = serializeXml(doc); mm.rels = sheetRels; report.sheetsAdded.push(sheet.name); }
  }

  // --- workbook structure: order, names, additions, removals
  const structural = report.sheetsAdded.length || report.sheetsRenamed.length || origSheets.some((s) => !used.has(s.part)) || mapping.some((m, i) => m.orig !== origSheets[i]) || mapping.length !== origSheets.length;
  const wbChanged = structural || anyCellChange || pivKey(orig) !== pivKey(workbook);
  const newPartOf = new Map<string, string>(); let ctChanged = false;
  if (structural) {
    const usedIds = new Set(kids(relsDoc.root).map((r) => attr(r, "Id")!));
    const usedSheetIds = new Set(origSheets.map((s) => Number(attr(s.el, "sheetId"))));
    const ctTypes = ctDoc.root; const CTP = ctTypes.name.includes(":") ? ctTypes.name.slice(0, ctTypes.name.indexOf(":") + 1) : "";
    const newEls: XEl[] = [];
    let n = 1;
    for (const m of mapping) {
      if (m.orig) { setAttr(m.orig.el, "name", m.sheet.name); newEls.push(m.orig.el); continue; }
      let part: string; do part = `xl/worksheets/sheet${n++}.xml`; while (storedName.has(part.toLowerCase()) || [...out.keys()].some((k) => k.toLowerCase() === part.toLowerCase()));
      let id = 1; while (usedIds.has(`rId${id}`)) id++; usedIds.add(`rId${id}`);
      let sid = 1; while (usedSheetIds.has(sid)) sid++; usedSheetIds.add(sid);
      relsDoc.root.kids.push(el(relsDoc.root.name.replace(/Relationships$/, "Relationship"), { Id: `rId${id}`, Type: REL_WS, Target: part.slice(wbPart.slice(0, wbPart.lastIndexOf("/") + 1).length) }));
      ctTypes.kids.push(el(CTP + "Override", { PartName: `/${part}`, ContentType: CT_WS }));
      const s = el(P + "sheet", { name: m.sheet.name, sheetId: String(sid) }); s.attrs.push([wbDoc.root.attrs.find(([k, v]) => k.startsWith("xmlns:") && v === NS_R)?.[0].slice(6) + ":id" || "r:id", `rId${id}`]); s.quote.push("\"");
      if (!wbDoc.root.attrs.some(([k, v]) => k.startsWith("xmlns:") && v === NS_R)) { wbDoc.root.attrs.push(["xmlns:r", NS_R]); wbDoc.root.quote.push("\""); }
      newEls.push(s); out.set(part, (m as { xml?: string }).xml!); report.partsRewritten.push(part); newPartOf.set(m.sheet.name, part);
      const nr = (m as { rels?: string }).rels; if (nr) { out.set(relsPathOf(part), nr); report.partsRewritten.push(relsPathOf(part)); }
    }
    for (const s of origSheets) if (!used.has(s.part)) {
      report.sheetsRemoved.push(s.name); removed.add(s.part);
      const id = rAttr(s.el); relsDoc.root.kids = relsDoc.root.kids.filter((k) => !(k.k === "el" && attr(k, "Id") === id));
      ctDoc.root.kids = ctDoc.root.kids.filter((k) => !(k.k === "el" && attr(k, "PartName") === `/${s.part}`));
    }
    for (const p of pinned) newEls.splice(Math.min(p.index, newEls.length), 0, p.el);
    const ws = sheetsEl.kids.filter((k) => k.k !== "el"); sheetsEl.kids = newEls.flatMap((e, i) => i && ws[0] ? [ws[0], e] : [e]);
    // definedNames: rename sheet prefixes; drop names that pointed only at a removed sheet
    const quote = (s: string) => /^[A-Za-z_][\w.]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
    const dn = kidL(wbDoc.root, "definedNames");
    for (const d of kidsL(dn, "definedName")) {
      let t = textOf(d);
      for (const [from, to] of report.sheetsRenamed) t = t.split(`${quote(from)}!`).join(`${quote(to)}!`);
      for (const r of report.sheetsRemoved) t = t.split(`${quote(r)}!`).join("#REF!");
      d.kids = [textNode(t)];
      const lsi = attr(d, "localSheetId");
      if (lsi !== undefined) { const was = allSheets[Number(lsi)]?.el; const now = newEls.indexOf(was!); if (now < 0) dn!.kids = dn!.kids.filter((k) => k !== d); else setAttr(d, "localSheetId", String(now)); }
    }
    // activeTab / firstSheet must stay inside the sheet list
    const view = kidL(kidL(wbDoc.root, "bookViews"), "workbookView");
    if (view) for (const a of ["activeTab", "firstSheet"]) if (Number(attr(view, a) ?? 0) >= newEls.length) setAttr(view, a, "0");
  }
  // --- TT50 charts: targeted edits / additions / removals in drawing + chart parts
  {
    const td = new TextDecoder();
    const CTP = pre0(ctDoc.root.name);
    // OPC part names are case-insensitive: map a path to the entry name the package really uses
    const real = (p: string) => out.has(p) ? p : [...out.keys()].find((k) => k.toLowerCase() === p.toLowerCase()) ?? realName(p);
    const io: ChartPatchIO = {
      read: async (p0) => { const p = real(p0); if (removed.has(p)) return null; const o = out.get(p); if (o !== undefined) return typeof o === "string" ? o : td.decode(o); return zip.readText(p); },
      exists: (p0) => { const p = real(p0); return !removed.has(p) && (out.has(p) || zip.has(p)); },
      write: (p0, x) => { const p = real(p0); out.set(p, x); removed.delete(p); },
      remove: (p0) => { const p = real(p0); out.delete(p); removed.add(p); },
      override: (p, ct) => {
        ctDoc.root.kids = ctDoc.root.kids.filter((k) => !(k.k === "el" && ln(k.name) === "Override" && (attr(k, "PartName") ?? "").toLowerCase() === `/${p}`.toLowerCase()));
        if (ct) { ctDoc.root.kids.push(el(CTP + "Override", { PartName: `/${p}`, ContentType: ct })); ctDoc.root.selfClose = false; }
        ctChanged = true;
      },
      sheetPartNow: (name) => { const m = mapping.find((x) => x.sheet.name === name); if (m) return m.orig?.part ?? newPartOf.get(name); const was = (renames[name] ?? name).toLowerCase(); return pinned.find((p) => p.name.toLowerCase() === was)?.part; },
      sheetPartWas: (name) => allSheets.find((s) => s.name.toLowerCase() === name.toLowerCase())?.part,
    };
    const cr = await patchCharts(io, workbook, orig.charts, workbook.charts, report.sheetsRenamed);
    if (cr.parts.length || cr.removed) { report.partsRewritten.push(...cr.parts); report.charts = cr; }
  }
  if (wbChanged) {
    // calcChain lists formula cells; a stale chain makes Excel "repair" the file — drop it, ask for a full recalc.
    const cc = kids(relsDoc.root).find((r) => /\/calcChain$/.test(attr(r, "Type") ?? ""));
    if (cc) {
      const part = resolve(wbPart, attr(cc, "Target")!); removed.add(part);
      relsDoc.root.kids = relsDoc.root.kids.filter((k) => k !== cc);
      ctDoc.root.kids = ctDoc.root.kids.filter((k) => !(k.k === "el" && attr(k, "PartName") === `/${part}`));
    }
    let calc = kidL(wbDoc.root, "calcPr");
    if (!calc) {
      calc = el(P + "calcPr", { calcId: "191029" });
      const order = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
      const at = wbDoc.root.kids.findIndex((k) => k.k === "el" && order.includes(ln(k.name)));
      if (at < 0) wbDoc.root.kids.push(calc); else wbDoc.root.kids.splice(at, 0, calc);
    }
    setAttr(calc, "fullCalcOnLoad", "1");
    // TT58: PivotTable definitions → hidden sheet-scoped names (replacing the ones this app wrote before)
    {
      const sheetEls = kidsL(kidL(wbDoc.root, "sheets"), "sheet");
      let dn = kidL(wbDoc.root, "definedNames");
      if (dn) dn.kids = dn.kids.filter((k) => !(k.k === "el" && PIVOT_NAME_RE.test(attr(k, "name") ?? "")));
      const add: XEl[] = [];
      for (const sh of workbook.sheets.values()) {
        const idx = sheetEls.findIndex((e) => attr(e, "name") === sh.name); if (idx < 0) continue;
        for (const x of pivotNames(sh.pivots)) { const e = el(P + "definedName", { name: x.name, localSheetId: String(idx), hidden: "1" }); e.kids = [textNode(x.text)]; e.selfClose = false; add.push(e); }
      }
      if (add.length && !dn) {
        dn = el(P + "definedNames", {}); dn.selfClose = false;
        const after = ["calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
        const at = wbDoc.root.kids.findIndex((k) => k.k === "el" && after.includes(ln(k.name)));
        if (at < 0) wbDoc.root.kids.push(dn); else wbDoc.root.kids.splice(at, 0, dn);
      }
      if (dn) { dn.kids.push(...add); if (!kids(dn).length) wbDoc.root.kids = wbDoc.root.kids.filter((k) => k !== dn); }
    }
    out.set(wbPart, serializeXml(wbDoc)); report.partsRewritten.push(wbPart);
    if (structural || cc) { out.set(wbRelsPath, serializeXml(relsDoc)); out.set("[Content_Types].xml", serializeXml(ctDoc)); report.partsRewritten.push(wbRelsPath, "[Content_Types].xml"); }
  }
  if (ctChanged && !out.has("[Content_Types].xml")) { out.set("[Content_Types].xml", serializeXml(ctDoc)); report.partsRewritten.push("[Content_Types].xml"); }
  if (styles.changed) { out.set(stylesPart, serializeXml(styles.doc)); report.partsRewritten.push(stylesPart); }

  // --- assemble in original entry order; new parts appended
  const files: { name: string; data: Uint8Array | string }[] = [];
  for (const e of zip.entries) {
    if (removed.has(e.name) || e.name.endsWith("/")) continue;
    const repl = out.get(e.name);
    if (repl !== undefined) { files.push({ name: e.name, data: repl }); out.delete(e.name); }
    else { files.push({ name: e.name, data: (await zip.read(e.name))! }); report.partsCopied++; }
  }
  for (const [name, data] of out) files.push({ name, data });
  if (!wbChanged && !styles.changed && files.every((f) => typeof f.data !== "string")) return { bytes: original, report };
  return { bytes: await writeZip(files), report };
}

/** True when the bytes look like an xlsx package this patcher can keep (zip with a workbook part). */
export function canPatch(bytes: Uint8Array): boolean {
  try { const z = openZip(bytes); return z.has("[Content_Types].xml") && z.entries.some((e) => /workbook\.xml$/.test(e.name)); } catch { return false; }
}

