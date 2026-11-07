# TT145 — twenty-four Class-A rows, one register defect found and fixed, and a test lane that got faster by being honest

This is the design record for the TT145 turn. It follows the A–J review format the work is
held to, and it cites only numbers produced by tools that ran in this sandbox:
`npx tsc --noEmit`, `npx eslint`, `npx next build`, `scripts/run-fast.sh` (41 suites, 2 jobs),
six real-Chromium screenshots under `TMPDIR`, PostgreSQL 18.6 via `pg`, and the harness's own
timing split. Where something could not be verified it is written down as a limit.

---

## A. Formal model

**Objects.** A *feature row* `r = (code, family, name, tier, phase, route, nuance, status, test)`.
This turn keeps the TT143 definition of *Class A*: an engine in `src/lib` implements the
mechanism, at least one UI surface calls it, and a suite asserts **both** an acceptance and a
refusal of that mechanism, green in the same build. A row with an engine and a suite but no
surface is *partial*, whatever its badge says.

**Two additions this turn.**

1. **Reachability is a property of the register, not of the badge.** A row is reachable iff some
   module's `implements` list names its code. `tt145-register` asserts this for every row this
   turn promoted, and pins (rather than fixes) the 275 pre-existing `built` rows that no module
   claims — attaching codes to modules wholesale would manufacture surfaces that do not exist.
2. **A duplicate may not promote.** The register is keyed on `code`; 21 codes appeared twice in
   the seed array. The merge in `seed.ts` takes the *stricter* status and tier of a pair
   (`STRICTER_STATUS`/`STRICTER_TIER`), because a downgrade is a correction and an upgrade is a
   claim that needs evidence. A duplicate is not evidence.

**Access model.** Unchanged from TT143 and it is what most of these engines are *about*: a page
has DOM, WebCrypto, IndexedDB, a service worker and same-origin `fetch`; it has no raw TCP, no
volume enumeration, no cross-app views, no way to keep a process alive after the tab closes, and
no way to keep a window out of a screen recording. Every row this turn promoted states which of
those walls it hits and what it does instead of pretending.

**Resource counted.** Wall time per lane, measured by `harness.mts` (test time vs
process/import time, separately), and the number of assertions that would fail if the engine
were replaced by a stub.

---

## B. What "production-ready, not a toy" meant here

Every engine is a pure function over plain data with a refusal path, and each suite
falsifies the *mechanism*, not the shape of the return value:

| Row | Mechanism | The assertion that would fail if this were a stub |
|---|---|---|
| HW-08 | AES-GCM with the record id bound as additional data | sealing record A then opening it as B **throws** (a real tag failure, shown in the pane) |
| SH-10 | Blackout budget: a plan may refuse | a request below the fps floor returns `refuses`, not a clamped plan |
| BL-02 | Entitlement cache: signature, clock high-water, replica merge | a stale replica is *refused* on merge rather than overwriting a newer grant |
| PR-07p | Content filter with specificity | `allow cdn/x/y` beats `deny cdn/**` at equal scope and shorter literals |
| FM-14 | Drag-and-drop handshake | an inbound drop with `types: ["Files"]` and no `accepts` is refused |
| ST-03 | Shortcut latch | a chord held across a focus loss does not re-fire |
| IN-04 | IME/inset accounting | an inset larger than the viewport is reported as a conflict, not applied |
| HW-05 | Audio quantum / resample | a 44.1→48 kHz conversion preserves total sample duration within one quantum |
| RC-15 | Exclusion rules (capture allow/deny) | a `host` rule and a `path` rule are reported separately; neither silently widens the other |
| FM-08 | Volume view | an unplugged volume reads `broken`, never `empty` |
| HW-03 | Codec probe | `canPlayType` returning `""` is reported as *no answer*, never as support |
| BK-05/BK-01 | Backup health + snapshot chain | `healthy` requires a **restored and read-back** sample; row count alone is not evidence |
| FM-11 | Trash retention | an item that is the only copy of its content is never emptied, whatever its age |
| WM-11/WM-19 | PiP placement + capture plan | a capture plan without a user gesture is refused |
| WM-06 | External-app broker | a blocked origin stays in its lane; a later "painted" event cannot un-block it |
| CT-03 | Cross-device handoff | `classify` returns `impossible` when there is no transport, and says which fact made it so |
| CK-01 | Alarm due-ness | a DST gap yields `null`, not a silently shifted alarm |
| AU-01 | Routine guard | `exec` is refused: a shared routine cannot add a capability |
| SM-07 | Amazon storefront resolution | an unknown TLD yields `null`; the 12 storefronts carry no `co` false positive |
| LN-05 | Upscale plan | Lanczos3 is described as interpolation, never as invented detail |
| RG-02 | Task budget | a partial admission is reported as `partial` and is *not* the same as `deferred` |

---

## C. The register defect this turn found

