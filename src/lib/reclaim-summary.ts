/** ST-11: duplicate-storage summary. Sums the per-group reclaimable bytes
 *  Storage already computes; a group is only "reclaimable" when at least
 *  two copies exist (the definition the per-group badges use). */
export interface DupGroup { copies: number; reclaimable: number }
export function reclaimSummary(groups: DupGroup[]): { groups: number; copies: number; bytes: number } {
  const real = groups.filter((g) => g.copies >= 2);
  return { groups: real.length, copies: real.reduce((a, g) => a + g.copies, 0), bytes: real.reduce((a, g) => a + Math.max(0, g.reclaimable), 0) };
}
