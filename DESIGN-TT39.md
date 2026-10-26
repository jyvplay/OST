# TT39: Private proxy isolation, Workers, WebSocket compression, PAC and OS proxy settings

Branch `arena/c82ec6a1-ost`, built on TT38 (84a775e). New register rows: **WP-10, WP-11, WP-12, WP-13** (seed 3.28.0). WP-08 and WP-09 no longer list these four as limits.

## Runtime honesty
This is what actually ran in this sandbox during this turn:
- **Tools:** Node 22 (`--experimental-strip-types`), `next build` / `next start` (Next 16.2.6), headless Chromium (Playwright 1.64) and PostgreSQL.
- **Python test peers** (independent, test-only, never shipped), in a Python 3.11 venv:
  - **websockets 13.1** (BSD-3): RFC 7692 interop.
  - **PyPAC 0.19.0** (Apache-2.0) running PAC in Duktape via **dukpy** (MIT): PAC differential oracle.
  - **pproxy 2.7.9** (MIT): an independent HTTP proxy.
  - Chromium itself: native-vs-proxied oracle for CORS and Workers.
- **Egress** reaches only github.com, pypi.org, npm and the GitHub API. Live tests use local servers through the test-only loopback allowance; pypi.org and github.com are real.
- **Not run:** no Windows or macOS machine, no GNOME desktop and no phone.
  - The OS-settings parsers are tested on each tool's *documented* output format. That sample text was written for the tests, not captured from real machines.
  - The full OS chain ran once through a stand-in `gsettings` executable on PATH.
  - "Works on a real computer or mobile device" therefore rests on the standards implemented and the platform tools named. It is not demonstrated on such devices (see J).

## A. Formal model
**WP-10, per-origin isolation.**
- **Inputs:** each proxied request carries `(sid, doc, cred)`, where `doc` maps server-side to the page's real origin `O`.
- **Policy:** for a target `T`, `policy(O, T, method, cred)` derives Origin, Referer, Sec-Fetch-Site, cookie sending and whether the request is a CORS request. A preflight runs against the real `T` when the Fetch §4.8 rules demand one.
- **Read check:** the response reaches the page iff `corsCheck(O, cred, ACAO, ACAC)` passes.

Invariants:
1. **I1:** no response body crosses origins without the target's consent.
2. **I2:** cookies are sent and stored only as the browser would allow (credentials mode × same-site × SameSite).
3. **I3:** an unknown or forged `doc` is origin `null` with no cookies.
4. **I4:** headers that act on Fusion's own origin are never passed to script responses.

**WP-11, Workers.**
- A worker is `bootstrap(cfg) ∘ script`, where `cfg = {sid, doc, url, ua, here, wst, module}`.
- Every network API in the worker (fetch, XHR, importScripts, WebSocket, nested Worker) is rewritten to the proxy with the page's `doc`.
- A module worker becomes a classic worker running `import(script)`. Messages that arrive before evaluation starts are queued and replayed in order.

**WP-13, permessage-deflate.**
- **Negotiation:** offer `permessage-deflate; client_max_window_bits`. Accept exactly one valid answer whose parameters are a subset of the RFC 7692 §7 grammar.
- **Inbound:** `inflate(payload ‖ 00 00 ff ff)` with a decompressed-size cap.
- **Outbound:** `deflate` with a sync flush and the 4-byte tail stripped. The window and context takeover are as negotiated.
- **I5:** messages are delivered in wire order, because one serial chain carries inflates and control frames.

**WP-12, PAC.** `route(T) = firstUsable(parse(FindProxyForURL(stripHttps(T), host(T))))`.
- **DNS:** `FindProxyForURL` is evaluated as a pure function of `(url, host, clock, DNS answers)`. A missing answer throws a marker, the host resolves it, and evaluation re-runs (≤ 16 names).
- **I6:** no host object is reachable from the PAC context. Only primitive strings cross the boundary, and every evaluation is time-limited, including promise jobs.

## B. Hypotheses
- **H+ (confirmed):**
  - A server that knows each page's real origin can enforce CORS exactly as the browser does. 0 differences on 27 requests.
  - Workers can be brought under the shim from a blob bootstrap.
  - Node's zlib supports every RFC 7692 parameter except an 8-bit window.
  - A PAC engine with no host callbacks can still do DNS, by re-running the deterministic function.
