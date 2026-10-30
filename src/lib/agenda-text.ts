/** PL-06: the day's agenda as plain text — for pasting into a note, an
 *  e-mail or a terminal. Times are local wall-clock (the planner's own
 *  convention); done tasks are marked, never silently dropped. */
export interface AgendaTaskLike { title: string; due: string | null; done: boolean; priority?: string }
export function agendaText(tasks: AgendaTaskLike[], day: Date): string {
  const sameDay = (iso: string) => { const d = new Date(iso); return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate(); };
  const todays = tasks.filter((t) => t.due && sameDay(t.due)).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const head = `Agenda — ${day.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
  if (!todays.length) return `${head}\n(no tasks due)`;
  const lines = todays.map((t) => {
    const time = new Date(String(t.due)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${t.done ? "✓" : "•"} ${time} — ${t.title}${t.priority === "high" ? " (!)" : ""}`;
  });
  return [head, ...lines].join("\n");
}
