# DESIGN — TT37: upstream network route for Private proxy tabs (Tor / SOCKS5 / HTTP CONNECT), gamepad pointer mode

Runtime used for every claim below: Node 22 (`--experimental-strip-types`), Next 16.2.6 production build on :3999, headless
Chromium via Playwright 1.64.1, embedded PostgreSQL, curl 8, Python 3 with **pproxy 2.7.9 (MIT, test-only, never shipped)**.
No Tor binary exists in this sandbox and Tor relays are not reachable from it; no physical gamepad exists either. Where
that limits a claim, the claim says so.

Rows: **WP-07** (new, built) — upstream route. **IN-07** (partial → built) — gamepad pointer mode.
Also: the TT36 blocker **"unexplained ECONNRESET uncaughtException" is root-caused, reproduced and fixed** (section I.10).

## A. Formal model

**Route.** `R ∈ {Direct} ∪ {(scheme, host, port, cred?) | scheme ∈ {socks5, socks5h, http}}`, held in one server
singleton (`globalThis.__fusionWpRoute`), seeded from `FUSION_WP_UPSTREAM`, changed only by a same-origin `PUT /api/wp-route`.
A Private proxy request for target `T = (name, port)` is a function `open(R, T, session) → Socket | RouteError`:

- `R = Direct` → `pinned-http` (TT35: resolve, refuse private addresses, connect to the pinned IP). `.onion` is refused.
- `R = socks5*` → TCP to the proxy; greeting `05 n methods`; RFC 1929 login when `cred` or isolation is set; CONNECT with
  **ATYP 3 (name)** for names, ATYP 1/4 for literals. Fusion's server performs **no DNS lookup** for `T` (invariant **I1**).
- `R = http` → `CONNECT name:port HTTP/1.1` (+ `Proxy-Authorization: Basic`), then TLS to `T` over the tunnel; the
  certificate is verified against `name` end to end (**I2**: the proxy can delay or drop traffic but can't read or change it).
- Isolation: `cred = ("fusion-" + session.id, session.circuit)` when isolation is on — with Tor's default
  `IsolateSOCKSAuth`, different credentials ⇒ different circuits. `PATCH /api/wp-session {newCircuit}` replaces `circuit`.
- Every failure before the first byte from `T` is a `ProxyRouteError` with a `reply` code, shown as "The network route
  failed …" — never as "the site is down" (**I3**). The SSRF verdict runs on the *name* before any byte is sent (**I4**).

**Gamepad.** A pure function `step(state, pad, dt, now, vw, vh) → (state', actions[])` (src/lib/gamepad-pointer.ts) and a
DOM host that polls `navigator.getGamepads()` once per animation frame only while a pad is connected and the tab is visible.
Velocity `v = MAX · ((|s| − d)/(1 − d))^γ · ŝ` for `|s| > d`, with `d = 0.15`, `γ = 2.2` and `MAX = 1400 px/s`; position
`p' = clamp(p + v·min(dt, 100 ms))`. Buttons are edge-triggered with the invariants: (**G1**) every emitted `down` gets
exactly one `up`; (**G2**) no `up` without a preceding `down`; (**G3**) while disabled, nothing moves, clicks or scrolls.

## B. Hypotheses

- **H+1** Our SOCKS5 / HTTP CONNECT bytes equal curl's for the same inputs. *Confirmed* for CONNECT and HTTP; greetings
  differ only by design (we offer fewer methods: `050100` vs curl `05020001`; with auth `05020002` vs curl `0503000102`).
- **H+2** Pages load through an independent proxy implementation, and the proxy sees names, not addresses. *Confirmed*
  (pproxy logs `pypi.org:443`, `github.com:443`; e2e: 16 tunnels by name for one page load).
- **H+3** The pointer's distance travelled doesn't depend on frame rate. *Confirmed* (30/60/144 Hz agree to < 1e-6 px).
- **H−1** "Setting `createConnection` is enough to route Node's `http.request`." *Refuted* — with `agent:false`, Node
  ignores `createConnection` and connects **directly, with local DNS** (a silent bypass plus a DNS leak). Found by the
  pproxy-log test, fixed by omitting `agent`.
- **H−2** "Edge-detect A, so release ⇒ `up`." *Refuted* — re-enabling the mode while A is held then releasing fired a
  stray `up` (click). Fixed with `downSent`.
- **H∂1** Circuit isolation actually yields different Tor exits. *Undecidable here* (no Tor, no relay egress); rests on
  Tor's documented `IsolateSOCKSAuth` default. We prove only the part we own: distinct credentials per session.
- **H∂2** Real controllers behave like the W3C shape (drift, vendor mappings). *Undecidable here*; the deadzone covers
  typical drift, and non-standard mappings get only stick + A + B.

## C. Frontier

What is beyond this turn, stated as limits rather than promises: sites that the sandbox's egress filter blocks (Yahoo,
SoundCloud, Wikipedia, DuckDuckGo …) stay blocked **through any route**, because the proxy sits behind the same filter;
we don't try to defeat the filter. Tor works when the user runs Tor (9050 / 9150 presets). Pointer mode can't reach into
cross-origin or sandboxed frames (embedded players, Private proxy pages), can't open native `<select>` pop-ups, and doesn't
map window dragging.

