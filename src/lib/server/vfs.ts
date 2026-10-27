import { createHash } from "node:crypto";
import { and, asc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, fileOps, indexDocs, vfsNodes, vfsVersions } from "@/db/schema";
import { safeTransaction, type TransactionDb } from "@/lib/server/transaction";
import { isThumbnailCacheEntry, lockThumbnailCache } from "@/lib/server/thumbnail-cache-lock";
import { lockVfsPurge, lockVfsWriter } from "@/lib/server/vfs-mutation-lock";
import { isSidecar, sidecarPath } from "@/lib/photos/recipe";


/**
 * CRITICAL FIX (v3.3): LIKE treats `_` and `%` as wildcards. v3.0-3.2 built
 * descendant patterns as `${path}/%` unescaped, so purging "/a_b" also deleted
 * everything under "/aXb" (reproduced against the live server: data loss).
 * Every prefix match now goes through escapeLike; backslash is Postgres's
 * default LIKE escape character.
 */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const descendantsOf = (p: string) => `${escapeLike(p === "/" ? "" : p)}/%`;

export const MAX_BYTES = 8 * 1024 * 1024; // honest cap: Postgres text column, not a disk

export type Encoding = "utf8" | "base64";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function normalize(p: string): string {
  if (!p || p === "/") return "/";
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    // zip-slip / traversal hardening also applies to plain path input
    out.push(part.replace(/\u0000/g, ""));
  }
  return "/" + out.join("/");
}

export const parentOf = (p: string) => {
  const n = normalize(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
};
export const baseName = (p: string) => normalize(p).split("/").filter(Boolean).pop() ?? "/";

// guessMime/isTextual moved to the isomorphic src/lib/mime.ts (TT18: the browser privacy layer needs them too)
export { guessMime, isTextual } from "@/lib/mime";
import { guessMime, isTextual, isPrivateVfsPath } from "@/lib/mime";

export async function getNode(path: string) {
  const p = normalize(path);
  const rows = await db.select().from(vfsNodes).where(eq(vfsNodes.path, p)).limit(1);
  return rows[0] ?? null;
}

export async function listDir(path: string, includeTrashed = false) {
  const p = normalize(path);
  const rows = await db
    .select()
    .from(vfsNodes)
    .where(includeTrashed ? eq(vfsNodes.parent, p) : and(eq(vfsNodes.parent, p), eq(vfsNodes.trashed, false)))
    .orderBy(asc(vfsNodes.kind), asc(vfsNodes.name));
  return rows;
}

export async function ensureDir(path: string) {
  const p = normalize(path);
  if (p === "/") return;
  const segments = p.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segments) {
    const parent = cur === "" ? "/" : cur;
    cur = `${parent === "/" ? "" : parent}/${seg}`;
    const existing = await getNode(cur);
    if (!existing) {
      await db.insert(vfsNodes).values({
        path: cur, parent, name: seg, kind: "dir", mime: "inode/directory", encoding: "utf8",
      }).onConflictDoNothing();
    }
  }
}

export class InvalidVfsDirectory extends Error {}

/** Validate the whole parent chain in the caller's transaction. A trashed
 * path remains occupied: writing below it would hide new files in trash. */
export async function writableDirectories(tx: TransactionDb, path: string, create: boolean) {
  let cur = ""; const paths: string[] = [];
  for (const segment of normalize(path).split("/").filter(Boolean)) {
    const parent = cur || "/"; cur = `${cur}/${segment}`; paths.push(cur);
    if (create) await tx.insert(vfsNodes).values({ path: cur, parent, name: segment, kind: "dir", mime: "inode/directory", encoding: "utf8" }).onConflictDoNothing();
  }
  if (!paths.length) return;
  const rows = await tx.select({ path: vfsNodes.path, kind: vfsNodes.kind, trashed: vfsNodes.trashed }).from(vfsNodes).where(inArray(vfsNodes.path, paths));
  const found = new Map(rows.map((row) => [row.path, row]));
  for (const p of paths) {
    const row = found.get(p);
    if (!row || row.kind !== "dir" || row.trashed) throw new InvalidVfsDirectory(`Folder is missing, not a folder, or in Trash: ${p}. Restore it before writing here.`);
  }
}

