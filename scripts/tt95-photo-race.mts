/** Forced recipe races using real PostgreSQL locks; EXCLUSIVE disposable database/server only. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing forced recipe races without an exclusive disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt95-recipe-race-${id}`;
const photo = `${root}/photo.jpg`, side = `${root}/.photo.jpg.edit.json`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await lock.connect(); await db.connect();
const { test, finish } = makeHarness("tt95-photo-race"), cov = { "MD-03": "partial", "FM-03": "partial" } as const;
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
const post = (body: object) => { const controller = new AbortController(); const promise = fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }); void promise.catch(() => undefined); pending.push({ promise, controller }); return promise; };
const wait = async (fragment: string) => {
  const until = Date.now() + 12_000;
  do {
    const r = await db.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1", [`%${fragment}%`]);
    if (r.rowCount) return; await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < until);
  throw new Error(`No real PostgreSQL lock wait observed for ${fragment}`);
};
const get = async (p: string) => (await db.query("SELECT id,version,sha256,content FROM vfs_nodes WHERE path=$1", [p])).rows[0];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
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
const init = async (withSide = false) => {
  assert.equal((await post({ op: "write", path: photo, content: "image", mime: "image/jpeg" })).status, 200);
  if (withSide) assert.equal((await post({ op: "write", path: side, content: "old", mime: "application/json" })).status, 200);
  const n = await get(photo), s = await get(side); return { owner: { path: photo, id: n.id, version: n.version, sha256: n.sha256 }, recipe: s ? { id: s.id, version: s.version, sha256: s.sha256 } : null };
};
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  assert.equal((await post({ op: "write", path: `${root}/identity.txt`, content: id })).status, 200); assert.equal((await get(`${root}/identity.txt`)).content, id, "server/database mismatch"); own = true; assert.equal(await settle(), true); await clean();
  await checked("an uncommitted competing insert cannot be overwritten by an absent-recipe save", cov, async () => {
    const { owner } = await init(); await lock.query("BEGIN"); inTx = true;
    await lock.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime,encoding,content,size,sha256) VALUES($1,$2,$3,'file','application/json','utf8','racer',5,$4)", [side, root, ".photo.jpg.edit.json", hash("racer")]);
    const saving = post({ op: "write", path: side, content: "stale", mime: "application/json", expectedPhoto: owner, expectedRecipe: null });
    await wait('insert into "vfs_nodes"'); await lock.query("COMMIT"); inTx = false;
    assert.equal((await saving).status, 409); assert.equal((await get(side)).content, "racer");
  });
  await checked("a locked update committed first invalidates the later guarded save", cov, async () => {
    const { owner, recipe } = await init(true); await lock.query("BEGIN"); inTx = true;
    await lock.query("UPDATE vfs_nodes SET content='new',sha256=$2,version=version+1 WHERE path=$1", [side, hash("new")]);
    const saving = post({ op: "write", path: side, content: "stale", mime: "application/json", expectedPhoto: owner, expectedRecipe: recipe });
    await wait('for update'); await lock.query("COMMIT"); inTx = false;
    assert.equal((await saving).status, 409); assert.equal((await get(side)).content, "new");
  });
  await checked("a locked update committed first invalidates the later guarded clear", cov, async () => {
    const { owner, recipe } = await init(true); await lock.query("BEGIN"); inTx = true;
    await lock.query("UPDATE vfs_nodes SET content='new',sha256=$2,version=version+1 WHERE path=$1", [side, hash("new")]);
    const clearing = post({ op: "purge", path: side, expectedPhoto: owner, expectedRecipe: recipe });
    await wait('for update'); await lock.query("COMMIT"); inTx = false;
    assert.equal((await clearing).status, 409); assert.equal((await get(side)).content, "new");
  });
} finally {
  if (inTx) await lock.query("ROLLBACK").catch(() => { safe = false; });
  if (own && safe && await settle()) await clean(); else if (own) { console.error(`Fixture ${root} retained; outcome unknown`); process.exitCode = 1; }
  await lock.end(); await db.end(); finish();
}
