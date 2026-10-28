# TT103 — human-initiated memory recall, not disguised downloading

## Verdict and runtime honesty

**Bounded delivery; not universal production readiness or all-Class-A completion. Declared bounded gates passed: **344/344 cases in 25 suites** on the patched production stack.** TT102's remaining physical chooser/audio/native-disk, site-fidelity, hard-memory and all-feature obligations were not silently marked complete. The new primary pathways save already-resident selected bytes or decoded pixels. Existing URL-refetch and recording pathways are retained separately. Fifteen Recall requirements are now visible in Specs, all honestly **partial** (tier A/A-B is platform feasibility, not a correctness grade); none is promoted to complete on a small test count.

One coding agent. Actual tools: shell/files/processes, Git/gh, web search, Node 22.22.3, TypeScript, Next 16.4.3 (updated from 16.2.6 after audit), ESLint, PostgreSQL 18.4, real headless Chromium through Playwright with software graphics, native canvas/Blob/MediaRecorder, and the pre-existing test harness. No independent reviewer/agent or theorem prover used. `lean`, `coqc`, `z3`, `isabelle`, `ffmpeg` were not on PATH. The new memory tests use no network interception, fabricated media permission, fake clipboard or mock crypto. Historical regressions include controlled browser-offline/response-loss fault injection around real server operations; that is not evidence of a physical network outage, and is not used to certify new media capture. Playwright drives real browser controls and supplies an authored PNG file; this is not physical file-chooser or clipboard verification. A real HTTP publisher draws a real canvas and provides a real cross-origin-taint witness. Historical accessibility suites emulate CSS media/viewport settings, not a physical assistive-technology device.

The restored checkout initially had `main` Git metadata but the prior files. Fetched the existing PR head, then mixed-reset metadata to that same tracked branch, preserving files. It matched `7134cf9`; no work was discarded. PostgreSQL/tools did not survive the environment restore and were reinstalled outside the repository. Initial embedded-PG configuration incorrectly requested OS user creation; corrected to run as the existing unprivileged user, and created UTF-8 databases explicitly. Production commands disable Next telemetry. No new runtime package families or schema changes. A later security repair updates existing Next/ESLint-config/PostCSS versions and the lockfile; see below.

## A. Formal model

Admissible objects:
1. Human-selected File/Blob with a declared image/audio/video MIME, nonzero size ≤8,388,608 bytes. The file chooser is an import, **not extraction of an arbitrary browser cache entry**.
2. Human clipboard action returning a PNG/JPEG/WebP Blob under the browser's real permission policy. Bytes are clipboard representation, not necessarily the original website encoding.
3. Explicitly requested decoded visual from the current Fusion proxy document: largest visible bounding-box area among the first 200 canvas/video/img nodes intersecting the viewport. Intrinsic dimensions must be positive, ≤16,777,216 pixels, and PNG output ≤8 MiB. One visual, not the whole webpage or a complete screenshot timeline. Selection is viewport/bounding-box geometry, not an occlusion/CSS-visibility classifier or proof of what the human actually perceived.
4. Existing display/Fusion streams and HTTP response copies under the previous documented restrictions.

Access: ordinary browser/PWA privileges; proxy page remains opaque-origin sandboxed. A loaded-image operation reads decoded pixels without changing src, refetching, or granting CORS privileges. Tainted canvas and protected video fail. Parent accepts results only from its current iframe, a live single-use request token, with 8-second response deadline and navigation-generation binding. A producer can observe its own token and lie; metadata is user/producer attribution, not secure screen attestation. PNG dimensions are checked before native decode; successful native decode is required before commit.

For each executed successful resident-byte operation x, **there exists** a saved file f whose bytes equal the selected Blob bytes, with matching SHA-256 receipt. This does not assert **for every** browser-visible media object x that the browser exposes its original bytes. For the controlled decoded visual, the native replay must reproduce its current expected pixel color without an asset request. Raster output is not original encoding. Failure means no new archive for the tested admission denial; a failure after media commit can leave media without receipt under the existing non-atomic commit model.

