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
ALL="unit integration office-engine oracle-parity oracle-xlsx sheet-layout names image-engine oracle-psd vector-engine vector-boolean oracle-svg browser-session privacy-crypto privacy-layer metaclean privacy-backup a11y-unit tables-engine whiteboard-engine ai-format oracle-ai contacts-engine oracle-vcard layout-unit tabletop-unit stream-unit maps-unit tt28-unit tt29-unit e2e e2e-office e2e-image e2e-vector e2e-browser e2e-privacy e2e-sheet-layout e2e-a11y e2e-tables e2e-whiteboard e2e-ai e2e-contacts e2e-layout e2e-tabletop e2e-media27 e2e-tt28 e2e-tt29 tt30-unit e2e-tt30 e2e-beauty"
# TT23: a suite that crashes before printing its summary used to show only its "=== name" header and the run still
# ended EXIT 0 (metaclean + e2e-privacy silently crashed on a missing python-docx). Now it is reported and counted.
crashed=""
for s in ${SUITES:-$ALL}; do
  echo "=== $s"
  out=$(timeout 1200 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1)
  echo "$out" | grep -E "✗|passed, |FAILED" -A3 | head -40
  if ! echo "$out" | grep -qE "[0-9]+ passed, [0-9]+ failed"; then
    echo "CRASHED $s (no summary line) — last lines:"; echo "$out" | tail -6; crashed="$crashed $s"
  fi
done
[ -n "$crashed" ] && echo "CRASHED SUITES:$crashed"
echo ALLDONE
