# TT42: computed imports, browsers without Fetch Metadata, srcdoc frames, live proxy failover, DHCP WPAD

TT41 left a list of browser-proxy blockers. TT42 closed these:
- **WP-20 (new):** `import()` of a path computed at run time — in module workers, with a colon in the first segment, absolute cross-origin, `new URL(…, import.meta.url)` — plus import-map *scope* twins, plus the lexer's function/class-expression blind spot.
- **WP-21 (new):** browsers that send no Fetch Metadata (Safari < 16.4).
- **WP-19 upgrade:** iframe `srcdoc` frames (static and set by script).
- **WP-14 upgrade:** WebSocket proxy failover and SOCKS4a, both now **live** against independent servers.
- **WP-15 upgrade:** WPAD from DHCP option 252 — lease files and a real DHCPINFORM exchange.

Everything shipped is original code. Prior art read for edge cases only (es-module-lexer for lexer shapes, RFC 2131/2132 and draft-ietf-wrec-wpad-01 for DHCP). Nothing was copied.

## Runtime honesty

**What ran:** all in the Arena Linux sandbox:
- Node 22.22.3, Next 16.2.6 (production builds; :3999 for the suite, a private `next start` on :3993 for e2e-tt42);
- Playwright 1.64.1, headless Chromium;
- acorn 8 (repo node_modules) and V8 itself (node:vm) as lexer oracles;
- Python 3: websockets 13.1 (WS echo servers), pproxy (HTTP / SOCKS5 proxies), **asyncssh 2.24.1** (EPL-2.0 OR GPL-2.0 — **test-only**, in /home/user/tools/venv, never shipped) as an independent SOCKS4a server (`forward_socks` over a real SSH connection);
- **busybox 1.36.1 udhcpd** (GPL-2.0 — **test-only**, a system binary, never shipped) as an independent DHCP server, inside a real network namespace (`ip netns`, a veth pair) using passwordless sudo.

**Network:** pypi.org (the one reachable public host) for the proxy and DHCP tests; every other "site" is a local HTTP/TLS server on 127.0.0.1 / 127.0.0.2 / 10.42.0.1.

**Not available, so not tested:** Firefox, Safari (the WP-21 test *emulates* a Fetch-Metadata-less browser by stripping the headers in front of real Chromium), real phones, Windows / macOS / GNOME / KDE desktops, a real DHCP client daemon (the lease-file test writes real-format lease files itself), a cross-tab SharedWorker, HTTP/3 / QUIC (Node 22 has no QUIC API).

## A. Formal model

**Segment** `<sid>:<doc>:<i|s|o>[m][t][x][y][n][e]`, `:r` for no-cors, `:f` for frames. `e` (new) = "the page's own fetch()/XHR" — read **only** when the request carries no `Sec-Fetch-Dest`/`Sec-Fetch-Mode`.

