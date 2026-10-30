/** Real HTTP and PostgreSQL compare-and-write adversarial checks, disposable server only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const base = process.env.BASE, nonce = randomBytes(12).toString("hex"), path = `/System/tt127-cas-${nonce}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("tt127-conditional");
const write = async (expected: object | null, content: string) => {
  const r = await fetch(`${base}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "writeIfUnchanged", path, expected, content, encoding: "utf8" }) });
  return { status: r.status, json: await r.json() };
};
const read = async () => (await db.query("SELECT id,version,sha256,content,trashed FROM vfs_nodes WHERE path=$1", [path])).rows[0];
let owned = false;
try {
  if ((await db.query("SELECT 1 FROM vfs_nodes WHERE path=$1", [path])).rowCount) throw new Error("Fixture already exists");
  const [a, b] = await Promise.all([write(null, "candidate-a"), write(null, "candidate-b")]);
  const row = await read();
  // Prove the server and explicit DB are the same before any deletion.
  assert.ok(row && ["candidate-a", "candidate-b"].includes(row.content), "server/database mismatch"); owned = true;
  await test("concurrent create allows exactly one winner and returns its committed identity", {}, () => {
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const winner = a.status === 200 ? a : b;
    assert.equal(winner.json.id, row.id); assert.equal(winner.json.version, row.version); assert.equal(winner.json.sha256, row.sha256);
  });
  await test("two writers from one snapshot yield one success, no lost update", {}, async () => {
    const expected = { id: row.id, version: row.version, sha256: row.sha256 };
    const outcomes = await Promise.all([write(expected, "next-a"), write(expected, "next-b")]);
    assert.deepEqual(outcomes.map((x) => x.status).sort(), [200, 409]);
    const now = await read(), winner = outcomes.find((x) => x.status === 200)!;
    assert.equal(now.id, row.id); assert.equal(now.version, row.version + 1); assert.equal(now.sha256, winner.json.sha256);
    assert.ok(["next-a", "next-b"].includes(now.content));
  });
  await test("stale identity, modified content, and trashed destination refuse writes", {}, async () => {
    let now = await read(), expected = { id: now.id, version: now.version, sha256: now.sha256 };
    assert.equal((await write({ ...expected, version: expected.version - 1 }, "stale")).status, 409);
    await db.query("UPDATE vfs_nodes SET content='tampered' WHERE path=$1", [path]);
    assert.equal((await write(expected, "do-not-write")).status, 409);
    await db.query("UPDATE vfs_nodes SET content=$2, trashed=true WHERE path=$1", [path, now.content]);
    assert.equal((await write(expected, "do-not-resurrect")).status, 409);
    const restored = await read(); assert.equal(restored.content, now.content); assert.equal(restored.trashed, true);
  });
} finally {
  if (owned) {
    await db.query("DELETE FROM vfs_versions WHERE path=$1", [path]);
    await db.query("DELETE FROM vfs_nodes WHERE path=$1", [path]);
    await db.query("DELETE FROM index_docs WHERE source='file' AND ref=$1", [path]);
    await db.query("DELETE FROM file_ops WHERE src=$1", [path]);
    await db.query("DELETE FROM audit_log WHERE detail=$1", [path]);
  }
  await db.end(); finish();
}
