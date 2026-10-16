"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { Workbook, Sheet, a1, isError, colToLetters, parseFormula, workbookFromJson, workbookToJson, type WorkbookJson, type Scalar } from "@/lib/formula/client";

const COLS = 18;
const ROWS = 60;
const SAMPLE = {
  A1: "Item", B1: "Qty", C1: "Price", D1: "Total",
  A2: "Widget", B2: "3", C2: "9.5", D2: "=B2*C2",
  A3: "Gadget", B3: "2", C3: "14.25", D3: "=B3*C3",
  A4: "", B4: "", C4: "Sum", D4: "=SUM(D2:D3)",
  A6: "Average price", B6: "=AVERAGE(C2:C3)",
  A7: "Tax", B7: "=D2*TaxRate!B1",
};

/**
 * Spreadsheet: multi-sheet workbook UI over the first-party formula engine.
 * Each keystroke invalidates the full bounded workbook (18×60 grid in the UI),
 * and dependencies are recursively resolved/cycle-checked by the Workbook.
 * Export is multi-sheet SpreadsheetML (OOXML); importing recomputes formula
 * values rather than trusting cached <v> values. Office support is a tested
 * subset; no charts/pivots/macros are claimed.
 */
export default function SpreadsheetModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [workbook, setWorkbook] = useState(() => new Workbook());
  const [active, setActive] = useState("Sheet1");
  const [rev, setRev] = useState(0);
  const [sel, setSel] = useState({ col: 0, row: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sheet = workbook.sheets.get(active) ?? workbook.sheet();

  const recalc = useCallback((wb: Workbook) => { wb.recalculate(); setRev((r) => r + 1); }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const wb = new Workbook();
      if (path.toLowerCase().endsWith(".xlsx")) {
        try {
          const r = await post<{ ok: boolean; workbook: WorkbookJson }>("/api/sheet", { op: "importXlsx", path });
          const imported = workbookFromJson(r.workbook);
          if (alive) { setWorkbook(imported); setActive(imported.sheets.keys().next().value ?? "Sheet1"); }
        } catch (e) {
          if (alive) { shell.toast(`Could not import .xlsx: ${String((e as Error).message)}`, "bad"); setWorkbook(new Workbook()); }
        }
      } else if (path) {
        try {
          const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
          const data = JSON.parse(r.node.content) as WorkbookJson & { name?: string; cells?: { ref: string; input: string }[] };
          const json: WorkbookJson = data.sheets ? data : { sheets: [{ name: data.name ?? "Sheet1", cells: data.cells ?? [] }] };
          const imported = workbookFromJson(json);
          if (alive) { setWorkbook(imported); setActive(imported.sheets.keys().next().value ?? "Sheet1"); }
        } catch {
          if (alive) { shell.toast("Starting a new workbook (the selected path was empty or not a Fusion workbook).", "info"); loadSample(wb); setWorkbook(wb); }
        }
      } else {
        loadSample(wb);
        const rates = new Sheet("TaxRate"); rates.setCell(0, 0, "Sales tax"); rates.setCell(1, 0, "0.08");
        wb.sheets.set(rates.name, rates);
        if (alive) { setWorkbook(wb); setActive("Sheet1"); }
      }
      if (alive) { recalc(wb); setLoaded(true); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const loadSample = (wb: Workbook) => {
    const s = wb.sheet("Sheet1");
    for (const [ref, input] of Object.entries(SAMPLE)) {
      const m = /^([A-Za-z]+)(\d+)$/.exec(ref)!;
      s.setCell(colLettersToIndex(m[1]), Number(m[2]) - 1, input);
    }
  };

  const setCellInput = (col: number, row: number, input: string) => {
    sheet.setCell(col, row, input);
    recalc(workbook);
    setDirty(true);
  };

  const toJson = () => workbookToJson(workbook);

  const save = async () => {
    const dest = path || `/Documents/workbook-${Date.now()}.fworkbook`;
    await post("/api/fs", { op: "write", path: dest, content: JSON.stringify(toJson()), reason: "spreadsheet-save" });
    setDirty(false); setStatus(`saved ${dest}`); shell.bumpRefresh();
    if (!path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest } });
  };

  const exportXlsx = async () => {
    const dest = (path || "/Documents/workbook").replace(/\.(fworkbook|fsheet|xlsx)$/i, "") + ".xlsx";
    const r = await post<{ ok: boolean; path: string; bytes: number; sheets: number; error?: string }>("/api/sheet", { op: "saveXlsxToVfs", workbook: toJson(), dest });
    if (r.ok) { setStatus(`exported ${r.bytes} B · ${r.sheets} sheet(s) → ${r.path}`); shell.bumpRefresh(); }
    else shell.toast(r.error ?? "export failed", "bad");
  };

  const importXlsx = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) { shell.toast(".xlsx exceeds the 8 MB import guard", "warn"); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const b64 = toBase64(bytes);
    const r = await post<{ ok: boolean; workbook?: WorkbookJson; error?: string }>("/api/sheet", { op: "importXlsx", base64: b64 });
    if (!r.ok || !r.workbook) { shell.toast(r.error ?? "import failed", "bad"); return; }
    const wb = workbookFromJson(r.workbook);
    setWorkbook(wb); setActive(wb.sheets.keys().next().value ?? "Sheet1");
    setDirty(true); recalc(wb);
    shell.toast(`Imported ${wb.sheets.size} sheet(s) — formulas re-evaluated by Fusion, not just cached values.`, "ok");
  };

  const newSheet = () => {
    let n = workbook.sheets.size + 1;
    while (workbook.sheets.has(`Sheet${n}`)) n++;
    const s = workbook.addSheet(`Sheet${n}`);
    setWorkbook(workbook); setActive(s.name); setSel({ col: 0, row: 0 }); setDirty(true); recalc(workbook);
  };

  const renameSheet = (old: string) => {
    const next = prompt("Sheet name (max 31 chars; no : \\ / ? * [ ])", old)?.trim();
    if (!next || next === old) return;
    if (next.length > 31 || /[:\\/?*\[\]]/.test(next)) { shell.toast("Invalid sheet name (max 31 chars; : \\ / ? * [ ] are forbidden)", "warn"); return; }
    if ([...workbook.sheets.keys()].some((s) => s.toLowerCase() === next.toLowerCase())) { shell.toast("A sheet with that name already exists.", "warn"); return; }
    const renamed = new Workbook(); renamed.sheets.clear();
    for (const [name, oldSheet] of workbook.sheets) {
      const s = new Sheet(name === old ? next : name); s.grid = oldSheet.grid;
      // Update only explicit sheet-qualified references to the renamed sheet.
      for (const cell of s.grid.values()) {
        if (cell.formula && cell.input.includes(`${old}!`)) {
          cell.input = cell.input.replaceAll(`${old}!`, `${quoteSheet(next)}!`);
          try { cell.formula = parseFormula(cell.input); } catch { /* keep previous AST; error shown in cell */ }
        }
      }
      renamed.sheets.set(s.name, s);
    }
    setWorkbook(renamed); setActive(next); setDirty(true); recalc(renamed);
  };

  const deleteSheet = (name: string) => {
    if (workbook.sheets.size <= 1) { shell.toast("A workbook must contain at least one sheet.", "warn"); return; }
    if (!confirm(`Delete sheet “${name}”? Formulas referring to it may become errors.`)) return;
    workbook.sheets.delete(name);
    const next = workbook.sheets.keys().next().value as string;
    setWorkbook(workbook); setActive(next); setDirty(true); recalc(workbook);
  };

  const cellDisplay = (col: number, row: number) => {
    const cell = sheet.get(col, row);
    if (!cell) return { text: "", isErr: false, isFormula: false };
    const v: Scalar = cell.value;
    return { text: isError(v) ? v.error : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v), isErr: isError(v), isFormula: Boolean(cell.formula) };
  };
  const selInput = sheet.get(sel.col, sel.row)?.input ?? "";
  const commitEditing = (next: { col: number; row: number } | null) => {
    if (editing !== null) setCellInput(sel.col, sel.row, editing);
    setEditing(null);
    if (next) setSel(next);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing !== null) {
      if (e.key === "Enter") { e.preventDefault(); commitEditing({ col: sel.col, row: Math.min(ROWS - 1, sel.row + 1) }); }
      else if (e.key === "Tab") { e.preventDefault(); commitEditing({ col: Math.min(COLS - 1, sel.col + 1), row: sel.row }); }
      else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
      return;
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], Enter: [0, 1], Tab: [1, 0] };
    if (moves[e.key]) { e.preventDefault(); const [dc, dr] = moves[e.key]; setSel((s) => ({ col: Math.max(0, Math.min(COLS - 1, s.col + dc)), row: Math.max(0, Math.min(ROWS - 1, s.row + dr)) })); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); setCellInput(sel.col, sel.row, ""); return; }
    if (e.key === "F2") { e.preventDefault(); setEditing(selInput); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) setEditing(e.key);
  };

  const colHeaders = useMemo(() => Array.from({ length: COLS }, (_, i) => colToLetters(i)), []);
  if (!loaded) return <div style={{ padding: 16, fontSize: 12 }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={() => void save()}>Save workbook</Btn>
        <Btn variant="ghost" onClick={() => void exportXlsx()}>Export .xlsx</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import .xlsx<input type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importXlsx(f); }} /></label>
        <Badge tone={dirty ? "warn" : "ok"}>{dirty ? "unsaved" : "saved"}</Badge>
        <Badge tone="info" title="First-party formula engine; see docs/OFFICE-ENGINE.md">from-scratch engine</Badge>
        {status ? <span className="fs-dim" style={{ fontSize: 11 }}>{status}</span> : null}
      </div>
      <div className="fs-row" style={{ gap: 4, padding: "4px 6px", borderBottom: "1px solid var(--fs-border)", overflowX: "auto" }}>
        {[...workbook.sheets.keys()].map((name) => (
          <button key={name} className="fs-btn" data-variant={name === active ? "primary" : "ghost"} onClick={() => { commitEditing(null); setActive(name); setSel({ col: 0, row: 0 }); }} onDoubleClick={() => renameSheet(name)} title="Double-click to rename">
            {name}
          </button>
        ))}
        <Btn variant="ghost" onClick={newSheet}>+ Sheet</Btn>
        <Btn variant="ghost" onClick={() => renameSheet(active)}>Rename</Btn>
        <Btn variant="ghost" onClick={() => deleteSheet(active)}>Delete</Btn>
        <span className="fs-dim" style={{ fontSize: 10.5, marginLeft: "auto" }}>{workbook.sheets.size} sheets · cross-sheet formulas supported (e.g. =TaxRate!B1)</span>
      </div>
      <div className="fs-row" style={{ padding: "4px 8px", gap: 6, borderBottom: "1px solid var(--fs-border)" }}>
        <span className="fs-mono" style={{ fontSize: 11.5, width: 60 }}>{active}!{colToLetters(sel.col)}{sel.row + 1}</span>
        <input className="fs-input fs-mono" style={{ flex: 1 }} aria-label="Formula bar"
          value={editing !== null ? editing : selInput} onChange={(e) => setEditing(e.target.value)}
          onFocus={() => setEditing((cur) => cur ?? selInput)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitEditing({ col: sel.col, row: Math.min(ROWS - 1, sel.row + 1) }); gridRef.current?.focus(); } if (e.key === "Escape") setEditing(null); }}
          onBlur={() => commitEditing(null)} />
      </div>
      <div ref={gridRef} tabIndex={0} className="fs-scroll" style={{ flex: 1, minHeight: 0, outline: "none" }} onKeyDown={onKeyDown}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead><tr><th style={{ width: 32, background: "rgba(255,255,255,.04)" }} />{colHeaders.map((h) => <th key={h} style={{ minWidth: 76, padding: 2, background: "rgba(255,255,255,.04)", borderBottom: "1px solid var(--fs-border)", position: "sticky", top: 0 }}>{h}</th>)}</tr></thead>
          <tbody>{Array.from({ length: ROWS }, (_, row) => (
            <tr key={row}><td className="fs-dim" style={{ textAlign: "center", background: "rgba(255,255,255,.03)", borderRight: "1px solid var(--fs-border)" }}>{row + 1}</td>
              {Array.from({ length: COLS }, (_, col) => {
                const d = cellDisplay(col, row); const isSel = sel.col === col && sel.row === row;
                return <td key={col} onClick={() => { commitEditing(null); setSel({ col, row }); gridRef.current?.focus(); }} onDoubleClick={() => setEditing(sheet.get(col, row)?.input ?? "")}
                  style={{ border: "1px solid var(--fs-border)", padding: "2px 5px", minWidth: 76, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "cell", outline: isSel ? "2px solid var(--fs-accent)" : "none", outlineOffset: -2, color: d.isErr ? "#ff9b9b" : d.isFormula ? "#bcd4ff" : "var(--fs-text)", background: isSel ? "rgba(91,140,255,.12)" : "transparent" }}>
                  {isSel && editing !== null ? <input autoFocus className="fs-input fs-mono" style={{ padding: 0, border: 0, background: "transparent", height: 18 }} value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={() => commitEditing(null)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitEditing({ col, row: Math.min(ROWS - 1, row + 1) }); gridRef.current?.focus(); } }} /> : d.text}
                </td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function colLettersToIndex(letters: string): number {
  let n = 0; for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1;
}
function quoteSheet(name: string): string { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`; }
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
