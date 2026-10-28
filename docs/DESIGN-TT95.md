# TT95 — public Photos recipe concurrency and prior-gate recovery

## Runtime and outstanding prior work

The reset left the TT94 gate incomplete. In this turn I installed the locked application dependencies, restored test tools and pinned corpus blobs, fetched the historical TT67 test commit, created an **exclusive disposable** PostgreSQL database, applied the schema with an explicit URL, built the production app, and served it on `0.0.0.0:3000`. This turn's database was PostgreSQL **18.4**, Node **22.22.3**, and the bundled headless Chromium **143.0.7499.0**. The TT94 report did not establish the earlier PostgreSQL version; it has been corrected rather than guessing.

The unchanged 64-suite TT94 production gate **finished 62/64, exit 1**. `e2e-tt54` crashed during fixture setup because `piexif` was absent; `e2e-privacy` failed its unchanged 50 MB/s encryption minimum at **42 MB/s** (decrypt 59; the save-latency part did not run). `docs/evidence/tt95-prior-production-gate.log`, `tt95-prior-e2e-privacy-failed.json`, `tt95-prior-privacy-bench-failed.json`, and `tt95-tt54-fixture-error.log` preserve this. The previous interrupted gate is also preserved. A separate disposable-database/browser baseline ran concurrently during part of this gate, but was stopped before the final privacy benchmark. It could have affected earlier timings; it does not change the recorded outcome.

Installing test-only `piexif`, PyAV and mutagen allowed `e2e-tt54` to run separately **8/8** (`tt95-tt54-recovery.log`); the bootstrap now checks for them. That isolated recovery does **not** retroactively pass the failed aggregate gate. No encryption speed fix or threshold change is claimed. The earlier Files native-drag failure and the TT93 privacy failures remain in their original evidence.

## Formal scope and quantifiers

For one **public** photo and its canonical recipe path, assume the requests reach the same PostgreSQL VFS and supply both the already-supported owner token and the new recipe token. The token is either `null` (the editor saw no recipe) or a file id, version and SHA-256 read with the recipe. For each such accepted write or clear, the server validates the owner and the current recipe within the mutation transaction; it locks existing rows and uses conflict-safe insertion for absence. A mismatched, missing, changed, trashed, recreated or corrupt recipe is refused with 409. Successful writes return the committed recipe identity so that the same editor can make another guarded save. Public current-node/history/index changes and the write's COMPLETE journal update remain in the database transaction; failed writes can retain a FAILED journal attempt.

The editor does not silently reinterpret an unreadable, malformed, non-object or unsupported-version recipe as no recipe. Host recipe identity is advanced only after a confirmed response. The token is retained in queued public writes. A rejected replay remains queued. Explicit recipe preconditions are refused—not silently dropped—by the privacy layer for Private and amnesic stores, which still use their existing unguarded store-specific writes.

**H+ (established on selected schedules):** a matching owner and recipe can be written, written again using the returned token, or cleared; two same-snapshot editors cannot both publish guarded edits; a stale clear preserves the newer recipe; a concurrent uncommitted ordinary insert cannot be silently replaced by a guarded absent-create. The tests use actual HTTP, Chromium and PostgreSQL; the read failure is explicitly injected by Playwright request interception.

**H− (refused or reported):** malformed guard, guard without owner, wrong owner/path, owner move/replacement, stale recipe content/version/id, tampered stored content, missing or trashed recipe, stale clear, corrupt JSON, unsupported recipe version, recipe read failure, inaccessible Private/RAM precondition, and stale queued replay. Selected negatives and their assertions are listed below.

**H∂ (frontier, not established):** legacy/noncooperating clients can still write unconditionally after a guarded operation. Direct SQL and old server implementations do not participate in all VFS locks or update index/history correctly. There is no universal Private/RAM recipe CAS, no cross-device or external-filesystem transaction, no automatic merge or draft recovery, and no authenticated provenance. An absent→created→purged ABA cycle cannot be detected from an absent token without a durable generation/tombstone. A lost commit response is still ambiguous; a replay may conflict rather than prove whether the earlier write committed. An absent guarded clear intentionally leaves any orphaned history/index rows untouched. Parsing still normalizes known fields and is not a complete forward-compatible recipe-schema preservation mechanism.

## Negative shapes / adversaries

