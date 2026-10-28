#!/usr/bin/env bash
# Run test suites sequentially against a running server and print a compact summary per suite.
# Usage: SUITES="unit e2e ..." BASE=http://localhost:3999 bash scripts/run-all.sh
# Each suite writes its full results to docs/test-results/<suite>.json (the source of truth);
# this wrapper only filters the console output so long failure traces do not flood the log.
cd "$(dirname "$0")/.." || exit 1
if [ "${TT89_DISPOSABLE_DATABASE:-0}" = "1" ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "Refusing disposable-mode suites without an explicit matching DATABASE_URL." >&2
  exit 2
fi
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
export AWS_EXECUTION_ENV="${AWS_EXECUTION_ENV:-AWS_Lambda_nodejs22.x}"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-/tmp/al2023/lib:/tmp}"
export BASE="${BASE:-http://localhost:3999}"
ALL="unit integration office-engine oracle-parity oracle-xlsx sheet-layout names image-engine oracle-psd vector-engine vector-boolean oracle-svg browser-session privacy-crypto privacy-layer metaclean a11y-unit tables-engine whiteboard-engine ai-format oracle-ai contacts-engine oracle-vcard layout-unit tabletop-unit stream-unit maps-unit tt28-unit tt29-unit e2e e2e-office e2e-image e2e-vector e2e-browser e2e-sheet-layout e2e-a11y e2e-tables e2e-whiteboard e2e-ai e2e-contacts e2e-layout e2e-tabletop e2e-media27 e2e-tt28 e2e-tt29 tt30-unit e2e-tt30 tt31-unit e2e-tt31 tt32-voice e2e-tt32 tt33-unit e2e-tt33 tt34-unit e2e-tt34 tt35-unit e2e-tt35 tt36-unit e2e-tt36 tt37-unit e2e-tt37 e2e-beauty tt38-unit e2e-tt38 tt39-unit tt39-pac e2e-tt39 tt40-unit tt40-proxy e2e-tt40 tt41-unit e2e-tt41 tt42-unit tt42-proxy tt42-dhcp e2e-tt42 tt43-unit e2e-tt43 tt44-unit tt44-vt tt44-bridge e2e-tt44 tt45-unit e2e-tt45 tt46-writer e2e-tt46 tt46-xlsx-patch tt47-sheet tt47-crypto e2e-tt47 tt48-office e2e-tt48 e2e-tt48-sync tt49-sheet e2e-tt49 tt49-writer e2e-tt49-writer tt50-charts e2e-tt50-charts tt51-slides e2e-tt51-slides tt52-pdf e2e-tt52-pdf tt53-media e2e-tt53-media tt54-meta tt55-files-unit e2e-tt55-files e2e-tt55-shell tt56-writer-track tt56-shell-unit tt56-sheet-paste e2e-tt56 e2e-tt56-rows tt57-writer-fmt tt57-writer-para tt57-sheet-links tt57-units e2e-tt57 e2e-tt57-rows tt58-writer-notes tt58-sheet-pivot e2e-tt58 e2e-tt58-rows tt59-writer-spell tt59-sheet-spell tt59-sheet-paste tt59-x14-cf tt59-raster e2e-tt59 tt60-writer-tblrev tt60-sheet-spell-all tt60-writer-spell-stories tt60-units e2e-tt60 tt61-writer-notes-rich tt61-writer-cellrev tt62-writer-schema tt62-sheet-schema tt62-writer-cellmerge tt61-sheet-pivot-delete e2e-tt61 e2e-tt62 tt63-sheet-pivotparts e2e-tt63 tt64-writer-trackcols e2e-tt64 tt65-writer-stories e2e-tt65 tt66-sheet-x14-patch tt66-input e2e-tt66 e2e-tt66-input tt67-input tt67-sheet-ns e2e-tt67-input tt68-blank e2e-tt68-sheet tt69-lifecycle tt69-sheet-misc e2e-tt69-lifecycle tt70-seal e2e-tt70-seal e2e-tt70-closeall tt70-range tt70-edge e2e-tt70-rows tt71-focus e2e-tt71-focus tt72-office tt72-padlink e2e-tt72-pad tt72-access e2e-tt72-access tt73-office tt74-office e2e-tt73-writer e2e-tt74-office tt75-office tt75-epub e2e-tt75-books tt76-sheet e2e-tt76-sheet tt76-slides e2e-tt76-slides tt77-pdf tt77-pdf-composite tt77-pdfsig e2e-tt77-pdfsig tt78-sheet e2e-tt78-sheet tt79-archive e2e-tt79-archive tt79-pdf e2e-tt79-pdf tt79-sheet tt80-banner tt81-core e2e-tt81 tt84-wordcount tt85-find tt85-inventory tt85-identity e2e-tt85 tt85-mutants tt86-pointer e2e-tt86-pointer tt86-mutants tt87-backup tt87-transaction e2e-tt87-backup e2e-tt87-localdisk e2e-tt87-privacy tt87-pointer-queue e2e-tt87-pointer-fallback tt88-recovery e2e-tt88-recovery tt89-drill-health tt89-launch-unit tt90-context-unit tt90-worker-pool tt90-private-thumb-path"
ALL="$ALL tt91-browser-download tt92-ledger-audit tt92-ledger-policy tt96-programmer tt96-calc-history tt96-scientific-units tt97-palette-commands tt97-svg-attributes"
# The privacy and TT89–TT94 browser/race tests alter disposable data; one suite revokes DB TEMP temporarily,
# and the private-thumbnail and race suites deliberately clear the disposable thumbnail cache.
# Include them only after an operator explicitly confirms this is a disposable environment.
if [ "${TT89_DISPOSABLE_DATABASE:-0}" = "1" ]; then
  ALL="$ALL tt87-backup-http privacy-backup e2e-privacy tt89-test-safety tt89-drill-db tt89-drill-http e2e-tt89-drill e2e-tt89-launch e2e-tt90-context e2e-tt90-thumbnails e2e-tt90-private-thumbnails tt91-thumbnail-cleanup-race tt91-purge tt91-purge-race tt91-write-atomic e2e-tt91-purge e2e-tt91-browser-download tt92-trash tt92-trash-race e2e-tt92-trash e2e-tt54 tt93-transfer tt93-transfer-race tt93-restore-race tt93-metadata-race e2e-tt93-sidecar e2e-tt93-photos-clear tt94-photo-guard tt94-photo-guard-race e2e-tt94-photo-stale e2e-tt94-photos-offline e2e-tt94-offline-race tt95-photo-concurrency tt95-photo-race e2e-tt95-photo-concurrency tt95-calculator-audit e2e-tt95-a11y-settings-race e2e-tt96-calculator e2e-tt96-desktop-menu e2e-tt96-files-contrast e2e-tt97-calculator-repairs e2e-tt97-palette-actions e2e-tt97-files-empty-a11y e2e-tt98-orbit e2e-tt99-interactions e2e-tt100-recall tt101-search e2e-tt101-search tt102-search tt102-private-bound e2e-tt102 tt103-memory-unit e2e-tt103-memory tt103-framework tt104-memory-unit tt104-page e2e-tt104-memory e2e-tt104-pages tt105-atomic e2e-tt105-clicked"
