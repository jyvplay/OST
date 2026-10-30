/** TT118 PL-03 — agenda: tasks grouped the way a person scans a day.
 * Buckets are overdue / today / tomorrow / this week (days 2–7) / later / done /
 * undated, in that display order, each sorted by due time then title. Bucket
 * boundaries are whole local days: a task due at 23:59 today is "today" all
 * day, never "overdue" at 09:00 — overdue starts tomorrow. */
export interface AgendaTask { id: number; title: string; done: boolean; dueAt: string | null; kind: string }
export type BucketName = "overdue" | "today" | "tomorrow" | "this week" | "later" | "undated" | "done";
export const BUCKET_ORDER: BucketName[] = ["overdue", "today", "tomorrow", "this week", "later", "undated", "done"];
function dayStart(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
export function buildAgenda(tasks: AgendaTask[], now = new Date()): { bucket: BucketName; tasks: AgendaTask[] }[] {
  const today = dayStart(now);
  const groups = new Map<BucketName, AgendaTask[]>(BUCKET_ORDER.map((b) => [b, []]));
  for (const t of tasks) {
    if (t.done) { groups.get("done")!.push(t); continue; }
    if (!t.dueAt || isNaN(Date.parse(t.dueAt))) { groups.get("undated")!.push(t); continue; }
    const due = dayStart(new Date(t.dueAt));
    const days = Math.round((due - today) / 86_400_000);
    const bucket: BucketName = days < 0 ? "overdue" : days === 0 ? "today" : days === 1 ? "tomorrow" : days <= 7 ? "this week" : "later";
    groups.get(bucket)!.push(t);
  }
  for (const list of groups.values()) list.sort((a, b) => String(a.dueAt ?? "9999").localeCompare(String(b.dueAt ?? "9999")) || a.title.localeCompare(b.title));
  return BUCKET_ORDER.map((bucket) => ({ bucket, tasks: groups.get(bucket)! })).filter((g) => g.tasks.length > 0);
}
