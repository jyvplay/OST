#!/usr/bin/env bash
# Rebuild the dev/test environment after a sandbox reset (the reset wipes node_modules, /tmp, TOOLS_DIR and processes).
# Everything comes from registry.npmjs.org / PyPI, the only hosts the Arena sandbox allows.
#
#   TT89_DISPOSABLE_DATABASE=1 DATABASE_URL=postgresql://.../disposable_db bash scripts/sandbox/bootstrap.sh
#   # The database must already exist and be exclusive/disposable; run `npm ci` in the repo first.
#
# TOOLS_DIR (default /home/user/tools) holds:
#   @sparticuz/chromium   a real Chromium packed inside an npm tarball (Playwright's CDN is not reachable)
#   @embedded-postgres/linux-x64   real PostgreSQL binaries (driven by scripts/sandbox/pg-start.mjs)
#   venv/                 Python oracles used by the test suites (openpyxl, formulas, psd-tools, …)
set -euo pipefail
# Schema push uses --force: require an explicit disposable target rather than
# silently applying it to the hard-coded URL in drizzle.config.json.
if [ "${TT89_DISPOSABLE_DATABASE:-0}" != "1" ] || [ -z "${DATABASE_URL:-}" ]; then
  echo "Refusing forced schema push without TT89_DISPOSABLE_DATABASE=1 and an explicit disposable DATABASE_URL." >&2
  exit 2
fi
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${TOOLS_DIR:-/home/user/tools}"
mkdir -p "$TOOLS"
cd "$TOOLS"
[ -f package.json ] || echo '{ "name": "fusion-tools", "private": true }' > package.json
if [ ! -d node_modules/@sparticuz/chromium ] || [ ! -d node_modules/@embedded-postgres/linux-x64 ]; then
  npm install --no-audit --no-fund "@sparticuz/chromium@^143" "@embedded-postgres/linux-x64" "file-type@22.2.0" "ft16@npm:file-type@16.5.4" >/dev/null
fi
# TT87/TT88 independent test-only raster oracle; these packages are not PWA dependencies.
if [ ! -f node_modules/pdfjs-dist/legacy/build/pdf.mjs ] || [ ! -d node_modules/@napi-rs/canvas ]; then
  npm install --no-audit --no-fund 'pdfjs-dist@5.4.624' '@napi-rs/canvas@0.1.80' >/dev/null
fi
if [ ! -x venv/bin/python ]; then python3 -m venv venv; fi
venv/bin/python -c "import argon2, cryptography, docx, formulas, numpy, openpyxl, pptx, psd_tools, shapely, svgelements, pocketsphinx, readability, openlocationcode, pproxy, websockets, geographiclib, gpxpy, pypac, asyncssh, bcrypt, paramiko, msoffcrypto, olefile, lxml, pypdf, pypdfium2, pikepdf, pymupdf, piexif, av, mutagen" 2>/dev/null || \
  venv/bin/pip install -q argon2-cffi cryptography python-docx formulas numpy pandas openpyxl python-pptx psd-tools shapely svgelements pypdf==6.21.0 vobject==0.9.9 pocketsphinx==5.1.1 \
    readability-lxml openlocationcode pproxy==2.7.9 websockets==13.1 geographiclib gpxpy pypac==0.19.0 asyncssh bcrypt paramiko \
    msoffcrypto-tool==6.0.0 olefile lxml pypdfium2==5.14.0 pikepdf==10.17.0 pymupdf piexif av mutagen
# TT52 test-only PDF oracles: pypdfium2 (BSD-3/Apache-2.0 bindings to PDFium, Chrome's PDF engine — structure, text and
# render references) and pikepdf (MPL-2.0 bindings to qpdf, Apache-2.0 — structural validity checks of the files our editor
# writes). msoffcrypto-tool/olefile/lxml (TT46–TT51 office oracles) were installed by hand until TT52. None ships in Fusion.
# TT44 test-only SSH oracles: asyncssh (EPL-2.0/GPL-2.0 — an independent SSH-2 + SFTP server; its ML-KEM comes from cryptography's
# OpenSSL), bcrypt (Apache-2.0, bcrypt_pbkdf oracle), paramiko (LGPL, key-format cross-check). None ships in Fusion.
# TT36/TT37 test-only oracles: readability-lxml (Apache-2.0, reader-view oracle), openlocationcode (Apache-2.0, Plus Codes
# reference), pproxy (MIT, an independent SOCKS5 / HTTP CONNECT server for the network-route tests), websockets (BSD-3, an independent RFC 6455 server for the WebSocket tests), geographiclib (MIT) and gpxpy (Apache-2.0) — the TT34 geodesy / GPX oracles, missing from this list until TT38; pypac (Apache-2.0, runs PAC files in Duktape via dukpy, MIT) — the TT39 PAC differential oracle. None ships in Fusion.
# pocketsphinx (CMU BSD-style licence, wheel bundles the en-us acoustic model + CMUdict) is the TEST-ONLY speech-recognition oracle for
# Fusion Voice (scripts/oracle/asr.py, scripts/tt32-voice.mts, scripts/e2e-tt32.mts). Nothing from it ships in Fusion.
# TT40 test-only oracle: the npm `socks` client (MIT) — its SOCKS4 / SOCKS4a request bytes are the differential
# reference for wp-tunnel's own (pproxy's SOCKS4 server has no 4a). Installed outside the repo; never imported by Fusion.
mkdir -p "$TOOLS/oracle-npm" && ( cd "$TOOLS/oracle-npm" && { test -f package.json || echo '{"name":"oracle","private":true}' > package.json; } && \
  { test -f node_modules/socks/package.json || npm install --no-audit --no-fund socks@2.8.10 >/dev/null; } )
node "$REPO/scripts/sandbox/pg-start.mjs"
cd "$REPO"
# TT67's historical regression test executes the actual TT66 matcher; a
# shallow checkout needs this pinned commit, without changing the branch.
if ! git cat-file -e '2edf69917615249efcc45318308efc93ebe2d65d^{commit}' 2>/dev/null; then
  git fetch --no-tags --depth=1 origin 2edf69917615249efcc45318308efc93ebe2d65d
fi
npx drizzle-kit push --dialect postgresql --schema ./src/db/schema.ts --url "$DATABASE_URL" --force >/dev/null
# Unpack Chromium once so /tmp/al2023/lib (its NSS libs) exists for LD_LIBRARY_PATH.
AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x node -e "const m=require('$TOOLS/node_modules/@sparticuz/chromium'); (m.default??m).executablePath().then(p=>console.log('chromium', p))"
echo "bootstrap ok"
