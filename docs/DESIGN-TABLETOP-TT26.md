# TT26 design notes — aesthetic dock sizing, rearrangeable icons, the Tabletop 3D desktop, the beauty standard

> **TT27 update:** the default camera is now a slanted desk view (floor ≥ 80 % of the frame, measured), every wall is a
> pinboard with unlimited pins and piles, and Tabletop views can be saved and loaded. The top-down box described below
> remains available through the **Camera** toggle. See `docs/DESIGN-TT27.md` §1–3.

Status as of 2026-10-17. Everything below is implemented in this repository and exercised by the suites named in
each section; limits are listed at the end of each section rather than hidden.

## 1. Dock icons at a pleasing size (LY-05)

**Problem (TT25):** the Art dock shrank every icon until all 37 apps fit — about 30 px on a 1440-wide screen, which
looked cramped and was below the comfortable touch/pointer sizes every major platform recommends.

**Decision:** the resting icon size comes from the *screen*, not from the number of apps:
`idealDockIcon(vw, vh, pref)` picks a size on the 4-px grid inside a 44–64 px band (≈5.5 % of the screen height,
our own heuristic), or Small 44 / Medium 52 / Large 64 when the user chooses (`appearance.dockSize`). Then
`planDock()` fits the *content* to that size: it folds whole app groups (Core / Create / Connect / System) into
macOS-style stacks, largest groups first, keeping pinned (`files`, `settings`) and running apps visible. Only when
every group is folded and the dock still does not fit does it unpin, then step down (never below 32 px), then let the
dock scroll inside itself.

Measured by `e2e-beauty` (resting icon / whole dock width), production build:

| Viewport | Resting icon | Dock width |
|---|---|---|
| 1920×1080 | 60 px | 1302 px |
| 1440×900 | 48 px | 1086 px (Create and System folded into stacks) |
| 1280×800 | 44 px | 1014 px |
| 390×844 | 36 px (narrow floor ≥ 32) | 342 px (all groups folded) |

Grounding for the band: WCAG 2.2 SC 2.5.8 (AA) minimum 24×24 CSS px (or the spacing exception); SC 2.5.5 (AAA)
44×44; Apple HIG 44 pt (minimum 28); Material 48 dp with 8 dp spacing.

Stack popover: a grid near φ in shape (`cols = ceil(sqrt(n·1.6))`, max 5), clamped to the screen (3 or fewer
columns on a phone), arrow keys move, Esc closes and returns focus to the stack tile. Magnification freezes while a
stack is open.

Tests: `tabletop-unit` (idealDockIcon, planDock ×2), `e2e-layout` ("Art dock: aesthetic size + stacks"),
`e2e-beauty` (dock-band, per-group rhythm, separator rhythm, equilibrium at 4 viewports).

## 2. Rearrangeable desktop icons (LY-06)

Positions are stored as **grid cells** in `DesktopState.icons` (not pixels), so they survive text-size and window
changes. Drag snaps to a cell and swaps with an occupant; Alt+Arrow moves the focused icon (the WCAG 2.5.7
non-drag alternative); the desktop menu has "Clean up icons" (close gaps, keep reading order) and "Sort icons by
name" (natural, case-insensitive, column-major). Saved positions for files that no longer exist are dropped.

**Pre-existing bug found and fixed here:** the desktop context menu closed on `pointerdown` (the desktop root's
handler also fired for presses inside the menu), so the menu unmounted before `click` and *no desktop menu item
ever ran from a mouse click* — this dated back several tiers; earlier tests had only used the keyboard. The menu now
stops propagation; `e2e-tabletop` "desktop icons (classic)" clicks "Sort icons by name" with the mouse and checks the
result, so a regression is caught.

## 3. The Tabletop 3D desktop (LY-07, LY-08, LY-09)

