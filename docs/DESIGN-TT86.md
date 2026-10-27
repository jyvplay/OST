# TT86 — SH-06 pointer triggers: Class A completion

**Review date:** 2026-10-26 (America/New_York)<br>
**Selected feature:** `SH-06` — Hot corners, edge triggers, pointer gestures, **A/P2**.<br>
**Starting status:** `partial`: the running register described one top-left corner; edge triggers and mouse gestures were absent.<br>
**Final status:** `built`, Class A for the bounded browser/PWA-viewport contract below. This is one feature promotion, not a review or promotion of all 414 register rows.

## Runtime honesty

### Specifications and live baseline

- Read the complete 949-line `Full V2 and V2.1 Specs.txt`, including all feature tables, architecture, platform/license boundaries, negative space, appendices, and the v2.1 patch. This finalization re-read the previously clipped §8–16 and Appendix A–C span (lines 519–733): it covers the budgets, security/privacy model, test plan, spikes, milestones, risks, build/legal/distribution constraints, negative space, decisions, verification status, and Beam skeleton before the v2.1 patch. Master §7.1 makes SH-06 **A/P2** and names hot corners, edge triggers, and mouse gestures via pointer input; it does **not** prescribe trigger dimensions or panel mapping. The v2.1 patch does not alter SH-06; its adjacent Δ3 is SH-09/IN-01 mouse-button, wheel, and per-device configuration behavior. This implementation therefore adds only the bounded supplemental pointer actions below and preserves ordinary secondary-button/context-menu behavior.
- Read all 140 lines of `docs/SPEC-WEB-v3.md` and all of `docs/DESIGN-TT85.md` (277 lines). The web spec explains the Android-to-browser mapping and explicitly makes the live feature-register data authoritative; its 252-row count and other v3.0/v3.1 claims are historical, not current. TT85 supplies the latest adjacent privacy, evidence, and test-review boundary. Neither prose document overrides the live register.
- Queried the production `/api/features` endpoint before and after work. Before: 414 rows and SH-06 `partial`, with one top-left launcher corner only. After the final production build: SH-06 `built`, with the bounded contract and tests recorded below.

### Runtime and commands actually exercised

- Node.js **22.22.3**, TypeScript **5.9.3**, Next.js **16.2.6**, Playwright **1.64.1**, Chromium **143.0.7499.0**, PostgreSQL **18.4**.
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db NEXT_TELEMETRY_DISABLED=1 npm run build` — passed after the implementation and feature-register update.
- `npx tsc --noEmit --pretty false` — passed.
- `npx eslint src/lib/pointer-triggers.ts src/db/seed-data/features-tt86.ts src/components/DesktopSurface.tsx --no-warn-ignored` — passed. `npx eslint src/components/Shell.tsx` is **not clean**: it reports five `react-hooks/refs` errors at existing ref reads/writes (lines 100, 101, 103, 632, 732) and three existing exhaustive-deps warnings (336, 486, 673); it reported no diagnostic on the new pointer effect. Repository-wide `npm run lint` was not rerun; the prior TT85 record says it was non-clean, so no whole-repository lint claim is made.
- `bash -n scripts/run-all.sh` and `git diff --check` — passed.
- The final E2E ran against the production build at `http://localhost:3999`; the `Fusion Shell` production server remains running on port 3999 for preview.

### External sources and a test-history blocker

No external technical API documentation was needed for SH-06: the browser event path was implemented and tested directly in real Chromium. One existing IN-03 test needed the historical commit `2edf699` to compare the pre-fix matcher; this checkout was shallow and initially lacked that object. I queried `gh api repos/jyvplay/OST/commits/2edf699 --jq .sha`, which returned `2edf69917615249efcc45318308efc93ebe2d65d`, then ran `git fetch --depth=1 origin 2edf69917615249efcc45318308efc93ebe2d65d`. The existing test then passed 11/11. That GitHub commit was used only as the test's historical code fixture; no web-search results or external SH-06 guidance were consulted.

---

## A. Formal model

### SH-06 web contract

All coordinates are CSS pixels in the current browser/PWA viewport. The feature does not receive physical-screen coordinates or OS-global pointer events. The in-memory tracker receives `(x, y, viewportWidth, viewportHeight, time, movementX, movementY, buttons)` and keeps the latest sample, current corner, and any short-lived edge arm. Shell separately keeps only the active right-button gesture's start/surface/context-menu replay state and a short suppression deadline. These are ephemeral page memory; pointer coordinates are not sent to the server, logged, or persisted.

