/**
 * WD-04 — business-hours status per zone: is it currently 09:00–17:00
 * there? Uses the Intl hour at the instant, so DST is handled by the
 * platform database rather than a fixed offset table that goes stale
 * twice a year. The status text names the local time it was derived
 * from, so the answer is checkable at a glance.
 */
export interface ZoneStatus { zone: string; localTime: string; hour: number; open: boolean }

export function zoneStatus(zone: string, at = new Date()): ZoneStatus {
  const dtf = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const weekday = String(parts.weekday);
  const weekdayNum = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const open = weekdayNum >= 1 && weekdayNum <= 5 && hour >= 9 && hour < 17;
  return { zone, localTime: `${weekday} ${parts.hour}:${parts.minute}`, hour, open };
}
