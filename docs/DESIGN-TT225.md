# TT225 — density fixture error handling

## Runtime and formal scope
One agent used Node 22, Next production server, real HTTP requests, PostgreSQL, Playwright/Chromium, the repository harness and web search. No independent agent, CI service, theorem prover or simulated database was used. Tests require an exclusive disposable server and database. For each density setup request, the checked resource is its HTTP status and JSON `ok` value: non-2xx or `ok:false` must fail the fixture rather than silently measuring a potentially stale window. The three suites also unload their previous page before seeding the next. Success in the finite attacks requires an actual rejected request and unchanged actual row; it does not mean density caps passed, module content finished loading, or all app functionality is correct.

H+: refused fixture writes can be surfaced. H−: unloading a page cannot by itself cancel a keepalive request or isolate shared server state. H∂: guarantees depend on exclusive database use, server responses, in-flight requests and revision ordering. The previous TT224 protection rejects strictly lower revisions only; equal revisions and old writers remain unresolved. No claim is made that any particular earlier density timeout was caused by a pagehide race.

[Playwright documentation](https://playwright.dev/docs/auth) notes that parallel tests modifying server-side state need separate accounts; browser contexts alone do not isolate that state. PostgreSQL row-lock and conflict semantics are discussed in DESIGN-TT224. These sources do not establish this application's full correctness.

## Evidence and corrections
The density scripts' old helper parsed JSON regardless of HTTP status; inspection showed a 409 setup error could be ignored. The shared `densityApi` now checks HTTP status and `ok:false`, with no changes to caps, counted content, module lists or existing settle waits. Two real HTTP attacks verify a stale 409 and out-of-range revision 400 are thrown by the same helper, while the newer row remains intact (2/2). Targeted density results before extracting the same helper were TT124 21/23 (Routines 477/300, Storage 505/480), TT125 2/3 (Files 375/260), TT123 22/23 (Files 375/320). Unloading adds work; no speed or Pareto claim is made.

A proposed browser pagehide test initially reported a database lock wait, but could not reliably distinguish the pagehide PUT from another save. Stronger Playwright request and console observations both timed out. The previously stated pagehide confirmation was withdrawn; the inconclusive test was removed rather than claiming verification. The full gate run containing that test was red. An initial helper edit also failed to parse due to a duplicate `body` variable and was corrected. The next high-information experiment must trace the exact keepalive request through navigation or identify the database session and revision, then verify storage and rehydration; no such proof is claimed here.

## Six approaches and adversaries
1. Original unchecked helper: artifact is old script, local error-propagation gap; real 409 is the falsifier.
2. Checked helper plus page unload: executable code and 400/409 tests; attacker uses a still-running keepalive or equal revision; local isolation gap.
3. Named desktop per fixture: `src/lib/desktop-id.ts` supplies the construction; attacker leaves a stale named row or mutates shared non-desktop tables; local cleanup/integration gap.
4. Fresh database per case: isolated database design, but attacker exploits seed/schema drift and setup failures; operational cost unmeasured.
5. Cooperative external serialization: lock design, attacker uses a lockless writer or kills owner; does not solve non-cooperative writers.
6. Full transactional test environment: requires app-wide transactional binding and controlled external effects; attacker writes via another connection, an architectural gap.

Fifteen misleading outcomes: (1) prompt accepted but no commit, (2) badge says ready with wrong window, (3) HTTP 409 parsed as ordinary JSON, (4) 200 without row verification, (5) browser context mistaken for server isolation, (6) navigation mistaken for keepalive cancellation, (7) row lock attributed to wrong request, (8) self-observing database query, (9) cached statistics snapshot, (10) only one race ordering, (11) equal revision treated as protected, (12) fixture pointed at production data, (13) swallowed readiness timeout called success, (14) looser caps or hidden rows presented as improvement, (15) test-only exception enabled in production, (16) a local pass called universal correctness. A modal acceptance alone cannot satisfy the tests: the real route response and independently queried row are asserted.

This turn does not establish ten Class-A promotions, a comprehensive visual review, original graphics, a measured Pareto improvement or modern OS parity.

## Final gate
After removing the inconclusive pagehide test, the full gate `.cache/gate/20261125T030419Z/run-1738920-B0bhLQ` exited 1: TT225 helper 2/2, TT224 atomic-write 2/2, TT134 8/8, accessibility 9/9. TT124 21/23 (Routines 513/300, Storage 525/480), TT125 2/3 (Files 375/260), TT123 22/23 (Files 375/320). Earlier gate `.cache/gate/20261125T021955Z/run-1499327-Sm0RTM` included the unverified pagehide test and also failed. Main had no commits ahead when fetched. The red gate is not merge-ready evidence.
