# TIDAL embed-player bridge — test fixture only

`message-bridge.js` and `url-options.js` are copied **unmodified** from TIDAL's open-source embed player
(https://github.com/tidal-music/embed-player, commit `0f4fb0fe60981189e5150632a8df6168f3247dc6`, 2026-06-08,
`src/client/js/`), licensed under the Apache License 2.0 (see `LICENSE` in this folder).

They are **not shipped** in Fusion (nothing under `src/` imports them). `scripts/e2e-tt33.mts` serves them inside
an intercepted `https://embed.tidal.com/…` page so that Fusion's own, independently written controller
(`src/lib/embed-control-core.ts`, ctl `"tidal"`) is exercised against TIDAL's real message handling instead of a
fixture we wrote ourselves. The real player (sign-in, DRM playback, TIDAL's servers) is not reachable from the
sandbox and is not part of this fixture.