Resource counts: 8 MiB per asset, 16 MP decoded PNG, one outstanding loaded-visual request, at most 100 shown entries from one selected folder, first 200 visual candidates, 8 s response deadline. Timeline fetch currently receives the entire directory listing **before** truncating to 100; that is not a whole-allocation bound. The DOM query collects all matching nodes before slicing to 200; this too is not a total allocation bound. Other image codecs/native decoder allocations, response queues, SQL buffers and JS GC are not globally bounded by this contract. Byte equality is exact; pixel assertions use exact native RGBA on an authored solid-color surface. No universal latency guarantee.

Adjacent problems explicitly not substituted: DOM replay vs pixels; DOM screenshot approximation vs native viewport screenshot; selected file import vs browser-cache introspection; refetch vs previously viewed bytes; PNG vs original JPEG/video; clipboard representation vs upstream original; user declaration vs attestation; file saved vs codec playable; opt-in vs sensitive-content detection; plaintext server archive vs local encrypted OS enclave; a bounded folder list vs universal semantic timeline; passing cases vs ten complete core features.

## B. Outcome space / acceptance threshold

- **H+**: these bounded user-initiated pathways can save exposed resident bytes/clean decoded pixels and replay the tested outputs.
- **H−**: a universal silent PWA recorder that reads all cross-origin/protected pixels or original browser-cache bytes while retaining ordinary permission/origin constraints is not supplied. Taint is an actual executable counterexample, not a renamed button.
- **H∂**: results depend on origin cleanliness, native decoder/clipboard/display permissions, supported codecs, selected data and resource bounds. Physical hardware/browser-matrix fidelity remains unknown.

Before committing: production build and typecheck pass; changed-source lint has zero errors (warnings reported); resident-byte/hash, real native decode/pixel/no-refetch, denial and token tests pass; affected legacy capture/Browser/privacy regressions rerun. A supplementary producer-specific attack must reject header-only PNG despite a real live token. Passing this threshold licenses only the bounded implementation claim, not production readiness of the global goal. Merge is authorized by TT103, replacing the earlier hold instruction, but will occur only after the declared bounded gates pass. After the security audit repair, this also requires zero **reported production dependency** advisories and the patched-framework admission/optimizer/privacy-header tests; it does not require pretending the remaining development advisories or application risks are gone.

## C. Frontier and research (retrieved this turn)

Microsoft's Recall documents opt-in snapshots, context, deletion controls and encrypted local storage—not a silent download manager. These inspire the consent-first timeline pattern, not a claim of security/feature parity. Native OS enclave/authentication/classification capabilities are not reproduced by this PWA. [1](https://support.microsoft.com/en-us/windows/privacy/privacy-and-control-over-your-recall-experience) [2](https://support.microsoft.com/en-us/windows/ai/ai-features/retrace-your-steps-with-recall)

An origin-unclean canvas rejects export; this hypothesis matters even after the user has visually seen the image. A permissive license does not grant access to cross-origin pixels. [1](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image) [2](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)

Display capture requires transient activation and a fresh permission decision. Clipboard reading is separately permission/activation/policy gated; native implementation differences remain. [3](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) [4](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)

Live GitHub review: html-to-image and rrweb have MIT API license classification. dom-to-image's API classification is NOASSERTION; its actual retrieved license text says MIT, with required notices. Repository HEAD SHAs/license responses and relevant README excerpts are in `docs/evidence/tt103-research/`. html-to-image/dom-to-image use DOM/SVG foreignObject/font/image reconstruction; their own documentation acknowledges tainted-canvas limitations. rrweb reconstructs snapshots/events for session replay, not original media bytes. None solves the actual access boundary. None was copied/imported into runtime. No global “best library” claim; these are relevant alternatives screened against this contract.

The open interface is obtaining legitimately exposed bytes/pixels with adequate resource/privacy/codec guarantees; not finding a differently licensed library to bypass the browser security model.

## D. Negative space and executable attacks

