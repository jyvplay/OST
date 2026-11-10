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
# The QR decoder is an independent Python oracle; share the configured oracle environment by default.
export TOOLS_DIR="${TOOLS_DIR:-/home/user/tools}"
export QR_PYTHON="${QR_PYTHON:-${ORACLE_PY:-/home/user/tools/venv/bin/python}}"
cd "$(dirname "$0")/.." || exit 1

PURE="tt158-entry-token tt157-routine-triggers tt155-window-fit tt151-qr tt151-time tt137-recall-engines tt137-system-engines tt135-core-engines tt135-text-encoding tt135-files-engines tt135-system-engines tt134-workflows-core tt133-core tt133-projections tt132-core tt132-claim-contract tt132-lint-contract unit a11y-unit layout-unit maps-unit stream-unit tabletop-unit contacts-engine image-engine vector-engine whiteboard-engine tables-engine ai-format tt117-core tt118-core tt119-core tt120-core tt121-core tt122-core tt123-core tt124-core tt125-core tt128-core tt129-core tt129-worker-unit tt129-calendar-core tt130-alarms-core tt130-privacy-boot tt85-inventory tt139-formulas tt139-documents tt139-systems tt139-media tt139-cast-governor tt140-glyph-geometry tt140-cast-privacy tt141-gamepad-pointer tt141-coverage-keys tt141-seed-unique tt141-auto-frame tt142-voice-gate tt142-input-scan tt142-share-gate tt142-a11y-gate tt143-safe-save tt146-core tt146-net-quality tt146-oracle tt147-core tt148-core"
LANE_A="e2e-tt161-lazy-thumbnail tt160-automation-concurrency tt159-settle-race e2e-tt158-planner e2e-tt157-routines e2e-tt156-monitor e2e-layout e2e-tt155-files e2e-tt155-window-fit e2e-tt154-recovery e2e-tt151 e2e-tt69-lifecycle e2e-tt70-seal tt134-workflows-http e2e-tt134-workflows-notes e2e-tt134-workflows-clipboard e2e-tt134-workflows-find tt133-http tt133-browser-kernels e2e-tt133-notes-find e2e-tt133-boundaries e2e-tt134-ownership tt134-icon-review tt134-review-repairs integration e2e-office e2e-sheet-layout e2e-vector e2e-tt81 e2e-tt49-writer e2e-tt73-writer tt132-oracles tt132-planner-http e2e-tt132-alarms e2e-tt132-planner tt131-ledger e2e-tt131-image-viewport e2e-tt130-privacy e2e-tt130-alarms e2e-tt129-offline e2e-tt129-calendar tt128-calendar-race tt128-writer-races e2e-tt128-worker e2e-tt128-photos e2e-tt128-time e2e-tt128-editor tt124-core e2e-tt124 e2e-tt125 e2e-tt126 tt127-conditional e2e-tt127-vault e2e-tt127-photos tt123-core e2e-tt123 tt122-core e2e-tt122 e2e-tt121 tt120-core e2e-tt120 e2e-tt119 e2e-tt117 e2e-a11y tt146-http e2e-tt146 e2e-tt147 e2e-tt148"
LANE_B="tt124-density tt125-density tt123-density tt122-density tt121-density tt120-density tt119-density tt118-density tt117-density tt116-density"

if [ "${TT89_DISPOSABLE_DATABASE:-}" != "1" ]; then
  echo "REFUSED: set TT89_DISPOSABLE_DATABASE=1 only for an exclusive disposable server/database."
  exit 2
fi
# A parent-provided root is NOT an invocation ID. Nested runner-contract
# checks must never truncate the real gate's receipts (or create sparse holes).
LOG_ROOT="${GATE_LOG_DIR:-.cache/gate/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p -- "$LOG_ROOT" || exit 2
LOG_DIR="$(mktemp -d "$LOG_ROOT/run-$$-XXXXXX")" || exit 2
echo "Full suite logs: $LOG_DIR"
echo "== independent test-tool and pinned-corpus prerequisites"
node scripts/gate-prerequisites.mjs >"$LOG_DIR/prerequisites.log" 2>&1 || { cat "$LOG_DIR/prerequisites.log"; echo "GATE FAILED (prerequisites)"; exit 1; }
cat "$LOG_DIR/prerequisites.log"
echo "== TT133/TT134 scripts semantic typecheck (root tsconfig does not include .mts)"
node node_modules/typescript/bin/tsc --project scripts/tsconfig-tt134.json || { echo "GATE FAILED (script types)"; exit 1; }
echo "== pure suites (parallel via run-fast.sh)"
FAST_LOG_DIR="$LOG_DIR/pure" JOBS="${JOBS:-2}" bash scripts/run-fast.sh $PURE "$@" || { echo "GATE FAILED (pure)"; exit 1; }
node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt126-regressions.mts >"$LOG_DIR/tt126-regressions.log" 2>&1 || { cat "$LOG_DIR/tt126-regressions.log"; echo "GATE FAILED (TT126 regressions)"; exit 1; }
cat "$LOG_DIR/tt126-regressions.log"

if [ -z "${BASE:-}" ] || [ -z "${DATABASE_URL:-}" ]; then
  echo "REFUSED: BASE and DATABASE_URL must point at the disposable gate server (see run-all.sh)"
  exit 2
fi
curl -sf -m 5 "$BASE/api/health" >/dev/null 2>&1 || curl -sf -m 5 "$BASE/" >/dev/null 2>&1 || { echo "REFUSED: no server answering at $BASE"; exit 2; }

failed=""
for s in $LANE_A $LANE_B; do
  echo "== $s"
  status=0
  log="$LOG_DIR/$s.log"
  timeout 1200 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" >"$log" 2>&1 || status=$?
  grep -E "passed, |FAILED:" "$log" | tail -2
  if [ "$status" -ne 0 ] || ! grep -qE "[0-9]+ passed, 0 failed" "$log" || grep -qE "[1-9][0-9]* failed" "$log"; then
    failed="$failed $s"
    echo "Exit $status; full diagnostics: $log"
    tail -60 "$log"
  fi
done
[ -n "$failed" ] && { echo "GATE FAILED (browser):$failed"; exit 1; }
echo "GATE PASSED"
