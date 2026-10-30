/** TT118 TM-02 — "did you mean" for terminal commands and palette queries.
 * Optimal-string-alignment Damerau–Levenshtein distance (one transposition per
 * substring), implemented from scratch. Suggestions are ranked by (distance,
 * length difference, alphabetical) and only offered within a threshold that
 * scales with the input length — a 2-letter typo gets no suggestion rather
 * than a confident wrong one. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 32) return Math.abs(m - n); // beyond any useful threshold; skip the table
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
export function suggest(input: string, candidates: string[], limit = 3): string[] {
  const q = String(input).trim().toLowerCase();
  if (q.length < 3) return [];
  const maxDist = q.length <= 5 ? 1 : 2;
  return candidates
    .map((c) => ({ c, d: editDistance(q, c.toLowerCase()) }))
    .filter((x) => x.d > 0 && x.d <= maxDist)
    .sort((x, y) => x.d - y.d || Math.abs(x.c.length - q.length) - Math.abs(y.c.length - q.length) || x.c.localeCompare(y.c))
    .slice(0, limit)
    .map((x) => x.c);
}
