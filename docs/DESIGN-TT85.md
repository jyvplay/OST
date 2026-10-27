# TT85 — Apps hub, honest background inventory, bounded proxy Find, and host-scoped proxy identity

**Review date:** 2026-10-26<br>
**Scope:** AP-01, AP-05, PR-07n, and PR-07h, plus the affected proxy, shell, accessibility, and ledger integration.<br>
**Implementation constraint:** original, dependency-free Find code; browser-native APIs for platform observations; no new production dependency.

## Runtime honesty

### Runtimes and tools actually exercised

- Node.js **22.22.3**, TypeScript **5.9.3**, Next.js **16.2.6**, Playwright **1.64.1**, and `axe-core` **4.14.0**.
- PostgreSQL **18.4**, local `app_db`, used by the production build and application. A Node `pg.Client` query returned the live server version.
- Real headless Chromium **143.0.7499.0**, launched by `scripts/browser-launch.mts`. Production E2E suites exercised the live app on `http://localhost:3999` after the final production build, including the PR-07h routes and final feature metadata.
- Production `npm run build`, `npm run typecheck`, and ESLint scoped to changed production files passed. Repository-wide `npm run lint` did **not** pass: the recorded run exited with 185 errors and 19 warnings, including unresolved ESLint rule definitions and React hooks/ref diagnostics. This review does not claim repository-wide lint cleanliness.

### Observed outputs, not capabilities inferred from labels

The final production `scripts/e2e-tt85.mts` run passed **3/3** after the final production build. E1 observed 46 registered Fusion modules, 3 manifest handler declarations, no `beforeinstallprompt` offer, and 0 browser-reported related apps. The zero is not an installed-app count: the manifest declares no related-app relationship, and `getInstalledRelatedApps()` is not a device-wide enumerator. The hub compared its displayed storage usage/quota and display mode with live `navigator.storage.estimate()` and `matchMedia()` results and verified each module launch row against the live registry. E3 used real Chromium against live PyPI: a new session rendered the Desktop shim surface, selecting Mobile changed the page surface and host-aware API, `/sponsors/` stayed Mobile, and clearing the override restored Desktop. A separate site-aware API assertion checked that a different host still resolves to Desktop; that second host was not navigated in Chromium.

E2 observed **1** service-worker registration, **0** periodic-sync tags, and **1/1** measured page callbacks for the planner/routine checks. Its assertions compare registration and tag rows with Chromium's live service-worker APIs. Those callbacks are page-JavaScript callbacks, not operating-system wakes; zero periodic tags is an observation, not proof of future scheduling or of API support in other browsers.

### Explicit non-claims

- No native PWA install prompt was offered in this headless run; no install was claimed or simulated. No OS file-open `LaunchQueue` handoff was exercised.
- No enumeration of arbitrary installed apps or of other apps' jobs was performed. AP-05's Shizuku/other-app inventory remains out of scope and the row stays **partial**.
- No service-worker or periodic-sync execution time is promised. A browser may throttle/suspend page timers, and page counters reset on reload.
- No cross-browser-engine, physical phone, Android Shizuku, or native desktop-app run is represented here.
- PR-07h changes a fixed proxy identity, not the browser/PWA process itself: it does not detect an external display, keyboard, device class, or OS settings. Directly embedded (non-proxy) pages retain the browser's own identity. User-Agent Client Hints and `navigator.userAgentData` are intentionally withheld; complete browser persona parity is not claimed.
- E3 does not claim every PyPI asset loaded: the sandbox returned 502 for separate third-party assets such as `media.ethicalads.io` and the PyPI status API. Those remote-frame failures are outside the identity oracle; the tested PyPI document and proxy navigation did load.
- The full proxy suite's GitHub repository-page test timed out; the sandbox's external-network limitation was not converted into a passing site result. See H.

---

## A. Formal model

### 1. AP-01 — Apps hub (`src/components/modules/Apps.tsx`)

Let `M` be the ordered module registry, `W` the actual web manifest, `B` the browser APIs available in the current secure origin, and `U` the hub's rendered state. The hub's evidence boundary is:

