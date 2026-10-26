# TT28 design notes: removing TT27's blockers with original code

The user asked for code written here from scratch (not borrowed, renamed or recalled from elsewhere) that removes the
specific blockers TT27 reported. Each section below names the blocker, says what was written, how it is tested, and
what it still does not do. Register rows: SM-04, MP-04, MP-05, SH-15, LY-16..19, AX-13 in
`src/db/seed-data/features-tt28.ts`. Nothing below is simulated. Where a test uses a stand-in (fixture players), it
says so.

| TT27 blocker | TT28 result | evidence |
|---|---|---|
| Embedded players could not auto-advance or be controlled | two-way control for YouTube, Vimeo, SoundCloud (SM-04) | stream-unit, e2e-tt28 (fixture players) |
| No place-name search (country / coordinate only) | offline city geocoding + reverse lookup (MP-04/05) | maps-unit (exact vs brute force), e2e-tt28 |
| Inputs used `window.prompt` (unstyled, blocking, no validation) | in-app ask dialog everywhere (SH-15) | tt28-unit, e2e-tt28, e2e-image |
| Business layout had no Snap layouts | flyout, edge snapping with preview, Snap Assist, Win+Z (LY-16/17) | tt28-unit, e2e-tt28 |
| Art dock could not auto-hide; minimise had no effect | auto-hide with edge/focus reveal; genie-style funnel (LY-18/19) | tt28-unit, e2e-tt28 |
| No screen-reader structure check | accessibility-tree snapshots in all 3 layouts (AX-13) | e2e-tt28 |
| Spotify full playback / control | **still a provider restriction** (no public message API; previews unless signed in) | stated in UI |

## 1. Embed control (SM-04): `src/lib/embed-control-core.ts`

The three providers publish message formats for their embed players. We implemented them directly, with no provider
SDK `<script>`:

* **YouTube:** the page is loaded with `enablejsapi=1&origin=<our origin>`. We post the string
  `{"event":"listening","id":…,"channel":"widget"}`, merge `initialDelivery` / `infoDelivery` patches (currentTime,
  duration, playerState), and send `{"event":"command","func":"playVideo"|"pauseVideo"|"seekTo",…}`. playerState 0 means
  ended. If the handshake is lost, "listening" is re-sent.
* **Vimeo:** we wait for `ready` (string or object form), then register `addEventListener` for play, pause, timeupdate
  and ended (legacy `finish` too). Commands are play, pause and setCurrentTime. Duplicate pause/seek events after `ended`
  are ignored.
* **SoundCloud:** `{method,value}` JSON to `https://w.soundcloud.com`, registered after `ready`. playProgress is in
  milliseconds, `finish` means ended.

**Trust boundary:** a message is accepted only if `event.source` is that iframe's own window **and** `event.origin` is
the provider's exact origin. Payloads are parsed defensively: non-JSON, wrong shapes and out-of-range numbers are
dropped. `ended` feeds the existing library's `nextIn` (Auto-next / Loop list).

**Limit:** the sandbox cannot reach the real players. e2e-tt28 serves *fixture players that speak the same protocol*
on stubbed provider hosts, which verifies our side of the protocol, not live playback. Register rows are therefore
tested "partial".

## 2. Offline gazetteer (MP-04 / MP-05): `gazetteer-core.ts`, `server/gazetteer.ts`

* **Data:** GeoNames `cities15000` (26 435 cities ≥ 15 000 people; CC BY 4.0, credited in the map attribution). It is
  shipped by `cities-15000-structured` (MIT). We use only its data file; the TSV parser, name folding (NFD + diacritic
  strip + case), alternate-name index and ranking are ours.
* **Search ranking:** exact primary name > prefix > alternate name, ties broken by population. Qualifiers such as
  "Paris, TX" or "Paris, France" filter by admin1 / country code / country name.
* **Nearest:** a 1° grid with ring expansion. A ring stops only when the haversine *lower bound* to any unvisited cell
  exceeds the best distance found, so the result is exact. This is checked against brute force on 400 random points,
  including poles and the antimeridian. Naming is "In X" within 25 km, otherwise "N km <dir> of X".
