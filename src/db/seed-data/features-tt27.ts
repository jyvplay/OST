import { F, type SpecRow } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test" | "status">>;

/**
 * TT27 register changes (user request: a slanted default Tabletop camera with the floor ≥ 80 % of the view, walls
 * that take pins and piles like the floor, saved Tabletop views, colour-scheme beauty checks, a mostly silver Art look
 * and a mostly light Business look, and video / music streaming and maps from open, permissive code).
 */
export const tt27Features: SpecRow[] = [
  F("LY-11", "LY", "Slanted Tabletop camera (default): the box is seen like a desk from a seated viewer — floor tilted 38° in true CSS 3D, a far wall band, slim side walls and a near lip — with the floor covering ≥ 80 % of the view at every screen size; a Camera button switches to the straight-down view and back (persisted per desk)",
    "A", "P2", "src/lib/tabletop-slant.ts slantGeometry / fitSlant (perspective, floor depth, wall and lip heights solved by bisection); src/components/Tabletop.tsx camera; DesktopState.table.camera",
    "Coverage is computed from the projected floor polygon clipped to the frame minus the part hidden by the lip, and independently measured in the browser by hit-sampling 1440 points (e2e). Floor hits map screen → floor through an exact plane homography, so drag-and-drop lands where the pointer is. The near lip is ≥ 24 px (WCAG 2.5.8). Side walls are slivers by design at this tilt (≈ 1.3 % each); open them from the switcher or double-click.",
    "built", "tabletop-unit.mts 'slanted camera (default)…', 'slanted camera maths…'; e2e-tabletop.mts 'slanted camera is the default…'"),
  F("LY-12", "LY", "Walls are pinboards: drag any card or whole pile from the floor onto a wall (or 'Pin to the … wall' from the card menu / Shift+F10) to pin it; an opened wall shows its built-in panel beside a pinboard where pins move freely, pile up, fan out and come back to the table; a wall in box view shows a count and chips of what is pinned",
    "A", "P2", "src/lib/tabletop-core.ts normalizeTable v2 / moveToSurface / surfacePaths / freeSlot, generic pile ops over any board; Tabletop.tsx pinboards + wallUnder drop targets",
    "Unlimited pins (bounded only by the files that exist; each file lives on exactly one surface — walls first on conflicts). v1 tables migrate unchanged. Pins are by VFS path, so trashed files drop out. Keyboard path for every pointer action (WCAG 2.5.7).",
    "built", "tabletop-unit.mts 'walls as pinboards…'; e2e-tabletop.mts 'walls are pinboards…', 'wall piles by menu…'"),
  F("LY-13", "LY", "Saved Tabletop views: name and save the current arrangement (floor, every wall's pins and piles, the camera and the open face), load one to jump back, rename or delete; up to 12 per desk, stored with the desk state",
    "A", "P2", "src/lib/tabletop-core.ts saveView / loadView / renameView / deleteView / MAX_VIEWS; Tabletop.tsx Views popover",
    "A view is a snapshot (later moves do not change it). Loading re-validates against the files that exist now; files created since land on the floor. Same name updates in place.",
    "built", "tabletop-unit.mts 'saved tabletop views…'; e2e-tabletop.mts 'saved tabletop views…'"),
  F("LY-14", "LY", "Silver and Daylight styles paired with the layouts: Art switches to Silver (bright silver glass, satin squircle icons with vivid glyphs, system blue, macOS traffic lights) and Business to Daylight (airy white Mica surfaces, acrylic tiles with Windows-style colour glyphs, Windows blue), both in the light theme; 'Match the look to the layout' turns the pairing off",
    "A", "P2", "src/lib/style-core.ts SILVER / DAYLIGHT; AppIcon.tsx satin / acrylic finishes; public/wallpapers/silver.svg, daylight.svg; layout-core pairedSettings; settings appearance.pairStyle",
    "Original artwork and palettes evoking, not copying, Apple's and Microsoft's light appearances. Every token passes the same WCAG checks as the other 11 styles; 'mostly silver / light' is measured from screenshots (≥ 55 % light near-neutral pixels).",
    "built", "a11y-unit.mts 'style system…'; tabletop-unit.mts 'colour beauty core…'; e2e-media27.mts 'layout ↔ style pairing…'; e2e-beauty.mts 'colour schemes…'"),
  F("LY-15", "LY", "Colour-scheme beauty checks: every style × theme is screenshotted live and measured in OKLCH — hard rules: axe colour-contrast clean and the light-intent of Silver / Daylight; reported: harmony-template fit, hue entropy and the 60-30-10 area split — written to docs/COLOUR-REPORT.md",
    "A", "P2", "src/lib/colour-beauty-core.ts; scripts/e2e-beauty.mts colour test; docs/COLOUR-REPORT.md",
    "Hard rules are WCAG 2.2 (still normative in Oct 2026; WCAG 3's contrast method is undecided, APCA withdrawn) plus the user's stated intent. Harmony / complexity / 60-30-10 are descriptive: large studies (TVCG 2025) find harmonised palettes are not reliably preferred.",
    "built", "tabletop-unit.mts 'colour beauty core…'; e2e-beauty.mts 'colour schemes…'"),
  F("SM-01", "SM", "Video player: paste a YouTube (watch, youtu.be, Shorts, live, playlists, start times), Vimeo (incl. unlisted), Dailymotion, Twitch (channels, VODs, clips), PeerTube or direct video link and it plays in the provider's official embed player, or the native player for files",
    "A", "P2", "src/lib/stream-core.ts parseStream; src/components/modules/Streams.tsx (Video.tsx); registry 'video'",
    "No scraping, proxying or bundled provider code: the provider's own player in a sandboxed iframe (no top navigation). Click-to-load privacy gate: nothing is sent to a provider until you choose (or set 'always load'). YouTube embeds need a Referer since 2025 ('Error 153'), so the iframe sends the origin only (strict-origin-when-cross-origin) while the site keeps no-referrer. Playback itself is NOT verified from this sandbox (provider hosts unreachable): tests prove the request, its Referer and attributes. Embeds do not report 'ended', so Next is manual for them (automatic for files).",
    "built", "stream-unit.mts 'YouTube…', 'Vimeo, Dailymotion, Twitch…', 'time parsing…'; e2e-media27.mts 'Video: privacy gate…'"),
  F("SM-02", "SM", "Music streaming: Spotify (tracks, albums, playlists, artists, shows, episodes; open.spotify.com links incl. intl paths, spotify: URIs) and SoundCloud (tracks, sets) through their official embed players, plus direct audio links",
    "A", "P2", "src/lib/stream-core.ts parseStream / soundcloudEmbed / playerHeight / iframeAllow; Streams.tsx (Music.tsx); registry 'music'",
    "Spotify's embed plays full tracks only when the user is signed in to Spotify in the browser, otherwise 30-second previews — stated before loading. Short on.soundcloud.com links redirect server-side and cannot be resolved offline; the app says so. Playback not verified from this sandbox (hosts unreachable).",
    "built", "stream-unit.mts 'Spotify + SoundCloud…'; e2e-media27.mts 'Music: Spotify…'"),
  F("SM-03", "SM", "Streams library: save links to /Documents/Streams.json (shared by Video and Music), filter, reorder, rename, remove, play from the list, Next / loop through the queue; re-saving the same player moves it to the top",
    "A", "P2", "src/lib/stream-core.ts addToLibrary / normalizeLibrary / filterLibrary / moveInLibrary / nextIn",
    "Plain JSON in the user's files (portable, versioned by the VFS). Defensive load: rows whose links no longer parse are dropped, duplicates collapse, cap 500.",
    "built", "stream-unit.mts 'library…'; e2e-media27.mts 'Video: privacy gate…' (save, reload, Next)"),
  F("MP-01", "MP", "Maps: an offline world map (Natural Earth admin-0 borders via world-atlas, drawn by Leaflet on canvas) that works with no network; optional OpenStreetMap street tiles or any https {z}/{x}/{y} tile server; scale bar, keyboard pan/zoom, theme-aware colours",
    "A", "P2", "src/components/modules/Maps.tsx; leaflet 1.9.4 (BSD-2-Clause), world-atlas 2.0.2 (ISC; data public domain), topojson-client 3.1.0 (ISC); settings maps.tiles / maps.tileUrl",
    "Street tiles are opt-in because tile.openstreetmap.org sees your IP and viewed area, and its usage policy is for light use (heavy use needs your own provider). Tile requests carry an origin-only Referer as the OSM policy requires. Tiles are not prefetched or cached by us. Tile rendering from OSM itself is not verified here (host unreachable); requests and attribution are.",
    "built", "maps-unit.mts 'point-in-polygon … country lookup'; e2e-media27.mts 'Maps offline…', 'Maps street tiles are opt-in…'"),
  F("MP-02", "MP", "Map search and places: search countries (accent-insensitive), saved places or pasted coordinates (decimal, DMS, N/S/E/W, geo: URIs, OpenStreetMap and Google Maps links) and fly there; hover shows coordinates and the country; add places by clicking (or at the map centre), name, note and colour them; stored as GeoJSON in /Documents/Places.geojson, import/export .geojson, Files opens .geojson in Maps",
    "A", "P2", "src/lib/maps-core.ts parseLatLng / formatLatLng / searchFeatures / featureAt / normalizePlaces / placesToGeoJSON; Maps.tsx; open-with .geojson",
    "RFC 7946 output ([lng, lat], simplestyle marker-color) so other GIS tools read it; imports keep Points and drop other geometry. No address geocoding (that needs an online geocoder such as Nominatim, whose policy forbids bulk/automatic use) — named places are countries and your own places.",
    "built", "maps-unit.mts 'coordinates…', 'places…'; e2e-media27.mts 'Maps places + measure…', 'Maps offline…'"),
  F("MP-03", "MP", "Measure and locate: click points to measure a great-circle path (haversine, metric or imperial, first-leg bearing), distance from the map centre to a place, and 'Locate me' via the browser's Geolocation API",
    "A", "P2", "src/lib/maps-core.ts haversine / pathLength / bearing / formatDistance; Maps.tsx",
    "Mean Earth radius 6371.0088 km (≈ 0.5 % error vs ellipsoidal routes). Geolocation needs the user's permission and a secure context; denial is reported, never faked. Routing/turn-by-turn is not offered.",
    "built", "maps-unit.mts 'geodesy…'; e2e-media27.mts 'Maps places + measure…'"),
];

export const UPDATES_TT27: Record<string, Patch> = {};