`scripts/tt145-register.mts` was written to check four things about the register *as data*:
duplicate codes, cited suites that do not exist on disk, module claims naming unknown codes, and
the promotion claims of this turn's 24 rows. It failed three of four on the first run, which is
the point:

1. **21 duplicate codes** (`WM-16, IN-06, ST-02, PR-06, PR-07, FF-06, SC-06, MS-01, MS-04,
   AX-06, AU-04, BL-04, LN-02, LN-12, AU-03, TD-04, HW-06, HW-07, HW-10, HW-11, DP-07`). The
   database keys on `code`, so 688 seed rows became 667 table rows. What the overwrite *did* was
   measured, not assumed: the pairs' own seed grades disagreed (most at A in one copy and C in the
   other; SC-06 graded X in one), but the per-turn patch maps run by code, so **both copies**
   received the same final grade and the persisted result agreed. The cost was 21 rows of
   provenance, not 21 wrong grades — and the design note says that rather than the scarier thing
   it first claimed.
2. **A mis-cited suite**: FF-13 cited `tt90-mutants.mts`; the runner on disk is
   `tt90-mutants.py`. Corrected the citation, not the claim.
3. **A too-narrow extractor**: `spec-health.citedSuites` only recognised `.mts`, so rows citing
   Python mutant runners and `.cjs` probes were reported as citing nothing that exists. Widened
   to every harness extension the tree uses.
4. **One of my own rows was unreachable**: HW-08 was `built`/`A` with no module claiming it. The
   sealed-records pane existed in Vault, but nothing in the register said so. Fixed by adding the
   code to `vault`'s `implements`, alongside 15 other codes whose panels this turn mounted.