| False solution shape | Detecting artifact / boundary |
|---|---|
| 1. Refetch URL and call it memory | Publisher asset-request counter unchanged on loaded-visual save |
| 2. Store only source URL | Actual saved PNG/File bytes, receipt and replay |
| 3. Fake static screenshot UI | Real publisher changes canvas red→green; replay pixel must change |
| 4. Claim raster is original bytes | Receipt method `loaded-visual-png`, separate file-byte path |
| 5. Replay DOM and claim video | rrweb rejected as substitute; existing MediaRecorder separate |
| 6. Capture silently | Explicit buttons; no capture interval added |
| 7. Clipboard text masquerades as image | Only supported image types; missing image is error; physical success unverified |
| 8. Zero-byte success | Actual zero-sized file rejected; archive count unchanged |
| 9. Oversized truncation | 8 MiB+1 input rejected, no archive |
| 10. HTML upload as media | Nonmedia MIME refusal with no archive |
| 11. MIME proves decodability | Native PNG decoder required for producer output; file MIME remains a label |
| 12. PNG signature alone proves PNG | Header-only producer attack and native decoder requirement |
| 13. Integer wrap admits huge image | uint32-max dimensions and 16 MP+row pure tests |
| 14. Tainted viewed pixels must be accessible | Actual loaded opaque image taints canvas; export fails with no refetch fallback |
| 15. Top-level forged postMessage saves data | Wrong source/token actual message yields unchanged archive count |
| 16. Token establishes honest producer | Live-token malformed producer attack; arbitrary valid producer image still not attestation |
| 17. Navigate/close then use old result | Generation check before and after decode; not an already-committing transaction cancel |
| 18. Empty/old timeline satisfies changed-image test | Await actual three-entry list plus native source-pixel assertion |
| 19. Show 100 implies directory memory bound | Explicitly disclose whole listing allocation and one-folder coverage |
| 20. Sensitive-data protection by opt-in alone | UI explicitly says no classifier and server copies plaintext |
| 21. Device-selected bytes prove loaded website original | Explicitly separate File import from browser cache retrieval |
| 22. Feature count/partial labels prove Class A | Fifteen new Specs rows remain partial; existing statuses retained |

Modal shortcut: refetch a current URL. It can return changed bytes, require a different authenticated context, or fail after viewing. The controlled loaded-canvas experiment uses zero asset refetches and changes the source pixels between saves, so a URL label/refetch-only solution cannot satisfy its pixel/no-request contract.

## E. Mechanism portfolio (independence preserved)

| Candidate | Construction / concrete artifact | Proved portion and exact gap | Cheapest falsifier / gap type |
|---|---|---|---|
| Resident File | File→arrayBuffer→existing receipt commit; RecallMemory | Executed byte/hash equality; not cache extraction or physical chooser proof | Empty/oversized/nonmedia tests; local admission, global cache gap remains |
| Clipboard | Native read→first supported image Blob→commit | Executable guarded path; real clipboard success not verified | Permission denial/real copied image on user's browser; conditional interface |
| Loaded visual | Current page canvas draw→PNG→bounded native decode | Real changed pixels + no refetch; taint fail-closed | Tainted surface and live-token bad PNG; origin/attestation gap fundamental |
| Authorized display snapshot | Existing getDisplayMedia→canvas PNG | Previous native pipeline retained, not new physical witness | Physical chooser or denied policy; external permission boundary |
| Authorized live encoding | Existing MediaRecorder/captureStream | Regression codec/stream witnesses only, not original bytes | No audio track or stalled encoder; conditional/hardware gap |
| HTTP original response | Existing bounded streaming fetch→receipt | Response-byte identity, not necessarily viewed bytes | Server changes after viewing; equivalent if substituted for universal memory |
| DOM reconstruction/replay | Reviewed MIT alternatives; README/license/HEAD artifacts | Useful DOM/session representation, not pixel/media identity | Tainted canvas, missing fonts/video; original-goal gap if claimed equivalent |
| Timeline/replay | Existing VFS folder→latest 100→Blob/native media element | Actual saved entry and native image decode/color | Stale list, unsupported codec, huge directory; local UI gap plus allocation frontier |

