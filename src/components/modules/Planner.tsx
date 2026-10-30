"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useMemo, useState } from "react";
import { api, fmtTime, patch, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";
import { parseRRule, expandRecurrence } from "@/lib/recurrence";
import { buildAgenda } from "@/lib/agenda";
import { filterTasks, type TaskStatus } from "@/lib/task-filter";
import { presetDue, presetLabel, type DuePreset } from "@/lib/due-presets";

interface Task { id: number; title: string; notes: string; done: boolean; dueAt: string | null; kind: string; endAt: string | null }

/** PR-03 tasks/reminders + PR-04 calendar via ICS import/export. */
export default function PlannerModule(_: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [view, setView] = useState<"list" | "week" | "agenda">("list");
  const [filterQ, setFilterQ] = useState("");
  const [filterStatus, setFilterStatus] = useState<TaskStatus>("all");
  const [repeat, setRepeat] = useState("");
  const repeatPreview = useMemo(() => {
    if (!repeat || !due) return null;
    try {
      const start = new Date(due);
      const occ = expandRecurrence(start, parseRRule(repeat), start, new Date(start.getTime() + 90 * 86400000));
      return occ.slice(0, 6).map((d) => d.toLocaleDateString([], { month: "short", day: "numeric" })).join(" · ") + (occ.length > 6 ? ` · … (${occ.length} in 90 days)` : "");
    } catch (e) { return `repeat error: ${String((e as Error).message)}`; }
  }, [repeat, due]);

  const shownRows = filterTasks(rows, filterQ, filterStatus);
  const load = () => api<{ rows: Task[] }>("/api/tasks").then((r) => setRows(r.rows)).catch(() => undefined);
  useEffect(() => { void load(); }, [shell.refreshTick]);

  const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000));

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ flex: 1, minWidth: fz(160) }} placeholder="New task" value={title}
          onChange={(e) => setTitle(e.target.value)} aria-label="Task title"
          onKeyDown={(e) => { if (e.key === "Enter") (document.getElementById("planner-add") as HTMLButtonElement)?.click(); }} />
        <input className="fs-input" type="datetime-local" style={{ width: fz(200) }} value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
        {(["today", "tomorrow", "next-week"] as DuePreset[]).map((preset) => (
          <Btn key={preset} variant="ghost" title={presetLabel(preset)} onClick={() => { const d = presetDue(preset); if (d) { const p = (n: number) => String(n).padStart(2, "0"); setDue(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`); } }}>{preset === "today" ? "Today" : preset === "tomorrow" ? "Tomorrow" : "+1 week"}</Btn>
        ))}
        {(() => { const overdue = rows.filter((t) => !t.done && t.dueAt && new Date(t.dueAt) < new Date()).length; return overdue ? <Badge tone="bad">{overdue} overdue</Badge> : null; })()}
        <Btn id="planner-add" variant="primary" disabled={!title} onClick={async () => {
          await post("/api/tasks", { title, dueAt: due ? new Date(due).toISOString() : null, ...(repeat ? { notes: `RRULE:${repeat}` } : {}) });
          setTitle(""); setDue(""); await load();
        }}>Add</Btn>
        <Btn variant="ghost" onClick={() => setView(view === "list" ? "week" : view === "week" ? "agenda" : "list")}>{view === "list" ? "Week view" : view === "week" ? "Agenda" : "List view"}</Btn>
        <input className="fs-input" style={{ width: fz(140) }} placeholder="Filter tasks" aria-label="Filter tasks" value={filterQ} onChange={(e) => setFilterQ(e.target.value)} />
        <select className="fs-select" style={{ width: fz(110) }} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TaskStatus)} aria-label="Filter by status">
          <option value="all">all</option><option value="open">open</option><option value="done">done</option>
        </select>
        <select className="fs-select" style={{ width: fz(150) }} value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label="Repeat">
          <option value="">no repeat</option>
          <option value="FREQ=DAILY">daily</option>
          <option value="FREQ=WEEKLY">weekly</option>
          <option value="FREQ=WEEKLY;BYDAY=MO,WE,FR">Mon/Wed/Fri</option>
          <option value="FREQ=MONTHLY">monthly</option>
          <option value="FREQ=YEARLY">yearly</option>
        </select>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>
          Import .ics
          <input type="file" accept=".ics,text/calendar" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const r = await post<{ parsed: number; added: number; skipped: number }>("/api/tasks", { ics: await f.text() });
            shell.toast(`ICS: ${r.parsed} items parsed, ${r.added} added, ${r.skipped} already present (dedup by UID)`, "ok");
            await load();
          }} />
        </label>
        <Btn variant="ghost" onClick={() => window.open("/api/tasks?format=ics", "_blank")}>Export .ics</Btn>
      </div>

      {repeatPreview ? <div className="fs-dim" data-testid="planner-repeat-preview" style={{ fontSize: fz(11) }}>Repeats: {repeatPreview}. The first occurrence is saved as the task; the rule is kept in its notes as RRULE so export stays honest.</div> : null}
      {rows.length === 0 ? <Empty title="Nothing planned" icon="🗓" /> : null}
      {rows.length > 0 && shownRows.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(12) }} role="status">No tasks match the filter.</div> : null}

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
            const overdue = t.dueAt && !t.done && new Date(t.dueAt).getTime() < Date.now();
            return (
              <div key={t.id} className="fs-list-item" style={{ opacity: t.done ? .55 : 1 }}>
                {t.kind === "task"
                  ? <input type="checkbox" checked={t.done} aria-label={`Done: ${t.title}`}
                      onChange={async () => { await patch("/api/tasks", { id: t.id, done: !t.done }); await load(); }} />
                  : <span>📅</span>}
                <span style={{ flex: 1, textDecoration: t.done ? "line-through" : "none", fontSize: fz(12) }}>{t.title}</span>
                {t.dueAt ? <Badge tone={overdue ? "bad" : "info"}>{fmtTime(t.dueAt)}</Badge> : null}
                <Btn variant="ghost" onClick={async () => { await fetch(`/api/tasks?id=${t.id}`, { method: "DELETE" }); await load(); }}>✕</Btn>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {days.map((d) => {
            const items = shownRows.filter((t) => t.dueAt && new Date(t.dueAt).toDateString() === d.toDateString());
            return (
              <div key={d.toISOString()} className="fs-panel" style={{ padding: 6, minHeight: 120 }}>
                <div style={{ fontSize: fz(11), fontWeight: 600, color: d.toDateString() === new Date().toDateString() ? "var(--fs-accent)" : undefined }}>
                  {d.toLocaleDateString([], { weekday: "short", day: "numeric" })}
                </div>
                {items.map((t) => (
                  <div key={t.id} style={{ fontSize: fz(10.5), marginTop: 3, textDecoration: t.done ? "line-through" : "none" }}>
                    {new Date(t.dueAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {t.title}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <Section title="Boundaries">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          Reminders fire from the shell while it is open (the reminder loop runs in the shell, not this window, so
          closing Planner does not stop them). There is no web API for the system calendar provider, so calendars move
          in and out as .ics files; TZID times are read as local time — no timezone database is bundled.
        </div>
      </Section>
    </div>
  );
}
