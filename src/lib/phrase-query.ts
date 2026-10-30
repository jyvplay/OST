/** SR-12: exact-phrase search construction. In phrase mode the query
 *  is wrapped so the index treats it as one phrase; embedded quotes are
 *  doubled rather than stripped, so the user's text is never silently
 *  rewritten into a different search. */
export function buildQuery(raw: string, phrase: boolean): string {
  const q = raw.trim();
  if (!q || !phrase) return q;
  return `"${q.replace(/"/g, '""')}"`;
}
