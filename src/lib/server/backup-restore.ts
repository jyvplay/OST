import { and, eq, inArray } from "drizzle-orm";
import { safeTransaction, type TransactionDb } from "@/lib/server/transaction";
import { lockVfsPurge } from "@/lib/server/vfs-mutation-lock";
import { isThumbnailCacheEntry, lockThumbnailCache } from "@/lib/server/thumbnail-cache-lock";
import { auditLog, fileOps, indexDocs, notes, settings, settingsHistory, vfsNodes, vfsVersions } from "@/db/schema";
import { canonicalJson, type BackupEntry, type BackupNote, type BackupPayload } from "@/lib/backup/bundle";
import { ENCRYPTED_MIME, isPrivateVfsPath, isTextual, refuseEncryptedOverwrite } from "@/lib/mime";
import { validateSetting } from "@/lib/settings-validate";
import { baseName, parentOf, sha256 } from "@/lib/server/vfs";

type Tx = TransactionDb;
type NodeRow = typeof vfsNodes.$inferSelect;
type SettingRow = typeof settings.$inferSelect;
type NoteRow = typeof notes.$inferSelect;

export class RestoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export interface RestoreSummary {
  filesCreate: number; filesReplace: number; filesUnchanged: number;
  foldersCreate: number; foldersRevive: number; notesAdd: number; notesUnchanged: number;
  settingsChange: number; settingsUnchanged: number; settingsLocked: string[]; settingsUnknown: string[];
}
interface RestorePlan {
  token: string;
  summary: RestoreSummary;
  paths: string[];
  nodes: Map<string, NodeRow>;
  settingRows: Map<string, SettingRow>;
  notesToAdd: BackupNote[];
}
const emptySummary = (): RestoreSummary => ({
  filesCreate: 0, filesReplace: 0, filesUnchanged: 0, foldersCreate: 0, foldersRevive: 0,
  notesAdd: 0, notesUnchanged: 0, settingsChange: 0, settingsUnchanged: 0, settingsLocked: [], settingsUnknown: [],
});
const sameFile = (node: NodeRow, e: BackupEntry) => !node.trashed && node.kind === "file" && node.content === e.content
  && node.encoding === e.encoding && node.mime === e.mime && node.tags === e.tags && node.size === e.size && node.sha256 === e.sha256;
const noteKey = (n: BackupNote) => canonicalJson(n);
const noteFromRow = (n: NoteRow): BackupNote => ({
  title: n.title, body: n.body, tags: n.tags, pinned: n.pinned,
  createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString(),
});

