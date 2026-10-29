/** TT117 PL-01 — recurrence expansion (a strict, honest subset of RFC 5545 RRULE).
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
  const parts = Object.fromEntries(String(text).replace(/^RRULE:/i, "").split(";").map((kv) => {
    const i = kv.indexOf("="); return [kv.slice(0, i).trim().toUpperCase(), kv.slice(i + 1).trim().toUpperCase()];
  }));
  const freq = parts.FREQ as Freq;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) throw new Error(`unsupported RRULE FREQ "${parts.FREQ ?? ""}"`);
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) throw new Error("RRULE INTERVAL must be 1–999");
  const dayCode: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  let byDay: number[] | undefined;
  if (parts.BYDAY !== undefined) {
    byDay = parts.BYDAY.split(",").map((c) => { if (!(c in dayCode)) throw new Error(`unsupported BYDAY "${c}"`); return dayCode[c]; });
  }
  const count = parts.COUNT === undefined ? undefined : Number(parts.COUNT);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > RECURRENCE_CAP)) throw new Error(`RRULE COUNT must be 1–${RECURRENCE_CAP}`);
  if (parts.UNTIL !== undefined && !/^\d{8}(T\d{6}Z?)?$/.test(parts.UNTIL)) throw new Error("RRULE UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ");
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
  const y = +until.slice(0, 4), mo = +until.slice(4, 6) - 1, d = +until.slice(6, 8);
  if (until.length > 8) return new Date(Date.UTC(y, mo, d, +until.slice(9, 11), +until.slice(11, 13), +until.slice(13, 15)));
  return new Date(Date.UTC(y, mo, d, 23, 59, 59));
}
function clamped(y: number, mo: number, day: number, base: Date): Date {
  const last = new Date(y, mo + 1, 0).getDate();
  return new Date(y, mo, Math.min(day, last), base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
}
/** Occurrences of `start` under `rule` inside [windowStart, windowEnd], ascending. */
export function expandRecurrence(start: Date, rule: Recurrence, windowStart: Date, windowEnd: Date): Date[] {
  if (!(start instanceof Date) || isNaN(+start)) throw new Error("recurrence start must be a valid date");
  if (windowEnd < windowStart) throw new Error("recurrence window is inverted");
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
    const days = [...new Set(rule.byDay)].sort((a, b) => a - b);
    const mondayOffset = (start.getDay() + 6) % 7;
    const week0 = new Date(start.getFullYear(), start.getMonth(), start.getDate() - mondayOffset, start.getHours(), start.getMinutes(), start.getSeconds());
    outer: for (let w = 0; ; w += rule.interval) {
      for (const day of days) {
        const d = new Date(week0.getFullYear(), week0.getMonth(), week0.getDate() + w * 7 + ((day + 6) % 7), start.getHours(), start.getMinutes(), start.getSeconds());
        if (d < start) continue;
        if (!emit(d)) break outer;
      }
      if (new Date(week0.getFullYear(), week0.getMonth(), week0.getDate() + w * 7) > end && produced > 0) break;
      if (w > 5200) break;
    }
    return out;
  }
  for (let i = 0; ; i++) {
    let d: Date;
    if (rule.freq === "DAILY") d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * rule.interval, start.getHours(), start.getMinutes(), start.getSeconds());
    else if (rule.freq === "WEEKLY") d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7 * rule.interval, start.getHours(), start.getMinutes(), start.getSeconds());
    else if (rule.freq === "MONTHLY") { const t = start.getMonth() + i * rule.interval; d = clamped(start.getFullYear() + Math.floor(t / 12), ((t % 12) + 12) % 12, start.getDate(), start); }
    else { d = clamped(start.getFullYear() + i * rule.interval, start.getMonth(), start.getDate(), start); }
    if (!emit(d)) break;
    if (i > 20000) throw new Error("recurrence expansion is unbounded");
  }
  return out;
}
