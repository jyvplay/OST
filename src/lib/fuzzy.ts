/**
 * SR-03 typo tolerance. Restricted Damerau-Levenshtein (optimal string
 * alignment): insertions, deletions, substitutions and ADJACENT transpositions
 * each cost 1 — "noets" → "notes" is distance 1, not 2 as plain Levenshtein says.
 *
 * Bound scales with length so short words don't match everything:
 *   len ≤ 3 → 0 (exact only)   len 4–6 → 1   len ≥ 7 → 2
 * Early exit: if a whole DP row exceeds the bound, stop (O(n·m) worst case,
 * but typical rejection is after 2–3 rows).
 */
export function osaDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

export const typoBudget = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Score a query against a title. Every query token must match some title token
 * (exactly, by prefix, or within the typo budget). Returns null if not a match;
 * lower score = better (sum of distances, prefix = 0.25).
 */
export function fuzzyScore(query: string, title: string): number | null {
  const q = tokens(query);
  const t = tokens(title);
  if (!q.length || !t.length) return null;
  let total = 0;
  for (const qt of q) {
    let best = Infinity;
    for (const tt of t) {
      if (tt === qt) { best = 0; break; }
      if (tt.startsWith(qt) && qt.length >= 2) { best = Math.min(best, 0.25); continue; }
      const budget = typoBudget(qt.length);
      if (budget === 0) continue;
      // compare against the same-length prefix too, so "calcu" ~ "calculator" isn't required to be whole-word
      const d = Math.min(osaDistance(qt, tt, budget), osaDistance(qt, tt.slice(0, qt.length), budget) + 0.5);
      if (d <= budget) best = Math.min(best, d);
    }
    if (best === Infinity) return null;
    total += best;
  }
  return total;
}
