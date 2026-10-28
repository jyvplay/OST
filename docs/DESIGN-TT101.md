# TT101 — existing metadata search, with bounded evidence

Date: 2026-10-28. Branch: `arena/aeaea59a-ost`. **PR must remain unmerged.**

## A. Verdict and evidence threshold

**Final fresh production gate: 263/263 assertions across 19 suites, exit 0. Metadata: 37/37; actual Find UI: 9/9; privacy: 13/13; Recall: 27/27.** See `docs/evidence/tt101-production-gate.log` and the per-suite JSON in `docs/test-results/`. The earlier production build passed **257/257 assertions across 19 suites**, preserved separately in `tt101-production-initial-257.log`. That result predates the last resource guard, mode-switch repair and held-out cases; it is not substituted for their verification.

Delivered: a separate **Live metadata / transcripts / lyrics** mode in Find, over current filesystem records and supported stored text/header values. It finds existing lyrics/transcripts, including real ID3 USLT/TXXX values; it does **not** create missing lyrics, perform ASR/OCR, or promise every format's metadata. Ordinary fast text search remains available.

**Universal recording, every metadata field of every application/format, all Class A specifications and ten newly complete Class A features are NOT established. No canonical specification grade is promoted.** This is a bounded, tested improvement, not completion of those larger goals. TT100's physical recording and native-disk limits remain open; therefore the subsequently sequenced context-menu/icon/notification redesign was not resumed. Existing implementations are preserved, not newly certified as complete.

Evidence categories:
- **H+**: a stated finite executable witness passes at the relevant boundary, with external observation when available. Not a theorem about all inputs.
- **H−**: a proposed stronger solution is refuted by an executed counterexample, or excluded by a normative access restriction. Standards evidence is not a physical-device experiment.
- **H∂**: implemented or researched but incompletely verified, unsupported, or outside the tested domain.

One coding agent used actual repository files, git/gh, Node, TypeScript, ESLint, a Next production build, PostgreSQL, Playwright with real Chromium/SwiftShader, axe-core, and a separately installed MIT music-metadata parser. Python tooling supports historical Files tests. No independent agent, theorem prover, physical microphone/display picker, Firefox/Safari/mobile device, FFmpeg execution, or generated screenshot was used. HTTP observation wrappers forward real requests; they do not replace responses. Pure parser/page tests are identified as such, not represented as browser or production integration tests.

## B. Formal contract and quantifiers

Let **D** be currently visible, untrashed VFS **files**, excluding `/Private`, encrypted MIME records and current `search.excludes` paths on the host. A metadata request supplies canonical absolute scope (optional), query q, optional field f and keyset cursor c. Non-file `source` values are rejected by the host metadata endpoint. Private/RAM mode is a separate local execution path, not a union with host results.

Let **E(n)** be scalar values actually emitted by `metadataValues(n)` within the declared limits: node properties except raw content/internal skip flags; textual content; recursively walked JSON; supported audio/image reader output, including supported EXIF/XMP and textual picture descriptions, not cover-image bytes. This definition is deliberately narrower than “all metadata that may exist in arbitrary bytes.” A present but unsupported field is not certified searched merely because its container was recognized.

Define `fold(s) = NFKC(s).toLowerCase()`. Split folded, trimmed q on whitespace into terms T. Eligible field paths are exact f, descendants of f, matching property subtrees, or leaf-name suffixes; empty f admits all emitted fields. A page hit satisfies:

`for every t in T, there exists an eligible (field,value) in E(n) with fold(value).includes(t)`.

Terms may match different scalar values of the same file. This is literal AND matching, not stemming, fuzzy ranking, phrase search, regular expressions, semantic inference or locale-complete Unicode case folding. Scalars `false`, `0` and `null` are not dropped as falsy. Metadata rank is constant 1, not a relevance measurement.

