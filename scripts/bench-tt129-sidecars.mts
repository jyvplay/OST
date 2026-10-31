/** Paired, same-input microbenchmark of the old and new sidecar selection.
 * Run on an otherwise idle machine: node --experimental-strip-types --import
 * ./scripts/register-hook.mjs scripts/bench-tt129-sidecars.mts */
import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { availableParallelism } from "node:os";
import { selectPhotoSidecars } from "../src/lib/photo-sidecars.ts";

const photos = Array.from({ length: 20_000 }, (_, i) => ({ path: `/Pictures/${i}.png` }));
const candidates = Array.from({ length: 4_500 }, (_, i) =>
  i % 5 === 0 ? `/Pictures/${19_999 - i}.png` : `/Pictures/missing-${i}.png`);
const before = () => candidates.filter((p) => photos.some((x) => x.path === p)).slice(0, 2000);
const after = () => selectPhotoSidecars(photos, candidates);
const reference = before(); assert.deepEqual(after(), reference); after(); before(); // correctness + warmup
const results: Record<string, { wallMs: number; cpuMs: number }[]> = { before: [], after: [] };
for (let i = 0; i < 6; i++) {
  const order = i % 2 ? [["after", after], ["before", before]] as const : [["before", before], ["after", after]] as const;
  for (const [name, fn] of order) {
    const cpu = process.cpuUsage(), start = performance.now(), result = fn();
    const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
    assert.deepEqual(result, reference);
    results[name].push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
  }
}
const stats = (rows: { wallMs: number; cpuMs: number }[]) => ({
  wallMeanMs: rows.reduce((n, r) => n + r.wallMs, 0) / rows.length,
  cpuMeanMs: rows.reduce((n, r) => n + r.cpuMs, 0) / rows.length,
  samples: rows,
});
console.log(JSON.stringify({ availableParallelism: availableParallelism(), photos: photos.length, candidates: candidates.length, matches: reference.length, before: stats(results.before), after: stats(results.after) }, null, 2));
