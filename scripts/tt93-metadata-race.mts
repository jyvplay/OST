/** Forced metadata/version versus transfer interleavings, EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing metadata races without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt93-meta-${id}`, a = `${root}/a.txt`, b = `${root}/b.txt`, fn = `tt93_meta_${id}`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await lock.connect(); await db.connect();
const { test, finish } = makeHarness("tt93-metadata-race"), cov = { "FM-03": "partial", "FM-18": "partial", "SC-10": "partial" } as const;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (body: object) => {
  const controller = new AbortController(); const promise = fetch(BASE + "/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  void promise.catch(() => undefined); pending.push({ promise, controller }); return promise;
};
const wait = async (...fragments: string[]) => {
  const until = Date.now() + 8_000;
  do { const r = await db.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE ANY($1::text[])", [fragments.map((x) => `%${x}%`)]); if (r.rowCount) return; await new Promise((resolve) => setTimeout(resolve, 40)); } while (Date.now() < until);
  throw new Error(`No database lock wait observed: ${fragments.join(" or ")}`);
};
const state = async (p: string) => ({ node: (await db.query("SELECT content,tags FROM vfs_nodes WHERE path=$1", [p])).rows,
  versions: (await db.query("SELECT content FROM vfs_versions WHERE path=$1 ORDER BY id", [p])).rows,
  index: (await db.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [p])).rows });
const clean = async () => {
  await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
};
let inTx = false, safe = true, own = false;
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const outcomes = await Promise.race([Promise.allSettled(pending.map((r) => r.promise)), timeout]); if (timer) clearTimeout(timer);
  if (!outcomes || outcomes.some((r) => r.status === "rejected")) { for (const r of pending) r.controller.abort(); pending.length = 0; return false; }
  pending.length = 0; return true;
};
const guarded: typeof test = async (name, c, f) => test(name, c, async () => {
  if (!safe) throw new Error(`Prior HTTP outcome unknown; ${root} retained.`);
  try { await f(); } finally {
    if (inTx) { try { await lock.query("ROLLBACK"); inTx = false; } catch { safe = false; for (const r of pending) r.controller.abort(); throw new Error("Could not release lock; fixture retained."); } }
    safe = await settle(); if (!safe) throw new Error("Could not settle HTTP requests; fixture retained."); await clean();
  }
});
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  const probe = await post({ op: "write", path: a, content: id }); assert.equal(probe.status, 200); assert.equal((await state(a)).node[0]?.content, id, "server/database mismatch");
  own = true; assert.ok(await settle()); await clean();

  await guarded("history removal and its audit are atomic when the audit insert fails", cov, async () => {
    assert.equal((await post({ op: "write", path: a, content: "old" })).status, 200); assert.equal((await post({ op: "write", path: a, content: "new" })).status, 200);
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='fs.dropVersions' AND NEW.detail LIKE '${a}%' THEN RAISE EXCEPTION 'tt93 metadata audit fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      assert.notEqual((await post({ op: "dropVersions", path: a })).status, 200);
      assert.deepEqual(await state(a), { node: [{ content: "new", tags: "" }], versions: [{ content: "old" }], index: [{ body: "new" }] });
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON audit_log`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  });

  await guarded("a move already in progress preserves its history before a later dropVersions can act", cov, async () => {
    assert.equal((await post({ op: "write", path: a, content: "old" })).status, 200); assert.equal((await post({ op: "write", path: a, content: "new" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [a]);
    const move = post({ op: "move", src: a, dst: b }); await wait('update vfs_nodes');
    const drop = post({ op: "dropVersions", path: a }); await wait("pg_advisory_xact_lock_shared");
    await lock.query("COMMIT"); inTx = false; const [moved, dropped] = await Promise.all([move, drop]);
    assert.equal(moved.status, 200); assert.notEqual(dropped.status, 200);
    assert.deepEqual(await state(b), { node: [{ content: "new", tags: "" }], versions: [{ content: "old" }], index: [{ body: "new" }] });
  });

  await guarded("a tag update queued behind a move cannot report success on a vanished source", cov, async () => {
    assert.equal((await post({ op: "write", path: a, content: "file" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [a]);
    const move = post({ op: "move", src: a, dst: b }); await wait('update vfs_nodes');
    const tag = post({ op: "tag", path: a, tags: "later" }); await wait("pg_advisory_xact_lock_shared");
    await lock.query("COMMIT"); inTx = false; const [moved, tagged] = await Promise.all([move, tag]);
    assert.equal(moved.status, 200); assert.notEqual(tagged.status, 200);
    assert.deepEqual(await state(b), { node: [{ content: "file", tags: "" }], versions: [], index: [{ body: "file" }] });
  });

  await guarded("a tag update that wins the gate is preserved by the following move", cov, async () => {
    assert.equal((await post({ op: "write", path: a, content: "file" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [a]);
    const tag = post({ op: "tag", path: a, tags: "before-move" }); await wait('update "vfs_nodes"', 'for update');
    const move = post({ op: "move", src: a, dst: b }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [tagged, moved] = await Promise.all([tag, move]);
    assert.equal(tagged.status, 200); assert.equal(moved.status, 200);
    assert.deepEqual(await state(b), { node: [{ content: "file", tags: "before-move" }], versions: [], index: [{ body: "file" }] });
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { safe = false; });
  if (own && safe && await settle()) await clean(); else if (own) { console.error(`Fixture ${root} retained; outcome unknown.`); process.exitCode = 1; }
  await lock.end(); await db.end(); finish();
}
