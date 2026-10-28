# TT106 — Guarded Recall pair lifecycle and already-open preview frames

## Runtime honesty (actually available and used this turn)
Used: bash in one Linux sandbox; Node 22.22.3; TypeScript 5.9.3 (`tsc --noEmit`); Next.js 16.4.3 production build; ESLint 9.39.4; real PostgreSQL **18.4** (embedded-postgres, databases `tt106`/`tt106_test`, port 5432); real headless Chromium via Playwright/@sparticuz; two real local HTTP publishers on 4001/4002; `fetch_page` for official documentation; `git`/`gh`.

Not available and **not** claimed: no theorem prover, model checker, fuzzer or static analyzer beyond ESLint/tsc; no independent reviewer or second agent; no hosted CI; no physical device matrix (no real clipboard hardware, camera, microphone, display capture, GPU, TPM or NPU); no multi-browser matrix (Chromium only); no power-loss/crash rig; no network-partition simulator. Every number below comes from a command actually executed in this session and retained under `docs/evidence/`. A single sandbox with sequential tool calls: no parallel agents or distributed search.

## Scope honesty, stated before any result
**This turn delivers three bounded Recall increments, not ALL-A and not ten newly completed core A features.** 26 Recall requirements now exist and **all 26 remain `partial`**. Tier letters in Specs are feasibility classes, not completion grades. The global predicate "every feature is A and fully functional" is **not met** and is not claimed; §J states the exact remaining gap.

## A. Formal model
**Admissible objects.** A *memory pair* is two VFS rows: media at `/Downloads/Recall/<group>/<file>` (`kind=file`, `encoding=base64`, MIME matching `recallMime`, ≤8 MiB raw) and its receipt at the same path plus `.recall.json` (`encoding=utf8`, ≤16 KiB UTF-8, JSON with `sha256`, `mime`, `path`, `bytes`, bounded `method`, `capturedAt`, query-redacted `source`/`page`). A *guard* is `{media,receipt}` each `{id:int>0, version:int>0, sha256:/^[a-f0-9]{64}$/}`. A *preview frame* is a PNG produced by `canvas.toBlob` from an already-decoded `HTMLImageElement`/`HTMLVideoElement` whose source is a local `blob:` URL of bytes already stored by this app.

**Information/access model.** Client holds no database credentials; it calls `POST /api/fs` with `op=recallPair|recallCommit`. The server holds one pooled PostgreSQL connection per transaction. Concurrency control is optimistic: the client must first `inspect`, then supply the returned guard. The browser may not read cross-origin pixels (origin-clean rule) and this app never re-requests a media URL in these paths.

**Resource counted.** Primary: durable row/index/journal state transitions per acknowledged HTTP request (correctness units). Secondary, measured: upstream HTTP requests to the publisher during a save (must be 0), per-request round trips (inspect + mutate = 2), decoded frame area (≤16,777,216 px) and body size (≤8 MiB).

**Success predicate (quantifier order).** For all canonical pair paths `p`, for all interleavings produced by the tested concurrency harness, and for all guards `g` offered by a client: if `g` equals the committed state of both rows at lock time, then exactly one mutation commits and it changes media flags, receipt flags, both search entries and the journal **together**; otherwise the request fails with HTTP 409 and **no** durable change occurs. Independently: for every save initiated from an already-open preview, the number of upstream media requests is 0 and the saved bytes decode to the frame that was on screen, within codec tolerance.

**Failure.** Any committed half-pair, any silent repair of a mixed state, any stale guard that mutates, any upstream request during a resident save, or any claim of completion unsupported by a retained log.

**Regime/units/tolerances.** PostgreSQL 18.4 default Read Committed plus explicit row locks and the existing cooperative mutation lock; single-node, local loopback; ≤8 MiB bodies; ≤16 MP frames; receipts ≤16 KiB. Pixel tolerance for lossy video frames: channel deviation ≤6 (measured 1).

**Adjacent problems that must NOT be substituted.** Encrypted/enclave archive; secure erasure; retention/expiry policy; exactly-once delivery under lost acknowledgements; crash/fsync durability proof; whole-screen or background timeline capture; OCR/semantic recall; authenticated provenance; cross-browser certification; repairing pre-existing orphans; transactional coupling of *later independent* Files edits.

