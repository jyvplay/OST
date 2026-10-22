"use client";
import { fz, useUiUnit } from "@/lib/uiscale";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import {
  Workbook, Sheet, a1, isError, colToLetters, FUNCTIONS, EXT_FUNCTIONS, workbookFromJson, workbookToJson, parseFormula, formatValue, BUILTIN_FORMATS,
  norm, rangeA1, toTsv, parseTsv, copyBlock, pasteBlock, pasteSpecial, pasteLink, type PasteSpecialOpts, type PasteOp, clearRange, autoFill, sortRange, insertDelete, findAll, replaceAll, selectionStats, shiftFormula,
  chartDataFromRange, chartDataFor, renameChartRefs, CHART_KINDS, trendLegend, buildChartSvg, svgDataUri, evalCondFormats, parseRange, currentRegion, jump, fillTarget, looksLikeHeader,
  completionToken, completions, activeCall, SIGNATURES, hasValueIn,
  type WorkbookJson, type CellStyle, type Range, type Clip, type ChartKind, type ChartGrouping, type TrendSpec, type CondKind, type CondRule, type Scalar,
} from "@/lib/formula/client";
import { askPassword, isEncryptedOffice, lockedProtection, saveBlocked, sealPackage, unlockOffice, type Protection } from "@/lib/office/unlock";
import { iconDataUri, iconLabel, ICON_SETS, MAIN_ICON_SETS } from "@/lib/formula/cficons";
import { TIME_PERIODS, type CfStyle } from "@/lib/formula/sheetmeta";
import {
  applyBorders, borderCss, edgeAt, expandToMerges, invalidCells, listFormula, listItems, mergeAcross, mergeAt, mergeCells, partialMergeConflict,
  ruleAt, sanitizeValidation, sortConflict, stepCell, unmergeCells, validateEntry, VALIDATION_OPS, type BorderPreset,
} from "@/lib/formula/sheetlayout";
import { textInput, type BorderLine, type DataValidation, type ValidationOp, type ValidationType } from "@/lib/formula/engine";
import { cellLink, linkAction, parseAddress, setLink } from "@/lib/formula/sheetlinks";
import { parseA1Range } from "@/lib/formula/sheetops";
import { FN_LABEL, fieldItems, type PivotFn, type PivotSpec } from "@/lib/formula/pivot";
import { deletePivot, nextPivotName, pivotAt, readTable, refreshPivots, writePivot, type PivotDef } from "@/lib/formula/pivotsheet";
import { absoluteRef, referenceTarget, validateName } from "@/lib/formula/names";
import { autoInk } from "@/lib/auto-ink";
import { askText } from "@/lib/ask";
import { changeAllCells, changeAllWorkbook, fixCellIssue, type CellSpellIssue } from "@/lib/formula/sheetspell";
import SheetSpellBar from "./sheet-spell";
import type { Speller } from "@/lib/spell/hunspell";
import { addUserWord, loadSpeller } from "@/lib/spell/client";

const COLS = 52;          // A..AZ
const ROWS = 1000;
/** Grid geometry in document pixels (TT20 sizes); the component multiplies by the text-size unit (TT21). */
const BASE_ROW_H = 22, BASE_HEAD_H = 22, BASE_ROWHDR_W = 44, BASE_W = 88;
const MAX_UNDO = 100;
const SAMPLE: Record<string, string> = {
  A1: "Item", B1: "Qty", C1: "Price", D1: "Total",
  A2: "Widget", B2: "3", C2: "9.5", D2: "=B2*C2",
  A3: "Gadget", B3: "2", C3: "14.25", D3: "=B3*C3",
  A4: "Gizmo", B4: "5", C4: "4.4", D4: "=B4*C4",
  C5: "Sum", D5: "=SUM(D2:D4)",
  A7: "Average price", B7: "=AVERAGE(C2:C4)",
  A8: "Tax", B8: "=D5*TaxRate!B1",
  F1: "Top sellers", F2: "=SORTBY(A2:A4,D2:D4,-1)",
};
type Pos = { col: number; row: number };
/** TT63: what the .xlsx writer did with each PivotTable (src/lib/formula/pivotxml.ts PivotSaveNote) */
type PivotNote = { sheet: string; name: string; native: boolean; why?: string };
const pivotNote = (notes?: PivotNote[]) => { const n = (notes ?? []).filter((x) => x.native).length; return n ? ` · ${n} PivotTable(s) written as Excel PivotTables` : ""; };
type Sel = { a: Pos; f: Pos };
type Drag = { mode: "select" } | { mode: "fill"; target: Range | null } | { mode: "resize"; col: number; x: number; w: number } | { mode: "point"; prefix: string; start: Pos } | null;

/**
 * Spreadsheet v2 (TT15): virtualised A..AZ × 1000 grid over the first-party
 * engine with range selection, fill handle, clipboard (TSV, formula-shifting
 * internal paste), snapshot undo/redo, formatting toolbar + number formats,
 * sort, insert/delete rows/cols, column resize, frozen header row, find &
 * replace, status-bar statistics, function autocomplete + argument hints,
 * formula point-mode, spill-range outlines, charts and conditional formatting.
 * Pure logic lives in src/lib/formula/{sheetops,sheetui,sheetmeta,numfmt}.ts
 * and is covered headless by scripts/office-engine*.mts.
 */
/** TT49: the rule types the conditional-format panel can author (Excel's "New Formatting Rule" set). */
type CfUiKind = "gt" | "lt" | "ge" | "le" | "eq" | "ne" | "between" | "notBetween" | "contains" | "notContains" | "begins" | "ends" | "blanks" | "noBlanks" | "errors" | "noErrors"
  | "duplicate" | "unique" | "top" | "bottom" | "topPct" | "bottomPct" | "aboveAvg" | "belowAvg" | "period" | "expr" | "scale" | "scale3" | "bar" | "icons";
const CF_UI_KINDS: [CfUiKind, string][] = [
  ["gt", "value >"], ["lt", "value <"], ["ge", "value \u2265"], ["le", "value \u2264"], ["eq", "value ="], ["ne", "value \u2260"], ["between", "between"], ["notBetween", "not between"],
  ["contains", "text contains"], ["notContains", "text does not contain"], ["begins", "text begins with"], ["ends", "text ends with"],
  ["blanks", "blanks"], ["noBlanks", "no blanks"], ["errors", "errors"], ["noErrors", "no errors"], ["duplicate", "duplicate values"], ["unique", "unique values"],
  ["top", "top N"], ["bottom", "bottom N"], ["topPct", "top N%"], ["bottomPct", "bottom N%"], ["aboveAvg", "above average"], ["belowAvg", "below average"],
  ["period", "date occurring"], ["expr", "formula is true"], ["scale", "2-colour scale"], ["scale3", "3-colour scale"], ["bar", "data bar"], ["icons", "icon set"],
];
const PERIOD_LABEL: Record<string, string> = { today: "today", yesterday: "yesterday", tomorrow: "tomorrow", last7Days: "in the last 7 days", thisWeek: "this week", lastWeek: "last week", nextWeek: "next week", thisMonth: "this month", lastMonth: "last month", nextMonth: "next month" };
const CMP_LABEL: Record<string, string> = { gt: ">", lt: "<", ge: "\u2265", le: "\u2264", eq: "=", ne: "\u2260" };
function cfLabel(r: CondRule): string {
  const A = r.af !== undefined ? `=${r.af}` : r.a ?? "", B = r.bf !== undefined ? `=${r.bf}` : r.b ?? "";
  const stop = r.stop ? " (stop)" : "";
  switch (r.kind) {
    case "gt": case "lt": case "ge": case "le": case "eq": case "ne": return `value ${CMP_LABEL[r.kind]} ${A}${stop}`;
    case "between": return `between ${A} and ${B}${stop}`;
    case "notBetween": return `not between ${A} and ${B}${stop}`;
    case "contains": return `text contains "${r.a ?? ""}"${stop}`;
    case "notContains": return `text does not contain "${r.a ?? ""}"${stop}`;
    case "begins": return `text begins with "${r.a ?? ""}"${stop}`;
    case "ends": return `text ends with "${r.a ?? ""}"${stop}`;
    case "blanks": return `blanks${stop}`; case "noBlanks": return `no blanks${stop}`;
    case "errors": return `errors${stop}`; case "noErrors": return `no errors${stop}`;
    case "duplicate": return `duplicate values${stop}`; case "unique": return `unique values${stop}`;
    case "top": return `${r.bottom ? "bottom" : "top"} ${r.a ?? 10}${r.pct ? "%" : ""}${stop}`;
    case "aboveAvg": return `${r.below ? "below" : "above"} average${r.equal ? " or equal" : ""}${r.stdDev ? ` by ${r.stdDev} std dev` : ""}${stop}`;
    case "period": return `date ${PERIOD_LABEL[r.period ?? ""] ?? r.period}${stop}`;
    case "expr": return `formula =${r.formula ?? ""}${stop}`;
    case "scale": return r.scaleMid ? "3-colour scale" : "2-colour scale";
    case "bar": return `data bar${r.barAxis ? " (negative axis)" : ""}`;
    case "icons": return `icon set ${r.iconSet ?? "3TrafficLights1"}${r.reverse ? " reversed" : ""}${r.icons ? " (custom)" : ""}`;
  }
  return r.kind;
}