/** Calculate a plan from the same transaction snapshot used for the eventual write. */
async function buildPlan(tx: Tx, payload: BackupPayload, digest: string): Promise<RestorePlan> {
  const paths = new Set<string>();
  for (const entry of payload.entries) {
    let p = entry.path;
    while (p !== "/") { paths.add(p); p = parentOf(p); }
  }
  const sortedPaths = [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const nodes = new Map<string, NodeRow>();
  // Chunking prevents hitting PostgreSQL's parameter limit on large snapshots.
  for (let i = 0; i < sortedPaths.length; i += 500) {
    const rows = await tx.select().from(vfsNodes).where(inArray(vfsNodes.path, sortedPaths.slice(i, i + 500)));
    for (const row of rows) nodes.set(row.path, row);
  }
  const byPath = new Map(payload.entries.map((entry) => [entry.path, entry]));
  const summary = emptySummary();
  for (const path of sortedPaths) {
    const existing = nodes.get(path);
    const entry = byPath.get(path);
    const desiredKind = entry?.kind ?? "dir";
    if (existing && existing.kind !== desiredKind) throw new RestoreError(`${path} is an existing ${existing.kind}; a ${desiredKind} is required. Nothing was restored.`);
    if (desiredKind === "dir") {
      if (!existing) summary.foldersCreate += 1;
      else if (existing.trashed) summary.foldersRevive += 1;
      continue;
    }
    if (!entry) throw new RestoreError(`Missing file entry for ${path}.`);
    if (!existing) summary.filesCreate += 1;
    else {
      try { refuseEncryptedOverwrite(existing, entry.content, false); }
      catch (e) { throw new RestoreError(String((e as Error).message)); }
      if (existing.mime === ENCRYPTED_MIME && entry.mime !== ENCRYPTED_MIME) throw new RestoreError(`${path} is encrypted; refusing to replace it with a non-encrypted file.`);
      if (sameFile(existing, entry)) summary.filesUnchanged += 1;
      else summary.filesReplace += 1;
    }
  }

  const settingRows = new Map<string, SettingRow>();
  const settingKeys = payload.settings.map((s) => s.key).sort();
  for (let i = 0; i < settingKeys.length; i += 500) {
    for (const row of await tx.select().from(settings).where(inArray(settings.key, settingKeys.slice(i, i + 500)))) settingRows.set(row.key, row);
  }
  for (const item of payload.settings) {
    const current = settingRows.get(item.key);
    if (!current) { summary.settingsUnknown.push(item.key); continue; }
    if (current.lockReason) { summary.settingsLocked.push(item.key); continue; }
    const invalid = validateSetting(item.key, item.value);
    if (invalid) throw new RestoreError(`Invalid setting ${item.key}: ${invalid}. Nothing was restored.`, 422);
    if (current.value === item.value) summary.settingsUnchanged += 1;
    else summary.settingsChange += 1;
  }
  summary.settingsLocked.sort(); summary.settingsUnknown.sort();

  // Equal note content AND timestamps identify an existing copy. Count occurrences so
  // two genuinely identical source notes are not silently collapsed into one.
  const wanted = new Set(payload.notes.map(noteKey));
  const existingCount = new Map<string, number>();
  if (wanted.size) {
    for (const row of await tx.select().from(notes)) {
      const key = noteKey(noteFromRow(row));
      if (wanted.has(key)) existingCount.set(key, (existingCount.get(key) ?? 0) + 1);
    }
  }
  const used = new Map<string, number>();
  const notesToAdd: BackupNote[] = [];
  for (const note of payload.notes) {
    const key = noteKey(note); const count = used.get(key) ?? 0;
    used.set(key, count + 1);
    if (count < (existingCount.get(key) ?? 0)) summary.notesUnchanged += 1;
    else { summary.notesAdd += 1; notesToAdd.push(note); }
  }

  // Bind preview to both the exact payload and all destination rows affecting the plan.
  // This is a stale-preview guard, not an authentication mechanism.
  const nodeState = sortedPaths.map((path) => {
    const n = nodes.get(path);
    return n ? { path, id: n.id, kind: n.kind, trashed: n.trashed, version: n.version, encoding: n.encoding,
      mime: n.mime, size: n.size, tags: n.tags, contentHash: sha256(n.content), updatedAt: n.updatedAt.toISOString() } : { path, absent: true };
  });
  const settingState = settingKeys.map((key) => {
    const row = settingRows.get(key);
    return row ? { key, value: row.value, lockReason: row.lockReason } : { key, absent: true };
  });
  const noteState = [...wanted].sort().map((key) => ({ key, count: existingCount.get(key) ?? 0 }));
  const token = sha256(canonicalJson({ digest, nodeState, settingState, noteState }));
  return { token, summary, paths: sortedPaths, nodes, settingRows, notesToAdd };
}

/** Shared restore engine; the caller provides the destination transaction. */
export async function restoreInTransaction(tx: Tx, payload: BackupPayload, digest: string, dryRun: boolean, token?: string) {
    const plan = await buildPlan(tx, payload, digest);
    if (dryRun) return { previewToken: plan.token, summary: plan.summary };
    if (!token || token !== plan.token) throw new RestoreError("The destination changed since preview, or no preview was provided. Preview the restore again.");

    const entries = new Map(payload.entries.map((e) => [e.path, e]));
    for (const path of plan.paths) {
      const existing = plan.nodes.get(path);
      const entry = entries.get(path);
      if ((entry?.kind ?? "dir") !== "dir") continue;
      if (!existing) {
        await tx.insert(vfsNodes).values({ path, parent: parentOf(path), name: baseName(path), kind: "dir", mime: "inode/directory", encoding: "utf8", tags: entry?.tags ?? "" });
      } else if (existing.trashed) {
        // Existing directory tags are deliberately preserved; a backup is a merge, not a destructive mirror.
        await tx.update(vfsNodes).set({ trashed: false, trashedFrom: null, updatedAt: new Date() }).where(eq(vfsNodes.path, path));
      }
    }
    for (const entry of payload.entries) {
      if (entry.kind !== "file") continue;
      const existing = plan.nodes.get(entry.path);
      if (existing && sameFile(existing, entry)) continue;
      if (existing) {
        await tx.insert(vfsVersions).values({ path: entry.path, version: existing.version, encoding: existing.encoding,
          content: existing.content, size: existing.size, sha256: existing.sha256, reason: "restore" });
        await tx.update(vfsNodes).set({ content: entry.content, encoding: entry.encoding, mime: entry.mime, size: entry.size,
          tags: entry.tags, sha256: entry.sha256, version: existing.version + 1, updatedAt: new Date(), trashed: false, trashedFrom: null }).where(eq(vfsNodes.path, entry.path));
      } else {
        await tx.insert(vfsNodes).values({ path: entry.path, parent: parentOf(entry.path), name: baseName(entry.path), kind: "file",
          content: entry.content, encoding: entry.encoding, mime: entry.mime, size: entry.size, tags: entry.tags, sha256: entry.sha256 });
      }
      if (isPrivateVfsPath(entry.path)) {
        await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), eq(indexDocs.ref, entry.path)));
      } else {
        const body = isTextual(entry.mime) && entry.encoding === "utf8" ? entry.content.slice(0, 50_000) : "";
        await tx.insert(indexDocs).values({ source: "file", ref: entry.path, title: baseName(entry.path), body, updatedAt: new Date() })
          .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: baseName(entry.path), body, updatedAt: new Date() } });
      }
    }
    for (const note of plan.notesToAdd) {
      const [added] = await tx.insert(notes).values({ ...note, createdAt: new Date(note.createdAt), updatedAt: new Date(note.updatedAt) }).returning();
      await tx.insert(indexDocs).values({ source: "note", ref: String(added.id), title: added.title, body: added.body })
        .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: added.title, body: added.body, updatedAt: new Date() } });
    }
    for (const item of payload.settings) {
      const current = plan.settingRows.get(item.key);
      if (!current || current.lockReason || current.value === item.value) continue;
      await tx.insert(settingsHistory).values({ key: item.key, oldValue: current.value, newValue: item.value });
      await tx.update(settings).set({ value: item.value, updatedAt: new Date() }).where(eq(settings.key, item.key));
    }
    const at = new Date().toISOString();
    await tx.insert(fileOps).values({ op: "restore", src: "backup bundle", state: "COMPLETE", sha256: digest,
      steps: ["REQUESTED", "DEST_VERIFIED", "DEST_PUBLISHED", "COMPLETE"].map((state) => ({ state, at })) });
    // Do not put file names, note bodies, or setting values into this audit message.
    await tx.insert(auditLog).values({ actor: "user", action: "backup.restore", detail: `${payload.kind}: ${plan.summary.filesCreate + plan.summary.filesReplace} files, ${plan.summary.notesAdd} notes, ${plan.summary.settingsChange} settings` });
    return { previewToken: plan.token, summary: plan.summary };
}

/**
 * A restore is a single serializable PostgreSQL transaction, including file snapshots,
 * search index, settings history, notes and journal. No individual failure is ignored.
 */
export async function restoreBackup(payload: BackupPayload, digest: string, dryRun: boolean, token?: string) {
  return safeTransaction(async (tx) => {
    if (!dryRun && payload.entries.length) {
      // Match the lock order of tree transfers: tree gate first, cache gate
      // second. A serializable snapshot can still become stale while waiting;
      // PostgreSQL may then abort and the caller must preview again.
      await lockVfsPurge(tx);
      const cache = "/System/Cache/thumbs";
      if (payload.entries.some(({ path }) => path === cache || cache.startsWith(`${path}/`) || isThumbnailCacheEntry(path))) await lockThumbnailCache(tx);
    }
    return restoreInTransaction(tx, payload, digest, dryRun, token);
  }, { isolationLevel: "serializable" });
}
