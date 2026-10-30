/** NC-07: alert list facets. Pure filtering over the rows the API already
 *  returned; unread counting is derived, never stored separately, so the
 *  badge and the list can never disagree. */
export interface AlertLike { read: boolean; title: string; body: string; app: string }
export const unreadCount = <T extends AlertLike>(rows: T[]): number => rows.filter((r) => !r.read).length;
export function filterAlerts<T extends AlertLike>(rows: T[], opts: { unreadOnly?: boolean; q?: string }): T[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  return rows.filter((r) => (!opts.unreadOnly || !r.read) && (!q || `${r.title} ${r.body} ${r.app}`.toLowerCase().includes(q)));
}
