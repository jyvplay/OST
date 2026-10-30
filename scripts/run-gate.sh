#!/usr/bin/env bash
# TT120 — the per-turn gate, as one reproducible command instead of a hand-
# typed sequence of suite invocations (which cost orchestration time and
# invited ordering mistakes every turn).
#
# Fidelity contract: every suite runs with the exact node invocation
# run-all.sh uses and is judged by its own "<n> passed, <m> failed" summary.
# Nothing is parallelised that shares state: the pure suites go through
# run-fast.sh (which mechanically refuses anything that reaches a server,
# browser, database or network), and the browser suites then run
# sequentially against the one production server, one database, one
# Chromium — the standing rule. If BASE is unset or the server is down,
# the browser half refuses rather than reporting false greens.
#
# Usage: bash scripts/run-gate.sh [extra pure suites...]
set -u
cd "$(dirname "$0")/.." || exit 1

PURE="unit a11y-unit layout-unit maps-unit stream-unit tabletop-unit contacts-engine image-engine vector-engine whiteboard-engine tables-engine ai-format tt117-core tt118-core tt119-core tt120-core"
BROWSER_SUITES="tt120-core e2e-tt120 tt120-density tt119-density e2e-tt119 tt118-density tt117-density e2e-tt117 tt116-density e2e-a11y"

echo "== pure suites (parallel via run-fast.sh)"
JOBS="${JOBS:-4}" bash scripts/run-fast.sh $PURE "$@" || { echo "GATE FAILED (pure)"; exit 1; }

if [ -z "${BASE:-}" ] || [ -z "${DATABASE_URL:-}" ]; then
  echo "REFUSED: BASE and DATABASE_URL must point at the disposable gate server (see run-all.sh)"
  exit 2
fi
curl -sf -m 5 "$BASE/api/health" >/dev/null 2>&1 || curl -sf -m 5 "$BASE/" >/dev/null 2>&1 || { echo "REFUSED: no server answering at $BASE"; exit 2; }

failed=""
for s in $BROWSER_SUITES; do
  echo "== $s"
  out=$(TT89_DISPOSABLE_DATABASE=1 timeout 1200 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1) || true
  echo "$out" | grep -E "passed, |FAILED:" | tail -2
  echo "$out" | grep -qE "[0-9]+ passed, 0 failed" || failed="$failed $s"
done
[ -n "$failed" ] && { echo "GATE FAILED (browser):$failed"; exit 1; }
echo "GATE PASSED"