- **H− (refuted, with measurements):**
  - "A module worker can be started from an opaque-origin page": Chromium fires `error` before running even a one-line blob module.
  - "`vm` timeouts bound a PAC script": false on two counts.
    - A queued promise job runs after `runInContext` returns, so the server hangs. This needed `microtaskMode: "afterEvaluate"`.
    - Node's error decoration (`displayErrors`) formats an escaping exception after the watchdog stops, which runs a planted `message` getter on the server thread. This needed `displayErrors: false`.
  - "PyPAC is a faithful reference": six departures from the Netscape text, now predicted in the test.
  - "`ACAH: *` excludes Authorization in practice": deployed Chromium and Firefox still allow it.
- **H∂ (open):**
  - Real Windows `reg` and macOS `scutil` output on localized systems. Value names are not localized, but untested.
  - WPAD discovery.
  - Mobile OS proxy settings: Android and iOS expose no tool a server process can read.

## C. Frontier (what is now possible that was not)
- **Isolation:** sites can't read each other through the proxy (logins safe from other tabs' scripts).
- **Workers:** sites built on Web Workers (editors, games, PDF viewers, maps) keep working through the proxy.
- **Compression:** WebSocket-heavy sites send compressed frames (1 MiB of repetitive text took ~3 KB on the wire).
- **Managed networks:** offices and schools that hand out a PAC file or set the proxy in the OS settings page work with no extra configuration.

## D. Negative shapes (≥ 15) and the modal-shortcut test
- **WP-10 (unit):**
  - 9 malformed session segments.
  - Unsafe headers: `(` in Accept, >128 bytes, a bad range, a multi-range, >1024 bytes total.
  - ACAO mismatches: a different origin, `null` vs a real origin, a list, missing.
  - ACAC not exactly `true`.
  - Wildcard with credentials; expired preflight cache entries.
- **WP-10 (e2e):**
  - An untagged raw request; a forged document id.
  - A raw client with a real document id but a wildcard and credentials → 403.
  - A denied DELETE sends OPTIONS only.