The Shell attaches one page-local sampler while `shell.hotCorners` is on:

1. Prefer `pointerrawupdate` when the browser exposes it; otherwise use `pointermove`.
2. Queue mouse samples and process the batch on the next `requestAnimationFrame`, preserving the path through a frame rather than collapsing it to only the last coordinate.
3. Ignore non-mouse pointer types for these mouse-specific triggers. Corner/edge actions require no buttons held. A first coordinate only establishes state; zero-motion updates do not activate.
4. On disable/unmount, remove listeners, cancel a pending frame, and discard arm/gesture state.

### Hot-corner transition

The viewport has four non-overlapping zones, 6 × 42 CSS px when the viewport permits (each dimension clamps to half the viewport to avoid overlap in unusually small windows). An action fires only when the pointer transitions from outside to inside a corner; a pointer already inside on the first sample is not an entry. A corner does not repeat while the pointer rests or jitters inside, and leaving then re-entering re-arms it.

| Corner | Existing shell action used |
|---|---|
| Top-left | Launcher (preserves TT67 behavior) |
| Top-right | Overview |
| Bottom-left | Quick panel |
| Bottom-right | Command palette |

### Edge-flick transition

The four edge rails are 4 CSS px wide/high. Their 42 px endpoint bands are excluded so a corner sample cannot also arm an edge. Merely entering a rail does not open a panel. Entry arms that edge for at most **600 ms**; movement must then reach at least **18 CSS px inward**, with tangential drift bounded to the corner guard. Each activation consumes its arm; a new rail entry is required to activate again.

| Edge | Action |
|---|---|
| Left | Launcher |
| Right | Overview |
| Top | Quick panel |
| Bottom | Command palette |

The tracker observes events without preventing them or installing a pointer-blocking overlay.

### Right-button gesture transition

A gesture begins only on blank desktop/tabletop surfaces: the classic desktop requires the surface root itself; Tabletop accepts a face background. Buttons, links, form controls, menus, cards, and application windows are excluded. The final right-button (`button === 2`) displacement must be at least **36 CSS px**, and one axis must be at least **1.25×** the other. Ambiguous diagonals and short drags are not gestures.

| Final dominant direction | Action |
|---|---|
| Left | Launcher |
| Right | Overview |
| Up | Quick panel |
| Down | Command palette |

The browser may dispatch `contextmenu` before or after `pointerup`. If it arrives while a blank-surface gesture is unresolved, Shell defers it: a recognized gesture drops it; a short/ordinary right click replays it into the existing React desktop menu. A late duplicate is suppressed only for that same gesture window. Right-clicks on controls/windows do not enter the gesture recognizer.

### Success predicate

SH-06 is `built` for this contract only if (a) all four corner and edge actions and all four gesture directions are model-tested, (b) trusted CDP pointer input opens the real shell panels in production Chromium on both Classic and Tabletop, (c) ordinary right-click, disabled preference, and ordinary control input remain functional, (d) seeded state-machine regressions are killed, and (e) the platform boundary remains explicit. These conditions passed below.

---

## B. Outcome space

### Achieved

- **SH-06: A/P2, `built`, fully tested** for the viewport contract above.
- Four corner zones, four inward-flick edge rails, and right-drag gestures share a single Shell-level event sampler; panel selection uses existing shell UI state rather than new fake modules or simulated OS behavior.
- The preference `shell.hotCorners` now controls corners, edges, and gestures and is labeled “Pointer triggers (corners, edges, gestures)” in Settings.
- Ordinary top-bar button input, desktop context menus, and gesture filtering for interactive controls were exercised in real Chromium.

### Not achieved / not claimed

- No physical-monitor edge or corner access, no pointer events outside the browser viewport, no native Android/Compose input injection, no OS-global hotkey/gesture registration, no touchpad pinch, and no “all input devices” claim.
- The browser run was headless Chromium, not an installed standalone PWA, physical laptop, external monitor, or phone.
- The `pointermove` fallback is implemented but was not exercised in a browser lacking `pointerrawupdate`.
- The 414-row register as a whole is not Class A.

### H∂ — explicit boundary

