/** Forced real HTTP/PostgreSQL write-vs-purge interleavings; exclusive disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing purge race without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable server/database.");
const BASE = process.env.BASE ?? "http://localhost:3000", root = `/Documents/tt91-purge-race-${randomBytes(8).toString("hex")}`, path = `${root}/item.txt`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
await lock.connect(); await observer.connect();
const { test, finish } = makeHarness("tt91-purge-race");
const covers = { "FM-11": "partial", "SC-10": "partial" } as const;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (body: object) => { const controller = new AbortController(), promise = fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }); void promise.catch(() => undefined); pending.push({ promise, controller }); return promise; };
const count = async () => ({
  nodes: (await observer.query("SELECT path,content FROM vfs_nodes WHERE path=$1 ORDER BY path", [path])).rows,
  versions: (await observer.query("SELECT content FROM vfs_versions WHERE path=$1", [path])).rows,
  index: (await observer.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows,
});
const clean = async () => {
  await observer.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await observer.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await observer.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
};
const wait = async (...fragments: string[]) => {
  const end = Date.now() + 12_000;
  do {
    const result = await observer.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE ANY($1::text[])", [fragments.map((x) => `%${x}%`)]);
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < end);
  throw new Error(`No lock wait observed for ${fragments.join(" or ")}`);
};
let inTx = false, cleanupSafe = true, own = false;
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const results = await Promise.race([Promise.allSettled(pending.map((x) => x.promise)), timeout]); if (timer) clearTimeout(timer);
  if (!results || results.some((r) => r.status === "rejected")) { for (const x of pending) x.controller.abort(); pending.length = 0; return false; }
  pending.length = 0; return true;
};
const safeTest: typeof test = async (name, cov, fn) => test(name, cov, async () => {
  if (!cleanupSafe) throw new Error(`Previous request outcome unknown; fixture ${root} retained.`);
  try { await fn(); } finally {
    if (inTx) { try { await lock.query("ROLLBACK"); inTx = false; } catch { cleanupSafe = false; for (const x of pending) x.controller.abort(); throw new Error(`Could not release lock; fixture ${root} retained.`); } }
    cleanupSafe = await settle();
    if (!cleanupSafe) throw new Error(`Request outcome unknown; fixture ${root} retained.`);
    await clean();
  }
});
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) {
    const r = await observer.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root]);
    assert.equal(r.rowCount, 0, `fixture already exists: ${root}`);
  }
  own = true;
  await safeTest("purge-first ordinary write cannot return success with orphan history or search text", covers, async () => {
    const initial = await post({ op: "write", path, content: "before" }); assert.equal(initial.status, 200);
    assert.equal((await count()).nodes.length, 1, "server/database mismatch");
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const purge = post({ op: "purge", path: root }); await wait('delete from "vfs_nodes"');
    const write = post({ op: "write", path, content: "after" }); await wait("pg_advisory_xact_lock", 'update "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false;
    const [gone, saved] = await Promise.all([purge, write]);
    assert.equal(gone.status, 200, await gone.clone().text()); assert.equal(saved.status, 200, await saved.clone().text());
    const result = await count(); console.log("    observed", JSON.stringify(result));
    assert.deepEqual(result, { nodes: [{ path, content: "after" }], versions: [], index: [{ body: "after" }] });
    assert.equal((await observer.query("SELECT path FROM vfs_nodes WHERE path=$1 AND kind='dir'", [root])).rowCount, 1, "writer recreates the purged parent");
  });
  await safeTest("unrelated ordinary writes can progress concurrently through the shared writer gate", covers, async () => {
    const sibling = `${root}/other.txt`;
    assert.equal((await post({ op: "write", path, content: "before" })).status, 200);
    assert.equal((await post({ op: "write", path: sibling, content: "sibling before" })).status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const stalled = post({ op: "write", path, content: "after" }); await wait('for update');
    const other = post({ op: "write", path: sibling, content: "sibling after" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 5000); });
    const response = await Promise.race([other, timeout]); if (timer) clearTimeout(timer);
    assert.ok(response, "unrelated writer was serialized behind the blocked writer"); assert.equal(response.status, 200);
    await lock.query("COMMIT"); inTx = false; assert.equal((await stalled).status, 200);
    assert.equal((await observer.query("SELECT content FROM vfs_nodes WHERE path=$1", [sibling])).rows[0].content, "sibling after");
  });
  await safeTest("conditional overwrite followed by purge cannot leave old versions behind", covers, async () => {
    const initial = await post({ op: "write", path, content: "before" }); assert.equal(initial.status, 200);
    const expected = (await observer.query("SELECT id,version,sha256 FROM vfs_nodes WHERE path=$1", [path])).rows[0];
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const write = post({ op: "writeIfUnchanged", path, content: "after", encoding: "utf8", mime: "text/plain", expected }); await wait('for update');
    const purge = post({ op: "purge", path }); await wait("pg_advisory_xact_lock", 'delete from "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false;
    const [saved, gone] = await Promise.all([write, purge]); assert.equal(saved.status, 200, await saved.clone().text()); assert.equal(gone.status, 200, await gone.clone().text());
    assert.deepEqual(await count(), { nodes: [], versions: [], index: [] });
  });
  await safeTest("write-first ordinary purge removes the committed version and search entry", covers, async () => {
    const initial = await post({ op: "write", path, content: "before" }); assert.equal(initial.status, 200);
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const write = post({ op: "write", path, content: "after" }); await wait('update "vfs_nodes"', 'for update');
    const purge = post({ op: "purge", path }); await wait("pg_advisory_xact_lock", 'delete from "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false;
    const [saved, gone] = await Promise.all([write, purge]); assert.equal(saved.status, 200, await saved.clone().text()); assert.equal(gone.status, 200, await gone.clone().text());
    const result = await count(); console.log("    observed", JSON.stringify(result));
    assert.deepEqual(result, { nodes: [], versions: [], index: [] });
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { cleanupSafe = false; });
  if (own && cleanupSafe) { cleanupSafe = await settle(); if (cleanupSafe) await clean(); }
  if (own && !cleanupSafe) { console.error(`Fixture ${root} retained: unknown request outcome.`); process.exitCode = 1; }
  await lock.end(); await observer.end();
}
finish();
