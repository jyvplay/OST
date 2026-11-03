"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { askConfirm, askForm, askText } from "@/lib/ask";
import { NOTE_LIMITS, type NoteFields, type NoteRecord } from "@/lib/note-model";
import { insertNoteLink, markdownTable, noteTemplate, replaceNoteText, splitNote, templateFilename } from "@/lib/note-workflows";
import WorkflowDialog from "../../WorkflowDialog";
import TextDifference from "../../TextDifference";
import { Btn } from "../../ui";

export default function NoteTools({ value, base, selection, disabled, preview, change, select, createBatch }: {
  value: NoteFields; base: NoteRecord; selection: { start: number; end: number }; disabled: boolean; preview: boolean;
  change: (patch: Partial<NoteFields>) => void; select: (start: number, end: number) => void; createBatch: (fields: NoteFields[]) => Promise<void>;
}) {
  const [find, setFind] = useState(""), [replacement, setReplacement] = useState(""), [status, setStatus] = useState(""), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [difference, setDifference] = useState<{ original: string; edited: string; revision: number; opener: HTMLElement | null } | null>(null);
  const live = useRef(false), pending = useRef(false), request = useRef<AbortController | null>(null), epoch = useRef(0);
  useLayoutEffect(() => {
    live.current = true;
    const invalidate = () => { epoch.current++; request.current?.abort(); };
    const clear = () => { invalidate(); setDifference(null); setFind(""); setReplacement(""); setStatus(""); setError(""); };
    window.addEventListener("fusion:privacy-locked", clear);
    return () => { live.current = false; invalidate(); window.removeEventListener("fusion:privacy-locked", clear); };
  }, []);
  const run = async (operation: (current: () => boolean) => Promise<void> | void) => {
    if (!live.current || pending.current || disabled) return;
    const owned = epoch.current; pending.current = true; setBusy(true); setError(""); setStatus("");
    try { await operation(() => live.current && owned === epoch.current); }
    catch (failure) { if (live.current && owned === epoch.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const blocked = disabled || busy;
  return <details data-testid="note-tools" style={{ width: "100%" }}><summary style={{ cursor: "pointer" }}>Text tools</summary><div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
    <div role="group" aria-label="Find and replace note text" className="fs-row" style={{ flexWrap: "wrap", gap: 5 }}>
      <input className="fs-input" aria-label="Find in note" maxLength={512} value={find} onChange={e => setFind(e.target.value)} placeholder="Literal, case-sensitive" />
      <input className="fs-input" aria-label="Replace in note" maxLength={16_384} value={replacement} onChange={e => setReplacement(e.target.value)} placeholder="Replacement" />
      <Btn disabled={blocked || preview} onClick={() => void run(() => {
        if (!find) throw new Error("Enter text to find");
        let at = value.body.indexOf(find, selection.end); const wrapped = at < 0; if (wrapped) at = value.body.indexOf(find);
        if (at < 0) { setStatus("No matches"); return; } select(at, at + find.length); setStatus(`Match at character ${at + 1}${wrapped ? " (wrapped)" : ""}`);
      })}>Find next</Btn>
      <Btn disabled={blocked} onClick={() => void run(() => { const result = replaceNoteText(value.body, find, replacement); change({ body: result.body }); setStatus(`${result.count} replacements in this draft`); })}>Replace all</Btn>
    </div>
    <div className="fs-row" style={{ flexWrap: "wrap", gap: 5 }}>
      <Btn disabled={blocked} onClick={() => void run(async current => {
        const fields = await askForm({ title: "Insert Markdown link", detail: "Plain label; only http, https or mailto. Replaces the selected range in this draft.", fields: [{ name: "label", label: "Link label", def: value.body.slice(selection.start, selection.end) }, { name: "url", label: "Link URL", def: "https://" }], okLabel: "Insert link", validate: form => { try { insertNoteLink(value.body, selection.start, selection.end, form.label, form.url); return null; } catch (e) { return (e as Error).message; } } });
        if (fields && current()) change({ body: insertNoteLink(value.body, selection.start, selection.end, fields.label, fields.url) });
      })}>Insert link…</Btn>
      <Btn disabled={blocked} onClick={() => void run(async current => {
        const fields = await askForm({ title: "Insert pipe table", detail: "2–16 columns; 1–100 data rows. Preview supports escaped pipes, inline text and column alignment.", fields: [{ name: "columns", label: "Columns", def: "2" }, { name: "rows", label: "Data rows", def: "2" }], okLabel: "Insert table", validate: form => { try { markdownTable(Number(form.columns), Number(form.rows)); return null; } catch (e) { return (e as Error).message; } } });
        if (!fields || !current()) return;
        const table = markdownTable(Number(fields.columns), Number(fields.rows));
        const body = value.body.slice(0, selection.start) + `\n${table}\n` + value.body.slice(selection.end);
        if (body.length > NOTE_LIMITS.body) throw new Error("Table would exceed the note body limit"); change({ body });
      })}>Insert table…</Btn>
      <Btn disabled={blocked} onClick={() => void run(async current => {
        const fields = splitNote(value);
        if (await askConfirm({ title: `Create ${fields.length} section notes?`, detail: "Copies this draft at top-level # headings. The source is not saved or changed. All section bodies together preserve the exact source.", okLabel: "Create sections" }) && current()) { await createBatch(fields); if (current()) setStatus(`${fields.length} section notes created; source unchanged`); }
      })}>Split at headings…</Btn>
      <Btn disabled={blocked} onClick={() => void run(async current => {
        const name = await askText("Template name", "", { title: "Save note template", okLabel: "Save template", validate: text => { try { templateFilename(text); return null; } catch (e) { return (e as Error).message; } } });
        if (!name || !current()) return;
        const template = noteTemplate({ kind: "fusion.note-template.v1", fields: value });
        await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "mkdir", path: "/System/NoteTemplates" }) });
        if (!current()) return;
        await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "writeIfUnchanged", path: `/System/NoteTemplates/${templateFilename(name)}`, content: JSON.stringify(template), mime: "application/json", expected: null, reason: "note-template" }) });
        if (current()) setStatus("Template saved. Open Library → Templates to use it. {{date}}, {{time}}, {{title}} are plain local text tokens.");
      })}>Save template…</Btn>
      <Btn disabled={blocked} onClick={() => void run(async current => {
        const opener = document.activeElement as HTMLElement | null;
        request.current?.abort(); const controller = new AbortController(); request.current = controller;
        const result = await api<{ row: NoteRecord }>(`/api/notes?id=${base.id}`, { signal: controller.signal });
        if (current() && !controller.signal.aborted) setDifference({ original: result.row.body, edited: value.body, revision: result.row.revision, opener });
      })}>Compare saved body</Btn>
    </div>
    {status ? <div role="status">{status}</div> : null}{error ? <div role="alert">{error}</div> : null}
  </div>
  {difference ? <WorkflowDialog title={`Saved revision ${difference.revision} vs current draft`} onClose={() => setDifference(null)} returnFocus={difference.opener}><TextDifference original={difference.original} edited={difference.edited} /><p>No save, reload or revision acceptance occurs here.</p></WorkflowDialog> : null}
  </details>;
}
