/** TT117 CK-01/02/03 — alarms, lap analysis and date arithmetic.
 * Pure functions over local wall-clock time. `nextFire` searches at most 8 days
 * forward, which is exact for daily/weekly schedules: if no weekday matches in a
 * full week the alarm can never fire, and that is reported as null rather than
 * looping forever. Times are "HH:MM" 24-hour strings, validated strictly. */
export interface Alarm { id: string; label: string; time: string; days: number[]; enabled: boolean; snoozeMin: number }
export const ALARM_LIMIT = 24;

export function validTime(t: unknown): t is string {
  return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}
export function validateAlarm(a: unknown): Alarm {
  const x = a as Alarm;
  if (!x || typeof x !== "object") throw new Error("alarm must be an object");
  if (typeof x.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(x.id)) throw new Error("alarm id is invalid");
  if (!validTime(x.time)) throw new Error(`alarm time "${String(x.time)}" must be HH:MM (24-hour)`);
  if (!Array.isArray(x.days) || x.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("alarm days must be weekday numbers 0–6");
  if (typeof x.enabled !== "boolean") throw new Error("alarm enabled must be boolean");
  const snoozeMin = x.snoozeMin === undefined ? 9 : x.snoozeMin;
  if (!Number.isInteger(snoozeMin) || snoozeMin < 1 || snoozeMin > 60) throw new Error("snooze must be 1–60 minutes");
  return { id: x.id, label: String(x.label ?? "").slice(0, 80), time: x.time, days: [...new Set(x.days)].sort(), enabled: x.enabled, snoozeMin };
}
export function validateAlarms(list: unknown): Alarm[] {
  if (!Array.isArray(list)) throw new Error("alarms must be an array");
  if (list.length > ALARM_LIMIT) throw new Error(`at most ${ALARM_LIMIT} alarms`);
  const out = list.map(validateAlarm);
  if (new Set(out.map((a) => a.id)).size !== out.length) throw new Error("alarm ids must be unique");
  return out;
}
/** Next local instant the alarm fires strictly after `from`, or null if it never can. */
export function nextFire(a: Alarm, from: Date): Date | null {
  if (!a.enabled) return null;
  const [h, m] = a.time.split(":").map(Number);
  const days = a.days.length ? a.days : [0, 1, 2, 3, 4, 5, 6]; // no days picked = every day
  for (let add = 0; add <= 7; add++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + add, h, m, 0, 0);
    if (d.getTime() > from.getTime() && days.includes(d.getDay())) return d;
  }
  return null;
}
export function upcomingAlarms(alarms: Alarm[], from: Date): { alarm: Alarm; at: Date }[] {
  return alarms.map((alarm) => ({ alarm, at: nextFire(alarm, from) }))
    .filter((x): x is { alarm: Alarm; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}
export function snooze(a: Alarm, from: Date): Date { return new Date(from.getTime() + a.snoozeMin * 60_000); }

/** CK-02: laps are cumulative stopwatch readings (ms). Splits are the per-lap deltas. */
export interface LapStat { index: number; totalMs: number; splitMs: number }
export function lapStats(lapsMs: number[]): { laps: LapStat[]; fastest: LapStat | null; slowest: LapStat | null; averageSplitMs: number } {
  const laps = lapsMs.map((totalMs, i) => {
    if (!Number.isFinite(totalMs) || totalMs < 0 || (i > 0 && totalMs < lapsMs[i - 1])) throw new Error("laps must be non-decreasing millisecond readings");
    return { index: i + 1, totalMs, splitMs: totalMs - (i ? lapsMs[i - 1] : 0) };
  });
  if (!laps.length) return { laps, fastest: null, slowest: null, averageSplitMs: 0 };
  const fastest = laps.reduce((a, b) => (b.splitMs < a.splitMs ? b : a));
  const slowest = laps.reduce((a, b) => (b.splitMs > a.splitMs ? b : a));
  return { laps, fastest, slowest, averageSplitMs: laps[laps.length - 1].totalMs / laps.length };
}

/** CK-03: calendar arithmetic on whole local days (time-of-day is discarded).
 * Convert the local date components to a UTC ordinal, not the instant at local
 * midnight: the latter can be 23, 25 or even zero hours from the next day. */
const dayMs = 86_400_000;
function dayOrdinal(d: Date): number {
  const result = new Date(0);
  result.setUTCFullYear(d.getFullYear(), d.getMonth(), d.getDate());
  result.setUTCHours(0, 0, 0, 0);
  return result.getTime();
}
export function localDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function daysBetween(a: Date, b: Date): number { return (dayOrdinal(b) - dayOrdinal(a)) / dayMs; }
export function addDays(d: Date, n: number): Date {
  if (!Number.isInteger(n)) throw new Error("days to add must be an integer");
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}
/** Business dates stepped from a toward b, excluding a and including b. */
export function businessDaysBetween(a: Date, b: Date): number {
  const total = daysBetween(a, b);
  if (!Number.isFinite(total)) throw new Error("valid dates are required");
  if (total === 0) return 0;
  const step = total > 0 ? 1 : -1, distance = Math.abs(total);
  // Every block of seven consecutive dates contains five weekdays. The small
  // remainder avoids a UI freeze when the input spans thousands of years.
  let count = Math.floor(distance / 7) * 5;
  const start = dayOrdinal(a);
  for (let i = 1; i <= distance % 7; i++) {
    const dow = new Date(start + step * i * dayMs).getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return step * count;
}
