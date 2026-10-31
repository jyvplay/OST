/** Alternating, full-suite wall-time samples against a real disposable
 * production server and Chromium. Both variants run the same four cases.
 * The newer variant adds a Lens assertion and cleans its routine fixture. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("exclusive disposable server/database and BASE required");
const BASE = process.env.BASE, temp = "scripts/.tt130-tt124-before.mts";
writeFileSync(temp, execFileSync("git", ["show", "bf92aa8:scripts/e2e-tt124.mts"], { encoding: "utf8" }));
const env = { ...process.env }; delete env.HARNESS_ONLY;
const results: Record<string, { wallMs: number; cases: string[] }[]> = { before: [], after: [] };
async function routines() {
  // spawnSync blocks this process long enough for Next's keep-alive socket to
  // expire. Avoid reusing that stale administrative connection after a run.
  const response = await fetch(`${BASE}/api/routines`, { headers: { connection: "close" } }); if (!response.ok) throw new Error(`routines: ${response.status}`);
  return (await response.json()).rows as { id: number; name: string }[];
}
try {
  for (let pair = 0; pair < 3; pair++) {
    for (const variant of (pair % 2 ? ["after", "before"] : ["before", "after"])) {
      const initial = new Set((await routines()).map((row) => row.id));
      let run;
      const start = performance.now();
      try {
        run = spawnSync(process.execPath, ["--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", variant === "before" ? temp : "scripts/e2e-tt124.mts"], { env, encoding: "utf8", timeout: 180_000 });
        const wallMs = performance.now() - start;
        if (run.error || run.status !== 0 || !/4 passed, 0 failed/.test(run.stdout)) throw new Error(`${variant} failed (${run.status}):\n${run.stdout}\n${run.stderr}\n${run.error ?? ""}`);
        const cases = run.stdout.split("\n").filter((line) => line.includes("✓")).map((line) => line.split("✓")[1].trim());
        assert.equal(cases.length, 4);
        if (results.before.length) assert.deepEqual(cases, results.before[0].cases);
        results[variant].push({ wallMs, cases });
      } finally {
        // Only remove newly created fixtures from this explicitly disposable
        // server. The original suite did not clean them itself.
        for (const row of await routines()) if (!initial.has(row.id) && row.name === "tt124 sample") {
          const response = await fetch(`${BASE}/api/routines?id=${row.id}`, { method: "DELETE", headers: { connection: "close" } });
          if (!response.ok) throw new Error(`fixture cleanup: ${response.status}`);
        }
      }
    }
  }
  const stats = (rows: typeof results.before) => ({ wallMeanMs: rows.reduce((sum, r) => sum + r.wallMs, 0) / rows.length, samples: rows.map((r) => r.wallMs), cases: rows[0].cases });
  console.log(JSON.stringify({ availableParallelism: availableParallelism(), baseline: "bf92aa8:scripts/e2e-tt124.mts", pairs: 3, before: stats(results.before), after: stats(results.after) }, null, 2));
} finally { unlinkSync(temp); }
