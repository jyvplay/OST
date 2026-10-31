# TT132 — actionable alarms and real Planner editing

Date: 2026-10-31 UTC. Branch: `arena/723a3a13-ost`. Base: `6014dc1`.

## Outcome, not a completion certificate

The strongest artifact is the actual production Next/React application with a shell-owned, actionable alarm center and PostgreSQL-backed task/event creation and editing. The new work has real browser, HTTP/SQL, pure-contract and independent-parser evidence. No new module shell was added just to increase a count.

This turn implements **24 distinguishable user-visible additions/corrections** below. That is not 24 newly completed master-spec rows, nor proof of 20 unrestricted native Class A features. The ≥20 additional **completed Class A feature-row** target is not met. CK-01, PR-03 and PR-04 remain **partial**; no row was promoted just to satisfy a count. Native/closed-page alarms, all-feature completion, all-state/all-engine visual certification, repository-wide lint success and a whole-application Pareto improvement remain unachieved. Preserve that distinction when reviewing the PR.

### Additions/corrections and their actual evidence

These are scoped web behaviors, not row-grade promotions. The browser suite names give the full executable conditions.

| # | Behavior now available/correct | Production path; evidence |
|---|---|---|
| 1 | Ringing alarms remain actionable after Clock closes and the toast expires | `AlarmCenter`; alarm browser: closed-window case |
| 2 | Snooze really schedules another delivery using the configured minutes, repeatedly | activity state machine/daemon; repeated-snooze browser case |
| 3 | Pending snooze has a real cancellation control | activity token transition; cancellation browser case |
| 4 | A normal-profile pending snooze resumes after reload without replaying the original occurrence | persistent activity + claim markers; reload browser case |
| 5 | An overdue snooze is explicitly shown as missed, not falsely delivered on time | bounded delivery window; late-wake browser case |
| 6 | Edit an alarm's time, label, weekdays and snooze length without replacing its identity | Clock native form; full-edit browser case |
| 7 | A stale second Clock editor cannot silently overwrite a changed schedule | full-baseline comparison; two-window browser case |
| 8 | Pause all cancels pending activity as well as future enabled schedules | schedule/activity reconciliation; browser case |
| 9 | Two cooperating pages serialize actionable changes to one occurrence | fresh lock-time reads/token comparison; forced real Web Lock race |
| 10 | Actionable alarms still work in page memory when storage writes fail | explicit memory-only mode; write-denial browser case |
| 11 | Amnesic actionable activity neither consumes nor overwrites normal-profile activity/claims | native-storage witness + real page; amnesic browser case; OS notification constructor was instrumented, not a real OS-surface observation |
| 12 | Create a real timed event, with start and optional end, from Planner | per-window form + `/api/tasks`; browser + real SQL/ICS |
| 13 | Create tasks/events with literal multiline notes instead of an always-empty notes field | native form + validated API; browser + SQL |
| 14 | Rename an existing item without delete/recreate or changing UID/time | editor + locked PATCH; browser + SQL |
| 15 | Edit an existing item's multiline notes without losing other fields | editor + locked PATCH; browser + SQL |
| 16 | Reschedule an existing reminder and rearm its delivered flag | merged validation + conditional reminder acknowledgement; browser + SQL late-ack attack |
| 17 | Clear a task's due date, retaining the task and notes | editor + API; browser + SQL |
| 18 | Edit both event endpoints, refusing inverted intervals while retaining typed fields | editor + merged server validation; browser + rollback SQL |
| 19 | Convert task to event and event to task, preserving notes/start and removing event-only end | shared task model; pure + browser + HTTP |
| 20 | Save conflict is visible, retains the local draft, and offers explicit server reload | row-locked expected snapshot + editor; real 409/browser |
| 21 | Delete requires consent and refuses a stale snapshot rather than deleting a changed item | confirmation + locked DELETE; real 409/browser/SQL |
| 22 | Existing-item drafts participate in close/switch/cancel Save/Discard/Cancel lifecycle, including an in-flight save | Planner DocGuard; real browser close/switch/held-PATCH cases |
| 23 | Enter submits the focused Planner window rather than a duplicate global input ID in another window | independent native forms; two-window browser case |
| 24 | Loading failure is visible and Retry performs a real server reload | abortable load/error state; held-out browser read failure |