- **WP-13:**
  - 12 malformed extension answers.
  - A 64 MiB decompression bomb, corrupt deflate data, RSV1 on ping, on CONT and unnegotiated, RSV2.
  - An unoffered extension (TT38's test now uses `x-webkit-deflate-frame`, since deflate IS offered).
- **WP-12:**
  - 9 malformed PAC entries and 8 malformed OS outputs.
  - 14 hostile PAC files: 3 escape routes, 6 kinds of endless loop (at load, in the function, promise job, getter, Proxy trap, toString), a planted getter on a real Error, a DNS flood, an oversize script, a syntax error, a missing function.
- **Modal shortcut (WP-10):** the TT35–TT38 design, "every proxied response carries ACAO `*`", is asserted to give a *different* result from native Chromium on the cross-site credentialed read. The shortcut fails the oracle, and the new design matches it.
- **Mutation checks:**
  - Ignoring the negotiated deflate window or context takeover turns both interop tests red.
  - Removing `microtaskMode` turns the hostile suite red (the child hangs).

## E. Mechanism-distinct approaches considered
1. **Isolation via per-site subdomains** (true browser origins): needs wildcard DNS and TLS at deployment. Rejected because Fusion must run on one host or port. Kept as a future option.
2. **Isolation via server-side policy** with the page's document id (chosen). It works on one origin; the browser's own CORS engine is the oracle.
3. **Workers via a ServiceWorker:** impossible, because opaque origins can't register one.
4. **Workers via a blob bootstrap and shim** (chosen), plus module emulation (forced by Chromium's refusal; see H−).
5. **Deflate:** pure-JS inflate vs Node's zlib (chosen: built in, fast, stream cap via `maxOutputLength` chunks).
6. **PAC engines:**
   - an embedded JS interpreter (Duktape/QuickJS in WASM), heavier;
   - async rewriting of the script (degenerator-style), which changes semantics;
   - **re-run on DNS miss** (chosen): no transformation and no host callbacks.
7. **OS settings:** native bindings (WinINet / SystemConfiguration FFI) vs parsing the platforms' own CLI tools (chosen: no native code, works from Node on each platform).

## F. Artifacts
- **WP-10:** `src/lib/wp-cors.ts`; changes in `wp-core.ts`, `wp-sessions.ts`, `/api/wp/s/[sid]/[...rest]/route.ts` and `public/wp-shim.js`.
- **WP-11:** `public/wp-shim.js` worker mode, `public/wp-mw-ready.js`, and ACAO for those two files in `next.config.ts`.
- **WP-13:** `src/lib/server/ws-deflate.ts`, with changes in `src/lib/server/ws-client.ts`.
- **WP-12:** `src/lib/server/pac.ts` and `src/lib/server/osproxy.ts`, with changes in `sysproxy.ts`, `wp-route.ts` (`routeForAsync`), `wp-fetch.ts` and `wp-ws.ts`.
- **TLS fix:** `wp-connect.ts` and `wp-tunnel.ts` pass `host` to `tls.connect`, so IP-literal sites are checked against their own name, not "localhost".
- **Tests:**
  - `scripts/tt39-unit.mts` (13), `scripts/tt39-pac.mts` (8) and `scripts/e2e-tt39.mts` (7).
  - Fixtures: `scripts/fixtures/pac/{pac_oracle.py, hostile-child.mts}` and the `small`/`plain` modes of `scripts/fixtures/ws/ws_server.py`.
  - `run-all.sh` now runs 69 suites.
- **Register and docs:** `src/db/seed-data/features-tt39.ts` (4 rows plus the WP-08/09 limit patch), seed 3.28.0, and this file.

## G. Adversary findings (this turn)
1. **ACAO `*` session-wide** (TT38 blocker): any page could read any site's credentialed responses. Fixed by WP-10.
2. **Workers bypassed the shim:** raw network, wrong identity. Fixed by WP-11.
3. **IP-literal TLS:** a certificate for "localhost" was accepted for 127.0.0.2, because `tls.connect` over a socket without `host` checks "localhost". Fixed; a test shows the before and after.
4. **PAC promise-job hang** and 5. **PAC `displayErrors` getter hang:** both made the whole server unresponsive. Found by the new attacks and fixed (see H−).
6. **Thrown sandbox values:** reading a property of a thrown sandbox value on the host can run hostile code. Now only primitive strings cross the boundary.

## H. External verification
- **Chromium:** native page vs proxied page, the same matrix, identical results (WP-10: 27 requests and 6 preflights; WP-11: the full worker JSON).
- **Python websockets 13.1:** default and non-default deflate parameters, plus no-compression mode.
- **PyPAC/Duktape:** 84 identical decisions and 6 predicted departures.
- **pproxy:** it logged the proxy's own view of the names it carried (pypi.org for both the PAC and the OS-settings live tests). github.com was absent where the PAC said DIRECT.

## I. Repair, then a new attack against the repair
- **Repair 1 (microtaskMode).** New attack: an endless *getter* on a thrown object, a thrown Proxy and an endless toString all still ended at the limit. Then a planted getter on a *real* Error thrown at load hung the server (repair 2: `displayErrors: false` and the safe `timedOut()`). It was re-attacked by the full 14-shape suite and passed.
- **Repair (deflate ordering).** Async inflate could be overtaken by a later frame or the close. Now there is a serial chain. New attack: one write with [1 MiB compressed][plain][3-fragment compressed][close] is delivered in order.
- **Repair (shExpMatch).** The first version escaped `[`, departing from deployed browsers, which treat `[ab]` as a class. Now there are POSIX classes; the differential includes `[ab]*.shop.example`.

## J. Stopping
I stop here because the four TT38 network blockers have code, tests, independent oracles and mutation checks, and the full suite was re-run. What remains is either outside this sandbox (real Windows, macOS, GNOME and phones; public WS endpoints; IPv6) or a design limit stated in the rows: WPAD, KDE, no PAC failover, SOCKS4 and HTTPS-to-proxy entries, the 8-bit deflate window, worker `self.location`, and cross-tab SharedWorker.

## Results (this turn)
- **Full run** (69 suites, production build): **657 passed, 1 failed**. The failure is e2e-tt34 "tabletop double-click guard (LY-22)", "west is main" timed out.
  - Re-runs of that suite failed 3 more times.
  - **TT38's own build (84a775e, built in a separate worktree) fails it identically** in this sandbox, so it is not a TT39 regression.
  - A diagnostic confirmed that the west wall's open button is the element under the pointer, yet the double-click does not open it. The floor holds ~22 files accumulated by earlier suites. The cause was **not identified**, and the test is left failing (not weakened).
- **New suites:** tt39-unit 13/13, tt39-pac 8/8, e2e-tt39 7/7. tt38-unit 15/15 after one test update (the "unoffered extension" shape now uses an extension we really don't offer).
- **Ledger:** 359 rows; built 276 full / 62 partial / 21 blocked; tested 158 full / 80 partial / 121 untested; per-suite 657/658. Tails: 39 rows, 9/10/20 (unchanged).
