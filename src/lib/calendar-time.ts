/**
 * TT139 (CK-09) — civil-time arithmetic that survives real time zones.
 *
 * The Clock/Planner code needs to answer questions like "what is the local wall
 * time at this instant in Santiago", "does this wall time exist", and "how many
 * civil days apart are these two dates". `Date` alone answers none of them
 * correctly across DST: adding 86 400 000 ms to an instant is not "tomorrow" in
 * a zone that skipped or repeated an hour.
 *
 * The approach here is the standard, boring one and it is chosen deliberately:
 * all civil maths is done on integer day numbers (the proleptic Gregorian
 * calendar as a pure function of y/m/d), and time-zone conversion is done by
 * asking `Intl.DateTimeFormat` for the offset, then *verifying* the round trip.
 * A conversion that does not round-trip is reported as a gap or an overlap,
 * never smoothed over.
 *
 * Every function is pure and takes an explicit `timeZone`; nothing reads the
 * host's zone implicitly.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 for a proleptic Gregorian civil date (Howard Hinnant's algorithm). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Add civil days to a y/m/d triple (no time zone involved, by construction). */
export function addCivilDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  return civilFromDays(daysFromCivil(y, m, d) + days);
}

/** 0 = Sunday … 6 = Saturday, for any Gregorian date. */
export function dayOfWeek(y: number, m: number, d: number): number {
  const z = daysFromCivil(y, m, d);
  return ((z % 7) + 11) % 7; // 1970-01-01 was a Thursday (4)
}

export function isoWeek(y: number, m: number, d: number): { year: number; week: number } {
  const dow = (dayOfWeek(y, m, d) + 6) % 7; // Monday = 0
  const thursday = addCivilDays(y, m, d, 3 - dow);
  const jan1 = daysFromCivil(thursday.y, 1, 1);
  const week = Math.floor((daysFromCivil(thursday.y, thursday.m, thursday.d) - jan1) / 7) + 1;
  return { year: thursday.y, week };
}

// ── offsets via Intl ─────────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts { y: number; m: number; d: number; h: number; mi: number; s: number; offsetMinutes: number }

/** Wall-clock parts + offset for an instant in a zone. */
export function partsInZone(instantMs: number, timeZone: string): ZonedParts {
  const f = formatter(timeZone);
  const parts = f.formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let h = get("hour");
  if (h === 24) h = 0; // some ICU versions emit 24 for midnight with hour12:false
  const y = get("year"), m = get("month"), d = get("day"), mi = get("minute"), s = get("second");
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  const offsetMinutes = Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / MS_PER_MINUTE);
  return { y, m, d, h, mi, s, offsetMinutes };
}

export function offsetMinutesAt(instantMs: number, timeZone: string): number {
  return partsInZone(instantMs, timeZone).offsetMinutes;
}

export type WallResolution =
  | { kind: "unique"; instant: number; offsetMinutes: number }
  | { kind: "gap"; before: number; after: number; message: string }
  | { kind: "overlap"; earlier: number; later: number; message: string };

/**
 * Resolve a local wall time to an instant. Candidate offsets are taken from the
 * instants 24 h either side (a zone changes offset at most twice in that window
 * for every zone in the IANA database); each candidate is then verified by
 * converting back. Zero matches = gap, two matches = overlap.
 */
export function resolveWallTime(y: number, m: number, d: number, h: number, mi: number, timeZone: string): WallResolution {
  const naive = Date.UTC(y, m - 1, d, h, mi, 0);
  const offsets = new Set<number>([
    offsetMinutesAt(naive - MS_PER_DAY, timeZone),
    offsetMinutesAt(naive, timeZone),
    offsetMinutesAt(naive + MS_PER_DAY, timeZone),
  ]);
  const matches: { instant: number; offsetMinutes: number }[] = [];
  for (const off of offsets) {
    const instant = naive - off * MS_PER_MINUTE;
    const back = partsInZone(instant, timeZone);
    if (back.y === y && back.m === m && back.d === d && back.h === h && back.mi === mi) matches.push({ instant, offsetMinutes: off });
  }
  matches.sort((a, b) => a.instant - b.instant);
  if (matches.length === 1) return { kind: "unique", instant: matches[0].instant, offsetMinutes: matches[0].offsetMinutes };
  if (matches.length >= 2) {
    return { kind: "overlap", earlier: matches[0].instant, later: matches[matches.length - 1].instant, message: "this local time occurs twice (clocks went back)" };
  }
  // gap: the zone skipped this wall time. Report the instants on either side.
  const before = naive - offsetMinutesAt(naive - 6 * MS_PER_HOUR, timeZone) * MS_PER_MINUTE;
  const after = naive - offsetMinutesAt(naive + 6 * MS_PER_HOUR, timeZone) * MS_PER_MINUTE;
  return { kind: "gap", before: Math.min(before, after), after: Math.max(before, after), message: "this local time does not exist (clocks went forward)" };
}

