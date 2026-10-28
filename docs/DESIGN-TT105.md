# TT105 — atomic publication and explicitly clicked resident visuals

## Verdict / runtime honesty

**Bounded delivery, not universal production readiness, ALL-A, or ten newly completed A-grade core features.** Two genuine feature increments address prior gaps: atomic publication of new Recall media/receipts, and explicitly clicked already-loaded visuals. All 23 Recall requirements remain **partial**; feasibility tier A is not a completion grade. Final broad production gate passed **453/453 cases in 34 suites, exit 0**, followed by an actual Specs UI smoke.

One coding agent. Actually used: shell/file/process tools, Git/gh, GitHub API and web-page retrieval, Node 22.22.3, npm, TypeScript, Next 16.4.3, ESLint, real embedded PostgreSQL 18.4, real Chromium through Playwright with software graphics, native pointer/Canvas/Blob/WebCrypto APIs, and existing harnesses. Python 3.11.2 venv restored for the actual ZIP oracle. No independent reviewer/agent, theorem prover, physical clipboard/display/audio/file-drag operator, OS enclave, or hardware crash/durability system was used. `lean`, `coqc`, `z3`, `isabelle`, `ffmpeg` were absent on PATH. Test publishers serve authored controlled media; they are not third-party-site fidelity proof. New tests do not dispatch synthetic pointer/clipboard events, override permissions, mock the database, or intercept network responses. Real SQL triggers/sequence markers and concurrent HTTP clients create actual database failures/races. Playwright defaults include basic test-profile storage, `--use-mock-keychain`, muted audio and headless operation: no physical keychain/audio claim follows. Historical accessibility tests emulate CSS media/viewport settings; historical offline/response-loss tests are fault injection, not physical network outages.

Repository branch is active `arena/e6ed3cf7-ost`. The earlier branch-state refusal was incorrect; no claim of work from that refusal is inherited. Dependencies and database processes did not survive checkout restoration and were actually reinstalled outside Git. Preview started early on 3001 and now uses the production build with normal UTF-8 DB `tt105`, no test proxy exception. Exclusive verification DB `tt105_test` on 3000 was recreated after repairs. Only the verification server permits explicit publisher loopback ports 4001/4002. Browser API URLs remain relative; servers bind 0.0.0.0 and accept the preview host. No new app dependencies or schema changes.

## A. Formal model

**Objects/access.** Resident File/clipboard/drop bytes from existing pathways, or a current decoded image/video/canvas in the current opaque-origin proxy document. Existing HTTP-copy and display/stream paths retain their distinct semantics. New selected mode remembers only the last **trusted native pointerdown** on a media element in that document; a subsequent explicit host button requests PNG encoding. A nonmedia pointer action clears selection. A missing/disconnected target is refused, never replaced silently by the largest visual. Original largest mode retains its previous first-200-visual selection and streaming traversal. Selected mode is not restricted to those first 200 candidates.

The selected element must be connected to the current document and intersect the viewport geometrically. Intrinsic dimensions must be positive, at most 16,777,216 pixels, PNG at most 8,388,608 bytes; native decode is still mandatory in the parent. Origin-tainted/protected surfaces fail; no source URL is changed or fetched as fallback. This captures **current pixels at save**, not original encoded video/audio, the frame at an earlier pointer action, occlusion, user attention, closed-shadow targets, or an entire webpage. The page is an untrusted producer that can observe its own nonce and lie; selection/method/source labels are not authenticated screen attestation. Same-origin XSS/extensions/devtools are outside a meaningful human-consent security guarantee because they can already call app APIs.

A publication request contains a canonical `/Downloads/Recall/<group>/<media>` path, canonical base64 nonempty bytes ≤8 MiB, normalized media MIME, and a version-1 receipt ≤16,384 UTF-8 bytes. Server checks exact receipt path/MIME/length/raw SHA-256, canonical UTC ISO timestamp syntax/calendar, bounded method token and query/hash-redacted canonical HTTP(S) source/page labels. Required fields are checked; arbitrary extra receipt fields are not a sensitive-data classifier. MIME declaration is not arbitrary codec-playability proof. Client consent/guard still prohibits Recall server writes in amnesic mode.

