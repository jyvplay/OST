# TT38 — Private proxy on real networks: WebSockets, SSE, Happy Eyeballs, keep-alive, system proxy

Branch `arena/c82ec6a1-ost`, on top of TT37 (8a0967d). Register rows **WP-08** and **WP-09** (seed 3.27.0).

## Runtime honesty
What actually ran this turn, in this sandbox:
- Node 22 (`--experimental-strip-types`), `next build` / `next start` (Next 16.2.6), headless Chromium 1.64 (Playwright),
  PostgreSQL. Python 3.11 venv with **websockets 13.1** (BSD-3) and **pproxy 2.7.9** (MIT) as *independent test peers only*,
  curl 7.88 and OpenSSL 3.0 as differential references.
- Egress is limited to github.com / pypi.org / npm / GitHub API. **No public WebSocket service and no IPv6 route** were
  reachable, so WebSocket and SSE behaviour is verified against local servers. A test-only allowance
  (`FUSION_WP_TEST_LOOPBACK_PORTS`, literal 127.0.0.1, ports > 1024, warns on stderr) lets the proxy reach them; it
  is never set outside tests.
- Nothing was run on a phone or a dual-stack network. "Works on a real computer or mobile device" is argued from the
  standards each piece implements and the browser APIs the shim uses. It is not proven on such devices. See J.

## A. Formal model
**Bridge (one page socket).** States are `CONNECTING → OPEN → CLOSING → CLOSED`, mirroring WHATWG `readyState`.
- Down-link: one streaming POST response carrying frames `[type u8][len u32 BE][payload]`. The types are 0 keep-alive, 1 open, 2 text, 3 binary, and 4 close `{code, reason, wasClean, error?}`.
- Up-link: ordered POST batches of types 2, 3 and 4, with a single request in flight, so the page's send order is the wire order.

Invariants:
1. **I1:** the site receives page messages in send order (single in-flight queue; Blobs are read in place).
2. **I2:** no page message is delivered after `close()` and none after CLOSED; exactly one `close` event fires, preceded by `error` iff the close was not clean.
3. **I3:** every upstream byte stream comes from `openUpstream`, so the SSRF guard, route, TLS verification and session isolation all apply.
4. **I4:** a socket never outlives its session, its page stream, or a "New circuit".
5. **I5:** the Origin the site sees is either proven for this session and document, or `null`.
6. **I6:** a cross-site or unverified handshake neither sends nor stores Lax/Strict cookies.

**Connection layer.** `addresses = validate(resolve(host))`, where one private answer refuses the name. Attempts start in RFC 8305 order at t = 0, 250 ms, 500 ms…, or immediately when the previous attempt fails. The first `connect` wins and every other attempt is destroyed. Pools are keyed by `(sid, circuit, scheme, route)` with ≤ 6 active exchanges per host.

## B. Hypotheses
- **H+ (confirmed):**
  - A fetch-stream bridge gives full WebSocket semantics without opening the page's CSP.
  - Racing validated addresses keeps the DNS-rebinding guard while adding fallback.
  - curl's proxy-variable rules can be matched exactly.
- **H− (refuted, with measurements):**
  - "Node's `http.Agent` `maxSockets` limits connections": false with an asynchronous `createConnection` (12 sockets for 12 parallel requests).
  - "`no_proxy=host:port` bypasses on that port": false in curl 7.88, so it is false here too.
  - "Gating secrets by Sec-Fetch works": my first test said no. The cause was the test's regex matching its own source; the server was right.
- **H∂ (partly open):**
  - Real mobile networks (NAT64, IPv6-only carriers): RFC 8305 ordering handles them by construction but is untested here.
  - Reverse proxies in front of Fusion that buffer streaming responses: mitigated with `x-accel-buffering: no` and `no-transform`, but untested.

## C. Frontier (what is now possible that was not)
Proxied chat, live-score and trading pages (WebSocket), live dashboards and notifications (SSE), sites with a dead IPv6 address, networks that require a proxy (corporate, school), and pages with many subresources (connection reuse instead of a handshake per request).

## D. Negative shapes (≥ 15) and the modal-shortcut test
These are tested in tt38-unit and e2e-tt38.
- **Handshake (7):** wrong accept, 200 instead of 101, missing Upgrade, unoffered subprotocol, unoffered extension, header flood, silence.
- **Frames (10):** masked server frame, RSV1, opcode 3, invalid UTF-8, 126-byte control frame, fragmented ping, orphan continuation, new message inside a fragmented one, 1005 on the wire, 1-byte close payload.
- **Size:** 1009 over the cap.
- **Bridge guards:** a 33rd socket (429), private / localhost / non-web-port / fragment / credential / ftp URLs, a private IP behind a name, another session's socket id, an unknown id, a truncated batch.
- **Forged origins (4):** another site's token, a made-up token, none, another session's token.
- **Scrape:** another document fetched by script.
- **Connection:** all addresses refused, nothing answering, a blackholed address, a stale pooled connection (GET retried, POST not), a self-signed TLS server, a malformed proxy variable.

**Modal shortcut:** the obvious implementations are demonstrably wrong.
- A stock Agent opens 12 sockets where 6 were asked for.
- Byte-slicing a close reason yields invalid UTF-8, which a conforming peer answers with 1007.

