/** Artifact-tampering tests of the real auditor against a real completed gate.
 * Copied/mutated evidence is explicitly NOT additional application execution. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const mainPath = process.argv[2] ?? "docs/evidence/tt135-carryover-final-gate.log", metricsPath = process.argv[3] ?? "docs/evidence/tt135-carryover-final-gate-metrics.json";
const original = readFileSync(mainPath, "utf8"), metrics = JSON.parse(readFileSync(metricsPath, "utf8")), root = /^Full suite logs: (.+)$/m.exec(original)?.[1];
assert.ok(root); mkdirSync(".cache", { recursive: true }); const temp = mkdtempSync(".cache/tt135-audit-attack-"), results = [];
try {
  for (const kind of ["intact-copy", "failed-command", "missing-case-line", "sparse-suite", "foreign-pure-root", "historical-receipt-window", "wrong-measurement-log", "corrupt-frozen-receipt"]) {
    const dir = join(temp, kind), primary = join(dir, "primary"), main = join(dir, "main.log"), measured = join(dir, "metrics.json"), output = join(dir, "audit.json");
    cpSync(root, primary, { recursive: true }); let text = original.replaceAll(root, primary); const receipt = { ...metrics, log: main };
    const image = join(primary, /^Full pure suite logs: (.+)$/m.exec(original)[1].slice(root.length + 1), "image-engine.log");
    if (kind === "corrupt-frozen-receipt") { const path = join(primary, "receipts/image.json"), saved = JSON.parse(readFileSync(path, "utf8")); saved.results[0].pass = false; writeFileSync(path, JSON.stringify(saved)); }
    if (kind === "failed-command") receipt.exitCode = 1;
    if (kind === "wrong-measurement-log") receipt.log = mainPath;
    if (kind === "missing-case-line") writeFileSync(image, readFileSync(image, "utf8").replace("✓ ", "REMOVED "));
    if (kind === "sparse-suite") writeFileSync(image, readFileSync(image, "utf8") + "\0");
    if (kind === "foreign-pure-root") text = text.replace(/^Full pure suite logs: .+$/m, `Full pure suite logs: ${temp}/foreign`);
    if (kind === "historical-receipt-window") receipt.startedAt = metrics.finishedAt;
    writeFileSync(main, text); writeFileSync(measured, JSON.stringify(receipt));
    const run = spawnSync(process.execPath, ["scripts/review-gate-logs.mjs", main, measured, output], { encoding: "utf8", timeout: 30_000 }); assert.equal(run.signal, null); const expected = kind === "intact-copy" ? 0 : 1; assert.equal(run.status, expected, `${kind}: ${run.stderr}`);
    if (!expected) { const audit = JSON.parse(readFileSync(output, "utf8")); assert.equal(audit.records.find(r => r.suite === "image-engine").receiptSuite, "image"); assert.equal(audit.records.find(r => r.suite === "vector-engine").receiptSuite, "vector"); }
    results.push({ kind, exitCode: run.status, expectedExitCode: expected, pass: true }); console.log(`  ✓ ${kind}`);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
const output = process.argv[4] ?? "docs/evidence/tt135-gate-audit-attacks.json";
writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), scope: "Real auditor on intact and deliberately corrupted copies of actual gate artifacts. Not native application execution or a synthetic gate success.", mainPath, metricsPath, results }, null, 2) + "\n");
console.log(`\n${results.length} passed, 0 failed`);
