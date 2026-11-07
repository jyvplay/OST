/**
 * TT145 (CK-01) — alarm occurrence maths, including the cases that make alarms
 * silently not fire.
 *
 * An alarm is (schedule, action). The schedule is one of daily / weekdays /
 * weekly-on-days / once. The hard part is not the next time; it is the four ways a
 * foreground page gets it wrong, each of which is a branch here:
 *
 *   1. **A missed window while the page was closed.** The alarm fired nowhere. The
 *      engine reports every occurrence between "last evaluated" and "now" as
 *      `missed`, in order, so the UI can say "3 alarms were missed while this tab
 *      was closed" instead of pretending the next one is the only one.
 *   2. **A backwards clock.** If now < lastEvaluated, the engine does not fire
 *      anything and reports `clock-backwards`; a wall-clock jump is not a reason to
 *      replay a morning alarm at midnight.
 *   3. **A week that does not contain the day.** `weekdays` with no valid day is
 *      refused at construction, because an alarm that never fires is worse than
 *      none — nobody notices it.
 *   4. **A once-alarm that already fired.** It is `spent`, not "due again", and the
 *      engine refuses to resurrect it after a reload.
 *
 * All arithmetic is in local civil time supplied by the caller (`partsOf`) so the
 * engine has no timezone in it: the caller passes a function that returns local
 * Y/M/D/h/m for a timestamp, and the test can supply a fixed-zone table.
 */

export type Cadence = "daily" | "weekdays" | "weekly" | "once";
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const; // 0 = Sunday
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface Alarm {
  id: string;
  label: string;
  at: string; // "HH:MM"
  cadence: Cadence;
  /** For `weekly`: days of week. Ignored otherwise. */
  days: number[];
  enabled: boolean;
  /** For `once`: the civil date, "YYYY-MM-DD". */
  date?: string;
  /** When this alarm last actually fired (not when it was due). */
  lastFiredAt: number | null;
  snoozedUntil: number | null;
}

export interface Civil { y: number; m: number; d: number; h: number; min: number; dow: number }

export type PartsOf = (ts: number) => Civil;

export type Outcome = "due" | "spent" | "disabled" | "snoozed" | "clock-backwards";

export interface Occurrence { alarmId: string; at: number; label: string }

export interface Evaluation {
  outcome: Outcome;
  /** Every occurrence in (since, now], oldest first. Includes missed ones. */
  due: Occurrence[];
  /** Occurrences that occurred while nobody was evaluating (an alias for the missed tail). */
  missed: number;
  sentence: string;
}

const atMinutes = (parts: string): number => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(parts);
  if (!m) throw new Error(`“${parts}” is not a 24-hour time`);
  return Number(m[1]) * 60 + Number(m[2]);
};

