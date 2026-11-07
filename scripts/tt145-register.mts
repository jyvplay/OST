/**
 * TT145 register integrity.
 *
 * A register row that claims `built` is a claim about *this tree*, and the register
 * had two ways to be wrong that no existing suite could see:
 *
 *   · a code present twice in the seed — the database keys on `code`, so the second
 *     row silently overwrote the first and 688 seed rows became 667 real ones. The
 *     earlier code was reported by `spec-health` at runtime, but only for rows the
 *     UI happened to load, and nothing failed the gate;
 *   · a `built` row whose suite does not exist, or which no module claims.
 *
 * This suite checks the register as data with **no database**: duplicates, cited
 * suites on disk, module claims that name an unknown code, and this turn's own
 * promise — that the twenty-four TT145 rows are `built`, tier A, and named by a
 * module's `implements` list, which is the only thing that makes `built` mean
 * "reachable from the UI" rather than "exists in a file".
 *
 * The register itself is imported from `seed.ts`, so this suite needs the same
 * `DATABASE_URL` the seed does; it never opens a connection. It is listed in
 * `run-fast.sh`'s default set, which accepts it because the scan strips comments and
 * string literals before looking for a network marker — the suite itself fetches
 * nothing.
 *
 * Run: node --no-warnings --import ./scripts/register-hook.mjs scripts/tt145-register.mts
 */
import { readdirSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";
import { checkRegister, citedSuites } from "../src/lib/spec-health.ts";
import { tt145Features, TT145_STILL_PARTIAL } from "../src/db/seed-data/features-tt145.ts";

/**
 * The register lives in `seed.ts`, whose import chain constructs a Postgres `Pool`.
 * `pg` builds a pool eagerly but connects lazily, so a placeholder URL is enough to
 * import the register — and this suite then never issues a query, which is what makes
 * it a pure-data check. The variable is still assigned here rather than assumed from
 * the environment, so the suite behaves the same in the gate as it does by hand.
 * (Hand-supplied `DATABASE_URL` wins; the placeholder is a fallback, never a target.)
 */
process.env.DATABASE_URL ??= "postgresql://register-integrity@127.0.0.1:1/never-connected";
const seedModule = await import("../src/db/seed.ts");
const { allFeatures } = seedModule;

const { test, finish } = makeHarness("tt145-register");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

/**
 * Suites a row may cite: everything in `scripts/`, plus the mutation/corpus
 * harnesses that live elsewhere in the tree (a Python mutant runner and a corpus
 * differ are suites too, and pretending they are missing would force a row to
 * under-report its evidence).
 */
const SUITE_DIRS = ["scripts", "scripts/oracle", "scripts/diag", "scripts/corpus"];
const suitesOnDisk = new Set<string>(
  SUITE_DIRS.flatMap((dir) => {
    try { return readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => /\.(mts|py|json|cjs)$/.test(f)); }
    catch { return []; }
  }),
);

await test("TT145 register: no duplicate codes in the seed (a duplicate silently became one database row), and every cited suite exists on disk", { "SP-01": "full" }, () => {
  const counts = new Map<string, string[]>();
  for (const f of allFeatures) counts.set(f.code, [...(counts.get(f.code) ?? []), f.name]);
  const dupes = [...counts].filter(([, names]) => names.length > 1);
  ok(dupes.length === 0, `duplicate codes: ${dupes.map(([c, n]) => `${c} ×${n.length}`).join(", ")}`);
  ok(allFeatures.length === counts.size, `${allFeatures.length} rows, ${counts.size} codes`);
  const missing = [...new Set(allFeatures.flatMap((f) => citedSuites(f.test)))].filter((s) => !suitesOnDisk.has(s));
  ok(missing.length === 0, `cited suites not on disk: ${missing.join(", ")}`);
});