- Each module row and launch target comes from `M`; filtering changes only the visible subset.
- Handler, protocol, share-target, and related-app information is presented as manifest/browser evidence—not as proof that an operating system registered a handler or that an arbitrary application is installed.
- Display mode, origin quota, persistent-storage state, install-event availability, service-worker registrations, and sync tags are read from browser APIs where exposed. Unsupported, empty, and query-failed states are not interchangeable.
- Storage is reported at the browser **origin**. The hub does not invent per-module byte attribution; server-side buckets remain the Storage assistant's responsibility.

**Success predicate:** the hub's rows equal the live registry, a real module can be launched, and every displayed platform fact is either sourced from a live API/manifest or explicitly labeled unavailable/limited. No fabricated install prompt, installed-app list, OS association, or per-module quota is accepted.

### 2. AP-05 — Fusion-owned work inventory (`src/lib/background-inventory.ts`)

The admissible inventory is the three Fusion-owned page jobs `planner-reminders`, `routine-triggers`, and `offline-replay`. For each job, the in-memory state is `(callbacks, lastAt, lastStatus)` plus its fixed definition. `recordBackgroundCallback(id, status)` increments `callbacks` only at a real callback entry; `updateBackgroundStatus` may update the timestamp/status but must not increment it. Returned snapshots are detached, status text is capped at 240 characters, unknown job IDs are ignored, and subscriptions stop notifying after unsubscribe.

Separately, the Apps module reads service-worker registration state and one-off/periodic sync tags from `navigator.serviceWorker.getRegistrations()` and the registration APIs, when exposed. These are read-only observations; the browser controls whether and when work runs. The model excludes other apps' jobs and operating-system wake counts.

**Success predicate:** the implemented Fusion-owned sub-scope reports only its own measured registrations, tags, and page callbacks; UI/API parity is tested; page-only counters are identified as such. This bounded sub-scope being fully tested does **not** promote the feature's overall status: AP-05 remains **B/P4 partial** because the other-app inventory is absent.

### 3. PR-07n — Private-proxy Find (`public/wp-find.js`)

For a proxied top-level document `D` and query `q`, Find builds a transient normalized text index plus source-span segments, derives literal match ranges, and maps those ranges back to DOM text-node offsets. The query and page text stay in the proxy frame. The search uses Unicode default lower-casing and collapses whitespace runs; it can cross inline and block boundaries, counts overlapping matches, and selects a real DOM `Range`.

The scan is bounded to **512 Ki UTF-16 code units** and **50,000 DOM nodes** by default. If either limit is reached, the result is marked truncated; a negative count over a partial prefix is not represented as a complete scan. Hidden/inert/`aria-hidden` and non-text surfaces are excluded. Shadow DOM, nested frames, form-control values, image alt text, canvas pixels, and Unicode canonical-equivalence normalization are not promised.

**Success predicate:** within that explicit boundary, count, ordinal, and selected source range agree in real Chromium; live DOM changes cause a recount without losing the current ordinal; and cap exhaustion is visible to the caller.

### 4. PR-07h — Per-host identity inside the Private proxy

For a proxy session `S` and a canonical target `host` (the URL host, including a non-default port), the effective identity is `S.uaOverrides[host] ?? S.ua`. Browser-created sessions use `S.ua = desktop`; a site without an override is therefore Desktop. A user can explicitly choose Desktop or Mobile for one host, or clear that host back to the default. The session map exists only in process memory, is isolated by session, and holds at most 64 host keys; inserting a 65th distinct key evicts the oldest entry. It is not a persisted profile preference.

The HTTP proxy, preflight builder, raw/reader fetches, injected document shim, and WebSocket handshake select by the actual request target host—not by a UI tab label or a session-global value. The upstream header builder discards the caller's real `User-Agent` and `sec-*` client hints, then supplies one of the fixed shared UA strings, fixed language, and Sec-GPC. The opaque page shim reports the same chosen UA string plus matching `appVersion`, `platform`, and `maxTouchPoints`; it does not expose `navigator.userAgentData`.

**Success predicate:** a local real HTTP listener reached through the production route sees Desktop for one overridden host and the session's Mobile fallback for a different host, regardless of spoofed incoming UA/client-hint headers; the WebSocket bridge's independent local server sees the target-host override even when the session default differs; and live Chromium on PyPI observes the expected page surface across override, same-host navigation, and clear; a separate site-aware API assertion checks another host falls back to Desktop. This proves the bounded string-selection path, not every browser fingerprint surface or physical hardware detection.

## B. Outcome space

