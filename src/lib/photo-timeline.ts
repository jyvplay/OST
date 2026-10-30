/** TT118 PH-02 — photo library timeline: group by capture month.
 * Input is the same item shape the Photos module already loads (path, mime,
 * size, capture date string). Months are local (a photo taken on 1 Jan in
 * Tokyo is a January photo to its owner, whatever UTC says). Undated photos
 * form their own group at the end, counted, never dropped. */
export interface PhotoItem { path: string; mime: string; size: number; date: string | null }
export interface MonthGroup { month: string; count: number; bytes: number; first: string; last: string }
export function photoTimeline(items: PhotoItem[]): { groups: MonthGroup[]; undated: { count: number; bytes: number }; totalBytes: number; spanMonths: number } {
  const byMonth = new Map<string, PhotoItem[]>();
  let undated = { count: 0, bytes: 0 };
  for (const it of items) {
    const d = it.date ? new Date(it.date) : null;
    if (!d || isNaN(+d)) { undated = { count: undated.count + 1, bytes: undated.bytes + it.size }; continue; }
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    byMonth.set(key, [...(byMonth.get(key) ?? []), it]);
  }
  const groups = [...byMonth.entries()].map(([month, list]) => {
    const dates = list.map((i) => i.date!).sort();
    return { month, count: list.length, bytes: list.reduce((s, i) => s + i.size, 0), first: dates[0], last: dates[dates.length - 1] };
  }).sort((a, b) => b.month.localeCompare(a.month));
  return { groups, undated, totalBytes: items.reduce((s, i) => s + i.size, 0), spanMonths: groups.length };
}
export function largestMonth(items: PhotoItem[]): MonthGroup | null {
  const { groups } = photoTimeline(items);
  return groups.reduce<MonthGroup | null>((best, g) => (!best || g.bytes > best.bytes ? g : best), null);
}
