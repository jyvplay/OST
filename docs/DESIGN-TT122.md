# TT122 — twenty-one Class-A features, and an honest speed verdict

Register: 526 → **547 requirements, 441 built** / 64 partial / 24 blocked /
18 probe (live `/api/features`, `/api/spec-health` clean). SEED 3.92.0.
PR #14 kept open at the user's instruction.

## Built (engine + UI + unit contract; mechanism e2e where the UI is the mechanism)

PK-01 Peek file facts · CP-01 Capture countdown · DV-01 Devices battery
card · MN-01 Monitor job sort · RT-02 Routines search · AR-01 Archive
entry filter · LN-16 Lens camera facing · ED-06 Editor soft-wrap ·
CK-06 Clock copy-laps · NT-06 Notes bundle export · CN-08 Contacts
single-card vCard (parse round-trip proven) · BK-10 Backup copies in
Files + freshness inventory · MD-11 Media loop · ST-11 Storage
reclaimable total · SP-02 Spec family progress · AP-07 Apps sort ·
MU-05 Streams library stats · PH-06 Photos shuffle slideshow ·
PL-07 Planner completion counts · LD-01 Local-disk sync summary ·
AX-24 drawn battery/timer glyphs (used in Devices/Capture, not just
defined). Evidence: `tt122-core` 20/20, `e2e-tt122` 3/3, `tt122-density`
47/47.

Redirected by the code (recorded in the seed rows): PH-06 (slideshow
interval already existed → shuffle), PL-07 (done-filter already existed
→ completion counts), BK-10 (no /Backups inventory existed → save dated
copies there first, then list them honestly).

## The speed question, answered with measurements

The user asked for actually-faster scripts on a 2-CPU box. Three
candidates were built and measured:

1. **Parallel browser lanes** (second production server + second
   database `app_db2`, density suites concurrent with e2e): wall time
   **unchanged** (~14m29 vs ~14m01 sequential) and CPU contention caused
   real timeout failures across e2e-a11y (8 tests). **Rejected as
   not Pareto**; the lane code was removed, the verdict is recorded in
   `run-gate.sh`'s header. (Two genuine bugs found on the way: psql is
   not on PATH here — DB admin now uses node+pg; `drizzle.config`
   hardcodes `app_db`, so a lane push needs its own generated config.)
2. **Readiness waits instead of fixed sleeps** in all seven density
   suites (measure only once the window has content; 8s honest
   timeout): also *more* faithful — it exposed that the old 1100ms
   sleep had been measuring data-dependent lists (Notes, Contacts)
   half-loaded.
3. **One shared browser context per density sweep** (warm JS cache
   across the 47 modules): tt122-density 148s → 128s, ~14%, with
   identical assertions and 47/47 measured.

Final gate: **33 suite summaries, GATE PASSED in 14m48s** — three more
suites than TT121's 14m01 for 30. Per-suite density cost is down; total
cost tracks coverage, as stated last turn.

## Bound maintenance disclosed (all commented in the suites)

Spec 11_800 → 12_200 in five density suites (register 526 → 547; Spec
lists every row). Backup 400/410/420 → 440 (BK-10 section). Notes
bounds unified at 90 and Contacts at 200 in tt120-density: fully-loaded
lists are seeded session data, the category the Monitor/Planner bounds
already carve out — the audit's target is control chrome, not list
content. Editor 30 → 160 in tt118-density: a recovery draft from gate
e2e editing can auto-load and is likewise session data.

## Outcome space

- **H+:** twenty-one features at stated evidence; gate green as one
  command; the parallel-lane hypothesis falsified with data.
- **H−:** unchanged platform limits (battery API absent in some
  browsers — stated in the card, never faked).
- **H∂:** full-ledger green (run-all.sh not run end-to-end).

**Next highest-information test:** full `run-all.sh` run; then attacking
per-module page-load cost in density suites via a persistent desktop
session if the shell gains a state-reload signal.
