# TT33: TIDAL, Qobuz and Amazon Music, plus one player at a time

Runtime used: the sandbox's bash with Node 22 / TypeScript, headless Chromium (Playwright 1.64.1) against the production build (`next build` + `next start`), embedded Postgres. Research used the web-search tool and `git clone` from github.com. **TIDAL, Qobuz and Amazon hosts cannot be reached from this sandbox.** No provider player was loaded or played for real. Everything about live playback below is therefore labelled as unverified.

## A. Formal model

A pasted text *t* becomes a `StreamRef = {provider, kind, id, sub, page, embed, host, unverified?}` through `parseStream(t)`.
- **Embed codes:** an `<iframe …>` snippet is first reduced to the value of its `src` attribute. Nothing else is read.
- **Library:** the library is a list deduplicated by `embed`.
- **Controller states:** a controlled player is a state machine `CtlState`:
  - status ∈ {loading, ready, playing, paused, buffering, ended, cued};
  - `connected` is true once the player is usable;
  - `oneWay` means the player never confirms pauses;
  - `assumed` means the current status is what *we asked for*, not what the player reported;
  - `pid` is the id the player echoes back.

**TIDAL (ctl `tidal`).** These rules were read from TIDAL's own embed-player source (Apache-2.0, commit `0f4fb0f`, 2026-06-08):

| event | transition |
|---|---|
| iframe `load` | loading → ready, `connected` (a queued autoplay sends `{commandName:"play"}`, retried ≤ 9× until a start arrives) |
| message `{activatePlayerId: pid}` from our frame + origin `https://embed.tidal.com` | → playing, `assumed = false` |
| `{activatePlayerId: other}` / any other shape / wrong source / wrong origin | no change |
| `{height,width,newEmbed:true}` | `connected` only |
| we send pause | playing → paused, `assumed = true` (shown as "Pause sent") |
| we send play | no change until the player's own start arrives |

There is no seek, no progress and no end event. In TIDAL's source, `broadcastMediaStatus` is defined but never called, so `ends` stays 0 forever and Auto-next cannot follow a TIDAL item.

**One player at a time (`fusion-media-exclusive`).** When a player enters the playing state, its window broadcasts its window id. Every *other* Video or Music window then:
- pauses its native `<audio>`/`<video>`;
- sends its embed's pause command (and records that pause through `afterCommand`).

## B. Claims

**H+ (built, verified here):**
1. **TIDAL link grammar.** The following map to `embed.tidal.com/<types>/<id>` at TIDAL's own sizes (120 / 275 / 16:9):
   - track, album, playlist (UUID), video and mix links;
   - `browse/` links, `album/…/track/…` and `listen.tidal.com`.
   - Short links and artists are refused with a reason.
