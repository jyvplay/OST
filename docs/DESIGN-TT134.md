# TT134 — finish the carried work, verify the implementation, and keep the gaps visible

> **Historical checkpoint:** its accepted-zero state was subsequently completed in TT135. See [the TT134 workflow release report](REPORT-TT134-WORKFLOWS.md) for the separately audited 20/20 carryover decision; these are not TT135 additions.

**Date:** 2026-11-01, America/New_York. Some artifacts have 2026-11-02 UTC timestamps.
**Branch:** `arena/723a3a13-ost`. **PR:** [#17](https://github.com/jyvplay/OST/pull/17), to remain open.

## Delivery verdict

- The **20 TT133 capabilities** are carried work, listed individually below, not twenty additional TT134 features.
- **Genuinely additional TT134 Class A feature completions accepted: 0 / requested at least 20. The additional-feature target is not met.** Repairs, new tests, a migration drill, two original vector marks, and faster verification are not relabeled as twenty new features.
- The strongest artifact is the actual Notes/Find implementation, repaired Writer ownership/DOM behavior, an explicit legacy Notes migration, native Chromium/PostgreSQL/OpenSSH evidence, and measured exact-oracle improvements. It is not a universal complete OS, a hardware certification, or an unrestricted licensing certification.
- Source-3 regression: **17 suites, 275 passed, 0 failed**, including 94 initial-view captures; cold PostgreSQL migration **7/0**. After the later repairs, latest passing affected-suite executions form a **129/0 composite**, and the final compiled-source network/disclosure/geometry/density/ledger checks passed **36/0**. These overlapping sets are **not added together** or promoted to a new full expanded run.
- **All 47 apps were visually reviewed at both tested window sizes** (94 initial views, sixteen contact sheets). There are remaining density/scrolling concerns and device/external-service gaps. See [the full per-app review](REVIEW-TT134.md).
- The expanded source-4 gate **exited 1: 789 passed / 4 failed across 90 suite executions (86 distinct)**. Its failures and subsequent affected reruns are retained below; they are not rewritten as a green full gate. Final reviewed-source checks are tracked separately.

## A. Exact objects, access, resources, success conditions and boundaries

### A1. Original request versus the artifact actually constructed

Let `R` be the real feature register returned by `/api/features`; `R` currently contains **627** rows. Let `C133` be the twenty carried rows `NT-08…18`, `SR-13…19`, `SV-02…03`. Let `N134` contain genuinely additional capabilities implemented and verified this turn, excluding `C133`, inherited features, tests, bug fixes, and cosmetic changes. The requested quantitative condition was `|N134| >= 20`; the accepted set here is **empty**. This is an unmet target, not a proof that another twenty capabilities are impossible.

The stronger original outcome also quantifies over every relevant feature, valid input, user-visible path, permitted device/environment and concurrent operation schedule. Neither 275 passing checks nor a green build establishes that universal quantifier. Hardware/protocol and partial rows are not silently upgraded to make it appear true.

The bounded engineering object comprises:

1. Notes records `(id, revision, title, body, tags, pinned, updatedAt)`, selected editor snapshots, window-scoped recovery drafts, title-based wiki-links, saved-ID backlinks, and source-mapped Markdown controls.
2. Search inputs, bounded public index entries, client-local Private search, recent queries, portable profiles, and an explicit transactional index-maintenance operation.
3. Writer document models, rendered DOM/projections, save acknowledgements, recovery files, modal ownership and independent saved OOXML bytes.
4. Real HTTP routes, PostgreSQL tables/locks, an actual OpenSSH peer, native Chromium storage/workers/RAF, independent file-format tools, and the recorded evidence.

Notes revision checks are **row-lifetime/cooperating-client compare-and-swap**, not protection against an external writer deleting/recreating the same ID. Recovery is **this tab/window identity**, not cross-device recovery. Search sorting/filtering is over the returned set, not an unbounded global result set. A browser media capability is not an Android/native system privilege.

### A2. Important finite parameters

| Object | Enforced/documented boundary |
|---|---|
| Notes | title 500, body 1,048,576, tags 2,048 UTF-16 code units; strict Unicode/field/revision validation; stale cooperating writes return 409 |
| Note import | 1 MiB UTF-8 input, native file control; not equivalent to the UTF-16 body limit |
| Drafts | 300 ms persistence debounce; seven-day draft eligibility; same tab + window/note identity; actual storage can refuse writes |
| RAM volume | 64 entries / 64 MiB serialized data, **not** a process-heap ceiling |
| Markdown | 5,000 rendered source lines, explicit outline/preview boundary; fences retain source meaning |
| Public text index | first 50,000 Unicode code points per body; at most 50 returned text hits; no general binary text-extraction claim |
| Metadata search | 32 files/page, 262,144 stored string units/file, 4,096 fields, depth 24; continuation/skipped-content limitations remain visible |
| Profiles/history | 30 profiles, 512 KiB portable JSON, 20 recent searches; local plaintext profiles need explicit consent for Private queries |
| Result filtering | native worker; bounded inputs/results; 150 ms debounce and a one-second termination timer, not a real-time deadline under arbitrary suspension/load |
| Maintenance/migration | four-second lock timeout, fifteen-second statement timeout; neither is a whole-transaction/global latency bound |
| Visual study | real Chromium; viewports 1500×960 and 900×960, bounded desktop windows; not every phone width or hidden tab/state |

### A3. Actual runtime, not a fictional tool inventory

Observed `os.availableParallelism() = 2`, `os.cpus().length = 2`, RAM **4,131,278,848 bytes**. There were no independent coding/research agents, theorem provers, proof assistants or simulators used. Parallel tool calls and two child test processes are not independent agents.

| Tool/system | Actual use |
|---|---|
| Node 22.22.3; TypeScript 5.9.3; tsx 4.23.15 | actual execution/transpilation; root application/config typecheck plus a new strict 14-entry TT133/TT134 MTS check and its dependency graph. Root `tsconfig.json` does **not** include `.mts`; no all-test-script semantic-typecheck or behavioral-proof claim |
| Next 16.4.3 / Turbopack; React | real production compilation and served application, not a static mockup |
| ESLint 9.39.4 | whole-tree diagnostics, content-keyed cache, actual same-metadata source mutation attack |
| Chromium 143.0.7499.0 / Playwright | real DOM, keyboard/mouse, Web Storage quota, RAF, Web Workers, downloads, screenshots and HTTP interactions |
| PostgreSQL 16.2 | real disposable application DB, real locks/rollback, independent clients, owned cold migration DB and an actual unsafe ID-reuse witness |
| OpenSSH 9.2; OpenSSL 3.0.20 | real sshd/client/key fingerprints/PTY/SFTP and native cryptographic tooling; key material stays in ignored `.cache` |
| Python, Pillow, MuPDF/PDFium, PyHanko and repository office oracles | executed native format/raster/ZIP/XML checks; installed test-tool pins and external input provenance are recorded |
| `git`, `gh`, GitHub/PyPI HTTP access | actual local inspection, primary-reference retrieval, PR/branch operations; no invented web search or inaccessible service test |
| GCC / make | found on PATH, **not invoked as compilers for this work**; a PostgreSQL version string mentioning GCC is not our own C build |

The [runtime discovery receipt](evidence/tt134-runtime.json) records command paths, available-but-unused GCC/g++/make, unavailable-on-PATH prover commands, actual versions and the source-worktree digest. `sshd` was invoked by its absolute `/usr/sbin/sshd` path, even though it is not on this shell PATH. This is not an exhaustive inventory of every installed binary.

Browser-facing application requests remain relative/same-origin; sandbox loopback addresses in Node test drivers and the real local SSH peer are not shipped as cross-service browser URLs. The production preview binds `0.0.0.0:3000`. Stateful browser suites run sequentially. CPU-heavy performance trials were not overlapped with builds/browser gates.

Adjacent, non-equivalent problems include native Android DocumentsProvider/SAF, OS-wide capture/notifications/clipboard, physical audio routing, Cast/AirPlay receiver protocols, installed file/protocol association, exact arbitrary Office fidelity, secure host erasure, and offline revocation. A PWA substitute does not complete those canonical contracts.

## B. Hypotheses, evidence thresholds and baseline

### B1. Working hypothesis ledger

| State | Claim | Evidence / boundary |
|---|---|---|
| **H+ bounded** | The twenty carried Notes/Find contracts operate through their implemented real paths | core 23, HTTP 13, Notes/Find 27, boundary 7, ownership 6; explicit per-row mappings below |
| **H+ bounded** | Writer's repaired cross-paragraph rendering/save ownership survives the witnessed late-write schedule | actual PostgreSQL block, close timeout, Cancel, newer edit, two acknowledgements and independent ZIP/XML exact-text readback |
| **H+ bounded** | The legacy Notes schema can be upgraded without losing the tested legacy data | cold owned database, real DDL lock refusal, rollback, default/CAS/idempotence and background-error-free cleanup, 7/0 |
| **H+ measured** | The exact raster implementation and warm lint reuse dominate their measured reference medians here | paired results, unchanged RGB/input hashes/bounds and identical lint diagnostics; scope and cold/dirty costs in G |
| **H− witnessed** | Revision 1 is an incarnation-safe token across external same-ID deletion/recreation | the real SQL drill admits the stale revision-1 write after recreation; this safety claim is rejected |
| **H− delivery** | Twenty other genuinely new TT134 Class A features were completed | zero additional accepted; inherited/carried work is not counted twice |
| **H− witnessed** | A green typecheck/lint/build implies a green expanded full gate | the real source-4 run failed four suites; both receipts are retained |
| **H+ bounded** | Browser can distinguish the observed actual DNS failure from GitHub's measured XFO denial | four native wide/compact UI cases, real second DNS-failure requests, unchanged alternatives; not a proof of every CSP/redirect/peer |
| **H− interpretation** | Every initial view reached network-idle / every window has zero overflow | 92/94 settled; two Photos views did not; Sheet overflow 289/575 px was retained |
| **H∂** | All apps, devices, schedules, licenses and original OS-spec features are production-complete | not established; 84 partial/probe and 24 blocked rows remain; initial screenshots and package metadata do not close these gaps |

### B2. Acceptance discipline

A source read or typecheck is **implementation/static evidence**. A pure test checks the actual pure function on the listed inputs. A browser-kernel test runs the production algorithm in real browser primitives but is **not** deployed-app E2E. Real HTTP/DB tests establish the tested server path. Native UI tests establish the exercised deployed control path. Independent parsers/peers/readback strengthen selected claims; they still do not quantify over every input/device.

The twenty carried rows need a working implementation plus their actual primary paths and negative/adversarial coverage. Controlled historical fixtures in the wider repository are not substituted for new native hardware/peer acceptance. No fabricated camera/receiver, intercepted fake API response, replaced worker/scheduler/storage or private React-state injection is used as the acceptance of the new ownership/Notes/Find work. Public application-state API setup creates test windows; that is disclosed and is **not** proof of every native Launcher action.

The generated ledger's `fully tested` means at least one passing full-tagged test, with incomplete rows mechanically capped at partial. It is not an independent universal certification. Mixed-date saved results must be distinguished from a freshly executed gate.

## C. Retrieved frontier, exact hypotheses and licensing

Primary retrieval manifests preserve repository, exact commit/blob, SHA-256, byte count and retrieval time: [`tt133-research.json`](evidence/tt133-research.json), [`tt134-research.json`](evidence/tt134-research.json), and [`tt134-native-office-corpus.json`](evidence/tt134-native-office-corpus.json). These are real GitHub API retrievals/source review, not an assertion of an exhaustive literature search. Additional actual issue-search queries and installed-version Pillow source/license retrieval are preserved in [`tt134-frontier-search.json`](evidence/tt134-frontier-search.json). The initial GitHub query returned 422 for missing `is:issue`; the corrected searches returned 26/17/35 matches for menu-focus/dialog-keyboard/RGB-getbbox respectively. Only three results per query were retrieved; this is not an exhaustive frontier survey.

1. **React ref/effect publication.** Reviewed React docs at `6f7728f0a2a6e838e2dff10c94e3885edf0dfde0` / `81a0842eb60f53c3f97e56f6c4d9e8b18bf846d8`. A ref can carry current imperative ownership; publishing it in a later effect is not the same as synchronous command availability. The open interface is our commit/command publication, not a theorem that React makes arbitrary async application state linearizable.
2. **PostgreSQL MVCC.** Reviewed PostgreSQL 16 concurrency material at `f8f83d463d4294f72092d83ea12cf7848387cad2`. A single conditional update under cooperating row locking/rechecking can reject an old revision in that row lifetime. Required hypotheses include the same live row, participation in the revision protocol and a correct atomic predicate. MVCC does not supply an unchanging incarnation token or whole-system serializability for our application.
3. **Playwright readiness.** Reviewed real documentation/issues at `749a50eebd0f837b1cfd8a4f7e953992fd4e5215`, including issue 22897's readiness distinction. A named control/actual acknowledgement is stronger for a specific action than assuming network-idle means application readiness. An issue report is not proof of our bug's cause.
4. **Worker termination.** Reviewed MDN source at `b83072c7ff2aa062c04057e11d0d93458c252a13`. Termination is a real mechanism for an isolated runaway regex; the timer that invokes it can still be delayed. No universal one-second wall-time theorem is claimed.
5. **[W3C menu button](https://github.com/w3c/aria-practices/blob/0f765e4dc33e966026114ac12a8380db1de3b787/content/patterns/menu-button/menu-button-pattern.html)** and **[menubar](https://github.com/w3c/aria-practices/blob/0f765e4dc33e966026114ac12a8380db1de3b787/content/patterns/menubar/menu-and-menubar-pattern.html)**: Enter/Space, Escape/context restoration and activation behavior informed focus ownership. A command that intentionally focuses the editor must not have that focus stolen back by unconditional menu cleanup.
6. **[W3C modal dialog](https://github.com/w3c/aria-practices/blob/0f765e4dc33e966026114ac12a8380db1de3b787/content/patterns/dialog-modal/dialog-modal-pattern.html)**: inert background, focus containment, initial/return focus and Escape. Guidance supplies a contract to test, not a whole-system proof. Native modal shortcut attacks are below.
7. **[MDN definition lists](https://github.com/mdn/content/blob/a0ba038b5e77c06c820e90dc39133acb70dd476a/files/en-us/web/html/reference/elements/dl/index.md)** informed Word Count's valid `dt`/`dd` grouping and keeping action controls out of the definition list. Semantic repair is distinct from modal ownership.
8. **Apache POI independent input corpus**, pinned to `6327f056ba3cfdae326a0261a236460592b80f5c`: actual `bug57031.docx` (55,889 bytes, SHA-256 `bbd88b16a90c65b46e1a6922f7017e8d4cc0bc8f62ac28619c2d367d37d6754b`) and `issue_51265_3.docx` (529,742 bytes). Retrieved test inputs are not copied production implementation code. Their identities are recorded; large inputs stay outside Git.
9. **PyPI package metadata** for PyMuPDF 1.28.0, 1.27.2.3 and 1.26.7 was actually retrieved. The chosen pin is test tooling. A metadata-print exception in the previous 2.0 layout shim did not establish that layout/4llm was absent or unlicensed. Corrected installed-file/dependency observations and bounded cross-pin fidelity are recorded, not a fabricated licensing verdict.

10. **Installed Pillow 13.0.0**, source/license pinned to `293218ad059d994baf1777d882911bed6a49704a`: [`Image.getbbox`](https://github.com/python-pillow/Pillow/blob/293218ad059d994baf1777d882911bed6a49704a/src/PIL/Image.py) trims when all channels are zero for RGB; alpha-channel behavior is explicitly different. Reviewed the body of [RGBA discrepancy issue #5914](https://github.com/python-pillow/Pillow/issues/5914), not just its title. The own helper refuses RGBA/L/P; an additional real seven-case mode/one-pixel RGB threshold check passes ([log](evidence/tt134-raster-mode-boundary.log)). This supports the exact RGB-only interface, not arbitrary-mode equivalence. Reviewed [W3C menu/dialog issue #1409](https://github.com/w3c/aria-practices/issues/1409) as a real focus-return ambiguity; it is an issue, not normative resolution. The APG contract and native ownership tests supply the acceptance basis.

### C1. License boundary

No new production dependency was introduced; new algorithms and the two updated marks are original implementations. [`tt134-production-license-inventory.json`](evidence/tt134-production-license-inventory.json) scans **86 production lockfile entries**, including optional platform variants:

- MIT 39, Apache-2.0 19, ISC 6, BSD-2-Clause 2, BSD-3-Clause 1, 0BSD 1, Unlicense 1;
- OFL-1.1 1, CC-BY-4.0 1, MPL-2.0 1;
- LGPL-3.0-or-later 10, Apache-2.0 AND LGPL-3.0-or-later 3, Apache-2.0 AND LGPL-3.0-or-later AND MIT 1.

This inventory is metadata, not a legal opinion, full source/license/NOTICE verification, deployed-artifact SBOM, or exhaustive asset audit. The tree is **not wholly permissively licensed**. Permissible commercial use of open-source software is not the same as absence of copyleft/attribution obligations. MuPDF/PyMuPDF test tools have AGPL/commercial licensing; PDFium and its dependencies also retain their own notices. PyHanko's separate full provenance/license review was not established here. Do not market this as a completed all-use-cases licensing certification.

## D. False-solution shapes rejected, including the modal shortcut test

| # | Attractive but false shortcut | Actual falsifier / disposition |
|---:|---|---|
| 1 | Count the TT133 twenty again as TT134's twenty others | Disjoint accounting: twenty carried, zero additional accepted |
| 2 | Count tests, bug fixes, a migration or icons as new product features | Those artifacts are listed separately, never added to `N134` |
| 3 | Green TypeScript proves behavior/completeness | Actual native/DB/oracle tests and explicit partial rows are still required |
| 4 | A full-tagged subtest completes an explicitly partial canonical row | Ledger caps partial/probe/skeleton rows at partial |
| 5 | Zero selected tests means success | Harness exits nonzero on zero selection; the mistaken early filter was not acceptance |
| 6 | A fake bridge/stream/receiver proves the physical protocol | Actual OpenSSH peer accepted only for tested SSH operations; physical receiver/device gaps remain |
| 7 | Network-idle proves the editor/model is ready | Native named controls, actual status and independent output checks; two unsettled Photos captures disclosed |
| 8 | A native keypress must be correct because it is native | Writer's native Ctrl+End exposed a stale DOM; real key input did not excuse incorrect rendered/model correspondence |
| 9 | Comparing a model with its own serializer is an independent oracle | Recovery ZIP/XML bytes were opened independently and required exact newer text |
| 10 | Draft titles define backlinks | Reproduced missing/shadow backlink; saved record ID/title identity now governs reverse edges |
| 11 | A ref filled by an effect is always available to first-load commands | Fresh-load Orbit actions exercise no-edit publication; not merely an after-typing happy path |
| 12 | Save→Duplicate may reuse an old revision or original body | Native tests require exactly acknowledged new revision/body and Unicode-safe copied title |
| 13 | A late successful save may close whatever window is current | Real lock/timeout/Cancel/new edit/two acknowledgements attack requires no late close and exact newer recovery |
| 14 | Revision equality protects external delete/recreate ABA | Actual SQL same-ID witness disproves cross-incarnation safety |
| 15 | Four-second lock timeout is a transaction deadline | Real lock refusal measured; separate statement/transaction/scheduler scope retained |
| 16 | Screenshot count proves all feature/state/device behavior | 94 initial views reviewed; hidden flows and physical devices are not inferred |
| 17 | Faster sampling/luminance bounds preserve the RGB oracle | Every RGB channel at every pixel, exact `<230` predicate, all output hashes/bounds and 18 colored boundary cases |
| 18 | Warm cached lint may skip changed same-mtime/same-length files | Real source mutation produces the same diagnostic/exit as uncached lint; removal restores reference diagnostics |
| 19 | Removing a package after a failed metadata print proves legality/absence | Correct metadata and installed-file inventory; legal boundary remains open |
| 20 | Six successful assertion messages make the migration suite pass | Initial cleanup really exited 1 (57P01); repaired real drain/non-forced cleanup and new background-error assertion reran 7/0 |
| 21 | A termination timer proves universal one-second responsiveness | Actual worker/RAF checks are bounded observations; arbitrary load/suspension is not covered |
| 22 | Hide warnings or remove a difficult test to obtain a green report | All six lint warnings remain reported; independent exact-text/lock/oracle assertions were retained |

**Modal-shortcut test:** native Word Count interactions press **Ctrl+Space** and **Alt+F4** while the dialog owns input. They must not open the underlying palette or close the document window. The native TT81 suite passed **7/0**, including semantic count content, focus/selection and shortcut isolation. This tests actual propagation/ownership; a static `<dialog>`/ARIA attribute or merely closing with a pointer would not establish it.

## E. Mechanism-distinct approaches and their artifacts

These are complementary engineering branches, not six renamed copies of one approach. “Established” below means the stated finite observation/invariant reasoning, not an unexecuted formal proof.

### E1. Atomic storage/versioning and cold migration

- **Construction:** validated Notes mutations with an atomic expected-revision predicate; explicit SQL migration, lock/statement limits and owned real database drill.
- **Artifacts:** `src/app/api/notes/route.ts`, `src/lib/note-model.ts`, `src/db/migrations/tt133-note-revisions.sql`, `scripts/tt134-note-migration.mts`, [migration evidence](evidence/tt134-note-migration.json).
- **Established:** tested legacy rows survive; real DDL lock refusal rolls back; repeated migration is idempotent; default revision and cooperating stale-write rejection operate. A conditional increment cannot accept an old revision of the same monotonically advanced live row, provided all writers use the predicate.
- **Exact gap:** that reasoning assumes the same incarnation and cooperating writers. External same-ID recreation was actually unsafe; no tombstone/incarnation token was implemented.
- **Cheapest next falsifier:** independent client deletes/recreates a live Notes ID then submits a stale browser token through the application path. The SQL-layer attack already rejects a stronger safety claim.
- **Local/original gap:** data-preserving Notes upgrade is not a safe migration framework for every table/provider or a native OS-wide storage contract.

### E2. Synchronous command/snapshot ownership

- **Construction:** selected editor snapshot plus synchronous last-committed publication; Orbit commands resolve their own acknowledged current record rather than stale list/editor state. Confirmation binds the revision the user actually consented to.
- **Artifacts:** `Notes.tsx`, `notes/NoteEditor.tsx`, `scripts/e2e-tt134-ownership.mts`, [source-3 ownership log](evidence/tt134-e2e-tt134-ownership-third.log).
- **Established:** first-clean-load actions, Save→Pin/Unpin, Save→Duplicate with a 500-unit surrogate-boundary title, cancelled deletion, independent winner during confirmation, and a later legitimate delete.
- **Exact gap:** finite tested interleavings, single tested browser and participating API clients; not proof over arbitrary third-party code or all schedules.
- **Cheapest falsifier:** issue a genuine competing update after the real delete confirmation opens, before pressing Delete, and require a 409/preserved winner.
- **Local/original gap:** this closes these Notes command paths, not every app's ownership or all cross-device conflict handling.

### E3. Stable identity and source-mapped document controls

- **Construction:** backlinks derive from the saved target ID/title, refuse ambiguous saved titles, and return none for a missing ID. Shared Markdown parsing retains source-line/task-marker mapping and fences.
- **Artifacts:** `note-links.ts`, `note-markdown.ts`, `NoteEditor.tsx`, `tt133-core.mts`, `e2e-tt133-notes-find.mts`, [before repair failure](evidence/tt134-backlink-identity-before.log).
- **Established:** reverse links survive unsaved renames, including a draft that shadows another saved title; ambiguity/missing target do not invent edges. Native outline/task/extract/import/download paths preserve the listed literal/Unicode data.
- **Exact gap:** title-addressed forward links are not immutable global identifiers; parser/preview limits remain; HTML safety tests do not certify arbitrary extensions or every Markdown dialect.
- **Cheapest falsifier:** rename the draft to another existing title while keeping the target ID; inspect both forward/reverse destinations and saved data.
- **Local/original gap:** useful bounded Markdown navigation is not a universal knowledge-graph/database implementation.

### E4. Writer DOM/model invalidation and asynchronous close ownership

- **Construction:** capture whether replacement spans multiple paragraphs **before** collapsing the range; invalidate the whole DOM when paragraph removal changes topology. Save/close acknowledgement remains bound to its own operation/generation; Cancel/new edits do not transfer consent to an older save.
- **Artifacts:** `Writer.tsx`, `word-ui.ts`, native ownership test, Writer projection suite, [diagnostic readback](evidence/tt134-native-writer-caret-diagnostic.json), [failure log](evidence/tt134-writer-lock-second.log).
- **Established:** the actual stale-DOM cause was observed, then the real lock/timeout/Cancel/edit/unlock schedule passed with **two acknowledgements**, no late close and **independent exact newer ZIP/XML text**. Source-3 attack duration was **7,643 ms**. `domToPos`/`posToDom` were inspected but not changed as a speculative cure for this bug.
- **Exact gap:** no arbitrary OOXML/rendering equivalence theorem, all-browser selection proof or universal storage latency bound.
- **Cheapest falsifier:** native select-all/type across the seeded multi-paragraph document, then native Ctrl+End/new text; independently inspect saved text, not just the visible prefix or model counter.
- **Local/original gap:** a repaired editor path is not a complete Word implementation. External POI/office tests strengthen specific format paths only.

### E5. Bounded isolation and privacy-preserving local state

- **Construction:** actual worker for potentially runaway result regex; epoch invalidation prevents a cleared history being resurrected by a late result. Strict profile validation precedes atomic replace; Private automatic history is purged, including malformed legacy aliases and corrupt JSON.
- **Artifacts:** `public/workers/`, `use-search-filter.ts`, `recent-searches.ts`, `saved-searches.ts`, native boundary/Notes-Find suites, actual-browser kernel provenance.
- **Established:** native sessionStorage is actually filled until QuotaExceededError (not overridden); editing/export remains possible. Real localStorage purge/consent/cancel/import paths, worker timeout and continued main-thread RAF are exercised. Browser kernels are explicitly not app E2E.
- **Exact gap:** tab-local plaintext storage can be inaccessible/cleared; timer scheduling can be delayed; Private profile consent is not encryption; heap/power are not globally bounded by serialized byte counts.
- **Cheapest falsifier:** fill native storage, edit, export exact unsaved bytes; lock a genuine search response, clear history, release the lock and inspect the actual key/UI.
- **Local/original gap:** no OS-wide secure storage, secret erasure or all-device synchronization guarantee.

### E6. Independent peers, parsers and native formats

- **Construction:** real sshd/client with independent fingerprint, actual application SSH bridge/PTY/SFTP, and independent ZIP/XML/PDF/office input/output checks.
- **Artifacts:** `e2e-tt133-openssh.mts` (**7/0**), independent `ssh-keygen`/CLI probe (UID 1001), POI corpus manifest, Writer49 **6/0**, Writer73 **4/0**, Office **11/0**, TT81-core **13/0** in source 3.
- **Established:** real Ed25519 trust-once, ANSI/Unicode, clipboard/TTY distinction, real `stty` size after resize, binary SFTP/file readback and disconnect. Independent PDF dimensions/signature/raster and OOXML text checks execute native tools, rather than asking our own renderer whether it agrees with itself.
- **Exact gap:** one tested SSH peer/algorithms/environment, no physical camera/cast/audio receiver, and finite format corpus.
- **Cheapest falsifier:** mutate/rename one selected real remote binary file, download and compare its hash to an independent disk read; or open the second pinned independent DOCX.
- **Local/original gap:** real protocol/format subsets do not complete every network service, native OS privilege or file-format variation.

### E7. Exact faster repeating verification

- **Construction:** own Pillow LUT/getbbox scan applies the original predicate at **every** RGB pixel; content-keyed whole-tree lint reuses unchanged work but fails closed on graph/config/content changes.
- **Artifacts:** `scripts/oracles/ink_bounds.py`, `benchmark-raster-ink.py`, `benchmark-lint.py`, [paired raster](evidence/tt134-raster-benchmark.json), [paired lint](evidence/tt134-lint-performance.json).
- **Established:** same rendered RGB bytes, dimensions and inclusive bounds on all eight fixed inputs and 18 color cases/run; full diagnostic hash/exit/count equality; a real same-path/mtime/length edit is detected. Significant local median improvements in G.
- **Exact gap:** fixed workload/environment; cold/changed dependency keys still require full lint. No electrical power sensor, universal Pareto theorem or total-memory accounting.
- **Cheapest falsifier:** one non-gray near-threshold pixel or same-metadata diagnostic-bearing edit; both families were actually executed.
- **Local/original gap:** two faster verification mechanisms do not prove that every repeating script/task got faster.

### E8. Human visual audit plus original vector work

- **Construction:** actual initial app views at two sizes, font readiness, unhandled-error recording, retained overflow/settling metadata; manually read all sixteen contact sheets. Two new original inline vector marks: indexed-document Find and ring-bound bookmarked Notes, with unchanged palette/label semantics.
- **Artifacts:** [94-view metadata](evidence/tt134-visual.json), [per-view hashes/review](evidence/tt134-visual-review.json), [47-app review](REVIEW-TT134.md), `AppIcon.tsx`, `tt134-icon-review.mts`.
- **Established:** all 47 initial surfaces inspected, not just the handful being edited. Existing folded details/More menus, ellipsized Notes titles, clear empty states, original shape/layout graphics and remaining density are documented.
- **Exact gap:** this is not all states, assistive technologies, physical devices, phone widths or all 627 features. The separate final-build mark/compact-toolbar suite passed **5/0**, and all five supplemental captures were manually viewed. They are not new Class A features.
- **Cheapest falsifier:** compact Contacts must actually reach the initially clipped Duplicates command; native browser scrolling/click result is checked rather than declaring the screenshot clean.
- **Local/original gap:** the all-app review is complete for these initial views; the user's global “less wordy/all fully functional” result is not established.

## F. Adversarial repair record and fresh regression

### F1. Failures were real and retained

| Failure / rejected candidate | Repair / fresh patch-specific attack |
|---|---|
| Saved-identity backlink disappeared during draft rename | Use saved ID/title, return none for missing ID; additional draft-shadowing-another-title attack included in the full 27-case native Notes/Find pass |
| Save→Orbit paths used stale/unpublished ownership; 500-unit title could split a surrogate pair | Synchronous acknowledged record publication and surrogate-safe generated title; fresh-load actions + exact revision/body/copy + genuine competing writer attack, 6-case ownership pass |
| Writer model removed paragraphs but DOM retained them; native End typed into stale content | Capture cross-paragraph state before collapse and invalidate topology; independent exact newer ZIP/XML check retained, not weakened to prefix matching |
| Menu activation cleanup could steal intentional editor focus | Conditional refocus and try/finally cleanup; native formatting/selection and modal keyboard attacks rerun |
| Corrupt recent JSON could retain plaintext Private queries | Distinguish parse failure from storage-read failure; actual native key contains corrupt plaintext before mount, is removed after mount; public neighbor preserved |
| Migration printed six assertions then exited 1 during forced cleanup | Capture background driver errors; `pool.end`, inspect real `pg_stat_activity` up to 5 s, non-forced drop of the owned DB, assert no driver errors; fresh drill **7/0** |
| “CAS solves external ABA” | **Not repaired or accepted**. Native SQL same-ID delete/recreate remains an explicit unsafe witness |

The initial failed migration log is sanitized in [`tt134-note-migration-first.log`](evidence/tt134-note-migration-first.log); the verbose driver dump stays in ignored cache, not a claimed success. Current [migration log](evidence/tt134-note-migration.log) and JSON include the fresh successful run and the rejected cross-incarnation claim.

### F2. Source-3 sequential regression (completed, exit 0)

Logs are `docs/evidence/tt134-<suite>-third.log`.

| Suite | Passed / failed | Actual layer |
|---|---:|---|
| tt133-core | 23 / 0 | production pure functions |
| tt133-projections | 6 / 0 | actual detached Writer projections |
| e2e-tt134-ownership | 6 / 0 | actual deployed UI + real concurrent PostgreSQL/API writes |
| tt133-http | 13 / 0 | real HTTP + locks/rollback/readers/source preservation |
| e2e-tt133-notes-find | 27 / 0 | real deployed Chromium interactions/downloads/worker |
| e2e-tt133-boundaries | 7 / 0 | real quota/storage/privacy/profile boundary paths |
| tt133-browser-kernels | 7 / 0 | production kernels in native browser primitives; not app E2E |
| e2e-tt133-openssh | 7 / 0 | actual UI/bridge/sshd/PTY/SFTP |
| integration | 25 / 0 | real server/application integration |
| e2e-office | 11 / 0 | real office UI/output paths |
| e2e-sheet-layout | 7 / 0 | real grid/layout/navigation/save/export |
| e2e-vector | 12 / 0 | native edit/resize/export, independent PNG dimensions |
| e2e-tt81 | 7 / 0 | native modal/format paths and shortcut attacks |
| e2e-tt49-writer | 6 / 0 | real Writer/independent corpus/output |
| e2e-tt73-writer | 4 / 0 | real Writer/independent corpus/output |
| tt81-core | 13 / 0 | independent native format/signature/raster oracles |
| tt134-visual | 94 / 0 | real initial captures; not 94 functional feature completions |
| **Total** | **275 / 0** | **17 suites** |

The cold migration adds seven separate checks, not seven more features. Earlier source-1/2 failures remain evidence of the rejected candidates, not current acceptance. A repaired candidate only earns the scope of the gates actually rerun.

### F3. Expanded full gate: collected failure, then bounded repairs

The expanded source-4 gate **completed, exit 1**. It ran **90 suite executions / 86 distinct suites**, **789 passed / 4 failed**. Repeated pure/browser suite executions are executions, not distinct capabilities. See the [unmodified main receipt](evidence/tt134-full-gate.json), [main log](evidence/tt134-full-gate.log), [suite-result snapshot taken before reruns](evidence/tt134-full-gate-results.json), and `docs/evidence/tt134-gate/` raw per-suite logs. Measured wall **1,560.803772081 s**, CPU **1,934.670662 s**. **666,672 KiB is the largest child peak RSS, not simultaneous aggregate memory.**

| Failed suite | Observed failure | Bounded repair and independent attack |
|---|---|---|
| `e2e-tt122`, 2/1 | Export all was inside the native closed More disclosure; the old test clicked a hidden control | Open the real summary, wait for the actual VFS write acknowledgement, then independently read `/notes-bundle.md`; no force click. Corrected rerun **3/0** includes a real persisted literal-`#`, Unicode title, count and every persisted title/body, plus media/Clock checks |
| `e2e-tt117`, 4/1 | Heading was incorrectly expected inside the statistics text | Keep exact 9 words/96 chars/2 sentences/one excluded code block; actually click Outline and its heading, verify the real preview heading in viewport. Whole suite **5/0** |
| `tt124-density`, 22/1 | Spec **12,574 > 12,400** | Native Questions & checks disclosure retains all 627 register rows and all twelve questions/statuses/pass criteria/fallbacks/results; compare the real DOM content to the actual APIs and use mouse/Enter/Space. Whole suite **23/0**, unchanged cap |
| `tt123-density`, 22/1 | Beam **303 > 300** | Shorten redundant labels/prefix only, retain receiver uncertainty, capability distinctions, all six unavailable-transport explanations and media control. Whole suite **23/0**, unchanged cap |

A separate confirmed UI defect was also repaired: the normal probe returned `unknown/status 0` for a genuine `.invalid` DNS failure, yet Browser previously called that a site refusal. It now shows **unverified / Embedding could not be checked**, says no framing policy was measured and keeps Re-probe/alternatives. Actual GitHub `DENY` continues to show the policy explanation. These are real server TLS/HTTP/DNS plus native UI checks, with **no intercepted transport, fake peer/device or private React-state mutation**. This is not universal CSP/redirect/peer verification.

**The first repair batch also exited 1**, not zero: **128 passed / 1 failed** in eleven suites, wall **555.426949598 s**, CPU **489.268134 s**, largest-child peak **654,040 KiB** (not aggregate). The new bundle oracle initially assumed `# title`, but the actual documented exporter stores `title: ...` in front matter. Production export was not changed to fit the test. The rejected oracle/log/result is retained in [the first repair-batch receipt](evidence/tt134-repair-reruns.json) and [log](evidence/tt134-repaired-e2e-tt122.log). After correcting the format expectation, a new persisted non-heading Unicode title and all-row independent readback passed; [fresh rerun](evidence/tt134-bundle-oracle-rerun.json), **3/0, exit 0**. Latest passing results across those eleven affected suites total **129/0 as a composite**, **not** one new expanded full-gate execution.

Other affected reruns in that batch: native Notes/Find **27/0**, ownership **6/0**, core **23/0**, axe **9/0**, Browser/Recall density **1/0** each (`tt122-density`, `tt117-density`), and the new review-repair suite **8/0**. The axe result covers its stated chrome/Files/Spreadsheet/theme checks, not every state of every app. Logs are `docs/evidence/tt134-repaired-<suite>.log`.

The new strict `scripts/tsconfig-tt134.json` covers **14 MTS entrypoints plus their imported dependency graph**; it is now part of `run-gate.sh`. The original root config excluded MTS. Its first genuine semantic check found an `Element.loop` assumption and an excess-property test literal; both test typings were repaired without weakening the actual media-loop/revision assertions. [Initial diagnostics](evidence/tt134-script-typecheck-before.log) and [passing targeted check](evidence/tt134-script-typecheck.log) are retained. This is increased verification power, not a claim that all historical MTS scripts were semantically typechecked.

Visual review of the ten source-5 repair captures found an actual Beam label/file-picker spacing issue. Those [manually viewed, hashed pre-spacing captures](evidence/tt134-review-repairs-before-spacing.json) remain separate. A small wrapping flex gap and a new native geometry attack were added. On the final compiled source, the new eight-case suite passed again, with a measured **8 px** label/control gap at both widths, and the stricter full 23-case density suite plus five compiled/live/source ledger checks passed: **36/0, exit 0**, [final receipt](evidence/tt134-final-native.json). Wall **62.901885501 s**, CPU **60.821597 s**, largest-child peak **631,660 KiB**, not aggregate. All ten [final captures](evidence/tt134-review-repairs.json) were manually viewed again. There was **no second expanded full-gate run** after the repairs.

### F4. Full staged-data hygiene, without altering the evidence

The first **fully staged** `git diff --cached --check` returned **exit 2**: newly staged verbatim psql/sshd/build logs contain padding/CRLF/final blank lines, and a Writer failure dump contains actual tab-only document lines. Earlier unstaged checks did not inspect these then-untracked files. [Collected diagnostic](evidence/tt134-staged-diff-check-before.json). Raw evidence was **not stripped or rewritten to fabricate a pass**. `.gitattributes` now exempts **only evidence `.log` data and `*-writer-failure.txt` diagnostics** from Git whitespace interpretation, not production/scripts. A real, temporary owned `src/lib` TS file with trailing space was then created, intent-to-added, and checked: **exit 2, trailing whitespace rejected**; it was unstaged/removed in `finally`. The full staged check under this explicit data policy returns **exit 0**. [Actual attack and attribute/exit receipt](evidence/tt134-whitespace-policy.json). The data-policy addition is delivery-only; all 1,390 recorded application/public/script/build input bytes remain unchanged.

## G. Measured work/CPU improvement, exact fidelity and limits

### G1. Paired exact raster experiment — completed, exit 0

Same pinned native tools and fixed eight-PDF inputs; AB/BA/AB, three trials per method, sequential on two CPUs. Both methods rasterize/read/check all output bytes. Original predicate: a pixel is ink iff `min(R,G,B) < 230`. Candidate maps each channel through an exact 256-value LUT, uses RGB `getbbox`, and converts exclusive upper bounds back to inclusive. No sampling, threshold change, grayscale approximation or reduced resolution.

| Median per eight inputs | Original nested Python scan | Exact Pillow candidate |
|---|---:|---:|
| Wall seconds | 4.917782147 | 0.189381261 |
| CPU seconds | 4.883777 | 0.159508 |
| Child peak RSS, KiB | 78,464 | 77,660 |

**25.9676× wall / 30.6178× CPU speedup** on this workload. Every input hash, dimensions, RGB SHA-256 and inclusive ink bounds match; eighteen colored/threshold-boundary cases per run also pass. [Raw paired results](evidence/tt134-raster-benchmark.json), [input manifest](evidence/tt134-raster-inputs.json).

A separate whole `tt81-core` observation changed **10.820375193 → 5.008674603 s wall**, **12.163780 → 5.918356 s CPU**, largest-child peak **176,064 → 174,740 KiB**, with 13/0 before-ready and after. **This whole-suite comparison changes both the scan and the dependency pin and is confounded; it does not isolate the pin's speed contribution.** The paired same-pin experiment above isolates the algorithm more cleanly.

### G2. Tool footprint and cross-pin fidelity

Test-only PyMuPDF is pinned **1.28.0**, PyHanko **0.35.1**; bootstrap records the versions. Removing the selected layout/4llm/ONNX dependency set and replacing the former PyMuPDF 2.0 installation reduced the sum of installed files for those **four distributions** from **191,197,782 to 66,669,555 bytes**: **124,528,227 bytes / 65.13%**. This is not the entire venv, whole container, production bundle or peak RAM.

All eight fixed PDF input hashes, dimensions, full RGB hashes and bounds were identical across the observed pin change; [bounded pin fidelity](evidence/tt134-raster-pin-fidelity.json). The actual observed package/engine versions were PyMuPDF **2.0 / MuPDF 1.28.5** → PyMuPDF **1.28.0 / MuPDF 1.29.0**. A lower wrapper version did not imply an older native engine. `pip check` passed. No arbitrary-document compatibility guarantee follows.

### G3. Full-tree ESLint — completed, exit 0

[Raw trials](evidence/tt134-lint-performance.json): cache-cold; alternating clean/warm trials; actual witness file, changed content with **same path, exact mtime and byte length**; cached-vs-clean dirty comparison; removal. Baseline source at this measurement contains **1,195 files, 0 errors, 6 warnings**, identical canonical diagnostic digest `f83c8bed09c7fd98ed9c4ea4a480f67ce1eaea5bf79a0bef9bc3bcd70f225ef4` for clean/warm/restored runs.

| Median | Uncached full tree | Warm content cache | Reduction |
|---|---:|---:|---:|
| Wall seconds | 65.334338 | 1.368981 | 97.905% |
| Child CPU seconds | 91.486516 | 1.614141 | 98.236% |
| Sampled summed RSS bytes | 1,585,537,024 | 346,984,448 | 78.116% |

Cold cache took **71.216451 s**, so cold execution is not claimed faster. Witness-prime/dirty cached runs took **69.773468/69.644579 s** because the changed dependency namespace fails closed into a full check. The dirty cached and uncached diagnostic hashes/exits agree, with one deliberate error; removal restores the original full-tree hash. New icon-review source added after this benchmark is subject to the final uncached lint, not retroactively represented as part of the 1,195-file measurement.

RSS is summed across live process descendants, sampled every 50 ms; shared mappings are double-counted and short peaks can be missed. Monitor CPU is recorded separately. OS page caches were not cleared. Measured warm medians locally dominate all three recorded dimensions; this is **not universal Pareto superiority**, not every edit workload, and **not an electrical energy/power measurement**. Lower CPU is useful work reduction, not a fabricated watt-hour number. Existing two-lane browser contention had previously failed to improve total time, so stateful browser gates remain sequential.

## H. Every-app visual review, wordiness and original graphics

See [REVIEW-TT134.md](REVIEW-TT134.md), [machine-readable observations/hashes](evidence/tt134-visual-review.json), and [contact-sheet index](evidence/tt134-visual-review-index.json). All eight wide and all eight compact sheets were actually viewed.

- **94 real initial captures; 92 network-settled, 2 Photos unsettled.** Unsettled is recorded rather than changed to “pass = settled.” The capture tests pass for real rendered content/no unhandled page error, a different predicate.
- **Sheet horizontal overflow is real: 289 px wide / 575 px compact.** The large grid is scrollable; it is not truthful to call this zero-overflow, or every column visible at once.
- Contacts' compact toolbar initially clips its later actions. CSS intentionally supplies horizontal toolbar scrolling (`.fs-toolbar` forces nowrap/overflow-x); this is not evidence the actions were deleted. Native reachability passed in the separate five-case final-build suite: Duplicates is genuinely scrolled into view, clicked and opens its real panel. All five supplemental screenshots were manually viewed. Discoverability remains a valid UX follow-up.
- Notes' long titles ellipsize with full tooltip, while Save/tags stay reachable. Source/preview controls use concise Outline/More groupings. Find folds saved profiles and diagnostic explanation. Critical limits, plaintext/secret warnings and platform blockers have not been removed just to lower a word count.
- Spec, Clock, Settings, Apps, Monitor and Backup remain dense. Rendered word counts **12,653 / 1,581 / 1,014 / 891 / 460 / 436** include off-viewport document text and select options, not simultaneously visible prose. These are not evidence of a global before/after word-count win.
- Two original inline SVG marks were newly drawn from scratch in `AppIcon.tsx`: indexed-document search and ring-bound bookmarked Notes. No external image service, copied artwork or added production asset dependency. Palette/accessible-label behavior is retained. They are **two graphic improvements, zero new functional Class A features**.
- Real test-generated documents/thumbnails/notes and an authentic earlier Writer recovery offer appear in the captures. They were not painted over to invent a pristine store. Hardware-dependent blank previews and the Messages bridge/skeleton surface are not promoted to complete functionality.

The review therefore fulfills bounded **all-app initial visual inspection**, not universal UI simplification or all-app feature completeness. The original 94 source-3 views are retained; five source-4 mark/layout supplements show the changed marks and scrolled Contacts panel. Ten source-5 repair captures and ten final source-6 captures are separate, each actually viewed; the extra captures are not relabeled as another 47-app run. Hashes/observations are attached to the review JSON.

The final repair views show **Spec 12,217 words closed / 12,657 open** using plain `innerText` (including off-viewport register text/select options), and **Beam 291** at both widths. These are explicit metric values, **not** a cross-metric global UI win. The twelve full spike records remain available, and all 627 primary register rows remain in the DOM. The original density suites now pass their unchanged caps (Spec 12,400; Beam 300). Browser's actual DNS-failure view is 60 words versus the intentionally retained measured-denial explanation at 121; these are different states, not equivalent before/after content. Remaining dense health warnings and some dark-toolbar glyph contrast are still visible follow-ups.

## I. Carried feature receipt, reproducibility and final-verification ledger

### I1. Twenty carried TT133 rows — counted once

All definitions/routes/nuances are in `src/db/seed-data/features-tt133.ts`, seed **3.96.0**. More detailed carried-work receipt: [DESIGN-TT133.md](DESIGN-TT133.md).

| Code | Carried capability | Actual acceptance anchor |
|---|---|---|
| NT-08 | Protect unsaved note changes | native leave Save/Discard/Cancel, Orbit ownership and genuine concurrent confirmation winner |
| NT-09 | Restore this window's editing draft | real sessionStorage reload/restore/clear; actual quota/error/export boundary |
| NT-10 | Reject stale note saves | real revision CAS/409, exact preservation; row-lifetime scope only |
| NT-11 | Filter text and tags together | actual native controls and stored notes |
| NT-12 | Read a safe Markdown preview | real literal HTML/Unicode/fence/native render tests |
| NT-13 | Import a Markdown note | actual file input, strict UTF-8/limits; no forced unsafe navigation |
| NT-14 | Wiki-links and backlinks | unique/ambiguous/missing saved destinations, unsaved rename + shadow attack |
| NT-15 | Jump through the note outline | real below-fold heading jump and fence/source-line bounds |
| NT-16 | Extract selected text to a note | native exact Unicode selection; source/save guard preserved |
| NT-17 | Check tasks in preview | source-mapped exact marker; fence/non-target lines preserved, save/reopen |
| NT-18 | Download current note | native UTF-8 local download including unsaved text; no VFS write, survives real draft quota refusal |
| SR-13 | Choose result source | server predicate/validation plus native selector and wrong-source emptiness |
| SR-14 | Order returned results | native relevance/title/reference; deterministic bounded-set ordering |
| SR-15 | Literal substring search | real literal spaces/wildcards/public-prefix/private boundaries |
| SR-16 | File-suffix filtering | native valid/multi-part suffix, bad input and incompatible-source reset |
| SR-17 | Rebuild public search index | real transaction, locks, rollback/readers/source preservation and native confirmation |
| SR-18 | Diagnose a missing file/index entry | actual absolute-path request/result, missing/invalid path and Private refusal |
| SR-19 | Replay complete recent searches | native all-control replay, real lock/late completion after clear, Private/corrupt purge |
| SV-02 | Save/replay complete profiles | strict name/count/input validation, native all-control replay and Private plaintext consent/cancel |
| SV-03 | Portable profile import/export | actual file/download, atomic validated replace/cancel, malformed/unknown-field/Unicode/size boundaries |

**No second set of twenty TT134 rows has been registered or accepted.** The new original marks, native migration drill, test additions and repairs are deliberately outside this table's feature count.

### I2. Reproduce on an explicitly disposable environment

Use the repository bootstrap for native tools; retain pinned versions and manifests. Never point stateful tests at a personal/production database. Example runtime values below refer to the actual isolated sandbox, not user credentials or a production deployment:

```sh
export BASE=http://127.0.0.1:3000
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db_utf8
export TT89_DISPOSABLE_DATABASE=1
export TOOLS_DIR=/home/user/.cache/ost-tools
export ORACLE_PY="$TOOLS_DIR/venv/bin/python"
export JOBS=2

node --use-system-ca --experimental-strip-types --no-warnings \
  --import ./scripts/register-hook.mjs scripts/tt133-core.mts
# Same invocation for the listed MTS suites. Real OpenSSH requires the actual
# separately provisioned owned sshd + ignored key directory, not a fake server.
node --use-system-ca --experimental-strip-types --no-warnings \
  --import ./scripts/register-hook.mjs scripts/tt134-note-migration.mts
node node_modules/typescript/bin/tsc --project scripts/tsconfig-tt134.json
# New real-peer/disclosure review; online GitHub must actually answer with DENY:
node --use-system-ca --experimental-strip-types --no-warnings \
  --import ./scripts/register-hook.mjs scripts/tt134-review-repairs.mts
bash scripts/run-gate.sh
# Run CPU measurements alone, not beside a build or browser gate:
python3 scripts/benchmark-raster-ink.py
TURN_TAG=tt134 python3 scripts/benchmark-lint.py
BASE="$BASE" node scripts/ledger.mjs
```

The SQL migration is an explicit operator artifact, not an automatic promise that upgrading every existing deployment was exercised. The native drill creates/drops only its random owned database; the user/role must have the appropriate disposable-database permissions.

### I3. Final-verification section

**Collected final state ([machine receipt](evidence/tt134-final-verification.json)): static/build checks and affected reruns pass; the earlier expanded full gate failed and was not rerun in full. The twenty-additional-feature target remains unmet.**

| Collected check | Result | Evidence / exact scope |
|---|---|---|
| Root application/config TypeScript | **exit 0** | [`tt134-typecheck-final-reviewed.log`](evidence/tt134-typecheck-final-reviewed.log), empty diagnostic log; root config excludes `.mts` |
| Strict TT133/TT134 MTS graph | **exit 0** | [`tt134-script-typecheck-final.log`](evidence/tt134-script-typecheck-final.log), 14 entrypoints plus imported graph via `scripts/tsconfig-tt134.json`, not every historical script |
| Uncached whole-tree ESLint | **1,197 files; 0 errors; 6 warnings; exit 0** | [`tt134-lint-final-reviewed.json`](evidence/tt134-lint-final-reviewed.json) and stderr; the six warnings are not silently called zero diagnostics |
| Final production compilation/server | **exit 0 / running** | [`tt134-build-final-reviewed.log`](evidence/tt134-build-final-reviewed.log), served at `0.0.0.0:3000` with relative browser API URLs |
| Initial expanded source-4 gate | **789/4, exit 1** | 90 suite executions/86 distinct; unchanged failed evidence retained in F3 |
| Affected source-5 results after the corrected bundle oracle | **129/0 latest-pass composite** | Eleven suites; first batch was 128/1, followed by the real corrected three-case rerun. This is not one new full gate |
| Final compiled-source new attacks + stricter density + live/source ledger | **36/0, exit 0** | **8 + 23 + 5**, [`tt134-final-native.json`](evidence/tt134-final-native.json). Re-executions overlap the earlier passes |
| Historical source-4 mark/compact-toolbar supplement | **5/0; five manually viewed captures** | [`tt134-icon-review.json`](evidence/tt134-icon-review.json); those mark/Contacts sources were not changed by the later three-app repair |
| Final repair supplement | **ten captures actually viewed** | [`tt134-review-repairs.json`](evidence/tt134-review-repairs.json), including real peer/DNS evidence, open/closed Spec and measured 8 px media-control gaps |
| Shell syntax / source whitespace | **exit 0** | `bash -n scripts/run-gate.sh scripts/sandbox/bootstrap.sh`; full `git diff --cached --check` under the explicitly scoped raw-evidence data policy in F4. Bootstrap whitespace repaired; actual source trailing-space attack still rejected (exit 2) |

The reviewed coverage snapshot is **627 rows: 519 built, 84 partial/probe, 24 blocked; 469 full-tag tested, 122 partial, 36 untested; 3,582/3,582 saved test results; zero failing-touch rows** ([refresh receipt](evidence/tt134-ledger-reviewed.log)). These results are **mixed-date**, **not** a fresh execution of 3,582 tests. Final `tt131-ledger` **5/0** actually verifies the **compiled production snapshot, checked-out source JSON and live registry** agree, including incomplete-row caps and registered tags. Do not regenerate the source snapshot without rebuilding the server.

The [final input binding](evidence/tt134-final-source.json) captures **1,390 selected production/public/script/root-build inputs** with per-file hashes and aggregate SHA-256 `b5efeca136bd8ccd8f0a6c458163595fd6daea9471eeabe0767873003978430f`. It explicitly excludes generated build/cache/docs/evidence/screens/test-results and is **not** an all-repository recursive digest. The earlier runtime capture's 1,388-file digest is historical, not relabeled as final. No recorded production/public/script/build input differs after this final binding and native pass. Documentation and the separately checked delivery-only Git raw-evidence whitespace policy are outside that digest; the temporary real hygiene-attack file was removed.

Git delivery uses only `arena/723a3a13-ost` and PR [#17](https://github.com/jyvplay/OST/pull/17). The actual commit/push/open-state result belongs to the delivery receipt/final response, not a pre-run success assertion. **No merge or close is authorized or performed.**

## J. Strongest result, exact remaining gap and next high-information work

The strongest verified artifact is a concrete, runnable implementation and adversarial verification of the twenty carried Notes/Find capabilities, plus repaired Writer DOM/save ownership, actual old-schema migration behavior, real SSH/native format checks, exact faster raster/lint verification, and the complete bounded initial-view review. Failure evidence is retained and acceptance is scoped to actual execution.

**Unmet:** twenty additional genuine Class A features; a second expanded full gate on the final repaired source; all-feature/native-OS completeness; universal wordiness reduction; physical/multi-device/multi-browser acceptance; a complete source/asset/license audit; a measured improvement for every repeating script; universal timing/memory/energy/Pareto guarantees; cross-incarnation Notes CAS. These are not hidden behind a higher grade.

Highest-information next engineering tests, before promoting another broad canonical row:

1. **Incarnation-safe Notes protocol:** define an immutable per-incarnation token/tombstone, migrate it, propagate it through recovery/saves/confirmation, then rerun real external same-ID deletion/recreation **through the application** and all current Notes ownership gates. Do not merely increase an integer bound.
2. **A complete fresh native device matrix:** installed PWA/handler acceptance, screen/camera/microphone permission paths, real second device/audio/receiver and browser diversity. Keep canonical native-only rows partial/blocked where the required primitive is absent.
3. **Target real unfinished Class A contracts, not invented sub-row counts:** the live register still has fifty non-built Class A rows, including broad original OS contracts and platform-dependent probes. Pick a feasible original contract with a native falsifier and close its exact remaining gap before relabeling it complete.
4. **UX follow-up:** make dense settings/status pages easier to scan while preserving explicit security/platform limits; improve compact overflow discoverability. Re-capture and inspect changed views, not only count screenshots.
5. **License/provenance audit:** verify actual shipped source/licenses/notices and assets, including copyleft/attribution obligations, rather than extrapolating from lockfile strings or a crashed metadata printer.

The requested universal success is not reported as achieved. PR #17 must remain open; no merge or close is authorized by this report.