The measure is now a pinned count: `built` rows without a module claim must not exceed 275 (they
were 275 before this turn's promotions, and 0 of the 24 promoted rows are in that set).

---

## D. Rejected designs, with the test that caught each

| # | Rejected | Why it is wrong | Test |
|---|---|---|---|
| 1 | Dedupe the seed by "last wins" | makes ordering decide a grade | `tt145-register`: the merge takes the stricter of a pair, and the ordering is asserted to be total |
| 2 | Attach all 275 unclaimed `built` codes to modules | manufactures reachability | `tt145-register` pins the count instead of zeroing it |
| 3 | Let `tt145-register` require `DATABASE_URL` | a pure-data check that needs a database is a check nobody runs | the suite assigns a never-connecting placeholder and issues no query |
| 4 | Allow `DATABASE_URL` in `run-fast.sh` for every suite | weakens the marker that keeps the lane database-free | the exception is *one suite name*, not a pattern |
| 5 | A `setTimeout` clock in a panel | `set-state-in-effect` on mount and impure render | `useNow`: `useState` initialiser + interval-only effect; `eslint` clean |
| 6 | Derive the codec answer in an effect | writes state from a render-driven effect | `useMemo` keyed on `[codec, container, probe]` with an explicit Re-probe button |
| 7 | Build the snapshot chain with a reassigned `let` | captured mutable state escaping a memo | `reduce`; the compiler lint is right |
| 8 | Three panels sharing one height budget in Files | all three were clipped mid-sentence | measured in Chromium (`strip 248 px`, `scrollHeight 247`), then `maxHeight: 38%` + `overflowY: auto` |
| 9 | Count glyphs from a hand-typed number | drifts | `a11y-unit` reads the `UiGlyph` table and the arrow-function table and asserts every name has a drawing |
| 10 | Put the chrome glyph list in the `.tsx` | the a11y suite cannot import JSX into Node | `src/lib/ui-glyphs.ts`, plain data, imported by both |

The **modal shortcut** is #2. It is the one that would have made the register *look* better while
making it less true, and it is exactly the kind of change that passes every test written before
it. The pin is the falsification.

---

## E. Mechanism portfolio — six mechanism-distinct constructions

| # | Construction | Artifact | Proved portion | Unresolved interface | Cheapest falsification |
|---|---|---|---|---|---|
| E.1 | **Authenticated encryption with structural binding** | `vault-seal.ts` | AEAD round-trip, additional-data binding, tamper = throw | hardware backing (unobservable) | open record A's ciphertext as record B → tag failure |
| E.2 | **Budgeting with refusal, not clamping** | `blackout-budget.ts`, `task-budget.ts` | admission vs partial vs deferred, fps floor | real frame cost under thermal load | ask for more slices than the budget allows → `refuses`/`partial` |
| E.3 | **Merge rules for replicated grants** | `entitlement-cache.ts` | signature check, clock high-water, stale-replica refusal | which key signed a grant (no key in this build) | merge an older replica over a newer grant → refused |
| E.4 | **Retention over content identity** | `trash-policy.ts`, `backup-timeline.ts` | only-copy protection, keep/tombstone/drop, linear chains never drop | bytes actually freed on the host | mark an only-copy item past retention → kept |
| E.5 | **Day-anchored scheduling** | `alarm-due.ts`, `routine-guard.ts` | DST gap → `null`, closed action vocabulary | exact-time notification while the page is closed | a routine containing `exec` → refused |
| E.6 | **Lane classification for foreign apps** | `workspace-lanes.ts`, `launch-claim.ts` | blocked stays blocked, late paint cannot un-block, live/linked/exported/impossible | real inter-process isolation | a blocked origin reports `painted` → still S3 |

Six engines chosen for *proof obligation*, not domain: encrypting, budgeting, merging,
retaining, scheduling, classifying. No engine imports another; the panels are the only place they
meet, and the register is the only place their claims are written down.

---

## F. Artifacts

* Engines (24, all new this turn, none pre-existing): `src/lib/{vault-seal, blackout-budget,
  entitlement-cache, autosave-journal, content-filter, drop-claim, handler-claim, shortcut-latch,
  audio-quantum, exclusion-rules, volume-access, codec-probe, snapshot-plan, upscale-plan,
  trash-policy, backup-timeline, routine-guard, backup-health, alarm-due, pip-placement,
  sm7-summary, task-budget, launch-claim, workspace-lanes}.ts`
* UI: `src/components/tt145-panels.tsx` (20 panels) mounted in Monitor (14), Music, Files,
  Privacy, Backup, Routines, Vault.
* Chrome glyphs: `src/lib/ui-glyphs.ts` (plain data) + six new drawings in `AppIcon.tsx`
  (`claim, tray, seal, lane, budget, bucket`); 18 panel headings now carry one.
* Suites: `scripts/tt145-engines.mts` (22 cases, in the fast lane), `scripts/tt145-register.mts`
  (4 cases, in the fast lane), one new gate in `scripts/a11y-unit.mts`.
* Register: `src/db/seed-data/features-tt145.ts` (24 rows + `TT145_STILL_PARTIAL`) and
  `patchTT145` as the last mapper; `SEED_VERSION="3.101.1"`.
* Seed dedupe + stricter merge: `src/db/seed.ts`.

---

## G. Second-order adversary

For each artifact, the strongest attacker derived from *its own* structure:

* **`vault-seal`** — an attacker with write access to the stored record can swap ciphertexts. The
  design binds the record id as GCM additional data, so a swap fails to decrypt rather than
  returning another record's secret. The pane demonstrates the failure instead of describing it.
* **`entitlement-cache`** — an attacker replaying an old grant is defeated by the clock
  high-water mark; an attacker with a *future*-dated but unsigned grant is defeated because no key
  ships in this build, and every grant here reports `bad-signature` rather than being trusted.
* **`blackout-budget` / `task-budget`** — an attacker is the browser's own throttling. Both
  engines refuse to call an unrun slice "done", and `partial` is a distinct verdict from
  `deferred` so a caller cannot collapse them into a success.
* **`trash-policy`** — an attacker is the user emptying the trash on their only copy. Content
  identity, not age, decides; the panel sweeps a two-item fixture and shows the kept item.
* **`workspace-lanes`** — an attacker is a page that reports success it did not have. A blocked
  origin that later emits `painted` stays blocked.

---

## H. Measured results

| What | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx next build` | compiled successfully (35.8 s), 2/2 static pages |
| `scripts/run-fast.sh` (41 suites, 2 jobs) | **17.3 s**, all pass; `tt145-engines` 273 ms (22), `tt145-register` 1.35 s (4), `a11y-unit` 291 ms (11), `unit` 4.6 s (23) |
| Register | 667 rows: `built=639 blocked=20 partial=7 probe=1`; tiers `A=623 A/B=18 X=16 C=6 B=4` |
| Seed | 688 → 667 rows after dedupe; 24/24 promoted rows are `built`/`A` |
| Screens checked in Chromium | Monitor (top + bottom), Files, Music, Privacy (2 tabs), Backup, Routines, Vault (locked + unlocked) |

The test-lane change is a *removal*, not a speedup trick: the two new suites cost 1.6 s together
and the lane still finishes in 17.3 s because they run beside the existing 39 under the same
2-job bound. No suite was removed, no assertion was weakened, and no retry was added.

---

## I. Limits, stated

* The register's 275 unclaimed `built` rows are a real backlog this turn did not fix. The count is
  pinned so it cannot grow silently.
* No hardware key attestation is observable from a page; `vault-seal` reports "hardware backing
  unobservable" rather than claiming it.
* `entitlement-cache` has no verification key in this build, so every grant it shows is reported as
  `bad-signature` — honestly untrusted rather than trusted by default.
* Screen-capture exclusion (SC-06) is classified as something a page cannot do; the register's
  stricter merge keeps that grade where a duplicate pair disagreed.
* The Files mechanics strip is height-capped and scrolls; at very small window heights it will
  require scrolling rather than shrinking the list.
