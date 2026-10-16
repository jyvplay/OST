# Browser-engine and sandbox research: getting past the gates honestly

## 0. Runtime honesty

Tools used: `bash`, Playwright 1.49 + real headless Chromium 131 (installed and launched
multiple times this session, including a controlled experiment comparing three Chromium
launch-flag configurations), Node's `fetch`/`dns`/`net` built-ins, the project's own
`writeZip`. No claim below about production-container behaviour (specifically, §C.3 /
mechanism B4's Chromium-binary availability) is asserted beyond what `build_and_start`
actually reports this turn — see that tool's output appended to this session's final
validation, not duplicated here.

## A. Formal model

**Admissible objects.** (i) An arbitrary external URL a user wants displayed inside the
Fusion desktop. (ii) An arbitrary user-authored "widget" (small piece of code) placed in the
VFS, which the shell runs continuously on the desktop surface.

**Information/access model.** The Fusion app is a single-origin PWA with zero special
browser permissions beyond what a normal web app can request. It cannot install a browser
extension, cannot modify the target site's server, and cannot assume any particular Chromium
command-line flag in a user's real browser (those flags are our OWN test harness's choice,
never something we can impose on an actual visitor).

**Resource counted.** For the browser problem: number of mechanism-distinct, genuinely
different ways to get THIRD-PARTY CONTENT onto the Fusion desktop when direct `<iframe>`
embedding is refused. For the sandbox problem: whether "a widget cannot freeze the shell" is
TRUE BY SPECIFICATION (holds in every conformant engine) or merely true as an empirically
observed, configuration-dependent fact (which is what we found last turn for the iframe path).

**Success/failure, explicit quantifier order.** Browser: for the target set of "sites that
refuse iframing," there exists at least one of {same-origin proxy, reader extraction,
out-of-process render} that displays SOME useful representation, with the exact information
lost by each declared. Sandbox: for ALL possible widget code (including adversarial
`while(true){}`), the main thread's responsiveness must be provably unaffected — "provably"
meaning derivable from the HTML/ECMAScript specification, not merely "we tested it and it
happened to work in this Chromium build."

**Adjacent problems NOT substituted.** "Can render a static picture of a page" ≠ "can embed
an interactive page" (declared, not conflated — mechanism B4 is explicitly non-interactive).
"Works in our Playwright-driven test" ≠ "works in every real visitor's browser" (sandbox
claims are scoped to what the relevant WEB SPECIFICATION guarantees, which is strictly
stronger than "worked in the one engine we tested," though we only have one engine to test
empirically against).

## B. Outcome space

- **H+:** mechanism-distinct alternatives to iframe-embedding exist and are implementable
  with zero new production dependencies for two of three (proxy, reader) and a probe-gated
  optional third (render). **Achieved.**
- **H−:** a sandboxed iframe can be made UNCONDITIONALLY non-freezing using only HTML-spec
  guarantees. **Impossible** — process allocation for sandboxed iframes is a Chromium
  performance heuristic (Site Isolation), not a spec requirement; no amount of `sandbox=`
  attribute tuning changes this, confirmed experimentally (§C).
- **H∂:** whether a GIVEN widget needs arbitrary DOM (requiring the iframe path, with its
  configuration-dependent isolation) or can be expressed as structured data (enabling the
  Worker path, which IS spec-guaranteed) depends on the widget's own requirements — both
  paths are kept, correctly scoped.

## C. Frontier — results imported and verified, with the exact open interface

1. **"The `sandbox` attribute on an iframe isolates untrusted content."** True for
   *capability* restriction (the HTML spec guarantees navigation/script/form restrictions),
   **false** for *performance/responsiveness* isolation, which the spec never promises.
   Verified by direct experiment (not assumed): launching real Chromium 131 three ways —
   default flags, `--enable-features=IsolateSandboxedIframes`, `--site-per-process` — and
   hanging a `sandbox="allow-scripts"` iframe with `while(true){}`:
   ```
   []                                           -> SAME THREAD (shell frozen)
   ["--enable-features=IsolateSandboxedIframes"] -> SAME THREAD (shell frozen)
   ["--site-per-process"]                        -> ISOLATED (shell responsive)
   ```
   This matches and extends last turn's finding (which only tested default vs.
   `--site-per-process`): even the feature flag that sounds like it should fix this
   (`IsolateSandboxedIframes`) does not, in this engine version, change the outcome.