1. Two clients see absence and publish different recipes.
2. A later editor changes an existing recipe before the older save.
3. A later editor changes it before the older clear.
4. Identical bytes are rewritten, incrementing the version.
5. The sidecar is removed and recreated with identical bytes but a different id.
6. A removed sidecar is targeted by a stale editor.
7. Stored content is changed without updating its stored hash.
8. Guard is an array, string, number, empty object, invalid id/version or invalid hash.
9. A recipe token is supplied without a photo owner token.
10. Two guarded creates race for one absent path.
11. Two guarded updates race from the same version.
12. A competing ordinary insert remains uncommitted while guarded creation starts.
13. A competing recipe update holds a real PostgreSQL row lock before a guarded save.
14. The same held update precedes a guarded clear.
15. Two Chromium editors attempt conflicting pixel edits.
16. A stale reset attempts to clear a later edit.
17. A stale pixel edit would remove a newer favorite.
18. A queued edit reconnects after another recipe write.
19. Existing recipe bytes are invalid JSON.
20. A browser-intercepted read returns HTTP 500.
21. Private/RAM callers request a recipe precondition that their store cannot enforce.
22. A legacy caller deliberately omits both preconditions (compatibility control).

These are concrete cases, not an exhaustive proof over arbitrary schedules. The initial browser baseline mistakenly matched the word “corrupt” in a fixture path before the editor opened; the corrected exact-message baseline and the partly invalid original are both preserved in `docs/evidence/`.

## Mechanisms and artifacts

1. `src/lib/server/vfs.ts`: validated optional recipe token, locked recipe comparison and actual-content digest; successful write identity returned from the transaction.
2. Same file: conflict-safe creation and a guarded absent-clear no-op, in addition to the existing owner guard and cooperative tree gate.
3. `src/app/api/fs/route.ts`: passes the optional precondition on writes and purges; conflict is returned as HTTP 409.
4. `src/lib/thumbs/service.ts`: strict editor-specific recipe read while thumbnails retain their existing best-effort read.
5. `src/components/modules/Photos.tsx`: per-editor token, confirmed-only advancement, storage-mode change refusal, and fail-closed errors.
6. `src/lib/privacy/layer.ts`: forwards a public host guard and refuses unsupported Private/RAM preconditions without exposing plaintext to the host.
7. `scripts/tt95-photo-concurrency.mts` and `tt95-photo-race.mts`: SQL readback, version/index/history checks and observed held locks.
8. `scripts/e2e-tt95-photo-concurrency.mts`: independent Chromium editors, queue replay and injected read faults; `scripts/tt95-photo-mutants.py` exercises deliberately broken variants.
9. The isolated fixture recovery and updated `scripts/sandbox/bootstrap.sh` repair the prior missing test prerequisites without installing those Python packages into the PWA.

## Baselines and focused checks

Before this repair, HTTP/PostgreSQL tests were **1/13** and corrected Chromium tests **1/6**: two editors' second save/clear returned 200, the newer favorite could be lost, and a corrupt or failed recipe read was treated as absent. Baselines are saved in `tt95-photo-concurrency-baseline.json` and `tt95-photo-browser-baseline.json`; the extra offline test was added after that baseline. The 15-suite development regression subsequently passed **127/127**, including recipe HTTP **13/13**, forced lock schedules **3/3**, Chromium **7/7**, owner **12/12**, old forced owner races **2/2**, stale UI **2/2**, failed-save UI **7/7**, offline **6/6**, cross-tab queue **3/3**, privacy layer **13/13**, Photos corpus **8/8**, transfer **17/17**, transfer races **5/5**, disposable safety **4/4**, and integration **25/25**. Scoped TypeScript/ESLint/diff checks passed before the final privacy-layer change; recheck below is required.

## Calculator register correction

The previous PR-09 seed said calculator history was persisted as searchable notes, but the component only holds 40 entries in React state; it is lost on remount. Its programmer support is standalone hexadecimal/binary conversion and radix display, not bitwise operators or a full programmer mode. Seed version **3.76.5** now reports it **partial**, not a new promotion. `tt95-calculator-audit.mts` passed **4/4** using the live register, shared evaluator, Chromium remount and direct PostgreSQL notes/index checks. This correction does not add persistence or change the calculator's privacy behavior.

## Source review and licensing

