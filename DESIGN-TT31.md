# TT31: Live walls (LY-22)

**Blocker addressed:** the user reported, "Right now the other panes are static but I need them to be the same level of functionality as every other plane."

Up to TT30, the Tabletop's four walls worked like this:
- they could be used only after opening one as the main view (double-click or the wall tag);
- in the box view they showed pinned items as shapes, and floor cards could be dropped on them;
- the drop went to a *free slot*, not to the place where it was dropped.

TT31 makes every wall a live surface **in the box view itself**:
- motion (move along the wall);
- piling;
- fanning;
- dragging out;
- dropping exactly where released;
- infinite pins;
- keyboard use.

The resting camera stays untouched (slanted, with the floor at ≥ 80 %).

## Runtime honesty (what was actually executed)

- **Tools:**
  - Node 22 and TypeScript (`--experimental-strip-types`);
  - Playwright 1.64 against the sandbox's headless Chromium, with axe-core;
  - a Next 16.2.6 production build on :3999 with embedded Postgres.
- **Pointer events:** all interaction tests use real Playwright pointer events (`mouse.move`, `down` and `up`, and the wheel) against the production build. Nothing is mocked.
- **Inputs not exercised:** touch is not exercised; headless Chromium is driven with a mouse. The phone test uses a 390×760 viewport with keyboard focus.
- **Code provenance:** no library was added. `wall-live-core.ts` is original code built on the existing slant-camera maths (`tabletop-slant.ts`, TT27).

## A. Formal model

- **Board.** A wall's pins live on its board, `x ∈ [0, MAX_X = 728]` with an unbounded `y`.
  - Row `r = round((y − 24) / 205)`; `rowY(r) = 24 + 205·r`.
- **Strip.** The rows are unrolled into one strip along the wall: `S = r·PITCH + x`, where `PITCH = 840 + 72`.
  - The strip is a band of height `BAND = 229`, and `t` is the offset inside the band.
  - `boardToStrip ∘ stripToBoard = id` on grid points.
- **Strip frame per wall.** An element-space frame `(u, v)` is used, with rotation 0 (N/S) and ±90 (E/W). It is a pure rotation (det +1, never mirrored) with padding `padU`/`padV` and scale `k = (thickness − head − 2·pad) / BAND`.
- **Visible range.** The visible part of the strip is `[pan, pan + visibleS]`.
  - `rows = maxRow + 2`, so there is always one empty row.
  - `maxPan = rows·PITCH − 72 − visibleS`.
- **Lifted pose.** A dock rectangle sits inside the frame along the wall's own edge, with its own size (not the rest element size, which gave k ≈ 0.47).
  - `liftMatrix` is the exact homography taking the element onto the dock at depth `Z`, in front of every resting face.
  - z-index has no effect inside `preserve-3d`, so the pose is genuinely in front in Z.
- **Hit testing.**
  - `screen → element` uses the inverse homography of the face's measured quad (rest or lifted).
  - `surfaceAt` follows paint order: the lifted wall, then the tags, then the floor.
  - A resting pin is a target only if its projected box is ≥ 24 px on both axes (WCAG 2.5.8).
- **State machine** per wall: `rest → (real pointer movement ≥ 300 ms | focus) → lifted → (leave the keep-region 450 ms | Esc | blur) → rest`.
  - During a drag, crossing to another wall's quad (geometry, not DOM events, because pointer capture blocks enter/leave) arms spring-load after 350 ms.
  - Every face change goes through `openFace`, which cancels all lift timers.

## B. Hypotheses

**H+ (claimed and tested):**
- A hovered or focused wall lifts flat and inside the frame, with pins ≥ 24 px and names ≥ 9 px.
- A floor→wall drop lands at the mapped point (within 1 px).
- Move, pile, fan, drag-out and wall→wall spring-load all work.
- 40 pins are all reachable.
- Keyboard-only use works.
- Phone and top-camera layouts work.
- axe reports no serious or critical violations.
- The resting camera is unchanged.

**H− (claimed impossible, and tested to fail closed):**
- A drop to a free slot instead of the mapped point.
- A mirrored frame.
- Panning past either end.
- A lifted pose outside the frame or behind a face.
- A side-sliver pin as a target.
- A fan that runs before S = 0 or overlaps by more than 14 %.
- Text under 9 px.