2. **HTML Living Standard, Web Workers §10:** a dedicated worker "must... run... in parallel"
   and `Worker.terminate()`'s algorithm unconditionally sets the worker's `[[Terminated]]` flag
   and aborts its event loop — this is NOT contingent on any site-isolation feature; it is how
   every conformant implementation must behave for ANY worker, because workers are specified
   to execute on an independent agent from the start, unlike same-origin iframes whose process
   placement is an engine-internal optimisation choice. We rely on this distinction directly.
3. **`X-Frame-Options`/CSP `frame-ancestors`** (RFC/W3C-adjacent, widely implemented): enforced
   by the browser against the HTTP response's own origin. A same-origin proxy that re-serves
   fetched bytes from OUR origin structurally removes the only signal the browser checks —
   confirmed by implementation (§F), not merely asserted.

**Exact open interface:** there is no web-platform primitive that gives a *third-party,
cross-origin* iframe BOTH full DOM/interactivity AND a spec-guaranteed responsiveness
isolation at the same time. Getting both requires either (a) the TARGET site's cooperation
(it must not send framing-refusal headers), or (b) giving up one of the two properties (proxy
mechanisms give up authenticated/interactive fidelity; render-snapshot gives up interactivity
entirely; Worker-based widgets give up arbitrary DOM). This is the real, structural boundary —
not a bug in our implementation.

## D. Negative space — 15 shapes that look like a fix and are not

1. "Add `sandbox="allow-scripts"` more strictly (remove `allow-same-origin`)" — reduces
   capability, does not change process/thread allocation; the hang test still freezes the
   shell under default Chromium (this is exactly what was tested last turn and falsified).
2. "Use `requestIdleCallback` inside the widget to yield periodically" — requires the
   widget's OWN code to cooperate; a hostile or simply buggy widget that never calls it is
   unaffected. Does not fix the adversarial case by definition.
3. "Poll `document.hidden` / a heartbeat and just hide the widget's DOM node" — this is what
   v3.2 already did (opt-in warning); it correctly DETECTS a hang but cannot UNFREEZE a main
   thread that is blocked inside the SAME iframe-hosted execution context when that context
   shares the thread (which is exactly the failure mode under default Chromium); the shell
   itself was still measured frozen, not just the widget.
4. **The modal shortcut: "just tell users to enable `--site-per-process` / use desktop
   Chrome."** Fails because (a) we cannot control a real visitor's browser flags, (b) Android
   Chrome — explicitly named as a target platform throughout this project's spec — does not
   run full Site Isolation the same way desktop Chrome does, and (c) Firefox/Safari have their
   own, different, independently-unverified isolation models. **Test that detects this
   failure:** run the exact hang test (`scripts/e2e.mts`, "characterisation" test) under the
   DEFAULT Chromium launch config with no special flags — it must still show the shell frozen
   for the iframe path (proving the modal shortcut does not generalise) while the Worker path
   passes under the same default config (proving the real fix does).
5. "Same-origin proxy fixes embedding, so just always use it instead of a direct iframe" —
   breaks authenticated/personalised content and same-origin JS the proxy can't rewrite
   generically; using it as the DEFAULT for sites that CAN be framed directly would be a
   regression (slower, lossier) disguised as a fix.
6. "Reader mode replaces the proxy" — reader mode cannot show non-article pages (apps,
   dashboards, search engines) at all; it is a third, narrower, complementary tool, not a
   superset.
7. "If the render-snapshot probe passes once, it will always pass" — the Chromium binary
   could be removed/fail between requests (container restart, disk eviction); treated as a
   live probe (`?probe=1`), not a cached-forever assumption, though it IS cached per-process
   for performance (a declared, bounded staleness window, not permanent).