- **H+ — achieved for the stated contracts:**
  - AP-01 is **Class A / P2, `built`**, with a passing real-browser E1 covering the live registry, module launch, manifest declarations, browser display/quota observations, and honest installed-app/install-prompt limits.
  - PR-07n is **Class A / P2, `built` and fully tested**. Real-Chromium DOM tests cover normalization, source ranges, visibility, overlap, mutation, and caps; the production proxy Find case also passed.
  - PR-07h is now **Class A / P2, `built`** for the bounded per-host proxy identity contract: five unit tests, a real HTTP-route echo test, an actual WebSocket bridge handshake, and E3 in live Chromium all passed.
  - The Fusion-owned portion of AP-05 is implemented and tested: real Chromium registration/tag observations plus page-local callback accounting. The overall row remains **Class B / P4, `partial`**.
- **H− — not achievable or not claimed by this web build:** arbitrary installed-app enumeration, Shizuku inventory, guaranteed background execution, native installation in a browser that did not offer the prompt, and OS-level file-open testing.
- **H∂ — deliberate boundaries:** Find is prefix-bounded; case conversion is not full Unicode case-folding or normalization; callbacks describe the current JavaScript page only; browser quota is origin-wide; browser manifest declarations are not OS registration evidence; and PR-07h is a fixed spoofed UA surface, not physical display/keyboard sensing, complete UA-CH parity, or a direct-embed identity switch.

The register has **414** rows. This work is not an A-grade review of the entire register.

---

## C. Frontier and resolved blockers

1. **Class-A browser Find (`PR-07n`).** The TT84 follow-up list called out Find as incomplete. TT85 adds a bounded index, exact source mapping, mutation-aware recount, and explicit partial-scan state, and promotes its seed row to Class A / P2 `built` with real-browser tests.
2. **Apps hub (`AP-01`).** The live module registry, module launch, manifest declarations, origin quota, display mode, install-event state, and limited related-app result are now presented together. The UI describes what the browser reports rather than claiming a device inventory. The register row is `built` and fully tested for this bounded contract.
3. **Stale AP-05 seed metadata.** The source feature specification was B/P4 and explicitly excluded other-app inventory, while the prior seed classification was inconsistent. `features-tt85.ts` now aligns the live seed with the source specification: B/P4, partial, with the unimplemented Shizuku portion named.
4. **Privacy and accounting boundary.** Page callback counts are in memory and increment only at callback entry. Status refreshes do not become events, and callback text is bounded. No task/routine payload is added to the inventory record.
5. **Accessibility test boundary.** E1/E2 Axe checks target the Apps module subtree (`[data-testid="app-hub"]`); the separate production `e2e-a11y.mts` suite covers shell/accessibility regressions. This avoids attributing shell chrome to the module-specific check.
6. **External-site frontier.** In the full proxy suite, the PyPI and Find cases passed, but the GitHub repository-page case timed out after 40.694 seconds. The failing result remains visible in the generated ledger; it is not reported as verified success.
7. **PR-07h host selection.** The former session-global selector is replaced by a session-local host map and target-host selection at HTTP and WebSocket boundaries. The browser E3 proves the page-visible path; a local echo server proves real upstream HTTP headers; the independent WebSocket fixture proves the handshake header. No test treats the hardware-detection language in the original request as a browser capability.

No external pages were consulted for PR-07h; its evidence comes from production source, the local real-server tests, and Chromium runs.