**H∂ (boundary):**
- **Resting side walls are scale ≈ 0.14 at 1440** (0.044 on a phone). They are deliberately *not* fine-grained targets at rest; they lift first.
- **A card dropped on a resting side wall still lands mapped.** For fine placement there, the wall lifts after 350 ms.

## C. Frontier (what is not covered)

- **Touch:** lifting on tap is coded (non-mouse `pointerType` skips hover intent) but not exercised. There is no touch device and no emulated touch test.
- **Pinboard overflow at 1440 px:** the opened (main-view) wall's pinboard overflow (800 vs 840 px) was fixed in CSS and verified by a diagnostic measurement plus the e2e-tabletop pass. There is no standing assertion for it.
- **Focus after Esc:** after Esc settles a lifted wall, focus stays on the pin. Returning focus to the wall tag is not asserted.
- **Throughput:** behaviour with more than 40 pins was not measured in a browser (unit maths only).

## D. Negative shapes (each has a test that must reject it)

| # | Shape | Where it is caught |
|---|---|---|
| 1 | Off-grid board y does not round-trip to the same row | tt31-unit #1 |
| 2 | Mirrored strip frame (det −1) | tt31-unit #2, mutant |
| 3 | Pan < 0 or > maxPan | tt31-unit #3; e2e-tt31 #5 (pan button disables at the end) |
| 4 | No empty row to drop into | tt31-unit #3 |
| 5 | Lifted pose outside the frame (6 viewports × 4 walls) | tt31-unit #4, mutant |
| 6 | Lifted pose behind a resting face | tt31-unit #4 |
| 7 | Lifted pins < 24 px or names < 9 px | tt31-unit #4; e2e-tt31 #1 and #7 (measured in the DOM) |
| 8 | Screen→element not inverting element→screen | tt31-unit #5, mutant |
| 9 | Side-sliver pin accepted as a target at rest | tt31-unit #6 |
| 10 | Fan before S = 0 or overlap > 14 % | tt31-unit #7, mutant |
| 11 | Floor→wall drop going to a free slot instead of the drop point | e2e-tt31 #2 (second drop further along lands further along) |
| 12 | The lift changing the resting camera (floor < 80 %) | e2e-tt31 #1 |
| 13 | Stale lift after a tag click or Esc | e2e-tt31 #6; e2e-tabletop (passes since `openFace`) |
| 14 | Unasked lift from Chrome's synthetic pointerenter when the layout moves under a parked mouse | e2e-tabletop "wall piles by menu" (failed before hover intent, passes after) |
| 15 | Accessible name not containing the visible label (`label-content-name-mismatch`) | e2e-tt31 #8, which **caught a real bug** this turn |
| 16 | A pin move not persisted | e2e-tt31 #3 and #6 (re-read from the server) |
| 17 | Any text on the Tabletop under 9 px (LY-21) after TT31 | e2e-tt29 (3 viewports) |

**Modal-shortcut test:**
1. Focus a resting wall: it lifts at once.
2. Tab reaches its pins.
3. Alt+ArrowRight moves the focused pin (persisted).
4. Esc settles the wall.

All four steps are in e2e-tt31 #6.

## E. Mechanisms (independent ways the claims are checked)

1. Hand-computed values in unit tests (row and strip, frames).
2. A property sweep: 6 viewports × 4 walls for the lifted pose (slant camera), and the rest quads of both cameras plus the lifted quads for the screen↔element inversion.
3. Mutation testing: 5 seeded geometry defects, all caught.
4. DOM measurement in the real build: `getBoundingClientRect` of pins and names, `elementFromPoint` hit tests, and waiting for `getAnimations()` to be empty before measuring.
5. A server round-trip: positions are re-read from `/api/state` after each move.
6. axe-core (an independent accessibility engine) in dark and light.
7. Visual inspection of 9 screenshots (`scripts/shots-tt31.mts`, written to the git-ignored `scripts/tt31-shots/`).

## F. Artifacts

- **Library:** `src/lib/wall-live-core.ts` (new).
- **Component:** `src/components/Tabletop.tsx` (the TT31 block, hover intent and `openFace`).
- **Styles:** `src/app/globals.css` (the TT31 block and `.fs-tt-wall-split`).
- **Test scripts:**
  - `scripts/tt31-unit.mts` (8 tests);
  - `scripts/e2e-tt31.mts` (8 tests);
  - `scripts/shots-tt31.mts`;
  - `scripts/e2e-tt29.mts` (faces-at-rest poll).
