# TT112 — Saving an object the page is holding itself, and measuring six rows that had never been measured

## Runtime honesty (actually available and used this turn)

One agent, one sandbox, no CI, no second reviewer, no theorem prover, no fuzzer beyond the hand-written adversarial cases below. Actually used: node v22.22.3, `tsc --noEmit`, ESLint, `next build` + `next start` (Next 16.4.3), PostgreSQL 18.4 (embedded), Chromium 143.0.7499.0 via Playwright, `curl`, `node -e` with `pg`, `drizzle-kit push`, and the repository's own harness. `music-metadata@12` (MIT) is installed **outside** the repository, at `/home/user/tools`, so that the suites which use it as an independent parser cannot accidentally be checking the product against itself.

A sandbox reset destroyed every process, `/tmp`, the databases and the local git HEAD in the middle of this turn. Nothing in this document is recovered from memory: the environment was rebuilt and every number below was produced after that rebuild.

## Scope honesty, stated before any result

RC-38 reads bytes out of the page the human is looking at. It is not a cache reader, not a DRM path, not a downloader, and it cannot read anything from a page that is not open in Fusion's own proxied frame. It adds no retention: nothing is held anywhere until the human names one object, and what is written is that object's bytes.

## A. Formal model

**Admissible objects.** A *resident object* is a pair `(document, url)` where `document` is a live proxied document in a Fusion frame and `url` is a `blob:` or `data:` address that document currently holds on an `img`, `video`, `audio` or `source` element. Its *bytes* are what `fetch(url)` yields **inside that document**.

**Admissible access.** The frame is sandboxed without `allow-same-origin`, so its origin is opaque and no other context may read it. The only channel is `postMessage`, and the only reader is the document's own runtime (`public/wp-shim.js`). The desktop can ask; it cannot take.

**Resource counted.** Bytes archived per human action, and requests made to the publisher. The target value for the second quantity is **zero**.

**Success quantifier.** For every resident object `o` the human names: the archive receives exactly `bytes(o)` (SHA-256 equal), the receipt records `method=resident-object-url`, `sourceAttribution=user-declared-label`, `refetched=false`, and the origin receives **no** request attributable to the save. For every object that cannot be read completely (revoked, MediaSource-backed, empty, or over 8 MiB): the save fails by name and writes nothing.

**Boundaries.** `http(s)` media is deliberately *not* offered here — that is RC-01 (ask again) or RC-37 (what the proxy kept). A page that has navigated away is gone. A document walk stops at 400 elements. Nothing survives the frame.

**Adjacent problems that must not be substituted.** Rasterising a decoded image (RC-31: pixels, not bytes); recording a stream (RC-39-shaped: a new encode); reading the browser's HTTP cache (unreachable); reading the publisher again (RC-01); keeping every response (RC-37, and it needs a policy switch precisely because it retains).

## B. Outcome space and declared threshold

- **H+** — media that never was a network response can still be archived byte-exactly on a human's command.
- **H−** — any such save silently refetches, or yields re-encoded bytes, or reaches into the page without the human.
- **H∂** — it works only while the publisher is reachable, i.e. it is a refetch in disguise.

**Threshold declared before the work:** H+ is accepted only if the archived SHA-256 equals bytes that the origin **never served at all**, with the origin additionally **shut down** at the moment of saving. Both conditions are met in `e2e-tt112-resident.mts`: the picture is assembled inside the page from a byte array, and the origin's request log is asserted to contain only the document fetch.

## C. Frontier (hypotheses restated with their hypotheses)

Microsoft's Click to Do (read in TT110) remains the incumbent for *acting on what is already on screen*: many explicit entry points, work only while the human is engaged, nothing kept behind their back, and an administrative switch that removes the feature. RC-38 inherits the first three; it needs no switch of its own because it retains nothing — the existing explicit-save rule (RC-01 has always saved on a click) is the governing precedent. MDN's object-URL and MediaSource documentation fixes the boundary: a `blob:` URL created from a `MediaSource` is a handle to a live stream, not a file, and fetching it is specified to fail — which is why that case is reported as a refusal rather than an error.

## D. Negative space — shapes that look like solutions and are not

1. `iframe.contentDocument` from the desktop — impossible: opaque origin (and that is the privacy design, not an obstacle to remove).
2. `allow-same-origin` on the frame to make it possible — destroys the sandbox for every page.
3. Re-`fetch()` the object's `http` source in the desktop — a second request; also impossible for `blob:`.
4. Ask the shim for *all* objects automatically and cache them — retention the human never asked for.
5. Walk the whole DOM unbounded — a hostile page can make the walk expensive; hence the 400-element budget.
6. Trust the page's `type` attribute for MIME — the save uses the Blob's own type, and refuses when there is none.
7. Save a `MediaSource` blob by recording it — that is a re-encode (RC-39), not this row's claim.
8. Treat a revoked object URL as "gone, so skip quietly" — a silent skip is indistinguishable from success; it is a named refusal.
9. Stream the bytes through the parent with `JSON.stringify` — base64 through a string channel; the transfer uses an `ArrayBuffer` transfer instead.
10. Let the frame push bytes unprompted — the parent only ever answers tokens it issued.
11. Accept any message that looks right — every reply is matched on `event.source` **and** a fresh token.
12. Omit the timeout — a navigated-away document would hang the pane forever.
13. Record the `blob:` handle as the memory's source — it is meaningless outside that document; the page's own address is recorded instead.
14. Claim `requested-url` attribution because the page address is an `http` URL — the committer rejects that: only the refetch method may claim it.
15. Enforce the 8 MiB ceiling in the desktop after transferring the bytes — the ceiling is enforced in the document, before anything is handed over.
16. Count "no console error" as proof of no refetch — the origin's own request log is asserted instead.
17. Make the new pathway the default for an existing button — it is a separate pane with its own action, per the standing contract.

