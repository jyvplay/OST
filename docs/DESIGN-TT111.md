# TT111 — Saving media the page already loaded, without asking the publisher again

## Runtime honesty (actually available and used this turn)

One agent, one sandbox, no CI, no second reviewer, no theorem prover. Used: node v22.22.3, TypeScript 5 (`tsc --noEmit`), ESLint, Next 16.4.3 production build (`next build` + `next start`), PostgreSQL 18.4 (embedded), Chromium 143.0.7499.0 through Playwright, `curl`, `node -e` with `pg`, `drizzle-kit push`. External documentation was read over the network (MDN, Microsoft Learn, PostgreSQL docs). No parallel agents, no hosted runners, no mutation-testing service, no fuzzer beyond the hand-written adversarial suites listed in F.

## Scope honesty, stated before any result

RC-37 is a **server-side, per-session, in-RAM retention of responses the proxy already streamed to the page**, plus a human-initiated commit of one retained item into the archive. It is not a browser cache reader, not a DRM path, not a page-content analyser, and it cannot retain what the page never fetched through Fusion's own proxy.

## A. Formal model

**Admissible objects.** A *retained item* is a tuple `(sid, url, mime, bytes, capturedAt)` where `sid` is a live proxy session, `url` is the absolute http(s) URL the page requested, `mime ∈ {image/*, audio/*, video/*}`, and `bytes` is the complete body of a `200` response, `|bytes| ≤ 8 MiB`.

**Admissible access.** The retention point is the single place where the proxy already holds the response stream (`src/app/api/wp/s/[sid]/[...rest]/route.ts`, the tee at the streaming return). No other component may read the page's memory, the browser cache, or the disk cache — none of those are reachable from a web app, and pretending otherwise would be fabrication.

**Resource bounds.** Per item ≤ 8 MiB; per session ≤ 24 items and ≤ 48 MiB; process-wide ≤ 192 MiB; eviction oldest-first; same URL replaces in place. Nothing is written to disk until a human presses Save.

**Success quantifier.** For every retained item `i` and every human Save of `i`: the archive receives exactly `bytes(i)` (byte-identical, SHA-256 equal) with a receipt recording `method = session-retained-response`, `sourceAttribution = proxy-recorded-response`, `refetched = false`, and the publisher is **not** contacted again. For every non-retained or policy-disabled request: Save fails closed (403/404) and no partial file appears.

**Boundaries.** Partial (`206`), aborted, over-cap, non-media and non-`200` responses are never retained. A closed session, a disabled policy, or a forgotten item makes the bytes unrecoverable. Retention is RAM-only and does not survive a server restart.

## B. Outcome space and declared threshold

- **H+** — "the bytes a page already loaded can be archived, on a human's command, without a second request to the publisher, byte-identically, and with an honest receipt."
- **H−** — "any such save silently re-downloads, or yields re-encoded/reconstructed bytes, or keeps bytes the user did not ask to keep."
- **H∂** — "it works only while the publisher is still reachable", i.e. indistinguishable from a refetch.

**Threshold declared before the work:** H+ is accepted only if a test **shuts the origin down**, proves with a control fetch that a refetch is now impossible, and *then* saves the item successfully with the same SHA-256 as the bytes the page received. Anything weaker is H∂.

## C. Frontier (retrieved this turn, hypotheses restated)

Microsoft's Click to Do (Microsoft Learn, read this turn) was taken as the incumbent for *acting on already-present content*: multiple explicit entry points, analysis only while the user is engaged, a temporary hand-off file that is not kept, and an administrative policy that removes the feature and its entry points entirely. The policy switch is inherited here (`privacy.recallMediaTap`, default **off**, enforced server-side, fail-closed). The NPU/Phi-Silica/Bing parts are not inherited and are not claimed.

MDN's `getDisplayMedia` page (read in TT110, still governing) fixes the honesty line for capture: the human picks the surface, audio may silently not arrive, secure context only.

## D. Negative space — shapes that look like a solution but fail the contract

1. Read the browser's HTTP cache — unreachable from a web app.
2. Service-worker `Cache` tap — the proxy sends `no-store`; caching it violates the privacy contract.
3. `performance.getEntriesByType('resource')` — gives names and sizes, never bytes.
4. Re-`fetch()` the URL in the page and call it "already loaded" — that is a second request (H−).
5. Trust the browser's memory cache to make the refetch free — unobservable, unprovable, and false when the origin is gone.
6. `canvas.drawImage` + `toBlob` — decoded pixels, not publisher bytes; `SecurityError` on tainted bitmaps.
7. `captureStream()` + MediaRecorder — an honest re-encode, not the original bytes.
8. Keep every proxied response "just in case" — unbounded RAM and a privacy violation.
9. Retain on the client in a `Map<url, Blob>` — lost on reload, invisible to the server, and not auditable.
10. Retain `206` ranges and stitch them — a partial body is not the publisher's object.
11. Retain non-`200` (304/redirect/error) bodies — not the object either.
12. Let the policy be a client-side checkbox — trivially bypassed; it must be enforced where the bytes are.
13. Cache the policy for the whole process — a user who switches it off keeps capturing; the cache must be short and re-read at the decisive moment.
14. Fail *open* when the policy cannot be read — a DB blip would silently enable capture.
15. Key retention by URL alone — one page's bytes would be savable from another session.
16. Keep the bytes after the session ends "for convenience" — the tab is gone; the mandate is gone.
17. Write the retained bytes to a temp file to hand them to the committer — that is disk retention the user never approved.
18. Make retention the default path of the existing Save button — a new behaviour must never silently replace an existing user action.

