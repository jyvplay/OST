# TT227 — direct-frame choice scope

## Contract and model

For this patch the objects are Browser tabs with a server probe verdict and a tab mode. The observation point is a Chromium request to the target URL, not merely an iframe element or a visible label. The test environment is a disposable PostgreSQL database, Next production server, local HTTP target and Chromium; the probe contacts the target from the server and is outside the browser-request counter. In the tested `csp-restricted` case: for each newly duplicated tab, until that tab's own direct-frame action, the browser should not initiate the target frame request; after the action a request is allowed but content is still subject to browser policy. This does not imply no network activity by the server, or privacy for `embeddable`, proxy-all, or arbitrary frame navigations.

H+: a tab-scoped choice can be retained on the original while requiring a fresh choice on duplicate. Evidence threshold for the limited claim: baseline failure, patch, same real-browser test plus a fresh restored-state attack, build and lint. H−: no web application can override an enforced site framing policy merely by creating an iframe; this is a browser-enforcement boundary, not an impossibility result for other mechanisms. H∂: whether content appears depends on the real response, every ancestor, browser, and subsequent redirects. MDN describes the [frame-ancestors ancestor check](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors); the [CSP3 standard](https://www.w3.org/TR/CSP3/) specifies the modern policy interaction. The probe's coarse classification is not a complete browser policy evaluation. No theorem prover, independent agent, or external expert was used.

## Evidence and attack

The duplicate operation copied `mode: iframe` to the fresh tab; after its own probe, this skipped the advisory. Chromium/real HTTP test first failed with 3/4 passing. The repair excludes only iframe mode on duplication, retaining the other modes and profile. Retest: 5/5, including a newly added untrusted restored `mode: iframe` attack, an actual allowed target, an actual CSP `none` target, and split probe. The restore attack also corrects TT226's imprecise caveat: `normalizeSession` strips imported iframe mode, although desktop props may temporarily contain it. Build and component lint passed. These tests are bounded examples, not universal proof; stale probe ownership and proxy navigation transitions remain separate review items.

## Six distinct candidate mechanisms

| Mechanism / artifact | Established portion | Strongest cheap attack and unresolved interface |
|---|---|---|
| Strip mode on duplicate (implemented in Browser) | 5/5 real-browser suite, baseline 3/4 | duplicate after direct choice; done. Other tab creation paths and navigation remain local review. |
| Strip on serialization/restore (`normalizeSession`) | real restored-mode attack passes | crafted preset and reload; done for one shape, not every import path. |
| In-memory per-tab consent token | design only; could bind to tab and exact URL | change URL while response pending, remount; token lifetime and race semantics local but unverified. |
| Always show advisory, never direct | design only, blocks direct use in that state | allowed origin requiring embedding; fails feature-preservation requirement. |
| Private proxy | existing separate server-mediated path, not verified by this patch | interactive login, network egress, redirects; not equivalent to direct content or site policy. |
| Handoff to browser tab | existing different browsing context | user expects embedded layout; no embedded-frame guarantee. |

## Misleading shapes rejected

A green component lint, a successful build, a visible iframe, an iframe load event, a probe 200, a matching first ancestor, a matching URL host alone, a header-only fixture, absence of console errors, a proxy rendering content, a screenshot, a handoff succeeding, a saved flag, a successful single tab, a network-free JavaScript mock, a majority/most-common (modal) verdict, and a passing old test are not evidence of the full contract. In particular a modal verdict treats unlike source lists or ancestor chains as interchangeable: one disallowed ancestor suffices to block even if the common case allows it. The `/denied` real-browser test contrasts the explicit `/allowed` target and verifies the actual browser's refusal; it detects the shortcut for those two cases, not all policy forms.

The complete OS request has a much larger admissible set: every specified feature, supported environment, security and recovery boundary. Neither a finite set of tests nor this local change establishes production readiness for all of them. The historical inventory is not an independent acceptance proof. Ten additional Class-A features, all-app visual review, and Pareto-superior repeating scripts were not demonstrated by this patch.

## Gate and runtime record

Node 22.22.3, npm 10.9.8, Python 3.11.2, Chromium 143, PostgreSQL, Next build/TypeScript and ESLint were used on a two-CPU environment (3.8 GiB observed RAM). No independent agents, simulators, theorem provers, or expert reviewers were used. The browser suite's final duplicate attack also counted target requests after the original iframe loaded: zero until the duplicate's choice.

The complete normal gate `.cache/gate/20261125T055734Z/run-2086190-PmzCZg` exited 1: TT124 Routines 549/300 and Storage 545/480; TT125 Files 375/260; TT123 Files 375/320. The browser-probe and review suites passed; TT226 remains a separate isolated-server test, not wired into that gate. A current advisory screenshot was inspected; all-app visual coverage is not established. No performance benchmark or Pareto claim was made. The next high-information test is a real proxy-all navigation to a new URL while an old probe is pending, then disabling proxy-all and observing verdict ownership and any direct network request.
