/** Real HTTP/PostgreSQL trash and restore adversaries. Exclusive disposable database/server only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing trash tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex");
const root = `/Documents/tt92-trash-${id}_%`, neighbor = `/Documents/tt92-trash-${id}AX`, privateRoot = `/Private/tt92-trash-${id}`;
const roots = [root, neighbor, privateRoot], fn = `tt92_trash_guard_${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("tt92-trash"), cov = { "FM-11": "partial", "SR-01": "partial", "SC-10": "partial" } as const;
const post = async (body: object) => { const r = await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const must = async (body: object) => { const r = await post(body); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const scope = (c: string) => `(${c}=$1 OR left(${c},char_length($1)+1)=$1||'/')`;
const clean = async () => { for (const path of roots) {
  await db.query(`DELETE FROM vfs_versions WHERE ${scope("path")}`, [path]);
  await db.query(`DELETE FROM vfs_nodes WHERE ${scope("path")}`, [path]);
  await db.query(`DELETE FROM index_docs WHERE source='file' AND ${scope("ref")}`, [path]);
} };
const write = (path: string, content: string) => must({ op: "write", path, content, mime: "text/plain" });
const getNode = async (path: string) => (await db.query("SELECT path,kind,content,trashed,trashed_from,version FROM vfs_nodes WHERE path=$1", [path])).rows[0];
const index = async (path: string) => (await db.query("SELECT ref,body FROM index_docs WHERE source='file' AND ref=$1", [path])).rows;
const safeTest: typeof test = async (name, covers, f) => test(name, covers, async () => { try { await f(); } finally { await clean(); } });
let own = false;
try {
  for (const path of roots) for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) {
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${scope(col)} LIMIT 1`, [path])).rowCount, 0, `fixture already exists: ${path}`);
  }
  own = true;
  await safeTest("trashing a directory hides every descendant from real search; restoring reindexes only that trash group", cov, async () => {
    const a = `${root}/sub/a.txt`, b = `${root}/sub/deep/b.txt`, earlier = `${root}/earlier.txt`, other = `${neighbor}/keep.txt`, token = `quartz${id}`;
    await write(a, `old ${token}`); await write(a, `new ${token}`); await write(b, `nested ${token}`); await write(earlier, `earlier ${token}`); await write(other, `neighbor ${token}`);
    assert.equal((await getNode(a)).content, `new ${token}`, "server/database mismatch");
    await must({ op: "trash", path: earlier }); await must({ op: "trash", path: root });
    for (const p of [a, b, earlier]) { assert.equal((await getNode(p)).trashed, true); assert.deepEqual(await index(p), []); }
    assert.equal((await getNode(earlier)).trashed_from, earlier, "a later parent trash must not replace an existing child trash group");
    assert.equal((await getNode(other)).trashed, false); assert.equal((await index(other)).length, 1, "literal _ and % neighbors must survive");
    const search = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(token)}&source=file`)).json();
    assert.ok(!search.hits.some((h: { ref: string }) => [a, b, earlier].includes(h.ref)), "trashed descendant leaked through search");
    await must({ op: "restore", path: root });
    for (const p of [a, b]) { assert.equal((await getNode(p)).trashed, false); assert.equal((await index(p)).length, 1); }
    assert.equal((await getNode(earlier)).trashed, true); assert.deepEqual(await index(earlier), []);
    assert.equal((await db.query("SELECT count(*)::int n FROM vfs_versions WHERE path=$1", [a])).rows[0].n, 1, "trash/restore must preserve saved versions");
    const after = await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(token)}&source=file`)).json();
    assert.ok(after.hits.some((h: { ref: string }) => h.ref === a)); assert.ok(after.hits.some((h: { ref: string }) => h.ref === b));
  });
  await safeTest("ordinary and conditional writes cannot overwrite a trashed item or create under a trashed parent", cov, async () => {
    const path = `${root}/old.txt`; await write(path, "keep in trash"); await must({ op: "trash", path: root });
    const overwrite = await post({ op: "write", path, content: "new" }); assert.notEqual(overwrite.status, 200, "trashed item overwritten");
    const create = await post({ op: "write", path: `${root}/new.txt`, content: "new" }); assert.notEqual(create.status, 200, "created inside trashed folder");
    const directory = await post({ op: "mkdir", path: `${root}/new-folder` }); assert.notEqual(directory.status, 200, "folder created inside trash");
    const conditional = await post({ op: "writeIfUnchanged", path: `${root}/other.txt`, content: "new", expected: null }); assert.notEqual(conditional.status, 200);
    assert.equal((await getNode(path)).content, "keep in trash"); assert.equal((await getNode(path)).trashed, true); assert.deepEqual(await index(path), []);
  });
  await safeTest("trash listings preserve metadata and content-presence flags without exposing file bodies", cov, async () => {
    const filled = `${root}/filled.txt`, empty = `${root}/empty.txt`; await write(filled, "hidden body"); await write(empty, ""); await must({ op: "trash", path: root });
    const r = await fetch(`${BASE}/api/fs?op=trash&path=%2F`); assert.equal(r.status, 200); const listing = await r.json();
    const f = listing.nodes.find((n: { path: string }) => n.path === filled), e = listing.nodes.find((n: { path: string }) => n.path === empty);
    assert.equal(f.hasContent, true); assert.equal(e.hasContent, false); assert.equal(f.base, "filled.txt"); assert.equal(f.trashedFrom, root);
    assert.ok(!("content" in f)); assert.ok(!("content" in e));
  });
  await safeTest("a trashed file reserves its original path and ordinary writes cannot silently revive it", cov, async () => {
    const path = `${root}/single.txt`; await write(path, "original"); await must({ op: "trash", path });
    const r = await post({ op: "write", path, content: "overwrite" }); assert.notEqual(r.status, 200);
    assert.equal((await getNode(path)).content, "original"); assert.equal((await getNode(path)).trashed, true);
    assert.equal((await db.query("SELECT count(*)::int n FROM vfs_versions WHERE path=$1", [path])).rows[0].n, 0); assert.deepEqual(await index(path), []);
  });
  await safeTest("a child cannot be restored into a parent still in trash", cov, async () => {
    const child = `${root}/nested/item.txt`; await write(child, "nested"); await must({ op: "trash", path: root });
    const r = await post({ op: "restore", path: child }); assert.notEqual(r.status, 200); assert.equal((await getNode(child)).trashed, true);
  });
  await safeTest("legacy rows without a trash group are restored one at a time rather than merged ambiguously", cov, async () => {
    const path = `${root}/legacy.txt`; await write(path, "legacy"); await must({ op: "trash", path: root });
    await db.query("UPDATE vfs_nodes SET trashed_from=NULL WHERE path=ANY($1::text[])", [[root, path]]);
    await must({ op: "restore", path: root });
    assert.equal((await getNode(root)).trashed, false); assert.equal((await getNode(path)).trashed, true, "ambiguous legacy child was silently restored");
    await must({ op: "restore", path }); assert.equal((await getNode(path)).trashed, false); assert.equal((await index(path))[0]?.body, "legacy");
  });
  await safeTest("a failed search-index deletion rolls the entire trash operation back", cov, async () => {
    const path = `${root}/item.txt`; await write(path, "rollback me");
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.ref='${path}' AND OLD.source='file' THEN RAISE EXCEPTION 'tt92 trash index fault'; END IF; RETURN OLD; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE DELETE ON index_docs FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const r = await post({ op: "trash", path }); assert.notEqual(r.status, 200);
      assert.equal((await getNode(path)).trashed, false); assert.equal((await index(path)).length, 1);
      assert.equal((await db.query("SELECT count(*)::int n FROM file_ops WHERE op='trash' AND src=$1", [path])).rows[0].n, 0);
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON index_docs`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  });
  await safeTest("a failed search-index rebuild rolls the entire restore operation back", cov, async () => {
    const path = `${root}/item.txt`; await write(path, "recover me"); await must({ op: "trash", path });
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ref='${path}' AND NEW.source='file' THEN RAISE EXCEPTION 'tt92 restore index fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON index_docs FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const r = await post({ op: "restore", path }); assert.notEqual(r.status, 200);
      assert.equal((await getNode(path)).trashed, true); assert.deepEqual(await index(path), []);
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON index_docs`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  });
  await safeTest("a failed restore journal rolls restored nodes and their new index entries back", cov, async () => {
    const path = `${root}/journal.txt`; await write(path, "journal rollback"); await must({ op: "trash", path });
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.op='restore' AND NEW.src='${path}' THEN RAISE EXCEPTION 'tt92 restore journal fault'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON file_ops FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const r = await post({ op: "restore", path }); assert.notEqual(r.status, 200);
      assert.equal((await getNode(path)).trashed, true); assert.deepEqual(await index(path), []);
    } finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON file_ops`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  });
  await safeTest("restoring a private subtree never writes its contents or names to the host search index", cov, async () => {
    const path = `${privateRoot}/cipher.txt`; await write(path, "private sentinel"); await must({ op: "trash", path: privateRoot }); await must({ op: "restore", path: privateRoot });
    assert.equal((await getNode(path)).trashed, false); assert.deepEqual(await index(path), []);
  });
  await safeTest("trashing the virtual root is refused before any database mutation", cov, async () => {
    // A malformed/legacy database may contain a root row; add one only if absent,
    // and use a statement trigger as a seatbelt against a buggy global UPDATE.
    const existing = (await db.query("SELECT 1 FROM vfs_nodes WHERE path='/'")).rowCount;
    if (!existing) await db.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime) VALUES ('/','/','/','dir','inode/directory')");
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'tt92 root seatbelt'; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON vfs_nodes FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`);
    try { const r = await post({ op: "trash", path: "/" }); assert.notEqual(r.status, 200); assert.match(String(r.json.error), /root/i); assert.doesNotMatch(String(r.json.error), /seatbelt/i); }
    finally { await db.query(`DROP TRIGGER IF EXISTS ${fn} ON vfs_nodes`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`); if (!existing) await db.query("DELETE FROM vfs_nodes WHERE path='/'"); }
  });
} finally {
  for (const table of ["vfs_nodes", "index_docs", "file_ops"]) await db.query(`DROP TRIGGER IF EXISTS ${fn} ON ${table}`).catch(() => undefined);
  await db.query(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => undefined);
  if (own) await clean(); await db.end();
}
finish();