## E. Mechanism portfolio (independent, all retained)

| # | Mechanism | Where the bytes come from | Method label | New this turn |
|---|-----------|---------------------------|--------------|----------------|
| 1 | Refetch | a fresh HTTP request | `original-response` | no |
| 2 | Session tap | the proxy stream the page consumed | `session-retained-response` | TT111 |
| 3 | **Resident object** | the page's own `blob:`/`data:` object | `resident-object-url` | **TT112** |
| 4 | Raster of a decoded visual | pixels | `raster-capture` / `fusion-element-frame` | no |
| 5 | Authorized recording | a new encode of a shared surface | `authorized-display-recording` | no |
| 6 | Resident file / clipboard / open document | the human's own bytes | `user-provided` / `open-document` | no |

Only 1, 2 and 3 are byte-exact. Only 3 works when the bytes were never a network response.

## F. Artifacts

- `public/wp-shim.js` — the in-document scan/read channel (token-matched, source-checked, 400-element budget, 8 MiB ceiling, named refusals).
- `src/lib/wp-session-registry.ts` — session → frame window, so Recall can ask without reaching into another component.
- `src/components/modules/Recall.tsx` — pane 1c, `askFrame` (fresh token, bounded wait), `resident-object-url` commit.
- `src/lib/recall.ts` — receipts now state `refetched` explicitly.
- `src/lib/governor.ts` — the long-task window is pruned on a timer (defect found by this turn's test, see I).
- `scripts/e2e-tt112-resident.mts` — 7 tests, including the structural falsifier.
- `scripts/e2e-tt112-shell.mts` — 7 tests over SH-07, SH-12, RG-01/02, WM-07, HW-05/08/11, PR-02.

## G. Second-order adversaries

- **Forged reply** — a page posting `resident-scan-result` unprompted: ignored (token + `event.source`).
- **Replay** — re-sending an old reply: tokens are per-request and the listener is removed on first match.
- **Lying page** — a document that reports a `data:` URL but serves other bytes on read: harmless, because the archive stores what the read returned and digests exactly that; the receipt claims only a declared label.
- **Oversize smuggler** — a 9 MiB object: refused inside the document (tested).
- **Stream pretending to be a file** — a `MediaSource` blob: listed, then refused on read with the reason (tested).
- **Navigation race** — saving after the page moved on: the id is no longer held, and the pane says so.
- **Attribution launderer** — a client posting `sourceAttribution:'requested-url'` with this method: the committer refuses (RC-14, tested).

## H. Verification

External oracles only: Chromium decides what the page holds; PostgreSQL holds what was written; the origin's own request log decides whether it was asked; `tsc`/`next build`/ESLint decide whether it compiles. Headline measurements:

- `e2e-tt112-resident.mts` — **7/7**. With the origin stopped and a control fetch proving it unreachable, a 22,136-byte picture the page built in memory is archived with SHA-256 `420f303f4a772ae9…`; the origin's log shows **one** request in the whole test (the document). The inline `data:` object archives byte-identically (503 B). The 9 MiB object is refused ("larger than 8 MiB; nothing was truncated") and writes nothing.
- `e2e-tt112-shell.mts` — **7/7**. The capability pane's yes/no is compared against the live `window`/`navigator` in the same page; 59 real long tasks drive the shell to `effects=off`; the state returns to `on` once the window drains.
- Production gate: `docs/evidence/tt112-production-gate.log`.

## I. Repair log (no inherited trust)

1. **Governor latch (product defect, found by a new test).** The 60 s long-task window was pruned only inside the `PerformanceObserver` callback, so once a machine went quiet the governor never recomputed: effects stayed off and background work stayed paused indefinitely. Fixed with a 5 s pruning timer that republishes only on a real state change. **New attack aimed at the patch:** the recovery test now requires `effects` to return to `on` with the thread idle — the exact behaviour the old code could not produce.
2. **Recall crashed on a window restored without `props`** (`win.props.url` on `undefined`). Hardened to `win.props?.url`; the new suites seed such windows deliberately.
3. **Gate harness defect (TT111 carry-over).** Five suites need standing publishers on :4001 and :4002; an ad-hoc driver had not started them, which produced five false regressions. The TT112 suites were moved to :4004–:4006 so they cannot collide with the standing fixtures.
4. **`/api/recall-tap` bypassed the shared JSON reader** — caught by `integration.mts`, which discovers handlers from source. Now uses `readJsonObject`, so an empty, malformed or non-object body is a uniform 400.
5. **Count-exact Specs assertion rotted again** (`e2e-tt106-memory` asserted exactly 37 Recall rows). Restated as a monotonic bound plus the real invariants (unique codes, every row named), so adding a row cannot make a true statement false.

## J. Stopping, residual gap, next highest-information test

**Proved.** Media that never was a network response can be archived byte-exactly, on a human's command, from a sandboxed opaque-origin document, with the origin down and provably un-asked; the ceiling and the refusals hold where the bytes are read.

**Not proved / out of scope.** The scan only sees media *elements* — objects held only in a JS variable, inside a canvas, or in a `srcObject` stream are not listed (the last is reported as a refusal). CSS background images are not walked. `MediaSource` content cannot be saved byte-exactly by anyone; recording it would be a re-encode and is a different row. Nothing here encrypts the archive.

**Next highest-information test.** Drive a page that revokes its object URL *between* the scan and the save, under load, and assert the refusal text is the revoked-object one and that no partial file appears — the one ordering this suite exercises only in the MediaSource shape.