## B. Outcome space and declared threshold
- **H+ (bounded):** a guarded, single-transaction pair lifecycle plus a no-refetch preview-frame save is achievable in this stack. 
- **H− :** some adjacent obligations are unreachable in an ordinary PWA: original compressed bytes from an already-decoded surface, cross-origin tainted pixels, exactly-once acknowledgement, and hardware-backed encryption are not achievable without privileges this app does not have.
- **H∂ :** the boundary moves with privileges/APIs — a native host, enclave or signed attestation would change the answer; so would relaxing "no refetch" or "plaintext archive".
- **H+global (every feature A):** **undecided and not claimed.** Neither a universal construction nor a catalog-wide impossibility proof was produced this turn.

**Threshold fixed before coding:** accept a claim only with (i) production build + `tsc` clean, (ii) zero changed-source lint errors, (iii) real PostgreSQL tests including a genuine mid-transaction failure and a concurrent-writer race, (iv) real Chromium tests asserting pixels and upstream request counts, (v) the affected broad regression gate passing, (vi) retained logs. Anything unverified is downgraded in text, not asserted.

## C. Frontier (retrieved this turn, hypotheses restated)
1. **PostgreSQL 18 isolation** (`/docs/18/transaction-iso.html`, chunks 0–1, fetched). Read Committed: a `SELECT` sees a snapshot as of statement start; two successive `SELECT`s in one transaction can differ. `SELECT ... FOR UPDATE` waits for a concurrent writer and then re-evaluates the updated row. Sequence advances are **not** rolled back. *Hypotheses needed here:* all pair writes occur on one connection/transaction; errors propagate; the client supplies a guard read under lock. *Not implied:* serializability across separate HTTP requests, physical crash durability, or exactly-once networking.
2. **`HTMLCanvasElement.toBlob`** (MDN, fetched). Native encoder; PNG mandatory; callback may yield `null`; **SecurityError** when the bitmap is not origin-clean; object URLs should be revoked. *Hypotheses:* media already decoded, origin-clean, within limits. *Not implied:* recovery of original compressed bytes or any DRM bypass.
3. **Microsoft Recall management docs** (fetched). Incumbent design: opt-in, locally analyzed periodic snapshots on Copilot+ PCs, default-disabled under management, Windows Hello/ESS gating, TPM-protected keys, VBS enclave, encrypted snapshots and vector store, default sensitive-information filtering, Click-to-Do element extraction. **Inspiration taken:** explicit timeline review and acting on a *selected element* rather than bulk capture. **Not inherited:** encryption, enclave, biometric gate, NPU analysis, sensitive filtering, background capture. This app's archive stays plaintext and human-initiated; the Specs rows say so.

**Open interface:** between "one transaction is atomic on one connection" (1) and "a client may retry a request whose response was lost" (networking). Nothing retrieved closes that gap; the implementation therefore refuses to invent idempotency and instructs inspection before retry.

