# TT98 — Orbit actions and rectangular selection

## Runtime honesty and carry-over

This is an engineering implementation, not a claim to solve a mathematical open problem. Tools actually used: local git, GitHub CLI, npm/Node, TypeScript, ESLint, Next.js production compiler, PostgreSQL 18.4 from an external test-tools npm installation, Chromium 143 through Playwright, Python's standard-library test environment, web search, file inspection and real screenshots. No independent agent, simulator, theorem prover, physical device, assistive-technology user or non-Chromium engine participated. Test cases are deterministic browser interactions, not simulated native OS capabilities.

TT97's corrected empty-folder test is included in the new production gates. Its broader Share/WebRTC and terminal-editor uncertainties have not been repaired by this change. This turn does not reclassify old failed aggregates as passes. The 79-suite TT97 gate and the full repository inventory were not run.

**No canonical feature is newly promoted to Class A.** More than ten concrete interactions were implemented or strengthened, but component-level browser tests do not certify ten entire specification rows. Existing feature grades are unchanged. In particular, this does not deliver an unrestricted native OS inside a browser, arbitrary native-app menus, or a completed custom menu for every semantic object in every module.

## A. Formal contract

Admissible objects: visible classic-desktop VFS icons (the existing maximum is 30), Files rows in the current pane, existing window-manager actions and the tab-local VFS path clipboard. No external clipboard is read. Context action values are strings rendered by React; no labels or file names are evaluated as code.

Access: browser DOM geometry and pointer/key events; existing same-origin `/api/fs` operations only after explicit action selection; existing shell state reducer for window operations. Listing/stat requests for copy/paste remain same-origin. Selection itself makes no network write. Existing privacy routing, encrypted-volume handling, server conflict checks and sidecar-aware trash are reused rather than bypassed.

Resource: n item rectangles per pointer-move, O(n) hit testing and O(n) path membership storage, plus React updates. No performance or frame-budget bound was measured. No new runtime dependency was added. Copy/trash batches use sequential operations; each server operation retains its existing atomicity, but the whole batch is not atomic.

Success predicate, with explicit order: for each supported primary non-touch blank-space gesture, for each delivered move while that pointer owns the gesture, selection equals the set of rendered item rectangles having positive-area intersection with the rectangle clipped to that pane's bounding box; union with the gesture-start selection when Ctrl, Command or Shift was held at pointer-down. Reversing drag direction must not change this rule. On normal release, selection persists and the release click must not clear or open items. On Escape or pointer cancellation, the start selection is restored. Existing row drags, icon rearrangement, text editing and touch scrolling retain their prior owners.

For each right-click on a supported window background, if no inner handler prevented default and the target is not an editing control, link, native media, canvas or menu, show only real window operations. A file's existing menu must win over this fallback. Selecting an action must invoke the existing reducer/API, not send a synthetic shortcut or show an unsupported success message.

Units/boundaries: viewport CSS pixels; gesture threshold 4 px, implemented as movement less than 4 px being ignored. Rectangle boundary contact alone is not a hit. Touch-origin marquee is deliberately excluded. Modifiers are sampled at gesture start. Geometry is recomputed per delivered pointer move. Only rendered items participate. Native browser text/media/link menus remain native.

Adjacent problems not substituted: OS-wide context menus; clipboard contents beyond VFS paths; arbitrary app-object editing actions; native process/system settings control; filesystem access outside the existing VFS; 3D projected lasso geometry; automatic edge scrolling; mobile long-press selection; multi-icon group repositioning; arbitrary file counts/performance guarantees; undo of a multi-operation batch; semantic equivalence to every Windows/macOS release.

## B. Outcome space and acceptance threshold

- **H+**: first-party DOM selection, VFS actions, accessible shared menus and real window-manager actions are feasible. Accept only after production compilation and recorded browser/server assertions for the claimed interaction.
- **H−**: an unrestricted native OS right-click layer cannot be supplied by these DOM handlers. No browser permission or API granting arbitrary native-app interception is implemented. This is a scope/platform boundary, not a proof that every possible OS-like PWA design is impossible.
- **H∂**: behavior changes at native editing/iframe/touch/3D boundaries; existing specialized handlers take precedence; batches may stop after partial completion. Viewport, scroll, timing and browser-engine coverage remain bounded by the tests.

## C. Research and implementation alignment

Actual search results consulted, not imported application source:

- Microsoft describes the streamlined Windows 11 file context menu and the separate “Show more options” route: https://internal.support.services.microsoft.com/en-us/windows/finding-items-in-the-file-explorer-context-menu-2c458eb5-d27a-4b69-9301-60df221caaa0
- Apple describes secondary-click shortcut menus for the desktop, icons and files: https://support.apple.com/en-gb/guide/mac-help/mh35853/mac
- Apple documents selection → contextual Copy and destination → Paste: https://support.apple.com/en-mide/guide/mac-help/mchl5252f3de/27/mac/27
- Apple documents multi-item contextual Rename and contextual Compress; those are already part of Files, and are not reimplemented as decorative placeholders: https://support.apple.com/guide/mac-help/rename-files-folders-and-disks-on-mac-mchlp1144/mac and https://support.apple.com/guide/mac-help/zip-and-unzip-files-and-folders-on-mac-mchlp2528/mac
- Drag-box and modifier selection references: https://www.computerhope.com/issues/ch000771.htm and https://www.idownloadblog.com/2018/03/02/how-to-select-files-mac-finder/

These are UX references, not correctness theorems or an exhaustive per-OS survey. Their platform-specific conditions do not imply those APIs exist in a PWA. “Orbit actions” names the new shared surface; familiar verbs are retained for usability. No external implementation was copied, renamed or bundled. Existing Files concise/full/search actions, Dock/Taskbar app menus and Tabletop object menus are retained.

## D. Negative space: 20 non-solutions

1. Suppress every browser contextmenu without offering a working replacement.
2. Put the same menu on every target, overriding Files' real actions.
3. Hijack text editing, links, media or canvas tools.
4. Draw a selection rectangle without changing selected paths.
5. Select by label text instead of canonical VFS path.
6. Keep all previously intersected items when shrinking the box.
7. Only support lower-right drags.
8. Lose the selection on the release click.
9. Let item drags become background lasso gestures.
10. Turn touch scrolling into lasso.
11. Ignore clipping and select items below the scroll viewport.
12. Move or delete a single item while claiming to operate on the selected batch.
13. Copy file contents to an external clipboard just to implement path Copy.
14. Overwrite an existing destination during Rename, Duplicate or Paste.
15. Truncate an existing file with the desktop's New file command.
16. Clear the entire cut clipboard after one item failed to move.
17. Report whole-batch atomicity for sequential server requests.
18. Put a menu offscreen or let large text make its controls unreachable.
19. Return focus to an unmounted menu item.
20. Call ten component tests ten fully certified spec features.

Modal shortcut: a universal top-level contextmenu preventDefault with cosmetic commands. It fails both target-specific semantics and actual action execution. Detection: `e2e-tt98-orbit` requires existing file menus to take precedence, native input context not to open Orbit, real reducer geometry after Tile left, actual filesystem content after Rename/Duplicate/Paste, and retained sentinel contents on collision.

## E–G. Mechanism portfolio and structure-specific attacks

These mechanisms were developed in one agent session, not by independent workers; no independent parallel research is claimed.

| Mechanism / central construction | Concrete artifact and tested portion | Attacker / cheapest falsification | Exact remaining interface; gap type |
|---|---|---|---|
| Geometry hit testing, clipped to the pane | `useMarquee.tsx`; list and desktop rectangles select real paths | Reverse direction, shrink to empty, release click, offscreen nodes | No edge autoscroll, 3D projection or performance benchmark; local extensions |
| Gesture-start snapshot and additive set union | Same hook; Ctrl-add, replacement, Escape restoration | Change modifiers halfway; second pointer; cancel after partial selection | Physical touch/pen and lost-capture usability not device-tested; local |
| Bubble-only capability fallback | `WindowFrame.tsx`; existing file menu and native input are preserved | Inner handler prevents default; nested menu event; native editable target | Domain-specific menus for every app object are not supplied; large remaining product scope |
| Focus/navigation and bounded portal menu | `OrbitMenu.tsx`; Arrow/Home/End/Escape, outside dismissal, viewport placement | Close after focused child unmount; resize or oversized text | AT-user evaluation and other engines absent; external validation gap |
| Session VFS clipboard, not system clipboard interception | Desktop Copy/Cut and existing `files/clipboard.ts`; copy → paste verified against server contents | Stale source, destination collision, cut batch fails halfway | Cut retry keeps remaining paths; multi-tab/cross-device clipboard is not claimed; local |
| Existing transactional transfer primitives | Desktop Rename/Duplicate; API-backed content assertions | Rename onto sentinel file; concurrent destination creation | Server refuses overwrite; whole-batch rollback not implemented; local |
| Confirmation and reversible trash | Desktop selected trash uses existing sidecar-aware API; cancel, confirm and Trash listing tested | Cancel after dialog; source removed concurrently; partial batch | Multi-operation rollback and secure erasure are not provided; different problem |
| Conditional creation instead of unconditional write | Desktop New file uses `writeIfUnchanged(expected: null)` | Select existing name and check sentinel bytes | Conflict must be handled, not silently retried; tested on host VFS, other persistence modes not separately covered |