export function makeAlarm(id: string, label: string, at: string, cadence: Cadence, opts: { days?: number[]; date?: string } = {}): Alarm {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error(`alarm id “${id}” must be a lowercase id`);
  atMinutes(at);
  if (cadence === "weekdays" || cadence === "weekly") {
    const days = [...new Set(opts.days ?? [])].sort();
    if (!days.length) throw new Error("a weekly alarm with no days never fires: refused rather than saved");
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error("days must be 0–6, Sunday = 0");
    if (cadence === "weekdays" && days.some((d) => d === 0 || d === 6)) throw new Error("“weekdays” excludes Saturday and Sunday; use weekly for those");
    return { id, label, at, cadence, days, enabled: true, lastFiredAt: null, snoozedUntil: null };
  }
  if (cadence === "once") {
    if (!opts.date || !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error("a once alarm needs a YYYY-MM-DD date");
    return { id, label, at, cadence, days: [], enabled: true, date: opts.date, lastFiredAt: null, snoozedUntil: null };
  }
  return { id, label, at, cadence, days: [...ALL_DAYS], enabled: true, lastFiredAt: null, snoozedUntil: null };
}

const DAY_MS = 86400000;

/** Local minute-of-day for a timestamp, via the caller's civil-time function. */
const minuteOfDay = (partsOf: PartsOf, ts: number): number => {
  const c = partsOf(ts);
  return c.h * 60 + c.min;
};

/**
 * The timestamp on the local day containing `dayAnchor` at the alarm's minute.
 *
 * Built by offsetting from a day anchor rather than by probing every minute, so a
 * 40-day window costs 40 steps, not 57 600. A DST transition makes the naive
 * offset off by exactly one hour, which is corrected once and then *verified*
 * against the caller's civil-time function — an alarm at 02:30 on the day the
 * clocks spring forward genuinely does not exist, and that is reported by
 * returning `null` for the day rather than inventing 03:30.
 */
function timestampForDay(dayAnchor: number, targetMin: number, partsOf: PartsOf): number | null {
  const anchorMin = minuteOfDay(partsOf, dayAnchor);
  for (const shift of [0, -60, 60, -120, 120]) {
    const ts = dayAnchor + (targetMin + shift - anchorMin) * 60000;
    if (minuteOfDay(partsOf, ts) === targetMin) return ts;
  }
  return null;
}

/**
 * Occurrences of one alarm in the half-open window (since, now].
 *
 * The window is bounded to 40 days on purpose: a tab that was closed longer than
 * that cannot report a per-occurrence list honestly (the records are not there),
 * and the caller reports a count instead. `once` alarms stop after their single
 * match, so nothing downstream has to special-case them.
 */
export function occurrencesBetween(a: Alarm, since: number, now: number, partsOf: PartsOf): number[] {
  if (now < since) return [];
  const target = atMinutes(a.at);
  const first = Math.floor(since / DAY_MS) * DAY_MS;
  const out: number[] = [];
  for (let day = 0; day <= 41; day++) {
    const anchor = first + day * DAY_MS;
    if (anchor > now + DAY_MS) break;
    const ts = timestampForDay(anchor, target, partsOf);
    if (ts === null || ts <= since || ts > now) continue;
    const c = partsOf(ts);
    if (a.cadence === "once") {
      const iso = `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
      if (iso !== a.date) continue;
      out.push(ts);
      return out;
    }
    if ((a.cadence === "weekdays" || a.cadence === "weekly") && !a.days.includes(c.dow)) continue;
    out.push(ts);
  }
  return out;
}

/**
 * One evaluation. `lastEvaluatedAt` is when the page last looked; a page that was
 * closed for a day reports missed alarms rather than skipping them.
 */
export function evaluate(a: Alarm, lastEvaluatedAt: number, now: number, partsOf: PartsOf): Evaluation {
  if (!a.enabled) return { outcome: "disabled", due: [], missed: 0, sentence: "this alarm is switched off" };
  if (now < lastEvaluatedAt) return { outcome: "clock-backwards", due: [], missed: 0, sentence: `the clock moved back ${Math.round((lastEvaluatedAt - now) / 60000)} min; nothing is fired by a clock jump` };
  if (a.snoozedUntil !== null && a.snoozedUntil > now) {
    return { outcome: "snoozed", due: [], missed: 0, sentence: `snoozed for another ${Math.ceil((a.snoozedUntil - now) / 60000)} min` };
  }
  if (a.cadence === "once" && a.lastFiredAt !== null) return { outcome: "spent", due: [], missed: 0, sentence: "this one-shot alarm already fired and is not reused" };
  const times = occurrencesBetween(a, lastEvaluatedAt, now, partsOf).filter((t) => a.lastFiredAt === null || t > a.lastFiredAt);
  if (!times.length) return { outcome: "due", due: [], missed: 0, sentence: "no occurrence in the window" };
  const due = times.map((t) => ({ alarmId: a.id, at: t, label: a.label }));
  const missed = Math.max(0, times.length - 1);
  return {
    outcome: "due", due, missed,
    sentence: missed
      ? `${times.length} occurrences were due while nothing was evaluating; the last is shown now and ${missed} were missed`
      : `due at ${a.at}`,
  };
}

/** Snooze. A snooze past the next natural occurrence is refused: it would skip it. */
export function snooze(a: Alarm, now: number, minutes: number, partsOf: PartsOf): { alarm: Alarm; note: string } {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error("a snooze is 1–1440 whole minutes");
  const natural = occurrencesBetween(a, now, now + 8 * DAY_MS, partsOf).find((t) => t > now) ?? null;
  const until = now + minutes * 60000;
  if (natural !== null && until >= natural) throw new Error(`a ${minutes}-minute snooze would run past the next occurrence at ${new Date(natural).toISOString()}; the alarm would be skipped`);
  return { alarm: { ...a, snoozedUntil: until }, note: `snoozed for ${minutes} min, until ${new Date(until).toISOString()}` };
}

/** Plain-language schedule, with no "every" for a cadence that is not every day. */
export function scheduleText(a: Alarm): string {
  if (a.cadence === "daily") return `every day at ${a.at}`;
  if (a.cadence === "weekdays") return `${a.days.map((d) => DAY_NAMES[d]).join(", ")} at ${a.at}`;
  if (a.cadence === "weekly") return `${a.days.map((d) => DAY_NAMES[d]).join(", ")} at ${a.at}`;
  return `${a.date} at ${a.at}, once`;
}

/** Passed straight to the UI: the alarm path is foreground-only. */
export function deliverySentence(): string {
  return "alarms fire while this app is running. A closed page fires nothing, and a page cannot ask the OS for an exact-time notification";
}