**State / quantifier order.** Let S be a valid pre-state, x an admissible create request, and Δx the new media, receipt, search-index, successful operation-journal and audit rows. For each executed x whose server transaction is acknowledged successful, there exists one database commit point t at which all Δx become visible together to other transactions. Before that commit, none of its uncommitted changes are visible. If SQL rejects the transaction and rollback is acknowledged, Δx is empty; conflicting pre-existing records are preserved, not deleted. No implication that both paths were absent initially: a pre-existing orphan receipt can remain after rejected creation. Directory creation occurs before this transaction and can leave empty directories. Sequence advances (ordinary serial IDs and the deliberate trigger witness) are not rolled back; the predicate concerns published rows, not bit-for-bit database identity.

This is **operation atomicity**, not `forall future states, media and receipt always coexist`: independent Files edits/trash, older servers, raw SQL and later mutations can split a pair. Nor is it `exists one common snapshot for forall separate HTTP reads`; reads straddling a commit can see different snapshots. The generic VFS conditional writer is shared without inner commits, preserving its create/compare-and-replace semantics.

For every tested clicked save acknowledged successful, there exists a saved PNG and matching receipt whose native-decoded authored pixel matches the actual selected source, without increasing publisher asset requests. For denied selection/taint/admission tests, no new media is created. Byte/hash/pixel comparisons are exact; controlled selected canvas asserts RGBA `0,0,255,255`. No universal media/site claim follows.

**Failure/unknown.** A lost COMMIT acknowledgement or HTTP response is unknown, not proof of rollback. Client reports the exact destination to inspect before manual retry; there is no automatic retry or exactly-once/idempotency claim. The safe-transaction implementation quarantines uncertain connections; no actual power-loss or lost-ack experiment was executed this turn. Existing orphan media is not automatically repaired. Database SQL/parameters are not reflected by the new transaction error response.

**Resources.** 8 MiB per asset; base64 string at most `ceil(8388608/3)*4` characters with canonical round-trip and decoded-size validation; receipt 16 KiB UTF-8; path ≤512 UTF-16 code units; one in-flight loaded request; 8-second **response** deadline, not total decode/commit latency. Selected mode retains one target; largest mode retains ≤200 candidates but total traversal work is not bounded. Atomic operation creates two VFS files plus corresponding metadata rows. Middleware JSON buffering, per-request copies, concurrent request counts, DB buffers, native decoders and JS GC are not globally memory-bounded by these limits. Server receipt bounds apply after request JSON acquisition, not a transport-allocation bound. Existing timeline limits stay 100/page, 400 displayed, metadata UTF-8 filters 1024/512/256 bytes.

Adjacent problems not substituted: refetch vs resident bytes; raster vs original encoding; pointer selection vs capture at pointer time; box intersection vs visibility/attention; SQL atomicity vs encryption; logical commit vs physical power-loss durability; unknown acknowledgement vs rollback; create-only race winner vs exactly-once retry; schema/hash consistency vs provenance authenticity; new pair publication vs old orphan repair or paired deletion; one transaction snapshot vs separate HTTP reads; component cases vs complete A features.

## B. Outcome space / declared acceptance threshold

For the **full original goal**, keep three distinct hypotheses: H+global = every mandatory catalog obligation can be delivered under the ordinary-PWA/access/privacy model; H−global = at least one mandatory obligation cannot be delivered under that model; H∂global = the outcome changes with privileges, native bridge/hardware, permissions or revised requirements. Neither a universal construction nor a catalog-wide impossibility proof was established this turn. Existing “blocked” labels alone are not a fresh proof. The tested subproblem has the following narrower outcomes:

