/**
 * TT139 (AU-03 / AU-01) — the automation entry point, and the dry run in front of it.
 *
 * A routine is a trigger plus a list of actions. Letting anything (a URL, another
 * tab, a pasted snippet) run actions is how local-first apps become remote-code
 * execution, so the entry surface is one narrow door:
 *
 *   - `parseAutomationRequest` accepts **only** a fixed JSON shape with a named
 *     routine and typed arguments, no free-form step list;
 *   - every request is *planned* first (`dryRun`), producing exactly what would
 *     happen, which the caller shows before committing;
 *   - a request with a step the shell does not have, an argument of the wrong
 *     type, or more than the action budget is refused with the reason — never
 *     partially executed;
 *   - this local planner can check a single-use, expiring token supplied in a
 *     pasted request. The pasted origin is not authenticated and this planner
 *     is not an inbound endpoint or a cross-origin security boundary.
 *
 * Limits: this is a *local* seam. There is no inbound webhook server, no
 * scheduling across restarts unless the shell persists it, and no shell command
 * execution — actions are the shell's own commands.
 */

export interface ActionSpec { command: string; args: Record<string, unknown> }
export interface Routine { id: string; name: string; trigger: "manual" | "schedule" | "event"; actions: ActionSpec[]; enabled: boolean }

export interface AutomationRequest { routineId: string; args: Record<string, string | number | boolean>; token?: string; origin?: string }

export const MAX_ACTIONS = 24;
export const MAX_ARG_BYTES = 2048;

export function parseAutomationRequest(raw: unknown): { ok: true; request: AutomationRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "a request must be a JSON object" };
  const r = raw as Record<string, unknown>;
  const routineId = typeof r.routineId === "string" ? r.routineId.trim() : "";
  if (!routineId) return { ok: false, error: "routineId is required" };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(routineId)) return { ok: false, error: "routineId may only contain letters, digits, dot, dash and underscore" };
  const argsIn = r.args === undefined ? {} : r.args;
  if (!argsIn || typeof argsIn !== "object" || Array.isArray(argsIn)) return { ok: false, error: "args must be an object" };
  const args: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(argsIn as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) return { ok: false, error: `argument name “${key}” is not allowed` };
    if (typeof value === "string") {
      if (new TextEncoder().encode(value).length > MAX_ARG_BYTES) return { ok: false, error: `argument “${key}” is longer than ${MAX_ARG_BYTES} bytes` };
      args[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) args[key] = value;
    else if (typeof value === "boolean") args[key] = value;
    else return { ok: false, error: `argument “${key}” must be a string, a finite number or a boolean` };
  }
  return { ok: true, request: { routineId, args, token: typeof r.token === "string" ? r.token : undefined, origin: typeof r.origin === "string" ? r.origin : undefined } };
}

export interface DryRunStep { index: number; command: string; describe: string; wouldChange: string[]; blocked: string | null }

/**
 * Plan a routine without running it. `schema` maps a command to its allowed
 * argument names and whether it mutates anything; an unknown command blocks the
 * whole plan (a routine that half-runs is worse than one that refuses).
 */
export function dryRun(routine: Routine, schema: Record<string, { args: readonly string[]; mutates: boolean; required?: readonly string[] }>): { steps: DryRunStep[]; executable: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!routine.enabled) problems.push("the routine is disabled");
  if (!routine.actions.length) problems.push("the routine has no actions");
  if (routine.actions.length > MAX_ACTIONS) problems.push(`a routine may contain at most ${MAX_ACTIONS} actions (this one has ${routine.actions.length})`);
  const steps: DryRunStep[] = routine.actions.map((action, index) => {
    const spec = schema[action.command];
    if (!spec) { problems.push(`unknown command “${action.command}”`); return { index, command: action.command, describe: "refused", wouldChange: [], blocked: "unknown command" }; }
    const unexpected = Object.keys(action.args).filter((k) => !spec.args.includes(k));
    if (unexpected.length) { problems.push(`“${action.command}” does not take ${unexpected.map((u) => `“${u}”`).join(", ")}`); return { index, command: action.command, describe: "refused", wouldChange: [], blocked: "bad arguments" }; }
    // A missing required argument is a refusal: guessing a default would run a
    // routine against a path or a value the author never chose.
    const missing = (spec.required ?? []).filter((k) => !(k in action.args));
    if (missing.length) { problems.push(`“${action.command}” needs ${missing.map((m) => `“${m}”`).join(", ")}`); return { index, command: action.command, describe: "refused", wouldChange: [], blocked: "missing argument" }; }
    return {
      index,
      command: action.command,
      describe: describeAction(action.command, action.args),
      wouldChange: spec.mutates ? [`${action.command} writes`] : [],
      blocked: null,
    };
  });
  return { steps, executable: problems.length === 0, problems };
}

function describeAction(command: string, args: Record<string, unknown>): string {
  const pairs = Object.entries(args).map(([k, v]) => `${k}=${String(v)}`);
  return pairs.length ? `${command} (${pairs.join(", ")})` : command;
}

/**
 * Local planner tokens, bound to a routine and consumed on successful check.
 * They are not credentials for the separate server automation API.
 */
export interface EntryToken { value: string; routineId: string; expiresAt: number; used: boolean }

export function issueToken(routineId: string, now: number, ttlMs = 60_000): EntryToken {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const value = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { value, routineId, expiresAt: now + Math.max(1000, Math.min(ttlMs, 600_000)), used: false };
}

export function redeemToken(token: EntryToken | undefined, presented: string | undefined, routineId: string, now: number): { ok: boolean; error: string | null } {
  if (!token || !presented) return { ok: false, error: "a planner token is required" };
  if (token.used) return { ok: false, error: "that token has already been used" };
  if (token.routineId !== routineId) return { ok: false, error: "the token was issued for a different routine" };
  if (!Number.isFinite(now) || !Number.isFinite(token.expiresAt) || now >= token.expiresAt) return { ok: false, error: "the token has expired" };
  if (presented !== token.value) return { ok: false, error: "the token does not match" };
  token.used = true;
  return { ok: true, error: null };
}