## E. Mechanism portfolio (kept independent)

| # | Mechanism | Bytes come from | Honest method label |
|---|-----------|-----------------|---------------------|
| 1 | Refetch (RC-01, pre-existing) | a new HTTP request | `original-response` |
| 2 | **Session-retained response (RC-37, this turn)** | the proxy stream the page already consumed | `session-retained-response` |
| 3 | PNG raster of a live canvas | decoded pixels | `raster-capture` |
| 4 | MediaRecorder of real tracks | a new encode | `live-encode` |
| 5 | Resident file / clipboard | the user's own bytes | `user-provided` |
| 6 | Preview-frame commit | an already-open document | `open-document` |

Mechanism 2 is the only one that satisfies the B threshold; the others remain available and unchanged, which is the point — the new path is additive.

## F. Artifacts

- `src/lib/server/wp-tap.ts` — retention store (`tappableResponse`, `tapPut`, `tapList`, `tapGet`, `tapForget`, `tapForgetAll`, `tapStats`).
- `src/lib/server/wp-tap-policy.ts` — `tapEnabled(fresh)`, 1-second cache, **fail-closed**, invalidated on settings write.
- `src/app/api/wp/s/[sid]/[...rest]/route.ts` — the tee at the streaming return; retains only complete `200` media bodies.
- `src/app/api/recall-tap/route.ts` — list / save / forget, keyed by `sid`.
- `src/lib/wp-session-registry.ts` + `ProxyFrame.tsx` + `Recall.tsx` §1b — the live-session bridge and the human-facing list.
- Suites: `scripts/tt111-recall-tap.mts` (7 tests), `scripts/tt111-core.mts` (11), `scripts/e2e-tt111-recall.mts` (3).

## G. Second-order adversaries (derived from this candidate's own structure)

- **Cross-session thief** — save an item using another session's `sid`: refused (three cross-claims tested).
- **Policy racer** — switch the policy off and immediately save: refused, because the save re-reads the policy fresh and the settings write invalidates the cache and empties the store.
- **Dead-session claimant** — save after the tab closed: `404`, store already dropped.
- **Partial-body smuggler** — abort mid-stream, then save: nothing was retained.
- **Cap evader** — an incompressible body over the cap (`randomBytes`, because a compressible fixture cannot test a size cap): refused.
- **Provenance forger** — claim `refetched:false` on a refetch path: the receipt's method/attribution pair is derived server-side from the commit path, not from the client.

## H. Verification

External, not self-review: PostgreSQL 18.4 as the oracle for persisted bytes and receipts; Chromium 143 as the oracle for what the page actually loaded; `next build` and `tsc --noEmit` as compilers; the production gate below as the regression oracle.

The decisive experiment (`tt111-recall-tap.mts`, falsifier test): the page loads an 81,424-byte PNG through the proxy, the **origin server is then shut down**, a control refetch is attempted and provably fails, and the Save still writes 81,424 bytes with SHA-256 `62b96f79936fd780…` into `/Downloads/Recall/127.0.0.1_4005/`. `e2e-tt111-recall.mts` repeats it in a real browser window with the origin down (75,929 bytes, SHA-256 `7970cf06505a…`).

## I. Repair log (no inherited trust)

Every red found this turn was triaged before it was "fixed". Six reds in `tt111-core.mts` were six wrong assumptions in the test, not six product defects (`/api/fs?op=audit` never existed; search returns `hits`; jobs returns `ops` with uppercase states; `/api/state` rejects only strictly older revisions; trashing hides a node from `list` while `read`-by-path still serves it). Two real product defects *were* found by the new suites and fixed: `GET /api/recall-tap` read a stale policy (now `tapEnabled(true)`), and a settings write did not invalidate the policy cache or drop already-retained bytes (now `forgetTapPolicyCache()` + `tapForgetAll()`).

Gate-harness defect found and fixed this turn: five Recall/browser suites depend on standing publisher fixtures (`scripts/tt100-fixture.mjs` on :4001, `scripts/tt103-publisher.mjs` on :4002) that an ad-hoc driver did not start; the suites were green again the moment the fixtures were running. The two TT111 suites were moved to :4004/:4005 so they cannot collide with those standing fixtures.

## J. Stopping, residual gap, next highest-information test

**Proved:** bytes already loaded can be archived byte-identically, on a human's command, with the publisher unreachable, under a fail-closed policy, with honest provenance.

**Not proved / out of scope:** retention does not survive a server restart; items a page loaded *before* the policy was switched on are gone; media the page obtained outside Fusion's proxy (extensions, DRM, other origins' service workers) is unreachable; nothing here encrypts the archive.

**Next highest-information test:** drive the retention store to its process-wide ceiling with many concurrent sessions and verify oldest-first eviction under real concurrency rather than sequentially — eviction order is currently proven only in a single-session sequence.
