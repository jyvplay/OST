/** Adversarial checks for destructive-test refusal. ONLY run on a disposable database and server. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing safety tests without TT89_DISPOSABLE_DATABASE=1 for a disposable database and server.");
const { test, finish } = makeHarness("tt89-test-safety");
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const suffix = randomBytes(8).toString("hex");
const nodePath = `/Private/tt89-safety-trashed-${suffix}`;
const versionPath = `/Private/tt89-safety-version-${suffix}`;
const destructivePrivacyScripts = ["e2e-privacy.mts", "privacy-backup.mts", "e2e-tt90-private-thumbnails.mts"];
const initial = await db.query(`SELECT EXISTS (SELECT 1 FROM vfs_nodes WHERE path LIKE '/Private/%') AS nodes,
  EXISTS (SELECT 1 FROM vfs_versions WHERE path = '/Private' OR path LIKE '/Private/%') AS versions`);
if (initial.rows[0].nodes || initial.rows[0].versions) { await db.end(); throw new Error("Safety tests require an empty /Private to establish that each sentinel causes refusal."); }
const run = (script: string, opt: boolean) => {
  const env = { ...process.env, TT89_DISPOSABLE_DATABASE: opt ? "1" : "0" };
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", `scripts/${script}`], { env, encoding: "utf8", timeout: 25_000 });
};
try {
  await test("destructive privacy and role-permission suites refuse to run without explicit disposable opt-in", {}, () => {
    for (const script of [...destructivePrivacyScripts, "tt87-backup-http.mts", "tt89-drill-db.mts", "tt91-thumbnail-cleanup-race.mts", "tt91-purge.mts", "tt91-purge-race.mts", "tt91-write-atomic.mts", "e2e-tt91-purge.mts", "e2e-tt91-browser-download.mts", "tt92-trash.mts", "tt92-trash-race.mts", "e2e-tt92-trash.mts", "tt92-privacy-perf.mts", "e2e-tt54.mts", "tt93-transfer.mts", "tt93-transfer-race.mts", "tt93-restore-race.mts", "tt93-metadata-race.mts", "e2e-tt93-sidecar.mts", "e2e-tt93-photos-clear.mts", "tt94-photo-guard.mts", "tt94-photo-guard-race.mts", "e2e-tt94-photo-stale.mts", "e2e-tt94-photos-offline.mts", "e2e-tt94-offline-race.mts", "tt95-photo-concurrency.mts", "tt95-photo-race.mts", "e2e-tt95-photo-concurrency.mts", "tt95-calculator-audit.mts"]) {
      const r = run(script, false); assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing/);
    }
  });
  await test("forced schema bootstraps refuse without an explicit disposable opt-in and database URL", {}, () => {
    for (const script of ["scripts/sandbox/bootstrap.sh", "scripts/sandbox/rebuild-all.sh", "scripts/tt94-production-gate.sh", "scripts/tt95-production-gate.sh"]) {
      for (const env of [{ ...process.env, TT89_DISPOSABLE_DATABASE: "0" }, { ...process.env, TT89_DISPOSABLE_DATABASE: "1", DATABASE_URL: "" }]) {
        const r = spawnSync("bash", [script], { env, encoding: "utf8", timeout: 10_000 });
        assert.equal(r.status, 2, script); assert.match(r.stderr, /Refusing/i, script);
      }
    }
  });
  await test("a trashed private child without keyslots blocks the destructive privacy suite and remains untouched", {}, async () => {
    await db.query("INSERT INTO vfs_nodes (path,parent,name,kind,content,trashed) VALUES ($1,'/Private',$2,'file','sentinel',true)", [nodePath, `tt89-safety-${suffix}`]);
    try {
      for (const script of destructivePrivacyScripts) {
        const r = run(script, true); assert.notEqual(r.status, 0, script); assert.match(r.stderr, /Existing \/Private data or versions/, script);
        const row = await db.query("SELECT content,trashed FROM vfs_nodes WHERE path=$1", [nodePath]);
        assert.deepEqual(row.rows, [{ content: "sentinel", trashed: true }], script);
      }
    } finally { await db.query("DELETE FROM vfs_nodes WHERE path=$1", [nodePath]); }
  });
  await test("an orphaned private version without a node blocks the suite and remains untouched", {}, async () => {
    await db.query("INSERT INTO vfs_versions (path,version,content) VALUES ($1,1,'orphan-sentinel')", [versionPath]);
    try {
      for (const script of destructivePrivacyScripts) {
        const r = run(script, true); assert.notEqual(r.status, 0, script); assert.match(r.stderr, /Existing \/Private data or versions/, script);
        const row = await db.query("SELECT content FROM vfs_versions WHERE path=$1", [versionPath]);
        assert.deepEqual(row.rows, [{ content: "orphan-sentinel" }], script);
      }
    } finally { await db.query("DELETE FROM vfs_versions WHERE path=$1", [versionPath]); }
  });
} finally { await db.end(); }
finish();
