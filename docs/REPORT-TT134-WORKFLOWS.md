# TT134 — bounded Notes, Clipboard and Find workflows

**Carryover accepted: 20/20 bounded additional TT134 workflows.** TT135 finished the previously incomplete release gate: **96 actual suite invocations / 92 distinct suites / 867 passing case executions / 0 failures**, with identical source fingerprints before and after the full production run. The twenty rows below are TT134 carryover, **not TT135 additions**. The earlier [checkpoint](DESIGN-TT134.md), failed/interrupted runs and their accepted-zero decisions remain historical. No universal OS-completion claim follows from this bounded acceptance.

PR #17 must remain open. No universal OS-completion claim is made.

## A — Objects, access, success criterion and boundaries

The artifact is this repository’s foreground browser desktop, its real Next HTTP routes, and a disposable **UTF-8 PostgreSQL 16.2** database. Inputs include saved public note rows, unsaved note drafts, real browser clipboard text, public VFS records and an actual browser-encrypted Private volume. Outputs are new persistent records/index entries, guarded draft changes, real downloads/clipboard writes, query results and current-source previews.

Let `S` contain persisted rows/indexes, editor base revision and draft, browser-local history/profiles, modal/request ownership generations, and clipboard history. A supported action must either produce its documented result while preserving unrelated/source data, or visibly refuse without silently replacing it. Success is bounded by the declared input/resource contract and actual browser permissions. The desired universal quantifier is “every supported action/state under those assumptions”; the executed finite tests do **not** prove that quantifier or all browser/OS combinations.

| Parameter | Implemented boundary |
|---|---|
| Note fields | 500 title / 1,048,576 body / 2,048 tags UTF-16 code units; valid Unicode, no NUL; existing normal title rules |
| Copy collections | 1–32 rows; at most 4 MiB compact field JSON; raw import/export files separately capped at 4 MiB UTF-8; new identities only |
| Batch transport | Fatal UTF-8 decoding; bounded request stream; one notes+index transaction; local 4 s lock / 15 s statement limits, **not** a whole-operation deadline |
| Split/table | At most 5,000 source lines / 32 sections; tables 2–16 columns and 1–100 data rows |
| Replace | Literal case-sensitive query 1–512 / replacement ≤16,384 code units; pre-expansion output-length refusal |
| Templates | Complete serialized UTF-8 envelope ≤4 MiB; first 64 files in picker; literal local title/date/time tokens; new note unpinned |
| Diff | ≤1,048,576 UTF-16 units per side; one exact common-prefix/suffix changed region, bounded changed-line rendering; **not LCS/minimal diff** |
| Task board | 100 notes / 2,097,152 UTF-16 units / 200 matching tasks / 5,000 parsed lines per note; coverage displayed |
| Clipboard tools | Non-sensitive valid Unicode without NUL, ≤1,048,576 UTF-16 units; canonical public paths ≤4,096 units; create-only transfers |
| Find resources | Real UTC calendar days 0001–9999; inclusive after / exclusive before; inclusive safe-integer byte interval; literal canonical excluded subtree |
| Literal pages | Public text/literal offsets 0/50/100/150; 50 results/page, 200 scan cap; deterministic live-index order, **not a cross-request snapshot** |
| Preview/export | Current public text prefix ≤65,536 Unicode code points; binary metadata only; visible ≤200-result JSON/CSV ≤4 MiB; explicit plaintext Private-export consent |

Non-equivalent adjacent problems: portable copies ≠ identity/timestamp-restoring backup; saved-body merge ≠ dirty-draft merge; exact-region diff ≠ LCS; revision CAS within one row lifetime ≠ incarnation-safe delete/recreate protection; deterministic pages ≠ stable snapshot export; public VFS creation ≠ arbitrary host-disk access; browser clipboard permission ≠ universal physical-desktop integration; finite DB timeouts ≠ a network/transaction deadline. Private/RAM advanced resource filters and host previews are explicitly unavailable rather than silently degraded.

## B — Evidence threshold and H ledger

Acceptance threshold for these twenty: implemented reachable native UI + actual production API/database or browser action as appropriate; at least one meaningful refusal/adversary; preserved source/draft/identity boundaries; no substituted request transport, fake clock, injected React state or synthetic peer used to establish native completion; fresh strict/build/regression checks. Coverage tags and register statuses are **authored claims**, not independent certification.

