/** Read-only check that the deployed generated coverage snapshot and live
 * register agree on incomplete rows. Run against the production server used to
 * generate the snapshot; a changed register needs a new snapshot/build. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE;
if (!BASE) throw new Error("BASE for the production server is required");
const { test, finish } = makeHarness("tt131-ledger");
const featuresResponse = await fetch(`${BASE}/api/features`);
const ledgerResponse = await fetch(`${BASE}/api/ledger`);
assert.equal(featuresResponse.status, 200);
assert.equal(ledgerResponse.status, 200);
type Feature = { code: string; status: string; route: string; nuance: string };
type Coverage = { generatedAt: string; totals: { built: { full: number; partial: number; blocked: number; none: number } }; rows: Record<string, { tested: string; tests: string[] }> };
const features = await featuresResponse.json() as { rows: Feature[] };
const ledger = await ledgerResponse.json() as Coverage & { ok: boolean };
const source = JSON.parse(readFileSync("src/data/coverage.json", "utf8")) as Coverage;

await test("the production ledger is the generated snapshot in the checked-out source", {}, () => {
  assert.equal(ledger.ok, true);
  const { ok: _ok, ...snapshot } = ledger;
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(digest(snapshot), digest(source), `the deployed snapshot is stale (${ledger.generatedAt} vs ${source.generatedAt}); rebuild the production server`);
});

await test("the recorded build counts and incomplete coverage caps agree with the live register", {}, () => {
  const status = (name: string) => features.rows.filter((row) => row.status === name).length;
  assert.deepEqual(ledger.totals.built, { full: status("built"), partial: status("partial") + status("probe"), blocked: status("blocked"), none: status("skeleton") });
  for (const row of features.rows) if (["partial", "probe", "skeleton"].includes(row.status)) {
    assert.notEqual(ledger.rows[row.code]?.tested, "full", `${row.code} is incomplete but reported fully tested`);
  }
});

await test("the alarm row is partial and includes the real foreground regression evidence", { "CK-01": "partial" }, () => {
  assert.equal(features.rows.find((row) => row.code === "CK-01")?.status, "partial");
  const alarm = ledger.rows["CK-01"];
  assert.equal(alarm?.tested, "partial");
  assert.ok(alarm.tests.some((name) => name.startsWith("e2e-tt130-alarms: an alarm still fires")), "missing closed-window alarm test");
});

await test("the VFS safe-save row does not claim the native SAF contract", { "FM-18": "partial" }, () => {
  const feature = features.rows.find((row) => row.code === "FM-18");
  assert.equal(feature?.status, "partial");
  assert.match(feature.route, /safeSave/);
  assert.match(feature.nuance, /SAF.*not implemented/i);
  assert.equal(ledger.rows["FM-18"]?.tested, "partial");
  assert.ok(ledger.rows["FM-18"].tests.some((name) => name.startsWith("tt116-safesave:")));
});

await test("saved test results refer only to registered feature codes", {}, () => {
  const codes = new Set(features.rows.map((row) => row.code));
  const unknown: string[] = [];
  for (const filename of readdirSync("docs/test-results").filter((name) => name.endsWith(".json"))) {
    const suite = JSON.parse(readFileSync(`docs/test-results/${filename}`, "utf8")) as { results: { covers: Record<string, string> }[] };
    for (const result of suite.results) for (const code of Object.keys(result.covers)) if (!codes.has(code)) unknown.push(`${filename}: ${code}`);
  }
  assert.deepEqual(unknown, [], `unregistered feature tags: ${unknown.join(", ")}`);
});
finish();
