"use client";
import { AppBanner, BannerGroup } from "@/components/AppBanner";
import { fz } from "@/lib/uiscale";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import * as T from "@/lib/tables-core";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

/**
 * Tables (TT22) — an Airtable-style relational base on top of the pure engine in src/lib/tables-core.ts.
 * Saved as a native `.ftable` JSON document in the VFS; CSV import/export for interchange. Every edit produces a new
 * immutable Base snapshot, so undo/redo is exact. Computed fields are derived on every render and never stored.
 */
type Panel = null | "filter" | "sort" | "group" | "hide" | "field";
// ASCII only: the bundled Nunito font has no arrows/stars/ballot boxes and the sandbox Chromium showed them as tofu
const TYPE_MARK: Record<T.FieldType, string> = {
  text: "Aa", longText: "Txt", number: "#", checkbox: "Y/N", singleSelect: "Sel", multiSelect: "Tags", date: "Date", url: "URL", email: "@",
  rating: "1-5", link: "Link", lookup: "Look", rollup: "Sum", count: "Cnt", formula: "fx", autonumber: "No.",
};
function Check({ on }: { on: boolean }) {
  return (
    <svg data-icon="check" viewBox="0 0 16 16" width="1.1em" height="1.1em" role="img" aria-label={on ? "checked" : "unchecked"} style={{ display: "inline-block", verticalAlign: "-0.15em" }}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill={on ? "var(--fs-accent)" : "none"} stroke={on ? "var(--fs-accent)" : "currentColor"} strokeWidth="1.5" opacity={on ? 1 : 0.6} />
      {on ? <path d="M4.5 8.3l2.3 2.3 4.7-5" fill="none" stroke="#04102b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}
function Stars({ n, max }: { n: number; max: number }) {
  return (
    <span role="img" aria-label={`${n} of ${max}`} style={{ whiteSpace: "nowrap" }}>
      {Array.from({ length: max }, (_, i) => (
        <svg key={i} data-icon="star" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-0.12em" }}>
          <path d="M8 1.6l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3l-4 2.3 1-4.4-3.4-3 4.5-.5z" fill={i < n ? "#ffc53d" : "none"} stroke={i < n ? "#ffc53d" : "currentColor"} strokeWidth="1.1" opacity={i < n ? 1 : 0.5} />
        </svg>
      ))}
    </span>
  );
}
const OPS: { id: T.FilterOp; label: string; needs: boolean }[] = [
  { id: "contains", label: "contains", needs: true }, { id: "notContains", label: "does not contain", needs: true },
  { id: "is", label: "is", needs: true }, { id: "isNot", label: "is not", needs: true }, { id: "hasAny", label: "has any of", needs: true },
  { id: "gt", label: ">", needs: true }, { id: "gte", label: ">=", needs: true }, { id: "lt", label: "<", needs: true }, { id: "lte", label: "<=", needs: true },
  { id: "isEmpty", label: "is empty", needs: false }, { id: "isNotEmpty", label: "is not empty", needs: false },
];
const CHIP_INK = "#14213d"; // option colours are all light pastels → dark ink ≥ 4.5:1
const fileName = (s: string) => s.replace(/[^a-z0-9-_ ]/gi, "").trim() || "base";

export default function TablesModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [hist, setHist] = useState<{ past: T.Base[]; now: T.Base; future: T.Base[] }>(() => ({ past: [], now: T.sampleBase(), future: [] }));
  const base = hist.now;
  const [loaded, setLoaded] = useState(!path);
  const [dirty, setDirty] = useState(false);
  const [tableId, setTableId] = useState(() => hist.now.tables[0].id);
  const [viewId, setViewId] = useState(() => hist.now.tables[0].views[0].id);
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [active, setActive] = useState<{ rec: string; field: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [linkPick, setLinkPick] = useState<{ rec: string; field: string } | null>(null);
  const [fieldMenu, setFieldMenu] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [renaming, setRenaming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // keep DOM focus on the active cell so arrow keys keep working (an effect, not a render-time ref)
  useEffect(() => {
    if (!active || editing) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`td[data-rec="${active.rec}"][data-fid="${active.field}"]`);
    if (el && document.activeElement !== el && rootRef.current?.contains(document.activeElement ?? null) !== false) el.focus();
  }, [active, editing]);

  useEffect(() => {
    if (!path) return;
    let live = true;
    (async () => {
      try {
        const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
        const b = T.loadBase(JSON.parse(r.node.content));
        if (live) { setHist({ past: [], now: b, future: [] }); setTableId(b.tables[0].id); setViewId(b.tables[0].views[0].id); }
      } catch (e) { if (live) setStatus(`Could not open ${path}: ${(e as Error).message} — showing a new base`); }
      if (live) setLoaded(true);
    })();
    return () => { live = false; };
  }, [path]);

  const table = T.tableById(base, tableId) ?? base.tables[0];
  const view = table.views.find((v) => v.id === viewId) ?? table.views[0];
  const result = useMemo(() => T.runView(base, table.id, view, search), [base, table.id, view, search]);
  const visible = table.fields.filter((f) => !view.hidden.includes(f.id));

  const commit = (next: T.Base) => { setHist((h) => ({ past: [...h.past.slice(-99), h.now], now: next, future: [] })); setDirty(true); };
  const attempt = (fn: () => T.Base) => { try { commit(fn()); return true; } catch (e) { shell.toast((e as Error).message, "bad"); return false; } };
  const undo = () => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), now: h.past.at(-1)!, future: [h.now, ...h.future] } : h));
  const redo = () => setHist((h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h));
  const setCell = (rec: string, field: string, v: unknown) => {
    const r = T.setCell(base, table.id, rec, field, v);
    if (r.ok) commit(r.base); else shell.toast(r.error, "bad");
    return r.ok;
  };
  const patchView = (patch: Partial<T.View>) => commit(T.updateView(base, table.id, view.id, patch));
  const pickTable = (id: string) => { const t = T.tableById(base, id)!; setTableId(id); setViewId(t.views[0].id); setActive(null); setEditing(null); setExpanded(null); setPanel(null); };

  const save = async () => {
    const dest = path && path.endsWith(".ftable") ? path : `/Documents/${fileName(base.name)}.ftable`;
    await post("/api/fs", { op: "write", path: dest, content: JSON.stringify(base), reason: "tables-save" });
    setDirty(false); setStatus(`saved ${dest}`); shell.bumpRefresh();
    if (!path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest, title: base.name } });
  };
  const exportCsv = async () => {
    const dest = `/Documents/${fileName(table.name)}.csv`;
    await post("/api/fs", { op: "write", path: dest, content: T.toCsv(base, table.id, view), reason: "tables-export" });
    setStatus(`exported ${result.rows.length} records (${view.name}) to ${dest}`); shell.bumpRefresh();
  };
  const importCsv = async (file: File) => {
    try {
      const r = T.importCsv(base, file.name.replace(/\.[^.]+$/, ""), await file.text());
      commit(r.base); pickTable(r.id);
      setStatus(`imported ${r.rows} records from ${file.name}${r.rejected ? ` — ${r.rejected} cell(s) refused by their field type` : ""}`);
    } catch (e) { shell.toast(`CSV import failed: ${(e as Error).message}`, "bad"); }
  };
  const addRecord = (cells: Record<string, unknown> = {}) => {
    const r = T.addRecord(base, table.id, cells); commit(r.base); setActive({ rec: r.id, field: table.fields[0].id }); setEditing(r.id + table.fields[0].id);
  };

  /* keyboard navigation over the grid (spreadsheet-like) */
  const onGridKey = (e: React.KeyboardEvent) => {
    if (!active || editing) return;
    const ri = result.rows.indexOf(active.rec), ci = visible.findIndex((f) => f.id === active.field);
    const move = (dr: number, dc: number) => { const r = result.rows[Math.max(0, Math.min(result.rows.length - 1, ri + dr))]; const c = visible[Math.max(0, Math.min(visible.length - 1, ci + dc))]; if (r && c) { setActive({ rec: r, field: c.id }); e.preventDefault(); } };
    if (e.key === "ArrowDown") move(1, 0); else if (e.key === "ArrowUp") move(-1, 0); else if (e.key === "ArrowRight" || e.key === "Tab" && !e.shiftKey) move(0, 1); else if (e.key === "ArrowLeft" || e.key === "Tab" && e.shiftKey) move(0, -1);
    else if (e.key === "Enter" || e.key === "F2") { const f = T.fieldById(table, active.field)!; if (f.type === "link") setLinkPick(active); else if (!T.COMPUTED.includes(f.type) && f.type !== "checkbox") setEditing(active.rec + active.field); else if (f.type === "checkbox") setCell(active.rec, f.id, !result.computed.get(active.rec)?.[f.id]); e.preventDefault(); }
    else if (e.key === "Delete" || e.key === "Backspace") { const f = T.fieldById(table, active.field)!; if (!T.COMPUTED.includes(f.type)) setCell(active.rec, f.id, f.type === "link" ? [] : null); e.preventDefault(); }
    else if (e.key === " " ) { setExpanded(active.rec); e.preventDefault(); }
  };

  if (!loaded) return <div style={{ padding: 16 }}>Opening base…</div>;

  const panelBox = (title: string, body: React.ReactNode) => (
    <div className="fs-card" role="group" aria-label={title} style={{ padding: 10, display: "grid", gap: 8, borderBottom: "1px solid var(--fs-border)", maxHeight: "40%", overflow: "auto" }}>
      <div className="fs-row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: fz(12) }}>{title}</strong><Btn variant="ghost" aria-label={`Close ${title}`} onClick={() => setPanel(null)}>Close</Btn></div>
      {body}
    </div>
  );
  const fieldSelect = (value: string | undefined, onChange: (v: string) => void, label: string, filter: (f: T.Field) => boolean = () => true, fields = table.fields) => (
    <select className="fs-select" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={{ width: "auto", minWidth: fz(130) }}>
      <option value="">— choose —</option>
      {fields.filter(filter).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );

  return (
    <div ref={rootRef} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }} data-testid="tables">
      {/* TT80 banner: Keep · Tweak · Glance (views) · Crunch · Put over one tool strip; table tabs below */}
      <AppBanner label="Tables" status={<>
          {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
      </>}>
        <BannerGroup name="Keep">
          <input className="fs-input" aria-label="Base name" value={base.name} style={{ flex: `0 1 ${fz(190)}`, minWidth: fz(110) }} onChange={(e) => commit({ ...base, name: e.target.value })} />
          <Btn variant="primary" onClick={() => void save()}>Save .ftable</Btn>
        </BannerGroup>
        <BannerGroup name="Tweak">
          <Btn variant="ghost" disabled={!hist.past.length} onClick={undo}>Undo</Btn>
          <Btn variant="ghost" disabled={!hist.future.length} onClick={redo}>Redo</Btn>
          <input className="fs-input" type="search" aria-label="Search records" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: fz(150) }} />
        </BannerGroup>
        <BannerGroup name="Glance">
          {table.views.map((v) => (
          <button key={v.id} type="button" className="fs-btn" aria-pressed={v.id === view.id} data-variant={v.id === view.id ? "primary" : "ghost"} onClick={() => { setViewId(v.id); setPanel(null); }} data-testid={`view-${v.name}`}>{v.name}</button>
          ))}
          <Btn variant="ghost" onClick={() => { const r = T.addView(base, table.id, "grid"); commit(r.base); setViewId(r.id); }}>+ Grid</Btn>
          <Btn variant="ghost" onClick={() => { const r = T.addView(base, table.id, "kanban"); commit(r.base); setViewId(r.id); }}>+ Kanban</Btn>
          <Btn variant="ghost" disabled={table.views.length <= 1} onClick={() => { if (attempt(() => T.deleteView(base, table.id, view.id))) setViewId(table.views.find((v) => v.id !== view.id)!.id); }}>Delete view</Btn>
        </BannerGroup>
        <BannerGroup name="Crunch">
          {(["filter", "sort", "group", "hide"] as const).map((p) => {
          const n = p === "filter" ? view.filters.length : p === "sort" ? view.sorts.length : p === "group" ? Number(Boolean(view.groupBy)) : view.hidden.length;
          const label = { filter: "Filter", sort: "Sort", group: "Group", hide: "Hide fields" }[p];
          return <Btn key={p} variant={panel === p || n ? "primary" : "ghost"} aria-expanded={panel === p} onClick={() => setPanel(panel === p ? null : p)}>{n ? `${label} · ${n}` : label}</Btn>;
          })}
        </BannerGroup>
        <BannerGroup name="Put">
          <Btn variant="ghost" aria-expanded={panel === "field"} onClick={() => setPanel(panel === "field" ? null : "field")}>+ Field</Btn>
          <Btn variant="ghost" onClick={() => addRecord()}>+ Record</Btn>
        </BannerGroup>
        <BannerGroup name="Keep">
          <Btn variant="ghost" onClick={() => fileRef.current?.click()}>Import CSV</Btn>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden aria-label="CSV file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ""; }} data-testid="tables-csv-input" />
          <Btn variant="ghost" onClick={() => void exportCsv()}>Export CSV</Btn>
        </BannerGroup>
      </AppBanner>
      {/* table tabs */}
      <div className="fs-row fs-toolbar" style={{ padding: "4px 6px", gap: 4, borderBottom: "1px solid var(--fs-border)" }}>
        <div role="tablist" aria-label="Tables" className="fs-row" style={{ gap: 4 }}>
        {base.tables.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === table.id} className="fs-btn" data-variant={t.id === table.id ? "primary" : "ghost"} onClick={() => pickTable(t.id)} data-testid={`table-tab-${t.name}`}>{t.name}</button>
        ))}
        </div>
        <Btn variant="ghost" onClick={() => { const r = T.addTable(base, `Table ${base.tables.length + 1}`); commit(r.base); pickTable(r.id); }}>+ Table</Btn>
        {renaming ? (
          <input className="fs-input" autoFocus aria-label="Table name" defaultValue={table.name} style={{ width: fz(150) }}
            onBlur={(e) => { commit(T.renameTable(base, table.id, e.target.value)); setRenaming(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }} />
        ) : <Btn variant="ghost" onClick={() => setRenaming(true)}>Rename table</Btn>}
        <Btn variant="ghost" disabled={base.tables.length <= 1} onClick={() => { if (attempt(() => T.deleteTable(base, table.id))) pickTable(base.tables.find((t) => t.id !== table.id)!.id); }}>Delete table</Btn>
      </div>
      {status ? <div className="fs-dim" role="status" style={{ padding: "3px 8px", fontSize: fz(11) }}>{status}</div> : null}

      {panel === "filter" && panelBox("Filter", <>
        {view.filters.map((flt, i) => {
          const f = T.fieldById(table, flt.field); const op = OPS.find((o) => o.id === flt.op)!;
          const upd = (p: Partial<T.Filter>) => patchView({ filters: view.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
          return (
            <div key={i} className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
              {i === 0 ? <span className="fs-dim" style={{ minWidth: fz(44) }}>Where</span> : i === 1 ? (
                <select className="fs-select" aria-label="Combine filters with" value={view.conjunction} onChange={(e) => patchView({ conjunction: e.target.value as "and" | "or" })} style={{ width: fz(70) }}><option value="and">and</option><option value="or">or</option></select>
              ) : <span className="fs-dim" style={{ minWidth: fz(44) }}>{view.conjunction}</span>}
              {fieldSelect(flt.field, (v) => upd({ field: v }), `Filter ${i + 1} field`)}
              <select className="fs-select" aria-label={`Filter ${i + 1} operator`} value={flt.op} onChange={(e) => upd({ op: e.target.value as T.FilterOp })} style={{ width: "auto" }}>
                {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {op.needs ? (f?.type === "singleSelect" && (flt.op === "is" || flt.op === "isNot") ? (
                <select className="fs-select" aria-label={`Filter ${i + 1} value`} value={flt.value ?? ""} onChange={(e) => upd({ value: e.target.value })} style={{ width: "auto" }}>
                  <option value="">—</option>{f.options?.map((o) => <option key={o.name}>{o.name}</option>)}
                </select>
              ) : <input className="fs-input" aria-label={`Filter ${i + 1} value`} value={flt.value ?? ""} onChange={(e) => upd({ value: e.target.value })} style={{ width: fz(140) }} />) : null}
              <Btn variant="ghost" aria-label={`Remove filter ${i + 1}`} onClick={() => patchView({ filters: view.filters.filter((_, j) => j !== i) })}>Remove</Btn>
            </div>
          );
        })}
        <div><Btn variant="ghost" onClick={() => patchView({ filters: [...view.filters, { field: table.fields[0].id, op: "contains", value: "" }] })}>+ Add condition</Btn></div>
      </>)}

      {panel === "sort" && panelBox("Sort", <>
        {view.sorts.map((s, i) => (
          <div key={i} className="fs-row" style={{ gap: 6 }}>
            <span className="fs-dim" style={{ minWidth: fz(54) }}>{i === 0 ? "Sort by" : "then by"}</span>
            {fieldSelect(s.field, (v) => patchView({ sorts: view.sorts.map((x, j) => (j === i ? { ...x, field: v } : x)) }), `Sort ${i + 1} field`)}
            <select className="fs-select" aria-label={`Sort ${i + 1} direction`} value={s.dir} onChange={(e) => patchView({ sorts: view.sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)) })} style={{ width: "auto" }}>
              <option value="asc">Ascending (A-Z, 1-9)</option><option value="desc">Descending (Z-A, 9-1)</option>
            </select>
            <Btn variant="ghost" aria-label={`Remove sort ${i + 1}`} onClick={() => patchView({ sorts: view.sorts.filter((_, j) => j !== i) })}>Remove</Btn>
          </div>
        ))}
        <div><Btn variant="ghost" onClick={() => patchView({ sorts: [...view.sorts, { field: table.fields[0].id, dir: "asc" }] })}>+ Add sort</Btn></div>
        <div className="fs-dim" style={{ fontSize: fz(11) }}>Empty cells always sort last, as in Airtable.</div>
      </>)}

      {panel === "group" && panelBox("Group", <div className="fs-row" style={{ gap: 6 }}>
        <span className="fs-dim">Group by</span>
        {fieldSelect(view.groupBy, (v) => patchView({ groupBy: v || undefined }), "Group by field", (f) => !["longText", "link", "lookup"].includes(f.type))}
        {view.kind === "kanban" ? <><span className="fs-dim">Stack by</span>{fieldSelect(view.stackBy, (v) => patchView({ stackBy: v || undefined }), "Kanban stack field", (f) => f.type === "singleSelect")}</> : null}
      </div>)}

      {panel === "hide" && panelBox("Hide fields", <div className="fs-row" style={{ gap: 10, flexWrap: "wrap" }}>
        {table.fields.map((f, i) => (
          <label key={f.id} className="fs-row" style={{ gap: 4 }}>
            <input type="checkbox" disabled={i === 0} checked={!view.hidden.includes(f.id)} onChange={(e) => patchView({ hidden: e.target.checked ? view.hidden.filter((x) => x !== f.id) : [...view.hidden, f.id] })} />
            {f.name}
          </label>
        ))}
      </div>)}

      {panel === "field" && <FieldEditor base={base} table={table} onCancel={() => setPanel(null)}
        onAdd={(spec) => { try { const r = T.addField(base, table.id, spec); commit(r.base); setPanel(null); setStatus(`added field “${T.fieldById(T.tableById(r.base, table.id)!, r.id)!.name}”`); } catch (e) { shell.toast((e as Error).message, "bad"); } }} />}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div className="fs-scroll" style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
          {view.kind === "kanban" ? (
            <Kanban base={base} table={table} view={view} search={search} onMove={(rec, opt) => setCell(rec, view.stackBy!, opt ?? null)} onOpen={setExpanded}
              onAdd={(opt) => addRecord(opt && view.stackBy ? { [view.stackBy]: opt } : {})} onPickStack={() => setPanel("group")} />
          ) : (
            <table className="fs-tables-grid" role="grid" aria-label={`${table.name} — ${view.name}`} aria-rowcount={result.rows.length + 1} onKeyDown={onGridKey}
              style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: fz(12.5), minWidth: "100%" }}>
              <thead>
                <tr>
                  <th scope="col" style={th(fz(46))}><span className="fs-dim">#</span></th>
                  {visible.map((f, i) => (
                    <th key={f.id} scope="col" style={{ ...th(fz(f.type === "longText" ? 240 : f.type === "checkbox" ? 90 : 160)), left: i === 0 ? fz(46) : undefined, zIndex: fieldMenu === f.id ? 6 : i === 0 ? 3 : 2 }}>
                      <button type="button" className="fs-btn" data-variant="ghost" aria-haspopup="menu" aria-expanded={fieldMenu === f.id} onClick={() => setFieldMenu(fieldMenu === f.id ? null : f.id)}
                        style={{ width: "100%", justifyContent: "flex-start", padding: "2px 4px", fontWeight: 700 }} data-testid={`field-${f.name}`}>
                        <span aria-hidden="true" className="fs-dim" style={{ fontSize: fz(10.5), minWidth: fz(18) }}>{TYPE_MARK[f.type]}</span>{f.name}
                      </button>
                      {fieldMenu === f.id ? <FieldMenu base={base} table={table} field={f} primary={i === 0} close={() => setFieldMenu(null)} commit={commit} toast={shell.toast} setStatus={setStatus}
                        sort={(dir) => { patchView({ sorts: [{ field: f.id, dir }] }); setFieldMenu(null); }} hide={() => { patchView({ hidden: [...view.hidden, f.id] }); setFieldMenu(null); }} /> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(result.groups ?? [{ key: "", rows: result.rows }]).map((g) => (
                  <GroupRows key={g.key || "all"} label={result.groups ? g.key : null} span={visible.length + 1}>
                    {g.rows.map((id) => {
                      const rec = table.records.find((r) => r.id === id)!; const row = result.computed.get(id)!;
                      return (
                        <tr key={id} data-record={id}>
                          <td style={{ ...td, width: fz(46), position: "sticky", left: 0, background: "var(--fs-panel-solid)", zIndex: 1 }}>
                            <button type="button" className="fs-btn" data-variant="ghost" aria-label={`Expand record ${rec.seq}`} onClick={() => setExpanded(id)} style={{ padding: "0 4px", minWidth: 0 }}>{rec.seq}</button>
                          </td>
                          {visible.map((f, i) => {
                            const isAct = active?.rec === id && active.field === f.id;
                            const key = id + f.id;
                            return (
                              <td key={f.id} role="gridcell" aria-selected={isAct} tabIndex={isAct || (!active && i === 0 && id === result.rows[0]) ? 0 : -1} data-field={f.name} data-rec={id} data-fid={f.id}
                                onClick={() => { setActive({ rec: id, field: f.id }); if (f.type === "checkbox") setCell(id, f.id, !row[f.id]); }}
                                onDoubleClick={() => { if (f.type === "link") setLinkPick({ rec: id, field: f.id }); else if (!T.COMPUTED.includes(f.type) && f.type !== "checkbox") setEditing(key); }}
                                style={{ ...td, outline: isAct ? "2px solid var(--fs-accent)" : undefined, outlineOffset: -2, position: i === 0 ? "sticky" : undefined, left: i === 0 ? fz(46) : undefined, background: i === 0 ? "var(--fs-panel-solid)" : undefined, zIndex: i === 0 ? 1 : undefined, fontWeight: i === 0 ? 600 : undefined }}>
                                {editing === key ? <CellEditor field={f} value={rec.cells[f.id] ?? null} onDone={(v, move) => { setEditing(null); if (v !== undefined) setCell(id, f.id, v); if (move) { const ri = result.rows.indexOf(id); const nx = result.rows[ri + 1]; if (nx) setActive({ rec: nx, field: f.id }); } }} />
                                  : <CellView base={base} field={f} value={row[f.id]} />}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </GroupRows>
                ))}
                <tr>
                  <td colSpan={visible.length + 1} style={{ ...td, borderBottom: 0 }}>
                    <Btn variant="ghost" onClick={() => addRecord()} style={{ padding: "2px 6px" }}>+ Add record</Btn>
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...td, ...foot }}><span className="fs-dim">{result.rows.length}</span></td>
                  {visible.map((f) => <td key={f.id} style={{ ...td, ...foot }} data-summary={f.name}><span className="fs-dim">{T.summarize(f, result.rows, result.computed)}</span></td>)}
                </tr>
              </tfoot>
            </table>
          )}
          {!result.rows.length && (view.filters.length || search) ? <div className="fs-dim" style={{ padding: 16 }}>No records match this view’s filters or search.</div> : null}
        </div>
        {expanded && table.records.some((r) => r.id === expanded) ? (
          <RecordPanel base={base} table={table} recId={expanded} computed={result.computed.get(expanded) ?? T.computeTable(base, table.id).get(expanded)!}
            onClose={() => setExpanded(null)} setCell={setCell} onPickLink={(field) => setLinkPick({ rec: expanded, field })}
            onDelete={() => { commit(T.deleteRecords(base, table.id, [expanded])); setExpanded(null); setActive(null); }}
            onDuplicate={() => { const r = T.duplicateRecord(base, table.id, expanded); commit(r.base); setExpanded(r.id); }} />
        ) : null}
      </div>
      {linkPick ? <LinkPicker base={base} table={table} pick={linkPick} onClose={() => setLinkPick(null)} setCell={setCell} /> : null}
    </div>
  );
}

const th = (w: string): React.CSSProperties => ({ minWidth: w, maxWidth: w, textAlign: "left", padding: 2, borderBottom: "1px solid var(--fs-border)", borderRight: "1px solid var(--fs-border)", position: "sticky", top: 0, background: "var(--fs-bg-2, var(--fs-panel-solid))", zIndex: 2, verticalAlign: "bottom" });
const td: React.CSSProperties = { padding: "3px 6px", borderBottom: "1px solid var(--fs-border)", borderRight: "1px solid var(--fs-border)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 0, height: "calc(10px + 16 * var(--fs-u))", cursor: "cell" };
const foot: React.CSSProperties = { position: "sticky", bottom: 0, background: "var(--fs-bg-2, var(--fs-panel-solid))", fontSize: fz(11), cursor: "default" };

function GroupRows({ label, span, children }: { label: string | null; span: number; children: React.ReactNode }) {
  return <>{label !== null ? <tr><th scope="rowgroup" colSpan={span} style={{ textAlign: "left", padding: "6px 8px", background: "var(--fs-bg-2, var(--fs-panel-solid))", borderBottom: "1px solid var(--fs-border)", fontSize: fz(12) }}>{label}</th></tr> : null}{children}</>;
}

function Chip({ name, color }: { name: string; color?: string }) {
  return <span style={{ display: "inline-block", padding: "0 calc(6 * var(--fs-u))", borderRadius: 999, background: color || "#dfe7f5", color: CHIP_INK, fontSize: fz(11), fontWeight: 600, marginRight: 3, lineHeight: 1.6 }}>{name}</span>;
}

function CellView({ base, field, value, inline }: { base: T.Base; field: T.Field; value: T.Cell | T.FVal | undefined; inline?: boolean }) {
  const numStyle: React.CSSProperties = inline ? { fontVariantNumeric: "tabular-nums" } : { display: "block", textAlign: "right", fontVariantNumeric: "tabular-nums" };
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return field.type === "checkbox" ? <Check on={false} /> : null;
  if (T.isErr(value)) return <span style={{ color: "var(--fs-bad-text, #ff9b9b)" }} title={String(value)}>{String(value).replace("#ERROR: ", "Error: ")}</span>;
  switch (field.type) {
    case "checkbox": return <Check on />;
    case "singleSelect": return <Chip name={String(value)} color={field.options?.find((o) => o.name === value)?.color} />;
    case "multiSelect": return <>{(value as string[]).map((v) => <Chip key={v} name={v} color={field.options?.find((o) => o.name === v)?.color} />)}</>;
    case "link": return <>{(value as string[]).map((id) => <Chip key={id} name={T.primaryText(base, field.linkTable!, id)} />)}</>;
    case "rating": return <Stars n={Number(value)} max={field.max ?? 5} />;
    case "url": return <a href={String(value)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{String(value).replace(/^https?:\/\//, "")}</a>;
    case "email": return <a href={`mailto:${String(value)}`} onClick={(e) => e.stopPropagation()}>{String(value)}</a>;
    case "number": case "rollup": case "count": case "autonumber": return <span style={numStyle}>{T.displayValue(field, value, base)}</span>;
    case "formula": return typeof value === "number" ? <span style={numStyle}>{T.str(value)}</span> : <span>{T.str(value as T.FVal)}</span>;
    default: return <span>{T.displayValue(field, value, base)}</span>;
  }
}

function CellEditor({ field, value, onDone }: { field: T.Field; value: T.Cell; onDone: (v: unknown, moveDown?: boolean) => void }) {
  const initial = field.type === "multiSelect" ? (value as string[] | null)?.join(", ") ?? "" : value === null ? "" : String(value);
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (val: unknown, move?: boolean) => { if (done.current) return; done.current = true; onDone(val, move); };
  const keys = (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === "Escape") finish(undefined); if (e.key === "Enter" && !(field.type === "longText" && e.shiftKey)) { e.preventDefault(); finish(v, true); } };
  const common = { autoFocus: true, className: "fs-input", "aria-label": `Edit ${field.name}`, onKeyDown: keys, onBlur: () => finish(v === initial ? undefined : v), style: { padding: "1px 4px", width: "100%" } };
  if (field.type === "singleSelect") return (
    <select {...common} className="fs-select" value={v} onChange={(e) => finish(e.target.value)}>
      <option value="">—</option>{field.options?.map((o) => <option key={o.name}>{o.name}</option>)}
    </select>
  );
  if (field.type === "date") return <input {...common} type="date" value={v} onChange={(e) => setV(e.target.value)} />;
  if (field.type === "number" || field.type === "rating") return <input {...common} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} />;
  return <input {...common} value={v} onChange={(e) => setV(e.target.value)} placeholder={field.type === "multiSelect" ? "comma, separated" : undefined} />;
}

function FieldEditor({ base, table, onAdd, onCancel }: { base: T.Base; table: T.Table; onAdd: (f: Omit<T.Field, "id">) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<T.FieldType>("text");
  const [extra, setExtra] = useState<Partial<T.Field>>({});
  const links = table.fields.filter((f) => f.type === "link");
  const via = extra.viaField ? T.fieldById(table, extra.viaField) : undefined;
  const target = via?.linkTable ? T.tableById(base, via.linkTable) : undefined;
  let formulaErr = "";
  if (type === "formula") { try { const n = T.parseFormula(extra.formula ?? ""); const unknown = [...T.formulaRefs(n)].filter((r) => !T.fieldByName(table, r)); if (unknown.length) formulaErr = `unknown field(s): ${unknown.join(", ")}`; } catch (e) { formulaErr = (e as Error).message; } }
  const ready = (type !== "link" || extra.linkTable) && (!["lookup", "rollup"].includes(type) || (extra.viaField && extra.targetField)) && (type !== "count" || extra.viaField) && (type !== "formula" || !formulaErr);
  return (
    <div className="fs-card" role="group" aria-label="Add field" style={{ padding: 10, display: "grid", gap: 8, borderBottom: "1px solid var(--fs-border)" }} data-testid="field-editor">
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" aria-label="Field name" placeholder="Field name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: fz(170) }} />
        <select className="fs-select" aria-label="Field type" value={type} onChange={(e) => { setType(e.target.value as T.FieldType); setExtra({}); }} style={{ width: "auto" }}>
          {T.FIELD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        {type === "number" ? <label className="fs-row" style={{ gap: 4 }}>Decimals<input className="fs-input" type="number" min={0} max={8} aria-label="Decimal places" value={extra.precision ?? 0} onChange={(e) => setExtra({ ...extra, precision: Math.max(0, Math.min(8, Number(e.target.value) || 0)) })} style={{ width: fz(64) }} /></label> : null}
        {type === "rating" ? <label className="fs-row" style={{ gap: 4 }}>Max<input className="fs-input" type="number" min={1} max={10} aria-label="Maximum rating" value={extra.max ?? 5} onChange={(e) => setExtra({ ...extra, max: Math.max(1, Math.min(10, Number(e.target.value) || 5)) })} style={{ width: fz(64) }} /></label> : null}
        {type === "singleSelect" || type === "multiSelect" ? <input className="fs-input" aria-label="Options (comma separated)" placeholder="Options, comma separated" onChange={(e) => setExtra({ ...extra, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map((n, i) => ({ name: n, color: T.PALETTE[i % T.PALETTE.length] })) })} style={{ width: fz(220) }} /> : null}
        {type === "link" ? (
          <select className="fs-select" aria-label="Link to table" value={extra.linkTable ?? ""} onChange={(e) => setExtra({ linkTable: e.target.value })} style={{ width: "auto" }}>
            <option value="">— link to table —</option>{base.tables.map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === table.id ? " (this table)" : ""}</option>)}
          </select>
        ) : null}
        {["lookup", "rollup", "count"].includes(type) ? (
          <select className="fs-select" aria-label="Via link field" value={extra.viaField ?? ""} onChange={(e) => setExtra({ ...extra, viaField: e.target.value, targetField: undefined })} style={{ width: "auto" }}>
            <option value="">— via link field —</option>{links.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : null}
        {(type === "lookup" || type === "rollup") && target ? (
          <select className="fs-select" aria-label="Field on the linked table" value={extra.targetField ?? ""} onChange={(e) => setExtra({ ...extra, targetField: e.target.value })} style={{ width: "auto" }}>
            <option value="">— field on {target.name} —</option>{target.fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : null}
        {type === "rollup" ? (
          <select className="fs-select" aria-label="Rollup function" value={extra.rollup ?? "sum"} onChange={(e) => setExtra({ ...extra, rollup: e.target.value as T.RollupFn })} style={{ width: "auto" }}>
            {T.ROLLUP_FNS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        ) : null}
      </div>
      {["lookup", "rollup", "count"].includes(type) && !links.length ? <div className="fs-dim">This table has no link field yet — add a “Link to another table” field first.</div> : null}
      {type === "formula" ? (
        <div style={{ display: "grid", gap: 4 }}>
          <input className="fs-input fs-mono" aria-label="Formula" placeholder='e.g. {Hours} * 1.2 or IF({Done}, "yes", "")' value={extra.formula ?? ""} onChange={(e) => setExtra({ ...extra, formula: e.target.value })} />
          <div className={formulaErr ? "" : "fs-dim"} role="status" style={{ fontSize: fz(11), color: formulaErr ? "var(--fs-bad-text, #ff9b9b)" : undefined }}>
            {formulaErr ? `Error: ${formulaErr}` : `Fields: ${table.fields.map((f) => `{${f.name}}`).join(" ")} · Functions: ${T.FORMULA_FUNCTIONS.join(", ")}`}
          </div>
        </div>
      ) : null}
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="primary" disabled={!ready} onClick={() => onAdd({ name: name || T.FIELD_TYPES.find((t) => t.id === type)!.label, type, ...extra })}>Create field</Btn>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

function FieldMenu({ base, table, field, primary, close, commit, toast, setStatus, sort, hide }: {
  base: T.Base; table: T.Table; field: T.Field; primary: boolean; close: () => void; commit: (b: T.Base) => void;
  toast: (m: string, tone?: "info" | "ok" | "warn" | "bad") => void; setStatus: (s: string) => void; sort: (d: "asc" | "desc") => void; hide: () => void;
}) {
  const [name, setName] = useState(field.name);
  const [type, setType] = useState<T.FieldType>(field.type);
  const [formula, setFormula] = useState(field.formula ?? "");
  const convertible = T.FIELD_TYPES.filter((t) => !["link", "lookup", "rollup", "count"].includes(t.id));
  return (
    <div role="menu" aria-label={`${field.name} field options`} className="fs-card" onKeyDown={(e) => { if (e.key === "Escape") close(); e.stopPropagation(); }}
      style={{ position: "absolute", top: "100%", left: 0, zIndex: 20, minWidth: fz(250), padding: 8, display: "grid", gap: 6, fontWeight: 400, background: "var(--fs-panel-solid)", boxShadow: "0 10px 30px rgba(0,0,0,.35)" }}>
      <input className="fs-input" aria-label="Rename field" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { commit(T.renameField(base, table.id, field.id, name)); close(); } }} />
      {field.type === "formula" ? <input className="fs-input fs-mono" aria-label="Edit formula" value={formula} onChange={(e) => setFormula(e.target.value)} /> : null}
      {field.type !== "link" && !["lookup", "rollup", "count"].includes(field.type) ? (
        <select className="fs-select" aria-label="Change field type" value={type} onChange={(e) => setType(e.target.value as T.FieldType)}>
          {convertible.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      ) : null}
      <Btn role="menuitem" variant="primary" onClick={() => {
        try {
          let b = name !== field.name ? T.renameField(base, table.id, field.id, name) : base;
          if (field.type === "formula" && formula !== field.formula) { T.parseFormula(formula); b = T.updateField(b, table.id, field.id, { formula }); }
          if (type !== field.type) { const r = T.changeFieldType(b, table.id, field.id, type, type === "formula" ? { formula: formula || "0" } : {}); b = r.base; setStatus(r.lost ? `converted to ${type}: ${r.lost} cell(s) could not be converted and were cleared (Undo restores them)` : `converted to ${type}`); }
          commit(b); close();
        } catch (e) { toast((e as Error).message, "bad"); }
      }}>Apply</Btn>
      <Btn role="menuitem" variant="ghost" onClick={() => sort("asc")}>Sort ascending</Btn>
      <Btn role="menuitem" variant="ghost" onClick={() => sort("desc")}>Sort descending</Btn>
      {!primary ? <Btn role="menuitem" variant="ghost" onClick={hide}>Hide field</Btn> : null}
      {!primary ? <Btn role="menuitem" variant="danger" onClick={() => { try { commit(T.deleteField(base, table.id, field.id)); close(); } catch (e) { toast((e as Error).message, "bad"); } }}>Delete field</Btn> : null}
    </div>
  );
}

function RecordPanel({ base, table, recId, computed, onClose, setCell, onPickLink, onDelete, onDuplicate }: {
  base: T.Base; table: T.Table; recId: string; computed: Record<string, T.Cell | T.FVal>; onClose: () => void;
  setCell: (rec: string, field: string, v: unknown) => boolean; onPickLink: (field: string) => void; onDelete: () => void; onDuplicate: () => void;
}) {
  const rec = table.records.find((r) => r.id === recId)!;
  return (
    <aside aria-label={`Record ${T.primaryText(base, table.id, recId)}`} data-testid="record-panel" className="fs-scroll"
      style={{ width: `min(${fz(340)}, 45%)`, borderLeft: "1px solid var(--fs-border)", padding: 10, display: "grid", gap: 8, alignContent: "start", overflow: "auto", background: "var(--fs-panel-solid)" }}>
      <div className="fs-row" style={{ justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
        <strong style={{ fontSize: fz(14) }}>{T.primaryText(base, table.id, recId)}</strong>
        <div className="fs-row" style={{ gap: 4 }}>
          <Btn variant="ghost" onClick={onDuplicate}>Duplicate</Btn>
          <Btn variant="danger" onClick={onDelete}>Delete</Btn>
          <Btn variant="ghost" aria-label="Close record" onClick={onClose}>Close</Btn>
        </div>
      </div>
      {table.fields.map((f) => {
        const id = `rp-${recId}-${f.id}`; const v = rec.cells[f.id] ?? null;
        const ro = T.COMPUTED.includes(f.type);
        return (
          <div key={f.id} style={{ display: "grid", gap: 3 }}>
            {/* only real form controls get a <label for>: a label on the "Edit links" button would rename it to the field name */}
            <label htmlFor={ro || f.type === "link" ? undefined : id} className="fs-dim" style={{ fontSize: fz(11), fontWeight: 700 }}>{f.name}{ro ? " · computed" : ""}</label>
            {ro ? <div style={{ minHeight: fz(20) }}><CellView base={base} field={f} value={computed[f.id]} /></div>
              : f.type === "checkbox" ? <input id={id} type="checkbox" checked={Boolean(v)} onChange={(e) => setCell(recId, f.id, e.target.checked)} style={{ justifySelf: "start", width: fz(18), height: fz(18) }} />
              : f.type === "link" ? <div className="fs-row" style={{ flexWrap: "wrap", gap: 4 }}><CellView base={base} field={f} value={v} /><Btn variant="ghost" aria-label={`Edit links · ${f.name}`} onClick={() => onPickLink(f.id)}>Edit links</Btn></div>
              : f.type === "singleSelect" ? (
                <select id={id} className="fs-select" value={(v as string) ?? ""} onChange={(e) => setCell(recId, f.id, e.target.value)}>
                  <option value="">—</option>{f.options?.map((o) => <option key={o.name}>{o.name}</option>)}
                </select>
              ) : f.type === "longText" ? <textarea id={id} className="fs-input" rows={4} defaultValue={(v as string) ?? ""} key={String(v)} onBlur={(e) => { if (e.target.value !== (v ?? "")) setCell(recId, f.id, e.target.value); }} />
              : <input id={id} className="fs-input" type={f.type === "date" ? "date" : "text"} defaultValue={f.type === "multiSelect" ? ((v as string[] | null) ?? []).join(", ") : v === null ? "" : String(v)} key={JSON.stringify(v)}
                  onBlur={(e) => { const cur = f.type === "multiSelect" ? ((v as string[] | null) ?? []).join(", ") : v === null ? "" : String(v); if (e.target.value !== cur && !setCell(recId, f.id, e.target.value)) e.target.value = cur; }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />}
          </div>
        );
      })}
    </aside>
  );
}

function LinkPicker({ base, table, pick, onClose, setCell }: { base: T.Base; table: T.Table; pick: { rec: string; field: string }; onClose: () => void; setCell: (rec: string, field: string, v: unknown) => boolean }) {
  const f = T.fieldById(table, pick.field)!; const target = T.tableById(base, f.linkTable!)!;
  const cur = (table.records.find((r) => r.id === pick.rec)?.cells[f.id] as string[] | null) ?? [];
  const [q, setQ] = useState("");
  const list = target.records.filter((r) => T.primaryText(base, target.id, r.id).toLowerCase().includes(q.toLowerCase()));
  return (
    <div role="dialog" aria-modal="true" aria-label={`Link ${f.name} to ${target.name}`} data-testid="link-picker" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.35)", display: "grid", placeItems: "center", zIndex: 30 }}>
      <div className="fs-card" style={{ width: `min(${fz(380)}, 92%)`, maxHeight: "80%", display: "grid", gridTemplateRows: "auto auto 1fr auto", gap: 8, padding: 12, background: "var(--fs-panel-solid)" }}>
        <strong>Link {f.name} to {target.name}</strong>
        <input className="fs-input" autoFocus type="search" aria-label={`Find a ${target.name} record`} placeholder={`Find in ${target.name}`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="fs-scroll" style={{ overflow: "auto", display: "grid", gap: 2 }}>
          {list.map((r) => {
            const on = cur.includes(r.id);
            return (
              <label key={r.id} className="fs-row" style={{ gap: 6, padding: "3px 4px" }}>
                <input type="checkbox" checked={on} onChange={() => setCell(pick.rec, f.id, on ? cur.filter((x) => x !== r.id) : [...cur, r.id])} />
                {T.primaryText(base, target.id, r.id)}
              </label>
            );
          })}
          {!list.length ? <span className="fs-dim">No matching records in {target.name}.</span> : null}
        </div>
        <div className="fs-row" style={{ justifyContent: "flex-end" }}><Btn variant="primary" onClick={onClose}>Done</Btn></div>
      </div>
    </div>
  );
}

function Kanban({ base, table, view, search, onMove, onOpen, onAdd, onPickStack }: {
  base: T.Base; table: T.Table; view: T.View; search: string; onMove: (rec: string, option: string | null) => void; onOpen: (rec: string) => void; onAdd: (option: string | null) => void; onPickStack: () => void;
}) {
  const cols = T.kanbanColumns(base, table.id, view, search);
  const [over, setOver] = useState<string | null>(null);
  if (!cols.length) return <div style={{ padding: 16, display: "grid", gap: 8, justifyItems: "start" }}><span>A kanban view stacks records by a single-select field.</span><Btn variant="primary" onClick={onPickStack}>Choose a stack field</Btn></div>;
  const computed = T.computeTable(base, table.id);
  const stack = T.fieldById(table, view.stackBy!)!;
  const shown = table.fields.filter((f) => f.id !== stack.id && !view.hidden.includes(f.id)).slice(1, 4);
  return (
    <div className="fs-row" style={{ alignItems: "flex-start", gap: 10, padding: 10, minHeight: "100%" }} role="list" aria-label={`${view.name} board`}>
      {cols.map((c) => (
        <section key={c.key ?? "_none"} role="listitem" aria-label={`${c.label} (${c.rows.length})`} data-column={c.label}
          onDragOver={(e) => { e.preventDefault(); setOver(c.key ?? "_none"); }} onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/x-fusion-record"); if (id) onMove(id, c.key); }}
          style={{ flex: `0 0 ${fz(230)}`, display: "grid", gap: 6, padding: 6, borderRadius: 12, background: over === (c.key ?? "_none") ? "color-mix(in srgb, var(--fs-accent) 18%, transparent)" : "var(--fs-bg-2, rgba(255,255,255,.04))", border: "1px solid var(--fs-border)" }}>
          <div className="fs-row" style={{ justifyContent: "space-between" }}>{c.key ? <Chip name={c.label} color={c.color} /> : <span className="fs-dim" style={{ fontWeight: 700 }}>{c.label}</span>}<span className="fs-dim">{c.rows.length}</span></div>
          {c.rows.map((id) => (
            <article key={id} draggable onDragStart={(e) => { e.dataTransfer.setData("text/x-fusion-record", id); e.dataTransfer.effectAllowed = "move"; }} data-card={T.primaryText(base, table.id, id)}
              className="fs-card" style={{ padding: 8, display: "grid", gap: 4, cursor: "grab", background: "var(--fs-panel-solid)" }}>
              <button type="button" className="fs-btn" data-variant="ghost" onClick={() => onOpen(id)} style={{ justifyContent: "flex-start", fontWeight: 700, padding: "0 2px" }}>{T.primaryText(base, table.id, id)}</button>
              {shown.map((f) => { const v = computed.get(id)?.[f.id]; return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) ? null : <div key={f.id} style={{ fontSize: fz(11.5) }}><span className="fs-dim">{f.name}: </span><CellView base={base} field={f} value={v} inline /></div>; })}
              <select className="fs-select" aria-label={`Move ${T.primaryText(base, table.id, id)} to`} value={(computed.get(id)?.[stack.id] as string) ?? ""} onChange={(e) => onMove(id, e.target.value || null)} style={{ fontSize: fz(11) }}>
                <option value="">Uncategorized</option>{stack.options?.map((o) => <option key={o.name}>{o.name}</option>)}
              </select>
            </article>
          ))}
          <Btn variant="ghost" onClick={() => onAdd(c.key)}>+ New</Btn>
        </section>
      ))}
    </div>
  );
}
