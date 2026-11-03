/** Full-repository ESLint, with content-addressed reusable results. No changed-
 * file shortcut, rule change, warning filter or successful-exit substitution.
 * Conservatively invalidate the WHOLE cache on source-graph changes: ESLint's
 * per-file cache alone cannot track rules that inspect imported modules/routes.
 * Normal npm-managed dependency/config/Node changes also select a new cache.
 * This optimizes repeated unchanged runs, not incremental edits. For manually
 * modified node_modules/plugins, use the independent `npm run lint:clean`. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function lintCacheKey(root, version = process.version) {
  const hash = createHash("sha256").update(`ost-eslint-graph-v2\0${version}\0`);
  for (const file of ["package.json", "package-lock.json", "eslint.config.mjs", "node_modules/.package-lock.json"]) {
    hash.update(file).update("\0").update(readFileSync(join(root, file))).update("\0");
  }
  const excluded = new Set([".git", ".cache", ".next", "node_modules", "out", "build", "dist", "coverage", "__pycache__"]);
  const walk = (directory, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (excluded.has(entry.name) || (relative === "docs" && ["evidence", "screens", "test-results"].includes(entry.name))) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), name);
      else {
        // Hash names too: adding/removing a route can affect an unchanged link.
        hash.update(name).update("\0");
        if (/\.(?:[cm]?[jt]sx?|json|css|scss|svg)$/.test(entry.name)) hash.update(readFileSync(join(root, name))).update("\0");
      }
    }
  };
  walk(root);
  return hash.digest("hex").slice(0, 24);
}
export function runLint(args = process.argv.slice(2)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), cli = join(root, "node_modules/eslint/bin/eslint.js");
  // Missing/unreadable metadata is a hard failure, never permission to reuse an
  // unvalidated cache. The clean script remains available for diagnosis.
  const cache = join(root, ".cache/eslint", lintCacheKey(root)); mkdirSync(dirname(cache), { recursive: true });
  const child = spawnSync(process.execPath, [cli, ".", "--cache", "--cache-strategy", "content", "--cache-location", cache, ...args], { cwd: root, stdio: "inherit" });
  if (child.error) { console.error(child.error.message); return 2; }
  if (child.signal) { console.error(`ESLint terminated by ${child.signal}`); return 2; }
  return child.status ?? 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = runLint(); } catch (error) { console.error(`ESLint cache refused: ${error.message}`); process.exitCode = 2; }
}
