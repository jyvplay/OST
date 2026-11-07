#!/usr/bin/env bash
# Browser-suite lane: suites that drive a real Chromium against one server.
#
# Why this is faster than run-all.sh without losing fidelity:
#   · one Chromium process is shared (browser-launch.sharedChromium) instead of
#     one per suite; a Playwright launch is 1.5–2.5 s of the sandbox's 2 CPUs;
#   · each case still runs in its own incognito BrowserContext, which is the same
#     isolation a fresh browser gives for cookies, caches, storage and service
#     workers — so no suite can observe another's state;
#   · suites run JOBS at a time. They deliberately do NOT share a desktop: each
#     one writes /api/state under its own revision first, and the server's
#     compare-and-set refuses a stale write, so interleaving cannot smuggle a
#     window from one suite into another. A suite that needs the whole machine
#     should be listed in SERIAL below.
#   · the server itself is untouched: no test-only route, no fixture database.
#
# Usage: BASE=http://127.0.0.1:3000 JOBS=2 bash scripts/run-browser.sh [suite ...]
cd "$(dirname "$0")/.." || exit 1
JOBS="${JOBS:-2}"
BASE="${BASE:-http://127.0.0.1:3000}"
# Suites that must not run beside anything else (they assert on global timing or
# on an exclusive resource). Empty today; keep the mechanism so the rule is
# enforced rather than remembered.
SERIAL=""
DEFAULT="tt141-browser tt142-browser tt142-platform"
SUITES="${*:-$DEFAULT}"
for s in $SUITES; do [ -f "scripts/$s.mts" ] || { echo "REFUSED $s: no such suite file" >&2; exit 2; }; done
export BASE
run_one() {
  s="$1"; t0=$(date +%s%N)
  out=$(timeout 900 node --use-system-ca --import ./scripts/register-hook.mjs "scripts/$s.mts" 2>&1); status=$?
  t1=$(date +%s%N)
  if [ "$status" -ne 0 ] || echo "$out" | grep -qE "[1-9][0-9]* failed"; then echo "FAILED $s"; fi
  if ! echo "$out" | grep -qE "[0-9]+ passed, [0-9]+ failed"; then echo "CRASHED $s (no summary line)"; echo "$out" | tail -6; fi
  echo "=== $s $(( (t1 - t0) / 1000000 ))ms"
  echo "$out" | grep -E "✗|passed, " | head -20
}
export -f run_one
export BASE
results=$(printf '%s\n' $SUITES | xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {})
echo "$results"
failed=$(echo "$results" | grep -E "^(FAILED|CRASHED) " || true)
[ -n "$failed" ] && { echo "FAILED SUITES:"; echo "$failed"; }
echo BROWSERDONE
[ -z "$failed" ]
