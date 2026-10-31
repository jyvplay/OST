/** Acknowledgement/snooze state, separate from the recurring alarm schedule.
 * All instants are integer Unix milliseconds; snooze is elapsed wall time, not
 * a second recurring schedule. The bounded state contains no labels. */
import { ALARM_LIMIT, validateAlarm, type Alarm } from "./clock-core";
import { ALARM_WINDOW_MS } from "./clock-alarm-plan";

export const ACTIVITY_RETAIN_MS = 48 * 60 * 60 * 1000;
export interface AlarmActivity {
  alarmId: string;
  occurrenceAt: number;
  dueAt: number;
  sequence: number;
  schedule: string;
  stage: "ringing" | "snoozed" | "missed";
}
const validInstant = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
export const alarmSchedule = (alarm: Alarm) => JSON.stringify([alarm.time, [...alarm.days].sort()]);
export const activityToken = (activity: AlarmActivity) => `${activity.alarmId}@${activity.occurrenceAt}@${activity.dueAt}@${activity.sequence}`;

export function validateAlarmActivity(value: unknown): AlarmActivity[] {
  if (!Array.isArray(value) || value.length > ALARM_LIMIT) throw new Error("invalid alarm activity list");
  const out = value.map((item): AlarmActivity => {
    if (!item || typeof item !== "object") throw new Error("invalid alarm activity");
    const x = item as AlarmActivity;
    if (typeof x.alarmId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(x.alarmId) ||
      !validInstant(x.occurrenceAt) || !validInstant(x.dueAt) ||
      !Number.isSafeInteger(x.sequence) || x.sequence < 0 || x.sequence > 1_000_000 ||
      !["ringing", "snoozed", "missed"].includes(x.stage) || typeof x.schedule !== "string" || x.schedule.length > 96) {
      throw new Error("invalid alarm activity");
    }
    // Validate the signature as data, never as executable content.
    const parts: unknown = JSON.parse(x.schedule);
    if (!Array.isArray(parts) || parts.length !== 2) throw new Error("invalid alarm schedule signature");
    const alarm = validateAlarm({ id: x.alarmId, time: parts[0], days: parts[1], enabled: true, snoozeMin: 9 });
    if (alarmSchedule(alarm) !== x.schedule) throw new Error("noncanonical alarm schedule signature");
    return { alarmId: x.alarmId, occurrenceAt: x.occurrenceAt, dueAt: x.dueAt, sequence: x.sequence, schedule: x.schedule, stage: x.stage };
  });
  if (new Set(out.map((x) => x.alarmId)).size !== out.length) throw new Error("duplicate alarm activity");
  return out;
}

/** Removed/disabled/rescheduled alarms cancel their outstanding occurrence.
 * Label and snooze-length edits take effect without changing the wall schedule. */
export function reconcileAlarmActivity(entries: readonly AlarmActivity[], alarms: readonly Alarm[], now: number): AlarmActivity[] {
  if (!validInstant(now)) throw new Error("valid current time required");
  const byId = new Map(alarms.map((a) => [a.id, a]));
  return entries.filter((entry) => {
    const alarm = byId.get(entry.alarmId);
    return alarm?.enabled && alarmSchedule(alarm) === entry.schedule && now - entry.dueAt < ACTIVITY_RETAIN_MS;
  });
}

export function startAlarmActivity(entries: readonly AlarmActivity[], alarm: Alarm, at: number): AlarmActivity[] {
  if (!validInstant(at)) throw new Error("valid occurrence time required");
  if (!alarm.enabled) return [...entries];
  const previous = entries.find((x) => x.alarmId === alarm.id);
  // A late callback must never replace a newer occurrence or undo its snooze.
  if (previous && previous.occurrenceAt >= at && previous.schedule === alarmSchedule(alarm)) return [...entries];
  return validateAlarmActivity([...entries.filter((x) => x.alarmId !== alarm.id), {
    alarmId: alarm.id, occurrenceAt: at, dueAt: at, sequence: 0, schedule: alarmSchedule(alarm), stage: "ringing",
  }]);
}

export type AlarmActivityAction = "snooze" | "dismiss" | "ring" | "miss";
export function transitionAlarmActivity(entries: readonly AlarmActivity[], token: string, action: AlarmActivityAction, alarm: Alarm | undefined, now: number): AlarmActivity[] {
  if (!validInstant(now)) throw new Error("valid action time required");
  return entries.flatMap((entry) => {
    if (activityToken(entry) !== token) return [entry];
    if (!alarm?.enabled || alarm.id !== entry.alarmId || alarmSchedule(alarm) !== entry.schedule || action === "dismiss") return [];
    if (action === "snooze") {
      if (entry.stage === "snoozed" || entry.sequence >= 1_000_000) return [entry];
      const dueAt = now + alarm.snoozeMin * 60_000;
      // A backward clock change may precede the original occurrence. Keep the
      // new due time valid without forcing it to wait for that old instant.
      if (!validInstant(dueAt)) throw new Error("snooze exceeds the date range");
      return [{ ...entry, dueAt, sequence: entry.sequence + 1, stage: "snoozed" as const }];
    }
    if (entry.stage !== "snoozed" || now < entry.dueAt) return [entry];
    const late = now - entry.dueAt >= ALARM_WINDOW_MS;
    if (action === "ring" && !late) return [{ ...entry, stage: "ringing" as const }];
    if (action === "miss" && late) return [{ ...entry, stage: "missed" as const }];
    return [entry];
  });
}

export function planAlarmActivity(entries: readonly AlarmActivity[], now: number): { due: AlarmActivity[]; missed: AlarmActivity[]; delay: number | null } {
  if (!validInstant(now)) throw new Error("valid current time required");
  const due: AlarmActivity[] = [], missed: AlarmActivity[] = [];
  let next = Infinity;
  for (const entry of entries) {
    if (entry.stage !== "snoozed") continue;
    if (now >= entry.dueAt) (now - entry.dueAt < ALARM_WINDOW_MS ? due : missed).push(entry);
    else next = Math.min(next, entry.dueAt);
  }
  return { due, missed, delay: Number.isFinite(next) ? Math.max(1, Math.min(ALARM_WINDOW_MS, next - now)) : null };
}
