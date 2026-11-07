#!/usr/bin/env bash
# TT117 — faster gate for the suites that never touch the server or a browser.
#
# Honesty contract: this does NOT change what any suite tests. Each suite is run
# with the exact node invocation run-all.sh uses, writes the same
# docs/test-results/<suite>.json, and is judged by the same rule (exit status,
# a "<n> failed" scan, and a required "<passed>, <failed>" summary line — a
# suite that crashes before printing its summary is CRASHED, exactly as in
# run-all.sh). The only change is scheduling: pure suites are independent
# processes with no shared state (no server, no database, no Chromium), so
# running JOBS of them at once cannot make one suite's assertions pass or fail
# differently. Server/browser suites are REFUSED here — they keep the
# sequential run-all.sh path, because they share one server and one database.
#
# Usage: JOBS=2 bash scripts/run-fast.sh [suite ...]
# With no arguments, preserve the original default coverage: pure suites run
# in parallel, then oracle-ai runs separately because it can fetch a corpus and
# uses external tools. It fails rather than skips if its dependencies are absent.
# Explicit arguments remain restricted to pure suites.
cd "$(dirname "$0")/.." || exit 1
JOBS="${JOBS:-2}"
case "$JOBS" in ''|*[!0-9]*) echo "JOBS must be a positive integer" >&2; exit 2;; esac
[ "$JOBS" -ge 1 ] || { echo "JOBS must be >= 1" >&2; exit 2; }
# Optional durable full output. Summaries alone hid passing-case diagnostics;
# the gate gives pure runs a distinct directory so repeated lane names cannot
# overwrite these receipts. The provided path is a root, not an invocation ID;
# nested invocations always get a new directory. Assertions and exit rules stay equal.
if [ -n "${FAST_LOG_DIR:-}" ]; then
  FAST_LOG_ROOT="$FAST_LOG_DIR"
  mkdir -p -- "$FAST_LOG_ROOT" || exit 2
  FAST_LOG_DIR="$(mktemp -d "$FAST_LOG_ROOT/run-$$-XXXXXX")" || exit 2
  export FAST_LOG_DIR
  echo "Full pure suite logs: $FAST_LOG_DIR"
fi

DEFAULT="unit a11y-unit layout-unit maps-unit stream-unit tabletop-unit contacts-engine image-engine vector-engine vector-boolean whiteboard-engine tables-engine ai-format tt117-core tt118-core tt119-core tt120-core tt121-core tt122-core tt123-core tt124-core tt125-core tt128-core tt129-core tt129-worker-unit tt129-calendar-core tt130-alarms-core tt130-privacy-boot tt135-core-engines tt135-files-engines tt135-system-engines tt135-text-encoding tt137-recall-engines tt137-system-engines tt139-engines tt139-platform tt143-engines tt85-inventory"
SUITES="${*:-$DEFAULT}"
include_oracle=0
[ "$#" -eq 0 ] && include_oracle=1

# Refuse anything that needs the server, a browser, or a database. The check is
# mechanical (the same markers run-all.sh's environment implies), not a list of
# names we happen to trust today: a suite edited tomorrow to fetch BASE is
# refused here until a human re-reads it.
for s in $SUITES; do
  f="scripts/$s.mts"
  [ -f "$f" ] || { echo "REFUSED $s: no such suite file" >&2; exit 2; }
  # TT142: strip string literals and comments before looking for a real
  # network call. A suite that CLASSIFIES a `javascript:fetch(...)` payload is
  # not itself fetching, and failing it for the word inside a test fixture
  # forced either a weaker suite or a noisier fixture. Only executable code is
  # matched, so the refusal keeps its meaning.
  code=$(sed -E "s/\`[^\`]*\`//g; s/\"[^\"]*\"//g; s/'[^']*'//g; s:^[[:space:]]*//.*::; s:/\*[^*]*\*/::g" "$f")
  if printf '%s' "$code" | grep -qE "process\.env\.BASE|launchChromium|DATABASE_URL|fetch\(|XMLHttpRequest|WebSocket\("; then
    echo "REFUSED $s: it reaches a server, browser, database or network — run it via scripts/run-all.sh" >&2
    exit 2
  fi
done

run_one() {
  s="$1"
  local t0 t1
  t0=$(date +%s%N)
  out=$(timeout 1200 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1)
  status=$?
  t1=$(date +%s%N)
  if [ -n "${FAST_LOG_DIR:-}" ]; then
    printf '%s\n' "$out" >"$FAST_LOG_DIR/$s.log" || { echo "FAILED $s (full log write)"; return; }
  fi
  if [ "$status" -ne 0 ] || echo "$out" | grep -qE "[1-9][0-9]* failed"; then echo "FAILED $s"; fi
  if ! echo "$out" | grep -qE "[0-9]+ passed, [0-9]+ failed"; then echo "CRASHED $s (no summary line)"; echo "$out" | tail -6; fi
  # A dependency that is absent from this sandbox is not a code failure, and
  # calling it one hides the real distinction. It is reported as BLOCKED and
  # still fails the gate (an unverified suite is not a passed suite), but the
  # label says which thing the reader must repair.
  if echo "$out" | grep -qE "ENOENT|MODULE_NOT_FOUND|Cannot find package|command not found"; then
    echo "BLOCKED $s (a dependency is missing in this environment, not a failing assertion)"
  fi
  echo "=== $s $(( (t1 - t0) / 1000000 ))ms"
  echo "$out" | grep -E "✗|passed, " | head -20
}
export -f run_one

results=$(printf '%s\n' $SUITES | xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {})
echo "$results"
failed=$(echo "$results" | grep -E "^(FAILED|CRASHED) " || true)
if [ "$include_oracle" -eq 1 ]; then
  echo "== network-dependent oracle-ai (serial; may fetch its held-out corpus)"
  oracle_result=$(run_one oracle-ai)
  echo "$oracle_result"
  oracle_failed=$(echo "$oracle_result" | grep -E "^(FAILED|CRASHED) " || true)
  [ -n "$oracle_failed" ] && failed="$failed $oracle_failed"
fi
[ -n "$failed" ] && { echo "FAILED SUITES:"; echo "$failed"; }
echo FASTDONE
[ -z "$failed" ]
