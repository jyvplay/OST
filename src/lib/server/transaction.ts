import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { pool } from "@/db";

export type TransactionDb = NodePgDatabase<Record<string, never>>;
export interface TransactionOptions {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  accessMode?: "read only" | "read write";
  /** Verify a successful rollback before returning, for isolated restore drills only. */
  rollbackOnly?: boolean;
}

/**
 * One checked-out connection for the entire transaction. BEGIN failures and uncertain
 * COMMIT/ROLLBACK failures discard the client instead of returning it to the pool.
 * PostgreSQL can answer COMMIT with ROLLBACK after a swallowed statement error; that
 * response is not a successful commit. Callbacks must not perform external side effects.
 */
export async function safeTransaction<T>(
  work: (tx: TransactionDb) => Promise<T>,
  options: TransactionOptions = {},
  source: Pick<Pool, "connect"> = pool,
): Promise<T> {
  const client = await source.connect();
  let phase: "acquired" | "active" | "committing" | "closed" = "acquired";
  let discard = false;
  try {
    // Values are restricted to the literals above; callers never supply raw SQL.
    const isolation = options.isolationLevel ? ` ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}` : "";
    const access = options.accessMode ? ` ${options.accessMode.toUpperCase()}` : "";
    await client.query(`BEGIN${isolation}${access}`);
    phase = "active";
    const result = await work(drizzle(client));
    // A drill returns its read-back result only after the server acknowledges ROLLBACK.
    // A lost acknowledgement discards the connection and is not reported as success.
    phase = "committing";
    if (options.rollbackOnly) {
      const outcome = await client.query("ROLLBACK");
      phase = "closed";
      if (outcome.command !== "ROLLBACK") { discard = true; throw new Error("PostgreSQL did not confirm the rollback."); }
    } else {
      const outcome = await client.query("COMMIT");
      phase = "closed";
      if (outcome.command !== "COMMIT") throw new Error("PostgreSQL did not commit the transaction.");
    }
    return result;
  } catch (error) {
    if (phase === "active") {
      try {
        const rolledBack = await client.query("ROLLBACK");
        if (rolledBack.command !== "ROLLBACK") discard = true;
      } catch { discard = true; }
    } else if (phase !== "closed") {
      // COMMIT acknowledgement may be lost: callers must treat the outcome as unknown.
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
