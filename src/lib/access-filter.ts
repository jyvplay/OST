/** AL-01: access-log filtering. Matches app, action and result text;
 *  the live/historical split stays a separate axis (an existing flag),
 *  so this filter never resurrects entries the live view excluded. */
export interface AccessLike { app: string; action: string; result?: string }
export function filterAccess<T extends AccessLike>(rows: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => `${r.app} ${r.action} ${r.result ?? ""}`.toLowerCase().includes(needle));
}
