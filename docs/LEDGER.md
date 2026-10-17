# Fusion Shell Web — build / test ledger (generated)

Generated 2026-10-17T19:52:49.748Z by `scripts/ledger.mjs` from the live register (http://localhost:3999) and
50 machine-readable suite result files in `docs/test-results/`. Nothing in the counts is hand-edited.

## Headline

| | Count |
|---|---:|
| **Features in register** | **334** |
| Fully built | 250 |
| Partially built (partial 45 + probe 17) | 62 |
| Not buildable on this platform (blocked, reason rendered in UI) | 22 |
| Not built at all (skeleton) | 0 |
| **Fully tested** (≥1 passing test tagged `full`) | **130** |
| **Partially tested** (only `partial` tags) | **78** |
| Untested | 126 |
| Automated tests executed / passed | 507 / 507 |

## Build × test matrix

| build \ test | fully tested | partially tested | untested |
|---|---:|---:|---:|
| fully built | 121 | 62 | 67 |
| partially built | 3 | 14 | 45 |
| blocked | 6 | 2 | 14 |
| skeleton | 0 | 0 | 0 |

"Blocked + fully tested" means a test asserts that the UI renders the platform-impossibility reason — it
verifies the honesty contract, not the (impossible) capability.

## Suites

| suite | tests | passed | failed | ran at |
|---|---:|---:|---:|---|
| a11y-unit | 8 | 8 | 0 | 2026-10-17T19:32:03.851Z |
| ai-format | 5 | 5 | 0 | 2026-10-17T19:32:05.631Z |
| browser-session | 5 | 5 | 0 | 2026-10-17T19:31:53.101Z |
| contacts-engine | 8 | 8 | 0 | 2026-10-17T19:32:09.075Z |
| e2e-a11y | 9 | 9 | 0 | 2026-10-17T19:41:13.189Z |
| e2e-ai | 6 | 6 | 0 | 2026-10-17T19:42:08.920Z |
| e2e-beauty | 6 | 6 | 0 | 2026-10-17T19:52:38.195Z |
| e2e-browser | 6 | 6 | 0 | 2026-10-17T19:36:26.997Z |
| e2e-contacts | 9 | 9 | 0 | 2026-10-17T19:42:31.925Z |
| e2e-image | 10 | 10 | 0 | 2026-10-17T19:35:18.640Z |
| e2e-layout | 12 | 12 | 0 | 2026-10-17T19:43:39.173Z |
| e2e-media27 | 7 | 7 | 0 | 2026-10-17T19:46:00.329Z |
| e2e-office | 11 | 11 | 0 | 2026-10-17T19:34:27.901Z |
| e2e-privacy | 14 | 14 | 0 | 2026-10-17T19:36:54.085Z |
| e2e-sheet-layout | 7 | 7 | 0 | 2026-10-17T19:37:26.600Z |
| e2e-tables | 8 | 8 | 0 | 2026-10-17T19:41:34.157Z |
| e2e-tabletop | 14 | 14 | 0 | 2026-10-17T19:45:14.260Z |
| e2e-tt28 | 7 | 7 | 0 | 2026-10-17T19:46:39.873Z |
| e2e-tt29 | 4 | 4 | 0 | 2026-10-17T19:47:02.276Z |
| e2e-tt30 | 6 | 6 | 0 | 2026-10-17T19:49:03.213Z |
| e2e-vector | 12 | 12 | 0 | 2026-10-17T19:35:45.072Z |
| e2e-whiteboard | 7 | 7 | 0 | 2026-10-17T19:41:55.964Z |
| e2e | 61 | 61 | 0 | 2026-10-17T19:34:01.057Z |
| image | 12 | 12 | 0 | 2026-10-17T19:31:47.823Z |
| integration | 25 | 25 | 0 | 2026-10-17T19:31:41.774Z |
| layout-unit | 8 | 8 | 0 | 2026-10-17T19:32:09.875Z |
| maps-unit | 6 | 6 | 0 | 2026-10-17T19:32:16.590Z |
| metaclean | 6 | 6 | 0 | 2026-10-17T19:32:00.213Z |
| names | 7 | 7 | 0 | 2026-10-17T19:31:47.430Z |
| office | 35 | 35 | 0 | 2026-10-17T19:31:42.207Z |
| oracle-ai | 3 | 3 | 0 | 2026-10-17T19:32:08.714Z |
| oracle-psd | 8 | 8 | 0 | 2026-10-17T19:31:50.953Z |
| oracle-svg | 4 | 4 | 0 | 2026-10-17T19:31:52.929Z |
| oracle-vcard | 3 | 3 | 0 | 2026-10-17T19:32:09.603Z |
| oracle-xlsx | 5 | 5 | 0 | 2026-10-17T19:31:44.044Z |
| oracle | 5 | 5 | 0 | 2026-10-17T19:31:42.614Z |
| privacy-backup | 7 | 7 | 0 | 2026-10-17T19:32:03.556Z |
| privacy-crypto | 9 | 9 | 0 | 2026-10-17T19:31:57.249Z |
| privacy-layer | 11 | 11 | 0 | 2026-10-17T19:31:58.817Z |
| sheet-layout | 6 | 6 | 0 | 2026-10-17T19:31:44.425Z |
| stream-unit | 7 | 7 | 0 | 2026-10-17T19:32:10.437Z |
| tables-engine | 9 | 9 | 0 | 2026-10-17T19:32:04.073Z |
| tabletop-unit | 17 | 17 | 0 | 2026-10-17T19:32:10.234Z |
| tt28-unit | 5 | 5 | 0 | 2026-10-17T19:32:16.887Z |
| tt29-unit | 4 | 4 | 0 | 2026-10-17T19:32:17.693Z |
| tt30-unit | 7 | 7 | 0 | 2026-10-17T19:47:02.500Z |
| unit | 23 | 23 | 0 | 2026-10-17T19:31:38.829Z |
| vector-boolean | 6 | 6 | 0 | 2026-10-17T19:31:52.176Z |
| vector | 18 | 18 | 0 | 2026-10-17T19:31:51.219Z |
| whiteboard-engine | 9 | 9 | 0 | 2026-10-17T19:32:04.284Z |

## Rows touched by failing tests

None.

## By family

| family | rows | built | partial+probe | blocked | fully tested | partially tested | untested |
|---|---:|---:|---:|---:|---:|---:|---:|
| SH | 15 | 14 | 1 | 0 | 3 | 2 | 10 |
| WM | 19 | 15 | 3 | 1 | 3 | 4 | 12 |
| IN | 8 | 5 | 3 | 0 | 1 | 1 | 6 |
| SR | 8 | 7 | 0 | 1 | 3 | 3 | 2 |
| FM | 18 | 15 | 2 | 1 | 5 | 3 | 10 |
| NC | 6 | 6 | 0 | 0 | 0 | 3 | 3 |
| ST | 9 | 6 | 2 | 1 | 0 | 3 | 6 |
| AP | 5 | 2 | 2 | 1 | 0 | 0 | 5 |
| TD | 6 | 3 | 2 | 1 | 3 | 1 | 2 |
| PR | 32 | 22 | 9 | 1 | 13 | 7 | 12 |
| FF | 34 | 25 | 9 | 0 | 25 | 5 | 4 |
| MD | 9 | 6 | 3 | 0 | 0 | 7 | 2 |
| SC | 18 | 16 | 1 | 1 | 10 | 3 | 5 |
| BK | 6 | 5 | 1 | 0 | 3 | 3 | 0 |
| AX | 14 | 13 | 1 | 0 | 8 | 4 | 2 |
| TB | 5 | 5 | 0 | 0 | 5 | 0 | 0 |
| WB | 5 | 5 | 0 | 0 | 5 | 0 | 0 |
| CN | 4 | 4 | 0 | 0 | 4 | 0 | 0 |
| LY | 21 | 21 | 0 | 0 | 21 | 0 | 0 |
| SM | 4 | 4 | 0 | 0 | 1 | 3 | 0 |
| MP | 5 | 5 | 0 | 0 | 5 | 0 | 0 |
| CT | 6 | 4 | 1 | 1 | 1 | 1 | 4 |
| CA | 15 | 6 | 3 | 6 | 6 | 7 | 2 |
| LN | 15 | 8 | 3 | 4 | 1 | 3 | 11 |
| MS | 4 | 0 | 2 | 2 | 0 | 2 | 2 |
| AU | 4 | 2 | 2 | 0 | 1 | 2 | 1 |
| RG | 7 | 6 | 1 | 0 | 1 | 2 | 4 |
| HW | 11 | 2 | 9 | 0 | 0 | 1 | 10 |
| CM | 2 | 1 | 0 | 1 | 0 | 0 | 2 |
| BL | 5 | 4 | 1 | 0 | 1 | 2 | 2 |
| DP | 14 | 13 | 1 | 0 | 1 | 6 | 7 |

## Per-row detail

| code | status | tested | evidence (passing tests) |
|---|---|---|---|
| SH-01 | built | untested |  |
| SH-02 | built | untested |  |
| SH-03 | built | untested |  |
| SH-04 | built | untested |  |
| SH-05 | built | partial | e2e: SH-05 under full site isolation (--site-per-process): hung widget greys, shell responsive |
| SH-06 | built | untested |  |
| SH-07 | built | untested |  |
| SH-08 | built | full | e2e: drag a window by its title bar; geometry is committed and persisted; integration: SH-08 stale revision cannot clobber newer desktop state (409); unit: command log replay reproduces the identical state hash (+1) |
| SH-09 | built | untested |  |
| SH-10 | partial | partial | e2e: Overview (Meta+Q) and Blackout overlay toggle |
| SH-11 | built | untested |  |
| SH-12 | built | untested |  |
| SH-13 | built | untested |  |
| SH-14 | built | full | e2e: offline write is queued, then replayed through the journal when back online |
| WM-01 | built | full | e2e: drag a window by its title bar; geometry is committed and persisted; unit: 10 000 random commands preserve every invariant; unit: TT21 reducer: unchanged viewport is a no-op (no revision bump); new windows are clamped inside a small desk |
| WM-02 | built | full | e2e: keyboard tiling: Meta+ArrowLeft snaps the focused window to the left half; unit: 10 000 random commands preserve every invariant |
| WM-03 | built | partial | unit: reducer is pure (input not mutated); workspaces filter without unmounting |
| WM-04 | built | partial | e2e: Overview (Meta+Q) and Blackout overlay toggle |
| WM-05 | built | untested |  |
| WM-06 | built | partial | e2e: mount: browser |
| WM-07 | partial | untested |  |
| WM-08 | built | untested |  |
| WM-09 | built | full | e2e: keyboard tiling: Meta+ArrowLeft snaps the focused window to the left half; unit: 10 000 random commands preserve every invariant |
| WM-10 | built | untested |  |
| WM-11 | built | untested |  |
| WM-12 | built | partial | unit: 10 000 random commands preserve every invariant |
| WM-13 | built | untested |  |
| WM-14 | blocked | untested |  |
| WM-15 | partial | untested |  |
| WM-16 | built | untested |  |
| WM-17 | built | untested |  |
| WM-18 | built | untested |  |
| WM-19 | probe | untested |  |
| IN-01 | built | untested |  |
| IN-02 | built | untested |  |
| IN-03 | built | untested |  |
| IN-04 | probe | untested |  |
| IN-05 | built | full | unit: shortcut presets have no internal conflicts; chord matcher |
| IN-06 | probe | untested |  |
| IN-07 | partial | partial | e2e: mount: devices |
| IN-08 | built | untested |  |
| SR-01 | built | full | e2e: mount: find; e2e: palette: Ctrl+Space, typo 'noets' surfaces Notes with provenance; Enter opens it; integration: SR-01 search finds new content with provenance (+1) |
| SR-02 | built | partial | e2e: mount: find; integration: SR-01 search finds new content with provenance; integration: deleting a note removes only its own index row |
| SR-03 | built | full | e2e: palette: Ctrl+Space, typo 'noets' surfaces Notes with provenance; Enter opens it; integration: SR-03 typo tolerance over HTTP: 'noets' finds the notes; junk finds nothing; unit: OSA distance counts adjacent transposition as 1 (+1) |
| SR-04 | built | untested |  |
| SR-05 | built | full | integration: search treats % and _ in queries literally |
| SR-06 | built | partial | e2e: mount: calculator; unit: precedence, power associativity, rounding policy |
| SR-07 | blocked | untested |  |
| SR-08 | built | partial | e2e: mount: find |
| FM-01 | built | partial | e2e-contacts: Files integration and launcher: a .vcf reached in Files with the keyboard alone (arrows, Space, Enter) opens in Contacts; Contacts is in the launcher; e2e-privacy: Files ▸ Remove metadata (copy) on a host .docx; overwrite mode also forgets the version that still held the author; e2e: mount: files (+1) |
| FM-02 | built | untested |  |
| FM-03 | built | full | e2e: mount: files; e2e: Files upload of a 1 MiB binary succeeds (stack-overflow base64 fix); integration: FM-03 journaled move: 6 states in order, digest preserved, source retired (+2) |
| FM-04 | built | partial | e2e-ai: hostile/edge files: Illustrator data without a PDF part is not rendered; an inflate bomb and 2000+ streams finish inside the 5 s watchdog; e2e: mount: peek; integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades |
| FM-05 | built | full | integration: FM-05 compress → extract round trip preserves bytes (text and binary); integration: FM-05 extract refuses zip-slip and writes nothing; unit: zip-slip and bomb guards fire before allocation (+2) |
| FM-06 | built | untested |  |
| FM-07 | built | full | e2e: mount: storage; integration: FM-11 trash → restore is exact; FM-07 finds duplicates by digest |
| FM-08 | built | partial | e2e: mount: localdisk |
| FM-09 | built | untested |  |
| FM-10 | probe | untested |  |
| FM-11 | built | full | e2e: mount: files; integration: FM-11 trash → restore is exact; FM-07 finds duplicates by digest; integration: CRITICAL regression: purging /a_b must not touch /aXb (LIKE wildcard) |
| FM-12 | blocked | untested |  |
| FM-13 | built | untested |  |
| FM-14 | partial | untested |  |
| FM-15 | built | untested |  |
| FM-16 | built | untested |  |
| FM-17 | built | untested |  |
| FM-18 | built | full | e2e: mount: files; e2e: editor: open via terminal, edit, Ctrl+S → saved and a version snapshot exists; integration: FM-18 overwrite snapshots the previous version |
| NC-01 | built | partial | e2e: mount: alerts |
| NC-02 | built | untested |  |
| NC-03 | built | untested |  |
| NC-04 | built | partial | e2e: mount: alerts |
| NC-05 | built | partial | integration: FM-03 journaled move: 6 states in order, digest preserved, source retired |
| NC-06 | built | untested |  |
| ST-01 | built | partial | e2e: mount: settings; integration: SR-04 / settings: locked settings refuse writes (423) |
| ST-02 | probe | untested |  |
| ST-03 | partial | untested |  |
| ST-04 | built | partial | e2e: mount: settings |
| ST-05 | built | untested |  |
| ST-06 | built | partial | unit: shortcut presets have no internal conflicts; chord matcher |
| ST-07 | built | untested |  |
| ST-08 | blocked | untested |  |
| ST-09 | built | untested |  |
| AP-01 | partial | untested |  |
| AP-02 | built | untested |  |
| AP-03 | blocked | untested |  |
| AP-04 | built | untested |  |
| AP-05 | partial | untested |  |
| TD-01 | built | full | e2e: mount: terminal; e2e: terminal: write + cat through the journal; mv shows journal op |
| TD-02 | built | full | e2e: mount: terminal; e2e: terminal: write + cat through the journal; mv shows journal op |
| TD-03 | partial | partial | e2e: mount: devices |
| TD-04 | probe | untested |  |
| TD-05 | blocked | untested |  |
| TD-06 | built | full | unit: command log replay reproduces the identical state hash |
| PR-01 | built | full | e2e: mount: editor; e2e: editor: open via terminal, edit, Ctrl+S → saved and a version snapshot exists |
| PR-02 | built | partial | e2e: mount: notes; integration: deleting a note removes only its own index row |
| PR-03 | built | partial | e2e: mount: planner; integration: PR-04 ICS import is idempotent by UID; export is valid iCalendar |
| PR-04 | built | full | e2e: mount: planner; integration: PR-04 ICS import is idempotent by UID; export is valid iCalendar; unit: ICS unfolding, escapes, parameters, VTODO status, round trip |
| PR-05 | built | partial | e2e-contacts: create: empty book → New → fill name, e-mail, phone, birthday, two groups → Save; card links and the .vcf on disk are right; e2e-contacts: Files integration and launcher: a .vcf reached in Files with the keyboard alone (arrows, Space, Enter) opens in Contacts; Contacts is in the launcher; e2e: mount: contacts |
| PR-06 | partial | untested |  |
| PR-07 | built | full | browser-session: URL guard: http(s) only, bare hosts get https, credentials and own origin refused; browser-session: restore normalisation: hostile/invalid tabs dropped, groups/perms validated, active repaired, pinned first; e2e-browser: hostile saved session: javascript:, same-origin and credential URLs are dropped on restore; no frame ever points at the shell origin (+3) |
| PR-07a | built | full | browser-session: close: active tab hands focus to its neighbour (regression: view went blank); last tab replaced; e2e-browser: address bar refuses credential, non-http and own-origin URLs; accepts bare hosts (https); e2e-browser: Alt+T / Alt+P / Alt+1..9 / Alt+W shortcuts; pinned tabs move left; middle-click closing the active tab keeps a live tab |
| PR-07b | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07c | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07d | built | untested |  |
| PR-07e | built | untested |  |
| PR-07f | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: Alt+T / Alt+P / Alt+1..9 / Alt+W shortcuts; pinned tabs move left; middle-click closing the active tab keeps a live tab |
| PR-07g | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07h | blocked | untested |  |
| PR-07i | built | full | e2e-browser: Alt+T / Alt+P / Alt+1..9 / Alt+W shortcuts; pinned tabs move left; middle-click closing the active tab keeps a live tab |
| PR-07j | built | untested |  |
| PR-07k | partial | untested |  |
| PR-07l | built | full | browser-session: URL guard: http(s) only, bare hosts get https, credentials and own origin refused; browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: site permissions panel writes the iframe delegation policy into the saved session |
| PR-07m | partial | untested |  |
| PR-07n | partial | untested |  |
| PR-07o | probe | untested |  |
| PR-07p | partial | untested |  |
| PR-07q | built | full | browser-session: batch actions: close others / to the right / duplicates keep pinned tabs and the anchor; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07r | built | partial | browser-session: restore normalisation: hostile/invalid tabs dropped, groups/perms validated, active repaired, pinned first; e2e-browser: hostile saved session: javascript:, same-origin and credential URLs are dropped on restore; no frame ever points at the shell origin; e2e: mount: routines (+1) |
| PR-07s | partial | untested |  |
| PR-08 | partial | untested |  |
| PR-09 | built | full | e2e: mount: calculator; e2e: calculator evaluates typed input with the shared evaluator; unit: precedence, power associativity, rounding policy (+1) |
| PR-10 | built | partial | e2e: mount: clock; e2e: clock stopwatch advances from performance.now anchors |
| PR-11 | partial | partial | e2e: mount: writer; e2e: mount: slides; e2e: mount: sheet (+2) |
| PR-12 | built | partial | e2e: mount: clipboard |
| PR-13 | built | full | e2e: desktop shows sticky note widget; seeded widget has no hang button |
| FF-01 | built | partial | e2e: mount: peek; unit: loss report itemises drops; registry grades |
| FF-02 | built | full | integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; unit: docx extraction; EPUB spine order; PSD header |
| FF-03 | partial | partial | oracle-ai: held-out real Illustrator .ai files (CS6 … 28.5): ai-pdf, renderable, version, creator = pypdf, pages = pypdf |
| FF-04 | built | full | ai-format: real Illustrator output: PDF export, DOS-EPS, Illustrator 88 EPS and FreeHand AI-dialect PostScript; ai-format: constructed .ai with and without PDF compatibility (the spec's open-vs-limited split); ai-format: creator hidden in a compressed object stream, UTF-16BE strings, junk before the header (+15) |
| FF-05 | built | untested |  |
| FF-06 | probe | untested |  |
| FF-07 | partial | untested |  |
| FF-08 | built | full | integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; unit: docx extraction; EPUB spine order; PSD header |
| FF-09 | built | full | unit: CSV RFC-4180 round trip |
| FF-10 | built | full | integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; unit: docx extraction; EPUB spine order; PSD header |
| FF-11 | built | full | e2e: mount: peek; unit: loss report itemises drops; registry grades |
| FF-12 | built | full | ai-format: FF-12 guards: inflate bomb, 1 000 streams, corrupt Flate data, damaged DOS-EPS, empty and text files; integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; integration: FM-05 extract refuses zip-slip and writes nothing (+1) |
| FF-13 | partial | untested |  |
| FF-14 | built | full | ai-format: version strings, PDF literal escapes, format registry and MIME; unit: loss report itemises drops; registry grades |
| FF-15 | built | partial | e2e: mount: editor; e2e: editor: open via terminal, edit, Ctrl+S → saved and a version snapshot exists |
| FF-19 | built | full | e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e: mount: sheet; office: first-party verified semantics survive: SUM(1,"x",2) is still #VALUE! (+7) |
| FF-20 | partial | full | e2e-office: save → reopen keeps styles/widths/charts; export .xlsx → server re-import keeps bold, numFmt, widths; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e-sheet-layout: TT19 defined names: Name Box defines a name for the selection and jumps to it; formulas + autocomplete use it; Name Manager lists it; survives Export .xlsx → reopen (+7) |
| FF-21 | partial | full | e2e-office: save → reopen keeps styles/widths/charts; export .xlsx → server re-import keeps bold, numFmt, widths; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e: mount: sheet (+3) |
| FF-22 | partial | partial | e2e: mount: writer |
| FF-23 | partial | partial | e2e: mount: slides |
| FF-24 | built | full | e2e-image: marquee → crop to selection changes canvas size; image rotate; Ctrl+Z restores; invert filter through selection; e2e-image: Export PNG → reopen the PNG from the VFS as a new document; Image size dialog resizes; e2e-image: classic Quick edit mode is still available (additive merge) (+3) |
| FF-25 | built | full | e2e-vector: UI: rect/ellipse/star by drag (shift = square), exact geometry; undo/redo by keyboard; e2e-vector: UI: Save .fsvg → reopen (v2 round trip), Export SVG (re-importable, safe), Export PNG (valid PNG at doc size); e2e: mount: vector |
| MD-01 | built | partial | e2e: mount: capture |
| MD-02 | built | partial | e2e: mount: media |
| MD-03 | partial | partial | e2e-image: classic Quick edit mode is still available (additive merge); e2e: mount: imageedit |
| MD-04 | built | partial | e2e: mount: devices |
| MD-05 | built | partial | e2e: mount: devices |
| MD-06 | built | partial | e2e: mount: devices |
| MD-07 | built | partial | e2e: mount: devices |
| MD-08 | partial | untested |  |
| MD-09 | partial | untested |  |
| SC-01 | built | partial | e2e: mount: vault; unit: seal/open round trip; wrong passphrase and ciphertext tamper fail |
| SC-02 | built | partial | e2e: mount: vault |
| SC-03 | built | untested |  |
| SC-04 | blocked | untested |  |
| SC-05 | built | untested |  |
| SC-06 | partial | untested |  |
| SC-07 | built | full | unit: seal/open round trip; wrong passphrase and ciphertext tamper fail; unit: header downgrade (iterations) is detected via AAD; policy floor enforced |
| SC-08 | built | partial | integration: SR-04 / settings: locked settings refuse writes (423) |
| SC-09 | built | untested |  |
| BK-01 | built | full | e2e: mount: backup; integration: FM-18 overwrite snapshots the previous version; integration: BK-01 tampered backup bundle is refused before anything is written (+1) |
| BK-02 | partial | partial | e2e: mount: localdisk |
| BK-03 | built | partial | e2e: mount: backup; integration: BK-01 tampered backup bundle is refused before anything is written |
| BK-04 | built | full | unit: BK-04 capability diff reports lost/gained with degrade text |
| BK-05 | built | partial | e2e: mount: backup; integration: BK-01 tampered backup bundle is refused before anything is written |
| BK-06 | built | full | privacy-crypto: volume life-cycle: create → unlock by passphrase or recovery key (any case/separators) → wrong secret refused; privacy-crypto: change passphrase rewraps one slot only: old files still open, old passphrase refused, recovery still works; rotate recovery kills the old key; unit: seal/open round trip; wrong passphrase and ciphertext tamper fail |
| FF-26 | built | full | e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e: mount: sheet; office: SEQUENCE(2,3) spills all six cells with correct values (+13) |
| FF-27 | built | full | e2e: mount: sheet; office: FILTER with a broadcast boolean condition, SORT, UNIQUE, XLOOKUP; office: first-party verified semantics survive: SUM(1,"x",2) is still #VALUE! (+6) |
| FF-28 | built | full | e2e-a11y: spreadsheet grid geometry scales with the text (row height = 22 × scale) and a header drag still moves the edge 1:1 on screen; e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e-office: autocomplete (Tab inserts NAME( ), point-mode click inserts a reference, Enter commits and recalculates (+29) |
| FF-29 | partial | full | e2e-office: charts panel renders SVG chart images (bar → pie) from a dynamic-array source; e2e: mount: sheet; office: charts: series from columns with header names, gaps for text, nice ticks, SVG escaping, error on no data (+2) |
| FF-30 | built | full | e2e-image: ORACLE: our compositor vs Chromium/Skia globalCompositeOperation — 12 blend modes, opaque and translucent backdrops; e2e-image: new doc renders; brush drag paints a continuous line in the foreground colour; undo/redo; e2e-image: layers: new layer, paint, blend=multiply changes composite, opacity, visibility toggle, reorder, merge (+23) |
| FF-31 | built | full | e2e-image: Save PSD → VFS file decodes with our reader (layers/blend/mask) → deep-link reopen restores layers and pixels; e2e: mount: imageedit; image: PackBits: Apple TN1023 vector decodes; encoder round-trips random/edge data and is ≤ TN1023 size (+9) |
| FF-32 | built | full | e2e-vector: ORACLE Chromium SVG: getBBox + getTotalLength of the ORIGINAL d vs our normalised cubics (arcs included); e2e-vector: ORACLE Chromium SVG: isPointInFill (nonzero + evenodd) vs our containment on a 31×31 grid per path; transform.baseVal; e2e-vector: ORACLE render parity: Chromium rasterises the original SVG and our import→export identically (≤0.5% pixels > 24/255) (+31) |
| FF-33 | built | full | e2e-sheet-layout: Merge & Center: upper-left-most data kept after the Excel warning, one spanning cell, selection/arrow keys treat it as one; Unmerge restores cells; e2e-sheet-layout: Freeze first column stays put on horizontal scroll; sorting a range with a merge is refused with Excel's message; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader) (+8) |
| FF-34 | built | full | e2e-sheet-layout: Borders: Outside (medium, colour) draws the four perimeter edges via the neighbours' shared edges; Inside dotted; No Border clears; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e: mount: sheet (+4) |
| FF-35 | built | full | e2e-sheet-layout: Data validation: list dropdown picks a value; Stop rejects (rolled back, Retry/Cancel); Warning lets you keep it; Circle invalid flags it; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e: mount: sheet (+5) |
| SC-10 | built | full | e2e-privacy: create Persistent Storage in the UI: Argon2id keyslots + recovery key; nothing secret reaches the host; top bar shows the unlocked state; e2e-privacy: files written by the shell into /Private reach the host as ciphertext only: no name, no content, no index entry, no audit path; e2e-privacy: amnesic session: AMNESIC badge, files in RAM only, notes refused + logged, localStorage and IndexedDB leave no trace, /Private still persists (+19) |
| SC-11 | built | full | e2e-privacy: create Persistent Storage in the UI: Argon2id keyslots + recovery key; nothing secret reaches the host; top bar shows the unlocked state; e2e-privacy: lock from the top bar → 423; unlock with the RECOVERY key in the UI → readable; a reload forgets the key (memory only); e2e: mount: privacy (+3) |
| SC-12 | built | full | e2e-privacy: Remove metadata on an encrypted photo in the UI: cleaned in the browser, copy stays encrypted, Pillow confirms only Orientation remains; e2e-privacy: Files ▸ Remove metadata (copy) on a host .docx; overwrite mode also forgets the version that still held the author; e2e: mount: privacy (+6) |
| SC-13 | built | full | e2e-privacy: amnesic session: AMNESIC badge, files in RAM only, notes refused + logged, localStorage and IndexedDB leave no trace, /Private still persists; e2e-privacy: privacy headers: no-referrer, no DNS prefetch, nosniff, object-src none; API bodies are never written to the HTTP disk cache; e2e: mount: privacy (+1) |
| SC-14 | built | full | e2e-privacy: host audit in the UI: a plaintext file planted by another client is flagged and 'Encrypt it' seals it (name + content); e2e: mount: privacy; privacy-layer: audit walks /Private on the host and flags anything stored in clear (a planted plaintext file is caught) |
| SC-15 | built | full | e2e-privacy: emergency shutdown chord: keys + RAM files gone, page blanked via location.replace (no history entry with the shell); e2e: mount: privacy |
| FF-36 | built | full | e2e-sheet-layout: TT19 defined names: Name Box defines a name for the selection and jumps to it; formulas + autocomplete use it; Name Manager lists it; survives Export .xlsx → reopen; names: name syntax follows Excel's rules (web-checked): letters/_ first, no spaces, not A1/R1C1-like, not C/R, ≤255; names: names in formulas: ranges, constants, formula names, chains; case-insensitive; unknown → #NAME? until defined (+5) |
| FF-37 | built | full | e2e-vector: TT19 Pathfinder: Unite / Minus Front on two drawn rectangles — geometry, paint and undo; vector-boolean: two rectangles: all four shape modes equal GEOS exactly; paint + stacking follow Illustrator (front paint; Minus Front keeps the back); vector-boolean: rotated rectangle (transform) × ellipse: every mode within flattening tolerance of GEOS (IoU ≥ 0.9995) (+4) |
| SC-16 | built | full | e2e-privacy: TT19 private search in the UI: the palette finds an encrypted /Private file by content; Find '/Private only' searches in the tab and sends NO search request to the host; privacy-layer: TT19 private search: /Private is searchable from an in-tab index; scoped queries never reach the host; index follows write/move/trash and dies on lock; privacy-layer: TT19 amnesic search: RAM-only files are searchable in place and hidden host files drop out of results |
| SC-17 | built | full | e2e-privacy: TT20 backup in the UI: download one encrypted file, verify it, wipe the host volume, restore it from the file — byte-identical ciphertext; privacy-backup: backup is one file holding only ciphertext: no names, no content, no tree shape; cleartext entries are skipped and reported; privacy-backup: verify opens every entry with the passphrase AND with the recovery key; wrong secret and a flipped byte are rejected (+4) |
| SC-18 | built | full | e2e-privacy: TT20 amnesic unsaved-work guard: RAM-only files listed, leaving asks first, 'Keep all' moves them into /Private encrypted; emergency shutdown never asks; privacy-backup: amnesic rescue: RAM-only files are listed and moved into /Private/Rescued encrypted; nothing lands in clear; locked refuses |
| AX-09 | built | full | a11y-unit: text-scale maths: default 125 %, Large text mode 200 %, clamps, steps; every inline font size goes through fz(); a11y-unit: token text contrast ≥4.5:1 (WCAG 1.4.3): body, muted, badges, desktop labels over the brightest wallpaper spot; a11y-unit: settings validation: text size must be an integer 100–300, wallpaper/theme/density from their lists, accent a hex colour (+8) |
| AX-10 | built | full | a11y-unit: icon contrast: every palette's glyph colour is ≥3:1 against its tile gradient across the whole glyph area (WCAG 1.4.11); a11y-unit: every registered module and every common file type has a real glyph; tile palettes exist; a11y-unit: no emoji glyphs left in the shell chrome (they render blank without a colour-emoji font) (+2) |
| AX-11 | built | full | a11y-unit: style system: every style's glyphs ≥3:1 on their tiles, chrome ink ≥4.5:1, dark+light text tokens ≥4.5:1, accent buttons ≥4.5:1; CSS emitted for each; a11y-unit: light theme: field background and status-text tokens reach ≥4.5:1; filled spreadsheet cells get automatic ink; e2e-a11y: style switch: the Settings and Quick panel pickers swap data-style, logo colours, auto wallpaper and accent; persisted; bad values refused (+1) |
| TB-01 | built | full | e2e-tables: editing: a number cell commits on Enter and recomputes the formula; a non-number is refused; Undo restores; e2e-tables: save .ftable, reopen it from the VFS with the edits intact; export CSV to the VFS; import a CSV file as a new table; e2e: mount: tables (+5) |
| TB-02 | built | full | e2e-tables: two-way link through the picker: linking Cy to a task shows on People (inverse field) and updates the Open hours rollup; e2e: mount: tables; tables-engine: two-way links: linking updates the inverse field, unlinking removes it, unknown ids are refused, deleting a record scrubs every reference (+1) |
| TB-03 | built | full | e2e-tables: sample base renders: Tasks grid, lookup-driven formula (6.5 h × 65 = 422.5), footer sum, table tabs; e2e-tables: add a formula field: live validation disables Create on a bad formula; a good one adds a computed column; e2e: mount: tables (+2) |
| TB-04 | built | full | e2e-tables: filter + sort: Status is Doing leaves 2 records; sorting Hours descending orders them; badges count the conditions; e2e-tables: kanban: columns by Status; moving a card with its Move select and by drag-and-drop updates the counts and the grid; e2e: mount: tables (+2) |
| TB-05 | built | full | e2e-tables: sample base renders: Tasks grid, lookup-driven formula (6.5 h × 65 = 422.5), footer sum, table tabs; e2e-tables: editing: a number cell commits on Enter and recomputes the formula; a non-number is refused; Undo restores; e2e-tables: save .ftable, reopen it from the VFS with the edits intact; export CSV to the VFS; import a CSV file as a new table (+2) |
| AX-12 | built | full | e2e-a11y: light + dark theme, all 13 styles: axe finds no serious violations in the chrome, Files and Spreadsheet |
| WB-01 | built | full | e2e-whiteboard: draw shapes with the pointer: rect by drag (snapped), ellipse by click (default size), pen stroke, sticky note with two lines of text; e2e: mount: whiteboard; whiteboard-engine: hit testing, marquee and bind targets respect real shape outlines and z-order (+2) |
| WB-02 | built | full | e2e-whiteboard: starter board: sticky + ellipse joined by a BOUND arrow, Layers list names them, module is in the launcher; e2e-whiteboard: connector follows: an arrow drawn from the rect to the ellipse binds both ends and stays on the rect's outline when the rect is dragged; e2e: mount: whiteboard (+3) |
| WB-03 | built | full | e2e-whiteboard: keyboard: Layers list selects, arrows nudge (Shift = 10), Ctrl+D duplicates, Delete removes, Ctrl+Z undoes; the text field edits; e2e-whiteboard: arrange: marquee selects only enclosed elements, Align Left lines them up, Group makes one selection; e2e: mount: whiteboard (+2) |
| WB-04 | built | full | e2e-whiteboard: files: Save .fboard, reopen it from its path, Export SVG (escaped, no script); a hostile .fboard is repaired and the count reported; e2e: mount: whiteboard; whiteboard-engine: SVG export is escaped and self-contained; .fboard round-trips; hostile files are refused or repaired (+1) |
| WB-05 | built | full | e2e-whiteboard: starter board: sticky + ellipse joined by a BOUND arrow, Layers list names them, module is in the launcher; e2e-whiteboard: draw shapes with the pointer: rect by drag (snapped), ellipse by click (default size), pen stroke, sticky note with two lines of text; e2e-whiteboard: keyboard: Layers list selects, arrows nudge (Shift = 10), Ctrl+D duplicates, Delete removes, Ctrl+Z undoes; the text field edits (+3) |
| CN-01 | built | full | contacts-engine: RFC 6350 §8 author's vCard: unfolding, structured N/ADR, quoted TYPE lists, tel: URIs, unknown properties kept; contacts-engine: RFC 2426 §7 (vCard 3.0): TYPE=PREF, INTERNET dropped, VOICE dropped beside other types, mixed-case BEGIN; contacts-engine: vCard 2.1: QUOTED-PRINTABLE with soft breaks, CHARSET=ISO-8859-1, bare TYPE params, base64 PHOTO, missing FN (+8) |
| CN-02 | built | full | contacts-engine: search (accents, tokens, phone digits), sort/letters, CSV export with injection guard, Contact Picker mapping, validation; e2e-contacts: create: empty book → New → fill name, e-mail, phone, birthday, two groups → Save; card links and the .vcf on disk are right; e2e-contacts: no lost edit: closing the window right after Save (inside the 0.5 s autosave delay) still writes the change (+5) |
| CN-03 | built | full | contacts-engine: RFC 6350 §4.3.1 dates: write basic format (YYYY-MM-DD is disallowed in 4.0), accept every listed form, Feb 29; contacts-engine: duplicates (e-mail case, phone formatting, folded name) and merge keep everything from both; e2e-contacts: duplicates and merge, birthdays: two cards sharing an e-mail (different case) are grouped and merged without losing a phone; a birthday in 3 days is listed (+1) |
| CN-04 | built | full | contacts-engine: search (accents, tokens, phone digits), sort/letters, CSV export with injection guard, Contact Picker mapping, validation; e2e-contacts: import + search + persistence: RFC 6350 §8, RFC 2426 §7 and a 2.1 quoted-printable card load; search folds accents and matches phone digits; .vcf import skips a repeated UID; survives reload; e2e-contacts: export: CSV to Files (injection-guarded) and as a download; .vcf download re-imports to the same contacts (+2) |
| LY-01 | built | full | e2e-layout: Settings → Layout: picking Business swaps the top bar + shelf for a bottom taskbar; persisted across a reload; e2e-layout: Business taskbar: open → minimise → restore on click, Shift+click new window, jump list, Show desktop round trip, clock → Planner; e2e-layout: Business: Start menu opens above the taskbar at bottom-left, search + Enter launches; Quick settings and toasts sit bottom-right; Windows caption buttons (+4) |
| LY-02 | built | full | e2e-layout: Quick panel → Layout: Art gives a menu bar and a centred dock holding EVERY app (+ Launchpad, Trash); no taskbar; e2e-layout: Art dock magnification: measured peak under the pointer, cosine falloff, name bubble, stable under the pointer, reset on leave; off switch; e2e-layout: Art dock: launch bounces and shows a running dot; minimise (traffic light) parks the window after the separator, click restores; right-click Quit (+7) |
| LY-03 | built | full | e2e-layout: Settings → Layout: picking Business swaps the top bar + shelf for a bottom taskbar; persisted across a reload; e2e-layout: Quick panel → Layout: Art gives a menu bar and a centred dock holding EVERY app (+ Launchpad, Trash); no taskbar; e2e-layout: API: unknown layout and dockMagnify values are refused (422); the setting is searchable by 'taskbar' and 'dock' (+1) |
| LY-04 | built | full | e2e-a11y: light + dark theme, all 13 styles: axe finds no serious violations in the chrome, Files and Spreadsheet; e2e-layout: axe-core: Business with Enterprise and Art with Graphite, dark + light, Start menu / Launchpad / menus open — no serious or critical violations; layout-unit: TT25 professional styles: Enterprise (flat, Windows-like) and Graphite (aluminium, macOS-like) with their own wallpapers |
| LY-05 | built | full | e2e-beauty: 1440×900: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations; e2e-beauty: 1280×800: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations; e2e-beauty: 1920×1080: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations (+7) |
| LY-06 | built | full | e2e-tabletop: desktop icons (classic): drag snaps to another grid cell and persists; Alt+Arrow moves; 'Sort icons by name' and 'Clean up icons' rearrange; tabletop-unit: desktop icons: column-major auto layout, saved cells win, contested/out-of-grid cells ignored, missing paths dropped (SH-04); tabletop-unit: desktop icons: drag moves to a cell and swaps with an occupant, nudge clamps at the edges, clean up closes gaps in reading order, sort by name is natural (+1) |
| LY-07 | built | full | e2e-tabletop: toggle: Quick panel switch replaces the desktop with the Tabletop (persisted); Settings → Desktop view brings Classic back; e2e-tabletop: box geometry (straight-down camera): floor projected at p/(p+depth) and centred; four walls hinge on the screen edges (measured); e2e-tabletop: a wall becomes the main view: double-click unfolds it to fill the desk (others fold away, inert), Back / Esc / double-click its background return; switcher works too (+7) |
| LY-08 | built | full | e2e-tabletop: drag a card onto a card makes a pile (persisted, survives reload); click fans it out on an arc; drag a card out of the fan takes it out and the pile dissolves; e2e-tabletop: keyboard pile (WCAG 2.5.7 alternative to dragging): Shift+F10 on a card → 'Pile with …'; Enter fans the pile, Esc gathers; Alt+Arrow moves a card; tabletop-unit: tabletop state: normalizeTable validates untrusted input against the files that exist (+2) |
| LY-09 | built | full | e2e-tabletop: micro peek shows the real contents (Markdown heading + bullets, CSV grid with a quoted comma) and enlarges on hover / focus; tabletop-unit: micro peek: Markdown keeps headings/bullets, plain text and code, line cap, CSV with RFC 4180 quoting, JSON grid / pretty text, images, SVG, binary, sealed, empty |
| LY-10 | built | full | e2e-beauty: the pipeline catches seeded violations in the live page (tiny crowded buttons, clipped text, an off-centre dock, an un-golden card); e2e-beauty: 1440×900: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations; e2e-beauty: 1280×800: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations (+3) |
| LY-11 | built | full | e2e-tabletop: slanted camera is the default: floor ≥ 80 % of the Tabletop by hit-sampling 1440 points (desktop + phone), the near lip is a ≥ 24 px target, Camera toggles top ↔ slant and persists; tabletop-unit: slanted camera (default): floor ≥ 80 % of the frame across a viewport sweep, lip ≥ 24 px, β = 38°, walls share the rest; tabletop-unit: slanted camera maths: floor homography = the 3D projection (< 0.01 px) and inverts (< 0.01 px); faces meet at the seams; every wall faces into the box |
| LY-12 | built | full | e2e-tabletop: walls are pinboards: drag a card onto a wall pins it (persisted, leaves the floor); the open wall shows it with a count; drag moves it on the wall; 'Put back on the table' returns it; e2e-tabletop: wall piles by menu (keyboard path): 'Pin to the Apps wall' ×2, pile them on the wall, fan the wall pile, take one out; pins survive reload; e2e-tt29: wall tags are the click AND drop targets the slivers could not be (TT29): clicking the Apps spine opens the Apps wall; dragging a floor card onto the Widgets spine highlights it and pins the card there (persisted) (+2) |
| LY-13 | built | full | e2e-tabletop: saved tabletop views: save (camera + face + pins), change everything, load restores it, survives reload, delete; tabletop-unit: saved tabletop views: save captures camera + face + every surface; same name updates in place; load restores (re-validated against today's files); rename / delete; cap |
| LY-14 | built | full | e2e-beauty: colour schemes: all 13 styles × dark/light measured from live screenshots (OKLCH) — hard: axe colour-contrast clean, Silver/Daylight light themes mostly light-neutral; soft: harmony template, hue entropy, 60-30-10; e2e-media27: layout ↔ style pairing: Art → Silver + light, Business → Daylight + light (from the Quick-panel/Settings switch), Fusion keeps the look; 'Match the look' off leaves the style alone; tabletop-unit: colour beauty core: OKLCH matches published values, WCAG contrast, harmony templates, hue entropy, pixel statistics (60-30-10, light-neutral share); Silver/Daylight tokens are silver/light |
| LY-15 | built | full | e2e-beauty: colour schemes: all 13 styles × dark/light measured from live screenshots (OKLCH) — hard: axe colour-contrast clean, Silver/Daylight light themes mostly light-neutral; soft: harmony template, hue entropy, 60-30-10; tabletop-unit: colour beauty core: OKLCH matches published values, WCAG contrast, harmony templates, hue entropy, pixel statistics (60-30-10, light-neutral share); Silver/Daylight tokens are silver/light |
| SM-01 | built | partial | e2e-media27: Video: privacy gate (no provider request before consent), youtube-nocookie iframe with origin-only Referer + sandbox/allow, bad links explained, Save → Streams.json, reload keeps it, Next walks the library; e2e: mount: video; stream-unit: YouTube: watch / youtu.be / shorts / live / embed / music links → youtube-nocookie embed; start times; playlists (+2) |
| SM-02 | built | partial | e2e-media27: Music: Spotify (152 px track player, encrypted-media) and SoundCloud widget (166 px, documented params) behind the gate; 'Always load' persists and skips the gate; video links redirected; e2e: mount: music; stream-unit: Spotify + SoundCloud: official embed URLs, URI form, intl paths, content types, widget params, heights, allow lists |
| SM-03 | built | full | e2e-media27: Video: privacy gate (no provider request before consent), youtube-nocookie iframe with origin-only Referer + sandbox/allow, bad links explained, Save → Streams.json, reload keeps it, Next walks the library; e2e-media27: axe-core: Video, Music and Maps (dark + light) — no serious or critical violations; e2e: mount: video (+2) |
| MP-01 | built | full | e2e-media27: Maps offline: the world draws with zero tile requests (≥ 230 countries, land pixels on the canvas); search 'France' flies there; hover names the country; coordinates search; Explore click selects a country; e2e-media27: Maps street tiles are opt-in: OSM tile requests start only after choosing them, carry an origin-only Referer (OSM tile policy), show the © OpenStreetMap attribution; bad custom templates are refused by the API; e2e-media27: axe-core: Video, Music and Maps (dark + light) — no serious or critical violations (+2) |
| MP-02 | built | full | e2e-media27: Maps offline: the world draws with zero tile requests (≥ 230 countries, land pixels on the canvas); search 'France' flies there; hover names the country; coordinates search; Explore click selects a country; e2e-media27: Maps places + measure: Add place by map click and 'Add at centre' → Places.geojson (valid RFC 7946, [lng, lat]); rename persists; measured distance equals haversine of the clicked points (Web Mercator inverse, ±1 %); e2e: mount: maps (+2) |
| MP-03 | built | full | e2e-media27: Maps places + measure: Add place by map click and 'Add at centre' → Places.geojson (valid RFC 7946, [lng, lat]); rename persists; measured distance equals haversine of the clicked points (Web Mercator inverse, ±1 %); e2e: mount: maps; maps-unit: geodesy: haversine matches known distances (±0.5 %), bearings, path length, metric/imperial formatting |
| SM-04 | built | partial | e2e-tt28: embed control (SM-04): YouTube handshake with origin + id, Play/Pause commands, progress clock, ended → auto-next by loadVideoById in the SAME player; spoofed 'ended' from our own window or a foreign-origin frame is ignored; Auto-next off stops; e2e-tt28: embed control (SM-04): Vimeo ready → addEventListener subscriptions → ended advances to the next item (new player, autoplay requested); SoundCloud ready → subscriptions → playProgress clock → finish advances (auto_play=true); Spotify (TT29): ready → ack, Play → confirmed toggle, clock, a near-end pause is NOT an end, paused-at-end → inferred end → next Spotify player asked to play; stream-unit: embed control protocol (TT28): YouTube handshake + infoDelivery/onStateChange → ended exactly once; Vimeo ready → subscriptions → ended/finish; SoundCloud ready → subscriptions → playProgress → finish; commands are the exact message strings (+1) |
| MP-04 | built | full | e2e-tt28: offline gazetteer (MP-04/MP-05): API answers 'Paris, TX' and 'In Raleigh' with attribution; Maps search lists cities, flies there, 'Save as place' writes it; new places are named by the nearest city; hover says how far from which city; zero third-party requests; maps-unit: gazetteer (TT28): own TSV parser over GeoNames cities15000; folding (Zürich = Zurich, St. = Saint); exact > prefix > word-prefix ranked by population; qualifiers 'Paris, TX' / 'Paris, France' / 'Springfield, Illinois'; garbage-safe |
| MP-05 | built | full | e2e-tt28: offline gazetteer (MP-04/MP-05): API answers 'Paris, TX' and 'In Raleigh' with attribution; Maps search lists cities, flies there, 'Save as place' writes it; new places are named by the nearest city; hover says how far from which city; zero third-party requests; maps-unit: gazetteer nearest (TT28): grid ring search is EXACT: 400 random points (incl. polar + antimeridian) agree with a brute-force scan; 'N km NE of …' labels; Raleigh downtown → In Raleigh |
| SH-15 | built | full | e2e-tt28: in-app ask dialog (SH-15) replaces prompt(): focus lands in the field with the default selected; Tab is trapped; global shortcuts are blocked while it is open (modal); Enter creates, Escape cancels and focus returns to the opener; passphrases are masked, double-entered and validated in place; tt28-unit: ask store: FIFO queue; validation keeps the dialog open; each request settles exactly once; cancel-all; queue cap 8; values capped at 4 KiB |
| LY-16 | built | full | e2e-tt28: Business Snap (LY-16/LY-17): hovering Maximise opens the layouts flyout; a quarter zone places the window exactly; Snap Assist offers the other windows for the remaining zones in order; a title-bar drag into a corner shows a live preview and snaps to that quarter; the Snap layouts chord opens the flyout with keyboard focus; tt28-unit: snap layouts tile the desk exactly: for 2 000 random desk sizes every layout's zones cover each pixel exactly once; thumbnails stay inside their box; tt28-unit: Snap Assist plan: remaining zones in reading order; nothing to offer → null; the reducer's 'place' clamps, rejects NaN, keeps the restore rect, raises z |
| LY-17 | built | full | e2e-tt28: Business Snap (LY-16/LY-17): hovering Maximise opens the layouts flyout; a quarter zone places the window exactly; Snap Assist offers the other windows for the remaining zones in order; a title-bar drag into a corner shows a live preview and snaps to that quarter; the Snap layouts chord opens the flyout with keyboard focus; tt28-unit: drag targets: corners → quarters, sides → halves, top → maximise, bottom edge only in its corners, interior → none; degenerate input → none |
| LY-18 | built | full | e2e-tt28: Art dock (LY-18/LY-19): auto-hide slides the dock off-screen and gives windows the space; the bottom edge reveals it; it stays ≥ 400 ms after leaving and hides by ~600 ms; keyboard focus reveals it; minimise plays the genie into the dock tile (clip-path funnel), and not at all under reduced motion |
| LY-19 | built | full | e2e-tt28: Art dock (LY-18/LY-19): auto-hide slides the dock off-screen and gives windows the space; the bottom edge reveals it; it stays ≥ 400 ms after leaving and hides by ~600 ms; keyboard focus reveals it; minimise plays the genie into the dock tile (clip-path funnel), and not at all under reduced motion; tt28-unit: genie keyframes: every frame has the same 4-point clip polygon (so it interpolates), offsets 0 → .45 → 1, phase 1 pinches only the bottom edge over the tile, and the last frame lands exactly on the dock tile for 500 random window/tile pairs |
| AX-13 | built | full | e2e-tt28: accessibility tree (AX-13): Playwright ariaSnapshot of the live page in Fusion, Business and Art: landmarks and names a screen reader would announce (dock / taskbar navigation, named window dialogs, no unnamed buttons or text fields); the ask dialog and the snap flyout expose their roles and names |
| LY-20 | built | full | e2e-tt29: beauty rule 'no squashed text' (TT29): under the default slanted camera every visible Tabletop text renders at an effective ≥ 9 px (font-size × projected scale, measured per element) at 1440×900 and 390×800; walls below the legibility rule show glyphs only; e2e-tt29: wall tags (TT29): one per foreshortened wall, inside the frame, centred on the wall's VISIBLE area (hit-test finds that wall under the centre), ≥ 24 px targets, no overlaps with each other or the switcher; counts in the label; e2e-tt29: wall tags are the click AND drop targets the slivers could not be (TT29): clicking the Apps spine opens the Apps wall; dragging a floor card onto the Widgets spine highlights it and pins the card there (persisted) (+5) |
| LY-21 | built | full | e2e-tt29: beauty rule 'no squashed text' (TT29): under the default slanted camera every visible Tabletop text renders at an effective ≥ 9 px (font-size × projected scale, measured per element) at 1440×900 and 390×800; walls below the legibility rule show glyphs only; e2e-tt29: straight-down camera obeys the same rule: its walls are below the legibility scale too (computed), so they show glyphs + tags; no visible text under 9 px effective; the computed box model matches the DOM (each wall face's measured box = its quad's box ± 2 px) |
| AX-14 | built | full | e2e-tt30: oracle: our accessible names and roles agree with Chromium's accessibility tree in all 40 modules × 3 layouts (thresholds declared up front: names ≥ 98 %, roles ≥ 99 %); e2e-tt30: oracle sensitivity: three mutants of the narrator source are caught (aria-label ignored → names < 98 %; buttons as generic → roles < 99 %; CSS text-transform ignored → the uppercase headings differ); e2e-tt30: behaviour: the toggle chord turns Narrator on (spoken + captioned + saved); Tab focus is announced with name and role and the cursor box surrounds the focused element; entering a window announces its dialog context; typing is echoed (+10) |
| CT-01 | built | untested |  |
| CT-02 | built | full | e2e: mount: share; e2e: WebRTC data channel between two contexts via Postgres signalling; integration: CA-09 signalling: targeted delivery, no self-echo, kind whitelist, size cap |
| CT-03 | partial | untested |  |
| CT-04 | built | untested |  |
| CT-05 | blocked | untested |  |
| CT-06 | built | partial | e2e: mount: devices |
| CA-01 | built | partial | e2e: mount: media; e2e: mount: beam |
| CA-02 | partial | partial | e2e: mount: beam; integration: CA-11 Together anchor clock advances while playing and freezes on pause |
| CA-03 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-04 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-05 | built | partial | e2e: mount: beam; e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-06 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-07 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-08 | partial | untested |  |
| CA-09 | built | partial | e2e: mount: share; e2e: WebRTC data channel between two contexts via Postgres signalling; integration: CA-09 signalling: targeted delivery, no self-echo, kind whitelist, size cap |
| CA-10 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-11 | built | partial | e2e: mount: together; integration: CA-11 Together anchor clock advances while playing and freezes on pause; integration: Together GET accepts lowercase room codes (casing fix) |
| CA-12 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-13 | built | partial | e2e: mount: share |
| CA-14 | built | untested |  |
| CA-15 | partial | partial | e2e: mount: together; integration: CA-11 Together anchor clock advances while playing and freezes on pause |
| LN-01 | built | full | e2e: mount: lens; e2e: Lens processes frames from a (fake) camera at > 0 fps |
| LN-02 | probe | untested |  |
| LN-03 | blocked | untested |  |
| LN-04 | built | untested |  |
| LN-05 | partial | untested |  |
| LN-06 | built | untested |  |
| LN-07 | built | untested |  |
| LN-08 | built | untested |  |
| LN-09 | built | untested |  |
| LN-10 | blocked | untested |  |
| LN-11 | blocked | untested |  |
| LN-12 | partial | untested |  |
| LN-13 | built | partial | e2e: mount: lens; e2e: Lens processes frames from a (fake) camera at > 0 fps |
| LN-14 | blocked | partial | e2e: mount: lens |
| LN-15 | built | partial | e2e: Lens processes frames from a (fake) camera at > 0 fps |
| MS-01 | partial | partial | e2e: mount: messages |
| MS-02 | blocked | untested |  |
| MS-03 | blocked | partial | e2e: mount: messages |
| MS-04 | partial | untested |  |
| AX-01 | built | partial | e2e-a11y: axe-core WCAG 2.x A/AA on every module window and the shell chrome: no serious or critical violations; e2e: structural a11y: every window is a named dialog; no unnamed buttons |
| AX-02 | built | partial | e2e: structural a11y: every window is a named dialog; no unnamed buttons |
| AX-03 | built | full | e2e-a11y: forced colours and prefers-contrast: more are honoured (buttons get system borders, muted text brightens) |
| AX-04 | built | untested |  |
| AX-05 | built | partial | e2e: keyboard tiling: Meta+ArrowLeft snaps the focused window to the left half |
| AX-06 | probe | untested |  |
| AX-07 | built | partial | unit: SRT → WebVTT conversion |
| AX-08 | built | full | a11y-unit: token text contrast ≥4.5:1 (WCAG 1.4.3): body, muted, badges, desktop labels over the brightest wallpaper spot; e2e-a11y: axe-core WCAG 2.x A/AA on every module window and the shell chrome: no serious or critical violations; e2e-a11y: light + dark theme, all 13 styles: axe finds no serious violations in the chrome, Files and Spreadsheet (+6) |
| AU-01 | built | full | e2e: mount: routines; e2e: routines: dry-run lists actions without executing; Run opens the window; integration: AU-01 routine whitelist rejects commands outside the palette vocabulary (+1) |
| AU-02 | built | partial | e2e: mount: routines; integration: AU-02 presets list and delete; non-prefixed rows cannot be deleted |
| AU-03 | partial | partial | integration: every JSON handler answers 400 to empty, malformed or non-object bodies and writes nothing (TT23 proxy + TT24 readJsonObject) |
| AU-04 | probe | untested |  |
| RG-01 | built | partial | e2e: mount: monitor; e2e: governor reacts to injected long tasks |
| RG-02 | partial | untested |  |
| RG-03 | built | untested |  |
| RG-04 | built | partial | e2e: mount: monitor; e2e: governor reacts to injected long tasks |
| RG-05 | built | untested |  |
| RG-06 | built | full | unit: RG-06 memory policy: absence is not low memory |
| RG-07 | built | untested |  |
| HW-01 | built | partial | e2e: drag a window by its title bar; geometry is committed and persisted |
| HW-02 | partial | untested |  |
| HW-03 | probe | untested |  |
| HW-04 | probe | untested |  |
| HW-05 | partial | untested |  |
| HW-06 | probe | untested |  |
| HW-07 | probe | untested |  |
| HW-08 | partial | untested |  |
| HW-09 | partial | untested |  |
| HW-10 | probe | untested |  |
| HW-11 | built | untested |  |
| CM-01 | blocked | untested |  |
| CM-02 | built | untested |  |
| BL-01 | built | full | e2e: mount: settings; integration: BL-01 licence: valid key verifies; one flipped character fails; wrong client is refused |
| BL-02 | built | partial | integration: BL-01 licence: valid key verifies; one flipped character fails; wrong client is refused |
| BL-03 | built | untested |  |
| BL-04 | probe | untested |  |
| BL-05 | built | partial | integration: BL-01 licence: valid key verifies; one flipped character fails; wrong client is refused |
| DP-01 | built | untested |  |
| DP-02 | built | untested |  |
| DP-03 | built | untested |  |
| DP-04 | built | partial | integration: FM-03 journaled move: 6 states in order, digest preserved, source retired |
| DP-05 | built | partial | integration: FM-18 overwrite snapshots the previous version; integration: CRITICAL regression: purging /a_b must not touch /aXb (LIKE wildcard) |
| DP-06 | built | untested |  |
| DP-07 | partial | partial | e2e: no non-resource console errors across all module mounts |
| DP-08 | built | partial | e2e: mount: spec; e2e: Spec module renders the full register; integration: register has no audited row still over-claimed |
| DP-09 | built | partial | unit: SVG sanitiser strips script/handlers/foreignObject/javascript: |
| DP-10 | built | full | e2e: mount: spec; e2e: Beam lists every transport and names the missing primitive on blocked ones; integration: health + bootstrap reconcile the register |
| DP-11 | built | untested |  |
| DP-12 | built | untested |  |
| DP-13 | built | untested |  |
| DP-14 | built | partial | e2e: mount: monitor; integration: FM-03 journaled move: 6 states in order, digest preserved, source retired |

## Definitions

- **Fully built** = register status `built`: runs end to end in this build against real browser/DB APIs.
- **Partially built** = `partial` (a named sub-capability is degraded) or `probe` (runs only where the browser exposes the API).
- **Fully tested** = a passing automated test exercises the row's primary contract end to end at the layer where it lives (pure library / server over HTTP / UI in real headless Chromium 131) including at least one negative or adversarial assertion.
- **Partially tested** = passing tests exercise only part of the row (e.g. the module mounts without error, or only the server half is exercised).
- Mount-only smoke tests tag a module's rows `partial`: rendering without an uncaught error is evidence of integration, not of function.