/** Optional cooperative guard for a public photo recipe, not an authentication mechanism. */
export interface ExpectedPhoto { path: string; id: number; version: number; sha256: string }
/** null means no recipe existed; undefined retains the legacy unconditional behavior. */
export type ExpectedRecipe = { id: number; version: number; sha256: string } | null;
export class PhotoRecipeConflict extends Error {}

export function parseExpectedPhoto(value: unknown, target: string): ExpectedPhoto | undefined {
  if (value === undefined) return undefined; // Legacy callers remain unconditional.
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expectedPhoto must identify a public photo");
  const x = value as Record<string, unknown>;
  if (typeof x.path !== "string" || !x.path.startsWith("/") || x.path !== normalize(x.path) || x.path === "/"
    || /[\u0000-\u001f\u007f]/.test(x.path) || isSidecar(x.path) || isPrivateVfsPath(x.path)
    || target !== normalize(target) || sidecarPath(x.path) !== target
    || !Number.isSafeInteger(x.id) || Number(x.id) <= 0 || !Number.isSafeInteger(x.version) || Number(x.version) <= 0
    || typeof x.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.sha256)) {
    throw new Error("expectedPhoto must match the canonical public photo owning this recipe");
  }
  return { path: x.path, id: Number(x.id), version: Number(x.version), sha256: x.sha256 };
}

export function parseExpectedRecipe(value: unknown, owner: ExpectedPhoto | undefined): ExpectedRecipe | undefined {
  if (value === undefined) return undefined; // Older clients remain unconditional.
  if (!owner) throw new Error("expectedRecipe requires a matching public photo guard");
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expectedRecipe must be null or a recipe id, version and SHA-256");
  const x = value as Record<string, unknown>;
  if (!Number.isSafeInteger(x.id) || Number(x.id) <= 0 || !Number.isSafeInteger(x.version) || Number(x.version) <= 0
    || typeof x.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.sha256)) {
    throw new Error("expectedRecipe must be null or a recipe id, version and SHA-256");
  }
  return { id: Number(x.id), version: Number(x.version), sha256: x.sha256 };
}

function checkExpectedRecipe(node: typeof vfsNodes.$inferSelect | undefined, expected: ExpectedRecipe): void {
  const changed = expected === null ? !!node : !node || node.kind !== "file" || node.trashed
    || node.id !== expected.id || node.version !== expected.version || node.sha256 !== expected.sha256 || sha256(node.content) !== expected.sha256;
  if (changed) throw new PhotoRecipeConflict("The photo recipe changed or is unavailable; reopen the photo before saving edits.");
}

async function checkExpectedPhoto(tx: TransactionDb, expected: ExpectedPhoto): Promise<void> {
  // The tree gate is already held. Lock the owner so ordinary writes cannot
  // change it between this check and publication/deletion of the recipe.
  const [owner] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, expected.path)).limit(1).for("update");
  if (!owner || owner.kind !== "file" || owner.trashed || !owner.mime.startsWith("image/") || owner.id !== expected.id
    || owner.version !== expected.version || owner.sha256 !== expected.sha256 || sha256(owner.content) !== expected.sha256) {
    throw new PhotoRecipeConflict("The photo moved, was replaced, changed or is unavailable; reopen it before saving edits.");
  }
}

export interface WriteArgs {
  path: string;
  content: string;
  encoding?: Encoding;
  mime?: string;
  reason?: string;
  expectedPhoto?: ExpectedPhoto;
  /** Optional compare-and-write for the recipe itself; requires expectedPhoto. */
  expectedRecipe?: unknown;
  /** Snapshot the previous database version before replacing it. */
  snapshot?: boolean;
}

/**
 * Transactional VFS write. The journal begins outside the data transaction so
 * failed attempts remain visible; publish, history, index and COMPLETE commit
 * together. Historical journal labels include COPYING_TO_TEMP, but this path
 * has no temp/reopen validation and is not the native SAF safe-save contract.
 * Current writes share a cooperative gate with tree trash/restore/purge.
 */
