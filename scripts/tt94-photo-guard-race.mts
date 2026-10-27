/** Forced save/move races on real PostgreSQL locks. EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing photo guard races without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt94-photo-race-${id}`;
const photo = `${root}/source.jpg`, movedPhoto = `${root}/moved.jpg`, side = `${root}/.source.jpg.edit.json`, movedSide = `${root}/.moved.jpg.edit.json`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await lock.connect(); await db.connect();
const { test, finish } = makeHarness("tt94-photo-guard-race"), cov = { "MD-03": "partial", "FM-03": "partial" } as const;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (body: object) => {
  const controller = new AbortController(); const promise = fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  void promise.catch(() => undefined); pending.push({ promise, controller }); return promise;
};
const wait = async (...fragments: string[]) => {
  const until = Date.now() + 8000;
  do {
    const r = await db.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE ANY($1::text[])", [fragments.map((x) => `%${x}%`)]);
    if (r.rowCount) return; await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < until);
  throw new Error(`No real database lock wait observed: ${fragments.join(" or ")}`);
};
const node = async (p: string) => (await db.query("SELECT id,version,sha256,content FROM vfs_nodes WHERE path=$1", [p])).rows[0];
const clean = async () => {
  await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
};
let inTx = false, safe = true, own = false;
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const outcomes = await Promise.race([Promise.allSettled(pending.map((r) => r.promise)), timeout]); if (timer) clearTimeout(timer);
  if (!outcomes || outcomes.some((r) => r.status === "rejected")) { for (const r of pending) r.controller.abort(); pending.length = 0; return false; }
  pending.length = 0; return true;
};
const checked: typeof test = async (name, c, fn) => test(name, c, async () => {
  if (!safe) throw new Error(`Prior outcome unknown; retaining ${root}`);
  try { await fn(); } finally {
    if (inTx) { try { await lock.query("ROLLBACK"); inTx = false; } catch { safe = false; for (const r of pending) r.controller.abort(); throw new Error("Could not release lock; fixture retained"); } }
    safe = await settle(); if (!safe) throw new Error("Could not settle requests; fixture retained"); await clean();
  }
});
const init = async () => {
  assert.equal((await post({ op: "write", path: photo, content: "image", mime: "image/jpeg" })).status, 200);
  assert.equal((await post({ op: "write", path: side, content: "old edits", mime: "application/json" })).status, 200);
  const n = await node(photo); return { path: photo, id: n.id, version: n.version, sha256: n.sha256 };
};
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  assert.equal((await post({ op: "write", path: `${root}/identity.txt`, content: id })).status, 200); assert.equal((await node(`${root}/identity.txt`)).content, id, "server/database mismatch"); own = true;
  assert.equal(await settle(), true); await clean();
  await checked("a guarded save that has the shared gate first commits before the photo move", cov, async () => {
    const guard = await init(); await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [photo]);
    const saving = post({ op: "write", path: side, content: "new edits", mime: "application/json", expectedPhoto: guard }); await wait("for update");
    const moving = post({ op: "move", src: photo, dst: movedPhoto }); await wait("pg_advisory_xact_lock");
    await lock.query("COMMIT"); inTx = false; const [saved, moved] = await Promise.all([saving, moving]); assert.equal(saved.status, 200); assert.equal(moved.status, 200);
    assert.equal(await node(photo), undefined); assert.equal(await node(side), undefined); assert.equal((await node(movedSide)).content, "new edits");
    assert.equal((await db.query("SELECT content FROM vfs_versions WHERE path=$1", [movedSide])).rows[0]?.content, "old edits");
  });
  await checked("a move that has the exclusive gate first forces the later guarded save to reject", cov, async () => {
    const guard = await init(); await lock.query("BEGIN"); inTx = true; await lock.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [photo]);
    const moving = post({ op: "move", src: photo, dst: movedPhoto }); await wait("UPDATE vfs_nodes");
    const saving = post({ op: "write", path: side, content: "late edits", mime: "application/json", expectedPhoto: guard }); await wait("pg_advisory_xact_lock_shared");
    await lock.query("COMMIT"); inTx = false; const [moved, saved] = await Promise.all([moving, saving]); assert.equal(moved.status, 200); assert.equal(saved.status, 409);
    assert.equal(await node(photo), undefined); assert.equal(await node(side), undefined); assert.equal((await node(movedSide)).content, "old edits");
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { safe = false; });
  if (own && safe && await settle()) await clean(); else if (own) { console.error(`Fixture ${root} retained; outcome unknown`); process.exitCode = 1; }
  await lock.end(); await db.end(); finish();
}
