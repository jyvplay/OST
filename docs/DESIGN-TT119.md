# TT119 — eleven Class-A features, AX-21 (words + contrast), launcher fast path

Continues TT118 on the same branch/PR. Register: 483 → **494 requirements,
388 built** / 64 partial / 24 blocked / 18 probe (live `/api/features`,
`/api/spec-health` clean for all new codes). SEED_VERSION 3.89.0.

Environment note: this turn began in a fresh sandbox whose git HEAD had been
reset to the base commit while the working tree held the TT118 files. The
pushed commit `4295fc5` was fetched and hard-reset to, so TT119 starts from
exactly the tree TT118 reported. PostgreSQL 18.4 was rebuilt via the PyPI
wheel recipe; schema via `drizzle-kit push`.

## Built (engine + UI + unit contract; mechanism e2e where the UI is the mechanism)

| Code | Feature | Engine | Evidence |
|---|---|---|---|
| ED-03 | Editor find & replace (literal, counted, nth-only) | `editor-find.ts` | tt119-core, e2e-tt119 |
| NT-03 | Notes daily note (local date, never guesses) | `daily-note.ts` | tt119-core |
| PL-04 | Planner filter (title+notes, order preserved) | `task-filter.ts` | tt119-core, e2e-tt119 |
| CK-04 | Clock custom zones (Intl-validated, UTC pinned, cap 12) | `zone-list.ts` | tt119-core, e2e-tt119 (persists) |
| WD-03 | Zone time converter with day shift | `zone-convert.ts` | tt119-core, e2e-tt119 |
| TM-03 | Terminal `wc`/`du`, POSIX lines, UTF-8 bytes | `wc-core.ts` | tt119-core, e2e-tt119 (`2 4 22 /tt119.txt`) |
| BK-07 | Backup bundle contents explorer (folder byte rollup) | `bundle-tree.ts` + `folder-size.ts` | tt119-core |
| SR-09 | Find recent searches (cap 20, mode-validated) | `recent-searches.ts` | tt119-core, e2e-tt119 |
| PH-03 | Photos slideshow (wraps, 1–60 s clamp, control lives in viewer too) | `slideshow.ts` | tt119-core, e2e-tt119 |
| MU-02 | Music recently-played (front-dedup, cap 50) | `recent-plays.ts` | tt119-core |
| AX-21 | All-app re-measure + control contrast assertion | `tt119-density.mts` | tt119-density |

Two candidates were **dropped mid-turn on evidence**: Files folder sizes
already exist server-side (FM-17) and Backup already has a server restore
preview (BK-05) — duplicating either would have been exactly the false
progress this register exists to prevent. One engine bug was caught by its
own new test (wc counted line segments, not newline characters) and fixed in
the engine. One real UX bug was caught by e2e: the slideshow control
unmounted when the photo opened; the toggle now lives in the viewer as well,
and the repair was re-gated (rebuild + e2e re-run) rather than inherited.

## AX-21 numbers (47/47 windows, this build)

Reductions from TT118: **messages 335→289** (Lens-upscale explanation behind
a one-line summary; the Blocked honesty sections stay fully visible),
**monitor 487→424** (ADPF-analogue and TD-06 explanations summarised),
storage 308→302. Bounds tightened for eleven modules; spec/settings/apps
exceptions unchanged and still declared. Clock 128 (new zone UI included),
editor 22 (find bar included — compact row), photos 44, planner 79.

Contrast: TT118 photographed near-black Browser toolbar glyphs but could
only report them. TT119 measures computed-colour contrast of every visible
control against its *effective* background (own background, else nearest
opaque ancestor) in Browser and Recall and asserts ratio ≥ 2.2. Result:
**no offenders in Browser or Recall** — the glyph colours are sound; what
reads as dark in screenshots is stroke weight at small size, now a measured
non-issue rather than an anecdote. Baseline offenders outside the asserted
set, printed by the suite: lens (Vignette/Mirror toggles 1.64), pdf (colour
swatch labels 1.30–1.73).

## Honest speedup (Pareto, fidelity-identical)

Every browser suite was paying ~2.46 s for sparticuz's `executablePath()`
unpack probe (measured). `scripts/browser-launch.mts` now launches the
already-unpacked `/tmp/chromium` directly when all three unpack markers
exist — same binary, same args, same env; any missing marker falls through
to the real unpack, so a cold machine behaves exactly as before. Launch +
version + close now takes **1.09 s end-to-end**. Browser, database, and
server suites remain sequential (shared state); the pure set gained
`tt119-core`: 15 suites, **169/169 in 12.4 s** at JOBS=4. The earlier
TT118 verdict-identical diff proof stands as the fidelity method; TT119's
identical-verdict evidence is the gate below rerun under the fast path.

## Gate (this turn, production build)

tt119-core 11/11 · e2e-tt119 4/4 · tt119-density 1/1 · tt118-density 1/1 ·
tt117-density 1/1 · e2e-tt117 5/5 · tt116-density 6/6 · e2e-a11y 9/9 ·
run-fast pure set 169/169. **38/38 + 169/169.** Not rerun: the remaining
incumbent suites (ledger claim stays H∂). `vector-boolean` GEOS failures
remain pre-existing (proven on the TT117 tree in TT118) and outside the claim.

## Outcome space

- **H+:** the eleven rows above at stated evidence; launcher fast path with
  cold-machine fallthrough; AX-21 reductions at measured numbers.
- **H−:** unchanged platform limits (physical devices, native shell,
  telephony, store/payment surfaces); word counts still do not prove glyph
  comprehension.
- **H∂:** full-ledger green; lens/pdf contrast baseline; glyph stroke weight
  at small sizes (measured colour-sound, not yet measured legible).

**Negative space (looks-done shapes rejected this turn):** regex find (a
query `a.b` matching `axb` — tested against); folder sizes re-implemented
in Files (already FM-17); a second restore preview (already BK-05); wc
counting lines as segments (caught by test); a slideshow control that
vanishes in the viewer (caught by e2e); contrast measured against body
background instead of effective background (first version flagged the
traffic-light window buttons at 1.05 — measurement bug, fixed, Browser/
Recall then clean); speedup claimed from wall-clock without identical
verdicts.

**Next highest-information test:** full `run-all.sh` ledger on this build;
lens/pdf contrast fixes with the AX-21 measurement extended to those two
windows.