**Destination inference** `inferDest(headers, seg) → {dest, mode} | null`:
- any Fetch Metadata present → `null` (the browser's own headers win);
- `f` → `iframe/navigate`; script tag `i|s|o` with `e` → `empty/cors`, without → `script/cors`;
- `r` → by Accept: `image/*` → image, `text/css` → style, else script (no-cors);
- untagged → `text/html` first in Accept → `document/navigate`, else by Accept.

**Computed import wrapper** `W(x) = import(R(x))` where `R`:
1. `s = ToString(x)` once (a throwing toString/Symbol: pass `x` through untouched so `import()` rejects natively);
2. `s` URL-like (`/`, `./`, `../`, or `scheme:`) → `u = new URL(s, realBase)`; bare → unchanged (import maps apply);
3. `u` http(s) and not already a proxy URL → `encodeTarget(u)` under the script's own segment; else unchanged.
Invariant: for every literal `s`, `R(s) = rewriteSpecifier(s)` (checked on 20 values).

**Scope twins:** for every scope `S` and inner key `k` that starts with the site root `R`, add `"/" + k.slice(|R|) → v` unless present. Scope *keys* get none (matched against the referrer, always a proxy URL).

**srcdoc:** static: `rewriteHtml(srcdoc, {…parent, srcdocDepth+1})`, depth < 3, runtime tagged `data-srcdoc="1"`. Dynamic (property or setAttribute): shim parses into an inert DOMParser document, fixes URL attributes, recurses into nested srcdoc, prepends its runtime; markup already carrying it is unchanged (idempotent). In srcdoc, the runtime resolves against `document.baseURI`.

**WPAD order:** DHCP (lease files newest first: dhclient `option wpad|unknown-252`, networkd/NM-internal `OPTION_252=<hex>`; then DHCPINFORM per IPv4 interface if UDP 68 binds) → DNS candidates (`wpad.<domain>` devolution). Lease grammar: the LAST `lease { }` block is current; values with `\ooo`/`\"` escapes or colon-hex; trailing NUL trimmed; only `http(s)://` accepted.

**DHCPINFORM** (RFC 2131 §3.4/§4.4.3): BOOTREQUEST, `ciaddr` = the interface address, broadcast flag, options 53=8, 61 (client id), 55={252}, 255; sent from port 68 to the subnet broadcast:67; accept only BOOTREPLY + matching xid + magic cookie + message type 5 (ACK) carrying 252.

## B. Hypotheses

- **H+1:** computed-import wrapping makes all 13 WP-20 probes identical to native. *Confirmed* (TT41 build: 7 differ; TT42: 0).
- **H+2:** without Fetch Metadata, inference from URL tag + Accept restores module rewriting and secret fencing. *Confirmed* (15/15 identical, fetch of a document gets no secret).
- **H+3:** a real DHCP server's option 252 can be fetched without a DHCP client daemon by DHCPINFORM. *Confirmed* live against busybox udhcpd.
- **H−1:** "a srcdoc frame is just a document; the runtime can share the parent's state." *Refuted*: it inherits the CSP sandbox → its own opaque origin; `parent.document` is a SecurityError through the proxy (declared limit).
- **H−2:** "TT41's lexer was fail-safe." *Refuted*: `x = function () {} / 1; import('dep.js')` gave **no** specifier silently (verified on the TT41 commit). Corrected in the WP-17 row.
- **H∂1:** Safari's real Accept strings for module scripts (`*/*`) vs images (`image/webp,…`) suffice to tell destinations apart. *Partly*: media and fonts also send `*/*` → classed as script (harmless: script rules are the stricter ones; never the navigation secret).

## C. Frontier (now possible that was not)

- Run-time-built module paths in module workers (where no browser applies import maps) route correctly.
- Modules work on Fetch-Metadata-less browsers, and a page fetch() there no longer receives navigation secrets.
- Widgets in `srcdoc` (embeds, editors' preview frames) load their images/scripts/modules through the proxy.
- WPAD on networks that publish the PAC URL by DHCP only (the common enterprise setup) — the first DHCP source has priority as in Windows/IE's WinHTTP auto-detect order.

## D. Negative shapes (≥ 15) and the modal-shortcut test

1. `x = function () {} / 1; import('dep.js')` — division, specifier found (the TT41 silent miss).
2. `x = class {} / 1` — division.
3. `function f() {} /re/.test(s)` — declaration: regex.
4. `x = async function () {} / 1` — acorn mis-lexes; V8 parses division (V8 is the arbiter).
5. `(function () {}) / 2` vs `{ } /re/` (block then regex).
6. `obj.import(x)` / `a?.import(x)` / method `import(x) { }` — not wrapped.
7. `import(x)\n{` (call + block by ASI) — not wrapped (disclosed; falls back to the import map).
8. A Symbol / throwing toString passed to import() — rejection identical to native.
9. A computed value that is already a proxy URL — not double-wrapped.
10. `data:` / `blob:` / bare specifiers — unchanged.
11. A forged `e` flag on a request that HAS Fetch Metadata — ignored.
12. Untagged request with Accept `text/html` but Sec-Fetch-Dest `script` — the header wins.
13. Old server + new shim flag `e` — refused as "bad session id" (version skew documented: deploy together).
14. srcdoc nested deeper than 3 — left alone (bounded recursion).
15. srcdoc already carrying our runtime — unchanged (idempotent; no double injection).
16. dhclient lease with an older block holding a stale URL — the last block wins.
17. Lease value `file:///etc/x` — rejected (only http/https).
18. DHCP reply with a foreign xid, a BOOTREQUEST, or a bad magic cookie — ignored.
19. No bindable port 68 (non-root) — INFORM silently skipped, leases and DNS still tried.
20. Option 252 URL that does not answer — next candidate tried; the DHCP source is still recorded.

**Modal-shortcut test:** "every check passes because both runs use the proxy" — no: the native runs load directly from A/B; the no-FM run goes through a separate HTTP front that demonstrably removed 63 Sec-Fetch-* headers (asserted > 20); the DHCP test's PAC URL exists *only* in udhcpd's configuration, so a passing discovery proves the DHCP exchange happened. And every mechanism has a killed mutant (§I).

## E. Mechanism-distinct approaches considered

1. **Inline wrapper at each computed import()** (chosen) — works in workers and with colons; needs a correct lexer.
2. **Import-map-only routing** (TT41) — impossible in workers, impossible for colon segments.
3. **Service worker interception** — rejected: proxied documents are opaque-origin sandboxed (no SW), and it would move the whole proxy into the client.
4. **Patching `import` via a global hook** — impossible: `import()` is syntax, not a function.
5. **Inference from Referer** for no-FM browsers — rejected earlier (Referer policy can strip it; leaks).
6. **Header inference from URL tag + Accept** (chosen) with a shim-set `e` flag.
7. **srcdoc → blob/data URL frames** — rejected: changes origin semantics and `location` further.
8. **srcdoc rewritten server-side + shim DOMParser** (chosen).
9. **DHCP via a helper daemon (dhclient -w / NetworkManager D-Bus)** — not present in many systems; D-Bus API is GNOME-specific; rejected as primary.
10. **Lease files + DHCPINFORM** (chosen) — no daemon dependency.

## F. Artifacts

- `src/lib/js-imports.ts` (expression context, `computed`), `src/lib/wp-core.ts` (`dynImportWrap`, scope twins, srcdoc), `src/lib/wp-cors.ts` (`e`, `inferDest`), route.ts (`hdrDest`/`hdrMode`), `public/wp-shim.js` (`e` tag, srcdoc), `src/lib/server/dhcp-wpad.ts` (new), `wpad.ts` (`first`), `wp-route.ts` (DHCP wiring, `dhcp` in route info), `src/db/seed-data/features-tt42.ts` (seed 3.31.0).
- Tests: `scripts/tt42-unit.mts`, `scripts/e2e-tt42.mts`, `scripts/tt42-proxy.mts`, `scripts/tt42-dhcp.mts`; fixtures `scripts/fixtures/ws/ws-failover-probe.mts`, `scripts/fixtures/ssh-socks.py` (test-only, asyncssh); oracle `scripts/oracle/dynwrap-diff.mts`.
- Env: `FUSION_WP_WPAD_DHCP=0` (skip DHCP), `FUSION_WP_WPAD_INFORM=0` (lease files only).

## G. Adversary findings (this turn)

- **The srcdoc opaque-origin limit** (found by the test, not by design): proxied srcdoc frames cannot touch `parent.document`. Editors built on about:blank/srcdoc + `contentDocument` (TinyMCE-style) are affected. Disclosed, not papered over.
- **TT41 over-claim:** the lexer's "never mis-rewritten" was false for one shape; corrected in the register.
- **Second-order:** a page script on a no-FM browser can omit `e` — it then gets script rules, never more than before TT42. A LAN attacker able to answer DHCP can set option 252 — the same trust the OS already gives DHCP; WPAD is opt-in (`FUSION_WP_WPAD=1`), and the PAC runs in the existing sandboxed evaluator.
- **Test harness defect found by a mutant:** one failed observation aborted the whole e2e suite (later tests never ran); fixed so each test fails on its own.

## H. External verification

- Chromium (native vs proxied, and behind a Fetch-Metadata-stripping front).
- acorn 8 over 12,443 real files; V8 executing rewritten scripts.
- Python websockets echo servers, pproxy HTTP/SOCKS5, asyncssh SOCKS (4a by name).
- busybox udhcpd answering a DHCPINFORM inside a network namespace.

## I. Repair, then a new attack against the repair

| Mutant | Killed by |
|---|---|
| dynamic-import wrap off | tt42-unit (V8 executes the rewrite) |
| function-expression context off | tt41-unit (15 shapes) |
| destination inference off (unit) | tt42-unit |
| destination inference off (route, build) | e2e-tt42 WP-21 (module null) |
| scope twins off (build) | e2e-tt42 WP-20 (`evalScoped` only) |
| server-side srcdoc off (build) | e2e-tt42 WP-19 (static inline module null; dynamic frames still OK — attribution exact) |
| DHCPINFORM off | tt42-dhcp INFORM test |
| lease parsing off | tt42-dhcp lease test |

Attack on the repairs: the DHCP repair was first "verified" with the test's PAC server blocked by a synchronous exec in the same process (false failure, found and fixed); the source list is now recorded even when no PAC answers (it was lost on failure — repaired).

## J. Stopping

Stopped because the targeted TT41 blockers are closed and verified against external oracles, every new mechanism has a killed mutant, and the full suite has been run. Not reached (listed in the PR body): cross-tab SharedWorker, QUIC, srcdoc parent access, non-Linux DHCP sources, Firefox/Safari/mobile runs.

## Results (this turn)

**Full run** (78 suites, clean production build e_-tklmOXvOs6fzKemtzC on :3999): first pass **707/708**. The one failure was tt35-unit's live-web test: pypi.org now serves this sandbox's IP a bot "Client Challenge" interstitial for /project/requests/ (3 same-site URLs), so the test's "≥ 20 outside URLs" precondition could not hold. Repaired in the TEST (not the code under test): challenge pages are recognised and logged, their leak / tag checks still run, and the precondition and "≥ 3 pages" count apply to real pages only. Re-run 13/13 → **708/708**.

**Ledger: 708/708, 367 rows, built 284/62/21, tested 166/80/121; Tails 39 rows: 9 full / 10 partial / 20 none (unchanged).**

| Suite | Result |
|---|---|
| tt42-unit | 6/6 |
| e2e-tt42 | 3/3 (WP-20 13 values, WP-21 15 values + 63 headers stripped, WP-19 srcdoc identical) |
| tt42-proxy | 2/2 (WS failover live; SOCKS4a live) |
| tt42-dhcp | 2/2 (lease files; real DHCPINFORM with busybox udhcpd) |
| tt41-unit / e2e-tt41 | 9/9 / 4/4 |
| tt40-unit / tt40-proxy / e2e-tt40 | 17/17 / 4/4 / 3/3 |
| tt39-unit / tt39-pac / e2e-tt39 | 13/13 / 8/8 / 7/7 |

**Oracles:** dynwrap-diff 12,443 files parsed, 69 computed imports, 0 disagreements, 59 files wrapped; acorn lexer differential 0.

**Visual:** no UI surface changed this turn (proxy internals and a register update); e2e-beauty and the layout suites passed in the full run.
