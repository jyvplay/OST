/**
 * TT143 (FM-18) — the safe-save contract as an explicit state machine.
 *
 * The contract is four steps: write a **session copy**, write a **temp** file,
 * **validate** it, then **atomically replace** the target. The point of writing it
 * as a machine rather than as a sequence of `if`s in a component is that the
 * interesting behaviour is what happens when a step fails — and that behaviour is
 * different at every step:
 *
 *   · failing before the temp exists leaves the target untouched (nothing to undo);
 *   · failing during validation leaves the temp behind, and the target untouched —
 *     the temp must be removed, not "cleaned up later";
 *   · failing during the replace is the only case where the target can be gone,
 *     which is why the old content is still in the session copy at that moment;
 *   · a crash (no `fail` call at all) is indistinguishable from a mid-write stop,
 *     so the recovery rule is: on boot, a temp with no session copy is discarded,
 *     and a session copy with no matching target content is offered back.
 *
 * The machine is pure, so a test can inject a crash at every step and assert the
 * recovery. `validate` is a predicate the caller supplies (byte length, digest,
 * a parse), because this engine must not know what a valid document is.
 */

export type Phase = "idle" | "session-copy" | "temp-written" | "validated" | "replaced" | "failed";
export interface SafeSaveState {
  phase: Phase;
  target: string;
  temp: string;
  bytes: number;
  /** The measured result of the caller's validator; null when it did not run. */
  valid: boolean | null;
  error: string | null;
  /** What recovery will do if the process stops here. Documented, not guessed. */
  recovery: string;
}

export const begin = (target: string, bytes: number): SafeSaveState => ({
  phase: "session-copy", target, temp: `${target}.tmp`, bytes, valid: null, error: null,
  recovery: "a stop now leaves the target untouched; nothing to undo",
});

export function afterSessionCopy(s: SafeSaveState, copiedBytes: number): SafeSaveState {
  if (s.phase !== "session-copy") return fail(s, `the session copy step ran in phase “${s.phase}”`);
  if (copiedBytes !== s.bytes) return fail({ ...s, phase: "failed" }, `the session copy is ${copiedBytes} bytes for a ${s.bytes}-byte body`);
  return { ...s, phase: "temp-written", recovery: "a stop now leaves the target untouched and a temp file behind; boot discards it" };
}

export function afterValidate(s: SafeSaveState, valid: boolean, reason?: string): SafeSaveState {
  if (s.phase !== "temp-written") return fail(s, `validation ran in phase “${s.phase}”`);
  if (!valid) {
    return {
      ...s, phase: "failed", valid: false, error: reason ?? "the written file did not validate",
      recovery: "the temp file is removed and the target is untouched",
    };
  }
  return { ...s, phase: "validated", valid: true, recovery: "a stop now leaves a validated temp and an untouched target; boot can replace or discard" };
}

export function afterReplace(s: SafeSaveState): SafeSaveState {
  if (s.phase !== "validated") return fail(s, `the replace step ran before validation (phase “${s.phase}”)`);
  return { ...s, phase: "replaced", recovery: "the target holds the new bytes; the session copy may be dropped" };
}

export function fail(s: SafeSaveState, why: string): SafeSaveState {
  return { ...s, phase: "failed", error: why, recovery: s.phase === "validated" || s.phase === "replaced" ? "the target already holds the new bytes" : "the target is untouched" };
}

export type Recovery = { action: "discard-temp" | "offer-session-copy" | "nothing" | "replace-from-temp"; why: string };

/**
 * What to do on boot about a target that has a temp and/or a session copy. The
 * rule is deliberately conservative: the target is never overwritten from a temp
 * that was not validated in this process, because a half-written temp is
 * indistinguishable from a complete one by size alone.
 */
export function recover(input: { hasTemp: boolean; hasSessionCopy: boolean; targetBytes: number | null; sessionBytes: number | null }): Recovery {
  if (input.hasTemp && !input.hasSessionCopy) return { action: "discard-temp", why: "a temp file with no session copy is an interrupted write; there is nothing to offer back" };
  if (input.hasSessionCopy && input.targetBytes === null) return { action: "offer-session-copy", why: "the target is missing and a session copy exists: offer it, do not restore it silently" };
  if (input.hasSessionCopy && input.sessionBytes !== null && input.targetBytes !== input.sessionBytes) return { action: "offer-session-copy", why: `the target is ${input.targetBytes} bytes and the session copy is ${input.sessionBytes}: the user should choose, because neither is provably newer` };
  if (input.hasTemp) return { action: "discard-temp", why: "a validated replace already left the target correct; the temp is a leftover" };
  return { action: "nothing", why: "no temp and no session copy: the target is all there is" };
}

/** One sentence for the save indicator; `replaced` is the only success. */
export function describe(s: SafeSaveState): string {
  switch (s.phase) {
    case "idle": return "No save in progress.";
    case "session-copy": return "Copying to the session file…";
    case "temp-written": return "Checking the written file…";
    case "validated": return "Checked; replacing the original…";
    case "replaced": return "Saved, and the written file was checked before the original was replaced.";
    case "failed": return s.error ? `Not saved: ${s.error}. ${s.recovery}.` : "Not saved.";
  }
}
