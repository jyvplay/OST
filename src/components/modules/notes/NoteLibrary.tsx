"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { askConfirm, askText } from "@/lib/ask";
import { noteMarkdown } from "@/lib/note-markdown";
import { type NoteFields, type NoteRecord } from "@/lib/note-model";
import { expandNoteTemplate, exportNoteCopies, importNoteCopies, mergedNote, noteTemplate, NOTE_COLLECTION_BYTES } from "@/lib/note-workflows";
import { Btn } from "../../ui";

type TemplateFile = { path: string; name: string; kind: string };
function TaskBoard({ rows, onOpen, onToggle, disabled }: { rows: NoteRecord[]; onOpen: (id: number) => Promise<void>; onToggle: (row: NoteRecord, line: number) => Promise<void>; disabled: boolean }) {
  const [completed, setCompleted] = useState(false);
  const { tasks, scanned } = useMemo(() => {
    const tasks: { row: NoteRecord; line: number; text: string; checked: boolean }[] = []; let chars = 0, scanned = 0;
    for (const row of rows.slice(0, 100)) {
      if (chars + row.body.length > 2_097_152) break;
      chars += row.body.length; scanned++;
      for (const block of noteMarkdown(row.body).blocks) if (block.kind === "task") {
        if (completed || !block.checked) tasks.push({ row, line: block.line, text: block.text, checked: block.checked });
        if (tasks.length >= 200) break;
      }
      if (tasks.length >= 200) break;
    }
    return { tasks, scanned };
  }, [rows, completed]);
  return <div data-testid="note-task-board" style={{ display: "grid", gap: 6 }}>
    <label><input type="checkbox" checked={completed} onChange={e => setCompleted(e.target.checked)} /> Include completed tasks</label>
    <small>{tasks.length} tasks · {scanned}/{rows.length} notes scanned. Caps: 100 notes, 2,097,152 UTF-16 code units, 200 tasks, 5,000 lines/note. Saved snapshots only.</small>
    {tasks.map(task => <div key={`${task.row.id}:${task.line}`} style={{ display: "flex", alignItems: "start", gap: 4 }}>
      <input type="checkbox" aria-label={`${task.checked ? "Reopen" : "Complete"} task: ${task.text}`} checked={task.checked} disabled={disabled} onChange={() => void onToggle(task.row, task.line)} />
      <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{task.text} <button className="fs-btn fs-btn-ghost" disabled={disabled} onClick={() => void onOpen(task.row.id)}>{task.row.title}</button></span>
    </div>)}
    {!tasks.length ? <p>No matching tasks in the scanned saved notes</p> : null}
  </div>;
}
export default function NoteLibrary({ rows, shown, checked, setChecked, createBatch, onToggle, onOpen, disabled }: {
  rows: NoteRecord[]; shown: NoteRecord[]; checked: number[]; setChecked: (ids: number[]) => void; createBatch: (notes: NoteFields[]) => Promise<void>;
  onToggle: (row: NoteRecord, line: number) => Promise<void>; onOpen: (id: number) => Promise<void>; disabled: boolean;
}) {
  const [panel, setPanel] = useState<"tasks" | "templates" | null>(null), [templates, setTemplates] = useState<TemplateFile[]>([]);
  const [error, setError] = useState(""), [status, setStatus] = useState(""), [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null), mounted = useRef(false), pending = useRef(false), epoch = useRef(0), read = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    const invalidate = () => { epoch.current++; read.current?.abort(); };
    const clear = () => { invalidate(); setTemplates([]); setPanel(null); setStatus(""); setError(""); };
    window.addEventListener("fusion:privacy-locked", clear);
    return () => { mounted.current = false; invalidate(); window.removeEventListener("fusion:privacy-locked", clear); };
  }, []);
  const selected = rows.filter(row => checked.includes(row.id));
  const run = async (operation: (current: () => boolean) => Promise<void>) => {
    if (!mounted.current || pending.current || disabled) return;
    const own = epoch.current; pending.current = true; setBusy(true); setError(""); setStatus("");
    try { await operation(() => mounted.current && epoch.current === own); }
    catch (failure) { if (mounted.current && epoch.current === own) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const blocked = disabled || busy;
  const loadTemplates = () => run(async current => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    let nodes: TemplateFile[] = [];
    try { nodes = (await api<{ nodes: TemplateFile[] }>(`/api/fs?op=list&path=${encodeURIComponent("/System/NoteTemplates")}`, { signal: controller.signal })).nodes; }
    catch (failure) { if ((failure as { status?: number }).status !== 404) throw failure; }
    if (current()) { setPanel("templates"); setTemplates(nodes.filter(node => node.kind === "file" && node.name.endsWith(".json")).slice(0, 64)); setStatus(nodes.length > 64 ? "Showing the first 64 template files. Manage the folder in Files." : ""); }
  });
  return <details data-testid="note-library" style={{ padding: "0 6px 6px", overflowWrap: "anywhere", maxHeight: "48%", overflowY: "auto", flexShrink: 0 }}><summary style={{ cursor: "pointer" }}>Library</summary>
    <div style={{ display: "grid", gap: 6, paddingTop: 6 }}>
      <div className="fs-row" style={{ flexWrap: "wrap", gap: 4 }}><Btn disabled={blocked || shown.length > 32 || !shown.length} onClick={() => setChecked(shown.map(row => row.id))}>Check shown</Btn><Btn disabled={!checked.length} onClick={() => setChecked([])}>Clear checks</Btn><span>{selected.length}/32 checked</span></div>
      {shown.length > 32 ? <small>Filter to 32 or fewer notes to check all shown.</small> : null}
      <Btn disabled={blocked || selected.length < 2} onClick={() => void run(async current => {
        const title = await askText("Merged note title", "Merged notes", { title: "Merge saved note copies", detail: "Uses checked saved snapshots in list order. No source note or editor draft is changed.", okLabel: "Create merged note" });
        if (title && current()) { await createBatch([mergedNote(selected, title)]); if (current()) setStatus("Merged copy created; sources unchanged"); }
      })}>Merge checked…</Btn>
      <Btn disabled={blocked || !selected.length} onClick={() => void run(async () => {
        const text = exportNoteCopies(selected), url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "note-copies.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); setStatus("Portable copies exported; identities and timestamps are intentionally excluded");
      })}>Export checked JSON</Btn>
      <Btn disabled={blocked} onClick={() => file.current?.click()}>Import JSON copies…</Btn>
      <input ref={file} hidden type="file" accept=".json,application/json" aria-label="Import note collection" onChange={event => {
        const chosen = event.target.files?.[0]; event.target.value = ""; if (!chosen) return;
        void run(async current => {
          if (chosen.size > NOTE_COLLECTION_BYTES) throw new Error("Import is limited to 4 MiB");
          const copies = importNoteCopies(new TextDecoder("utf-8", { fatal: true }).decode(await chosen.arrayBuffer()));
          if (!current()) return;
          if (await askConfirm({ title: `Import ${copies.length} new note copies?`, detail: "All copies and their search index commit together. Existing identities, notes and unsaved editor drafts are untouched. Not queued offline.", okLabel: "Import copies" }) && current()) { await createBatch(copies); if (current()) setStatus(`${copies.length} copies imported`); }
        });
      }} />
      <div className="fs-row" style={{ flexWrap: "wrap", gap: 4 }}><Btn disabled={blocked} aria-expanded={panel === "tasks"} onClick={() => setPanel(panel === "tasks" ? null : "tasks")}>Tasks</Btn><Btn disabled={blocked} aria-expanded={panel === "templates"} onClick={() => void loadTemplates()}>Templates</Btn></div>
      {panel === "tasks" ? <TaskBoard rows={rows} disabled={blocked} onOpen={onOpen} onToggle={onToggle} /> : null}
      {panel === "templates" ? <div data-testid="note-templates"><small>Plain tokens: {"{{title}}, {{date}}, {{time}}"} (local clock). No script execution.</small>
        {templates.map(template => <Btn key={template.path} disabled={blocked} style={{ display: "block", width: "100%", marginTop: 4, overflowWrap: "anywhere" }} onClick={() => void run(async current => {
          read.current?.abort(); const controller = new AbortController(); read.current = controller;
          const response = await api<{ node: { content: string; encoding: string } }>(`/api/fs?op=read&path=${encodeURIComponent(template.path)}`, { signal: controller.signal });
          if (response.node.encoding !== "utf8" || new TextEncoder().encode(response.node.content).byteLength > NOTE_COLLECTION_BYTES) throw new Error("Template must be bounded UTF-8 JSON");
          const parsed = noteTemplate(JSON.parse(response.node.content)); if (!current()) return;
          const title = await askText("New note title", parsed.fields.title, { title: "Create from template", okLabel: "Create note" });
          if (title && current()) { await createBatch([expandNoteTemplate(parsed, title, new Date())]); if (current()) setStatus("Template copy created; source template unchanged"); }
        })}>{template.name.replace(/\.json$/, "")}</Btn>)}
        {!templates.length ? <p>No saved templates. Use a note’s Text tools → Save template.</p> : null}
      </div> : null}
      {status ? <small role="status">{status}</small> : null}{error ? <div role="alert">{error}</div> : null}
    </div>
  </details>;
}
