# TT40: LY-22 fixed, more proxy kinds with failover, auto-detect / WPAD / KDE, SameSite for subresources

TT39 left a list of blockers. TT40 first finished the LY-22 failure, then closed three groups of proxy blockers:
- **WP-14:** proxy kinds and failover;
- **WP-15:** auto-detect, WPAD and KDE;
- **WP-16:** cookies, Sec-Fetch-Site and Referer for images, scripts and stylesheets.

All of it is original code. Nothing in the shipped path is third-party.

## Runtime honesty

**What ran:** everything here ran in the Arena Linux sandbox. That includes:
- Node 22 and Next 16.2.6 (production build on :3999, plus private `next start` servers on :3991 for e2e-tt40);
- Playwright 1.64.1 driving headless Chromium;
- Python 3 with pproxy (as SOCKS4 / SOCKS5 / HTTP / TLS proxy), pypac 0.19.0 (Apache-2.0) and dukpy;
- npm `socks` 2.8.10 (MIT), installed outside the repository at /home/user/tools/oracle-npm as a byte oracle;
- `sudo -n`, used to edit /etc/hosts and /etc/resolv.conf. Both are restored from backups by the test.

**Network:** the only outside host reached is pypi.org (allowed egress). Every other "site" is a local server on 127.0.0.1 / 127.0.0.2.