For a **fixed, unchanged** finite D, complete keyset traversal visits eligible files in C-collated path order on the host. It does not give a snapshot across writes/renames/deletions. Private enumeration and RAM ordering are local; crossing traversal caps is explicitly partial. A cursor is a path, not a signed snapshot token.

H+ means tested membership/provenance/privacy behavior on the witnessed inputs. There is no proved universal parser soundness/completeness, end-to-end memory bound, latency SLA, or completeness over unavailable/encrypted-without-key content.

### Resources and access

| Boundary | Implemented limit / qualification |
|---|---|
| Query | 1–512 characters, at most 32 whitespace-separated terms |
| Field / cursor | 256 / 4096 characters; control characters refused |
| Content | 262,144 stored string units/file in JS; SQL `length(text)` uses PostgreSQL characters, not a uniform byte bound. Base64 consumes this stored-content budget before decoding |
| Files | 32 parsed/page; SQL fetches 33 for continuation |
| Flattening | 4,096 emitted fields, depth 24 |
| Returned provenance | At most 16 matched fields, each value cropped to 240 characters; snippet cropped separately |
| Private enumeration | 256 folders, 5,000 candidates, 32 levels; inner-list guard prevents adding beyond candidate cap |
| Private access | Existing keys and actual encrypted file transport; key change while reading discards result |
| RAM mode | Actual in-memory filesystem; intentionally does not search the host overlay |
| Persistence | No new search table, background worker, service or runtime package; live extraction is query-time |

These are **not** a whole-process/DB RAM proof. Directory listing itself, non-content node scalars and SQL `to_jsonb(n)` intermediates can be large; a file-count cap does not bound every byte allocated. The 5,000-candidate guard has structural inspection but no executed 5,001-encrypted-file boundary witness in this turn. The new 33-record pure test attacks the independent 32-file page cap, not that larger traversal boundary. No hard runtime resource-safety claim is made.

Host ordinary queries remain host-visible. Private query text is kept in the tab/shared privacy layer, but encrypted file I/O and access patterns still reach the host. This is not ORAM or protection against compromised same-origin JavaScript. Raw direct filesystem API use is not automatically client-side encryption; the encrypted-write guarantee refers to the actual privacy layer path.

## C. Research and mechanism choice