export async function writeFile(args: WriteArgs) {
  const expectedPhoto = parseExpectedPhoto(args.expectedPhoto, args.path);
  const expectedRecipe = parseExpectedRecipe(args.expectedRecipe, expectedPhoto);
  const path = normalize(args.path);
  if (path === "/") throw new Error("Refusing to write the VFS root");
  const name = baseName(path), parent = parentOf(path);
  const encoding: Encoding = args.encoding ?? "utf8";
  const mime = args.mime ?? guessMime(name);
  const size = Buffer.byteLength(args.content, encoding === "base64" ? "base64" : "utf8");
  if (size > MAX_BYTES) throw new Error(`File exceeds the ${MAX_BYTES} byte store limit (${size})`);
  const digest = sha256(args.content);
  const [op] = await db.insert(fileOps).values({ op: "write", src: path, state: "REQUESTED", bytes: size })
    .returning({ id: fileOps.id });
  const steps: { state: string; at: string }[] = [{ state: "REQUESTED", at: new Date().toISOString() }];
  const step = async (state: string, extra: Partial<typeof fileOps.$inferInsert> = {}) => {
    steps.push({ state, at: new Date().toISOString() });
    await db.update(fileOps).set({ state, steps, updatedAt: new Date(), ...extra }).where(eq(fileOps.id, op.id));
  };
  try {
    await step("COPYING_TO_TEMP");
    if (sha256(args.content) !== digest) throw new Error("digest mismatch before publish");
    await step("DEST_VERIFIED", { sha256: digest });
    const identity = await safeTransaction(async (tx) => {
      // Global shared writer gate must precede the cache-specific exclusive gate.
      await lockVfsWriter(tx);
      if (isThumbnailCacheEntry(path)) await lockThumbnailCache(tx);
      await writableDirectories(tx, parent, true);
      if (expectedPhoto) await checkExpectedPhoto(tx, expectedPhoto);
      const [prev] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, path)).limit(1).for("update");
      if (expectedRecipe !== undefined) checkExpectedRecipe(prev, expectedRecipe);
      let written: { id: number; version: number }[];
      if (prev) {
        if (prev.trashed) throw new Error(`This path is in Trash: ${path}. Restore or permanently delete it before writing here.`);
        if (prev.kind !== "file") throw new Error(`This path is a folder: ${path}`);
        if (args.snapshot !== false) await tx.insert(vfsVersions).values({ path, version: prev.version, encoding: prev.encoding, content: prev.content, size: prev.size, sha256: prev.sha256, reason: args.reason ?? "write" });
        written = await tx.update(vfsNodes).set({ content: args.content, encoding, mime, size, sha256: digest, version: prev.version + 1, updatedAt: new Date(), trashed: false }).where(eq(vfsNodes.path, path)).returning({ id: vfsNodes.id, version: vfsNodes.version });
        if (written.length !== 1) throw new Error("File changed during write");
      } else {
        const insert = tx.insert(vfsNodes).values({ path, parent, name, kind: "file", mime, encoding, content: args.content, size, sha256: digest });
        // A missing row cannot be locked. An ordinary writer may insert this
        // path concurrently, so guarded creation must also be conflict-safe.
        written = expectedRecipe === null
          ? await insert.onConflictDoNothing({ target: vfsNodes.path }).returning({ id: vfsNodes.id, version: vfsNodes.version })
          : await insert.returning({ id: vfsNodes.id, version: vfsNodes.version });
        if (!written.length) throw new PhotoRecipeConflict("The photo recipe was created concurrently; reopen the photo before saving edits.");
      }
      if (isPrivateVfsPath(path)) await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), eq(indexDocs.ref, path)));
      else {
        const body = isTextual(mime) && encoding === "utf8" ? args.content.slice(0, 50_000) : "";
        await tx.insert(indexDocs).values({ source: "file", ref: path, title: name, body, updatedAt: new Date() })
          .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: name, body, updatedAt: new Date() } });
      }
      await tx.insert(auditLog).values({ actor: "user", action: "fs.write", detail: path });
      const at = new Date().toISOString();
      const completeSteps = [...steps, { state: "DEST_PUBLISHED", at }, { state: "COMPLETE", at }];
      await tx.update(fileOps).set({ state: "COMPLETE", steps: completeSteps, sha256: digest, updatedAt: new Date() }).where(eq(fileOps.id, op.id));
      return written[0];
    });
    return { ok: true, path, size, sha256: digest, opId: op.id, ...identity };
  } catch (err) {
    // If COMMIT succeeded but its acknowledgement was lost, do not overwrite COMPLETE.
    await db.update(fileOps).set({ state: "FAILED", error: String((err as Error).message ?? err), steps, updatedAt: new Date() })
      .where(and(eq(fileOps.id, op.id), ne(fileOps.state, "COMPLETE"))).catch(() => undefined);
    throw err;
  }
}

