#!/usr/bin/env bash
# Rebuild the dev/test environment after a sandbox reset (the reset wipes node_modules, /tmp, TOOLS_DIR and processes).
# Everything comes from registry.npmjs.org / PyPI, the only hosts the Arena sandbox allows.
#
#   bash scripts/sandbox/bootstrap.sh          # tools + venv + postgres + schema (run `npm ci` in the repo first)
#
# TOOLS_DIR (default /home/user/tools) holds:
#   @sparticuz/chromium   a real Chromium packed inside an npm tarball (Playwright's CDN is not reachable)
#   @embedded-postgres/linux-x64   real PostgreSQL binaries (driven by scripts/sandbox/pg-start.mjs)
#   venv/                 Python oracles used by the test suites (openpyxl, formulas, psd-tools, …)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${TOOLS_DIR:-/home/user/tools}"
mkdir -p "$TOOLS"
cd "$TOOLS"
[ -f package.json ] || echo '{ "name": "fusion-tools", "private": true }' > package.json
if [ ! -d node_modules/@sparticuz/chromium ] || [ ! -d node_modules/@embedded-postgres/linux-x64 ]; then
  npm install --no-audit --no-fund "@sparticuz/chromium@^143" "@embedded-postgres/linux-x64" "file-type@22.2.0" "ft16@npm:file-type@16.5.4" >/dev/null
fi
if [ ! -x venv/bin/python ]; then python3 -m venv venv; fi
venv/bin/python -c "import argon2, cryptography, docx, formulas, numpy, openpyxl, pptx, psd_tools, shapely, svgelements, pocketsphinx, readability, openlocationcode, pproxy, websockets, geographiclib, gpxpy, pypac" 2>/dev/null || \
  venv/bin/pip install -q argon2-cffi cryptography python-docx formulas numpy openpyxl python-pptx psd-tools shapely svgelements pypdf==6.21.0 vobject==0.9.9 pocketsphinx==5.1.1 \
    readability-lxml openlocationcode pproxy==2.7.9 websockets==13.1 geographiclib gpxpy pypac==0.19.0
# TT36/TT37 test-only oracles: readability-lxml (Apache-2.0, reader-view oracle), openlocationcode (Apache-2.0, Plus Codes
# reference), pproxy (MIT, an independent SOCKS5 / HTTP CONNECT server for the network-route tests), websockets (BSD-3, an independent RFC 6455 server for the WebSocket tests), geographiclib (MIT) and gpxpy (Apache-2.0) — the TT34 geodesy / GPX oracles, missing from this list until TT38; pypac (Apache-2.0, runs PAC files in Duktape via dukpy, MIT) — the TT39 PAC differential oracle. None ships in Fusion.
# pocketsphinx (CMU BSD-style licence, wheel bundles the en-us acoustic model + CMUdict) is the TEST-ONLY speech-recognition oracle for
# Fusion Voice (scripts/oracle/asr.py, scripts/tt32-voice.mts, scripts/e2e-tt32.mts). Nothing from it ships in Fusion.
node "$REPO/scripts/sandbox/pg-start.mjs"
cd "$REPO"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
npx drizzle-kit push --force >/dev/null
# Unpack Chromium once so /tmp/al2023/lib (its NSS libs) exists for LD_LIBRARY_PATH.
AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x node -e "const m=require('$TOOLS/node_modules/@sparticuz/chromium'); (m.default??m).executablePath().then(p=>console.log('chromium', p))"
echo "bootstrap ok"
