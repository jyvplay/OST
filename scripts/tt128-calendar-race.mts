/** Real PostgreSQL + HTTP concurrent ICS imports. A trigger/advisory lock holds
 * the first INSERT so the second request meets the actual transaction window.
 * Run only on an exclusive, explicitly disposable server and database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE, token = randomBytes(10).toString("hex"), uid = `tt128-${token}@example.test`, probe = `tt128-probe-${token}@example.test`, fn = `tt128_ics_${token}`;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL }), db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await lock.connect(); await db.connect();
const { test, finish } = makeHarness("tt128-calendar-race");
const pending: { promise: Promise<Response>; controller: AbortController }[] = [];
let own = false, held = false, functionCreated = false, triggerCreated = false, safe = true;
const calendar = (id: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", `UID:${id}`, "SUMMARY:Concurrent import", "DUE:20261101T103000Z", "RRULE:FREQ=DAILY;COUNT=3", "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
const importIcs = (ics: string) => {
  const controller = new AbortController(), promise = fetch(`${BASE}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ics }), signal: controller.signal });
  void promise.catch(() => undefined); pending.push({ promise, controller }); return promise;
};
const waitFor = async (fragment: string) => {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const r = await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1", [`%${fragment}%`]);
    if (r.rowCount) return; await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`No PostgreSQL waiter observed for ${fragment}`);
};
const waitForTwoTransactions = async () => {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const r = await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query ILIKE '%insert into \"tasks\"%' OR query ILIKE '%hashtextextended%')");
    if (r.rows[0].n >= 2) return; await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Two import transactions did not both reach the forced lock window");
};
const settle = async () => {
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 35_000); });
  const all = await Promise.race([Promise.allSettled(pending.map((p) => p.promise)), timeout]); if (timer) clearTimeout(timer);
  if (!all || all.some((r) => r.status === "rejected")) { for (const p of pending) p.controller.abort(); pending.length = 0; return false; }
  pending.length = 0; return true;
};
try {
  assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=ANY($1)", [[uid, probe]])).rowCount, 0, "fixture UIDs already present");
  const warm = await importIcs(calendar(probe)); assert.equal(warm.status, 200);
  assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=$1", [probe])).rowCount, 1, "HTTP server and database must match"); own = true;
  await test("concurrent matching UIDs serialize the check and insert", { "PR-04": "partial", "PL-02": "partial" }, async () => {
    // A trigger is fault injection; it only pauses our random UID's actual INSERT.
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid='${uid}' THEN PERFORM pg_advisory_xact_lock(128019,128020); END IF; RETURN NEW; END $$`); functionCreated = true;
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION ${fn}()`); triggerCreated = true;
    await lock.query("SELECT pg_advisory_lock(128019,128020)"); held = true;
    const first = importIcs(calendar(uid)); await waitFor('insert into "tasks"');
    const second = importIcs(calendar(uid)); await waitForTwoTransactions();
    await lock.query("SELECT pg_advisory_unlock(128019,128020)"); held = false;
    const [a, b] = await Promise.all([first, second]); assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.deepEqual(await a.json(), { ok: true, parsed: 1, added: 1, skipped: 0 });
    assert.deepEqual(await b.json(), { ok: true, parsed: 1, added: 0, skipped: 1 });
    assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=$1", [uid])).rowCount, 1);
    const exported = await fetch(`${BASE}/api/tasks?format=ics`); assert.equal(exported.status, 200);
    const text = await exported.text(), component = text.split("BEGIN:VTODO").find((part) => part.includes(`UID:${uid}`));
    assert.ok(component); assert.match(component!, /DTSTART:20261101T103000Z\r\nDUE:20261101T103000Z\r\nRRULE:FREQ=DAILY;COUNT=3/);
  });
} finally {
  if (held) await lock.query("SELECT pg_advisory_unlock(128019,128020)").catch(() => { safe = false; });
  safe = (await settle()) && safe;
  if (triggerCreated) await db.query(`DROP TRIGGER IF EXISTS ${fn} ON tasks`);
  if (functionCreated) await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  if (own && safe) await db.query("DELETE FROM tasks WHERE uid=ANY($1)", [[uid, probe]]);
  else if (own) { console.error(`Fixtures ${uid} and ${probe} retained; outcome unknown`); process.exitCode = 1; }
  await lock.end(); await db.end(); finish();
}
