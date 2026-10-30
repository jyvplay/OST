"use client";
import OrbitTarget from "../OrbitTarget";
import { askConfirm } from "@/lib/ask";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, post, put } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { analyzeNote } from "@/lib/notes-stats";
import { sortNotes, type NoteSort } from "@/lib/note-sort";
import { findDailyNote, dailyTitle } from "@/lib/daily-note";
import { noteFilename, noteToMarkdown } from "@/lib/note-export";
import { notesBundle } from "@/lib/notes-bundle";
import { extractTags, resolveLinks, backlinks } from "@/lib/note-links";

interface Note { id: number; title: string; body: string; tags: string; pinned: boolean; updatedAt: string }

/** PR-02: notes land in the same index as files, so one search covers both. */
export default function NotesModule({ win }: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Note[]>([]);
  const [noteSort, setNoteSort] = useState<NoteSort>("updated");
  const [sel, setSel] = useState<number | null>((win.props.noteId as number) ?? null);
  const [edit, setEdit] = useState<Note | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = edit?.id === sel ? edit : rows.find(n => n.id === sel) ?? null;
  const dirty = edit !== null && edit.id === sel;

  const load = useCallback(async () => {
    try {
      const r = await api<{ rows: Note[] }>("/api/notes"); setRows(r.rows); setError(null);
      setSel(s => s === null ? r.rows[0]?.id ?? null : s);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    let live = true;
    void api<{ rows: Note[] }>("/api/notes").then(r => {
      if (!live) return; setRows(r.rows); setSel(s => s === null ? r.rows[0]?.id ?? null : s);
    }).catch(e => { if (live) setError(String(e instanceof Error ? e.message : e)); });
    return () => { live = false; };
  }, []);

  const save = async () => {
    if (!draft) return;
    await put("/api/notes", { id: draft.id, title: draft.title, body: draft.body, tags: draft.tags });
    setEdit(current => current === draft ? null : current);
    shell.toast("Note saved and re-indexed", "ok");
    await load();
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: `min(${fz(200)}, 38%) minmax(0, 1fr)`, height: "100%", minHeight: 0 }}>
      <div style={{ borderRight: "1px solid var(--fs-border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {error ? <Badge tone="bad">{error}</Badge> : null}
        <div className="fs-row" style={{ padding: 6, gap: 4 }}>
          <Btn variant="primary" onClick={async () => {
            const r = await post<{ row: Note }>("/api/notes", { title: "Untitled", body: "" });
            await load();
            setSel(r.row.id);
          }}>New</Btn>
          <Btn variant="ghost" onClick={() => void load()}>↻</Btn>
          <Btn variant="ghost" aria-label="Open daily note" title="Open (or create) today's daily note" onClick={async () => {
            const existing = findDailyNote(rows);
            if (existing) { setSel(existing.id); return; }
            const r = await post<{ row: Note }>("/api/notes", { title: dailyTitle(), body: "" });
            await load();
            setSel(r.row.id);
          }}>Daily</Btn>
        </div>
        <label className="fs-row" style={{ gap: 6, padding: "2px 6px", fontSize: fz(11) }}>Sort
          <select className="fs-select" style={{ width: "auto" }} aria-label="Sort notes" value={noteSort} onChange={(e) => setNoteSort(e.target.value as NoteSort)} data-testid="notes-sort">
            <option value="updated">Recently edited</option><option value="title">Title A–Z</option><option value="created">Oldest first</option>
          </select>
        </label>
        <div className="fs-scroll" style={{ flex: 1, minHeight: 0, padding: 4 }}>
          {sortNotes(rows, noteSort).map((n) => (
            <OrbitTarget key={n.id} label={`Note: ${n.title}`} actions={[
              { label: "Open note", disabled: dirty && sel !== n.id, run: () => setSel(n.id) },
              { label: "Copy saved text", run: () => shell.copy(n.body, "notes") },
              { label: n.pinned ? "Unpin note" : "Pin note", disabled: dirty, run: async () => { await put("/api/notes", { id: n.id, pinned: !n.pinned }); await load(); } },
              { label: "Duplicate note", disabled: dirty, run: async () => { await post("/api/notes", { title: `${n.title} copy`, body: n.body, tags: n.tags }); await load(); } },
              { label: "Delete note…", disabled: dirty, run: async () => {
                if (!await askConfirm({ title: `Delete “${n.title}”?`, detail: "Deletes the saved note and its search entry. This is not the Files Trash.", okLabel: "Delete note" })) return;
                await api(`/api/notes?id=${n.id}`, { method: "DELETE" }); if (sel === n.id) setSel(null); await load();
              } },
            ]}>
            <button className="fs-list-item" data-selected={n.id === sel}
              style={{ width: "100%", textAlign: "left", border: 0, background: n.id === sel ? "rgba(91,140,255,.22)" : "none", color: "inherit" }}
              onClick={() => setSel(n.id)}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: fz(12) }}>{n.pinned ? "📌 " : ""}{n.title}</div>
                <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{fmtTime(n.updatedAt)}</div>
              </span>
            </button>
            </OrbitTarget>
          ))}
          {rows.length === 0 ? <Empty title="No notes" icon="🗒" /> : null}
        </div>
      </div>

      {draft ? (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* TT22: wraps on narrow windows — at phone width the two inputs had shrunk to slivers */}
          <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
            <input className="fs-input" style={{ flex: `1 1 ${fz(140)}`, minWidth: fz(110) }} value={draft.title} aria-label="Note title"
              onChange={(e) => { setEdit({ ...draft, title: e.target.value }); }} />
            <input className="fs-input" style={{ flex: `0 1 ${fz(150)}`, minWidth: fz(90) }} placeholder="tags" value={draft.tags} aria-label="Tags"
              onChange={(e) => { setEdit({ ...draft, tags: e.target.value }); }} />
            <Btn variant="primary" disabled={!dirty} onClick={() => void save()}>Save</Btn>
            <Btn variant="ghost" onClick={() => void put("/api/notes", { id: draft.id, pinned: !draft.pinned }).then(load)}>
              {draft.pinned ? "Unpin" : "Pin"}
            </Btn>
            <Btn variant="ghost" title="Save this note as a Markdown file in Files" onClick={async () => {
              const name = noteFilename(draft.title);
              await post("/api/fs", { op: "write", path: `/${name}`, content: noteToMarkdown(draft), mime: "text/markdown", reason: "notes-export" });
              shell.toast(`Exported to /${name}`, "ok");
            }}>Export .md</Btn>
            <Btn variant="ghost" title="Save every note as one Markdown bundle in Files" onClick={async () => {
              await post("/api/fs", { op: "write", path: "/notes-bundle.md", content: notesBundle(rows.map((n) => ({ title: n.title, body: n.body, tags: n.tags })), new Date()), mime: "text/markdown", reason: "notes-bundle" });
              shell.toast("Exported all notes to /notes-bundle.md", "ok");
            }} data-testid="notes-bundle">Export all</Btn>
            <Btn variant="ghost" title="PR-06 mail handoff: opens your mail app with the note pre-filled"
              onClick={() => {
                // mailto URLs are length-limited in practice (~2 000 chars in some clients); truncate visibly
                const body = draft.body.length > 1800 ? `${draft.body.slice(0, 1800)}\n\n[truncated by Fusion — full note is in Notes]` : draft.body;
                window.location.href = `mailto:?subject=${encodeURIComponent(draft.title)}&body=${encodeURIComponent(body)}`;
              }}>Email</Btn>
            {"share" in navigator ? (
              <Btn variant="ghost" onClick={() => void navigator.share({ title: draft.title, text: draft.body }).catch(() => undefined)}>Share</Btn>
            ) : null}
            <Btn variant="danger" onClick={async () => {
              if (!confirm("Delete this note?")) return;
              await fetch(`/api/notes?id=${draft.id}`, { method: "DELETE" });
              setSel(null);
              await load();
            }}>Delete</Btn>
            {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
          </div>
          {(() => { const st = analyzeNote(draft.body); return (
            <div className="fs-row" data-testid="note-stats" style={{ gap: 6, padding: "4px 8px", flexWrap: "wrap", borderTop: "1px solid var(--fs-border)" }}>
              <Badge>{st.words} words</Badge><Badge>{st.chars} chars</Badge><Badge>{st.sentences} sentences</Badge>
              <Badge tone="info">{st.readingMinutes} min read</Badge>
              {st.codeBlocks ? <Badge>{st.codeBlocks} code blocks (excluded from words)</Badge> : null}
              {st.headings.map((h) => <Badge key={h.line} title={`line ${h.line}`}>{"#".repeat(h.level)} {h.text}</Badge>)}
              {extractTags(draft.body).map((t) => <Badge key={t} tone="info">#{t}</Badge>)}
              {resolveLinks(rows, draft).map((l, i) => <Badge key={i} tone={l.noteId ? "ok" : "warn"}>[[{l.label}]]{l.noteId ? "" : " — no such note"}</Badge>)}
              {backlinks(rows, draft).map((b) => <Badge key={b.id}>← {b.title}</Badge>)}
            </div> ); })()}
          <textarea className="fs-textarea" value={draft.body} spellCheck={false}
            style={{ flex: 1, border: 0, borderRadius: 0, resize: "none", padding: 10 }}
            aria-label="Note body"
            onChange={(e) => { setEdit({ ...draft, body: e.target.value }); }} />
        </div>
      ) : <Empty title="Select a note" icon="🗒" />}
    </div>
  );
}
