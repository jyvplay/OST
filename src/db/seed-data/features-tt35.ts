import { F, type SpecRow, type Status } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test">> & { status: Status };

/**
 * TT35 register changes: the Browser gets a private, same-origin web proxy ("Private proxy" tabs). Every byte of a
 * proxied page comes through the Fusion server, which rewrites the page so it keeps working (links, forms, CSS,
 * images, scripts' fetch / XHR / history), keeps cookies in a per-tab in-memory jar, blocks trackers, sends one
 * identity for everyone, and serves the page into an opaque-origin CSP sandbox so it can never touch the desktop.
 * All original code; Ultraviolet / Scramjet / Rammerhead (AGPL or GPL-compatible-only) were read for ideas only.
 */
export const tt35Features: SpecRow[] = [
  F("WP-01", "PR", "Private proxy rewriting: a proxied page keeps working — links, forms, redirects, <base>, srcset, CSS url() / @import, inline styles, meta refresh, and at run time fetch / XHR / history.pushState / window.open / element URL setters — while every URL it uses points back through Fusion",
    "A", "P2", "src/lib/wp-core.ts (encodeTarget / decodeTarget, rewriteUrl, rewriteSrcset, rewriteCss, rewriteHtml); public/wp-shim.js (in-page runtime); src/app/api/wp/s/[sid]/[...rest]/route.ts",
    "Path-preserving scheme /api/wp/s/<session>/<scheme>/<host[:port]><path> so a page's own relative URLs resolve inside the proxy without help. Measured: 4 real pages fetched live (github.com ×2, pypi.org ×2) — 1 817 URL-bearing attributes pointing outside before, 0 after (walked by Python's html.parser as an independent oracle); the runtime encodes a 400-URL corpus identically to the server. In the real browser pypi.org renders with its own fonts / colours / images (120+ requests, NONE to any host but Fusion); github.com's HTML renders (title, README) but unstyled, because this sandbox's egress filter blocks GitHub's asset CDN (github.githubassets.com, avatars.githubusercontent.com) — the toolbar names those hosts. A same-origin fetch the site makes to itself is translated to CORS (the opaque origin could never meet same-origin); to another site it still fails, as natively. Limits: JavaScript that builds URLs from location.origin, WebSockets and service workers are not proxied; sites with bot challenges (pypi's Fastly challenge on /search/ for this sandbox's address) show their challenge — Fusion does not solve or evade it.",
    "built", "tt35-unit.mts ×5; e2e-tt35.mts ×2"),
  F("WP-02", "PR", "Private proxy isolation: proxied pages run in an opaque-origin CSP sandbox (top-level or framed) that cannot read the desktop's API or storage; the server refuses loopback / private / metadata targets (SSRF), unknown sessions, decompression bombs and over-size bodies, and names network failures in plain words",
    "A", "P2", "src/app/api/wp/s/[sid]/[...rest]/route.ts (documentCsp, error page); src/lib/server/wp-fetch.ts (byte caps, gunzip / brotli caps); src/lib/server/netguard.ts",
    "CSP 'sandbox' without allow-same-origin on every proxied document makes its origin \"null\" even when opened directly; default-src is limited to Fusion's own origin so nothing can be fetched around the proxy. Verified with the in-page runtime WITHHELD (a hostile page): reading /api fails and a CSRF write to /api/fs leaves no file, top-level and inside the Browser. SSRF: 127.0.0.1, ::1, 10/8, 169.254.169.254, localhost names refused before connecting. A 64 MB zero-bomb gzipped to ~64 KB stops at the 8 MB cap (RSS +0.2 MB). yahoo.com / soundcloud.com are attempted for real: this sandbox's egress filter cuts the TLS handshake, and the tab says 'Could not reach … firewall or egress policy … not that the site is down'.",
    "built", "tt35-unit.mts ×3; e2e-tt35.mts ×4"),
  F("WP-03", "PR", "Private proxy privacy hygiene: the site never sees the user's address, cookies of other sites, referrer path, real browser identity or client hints; shared Desktop identity by default with an explicit host-scoped Desktop/Mobile override; fixed language; Sec-GPC; tracker hosts are answered locally (Shields counter, per-host list); nothing is cached or written to disk",
    "A", "P2", "src/lib/wp-core.ts (upstreamHeaders, downstreamHeaders, isTracker); src/components/modules/ProxyFrame.tsx (Shields and host-scoped identity)",
    "Upstream drops the user's cookie, origin, referer, actual user-agent, language, forwarding / proxy headers and every sec-* client hint, then supplies a fixed Desktop identity by default. PR-07h allows an explicit per-host choice between two shared Desktop/Mobile strings, held only in the proxy session's RAM; the site never receives the real device UA or client hints. Language and Sec-GPC remain fixed. Downstream is an ALLOW-list — only content headers named by Fusion pass (no Set-Cookie, CSP / XFO, HSTS, Alt-Svc, Report-To / NEL, Server-Timing); Content-Disposition is sanitised. Tracker matching is by host and parent domain (look-alikes do not match). Bounds: the egress address is the Fusion server's; a site can still fingerprint by JavaScript inside the page (canvas, fonts) — same as any browser without anti-fingerprinting.",
    "built", "tt35-unit.mts ×1; e2e-tt35.mts ×1"),
  F("WP-04", "PR", "Private proxy sessions + cookie jar: each tab is its own private profile — cookies follow RFC 6265 (host-only / Domain, path, Secure, Max-Age, HttpOnly hidden from scripts, __Secure- / __Host-, public-suffix refusal) in a per-tab in-memory jar; Clear cookies; sessions expire after 30 idle minutes and are deleted when the tab closes",
    "A", "P2", "src/lib/wp-core.ts (CookieJar); src/lib/server/wp-sessions.ts; src/app/api/wp-session/route.ts; src/components/modules/Browser.tsx (session per tab, DELETE on close)",
    "Session ids are 128-bit capabilities (the only key); the store is capped with least-recently-used eviction. In the real browser: a cookie set by a page survives reload and navigation inside its tab, a second tab on the same site never sees it, Clear cookies empties the jar, and closing the tab deletes the server session. Sessions are never persisted (a server restart forgets all).",
    "built", "tt35-unit.mts ×2; e2e-tt35.mts ×1"),
  F("WP-05", "PR", "Browser integration of the private proxy: 'Private proxy: all tabs' toggle (remembered per window) and proxy mode per tab; a proxy toolbar with Back / Forward / Reload, find in page with match count and stepping, per-site Identity (Desktop default / Desktop or Mobile override), Shields, Cookies and Unreachable-hosts indicators (which hosts failed and why), Clear cookies and Save to Files; the address bar and tab title follow the page",
    "A", "P2", "src/components/modules/ProxyFrame.tsx; src/components/modules/Browser.tsx (br-proxy-all, proxied tabs)",
    "History is kept by Fusion (the page's own history API stays inside the frame); messages are accepted only from the tab's own frame window. Save to Files fetches the ORIGINAL bytes through the session (__raw: an attachment with a sandbox CSP, never renderable on Fusion's origin) into /Downloads. Find recomputes after the page changes. Verified on pypi.org: search form → site answer, link → Back → Forward with the address following, Find selects matches, the page shim follows the host's Desktop/Mobile choice, and Save writes original HTML. The selected host's HTTP header construction is covered by tt35-unit.mts.",

    "built", "e2e-tt35.mts ×3"),
  F("WP-06", "PR", "CSRF guard for the desktop's API: state-changing requests (POST / PUT / PATCH / DELETE) are accepted only from the desktop itself or a non-browser client — refused from other sites, sibling subdomains and sandboxed / proxied pages (Origin: null)",
    "A", "P1", "src/proxy.ts (csrfVerdict from src/lib/wp-core.ts)",
    "Uses Sec-Fetch-Site where sent, else Origin against the request's own host (and the forwarded host behind the preview proxy). Proxy-session paths and safe methods are never blocked. Closes the gap where a text/plain form or fetch from any page could reach JSON routes.",
    "built", "tt35-unit.mts ×1; e2e-tt35.mts ×1"),
];

