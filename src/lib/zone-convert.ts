/**
 * WD-03 — "when it's 15:00 there, what time is it here?" Point conversion
 * between zones for a stated local date/time, via Intl with hourCycle h23.
 * The date can shift across the dateline; the result reports the target
 * date as well as the time so a +1 day answer is never silently read as
 * same-day. Invalid zone or date input throws instead of guessing.
 */
function zoneOffsetMs(atUtc: number, zone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(atUtc)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(atUtc / 1000) * 1000;
}

export interface ZoneConversion { utc: string; targetDate: string; targetTime: string; dayShift: number }

export function convertZoneTime(date: string, time: string, fromZone: string, toZone: string): ZoneConversion {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("date must be YYYY-MM-DD and time HH:MM");
  // Resolve the stated wall time in fromZone to a UTC instant (two-pass offset).
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(naive)) throw new Error("date must be YYYY-MM-DD and time HH:MM");
  let utc = naive - zoneOffsetMs(naive, fromZone);
  utc = naive - zoneOffsetMs(utc, fromZone);
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: toZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utc)).map((p) => [p.type, p.value]));
  const targetDate = `${parts.year}-${parts.month}-${parts.day}`;
  const dayShift = Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  return { utc: new Date(utc).toISOString(), targetDate, targetTime: `${parts.hour}:${parts.minute}`, dayShift };
}
