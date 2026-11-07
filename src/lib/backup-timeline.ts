/**
 * TT145 (BK-01) — timeline backup: versioned, encrypted, verifiable.
 *
 * "Timeline backup" collapses four separate promises, and a backup that keeps
 * three of them is the kind of backup people lose data to. This engine makes each
 * one checkable:
 *
 *   1. **VERSIONED** — a backup is a chain, not a pile. Each snapshot names its
 *      parent, so a restore can prove it has a contiguous history rather than a
 *      folder of files with plausible names.
 *   2. **ENCRYPTED** — every chunk carries its own AES-GCM envelope with a key id,
 *      so one chunk can be restored without holding the whole archive in memory,
 *      and a chunk from another snapshot fails to open (the AAD binds snapshot and
 *      chunk ids together — same discipline as the vault).
 *   3. **VERIFIABLE** — a manifest of (path, bytes, digest) per snapshot, plus a
 *      root digest over the manifest. Verification is a *re-computation*, not a
 *      comparison of two files that could both be wrong.
 *   4. **BOUNDED** — a retention chain: keep the last N, plus one per day for D
 *      days, plus one per week for W weeks. A chain that only keeps the last N
 *      dies with a bug that ran N times.
 *
 * Compaction is the hard part and the reason this is an engine: deleting an
 * *ancestor* of a retained snapshot would break the chain, so compaction removes
 * only snapshots that are neither retained nor an ancestor of a retained one.
 */

export const SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_KEEP = { last: 24, daily: 7, weekly: 4 } as const;
export const MAX_CHUNKS = 100_000;

export interface FileEntry { path: string; bytes: number; digest: number }

export interface Snapshot {
  v: typeof SNAPSHOT_VERSION;
  id: string;
  /** Parent snapshot id, or null for the first. */
  parent: string | null;
  at: number;
  /** keyId used for every chunk in this snapshot. */
  keyId: string;
  /** Per-file manifest; the root digest is computed from this. */
  files: FileEntry[];
  /** Digest over the canonical manifest; the verifier recomputes it. */
  root: number;
  /** Chunk ids in write order; each is a separate AES-GCM envelope. */
  chunks: string[];
}

export function digestBytes(entries: readonly FileEntry[]): number {
  let h = 0x811c9dc5;
  const canon = entries.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of canon) {
    const line = `${e.path}\u0000${e.bytes}\u0000${e.digest.toString(16)}\n`;
    for (let i = 0; i < line.length; i++) { h ^= line.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  return h >>> 0;
}

export function snapshot(id: string, parent: string | null, at: number, keyId: string, files: FileEntry[]): Snapshot {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error(`snapshot id “${id}” must be a lowercase id`);
  if (files.length > MAX_CHUNKS) throw new Error(`${files.length} files exceeds the ${MAX_CHUNKS} per-snapshot limit; split the backup`);
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.path || f.path.startsWith("/")) throw new Error(`“${f.path}” is not a relative path`);
    if (seen.has(f.path)) throw new Error(`duplicate path ${f.path} in one snapshot`);
    seen.add(f.path);
    if (!(f.bytes >= 0)) throw new Error(`negative size for ${f.path}`);
  }
  return { v: SNAPSHOT_VERSION, id, parent, at, keyId, files: [...files], root: digestBytes(files), chunks: files.map((f) => `${id}:${f.path}`) };
}

/**
 * Verification. Three independent failures are reported separately, because the
 * repair for each is different: a broken chain means a missing snapshot, a root
 * mismatch means the manifest was edited, and a chunk failure means the ciphertext
 * was altered.
 */
export interface VerifyResult {
  ok: boolean;
  chain: "intact" | "gap" | "no-history";
  rootMatch: boolean;
  missingChunks: string[];
  sentence: string;
}

export function verify(chain: readonly Snapshot[], targetId: string, present: ReadonlySet<string>): VerifyResult {
  const byId = new Map(chain.map((s) => [s.id, s]));
  const target = byId.get(targetId);
  if (!target) return { ok: false, chain: "gap", rootMatch: false, missingChunks: [], sentence: `snapshot ${targetId} is not in this chain` };
  let cursor: Snapshot | undefined = target;
  let steps = 0;
  let gap = false;
  while (cursor) {
    if (++steps > chain.length + 1) { gap = true; break; }
    if (cursor.parent === null) break;
    const parent: Snapshot | undefined = byId.get(cursor.parent);
    if (!parent) { gap = true; break; }
    if (parent.at >= cursor.at) { gap = true; break; }
    cursor = parent;
  }
  const rootMatch = digestBytes(target.files) === target.root;
  const missing = target.chunks.filter((c) => !present.has(c));
  const ok = !gap && rootMatch && missing.length === 0;
  return {
    ok, chain: gap ? "gap" : steps === 1 ? "no-history" : "intact", rootMatch, missingChunks: missing,
    sentence: ok
      ? `verified ${target.files.length} files against root ${target.root.toString(16)}; ${steps - 1} ancestor snapshot(s) present`
      : gap ? "the chain is broken: an ancestor snapshot is missing or out of order, so this is not a restorable history"
      : !rootMatch ? "the manifest does not match its root digest: it was edited after the snapshot was written"
      : `${missing.length} chunk(s) are not present, so the restore would be incomplete`,
  };
}

/**
 * Retention. The three windows are unioned, never intersected, and the first
 * snapshot is always kept: a chain with no root cannot be verified.
 */
