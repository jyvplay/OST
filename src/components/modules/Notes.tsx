"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, fmtTime, post, put } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";

interface Note { id: number; title: string; body: string; tags: string; pinned: boolean; updatedAt: string }

/** PR-02: notes land in the same index as files, so one search covers both. */
export default function NotesModule({ win }: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Note[]>([]);
  const [sel, setSel] = useState<number | null>((win.props.noteId as number) ?? null);
  const [draft, setDraft] = useState<Note | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    const r = await api<{ rows: Note[] }>("/api/notes");
    setRows(r.rows);
    if (sel === null && r.rows[0]) setSel(r.rows[0].id);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { setDraft(rows.find((r) => r.id === sel) ?? null); setDirty(false); }, [sel, rows]);

  const save = async () => {
    if (!draft) return;
    await put("/api/notes", { id: draft.id, title: draft.title, body: draft.body, tags: draft.tags });
    setDirty(false);
    shell.toast("Note saved and re-indexed", "ok");
    await load();
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: `min(${fz(200)}, 38%) minmax(0, 1fr)`, height: "100%", minHeight: 0 }}>
      <div style={{ borderRight: "1px solid var(--fs-border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="fs-row" style={{ padding: 6, gap: 4 }}>
          <Btn variant="primary" onClick={async () => {
            const r = await post<{ row: Note }>("/api/notes", { title: "Untitled", body: "" });
            await load();
            setSel(r.row.id);
          }}>New</Btn>
          <Btn variant="ghost" onClick={() => void load()}>↻</Btn>
        </div>
        <div className="fs-scroll" style={{ flex: 1, minHeight: 0, padding: 4 }}>
          {rows.map((n) => (
            <button key={n.id} className="fs-list-item" data-selected={n.id === sel}
              style={{ width: "100%", textAlign: "left", border: 0, background: n.id === sel ? "rgba(91,140,255,.22)" : "none", color: "inherit" }}
              onClick={() => setSel(n.id)}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: fz(12) }}>{n.pinned ? "📌 " : ""}{n.title}</div>
                <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{fmtTime(n.updatedAt)}</div>
              </span>
            </button>
          ))}
          {rows.length === 0 ? <Empty title="No notes" icon="🗒" /> : null}
        </div>
      </div>

      {draft ? (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* TT22: wraps on narrow windows — at phone width the two inputs had shrunk to slivers */}
          <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
            <input className="fs-input" style={{ flex: `1 1 ${fz(140)}`, minWidth: fz(110) }} value={draft.title} aria-label="Note title"
              onChange={(e) => { setDraft({ ...draft, title: e.target.value }); setDirty(true); }} />
            <input className="fs-input" style={{ flex: `0 1 ${fz(150)}`, minWidth: fz(90) }} placeholder="tags" value={draft.tags} aria-label="Tags"
              onChange={(e) => { setDraft({ ...draft, tags: e.target.value }); setDirty(true); }} />
            <Btn variant="primary" disabled={!dirty} onClick={() => void save()}>Save</Btn>
            <Btn variant="ghost" onClick={() => void put("/api/notes", { id: draft.id, pinned: !draft.pinned }).then(load)}>
              {draft.pinned ? "Unpin" : "Pin"}
            </Btn>
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
          <textarea className="fs-textarea" value={draft.body} spellCheck={false}
            style={{ flex: 1, border: 0, borderRadius: 0, resize: "none", padding: 10 }}
            aria-label="Note body"
            onChange={(e) => { setDraft({ ...draft, body: e.target.value }); setDirty(true); }} />
        </div>
      ) : <Empty title="Select a note" icon="🗒" />}
    </div>
  );
}