The source spec says pointer input, and the web implementation’s honest boundary is the app viewport. Native global-edge behavior outside that viewport needs an OS/native input interface not exposed by this PWA. Fixed action mapping is used because the source register does not specify customization or an action editor.

---

## C. Frontier and unresolved interfaces

| Interface not proved | Why it is not claimed | Cheapest falsification / next test | Gap class |
|---|---|---|---|
| Browser `pointermove` fallback | Final E2E used Chromium 143, which exposed `pointerrawupdate`; fallback branch was not forced. | Run the same CDP suite in an engine without `pointerrawupdate`, or add a test-only event-source injection and compare the same edge/corner traces. | Browser-engine semantics |
| Pointer beyond app bounds / physical display corners | Page JS receives viewport events only; no privileged OS cursor feed is present. | Attempt the trigger with the pointer outside the content viewport in a native desktop shell; expect this web build not to see it. | Original Android/OS capability gap |
| Installed PWA / Window Controls Overlay / second display | The automated browser was a tab at 1440×900, not an installed app or external monitor. | Repeat the same input matrix in an installed Chromium PWA and a real second-display setup; compare CSS viewport boundary behavior, without claiming OS-global access. | Deployment/platform |
| User-editable corner/edge action map | The master spec does not define actions or a customization UI; TT86 selects existing panels and documents that mapping. | Ask for a specified mapping contract, then test persisted edits and invalid values. | Spec-detail gap |
| Very long frame suspension / pointer flood | Ordinary 120 Hz-class browser input was tested; no stress/load measurement of the queued batch under a frozen tab was made. | Dispatch a large burst, background the page, resume, and assert bounded memory/one action per edge entry. | Local performance boundary |
| Touch / pen semantics | This is a mouse-trigger contract; Shell deliberately filters to `pointerType === "mouse"`. | If touch/pen triggers are desired, define separate thresholds and run trusted input on physical devices. | Scope, not a hidden implementation claim |

No blocking browser standard ambiguity remained for the bounded test, so no external documentation search was required for this feature.

---

## D. Negative space: rejected shapes and modal-shortcut failure

### Rejected result shapes

These are invalid activation outcomes within the bounded contract; the test names in the last column are executable checks, not a list of hypothetical features.

| # | Rejected shape | Expected result / evidence |
|---:|---|---|
| 1 | The first coordinate is already inside a hot corner | No action; first sample only arms. Model test. |
| 2 | `movementX === 0 && movementY === 0` while entering a corner | No action; synthetic stationary hover is not user entry. Model test. |
| 3 | Pointer jitter/rest inside an already-fired corner | No repeat; real 3-second launcher regression in `e2e-tt67-input.mts`. |
| 4 | `x === 6` at the left corner boundary | Outside; no launcher. Unit and real Chromium boundary assertion. |
| 5 | `y === 42` at the top-corner boundary, or `y === 558` at the bottom-corner boundary in a 600 px viewport | Top is outside; bottom is inside; exact-boundary unit assertions. |
| 6 | Top-left corner is also interpreted as left-edge entry | Corner action only; corner bands are excluded from rails. Model test. |
| 7 | Enter a 4 px edge rail and stop | Arm only; no panel. Unit and E2E. |
| 8 | Inward edge displacement is 17 px | No action; threshold is 18 px. Mutant M5 and threshold test. |
| 9 | Inward edge displacement is exactly 18 px | Action; exact threshold is inclusive. Unit and mutant. |
| 10 | Edge flick arrives more than 600 ms after entry | No action at 601 ms; the exact 600 ms boundary remains valid. Model timeout, inclusive-boundary test, and mutant M6. |
| 11 | Pointer drifts into a corner band while an edge is armed | Arm is discarded; no double corner+edge activation. Model path/corner tests. |
| 12 | Pointer button is held while entering an edge/corner | No hover trigger; button-held model assertion. |
| 13 | A left or middle button drag is submitted to the right-gesture classifier | No gesture. Unit test and mutant M8. |
| 14 | Right drag is 35 px | No gesture; 36 px is the minimum. Unit test and mutant M10. |
| 15 | Right drag is exactly 36 px on a dominant axis | Valid gesture; exact bound is tested. |
| 16 | A 40×40 diagonal is treated as horizontal/vertical by arbitrary tie-breaking | No gesture; ambiguous. Unit test and mutant M9. |
| 17 | Axis dominance is less than 1.25× (e.g. 50×41) | No gesture; exact 50×40 is accepted and 50×41 rejected by the model truth table. |
| 18 | Horizontal gesture direction is reversed | Fails expected Launcher/Overview mapping; mutant M7. |
| 19 | Gesture begins on an actual menu button | No panel; real DOM target check in Chromium. |
| 20 | A normal right-click with no qualifying drag is eaten | Existing desktop menu remains available; real Chromium. |
| 21 | Recognized right-drag opens both a panel and the desktop menu | Gesture context event is deferred/consumed; real Chromium. |
| 22 | `shell.hotCorners=off`, but a corner, edge, or gesture still fires | No panel in Classic or Tabletop; real Chromium. |
| 23 | A regular Quick panel toolbar button is swallowed by trigger handling | Click remains functional; real Chromium. |
| 24 | A touch/pen event is silently treated as a mouse trigger | Shell filters `pointerType !== "mouse"`; this code boundary is stated, but no physical touch/pen E2E is claimed. |
| 25 | An action is claimed outside the CSS viewport or as a physical-display corner | Rejected as an unsupported report claim, not a software assertion; no such capability is represented in the code or status. |

