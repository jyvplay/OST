# TT126 — reliability, privacy and verification report

## Scope and model

The admissible system is this checkout's Next.js web application, PostgreSQL
server, browser and service worker. The specifications also describe native
Android mechanisms that a web page does not acquire merely by being installable.
The resource in the speed experiment is elapsed seconds and aggregate child CPU
seconds on this two-vCPU host, for an identical set of fast-lane suites.

For each change below, the intended predicate is: **for every** input in the
specified domain and every supported execution, if the documented preconditions
hold, the observable result has the stated properties; **if not**, the operation
must refuse or report uncertainty rather than declare success. The tests sample
this predicate; they do not prove the universal claim. A Class A designation
would require complete specification, real-device and cross-browser tests,
security review, and passing the full production gate. Those gates were not met
for 20 features, or for the system as a whole. No register rows were promoted.

- H+: the browser-level repairs can work when required APIs and a live server exist.
- H−: a service worker alone cannot turn this server/PostgreSQL application into
  a complete single-file offline OS, or provide Android-only device privileges.
- H∂: camera controls, media permission, browser storage and hardware depend on
  browser and device capabilities. Multi-tab vault concurrency remains unresolved.

## Changes and adversarial interfaces

1. **Vault availability and save:** only an explicit 404 offers creation; a
   failed lookup remains unknown with Retry. Writes use direct requests rather
   than queuing stale ciphertext. The view updates only after a successful
   response; saves are serialized within the component. Lock/hidden invalidates
   pending unlocks and audits and clears the passphrase and displayed state.
   Empty secrets are excluded from reuse checks. *Remaining:* a lost response can
   leave server commit status unknown, and two tabs can still race on the same
   vault because the server lacks atomic compare-and-swap/create-if-absent.
   JS cannot guarantee memory zeroization. Next test: concurrently create and
   edit from two real browser contexts against a version-checked server API.
2. **Camera:** controls remain available while running; stop/unmount stops owned
   camera, screen and processed tracks, and late permission grants are discarded.
   Capability sampling is bounded and invalid grids are refused. Constraints
   are checked against reported settings rather than treating a resolved promise
   as proof. *Remaining:* no physical camera/torch was available; asynchronous
   device settings and interaction between multiple constraints need device tests.
   Image Capture explicitly notes settings can take time to change; Media Capture
   allows unsatisfiable advanced sets to be skipped:
   https://www.w3.org/TR/image-capture/ and https://www.w3.org/TR/mediacapture-streams/.
3. **Terminal:** aliases only resolve own properties; text-based commands use
   the expanded command line rather than slicing the unexpanded input. *Remaining:*
   aliasing is intentionally one-pass, not a shell grammar.
4. **Service worker:** upgrade removes only the app's `fusion-` caches; cache
   reads are scoped to the current cache; only a successful, HTML, unqueried
   `/` navigation can refresh the cached shell. *Remaining:* installation still
   tolerates a failed precache, and server-backed APIs are not offline data.
   Cache Storage provides network resources, not an automatic local database:
   https://web.dev/learn/pwa/service-workers and
   https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/offline.
5. **Test gate:** a browser suite must exit zero as well as report zero failures.
   The regression test drives the actual shell runner with controlled process
   outputs, including a process that prints success then fails. This is a runner
   test, not a claim that a browser or app was exercised by that fixture.
6. **Readability and access:** shortened three visually reviewed Settings descriptions while
   preserving the narrator shortcut and essential operating instructions. The Files
   journal is now a named, keyboard-focusable scroll region. Only the Settings
   screen was visually inspected; this is not an all-app visual audit.

## Negative space / rejected substitutes

The following do **not** establish the requested complete, production-grade OS:
(1) counting buttons as features; (2) a successful TypeScript build alone;
(3) cached HTML presented as offline VFS; (4) a fake camera feed presented as
physical hardware; (5) a resolved optional media constraint presented as a
confirmed setting; (6) unsupported Android privileges presented as web APIs;
(7) masking a password in the UI while persisting plaintext; (8) local hashing
claimed as protection against a compromised client; (9) a failed vault lookup
interpreted as an absent vault; (10) an offline ciphertext queue replayed over a
newer vault; (11) a single-tab lock claimed to solve multi-tab write conflicts;
(12) a test log's success line while its process exits nonzero; (13) a mocked
runner test called a real browser test; (14) a screenshot substituted for an
accessibility audit; (15) a single-browser run claimed as cross-browser coverage;
(16) omitting an external-oracle suite silently and calling coverage unchanged;
(17) prior-turn test artifacts treated as newly executed proof. The modal
shortcut here is item 1: a feature counter can increase while behavior is
unreachable. A real interaction test (such as `e2e-tt126`) detects it by opening
a module and asserting persisted or observable effects rather than presence.

