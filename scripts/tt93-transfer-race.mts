/** Forced HTTP/PostgreSQL transfer interleavings; EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing transfer races without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt93-race-${id}`;
const cache = `/System/Cache/thumbs/tt93-race-${id}.txt`, a = `${root}/a.txt`, b = `${root}/b.txt`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await lock.connect(); await db.connect();
const { test, finish } = makeHarness("tt93-transfer-race"), cov = { "FM-03": "partial", "FM-11": "partial", "SC-10": "partial" } as const;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (body: object, url = "/api/fs") => {
  const controller = new AbortController(); const promise = fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  void promise.catch(() => undefined); pending.push({ promise, controller }); return promise;
};
const wait = async (...fragments: string[]) => {
  const until = Date.now() + 8_000;
  do {
    const r = await db.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE ANY($1::text[])", [fragments.map((x) => `%${x}%`)]);
    if (r.rowCount) return; await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < until);
  throw new Error(`No database lock wait observed: ${fragments.join(" or ")}`);
};
const state = async (path: string) => ({ node: (await db.query("SELECT content,trashed FROM vfs_nodes WHERE path=$1", [path])).rows,
  versions: (await db.query("SELECT content FROM vfs_versions WHERE path=$1 ORDER BY id", [path])).rows,
  index: (await db.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows });
const clean = async () => { for (const p of [root, cache]) {
  await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [p]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [p]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [p]);
} };
let inTx = false, safe = true, own = false;
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const outcomes = await Promise.race([Promise.allSettled(pending.map((r) => r.promise)), timeout]); if (timer) clearTimeout(timer);
  if (!outcomes || outcomes.some((r) => r.status === "rejected")) { for (const r of pending) r.controller.abort(); pending.length = 0; return false; }
  pending.length = 0; return true;
};
const guarded: typeof test = async (name, c, fn) => test(name, c, async () => {
  if (!safe) throw new Error(`Prior HTTP outcome unknown; fixtures ${root} and ${cache} retained.`);
  try { await fn(); } finally {
    if (inTx) { try { await lock.query("ROLLBACK"); inTx = false; } catch { safe = false; for (const r of pending) r.controller.abort(); throw new Error("Could not release lock; fixtures retained."); } }
    safe = await settle(); if (!safe) throw new Error("Could not settle HTTP requests; fixtures retained."); await clean();
  }
});
try {
  for (const p of [root, cache]) for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [p])).rowCount, 0);
  const probe = await post({ op: "write", path: a, content: id }); assert.equal(probe.status, 200); assert.equal((await state(a)).node[0]?.content, id, "server/database mismatch");
  own = true; assert.ok(await settle()); await clean();

  await guarded("move waits behind a held cooperative tree gate before reading or publishing", cov, async () => {
    assert.equal((await post({ op: "write", path: a, content: "before" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT pg_advisory_xact_lock(1179997001,1447449413)");
    const moving = post({ op: "move", src: a, dst: b }); await wait("pg_advisory_xact_lock");
    assert.equal((await state(a)).node[0]?.content, "before"); assert.equal((await state(b)).node.length, 0);
    await lock.query("COMMIT"); inTx = false; assert.equal((await moving).status, 200); assert.equal((await state(b)).node[0]?.content, "before");
  });

  await guarded("trash-first cannot be bypassed by a move that later resurrects its stale snapshot", cov, async () => {
    assert.equal((await post({ op: "write", path: a, content: "before" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [a]);
    const trash = post({ op: "trash", path: root }); await wait('update "vfs_nodes"');
    const moving = post({ op: "move", src: a, dst: b }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [trashed, moved] = await Promise.all([trash, moving]);
    assert.equal(trashed.status, 200); assert.notEqual(moved.status, 200);
    assert.deepEqual(await state(a), { node: [{ content: "before", trashed: true }], versions: [], index: [] });
    assert.deepEqual(await state(b), { node: [], versions: [], index: [] });
  });

  await guarded("a completed writer precedes a gated move, including its current bytes and saved version", cov, async () => {
    assert.equal((await post({ op: "write", path: a, content: "before" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [a]);
    const writing = post({ op: "write", path: a, content: "after" }); await wait('for update', 'update "vfs_nodes"');
    const moving = post({ op: "move", src: a, dst: b }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [wrote, moved] = await Promise.all([writing, moving]); assert.equal(wrote.status, 200); assert.equal(moved.status, 200);
    assert.deepEqual(await state(a), { node: [], versions: [], index: [] });
    assert.deepEqual(await state(b), { node: [{ content: "after", trashed: false }], versions: [{ content: "before" }], index: [{ body: "after" }] });
  });

  await guarded("a sidecar save that wins the gate travels atomically with the following photo move", cov, async () => {
    const photo = `${root}/a.jpg`, movedPhoto = `${root}/b.jpg`, side = `${root}/.a.jpg.edit.json`, movedSide = `${root}/.b.jpg.edit.json`;
    assert.equal((await post({ op: "write", path: photo, content: "image", mime: "image/jpeg" })).status, 200);
    assert.equal((await post({ op: "write", path: side, content: "old edits", mime: "application/json" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [side]);
    const saving = post({ op: "write", path: side, content: "new edits", mime: "application/json" }); await wait('for update', 'update "vfs_nodes"');
    const moving = post({ op: "move", src: photo, dst: movedPhoto }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [saved, moved] = await Promise.all([saving, moving]);
    assert.equal(saved.status, 200); assert.equal(moved.status, 200); assert.equal((await moved.json()).sidecar, "followed");
    assert.deepEqual(await state(side), { node: [], versions: [], index: [] });
    assert.deepEqual(await state(movedSide), { node: [{ content: "new edits", trashed: false }], versions: [{ content: "old edits" }], index: [{ body: "new edits" }] });
  });

  await guarded("a cache transfer waits for cache cleanup and does not republish deleted bytes", cov, async () => {
    assert.equal((await post({ op: "write", path: cache, content: "cached secret" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [cache]);
    const clear = post({ confirm: "CLEAR THUMBNAIL CACHE" }, "/api/privacy/thumbnail-cache"); await wait('delete from "vfs_nodes"');
    const moving = post({ op: "move", src: cache, dst: b }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [cleared, moved] = await Promise.all([clear, moving]);
    assert.equal(cleared.status, 200); assert.notEqual(moved.status, 200);
    assert.deepEqual(await state(cache), { node: [], versions: [], index: [] }); assert.deepEqual(await state(b), { node: [], versions: [], index: [] });
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { safe = false; });
  if (own && safe && await settle()) await clean(); else if (own) { console.error(`Fixture ${root} retained; outcome unknown.`); process.exitCode = 1; }
  await lock.end(); await db.end(); finish();
}
