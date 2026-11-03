/** Fail early on genuinely absent independent test tools/inputs. Presence and
 * package metadata are NOT successful oracle execution or app acceptance.
 * Does not install, download, substitute an oracle or relax any suite.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tools = process.env.TOOLS_DIR ?? "/home/user/tools";
const packages = {};
for (const name of ["@js-temporal/polyfill", "ical.js", "pdfjs-dist", "@napi-rs/canvas"]) {
  const path = join(tools, "node_modules", name, "package.json");
  assert.ok(existsSync(path), `Missing test-only ${name} at ${path}; install licensed oracle tools outside production dependencies before the gate`);
  const info = JSON.parse(readFileSync(path, "utf8")); packages[name] = { version: info.version, license: info.license };
}
assert.ok(existsSync(join(tools, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")), "Missing independent PDF.js legacy entry");
const fixtures = JSON.parse(readFileSync("docs/evidence/tt134-native-office-corpus.json", "utf8")).fixtures;
// The carried header/footer suite uses this location; identify its actual
// required path rather than checking an unused duplicate corpus directory.
const corpus = process.env.CORPUS_DOCX ?? "/home/user/tools/corpus/docx";
for (const fixture of fixtures) {
  const path = join(corpus, fixture.path.split("/").at(-1));
  assert.ok(existsSync(path), `Missing real independent DOCX input ${path}; restore the pinned Apache POI blob, do not skip its cases`);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, fixture.bytes, `Wrong independent corpus size: ${path}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256, `Wrong independent corpus digest: ${path}`);
}
const python = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
assert.ok(existsSync(python), `Missing real oracle Python: ${python}`);
const pythonPackages = JSON.parse(execFileSync(python, ["-c", "import importlib.metadata,json; print(json.dumps({p:importlib.metadata.version(p) for p in ['Pillow','python-docx','openpyxl','python-pptx','pypdf']}))"], { encoding: "utf8" }));
console.log(JSON.stringify({ scope: "Read-only prerequisites and identities, not executed app/oracle acceptance", tools, packages, python, pythonPackages, corpus, pinnedCorpusFiles: fixtures.length }, null, 2));
