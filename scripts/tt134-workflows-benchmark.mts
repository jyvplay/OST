/** Reproducible, explicitly bounded two-CPU measurements. No fake HTTP/DB,
 * clocks or skipped field/index checks. Keep all other verification serial.
 * Pareto vector: wall + CPU, subject to exact declared successful-setup fidelity.
 * This does not establish peak-memory or universal-workload Pareto dominance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { sourceTextRange, type TextRange } from "../src/lib/text-selection.ts";

const BASE = process.env.BASE, DATABASE_URL = process.env.DATABASE_URL;
if (!BASE || !DATABASE_URL || process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Exclusive disposable BASE/DATABASE_URL required");
assert.equal(availableParallelism(), 2, "This receipt is specifically for the available two-CPU sandbox");
const RUN = `tt134-perf-${Date.now().toString(36)}`, pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 }), owned = new Set<number>();
const cpuTotal = () => {
  const text = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"), match = /^usage_usec (\d+)$/m.exec(text);
  if (!match) throw new Error("Whole-sandbox cgroup CPU counter unavailable; do not substitute client CPU");
  return Number(match[1]) * 1000;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const inputs = Array.from({ length: 32 }, (_, i) => ({ title: `${RUN} ${String(i).padStart(2, "0")}`, body: `Unicode μ 🧭 ${i}\r\n` + "exact text ".repeat(100), tags: "benchmark,fixture", pinned: i % 3 === 0 }));
async function post(path: string, body: unknown): Promise<any> {
  const response = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
async function clear() {
  const ids = [...owned];
  await pool.query("delete from index_docs where source='note' and ref=any($1::text[])", [ids.map(String)]);
  await pool.query("delete from notes where id=any($1::int[])", [ids]); owned.clear();
}
async function setup(kind: "serial" | "batch", warmup = false) {
  const cpu = cpuTotal(), client = process.cpuUsage(), wall = process.hrtime.bigint(); let rows: any[] = [];
  if (kind === "serial") {
    for (const input of inputs) { const result = await post("/api/notes", input); owned.add(result.row.id); rows.push(result.row); }
  } else { const result = await post("/api/notes/batch", { notes: inputs }); rows = result.rows; rows.forEach(row => owned.add(row.id)); }
  const elapsedNs = Number(process.hrtime.bigint() - wall), cpuNs = cpuTotal() - cpu, used = process.cpuUsage(client);
  // Verification and cleanup are OUTSIDE each setup timing for both mechanisms.
  assert.equal(rows.length, inputs.length); assert.equal(new Set(rows.map(row => row.id)).size, 32);
  assert.deepEqual(rows.map(({ title, body, tags, pinned }) => ({ title, body, tags, pinned })), inputs);
  assert.ok(rows.every(row => row.revision === 1 && row.createdAt && row.updatedAt));
  const stored = await pool.query("select n.title,n.body,n.tags,n.pinned,n.revision,i.title as index_title,i.body as index_body from notes n join index_docs i on i.source='note' and i.ref=n.id::text where n.id=any($1::int[]) order by n.id", [rows.map(row => row.id)]);
  assert.equal(stored.rows.length, 32);
  const projection = stored.rows.map(row => ({ title: row.title, body: row.body, tags: row.tags, pinned: row.pinned, revision: row.revision, indexTitle: row.index_title, indexBody: row.index_body }));
  const expected = inputs.map(input => ({ ...input, revision: 1, indexTitle: input.title, indexBody: input.body })); assert.deepEqual(projection, expected);
  const result = { kind, warmup, wallMs: elapsedNs / 1e6, sandboxCpuMs: cpuNs / 1e6, clientCpuMs: (used.user + used.system) / 1000, createdRows: rows.length, projectionSha256: digest(projection), identitiesExcludedFromComparison: true };
  await clear(); return result;
}

// Independent direct traversal oracle, also the pre-fast-path algorithm.
// It runs on real JS strings, not a substituted application transport.
function traversal(text: string, start: number, end: number): TextRange {
  let raw = 0, shown = 0, first = start === 0 ? 0 : -1;
  while (shown < end && raw < text.length) { raw += text[raw] === "\r" && text[raw + 1] === "\n" ? 2 : 1; shown++; if (shown === start) first = raw; }
  if (shown !== end || first < 0) throw new Error("Invalid displayed range"); return { start: first, end: raw };
}
const text = "a\n".repeat(524_288), iterations = 200;
for (const sample of [text, "first\r\n🧭\rnext\n", "", "🧭"]) {
  const length = sample.replace(/\r\n?/g, "\n").length;
  for (const [start, end] of [[0, 0], [0, length], [Math.floor(length / 2), length]]) assert.deepEqual(sourceTextRange(sample, start, end), traversal(sample, start, end));
}
function rangeTrial(kind: "traversal" | "fast-path") {
  const fn = kind === "traversal" ? traversal : sourceTextRange;
  const cpu = process.cpuUsage(), wall = process.hrtime.bigint(); let checksum = 0;
  for (let i = 0; i < iterations; i++) { const range = fn(text, text.length - 100, text.length); checksum += range.start + range.end; }
  const elapsedMs = Number(process.hrtime.bigint() - wall) / 1e6, used = process.cpuUsage(cpu);
  assert.equal(checksum, iterations * (text.length * 2 - 100));
  return { kind, wallMs: elapsedMs, processCpuMs: (used.user + used.system) / 1000, checksum };
}
try {
  const warmups = [await setup("serial", true), await setup("batch", true)];
  const setups: Awaited<ReturnType<typeof setup>>[] = []; for (const kind of ["serial", "batch", "batch", "serial", "serial", "batch"] as const) setups.push(await setup(kind));
  assert.equal(new Set(setups.map(row => row.projectionSha256)).size, 1, "Every API setup retains the same declared field/index projection");
  // Warm the implementations before the timed alternating sequence.
  rangeTrial("traversal"); rangeTrial("fast-path");
  const ranges: ReturnType<typeof rangeTrial>[] = []; for (const kind of ["traversal", "fast-path", "fast-path", "traversal", "traversal", "fast-path"] as const) ranges.push(rangeTrial(kind));
  const setupSummary = Object.fromEntries((["serial", "batch"] as const).map(kind => [kind, { medianWallMs: median(setups.filter(row => row.kind === kind).map(row => row.wallMs)), medianSandboxCpuMs: median(setups.filter(row => row.kind === kind).map(row => row.sandboxCpuMs)) }]));
  const rangeSummary = Object.fromEntries((["traversal", "fast-path"] as const).map(kind => [kind, { medianWallMs: median(ranges.filter(row => row.kind === kind).map(row => row.wallMs)), medianProcessCpuMs: median(ranges.filter(row => row.kind === kind).map(row => row.processCpuMs)) }]));
  const pareto = { setup: setupSummary.batch.medianWallMs < setupSummary.serial.medianWallMs && setupSummary.batch.medianSandboxCpuMs < setupSummary.serial.medianSandboxCpuMs, range: rangeSummary["fast-path"].medianWallMs < rangeSummary.traversal.medianWallMs && rangeSummary["fast-path"].medianProcessCpuMs < rangeSummary.traversal.medianProcessCpuMs };
  const receipt = { at: new Date().toISOString(), cpuAffinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:.*$/m)?.[0], availableParallelism: availableParallelism(), node: process.version, sourceSha256: createHash("sha256").update(readFileSync("src/lib/text-selection.ts")).digest("hex"), scope: "32 successful valid public-note fixture creates; exact title/body/tags/pin/revision/index projection, not identity/time equality, failure equivalence or peak-memory Pareto. LF-only 1,048,576-code-unit repeated selection mapping; mixed-ending correctness checked separately. Not universal whole-app latency dominance.", cpuScope: "API setup CPU is whole-sandbox cgroup usage including Node client, real Next server, PostgreSQL and idle infrastructure; range CPU is the executing Node process. No concurrent verification was intentionally scheduled.", warmups, setups, setupSummary, rangeIterations: iterations, ranges, rangeSummary, pareto };
  writeFileSync("docs/evidence/tt134-workflows-benchmark.json", JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify({ setupSummary, rangeSummary, pareto }, null, 2)); assert.ok(pareto.setup && pareto.range, "Do not claim measured Pareto superiority if either declared vector fails");
} finally { await clear(); await pool.end(); }
