/** Cache-key invalidation contract, using disposable metadata only. The actual
 * full-ESLint diagnostic/mtime attack is scripts/benchmark-lint.py. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lintCacheKey } from "./lint.mjs";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt132-lint-contract");
const root = mkdtempSync(join(tmpdir(), "ost-eslint-key-"));
const files = ["package.json", "package-lock.json", "eslint.config.mjs", "node_modules/.package-lock.json"];
try {
  for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), "initial bytes"); }
  await test("every root config, declared lock and installed metadata change invalidates the cache namespace", {}, () => {
    const initial = lintCacheKey(root);
    for (const file of files) { const path = join(root, file), before = readFileSync(path); writeFileSync(path, "changed bytes"); assert.notEqual(lintCacheKey(root), initial, file); writeFileSync(path, before); assert.equal(lintCacheKey(root), initial); }
  });
  await test("an unchanged importer is invalidated by a same-length same-metadata dependency edit or a new route", {}, () => {
    mkdirSync(join(root, "src/app"), { recursive: true });
    const path = join(root, "src/app/page.tsx"); writeFileSync(path, "export const value = 1;"); utimesSync(path, 1700000000, 1700000000);
    const initial = lintCacheKey(root); writeFileSync(path, "export const value = 2;"); utimesSync(path, 1700000000, 1700000000);
    assert.equal(statSync(path).mtimeMs, 1700000000000); assert.notEqual(lintCacheKey(root), initial);
    const changed = lintCacheKey(root); writeFileSync(join(root, "src/app/new-route.tsx"), "export default 1;"); assert.notEqual(lintCacheKey(root), changed);
  });
  await test("a Node version change invalidates the namespace even with identical source/config", {}, () => {
    assert.notEqual(lintCacheKey(root, "v22.22.3"), lintCacheKey(root, "v24.0.0"));
  });
  await test("missing metadata fails closed instead of silently trusting an old cache", {}, () => {
    rmSync(join(root, "eslint.config.mjs")); assert.throws(() => lintCacheKey(root), /ENOENT/);
  });
} finally { rmSync(root, { recursive: true, force: true }); }
finish();