export default function SpreadsheetModule({ win }: ModuleProps) {
  // TT21: rows, headers and default columns grow with the text size. Stored column widths stay in document px
  // (what xlsx export writes); the screen width is stored × k and a drag divides by k.
  const k = useUiUnit();
  const ROW_H = Math.round(BASE_ROW_H * k), HEAD_H = Math.round(BASE_HEAD_H * k), ROWHDR_W = Math.round(BASE_ROWHDR_W * k);
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [workbook, setWorkbook] = useState(() => new Workbook());
  const [active, setActive] = useState("Sheet1");
  const [rev, setRev] = useState(0);
  const [sel, setSel] = useState<Sel>({ a: { col: 0, row: 0 }, f: { col: 0, row: 0 } });
  const [editing, setEditing] = useState<string | null>(null);
  const [editSrc, setEditSrc] = useState<"cell" | "bar">("cell");
  const [acIdx, setAcIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [panel, setPanel] = useState<null | "find" | "charts" | "cf" | "dv" | "names" | "paste" | "link" | "pivot" | "spell">(null);
  // TT59 spelling (F7): scope = the selection when it spans several cells, else the whole active sheet
  const [speller, setSpeller] = useState<Speller | null>(null);
  const [spErr, setSpErr] = useState("");
  const [spScope, setSpScope] = useState<{ c0: number; r0: number; c1: number; r1: number } | null>(null);
  const [spAll, setSpAll] = useState(false); const [spFrom, setSpFrom] = useState(""); // TT60 spelling across all sheets
  const [spIdx, setSpIdx] = useState(0);
  const [spGen, setSpGen] = useState(0);
  const [spTo, setSpTo] = useState<{ key: string; v: string } | null>(null);
  const [spIgnore, setSpIgnore] = useState<{ all: Set<string>; once: Set<string> }>(() => ({ all: new Set(), once: new Set() }));
  // TT57: Insert ▸ Link (Ctrl+K) form
  const [lk, setLk] = useState({ addr: "", text: "", tip: "", had: false });
  // TT58 PivotTable panel: field indexes into the source heading row (-1 = none)
  const [pv, setPv] = useState<{ src: string; rows: number[]; cols: number[]; vals: { field: number; fn: PivotFn }[]; filter: number; inc: string[] | null; subtotals: boolean; grand: boolean; edit: null | { sheet: string; name: string } }>(
    { src: "", rows: [-1, -1, -1], cols: [-1, -1], vals: [{ field: -1, fn: "sum" }, { field: -1, fn: "sum" }, { field: -1, fn: "sum" }], filter: -1, inc: null, subtotals: true, grand: true, edit: null });
  const [psFrom, setPsFrom] = useState("");
  const [ps, setPs] = useState<PasteSpecialOpts>({ what: "values", op: "none", transpose: false, skipBlanks: false });
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [newName, setNewName] = useState({ name: "", ref: "", scope: "" });
  const [borderLine, setBorderLine] = useState<BorderLine>("thin");
  const [borderColor, setBorderColor] = useState("#e5e7eb");
  const [dvForm, setDvForm] = useState<{ type: ValidationType; operator: ValidationOp; f1: string; f2: string; style: DataValidation["errorStyle"]; error: string; prompt: string; allowBlank: boolean; dropdown: boolean }>({ type: "list", operator: "between", f1: "Low,Medium,High", f2: "", style: "stop", error: "", prompt: "", allowBlank: true, dropdown: true });
  const [dvAlert, setDvAlert] = useState<null | { title: string; message: string; style: DataValidation["errorStyle"]; sheet: string; col: number; row: number; text: string }>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listUp, setListUp] = useState(false);
  /** Open the in-cell list; flip it above the cell when the visible grid has no room below (as Excel does). */
  const openList = (toggle: boolean, from: Element | null) => {
    const el = from?.closest('[data-testid="sheet-grid"]') as HTMLElement | null;
    if (el) {
      const m = mergeAt(sheet, sel.f.col, sel.f.row); const below = m ? m.r1 : sel.f.row;
      const n = ruleAt(sheet, sel.f.col, sel.f.row)?.type === "list" ? Math.min(8, listItems(workbook, active, ruleAt(sheet, sel.f.col, sel.f.row)!).length) : 8;
      const menuH = Math.min(180 * k, n * 21.5 * k + 8);
      setListUp(HEAD_H + (below + 1) * ROW_H + menuH > el.scrollTop + el.clientHeight);
    }
    setListOpen((o) => (toggle ? !o : true));
  };
  const [showInvalid, setShowInvalid] = useState(false);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });
  const [findQ, setFindQ] = useState(""); const [replQ, setReplQ] = useState(""); const [matchCase, setMatchCase] = useState(false); const [findInfo, setFindInfo] = useState("");
  const [cf, setCf] = useState<{ kind: CfUiKind; a: string; b: string; fill: string; color: string; sMin: string; sMid: string; sMax: string; bold: boolean; stop: boolean; formula: string; period: string; iconSet: string; reverse: boolean; barColor: string }>({ kind: "gt", a: "10", b: "", fill: "#14532d", color: "#bbf7d0", sMin: "#f8696b", sMid: "#ffeb84", sMax: "#63be7b", bold: false, stop: false, formula: "", period: "today", iconSet: "3Arrows", reverse: false, barColor: "#638ec6" });
  const gridRef = useRef<HTMLDivElement | null>(null);
  const undoRef = useRef<{ json: string; active: string }[]>([]);
  /** current sheet name → name in the opened .xlsx (lossless save maps renamed sheets back to their parts). */
  const renamesRef = useRef<Record<string, string>>({});
  const redoRef = useRef<{ json: string; active: string }[]>([]);
  const clipRef = useRef<{ tsv: string; clip: Clip; cut: boolean; range: Range; sheet: string; values?: Scalar[][] } | null>(null);
  /** TT47/48: password protection (password in this window's memory only) + the decrypted package used as patch source. */
  const encRef = useRef<(Protection & { plain: Uint8Array | null }) | null>(null);
  const [locked, setLocked] = useState(false);
  const dragRef = useRef<Drag>(null);
  const [editAt, setEditAt] = useState<Pos>({ col: 0, row: 0 });
  const [editSheet, setEditSheet] = useState("Sheet1");
  const [histN, setHistN] = useState({ undo: 0, redo: 0 });
  const [fillPreview, setFillPreview] = useState<Range | null>(null);
  const sheet = workbook.sheets.get(active) ?? workbook.sheet();
  // Excel: a selection touching part of a merged area includes all of it.
  const selR = useMemo(() => expandToMerges(sheet, norm({ c0: sel.a.col, r0: sel.a.row, c1: sel.f.col, r1: sel.f.row })), [sel, sheet, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const fnNames = useMemo(() => [...new Set([...Object.keys(FUNCTIONS), ...Object.keys(EXT_FUNCTIONS)])].sort(), []);
  const colW = useCallback((c: number) => Math.round((sheet.colWidths[c] ?? BASE_W) * k), [sheet, rev, k]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ load */
  useEffect(() => {
    let alive = true;
    (async () => {
      let wb = new Workbook();
      renamesRef.current = {};
      if (path.toLowerCase().endsWith(".xlsx")) {
        encRef.current = null; setLocked(false);
        try { const r = await post<{ ok: boolean; workbook: WorkbookJson }>("/api/sheet", { op: "importXlsx", path }); wb = workbookFromJson(r.workbook); }
        catch (e) {
          const msg = String((e as Error).message);
          if (/OLE\/CFB container/.test(msg)) {
            // TT47: password-protected .xlsx — fetch the container, decrypt on this device, import the decrypted package
            encRef.current = { ...lockedProtection(path), plain: null }; // set first: a cancelled/failed open must never save plaintext over it
            try {
              const n = await api<{ node: { content: string; encoding?: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
              const raw = Uint8Array.from(atob(n.node.content), (c) => c.charCodeAt(0));
              const u = isEncryptedOffice(raw) ? await unlockOffice(raw, path.split("/").pop() ?? "workbook.xlsx") : null;
              if (u) {
                const r = await post<{ ok: boolean; workbook: WorkbookJson }>("/api/sheet", { op: "importXlsx", base64: toBase64(u.bytes) });
                wb = workbookFromJson(r.workbook); encRef.current = { ...lockedProtection(path), password: u.password, plain: u.bytes }; setLocked(true);
                setStatus(`Opened password-protected workbook (${u.method}${u.integrity === "verified" ? ", integrity verified" : ""}) — saves stay encrypted with the same password`);
              } else shell.toast(isEncryptedOffice(raw) ? "Not opened: the workbook is password-protected and no password was entered." : `Could not import .xlsx: ${msg}`, "warn");
            } catch (e2) { shell.toast(`Could not open the protected workbook: ${String((e2 as Error).message)}`, "bad"); }
          } else shell.toast(`Could not import .xlsx: ${msg}`, "bad");
        }
      } else if (path) {
        try {
          const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
          const data = JSON.parse(r.node.content) as WorkbookJson & { name?: string; cells?: { ref: string; input: string }[] };
          wb = workbookFromJson(data.sheets ? data : { sheets: [{ name: data.name ?? "Sheet1", cells: data.cells ?? [] }] });
        } catch { shell.toast("Starting a new workbook (the selected path was empty or not a Fusion workbook).", "info"); loadSample(wb); }
      } else loadSample(wb);
      if (!alive) return;
      wb.recalculate(); setWorkbook(wb); setActive(wb.sheets.keys().next().value ?? "Sheet1"); setRev((r) => r + 1); setLoaded(true);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  /* ------------------------------------------------------------ mutation + history */
  const snapshot = () => ({ json: JSON.stringify(workbookToJson(workbook)), active });
  const syncHist = () => setHistN({ undo: undoRef.current.length, redo: redoRef.current.length });
  const pushUndo = () => { undoRef.current.push(snapshot()); if (undoRef.current.length > MAX_UNDO) undoRef.current.shift(); redoRef.current = []; syncHist(); };
  const mutate = (fn: (wb: Workbook, s: Sheet) => void) => { pushUndo(); fn(workbook, sheet); workbook.recalculate(); setRev((r) => r + 1); setDirty(true); };
  const restore = (from: typeof undoRef, to: typeof undoRef) => {
    const snap = from.current.pop(); if (!snap) return;
    to.current.push(snapshot()); syncHist();
    const wb = workbookFromJson(JSON.parse(snap.json)); setWorkbook(wb); setActive(wb.sheets.has(snap.active) ? snap.active : wb.sheets.keys().next().value!); setRev((r) => r + 1); setDirty(true);
  };
  const undo = () => restore(undoRef, redoRef);
  const redo = () => restore(redoRef, undoRef);

  /* ------------------------------------------------------------ persistence */
  /** TT46: lossless .xlsx save — the original package is kept; only edited cells/sheets/styles are rewritten. */
  const saveXlsxLossless = async (dest0: string): Promise<boolean> => {
    const dest = dest0; const prot = encRef.current;
    // never write plaintext over a password-protected original that was not unlocked (or whose password was not removed)
    if (saveBlocked(prot, dest) || (prot?.wasEncrypted && !prot.plain)) { shell.toast("Not saved: the password-protected workbook was not unlocked.", "warn"); return true; }
    const src = prot?.plain ? { sourceBase64: toBase64(prot.plain) } : {};
    const replaceEncrypted = !!(prot?.removed && dest === prot.path);
    try {
      type Rep = { partsCopied: number; partsRewritten: string[]; cellsRewritten: number; sheetsAdded: string[]; sheetsRemoved: string[]; sheetsRenamed: [string, string][]; pivots?: { notes: PivotNote[] } };
      const r = await post<{ ok: boolean; path: string; bytes: number; base64?: string; report: Rep }>(
        "/api/sheet", { op: "patchXlsxToVfs", source: path, dest, workbook: workbookToJson(workbook), renames: renamesRef.current, ...src, returnBytes: !!prot?.password, replaceEncrypted });
      let note = replaceEncrypted ? " · password removed" : "";
      if (prot?.password) {
        // TT48: encrypt the patched package here (MS-OFFCRYPTO Agile, AES-256) and upload the encrypted container
        setStatus(prot.key ? "encrypting…" : "encrypting (deriving the key from your password)…"); await new Promise((res) => setTimeout(res, 30));
        const plain = Uint8Array.from(atob(r.base64 ?? ""), (c) => c.charCodeAt(0));
        const sealed = sealPackage(plain, prot).bytes;
        await post("/api/fs", { op: "upload", path: dest, content: toBase64(sealed), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        prot.plain = plain; prot.path = dest; note = " · encrypted with your password (AES-256)";
      } else if (prot?.removed) { encRef.current = null; setLocked(false); }
      const rp = r.report;
      setDirty(false);
      setStatus(rp.partsRewritten.length
        ? `saved ${r.path}${note} · lossless: ${rp.partsCopied} part(s) kept byte-identical, ${rp.partsRewritten.length} rewritten, ${rp.cellsRewritten} cell(s) written${pivotNote(rp.pivots?.notes)}`
        : `saved ${r.path}${note} · no changes — file left byte-identical`);
      warnValuesOnly(rp.pivots?.notes);
      shell.bumpRefresh();
      if (dest !== path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest } });
      return true;
    } catch (e) {
      if (encRef.current) { shell.toast(`Not saved: ${String((e as Error).message)}`, "bad"); return true; } // no plaintext .fworkbook fallback
      shell.toast(`Lossless .xlsx save refused: ${String((e as Error).message)}. Saved as a Fusion workbook instead; "Export .xlsx" writes a NEW package (cells, styles, charts, PivotTables, conditional formats and validations kept; comments and non-chart drawings dropped).`, "warn");
      return false;
    }
  };
  /** TT63: PivotTables become real Excel PivotTables on .xlsx save; the ones that cannot are saved as values + definition */
  const warnValuesOnly = (notes?: PivotNote[]) => {
    const bad = (notes ?? []).filter((n) => !n.native);
    if (bad.length) shell.toast(`Saved as values only (still editable here): ${bad.map((n) => `${n.name} — ${n.why}`).join("; ")}`, "warn");
  };
  const save = async () => {
    if (path && /\.xlsx$/i.test(path) && await saveXlsxLossless(path)) return;
    const dest = path && !/\.xlsx$/i.test(path) ? path : `/Documents/workbook-${Date.now()}.fworkbook`;
    await post("/api/fs", { op: "write", path: dest, content: JSON.stringify(workbookToJson(workbook)), reason: "spreadsheet-save" });
    setDirty(false); setStatus(`saved ${dest}`); shell.bumpRefresh();
    if (dest !== path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest } });
  };
  const exportXlsx = async () => {
    const dest = (path || "/Documents/workbook").replace(/\.(fworkbook|fsheet|xlsx)$/i, "") + ".xlsx";
    if (path && /\.xlsx$/i.test(path)) { await saveXlsxLossless(dest); return; }
    const r = await post<{ ok: boolean; path: string; bytes: number; sheets: number; error?: string; pivots?: PivotNote[] }>("/api/sheet", { op: "saveXlsxToVfs", workbook: workbookToJson(workbook), dest });
    if (r.ok) { setStatus(`exported ${r.bytes} B · ${r.sheets} sheet(s) to ${r.path} · ${workbook.charts.length} chart(s) written as Excel charts${pivotNote(r.pivots)}`); warnValuesOnly(r.pivots); shell.bumpRefresh(); }
    else shell.toast(r.error ?? "export failed", "bad");
  };
  const importXlsx = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) { shell.toast(".xlsx exceeds the 8 MB import guard", "warn"); return; }
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    if (isEncryptedOffice(bytes)) {
      try { const u = await unlockOffice(bytes, file.name); if (!u) return; bytes = u.bytes; }
      catch (e) { shell.toast(`Cannot open ${file.name}: ${(e as Error).message}`, "bad"); return; }
    }
    const r = await post<{ ok: boolean; workbook?: WorkbookJson; error?: string }>("/api/sheet", { op: "importXlsx", base64: toBase64(bytes) });
    if (!r.ok || !r.workbook) { shell.toast(r.error ?? "import failed", "bad"); return; }
    pushUndo();
    const wb = workbookFromJson(r.workbook); setWorkbook(wb); setActive(wb.sheets.keys().next().value ?? "Sheet1"); setDirty(true); setRev((x) => x + 1);
    shell.toast(`Imported ${wb.sheets.size} sheet(s) — formulas re-evaluated by Fusion, styles and widths kept.`, "ok");
  };

  /* ------------------------------------------------------------ sheets */
  /* ---------------------------------------------------------------- TT57 hyperlinks */
  const openLinkPanel = () => {
    commit(null);
    const l = cellLink(workbook, active, sel.f.col, sel.f.row);
    const c = sheet.get(sel.f.col, sel.f.row);
    const addr = l ? (l.target ? `${l.target}${l.location ? `#${l.location}` : ""}` : l.location ?? "") : "";
    setLk({ addr, text: c && !c.formula ? c.input : "", tip: l?.tooltip ?? "", had: !!l && !l.formula });
    setPanel("link");
  };
  const applyLink = () => {
    const a = parseAddress(lk.addr);
    if (!a) { const m = "Enter a web address (example.com), an e-mail address, or a place in this workbook such as Sheet2!A1."; shell.toast(m, "warn"); setStatus(m); return; }
    const where = { c0: selR.c0, r0: selR.r0, c1: selR.c1, r1: selR.r1 };
    mutate((_wb, s) => {
      setLink(s, where, { ...a, tooltip: lk.tip.trim() || undefined });
      // Excel's "Text to display": the top-left cell shows it (formulas are left alone); an empty cell shows the address
      const c = s.get(where.c0, where.r0);
      if (!c?.formula) { const t = lk.text.trim() || (c?.input ? c.input : lk.addr.trim()); if (t !== (c?.input ?? "")) s.setCell(where.c0, where.r0, textInput(t)); }
    });
    setStatus(`link on ${rangeA1(selR)}: ${a.target ?? a.location}`); setPanel(null); gridRef.current?.focus();
  };
  const removeLink = () => { mutate((_wb, s) => setLink(s, { c0: selR.c0, r0: selR.r0, c1: selR.c1, r1: selR.r1 }, null)); setStatus(`link removed from ${rangeA1(selR)}`); setPanel(null); gridRef.current?.focus(); };
  const followLink = (col: number, row: number): boolean => {
    const l = cellLink(workbook, active, col, row);
    if (!l) return false;
    const act = linkAction(l, [...workbook.sheets.keys()]);
    if (act.kind === "url") {
      if (/^mailto:/i.test(act.url)) window.open(act.url, "_blank", "noopener,noreferrer");
      else shell.open("browser", { url: act.url });
      setStatus(`opened ${act.url}`);
    } else if (act.kind === "place") {
      const r = parseA1Range(act.ref);
      if (r) { if (act.sheet && act.sheet !== active) { commit(null); setActive(act.sheet); } setSel({ a: { col: r.c0, row: r.r0 }, f: { col: r.c1, row: r.r1 } }); requestAnimationFrame(() => ensureVisible({ col: r.c0, row: r.r0 })); setStatus(`went to ${act.sheet ? `${act.sheet}!` : ""}${act.ref}`); }
    } else { shell.toast(act.why, "warn"); setStatus(act.why); }
    return true;
  };
  const switchSheet = (name: string) => { commit(null); setActive(name); setSel({ a: { col: 0, row: 0 }, f: { col: 0, row: 0 } }); };
  // ---- TT58 PivotTables ----
  const splitSrc = (t: string): { sheet: string; ref: string } | null => {
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(t.trim());
    const sheetName = m ? (m[1]?.replace(/''/g, "'") ?? m[2]) : active, ref = m ? m[3] : t.trim();
    return parseA1Range(ref) && workbook.sheets.has(sheetName) ? { sheet: sheetName, ref: ref.replace(/\$/g, "").toUpperCase() } : null;
  };
  const srcText = (src: { sheet: string; ref: string }) => `${quoteSheet(src.sheet)}!${src.ref}`;
  const pivotHeads = (): string[] => {
    const src = splitSrc(pv.src); if (!src) return [];
    try { const t = readTable(workbook, src); return (t[0] ?? []).map((h, i) => (h === null ? `(column ${i + 1})` : typeof h === "object" ? h.e : String(h))); } catch { return []; }
  };
  const openPivotPanel = () => {
    commit(null);
    const ex = pivotAt(sheet, sel.f.col, sel.f.row);
    if (ex) {
      const sp = ex.spec, pad = <T,>(a: T[], n: number, f: T) => [...a, ...Array(Math.max(0, n - a.length)).fill(f)].slice(0, n);
      setPv({ src: srcText(ex.src), rows: pad(sp.rows, 3, -1), cols: pad(sp.cols, 2, -1), vals: pad(sp.values, 3, { field: -1, fn: "sum" as PivotFn }), filter: sp.filters?.[0]?.field ?? -1, inc: sp.filters?.[0]?.include ?? null, subtotals: sp.subtotals !== false, grand: sp.grandRows !== false, edit: { sheet: active, name: ex.name } });
    } else {
      const r = dataRange(); const src = { sheet: active, ref: rangeA1(r) };
      let heads: (string | null)[] = [], numeric: boolean[] = [];
      try { const t = readTable(workbook, src); heads = (t[0] ?? []).map((h) => (h === null ? null : String(h))); numeric = heads.map((_, j) => t.slice(1).some((row) => typeof row[j] === "number")); } catch { /* the panel explains invalid sources */ }
      const firstText = numeric.findIndex((n) => !n), firstNum = numeric.findIndex((n, j) => n && j !== firstText);
      setPv({ src: srcText(src), rows: [firstText, -1, -1], cols: [-1, -1], vals: [{ field: firstNum, fn: "sum" }, { field: -1, fn: "sum" }, { field: -1, fn: "sum" }], filter: -1, inc: null, subtotals: true, grand: true, edit: null });
    }
    setPanel("pivot");
  };
  const pivotSpecOf = (): PivotSpec => ({
    rows: pv.rows.filter((f) => f >= 0), cols: pv.cols.filter((f) => f >= 0), values: pv.vals.filter((v) => v.field >= 0),
    filters: pv.filter >= 0 && pv.inc ? [{ field: pv.filter, include: pv.inc }] : [], subtotals: pv.subtotals, grandRows: pv.grand, grandCols: pv.grand,
  });
  const say = (m: string, warn = false) => { setStatus(m); if (warn) shell.toast(m, "warn"); };
  const writeFilterCaption = (s: Sheet, def: PivotDef) => {
    // Excel's report-filter area two rows above the table: field name | (All) / item / (Multiple Items)
    if (def.anchor.row < 2) return;
    const r = def.anchor.row - 2, f = def.spec.filters?.[0];
    let label = "", value = "";
    if (f) { const heads = readTable(workbook, def.src)[0] ?? []; label = String(heads[f.field] ?? ""); value = f.include.length === 1 ? f.include[0] : "(Multiple Items)"; }
    s.setCell(def.anchor.col, r, label ? textInput(label) : ""); s.setCell(def.anchor.col + 1, r, value ? textInput(value) : "");
    s.setStyle(def.anchor.col, r, { bold: label ? true : undefined });
  };
  const applyPivot = () => {
    const src = splitSrc(pv.src);
    if (!src) { say("Enter the source as a range such as Sheet1!A1:D20 (the first row holds the field names).", true); return; }
    const spec = pivotSpecOf();
    if (pv.edit) {
      const sh = workbook.sheets.get(pv.edit.sheet); const def = sh?.pivots.find((p) => p.name === pv.edit!.name);
      if (!sh || !def) { say("That PivotTable no longer exists.", true); return; }
      let res: ReturnType<typeof writePivot> = { ok: false };
      mutate((wb) => { const old = { src: def.src, spec: def.spec }; def.src = src; def.spec = spec; res = writePivot(wb, sh, def); if (!res.ok) { def.src = old.src; def.spec = old.spec; } else writeFilterCaption(sh, def); });
      if (!res.ok) { say(res.why ?? "PivotTable not updated", true); return; }
      say(`${def.name} updated (${rangeA1(res.out!)})`); setPanel(null); gridRef.current?.focus(); return;
    }
    let n = 1; while (workbook.sheets.has(`Pivot${n}`)) n++;
    const name = `Pivot${n}`, def: PivotDef = { name: nextPivotName(workbook), src, anchor: { col: 0, row: 2 }, spec };
    let res: ReturnType<typeof writePivot> = { ok: false };
    // compute first so a refused spec does not leave an empty sheet behind
    try { readTable(workbook, src); } catch (e) { say((e as Error).message, true); return; }
    mutate((wb) => { const sh = wb.addSheet(name); res = writePivot(wb, sh, def); if (!res.ok) wb.sheets.delete(name); else writeFilterCaption(sh, def); });
    if (!res.ok) { say(res.why ?? "PivotTable not created", true); return; }
    switchSheet(name);
    say(`${def.name} created on ${name} (${rangeA1(res.out!)}) from ${srcText(src)}`); setPanel(null); gridRef.current?.focus();
  };
  const refreshPivotUi = (onlyHere: boolean) => {
    const here = pivotAt(sheet, sel.f.col, sel.f.row);
    const total = [...workbook.sheets.values()].reduce((k, s) => k + s.pivots.length, 0);
    if (!total) { say("This workbook has no PivotTables — Data > PivotTable creates one."); return; }
    let bad: { name: string; why: string }[] = [];
    if (onlyHere && here) {
      mutate((wb, s) => { const r = writePivot(wb, s, here, true); if (!r.ok) bad = [{ name: here.name, why: r.why! }]; });
      say(bad.length ? `${here.name}: ${bad[0].why}` : `${here.name} refreshed`, !!bad.length); return;
    }
    mutate((wb) => { bad = refreshPivots(wb); });
    say(bad.length ? `refreshed ${total - bad.length} of ${total} PivotTable(s) — ${bad.map((b) => `${b.name}: ${b.why}`).join("; ")}` : `refreshed ${total} PivotTable(s)`, !!bad.length);
  };
  const removePivot = () => {
    const sh = pv.edit && workbook.sheets.get(pv.edit.sheet); const def = sh?.pivots.find((p) => p.name === pv.edit!.name);
    if (!sh || !def) return;
    mutate(() => { deletePivot(sh, def); if (def.anchor.row >= 2) { sh.setCell(def.anchor.col, def.anchor.row - 2, ""); sh.setCell(def.anchor.col + 1, def.anchor.row - 2, ""); } });
    say(`${def.name} deleted`); setPanel(null); gridRef.current?.focus();
  };
  const newSheet = () => { let n = workbook.sheets.size + 1; while (workbook.sheets.has(`Sheet${n}`)) n++; const name = `Sheet${n}`; mutate((wb) => { wb.addSheet(name); }); switchSheet(name); };
  const renameSheet = async (old: string) => {
    const next = (await askText("Sheet name", old, {
      detail: "Up to 31 characters; : \\ / ? * [ ] are not allowed.", okLabel: "Rename",
      validate: (v) => { const t = v.trim(); return t.length > 31 || /[:\\/?*[\]]/.test(t) ? "Up to 31 characters, without : \\ / ? * [ ]" : t.toLowerCase() !== old.toLowerCase() && [...workbook.sheets.keys()].some((s) => s.toLowerCase() === t.toLowerCase()) ? "A sheet with that name already exists." : null; },
    }))?.trim();
    if (!next || next === old) return;
    if (next.length > 31 || /[:\\/?*[\]]/.test(next)) { shell.toast("Invalid sheet name (max 31 chars; : \\ / ? * [ ] are forbidden)", "warn"); return; }
    if ([...workbook.sheets.keys()].some((s) => s.toLowerCase() === next.toLowerCase())) { shell.toast("A sheet with that name already exists.", "warn"); return; }
    mutate((wb) => {
      const entries = [...wb.sheets.entries()]; wb.sheets.clear();
      for (const [n, s] of entries) { if (n === old) s.name = next; wb.sheets.set(s.name, s); } // keeps order, styles, widths, freeze
      for (const t of wb.tables.values()) if (t.sheet === old) t.sheet = next; // structured references follow the sheet
      const was = renamesRef.current[old] ?? old; delete renamesRef.current[old]; renamesRef.current[next] = was; // lossless .xlsx save maps it back
      const re = new RegExp(`(^|[^A-Za-z0-9_.'])(?:${escapeRe(old)}|'${escapeRe(old.replace(/'/g, "''"))}')!`, "g");
      for (const s of wb.sheets.values()) for (const [k, cell] of [...s.grid]) if (cell.formula && re.test(cell.input)) { re.lastIndex = 0; const [c, r] = k.split(",").map(Number); s.setCell(c, r, cell.input.replace(re, (_m, pre) => `${pre}${quoteSheet(next)}!`)); }
      wb.charts = wb.charts.map((c) => renameChartRefs(c, old, next)); // TT50: chart series references follow the rename
      for (const x of [...wb.charts, ...wb.condFormats]) if (x.sheet === old) x.sheet = next;
      for (const sh of wb.sheets.values()) for (const p of sh.pivots) if (p.src.sheet === old) p.src.sheet = next; // TT58: PivotTable sources follow
    });
    setActive(next);
  };
  const deleteSheet = (name: string) => {
    if (workbook.sheets.size <= 1) { shell.toast("A workbook must contain at least one sheet.", "warn"); return; }
    if (!confirm(`Delete sheet “${name}”? Formulas referring to it become #REF!-style errors. (Undo with Ctrl+Z.)`)) return;
    mutate((wb) => { wb.sheets.delete(name); wb.charts = wb.charts.filter((c) => c.sheet !== name); wb.condFormats = wb.condFormats.filter((c) => c.sheet !== name); });
    setActive(workbook.sheets.keys().next().value as string);
  };

  /* ------------------------------------------------------------ editing */
  const startEdit = (text: string, src: "cell" | "bar" = "cell") => { setEditAt({ ...sel.f }); setEditSheet(active); setEditSrc(src); setEditing(text); setAcIdx(0); };
  const commit = (move: [number, number] | null, fillSelection = false) => {
    if (editing !== null) {
      const { col, row } = editAt; const text = editing; const target = workbook.sheets.get(editSheet) ?? sheet;
      if (fillSelection && (selR.c0 !== selR.c1 || selR.r0 !== selR.r1)) mutate((_wb, s) => { for (let r = selR.r0; r <= selR.r1; r++) for (let c = selR.c0; c <= selR.c1; c++) s.setCell(c, r, shiftFormula(text, c - col, r - row)); });
      else if ((target.get(col, row)?.input ?? "") !== text) enter(editSheet, col, row, text);
    }
    setEditing(null);
    if (move) moveTo(stepCell(sheet, editAt, move[0], move[1], COLS - 1, ROWS - 1));
  };
  /** Typed entry with Excel data-validation semantics (Stop blocks; Warning/Information ask; showError=false never asks). */
  const enter = (sheetName: string, col: number, row: number, text: string) => {
    const target = workbook.sheets.get(sheetName); if (!target) return;
    const rule = ruleAt(target, col, row);
    if (!rule || !rule.showError) { mutate(() => target.setCell(col, row, text)); return; }
    pushUndo();
    const chk = validateEntry(workbook, sheetName, col, row, text);   // rolls back when invalid
    setRev((r) => r + 1);
    if (chk.ok) { setDirty(true); setDvAlert(null); return; }
    undoRef.current.pop(); syncHist();
    setDvAlert({ title: chk.title ?? "Invalid entry", message: chk.message ?? "", style: rule.errorStyle, sheet: sheetName, col, row, text });
  };
  const pickListValue = (col: number, row: number, value: string) => { setListOpen(false); enter(active, col, row, value); gridRef.current?.focus(); };
  const resolveAlert = (keep: boolean, retry = false) => {
    const a = dvAlert; if (!a) return; setDvAlert(null);
    if (keep && a.style !== "stop") { mutate((wb) => wb.sheet(a.sheet).setCell(a.col, a.row, a.text)); setStatus(`kept ${a.text} in ${a1(a.col, a.row)} despite the ${a.style} rule`); }
    else if (retry) { setActive(a.sheet); setSel({ a: { col: a.col, row: a.row }, f: { col: a.col, row: a.row } }); setEditAt({ col: a.col, row: a.row }); setEditSheet(a.sheet); setEditSrc("cell"); setEditing(a.text); }
    gridRef.current?.focus();
  };
  const token = editing !== null ? completionToken(editing) : null;
  const definedNames = workbook.listNames().filter((n) => n.scope === null || n.scope === active).map((n) => n.name);
  const acList = token ? completions(token, [...fnNames, ...definedNames]) : [];
  const call = editing !== null && editing.startsWith("=") ? activeCall(editing) : null;
  const acceptCompletion = (name: string) => { if (editing !== null && token) { const isName = definedNames.some((n) => n.toUpperCase() === name.toUpperCase()) && !fnNames.includes(name); setEditing(editing.slice(0, editing.length - token.length) + name + (isName ? "" : "(")); setAcIdx(0); } };
  /** Name Box (Excel): a defined name or reference → go there; a new valid name → define it for the selection. */
  const nameBoxDisplay = (() => {
    const hit = workbook.listNames().find((n) => { if (n.scope !== null && n.scope !== active) return false; const t = referenceTarget(n.ref, active); return !!t && t.sheet === active && t.c0 === selR.c0 && t.r0 === selR.r0 && t.c1 === selR.c1 && t.r1 === selR.r1; });
    return hit ? hit.name : `${active}!${rangeA1(selR)}`;
  })();
  const goToTarget = (t: { sheet: string; c0: number; r0: number; c1: number; r1: number }) => {
    if (!workbook.sheets.has(t.sheet)) { setStatus(`no sheet "${t.sheet}"`); return; }
    commit(null); setActive(t.sheet);
    setSel({ a: { col: t.c0, row: t.r0 }, f: { col: Math.min(t.c1, COLS - 1), row: Math.min(t.r1, ROWS - 1) } });
    requestAnimationFrame(() => ensureVisible({ col: t.c0, row: t.r0 }));
  };
  const submitNameBox = (raw: string) => {
    const text = raw.trim(); setNameBox(null); if (!text) return;
    const def = workbook.lookupName(text, active);
    if (def) { const t = referenceTarget(def.ref, def.scope ?? active); if (t) goToTarget(t); else setStatus(`${def.name} refers to ${def.ref} (not a range)`); return; }
    const asRef = /^(?:[^!]+!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/.test(text) ? referenceTarget(text, active) : null;
    if (asRef) { goToTarget(asRef); return; }
    const bad = validateName(text);
    if (bad) { setStatus(`Name Box: ${bad}`); return; }
    const ref = absoluteRef(active, selR.c0, selR.r0, selR.c1, selR.r1);
    mutate((wb) => wb.defineName(text, ref));
    setStatus(`defined ${text} = ${ref}`);
  };
  const editKeys = (e: React.KeyboardEvent) => {
    if (acList.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setAcIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + acList.length) % acList.length); return; }
    if (acList.length && e.key === "Tab") { e.preventDefault(); acceptCompletion(acList[Math.min(acIdx, acList.length - 1)]); return; }
    if (e.key === "Enter") { e.preventDefault(); commit([0, e.shiftKey ? -1 : 1], e.ctrlKey || e.metaKey); gridRef.current?.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); commit([e.shiftKey ? -1 : 1, 0]); gridRef.current?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); setEditing(null); gridRef.current?.focus(); }
  };

  /* ------------------------------------------------------------ selection + navigation */
  const ensureVisible = (p: Pos) => {
    const el = gridRef.current; if (!el) return;
    const top = HEAD_H + p.row * ROW_H, frozen = sheet.freezeRows ? ROW_H : 0;
    if (top < el.scrollTop + HEAD_H + frozen && p.row >= sheet.freezeRows) el.scrollTop = top - HEAD_H - frozen;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    let left = ROWHDR_W; for (let c = 0; c < p.col; c++) left += colW(c);
    if (left < el.scrollLeft + ROWHDR_W) el.scrollLeft = left - ROWHDR_W;
    else if (left + colW(p.col) > el.scrollLeft + el.clientWidth) el.scrollLeft = left + colW(p.col) - el.clientWidth;
  };
  const moveTo = (p: Pos, extend = false) => { setListOpen(false); setSel((s) => (extend ? { a: s.a, f: p } : { a: p, f: p })); requestAnimationFrame(() => ensureVisible(p)); };
  const has = hasValueIn(workbook, active);
  const spShow = (x: CellSpellIssue) => { if (x.sheet !== active) setActive(x.sheet); moveTo({ col: x.col, row: x.row }); };
  const spFix = (x: CellSpellIssue, v: string) => { let done = false; mutate((wb) => { done = fixCellIssue(wb, x, v); }); if (done) spShow(x); };
  const openSpelling = () => {
    const r = selR; setSpScope(r.c0 === r.c1 && r.r0 === r.r1 ? null : r); setSpIdx(0); setSpFrom(active); setPanel("spell");
    if (!speller) loadSpeller().then(setSpeller).catch((e) => setSpErr(`Spelling dictionary could not be loaded: ${(e as Error).message}`));
  };

  const gridKeys = (e: React.KeyboardEvent) => {
    if (editing !== null) return;
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    const arrows: Record<string, [number, number]> = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] };
    if (arrows[k]) {
      e.preventDefault(); const [dc, dr] = arrows[k];
      const p = mod ? jump(has, sel.f.col, sel.f.row, dc, dr, COLS - 1, ROWS - 1) : stepCell(sheet, sel.f, dc, dr, COLS - 1, ROWS - 1);
      moveTo(p, e.shiftKey); return;
    }
    if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod && (k === "b" || k === "i" || k === "u")) { e.preventDefault(); toggle(k === "b" ? "bold" : k === "i" ? "italic" : "underline"); return; }
    if (mod && k === "d") { e.preventDefault(); fillDir("down"); return; }
    if (mod && k === "r") { e.preventDefault(); fillDir("right"); return; }
    if (mod && k === "a") { e.preventDefault(); const r = currentRegion(has, sel.f.col, sel.f.row, COLS - 1, ROWS - 1); const whole = (r.c0 === selR.c0 && r.r0 === selR.r0 && r.c1 === selR.c1 && r.r1 === selR.r1) || !has(sel.f.col, sel.f.row); setSel(whole ? { a: { col: 0, row: 0 }, f: { col: COLS - 1, row: ROWS - 1 } } : { a: { col: r.c0, row: r.r0 }, f: { col: r.c1, row: r.r1 } }); return; }
    if (mod && k === "f") { e.preventDefault(); setPanel("find"); return; }
    if (mod && k === "k") { e.preventDefault(); openLinkPanel(); return; }
    if (e.key === "F5" && e.altKey) { e.preventDefault(); refreshPivotUi(!e.ctrlKey && !e.metaKey); return; }
    if (e.key === "F7" && !mod && !e.altKey) { e.preventDefault(); openSpelling(); return; }
    if (mod && e.shiftKey && k === "v") { e.preventDefault(); openPasteSpecial(); return; }
    if (mod && e.key === "F3") { e.preventDefault(); setPanel("names"); return; }
    if (mod && k === "home") { e.preventDefault(); moveTo({ col: 0, row: 0 }); return; }
    if (k === "home") { e.preventDefault(); moveTo({ col: 0, row: sel.f.row }, e.shiftKey); return; }
    if (k === "pagedown" || k === "pageup") { e.preventDefault(); const n = Math.max(1, Math.floor((gridRef.current?.clientHeight ?? 400) / ROW_H) - 2); moveTo({ col: sel.f.col, row: clamp(sel.f.row + (k === "pagedown" ? n : -n), ROWS - 1) }, e.shiftKey); return; }
    if (k === "enter") { e.preventDefault(); moveTo(stepCell(sheet, sel.f, 0, e.shiftKey ? -1 : 1, COLS - 1, ROWS - 1)); return; }
    if (k === "tab") { e.preventDefault(); moveTo(stepCell(sheet, sel.f, e.shiftKey ? -1 : 1, 0, COLS - 1, ROWS - 1)); return; }
    if (e.altKey && k === "arrowdown") { e.preventDefault(); if (ruleAt(sheet, sel.f.col, sel.f.row)?.type === "list") openList(false, e.target as Element); return; }
    if (k === "delete" || k === "backspace") { e.preventDefault(); mutate((_wb, s) => clearRange(s, selR)); return; }
    if (k === "f2") { e.preventDefault(); startEdit(sheet.get(sel.f.col, sel.f.row)?.input ?? ""); return; }
    if (e.key.length === 1 && !mod && !e.altKey) { e.preventDefault(); startEdit(e.key); }
  };

  /* ------------------------------------------------------------ clipboard */
  const displayText = (c: number, r: number) => formatValue(workbook.valueAt(active, c, r), sheet.get(c, r)?.style?.numFmt).text;
  const onCopy = (e: React.ClipboardEvent, cut = false) => {
    if (editing !== null) return;
    e.preventDefault();
    const rows: string[][] = []; for (let r = selR.r0; r <= selR.r1; r++) { const row: string[] = []; for (let c = selR.c0; c <= selR.c1; c++) row.push(displayText(c, r)); rows.push(row); }
    const tsv = toTsv(rows); e.clipboardData.setData("text/plain", tsv);
    const values: Scalar[][] = []; for (let r = selR.r0; r <= selR.r1; r++) { const row: Scalar[] = []; for (let c = selR.c0; c <= selR.c1; c++) row.push(workbook.valueAt(active, c, r) ?? ""); values.push(row); }
    clipRef.current = { tsv, clip: copyBlock(sheet, selR), cut, range: selR, sheet: active, values };
    setStatus(`${cut ? "cut" : "copied"} ${rangeA1(selR)} — paste with Ctrl+V`);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing !== null) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const internal = clipRef.current && clipRef.current.tsv.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n").replace(/\n$/, "") ? clipRef.current : null;
    {
      const rows = internal ? internal.clip.inputs : parseTsv(text);
      const h = Math.max(1, rows.length), w = Math.max(1, rows[0]?.length ?? 1);
      const conflict = partialMergeConflict(sheet, { c0: selR.c0, r0: selR.r0, c1: Math.max(selR.c1, selR.c0 + w - 1), r1: Math.max(selR.r1, selR.r0 + h - 1) });
      if (conflict) { shell.toast(conflict, "warn"); setStatus(conflict); return; }
    }
    let out: Range = selR;
    mutate((wb, s) => {
      if (internal) {
        const h = internal.clip.inputs.length, w = internal.clip.inputs[0]?.length ?? 1;
        if (internal.cut) { clearRange(wb.sheet(internal.sheet), internal.range, "all"); }
        if (h === 1 && w === 1 && !internal.cut) { for (let r = selR.r0; r <= selR.r1; r++) for (let c = selR.c0; c <= selR.c1; c++) pasteBlock(s, internal.clip, c, r); }
        else out = pasteBlock(s, internal.clip, selR.c0, selR.r0);
      } else {
        const rows = parseTsv(text);
        out = pasteBlock(s, { inputs: rows, styles: [], origin: { col: selR.c0, row: selR.r0 } }, selR.c0, selR.r0, { valuesOnly: true });
      }
    });
    if (internal?.cut) clipRef.current = null;
    setSel({ a: { col: out.c0, row: out.r0 }, f: { col: Math.min(out.c1, COLS - 1), row: Math.min(out.r1, ROWS - 1) } });
  };

  const openPasteSpecial = () => {
    if (!clipRef.current) { const m = "Paste special uses this Spreadsheet's clipboard — copy cells here first (Ctrl+C)."; shell.toast(m, "warn"); setStatus(m); return; }
    setPsFrom(`${clipRef.current.sheet}!${rangeA1(clipRef.current.range)}`); setPanel("paste");
  };
  const doPasteSpecial = () => {
    const c = clipRef.current; if (!c) return;
    const h = c.clip.inputs.length, w = c.clip.inputs[0]?.length ?? 1;
    const [H, W] = ps.transpose ? [w, h] : [h, w];
    const conflict = partialMergeConflict(sheet, { c0: selR.c0, r0: selR.r0, c1: selR.c0 + W - 1, r1: selR.r0 + H - 1 });
    if (conflict) { shell.toast(conflict, "warn"); setStatus(conflict); return; }
    let out: Range = selR;
    mutate((wb, s) => { out = pasteSpecial(s, c.clip, c.values, selR.c0, selR.r0, ps, (col, row) => wb.valueAt(active, col, row)); });
    setSel({ a: { col: out.c0, row: out.r0 }, f: { col: Math.min(out.c1, COLS - 1), row: Math.min(out.r1, ROWS - 1) } });
    setStatus(`pasted ${ps.what}${ps.transpose ? ", transposed" : ""}${ps.skipBlanks ? ", skipping blanks" : ""}${ps.op && ps.op !== "none" ? `, ${ps.op}` : ""} into ${rangeA1(out)}`);
    setPanel(null); gridRef.current?.focus();
  };

  const doPasteLink = () => {
    const c = clipRef.current; if (!c) return;
    const h = c.clip.inputs.length, w = c.clip.inputs[0]?.length ?? 1;
    const conflict = partialMergeConflict(sheet, { c0: selR.c0, r0: selR.r0, c1: selR.c0 + w - 1, r1: selR.r0 + h - 1 });
    if (conflict) { shell.toast(conflict, "warn"); setStatus(conflict); return; }
    let out: Range = selR;
    mutate((_wb, s) => { out = pasteLink(s, c.clip, c.sheet, selR.c0, selR.r0); });
    setSel({ a: { col: out.c0, row: out.r0 }, f: { col: Math.min(out.c1, COLS - 1), row: Math.min(out.r1, ROWS - 1) } });
    setStatus(`pasted links to ${c.sheet}!${rangeA1(c.range)} into ${rangeA1(out)}`);
    setPanel(null); gridRef.current?.focus();
  };

  /* ------------------------------------------------------------ formatting + data ops */
  const styleOf = (p: Pos): CellStyle => sheet.get(p.col, p.row)?.style ?? {};
  const applyStyle = (patch: Partial<CellStyle> | null) => mutate((_wb, s) => { for (let r = selR.r0; r <= selR.r1; r++) for (let c = selR.c0; c <= selR.c1; c++) s.setStyle(c, r, patch); });
  const toggle = (k: "bold" | "italic" | "underline" | "wrap") => applyStyle({ [k]: !styleOf(sel.f)[k] });
  const fillDir = (dir: "down" | "right") => {
    // Excel: with a single cell selected, Ctrl+D copies from the cell above (Ctrl+R from the left)
    if (dir === "down") { const top = selR.r0 === selR.r1 ? Math.max(0, selR.r0 - 1) : selR.r0; mutate((_wb, s) => fillCopy(s, { ...selR, r0: top }, "down")); }
    else { const left = selR.c0 === selR.c1 ? Math.max(0, selR.c0 - 1) : selR.c0; mutate((_wb, s) => fillCopy(s, { ...selR, c0: left }, "right")); }
  };
  const dataRange = (): Range => (selR.c0 === selR.c1 && selR.r0 === selR.r1 ? currentRegion(has, sel.f.col, sel.f.row, COLS - 1, ROWS - 1) : selR);
  const sort = (asc: boolean) => {
    const r = dataRange(); const header = looksLikeHeader(workbook, active, r);
    const conflict = sortConflict(sheet, r); if (conflict) { shell.toast(conflict, "warn"); setStatus(conflict); return; }
    mutate((wb) => sortRange(wb, active, r, clamp(sel.f.col, r.c1, r.c0), asc, header));
    setStatus(`sorted ${rangeA1(r)} by ${colToLetters(clamp(sel.f.col, r.c1, r.c0))} ${asc ? "A to Z" : "Z to A"}${header ? " (header row kept)" : ""}`);
  };
  const structural = (axis: "row" | "col", insert: boolean) => {
    const at = axis === "row" ? selR.r0 : selR.c0; const n = axis === "row" ? selR.r1 - selR.r0 + 1 : selR.c1 - selR.c0 + 1;
    mutate((wb) => insertDelete(wb, active, axis, at, insert ? n : -n));
  };
  const doMerge = (mode: "center" | "across" | "merge" | "unmerge") => {
    if (mode === "unmerge") { let n = 0; mutate((_wb, s) => { n = unmergeCells(s, selR); }); setStatus(n ? `unmerged ${n} area(s)` : "nothing to unmerge"); return; }
    const filled = [...sheet.grid].filter(([k, c]) => { const [cc, rr] = k.split(",").map(Number); return c.input !== "" && cc >= selR.c0 && cc <= selR.c1 && rr >= selR.r0 && rr <= selR.r1; }).length;
    if (mode !== "across" && filled > 1 && !confirm("Merging cells only keeps the upper-left value and discards other values.")) return;
    let msg = "";
    mutate((_wb, s) => {
      if (mode === "across") { const r = mergeAcross(s, selR); msg = r.error ?? `merged ${r.merged} row(s)${r.discarded ? ` · ${r.discarded} value(s) discarded` : ""}`; }
      else { const r = mergeCells(s, selR); msg = r.ok ? `merged ${rangeA1(selR)}${r.discarded ? ` · ${r.discarded} value(s) discarded` : ""}` : r.error; if (r.ok && mode === "center") s.setStyle(selR.c0, selR.r0, { align: "center" }); }
    });
    setStatus(msg); setSel({ a: { col: selR.c0, row: selR.r0 }, f: { col: selR.c0, row: selR.r0 } });
  };
  const doBorders = (preset: BorderPreset) => {
    try { mutate((_wb, s) => applyBorders(s, selR, preset, { style: borderLine, color: borderColor })); setStatus(`borders: ${preset} on ${rangeA1(selR)}`); }
    catch (e) { shell.toast((e as Error).message, "warn"); }
  };
  const addValidation = () => {
    let formula1 = dvForm.f1.trim();
    try {
      if (dvForm.type === "list" && !/^=|^\$?[A-Z]{1,3}\$?\d/i.test(formula1)) formula1 = listFormula(formula1.split(","));
    } catch (e) { shell.toast((e as Error).message, "warn"); return; }
    const rule = sanitizeValidation({ id: nextId("dv", sheet.validations.map((v) => v.id)), sqref: rangeA1(selR), type: dvForm.type, operator: dvForm.operator, formula1, formula2: dvForm.f2,
      allowBlank: dvForm.allowBlank, errorStyle: dvForm.style, showError: true, inCellDropdown: dvForm.dropdown, error: dvForm.error || undefined, prompt: dvForm.prompt || undefined, promptTitle: dvForm.prompt ? "Input" : undefined });
    if (!rule) { shell.toast("That rule is incomplete (check the source / values).", "warn"); return; }
    mutate((_wb, s) => { s.validations = [...s.validations.filter((v) => !(v.sqref === rule.sqref)), rule]; });
    setStatus(`validation (${rule.type}) applied to ${rule.sqref}`);
  };
  const addChart = (kind: ChartKind) => {
    const r = dataRange();
    const id = nextId("chart", workbook.charts.map((c) => c.id));
    mutate((wb) => { wb.charts.push({ id, sheet: active, range: rangeA1(r).includes(":") ? rangeA1(r) : `${rangeA1(r)}:${rangeA1(r)}`, kind, title: String(workbook.valueAt(active, Math.min(r.c0 + 1, r.c1), r.r0) ?? "Chart"), headerRow: looksLikeHeader(workbook, active, r) }); });
    setPanel("charts");
  };
  const addCf = () => {
    const id = nextId("cf", workbook.condFormats.map((c) => c.id));
    const range = rangeA1(selR).includes(":") ? rangeA1(selR) : `${rangeA1(selR)}:${rangeA1(selR)}`;
    const k = cf.kind;
    const fmt = { fill: cf.fill, color: cf.color, ...(cf.bold ? { bold: true } : {}), ...(cf.stop ? { stop: true } : {}) };
    const formulaOk = (f: string) => { try { parseFormula("=" + f); return true; } catch { return false; } };
    // cellIs operand: a number, text (= and ≠ only), or "=formula" relative to the range's top-left cell
    const operand = (v: string, key: "a" | "b", textOk: boolean): Partial<CondRule> | null => {
      const t = v.trim();
      if (t.startsWith("=")) return t.length > 1 && formulaOk(t.slice(1)) ? { [key + "f"]: t.slice(1) } : null;
      if (t !== "" && Number.isFinite(Number(t))) return { [key]: t };
      return textOk ? { [key]: v } : null;
    };
    let rule: CondRule | null = null;
    if (k === "scale" || k === "scale3") rule = { id, sheet: active, range, kind: "scale", scaleMin: cf.sMin, scaleMax: cf.sMax, ...(k === "scale3" ? { scaleMid: cf.sMid, scaleAt: "min|percentile:50|max" } : { scaleAt: "min|max" }) };
    else if (k === "bar") rule = { id, sheet: active, range, kind: "bar", barColor: cf.barColor, cfvo: [{ t: "min" }, { t: "max" }] };
    else if (k === "icons") { const n = ICON_SETS[cf.iconSet]?.length ?? 3; const pct = n === 5 ? [0, 20, 40, 60, 80] : n === 4 ? [0, 25, 50, 75] : [0, 33, 67]; rule = { id, sheet: active, range, kind: "icons", iconSet: cf.iconSet, cfvo: pct.map((p) => ({ t: "percent" as const, v: String(p) })), ...(cf.reverse ? { reverse: true } : {}) }; }
    else if (k === "expr") { const f = cf.formula.trim().replace(/^=/, ""); if (!f || !formulaOk(f)) { shell.toast("Enter a valid formula, e.g. =$B2>100", "warn"); return; } rule = { id, sheet: active, range, kind: "expr", formula: f, ...fmt }; }
    else if (k === "period") rule = { id, sheet: active, range, kind: "period", period: cf.period, ...fmt };
    else if (k === "top" || k === "bottom" || k === "topPct" || k === "bottomPct") {
      const n = Math.trunc(Number(cf.a)); if (!(n >= 1 && n <= (k.endsWith("Pct") ? 100 : 1000))) { shell.toast("Enter a whole number for N.", "warn"); return; }
      rule = { id, sheet: active, range, kind: "top", a: String(n), ...(k.startsWith("bottom") ? { bottom: true } : {}), ...(k.endsWith("Pct") ? { pct: true } : {}), ...fmt };
    } else if (k === "aboveAvg" || k === "belowAvg") rule = { id, sheet: active, range, kind: "aboveAvg", ...(k === "belowAvg" ? { below: true } : {}), ...fmt };
    else if (k === "contains" || k === "notContains" || k === "begins" || k === "ends") rule = { id, sheet: active, range, kind: k, a: cf.a, ...fmt };
    else if (k === "blanks" || k === "noBlanks" || k === "errors" || k === "noErrors" || k === "duplicate" || k === "unique") rule = { id, sheet: active, range, kind: k, ...fmt };
    else {
      const two = k === "between" || k === "notBetween";
      const p = operand(cf.a, "a", k === "eq" || k === "ne"), q = two ? operand(cf.b, "b", false) : {};
      if (!p || !q) { shell.toast("Enter a number (or =formula) for the rule value.", "warn"); return; }
      rule = { id, sheet: active, range, kind: k, ...p, ...q, ...fmt };
    }
    const r = rule;
    mutate((wb) => { wb.condFormats.push(r); });
  };
  const findNext = () => {
    const hits = findAll(workbook, findQ, { matchCase }); if (!hits.length) { setFindInfo("no matches"); return; }
    const order = [...workbook.sheets.keys()];
    const after = hits.findIndex((h) => order.indexOf(h.sheet) > order.indexOf(active) || (h.sheet === active && (h.row > sel.f.row || (h.row === sel.f.row && h.col > sel.f.col))));
    const i = after < 0 ? 0 : after; const h = hits[i];
    if (h.sheet !== active) setActive(h.sheet);
    moveTo({ col: h.col, row: h.row }); setFindInfo(`${i + 1} of ${hits.length}`);
  };

  /* ------------------------------------------------------------ mouse */
  const cellDown = (e: React.MouseEvent, p: Pos) => {
    if (e.button !== 0) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && editing === null && followLink(p.col, p.row)) { e.preventDefault(); return; }
    if (editing !== null && editing.startsWith("=") && /[=(,+\-*/^&<>:;]$/.test(editing)) { e.preventDefault(); dragRef.current = { mode: "point", prefix: editing, start: p }; setEditing(editing + (active !== editSheet ? `${quoteSheet(active)}!` : "") + a1(p.col, p.row)); return; }
    commit(null); setListOpen(false);
    if (e.shiftKey) setSel((s) => ({ a: s.a, f: p })); else setSel({ a: p, f: p });
    dragRef.current = { mode: "select" }; gridRef.current?.focus();
  };
  const cellEnter = (p: Pos) => {
    const d = dragRef.current; if (!d) return;
    if (d.mode === "select") setSel((s) => ({ a: s.a, f: p }));
    else if (d.mode === "fill") { d.target = fillTarget(selR, p.col, p.row); setFillPreview(d.target); }
    else if (d.mode === "point") setEditing(d.prefix + rangeA1({ c0: d.start.col, r0: d.start.row, c1: p.col, r1: p.row }));
  };
  useEffect(() => {
    const move = (e: MouseEvent) => { const d = dragRef.current; if (d?.mode === "resize") { sheet.colWidths[d.col] = Math.max(24, Math.min(800, Math.round((d.w + e.clientX - d.x) / k))); setRev((r) => r + 1); } };
    const up = () => {
      const d = dragRef.current; dragRef.current = null;
      if (d?.mode === "fill" && d.target) { const t = d.target; mutate((_wb, s) => autoFill(s, selR, t)); setSel({ a: { col: t.c0, row: t.r0 }, f: { col: t.c1, row: t.r1 } }); }
      if (d?.mode === "fill") setFillPreview(null);
      if (d?.mode === "resize") setDirty(true);
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  });

  /* ------------------------------------------------------------ virtualisation */
  useEffect(() => {
    const el = gridRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight }))); ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);
  const frozen = Math.min(sheet.freezeRows, 1);
  const first = Math.max(frozen, Math.floor(scroll.top / ROW_H) - 6);
  const last = Math.min(ROWS - 1, first + Math.ceil(scroll.h / ROW_H) + 12);

  /* ------------------------------------------------------------ derived render data */
  const cfMap = useMemo(() => evalCondFormats(workbook, active, workbook.condFormats), [workbook, active, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const spills = useMemo(() => {
    const out: Range[] = [];
    for (const [k, c] of sheet.grid) if (c.spill && (c.spill.rows > 1 || c.spill.cols > 1)) { const [col, row] = k.split(",").map(Number); out.push({ c0: col, r0: row, c1: col + c.spill.cols - 1, r1: row + c.spill.rows - 1 }); }
    return out;
  }, [sheet, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useMemo(() => selectionStats(workbook, active, selR), [workbook, active, selR, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const charts = workbook.charts.filter((c) => c.sheet === active);
  const invalid = useMemo(() => (showInvalid ? new Set(invalidCells(workbook, active).map((p) => `${p.col},${p.row}`)) : null), [showInvalid, workbook, active, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const curRule = ruleAt(sheet, sel.f.col, sel.f.row);
  const fc = Math.min(sheet.freezeCols, 1);
  // List menu lives in grid space: a cell has overflow:hidden, which clipped it (found by visual inspection, TT17).
  const listMenu = (() => {
    if (!curRule || curRule.type !== "list" || !listOpen || editing !== null) return null;
    const m = mergeAt(sheet, sel.f.col, sel.f.row); const col = m ? m.c0 : sel.f.col, row = m ? m.r0 : sel.f.row, below = m ? m.r1 : sel.f.row;
    let left = ROWHDR_W; for (let c = 0; c < col; c++) left += colW(c);
    return { col, row, left, top: listUp ? HEAD_H + row * ROW_H : HEAD_H + (below + 1) * ROW_H, transform: listUp ? "translateY(-100%)" : undefined, width: Math.max(colW(col), 120 * k), items: listItems(workbook, active, curRule), cur: String(workbook.valueAt(active, col, row) ?? "") };
  })();
  let totalW = ROWHDR_W; for (let c = 0; c < COLS; c++) totalW += colW(c); // 52 additions; cheaper than a memo
  const selInput = sheet.get(sel.f.col, sel.f.row)?.input ?? "";
  const cur = styleOf(sel.f);

  if (!loaded) return <div style={{ padding: 16, fontSize: fz(12) }}>Loading…</div>;

  const renderCell = (col0: number, row0: number, segStart: number, segEnd: number) => {
    // Merged area: render once, at its top-left column and the first row of it visible in this segment.
    const m = mergeAt(sheet, col0, row0);
    if (m && (col0 !== m.c0 || row0 !== Math.max(m.r0, segStart))) return null;
    const col = m ? m.c0 : col0, row = m ? m.r0 : row0;
    const span = m ? { colSpan: m.c1 - m.c0 + 1, rowSpan: Math.min(m.r1, segEnd) - row0 + 1 } : {};
    const cell = sheet.get(col, row); const st = cell?.style ?? {};
    const v: Scalar | undefined = workbook.valueAt(active, col, row);
    const over = cfMap.get(`${col},${row}`);
    const fmt = formatValue(v, over?.numFmt ?? st.numFmt);
    const inSel = col >= selR.c0 && col <= selR.c1 && row >= selR.r0 && row <= selR.r1;
    const isCur = m ? sel.f.col >= m.c0 && sel.f.col <= m.c1 && sel.f.row >= m.r0 && sel.f.row <= m.r1 : sel.f.col === col && sel.f.row === row;
    const rEdge = edgeAt(sheet, m ? m.c1 : col, row, "right"), bEdge = edgeAt(sheet, col, m ? m.r1 : row, "bottom");
    const tEdge = row === 0 ? edgeAt(sheet, col, row, "top") : undefined, lEdge = col === 0 ? edgeAt(sheet, col, row, "left") : undefined;
    const rule = isCur ? curRule : undefined;
    const bad = invalid?.has(`${col},${row}`);
    const stickyCol = fc > 0 && col === 0;
    const inFill = fillPreview && col >= fillPreview.c0 && col <= fillPreview.c1 && row >= fillPreview.r0 && row <= fillPreview.r1;
    const sp = spills.find((r) => col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1);
    const edge = "1px dashed #60a5fa", base = "1px solid var(--fs-border)";
    const err = v !== undefined && isError(v as never);
    const align = st.align ?? (typeof v === "number" ? "right" : typeof v === "boolean" || err ? "center" : "left");
    const editingHere = editing !== null && editSrc === "cell" && editAt.col === col && editAt.row === row && editSheet === active;
    const isFillCorner = !editing && col === selR.c1 && row === selR.r1;
    const link = cellLink(workbook, active, col, row);
    const linkTip = link ? `${link.tooltip ?? link.target ?? link.location ?? ""}${link.target || link.location ? " — Ctrl+click to follow" : ""}` : undefined;
    return (
      <td key={col0} data-cell={a1(col, row)} {...span} data-merge={m ? `${a1(m.c0, m.r0)}:${a1(m.c1, m.r1)}` : undefined} onMouseDown={(e) => cellDown(e, { col, row })} onMouseEnter={() => cellEnter({ col, row })}
        onDoubleClick={() => startEdit(cell?.input ?? "")} title={cell?.error ?? linkTip ?? (sp && !(sp.c0 === col && sp.r0 === row) ? `spilled from ${a1(sp.c0, sp.r0)}` : undefined)} data-link={link ? (link.target ?? link.location ?? "") : undefined}
        style={{
          position: stickyCol ? "sticky" : "relative", left: stickyCol ? ROWHDR_W : undefined, zIndex: stickyCol ? 1 : undefined, verticalAlign: m ? (st.valign === "top" ? "top" : st.valign === "center" ? "middle" : "bottom") : undefined,
          height: ROW_H, padding: "0 5px", overflow: editingHere ? "visible" : "hidden", textOverflow: "ellipsis", whiteSpace: st.wrap ? "normal" : "nowrap", cursor: "cell",
          borderTop: sp && row === sp.r0 ? edge : base, borderBottom: sp && row === sp.r1 ? edge : base, borderLeft: sp && col === sp.c0 ? edge : base, borderRight: sp && col === sp.c1 ? edge : base,
          fontWeight: st.bold || over?.bold ? 700 : undefined, fontStyle: st.italic || over?.italic ? "italic" : undefined, textDecoration: [st.underline || over?.underline || (link && (link.target || link.location)) ? "underline" : "", over?.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined, textAlign: align,
          paddingLeft: over?.icon ? 22 : undefined,
          // TT22: theme tokens (light theme had pale-blue formula text), and "automatic" ink on filled cells with no
          // explicit font colour — white or near-black by the fill's luminance (display only; the document is unchanged)
          color: err ? "var(--fs-bad-text, #ff9b9b)" : fmt.color ?? over?.color ?? st.color ?? autoInk(over?.fill ?? st.fill) ?? (link && (link.target || link.location) ? "var(--fs-link, #4ea1ff)" : undefined) ?? (cell?.formula ? "var(--fs-cell-formula, #bcd4ff)" : "var(--fs-text)"),
          background: inFill ? "rgba(96,165,250,.18)" : inSel && !isCur ? `linear-gradient(rgba(91,140,255,.18),rgba(91,140,255,.18)),${over?.fill ?? st.fill ?? (stickyCol ? "var(--fs-bg, #0b1020)" : "transparent")}` : over?.fill ?? st.fill ?? (stickyCol ? "var(--fs-bg, #0b1020)" : "transparent"),
          outline: isCur ? "2px solid var(--fs-accent)" : undefined, outlineOffset: -2,
        }}>
        {editingHere ? (
          <>
            <input autoFocus className="fs-input fs-mono" aria-label="Cell editor" style={{ padding: "0 2px", border: 0, height: ROW_H - 2, width: Math.max(colW(col) - 10, 160), position: "relative", zIndex: 5 }}
              value={editing ?? ""} onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }} onChange={(e) => { setEditing(e.target.value); setAcIdx(0); }} onKeyDown={editKeys} onBlur={() => { if (!dragRef.current) commit(null); }} />
            {renderAssist()}
          </>
        ) : over?.bar || over?.icon || over?.hideValue ? cfDecor(over, fmt.text) : fmt.text}
        {rEdge || bEdge || tEdge || lEdge ? <div aria-hidden data-border={[tEdge && "t", rEdge && "r", bEdge && "b", lEdge && "l"].filter(Boolean).join("")}
          style={{ position: "absolute", top: tEdge ? 0 : -1, left: lEdge ? 0 : -1, right: -1, bottom: -1, borderRight: borderCss(rEdge), borderBottom: borderCss(bEdge), borderTop: borderCss(tEdge), borderLeft: borderCss(lEdge), pointerEvents: "none", zIndex: 2 }} /> : null}
        {over?.border ? <div aria-hidden data-cf-border={(["top", "right", "bottom", "left"] as const).filter((k) => over.border![k]).map((k) => k[0]).join("")}
          style={{ position: "absolute", inset: 0, borderTop: borderCss(over.border.top), borderRight: borderCss(over.border.right), borderBottom: borderCss(over.border.bottom), borderLeft: borderCss(over.border.left), pointerEvents: "none", zIndex: 2 }} /> : null}
        {bad ? <div aria-hidden data-invalid="1" style={{ position: "absolute", inset: "1px 2px", border: "2px solid #ef4444", borderRadius: "50%", pointerEvents: "none", zIndex: 2 }} /> : null}
        {rule && rule.type === "list" && rule.inCellDropdown && !editingHere ? (
          <button type="button" aria-label="Show list" data-testid="list-arrow" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); openList(true, e.currentTarget); }}
            style={{ position: "absolute", right: 1, top: 1, width: 16, height: ROW_H - 3, padding: 0, border: "1px solid var(--fs-border)", borderRadius: 3, background: "var(--fs-bg-2, #131a2b)", color: "inherit", cursor: "pointer", zIndex: 4 }}>
            <svg width="8" height="6" viewBox="0 0 8 6" style={{ display: "block", margin: "auto" }}><path d="M0 0h8L4 6z" fill="currentColor" /></svg>
          </button>) : null}
        {isFillCorner ? <div data-testid="fill-handle" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); dragRef.current = { mode: "fill", target: null }; }}
          style={{ position: "absolute", right: -1, bottom: -1, width: 7, height: 7, background: "var(--fs-accent)", border: "1px solid #fff", cursor: "crosshair", zIndex: 3 }} /> : null}
      </td>
    );
  };
  /** TT49: data bar / icon layers of a conditionally formatted cell; a hidden value (showValue="0") stays readable to screen readers. */
  const cfDecor = (over: CfStyle, text: string) => {
    const b = over.bar;
    const barBg = b ? (b.solid ? b.color : `linear-gradient(${b.negative ? 270 : 90}deg, ${b.color}, ${b.color}33)`) : undefined;
    return (
      <>
        {b ? <span aria-hidden data-cf-bar={`${b.from.toFixed(3)}-${b.to.toFixed(3)}`} data-cf-bar-color={b.color}
          style={{ position: "absolute", left: `${b.from * 100}%`, width: `${Math.max(0, b.to - b.from) * 100}%`, top: 2, bottom: 2, background: barBg, border: b.border ? `1px solid ${b.border}` : undefined, borderRadius: 1, pointerEvents: "none", zIndex: 0 }} /> : null}
        {b && b.axis !== undefined && b.axis > 0 && b.axis < 1 ? <span aria-hidden style={{ position: "absolute", left: `${b.axis * 100}%`, top: 0, bottom: 0, borderLeft: `1px dashed ${b.axisColor ?? "#000"}`, pointerEvents: "none", zIndex: 0 }} /> : null}
        {over.icon ? <img alt="" aria-hidden data-cf-icon={over.icon} src={iconDataUri(over.icon)} width={14} height={14} style={{ position: "absolute", left: 4, top: (ROW_H - 14) / 2, pointerEvents: "none" }} /> : null}
        {over.icon ? <span className="fs-visually-hidden">{iconLabel(over.icon)}: </span> : null}
        <span className={over.hideValue ? "fs-visually-hidden" : undefined} style={{ position: "relative", zIndex: 1 }}>{text}</span>
      </>
    );
  };
  const renderAssist = () => (acList.length || call) ? (
    <div className="fs-card" data-testid="formula-assist" style={{ position: "absolute", top: "100%", left: 0, zIndex: 20, minWidth: 220, padding: 4, fontSize: fz(11.5), background: "var(--fs-panel, #111827)", border: "1px solid var(--fs-border)", borderRadius: 6, boxShadow: "0 6px 20px rgba(0,0,0,.4)", textAlign: "left", whiteSpace: "nowrap" }}>
      {acList.map((n, i) => (
        <div key={n} data-ac={n} onMouseDown={(e) => { e.preventDefault(); acceptCompletion(n); }} style={{ padding: "2px 6px", borderRadius: 4, cursor: "pointer", background: i === acIdx ? "rgba(91,140,255,.25)" : undefined }} className="fs-mono">
          {n}{SIGNATURES[n] ? <span className="fs-dim">({SIGNATURES[n].join(", ")})</span> : null}
        </div>
      ))}
      {!acList.length && call ? <div className="fs-mono" data-testid="arg-hint">{call.name}(
        {(SIGNATURES[call.name] ?? ["…"]).map((a, i, arr) => <span key={i} style={{ fontWeight: i === Math.min(call.arg, arr.length - 1) ? 700 : 400, color: i === Math.min(call.arg, arr.length - 1) ? "#fff" : undefined }}>{a}{i < arr.length - 1 ? ", " : ""}</span>)})
        {!SIGNATURES[call.name] && !fnNames.includes(call.name) ? <span style={{ color: "var(--fs-bad-text, #ff9b9b)" }}> unknown function</span> : null}</div> : null}
      {acList.length ? <div className="fs-dim" style={{ fontSize: fz(10), padding: "2px 6px" }}>Tab to insert, Up/Down to choose</div> : null}
    </div>
  ) : null;

  const row = (r: number, sticky = false, segStart = r, segEnd = r) => (
    <tr key={r} style={sticky ? { position: "sticky", top: HEAD_H, zIndex: 2, background: "var(--fs-bg, #0b1020)" } : undefined}>
      <td className="fs-dim" onMouseDown={() => { commit(null); setSel({ a: { col: 0, row: r }, f: { col: COLS - 1, row: r } }); gridRef.current?.focus(); }}
        style={{ position: "sticky", left: 0, zIndex: 1, textAlign: "center", fontSize: fz(10.5), background: r >= selR.r0 && r <= selR.r1 ? "linear-gradient(rgba(91,140,255,.22), rgba(91,140,255,.22)), var(--fs-bg-2, #131a2b)" : "var(--fs-bg-2, #131a2b)", borderRight: "1px solid var(--fs-border)", borderBottom: sticky ? "2px solid #475569" : "1px solid var(--fs-border)", cursor: "e-resize" }}>{r + 1}</td>
      {Array.from({ length: COLS }, (_, c) => renderCell(c, r, segStart, segEnd))}
    </tr>
  );


  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={() => void save()}>Save workbook</Btn>
        <Btn variant="ghost" onClick={() => void exportXlsx()}>Export .xlsx</Btn>
        <Btn variant="ghost" data-testid="sheet-password" aria-pressed={locked} disabled={!/\.xlsx$/i.test(path)} title={/\.xlsx$/i.test(path) ? "Set, change or remove the file's password" : "Export as .xlsx first — passwords protect .xlsx files"} onClick={async () => {
          const cur = encRef.current;
          if (saveBlocked(cur, path) || (cur?.wasEncrypted && !cur.plain)) { setStatus("unlock the workbook first (reopen it and enter its password)"); return; }
          const np = await askPassword(path.split("/").pop() || "workbook.xlsx", cur, path);
          if (!np) return;
          encRef.current = { ...np, plain: cur?.plain ?? null }; setLocked(!!np.password); setDirty(true);
          setStatus(np.password ? "password set — the next save encrypts the workbook (AES-256)" : "password removed — the next save writes the workbook without encryption");
        }}>{locked ? "Password: on" : "Password…"}</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import .xlsx<input type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importXlsx(f); }} /></label>
        <Badge tone={dirty ? "warn" : "ok"}>{dirty ? "unsaved" : "saved"}</Badge>
        <Badge tone="info" title="First-party formula engine; see docs/OFFICE-ENGINE.md">from-scratch engine · {fnNames.length} functions</Badge>
        {status ? <span className="fs-dim" data-testid="sheet-status" style={{ fontSize: fz(11) }}>{status}</span> : null}
      </div>
      <div className="fs-row fs-toolbar" role="toolbar" aria-label="Formatting" data-testid="sheet-toolbar" style={{ padding: "4px 6px", gap: 3, borderBottom: "1px solid var(--fs-border)", alignItems: "center" }}>
        <TB label="Undo" onClick={undo} title={"Undo (Ctrl+Z)"} /><TB label="Redo" onClick={redo} title={"Redo (Ctrl+Y)"} />
        <span style={{ width: 6 }} />
        <TB label="B" onClick={() => toggle("bold")} active={!!cur.bold} title={"Bold (Ctrl+B)"} style={{ fontWeight: 700 }} />
        <TB label="I" onClick={() => toggle("italic")} active={!!cur.italic} title={"Italic (Ctrl+I)"} style={{ fontStyle: "italic" }} />
        <TB label="U" onClick={() => toggle("underline")} active={!!cur.underline} title={"Underline (Ctrl+U)"} style={{ textDecoration: "underline" }} />
        <TB label="Left" onClick={() => applyStyle({ align: "left" })} active={cur.align === "left"} title={"Align left"} />
        <TB label="Center" onClick={() => applyStyle({ align: "center" })} active={cur.align === "center"} title={"Align center"} />
        <TB label="Right" onClick={() => applyStyle({ align: "right" })} active={cur.align === "right"} title={"Align right"} />
        <TB label="Wrap" onClick={() => toggle("wrap")} active={!!cur.wrap} title={"Wrap text"} />
        <label className="fs-dim" title="Fill colour" style={{ fontSize: fz(11), display: "flex", alignItems: "center", gap: 2 }}>Fill<input aria-label="Fill colour" type="color" value={cur.fill ?? "#000000"} onChange={(e) => applyStyle({ fill: e.target.value })} style={{ width: 22, height: 20, border: 0, background: "none" }} /></label>
        <label className="fs-dim" title="Text colour" style={{ fontSize: fz(11), display: "flex", alignItems: "center", gap: 2 }}>Text<input aria-label="Text colour" type="color" value={cur.color ?? "#e5e7eb"} onChange={(e) => applyStyle({ color: e.target.value })} style={{ width: 22, height: 20, border: 0, background: "none" }} /></label>
        <select className="fs-input" aria-label="Number format" value={BUILTIN_FORMATS.some((f) => f.code === (cur.numFmt ?? "General")) ? cur.numFmt ?? "General" : "custom"} style={{ width: 150, fontSize: fz(11) }}
          onChange={async (e) => { const v = e.target.value; if (v === "custom") { const code = await askText("Custom number format", cur.numFmt ?? "General", { detail: "Excel syntax, for example #,##0.00;[Red]-#,##0.00", okLabel: "Apply" }); if (code) applyStyle({ numFmt: code }); } else applyStyle({ numFmt: v === "General" ? undefined : v }); }}>
          {BUILTIN_FORMATS.map((f) => <option key={f.code} value={f.code}>{f.label} — {f.code}</option>)}
          <option value="custom">Custom…{cur.numFmt && !BUILTIN_FORMATS.some((f) => f.code === cur.numFmt) ? ` (${cur.numFmt})` : ""}</option>
        </select>
        <TB label="Clear fmt" onClick={() => applyStyle(null)} title={"Clear formatting"} />
        <span style={{ width: 6 }} />
        <select className="fs-input" aria-label="Merge" value="" style={{ width: fz(92), fontSize: fz(11) }} onChange={(e) => { const v = e.target.value as "center" | "across" | "merge" | "unmerge"; if (v) doMerge(v); }}>
          <option value="">Merge…</option><option value="center">Merge &amp; Center</option><option value="across">Merge Across</option><option value="merge">Merge Cells</option><option value="unmerge">Unmerge Cells</option>
        </select>
        <select className="fs-input" aria-label="Borders" value="" style={{ width: fz(96), fontSize: fz(11) }} onChange={(e) => { const v = e.target.value as BorderPreset; if (v) doBorders(v); }}>
          <option value="">Borders…</option><option value="all">All Borders</option><option value="outside">Outside Borders</option><option value="thickOutside">Thick Outside Borders</option>
          <option value="inside">Inside Borders</option><option value="top">Top Border</option><option value="bottom">Bottom Border</option><option value="bottomDouble">Bottom Double Border</option>
          <option value="left">Left Border</option><option value="right">Right Border</option><option value="none">No Border</option>
        </select>
        <select className="fs-input" aria-label="Border line style" value={borderLine} style={{ width: fz(70), fontSize: fz(11) }} onChange={(e) => setBorderLine(e.target.value as BorderLine)}>
          {(["thin", "medium", "thick", "dashed", "dotted", "double", "hair"] as const).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input aria-label="Border colour" title="Border colour" type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} style={{ width: 22, height: 20, border: 0, background: "none" }} />
        <select className="fs-input" aria-label="Vertical alignment" value={cur.valign ?? ""} style={{ width: fz(86), fontSize: fz(11) }} onChange={(e) => applyStyle({ valign: (e.target.value || undefined) as CellStyle["valign"] })}>
          <option value="">V: bottom</option><option value="top">V: top</option><option value="center">V: middle</option><option value="bottom">V: bottom*</option>
        </select>
        <span style={{ width: 6 }} />
        <TB label="Sort A-Z" onClick={() => sort(true)} title={"Sort ascending by the active column"} /><TB label="Sort Z-A" onClick={() => sort(false)} title={"Sort descending by the active column"} />
        <TB label="+Row" onClick={() => structural("row", true)} title={"Insert rows above selection"} /><TB label="-Row" onClick={() => structural("row", false)} title={"Delete selected rows"} />
        <TB label="+Col" onClick={() => structural("col", true)} title={"Insert columns left of selection"} /><TB label="-Col" onClick={() => structural("col", false)} title={"Delete selected columns"} />
        <TB label="Freeze" onClick={() => mutate((_wb, s) => { s.freezeRows = s.freezeRows ? 0 : 1; })} active={sheet.freezeRows > 0} title={"Freeze top row"} />
        <TB label="Freeze col" onClick={() => mutate((_wb, s) => { s.freezeCols = s.freezeCols ? 0 : 1; })} active={sheet.freezeCols > 0} title={"Freeze first column"} />
        <span style={{ width: 6 }} />
        <TB label="Chart" onClick={() => addChart("bar")} title={"Insert a chart from the selection (or current region)"} />
        <TB label={`Charts${charts.length ? ` (${charts.length})` : ""}`} onClick={() => setPanel(panel === "charts" ? null : "charts")} active={panel === "charts"} title="Show charts" />
        <TB label="Cond. format" onClick={() => setPanel(panel === "cf" ? null : "cf")} active={panel === "cf"} title={"Conditional formatting rules"} />
        <TB label="Paste special" onClick={() => (panel === "paste" ? setPanel(null) : openPasteSpecial())} active={panel === "paste"} title={"Paste special: values / formulas / formats, operation, skip blanks, transpose (Ctrl+Shift+V)"} />
        <TB label="PivotTable" onClick={() => (panel === "pivot" ? setPanel(null) : openPivotPanel())} active={panel === "pivot"} title={"Insert a PivotTable from the selection (or current region), or edit the one under the cursor"} />
        <TB label="Refresh All" onClick={() => refreshPivotUi(false)} title={"Refresh every PivotTable from its source (Ctrl+Alt+F5; Alt+F5 refreshes the one under the cursor)"} />
        <TB label="Link" onClick={() => (panel === "link" ? setPanel(null) : openLinkPanel())} active={panel === "link"} title={"Insert link (Ctrl+K) — Ctrl+click a linked cell to follow it"} />
        <TB label="Find" onClick={() => setPanel(panel === "find" ? null : "find")} active={panel === "find"} title={"Find & replace (Ctrl+F)"} />
        <TB label="Spelling" onClick={() => (panel === "spell" ? setPanel(null) : openSpelling())} active={panel === "spell"} title={"Check spelling (F7)"} />
        <TB label={`Names${workbook.names.size ? ` (${workbook.names.size})` : ""}`} onClick={() => setPanel(panel === "names" ? null : "names")} active={panel === "names"} title={"Name Manager (Ctrl+F3)"} />
        <TB label={`Validation${sheet.validations.length ? ` (${sheet.validations.length})` : ""}`} onClick={() => setPanel(panel === "dv" ? null : "dv")} active={panel === "dv"} title={"Data validation"} />
        <TB label="Circle invalid" onClick={() => setShowInvalid((x) => !x)} active={showInvalid} title={"Circle invalid data"} />
      </div>
      <div className="fs-row" style={{ gap: 4, padding: "4px 6px", borderBottom: "1px solid var(--fs-border)", overflowX: "auto" }}>
        {[...workbook.sheets.keys()].map((name) => (
          <button key={name} className="fs-btn" data-variant={name === active ? "primary" : "ghost"} onClick={() => switchSheet(name)} onDoubleClick={() => renameSheet(name)} title="Double-click to rename">{name}</button>
        ))}
        <Btn variant="ghost" onClick={newSheet}>+ Sheet</Btn>
        <Btn variant="ghost" onClick={() => renameSheet(active)}>Rename</Btn>
        <Btn variant="ghost" onClick={() => deleteSheet(active)}>Delete</Btn>
        <span className="fs-dim" style={{ fontSize: fz(10.5), marginLeft: "auto" }}>{workbook.sheets.size} sheets · cross-sheet formulas (e.g. =TaxRate!B1)</span>
      </div>
      <div className="fs-row" style={{ padding: "4px 8px", gap: 6, borderBottom: "1px solid var(--fs-border)", position: "relative" }}>
        <input className="fs-input fs-mono" data-testid="name-box" aria-label="Name Box" title="Name Box: type a name to define it for the selection, or a name/reference to go there"
          style={{ fontSize: fz(11.5), width: fz(92) }} value={nameBox ?? nameBoxDisplay} onFocus={(e) => { setNameBox(nameBoxDisplay); requestAnimationFrame(() => e.target.select()); }}
          onChange={(e) => setNameBox(e.target.value)} onBlur={() => setNameBox(null)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitNameBox(nameBox ?? ""); gridRef.current?.focus(); } else if (e.key === "Escape") { setNameBox(null); gridRef.current?.focus(); } }} />
        <span className="fs-dim fs-mono" style={{ fontSize: fz(12) }}>ƒx</span>
        <div style={{ flex: 1, position: "relative" }}>
          <input className="fs-input fs-mono" style={{ width: "100%" }} aria-label="Formula bar"
            value={editing !== null ? editing : selInput} onChange={(e) => { if (editing === null) startEdit(e.target.value, "bar"); else setEditing(e.target.value); setAcIdx(0); }}
            onFocus={() => { if (editing === null) startEdit(selInput, "bar"); else setEditSrc("bar"); }} onKeyDown={editKeys} onBlur={() => { if (!dragRef.current) commit(null); }} />
          {editing !== null && editSrc === "bar" ? renderAssist() : null}
        </div>
      </div>
      {dvAlert ? (
        <div role="alertdialog" aria-label={dvAlert.title} data-testid="dv-alert" data-style={dvAlert.style} className="fs-row" style={{ gap: 8, padding: "5px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(12), alignItems: "center",
          background: dvAlert.style === "stop" ? "rgba(239,68,68,.16)" : dvAlert.style === "warning" ? "rgba(234,179,8,.16)" : "rgba(59,130,246,.16)" }}>
          <b>{dvAlert.title}</b><span>{dvAlert.message}</span><span className="fs-dim fs-mono">({dvAlert.text} in {a1(dvAlert.col, dvAlert.row)})</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {dvAlert.style === "stop" ? <><Btn variant="primary" onClick={() => resolveAlert(false, true)}>Retry</Btn><Btn variant="ghost" onClick={() => resolveAlert(false)}>Cancel</Btn></>
              : dvAlert.style === "warning" ? <><span>Continue?</span><Btn variant="primary" onClick={() => resolveAlert(true)}>Yes</Btn><Btn variant="ghost" onClick={() => resolveAlert(false, true)}>No</Btn><Btn variant="ghost" onClick={() => resolveAlert(false)}>Cancel</Btn></>
                : <><Btn variant="primary" onClick={() => resolveAlert(true)}>OK</Btn><Btn variant="ghost" onClick={() => resolveAlert(false)}>Cancel</Btn></>}
          </span>
        </div>
      ) : null}
      {panel === "dv" ? (
        <div data-testid="dv-panel" style={{ padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5) }}>
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span>Allow in <b className="fs-mono">{rangeA1(selR)}</b></span>
            <select className="fs-input" aria-label="Validation type" value={dvForm.type} onChange={(e) => setDvForm({ ...dvForm, type: e.target.value as ValidationType })} style={{ width: 110 }}>
              <option value="list">List</option><option value="whole">Whole number</option><option value="decimal">Decimal</option><option value="date">Date (serial)</option><option value="textLength">Text length</option><option value="custom">Custom formula</option>
            </select>
            {dvForm.type !== "list" && dvForm.type !== "custom" ? (
              <select className="fs-input" aria-label="Validation operator" value={dvForm.operator} onChange={(e) => setDvForm({ ...dvForm, operator: e.target.value as ValidationOp })} style={{ width: 130 }}>
                {VALIDATION_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>) : null}
            <input className="fs-input" aria-label={dvForm.type === "list" ? "List source" : dvForm.type === "custom" ? "Formula" : "Minimum or value"} value={dvForm.f1} onChange={(e) => setDvForm({ ...dvForm, f1: e.target.value })} style={{ width: 170 }}
              placeholder={dvForm.type === "list" ? "a,b,c or $F$1:$F$9" : dvForm.type === "custom" ? "MOD(A1,2)=0" : "value / =A1"} />
            {dvForm.type !== "list" && dvForm.type !== "custom" && (dvForm.operator === "between" || dvForm.operator === "notBetween") ? <input className="fs-input" aria-label="Maximum" value={dvForm.f2} onChange={(e) => setDvForm({ ...dvForm, f2: e.target.value })} style={{ width: 80 }} /> : null}
            <select className="fs-input" aria-label="Error style" value={dvForm.style} onChange={(e) => setDvForm({ ...dvForm, style: e.target.value as DataValidation["errorStyle"] })} style={{ width: 100 }}>
              <option value="stop">Stop</option><option value="warning">Warning</option><option value="information">Information</option>
            </select>
            <input className="fs-input" aria-label="Error message" placeholder="error message" value={dvForm.error} onChange={(e) => setDvForm({ ...dvForm, error: e.target.value.slice(0, 255) })} style={{ width: 150 }} />
            <input className="fs-input" aria-label="Input message" placeholder="input message" value={dvForm.prompt} onChange={(e) => setDvForm({ ...dvForm, prompt: e.target.value.slice(0, 255) })} style={{ width: 130 }} />
            <label><input type="checkbox" checked={dvForm.allowBlank} onChange={(e) => setDvForm({ ...dvForm, allowBlank: e.target.checked })} /> ignore blank</label>
            {dvForm.type === "list" ? <label><input type="checkbox" checked={dvForm.dropdown} onChange={(e) => setDvForm({ ...dvForm, dropdown: e.target.checked })} /> in-cell dropdown</label> : null}
            <Btn variant="primary" onClick={addValidation}>Apply rule</Btn>
            <Btn variant="ghost" onClick={() => mutate((_wb, s) => { s.validations = s.validations.filter((v) => !v.sqref.split(" ").some((p) => { const r = parseRange(p); return r && r.c0 <= selR.c1 && selR.c0 <= r.c1 && r.r0 <= selR.r1 && selR.r0 <= r.r1; })); })}>Clear rules here</Btn>
          </div>
          {sheet.validations.map((v) => (
            <div key={v.id} className="fs-row" data-dv={v.id} style={{ gap: 6, marginTop: 3 }}>
              <span className="fs-mono">{v.sqref}</span><span>{v.type}{v.operator && v.type !== "list" ? ` ${v.operator}` : ""} {v.formula1}{v.formula2 ? ` … ${v.formula2}` : ""}</span><span className="fs-dim">{v.errorStyle}{v.showError ? "" : " (no alert)"}</span>
              <button className="fs-btn" data-variant="ghost" onClick={() => mutate((_wb, s) => { s.validations = s.validations.filter((x) => x.id !== v.id); })}>remove</button>
            </div>
          ))}
          <div className="fs-dim" style={{ fontSize: fz(10.5), marginTop: 3 }}>As in Excel: rules check typed entries only (paste replaces cells without checking; use Circle invalid to audit). Only Stop blocks. Typed lists are limited to 255 characters.</div>
        </div>
      ) : null}
      {panel === "names" ? (
        <div data-testid="names-panel" style={{ padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5), display: "grid", gap: 4, maxHeight: 200, overflow: "auto" }}>
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <b>Name Manager</b>
            <input className="fs-input fs-mono" aria-label="New name" placeholder="Name" value={newName.name} onChange={(e) => setNewName({ ...newName, name: e.target.value })} style={{ width: 120 }} />
            <input className="fs-input fs-mono" aria-label="Refers to" placeholder={absoluteRef(active, selR.c0, selR.r0, selR.c1, selR.r1)} value={newName.ref} onChange={(e) => setNewName({ ...newName, ref: e.target.value })} style={{ width: 200 }} />
            <select className="fs-select" aria-label="Scope" style={{ width: fz(130), flex: "0 0 auto" }} value={newName.scope} onChange={(e) => setNewName({ ...newName, scope: e.target.value })}>
              <option value="">Workbook</option>{[...workbook.sheets.keys()].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <Btn variant="primary" onClick={() => {
              const ref = newName.ref.trim() || absoluteRef(active, selR.c0, selR.r0, selR.c1, selR.r1);
              const bad = validateName(newName.name.trim());
              if (bad) { setStatus(`Name Manager: ${bad}`); return; }
              try { parseFormula(`=${ref.replace(/^=/, "")}`); } catch (er) { setStatus(`Name Manager: ${(er as Error).message}`); return; }
              mutate((wb) => wb.defineName(newName.name.trim(), ref, newName.scope || null)); setStatus(`defined ${newName.name.trim()}`); setNewName({ name: "", ref: "", scope: "" });
            }}>Define</Btn>
          </div>
          {workbook.listNames().length === 0 ? <span className="fs-dim">No names yet. Select cells and type a name in the Name Box, or define one here.</span> : (
            <table style={{ borderCollapse: "collapse", textAlign: "left" }}>
              <thead><tr><th>Name</th><th>Refers to</th><th>Value</th><th>Scope</th><th /></tr></thead>
              <tbody>{workbook.listNames().map((n) => {
                const t = referenceTarget(n.ref, n.scope ?? active);
                const val = t && workbook.sheets.has(t.sheet) ? workbook.valueAt(t.sheet, t.c0, t.r0) : undefined;
                return (
                  <tr key={`${n.scope}|${n.name}`} data-name={n.name}>
                    <td className="fs-mono"><button className="fs-btn" data-variant="ghost" onClick={() => t && goToTarget(t)} title="Go to">{n.name}</button></td>
                    <td className="fs-mono" style={{ color: /#REF!/.test(n.ref) ? "var(--fs-bad-text, #ff9b9b)" : undefined }}>={n.ref}</td>
                    <td className="fs-mono fs-dim">{t ? `${val === undefined ? "" : String(typeof val === "object" ? (val as { error: string }).error : val)}${t.c0 !== t.c1 || t.r0 !== t.r1 ? " …" : ""}` : ""}</td>
                    <td>{n.scope ?? "Workbook"}</td>
                    <td><Btn variant="ghost" onClick={() => mutate((wb) => { wb.deleteName(n.name, n.scope); })} title="Delete name">Delete</Btn></td>
                  </tr>);
              })}</tbody>
            </table>)}
        </div>
      ) : null}
      {panel === "paste" ? (
        <div className="fs-row" role="group" aria-label="Paste special" data-testid="paste-special" style={{ gap: 10, padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5), flexWrap: "wrap", alignItems: "center" }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setPanel(null); gridRef.current?.focus(); } if (e.key === "Enter") { e.preventDefault(); doPasteSpecial(); } }}>
          <b>Paste special</b>
          <span className="fs-row" style={{ gap: 6 }}>{(["all", "formulas", "values", "formats"] as const).map((w) => (
            <label key={w}><input type="radio" name="ps-what" checked={ps.what === w} onChange={() => setPs({ ...ps, what: w })} /> {w === "all" ? "All" : w === "formulas" ? "Formulas" : w === "values" ? "Values" : "Formats"}</label>))}</span>
          <label>Operation <select className="fs-input" aria-label="Operation" value={ps.op ?? "none"} onChange={(e) => setPs({ ...ps, op: e.target.value as PasteOp })} disabled={ps.what === "formats"}>
            <option value="none">None</option><option value="add">Add</option><option value="subtract">Subtract</option><option value="multiply">Multiply</option><option value="divide">Divide</option></select></label>
          <label><input type="checkbox" checked={!!ps.skipBlanks} onChange={(e) => setPs({ ...ps, skipBlanks: e.target.checked })} /> Skip blanks</label>
          <label><input type="checkbox" checked={!!ps.transpose} onChange={(e) => setPs({ ...ps, transpose: e.target.checked })} /> Transpose</label>
          <Btn variant="primary" onClick={doPasteSpecial}>Paste</Btn>
          <Btn variant="ghost" onClick={doPasteLink} disabled={!!ps.transpose || !!ps.skipBlanks || (ps.op ?? "none") !== "none"} title="Paste formulas that refer to the copied cells (=$A$1); not with Transpose, Skip blanks or an operation">Paste Link</Btn>
          <Btn variant="ghost" onClick={() => { setPanel(null); gridRef.current?.focus(); }}>Cancel</Btn>
          <span className="fs-dim">from {psFrom} (this Spreadsheet&apos;s clipboard)</span>
        </div>
      ) : null}
      {panel === "link" ? (
        <div className="fs-row" role="group" aria-label="Insert link" data-testid="link-panel" style={{ gap: 8, padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5), flexWrap: "wrap", alignItems: "center" }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setPanel(null); gridRef.current?.focus(); } if (e.key === "Enter") { e.preventDefault(); applyLink(); } }}>
          <b>Link on <span className="fs-mono">{rangeA1(selR)}</span></b>
          <label>Address <input className="fs-input" autoFocus aria-label="Link address" placeholder="example.com · me@example.com · Sheet2!A1" value={lk.addr} onChange={(e) => setLk({ ...lk, addr: e.target.value })} style={{ width: 240 }} /></label>
          <label>Text to display <input className="fs-input" aria-label="Text to display" value={lk.text} onChange={(e) => setLk({ ...lk, text: e.target.value })} style={{ width: 140 }} /></label>
          <label>ScreenTip <input className="fs-input" aria-label="ScreenTip" value={lk.tip} onChange={(e) => setLk({ ...lk, tip: e.target.value })} style={{ width: 140 }} /></label>
          <Btn variant="primary" onClick={applyLink}>{lk.had ? "Update" : "Insert"}</Btn>
          {lk.had ? <Btn variant="ghost" onClick={removeLink}>Remove link</Btn> : null}
          {lk.had ? <Btn variant="ghost" onClick={() => followLink(sel.f.col, sel.f.row)}>Open</Btn> : null}
          <Btn variant="ghost" onClick={() => { setPanel(null); gridRef.current?.focus(); }}>Cancel</Btn>
          <span className="fs-dim">only web and e-mail links open; others are kept in the file</span>
        </div>
      ) : null}
      {panel === "pivot" ? (() => {
        const heads = pivotHeads();
        const fieldSel = (label: string, v: number, on: (n: number) => void, none = "(none)") => (
          <select className="fs-input" aria-label={label} value={v} onChange={(e) => on(Number(e.target.value))} style={{ maxWidth: 150 }}>
            <option value={-1}>{none}</option>{heads.map((h, i) => <option key={i} value={i}>{h}</option>)}
          </select>);
        const setAt = <T,>(a: T[], i: number, x: T) => a.map((y, j) => (j === i ? x : y));
        let items: string[] = [];
        if (pv.filter >= 0) { const src = splitSrc(pv.src); try { if (src) items = fieldItems(readTable(workbook, src), pv.filter); } catch { items = []; } }
        const inc = pv.inc ?? items;
        return (
          <div role="group" aria-label="PivotTable" data-testid="pivot-panel" style={{ padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5) }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setPanel(null); gridRef.current?.focus(); } }}>
            <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <b>{pv.edit ? `Edit ${pv.edit.name}` : "New PivotTable"}</b>
              <label>Source <input className="fs-input fs-mono" aria-label="PivotTable source" value={pv.src} onChange={(e) => setPv({ ...pv, src: e.target.value })} style={{ width: 150 }} /></label>
              {heads.length ? <span className="fs-dim">{heads.length} fields</span> : <span role="alert">The source needs a heading row and data (for example Sheet1!A1:D20).</span>}
            </div>
            <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
              <span>Rows</span>{fieldSel("Rows field", pv.rows[0], (n) => setPv({ ...pv, rows: setAt(pv.rows, 0, n) }))}
              {pv.rows[0] >= 0 ? <>then by {fieldSel("Rows field 2", pv.rows[1], (n) => setPv({ ...pv, rows: setAt(pv.rows, 1, n) }))}</> : null}
              {pv.rows[1] >= 0 ? <>then by {fieldSel("Rows field 3", pv.rows[2], (n) => setPv({ ...pv, rows: setAt(pv.rows, 2, n) }))}</> : null}
              <span style={{ marginLeft: 8 }}>Columns</span>{fieldSel("Columns field", pv.cols[0], (n) => setPv({ ...pv, cols: setAt(pv.cols, 0, n) }))}
              {pv.cols[0] >= 0 ? <>then by {fieldSel("Columns field 2", pv.cols[1], (n) => setPv({ ...pv, cols: setAt(pv.cols, 1, n) }))}</> : null}
            </div>
            <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
              {pv.vals.map((v, i) => (i === 0 || pv.vals[i - 1].field >= 0 ? (
                <span key={i} className="fs-row" style={{ gap: 4, alignItems: "center" }}>
                  <span>{i === 0 ? "Values" : "and"}</span>
                  {fieldSel(i ? `Values field ${i + 1}` : "Values field", v.field, (n) => setPv({ ...pv, vals: setAt(pv.vals, i, { ...v, field: n }) }), i ? "(none)" : "(count of rows)")}
                  {v.field >= 0 ? <select className="fs-input" aria-label={i ? `Summarize values field ${i + 1} by` : "Summarize values by"} value={v.fn} onChange={(e) => setPv({ ...pv, vals: setAt(pv.vals, i, { ...v, fn: e.target.value as PivotFn }) })}>
                    {(Object.keys(FN_LABEL) as PivotFn[]).map((f) => <option key={f} value={f}>{FN_LABEL[f]}</option>)}
                  </select> : null}
                </span>) : null))}
              <span style={{ marginLeft: 8 }}>Filter</span>{fieldSel("Filter field", pv.filter, (n) => setPv({ ...pv, filter: n, inc: null }))}
              <label><input type="checkbox" checked={pv.subtotals} onChange={(e) => setPv({ ...pv, subtotals: e.target.checked })} /> Subtotals</label>
              <label><input type="checkbox" checked={pv.grand} onChange={(e) => setPv({ ...pv, grand: e.target.checked })} /> Grand totals</label>
            </div>
            {pv.filter >= 0 ? (
              <div role="group" aria-label="Filter items" className="fs-row" style={{ gap: 8, flexWrap: "wrap", marginTop: 4, maxHeight: 72, overflowY: "auto" }}>
                {items.slice(0, 200).map((it) => <label key={it}><input type="checkbox" checked={inc.includes(it)} onChange={(e) => setPv({ ...pv, inc: e.target.checked ? [...inc, it] : inc.filter((x) => x !== it) })} /> {it}</label>)}
                {items.length > 200 ? <span className="fs-dim">first 200 of {items.length} items</span> : null}
              </div>) : null}
            <div className="fs-row" style={{ gap: 8, marginTop: 4, alignItems: "center" }}>
              <Btn variant="primary" onClick={applyPivot}>{pv.edit ? "Update" : "Create"}</Btn>
              {pv.edit ? <Btn variant="ghost" onClick={() => { setPanel(null); refreshPivotUi(true); }}>Refresh</Btn> : null}
              {pv.edit ? <Btn variant="ghost" onClick={removePivot}>Delete PivotTable</Btn> : null}
              <Btn variant="ghost" onClick={() => { setPanel(null); gridRef.current?.focus(); }}>Cancel</Btn>
              <span className="fs-dim">{pv.edit ? "Refresh recomputes it from the source; .xlsx save writes a real Excel PivotTable" : "creates a new sheet; refresh after the source changes — .xlsx save writes a real Excel PivotTable"}</span>
            </div>
          </div>);
      })() : null}
      {panel === "spell" ? (
        <SheetSpellBar sheet={sheet} workbook={workbook} allSheets={spAll} setAllSheets={setSpAll} from={spFrom || active} rev={rev} speller={speller} err={spErr} scope={spScope} ignore={spIgnore} gen={spGen} idx={spIdx} setIdx={setSpIdx}
          onFix={spFix} onShow={spShow}
          onChangeAll={(x, v, opts, all) => { let n = 0; mutate((wb, sh) => { n = all ? changeAllWorkbook(wb, speller!, x.word, v, opts) : changeAllCells(wb, sh, speller!, x.word, v, opts); }); setFindInfo(`changed ${n}`); }}
          onIgnore={(all, v) => setSpIgnore((x) => (all ? { ...x, all: new Set([...x.all, v]) } : { ...x, once: new Set([...x.once, v]) }))}
          onAdd={(w) => { if (addUserWord(w)) setSpGen((g) => g + 1); }}
          onClose={() => { setPanel(null); gridRef.current?.focus(); }} />
      ) : null}
      {panel === "find" ? (
        <div className="fs-row" data-testid="find-panel" style={{ gap: 6, padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5), flexWrap: "wrap" }}>
          <input className="fs-input" aria-label="Find" placeholder="Find" value={findQ} onChange={(e) => setFindQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") findNext(); }} style={{ width: 160 }} />
          <input className="fs-input" aria-label="Replace with" placeholder="Replace with" value={replQ} onChange={(e) => setReplQ(e.target.value)} style={{ width: 160 }} />
          <label><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> match case</label>
          <Btn variant="ghost" onClick={findNext}>Find next</Btn>
          <Btn variant="ghost" onClick={() => { if (!findQ) return; let n = 0; mutate((wb) => { n = replaceAll(wb, findQ, replQ, { matchCase }); }); setFindInfo(`replaced in ${n} cell(s)`); }}>Replace all</Btn>
          <span className="fs-dim" data-testid="find-info">{findInfo}</span>
        </div>
      ) : null}
      {panel === "cf" ? (
        <div data-testid="cf-panel" style={{ padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11.5) }}>
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span>Apply to <b className="fs-mono">{rangeA1(selR)}</b> when</span>
            <select className="fs-input" aria-label="Rule type" value={cf.kind} onChange={(e) => setCf({ ...cf, kind: e.target.value as CfUiKind })} style={{ width: 170 }}>
              {CF_UI_KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            {["gt", "lt", "ge", "le", "eq", "ne", "between", "notBetween", "contains", "notContains", "begins", "ends", "top", "bottom", "topPct", "bottomPct"].includes(cf.kind) ? <input className="fs-input" aria-label="Rule value" value={cf.a} onChange={(e) => setCf({ ...cf, a: e.target.value })} style={{ width: 80 }} /> : null}
            {cf.kind === "between" || cf.kind === "notBetween" ? <input className="fs-input" aria-label="Rule value 2" value={cf.b} onChange={(e) => setCf({ ...cf, b: e.target.value })} style={{ width: 80 }} /> : null}
            {cf.kind === "expr" ? <input className="fs-input fs-mono" aria-label="Rule formula" placeholder="=$B2>100" value={cf.formula} onChange={(e) => setCf({ ...cf, formula: e.target.value })} style={{ width: 170 }} /> : null}
            {cf.kind === "period" ? <select className="fs-input" aria-label="Time period" value={cf.period} onChange={(e) => setCf({ ...cf, period: e.target.value })}>{TIME_PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}</select> : null}
            {cf.kind === "icons" ? <><select className="fs-input" aria-label="Icon set" value={cf.iconSet} onChange={(e) => setCf({ ...cf, iconSet: e.target.value })}>{MAIN_ICON_SETS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
              <span aria-hidden className="fs-row" style={{ gap: 2 }}>{(ICON_SETS[cf.iconSet] ?? []).map((g, i) => <img key={i} alt="" src={iconDataUri(g)} width={14} height={14} />)}</span>
              <label><input type="checkbox" checked={cf.reverse} onChange={(e) => setCf({ ...cf, reverse: e.target.checked })} /> reverse</label></> : null}
            {cf.kind === "bar" ? <>bar <input type="color" aria-label="Bar colour" value={cf.barColor} onChange={(e) => setCf({ ...cf, barColor: e.target.value })} /></> : null}
            {cf.kind === "bar" || cf.kind === "icons" ? null : cf.kind !== "scale" && cf.kind !== "scale3" ? <>fill <input type="color" aria-label="Rule fill" value={cf.fill} onChange={(e) => setCf({ ...cf, fill: e.target.value })} /> text <input type="color" aria-label="Rule text colour" value={cf.color} onChange={(e) => setCf({ ...cf, color: e.target.value })} /></>
              : <>min <input type="color" aria-label="Scale minimum colour" value={cf.sMin} onChange={(e) => setCf({ ...cf, sMin: e.target.value })} />{cf.kind === "scale3" ? <> mid <input type="color" aria-label="Scale midpoint colour" value={cf.sMid} onChange={(e) => setCf({ ...cf, sMid: e.target.value })} /></> : null} max <input type="color" aria-label="Scale maximum colour" value={cf.sMax} onChange={(e) => setCf({ ...cf, sMax: e.target.value })} /></>}
            {!["scale", "scale3", "bar", "icons"].includes(cf.kind) ? <><label><input type="checkbox" checked={cf.bold} onChange={(e) => setCf({ ...cf, bold: e.target.checked })} /> bold</label>
              <label title="Lower-priority rules are not applied to cells this rule matches"><input type="checkbox" checked={cf.stop} onChange={(e) => setCf({ ...cf, stop: e.target.checked })} /> stop if true</label></> : null}
            <Btn variant="primary" onClick={addCf}>Add rule</Btn>
          </div>
          {workbook.condFormats.filter((r) => r.sheet === active).map((r) => (
            <div key={r.id} className="fs-row" data-testid="cf-rule" data-range={r.range} style={{ gap: 6, marginTop: 3 }}>
              <span className="fs-mono">{r.range}</span><span data-testid="cf-rule-label">{cfLabel(r)}</span>
              {(r.kind === "scale" ? [r.scaleMin, r.scaleMid, r.scaleMax] : r.kind === "bar" ? [r.barColor] : [r.fill, r.color]).filter(Boolean).map((c, i) => <span key={i} aria-hidden style={{ width: 14, height: 14, background: c, display: "inline-block", borderRadius: 3, border: "1px solid var(--fs-border)" }} />)}
              <button className="fs-btn" data-variant="ghost" aria-label={`Remove rule ${r.range}`} onClick={() => mutate((wb) => { wb.condFormats = wb.condFormats.filter((x) => x.id !== r.id); })}>remove</button>
            </div>
          ))}
        </div>
      ) : null}
      <div ref={gridRef} tabIndex={0} data-testid="sheet-grid" className="fs-scroll" style={{ flex: 1, minHeight: 0, outline: "none", position: "relative", userSelect: "none" }}
        onKeyDown={gridKeys} onCopy={(e) => onCopy(e)} onCut={(e) => onCopy(e, true)} onPaste={onPaste}
        onScroll={(e) => { const t = (e.target as HTMLDivElement).scrollTop; if (Math.abs(t - scroll.top) > ROW_H) setScroll((s) => ({ ...s, top: t })); }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: fz(11.5), tableLayout: "fixed", width: totalW }}>
          <colgroup><col style={{ width: ROWHDR_W }} />{Array.from({ length: COLS }, (_, c) => <col key={c} style={{ width: colW(c) }} />)}</colgroup>
          <thead>
            <tr style={{ position: "sticky", top: 0, zIndex: 3 }}>
              <th onMouseDown={() => setSel({ a: { col: 0, row: 0 }, f: { col: COLS - 1, row: ROWS - 1 } })} style={{ position: "sticky", left: 0, zIndex: 4, height: HEAD_H, background: "var(--fs-bg-2, #131a2b)", borderBottom: "1px solid var(--fs-border)" }} title="Select all" />
              {Array.from({ length: COLS }, (_, c) => (
                <th key={c} onMouseDown={(e) => { if ((e.target as HTMLElement).dataset.resize) return; commit(null); setSel(e.shiftKey ? { a: { col: sel.a.col, row: 0 }, f: { col: c, row: ROWS - 1 } } : { a: { col: c, row: 0 }, f: { col: c, row: ROWS - 1 } }); gridRef.current?.focus(); }}
                  style={{ position: fc && c === 0 ? "sticky" : "relative", left: fc && c === 0 ? ROWHDR_W : undefined, zIndex: fc && c === 0 ? 4 : undefined, height: HEAD_H, fontWeight: 500, fontSize: fz(11), background: c >= selR.c0 && c <= selR.c1 ? "linear-gradient(rgba(91,140,255,.22), rgba(91,140,255,.22)), var(--fs-bg-2, #131a2b)" : "var(--fs-bg-2, #131a2b)", borderBottom: "1px solid var(--fs-border)", borderRight: "1px solid var(--fs-border)", cursor: "s-resize" }}>
                  {colToLetters(c)}
                  <div data-resize="1" data-testid={`resize-${colToLetters(c)}`} onMouseDown={(e) => { e.stopPropagation(); pushUndo(); dragRef.current = { mode: "resize", col: c, x: e.clientX, w: colW(c) }; }}
                    onDoubleClick={() => mutate((_wb, s) => { delete s.colWidths[c]; })} style={{ position: "absolute", right: -3, top: 0, width: 6, height: "100%", cursor: "col-resize", zIndex: 2 }} />
                </th>
              ))}
            </tr>
            {frozen ? row(0, true, 0, 0) : null}
          </thead>
          <tbody>
            <tr style={{ height: (first - frozen) * ROW_H }} />
            {Array.from({ length: last - first + 1 }, (_, i) => row(first + i, false, first, last))}
            <tr style={{ height: (ROWS - 1 - last) * ROW_H }} />
          </tbody>
        </table>
        {listMenu ? (
          <div role="listbox" aria-label="List values" data-testid="list-menu" onMouseDown={(e) => e.stopPropagation()}
            data-placement={listUp ? "above" : "below"} style={{ position: "absolute", top: listMenu.top, transform: listMenu.transform, left: listMenu.left, minWidth: listMenu.width, maxHeight: 180 * k, overflowY: "auto", zIndex: 30, background: "var(--fs-panel-solid, #111827)", border: "1px solid var(--fs-border)", borderRadius: 4, padding: 2, fontSize: fz(11.5), boxShadow: "0 6px 20px rgba(0,0,0,.4)" }}>
            {listMenu.items.map((it) => <div key={it} role="option" aria-selected={listMenu.cur === it} onMouseDown={(e) => { e.preventDefault(); pickListValue(listMenu.col, listMenu.row, it); }}
              style={{ padding: "2px 6px", cursor: "pointer", borderRadius: 3, background: listMenu.cur === it ? "rgba(91,140,255,.25)" : undefined }} className="fs-list-item">{it}</div>)}
          </div>
        ) : null}
        {curRule && (curRule.prompt || curRule.promptTitle) && !listOpen && editing === null ? (() => {
          // Input message (Excel shows it beside the active cell); positioned in grid space, outside the cell's text.
          let left = ROWHDR_W + 8; for (let c = 0; c < sel.f.col; c++) left += colW(c);
          return <div data-testid="input-prompt" role="note" className="fs-card" style={{ position: "absolute", top: HEAD_H + (sel.f.row + 1) * ROW_H + 2, left, zIndex: 25, padding: "4px 7px", fontSize: fz(11), maxWidth: 220, background: "#fef9c3", color: "#1f2937", border: "1px solid #a16207", borderRadius: 3, pointerEvents: "none" }}>
            {curRule.promptTitle ? <b style={{ display: "block" }}>{curRule.promptTitle}</b> : null}{curRule.prompt}
          </div>;
        })() : null}
      </div>
      {panel === "charts" ? (
        <div data-testid="charts-panel" className="fs-scroll" tabIndex={0} aria-label="Charts" style={{ display: "flex", gap: 10, padding: 8, borderTop: "1px solid var(--fs-border)", overflowX: "auto", height: 266, flexShrink: 0 }}>
          {charts.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(12) }}>No charts on this sheet. Select a range with labels in the first column and numbers to the right, then press “Chart”.</span> : null}
          {charts.map((c) => {
            let src = "", error = "";
            try { src = svgDataUri(buildChartSvg(c.kind, c.title, chartDataFor(workbook, c), 420, 220, c)); } catch (e) { error = (e as Error).message; }
            const axes = c.kind !== "pie" && c.kind !== "doughnut";
            const stackable = c.kind === "bar" || c.kind === "hbar" || c.kind === "line" || c.kind === "area";
            const trend = c.trend ?? c.series?.find((s) => s.trend)?.trend;
            const trendOk = axes && (c.grouping ?? "clustered") === "clustered";
            const setTrend = (t: TrendSpec | undefined) => mutate(() => { c.trend = t; c.series?.forEach((s) => { delete s.trend; }); });
            const edit = (fn: () => void) => { fn(); setRev((r) => r + 1); setDirty(true); };
            const at = c.anchor;
            return (
              <div key={c.id} data-chart={c.id} style={{ flexShrink: 0, display: "flex", gap: 6, border: "1px solid var(--fs-border)", borderRadius: 6, padding: 4 }}>
                <div style={{ width: 212, display: "flex", flexDirection: "column", gap: 4, fontSize: fz(11), minWidth: 0 }}>
                <div className="fs-row" style={{ gap: 4 }}>
                  <input className="fs-input" aria-label="Chart title" value={c.title} onChange={(e) => edit(() => { c.title = e.target.value.slice(0, 255); })} style={{ flex: 1, minWidth: 0 }} />
                  <select className="fs-input" aria-label="Chart type" value={c.kind} onChange={(e) => mutate(() => { c.kind = e.target.value as ChartKind; if (c.kind === "pie" || c.kind === "doughnut" || c.kind === "scatter") c.grouping = undefined; })} style={{ width: 84 }}>
                    {CHART_KINDS.map((k) => <option key={k} value={k}>{CHART_KIND_LABEL[k]}</option>)}
                  </select>
                  <button className="fs-btn" data-variant="ghost" aria-label="Delete chart" title="Delete chart" onClick={() => mutate((wb) => { wb.charts = wb.charts.filter((x) => x.id !== c.id); })}>✕</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  <select className="fs-input" aria-label="Stacking" value={c.grouping ?? "clustered"} disabled={!stackable} onChange={(e) => mutate(() => { c.grouping = e.target.value === "clustered" ? undefined : e.target.value as ChartGrouping; })} style={{ gridColumn: "1 / -1" }}>
                    <option value="clustered">{c.kind === "line" || c.kind === "area" ? "standard" : "clustered"}</option><option value="stacked">stacked</option><option value="percent">100% stacked</option>
                  </select>
                  <input className="fs-input" aria-label="Horizontal axis title" placeholder={c.kind === "hbar" ? "category axis title" : "x-axis title"} disabled={!axes} value={c.catTitle ?? ""} onChange={(e) => edit(() => { c.catTitle = e.target.value.slice(0, 255) || undefined; })} style={{ minWidth: 0 }} />
                  <input className="fs-input" aria-label="Vertical axis title" placeholder={c.kind === "hbar" ? "value axis title" : "y-axis title"} disabled={!axes} value={c.valTitle ?? ""} onChange={(e) => edit(() => { c.valTitle = e.target.value.slice(0, 255) || undefined; })} style={{ minWidth: 0 }} />
                </div>
                <div className="fs-row" style={{ gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <select className="fs-input" aria-label="Trendline" value={trend?.type ?? ""} disabled={!trendOk} title={trendOk ? "Trendline" : "Excel offers trendlines only on unstacked, non-pie charts"} onChange={(e) => setTrend(e.target.value ? { ...(trend ?? {}), type: e.target.value as TrendSpec["type"] } : undefined)} style={{ minWidth: 0 }}>
                    <option value="">no trendline</option><option value="linear">linear</option><option value="exp">exponential</option><option value="log">logarithmic</option><option value="power">power</option><option value="poly">polynomial</option><option value="movingAvg">moving avg</option>
                  </select>
                  {trend?.type === "poly" ? <input className="fs-input" type="number" min={2} max={6} aria-label="Polynomial order" value={trend.order ?? 2} onChange={(e) => setTrend({ ...trend, order: clamp(Math.round(Number(e.target.value) || 2), 6, 2) })} style={{ width: 48 }} /> : null}
                  {trend?.type === "movingAvg" ? <input className="fs-input" type="number" min={2} max={255} aria-label="Moving average period" value={trend.period ?? 2} onChange={(e) => setTrend({ ...trend, period: clamp(Math.round(Number(e.target.value) || 2), 255, 2) })} style={{ width: 54 }} /> : null}
                  {trend && trend.type !== "movingAvg" ? <>
                    <label className="fs-row" style={{ gap: 2 }}><input type="checkbox" checked={!!trend.dispEq} onChange={(e) => setTrend({ ...trend, dispEq: e.target.checked || undefined })} />equation</label>
                    <label className="fs-row" style={{ gap: 2 }}><input type="checkbox" checked={!!trend.dispRSqr} onChange={(e) => setTrend({ ...trend, dispRSqr: e.target.checked || undefined })} />R²</label>
                  </> : null}
                  <label className="fs-row" style={{ gap: 2 }}><input type="checkbox" checked={c.legend ?? ((c.series?.length ?? 2) > 1 || !!trend)} onChange={(e) => mutate(() => { c.legend = e.target.checked; })} />legend</label>
                  
                </div>
                <div className="fs-dim" style={{ display: "flex", flexDirection: "column", gap: 1, fontSize: fz(10.5), minWidth: 0, marginTop: "auto" }}>
                  <span className="fs-mono" data-testid="chart-source" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.series?.length ? `${c.series.length} series · ${c.series[0].val}` : c.range}</span>
                  <span className="fs-row" style={{ gap: 4, alignItems: "center" }}><button className="fs-btn" data-variant="ghost" style={{ padding: "1px 8px" }} aria-label="Place chart over the selected cells · Place" title="Place the chart over the selected cells (saved as its position in .xlsx)" onClick={() => { const r = selR; if (r.c1 === r.c0 && r.r1 === r.r0) { shell.toast("Select the cells the chart should cover first.", "warn"); return; } mutate(() => { c.anchor = { c0: r.c0, r0: r.r0, c1: r.c1, r1: r.r1 }; }); }}>Place</button><span data-testid="chart-anchor">{at ? `at ${a1(at.c0, at.r0)}:${a1(at.c1, at.r1)}` : "position: auto"}</span></span>
                  {c.note ? <span title={c.note} data-testid="chart-note" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{c.note}</span> : null}
                </div>
                </div>
                {error ? <div style={{ color: "var(--fs-bad-text, #ff9b9b)", fontSize: fz(11.5), padding: 8 }}>Chart unavailable: {error}</div> : <ChartImg alt={c.title || "chart"} src={src} />}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="fs-row" data-testid="status-bar" style={{ gap: 14, padding: "3px 10px", borderTop: "1px solid var(--fs-border)", fontSize: fz(11) }}>
        <span className="fs-dim">{rangeA1(selR)}</span>
        {stats.numeric ? <><span>Sum: <b data-testid="stat-sum">{formatValue(stats.sum, cur.numFmt && !/[dmyhs]/i.test(cur.numFmt) ? cur.numFmt : "General").text}</b></span><span>Average: <b>{formatValue(stats.average!, "General").text}</b></span><span>Min: {formatValue(stats.min!, "General").text}</span><span>Max: {formatValue(stats.max!, "General").text}</span></> : null}
        <span>Count: <b data-testid="stat-count">{stats.count}</b></span>
        <span className="fs-dim" style={{ marginLeft: "auto" }}>recalc {workbook.lastRecalc.passes} pass(es) · {workbook.lastRecalc.spills} spill(s){workbook.lastRecalc.blocked ? ` · ${workbook.lastRecalc.blocked} blocked` : ""} · undo {histN.undo}{histN.redo ? ` / redo ${histN.redo}` : ""}</span>
      </div>
    </div>
  );
}

function loadSample(wb: Workbook) {
  const s = wb.sheet("Sheet1");
  for (const [ref, input] of Object.entries(SAMPLE)) { const r = parseRange(ref)!; s.setCell(r.c0, r.r0, input); }
  for (let c = 0; c < 4; c++) s.setStyle(c, 0, { bold: true, fill: "#1e3a5f" });
  s.setStyle(5, 0, { bold: true, fill: "#1e3a5f" });
  for (let r = 1; r <= 4; r++) { s.setStyle(2, r, { numFmt: "$#,##0.00" }); s.setStyle(3, r, { numFmt: "$#,##0.00" }); }
  s.setStyle(1, 7, { numFmt: "$#,##0.00" });
  s.colWidths[0] = 110; s.freezeRows = 1;
  const rates = new Sheet("TaxRate"); rates.setCell(0, 0, "Sales tax"); rates.setCell(1, 0, "0.08"); rates.setStyle(1, 0, { numFmt: "0.0%" });
  wb.sheets.set(rates.name, rates);
  // chart source: labels + totals as a contiguous two-column block built with HSTACK (a dynamic array)
  s.setCell(7, 0, "Item"); s.setCell(8, 0, "Total"); s.setCell(7, 1, "=HSTACK(A2:A4,D2:D4)");
  wb.charts = [{ id: "c1", sheet: "Sheet1", range: "H1:I4", kind: "bar", title: "Total by item", headerRow: true }];
  wb.condFormats = [{ id: "cf1", sheet: "Sheet1", range: "D2:D4", kind: "scale", scaleMin: "#7f1d1d", scaleMax: "#14532d" }];
}

/** Ctrl+D / Ctrl+R: copy the first row (down) or first column (right) of the target across it; formulas shift. */
function fillCopy(s: Sheet, t: Range, dir: "down" | "right") {
  for (let r = t.r0; r <= t.r1; r++) for (let c = t.c0; c <= t.c1; c++) {
    const src = dir === "down" ? { col: c, row: t.r0 } : { col: t.c0, row: r };
    if (src.col === c && src.row === r) continue;
    const cell = s.get(src.col, src.row);
    s.setCell(c, r, shiftFormula(cell?.input ?? "", c - src.col, r - src.row)); s.setStyle(c, r, cell?.style ?? null);
  }
}
/** Smallest unused `${prefix}${n}` id (pure: no clock/random during render). */
const CHART_KIND_LABEL: Record<ChartKind, string> = { bar: "column", hbar: "bar", line: "line", area: "area", pie: "pie", doughnut: "doughnut", scatter: "scatter" };
function nextId(prefix: string, used: string[]): string { let n = used.length + 1; while (used.includes(`${prefix}${n}`)) n++; return `${prefix}${n}`; }
function ChartImg({ alt, src }: { alt: string; src: string }) {
  // data: URI SVG (script-inert inside <img>); next/image optimisation does not apply to data URIs
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={alt} src={src} width={420} height={220} style={{ display: "block" }} />;
}
function TB({ label, onClick, active, title, style }: { label: string; onClick: () => void; active?: boolean; title?: string; style?: React.CSSProperties }) {
  return <button type="button" className="fs-btn" data-variant={active ? "primary" : "ghost"} aria-label={nameWithLabel(label, title)} title={title ?? label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} style={{ padding: "2px 7px", minWidth: 26, ...style }}>{label}</button>;
}
/** WCAG 2.5.3 label-in-name: the accessible name must contain the visible text ("Clear fmt" → "Clear formatting · Clear fmt"; axe ignores parentheticals). */
function nameWithLabel(label: string, title?: string): string {
  if (!title) return label;
  return title.toLowerCase().includes(label.toLowerCase()) || label.length <= 2 ? title : `${title} · ${label}`;
}
const clamp = (v: number, max: number, min = 0) => Math.max(min, Math.min(max, v));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function quoteSheet(name: string): string { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`; }
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
