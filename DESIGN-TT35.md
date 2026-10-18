# TT35: private same-origin web proxy for the Browser

## What was asked
Fully integrate and harden the browser's features and the same-origin proxy, and make sure an outside site such as SoundCloud or Yahoo can be reached. Keep the privacy and lightweight constraints, and use only original, permissively licensed code.

## Runtime honesty: what this sandbox can reach
| Host | Result (curl and Node, from the Fusion server) |
|---|---|
| yahoo.com, soundcloud.com, w.soundcloud.com, example.com | **blocked**: the egress filter resets the TLS handshake (`SSL_ERROR_SYSCALL`, Node: "socket disconnected before secure TLS connection") |
| github.githubassets.com, avatars.githubusercontent.com, collector.github.com | **blocked** (same signature) |
| github.com, api.github.com | reachable, but **TLS-intercepted** by the sandbox's egress proxy (issuer "E2B Proxy CA"). The server runs with `NODE_OPTIONS=--use-system-ca` so Node trusts the OS store, as browsers do |
| pypi.org, files.pythonhosted.org | reachable, real certificates |

So **Yahoo and SoundCloud cannot be reached from this sandbox.** Fusion does not try to get around the filter. The proxy attempts them for real, and the tab shows the result in plain words ("Could not reach www.yahoo.com: connection cut during setup … a firewall or egress policy … not that the site is down"). The proxy itself is proven on pypi.org and github.com. Nothing in the code is specific to a site, so on a machine with normal egress the same path serves yahoo.com and soundcloud.com. That last point is **inferred, not verified here.**

pypi.org's CDN (Fastly) began answering /search/ and /project/ with a **bot challenge** to this sandbox's address partway through the session (plain curl too). Fusion shows the challenge and does not solve or evade it. The tests use pypi pages that are still served, and they log whether the search returned results or the challenge.

## A: Formal model
- **Proxy URL**: `/api/wp/s/<sid>/<scheme>/<host[:port]><path>?<query>`. The path is preserved, so a page's own relative and root-relative URLs resolve inside the proxy with no help. `<sid>` is a 128-bit capability; there are no cookies and no Referer fallback, because that would leak the sid.
- **Session**: `{ua, profile, CookieJar, stats{requests, blocked, bytesIn, errors, blockedHosts, failedHosts}}`, held in RAM only. Sessions expire after 30 idle minutes, the store holds at most 64 (least recently used goes first), and the Browser deletes a tab's session when the tab closes.
- **Document**: rewritten HTML with the runtime `<script src=/wp-shim.js>` first in `<head>`, served with a `CSP: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads …` header without allow-same-origin. The origin is therefore opaque even when the document is opened top-level, and `default-src` is limited to Fusion's own origin.
- **Streams**: HTML and CSS are buffered (≤ 8 MB) to be rewritten. Everything else streams with pull-based backpressure, with a 4 GB ceiling and constant memory. An upstream failure mid-body cuts the client connection instead of ending cleanly.
- **CSRF**: state-changing `/api` requests pass only from the desktop itself (Sec-Fetch-Site same-origin, or an Origin naming one of our hosts) or a non-browser client. `Origin: null` is refused.

## B: Claims
- **H+ (demonstrated):**
  - pypi.org renders in the proxied tab with its own fonts, colours and images. 128–132 browser requests (per run) went **only** to the Fusion server.
  - The search form, a link, Back/Forward and address tracking work.
  - Find gives 1/34 → 2/34 with the match selected.
  - The Mobile identity is seen by both server and page.
  - Save to Files writes the original HTML.
  - Per-tab cookie jars are isolated, survive reload and navigation, and Clear and close-tab work.
  - A 10.5 MB wheel is byte-identical to PyPI's published SHA-256, and Range returns 206 with the right bytes.
- **H− (refuted):**
  - A page with the runtime **withheld** cannot read `/api` and cannot write a file by CSRF, top-level or framed.
  - Loopback, private and metadata targets are refused.
  - A 64 MB gzip bomb stops at the cap.
- **H∂ (partial):**
  - github.com: its HTML renders, but unstyled here (CDN blocked; the toolbar names the hosts).
  - JS that builds URLs from `location.origin`, WebSockets and service workers are not proxied.
  - Page-initiated downloads inside the sandboxed frame go to the browser's own download folder.

## C: Frontier
JavaScript-heavy single-page apps that compute origins at run time; WebSocket proxying; named profiles shared across tabs; reader mode in proxied tabs (the runtime already answers a `text` request; there is no UI yet).

