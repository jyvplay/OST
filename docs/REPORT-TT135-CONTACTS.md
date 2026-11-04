# TT135 — Contacts safety and bounded performance work

2026-11-04 UTC. Branch `arena/a93c37eb-ost`, based on `b31a078`. This is **not** a claim that the OS is complete or that 20 additional Class A features have been completed. The previous turn's twenty bounded workflows were already delivered in merged PR #17; see `REPORT-TT134-WORKFLOWS.md`. This turn makes targeted repairs and optimizations, not 20 new features.

## Contract and decision

Inputs are real vCard strings and a VFS book, using the existing parser's maximum of 20,971,520 UTF-16 code units and 20,000 cards. Duplicate UID comparison is exact, case-sensitive string equality on parsed UIDs. Existing cards win over imported cards, and the first incoming card wins over later incoming cards with the same UID; the counts are disclosed. Truncated imports are refused as a whole; prospective imported books exceeding either limit are refused. Existing truncated, duplicate-UID, or nonempty no-card source books cannot be edited through Contacts and remain in Files. Empty source books remain valid. These are bounded safeguards, not a full vCard fidelity guarantee.

For a supported successful import, the intended invariant is that every accepted UID occurs at most once in the existing plus imported book and no already-present card is replaced. For a refused operation, no list commit should occur. Finite tests establish particular executions, not universal behavior across every valid input, competing writer, browser, crash, or storage failure. A source containing nested AGENT cards or other parser warnings may still have fidelity limitations; normal edits and saves outside import can still exceed the parser bounds. The autosave path remains vulnerable to concurrent writers or out-of-order overlapping writes, and tab termination delivery is best effort. CSV export still targets a fixed filename and may overwrite an existing live export. These limitations are not resolved here.

**H+**: the bounded cases below passed, and the measured algorithms produced exactly equal outputs against the checked-in parent for the tested fixtures. **H−**: the full regression gate did not start its suites because an independent test prerequisite was missing; 20 additional Class A completions and all-app completeness were not achieved. **H∂**: browser-native OS contacts and hardware features depend on browser/device support and permission; passing synthetic or Chromium-only checks cannot resolve those external conditions. Acceptance threshold for a merge here is a fresh complete regression gate, verified production-source identity, and sufficient comparative performance/stability evidence. It was not met; do not merge on the basis of this report.

Adjacent problems not substituted: file import versus native contacts sync; a one-off picker versus persistent OS contacts access; in-app VFS versus host filesystem; one row-lifetime revision versus incarnation-safe CAS; bounded vCard versus all versions/extensions; case-sensitive UID identity versus semantic person deduplication; observed single-workload speedup versus global Pareto superiority; browser screenshots versus all states/accessibility; one-device web APIs versus native Android privileges.

## Research and constraints