Relevant platform references used to set boundaries: [MDN Periodic Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API), [MDN `getInstalledRelatedApps()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getInstalledRelatedApps), and [MDN PWA file handling](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Associate_files_with_your_PWA).

---

## D. Negative space (rejected shapes and failure tests)

The following are not accepted outcomes. Evidence tags identify the direct test, mutation, or browser assertion that rejects each shape.

1. **Match silently misses text split across inline nodes.** Rejected by the live Chromium fixture crossing `<span>`/`<strong>` text (`tt85-find`, test 1).
2. **Match silently misses the separator between block paragraphs.** Rejected by the two-paragraph match in `tt85-find`, test 1.
3. **Hidden-attribute text contributes a hit.** Rejected by `tt85-find`, test 1.
4. **`display:none` text contributes a hit.** Rejected by the hidden/non-text fixture in `tt85-find`, test 1.
5. **`aria-hidden` or `inert` text contributes a hit.** Rejected by that same Chromium fixture; M4 also removes the visibility filter and is killed.
6. **Script/style/template or input/textarea text is indexed as reader-visible prose.** Rejected by `tt85-find`, test 1.
7. **Overlapping `ana` occurrences in `banana` collapse to one hit.** Rejected by `tt85-find`, test 3; M3 is killed.
8. **Reverse search starts at the first match rather than the last.** Rejected by the initial reverse ordinal assertion in `tt85-find`, test 3.
9. **Next/previous fails to wrap through the hit list.** Rejected by the reverse-start and forward-wrap ordinal assertions in `tt85-find`, test 3.
10. **A normalized multi-space run maps one source unit late.** Rejected by exact Range offsets `[4, 26]` and whitespace source span `[15, 18]` in `tt85-find`, test 2; M1 is killed.
11. **Searching for the word after a multi-space run drops its first character.** Rejected by the exact `packages` Range `[18, 26]` in `tt85-find`, test 2.
12. **A pending DOM mutation resets the current hit ordinal before the next key press.** Rejected by the immediate post-mutation `[4 hits, ordinal 3]` assertion in `tt85-find`, test 3; M2 is killed.
13. **A class/style visibility change leaves stale results.** Rejected by the class-hide recount in `tt85-find`, test 4.
14. **Decomposed accent text is changed by normalization so its source selection is wrong.** Rejected by the exact decomposed-string selection assertion in `tt85-find`, test 3.
15. **No-match or empty-query state retains a nonzero match/ordinal.** Rejected by `tt85-find`, test 3.
16. **A hit beyond the text cap is reported as a complete negative result.** Rejected by the explicit `truncated: true` assertion in `tt85-find`, test 4.
17. **A hit beyond the node cap is scanned without bound.** Rejected by the node-capped Chromium cases in `tt85-find`, test 4; M5 removes the effective cap and is killed.
18. **The node cap is reached but the partial-scan marker is omitted.** Rejected by `tt85-find`, test 4; M6 is killed.
19. **A status refresh increments the callback count.** Rejected by `tt85-inventory`, test 2; M7 is killed.
20. **Mutating a returned snapshot changes internal counter state, or an unknown job ID adds a job.** Rejected by `tt85-inventory`, tests 1–2.
21. **An unsubscribed listener receives later updates.** Rejected by `tt85-inventory`, test 3.
22. **A long status string is stored without a bound or inventory records gain payload fields.** Rejected by `tt85-inventory`, test 4 (240-character cap and exact record keys).
23. **The UI invents an install prompt when Chromium did not offer one.** Rejected by E1's disabled-control assertion when no real prompt is captured and by `captureInstallPrompt`, which accepts only the browser event shape.
24. **A zero related-app result is labeled as “no apps installed.”** Rejected by E1, which checks the empty manifest relationship is described as such and asserts the inventory boundary.
25. **Origin quota is represented as per-module bytes.** Rejected by E1's visible origin/per-module scope assertion.
26. **A page callback is called an OS wake or a zero tag count is presented as a schedule.** Rejected by E2's visible disclaimer and no-self-registration assertion.
27. **Selecting Mobile on one site changes every host in the session.** Rejected by the separate-host API assertion in E3, the two-host HTTP-route echo test, and M8.
28. **A second proxy session inherits the first session's override.** Rejected by the session-isolation assertion in `tt85-identity.mts`.
29. **No explicit override is confused with an explicit Desktop override.** Rejected by the `null` versus `"desktop"` assertions in the identity model test and the site-aware API.
30. **A site key with a path, query, fragment, credentials, whitespace, a slash/backslash, or excessive length is stored.** Rejected by malformed-key tests; M9 is killed.
31. **An arbitrary identity such as `tablet` or a non-string value is accepted.** Rejected by identity validation tests.
32. **A 65th host grows the session map without a bound.** Rejected by the 64-entry cap test; M11 is killed.
33. **The oldest host override survives when a new host is inserted beyond the cap.** Rejected by the oldest-entry eviction assertions.
34. **Clearing one host clears the whole map.** Rejected by the second-host persistence assertion; M10 is killed.
35. **Clearing an override leaves the old Mobile identity active.** Rejected by E3's live page reload and site-aware API result.
36. **A host override is shared across sessions or profiles that do not share the session capability.** Rejected by the two-session unit assertion; map lifetime is tied to the in-memory session.
37. **Uppercase host names or the default HTTPS port create a second logical site key.** Rejected by `PYPI.ORG` and `pypi.org:443` normalization assertions.
38. **The real HTTP proxy route uses the global UA or caller-supplied UA instead of the target-host choice.** Rejected by the production route to two real local echo listeners; M13 is killed.
39. **Incoming `sec-ch-ua` is forwarded upstream or a Mobile hint is invented.** Rejected by the route echo test and header-builder assertions; the echoed client-hint field is absent.
40. **A WebSocket handshake uses `s.ua` instead of the WebSocket target host.** Rejected by the independent RFC 6455 fixture with session default Mobile and host override Desktop; M12 is killed.
41. **The page shim reports a different fixed UA/platform/touch surface after a Mobile choice.** Rejected by E3's direct in-frame checks for `userAgent`, `appVersion`, `platform`, and `maxTouchPoints`.
42. **`navigator.userAgentData` is fabricated to imply complete UA-CH parity.** Rejected by E3 (`undefined`) and by absence of the incoming `sec-ch-ua` in HTTP header tests.
43. **The session API returns every hostname override to a caller asking for aggregate stats.** Rejected by `publicStats` unit assertions and E3's aggregate API redaction check.
44. **Directly embedded pages or detected physical peripherals are silently treated as proxy-controlled.** Rejected as an unsupported result shape by the stated contract boundary: only the proxied opaque document and selected target-host request are controlled.

### Modal-shortcut failure test

The existing real-browser regression suite is also part of the stopping gate: in `e2e-tt81.mts` E3, Ctrl+F/Delete/undo while the Save-as modal is open must not act on the underlying editor; in E5, the Word Count modal's single close control retains focus after Tab. A test fails if the modal leaks shortcuts or focus. The suite passed **7/7**; E5 also passed its serious/critical Axe check.

---

## E. Mechanism portfolio

| # | Mechanism | Artifact | Verified portion | Open interface / cheapest falsification | Gap class |
|---|---|---|---|---|---|
| 1 | Registry-backed module discovery and launch | `Apps.tsx`, `src/lib/registry.ts` | Exact 46-row registry parity, filtering, and launching Calculator in E1 | Remove/reorder an ID or make a launch target inert | Integration |
| 2 | Browser-evidence adapter for manifest, display mode, and origin storage | `Apps.tsx`, `/manifest.webmanifest` | E1 compares quota and display mode to live browser APIs and handler declarations to the manifest | Change one manifest declaration/API value and compare rendered output | Browser/platform semantics |
| 3 | Genuine install-event lifecycle | `src/lib/pwa-install.ts`, `Shell.tsx` | No synthetic prompt; availability comes from the actual `beforeinstallprompt` event | Browser offers/dismisses a prompt in a supported desktop profile | Browser/OS UI |
| 4 | Read-only service-worker and sync-tag reconciliation | `Apps.tsx` | E2 compares registration count, scope/worker state, query status, and tag values with Chromium APIs | Alter a registration/tag or force a query rejection | Browser API availability |
| 5 | Page-local callback accounting | `background-inventory.ts`, `ShellDaemons.tsx` | Only callback entry increments; status updates, detached snapshots, bounded text, subscriptions tested | Inject a false increment or retain a listener after unsubscribe | Page lifecycle; not OS scheduling |
| 6 | Normalized text index with source-span map | `public/wp-find.js` | Inline/block joining, collapsed source-whitespace offsets, and exact DOM `Range` in real Chromium | Shift a source boundary or merge the whitespace segment | DOM/text model |
| 7 | Mutation-aware recount preserving search ordinal | `public/wp-find.js` | Pending-mutation search and class visibility change both recount correctly | Reset the ordinal or omit an observed visibility attribute | DOM mutation timing |
| 8 | Hard text/node budgets with explicit truncation | `public/wp-find.js` | Configured text/node caps stop scanning and expose partial results | Remove either guard or suppress the `truncated` flag | Large-document behavior within stated budget |
| 9 | Canonical host-key validation | `wp-sessions.ts:normalizeUaSite` | Case-folding, URL-derived hosts, default-port normalization, and hostile path/query/credential rejection | Fuzz IPv6, IDNA, trailing-dot, malformed-label, and non-default-port inputs | Host syntax vs. user-provided site label; uncommon URL canonicalization remains a boundary |
| 10 | Session-local bounded override store | `wp-sessions.ts:setUaOverride/clearUaOverride` | Separate-session isolation, no-override vs explicit Desktop, clear-one semantics, oldest eviction at 64 | Insert 65+ distinct hosts and query each session before/after eviction | Resource bound is met; users needing >64 remembered hosts must reselect an evicted site |
| 11 | Target-host upstream HTTP identity | `api/wp/.../route.ts`, `wp-core.ts:upstreamHeaders`, `tt85-identity.mts` | Production route sends fixed Desktop for the overridden local host and session Mobile fallback for another host; caller UA/client hints are discarded | Change the route to pass `s.ua`, or inject a fake UA/client hint and inspect both real local listeners | Local HTTP wire contract is verified; a separate public echo service was not used |
| 12 | Target-host WebSocket handshake identity | `wp-ws.ts`, `tt38-unit.mts` | Independent local RFC 6455 server receives Desktop for its host while the session default is Mobile | Replace `uaForSite(s, target.host)` with `s.ua` and rerun the bridge test | Real socket handshake is verified; no public WebSocket provider was required |
| 13 | Page-visible identity shim | `public/wp-shim.js`, `ProxyFrame.tsx`, E3 | Live Chromium checks UA, appVersion, platform, touch count, same-host navigation, and clear on a real PyPI document | Omit one navigator override or inject a second value on navigation | The selected JS surface is verified; canvas/fonts and other fingerprint surfaces remain outside scope |
| 14 | Site-aware API/UI lifecycle and aggregate redaction | `wp-session/route.ts`, `ProxyFrame.tsx`, `publicStats` | Default/override/clear reflect in the selector and page; per-site GET returns one effective value; aggregate stats omit the map | Return `s.ua` for every query or expose the map in generic stats | Same-origin proxy UI/API is verified; direct embeds intentionally cannot use the selector |
| 15 | Fixed privacy header policy | `wp-core.ts:upstreamHeaders`, `tt35-unit.mts` | Incoming UA, language, forwarding fields, and all `sec-*` client hints are dropped before shared identity headers are set | Add a spoofed `sec-ch-ua` or actual browser UA to the incoming request and inspect the echo server | Protects the real browser identity; it is not full anti-fingerprinting and does not hide canvas/fonts |

The Find module is original dependency-free code. AP-01/AP-05 use browser-native APIs; no new production package or telemetry path was introduced.

---

## F. Concrete artifacts

### Production code and feature metadata

- `src/components/modules/Apps.tsx` — integrated Apps and background-inventory views, manifest and API status, module filter/launch, and honest scope labels.
- `src/lib/pwa-install.ts` — captures and consumes only the real browser install prompt; never synthesizes one.
- `src/lib/background-inventory.ts`, `src/components/ShellDaemons.tsx`, `src/components/Shell.tsx` — page-local job definitions, callback accounting, listeners, and install-event wiring.
- `public/wp-find.js`, `src/components/modules/ProxyFrame.tsx`, `public/wp-shim.js`, `src/app/api/wp/s/[sid]/[...rest]/route.ts` — bounded in-frame Find, toolbar integration, and injection path.
- `src/db/seed-data/features-tt85.ts`, `src/db/seed-data/features-files.ts`, `src/db/seed-data/features-tt35.ts`, `src/db/seed.ts` — AP-01/AP-05/PR-07n/PR-07h classification and TT85 seed patch (version 3.71.0).

### Tests and generated records

- `scripts/e2e-tt85.mts` → `docs/test-results/e2e-tt85.json` — production browser E1/E2/E3, including the per-host PR-07h workflow.
- `scripts/tt85-identity.mts` → `docs/test-results/tt85-identity.json` — five identity tests, including a real HTTP proxy route to two local echo servers.
- `scripts/tt38-unit.mts` → `docs/test-results/tt38-unit.json` — 15 WebSocket/connection tests; the bridge case checks that target-host identity wins over session default.
- `scripts/tt85-find.mts` → `docs/test-results/tt85-find.json` — four real-Chromium DOM tests.
- `scripts/tt85-inventory.mts` → `docs/test-results/tt85-inventory.json` — four inventory-model tests.
- `scripts/tt85-mutants.py`, integrated in `scripts/run-all.sh` as `tt85-mutants` — 13 mutation checks across Find, inventory, HTTP identity, session bounds, and WebSocket handshake.
- `docs/LEDGER.md` and `src/data/coverage.json` — refreshed from the live feature register and machine-readable test results.
- `scripts/ledger.mjs` — records the browser version from the run rather than hard-coding a Chromium release.

---

## G. Second-order adversary and mutation results

The adversary mutates production code, runs the relevant Chromium/unit/live-socket suite, and restores each source file after the case. All 13 defects were killed; the wrapper path `SUITES=tt85-mutants bash scripts/run-all.sh` also passed.

| Mutant | Injected defect | Killing evidence | Result |
|---|---|---|---|
| M1 | Start a normalized whitespace source span one unit late | `tt85-find` exact source offsets | **KILLED** |
| M2 | Reset the hit ordinal when a mutation is pending | `tt85-find` mutation-before-keypress ordinal assertion | **KILLED** |
| M3 | Advance by query length and suppress overlapping matches | `tt85-find` `banana` / `ana` count | **KILLED** |
| M4 | Remove visibility checks for hidden/inert/`aria-hidden` surfaces | `tt85-find` hidden-content fixture | **KILLED** |
| M5 | Make the node cap ineffective | `tt85-find` node-budget test | **KILLED** |
| M6 | Stop at the node cap without setting `truncated` | `tt85-find` partial-scan assertion | **KILLED** |
| M7 | Increment callback count on status refresh | `tt85-inventory` status-vs-callback assertion | **KILLED** |
| M8 | Ignore host UA overrides in the resolver | `tt85-identity.mts` host-selection assertions | **KILLED** |
| M9 | Accept malformed host keys into the map | `tt85-identity.mts` validation test | **KILLED** |
| M10 | Clear every host when clearing one site | `tt85-identity.mts` two-host clear test | **KILLED** |
| M11 | Remove the 64-host bound | `tt85-identity.mts` size/eviction test | **KILLED** |
| M12 | Use session-global UA for WebSocket handshakes | `tt38-unit.mts` real bridge/echo handshake | **KILLED** |
| M13 | Bypass target-host identity in the HTTP route | `tt85-identity.mts` real local HTTP route echo | **KILLED** |

**Score: 13/13 mutants killed.** The WebSocket mutant first exposed a test-harness defect: `tt38-unit.mts` called `process.exit(0)` after `finish()`, masking a failed assertion. It now exits with `process.exit(process.exitCode ?? 0)`, and M12 is detected as a nonzero test run. After mutation execution, the unmutated Find, inventory, identity, and WebSocket suites were rerun and passed 4/4, 4/4, 5/5, and 15/15; the ledger was regenerated afterward.

---

## H. Verification summary

| Gate | Command / oracle | Result |
|---|---|---:|
| TypeScript | `npm run typecheck` | **passed** |
| Production build | `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db NEXT_TELEMETRY_DISABLED=1 npm run build` | **passed** |
| Changed production files | Scoped ESLint run | **passed** |
| Repository-wide lint | `npm run lint` | **not clean:** 185 errors, 19 warnings in recorded run |
| AP-01 / AP-05 / PR-07h final production E2E | `scripts/e2e-tt85.mts` against port 3999 after final build | **3/3 passed** |
| PR-07n DOM/source mapping | `scripts/tt85-find.mts`, Chromium 143 | **4/4 passed** |
| PR-07h session/HTTP selection | `scripts/tt85-identity.mts` (production route + local upstream echo) | **5/5 passed** |
| PR-07h WebSocket target selection | `scripts/tt38-unit.mts` (real local RFC 6455 peer) | **15/15 passed** |
| AP-05 inventory model | `scripts/tt85-inventory.mts` | **4/4 passed** |
| Mutation adversary | `scripts/tt85-mutants.py` and `run-all.sh` branch | **13/13 killed** |
| Proxy regression | `scripts/e2e-tt35.mts` | **6/7 passed**; PR-07h identity case passed again against the final build; GitHub repository-page case timed out after 40.694 s |
| Accessibility/regressions | `e2e-a11y.mts`, `a11y-unit.mts`, `e2e-tt55-shell.mts`, `e2e-tt81.mts`, `tt35-unit.mts` | **9/9, 8/8, 3/3, 7/7, 13/13 passed** |
| Generated live ledger | `BASE=http://localhost:3999 node scripts/ledger.mjs` | **414 rows:** 343 built, 32 partial + 18 probe, 21 blocked; 269 fully tested, 70 partially tested, 75 untested; **1670/1671** tests passed; 1 failed test touches 2 rows |

**Browser oracle output from the final E2E:** Chromium reported one service-worker registration and zero periodic tags; the UI's queried rows matched the APIs. The two measured page callbacks were 1/1. E1 saw 46 modules, 3 manifest handler declarations, no offered prompt, and 0 related-app results. These are observations from this run, not cross-browser guarantees.

**Proxy failure detail:** `docs/test-results/e2e-tt35.json` records `timed out: github repository page` (40,694 ms). The suite description identifies the sandbox's GitHub asset-CDN egress restriction, but because the test timed out, this run does **not** verify the intended final GitHub toolbar assertion. The generated ledger marks WP-01 and WP-03 as touched by the failing test. Do not describe the full proxy suite as passing.

The mutation score measures sensitivity to these 13 injected defects; it is not a proof of untested browser engines or the entire 414-row register. E3 intentionally does not gate on exceptions thrown by PyPI's separate blocked ad/status assets inside the opaque frame; it verifies the stated identity path and records the network limitation above.

---

## I. Repairs performed and re-tested

1. **Collapsed-whitespace source mapping:** a normalized space now retains the complete original source run and is not merged into adjacent linear text. This prevents a following-word selection from starting late; the Chromium assertions verify both `[15,18]` whitespace bounds and the following word's `[18,26]` Range.
2. **Mutation-pending ordinal:** on rebuild, Find preserves the existing ordinal (clamped to the new hit list) for the same query rather than resetting to the first hit. The immediate post-mutation test catches the regression before the delayed observer refresh.
3. **Partial scans are explicit:** both text and node limits set the truncation signal; a missing match outside the scanned prefix is not presented as a complete negative.
4. **Inventory counters are event-based:** callback entry and status refresh are separate functions; snapshots do not alias internal state, and subscriber cleanup is tested.
5. **AP-05 scope correction:** the live row now matches the B/P4 source specification and remains partial while other-app enumeration is absent.
6. **Accessibility boundary:** module Axe checks are scoped to the Apps hub, with the separate accessibility suite retained for shell-wide regressions. The latest production E1/E2/E3 rerun, after final source and feature-register edits, passed 3/3.
7. **PR-07h identity consistency:** target-host lookup is shared by HTTP, WebSocket, and injected-page identity. A real HTTP route test catches bypass of the target helper; a real bridge handshake catches regression to session-global UA. Inputs are bounded, map state is session-local and RAM-only, and aggregate stats do not disclose the map.
8. **Test exit integrity:** the WebSocket unit suite previously force-exited with code 0 even after a failed assertion. It now preserves `finish()`'s exit code; this repair makes the M12 mutation a trustworthy kill rather than a printed-but-ignored failure.

---

## J. Stopping condition

TT85 is complete for its bounded targets when the production build/typecheck and scoped lint pass; AP-01 E1, AP-05 E2, and PR-07h E3 pass against that final build; PR-07n's real-Chromium source-range/mutation/cap tests pass; PR-07h HTTP and WebSocket target-selection tests pass; and the adversary kills all 13 seeded defects. Those conditions are met.

The resulting statuses are intentionally not uniform:

- **AP-01:** A/P2, `built`, fully tested for the honest Apps-hub contract.
- **PR-07n:** A/P2, `built`, fully tested for bounded top-document Find.
- **PR-07h:** A/P2, `built`, fully tested for bounded host-scoped proxy UA selection across actual HTTP, WebSocket, and page surfaces. No peripheral detection, direct-embed override, UA-CH parity, or broad anti-fingerprinting claim is made.
- **AP-05:** B/P4, `partial`; only Fusion-owned browser registrations/tags and measured page callbacks are implemented. No other-app inventory is claimed.

The full proxy suite is not all green: its single GitHub repository-page timeout remains recorded, while the production Find case passed. It is not useful to relabel or hide that failure; rerun it only when the sandbox's GitHub asset/CDN egress permits the intended check. Further high-information work would be a supported-browser install/LaunchQueue run and, only with an appropriate Android environment and explicit scope, the absent other-app inventory. **No claim is made that all 414 register rows are Class A.**
