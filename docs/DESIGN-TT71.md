# TT71 — NC-02 focus rules (was registered "built", did not exist)

## Runtime honesty

- **Ran:**
  - Node 22 (strip-types), tsc, the Next 16.2.6 production build (two rebuilds), Playwright 1.64.1 with Chromium 143
    (headless), embedded Postgres 17.10 with `drizzle-kit push` (two new nullable columns).
  - Python 3.11 for the mutant runner.
- **Did not run:** a real OS notification centre (headless Chromium has none, so `Notification` is replaced by a
  recorder in the e2e and that is disclosed); Firefox / Safari; a phone; Word / Excel / LibreOffice.
- **No theorem prover.** The schedule model is checked against an independent oracle on every point of a finite domain
  (60 schedules × 10 080 minutes = 604 800 points), which is exhaustive for those schedules, not a proof for all.
- **Writer / Spreadsheet:** not advanced this tier. The whole turn went to one row that the register called built but
  that had no code (see "Truth check"). I am saying so plainly rather than counting it as office progress.

## Truth check (why this row)

A grep of the "built" rows that were still untested found three with **no implementation**: NC-02 (focus rules),
SH-11 (BroadcastChannel `fusion-shell`; only `fusion.refresh` exists) and SC-05 (device-access log). NC-02 was built
this tier. SH-11 and SC-05 are still unbuilt and are listed as blockers below. Their register status will be corrected
when they are built. This is the second tier in a row (WM-13 in TT70) where "built" in the seed was false.

## A. Formal model

- **Rule** = `{id, name, enabled, schedule?, workspaces?, focusMode?, allowApps[], allowPriorities[]}`.
  - Absent condition = no constraint.
  - Default `allowPriorities = ["high"]`; an explicit `[]` lets nothing through.
- **Local time** `L = (day ∈ 0..6, minute ∈ 0..1439)` of `now` in the IANA zone `alerts.timeZone` (via
  `Intl.DateTimeFormat`). The zone is validated on write; an unknown zone at read time falls back to UTC.
- **Schedule** `{days, from, to}` with `from ≠ to` is the union over `d ∈ days` of the half-open interval
  `[d·1440+from, d·1440+from+len)` on the 10 080-minute week (mod 10 080), where `len = to−from` if `to > from`, else
  `to+1440−from`. In words: an overnight window belongs to the day it **starts** on.
- **active(r)** ⇔ `r.enabled ∧ (no schedule ∨ L ∈ schedule) ∧ (no workspaces ∨ activeWorkspace ∈ workspaces) ∧
  (focusMode undefined ∨ focusMode = desktop.focusMode)`.
- **deliver(a)** ⇔ `∀ r ∈ active: lower(a.app) ∈ lower(r.allowApps) ∨ a.priority ∈ r.allowPriorities`.
  - Otherwise the alert is held by the **first** blocking active rule in list order, and that rule's id and a reason
    sentence are stored on the alert.
- **Release:** `PATCH {deliver:true}` sets `heldBy = heldReason = null`. Nothing else ever clears it.

## B. Hypotheses

- **H+ (built and tested):**
  - Held alerts raise no toast and no OS notification. This covers both producers: Planner reminders in
    ShellDaemons and the Alerts test button.
  - The decision uses the server's live desktop state, not the caller's claim.
- **H− (refuted during the tier):** "The body is first-party, so it needs no validation." Refuted by G1: `{"app":5}`
  crashed the route.
- **H∂ (partly true):** "The decision sees the workspace the user is on."
  - True once the shell persists its state.
  - The shell debounces that save: 600 ms, at most 1 s. An alert within ≤1 s of a workspace switch is decided
    against the previous workspace. This is disclosed, not fixed.

## C. Frontier

| Part | Status |
|---|---|
| Engine (`src/lib/focus-rules.ts`, pure) | done |
| Persistence (`alerts.held_by`, `alerts.held_reason`) | done |
| Settings `alerts.focusRules` and `alerts.timeZone`, validated on write | done |
| API: POST decides; GET reports the rules and the active ones; PATCH releases | done |
| UI: editor, status line, held list with reasons, Deliver now | done |
| Reminders respect the rules | done |
| Automatic re-delivery when a rule ends | **not built** (held alerts stay listed, unread) |
| Rules applied to the Routine "alert" action | **not built** (it stores no toast or notification, so nothing is leaked) |
| ≤1 s workspace-persistence window | **not closed** |

## D. Negative shapes (≥15) + modal shortcut