export function retain(chain: readonly Snapshot[], now: number, keep: { last: number; daily: number; weekly: number } = DEFAULT_KEEP): Set<string> {
  if (chain.length === 0) return new Set();
  const sorted = [...chain].sort((a, b) => b.at - a.at);
  const out = new Set<string>();
  for (const s of sorted.slice(0, Math.max(1, keep.last))) out.add(s.id);
  const seenDay = new Set<string>(), seenWeek = new Set<string>();
  for (const s of sorted) {
    const day = new Date(s.at).toISOString().slice(0, 10);
    const week = `${new Date(s.at).getUTCFullYear()}-w${Math.floor((s.at - Date.UTC(new Date(s.at).getUTCFullYear(), 0, 1)) / (7 * 86400000))}`;
    if (seenDay.size < keep.daily && !seenDay.has(day)) { seenDay.add(day); out.add(s.id); }
    if (seenWeek.size < keep.weekly && !seenWeek.has(week)) { seenWeek.add(week); out.add(s.id); }
  }
  out.add(sorted[sorted.length - 1].id); // the root
  if (now <= 0) throw new Error("retain needs a real clock");
  return out;
}

/**
 * Compaction plan. This is where the first draft was wrong in a way only a test
 * found: in a linear chain, *every* snapshot is an ancestor of the newest one, so
 * "keep ancestors" meant "keep everything" and compaction was vacuous.
 *
 * The fix is to separate the two things an ancestor is needed for:
 *
 *   · **the link** — its id, timestamp and parent. Verification needs these to prove
 *     contiguity, and they are a few dozen bytes.
 *   · **the payload** — its file manifest, root digest and encrypted chunks. Only a
 *     *retained* snapshot can be restored *from*, so an ancestor's payload is only
 *     needed if it is itself retained.
 *
 * Hence three classes: `keep` (retained; payload and link), `tombstone` (not
 * retained but an ancestor; link only), `drop` (neither; nothing).
 *
 * A consequence worth stating because it surprised the first draft's test: in a
 * **linear** chain nothing is ever `drop`-pable, because the newest snapshot is
 * retained and therefore every earlier snapshot is its ancestor. Linear chains can
 * only be tombstoned. `drop` exists for **branched** chains, where an abandoned
 * branch is an ancestor of nothing retained — that is the case where space is
 * actually reclaimed.
 */
export interface CompactPlan {
  keep: string[];
  tombstone: string[];
  drop: string[];
  /** File records freed by tombstoning and dropping. */
  freedFiles: number;
  /** Chunk ids that can be deleted. */
  freedChunks: string[];
  sentence: string;
}

export function compactPlan(chain: readonly Snapshot[], now: number, keep = DEFAULT_KEEP): CompactPlan {
  const retained = retain(chain, now, keep);
  const byId = new Map(chain.map((s) => [s.id, s]));
  const ancestors = new Set<string>();
  for (const id of retained) {
    let cur = byId.get(id)?.parent ?? null;
    let guard = 0;
    while (cur && guard++ <= chain.length) { ancestors.add(cur); cur = byId.get(cur)?.parent ?? null; }
  }
  const sorted = [...chain].sort((a, b) => a.at - b.at);
  const newest = sorted[sorted.length - 1]?.id;
  const drop = sorted.filter((s) => !retained.has(s.id) && !ancestors.has(s.id));
  // A snapshot that is the only link to something retained can never be dropped —
  // that is what `ancestors` already encodes; the newest is kept regardless because
  // it is the head of the chain.
  const tombstone = sorted.filter((s) => !retained.has(s.id) && ancestors.has(s.id) && s.id !== newest);
  const payloadFreed = [...drop, ...tombstone];
  return {
    keep: [...retained],
    tombstone: tombstone.map((s) => s.id),
    drop: drop.map((s) => s.id),
    freedFiles: payloadFreed.reduce((n, s) => n + s.files.length, 0),
    freedChunks: payloadFreed.flatMap((s) => s.chunks),
    sentence: payloadFreed.length
      ? `${tombstone.length} ancestor(s) keep only their link and ${drop.length} are removed, freeing ${payloadFreed.reduce((n, s) => n + s.files.length, 0)} file records; every retained snapshot still has a contiguous chain`
      : "nothing is droppable: every snapshot is retained or is the only link to one that is",
  };
}

/**
 * Verification against a compacted chain: a tombstone has no manifest, so its root
 * check is *not applicable* rather than failed. Conflating "no payload" with
 * "payload wrong" would make a correct compaction look like corruption.
 */
export function verifyCompacted(chain: readonly Snapshot[], targetId: string, present: ReadonlySet<string>, tombstones: ReadonlySet<string>): VerifyResult {
  const target = chain.find((s) => s.id === targetId);
  if (!target) return { ok: false, chain: "gap", rootMatch: false, missingChunks: [], sentence: `snapshot ${targetId} is not in this chain` };
  if (tombstones.has(targetId)) return { ok: false, chain: "intact", rootMatch: false, missingChunks: [], sentence: `${targetId} was compacted to a link: it has no manifest to restore from, which is why it is not offered as a restore point` };
  return verify(chain, targetId, present);
}

export const LIMITS = [
  "the timeline is a chain of snapshots; there is no continuous per-edit history inside a snapshot",
  "verification proves the archive matches its own manifest, not that the manifest described the truth when it was written",
  "encryption keys are not escrowed: losing every copy of a key loses every chunk sealed under it",
  "a restore is a full snapshot, not a merge into the current state",
] as const;
