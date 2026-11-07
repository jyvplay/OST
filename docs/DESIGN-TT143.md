# TT143/144 — twenty Class-A rows, one reverted design, and a measured test-lane change

This is the design record for the TT143/144 turn. It follows the A–J review format the
work is held to, and it cites only numbers produced by tools that actually ran in the
sandbox: `npx next build`, `tsc --noEmit`, `eslint`, four Node suites, three real-Chromium
suites, PostgreSQL 18.6 via `pg`, and Node's own CPU profiler. Where a claim could not be
verified by any of those, it is written down as a limit rather than as a result.

---

## A. Formal model

**Objects.** A *feature row* `r = (code, family, name, tier, phase, route, nuance, status, test)`.
A row is *Class A* iff (i) an engine exists in `src/lib` implementing the mechanism, (ii) at
least one UI surface calls it, and (iii) a suite asserts both an acceptance and a refusal
of that mechanism, with the suite green in the same build. A row that satisfies (i)+(iii)
but not (ii) is *partial*, whatever its badge says.

**Access model.** The app is a page: it has DOM, WebCrypto, IndexedDB, a service worker, and
`fetch` to its own origin. It has **no** raw TCP, no filesystem enumeration, no cross-app
views, no OS firewall hooks, and no way to keep a process alive after the tab closes. Every
mechanism in this turn is a *monotone* statement about that surface: what is reachable,
what is refused, and which platform fact produced the refusal.

**Resource counted.** Three, separately:
1. **wall time** of each test lane (ms), measured by the harness, split into test time and
   process/import time;
2. **CPU samples** in the reducer (`node --cpu-prof`), the dominant cost of `scripts/unit.mts`;
3. **bytes of chrome copy**, counted by `content-density.ts` against the same registry the
   UI renders.

**Success/failure, with quantifiers.** For a set of features F and a suite S:
`∀ r ∈ F : ∃ t ∈ S : t passes ∧ t exercises r's refusal`. A single failing feature fails the
tier claim for the whole set — there is no averaging. H− (impossible) is asserted per
mechanism, not globally: e.g. `∀ page p, ∀ web origin o : ¬(p speaks RDP)`.

**Regime, units, tolerances.** CSS px and ms; luma in `[0,1]`; contrast as a dimensionless
ratio with a 4.5:1 text floor and 3:1 non-text floor; fixed-point colour at 10 bits per
channel; timing tolerances are *reported*, never smoothed (a 250 ms budget for indexing
100 000 rows is the assertion, a measured 40 ms is the observation).

**Adjacent problems that must not substitute for this one.**
* A per-browser desktop row is not "multi-device sync".
* A deny-list of hosts is not a firewall (§A access model).
* A retry loop is not concurrency control (§I).
* A gradient overlay is not relighting (§E.10).
* A mocked service worker is not offline support.
* A screenshot diff is not a contrast measurement.

---

## B. Outcome space

