/**
 * TT137 (FM-18) — Safe-save contract.
 *
 * Session copy → temp → validate → atomic replace. Nothing is overwritten
 * until the new bytes pass validation. The original file is never touched
 * until the very last step.
 */

export type SafeSavePhase = "idle" | "copying" | "temp-written" | "validated" | "published" | "failed";

export interface SafeSaveState {
  phase: SafeSavePhase;
  sessionPath: string;
  tempPath: string;
  targetPath: string;
  /** Bytes written to temp so far. */
  written: number;
  /** Total bytes to write. */
  total: number;
  /** SHA-256 of the temp bytes, computed after write. */
  tempSha?: string;
  /** SHA-256 of the original target, captured before replace. */
  originalSha?: string;
  /** Error reason if phase is failed. */
  error?: string;
}

export const SAFE_SAVE_TOKEN = "safe-save";

export function createSafeSave(sessionPath: string, targetPath: string, totalBytes: number): SafeSaveState {
  if (!sessionPath.startsWith("/") || !targetPath.startsWith("/")) throw new Error("Paths must be absolute");
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > 8 * 1024 * 1024) throw new Error("Byte count must be 0…8 MiB");
  if (sessionPath === targetPath) throw new Error("Session path must differ from target");
  const dot = targetPath.lastIndexOf(".");
  const base = dot > 0 ? targetPath.slice(0, dot) : targetPath;
  const ext = dot > 0 ? targetPath.slice(dot) : "";
  return { phase: "idle", sessionPath, tempPath: `${base}.safe-save.${Date.now().toString(36)}.part${ext}`, targetPath, written: 0, total: totalBytes };
}

export function writeChunk(state: SafeSaveState, chunk: Uint8Array): SafeSaveState {
  if (state.phase !== "copying" && state.phase !== "idle") throw new Error(`Cannot write in ${state.phase} phase`);
  if (chunk instanceof Uint8Array === false) throw new Error("Chunk must be a Uint8Array");
  if (state.written + chunk.length > state.total) throw new Error(`Chunk would exceed total bytes (${state.written + chunk.length} > ${state.total})`);
  return { ...state, phase: "copying", written: state.written + chunk.length };
}

export function markTempWritten(state: SafeSaveState, sha256: string): SafeSaveState {
  if (state.phase !== "copying") throw new Error("Must be in copying phase");
  if (state.written !== state.total) throw new Error(`Temp write incomplete (${state.written} of ${state.total})`);
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error("SHA-256 must be 64 hex characters");
  return { ...state, phase: "temp-written", tempSha: sha256 };
}

export type ValidateResult = { ok: true; sha: string; bytes: number } | { ok: false; reason: string };

/** Validate the temp file against the declared size and compute its SHA-256. */
export function validate(state: SafeSaveState, actualSha: string, actualBytes: number): ValidateResult {
  if (state.phase !== "temp-written") throw new Error("Must be in temp-written phase");
  if (actualBytes !== state.total) return { ok: false, reason: `Size mismatch: ${actualBytes} ≠ ${state.total}` };
  if (actualSha !== state.tempSha) return { ok: false, reason: "SHA mismatch" };
  return { ok: true, sha: actualSha, bytes: actualBytes };
}

export function markValidated(state: SafeSaveState, originalSha: string): SafeSaveState {
  if (state.phase !== "temp-written") throw new Error("Must be in temp-written phase");
  if (!/^[0-9a-f]{64}$/i.test(originalSha)) throw new Error("Original SHA-256 must be 64 hex characters");
  return { ...state, phase: "validated", originalSha };
}

export function publish(state: SafeSaveState): SafeSaveState {
  if (state.phase !== "validated") throw new Error("Must be in validated phase before publish");
  return { ...state, phase: "published" };
}

export function fail(state: SafeSaveState, reason: string): SafeSaveState {
  return { ...state, phase: "failed", error: reason.slice(0, 300) };
}

/** The original file is only replaced after publish. If any step fails, the original is untouched. */
export function isOriginalSafe(state: SafeSaveState): boolean {
  return state.phase !== "published";
}

export function describePhase(state: SafeSaveState): string {
  const map: Record<SafeSavePhase, string> = {
    idle: "ready to copy",
    copying: `copying (${state.written}/${state.total} bytes)`,
    "temp-written": "temp written, awaiting validation",
    validated: "validated, ready to publish",
    published: "published — target replaced",
    failed: `failed: ${state.error}`,
  };
  return map[state.phase];
}