[PostgreSQL 18 transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) and [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) explain why a row lock cannot lock a missing row, and why read-committed statements and concurrent inserts require care. [Pomerium PR #6773](https://github.com/pomerium/pomerium/pull/6773) (Apache-2.0) discusses version predicates and concurrent creation; [OptimisticConcurrencyBundle](https://github.com/alkinbg/optimistic-concurrency-bundle) (MIT) documents representation-bound validators and successful-write token advancement. [ComfyUI separate metadata](https://github.com/Kuroi961/ComfyUI-Save-Separate-Metadata) (MIT) documents sidecar portability and ambiguous matches. These were reviewed as reference material; the implementation here was independently written, not copied. Test-only corpus and oracle licenses remain subject to their own terms.

## Mutation and shortcut checks

The TT95 source-mutation portfolio killed **12/12** selected recipe mutations, including omission of write/clear checks, each id/version/content comparison, absent-create conflict handling, UI token forwarding/advancement, corrupt/read-error handling, privacy forwarding and offline queue preservation. Each mutant was restored and its selected baseline passed first; `docs/test-results/tt95-photo-mutants.json` and `docs/evidence/tt95-photo-mutants.log` record detections. The refactored prior photo/queue portfolio also killed **15/15**. These targeted mutations are not a universal correctness proof.

The required modal-shortcut failure/detection check was actually run: the Slides Save-as modal test killed **2/2** mutations. Removing the editor guard let Ctrl+F open behind the modal; removing the shell hold let the global palette open after focus escaped. `docs/evidence/tt95-modal-mutants.log` records both specific detections. After restoration, the complete Slides/browser suite passed **7/7**, and a sequential 12-suite development recheck passed **81/81** including recipe HTTP/races/browser, register audit, earlier photo/queue cases, privacy dispatch, test safety and Slides (`docs/evidence/tt95-post-mutation-regression.log`).

## Final verification and delivery

The latest TypeScript check, ESLint for changed TT95 server/editor/privacy/seed and accessibility-test files, shell syntax checks, Python mutation-runner compilation and `git diff --check` passed. This is a scoped lint result, not a whole-repository lint pass; the most recent global lint was 182 errors and 18 warnings.

### Production gate and accessibility investigation

The repaired application built successfully for production. A separate 68-suite run against a fresh disposable PostgreSQL database and production server completed **66/68 suites, 477/479 cases, exit 1** (`docs/evidence/tt95-production-gate.log`). The remaining failures were:

- **Privacy:** encryption **48 MB/s**, decryption **48 MB/s**, below the unchanged 50 MB/s encryption gate. Save latency was not reached (`tt95-production-e2e-privacy-failed.json`, `tt95-production-privacy-bench-failed.json`). The earlier 42 and 44 MB/s failures remain; no speed repair or threshold change is claimed.
- **Accessibility:** `e2e-a11y` **8/9**, reporting a large-text shelf icon at **30px** rather than the expected larger size (`tt95-production-e2e-a11y-failed.json`). The exact selected test passed 3/3 in separate runs; this did not erase the aggregate failure. A forced Playwright schedule held `/api/settings` and observed **30px before settings, 48px after 200% hydration**, demonstrating a way the old test's immediate measurement could fail; it does not prove that this was the actual cause of the gate failure. The test now waits for the saved scale before measuring, while still asserting the icon size. The full accessibility suite then passed **9/9**, the forced schedule **1/1**, and test-safety **4/4** (`tt95-a11y-safety-recheck.log`). An initial injected-delay experiment failed both old and changed tests before reaching the icon assertion; a second had both pass; both inconclusive attempts are retained. The product still initially renders at the default scale until settings load.

The preview is a production server on port 3000 backed by its own separate disposable database. Local HTTP checks returned 200; real Chromium initialized the shell without page errors and rendered visible controls. The first smoke incorrectly waited for an empty hidden toast region to be visible and timed out; its corrected smoke passed (`tt95-preview-smoke*.log`). The proxied external HTTPS URL itself and physical devices were not independently verified here. The regression server uses a separate database on port 3001 so ordinary preview interactions do not modify the gate database, although shared machine load could still affect timing.

### Expanded 69-suite gate (completed during TT96)

After the test adjustment, an expanded, sequential production run on a new separate disposable database **failed 65/69 suites, 474/480 cases, exit 1** (`docs/evidence/tt95-final-production-gate.log`). All 69 suites printed a summary. Four suites failed:

- Tabletop **13/15**: a two-card fan assertion observed three rotations, and the desktop context menu was intercepted by the dock.
- Files **11/13**: embedded terminal follow-folder text did not appear before the timeout, and axe reported insufficient contrast for a selected file's server badge.
- Accessibility **8/9**: the all-themes test timed out waiting for spreadsheet cell A2. The earlier icon-scale case passed in this run.
- Pointer fallback **5/6**: the right-button gesture test timed out waiting for the Launcher dialog.

Detailed unmodified failure JSON is retained as `docs/evidence/tt95-final-e2e-*.json`. All six named cases passed when selected separately (**2 + 2 + 1 + 1**), without overwriting the full-suite JSON (`docs/evidence/tt96-prior-gate-failure-investigation.log`); this does not establish the causes or erase the aggregate failure. In this run the unchanged privacy suite **passed 16/16**, with encryption **55 MB/s**, decryption **64 MB/s**, and median host/private saves **33.1/49.4 ms** against the existing `private ≤ host × 1.3 + 8 ms` gate (`tt95-final-privacy-bench.json`). That is a real passing measurement, not a demonstrated performance fix: the earlier 42, 44 and 48 MB/s results and latency failures remain evidence of variability and unresolved reliability.

A draft PR is open at https://github.com/jyvplay/OST/pull/3. Regenerating the mixed-date ledger/static endpoint, resolving the newly exposed failures, final delivery and any actual merge result remain outstanding. TT95 established no ten new Class A promotions.
