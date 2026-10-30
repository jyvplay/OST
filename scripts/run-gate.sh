#!/usr/bin/env bash
# TT120/TT122 — the per-turn gate, as one reproducible command.
#
# Fidelity contract: every suite runs with the exact node invocation
# run-all.sh uses and is judged by its own "<n> passed, <m> failed" summary.
#
# TT122 speed verdict (measured, not assumed): two parallel browser lanes
# (second server + second database) were built and run — total wall time
# was unchanged (~14.5 min vs ~14.0 sequential) and CPU contention on this
# 2-CPU box caused real timeout failures in e2e-a11y. NOT Pareto, so the
# gate stays sequential. The actual win was inside the density suites:
# their fixed 1100-1500ms per-module sleeps are now readiness waits
# (measure only once the window has content, same honest timeout).
#
# Usage: bash scripts/run-gate.sh [extra pure suites...]
# Env: BASE + DATABASE_URL for the disposable gate server (required).
set -u
cd "$(dirname "$0")/.." || exit 1

PURE="unit a11y-unit layout-unit maps-unit stream-unit tabletop-unit contacts-engine image-engine vector-engine whiteboard-engine tables-engine ai-format tt117-core tt118-core tt119-core tt120-core tt121-core tt122-core tt123-core tt124-core tt125-core"
LANE_A="tt124-core e2e-tt124 e2e-tt125 tt123-core e2e-tt123 tt122-core e2e-tt122 e2e-tt121 tt120-core e2e-tt120 e2e-tt119 e2e-tt117 e2e-a11y"
LANE_B="tt124-density tt125-density tt123-density tt122-density tt121-density tt120-density tt119-density tt118-density tt117-density tt116-density"

echo "== pure suites (parallel via run-fast.sh)"
JOBS="${JOBS:-4}" bash scripts/run-fast.sh $PURE "$@" || { echo "GATE FAILED (pure)"; exit 1; }

if [ -z "${BASE:-}" ] || [ -z "${DATABASE_URL:-}" ]; then
  echo "REFUSED: BASE and DATABASE_URL must point at the disposable gate server (see run-all.sh)"
  exit 2
fi
curl -sf -m 5 "$BASE/api/health" >/dev/null 2>&1 || curl -sf -m 5 "$BASE/" >/dev/null 2>&1 || { echo "REFUSED: no server answering at $BASE"; exit 2; }

failed=""
for s in $LANE_A $LANE_B; do
  echo "== $s"
  out=$(TT89_DISPOSABLE_DATABASE=1 timeout 1200 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1) || true
  echo "$out" | grep -E "passed, |FAILED:" | tail -2
  echo "$out" | grep -qE "[0-9]+ passed, 0 failed" || failed="$failed $s"
done
[ -n "$failed" ] && { echo "GATE FAILED (browser):$failed"; exit 1; }
echo "GATE PASSED"
