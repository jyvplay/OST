# Fusion Shell Web — build / test ledger (generated)

Generated 2026-10-16T04:21:57.246Z by `scripts/ledger.mjs` from the live register (http://localhost:3999) and
15 machine-readable suite result files in `docs/test-results/`. Nothing in the counts is hand-edited.

## Headline

| | Count |
|---|---:|
| **Features in register** | **269** |
| Fully built | 182 |
| Partially built (partial 47 + probe 18) | 65 |
| Not buildable on this platform (blocked, reason rendered in UI) | 22 |
| Not built at all (skeleton) | 0 |
| **Fully tested** (≥1 passing test tagged `full`) | **65** |
| **Partially tested** (only `partial` tags) | **73** |
| Untested | 131 |
| Automated tests executed / passed | 228 / 228 |

## Build × test matrix

| build \ test | fully tested | partially tested | untested |
|---|---:|---:|---:|
| fully built | 55 | 59 | 68 |
| partially built | 4 | 12 | 49 |
| blocked | 6 | 2 | 14 |
| skeleton | 0 | 0 | 0 |

"Blocked + fully tested" means a test asserts that the UI renders the platform-impossibility reason — it
verifies the honesty contract, not the (impossible) capability.

## Suites

| suite | tests | passed | failed | ran at |
|---|---:|---:|---:|---|
| browser-session | 5 | 5 | 0 | 2026-10-16T04:18:05.281Z |
| e2e-browser | 6 | 6 | 0 | 2026-10-16T04:18:45.572Z |
| e2e-image | 10 | 10 | 0 | 2026-10-16T03:58:09.347Z |
| e2e-office | 11 | 11 | 0 | 2026-10-16T03:58:29.829Z |
| e2e-vector | 11 | 11 | 0 | 2026-10-16T04:14:45.349Z |
| e2e | 54 | 54 | 0 | 2026-10-16T04:21:51.815Z |
| image | 12 | 12 | 0 | 2026-10-16T04:18:01.268Z |
| integration | 24 | 24 | 0 | 2026-10-16T04:18:07.142Z |
| office | 35 | 35 | 0 | 2026-10-16T04:17:59.997Z |
| oracle-psd | 8 | 8 | 0 | 2026-10-16T04:18:04.234Z |
| oracle-svg | 4 | 4 | 0 | 2026-10-16T04:18:05.127Z |
| oracle-xlsx | 3 | 3 | 0 | 2026-10-16T04:18:00.906Z |
| oracle | 5 | 5 | 0 | 2026-10-16T04:17:59.601Z |
| unit | 22 | 22 | 0 | 2026-10-16T04:17:59.239Z |
| vector | 18 | 18 | 0 | 2026-10-16T04:18:04.461Z |

## Rows touched by failing tests

None.

## By family

| family | rows | built | partial+probe | blocked | fully tested | partially tested | untested |
|---|---:|---:|---:|---:|---:|---:|---:|
| SH | 14 | 13 | 1 | 0 | 2 | 2 | 10 |
| WM | 19 | 15 | 3 | 1 | 3 | 4 | 12 |
| IN | 8 | 5 | 3 | 0 | 1 | 1 | 6 |
| SR | 8 | 7 | 0 | 1 | 3 | 3 | 2 |
| FM | 18 | 15 | 2 | 1 | 5 | 3 | 10 |
| NC | 6 | 6 | 0 | 0 | 0 | 3 | 3 |
| ST | 9 | 6 | 2 | 1 | 0 | 3 | 6 |
| AP | 5 | 2 | 2 | 1 | 0 | 0 | 5 |
| TD | 6 | 3 | 2 | 1 | 3 | 1 | 2 |
| PR | 32 | 21 | 10 | 1 | 13 | 6 | 13 |
| FF | 29 | 19 | 10 | 0 | 20 | 4 | 5 |
| MD | 9 | 6 | 3 | 0 | 0 | 7 | 2 |
| SC | 9 | 7 | 1 | 1 | 1 | 3 | 5 |
| BK | 6 | 5 | 1 | 0 | 2 | 4 | 0 |
| CT | 6 | 4 | 1 | 1 | 1 | 1 | 4 |
| CA | 15 | 6 | 3 | 6 | 6 | 7 | 2 |
| LN | 15 | 8 | 3 | 4 | 1 | 3 | 11 |
| MS | 4 | 0 | 2 | 2 | 0 | 2 | 2 |
| AX | 8 | 6 | 2 | 0 | 0 | 4 | 4 |
| AU | 4 | 2 | 2 | 0 | 1 | 1 | 2 |
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
| SH-08 | built | full | e2e: drag a window by its title bar; geometry is committed and persisted; integration: SH-08 stale revision cannot clobber newer desktop state (409); unit: command log replay reproduces the identical state hash |
| SH-09 | built | untested |  |
| SH-10 | partial | partial | e2e: Overview (Meta+Q) and Blackout overlay toggle |
| SH-11 | built | untested |  |
| SH-12 | built | untested |  |
| SH-13 | built | untested |  |
| SH-14 | built | full | e2e: offline write is queued, then replayed through the journal when back online |
| WM-01 | built | full | e2e: drag a window by its title bar; geometry is committed and persisted; unit: 10 000 random commands preserve every invariant |
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
| FM-01 | built | partial | e2e: mount: files; e2e: Files upload of a 1 MiB binary succeeds (stack-overflow base64 fix) |
| FM-02 | built | untested |  |
| FM-03 | built | full | e2e: mount: files; e2e: Files upload of a 1 MiB binary succeeds (stack-overflow base64 fix); integration: FM-03 journaled move: 6 states in order, digest preserved, source retired (+2) |
| FM-04 | built | partial | e2e: mount: peek; integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades |
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
| PR-05 | probe | untested |  |
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
| FF-03 | partial | untested |  |
| FF-04 | partial | full | e2e-vector: UI: hostile SVG via Files deep link — report lists drops, no script/handler executes, canvas holds only allowlisted markup; e2e: mount: vector; unit: SVG sanitiser strips script/handlers/foreignObject/javascript: (+1) |
| FF-05 | built | untested |  |
| FF-06 | probe | untested |  |
| FF-07 | partial | untested |  |
| FF-08 | built | full | integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; unit: docx extraction; EPUB spine order; PSD header |
| FF-09 | built | full | unit: CSV RFC-4180 round trip |
| FF-10 | built | full | integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; unit: docx extraction; EPUB spine order; PSD header |
| FF-11 | built | full | e2e: mount: peek; unit: loss report itemises drops; registry grades |
| FF-12 | built | full | integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; integration: FM-05 extract refuses zip-slip and writes nothing; unit: zip-slip and bomb guards fire before allocation |
| FF-13 | partial | untested |  |
| FF-14 | built | full | unit: loss report itemises drops; registry grades |
| FF-15 | built | partial | e2e: mount: editor; e2e: editor: open via terminal, edit, Ctrl+S → saved and a version snapshot exists |
| FF-19 | built | full | e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e: mount: sheet; office: first-party verified semantics survive: SUM(1,"x",2) is still #VALUE! (+7) |
| FF-20 | partial | full | e2e-office: save → reopen keeps styles/widths/charts; export .xlsx → server re-import keeps bold, numFmt, widths; e2e: mount: sheet; office: OOXML future-function prefixes: _xlfn./_xlfn._xlws. added on write, stripped on read, strings safe (+2) |
| FF-21 | partial | full | e2e-office: save → reopen keeps styles/widths/charts; export .xlsx → server re-import keeps bold, numFmt, widths; e2e: mount: sheet; oracle-xlsx: B. openpyxl-authored file → our reader: styles, widths, freeze, shared formulas, _xlfn strip, array children don't block |
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
| BK-06 | built | partial | unit: seal/open round trip; wrong passphrase and ciphertext tamper fail |
| FF-26 | built | full | e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e: mount: sheet; office: SEQUENCE(2,3) spills all six cells with correct values (+13) |
| FF-27 | built | full | e2e: mount: sheet; office: FILTER with a broadcast boolean condition, SORT, UNIQUE, XLOOKUP; office: first-party verified semantics survive: SUM(1,"x",2) is still #VALUE! (+6) |
| FF-28 | built | full | e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e-office: autocomplete (Tab inserts NAME( ), point-mode click inserts a reference, Enter commits and recalculates; e2e-office: drag-select a range → status bar Sum/Count; Ctrl+A selects current region (+27) |
| FF-29 | partial | full | e2e-office: charts panel renders SVG chart images (bar → pie) from a dynamic-array source; e2e: mount: sheet; office: charts: series from columns with header names, gaps for text, nice ticks, SVG escaping, error on no data (+2) |
| FF-30 | built | full | e2e-image: ORACLE: our compositor vs Chromium/Skia globalCompositeOperation — 12 blend modes, opaque and translucent backdrops; e2e-image: new doc renders; brush drag paints a continuous line in the foreground colour; undo/redo; e2e-image: layers: new layer, paint, blend=multiply changes composite, opacity, visibility toggle, reorder, merge (+23) |
| FF-31 | built | full | e2e-image: Save PSD → VFS file decodes with our reader (layers/blend/mask) → deep-link reopen restores layers and pixels; e2e: mount: imageedit; image: PackBits: Apple TN1023 vector decodes; encoder round-trips random/edge data and is ≤ TN1023 size (+9) |
| FF-32 | built | full | e2e-vector: ORACLE Chromium SVG: getBBox + getTotalLength of the ORIGINAL d vs our normalised cubics (arcs included); e2e-vector: ORACLE Chromium SVG: isPointInFill (nonzero + evenodd) vs our containment on a 31×31 grid per path; transform.baseVal; e2e-vector: ORACLE render parity: Chromium rasterises the original SVG and our import→export identically (≤0.5% pixels > 24/255) (+31) |
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
| AX-01 | built | partial | e2e: structural a11y: every window is a named dialog; no unnamed buttons |
| AX-02 | built | partial | e2e: structural a11y: every window is a named dialog; no unnamed buttons |
| AX-03 | built | untested |  |
| AX-04 | built | untested |  |
| AX-05 | built | partial | e2e: keyboard tiling: Meta+ArrowLeft snaps the focused window to the left half |
| AX-06 | probe | untested |  |
| AX-07 | built | partial | unit: SRT → WebVTT conversion |
| AX-08 | partial | untested |  |
| AU-01 | built | full | e2e: mount: routines; e2e: routines: dry-run lists actions without executing; Run opens the window; integration: AU-01 routine whitelist rejects commands outside the palette vocabulary (+1) |
| AU-02 | built | partial | e2e: mount: routines; integration: AU-02 presets list and delete; non-prefixed rows cannot be deleted |
| AU-03 | partial | untested |  |
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
