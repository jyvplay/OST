# TT55 — Files becomes a real file manager; WM-08; the modal-shortcut audit

Rows: FM-01 · FM-02 · FM-03 · FM-06 · FM-09 · FM-13 · FM-15 · FM-16 · FM-17 · SH-09 · DP-03 · WM-08 · SH-01 · SH-02 · SH-04
(built + tested), and
NC-06 · AP-02 · WM-16 · ST-09 · SH-13 · WM-05 · IN-08 (downgraded by audit). TT54 was finished first (run-all, a11y / ai
repairs; see DESIGN-TT54 §I).

## Runtime honesty
What actually ran: bash in a Linux sandbox (2 cores, 3 GB), Node 22 + `tsc` + ESLint, Next 16 production builds, an
embedded Postgres, headless Chromium 143 driven by Playwright, axe-core, Python 3 (`zipfile` as the archive oracle).
What did not run: Firefox, Safari, any desktop OS file manager, touch hardware, a real offline network (offline was
simulated with Playwright's `context.setOffline`, which really blocks requests from the page), parallel agents, theorem
provers. No claim below depends on something that did not run. "Ctrl-drag copies" is verified with a synthetic
`dragover`+`drop` event that carries `ctrlKey` — a native drag with Control held hangs Playwright's mouse API, so the real
OS gesture is **not** verified; plain native drag-and-drop is.

## A. Formal model
* Pane state `P = (cwd, H, Sel, view, sort, filter, deep)`; `H = (back[], cur, fwd[])`, `|back| ≤ 50`.
  `nav(H, t) = H` if `t = cur`, else `(back ++ [cur], t, [])`; `back(H) = (init back, last back, [cur] ++ fwd)`.
* `Sel = (paths, anchor, focus)` over the visible order `O`. Click → `{p}`; Ctrl → toggle `p`; Shift → `O[a..p]`
  (inclusive, anchor kept); Ctrl+Shift → `paths ∪ O[a..p]`; Ctrl+arrow moves focus only.
* Names: `copyName(n, taken)` = the smallest `k ≥ 1` such that `stem + " copy" + (k = 1 ? "" : " k") + ext ∉ taken`, where
  `stem` has any trailing ` copy[ k]` removed (copies of copies do not grow). `badName(n)` ⇔ `n ∈ {"", ".", ".."}` or it
  contains `/`, `\`, NUL.
* Menu: `items(ctx)` full set; `concise(ctx) ⊆ items(ctx)`; `search(q) = { i | ∀ w ∈ words(fold(q)): w ⊆ fold(label ‖ keywords) }`,
  `fold` = NFD, strip marks, lowercase.
* Server truth: every operation's effect is defined by `/api/fs` rows (`vfs_nodes`), never by what the UI shows.
  `size(dir) = Σ size(file ∈ subtree, not trashed)`; `find(root, q)` = names containing `q` literally (`%`, `_` escaped),
  excluding trash and dotfiles, `/System` only when `root ⊆ /System`, `≤ 200`.
* WM-08: `geom[module|host] ← normal rect` on close (the restore rect if maximized); open rect =
  `explicit ▷ remembered (+28 px per live sibling) ▷ registry default ▷ cascade`, then fitted to the viewport; `|geom| ≤ 64`.

## B. Hypotheses
* H+ (must hold): selection = reference model over 3 000 random gestures; history = browser model; names never collide;
  every copy is byte-identical on the server; deep find = recursive server walk; folder size = recursive walk; a queued
  offline write becomes exactly one server row after replay; Back/Forward mouse buttons never navigate the tab.
* H− (must fail): a slash name is accepted; paste overwrites; `%` matches everything; dotfiles or `/System` leak into a
  search; a stale folder size survives a write; an explicit rect is overridden by memory; the second window stacks exactly
  on the first.
* H∂ (boundary): ≥ 200 matches (notice shown, list capped); names with ` copy 9`; root has no parent; history at 50;
  maximized windows; a viewport smaller than the remembered rect; the menu at the window edge.

## C. Frontier
Covered: everything in A/B in real Chromium against the real server. Not covered: OS-level drag with modifiers (see
runtime honesty), cloud mounts (none exist — FM-09 says so instead of drawing cloud badges), more than 8 tabs (the New tab
button is disabled with a tooltip), file-system watching across browsers other than Chromium.

## D. Negative shapes (≥ 15) + modal shortcut
1 paste into the same folder → `copy` names, never overwrite · 2 second paste → `copy 2` · 3 copy of a copy → not `copy copy`
· 4 rename to `a/b` refused · 5 rename to `..` refused · 6 `%` / `_` literal in deep find (`x_y.txt` vs `xzy.txt`) ·
7 dotfiles never in results · 8 `/System` excluded unless searching inside it · 9 trashed files excluded · 10 folder size
after a write is recomputed (cache keyed by refresh tick) · 11 offline write → ghost row, not a fake server row ·
12 replay twice concurrently → applied once (in-flight guard; this was a real double-apply bug) · 13 mouse button 4 / 5 →
pane only, the browser tab URL unchanged · 14 drop a folder onto itself / its descendant → refused (code path, *not* e2e-tested) · 15 Esc after "More
actions" unmounted the focused button → still closes · 16 purge needs a typed confirmation (code path, *not* e2e-tested) · 17 WM-08 explicit rect wins ·
18 remembered rect larger than the viewport → fitted.
**Modal shortcut (the failure being tested):** a register row marked "built" whose behaviour exists only as a probe,
manifest entry or prose. Test: grep the product for the mechanism each row names (`beforeinstallprompt`, `launchQueue`
consumers, `requestPointerLock` callers, `screenschange`, an OSD layer, an uninstall flow, an MRU ring). Seven rows failed
and are downgraded in `features-tt55.ts` (NC-06, AP-02 → skeleton; WM-16, ST-09 → probe; SH-13, WM-05, IN-08 → partial).
WM-08 failed a stronger version of the same test: the reducer feature passed its unit tests but was **dead in the
product** because Shell.open always passed an explicit rect — found only because a mutant ("overrides an explicit rect")
survived the e2e. Fixed (`defaults` vs `rect`), now killed.

## E. Mechanism-distinct approaches (≥ 6)
1 pure reference models (selection / history / names / menu / sort / paths) re-implemented independently in the unit test
and compared over random sequences · 2 mutation testing (19 mutants, `scripts/tt55-mutants.py`, all killed) · 3 server
ground truth: every e2e assertion reads `/api/fs` or Postgres, not the DOM · 4 an external archive reader (Python
`zipfile`, CRC + bytes) for Compress · 5 real browser input (keyboard, mouse buttons 4/5, native drag, context menu) in
Chromium · 6 axe-core over the new chrome (tabs, toolbars, menu, tree) · 7 visual inspection of 7 screenshots
(`/tmp/tt55/*.png`) — it found two defects tests missed (§I).
Design alternatives considered and rejected: a floating selection bar (covered rows in narrow panes); a bar above the
rows (shifted rows under the cursor so a double-click opened the next file); server-side copy-with-overwrite flag (the
server deliberately never overwrites); browser-reserved Ctrl+T / Ctrl+W for tabs (cannot be captured — buttons and
middle-click instead).

## F. Artifacts
`src/lib/files/{model,clipboard}.ts`, `src/components/modules/{Files,FilesPane}.tsx`, `src/app/api/fs/route.ts`
(`op=find`; `paths[]` for compress / batch rename), `src/lib/api.ts` (replay guard), `src/lib/windowing/state.ts` (WM-08),
`scripts/tt55-files-unit.mts` (7), `scripts/tt55-mutants.py` (19), `scripts/e2e-tt55-files.mts` (13),
`scripts/e2e-tt55-shell.mts` (3: SH-01 registry = launcher = palette, SH-02 shelf = persisted windows, SH-04 icons follow the
file system across tabs), `src/components/Shell.tsx` (refresh broadcast), `src/components/Palette.tsx` (cap fix),
`src/db/seed-data/features-tt55.ts` (seed 3.41.0).

## G. Second-order adversary
"The tests agree with the code because both were written together." Counter: reference models are written from the
spec text, not from model.ts; e2e checks the server, not the UI; mutants prove the tests can fail; and the e2e found real
product bugs (dragstart setState cancelling native drag, the shifting selection bar, Esc after focus loss, the dead
WM-08) that the unit layer could not. "The axe pass is vacuous." It caught a real violation this turn (role=menu owning an
input), which forced the menu restructure.

## H. External verification
Python `zipfile` (archives), Postgres rows via the REST API (all file effects), axe-core (ARIA), Chromium's own
history (tab URL unchanged after mouse buttons 4/5). No external file-manager code was read; the behaviour follows common
desktop conventions (Explorer / Finder / Nautilus / Total Commander) described from the spec rows.

## I. Repairs, and a new attack on each patch
| Defect | Repair | Attack on the patch |
|---|---|---|
| Listing keys did nothing after clicking empty space | the listing div is focusable (`tabIndex=-1`) and owns the key handler | e2e: click empty area, then keys act; still exactly one `tabindex=0` row |
| Offline replay double-applied writes when `online` fired twice | in-flight guard in `replayQueue` | e2e: one server row after replay |
| WM-08 dead in the product | Shell passes registry size as `defaults`, `rect` only when explicit | mutant "overrides an explicit rect" now killed; unit precedence test |
| Synchronous setState in `dragstart` cancelled native drag | selection update deferred one task | native drag e2e (row → other pane, row → folder) |
| Selection bar above rows shifted them → double-click opened the wrong file | bar moved below the listing, in flow | e2e double-click opens the intended folder |
| Overlay selection bar covered rows in narrow panes | in-flow bar; one scrollable line (`.fs-selbar`) | dual-pane screenshot: ≥ 4 rows visible with a selection |
| Esc did not close the menu after "More actions" unmounted the focused button | document-level Esc / outside-press | FM-06 e2e |
| axe: role=menu owned the search input | outer wrapper holds search + status; inner role=menu only menuitems / separators | axe in the regressions test |
| Toasts showed "→" as tofu | words ("to", "into") | dual-pane screenshot |
| Breadcrumbs overlapped ("Home)ocument:") in narrow panes | crumbs don't shrink, only the last ellipsizes; > 4 levels collapse to Home › … › last three (… opens the path editor; hidden crumbs keep `data-crumb`) | SH-09 e2e clicks a crumb at depth 5; screenshot |
| SH-01 test: the palette's 40-row cap hid 3 of 43 apps in the "apps" scope (a real, pre-existing defect) | the cap applies to non-app rows only | the same e2e: palette rows = registry (43) |
| SH-04: a change made in another tab never reached this desktop (refresh was tab-local) | refresh bump broadcast on a BroadcastChannel (no payload) + re-read on visibilitychange | e2e: second tab drops the icon with no reload; the visibility path is exercised with a dispatched `visibilitychange` (synthetic) |
| e2e-a11y: PDF stage status text inherited light theme ink on the light stage; Slides rail option name ≠ its visible text (thumbnail text) | dark stage ink constant; rail thumbnail `aria-hidden` (name stays "Slide N") | e2e-a11y re-run |
| e2e-beauty at 1440×900: Tabletop floor cards #47+ only 24.6 px tall — caused by 36 files the TT51/TT52 e2e suites never cleaned up | both suites now purge their own `${RUN}-*` files; leftovers removed | e2e-beauty re-run. **Product limit recorded, not fixed:** with ≳ 46 files on the floor, the rear cards fall below the 32 px target at 1440×900 |
| Old suites clicked privacy actions now behind "More actions" | e2e-privacy / e2e-tt28 open the full menu first (feature unchanged) | both suites re-run |

## J. Stopping
Stopped when: unit 7/7, mutants 19/19, e2e-tt55-files 13/13 on the final build, screenshots re-inspected after the last UI
change, and the affected older suites re-run (results in docs/test-results). Not done this turn (next): e2e for WM-10, ST-05/07; an MRU switcher (WM-05); NC-06 OSD; further Writer / Sheet depth.

## Policies
Deep find caps at 200 (notice shown). Folder sizes are computed server-side, two at a time, cached per refresh tick. The
clipboard holds paths in sessionStorage (never file contents). Tabs ≤ 8 (button disabled at 8). Purge needs typed confirmation. WM-08 records on
close, explicit rect wins, ≤ 64 entries. Ctrl-drop copy verified only via a synthetic event.
