import { F, type SpecRow } from "./row";

/**
 * TT34 register changes: Maps gets survey-grade geodesy, Plus Codes and GPX / KML; the Video / Music players get a
 * full transport (seek, volume, mute, speed, provider playlists, keyboard) wherever the provider's documented message
 * API allows it, plus library Previous / Shuffle. All original code; the oracles (GeographicLib, gpxpy, the Open
 * Location Code test vectors) are test-only.
 */
export const tt34Features: SpecRow[] = [
  F("MP-06", "MP", "Maps measures on the WGS84 ellipsoid: distances (Vincenty's equations, with a shooting solver where Vincenty fails near antipodes), true geodesic curves drawn on the map (continuous across the antimeridian), and the area + perimeter of a closed shape (polygons around a pole included); metric or imperial",
    "A", "P2", "src/lib/geodesy.ts (inverse, direct, polygonArea, geodesicLine, formatArea); src/components/modules/Maps.tsx (measure card: Closed shape, mp-area)",
    "Original code from the published equations (Vincenty 1975; Snyder's authalic latitude). Measured against GeographicLib (independent Python package, test-only): max distance error 0.074 mm over 20 000 random pairs and 0.065 mm over 2 000 near-antipodal pairs; direct problem 0.09 mm; polygon areas ≤ 4.2e-8 relative over 400 random polygons (1 m² to continents), polar cap and antimeridian cases. The haversine sphere it replaces was off by up to ~0.5 %. Bounds: points are on the ellipsoid surface (no heights); a self-intersecting shape gets a signed-sum area like other GIS tools.",
    "built", "tt34-unit.mts ×3 (2 mutants caught); e2e-tt34.mts ×1"),
  F("MP-07", "MP", "Plus Codes in Maps: search accepts a full code (8FVC9G8F+6W) or a short code with a city (9G8F+6W Zürich — recovered around the offline gazetteer's city) or alone (around the map centre) and flies to the code's cell; a saved place and a found city show their Plus Code, with Copy",
    "A", "P3", "src/lib/pluscode.ts (encode, decode, isValid / isShort / isFull, shorten, recoverNearest, findCode); src/components/modules/Maps.tsx",
    "Original code written from the Open Location Code specification; passes all 766 official test vectors (encoding incl. integer conversion, decoding, validity, shorten / recover — vendored under scripts/fixtures/olc with the Apache-2.0 licence). Where the specification's prose (\"a maximum of six digits removed\") and its vectors (removing eight) disagree, the vectors are followed and the choice is documented in the code. Fully offline.",
    "built", "tt34-unit.mts ×2 (1 mutant caught); e2e-tt34.mts ×1"),
  F("MP-08", "MP", "GPX and KML in Maps: Export GPX (places → waypoints, the measured path → a track) and Export KML (placemarks; the path → a line, a closed shape → a polygon); Import… and Files → Open with Maps read GPX 1.0 / 1.1 (waypoints → places, the first track / route → Measure) and KML (Point / LineString / Polygon, MultiGeometry, folders, namespaced)",
    "A", "P3", "src/lib/geo-formats.ts (parseXml, parseGPX, toGPX, parseKML, toKML, parseGeoFile); src/components/modules/Maps.tsx; src/lib/open-with.ts",
    "Original code including a small strict XML reader: entity declarations are refused (no billion-laughs, no external entities), malformed XML is refused with a reason, out-of-range coordinates are skipped with a warning. Cross-checked both ways with gpxpy (GPX 1.0 and 1.1) and Python's xml.etree (KML) on hostile names. Bounds: one path is loaded into Measure (others are reported, not shown); KML polygon holes, gx:Track and styles are not imported (reported as warnings).",
    "built", "tt34-unit.mts ×3 (1 mutant caught); e2e-tt34.mts ×1"),
  F("SM-09", "SM", "Player transport in Video and Music: seek slider, −10 s / +10 s, volume, mute, playback speed and the provider's own playlist Prev / Next — on YouTube (all), Vimeo (all; speed only where the video's owner allows it), SoundCloud (seek + set next / prev) and native audio / video files (all); the volume, mute and speed shown are what the player REPORTS, never just what was asked",
    "A", "P2", "src/lib/embed-control-core.ts (capabilities, Command volume/mute/rate/next/prev, receive: YouTube infoDelivery, Vimeo volumechange / playbackratechange, SoundCloud getSounds); src/components/modules/Streams.tsx (fs-stream-transport)",
    "Original code against the providers' documented message APIs (YouTube IFrame API, Vimeo player.js, SoundCloud widget API). Honest boundaries: SoundCloud volume is NOT offered (its docs say 0–100 while public reports say 0–1, and a wrong guess is a blast or silence); Spotify (toggle only) and TIDAL (play / pause only) offer nothing more; Qobuz / Amazon / Dailymotion / Twitch / PeerTube have no control protocol. Verified against protocol fixtures — the provider hosts are unreachable from the sandbox, so the live players are not verified here.",
    "built", "tt34-unit.mts ×2 (1 mutant caught); e2e-tt34.mts ×3"),
  F("SM-10", "SM", "Player keyboard shortcuts while focus is in the player region: Space / K play·pause, J / L ±10 s, ← / → ±5 s, ↑ / ↓ volume, M mute, < / > speed, 0–9 jump to 0–90 %, Shift+N / Shift+P next / previous in the library — never while typing, never with Ctrl / ⌘ / Alt, sliders keep their own arrow keys",
    "A", "P3", "src/lib/embed-control-core.ts (keyAction, stepRate); src/components/modules/Streams.tsx (onKeys, aria-keyshortcuts)",
    "Original code; YouTube-style key map. Keys pressed while focus is INSIDE a provider's iframe go to that provider's own player (browsers do not let the page see them).",
    "built", "tt34-unit.mts ×1 (1 mutant caught); e2e-tt34.mts ×1"),
  F("SM-11", "SM", "Library order: Previous (retraces what was played, including shuffled picks), Shuffle (uniformly random, no repeats within a round, no back-to-back repeat across rounds with Loop list)",
    "A", "P3", "src/lib/stream-core.ts (prevIn, shuffleNext); src/components/modules/Streams.tsx",
    "Original code; uniformity checked with a χ² test (6 items × 6 000 draws).",
    "built", "tt34-unit.mts ×1 (1 mutant caught); e2e-tt34.mts ×1"),
];
