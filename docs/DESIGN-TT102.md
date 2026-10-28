# TT102 — Recall browsing and existing-value search hardening

2026-10-28 · continuation on `arena/aeaea59a-ost` · updates **PR #7**, never merges it.

## A. Formal model and actual runtime

**Final verdict: bounded delivery verified; full requested target remains partial.** One final fresh, sequential **production run passed 317/317 cases across 22 selected suites (exit 0)**, including 33 search/parser cases, 16 actual Chromium/UI cases and 5 real encrypted-boundary cases. This adds 54 bounded cases to TT101’s 263, not 54 features or ten new complete Class A rows. Earlier failed runs and the retracted external-page false positive remain recorded below.

Actual systems: one coding agent; repository files, git/gh, web search; Node, TypeScript, ESLint, Next.js; actual PostgreSQL; Playwright with real Chromium using SwiftShader; axe-core; separately installed **music-metadata 12.3.2 (MIT)** as a test oracle. The existing Python environment supports historical Files verification. No independent agent/reviewer, theorem prover, physical screen/audio source, physical permission chooser, Firefox/Safari/mobile device, FFmpeg execution or new cloud service was used. No network/media/crypto APIs were mocked. Historical accessibility tests use real Chromium viewport/CSS-media emulation; SwiftShader is software graphics, not a physical-GPU/display witness. `lean`, `coqc`, `z3`, `isabelle` and `ffmpeg` were not on PATH when checked. Actual versions are recorded in `tt102-runtime.json`: Node 22.22.3, TypeScript 5.9.3, Next 16.2.6, Playwright 1.64.1, Chromium 153.0.8010.0, axe 4.14.0 and PostgreSQL 18.4. Concurrent tool calls and actual background processes occurred; no multi-agent execution is claimed. All screenshots are actual browser captures, not generated imagery.

### Admissible objects and information/access

- Search objects are current, visible **VFS files**, not all application records. Host scans exclude Private, encrypted MIME, trashed and configured excluded paths. Private files require actual in-tab keys; RAM mode remains separate.
- Previously supported node/text/JSON/audio/image values remain available. New admitted structured formats: line-separated JSON objects/values, headed comma/tab-delimited text, and structurally admitted ID3 SYLT/SLT frames. CSV/TSV cells remain strings; formula-looking text is never executed. No schema is inferred from speech or images.
- SYLT timestamp formats 1 and 2 are preserved as **MPEG frames** and **milliseconds**, respectively. No frame-to-time conversion without needed stream information. Nonmonotone/truncated/over-budget frames, unknown timestamp format, and ambiguous BOM-less UTF-16 segments are refused with warnings. Per-string BOM UTF-16 is supported; this does not certify every producer convention.
- Recall uses the existing actual Browser/private-proxy stack inside its window. Proxy rendering is a transformed document, not a full native browser engine replacement. User action opens the pane; Auto Recall requires separate explicit arming for a proxy document. Closing the pane unmounts sessions/watchers and cancels their cancellable jobs. Cookies/sessions stay under the existing proxy model.
- Same-origin exposed HTTP media discovery is not every network response, opaque frame, CSS background, MSE/blob segment, DRM stream, or media source on every site. Titles/URLs are producer/user labels, not trusted attestations of what physical screen the chooser selected.

### Quantifier order and success

For fixed accessible dataset D, request r within the declared limits, and emitted scalar set E(n), a hit on n means **for every normalized query term t, there exists an eligible scalar value v of that same n containing t**. It does not mean terms can be distributed across different files. Normalization is NFKC plus lowercase; matching is literal AND, not semantic recognition, fuzzy inference or complete locale folding.

Completeness is only relative to E(n), the selected page and supported readers. It is **not** `for every possible format/value/site, there exists an unbounded extraction/capture procedure that succeeds`. Changes during traversal can move records across cursor boundaries; no snapshot guarantee is introduced.

For witnessed original-byte saves, saved bytes must equal actual publisher response bytes under SHA-256 comparison. For visible browsing, actual publisher HTML must render and respond to an actual DOM button action through the proxy. A label, blank iframe or static screenshot is insufficient. The live stream and PNG mechanisms retain their independent native encode/decode regression contracts from TT100; they are not proved by an HTTP save.

