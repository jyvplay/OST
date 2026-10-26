# TT76 — Spreadsheet filters class A, Slides transitions + animations class A, presenter view (CA-02) class A

## Runtime honesty

**Used:**
- Node 22 (`--experimental-strip-types`, including its built-in `BroadcastChannel` for the protocol test), tsc, eslint, and Next 16.2.6 (production build plus `next start`).
- Playwright 1.64.1 driving Chromium 143 (@sparticuz) against that server, with **two real pages** for the presenter/audience test.
- Embedded PostgreSQL 17.10.
- A Python 3.11 venv with the independent oracles, all test-only and never shipped:
  - openpyxl (MIT) for filters;
  - lxml (BSD) for `scripts/oracle/pptx_motion.py` and for the ECMA-376 transitional XSDs (`ooxml_xsd.py`, which is MCE-aware);
  - python-pptx (MIT).

**Corpora** (fetched at test time, not in git):
- ClosedXML AutoFilter workbooks (MIT, through api.github.com);
- Apache POI test-data (Apache-2.0);
- the 95-deck pptx corpus (POI / LibreOffice / web decks).

**Not available:**
- Excel, PowerPoint, LibreOffice, Keynote;
- a Presentation API receiver (Chromecast-class device), multiple physical displays, Firefox and Safari, phones, theorem provers, parallel agents.

"Class A" below therefore means ordinary-app grade on these measurable corpora with independent oracles. It does not mean "verified in Excel / PowerPoint".

The sandbox was reset at the start of the turn. `scripts/sandbox/rebuild-all.sh` (new) restores the whole environment, and every gate here ran after that.

## A. Formal model

### AutoFilter criteria (FF-62)

**Shape.** A filter column holds exactly one criterion:
- `values` (with `dateGroupItem`s),
- `custom` (≤ 2 rules, And/Or),
- `top10` (top/bottom, N or N %),
- `dynamic` (average or a date period),
- `color` (cell/font, through a dxf),
- `icon`.

A row is shown iff every filtered column accepts its cell (ECMA-376 §18.3.2).

**Typed comparison.** A rule's value has a detected type (number/date, text, boolean, error). `<`, `≤`, `>` and `≥` only match cells of that type:
- text compares case-insensitively;
- booleans order false < true;
- errors compare by code;
- a blank never matches.

`equal` with a wildcard matches text only, through a regex-free matcher (`*`, `?`, `~`), so ReDoS is impossible. `equal` without a wildcard compares displayed text.

**Top N.** Numbers only; ties are included; the percent count is `max(1, floor(n·p/100))`.

**Averages.** Strict comparison, numbers only.

**Dynamic periods.** Half-open serial ranges `[val, maxVal)` from today; weeks start on Sunday; yearToDate runs from Jan 1 through today. ECMA worked example: 2006-09-22 → [Sep 17, Sep 24).

**Colour filters.** They reference a dxf, written and pruned with the filter.

### Slide transitions (FF-63)

`SlideTransition = (kind ∈ {none, cut, fade, push, wipe, cover, pull, split, zoom, random, other}, dir?, thruBlk?, orient?, inOut?, durMs, advClick, advAfterMs?, name?, playsAs?)`.

**Reading.** `p:transition` is read directly or inside `mc:AlternateContent`. The Choice's `p14:dur` (exact ms) wins over the Fallback's `spd` bucket (fast 500, med 750, slow 1000). Diagonal cover/pull and any non-modelled element (p14 vortex, ripple, …) are read as `other`: kept byte-for-byte, only their timing is editable, and they play as their Fallback kind.

**Writing.** As PowerPoint 2010+ does: AlternateContent(Choice Requires=p14 with `p14:dur`, Fallback with `spd`), so an MCE-unaware reader sees a valid transition. Cut is written plain. The transition is inserted before `p:timing` / `p:extLst` (schema order).

### Slide animations (FF-63)

**The model.** The main sequence is an ordered list `Effect = (spid, trigger ∈ {click, with, after}, delayMs, durMs, kind, from?)`. Native kinds are Appear (presetID 1), Fade (10), Fly In (2), Wipe (22) and Zoom (53); everything else is `foreign`, kept as its original `p:par` with its cTn ids renumbered.

**Structure.**
- Click groups → after-chains → effects.
- An after-chain's offset is the previous chain's longest `delay + dur`.
- A first effect that is not "on click" makes group 0 start on `onBegin`.

**Validity invariants** (checked by the oracle):
- every cTn id is unique;
- every `spTgt` / `bld*` spid names a shape on the slide;
- durations are clamped to 0–59 s;
- effects for missing shapes are dropped.

