/** Forced ordinary versus conditional VFS writes with real PostgreSQL row locks.
 * Requires an exclusive disposable server/database; the direct SQL lock is test
 * orchestration, not a model of a second production server. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE, token = randomBytes(12).toString("hex"), path = `/System/tt128-writer-${token}.txt`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await lock.connect(); await db.connect();
const { test, finish } = makeHarness("tt128-writer-races");
let inTx = false, own = false, safe = true;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (body: object) => {
  const controller = new AbortController();
  const promise = fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  void promise.catch(() => undefined); pending.push({ promise, controller }); return promise;
};
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const results = await Promise.race([Promise.allSettled(pending.map((x) => x.promise)), timeout]); if (timer) clearTimeout(timer);
  if (!results || results.some((x) => x.status === "rejected")) { for (const x of pending) x.controller.abort(); pending.length = 0; return false; }
  pending.length = 0; return true;
};
const row = async () => (await db.query("SELECT id,version,sha256,content FROM vfs_nodes WHERE path=$1", [path])).rows[0];
const clean = async () => {
  await db.query("DELETE FROM vfs_versions WHERE path=$1", [path]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1", [path]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND ref=$1", [path]);
  await db.query("DELETE FROM file_ops WHERE src=$1", [path]);
  await db.query("DELETE FROM audit_log WHERE detail=$1", [path]);
};
const waitForBlocked = async (minimum: number) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%vfs_nodes%' AND query ILIKE '%for update%'");
    if (result.rowCount !== null && result.rowCount >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Did not observe ${minimum} real SELECT FOR UPDATE lock waiters`);
};
const guarded: typeof test = async (name, covers, fn) => test(name, covers, async () => {
  if (!safe) throw new Error("An earlier request has an unknown outcome; fixture retained");
  try { await fn(); } finally {
    if (inTx) { try { await lock.query("ROLLBACK"); inTx = false; } catch { safe = false; throw new Error("Lock release failed; fixture retained"); } }
    safe = await settle(); if (!safe) throw new Error("HTTP requests did not settle; fixture retained");
    await clean();
  }
});
const seed = async () => {
  assert.equal((await post({ op: "write", path, content: "initial" })).status, 200);
  const current = await row(); return { id: current.id, version: current.version, sha256: current.sha256 };
};
try {
  assert.equal((await db.query("SELECT 1 FROM vfs_nodes WHERE path=$1", [path])).rowCount, 0);
  assert.equal((await post({ op: "write", path, content: token })).status, 200);
  assert.equal((await row())?.content, token, "HTTP server and database do not match"); own = true;
  assert.ok(await settle()); await clean();
  await guarded("ordinary writer commits first: stale conditional writer rejects", { "BK-03": "partial" }, async () => {
    const expected = await seed();
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT id FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const ordinary = post({ op: "write", path, content: "ordinary-first" }); await waitForBlocked(1);
    const conditional = post({ op: "writeIfUnchanged", path, expected, content: "conditional-stale" }); await waitForBlocked(2);
    await lock.query("COMMIT"); inTx = false;
    const [a, b] = await Promise.all([ordinary, conditional]);
    assert.equal(a.status, 200); assert.equal(b.status, 409);
    const final = await row(); assert.equal(final.content, "ordinary-first"); assert.equal(final.version, expected.version + 1);
    assert.deepEqual((await db.query("SELECT content FROM vfs_versions WHERE path=$1 ORDER BY id", [path])).rows.map((x) => x.content), ["initial"]);
  });
  await guarded("conditional writer commits first: a later unconditional write can overwrite it", { "BK-03": "partial" }, async () => {
    const expected = await seed();
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT id FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const conditional = post({ op: "writeIfUnchanged", path, expected, content: "conditional-first" }); await waitForBlocked(1);
    const ordinary = post({ op: "write", path, content: "ordinary-later" }); await waitForBlocked(2);
    await lock.query("COMMIT"); inTx = false;
    const [a, b] = await Promise.all([conditional, ordinary]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const final = await row(); assert.equal(final.content, "ordinary-later"); assert.equal(final.version, expected.version + 2);
    assert.deepEqual((await db.query("SELECT content FROM vfs_versions WHERE path=$1 ORDER BY id", [path])).rows.map((x) => x.content), ["initial", "conditional-first"]);
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { safe = false; });
  if (own && safe && await settle()) await clean(); else if (own) { console.error(`Fixture ${path} retained; outcome unknown`); process.exitCode = 1; }
  await lock.end(); await db.end(); finish();
}
