/**
 * PL-04 — Planner task filter. Query matches title and notes (case-folded),
 * status narrows to open/done/all, and the result preserves the caller's
 * order — filtering must never re-sort a list the user arranged.
 */
export interface FilterableTask { id: string | number; title: string; notes?: string | null; done: boolean }
export type TaskStatus = "all" | "open" | "done";

export function filterTasks<T extends FilterableTask>(tasks: T[], query: string, status: TaskStatus = "all"): T[] {
  const q = query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (status === "open" && t.done) return false;
    if (status === "done" && !t.done) return false;
    if (!q) return true;
    return t.title.toLowerCase().includes(q) || (t.notes ?? "").toLowerCase().includes(q);
  });
}
