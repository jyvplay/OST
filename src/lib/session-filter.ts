/** TT125 BM-03: narrow a session list by a query over everything a person
 *  can see about a session — transport, target and state. */
export interface SessionLike { transport: string; state: string; }
export function filterSessions<T extends SessionLike>(list: ReadonlyArray<T>, q: string, extra?: (s: T) => string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...list];
  return list.filter((s) => `${s.transport} ${s.state} ${extra ? extra(s) : ""}`.toLowerCase().includes(needle));
}
