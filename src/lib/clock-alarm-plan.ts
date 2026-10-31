import { nextFire, type Alarm } from "./clock-core";

/** The existing Clock delivery window is the last 60 seconds. Keep it bounded:
 * a suspended or closed page cannot promise to deliver arbitrarily late alarms. */
export const ALARM_WINDOW_MS = 60_000;
export interface DueAlarm { alarm: Alarm; at: number }
export function planAlarmChecks(alarms: readonly Alarm[], now: number): { due: DueAlarm[]; delay: number | null } {
  if (!Number.isFinite(now)) throw new Error("alarm check requires a valid time");
  const due: DueAlarm[] = [];
  let next = Infinity;
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    const recent = nextFire(alarm, new Date(now - ALARM_WINDOW_MS));
    if (recent && recent.getTime() <= now) due.push({ alarm, at: recent.getTime() });
    const upcoming = nextFire(alarm, new Date(now));
    if (upcoming) next = Math.min(next, upcoming.getTime());
  }
  // Recheck at least once a minute for wall-clock/time-zone changes, but use
  // no repeating timer at all when no alarm is enabled.
  return { due, delay: Number.isFinite(next) ? Math.max(1, Math.min(ALARM_WINDOW_MS, next - now)) : null };
}