PostgreSQL text search normalizes to lexemes and can discard stopwords; it is not arbitrary literal value preservation. [2](https://www.postgresql.org/docs/current/textsearch-controls.html) [6](https://www.postgresql.org/docs/current/textsearch-intro.html)

`jsonb_to_tsvector` can include string, numeric, boolean and key values using filters, but still applies text-search normalization. That is useful for indexed lexical search, not a substitute for this contract. [1](https://www.postgresql.org/docs/current/functions-textsearch.html) PostgreSQL also documents lexeme/vector/position limits; removing one application truncation would not establish unlimited coverage. [7](https://www.postgresql.org/docs/current/textsearch-limitations.html)

ID3 primary/spec references consulted earlier in the turn: <https://id3.org/id3v2.3.0>, <https://mutagen-specs.readthedocs.io/en/latest/id3/id3v2.3.0.html>, <https://mutagen-specs.readthedocs.io/en/latest/id3/id3v2.4.0-frames.html>. These distinguish USLT, custom TXXX text and separate synchronized SYLT data. The implementation is original; specification layout is not copied library source. FFmpeg's reported custom-lyrics interoperability issue motivated preserving arbitrary text frames: <https://trac.ffmpeg.org/ticket/8795>. No FFmpeg binary was executed.

An independently installed **music-metadata 12.3.2 (MIT)** agrees on actual ID3v2.4 UTF-8 USLT/TXXX and ID3v2.3 UTF-16 Greek USLT byte fixtures. These are real stored ID3 tag bytes, not a claim that the tag-only fixture is a complete playable music recording. Agreement on two fixtures is not universal format conformance.

Recording research was rechecked: browser display sharing requires activation and a fresh chooser grant; audio availability varies. [1](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) Canvas export/capture requires origin-clean pixels. [4](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream) [7](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image) These are access boundaries, not inconveniences that an alternative permissive library can legitimately bypass.

## D. Mechanism-distinct approach ledger

| Approach | Artifact / established portion | Gap and candidate-specific falsifier |
|---|---|---|
| 1. Existing Postgres fast index | Existing route retained; real late-JSON witness shows old index misses the value | Not all values. Falsifier: transcript after legacy 50,000-character cutoff; new live mode finds it |
| 2. JSONB-to-tsvector / broader lexical index | Official PostgreSQL research above; no new index installed | Normalization/stopword/lexeme limits remain. Falsifier: require exact punctuation/false/long literal preservation, not just word recall |
| 3. Live host value pages | `src/lib/server/metadata-search.ts`; real HTTP/PG path, provenance, scoped keyset traversal | Files only; mutations are not snapshot-isolated. Falsifiers: held-out page-2 match, wildcard-shaped scope, exclusions changed after indexing |
| 4. Structural/text/header extraction | `src/lib/search/metadata.ts`, original `audio.ts` extension; arbitrary JSON, USLT/TXXX/unknown text frames | Not arbitrary binary/container/codec support. Falsifiers: UTF-16 terminators, truncated frame, actual zlib-compressed USLT, ZIP, deep JSON |
| 5. Client-side decrypted private query | Existing encryption plus `PrivacyLayer`; real encrypted writes, PG plaintext check and actual HTTP observation | Browser unlocked interaction is not separately exercised; access-pattern leakage persists. Falsifiers: lock mid-read, locked request, 35 encrypted files requiring continuation |
| 6. RAM-only execution | Existing RAM filesystem plus same query engine; actual RAM write and query with zero forwarded requests | Not persistent or host-overlay search. Falsifier: a local result must be returned without host search or read requests |
| 7. Automatic ASR/OCR / lyric retrieval | Not installed or falsely advertised | Changes task from finding existing values to generating/fetching content; introduces accuracy, compute and privacy obligations. Falsifier: absent text must not appear as a fabricated result |
| 8. Recall's byte/archive, stream-encode and PNG mechanisms | Unchanged `e2e-tt100-recall` production regression; prior design in `DESIGN-TT100.md` | Discovery is orchestration, not a fourth recorder. Physical permission/audio/native-disk/DRM boundaries remain; headless canvas/media tests do not close them |

This is a research/implementation ledger, not a claim every alternative was implemented and benchmarked. No paid/cloud extraction, copyleft runtime addition, vendored foreign implementation or runtime dependency change was introduced.

## E. Falsification ledger — false-solution shapes

| # | Tempting false solution | Witness / outcome, or explicit unclosed boundary |
|---|---|---|
| 1 | Search titles only and call it metadata | Stored SHA, artist, JSON transcript, USLT/TXXX values tested |
| 2 | Reuse the old capped index and rename the UI | Actual late JSON value missed by old index, found live |
| 3 | Hard-code a few lyric field names | Arbitrary custom TXXX, unknown text frame, nested unknown JSON key tested |
| 4 | Drop zero/false as empty | Actual scalar cases tested |
| 5 | Pretend ASCII alone is Unicode search | Full-width NFKC and UTF-16 Greek ID3 cases tested; not full locale folding |
| 6 | Inflate every header at query time | Real compressed USLT explicitly refused/warned; no decompression executed by query engine |
| 7 | Interpret `%`, `_` or SQL-looking text as query operators | Literal metadata and injection-shaped real HTTP queries tested |
| 8 | Let `/foo` include `/foo-sibling` | Actual sibling scope witness tested |
| 9 | Keep excluded/stale rows visible | Current exclusions checked in metadata and legacy output; real overwrite updates tested |
| 10 | First page has no match, so nothing exists | Real >32-file HTTP and Chromium continuation cases tested |
| 11 | Client helper quietly parses a 33rd supplied record | Pure page-engine 33-record attack tested, separate from HTTP integration |
| 12 | Forward private plaintext query to host | Real encrypted transport observation and locked Chromium request observation tested |
| 13 | Decrypt after a lock and still publish results | Actual pending read with key revocation tested, result discarded |
| 14 | Keep private plaintext in PG | Actual encrypted-write witness checked against PG content/path plaintext |
| 15 | RAM privacy merely labels a host search as local | Actual RAM write/query with zero forwarded requests tested |
| 16 | Render metadata HTML as markup | Actual `<img ... onerror=...>` value displayed as text in Chromium; no injected image |
| 17 | Keep old hits/cursors after editing criteria | Actual browser edits invalidate old provenance/cursor; separate mode-switch regression added |
| 18 | Return fake 0 ms and call it measured performance | Server/private elapsed clocks and measured UI fallback; no fixed latency claim |
| 19 | Test an empty UI and claim populated accessibility | axe runs against the actual populated metadata Find window; serious/critical violations checked |
| 20 | A parser recognizes a container, therefore all its fields were searched | Explicitly rejected: SYLT/unknown binary fields may remain unread and are not certified |
| 21 | A 5,000-counter means bounded total RAM | Explicitly rejected: list response/SQL/intermediate scalar sizes are not wholly bounded; large-boundary witness remains H∂ |
| 22 | A green selected suite means every historical suite passed | Only the named 19-suite gate is claimed; run-all's full default list was not executed |
| 23 | Three recording buttons mean universal capture | Three mechanisms retained and regressed, not universal website/audio/DRM capability |
| 24 | Ten preserved behaviors mean ten newly completed Class A features | Explicitly rejected; no grade promotions or all-A claim |

## F. Implementation and privacy delta

- New bounded isomorphic value walker and literal matcher; no persistent secondary metadata copy.
- Host SQL excludes trashed/private/encrypted/excluded files and applies separator-aware canonical scope. C-collated keyset pages avoid offset-based continuation.
- Original ID3 reader now retains arbitrary text/custom fields and unsynchronized lyrics, with real encoding/truncation checks. Synchronized lyrics are not newly implemented.
- Private query uses existing encryption and local extraction; RAM queries use real RAM nodes. Lazy parser import avoids eagerly adding its work to ordinary private operations.
- Find adds mode/field/page controls, provenance, partial-coverage diagnostics, error/retry and UI request cancellation/stale-result suppression. Private internal reads may finish after UI cancellation; no preemptive CPU-work cancellation guarantee is made. Changes to criteria invalidate old results and cursors. `/Privateer` is no longer mistaken for `/Private` when toggling the private scope.
- The index-health text now distinguishes fast-index counts from live metadata coverage. Timing is measured, not invented.
- Legacy search output/coverage/explain count gains current visibility filtering. **Excluded old index rows can still persist**; this is output filtering, not a no-index/no-persistence guarantee.

No edits to package manifests, lockfiles, Recall implementation, canonical grades, menu/logo/toast implementation or DB schema were needed. The original good stack and three recording mechanisms are retained.

## G. Executed verification and repair chronology

1. Initial typing/API-method mistakes were repaired; failing initial evidence is retained in `tt101-search-initial.log` and UI initial logs.
2. Initial browser pagination witness was out of the first 32 files. The assertion was scoped to its actual file and a separate real multi-page test added; it was not “fixed” by widening a fake result.
3. Real metadata/provenance, exclusions, scope, Unicode, budgets, malformed/unsupported input and private/RAM tests passed. Independent audio-parser checks were added, including UTF-16 and compressed-frame refusal.
4. Actual production build and 19-suite gate passed 257 assertions. Historical screenshots were restored rather than relabeled as TT101 evidence.
5. Added real encrypted pagination, pure 33-record attack, locked actual-browser query privacy, populated axe, and mode-switch stale-claim checks. Added inner-loop private candidate guard; last guard's 5,001-boundary behavior remains unexecuted.
6. Rebuilt production after final source changes. One build invocation omitted `DATABASE_URL` and failed collecting route data; `tt101-build-missing-env.log` preserves that environmental failure. Re-running with the explicit disposable DB passed (`tt101-build.log`). Typecheck and focused changed-file ESLint passed.
7. The next whole-gate rerun hit a fixture-isolation failure: a prior deliberately plaintext `/Private/tt101-*.json` negative witness persisted and broke the historical locked-list clean-data assertion. The interrupted failed log is retained as `tt101-dirty-db-interrupted.log`; it is not counted as a successful gate. The witness now purges its own file in `finally`.
8. Centralized non-file source validation so private/RAM paths also reject unsupported source filters before I/O; added a candidate-specific no-forwarding test. Rebuilt and rechecked types/focused lint. Final gate uses a fresh `tt101_final` database and deliberately runs metadata **before privacy-layer**, testing the fixture-cleanup repair against the actual historical assertion.
9. Separate normal preview started on port **3001** against `tt101_preview` with no loopback-test flag. Actual HTTP metadata query and Chromium interaction passed with zero page errors (`tt101-preview-smoke.log`). The only added preview content is `metadata-search-example.json`, explicitly authored and labeled as text not extracted from audio; it is not a gate fixture or an ASR demonstration. Initial smoke selector/window-reentry mistakes are retained in the two preview-smoke failure logs, then repaired and rerun successfully. `tt101-preview.png` was visually inspected: actual maximized Find controls, field provenance and honest coverage diagnostics are readable. The existing narrow scope input horizontally clips its long path; maximization is a real window action, not a screenshot-only DOM alteration.
10. Final fresh production gate completed **263/263 in 19 suites, exit 0**, against the final production build. Metadata 37/37 ran before privacy 13/13, proving that fixture cleanup no longer poisons the historical privacy assertion. `tt101-summary.json` records per-suite timestamps/counts and SHA-256 of the six changed runtime source files. The separate preview smoke is not added to the 263 count.

Screenshots are actual Chromium captures, not generated images. `tt101-search.png` shows controls; `tt101-search-results.png` scrolls the actual field/value and coverage diagnostics into view. The final default-window result screenshot was visually inspected: provenance is visible at the lower edge, while the retained index-health card occupies substantial height. The separately inspected maximized clean-preview screenshot shows the complete provenance and partial-coverage diagnostics. This is not a native-UI comparison or a claim that all layout issues are resolved. Current Recall regression capture is stored separately as `tt101-recall-regression.png`.

The selected gate preserves witnesses for more than ten existing behaviors, including actual filesystem write/read, move rejection/journaling, overwrite versioning, trash/restore, digest duplicates, text search, file selection/drag, desktop menu behavior, command palette, Orbit interactions, browser sessions, privacy and Recall. These are regression witnesses, **not** ten newly complete features or full contracts inferred from a single assertion.

## H. Reproduction

Use a disposable PostgreSQL database only; these tests create records and change application state. `BASE` must reach the production server built against that same DB. Initialize schema using this repository's Drizzle configuration. Build/start require `DATABASE_URL`.

```sh
npm ci
export DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tt101_final
# Explicit URL is necessary: the checked-in drizzle JSON has its own DB URL.
npx drizzle-kit push --dialect postgresql --schema ./src/db/schema.ts --url "$DATABASE_URL"
npm run build
# Separate terminal; TEST ONLY permits the actual Recall HTTP fixture publisher:
FUSION_WP_TEST_LOOPBACK_PORTS=4001 npm run start -- --hostname 0.0.0.0 --port 3000
# Separate terminal: node scripts/tt100-fixture.mjs
TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 \
  SUITES='tt101-search e2e-tt101-search privacy-layer unit integration browser-session tt55-files-unit e2e-tt55-files e2e-tt55-shell e2e-tt96-desktop-menu tt97-palette-commands e2e-tt97-palette-actions e2e-tt97-files-empty-a11y e2e-tt98-orbit e2e-tt99-interactions e2e-browser tt69-lifecycle e2e-tt100-recall e2e-a11y' \
  bash scripts/run-all.sh
```

Prerequisites are real PostgreSQL, real Chromium (see `scripts/browser-launch.mts`) and historical Python dependencies. The restricted sandbox used external tools under `/home/user/tools`, not new app packages. `tt101-search.mts` currently imports the test-only music-metadata parser at `/home/user/tools/node_modules/music-metadata/lib/index.js`; install **12.3.2** there or adapt that import. This absolute path is a portability limitation, not a runtime app dependency. The browser launcher supports `PW_CHROMIUM` and `TOOLS_DIR`.

Do **not** set the loopback-test flag on the final normal preview/deployment. Gate results contain synthetic test fixtures; the final preview uses a different initialized database with one explicitly authored example. Run `TT101_PREVIEW_EXAMPLE=1 BASE=http://127.0.0.1:3001 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt101-preview-smoke.mts` only on an intended preview; it refuses to overwrite a user-edited example.

## I. Exact remaining gaps / counterexamples

- Existing metadata in folders, notes/tags/application records, arbitrary archives/office/PDF/video containers, SYLT and reader-unsupported image/audio fields is not universally searched. A recognized format does not certify all its fields. No generated ASR/OCR/lyrics.
- Over-budget or deeply nested values, later private-enumeration candidates, missing keys and unreadable sources are outside completeness. Non-file source parameters are rejected in the shared validator before private host I/O; this repair has its own local no-forwarding attack. The UI exposes no source selector.
- Mutating datasets can move records across cursor boundaries. No snapshot token, signed cursor, exhaustive adversarial parser proof or whole-process allocation bound.
- Locking storage prevents future reads; it is not secure screen/memory erasure. Already-rendered Find results/query text, other open application content, browser undo buffers or snapshots are not guaranteed cleared by storage lock.
- Unlocked private browser UI is not exercised independently of the actual shared privacy-layer Node/HTTP/PG tests. Locked actual-browser no-query-leak is exercised. Keys/plaintext remain exposed to compromised same-origin code by design.
- Legacy POST `/api/search` still reports `rebuilt:true` without an implemented rebuild. Legacy fast-index scope still uses its older prefix semantics. No new claim relies on either. Index rows for excluded content can persist.
- No physical screen/tab chooser, physical audio loopback, native disk backpressure/file-picker completion, Firefox/Safari/mobile, DRM capture or exhaustive site discovery validation. TT100's non-atomic unsigned receipts are unchanged.
- No fresh menu/icon/toast redesign: the explicit recording-first sequencing condition remains unmet. Prior decorative toast-depth limitations remain.
- No all-A or ten-new-complete-feature claim. A full default historical run-all, independent review and formal proof remain absent. A fresh whole-repo lint run reproduces **173 errors and 16 warnings** (`tt101-full-lint.log`); focused changed-file lint passes. This is not an all-repo-clean assertion.

## J. Strongest artifact and next boundary

Strongest deliverable: the actual production-capable Find metadata mode plus reproducible real HTTP/PG/private/native-browser witnesses and independent ID3 parsing agreement. The implementation is useful without pretending a complete index or fabricating text absent from files.

Next high-information work is lock-triggered visible-result clearing with a real unlocked-browser witness; a schema-aware reader inventory and independent malformed/large corpus; native-browser unlocked-private exercise; a real 5,001-file cap/memory profile; bounded SQL projection/list streaming; and physical permission/audio/native-disk capture verification. Completing those would reduce named H∂ gaps. None would justify silently promoting all applications to Class A. Review only: **do not merge**.
