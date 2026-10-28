#!/usr/bin/env bash
# Full environment rebuild after an Arena sandbox reset (TT76). The reset wipes node_modules, /home/user/tools, /tmp and
# processes; TT75's gate showed that a partial manual rebuild silently drops oracles (the MS-XLSX schemas) and leaves the
# server unable to verify TLS through the sandbox's interception proxy. This script runs every step in order:
#
#   TT89_DISPOSABLE_DATABASE=1 DATABASE_URL=postgresql://.../disposable_db bash scripts/sandbox/rebuild-all.sh
#   # The explicitly named database must already exist and be exclusive/disposable.
#
# Only registry.npmjs.org, PyPI and github.com are reachable; every source below comes from them.
set -uo pipefail
if [ "${TT89_DISPOSABLE_DATABASE:-0}" != "1" ] || [ -z "${DATABASE_URL:-}" ]; then
  echo "Refusing rebuild: forced schema push requires TT89_DISPOSABLE_DATABASE=1 and an explicit disposable DATABASE_URL." >&2
  exit 2
fi
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${TOOLS_DIR:-/home/user/tools}"
step() { echo "=== $(date +%T) $*"; }
cd "$REPO"
step "npm ci";                         npm ci --no-audit --no-fund >/dev/null 2>&1 || { echo "npm ci failed"; exit 1; }
mkdir -p "$TOOLS" && cd "$TOOLS" && { [ -f package.json ] || echo '{ "name": "fusion-tools", "private": true }' > package.json; }
step "tools npm (chromium, postgres, file-type oracles)"
npm install --no-audit --no-fund "@sparticuz/chromium@143.0.4" "embedded-postgres@17.10.0-beta.17" "file-type@22.2.0" "ft16@npm:file-type@16.5.4" >/dev/null 2>&1 || echo "tools npm failed"
cd "$REPO"
step "bootstrap (venv, postgres, schema)"; bash scripts/sandbox/bootstrap.sh || { echo "bootstrap failed" >&2; exit 1; }
step "pip extras"
"$TOOLS/venv/bin/pip" install -q mammoth markdown-it-py mdit-py-plugins spylls av mutagen exifread piexif pillow_heif psd-tools==1.26.0 pyHanko==0.38.0 glymur pyzipper || echo "pip extras failed"   # TT77: pyHanko + glymur (PDF signature / JPX oracles)
step "ECMA-376 XSDs";                  bash scripts/oracle/fetch-xsd.sh >/dev/null 2>&1 || echo "fetch-xsd failed"
step "MS-XLSX XSDs";                   bash scripts/oracle/fetch-msxlsx-xsd.sh >/dev/null 2>&1 || echo "fetch-msxlsx failed"
step "corpora (POI, meta, pdf)"
"$TOOLS/venv/bin/python" scripts/corpus/fetch.py >/dev/null 2>&1 || echo "corpus fetch failed"
"$TOOLS/venv/bin/python" scripts/corpus/fetch-meta.py "$TOOLS/corpus" >/dev/null 2>&1 || echo "fetch-meta failed"
"$TOOLS/venv/bin/python" scripts/corpus/fetch-pdf.py >/dev/null 2>&1 || echo "fetch-pdf failed"
bash scripts/corpus/fetch-filters.sh >/dev/null 2>&1 || echo "fetch-filters failed"   # TT76 (after the POI corpus)
step "EPUB corpora"
mkdir -p "$TOOLS/corpus/epub" && cd "$TOOLS/corpus/epub"
[ -d epub3-samples ] || git clone -q --depth 1 https://github.com/IDPF/epub3-samples.git || echo "epub3-samples clone failed"
[ -d epub-tests ] || git clone -q --depth 1 https://github.com/w3c/epub-tests.git || echo "epub-tests clone failed"
cd "$REPO"
step "ZIP corpus (TT79: real Deflate64 archives, MIT — anatawa12/deflate64-rs test-assets, from dotnet/runtime-assets)"
mkdir -p "$TOOLS/corpus/zip"
for f in test-assets/README.md test-assets/deflate64.zip test-assets/issue-13/unitwf-1.5.0.minimized.zip test-assets/issue-25/deflate64_not_enough_space.zip test-assets/issue-29/raw.zip; do
  [ -s "$TOOLS/corpus/zip/d64-$(basename $f)" ] || curl -s -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/anatawa12/deflate64-rs/contents/$f" -o "$TOOLS/corpus/zip/d64-$(basename $f)" || echo "zip corpus fetch failed: $f"
done
step "done"
echo "next: DATABASE_URL=<the same disposable URL> npm run build"
echo "then: NODE_OPTIONS=--use-system-ca DATABASE_URL=… npm exec next start -- -H 0.0.0.0 -p 3999"