## F. Artifacts / Specs

Runtime: `RecallMemory.tsx`, `recall-memory.ts`, proxy/shim integration, existing capture/commit infrastructure retained. New readable requirements `RC-01..RC-15` in seed/Specs; seed version bumped, no schema migration. Test publisher: `tt103-publisher.mjs` on 4002. Tests: `tt103-memory-unit.mts`, `e2e-tt103-memory.mts`; both added to disposable run-all group. No new package family; the existing framework/tooling versions and lockfile are updated for audited security fixes. New APIs are not invented; original code reuses actual browser facilities and this repository's VFS.

Explicit missing requirements are registered too: encrypted Recall archive, dedicated retention/deletion, sensitive-content exclusions. Existing Files trash remains available; no secure-delete claim. No canonical statuses are inflated.

## G. Second-order adversary / repair log

Initial native UI run: **9 passed / 1 failed**. The changed-pixel verifier clicked a stale timeline entry before the asynchronous refresh had replaced the list. Diagnostic repair waits for the three actual entries and independently asserts green pixels in the live source canvas before save. It then passed 10/10. Both logs retained. This is verifier synchronization, not evidence that retries magically repaired production code.

Review then identified that a producer can observe its valid nonce and fabricate a PNG-looking Blob. Added header/dimension validation **before allocation**, plus actual native decoding before commit; an 8-byte signature is not enough. Added ten targeted pure attacks including offsets, uint32 overflow, exact and over-limit dimensions. Added real browser taint attack and explicit no-refetch denial test. All affected production gates rerun after this source repair. The first 24-suite broad run was **337 passed / 1 failed**: the Files ZIP verification could not spawn `/home/user/tools/venv/bin/python`, missing after the environment restore. Restored an actual Python 3.11.2 venv, independently verified it accepts a real ZIP and rejects corrupt data, and restarted verification against a fresh UTF-8 database. This was not a change to application logic or a disabled test. That fresh pre-security run passed **339/339 in 24 suites**, followed by a ledger-only rebuild and **31/31** affected unit/UI/accessibility cases. Actual Specs UI smoke also showed all 15 Recall rows and the unimplemented private-archive explanation. These earlier results do not substitute for the framework repair below.

No trust inherited from old compilation. Current production build compiled after these repairs. The final fresh broad gate enables the additional live-token producer attack with `TT103_ATTACK=1`, without changing application source after the production build. Producer is deliberately untrusted; its real message is not a mocked native decoder/network/permission result.

### Security repair discovered during final review

`npm audit` reported **7 advisories: 1 critical / 2 high / 4 moderate** in the inherited dependency tree. Retrieved registry version/license metadata and representative GitHub advisories for Next image-optimizer RCE, PostCSS source-map file disclosure and sharp/libvips (`tt103-research/GHSA-*.json`). These are imported advisory conditions/version ranges, not an exploit demonstration on every platform. No attack payload/RCE was executed.

Targeted updates: **Next 16.4.3**, **eslint-config-next 16.4.3**, **PostCSS 8.5.32**; resolved **sharp 0.35.5**. Licenses actually inspected: Next/config/PostCSS MIT, sharp Apache-2.0. No `audit fix --force`: its proposed Drizzle downgrade was rejected. After update, registry audit reports **0 production advisories**, **4 moderate development-tool advisories** in the Drizzle/esbuild-kit chain, and **0 high/critical**. This is not proof of zero unknown vulnerabilities or app security. Every audit output, exact version/license and install log is retained.

