/** TT118 WD-01/02 — meeting overlap across time zones, and countdowns.
 * Overlap: for one UTC day, each zone's local work window (default 09:00–17:00)
 * is projected onto UTC minutes; the answer is the intersection. Using real
 * Intl zone offsets per instant (not fixed offsets) is what makes DST weeks
 * come out right. Countdowns are whole local days to a named date. */
export interface ZoneWindow { zone: string; startHour: number; endHour: number }
function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}
/** Minutes of overlap of all zones' work windows on the UTC day containing `day`. Empty = no common hour. */
export function commonWindows(windows: ZoneWindow[], day = new Date()): { startUtc: string; endUtc: string; minutes: number }[] {
  if (!windows.length) throw new Error("at least one zone is required");
  const dayStartUtc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  // Work in 30-minute cells across two UTC days (a local day can start the day before in UTC).
  const cells: boolean[] = new Array(96).fill(true);
  for (const w of windows) {
    if (w.startHour < 0 || w.endHour > 24 || w.startHour >= w.endHour) throw new Error(`invalid work window for ${w.zone}`);
    const inWindow = new Array(96).fill(false);
    for (let c = 0; c < 96; c++) {
      const at = new Date(dayStartUtc - 86_400_000 + c * 1_800_000);
      const localMin = (at.getUTCHours() * 60 + at.getUTCMinutes() + offsetMinutes(w.zone, at) + 1440) % 1440;
      if (localMin >= w.startHour * 60 && localMin < w.endHour * 60) inWindow[c] = true;
    }
    for (let c = 0; c < 96; c++) cells[c] = cells[c] && inWindow[c];
  }
  const runs: { startUtc: string; endUtc: string; minutes: number }[] = [];
  let start: number | null = null;
  for (let c = 0; c <= 96; c++) {
    if (c < 96 && cells[c] && start === null) start = c;
    if ((c === 96 || !cells[c]) && start !== null) {
      const s = new Date(dayStartUtc - 86_400_000 + start * 1_800_000);
      const e = new Date(dayStartUtc - 86_400_000 + c * 1_800_000);
      // Only report the part inside the requested UTC day.
      const cs = new Date(Math.max(+s, dayStartUtc)), ce = new Date(Math.min(+e, dayStartUtc + 86_400_000));
      if (ce > cs) runs.push({ startUtc: cs.toISOString(), endUtc: ce.toISOString(), minutes: Math.round((+ce - +cs) / 60000) });
      start = null;
    }
  }
  return runs;
}
export interface Countdown { id: string; label: string; date: string }
export function validateCountdowns(list: unknown): Countdown[] {
  if (!Array.isArray(list) || list.length > 50) throw new Error("countdowns must be an array of at most 50");
  return list.map((raw) => {
    const c = raw as Countdown;
    if (!c || typeof c.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(c.id)) throw new Error("countdown id is invalid");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date) || isNaN(Date.parse(c.date + "T00:00:00"))) throw new Error(`countdown date "${String(c.date)}" must be YYYY-MM-DD`);
    return { id: c.id, label: String(c.label ?? "").slice(0, 80), date: c.date };
  });
}
export function daysUntil(c: Countdown, now = new Date()): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const [y, m, d] = c.date.split("-").map(Number);
  return Math.round((new Date(y, m - 1, d).getTime() - a) / 86_400_000);
}