For private search, the witnessed predicates are actual encrypted writes, readable plaintext in the unlocked browser, absence of that plaintext from observed HTTP URLs/bodies and PG file content/path, then visible Find state clearing on a real UI storage lock. This is not secure GC memory erasure, browser undo/snapshot clearing, removal of already-rendered content in every other app, or protection against compromised same-origin code.

### Units, bounds and boundary conditions

| Resource | Contract / qualification |
|---|---|
| Query | 1–512 characters; at most 32 whitespace terms |
| Field / cursor | 256 / 4096 characters; control characters refused |
| Page | 32 file candidates; SQL fetches 33 for continuation |
| Content | 262,144 stored string units/file in JS; SQL text length is PG characters, not a byte quota; base64 consumes stored-string budget |
| Flattening | 4,096 fields, relative depth 24; cropped provenance/snippets remain bounded |
| Delimited input | At most 4,096 consumed cells; first record is the header; duplicate header values retained in arrays; partial/corrupt input explicitly marked |
| Synchronized text | At most 4,096 entries/frame; unsigned 32-bit timestamps, no invented unit conversion |
| Private traversal | 256 folders, 5,000 candidates, relative depth 32; now attacked with 5,001 actual encrypted files |
| Browsing pane | 540 px fixed pane; secondary tools expandable; measured iframe height at least 250 CSS px in the tested 1440×1000 viewport |
| Original recording | Existing 8 MiB VFS, ~6 MiB recorder stop, 16 MP raster and 16 MiB pending native-write bounds unchanged |
| Auto Recall | Existing 200 discovered URLs / 2,000 nodes, 16 pending jobs, one active fetch and bounded fetch lifetime unchanged |

There is no new universal latency tolerance or hard whole-process memory proof. Directory listings and non-content scalar sizes remain imperfectly bounded. SQL now projects the 15 current non-content columns directly instead of serializing raw content into a temporary JSON object before deleting it. This is a structural improvement, not a measured total-memory theorem. Future schema columns require updating the explicit projection; parity against all 15 current columns is tested.

Adjacent problems deliberately not substituted: ASR/OCR/lyric retrieval; lexical indexing versus literal value matching; archiving versus playback; live encoding versus byte identity; PNG versus original image; DOM replay versus video; transformed proxy versus native authenticated browser; storage lock versus screen/memory wipe; selected green tests versus full-spec Class A; a count cap versus allocation safety; an unsupported rebuild versus a coverage read.

## B. Outcome space and evidence threshold

- **H+ (bounded target):** implemented, executable witnesses at the actual HTTP/PG/native-browser boundary, with external parser/axe/byte comparison where appropriate. This means those contracts and inputs passed, not all possible inputs.
- **H− (stronger universal target):** the claim of automatic successful recording across every site/source/permission condition is refuted by documented consent/origin boundaries and actual fail-closed cases. A library cannot legitimately remove required consent or recover unavailable data by relabeling a capture button.
- **H∂:** other formats/app records, changing datasets, inherited-BOM producer variants, arbitrary page fidelity, authenticated sites, physical capture, native disk streaming and hard global resource safety require additional conditions/verification.

Threshold before acceptance: successful production compilation/types/focused lint; new candidate-specific gates; affected historical regressions; independent observations rather than just capability flags; visual inspection for the new browser pane. No canonical grades are promoted on development tests alone. `tt102-spec-inventory.json` records the actual current feature inventory; the repository's `tier` is platform feasibility and `status` is implementation state, neither a universal correctness certificate.

**The full “all features A” and “ten other newly complete core Class A features” target is NOT established.** The capability table below contains more than ten bounded improvements/witnesses, not ten invented whole-feature promotions. General Arts-mode menu deduplication and font/alignment-bar cleanup remain deferred under the explicit recording-first condition; universal recording/physical verification is not finished. Compact controls inside the newly added Recall browsing pane are part of making that feature usable, not a claim to have cleaned up every app.

