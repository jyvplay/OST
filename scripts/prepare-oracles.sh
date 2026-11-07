#!/usr/bin/env bash
# Restore the independent oracle toolchain AND the pinned corpus the gate needs.
#
# These libraries are NEVER imported by the app. They exist so a claim like
# "our TIFF decoder is bit-exact" can be checked against Pillow rather than
# against itself. The pinned DOCX fixtures are real Apache POI test documents,
# used as inputs, not as code.
#
# This script exists because that whole toolchain once lived only in a scratch
# directory. When it disappeared, nothing broke loudly: the gate refused at
# prerequisites, and every oracle-backed suite silently stopped being able to
# run. Reproducing it was a session of guesswork. Hence a committed script.
#
# Usage:  bash scripts/prepare-oracles.sh [target-dir]     (default /home/user/tools)
# Env:    TOOLS_DIR. Network access is required on first run.
set -euo pipefail

DIR="${1:-${TOOLS_DIR:-/home/user/tools}}"
mkdir -p "$DIR"

echo "== node oracles -> $DIR"
if [ ! -f "$DIR/package.json" ]; then
  cat > "$DIR/package.json" <<'JSON'
{
  "name": "fusion-oracles",
  "private": true,
  "type": "module",
  "description": "Independent oracle libraries used ONLY to verify our own implementations. Never imported by the app.",
  "dependencies": {
    "@napi-rs/canvas": "1.1.0",
    "@js-temporal/polyfill": "0.4.4",
    "ical.js": "2.1.0",
    "pdfjs-dist": "4.10.38"
  }
}
JSON
fi
( cd "$DIR" && npm install --no-audit --no-fund --silent )

echo "== python oracles -> $DIR/venv"
if [ ! -x "$DIR/venv/bin/python" ]; then
  python3 -m venv "$DIR/venv"
fi
"$DIR/venv/bin/pip" install --quiet --upgrade pip
"$DIR/venv/bin/pip" install --quiet Pillow python-docx openpyxl python-pptx pypdf

echo "== pinned corpus (Apache POI test documents, digest-verified)"
CORPUS="$DIR/corpus/docx"
mkdir -p "$CORPUS"
node - "$CORPUS" <<'JS'
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const dir = process.argv[2];
const want = JSON.parse(readFileSync("docs/evidence/tt134-native-office-corpus.json", "utf8")).fixtures;
const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let ok = 0, already = 0, failed = 0;
for (const f of want) {
  const name = f.path.split("/").at(-1);
  const dest = `${dir}/${name}`;
  if (existsSync(dest) && digest(dest) === f.sha256) { console.log(`  ${name} present, digest ok`); already++; continue; }
  // raw.githubusercontent.com is not reachable from this environment; the
  // contents API with a raw Accept header is.
  const url = `https://api.github.com/repos/${f.repository}/contents/${f.path}?ref=${f.ref}`;
  try {
    writeFileSync(dest, execFileSync("curl", ["-sL", "-H", "Accept: application/vnd.github.raw", url]));
  } catch (e) { console.log(`  ${name}: download failed (${e.message})`); failed++; continue; }
  const got = digest(dest);
  if (got === f.sha256) { console.log(`  ${name} fetched, digest ok`); ok++; }
  else { console.log(`  ${name} DIGEST MISMATCH ${got} != ${f.sha256} — refusing to use it`); failed++; }
}
console.log(`  corpus: ${already} already present, ${ok} fetched, ${failed} failed`);
if (failed) { console.error("  the gate will refuse until every fixture is restored and digest-clean"); process.exitCode = 1; }
JS

echo "== verify"
node -e "const c=require('$DIR/node_modules/@napi-rs/canvas');if(typeof c.Path2D!=='function')throw new Error('canvas unusable');console.log('  @napi-rs/canvas ok')"
"$DIR/venv/bin/python" - <<'PY'
import PIL, docx, openpyxl, pptx, pypdf
print("  Pillow", PIL.__version__)
PY
echo "== done: $DIR"
