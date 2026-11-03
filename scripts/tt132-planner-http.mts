/** Real HTTP + PostgreSQL tests, including a forced row-lock race. No mock DB. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { makeHarness } from "./harness.mts";
import { taskSnapshot, type PlannerTask } from "../src/lib/task-model.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("exclusive disposable server/database required");
const BASE = process.env.BASE, tag = `tt132-${randomUUID()}`, owned = new Set<number>();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }), lock = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect(); await lock.connect();
const { test, finish } = makeHarness("tt132-planner-http"), covers = { "PR-03": "partial", "PR-04": "partial" } as const;
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = { text }; }
  if (method === "POST" && path === "/api/tasks" && data.row?.id && String(data.row.title).startsWith(tag)) owned.add(data.row.id);
  return { status: response.status, data };
}
async function create(extra: Record<string, unknown> = {}): Promise<PlannerTask> {
  const out = await call("POST", "/api/tasks", { title: `${tag}-item`, ...extra });
  assert.equal(out.status, 200, JSON.stringify(out.data)); return out.data.row;
}
async function read(id: number): Promise<PlannerTask> {
  const out = await call("GET", "/api/tasks"); assert.equal(out.status, 200);
  const row = out.data.rows.find((r: PlannerTask) => r.id === id); assert.ok(row); return row;
}
let matched = false, held = false;
const pending: Promise<unknown>[] = [];
try {
  const probe = await create({ title: `${tag}-probe` });
  assert.equal((await db.query("SELECT id FROM tasks WHERE id=$1 AND title=$2", [probe.id, probe.title])).rowCount, 1, "HTTP server and disposable database must match"); matched = true;
  await test("malformed write matrix returns 400 without adding database rows", covers, async () => {
    const before = Number((await db.query("SELECT count(*) AS n FROM tasks")).rows[0].n);
    const invalid = [{ title: " " }, { title: 0 }, { notes: 0 }, { done: "false" }, { reminded: 1 }, { dueAt: "bad" }, { dueAt: "2030-02-30T10:00:00Z" }, { dueAt: "2030-01-01T10:00" }, { kind: "event" }, { kind: "other" }, { endAt: "2030-01-01T10:00:00Z" }, { kind: "event", dueAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T09:00:00Z" }];
    for (const patch of invalid) { const out = await call("POST", "/api/tasks", { title: `${tag}-invalid`, ...patch }); assert.equal(out.status, 400, JSON.stringify(patch)); }
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM tasks")).rows[0].n), before);
  });
  await test("create task with notes and no due time, then verify the real SQL row", covers, async () => {
    const row = await create({ title: ` ${tag}-notes `, notes: "First\nSecond <script>not markup</script>" });
    assert.equal(row.title, `${tag}-notes`); assert.equal(row.dueAt, null);
    const actual = (await db.query("SELECT notes, kind, due_at FROM tasks WHERE id=$1", [row.id])).rows[0];
    assert.equal(actual.notes, "First\nSecond <script>not markup</script>"); assert.equal(actual.kind, "task"); assert.equal(actual.due_at, null);
  });
  await test("create event with explicit offset and millisecond end, exported as real VEVENT", covers, async () => {
    const row = await create({ kind: "event", dueAt: "2030-01-07T07:30:00.123-05:00", endAt: "2030-01-07T08:45:00.456-05:00" });
    assert.equal(row.dueAt, "2030-01-07T12:30:00.123Z"); assert.equal(row.endAt, "2030-01-07T13:45:00.456Z");
    const actual = (await db.query("SELECT due_at, end_at, kind FROM tasks WHERE id=$1", [row.id])).rows[0]; assert.equal(actual.end_at.toISOString(), row.endAt); assert.equal(actual.kind, "event");
    const exported = await fetch(BASE + "/api/tasks?format=ics"); assert.equal(exported.status, 200);
    const event = (await exported.text()).split("BEGIN:VEVENT").find((part) => part.includes(`UID:fusion-${row.id}@fusion.local`));
    assert.ok(event); assert.match(event, /DTSTART:20300107T123000Z/); assert.match(event, /DTEND:20300107T134500Z/);
  });
  await test("guarded rename and note edit preserve UID and dates", covers, async () => {
    const row = await create({ dueAt: "2030-01-01T10:00:00.123Z" });
    const out = await call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(row), title: `${tag}-renamed`, notes: "edited" });
    assert.equal(out.status, 200); const next = await read(row.id);
    assert.equal(next.title, `${tag}-renamed`); assert.equal(next.notes, "edited"); assert.equal(next.dueAt, row.dueAt); assert.equal(next.uid, row.uid);
  });
  await test("reschedule and clear due rearm reminders; an unchanged due instant does not", covers, async () => {
    const row = await create({ dueAt: "2030-01-01T10:00:00Z" });
    assert.equal((await call("PATCH", "/api/tasks", { id: row.id, reminded: true })).status, 200);
    let out = await call("PATCH", "/api/tasks", { id: row.id, dueAt: row.dueAt }); assert.equal(out.status, 200); assert.equal(out.data.row.reminded, true);
    out = await call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(await read(row.id)), dueAt: "2031-01-01T10:00:00Z" }); assert.equal(out.status, 200); assert.equal(out.data.row.reminded, false);
    out = await call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(out.data.row), dueAt: null }); assert.equal(out.status, 200); assert.equal(out.data.row.dueAt, null);
  });
  await test("a delayed reminder acknowledgement cannot mark a newly rescheduled item delivered", covers, async () => {
    const original = await create({ dueAt: "2030-01-01T10:00:00Z" });
    const changed = await call("PATCH", "/api/tasks", { id: original.id, expected: taskSnapshot(original), dueAt: "2031-01-01T10:00:00Z" });
    assert.equal(changed.status, 200);
    const late = await call("PATCH", "/api/tasks", { id: original.id, expected: taskSnapshot(original), reminded: true });
    assert.equal(late.status, 409); const current = await read(original.id);
    assert.equal(current.dueAt, "2031-01-01T10:00:00.000Z"); assert.equal(current.reminded, false);
  });
  await test("event duration edits validate the merged row and roll back invalid partial edits", covers, async () => {
    const row = await create({ kind: "event", dueAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T11:00:00Z" });
    const out = await call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(row), dueAt: "2030-01-01T12:00:00Z", title: "not committed" });
    assert.equal(out.status, 400); assert.deepEqual(taskSnapshot(await read(row.id)), taskSnapshot(row));
    const good = await call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(row), dueAt: "2030-01-01T12:00:00Z", endAt: "2030-01-01T13:00:00Z" });
    assert.equal(good.status, 200); assert.equal(good.data.row.endAt, "2030-01-01T13:00:00.000Z");
  });
  await test("task to event and event to task conversion preserve notes and clear event-only data", covers, async () => {
    const row = await create({ notes: "Keep this", dueAt: "2030-01-01T10:00:00Z" });
    const a = await call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(row), kind: "event", endAt: "2030-01-01T11:00:00Z" }); assert.equal(a.status, 200);
    const b = await call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(a.data.row), kind: "task", done: true }); assert.equal(b.status, 200);
    assert.equal(b.data.row.notes, "Keep this"); assert.equal(b.data.row.endAt, null); assert.equal(b.data.row.done, true);
  });
  await test("two forced concurrent edits of one baseline commit once and return one real 409", covers, async () => {
    const row = await create();
    await lock.query("BEGIN"); await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [row.id]); held = true;
    const a = call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(row), title: `${tag}-winner-a` });
    const b = call("PATCH", "/api/tasks", { id: row.id, expected: taskSnapshot(row), title: `${tag}-winner-b` }); pending.push(a, b);
    const until = Date.now() + 15_000; let waiters = 0;
    while (Date.now() < until) {
      waiters = Number((await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%from \"tasks\"%for update%'")).rows[0].n);
      if (waiters >= 2) break; await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(waiters >= 2, "both HTTP transactions reached the actual row-lock wait");
    await lock.query("COMMIT"); held = false;
    const results = await Promise.all([a, b]); assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const final = await read(row.id); assert.equal(final.title, results.find((r) => r.status === 200)!.data.row.title);
  });
  await test("a stale delete cannot destroy a changed item; a current delete removes it", covers, async () => {
    const row = await create();
    const changed = await call("PATCH", "/api/tasks", { id: row.id, notes: "New note" }); assert.equal(changed.status, 200);
    const stale = await call("DELETE", `/api/tasks?id=${row.id}`, { expected: taskSnapshot(row) }); assert.equal(stale.status, 409);
    assert.equal((await read(row.id)).notes, "New note");
    const current = await call("DELETE", `/api/tasks?id=${row.id}`, { expected: taskSnapshot(changed.data.row) }); assert.equal(current.status, 200); owned.delete(row.id);
    assert.equal((await db.query("SELECT id FROM tasks WHERE id=$1", [row.id])).rowCount, 0);
  });
  await test("empty patches, malformed IDs and deleted items have explicit 400/404 responses", covers, async () => {
    assert.equal((await call("PATCH", "/api/tasks", { id: probe.id })).status, 400);
    for (const id of [0, -1, 1.2, "1", null]) assert.equal((await call("PATCH", "/api/tasks", { id, done: true })).status, 400);
    for (const id of ["", "0", "1.5", "-1", "NaN", "2147483648"]) assert.equal((await call("DELETE", `/api/tasks?id=${id}`)).status, 400);
    assert.equal((await call("PATCH", "/api/tasks", { id: 2_147_483_647, done: true })).status, 404);
    assert.equal((await call("DELETE", "/api/tasks?id=2147483647")).status, 404);
  });
} finally {
  if (held) await lock.query("ROLLBACK");
  await Promise.allSettled(pending);
  if (matched && owned.size) await db.query("DELETE FROM tasks WHERE id=ANY($1)", [[...owned]]);
  await lock.end(); await db.end(); finish();
}
