/**
 * TT146 (AU-03) — external automation entry points, with a door instead of a hole.
 *
 * The register's promise is that automation uses the same command vocabulary as
 * the UI, so anything scriptable is discoverable. The dangerous reading of that
 * promise is an endpoint that runs whatever it is sent: an endpoint on a
 * loopback server is reachable by any page the user visits (a form POST needs no
 * CORS permission), and "it is only localhost" has never been a security model.
 *
 * So the door has four parts, and each one is testable on its own:
 *
 *   1. **A bearer token that is never stored in the clear.** The server keeps
 *      `id` → SHA-256(secret). A database dump does not let anyone run commands,
 *      and the token itself is shown exactly once, at creation.
 *   2. **Scopes.** `run` may enqueue commands; `read` may only ask what the
 *      vocabulary is. A read-only token cannot escalate by sending `run`.
 *   3. **A rate limit per token**, because an automation loop that is buggy is
 *      indistinguishable from an attack, and the difference should be a 429
 *      rather than a wedged shell.
 *   4. **A queue the shell drains.** The server cannot press a button in the
 *      browser; it records the intent, and the shell executes it through the
 *      same executor the UI uses and reports the outcome back. A command that
 *      is never executed stays visibly `queued` instead of pretending it ran.
 *
 * Nothing here performs I/O; the route owns the database and the clock.
 */

import { ROUTINE_COMMANDS, validateActions, type RoutineAction } from "../routines";

export const TOKEN_PREFIX = "fsa1";
export const ID_LENGTH = 8;
export const SECRET_LENGTH = 43; // 32 bytes, base64url, no padding
export const MAX_ACTIONS = 30;
export const MAX_QUEUE_DEPTH = 50;

export type Scope = "run" | "read";
export const SCOPES: readonly Scope[] = ["run", "read"] as const;

export interface ParsedToken { id: string; secret: string }

const ID_RE = /^[0-9a-z]{8}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** Strict parse. A token that is almost right is not a token. */
export function parseToken(raw: string): ParsedToken | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(".");
  if (parts.length !== 3) return null;
  const [prefix, id, secret] = parts;
  if (prefix !== TOKEN_PREFIX || !ID_RE.test(id) || !SECRET_RE.test(secret)) return null;
  return { id, secret };
}

export interface MintedToken { token: string; id: string; secret: string }

/**
 * Mint from a caller-supplied random source (`crypto.randomBytes` in the route,
 * a deterministic function in tests). Rejection sampling is unnecessary: 32 bytes
 * base64url is uniform, and the id is drawn from the same source.
 */
export function mintToken(random: (bytes: number) => Uint8Array): MintedToken {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const idBytes = random(ID_LENGTH);
  if (idBytes.length !== ID_LENGTH) throw new Error("random source returned the wrong length");
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) id += alphabet[idBytes[i] % alphabet.length];
  const secret = base64url(random(32));
  return { token: `${TOKEN_PREFIX}.${id}.${secret}`, id, secret };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoaSafe(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function btoaSafe(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  // Node: the route hashes with node:crypto, but this module is also imported by
  // pure tests, so provide a tiny base64 that does not depend on the DOM.
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
    out += table[a >> 2];
    out += table[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b) ? "=" : table[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? "=" : table[c & 63];
  }
  return out;
}

/** Hex comparison that does not return early. Length mismatch is still false. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ scopes */

export function parseScopes(raw: unknown): Scope[] {
  if (!Array.isArray(raw)) return [];
  const out: Scope[] = [];
  for (const v of raw) {
    if (v === "run" || v === "read") { if (!out.includes(v)) out.push(v); }
  }
  return out;
}

export function hasScope(scopes: readonly Scope[], need: Scope): boolean {
  return scopes.includes(need);
}

/* ------------------------------------------------------------------ rate limit */

export interface RateLimitState { count: number; windowStart: number }

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the window resets, 0 when allowed. */
  retryAfterMs: number;
  state: RateLimitState;
}

