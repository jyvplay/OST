/**
 * TT139 (PR-10, CK-01) — Clock, timer, stopwatch, and recurring alarms.
 *
 * Pure state machine. No setInterval, no Date.now(): the caller supplies `now`
 * on every tick. That is what makes a timer testable at all — you can run a
 * 24-hour countdown to completion in microseconds and assert the exact value,
 * instead of sleeping and hoping.
 *
 * Design decisions worth stating:
 *   • `elapsed` is the single source of truth for a stopwatch; `laps` is a
 *     derived list of split times. Lap splits are computed at read time from
 *     the cumulative list, so a lap recorded while paused cannot drift.
 *   • A timer that reaches its duration latches `alarmed` and stops. It does
 *     not silently wrap. `resetClock` clears the latch.
 *   • Drift: a tick takes `now - lastTick`, so a browser that suspends the tab
 *     for 30 s still shows 30 s of elapsed time on resume. The engine never
 *     assumes a fixed tick interval.
 *   • A monotonic clock is NOT required; going backwards is clamped to 0
 *     rather than producing negative elapsed time.
 *
 * CK-01 adds recurring alarms: daily and weekly schedules, snooze, and a
 * bounded fire log. Schedules are computed in local wall-clock terms from an
 * injected timezone offset in minutes, so the module stays pure.
 */

export type ClockKind = "clock" | "timer" | "stopwatch";

export interface ClockState {
  kind: ClockKind;
  /** Milliseconds counted up (stopwatch/clock) or down-consumed (timer). */
  elapsed: number;
  /** Timer target in ms. Absent for clock/stopwatch. */
  duration?: number;
  running: boolean;
  /** Cumulative elapsed at each lap press, in order. */
  lapTimes: number[];
  /** Set when a timer reaches zero; cleared by reset. */
  alarmed: boolean;
}

export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_LAPS = 100;

export function createClock(kind: ClockKind, duration?: number): ClockState {
  if (kind === "timer") {
    if (duration === undefined) throw new Error("A timer needs a duration");
    if (!(duration > 0)) throw new Error("Timer duration must be positive");
    if (duration > MAX_DURATION_MS) throw new Error(`Timer duration capped at 24 h (${MAX_DURATION_MS} ms)`);
    return { kind, elapsed: 0, duration, running: false, lapTimes: [], alarmed: false };
  }
  return { kind, elapsed: 0, running: false, lapTimes: [], alarmed: false };
}

export function startClock(s: ClockState): ClockState {
  if (s.running) return s;
  // Restarting an alarmed timer would fire again immediately; require reset.
  if (s.kind === "timer" && s.alarmed) return s;
  return { ...s, running: true };
}

export function pauseClock(s: ClockState): ClockState {
  return s.running ? { ...s, running: false } : s;
}

export function toggleClock(s: ClockState): ClockState {
  return s.running ? pauseClock(s) : startClock(s);
}

/**
 * Advance by `now - lastTick`. Caller passes the previous tick's timestamp.
 * Going backwards in time is clamped to zero delta, never negative elapsed.
 */
export function tickClock(s: ClockState, now: number, lastTick: number): ClockState {
  if (!s.running) return s;
  if (!Number.isFinite(now) || !Number.isFinite(lastTick)) throw new Error("Tick needs finite timestamps");
  const delta = Math.max(0, now - lastTick);
  if (delta === 0) return s;

  if (s.kind === "timer") {
    const target = s.duration ?? 0;
    const next = s.elapsed + delta;
    if (next >= target) {
      return { ...s, elapsed: target, running: false, alarmed: true };
    }
    return { ...s, elapsed: next };
  }
  return { ...s, elapsed: s.elapsed + delta };
}

export function lapClock(s: ClockState): ClockState {
  if (!s.running) return s;
  if (s.lapTimes.length >= MAX_LAPS) return s;
  return { ...s, lapTimes: [...s.lapTimes, s.elapsed] };
}

export function resetClock(s: ClockState): ClockState {
  return { ...s, elapsed: 0, running: false, lapTimes: [], alarmed: false };
}

export function setTimerDuration(s: ClockState, duration: number): ClockState {
  if (s.kind !== "timer") throw new Error("Only a timer has a duration");
  if (!(duration > 0)) throw new Error("Duration must be positive");
  if (duration > MAX_DURATION_MS) throw new Error("Duration capped at 24 hours");
  return { ...s, duration, elapsed: 0, alarmed: false, running: false, lapTimes: [] };
}

