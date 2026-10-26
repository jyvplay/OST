import { F, type SpecRow } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test" | "status">>;

/**
 * TT28 register changes. The user asked for original code (written here, not borrowed) that removes the specific
 * blockers left by TT27: embeds that could not auto-advance, no place-name search, window.prompt dialogs, no Snap
 * layouts in Business, no dock auto-hide / minimise effect in Art, and no screen-reader structure test.
 */
export const tt28Features: SpecRow[] = [
  F("SM-04", "SM", "Two-way player control: the Video / Music window talks to the YouTube, Vimeo and SoundCloud embed players over their documented postMessage interfaces — play / pause from our controls, a live position clock, and 'ended' drives Auto-next / Loop list through the library",
    "A", "P2", "src/lib/embed-control-core.ts (handshake, message parsing, command encoding, per-provider state); src/components/modules/Streams.tsx control row",
    "Written from the providers' public message formats (YouTube widget 'listening' / infoDelivery, Vimeo addEventListener / ended, SoundCloud widget method/value); no provider SDK script is loaded. Messages are accepted only from the iframe's own window and the provider's exact origin. Spotify's embed exposes no public message API, so Spotify rows play but cannot auto-advance — stated in the UI. The sandbox cannot reach the real players, so tests drive same-protocol fixture players: verified protocol handling, not live provider playback.",
    "built", "stream-unit.mts 'embed control protocol (TT28)…'; e2e-tt28.mts 'SM-04 …' ×2"),
  F("MP-04", "MP", "Offline place-name search: type a city (any of the 26 435 with ≥ 15 000 people, accent- and case-insensitive, alternate names, 'Paris, TX' style qualifiers) and the map flies there with a card showing population, time zone and coordinates; 'Save as place' keeps it",
    "A", "P2", "src/lib/gazetteer-core.ts (own TSV parser, folding, ranking); src/lib/server/gazetteer.ts; /api/places/search; Maps.tsx search list + found card",
    "Data: GeoNames cities15000 (CC BY 4.0, attributed on the map) shipped by the MIT-licensed cities-15000-structured package; the parser, index and ranking are our own. Runs entirely on this server — nothing is sent to an online geocoder. City level only: no street addresses and no routing.",
    "built", "maps-unit.mts 'gazetteer (TT28)…'; e2e-tt28.mts 'offline gazetteer (MP-04/MP-05)…'"),
  F("MP-05", "MP", "Reverse lookup: new places are named after the nearest city ('Raleigh', or '12 km NE of Raleigh'), and resting the pointer on the map says where you are",
    "A", "P2", "src/lib/gazetteer-core.ts nearest (grid ring search with a haversine lower bound); /api/places/near; Maps.tsx addAt / hover",
    "Nearest search is exact (checked against brute force on 400 random points). Names within 25 km; farther points say 'N km <dir> of <city>'. A name you type is never overwritten by a late lookup.",
    "built", "maps-unit.mts 'gazetteer nearest (TT28)…'; e2e-tt28.mts 'offline gazetteer (MP-04/MP-05)…'"),
  F("SH-15", "SH", "In-app ask dialog replaces every window.prompt — none remain; 25 call sites (new file / folder, rename, sheet name, image size, vault entry, encryption passphrase…): themed, keyboard-complete, validates in place, masks secrets with a Show toggle, and queues safely",
    "A", "P1", "src/lib/ask.ts (askForm / askText store); src/components/AskHost.tsx; call sites in Files, DesktopSurface, Editor, ImageStudio, ImageQuickEdit, Media, Routines, Spreadsheet, Streams, Vault, Tabletop",
    "Native prompt() blocks the whole page, cannot be styled or validated and is suppressed by some browsers. The dialog is aria-modal with a Tab trap, Esc cancels and focus returns to the opener; shell shortcuts are blocked while it is open. Secret fields use autocomplete=off. confirm() / alert() stay native (one-click, no input).",
    "built", "tt28-unit.mts 'ask store…'; e2e-tt28.mts 'ask dialog (SH-15)…'; e2e-image.mts 'Export PNG … Image size dialog…'"),
  F("LY-16", "LY", "Snap layouts (Business): hover a window's Maximise button (or Win+Z) for a flyout of layouts — halves, two-thirds, three columns, half + quarters, quarters, and quarter-half-quarter on wide screens — and click a zone to place the window exactly",
    "A", "P2", "src/lib/snap-core.ts SNAP_LAYOUTS / zoneRect / layoutsFor; src/components/SnapHost.tsx flyout; windowing 'place' command; shortcuts snapLayouts",
    "Zones tile the desk exactly (no gaps or overlaps, checked on 2 000 random desk sizes). Keyboard: Win+Z (Ctrl+Alt+Z on a Mac keyboard) focuses the flyout; arrows move, Enter places. Business layout only — Art keeps macOS-style behaviour.",
    "built", "tt28-unit.mts 'snap layouts tile the desk exactly…'; e2e-tt28.mts 'Business Snap (LY-16/LY-17)…'"),
  F("LY-17", "LY", "Edge snapping with preview and Snap Assist: drag a window to a corner (quarter) or side (half) and a preview shows where it will land; after snapping, the remaining zones offer your other windows to fill them",
    "A", "P2", "src/lib/snap-core.ts dragTarget / assistPlan; WindowFrame.tsx drag; SnapHost.tsx preview + assist",
    "Releasing mid-screen never snaps. Assist lists only windows on the current workspace, in reading order; 'Not now' or Esc dismisses it.",
    "built", "tt28-unit.mts 'drag targets…', 'Snap Assist plan…'; e2e-tt28.mts 'Business Snap (LY-16/LY-17)…'"),
  F("LY-18", "LY", "Dock auto-hide (Art): the dock slides off-screen so windows can use the full height; pointing at the bottom edge or tabbing to it brings it back, and it hides again after a short delay",
    "A", "P2", "src/components/Dock.tsx reveal strip + timers; setting appearance.dockAutoHide (Display settings)",
    "Reveal strip: the bottom 4 px. Off by default. Keyboard and screen-reader users are not locked out: focus inside the dock reveals it. Hide delay ≈ 0.6 s after the pointer leaves.",
    "built", "e2e-tt28.mts 'Art dock (LY-18/LY-19)…'"),
  F("LY-19", "LY", "Minimise effect (Art): a minimising window pours into its dock tile in a genie-style funnel",
    "A", "P3", "src/lib/genie-core.ts keyframes; src/components/genie.ts (Web Animations clip-path ghost); WindowFrame.tsx",
    "An honest approximation: a trapezoid clip-path funnel of a snapshot, not macOS's mesh warp. Skipped entirely under reduced motion or Motion: off.",
    "built", "tt28-unit.mts 'genie keyframes…'; e2e-tt28.mts 'Art dock (LY-18/LY-19)…'"),
  F("AX-13", "AX", "Accessibility-tree checks: the live page's accessibility tree (what a screen reader announces) is snapshotted in Fusion, Business and Art — windows are named dialogs, the dock / taskbar are exposed, no button or field is unnamed, and the ask dialog and Snap flyout expose roles and names",
    "A", "P2", "scripts/e2e-tt28.mts (Playwright ariaSnapshot)",
    "This reads Chromium's accessibility tree; it is NOT a test with a real screen reader (NVDA / JAWS / VoiceOver are not available in this sandbox), so speech output and reading order in those products remain unverified.",
    "built", "e2e-tt28.mts 'accessibility tree (AX-13)…'"),
];

export const UPDATES_TT28: Record<string, Patch> = {
  "MP-02": {
    nuance: "RFC 7946 output ([lng, lat], simplestyle marker-color) so other GIS tools read it; imports keep Points and drop other geometry. Since TT28 the search also finds cities offline (MP-04); street-address geocoding is still not offered (that needs an online geocoder such as Nominatim, whose policy forbids bulk/automatic use).",
  },
};