/**
 * Database-local move/copy. A single transaction holds the cooperating tree
 * gate, verifies each source file's stored bytes, updates paths/history/index,
 * and records COMPLETE. Legacy journal step names are retained for the Jobs
 * UI; there is no external temp file, native SAF replacement, pause/resume, or
 * cross-database crash recovery. A lost COMMIT acknowledgement is unknown.
 */
export async function transferNode(src: string, dst: string, mode: "move" | "copy") {
  const from = normalize(src), to = normalize(dst);
  if (from === "/" || to === "/") throw new Error("refusing to transfer the root");
  if (to === from) throw new Error("source and destination are identical");
  if (to.startsWith(`${from}/`)) throw new Error("refusing to move a directory into itself");
  const sourcePattern = descendantsOf(from), destPattern = descendantsOf(to), cache = "/System/Cache/thumbs";
  const touchesCache = (p: string) => p === cache || cache.startsWith(`${p}/`) || isThumbnailCacheEntry(p);
  // REQUESTED survives an ordinary transaction rollback; COMPLETE is written in
  // the same transaction as publication, never afterwards in a second commit.
  const [op] = await db.insert(fileOps).values({ op: mode, src: from, dst: to, state: "REQUESTED" }).returning({ id: fileOps.id });
  const requested = { state: "REQUESTED", at: new Date().toISOString() };
  try {
    const followedSidecar = await safeTransaction(async (tx) => {
      await lockVfsPurge(tx);
      if (touchesCache(from) || touchesCache(to)) await lockThumbnailCache(tx);
      await writableDirectories(tx, parentOf(from), false);
      const rows = await tx.select({
        path: vfsNodes.path, parent: vfsNodes.parent, name: vfsNodes.name, kind: vfsNodes.kind,
        trashed: vfsNodes.trashed, size: vfsNodes.size, sha256: vfsNodes.sha256,
        actual: sql<string>`CASE WHEN ${vfsNodes.kind} = 'file' THEN encode(sha256(convert_to(${vfsNodes.content}, 'UTF8')), 'hex') ELSE '' END`,
      }).from(vfsNodes).where(or(eq(vfsNodes.path, from), like(vfsNodes.path, sourcePattern))).orderBy(asc(vfsNodes.path));
      const root = rows.find((row) => row.path === from);
      if (!root) throw new Error(`not found: ${from}`);
      if (root.trashed) throw new Error(`This source is in Trash: ${from}. Restore it before transferring.`);
      if (root.kind !== "dir" && root.kind !== "file") throw new Error("Unsupported source kind");
      if (root.kind === "file" && rows.length !== 1) throw new Error("The source file has unexpected descendants");
      const byPath = new Map(rows.map((row) => [row.path, row]));
      for (const row of rows) {
        if (row.trashed) throw new Error("The source tree contains a separately trashed item. Restore or permanently delete it before transferring the folder.");
        if ((row.kind !== "dir" && row.kind !== "file") || row.parent !== parentOf(row.path) || row.name !== baseName(row.path)) throw new Error("The source tree has inconsistent metadata");
        if (row.path !== from && byPath.get(row.parent)?.kind !== "dir") throw new Error("The source tree has a missing or invalid parent");
        if (row.kind === "file" && row.actual !== row.sha256) throw new Error(`Source checksum mismatch: ${row.path}`);
      }
      // Preserve orphan histories instead of joining them to an unrelated new
      // file. Literal escaped prefixes also prevent %/_ neighbor collisions.
      const [destNode] = await tx.select({ path: vfsNodes.path }).from(vfsNodes)
        .where(or(eq(vfsNodes.path, to), like(vfsNodes.path, destPattern))).limit(1);
      const [destVersion] = await tx.select({ path: vfsVersions.path }).from(vfsVersions)
        .where(or(eq(vfsVersions.path, to), like(vfsVersions.path, destPattern))).limit(1);
      const [destIndex] = await tx.select({ ref: indexDocs.ref }).from(indexDocs)
        .where(and(eq(indexDocs.source, "file"), or(eq(indexDocs.ref, to), like(indexDocs.ref, destPattern)))).limit(1);
      if (destNode || destVersion || destIndex) throw new Error(`destination exists or has retained data: ${to}`);

      // A photo and its named recipe form one public-VFS asset. Reserve the
      // destination sidecar even if this source has no recipe: otherwise an
      // unrelated existing recipe could become attached to the moved photo.
      // Encrypted Private names cannot reveal their logical sidecar mapping to
      // this server; the browser layer would need to provide that separately.
      let sideFrom: string | null = null, sideTo: string | null = null, hasSidecar = false;
      if (root.kind === "file" && !isSidecar(from) && !isPrivateVfsPath(from) && !isPrivateVfsPath(to)) {
        sideFrom = sidecarPath(from); sideTo = sidecarPath(to);
        const sideSourcePattern = descendantsOf(sideFrom), sideDestPattern = descendantsOf(sideTo);
        const sideRows = await tx.select({ path: vfsNodes.path, parent: vfsNodes.parent, name: vfsNodes.name,
          kind: vfsNodes.kind, trashed: vfsNodes.trashed, sha256: vfsNodes.sha256,
          actual: sql<string>`CASE WHEN ${vfsNodes.kind} = 'file' THEN encode(sha256(convert_to(${vfsNodes.content}, 'UTF8')), 'hex') ELSE '' END`,
        }).from(vfsNodes).where(or(eq(vfsNodes.path, sideFrom), like(vfsNodes.path, sideSourcePattern)));
        if (sideRows.length) {
          const side = sideRows.find((row) => row.path === sideFrom);
          if (sideRows.length !== 1 || !side || side.kind !== "file" || side.trashed || side.parent !== parentOf(sideFrom) || side.name !== baseName(sideFrom) || side.actual !== side.sha256) throw new Error("The source sidecar is missing, trashed, corrupt or has inconsistent metadata");
          hasSidecar = true;
        }
        const [sideDestNode] = await tx.select({ path: vfsNodes.path }).from(vfsNodes)
          .where(or(eq(vfsNodes.path, sideTo), like(vfsNodes.path, sideDestPattern))).limit(1);
        const [sideDestVersion] = await tx.select({ path: vfsVersions.path }).from(vfsVersions)
          .where(or(eq(vfsVersions.path, sideTo), like(vfsVersions.path, sideDestPattern))).limit(1);
        const [sideDestIndex] = await tx.select({ ref: indexDocs.ref }).from(indexDocs)
          .where(and(eq(indexDocs.source, "file"), or(eq(indexDocs.ref, sideTo), like(indexDocs.ref, sideDestPattern)))).limit(1);
        if (sideDestNode || sideDestVersion || sideDestIndex) throw new Error(`destination sidecar exists or has retained data: ${sideTo}`);
      }
      await writableDirectories(tx, parentOf(to), true);

      if (mode === "move") {
        // Expressions read the old row values. Source and destination subtrees
        // are disjoint, so unique paths never overlap during this rewrite.
        await tx.execute(sql`
          UPDATE vfs_nodes SET
            path = ${to} || substring(path FROM char_length(${from}) + 1),
            parent = CASE WHEN path = ${from} THEN ${parentOf(to)} ELSE ${to} || substring(parent FROM char_length(${from}) + 1) END,
            name = CASE WHEN path = ${from} THEN ${baseName(to)} ELSE name END,
            updated_at = now()
          WHERE path = ${from} OR path LIKE ${sourcePattern}
        `);
        await tx.execute(sql`
          UPDATE vfs_versions SET path = ${to} || substring(path FROM char_length(${from}) + 1)
          WHERE path = ${from} OR path LIKE ${sourcePattern}
        `);
        await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), or(eq(indexDocs.ref, from), like(indexDocs.ref, sourcePattern))));
      } else {
        // A copy is an independent current snapshot, not a copy of the source
        // history. Keep content in PostgreSQL rather than buffering a tree in JS.
        await tx.execute(sql`
          INSERT INTO vfs_nodes (path, parent, name, kind, mime, encoding, content, size, sha256, tags)
          SELECT ${to} || substring(path FROM char_length(${from}) + 1),
            CASE WHEN path = ${from} THEN ${parentOf(to)} ELSE ${to} || substring(parent FROM char_length(${from}) + 1) END,
            CASE WHEN path = ${from} THEN ${baseName(to)} ELSE name END,
            kind, mime, encoding, content, size, sha256, tags
          FROM vfs_nodes WHERE path = ${from} OR path LIKE ${sourcePattern}
        `);
      }
      if (hasSidecar && sideFrom && sideTo) {
        if (mode === "move") {
          await tx.update(vfsNodes).set({ path: sideTo, parent: parentOf(sideTo), name: baseName(sideTo), updatedAt: new Date() }).where(eq(vfsNodes.path, sideFrom));
          await tx.update(vfsVersions).set({ path: sideTo }).where(eq(vfsVersions.path, sideFrom));
          await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), eq(indexDocs.ref, sideFrom)));
        } else {
          await tx.execute(sql`
            INSERT INTO vfs_nodes (path, parent, name, kind, mime, encoding, content, size, sha256, tags)
            SELECT ${sideTo}, ${parentOf(sideTo)}, ${baseName(sideTo)}, kind, mime, encoding, content, size, sha256, tags
            FROM vfs_nodes WHERE path = ${sideFrom}
          `);
        }
      }
      // Rebuild every destination file's title/body, not only the tree root.
      // The server never indexes /Private, including raw-client transfers.
      await tx.execute(sql`
        INSERT INTO index_docs (source, ref, title, body, updated_at)
        SELECT 'file', path, name,
          CASE WHEN encoding = 'utf8' AND (mime LIKE 'text/%' OR mime IN ('application/json', 'image/svg+xml'))
            THEN left(content, 50000) ELSE '' END, now()
        FROM vfs_nodes
        WHERE (path = ${to} OR path LIKE ${destPattern} OR (${hasSidecar} AND path = ${sideTo})) AND kind = 'file'
          AND path <> '/Private' AND path NOT LIKE '/Private/%'
        ON CONFLICT (source, ref) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at
      `);
      const at = new Date().toISOString();
      const states = ["COPYING_TO_TEMP", "DEST_VERIFIED", "DEST_PUBLISHED", ...(mode === "move" ? ["SOURCE_RETIRE"] : []), "COMPLETE"];
      await tx.update(fileOps).set({ state: "COMPLETE", bytes: root.size, sha256: root.sha256,
        steps: [requested, ...states.map((state) => ({ state, at }))], updatedAt: new Date() }).where(eq(fileOps.id, op.id));
      await tx.insert(auditLog).values({ actor: "user", action: `fs.${mode}`,
        detail: isPrivateVfsPath(from) || isPrivateVfsPath(to) ? "/Private/…" : `${from} -> ${to}` });
      return hasSidecar;
    });
    return { ok: true, opId: op.id, from, to, ...(followedSidecar ? { sidecar: "followed" } : {}) };
  } catch (err) {
    // A lost COMMIT acknowledgement might mean COMPLETE actually committed.
    // Never overwrite that state with FAILED, and do not log SQL parameters
    // from potentially sensitive private paths into the journal.
    const message = isPrivateVfsPath(from) || isPrivateVfsPath(to) ? "Private transfer could not be confirmed" : String((err as Error).message ?? err).slice(0, 500);
    await db.update(fileOps).set({ state: "FAILED", error: message, steps: [requested], updatedAt: new Date() })
      .where(and(eq(fileOps.id, op.id), ne(fileOps.state, "COMPLETE"))).catch(() => undefined);
    throw err;
  }
}

