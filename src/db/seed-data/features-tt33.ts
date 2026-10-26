import { F, type SpecRow } from "./row";

/**
 * TT33 register changes: TIDAL, Qobuz and Amazon Music in the Video / Music players (asked for "with all functions of
 * a regular app"). What an embedding app can honestly offer is the provider's OWN player (sign-in, subscription
 * playback and DRM stay with the provider) plus Fusion's library / queue / controls around it. Full regular-app parity
 * (catalogue search, the user's own library, full tracks without the provider's player) needs partner API access
 * and the provider's SDK with the user's account — not available to an independent app, and not claimed.
 */
export const tt33Features: SpecRow[] = [
  F("SM-05", "SM", "TIDAL in Video and Music: tidal.com / listen.tidal.com / embed.tidal.com links for tracks, albums, playlists, videos and mixes (album…/track/… too) play in TIDAL's official embed player behind the click-to-load gate, at TIDAL's own sizes; two-way control over TIDAL's real postMessage bridge — Play / Pause from Fusion and the player's start signal (tagged with our player id) shown as status; library, queue and Next like every provider",
    "A", "P2", "src/lib/stream-core.ts (tidal grammar, sizes, allow, access note); src/lib/embed-control-core.ts (ctl \"tidal\": pid, frameLoaded, afterCommand, receive, command); src/components/modules/Streams.tsx (one-way controls, status text)",
    "Original code. The protocol was read from TIDAL's open-source embed player (Apache-2.0, @0f4fb0f), and the browser suite runs TIDAL's own bridge files unmodified (test fixture only) against Fusion's controller. Honest boundary: TIDAL's bridge reports only when playback STARTS — its media-status broadcast exists in the source but is never called — so pauses are shown as 'Pause sent', there is no progress clock, seek, volume or end signal, and Auto-next cannot follow a TIDAL item. Full tracks need a TIDAL subscription and signing in inside the player (otherwise 30-second previews). TIDAL's servers are unreachable from the sandbox: the real player loading and playing is not verified here.",
    "built", "tt33-unit.mts ×4 (incl. 2 mutants caught); e2e-tt33.mts ×2"),
  F("SM-06", "SM", "Qobuz in Music: widget.qobuz.com, open.qobuz.com, play.qobuz.com and qobuz.com store-page links for albums and tracks play in Qobuz's player widget (album 390 px; compact track), with the store page's zone carried over; library, queue, Open on Qobuz",
    "A", "P3", "src/lib/stream-core.ts (qobuz grammar, qobuzZone, sizes, access note)",
    "Original code; widget address shapes cross-checked with the EmbedVideo MediaWiki extension's tests (read for the facts, no code used). Honest boundary: Qobuz publishes no control protocol for the widget, so Fusion offers no Play/Pause/progress of its own — the widget's own controls are used; playlists and artists have no widget (refused with a link-out reason); the widget may play excerpts unless signed in to Qobuz; Qobuz's API needs a partner app id + user token, so no search or user library. Not reachable from the sandbox.",
    "built", "tt33-unit.mts ×3; e2e-tt33.mts ×1"),
  F("SM-07", "SM", "Amazon Music in Music: Amazon's own Share → Embed code (or its address) for albums, tracks, playlists and user playlists plays exactly as Amazon issued it (minus affiliate / tracking parameters); album / track (?trackAsin=) / playlist page links on 12 storefronts are turned into the same embed shape with the storefront's marketplace id; library, queue, Open on Amazon Music",
    "A", "P3", "src/lib/stream-core.ts (amazonMusic grammar, AMAZON_MUSIC_STORES, access note)",
    "Original code; marketplace ids from Amazon's SP-API documentation; the embed address shape from real Share → Embed snippets. Honest boundary: an address built from a page link lacks Amazon's opaque share id and is flagged 'unverified' in the UI (with the advice to paste Amazon's own embed code); Amazon's embed plays 30-second previews (reported even for subscribers); no control protocol, no search or library (Amazon's Music APIs are partner-only). Not reachable from the sandbox.",
    "partial", "tt33-unit.mts ×3; e2e-tt33.mts ×1"),
  F("SM-08", "SM", "Player conveniences: paste any provider's <iframe> embed code (only its src is read), SoundCloud widget addresses (api.soundcloud.com tracks / playlists), and one player at a time — starting playback in any Video or Music window pauses the others (embeds through their control protocol, native audio/video directly)",
    "A", "P3", "src/lib/stream-core.ts (embed-code reduction, SoundCloud widget); src/components/modules/Streams.tsx (fusion-media-exclusive)",
    "Original code. Hostile snippets (srcdoc, javascript:, http:) are refused; data-src is not mistaken for src. Exclusive playback covers players that report a start (YouTube, Vimeo, SoundCloud, Spotify, TIDAL, native files); a provider without a control protocol (Qobuz, Amazon, Dailymotion, Twitch, PeerTube) can be paused only by its own controls.",
    "built", "tt33-unit.mts ×2; e2e-tt33.mts ×3"),
];