**Model:** an open box seen from above. The floor (`tt-floor`) holds file cards; the four walls hold
Windows (north), Widgets (east), Recent (south) and Apps (west). Pure CSS 3D — one `perspective` on the scene
(0.85 × the larger dimension), `preserve-3d`, walls hinged on their screen edge (`faceTransform`), no WebGL.
`boxGeometry()` gives the floor scale p/(p+depth); the floor counter-scales its content so text renders at true size.

**Making a wall the main view:** double-click a wall (or the switcher, or Enter on it). It unfolds on its hinge to
fill the desk while the others fold away (`awayTransform`) and become `inert`; Back, Esc or a double-click on its
background folds it back. Durations derive from `--fs-motion` (≈720 ms with an ease-out curve); Motion off or
`prefers-reduced-motion` makes every transition instant (tested via computed durations).

**Piles:** drop a card on a card (or a pile) to stack them; deterministic jitter (FNV-1a of the path) makes the stack
look hand-made while the top card stays straight; click fans the pile on an arc (spacing ≥ ⅔ of a card, symmetric
tilt, middle highest); drag a card out of the fan to take it out; a pile of one dissolves. Shift+F10 opens the card
menu (Pile with…, Unstack, Rename) as the keyboard alternative. State lives in `DesktopState.table` and is validated
against the files that exist (`normalizeTable`, `pileUp(..., existing)`), so no ghost cards.

**Micro peek:** every card shows its file's real contents in miniature — Markdown keeps headings and bullets, CSV/TSV
(RFC 4180 quoting) and JSON become row grids, images and SVG show as images (SVG only through `<img>`, which never
runs script), anything else gets an extension badge. At most 4096 characters are read; files over 2 MB get a badge.
Peeks are `aria-hidden` decoration: the card is named by its visible file name, its `title` says what kind of
preview it is, and a shared hidden description explains Enter / drag / Shift+F10 (this replaced an aria-label that
axe flagged as label-content-name-mismatch).

Cards are 112 × 181 px — 1 : φ. That is our own design choice, enforced as a hard `golden-card` rule so it cannot
drift; it is not a claim that φ is universally preferred (see §4).

Tests: `tabletop-unit` (state, piles, geometry, box geometry, micro peek), `e2e-tabletop` (10 tests: toggle,
measured box geometry, wall main view, walls work, micro peek, mouse piles, keyboard piles, desktop icons,
reduced motion, axe on floor + each wall).

**Limits:** no orbit camera or physics; peeks are fetched one after another; windows float above the box (as they
do above the classic desktop), including when a wall is the main view; the switcher overlays the centre of the
south wall; no hot corners in Tabletop; on a phone the floor's lowest row sits under the switcher.

## 4. The beauty standard (LY-10)

`scripts/e2e-beauty.mts` measures, in real Chromium against the production build, every visible control, text
element, icon and panel (`getBoundingClientRect` + computed style; `[data-beauty-skip]`, `aria-hidden` and `inert`
subtrees skipped) in 12–13 views × 4 viewports (1440×900, 1280×800, 1920×1080, 390×844): Fusion desktop with icons,
Fusion launcher, a Settings window (large viewports), Business taskbar, Start, Art menu bar + dock, a dock stack,
Launchpad, the Tabletop floor and each wall as the main view. The boxes go through the pure rules in
`src/lib/beauty-core.ts`. It writes `docs/beauty-report.json` and `docs/BEAUTY-REPORT.md`.

### Hard rules (fail the suite)