/** Reversible tree trash. Descendants keep their own earlier trash group; the
 * search index and journal are changed in the same transaction as the nodes. */
export async function trashNode(path: string) {
  const p = normalize(path);
  if (p === "/") throw new Error("Refusing to trash the VFS root");
  const pattern = descendantsOf(p), thumbnailRoot = "/System/Cache/thumbs";
  await safeTransaction(async (tx) => {
    await lockVfsPurge(tx);
    if (p === thumbnailRoot || thumbnailRoot.startsWith(`${p}/`) || isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);
    const [node] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, p)).limit(1).for("update");
    if (!node) throw new Error(`not found: ${p}`);
    if (node.trashed) return; // do not reset the original deletion time/group
    await tx.update(vfsNodes).set({ trashed: true, trashedFrom: p, updatedAt: new Date() })
      .where(and(eq(vfsNodes.trashed, false), or(eq(vfsNodes.path, p), like(vfsNodes.path, pattern))));
    await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), or(eq(indexDocs.ref, p), like(indexDocs.ref, pattern))));
    await tx.insert(fileOps).values({ op: "trash", src: p, state: "COMPLETE", bytes: node.size });
    await tx.insert(auditLog).values({ actor: "user", action: "fs.trash", detail: isPrivateVfsPath(p) ? "/Private/…" : p });
  });
  return { ok: true };
}

