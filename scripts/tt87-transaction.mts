/** Real PostgreSQL transaction failure tests; BEGIN/acknowledgement faults are explicitly injected. */
import assert from "node:assert/strict";
import pg from "pg";
import { sql } from "drizzle-orm";
import { notes } from "../src/db/schema.ts";
import { pool } from "../src/db/index.ts";
import { safeTransaction } from "../src/lib/server/transaction.ts";
import { makeHarness } from "./harness.mts";

const RUN = `tt87tx${Date.now().toString(36)}`;
const { test, finish } = makeHarness("tt87-transaction");
const count = async (title: string) => (await pool.query("select count(*)::int n from notes where title=$1", [title])).rows[0].n;
const insert = (tx: any, title: string) => tx.insert(notes).values({ title, body: "transaction fixture", tags: "tt87-transaction" });
try {
  await test("TT87 PostgreSQL rejects an apparent COMMIT when a swallowed SQL error actually produced ROLLBACK", { "BK-03": "full" }, async () => {
    const title = `${RUN}-swallowed`;
    await assert.rejects(safeTransaction(async (tx) => {
      await insert(tx, title);
      try { await tx.execute(sql`select 1 / 0`); } catch { /* deliberately emulate a swallowed SQL error */ }
      return "false success";
    }), /did not commit/);
    assert.equal(await count(title), 0, "PostgreSQL rolled the insert back");
  });
  await test("TT87 a callback failure rolls back a real PostgreSQL write", { "BK-03": "full" }, async () => {
    const title = `${RUN}-rollback`;
    await assert.rejects(safeTransaction(async (tx) => { await insert(tx, title); throw new Error("deliberate callback failure"); }), /deliberate callback failure/);
    assert.equal(await count(title), 0);
  });
  await test("TT87 a real failed BEGIN discards the checked-out pool client", { "BK-03": "partial" }, async () => {
    const isolated = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await isolated.connect(); const query = client.query.bind(client);
    // Deliberately change just BEGIN into invalid SQL: the failure is returned by real PostgreSQL.
    (client as any).query = (q: unknown, ...args: unknown[]) => query(typeof q === "string" && q.startsWith("BEGIN") ? "BEGIN INVALID" : q as any, ...args as []);
    let ran = false;
    try {
      await assert.rejects(safeTransaction(async () => { ran = true; }, {}, { connect: async () => client } as any));
      assert.equal(ran, false); assert.equal(isolated.totalCount, 0, "failed BEGIN client must not leak into the pool");
    } finally { await isolated.end(); }
  });
  await test("TT87 a real query timeout cannot poison the next pool checkout", { "BK-03": "partial" }, async () => {
    const isolated = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, query_timeout: 120, connectionTimeoutMillis: 1500 });
    try {
      await assert.rejects(safeTransaction(async (tx) => { await tx.execute(sql`select pg_sleep(1)`); }, {}, isolated));
      const after = await isolated.query("select 1 as ok");
      assert.equal(after.rows[0].ok, 1, "a fresh checkout must work after the timed-out transaction");
    } finally { await isolated.end(); }
  });
  await test("TT87 a lost commit acknowledgement is reported as unknown even when PostgreSQL committed", { "BK-03": "partial" }, async () => {
    const title = `${RUN}-uncertain`;
    const isolated = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await isolated.connect(); const query = client.query.bind(client);
    // Commit against real PostgreSQL, then inject a lost response before the wrapper sees it.
    (client as any).query = async (q: unknown, ...args: unknown[]) => {
      const result = await query(q as any, ...args as []);
      if (q === "COMMIT") throw new Error("injected lost commit acknowledgement");
      return result;
    };
    try {
      await assert.rejects(safeTransaction(async (tx) => { await insert(tx, title); }, {}, { connect: async () => client } as any), /injected lost commit acknowledgement/);
      assert.equal(await count(title), 1, "the real commit happened despite the missing acknowledgement");
      assert.equal(isolated.totalCount, 0, "uncertain client was discarded");
    } finally { await pool.query("delete from notes where title=$1", [title]); await isolated.end(); }
  });
} finally {
  await pool.query("delete from notes where title like $1", [`${RUN}%`]);
  await pool.end();
}
finish();
