/** Late/stale photo-recipe saves against real HTTP + PostgreSQL. EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing photo guard tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt94-photo-${id}_%`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("tt94-photo-guard"), cov = { "MD-03": "partial", "FM-03": "partial" } as const;
const post = async (body: object) => { const r = await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const node = async (p: string) => (await db.query("SELECT id,path,version,content,sha256,trashed FROM vfs_nodes WHERE path=$1", [p])).rows[0];
const side = (p: string) => `${p.slice(0, p.lastIndexOf("/") + 1)}.${p.slice(p.lastIndexOf("/") + 1)}.edit.json`;
const write = async (path: string, content: string, mime = "text/plain") => { const r = await post({ op: "write", path, content, mime }); assert.equal(r.status, 200, JSON.stringify(r.json)); };
const photo = async (name: string, content = "original image") => { const p = `${root}/${name}.jpg`; await write(p, content, "image/jpeg"); return p; };
const expected = async (p: string) => { const n = await node(p); return { path: p, id: n.id, version: n.version, sha256: n.sha256 }; };
const save = (p: string, e: object, content = '{"v":1,"rotate":1}') => post({ op: "write", path: side(p), content, mime: "application/json", reason: "photo edit", expectedPhoto: e });
const clean = async () => {
  await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
};
const checked: typeof test = async (name, c, fn) => test(name, c, async () => { try { await fn(); } finally { await clean(); } });
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  await write(`${root}/identity.txt`, id); assert.equal((await node(`${root}/identity.txt`))?.content, id, "server/database mismatch"); own = true; await clean();
  await checked("a matching photo identity permits versioned recipe writes and an idempotent clear", cov, async () => {
    const p = await photo("current"), e = await expected(p); assert.equal((await save(p, e, "first")).status, 200); assert.equal((await save(p, e, "second")).status, 200);
    assert.equal((await node(side(p))).content, "second"); assert.equal((await db.query("SELECT content FROM vfs_versions WHERE path=$1", [side(p)])).rows[0]?.content, "first");
    assert.equal((await post({ op: "purge", path: side(p), expectedPhoto: e })).status, 200); assert.equal((await post({ op: "purge", path: side(p), expectedPhoto: e })).status, 200); assert.equal(await node(side(p)), undefined); assert.equal((await node(p)).content, "original image");
  });
  await checked("a recipe save from a stale editor after a photo move is refused without creating an orphan", cov, async () => {
    const p = await photo("source"), e = await expected(p), dst = `${root}/moved.jpg`; assert.equal((await post({ op: "move", src: p, dst })).status, 200);
    assert.equal((await save(p, e)).status, 409); assert.equal(await node(side(p)), undefined); assert.equal((await node(dst)).content, "original image");
  });
  await checked("recreating an identical photo at the old path does not authorize an old editor", cov, async () => {
    const p = await photo("same"), e = await expected(p); assert.equal((await post({ op: "move", src: p, dst: `${root}/moved.jpg` })).status, 200); await photo("same");
    assert.notEqual((await node(p)).id, e.id); assert.equal((await node(p)).sha256, e.sha256); assert.equal((await save(p, e)).status, 409); assert.equal(await node(side(p)), undefined);
  });
  await checked("a modified photo version refuses the old recipe even at the same path and identity", cov, async () => {
    const p = await photo("changed"), e = await expected(p); await write(p, "changed image", "image/jpeg"); assert.equal((await node(p)).id, e.id);
    assert.equal((await save(p, e)).status, 409); assert.equal(await node(side(p)), undefined);
  });
  await checked("even a byte-identical overwrite changes the version and invalidates an old editor", cov, async () => {
    const p = await photo("same-version"), e = await expected(p); await write(p, "original image", "image/jpeg");
    assert.equal((await node(p)).id, e.id); assert.equal((await node(p)).sha256, e.sha256); assert.notEqual((await node(p)).version, e.version);
    assert.equal((await save(p, e)).status, 409); assert.equal(await node(side(p)), undefined);
  });
  await checked("a stale clear cannot purge a new photo's unrelated recipe at the reused path", cov, async () => {
    const p = await photo("reuse"), e = await expected(p); assert.equal((await post({ op: "move", src: p, dst: `${root}/moved.jpg` })).status, 200);
    await photo("reuse", "new image"); await write(side(p), "new edits", "application/json");
    assert.equal((await post({ op: "purge", path: side(p), expectedPhoto: e })).status, 409); assert.equal((await node(side(p))).content, "new edits");
  });
  await checked("a guard cannot authorize writes or deletion of an unrelated path", cov, async () => {
    const p = await photo("owner"), e = await expected(p), victim = `${root}/victim.txt`; await write(victim, "keep");
    assert.equal((await post({ op: "write", path: victim, content: "overwrite", expectedPhoto: e })).status, 400);
    assert.equal((await post({ op: "purge", path: victim, expectedPhoto: e })).status, 400); assert.equal((await node(victim)).content, "keep");
  });
  await checked("media listing exposes the exact identity and version used by a live editor", cov, async () => {
    const p = await photo("listing"), e = await expected(p), result = await fetch(`${BASE}/api/fs?op=media`).then((r) => r.json()), item = result.items.find((x: { path: string }) => x.path === p);
    assert.ok(item); assert.equal(item.id, e.id); assert.equal(item.version, e.version); assert.equal(item.sha256, e.sha256);
  });
  await checked("a corrupt photo whose stored digest was not updated cannot accept a guarded recipe", cov, async () => {
    const p = await photo("corrupt"), e = await expected(p); await db.query("UPDATE vfs_nodes SET content='tampered' WHERE path=$1", [p]);
    assert.equal((await save(p, e)).status, 409); assert.equal(await node(side(p)), undefined); assert.equal((await node(p)).content, "tampered");
  });
  await checked("malformed, private and unrelated owner guards are refused rather than silently downgraded", cov, async () => {
    const p = await photo("invalid"), e = await expected(p);
    for (const bad of [null, {}, { ...e, id: 0 }, { ...e, version: -1 }, { ...e, sha256: "not-a-sha" }, { ...e, path: "/Private/secret.jpg" }]) {
      assert.equal((await post({ op: "write", path: side(p), content: "edits", expectedPhoto: bad })).status, 400);
      assert.equal((await post({ op: "purge", path: side(p), expectedPhoto: bad })).status, 400);
    }
    assert.equal(await node(side(p)), undefined); assert.equal((await node(p)).content, "original image");
  });
  await checked("a photo in Trash refuses guarded recipe writes and clears", cov, async () => {
    const p = await photo("trash"), e = await expected(p); assert.equal((await post({ op: "trash", path: p })).status, 200);
    assert.equal((await save(p, e)).status, 409); assert.equal((await post({ op: "purge", path: side(p), expectedPhoto: e })).status, 409);
    assert.equal(await node(side(p)), undefined); assert.equal((await node(p)).trashed, true);
  });
  await checked("unconditional sidecar writes remain available to existing clients", cov, async () => {
    const p = await photo("legacy"); await write(side(p), "legacy edits", "application/json"); assert.equal((await node(side(p))).content, "legacy edits");
  });
} finally { if (own) await clean(); await db.end(); finish(); }