**H+ (observed, with receipts):** after the first expanded gate failed, the repaired production build exited 0 and strict source/`.mts` checks passed. Focused real production reruns now report: kernels 21/0; HTTP/PostgreSQL 9/0; native Notes 13/0, Clipboard 10/0 and Find 10/0; transitive browser kernels 8/0; carried Notes/Find 27/0, boundary controls 7/0, TT122 3/0, Writer header/footer 6/0 and native PDF/office/storage TT81 7/0. This is not yet the clean full-gate decision. The actual SQL index lock caused a ≥3.9 s timeout/refusal and rollback. Private search/export used a genuinely created Argon2/AES-encrypted volume, actual local search and real lock clearing, not a replacement privacy implementation.

**H− (retained failures):** initial HTTP 8/1 had a bad fuzzy-positive oracle; Notes 8/3 exposed asynchronous opener focus loss plus premature controlled-checkbox assertions; Clipboard first/second 7/1 exposed an invalid read-only-arrow assumption and then real modal focus eviction after async copy. A new template-boundary test first failed because its test constant was not imported; strict `.mts` checks exposed omitted fixture fields and untyped benchmark arrays. Original logs are retained. None is relabelled a pass.

**Completed expanded-gate failure:** exit 1, 1,660.083695 s; eight failed suites. Its before/after identity was unchanged: 1,419 implementation/verification inputs, SHA-256 `419033ab3a935379369458658ff1e428c2021bbdbb902e6e91f408e5aa6dce3d`. Deferred checkbox-event reads really lost a selected entry; old selectors collided with new nested tools/Preview buttons; a Blob harness omitted transitive imports; independent Word/PDF inputs were absent; axe found an undersized Notes checkbox. Nested runner-contract invocations also overwrote primary logs and produced sparse holes: **no aggregate count is certified for that run**. Raw failure, metrics and integrity receipts are retained. Repairs were applied only after it exited.

**TT135 continuation correction:** the first restored-runtime rerun was stopped after a completed Clipboard 9/1 diagnostic. The screenshot shows the older row correctly checked while a later same-prefix capture became the new first row. The helper incorrectly acknowledged only a common first line, so an ordinal checkbox assertion raced actual insertion. This is an oracle/readiness defect, not evidence that the repaired state handler lost that checked identity. The earlier root-cause attribution was too strong. The scalar-capture guard remains defensive. Capture now waits for the full actual body; all original assertions remain, and a four-cycle same-prefix/identity native attack was added. This stopped run has no certified full-gate result. Two display/error labels also now explicitly say UTF-16 code units rather than characters/MiB.

**H∂ (open boundary):** universal all-feature completeness, physical desktop/device integration, Safari/Firefox/mobile, screen-reader operation, exactly-once retries, cross-request snapshot paging, minimal diff, arbitrary-length input/deadline guarantees, incarnation-safe CAS and exhaustive license/notice certification remain unproved or out of scope. The legacy register still has consistency gaps; reducing them is not equivalent to completing the underlying features.

## C — Actual primary-source research and frontier

[Research receipt](evidence/tt134-workflows-research.json) records actual `gh api` retrievals, immutable commit URLs, SHA-256/byte counts, times, search query and the three issue bodies read. No production implementation was copied from these references.

