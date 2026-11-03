/** Native HTTP/PostgreSQL witnesses. Database locks/cancellation are real
 * operations in the explicitly disposable database, not mocked API results. */
import assert from "node:assert/strict";
import pg from "pg";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt133-http");
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.BASE || !process.env.DATABASE_URL) throw new Error("exclusive disposable BASE and DATABASE_URL required");
const BASE = process.env.BASE, RUN = `tt133h-${Date.now().toString(36)}`, DIR = `/Documents/${RUN}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ids = new Set<number>();
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json() };
}
async function good(method: string, path: string, body?: unknown) { const r = await call(method, path, body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function create(body = "base", title = `${RUN} Note`) { const r = await good("POST", "/api/notes", { title, body }); ids.add(r.row.id); return r.row; }
async function write(path: string, content: string, mime = "text/plain") { return good("POST", "/api/fs", { op: "write", path, content, mime }); }
async function indexed(id: number) { return (await pool.query("select title,body from index_docs where source='note' and ref=$1", [String(id)])).rows; }
async function snapshot(where = "true") { return (await pool.query(`select id,source,ref,title,body,updated_at from index_docs where ${where} order by id`)).rows; }
async function waiting(fragment: string, timeout = 6000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const r = await pool.query("select pid,query,wait_event from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active' and wait_event_type='Lock' and query like $1", [`%${fragment}%`]);
    if (r.rows.length) return r.rows[0]; await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`No real PostgreSQL lock wait observed for ${fragment}`);
}
let priorExcludes: string | undefined;
try {
  await good("GET", "/api/health");
  const encoding = (await pool.query("show server_encoding")).rows[0].server_encoding; assert.equal(encoding, "UTF8", "this suite requires a real UTF-8 database, not SQL_ASCII");
  await test("Native runtime exposes non-null positive note revisions; strict writes reject bad JSON field values without changing the note or index", { "NT-10": "partial" }, async () => {
    const n = await create("Unicode μ → 🧭"); assert.equal(n.revision, 1); const before = (await good("GET", `/api/notes?id=${n.id}`)).row, idx = await indexed(n.id);
    for (const bad of [{ title: " " }, { body: "nul\0" }, { body: "\ud800" }, { pinned: "yes" }, { tags: "x".repeat(2049) }, { expectedRevision: "1", body: "bad" }, { id: 0, body: "bad" }]) { const r = await call("PUT", "/api/notes", { id: n.id, expectedRevision: n.revision, ...bad }); assert.equal(r.status, 400, JSON.stringify(bad)); }
    assert.deepEqual((await good("GET", `/api/notes?id=${n.id}`)).row, before); assert.deepEqual(await indexed(n.id), idx);
  });
  await test("Eight concurrent genuine HTTP saves serialize on one PostgreSQL row: exactly one revision wins, seven get 409, index agrees", { "NT-10": "partial" }, async () => {
    const n = await create(); const values = Array.from({ length: 8 }, (_, i) => `concurrent writer ${i} 🧭`);
    const results = await Promise.all(values.map(body => call("PUT", "/api/notes", { id: n.id, expectedRevision: n.revision, body })));
    assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(results.filter(r => r.status === 409).length, 7);
    const winner = results.find(r => r.status === 200)!.data.row, current = (await good("GET", `/api/notes?id=${n.id}`)).row; assert.equal(current.revision, 2); assert.equal(current.body, winner.body); assert.deepEqual(await indexed(n.id), [{ title: current.title, body: current.body }]);
    assert.equal((await call("DELETE", `/api/notes?id=${n.id}`, { expectedRevision: 1 })).status, 409); assert.equal((await indexed(n.id)).length, 1);
    await good("DELETE", `/api/notes?id=${n.id}`, { expectedRevision: 2 }); assert.equal((await call("GET", `/api/notes?id=${n.id}`)).status, 404); assert.deepEqual(await indexed(n.id), []); ids.delete(n.id);
  });
  await test("A→B→A is still a new revision; old equal-content token cannot overwrite it", { "NT-10": "partial" }, async () => {
    const n = await create("A"); const b = await good("PUT", "/api/notes", { id: n.id, expectedRevision: 1, body: "B" }); const a = await good("PUT", "/api/notes", { id: n.id, expectedRevision: b.row.revision, body: "A" }); assert.equal(a.row.revision, 3);
    assert.equal((await call("PUT", "/api/notes", { id: n.id, expectedRevision: 1, body: "stale" })).status, 409); assert.equal((await good("GET", `/api/notes?id=${n.id}`)).row.body, "A");
  });
  await test("Native cancellation after note UPDATE but during blocked index UPSERT rolls back both; server reports 503, never saved", { "NT-10": "partial" }, async () => {
    const n = await create("before cancellation"), before = (await good("GET", `/api/notes?id=${n.id}`)).row, idx = await indexed(n.id);
    const lock = await pool.connect(); await lock.query("begin"); await lock.query("select id from index_docs where source='note' and ref=$1 for update", [String(n.id)]);
    try {
      const pending = call("PUT", "/api/notes", { id: n.id, expectedRevision: n.revision, body: "must roll back" }); const blocker = await waiting('insert into "index_docs"');
      assert.equal((await good("GET", `/api/notes?id=${n.id}`)).row.body, before.body, "uncommitted UPDATE must be invisible"); assert.equal((await pool.query("select pg_cancel_backend($1) as cancelled", [blocker.pid])).rows[0].cancelled, true);
      const r = await pending; assert.equal(r.status, 503); assert.equal(r.data.ok, false); assert.deepEqual((await good("GET", `/api/notes?id=${n.id}`)).row, before); assert.deepEqual(await indexed(n.id), idx);
    } finally { await lock.query("rollback"); lock.release(); }
    await good("PUT", "/api/notes", { id: n.id, expectedRevision: n.revision, body: "retry succeeds" });
  });
  const unicode = "🧭".repeat(50_000) + "TAIL-SHOULD-NOT-BE-INDEXED";
  await test("Every note/file index prefix is 50,000 Unicode code points, matches real PostgreSQL left(), and never splits a surrogate", { "NT-10": "partial", "SR-17": "partial" }, async () => {
    const n = await create(unicode); await write(`${DIR}/unicode.md`, unicode, "text/markdown");
    const r = await pool.query("select i.ref,char_length(i.body)::int as chars,i.body=left(case when i.source='note' then n.body else f.content end,50000) as exact from index_docs i left join notes n on i.source='note' and n.id::text=i.ref left join vfs_nodes f on i.source='file' and f.path=i.ref where (i.source='note' and i.ref=$1) or (i.source='file' and i.ref=$2)", [String(n.id), `${DIR}/unicode.md`]); assert.equal(r.rows.length, 2); for (const row of r.rows) { assert.equal(row.chars, 50_000); assert.equal(row.exact, true); }
  });
  await test("Source/metadata/suffix/mode validation runs before search work and refuses nonsensical combinations", { "SR-13": "partial", "SR-16": "partial" }, async () => {
    for (const query of ["q=x&source=other", "q=x&mode=metadata&source=note", "q=x&mode=metadata&source=spec&scope=%2FPrivate", "q=x&source=note&extension=.md", "q=x&match=semantic", "q=x&scope=%2Fa%2F..%2Fb", "q=x&extension=%25", "q=x&mode=remote"]) assert.equal((await call("GET", `/api/search?${query}`)).status, 400, query);
  });
  await test("Literal search keeps SQL wildcard characters literal, returns numeric ranks and excludes fuzzy-only names", { "SR-15": "partial", "SR-16": "partial" }, async () => {
    await write(`${DIR}/literal.MD`, `${RUN} %_two  spaces`); await write(`${DIR}/neighbour.txt`, `${RUN} XXtwo gap spaces`);
    const p = new URLSearchParams({ q: "%_two  spaces", scope: DIR, source: "file", extension: "md", match: "literal" }); const r = await good("GET", `/api/search?${p}`); assert.deepEqual(r.hits.map((h: any) => h.ref), [`${DIR}/literal.MD`]); assert.equal(r.hits[0].how, "literal"); assert.equal(typeof r.hits[0].rank, "number");
    assert.equal((await good("GET", `/api/search?${new URLSearchParams({ q: "%_two three", scope: DIR, match: "literal" })}`)).hits.length, 0);
  });
  await test("Metadata suffix filtering occurs before the 32-file page, not after consuming wrong-suffix budget", { "SR-16": "partial" }, async () => {
    for (let i = 0; i < 33; i++) await write(`${DIR}/suffix/${String(i).padStart(2, "0")}.txt`, "wrong format"); await write(`${DIR}/suffix/z.JSON`, JSON.stringify({ artist: RUN }), "application/json");
    const r = await good("GET", `/api/search?${new URLSearchParams({ mode: "metadata", q: RUN, scope: `${DIR}/suffix`, extension: "JSON", field: "artist", source: "file" })}`); assert.deepEqual(r.hits.map((h: any) => h.ref), [`${DIR}/suffix/z.JSON`]); assert.equal(r.scanned, 1); assert.ok(!r.nextCursor);
  });
  const settings = await good("GET", "/api/settings"); priorExcludes = settings.rows.find((r: any) => r.key === "search.excludes")?.value;
  await test("Current exclusions are literal folder boundaries in fast search, live metadata and diagnostics (underscore cannot hide its neighbour)", { "SR-18": "partial", "SR-17": "partial" }, async () => {
    await write(`${DIR}/a_b/item.json`, JSON.stringify({ marker: RUN }), "application/json"); await write(`${DIR}/aXb/item.json`, JSON.stringify({ marker: RUN }), "application/json");
    await good("PUT", "/api/settings", { key: "search.excludes", value: [priorExcludes ?? "/System/Cache", `${DIR}/a_b`].join(",") });
    for (const mode of ["text", "metadata"]) { const r = await good("GET", `/api/search?${new URLSearchParams({ mode, q: RUN, scope: DIR, source: "file", match: "literal", extension: ".json" })}`); assert.ok(r.hits.some((h: any) => h.ref === `${DIR}/aXb/item.json`)); assert.ok(!r.hits.some((h: any) => h.ref === `${DIR}/a_b/item.json`)); }
    const diagnosis = await good("GET", `/api/search?${new URLSearchParams({ mode: "diagnose", path: `${DIR}/a_b/item.json` })}`); assert.equal(diagnosis.status, "excluded");
  });
  await test("Path diagnosis distinguishes saved/current, stale, missing, folders, trash, private and name-only binary content", { "SR-18": "partial" }, async () => {
    const path = `${DIR}/diagnose.txt`; await write(path, "current text"); const diagnose = (path: string) => good("GET", `/api/search?${new URLSearchParams({ mode: "diagnose", path })}`);
    assert.equal((await diagnose(path)).status, "indexed"); await pool.query("update index_docs set body='older data' where source='file' and ref=$1", [path]); assert.equal((await diagnose(path)).status, "stale");
    assert.equal((await diagnose(`${DIR}/never-existed.txt`)).status, "missing"); assert.equal((await diagnose(DIR)).status, "folder"); assert.equal((await diagnose("/Private/no-such-name.txt")).status, "private");
    await good("POST", "/api/fs", { op: "upload", path: `${DIR}/bytes.bin`, content: "AAECAw==", mime: "application/octet-stream" }); assert.equal((await diagnose(`${DIR}/bytes.bin`)).status, "name-only");
    await good("POST", "/api/fs", { op: "trash", path }); assert.equal((await diagnose(`${DIR}/.Trash`)).status, "missing"); const trashed = (await pool.query("select path from vfs_nodes where name='diagnose.txt' and trashed and trashed_from=$1", [path])).rows[0]; assert.ok(trashed); assert.equal((await diagnose(trashed.path)).status, "trashed"); await good("POST", "/api/fs", { op: "restore", path: trashed.path });
  });
  await test("Unconfirmed rebuilds and malformed bodies return 400 without changing any index rows", { "SR-17": "partial" }, async () => {
    const before = await snapshot(); for (const body of [{}, { confirm: "rebuild" }, { confirm: true }, []]) assert.equal((await call("POST", "/api/search", body)).status, 400);
    for (const body of ["", "{", "null"]) { const r = await fetch(BASE + "/api/search", { method: "POST", headers: { "content-type": "application/json" }, body }); assert.equal(r.status, 400); await r.arrayBuffer(); }
    assert.deepEqual(await snapshot(), before);
  });
  await test("Native lock timeout after a rebuild DELETE starts rolls it all back; concurrent readers see the complete old index and 503 says not rebuilt", { "SR-17": "partial" }, async () => {
    const target = (await pool.query("select id from index_docs where source in ('file','note') order by id desc limit 1")).rows[0]; assert.ok(target);
    const lock = await pool.connect(); await lock.query("begin"); await lock.query("select id from index_docs where id=$1 for update", [target.id]); const before = await snapshot();
    try {
      const started = performance.now(), pending = call("POST", "/api/search", { confirm: "REBUILD" }); const observed = await waiting("delete from index_docs"); assert.equal(observed.wait_event, "transactionid"); assert.deepEqual(await snapshot(), before, "MVCC reader must not see a partially deleted index");
      const r = await pending, elapsed = performance.now() - started; assert.equal(r.status, 503); assert.equal(r.data.rebuilt, false); assert.ok(elapsed >= 3500 && elapsed < 9000, `real lock timeout took ${elapsed}ms`); assert.deepEqual(await snapshot(), before); console.log(`  actual rebuild lock timeout: ${elapsed.toFixed(3)}ms`);
    } finally { await lock.query("rollback"); lock.release(); }
  });
  await test("A confirmed real rebuild repairs missing/stale entries, preserves notes/files and all spec/setting rows, and matches PostgreSQL's canonical prefix", { "SR-17": "partial" }, async () => {
    await pool.query("delete from index_docs where source='file' and ref=$1", [`${DIR}/literal.MD`]); const untouched = await snapshot("source in ('spec','setting')"), originals = (await pool.query("select id,title,body,tags,pinned,revision,updated_at from notes order by id")).rows;
    const rebuilt = await good("POST", "/api/search", { confirm: "REBUILD" }); assert.equal(rebuilt.rebuilt, true); assert.equal(rebuilt.bodyUnit, "Unicode code points"); assert.deepEqual(await snapshot("source in ('spec','setting')"), untouched); assert.deepEqual((await pool.query("select id,title,body,tags,pinned,revision,updated_at from notes order by id")).rows, originals);
    const mismatch = await pool.query("select count(*)::int as n from notes n left join index_docs i on i.source='note' and i.ref=n.id::text where i.id is null or i.title<>n.title or i.body<>left(n.body,50000)"); assert.equal(mismatch.rows[0].n, 0, "note prefixes must equal PostgreSQL left()");
    assert.equal((await good("GET", `/api/search?${new URLSearchParams({ mode: "diagnose", path: `${DIR}/literal.MD` })}`)).status, "indexed"); const hidden = await pool.query("select count(*)::int as n from index_docs where source='file' and (ref='/Private' or ref like '/Private/%' or starts_with(ref,$1))", [`${DIR}/a_b/`]); assert.equal(hidden.rows[0].n, 0, "Private and exact excluded folder prefix must be absent");
  });
} finally {
  if (priorExcludes !== undefined) await good("PUT", "/api/settings", { key: "search.excludes", value: priorExcludes });
  for (const id of ids) await good("DELETE", `/api/notes?id=${id}`);
  await good("POST", "/api/fs", { op: "purge", path: DIR }); await pool.end(); finish();
}
