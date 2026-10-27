/** Real PostgreSQL/HTTP interleaving; clears the disposable thumbnail cache. NEVER use against user data. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing cleanup race without TT89_DISPOSABLE_DATABASE=1 for an isolated server/database.");
const BASE = process.env.BASE ?? "http://localhost:3000";
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL must name the same disposable database used by the server");
const lock = new pg.Client({ connectionString: dbUrl }); const observer = new pg.Client({ connectionString: dbUrl });
await lock.connect(); await observer.connect();
const { test, finish } = makeHarness("tt91-thumbnail-cleanup-race");
const path = `/System/Cache/thumbs/race-${randomBytes(8).toString("hex")}.txt`;
const requests: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (url: string, body: unknown) => {
  const controller = new AbortController();
  const promise = fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  // A failed assertion can temporarily leave a request awaiting a PostgreSQL lock.
  // Observe rejections immediately and settle every request after releasing that lock.
  void promise.catch(() => undefined); requests.push({ promise, controller }); return promise;
};
const waitForLock = async (...fragments: string[]) => {
  const end = Date.now() + 12_000;
  do {
    const r = await observer.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE ANY($1::text[])", [fragments.map((fragment) => `%${fragment}%`)]);
    if (r.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < end);
  throw new Error(`No lock wait observed for ${fragments.join(" or ")}`);
};
let inTx = false, cleanupSafe = true;
const clearFixture = async () => {
  await observer.query("DELETE FROM vfs_versions WHERE path=$1", [path]);
  await observer.query("DELETE FROM vfs_nodes WHERE path=$1", [path]);
  await observer.query("DELETE FROM index_docs WHERE source='file' AND ref=$1", [path]);
};
const settleRequests = async () => {
  if (!requests.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const outcomes = await Promise.race([Promise.allSettled(requests.map((r) => r.promise)), timeout]);
  if (timer) clearTimeout(timer);
  if (!outcomes || outcomes.some((r) => r.status === "rejected")) {
    for (const r of requests) r.controller.abort();
    requests.length = 0;
    // A disconnected client cannot prove the server stopped its transaction.
    // Preserve fixtures rather than deleting underneath an unknown in-flight write.
    return false;
  }
  requests.length = 0; return true;
};
const safeTest: typeof test = async (name, covers, fn) => test(name, covers, async () => {
  if (!cleanupSafe) throw new Error(`Previous request outcome unknown; fixture ${path} was retained for manual inspection.`);
  try { await fn(); }
  finally {
    if (inTx) {
      try { await lock.query("ROLLBACK"); inTx = false; }
      catch { cleanupSafe = false; for (const r of requests) r.controller.abort(); throw new Error(`Could not release test lock; fixture ${path} retained for inspection.`); }
    }
    cleanupSafe = await settleRequests();
    if (!cleanupSafe) throw new Error(`Could not settle all HTTP requests; fixture ${path} retained for manual inspection.`);
    await clearFixture();
  }
});
try {
  await safeTest("cache cleanup and an overlapping real write must not leave an orphan version or index", { "SC-10": "partial", "FF-13": "partial" }, async () => {
    const initial = await post("/api/fs", { op: "write", path, content: "before", mime: "text/plain" });
    assert.equal(initial.status, 200, await initial.clone().text());
    await lock.query("BEGIN"); inTx = true;
    await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const clearing = post("/api/privacy/thumbnail-cache", { confirm: "CLEAR THUMBNAIL CACHE" });
    await waitForLock("delete from \"vfs_nodes\"");
    const writing = post("/api/fs", { op: "write", path, content: "after", mime: "text/plain" });
    await waitForLock("pg_advisory_xact_lock", 'update "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false;
    const [cleared, wrote] = await Promise.all([clearing, writing]);
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal(wrote.status, 200, await wrote.clone().text());
    const result = {
      writeStatus: wrote.status,
      nodes: (await observer.query("SELECT content FROM vfs_nodes WHERE path=$1", [path])).rows,
      versions: (await observer.query("SELECT content FROM vfs_versions WHERE path=$1", [path])).rows,
      index: (await observer.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows,
    };
    console.log("    observed", JSON.stringify(result));
    // Linearizable outcomes: cleanup after write leaves nothing; a complete write after cleanup leaves a new live row.
    const absent = result.nodes.length === 0 && result.versions.length === 0 && result.index.length === 0;
    const live = result.nodes.length === 1 && result.nodes[0].content === "after" && result.versions.length === 0 && result.index.length === 1;
    assert.ok(absent || live, `interleaving left inconsistent cache state: ${JSON.stringify(result)}`);
  });
  await safeTest("an already-running cache write completes before cleanup and leaves no historical cache rows", { "SC-10": "partial", "FF-13": "partial" }, async () => {
    const initial = await post("/api/fs", { op: "write", path, content: "before", mime: "text/plain" }); assert.equal(initial.status, 200);
    await lock.query("BEGIN"); inTx = true;
    await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const writing = post("/api/fs", { op: "write", path, content: "after", mime: "text/plain" });
    await waitForLock('update "vfs_nodes"', 'for update');
    const clearing = post("/api/privacy/thumbnail-cache", { confirm: "CLEAR THUMBNAIL CACHE" });
    await waitForLock("pg_advisory_xact_lock", 'delete from "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false;
    const [wrote, cleared] = await Promise.all([writing, clearing]);
    assert.equal(wrote.status, 200, await wrote.clone().text()); assert.equal(cleared.status, 200, await cleared.clone().text());
    const [nodes, versions, index] = await Promise.all([
      observer.query("SELECT path FROM vfs_nodes WHERE path=$1", [path]),
      observer.query("SELECT path FROM vfs_versions WHERE path=$1", [path]),
      observer.query("SELECT ref FROM index_docs WHERE source='file' AND ref=$1", [path]),
    ]);
    assert.equal(nodes.rowCount, 0); assert.equal(versions.rowCount, 0); assert.equal(index.rowCount, 0);
  });
  await safeTest("conditional cache creation waits for cleanup and does not overwrite the pre-cleanup row", { "SC-10": "partial", "FF-13": "partial" }, async () => {
    const initial = await post("/api/fs", { op: "write", path, content: "before", mime: "text/plain" }); assert.equal(initial.status, 200);
    await lock.query("BEGIN"); inTx = true;
    await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const clearing = post("/api/privacy/thumbnail-cache", { confirm: "CLEAR THUMBNAIL CACHE" });
    await waitForLock("delete from \"vfs_nodes\"");
    const writing = post("/api/fs", { op: "writeIfUnchanged", path, content: "after", encoding: "utf8", mime: "text/plain", expected: null });
    await waitForLock("pg_advisory_xact_lock", 'for update');
    await lock.query("COMMIT"); inTx = false;
    const [cleared, wrote] = await Promise.all([clearing, writing]);
    assert.equal(cleared.status, 200, await cleared.clone().text()); assert.equal(wrote.status, 200, await wrote.clone().text());
    assert.deepEqual((await observer.query("SELECT content FROM vfs_nodes WHERE path=$1", [path])).rows, [{ content: "after" }]);
    assert.equal((await observer.query("SELECT path FROM vfs_versions WHERE path=$1", [path])).rowCount, 0);
    assert.deepEqual((await observer.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows, [{ body: "after" }]);
  });
  await safeTest("cache purge waits for an already-running writer and removes its new history", { "SC-10": "partial", "FF-13": "partial" }, async () => {
    const initial = await post("/api/fs", { op: "write", path, content: "before", mime: "text/plain" }); assert.equal(initial.status, 200);
    await lock.query("BEGIN"); inTx = true;
    await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const writing = post("/api/fs", { op: "write", path, content: "after", mime: "text/plain" });
    await waitForLock('update "vfs_nodes"', 'for update');
    const purging = post("/api/fs", { op: "purge", path });
    await waitForLock("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false;
    const [wrote, purged] = await Promise.all([writing, purging]);
    assert.equal(wrote.status, 200, await wrote.clone().text()); assert.equal(purged.status, 200, await purged.clone().text());
    assert.equal((await observer.query("SELECT path FROM vfs_nodes WHERE path=$1", [path])).rowCount, 0);
    assert.equal((await observer.query("SELECT path FROM vfs_versions WHERE path=$1", [path])).rowCount, 0);
    assert.equal((await observer.query("SELECT ref FROM index_docs WHERE source='file' AND ref=$1", [path])).rowCount, 0);
  });
  await safeTest("cache purge cooperates with an in-flight cache cleanup", { "SC-10": "partial", "FF-13": "partial" }, async () => {
    const initial = await post("/api/fs", { op: "write", path, content: "before", mime: "text/plain" }); assert.equal(initial.status, 200);
    await lock.query("BEGIN"); inTx = true;
    await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const clearing = post("/api/privacy/thumbnail-cache", { confirm: "CLEAR THUMBNAIL CACHE" });
    await waitForLock('delete from "vfs_nodes"');
    const purging = post("/api/fs", { op: "purge", path });
    await waitForLock("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false;
    const [cleared, purged] = await Promise.all([clearing, purging]);
    assert.equal(cleared.status, 200, await cleared.clone().text()); assert.equal(purged.status, 200, await purged.clone().text());
    assert.equal((await observer.query("SELECT path FROM vfs_nodes WHERE path=$1", [path])).rowCount, 0);
    assert.equal((await observer.query("SELECT path FROM vfs_versions WHERE path=$1", [path])).rowCount, 0);
    assert.equal((await observer.query("SELECT ref FROM index_docs WHERE source='file' AND ref=$1", [path])).rowCount, 0);
  });
  await safeTest("conditional overwrite followed by cleanup cannot reintroduce an old saved version", { "SC-10": "partial", "FF-13": "partial" }, async () => {
    const initial = await post("/api/fs", { op: "write", path, content: "before", mime: "text/plain" }); assert.equal(initial.status, 200);
    const expected = (await observer.query("SELECT id,version,sha256 FROM vfs_nodes WHERE path=$1", [path])).rows[0];
    await lock.query("BEGIN"); inTx = true;
    await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const writing = post("/api/fs", { op: "writeIfUnchanged", path, content: "after", encoding: "utf8", mime: "text/plain", expected });
    await waitForLock("for update");
    const clearing = post("/api/privacy/thumbnail-cache", { confirm: "CLEAR THUMBNAIL CACHE" });
    await waitForLock("pg_advisory_xact_lock", 'delete from "vfs_nodes"');
    await lock.query("COMMIT"); inTx = false;
    const [wrote, cleared] = await Promise.all([writing, clearing]);
    assert.equal(wrote.status, 200, await wrote.clone().text()); assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal((await observer.query("SELECT path FROM vfs_nodes WHERE path=$1", [path])).rowCount, 0);
    assert.equal((await observer.query("SELECT path FROM vfs_versions WHERE path=$1", [path])).rowCount, 0);
    assert.equal((await observer.query("SELECT ref FROM index_docs WHERE source='file' AND ref=$1", [path])).rowCount, 0);
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { cleanupSafe = false; });
  if (cleanupSafe && await settleRequests()) await clearFixture();
  else { console.error(`Fixture ${path} retained: request outcome was not established.`); process.exitCode = 1; }
  await lock.end(); await observer.end();
}
finish();
