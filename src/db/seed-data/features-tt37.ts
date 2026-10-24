import { F, type SpecRow, type Status } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test">> & { status: Status };

/**
 * TT37 register changes: the Private proxy gets an UPSTREAM ROUTE — Fusion's server can reach the web through Tor
 * or any SOCKS5 / HTTP proxy, with no local DNS and per-session circuit isolation. This is the code-level answer to
 * networks that filter direct egress (as this sandbox does): written from RFC 1928 / 1929 / 9110, no library.
 */
export const tt37Features: SpecRow[] = [
  F("WP-07", "PR", "Network route for the Private proxy: Direct, Tor (SOCKS5) or any SOCKS5 / HTTP CONNECT proxy — tested before use, applied server-wide, names resolved by the proxy (no DNS leak, .onion through Tor), per-tab / per-profile circuit isolation and 'New circuit'",
    "A", "P2", "src/lib/server/wp-tunnel.ts (parseRoute, openTunnel: SOCKS5 + RFC 1929, HTTP CONNECT; isolationCredentials; tunnelHostVerdict); src/lib/server/wp-route.ts; src/lib/server/wp-fetch.ts (tunnelRequest); src/lib/server/pinned-http.ts; /api/wp-route; src/components/modules/NetworkRoute.tsx; ProxyFrame (wp-circuit, wp-via)",
    "Original code from the protocol documents. Verified independently: handshake bytes identical to curl's (SOCKS5 greeting methods, RFC 1929 login, CONNECT; HTTP CONNECT line, Host, Proxy-Authorization); real pages (pypi.org, github.com) carried by pproxy (MIT, an independent server), whose log shows names arriving — Fusion resolves nothing itself; IPv6 encoding equal to Python's ipaddress. 14 hostile / broken proxy behaviours fail fast (< 2.5 s) as 'network route' errors; a destination that is not TLS is not blamed on the route. Everything server-side follows the route (proxy tabs, reader, embed probe). SSRF guard kept without local DNS (private literals, local / single-label / internal names refused before the proxy is contacted). 5 source mutants caught (one was the real bypass found while building: Node's agent:false silently ignored the tunnel). Kept in RAM (FUSION_WP_UPSTREAM for a permanent route). Not observable here: real Tor — no Tor binary and no egress to relays in this sandbox — so 'separate circuits' rests on Tor's documented IsolateSOCKSAuth (we verify each session sends distinct credentials), and the sites the user named (yahoo, soundcloud) stay unreachable from this sandbox even through a route, because the route's own egress is filtered.",
    "built", "tt37-unit.mts ×7; e2e-tt37.mts ×4"),
];

export const UPDATES_TT37: Record<string, Patch> = {
  "IN-07": {
    status: "built",
    route: "src/lib/gamepad-pointer.ts (shapeStick, step — pure mapping); src/components/GamepadPointer.tsx (shell-wide host, rAF only while a pad is connected and the tab visible); Devices → Gamepad (live axes / buttons, pointer-mode help and toggle)",
    nuance: "W3C 'standard' mapping: left stick moves the pointer (radial deadzone 0.15, power curve 2.2, 1400 px/s at full deflection, frame-rate independent, dt capped at 100 ms), d-pad nudges 1 px with auto-repeat (350 ms, then every 45 ms), A clicks (focus follows), X right-clicks, B is Escape, LB / RB move keyboard focus and the pointer jumps to the focused control, right stick scrolls the box under the pointer (sub-pixel carry, so slow scrolling is never lost), Start toggles the mode (a press is released when the mode turns off — no stuck buttons, no stray clicks). Non-standard pads get stick, A and B. Limits: synthetic events cannot enter cross-origin / sandboxed frames (embedded players, Private proxy pages); native <select> pop-ups do not open; window dragging is not mapped. Verified: the mapping with exact numbers (tt37-unit); the whole host in Chromium with a scripted pad of the W3C shape — no physical controller exists in this sandbox, so real-hardware behaviour (drift, vendor quirks) is unobserved.",
    test: "tt37-unit.mts ×2; e2e-tt37.mts ×1",
  },
};
