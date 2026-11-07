/**
 * TT145 (PR-01) — autosave that is a journal, not a write.
 *
 * The editor's autosave claim is "autosave never means irreversibly overwrote".
 * That claim is only true if three separate things hold, and this engine is the
 * one that holds them:
 *
 *   1. **Bounded history.** Every save appends an immutable revision; revisions
 *      are compacted only by merging an OLDER revision into its successor when
 *      the pair is byte-identical (a no-op save) or when the older one is past
 *      the retention window. A compaction that would drop the last *distinct*
 *      predecessor is refused, because that is exactly the version a user asks
 *      for after a bad paste.
 *   2. **Debounce that survives a crash.** A save that has been *scheduled* but
 *      not *flushed* is visible as `dirty`; the recovery path can tell the
 *      difference between "nothing changed" and "the tab died before the write
 *      landed", and it hands back the pending body rather than the last flushed
 *      one.
 *   3. **A conflict rule for two writers.** If another tab flushed a revision
 *      with the same parent, this tab does not overwrite it: it forks a
 *      `conflict` revision that carries both bodies, and the UI shows a choice.
 *      Last-writer-wins would silently destroy one of the two edits.
 *
 * All of it is pure: bodies are strings, the caller supplies the clock, and
 * nothing here touches storage, so the same rules run in Node and in the page.
 */

export const MAX_REVISIONS = 40;
export const DEBOUNCE_MS = 900;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type Kind = "flush" | "scheduled" | "conflict" | "restore";

export interface Revision {
  id: string;
  /** Revision this one was written on top of; null for the first. */
  parent: string | null;
  at: number;
  /** UTF-8 byte length of `body`; stored so compaction does not re-encode. */
  bytes: number;
  /** FNV-1a over the body — cheap equality, not a security hash. */
  digest: number;
  kind: Kind;
  body: string;
  /** For a conflict fork: the body the other tab had. */
  other?: string;
}

export interface Journal {
  docId: string;
  revs: Revision[];
  /** Set while a debounce is pending; cleared on flush. */
  pending: { body: string; since: number } | null;
  /** Highest `at` this journal has ever used, so a rolled-back clock cannot reorder it. */
  highWater: number;
}

export function digest(body: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const utf8Bytes = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : 3;
    if (c >= 0xd800 && c <= 0xdbff) i++;
  }
  return n;
};

export function emptyJournal(docId: string): Journal {
  if (!docId.trim()) throw new Error("a document id is required");
  return { docId: docId.trim(), revs: [], pending: null, highWater: 0 };
}

const nextId = (j: Journal, at: number) => `${j.docId}@${at.toString(36)}#${j.revs.length.toString(36)}`;

/**
 * Schedules a save. Returns the journal unchanged when the body is identical to
 * the last flushed revision — a no-op save must not create a revision, or the
 * history fills with noise and the retention window evicts the edit that
 * mattered.
 */
export function schedule(j: Journal, body: string, now: number): { journal: Journal; note: string } {
  const bytes = utf8Bytes(body);
  if (bytes > MAX_BODY_BYTES) throw new Error(`body is ${bytes} bytes; the editor journals at most ${MAX_BODY_BYTES}`);
  const head = j.revs[j.revs.length - 1];
  if (head && head.digest === digest(body) && head.bytes === bytes) {
    return { journal: j.pending ? { ...j, pending: null } : j, note: "identical to the last flushed revision: nothing scheduled" };
  }
  const at = Math.max(now, j.highWater + 1);
  return { journal: { ...j, pending: { body, since: at }, highWater: at }, note: `scheduled a ${bytes}-byte save at ${new Date(at).toISOString()}` };
}

/**
 * Flushes the pending save. `parentRev` is what the caller believes it is
 * editing on top of; if the journal's head moved in the meantime, the flush
 * forks a conflict instead of overwriting.
 */
export function flush(j: Journal, parentRev: string | null, body: string, now: number): { journal: Journal; revision: Revision; conflicted: boolean } {
  const at = Math.max(now, j.highWater + 1);
  const head = j.revs[j.revs.length - 1];
  const headId = head?.id ?? null;
  const conflicted = headId !== parentRev;
  const d = digest(body);
  if (!conflicted && head && head.digest === d && head.bytes === utf8Bytes(body)) {
    return { journal: { ...j, pending: null }, revision: head, conflicted: false };
  }
  const previousOther = conflicted && j.pending && body === j.pending.body ? head?.body : undefined;
  const revision: Revision = {
    id: nextId(j, at), parent: headId, at, bytes: utf8Bytes(body), digest: d,
    kind: conflicted ? "conflict" : "flush", body, ...(conflicted ? { other: previousOther ?? head?.body ?? "" } : {}),
  };
  const journal = compact({ ...j, revs: [...j.revs, revision], pending: null, highWater: at });
  return { journal, revision, conflicted };
}

/**
 * Compaction. Two rules, both conservative:
 *   · adjacent revisions with the same digest collapse to the newer one (the
 *     older body is byte-identical, so nothing is lost);
 *   · revisions older than the retention window are dropped ONLY while at least
 *     one newer *distinct* body remains, so the "restore previous version"
 *     affordance never disappears.
 */
export function compact(j: Journal): Journal {
  const out: Revision[] = [];
  for (const r of j.revs) {
    const prev = out[out.length - 1];
    if (prev && prev.digest === r.digest && prev.bytes === r.bytes) { out[out.length - 1] = r; continue; }
    out.push(r);
  }
  if (out.length <= MAX_REVISIONS) return { ...j, revs: out };
  const head = j.highWater;
  const kept: Revision[] = [];
  for (const r of out) {
    const old = head - r.at > RETENTION_MS;
    // Never drop the newest revision, and never drop below two distinct bodies.
    if (old && kept.length + 1 < out.length && out.length - kept.length > 2) continue;
    kept.push(r);
  }
  return { ...j, revs: kept.slice(-MAX_REVISIONS) };
}

/** The crash-recovery answer: the pending body if there is one, else the last flush. */
export function recover(j: Journal): { body: string; dirty: boolean; why: string } {
  if (j.pending) return { body: j.pending.body, dirty: true, why: `a save was scheduled at ${new Date(j.pending.since).toISOString()} and never flushed; this is the unsaved body` };
  const head = j.revs[j.revs.length - 1];
  if (!head) return { body: "", dirty: false, why: "no revisions were ever written for this document" };
  return { body: head.body, dirty: false, why: `restored the last flushed revision from ${new Date(head.at).toISOString()}` };
}

/** Step back one distinct body, which is what "undo a bad paste" actually wants. */
export function previousDistinct(j: Journal, fromId?: string): Revision | null {
  const list = j.revs;
  if (!list.length) return null;
  let i = fromId ? list.findIndex((r) => r.id === fromId) : list.length - 1;
  if (i < 0) i = list.length - 1;
  const d = list[i].digest;
  for (let k = i - 1; k >= 0; k--) if (list[k].digest !== d) return list[k];
  return null;
}

/** A revision list summarised for the UI in one line, with no noise words. */
export function summary(j: Journal): string {
  const head = j.revs[j.revs.length - 1];
  if (!head) return j.pending ? "unsaved draft" : "no history";
  const distinct = new Set(j.revs.map((r) => r.digest)).size;
  return `${j.revs.length} revisions · ${distinct} distinct · head ${head.bytes} B${j.pending ? " · unsaved" : ""}`;
}
