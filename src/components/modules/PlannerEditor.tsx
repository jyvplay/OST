"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { patch } from "@/lib/api";
import { TASK_NOTES_LIMIT, TASK_TITLE_LIMIT, taskInputInstant, taskLocalInput, taskSnapshot, type PlannerTask } from "@/lib/task-model";
import { Btn, Section } from "../ui";
import { fz } from "@/lib/uiscale";
import { registerDocGuard } from "@/lib/doc-lifecycle";

/** A keyed editor owns a fixed baseline and a draft. Background refreshes do
 * not overwrite a user's typing; the server compares the complete baseline
 * under a PostgreSQL row lock before committing the draft. */
export default function PlannerEditor({ winId, task, onSaved, onCancel, onReload }: {
  winId: string; task: PlannerTask; onSaved: () => void; onCancel: () => void; onReload: () => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title), [notes, setNotes] = useState(task.notes);
  const [kind, setKind] = useState(task.kind), [done, setDone] = useState(task.done);
  const [due, setDue] = useState(() => taskLocalInput(task.dueAt)), [end, setEnd] = useState(() => taskLocalInput(task.endAt));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saved = useRef(false);
  const pending = useRef(false), input = useRef<HTMLInputElement>(null), live = useRef(false);
  useEffect(() => { live.current = true; input.current?.focus(); return () => { live.current = false; }; }, []);
  const submit = async (): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    try {
      await patch("/api/tasks", {
        id: task.id, expected: taskSnapshot(task), title, notes, kind, done: kind === "task" ? done : false,
        dueAt: taskInputInstant(due, task.dueAt), endAt: kind === "event" ? taskInputInstant(end, task.endAt) : null,
      });
      saved.current = true;
      if (live.current) onSaved();
      return true;
    } catch (e) { if (live.current) setError((e as Error).message); return false; }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const dirty = title !== task.title || notes !== task.notes || kind !== task.kind || done !== task.done || due !== taskLocalInput(task.dueAt) || (kind === "event" && end !== taskLocalInput(task.endAt));
  const committed = useRef({ dirty, title, submit });
  useLayoutEffect(() => { committed.current = { dirty, title, submit }; });
  useEffect(() => registerDocGuard({
    winId, kind: "planner", title: () => committed.current.title,
    dirty: () => committed.current.dirty && !saved.current,
    save: () => committed.current.submit(), flushDraft: async () => undefined, recoverable: () => false,
  }), [winId]);
  return <Section title={kind === "event" ? "Edit event" : "Edit task"}>
    <form aria-label="Edit planner item" onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ display: "grid", gap: 8 }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8, minWidth: 0 }}>
        <input ref={input} className="fs-input" aria-label="Edit title" required maxLength={TASK_TITLE_LIMIT} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <select className="fs-select" style={{ width: fz(96) }} aria-label="Edit item type" value={kind} onChange={(e) => setKind(e.target.value as PlannerTask["kind"])}><option value="task">Task</option><option value="event">Event</option></select>
          <label style={{ display: "grid", gap: 3, fontSize: fz(11) }}>{kind === "task" ? "Due" : "Start"}<input className="fs-input" type="datetime-local" step="0.001" aria-label="Edit due or start" required={kind === "event"} value={due} onChange={(e) => setDue(e.target.value)} /></label>
          {kind === "event" ? <label style={{ display: "grid", gap: 3, fontSize: fz(11) }}>End<input className="fs-input" type="datetime-local" step="0.001" aria-label="Edit event end" value={end} onChange={(e) => setEnd(e.target.value)} /></label> : <>
            <Btn variant="ghost" disabled={!due} onClick={() => setDue("")}>Clear due</Btn>
            <label className="fs-row" style={{ gap: 5 }}><input type="checkbox" aria-label="Edit completed" checked={done} onChange={(e) => setDone(e.target.checked)} />Done</label>
          </>}
        </div>
        <textarea className="fs-input" aria-label="Edit notes" maxLength={TASK_NOTES_LIMIT} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: "vertical", minHeight: fz(80) }} />
        <div className="fs-row" style={{ gap: 6 }}><Btn type="submit" variant="primary" disabled={!title.trim()}>Save changes</Btn><Btn variant="ghost" onClick={onCancel}>Cancel edit</Btn></div>
      </fieldset>
      {error ? <div role="alert" style={{ display: "grid", gap: 5 }}><span>{error}</span><Btn variant="ghost" disabled={busy} onClick={async () => {
        if (pending.current) return; pending.current = true; setBusy(true);
        try { await onReload(); } catch (e) { if (live.current) setError((e as Error).message); }
        finally { pending.current = false; if (live.current) setBusy(false); }
      }}>Reload item (discard draft)</Btn></div> : null}
    </form>
  </Section>;
}