## Actual verification and environment

- Node 22.22.3, TypeScript compiler, Next.js, real Playwright Chromium and a
  disposable real PostgreSQL 17.5 instance were used. Python/Shapely provided
  the external GEOS oracle for vector tests. No independent agents, theorem
  prover, physical camera, or expert security reviewer were used.
- `npm run build` and `npm run typecheck` passed after changes.
- `scripts/tt126-regressions.mts`: 4/4 passed. Its service-worker test uses a
  controlled CacheStorage model; it is not a browser offline test.
- `scripts/e2e-tt126.mts`: 4/4 passed against Chromium, the actual application
  server and disposable DB: alias behavior, encrypted vault create/save/reopen/
  reuse/delete, the no-device camera-control state, and a keyboard/axe check of
  the Files journal. It refuses to touch an
  existing vault and requires explicit disposable-server opt-in.
- `e2e-tt125`: 3/3 passed in the broader gate against the development server.
- The default fast lane ran 22 suites successfully after installing Shapely.
  The external `oracle-ai` suite is **not** part of that set: the previous fast
  default included it despite its network access and therefore refused to run
  at all. It remains available via the sequential runner and was not run here.
- Full `npm run lint` failed with numerous existing repository errors, including
  missing TypeScript ESLint rule definitions and React hook findings. Linting the
  touched source files returned zero errors and one Vault effect-cleanup warning.
  Real offline/device suites were not run.
- The broader `run-gate.sh` was run against the development server and failed:
  `e2e-tt120` had one Photos navigation timeout; `e2e-a11y` had four failures
  (text scale/reflow, live text-size controls, spreadsheet geometry, and an axe
  finding in the Files journal). All ten density suites passed. Failure records
  are preserved in `docs/evidence/tt126-e2e-tt120.json` and
  `docs/evidence/tt126-e2e-a11y.json`. The isolated Photos test subsequently
  passed; its intermittent timeout is not diagnosed. The three text-size tests
  also passed when retried in isolation. After making the journal focusable,
  the 13 styles × two themes axe test passed in isolation and the new focused
  journal test passed. These retries do **not** turn the original full-gate run
  green; it has not been rerun in full after the repair.

## Test speed experiment

After fixing the previously self-refusing fast default, four cold-process runs
with the same 22 suites and warm dependencies were measured sequentially while
the server was otherwise idle. JOBS=1: 19.213, 18.925 s; JOBS=2: 11.355,
11.179 s; JOBS=4: 13.263, 12.916 s. JOBS=2 averaged 11.267 s vs 13.090 s for
JOBS=4 (~14% less wall time); aggregate user+system CPU averaged 20.411 s vs
21.255 s (~4% less). All four JOBS=2/4 runs passed; this is a small local sample,
not a universal performance guarantee. Defaults are now 2, still overrideable.
The comparison does not include the separately required external oracle, browser
lane, or the additional TT126 regression; it is not a claim of faster full-gate
runtime or unchanged coverage relative to a hypothetical successful oracle run.

## Next highest-information work

Implement atomic version-checked vault writes and create-if-absent at the server,
then run two real browser contexts with competing writes and dropped responses.
Test Lens with a physical zoom/torch device, including late permission and unmount;
rerun the full gate, investigate the intermittent Photos and text-scale failures,
and run offline lifecycle tests and cross-browser/accessibility reviews.
A genuinely standalone PWA requires a separately designed local storage and
migration/synchronization architecture, not just more cached assets.

TT127 follow-up: the original default's network-dependent oracle is no longer
omitted; it is scheduled separately after the pure suites and still fails if
unavailable. The earlier benchmark numbers above apply only to the explicitly
listed 22 pure suites, not this restored serial oracle. See `DESIGN-TT127.md`.
