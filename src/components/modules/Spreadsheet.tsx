"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import {
  Workbook, Sheet, a1, isError, colToLetters, FUNCTIONS, EXT_FUNCTIONS, workbookFromJson, workbookToJson, parseFormula, formatValue, BUILTIN_FORMATS,
  norm, rangeA1, toTsv, parseTsv, copyBlock, pasteBlock, clearRange, autoFill, sortRange, insertDelete, findAll, replaceAll, selectionStats, shiftFormula,
  chartDataFromRange, buildChartSvg, svgDataUri, evalCondFormats, parseRange, currentRegion, jump, fillTarget, looksLikeHeader,
  completionToken, completions, activeCall, SIGNATURES, hasValueIn,
  type WorkbookJson, type CellStyle, type Range, type Clip, type ChartKind, type CondKind, type Scalar,
} from "@/lib/formula/client";
import {
  applyBorders, borderCss, edgeAt, expandToMerges, invalidCells, listFormula, listItems, mergeAcross, mergeAt, mergeCells, partialMergeConflict,
  ruleAt, sanitizeValidation, sortConflict, stepCell, unmergeCells, validateEntry, VALIDATION_OPS, type BorderPreset,
} from "@/lib/formula/sheetlayout";
import type { BorderLine, DataValidation, ValidationOp, ValidationType } from "@/lib/formula/engine";
import { absoluteRef, referenceTarget, validateName } from "@/lib/formula/names";