* **UI:** the search list adds a city kind, a found card (population, time zone, coordinates) and *Save as place*.
  "Add at centre" auto-names, hover shows the nearest city, and a typed name is never overwritten by a late lookup.
  Without street tiles the map flies to a regional zoom (7) instead of 11, because the offline layer has only
  coastlines and borders.
* **Fix found by screenshot review:** point markers were canvas `circleMarker`s. During `flyTo`, Leaflet CSS-scales the
  vector canvas, so a 9 px dot filled the whole map until the flight ended. Markers are now DOM dots (`divIcon`), and
  e2e-tt28 samples the pin size *during* the flight.
* **Limit:** city level only. There is no street-address geocoding and no routing.

## 3. Ask dialog (SH-15): `src/lib/ask.ts`, `src/components/AskHost.tsx`

`askForm({title, detail, fields, okLabel, validate})` resolves to the values or `null`. `askText` is the single-field
form. The store is a FIFO queue (cap 8), each request settles exactly once, values are capped at 4 KiB, and a throwing
validator shows its message instead of crashing. The host is `aria-modal`:

* focus starts in the first field with the text selected, and Tab / Shift+Tab are trapped;
* Esc cancels and focus returns to the opener;
* shell chords are blocked while it is open;
* secret fields are masked, have a Show toggle and use `autocomplete=off`.

All 25 call sites that used `window.prompt` were converted. The Vault's three prompts became one 3-field form and
Files › Encrypt asks for the passphrase twice. `confirm()` / `alert()` remain native.

## 4. Snap (LY-16 / LY-17): `src/lib/snap-core.ts`, `src/components/SnapHost.tsx`

* **Layouts:** halves, 2/3 + 1/3, thirds, half + quarters, quarters, and quarter-half-quarter at ≥ 1600 px. Zone
  rectangles are computed with integer edges shared between neighbours, so every layout tiles the desk exactly (2 000
  random sizes in tt28-unit).
* **Flyout:** hover Maximise (Business caption) or press Win+Z (Ctrl+Alt+Z on a Mac keyboard). Each layout is a named
  `group` and each zone a named button. It lives in a desk-level host because windows clip overflow.
* **Edge drag:** corners give quarters, sides give halves, and the top edge maximises. A live preview is shown, and a
  release mid-screen never snaps.
* **Snap Assist:** the remaining zones of the chosen layout, in reading order, offer the other windows on the current
  workspace. "Not now" or Esc dismisses it.
* **Scope:** Business only. Art keeps macOS-style behaviour.

## 5. Art dock (LY-18 / LY-19)

* **Auto-hide:** the dock slides out (`transform`). A 4 px strip at the bottom edge reveals it, and the strip itself
  schedules the hide (≈ 0.6 s) on pointer leave, because the dock floats above the edge. Focus anywhere inside the dock
  reveals it, so keyboard users are never locked out. It is off by default, under Display settings.
* **Genie:** a fixed-position ghost of the window animates a 4-point `clip-path` polygon (Web Animations). The window
  first narrows its bottom edge toward the `dock-min` tile, then drops into it. It is skipped entirely under
  `prefers-reduced-motion` or Motion: off. This is a trapezoid funnel, not macOS's mesh warp.

## 6. Accessibility tree (AX-13)

e2e-tt28 takes Playwright `ariaSnapshot()`s of the live page in Fusion, Business and Art. It checks that:

* windows are named dialogs;
* Art's Dock is a navigation landmark and Business exposes its taskbar;
* there are **no unnamed buttons, text fields, checkboxes, links or combo boxes**;
* the ask dialog and the Snap flyout expose their roles, names, groups and buttons.

**Limit:** this is Chromium's accessibility tree, not NVDA / JAWS / VoiceOver output. Real screen-reader speech and
reading order remain unverified in this sandbox.

## Visual review

`scripts/shots-tt28.mts` writes screenshots (not committed) of the Snap flyout / assist / drag preview (Daylight), the
ask dialog in Daylight and in dark Poolside with a validation error, Maps city results and found card, the Video
control row, the Art dock hidden / revealed (Silver), and genie mid-frames. The review found and fixed one real bug
(map markers ballooning during `flyTo`, §2). All the other surfaces were checked by eye against the beauty-standard
rules (24–44 px targets, readable contrast, no clipped text).
