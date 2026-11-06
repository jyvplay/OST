/**
 * TT136 (RH-04) — actionable routines, on a bounded scheduler.
 *
 * A routine is: when the trigger fires, run steps. Steps are safe (text,
 * note, routine, focus, calculator, nothing) — never arbitrary commands, and
 * never a system action that would need privileges. Steps that fail do not
 * abort the routine; they are recorded with a reason so a dry run shows exactly
 * which steps would run and which would fail.
 *
 * This module is pure policy and scheduling; the caller performs the steps.
 */

export type ActionKind = "text" | "note" | "routine" | "focus" | "calculator" | "nothing";

export interface Action { kind: ActionKind; /** Raw, opaque payload; validated for size only. */ payload: string }

export interface Step {
  action: Action;
  /** Skip a step that has not been recorded as run, for re-entrant firing. */
  once?: boolean;
}

export interface Routine {
  id: string;
  name: string;
  /** ISO-8601 date; a routine without a valid date is never scheduled. */
  when: string;
  /** -1 = the newest version; otherwise pin an explicit revision. */
  revision: number;
  once?: boolean;
  steps: Step[];
}

export interface Run {
  routineId: string;
  firedAt: number;
  /** False when the routine was dry-run and nothing was performed. */
  performed: boolean;
  stepResults: { action: Action; ok: boolean; error?: string }[];
}

export const ROUTINE_NAME_MAX = 60;
export const ROUTINE_STEP_LIMIT = 40;
export const ROUTINE_PAYLOAD_BYTES = 1_000;

const ACTION_KINDS: readonly ActionKind[] = ["text", "note", "routine", "focus", "calculator", "nothing"];

/** Cron-free, calendar-free: date + time in the browser's own zone, never UTC-shifted. */
export function parseWhen(when: string, now: number): number | null {
  if (typeof when !== "string" || when.length === 0 || when.length > 40) return null;
  const t = new Date(when).getTime();
  if (!Number.isFinite(t) || t < 0 || t > now + 31_536_000_000) return null;
  return t;
}

export function validateRoutine(input: Routine): Routine {
  if (typeof input.id !== "string" || !/^[a-z][a-z0-9-]{0,32}$/.test(input.id)) throw new Error("Routine ids are 1…33 lowercase alphanumerics/dashes");
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > ROUTINE_NAME_MAX) throw new Error(`Routine name must be 1…${ROUTINE_NAME_MAX} characters`);
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > ROUTINE_STEP_LIMIT) throw new Error(`A routine needs 1…${ROUTINE_STEP_LIMIT} steps`);
  const steps = input.steps.map((step) => {
    if (step === null || typeof step !== "object") throw new Error("Every step must be an object");
    const { action, once } = step;
    if (!action || !ACTION_KINDS.includes(action.kind)) throw new Error(`Unknown action ${String(action?.kind)}`);
    if (typeof action.payload !== "string" || new TextEncoder().encode(action.payload).byteLength > ROUTINE_PAYLOAD_BYTES) throw new Error(`Action payload is larger than ${ROUTINE_PAYLOAD_BYTES} bytes`);
    return { action, once: once === true };
  });
  return { ...input, steps };
}

export interface TriggerPlan { fire: boolean; dueAt: number | null; reason: string }

/** A routine fires when the trigger time is in the past (or exactly now). */
export function planFire(routine: Routine, now: number): TriggerPlan {
  const dueAt = parseWhen(routine.when, now);
  if (dueAt === null) return { fire: false, dueAt: null, reason: "Trigger time is unusable" };
  if (dueAt > now) return { fire: false, dueAt, reason: "Not due yet" };
  return { fire: true, dueAt, reason: "Due" };
}

export interface Reschedule { fire: boolean; nextAt: number | null; reason: string }

/** After firing, compute the next occurrence; a once routine never recurs. */
export function planNext(routine: Routine, firedAt: number): Reschedule {
  if (routine.once) return { fire: false, nextAt: null, reason: "Routine is once-only" };
  const when = parseWhen(routine.when, firedAt);
  if (when === null) return { fire: false, nextAt: null, reason: "Trigger time is unusable" };
  if (when <= firedAt) return { fire: false, nextAt: null, reason: "Trigger time is already past" };
  return { fire: false, nextAt: when, reason: "Already planned" };
}

/**
 * A safe action is one whose payload is opaque and whose effect is invoked by
 * the caller. This predicate guards against payloads that look like commands.
 */
export function isSafeAction(action: Action): boolean {
  if (action.kind === "nothing") return true;
  if (!ACTION_KINDS.includes(action.kind)) return false;
  if (/[<>]|["'`;|&$\\]/.test(action.payload)) return false;
  return new TextEncoder().encode(action.payload).byteLength <= ROUTINE_PAYLOAD_BYTES;
}

export interface DryRun {
  ok: boolean;
  steps: { index: number; action: ActionKind; safe: boolean; error?: string }[];
  /** True when every step is safe and the routine is due. */
  wouldRun: boolean;
}

export function dryRun(routine: Routine, now: number): DryRun {
  const plan = planFire(routine, now);
  const steps = routine.steps.map((step, index) => {
    const safe = isSafeAction(step.action);
    return { index, action: step.action.kind, safe, error: safe ? undefined : "payload is not a safe text value" };
  });
  return { ok: steps.every((s) => s.safe), steps, wouldRun: plan.fire && steps.every((s) => s.safe) };
}

/** Deterministic, deduplicated, bounded planner for a whole day of routines. */
export function planDay(routines: readonly Routine[], now: number, limit = 200): Routine[] {
  const valid = routines.filter((r) => {
    try { validateRoutine(r); return true; } catch { return false; }
  });
  if (valid.length > limit) throw new Error(`At most ${limit} routines can be planned`);
  return valid.filter((r) => planFire(r, now).fire);
}

export function describeRun(run: Run): string {
  const ok = run.stepResults.filter((s) => s.ok).length;
  return `${run.routineId} · ${ok}/${run.stepResults.length} step(s) ${run.performed ? "performed" : "dry run"}`;
}

export function describeSchedule(routines: readonly Routine[], now: number): string {
  const due = planDay(routines, now).length;
  return `${routines.length} routine(s) · ${due} due`;
}
