# TT80 — Fusion banners: one tidy top bar for every creative app, with Fusion's own menu names

## A. Formal model

**Admissible objects.** A *banner* is the top region of an app window: a menu row (top-level menus, one word each)
plus ONE tool strip (the controls, grouped by the same words). A *menu* is a list of the controls of one group, read
from the live DOM when it opens. A *group* is a named cluster of controls (`<BannerGroup name="Keep">`), marked on
the strip; groups may also live outside the banner (Vector's tool palette, the Image Editor's edit panel) and are
found by `data-banner-group`.

**Information / access model.** The menu is not a second implementation of the commands: it is a *view* of the strip's
controls. When a menu opens, `mirrorGroups()` walks that group's DOM and builds one item per control, with the label a
screen reader would use (visible text when it is a word, else `aria-label`, else `title`), its pressed/checked state,
and an `onSelect` that clicks the control it mirrors. So a command cannot behave differently from its toolbar button,
and a control scrolled out of a narrow strip is still one click away. The shell menu bar (Art layout) reads the same
groups through `bannerStore`, so the focused window's menus appear beside the shell's own.

**Resource counted.** (1) Rows above the document: the banner's own two rows are allowed, anything else that *wrapped*
is not (a header row that does not wrap is fine — measured as `scrollHeight > clientHeight + 2`). (2) Menu completeness:
every item must be a control of that group. (3) Menu honesty: clicking an item must change the control it mirrors.
(4) Menu size: ≤ `MENU_ITEM_CAP` (40) items, else the group is served compact (list options not expanded) and the menu
scrolls.

