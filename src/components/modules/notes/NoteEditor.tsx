"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, put } from "@/lib/api";
import { fz } from "@/lib/uiscale";
import { registerDocGuard } from "@/lib/doc-lifecycle";
import { privacy } from "@/lib/privacy/session";
import { NOTE_LIMITS, excerptNote, noteFields, sameNote, type NoteFields, type NoteRecord } from "@/lib/note-model";
import { noteDraftKey, readNoteDraft, removeNoteDraft, writeNoteDraft, type NoteDraft } from "@/lib/note-drafts";
import { extractTags, resolveLinks, backlinks } from "@/lib/note-links";
import { analyzeNote } from "@/lib/notes-stats";
import { NOTE_PREVIEW_LINES, noteMarkdown, toggleNoteTask } from "@/lib/note-markdown";
import { askConfirm, askText } from "@/lib/ask";
import { displayedTextRange, sourceTextRange } from "@/lib/text-selection";
import { noteFilename, noteToMarkdown } from "@/lib/note-export";
import { useShell } from "../../shell-context";
import { Badge, Btn } from "../../ui";
import MarkdownView from "./MarkdownView";
import NoteTools from "./NoteTools";

export default function NoteEditor({ note, rows, winId, onCommitted, onOpen, onExtract, onDelete, onExportAll, onCreateBatch }: {
  note: NoteRecord; rows: NoteRecord[]; winId: string; onCommitted: (note: NoteRecord) => void;
  onOpen: (id: number) => Promise<void>; onExtract: (title: string, text: string) => Promise<void>;
  onDelete: (id: number, revision: number) => Promise<void>; onExportAll: () => Promise<void>; onCreateBatch: (fields: NoteFields[]) => Promise<void>;
}) {
  const shell = useShell();
  const [base, setBase] = useState(note), [value, setValue] = useState<NoteFields>(() => noteFields(note));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState(false), [outline, setOutline] = useState(false), [jump, setJump] = useState<number | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const body = useRef<HTMLTextAreaElement>(null), root = useRef<HTMLDivElement>(null), pending = useRef(false), live = useRef(false);
  const selectionText = useRef(value.body);
  useLayoutEffect(() => { selectionText.current = value.body; }, [value.body]);
  const key = noteDraftKey(winId, note.id);
  const storage = () => privacy.status().amnesic ? null : window.sessionStorage;
  const [recovery, setRecovery] = useState<NoteDraft | null>(() => { try { return readNoteDraft(storage(), key, note.id); } catch { return null; } });
  const [draftError, setDraftError] = useState("");
  const draftTimer = useRef<number | null>(null);
  const dirty = !sameNote(base, value);
  const stats = useMemo(() => analyzeNote(value.body), [value.body]);
  const viewNote = { ...base, ...value };
  const tags = useMemo(() => extractTags(value.body), [value.body]);
  // Outline and preview share one bounded parse and therefore the same line IDs.
  const parsed = useMemo(() => preview || outline ? noteMarkdown(value.body) : { blocks: [], truncated: false }, [preview, outline, value.body]);
  const headings = parsed.blocks.filter(block => block.kind === "heading");
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const removeDraft = () => { try { removeNoteDraft(storage(), key); setDraftError(""); } catch { setDraftError("Could not remove this tab's recovery draft."); } };
  const persistDraft = async () => {
    if (!dirty && !recovery) return;
    const draft = recovery ?? { v: 1 as const, base, value, savedAt: Date.now() };
    try {
      const target = storage();
      writeNoteDraft(target, key, draft);
      const kept = readNoteDraft(target, key, note.id);
      if (!kept || kept.base.revision !== draft.base.revision || !sameNote(kept.base, draft.base) || !sameNote(kept.value, draft.value)) throw new Error("Recovery draft could not be read back");
      setDraftError("");
    } catch (error) {
      setDraftError("Draft recovery unavailable. Keep this window open until saved.");
      throw error;
    }
  };
  const submit = async (): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await put<{ row: NoteRecord }>("/api/notes", { id: base.id, expectedRevision: base.revision, ...value });
      if (live.current) {
        if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
        setBase(result.row); setValue(noteFields(result.row)); removeDraft(); setRecovery(null); onCommitted(result.row);
        committed.current.dirty = false; committed.current.persistDraft = async () => undefined;
      }
      return true;
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const committed = useRef({ dirty, submit, persistDraft, title: value.title });
  useLayoutEffect(() => { committed.current = { dirty, submit, persistDraft, title: value.title }; });
  useEffect(() => registerDocGuard({
    winId, kind: "notes", title: () => committed.current.title,
    dirty: () => committed.current.dirty, save: () => committed.current.submit(),
    flushDraft: () => committed.current.persistDraft(), recoverable: () => true,
    recoveryDetail: () => "Draft recovery is limited to this tab and this window ID. Switching back can offer it; reopening a closed window cannot. Save or Download first if you need to keep the edits. If writing the draft fails, this editor stays open.",
  }), [winId]);
  useEffect(() => {
    if (!dirty || recovery) return;
    draftTimer.current = window.setTimeout(() => { draftTimer.current = null; void committed.current.persistDraft().catch(() => undefined); }, 300);
    return () => { if (draftTimer.current !== null) window.clearTimeout(draftTimer.current); };
  }, [dirty, value, base, recovery]);
  useEffect(() => {
    const flush = () => { void committed.current.persistDraft().catch(() => undefined); };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);
  useEffect(() => {
    if (jump === null || !preview) return;
    const frame = requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>(`[data-note-line="${jump}"]`)?.scrollIntoView({ block: "start" });
      setJump(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [jump, preview]);
  const change = (patch: Partial<NoteFields>) => { setValue(v => ({ ...v, ...patch })); setError(""); };
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { if (live.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const pin = () => run(async () => {
    const result = await put<{ row: NoteRecord }>("/api/notes", { id: base.id, expectedRevision: base.revision, pinned: !value.pinned });
    setBase(result.row); setValue(v => ({ ...v, pinned: result.row.pinned })); onCommitted(result.row);
  });
  const reload = async () => {
    if (!await askConfirm({ title: "Reload note?", detail: "Discard the current draft and read the latest saved note.", okLabel: "Reload note" })) return;
    await run(async () => { const result = await api<{ row: NoteRecord }>(`/api/notes?id=${base.id}`); if (draftTimer.current !== null) window.clearTimeout(draftTimer.current); setBase(result.row); setValue(noteFields(result.row)); removeDraft(); setRecovery(null); onCommitted(result.row); committed.current.dirty = false; committed.current.persistDraft = async () => undefined; });
  };
  const extract = async () => {
    let text: string;
    try { text = excerptNote(value.body, selection.start, selection.end); } catch (e) { setError((e as Error).message); return; }
    const title = await askText("New note title", text.replace(/\s+/g, " ").trim().slice(0, 80), { okLabel: "Create note" });
    if (title?.trim()) await onExtract(title.trim(), text);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([noteToMarkdown(value)], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = noteFilename(value.title); a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const links = resolveLinks(rows, viewNote), back = backlinks(rows, viewNote);
  return <div ref={root} data-testid="note-editor" style={{ display: "flex", flexDirection: "column", minHeight: 0 }} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy && !recovery) void submit(); }
  }}>
    <div className="fs-row" style={{ padding: 6, gap: 5, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
      <input className="fs-input" style={{ flex: `1 1 ${fz(140)}`, minWidth: fz(110) }} value={value.title} aria-label="Note title" maxLength={NOTE_LIMITS.title} disabled={busy || !!recovery} onChange={e => change({ title: e.target.value })} />
      <input className="fs-input" style={{ flex: `0 1 ${fz(130)}`, minWidth: fz(90) }} value={value.tags} placeholder="tags" aria-label="Tags" maxLength={NOTE_LIMITS.tags} disabled={busy || !!recovery} onChange={e => change({ tags: e.target.value })} />
      <Btn variant="primary" disabled={!dirty || busy || !!recovery || !value.title.trim()} onClick={() => void submit()}>Save</Btn>
      <Btn variant="ghost" aria-pressed={preview} disabled={busy || !!recovery} onClick={() => setPreview(!preview)}>{preview ? "Edit" : "Preview"}</Btn>
      <Btn variant="ghost" disabled={busy || !!recovery} onClick={() => void pin()}>{value.pinned ? "Unpin" : "Pin"}</Btn>
      <Btn variant="ghost" aria-pressed={outline} onClick={() => setOutline(!outline)}>Outline</Btn>
      <details><summary style={{ cursor: "pointer", fontSize: fz(12) }}>More</summary><div className="fs-row" style={{ flexWrap: "wrap", padding: 5, gap: 4 }}>
        <Btn variant="ghost" disabled={!dirty || busy || !!recovery} onClick={() => void reload()}>Discard edits</Btn>
        <Btn variant="ghost" disabled={busy || !!recovery} onClick={() => void run(async () => {
          const filename = noteFilename(value.title);
          await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "write", path: `/${filename}`, content: noteToMarkdown(value), mime: "text/markdown", reason: "notes-export" }) }); shell.toast(`Exported to /${filename}`, "ok");
        })}>Export .md</Btn>
        <Btn variant="ghost" disabled={busy || !!recovery} onClick={() => void run(onExportAll)} data-testid="notes-bundle">Export all</Btn>
        <Btn variant="ghost" onClick={download}>Download .md</Btn>
        <Btn variant="ghost" disabled={busy || !!recovery || preview || selection.end <= selection.start} onMouseDown={(e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault()} onClick={() => void extract().catch(e => setError(String(e.message)))}>Extract selection</Btn>
        <Btn variant="ghost" onClick={() => {
          const text = value.body.length > 1800 ? `${value.body.slice(0, 1800)}\n\n[truncated by Fusion — full note is in Notes]` : value.body;
          window.location.href = `mailto:?subject=${encodeURIComponent(value.title)}&body=${encodeURIComponent(text)}`;
        }}>Email</Btn>
        {typeof navigator !== "undefined" && "share" in navigator ? <Btn variant="ghost" onClick={() => void navigator.share({ title: value.title, text: value.body }).catch(() => undefined)}>Share</Btn> : null}
        <Btn variant="danger" disabled={busy || !!recovery} onClick={async () => {
          if (!await askConfirm({ title: "Delete note?", detail: dirty ? "This also discards the current draft. This is not Files Trash." : "This is not Files Trash.", okLabel: "Delete note" })) return;
          await run(async () => { await onDelete(base.id, base.revision); removeDraft(); });
        }}>Delete</Btn>
        <NoteTools value={value} base={base} selection={selection} disabled={busy || !!recovery} preview={preview} change={change} createBatch={onCreateBatch} select={(start, end) => { if (!body.current) return; const displayed = displayedTextRange(value.body, start, end); body.current.focus(); body.current.setSelectionRange(displayed.start, displayed.end); setSelection({ start, end }); }} />
      </div></details>
      <Badge tone={dirty ? "warn" : "ok"}>{dirty ? "unsaved" : "saved"}</Badge>
    </div>
    {error ? <div role="alert" style={{ padding: 8 }}>{error} <Btn variant="ghost" disabled={busy || !!recovery} onClick={() => void reload()}>Reload note</Btn></div> : null}
    {draftError ? <div role="status" style={{ padding: 8 }}>{draftError}</div> : null}
    {recovery ? <div role="status" data-testid="note-recovery" style={{ padding: 8 }}>
      Recover a draft from this tab?{recovery.base.revision !== note.revision ? " The saved note has changed; saving this draft will require a reload or a new note." : ""}
      <Btn variant="ghost" onClick={() => { setBase(recovery.base); setValue(recovery.value); setRecovery(null); }}>Restore draft</Btn>
      <Btn variant="ghost" onClick={() => { removeDraft(); setRecovery(null); }}>Discard draft</Btn>
    </div> : null}
    <div className="fs-row" data-testid="note-stats" style={{ gap: 6, padding: "4px 8px", flexWrap: "wrap", fontSize: fz(11) }}>
      <span>{stats.words} words · {stats.chars} chars · {stats.sentences} sentences · {stats.readingMinutes} min read</span>
      {stats.codeBlocks ? <span>{stats.codeBlocks} code blocks (excluded from words)</span> : null}
      <span className="fs-dim">Draft: this tab</span>
    </div>
    {outline ? <nav aria-label="Note outline" className="fs-row" style={{ gap: 4, padding: "2px 8px", flexWrap: "wrap", maxHeight: fz(100), overflow: "auto" }}>
      {headings.length ? headings.map(h => <Btn key={h.line} variant="ghost" title={`Line ${h.line + 1}`} onClick={() => { setPreview(true); setJump(h.line); }}>{h.text}</Btn>) : <span>No headings</span>}
      {parsed.truncated ? <span role="status">Outline: first {NOTE_PREVIEW_LINES} lines. Editing and export keep the full note.</span> : null}
    </nav> : null}
    {(tags.length || links.length || back.length) ? <div className="fs-row" aria-label="Note links" style={{ gap: 4, padding: "2px 8px", flexWrap: "wrap", maxHeight: fz(100), overflow: "auto" }}>
      {tags.map(t => <Badge key={t}>#{t}</Badge>)}
      {links.map((link, i) => {
        const candidates = rows.filter(n => n.title.trim().toLowerCase() === link.target.toLowerCase());
        return <Btn key={i} variant="ghost" disabled={busy || !!recovery || candidates.length !== 1} title={candidates.length > 1 ? "Ambiguous title; choose the note from the list" : candidates.length ? "Open linked note" : "No such note"} onClick={() => void onOpen(candidates[0].id)}>[[{link.label}]]{candidates.length ? "" : " — no such note"}</Btn>;
      })}
      {back.map(link => <Btn key={`back-${link.id}`} variant="ghost" disabled={busy || !!recovery} aria-label={`Backlink: ${link.title}`} onClick={() => void onOpen(link.id)}>← {link.title}</Btn>)}
    </div> : null}
    {preview ? <MarkdownView parsed={parsed} disabled={busy || !!recovery} onTask={line => { try { change({ body: toggleNoteTask(value.body, line) }); } catch (e) { setError((e as Error).message); } }} /> : <textarea ref={body} className="fs-textarea" value={value.body} spellCheck={false} maxLength={NOTE_LIMITS.body} disabled={busy || !!recovery} style={{ flex: 1, minHeight: fz(90), border: 0, borderRadius: 0, resize: "none", padding: 10 }} aria-label="Note body" onChange={e => { selectionText.current = e.target.value; change({ body: e.target.value }); setSelection({ start: e.target.selectionStart, end: e.target.selectionEnd }); }} onSelect={e => setSelection(sourceTextRange(selectionText.current, e.currentTarget.selectionStart, e.currentTarget.selectionEnd))} />}
  </div>;
}