Added five repair-specific executed checks: installed versions/licenses; production registry-audit result; actual HTTP optimizer output decoded by native Chromium; rejection of a private-host optimizer URL without incrementing its real publisher counter (the proxy's test-loopback grant must not apply to Next); and preservation of API no-store/privacy headers plus the opaque-worker CORS bridge. All five passed independently before the full patched-stack rerun. Build/types/focused lint reran. Final patched-stack broad run: **344 passed, 0 failed, 25 suites**, exit 0 (`tt103-production-gate.log`). Actual Specs UI smoke reran successfully on this build; all 15 requirements and RC-12’s plaintext/encryption gap were visible. Final typecheck passed; focused lint (including the new framework script) reported **0 errors / 2 warnings**. Whole-repository lint remains **173 errors / 18 warnings**, not a green gate.

The generated Specs ledger is a mixed-run recorded evidence snapshot, not a claim that every historical test passed on this exact build. Six Recall requirements get **partial** evidence tags; no full tags or implementation-status promotions. First screenshot showed conservative untested labels before regeneration; final UI was rechecked after the updated build. Its recorded 2399/2403 counter is the compiled mixed-run snapshot, not the separate fresh 344/344 gate.

## H. Verification and reproduction

Preview on 3001: normal DB `tt103`, system CA trust, **no** test-loopback exception. Final production verification on 3000: exclusive UTF-8 DB `tt103_secure`, explicit test-only loopback ports 4001/4002. No client-facing localhost backend URL added; app requests remain relative. Publisher loopback URLs occur only in explicit disposable test data.

```
NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=... npm run build
NODE_OPTIONS=--use-system-ca NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=... \
 FUSION_WP_TEST_LOOPBACK_PORTS=4001,4002 npm run start -- --hostname 0.0.0.0 --port 3000
node scripts/tt100-fixture.mjs
node scripts/tt103-publisher.mjs
TT103_ATTACK=1 TT89_DISPOSABLE_DATABASE=1 BASE=http://127.0.0.1:3000 DATABASE_URL=... \
 SUITES='tt103-framework tt103-memory-unit e2e-tt103-memory e2e-tt102 tt102-search tt102-private-bound tt101-search e2e-tt101-search privacy-layer unit integration browser-session tt55-files-unit e2e-tt55-files e2e-tt55-shell e2e-tt96-desktop-menu tt97-palette-commands e2e-tt97-palette-actions e2e-tt97-files-empty-a11y e2e-tt98-orbit e2e-tt99-interactions e2e-browser tt69-lifecycle e2e-tt100-recall e2e-a11y' bash scripts/run-all.sh
# TT103_ATTACK=1 enables the live-token malformed-producer attack in the broad run
```

Embedded PostgreSQL/Chromium/music-metadata are external test tools, not runtime app dependencies. Existing TT102 oracle uses music-metadata 12.3.2 under `/home/user/tools`; browser launcher uses Playwright or external Chromium. Historical gates are selected, not a claim to have executed every default suite.

## I. Exact remaining gaps

Not universally production ready. No physical chooser/audio/clipboard/browser-matrix proof; no universal screenshot of every webpage; no arbitrary browser cache extraction; no sensitive-information classifier/OCR/semantic search/enclave; plaintext Recall archive and non-atomic receipt; complete global timeline and true listing byte bounds absent. JPEG/other decoder allocation safety is not a global theorem. No original music/video extraction from a decoded frame. File import preserves selected bytes, not all filesystem metadata such as the original filename/mtime; timeline names remain generated identifiers. Selection geometry does not prove visual occlusion or human attention. No independent expert review or formal proof. Prior all-repository lint debt was not repaired; changed-file lint records two warnings explicitly. Development dependency advisories remain; audit-zero production is not a whole security proof.

## J. Stopping / strongest artifact

Strongest artifact: executable memory-first workflows, genuine pixel/no-refetch/taint witnesses and explicit partial Recall requirements, while retaining existing download and capture paths. Ten complete additional core Class-A features and ALL-A are **not established**; test cases are not feature promotions. Arts-mode all-app menu cleanup remains deferred under the recording-first condition because full recording/privacy readiness is not honestly complete. Highest-information next tests: real human clipboard/display/audio with user-supplied media and denied permissions, encrypted archive integration, retention/deletion races, broad codec corpus and paged directory allocation measurement.

The declared bounded threshold passed; PR #7 is authorized for merge by TT103. Merging bounded progress must not be represented as completion of the global target. Source/package hashes are recorded in `docs/evidence/tt103-source-hashes.json`; final Git/PR status is reported separately after the operation.
