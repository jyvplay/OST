/** Real PostgreSQL cold-upgrade drill. Creates and drops ONLY a uniquely named
 * owned database. Runs the shipped SQL verbatim, with a real conflicting lock.
 * No app/API/clock/storage substitution. This is DB integration, not browser E2E.
 * Also records an explicit external-ID-reuse ABA boundary, NOT a passing safety claim.
 */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { makeHarness } from "./harness.mts";
assert.equal(process.env.TT89_DISPOSABLE_DATABASE, "1", "requires an explicitly disposable database server");
assert.ok(process.env.DATABASE_URL, "DATABASE_URL required");
const { test, finish } = makeHarness("tt134-note-migration");
const name = `tt134_note_upgrade_${randomBytes(8).toString("hex")}`;
assert.match(name, /^tt134_note_upgrade_[a-f0-9]{16}$/);
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
const migration = readFileSync(new URL("../src/db/migrations/tt133-note-revisions.sql", import.meta.url), "utf8");
const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
const driverErrors: { code?: string; name: string }[] = [];
pool.on("error", error => driverErrors.push({ code: (error as { code?: string }).code, name: error.name }));
let made = false;
const evidence: Record<string, unknown> = { scope: "actual PG cold migration + explicit ID-reuse counterexample; not app/native browser acceptance", migrationSha256: createHash("sha256").update(migration).digest("hex"), database: name };
const originals = () => pool.query("SELECT id,title,body,tags,pinned,created_at,updated_at FROM public.notes ORDER BY id").then(r => r.rows);
const absent = () => pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='notes' AND column_name='revision'").then(r => r.rows[0].n === 0);
const canary = () => pool.query("SELECT * FROM public.upgrade_canary ORDER BY key").then(r => r.rows);
try {
  await admin.connect(); await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.utf8' LC_CTYPE 'C.utf8'`); made = true;
  await pool.query(`CREATE TABLE public.notes (
    id serial PRIMARY KEY, title text NOT NULL DEFAULT 'Untitled', body text NOT NULL DEFAULT '',
    tags text NOT NULL DEFAULT '', pinned boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.upgrade_canary (key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO public.upgrade_canary VALUES ('seed-marker','"already-seeded"'),('unrelated','{"nested":[1,2,3]}');
    INSERT INTO public.notes(title,body,tags,pinned,created_at,updated_at) VALUES
      ('Older μ 🧭','exact\r\noriginal body','one,two',true,'2020-01-02T03:04:05Z','2021-02-03T04:05:06Z'),
      ('Untouched','','',false,'2022-01-01T00:00:00Z','2023-01-01T00:00:00Z');`);
  const before = await originals(), beforeCanary = await canary();
  evidence.postgres = (await pool.query("SELECT version() v")).rows[0].v;
  await test("Cold pre-TT133 notes really lack revision; owned original rows and unrelated canaries exist", {}, async () => { assert.equal(await absent(), true); assert.equal(before.length, 2); assert.equal(beforeCanary.length, 2); assert.equal(before[0].body, "exact\r\noriginal body"); });
  await test("Genuine SHARE lock makes the shipped ALTER fail near its four-second lock timeout, with no partial schema or user-data mutation", { "NT-10": "partial" }, async () => {
    const holder = await pool.connect(), worker = await pool.connect(); let locked = false;
    try {
      await holder.query("BEGIN"); locked = true; await holder.query("LOCK TABLE public.notes IN SHARE MODE");
      const start = performance.now(), pending = worker.query(migration).then(() => null, error => error);
      let seen = false;
      while (performance.now() - start < 3000) {
        const active = await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%ALTER TABLE public.notes%'");
        if (active.rows[0].n > 0) { seen = true; break; }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      const error = await pending, elapsed = performance.now() - start; await worker.query("ROLLBACK");
      assert.equal(seen, true); assert.equal(error?.code, "55P03"); assert.ok(elapsed >= 3800 && elapsed < 12_000, `lock timeout ${elapsed}ms`);
      assert.equal(await absent(), true); assert.deepEqual(await originals(), before); assert.deepEqual(await canary(), beforeCanary);
      evidence.realLockTimeoutMs = elapsed;
    } finally { if (locked) await holder.query("ROLLBACK"); holder.release(); worker.release(); }
  });
  await test("Unblocked shipped migration initializes every legacy revision to one while preserving all IDs, Unicode, CRLF, tags, pins, timestamps and unrelated data", { "NT-10": "partial" }, async () => {
    await pool.query(migration); assert.deepEqual(await originals(), before); assert.deepEqual(await canary(), beforeCanary);
    const rows = (await pool.query("SELECT revision FROM public.notes ORDER BY id")).rows; assert.deepEqual(rows.map(r => r.revision), [1, 1]);
    const column = (await pool.query("SELECT is_nullable,data_type,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='notes' AND column_name='revision'")).rows[0];
    assert.equal(column.is_nullable, "NO"); assert.equal(column.data_type, "integer"); assert.equal(column.column_default, "1");
  });
  await test("Migrated SQL CAS advances only its matching original row; a stale precondition changes nothing", { "NT-10": "partial" }, async () => {
    const id = before[0].id;
    const accepted = await pool.query("UPDATE public.notes SET body='post-upgrade',revision=revision+1 WHERE id=$1 AND revision=1 RETURNING revision", [id]); assert.equal(accepted.rows[0].revision, 2);
    const refused = await pool.query("UPDATE public.notes SET body='stale loser',revision=revision+1 WHERE id=$1 AND revision=1 RETURNING id", [id]); assert.equal(refused.rowCount, 0);
    assert.equal((await pool.query("SELECT body FROM public.notes WHERE id=$1", [id])).rows[0].body, "post-upgrade");
  });
  await test("Reapplying the same SQL does not reset advanced revisions, and a genuinely new row gets default revision one", { "NT-10": "partial" }, async () => {
    const current = (await pool.query("SELECT * FROM public.notes ORDER BY id")).rows;
    await pool.query(migration); assert.deepEqual((await pool.query("SELECT * FROM public.notes ORDER BY id")).rows, current);
    const inserted = (await pool.query("INSERT INTO public.notes(title) VALUES ('new after upgrade') RETURNING revision")).rows[0]; assert.equal(inserted.revision, 1);
    assert.deepEqual(await canary(), beforeCanary);
  });
  await test("Boundary witness, NOT acceptance: external delete/recreate of the same row ID resets revision and defeats a stale revision-one precondition", {}, async () => {
    const id = before[1].id; await pool.query("DELETE FROM public.notes WHERE id=$1", [id]);
    await pool.query("INSERT INTO public.notes(id,title,body) VALUES ($1,'externally restored identity','new incarnation')", [id]);
    const accepted = await pool.query("UPDATE public.notes SET body='stale incarnation writer',revision=revision+1 WHERE id=$1 AND revision=1 RETURNING id", [id]);
    assert.equal(accepted.rowCount, 1); evidence.externalIdReuseABAWitnessed = true; evidence.crossIncarnationSafetyAccepted = false;
  });
} finally {
  await pool.end();
  if (made) {
    // A driver's end() can resolve before PG observes the socket close. Do
    // not FORCE-kill a closing idle client and turn cleanup into a fatal event.
    const deadline = performance.now() + 5000;
    while (Number((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1", [name])).rows[0].n) > 0) {
      assert.ok(performance.now() < deadline, "owned connections did not drain");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await admin.query(`DROP DATABASE "${name}"`);
  }
  await test("No background driver errors, and owned connections drain before non-forced cleanup", {}, () => assert.deepEqual(driverErrors, []));
  await admin.end(); mkdirSync("docs/evidence", { recursive: true }); writeFileSync("docs/evidence/tt134-note-migration.json", JSON.stringify(evidence, null, 2) + "\n"); finish();
}
