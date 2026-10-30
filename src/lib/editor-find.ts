/**
 * ED-03 — Editor find & replace. Pure string mechanics: matches are literal
 * (never regex, so a query like `a.b` finds only `a.b`), non-overlapping,
 * counted before anything is replaced. An empty query is refused rather than
 * matching at every position, which is how find bars freeze editors.
 */
export interface FindMatch { index: number; line: number; column: number }

export function findMatches(text: string, query: string, caseSensitive = false): FindMatch[] {
  if (!query) throw new Error("Type something to find first");
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: FindMatch[] = [];
  let from = 0;
  for (;;) {
    const index = hay.indexOf(needle, from);
    if (index < 0) break;
    const before = text.slice(0, index);
    out.push({ index, line: before.split("\n").length, column: index - before.lastIndexOf("\n") });
    from = index + Math.max(1, needle.length);
    if (out.length >= 10_000) break; // counted and reported, never silently truncated in the UI
  }
  return out;
}

export function replaceAll(text: string, query: string, replacement: string, caseSensitive = false): { text: string; count: number } {
  const matches = findMatches(text, query, caseSensitive);
  if (!matches.length) return { text, count: 0 };
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.index) + replacement;
    cursor = m.index + query.length;
  }
  return { text: out + text.slice(cursor), count: matches.length };
}

/** Replace only the nth match (1-based, as shown in the find bar). */
export function replaceOne(text: string, query: string, replacement: string, n: number, caseSensitive = false): { text: string; count: number } {
  const matches = findMatches(text, query, caseSensitive);
  const m = matches[n - 1];
  if (!m) return { text, count: 0 };
  return { text: text.slice(0, m.index) + replacement + text.slice(m.index + query.length), count: matches.length };
}