Additional correctness work, deliberately not padded into that 24: preserve the second DST-fold occurrence and milliseconds on no-time edits; reject local DST gaps; navigate calendar weeks by local dates across DST; original named inline SVG controls; compact type selectors; countdown notification-refusal/privacy handling and audio-context cleanup; immutable shell command/stream snapshots and commit-phase handler refs; removal of obsolete lint directives for a rule this config does not define. Completion checkboxes and ICS import/export already existed and are not counted as new features.

## A. Formal object, access model and success quantifiers

- Target object: the current PWA/HTML desktop, its 47 registered modules, the actual live feature register (607 rows), browser-owned state, API routes and PostgreSQL rows. The Android master specification and its web conversion are related but not equivalent targets.
- Alarm instance: validated schedule `(id,time,days,enabled,label,snoozeMin)` and activity `(alarmId,occurrenceAt,schedule,dueAt,sequence,stage)`. Actions carry occurrence/sequence tokens; labels are not persisted in the activity/claim marker. Bounds: 24 alarms/activities, 48-hour activity retention, 60-second snooze delivery window, 1–60 minute snooze. Activity storage uses `fusion.clock.activity.v1`.
- Planner instance: integer ID 1…2,147,483,647, trimmed title 1…500 JavaScript UTF-16 code units, notes at most 65,536 code units (not grapheme counts), task/event kind, completion, optional explicit-offset timestamps. Events require a start; a supplied end must be strictly later. Tasks have no event-only end. Expected snapshots compare the six editable fields under a row lock.
- Access actually used: real same-origin Chromium pages, storage/Web Locks, HTTP and SQL against an exclusive disposable PG database; repository filesystem and open-source toolchain. No user-device OS broker, native AlarmManager, peer receiver or remote display was available through the app; ordinary server HTTP/PostgreSQL sockets were used.
- Strong original quantifier: for every relevant spec row, admissible input, resource state and event/interleaving, offer correct complete behavior. **Not established.** Our evidence establishes the listed finite executions and narrow source-level arguments under their hypotheses, not that universal statement.
- Parameters/boundaries: one browser build, two logical CPUs, a disposable database, explicit local/UTC and DST cases, 900/1500 CSS-pixel visual views. Browser clocks are deliberately controlled in alarm tests. They are not hardware sleep/resume tests.
- Adjacent non-equivalent problems: native wake scheduling vs a running-page timer; durable exactly-once external notification vs a cooperative claim marker; editing content vs an ABA/history-sensitive revision protocol; VFS safe save vs Android SAF/provider replacement/fsync; independent parser algorithm vs an independent timezone database; initial-view rendering vs all-feature usability.

## B. Hypothesis ledger and evidence threshold

**H+ (supported in the stated finite scope):** real configured snooze/cancel/reload activity, fresh lock-time token checks, amnesic/native-storage isolation in the instrumented page, locked stale task update/delete rejection, task/event conversion and endpoint validation, dirty existing-item lifecycle, full diagnostic reuse on unchanged lint inputs.

**H− (do not assert):** all 607 rows Class A; reliable closed/frozen-page alarms; unrestricted exactly-once reminders; ABA/history-sensitive editing; lossless arbitrary RFC 5545 calendar fidelity; universal privacy or accessibility; all recurring jobs faster; complete-application/main-branch Pareto dominance. A normal-profile task reminder can still be emitted after an old read and before a later reschedule check, and two pages can post duplicate task alerts: conditional acknowledgement prevents marking the new due instant delivered, not an atomic alert/outbox protocol.