/** Whole civil days between two y/m/d dates. Sign is b − a. */
export function civilDaysBetween(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }): number {
  return daysFromCivil(b.y, b.m, b.d) - daysFromCivil(a.y, a.m, a.d);
}

/** "in 3 days", "2 hours ago" — deliberately coarse and honest about rounding. */
export function describeDelta(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  const future = diff > 0;
  const unit = (n: number, name: string) => `${future ? "in " : ""}${n} ${name}${n === 1 ? "" : "s"}${future ? "" : " ago"}`;
  if (abs < MS_PER_MINUTE) return future ? "in a moment" : "just now";
  if (abs < MS_PER_HOUR) return unit(Math.round(abs / MS_PER_MINUTE), "minute");
  if (abs < MS_PER_DAY) return unit(Math.round(abs / MS_PER_HOUR), "hour");
  if (abs < 30 * MS_PER_DAY) return unit(Math.round(abs / MS_PER_DAY), "day");
  if (abs < 365 * MS_PER_DAY) return unit(Math.round(abs / (30 * MS_PER_DAY)), "month");
  return unit(Math.round(abs / (365 * MS_PER_DAY)), "year");
}

/** Format an instant as an RFC 5545 UTC timestamp. */
export function toIcsUtc(instantMs: number): string {
  const d = new Date(instantMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Parse the RFC 5545 forms this app writes and reads: DATE and UTC DATE-TIME. */
export function parseIcsTime(value: string): { kind: "date"; y: number; m: number; d: number } | { kind: "utc"; instant: number } | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date) return { kind: "date", y: Number(date[1]), m: Number(date[2]), d: Number(date[3]) };
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (utc) return { kind: "utc", instant: Date.UTC(Number(utc[1]), Number(utc[2]) - 1, Number(utc[3]), Number(utc[4]), Number(utc[5]), Number(utc[6])) };
  return null;
}

/** Supported IANA zones as reported by this runtime, for a picker that cannot lie. */
export function supportedTimeZones(): string[] {
  const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return anyIntl.supportedValuesOf ? anyIntl.supportedValuesOf("timeZone") : [];
}

/**
 * Hours between two wall clocks in different zones at the same instant — used
 * by the world clock's "good time to call" planner. Returns the overlap window
 * in *the first zone's* local hours, or null when there is none.
 */
export function callOverlap(aZone: string, bZone: string, nowMs: number, workHours = { from: 9, to: 18 }): { startHour: number; endHour: number } | null {
  const step = 15 * MS_PER_MINUTE;
  const startOfDay = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
  let bestStart: number | null = null, bestEnd: number | null = null;
  let runStart: number | null = null;
  for (let t = startOfDay; t < startOfDay + MS_PER_DAY; t += step) {
    const a = partsInZone(t, aZone), b = partsInZone(t, bZone);
    const ok = a.h >= workHours.from && a.h < workHours.to && b.h >= workHours.from && b.h < workHours.to;
    const mins = (a.h * 60 + a.mi) / 60;
    if (ok && runStart === null) runStart = mins;
    if (!ok && runStart !== null) { if (bestStart === null || mins - runStart > (bestEnd! - bestStart)) { bestStart = runStart; bestEnd = mins; } runStart = null; }
  }
  if (runStart !== null) { const end = 24; if (bestStart === null || end - runStart > (bestEnd! - bestStart)) { bestStart = runStart; bestEnd = end; } }
  return bestStart === null ? null : { startHour: bestStart, endHour: bestEnd! };
}
