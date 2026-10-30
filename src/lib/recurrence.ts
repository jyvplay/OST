import { parseIcsDate } from "./ics";

/** TT117 PL-01 — recurrence preview (a limited RRULE-like subset). Monthly/yearly clamping differs from RFC 5545, which skips invalid dates.
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL>=1, BYDAY for WEEKLY,
 * COUNT and UNTIL. Monthly/yearly expansion clamps the day to the target month
 * (31 Jan -> 28/29 Feb, then back to 31 Mar — the anchor day is remembered, so
 * the series does not drift to the 28th forever). Expansion is always bounded
 * by the caller's window and a hard occurrence cap; an unbounded rule asked for
 * an unbounded window is refused instead of looping. */
export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export interface Recurrence { freq: Freq; interval: number; byDay?: number[]; count?: number; until?: string }
export const RECURRENCE_CAP = 512;

export function parseRRule(text: string): Recurrence {
  const parts: Record<string, string> = Object.create(null);
  for (const kv of String(text).replace(/^RRULE:/i, "").split(";")) {
    const i = kv.indexOf("=");
    if (i <= 0 || i === kv.length - 1) throw new Error("invalid RRULE part");
    const key = kv.slice(0, i).trim().toUpperCase(), value = kv.slice(i + 1).trim().toUpperCase();
    if (!["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"].includes(key)) throw new Error(`unsupported RRULE part "${key}"`);
    if (key in parts) throw new Error(`duplicate RRULE part "${key}"`);
    parts[key] = value;
  }
  const freq = parts.FREQ as Freq;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) throw new Error(`unsupported RRULE FREQ "${parts.FREQ ?? ""}"`);
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  if ((parts.INTERVAL !== undefined && !/^\d+$/.test(parts.INTERVAL)) || !Number.isInteger(interval) || interval < 1 || interval > 999) throw new Error("RRULE INTERVAL must be 1–999");
  const dayCode: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  let byDay: number[] | undefined;
  if (parts.BYDAY !== undefined) {
    byDay = parts.BYDAY.split(",").map((c) => { if (!(c in dayCode)) throw new Error(`unsupported BYDAY "${c}"`); return dayCode[c]; });
  }
  if (byDay && freq !== "WEEKLY") throw new Error("BYDAY is supported only for WEEKLY rules");
  const count = parts.COUNT === undefined ? undefined : Number(parts.COUNT);
  if (count !== undefined && (!/^\d+$/.test(parts.COUNT) || !Number.isInteger(count) || count < 1 || count > RECURRENCE_CAP)) throw new Error(`RRULE COUNT must be 1–${RECURRENCE_CAP}`);
  if (parts.COUNT !== undefined && parts.UNTIL !== undefined) throw new Error("RRULE cannot combine COUNT and UNTIL");
  if (parts.UNTIL !== undefined && !parseIcsDate(parts.UNTIL, "")) throw new Error("RRULE UNTIL must be a valid YYYYMMDD or YYYYMMDDTHHMMSS[Z]");
  return { freq, interval, byDay, count, until: parts.UNTIL };
}
export function formatRRule(r: Recurrence): string {
  const code = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const out = [`FREQ=${r.freq}`, `INTERVAL=${r.interval}`];
  if (r.byDay?.length) out.push(`BYDAY=${r.byDay.map((d) => code[d]).join(",")}`);
  if (r.count) out.push(`COUNT=${r.count}`);
  if (r.until) out.push(`UNTIL=${r.until}`);
  return out.join(";");
}
function untilDate(until: string): Date {
  const d = parseIcsDate(until, "");
  if (!d) throw new Error("invalid RRULE UNTIL");
  // A DATE has local calendar-day semantics, while a date-time with Z is UTC.
  if (until.length === 8) d.setHours(23, 59, 59, 999);
  return d;
}
function clamped(y: number, mo: number, day: number, base: Date): Date {
  const last = new Date(y, mo + 1, 0).getDate();
  return new Date(y, mo, Math.min(day, last), base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
}
/** Occurrences of `start` under `rule` inside [windowStart, windowEnd], ascending. */
export function expandRecurrence(start: Date, rule: Recurrence, windowStart: Date, windowEnd: Date): Date[] {
  if (!(start instanceof Date) || isNaN(+start)) throw new Error("recurrence start must be a valid date");
  if (!(windowStart instanceof Date) || !Number.isFinite(+windowStart) || !(windowEnd instanceof Date) || !Number.isFinite(+windowEnd)) throw new Error("recurrence window must have valid dates");
  if (windowEnd < windowStart) throw new Error("recurrence window is inverted");
  if (!rule || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq) || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 999 ||
      (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > RECURRENCE_CAP)) ||
      (rule.count !== undefined && rule.until !== undefined) ||
      (rule.byDay !== undefined && (rule.freq !== "WEEKLY" || !Array.isArray(rule.byDay) || !rule.byDay.length || rule.byDay.some((d) => !Number.isInteger(d) || d < 0 || d > 6)))) throw new Error("invalid recurrence rule");
  const until = rule.until ? untilDate(rule.until) : null;
  const end = until && until < windowEnd ? until : windowEnd;
  const out: Date[] = [];
  let produced = 0;
  const emit = (d: Date): boolean => { // false = stop entirely
    if (rule.count && produced >= rule.count) return false;
    if (d > end) return false;
    produced++;
    if (d >= windowStart) { out.push(d); if (out.length > RECURRENCE_CAP) throw new Error(`recurrence exceeds ${RECURRENCE_CAP} occurrences in the window`); }
    return true;
  };
  if (rule.freq === "WEEKLY" && rule.byDay?.length) {
    const days = [...new Set(rule.byDay)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const mondayOffset = (start.getDay() + 6) % 7;
    const week0 = new Date(start.getFullYear(), start.getMonth(), start.getDate() - mondayOffset, start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
    outer: for (let w = 0; ; w += rule.interval) {
      for (const day of days) {
        const d = new Date(week0.getFullYear(), week0.getMonth(), week0.getDate() + w * 7 + ((day + 6) % 7), start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
        if (d < start) continue;
        if (!emit(d)) break outer;
      }
      if (new Date(week0.getFullYear(), week0.getMonth(), week0.getDate() + w * 7) > end && produced > 0) break;
      if (w > 5200) throw new Error("recurrence expansion exceeds the supported span");
    }
    return out;
  }
  for (let i = 0; ; i++) {
    let d: Date;
    if (rule.freq === "DAILY") d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * rule.interval, start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
    else if (rule.freq === "WEEKLY") d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7 * rule.interval, start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
    else if (rule.freq === "MONTHLY") { const t = start.getMonth() + i * rule.interval; d = clamped(start.getFullYear() + Math.floor(t / 12), ((t % 12) + 12) % 12, start.getDate(), start); }
    else { d = clamped(start.getFullYear() + i * rule.interval, start.getMonth(), start.getDate(), start); }
    if (!emit(d)) break;
    if (i > 20000) throw new Error("recurrence expansion is unbounded");
  }
  return out;
}