### Modal-shortcut failure explanation and detection test

A prior shell regression allowed global keyboard commands to reach the underlying editor while a Save-as dialog was open. The danger was not merely a shortcut label: `Ctrl+F` could open Find behind the modal and `Delete`/undo could alter the document while the user believed the dialog owned input. `Shell.tsx` now checks `isAskOpen()` before dispatching global keyboard commands; the pointer action path also refuses to open a panel while an ask/modal is active.

The existing real-browser detection oracle was rerun, not inferred: `e2e-tt81.mts` E3 opens Save-as, presses `Control+f` and `Delete` inside its input, asserts the Find pane does not appear and the underlying file bytes remain unchanged; E5 checks the Word Count modal retains its close-control focus through Tab. The entire suite passed **7/7**. `e2e-tt67-input.mts` also pressed Meta+Q behind the mouse-learning modal and asserted no shell panel opened; it passed **5/5**.

---

## E. Mechanism portfolio

The mechanisms below are distinct production/test mechanisms, not six labels for the same handler.

| # | Mechanism | Artifact | Proved portion | Exact unresolved interface | Cheapest falsification | Gap class |
|---:|---|---|---|---|---|---|
| 1 | Raw pointer sampling with frame-batched path processing | `src/components/Shell.tsx` SH-06 effect | Chromium 143 delivered real CDP pointer input; corners/edges activated in the production build; no page errors. `pointerrawupdate` is selected when exposed. | The fallback branch and other browser engines were not exercised. | Run E2E in Firefox/WebKit or force `pointermove` and replay the same coordinates. | Browser-engine |
| 2 | Four-corner entry/re-arm state machine | `src/lib/pointer-triggers.ts` `createPointerTriggerTracker` | All four action mappings, first-sample arming, exact x/y bounds, zero movement, jitter, leaving/re-entry. Unit + Chromium. | CSS viewport only; action customization not defined. | Inject a repeated inside event, inclusive boundary, or first-inside event; unit tests fail. | Web-local / spec-detail |
| 3 | Four edge arm/flick machines | `src/lib/pointer-triggers.ts` edge entry, timer, inward/tangent measures | All edges; 4 px rail, 42 px corner exclusions, 18 px exact threshold, 600 ms timeout, held-button rejection and same-edge fresh-entry re-arm. Unit + Chromium. | Behavior after a tab is frozen for an unusually long interval is not stress-tested. | Replay a stale arm after 601 ms or a diagonal path into the corner; unit tests fail. | Web-local / performance |
| 4 | Right-button direction classifier | `src/lib/pointer-triggers.ts` `pointerGestureAction` | Four directions, 36 px boundary, 1.25× dominance, ties, wrong button. Unit; all four directions in real Classic and Tabletop E2E. | Real OS mouse/touchpad hardware, pointer capture beyond page bounds. | Swap a direction or accept an ambiguous axis; unit/mutant catches it. | Web-local / OS gap |
| 5 | Gesture-surface eligibility + contextmenu order adapter | `Shell.tsx`, `DesktopSurface.tsx`, `Tabletop.tsx` | Real right-click still shows the existing menu; recognized drag does not; an actual menu button is excluded; both desktop surfaces support the gesture. | Exact contextmenu ordering outside Chromium and custom embedded input surfaces. | Rerun with a browser dispatching contextmenu before/after pointerup; verify ordinary-click replay and gesture suppression. | Browser-engine |
| 6 | Single panel action router and modal guard | `Shell.tsx` `triggerPointerPanel`, `isAskOpen()` checks | One action sets one existing Launcher/Overview/QuickPanel/Palette overlay; real controls continue to work; modal keyboard regressions remain blocked. | Whether future user-customizable mappings are desired. | Fire two action samples in one frame or open an ask modal and attempt a trigger. | Web-local / spec-detail |
| 7 | Setting-controlled listener lifecycle | `shell.hotCorners` in `src/db/seed.ts`; Shell effect cleanup | Off removes all three trigger paths in Classic and Tabletop after reload; the top-bar control and ordinary menu still work. | Dynamic runtime preference changes without reload were not independently exercised in E2E. | Toggle setting in the live Settings UI while pointer is armed; confirm cleanup/re-arm. | Web-local |
| 8 | Model, browser oracle, mutation, and register reconciliation | `scripts/tt86-pointer.mts`, `e2e-tt86-pointer.mts`, `tt86-pointer-mutants.py`, `run-all.sh`, live `/api/features` | 3 model tests, 5 real-browser tests, 11 injected mutants killed; live row says built and records the route/test paths; generated ledger includes the suites. | Full 414-row A review is not within this task. | Re-run the targeted `SUITES=...` command; mutate a guard and require nonzero. | Test-harness boundary |

