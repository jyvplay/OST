"use client";

import { useEffect, useState } from "react";
import { api, fmtTime, patch, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";

interface Task { id: number; title: string; notes: string; done: boolean; dueAt: string | null; kind: string; endAt: string | null }

/** PR-03 tasks/reminders + PR-04 calendar via ICS import/export. */
export default function PlannerModule(_: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [view, setView] = useState<"list" | "week">("list");

  const load = () => api<{ rows: Task[] }>("/api/tasks").then((r) => setRows(r.rows)).catch(() => undefined);
  useEffect(() => { void load(); }, [shell.refreshTick]);

  const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * 86_400_000));

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ flex: 1, minWidth: 160 }} placeholder="New task" value={title}
          onChange={(e) => setTitle(e.target.value)} aria-label="Task title"
          onKeyDown={(e) => { if (e.key === "Enter") (document.getElementById("planner-add") as HTMLButtonElement)?.click(); }} />
        <input className="fs-input" type="datetime-local" style={{ width: 200 }} value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
        <Btn id="planner-add" variant="primary" disabled={!title} onClick={async () => {
          await post("/api/tasks", { title, dueAt: due ? new Date(due).toISOString() : null });
          setTitle(""); setDue(""); await load();
        }}>Add</Btn>
        <Btn variant="ghost" onClick={() => setView(view === "list" ? "week" : "list")}>{view === "list" ? "Week view" : "List view"}</Btn>
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

      {rows.length === 0 ? <Empty title="Nothing planned" icon="🗓" /> : null}

      {view === "list" ? (
        <div style={{ display: "grid", gap: 2 }}>
          {rows.map((t) => {
            const overdue = t.dueAt && !t.done && new Date(t.dueAt).getTime() < Date.now();
            return (
              <div key={t.id} className="fs-list-item" style={{ opacity: t.done ? .55 : 1 }}>
                {t.kind === "task"
                  ? <input type="checkbox" checked={t.done} aria-label={`Done: ${t.title}`}
                      onChange={async () => { await patch("/api/tasks", { id: t.id, done: !t.done }); await load(); }} />
                  : <span>📅</span>}
                <span style={{ flex: 1, textDecoration: t.done ? "line-through" : "none", fontSize: 12 }}>{t.title}</span>
                {t.dueAt ? <Badge tone={overdue ? "bad" : "info"}>{fmtTime(t.dueAt)}</Badge> : null}
                <Btn variant="ghost" onClick={async () => { await fetch(`/api/tasks?id=${t.id}`, { method: "DELETE" }); await load(); }}>✕</Btn>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {days.map((d) => {
            const items = rows.filter((t) => t.dueAt && new Date(t.dueAt).toDateString() === d.toDateString());
            return (
              <div key={d.toISOString()} className="fs-panel" style={{ padding: 6, minHeight: 120 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: d.toDateString() === new Date().toDateString() ? "var(--fs-accent)" : undefined }}>
                  {d.toLocaleDateString([], { weekday: "short", day: "numeric" })}
                </div>
                {items.map((t) => (
                  <div key={t.id} style={{ fontSize: 10.5, marginTop: 3, textDecoration: t.done ? "line-through" : "none" }}>
                    {new Date(t.dueAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {t.title}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <Section title="Boundaries">
        <div className="fs-dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          Reminders fire from the shell while it is open (the reminder loop runs in the shell, not this window, so
          closing Planner does not stop them). There is no web API for the system calendar provider, so calendars move
          in and out as .ics files; TZID times are read as local time — no timezone database is bundled.
        </div>
      </Section>
    </div>
  );
}
