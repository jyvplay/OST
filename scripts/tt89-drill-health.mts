import assert from "node:assert/strict";
import { drillHealthState, nextDrillDate, parseDrillHealth, recordDrill, type DrillAttempt } from "../src/lib/backup/drill-health.ts";
import { BACKUP_VERSION, type BackupPayload } from "../src/lib/backup/bundle.ts";
import { DRILL_LIMITS, sampleBackup } from "../src/lib/server/backup-drill.ts";
import { pool } from "../src/db/index.ts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("tt89-drill-health");
const partial = { "BK-05": "partial" } as const;
const attempt = (at: string, outcome: DrillAttempt["outcome"]): DrillAttempt => ({ at, outcome, kind: "data", files: 1, folders: 0, notes: 1, settings: 0 });

await test("calendar months clamp correctly including leap years and year boundaries", partial, () => {
  assert.equal(nextDrillDate("2024-01-31T10:11:12.345Z"), "2024-02-29T10:11:12.345Z");
  assert.equal(nextDrillDate("2025-01-31T10:11:12.345Z"), "2025-02-28T10:11:12.345Z");
  assert.equal(nextDrillDate("2026-12-31T23:00:00.000Z"), "2027-01-31T23:00:00.000Z");
  assert.throws(() => nextDrillDate("2025-02-30T00:00:00.000Z"));
  assert.throws(() => nextDrillDate("0099-01-01T00:00:00.000Z"));
});
await test("monthly reminder changes on the exact due instant and never pretends an empty status is healthy", partial, () => {
  const h = recordDrill(null, attempt("2026-01-31T12:00:00.000Z", "passed"));
  assert.equal(drillHealthState(null, Date.now()).state, "never");
  assert.deepEqual(drillHealthState(h, Date.parse("2026-02-28T11:59:59.999Z")), { state: "passed", dueAt: "2026-02-28T12:00:00.000Z" });
  assert.equal(drillHealthState(h, Date.parse("2026-02-28T12:00:00.000Z")).state, "due");
});
await test("failed and partial attempts override earlier success without erasing its due date", partial, () => {
  let h = recordDrill(null, attempt("2026-01-10T00:00:00.000Z", "passed"));
  h = recordDrill(h, attempt("2026-01-20T00:00:00.000Z", "failed"));
  assert.deepEqual(drillHealthState(h, Date.parse("2026-01-21T00:00:00.000Z")), { state: "failed", dueAt: "2026-02-10T00:00:00.000Z" });
  h = recordDrill(h, attempt("2026-01-22T00:00:00.000Z", "partial"));
  assert.equal(h.lastSuccess, "2026-01-10T00:00:00.000Z");
  assert.equal(drillHealthState(h, Date.parse("2026-01-23T00:00:00.000Z")).state, "partial");
  h = recordDrill(h, attempt("2026-01-24T00:00:00.000Z", "passed"));
  assert.equal(h.lastSuccess, "2026-01-24T00:00:00.000Z");
});
await test("backwards clock, inconsistent success and invalid current time are not labelled passed", partial, () => {
  const h = recordDrill(null, attempt("2026-01-10T12:00:00.000Z", "passed"));
  assert.equal(drillHealthState(h, Date.parse("2026-01-10T11:54:59.000Z")).state, "clock");
  assert.equal(drillHealthState({ ...h, lastSuccess: null }, Date.parse("2026-01-11T00:00:00.000Z")).state, "clock");
  assert.equal(drillHealthState(h, NaN).state, "clock");
});
await test("malformed, unbounded, nonsensical and future-version local records are rejected", partial, () => {
  const valid = recordDrill(null, attempt("2026-01-10T00:00:00.000Z", "passed"));
  for (const raw of [null, "", "{", "[]", JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, lastSuccess: "tomorrow" }),
    JSON.stringify({ ...valid, lastAttempt: { ...valid.lastAttempt, at: "2025-02-30T00:00:00.000Z" } }),
    JSON.stringify({ ...valid, lastAttempt: { ...valid.lastAttempt, files: -1 } }),
    JSON.stringify({ ...valid, lastAttempt: { ...valid.lastAttempt, notes: 10001 } }),
    JSON.stringify({ ...valid, lastAttempt: { ...valid.lastAttempt, outcome: "healthy" } }),
    JSON.stringify({ ...valid, lastAttempt: { ...valid.lastAttempt, kind: "backup.json" } })]) assert.equal(parseDrillHealth(raw), null);
});
await test("status serialization retains only dates, fixed outcome, kind and bounded counts", partial, () => {
  const valid = recordDrill(null, attempt("2026-01-10T00:00:00.000Z", "passed"));
  const input = { ...valid, secret: "top-level-secret", lastAttempt: { ...valid.lastAttempt, fileName: "private-name", body: "private-body" } };
  const read = parseDrillHealth(JSON.stringify(input));
  assert.deepEqual(read, valid);
  assert.doesNotMatch(JSON.stringify(read), /secret|private-name|private-body/);
});
await test("deterministic stratified sample is bounded, distinct, reproducible and not fixed to the first records", partial, () => {
  const payload: BackupPayload = { version: BACKUP_VERSION, exportedAt: "2026-01-01T00:00:00.000Z", kind: "data", settings: [], notes: [], entries: [] };
  for (let i = 0; i < 100; i++) {
    payload.entries.push({ path: `/test/f${i}`, kind: "file", mime: "text/plain", encoding: "utf8", content: String(i), size: String(i).length, sha256: "a".repeat(64), tags: "" });
    payload.entries.push({ path: `/test/d${i}`, kind: "dir", mime: "inode/directory", encoding: "utf8", content: "", size: 0, sha256: "b".repeat(64), tags: "" });
    payload.notes.push({ title: String(i), body: "", tags: "", pinned: false, createdAt: payload.exportedAt, updatedAt: payload.exportedAt });
    payload.settings.push({ key: `key${i}`, value: "v" });
  }
  const a = sampleBackup(payload, "a".repeat(64)), again = sampleBackup(payload, "a".repeat(64)), b = sampleBackup(payload, "b".repeat(64));
  assert.deepEqual(a, again); assert.notDeepEqual(a.entries, b.entries);
  assert.equal(a.entries.filter((e) => e.kind === "file").length, DRILL_LIMITS.files);
  assert.equal(a.entries.filter((e) => e.kind === "dir").length, DRILL_LIMITS.folders);
  assert.equal(a.notes.length, DRILL_LIMITS.notes); assert.equal(a.settings.length, DRILL_LIMITS.settings);
  assert.equal(new Set(a.entries.map((e) => e.path)).size, a.entries.length);
  assert.ok(a.entries.some((e) => Number(e.path.slice(e.path.lastIndexOf("f") + 1)) > DRILL_LIMITS.files));
  assert.equal(payload.entries.length, 200);
});
await pool.end();
finish();