### Original-problem vs local implementation gap

The master spec’s Android implementation could receive pointer input in the native shell. This web implementation receives trusted pointer events only while they are inside its own viewport. The tested behavior is real, not simulated, but the native OS-wide part is unavailable to the PWA and is not claimed. There is no physical-display sensing or privileged pointer injection in the code.

---

## F. Concrete artifacts

### Production

- `src/lib/pointer-triggers.ts` — framework-free corner, edge-flick, and gesture model with named dimensions/thresholds.
- `src/components/Shell.tsx` — one frame-batched sampler, actions routed to existing panels, per-setting lifecycle, Tabletop/Classic target filtering, modal guard, and browser contextmenu ordering.
- `src/components/DesktopSurface.tsx` — classic gesture surface plus deferred replay into the existing right-click menu; the prior one-corner listener was removed so it cannot fire in parallel with the Shell sampler.
- `src/components/Tabletop.tsx` — marks the actual Tabletop surface for the same real pointer-gesture path.
- `src/db/seed-data/features-tt86.ts` and `src/db/seed.ts` — SH-06 `built` contract/test metadata and the descriptive preference label.

### Tests, runner, and generated evidence

- `scripts/tt86-pointer.mts` → `docs/test-results/tt86-pointer.json`: three pure state/classifier tests.
- `scripts/e2e-tt86-pointer.mts` → `docs/test-results/e2e-tt86-pointer.json`: five real Chromium/CDP tests, including all four corners, all four edges, all four directions on Classic and Tabletop, ordinary and short right-clicks, interactive-target exclusion, off preference, control click, and page errors.
- `scripts/tt86-pointer-mutants.py` — injects 11 regressions, runs the model suite, restores the source in `finally`.
- `scripts/run-all.sh` — includes `tt86-pointer`, `e2e-tt86-pointer`, and `tt86-mutants`.
- `scripts/e2e-tt55-shell.mts` — now sets/restores its required Fusion layout and classic desktop so SH-01/02/04 do not depend on a previous user's Business/Tabletop setting.
- `docs/LEDGER.md` and `src/data/coverage.json` — regenerated from the live 414-row register and machine-readable suite outputs.
- This report: `docs/DESIGN-TT86.md`.

No production dependency, telemetry path, pointer storage, remote image/source, or third-party code was added.

---

## G. Second-order adversary and mutation results

The final targeted `run-all.sh` `tt86-mutants` branch invoked `python3 scripts/tt86-pointer-mutants.py` and passed. Each mutant had to produce an assertion failure in `tt86-pointer.mts`; a crash or a test-runner success with no failures would not count as a kill.