| Rule | Source |
|---|---|
| target-size ≥ 24×24 or spacing exception | WCAG 2.2 SC 2.5.8 (AA) |
| chrome-target ≥ 32 px for shell launch targets; a target touching a screen edge is unbounded on that axis | between 2.5.8 and Apple 44 pt / Material 48 dp; Fitts's law edge targets |
| overlap: no two visible targets in one region overlap | ambiguous hits; measured on the *visible* (clip-intersected) rect |
| clipped-text without an ellipsis | WCAG 1.4.4 / 1.4.12 resilience |
| offscreen: every control and floating panel is on screen or inside an on-screen scroller | reachability (WCAG 1.4.10 reflow) |
| square-icon | icon system consistency |
| dock-band 44–64 (≥32 narrow), one resting size, dock ≤ 90 % of the screen | §1 |
| rhythm: one gap (σ ≤ 1 px) and one centre line per row (dock per group, separators, taskbar, Launchpad, Tabletop switcher, desktop icon column) | Ngo, Teo & Byrne regularity / alignment |
| equilibrium: centred elements within 2 % of the frame centre (dock, Launchpad grid) | Ngo et al. equilibrium |
| line-height ≥ 1.4 for multi-line paragraphs | WCAG 1.4.12; typographic guides 1.4–1.6 |
| golden-card: Tabletop cards stay 1:φ (±2 %) | our own design (§3) |

### Soft findings (reported, never failed)

* **proportion** — panels near a "pleasing" rectangle (φ, 5:3, 3:2, √2, ±6 %).
* **type-scale** — more than 8 distinct font sizes in a view, or a largest/smallest ratio above φ⁴ (modular scales
  use ratios of 1.067–1.618; Ngo "economy").
* **Ngo balance** (0–1) per view.

### Why φ is soft

The evidence is mixed: an AIS 2013 study (91 participants) found φ preferred for phone layouts but not for web pages;
a 2024 IJHCI survey of 114 designers found a positive but small relationship; De Bartolo 2022 found a 53 % slight
preference; Fechner (1876) had 35 % choosing 5:8 but 76 % anywhere in 3:5–5:8; a Korean study (277 participants)
preferred 1:√2; other studies prefer 1.5; a PLOS One 2024 RCT and a 2024 PMC review call the φ preference a myth;
practitioner guidance in 2026 (e.g. uxcel) recommends moderate, balanced proportions rather than 1.618 exactly.
So the checker reports how close panels are to a family of pleasing ratios and never fails on it.

### Self-checks — how we know the checker sees things

* Test 1 injects tiny crowded buttons and a clipped label into the live page and requires the pipeline to report
  them, and requires `[data-beauty-skip]` to remove them.
* `tabletop-unit` "beauty rules" seeds a violation for every hard rule (including the edge exemption only on the
  edge axis, and scrolled items exempt from offscreen only).
* During development the checker was run against a build *without* the phone fixes and reported exactly the defects
  that had been seen in screenshots (desktop widgets off the right edge, top-bar controls off-screen, menu bar items
  colliding); after the fixes it reports none.

### What the checker found and what was fixed (all in this tier)

* Start "All apps" rows were 30.5 px and the Start / Launchpad search fields 24 px tall → ≥ 34–36 px.
* Phone (390 px): the Fusion shelf ran off-screen (low-priority pins now drop out, still in the launcher); the
  Business taskbar overflowed and its Task view button overlapped Quick settings (desktops/perf/Blackout hide, search
  becomes an icon, apps scroll); the Tabletop switcher overflowed both edges (now wraps); the dock-stack popover ran
  past the right edge (column count and width clamp to the screen); desktop widgets overflowed (now fit); the Fusion
  top bar pushed Main/Build/Blackout/Quick off-screen (labels collapse to icons, workspaces hide); the Art menu bar's
  Window/Help collided with its status buttons (Spaces, Mission Control, Help and the date hide).
* Measurement bugs fixed on the way: visually-hidden labels counted as clipped text; nested scrollers; items
  scrolled out of a scroller counted as overlapping what is next to it.

### Limits

It measures geometry, not taste — it is a regression net for layout quality, not a substitute for people judging
beauty. Colour contrast is covered by axe in `e2e-a11y` / `e2e-tabletop`, not re-implemented here. Module UIs other
than Settings are not walked view by view. The Toggle switch (40×22) relies on the 2.5.8 spacing exception or its
label wrapper.