8. Claiming SSRF-safety from "we check if the hostname LOOKS private" (string matching on the
   literal hostname) — insufficient, since `evil.com` can resolve to `127.0.0.1`. We resolve
   via real DNS (`node:dns/promises`) and check the RESOLVED address, including after
   following redirects (a redirect to an internal address is a classic SSRF bypass we
   explicitly re-check for).
9. "The proxy is safe because it's read-only" — a proxy can still be used to port-scan an
   internal network by observing response timing/errors across many hostnames; mitigated by
   the private-address guard, but declared as a residual risk class, not eliminated by
   assertion.
10. Assuming a worker-based widget is "safe" in the security sense (not just the liveness
    sense) because it's isolated — a worker CAN still be used to exfiltrate data IF given
    sensitive props; our protocol only ever sends `{now: Date.now()}` to widgets today, and
    the render-tree contract returns only text/color (no HTML/script channel back), bounding
    the blast radius by design, not by trust.
11. "Workers can't freeze the TAB, so the problem is solved" — a worker computing something
    genuinely expensive still consumes a CPU core and could cause battery/thermal effects
    (RG-01 governor territory); liveness of the MAIN THREAD is solved, resource fairness is a
    separate, not fully solved, concern (worker count is bounded by how many widgets a user
    adds, which is a reasonable, declared limit).
12. Treating the probe-gated render mechanism as "done" without actually running
    `build_and_start` against it — would be exactly the kind of unverified claim the task
    prohibits; resolved by checking the live platform build/start output (see final
    validation).
13. "Reader mode is just `innerText`" — naive text extraction loses structure (headings,
    lists, images); our extractor explicitly preserves a bounded, safe tag allowlist, verified
    by checking the output contains expected structural tags, not just non-empty text.
14. Believing the three browser mechanisms are interchangeable UI buttons rather than
    independently falsifiable — each has its OWN register row (WM-17/18/19) and its own
    distinct failure mode stated in the UI, so a user (or a future maintainer) can tell which
    one to blame when one breaks.
