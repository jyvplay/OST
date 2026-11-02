/** Verify the real completed gate's primary logs against current harness
 * receipts. Nested runner-contract logs stay separate and are NOT counted as
 * app/test execution. No summaries/assertions are substituted or manufactured.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ts from "typescript";

const [mainPath, metricsPath, output] = process.argv.slice(2);
if (!mainPath || !metricsPath || !output) throw new Error("usage: node scripts/review-gate-logs.mjs <main.log> <metrics.json> <receipt.json>");
const main = readFileSync(mainPath, "utf8"), metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
assert.equal(metrics.exitCode, 0, "a failed gate cannot produce a passing audit");
assert.equal(resolve(metrics.log), resolve(mainPath), "measurement must name this exact main log");
assert.ok(main.endsWith("GATE PASSED\n"), "missing actual completed-gate success");
assert.equal(main.includes("\0"), false, "sparse/corrupted main log");
const match = /^Full suite logs: (.+)$/m.exec(main); assert.ok(match, "missing primary invocation log directory");
const root = match[1], source = readFileSync("scripts/run-gate.sh", "utf8");
const pureMatch = /^Full pure suite logs: (.+)$/m.exec(main); assert.ok(pureMatch, "missing isolated pure invocation directory");
const pureRoot = pureMatch[1];
assert.ok(resolve(pureRoot).startsWith(resolve(root) + sep), "pure primary logs must be inside this gate invocation");
const names = key => {
  const value = new RegExp(`^${key}="([^"]+)"$`, "m").exec(source); assert.ok(value, `missing ${key}`); return value[1].split(/\s+/);
};
const runs = [...names("PURE").map(suite => ({ suite, lane: "pure" })), { suite: "tt126-regressions", lane: "serial" }, ...[...names("LANE_A"), ...names("LANE_B")].map(suite => ({ suite, lane: "serial" }))];
// Command filenames are not necessarily harness identities (image-engine →
// image, vector-engine → vector). Read the single literal registration in the
// actual suite source; never guess, accept a stale alternate, or rename receipts.
const receiptIdentity = suite => {
  const path = `scripts/${suite}.mts`, text = readFileSync(path, "utf8"), tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), found = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "makeHarness") {
      assert.equal(node.arguments.length, 1, `ambiguous harness registration: ${suite}`);
      assert.ok(ts.isStringLiteral(node.arguments[0]), `nonliteral harness identity: ${suite}`); found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.equal(found.length, 1, `exactly one harness identity is required: ${suite}`); return found[0];
};
const records = runs.map(run => {
  const path = join(run.lane === "pure" ? pureRoot : root, `${run.suite}.log`), bytes = readFileSync(path), log = bytes.toString("utf8");
  assert.equal(log.includes("\0"), false, `sparse/corrupted suite log: ${path}`);
  const receiptSuite = receiptIdentity(run.suite), snapshotPath = join(root, "receipts", `${receiptSuite}.json`), receiptPath = existsSync(snapshotPath) ? snapshotPath : `docs/test-results/${receiptSuite}.json`, receiptBytes = readFileSync(receiptPath), saved = JSON.parse(receiptBytes.toString("utf8"));
  assert.equal(saved.suite, receiptSuite); assert.ok(saved.results.length > 0, `empty harness result: ${run.suite}`);
  assert.ok(Date.parse(saved.at) >= Date.parse(metrics.startedAt) && Date.parse(saved.at) <= Date.parse(metrics.finishedAt), `historical result instead of this gate: ${run.suite}`);
  for (const test of saved.results) {
    assert.equal(test.suite, receiptSuite, `mixed receipt identities: ${run.suite}`);
    assert.equal(test.pass, true, `${run.suite}: ${test.name}`);
    assert.ok(log.includes(`✓ ${test.name}`), `full passing-case diagnostics absent or overwritten: ${run.suite}: ${test.name}`);
  }
  const summaries = [...log.matchAll(/^(\d+) passed, (\d+) failed$/gm)]; assert.ok(summaries.length, `no real summary: ${path}`);
  const last = summaries.at(-1); assert.equal(Number(last[1]), saved.results.length, `summary/cases differ: ${path}`); assert.equal(Number(last[2]), 0);
  // Freeze validated original receipts, so a later legitimate focused rerun
  // cannot destroy the ability to audit this completed invocation again.
  if (!existsSync(snapshotPath)) { mkdirSync(join(root, "receipts"), { recursive: true }); writeFileSync(snapshotPath, receiptBytes, { flag: "wx" }); }
  return { ...run, receiptSuite, receiptPath: snapshotPath, receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"), path, passed: saved.results.length, failed: 0, fullCaseLinesRetained: true, currentReceiptAt: saved.at, logSha256: createHash("sha256").update(bytes).digest("hex") };
});
const receipt = {
  at: new Date().toISOString(), scope: "Actual completed primary gate invocations/case executions; duplicates count as executions, not distinct suites. Controlled kernel/runner-boundary tests are not relabelled native application proof.",
  mainPath, metricsPath, auditorSha256: createHash("sha256").update(readFileSync("scripts/review-gate-logs.mjs")).digest("hex"), runGateSha256: createHash("sha256").update(source).digest("hex"), primaryLogDirectory: root, primaryPureLogDirectory: pureRoot,
  suiteInvocations: records.length, distinctSuites: new Set(records.map(record => record.suite)).size,
  passedCaseExecutions: records.reduce((sum, record) => sum + record.passed, 0), failedCaseExecutions: 0,
  mainLogHasNoSparseHoles: true, everyCurrentSavedCaseHasActualFullLogLine: true, records,
};
writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ suiteInvocations: receipt.suiteInvocations, distinctSuites: receipt.distinctSuites, passedCaseExecutions: receipt.passedCaseExecutions, failedCaseExecutions: 0, primaryLogDirectory: root }, null, 2));
