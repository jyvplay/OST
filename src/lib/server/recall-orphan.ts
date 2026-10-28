/**
 * TT107 — guarded cleanup of a single unpaired Recall file.
 *
 * The pair action deliberately refuses incomplete pairs, so before this turn an
 * orphan could only be removed through generic Files operations with no Recall
 * invariant. This operation trashes exactly one file, and only after proving in
 * the same transaction that its counterpart is genuinely absent.
 */
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, fileOps, indexDocs, vfsNodes } from '@/db/schema';
import { safeTransaction } from './transaction';
import { lockVfsPurge } from './vfs-mutation-lock';
import { ConditionalWriteConflict } from './conditional-write';
import { normalize, sha256 } from './vfs';

const SUFFIX = '.recall.json';

export async function recallOrphanTrash(value: Record<string, unknown>) {
  const { path, expected } = value;
  if (typeof path !== 'string' || path !== normalize(path) || path.length > 512 || /[\u0000-\u001f\u007f]/.test(path)
    || !/^\/Downloads\/Recall\/[^/]+\/[^/]+$/.test(path))
    throw new Error('One canonical Recall file path is required');
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Inspect the file before changing it');
  const want = expected as { id?: unknown; version?: unknown; sha256?: unknown };
  if (!Number.isSafeInteger(want.id) || (want.id as number) <= 0 || !Number.isSafeInteger(want.version) || (want.version as number) <= 0
    || typeof want.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(want.sha256))
    throw new Error('Invalid orphan guard');

  const isReceipt = path.endsWith(SUFFIX);
  const counterpart = isReceipt ? path.slice(0, -SUFFIX.length) : path + SUFFIX;

  try {
    return await safeTransaction(async (tx) => {
      await lockVfsPurge(tx);
      const [node] = await tx.select().from(vfsNodes).where(eq(vfsNodes.path, path)).limit(1).for('update');
      if (!node || node.kind !== 'file') throw new ConditionalWriteConflict('File not found');
      if (node.trashed) throw new ConditionalWriteConflict('File is already in Trash');
      if (node.id !== want.id || node.version !== want.version || node.sha256 !== want.sha256 || sha256(node.content) !== node.sha256)
        throw new ConditionalWriteConflict('File changed since inspection; inspect again');
      // The decisive invariant: only a genuinely unpaired file may be removed here.
      const [other] = await tx.select({ id: vfsNodes.id, trashed: vfsNodes.trashed, kind: vfsNodes.kind })
        .from(vfsNodes).where(eq(vfsNodes.path, counterpart)).limit(1).for('update');
      if (other && other.kind === 'file' && !other.trashed)
        throw new ConditionalWriteConflict('This file is part of a complete pair; use the pair action instead');

      await tx.update(vfsNodes).set({ trashed: true, trashedFrom: path, version: sql`${vfsNodes.version}+1`, updatedAt: new Date() })
        .where(eq(vfsNodes.path, path));
      await tx.delete(indexDocs).where(and(eq(indexDocs.source, 'file'), eq(indexDocs.ref, path)));
      await tx.insert(fileOps).values({ op: 'trash', src: path, state: 'COMPLETE', bytes: node.size });
      await tx.insert(auditLog).values({ actor: 'user', action: 'fs.recall-orphan', detail: path });
      return { ok: true, path, state: 'trashed', counterpartAbsent: true, version: node.version + 1 };
    });
  } catch (error) {
    if (error instanceof ConditionalWriteConflict) throw error;
    throw new Error('Orphan cleanup was not acknowledged. Inspect Files before retrying.');
  }
}