15. "This fixes the general 'can't run arbitrary native apps in a browser' limit" — it does
    not; these mechanisms only help with WEB CONTENT (HTML pages), not native application
    compatibility, which remains out of scope for the whole project (consistent with the
    original spec's negative space).

## E. Mechanism portfolio

**Browser (6 distinct mechanisms considered for the iframe-refusal gate):**

| # | Mechanism | Built? | Central idea | Proved | Gap |
|---|---|---|---|---|---|
| B0 | Direct iframe (baseline, pre-existing) | yes (prior turns) | n/a | works when the target allows it | fails by DESIGN for refusing sites — this is the gate itself |
| B1 | Same-origin proxy | **yes, this turn** | re-serve fetched bytes from our origin so framing headers never reach the browser | implemented + SSRF-guarded | no auth forwarding, target's absolute-URL XHR may break (local) |
| B2 | Browser extension companion | **not built** (documented only) | a real WebExtension can bypass/rewrite headers with host permissions | n/a — requires the user to leave pure-PWA distribution, a genuine architectural admission, not a workaround | equivalent-to-original (solves it by leaving the constraint, not within it) |
| B3 | Readability extraction | **yes, this turn** | discard the original DOM entirely; render our OWN sanitised article view | implemented | cannot represent non-article pages (local, declared) |
| B4 | Out-of-process render snapshot | **yes, this turn, probe-gated** | screenshot via server-side headless Chromium; no interactivity | implemented; capability genuinely uncertain in production until `build_and_start` confirms | H∂ until verified this turn (see §J) |
| B5 | Pure client-side CORS-fetch + manual DOM reconstruction (no server hop) | **not built** | fetch from the browser directly | rejected: blocked by CORS for the overwhelming majority of sites (the exact problem we're solving), so it degenerates to B1 anyway but without SSRF-guard feasibility (a browser can't DNS-resolve to check private ranges) | equivalent-to-original for the cases that matter |

**Sandbox (for the SH-05 widget-freeze gate):**

| # | Mechanism | Built? | Central idea | Proved | Gap |
|---|---|---|---|---|---|
| S1 | Dedicated Worker + structured render-tree protocol | **yes, this turn** | spec-guaranteed terminable thread; no raw-HTML channel back (avoids reopening XSS) | hang test passes under DEFAULT Chromium config (§G) | widgets needing arbitrary DOM can't use it (by design; they use S2 instead) |
| S2 | Sandboxed iframe + heartbeat (prior turns) | yes (kept, opt-in) | capability restriction + liveness detection | detects a hang; does NOT prevent the freeze under default config (declared, labelled) | isolation-dependent (H∂), explicitly not claimed otherwise anymore |
| S3 | Declarative-only widgets (no code execution at all) | **not built** (documented) | a fixed JSON schema, no Turing-complete widget logic at all | would be trivially freeze-proof (no halting problem exposed) | strictly less expressive than S1; S1 dominates it while remaining safe, so S3 was not pursued further |

## F. Artifact requirement

B1/B3: `src/lib/server/webproxy.ts`, `src/app/api/webproxy/route.ts`, wired into
`src/components/modules/Browser.tsx`. B4: `src/lib/server/render.ts`,
`src/app/api/render/route.ts`, probe-gated UI button. S1:
`src/lib/widgetWorker.ts`, wired into `src/components/DesktopWidgets.tsx`, sample widget
seeded at `/Widgets/counter.worker.js`. Every one of these is exercised by a Playwright test
in `scripts/e2e.mts` against a real, running Chromium (not a unit-test mock of the DOM).

## G. Second-order adversary

| Candidate | Attack | Result |
|---|---|---|
| B1 proxy | target hostname resolves to `127.0.0.1` | refused before fetch (DNS-resolved guard) |
| B1 proxy | target REDIRECTS to an internal address | refused after following the redirect (re-checked post-redirect, not just pre-redirect) |
| B1 proxy | response body is enormous (zip-bomb-style over HTTP) | capped at 4 MB, aborted mid-stream |
| B3 reader | page contains `<script>alert(1)</script>` inside the article body | stripped entirely before the allowlist pass even runs |
| B3 reader | `<a href="javascript:evil()">` | `javascript:` scheme stripped as a post-pass |
| B4 render | Chromium binary absent | probe returns `capable:false`, UI disables the button with the reason shown, never a silent/broken attempt |
| S1 worker | `while(true){}` immediately on load | detected at the 300 ms compute-budget deadline, `.terminate()`d, shell responsive throughout (verified, not assumed) — **tested under the browser's DEFAULT configuration**, the exact condition that falsified the iframe approach last turn |
| S1 worker | widget tries to `postMessage` a `tree.text` containing `<img onerror=...>` | rendered as React text content (not `dangerouslySetInnerHTML`), so it displays as literal text, never executes |

## H. Verification

`tsc --noEmit`: clean. The three-configuration Chromium hang experiment (§C.1) was run live,
output captured verbatim above. The S1 worker hang test and the B1/B3 mechanisms are exercised
by `scripts/e2e.mts` against real, running Chromium — results reported in this session's
ledger, not asserted separately here. B4's production viability is bound to the literal
`build_and_start` output for this turn (see the final validation section) — if the Chromium
binary is absent there, the claim is correctly downgraded to "implemented, probe-gated,
verified unavailable in this deployment" rather than silently claimed working.

## I. Repair log

None of B1/B3/B4/S1 are repairs of PREVIOUSLY SHIPPED code (they are new); the relevant repair
this session is SH-05 itself (see `docs/OFFICE-ENGINE.md`-adjacent ledger entry and
`src/db/seed-data/updates-v31.ts`), which inherits no trust from last turn's partial fix and
was re-attacked with a harder test (hang under DEFAULT config, not just verifying the
`--site-per-process` happy path again).

## J. Stopping condition and remaining gap

B2 (browser extension) is the only mechanism in this document that would give TRUE universal
embedding, and it is correctly NOT built, because it requires leaving the PWA distribution
model entirely — an architectural trade, not an engineering gap, and stated as such rather
than attempted and mis-sold. B4's real-world availability is an open, probe-answered question
as of this turn's `build_and_start` run. Next highest-information test: run the B1 proxy
against a deliberately adversarial target (a page that itself tries SSRF via a meta-refresh
redirect loop) to confirm the redirect re-check loop-protects correctly — not yet tested this
session (declared gap).