/** Add `delta` ms to a running timer (the "+1 minute" affordance). */
export function extendTimer(s: ClockState, delta: number): ClockState {
  if (s.kind !== "timer") throw new Error("Only a timer can be extended");
  const target = (s.duration ?? 0) + delta;
  if (!(target > 0)) throw new Error("Extending would make the duration non-positive");
  if (target > MAX_DURATION_MS) throw new Error("Duration capped at 24 hours");
  const alarmed = s.alarmed && s.elapsed < target ? false : s.alarmed;
  return { ...s, duration: target, alarmed, running: alarmed ? false : s.running };
}

/** Remaining ms for a timer; 0 for other kinds. */
export function timerRemaining(s: ClockState): number {
  if (s.kind !== "timer") return 0;
  return Math.max(0, (s.duration ?? 0) - s.elapsed);
}

/** 0..1 for a timer; 1 for other kinds. */
export function timerProgress(s: ClockState): number {
  if (s.kind !== "timer" || !s.duration) return 1;
  return Math.min(1, Math.max(0, s.elapsed / s.duration));
}

/**
 * "h:mm:ss.cc" when there is an hour component, "m:ss.cc" otherwise.
 * Negative input is formatted as-is with a leading minus rather than clamped,
 * because a negative value indicates a caller bug worth seeing.
 */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error("formatTime needs a finite number");
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const total = Math.floor(abs);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const sec = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  const tail = `${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  if (h > 0) return `${sign}${h}:${String(m).padStart(2, "0")}:${tail}`;
  return `${sign}${m}:${tail}`;
}

/** Split per lap (not cumulative). First lap split is measured from zero. */
export function getLapDiffs(s: ClockState): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const t of s.lapTimes) {
    out.push(t - prev);
    prev = t;
  }
  return out;
}

export function getFastestLap(s: ClockState): { index: number; ms: number } | null {
  const diffs = getLapDiffs(s);
  if (!diffs.length) return null;
  let best = 0;
  for (let i = 1; i < diffs.length; i++) if (diffs[i] < diffs[best]) best = i;
  return { index: best, ms: diffs[best] };
}

export function getSlowestLap(s: ClockState): { index: number; ms: number } | null {
  const diffs = getLapDiffs(s);
  if (!diffs.length) return null;
  let worst = 0;
  for (let i = 1; i < diffs.length; i++) if (diffs[i] > diffs[worst]) worst = i;
  return { index: worst, ms: diffs[worst] };
}

// ══ CK-01: recurring alarms ══════════════════════════════════════════════

export type Recurrence =
  | { kind: "once"; at: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; hour: number; minute: number; days: number[] };

export interface Alarm {
  id: string;
  label: string;
  recurrence: Recurrence;
  enabled: boolean;
  /** Next scheduled fire time in epoch ms, or null when disabled/finished. */
  nextAt: number | null;
  /** Snoozed until this epoch ms, if set. */
  snoozedUntil?: number;
  /** Fires completed. */
  fireCount: number;
}

export interface AlarmState {
  alarms: Alarm[];
  /** Bounded log of recent fire events, newest last. */
  log: Array<{ id: string; label: string; at: number }>;
}

export const MAX_ALARM_LOG = 200;

export function createAlarmState(): AlarmState {
  return { alarms: [], log: [] };
}

const DAY_MS = 86400000;

/**
 * Compute the next fire time strictly after `after`.
 * `tzOffsetMinutes` is the local offset from UTC in minutes (e.g. -300 for
 * UTC-5). Durations are handled in UTC and then shifted, so a DST transition
 * cannot make an alarm skip or double-fire within one schedule computation.
 */
export function nextFireTime(rec: Recurrence, after: number, tzOffsetMinutes = 0): number | null {
  if (rec.kind === "once") return rec.at > after ? rec.at : null;

  if (rec.kind === "daily") {
    if (rec.hour < 0 || rec.hour > 23) throw new Error(`Hour out of range: ${rec.hour}`);
    if (rec.minute < 0 || rec.minute > 59) throw new Error(`Minute out of range: ${rec.minute}`);
    const offset = tzOffsetMinutes * 60000;
    const local = after + offset;
    const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
    let candidate = dayStart + rec.hour * 3600000 + rec.minute * 60000 - offset;
    if (candidate <= after) candidate += DAY_MS;
    return candidate;
  }

  if (rec.kind === "weekly") {
    if (!rec.days.length) return null;
    for (const d of rec.days) {
      if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error(`Weekday out of range: ${d}`);
    }
    const offset = tzOffsetMinutes * 60000;
    const local = after + offset;
    const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
    const todayDow = new Date(dayStart).getUTCDay();
    // Search forward up to 8 days so "today, already passed" rolls a week.
    for (let add = 0; add <= 7; add++) {
      const dow = (todayDow + add) % 7;
      if (!rec.days.includes(dow)) continue;
      const candidate = dayStart + add * DAY_MS + rec.hour * 3600000 + rec.minute * 60000 - offset;
      if (candidate > after) return candidate;
    }
    return null;
  }
  return null;
}

export function addAlarm(
  state: AlarmState,
  alarm: { id: string; label: string; recurrence: Recurrence; enabled?: boolean },
  now: number,
  tzOffsetMinutes = 0,
): AlarmState {
  if (!alarm.id) throw new Error("Alarm needs an id");
  if (state.alarms.some((a) => a.id === alarm.id)) throw new Error(`Alarm id already exists: ${alarm.id}`);
  if (alarm.label.length > 120) throw new Error("Alarm label too long (>120)");
  const enabled = alarm.enabled ?? true;
  const next = enabled ? nextFireTime(alarm.recurrence, now, tzOffsetMinutes) : null;
  return {
    ...state,
    alarms: [...state.alarms, { id: alarm.id, label: alarm.label, recurrence: alarm.recurrence, enabled, nextAt: next, fireCount: 0 }],
  };
}

export function setAlarmEnabled(state: AlarmState, id: string, enabled: boolean, now: number, tz = 0): AlarmState {
  return {
    ...state,
    alarms: state.alarms.map((a) =>
      a.id !== id
        ? a
        : { ...a, enabled, nextAt: enabled ? nextFireTime(a.recurrence, now, tz) : null, snoozedUntil: enabled ? a.snoozedUntil : undefined },
    ),
  };
}

export function removeAlarm(state: AlarmState, id: string): AlarmState {
  return { ...state, alarms: state.alarms.filter((a) => a.id !== id) };
}

export interface FireResult {
  state: AlarmState;
  fired: Array<{ id: string; label: string; at: number }>;
}

/**
 * Fire every alarm whose next time has passed, exactly once each.
 * A daily alarm advances by one schedule step, so a device that was asleep for
 * three days fires once (not three times) and then reschedules from `now`.
 */
export function fireDueAlarms(state: AlarmState, now: number, tz = 0): FireResult {
  const fired: FireResult["fired"] = [];
  const alarms = state.alarms.map((a) => {
    if (!a.enabled) return a;
    const due = a.snoozedUntil ?? a.nextAt;
    if (due === null || due > now) return a;
    fired.push({ id: a.id, label: a.label, at: due });
    const next = a.recurrence.kind === "once" ? null : nextFireTime(a.recurrence, now, tz);
    return {
      ...a,
      snoozedUntil: undefined,
      nextAt: next,
      enabled: a.recurrence.kind === "once" ? false : a.enabled,
      fireCount: a.fireCount + 1,
    };
  });
  const log = [...state.log, ...fired].slice(-MAX_ALARM_LOG);
  return { state: { alarms, log }, fired };
}

export function snoozeAlarm(state: AlarmState, id: string, minutes: number, now: number): AlarmState {
  if (!(minutes > 0)) throw new Error("Snooze must be a positive number of minutes");
  if (minutes > 24 * 60) throw new Error("Snooze capped at 24 hours");
  return {
    ...state,
    alarms: state.alarms.map((a) =>
      a.id !== id ? a : { ...a, snoozedUntil: now + minutes * 60000, enabled: true },
    ),
  };
}

export function upcomingAlarms(state: AlarmState, limit = 10): Alarm[] {
  return state.alarms
    .filter((a) => a.enabled && (a.snoozedUntil ?? a.nextAt) !== null)
    .sort((a, b) => (a.snoozedUntil ?? a.nextAt ?? 0) - (b.snoozedUntil ?? b.nextAt ?? 0))
    .slice(0, limit);
}

export function describeClock(s: ClockState): string {
  const label = s.kind === "timer" ? "Timer" : s.kind === "stopwatch" ? "Stopwatch" : "Clock";
  if (s.kind === "timer") {
    const pct = Math.round(timerProgress(s) * 100);
    return `${label} ${s.running ? "running" : s.alarmed ? "alarmed" : "idle"} — ${formatTime(timerRemaining(s))} left (${pct}%)`;
  }
  return `${label} ${s.running ? "running" : "idle"} — ${formatTime(s.elapsed)}${s.lapTimes.length ? ` · ${s.lapTimes.length} laps` : ""}`;
}
