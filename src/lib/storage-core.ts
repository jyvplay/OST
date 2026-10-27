/**
 * AP-02 / FM-07 pure storage & uninstall-assistant model (DOM-free, Node-testable).
 *
 * Contract:
 * 1. Every user-owned data store is represented as a named bucket with live row counts, byte totals and sample items.
 * 2. System tables (`features`, `spikes`, `license_authority`) and `/System` VFS files are never purgeable through
 *    the uninstall assistant.
 * 3. `validatePurgeRequest` refuses any request without `op === "purge"`, an explicit non-empty list of valid bucket
 *    ids, and the exact confirmation token `"DELETE"`.
 * 4. `summarizePreview` and `verifyPostPurge` provide a deterministic pre/post-condition oracle: a purge must zero
 *    every selected bucket and leave every unselected bucket untouched.
 */

export const SERVER_BUCKET_IDS = [
  "vfs_user",
  "trash",
  "versions",
  "notes",
  "alerts",
  "planner",
  "settings",
  "sessions",
] as const;

export type ServerBucketId = (typeof SERVER_BUCKET_IDS)[number];

export interface BucketMeta {
  id: ServerBucketId;
  label: string;
  description: string;
}

export const SERVER_BUCKETS: readonly BucketMeta[] = [
  { id: "vfs_user", label: "User files & folders", description: "Active files and folders outside /System in the VFS" },
  { id: "trash", label: "Trash", description: "Trashed files and folders awaiting permanent removal" },
  { id: "versions", label: "Version history & file journal", description: "Timeline snapshots (vfs_versions) and file-operation journal (file_ops)" },
  { id: "notes", label: "Notes & calculator history", description: "Local-first Markdown notes and persisted calculator tape" },
  { id: "alerts", label: "Alerts history", description: "Saved notification center alerts and snooze/focus state" },
  { id: "planner", label: "Planner tasks, events & routines", description: "Tasks, imported calendar events and automation routines" },
  { id: "settings", label: "Settings & saved sessions", description: "Custom settings overrides, change history and saved window presets/sessions" },
  { id: "sessions", label: "Cast, Together & diagnostic logs", description: "Beam sessions, Together rooms, WebRTC signals, capability reports and audit log" },
] as const;

const VALID_IDS = new Set<string>(SERVER_BUCKET_IDS);

export interface BucketStat {
  id: ServerBucketId;
  label: string;
  description: string;
  rows: number;
  bytes: number;
  samples: string[];
}

export interface UninstallPreview {
  buckets: BucketStat[];
  totalRows: number;
  totalBytes: number;
  samples: string[];
}

export function validateBucketSelection(input: unknown): { ok: true; buckets: ServerBucketId[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "buckets must be an array of bucket ids" };
  if (input.length === 0) return { ok: false, error: "select at least one data bucket" };
  const out: ServerBucketId[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string" || !VALID_IDS.has(item)) {
      return { ok: false, error: `unknown or protected storage bucket: ${String(item)}` };
    }
    if (seen.has(item)) {
      return { ok: false, error: `duplicate bucket id: ${item}` };
    }
    seen.add(item);
    out.push(item as ServerBucketId);
  }
  return { ok: true, buckets: out };
}

export function validatePurgeRequest(body: unknown): { ok: true; buckets: ServerBucketId[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "request body must be a JSON object" };
  const rec = body as Record<string, unknown>;
  if (rec.op !== "purge") return { ok: false, error: "op must be 'purge'" };
  if (rec.confirm !== "DELETE") return { ok: false, error: "confirmation token must be the exact string 'DELETE'" };
  return validateBucketSelection(rec.buckets);
}

export function summarizePreview(allBuckets: readonly BucketStat[], selectedIds: readonly ServerBucketId[]): UninstallPreview {
  const want = new Set<ServerBucketId>(selectedIds);
  const buckets = allBuckets.filter((b) => want.has(b.id)).map((b) => ({
    ...b,
    rows: Math.max(0, Math.trunc(Number(b.rows) || 0)),
    bytes: Math.max(0, Math.trunc(Number(b.bytes) || 0)),
    samples: b.samples.slice(0, 5),
  }));
  const totalRows = buckets.reduce((acc, b) => acc + b.rows, 0);
  const totalBytes = buckets.reduce((acc, b) => acc + b.bytes, 0);
  const samples = buckets.flatMap((b) => b.samples.map((s) => `${b.label}: ${s}`)).slice(0, 12);
  return { buckets, totalRows, totalBytes, samples };
}

export function verifyPostPurge(
  before: readonly BucketStat[],
  after: readonly BucketStat[],
  purgedIds: readonly ServerBucketId[],
): { ok: boolean; errors: string[] } {
  const purged = new Set<ServerBucketId>(purgedIds);
  const beforeMap = new Map(before.map((b) => [b.id, b]));
  const afterMap = new Map(after.map((b) => [b.id, b]));
  const errors: string[] = [];
  for (const id of SERVER_BUCKET_IDS) {
    const b0 = beforeMap.get(id);
    const b1 = afterMap.get(id);
    if (!b0 || !b1) {
      errors.push(`missing bucket stat for ${id}`);
      continue;
    }
    if (purged.has(id)) {
      if (b1.rows !== 0 || b1.bytes !== 0) {
        errors.push(`purged bucket ${id} still has ${b1.rows} rows / ${b1.bytes} bytes`);
      }
    } else if (id === "sessions") {
      // A purge that does not clear `sessions` records one audit_log entry, so rows may stay equal or increase by 1.
      if (b1.rows < b0.rows || b1.rows > b0.rows + 1) {
        errors.push(`unselected bucket sessions changed unexpectedly from ${b0.rows} to ${b1.rows} rows`);
      }
    } else if (b1.rows !== b0.rows || b1.bytes !== b0.bytes) {
      errors.push(`unselected bucket ${id} changed from (${b0.rows} rows, ${b0.bytes} B) to (${b1.rows} rows, ${b1.bytes} B)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface KvStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export interface BrowserBucketReport {
  keys: string[];
  rows: number;
  bytes: number;
  samples: string[];
}

export function inspectBrowserStorage(storage: KvStorageLike | null | undefined): BrowserBucketReport {
  if (!storage) return { keys: [], rows: 0, bytes: 0, samples: [] };
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) keys.push(k);
  }
  keys.sort();
  let bytes = 0;
  for (const k of keys) {
    const v = storage.getItem(k) ?? "";
    bytes += (k.length + v.length) * 2;
  }
  return {
    keys,
    rows: keys.length,
    bytes,
    samples: keys.slice(0, 5),
  };
}

export function clearBrowserStorage(storage: KvStorageLike | null | undefined): { removed: number; bytesFreed: number } {
  const report = inspectBrowserStorage(storage);
  if (!storage) return { removed: 0, bytesFreed: 0 };
  for (const k of report.keys) storage.removeItem(k);
  return { removed: report.rows, bytesFreed: report.bytes };
}