- **Register:** `src/db/seed-data/features-tt31.ts` (LY-22); seed 3.20.0.
- **Test results:** `docs/test-results/tt31-unit.json`, `docs/test-results/e2e-tt31.json`.

## G. Adversary (attacks tried)

- **A parked mouse while the layout changes.** Chrome fires a synthetic pointerenter, which used to lift the wall unasked and broke "wall piles by menu". This led to repair I-3.
- **A click on the tag while a hover timer is pending.** The wall used to lift *after* opening. This led to repair I-2.
- **The hover at a face's bbox centre** lands on the wall tag, not the face. The tests now hit-test `[data-face]`.
- **Leaving and re-entering during the settle animation** made the wall oscillate. This led to repair I-1.
- **40 pins with the pan at maximum:** the last pin is off the start of the view, because the empty row fills the end. The test was corrected to "seen while panning", plus focus auto-pan.
- **axe on the lifted wall** found `label-content-name-mismatch` ×2. This led to repair I-4.

## H. External verification

- **axe-core 4.x** (Deque, an independent engine): 0 serious or critical violations on a lifted wall in dark and light, after repair I-4.
- **Chromium's own hit testing** (`elementFromPoint`) and layout (`getBoundingClientRect`) are the oracle for "where did the card land" and "how big is the pin". The code under test does not compute these.

## I. Repairs (each followed by a new attack)

1. **Hover oscillation.**
   - *Fix:* a geometric keep-region (`hoverTrack`/`settling`) replaces face pointerleave.
   - *New attack:* parked 3.2 s on the lift edge. Stable.
2. **Stale lift after tag click or Esc.**
   - *Fix:* `openFace` clears timers, cancels the spring and nulls the lift; 11 `setMain` calls were rerouted.
   - *New attack:* Esc immediately after hover. e2e-tt31 #6 and e2e-tabletop are green.
3. **Unasked lift from a synthetic pointerenter.**
   - *Fix:* hover intent arms only on real movement (non-zero `movementX/Y`), not while dragging, only when the floor is main, and only for mouse/pen. `onPointerMove` replaces `onPointerEnter` on the face and the tag.
   - *New attack:* the "wall piles by menu" replay. It passes.
4. **Accessible name not matching the visible label.**
   - *Fix:* lifted pins and piles are named by their visible text plus a visually hidden ", pinned to the … wall" (the floor-card pattern). Resting pins, which have no visible text, keep `aria-label`.
   - *New attack:* axe dark + light, and a role/name query. Green.
5. **Opened pinboard horizontal scroll at 1440** (800 vs 840 px).
   - *Fix:* `grid-template-columns: minmax(0, 1fr) min(870px, 64%)`.
   - *New attack:* "walls are pinboards … moved on the wall" passed in e2e-tabletop (14/14) afterwards.
6. **Pre-existing top-camera timing flake** (face height 430→402 still transitioning at 1.4 s, also present on the pre-TT31 baseline in 3 of 6 boots).
   - *Fix in the test:* poll until every face has no running animation.
   - *New attack:* 4/4 runs green.

7. **Test hygiene: shots-tt31 left the shared desktop in Tabletop view.** The first full run (52 suites) had 50 green, but `e2e` (3 widget tests) and `e2e-privacy` (3) failed, because the classic desktop's widgets and windows were not on screen.
   - *Fix:* shots-tt31 now restores the classic view, resets the table, and trashes and purges its files in a `finally`.
   - *New attack:* re-ran shots and checked that the setting reads `classic` and 0 files are left; re-ran `e2e` (61/61) and `e2e-privacy` (14/14).

Repairs stayed within the ~1/10 budget.

## Results

- **Full run:** 52 suites (`run-all.sh`, now including `tt31-unit` and `e2e-tt31`). After repair 7 and the re-run of the two affected suites, the ledger reads **523/523** tests passing.
- **Register:** 335 rows; built 251 full / 62 partial / 22 blocked; tested 132 full / 77 partial / 126 untested.
- **Tails ledger:** unchanged (39 rows: 9 / 10 / 20).

## J. Stopping

The stopping criteria are:
- all H+ claims have a passing test;
- every D shape has a test that rejects it;
- the full suite is green (see the ledger);
- the visual inspection found no defect.

Stop here. The frontier items in C are listed as such and are not claimed.