## F. Concrete delivery inventory

1. Classic-desktop rectangular selection with visible selected state.
2. Files rectangular selection through the existing selected-path/toolbar model.
3. Ctrl/Command/Shift additive rectangle semantics.
4. Normal replacement and empty-box clearing.
5. Escape/cancel restoration and release-click suppression.
6. Desktop item Open, containing-folder access, Copy, Cut and Copy paths.
7. Desktop Rename with server refusal of collisions.
8. Desktop Duplicate using conflict-free names.
9. Desktop confirmed, recoverable multi-item Trash.
10. Desktop background New folder, backed by a real VFS directory.
11. Desktop background Paste with conflict-safe copy/move requests.
12. Desktop Select all/Clear controls and keyboard Ctrl/Command+A and Escape on the desktop.
13. New text file collision protection (fixes the prior unconditional write).
14. Common Orbit window controls, tiling and workspace-send actions across ordinary first-party windows.
15. Shared menu keyboard navigation, dismissal, focus return, resize handling and error-to-toast handling.

This inventory is not a canonical Class A promotion list. The existing desktop icon cap and existing app-specific capabilities are not inflated.

## H–I. Verification, failures, repairs and re-gates

Artifacts and runnable commands are under `docs/evidence/tt98-*` and `scripts/e2e-tt98-orbit.mts`. New destructive browser tests refuse to run without `TT89_DISPOSABLE_DATABASE=1`, explicit `DATABASE_URL` and `BASE`. As with the existing test harness, operators must ensure the server actually matches that disposable URL.

Observed development sequence:

- Initial Orbit test: **10/14**, preserved in `tt98-orbit-initial-10of14.json`. Three selection assertions started on the window's resize handle rather than the 6 px listing gutter. Corrected the event target, not the expected selection count. The focus assertion exposed an unhelpful return to the body; the window now receives focus before opening the fallback.
- The newly added stale-selection filter initially referenced `items` before its hook declaration, causing a real ReferenceError on selecting an icon. Moved initialization ahead of the derived filter and reran the complete Orbit suite. This repair inherits no credit from the earlier pass.
- Expanded operation test: **20/21**, preserved in `tt98-orbit-20of21.json`. Collision was correctly refused, but the test expected “already exists” instead of the actual “exists” wording; broadened only that message matcher. Both source and sentinel content are independently read from the server.
- Final development Orbit run: **22/22**, including a new Escape-during-drag attack (`tt98-orbit-dev.log`).
- TypeScript passed and the optimized Next.js production build passed. Targeted lint passed. Full repository lint failed: **179 errors, 18 warnings**, preserved verbatim; these are outside the changed implementation and include existing Writer/input ref rules and missing ESLint rule definitions. This turn does not certify repository lint clean.
- First production gate used inadvertently inherited SQL_ASCII databases and lacked the test-only Python executable. Integration **22/25**, old Files **12/13**. Repeating integration against a new UTF-8 database passes **25/25**. Python's standard library environment was then provisioned for zipfile/Decimal oracles. No user database was touched.
- The old desktop-menu negative control was **4/5**: the ResizeObserver could repair its single inline mutation when the longer menu reflowed. Strengthened the test to keep an offscreen fault active with a temporary !important stylesheet, then remove it before testing recovery. The previous failure is preserved in `tt98-desktop-negative-control-first.json`. This changes the test, not the product placement logic.

Final production gate results are appended below after completion. Passing selected reruns never retroactively convert the first aggregate to a pass.

## J. Remaining gap and next highest-information tests

Not certified: every app-specific semantic action, 3D Tabletop marquee, lasso edge-autoscroll, group icon movement, pen/touch hardware, Firefox/Safari, installed PWA associations, true native OS integration, arbitrary file-count performance, full-batch undo/rollback, external HTTPS-proxy end-to-end browser access, or ten entire Class A rows. Preview was exercised locally through the real production HTTP server; platform preview warnings were absent, but an external user's browser was not controlled here.

Next tests: hold a drag at scroll edges in a very large folder; pointer-capture cancellation and scrolling on physical touch/pen devices; real screen-reader keyboard use; separate-browser clipboard error paths (stale source and partial cut); domain-object action inventories for each module before adding semantic commands. Also retain TT97's clean sequential broad Share/Terminal tests as unresolved carry-over rather than claiming they were completed by this UI work.

