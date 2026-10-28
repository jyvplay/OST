/** Real PostgreSQL + HTTP deletion regressions. Uses exclusive, disposable DB/server and test-only triggers. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing purge tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable DATABASE_URL/server.");
const BASE = process.env.BASE ?? "http://localhost:3999", id = randomBytes(8).toString("hex");
const roots = [`/Documents/tt91-purge-${id}_%`, `/Documents/tt91-purge-${id}AX`, `/Documents/tt91-file-${id}`, `/Documents/tt91-orphan-${id}`, `/Documents/tt91-rollback-${id}`];
const [dir, neighbor, file, orphan, rollback] = roots;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("tt91-purge");
const cov = { "FM-11": "partial", "SC-10": "partial" } as const;
const post = async (body: object) => { const r = await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const must = async (body: object) => { const r = await post(body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const matches = (column: string) => `(${column} = $1 OR left(${column}, char_length($1) + 1) = $1 || '/')`;
const counts = async (root: string) => ({
  nodes: (await db.query(`SELECT count(*)::int n FROM vfs_nodes WHERE ${matches("path")}`, [root])).rows[0].n,
  versions: (await db.query(`SELECT count(*)::int n FROM vfs_versions WHERE ${matches("path")}`, [root])).rows[0].n,
  index: (await db.query(`SELECT count(*)::int n FROM index_docs WHERE source='file' AND ${matches("ref")}`, [root])).rows[0].n,
});
const trigger = `tt91_delete_guard_${id}`;
let safeToClean = false;
try {
  // Literal unique prefixes only; no LIKE interpretation. Exclusive access is still required.
  for (const root of roots) {
    assert.deepEqual(await counts(root), { nodes: 0, versions: 0, index: 0 }, `fixture exists: ${root}`);
    assert.equal((await db.query(`SELECT count(*)::int n FROM index_docs WHERE ${matches("ref")}`, [root])).rows[0].n, 0, `index fixture exists: ${root}`);
  }
  safeToClean = true;
  await test("folder purge removes nested nodes, old versions and search text without touching wildcard-like neighbors", cov, async () => {
    const a = `${dir}/nested/secret.txt`, b = `${neighbor}/nested/keep.txt`, needle = `purgeprobe${id}`;
    await must({ op: "write", path: a, content: `${needle} before` }); await must({ op: "write", path: a, content: `${needle} after` });
    await must({ op: "write", path: b, content: "keep before" }); await must({ op: "write", path: b, content: "keep after" });
    assert.equal((await counts(dir)).versions, 1, "server/database do not match or fixture history missing");
    await db.query("INSERT INTO vfs_versions(path,version,content) VALUES($1,1,'orphan')", [`${dir}/gone.txt`]);
    const before = await fetch(`${BASE}/api/search?q=${needle}&source=file`).then((r) => r.json());
    assert.ok(before.hits.some((h: { ref: string }) => h.ref === a));
    await must({ op: "purge", path: dir });
    const state = await counts(dir); console.log("    post-purge", JSON.stringify(state));
    assert.deepEqual(state, { nodes: 0, versions: 0, index: 0 });
    const remains = await counts(neighbor); assert.ok(remains.nodes > 0 && remains.versions === 1 && remains.index === 1, JSON.stringify(remains));
    const after = await fetch(`${BASE}/api/search?q=${needle}&source=file`).then((r) => r.json());
    assert.ok(!after.hits.some((h: { ref: string }) => h.ref === a));
  });
  await test("file purge removes that file's history and index, and repeating it is safe", cov, async () => {
    await must({ op: "write", path: file, content: "before" }); await must({ op: "write", path: file, content: "after" });
    assert.deepEqual(await counts(file), { nodes: 1, versions: 1, index: 1 });
    await must({ op: "purge", path: file }); await must({ op: "purge", path: file });
    assert.deepEqual(await counts(file), { nodes: 0, versions: 0, index: 0 });
  });
  await test("purge also clears orphaned file history/index, but never other index sources", cov, async () => {
    await db.query("INSERT INTO vfs_versions(path,version,content) VALUES($1,1,'orphan')", [orphan]);
    await db.query("INSERT INTO index_docs(source,ref,title,body) VALUES('file',$1,'orphan','file text'),('note',$1,'other','keep')", [orphan]);
    await must({ op: "purge", path: orphan }); assert.deepEqual(await counts(orphan), { nodes: 0, versions: 0, index: 0 });
    assert.equal((await db.query("SELECT count(*)::int n FROM index_docs WHERE source='note' AND ref=$1", [orphan])).rows[0].n, 1);
  });
  await test("a real SQL failure rolls back nodes, versions, index and audit together", cov, async () => {
    const target = `${rollback}/item.txt`;
    await must({ op: "write", path: target, content: "before" }); await must({ op: "write", path: target, content: "after" });
    const before = await counts(rollback); assert.deepEqual(before, { nodes: 2, versions: 1, index: 1 });
    const beforeAudit = (await db.query("SELECT count(*)::int n FROM audit_log WHERE action='fs.purge' AND detail=$1", [rollback])).rows[0].n;
    // Fail the final data deletion, after versions and nodes would already be
    // gone without a transaction; the rollback assertion must detect that.
    await db.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.source = 'file' AND OLD.ref = '${target}' THEN RAISE EXCEPTION 'tt91 injected delete failure'; END IF; RETURN OLD; END $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE DELETE ON index_docs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      const result = await post({ op: "purge", path: rollback }); assert.notEqual(result.status, 200);
      assert.deepEqual(await counts(rollback), before);
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE action='fs.purge' AND detail=$1", [rollback])).rows[0].n, beforeAudit);
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON index_docs`); await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`); }
  });
  await test("purging root is rejected before any delete statement", cov, async () => {
    // Statement triggers are a destructive-test seatbelt even if the root guard regresses.
    const fn = `${trigger}_root`;
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test root delete seatbelt'; END $$`);
    try {
      for (const table of ["vfs_nodes", "vfs_versions", "index_docs"]) await db.query(`CREATE TRIGGER ${fn} BEFORE DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`);
      const r = await post({ op: "purge", path: "/" });
      assert.notEqual(r.status, 200); assert.match(String(r.body.error), /root/i); assert.doesNotMatch(String(r.body.error), /seatbelt/i);
    } finally {
      for (const table of ["vfs_nodes", "vfs_versions", "index_docs"]) await db.query(`DROP TRIGGER IF EXISTS ${fn} ON ${table}`);
      await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
} finally {
  await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON index_docs`).catch(() => undefined);
  await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`).catch(() => undefined);
  if (safeToClean) for (const root of roots) {
    await db.query(`DELETE FROM vfs_versions WHERE ${matches("path")}`, [root]);
    await db.query(`DELETE FROM vfs_nodes WHERE ${matches("path")}`, [root]);
    await db.query(`DELETE FROM index_docs WHERE ${matches("ref")}`, [root]);
  }
  await db.end();
}
finish();