export const UPDATES_TT35: Record<string, Patch> = {
  "PR-07h": {
    tier: "A", route: "ProxyFrame host selector → PATCH /api/wp-session {site, ua|clearSiteUa}; wp-sessions.ts (64-host RAM map); HTTP route, wp-ws.ts and public/wp-shim.js (target-host identity)",
    nuance: "Bounded private-proxy identity only: Desktop is the per-host default; a Desktop/Mobile override follows the target host for upstream HTTP and WebSockets and the page's navigator.userAgent/platform/maxTouchPoints. Overrides are in session RAM only, max 64 hosts. Client hints and navigator.userAgentData are withheld. Direct embeds and reliable physical display/keyboard detection are outside the browser contract.",
    status: "built", test: "tt85-identity.mts ×5; tt35-unit.mts; tt38-unit.mts (real target-host handshake); e2e-tt85.mts E3 (live Chromium/PyPI); e2e-tt35.mts identity regression passed; full proxy suite 6/7 with unrelated GitHub egress timeout",
  },

  "PR-07n": {
    tier: "A", route: "src/components/modules/ProxyFrame.tsx (wp-find); public/wp-shim.js (find)",
    nuance: "Works in Private proxy tabs: count, next / previous (Shift+Enter), the match selected and scrolled into view; recomputed when the page changes. Directly embedded cross-origin pages remain unsearchable (the honest limit is shown there).",
    status: "partial", test: "e2e-tt35.mts ×1",
  },
  "PR-07m": {
    route: "fetch → VFS write when CORS permits; Private proxy tabs: Save to Files (original bytes via the session) → /Downloads",
    nuance: "Downloads land in the VFS. In a Private proxy tab Save to Files stores the page's original bytes (not the rewritten copy) in /Downloads. Files a page itself offers for download inside a sandboxed frame go to the browser's own download folder.",
    status: "partial", test: "e2e-tt35.mts ×1",
  },
  "PR-07o": {
    tier: "A", route: "src/lib/server/wp-sessions.ts; src/components/modules/Browser.tsx (one proxy session per tab)",
    nuance: "Private proxy tabs are isolated profiles: each tab has its own cookie jar, deleted when the tab closes (verified: a cookie set in one tab is invisible to another tab on the same site). Not yet: named, reusable profiles shared by several tabs; directly embedded pages still share the browser's partitioned storage.",
    status: "partial", test: "e2e-tt35.mts ×1",
  },
  "PR-07p": {
    route: "CSP sandbox + blocklist for our own fetches; Private proxy tabs: tracker hosts answered locally (Shields)",
    nuance: "Inside Private proxy tabs filtering is real: tracker requests never leave Fusion and are counted per host. Directly embedded cross-origin pages still cannot be filtered.",
    status: "partial", test: "tt35-unit.mts ×1; e2e-tt35.mts ×1",
  },
};