**Success / failure (quantifier order).** For every app: ∃ exactly one banner ∧ ∀ menus: (opens ∧ lists ≥1 item ∧ every
item ∈ that group's controls ∧ items ≤ cap) ∧ ∃ a toggle whose state changes when its menu item is clicked ∧ the strip
does not wrap ∧ (Art layout) the shell menu bar lists the window's menus + Frame + Guide. Failure is any conjunct false.

**Parameter regime, units, tolerances.** 1440×900 viewport, 100 % text scale (the 125 % default and the 200 % toggle are
covered by the layout/a11y suites, not here); tolerances: strip wrap ≤ 2 px, no wrapped row above the document, menu
item cap 40, ≥ 4 commands across an app's menus.

**Adjacent but different problems (not substituted).** A menu that lists controls from *other* groups; a menu that is a
hand-written copy of the toolbar (drifts from the buttons); a menu that opens a dialog instead of acting; a toolbar that
scrolls but whose controls are unreachable from the menus; a "banner" that is only a status line.

## B. Outcome space

- **H+** (taken): one banner per app, Fusion's own menu names, menus that mirror the strip, verified by an executable
  audit (11/11) plus the e2e suites that drive the same controls.
- **H−** (rejected): "one shared toolbar for every app" — the commands differ per app, so a single strip cannot be honest.
  Also rejected: naming the menus after an existing system (the user's explicit constraint) and keeping the old multi-row
  wrapped toolbars (the mess being fixed).
- **H∂** (taken, with conditions): the shell menu bar shows a window's menus only when a window is focused and only in
  the Art layout (Business has a taskbar instead); a group may be declared `extra` when its controls live outside the
  banner (Vector's palette, the Image Editor's edit panel); the quick-edit mode's edit controls appear only once an image
  is loaded, so its Look menu is empty until then (the audit seeds a file for that case).

## C. Frontier (imported results, with their hypotheses)

- WAI-ARIA APG "menu button": Enter/Space/ArrowDown open and focus the first item, arrows move, Escape closes and returns
  focus, Tab closes, click-outside closes. **Hypotheses used:** the menu must own focus while open; Escape must work even
  when focus is still on the trigger (the APG text implies it, our first implementation did not — see §I).
- macOS dock folding (`planDock`): whole groups fold into stacks when the dock would exceed `DOCK_FILL` of the width,
  biggest saving first, pinned/running apps stay out. **Hypothesis used:** folding is a *width* decision, so adding an app
  to a group can change which groups fold (TT79 added one to Core: 10 → 11 apps, so Core now folds at 1440×900).
- **Open interface:** the app's own menu vocabulary (`banner-core.ts`) is Fusion-specific and has no external oracle; its
  only external check is the negative one — no name may equal a top-level menu name of macOS, Windows, Office, Google,
  LibreOffice, Acrobat, Photoshop, Figma or a browser (84 names checked, executable in the audit).

## D. Negative space — shapes that look like solutions but are not

1. A menu that duplicates the toolbar by hand (drifts; the audit's "item not in its group" check catches it).
2. A menu that lists every control of the *window* instead of its group (hides which commands belong where).
3. A menu item that opens a dialog rather than acting on the control (the probe's state-change check catches it).
4. A menu built from `title` attributes (long tooltips as labels — caught by the naming rule).
5. A menu that lists a control's *options* only (loses the control itself).
6. A menu that is populated once at mount (stale after the document changes — the mirror is lazy).
7. A toolbar that wraps to two rows and calls it a banner (the "wrapped row above the document" check catches it).
8. A strip that scrolls but hides controls behind a mask without a way to reach them (the audit clicks items by label).
9. A banner that only shows in one layout (the audit switches to Art to check the shell menu bar).
10. An "Open…" button that exists only in the empty state (the Editor now shows its banner in every state).
11. Menu names copied from an existing system (the FOREIGN list check).
12. A menu that lists a control twice because the group appears twice (the mirror concatenates; duplicates are legal but
    the probe picks one).
13. A group declared `extra` but never marked in the DOM (empty menu — caught by "menu is empty").
14. A strip whose controls are outside the window (the mirror reads within the window, so a stray banner in another window
    cannot leak in — the earlier audit bug of reading `document.querySelector` first is exactly this shape).
15. **Modal shortcut:** "open the menu and press the first item's shortcut" — the shortcut acts on the *focused* control,
    which after opening a menu is the menu itself, so the shortcut would act on the menu, not the document. The audit
    therefore clicks the mirrored item (a real click), which is the only honest way to prove the mirror acts.

## E. Mechanism portfolio (six distinct approaches, with what each proved)

| # | Construction | Concrete artifact | Proved | Unresolved | Cheapest falsification |
|---|---|---|---|---|---|
| 1 | DOM mirror (menu = view of the strip) | `mirrorGroups` + `MenuButton` items as a lazy function | every item is a control of its group; clicking it acts | controls that are not buttons/selects/inputs (canvas tools) are out of scope | audit's "item not in its group" |
| 2 | Own vocabulary + negative check | `banner-core.ts` (11 names, 84 foreign names) | no name equals an existing system's top-level menu | "similar to" is not formally defined | the FOREIGN list assertion |
| 3 | One-line strip with scroll + edge controls | `.fs-banner-strip` + ‹ › + mask fade | the strip never wraps; a wheel over it scrolls sideways | touch-drag scrolling is not covered | `scrollHeight − clientHeight ≤ 2` |
| 4 | Groups outside the banner | `data-banner-group` + `extra` | Vector's palette and the Image Editor's edit panel are reachable from the same menus | a group could be marked twice with different names | the Kit/Look menus in the audit |
| 5 | Two-tier menu size | `MENU_ITEM_CAP` + compact fallback | the Writer's 43-item Look menu becomes compact and still lists every control | the cap itself is a taste, not a spec | `items.length ≤ MENU_ITEM_CAP` |
| 6 | Shell integration via a store | `bannerStore` + `useBannerMenus` + `menuItemsForWindow` | the Art menu bar lists the focused window's menus beside Frame/Guide | what happens with two windows of the same app (both publish; the focused one is shown) | the audit's shell-menu check |

Gaps are **local** (each is a bounded UX choice), not equivalent to the original problem: the original problem — a messy,
wrapped, multi-row set of toolbars with borrowed menu names — is solved and verified.

## F. Artifacts

- `src/components/AppBanner.tsx` (banner, groups, mirror, store), `src/lib/banner-core.ts` (vocabulary, cap, foreign list).
- `src/components/chrome-bits.tsx` (MenuButton: lazy items, section headings, scroll cap, Escape from anywhere).
- `src/components/MenuBar.tsx` (Frame / Guide + the focused window's menus).
- `src/app/globals.css` (TT80 banner block).
- `scripts/tt80-banner.mts` — the audit (11 cases), in `run-all.sh`.
- `docs/screens/tt80-*.png` — one banner crop per app (17 files, 504 KB) for visual inspection.
- 11 app modules converted: Writer, Slides, Spreadsheet, PDF, Vector, Whiteboard, Tables, Editor, Photos, Image Editor
  (layers), Image Editor (quick edit).

## G. Second-order adversary

Attacks derived from the mirror's structure, all of which the audit now exercises:
- **Stale DOM:** a menu opened before a document loads (Editor's "No document" state) — the audit opens the menu after the
  state settles and requires ≥ 1 item.
- **Hidden controls:** `hidden` file inputs and `[data-banner-skip]` are skipped, so a menu cannot promise a picker the UI
  does not offer.
- **Duplicate names:** Writer and Slides declare `Keep` twice (essentials early, the rest late) — the mirror concatenates
  both occurrences in strip order.
- **Quantifier order:** "every menu lists its controls" is checked per menu, and "the strip never wraps" per app, so a
  pass on one cannot mask a failure on another.
- **Imported-theorem alignment:** the APG Escape rule is implemented as a window-level handler (not only on the menu), and
  the dock's fold order is re-derived from the registry rather than hard-coded in the test.
- **Global compatibility:** the banner is a grid/flex child; for the four modules whose root is a CSS grid the banner needs
  `span="1 / N"` (found by the e2e-image clipping test failing on a zero-width panel — see §I).

## H. Verification

- TypeScript: `npx tsc --noEmit` clean; `next build` exit 0 (build93).
- The audit itself: 11/11 (real Chromium, production build, Art layout for the shell check).
- Regression suites re-run against build93: e2e-image 11/11, e2e-layout 12/12, e2e-a11y 9/9, e2e-tables 8/8,
  e2e-vector 12/12, e2e-whiteboard 7/7, e2e-tt51-slides 6/6, e2e-tt52-pdf 8/8, e2e-tt50-charts 5/5, e2e-tt79-pdf 5/5,
  e2e-tt79-archive 7/7, e2e-tt77-pdfsig 7/7, e2e-tt78-sheet 3/3, e2e-tt55-files 13/13, e2e-tt55-shell 3/3, e2e-tt29 4/4,
  e2e-beauty 6/6.
- **Not verified:** human visual inspection. This sandbox has no image input for the agent, so the "visual check" is
  DOM measurement (wrapping, heights, spans, off-screen reachability) plus the captured `docs/screens/tt80-*.png` crops for
  the user to look at. Claims about appearance are therefore limited to what the audit measured.

## I. Repair (each item was a real failure the audit or a suite found)

1. Escape did not close a menu when focus was still on the trigger → window-level handler.
2. A button's long `title` was used as its menu label → the naming rule prefers visible text.
3. The Writer's Look menu listed 43 items → two-tier compaction (cap 40).
4. The audit read the first banner in the document, which could be another app's → every DOM read is scoped to the app's
   own window/banner.
5. The Image Editor's "No document" state had no banner → the banner is now rendered in every state (with an
   "Open in Files…" command).
6. A menu item click could swap the whole module under the user (the mode tablist was a Glance group) → the tablist is a
   header again; the quick-edit mode got its own banner.
7. `aria-pressed` on `role="tab"` (axe: aria-allowed-attr) and `aria-label` that differed from the visible text
   (axe: label-content-name-mismatch) → removed.
8. Three grid-rooted modules put the banner in the first column only, which shifted the canvas and crushed the layers
   panel to a 30.5 px grid → `span` prop on the banner.
9. The dock's fold order changed when TT79 added an app to Core → the test now asserts the documented invariants
   (fits, folds whole groups, pinned apps stay out) instead of a hard-coded group list.
10. The shell's "Window" menu is now "Frame" (and "Help" is "Guide") → the affected locators updated.

**New attack on the patch:** the audit's `extra`/`data-banner-group` path (a group outside the banner) and the
quick-edit mode's `Look` menu were added *after* the first green run and are covered by the `imagequick` case; the
`span` regression was found by e2e-image, not by the audit, which is why the audit now also asserts that no wrapped row
sits above the document in a grid-rooted module.

## J. Stopping

The success predicate holds for all 11 audited apps and the affected e2e suites pass on the current build. Remaining
gaps, stated plainly: the menu vocabulary is Fusion-specific with no external oracle (only the negative check); canvas
and pointer tools are not mirrorable and are reachable only from the strip; the 125 %/200 % text scales are covered by the
layout and a11y suites rather than by this audit; and no human has looked at the captured screenshots yet.

**Register / ledger:** the audit covers `DP-10` (design/spec) at full; `tt80-banner` is in `run-all.sh`.
