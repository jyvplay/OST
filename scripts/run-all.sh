#!/usr/bin/env bash
# Run test suites sequentially against a running server and print a compact summary per suite.
# Usage: SUITES="unit e2e ..." BASE=http://localhost:3999 bash scripts/run-all.sh
# Each suite writes its full results to docs/test-results/<suite>.json (the source of truth);
# this wrapper only filters the console output so long failure traces do not flood the log.
cd "$(dirname "$0")/.." || exit 1
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
export AWS_EXECUTION_ENV="${AWS_EXECUTION_ENV:-AWS_Lambda_nodejs22.x}"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-/tmp/al2023/lib:/tmp}"
export BASE="${BASE:-http://localhost:3999}"
ALL="unit integration office-engine oracle-parity oracle-xlsx sheet-layout names image-engine oracle-psd vector-engine vector-boolean oracle-svg browser-session privacy-crypto privacy-layer metaclean privacy-backup a11y-unit tables-engine whiteboard-engine ai-format oracle-ai contacts-engine oracle-vcard layout-unit tabletop-unit stream-unit maps-unit tt28-unit tt29-unit e2e e2e-office e2e-image e2e-vector e2e-browser e2e-privacy e2e-sheet-layout e2e-a11y e2e-tables e2e-whiteboard e2e-ai e2e-contacts e2e-layout e2e-tabletop e2e-media27 e2e-tt28 e2e-tt29 tt30-unit e2e-tt30 tt31-unit e2e-tt31 tt32-voice e2e-tt32 tt33-unit e2e-tt33 tt34-unit e2e-tt34 tt35-unit e2e-tt35 tt36-unit e2e-tt36 tt37-unit e2e-tt37 e2e-beauty tt38-unit e2e-tt38 tt39-unit tt39-pac e2e-tt39 tt40-unit tt40-proxy e2e-tt40 tt41-unit e2e-tt41 tt42-unit tt42-proxy tt42-dhcp e2e-tt42 tt43-unit e2e-tt43 tt44-unit tt44-vt tt44-bridge e2e-tt44 tt45-unit e2e-tt45 tt46-writer e2e-tt46 tt46-xlsx-patch tt47-sheet tt47-crypto e2e-tt47 tt48-office e2e-tt48 e2e-tt48-sync tt49-sheet e2e-tt49 tt49-writer e2e-tt49-writer tt50-charts e2e-tt50-charts tt51-slides e2e-tt51-slides tt52-pdf e2e-tt52-pdf tt53-media e2e-tt53-media tt54-meta e2e-tt54 tt55-files-unit e2e-tt55-files e2e-tt55-shell tt56-writer-track tt56-shell-unit tt56-sheet-paste e2e-tt56 e2e-tt56-rows tt57-writer-fmt tt57-writer-para tt57-sheet-links tt57-units e2e-tt57 e2e-tt57-rows tt58-writer-notes tt58-sheet-pivot e2e-tt58 e2e-tt58-rows tt59-writer-spell tt59-sheet-spell tt59-sheet-paste tt59-x14-cf tt59-raster e2e-tt59 tt60-writer-tblrev tt60-sheet-spell-all tt60-writer-spell-stories tt60-units e2e-tt60 tt61-writer-notes-rich tt61-writer-cellrev tt62-writer-schema tt62-sheet-schema tt62-writer-cellmerge tt61-sheet-pivot-delete e2e-tt61 e2e-tt62 tt63-sheet-pivotparts e2e-tt63 tt64-writer-trackcols e2e-tt64 tt65-writer-stories e2e-tt65 tt66-sheet-x14-patch tt66-input e2e-tt66 e2e-tt66-input tt67-input tt67-sheet-ns e2e-tt67-input tt68-blank e2e-tt68-sheet tt69-lifecycle tt69-sheet-misc e2e-tt69-lifecycle tt70-seal e2e-tt70-seal e2e-tt70-closeall tt70-range tt70-edge e2e-tt70-rows tt71-focus e2e-tt71-focus tt72-office tt72-padlink e2e-tt72-pad tt72-access e2e-tt72-access tt73-office tt74-office e2e-tt73-writer e2e-tt74-office tt75-office tt75-epub e2e-tt75-books tt76-sheet e2e-tt76-sheet tt76-slides e2e-tt76-slides tt77-pdf tt77-pdf-composite tt77-pdfsig e2e-tt77-pdfsig tt78-sheet e2e-tt78-sheet tt79-archive e2e-tt79-archive"
# TT23: a suite that crashes before printing its summary used to show only its "=== name" header and the run still
# ended EXIT 0 (metaclean + e2e-privacy silently crashed on a missing python-docx). Now it is reported and counted.
crashed=""
for s in ${SUITES:-$ALL}; do
  echo "=== $s"
  out=$(timeout 1200 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1)
  echo "$out" | grep -E "✗|passed, |FAILED" -A3 | head -40
  if ! echo "$out" | grep -qE "[0-9]+ passed, [0-9]+ failed"; then
    echo "CRASHED $s (no summary line) — last lines:"; echo "$out" | tail -6; crashed="$crashed $s"
  fi
done
[ -n "$crashed" ] && echo "CRASHED SUITES:$crashed"
echo ALLDONE
