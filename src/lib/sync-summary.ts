/** LD-01: local-disk sync summary. One line stating what the last sync
 *  did; a run with conflicts is never summarised as clean. */
export interface SyncResult { pushed: number; pulled: number; conflicts: number; at: string }
export function syncSummary(r: SyncResult | null): string {
  if (!r) return "not synced yet in this window";
  const when = new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (r.conflicts > 0) return `last sync ${when}: ${r.pushed} pushed, ${r.pulled} pulled, ${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"} need review`;
  if (r.pushed + r.pulled === 0) return `last sync ${when}: already up to date`;
  return `last sync ${when}: ${r.pushed} pushed, ${r.pulled} pulled, no conflicts`;
}