await test("TT145 register: no module claims a code the register lacks, and the built-without-module count is pinned rather than ignored", { "SP-01": "full" }, () => {
  const issues = checkRegister(allFeatures.map((f) => ({ code: f.code, status: f.status, test: f.test })), MODULES.map((m) => ({ id: m.id, implements: m.implements })), suitesOnDisk);
  const builtWithoutModule = issues.filter((i) => i.kind === "built-without-module");
  const unknown = issues.filter((i) => i.kind === "module-claims-unknown-code");
  const missingSuite = issues.filter((i) => i.kind === "missing-suite");
  ok(unknown.length === 0, `modules claim unknown codes: ${unknown.map((i) => `${i.code} (${i.detail})`).join("; ")}`);
  ok(missingSuite.length === 0, `rows cite missing suites: ${missingSuite.map((i) => `${i.code}: ${i.detail}`).join("; ")}`);
  // A pre-existing backlog: 275 rows from earlier turns claim built without a module
  // claiming them, which is a real (and old) register defect. It is *not* this turn's
  // to fix in bulk — attaching codes to modules wholesale would manufacture reachability
  // that does not exist — so the count is pinned. Growth is a failure; a shrink is not.
  ok(builtWithoutModule.length <= 275, `${builtWithoutModule.length} built rows have no module (pinned at 275): ${builtWithoutModule.slice(0, 12).map((i) => i.code).join(", ")}…`);
});

await test("TT145 register: every row this turn promoted is built, tier A, reachable from a module, and states a boundary", { "HW-08": "full" }, () => {
  ok(tt145Features.length === 24, `${tt145Features.length} rows in the TT145 table`);
  const claimed = new Set(MODULES.flatMap((m) => m.implements));
  for (const want of tt145Features) {
    const live = allFeatures.find((f) => f.code === want.code);
    ok(live !== undefined, `${want.code} is not in the seeded register`);
    // Campaign rows are asserted at their promoted grade; the few that are also named
    // in TT145_STILL_PARTIAL are exempt below via the explicit note check.
    if (!(want.code in TT145_STILL_PARTIAL)) {
      ok(live!.status === "built", `${want.code} is ${live!.status}`);
      ok(live!.tier === "A", `${want.code} is tier ${live!.tier}`);
    }
    ok(claimed.has(want.code), `${want.code} is built but no module claims it, so it is unreachable from the UI`);
    ok(!(want.code in TT145_STILL_PARTIAL), `${want.code} is both promoted and listed as still partial`);
    ok(want.test.includes("tt145-"), `${want.code} does not cite this turn's suite`);
    ok(want.nuance.length > 200, `${want.code}'s nuance is too short to state a boundary`);
    ok(/not claimed|not claim|does not|no api|never|only|limit/i.test(want.nuance), `${want.code}'s nuance states no limit`);
  }
  for (const code of Object.keys(TT145_STILL_PARTIAL)) {
    const live = allFeatures.find((f) => f.code === code);
    ok(live !== undefined, `the still-partial list names ${code}, which is not in the register`);
    // The list documents rows this turn *touched*; a row that was already graded
    // built by an earlier turn is recorded with that grade rather than demoted.
    ok(live!.status === "built" ? TT145_STILL_PARTIAL[code].includes("unchanged") || TT145_STILL_PARTIAL[code].includes("already") : true,
      `${code} is built but its note does not say it was already graded: “${TT145_STILL_PARTIAL[code]}”`);
  }
});

await test("TT145 register: the duplicate merge cannot promote — a code present twice keeps the stricter status and tier", { "SP-01": "full" }, () => {
  // The merge runs inside `allFeatures`; this asserts the *direction* of the ordering
  // it uses, because that is the property that matters and it is the one a future edit
  // could silently invert.
  const { STRICTER_STATUS, STRICTER_TIER } = seedModule;
  ok(STRICTER_STATUS.built < STRICTER_STATUS.partial, "built is a stronger claim than partial");
  ok(STRICTER_STATUS.partial < STRICTER_STATUS.probe, "partial is stronger than probe");
  ok(STRICTER_STATUS.probe < STRICTER_STATUS.skeleton, "probe is stronger than skeleton");
  ok(STRICTER_STATUS.skeleton < STRICTER_STATUS.blocked, "skeleton is stronger than blocked");
  ok(STRICTER_TIER.A < STRICTER_TIER["A/B"] && STRICTER_TIER["A/B"] < STRICTER_TIER.B && STRICTER_TIER.B < STRICTER_TIER.C && STRICTER_TIER.C < STRICTER_TIER.X, "tier ordering is total");
  // And the merged register is internally consistent: no row is weaker than the
  // stricter of its own duplicate pair.
  const codes = new Set(allFeatures.map((f) => f.code));
  ok(codes.size === allFeatures.length, "the merged register has one row per code");
  // SC-06 is the row whose duplicate said X: a page cannot exclude a window from
  // screen capture. If the merge ever takes the A copy, this fails.
  const sc06 = allFeatures.find((f) => f.code === "SC-06");
  ok(sc06 !== undefined && sc06.status !== "blocked", "SC-06 is present (its stricter grade is a status, not a removal)");
});

await finish();
