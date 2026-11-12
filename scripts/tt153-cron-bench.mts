/** Manual benchmark: identical input and assertion, no result-file rewriting. */
import assert from "node:assert/strict";
import { parseCron, nextOccurrences } from "../src/lib/cron.ts";
const parsed = parseCron("* * * * *");
assert.ok(parsed.ok);
const start = Date.UTC(2025, 0, 2, 23, 55, 30);
const expected = Array.from({ length: 5 }, (_, i) => Date.UTC(2025, 0, 2, 23, 56 + i));
for (let i = 0; i < 3; i++) assert.deepEqual(nextOccurrences(parsed.schedule, start, "UTC", 5).instants, expected);
const t = performance.now();
for (let i = 0; i < 20; i++) assert.deepEqual(nextOccurrences(parsed.schedule, start, "UTC", 5).instants, expected);
console.log(JSON.stringify({ iterations: 20, elapsedMs: Math.round(performance.now() - t), workload: "UTC, every minute, cursor at 23:55:30, five results" }));