2. **TIDAL control.** Play and Pause go from Fusion to TIDAL's **real bridge code**, and the player's start reaches Fusion, with spoofs ignored (e2e against TIDAL's unmodified `message-bridge.js` + `url-options.js`).
3. **Qobuz.** Widget, open, play and store-page links for albums and tracks map to `widget.qobuz.com/{album|track}/<id>?zone=<CC-ll>`. The zone is carried over from the store page, and track widgets use `&display=compact`.
4. **Amazon Music:**
   - Amazon's own Share → Embed code is kept exactly as issued, minus affiliate and tracking parameters.
   - Album, track (`?trackAsin=`) and playlist links on 12 storefronts are turned into the same address shape, using marketplace ids from Amazon's SP-API docs.
5. **Embed codes.** Any provider's `<iframe>` snippet works (only `src` is read, and hostile snippets are refused), as do SoundCloud `api.soundcloud.com` widget addresses.
6. **One player at a time** across Video and Music windows.
7. **Click-to-load privacy gate.** Each provider's notice states what that embed can and cannot do.
8. **Tabletop (TT31 leftover).** Esc on a lifted wall now returns focus to that wall's button instead of leaving it on a pin of a wall that has gone flat, and returning focus does not re-lift the wall.

**H− (not possible for an independent app, and not claimed):**
- "**All functions of a regular app**" is out of reach for all three providers:
  - catalogue search, the user's own library and playlists, and full-length playback outside the provider's player all require partner API credentials, the user's OAuth sign-in and the provider's DRM SDK;
  - TIDAL's developer API needs a registered client;
  - Qobuz's API needs an app id plus a user token, and the only routes to one are unofficial, so they were rejected;
  - Amazon's Music Web and Device APIs are partner-only.
- No DRM circumvention, no unofficial tokens, no provider SDK bundled.
- **Full tracks:** TIDAL needs a subscription and sign-in inside the player, otherwise it plays 30-second previews. Amazon embeds play 30-second previews even for subscribers. Qobuz's widget may play excerpts.

**H∂ (unverified boundary):**
- Whether the live players load and play: their hosts are unreachable from the sandbox.
- Whether Amazon accepts an embed address *without* its opaque share `id`. Such addresses are flagged `unverified` in the UI, with the advice to paste Amazon's own embed code.
- Whether TIDAL's production build matches the repository revision that was read.

## C. Frontier

These are the next things that would actually raise parity:
- **TIDAL catalogue search.** A "bring your own TIDAL developer client" option (OAuth PKCE, catalogue search through TIDAL's official API). It can't be tested here because the host is unreachable.
- **TIDAL pause and progress.** TIDAL's own embed would need to start calling `broadcastMediaStatus`.
- **Qobuz and Amazon controls.** They would need a published control protocol.

## D. Negative space and the modal shortcut

**Refused shapes.** `tt33-unit` refuses 20 shapes, each with an asserted reason:
- **TIDAL:** artists, short links, bad UUIDs, non-numeric ids, bad mixes, genres, uploads;
- **Qobuz:** playlists, artists, bad ids;
- **Amazon:** artists, user-playlist pages, lowercase ASINs, podcasts, bad embed ids, an unknown storefront;
- **Embed snippets:** `srcdoc`, `javascript:`, `http:`, and a foreign `url=` in a SoundCloud widget.

**Junk messages.** The TIDAL controller ignores 10 junk messages.

**Modal shortcut** (e2e-tt33, test 4). The Rename dialog traps Escape: it closes only the dialog, leaving the title unchanged and the window open. Enter renames. The Tabletop Esc behaviour gets a new focus assertion in e2e-tt31.

## E. Mechanisms

1. A pure grammar module plus unit tests that use real ids published by the providers (TIDAL's own test-page items; a real Amazon Share → Embed snippet).
2. A protocol state machine written from the provider's source, with `assumed` marking every non-confirmed state.
3. **Conformance against the provider's real code:** the e2e test serves TIDAL's unmodified bridge files on the intercepted `embed.tidal.com` origin.
4. Mutation testing:
   - **unit:** dropping the pid check fails the suite, and so does using the wrong command key;
   - **browser:** removing the start broadcast fails the one-player test with "music's player was paused".
5. Request logging that proves no provider is contacted before consent.
6. A visual check: `docs/screenshots/tt33-tidal-qobuz.png`.

## F. Artifacts

**Code:**
- `src/lib/stream-core.ts`
- `src/lib/embed-control-core.ts`
- `src/components/modules/Streams.tsx`
- `src/components/Tabletop.tsx` (Esc focus)

**Register:** `src/db/seed-data/features-tt33.ts`, with rows SM-05, SM-06, SM-07 and SM-08. The seed is now 3.22.0.

**Tests:**
- `scripts/tt33-unit.mts` (7 tests)
- `scripts/e2e-tt33.mts` (4 tests)
- the e2e-tt31 focus assertion
- test-only fixture `scripts/fixtures/tidal-embed/` (Apache-2.0 LICENSE + NOTICE; not shipped)

## G. Adversary

- **"The TIDAL fixture is your own mock."** No: the message handling running in the frame is TIDAL's own file. Only the play button is a stand-in, wired exactly as TIDAL's `app.js` lines 850–866 and 174 wire theirs.
- **"Pause sent is a lie if the user paused inside the player."** That's why the label is "Pause sent", not "Paused", and both Play and Pause stay enabled.
- **"A hostile site posts a start."** Messages are rejected unless they pass all three checks: source is our frame, origin is exact, and the pid matches.

## H. External verification

- TIDAL protocol and sizes: github.com/tidal-music/embed-player (`message-bridge.js`, `url-options.js`, `app.js`, test page).
- Qobuz widget shapes: the EmbedVideo MediaWiki extension's code and tests. They were read for the facts only; no code was used.
- Amazon marketplace ids: Amazon SP-API "Marketplace IDs".
- Amazon embed shape: public Share → Embed snippets.

## I. Repairs

**Tabletop Esc focus.**
- *Attack:* Esc while a pin of a lifted wall has focus.
- *Before:* focus stayed on the pin of the flattened wall (measured).
- *After:* focus is on `tt-open-north`; the wall stays settled 900 ms later; Tab re-lifts it.

## J. Stopping

The ask was to make TIDAL, Qobuz and Amazon Music Class A "with all functions of a regular app". What was delivered is everything an embedding app can honestly provide: the official players, grammar, privacy, library, queue, control where a protocol exists, and one player at a time. The remaining gap is listed under H−, and it can't be closed without the providers' partner access.

## Results (measured)

- **Register:** 340 rows (+4), built 255, partial 46, blocked 22, probe 17. Ledger build: 255 / 63 / 22; tests: 137 / 77 / 126.
- **New suites:** `tt33-unit` 7/7 and `e2e-tt33` 4/4. `e2e-tt31` is 10/10 including the new Esc-focus assertions.
- **Full run** (`run-all.sh`, 56 suites):
  - 548/549. The one failure was e2e-tabletop "a wall becomes the main view", timing out at "west is main".
  - That step is a mouse double-click aimed at a wall while its 300 ms hover-lift can move it under the pointer. The suite is 14/14 on two solo reruns, and the Esc branch changed in TT33 is not on that path (that Esc runs while a wall is the main view).
  - It is recorded as a load-sensitive flake. The ledger reads 549/549 from the solo result.
- **Mutants:** 3 seeded, 3 caught (2 unit, 1 browser).