## C. Frontier, hypotheses and imported results

1. Display capture requires transient activation and a fresh chooser permission; permission cannot simply be persisted. This excludes a silent universal recorder in the ordinary PWA access model, not recording after a real grant. [1](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
2. An origin-unclean canvas can reject `captureStream()` with SecurityError. This is an origin boundary, not proof every clean canvas or protected surface is capturable. [6](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)
3. ID3v2.3 SYLT specifies encoding, language, timestamp format, content type, descriptor and terminated text/timestamp pairs; timestamps can be milliseconds or MPEG frames. The original reader follows that structure and preserves units. [1](https://id3.org/id3v2.3.0)
4. Actual producer discussions document ambiguity around UTF-16 BOM inheritance. These discussions are interoperability evidence, not a normative theorem selecting one interpretation; ambiguous segments are currently refused rather than guessed. [2](https://lists.id3.org/pipermail/id3v2/2010-February/000114.html) [4](https://lists.id3.org/pipermail/id3v2/2006-February/000277.html)
5. RFC 4180 describes quoted commas/newlines and doubled quotes. The new headed metadata reader handles those tested constructions, also accepts LF/CR and TSV, and is not claimed universally RFC-conformant or a general dialect detector. [1](https://www.rfc-editor.org/info/rfc4180/)
6. The installed music-metadata parser was executed on the same actual SYLT bytes and agrees on text and millisecond timestamps. Its MIT license was checked via installed-package context and `gh api repos/Borewit/music-metadata/license --jq '.license.spdx_id'` (MIT). No library implementation was copied into runtime. Original construction preceded oracle comparison; no “globally best library” claim is made.

The open interface is explicit: supported observed text and authorized streams versus unavailable bytes, producer dialects, access restrictions and fidelity/resource obligations not covered by these witnesses. No permissive code can bypass the consent hypothesis while still satisfying the stated privacy/access model.

## D. Negative space — false solutions and detecting attacks

| # | False solution shape | Detection / status |
|---|---|---|
| 1 | Rename the URL form “browser” | Actual proxied publisher heading plus interactive DOM mutation in `e2e-tt102` |
| 2 | Show a static screenshot and call it browsing | Actual Go navigation and page button action must work |
| 3 | Open a browser and silently arm downloads | Initial watcher must be disabled; reopen must be disarmed |
| 4 | Save unrelated bytes while claiming visible media | Actual publisher-versus-VFS SHA-256 equality |
| 5 | Only discover initial media | Actual publisher adds an image dynamically; second archive required |
| 6 | Leave archiving active after pane close | Real `/slow` HTTP archive enters fetching, then pane close must cancel it |
| 7 | Duplicate browser/Recall launch buttons recursively | Embedded view omits both redundant Recall launchers; ordinary Browser retains them |
| 8 | Hide controls by deleting their behavior | Expandable Browser/Page tools retain advanced actions and real find-in-page |
| 9 | Give media only a tiny viewport | Actual frame bounding-box ≥250 CSS px in declared desktop test |
| 10 | Call raw JSONL text structured metadata | Field-specific lookup must return `content.lines[1].lyrics` |
| 11 | One malformed line hides later records | Later valid record found, partial/warning required |
| 12 | Recognize JSON only by filename | NDJSON and vendor +json MIME witnesses on `.bin` names |
| 13 | CSV split on commas/newlines | Quoted comma, doubled quote and embedded newline attack |
| 14 | Duplicate headers overwrite earlier/later values | Later duplicate-header lyric found with array provenance |
| 15 | CSV `__proto__` mutates object prototypes | Null-prototype records; real hostile-header file query and unchanged ordinary object |
| 16 | Drop a CSV quote error silently | Structured lookup fails while raw text survives with explicit warning |
| 17 | Array fields fall outside field selection | Array descendant matches, similarly prefixed sibling does not |
| 18 | SYLT is just USLT text with binary junk | Native byte fixture plus independent parser agreement on text/timestamps |
| 19 | Interpret all timestamps as ms / signed int | MPEG-frame unit witness and unsigned 3,000,000,000 ms value |
| 20 | Publish truncated/descending/ambiguous lyric text as complete | Malformed, nonmonotone, ambiguous BOM and 4,097-entry refusal attacks |
| 21 | Private search is a host query with a “local” badge | Actual UI-unlocked encrypted write/search, HTTP observation and PG plaintext check |
| 22 | Lock only blocks future reads but leaves Find plaintext visible | Real storage Lock button must clear hits/query/field/scope/cursor; retry cannot resurrect hits |
| 23 | Report a traversal counter without bounding behavior | PG independently contains 5,001 files; decrypted list has 5,001; cursor after 4,999 yields zero scanned with partial enumeration, which the old overshoot would fail |
| 24 | Legacy `/foo` includes `/foo-sibling` | Real HTTP legacy sibling/root/wildcard-scope witnesses |
| 25 | Return `rebuilt:true` after merely counting | POST now returns 501 and `rebuilt:false`; no fake rebuild |
| 26 | Fix resource use by silently dropping node fields | Independent PG `to_jsonb` reference versus all current projected columns, including tags/null/dates |
| 27 | A green dev build proves production | Separate fresh production build and full selected regression gate required |
| 28 | Repeated tests are isolated just because DB is disposable | A static root sentinel collided on rerun; failure retained, unique sentinel plus prior-run-noise attack added |
| 29 | Fifty tests mean fifty complete features | Explicitly rejected; no grade promotions, 54 new bounded cases planned |
| 30 | A count limit proves global memory/latency safety | Explicit H∂; no such theorem/benchmark claimed |

The modal shortcut is **a browser-looking form without actual viewing and page-bound archival**. Its detecting experiment requires actual HTML rendering, Go navigation, a real page DOM mutation, VFS bytes equal to the live HTTP publisher, and cancellation on pane teardown. A relabeled form or static picture cannot pass those observations.

## E. Mechanism portfolio and candidate-specific attackers

| Candidate / central construction | Artifact and established portion | Strongest cheap structure-derived attacker | Exact unresolved interface; local or original-scale gap |
|---|---|---|---|
| C1 Original HTTP bytes | Existing Recall queue; real publisher/hash regression and new embedded Auto Recall witness | Partial/oversize/slow/changed response; close during fetch | Publisher permissions, stream manifests and atomic receipt/media persistence; partly local, universal access is original-scale |
| C2 Authorized live stream encoding | Existing MediaRecorder path; retained native canvas/audio regression | Missing audio, ended track, codec refusal, source close | Physical chooser/audio/native disk not exercised; boundary verification, not byte identity |
| C3 PNG raster | Existing native raster/PNG decode regression | No frame, origin-tainted surface, 16 MP or byte overflow | Only authorized decoded surface, not arbitrary DOM/original image; access gap original-scale |
| C4 Browsing orchestration | Original Browser reused inside Recall; real proxy navigation, arming, mutation, close/cancel/restore | Late title/probe overwrite, recursive launcher, hidden armed watcher, slow archive after close | Proxy fidelity/auth/cross-origin/DRM; local integration closed on witnesses, universal fidelity not closed |
| C5 Line-structured JSON | New bounded branch in `metadata.ts` | MIME without suffix, corrupt middle line, 4,500 lines | Unknown app records/binary schemas and whole-process budgets; local reader, general schema inventory original-scale |
| C6 Delimited state machine | Original `delimited.ts`, string cells and duplicate-value arrays | Quoted newline, quote suffix injection, duplicate/prototype header, >4,096 cells | Headerless/dialect inference, malformed-tail recovery and unique path escaping; local extensions, not complete metadata extraction |
| C7 Timestamped ID3 text | Original SYLT/SLT decoder; independent native-tag oracle | Unsigned overflow, wrong unit, nonmonotone/truncated/BOM ambiguity/4,097 segments | Other producer conventions, containers and frames; local supported-reader gap |
| C8 Decrypted in-tab search | Existing real crypto plus visible-lock clearing | HTTP plaintext, key revocation mid-read, already-published result after Lock | Same-origin compromise, other app buffers, memory/undo/snapshots; whole-system privacy not implied |
| C9 RAM-only query | Existing real RAM filesystem, retained TT101 witness | Demand host-overlay result with no host I/O | By design no persistent/host overlay; boundary changes contract |

Early independence is preserved: byte equality is not inferred from stream encoding, raster validity does not prove either, and parser agreement does not prove browser integration. Some candidates predate this turn and are explicitly regressions, not newly invented mechanisms. Every candidate returns executable code/tests, a quantitative bound, or a documented access counterexample rather than a status-only assertion. The external-page test repair also illustrates verifier-specific adversarial testing: an actual TLS error containing the expected URL must be rejected.

## F. Implemented capabilities, not invented grades

| Bounded capability | Actual artifact/witness |
|---|---|
| 1. Recall browsing pane | Real Browser/ProxyFrame render inside Recall |
| 2. Active page/source/title following | Actual Go navigation and publisher title callback; proxy mode skips irrelevant framing probes |
| 3. Visible-page automatic archive | Custom-folder publisher bytes verified under SHA-256 |
| 4. Dynamic-media discovery inside Recall | Actual page button creates another image; saved second archive |
| 5. Close-time queue teardown | Actual slow HTTP fetch cancels on pane close |
| 6. Browser session restore without rearming | Active tab survives close/reopen; watcher is off; embedded props persist without standard Browser's delay |
| 7. Compact optional browser/page tools | Existing advanced controls preserved; actual find and viewport check |
| 8. JSONL/NDJSON field search | Actual stored records with structural provenance and partial warnings |
| 9. Headed CSV field search | Duplicate headers, quotes/newlines and hostile keys handled as data |
| 10. TSV field search | Actual tab-separated transcript values |
| 11. Array descendant field selection | Correct array match without similarly prefixed sibling leakage |
| 12. Synchronized lyric/text metadata | Supported SYLT/SLT stored text and original timestamp units |
| 13. Private Find lock hygiene | Actual UI unlock/write/search/lock and cleared visible state |
| 14. Legacy scope boundary repair | Real sibling/root/special-character scope attacks |
| 15. Honest rebuild response | Unsupported operation explicitly 501 / false, not implemented rebuild |
| 16. Query-time SQL projection | All 15 current non-content columns preserved without raw-content JSON intermediate |
| 17. Previously unexecuted private cap | Actual 5,001-file experiment with observable cursor behavior and cleanup |
| 18. Privacy credential/recovery lock hygiene | Old production fails actual lock/resurrection attacks; repaired production passes, with visually inspected locked screen |
| 19. Classic desktop accessible grouping | Semantic named group plus patch-specific and full axe checks |

This table is a capability-level delivery list. Items share core modules and do **not** establish ten new complete canonical Class A rows. No package manifest/lockfile, schema or canonical grade changes. Runtime implementation is original or reuses this repository's original components; external MIT parser remains test-only.

## G. Repair and verification chronology

1. Started a source-updating preview early. Inspected previous gaps and existing Recall/Browser/metadata/privacy contracts before editing.
2. Added browsing integration, shared current-page callback, preserved standard Browser behavior and immediate embedded session persistence. Source URL/title freeze during active recording uses the existing busy guard; chooser labels remain user declarations.
3. Added lock-event clearing, literal legacy separator scope, truthful unsupported rebuild, structured line/delimited readers, synchronized text and direct SQL projection. Types and focused lint passed.
4. Real development gates: initial search 30/30, initial UI 13/13. Separately wrote/read **5,001 real encrypted files** (eight actual concurrent writer loops), checked PG count independently, observed the cap through cursor behavior, verified no witness plaintext in PG, and purged the owned fixture. Five boundary cases passed; not a memory proof.
5. Visual inspection found too much toolbar height inside the new browsing pane. Added optional Browser/Page tools without removing normal-browser features. Added a patch-specific actual find/viewport gate and advanced-controls visibility gate; UI reran **15/15**. This is new-feature usability work, not completion of the later all-app Arts menu request.
6. Added unsigned timestamp/BOM ambiguity attacks. Repeating search tests exposed a **test fixture collision**: the legacy root query's static word matched prior runs. Preserved `tt102-search-root-collision.log`; replaced it with a unique run sentinel and added prior-run common-word noise in that same root test. All **32/32** reran successfully. The application scope predicate was not weakened to satisfy the test.
7. Built actual production against fresh `tt102_gate`. The first complete 22-suite run had **313 passed / 2 failed**, not a green gate (`tt102-production-initial-failed.log`). The legacy scope repair rejected existing callers' trailing separators; normalization now preserves both separator-boundary safety and those calls. A new `/` versus `////` attack was added. The all-module axe run also exposed a pre-existing classic-desktop generic div with a prohibited accessible label; it now has an appropriate named `group` role. A dedicated real classic-desktop role/axe attack was added, and the new Recall browser test now requires native publisher-image decoding as well as HTML. Types/focused lint and the production build reran after these repairs.
8. Preview visual inspection caught a **false positive verifier**: a proxy TLS error page echoed the GitHub URL and passed a loose substring check. Retained `tt102-preview-smoke-false-positive.log` and `tt102-preview-tls-failure.png`; retracted the external-page success claim. The sandbox's configured system CA trust is now enabled via `NODE_OPTIONS=--use-system-ca`, not TLS verification disablement. The strengthened test rejects the actual error document and requires an actual `package.json` file-listing link, not an echoed URL. A wrong README assumption also failed and is retained in `tt102-preview-smoke-wrong-oracle.log`; direct upstream HTML confirmed this repository has no README.md listing. The repaired verifier was attacked against a separate actual no-system-CA server: it failed for the intended error-page reason (`tt102-tls-negative.log`). The normal trusted preview then passed the actual external document and CSV UI checks. No responses, permissions or certificates were fabricated.
9. Normal production preview on **3001** uses `tt102_preview`, no loopback-test flag, and only one explicitly authored CSV example. Actual external repository file-listing and CSV field-search screenshots were visually inspected. GitHub styling/assets are incomplete under the proxy/egress policy; that is shown, not represented as full site fidelity. Browsing remains opt-in after reload; sessions store full URLs with ordinary desktop state under the existing Browser persistence model (not encrypted private history).
10. The second run was also **not green** (`tt102-production-second-failed.log`): the new fresh-database UI test issued settings PUT before bootstrap, yielding setup failure; Orbit crashed on screenshot waiting, palette had two timeouts, Recall's toast test timed out, and the spreadsheet accessibility case timed out. These are retained, not erased by retries. A concurrent lint job ran during part of this run; causation of the timeouts is **not established**. The setup now explicitly GETs settings before PUT. No test was disabled and no timeout was increased.
11. Visual inspection of the locked-private screenshot then found a separate **inherited Privacy bug**: the recovery key remained visible while storage was locked. The screenshot contained only a disposable test volume's key, but the old database was destroyed and the retained failure image was pixel-redacted (`tt102-private-locked-before-repair-redacted.png`). Privacy now drops recovery display, passphrase/repeat/new/backup fields, audit mapping and backup-report state on locked status, and only renders recovery while unlocked. The candidate-specific attack fills credential fields, locks, then unlocks and checks that neither recovery nor old credentials resurrect. Against an actual separate **old production build**, the strengthened test failed exactly those two cases: **14 passed / 2 failed** (`tt102-privacy-lock-negative.log/json`). No private session keys or media APIs were injected.
12. A third fresh production build and quiet sequential 22-suite gate use **tt102_release**, with the new bootstrap fix, privacy repair, 33-case search and 16-case UI tests. No parallel lint or extra audit browser runs during this gate. **Final result: 317 passed / 0 failed; 22/22 suites completed; exit 0.** Palette 11/11, Orbit 22/22, Recall 27/27 and all-module accessibility 9/9 passed in this run without changed timeout limits. This does not explain the earlier timing failures or establish deterministic success in every environment.

Intentional archive cancellation produced server-side aborted/ECONNRESET response-pipe logs; the zero-uncaught-error browser assertion is not a claim of zero server logs. Verification server 3000 and the local publisher were stopped after the successful run; the normal 3001 preview remains running without test-loopback access.

Final suite ledger and source hashes: `docs/evidence/tt102-production-summary.json`. Counts are test cases, not proof of every possible input.

Evidence: `docs/evidence/tt102-{build,typecheck,lint,search-dev,ui-dev,private-bound-dev,production-gate}.log`; per-suite JSON in `docs/test-results/`; actual `tt102-recall-browser.png` and `tt102-private-locked.png`. Historical TT100/TT101 screenshots are restored after regression capture, not relabeled as current evidence.

## H. Reproduction and verifier alignment

Use a genuinely disposable initialized PostgreSQL database, not a user's data. `BASE` and `DATABASE_URL` must identify the same running server/database. Example:

```sh
npm ci
export DATABASE_URL=postgresql://postgres@127.0.0.1/tt102_release
npx drizzle-kit push --dialect postgresql --schema ./src/db/schema.ts --url "$DATABASE_URL"
npm run build
# Separate terminals (test-only loopback exception):
NODE_OPTIONS=--use-system-ca FUSION_WP_TEST_LOOPBACK_PORTS=4001 npm run start -- --hostname 0.0.0.0 --port 3000
node scripts/tt100-fixture.mjs
# In the test terminal with DATABASE_URL still exported:
TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 \
 SUITES='e2e-tt102 tt102-search tt102-private-bound tt101-search e2e-tt101-search privacy-layer unit integration browser-session tt55-files-unit e2e-tt55-files e2e-tt55-shell e2e-tt96-desktop-menu tt97-palette-commands e2e-tt97-palette-actions e2e-tt97-files-empty-a11y e2e-tt98-orbit e2e-tt99-interactions e2e-browser tt69-lifecycle e2e-tt100-recall e2e-a11y' \
 bash scripts/run-all.sh
```

Normal preview: `NODE_OPTIONS=--use-system-ca DATABASE_URL=postgresql://postgres@127.0.0.1/tt102_preview npm run start -- --hostname 0.0.0.0 --port 3001`; do not set the loopback-test flag. The separate explicit preview example/experiment is `TT102_PREVIEW_EXAMPLE=1 BASE=http://127.0.0.1:3001 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt102-preview-smoke.mts`. It refuses to overwrite a user-edited example. System CA trust is a deployment hypothesis in this sandbox; no insecure rejectUnauthorized bypass was added.

The app's checked-in Drizzle JSON has a hard-coded DB URL; the explicit CLI URL above is necessary. Real Chromium is resolved via the existing browser launcher (`PW_CHROMIUM` or external tools). The independent oracle still imports `/home/user/tools/node_modules/music-metadata/lib/index.js`; install version 12.3.2 there or adapt that test import. The historical Python environment is required by relevant old tests. No extra runtime dependency is installed.

The UI suite creates/unlocks an actual temporary test volume through the actual UI. On repeat it uses the same declared test passphrase; it is unsuitable for a preexisting unrelated volume. Page evaluation calls the real application's installed fetch/encryption layer; no keys, permission grants, crypto results, network responses or media APIs are mocked. The publisher is an actual local HTTP service with deterministic media bytes and actual DOM buttons, not intercepted API responses. Its slow request is a causal cancellation witness, not a fabricated state flag. Real test media is not evidence of physical audio or arbitrary external-site fidelity.

Only the listed 22-suite gate is claimed, not the repository's much larger default run-all or exhaustive malformed corpus. Selected suite cases are counted once; multiple internal assertions in one case do not become invented feature counts.

## I. Exact remaining gaps

- Universal metadata coverage is still false: folder/application-record metadata, arbitrary archives/office/PDF/video containers and reader-unsupported fields remain outside the new contract. Empty queries are refused; arbitrary field-name schemas/path escaping and every CSV dialect are not solved. No generated ASR/OCR/lyrics.
- SYLT support is strict and partial; the legacy SLT branch is implemented but not independently fixture-certified: ambiguous BOM inheritance is refused, timestamps are not turned into a playback/karaoke feature, and other producer/container/frame combinations are not certified.
- Private enumeration now has a real 5,001 witness, but response/list allocation, arbitrary node scalars and global concurrent-work/RAM bounds remain open. SQL projection reduces an avoidable intermediate; it does not prove optimal performance.
- Visible Find state clears on storage lock. This is not all-app screen locking, secure GC/undo/snapshot erasure or resistance to hostile same-origin code. Internal bounded reads can finish after UI cancellation.
- Query paging has no mutation snapshot. Excluded old fast-index rows may persist; output filtering is not no-index/no-persistence. Rebuild is now honestly unsupported, not completed.
- Recall browser retains proxy limitations: transformed/sanitized documents, potentially missing assets, authenticated-site/session differences, opaque frames, DRM, MSE/blob and site-specific incompatibilities. It cannot guarantee every viewed media is archived. HTTP success is not codec fidelity. Media/receipt commits remain non-atomic and unsigned.
- Physical chooser/audio/native-file/backpressure/browser-matrix verification remains absent. The three real capture mechanisms are retained and tested within headless/native-media bounds, not universally certified production-ready.
- General all-app Arts-mode duplicated-menu and font/alignment-bar cleanup is not performed because the recording-first condition remains open. New Recall-only compact tools do not imply that broader task is complete.
- All Class A / ten newly complete core Class A rows are not established. No canonical grades changed. The actual 414-row inventory still includes 24 blocked, 39 partial and 18 probe rows; even a `built` status is not a universal correctness certificate. A fresh full-repository lint audit still reports **173 errors / 16 warnings** (`tt102-full-lint.log`), whereas final changed-file focused lint passes; full default run-all and independent review/proof are absent.

## J. Strongest artifact and stopping boundary

Strongest artifact: a production-capable Recall browsing pane with real page-bound archiving/cancellation witnesses; broader existing-value metadata readers; actual unlocked-private browser/lock verification; and a previously missing real 5,001-file resource-boundary experiment. These close named TT101 gaps without pretending universal extraction/capture or silently promoting grades.

Next highest-information work: authorized physical tab/audio/native-disk verification; an independent malformed metadata corpus including inherited-BOM producers; schema-aware application-record search; streamed/paged private directory listing with actual memory measurement; and separate Arts-menu inventory/cleanup once the sequencing condition is satisfied. PR #7 is updated for review only and **must remain unmerged**.

### Additional explicit boundaries after visual repair

The Privacy credential-state repair is not a secure-erasure/JavaScript-GC or all-app-buffer proof, and does not certify create/rotate-versus-lock races. Metadata pages have no cross-page snapshot guarantee during concurrent mutation. NFKC + lowercase is the declared literal normalization, not stemming, fuzzy search, ASR or full Unicode casefold. The retained second gate's timing failures remain unexplained unless reproduced and diagnosed; a later passing run does not retroactively make that run green.

## Final selected production results

| Suite | Passed | Failed |
|---|---:|---:|
| e2e-tt102 | 16 | 0 |
| tt102-search | 33 | 0 |
| tt102-private-bound | 5 | 0 |
| tt101-search | 37 | 0 |
| e2e-tt101-search | 9 | 0 |
| privacy-layer | 13 | 0 |
| unit | 23 | 0 |
| integration | 25 | 0 |
| browser-session | 5 | 0 |
| tt55-files-unit | 7 | 0 |
| e2e-tt55-files | 14 | 0 |
| e2e-tt55-shell | 3 | 0 |
| e2e-tt96-desktop-menu | 5 | 0 |
| tt97-palette-commands | 4 | 0 |
| e2e-tt97-palette-actions | 11 | 0 |
| e2e-tt97-files-empty-a11y | 3 | 0 |
| e2e-tt98-orbit | 22 | 0 |
| e2e-tt99-interactions | 29 | 0 |
| e2e-browser | 6 | 0 |
| tt69-lifecycle | 11 | 0 |
| e2e-tt100-recall | 27 | 0 |
| e2e-a11y | 9 | 0 |
| **Total** | **317** | **0** |