## D. Negative space — 17 shapes that look like solutions but fail the contract
1. **Two sequential `op=write` calls** (media then receipt). Fails: a crash or conflict between them leaves a half pair. Detector: `tt106-lifecycle` conflict/trigger tests demand both rows unchanged.
2. **Client-side "transaction"** that deletes on error. Fails: the compensating call can itself fail; no isolation. Detector: concurrent-writer test expects exactly one 409 winner.
3. **Trash media only, leave receipt** (or vice versa). Fails: later inspection sees a mixed pair. Detector: mixed-state test requires 409, no silent repair.
4. **Silently repairing a mixed state** found during inspect. Fails: destroys evidence of an independent Files action. Detector: same test asserts refusal.
5. **`last-write-wins` without a guard.** Fails: ABA and concurrent edits clobber. Detector: stale-guard and ABA tests.
6. **Guarding on path/name only.** Fails: a replaced file at the same path passes. Detector: edited-content test (content rewritten, same path) must 409.
7. **Guarding on `updated_at`.** Fails: coarse clocks and equal timestamps; not a content identity. Replaced by id+version+sha256.
8. **Trusting the client's claimed sha256.** Fails: forgeable. Server recomputes `sha256(content)` from stored rows and compares with the stored column before acting.
9. **Returning the raw driver error** on failure. Fails: Drizzle wraps SQL **and parameters**, which contain base64 media and labels → data leak in an error string. Detector: trigger test asserts the response contains no SQL fragment.
10. **Treating a lost acknowledgement as failure and retrying.** Fails: may double-apply. The code returns "not acknowledged — inspect before retrying"; no exactly-once claim.
11. **Calling `restore` idempotent.** Fails: it would revive a pair trashed by a *different* action. Detector: independently-trashed-siblings test expects 409.
12. **Undo via "trash the newest row again".** Fails: ABA. Detector: ABA test requires the old guard to be rejected after trash→restore→trash.
13. **Re-fetching the media URL to build a "frame".** Fails the number-one use case (save what is already loaded). Detector: request listener asserts **zero** non-app requests during preview-frame save.
14. **Screenshotting the window instead of the media element.** Fails: captures chrome/overlays, wrong dimensions. Detector: saved PNG must equal the media's intrinsic 64×32 and carry the expected pixel.
15. **Asserting the decoded video frame is bit-identical to authored pixels.** Fails: VP8 is lossy (measured `#0000ff` → `(0,1,255)`). Fixed by a tolerance predicate that still rejects black/empty frames; the limit is now printed in the Specs row.
16. **Letting a refused open leave the previous preview on screen.** Fails: every pair action below would act on a different file than the row clicked. Detector: 16 MP test asserts the preview region disappears and the actions disable.
17. **Reporting "all features A" from a passing suite.** Fails: suites test what they test. All 26 Recall rows stay `partial`; §J states the gap.

## E. Mechanism portfolio (six distinct constructions, kept independent early)
| # | Central construction | Artifact | Proved portion | Unresolved interface | Cheapest falsifier | Gap local or = original problem? |
|---|---|---|---|---|---|---|
| M1 | **Transaction-scoped pair mutation**: one `safeTransaction`, cooperative purge lock, `SELECT … FOR UPDATE` on both rows, then flags+index+journal+audit | `src/lib/server/recall-lifecycle.ts`; `tt106-lifecycle` rollback test | Mid-transaction journal failure rolls back both rows, versions and the index deletion; sequence witness proves the trigger ran | Lost COMMIT acknowledgement; separate later Files edits | Temporary PG trigger on `file_ops` | Local |
| M2 | **Optimistic identity guard** (id+version+sha256 of both rows, recomputed server-side) | `parseGuard` + guard checks; stale/ABA/edited tests | Stale, replaced and ABA guards cannot mutate | Not authentication: a writer who rewrites both rows forges consistency | Rewrite content, replay old guard | Local |
| M3 | **Single-statement consistent inspection** (one `SELECT` over both paths) | `action='inspect'` path; "no media bodies" assertion | Pair read from one statement snapshot; response carries metadata, not bytes | Not a repeatable-read snapshot across requests | Compare rows mid-write | Local |
| M4 | **Receipt re-verification at lifecycle time** (recompute SHA-256 over stored base64, re-validate receipt schema) | `verifyRecallReceipt` call inside the transaction | Corrupted/mismatched pairs are refused before any mutation | Integrity ≠ provenance | Flip one stored byte | Local |
| M5 | **Native decoded-frame capture** from an already-open Blob preview (`drawImage`+`toBlob`), bounded 16 MP/8 MiB, epoch-checked | `frame()` in `RecallMemory.tsx`; green-PNG and WebM tests | Saves on-screen frame with **0** upstream requests; exact dimensions; blue within tolerance | Original compressed bytes unreachable; codec support conditional | Request listener; pixel probe | Equivalent to original (original-byte recovery is out of reach) |
| M6 | **Fail-closed preview state machine** (epoch counter, preview cleared on open, confirmation step, undo token) | `open`/`trash`/`restore`; cancel + 16 MP tests | A refused open leaves no stale preview; cancel changes nothing; undo restores only the same pair | Multi-tab state is not coordinated | Click row that cannot decode | Local |

