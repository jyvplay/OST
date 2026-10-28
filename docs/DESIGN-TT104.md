# TT104 — resident-media pathways and inspectable Recall memories

## Runtime honesty / current verdict

**Bounded implementation, not ALL-A, ten new complete core features, or universal production readiness.** Final selected production verification: **409/409 cases, 29 suites**, followed by an actual Specs UI smoke. Six additional Recall requirements are registered as partial; existing requirements remain partial. Ten or more tested contracts are not ten completed OS modules.

Actually used: one coding agent; shell/file/process tools, Git and authenticated gh, GitHub API research, page retrieval, Node v22.22.3, npm, Next 16.4.3, TypeScript, ESLint, real PostgreSQL 18.4, real Chromium 153 via Playwright and @sparticuz/chromium (software graphics). Python 3.11.2 venv restored for the existing real ZIP oracle. Embedded PostgreSQL, Chromium and music-metadata are external verification tools, not added app dependencies. No independent agent/reviewer, simulator, theorem prover, physical microphone/audio/display chooser, physical clipboard operator, or OS file-drag operator was used. `lean`, `coqc`, `z3`, `isabelle`, `ffmpeg` were not available on PATH. No new app package or schema dependency. No imitation clipboard, synthetic ClipboardEvent/DataTransfer, permission override, substituted microphone or intercepted network response was used in the new tests. Playwright defaults include `--use-mock-keychain`, a basic test-profile password store and muted audio; no native OS keychain/audio claim follows. Download byte checks enable Playwright download acceptance; they do not exercise a physical save dialog. Historical suites include CSS-media/viewport emulation and response-loss/offline fault injection, not physical device or network experiments. No mock application media/clipboard implementation was supplied.

Preview started early on 3001, initially development mode; normal UTF-8 database `tt104`, no loopback proxy exception. Production verification is on 3000, exclusive disposable UTF-8 `tt104_test`; explicit test-only publisher grants 4001/4002. Servers bind 0.0.0.0, browser backend URLs remain relative. Prior processes/dependencies/database were absent after checkout restoration and actually reinstalled. Initial drizzle command accidentally used the repository's hardcoded app_db configuration and failed; explicit CLI URL/schema/dialect repaired setup without altering that configuration.

## A. Formal model

### Objects / access

- A File exposed by the real browser in a deliberate chooser/paste/drop action, with one-file cardinality, a declared image/audio/video MIME, nonzero length at most 8,388,608 bytes. File metadata is not evidence that bytes are a valid codec. A pasted PNG is the clipboard's representation, not necessarily the source site's encoded bytes.
- An already-decoded eligible canvas/video/image in the current sandboxed Fusion document. TreeWalker streams through the document until it finds the first **200 visual candidates** or reaches the end, then uses the existing viewport-intersection/bounding-area selector. Native PNG capture retains the prior 16,777,216-pixel / 8 MiB caps, nonce/source/generation/deadline and native decode admission. This is neither original video extraction nor a complete webpage screenshot.
- Saved media in one canonical `/Downloads/Recall/<group>` folder. A page projects metadata only, excluding trash/nonmedia/oversized metadata; keyset order is strictly decreasing integer insertion ID. This is insertion order, not necessarily event-time order for externally imported or restored memories.
- A version-1 JSON receipt, at most **16,384 UTF-8 bytes**, associated by exact path/MIME/length with saved bytes. The checker requires valid canonical millisecond UTC ISO time and exact lowercase SHA-256. It verifies consistency of the stored pair, not the origin, human attention, creator, chronology, signature or open preview snapshot.
- Existing authorized display/Fusion streams and explicit HTTP response copies retain their separate semantics and permission requirements.

Ordinary browser access only. Human initiation describes the supplied UI workflow, not a cryptographic barrier against same-origin XSS, extensions or devtools scripts; those can already access the app APIs. Paste/drop consume FileList objects, never text/html, text/uri-list or getData URLs. No arbitrary browser cache inspection or hidden HTTP fallback. Same-origin VFS APIs remain server-readable plaintext; amnesic-mode Recall writes remain prohibited by the existing privacy guard. New pathways do not weaken sandbox or clipboard permissions.

