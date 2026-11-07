/**
 * TT145 (BK-05) — backup health that refuses to call anything "healthy" without
 * evidence, and a restore drill that is a real restore into a sandbox.
 *
 * The row's honest core is a single asymmetry: **a backup is not evidence; a
 * restore is.** So the health model keeps three separate clocks —
 * *written*, *verified* (the manifest was re-hashed) and *drilled* (a sample was
 * actually restored) — and the verdict is the weakest of the three. A backup that
 * was written daily but never drilled is not healthy; it is *unproven*, which is a
 * different word and a different colour in the UI.
 *
 * Three failure modes are modelled explicitly because they are the ones that make
 * "healthy" a lie:
 *
 *   · **clock problems** — a backup timestamped in the future (a device whose clock
 *     ran fast) must not read as "missing", and a backup older than the window must
 *     not read as "just now" because the clock moved back.
 *   · **malformed status** — a status written by an older build, or hand-edited, is
 *     `unreadable`, and unreadable is never healthy.
 *   · **sampling that cannot actually restore** — a drill that restores zero files
 *     because the sample was empty, or because every sampled file was excluded
 *     from the archive, is *not* a passing drill. It is `vacuous`, and vacuous is a
 *     failure with a reason.
 */

export const DRILL_INTERVAL_DAYS = 30;
export const MAX_STALE_DAYS = 2;
export const SAMPLE_MIN = 3;
export const SAMPLE_MAX = 60;

export type Verdict = "healthy" | "unproven" | "stale" | "unreadable" | "vacuous" | "never";

export interface Record_ {
  /** Epoch ms of the archive's own write time, as recorded by the writer. */
  writtenAt: number;
  /** Epoch ms of the last successful re-hash of the manifest, or null. */
  verifiedAt: number | null;
  /** Epoch ms of the last drill that restored at least one file, or null. */
  drilledAt: number | null;
  /** Files the archive says it holds. */
  files: number;
  /** Files the last drill actually restored and read back. */
  drillRestored: number;
  /** Raw status string from storage, whatever a previous build wrote. */
  rawStatus: string;
}

export interface Health {
  verdict: Verdict;
  /** Whole sentence, the only thing the UI prints. */
  sentence: string;
  /** Days until the next drill is due; negative when overdue, null when never drilled. */
  drillDueInDays: number | null;
}

const KNOWN = new Set(["ok", "partial", "failed", "skipped", "legacy"]);

/**
 * The verdict. Order is weakest-link, then clock sanity, then status legibility.
 * An `unreadable` status wins over everything: if the stored record cannot be
 * interpreted, nothing downstream is trustworthy.
 */