**Read-only cases.** A timing tree without `tmRoot`, or one wrapped in AlternateContent, is read-only: kept verbatim, and editing refuses. Deleting a shape prunes its effects and build entries. Modelled timelines are re-emitted; opaque ones are pruned at the smallest enclosing `p:par`.

**Playback.**
- `playSteps` gives click steps with item start times.
- Shapes whose first effect is an entrance are hidden until it plays.
- A foreign entrance appears, a foreign exit hides, and emphasis/paths are inert.
- CSS animates only the individual `translate` / `scale` / `opacity` / `clip-path` properties, so a shape's own rotate/flip `transform` is untouched.
- `clip-path` keyframes name both ends as `inset()`.
- `prefers-reduced-motion` is honoured.

### Presenter view (CA-02)

**Session.** The presenter opens `/present?show=<sid>` (64-bit random sid) in a second window, synchronously inside the click so it is not a blocked pop-up. It is moved to another screen when the Window Management permission is already granted.

**Protocol** (`showlink.ts`):
- receiver → presenter: `hello` (repeated until the deck arrives), `ready`, `nav`;
- presenter → receiver: `deck` (the .pptx bytes once), `state (i, done, animate, key, from)`, `end`.

**Validation.** Every message is checked on receipt:
- the deck must be a ZIP of at most 64 MiB, with a name of at most 260 characters;
- indices and step counts must be in bounds;
- unknown keys are dropped.

**Transports.** `BroadcastChannel` (tested) and a PresentationConnection text adapter (the same protocol; not exercised, because there is no receiver device).

## B. Outcome space

| Hypothesis | Verdict |
|---|---|
| **H+ filters** | Accepted. 18 of 19 external oracle filters match; S1–S4 and D1 port the ClosedXML/PhpSpreadsheet expectations. |
| **H∂ filters** | The thousands-separator sample (`AutoFilterWithThousandsSeparator.xlsx`) is a declared locale boundary: its criterion text depends on Excel's locale. |
| **H+ slide motion read** | Accepted. 551 slides, 216 transitions and 237 effects agree with lxml. |
| **H+ slide motion write** | Accepted. 301 slides are re-emitted from Fusion's model, are XSD-valid, open in python-pptx, and reread identically. |
| **H∂ slide motion** | Non-native effects and p14 transitions play approximately (by design, stated in the UI). Interactive trigger sequences and media are kept, not played. |
| **H+ presenter** | Accepted with two real pages. |
| **H− presenter** | Presentation API TVs are untested (no device). |

## Class A criteria and results

| Gate | Result |
|---|---|
| tt76-sheet | 13 / 13: O1, S1–S4, D1, R1–R5, U1, N1–N18 |
| e2e-tt76-sheet | 6 / 6. The Condition dialog in real Chromium, with openpyxl reading the saved colour filter and hidden rows. The dialog screenshot was checked after the layout fix |
| tt76-slides | 8 / 8: M1–M6, L1, N1–N17 |
| M1 | 95 decks / 551 slides (12 decks are refused by the pre-existing reader: encrypted or broken). 216 transitions (10 in p14 AlternateContent), 237 effects (107 native), 0 disagreements with lxml |
| M2 | 26 decks / 301 slides re-emitted. No new XSD error (errors already present in the source decks are subtracted), python-pptx opens every one, lxml sees the same effects/groups, ids are unique, nothing dangles, and the reread is identical |
| M3 | 10 transitions and 7 effects (5 kinds × 3 triggers, directions, delays) authored on a blank deck and read back exactly by lxml and by Fusion |
| M5 | 50 animated shapes deleted across 14 decks; nothing dangles and the files stay XSD-valid. Opaque and AlternateContent timelines are covered by N15 / N17 |
| L1 | Real BroadcastChannel round trip; 11 hostile messages and 5 garbage text frames dropped; other sessions isolated |
| e2e-tt76-slides | 7 / 7: E1 authoring through the UI → save → oracle; E2 undo/redo; E3 show builds plus an observed **mid-wipe** clip; E4 foreign effects kept; E5 the modal-shortcut test; E6 no page errors; E7 presenter + audience pages |
| tt76-mutants.py | 16 / 16 killed (after M6 was strengthened, see D) |
| Full regression gate (188 suites) | 1475 passed, 4 failed. All 4 were diagnosed (above), fixed and rerun green: e2e-tt51-slides 6/6 three times, e2e-tt67-input 5/5. Ledger: 394 features, tests 1479/1479, failingTouch 0 |

## D. Negative space (result shapes that look right but are not)