## D. Negative shapes tested (≥15)

tt37-unit "route parsing", "SSRF guard with a route", "hostile and broken proxies", "gamepad buttons":

1. Unsupported schemes refused. 2. Port 0 / 65536 / non-numeric refused. 3. A path or query in the
proxy address refused. 4. Credentials > 255 bytes refused (RFC 1929 limit). 5. The description never contains the
password. 6. A proxy offering no acceptable method (`05 FF`). 7. Every RFC 1928 reply code 1–8 and Tor's F0–F7, each
named. 8. A non-SOCKS server answering HTTP. 9. Silence → deadline (< 2.5 s). 10. A 100 KB flood. 11. A close mid-reply.
12. HTTP 407 and 403 on CONNECT. 13. An oversized CONNECT reply header. 14. Garbage from the *destination* after a good
tunnel → classified `tls`, not route. 15. Private / loopback / link-local literals, `localhost`, single-label names,
`.internal` / `.local`, non-web ports — refused before the proxy is contacted. 16. `.onion` over Direct or over an HTTP
proxy → refused with a stated reason (a Tor route is needed) — e2e-checked. 17. Cross-site `PUT /api/wp-route` → CSRF guard
403. 18. A dead route (port 1) → "The network route failed", and Reload works once the route is fixed (e2e). 19. Gamepad:
NaN axes inert; deflection 0.14 → no motion; a 5 s stalled frame moves ≤ 140 px; held A doesn't repeat; Start-off
blocks moves, clicks and scrolls; a non-standard pad gets only stick, A and B.

**Modal-shortcut failure test.** The two shortcuts most implementations take, each shown failing by a test that stays in
the suite: (a) `http.request({ agent: false, createConnection })` — the pproxy-log assertion fails because the request
never reaches the proxy; (b) "release ⇒ up" — the attack test (enable with A held, release) fails with a stray `up`.

## E. Mechanism-distinct approaches considered (≥6)

1. **Own SOCKS5 / HTTP CONNECT client on `net` / `tls`** (chosen): about 300 lines, no dependency, remote DNS, our own error taxonomy.
2. A SOCKS npm package (e.g. `socks`, MIT) — rejected: a dependency for about 150 lines of protocol, and it doesn't fix the
   `agent` bypass, which is in *our* use of `http`.
3. `undici` `ProxyAgent` — HTTP CONNECT only, no SOCKS, so no Tor.
4. A system-wide `HTTPS_PROXY` env — leaks into unrelated server traffic (DB, embeds), no per-session isolation.
5. Shelling out to `curl --socks5-hostname` — process per request, streaming and cookies lost; rejected.
6. Bundling Tor or arti — not permissive-light (size, licence mix), and Tor needs relay egress the sandbox lacks.
7. Gamepad: a CSS-only focus ring driven by d-pad (spatial navigation) vs a free pointer — chose the pointer (works with
   every control, including canvas), plus LB / RB focus cycling for keyboard-style navigation.
8. Gamepad: synthetic `WheelEvent` for scroll — rejected (untrusted wheel events don't scroll); `scrollBy` on the nearest
   scrollable ancestor.

## F. Artifacts

`src/lib/server/wp-tunnel.ts`, `wp-route.ts`, `src/app/api/wp-route/route.ts`, `src/components/modules/NetworkRoute.tsx`
(Browser → "Route"), the edits in wp-fetch / wp-sessions / pinned-http / ProxyFrame (`wp-via`, `wp-circuit`);
`src/lib/gamepad-pointer.ts`, `src/components/GamepadPointer.tsx`, Devices → Gamepad (`gp-help`, `gp-toggle`);
`scripts/tt37-unit.mts` (9), `scripts/e2e-tt37.mts` (4); `src/db/seed-data/features-tt37.ts` (seed 3.26.0);
`docs/test-results/tt37-unit.json`, `e2e-tt37.json`.

## G. Adversary

- **Malicious page** — can't change the route (CSRF guard, verified), should not be able to read it (proxied pages run in an opaque
  origin and `/api/wp-route` sends no CORS headers; this read path is **not** separately tested), can't reach LAN through the proxy (SSRF verdict on names before any byte).
- **Malicious or broken proxy** — can stall or refuse (deadlines, named errors), can't read or alter HTTPS (TLS verified
  to the *target* name over the tunnel), can't inject bytes into the HTTP parser before the tunnel succeeds (only
  unshift on success).
- **Credential leakage** — the password never appears in the description, the API response, logs or the toolbar.
- **Gamepad** — synthetic events are dispatched only at the element under the pointer in Fusion's own document; they
  can't cross into other origins (browser rule), so a pad can't drive a proxied page or a provider player.

## H. External verification

- **curl 8** (independent client): byte-identical CONNECT request and HTTP CONNECT header block for the same inputs.
- **pproxy** (independent MIT server): its own log shows tunnels by *name*, so no local resolution happened. Note: pproxy
  does **not** enforce `#user:pass` (it accepts wrong credentials), so authentication is verified by a curl differential
  test against our recording server instead.
