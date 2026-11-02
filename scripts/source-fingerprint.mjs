/** Reproducible content identity for checked-out implementation/verification
 * inputs. Documents, evidence, caches and installed dependencies are excluded.
 * This is not a Git commit signature, proof of execution or build attestation.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const output = process.argv[2];
if (!output) throw new Error("usage: node scripts/source-fingerprint.mjs <receipt.json>");
const paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0"))]
  .filter(path => path && existsSync(path) && (/^(src|scripts|public)\//.test(path) || (!path.includes("/") && /\.(?:[cm]?js|json|ts|css|sh)$/.test(path))))
  .sort();
const files = paths.map(path => {
  const content = readFileSync(path);
  return { path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
});
const identity = entries => {
  const hash = createHash("sha256");
  for (const file of entries) hash.update(file.path).update("\0").update(file.sha256).update("\n");
  return hash.digest("hex");
};
const receipt = {
  at: new Date().toISOString(),
  branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope: "Existing Git-listed tracked or nonignored untracked src/, scripts/, public/ and root JS/JSON/TS/CSS/shell configuration inputs; docs/evidence/caches/dependencies excluded",
  encoding: "SHA256 over sorted UTF-8 path + NUL + raw-file SHA256 hex + LF, one entry per path",
  fileCount: files.length,
  sha256: identity(files),
  withoutGeneratedCoverageSha256: identity(files.filter(file => file.path !== "src/data/coverage.json")),
  exclusionsCaveat: "The coverage-excluding identity omits only generated src/data/coverage.json; it is NOT a proof that excluded metadata has no effects",
  files,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ fileCount: receipt.fileCount, sha256: receipt.sha256, withoutGeneratedCoverageSha256: receipt.withoutGeneratedCoverageSha256, output }, null, 2));