/** Restore only nodes that belonged to the selected trash group. Independent
 * earlier deletions stay in trash. A legacy null group is ambiguous, so only
 * the selected node is restored; descendants can be restored individually.
 * Index rebuild runs in PostgreSQL, without loading all file bodies into JS. */
export async function restoreNode(path: string) {
  const p = normalize(path);
  if (p === "/") throw new Error("Refusing to restore the VFS root");
  const pattern = descendantsOf(p), thumbnailRoot = "/System/Cache/thumbs";
  await safeTransaction(async (tx) => {
    await lockVfsPurge(tx);
    if (p === thumbnailRoot || thumbnailRoot.startsWith(`${p}/`) || isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);
    const [node] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, p)).limit(1).for("update");
    if (!node || !node.trashed) return; // idempotent; do not revive other trash groups
    await writableDirectories(tx, parentOf(p), false);
    await tx.execute(sql`
      WITH restored AS (
        UPDATE vfs_nodes SET trashed = false, trashed_from = NULL, updated_at = now()
        WHERE trashed = true AND (path = ${p} OR path LIKE ${pattern})
          AND (path = ${p} OR (trashed_from = ${node.trashedFrom} AND ${node.trashedFrom}::text IS NOT NULL))
        RETURNING path, name, kind, mime, encoding, content
      )
      INSERT INTO index_docs (source, ref, title, body, updated_at)
      SELECT 'file', path, name,
        CASE WHEN encoding = 'utf8' AND (mime LIKE 'text/%' OR mime IN ('application/json', 'image/svg+xml'))
          THEN left(content, 50000) ELSE '' END, now()
      FROM restored
      WHERE kind = 'file' AND path <> '/Private' AND path NOT LIKE '/Private/%'
      ON CONFLICT (source, ref) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at
    `);
    await tx.insert(fileOps).values({ op: "restore", src: p, state: "COMPLETE", bytes: node.size });
    await tx.insert(auditLog).values({ actor: "user", action: "fs.restore", detail: isPrivateVfsPath(p) ? "/Private/…" : p });
  });
  return { ok: true };
}