- **Python `ipaddress`**: IPv6 ATYP 4 packing identical for 8 shapes.
- **Chromium**: the real Gamepad API surface with the hardware substituted (`navigator.getGamepads` returns a scripted
  W3C-shape pad); everything downstream (rAF polling, hit-testing, dispatch, React handlers, dock magnification) is real.
  Screenshot: the pointer paints over the Art dock and triggers its real hover magnification and tooltip.

## I. Repair and new attack

Real bugs found this turn (all by tests, all fixed):

1. `agent:false` silently bypassed the proxy and resolved DNS locally (pproxy log). → omit `agent`.
2. A flowing socket with no listeners lost the proxy's first bytes; a paused one was never resumed by the HTTP client.
   → pause in `release()`, resume on `req.on('socket')`.
3. Handshake failures surfaced as a generic reset. → every handshake error becomes a `ProxyRouteError`.
4. Node strip-types rejects TypeScript parameter properties in imported source. → plain fields.
5. Gamepad stray `up` after re-enabling with A held. → `downSent`; **new attack**: turn the mode *off* while A is held —
   must release exactly once (not zero: that would leave a stuck button; not twice). Test: `[down, up, toggle false]`.
6. The route panel's initial load overwrote a choice the user had already made (e2e: the custom-address input detached).
   → user choice wins (`touchedRef`).
7. Reload did nothing on Fusion's own error pages (they carry no runtime). → Reload navigates the frame to the
   current address. New attack: dead route → error page → fix route → Reload → page loads (e2e, passes).
8. The pointer was mounted inside the desk, which in Business / Art is an isolated stacking context: it would paint
   under the taskbar and dock. → mounted at the shell root; screenshot-verified over the Art dock.
9. Test-side: a 90 ms tap can fall between two polls on a busy frame (a property of every polled Gamepad API).
   → presses held for 3 rendered frames; e2e-tt37 4/4 on four consecutive runs.

10. **The TT36 "unexplained ECONNRESET" (root cause).** The preload monitor captured it during e2e-tt35 in the full run:
   `uncaughtException: Error: aborted at abortIncoming (node:_http_server) ← socketOnClose`, so a client hung up
   while the server still owed a response. This is the upstream defect vercel/next.js#99278: for a request with a
   body that passes through `proxy.ts`, Next swaps in a buffered body (`replaceRequestBody`) and so replaces the
   request's listeners and `_destroy`. Only the `next()` / rewrite path re-attaches an `error` listener. Ours answered
   two cases **itself** (403 CSRF refusal, 400 malformed JSON). Raw-socket reproduction against the live server:
   6/6 uncaught after a client reset on those two paths, 0/3 on the `next()` control. **Fix:** the proxy *rewrites* refusals to
   `/api/refused`, which returns the same status and body (passed by request header — a middleware rewrite's query
   string did not reach the route, which the 400 check caught). **New attack:** is the rewrite really internal? Next keeps it internal
   only when its origin equals the bind origin. Under `-H 127.0.0.1` it became an HTTP request to itself, and the
   refusal hung (found by the test). Under the real `-H 0.0.0.0` binding, a request recorder in the server proves that
   exactly one request arrives per refusal. Standing test: e2e-tt37 "client resets". It **fails against the unfixed
   build** (recorder caught 3+), passes after. Limitation: binding with an explicit `-H 127.0.0.1` would bring the self-hop back.
11. Test isolation: the core e2e suite assumed the Fusion chrome and classic desktop. A shared desktop left on Art +
    Tabletop produced 7 false failures. e2e now pins both and restores the user's choice (61/61). run-all now gives
    suites the same CA store as the server (`--use-system-ca`), which a TLS-verifying unit test needed.

Mutation check (WP-07): 5/5 mutants of wp-tunnel / wp-fetch caught by tt37-unit earlier this turn (files restored and
rebuilt afterwards). The individual mutants were not recorded in this document.

## Results (this turn)

tt37-unit 9/9; e2e-tt37 5/5 (the four feature tests passed on 4 consecutive runs before the fifth was added). Full run (64 suites, fresh build, recorder preloaded): 606/608; the two failures (wall-drag timing in
e2e-tabletop and e2e-tt31) passed on rerun (14/14, 10/10), so 608/608 per suite. **The uncaught-exception recorder
stayed empty for the whole run.** Ledger: 353 rows; built 270 / partial 62 / blocked 21; tested full 152 / partial 80 /
untested 121. IN-07 is tested **partial** (not full): the mapping is fully unit-tested, but no real controller was used.

**ECONNRESET investigation** — see I.10: captured, reproduced 6/6, fixed, guarded by a standing test. A bare
`Error: aborted` line *without* "uncaughtException" can still appear: that is Next logging a client abort it handled.

## J. Stopping

Stopped when WP-07 and IN-07 met their acceptance criteria with external evidence, every negative shape was in a
standing test, and the remaining gaps were ones this sandbox can't close: no Tor or relay egress, no gamepad, and a
filtered egress that blocks the named sites through any route.
