/** TT125 DV-03: render navigator.storage.estimate() honestly — the browser
 *  may refuse either number, and a refusal is shown, never guessed. */
export function estimateText(usage: number | null | undefined, quota: number | null | undefined): string {
  const fmt = (n: number) => {
    if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
    if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
    if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} kB`;
    return `${n} B`;
  };
  if (usage == null && quota == null) return "the browser shares no storage estimate here";
  if (usage == null) return `quota ${fmt(quota!)} · usage not shared`;
  if (quota == null) return `using ${fmt(usage)} · quota not shared`;
  const pct = quota > 0 ? Math.min(100, Math.round((usage / quota) * 100)) : 0;
  return `using ${fmt(usage)} of ${fmt(quota)} (${pct}%)`;
}
