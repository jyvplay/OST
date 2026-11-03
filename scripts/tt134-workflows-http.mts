/** Exclusive real PostgreSQL + deployed HTTP, including native lock timeout.
 * Owned SQL fixtures are actual data/locks, not fake services or routes. */
import assert from "node:assert/strict";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Explicit exclusive disposable BASE/DATABASE_URL required");
const BASE = process.env.BASE, RUN = `tt134-http-${Date.now().toString(36)}`, DIR = `/Documents/${RUN}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const ids = new Set<number>(), { test, finish } = makeHarness("tt134-workflows-http");
async function request(method: string, path: string, data?: unknown) {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(25_000) });
  const body = await response.json(); return { status: response.status, body };
}
async function ok(method: string, path: string, data?: unknown) { const result = await request(method, path, data); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
async function batch(notes: { title: string; body?: string; tags?: string; pinned?: boolean }[]) { const result = await ok("POST", "/api/notes/batch", { notes }); for (const row of result.rows) ids.add(row.id); return result.rows; }
async function file(path: string, content: string, mime = "text/plain", encoding = "utf8") { await ok("POST", "/api/fs", { op: "write", path, content, mime, encoding }); }
async function search(extra: Record<string, string> = {}) { return ok("GET", `/api/search?${new URLSearchParams({ q: RUN, match: "literal", source: "file", scope: DIR, ...extra })}`); }
const savedExclusions = await pool.query("select value from settings where key='search.excludes'");
try {
  await test("Batch commits exact editable fields and every real public index row together", { "NT-19": "partial", "NT-20": "partial", "NT-21": "partial" }, async () => {
    const expected = [{ title: `${RUN} μ`, body: "x\r\n🧭\n<script>literal</script>", tags: "alpha,beta", pinned: true }, { title: `${RUN} prefix`, body: "🧭".repeat(50_000) + "TAIL", tags: "", pinned: false }];
    const rows = await batch(expected); assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
    for (let i = 0; i < rows.length; i++) { const stored = (await pool.query("select * from notes where id=$1", [rows[i].id])).rows[0]; for (const key of ["title", "body", "tags", "pinned"]) assert.equal(stored[key], expected[i][key as keyof typeof expected[number]]); assert.equal(stored.revision, 1); const index = (await pool.query("select * from index_docs where source='note' and ref=$1", [String(rows[i].id)])).rows[0]; assert.equal(index.title, expected[i].title); assert.equal(index.body, i ? "🧭".repeat(50_000) : expected[i].body); }
  });
  await test("All-row input validation and byte-stream limit reject without creating any partial notes", { "NT-19": "partial" }, async () => {
    const before = Number((await pool.query("select count(*)::int as n from notes")).rows[0].n);
    for (const notes of [[], [{ title: `${RUN} invalid first valid` }, { title: " " }], [{ title: "bad", id: 17 }], Array(33).fill({ title: "too many" }), [{ title: "bad", body: "\ud800" }]]) assert.equal((await request("POST", "/api/notes/batch", { notes })).status, 400);
    const oversized = await fetch(BASE + "/api/notes/batch", { method: "POST", headers: { "content-type": "application/json" }, body: '{"notes":[' + ' '.repeat(4_194_304 + 4096) + "]}", signal: AbortSignal.timeout(15_000) }); assert.equal(oversized.status, 413);
    const malformed = await fetch(BASE + "/api/notes/batch", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff, 0xfe]) }); assert.equal(malformed.status, 400);
    assert.equal(Number((await pool.query("select count(*)::int as n from notes")).rows[0].n), before);
  });
  await test("Real index-table lock causes four-second refusal and rolls back already-inserted batch notes", { "NT-19": "partial", "NT-20": "partial", "NT-21": "partial" }, async () => {
    const lock = await pool.connect();
    try { await lock.query("begin"); await lock.query("lock table index_docs in access exclusive mode"); const started = performance.now();
      const result = await request("POST", "/api/notes/batch", { notes: [{ title: `${RUN} blocked-one` }, { title: `${RUN} blocked-two` }] });
      assert.equal(result.status, 503); assert.ok(performance.now() - started >= 3900); assert.equal((await pool.query("select id from notes where title like $1", [`${RUN} blocked%`])).rowCount, 0);
    } finally { await lock.query("rollback"); lock.release(); }
    assert.equal((await pool.query("select ref from index_docs where title like $1", [`${RUN} blocked%`])).rowCount, 0);
  });
  const early = `${DIR}/early.txt`, late = `${DIR}/late.txt`, excluded = `${DIR}/archive_%/hidden.txt`, sibling = `${DIR}/archive_%sibling/visible.txt`;
  const contents = new Map([[early, `${RUN} 🧭`], [late, `${RUN} ` + "z".repeat(100)], [excluded, `${RUN} hidden`], [sibling, `${RUN} sibling`]]);
  for (const [path, content] of contents) await file(path, content);
  await pool.query("update vfs_nodes set updated_at='2020-02-29T10:00:00Z' where path=$1", [early]);
  await pool.query("update vfs_nodes set updated_at='2024-01-01T00:00:00Z' where path=$1", [late]);
  await test("Modified intervals read canonical file timestamps, not fresh index/rebuild timestamps, in literal and live metadata", { "SR-20": "partial" }, async () => {
    for (const mode of ["text", "metadata"]) { const result = await search({ mode, modifiedAfter: "2020-02-29", modifiedBefore: "2020-03-01" }); assert.deepEqual(result.hits.map((hit: any) => hit.ref), [early]); }
    assert.equal((await search({ modifiedBefore: "2020-02-29" })).hits.length, 0);
    assert.equal((await request("GET", `/api/search?${new URLSearchParams({ q: RUN, modifiedAfter: "2025-02-29" })}`)).status, 400);
  });
  await test("Content byte intervals use real UTF-8 file/note sizes; zero/bad/incompatible ranges are explicit", { "SR-21": "partial" }, async () => {
    const size = String(Buffer.byteLength(contents.get(early)!));
    for (const mode of ["text", "metadata"]) assert.deepEqual((await search({ mode, minBytes: size, maxBytes: size })).hits.map((hit: any) => hit.ref), [early]);
    const body = `${RUN} note 🧭`, note = (await batch([{ title: `${RUN} byte-note`, body }]))[0];
    const result = await search({ source: "note", scope: "", minBytes: String(Buffer.byteLength(body)), maxBytes: String(Buffer.byteLength(body)) }); assert.deepEqual(result.hits.map((hit: any) => hit.ref), [String(note.id)]);
    const badRanges: Record<string, string>[] = [{ minBytes: "9", maxBytes: "8" }, { minBytes: "-1" }, { maxBytes: "01" }, { source: "setting", maxBytes: "20" }];
    for (const params of badRanges) assert.equal((await request("GET", `/api/search?${new URLSearchParams({ q: RUN, ...params })}`)).status, 400);
  });
  await test("Folder exclusion applies before all server branches and metadata paging, preserving wildcard-named siblings", { "SR-22": "partial" }, async () => {
    for (const mode of ["text", "metadata"]) { const refs = (await search({ mode, excludeFolder: `${DIR}/archive_%` })).hits.map((hit: any) => hit.ref); assert.ok(!refs.includes(excluded)); assert.ok(refs.includes(sibling)); assert.ok(refs.includes(early)); }
    assert.equal((await search({ excludeFolder: DIR })).hits.length, 0);
    const ranked = await search({ match: "ranked", excludeFolder: DIR }); assert.equal(ranked.hits.length, 0);
    assert.equal((await request("GET", `/api/search?${new URLSearchParams({ q: RUN, excludeFolder: "/a/../b" })}`)).status, 400);
  });
  await test("Actual fuzzy fallback cannot bypass canonical size/date/exclusion predicates", { "SR-20": "partial", "SR-21": "partial", "SR-22": "partial" }, async () => {
    const title = `${RUN.replaceAll("-", "")}compass`, note = (await batch([{ title, body: "short" }]))[0]; await pool.query("update notes set updated_at='2020-01-01T00:00:00Z' where id=$1", [note.id]);
    const query = title.slice(0, -2) + "xs", params = { q: query, source: "note", scope: "", match: "ranked", modifiedBefore: "2021-01-01" };
    const good = await search(params); assert.ok(good.hits.some((hit: any) => hit.ref === String(note.id) && hit.how.startsWith("fuzzy")));
    assert.equal((await search({ ...params, minBytes: "999999" })).hits.length, 0); assert.equal((await search({ ...params, modifiedAfter: "2020-01-02" })).hits.length, 0);
  });
  await test("Literal public pages have deterministic disjoint fixed-index coverage, cap 200 and reject invalid offsets", { "SR-25": "partial" }, async () => {
    const created: any[] = [];
    for (let i = 0; i < 225; i += 32) created.push(...await batch(Array.from({ length: Math.min(32, 225 - i) }, (_, j) => ({ title: `${RUN} page ${String(i + j).padStart(3, "0")}`, body: `${RUN} pagination` }))));
    const seen: string[] = [];
    for (const offset of [0, 50, 100, 150]) { const result = await search({ q: `${RUN} pagination`, source: "note", scope: "", offset: String(offset), publicPages: "1" }); assert.equal(result.hits.length, 50); seen.push(...result.hits.map((hit: any) => hit.ref)); assert.equal(result.nextOffset, offset < 150 ? offset + 50 : null); assert.equal(result.capped, offset === 150); }
    assert.equal(new Set(seen).size, 200); assert.deepEqual(seen, created.slice(0, 200).map(row => String(row.id)));
    for (const params of [{ offset: "200", match: "literal" }, { offset: "50", match: "ranked" }, { offset: "-1", match: "literal" }]) assert.equal((await request("GET", `/api/search?${new URLSearchParams({ q: RUN, ...params })}`)).status, 400);
  });
  await test("Preview reads current bounded public text, not stale index snippets; binary/Private/trashed/excluded/missing cases stay safe", { "SR-24": "partial" }, async () => {
    const path = `${DIR}/preview.txt`, body = "🧭".repeat(65536) + "TAIL<script>literal</script>"; await file(path, body);
    let result = await ok("GET", `/api/search/preview?${new URLSearchParams({ source: "file", ref: path })}`); assert.equal(result.body, "🧭".repeat(65536)); assert.equal(result.truncated, true); assert.equal(Number(result.size), Buffer.byteLength(body));
    const note = (await batch([{ title: `${RUN} preview-note`, body: "saved <script>literal</script>" }]))[0]; result = await ok("GET", `/api/search/preview?source=note&ref=${note.id}`); assert.equal(result.body, note.body); assert.equal(result.revision, 1);
    const binary = `${DIR}/binary.bin`; await file(binary, Buffer.from([0, 255, 17, 0]).toString("base64"), "application/octet-stream", "base64"); result = await ok("GET", `/api/search/preview?${new URLSearchParams({ source: "file", ref: binary })}`); assert.equal(result.textual, false); assert.equal(result.body, "");
    assert.equal((await request("GET", "/api/search/preview?source=file&ref=%2FPrivate%2Fsecret.txt")).status, 400); assert.equal((await request("GET", `/api/search/preview?${new URLSearchParams({ source: "file", ref: `${DIR}/missing.txt` })}`)).status, 404);
    await pool.query("update vfs_nodes set trashed=true where path=$1", [path]); assert.equal((await request("GET", `/api/search/preview?${new URLSearchParams({ source: "file", ref: path })}`)).status, 404); await pool.query("update vfs_nodes set trashed=false where path=$1", [path]);
    await pool.query("update settings set value=$1 where key='search.excludes'", [DIR]); assert.equal((await request("GET", `/api/search/preview?${new URLSearchParams({ source: "file", ref: early })}`)).status, 404);
  });
} finally {
  if (savedExclusions.rows.length) await pool.query("update settings set value=$1 where key='search.excludes'", [savedExclusions.rows[0].value]);
  await pool.query("delete from index_docs where (source='note' and ref=any($1::text[])) or (source='file' and (ref=$2 or starts_with(ref,$2||'/')))", [[...ids].map(String), DIR]);
  await pool.query("delete from notes where id=any($1::int[])", [[...ids]]);
  // Only this suite's random owned subtree, including explicit path-owned version cleanup.
  await pool.query("delete from vfs_versions where path=$1 or starts_with(path,$1||'/')", [DIR]);
  await pool.query("delete from vfs_nodes where path=$1 or starts_with(path,$1||'/')", [DIR]);
  await pool.end(); finish();
}
