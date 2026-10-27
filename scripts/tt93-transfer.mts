/** Real HTTP/PostgreSQL transfer adversaries. EXCLUSIVE disposable database/server only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing transfer tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex");
const root = `/Documents/tt93-transfer-${id}_%`, neighbor = `/Documents/tt93-transfer-${id}AX`, privateRoot = `/Private/tt93-transfer-${id}`;
const roots = [root, neighbor, privateRoot], fn = `tt93_transfer_${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("tt93-transfer"), cov = { "FM-03": "partial", "FM-18": "partial", "SR-01": "partial", "SC-10": "partial" } as const;
const post = async (body: object) => { const r = await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const must = async (body: object) => { const r = await post(body); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const write = (path: string, content: string, mime = "text/plain") => must({ op: "write", path, content, mime });
const scope = (c: string) => `(${c}=$1 OR left(${c},char_length($1)+1)=$1||'/')`;
const clean = async () => { for (const path of roots) {
  await db.query(`DELETE FROM vfs_versions WHERE ${scope("path")}`, [path]);
  await db.query(`DELETE FROM vfs_nodes WHERE ${scope("path")}`, [path]);
  await db.query(`DELETE FROM index_docs WHERE source='file' AND ${scope("ref")}`, [path]);
} };
const node = async (path: string) => (await db.query("SELECT id,path,parent,name,kind,content,sha256,trashed,version FROM vfs_nodes WHERE path=$1", [path])).rows[0];
const versions = async (path: string) => (await db.query("SELECT content,version FROM vfs_versions WHERE path=$1 ORDER BY id", [path])).rows;
const index = async (path: string) => (await db.query("SELECT ref,body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows;
const safeTest: typeof test = async (name, c, f) => test(name, c, async () => { try { await f(); } finally { await clean(); } });
let own = false;
try {
  for (const p of roots) for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${scope(col)} LIMIT 1`, [p])).rowCount, 0, `fixture already exists: ${p}`);
  // Verify server and SQL client agree before installing any trigger or deleting fixture rows.
  await write(`${root}/identity.txt`, id);
  assert.equal((await node(`${root}/identity.txt`))?.content, id, "server/database mismatch; retain fixture on the server");
  own = true; await clean();

  await safeTest("moving a nested tree preserves node identity and version history, and moves every search row without wildcard collateral", cov, async () => {
    const from = `${root}/tree_%`, to = `${root}/moved`, a = `${from}/sub/a.txt`, b = `${from}/sub/deep/b.txt`, n = `${neighbor}/untouched.txt`;
    await write(a, "old body"); await write(a, "new body"); await write(b, "nested body"); await write(n, "neighbor body");
    const before = await node(a); assert.equal((await versions(a)).length, 1);
    await must({ op: "move", src: from, dst: to });
    assert.equal(await node(a), undefined); const moved = await node(`${to}/sub/a.txt`);
    assert.equal(moved.id, before.id); assert.equal(moved.version, before.version); assert.equal(moved.content, "new body");
    assert.deepEqual(await versions(a), []); assert.deepEqual(await versions(`${to}/sub/a.txt`), [{ content: "old body", version: 1 }]);
    assert.deepEqual(await index(a), []); assert.equal((await index(`${to}/sub/a.txt`))[0]?.body, "new body");
    assert.deepEqual(await index(b), []); assert.equal((await index(`${to}/sub/deep/b.txt`))[0]?.body, "nested body");
    assert.equal((await node(n)).content, "neighbor body"); assert.equal((await index(n))[0]?.body, "neighbor body");
  });

  await safeTest("Unicode and escaped backslash, percent and underscore paths move literally with their history", cov, async () => {
    const from = `${root}/🗂_%.\\café`, to = `${root}/🌈-renamed`, a = `${from}/é/雪.txt`, n = `${root}/🗂Xother/café.txt`;
    await write(a, "first λ"); await write(a, "updated 雪"); await write(n, "neighbor");
    await must({ op: "move", src: from, dst: to });
    const moved = `${to}/é/雪.txt`;
    assert.equal((await node(moved)).parent, `${to}/é`); assert.equal((await node(moved)).name, "雪.txt");
    assert.equal((await node(moved)).content, "updated 雪"); assert.equal((await versions(moved))[0]?.content, "first λ");
    assert.equal((await index(moved))[0]?.body, "updated 雪"); assert.equal((await node(n)).content, "neighbor");
  });

  await safeTest("copy duplicates current nested data and search entries without stealing source history", cov, async () => {
    const a = `${root}/source/sub/a.txt`, b = `${root}/copied/sub/a.txt`;
    await write(a, "first"); await write(a, "second"); await must({ op: "copy", src: `${root}/source`, dst: `${root}/copied` });
    assert.equal((await node(a)).content, "second"); assert.equal((await node(b)).content, "second");
    assert.notEqual((await node(a)).id, (await node(b)).id); assert.deepEqual(await versions(a), [{ content: "first", version: 1 }]);
    assert.deepEqual(await versions(b), []); assert.equal((await index(a))[0]?.body, "second"); assert.equal((await index(b))[0]?.body, "second");
  });

  await safeTest("a trashed source is reserved and cannot be silently resurrected by move or copy", cov, async () => {
    const a = `${root}/old.txt`; await write(a, "in trash"); await must({ op: "trash", path: a });
    for (const op of ["move", "copy"]) assert.notEqual((await post({ op, src: a, dst: `${root}/${op}.txt` })).status, 200);
    assert.equal((await node(a)).trashed, true); assert.equal((await node(a)).content, "in trash");
    assert.equal(await node(`${root}/move.txt`), undefined); assert.equal(await node(`${root}/copy.txt`), undefined);
  });

  await safeTest("moving a tree containing an independently trashed child is refused rather than reviving or orphaning it", cov, async () => {
    const dir = `${root}/tree`, a = `${dir}/live.txt`, b = `${dir}/deleted.txt`; await write(a, "live"); await write(b, "deleted"); await must({ op: "trash", path: b });
    assert.notEqual((await post({ op: "move", src: dir, dst: `${root}/target` })).status, 200);
    assert.equal((await node(a)).content, "live"); assert.equal((await node(b)).trashed, true); assert.equal(await node(`${root}/target`), undefined);
  });

  await safeTest("destination ancestors that are files or in Trash are rejected without changing source", cov, async () => {
    const a = `${root}/a.txt`, block = `${root}/block`, bin = `${root}/bin`; await write(a, "source"); await write(block, "not a folder"); await write(`${bin}/old.txt`, "trashed"); await must({ op: "trash", path: bin });
    assert.notEqual((await post({ op: "move", src: a, dst: `${block}/bad.txt` })).status, 200);
    assert.notEqual((await post({ op: "copy", src: a, dst: `${bin}/bad.txt` })).status, 200);
    assert.equal((await node(a)).content, "source"); assert.equal(await node(`${block}/bad.txt`), undefined); assert.equal(await node(`${bin}/bad.txt`), undefined);
  });

  await safeTest("corrupt source content is detected by recomputing its digest before publication", cov, async () => {
    const a = `${root}/a.txt`, b = `${root}/b.txt`; await write(a, "valid");
    await db.query("UPDATE vfs_nodes SET content='corrupted' WHERE path=$1", [a]);
    assert.notEqual((await post({ op: "move", src: a, dst: b })).status, 200);
    assert.equal((await node(a)).content, "corrupted"); assert.equal(await node(b), undefined);
  });

  await safeTest("a corrupt descendant aborts a whole directory copy, not just a corrupt root", cov, async () => {
    const from = `${root}/tree`, a = `${from}/good.txt`, b = `${from}/bad.txt`, to = `${root}/copy`;
    await write(a, "good"); await write(b, "valid"); await db.query("UPDATE vfs_nodes SET content='corrupted child' WHERE path=$1", [b]);
    assert.notEqual((await post({ op: "copy", src: from, dst: to })).status, 200);
    assert.equal((await node(a)).content, "good"); assert.equal((await node(b)).content, "corrupted child"); assert.equal(await node(to), undefined);
  });

  await safeTest("an index publication fault rolls back the entire move, including created parent folders", cov, async () => {
    const a = `${root}/a.txt`, b = `${root}/new/deep/b.txt`; await write(a, "keep me");
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='file' AND NEW.ref='${b}' THEN RAISE EXCEPTION 'tt93 index fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON index_docs FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      assert.notEqual((await post({ op: "move", src: a, dst: b })).status, 200);
      assert.equal((await node(a)).content, "keep me"); assert.equal(await node(b), undefined); assert.equal(await node(`${root}/new`), undefined); assert.equal((await index(a))[0]?.body, "keep me");
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON index_docs`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  });

  await safeTest("a journal completion fault rolls back data, history and search instead of reporting a half-move", cov, async () => {
    const a = `${root}/a.txt`, b = `${root}/b.txt`; await write(a, "old"); await write(a, "new");
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.op='move' AND NEW.src='${a}' AND NEW.state='COMPLETE' THEN RAISE EXCEPTION 'tt93 journal fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON file_ops FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      assert.notEqual((await post({ op: "move", src: a, dst: b })).status, 200);
      assert.equal((await node(a)).content, "new"); assert.equal(await node(b), undefined); assert.equal((await versions(a))[0]?.content, "old"); assert.equal((await index(a))[0]?.body, "new");
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON file_ops`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  });

  await safeTest("an orphaned destination version reserves the path instead of mixing unrelated histories", cov, async () => {
    const a = `${root}/a.txt`, b = `${root}/b.txt`; await write(a, "source");
    await db.query("INSERT INTO vfs_versions(path,version,content) VALUES ($1,1,'unrelated history')", [b]);
    assert.notEqual((await post({ op: "move", src: a, dst: b })).status, 200);
    assert.equal((await node(a)).content, "source"); assert.equal(await node(b), undefined); assert.equal((await versions(b))[0]?.content, "unrelated history");
  });

  await safeTest("an orphaned destination search row is never overwritten by a move", cov, async () => {
    const a = `${root}/a.txt`, b = `${root}/b.txt`; await write(a, "source");
    await db.query("INSERT INTO index_docs(source,ref,title,body) VALUES ('file',$1,'unrelated','keep it')", [b]);
    assert.notEqual((await post({ op: "move", src: a, dst: b })).status, 200);
    assert.equal((await node(a)).content, "source"); assert.equal(await node(b), undefined); assert.equal((await index(b))[0]?.body, "keep it");
  });

  await safeTest("a public tree moved beneath Private leaves no public or private search entries", cov, async () => {
    const a = `${root}/public/sub/secret.txt`, b = `${privateRoot}/moved/sub/secret.txt`; await write(a, "secret not in search");
    await must({ op: "move", src: `${root}/public`, dst: `${privateRoot}/moved` });
    assert.equal((await node(b)).content, "secret not in search"); assert.deepEqual(await index(a), []); assert.deepEqual(await index(b), []);
  });

  await safeTest("a photo sidecar collision refuses the whole move without overwriting or misattaching edits", cov, async () => {
    const a = `${root}/source.jpg`, b = `${root}/dest.jpg`, src = `${root}/.source.jpg.edit.json`, dst = `${root}/.dest.jpg.edit.json`;
    await write(a, "image", "image/jpeg"); await write(src, "source edits"); await write(dst, "unrelated edits");
    const moved = await post({ op: "move", src: a, dst: b });
    assert.notEqual(moved.status, 200); assert.equal((await node(a)).content, "image"); assert.equal(await node(b), undefined);
    assert.equal((await node(src)).content, "source edits"); assert.equal((await node(dst)).content, "unrelated edits");
  });

  await safeTest("an orphan destination sidecar cannot attach unrelated edits to a photo without a sidecar", cov, async () => {
    const a = `${root}/source.jpg`, b = `${root}/dest.jpg`, dst = `${root}/.dest.jpg.edit.json`;
    await write(a, "image", "image/jpeg"); await write(dst, "unrelated edits");
    assert.notEqual((await post({ op: "copy", src: a, dst: b })).status, 200);
    assert.equal((await node(a)).content, "image"); assert.equal(await node(b), undefined); assert.equal((await node(dst)).content, "unrelated edits");
  });

  await safeTest("a trashed sidecar cannot be silently detached from its photo by a move", cov, async () => {
    const a = `${root}/source.jpg`, b = `${root}/dest.jpg`, src = `${root}/.source.jpg.edit.json`;
    await write(a, "image", "image/jpeg"); await write(src, "edits"); await must({ op: "trash", path: src });
    assert.notEqual((await post({ op: "move", src: a, dst: b })).status, 200);
    assert.equal((await node(a)).content, "image"); assert.equal((await node(src)).trashed, true); assert.equal(await node(b), undefined);
  });

  await safeTest("a sidecar publication fault rolls back both the photo and its edit", cov, async () => {
    const a = `${root}/source.jpg`, b = `${root}/dest.jpg`, src = `${root}/.source.jpg.edit.json`, dst = `${root}/.dest.jpg.edit.json`;
    await write(a, "image", "image/jpeg"); await write(src, "old edits"); await write(src, "new edits");
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='file' AND NEW.ref='${dst}' THEN RAISE EXCEPTION 'tt93 sidecar fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON index_docs FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      assert.notEqual((await post({ op: "move", src: a, dst: b })).status, 200);
      assert.equal((await node(a)).content, "image"); assert.equal((await node(src)).content, "new edits"); assert.equal((await versions(src))[0]?.content, "old edits");
      assert.equal(await node(b), undefined); assert.equal(await node(dst), undefined);
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON index_docs`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  });
} finally { if (own) await clean(); await db.end(); finish(); }