const COLS = 52;          // A..AZ
const ROWS = 1000;
const ROW_H = 22, HEAD_H = 22, ROWHDR_W = 44, DEFAULT_W = 88;
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
export default function SpreadsheetModule({ win }: ModuleProps) {
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
  const [panel, setPanel] = useState<null | "find" | "charts" | "cf" | "dv" | "names">(null);
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
      const menuH = Math.min(180, n * 21.5 + 8);
      setListUp(HEAD_H + (below + 1) * ROW_H + menuH > el.scrollTop + el.clientHeight);
    }
    setListOpen((o) => (toggle ? !o : true));
  };
  const [showInvalid, setShowInvalid] = useState(false);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });
  const [findQ, setFindQ] = useState(""); const [replQ, setReplQ] = useState(""); const [matchCase, setMatchCase] = useState(false); const [findInfo, setFindInfo] = useState("");
  const [cf, setCf] = useState<{ kind: CondKind; a: string; b: string; fill: string; color: string }>({ kind: "gt", a: "10", b: "", fill: "#14532d", color: "#bbf7d0" });
  const gridRef = useRef<HTMLDivElement | null>(null);
  const undoRef = useRef<{ json: string; active: string }[]>([]);
  const redoRef = useRef<{ json: string; active: string }[]>([]);
  const clipRef = useRef<{ tsv: string; clip: Clip; cut: boolean; range: Range; sheet: string } | null>(null);
  const dragRef = useRef<Drag>(null);
  const [editAt, setEditAt] = useState<Pos>({ col: 0, row: 0 });
  const [editSheet, setEditSheet] = useState("Sheet1");
  const [histN, setHistN] = useState({ undo: 0, redo: 0 });
  const [fillPreview, setFillPreview] = useState<Range | null>(null);
  const sheet = workbook.sheets.get(active) ?? workbook.sheet();
  // Excel: a selection touching part of a merged area includes all of it.
  const selR = useMemo(() => expandToMerges(sheet, norm({ c0: sel.a.col, r0: sel.a.row, c1: sel.f.col, r1: sel.f.row })), [sel, sheet, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const fnNames = useMemo(() => [...new Set([...Object.keys(FUNCTIONS), ...Object.keys(EXT_FUNCTIONS)])].sort(), []);
  const colW = useCallback((c: number) => sheet.colWidths[c] ?? DEFAULT_W, [sheet, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ load */
  useEffect(() => {
    let alive = true;
    (async () => {
      let wb = new Workbook();
      if (path.toLowerCase().endsWith(".xlsx")) {
        try { const r = await post<{ ok: boolean; workbook: WorkbookJson }>("/api/sheet", { op: "importXlsx", path }); wb = workbookFromJson(r.workbook); }
        catch (e) { shell.toast(`Could not import .xlsx: ${String((e as Error).message)}`, "bad"); }
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
  const save = async () => {
    const dest = path && !/\.xlsx$/i.test(path) ? path : `/Documents/workbook-${Date.now()}.fworkbook`;
    await post("/api/fs", { op: "write", path: dest, content: JSON.stringify(workbookToJson(workbook)), reason: "spreadsheet-save" });
    setDirty(false); setStatus(`saved ${dest}`); shell.bumpRefresh();
    if (dest !== path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest } });
  };
  const exportXlsx = async () => {
    const dest = (path || "/Documents/workbook").replace(/\.(fworkbook|fsheet|xlsx)$/i, "") + ".xlsx";
    const r = await post<{ ok: boolean; path: string; bytes: number; sheets: number; error?: string }>("/api/sheet", { op: "saveXlsxToVfs", workbook: workbookToJson(workbook), dest });
    if (r.ok) { setStatus(`exported ${r.bytes} B · ${r.sheets} sheet(s) → ${r.path} (charts & conditional formats are not exported to .xlsx)`); shell.bumpRefresh(); }
    else shell.toast(r.error ?? "export failed", "bad");
  };
  const importXlsx = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) { shell.toast(".xlsx exceeds the 8 MB import guard", "warn"); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await post<{ ok: boolean; workbook?: WorkbookJson; error?: string }>("/api/sheet", { op: "importXlsx", base64: toBase64(bytes) });
    if (!r.ok || !r.workbook) { shell.toast(r.error ?? "import failed", "bad"); return; }
    pushUndo();
    const wb = workbookFromJson(r.workbook); setWorkbook(wb); setActive(wb.sheets.keys().next().value ?? "Sheet1"); setDirty(true); setRev((x) => x + 1);
    shell.toast(`Imported ${wb.sheets.size} sheet(s) — formulas re-evaluated by Fusion, styles and widths kept.`, "ok");
  };

  /* ------------------------------------------------------------ sheets */
  const switchSheet = (name: string) => { commit(null); setActive(name); setSel({ a: { col: 0, row: 0 }, f: { col: 0, row: 0 } }); };
  const newSheet = () => { let n = workbook.sheets.size + 1; while (workbook.sheets.has(`Sheet${n}`)) n++; const name = `Sheet${n}`; mutate((wb) => { wb.addSheet(name); }); switchSheet(name); };
  const renameSheet = (old: string) => {
    const next = prompt("Sheet name (max 31 chars; no : \\ / ? * [ ])", old)?.trim();
    if (!next || next === old) return;
    if (next.length > 31 || /[:\\/?*[\]]/.test(next)) { shell.toast("Invalid sheet name (max 31 chars; : \\ / ? * [ ] are forbidden)", "warn"); return; }
    if ([...workbook.sheets.keys()].some((s) => s.toLowerCase() === next.toLowerCase())) { shell.toast("A sheet with that name already exists.", "warn"); return; }
    mutate((wb) => {
      const entries = [...wb.sheets.entries()]; wb.sheets.clear();
      for (const [n, s] of entries) { if (n === old) s.name = next; wb.sheets.set(s.name, s); } // keeps order, styles, widths, freeze
      const re = new RegExp(`(^|[^A-Za-z0-9_.'])(?:${escapeRe(old)}|'${escapeRe(old.replace(/'/g, "''"))}')!`, "g");
      for (const s of wb.sheets.values()) for (const [k, cell] of [...s.grid]) if (cell.formula && re.test(cell.input)) { re.lastIndex = 0; const [c, r] = k.split(",").map(Number); s.setCell(c, r, cell.input.replace(re, (_m, pre) => `${pre}${quoteSheet(next)}!`)); }
      for (const x of [...wb.charts, ...wb.condFormats]) if (x.sheet === old) x.sheet = next;
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
    clipRef.current = { tsv, clip: copyBlock(sheet, selR), cut, range: selR, sheet: active };
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
    setStatus(`sorted ${rangeA1(r)} by ${colToLetters(clamp(sel.f.col, r.c1, r.c0))} ${asc ? "A→Z" : "Z→A"}${header ? " (header row kept)" : ""}`);
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
    mutate((wb) => { wb.condFormats.push({ id, sheet: active, range: rangeA1(selR).includes(":") ? rangeA1(selR) : `${rangeA1(selR)}:${rangeA1(selR)}`, kind: cf.kind, a: cf.a, b: cf.b, fill: cf.fill, color: cf.color }); });
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
    const move = (e: MouseEvent) => { const d = dragRef.current; if (d?.mode === "resize") { sheet.colWidths[d.col] = Math.max(24, Math.min(800, Math.round(d.w + e.clientX - d.x))); setRev((r) => r + 1); } };
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
    return { col, row, left, top: listUp ? HEAD_H + row * ROW_H : HEAD_H + (below + 1) * ROW_H, transform: listUp ? "translateY(-100%)" : undefined, width: Math.max(colW(col), 120), items: listItems(workbook, active, curRule), cur: String(workbook.valueAt(active, col, row) ?? "") };
  })();
  const totalW = useMemo(() => { let w = ROWHDR_W; for (let c = 0; c < COLS; c++) w += colW(c); return w; }, [colW]);
  const selInput = sheet.get(sel.f.col, sel.f.row)?.input ?? "";
  const cur = styleOf(sel.f);

  if (!loaded) return <div style={{ padding: 16, fontSize: 12 }}>Loading…</div>;

  const renderCell = (col0: number, row0: number, segStart: number, segEnd: number) => {
    // Merged area: render once, at its top-left column and the first row of it visible in this segment.
    const m = mergeAt(sheet, col0, row0);
    if (m && (col0 !== m.c0 || row0 !== Math.max(m.r0, segStart))) return null;
    const col = m ? m.c0 : col0, row = m ? m.r0 : row0;
    const span = m ? { colSpan: m.c1 - m.c0 + 1, rowSpan: Math.min(m.r1, segEnd) - row0 + 1 } : {};
    const cell = sheet.get(col, row); const st = cell?.style ?? {};
    const v: Scalar | undefined = workbook.valueAt(active, col, row);
    const fmt = formatValue(v, st.numFmt);
    const over = cfMap.get(`${col},${row}`);
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
    return (
      <td key={col0} data-cell={a1(col, row)} {...span} data-merge={m ? `${a1(m.c0, m.r0)}:${a1(m.c1, m.r1)}` : undefined} onMouseDown={(e) => cellDown(e, { col, row })} onMouseEnter={() => cellEnter({ col, row })}
        onDoubleClick={() => startEdit(cell?.input ?? "")} title={cell?.error ?? (sp && !(sp.c0 === col && sp.r0 === row) ? `spilled from ${a1(sp.c0, sp.r0)}` : undefined)}
        style={{
          position: stickyCol ? "sticky" : "relative", left: stickyCol ? ROWHDR_W : undefined, zIndex: stickyCol ? 1 : undefined, verticalAlign: m ? (st.valign === "top" ? "top" : st.valign === "center" ? "middle" : "bottom") : undefined,
          height: ROW_H, padding: "0 5px", overflow: editingHere ? "visible" : "hidden", textOverflow: "ellipsis", whiteSpace: st.wrap ? "normal" : "nowrap", cursor: "cell",
          borderTop: sp && row === sp.r0 ? edge : base, borderBottom: sp && row === sp.r1 ? edge : base, borderLeft: sp && col === sp.c0 ? edge : base, borderRight: sp && col === sp.c1 ? edge : base,
          fontWeight: st.bold || over?.bold ? 700 : undefined, fontStyle: st.italic ? "italic" : undefined, textDecoration: st.underline ? "underline" : undefined, textAlign: align,
          color: err ? "#ff9b9b" : fmt.color ?? over?.color ?? st.color ?? (cell?.formula ? "#bcd4ff" : "var(--fs-text)"),
          background: inFill ? "rgba(96,165,250,.18)" : inSel && !isCur ? `linear-gradient(rgba(91,140,255,.18),rgba(91,140,255,.18)),${over?.fill ?? st.fill ?? (stickyCol ? "var(--fs-bg, #0b1020)" : "transparent")}` : over?.fill ?? st.fill ?? (stickyCol ? "var(--fs-bg, #0b1020)" : "transparent"),
          outline: isCur ? "2px solid var(--fs-accent)" : undefined, outlineOffset: -2,
        }}>
        {editingHere ? (
          <>
            <input autoFocus className="fs-input fs-mono" aria-label="Cell editor" style={{ padding: "0 2px", border: 0, height: ROW_H - 2, width: Math.max(colW(col) - 10, 160), position: "relative", zIndex: 5 }}
              value={editing ?? ""} onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }} onChange={(e) => { setEditing(e.target.value); setAcIdx(0); }} onKeyDown={editKeys} onBlur={() => { if (!dragRef.current) commit(null); }} />
            {renderAssist()}
          </>
        ) : fmt.text}
        {rEdge || bEdge || tEdge || lEdge ? <div aria-hidden data-border={[tEdge && "t", rEdge && "r", bEdge && "b", lEdge && "l"].filter(Boolean).join("")}
          style={{ position: "absolute", top: tEdge ? 0 : -1, left: lEdge ? 0 : -1, right: -1, bottom: -1, borderRight: borderCss(rEdge), borderBottom: borderCss(bEdge), borderTop: borderCss(tEdge), borderLeft: borderCss(lEdge), pointerEvents: "none", zIndex: 2 }} /> : null}
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
  const renderAssist = () => (acList.length || call) ? (
    <div className="fs-card" data-testid="formula-assist" style={{ position: "absolute", top: "100%", left: 0, zIndex: 20, minWidth: 220, padding: 4, fontSize: 11.5, background: "var(--fs-panel, #111827)", border: "1px solid var(--fs-border)", borderRadius: 6, boxShadow: "0 6px 20px rgba(0,0,0,.4)", textAlign: "left", whiteSpace: "nowrap" }}>
      {acList.map((n, i) => (
        <div key={n} data-ac={n} onMouseDown={(e) => { e.preventDefault(); acceptCompletion(n); }} style={{ padding: "2px 6px", borderRadius: 4, cursor: "pointer", background: i === acIdx ? "rgba(91,140,255,.25)" : undefined }} className="fs-mono">
          {n}{SIGNATURES[n] ? <span className="fs-dim">({SIGNATURES[n].join(", ")})</span> : null}
        </div>
      ))}
      {!acList.length && call ? <div className="fs-mono" data-testid="arg-hint">{call.name}(
        {(SIGNATURES[call.name] ?? ["…"]).map((a, i, arr) => <span key={i} style={{ fontWeight: i === Math.min(call.arg, arr.length - 1) ? 700 : 400, color: i === Math.min(call.arg, arr.length - 1) ? "#fff" : undefined }}>{a}{i < arr.length - 1 ? ", " : ""}</span>)})
        {!SIGNATURES[call.name] && !fnNames.includes(call.name) ? <span style={{ color: "#ff9b9b" }}> unknown function</span> : null}</div> : null}
      {acList.length ? <div className="fs-dim" style={{ fontSize: 10, padding: "2px 6px" }}>Tab to insert, Up/Down to choose</div> : null}
    </div>
  ) : null;

  const row = (r: number, sticky = false, segStart = r, segEnd = r) => (
    <tr key={r} style={sticky ? { position: "sticky", top: HEAD_H, zIndex: 2, background: "var(--fs-bg, #0b1020)" } : undefined}>
      <td className="fs-dim" onMouseDown={() => { commit(null); setSel({ a: { col: 0, row: r }, f: { col: COLS - 1, row: r } }); gridRef.current?.focus(); }}
        style={{ position: "sticky", left: 0, zIndex: 1, textAlign: "center", fontSize: 10.5, background: r >= selR.r0 && r <= selR.r1 ? "rgba(91,140,255,.22)" : "var(--fs-bg-2, #131a2b)", borderRight: "1px solid var(--fs-border)", borderBottom: sticky ? "2px solid #475569" : "1px solid var(--fs-border)", cursor: "e-resize" }}>{r + 1}</td>
      {Array.from({ length: COLS }, (_, c) => renderCell(c, r, segStart, segEnd))}
    </tr>
  );


  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={() => void save()}>Save workbook</Btn>
        <Btn variant="ghost" onClick={() => void exportXlsx()}>Export .xlsx</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import .xlsx<input type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importXlsx(f); }} /></label>
        <Badge tone={dirty ? "warn" : "ok"}>{dirty ? "unsaved" : "saved"}</Badge>
        <Badge tone="info" title="First-party formula engine; see docs/OFFICE-ENGINE.md">from-scratch engine · {fnNames.length} functions</Badge>
        {status ? <span className="fs-dim" data-testid="sheet-status" style={{ fontSize: 11 }}>{status}</span> : null}
      </div>
      <div className="fs-row" data-testid="sheet-toolbar" style={{ padding: "4px 6px", gap: 3, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap", alignItems: "center" }}>
        <TB label="Undo" onClick={undo} title={"Undo (Ctrl+Z)"} /><TB label="Redo" onClick={redo} title={"Redo (Ctrl+Y)"} />
        <span style={{ width: 6 }} />
        <TB label="B" onClick={() => toggle("bold")} active={!!cur.bold} title={"Bold (Ctrl+B)"} style={{ fontWeight: 700 }} />
        <TB label="I" onClick={() => toggle("italic")} active={!!cur.italic} title={"Italic (Ctrl+I)"} style={{ fontStyle: "italic" }} />
        <TB label="U" onClick={() => toggle("underline")} active={!!cur.underline} title={"Underline (Ctrl+U)"} style={{ textDecoration: "underline" }} />
        <TB label="Left" onClick={() => applyStyle({ align: "left" })} active={cur.align === "left"} title={"Align left"} />
        <TB label="Center" onClick={() => applyStyle({ align: "center" })} active={cur.align === "center"} title={"Align center"} />
        <TB label="Right" onClick={() => applyStyle({ align: "right" })} active={cur.align === "right"} title={"Align right"} />
        <TB label="Wrap" onClick={() => toggle("wrap")} active={!!cur.wrap} title={"Wrap text"} />
        <label className="fs-dim" title="Fill colour" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 2 }}>Fill<input aria-label="Fill colour" type="color" value={cur.fill ?? "#000000"} onChange={(e) => applyStyle({ fill: e.target.value })} style={{ width: 22, height: 20, border: 0, background: "none" }} /></label>
        <label className="fs-dim" title="Text colour" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 2 }}>Text<input aria-label="Text colour" type="color" value={cur.color ?? "#e5e7eb"} onChange={(e) => applyStyle({ color: e.target.value })} style={{ width: 22, height: 20, border: 0, background: "none" }} /></label>
        <select className="fs-input" aria-label="Number format" value={BUILTIN_FORMATS.some((f) => f.code === (cur.numFmt ?? "General")) ? cur.numFmt ?? "General" : "custom"} style={{ width: 150, fontSize: 11 }}
          onChange={(e) => { const v = e.target.value; if (v === "custom") { const code = prompt("Custom number format (Excel syntax, e.g. #,##0.00;[Red]-#,##0.00)", cur.numFmt ?? "General"); if (code) applyStyle({ numFmt: code }); } else applyStyle({ numFmt: v === "General" ? undefined : v }); }}>
          {BUILTIN_FORMATS.map((f) => <option key={f.code} value={f.code}>{f.label} — {f.code}</option>)}
          <option value="custom">Custom…{cur.numFmt && !BUILTIN_FORMATS.some((f) => f.code === cur.numFmt) ? ` (${cur.numFmt})` : ""}</option>
        </select>
        <TB label="Clear fmt" onClick={() => applyStyle(null)} title={"Clear formatting"} />
        <span style={{ width: 6 }} />
        <select className="fs-input" aria-label="Merge" value="" style={{ width: 92, fontSize: 11 }} onChange={(e) => { const v = e.target.value as "center" | "across" | "merge" | "unmerge"; if (v) doMerge(v); }}>
          <option value="">Merge…</option><option value="center">Merge &amp; Center</option><option value="across">Merge Across</option><option value="merge">Merge Cells</option><option value="unmerge">Unmerge Cells</option>
        </select>
        <select className="fs-input" aria-label="Borders" value="" style={{ width: 96, fontSize: 11 }} onChange={(e) => { const v = e.target.value as BorderPreset; if (v) doBorders(v); }}>
          <option value="">Borders…</option><option value="all">All Borders</option><option value="outside">Outside Borders</option><option value="thickOutside">Thick Outside Borders</option>
          <option value="inside">Inside Borders</option><option value="top">Top Border</option><option value="bottom">Bottom Border</option><option value="bottomDouble">Bottom Double Border</option>
          <option value="left">Left Border</option><option value="right">Right Border</option><option value="none">No Border</option>
        </select>
        <select className="fs-input" aria-label="Border line style" value={borderLine} style={{ width: 70, fontSize: 11 }} onChange={(e) => setBorderLine(e.target.value as BorderLine)}>
          {(["thin", "medium", "thick", "dashed", "dotted", "double", "hair"] as const).map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input aria-label="Border colour" title="Border colour" type="color" value={borderColor} onChange={(e) => setBorderColor(e.target.value)} style={{ width: 22, height: 20, border: 0, background: "none" }} />
        <select className="fs-input" aria-label="Vertical alignment" value={cur.valign ?? ""} style={{ width: 70, fontSize: 11 }} onChange={(e) => applyStyle({ valign: (e.target.value || undefined) as CellStyle["valign"] })}>
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
        <TB label="Find" onClick={() => setPanel(panel === "find" ? null : "find")} active={panel === "find"} title={"Find & replace (Ctrl+F)"} />
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
        <span className="fs-dim" style={{ fontSize: 10.5, marginLeft: "auto" }}>{workbook.sheets.size} sheets · cross-sheet formulas (e.g. =TaxRate!B1)</span>
      </div>
      <div className="fs-row" style={{ padding: "4px 8px", gap: 6, borderBottom: "1px solid var(--fs-border)", position: "relative" }}>
        <input className="fs-input fs-mono" data-testid="name-box" aria-label="Name Box" title="Name Box: type a name to define it for the selection, or a name/reference to go there"
          style={{ fontSize: 11.5, width: 130 }} value={nameBox ?? nameBoxDisplay} onFocus={(e) => { setNameBox(nameBoxDisplay); requestAnimationFrame(() => e.target.select()); }}
          onChange={(e) => setNameBox(e.target.value)} onBlur={() => setNameBox(null)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitNameBox(nameBox ?? ""); gridRef.current?.focus(); } else if (e.key === "Escape") { setNameBox(null); gridRef.current?.focus(); } }} />
        <span className="fs-dim fs-mono" style={{ fontSize: 12 }}>ƒx</span>
        <div style={{ flex: 1, position: "relative" }}>
          <input className="fs-input fs-mono" style={{ width: "100%" }} aria-label="Formula bar"
            value={editing !== null ? editing : selInput} onChange={(e) => { if (editing === null) startEdit(e.target.value, "bar"); else setEditing(e.target.value); setAcIdx(0); }}
            onFocus={() => { if (editing === null) startEdit(selInput, "bar"); else setEditSrc("bar"); }} onKeyDown={editKeys} onBlur={() => { if (!dragRef.current) commit(null); }} />
          {editing !== null && editSrc === "bar" ? renderAssist() : null}
        </div>
      </div>
      {dvAlert ? (
        <div role="alertdialog" aria-label={dvAlert.title} data-testid="dv-alert" data-style={dvAlert.style} className="fs-row" style={{ gap: 8, padding: "5px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: 12, alignItems: "center",
          background: dvAlert.style === "stop" ? "rgba(239,68,68,.16)" : dvAlert.style === "warning" ? "rgba(234,179,8,.16)" : "rgba(59,130,246,.16)" }}>
          <b>{dvAlert.title}</b><span>{dvAlert.message}</span><span className="fs-dim fs-mono">({dvAlert.text} → {a1(dvAlert.col, dvAlert.row)})</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {dvAlert.style === "stop" ? <><Btn variant="primary" onClick={() => resolveAlert(false, true)}>Retry</Btn><Btn variant="ghost" onClick={() => resolveAlert(false)}>Cancel</Btn></>
              : dvAlert.style === "warning" ? <><span>Continue?</span><Btn variant="primary" onClick={() => resolveAlert(true)}>Yes</Btn><Btn variant="ghost" onClick={() => resolveAlert(false, true)}>No</Btn><Btn variant="ghost" onClick={() => resolveAlert(false)}>Cancel</Btn></>
                : <><Btn variant="primary" onClick={() => resolveAlert(true)}>OK</Btn><Btn variant="ghost" onClick={() => resolveAlert(false)}>Cancel</Btn></>}
          </span>
        </div>
      ) : null}
      {panel === "dv" ? (
        <div data-testid="dv-panel" style={{ padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: 11.5 }}>
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
          <div className="fs-dim" style={{ fontSize: 10.5, marginTop: 3 }}>As in Excel: rules check typed entries only (paste replaces cells without checking; use Circle invalid to audit). Only Stop blocks. Typed lists are limited to 255 characters.</div>
        </div>
      ) : null}
      {panel === "names" ? (
        <div data-testid="names-panel" style={{ padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: 11.5, display: "grid", gap: 4, maxHeight: 200, overflow: "auto" }}>
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <b>Name Manager</b>
            <input className="fs-input fs-mono" aria-label="New name" placeholder="Name" value={newName.name} onChange={(e) => setNewName({ ...newName, name: e.target.value })} style={{ width: 120 }} />
            <input className="fs-input fs-mono" aria-label="Refers to" placeholder={absoluteRef(active, selR.c0, selR.r0, selR.c1, selR.r1)} value={newName.ref} onChange={(e) => setNewName({ ...newName, ref: e.target.value })} style={{ width: 200 }} />
            <select className="fs-select" aria-label="Scope" style={{ width: 130, flex: "0 0 auto" }} value={newName.scope} onChange={(e) => setNewName({ ...newName, scope: e.target.value })}>
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
                    <td className="fs-mono" style={{ color: /#REF!/.test(n.ref) ? "#ff9b9b" : undefined }}>={n.ref}</td>
                    <td className="fs-mono fs-dim">{t ? `${val === undefined ? "" : String(typeof val === "object" ? (val as { error: string }).error : val)}${t.c0 !== t.c1 || t.r0 !== t.r1 ? " …" : ""}` : ""}</td>
                    <td>{n.scope ?? "Workbook"}</td>
                    <td><Btn variant="ghost" onClick={() => mutate((wb) => { wb.deleteName(n.name, n.scope); })} title="Delete name">Delete</Btn></td>
                  </tr>);
              })}</tbody>
            </table>)}
        </div>
      ) : null}
      {panel === "find" ? (
        <div className="fs-row" data-testid="find-panel" style={{ gap: 6, padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: 11.5, flexWrap: "wrap" }}>
          <input className="fs-input" aria-label="Find" placeholder="Find" value={findQ} onChange={(e) => setFindQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") findNext(); }} style={{ width: 160 }} />
          <input className="fs-input" aria-label="Replace with" placeholder="Replace with" value={replQ} onChange={(e) => setReplQ(e.target.value)} style={{ width: 160 }} />
          <label><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> match case</label>
          <Btn variant="ghost" onClick={findNext}>Find next</Btn>
          <Btn variant="ghost" onClick={() => { if (!findQ) return; let n = 0; mutate((wb) => { n = replaceAll(wb, findQ, replQ, { matchCase }); }); setFindInfo(`replaced in ${n} cell(s)`); }}>Replace all</Btn>
          <span className="fs-dim" data-testid="find-info">{findInfo}</span>
        </div>
      ) : null}
      {panel === "cf" ? (
        <div data-testid="cf-panel" style={{ padding: "4px 8px", borderBottom: "1px solid var(--fs-border)", fontSize: 11.5 }}>
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span>Apply to <b className="fs-mono">{rangeA1(selR)}</b> when</span>
            <select className="fs-input" aria-label="Rule type" value={cf.kind} onChange={(e) => setCf({ ...cf, kind: e.target.value as CondKind })} style={{ width: 150 }}>
              <option value="gt">value &gt;</option><option value="lt">value &lt;</option><option value="eq">value =</option><option value="between">between</option>
              <option value="contains">text contains</option><option value="duplicate">duplicate values</option><option value="top">top N</option><option value="scale">2-colour scale</option>
            </select>
            {["gt", "lt", "eq", "between", "contains", "top"].includes(cf.kind) ? <input className="fs-input" aria-label="Rule value" value={cf.a} onChange={(e) => setCf({ ...cf, a: e.target.value })} style={{ width: 80 }} /> : null}
            {cf.kind === "between" ? <input className="fs-input" aria-label="Rule value 2" value={cf.b} onChange={(e) => setCf({ ...cf, b: e.target.value })} style={{ width: 80 }} /> : null}
            {cf.kind !== "scale" ? <>fill <input type="color" value={cf.fill} onChange={(e) => setCf({ ...cf, fill: e.target.value })} /> text <input type="color" value={cf.color} onChange={(e) => setCf({ ...cf, color: e.target.value })} /></> : null}
            <Btn variant="primary" onClick={addCf}>Add rule</Btn>
          </div>
          {workbook.condFormats.filter((r) => r.sheet === active).map((r) => (
            <div key={r.id} className="fs-row" style={{ gap: 6, marginTop: 3 }}>
              <span className="fs-mono">{r.range}</span><span>{r.kind}{r.a ? ` ${r.a}` : ""}{r.b ? `…${r.b}` : ""}</span>
              {r.fill ? <span style={{ width: 14, height: 14, background: r.fill, display: "inline-block", borderRadius: 3 }} /> : null}
              <button className="fs-btn" data-variant="ghost" onClick={() => mutate((wb) => { wb.condFormats = wb.condFormats.filter((x) => x.id !== r.id); })}>remove</button>
            </div>
          ))}
        </div>
      ) : null}
      <div ref={gridRef} tabIndex={0} data-testid="sheet-grid" className="fs-scroll" style={{ flex: 1, minHeight: 0, outline: "none", position: "relative", userSelect: "none" }}
        onKeyDown={gridKeys} onCopy={(e) => onCopy(e)} onCut={(e) => onCopy(e, true)} onPaste={onPaste}
        onScroll={(e) => { const t = (e.target as HTMLDivElement).scrollTop; if (Math.abs(t - scroll.top) > ROW_H) setScroll((s) => ({ ...s, top: t })); }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 11.5, tableLayout: "fixed", width: totalW }}>
          <colgroup><col style={{ width: ROWHDR_W }} />{Array.from({ length: COLS }, (_, c) => <col key={c} style={{ width: colW(c) }} />)}</colgroup>
          <thead>
            <tr style={{ position: "sticky", top: 0, zIndex: 3 }}>
              <th onMouseDown={() => setSel({ a: { col: 0, row: 0 }, f: { col: COLS - 1, row: ROWS - 1 } })} style={{ position: "sticky", left: 0, zIndex: 4, height: HEAD_H, background: "var(--fs-bg-2, #131a2b)", borderBottom: "1px solid var(--fs-border)" }} title="Select all" />
              {Array.from({ length: COLS }, (_, c) => (
                <th key={c} onMouseDown={(e) => { if ((e.target as HTMLElement).dataset.resize) return; commit(null); setSel(e.shiftKey ? { a: { col: sel.a.col, row: 0 }, f: { col: c, row: ROWS - 1 } } : { a: { col: c, row: 0 }, f: { col: c, row: ROWS - 1 } }); gridRef.current?.focus(); }}
                  style={{ position: fc && c === 0 ? "sticky" : "relative", left: fc && c === 0 ? ROWHDR_W : undefined, zIndex: fc && c === 0 ? 4 : undefined, height: HEAD_H, fontWeight: 500, fontSize: 11, background: c >= selR.c0 && c <= selR.c1 ? "rgba(91,140,255,.22)" : "var(--fs-bg-2, #131a2b)", borderBottom: "1px solid var(--fs-border)", borderRight: "1px solid var(--fs-border)", cursor: "s-resize" }}>
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
            data-placement={listUp ? "above" : "below"} style={{ position: "absolute", top: listMenu.top, transform: listMenu.transform, left: listMenu.left, minWidth: listMenu.width, maxHeight: 180, overflowY: "auto", zIndex: 30, background: "var(--fs-panel-solid, #111827)", border: "1px solid var(--fs-border)", borderRadius: 4, padding: 2, fontSize: 11.5, boxShadow: "0 6px 20px rgba(0,0,0,.4)" }}>
            {listMenu.items.map((it) => <div key={it} role="option" aria-selected={listMenu.cur === it} onMouseDown={(e) => { e.preventDefault(); pickListValue(listMenu.col, listMenu.row, it); }}
              style={{ padding: "2px 6px", cursor: "pointer", borderRadius: 3, background: listMenu.cur === it ? "rgba(91,140,255,.25)" : undefined }} className="fs-list-item">{it}</div>)}
          </div>
        ) : null}
        {curRule && (curRule.prompt || curRule.promptTitle) && !listOpen && editing === null ? (() => {
          // Input message (Excel shows it beside the active cell); positioned in grid space, outside the cell's text.
          let left = ROWHDR_W + 8; for (let c = 0; c < sel.f.col; c++) left += colW(c);
          return <div data-testid="input-prompt" role="note" className="fs-card" style={{ position: "absolute", top: HEAD_H + (sel.f.row + 1) * ROW_H + 2, left, zIndex: 25, padding: "4px 7px", fontSize: 11, maxWidth: 220, background: "#fef9c3", color: "#1f2937", border: "1px solid #a16207", borderRadius: 3, pointerEvents: "none" }}>
            {curRule.promptTitle ? <b style={{ display: "block" }}>{curRule.promptTitle}</b> : null}{curRule.prompt}
          </div>;
        })() : null}
      </div>
      {panel === "charts" ? (
        <div data-testid="charts-panel" className="fs-scroll" style={{ display: "flex", gap: 10, padding: 8, borderTop: "1px solid var(--fs-border)", overflowX: "auto", height: 270, flexShrink: 0 }}>
          {charts.length === 0 ? <span className="fs-dim" style={{ fontSize: 12 }}>No charts on this sheet. Select a range with labels in the first column and numbers to the right, then press “Chart”.</span> : null}
          {charts.map((c) => {
            let src = "", error = "";
            try { src = svgDataUri(buildChartSvg(c.kind, c.title, chartDataFromRange(workbook, c.sheet, c.range, c.headerRow), 420, 220)); } catch (e) { error = (e as Error).message; }
            return (
              <div key={c.id} data-chart={c.id} style={{ flexShrink: 0, width: 424, border: "1px solid var(--fs-border)", borderRadius: 6, padding: 4 }}>
                <div className="fs-row" style={{ gap: 4, fontSize: 11, marginBottom: 2 }}>
                  <input className="fs-input" aria-label="Chart title" value={c.title} onChange={(e) => { c.title = e.target.value.slice(0, 120); setRev((r) => r + 1); setDirty(true); }} style={{ flex: 1 }} />
                  <select className="fs-input" aria-label="Chart type" value={c.kind} onChange={(e) => mutate(() => { c.kind = e.target.value as ChartKind; })} style={{ width: 80 }}>
                    <option value="bar">bar</option><option value="line">line</option><option value="pie">pie</option><option value="scatter">scatter</option>
                  </select>
                  <span className="fs-mono fs-dim">{c.range}</span>
                  <button className="fs-btn" data-variant="ghost" onClick={() => mutate((wb) => { wb.charts = wb.charts.filter((x) => x.id !== c.id); })}>✕</button>
                </div>
                {error ? <div style={{ color: "#ff9b9b", fontSize: 11.5, padding: 8 }}>Chart unavailable: {error}</div> : <ChartImg alt={c.title || "chart"} src={src} />}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="fs-row" data-testid="status-bar" style={{ gap: 14, padding: "3px 10px", borderTop: "1px solid var(--fs-border)", fontSize: 11 }}>
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
function nextId(prefix: string, used: string[]): string { let n = used.length + 1; while (used.includes(`${prefix}${n}`)) n++; return `${prefix}${n}`; }
function ChartImg({ alt, src }: { alt: string; src: string }) {
  // data: URI SVG (script-inert inside <img>); next/image optimisation does not apply to data URIs
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={alt} src={src} width={420} height={220} style={{ display: "block" }} />;
}
function TB({ label, onClick, active, title, style }: { label: string; onClick: () => void; active?: boolean; title?: string; style?: React.CSSProperties }) {
  return <button type="button" className="fs-btn" data-variant={active ? "primary" : "ghost"} aria-label={title ?? label} title={title ?? label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} style={{ padding: "2px 7px", minWidth: 26, ...style }}>{label}</button>;
}
const clamp = (v: number, max: number, min = 0) => Math.max(min, Math.min(max, v));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function quoteSheet(name: string): string { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`; }
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
