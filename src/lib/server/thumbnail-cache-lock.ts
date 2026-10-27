import { sql } from "drizzle-orm";
import type { TransactionDb } from "./transaction";

/** A transaction-scoped, database-wide cooperative lock for ordinary thumbnail-cache
 * writes, explicit cache cleanup, overlapping current tree operations and file-bearing
 * backup restores. Older/nonparticipating operations and raw SQL do not take it. */
export async function lockThumbnailCache(tx: TransactionDb): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(1179997001, 1414024514)`);
}

/** Input must already be normalized; the cache directory itself is not a cached file. */
export const isThumbnailCacheEntry = (path: string) => path.startsWith("/System/Cache/thumbs/");
