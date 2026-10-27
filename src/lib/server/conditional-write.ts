/** Compare-and-write for folder sync; unlike a list-then-write, a concurrent VFS edit is not overwritten. */
import { and, eq } from "drizzle-orm";
import { safeTransaction } from "@/lib/server/transaction";
import { isThumbnailCacheEntry, lockThumbnailCache } from "@/lib/server/thumbnail-cache-lock";
import { lockVfsWriter } from "@/lib/server/vfs-mutation-lock";
import { auditLog, fileOps, indexDocs, vfsNodes, vfsVersions } from "@/db/schema";
import { ENCRYPTED_MIME, isPrivateVfsPath, isTextual } from "@/lib/mime";
import { baseName, guessMime, InvalidVfsDirectory, MAX_BYTES, normalize, parentOf, sha256, writableDirectories } from "@/lib/server/vfs";

export interface ExpectedFile { id: number; version: number; sha256: string }
export class ConditionalWriteConflict extends Error {}

export async function conditionalWriteFile(path: string, content: string, expected: ExpectedFile | null, encoding: "utf8" | "base64", requestedMime?: string) {
  if (!path.startsWith("/") || path !== normalize(path) || path === "/" || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("A canonical absolute file path is required");
  if (content.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)
    || (encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
    || Buffer.byteLength(content, encoding) > MAX_BYTES) throw new Error("Invalid or oversized file content");
  if (requestedMime && (requestedMime.length > 256 || /[\u0000-\u001f\u007f]/.test(requestedMime))) throw new Error("Invalid MIME type");
  const parent = parentOf(path), name = baseName(path), digest = sha256(content), size = Buffer.byteLength(content, encoding);
  return safeTransaction(async (tx) => {
    await lockVfsWriter(tx);
    if (isThumbnailCacheEntry(path)) await lockThumbnailCache(tx);
    if (parent !== "/") {
      const [dir] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, parent)).for("update");
      if (!dir || dir.kind !== "dir" || dir.trashed) throw new ConditionalWriteConflict(`Parent folder is missing or not writable: ${parent}`);
      try { await writableDirectories(tx, parent, false); }
      catch (error) {
        if (error instanceof InvalidVfsDirectory) throw new ConditionalWriteConflict(`An ancestor folder is missing or in Trash: ${parent}`);
        throw error;
      }
    }
    const [existing] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, path)).for("update");
    let mime = requestedMime || guessMime(name);
    if (expected === null) {
      if (existing) throw new ConditionalWriteConflict("The destination already exists; sync again.");
      const created = await tx.insert(vfsNodes).values({ path, parent, name, kind: "file", mime, encoding, content, size, sha256: digest })
        .onConflictDoNothing({ target: vfsNodes.path }).returning({ id: vfsNodes.id });
      if (!created.length) throw new ConditionalWriteConflict("The destination was created concurrently; sync again.");
    } else {
      if (!existing || existing.kind !== "file" || existing.trashed || existing.encoding !== encoding || existing.mime === ENCRYPTED_MIME || existing.id !== expected.id
        || existing.version !== expected.version || existing.sha256 !== expected.sha256 || sha256(existing.content) !== expected.sha256) {
        throw new ConditionalWriteConflict("The Fusion copy changed since the conflict was shown; sync again.");
      }
      mime = existing.mime;
      await tx.insert(vfsVersions).values({ path, version: existing.version, encoding: existing.encoding, content: existing.content,
        size: existing.size, sha256: existing.sha256, reason: "conflict-keep-local" });
      await tx.update(vfsNodes).set({ content, size, sha256: digest, version: existing.version + 1, updatedAt: new Date() }).where(eq(vfsNodes.path, path));
    }
    if (isPrivateVfsPath(path)) await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), eq(indexDocs.ref, path)));
    else {
      const body = isTextual(mime) && encoding === "utf8" ? content.slice(0, 50_000) : "";
      await tx.insert(indexDocs).values({ source: "file", ref: path, title: name, body, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: name, body, updatedAt: new Date() } });
    }
    const at = new Date().toISOString();
    await tx.insert(fileOps).values({ op: "write", src: path, state: "COMPLETE", bytes: size, sha256: digest,
      steps: ["REQUESTED", "DEST_VERIFIED", "DEST_PUBLISHED", "COMPLETE"].map((state) => ({ state, at })) });
    await tx.insert(auditLog).values({ actor: "user", action: "fs.sync-write", detail: isPrivateVfsPath(path) ? "/Private/…" : path });
    return { ok: true, path, sha256: digest, size };
  });
}
