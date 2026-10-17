import { F, type SpecRow } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test" | "status">>;

/**
 * TT29 register changes. Blockers removed with original code: Spotify rows could not be controlled or auto-advance
 * (SM-04), and the Tabletop's foreshortened walls rendered unreadable, squashed text and were too thin to aim at
 * (found by screenshot review; LY-20 / LY-21).
 */
export const tt29Features: SpecRow[] = [
  F("LY-20", "LY", "Tabletop legibility level of detail: a wall too foreshortened to read shows its pinned items as shapes only, and a flat, legible tag at the wall's visible centre names it with live counts ('Windows · 1 open', 'Widgets · 3 pinned'); the tag opens the wall on click and is a drop target for pinning, so thin side walls no longer need precise aim",
    "A", "P2", "src/lib/tabletop-slant.ts faceScale / wallLegibility / boxQuads / boxLegibility; src/components/Tabletop.tsx glyph faces + wall tags (avoid the switcher)",
    "Rule: detail only if the face's minimum linear scale (smallest singular value of the plane homography's Jacobian, sampled at corners + centre) is ≥ 0.6 and its projected extent ≥ 96 px. Applies to both cameras; with the default room proportions every wall falls below it, so in practice all four show glyphs + tags in the overview (opened walls are full size and fully detailed). Side tags are vertical spines; on phones the side sliver is thinner than a 24 px target, so the spine overlaps the floor edge. Tags are pointer conveniences marked aria-hidden; keyboard and screen readers keep the 'Open the … wall' buttons and the switcher.",
    "built", "tt29-unit.mts ×4; e2e-tt29.mts 'wall tags…', 'wall tags are the click AND drop targets…', 'straight-down camera obeys the same rule…'"),
  F("LY-21", "LY", "Beauty rule 'no squashed text': every visible text on the Tabletop must render at an effective size ≥ 9 px (computed font size × its measured projected scale), in both cameras, at desktop and phone sizes",
    "A", "P2", "scripts/e2e-tt29.mts textScales (per element: getBoundingClientRect ÷ layout size × computed font size)",
    "Measured result: smallest text 10.6 px (1440×900 slanted), 10.8 px (390×800), 13.5 px (top-down; was 3.2 px before LY-20). Decorative aria-hidden miniatures (card content peeks) are excluded and counted in the log. The bounding-box ratio overestimates scale under in-plane rotation, so it is lenient for rotated text; foreshortening (the actual defect) is caught.",
    "built", "e2e-tt29.mts 'beauty rule no squashed text…', 'straight-down camera obeys the same rule…'"),
];

export const UPDATES_TT29: Record<string, Patch> = {
  "SM-04": {
    name: "Two-way player control: the Video / Music window talks to the YouTube, Vimeo, SoundCloud and Spotify embed players over their postMessage interfaces — play / pause from our controls, a live position clock, and 'ended' drives Auto-next / Loop list through the library",
    route: "src/lib/embed-control-core.ts (handshake, message parsing, command encoding, per-provider state, spotifyEnded); src/components/modules/Streams.tsx control row",
    nuance: "Written from the providers' public message formats (YouTube 'listening' / infoDelivery, Vimeo addEventListener / ended, SoundCloud method/value, Spotify embed 'ready' / 'playback_update' objects); no provider SDK script is loaded. Messages are accepted only from the iframe's own window and the provider's exact origin. Spotify (TT29): play / pause use the embed's 'toggle' command (confirmed by two independent public reports) and are sent only when the reported state differs; the clock follows playback_update; Spotify sends no 'ended', so the end is inferred (paused within 0.5 s of the end, or rewound after the last second) and Auto-next then asks the next Spotify player to play. Limits: no seek or volume for Spotify; the load acknowledgement string is unconfirmed (sent best-effort, nothing depends on it); without a signed-in Premium account Spotify plays 30-second previews (provider restriction, not bypassed). All four providers are verified against local fixture players only — the real hosts are not reachable from the test sandbox.",
    test: "stream-unit.mts 'embed control protocol (TT28)…', 'Spotify embed control (TT29)…'; e2e-tt28.mts 'SM-04 …' ×2 (Spotify section in the second)",
  },
  "LY-11": {
    nuance: "Coverage is computed from the projected floor polygon clipped to the frame minus the part hidden by the lip, and independently measured in the browser by hit-sampling 1440 points (e2e). Floor hits map screen → floor through an exact plane homography, so drag-and-drop lands where the pointer is. The near lip is ≥ 24 px (WCAG 2.5.8). Side walls are slivers by design at this tilt (≈ 1.3 % each); since TT29 every foreshortened wall carries a legible tag that opens it and accepts drops (LY-20), besides the switcher and double-click.",
  },
};