## F. Artifacts
Executable: `src/lib/server/recall-lifecycle.ts` (new server module), `src/app/api/fs/route.ts` (`recallPair` op), `src/components/modules/RecallMemory.tsx` (inspect/trash/undo/frame + fail-closed preview), `src/db/seed-data/features-tt106.ts` (RC-24/25/26). Experiments: `scripts/tt106-lifecycle.mts` (23 cases), `scripts/e2e-tt106-memory.mts` (8 cases). Quantitative: 0 upstream requests during resident saves; 64×32 frame; VP8 deviation 1/255; 8 concurrent writers → 1×200 + 1×409. Causal model: §C hypotheses mapped to code paths. Raw logs under `docs/evidence/tt106-*`.

## G. Second-order adversaries (attacker derived from each candidate's own structure)
- **A(M1)** — force failure *after* the first successful write: temporary `BEFORE INSERT` trigger on `file_ops` firing only for the receipt row; a non-transactional sequence proves execution. Result: rollback verified, response sanitized.
- **A(M2)** — ABA: trash → restore → trash, then replay the first undo token. Result: 409.
- **A(M2′)** — content swap at the same path with identical length. Result: 409 (sha256+version).
- **A(M3)** — delete the receipt behind the client's back. Result: inspect 409, media untouched.
- **A(M4)** — independent Files trash of one member. Result: mixed-state 409, no silent repair.
- **A(M5)** — network watchdog over every save; oversize 4097² frame; audio-only preview. Results: zero upstream requests, refusal above 16 MP, button disabled for audio.
- **A(M6)** — click an undecodable memory while another preview is open. Result: preview cleared, actions disabled.
- **A(global)** — two simultaneous identical guarded trashes. Result: exactly one 200, one 409.
- **Quantifier-order check:** guards are validated *after* row locks, so the comparison uses the locked committed version, not a pre-lock read.

## H. Verification (external tools, not self-review)
| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | pass (`docs/evidence/tt106-typecheck.log`) |
| Production build | `npm run build` | pass (`docs/evidence/tt106-build.log`) |
| Changed-source lint | `npx eslint <9 changed files>` | **0 errors / 0 warnings** (`tt106-lint.log`) |
| Real DB suite | `scripts/tt106-lifecycle.mts` | **23/23** (`tt106-lifecycle-final.log`) |
| Real browser suite | `scripts/e2e-tt106-memory.mts` | **8/8** (`tt106-browser-final.log`) |
| Broad regression | `scripts/run-all.sh`, 38 suites, fresh DB | **497 passed / 0 failed / exit 0** (`tt106-production-gate.log`) |
| Post-ledger rerun | 6 suites incl. `tt92-ledger-audit`, `tt92-ledger-policy` | **72/72, exit 0** (`tt106-ledger-gate.log`) |
| Actual Specs UI | `scripts/tt106-specs-smoke.mts` | pass: 26 Recall rows, all `partial` (`tt106-specs-smoke.log`, `tt106-specs.png`) |
| Dependency audit | `npm audit` | **0 production advisories**; 4 moderate development advisories |
| Retained failures | `tt106-lifecycle-first.log`, `tt106-browser-first.log`, `tt106-browser-expanded.log` | kept deliberately |

**Whole-repository lint debt is disclosed, not defined away: 173 errors / 16 warnings** (`tt106-full-lint.log`); the nine changed sources contribute **0 errors / 0 warnings**. Recorded evidence ledger after regeneration: 440 rows, 333 built / 65 partial / 24 blocked, evidence 259 full / 99 partial / 82 untested, aggregate historical **2532/2536** with 5 failing-touch rows — a mixed historical aggregate, **not** a fresh universal certificate. Frozen source/package/build hashes: `docs/evidence/tt106-source-hashes.json`.

Chromium/Node identity and the explicit "no physical device, no second agent" record: `docs/evidence/tt106-runtime.json`. Database identity/settings: `docs/evidence/tt106-database.json`.