### Further gate findings and test repairs

The first completed UTF-8 gate was **14/16 suites, 157/159 cases, exit 1** (`tt98-production-utf8-firstgate.log`). All 22 Orbit scenarios and the existing Files/desktop-menu regressions passed. Two other tests failed:

- Privacy's assertion searched **every** host path for the substrings `renamed` or `inner`, so the new deliberately public rename fixtures were misclassified as encrypted-private-name leaks. The test now scopes to `/Private/`, checks exact plaintext path segments/names, and independently requires the expected encrypted destination row and encrypted bytes to exist. A read-only SQL negative control requires the scoped predicate to detect `/Private/attack/inner.md` and allow `/Documents/inner.md`. The prior failing privacy result is preserved in `tt98-privacy-first-utf8.json`.
- A palette routine case observed focus mode before its asynchronous execution-record POST had committed. The old wait used `optionalProperty !== null`, which can incorrectly accept `undefined`. The test now binds to the selected routine's real POST response, requires success, and waits for a string timestamp before directly querying PostgreSQL. No palette implementation was changed. Before that strengthening, a selected rerun already passed **11/11**, so the original intermittency remains recorded rather than described as a deterministic product defect (`tt98-palette-first-utf8.json`).

Selected palette/privacy rerun: **11/11 + 13/13**, exit 0 (`tt98-palette-privacy-rerun.log`). The complete scoped gate is rerun after the test repairs rather than being inferred from those selected passes.

The SQL_ASCII server logged PostgreSQL error **22021**, `invalid byte sequence for encoding "UTF8": 0xe2 0x86`, while selecting truncated search snippets. The fresh UTF-8 database eliminates that witnessed setup fault; existing data was not converted in place. The separate production accessibility suite passed **9/9** in the first gate (`tt98-production-gate.log`). Full lint remains failed; no assertion of universal accessibility or lint cleanliness follows.

Production preview: `0.0.0.0:3000`, database `tt98_preview_utf8`, separate from all regression data. `tt98-preview-smoke.log` records HTTP 200 for the page, manifest/settings/features, a real Files listing, an Orbit menu with window operations, Escape dismissal, and zero uncaught page exceptions. `docs/screenshots/tt98-orbit-preview.png` was actually captured and visually inspected. The preview shows the real Files app, not a static screenshot or mock shell.

### Final repaired build: accepted scoped gate

The first repaired-test gate passed **16/16 suites, 159/159 cases, exit 0** (`tt98-production-before-focus-gate.log`). A final review then identified that pointer-down `preventDefault()` suppresses the compatibility mousedown used to activate a Files pane. A new assertion against that built version failed **0/1** (`tt98-focus-baseline.log`): the blank-space drag did not focus its own listing. The hook now explicitly focuses its owning surface with `preventScroll`, allowing the existing Files focus-capture handler to activate the correct pane. The same new assertion is retained in the full Orbit suite.

After that application repair: TypeScript and targeted lint passed again, the optimized production build was rebuilt successfully, both production servers were restarted, and the **entire same 16-suite gate passed again: 159/159 cases, zero failures, exit 0** (`tt98-production-finalgate.log`). This is the final application build; the earlier pass was not inherited. The scoped gate contains unit 23, integration 25, Files model 7, Files UI 13, Files shell 3, desktop placement/negative control 5, empty Files accessibility 3, Orbit 22, Programmer 8, calculator history 6, scientific units/Decimal 6, palette grammar 4, SVG attributes 3, calculator repairs 7, palette actions 11, privacy layer 13.

The 9/9 full accessibility suite belongs to the earlier application build; it was **not** repeated after the final focus-only patch. The new-build Files UI suite still includes its axe checks. No claim is made that all repository tests or all accessibility dimensions passed on the final build.

The repeated preview smoke initially targeted the first of two persisted Files windows and was blocked by the newer foreground window (`tt98-preview-smoke-repeated-first.log`). The smoke now targets the newest Files window; the dedicated preview's window state was reset (not user data), and the final production smoke passed again. The final preview is running with one real Files window on port 3000, against its own UTF-8 database. Only regression servers are stopped at completion.

**Stopping outcome:** deliver the tested implementation and scoped evidence, not an unsupported all-Class-A declaration. The next highest-information work remains scrolling/3D/device behavior and a per-module semantic context-action inventory, plus TT97's explicitly unresolved broad Share/Terminal tests.
