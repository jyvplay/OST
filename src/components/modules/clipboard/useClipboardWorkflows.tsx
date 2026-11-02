"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { askText } from "@/lib/ask";
import { clipFilePath, clipboardSelection, CLIP_TEXT_LIMIT, transferableClip } from "@/lib/clipboard-workflows";
import { noteWrite } from "@/lib/note-model";
import WorkflowDialog from "../../WorkflowDialog";
import TextDifference from "../../TextDifference";
import { useShell, type ClipEntry } from "../../shell-context";
import { Btn } from "../../ui";

type Modal = { kind: "inspect" | "edit"; entry: ClipEntry } | { kind: "compare"; a: string; b: string };
function ClipText({ entry, edit, onCopy }: { entry: ClipEntry; edit: boolean; onCopy: (text: string) => Promise<void> }) {
  const [value, setValue] = useState(entry.text), [selected, setSelected] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [range, setRange] = useState({ start: "0", end: "0" });
  const area = useRef<HTMLTextAreaElement>(null), mounted = useRef(false), pending = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <div style={{ display: "grid", gap: 8 }}>
    <label htmlFor={`clip-text-${entry.at}`}>{edit ? "Edited clipboard copy" : "Full clipboard text"}</label>
    <textarea ref={area} id={`clip-text-${entry.at}`} aria-label={edit ? "Edited clipboard copy" : "Full clipboard text"} className="fs-textarea" readOnly={!edit} disabled={busy} maxLength={CLIP_TEXT_LIMIT} value={value} onChange={event => setValue(event.target.value)} onSelect={event => { setSelected(event.currentTarget.selectionEnd > event.currentTarget.selectionStart); setRange({ start: String(event.currentTarget.selectionStart), end: String(event.currentTarget.selectionEnd) }); }} style={{ minHeight: "35vh", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} />
    <small>{value.length} UTF-16 code units. Original history entry stays unchanged.{edit && /\r/.test(entry.text) ? " Editing uses native LF line endings; the untouched original retains its endings." : ""}</small>
    {!edit ? <div className="fs-row" style={{ flexWrap: "wrap", gap: 6 }} aria-label="Keyboard selection range">
      <label>Start<input className="fs-input" style={{ width: 90 }} aria-label="Clipboard selection start" inputMode="numeric" value={range.start} onChange={event => { const start = event.currentTarget.value; setRange(old => ({ ...old, start })); }} /></label>
      <label>End<input className="fs-input" style={{ width: 90 }} aria-label="Clipboard selection end" inputMode="numeric" value={range.end} onChange={event => { const end = event.currentTarget.value; setRange(old => ({ ...old, end })); }} /></label>
      <Btn disabled={busy} onClick={() => { try {
        if (!/^(0|[1-9]\d*)$/.test(range.start) || !/^(0|[1-9]\d*)$/.test(range.end)) throw new Error("Use nonnegative UTF-16 selection offsets");
        const start = Number(range.start), end = Number(range.end), selected = clipboardSelection(entry.text, start, end); transferableClip({ ...entry, text: selected });
        area.current?.focus(); area.current?.setSelectionRange(start, end); setSelected(end > start); setError("");
      } catch (failure) { setError((failure as Error).message); } }}>Select range</Btn><small>Displayed UTF-16 offsets. Copies keep original line endings.</small>
    </div> : null}
    <Btn disabled={busy || (!edit && !selected)} onClick={async () => {
      if (pending.current) return; pending.current = true; setBusy(true); setError("");
      try {
        const text = edit ? value : clipboardSelection(entry.text, area.current!.selectionStart, area.current!.selectionEnd);
        if (!edit && !text) return;
        transferableClip({ ...entry, text }); await onCopy(text);
      } catch (failure) { if (mounted.current) setError((failure as Error).message); }
      finally { pending.current = false; if (mounted.current) setBusy(false); }
    }}>{edit ? "Add edited copy" : "Copy selected text"}</Btn>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
export function useClipboardWorkflows(entries: ClipEntry[]) {
  const shell = useShell(), [selected, setSelected] = useState<number[]>([]), [modal, setModal] = useState<Modal | null>(null);
  const mounted = useRef(false), pending = useRef(false), epoch = useRef(0);
  useLayoutEffect(() => {
    mounted.current = true;
    const invalidate = () => { epoch.current++; };
    const clear = () => { invalidate(); setModal(null); setSelected([]); };
    window.addEventListener("fusion:privacy-locked", clear);
    return () => { mounted.current = false; invalidate(); window.removeEventListener("fusion:privacy-locked", clear); };
  }, []);
  const chosen = entries.filter(entry => selected.includes(entry.at) && !entry.sensitive);
  const run = async (operation: (current: () => boolean) => Promise<void> | void) => {
    if (!mounted.current || pending.current) return;
    const owned = epoch.current; pending.current = true;
    try { await operation(() => mounted.current && epoch.current === owned); }
    catch (failure) { if (mounted.current && epoch.current === owned) shell.toast((failure as Error).message, "warn"); }
    finally { pending.current = false; }
  };
  const row = (entry: ClipEntry) => <>
    <input type="checkbox" style={{ width: 24, height: 24, flexShrink: 0 }} aria-label={`Compare clipboard entry ${entry.at}`} checked={selected.includes(entry.at)} disabled={entry.sensitive || entry.text.length > CLIP_TEXT_LIMIT || (!selected.includes(entry.at) && chosen.length >= 2)} onChange={event => { const checked = event.currentTarget.checked; setSelected(old => checked ? [...old.filter(at => entries.some(item => item.at === at && !item.sensitive)), entry.at] : old.filter(at => at !== entry.at)); }} />
    <details><summary style={{ cursor: "pointer" }}>Tools</summary><div className="fs-row" style={{ flexWrap: "wrap", gap: 4 }}>
      <Btn disabled={entry.sensitive || entry.text.length > CLIP_TEXT_LIMIT} onClick={() => void run(() => { transferableClip(entry); setModal({ kind: "inspect", entry }); })}>Inspect</Btn>
      <Btn disabled={entry.sensitive || entry.text.length > CLIP_TEXT_LIMIT} onClick={() => void run(() => { transferableClip(entry); setModal({ kind: "edit", entry }); })}>Edit copy</Btn>
      <Btn disabled={entry.sensitive || entry.text.length > CLIP_TEXT_LIMIT} onClick={() => void run(async current => {
        const body = transferableClip(entry), title = await askText("Public note title", "Clipboard note", { title: "Save clipboard text as note", detail: "Creates a plaintext public note. Does not alter the history entry. Not queued offline.", okLabel: "Create note", validate: text => { try { noteWrite({ title: text, body }); return null; } catch (failure) { return (failure as Error).message; } } });
        if (!title || !current()) return;
        await api("/api/notes", { method: "POST", body: JSON.stringify({ title, body, tags: "clipboard", pinned: false }) }); if (current()) shell.toast("Clipboard text saved as a new public note", "ok");
      })}>Save as note…</Btn>
      <Btn disabled={entry.sensitive || entry.text.length > CLIP_TEXT_LIMIT} onClick={() => void run(async current => {
        const text = transferableClip(entry), path = await askText("New public file path", "/clipboard.txt", { title: "Save clipboard text as file", detail: "Creates a plaintext public file; an existing file is never overwritten. Private and amnesic storage are unsupported. Not queued offline.", okLabel: "Create file", validate: input => { try { clipFilePath(input); return null; } catch (failure) { return (failure as Error).message; } } });
        if (!path || !current()) return;
        await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "writeIfUnchanged", path: clipFilePath(path), content: text, mime: "text/plain", expected: null, reason: "clipboard-transfer" }) }); if (current()) shell.toast("Clipboard text saved as a new public file", "ok");
      })}>Save as file…</Btn>
    </div></details>
  </>;
  const toolbar = <Btn disabled={chosen.length !== 2} onClick={() => void run(() => { const a = transferableClip(chosen[0]), b = transferableClip(chosen[1]); setModal({ kind: "compare", a, b }); })}>Compare checked ({chosen.length}/2)</Btn>;
  const dialog = modal ? <WorkflowDialog title={modal.kind === "compare" ? "Clipboard text comparison" : modal.kind === "edit" ? "Edit a clipboard copy" : "Inspect clipboard text"} onClose={() => setModal(null)}>
    {modal.kind === "compare" ? <TextDifference original={modal.a} edited={modal.b} /> : <ClipText key={`${modal.kind}:${modal.entry.at}`} entry={modal.entry} edit={modal.kind === "edit"} onCopy={async text => { await shell.copy(text, modal.kind === "edit" ? "clipboard edited copy" : "clipboard selection"); }} />}
  </WorkflowDialog> : null;
  return { row, toolbar, dialog };
}
