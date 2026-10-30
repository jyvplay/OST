/** TT118 PH-02 — photo library timeline. The date is interpreted in the
 * viewer's local time; undated photos are counted rather than dropped. */
export interface PhotoItem { path: string; mime: string; size: number; date: string | null }
export interface MonthGroup { month: string; count: number; bytes: number; first: string; last: string }
export function photoTimeline(items: PhotoItem[]): { groups: MonthGroup[]; undated: { count: number; bytes: number }; totalBytes: number; spanMonths: number } {
  // Aggregate in one pass: copying the entire month's array on each insertion
  // made a single-month library quadratic in both work and allocations.
  const byMonth = new Map<string, MonthGroup>();
  const undated = { count: 0, bytes: 0 };
  let totalBytes = 0;
  for (const item of items) {
    totalBytes += item.size;
    const d = item.date ? new Date(item.date) : null;
    if (!d || !Number.isFinite(+d)) { undated.count++; undated.bytes += item.size; continue; }
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const group = byMonth.get(month);
    if (group) {
      group.count++; group.bytes += item.size;
      if (item.date! < group.first) group.first = item.date!;
      if (item.date! > group.last) group.last = item.date!;
    } else byMonth.set(month, { month, count: 1, bytes: item.size, first: item.date!, last: item.date! });
  }
  const groups = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  return { groups, undated, totalBytes, spanMonths: groups.length };
}
export function largestMonth(items: PhotoItem[]): MonthGroup | null {
  const { groups } = photoTimeline(items);
  return groups.reduce<MonthGroup | null>((best, group) => (!best || group.bytes > best.bytes ? group : best), null);
}
