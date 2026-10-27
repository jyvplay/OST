/** Concurrent/stale public recipe adversaries against real HTTP + PostgreSQL. EXCLUSIVE disposable database/server only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing recipe-concurrency tests without explicit disposable opt-in and a matching exclusive database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", run = randomBytes(8).toString("hex"), root = `/Documents/tt95-recipe-${run}_%`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("tt95-photo-concurrency"), cov = { "MD-03": "partial", "FM-03": "partial" } as const;
const post = async (body: object) => { const r = await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const get = async (path: string) => (await db.query("SELECT id,version,sha256,content,trashed FROM vfs_nodes WHERE path=$1", [path])).rows[0];
const side = (p: string) => `${p.slice(0, p.lastIndexOf("/") + 1)}.${p.slice(p.lastIndexOf("/") + 1)}.edit.json`;
const write = async (path: string, content: string, mime = "text/plain") => { const r = await post({ op: "write", path, content, mime }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const photo = async (name: string) => { const p = `${root}/${name}.jpg`; await write(p, "original image", "image/jpeg"); return p; };
const owner = async (p: string) => { const n = await get(p); return { path: p, id: n.id, version: n.version, sha256: n.sha256 }; };
const recipe = async (p: string) => { const n = await get(side(p)); return n ? { id: n.id, version: n.version, sha256: n.sha256 } : null; };
const save = (p: string, expectedPhoto: object, expectedRecipe: unknown, content: string) => post({ op: "write", path: side(p), content, mime: "application/json", reason: "photo edit", expectedPhoto, expectedRecipe });
const clear = (p: string, expectedPhoto: object, expectedRecipe: unknown) => post({ op: "purge", path: side(p), expectedPhoto, expectedRecipe });
const clean = async () => {
  await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
};
const checked: typeof test = async (name, c, fn) => test(name, c, async () => { try { await fn(); } finally { await clean(); } });
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  await write(`${root}/identity.txt`, run); assert.equal((await get(`${root}/identity.txt`))?.content, run, "server/database mismatch"); own = true; await clean();

  await checked("two editors seeing no recipe cannot silently replace the first edit", cov, async () => {
    const p = await photo("absent"), e = await owner(p); assert.equal((await save(p, e, null, "first")).status, 200);
    assert.equal((await save(p, e, null, "stale")).status, 409); assert.equal((await get(side(p))).content, "first");
  });
  await checked("a stale update refuses a later edit and leaves its current row, history and index intact", cov, async () => {
    const p = await photo("update"), e = await owner(p); await write(side(p), "old", "application/json"); const observed = await recipe(p); await write(side(p), "new", "application/json");
    const before = await get(side(p)), history = await db.query("SELECT version,content FROM vfs_versions WHERE path=$1 ORDER BY version", [side(p)]), index = await db.query("SELECT title,body FROM index_docs WHERE source='file' AND ref=$1", [side(p)]);
    assert.equal((await save(p, e, observed, "stale")).status, 409); assert.deepEqual(await get(side(p)), before);
    assert.deepEqual((await db.query("SELECT version,content FROM vfs_versions WHERE path=$1 ORDER BY version", [side(p)])).rows, history.rows);
    assert.deepEqual((await db.query("SELECT title,body FROM index_docs WHERE source='file' AND ref=$1", [side(p)])).rows, index.rows);
  });
  await checked("a stale clear cannot purge newer edits or their history", cov, async () => {
    const p = await photo("clear"), e = await owner(p); await write(side(p), "old", "application/json"); const observed = await recipe(p); await write(side(p), "new", "application/json");
    assert.equal((await clear(p, e, observed)).status, 409); assert.equal((await get(side(p))).content, "new");
    assert.equal((await db.query("SELECT content FROM vfs_versions WHERE path=$1", [side(p)])).rows[0]?.content, "old");
  });
  await checked("a same-byte rewrite is still a new recipe version", cov, async () => {
    const p = await photo("same-bytes"), e = await owner(p); await write(side(p), "same", "application/json"); const observed = await recipe(p); await write(side(p), "same", "application/json");
    assert.equal((await save(p, e, observed, "stale")).status, 409); assert.equal((await get(side(p))).content, "same");
  });
  await checked("a recreated recipe with identical bytes is not the original row", cov, async () => {
    const p = await photo("recreate"), e = await owner(p); await write(side(p), "same", "application/json"); const observed = await recipe(p);
    assert.equal((await post({ op: "purge", path: side(p) })).status, 200); await write(side(p), "same", "application/json"); assert.notEqual((await recipe(p))?.id, observed?.id);
    assert.equal((await clear(p, e, observed)).status, 409); assert.equal((await get(side(p))).content, "same");
  });
  await checked("a removed recipe cannot be recreated by a stale editor", cov, async () => {
    const p = await photo("removed"), e = await owner(p); await write(side(p), "old", "application/json"); const observed = await recipe(p); assert.equal((await post({ op: "purge", path: side(p) })).status, 200);
    assert.equal((await save(p, e, observed, "stale")).status, 409); assert.equal(await get(side(p)), undefined);
  });
  await checked("a corrupt sidecar digest is not silently replaced", cov, async () => {
    const p = await photo("corrupt"), e = await owner(p); await write(side(p), "old", "application/json"); const observed = await recipe(p); await db.query("UPDATE vfs_nodes SET content='tampered' WHERE path=$1", [side(p)]);
    assert.equal((await save(p, e, observed, "stale")).status, 409); assert.equal((await get(side(p))).content, "tampered");
  });
  await checked("malformed explicit recipe preconditions fail closed", cov, async () => {
    const p = await photo("malformed"), e = await owner(p);
    for (const value of [{}, [], 0, "0", { id: 1, version: -1, sha256: "x" }, { id: 0, version: 1, sha256: "a".repeat(64) }]) {
      assert.equal((await save(p, e, value, "bad")).status, 400); assert.equal((await clear(p, e, value)).status, 400); assert.equal(await get(side(p)), undefined);
    }
  });
  await checked("a recipe precondition without an owner guard is rejected", cov, async () => {
    const p = await photo("owner-required"); assert.equal((await post({ op: "write", path: side(p), content: "bad", expectedRecipe: null })).status, 400);
    assert.equal((await post({ op: "purge", path: side(p), expectedRecipe: null })).status, 400); assert.equal(await get(side(p)), undefined);
  });
  await checked("competing guarded creates have one winner", cov, async () => {
    const p = await photo("race-create"), e = await owner(p), results = await Promise.all([save(p, e, null, "one"), save(p, e, null, "two")]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]); assert.ok(["one", "two"].includes((await get(side(p))).content));
  });
  await checked("competing guarded updates from one version have one winner", cov, async () => {
    const p = await photo("race-update"), e = await owner(p); await write(side(p), "base", "application/json"); const observed = await recipe(p);
    const results = await Promise.all([save(p, e, observed, "one"), save(p, e, observed, "two")]); assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.ok(["one", "two"].includes((await get(side(p))).content)); assert.equal((await db.query("SELECT count(*)::int AS n FROM vfs_versions WHERE path=$1", [side(p)])).rows[0].n, 1);
  });
  await checked("successful saves return their actual new identity and can advance the next precondition", cov, async () => {
    const p = await photo("success"), e = await owner(p), a = await save(p, e, null, "first"); assert.equal(a.status, 200); const first = await recipe(p);
    assert.deepEqual({ id: a.json.id, version: a.json.version, sha256: a.json.sha256 }, first); const b = await save(p, e, first, "second"); assert.equal(b.status, 200); const next = await recipe(p);
    assert.deepEqual({ id: b.json.id, version: b.json.version, sha256: b.json.sha256 }, next); assert.equal(next?.version, first!.version + 1);
    assert.equal((await clear(p, e, next)).status, 200); assert.equal((await clear(p, e, null)).status, 200); assert.equal(await get(side(p)), undefined);
  });
  await checked("legacy unguarded sidecar writes retain their existing overwrite behavior", cov, async () => {
    const p = await photo("legacy"); await write(side(p), "first", "application/json"); await write(side(p), "second", "application/json"); assert.equal((await get(side(p))).content, "second");
  });
} finally { if (own) await clean(); await db.end(); finish(); }