## E. Mechanism-distinct approaches considered
| # | Approach | Verdict |
|---|---|---|
| 1 | Open the page CSP to `wss:` and let native sockets go direct | Rejected: the page would contact sites directly (IP exposure, bypasses route / Tor / shields). |
| 2 | Raw HTTP Upgrade passthrough on the Next server | Rejected: App Router handlers never see the upgrade socket, so it needs a custom server and breaks `next start` deployments. |
| 3 | **Fetch streaming response down + ordered POST up** | **Chosen**: plain HTTP through any CDN / reverse proxy / mobile network; ReadableStream bodies exist in every current browser. |
| 4 | Long-polling | Works everywhere, but adds a round trip per message; kept as the documented fallback design, not built. |
| 5 | EventSource down + POST up | Text only (binary would need base64, +33 %), and EventSource auto-reconnects in ways a WebSocket must not. |
| 6 | WebTransport | Needs an HTTP/3 server, which Node lacks in core. |
| 7 | Service Worker interception | Opaque-origin (sandboxed) documents cannot register workers. |

For Happy Eyeballs, Node's own `autoSelectFamily` with a lookup returning the validated addresses is a viable alternative. The own racer was chosen for per-address error reporting, the attempt log ("via …"), an injectable dial for deterministic tests, and identical behaviour on Node versions where `autoSelectFamily` defaults differ.

## F. Artifacts
- **New files:**
  - `src/lib/server/ws-client.ts`, `wp-ws.ts`, `wp-connect.ts`, `sysproxy.ts`;
  - `scripts/tt38-unit.mts` (15 tests), `scripts/e2e-tt38.mts` (7 tests);
  - `scripts/fixtures/ws/ws_server.py` and `sysproxy-probe.mts`;
  - `src/db/seed-data/features-tt38.ts`.
- **Changed files:**
  - `wp-fetch.ts`: pools, retry, routeFor.
  - `pinned-http.ts`: one connection layer.
  - `wp-route.ts`: system route, routeFor.
  - `netguard.ts`: test allowance.
  - `wp-sessions.ts`: end hooks.
  - `wp-core.ts`: SameSite, siteOf.
  - The proxy route: `__ws` endpoints, SSE headers, navigation-gated secrets.
  - `/api/wp-route`: "system".
  - `/api/wp-session`: new circuit drops pools and sockets.
  - `public/wp-shim.js`: WebSocket and EventSource.
  - `NetworkRoute.tsx`: system preset and details.
  - `bootstrap.sh`: websockets.

## G. Adversary findings (this turn)
1. **Cross-site WebSocket hijacking:** the first bridge trusted the page's claimed origin, so a page could open a socket to another site in that site's name with its cookies.
2. **Cookie scraping:** script cookies (`data-cookies`) were injected into every HTML response, including ones a page fetched by script.
3. Lax cookies from a cross-site handshake's 101 reply were stored (Chrome blocks this).
4. A stock Agent's socket limit doesn't hold.
5. A close reason split mid-character.
6. A stale keep-alive connection can surface as an error on reuse.

## H. External verification
- Python **websockets** is an independent RFC 6455 implementation, used for interop in both directions.
- **curl 7.88** is the system-proxy differential (22 cases).
- **pproxy** is an independent HTTP / SOCKS5 proxy. It carried pypi.org by name and carried a WebSocket over SOCKS5.
- **Chromium** is the real WebSocket / EventSource consumer through a production build.
- **github.com** provided real TLS on the new path, and OpenSSL's self-signed certificate was the negative.

## I. Repair, then a new attack against the repair
- **Repairs:**
  - Per-document HMAC origin tokens (per-process key), injected only into navigations (`Sec-Fetch-Dest` document/iframe or `Sec-Fetch-Mode: navigate`; browsers without Fetch Metadata are trusted as before).
  - SameSite tracked in the jar: default Lax; None requires Secure.
  - Cross-site handshakes send and store only SameSite=None.
  - Script cookies are gated like the token.
- **New attacks run against the repair:**
  - Four forged-origin variants at the module layer.
  - In Chromium, a page that (a) fetches its own site's HTML to steal the token and cookies, then (b) calls the bridge directly with its own token while claiming another origin.
  - The site saw `Origin: null` and no cookie; the fetched copy carried neither secret.

## J. Stopping
I stopped when every WP-08 / WP-09 claim in the register had a passing test at the layer where it lives, the adversary findings had repairs with tests that attack the repair, and the full suite was re-run (see the PR / LEDGER). Not done, and why:
- Workers' own sockets: workers don't run the shim.
- permessage-deflate.
- PAC / OS proxy dialogs.
- A live public WebSocket service, IPv6 and mobile networks: all unreachable here.
- The general (non-WebSocket) proxy path still lets a page in one session read another site's responses by script (CORS is `*` inside a session). This is the known single-origin-proxy limit; per-tab sessions are the mitigation.

## Results (this turn)
- **Full run:** 66 suites, **624/630** in the run.
  - 5 failures were `tt34-unit` oracles whose Python packages (geographiclib, gpxpy) were missing after the sandbox reset. `bootstrap.sh` never listed them; fixed now.
  - 1 was the known Tabletop wall flake in `e2e-tt34`.
- **Per suite:** both re-run green, so **630/630**. The uncaught-exception recorder stayed empty.
- **Ledger:** 355 rows; built 272 full / 62 partial / 21 blocked; tested 154 full / 80 partial / 121 untested.
- **Tails ledger:** unchanged at 39 rows (9 full / 10 partial / 20 none).
- **Bugs found and fixed by this turn's tests before shipping:**
  - Agent socket overshoot;
  - curl `no_proxy` port semantics;
  - control-frame length checked too late;
  - a close reason split mid-character;
  - CSWSH;
  - cookie scraping through fetched HTML;
  - cross-site 101 cookies;
  - an unhandled rejection in the shim;
  - the TT34 bootstrap gap.
