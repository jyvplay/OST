/**
 * Cron, honestly.
 *
 * Three things separate a cron implementation that is *useful* from one that is a
 * demo: it refuses the expressions that mean nothing, it agrees with a brute-force
 * minute scan on every input it accepts, and it says what happens to a job whose
 * wall time does not exist. All three are properties this module is built around and
 * `scripts/tt151-time.mts` checks.
 *
 * Semantics follow Vixie cron, including the one rule people get wrong: when *both*
 * day-of-month and day-of-week both lack a leading wildcard, either may match.
 * If either starts with `*`, the fields intersect, including stepped forms. Our
 * `?` extension is treated as a leading wildcard. Thus `0 0 1 * 1` fires on
 * the 1st **and** on every Monday; a stepped wildcard requires both matches.
 *
 * Time zones are not a detail here. Occurrence search walks civil days and resolves
 * each candidate wall time through `calendar-time.resolveWallTime`, so a 02:30 job in
 * a spring-forward gap is *reported as skipped* instead of being invented at 03:30 or
 * silently moved to the wrong instant. Nothing in this file uses the ambient clock.
 */
import { partsInZone, resolveWallTime, daysFromCivil, civilFromDays } from "./calendar-time";

export interface CronSchedule {
  source: string;
  /** Sorted, de-duplicated, ascending. */
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  /** False for a leading `*` (or our `?` extension), needed for Vixie AND/OR. */
  domRestricted: boolean;
  dowRestricted: boolean;
  macro?: string;
  /** Wall-clock minute (0–59) regardless of zone. */
  minuteOfHour: number;
}

export type CronParse = { ok: true; schedule: CronSchedule } | { ok: false; error: string };

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_FULL_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DOW_FULL_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** 7 is a second name for Sunday; normalised to 0. */
const DOW_MAX = 7;

export const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseValue(raw: string, min: number, max: number, names: string[] | null, field: string): number | string {
  const v = raw.trim().toLowerCase();
  if (v === "") return `${field}: empty value`;
  if (names) {
    const fullNames = names === MONTH_NAMES ? MONTH_FULL_NAMES : DOW_FULL_NAMES;
    const idx = names.indexOf(v) >= 0 ? names.indexOf(v) : fullNames.indexOf(v);
    if (idx >= 0) {
      // Chronologically ordered names (months) map to 1-based numbers; weekday names to 0-based.
      return names === MONTH_NAMES ? idx + 1 : idx;
    }
  }
  if (!/^\d+$/.test(v)) return `${field}: "${raw}" is not a number${names ? " or name" : ""}`;
  const n = Number(v);
  if (n < min || n > max) return `${field}: ${n} is outside ${min}–${max}`;
  return n;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names: string[] | null,
  field: string,
  { allowSunday7 = false }: { allowSunday7?: boolean } = {},
): number[] | string {
  const out = new Set<number>();
  // A trailing/leading comma, or a doubled one, is a typo rather than a list.
  for (const part of raw.split(",")) {
    if (part.trim() === "") return `${field}: empty list item in "${raw}"`;
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) return `${field}: "${part}" has more than one step`;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart.trim())) return `${field}: step "${stepPart}" is not a number`;
      step = Number(stepPart);
      if (!Number.isSafeInteger(step) || step < 1) return `${field}: step must be a safe integer of at least 1`;
    }
    let lo: number, hi: number;
    if (rangePart.trim() === "*" || (rangePart.trim() === "?" && (field === "day-of-month" || field === "day-of-week"))) {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b, more] = rangePart.split("-");
      if (more !== undefined) return `${field}: "${rangePart}" has more than one dash`;
      const pa = parseValue(a, min, allowSunday7 ? DOW_MAX : max, names, field);
      const pb = parseValue(b, min, allowSunday7 ? DOW_MAX : max, names, field);
      if (typeof pa === "string") return pa;
      if (typeof pb === "string") return pb;
      if (pa > pb) return `${field}: range ${pa}-${pb} runs backwards`;
      lo = pa;
      hi = pb;
    } else {
      const single = parseValue(rangePart, min, allowSunday7 ? DOW_MAX : max, names, field);
      if (typeof single === "string") return single;
      if (stepPart === undefined) {
        out.add(single === 7 && allowSunday7 ? 0 : single);
        continue;
      }
      // "5/10" is "from 5 to the end of the field, every 10" — the standard reading.
      lo = single;
      hi = allowSunday7 ? DOW_MAX : max;
    }
    for (let n = lo; n <= hi; n += step) out.add(n === 7 && allowSunday7 ? 0 : n);
  }
  return [...out].sort((a, b) => a - b);
}

