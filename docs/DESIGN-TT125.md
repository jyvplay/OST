# TT125 — twenty more Class A features, tier-5 ultrareview

Same protocol as TT117–TT124: every claim below is backed by a checked-in suite that
ran green on this build (see Key evidence). Nothing is asserted from code reading.

## The twenty (register codes, final)

| Code | Module | Feature | Engine | Evidence |
|---|---|---|---|---|
| ED-09 | Editor | case of selection (AA / aa / Aa) | `src/lib/case-text.ts` | tt125-core, e2e-tt125 |
| ED-10 | Editor | insert local date+time at caret ("now") | `src/lib/stamp-text.ts` | tt125-core, e2e-tt125 |
| PD-03 | Pdf | copy current page's text layer | app engine `lib/pdf/pdftext.ts` | e2e-tt125 placement, tt125-density |
| WR-02 | Writer | reading time in Word Count (238 wpm) | `src/lib/read-time.ts` | tt125-core, e2e-tt125 |
| BM-03 | Beam | filter sessions by transport/target/state | `src/lib/session-filter.ts` | tt125-core, e2e-tt125 |
| DV-03 | Devices | honest storage estimate line | `src/lib/storage-estimate.ts` | tt125-core, e2e-tt125 |
| VA-03 | Vault | password-reuse audit (digests only) | `src/lib/pwd-audit.ts` | tt125-core, e2e-tt125 |
| PL-10 | Planner | copy done list (agenda view) | `src/lib/done-list.ts` | tt125-core, e2e-tt125 |
| TM-08 | Terminal | `alias name=cmd` built-in, one-pass expand | `src/lib/alias-map.ts` | tt125-core |
| SSH-04 | Ssh | three copy-snippet buttons | `src/lib/participants-text.ts`* | e2e-tt125 placement |
| RC-43 | Recall | copy source list, newest first | `src/lib/recall-text.ts` | tt125-core, e2e-tt125 |
| PK-04 | Peek | copy ASCII strings from a binary | `src/lib/peek-strings.ts` | tt125-core, e2e-tt125 |
| WB-08 | Whiteboard | export selection only (disabled until a selection exists) | app engine | e2e-tt125 |
| LN-19 | Lens | zoom picker thinned to ≤12 honest options | `src/lib/zoom-pick.ts` | tt125-core, e2e-tt125 |
| LN-20 | Lens | torch toggle, disabled + labelled when hardware says no | `src/lib/zoom-pick.ts` | tt125-core, e2e-tt125 |
| AP-08 | Apps | session recents chips (sessionStorage, cap 8) | `src/lib/recents.ts` | tt125-core, e2e-tt125 |
| CB-03 | Clipboard | merge shown clips (disabled below two) | `src/lib/merge-clips.ts` | tt125-core, e2e-tt125 |
| TG-03 | Together | copy participant roster, hosts first | `src/lib/participants-text.ts` | tt125-core, e2e-tt125 |
| ST-16 | Settings | copy shortcut list (Shortcuts tab) | `src/lib/shortcuts-text.ts` | tt125-core, e2e-tt125 |
| BK-13 | Books | copy reading position | `src/lib/position-text.ts` | tt125-core, e2e-tt125 |

\* SSH-04 snippets reuse the participants/shortcuts text engines' style; the buttons
themselves are UI-only and covered by the placement test.

## Formal model

- **H+ (feature present ⇒ observable effect):** e2e-tt125 drives real Chromium against
  the production server: case buttons rewrite only the selected span of a real VFS
  file; `now` inserts `YYYY-MM-DD HH:MM` at the caret keeping every later byte;
  Files-style mkdir naming is exercised through Peek's binary write + Copy strings
  toast; agenda view's Copy done renders after a real task is PATCHed done.
- **H− (absence ⇒ honest refusal):** headless Chromium reports no torch → LN-20 button
  disabled with a saying-so title; no selection → WB-08 disabled; one clip → CB-03
  disabled; alias expansion is one-pass (no recursion bomb) and unknown aliases stay
  literal (unit-tested).
- **H∂ (bounds):** tt125-density measures words/glyphs/controls of all twenty touched
  modules against first-turn caps (all actuals ≤ cap, e.g. editor 22/70, apps 893/980,
  settings 1517/1650) and asserts the register grew past TT124's 587 with all twenty
  codes `built`.