| Hypothesis | Verdict | Evidence |
|---|---|---|
| **H+** twenty rows can be taken to A this turn with real engines and refusal tests | **accepted** | 20/20 rows rewritten to `built`/`tier A`; `tt143-engines` 20/20 green; register re-seeded (596 built / 29 partial / 21 blocked / 5 probe) |
| **H+** the pure lane can stay under 20 s with four more suites | **accepted** | `scripts/run-fast.sh` 17.6–20.1 s across four runs (was 18.0 s before this turn's additions) |
| **H+** the reducer's stress test can be made materially faster at equal fidelity | **accepted** | `unit` suite 8.9 s → 3.4 s test time, same 10 000-command invariants |
| **H−** a web page can implement AirPlay/RAOP, DLNA, Miracast or the Cast sender without proprietary code | **asserted impossible** | `stream-plan.ts` returns `blocked` with the protocol named; `tt143-engines` CA-08/CA-12 assert the refusal |
| **H−** a page can filter another app's traffic or change the system resolver | **asserted impossible** | `egress-rules.ts` is scoped to the app's own fetch seam and says so in its first line |
| **H∂** per-browser desktop identity | **boundary found, design reverted** | see §I.1 — the boundary is the app's one-desktop-on-several-screens premise, not a technical limit |
| **H∂** two browser suites can share a lane | **conditional** | they can, *iff* they own disjoint revision domains (§I.4) |
| **H∂** the module dialog can be made to appear faster | **condition not yet met** | 1.0–3.4 s is client-side dev-mode compilation of module chunks, not app latency (measured: the state fetch reports 49–640 ms while the dialog takes 2.0–4.5 s) |

No claim above is committed beyond its evidence. In particular B's last row is a *measured
attribution*, not a solution.

---

## C. Frontier

Imported and restated with the hypotheses they need:

1. **WCAG 2.1 SC 1.4.3 / 1.4.11** — text ≥ 4.5:1, non-text boundaries ≥ 3:1, computed with
   the sRGB relative-luminance formula. Hypothesis needed: the pair is actually adjacent in
   the rendered UI. Our audit checks the token matrix, not every composed surface; the gap is
   named in `a11y-gate.ts`'s own limits list.
2. **RFC 6068** (`mailto:` encoding) — already implemented in `mailto.ts`, unchanged.
3. **ZIP/Deflate64/BZip2/LZMA + AES** — already implemented; not touched this turn.
4. **Service-worker lifetime** — the platform makes no promise that a worker runs after the
   page closes; periodic-sync `minInterval` is a floor the UA may ignore. Restated in
   `background-mechanisms.ts` per mechanism.
5. **`setSinkId`** — secure context + `speaker-selection` permission + cross-origin-stream
   refusal. These are the three limits the design is built around.
6. **Optimistic concurrency** — a revision-based compare-and-swap. The open interface
   between "refuse the stale write" and "do not lose the user's window" is exactly
   `desktop-merge.ts`: the store refuses, the client merges. Neither half is sufficient
   alone, and that interface is the contribution of DP-04.

No result in this turn is an imported theorem. The frontier items are platform contracts,
and each is used only in the form stated above.

---

## D. Negative space — fifteen shapes that look like solutions

| # | Shape | Why it fails the contract | Test that detects it |
|---|---|---|---|
| 1 | Per-browser desktop row | breaks the one-desktop-on-several-screens premise; 184 fixtures addressed the shared row | `tt142-platform` DP-03 asserts the unnamed case is `default` |
| 2 | Retry a 409 until it succeeds | hides a real concurrency bug behind a loop | `tt143-engines` DP-04 asserts a close newer than the open wins and the merged set is order-independent |
| 3 | Treat "no Content-Length" as complete | an interrupted stream is indistinguishable from a finished one | `tt143-engines` PR-07m: `complete(…, null)` → `unverified` |
| 4 | Filter hosts with a regex deny-list | a hostile pattern can be made expensive; rules that fail to parse vanish | `tt143-engines` SC-04 asserts 4 malformed rules are all *reported* and none applied |
| 5 | Per-channel saturation | it is a contrast change wearing saturation's name | `tt143-engines` MD-03 asserts luma is preserved within 2/255 |
| 6 | `brightness()` as a key light | lifts the background, has no direction, cannot disclose clipping | `tt143-engines` LN-06 asserts the brightest stop is on the fill side |
| 7 | A "background sync" claim backed by a `setTimeout` | timers are throttled when hidden and stop when the tab closes | `tt143-engines` AP-05 asserts periodic sync's guarantee text contains the fact the interval may be ignored |
| 8 | `userAgent` sniffing for profiles | a touchscreen laptop reports a desktop UA | `tt143-engines` ST-09: coarse+no-hover+touch = tablet; touch alone = laptop |
| 9 | Restore "the nearest screen" | a wrong restore is worse than none | `tt143-engines` WM-07 asserts an ambiguous screen pair is reported, not guessed |
| 10 | Virtualise with an estimated fixed row height | measured rows then jump on mount | `tt143-engines` SH-13 asserts a measured 0 keeps the estimate and pads sum to the total |
| 11 | "Cast this tab" via a `blob:` URL | a receiver fetches the URL and cannot reach the page's blob | `tt143-engines` CA-08 asserts blocked + a real alternative |
| 12 | Audit "the archive is clean" from row count alone | a half-published pair has a matching count | `tt143-engines` RC-29 asserts dangling rows are never auto-reclaimed |
| 13 | Copy a `vnc://` link and call it remote desktop | the scheme is usually unregistered, so the link does nothing | `tt143-engines` CT-05 asserts `vnc://` is *copied*, `rdp://` is a handoff |
| 14 | Word budget by eyeball | unreviewable, and regresses silently | `a11y-unit` TT143 copy asserts every module summary ≤ 12 words |
| 15 | A palette with hand-picked borders | shipped a 1.39:1 boundary that a low-vision user cannot see | `a11y-unit` TT143 tokens asserts the derived border clears 3:1 on every surface; `tt143-engines` visual proves the auditor catches a broken palette |

The **modal shortcut** is #3 (declaring success without a length) because it is the one whose
failure is invisible in normal use: every happy-path test passes, and the bug only appears on
a dropped connection. The test above is therefore a *state* assertion (`unverified`), not a
timing assertion.

---

## E. Mechanism portfolio — six mechanism-distinct approaches

| # | Construction | Artifact | Proved portion | Unresolved interface | Cheapest falsification |
|---|---|---|---|---|---|
| E.1 | **Rule resolution by specificity** over a glob host/path lattice | `egress-rules.ts` | specificity, deny-at-equal-specificity, credential and scheme refusal, parse rejections | which requests exist at all (the app's own seam) | add a rule `allow cdn/x/y` and a `deny cdn/**`; the path rule must win (`SC-04` passes) |
| E.2 | **Per-key collapse + content digest** outbox | `offline-queue.ts` | ordering, collapse, dedupe, byte/entry caps, 409-drop | durability across a browser kill | enqueue the same body twice → `duplicate`, not two writes |
| E.3 | **Four-phase state machine** for saving | `safe-save.ts` | phase ordering, per-phase recovery, crash rules | validator semantics (caller-supplied by design) | call `afterReplace` before `afterValidate` → refused |
| E.4 | **Order-independent merge** with dense z renumbering | `desktop-merge.ts` | no window loss, close-vs-reopen ordering, set commutativity | *which* side's geometry wins on an exact tie (stated) | merge A,B and B,A with opposite `prefer` → same id set |
| E.5 | **Prefix-sum index + binary search** | `panel-layout.ts` | O(log n) lookup, pads sum to total, clamp at both ends | painted frame time in a real browser | index 100 000 rows in < 250 ms; mount < 1 % |
| E.6 | **Measured-fact classifier** for profiles | `context-profile.ts` | precedence rules, announcement only on id change | whether a given device reports truthful media queries | coarse+no-hover+touch on a 3-screen desk → tablet |

Each was kept independent: E.1 does not import E.2, and no engine imports another. The six
are mechanism-distinct rather than domain-distinct — matching, collapsing, ordering,
merging, indexing and classifying are different *proof obligations*.

---

## F. Artifacts

* Engines: `src/lib/{egress-rules,offline-queue,safe-save,desktop-merge,context-profile,remote-desktop,capture-plan,audio-route,photo-edit,key-light,background-mechanisms,hotplug-restore,panel-layout,row-cluster,design-tokens,content-density,download-arbiter,memory-audit,stream-plan,desktop-id}.ts`
* Suites: `scripts/tt143-engines.mts` (20 cases), `scripts/tt142-platform.mts` (6), `scripts/tt142-browser.mts` (7), extensions to `scripts/a11y-unit.mts` (2 new gates).
* Register: `src/db/seed-data/features-tt143.ts` + `patchTT143` as the last mapper; `SEED_VERSION="3.100.0"`.
* UI: Monitor → *Platform facts (TT143)*; three new original glyphs (`plugBoard`, `signal`, `ledger`) shared by module tiles and chrome marks.

---

## G. Second-order adversary

For each accepted artifact, the strongest attacker derived from *its own* structure:

* **E.1 (egress)** — attacker: a rule list with a `**.example` deny and an `allow a.b.example/x`
  buried behind it. Structure-derived attack: path specificity must beat host wildcards, so
  the test asserts `by === "one-path"` on a `**` deny; a rule that relies on ordering would
  fail it.
* **E.2 (queue)** — attacker: two devices editing one note. The collapse rule could replay an
  older body over a newer one; the digest plus per-key replacement makes the newer body the
  only queued one, and a 409 is dropped rather than retried.
* **E.3 (safe save)** — attacker: a crash between temp and validate. The recovery rule keeps
  the temp (validated? unknown) and offers the session copy; it never promotes an unvalidated
  temp, which is the only safe reading.
* **E.4 (merge)** — attacker: a stale tab that opens the same window id at an older z. z is
  renumbered densely from 1, so a merge cannot leave a gap that later `nextZ` arithmetic
  trusts; the test asserts `nextZ === windows.length + 1`.
* **E.5 (virtual list)** — attacker: a row measured as 0 (not yet laid out). The clamp keeps
  the previous estimate, so the index never collapses; asserted directly.
* **E.6 (profile)** — attacker: a device that lies (an iPad in desktop mode reporting a Mac
  UA). The classifier never reads the UA; it reads media queries and `maxTouchPoints`.

Quantifier-order check: every refusal above is `∀ input in the stated domain` — the tests
iterate the domain (all reserved names, all schemes, all failure kinds) rather than sampling.

---

## H. Verification

| Claim | Verifier | Result |
|---|---|---|
| 20 engines typecheck | `npx tsc --noEmit` | clean |
| 20 engines lint | `eslint` on the new files | clean |
| engine behaviour | `scripts/tt143-engines.mts` | 20 passed / 0 failed, 462–551 ms |
| named desktops + isolation | `tt142-platform.mts` (real Chromium) | 6/0 |
| install/manifest/SW/reflow/desktop labelling | `tt142-browser.mts` (real Chromium) | 7/0, three consecutive lane runs clean |
| eight module surfaces in a real browser | `tt141-browser.mts` | 8/0 |
| token contrast + word budget | `a11y-unit.mts` | 11/0 |
| register reseed | `ensureSeeded()` out-of-process + `pg` | 596 built / 29 partial / 21 blocked / 5 probe; all 20 codes `built`/`A` |
| production build | `npx next build` with `DATABASE_URL` | compiled successfully, `.next/BUILD_ID` written, 45 routes |
| reducer speedup | `node --cpu-prof` + wall clock | 8.9 s → 3.4 s test time on the same 10 000-command workload |

**Downgraded claims.** (i) The "cast" matrix asserts *refusals* for native protocols, not
playback. (ii) `AP-05` reports mechanisms and observations, never a delivery rate. (iii) The
1.0–3.4 s dialog latency is attributed to dev-mode chunk compilation by measurement, not
proved by a production-mode run (no production server was started this turn).

---

## I. Repair

### I.1 A design that was built, measured, and reverted (DP-03)

The first implementation gave each browser an opaque desktop id in an httpOnly cookie minted
by the proxy, so two browsers could never share a row. It worked — the cookie was present
before the first render, two contexts kept separate desktops, and `tt142-platform` was green.
Then the measurement: **184 e2e scripts** seed the shared `default` row and assert on a
rendered page; the shell's own suite went **8/8 → 2/8** because every fixture wrote to a row
nobody read. More importantly the premise is *one desktop on several screens* — a phone and a
laptop are not two desktops. The feature was reverted to the additive half: `?desk=` names a
desktop, the shared row stays the default, and `src/proxy.ts` carries the measurement in a
comment so a future attempt inherits the constraint instead of rediscovering it.

New attack aimed at the patch: `tt142-platform` asserts that *absence* of a name resolves to
the shared row, that a named row is isolated, that a stale revision is refused with 409, and
that a typo falls back with a sentence.

### I.2 Performance repairs, with the attack that keeps them honest

* `syncMru` de-duplicated with `indexOf` inside `filter`: **O(n²)** per reducer command, 36 %
  of the suite's samples. Rewritten with a `Set` and an identity fast path. New attack: the
  suite's 10 000-command run asserts unique z, minimum sizes and a live focus after every
  step, so a reordering bug cannot pass.
* `invariants` rebuilt every window on every command (90 % of samples, and a fresh object per
  title bar in the real app). Now: `alreadyValid()` fast path returning the *same* state
  reference, and unchanged windows keep their identity. New attack: fractional rectangles are
  re-clamped (the `Number.isInteger` guard), because `clampRect` rounds.
* `cycle` did a `find()` per id: O(n²) per Alt-Tab. One `Map` index now.
* `tt141-browser` polls the dialog's `aria-label` attribute instead of the accessibility-indexed
  role query (1.6–3.3 s → 1.0–1.5 s per module), with the role query kept as a fallback.

### I.3 Tests that were wrong, not the code

* `words("WCAG 2.1 AA v1.2.3")` — the expectation `1` was wrong; every token is an acronym or a
  version, so the correct answer is `0`. Fixed the assertion and added a case with a real verb.
* The download arbiter's `complete(…, null)` marked an item `truncated` from the *enqueued*
  length. That is the exact bug state #3 describes; the engine was fixed, not the test.
* The key light darkened an over-bright frame (gain 1 → 0.968) because the clip cap applied in
  both directions. Fixed: the cap only ever reduces an *added* light.
* `shortDesktopId("d-0123456789ab")` — the test's expected string was miscomputed; the engine's
  7-character tail is right.

### I.4 The one remaining flake, and the honest fix that removed it

`tt142-browser`'s two-tab case failed roughly one lane run in three, and never standalone. The
cause: that case does a read-modify-write on the desktop row while **two live tabs** are also
saving to it, so a 409 is the *correct* answer. Three repairs, in order of principle:

1. retry the fixture write on 409 (the same loop the shell uses) — reduced but did not remove it;
2. assert the *verdict* (refused or stored, never resurrected) rather than only the status code;
3. give the suite its own revision domain: it now runs on the named desktop `?desk=tt142`
   while `tt141` uses the shared row. This is the same conclusion the earlier lane measurement
   reached — parallelism needs separate state domains, not more retries — and it is why the
   suite is now labelled with its own row in the code.

Result: three consecutive full-lane runs, zero failures (and earlier: three consecutive
`tt142-browser` runs at 7/0 before the desk split).

---

## J. Stopping

**Success predicate.** Twenty named rows exist with engine + UI + acceptance *and* refusal
tests, the register reflects that, and every lane is green in the same build. All three hold
(`tt143-engines` 20/0, `a11y-unit` 11/0, fast lane 17.6–20.1 s, browser lane 75–95 s green in
three consecutive runs, build clean, register reseeded).

**Exact remaining gaps.**
1. The four rows documented as *partial* in `features-tt143.ts` (BK-01 timeline storage,
   BK-02 second endpoint, BL-02 no store to issue entitlements, FM-08 volume enumeration) stay
   partial on purpose; flipping them would be the negative-space shape #1 of this turn.
2. Module-dialog latency (1.0–3.4 s) is dev-mode chunk compilation; a production-mode
   measurement was not taken.
3. Several engines are wired into one visible surface (Monitor's *Platform facts*) rather than
   one per module; e.g. `photo-edit.ts` has no Photos panel yet. That is a UI gap, not an engine
   gap, and it is listed here rather than claimed shut.

**Next highest-information test.** Start the production server (`next start`) and re-run
`tt141-browser` with `TT_TIMING=1`. That single number decides whether the dialog latency is a
dev-only artefact or a real hydration cost — and therefore whether the browser lane's 75–95 s
can be cut at the root instead of at the edges.