/**
 * Fixed-window limiter. A sliding window is nicer and needs a queue of
 * timestamps; for "30 runs a minute" the difference is not worth the memory.
 * The window is anchored at the first request, not at the wall clock, so a
 * caller cannot get two full budgets by firing across a minute boundary.
 */
export function takeToken(
  state: RateLimitState | null,
  at: number,
  limit: number,
  windowMs: number,
): RateDecision {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be a positive integer");
  if (!state || at - state.windowStart >= windowMs || at < state.windowStart) {
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0, state: { count: 1, windowStart: at } };
  }
  if (state.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterMs: windowMs - (at - state.windowStart), state };
  }
  const next = { count: state.count + 1, windowStart: state.windowStart };
  return { allowed: true, remaining: limit - next.count, retryAfterMs: 0, state: next };
}

/* ------------------------------------------------------------------ requests */

export interface CommandRequest { actions: RoutineAction[] }

export type RequestError = { field: string; message: string };

/**
 * Validate an enqueue request. `commands` is the friendlier spelling and
 * `actions` matches the routine engine; exactly one is honoured, and a request
 * that sends both is refused rather than guessed at.
 */
export function validateRequest(body: Record<string, unknown>): { ok: true; request: CommandRequest } | { ok: false; errors: RequestError[] } {
  const errors: RequestError[] = [];
  const hasActions = body.actions !== undefined;
  const hasCommands = body.commands !== undefined;
  if (hasActions && hasCommands) errors.push({ field: "actions", message: "send actions or commands, not both" });
  const raw = hasActions ? body.actions : body.commands;
  if (raw === undefined) errors.push({ field: "actions", message: "actions are required" });
  if (errors.length) return { ok: false, errors };

  // A `commands` body may be a shorthand string ("open files; tile left").
  let list: unknown = raw;
  if (typeof raw === "string") {
    list = raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [cmd, ...rest] = s.split(/\s+/);
      return { cmd, arg: rest.length ? rest.join(" ") : undefined };
    });
  }
  if (!Array.isArray(list)) return { ok: false, errors: [{ field: "actions", message: "actions must be an array or a command string" }] };
  if (list.length === 0) return { ok: false, errors: [{ field: "actions", message: "at least one action is required" }] };
  if (list.length > MAX_ACTIONS) return { ok: false, errors: [{ field: "actions", message: `at most ${MAX_ACTIONS} actions per request` }] };
  try {
    return { ok: true, request: { actions: validateActions(list) } };
  } catch (e) {
    return { ok: false, errors: [{ field: "actions", message: (e as Error).message }] };
  }
}

/** The discovery document a script reads before it tries anything. */
export function vocabulary() {
  return {
    version: 1,
    commands: ROUTINE_COMMANDS,
    limits: { actions: MAX_ACTIONS, queue: MAX_QUEUE_DEPTH },
    scopes: SCOPES,
    note: "Commands are executed by the open Fusion shell through the same executor the UI uses. Queued work does not run while no shell window is open.",
  };
}

/* ------------------------------------------------------------------ queue */

export type RunStatus = "queued" | "done" | "failed";

export interface QueuedRun {
  id: number;
  tokenId: string;
  actions: RoutineAction[];
  status: RunStatus;
  createdAt: number;
  finishedAt: number | null;
  /** Reported by the shell; never inferred by the server. */
  result: string;
}

export function queueDepth(runs: readonly QueuedRun[]): number {
  return runs.filter((r) => r.status === "queued").length;
}

export function canEnqueue(runs: readonly QueuedRun[]): boolean {
  return queueDepth(runs) < MAX_QUEUE_DEPTH;
}

/** Terminal statuses are terminal: a late "done" for a failed run does not rewrite history. */
export function settle(run: QueuedRun, ok: boolean, result: string, at: number): QueuedRun {
  if (run.status !== "queued") return run;
  return { ...run, status: ok ? "done" : "failed", result: result.slice(0, 500), finishedAt: at };
}
