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
ALL="unit integration office-engine oracle-parity oracle-xlsx sheet-layout names image-engine oracle-psd vector-engine vector-boolean oracle-svg browser-session privacy-crypto privacy-layer metaclean privacy-backup a11y-unit tables-engine e2e e2e-office e2e-image e2e-vector e2e-browser e2e-privacy e2e-sheet-layout e2e-a11y e2e-tables"
for s in ${SUITES:-$ALL}; do
  echo "=== $s"
  timeout 1200 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1 \
    | grep -E "✗|passed, |FAILED" -A3 | head -40
done
echo ALLDONE
