/** RT-02: routine search. Matches name and action text; a query never
 *  reorders, so the list keeps the author's running order. */
export interface RoutineLike { name: string; actions?: string }
export function filterRoutines<T extends RoutineLike>(routines: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return routines;
  return routines.filter((r) => `${r.name} ${r.actions ?? ""}`.toLowerCase().includes(needle));
}
