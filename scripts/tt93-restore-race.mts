/** Forced backup-restore/tree/cache interleavings against an EXCLUSIVE disposable server/database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
import { BACKUP_VERSION, digestText, makeBackup } from "../src/lib/backup/bundle.ts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing restore races without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt93-restore-${id}`;
const path = `${root}/item.txt`, cache = `/System/Cache/thumbs/tt93-restore-${id}.txt`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await lock.connect(); await db.connect();
const { test, finish } = makeHarness("tt93-restore-race"), cov = { "BK-01": "partial", "FM-11": "partial", "SC-10": "partial" } as const;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (url: string, body: object) => {
  const controller = new AbortController(); const promise = fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  void promise.catch(() => undefined); pending.push({ promise, controller }); return promise;
};
const wait = async (...fragments: string[]) => {
  const until = Date.now() + 8_000;
  do { const r = await db.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE ANY($1::text[])", [fragments.map((x) => `%${x}%`)]); if (r.rowCount) return; await new Promise((resolve) => setTimeout(resolve, 40)); } while (Date.now() < until);
  throw new Error(`No database lock wait observed: ${fragments.join(" or ")}`);
};
const state = async (p: string) => ({ node: (await db.query("SELECT content,trashed FROM vfs_nodes WHERE path=$1", [p])).rows,
  versions: (await db.query("SELECT content FROM vfs_versions WHERE path=$1 ORDER BY id", [p])).rows,
  index: (await db.query("SELECT body FROM index_docs WHERE source='file' AND ref=$1", [p])).rows });
const bundle = async (p: string, content: string) => makeBackup({ version: BACKUP_VERSION, exportedAt: new Date().toISOString(), kind: "data",
  entries: [{ path: p, kind: "file", mime: "text/plain", encoding: "utf8", content, size: Buffer.byteLength(content), tags: "", sha256: await digestText(content) }], notes: [], settings: [] });
const clean = async () => { for (const p of [root, cache]) {
  await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [p]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [p]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [p]);
} };
let inTx = false, safe = true, own = false;
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
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
  const probe = await post("/api/fs", { op: "write", path, content: id }); assert.equal(probe.status, 200); assert.equal((await state(path)).node[0]?.content, id, "server/database mismatch");
  own = true; assert.ok(await settle()); await clean();

  await guarded("commit of a backup restore waits for the participating tree gate", cov, async () => {
    assert.equal((await post("/api/fs", { op: "write", path, content: "before" })).status, 200);
    const b = await bundle(path, "restored"); const preview = await post("/api/backup", { bundle: b, dryRun: true }); assert.equal(preview.status, 200); const { previewToken } = await preview.json();
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT pg_advisory_xact_lock(1179997001,1447449413)");
    const restore = post("/api/backup", { bundle: b, previewToken }); await wait("pg_advisory_xact_lock");
    assert.equal((await state(path)).node[0]?.content, "before");
    await lock.query("COMMIT"); inTx = false; assert.equal((await restore).status, 200);
    assert.deepEqual(await state(path), { node: [{ content: "restored", trashed: false }], versions: [{ content: "before" }], index: [{ body: "restored" }] });
  });

  await guarded("trash before a waiting restore invalidates the preview and cannot resurrect the deleted tree", cov, async () => {
    assert.equal((await post("/api/fs", { op: "write", path, content: "before" })).status, 200);
    const b = await bundle(path, "restored"); const preview = await post("/api/backup", { bundle: b, dryRun: true }); assert.equal(preview.status, 200); const { previewToken } = await preview.json();
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [path]);
    const trash = post("/api/fs", { op: "trash", path: root }); await wait('update "vfs_nodes"');
    const restore = post("/api/backup", { bundle: b, previewToken }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [trashed, restored] = await Promise.all([trash, restore]);
    assert.equal(trashed.status, 200); assert.notEqual(restored.status, 200);
    assert.deepEqual(await state(path), { node: [{ content: "before", trashed: true }], versions: [], index: [] });
  });

  await guarded("cache cleanup before a waiting restore cannot republish the cleared bytes", cov, async () => {
    assert.equal((await post("/api/fs", { op: "write", path: cache, content: "before" })).status, 200);
    const b = await bundle(cache, "restored"); const preview = await post("/api/backup", { bundle: b, dryRun: true }); assert.equal(preview.status, 200); const { previewToken } = await preview.json();
    await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [cache]);
    const clear = post("/api/privacy/thumbnail-cache", { confirm: "CLEAR THUMBNAIL CACHE" }); await wait('delete from "vfs_nodes"');
    const restore = post("/api/backup", { bundle: b, previewToken }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [cleared, restored] = await Promise.all([clear, restore]);
    assert.equal(cleared.status, 200); assert.notEqual(restored.status, 200);
    assert.deepEqual(await state(cache), { node: [], versions: [], index: [] });
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { safe = false; });
  if (own && safe && await settle()) await clean(); else if (own) { console.error(`Fixture ${root} retained; outcome unknown.`); process.exitCode = 1; }
  await lock.end(); await db.end(); finish();
}