**H∂ (conditional/unresolved):** cross-page suppression requires cooperative pages, shared storage bucket, functioning storage and Web Locks; without those it is best effort. New ambiguous local times use the browser's earlier choice (disclosed), while unchanged later-fold values are retained. New-item form drafts and crash recovery remain outside the existing-item DocGuard. Legacy clients can omit `expected`; snapshots detect unequal current content, not A→B→A history. Clock edit baseline checks catch the tested stale UI edit, but schedule-list localStorage writes are not a cross-tab atomic transaction; simultaneous schedule writers can still lose updates.

Threshold used here: a build is necessary but insufficient. A behavior needs a real user route and mechanism-specific assertions; persistence/concurrency claims need actual HTTP/SQL or real browser coordination. Pure boundary injection is labeled as such. Independent parsers increase confidence but are not formal verification. A feature-register status or a screenshot is never treated as its own proof.

## C. Retrieved sources, frontier and exact interfaces

Primary files retrieved via authenticated `gh api` and content-reviewed this turn, not copied as production implementation:

| Source | Retrieved blob SHA; narrow finding and hypothesis |
|---|---|
| [React external-store reference](https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/useSyncExternalStore.md) | `9bb755a4be93c04ba6e6666ba54adc155f76f24a`: unchanged `getSnapshot` must return the same value; snapshots must be immutable; SSR snapshot must agree with hydration. This informed cached external-store snapshots. It is not a theorem that our whole store is correct. |
| [W3C Web Locks draft](https://github.com/w3c/web-locks/blob/main/index.bs) | `1800ed46772eafbd915067b1bdf0b19b875a3fb0`: same-storage-bucket cooperative coordination; exclusive same-name locks exclude other holders; callback promise settlement controls release. A rejected callback can reject the outer request, so blindly retrying every rejected request can repeat delivery. No closed-page liveness or durable transaction follows. |
| [PostgreSQL 17 MVCC/locking documentation](https://github.com/postgres/postgres/blob/REL_17_STABLE/doc/src/sgml/mvcc.sgml) | `380d0c9e8051ed123fd196d464d310dcb72d9c62`: at Read Committed, `SELECT FOR UPDATE` waits and returns the updated matching row after a concurrent updater commits. Our compare/update must stay inside that transaction. This is not the same behavior as Repeatable Read/Serializable, nor an all-writers revision protocol. |
| [ESLint CLI reference](https://github.com/eslint/eslint/blob/main/docs/src/use/command-line-interface.md) | `76663b3d80d709c6f1ec3508f649fa5f394b7375`: content vs metadata cache; per-file cache does **not** track dependencies. The wrapper therefore conservatively invalidates the entire namespace on source-graph/config/lock/Node changes, instead of assuming per-file content hashing alone preserves cross-file rules. |
| [WHATWG Notifications standard source](https://github.com/whatwg/notifications/blob/main/notifications.bs) | `167d421d94011e444e477475e212b9970760d88b`: nonpersistent vs service-worker persistent notifications and permission integration are distinct. No `showTrigger`/`TimestampTrigger` was found in this retrieved source. That is not a proof about every future browser. |
| [Notification Triggers proposal](https://github.com/beverloo/notification-triggers/blob/master/README.md) | `616077ea1fb08579196a97edf2a31f7e4762ac3e`: a 2019 proposal for prepared notifications, explicitly distinguishing push connectivity/deep sleep. Its existence is not implementation availability. No production dependency on this proposal was added. |

This is a targeted interface review, **not an exhaustive frontier survey** or a new mathematical result. No theorem prover was used and no unsupported theorem is imported. The exact open interfaces for the stronger target are an available privacy-compatible native scheduler, an atomic reminder alert/outbox protocol, and a schema/client revision contract for history-sensitive conflict detection.

License review: React, Next, ESLint and node-postgres upstream license texts were retrieved and confirmed MIT; TypeScript Apache-2.0. Existing package/version controls remain. New production mechanisms and SVG paths are original repository code, not renamed/copied reference implementations. Temporal 0.5.1 (ISC) and ICAL.js 2.2.1 (MPL-2.0) are external test-only oracles, not new runtime dependencies; their installed license texts were inspected (MPL carries source/notice obligations when distributing covered code); Temporal shares platform Intl timezone data, so its algorithmic independence is not independent tzdata. No commercial service/API key/telemetry was introduced. This is not an exhaustive legal audit of every historical dependency or dataset.

## D. False-solution shapes and modal-shortcut test

Reject these twenty shortcuts: (1) snooze arithmetic without UI or scheduler; (2) a toast presented as persistent alarm controls; (3) a Clock-owned timer presented as shell-owned; (4) running-page delivery presented as physical wake; (5) notification permission presented as successful OS delivery; (6) localStorage set success assumed after write denial; (7) amnesic in-memory data backed by normal-profile claims; (8) cached pre-lock state accepted after waiting; (9) callback rejection retried as though lock acquisition never began; (10) title-only conflict detection; (11) unlocked SELECT then UPDATE; (12) expected snapshot called ABA protection; (13) valid date string accepted after silent February rollover; (14) unchanged later-fold time silently changed to earlier fold; (15) week navigation by fixed 24-hour milliseconds; (16) self-parser/self-writer round trip called independent verification; (17) disabling a check or accepting only exit zero without the passing summary; (18) cache returning exit zero while hiding unchanged errors; (19) faster wall time assumed to imply less CPU/energy/peak memory; (20) all initial screenshots or 24 behaviors promoted into universal all-row Class A completion.

Modal-shortcut attack: normal storage, one page and an on-time tick are deliberately replaced with write-only denial, amnesic native-storage witnesses, two real pages blocked on one Web Lock, a blocked claim followed by disable, a missed delivery window, a stale editor, a real SQL row-lock barrier, a second DST-fold value, a spring gap, a failed read, a held HTTP save, a native storage event after amnesic dismissal, and an actual browser-offline save followed by an independent server read and online retry. The normal/modal case cannot substitute for these states. Those executions still do not enumerate all schedules.

## E. Six mechanism-distinct branches with concrete artifacts

| Mechanism / construction | Concrete artifact | Established portion; exact gap | Cheapest next falsification |
|---|---|---|---|
| Pure occurrence-token state machine, bounded acknowledgement retention | `alarm-activity-core.ts`, `tt132-core.mts` | Validation/transition examples plus 1,000 deterministic adversarial steps; source-level invariant reasoning, not mechanically proved induction. No scheduling liveness from pure arithmetic. | Generate shrinking random traces with wall rollback, corruption and simultaneous schedule changes. |
| Shell-owned external activity store + real browser locking/persistence | `alarm-activity-store.ts`, `AlarmCenter.tsx`, daemon; alarm browser suite | Real two-page lock barrier, reload, cancellation, denied writes and isolation. Conditional on live JS, storage and cooperative lock users; not durable exactly once or OS wake. | Kill the page after claim but before visible delivery; test storage eviction and another browser engine. |
| Locked SQL compare-and-mutate | `task-model.ts`, tasks route; HTTP/PG suite | Actual two-waiter race produces 200/409; rollback and stale delete checked. No ABA, revision field or mandatory expected snapshot for legacy callers. | A→B→A plus stale client; concurrent daemon alert/outbox race. |
| Native per-window forms + keyed fixed-baseline editor + DocGuard | Planner/PlannerEditor; 17 browser cases | Real user controls, save conflict retention, switch/cancel/close and held save checked. New creation draft, crash draft and every unload/navigation scenario remain incomplete. | Close all with two dirty Planners while one save fails; reload a new-item draft. |
| Independent external date/calendar algorithms | `tt132-oracles.mts`; Temporal + ICAL.js | Low-year/offset instants, folds/gaps and independently authored VEVENT read/write checked. Shared timezone database; RFC 5545 export has whole-second precision; custom VTIMEZONE/recurrence exceptions remain beyond current importer. | Other zones/engines and a hostile custom VTIMEZONE/EXDATE fixture. |
| Conservative cache namespace + unchanged-run diagnostic reuse | `lint.mjs`, cache contract, `benchmark-lint.py` | Alternating full-scope outputs and exit codes compared; same-mtime/same-length source attack; config/graph/Node invalidation. No changed-file shortcut or rule relaxation. Extra disk cache; code edits conservatively go cold; manually altered plugins require clean lint. | Modify a rule's external dependency/environment, compare uncached; benchmark complete app/gate and energy. |

Each branch has an executed/testable artifact, not a speculative architecture diagram. None closes the gap between its local problem and the original unrestricted all-feature target.

## F. Verification and repair record

### Final-candidate checks

**The second, final configured gate passed: 75 suite executions (71 distinct suites), 627 passing / 0 failing case results, exit 0.** Four core suites intentionally run twice; these are case-result counts, not 627 unique tests/features. It ran serial browser/database suites with `JOBS=2` only for the independent pure phase, against the final production rebuild and regenerated embedded ledger. Wall time **991.089 s**, child user **604.360 s**, child system **147.650 s** (`tt132-gate-final-resources.json`); this is not a whole-machine CPU/energy measurement or a controlled comparison with the first run/main.

Authoritative evidence: `tt132-production-gate-final.log`, `tt132-gate-final/`, `tt132-gate-final-summary.json`. `tt132-source-manifest.json` binds the final changed source/script/config bytes; `tt132-delivery-status.json` summarizes the observed statuses. The derived summaries count repeated failure-log tails only once and attribute the six post-`FASTDONE` regressions to the actual `tt126-regressions` invocation, rather than the preceding pure suite.

| Check | Result / scope |
|---|---|
| Production build + TypeScript | Both exit 0; `tt132-build-delivery.log`, `tt132-typecheck-delivery.log`; production restarted with the regenerated embedded ledger |
| New pure activity/task contracts | 12/12, including the 1,000-transition deterministic attack (one test case, not 1,000 features) |
| Injected claim boundaries / cache-key contracts | 3/3 and 4/4; injection is not a native lock/OS test |
| Real HTTP + PostgreSQL | 11/11, including the two actual waiting row-lock transactions and stale acknowledgement |
| External Temporal / ICAL.js | 5/5; limited independent oracle scope in §E |
| TT132 actual Chromium alarms / Planner | 13/13 and 17/17 again in the final configured gate, with cross-page storage-event and browser-offline attacks |
| Legacy alarm / timezone regression suites | 9/9 and 2/2 again in the final configured gate |
| All density sweeps / deployed-ledger contract | All 10 sweeps passed; ledger 5/5; Chromium + axe accessibility suite 9/9 and image-viewport regression 10/10. These finite checks are not general accessibility certification. |
| Initial visual captures | 94/94; the visual/readiness/word-count limits in §H apply |
| Scoped delivery ESLint | Exit 0 for the named new alarm/task/Planner files, Shell/daemon/input/QuickPanel/Messages and TT132/legacy repair scripts; `tt132-scoped-delivery-lint.log` |
| **Uncached repository-wide ESLint** | **Exit 1: 135 errors, 13 warnings across 1,171 analyzed files**; `tt132-lint-final{,-summary}.json`. Writer accounts for 102 errors, SSH 14; Beam (2) and Share (1) retain existing hook errors. No lint rule was relaxed to make these disappear. |
| Generated historical ledger | 607 rows: 499 built / 84 partial-or-probe / 24 blocked / 0 skeleton; 448 full test-tags / 123 partial / 36 untested; **3,358 passed / 3,372 saved results**. These authored statuses/tags and mixed timestamps are not fresh universal coverage or Class A grades. |

The ledger still retains **14 failed saved results in five older suites**: `integration` (3), `e2e-office` (1), `e2e-sheet-layout` (5), `e2e-vector` (1), `e2e-tt81` (4), dated October 30. These five suites were not rerun as part of this turn's configured gate. Do not relabel the configured gate as every repository test or erase those unresolved records. `tt131-ledger` checks the generated snapshot against the actual deployed register and caps partial rows rather than promoting them.

The **first broad gate failed**: 75 suite executions, 624 passing / 2 failing case results, 1,023.972 s wall, 937.420 s child user / 170.513 s child system. The original failed `tt132-production-gate.log`, per-suite logs and `tt132-gate-first-summary.json` are retained. The failing legacy alarm oracle expected an amnesic schedule inside the Storage overlay; the actual UI route now witnesses it and persisted claims must belong only to known normal-profile IDs. The timezone oracle expected old prose; it now checks the real import/edit/fold semantics. Review also found a **real UI regression**, not just oracle drift: the running-page reminder warning had been hidden inside details. It was restored outside the disclosure, rebuilt and checked before expansion. The affected four suites passed serially, and added patch-specific attacks cover a native normal-page storage event after private dismissal and a real browser-offline failed save with unchanged server data and successful online retry.

Important failed attempts are retained, not rewritten as passes:

- Node 22 strip-types rejected a constructor parameter property before pure/HTTP tests. Replaced it with an explicit field; affected gates reran successfully. The subsequent independent low-year/fold tests were a new date-model attack.
- First alarm browser run: 9 passed / 2 failed because the test's clock kept advancing and a helper required the second alarm to be next while the first remained earlier. Paused the clock explicitly; waited for the exact editor control, not summary ordering. Rerun: 11/11; later expanded: 13/13. No intended production assertion was removed.
- First Planner run: 13 passed / 1 failed because a broad alert-detached selector matched Next's always-mounted route announcer. Scoped it to the Planner window, kept the induced read failure and actual Retry assertions. Added switch/cancel/held-save attacks. Expanded rerun: 16/16.
- Expanded countdown test initially used nonexistent field names/default minutes, so it timed out before exercising the feature. Corrected it from the actual labeled UI; notification-constructor refusal then passed.
- First claim-contract attempt imported a nonexistent helper; corrected it to exercise the public `claimAlarm` function. This is explicitly isolated LockManager/storage boundary injection, not a real browser/OS test. Separate real browser lock tests exist.
- Cache design was strengthened after reviewing ESLint's cross-file dependency caveat; the pure key tests add unchanged-importer/source-graph invalidation. The benchmark checks actual complete diagnostic equality and unchanged-metadata edits, not just a faster exit.

A repaired candidate is not accepted merely because the formerly failing example passes: affected suites rerun, and an additional mechanism-specific attack is added where recorded above.

## G. Repeating-work measurements and costs

Measured locally in isolation on the actual two-logical-CPU sandbox; `tt132-lint-performance.json` and `tt132-lint-benchmark-run.log` preserve all trials. A cold cached prime was followed by **AB, BA, AB** (three uncached and three warm full-repository runs); normalized diagnostics and exit statuses were identical. Both modes used the same production-source scope and rules; no changed-file-only lint, rule removal or suppression of production diagnostics was used. `.cache/` now explicitly ignores disposable benchmark/scratch artifacts in both full commands.

| Median metric | Uncached full lint | Warm content/graph cache | Observed reduction |
|---|---:|---:|---:|
| Wall time | 72.408738 s | 1.365823 s | 98.114% |
| Child CPU (user + system) | 101.273703 s | 1.664515 s | 98.356% |
| Peak **sampled summed** process-tree RSS | 1,040,044,032 B | 360,206,336 B | 65.366% |

The measured revision returned **136 errors, 13 warnings, exit 1** in both modes. A same-length/same-mtime added error changed that to 137/13 and was detected by both cached and uncached runs; removing the witness restored the original diagnostic fingerprint. Four cache-key contracts separately cover content/config/Node and unchanged-importer/source-graph invalidation. One cache namespace occupied 619,114 bytes; namespaces are not automatically pruned and later source/ledger changes deliberately select a cold namespace. Final lint counts are recorded separately in §F because further repairs postdate these measurements. A subsequent isolated **final-candidate fidelity recheck** (`tt132-lint-delivery-fidelity.{log,json}`) matched the independent uncached output at 135 errors / 13 warnings / exit 1: cold prime 62.608496 s, then warm 1.264210 s. Those are two observations, not a second alternating median study; they validate reuse of the final diagnostics without replacing the earlier performance experiment.

**Pareto verdict:** the observed warm medians dominate these three measured time/CPU/RSS metrics at equal diagnostics on this workload. This is not universal Pareto dominance: cold/changed-graph checks can be slower, disk usage increases, manual plugin/dependency changes require `lint:clean`, and there is no energy measurement or whole-application comparison. RSS was sampled every 50 ms, may double-count shared mappings and miss brief peaks; `wait4` maxRSS is not aggregate memory. Monitor CPU is recorded separately and OS page caches were not cleared.

The visual helper still incurs an 8-second network-idle timeout per view; no verified faster replacement was delivered. Resolving its two observed pending request types and adding semantic, held-request readiness attacks is a useful next script optimization, rather than silently deleting the wait.

The general demand that every recurring job be faster/less CPU intensive/more powerful is not universally satisfied. This turn substantially improves one important unchanged-code diagnostic workload and strengthens the gate (explicit disposable opt-in and full per-suite logs); no new parallel browser lanes were enabled. Stateful browser/database suites stay serial on this two-CPU machine. A stronger gate can take longer; that is not relabeled as a wall-time speedup.

## H. Visuals, density and original graphics

Executed `tt132-visual.mts` against the rebuilt production server: **47 registered modules × 2 viewports = 94 initial views, 94 passed / 0 failed**. All eight generated contact sheets were actually opened and visually reviewed (not just generated), together covering all 94 captures. Earlier full-resolution alarm-snooze, Planner-editor and conflict screenshots were inspected and informed real layout repairs: bounded type selectors, native form sizing, unclipped control titles, and the original conversion arrow glyph. The always-visible **“Keep Fusion open for reminders.”** warning was restored after a regression; the repaired legacy timezone test checks it before expanding details.

Evidence: `docs/evidence/tt132-visual.{log,json}`, `docs/screens/tt132-visual/{wide,compact}/`, `docs/screens/tt132-{wide,compact}-review-{1,2,3,4}.jpg`. The browser was **Chromium 143.0.7499.0**, 1500×960 and 900×960 CSS-pixel contexts. Reported capabilities: secure context, 2 hardware threads, Web Locks and Notification constructor present, `TimestampTrigger` absent; service-worker API present but workers explicitly blocked by this reproducible fixture, timezone UTC. API presence is not proof of native display/wake or service-worker execution.

No initial view had an unhandled page error. The visual helper truthfully records **all 94 `networkidle` waits as unsettled** rather than claiming full transport quiescence; a follow-up real request trace (`tt132-visual-network-trace.log`) observed pending Private-header and desktop-save requests, without establishing the underlying cause. Screenshots still show loaded entry controls/data, but this timeout-based capture is not a proved data-settled/readiness or performance gate. Spreadsheet reports 289 px wide / 575 px compact root horizontal overflow; grids/documents intentionally have scrolling, and compact Contacts toolbars scroll rather than wrap. These are review observations, not silently dropped failures: no universal no-overflow/all-state assertion was made.

The strict historical density sweeps use a different **rendered text-node geometry** metric from the contact-sheet labels' `innerText` (which includes select options/offscreen list text, e.g. Clock/Spec); do not compare these as interchangeable word counts. Targeted controls and disclosures were shortened, but Settings/Spec/Apps/Backup/Storage remain text-heavy and a whole-OS wording redesign is unfinished. The final strict sweep measured all 47 modules: **Clock 142 rendered words (ceiling 160), Planner 20 (ceiling 120)**. `EMOJI-IN-CONTROL` detector flags remain in several modules (including geometric symbols); the no-emoji assertion is limited to Browser/Recall. This turn does not claim all controls across all apps were redrawn. The 94 captures preceded the final ledger-only rebuild; the current Spec headline was independently recaptured and opened afterward in `tt132-spec-current-ledger.png`, with a real browser assertion of `3358/3372` and its mixed-date tooltip (`tt132-deployed-ledger-view.log`). The all-app review found no newly blank/broken module initial view; it does not establish that every displayed control implements its complete specification.

New glyphs are original inline SVG paths with accessible names on their controls; no image model, icon library, remote image fetch or new font dependency was used. Native task/event type selectors have explicit compact widths; browser screenshots exposed and prompted that layout correction. Warnings about running-page alarm/countdown limits remain visible rather than hidden to achieve a word-count target. Initial-view inspection does not certify every canvas zoom, dialog, permission flow, dataset or assistive-technology state.

## I. Runtime honesty and reproduction

Selected tool/package versions, licenses and the PATH audit are recorded in `docs/evidence/tt132-runtime-inventory.json`. Actually used: repository tools (`bash`, file read/edit/write), `git`/`gh`, Node 22.22.3/npm 10.9.8, Next 16.4.3/Turbopack, TypeScript, ESLint, Drizzle schema push, a real PostgreSQL 17.5 process, actual Chromium 143.0.7499.0 driven by Playwright, axe-core, Python 3 with standard-library resource/wait4 measurements, Pillow contact sheets, Temporal 0.5.1 and ICAL.js 2.2.1. Additional test-only Python libraries were installed in the transient tools environment for existing suites (NumPy, Shapely, cryptography, argon2-cffi); only actual executions in the logs count as use. Search was limited/targeted and primary references were retrieved from GitHub; no unsupported comprehensive-search claim.

Not used/provided: additional coding agents, theorem provers, model checkers, hardware/OS simulators, physical phone/laptop wake tests, a LAN Cast/AirPlay receiver, raw network/OS broker, real screen reader or a second browser engine. Browser clock and injected API failures are controlled tests, not physical devices or proof of OS notification display. `/usr/bin/time` was absent; failed attempts to use it are not measurements. Large tools/databases/caches live in ignored/transient storage, not committed datasets.

Reproduce against an **exclusive disposable** PostgreSQL/server, never user data:

```sh
npm ci --no-audit --no-fund
# Start PG, apply the existing Drizzle schema, build and start with DATABASE_URL.
export BASE=http://127.0.0.1:3000 DATABASE_URL='postgresql://.../disposable_db'
export TT89_DISPOSABLE_DATABASE=1 TOOLS_DIR=/path/to/test-tools
export ORACLE_PY=/path/to/test-tools/venv/bin/python JOBS=2
# TOOLS_DIR needs the real browser and test-only Temporal/ICAL packages.
npm run test:gate
# Run performance in isolation, not beside that gate/build/browser work:
python3 scripts/benchmark-lint.py
npm run lint          # still nonzero while existing diagnostics remain
npm run lint:clean    # independent full uncached diagnostic run
node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt132-visual.mts
/path/to/tools/venv/bin/python scripts/tt132-contact-sheet.py
```

The benchmark deliberately retains existing errors and compares nonzero statuses; its own successful exit means the cache contract/measurement checks passed, not that lint passed. The current disposable live preview is a sandbox service, not a deployed production offering.

## J. Exact remaining gap and next high-information work

1. Reproduce the 14 unresolved older saved failures against isolated current production (first the independent HTTP/search index cases), then repair actual defects without replacing their assertions with smoke checks. Finish the existing repository lint backlog without suppressing compiler/hook diagnostics; Writer/ref-heavy modules dominate. Keep the uncached check as an independent gate.
2. Implement and test new-item/crash-draft lifecycle, multi-editor close-all failure and unload behavior; test actual page termination after claim and physically suspended/closed PWA behavior on real devices.
3. Decide the stronger persistence contract: schema revision/mandatory client precondition for history-sensitive conflicts; atomic task-reminder outbox/claim/alert transaction for duplicate/stale delivery, not just a conditional acknowledgement.
4. Test Firefox/WebKit, real assistive technology, large/imported edge-case datasets and full visual interaction states. Continue spec-backed end-to-end implementation rather than register promotions or new skeleton modules.
5. Compare complete current/main builds and the whole recurring workload on this hardware, including cold/changed-code runs, aggregate memory/disk/energy/network and fidelity; local warm-lint dominance does not settle that target.

Keep the PR open. No merge is authorized by the historical permission for PR #16.
