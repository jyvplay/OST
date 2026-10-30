/** ED-07: find-match navigation. Wrapping is explicit and stated (the
 *  caller learns when the search wrapped), and a stale current offset
 *  that no longer matches any hit resumes from the nearest position. */
export interface MatchNav { index: number; wrapped: boolean }
export function nextMatch(offsets: number[], current: number, dir: 1 | -1): MatchNav | null {
  if (!offsets.length) return null;
  if (dir > 0) {
    const i = offsets.findIndex((o) => o > current);
    return i >= 0 ? { index: i, wrapped: false } : { index: 0, wrapped: true };
  }
  for (let i = offsets.length - 1; i >= 0; i--) if (offsets[i] < current) return { index: i, wrapped: false };
  return { index: offsets.length - 1, wrapped: true };
}
