"use client";
import { doneTasksText } from "@/lib/done-list";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtTime, patch, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";
import { parseRRule, expandRecurrence } from "@/lib/recurrence";
import { buildAgenda } from "@/lib/agenda";
import { agendaText } from "@/lib/agenda-text";
import { completionStats } from "@/lib/completion-stats";
import { localWeekDays } from "@/lib/local-week";
import { overdueText } from "@/lib/overdue-text";
import { filterTasks, type TaskStatus } from "@/lib/task-filter";
import { presetDue, presetLabel, type DuePreset } from "@/lib/due-presets";
import type { IcsImportWarning, IcsImportWarningCode } from "@/lib/ics";
import { TASK_NOTES_LIMIT, TASK_TITLE_LIMIT, taskInputInstant, taskLocalInput, taskSnapshot, type PlannerTask } from "@/lib/task-model";
import { askConfirm } from "@/lib/ask";
import { addDays } from "@/lib/clock-core";
import PlannerEditor from "./PlannerEditor";
import ActionGlyph from "../ActionGlyph";

const importWarningText: Record<IcsImportWarningCode, string> = {
  timezone: "TZID and embedded timezone definitions are ignored; the server's local time is used.",
  floating: "Floating times are interpreted in the server's local timezone.",
  allDay: "All-day dates become local-midnight instants and lose their all-day type.",
  invalidDate: "Invalid or unrepresentable dates may become undated.",
  recurrence: "Only the first item is saved; RRULE is stored as text, not scheduled.",
  exceptions: "Recurrence exceptions or additions are not preserved.",
  duration: "DURATION is ignored.",
  alarms: "Imported alarms are ignored.",
  missingUid: "Items without UIDs can be duplicated on reimport.",
};
interface ImportReview { ics: string; parsed: number; warnings: IcsImportWarning[]; serverTimeZone: string }

type Task = PlannerTask;