const CAREFULLY = { allowSunday7: true } as const;

export function parseCron(expr: string): CronParse {
  const source = expr.trim();
  if (source === "") return { ok: false, error: "empty expression" };
  let macro: string | undefined;
  let body = source;
  if (source.startsWith("@")) {
    const key = source.toLowerCase();
    if (key === "@reboot") return { ok: false, error: "@reboot has no wall-clock meaning; use a startup routine" };
    const mapped = CRON_MACROS[key];
    if (!mapped) return { ok: false, error: `unknown macro "${source}"` };
    macro = key;
    body = mapped;
  }
  const fields = body.split(/\s+/).filter((s) => s !== "");
  if (fields.length === 6) {
    // An explicit seconds field is a different dialect (Quartz); refusing is kinder
    // than accepting it and firing 60× more often than the user meant.
    return { ok: false, error: "six fields means seconds: this scheduler is minute-granular, drop the first field" };
  }
  if (fields.length !== 5) return { ok: false, error: `expected 5 fields, got ${fields.length}` };
  const [mi, ho, dom, mo, dow] = fields;
  const minute = parseField(mi, 0, 59, null, "minute");
  if (typeof minute === "string") return { ok: false, error: minute };
  const hour = parseField(ho, 0, 23, null, "hour");
  if (typeof hour === "string") return { ok: false, error: hour };
  const dayOfMonth = parseField(dom, 1, 31, null, "day-of-month");
  if (typeof dayOfMonth === "string") return { ok: false, error: dayOfMonth };
  const month = parseField(mo, 1, 12, MONTH_NAMES, "month");
  if (typeof month === "string") return { ok: false, error: month };
  const dayOfWeek = parseField(dow, 0, 6, DOW_NAMES, "day-of-week", CAREFULLY);
  if (typeof dayOfWeek === "string") return { ok: false, error: dayOfWeek };

  // Vixie checks the first character, not whether the expanded set is full.
  // Our ? extension follows the same leading-wildcard rule.
  const domRestricted = !/^[*?]/.test(dom);
  const dowRestricted = !/^[*?]/.test(dow);

  // A date that can never occur is worse than a parse error: it looks alive forever.
  if (month.length === 0 || dayOfMonth.length === 0 || dayOfWeek.length === 0) {
    return { ok: false, error: "a field selects nothing" };
  }
  const longest = Math.max(...month.map((m) => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]));
  if (!(domRestricted && dowRestricted) && dayOfMonth.length && Math.min(...dayOfMonth) > longest) {
    return { ok: false, error: `day ${Math.min(...dayOfMonth)} never occurs in the selected months` };
  }
  return {
    ok: true,
    schedule: {
      source,
      minute,
      hour,
      dayOfMonth,
      month,
      dayOfWeek,
      domRestricted,
      dowRestricted,
      macro,
      minuteOfHour: minute.length === 1 ? minute[0] : -1,
    },
  };
}

