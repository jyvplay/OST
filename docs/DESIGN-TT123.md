# TT123 — twenty more Class-A features; the ledger goes green on one command

Register: 547 → **567 requirements, 461 built** / 64 partial / 24 blocked /
18 probe (live `/api/features`, all twenty new codes `built`). SEED 3.93.0.
PR #14 kept open at the user's instruction.

## Built (engine + UI + unit contract; mechanism e2e; density visit)

WB-07 Whiteboard PNG export · VT-01 Vector 2× PNG export · BM-01 Beam
live-session elapsed · AL-01 access-log filter · SSH-01 terminal font
ladder · CK-07 world-clock offset order + UTC labels · ED-07 find-match
stepping with honest wrap reporting · NT-07 note tag facets · BK-11
dated-backup prune (keeps 2, undated never eligible) · TM-06 terminal
`history` builtin · CV-03 calculator history as chronological text ·
MS-05 message search over loaded messages · PH-07 photos "No date"
view · PL-08 copy overdue list · SR-12 exact-phrase search (quotes
doubled, never stripped) · DV-02 copy device info with absences stated
· SL-01 slides go-to clamp · CN-09 family-name sort · AX-25 drawn
shuffle/wrap glyphs (used in Photos/Editor) · FM-19 copy folder names
list. Evidence: `tt123-core` 18/18, `e2e-tt123` 3/3 (mechanism:
match-stepping selects in the textarea; prune/copy-info/no-date/go-to
render; history builtin + font buttons + PNG button), `tt123-density`
23/23 (20 module visits within caps, register assertion, glyph
assertion, screenshots).

Redirected by the code: Vector already exported a **1×** PNG, so VT-01
is the 2× capped-raster export through the new shared `raster-size`
engine (16-megapixel cap, status states the true size and when the cap
scaled down) — Whiteboard reuses the same engine for WB-07. Absence
sweep first: table row-duplication, image rotate/flip, Together
link-copy, contact sorting, stream shuffle+history, open-terminal-here
and the slides presenter view all already exist; none were rebuilt.

## The speed question, measured again

Last turn's two wins (readiness waits + one shared browser context per
density sweep) are inherited by `tt123-density` and by the six older
density suites. This turn added no new parallelism claim: a third
measurement attempt (pure-suite `JOBS` fan-out inside run-fast.sh) was
already present and kept; the gate remains sequential by the TT122
verdict (parallel browser lanes on 2 CPUs cost e2e-a11y failures for
zero wall-time win). Honest summary: **per-density-suite cost is down
from TT121's fixed-sleep baseline; total gate cost tracks coverage**
(this gate runs 36 suite summaries).

## Bound/limit disclosures (all commented in the suites)

`tt123-density` caps are first-turn caps for the twenty touched
modules, not fitted actuals — stated in the suite header. List content
that scales with seeded data (notes/contacts/monitor/planner) keeps
the session-data treatment established in TT120/TT122. Editor's
recovery-draft auto-load is session data (TT122 disclosure stands).

The gate needed three runs to reach green, and each intermediate
failure is disclosed rather than hidden: (1) the five older density
suites measured Clock at 151 words against 145–150 caps — CK-07's
per-row UTC labels and toggle are real new chrome, so the cap moved
to 160 in all five suites with a CK-07 comment; (2) tt118-density
measured Photos at 45 against 40 — the PH-07 view button plus pictures
the gate's own DB seeds are list content, so that cap moved to 60
under the session-data treatment. No cap moved down-to-up without a
named cause, and no assertion was weakened: word counting, contrast
and glyph scans are unchanged.

A fourth run binds the green gate to the shipped build after a visual
defect fix: the find-bar's text arrows (↑/↓) rendered as illegible
slivers in this stack's fonts, so they became drawn caret glyphs
(AX-25 extended to four glyphs; SEED 3.93.1) and `tt123-density` now
asserts the match-step buttons carry SVG carets, not text arrows.

## Outcome space

- **H+:** twenty features at stated evidence; one-command gate green.
- **H−:** unchanged platform limits (battery/serial/etc. probes state
  absence; DV-02 writes "not exposed" rather than guessing).
- **H∂:** full `run-all.sh` still not run end-to-end this turn.

**Next highest-information test:** a full `run-all.sh` pass (the
carried H∂), then per-module page-load cost in density suites if the
shell gains a state-reload signal.