/** PR-03 tasks/reminders + PR-04 calendar via ICS import/export. */
export default function PlannerModule(_: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [kind, setKind] = useState<Task["kind"]>("task");
  const [end, setEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const pending = useRef(false), loading = useRef<AbortController | null>(null);
  const [editing, setEditing] = useState<{ item: Task; generation: number } | null>(null);
  const editorGeneration = useRef(0), editorTrigger = useRef<HTMLElement | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [view, setView] = useState<"list" | "week" | "agenda">("list");
  const [filterQ, setFilterQ] = useState("");
  const [filterStatus, setFilterStatus] = useState<TaskStatus>("all");
  const [repeat, setRepeat] = useState("");
  const [importReview, setImportReview] = useState<ImportReview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const repeatPreview = useMemo(() => {
    if (!repeat || !due) return null;
    try {
      const start = new Date(due);
      const occ = expandRecurrence(start, parseRRule(repeat), start, new Date(start.getTime() + 90 * 86400000));
      return occ.slice(0, 6).map((d) => d.toLocaleDateString([], { month: "short", day: "numeric" })).join(" · ") + (occ.length > 6 ? ` · … (${occ.length} in 90 days)` : "");
    } catch (e) { return `repeat error: ${String((e as Error).message)}`; }
  }, [repeat, due]);

  const shownRows = filterTasks(rows, filterQ, filterStatus);
  const load = useCallback(() => {
    loading.current?.abort();
    const controller = new AbortController(); loading.current = controller;
    return api<{ rows: Task[] }>("/api/tasks", { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return;
      setRows(r.rows); setLoadState("ready"); return r.rows;
    }).catch((e: Error) => {
      if (!controller.signal.aborted) { setError(`Could not load Planner: ${e.message}`); setLoadState("error"); }
    });
  }, []);
  useEffect(() => { void load(); return () => { loading.current?.abort(); }; }, [load, shell.refreshTick]);
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(t); }, []);
  const closeEditor = () => { setEditing(null); requestAnimationFrame(() => editorTrigger.current?.isConnected && editorTrigger.current.focus()); };
  const openEditor = async (item: Task, trigger: HTMLElement) => {
    if (editing && (await shell.askSave(_.win.id)) === "cancelled") return;
    editorTrigger.current = trigger; setEditing({ item, generation: ++editorGeneration.current });
  };
  const requestCloseEditor = async () => { if ((await shell.askSave(_.win.id)) !== "cancelled") closeEditor(); };
  const mutate = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  const addItem = () => mutate(async () => {
    const itemNotes = `${notes}${repeat ? `${notes ? "\n" : ""}RRULE:${repeat}` : ""}`;
    await post("/api/tasks", { title, notes: itemNotes, kind, dueAt: taskInputInstant(due), endAt: kind === "event" ? taskInputInstant(end) : null });
    setTitle(""); setDue(""); setEnd(""); setNotes(""); shell.bumpRefresh();
  });
  const toggleDone = (item: Task) => mutate(async () => {
    await patch("/api/tasks", { id: item.id, done: !item.done, expected: taskSnapshot(item) }); shell.bumpRefresh();
  });
  const removeItem = (item: Task) => mutate(async () => {
    if (!await askConfirm({ title: "Delete planner item?", detail: item.title, okLabel: "Delete item" })) return;
    await api(`/api/tasks?id=${item.id}`, { method: "DELETE", body: JSON.stringify({ expected: taskSnapshot(item) }) });
    if (editing?.item.id === item.id) closeEditor(); shell.bumpRefresh();
  });
  const importCalendar = async (ics: string) => {
    setImportBusy(true);
    try {
      const r = await post<{ parsed: number; added: number; skipped: number }>("/api/tasks", { ics });
      setImportReview(null);
      shell.toast(`ICS: ${r.parsed} parsed, ${r.added} added, ${r.skipped} already present`, "ok");
      await load(); shell.bumpRefresh();
    } catch (e) { shell.toast(`Calendar import failed: ${String((e as Error).message)}`, "bad"); }
    finally { setImportBusy(false); }
  };

  const days = localWeekDays(weekAnchor);

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <form aria-label="New planner item" onSubmit={(event) => { event.preventDefault(); void addItem(); }} style={{ display: "grid", gap: 6 }}>
        <fieldset disabled={busy} style={{ display: "grid", gap: 6, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <ActionGlyph name={kind === "task" ? "task" : "calendar"} />
            <input className="fs-input" style={{ flex: 1, minWidth: fz(140) }} placeholder={kind === "task" ? "New task" : "New event"} value={title} required maxLength={TASK_TITLE_LIMIT}
              onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
            <select className="fs-select" style={{ width: fz(96) }} value={kind} aria-label="Item type" onChange={(e) => setKind(e.target.value as Task["kind"])}><option value="task">Task</option><option value="event">Event</option></select>
            <input className="fs-input" type="datetime-local" step="0.001" style={{ width: fz(210) }} value={due} required={kind === "event"} onChange={(e) => setDue(e.target.value)} aria-label={kind === "task" ? "Due" : "Start"} />
            {kind === "event" ? <input className="fs-input" type="datetime-local" step="0.001" style={{ width: fz(210) }} value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Event end" /> : null}
            <Btn id={`${_.win.id}-planner-add`} type="submit" variant="primary" disabled={!title.trim() || (!!repeat && !due)}>Add</Btn>
          </div>
          <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
            {(["today", "tomorrow", "next-week"] as DuePreset[]).map((preset) => <Btn key={preset} variant="ghost" title={presetLabel(preset)} onClick={() => { const d = presetDue(preset); if (d) setDue(taskLocalInput(d.toISOString())); }}>{preset === "today" ? "Today" : preset === "tomorrow" ? "Tomorrow" : "+1 week"}</Btn>)}
            <select className="fs-select" style={{ width: fz(150) }} value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label="Repeat">
              <option value="">no repeat</option><option value="FREQ=DAILY">daily</option><option value="FREQ=WEEKLY">weekly</option><option value="FREQ=WEEKLY;BYDAY=MO,WE,FR">Mon/Wed/Fri</option><option value="FREQ=MONTHLY">monthly</option><option value="FREQ=YEARLY">yearly</option>
            </select>
          </div>
          <details><summary style={{ cursor: "pointer", fontSize: fz(11) }}>Notes</summary><textarea className="fs-input" aria-label="New item notes" rows={3} maxLength={TASK_NOTES_LIMIT} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: "100%", marginTop: 5, resize: "vertical" }} /></details>
        </fieldset>
      </form>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={() => setView(view === "list" ? "week" : view === "week" ? "agenda" : "list")}>{view === "list" ? "Week view" : view === "week" ? "Agenda" : "List view"}</Btn>
        <input className="fs-input" style={{ width: fz(140) }} placeholder="Filter tasks" aria-label="Filter tasks" value={filterQ} onChange={(e) => setFilterQ(e.target.value)} />
        <select className="fs-select" style={{ width: fz(110) }} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TaskStatus)} aria-label="Filter by status"><option value="all">all</option><option value="open">open</option><option value="done">done</option></select>
        {(() => { const overdue = rows.filter((t) => !t.done && t.dueAt && new Date(t.dueAt) < now).length; return overdue ? <><Badge tone="bad">{overdue} overdue</Badge><Btn variant="ghost" onClick={() => void shell.copy(overdueText(rows, new Date()), "planner")} data-testid="planner-copy-overdue">Copy overdue</Btn></> : null; })()}
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>
          Import .ics
          <input type="file" accept=".ics,text/calendar" hidden disabled={importBusy} onChange={async (e) => {
            const input = e.currentTarget, f = input.files?.[0];
            input.value = ""; // permit selecting the same file again after cancel/failure
            if (!f) return;
            setImportBusy(true); setImportReview(null);
            try {
              const ics = await f.text();
              const review = await post<Omit<ImportReview, "ics">>("/api/tasks", { ics, preview: true });
              if (review.warnings.length) setImportReview({ ...review, ics });
              else await importCalendar(ics);
            } catch (err) { shell.toast(`Calendar preview failed: ${String((err as Error).message)}`, "bad"); }
            finally { setImportBusy(false); }
          }} />
        </label>
        <Btn variant="ghost" onClick={() => window.open("/api/tasks?format=ics", "_blank")}>Export .ics</Btn>
      </div>

      {error ? <div role="alert" className="fs-panel" style={{ padding: 8 }}>{error} <Btn variant="ghost" onClick={() => { setError(""); void load(); }}>Retry loading</Btn></div> : null}
      {loadState === "loading" ? <div role="status">Loading Planner…</div> : null}
      {editing ? <PlannerEditor key={`${editing.item.id}-${editing.generation}`} winId={_.win.id} task={editing.item} onCancel={() => void requestCloseEditor()} onSaved={() => { closeEditor(); shell.bumpRefresh(); }} onReload={async () => {
        const r = await load();
        if (!r) throw new Error("Could not reload this item. Your draft is still open.");
        const item = r.find((row) => row.id === editing.item.id);
        if (!item) throw new Error("This item was deleted. Cancel to close the draft.");
        setEditing({ item, generation: ++editorGeneration.current });
      }} /> : null}

      {importReview ? <Section title="Review calendar import">
        <div role="status">{importReview.parsed} items found · server timezone: {importReview.serverTimeZone}. Nothing has been imported yet.</div>
        <ul style={{ margin: 0, paddingInlineStart: 20, listStyle: "disc" }}>
          {importReview.warnings.map(({ code, items }) => <li key={code}>{importWarningText[code]} ({items} {items === 1 ? "item" : "items"})</li>)}
        </ul>
        <div className="fs-row" style={{ gap: 6 }}>
          <Btn variant="ghost" disabled={importBusy} onClick={() => setImportReview(null)}>Cancel import</Btn>
          <Btn variant="primary" disabled={importBusy} onClick={() => void importCalendar(importReview.ics)}>Import anyway</Btn>
        </div>
      </Section> : null}
      {repeat && !due ? <div className="fs-dim" role="status">Choose a due date to add a repeating task.</div> : null}
      {repeatPreview ? <div className="fs-dim" data-testid="planner-repeat-preview" style={{ fontSize: fz(11) }}>Repeats: {repeatPreview}. Only the first task is saved. UTC export may shift local times; month-end rules may skip dates.</div> : null}
      {rows.length === 0 && loadState === "ready" ? <Empty title="Nothing planned" glyph="emptyPlan" /> : null}
      {rows.length > 0 && shownRows.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(12) }} role="status">No tasks match the filter.</div> : null}

      {view === "agenda" ? (
        <div className="fs-row" style={{ gap: 6 }}>
          <Btn variant="ghost" onClick={() => void shell.copy(agendaText(rows.map((t) => ({ title: t.title, due: t.dueAt, done: t.done })), new Date()), "planner")} data-testid="planner-copy-agenda">Copy today’s agenda</Btn>
          <Btn variant="ghost" onClick={() => void shell.copy(doneTasksText(rows), "planner")} data-testid="planner-copy-done">Copy done</Btn>
          {(() => { const cs = completionStats(rows, new Date()); return <Badge tone="ok" data-testid="planner-completion">done today {cs.today} · this week {cs.week}{cs.undated ? ` · ${cs.undated} undated` : ""}</Badge>; })()}
          <span className="fs-dim" style={{ fontSize: fz(11) }}>plain text, ready to paste anywhere</span>
        </div>
      ) : null}
      {view === "agenda" ? (
        <div style={{ display: "grid", gap: 8 }} data-testid="planner-agenda">
          {buildAgenda(shownRows).map((g) => (
            <div key={g.bucket}>
              <div style={{ fontSize: fz(11), fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>{g.bucket} · {g.tasks.length}</div>
              {g.tasks.map((t) => <div key={t.id} style={{ fontSize: fz(12), textDecoration: t.done ? "line-through" : "none" }}>{t.title}{t.dueAt ? <span className="fs-dim"> · {fmtTime(t.dueAt)}</span> : null}</div>)}
            </div>
          ))}
          {shownRows.length === 0 && rows.length > 0 ? null : buildAgenda(shownRows).length === 0 ? <div className="fs-dim">Nothing to show.</div> : null}
        </div>
      ) : view === "list" ? (
        <div style={{ display: "grid", gap: 2 }}>
          {shownRows.map((t) => {
            const overdue = t.dueAt && !t.done && new Date(t.dueAt).getTime() < now.getTime();
            return (
              <div key={t.id} className="fs-list-item" style={{ opacity: t.done ? .55 : 1 }}>
                {t.kind === "task"
                  ? <input type="checkbox" checked={t.done} aria-label={`Done: ${t.title}`}
                      disabled={busy} onChange={() => void toggleDone(t)} />
                  : <ActionGlyph name="calendar" size={16} />}
                <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", textDecoration: t.done ? "line-through" : "none", fontSize: fz(12) }}>{t.title}</span>
                {t.dueAt ? <Badge tone={overdue ? "bad" : "info"}>{fmtTime(t.dueAt)}</Badge> : null}
                {t.kind === "event" && t.endAt ? <Badge tone="info"><ActionGlyph name="arrow" size={12} /> {fmtTime(t.endAt)}</Badge> : null}
                <Btn variant="ghost" disabled={busy} aria-label={`Edit ${t.title}`} title={`Edit ${t.title}`} onClick={(e) => void openEditor(t, e.currentTarget as HTMLElement)}><ActionGlyph name="edit" size={16} /></Btn>
                <Btn variant="ghost" disabled={busy} aria-label={`Delete ${t.title}`} title={`Delete ${t.title}`} onClick={() => void removeItem(t)}><ActionGlyph name="remove" size={16} /></Btn>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
          <div className="fs-row" style={{ gap: 5, flexWrap: "wrap" }}>
            <Btn variant="ghost" aria-label="Previous week" onClick={() => setWeekAnchor((d) => addDays(d, -7))}>←</Btn>
            <Btn variant="ghost" onClick={() => setWeekAnchor(new Date())}>This week</Btn>
            <Btn variant="ghost" aria-label="Next week" onClick={() => setWeekAnchor((d) => addDays(d, 7))}>→</Btn>
            <span data-testid="planner-week-range" style={{ fontSize: fz(11) }}>{days[0].toLocaleDateString()}–{days[6].toLocaleDateString()}</span>
          </div>
          <div role="region" aria-label="Week calendar" tabIndex={0} style={{ overflowX: "auto" }}>
          <div data-testid="planner-week" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(110px, 1fr))", gap: 4 }}>
          {days.map((d) => {
            const items = shownRows.filter((t) => t.dueAt && new Date(t.dueAt).toDateString() === d.toDateString());
            return (
              <div key={d.toISOString()} data-testid="planner-day" className="fs-panel" style={{ padding: 6, minHeight: 120 }}>
                <div style={{ fontSize: fz(11), fontWeight: 600, color: d.toDateString() === new Date().toDateString() ? "var(--fs-accent)" : undefined }}>
                  {d.toLocaleDateString([], { weekday: "short", day: "numeric" })}
                </div>
                {items.map((t) => (
                  <button key={t.id} className="fs-btn" data-variant="ghost" style={{ width: "100%", justifyContent: "start", overflowWrap: "anywhere", whiteSpace: "normal", fontSize: fz(10.5), marginTop: 3, textDecoration: t.done ? "line-through" : "none" }} aria-label={`Edit ${t.title}`} onClick={(e) => void openEditor(t, e.currentTarget)}>
                    {new Date(t.dueAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {t.title}
                  </button>
                ))}
              </div>
            );
          })}
          </div></div>
        </div>
      )}

      <div className="fs-dim" style={{ fontSize: fz(11.5) }}>Keep Fusion open for reminders.</div>
      <details className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
        <summary style={{ cursor: "pointer" }}>Limits & timezones</summary>
        Reminders need the shell running; closing Planner is safe. Events use .ics, not a system calendar provider.
        Imported TZID/floating dates use the server’s timezone. Edited times use this browser’s timezone;
        repeated hours follow the browser’s first occurrence unless the input is unchanged. Edits ask before closing; no crash-recovery draft is stored.
      </details>
    </div>
  );
}
