#!/usr/bin/env bash
# Full environment rebuild after an Arena sandbox reset (TT76). The reset wipes node_modules, /home/user/tools, /tmp and
# processes; TT75's gate showed that a partial manual rebuild silently drops oracles (the MS-XLSX schemas) and leaves the
# server unable to verify TLS through the sandbox's interception proxy. This script runs every step in order:
#
#   bash scripts/sandbox/rebuild-all.sh            # then: npm run build (with DATABASE_URL) and start the server with
#                                                  # NODE_OPTIONS=--use-system-ca (see the last lines of output)
#
# Only registry.npmjs.org, PyPI and github.com are reachable; every source below comes from them.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${TOOLS_DIR:-/home/user/tools}"
step() { echo "=== $(date +%T) $*"; }
cd "$REPO"
step "npm ci";                         npm ci --no-audit --no-fund >/dev/null 2>&1 || { echo "npm ci failed"; exit 1; }
mkdir -p "$TOOLS" && cd "$TOOLS" && { [ -f package.json ] || echo '{ "name": "fusion-tools", "private": true }' > package.json; }
step "tools npm (chromium, postgres, file-type oracles)"
npm install --no-audit --no-fund "@sparticuz/chromium@143.0.4" "embedded-postgres@17.10.0-beta.17" "file-type@22.2.0" "ft16@npm:file-type@16.5.4" >/dev/null 2>&1 || echo "tools npm failed"
cd "$REPO"
step "bootstrap (venv, postgres, schema)"; bash scripts/sandbox/bootstrap.sh || echo "bootstrap failed"
step "pip extras"
"$TOOLS/venv/bin/pip" install -q mammoth markdown-it-py mdit-py-plugins spylls av mutagen exifread piexif pillow_heif psd-tools==1.26.0 || echo "pip extras failed"
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
step "done"
echo "next: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db npm run build"
echo "then: NODE_OPTIONS=--use-system-ca DATABASE_URL=… npm exec next start -- -H 0.0.0.0 -p 3999"
