# TT133 — carried implementation receipt, completed and rechecked during TT134

**Accounting:** these twenty capabilities were implemented as TT133 work and carried into TT134 unfinished. They are registered once in `src/db/seed-data/features-tt133.ts`, seed **3.96.0**. They are **not** twenty additional TT134 completions. No feature-count credit is assigned to strict-type repairs, scripts, tests, the migration drill, Writer bug fixes or icons.

The full A–J engineering/research/verification report for finishing this work is [DESIGN-TT134.md](DESIGN-TT134.md). It records the actual runtime, primary references, hypotheses, rejected shortcuts, mechanism-distinct branches, concrete artifacts, adversarial repairs, exact gaps, performance and all-app visual review. This receipt is a scope/accounting index, not a second claim to the same twenty features.

## The twenty carried capabilities

| Code | Implemented user capability | Principal artifacts |
|---|---|---|
| NT-08 | Save/Discard/Cancel before leaving edited Notes | `Notes.tsx`, `notes/NoteEditor.tsx`, `doc-lifecycle.ts`, `CloseConfirm.tsx` |
| NT-09 | Restore this tab/window's editing draft | `note-drafts.ts`, native `sessionStorage`, recovery controls |
| NT-10 | Refuse a cooperating stale revision | Notes API/schema, `note-model.ts`, expected-revision update/delete |
| NT-11 | Combine text/tag filtering | actual Notes controls, `note-model.ts`, tag/sort helpers |
| NT-12 | Safe Markdown preview | `note-markdown.ts`, `MarkdownView`, NoteEditor preview |
| NT-13 | Import Markdown using a real file control | strict UTF-8/byte/field validation and guarded creation |
| NT-14 | Follow wiki-links and saved-ID backlinks | `note-links.ts`, unique-title navigation, ambiguity/missing-target refusal |
| NT-15 | Navigate the source-mapped outline | fence-aware heading parsing and real preview anchors |
| NT-16 | Create a new note from native text selection | exact selection/extract path; source editor unchanged |
| NT-17 | Toggle source-mapped preview tasks | exact matching source marker; fence/non-target preservation |
| NT-18 | Download current unsaved text as local UTF-8 Markdown | actual Blob/native download, distinct from VFS export |
| SR-13 | Select source type for actual search | `search-query.ts`, search route, native Find selector |
| SR-14 | Sort the bounded returned result set | actual relevance/title/reference controls and deterministic ordering |
| SR-15 | Literal substring mode | real public/private paths, literal spaces/wildcards, index-prefix boundary |
| SR-16 | Filter file results by literal suffix | suffix validation and incompatible-source clearing |
| SR-17 | Confirmed transactional public-index rebuild | `server/search-maintenance.ts`, real PostgreSQL locks/rollback |
| SR-18 | Diagnose a missing path/index entry | validated public path, real source/index state, Private refusal |
| SR-19 | Replay complete recent searches | `recent-searches.ts`, all controls, epoch clear, Private/corrupt purge |
| SV-02 | Save/replay complete named profiles | `saved-searches.ts`, validated bounded profiles, explicit plaintext consent |
| SV-03 | Versioned portable profile JSON | actual import/download, strict whole-container validation, atomic confirmed replace |

## Actual execution, not source-only promotion

Completed source-3 regression during TT134: **17 suites / 275 passed / 0 failed**, including **94 initial-view captures**. Of these, the direct carried-work tests include `tt133-core` 23, `tt133-projections` 6, `tt133-http` 13, native Notes/Find 27, native boundaries 7, browser kernels 7 and native ownership 6. The wider batch also rechecked real OpenSSH, Office/Writer/Sheet/Vector/modal and native format oracles. Logs are `docs/evidence/tt134-<suite>-third.log`.

A separate **real cold PostgreSQL migration drill passed 7/0**. The first drill genuinely failed during cleanup after six assertions; that failed exit is not accepted. The repair waits for actual owned connections to drain, drops without force and asserts no background driver errors. See the current migration log/JSON and sanitized first-failure log.

### Additional attacks required before acceptance

- First-clean-load Orbit commands: no “it works after editing once” assumption.
- Save→Pin/Unpin/Duplicate: acknowledged new revision/body and Unicode-safe 500-unit copy title.
- Delete confirmation: a real competing writer cannot be silently adopted as the user's delete consent.
- Backlinks: unsaved rename, another saved title shadowed by the draft, duplicate/missing saved destinations.
- Draft quota: real native sessionStorage filled until actual `QuotaExceededError`, not an overridden Storage method; unsaved local export remains possible.
- Search privacy/history: actual canonical/malformed legacy Private keys and corrupt JSON, public neighbors, real late response after confirmed clear.
- Profiles: native all-control replay/download/import, cancellation, Private plaintext consent, malformed Unicode/unknown-field/size rejection before replacement.
- Worker: actual pathological regex and main-thread RAF, not a replacement worker/scheduler.
- Writer preservation regression: actual database lock/close timeout/Cancel/new edit/two acknowledgements, independent exact recovery ZIP/XML bytes after the cross-paragraph DOM repair.

## Contract boundaries that remain part of the product

- Notes revision CAS covers a live row lifetime and cooperating clients. **External same-ID deletion/recreation was actually unsafe**; an incarnation-safe protocol was not implemented.
- Drafts are same tab/window identity, not cross-device/global recovery; browser storage can be cleared or unavailable.
- Text/UTF-8/import, preview/index/result/profile/history and worker bounds are explicit; one-second worker termination timer and four-second lock timeout are not universal wall-time guarantees.
- Sorting/filtering applies to returned results; metadata uses real bounded pages; binary semantic extraction is not invented.
- Private queries do not enter automatic history. Explicitly saved profiles are local/exportable **plaintext**, not encrypted storage.
- Existing original OS contracts, hardware/device capabilities and canonical partial/blocked rows remain partial/blocked. No native Android/OS privilege is claimed as equivalent to a browser workaround.

## Delivery state and references

Source and machine evidence are part of the same working branch/PR. Final whole-tree/build/full-gate/compiled-ledger and push status belong to the final-verification receipt in [DESIGN-TT134.md](DESIGN-TT134.md); an in-progress final process must not be reported as passed here.

- [Twenty row definitions](../src/db/seed-data/features-tt133.ts)
- [Current migration evidence](evidence/tt134-note-migration.json)
- [All-app review](REVIEW-TT134.md)
- [Full report and exact unmet TT134 target](DESIGN-TT134.md)
- [Feature ledger](LEDGER.md) — generated mixed-date evidence, not a fresh universal proof

**Keep PR [#17](https://github.com/jyvplay/OST/pull/17) open.**
