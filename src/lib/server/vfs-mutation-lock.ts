import { sql } from "drizzle-orm";
import type { TransactionDb } from "./transaction";

/**
 * Cooperative read/write gate for tree trash/restore/purge versus current
 * ordinary, conditional, mkdir, tag and history-removal VFS writes. Shared writer locks permit
 * unrelated writes to run concurrently; tree operations take the exclusive
 * form. Current move/copy and file-bearing backup restore also take the
 * exclusive form. Acquire this before the thumbnail-cache lock. Older servers,
 * some internal directory creation and raw SQL do not take it,
 * so this is not a universal filesystem or secure-deletion guarantee.
 */
export async function lockVfsWriter(tx: TransactionDb): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(1179997001, 1447449413)`);
}
export async function lockVfsPurge(tx: TransactionDb): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(1179997001, 1447449413)`);
}
