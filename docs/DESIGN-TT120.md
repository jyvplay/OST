# TT120 — eleven Class-A features, AX-22 contrast debt closed, one-command gate

Register: 494 → **505 requirements, 399 built** / 64 partial / 24 blocked /
18 probe (live `/api/features`, `/api/spec-health` clean). SEED 3.90.0.
Branch `arena/c7f57ea7-ost`; PR kept open at the user's instruction.

## Built (engine + UI + unit contract; mechanism e2e where the UI is the mechanism)

| Code | Feature | Evidence |
|---|---|---|
| ED-04 | Editor go-to-line + live stats (wc-identical counting) | tt120-core, e2e-tt120 (stats `3 lines · 6 words`; caret at byte 8 = line 2) |
| NT-04 | Notes export as self-contained Markdown | tt120-core (`../../etc/passwd` → `etc passwd.md`) |
| PL-05 | Planner due presets + overdue count | tt120-core |
| WD-04 | Clock business-hours indicator per zone | tt120-core, e2e-tt120 |
| TM-04 | Terminal `head`/`tail` | tt120-core, e2e-tt120 on a real VFS file |
| BK-08 | Backup freshness (never/fresh/stale, threshold stated) | tt120-core |
| SR-10 | Find result summary by source | tt120-core |
| PH-04 | Photos editor prev/next (no silent wrap, position stated) | tt120-core, e2e-tt120 |
| MU-03 | Streams provider facet (unknown facet = empty, not everything) | tt120-core |
| CN-06 | Contact stars (browser-local; vCard file never rewritten) | tt120-core, e2e-tt120 (persists across reload in one profile) |
| AX-22 | Contrast asserted for browser/recall/lens/pdf; all 47 apps re-measured | tt120-density |

## Bugs the new tests caught (fixed in the mechanism, re-gated)

1. **Editor go-to-line corrupted the buffer**: pressing Enter in the
   line-number input moved focus to the textarea mid-keystroke, and the
   Enter's `beforeinput` inserted a newline at the caret (caret landed at
   9, not 8, and the document gained a character). Fixed with
   `preventDefault()`; e2e asserts the exact byte offset.
2. **Editor stats disagreed with `wc`** (segment counting vs newline
   counting). `docStats` now uses wc's rule, so Editor and Terminal report
   the same line count for the same file — the seed claim is now true.
3. **Note export filename** needed two adversarial rounds: separators
   first, then leading dots (`.. etc passwd.md` hidden-file risk).
4. **Density measurement bugs** (in the suite, disclosed as such): a
   regex escape eaten by an intermediate string layer (`\d` → `d`), an
   `rgba()` colour parser that read translucent colours as black, and a
   TT118 bound made stale by WD-04's badges (raised 130→145 in both
   suites with the reason in a comment — the successor suite asserts the
   same 145). Monitor's bound was raised 440→500 in both density suites:
   Monitor lists live jobs/command-log, so its count is session-data
   dependent (424 fresh, 469 after a turn of file operations) — the same
   treatment Planner task titles already had.

## AX-22 contrast closure

TT119's baseline offenders are fixed at the source: the shared Toggle's
off-track went from white 12% to 28% over dark; PDF colour swatches gained
a 1.5px light outline (the black swatch measured 1.39 against the 1.4 bar
with the old border). The measure itself now judges contentless controls
(swatches, switches) by what a sighted user perceives — own
background/border/knob against surroundings — and text/glyph controls by
text colour against effective background, with alpha colours blended over
their backdrop instead of misread as black. Asserted set: browser, recall,
lens, pdf. `tt120-density` passes 47/47. Visual confirmation:
`docs/screens/tt120-{lens,pdf,contacts}.png` (Lens switches plainly
visible). Noted, not fixed: the ★ in the Contacts filter can render as a
fallback box in headless Chromium's font set.

## Speedup: the gate is now one command

`scripts/run-gate.sh` runs the full per-turn gate (16 pure suites in
parallel via run-fast's mechanical refusal rules, then 10 browser suites
sequentially against the gate server) with verdict-identical summary
checks. This turn it ran end-to-end in **12m01s, GATE PASSED** — replacing
the hand-typed per-turn sequence whose cost was orchestration errors
(two of this turn's early failures were stale-state artefacts of manual
sequencing, caught because the gate is strict). Browser suites remain
sequential (shared server/DB/Chromium); the TT119 launcher fast path is
unchanged. `vector-boolean`'s GEOS failures remain pre-existing (proven
on the TT117 tree) and outside the claim. One e2e-a11y test ("style
switch") timed out inside the first gate run and passed 9/9 on isolated
re-run and in the final clean gate — recorded as contention flake, not
silently absorbed.

## Outcome space

- **H+:** eleven features at stated evidence; gate as one reproducible
  command; AX-22 contrast closure at measured ratios.
- **H−:** unchanged platform limits; stars/star glyphs depend on the
  browser font set for the ★ character.
- **H∂:** full-ledger green (run-all.sh not run end-to-end; the gate
  covers the TT116–TT120 families plus incumbents listed in run-gate.sh);
  Monitor/Planner word counts vary with session data within stated bounds.

**Next highest-information test:** full `run-all.sh` run; then replacing
the ★/☆ text stars with drawn UiGlyph stars so the Contacts affordance
does not depend on font fallback.