| Mutant | Injected defect | Killing assertion | Result |
|---|---|---|---|
| M1 | Corner fires on every in-zone move | Corner jitter/entry-only trace | **KILLED** |
| M2 | First point inside a corner fires | First-sample arm test | **KILLED** |
| M3 | Corner x-boundary is inclusive at 6 | Exact x=6 boundary | **KILLED** |
| M4 | Edge fires immediately on rail entry | Entry-alone negative | **KILLED** |
| M5 | Exact 18 px edge flick is rejected | Exact-threshold assertion | **KILLED** |
| M6 | Edge arm survives beyond 600 ms | Timeout negative | **KILLED** |
| M7 | Horizontal gesture directions are reversed | Direction truth table | **KILLED** |
| M8 | Non-right button is accepted / right button refused | Button truth table | **KILLED** |
| M9 | Ambiguous diagonal is accepted | 40×40 tie assertion | **KILLED** |
| M10 | Gesture minimum falls from 36 to 35 px | 35 px negative | **KILLED** |
| M11 | Bottom edge selects the wrong panel | Edge mapping truth table | **KILLED** |

**Score: 11/11 injected defects killed.** This is evidence that the named tests detect these seeded regressions; it is not a proof over all browsers or all pointer hardware.

---

## H. Verification summary

| Gate | Command / oracle | Result |
|---|---|---:|
| Production build | `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db NEXT_TELEMETRY_DISABLED=1 npm run build` | **passed** |
| TypeScript | `npx tsc --noEmit --pretty false` | **passed** |
| Scoped lint: model, metadata, Classic component | `npx eslint src/lib/pointer-triggers.ts src/db/seed-data/features-tt86.ts src/components/DesktopSurface.tsx --no-warn-ignored` | **passed** |
| Shell lint | `npx eslint src/components/Shell.tsx --no-warn-ignored` | **not clean:** five existing `react-hooks/refs` errors and three exhaustive-deps warnings; none point into the new SH-06 effect |
| Whitespace / runner syntax | `git diff --check`; `bash -n scripts/run-all.sh` | **passed** |
| SH-06 model | `scripts/tt86-pointer.mts` | **3/3 passed** |
| SH-06 real input | `scripts/e2e-tt86-pointer.mts` (production port 3999, real Chromium/CDP) | **5/5 passed** |
| SH-06 mutation adversary | `scripts/tt86-pointer-mutants.py` | **11/11 killed** |
| Legacy IN-02/IN-03/SH-06 model regression | `scripts/tt67-input.mts` after fetching its historical fixture | **11/11 passed** |
| Legacy real pointer/shortcut regression | `scripts/e2e-tt67-input.mts` | **5/5 passed** |
| Modal keyboard/focus regression | `scripts/e2e-tt81.mts` | **7/7 passed** |
| Shell registry/shelf/files regression | `scripts/e2e-tt55-shell.mts` after explicit layout setup/restore | **3/3 passed** |
| Required proxy recheck | `scripts/e2e-tt35.mts` on production port 3999 (result timestamp `2026-10-27T01:24:47Z`) | **6/7 passed**; GitHub repository-page test timed out at 40.739 s; command duration 70.273 s; this preceded the final re-read of master lines 519–733 |
| Live register | `GET /api/features`, SH-06 | **A/P2, built**, route and boundary shown above |
| Generated ledger | `BASE=http://localhost:3999 node scripts/ledger.mjs` | **414 rows:** 344 built, 31 partial + 18 probe, 21 blocked; 269 fully tested, 70 partially tested, 75 untested; **1678/1679** automated tests passed |

The `e2e-tt35.mts` recheck (result timestamp `2026-10-27T01:24:47Z`, command duration 70.273 s) was run before this finalization re-read master lines 519–733; it is **not** represented as a post-complete-master-review run. Its six successful cases passed; the GitHub repository-page case timed out after 40.739 seconds while waiting for the proxied document to reach its title/README readiness condition. The test case is written for the expected GitHub asset-CDN block, but that timeout occurred before its toolbar/shields assertions, so this run does **not** independently prove the asset-CDN diagnosis or those assertions. The failure still touches WP-01/WP-03 and was not hidden or converted into a pass. The ledger does **not** show all 414 rows as Class A. SH-06 was already counted as “fully tested” by the prior one-corner E2E tag, so the number of fully-tested *rows* remains 269 even though this turn adds eight passing model/browser cases and makes the feature itself fully built. No inflated row-count claim is made.

