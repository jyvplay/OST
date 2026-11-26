# TT228 — probe ownership across proxy navigation

## Scope, model, and evidence threshold

A Browser tab has a URL, optional framing verdict and direct-frame choice. A proxy document may report a navigation while an earlier asynchronous embed probe is pending or already complete. Under the tested contract, when that tab reports a **different URL**, its earlier verdict and direct-frame choice must not authorize a direct browser request for the new URL; a fresh probe must be able to run without waiting for an old probe. Browser requests are counted in Chromium, separately from the server's probe and proxy requests. The real HTTP fixture and exclusive disposable PostgreSQL/Next app are on loopback; Chromium 143 is the browser. A successful probe with no restrictions is still allowed to load directly, so this is not a blanket no-network privacy guarantee.

H+: ownership can be scoped by tab and navigation generation. Evidence threshold: a pre-patch network-request counterexample; build and component lint; post-patch real-browser retest and a new delayed old-probe attack, plus existing framing regressions. H−: a direct iframe cannot make an independently enforced framing policy permit embedding; that is a different task from stale state prevention. H∂: browser behavior and content depend on actual redirects, CSP and ancestor chain; server probing is itself network access. React documents that asynchronous responses may arrive out of order and need stale-response handling ([React documentation](https://react.dev/reference/react/useEffect)). This is guidance, not a proof of this implementation or browser-policy completeness.

## Construction and measurements

The proxy navigation callback now clears URL-bound verdict/reason/host and the prior direct choice on an actual URL change. A transient per-tab generation increments on each such navigation; it is neither restored nor persisted. In-flight probe deduplication is keyed by tab and generation, and completion checks tab, URL and generation. Other selected modes and profiles are retained. An unchanged reported URL does not reset state.

Before patch, the actual browser sent **one** direct request to `/restricted` after a proxy navigation, while the UI reused the prior `/open` verdict (test 0/1). After patch, the fresh-verdict and pending-probe attacks initially passed 2/2, and TT226 passed 5/5. Two additional attacks for direct-choice transfer and A→B→A were then added; the expanded suite passed 4/4. The delayed test holds a real server response to the old probe, navigates via the actual proxy, switches proxy-all off and checks the new restriction while the old response is held, then releases it. Timing observations are bounded examples, not universal concurrency proof. Build and ESLint passed.

Separate loopback tests require `FUSION_WP_TEST_LOOPBACK_PORTS=4043 FUSION_WP_OS_PROXY=0` on a **loopback-only test server**, plus `TT222_LOOPBACK_FIXTURE=1 TT89_DISPOSABLE_DATABASE=1 DATABASE_URL=... BASE=http://127.0.0.1:4002 bash scripts/gate-child.sh 100 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt228-proxy-verdict.mts`. Do not enable the loopback allowance on the normal app server. This isolated suite is not in the standard gate.

## Independent mechanisms and adversaries

| Candidate and artifact | Established / construction | Attack and remaining gap |
|---|---|---|
| Per-tab navigation generation: Browser implementation | Real stale and delayed cases above | A→B→A while old A is pending passed in one bounded real-browser run; arbitrary interleavings remain a local gap. |
| Abort old request: design | Reduces unnecessary work if cancellation succeeds | Response may race cancellation; still needs ownership check; local gap, not implemented. |
| Clear verdict only: baseline counterexample and design | Forces another probe after completed old request | In-flight by-tab dedupe may stall fresh probe, old A could return after A→B→A; local gap. |
| Proxy all indefinitely: existing option | Avoids direct-frame request while enabled | Switching it off resurrects stale state in baseline; no general solution for direct mode. |
| Force handoff on every navigation: design | Avoids in-app iframe for changed URL | Breaks intended browser behavior and user choice; adjacent, not accepted. |
| Full browser CSP evaluator: design | Could increase precision of advisory | Ancestors, redirects, policy changes and browser implementation remain; equivalent only to a different classification problem, not stale ownership. |

## Negative space

A build, lint, an iframe node, an iframe load event, a 200 probe response, a successful proxy load, a successful direct load, a single host match, a screenshot, a browser console without errors, a clean unit test, a majority/modal verdict, an old suite pass, identical URL strings after an A→B→A transition, a cancelled fetch alone, a stale response ignored without starting a fresh one, and a successful handoff are not sufficient. A modal shortcut is invalid because a majority of navigation events with correct ownership does not establish the universal per-navigation property; the initial 0/1 real-browser test exposes one minority counterexample. It does not establish coverage of all interleavings.

## Unresolved broader request

The full OS feature space is much larger than this patch's tab-state model. No ten Class-A promotions, all-app visual review, original graphics, or measured Pareto script improvements are claimed. Prior full gate failures and the new full-gate result must be considered separately. No independent agent, theorem prover, simulator or expert review was used. The A→B→A test delays the first A probe until the later A probe and direct frame finish, then checks the old restrictive response is not applied; the 400 ms post-response observation is bounded. A next high-information test would include close/reopen or unmount/replacement during a pending probe and independently identify the eventual response handling.

## Full gate and runtime

The normal full gate `.cache/gate/20261125T064826Z/run-2389675-UyRJEM` exited 1: TT124 Routines 567/300 and Storage 555/480; TT125 Files 375/260; TT123 Files 375/320. Browser-probe TT221, TT134 review, lifecycle and accessibility tests passed (2/2, 8/8, 6/6, 9/9 respectively). Node 22, production Next build, ESLint, Chromium and disposable PostgreSQL were used with two CPUs. No claim of significant speedup or complete Class-A status follows.