### Success predicate / quantifiers

For every *admitted and completed* resident-File action x in the stated regime, there exists a saved media file f and receipt r such that bytes(f)=bytes(x), method(r) identifies the pathway, and successful receipt verification establishes exact digest/length/path/MIME consistency. Admission failure must not initiate an archive write. Existing failure between media and receipt commits can leave an orphan media file and must not be reported as complete.

For every eligible page request (folder, optional before-ID), every returned node belongs to that folder, is nontrashed media and has ID below before when supplied; at most 100 rows are returned, and a continuation is present iff the one-row lookahead finds more. This is a read-committed page contract, not `exists one immutable snapshot such that forall pages` under concurrent writes/deletes. Strict ID decrease prevents overlap during append-only insertion, not arbitrary identity-preserving mutation.

For every accepted saved-byte verification, digest equality and the checked receipt fields hold for the **read pair**. Two HTTP reads are not atomic; a concurrent mutation can yield a mismatch. A malicious writer replacing both records can manufacture consistency. A success cannot certify the currently open Blob preview, which may be older; the UI says so.

For every local export operation where the browser produces a download, its bytes equal the already-open Blob. A click is only a request until native browser download policy allows it. This is not an upstream media fetch, proof of a physical save dialog, or proof of final disk durability.

### Resources / boundaries

Timeline SQL LIMIT 101; at most 100 returned rows; at most 400 displayed entries. Metadata admission caps path/name/MIME at 1024/512/256 UTF-8 bytes, respectively, **before transfer**. Unusual legacy names beyond these bounds are excluded, not truncated or silently claimed complete. Cursor: canonical decimal 1..2,147,483,647; no floats/exponents/leading zero/negative/SQL fragments. Root and nested/noncanonical grouping paths rejected. Only the retained candidate count is bounded; total traversal, including internal visits to non-element nodes, is not bounded. This preserves the previous first-200 selection rather than rejecting late visuals after an arbitrary element cutoff. SQL scan/sort cost, Postgres internal memory, request buffering, JSON parser allocations, total VFS contents and browser GC are not globally bounded by these counts. The 16 KiB receipt cap is checker admission after the ordinary VFS read, not a 16 KiB transport-allocation bound; an oversized stored receipt can already have been received. No whole-system RAM or universal latency theorem.

SHA-256 comparisons are exact, bytes use exact equality, native controlled canvas pixel tests use exact RGBA. At the count/byte boundary exactly 8 MiB is admitted; one byte over is rejected. PNG-decoder protections do not prove safety of every other codec.

Adjacent problems NOT substituted: download vs already-loaded access; original encoding vs decoded pixels; File import vs cache extraction; clipboard representation vs upstream original; one visual vs whole screen; bounding-box intersection vs actual visibility/attention; timeline listing vs semantic search; integrity vs authenticated provenance; server plaintext vs local OS-enclave storage; pagination vs immutable snapshot; row bounds vs SQL-work bounds; export request vs physical disk commit; component tests vs whole-feature A grades.

## B. Outcome space / evidence threshold

- **H+ (bounded):** browser-exposed resident files/clean decoded pixels can be saved, inspected, paged and exported without requesting upstream bytes again.
- **H− (stronger shortcut, not a proof against the whole human-assisted task):** silently treating an arbitrary webpage drag URL as previously loaded original bytes is not a valid construction. Fetching it can return changed data and is a new network operation. Existing browser-origin/taint/permission constraints do not supply arbitrary cross-origin/protected pixels. An unkeyed digest cannot authenticate against a writer controlling both media and receipt.
- **H∂:** positive image paste/drop depends on browser-supplied File representations/native permission. Page completeness changes at candidate/metadata/count boundaries; codec, physical clipboard/audio/display and browser matrices remain conditional.

Before commit/merge: production compile and typecheck; zero changed-source lint errors; executed pure receipt/admission attacks and real SQL/HTTP pagination tests; real Chromium saved-file/replay/integrity/export/native-negative-transfer and late-visual compatibility tests; affected TT100–TT103/browser/privacy/files/shell regressions; current dependency audit disclosure. No claimed positive clipboard-image or physical-drag proof without an adequate native run. Failing production gates are repaired/rerun or block merge. Whole-repository lint debt is disclosed, not silently redefined as clean. The threshold licenses bounded delivery only.