A separate, non-gating `scripts/e2e-tabletop.mts` preservation check was inconsistent and is **not** attributed to SH-06: a complete uninstrumented run passed 14/15 and timed out at `LY-12`'s “moved on the wall” assertion; one focused uninstrumented retry also failed 0/1. A diagnostic focused run passed after temporary per-move reads and a 300 ms post-drag delay altered timing, so it is not counted as a clean fix. With the diagnostics removed, a later full invocation terminated with a shell error after partial output (including a separate `west is main` timeout), then a focused uninstrumented retry passed 1/1; neither establishes a stable full-suite result. At the user's request, the before/after wall-drag log block and 300 ms delay have now been restored, but this instrumented file has not been rerun and its results are not evidence. The test helper uses Playwright's default left-button drag, and `Tabletop.tsx`'s card handler accepts `button === 0` and captures that pointer; SH-06 recognizes eligible right-button surface gestures and does not prevent pointer events. This distinguishes the paths but does not establish a cause or rule out indirect timing interaction. The wall-drag flake remains unresolved. `docs/test-results/e2e-tabletop.json` remains the earlier historical 15/15 artifact, and the generated ledger includes that historical result rather than these later ad-hoc attempts.

---

## I. Repairs and regression checks

1. **Context-menu event ordering:** the first production E2E exposed that Chromium could dispatch the desktop context menu while a right-drag gesture was still ambiguous. The first version let a menu open alongside a successful panel gesture. Shell now defers a contextmenu that occurs during an eligible gesture, replays it for a plain/short click, and drops it for a recognized gesture. Real Chromium then passed gesture, ordinary-right-click, and short-drag checks.
2. **One listener, not two:** the old `DesktopSurface` top-left listener remained after the new Shell-level tracker was introduced. It was removed from the active component so the launcher cannot be opened twice by separate trackers. The legacy helper/tests remain as historical regression evidence; the live path uses `pointer-triggers.ts`.
3. **Old shell E2E precondition:** an initial `e2e-tt55-shell.mts` run failed SH-01/SH-02 because the saved user settings were Business + Tabletop while the test asserts the Fusion launcher/shelf. The test now snapshots, forces Fusion + Classic, and restores both settings. The final production run passed 3/3; the test does not silently leave the user in another layout.
4. **Shallow-history test fixture:** the first `tt67-input.mts` attempt was 10/11 because the shallow checkout lacked commit `2edf699`, not because an input assertion failed. The full SHA was resolved through the GitHub commit endpoint and fetched; the unchanged test then passed 11/11.
5. **Modal/shortcut isolation:** `e2e-tt81.mts` E3 and E5 reran against the final production build and passed. `e2e-tt67-input.mts`'s real modal/Meta+Q test also passed.
6. **Settings/state cleanup:** the new SH-06 E2E snapshots and restores `shell.hotCorners`, `appearance.layout`, `appearance.desktopView`, and the server-side desktop state in `finally`. After the final run the pre-test Business/Tabletop/on settings were restored.
7. **Optional Tabletop test cleanup:** removed the per-move helper instrumentation, deleted the four orphaned test files from the interrupted run, and restored the prior settings and empty desktop state. At the user's request, the before/after wall-drag log block and 300 ms delay are now restored in `scripts/e2e-tabletop.mts`; no test was run with this restored instrumentation because its added reads/wait alter timing. The historic result artifact remains unchanged, and H keeps the flaky outcome separate from SH-06.

---

## J. Stopping condition

TT86 is complete for **SH-06's bounded web contract** because:

- the live register says **A/P2 `built`**;
- the final production build and TypeScript gate passed;
- the model suite passed **3/3**;
- real production Chromium input passed **5/5** across Classic and Tabletop;
- the mutation adversary killed **11/11** seeded regressions;
- legacy hot-corner, modal-keyboard, and shell regressions passed after repairing their environmental preconditions; and
- platform limits, the remaining proxy timeout, repository lint state, and the separate unresolved Tabletop wall-drag flake are disclosed rather than relabeled.

This does **not** establish native OS-wide hot corners or prove the untested `pointermove` fallback on every browser engine. It also does not promote every feature row or resolve the independent Tabletop wall-drag timeout. The final live ledger remains **344 built, 49 partial/probe, 21 blocked, 269 fully tested, 70 partially tested, and 75 untested out of 414**. Further work should target the exact unresolved interfaces in §C, not broaden the claim beyond the evidence.
