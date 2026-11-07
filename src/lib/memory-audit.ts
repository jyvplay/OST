/**
 * TT143 (RC-29) — archive publication auditing: names what is on disk, not what
 * the code intended to write.
 *
 * The failure this exists to catch is specific and was named in the specs: a
 * crash between writing an image and writing its metadata leaves a **half pair**
 * — an orphaned payload with no row, or a row pointing at a payload that does not
 * exist. Neither is a data-loss bug on its own; both become one when a later
 * restore trusts the row.
 *
 * So the input is two *observed* inventories (what the store lists, what the
 * database lists) and the output is a verdict, not a cleanup action:
 *
 *   · `orphanPayload` — a payload no row references. Reclaimable, but only after
 *     a grace period, because the writer may still be mid-publish;
 *   · `danglingRow` — a row whose payload is gone. Never reclaimable blindly:
 *     the payload may be on a slower device, and deleting the row destroys the
 *     only record that it existed;
 *   · `sizeMismatch` — both exist and disagree; the smaller one is truncated;
 *   · `checksumMismatch` — both exist at the right size and the content differs,
 *     which is corruption, not an interrupted write.
 *
 * The grace period is an argument, never a constant hidden in the engine, and the
 * audit refuses to classify a payload younger than it. A `clean` verdict means
 * "every row has a payload and every payload has a row at this instant", which is
 * exactly as strong as that sentence and no stronger.
 */

export interface Payload { key: string; bytes: number; createdAt: number; digest?: string }
export interface RowRef { key: string; bytes: number; digest?: string; createdAt: number }
export type Finding =
  | { kind: "orphanPayload"; key: string; bytes: number; ageMs: number; note: string }
  | { kind: "danglingRow"; key: string; bytes: number; ageMs: number; note: string }
  | { kind: "sizeMismatch"; key: string; payloadBytes: number; rowBytes: number; note: string }
  | { kind: "checksumMismatch"; key: string; note: string }
  | { kind: "unverified"; key: string; note: string };

export interface AuditResult {
  findings: Finding[];
  clean: boolean;
  counts: { payloads: number; rows: number; orphanPayloads: number; danglingRows: number; mismatches: number };
  /** Keys that are safe to reclaim right now (orphans older than the grace period). */
  reclaimable: string[];
  /** One sentence for the UI. */
  sentence: string;
}

/** Default grace: 10 minutes. A publish that takes longer than this is a stall, not a race. */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/**
 * Audit two inventories taken at `now`.
 *
 * `verifyDigests` is false by default: a digest can only be checked against real
 * bytes, and this engine deliberately never reads them (a 16 MiB archive would be
 * loaded into memory to prove nothing new). When the caller HAS read and hashed
 * the payloads it passes `true`, and a mismatch is then a corruption finding.
 */
export function audit(payloads: readonly Payload[], rows: readonly RowRef[], now: number, opts: { graceMs?: number; verifyDigests?: boolean } = {}): AuditResult {
  const grace = Math.max(0, opts.graceMs ?? DEFAULT_GRACE_MS);
  const findings: Finding[] = [];
  const byKey = new Map<string, Payload>();
  for (const p of payloads) byKey.set(p.key, p);
  const rowKeys = new Set<string>();

  for (const row of rows) {
    if (rowKeys.has(row.key)) {
      findings.push({ kind: "danglingRow", key: row.key, bytes: row.bytes, ageMs: now - row.createdAt, note: "the same key appears twice; a restore would apply both rows" });
      continue;
    }
    rowKeys.add(row.key);
    const payload = byKey.get(row.key);
    if (!payload) {
      findings.push({ kind: "danglingRow", key: row.key, bytes: row.bytes, ageMs: now - row.createdAt, note: "the record exists and its bytes do not: keep the record until a restore proves the bytes are gone" });
      continue;
    }
    if (payload.bytes !== row.bytes) {
      const smaller = payload.bytes < row.bytes ? "payload" : "record";
      findings.push({
        kind: "sizeMismatch", key: row.key, payloadBytes: payload.bytes, rowBytes: row.bytes,
        note: `${smaller} is short by ${Math.abs(row.bytes - payload.bytes)} bytes — an interrupted write, not corruption`,
      });
      continue;
    }
    if (opts.verifyDigests && row.digest && payload.digest && row.digest !== payload.digest) {
      findings.push({ kind: "checksumMismatch", key: row.key, note: "same length, different content: this is corruption" });
      continue;
    }
    if (opts.verifyDigests && (!row.digest || !payload.digest)) {
      findings.push({ kind: "unverified", key: row.key, note: "one side has no digest, so identical length is all that was checked" });
    }
  }

  const reclaimable: string[] = [];
  let orphans = 0, dangling = 0, mismatches = 0;
  for (const p of payloads) {
    if (rowKeys.has(p.key)) continue;
    orphans += 1;
    const ageMs = Math.max(0, now - p.createdAt);
    if (ageMs >= grace) {
      reclaimable.push(p.key);
      findings.push({ kind: "orphanPayload", key: p.key, bytes: p.bytes, ageMs, note: `no record references this payload; older than the ${Math.round(grace / 60000)}-minute grace period, so it can be reclaimed` });
    } else {
      findings.push({ kind: "orphanPayload", key: p.key, bytes: p.bytes, ageMs, note: `no record references this payload, but it is ${Math.round(ageMs / 1000)}s old: a publish may still be in flight` });
    }
  }
  for (const f of findings) {
    if (f.kind === "danglingRow") dangling += 1;
    if (f.kind === "sizeMismatch" || f.kind === "checksumMismatch") mismatches += 1;
  }
  const clean = findings.length === 0;
  return {
    findings, clean, reclaimable,
    counts: { payloads: payloads.length, rows: rows.length, orphanPayloads: orphans, danglingRows: dangling, mismatches },
    sentence: clean
      ? "Every record has its bytes and every payload has a record, at this instant."
      : `${dangling} record${dangling === 1 ? "" : "s"} without bytes, ${orphans} payload${orphans === 1 ? "" : "s"} without a record (${reclaimable.length} reclaimable), ${mismatches} length mismatch${mismatches === 1 ? "" : "es"}.`,
  };
}

/**
 * Which keys may be deleted. Deliberately narrow: only orphan payloads past the
 * grace period. A dangling row is never deleted, because the record is the only
 * evidence that the payload existed.
 */
export function reclaimPlan(result: AuditResult): { deletePayloads: string[]; keepRecords: string[]; reason: string } {
  return {
    deletePayloads: [...result.reclaimable],
    keepRecords: result.findings.filter((f) => f.kind === "danglingRow").map((f) => f.key),
    reason: "Payloads with no record are removable once they are older than the grace period; records with no payload are kept, because deleting the record destroys the only evidence the ciphertext existed.",
  };
}