export async function purgeNode(path: string, guard?: ExpectedPhoto, recipeGuard?: unknown) {
  const expectedPhoto = parseExpectedPhoto(guard, path);
  const expectedRecipe = parseExpectedRecipe(recipeGuard, expectedPhoto);
  const p = normalize(path);
  if (p === "/") throw new Error("Refusing to purge the VFS root");
  const pattern = descendantsOf(p), cache = "/System/Cache/thumbs";
  // Removing current nodes but leaving their versions or descendant search
  // snippets makes "delete permanently" misleading. Keep these row deletions
  // and the audit record atomic; this is not secure erasure of external copies.
  await safeTransaction(async (tx) => {
    await lockVfsPurge(tx);
    if (p === cache || cache.startsWith(`${p}/`) || isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);
    if (expectedPhoto) await checkExpectedPhoto(tx, expectedPhoto);
    if (expectedRecipe !== undefined) {
      const [current] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, p)).limit(1).for("update");
      checkExpectedRecipe(current, expectedRecipe);
    }
    // An observed-absent clear is a no-op for data. In particular it must not
    // remove a new row, index or history created after the absence check.
    if (expectedRecipe !== null) {
      await tx.delete(vfsVersions).where(or(eq(vfsVersions.path, p), like(vfsVersions.path, pattern)));
      await tx.delete(vfsNodes).where(or(eq(vfsNodes.path, p), like(vfsNodes.path, pattern)));
      await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), or(eq(indexDocs.ref, p), like(indexDocs.ref, pattern))));
    }
    await tx.insert(auditLog).values({ actor: "user", action: "fs.purge", detail: isPrivateVfsPath(p) ? "/Private/…" : p });
  });
  return { ok: true };
}

