/** PL-08: the overdue list as text. Open tasks only (done tasks are
 *  history, not overdue), oldest first so the longest-waiting reads at
 *  the top; ages are whole local days. */
export interface OverdueTask { title: string; dueAt: string | null; done: boolean }
export function overdueText(tasks: OverdueTask[], now: Date): string {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const over = tasks.filter((t) => !t.done && t.dueAt && new Date(t.dueAt).getTime() < start.getTime())
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  if (!over.length) return "(nothing overdue)";
  return over.map((t) => {
    const dueDay = new Date(String(t.dueAt)); dueDay.setHours(0, 0, 0, 0);
    const days = Math.max(1, Math.round((start.getTime() - dueDay.getTime()) / 86400000));
    return `• ${t.title} — ${days} day${days === 1 ? "" : "s"} overdue`;
  }).join("\n");
}
