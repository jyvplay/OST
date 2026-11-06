/**
 * TT137 (BK-05) — Backup health + restore drill.
 *
 * Pure health check and restore drill for backup sets. No I/O —
 * just classification of backup state and drill planning.
 */

export interface BackupSet {
  id: string;
  /** Timestamp of the last backup (epoch ms). */
  lastBackup: number;
  /** Total bytes in the set. */
  bytes: number;
  /** Number of files backed up. */
  files: number;
  /** Whether the set is encrypted. */
  encrypted: boolean;
  /** Whether the set is verifiable (has a manifest with digests). */
  verifiable: boolean;
  /** Whether the set is complete (all files present). */
  complete: boolean;
}

export interface BackupHealth {
  ok: boolean;
  stalenessDays: number;
  /** Days since last backup. */
  grade: "fresh" | "ok" | "stale" | "critical";
  issues: string[];
  recommendation: string;
}

export const STALE_DAYS = 7;
export const CRITICAL_DAYS = 30;

export function checkHealth(set: BackupSet, now: number): BackupHealth {
  if (!Number.isFinite(now) || now < 0) throw new Error("now must be finite");
  if (!Number.isFinite(set.lastBackup) || set.lastBackup < 0) throw new Error("lastBackup must be finite");
  const stalenessDays = Math.floor((now - set.lastBackup) / 86_400_000);
  const issues: string[] = [];

  if (stalenessDays > CRITICAL_DAYS) issues.push(`Backup is ${stalenessDays} days old (critical: >${CRITICAL_DAYS})`);
  else if (stalenessDays > STALE_DAYS) issues.push(`Backup is ${stalenessDays} days old (stale: >${STALE_DAYS})`);

  if (!set.encrypted) issues.push("Backup set is not encrypted");
  if (!set.verifiable) issues.push("Backup set is not verifiable");
  if (!set.complete) issues.push("Backup set is incomplete");
  if (set.files === 0) issues.push("Backup set contains no files");

  const grade = stalenessDays > CRITICAL_DAYS ? "critical" : stalenessDays > STALE_DAYS ? "stale" : stalenessDays > 3 ? "ok" : "fresh";
  const recommendation = issues.length === 0
    ? "No issues — backup is healthy"
    : (issues.includes(`Backup is ${stalenessDays} days old (critical)`)
      ? "Run a backup immediately"
      : "Run a backup soon");

  return { ok: issues.length === 0, stalenessDays, grade, issues, recommendation };
}

export interface RestoreDrill {
  /** Files to restore. */
  files: string[];
  /** Whether the drill is a full restore. */
  full: boolean;
  /** Whether the drill verifies digests after restore. */
  verifyDigests: boolean;
  /** Estimated bytes to restore. */
  estimatedBytes: number;
  /** Whether the drill is safe to run (does not overwrite existing files). */
  safe: boolean;
  issues: string[];
}

export function planDrill(set: BackupSet, targetPaths: readonly string[], verifyDigests = true): RestoreDrill {
  if (!set.complete) throw new Error("Cannot drill on an incomplete backup set");
  const issues: string[] = [];
  const safe = targetPaths.length === 0; // Dry run: no targets = safe
  if (!verifyDigests) issues.push("Digest verification disabled");
  if (!set.verifiable && verifyDigests) issues.push("Set is not verifiable but digest verification requested");
  return {
    files: [...targetPaths],
    full: targetPaths.length === 0,
    verifyDigests,
    estimatedBytes: set.bytes,
    safe,
    issues,
  };
}

export function describeHealth(h: BackupHealth): string {
  return `${h.grade} · ${h.stalenessDays} days · ${h.issues.length} issue(s) — ${h.recommendation}`;
}