## C. Retrieved frontier / exact open interface

1. [MDN paste event](https://github.com/mdn/content/blob/main/files/en-us/web/api/element/paste_event/index.md), retrieved via gh: a native human paste action produces a paste event; handler can inspect clipboardData and cancel default insertion. Constructing a synthetic event is not native clipboard acquisition. This supports event-driven receipt of exposed files, not unpermissioned background clipboard inspection.
2. [MDN DataTransfer.files](https://github.com/mdn/content/blob/main/files/en-us/web/api/datatransfer/files/index.md), retrieved via gh: files are available in drop/paste; outside these events the protected data store can make them empty. Therefore files must be captured synchronously during the event, not re-read after an async permission/network task.
3. [MDN native file drag/drop](https://github.com/mdn/content/blob/main/files/en-us/web/api/html_drag_and_drop_api/file_drag_and_drop/index.md), retrieved via gh: OS files and within-page drags are distinct cases; a chooser is an accessibility fallback. We wrote our own handler, did not import this guide's implementation.
4. [Microsoft Manage Recall](https://learn.microsoft.com/en-us/windows/client-management/manage-recall), actually retrieved with page tool: on supported Copilot+ PCs, Recall provides opt-in local screen snapshots/timeline and local search; documented Windows Hello/TPM/VBS-enclave encryption and sensitive-information filtering are OS facilities with hardware/identity hypotheses. They are not implied by an ordinary PWA, plain Postgres storage or a checkbox. Inspiration: explicit consent and inspectable timeline, not background surveillance or a false encryption equivalence.
5. [W3C Clipboard API and events](https://www.w3.org/TR/2026/WD-clipboard-apis-20260624/), retrieved chunks 0–1: **Working Draft**, not a final Recommendation or a promise of uniform implementation. Introduction distinguishes event-driven clipboard hooks from permission-controlled Async Clipboard. Section 5.1 describes native clipboardData as a filtered live view, multipart items/files, and synthetic event data as script-provided. This supports the mechanism distinction, not bypass of browser filtering or proof of native image delivery. Only the retrieved sections are relied on; clipboardchange/background observation is deliberately not implemented.
6. Inherited CORS/PNG/native capture frontier is rechecked by actual existing taint/native-decoder regressions, rather than asserting a new permission bypass. A bibliography is not independent exploit proof.

Failed retrievals retained in the research note: guessed Microsoft support URL returned page-not-found; MicrosoftDocs GitHub path/tree returned 404; first guessed MDN drag/drop path returned 404, corrected to API path. These failures are not cited as successful sources. Research snapshots/notes under `docs/evidence/tt104-research/`; no runtime dependency or source implementation copied. MDN documentation is reference material, not app code; existing permissive app stack unchanged.

Exact open interface: acquiring the user's intended already-loaded original representation when the browser exposes only a URL or protected decoded output; physically validating native file/clipboard/display flows; and integrating private encrypted storage/retention without leaking metadata or breaking existing APIs. No researched library erases origin, DRM or consent restrictions.

## D. Negative space (20 false solution shapes)

1. Refetch a drag URL and call it resident memory: changed source/no-refetch counterexample. Native URL-only drag test observes trusted drag types and unchanged real publisher counter.
2. Accept HTML `<img src>` as image bytes: nonmedia/URI-only admission rejects.
3. Dispatch synthetic ClipboardEvent and claim native clipboard works: explicitly not used; real write denial retained.
4. Grant automation clipboard permission and call it physical consent: no override used; no such claim.
5. Count paste/drop wrappers as three independent algorithms: one resident-File mechanism in portfolio.
6. Trust MIME as codec proof: no general codec claim; native PNG decoding remains separate.
7. Silently save the first of multiple dropped files: reject entire multi-file admission.
8. Truncate overlarge media into a supposedly complete file: exact-boundary admission tests.
9. Return 100 rows after fetching every body: metadata-only SQL LIMIT/byte-length admission, sentinel tests.
10. Offset pagination under insertion and claim stability: strict keyset ID continuation; append-between-pages experiment.
11. Say keyset pages form an immutable transaction snapshot: explicitly not guaranteed.
12. Apply a global cursor across a changed grouping folder: UI older-page requests validate folder binding.
13. Truncate a long path then open/export the wrong file: exclude overlimit metadata in SQL, never truncate identity.
14. Treat .recall.json presence as integrity: compute SHA-256 and bind path/length/MIME/schema.
15. Treat matching SHA as authorship: no key/signature; replacing both records is a constructive forgery.
16. Check stored bytes then call the stale open preview verified: separate snapshots disclosed in success message.
17. Return 'download requested' as physical disk durability: actual browser download byte comparison; physical dialog still unknown.
18. querySelectorAll then slice(200) as bounded discovery: streaming TreeWalker replaces full NodeList construction; a visual after 2005 nonvisual elements remains capturable. No total traversal-work bound is claimed.
19. 16K UTF-16 code units as 16 KiB UTF-8: repaired byte counting and multibyte attack.
20. Passing 400 component cases as ten complete A features / all-A: no status promotions; unmet privacy/native matrix listed.

Modal shortcut is #1. No assumption that HTTP cache reuse guarantees byte identity: even a cache hit has different semantics from possession of original resident bytes. The real publisher counter is measured before/after native transfer/export and existing loaded-pixel operations; malformed/URI-only pathways must not route to URL queue.

## E. Mechanism portfolio (distinct mechanisms, not six names for imports)

| Candidate | Central construction / artifact | Established portion | Interface / cheapest falsifier / gap |
|---|---|---|---|
| C1 exposed resident-file transfer | Native FileList→oneResidentFile→unchanged byte commit. Paste/drop grouped as one mechanism; chooser retained | Native File object admission/byte equality and rejection boundaries; real native text/URI negative transfers | Positive physical file-drop/image-paste matrix unresolved. Falsify with native source exposing URI only. Local browser/access boundary, not arbitrary cache solution |
| C2 decoded-surface acquisition | Streaming TreeWalker + native canvas PNG + existing source/nonce/generation/native-decode gate | Controlled rendered pixels, no-refetch, taint refusal; late-visual compatibility experiment and repeated positive save | Original encoded video/music absent; occlusion/protected surfaces not solved. Falsify with taint or an eligible candidate outside the first 200 visuals. Global universal-capture gap remains |
| C3 server keyset index | SQL projection/filter/ID cursor/LIMIT lookahead; recallPage route and tt104-page | Real DB/HTTP exact pages, no overlap after append, malformed cursors, trash, byte-limit metadata exclusion | Not transactional across pages or global semantic recall. Falsify with delete/move between pages. Local listing contract |
| C4 integrity inspection | Schema-bound exact SHA-256 of read bytes; verifyRecallReceipt + UI | Tampered digest/bytes/path/length/MIME/version/time and UTF-8 bounds rejected, valid pair accepted | No authenticated provenance or two-read snapshot. Cheapest forgery is replacing both bytes and receipt. Local integrity property, global authenticity not supplied |
| C5 local Blob export | Existing open object URL→native anchor download | Real Chromium download bytes equal open saved bytes; upstream publisher counter unchanged | Native final disk save policy/durability unresolved. Falsify with browser download denial. Local export property |
| C6 authorized live stream encoding (retained) | Existing getDisplayMedia / Fusion captureStream→MediaRecorder/PNG, independent native stream mechanism | Retained implementation and selected existing native capture regressions, not relabeled as new functionality | Human display/audio/chooser and codec matrix unresolved. Cheapest next test is physical denied/granted chooser with known audio. Not original already-loaded compressed bytes |

These mechanisms were preserved rather than collapsing all approaches into HTTP fetch. Each has code/test/counterexample artifacts. C6 is existing work, not counted as a new feature. Private-enclave equivalence is rejected by the actual plaintext server-readable archive, not represented by an empty encryption toggle.

## F. Delivered artifacts / Specs

- `src/lib/recall-memory.ts`: one-file admission, strict receipt checker; no network operation.
- `RecallMemory.tsx`: focused paste/drop target, paging/older-page folder binding, 400-item cap, explicit stored-byte verification and local export. Native permission/image representation caveats visible. Existing chooser/copied-image/URL/recording paths retained.
- `src/app/api/fs/route.ts`: separate `recallPage`, canonical folder/cursor admission, metadata-only projection, row/UTF-8 caps, lookahead. Existing list/read/Files operations unchanged.
- `public/wp-shim.js`: cursor scan removes full querySelectorAll match-list allocation.
- Specs `RC-16..RC-21`, all partial, plus clarified RC-03/07/09; seed version 3.76.10. 21 total Recall requirements, including unmet encrypted archive/retention/sensitive filtering.
- `tt104-memory-unit.mts`, `tt104-page.mts`, `e2e-tt104-memory.mts`, `e2e-tt104-pages.mts`; added only to disposable default runner group. Historical TT103 assertions narrowed to their original RC-01..15, not removed/weakened for those requirements.

## G. Second-order adversary / repair history

A(C1): provide multiple/empty/oversize/HTML/playlist/unknown-MIME files or native URI-only drag/paste; admission rejects. Real image clipboard write was denied by headless Chromium (no permission override). Original probe failed the positive expectation; changed the claim/test to the actual permission boundary, preserving failed evidence and explicitly leaving positive image paste unverified. This is not a production permission bypass repair.

A(C2): bury an otherwise valid visible canvas after 2005 hidden elements. Review caught that an initial 2000-element cutoff would regress the prior first-200-visual behavior. Removed that cutoff, retaining streaming traversal and the 200-candidate memory bound. New attack requires the late canvas to save successfully without removing the prefix, then verifies a second save after prefix removal. This is a compatibility repair, not a claim of bounded traversal CPU. Existing hostile producer with valid token/malformed PNG and real taint attacks rerun.

A(C3): invalid integer cursor, traversal/root/private/nested grouping, inserted newer rows between pages, trashed rows/folder, nonmedia and huge metadata. Initial LIMIT-only review identified that bounded rows do not bound oversized path/name/MIME strings. Repaired with SQL UTF-8 byte filters **before transfer**, added oversized-metadata attack and rebuilt before the final gate. Total SQL-work bound remains unproved.

A(C4): same-length byte tamper, wrong path/MIME/size/schema/time, malformed JSON and multibyte padding. Review identified UTF-16 length vs UTF-8-byte confusion and permissive Date.parse. Repaired with UTF-8 byte count, canonical ISO/calendar roundtrip, nonempty bounded bytes; new Unicode/calendar/empty-digest attacks added, rebuilt, all affected gates rerun. Matching checksums remain forgeable by dual writers.

A(C5): source changes after preview opens; export must still use the open Blob. Actual download bytes and no publisher fetch are tested. Export does not certify later disk persistence.

A(C6): absent/denied audio/display permission, taint, protected surface, unsupported codec; inherited limitations retained, not certified by a headless chooser.

Runner failure: the initial 28-suite run emitted 406 passed / 0 failed case summaries, but exited **2** with a trailing shell EOF error after the runner file was edited during execution. `bash -n` on the current file passes; that failed run is retained and is **not** the green broad gate. Froze runner inputs, rebuilt the generated evidence snapshot, recreated the disposable database and restarted all 29 suites including the additional 3-case timeline UI suite. That intermediate run was stopped during accessibility verification for the compatibility repair above; its log is retained as before-compatibility evidence, not final acceptance. Rebuilt and recreated the test database again; the final full run places accessibility first. No runner/test/application files are edited during that gate.

Verifier repairs: fresh database state row can be null; initial new UI suite crashed on a verifier's unconditional `row.revision`, repaired optional default (no production change). Native URL-only drag does not invoke an accepted file drop because dragover intentionally rejects non-Files; initial test wrongly awaited a File error message. Repaired test observes actual **trusted native dragover** with text/uri-list plus unchanged URL/publisher counter. No synthetic event or timeout passed off as success.

## H. Reproduction and verification ledger

```
npm ci
npx drizzle-kit push --dialect postgresql --schema ./src/db/schema.ts --url "$DATABASE_URL" --force
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=... npm run build
NODE_OPTIONS=--use-system-ca NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=... \
 FUSION_WP_TEST_LOOPBACK_PORTS=4001,4002 npm run start -- --hostname 0.0.0.0 --port 3000
node scripts/tt100-fixture.mjs
node scripts/tt103-publisher.mjs
TT103_ATTACK=1 TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 DATABASE_URL=... \
 SUITES='e2e-a11y tt104-memory-unit tt104-page e2e-tt104-memory e2e-tt104-pages tt103-framework tt103-memory-unit e2e-tt103-memory e2e-tt102 tt102-search tt102-private-bound tt101-search e2e-tt101-search privacy-layer unit integration browser-session tt55-files-unit e2e-tt55-files e2e-tt55-shell e2e-tt96-desktop-menu tt97-palette-commands e2e-tt97-palette-actions e2e-tt97-files-empty-a11y e2e-tt98-orbit e2e-tt99-interactions e2e-browser tt69-lifecycle e2e-tt100-recall' bash scripts/run-all.sh
```

This is a selected suite gate, not every default historical suite. Tests use real authored fixtures to isolate properties, not fake application features. Current audit: 0 reported production advisories, 4 moderate development advisories; not a proof of app security. New dependencies: none. Build/typecheck passed; changed-source ESLint 0 errors / 2 warnings (existing ref-cleanup/img warnings retained). Final compatibility-repaired production gate: **409 passed / 0 failed in 29 suites, exit 0**, against a freshly recreated database. Actual Specs UI smoke then passed: 21 Recall requirements, bounded-metadata disclosure and RC-12 plaintext/encryption gap visible. Final standalone typecheck passed. Exact source/package/test SHA-256 values and build ID: `docs/evidence/tt104-source-hashes.json`.

## I. Exact remaining gap

Not ten new complete A core features and not global ALL-A. Native positive image paste and physical OS file-drop are not established; actual clipboard image write denied in this headless environment. No arbitrary original cache extraction, no protected-content bypass, no universal screenshot/occlusion proof. No encrypted local Recall archive/Windows-Hello/enclave integration, sensitive-content classifier/OCR/semantic search, dedicated retention UI or atomic media+receipt commit. Timeline is selected-folder insertion-order metadata pages, not a complete event-time/global semantic history; huge legacy metadata is excluded. Reads/export are not final durable native storage; multi-read integrity isn't an atomic snapshot or authenticated provenance. Whole-system memory/latency and every codec/browser/hardware matrix remain unverified. Whole-repository ESLint was actually rerun: **173 errors / 18 warnings** (191 total); this debt is not repaired by these changes. The compiled evidence ledger is a mixed-run snapshot generated before the final compatibility repair (including preliminary RC-21 evidence; final repaired results are in the fresh gate/test JSON): **2469/2473** historical recorded cases, not the fresh selected gate. It records 435 requirements, 333 built / 78 partial-or-probe / 24 blocked; evidence levels 259 full / 94 partial / 82 untested. These statuses are not universal A-grade certificates.

## J. Stopping / next highest-information tests

Strongest artifact is the compiled bounded resident-media pipeline with real SQL/HTTP and native browser evidence, actual denial boundaries and exposed partial requirements. Next high-information experiment: a human in the actual preview browser pastes an image and drags an OS media file, then verifies/exports/replays it, repeats with denied permission and URI-only drag, and checks byte hashes against their source. Next implementation priorities: encrypted archive integration with metadata privacy, atomic media/receipt commit, retention/deletion race tests and broader native media corpus. These cannot be replaced by a grade change.

Arts menu/fontbar cleanup remains deferred because the user's explicit prerequisite (fully/honestly completed recording task) is unmet. Prior PR #7 is already merged; commits cannot be added to its merged state as an open review. TT104 therefore uses the fixed current session branch and, after declared gates, a successor PR preserving that history. Merge outcome is verified/reported separately, never assumed.
