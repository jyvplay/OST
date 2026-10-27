/** Transactional VFS-write tests, real PostgreSQL trigger failures and simultaneous HTTP writers. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing write-atomic tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt91-write-${id}`, path = `${root}/file.txt`, trigger = `tt91_write_guard_${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("tt91-write-atomic"); const cov = { "FM-18": "partial", "SC-10": "partial" } as const;
const post = async (content: string) => { const r = await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path, content, mime: "text/plain" }) }); return { status: r.status, json: await r.json() }; };
const matches = (col: string) => `(${col}=$1 OR left(${col},char_length($1)+1)=$1||'/')`;
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${matches(col)} LIMIT 1`, [root])).rowCount, 0);
  own = true;
  assert.equal((await post("initial")).status, 200);
  assert.equal((await db.query("SELECT content FROM vfs_nodes WHERE path=$1", [path])).rows[0]?.content, "initial", "server/database mismatch");
  await test("failed index update rolls back content, history and audit; the journal records failure", cov, async () => {
    const audit = (await db.query("SELECT count(*)::int n FROM audit_log WHERE action='fs.write' AND detail=$1", [path])).rows[0].n;
    await db.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='file' AND NEW.ref='${path}' THEN RAISE EXCEPTION 'tt91 index failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON index_docs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      const r = await post("should roll back"); assert.notEqual(r.status, 200);
      assert.deepEqual((await db.query("SELECT content,version FROM vfs_nodes WHERE path=$1", [path])).rows, [{ content: "initial", version: 1 }]);
      assert.equal((await db.query("SELECT count(*)::int n FROM vfs_versions WHERE path=$1", [path])).rows[0].n, 0);
      assert.deepEqual((await db.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows, [{ body: "initial" }]);
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE action='fs.write' AND detail=$1", [path])).rows[0].n, audit);
      const journal = (await db.query("SELECT state,steps FROM file_ops WHERE src=$1 ORDER BY id DESC LIMIT 1", [path])).rows[0];
      assert.equal(journal.state, "FAILED"); assert.ok(!journal.steps.some((x: { state: string }) => x.state === "COMPLETE"));
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON index_docs`); await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`); }
  });
  await test("two simultaneous overwrites preserve both serialized versions and the current search text", cov, async () => {
    const [a, b] = await Promise.all([post("first"), post("second")]); assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(b.status, 200, JSON.stringify(b.json));
    const node = (await db.query("SELECT content,version FROM vfs_nodes WHERE path=$1", [path])).rows[0];
    const versions = (await db.query("SELECT content,version FROM vfs_versions WHERE path=$1 ORDER BY version", [path])).rows;
    assert.equal(node.version, 3); assert.equal(versions.length, 2); assert.deepEqual(versions.map((x: { version: number }) => x.version), [1, 2]);
    assert.equal(versions[0].content, "initial"); assert.deepEqual(new Set([versions[1].content, node.content]), new Set(["first", "second"]));
    assert.equal((await db.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows[0].body, node.content);
  });
} finally {
  await db.query(`DROP TRIGGER IF EXISTS ${trigger} ON index_docs`).catch(() => undefined); await db.query(`DROP FUNCTION IF EXISTS ${trigger}()`).catch(() => undefined);
  if (own) {
    await db.query(`DELETE FROM vfs_versions WHERE ${matches("path")}`, [root]); await db.query(`DELETE FROM vfs_nodes WHERE ${matches("path")}`, [root]); await db.query(`DELETE FROM index_docs WHERE ${matches("ref")}`, [root]);
  }
  await db.end();
}
finish();