fi
# TT23: a suite that crashes before printing its summary used to show only its "=== name" header and the run still
# ended EXIT 0 (metaclean + e2e-privacy silently crashed on a missing python-docx). Now it is reported and counted.
crashed=""
failed=""
for s in ${SUITES:-$ALL}; do
  echo "=== $s"
  if [ "$s" = "tt85-mutants" ]; then
    status=0
    out=$(timeout 1200 python3 scripts/tt85-mutants.py 2>&1) || status=$?
    echo "$out" | grep -E "KILLED|SURVIVED|Mutants:" -A2 | head -40
    if ! echo "$out" | grep -qE "Mutants: [0-9]+/[0-9]+ killed"; then crashed="$crashed $s"; fi
    if [ "$status" -ne 0 ]; then failed="$failed $s"; fi
    continue
  fi
  if [ "$s" = "tt86-mutants" ]; then
    status=0
    out=$(timeout 1200 python3 scripts/tt86-pointer-mutants.py 2>&1) || status=$?
    echo "$out" | grep -E "KILLED|SURVIVED|Mutants:" -A2 | head -40
    if ! echo "$out" | grep -qE "Mutants: [0-9]+/[0-9]+ killed"; then crashed="$crashed $s"; fi
    if [ "$status" -ne 0 ]; then failed="$failed $s"; fi
    continue
  fi
  if [ "$s" = "tt87-mutants" ]; then
    # Server-source mutations need a development server; a production build cannot see source edits.
    status=0
    out=$(timeout 1200 python3 scripts/tt87-mutants.py 2>&1) || status=$?
    echo "$out" | grep -E "KILLED|SURVIVED|CRASHED|Mutants:" -A2 | head -50
    if ! echo "$out" | grep -qE "Mutants: [0-9]+/[0-9]+ killed"; then crashed="$crashed $s"; fi
    if [ "$status" -ne 0 ]; then failed="$failed $s"; fi
    continue
  fi
  if [ "$s" = "tt88-mutants" ]; then
    # Client/server source mutations must run against the development server.
    status=0
    out=$(timeout 1200 python3 scripts/tt88-mutants.py 2>&1) || status=$?
    echo "$out" | grep -E "KILLED|SURVIVED|CRASHED|Mutants:" -A2 | head -50
    if ! echo "$out" | grep -qE "Mutants: [0-9]+/[0-9]+ killed"; then crashed="$crashed $s"; fi
    if [ "$status" -ne 0 ]; then failed="$failed $s"; fi
    continue
  fi
  if [ "$s" = "tt89-mutants" ] || [ "$s" = "tt89-launch-mutants" ] || [ "$s" = "tt90-mutants" ]; then
    # Source mutations are safe only against a disposable database and a development server.
    status=0
    out=$(timeout 1200 python3 "scripts/$s.py" 2>&1) || status=$?
    echo "$out" | grep -E "KILLED|SURVIVED|CRASHED|Mutants:" -A2 | head -60
    if ! echo "$out" | grep -qE "Mutants: [0-9]+/[0-9]+ killed"; then crashed="$crashed $s"; fi
    if [ "$status" -ne 0 ]; then failed="$failed $s"; fi
    continue
  fi
  if [ "$s" = "tt91-purge-mutants" ] || [ "$s" = "tt91-purge-race-mutants" ] || [ "$s" = "tt91-race-mutants" ] || [ "$s" = "tt91-write-mutants" ] || [ "$s" = "tt91-download-mutants" ] || [ "$s" = "tt92-trash-mutants" ] || [ "$s" = "tt93-transfer-mutants" ] || [ "$s" = "tt94-photo-mutants" ] || [ "$s" = "tt95-photo-mutants" ]; then
    # These scripts require both explicit opt-ins and a matching disposable source-watching server.
    status=0
    out=$(timeout 1200 python3 "scripts/$s.py" 2>&1) || status=$?
    echo "$out" | grep -E "KILLED|SURVIVED|CRASHED|Mutants:" -A2 | head -80
    if ! echo "$out" | grep -qE "Mutants: [0-9]+/[0-9]+ killed"; then crashed="$crashed $s"; fi
    if [ "$status" -ne 0 ]; then failed="$failed $s"; fi
    continue
  fi
  if [ "$s" = "e2e-tt87-pointer-fallback" ]; then
    status=0
    out=$(POINTER_EVENT_SOURCE=pointermove timeout 1200 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt86-pointer.mts 2>&1) || status=$?
    if [ "$status" -ne 0 ] || echo "$out" | grep -qE "[1-9][0-9]* failed"; then failed="$failed $s"; fi
    echo "$out" | grep -E "✗|passed, |FAILED" -A3 | head -40
    if ! echo "$out" | grep -qE "[0-9]+ passed, [0-9]+ failed"; then echo "CRASHED $s (no summary line)"; echo "$out" | tail -6; crashed="$crashed $s"; fi
    continue
  fi
  status=0
  out=$(timeout 1200 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1) || status=$?
  if [ "$status" -ne 0 ] || echo "$out" | grep -qE "[1-9][0-9]* failed"; then failed="$failed $s"; fi
  echo "$out" | grep -E "✗|passed, |FAILED" -A3 | head -40
  if ! echo "$out" | grep -qE "[0-9]+ passed, [0-9]+ failed"; then
    echo "CRASHED $s (no summary line) — last lines:"; echo "$out" | tail -6; crashed="$crashed $s"
  fi
done
[ -n "$crashed" ] && echo "CRASHED SUITES:$crashed"
[ -n "$failed" ] && echo "FAILED SUITES:$failed"
echo ALLDONE
[ -z "$crashed$failed" ]