The actual [W3C Contact Picker proposal](https://github.com/w3c/contact-picker) describes a user-mediated, one-off selection from a secure top-level context, not perpetual address-book access. It is a proposal, not proof of implementation on every browser or a workaround for native sync. The UID-related [sabre-io discussion](https://github.com/sabre-io/dav/issues/906) quotes RFC 6350's entity-identifier purpose; an issue is not itself a normative standard or a guarantee all inputs follow it. No external implementation was copied or shipped and no dependency was added. Prior repository vCard RFC cases remain in `contacts-engine.mts`. No comprehensive dependency/asset license audit was performed.

## Six distinct mechanisms and their adversaries

| Mechanism | Artifact and observed test | Remaining interface / cheapest next attack |
|---|---|---|
| Explicit parser truncation state | `parseVcf.truncated`; exact 20,000 versus 20,001 and oversized-input tests | Parser warnings/unsupported properties are not all lossless. Attack nested AGENT and malformed books before any edit. |
| UID-keyed import planning | `planContactImport`; native same-new-UID and existing-UID import, disk read and reload | Repeated cards are skipped, not merged; user must resolve conflicting records externally. Attack collisions among generated missing UIDs and repeated import races. |
| Unsafe book refusal | `bookProblem`; Chromium opened real duplicate and 20,001-card VFS books, verified unchanged content and unavailable editor | Does not prevent writes from other windows/processes; attack an external replacement after load. |
| Import size preflight | `contactImportProblem`; exact count and oversized serialized result checks | Normal edits do not share this gate; large serialization is synchronous. Test near-limit interactive editing and memory pressure. |
| Duplicate graph aggregation | Iterative path compression, in-place grouping and one pass aggregating reasons; 500 parent differential trials and two timed workloads | Tested finite distributions are not a proof; attack extreme transitive chains and adversarial repeated keys. |
| UTF-8 folding byte count | Original authored per-code-point calculation; 1,000 parent differential trials including lone surrogates, plus existing RFC/round-trip checks | Not independently exhaustive over every string. Next: exhaustive short code-unit sequences and independent vCard oracle. |
| Layout and error disclosure | Wrapped Contacts toolbar; native compact geometry, click and screenshot; native CSV failure against a trashed path | Small windows/zoom and screen readers remain unverified. Test 200% zoom and 320px layout with a populated book. |

Tests are falsifiers, not certificates. The modal shortcut of calling a control present in the DOM sufficient fails when horizontal scrolling hides it. The compact geometry test checks each actual child rectangle against the toolbar, and the icon regression opens Duplicates with no horizontal overflow; [actual screenshot](screens/tt135-contacts-polish/contacts-compact-scrolled.png) was captured by Chromium. The prior compact screenshot was also inspected, and the newer `.cache/tt135-contacts-compact.png` was viewed. This turn did **not** visually review all 47 apps; the earlier bounded 94-view review remains historical.

### Fifteen non-solutions

1. A screenshot alone without working actions. 2. A UID `Set` built only from existing cards, missing collisions within the incoming file. 3. Automatically changing UIDs and pretending they are the same identity. 4. Silently dropping a truncated source book. 5. Importing only the first 20,000 while saying the entire file succeeded. 6. Testing only 20,001 and omitting the exact 20,000 boundary. 7. Rejecting all empty books. 8. Counting skipped cards as imported. 9. Raising limits without considering serialization output. 10. A fast duplicate algorithm that loses transitive reasons. 11. Matching only group counts instead of exact ordered groups/reasons. 12. Counting UTF-16 code units as UTF-8 bytes when folding non-ASCII. 13. Treating a worker or mock API as a real browser/DB test. 14. Citing historical full-gate results as a fresh run. 15. Treating shorter isolated timings as proof of universal time/memory/energy Pareto superiority. 16. Equating a one-off Contact Picker grant with background native synchronization.

## Measurement and verification

The actual tools used were Node 22.22.3, TypeScript 5.9.3, Next 16.4.3, ESLint 9, Playwright with Chromium 143.0.7499.0, real disposable PostgreSQL 18.6, git/gh, shell and web search/fetch. Two CPUs were available. No independent agent, theorem prover, physical device, simulator, or external expert reviewed this turn. Development and production servers used relative browser APIs. The database was newly initialized and is disposable; these test commands must never target user data. The PostgreSQL version string mentions a compiler, but no C compilation was performed here.

* Final production build and application TypeScript passed; strict MTS project (now includes the added core/benchmark and Contacts suite) passed. Full-tree ESLint passed with **0 errors, 6 warnings** after the final application and test edits; final build/typecheck passed after the last application edit. Shell syntax and `git diff --check` passed.
* Final production server: [Contacts native suite](test-results/e2e-contacts.json) **15/0**, including real file input, VFS, reload, download, axe and refusal paths; [icon/layout suite](test-results/tt134-icon-review.json) **5/0**. Pure [new core suite](test-results/tt135-contacts-core.json) **5/0** and Contacts engine **8/0**. An earlier two-worker pure run passed 69 cases across five suites, but preceded the final size/serialization changes; it is not a final full gate.
* First full Contacts run was **11/1** because the new skipped-UID message broke the legacy assertion. The message was repaired to distinguish existing and repeated UIDs, preserving the old disclosure; all affected cases were rerun. The next run was **11/1** because the historical CSV fixture reused a path left in Trash by the previous run. The test now creates its own unique directory instead of touching `/Contacts/contacts-export.csv`, and a new native test verifies the actual export refusal is visible. Subsequent complete runs passed; failures are not retroactively counted as green.
* The [attempted full `run-gate.sh`](evidence/tt135-contacts-gate-preflight.log) exited 1 at preflight: test-only `@js-temporal/polyfill` absent from `/home/user/tools`. No broad suite was run by that invocation. Other required independent tools/corpus were not fully restored, and the prior turn's full gate is not evidence for this source.
* [Measurement receipt](evidence/tt135-contacts-benchmark.json): actual parent Git blob vs current code, alternating six observations per workload, equal SHA-256 outputs. Median wall/CPU ms: 6,000 paired contacts **127.92/158.45 → 10.96/19.52**; 12,000 in one group **222.32/221.44 → 12.00/24.51**; 325,000-code-unit fold **210.61/299.42 → 14.40/22.68**. Also 500 duplicate and 1,000 folding differential inputs passed. Process CPU can exceed wall because of runtime threads. These are isolated-kernel local observations, not full-suite speed, peak memory, energy, or universal Pareto evidence. The new import preflight adds serialization work; no overall performance dominance is claimed.

Reproduce on an **exclusive disposable** server/database:

```sh
npm ci
npm run typecheck
node node_modules/typescript/bin/tsc --project scripts/tsconfig-tt134.json
node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt135-contacts-core.mts
node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt135-contacts-benchmark.mts
TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-contacts.mts
# Complete test tools/corpus first; point both values to the same exclusive disposable instance:
TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 DATABASE_URL='<disposable database URL>' JOBS=2 bash scripts/run-gate.sh
```

The test refuses to run without explicit disposable consent; this is a guard, not proof a URL is disposable. Its fixture resets desktop state. The app preview in this sandbox uses a disposable database and is not a production deployment.

## Next highest-information work

1. Restore pinned oracle tools/corpus and run the complete expanded gate against the final production build; audit its receipts and source identity.
2. Attack Contacts autosave with intentionally reordered real requests and two windows; design a versioned conditional save and reliable close/flush policy before claiming data-loss safety.
3. Apply input/serialized-output limits consistently to all edit/merge/restore paths and explicitly refuse unsupported destructive vCard constructs. Include near-limit memory and UI responsiveness.
4. Exercise device Contact Picker, Firefox/Safari, installed PWA, screen reader and narrow/zoomed layouts. Continue an actual all-app visual review; preserve meaningful warnings.
5. Address cross-incarnation Notes CAS and the remaining native-only/platform-dependent rows. Audit production source, assets and dependency licenses/notices separately.
