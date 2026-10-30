/** PL-07: Planner completion counts. "Today" and "this week" count tasks
 *  completed (done flag) whose due date falls in the window; undated
 *  done tasks are reported separately instead of being silently assigned
 *  to today. Week starts Monday, the agenda's convention. */
export interface CompletionTask { done: boolean; dueAt: string | null }
export function completionStats(tasks: CompletionTask[], now: Date): { today: number; week: number; undated: number } {
  const done = tasks.filter((t) => t.done);
  const day = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const todayStart = day(now);
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  const weekStart = todayStart - dow * 86400000;
  let today = 0, week = 0, undated = 0;
  for (const t of done) {
    if (!t.dueAt) { undated++; continue; }
    const at = day(new Date(t.dueAt));
    if (at === todayStart) today++;
    if (at >= weekStart && at <= todayStart) week++;
  }
  return { today, week, undated };
}