## I. Repair log (no inherited trust)
1. **DB test #4 failed** (`400` instead of `409`): the attack wrote `'changed'`, which is not canonical base64, so input validation fired before the guard. The *test* was wrong, not the server. Fixed to a valid base64 body; whole suite rerun → 23/23.
2. **Browser WebM test hung** (no timeout inside `page.evaluate`). Isolated probe showed a **detached** canvas yields a 110-byte WebM with no frames; an attached canvas yields 1599 bytes, `readyState=4`, 64×32. Test rewritten to a DOM-attached canvas with explicit timeouts so a failure reports instead of hanging.
3. **Strict-mode locator violation** (`video` matched both the saved-memory preview and the capture preview) and **row-order ambiguity**: tests now scope to the preview region and click the exact saved filename parsed from the status line.
4. **Real product defect found by test #7**: a refused open left the previous preview visible, so pair actions could target a different file than the row clicked. Fixed in `open()` (revoke + clear before fetch). **Source changed ⇒ rebuilt, fresh database, all gates rerun**; new attack added (16 MP refusal must clear the preview and disable actions).
5. **Gate run 1 — environment, not code**: `e2e-tt55-files` FM-15 failed with `spawnSync /home/user/tools/venv/bin/python ENOENT`; this sandbox had no Python venv for the independent ZIP oracle. Recreated the venv (Python 3.11.2); the suite then passed **14/14**. Because an environment change intervened, the whole gate was rerun rather than stitching partial runs together.
6. **Gate run 2 — accumulated test state, not code**: `integration` FM-07 reported "duplicate group missing" because run 2 reused the database already filled by run 1. Measured directly: **112 duplicate groups** existed, while `/api/storage` deliberately returns only the **top 30 by reclaimable bytes**, so the assertion's 10-byte group fell outside the window. Reproducibility rule recorded: this gate requires a freshly created disposable database. Database recreated (UTF-8, schema pushed) and the full gate rerun.
7. **Wrong predicate, not a bug**: exact pixel equality on a lossy VP8 frame. Measured `(0,1,255)`; replaced by a tolerance predicate and the measurement is now stated in the RC-26 Specs row.

## J. Stopping, residual gap, next highest-information test
Stopped at budget, not at "believed open". **Global predicate (all features A, ten new complete A features) is NOT met** and is not claimed. Delivered: three partial increments; 26 Recall requirements, all `partial`.

**Exact remaining gap:** no encryption/enclave/biometric gate; no retention, expiry or secure erasure; no repair of pre-existing orphans; atomicity covers publication and this guarded lifecycle only — later independent Files edits can still split a pair; lost-acknowledgement idempotency and physical crash durability remain unproven; frames are current decoded pixels, never original compressed bytes; Chromium-only, no physical device matrix; whole-repository lint debt persists; Specs tier letters are not completion grades.

**Next highest-information test (designed, not run):** a kill-9 harness that terminates the Node server inside the pair transaction between the two writes, restarts against the same cluster, and asserts no half-pair and no orphaned index row — it would attack the one hypothesis (crash durability) that no gate here covers. Second: a cross-browser run of the frame path on a non-Chromium engine to convert "codec support conditional" into measurement.

**Arts/menu cleanup remains deferred.** The user's instruction gates it on the recording task being fully and honestly complete; it is not, so that cleanup is not performed this turn.

## Addendum — measured inventory of this turn
| Item | Measured |
|---|---|
| New/changed application sources | 5 (`recall-lifecycle.ts` new, `route.ts`, `RecallMemory.tsx`, `seed.ts`, `features-tt106.ts`) |
| New test suites | 3 (`tt106-lifecycle.mts` 23 cases, `e2e-tt106-memory.mts` 8 cases, `tt106-specs-smoke.mts`) |
| Focused cases, final | **31/31** (23 PostgreSQL + 8 Chromium) |
| Broad gate, fresh DB | **497/497 across 38 suites, exit 0** |
| Recall requirements in Specs | 26 (23 before) — **all `partial`** |
| Upstream media requests during resident saves | **0** (asserted per save) |
| Concurrency outcome, 2 identical guarded trashes | 1×200 + 1×409 |
| VP8 decoded-frame deviation from authored blue | 1/255 (tolerance 6) |
| Changed-source lint | 0 errors / 0 warnings |
| Whole-repository lint | 173 errors / 16 warnings (pre-existing debt) |

**Interpretation guard.** 497 passing cases measure the suites that exist; they do not certify untested behavior, other browsers, other hardware, or the un-run portions of the catalog. The three new rows are honest partials with explicit falsifiers. Nothing here promotes any feature to a completion grade, and no "ten complete A features" claim is made.