**Not available, so not tested:**
- real Windows, macOS, GNOME or KDE desktops. Their settings formats were written from documentation into fixtures, with a stand-in `gsettings`;
- phones, IPv6 egress and DHCP;
- a live SOCKS4a server (pproxy's SOCKS4 server lacks 4a);
- live WebSocket failover.

## A. Formal model

**Routes.** A route is one of:

    DIRECT | HTTP h:p | HTTPS h:p (TLS to proxy) | SOCKS4 h:p | SOCKS4A h:p | SOCKS5 h:p

PAC `SOCKS` means SOCKS4, as in Chrome. The Windows `socks=` value means SOCKS4 unless it is written `socks5://`.

A request has an ordered candidate list `L`:
- **Failover:** the request tries `L[i]` in order. It moves to `L[i+1]` **only** when `L[i]` is unreachable: DNS, TCP connect, TLS to the proxy, a broken SOCKS reply, or a proxy that closes before answering.
- **No failover on answers:** a proxy that *answers* (CONNECT 403, SOCKS refusal 91, HTTP 502 from the proxy) ends the request. This is Chromium's rule since M67, and it prevents a fall to DIRECT that would leak the request.
- **Bad-proxy memory:** an unreachable proxy is moved to the end of every list for 300 s. It is not removed.

**Auto-detect.**
- `wpadCandidates(searchDomains)` yields `wpad` and then, for each search domain D, `wpad.<suffix>` for every suffix of D that is **at least** the registrable domain of D.
- A candidate is accepted when GET `http://<name>/wpad.dat` returns 2xx with a body that defines `FindProxyForURL`.
- The first accepted file becomes the PAC file. When nothing is found, the result is DIRECT, plus any manual proxy as a fallback.

**Subresources.** A document `d` has an origin `O(d)` and a referrer URL `U(d)`. For a stylesheet, `U` is the stylesheet's own URL. A markup subresource request `r` of `d` targeting `T` is processed as follows:
- **Cookies:** `cookies(r) = { c ∈ jar(T) : sameSite(O(d), T) ∨ c.SameSite = None }`;
- **Sec-Fetch-Site:** same-origin, same-site or cross-site, from `O(d)` vs `T` (schemeful);
- **Referer:** strict-origin-when-cross-origin from `U(d)` to `T`, giving the full URL without fragment or credentials, the origin, or nothing on https→http;
- **Storage:** a cross-site response may store only SameSite=None cookies.

A navigation is never treated as a subresource.

## B. Hypotheses

**H+ (must hold, all tested):**
- SOCKS4/4a bytes equal an independent client's.
- SOCKS4 never sends the destination name; the name is resolved here and goes through the public-address guard.
- The HTTPS proxy refuses TLS without trust, and it does so before revealing the destination.
- PAC failover carries a large POST byte-exact. A proxy that answers 403 is not failed over.
- WPAD finds the corporate file through the real resolver.
- For every subresource kind, native Chromium and the proxy show identical cookies, Sec-Fetch-Site and Referer.

**H− (must not hold):**
- WPAD queries a name at or above a public suffix (`wpad.com`, `wpad.github.io`, `wpad.co.uk`).
- A forged document id gains Lax/Strict cookies.
- A subresource tag on a navigation strips a navigation's cookies.
- A script fetch() of a tagged URL is treated as markup.

**H∂ (partial, disclosed):**
- QUIC is not spoken.
- DHCP option 252 is not read.
- Same-site is judged against the document, not every ancestor frame.
- Browsers without Fetch Metadata are not filtered.

## C. Frontier (what is now possible that was not)

- An office network that hands out "Automatically detect settings" now works without anyone typing a PAC URL. So does a network whose PAC lists `HTTPS proxy:443; SOCKS fallback:1080; DIRECT`, or a KDE desktop.
- A dead first proxy no longer breaks the Private browser.
- A proxied page's images, scripts and stylesheets no longer leak Lax/Strict cookies to third parties. This closes the TT39 WP-10 deviation.
- The Tabletop wall double-click works on the first try (LY-22).

## D. Negative shapes (≥ 15) and the modal-shortcut test

**The 18 negatives:**
1. SOCKS4 with an IPv6 target: refused before any byte.
2. Plain SOCKS4 with a hostname: refused.
3. A NUL byte in the SOCKS4 user id: refused.
4. A 256-byte SOCKS4a host: refused.
5. A SOCKS server that answers with a SOCKS5 reply: classified "broken proxy", so failover applies.
6. SOCKS4 refusal 91: an answer, so no failover.
7. A short SOCKS4 reply: broken.
8. A silent SOCKS4 server: times out, so the proxy is down.
9. An HTTPS proxy with an untrusted certificate: refused at TLS, and the destination is never sent.
10. A PAC list with only `QUIC`: refused, not silently DIRECT.
11. A proxy that answers CONNECT 403: no failover, no DIRECT leak.
12. A public-suffix search domain (`github.io`, `co.uk`): no `wpad.<suffix>` probe. **Found a real hole.**
13. A WPAD 2xx answer that is not a PAC file: ignored.
14. No WPAD found anywhere: DIRECT, with the tried names reported.
15. A forged document id on a subresource: SameSite=None cookies only.
16. A script fetch() of an `r`-tagged URL: re-tagged by the shim and follows the script rules.
17. An `r` tag on a navigation: ignored. **Found a real defect.**
18. A cross-site image setting `SameSite=Lax`: not stored, exactly as natively.

**Modal-shortcut test:** the shortcut is "send the whole jar for subresources", which was TT39's behaviour. It was re-introduced as a mutant and rebuilt. e2e-tt40 failed 3/3 against it: the oracle showed `cs` natively carrying `b=1` only. The other mutants:
- M1 (failover disabled) and M2 (bad-proxy memory disabled), both killed by tt40-proxy;
- the e2e oracle's own non-vacuity test, which checks that each cookie class and each Sec-Fetch-Site value actually occurs.

## E. Mechanism-distinct approaches considered

1. **Per-request tag in the URL segment (`<sid>:<doc>:r`), set by the server-side HTML / CSS rewriter and by the shim for dynamic elements. Chosen.** This is the only mechanism that survives the opaque-origin sandbox, where the browser always says same-origin to the proxy.
2. **The browser's own `Sec-Fetch-Site` / `Sec-Fetch-Dest` alone.** Rejected: through the proxy every request is same-origin. `Sec-Fetch-Dest` is used only to *gate* the tag, so that a tag is honoured only on real subresource loads.
3. **Referer-based initiator inference.** Rejected (already in TT37): the page controls its own Referer policy.
4. **One cookie jar per top-level site (partitioning).** Rejected: it is not what browsers do for first-party subresources, and it would break same-site logins.
5. **A ServiceWorker that classifies requests.** Unavailable: opaque-origin pages cannot register one in any browser.
6. **Failover:**
   - Chosen: a candidate list with connection-level classification.
   - Rejected: retrying any error, which would fall to DIRECT on a 403 and leak; and parallel racing, which leaks the destination to every proxy.
7. **WPAD:**
   - Chosen: DNS devolution with a registrable-domain floor.
   - Rejected: DHCP option 252, which needs privileged raw DHCP; and an mDNS guess, which is non-standard.

## F. Artifacts

**Code:**
- **Proxy core:** src/lib/server/wp-tunnel.ts, wp-connect.ts, wp-route.ts, wp-fetch.ts, wp-ws.ts, osproxy.ts, sysproxy.ts, wp-sessions.ts, and the new **wpad.ts**.
- **Shared libraries:** src/lib/wp-core.ts, src/lib/wp-cors.ts.
- **Route and shim:** `src/app/api/wp/s/[sid]/[...rest]/route.ts`, public/wp-shim.js.
- **LY-22:** src/components/Tabletop.tsx.

**Tests:**
- **scripts/tt40-unit.mts (17):** route parsing, SOCKS4 bytes against npm socks, TLS, PAC mapping, memory, classification, OS parsers, WPAD and WP-16 rules.
- **scripts/tt40-proxy.mts (4, live):** pproxy, pypi.org, sudo-edited resolver.
- **scripts/e2e-tt40.mts (3):** a native Chromium oracle, non-vacuity, and the adversary checks.
- **Updated:** tt37-unit / tt39-pac, whose assertions of the old limits were changed to the new behaviour.

**Environment and ledger:**
- scripts/sandbox/bootstrap.sh installs the npm `socks` oracle.
- **Seed rows:** src/db/seed-data/features-tt40.ts (WP-14, WP-15, WP-16, plus patches to WP-10, WP-12 and LY-22), with SEED_VERSION 3.29.0.

## G. Adversary findings (this turn)

1. **WPAD squatting.** A DNS search domain that is itself a public suffix (e.g. `github.io`) made the candidate walk offer `wpad.github.io`, which anyone can register and use to serve a PAC file routing all traffic. This is the classic WPAD attack. **Fixed:** a floor at the registrable domain via isPublicSuffix, with negatives for com, co.uk, github.io and single labels.
2. **Stylesheet-initiated Referer.** Chromium sends the *stylesheet's* URL as the Referer for images a stylesheet loads, while Sec-Fetch-Site still follows the page. The proxy sent the page origin. **Fixed:** child documents, with the page origin for SameSite and the stylesheet URL for Referer. The oracle now matches.
3. **Tagged navigation lost its cookies.** A navigation carrying an `r` tag fell into the script-request path, because a document id was present, and went out with no cookies and `Origin: null`. **Fixed:** an `r` tag is ignored on anything the browser calls a navigation.
4. **LY-22 root cause.** Pressing a wall focused it. The focus lift moved the wall from under the pointer, so the second click hit the floor. **Fixed:** the lift now happens on `:focus-visible` only, and a press cancels a pending hover lift.

## H. External verification

| Oracle | What it checked |
|---|---|
| npm `socks` 2.8.10 (independent SOCKS client) | Request bytes: 4/4 identical |
| pproxy (independent SOCKS4 / TLS / HTTP proxy) | Live routes to pypi.org; its log shows only an IPv4 address for SOCKS4 |
| The machine's real glibc resolver, via /etc/hosts and resolv.conf | WPAD discovery |
| Headless Chromium itself | The native side of the WP-16 differential: 7 subresources plus the resulting jar |
| e2e-tt39's 27-request CORS differential | Still 0 differences after WP-16 |

## I. Repair, then a new attack against the repair

**WPAD floor.** The repair was attacked with multi-label suffixes (`co.uk`) and private suffixes (`github.io`). Both are refused.

**Stylesheet child documents.** The repair was attacked with a forged / unknown id, which is kept as-is: the "cross-site with only None cookies" floor still applies, and the forged test passes. The ordering race found while doing this was a *test* defect: the cookie-setting image raced the stylesheet's image. It was fixed by creating that image from page script after all other loads. That step now also exercises the shim's tagging of dynamic subresources, and is stable over 3 consecutive runs.

**Navigation tag.** The repair was attacked by checking that ignoring the tag cannot *escalate*. An untagged navigation already receives the full jar, which is the TT39 behaviour and correct for a top-level view.

## J. Stopping

The turn stopped because the targeted blockers are closed and verified against external oracles, and the full suite has been run. The ones not reached are listed under "Remaining blockers" in the PR body. Workers, redirect taint, Response.url and the 8-bit deflate window are untouched this turn and were not claimed.

## Results (this turn)

Full run (72 suites, production build on :3999): first pass 679/682. The 3 failures:
- two old assertions of TT39-era behaviour that TT40 changed on purpose: e2e-tt37 expected the old route-parser wording; tt39-pac expected the old Windows command list without the auto-detect flag. The assertions were updated;
- one tt39-unit Python WebSocket server start flake, on unchanged code.

Re-run of those 3 suites: all pass. **Ledger: 682/682, 362 rows, built 279/62/21, tested 161/80/121; Tails 39 rows: 9 full / 10 partial / 20 none.**

| Suite | Result |
|---|---|
| e2e-tt34 (LY-22) | 5/5 |
| tt40-unit | 17/17 |
| tt40-proxy | 4/4 |
| e2e-tt40 | 3/3 (×3 consecutive) |
| e2e-tt39 | 7/7 |

Mutants: subresource whole-jar, failover off and memory off were all killed.
