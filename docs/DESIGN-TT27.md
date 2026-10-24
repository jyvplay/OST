# TT27 design notes — slanted Tabletop, wall pinboards, saved views, Silver / Daylight, colour beauty, Video / Music / Maps

Everything below is implemented in this tier and tested by the suites named in each section (register rows LY-11..15,
SM-01..03, MP-01..03 in `src/db/seed-data/features-tt27.ts`). Limits are stated at the end of each section; nothing here
is simulated.

## 1. The slanted Tabletop camera (LY-11)

**Requirement:** the default Tabletop view is a slanted angle, as a person sees a desk when looking down at it, and the
floor (the desk) covers **more than 80 % of the observable space**.

**How:** `src/lib/tabletop-slant.ts` builds the box with a real perspective projection (tilt β = 38°, vanishing point
45 % of the frame height above it, i.e. a seated eye line above the desk) and renders each face with an exact
**homography** (`matrix3d`), because CSS `perspective` + `rotateX` cannot keep the near edge pinned to the bottom of an
arbitrary frame. Everything except β is *solved* by bisection, not tuned:

| solved quantity | constraint |
|---|---|
| perspective | the far edge is inset by a small fraction of W on each side — that sliver is the side wall you see |
| south-lip height | the near lip shows **33 px** (32 px chrome-target floor + 1 px for sub-pixel layout rounding); on very short frames (e.g. 800×300) it falls back to the WCAG 2.5.8 minimum of 24 px so the 80 % floor still holds |
| floor depth | the far edge lands at ≈ 7.5 % of H (the north wall's band) |
| wall height | the north wall's top reaches the top of the frame (no empty strip) |

Coverage is computed exactly (Sutherland–Hodgman clipping of the projected floor by the screen, minus the part hidden
behind the lip) and `fitSlant` narrows the side walls until coverage ≥ 81 %.

| frame | floor share (computed) |
|---|---|
| 1440×860 | 82.4 % |
| 1280×760 | 82.5 % |
| 1920×1020 | 82.4 % |
| 390×700 | 82.3 % |
| 800×300 | 81.3 % |

**Measured, not just computed:** `e2e-tabletop` hit-samples 1 440 points over the live Tabletop at 1440×900 and 390×844
and counts the points whose *topmost* face is the floor. The live share is 84.1 % on both (the corners above the side
walls are empty frame, which counts as "not floor"), within 4 points of the computed value. A **Camera** toggle switches
between the slant and the TT26 top-down box, and the choice persists in the desktop state.

Pointer maths on the slant inverts the homography, so a drag, a drop or a pile lands exactly under the pointer.
`tabletop-unit` checks the homography against the 3D projection to < 0.01 px.

## 2. Walls are pinboards (LY-12)

Every wall now has its own board, with the same model as the floor (`tabletop-core.ts` v2, `walls.{north|east|south|west}`):
- **Pin:** drag a card from the floor onto a wall in the box view and it is pinned there (`moveToSurface`), placed in the
  wall's first free slot. Pins are unlimited: the board scrolls.
- **Move:** with the wall open, drag cards anywhere on it.
- **Pile:** drop a card on another card to pile them, exactly as on the floor. Fan, gather and take-from-pile work too.
- **Keyboard:** Shift+F10 on a card offers "Pin to the … wall" and "Put back on the table"; Alt+Arrow moves a card.
- Each wall shows a pin count chip. The wall's built-in panel (Windows, Apps, Widgets, Recent) stays beside the pins.

Tested by `e2e-tabletop` (drag-pin, persisted, leaves the floor, count chip, move on the wall, put back; wall piles) and
`tabletop-unit`.

## 3. Saved Tabletop views (LY-13)

A *view* stores the camera (slant or top), the main face, and a snapshot of the floor and wall boards. The **Views**
panel can save the current arrangement under a name, load one in one click, rename it, or delete it.
Saving under an existing name updates that view in place. Up to 12 views are kept in the desktop state (`MAX_VIEWS`), so they sync like the rest of the
desktop. Files deleted since a view was saved are dropped silently when it loads. Tested by `tabletop-unit` and
`e2e-tabletop` (save → change → load restores the camera and positions, survives a reload).

## 4. Silver (Art) and Daylight (Business) (LY-14)

| style | finish | light tokens | accent | modelled on |
|---|---|---|---|---|
| **Silver** | satin | bg #e6e8ec, text #1d1d1f, muted #55585f | #0a84ff | macOS light appearance: aluminium-grey chrome, system blue |
| **Daylight** | acrylic | bg #eef2f8, text #1a1d23, muted #545b68 | #2f95e6 | Windows 11 light: Mica / acrylic surfaces, Fluent blue |

The accents are light enough to carry dark (#04102b) button text at AA contrast. Each style has its own wallpaper
(`public/wallpapers/silver.svg`, `daylight.svg`) and a unique tile finish, which `a11y-unit` enforces.

**Pairing:** choosing the Art layout switches to Silver (light) and Business to Daylight (light). This is controlled by
`appearance.pairStyle` (on by default), with the toggle in Display settings. With pairing off, the layout and style are
independent. All 13 styles stay selectable. Tested by `e2e-media27` ("pairing") and `a11y-unit`.

## 5. Colour beauty standard (LY-15)

`src/lib/colour-beauty-core.ts` (pure) and the "colour schemes" test in `e2e-beauty` screenshot every style × theme
(26 combinations) at 1440×900, downsample to 360×225 and measure in OKLCH. The generated report is
`docs/COLOUR-REPORT.md`.

**Hard rules (fail the suite):**
- axe-core `color-contrast` (WCAG 2.2 SC 1.4.3) has zero violations. WCAG 2.x ratios remain normative: the WCAG 3.0
  Working Draft (Sep 2026) still says its contrast algorithm is "yet to be determined", and APCA is not adopted.
- Silver and Daylight in light theme are ≥ 55 % light-neutral pixels (L ≥ 0.80, C ≤ 0.045). This is the measurable form
  of "mostly silver / mostly light". Measured: Silver 91.1 %, Daylight 92.1 %.

**Soft findings (reported, never failed), with the evidence for keeping them soft:**
- **Harmony template fit** (Cohen-Or templates) of the icon palette + accent. O'Donovan, Agarwala & Hertzmann (large
  Kuler / COLOURlovers datasets) found monochromatic, analogous and complementary templates the most used. But Schloss &
  Palmer found little evidence for contrastive-hue harmony, and Tan, Echevarria & Gingold (TVCG 2025, > 1 000
  participants) found harmonised images were not preferred. So it is descriptive only.
- **Hue entropy** (O'Donovan's complexity measure; lower = simpler).
- **60-30-10 deviation:** a practitioner rule with no controlled evidence, so soft.

**Result this tier:** 26/26 combinations have zero contrast violations. One observation: Silver and Daylight in *dark*
theme are still about 50 % light-neutral, because their wallpapers are light by design. Dark theme darkens the windows
and chrome, not the wallpaper.

**Projection rule (added this tier):** on 3D-projected faces (the slanted floor, folded walls), the checker judges size
rules on an element's own layout size (its design size before the camera) and position rules on the part visible on
screen (the Tabletop crops the projection at its frame, like a camera). Targets touching a screen edge keep the existing
Fitts edge rule.

## 6. Video and Music — embedded streaming (SM-01..03)

Two modules share `src/components/modules/Streams.tsx` and the pure `src/lib/stream-core.ts`:
- **Video:** YouTube (sent to `youtube-nocookie.com`, rel=0, start time), Vimeo (dnt=1), Dailymotion, Twitch (with the
  required `parent=` host), PeerTube, and direct video file links.
- **Music:** Spotify (`open.spotify.com/embed/{track|album|playlist|artist|show|episode}/{id}`, compact 152 px or tall
  352 px) and SoundCloud (`w.soundcloud.com/player/?url=…`, 166 / 450 px), and direct audio file links.

**Only the providers' official embed players are used.** There is no scraping and no third-party front-end: Invidious and
Piped are AGPL and were not used. No streaming code is vendored; the iframes are the providers' own players, used under
their embed terms.

**Privacy:** nothing is contacted until the user presses **Load player** on a click-to-load facade, which names the host
that will see their IP. "Always load" sets `media.embeds=allow`. The app sends a global `Referrer-Policy: no-referrer`;
YouTube refuses embeds with no Referer (error 153 since 2025). So each player iframe sets
`referrerpolicy="strict-origin-when-cross-origin"`, which sends only the origin. The iframes are sandboxed (scripts,
same-origin, presentation, popups).

**Library:** saved links live in `/Documents/Streams.json` (a real file in the shell's file system), with rename,
remove, filter, Next and Loop list. Direct files auto-advance at the end. Saves are debounced and flushed on unmount and
on `pagehide`.

**Layout:** a container query on the window. A wide video window lets the player fill the height; a narrow window (or a
phone) stacks the player above the library, and the consent card sizes to its text.

**Tests:** `stream-unit` covers URL parsing for every provider, time parsing, embed heights and allow lists, and library
operations. `e2e-media27` runs in Chromium with the provider hosts intercepted (the sandbox has no route to them). It
checks the facade (nothing contacted before consent), the iframe `src`/`allow`/`sandbox`/`referrerpolicy`, the
**Referer the browser actually sends** (origin only), library persistence across reloads, and Music with Spotify and
SoundCloud.

**Limits (honest):** actual playback cannot be verified in this sandbox (no network route to the providers, and no
proprietary codecs). Spotify plays 30-second previews unless the user is signed in to Spotify in that browser.
SoundCloud autoplay is best-effort. `on.soundcloud.com` short links and plain-http links are refused with an explanation.

## 7. Maps (MP-01..03)

`src/components/modules/Maps.tsx` with the pure `src/lib/maps-core.ts`. Open-source parts only:

| package | version | licence |
|---|---|---|
| leaflet | 1.9.4 | BSD-2-Clause |
| world-atlas (Natural Earth 1:50m countries) | 2.0.2 | ISC; the data is public domain |
| topojson-client | 3.1.0 | ISC |
| @types/leaflet / @types/topojson-client | 1.9.22 / 3.1.5 | MIT |

- **Works offline by default:** the base map is Natural Earth country polygons, bundled and drawn on a canvas. Hover
  shows the country; "Locate me" uses the browser's geolocation (with permission); search covers countries, saved places and coordinates (`35.78, -78.64`, `35°46′N 78°38′W`). A
  country result flies to its **main landmass** (`mainBbox`), so "France" frames Europe, not the Atlantic between
  France and French Guiana.
- **Antimeridian:** rings that cross ±180° are unwrapped for display (`unwrapRing`). Before this fix, Russia and Fiji drew
  seam lines across the whole map; the bug was found by visual inspection.
- **Places:** add by clicking the map or "Add at centre". Rename, note, delete and fly-to are supported. Places are stored
  as RFC 7946 GeoJSON in `/Documents/Places.geojson`; Import and Export are available, and `.geojson` files open in Maps.
- **Measure:** click points to measure a path with great-circle (haversine) distance, in km or mi. LHR→JFK measures
  ≈ 5 540 km.
- **Street tiles are opt-in:** OpenStreetMap's tile policy requires a visible attribution and a Referer, forbids bulk or
  prefetch use, and asks distributed apps to arrange heavy use in advance. So the default is **off**. "OpenStreetMap"
  enables `tile.openstreetmap.org` with "© OpenStreetMap contributors" and an origin-only Referer, and "Custom" accepts a
  validated `{z}/{x}/{y}` https template (for example a self-hosted or commercial tile server). Invalid templates are
  refused by the settings API with 422.
- **Tests:** `maps-unit` covers point-in-polygon (Raleigh → United States of America), coordinate parsing and formatting,
  geodesy, the antimeridian unwrap, the France main landmass, and places operations. `e2e-media27` checks the offline map
  draws land, search → fly to France, the place and measure distance against haversine (±1 %), OSM tiles requested with
  the attribution and an origin Referer (intercepted), and the bad template refused.

**Limits:** no street-address geocoding and no routing (both need an online service; none is free-for-all without
arrangement). Offline detail is country level only.
