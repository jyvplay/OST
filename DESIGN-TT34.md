# TT34: survey-grade Maps (geodesy, Plus Codes, GPX/KML) and a full media transport

**Runtime honesty.** Everything here was built and run in the Arena sandbox. The tools were Node 22 with
TypeScript strip-types, Next 16 (`next build` + `next start`), headless Chromium driven by Playwright 1.64, and
Python 3 for the test-only oracles: GeographicLib, gpxpy and `xml.etree`. YouTube, Vimeo, SoundCloud and OSM
are **unreachable** from this sandbox. Every player test therefore runs against a **protocol fixture**: a
page I wrote that speaks the provider's *documented* postMessage API and records what Fusion sends. The
native-audio test plays a WAV that the test **generates** (30 s, 8 kHz), served with HTTP byte ranges. None of
this proves that the real provider iframes behave like the fixtures. It proves that Fusion sends and receives
exactly what each provider documents.

## A. Formal model

- **Geodesy (MP-06).** The ellipsoid is WGS84 (a = 6 378 137 m, f = 1/298.257223563).
  - `inverse(p, q) → {s, az1, az2, method}`. It uses Vincenty's iteration (to |Δλ| ≤ 1e-13). If λ grows past
    π or fails to converge in 500 steps (the near-antipodal regime), it falls back to a **shooting** solver.
    This is a 2-D Newton method on (departure azimuth, length): `direct()` is the forward model, the Jacobian
    is numerical, steps are damped, and it runs up to 60 iterations until the endpoint error is < 1e-5.
  - Meridional and polar cases are special-cased before shooting.
  - `polygonArea(ring)` densifies each edge along the geodesic (default ≤ 2 km steps). It then integrates on
    the authalic sphere (Snyder's authalic latitude β) using spherical excess.
  - **Winding rule:** if |ΣΔλ| > π, the ring encloses a pole, so `area = 2π·sign − S` (scaled by R_q²).
- **Plus Codes (MP-07).**
  - Degrees are converted to integers by **floor**, with ×8000 for latitude and ×8 192 000 for longitude.
    Float products within 1e-5 of an integer snap to it.
  - Latitude is clamped to [0, 4 499 999 999]. Longitude wraps.
  - Encoding is base-20 pairs, followed by a 4×5 grid refinement for digits beyond 10.
  - `shorten` removes 2, 4, 6 or **8** leading digits while the reference lies within 0.3 × the removed
    prefix's resolution.
  - `recoverNearest` prefixes the code with the reference's encoding. It then shifts by one resolution step if
    the result is more than half a step away (latitude stays within ±90).
- **GPX/KML (MP-08).** A strict XML reader produces a tree with text and attributes.
  - Any `<!ENTITY` is refused (layer 1). Undeclared entities are refused (layer 2). Input over 20 MB is
    refused.
  - GPX 1.0/1.1: `wpt` → places; the first `trk`/`rte` → the Measure path.
  - KML: Point, LineString and Polygon (outer ring).
  - Writers XML-escape every text node.
- **Transport (SM-09/10/11).** `capabilities(provider)` is a set ⊆ {seek, volume, mute, rate, next, prev}.
  - A UI control is **enabled iff** the capability is present.
  - A reading (volume, speed) is shown as *reported* only once the provider has echoed it back
    (`data-reported`).
  - `keyAction(key, mods, typing)` maps keys to commands, or to null when typing, with Ctrl/⌘/Alt held, or
    when Space/arrows belong to the focused control.
  - Library order: `prevIn` retraces the play history; `shuffleNext` draws uniformly with no repeats within a
    round.

## B. Claims

**H+ (claimed and tested):**
- Distances and areas on the ellipsoid match GeographicLib to sub-millimetre and 4e-8 relative accuracy.
- Plus Codes pass all 766 official vectors.
- GPX/KML round-trip through independent readers, and hostile XML is refused.
- YouTube receives mute/unMute/setVolume/seekTo/setPlaybackRate/nextVideo/previousVideo exactly as the IFrame
  API documents, and the UI reflects `infoDelivery`.
- Vimeo gets setVolume/setMuted/setPlaybackRate. When the owner disables speed, the UI keeps showing the
  *reported* 1×.
- SoundCloud gets seekTo/next/prev.
- Native `<audio>` is fully driven, including seeking.
- Keyboard shortcuts work and never fire while typing.
- Shuffle is χ²-uniform.

**H− (not claimed):**
- Behaviour of the *real* provider iframes, which are unreachable here.
- SoundCloud volume/mute/speed: deliberately not offered (see G).
- Spotify beyond toggle; TIDAL beyond play/pause; Qobuz and Amazon have no control.
- Keyboard shortcuts while focus is *inside* a provider iframe (browsers don't deliver those keys to the page).

**H∂ (partial):**
- Vimeo speed works only where the video's owner allows it.
- A short Plus Code with a city depends on the offline gazetteer (cities15000) containing that city.

## C. Frontier

- **Maps:** routing and elevation need a data source that can't be reached offline. Area is spherical-excess
  on the authalic sphere, accurate to ~4e-8, not Karney's series; that is enough for any human use.
- **Players:** SoundCloud volume could be offered only once its scale is confirmed against the live widget,
  which needs network access.

## D. Negative space (≥ 15 shapes) and the modal shortcut

| # | Shape | Behaviour (tested unless stated) |
|---|---|---|
| 1 | `<!ENTITY` billion-laughs GPX | refused: "XML: entity declarations are not accepted" (M3 pins this exact layer) |
| 2 | undeclared `&foo;` | refused (second layer) |
| 3 | external `SYSTEM` entity | refused by layer 1 |
| 4 | malformed XML (unclosed tag) | refused with a reason |
| 5 | latitude 95 / longitude 200 in GPX | point skipped with a warning |
| 6 | > 20 MB file | refused |
| 7 | Plus Code `+`, `G+` | invalid (`+G6` is valid), per the official validity vectors. Encoding at an odd length < 10 throws in the code, but **no test covers it** |
| 8 | lat ≥ 90 / ≤ −90 in encode | clamped as the vectors require |
| 9 | exactly antipodal points | shooting fallback, not NaN |
| 10 | inverse at a pole | special case, no crash (was a crash before the fix) |
| 11 | ring enclosing the South Pole | winding correction (was the complement before the fix) |
| 12 | coincident points | s = 0 |
| 13 | key shortcuts while typing in the URL box | ignored |
| 14 | Ctrl/⌘/Alt + shortcut | ignored (left to the browser and the shell) |
| 15 | Space on a focused button, arrows on a focused slider | left to the element |
| 16 | Vimeo ignores setPlaybackRate | UI stays at the reported 1× (e2e B) |
| 17 | SoundCloud volume | control absent; no command sent |
| 18 | media server without byte ranges | found in the fixture: Chromium cannot seek; the fixture now serves 206 responses, as real servers do |

**Modal shortcut failure test.** While a text field such as the player's link box has focus, letter shortcuts
must do nothing. e2e A types into the link box and asserts that no command reaches the player ("typing in the
link box sends nothing to the player").

## E. Mechanisms (≥ 6, mechanism-distinct)

1. Vincenty iteration plus a damped 2-D Newton shooting solver on `direct()` (two independent algorithms).
2. Authalic-sphere spherical excess with a winding correction (integral geometry).
3. Integer floor arithmetic with snapping (Plus Codes; avoids the float-rounding trap of 20.3701125).
4. A strict hand-written XML tokenizer with two refusal layers (parser security).
5. A postMessage command/echo protocol per provider, with *reported-only* UI state (distributed honesty).
6. A pure `keyAction` reducer, separate from the DOM (keyboard).
7. Shuffle bag with history and a cross-round no-repeat rule (sampling).

## F. Artifacts

- **Libraries:** `src/lib/geodesy.ts`, `pluscode.ts`, `geo-formats.ts`; changes in `embed-control-core.ts`,
  `stream-core.ts` and `open-with.ts`.
- **UI:** `src/components/modules/Maps.tsx` and `Streams.tsx`, `src/app/globals.css` (transport).
- **Tests:** `scripts/tt34-unit.mts` (12 tests) and `scripts/e2e-tt34.mts` (5 tests). Supporting files:
  - e2e-tt34 has an optional `ONLY=` test filter and `TT_CPU=` CPU throttling;
  - `scripts/oracle/geod.py` and `geoformats.py` (test-only);
  - `scripts/fixtures/olc/` (official OLC vectors, Apache-2.0, test-only).
- **Register:** `src/db/seed-data/features-tt34.ts` (MP-06/07/08, SM-09/10/11); seed 3.23.0.

## G. Adversary

- **M1–M7: seven hand-made source mutants, all caught by tt34-unit.** By area: geodesy ×2 (MP-06), Plus
  Codes ×1 (MP-07), XML/GPX ×1 (MP-08: M3, dropping the `<!ENTITY` layer), transport ×1 (SM-09), keyboard ×1
  (SM-10), shuffle ×1 (SM-11). The exact edits weren't written down, beyond M3, so only the per-row counts
  recorded in the register are claimed here.
- **M3 weak-test finding.** M3 first *survived*: the second layer's error message also matched `/entity/`. The
  test now pins layer 1's exact message.
- **SoundCloud volume.** Its documentation says 0–100, while public reports say 0–1. A wrong guess means either
  a 100× blast or silence, so the control is refused rather than guessed.
- **M8, the Tabletop "race" (see I).** I hypothesised that the old e2e-tabletop "west is main" flake came from
  the 300 ms hover-lift firing between the two clicks of a double-click, and wrote a guard (`noLiftUntil`).
  - A mutant that removed the guard **survived**, even at 6× CPU throttling.
  - Tracing showed that mousedown focuses the wall's `tt-open` button, and that focus lifts the wall *at once*.
    The timer was never the thing that moved the wall, and a lift mid-double-click does not break the
    double-click.
  - The guard was therefore a no-op, and it was **reverted**. e2e-tt34 E stays as a regression guard
    (double-click across the lift deadline, ×3 walls, also at `TT_CPU=6`).
  - The flake's root cause remains **unknown**.

## H. External verification

- **Distances and areas:** GeographicLib (Karney), an independent implementation.
- **Plus Codes:** Google's official test vectors.
- **GPX:** gpxpy. **KML:** Python's `xml.etree`.
- **Players:** checked against the providers' published API docs (YouTube IFrame API, Vimeo player.js,
  SoundCloud widget API). There was no live check (hosts unreachable).

## I. Repairs, each with a new attack

| Finding | Repair | New attack |
|---|---|---|
| Vincenty diverges near antipodes | shooting fallback | 2 000 near-antipodal pairs vs GeographicLib: 0.065 mm |
| `(x+π) mod 2π − π` wrapping (wrapPi) cost area precision | exact wrap; poles before shooting | area relative error 4.2e-8 |
| crash on an inverse at a pole | special case | pole-to-pole and pole-to-equator vectors |
| polar cap area came out as the complement | winding correction | cap vs GeographicLib 2 507 270 031 169.875 m² |
| GPX names lost surrounding whitespace | stop trimming XML text | gpxpy reads back byte-identical names |
| OLC prose says ≤ 6 digits removed, the vectors remove 8 | follow the vectors (normative tests) | all 19 shorten/recover vectors |
| e2e B: overlapping windows intercepted clicks | lay out without overlap | rerun green ×3 |
| e2e C: fixture served media without byte ranges, so no seeking | 206/Content-Range | rerun green ×3 |
| e2e E: `boot()` dropped the Tabletop camera; the point picker aimed at the one-click tag; the approach armed the timer early | pass the table through `boot`; avoid `[data-wall-tag]`; approach from the floor; assert the wall is at rest before click 1 | rerun green ×3 and at `TT_CPU=6` |

The repair stayed within budget. Most of it was test-side, and the one product-side Tabletop change was reverted
as explained in G.

## J. Stopping

I stopped once:
- every new row had a unit test and an end-to-end test;
- every mutant was either caught or explained (M8);
- the full run was green, apart from listed flakes.

Further gains (live provider checks, SoundCloud volume) need network access this sandbox lacks.

## Results (measured)

| Area | Result |
|---|---|
| Inverse | max \|Δs\| 0.0737 mm (20 000 random pairs), 0.0654 mm (2 000 near-antipodal pairs); max \|Δaz1\| 5.55e-9° |
| Direct | 0.0900 mm |
| Area | max relative 4.22e-8; perimeter 0.0230 mm; polar cap matches GeographicLib |
| Plus Codes | encoding 302/302, decoding 420/420, validity 25/25, shorten/recover 19/19 |
| GPX/KML | oracles read Fusion's output back exactly; hostile input refused |
| tt34-unit | 12/12; mutants 7/7 caught (+ M8 survived → change reverted) |
| e2e-tt34 | 5/5 (×2 runs), guard also 1/1 at `TT_CPU=6` |
| Full run (58 suites) | first pass **558/566**; ledger after reruns **566/566** (see below) |
| Register | 346 rows; built 261 / partial 63 / blocked 22; tested 143 / 77 / 126 |
| Tails | 39 rows (9 / 10 / 20), all cited evidence present and passing |
| Beauty / colour | no hard violations; axe colour-contrast 0 on every theme combination |

**First-pass failures (8), stated plainly:**

- **stream-unit, 1 failure.** A real expectation change. TT34 deliberately adds `getSounds` to the SoundCloud
  handshake (for Prev/Next), and the TT28 test pinned the exact message list. The expectation was updated to
  the new exact list, not loosened. It is 7/7 on rerun.
- **e2e, 4 failures** (WebRTC, both SH-05 widget tests, the sticky-note widget), all locator timeouts.
  **e2e-layout, 2 failures** (dock rest size read as 44 or 48 px).
  - Both were green in isolation (61/61, 12/12).
  - The cause was **not determined**. My debugging scripts were run against the same shared desktop, and one
    exited without restoring its settings. That is a plausible cause, but by the time I checked, the settings
    were back to normal, so it is unconfirmed.
- **e2e-privacy, 1 failure.** The known CPU-sensitive AES-GCM throughput floor (47 MB/s measured). It was 14/14
  on rerun.