/** Vixie day test: either field may satisfy the day when both are restricted. */
export function cronMatchesDay(s: CronSchedule, y: number, m: number, d: number): boolean {
  if (!s.month.includes(m)) return false;
  const dow = new Date(daysFromCivil(y, m, d) * 86400000).getUTCDay();
  const domOk = s.dayOfMonth.includes(d);
  const dowOk = s.dayOfWeek.includes(dow);
  return s.domRestricted && s.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

export function cronMatches(s: CronSchedule, parts: { y: number; m: number; d: number; h: number; mi: number }): boolean {
  return cronMatchesDay(s, parts.y, parts.m, parts.d) && s.hour.includes(parts.h) && s.minute.includes(parts.mi);
}

export interface CronSkipped { local: string; reason: "gap" }
export interface CronRun {
  /** Strictly increasing instants, all after `fromMs`. */
  instants: number[];
  /** Wall times the schedule wanted that the zone did not have. */
  skipped: CronSkipped[];
  /** True when the search hit its horizon before finding `count` runs. */
  truncated: boolean;
}

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

/**
 * Next `count` occurrences after `fromMs`, in `timeZone`.
 *
 * The walk is over civil days, not over minutes, so `0 0 29 2 *` costs one leap-year
 * scan rather than 500 k iterations. Each candidate wall time is resolved through the
 * zone: unique → emitted, gap → recorded as skipped, overlap → the *earlier* instant is
 * emitted and the later one is not (firing twice would be the bug users notice).
 */
export function nextOccurrences(
  schedule: CronSchedule,
  fromMs: number,
  timeZone: string,
  count = 5,
  horizonDays = 4 * 366,
): CronRun {
  const instants: number[] = [];
  const skipped: CronSkipped[] = [];
  if (count <= 0) return { instants, skipped, truncated: false };
  const start = partsInZone(fromMs, timeZone);
  const startDay = daysFromCivil(start.y, start.m, start.d);
  let truncated = true;
  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    const { y, m, d } = civilFromDays(startDay + dayOffset);
    if (!cronMatchesDay(schedule, y, m, d)) continue;
    for (const h of schedule.hour) {
      for (const mi of schedule.minute) {
        // UTC has no gaps or overlaps: on the cursor day an earlier (or the
        // same) civil minute cannot produce an instant strictly after fromMs.
        // Keep the full zone resolver for every other zone.
        if (timeZone === "UTC" && dayOffset === 0 && h * 60 + mi <= start.h * 60 + start.mi) continue;
        const res = resolveWallTime(y, m, d, h, mi, timeZone);
        if (res.kind === "gap") {
          // A nonexistent time earlier on the cursor’s civil day is not a future skip.
          if (dayOffset === 0 && h * 60 + mi <= start.h * 60 + start.mi) continue;
          skipped.push({ local: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, reason: "gap" });
          continue;
        }
        const instant = res.kind === "unique" ? res.instant : res.earlier;
        if (instant <= fromMs) continue;
        if (instants.length && instant <= instants[instants.length - 1]) continue;
        instants.push(instant);
        if (instants.length >= count) return { instants, skipped, truncated: false };
      }
    }
    // Cheap early exit: if the day matched and we are already past the horizon the loop ends anyway.
    if (dayOffset * MS_DAY > 0 && instants.length === 0 && dayOffset > horizonDays) break;
  }
  return { instants, skipped, truncated };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Compress a sorted number list into ranges: [1,2,3,5] → "1–3, 5". */
function compress(values: number[], label: (n: number) => string = String): string {
  const out: string[] = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    if (j - i >= 2) out.push(`${label(values[i])}–${label(values[j])}`);
    else for (let k = i; k <= j; k++) out.push(label(values[k]));
    i = j + 1;
  }
  return out.join(", ");
}

const dayName = (d: number) => DOW_NAMES[d];

/**
 * A description derived from the *parsed* fields, so two sources that mean the same
 * thing read the same: `0 9 * * 1` and `0 09 * * MON` both say "on mon at 09:00".
 * It is deliberately concrete — no "twice a day" prettiness that could hide a mistake.
 */
export function describeCron(s: CronSchedule): string {
  if (s.macro) return `${s.macro} (${CRON_MACROS[s.macro] ?? s.source})`;
  const clock = s.hour.length * s.minute.length <= 6
    ? s.hour.flatMap((h) => s.minute.map((mi) => `${pad2(h)}:${pad2(mi)}`)).join(", ")
    : "";
  const time = s.minute.length === 60 && s.hour.length === 24
    ? "every minute"
    : s.hour.length === 24
      ? s.minute.length === 1
        ? `hourly at :${pad2(s.minute[0])}`
        : `at minutes ${compress(s.minute)} of every hour`
      : clock
        ? `at ${clock}`
        : `at minutes ${compress(s.minute)} of hours ${compress(s.hour)}`;
  const domFull = s.dayOfMonth.length === 31;
  const dowFull = s.dayOfWeek.length === 7;
  const days = s.domRestricted && s.dowRestricted
    ? `on day ${compress(s.dayOfMonth)} or weekday ${compress(s.dayOfWeek, dayName)}`
    : !domFull && !dowFull
      ? `on day ${compress(s.dayOfMonth)} and weekday ${compress(s.dayOfWeek, dayName)}`
      : !domFull
        ? `on day ${compress(s.dayOfMonth)}`
        : !dowFull
          ? `on ${compress(s.dayOfWeek, dayName)}`
          : "";
  const months = s.month.length === 12 ? "" : `in ${compress(s.month, (m) => MONTH_NAMES[m - 1])}`;
  return [days, months, time].filter(Boolean).join(" ");
}