1. A wipe that "works" in tests but jumps at 50%: `inset()` → `none` is not interpolable. **The first screenshot showed it.** The e2e now samples the computed clip mid-transition, and M6 checks that every clip keyframe names both ends. Mutant C1 at first SURVIVED the unit test; M6 was strengthened until it was killed.
2. Transition duration read from `spd` only, so every p14 duration is wrong. Caught by M1 / M3 and mutant P1.
3. Re-emitting foreign effects without renumbering their ids, which creates duplicate cTn ids (PowerPoint repairs the file). Caught by M2 and mutant P2.
4. "With previous" starting a new click step. Caught by M3 / M4 and mutant P3.
5. Deleting a shape and leaving its `spTgt`: **a pre-existing bug since TT51.** Caught by M5 / N15–N17 and mutant P4.
6. A spid injected into the XML. Caught by N7 and mutant P5.
7. Effects on missing shapes written, so targets dangle. Caught by N6 and mutant P6.
8. **(Second-order)** A timing tree wrapped in AlternateContent read as "no timing", so an edit adds a second `p:timing`. Found by attacking the first version; covered by N17 and mutant P7.
9. An empty `tmRoot` (no main sequence) read as read-only, so such slides (e.g. `2411-Performance_Up.pptx` slide 47) could not be animated. Found while sanity-checking the oracle; fixed.
10. `thruBlk:false` appearing where the file had none, so the model is unequal after a round trip. Found by M2.
11. An audience screen accepting any message on the channel. Caught by L1 and mutants C3 / C4.
12. Hidden-until-built missing, so shapes flash before their entrance. Caught by M6, E3 and mutant C2.
13. Filters: And evaluated as Or; Top N % rounding up; ties dropped; averages inclusive; dynamic ranges closed. Caught by mutants F1–F5.
14. **The modal shortcut.** Delete / Backspace / Ctrl+D typed in a Motion field, or during the show, must never delete the selected shape or duplicate a slide (E5). Likewise, Enter in an empty Condition value box applies nothing (e2e-tt76-sheet).
15. Speaker notes leaking to the audience screen. E7 asserts the audience text lacks them.
16. Icons that render as tofu boxes (↑ ↓ ✕ ▶ were missing from the UI font). Found in the screenshot; replaced by inline SVG.

## E. Approaches considered (mechanism-distinct)

1. **Typed effect list plus foreign XML carried in place.** Chosen: edits are lossless for everything not modelled.
2. **Full SMIL timing engine** (evaluate any `p:par`/`p:seq`/`p:anim` tree). Rejected for this tier: very large, and its results could not be verified without PowerPoint.
3. **Web Animations API driven from JS** instead of CSS keyframes. Rejected: harder to make deterministic under React re-renders, and no gain for these effects.
4. **Canvas/video rendering of slides for the audience.** Rejected: it costs bandwidth and loses text crispness. Sending the deck once plus tiny state messages was chosen.
5. **WebRTC to the audience screen.** Unnecessary on one device; BroadcastChannel is simpler and private. It would be the route for a remote audience.
6. **Presentation API only.** Rejected as the sole path because Chromium has no receiver device here and most desktops have none. Kept as an adapter.

## Fixed this tier

| Fix | Evidence |
|---|---|
| Slides `deleteShape` left dangling animation targets (since TT51) | M5 |
| Empty tmRoot read-only | Oracle run |
| Wipe/split transitions and the Wipe entrance flipped at 50% | Screenshot, then E3 / M6 |
| Tofu icons in the Motion panel | Screenshot |
| Spreadsheet Condition dialog inputs were squashed | Screenshot, rechecked after the rebuild |
| Slides stage started from a 720 px guess and resized after first paint (every deck jumped once; early clicks hit the wrong shape). Now measured in a layout effect before paint | Gate: e2e-tt51-slides "pick selected nothing", reproduced 2/3 with a probe that logged the canvas box at click time |
| e2e-tt51-slides `name: /Present/` also matched the new "Presenter view" button (strict-mode violation) | Gate |
| e2e-tt67-input failed after an earlier suite left `appearance.layout = business`; it now forces Fusion and restores the previous value (verified from a Business start) | Gate, reproduced 2/2, then 5/5 after the fix |

## Remaining blockers / limits (TT76)

- **Slides:**
  - emphasis, exit and motion-path effects are kept but only approximated in the show (exit hides, emphasis/paths inert);
  - p14 transitions play as their Fallback kind;
  - interactive trigger sequences and media are not played;
  - no PDF export, no find/replace;
  - PowerPoint was not run.
- **Presenter:**
  - Presentation API receivers untested;
  - the automatic second-screen placement needs an already-granted Window Management permission; otherwise the user drags the window;
  - a single presenter per audience window.
- **Shell:** windows shift down once after the settings load (the Fusion top bar appears); tests wait for a stable layout, but the shift itself remains.
- **Filters:** the locale-dependent thousands-separator criterion; Excel was not run.
- **Never tested here:** Excel, PowerPoint, LibreOffice, Firefox, Safari, mobile, real projectors/TVs.