* [MDN Clipboard.readText](https://github.com/mdn/content/blob/a0ba038b5e77c06c820e90dc39133acb70dd476a/files/en-us/web/api/clipboard/readtext/index.md): secure context, permission failures and text-only result. A permission grant in the test is an explicit lab condition, not a bypass shipped to users.
* [PostgreSQL 16 queries](https://github.com/postgres/postgres/blob/582db3ee09e9d2128c2510937bbc3c9f763d97bf/doc/src/sgml/queries.sgml): LIMIT/OFFSET needs a unique predictable ORDER BY. That hypothesis supplies deterministic fixed-index pages, not a shared snapshot across requests.
* [PostgreSQL 16 MVCC](https://github.com/postgres/postgres/blob/582db3ee09e9d2128c2510937bbc3c9f763d97bf/doc/src/sgml/mvcc.sgml): transaction/isolation and same-row concurrency semantics do not establish delete/recreate incarnation identity. Atomicity assumes the actual single DB transaction, not independent notes/index writes.
* [W3C APG modal pattern](https://github.com/w3c/aria-practices/blob/0f765e4dc33e966026114ac12a8380db1de3b787/content/patterns/dialog-modal/dialog-modal-pattern.html): initial focus, Tab ring, Escape and logical focus return. `aria-modal` alone is not behavior. Async disabled openers and body-focus eviction require actual implementation/testing.
* [MDN textarea](https://github.com/mdn/content/blob/a0ba038b5e77c06c820e90dc39133acb70dd476a/files/en-us/web/html/reference/elements/textarea/index.md): read-only controls remain focusable/selectable, unlike disabled controls. This does **not** promise arrow-key caret navigation on every platform; the native Chromium microexperiment established only the observed version’s behavior. DOM LF/source CRLF mapping is additionally exercised by native application tests.

Actual issue search: `repo:w3c/aria-practices is:issue dialog focus return`, 18 matches, first three bodies reviewed: [2924](https://github.com/w3c/aria-practices/issues/2924), [1409](https://github.com/w3c/aria-practices/issues/1409), [599](https://github.com/w3c/aria-practices/issues/599). All three were open at retrieval; nonmodal navigation and menu-to-dialog return-focus questions are related, not a proof that this implementation is correct or that the frontier is closed. Comments/resolutions were not exhaustively reviewed. No theorem prover or external human reviewer certified the work.

## D — False-solution shapes actively excluded

1. Relabel carried TT133 rows as this turn’s twenty.
2. Count bug repairs, tests or icons as new user workflows.
3. Count rendering, a compiler pass or a pure helper as native end-to-end completion.
4. Substitute routes/crypto/clipboard history, then call the result native.
5. Assume arrow keys select in a read-only textarea because they do in an editable one.
6. Blame event propagation without isolating native read-only behavior.
7. Restore focus to `document.activeElement` only after disabling the async opener.
8. Trap Escape only inside the dialog after a disabled active control sends focus to `<body>`.
9. Block the real emergency privacy chord along with ordinary modal shortcuts.
10. Treat controlled checkbox dispatch as an acknowledged asynchronous commit.
11. Let a task’s stale line index target a different line after an own Save.
12. Import caller-supplied note IDs/revisions into an overwrite path.
13. Write notes and index in separate transactions, or claim abort proves no commit.
14. Retry an unconfirmed copy as if the route had an idempotency key.
15. Label UTF-16 code units as MiB bytes; omit template-envelope JSON overhead.
16. Apply dates/bytes to index rebuild time/truncated snippets instead of canonical records.
17. Treat `%`/`_` in an excluded folder as SQL wildcard syntax.
18. Apply predicates only to the first ranked branch, omitting substring/fuzzy/metadata paths.
19. Reuse old results/cursors/export ownership after the query changes.
20. Export stale/deleted source snippets as if they were current preview content.
21. Present live LIMIT/OFFSET as snapshot-consistent full collection export.
22. Export spreadsheet-formula titles without a stated CSV neutralization policy.
23. Export Private plaintext without consent, or keep it visible after the actual lock event.
24. Hide/remove Spec rows, spike criteria, failure explanations or capabilities to win a density count.
25. Infer all-workload/peak-memory Pareto dominance from a single wall-time sample.

**Modal shortcut test:** the Notes test first proves native tiling works, then opens the async comparison, exercises actual tiling + Ctrl-S refusal, checks unchanged saved winner/geometry, traverses Tab/Shift-Tab, closes by Escape and pointer, reopens, checks opener return and proves the shortcut works again. Clipboard additionally copies through the actual API, observes focus on **BODY**, then proves Escape still closes and post-close tiling is released. The real Ctrl+Alt+Shift+Backspace emergency chord is tested during modal ownership.

## E — Mechanism-distinct constructions, artifacts and cheapest falsification

These are complementary mechanisms for the composite request, not six purported proofs of universal OS completeness.

| Mechanism | Construction / concrete artifact | Established portion | Gap; cheapest next falsification |
|---|---|---|---|
| Atomic portable copies | `note-workflows.ts`, bounded JSON reader, `/api/notes/batch`; kernel/HTTP/native Notes receipts | Strict copy-only validation; one actual notes+index commit; real locked-index rollback | No idempotency/offline replay; drop a real response after commit and inspect before retrying |
| Source-preserving text tools | `NoteTools`, Markdown parser/renderer, template codec, `text-selection.ts`; CRLF/control/envelope tests | Exact slices, safe literal links/tables/tokens; native find/link replacement preserves other CRLF bytes; full template budget | Not CommonMark/LCS or arbitrary size; mixed-ending multi-edit/IME corpus on another browser |
| Owned asynchronous modals | `WorkflowDialog`, explicit opener and generation/abort ownership | Native async focus-return/reopen; real body-focus eviction recovery; ordinary shortcut suppression and emergency exception | Not general React linearizability or tested assistive-tech stack; simultaneous workflow/AskHost transition drill |
| Clipboard-safe transfers | Clipboard workflows, canonical create-only destinations and streaming timestamp max | Actual selection/edited clipboard writes, pin/source retention, note/index/file creation; real Vault sensitivity refusal | Permission/platform dependent; real denied-write UX and another desktop browser are high-value next tests |
| Canonical search predicates/pages | Resource codecs, SQL predicates, metadata path and Find ownership | Real timestamp/UTF-8 size/exclusion before all relevant branches; native replay; fixed-index disjoint pages and cap | Live-index movement remains disclosed; edit titles between page requests and audit omissions/duplicates |
| Current preview and portable results | Preview API/component, JSON/CSV codec, actual downloads and independent Python CSV parser | Current safe text/missing-source refusal, exact visible result set/completed query; real encrypted-local export consent/lock clearing | Bounded prefix/snippets, not full content export; unlock/relock during a slow actual read/export |
| Bounded repeated-work optimization | `tt134-workflows-benchmark.mts`, batch fixture setup and LF range identity fast path | Equal declared field/index projection and range results; measured wall+CPU reductions on two CPUs | Not peak-memory/all-workload dominance or full-app latency; repeat under larger mixed-ending inputs and independent machine |

The local-to-original gap for **every** row is the same important distinction: these establish bounded workflows/components, not completion of every OS module, every requested capability or all platforms.

## F — Structure-specific attacks and repairs

* Atomic import: 33 rows, malformed/oversized/invalid UTF-8 bodies, explicit identity/unknown-field attempts, Unicode bytes and actual PostgreSQL lock/rollback.
* Text: fenced headings/tasks, CRLF exact joins, escaped table pipes/alignment, literal HTML, active URL schemes, control labels, empty find, expansion guard, stale saved revision and shifted task line.
* Template: complete **exact 4 MiB** JSON roundtrip; one-byte overflow refusal. Validation now includes the wrapper; reads check real UTF-8 bytes.
* Clipboard: actual OS-facing browser clipboard readback, half-surrogate refusal, exact CRLF excerpt, source pin retention, one-entry comparison refusal, actual masked Vault capture, actual emergency shutdown; 170,000 retained pins exercise the removed argument-spread hazard in a kernel test, not a fabricated GUI history.
* Find: UTC leap-day/range negatives, multibyte file/note byte equality, literal wildcard folder siblings, invalid intervals, source incompatibility, saved profile reload, current/deleted preview, real downloads, fixed 75-row native continuation and 225-row HTTP paging/cap checks. Private tests create an actual encrypted volume and inspect outgoing requests/storage rather than substitute a privacy peer.
* Presentation: all register rows and spike fields remain; original SVG coverage marks expose accessible saved-snapshot labels, not assertions of a fresh all-suite pass.

Repair-specific native attacks now include six complete Clipboard check/uncheck/comparison/focus cycles, independent keyboard Notes checks, repeated Find filter/regex/case/sort changes without another search, actual 24×24px hit-box measurements, transitive browser import validation and scaled comparison-heading checks. An actual missing-glyph screenshot is retained; the controlled heading now uses ASCII `vs`, visually re-read at ordinary and large text. Full/fast runners now create unique temporary invocation directories, including nested calls; full passing-case output is retained and a separate auditor checks current receipts against actual primary logs. Independent prerequisites are checked read-only before expensive work.

Every repaired native candidate receives a patch-specific adversary and affected checks are rerun. Initial failures remain in `docs/evidence/tt134-workflows-*-first.log`, Notes/Clipboard subsequent logs, script-typecheck logs and failure screenshots. `HARNESS_ONLY` runs do not overwrite full-suite JSON receipts.

## G — Verification receipts and freshness

| Check | Latest collected result / scope |
|---|---|
| Kernel workflows | 21/0 repaired-source rerun, `tt134-workflows-core-release.log`; component/refusal coverage remains partial where appropriate |
| Real production HTTP/SQL | 9/0 repaired run, including actual locked-index rollback |
| Native production Notes / Clipboard / Find | 13/0 · 10/0 · 10/0; all new commands use real UI, transport/clipboard/crypto |
| Affected carried browser suites | Browser kernels 8/0; Notes/Find 27/0; boundaries 7/0; TT122 3/0 |
| Independent real Word / PDF regressions | Writer49 6/0 and TT81 7/0 after pinned DOCX and test-only PDF.js restoration |
| Independent calendar oracles | Earlier 5/0, Temporal 0.5.1 + ICAL.js 2.2.1; must rerun in full gate |
| Root / scripts types | Root fifth 0; strict `.mts` ninth 0; semantic checks include the new transitive loader |
| Full lint | Sixth 0 errors / 6 existing warnings; includes final isolated-log/auditor changes |
| Production build | Third workflow build exited 0, actual `next build`; now served by the production preview |
| First expanded full gate | **EXIT 1**; raw logs/metrics/integrity preserved, no aggregate certification |
| Clean repaired full gate | **PENDING**; must finish and pass the primary-log/current-receipt audit |
| All-app visual / density | All 47 apps / 94 authentic wide+compact images reviewed; six refreshed repaired-native images also actually read; see detailed review |

The saved coverage snapshot currently generated here is **3736 mixed-date recorded tests**, with 647 live rows: 539 built, 84 partial/probe, 24 blocked; 489 fully / 122 partially / 36 untested. This is **not** a fresh 3,736-test execution and not independent all-row acceptance. The live register health inspection found **254 issues**, none touching the new twenty, versus 274 before expanded module claims. The seeder’s raw definition count includes an existing duplicate; the actual API has **647 unique rows**, not 648 features.

## H — Repeating work and measured resource vector

Two actual CPUs (affinity `0-1`), Node 22.22.3, about 3.85 GiB physical memory. Measurements use alternating trial order, warmups excluded and three timed trials/mechanism. No other verification was intentionally run during the benchmark.

| Production workload | Baseline median | Candidate median | Measured result |
|---|---:|---:|---|
| 32 successful note fixtures, wall | 219.124414 ms serial HTTP | 11.706191 ms atomic batch | ~18.7× faster |
| Same setup, whole-sandbox CPU | 247.91 ms | 16.00 ms | ~15.5× lower CPU |
| 200 LF-only 1 Mi-unit source-range maps, wall | 355.830568 ms traversal | 2.517897 ms identity fast path | ~141× faster |
| Same mapping, executing-process CPU | 355.519 ms | 2.524 ms | ~141× lower CPU |

[Production receipt](evidence/tt134-workflows-benchmark-production.json) and [development receipt](evidence/tt134-workflows-benchmark-dev.json) retain every trial, equal checksums/projection hashes, CPU scopes and limitations. Fixture comparison excludes newly allocated IDs/timestamps but verifies title/body/tags/pin/revision/index data in the actual database after each setup. This is successful-fixture fidelity, **not** equivalence of serial partial-failure semantics to an atomic batch. The range fast path follows the identity mapping when no CR exists; mixed CR/CRLF correctness is separately checked. Peak-memory Pareto and universal workload dominance were **not** measured. All repetitive OS work is not magically optimized.

The full regression is reproducible with `TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 DATABASE_URL=<exclusive-disposable-UTF8-PostgreSQL-URL> TOOLS_DIR=<test-only-tools> JOBS=2 bash scripts/run-gate.sh`. Do **not** point this mutating fixture gate at user/production data. Actual commands/CPU scopes are retained in measurement receipts. The read-only preflight checks installed metadata and pinned input hashes, not successful oracle execution.

The existing gate still uses two independent pure lanes and **serial** shared-database/native browser suites. Earlier browser-lane parallelism was not Pareto on this two-CPU machine; it is not reintroduced. Full-graph lint caching and its invalidation contract remain intact; no changed-file lint shortcut, dropped assertion or relaxed density cap is used.

## I — Visual review, graphics, provenance and tools

The actual [47-app/94-view review](REVIEW-TT134-WORKFLOWS.md) is complete for the initial production captures, with six populated native states refreshed and actually re-read after the checkbox/heading fixes. It is visual evidence, not all-feature acceptance. Slides compact really fits (the earlier clipping assertion was corrected); Writer compact paper clipping, Spreadsheet horizontal overflow (289/575px), compact Contacts toolbar crowding and unsettled Photos-wide networking remain disclosed. The new comparison heading visibly renders `vs` at ordinary and large text. No screenshot is invented, redrawn or passed off as native evidence. New source changes add an original inline Capture glyph and check/half/dash coverage symbols with accessible labels; previous original Notes/Find marks are preserved. Repeated coverage words are removed without deleting row details, every register row or any spike criteria. Tools/libraries are not counted as graphics/features.

No new production dependency or copied implementation is introduced. New production logic and SVG paths are authored here using the existing stack. This does not convert the prior transitive license/NOTICE inventory into legal certification; permissive/copyleft/font/data obligations still apply. Newly installed Temporal/ICAL.js, browser/database tools and Python packages are test-only under ignored `.cache`.

[Runtime discovery](evidence/tt134-workflows-runtime-discovery.json) distinguishes installed/discovered tools from execution. Used: repository/file/process tools, Git/gh, Node, TypeScript 5.9.3, Next 16.4.3/Turbopack build, ESLint 9.39.4, Chromium 143.0.7499.0 through Playwright 1.64.1, real PostgreSQL 16.2 via `pg`, Python standard-library independent CSV parsing and test-only Temporal/ICAL.js. Actual carried regressions now also use Python Pillow/python-docx/openpyxl/python-pptx/pypdf and test-only PDF.js 6.5.438 with @napi-rs/canvas 1.1.0. Both pinned Apache POI DOCX blobs were re-retrieved and byte/hash-verified; restoration metadata and a real two-page raster smoke are retained separately from the full native TT81 pass. **Independent agents: 0. Theorem provers used: 0. OS/hardware simulators used: 0.** A minimal real-DOM browser experiment is labelled as such, not application acceptance. Legacy broad regressions can contain controlled boundary tests; they are not relabelled native proof of these new twenty. New workflow suites seed owned disposable fixtures and saved window layouts through the real APIs; they do not replace transport, crypto, clocks or React stores. Browser permissions are explicitly granted and service workers blocked in the foreground workflow fixture; those cases alone do not prove PWA offline/device behavior.

The sandbox database is disposable, not a production authentication/deployment recommendation. Actual owned fixture leftovers from initial failures were inspected and removed with exact IDs/paths; later suites explicitly clean their own VFS versions. No general user-data cleanup is performed.

## J — Decision, strongest artifact, remaining gap and next test

**ACCEPTED, bounded TT134 set:** the twenty implementations below now have the completed production gate, an independently checked primary-log audit, the 47-app/94-view visual review and the focused native repair attacks. Acceptance is for their documented finite contracts, not the canonical OS as a whole. PR #17 remains open.

### TT135 completion of the carryover release

* [Actual complete gate](evidence/tt135-carryover-final-gate.log), [raw per-suite logs](evidence/tt135-carryover-final-gate-logs/run-7394-0ZQrA2/), [metrics](evidence/tt135-carryover-final-gate-metrics.json), [positive audit](evidence/tt135-carryover-final-gate-audit.json): **96 invocations, 92 distinct suites, 867 passing executions, 0 failures**. Duplicate suite invocations are executions, not additional distinct suites/features.
* Exact frozen input: 1,422 files; before/after SHA-256 **`cf71e45cc623ad38fb3a6f8700610f5885d747b7e60bb0f7717b41bf93680699`**. Coverage-excluding hash **`434b841b506032b39fdf4b44adf9c5f4a1d80528b6430dbb8e4b0649055748ac`**. [Before](evidence/tt135-carryover-final-source-before.json) / [after](evidence/tt135-carryover-final-source-after.json) are unmodified. Restored Git metadata initially pointed at the checkout base; a later mixed reset to existing PR head `71c27a6` preserved the complete working tree before delivery.
* Measured wall **1660.309900164 s**; waited-child CPU **1886.708166 s**; largest-child RSS **662696 KiB**; whole-sandbox CPU **2886.005145 s**; affinity **0–1**. Independent draft preparation/type checking overlapped this gate, so whole-sandbox CPU and wall are **not** an isolated comparative benchmark or Pareto claim.
* Repaired Clipboard readiness/identity attack: **11/0**, retaining all comparison assertions, four real same-prefix capture/check cycles and the UTF-16 limit assertion. The earlier screenshot did not establish production identity loss; that attribution remains withdrawn.
* The gate itself exited 0; the *following audit command initially exited 1*, because command filenames `image-engine` and `vector-engine` differ from actual harness identities `image` and `vector`. The auditor now reads exactly one literal `makeHarness` registration with the real TypeScript AST, checks every case identity, timestamp, diagnostic and count, and binds metrics to the exact main-log path. No receipt was renamed and no application assertion weakened. Its affected gate was rerun on the preserved complete artifacts. [Eight artifact attacks](evidence/tt135-gate-audit-attacks.json) pass: intact aliases accepted; failed command, missing real case line, NUL/sparse suite, foreign pure directory, historical receipt window wrong measurement log and corrupt frozen receipt all refused. Validated harness receipts are frozen beside the primary logs, so later legitimate reruns cannot replace this audit’s inputs. These are explicitly artifact-tampering tests, **not eight native application cases**.
* Ledger refreshed from actual current saved suite receipts: **647 unique rows; 539 built / 84 partial-or-probe / 24 blocked; 489 full-tagged / 122 partial-tagged / 36 untested; 3742/3742 mixed-date saved cases**. The latter is historical coverage, not this gate's 867. The 254 pre-existing register-health inconsistencies are not magically repaired.
* Post-gate changes are the verification-only auditor/attack script and generated coverage metadata. Final release build/lint both exit **0** (lint: **0 errors / 6 pre-existing warnings**); post-refresh native/metadata checks are **tt131-ledger 5/0, tt134-icon-review 5/0 and tt134-review-repairs 8/0**. The auditor reruns positively against its frozen receipts afterward. The [release receipt](evidence/tt135-carryover-release.json) records exact source deltas and identities; the runtime feature implementations stayed frozen during the full gate. No TT135 draft feature is counted here.

| New feature | Implemented workflow |
|---|---|
| NT-19 | Portable note collection copies |
| NT-20 | Merge saved notes into a new copy |
| NT-21 | Split a draft at headings |
| NT-22 | In-note literal find/replace |
| NT-23 | Validated Markdown-link insertion |
| NT-24 | Build/edit/preview pipe tables |
| NT-25 | Save/instantiate literal note templates |
| NT-26 | Compare draft with latest saved body |
| NT-27 | Review/commit cross-note saved tasks |
| CB-04 | Inspect and copy a selected excerpt |
| CB-05 | Edit a separate clipboard copy |
| CB-06 | Save clipboard text as a public note |
| CB-07 | Save clipboard text as a new public file |
| CB-08 | Compare two checked entries |
| SR-20 | Canonical modification interval |
| SR-21 | Canonical content-byte interval |
| SR-22 | Literal per-query folder exclusion |
| SR-23 | Download visible result JSON/CSV |
| SR-24 | Preview current public result content |
| SR-25 | Continue bounded public literal pages |

The original universal goal is still unmet: 84 partial/probe and 24 blocked authored register rows, 36 untested rows and 254 health inconsistencies are not eliminated by adding these workflows. The next high-information tests after the local gate are another real browser/permission-denied clipboard path, concurrent edits between pages, actual lost-response recovery and a real screen-reader/modal audit—not more optimistic status labels. Keep PR #17 open and preserve the complete failure/evidence chain.
