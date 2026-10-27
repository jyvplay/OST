/** Forced interleavings against real HTTP/PostgreSQL; exclusive disposable database/server only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing trash-race tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt92-trash-race-${id}`, path = `${root}/item.txt`, peer = `/Documents/tt92-trash-peer-${id}/item.txt`, cache = `/System/Cache/thumbs/tt92-${id}.txt`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), observer = new pg.Client({ connectionString: process.env.DATABASE_URL }); await lock.connect(); await observer.connect();
const { test, finish } = makeHarness("tt92-trash-race"), cov = { "FM-11": "partial", "SC-10": "partial" } as const;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (body: object, url = "/api/fs") => { const controller = new AbortController(), promise = fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }); void promise.catch(() => undefined); pending.push({ promise, controller }); return promise; };
const state = async (p = path) => ({ node: (await observer.query("SELECT content,trashed FROM vfs_nodes WHERE path=$1", [p])).rows,
  versions: (await observer.query("SELECT content FROM vfs_versions WHERE path=$1 ORDER BY version", [p])).rows,
  index: (await observer.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [p])).rows });
const clean = async () => { for (const p of [root, peer.slice(0, peer.lastIndexOf("/")), cache]) {
  await observer.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [p]);
  await observer.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [p]);
  await observer.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [p]);
} };
const wait = async (...fragments: string[]) => {
  const end = Date.now() + 12_000;
  do { const r = await observer.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE ANY($1::text[])", [fragments.map((x) => `%${x}%`)]); if (r.rowCount) return; await new Promise((resolve) => setTimeout(resolve, 40)); } while (Date.now() < end);
  throw new Error(`No lock wait observed for ${fragments.join(" or ")}`);
};
let inTx = false, cleanupSafe = true, own = false;
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const results = await Promise.race([Promise.allSettled(pending.map((p) => p.promise)), timeout]); if (timer) clearTimeout(timer);
  if (!results || results.some((r) => r.status === "rejected")) { for (const p of pending) p.controller.abort(); pending.length = 0; return false; }
  pending.length = 0; return true;
};
const safeTest: typeof test = async (name, c, f) => test(name, c, async () => {
  if (!cleanupSafe) throw new Error(`Previous request outcome unknown; fixtures ${root} and ${cache} retained.`);
  try { await f(); } finally {
    if (inTx) { try { await lock.query("ROLLBACK"); inTx = false; } catch { cleanupSafe = false; for (const p of pending) p.controller.abort(); throw new Error("Could not release test lock; fixtures retained."); } }
    cleanupSafe = await settle(); if (!cleanupSafe) throw new Error("Unknown HTTP outcome; fixtures retained."); await clean();
  }
});
try {
  for (const p of [root, peer.slice(0, peer.lastIndexOf("/")), cache]) for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) assert.equal((await observer.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [p])).rowCount, 0);
  own = true;
  await safeTest("trash-first blocks a subsequent ordinary write rather than overwriting the retained file", cov, async () => {
    assert.equal((await post({ op: "write", path, content: "before" })).status, 200); assert.equal((await state()).node[0].content, "before", "server/database mismatch");
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const trash = post({ op: "trash", path: root }); await wait('update "vfs_nodes"');
    const write = post({ op: "write", path, content: "after" }); await wait("pg_advisory_xact_lock", 'for update');
    await lock.query("COMMIT"); inTx = false; const [gone, saved] = await Promise.all([trash, write]);
    assert.equal(gone.status, 200); assert.notEqual(saved.status, 200);
    assert.deepEqual(await state(), { node: [{ content: "before", trashed: true }], versions: [], index: [] });
  });
  await safeTest("tree trash holds its cooperative exclusive gate until its transaction finishes", cov, async () => {
    assert.equal((await post({ op: "write", path, content: "before" })).status, 200); assert.equal((await post({ op: "write", path: peer, content: "peer" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const trash = post({ op: "trash", path: root }); await wait('update "vfs_nodes"');
    const write = post({ op: "write", path: peer, content: "peer after" }); await wait("pg_advisory_xact_lock_shared");
    await lock.query("COMMIT"); inTx = false; const [gone, saved] = await Promise.all([trash, write]); assert.equal(gone.status, 200); assert.equal(saved.status, 200);
    assert.deepEqual(await state(peer), { node: [{ content: "peer after", trashed: false }], versions: [{ content: "peer" }], index: [{ body: "peer after" }] });
  });
  await safeTest("write-first is snapshotted and hidden by subsequent tree trash, then search returns after restore", cov, async () => {
    assert.equal((await post({ op: "write", path, content: "before" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const write = post({ op: "write", path, content: "after" }); await wait('for update');
    const trash = post({ op: "trash", path: root }); await wait("pg_advisory_xact_lock", 'update "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false; const [saved, gone] = await Promise.all([write, trash]); assert.equal(saved.status, 200); assert.equal(gone.status, 200);
    assert.deepEqual(await state(), { node: [{ content: "after", trashed: true }], versions: [{ content: "before" }], index: [] });
    assert.equal((await post({ op: "restore", path: root })).status, 200);
    assert.deepEqual(await state(), { node: [{ content: "after", trashed: false }], versions: [{ content: "before" }], index: [{ body: "after" }] });
  });
  await safeTest("conditional-write-first and trash cooperate without a visible search remnant", cov, async () => {
    assert.equal((await post({ op: "write", path, content: "before" })).status, 200);
    const expected = (await observer.query("SELECT id,version,sha256 FROM vfs_nodes WHERE path=$1", [path])).rows[0];
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const write = post({ op: "writeIfUnchanged", path, content: "after", encoding: "utf8", mime: "text/plain", expected }); await wait('for update');
    const trash = post({ op: "trash", path: root }); await wait("pg_advisory_xact_lock", 'update "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false; const [saved, gone] = await Promise.all([write, trash]); assert.equal(saved.status, 200); assert.equal(gone.status, 200);
    assert.deepEqual(await state(), { node: [{ content: "after", trashed: true }], versions: [{ content: "before" }], index: [] });
  });
  await safeTest("restore-first and a following writer publish one current index and retain the old version", cov, async () => {
    assert.equal((await post({ op: "write", path, content: "before" })).status, 200); assert.equal((await post({ op: "trash", path: root })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [root]);
    const restore = post({ op: "restore", path: root }); await wait('for update');
    const write = post({ op: "write", path, content: "after" }); await wait("pg_advisory_xact_lock", 'insert into "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false; const [back, saved] = await Promise.all([restore, write]); assert.equal(back.status, 200); assert.equal(saved.status, 200);
    assert.deepEqual(await state(), { node: [{ content: "after", trashed: false }], versions: [{ content: "before" }], index: [{ body: "after" }] });
  });
  await safeTest("thumbnail cleanup and cache-item trash do not deadlock or reintroduce data", cov, async () => {
    assert.equal((await post({ op: "write", path: cache, content: "before" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [cache]);
    const clear = post({ confirm: "CLEAR THUMBNAIL CACHE" }, "/api/privacy/thumbnail-cache"); await wait('delete from "vfs_nodes"');
    const trash = post({ op: "trash", path: cache }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [cleared, gone] = await Promise.all([clear, trash]); assert.equal(cleared.status, 200); assert.notEqual(gone.status, 200);
    assert.deepEqual(await state(cache), { node: [], versions: [], index: [] });
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { cleanupSafe = false; });
  if (own && cleanupSafe) { cleanupSafe = await settle(); if (cleanupSafe) await clean(); }
  if (own && !cleanupSafe) { console.error(`Fixtures ${root} and ${cache} retained: unknown request outcome.`); process.exitCode = 1; }
  await lock.end(); await observer.end();
}
finish();