## Frontier & negative space (≥15 rejected shapes, with reasons)

1. FM-20 duplicate "New folder" toolbar button — FilesPane already had a
   collision-free New folder flow; caught by the screenshot review, button removed,
   code retired (see adversary note), slot reassigned to ED-10.
2. CP-03 Capture burst — getDisplayMedia needs a fresh gesture per shot; claiming a
   burst would be pretend. Dropped, replaced by BK-13.
3. Find "copy results" — already exists.
4. Browser page-text — cross-origin, honestly impossible.
5. Music/Video playback-rate — already exists.
6–8. RC-03, WB-05, AP-02 (and WB-06/07, AP-03…07) — register collisions found by
   probing the live `/api/features` before seeding; reassigned to RC-43/WB-08/AP-08.
9. Whiteboard export auto-renaming — VFS writes are versioned, overwrite is not loss.
10. Files copy-path / duplicate / zip download / tags — all already exist.
11. Editor sort-lines — already exists.
12. Lens torch forced on in headless — would lie about hardware.
13. Peek strings on text files — meaningless; gated to binary mimes.
14. Recents persisted to server — session-scoped by design (privacy), sessionStorage.
15. Vault audit storing plaintext passwords — digest-only comparison.
16. Writer reading-time in the main pane — moved into Word Count dialog to keep the
   writing surface wordless.

## Second-order adversary (what caught me this turn)

- The absence sweep grepped `Files.tsx`; the pane UI lives in `FilesPane.tsx`, so the
  duplicate New-folder button shipped into the first build. The density **screenshot**
  (visual check) exposed it. Response: removed the duplicate, deleted the now-unused
  engine, retired the code in the register, and added `RETIRED_FEATURE_CODES` +
  a delete-on-boot prune to `src/db/seed.ts` so a withdrawn code can never linger.
- The a11y gate caught three raw-px inline font sizes in my new UI (Apps/Devices/Vault);
  all now go through `fz()`; a11y-unit is 8/8 again.
- e2e iterations caught real product bugs the unit tests could not: the Files list
  parse read `rows` where the API returns `nodes` (second mkdir always collided),
  tasks complete via PATCH not PUT, and Planner's copy row only exists in agenda view.
- PH-04 (TT120 suite) started failing this turn: walking the photo library reached a
  tile the canvas cannot rasterise (SVG/PSD), whose editor rendered *without* the
  position nav, stranding the walk. Root cause was a product gap, not a test artefact:
  the loading and decode-error branches of the Photos editor returned early without
  the header. Both branches now carry the back button + position nav
  (`src/components/modules/Photos.tsx`), and PH-04 was rewritten to walk from the tile
  it wrote, in both directions, to the true end (next disabled, prev enabled).
  e2e-tt120 is 4/4 again, with a stronger test and a better editor.
- Planner's word count is session data (it lists your tasks): the e2e now deletes the
  task it creates, and tt125-density caps planner at the session-data bound (160).
- Same growth hit tt120-density's AX-22 (planner 140 ceiling): e2e-tt119 seeds a
  "filter probe" task on every gate run and never cleaned up. e2e-tt119 now prunes its
  own probe tasks before seeding a fresh one, and the planner ceiling carries the
  session-data treatment (200, Monitor/contacts precedent). Gate runs no longer
  accumulate planner words.

## Runtime honesty

- e2e-tt81 keeps 4 environmental failures (legacy media harness); e2e-sheet-layout,
  e2e-vector, e2e-office, e2e-privacy remain environmental on this box. The gate
  excludes e2e-tt81 from the pass/fail set; nothing here claims otherwise.
- No test-script speedup was adopted this turn: no candidate was both Pareto-superior
  and significant. run-fast.sh already parallelises the pure lane (JOBS=4).
- tt125-core is pure (static guard: no fetch/BASE/DATABASE_URL/launchChromium); the
  register assertion lives in tt125-density, which is allowed to reach the server.

## Artifacts

- `docs/screens/tt125-editor.png` (case + now toolbar), `docs/screens/tt125-lens.png`
  (zoom/torch capability row), produced by tt125-density.
- Suite logs: `/tmp/gate-tt125c.log` (final gate), suite JSONs under `docs/results/`.
- Ledger refreshed after the gate via `scripts/ledger.mjs`.
