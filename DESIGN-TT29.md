# TT29 — Spotify control and a legible Tabletop

TT29 removes two of the blockers left by TT27/TT28, using original code written for this repository. No provider SDK,
no copied player wrapper, no renamed third-party module. It supersedes the "Spotify is uncontrolled" statements in
DESIGN-TT28.md.

## 1. Spotify embed control (SM-04)

### What changed
Before, the Music window could load a Spotify embed but could not start or stop it, could not show its position,
and could not move on when a track ended. Auto-next skipped Spotify rows.

Now, in `src/lib/embed-control-core.ts`:

- **Inbound messages.** These are objects of the form `{type, payload}`:
  - `ready` → we mark the player connected;
  - `playback_update` → `{position, duration}` (in ms) plus `isPaused` / `isBuffering`;
  - `error`.
  
  They are accepted only from the iframe's own `contentWindow` *and* the exact origin `https://open.spotify.com`
  (the same gate as the other providers).
- **Play / pause.** The embed answers `{command: "toggle"}`. That string is **confirmed by two independent public
  reports** (Stack Overflow 71979852, with a commenter confirming it on a plain embed src; Spotify Community thread
  5502612). Because a toggle only flips the state, `command()` sends it only when the reported state differs from the
  one asked for. Pressing Pause on a paused player sends nothing.
- **Autoplay for Auto-next.** Spotify's embed URL has no autoplay flag. When Auto-next lands on a Spotify row, the
  new player is asked to play by one toggle right after its `ready`.
- **End of track.** Spotify posts no "ended". The end is inferred by `spotifyEnded()`:
  - the player reports *paused* with the position within 0.5 s of the duration; or
  - it is paused and has rewound after having been in the last second (a preview that resets).
  
  Not ends: a user pause 2 s before the end; a playlist rolling into its next track (new duration, still playing);
  junk payloads. A replay re-arms the detector, so a second end counts too.
- **Load acknowledgement.** After `ready` we send `{command: "load_complete_ack"}` once. This mirrors the shape the
  public controller sends, but the exact string is **unconfirmed**. Nothing in our code depends on it.

### Honest limits
- **No seek and no volume for Spotify.** Only the toggle is confirmed. We do not send guessed seek strings.
- **Previews.** Without a signed-in Premium account, Spotify plays 30-second previews. This is a provider
  restriction and is not bypassed (no DRM or ToS circumvention).
- **Live testing.** `open.spotify.com` is **not reachable from the test sandbox**, so live Spotify is untested.
  Verification uses a local fixture player that speaks the message format above (`scripts/e2e-tt28.mts`, Spotify
  section). It is the same strategy, and the same caveat, as YouTube, Vimeo and SoundCloud in TT28.

### Tests
- `stream-unit.mts` "Spotify embed control (TT29)…": 7/7 tests. Three hand-made mutants (end threshold, rewind
  clause, autoplay toggle) are each caught.
- `e2e-tt28.mts` SM-04 second test, in a real browser against the fixture:
  - exactly one ack, and the frame sees our exact origin;
  - Play → toggle → "playing" → the button reads Pause;
  - clock "0:12 / 0:30";
  - a pause at 28 s does **not** advance;
  - a pause at 29.8 s ends the track → the next row, "Second spot", becomes current, and its new player receives a
    toggle.
- The evil-frame spoof test now also posts a Spotify-format fake end from the wrong window. It is ignored.

## 2. Tabletop legibility level of detail (LY-20) and the "no squashed text" rule (LY-21)

### The defect (found by TT29 screenshot review)
- **Slanted camera.** The side walls are slivers and the south wall is a ~36 px lip. Each still rendered its
  heading, chips and tiles, which the projection squashed into smears. The slivers were also too thin to hit
  reliably.
- **Top-down camera.** Measuring revealed the same defect: the smallest wall text rendered at **3.2 px** effective.

### The rule
`src/lib/tabletop-slant.ts`:

- `faceScale(w, h, quad)`: the minimum linear scale of the plane → screen map. It is the smallest singular value of
  the homography's Jacobian, computed analytically at the four corners and the centre. A homography's Jacobian is
  ∝ 1/w² with w affine in (u, v), so the extremes lie on the boundary. Corners plus centre are a sampled bound; our
  wall frames have no shear.
- A wall shows **detail** only if scale ≥ **0.6** (a 16 px label stays ≥ 9.6 px) and its projected extent ≥ **96 px**.
  Otherwise it shows **glyphs**: pinned items (and, on the Windows wall, open windows) as shapes, with no text.
- `wallLegibility(slant)` uses the slant tray's solved quads. `boxQuads` / `boxLegibility` give the top-down box's
  quads from its depth and floor scale. A plane under perspective is a homography, so the four corners determine it
  exactly; e2e confirms each wall's DOM box matches the model within ±2 px.

**Measured verdicts.** Every wall falls below the rule in both cameras:
- slant: side walls 0.04–0.15, north 0.46, south 0.38;
- top-down: 0.13–0.39.

So the overview always shows glyphs plus tags. An opened wall is full size and fully detailed.

### Wall tags
- A flat, unprojected pill sits at the centroid of the wall's **visible** polygon (clipped to the frame). It names
  the wall with live counts ("Windows · 1 open", "Widgets · 1 pinned").
- **Click** opens the wall. **Dropping a dragged card on it pins the card** to that wall: `wallUnder()` checks tags
  first. This replaces aiming at a sliver.
- Side walls get vertical spines. On a phone the sliver is ~6–23 px wide, thinner than a 24 px target, so the spine
  sits flush to the frame edge and overlaps the floor edge. The test asserts it overlaps its wall, not that it is
  centred on it.
- In the top-down box the switcher floats over the south wall. Visual review caught the "Recent" tag under it; the
  e2e assertion was then written to fail on that build. The tag now moves to the middle of the wider free stretch
  beside the switcher, which is measured with a ResizeObserver.
- Tags are pointer conveniences marked `aria-hidden`. Keyboard and screen-reader users keep the "Open the … wall"
  buttons and the switcher, so nothing is announced twice.

### The beauty rule (e2e-tt29)
For every visible text element on the Tabletop:

effective px = computed font-size × min(projected width ÷ layout width, projected height ÷ layout height)

It must be ≥ 9 px. Decorative `aria-hidden` miniatures (card content peeks) are excluded **and counted in the log**.
The bounding-box ratio is lenient for text rotated in-plane, but foreshortening (the actual defect) is caught.

| Frame | Smallest text |
|---|---|
| 1440×900, slanted | 10.6 px |
| 390×800, slanted | 10.8 px |
| 1440×900, top-down | 13.5 px (was 3.2 px) |

### Tests
- `tt29-unit.mts` (4/4): hand-computed singular values and scales; centroids; tags inside their visible wall at
  1 500 random frames; an area identity for the top-down quads. Three mutants (max instead of min, a wrong centroid
  factor, the spine threshold) are each caught.
- `e2e-tt29.mts` (4/4): the squashed-text rule at desktop and phone; tag placement, size, non-overlap and counts;
  click-to-open and drop-to-pin (persisted); the top-down model vs the DOM and the switcher collision.

## 3. Still open (not claimed)
- **AX-13** is a Playwright accessibility-tree check, not a real screen reader.
- **Real-host playback.** SM-04 is fixture-tested for all four providers.
- **Gazetteer flake.** The intermittent e2e-tt28 "manual name kept" failure has no root cause yet.
- **The 22 tier-X rows** stay blocked (hardware / OS / network capabilities a browser app cannot have).