export function health(r: Record_ | null, now: number, opts: { staleDays?: number; drillDays?: number } = {}): Health {
  const staleDays = opts.staleDays ?? MAX_STALE_DAYS;
  const drillDays = opts.drillDays ?? DRILL_INTERVAL_DAYS;
  if (!r) return { verdict: "never", sentence: "no backup record exists for this device; the first backup will prove the path", drillDueInDays: null };
  if (!KNOWN.has(r.rawStatus) || !Number.isFinite(r.writtenAt)) return { verdict: "unreadable", sentence: `the stored backup status “${String(r.rawStatus).slice(0, 40)}” was not written by a build this one understands; it is treated as unhealthy rather than guessed at`, drillDueInDays: null };
  if (r.rawStatus === "failed") return { verdict: "unreadable", sentence: "the last backup run reported failure; the previous archive is the one in use", drillDueInDays: null };
  if (r.writtenAt > now + 86400000) return { verdict: "unreadable", sentence: `the archive is dated ${Math.round((r.writtenAt - now) / 3600000)} h in the future; a device clock that ran fast is not evidence of a fresh backup`, drillDueInDays: null };
  const ageDays = (now - r.writtenAt) / 86400000;
  if (ageDays > staleDays) return { verdict: "stale", sentence: `the last archive is ${Math.round(ageDays)} days old against a ${staleDays}-day window`, drillDueInDays: null };
  if (r.verifiedAt === null) return { verdict: "unproven", sentence: "the archive was written but its manifest has never been re-hashed, so integrity is an assumption", drillDueInDays: null };
  if (r.verifiedAt < r.writtenAt) return { verdict: "unproven", sentence: "the last verification is older than the archive it was supposed to check", drillDueInDays: null };
  if (r.drilledAt === null) return { verdict: "unproven", sentence: "nothing has been restored from this archive; a backup that was never restored is a hypothesis", drillDueInDays: 0 };
  if (r.drillRestored === 0) return { verdict: "vacuous", sentence: "the last drill restored zero files, which proves only that the sampler ran", drillDueInDays: 0 };
  if (r.drillRestored > r.files) return { verdict: "unreadable", sentence: `the drill claims ${r.drillRestored} restored of ${r.files} archived files; that is impossible and the record is not trusted`, drillDueInDays: null };
  const dueIn = drillDays - (now - r.drilledAt) / 86400000;
  return {
    verdict: "healthy",
    sentence: `${r.drillRestored} of ${r.files} files were restored and read back, manifest re-hashed at the same revision`,
    drillDueInDays: dueIn,
  };
}

/**
 * The drill's sample. Deterministic given a seed, spread across the manifest, and
 * bounded: a drill that restores everything is a restore, not a drill, and one
 * that restores the first N files tests only the files that always work.
 */
export function sample(paths: readonly string[], seed: number, max = SAMPLE_MAX): string[] {
  if (!paths.length) return [];
  const n = Math.max(SAMPLE_MIN, Math.min(max, Math.ceil(paths.length * 0.02), paths.length));
  // Deterministic index walk: a fixed stride coprime with the length visits every
  // slot before repeating, so the sample spreads without a shuffle.
  const stride = (() => {
    // Mixed first: `(seed | 1)` maps 42 and 43 onto the same odd number, which made
    // two different seeds sample the same files. The multiply-rotate spreads them.
    let s = (Math.imul((seed >>> 0) ^ 0x9e3779b9, 2654435761) >>> 0) % paths.length || 1;
    while (gcd(s, paths.length) !== 1) s = (s + 2) % paths.length || 1;
    return s;
  })();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(paths[(i * stride) % paths.length]);
  return [...new Set(out)];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** What a drill result means. A partial restore is not a pass. */
export function interpretDrill(restored: number, sampled: number, errors: readonly string[]): { verdict: "pass" | "vacuous" | "fail"; sentence: string } {
  if (sampled === 0) return { verdict: "vacuous", sentence: "the sample was empty, so the drill exercised nothing" };
  if (errors.length) return { verdict: "fail", sentence: `${errors.length} of ${sampled} sampled files failed to restore: ${errors[0]}` };
  if (restored === 0) return { verdict: "vacuous", sentence: `0 of ${sampled} sampled files were restored and read back` };
  if (restored < sampled) return { verdict: "fail", sentence: `${sampled - restored} of ${sampled} sampled files restored without a read-back match` };
  return { verdict: "pass", sentence: `${restored} of ${sampled} sampled files restored and matched their digests` };
}

/** When the next drill is due, in the words the UI shows. */
export function dueSentence(h: Health): string {
  if (h.drillDueInDays === null) return "no drill has been scheduled";
  if (h.drillDueInDays <= 0) return "a drill is due now";
  return `a drill is due in ${Math.ceil(h.drillDueInDays)} days`;
}

export const LIMITS = [
  "the drill restores a bounded sample into isolated tables, not the whole archive, and not into the live schema",
  "rollback is transactional, not secure erasure",
  "this engine judges a record; it does not schedule background backups, and a closed tab runs nothing",
  "healthy means “restorable to the extent drilled”, not “the data is correct”",
] as const;
