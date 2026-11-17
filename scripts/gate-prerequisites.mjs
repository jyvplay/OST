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
const pythonPackages = JSON.parse(execFileSync(python, ["-c", "import importlib.metadata,json; import numpy,zxingcpp,pillow_heif,msoffcrypto; print(json.dumps({p:importlib.metadata.version(p) for p in ['Pillow','pillow-heif','python-docx','openpyxl','python-pptx','pypdf','numpy','zxing-cpp','msoffcrypto-tool']}))"], { encoding: "utf8" }));
// The browser suites use generated, real encoded image bytes, not a header stub.
// Decode both with the independent test-only libraries and check their format
// and dimensions before starting a long gate. Do not silently skip a fixture.
for (const format of ["avif", "heic"]) {
  const path = `/tmp/tt148-${format}.json`;
  assert.ok(existsSync(path), `Missing real ${format} fixture ${path}; run scripts/prepare-oracles.sh`);
  execFileSync(python, ["-c", `import base64,io,json,sys; from PIL import Image; import pillow_heif; pillow_heif.register_heif_opener(); f=json.load(open(sys.argv[1])); im=Image.open(io.BytesIO(base64.b64decode(f['bytes'],validate=True))); im.load(); assert im.format==sys.argv[2] and im.size==(f['width'],f['height'])`, path, format === "avif" ? "AVIF" : "HEIF"], { stdio: "pipe" });
}
console.log(JSON.stringify({ scope: "Read-only prerequisites and identities, not executed app/oracle acceptance", tools, packages, python, pythonPackages, corpus, pinnedCorpusFiles: fixtures.length, generatedImageFixtures: ["avif", "heic"] }, null, 2));
