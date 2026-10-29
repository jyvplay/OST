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

/** CK-03: calendar arithmetic on whole local days (time-of-day is discarded on purpose). */
const dayMs = 86_400_000;
function strip(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
export function daysBetween(a: Date, b: Date): number { return Math.round((strip(b) - strip(a)) / dayMs); }
export function addDays(d: Date, n: number): Date {
  if (!Number.isInteger(n)) throw new Error("days to add must be an integer");
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}
/** Business days in [a, b): Monday–Friday days strictly after a, up to and excluding b (sign-aware). */
export function businessDaysBetween(a: Date, b: Date): number {
  const total = daysBetween(a, b);
  if (total === 0) return 0;
  const step = total > 0 ? 1 : -1;
  let count = 0;
  for (let i = 1; i <= Math.abs(total); i++) {
    const d = new Date(a.getFullYear(), a.getMonth(), a.getDate() + step * i);
    if (d.getDay() >= 1 && d.getDay() <= 5) count++;
  }
  return step * count;
}
