/** Local, non-secret status for the most recent user-selected backup drill. */
export const DRILL_HEALTH_KEY = "fusion.backup.drill-health.v1";
export type DrillOutcome = "passed" | "partial" | "failed";
export type DrillKind = "data" | "config" | "unknown";
export interface DrillAttempt {
  at: string;
  outcome: DrillOutcome;
  kind: DrillKind;
  files: number;
  folders: number;
  notes: number;
  settings: number;
}
export interface DrillHealth { version: 1; lastAttempt: DrillAttempt; lastSuccess: string | null }
export type HealthState = "never" | "passed" | "partial" | "failed" | "due" | "clock";

const validIso = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1970 || year > 9998) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
};
const boundedCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 10_000;

/** Discard malformed, future-version and unexpected fields; never store a file name, checksum, secret or contents. */
export function parseDrillHealth(raw: string | null): DrillHealth | null {
  try {
    const x = JSON.parse(raw ?? "null");
    if (!x || x.version !== 1 || !x.lastAttempt || !validIso(x.lastAttempt.at)
      || !["passed", "partial", "failed"].includes(x.lastAttempt.outcome)
      || !["data", "config", "unknown"].includes(x.lastAttempt.kind)
      || ![x.lastAttempt.files, x.lastAttempt.folders, x.lastAttempt.notes, x.lastAttempt.settings].every(boundedCount)
      || !(x.lastSuccess === null || validIso(x.lastSuccess))) return null;
    return { version: 1, lastAttempt: { at: x.lastAttempt.at, outcome: x.lastAttempt.outcome, kind: x.lastAttempt.kind,
      files: x.lastAttempt.files, folders: x.lastAttempt.folders, notes: x.lastAttempt.notes, settings: x.lastAttempt.settings }, lastSuccess: x.lastSuccess };
  } catch { return null; }
}

/** Next calendar month in UTC, clamping e.g. January 31 to February 28/29. */
export function nextDrillDate(iso: string): string {
  const d = new Date(iso);
  if (!validIso(iso)) throw new Error("Invalid drill date");
  const year = d.getUTCFullYear(), month = d.getUTCMonth();
  const nextLastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return new Date(Date.UTC(year, month + 1, Math.min(d.getUTCDate(), nextLastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())).toISOString();
}

/** Failure/partial always outrank a previous success; a future timestamp is not healthy. */
export function drillHealthState(health: DrillHealth | null, now: number): { state: HealthState; dueAt: string | null } {
  if (!health) return { state: "never", dueAt: null };
  if (!validIso(health.lastAttempt.at) || (health.lastSuccess !== null && !validIso(health.lastSuccess))) return { state: "clock", dueAt: null };
  const attemptTime = Date.parse(health.lastAttempt.at);
  const successTime = health.lastSuccess === null ? null : Date.parse(health.lastSuccess);
  if (!Number.isFinite(now) || !Number.isFinite(attemptTime) || (successTime !== null && !Number.isFinite(successTime))
    || attemptTime > now + 300_000 || (successTime !== null && (successTime > now + 300_000 || successTime > attemptTime + 300_000))
    || (health.lastAttempt.outcome === "passed" && health.lastSuccess !== health.lastAttempt.at)) return { state: "clock", dueAt: null };
  const dueAt = health.lastSuccess ? nextDrillDate(health.lastSuccess) : null;
  if (health.lastAttempt.outcome !== "passed") return { state: health.lastAttempt.outcome, dueAt };
  if (!dueAt || now >= Date.parse(dueAt)) return { state: "due", dueAt };
  return { state: "passed", dueAt };
}

/** A failure never erases the last successful drill date. */
export function recordDrill(previous: DrillHealth | null, attempt: DrillAttempt): DrillHealth {
  return { version: 1, lastAttempt: attempt, lastSuccess: attempt.outcome === "passed" ? attempt.at : previous?.lastSuccess ?? null };
}
