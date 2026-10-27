/** Isolated fixture test of the ledger generator's classification policy; no real server or DB is mutated. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt92-ledger-policy"), exec = promisify(execFile);
const scratch = await mkdtemp(join(tmpdir(), "tt92-ledger-")), generator = resolve("scripts/ledger.mjs");
const rows = [
  { code: "T-BUILT", status: "built", family: "test" }, { code: "T-PARTIAL", status: "partial", family: "test" },
  { code: "T-PROBE", status: "probe", family: "test" }, { code: "T-BLOCKED", status: "blocked", family: "test" },
  { code: "T-EMPTY", status: "skeleton", family: "test" },
];
const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ rows })); });
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address(); assert.ok(address && typeof address !== "string");
const env = { ...process.env, BASE: `http://127.0.0.1:${address.port}` };
try {
  await mkdir(join(scratch, "docs/test-results"), { recursive: true });
  const path = join(scratch, "docs/test-results/fake.json");
  const fake = { suite: "fixture", at: "2000-01-01T00:00:00Z", results: [
    { name: "built", pass: true, covers: { "T-BUILT": "full" } }, { name: "incomplete", pass: true, covers: { "T-PARTIAL": "full", "T-PROBE": "full" } },
    { name: "blocked honesty", pass: true, covers: { "T-BLOCKED": "full" } }, { name: "failure", pass: false, covers: { "T-EMPTY": "full" } },
  ] };
  await writeFile(path, JSON.stringify(fake));
  await test("full-tagged incomplete rows stay partial; blocked honesty and failed tests are distinguished", {}, async () => {
    await exec(process.execPath, [generator], { cwd: scratch, env });
    const result = JSON.parse(await readFile(join(scratch, "src/data/coverage.json"), "utf8"));
    assert.equal(result.rows["T-BUILT"].tested, "full"); assert.equal(result.rows["T-PARTIAL"].tested, "partial");
    assert.equal(result.rows["T-PROBE"].tested, "partial"); assert.equal(result.rows["T-BLOCKED"].tested, "full"); assert.equal(result.rows["T-EMPTY"].tested, "untested");
    const text = await readFile(join(scratch, "docs/LEDGER.md"), "utf8"); assert.match(text, /not independent proof/); assert.match(text, /Rows touched by FAILING tests/);
  });
  await test("unknown test feature codes fail instead of silently inflating coverage", {}, async () => {
    fake.results.push({ name: "unknown", pass: true, covers: { "T-NOT-REGISTERED": "full" } } as any); await writeFile(path, JSON.stringify(fake));
    await assert.rejects(() => exec(process.execPath, [generator], { cwd: scratch, env }), /unknown feature codes/i);
  });
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(scratch, { recursive: true, force: true });
}
finish();