- **22 malformed rule lists are rejected,** each with a message naming the rule:
  - invalid JSON, a non-list, non-object entries, a missing, uppercase or 33-character id, a duplicate id;
  - a blank or 61-character name, a non-boolean `enabled`;
  - empty days, day 7, `9:00`, `24:00`, `from = to`;
  - workspace 0, a numeric focusMode, a blank app, priority "urgent", 33 rules.
- **8 malformed alert bodies are rejected** (the repair).
- **2 malformed zones** are refused end to end with 422, and 4 at unit level.
- **Modal shortcut:** the editor is a non-modal section inside the Alerts window, with no focus trap. Its Save button
  is disabled until something changes, and an invalid draft never reaches the server. The client runs the same parser
  first; the server re-validates.

## E. Mechanism-distinct approaches

1. A pure engine with injected context (time, zone, workspace, focus mode), so it is unit-testable without a clock.
2. An **independent oracle** for schedules: minute-of-week interval arithmetic, versus the engine's day / minute
   branches.
3. Real IANA data through `Intl` for DST gaps and overlaps (New York 2026-03-08 and 2026-11-01), +05:30 and +12:45.
4. Server-side decision against persisted desktop state, with the decision stored on the row, so "why didn't I get
   this" is answerable later.
5. A real browser through real routes: an e2e with an OS-notification recorder, in a production build.
6. Mutation analysis: 19 seeded bugs, including 2 that revert the repair.

## F. Artifacts

| Type | Files |
|---|---|
| Code | `src/lib/focus-rules.ts`, `src/components/modules/FocusRules.tsx`; edits to `api/alerts/route.ts`, `Alerts.tsx`, `ShellDaemons.tsx`, `settings-validate.ts`, `db/schema.ts`, `db/seed.ts` (3.57.0), `seed-data/features-tt71.ts` |
| Tests | `scripts/tt71-focus.mts` (7), `scripts/e2e-tt71-focus.mts` (4), `scripts/tt71-mutants.py`; both suites appended to run-all (172) |
| Evidence | `docs/heldout/tt71-mutants.txt`, `docs/heldout/tt71-alerts-held.png`, `docs/heldout/tt71-focus-editor.png` (visually inspected) |

## G. Second-order adversary (attacks on the patch)

- **G1:** `POST /api/alerts {"app":5}` → **500** (`r.app.trim is not a function`, seen in the server log). Introduced
  by this patch.
- **G2:** `{"priority":["high"]}` was stored as the string `{"high"}`. This existed before the patch, and the rule
  engine would have treated it as "normal".
- **G3:** a blank app `"   "` was stored blank and grouped under a blank heading. Now it defaults to "Fusion".
- **G4 (not repaired, disclosed):** the ≤1 s workspace-persistence window (see H∂).
- **G5 (by design):** any same-origin caller may set `priority: "high"`. Alerts are first-party, and there is no
  third-party producer to defend against.

## H. External verification

- Chromium 143 through the production build and Postgres: 4/4 e2e.
- IANA zone data from the runtime's ICU through `Intl`, which this code did not write.
- There is no OS notification centre to verify against, so the recorder is used and disclosed.

## I. Repair (+ new attack aimed at the patch)

- **The repair:** `normalizeAlert` trims and caps strings, defaults blanks, requires `priority ∈ {low, normal, high}`,
  and returns 400 for anything else.
- **Attacks aimed at the repair:**
  - The unit test covers 8 bad bodies; the e2e checks `{"app":5}`, a priority array and "urgent", all 400.
  - Two mutants that revert the repair are both killed.

## J. Stopping

- **Gate:** the targeted run passed 8 suites / 85 tests (tt71-focus 7, e2e-tt71-focus 4, integration 25,
  a11y-unit 8, layout-unit 8, tabletop-unit 17, tt67-input 11, e2e-tt60 5).
- **Full gate:** run-all with 172 suites → **1296 passed / 0 failed**, no crashes, GATE EXIT 0. This is the first
  zero-failure gate since TT60; the usually flaky e2e-privacy, e2e-a11y, e2e-tt28 and e2e-tabletop all passed this run.
  That does not make them fixed.
- **Mutants:** 19/19 killed.
- **Ledger:** tested full **230** (TT70: 229) / partial 72 / untested **81** (82). Tests 1296/1296.
- **Why stop here:**
  - The row is complete except for the three disclosed gaps in C.
  - The next untested-but-"built" rows (SH-11, SC-05) need building, not testing, and do not fit this turn.
