"use client";
import OrbitTarget from "../OrbitTarget";
import { askConfirm } from "@/lib/ask";
import { fz } from "@/lib/uiscale";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtTime, post, put } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Btn, Empty } from "../ui";
import { sortNotes, type NoteSort } from "@/lib/note-sort";
import { allTags, filterByTag } from "@/lib/note-tags";
import { findDailyNote, dailyTitle } from "@/lib/daily-note";
import { notesBundle } from "@/lib/notes-bundle";
import { filterNotes, importNoteMarkdown, noteCopyTitle, NOTE_LIMITS, type NoteFields, type NoteRecord } from "@/lib/note-model";
import NoteEditor from "./notes/NoteEditor";
import NoteLibrary from "./notes/NoteLibrary";
import { toggleNoteTask } from "@/lib/note-markdown";

/** A selected snapshot survives background list refresh/deletion. Only an
 * explicit, guarded navigation replaces the editor; typing is never a fetch
 * side effect. No Markdown is interpreted on the server. */
export default function NotesModule({ win }: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<NoteRecord[]>([]), [checked, setChecked] = useState<number[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSort>("updated"), [tagFilter, setTagFilter] = useState("all"), [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ id: number | null; note: NoteRecord | null; generation: number }>({ id: (win.props.noteId as number) ?? null, note: null, generation: 0 });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const pending = useRef(false), mounted = useRef(false), lastCommitted = useRef<NoteRecord | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await api<{ rows: NoteRecord[] }>("/api/notes", { signal });
    if (signal?.aborted || !mounted.current) return result.rows;
    setRows(result.rows); setError("");
    setSelected(s => s.note ? s : { ...s, note: result.rows.find(n => n.id === s.id) ?? (s.id === null ? result.rows[0] : null) ?? null, id: s.id ?? result.rows[0]?.id ?? null });
    return result.rows;
  }, []);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(String(e instanceof Error ? e.message : e)); });
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);
  const perform = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await operation(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const beforeLeave = async () => {
    if (!mounted.current) return false;
    const choice = await shell.askSave(win.id);
    return mounted.current && choice !== "cancelled";
  };
  const orbitRecord = async (record: NoteRecord): Promise<NoteRecord | null> => {
    if (!mounted.current) return null;
    const before = lastCommitted.current;
    const choice = await shell.askSave(win.id);
    if (!mounted.current || choice === "cancelled") return null;
    // A Save in the leave dialog advances this exact record's revision. Use
    // that acknowledged commit, NOT a fresh GET accepting an unseen writer.
    if (choice === "saved" && selected.id === record.id && lastCommitted.current !== before) {
      const saved = lastCommitted.current;
      if (!saved || saved.id !== record.id) throw new Error("Saved note was not published; refresh and retry");
      return saved;
    }
    return record;
  };
  const choose = (note: NoteRecord) => setSelected(s => ({ id: note.id, note, generation: s.generation + 1 }));
  const open = async (id: number) => {
    if (id === selected.id) return;
    await perform(async () => { if (!await beforeLeave()) return; const result = await api<{ row: NoteRecord }>(`/api/notes?id=${id}`); choose(result.row); });
  };
  const create = (title = "Untitled", body = "", tags = "") => perform(async () => {
    if (!await beforeLeave()) return;
    const result = await post<{ row: NoteRecord }>("/api/notes", { title, body, tags }); await load(); choose(result.row);
  });
  const remove = async (id: number, revision: number) => {
    await api(`/api/notes?id=${id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: revision }) });
    setRows(old => old.filter(n => n.id !== id));
    if (selected.id === id) setSelected(s => ({ id: null, note: null, generation: s.generation + 1 }));
  };
  const committed = (record: NoteRecord) => {
    lastCommitted.current = record;
    setRows(old => old.some(n => n.id === record.id) ? old.map(n => n.id === record.id ? record : n) : [record, ...old]);
    setSelected(s => s.id === record.id ? { ...s, note: record } : s);
  };
  const refresh = () => perform(async () => {
    if (!await beforeLeave()) return;
    const current = await load(); const next = current.find(n => n.id === selected.id) ?? current[0];
    if (next) choose(next); else setSelected(s => ({ id: null, note: null, generation: s.generation + 1 }));
  });
  const importFile = (file: File) => perform(async () => {
    if (file.size > NOTE_LIMITS.body) throw new Error("Markdown import is limited to 1 MiB of UTF-8 bytes");
    const value = importNoteMarkdown(new Uint8Array(await file.arrayBuffer()), file.name);
    if (!await beforeLeave()) return;
    const result = await post<{ row: NoteRecord }>("/api/notes", value); await load(); choose(result.row);
  });
  const createBatch = async (fields: NoteFields[]) => {
    // Deliberately not post(): these new writes must never masquerade as an
    // offline-queued acknowledgement. Never navigate or replace a draft.
    const response = await api<{ rows: NoteRecord[] }>("/api/notes/batch", { method: "POST", body: JSON.stringify({ notes: fields }) });
    if (!mounted.current) return;
    setRows(old => [...response.rows, ...old]);
    shell.toast(`${response.rows.length} note ${response.rows.length === 1 ? "copy" : "copies"} created`, "ok");
  };
  const toggleSavedTask = (record: NoteRecord, line: number) => perform(async () => {
    const current = await orbitRecord(record); if (!current) return;
    if (current.body.split("\n")[line] !== record.body.split("\n")[line]) throw new Error("The task source changed. Refresh the library before retrying.");
    const result = await api<{ row: NoteRecord }>("/api/notes", { method: "PUT", body: JSON.stringify({ id: current.id, expectedRevision: current.revision, body: toggleNoteTask(current.body, line) }) });
    committed(result.row); if (selected.id === result.row.id) choose(result.row);
  });
  const shown = sortNotes(filterNotes(filterByTag(rows, tagFilter), query), noteSort);
  return <div style={{ display: "grid", gridTemplateColumns: `min(${fz(220)}, 38%) minmax(0, 1fr)`, height: "100%", minHeight: 0 }}>
    <div style={{ borderRight: "1px solid var(--fs-border)", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
      {error ? <div role="alert" style={{ padding: 6, overflowWrap: "anywhere" }}>{error}</div> : null}
      <div className="fs-row" style={{ padding: 6, gap: 4, flexWrap: "wrap" }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" style={{ width: fz(21), height: fz(21), flexShrink: 0 }}><path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
        <Btn variant="primary" disabled={busy} onClick={() => void create()}>New</Btn>
        <Btn variant="ghost" disabled={busy} aria-label="Refresh notes" onClick={() => void refresh()}>↻</Btn>
        <Btn variant="ghost" disabled={busy} aria-label="Open daily note" title="Open or create today's note" onClick={() => void perform(async () => {
          if (!await beforeLeave()) return;
          const current = await load(), found = findDailyNote(current);
          const note = found ? current.find(n => n.id === found.id)! : (await post<{ row: NoteRecord }>("/api/notes", { title: dailyTitle(), body: "" })).row;
          await load(); choose(note);
        })}>Daily</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ fontSize: fz(12), cursor: busy ? "default" : "pointer" }}>Import<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="Import Markdown note" disabled={busy} style={{ display: "none" }} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importFile(file); }} /></label>
      </div>
      <input className="fs-input" value={query} aria-label="Filter notes" placeholder="Filter notes" onChange={e => setQuery(e.target.value)} style={{ margin: "0 6px 5px", width: "calc(100% - 12px)", minWidth: 0 }} />
      <div className="fs-row" style={{ gap: 5, padding: "2px 6px", flexWrap: "wrap" }}>
        <select className="fs-select" style={{ width: "100%", minWidth: 0 }} aria-label="Sort notes" value={noteSort} onChange={e => setNoteSort(e.target.value as NoteSort)} data-testid="notes-sort"><option value="updated">Recently edited</option><option value="title">Title A–Z</option><option value="created">Oldest first</option></select>
        {allTags(rows).length ? <select className="fs-select" style={{ width: "100%", minWidth: 0 }} aria-label="Filter notes by tag" value={tagFilter} onChange={e => setTagFilter(e.target.value)} data-testid="notes-tag-filter"><option value="all">All tags</option>{allTags(rows).map(t => <option key={t} value={t}>{t}</option>)}<option value="untagged">Untagged</option></select> : null}
        <span role="status" className="fs-dim" style={{ fontSize: fz(11) }}>{shown.length} / {rows.length}</span>
      </div>
      <NoteLibrary rows={sortNotes(rows, noteSort)} shown={shown} checked={checked} setChecked={setChecked} createBatch={createBatch} onToggle={toggleSavedTask} onOpen={open} disabled={busy} />
      <div className="fs-scroll" aria-label="Notes list" style={{ flex: 1, minHeight: 0, padding: 4 }}>
        {shown.map(n => <OrbitTarget key={n.id} label={`Note: ${n.title}`} actions={[
          { label: "Open note", run: () => open(n.id) },
          { label: "Copy saved text", run: () => shell.copy(n.body, "notes") },
          { label: n.pinned ? "Unpin note" : "Pin note", run: () => perform(async () => { const current = await orbitRecord(n); if (!current) return; const result = await put<{ row: NoteRecord }>("/api/notes", { id: current.id, expectedRevision: current.revision, pinned: !current.pinned }); committed(result.row); if (selected.id === current.id) choose(result.row); }) },
          { label: "Duplicate note", run: () => perform(async () => {
            const current = await orbitRecord(n); if (!current) return;
            const result = await post<{ row: NoteRecord }>("/api/notes", { title: noteCopyTitle(current.title), body: current.body, tags: current.tags }); await load(); choose(result.row);
          }) },
          { label: "Delete note…", run: () => perform(async () => { const current = await orbitRecord(n); if (!current) return; if (await askConfirm({ title: `Delete “${current.title}”?`, detail: "Deletes the saved note and its search entry, not Files Trash.", okLabel: "Delete note" })) await remove(current.id, current.revision); }) },
        ]}>
          <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
          <input type="checkbox" style={{ width: 24, height: 24, flexShrink: 0 }} aria-label={`Check note: ${n.title}`} checked={checked.includes(n.id)} disabled={busy || (!checked.includes(n.id) && rows.filter(row => checked.includes(row.id)).length >= 32)} onChange={e => { const value = e.currentTarget.checked; setChecked(old => value ? [...old.filter(id => rows.some(row => row.id === id)), n.id] : old.filter(id => id !== n.id)); }} />
          <button className="fs-list-item" disabled={busy} data-selected={n.id === selected.id} style={{ width: "100%", textAlign: "left", border: 0, background: n.id === selected.id ? "rgba(91,140,255,.22)" : "none", color: "inherit" }} onClick={() => void open(n.id)}>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}><span title={n.title} style={{ display: "block", fontSize: fz(12), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.pinned ? <svg aria-label="Pinned" viewBox="0 0 16 16" width="12" height="12"><path d="m6 2 7 7-3 1-3 4-1-4-4-1 3-3z" fill="none" stroke="currentColor" /></svg> : null} {n.title}</span><span className="fs-dim" style={{ fontSize: fz(10.5) }}>{fmtTime(n.updatedAt)}</span></span>
          </button></div>
        </OrbitTarget>)}
        {!shown.length ? <Empty title={rows.length ? "No matching notes" : "No notes"} glyph="emptyNote" /> : null}
      </div>
    </div>
    {selected.note ? <NoteEditor key={`${selected.id}-${selected.generation}`} note={selected.note} rows={rows} winId={win.id} onCommitted={committed} onCreateBatch={createBatch} onOpen={open} onExtract={create} onDelete={remove} onExportAll={async () => {
      await post("/api/fs", { op: "write", path: "/notes-bundle.md", content: notesBundle(rows.map(n => ({ title: n.title, body: n.body, tags: n.tags })), new Date()), mime: "text/markdown", reason: "notes-bundle" }); shell.toast("Exported all notes to /notes-bundle.md", "ok");
    }} /> : <Empty title="Select a note" glyph="emptyNote" />}
    {busy ? <span className="sr-only" role="status">Updating notes…</span> : null}
  </div>;
}