## D: Negative shapes (each pinned by a test)
1. Credentials in URLs.
2. Non-http schemes.
3. Bad or unknown sid (403).
4. Smuggled hosts.
5. Loopback, IPv6 loopback, private ranges, ULA and the metadata IP.
6. localhost names.
7. Decompression bomb.
8. Upload over 8 MB (413).
9. Cross-site POST to `/api` (403).
10. Origin null (403).
11. Sibling subdomain (403).
12. Tracker hosts and subdomains blocked; look-alikes allowed.
13. HttpOnly cookies hidden from scripts.
14. Public-suffix Domain cookies refused.
15. `__Host-` cookie with a Domain refused.
16. A same-origin fetch to another site still fails.
17. An upstream reset mid-body.
18. A cancelled client.
19. A find before the page is parsed.

**Modal-shortcut failure test:** the "hostile page" model withholds the runtime instead of trusting it. An earlier version of that test passed for the wrong reason: the runtime had rerouted the attack to pypi.org. That was caught and replaced.

## E: Mechanism-distinct approaches
1. Server-side HTML/CSS/srcset rewriting.
2. In-page runtime patches (fetch, XHR, history, `window.open`, element URL setters, `document.cookie`, storage).
3. CSP sandbox for the opaque origin.
4. Server-side cookie jar.
5. Header allow/deny filters.
6. Parent-side history and find over postMessage, with a `source === frame.contentWindow` check.
7. CSRF middleware.

## F: Artifacts
- **Source:** `src/lib/wp-core.ts`, `src/lib/server/wp-fetch.ts`, `src/lib/server/wp-sessions.ts`, `src/app/api/wp/s/[sid]/[...rest]/route.ts`, `src/app/api/wp-session/route.ts`, `public/wp-shim.js`, `src/components/modules/ProxyFrame.tsx`, `src/proxy.ts`.
- **Tests:** `scripts/tt35-unit.mts` (13), `scripts/e2e-tt35.mts` (7), `scripts/oracle/htmlurls.py` (Python html.parser oracle).
- **Register:** `src/db/seed-data/features-tt35.ts` (WP-01..06; PR-07h blocked→partial, PR-07o probe→partial; PR-07m/n/p updated), seed 3.24.0.

## G: Adversary findings and I: repairs (each with a new attack)
| Finding | Repair | New attack |
|---|---|---|
| `.pipe()` doesn't forward errors. An upstream reset gave an **uncaught exception** and a hung reader; a cancelled client left the upstream flowing | `responseBody()` built on `stream.pipeline` | local socket that resets mid-body (plain and gzip) plus an endless cancelled stream. The old plumbing is run as the mutant: it hangs ×2, gives 1 uncaught, and leaves the upstream open; the repaired one passes |
| `Readable.toWeb` threw "Controller is already closed" when a client cancelled | pull-based `toWebStream()` | cancel with a pending read and late data; a mid-body failure must error the reader |
| Streamed downloads cut at 8 MB, because document navigations used the text cap | caps split: 8 MB buffered, 4 GB streamed | 10.5 MB wheel checked against PyPI's SHA-256 |
| `fetch(..., {mode:"same-origin"})` (used by pypi) can never succeed from an opaque origin | translated to `cors` only when the real target is the page's own site | own-site works; cross-site stays refused |
| Find counted a half-parsed page; a later "nav" report erased the answer | the runtime defers until DOMContentLoaded; DOM mutations invalidate; the first report doesn't reset | find immediately after load |
| GitHub silently unstyled | the toolbar shows "Unreachable: N" with host and reason | e2e asserts github.githubassets.com is named as a firewall/egress block |
| **Pre-existing** (since the initial upload): `pinned-http.ts` redirect branch `res.resume()` had no error listener, so an uncaught `aborted` showed up during e2e-tt30 | error listener on every path | e2e-tt30 rerun: server log clean |

## H: External verification
Independent oracles:
- Python `html.parser`, which walks the rewritten real pages: 1 817 outside URLs → 0.
- PyPI's published SHA-256 digests.
- Real Chromium for origin, CORS and CSP behaviour.
- Real network attempts for the egress classification.

## J: Stopping
- **Suites:** tt35-unit 13/13; e2e-tt35 7/7; e2e-browser 6/6, browser-session 5/5, unit 23/23 and e2e-tt30 6/6 rerun after the CSRF guard.
- **Lint:** tsc is clean. Browser.tsx keeps its 3 react-compiler lint errors. They are pre-existing (identical on the committed version, lines shifted), so they were left alone.

## Licences
Ultraviolet and Scramjet (AGPL) and Rammerhead/testcafe-hammerhead were read for **architecture ideas only**. No code was copied. Everything here is original.