export async function mkdir(path: string) {
  const p = normalize(path);
  await safeTransaction(async (tx) => {
    await lockVfsWriter(tx);
    if (isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);
    await writableDirectories(tx, p, true);
    await tx.insert(auditLog).values({ actor: "user", action: "fs.mkdir", detail: isPrivateVfsPath(p) ? "/Private/…" : p });
  });
  return { ok: true, path: p };
}

export async function folderSize(path: string) {
  const p = normalize(path);
  const rows = await db
    .select({ bytes: sql<number>`coalesce(sum(${vfsNodes.size}),0)`, files: sql<number>`count(*) filter (where ${vfsNodes.kind} = 'file')`, dirs: sql<number>`count(*) filter (where ${vfsNodes.kind} = 'dir')` })
    .from(vfsNodes)
    .where(and(like(vfsNodes.path, descendantsOf(p)), eq(vfsNodes.trashed, false)));
  // TT55: `files` counted folders too; now files and folders are separate (FM-17 shows "N files · M folders")
  return { bytes: Number(rows[0]?.bytes ?? 0), files: Number(rows[0]?.files ?? 0), dirs: Number(rows[0]?.dirs ?? 0) };
}

/**
 * Forgets the stored history of ONE file (TT18 metadata cleaning: an overwrite would otherwise keep the
 * original — EXIF, authors — as a previous version). Irreversible by design; the current node is kept.
 */
export async function dropVersions(path: string) {
  const p = normalize(path);
  const dropped = await safeTransaction(async (tx) => {
    await lockVfsWriter(tx);
    if (isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);
    const [node] = await tx.select({ kind: vfsNodes.kind }).from(vfsNodes).where(eq(vfsNodes.path, p)).limit(1).for("update");
    if (!node || node.kind !== "file") throw new Error(`not a file: ${p}`);
    const gone = await tx.delete(vfsVersions).where(eq(vfsVersions.path, p)).returning({ v: vfsVersions.version });
    await tx.insert(auditLog).values({ actor: "user", action: "fs.dropVersions", detail: isPrivateVfsPath(p) ? `/Private/… (${gone.length})` : `${p} (${gone.length})` });
    return gone.length;
  });
  return { ok: true, path: p, dropped };
}

/** Tagging participates in tree moves and locks the actual node, so a request
 * queued behind a move cannot claim to have tagged a now-missing source. */
export async function setTags(path: string, tags: string) {
  const p = normalize(path);
  await safeTransaction(async (tx) => {
    await lockVfsWriter(tx);
    if (isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);
    const [node] = await tx.select({ id: vfsNodes.id }).from(vfsNodes).where(eq(vfsNodes.path, p)).limit(1).for("update");
    if (!node) throw new Error(`not found: ${p}`);
    await tx.update(vfsNodes).set({ tags }).where(eq(vfsNodes.id, node.id));
  });
  return { ok: true };
}

export async function versionsOf(path: string) {
  return db.select().from(vfsVersions).where(eq(vfsVersions.path, normalize(path))).orderBy(asc(vfsVersions.version));
}
