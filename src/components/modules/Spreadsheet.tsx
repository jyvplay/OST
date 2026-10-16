"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import {
  Workbook, Sheet, a1, isError, colToLetters, FUNCTIONS, EXT_FUNCTIONS, workbookFromJson, workbookToJson, formatValue, BUILTIN_FORMATS,
  norm, rangeA1, toTsv, parseTsv, copyBlock, pasteBlock, clearRange, autoFill, sortRange, insertDelete, findAll, replaceAll, selectionStats, shiftFormula,
  chartDataFromRange, buildChartSvg, svgDataUri, evalCondFormats, parseRange, currentRegion, jump, fillTarget, looksLikeHeader,
  completionToken, completions, activeCall, SIGNATURES, hasValueIn,
  type WorkbookJson, type CellStyle, type Range, type Clip, type ChartKind, type CondKind, type Scalar,
} from "@/lib/formula/client";

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
  const [panel, setPanel] = useState<null | "find" | "charts" | "cf">(null);
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
  const selR = useMemo(() => norm({ c0: sel.a.col, r0: sel.a.row, c1: sel.f.col, r1: sel.f.row }), [sel]);
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
      else if ((target.get(col, row)?.input ?? "") !== text) mutate(() => target.setCell(col, row, text));
    }
    setEditing(null);
    if (move) moveTo({ col: clamp(editAt.col + move[0], COLS - 1), row: clamp(editAt.row + move[1], ROWS - 1) });
  };
  const token = editing !== null ? completionToken(editing) : null;
  const acList = token ? completions(token, fnNames) : [];
  const call = editing !== null && editing.startsWith("=") ? activeCall(editing) : null;
  const acceptCompletion = (name: string) => { if (editing !== null && token) { setEditing(editing.slice(0, editing.length - token.length) + name + "("); setAcIdx(0); } };
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
  const moveTo = (p: Pos, extend = false) => { setSel((s) => (extend ? { a: s.a, f: p } : { a: p, f: p })); requestAnimationFrame(() => ensureVisible(p)); };
  const has = hasValueIn(workbook, active);

  const gridKeys = (e: React.KeyboardEvent) => {
    if (editing !== null) return;
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    const arrows: Record<string, [number, number]> = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] };
    if (arrows[k]) {
      e.preventDefault(); const [dc, dr] = arrows[k];
      const p = mod ? jump(has, sel.f.col, sel.f.row, dc, dr, COLS - 1, ROWS - 1) : { col: clamp(sel.f.col + dc, COLS - 1), row: clamp(sel.f.row + dr, ROWS - 1) };
      moveTo(p, e.shiftKey); return;
    }
    if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod && (k === "b" || k === "i" || k === "u")) { e.preventDefault(); toggle(k === "b" ? "bold" : k === "i" ? "italic" : "underline"); return; }
    if (mod && k === "d") { e.preventDefault(); fillDir("down"); return; }
    if (mod && k === "r") { e.preventDefault(); fillDir("right"); return; }
    if (mod && k === "a") { e.preventDefault(); const r = currentRegion(has, sel.f.col, sel.f.row, COLS - 1, ROWS - 1); const whole = (r.c0 === selR.c0 && r.r0 === selR.r0 && r.c1 === selR.c1 && r.r1 === selR.r1) || !has(sel.f.col, sel.f.row); setSel(whole ? { a: { col: 0, row: 0 }, f: { col: COLS - 1, row: ROWS - 1 } } : { a: { col: r.c0, row: r.r0 }, f: { col: r.c1, row: r.r1 } }); return; }
    if (mod && k === "f") { e.preventDefault(); setPanel("find"); return; }
    if (mod && k === "home") { e.preventDefault(); moveTo({ col: 0, row: 0 }); return; }
    if (k === "home") { e.preventDefault(); moveTo({ col: 0, row: sel.f.row }, e.shiftKey); return; }
    if (k === "pagedown" || k === "pageup") { e.preventDefault(); const n = Math.max(1, Math.floor((gridRef.current?.clientHeight ?? 400) / ROW_H) - 2); moveTo({ col: sel.f.col, row: clamp(sel.f.row + (k === "pagedown" ? n : -n), ROWS - 1) }, e.shiftKey); return; }
    if (k === "enter") { e.preventDefault(); moveTo({ col: sel.f.col, row: clamp(sel.f.row + (e.shiftKey ? -1 : 1), ROWS - 1) }); return; }
    if (k === "tab") { e.preventDefault(); moveTo({ col: clamp(sel.f.col + (e.shiftKey ? -1 : 1), COLS - 1), row: sel.f.row }); return; }
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
    mutate((wb) => sortRange(wb, active, r, clamp(sel.f.col, r.c1, r.c0), asc, header));
    setStatus(`sorted ${rangeA1(r)} by ${colToLetters(clamp(sel.f.col, r.c1, r.c0))} ${asc ? "A→Z" : "Z→A"}${header ? " (header row kept)" : ""}`);
  };
  const structural = (axis: "row" | "col", insert: boolean) => {
    const at = axis === "row" ? selR.r0 : selR.c0; const n = axis === "row" ? selR.r1 - selR.r0 + 1 : selR.c1 - selR.c0 + 1;
    mutate((wb) => insertDelete(wb, active, axis, at, insert ? n : -n));
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
    commit(null);
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
  const totalW = useMemo(() => { let w = ROWHDR_W; for (let c = 0; c < COLS; c++) w += colW(c); return w; }, [colW]);
  const selInput = sheet.get(sel.f.col, sel.f.row)?.input ?? "";
  const cur = styleOf(sel.f);

  if (!loaded) return <div style={{ padding: 16, fontSize: 12 }}>Loading…</div>;

  const renderCell = (col: number, row: number) => {
    const cell = sheet.get(col, row); const st = cell?.style ?? {};
    const v: Scalar | undefined = workbook.valueAt(active, col, row);
    const fmt = formatValue(v, st.numFmt);
    const over = cfMap.get(`${col},${row}`);
    const inSel = col >= selR.c0 && col <= selR.c1 && row >= selR.r0 && row <= selR.r1;
    const isCur = sel.f.col === col && sel.f.row === row;
    const inFill = fillPreview && col >= fillPreview.c0 && col <= fillPreview.c1 && row >= fillPreview.r0 && row <= fillPreview.r1;
    const sp = spills.find((r) => col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1);
    const edge = "1px dashed #60a5fa", base = "1px solid var(--fs-border)";
    const err = v !== undefined && isError(v as never);
    const align = st.align ?? (typeof v === "number" ? "right" : typeof v === "boolean" || err ? "center" : "left");
    const editingHere = editing !== null && editSrc === "cell" && editAt.col === col && editAt.row === row && editSheet === active;
    const isFillCorner = !editing && col === selR.c1 && row === selR.r1;
    return (
      <td key={col} data-cell={a1(col, row)} onMouseDown={(e) => cellDown(e, { col, row })} onMouseEnter={() => cellEnter({ col, row })}
        onDoubleClick={() => startEdit(cell?.input ?? "")} title={cell?.error ?? (sp && !(sp.c0 === col && sp.r0 === row) ? `spilled from ${a1(sp.c0, sp.r0)}` : undefined)}
        style={{
          position: "relative", height: ROW_H, padding: "0 5px", overflow: editingHere ? "visible" : "hidden", textOverflow: "ellipsis", whiteSpace: st.wrap ? "normal" : "nowrap", cursor: "cell",
          borderTop: sp && row === sp.r0 ? edge : base, borderBottom: sp && row === sp.r1 ? edge : base, borderLeft: sp && col === sp.c0 ? edge : base, borderRight: sp && col === sp.c1 ? edge : base,
          fontWeight: st.bold || over?.bold ? 700 : undefined, fontStyle: st.italic ? "italic" : undefined, textDecoration: st.underline ? "underline" : undefined, textAlign: align,
          color: err ? "#ff9b9b" : fmt.color ?? over?.color ?? st.color ?? (cell?.formula ? "#bcd4ff" : "var(--fs-text)"),
          background: inFill ? "rgba(96,165,250,.18)" : inSel && !isCur ? `linear-gradient(rgba(91,140,255,.18),rgba(91,140,255,.18)),${over?.fill ?? st.fill ?? "transparent"}` : over?.fill ?? st.fill ?? "transparent",
          outline: isCur ? "2px solid var(--fs-accent)" : undefined, outlineOffset: -2,
        }}>
        {editingHere ? (
          <>
            <input autoFocus className="fs-input fs-mono" aria-label="Cell editor" style={{ padding: "0 2px", border: 0, height: ROW_H - 2, width: Math.max(colW(col) - 10, 160), position: "relative", zIndex: 5 }}
              value={editing ?? ""} onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }} onChange={(e) => { setEditing(e.target.value); setAcIdx(0); }} onKeyDown={editKeys} onBlur={() => { if (!dragRef.current) commit(null); }} />
            {renderAssist()}
          </>
        ) : fmt.text}
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

  const row = (r: number, sticky = false) => (
    <tr key={r} style={sticky ? { position: "sticky", top: HEAD_H, zIndex: 2, background: "var(--fs-bg, #0b1020)" } : undefined}>
      <td className="fs-dim" onMouseDown={() => { commit(null); setSel({ a: { col: 0, row: r }, f: { col: COLS - 1, row: r } }); gridRef.current?.focus(); }}
        style={{ position: "sticky", left: 0, zIndex: 1, textAlign: "center", fontSize: 10.5, background: r >= selR.r0 && r <= selR.r1 ? "rgba(91,140,255,.22)" : "var(--fs-bg-2, #131a2b)", borderRight: "1px solid var(--fs-border)", borderBottom: sticky ? "2px solid #475569" : "1px solid var(--fs-border)", cursor: "e-resize" }}>{r + 1}</td>
      {Array.from({ length: COLS }, (_, c) => renderCell(c, r))}
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
        <TB label="Sort A-Z" onClick={() => sort(true)} title={"Sort ascending by the active column"} /><TB label="Sort Z-A" onClick={() => sort(false)} title={"Sort descending by the active column"} />
        <TB label="+Row" onClick={() => structural("row", true)} title={"Insert rows above selection"} /><TB label="-Row" onClick={() => structural("row", false)} title={"Delete selected rows"} />
        <TB label="+Col" onClick={() => structural("col", true)} title={"Insert columns left of selection"} /><TB label="-Col" onClick={() => structural("col", false)} title={"Delete selected columns"} />
        <TB label="Freeze" onClick={() => mutate((_wb, s) => { s.freezeRows = s.freezeRows ? 0 : 1; })} active={sheet.freezeRows > 0} title={"Freeze top row"} />
        <span style={{ width: 6 }} />
        <TB label="Chart" onClick={() => addChart("bar")} title={"Insert a chart from the selection (or current region)"} />
        <TB label={`Charts${charts.length ? ` (${charts.length})` : ""}`} onClick={() => setPanel(panel === "charts" ? null : "charts")} active={panel === "charts"} title="Show charts" />
        <TB label="Cond. format" onClick={() => setPanel(panel === "cf" ? null : "cf")} active={panel === "cf"} title={"Conditional formatting rules"} />
        <TB label="Find" onClick={() => setPanel(panel === "find" ? null : "find")} active={panel === "find"} title={"Find & replace (Ctrl+F)"} />
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
        <span className="fs-mono" data-testid="name-box" style={{ fontSize: 11.5, minWidth: 90 }}>{active}!{rangeA1(selR)}</span>
        <span className="fs-dim fs-mono" style={{ fontSize: 12 }}>ƒx</span>
        <div style={{ flex: 1, position: "relative" }}>
          <input className="fs-input fs-mono" style={{ width: "100%" }} aria-label="Formula bar"
            value={editing !== null ? editing : selInput} onChange={(e) => { if (editing === null) startEdit(e.target.value, "bar"); else setEditing(e.target.value); setAcIdx(0); }}
            onFocus={() => { if (editing === null) startEdit(selInput, "bar"); else setEditSrc("bar"); }} onKeyDown={editKeys} onBlur={() => { if (!dragRef.current) commit(null); }} />
          {editing !== null && editSrc === "bar" ? renderAssist() : null}
        </div>
      </div>
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
                  style={{ position: "relative", height: HEAD_H, fontWeight: 500, fontSize: 11, background: c >= selR.c0 && c <= selR.c1 ? "rgba(91,140,255,.22)" : "var(--fs-bg-2, #131a2b)", borderBottom: "1px solid var(--fs-border)", borderRight: "1px solid var(--fs-border)", cursor: "s-resize" }}>
                  {colToLetters(c)}
                  <div data-resize="1" data-testid={`resize-${colToLetters(c)}`} onMouseDown={(e) => { e.stopPropagation(); pushUndo(); dragRef.current = { mode: "resize", col: c, x: e.clientX, w: colW(c) }; }}
                    onDoubleClick={() => mutate((_wb, s) => { delete s.colWidths[c]; })} style={{ position: "absolute", right: -3, top: 0, width: 6, height: "100%", cursor: "col-resize", zIndex: 2 }} />
                </th>
              ))}
            </tr>
            {frozen ? row(0, true) : null}
          </thead>
          <tbody>
            <tr style={{ height: (first - frozen) * ROW_H }} />
            {Array.from({ length: last - first + 1 }, (_, i) => row(first + i))}
            <tr style={{ height: (ROWS - 1 - last) * ROW_H }} />
          </tbody>
        </table>
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