- **H+:** bounded existing bytes and clean clicked pixels can be published with their receipts in one DB transaction, and current controlled browser outputs can be verified without upstream refetch.
- **H−:** two independent autocommit creates do not guarantee all-or-nothing pair publication. A receipt conflict after successful media creation is a concrete counterexample. Transactional plaintext does not become an encrypted enclave. Ordinary origin rules do not grant arbitrary protected pixels/cache bytes. These reject specific shortcuts, not every human-assisted design.
- **H∂:** native element exposure, trust/connection/viewport, origin cleanliness, codecs, size limits, DB transaction cooperation and acknowledgement availability change the result.

Before commit/merge: build/typecheck; zero changed-source lint errors; actual PostgreSQL create/conflict/concurrent-writer/second-write-trigger rollback tests including ancillary rows; actual native selected-pixel/no-refetch/taint/removed-target tests; regression tests for standalone conditional writes, affected VFS races, TT100–104 capture/memory/privacy/Browser/Files/shell and accessibility; audit disclosure and actual Specs UI inspection. No fabricated native device certification. Failed/repaired candidates inherit no trust: fresh build/database and affected gates rerun. Whole-repository lint debt is disclosed, not defined away.

## C. Retrieved frontier / licensing / exact open interface

1. [PostgreSQL 18 transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html), actually retrieved: steps inside a BEGIN/COMMIT transaction are all-or-nothing and uncommitted updates are invisible to other transactions. Hypotheses here: all relevant writes use the same checked-out connection/transaction, SQL errors propagate, rollback/commit acknowledgements are handled, and observers use ordinary database isolation. Separate transactions/HTTP reads are not magically bundled; external filesystem/network side effects are not rolled back. The deployed engine reports 18.4; current version-18 documentation may reflect a newer patch. No physical crash claim is inferred.
2. Also retrieved upstream `doc/src/sgml/advanced.sgml` via GitHub for comparison, not copied into implementation. Actual upstream `COPYRIGHT` saved: PostgreSQL's permissive licence permits use/copy/modification/distribution for any purpose without fee subject to notices. Existing Drizzle/pg transaction facilities are reused, not replaced by a copied database implementation.
3. [MDN Canvas.toBlob](https://github.com/mdn/content/blob/main/files/en-us/web/api/htmlcanvaselement/toblob/index.md), retrieved via gh: actual canvas encoding is conditional on native encoder and origin-clean security. A draw of tainted cross-origin content does not gain read access merely because it was already rendered. Native taint refusal is experimentally rechecked, not treated as a renamed button.
4. [Microsoft Manage Recall](https://learn.microsoft.com/en-us/windows/client-management/manage-recall), retrieved this turn: on supported Copilot+ PCs, documented Recall uses opt-in local snapshots/timeline/search and Windows Hello/TPM/VBS-enclave protections with sensitive filtering. Inspiration is explicit moment/element retrieval, not a false equivalence between this server archive and those hardware/OS security guarantees. No periodic surveillance was added.

Research is targeted, not a claimed exhaustive search of all open-source projects. No external screenshot/recording library or runtime package was imported; new application code is original composition around existing APIs. Documentation snapshots under `docs/evidence/tt105-research` are research references, not application source. A permissive library cannot supply permissions/origin bypass or an OS enclave in a plain PWA. Exact open interface: physically validating human clipboard/display/audio flows, privately encrypted archive integration with metadata privacy, recovery/idempotency and retention/deletion coherence without regressing the VFS.

## D. Negative space — 20 false solution shapes and detectors

1. Sequential media then receipt writes called atomic: pre-existing receipt causes second-write failure; real rollback test checks media/index/journal absent.
2. Two nested transactions called one: extracted transaction-owned writer never commits internally; forced receipt failure would reveal an inner media commit.
3. Ignore ancillary rows: real SQL checks no media index or successful media journal survived rollback.
4. Catch SQL error and return success: status/error and absence checks reject this shape; safeTransaction COMMIT verification retained.
5. Automatic retry after ambiguous acknowledgement called exactly-once: explicitly not implemented/claimed.
6. Claim pair forever despite later Files edits: operation-only quantifier, no persistent coupling claim.
7. Delete a conflicting pre-existing receipt to make retry succeed: conflict test requires original receipt remain.
8. Trust only client checksum: server recomputes SHA-256 and binds path/MIME/size.
9. Accept permissive base64 aliases/truncation: canonical round-trip and empty/malformed tests.
10. Accept query/hash secrets with queryRedacted=true: source/page equality to redacted canonical URL required; adversarial fields rejected.
11. Reflect a database exception with saved bytes: new errors sanitized; trigger test checks response excludes SQL/raw payload.
12. Save largest visual when selected target vanished: selected mode fails without archive, no fallback.
13. Limit explicitly selected target to first 200 visuals: a real pointer selects a later canvas beyond 205 hidden visuals and succeeds.
14. Synthetic pointer event called human selection: new browser tests use real pointer input; producer authenticity remains explicitly limited.
15. Click-time frame confused with save-time frame: declared current-frame semantics, no retroactive extraction.
16. Tainted selected surface re-downloaded to make save succeed: real selected taint refusal and unchanged publisher counter.
17. Old success text mistaken for current operation completion: repaired pending status; rapid second-save count test.
18. Native PNG called original compressed image/video/music: receipts distinguish clicked-visual-png; no such claim.
19. Atomic plaintext labelled local encrypted memory: visible plaintext disclosure/RC-12 remain; no grade promotion.
20. 32 focused cases or hundreds of regression cases called ten complete OS features: two feature increments, both partial; full target remains unestablished.

Modal shortcut is #1. A second-create conflict after a first committed create leaves an orphan. The new test deliberately supplies that conflict and accepts only rollback of the first write plus its metadata. This distinguishes a real transaction from a renamed pair-save helper. Real trigger failure/sequence marker tests target the repaired composition directly.

## E. Mechanism portfolio — six distinct constructions and concrete evidence

These are distinct mechanisms in the target pipeline/alternatives, **not six complete OS implementations**, not six newly shipped features, and not six independent reviewers. Existing pathways remain independent rather than being rewritten into URL downloads.

| Candidate | Central construction / artifact | Established portion | Exact interface, cheapest falsifier, gap size |
|---|---|---|---|
| C1 transactional archive | One connection/BEGIN; transaction-owned conditional writer for media + receipt + index/journal; `recall-commit.ts` | Actual create/conflict/eight-writer/trigger rollback and standalone CAS tests | Unknown acknowledgements and later external mutation remain. Falsifier: second-write real DB trigger. Local publication gap repaired; not encryption/full goal |
| C2 clicked decoded pixels | Trusted pointer target + explicit host request + existing nonce/generation/native PNG admission | Real smaller-blue-vs-larger-red capture, beyond-200 selection, removed target and taint refusal, no-refetch counter | Linked media may navigate on click, keyboard-only/closed-shadow/occlusion/DRM are conditional; current frame not original encoding. Falsifier: disconnected/tainted target. Universal capture gap remains |
| C3 exposed resident bytes | Existing chooser/paste/drop File objects→byte commit; now atomic archive | Retained actual File byte/hash and negative MIME/size/URI-only experiments in legacy suites | Positive physical image paste/drop matrix unverified. Falsifier: browser exposes only URL. Different access mechanism, not arbitrary cache solution |
| C4 authorized native streams | Retained display/Fusion stream→MediaRecorder/PNG | Selected existing real native capture regressions rerun | Physical chooser/audio and codec/browser matrix unresolved. Cheapest falsifier: denied native permission/unsupported stream. Not original encoded memory |
| C5 cryptographic consistency | Existing exact SHA-256/schema-bound receipt checker, now also server admission | Wrong digest/path/MIME/size/date/schema rejected; native replay checked | Writer replacing both records can forge consistency; no authenticated provenance. Cheapest falsifier: mutate bytes then both records. Local integrity, global authenticity not supplied |
| C6 local Blob export / history retrieval | Existing keyset metadata pages + explicit native Blob download, no source fetch | Legacy real SQL/HTTP page and native download byte equality tests rerun | No single immutable cross-page snapshot, encrypted local storage or physical final disk durability. Cheapest falsifier: mutation between reads or download policy denial. Local retrieval/export, not complete timeline semantics |

Each row returns executable code, a reproducible experiment or a counterexample; none is accepted as a status-only solution to the full task.

## F. Artifacts / Specs / compatibility

- New `src/lib/server/recall-commit.ts`: strict admission and one transaction for pair publication, sanitized unknown/failure response.
- `conditional-write.ts`: shared transaction-owned operation extracted; old standalone wrapper still owns its own transaction. No file-operation permission/lock/history/index semantics intentionally removed.
- `recall.ts` routes all existing commit callers through the atomic op; captures/imports/URL copies retain their distinct method names and disclosure.
- ProxyFrame/shim: `Save clicked loaded visual`; largest mode retained, pointer target is only encoded on explicit request. Pending status replaces stale success while a request is active.
- Specs: `RC-22` atomic publication, `RC-23` clicked visual; updated RC-09. Seed 3.76.11, 437 total requirements / 23 Recall requirements. Historical TT104 assertions narrowed to RC-01..21 rather than failing on future additions; their old requirements are still asserted.
- New tests: `tt105-atomic.mts` (25), `e2e-tt105-clicked.mts` (7), added to disposable-only default runner before execution. Native test screenshot/runtime, failure logs and source hashes retained under evidence.

## G. Second-order adversaries and repair record

**C1:** race eight creates at one path; pre-create receipt; mutate required fields; submit alias base64/traversal/private path; fail the real second INSERT with a temporary PostgreSQL trigger. A nontransactional sequence marker confirms the trigger actually ran even though row changes rolled back. Verify no media/index/success journal survived. Drop trigger and retry the same valid payload to check rollback recovery. Check original standalone conditional create/replace/stale CAS after extraction. Cooperative VFS purge/trash races are also included in the broad gate.

**C2:** smaller chosen canvas versus larger candidate; 205 hidden visuals before chosen target; removed selected element; nonmedia pointer clearing; origin-tainted native canvas; forged producer/nonce/PNG from inherited attacks. No saved result may be silently replaced with the largest candidate. Attribution is still untrusted.

**C3:** oversized/empty/multiple/HTML/playlist/URI-only inputs in existing admission/native transfer tests; physical positive clipboard remains unverified, not fixed by an override.

**C4:** permissions/DRM/taint/codec constraints retained. Software/headless regression does not certify physical hardware.

**C5:** schema/digest/path/length/time/UTF-8 attacks rerun; unkeyed consistency is not a signature.

**C6:** pagination append/concurrent metadata boundaries and local export no-refetch checks rerun; retained gaps are not erased by successful archive publication.

Initial focused run: atomic **23 passed / 1 failed**, clicked **4 passed / 2 failed**. The DB trigger experiment's verifier wrongly expected PostgreSQL's inner exception text directly, but Drizzle wraps it. Review also found driver errors could include SQL/parameters: added a constant sanitized publication error and a real sequence-marker trigger witness; the patch test rejects raw SQL/payload reflection. The clicked repeated-save verifier saw the old success text before the new async write finished; production UI now explicitly sets pending text before sending the request, removing that misleading signal. Rebuilt before rerun. Repaired focused run passed **24+7**; then added standalone-CAS regression, final focused run **25+7 = 32/32**. Failure logs retained. A fresh database/build and full affected gate follow; no trust is inherited from the failed candidate.

Final Specs verifier initially waited for “remain unknown” while the actual registered requirement correctly says “are unknown”; that exact-text assertion timed out. Corrected the verifier phrase (no application change), retained its failure log, and reran the actual UI probe before acceptance.

## H. Verification / reproduction

```
npm ci
npx drizzle-kit push --dialect postgresql --schema ./src/db/schema.ts --url "$DATABASE_URL" --force
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=... npm run build
NODE_OPTIONS=--use-system-ca NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=... \
 FUSION_WP_TEST_LOOPBACK_PORTS=4001,4002 npm run start -- --hostname 0.0.0.0 --port 3000
node scripts/tt100-fixture.mjs
node scripts/tt103-publisher.mjs
TT103_ATTACK=1 TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 DATABASE_URL=... \
 SUITES='tt105-atomic e2e-tt105-clicked tt91-write-atomic tt91-purge-race tt92-trash-race tt104-memory-unit tt104-page e2e-tt104-memory e2e-tt104-pages tt103-framework tt103-memory-unit e2e-tt103-memory e2e-tt102 tt102-search tt102-private-bound tt101-search e2e-tt101-search privacy-layer unit integration browser-session tt55-files-unit e2e-tt55-files e2e-tt55-shell e2e-tt96-desktop-menu tt97-palette-commands e2e-tt97-palette-actions e2e-tt97-files-empty-a11y e2e-tt98-orbit e2e-tt99-interactions e2e-browser tt69-lifecycle e2e-tt100-recall e2e-a11y' bash scripts/run-all.sh
```

Actual current evidence: focused 32/32; production build/typecheck pass; changed-source lint **0 errors / 0 warnings**. Full-repository lint remains **173 errors / 18 warnings**. Registry audit reports **0 production advisories / 4 moderate development advisories**, not zero unknown app/DB/browser risk. No package updates needed this turn. Compiled Specs evidence is explicitly mixed historical: **2501/2505**, 437 rows, 333 built / 80 partial-or-probe / 24 blocked, evidence levels 259 full / 96 partial / 82 untested. This is not the fresh selected gate and not a universal A-grade certificate.

Final broad gate: **453 passed / 0 failed / 34 suites / exit 0** on the repaired build and freshly recreated UTF-8 database. Final actual Specs UI smoke passed: all 23 partial requirements, RC-22 acknowledgement caveat, RC-23 selection limits and RC-12 plaintext disclosure are present. Final standalone typecheck passed. Exact frozen source/package/test hashes and build ID: `docs/evidence/tt105-source-hashes.json`. Independent expert review/physical tests are absent. External engines/compiler output and retained raw case results support only the bounded claims above.

## I. Exact remaining gap

Not ALL-A or ten new complete core features. No encrypted/private/local-only Recall archive or OS-enclave integration, classifier/OCR/semantic search, dedicated retention/deletion UI or old-orphan repair. New publication atomicity is established only for the transaction, not future independent Files edits or deletion coupling. No retry/idempotency or lost-ack/power-failure verification. Physical clipboard/drop/display/audio and cross-browser matrix remain unverified. Selected capture needs a trusted pointer target still present at save; normal linked-image navigation, keyboard-only selection, closed-shadow targets, occlusion/attention and changing video frames remain conditional. It does not extract original encoded audio/video/cache bytes. No global process RAM/CPU/latency guarantee. Existing whole-repository lint/development advisories remain. Existing permissive app stack unchanged; no copied third-party implementation introduced.

## J. Stopping / strongest artifact / next highest-information test

Strongest artifact: an actual atomic Recall publisher shared by existing pathways, plus an explicitly selected already-loaded pixel path, verified against real PostgreSQL rollback/races and native Chromium output with no source refetch. Full task completion must not be inferred from these two increments. Highest-information next tests: physical browser user selects a real photo/video and attempts denied/granted native clipboard/display/audio flows; independently test a real server disconnection around COMMIT with reconciliation (without declaring unknown as rollback); integrate encrypted archive and coherent paired retention/deletion with metadata privacy.

Arts cleanup remains deferred under the explicit recording-completion prerequisite; that prerequisite is not honestly complete. PR #8 is already merged, so TT105 uses a successor PR from the fixed active session branch after declared gates pass, rather than pretending a merged PR can accept new open-review commits. GitHub merge outcome will be verified and reported separately.
