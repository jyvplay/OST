# Fusion Shell Web — build / test ledger (generated)

Generated 2026-11-10T08:06:24.650Z by `scripts/ledger.mjs` from the live register (http://localhost:4000) and
468 machine-readable suite result files in `docs/test-results/`. Nothing in the counts is hand-edited.
These files span different runs and dates: this is a historical aggregate, **not** a claim that all suites were rerun today.
Each suite file is overwritten on a full rerun, so this is the latest saved result per suite, not a history of every attempt.
Register statuses and test tags are authored claims, not independent proof that the canonical specification is implemented.
See each suite timestamp and the latest turn report for current tests, known classification errors and earlier failures.

## Headline

| | Count |
|---|---:|
| **Features in register** | **674** |
| Fully built | 649 |
| Partially built (partial 5 + probe 0) | 5 |
| Not buildable on this platform (blocked, reason rendered in UI) | 20 |
| Not built at all (skeleton) | 0 |
| **Fully tested** (≥1 passing `full` tag; incomplete rows capped) | **598** |
| **Partially tested** (partial tags or an incomplete row with passing evidence) | **64** |
| Untested | 12 |
| Recorded test cases / passed (mixed run dates) | 4512 / 4501 |

## Build × test matrix

| build \ test | fully tested | partially tested | untested |
|---|---:|---:|---:|
| fully built | 593 | 51 | 5 |
| partially built | 0 | 5 | 0 |
| blocked | 5 | 8 | 7 |
| skeleton | 0 | 0 | 0 |

"Blocked + fully tested" means a test asserts that the UI renders the platform-impossibility reason — it
verifies the honesty contract, not the (impossible) capability.

## Suites

| suite | tests | passed | failed | ran at |
|---|---:|---:|---:|---|
| a11y-unit | 12 | 12 | 0 | 2026-11-10T07:23:40.157Z |
| ai-format | 5 | 5 | 0 | 2026-11-10T07:23:47.270Z |
| browser-session | 5 | 5 | 0 | 2026-10-30T17:48:48.358Z |
| contacts-engine | 8 | 8 | 0 | 2026-11-10T07:23:44.488Z |
| e2e-a11y | 9 | 9 | 0 | 2026-11-10T07:52:00.568Z |
| e2e-ai | 6 | 6 | 0 | 2026-10-25T22:19:39.720Z |
| e2e-beauty | 6 | 6 | 0 | 2026-10-26T12:15:43.541Z |
| e2e-browser | 6 | 6 | 0 | 2026-10-30T17:55:03.660Z |
| e2e-contacts | 9 | 9 | 0 | 2026-10-25T22:20:01.143Z |
| e2e-image | 11 | 11 | 0 | 2026-10-31T05:14:55.173Z |
| e2e-layout | 12 | 12 | 0 | 2026-11-10T07:26:00.449Z |
| e2e-media27 | 7 | 7 | 0 | 2026-10-25T22:23:42.055Z |
| e2e-office | 11 | 11 | 0 | 2026-11-10T07:34:24.320Z |
| e2e-privacy | 16 | 16 | 0 | 2026-10-31T05:40:42.112Z |
| e2e-sheet-layout | 7 | 7 | 0 | 2026-11-10T07:35:10.384Z |
| e2e-tables | 8 | 8 | 0 | 2026-10-26T13:12:19.850Z |
| e2e-tabletop | 15 | 15 | 0 | 2026-10-27T21:16:03.541Z |
| e2e-tt100-recall | 27 | 27 | 0 | 2026-10-29T19:41:23.175Z |
| e2e-tt101-search | 9 | 9 | 0 | 2026-10-29T19:36:30.952Z |
| e2e-tt102 | 16 | 16 | 0 | 2026-10-29T19:35:50.643Z |
| e2e-tt103-memory | 11 | 11 | 0 | 2026-10-29T19:35:33.319Z |
| e2e-tt104-memory | 10 | 10 | 0 | 2026-10-29T19:35:03.651Z |
| e2e-tt104-pages | 3 | 3 | 0 | 2026-10-29T19:35:13.017Z |
| e2e-tt105-clicked | 7 | 7 | 0 | 2026-10-29T19:34:44.855Z |
| e2e-tt106-memory | 8 | 8 | 0 | 2026-10-29T19:34:33.147Z |
| e2e-tt107-memory | 6 | 6 | 0 | 2026-10-29T19:46:27.851Z |
| e2e-tt107-shell | 7 | 7 | 0 | 2026-10-29T19:46:19.101Z |
| e2e-tt108-recall | 6 | 6 | 0 | 2026-10-29T19:46:55.056Z |
| e2e-tt108-shell | 7 | 7 | 0 | 2026-10-29T19:47:37.691Z |
| e2e-tt109-shell | 5 | 5 | 0 | 2026-10-29T19:48:49.912Z |
| e2e-tt110-banner | 5 | 5 | 0 | 2026-10-29T19:49:51.635Z |
| e2e-tt110-recall | 6 | 6 | 0 | 2026-10-29T19:49:08.584Z |
| e2e-tt110-shell | 4 | 4 | 0 | 2026-10-29T19:49:26.163Z |
| e2e-tt111-recall | 3 | 3 | 0 | 2026-10-29T23:57:33.413Z |
| e2e-tt112-resident | 7 | 7 | 0 | 2026-10-29T19:51:34.600Z |
| e2e-tt112-shell | 7 | 7 | 0 | 2026-10-29T19:52:46.635Z |
| e2e-tt113-density | 6 | 6 | 0 | 2026-10-29T19:53:11.606Z |
| e2e-tt114-density | 6 | 6 | 0 | 2026-10-29T19:54:04.033Z |
| e2e-tt114-shell | 9 | 9 | 0 | 2026-10-29T19:53:33.210Z |
| e2e-tt114-tabs | 5 | 5 | 0 | 2026-10-29T23:45:00.924Z |
| e2e-tt117 | 5 | 5 | 0 | 2026-11-10T07:46:04.972Z |
| e2e-tt118 | 5 | 5 | 0 | 2026-10-30T00:30:35.025Z |
| e2e-tt119 | 4 | 4 | 0 | 2026-11-10T07:45:45.367Z |
| e2e-tt120 | 4 | 4 | 0 | 2026-11-10T07:45:20.863Z |
| e2e-tt121 | 4 | 4 | 0 | 2026-11-10T07:45:01.419Z |
| e2e-tt122 | 3 | 3 | 0 | 2026-11-10T07:44:31.924Z |
| e2e-tt123 | 3 | 3 | 0 | 2026-11-10T07:44:06.063Z |
| e2e-tt124 | 4 | 4 | 0 | 2026-11-10T07:41:54.826Z |
| e2e-tt125 | 3 | 3 | 0 | 2026-11-10T07:42:43.553Z |
| e2e-tt126 | 4 | 4 | 0 | 2026-11-10T07:42:57.719Z |
| e2e-tt127-photos | 1 | 1 | 0 | 2026-11-10T07:43:23.376Z |
| e2e-tt127-vault | 3 | 3 | 0 | 2026-11-10T07:43:17.380Z |
| e2e-tt128-editor | 4 | 4 | 0 | 2026-11-10T07:41:16.113Z |
| e2e-tt128-photos | 11 | 11 | 0 | 2026-11-10T07:41:00.664Z |
| e2e-tt128-time | 2 | 2 | 0 | 2026-11-10T07:41:09.616Z |
| e2e-tt128-worker | 4 | 4 | 0 | 2026-11-10T07:40:16.588Z |
| e2e-tt129-calendar | 3 | 3 | 0 | 2026-11-10T07:40:07.144Z |
| e2e-tt129-offline | 4 | 4 | 0 | 2026-11-10T07:40:00.408Z |
| e2e-tt130-alarms | 9 | 9 | 0 | 2026-11-10T07:39:38.381Z |
| e2e-tt130-privacy | 1 | 1 | 0 | 2026-11-10T07:39:00.968Z |
| e2e-tt131-image-viewport | 10 | 10 | 0 | 2026-11-10T07:38:57.307Z |
| e2e-tt132-alarms | 13 | 13 | 0 | 2026-11-10T07:37:51.366Z |
| e2e-tt132-planner | 17 | 17 | 0 | 2026-11-10T07:38:50.457Z |
| e2e-tt133-boundaries | 7 | 7 | 0 | 2026-11-10T07:32:09.190Z |
| e2e-tt133-notes-find | 27 | 27 | 0 | 2026-11-10T07:31:46.611Z |
| e2e-tt133-openssh | 7 | 7 | 0 | 2026-11-02T00:17:19.134Z |
| e2e-tt134-ownership | 6 | 6 | 0 | 2026-11-10T07:32:40.455Z |
| e2e-tt134-workflows-clipboard | 11 | 11 | 0 | 2026-11-10T07:29:40.507Z |
| e2e-tt134-workflows-find | 10 | 10 | 0 | 2026-11-10T07:30:18.510Z |
| e2e-tt134-workflows-notes | 13 | 13 | 0 | 2026-11-10T07:29:00.816Z |
| e2e-tt146 | 5 | 4 | 1 | 2026-11-10T07:52:58.619Z |
| e2e-tt147 | 6 | 6 | 0 | 2026-11-10T08:05:42.738Z |
| e2e-tt148 | 4 | 4 | 0 | 2026-11-10T07:54:16.733Z |
| e2e-tt151 | 2 | 2 | 0 | 2026-11-10T07:26:31.668Z |
| e2e-tt152-boot | 1 | 1 | 0 | 2026-11-08T06:47:44.086Z |
| e2e-tt154-recovery | 1 | 1 | 0 | 2026-11-10T07:26:19.675Z |
| e2e-tt155-files | 1 | 1 | 0 | 2026-11-10T07:26:04.717Z |
| e2e-tt155-window-fit | 2 | 2 | 0 | 2026-11-10T07:26:14.907Z |
| e2e-tt156-monitor | 1 | 1 | 0 | 2026-11-10T07:24:19.281Z |
| e2e-tt157-routines | 2 | 2 | 0 | 2026-11-10T07:24:12.857Z |
| e2e-tt158-planner | 1 | 1 | 0 | 2026-11-10T07:24:06.030Z |
| e2e-tt28 | 7 | 7 | 0 | 2026-10-25T22:24:18.083Z |
| e2e-tt29 | 4 | 4 | 0 | 2026-10-26T12:12:00.498Z |
| e2e-tt30 | 6 | 6 | 0 | 2026-10-25T22:26:37.267Z |
| e2e-tt31 | 10 | 10 | 0 | 2026-10-25T22:27:55.111Z |
| e2e-tt32 | 6 | 6 | 0 | 2026-10-25T22:31:14.935Z |
| e2e-tt33 | 4 | 4 | 0 | 2026-10-25T22:31:27.284Z |
| e2e-tt34 | 5 | 5 | 0 | 2026-10-25T22:32:28.251Z |
| e2e-tt35 | 7 | 7 | 0 | 2026-10-28T20:02:50.215Z |
| e2e-tt36 | 3 | 3 | 0 | 2026-10-25T22:33:16.751Z |
| e2e-tt37 | 5 | 5 | 0 | 2026-10-28T20:03:10.015Z |
| e2e-tt38 | 7 | 7 | 0 | 2026-10-25T22:37:21.872Z |
| e2e-tt39 | 7 | 7 | 0 | 2026-10-25T22:37:40.816Z |
| e2e-tt40 | 3 | 3 | 0 | 2026-10-25T22:37:53.787Z |
| e2e-tt41 | 4 | 4 | 0 | 2026-10-25T22:37:57.478Z |
| e2e-tt42 | 3 | 3 | 0 | 2026-10-25T22:38:08.475Z |
| e2e-tt43 | 3 | 3 | 0 | 2026-10-25T22:38:18.452Z |
| e2e-tt44 | 5 | 5 | 0 | 2026-10-25T22:39:02.847Z |
| e2e-tt45 | 2 | 2 | 0 | 2026-10-25T22:39:12.248Z |
| e2e-tt46 | 8 | 8 | 0 | 2026-10-25T22:40:17.461Z |
| e2e-tt47 | 5 | 5 | 0 | 2026-10-25T22:48:18.928Z |
| e2e-tt48-sync | 4 | 4 | 0 | 2026-10-25T22:49:07.022Z |
| e2e-tt48 | 6 | 6 | 0 | 2026-10-25T22:48:59.174Z |
| e2e-tt49-writer | 6 | 6 | 0 | 2026-11-10T08:06:19.496Z |
| e2e-tt49 | 5 | 5 | 0 | 2026-10-25T22:49:43.811Z |
| e2e-tt50-charts | 5 | 5 | 0 | 2026-10-26T13:09:52.094Z |
| e2e-tt51-slides | 6 | 6 | 0 | 2026-10-26T15:55:38.896Z |
| e2e-tt52-pdf | 8 | 8 | 0 | 2026-10-26T11:53:35.201Z |
| e2e-tt53-media | 6 | 6 | 0 | 2026-10-25T22:54:02.467Z |
| e2e-tt54 | 8 | 8 | 0 | 2026-10-27T20:37:22.269Z |
| e2e-tt55-files | 14 | 14 | 0 | 2026-10-29T19:37:48.226Z |
| e2e-tt55-shell | 3 | 3 | 0 | 2026-10-29T19:38:02.347Z |
| e2e-tt56-rows | 7 | 7 | 0 | 2026-10-25T22:56:48.364Z |
| e2e-tt56 | 10 | 10 | 0 | 2026-10-25T22:56:31.173Z |
| e2e-tt57-rows | 4 | 4 | 0 | 2026-10-25T22:58:21.446Z |
| e2e-tt57 | 3 | 3 | 0 | 2026-10-25T22:57:54.986Z |
| e2e-tt58-rows | 3 | 3 | 0 | 2026-10-27T23:09:39.196Z |
| e2e-tt58 | 3 | 3 | 0 | 2026-10-25T22:59:03.915Z |
| e2e-tt59 | 4 | 4 | 0 | 2026-10-25T23:01:05.251Z |
| e2e-tt60 | 5 | 5 | 0 | 2026-10-27T07:24:43.224Z |
| e2e-tt61 | 4 | 4 | 0 | 2026-10-25T23:02:34.079Z |
| e2e-tt62 | 3 | 3 | 0 | 2026-10-25T23:02:40.962Z |
| e2e-tt63 | 2 | 2 | 0 | 2026-10-25T23:03:03.639Z |
| e2e-tt64 | 3 | 3 | 0 | 2026-10-25T23:03:54.083Z |
| e2e-tt65 | 2 | 2 | 0 | 2026-10-25T23:04:36.945Z |
| e2e-tt66-input | 4 | 4 | 0 | 2026-10-25T23:05:07.250Z |
| e2e-tt66 | 3 | 3 | 0 | 2026-10-25T23:04:53.733Z |
| e2e-tt67-input | 5 | 5 | 0 | 2026-10-27T21:17:46.574Z |
| e2e-tt68-sheet | 3 | 3 | 0 | 2026-10-25T23:09:33.883Z |
| e2e-tt69-lifecycle | 6 | 6 | 0 | 2026-11-10T07:27:21.568Z |
| e2e-tt70-closeall | 3 | 3 | 0 | 2026-10-25T23:11:22.407Z |
| e2e-tt70-rows | 3 | 3 | 0 | 2026-10-25T23:15:35.730Z |
| e2e-tt70-seal | 2 | 2 | 0 | 2026-11-10T07:27:59.176Z |
| e2e-tt71-focus | 4 | 4 | 0 | 2026-10-25T23:15:45.675Z |
| e2e-tt72-access | 4 | 4 | 0 | 2026-10-25T23:17:42.237Z |
| e2e-tt72-pad | 5 | 5 | 0 | 2026-10-25T23:17:23.026Z |
| e2e-tt73-writer | 4 | 4 | 0 | 2026-11-10T07:36:46.015Z |
| e2e-tt74-office | 6 | 6 | 0 | 2026-10-25T23:22:40.553Z |
| e2e-tt75-books | 16 | 16 | 0 | 2026-10-25T23:26:09.598Z |
| e2e-tt76-sheet | 6 | 6 | 0 | 2026-10-25T23:26:23.466Z |
| e2e-tt76-slides | 7 | 7 | 0 | 2026-10-25T23:27:11.022Z |
| e2e-tt77-pdfsig | 7 | 7 | 0 | 2026-10-26T16:01:56.377Z |
| e2e-tt78-sheet | 3 | 3 | 0 | 2026-10-26T11:55:23.062Z |
| e2e-tt79-archive | 7 | 7 | 0 | 2026-10-26T13:07:47.830Z |
| e2e-tt79-pdf | 5 | 5 | 0 | 2026-10-26T15:55:00.602Z |
| e2e-tt81 | 7 | 7 | 0 | 2026-11-10T07:36:26.329Z |
| e2e-tt85 | 3 | 3 | 0 | 2026-10-27T07:26:10.093Z |
| e2e-tt86-pointer | 6 | 6 | 0 | 2026-11-09T07:55:39.307Z |
| e2e-tt87-backup | 6 | 6 | 0 | 2026-10-27T21:23:53.015Z |
| e2e-tt87-localdisk | 5 | 5 | 0 | 2026-10-27T21:23:58.752Z |
| e2e-tt87-pointer-fallback | 6 | 6 | 0 | 2026-10-27T21:23:42.054Z |
| e2e-tt87-privacy | 3 | 3 | 0 | 2026-10-27T21:24:02.179Z |
| e2e-tt88-recovery | 6 | 6 | 0 | 2026-10-27T21:24:11.125Z |
| e2e-tt89-drill | 9 | 9 | 0 | 2026-10-27T21:24:23.762Z |
| e2e-tt89-launch | 9 | 9 | 0 | 2026-10-27T21:24:35.265Z |
| e2e-tt90-context | 8 | 8 | 0 | 2026-10-27T21:25:00.466Z |
| e2e-tt90-private-thumbnails | 5 | 5 | 0 | 2026-10-27T20:36:16.507Z |
| e2e-tt90-thumbnails | 5 | 5 | 0 | 2026-10-27T20:36:03.583Z |
| e2e-tt91-browser-download | 7 | 7 | 0 | 2026-10-27T23:10:45.317Z |
| e2e-tt91-purge | 2 | 2 | 0 | 2026-10-27T20:36:24.319Z |
| e2e-tt92-trash | 2 | 2 | 0 | 2026-10-29T19:34:51.615Z |
| e2e-tt93-photos-clear | 7 | 7 | 0 | 2026-10-27T20:37:50.073Z |
| e2e-tt93-sidecar | 2 | 2 | 0 | 2026-10-27T20:37:30.391Z |
| e2e-tt94-offline-race | 3 | 3 | 0 | 2026-10-27T20:38:34.566Z |
| e2e-tt94-photo-stale | 2 | 2 | 0 | 2026-10-27T20:37:59.357Z |
| e2e-tt94-photos-offline | 6 | 6 | 0 | 2026-10-27T20:38:18.378Z |
| e2e-tt95-a11y-settings-race | 1 | 1 | 0 | 2026-10-27T20:39:19.823Z |
| e2e-tt95-photo-concurrency | 7 | 7 | 0 | 2026-10-27T20:39:13.515Z |
| e2e-tt96-calculator | 9 | 9 | 0 | 2026-10-27T23:25:08.856Z |
| e2e-tt96-desktop-menu | 5 | 5 | 0 | 2026-10-29T19:38:13.936Z |
| e2e-tt96-files-contrast | 5 | 5 | 0 | 2026-10-27T23:25:54.025Z |
| e2e-tt97-calculator-repairs | 7 | 7 | 0 | 2026-10-28T02:01:11.124Z |
| e2e-tt97-files-empty-a11y | 3 | 3 | 0 | 2026-10-29T19:38:40.207Z |
| e2e-tt97-palette-actions | 11 | 11 | 0 | 2026-10-29T19:38:36.272Z |
| e2e-tt98-orbit | 22 | 22 | 0 | 2026-10-29T19:38:55.599Z |
| e2e-tt99-interactions | 29 | 29 | 0 | 2026-10-29T19:39:41.331Z |
| e2e-vector | 12 | 12 | 0 | 2026-11-10T07:35:47.341Z |
| e2e-whiteboard | 7 | 7 | 0 | 2026-10-26T13:08:34.110Z |
| e2e | 68 | 68 | 0 | 2026-10-30T17:51:32.119Z |
| image | 16 | 16 | 0 | 2026-11-10T07:23:45.025Z |
| integration | 25 | 25 | 0 | 2026-11-10T07:33:35.744Z |
| layout-unit | 8 | 8 | 0 | 2026-11-10T07:23:40.507Z |
| maps-unit | 6 | 6 | 0 | 2026-11-10T07:23:47.621Z |
| metaclean | 6 | 6 | 0 | 2026-10-30T17:48:56.803Z |
| names | 7 | 7 | 0 | 2026-10-30T17:48:41.792Z |
| office | 35 | 35 | 0 | 2026-10-30T17:48:35.700Z |
| oracle-ai | 3 | 3 | 0 | 2026-11-07T05:39:40.866Z |
| oracle-psd | 11 | 11 | 0 | 2026-10-30T17:48:46.148Z |
| oracle-svg | 4 | 4 | 0 | 2026-10-30T17:48:48.151Z |
| oracle-vcard | 3 | 3 | 0 | 2026-10-30T17:49:01.297Z |
| oracle-xlsx | 5 | 5 | 0 | 2026-10-30T17:48:37.686Z |
| oracle | 5 | 5 | 0 | 2026-10-30T17:48:36.208Z |
| privacy-backup | 7 | 7 | 0 | 2026-10-27T20:39:53.048Z |
| privacy-crypto | 9 | 9 | 0 | 2026-10-31T05:40:17.723Z |
| privacy-layer | 13 | 13 | 0 | 2026-10-31T05:40:43.737Z |
| sheet-layout | 6 | 6 | 0 | 2026-10-30T17:48:38.199Z |
| stream-unit | 7 | 7 | 0 | 2026-11-10T07:23:43.545Z |
| tables-engine | 9 | 9 | 0 | 2026-11-09T06:55:15.381Z |
| tabletop-unit | 17 | 17 | 0 | 2026-11-10T07:23:44.067Z |
| tt101-search | 37 | 37 | 0 | 2026-10-29T19:36:23.826Z |
| tt102-private-bound | 5 | 5 | 0 | 2026-10-29T19:36:21.550Z |
| tt102-search | 33 | 33 | 0 | 2026-10-29T19:35:51.689Z |
| tt103-framework | 5 | 5 | 0 | 2026-10-29T19:35:15.110Z |
| tt103-memory-unit | 10 | 10 | 0 | 2026-10-29T19:35:15.287Z |
| tt104-memory-unit | 27 | 27 | 0 | 2026-10-29T19:34:51.812Z |
| tt104-page | 25 | 25 | 0 | 2026-10-29T19:34:52.120Z |
| tt105-atomic | 25 | 25 | 0 | 2026-10-29T19:34:33.675Z |
| tt106-lifecycle | 23 | 23 | 0 | 2026-10-29T19:34:09.386Z |
| tt107-crash | 4 | 4 | 0 | 2026-10-29T19:46:12.094Z |
| tt107-features | 20 | 20 | 0 | 2026-10-29T19:46:13.297Z |
| tt107-recall | 30 | 30 | 0 | 2026-10-29T19:46:12.707Z |
| tt108-engine-crash | 10 | 10 | 0 | 2026-10-29T19:46:42.036Z |
| tt108-recall | 18 | 18 | 0 | 2026-10-29T19:46:42.944Z |
| tt108-refusal | 7 | 7 | 0 | 2026-10-29T19:47:38.634Z |
| tt109-recall | 13 | 13 | 0 | 2026-10-29T19:47:39.728Z |
| tt110-core | 7 | 7 | 0 | 2026-10-29T19:48:50.968Z |
| tt111-core | 11 | 11 | 0 | 2026-10-29T19:51:15.651Z |
| tt111-recall-tap | 7 | 7 | 0 | 2026-10-29T19:51:19.261Z |
| tt114-core | 9 | 9 | 0 | 2026-10-29T19:53:11.828Z |
| tt114-recall-token | 8 | 8 | 0 | 2026-10-29T19:53:12.448Z |
| tt116-density | 6 | 6 | 0 | 2026-11-10T08:04:13.433Z |
| tt116-platform | 9 | 9 | 0 | 2026-10-29T19:54:07.136Z |
| tt116-recall-archive | 8 | 8 | 0 | 2026-10-29T19:54:06.444Z |
| tt116-recall-retention | 7 | 7 | 0 | 2026-10-29T19:54:05.957Z |
| tt116-safesave | 15 | 15 | 0 | 2026-10-31T04:53:31.846Z |
| tt117-core | 12 | 12 | 0 | 2026-11-10T07:23:47.643Z |
| tt117-density | 1 | 1 | 0 | 2026-11-10T08:03:58.801Z |
| tt118-core | 12 | 12 | 0 | 2026-11-10T07:23:48.025Z |
| tt118-density | 1 | 0 | 1 | 2026-11-10T08:03:52.235Z |
| tt119-core | 11 | 11 | 0 | 2026-11-10T07:23:47.943Z |
| tt119-density | 1 | 0 | 1 | 2026-11-10T08:02:19.937Z |
| tt120-core | 10 | 10 | 0 | 2026-11-10T07:45:01.635Z |
| tt120-density | 1 | 0 | 1 | 2026-11-10T08:00:48.060Z |
| tt121-core | 19 | 19 | 0 | 2026-11-10T07:23:48.291Z |
| tt121-density | 1 | 0 | 1 | 2026-11-10T07:59:20.359Z |
| tt122-core | 20 | 20 | 0 | 2026-11-10T07:44:06.295Z |
| tt122-density | 1 | 0 | 1 | 2026-11-10T07:57:47.097Z |
| tt123-core | 18 | 18 | 0 | 2026-11-10T07:23:48.619Z |
| tt123-density | 23 | 21 | 2 | 2026-11-10T07:56:19.307Z |
| tt124-core | 19 | 19 | 0 | 2026-11-10T07:41:16.429Z |
| tt124-density | 23 | 21 | 2 | 2026-11-10T07:55:03.054Z |
| tt125-core | 17 | 17 | 0 | 2026-11-10T07:23:48.958Z |
| tt125-density | 3 | 2 | 1 | 2026-11-10T07:55:38.952Z |
| tt126-regressions | 6 | 6 | 0 | 2026-11-10T07:23:58.154Z |
| tt127-conditional | 3 | 3 | 0 | 2026-11-10T07:42:58.019Z |
| tt128-calendar-race | 1 | 1 | 0 | 2026-11-10T07:40:07.903Z |
| tt128-core | 23 | 23 | 0 | 2026-11-10T07:23:50.108Z |
| tt128-oracle | 5 | 5 | 0 | 2026-10-31T04:47:39.773Z |
| tt128-visual | 47 | 47 | 0 | 2026-10-30T23:13:54.938Z |
| tt128-writer-races | 2 | 2 | 0 | 2026-11-10T07:40:08.415Z |
| tt129-calendar-core | 6 | 6 | 0 | 2026-11-10T07:23:49.847Z |
| tt129-core | 7 | 7 | 0 | 2026-11-10T07:23:49.348Z |
| tt129-worker-unit | 5 | 5 | 0 | 2026-11-10T07:23:49.631Z |
| tt130-alarms-core | 4 | 4 | 0 | 2026-11-10T07:23:50.192Z |
| tt130-privacy-boot | 1 | 1 | 0 | 2026-11-10T07:23:50.488Z |
| tt131-ledger | 5 | 5 | 0 | 2026-11-10T07:38:50.760Z |
| tt132-claim-contract | 3 | 3 | 0 | 2026-11-06T21:20:20.748Z |
| tt132-core | 12 | 12 | 0 | 2026-11-10T07:23:38.486Z |
| tt132-lint-contract | 4 | 4 | 0 | 2026-11-10T07:23:38.930Z |
| tt132-oracles | 5 | 5 | 0 | 2026-11-10T07:36:46.506Z |
| tt132-planner-http | 11 | 11 | 0 | 2026-11-10T07:36:47.210Z |
| tt132-visual | 94 | 94 | 0 | 2026-10-31T07:19:57.468Z |
| tt133-browser-kernels | 8 | 8 | 0 | 2026-11-06T05:04:35.501Z |
| tt133-core | 23 | 23 | 0 | 2026-11-10T07:23:37.868Z |
| tt133-http | 13 | 13 | 0 | 2026-11-10T07:30:23.805Z |
| tt133-projections | 6 | 6 | 0 | 2026-11-10T07:23:38.238Z |
| tt134-icon-review | 5 | 5 | 0 | 2026-11-10T07:32:57.043Z |
| tt134-note-migration | 7 | 7 | 0 | 2026-11-02T00:22:44.722Z |
| tt134-review-repairs | 8 | 8 | 0 | 2026-11-10T08:05:08.377Z |
| tt134-visual | 94 | 94 | 0 | 2026-11-02T00:23:34.190Z |
| tt134-workflows-core | 22 | 22 | 0 | 2026-11-10T07:23:37.239Z |
| tt134-workflows-http | 9 | 9 | 0 | 2026-11-10T07:28:04.396Z |
| tt134-workflows-visual | 94 | 94 | 0 | 2026-11-02T03:43:52.511Z |
| tt135-core-engines | 20 | 20 | 0 | 2026-11-07T05:20:15.281Z |
| tt135-files-engines | 44 | 44 | 0 | 2026-11-09T14:50:02.870Z |
| tt135-system-engines | 48 | 48 | 0 | 2026-11-10T07:23:36.661Z |
| tt135-text-encoding | 14 | 14 | 0 | 2026-11-10T07:23:36.272Z |
| tt137-recall-engines | 31 | 31 | 0 | 2026-11-10T07:23:35.711Z |
| tt137-system-engines | 39 | 39 | 0 | 2026-11-10T07:23:35.940Z |
| tt139-cast-governor | 12 | 12 | 0 | 2026-11-09T06:55:20.540Z |
| tt139-documents | 31 | 31 | 0 | 2026-11-10T07:23:50.934Z |
| tt139-engines | 57 | 57 | 0 | 2026-11-07T16:52:38.901Z |
| tt139-formulas | 43 | 43 | 0 | 2026-11-10T07:23:50.742Z |
| tt139-media | 42 | 42 | 0 | 2026-11-10T07:23:51.405Z |
| tt139-platform | 61 | 61 | 0 | 2026-11-10T07:21:05.139Z |
| tt139-systems | 45 | 45 | 0 | 2026-11-10T07:23:51.155Z |
| tt140-cast-privacy | 24 | 24 | 0 | 2026-11-10T07:23:51.824Z |
| tt140-glyph-geometry | 1 | 1 | 0 | 2026-11-10T07:23:52.783Z |
| tt141-auto-frame | 12 | 12 | 0 | 2026-11-06T21:54:11.058Z |
| tt141-browser | 8 | 8 | 0 | 2026-11-10T07:22:02.972Z |
| tt141-gamepad-pointer | 11 | 11 | 0 | 2026-11-10T07:23:52.008Z |
| tt142-a11y-gate | 9 | 9 | 0 | 2026-11-09T14:50:20.697Z |
| tt142-browser | 7 | 7 | 0 | 2026-11-07T04:37:03.525Z |
| tt142-input-scan | 16 | 16 | 0 | 2026-11-10T07:23:53.495Z |
| tt142-platform | 6 | 6 | 0 | 2026-11-07T05:25:36.877Z |
| tt142-share-gate | 13 | 13 | 0 | 2026-11-07T05:27:13.622Z |
| tt142-voice-gate | 9 | 9 | 0 | 2026-11-10T07:23:53.279Z |
| tt143-engines | 20 | 20 | 0 | 2026-11-09T07:35:38.638Z |
| tt143-safe-save | 9 | 9 | 0 | 2026-11-10T07:23:53.886Z |
| tt145-engines | 22 | 22 | 0 | 2026-11-07T05:39:43.525Z |
| tt145-register | 4 | 4 | 0 | 2026-11-07T09:12:50.118Z |
| tt146-core | 22 | 22 | 0 | 2026-11-10T07:23:54.111Z |
| tt146-http | 4 | 4 | 0 | 2026-11-10T07:52:01.130Z |
| tt146-net-quality | 9 | 9 | 0 | 2026-11-10T07:23:54.194Z |
| tt146-oracle | 3 | 3 | 0 | 2026-11-10T07:23:54.841Z |
| tt147-core | 10 | 10 | 0 | 2026-11-10T07:23:54.534Z |
| tt148-core | 7 | 7 | 0 | 2026-11-10T07:23:54.877Z |
| tt149-calc | 6 | 6 | 0 | 2026-11-07T09:39:36.073Z |
| tt151-qr | 6 | 6 | 0 | 2026-11-10T07:23:39.687Z |
| tt151-time | 11 | 11 | 0 | 2026-11-10T07:23:35.479Z |
| tt155-window-fit | 2 | 2 | 0 | 2026-11-10T07:23:34.914Z |
| tt157-routine-triggers | 1 | 1 | 0 | 2026-11-09T14:47:30.429Z |
| tt158-entry-token | 1 | 1 | 0 | 2026-11-10T07:23:15.961Z |
| tt28-unit | 5 | 5 | 0 | 2026-10-30T17:49:09.360Z |
| tt29-unit | 4 | 4 | 0 | 2026-10-30T17:49:10.295Z |
| tt30-unit | 7 | 7 | 0 | 2026-10-26T19:56:55.105Z |
| tt31-unit | 8 | 8 | 0 | 2026-10-26T19:56:55.323Z |
| tt32-voice | 7 | 7 | 0 | 2026-10-25T22:28:08.823Z |
| tt33-unit | 7 | 7 | 0 | 2026-10-26T19:56:55.502Z |
| tt34-unit | 12 | 12 | 0 | 2026-10-25T22:31:31.121Z |
| tt35-unit | 13 | 13 | 0 | 2026-10-28T20:02:11.650Z |
| tt36-unit | 5 | 5 | 0 | 2026-10-25T22:33:04.447Z |
| tt37-unit | 9 | 9 | 0 | 2026-10-25T22:33:21.066Z |
| tt38-unit | 15 | 15 | 0 | 2026-10-27T00:31:21.911Z |
| tt39-pac | 8 | 8 | 0 | 2026-10-25T22:37:37.687Z |
| tt39-unit | 13 | 13 | 0 | 2026-10-25T22:37:23.323Z |
| tt40-proxy | 4 | 4 | 0 | 2026-10-25T22:37:50.428Z |
| tt40-unit | 17 | 17 | 0 | 2026-10-25T22:37:42.763Z |
| tt41-unit | 9 | 9 | 0 | 2026-11-06T21:24:22.417Z |
| tt42-dhcp | 2 | 2 | 0 | 2026-10-25T22:38:05.727Z |
| tt42-proxy | 2 | 2 | 0 | 2026-10-25T22:38:00.122Z |
| tt42-unit | 6 | 6 | 0 | 2026-10-25T22:37:57.836Z |
| tt43-unit | 7 | 7 | 0 | 2026-10-26T19:56:55.801Z |
| tt44-bridge | 8 | 8 | 0 | 2026-10-28T20:02:14.746Z |
| tt44-unit | 18 | 18 | 0 | 2026-10-25T22:38:31.278Z |
| tt44-vt | 12 | 12 | 0 | 2026-10-25T22:38:45.767Z |
| tt45-unit | 10 | 10 | 0 | 2026-10-25T22:39:05.465Z |
| tt46-writer | 12 | 12 | 0 | 2026-10-25T22:39:54.670Z |
| tt46-xlsx-patch | 8 | 8 | 0 | 2026-10-26T08:07:43.125Z |
| tt47-crypto | 5 | 5 | 0 | 2026-10-25T22:47:54.686Z |
| tt47-sheet | 8 | 8 | 0 | 2026-10-26T07:52:30.136Z |
| tt48-office | 6 | 6 | 0 | 2026-10-26T07:52:44.957Z |
| tt49-sheet | 10 | 10 | 0 | 2026-10-26T07:53:13.615Z |
| tt49-writer | 9 | 9 | 0 | 2026-10-25T22:50:37.186Z |
| tt50-charts | 10 | 10 | 0 | 2026-10-25T22:51:10.860Z |
| tt51-slides | 15 | 15 | 0 | 2026-10-25T22:52:22.940Z |
| tt52-pdf | 28 | 28 | 0 | 2026-10-25T22:52:51.701Z |
| tt53-media | 11 | 11 | 0 | 2026-10-25T22:53:46.642Z |
| tt54-meta | 6 | 6 | 0 | 2026-10-25T22:54:14.390Z |
| tt55-files-unit | 7 | 7 | 0 | 2026-10-29T19:36:45.171Z |
| tt56-sheet-paste | 4 | 4 | 0 | 2026-10-26T19:56:57.046Z |
| tt56-shell-unit | 4 | 4 | 0 | 2026-10-26T19:56:56.670Z |
| tt56-writer-track | 6 | 6 | 0 | 2026-10-25T22:55:59.908Z |
| tt57-sheet-links | 6 | 6 | 0 | 2026-10-26T08:12:03.882Z |
| tt57-units | 2 | 2 | 0 | 2026-10-26T19:56:57.171Z |
| tt57-writer-fmt | 5 | 5 | 0 | 2026-10-25T22:57:01.751Z |
| tt57-writer-para | 5 | 5 | 0 | 2026-10-25T22:57:33.387Z |
| tt58-sheet-pivot | 5 | 5 | 0 | 2026-10-26T08:12:09.379Z |
| tt58-writer-notes | 5 | 5 | 0 | 2026-10-25T22:58:43.924Z |
| tt59-raster | 5 | 5 | 0 | 2026-10-25T23:00:40.941Z |
| tt59-sheet-paste | 3 | 3 | 0 | 2026-10-25T23:00:37.383Z |
| tt59-sheet-spell | 5 | 5 | 0 | 2026-10-25T23:00:36.665Z |
| tt59-writer-spell | 8 | 8 | 0 | 2026-10-25T23:00:34.184Z |
| tt59-x14-cf | 3 | 3 | 0 | 2026-10-25T23:00:38.664Z |
| tt60-sheet-spell-all | 2 | 2 | 0 | 2026-10-25T23:01:11.182Z |
| tt60-units | 2 | 2 | 0 | 2026-10-26T19:56:57.298Z |
| tt60-writer-spell-stories | 3 | 3 | 0 | 2026-10-25T23:01:12.178Z |
| tt60-writer-tblrev | 7 | 7 | 0 | 2026-10-25T23:01:10.294Z |
| tt61-sheet-pivot-delete | 1 | 1 | 0 | 2026-10-25T23:02:24.275Z |
| tt61-writer-cellrev | 4 | 4 | 0 | 2026-10-25T23:01:56.494Z |
| tt61-writer-notes-rich | 7 | 7 | 0 | 2026-10-25T23:01:52.986Z |
| tt62-sheet-schema | 5 | 5 | 0 | 2026-10-25T23:02:20.086Z |
| tt62-writer-cellmerge | 4 | 4 | 0 | 2026-10-25T23:02:23.255Z |
| tt62-writer-schema | 5 | 5 | 0 | 2026-10-25T23:02:18.043Z |
| tt63-sheet-pivotparts | 10 | 10 | 0 | 2026-10-25T23:02:54.183Z |
| tt64-writer-trackcols | 6 | 6 | 0 | 2026-10-25T23:03:44.235Z |
| tt65-writer-stories | 8 | 8 | 0 | 2026-10-25T23:04:29.920Z |
| tt66-input | 2 | 2 | 0 | 2026-10-26T19:56:57.441Z |
| tt66-sheet-x14-patch | 9 | 9 | 0 | 2026-10-25T23:04:40.554Z |
| tt67-input | 11 | 11 | 0 | 2026-10-27T21:17:11.260Z |
| tt67-sheet-ns | 13 | 13 | 0 | 2026-10-26T08:11:31.185Z |
| tt68-blank | 8 | 8 | 0 | 2026-10-25T23:09:25.727Z |
| tt69-lifecycle | 11 | 11 | 0 | 2026-11-08T18:28:21.554Z |
| tt69-sheet-misc | 5 | 5 | 0 | 2026-10-26T07:53:17.856Z |
| tt70-edge | 5 | 5 | 0 | 2026-10-26T20:00:59.953Z |
| tt70-range | 6 | 6 | 0 | 2026-10-26T20:00:59.791Z |
| tt70-seal | 8 | 8 | 0 | 2026-10-25T23:10:43.789Z |
| tt71-focus | 7 | 7 | 0 | 2026-10-26T20:01:00.633Z |
| tt72-access | 3 | 3 | 0 | 2026-10-25T23:17:23.233Z |
| tt72-office | 12 | 12 | 0 | 2026-10-26T07:55:08.912Z |
| tt72-padlink | 6 | 6 | 0 | 2026-10-25T23:17:10.871Z |
| tt73-office | 12 | 12 | 0 | 2026-10-26T07:58:20.490Z |
| tt74-office | 32 | 32 | 0 | 2026-10-26T08:00:39.179Z |
| tt75-epub | 31 | 31 | 0 | 2026-10-25T23:25:09.333Z |
| tt75-office | 17 | 17 | 0 | 2026-10-26T08:03:13.483Z |
| tt76-sheet | 13 | 13 | 0 | 2026-10-26T08:03:15.704Z |
| tt76-slides | 8 | 8 | 0 | 2026-10-26T15:59:10.851Z |
| tt77-pdf-composite | 18 | 18 | 0 | 2026-10-26T20:45:52.499Z |
| tt77-pdf | 11 | 11 | 0 | 2026-10-25T23:27:21.990Z |
| tt77-pdfsig | 23 | 23 | 0 | 2026-10-26T20:53:30.198Z |
| tt78-sheet | 11 | 11 | 0 | 2026-10-26T15:59:23.715Z |
| tt79-archive | 15 | 15 | 0 | 2026-10-26T07:10:13.663Z |
| tt79-pdf | 17 | 17 | 0 | 2026-10-26T08:37:24.818Z |
| tt79-sheet | 5 | 5 | 0 | 2026-10-26T15:54:13.462Z |
| tt80-banner | 11 | 11 | 0 | 2026-10-29T03:35:49.119Z |
| tt81-core | 13 | 13 | 0 | 2026-11-02T00:25:57.325Z |
| tt84-wordcount | 15 | 15 | 0 | 2026-10-26T20:46:39.790Z |
| tt85-find | 4 | 4 | 0 | 2026-10-27T00:31:18.229Z |
| tt85-identity | 5 | 5 | 0 | 2026-10-27T00:31:17.511Z |
| tt85-inventory | 4 | 4 | 0 | 2026-11-07T05:20:58.433Z |
| tt86-pointer | 3 | 3 | 0 | 2026-10-27T21:22:59.018Z |
| tt87-backup-http | 8 | 8 | 0 | 2026-10-27T21:23:44.185Z |
| tt87-backup | 5 | 5 | 0 | 2026-10-27T21:23:43.295Z |
| tt87-pointer-queue | 2 | 2 | 0 | 2026-10-27T21:23:20.838Z |
| tt87-transaction | 5 | 5 | 0 | 2026-10-27T21:23:43.018Z |
| tt88-recovery | 9 | 9 | 0 | 2026-10-27T21:24:05.098Z |
| tt89-drill-db | 13 | 13 | 0 | 2026-10-27T21:24:13.970Z |
| tt89-drill-health | 7 | 7 | 0 | 2026-10-27T21:24:11.973Z |
| tt89-drill-http | 9 | 9 | 0 | 2026-10-27T21:24:14.496Z |
| tt89-launch-mutants | 12 | 12 | 0 | 2026-10-27T05:26:22.287153+00:00 |
| tt89-launch-unit | 6 | 6 | 0 | 2026-10-27T21:24:24.063Z |
| tt89-mutants | 13 | 13 | 0 | 2026-10-27T05:27:16.194555+00:00 |
| tt89-test-safety | 4 | 4 | 0 | 2026-10-27T23:32:18.047Z |
| tt90-context-unit | 4 | 4 | 0 | 2026-10-27T21:24:35.430Z |
| tt90-crypto-probe | 1 | 1 | 0 | 2026-10-27T17:21:35.626Z |
| tt90-modal-mutant | 2 | 2 | 0 | 2026-10-27T21:09:13.164457+00:00 |
| tt90-mutants | 15 | 15 | 0 | 2026-10-27T06:33:22.657077+00:00 |
| tt90-private-thumb-path | 1 | 1 | 0 | 2026-10-27T21:25:01.130Z |
| tt90-worker-pool | 9 | 9 | 0 | 2026-10-27T21:25:00.835Z |
| tt91-browser-download | 10 | 10 | 0 | 2026-10-27T20:36:24.709Z |
| tt91-download-mutants | 10 | 10 | 0 | 2026-10-27T13:58:50.777249+00:00 |
| tt91-purge-mutants | 4 | 4 | 0 | 2026-10-27T13:56:45.169085+00:00 |
| tt91-purge-race-mutants | 3 | 3 | 0 | 2026-10-27T13:56:48.374454+00:00 |
| tt91-purge-race | 4 | 4 | 0 | 2026-10-29T19:34:45.814Z |
| tt91-purge | 5 | 5 | 0 | 2026-10-27T20:36:17.968Z |
| tt91-race-mutants | 4 | 4 | 0 | 2026-10-27T13:57:06.155168+00:00 |
| tt91-thumbnail-cleanup-race | 6 | 6 | 0 | 2026-10-27T20:36:17.478Z |
| tt91-write-atomic | 2 | 2 | 0 | 2026-10-29T19:34:45.140Z |
| tt91-write-mutants | 2 | 2 | 0 | 2026-10-27T16:00:14.746222+00:00 |
| tt92-ledger-audit | 7 | 7 | 0 | 2026-10-31T04:54:45.060Z |
| tt92-ledger-policy | 2 | 2 | 0 | 2026-10-31T04:50:24.681Z |
| tt92-privacy-perf | 1 | 1 | 0 | 2026-10-27T16:27:53.119Z |
| tt92-trash-mutants | 13 | 13 | 0 | 2026-10-27T16:01:17.863627+00:00 |
| tt92-trash-race | 6 | 6 | 0 | 2026-10-29T19:34:46.765Z |
| tt92-trash | 11 | 11 | 0 | 2026-10-29T19:34:47.434Z |
| tt93-metadata-race | 4 | 4 | 0 | 2026-10-27T20:37:25.685Z |
| tt93-restore-race | 3 | 3 | 0 | 2026-10-27T20:37:25.038Z |
| tt93-transfer-mutants | 16 | 16 | 0 | 2026-10-27T15:59:35.182554+00:00 |
| tt93-transfer-race | 5 | 5 | 0 | 2026-10-27T20:37:24.417Z |
| tt93-transfer | 17 | 17 | 0 | 2026-10-27T20:37:23.574Z |
| tt94-photo-guard-race | 2 | 2 | 0 | 2026-10-30T23:55:28.304Z |
| tt94-photo-guard | 12 | 12 | 0 | 2026-10-27T20:37:50.824Z |
| tt94-photo-mutants | 15 | 15 | 0 | 2026-10-27T19:47:59.101342+00:00 |
| tt95-calculator-audit | 4 | 4 | 0 | 2026-10-27T23:27:24.404Z |
| tt95-photo-concurrency | 13 | 13 | 0 | 2026-10-27T20:38:45.304Z |
| tt95-photo-mutants | 12 | 12 | 0 | 2026-10-27T19:40:47.851721+00:00 |
| tt95-photo-race | 3 | 3 | 0 | 2026-10-27T20:38:45.757Z |
| tt96-calc-history | 6 | 6 | 0 | 2026-10-28T02:00:16.079Z |
| tt96-calculator-mutants | 19 | 19 | 0 | 2026-10-27T20:54:51.033317+00:00 |
| tt96-programmer | 8 | 8 | 0 | 2026-10-28T02:00:15.878Z |
| tt96-scientific-units | 6 | 6 | 0 | 2026-10-28T02:00:16.314Z |
| tt97-palette-commands | 4 | 4 | 0 | 2026-10-29T19:38:14.093Z |
| tt97-palette-mutants | 8 | 8 | 0 | 2026-10-27T23:08:25.457823+00:00 |
| tt97-svg-attributes | 3 | 3 | 0 | 2026-10-28T02:00:16.639Z |
| unit | 23 | 23 | 0 | 2026-11-10T07:23:43.225Z |
| vector-boolean | 6 | 6 | 0 | 2026-11-07T05:39:32.405Z |
| vector | 18 | 18 | 0 | 2026-11-10T07:23:45.396Z |
| whiteboard-engine | 9 | 9 | 0 | 2026-11-10T07:23:45.723Z |

## Rows touched by FAILING tests (not counted as tested)

- HW-03: e2e-tt146: HW-03/HW-10 the runtime pane reports what this engine really does
- HW-10: e2e-tt146: HW-03/HW-10 the runtime pane reports what this engine really does
- AX-20: tt118-density: AX-20: every app measured, none wordier than the ceiling, no emoji marks
- AX-21: tt119-density: AX-21: every app measured, none wordier than the ceiling, no emoji marks
- AX-22: tt120-density: AX-22: every app measured, none wordier than the ceiling, no emoji marks
- AX-23: tt121-density: AX-23: every app measured, none wordier than the ceiling, no emoji marks
- AX-24: tt122-density: AX-24: every app measured, none wordier than the ceiling, no emoji marks; tt123-density: density beam: words<=300; tt123-density: density files: words<=320; tt124-density: density routines: words<=300; tt124-density: density storage: words<=480; tt125-density: AX-24 bounds: every touched module within its TT125 cap

## By family

| family | rows | built | partial+probe | blocked | fully tested | partially tested | untested |
|---|---:|---:|---:|---:|---:|---:|---:|
| Windowing | 4 | 4 | 0 | 0 | 3 | 0 | 1 |
| Input | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| System | 4 | 4 | 0 | 0 | 3 | 0 | 1 |
| Publishing | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Files | 6 | 6 | 0 | 0 | 6 | 0 | 0 |
| Security | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Connect | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Accessibility | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Automation | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Licensing | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Lens | 6 | 6 | 0 | 0 | 6 | 0 | 0 |
| Terminal | 7 | 7 | 0 | 0 | 7 | 0 | 0 |
| Hardware | 5 | 5 | 0 | 0 | 4 | 0 | 1 |
| Diffusion | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| SR | 9 | 8 | 0 | 1 | 7 | 2 | 0 |
| CSV | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| CG | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| IN | 8 | 7 | 0 | 1 | 7 | 0 | 1 |
| CK | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| CV | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| ED | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Devices | 5 | 5 | 0 | 0 | 5 | 0 | 0 |
| Editor | 10 | 10 | 0 | 0 | 10 | 0 | 0 |
| Store | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Routines | 4 | 4 | 0 | 0 | 4 | 0 | 0 |
| Network | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Streaming | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Notes | 27 | 27 | 0 | 0 | 27 | 0 | 0 |
| Clipboard | 8 | 8 | 0 | 0 | 8 | 0 | 0 |
| Find | 21 | 21 | 0 | 0 | 21 | 0 | 0 |
| Pdf | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Writer | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Beam | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| Vault | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Planner | 9 | 9 | 0 | 0 | 9 | 0 | 0 |
| Ssh | 1 | 1 | 0 | 0 | 0 | 0 | 1 |
| Recall | 42 | 39 | 3 | 0 | 35 | 7 | 0 |
| Peek | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| Whiteboard | 3 | 3 | 0 | 0 | 2 | 1 | 0 |
| Apps | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| Together | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Settings | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Books | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Clock | 12 | 12 | 0 | 0 | 12 | 0 | 0 |
| Monitor | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| ImageQuickEdit | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Media | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| Contacts | 5 | 5 | 0 | 0 | 5 | 0 | 0 |
| Messages | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Photos | 7 | 7 | 0 | 0 | 7 | 0 | 0 |
| Vector | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Capture | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Spec | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| SSH | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Visual language | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| Privacy | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Backup | 6 | 6 | 0 | 0 | 6 | 0 | 0 |
| Calculator | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| Slides | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Archive | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Storage | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Music | 4 | 4 | 0 | 0 | 4 | 0 | 0 |
| Local disk | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Design | 7 | 7 | 0 | 0 | 3 | 4 | 0 |
| Alerts | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Maps | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| PDF | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| Browser | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| RC | 1 | 1 | 0 | 0 | 1 | 0 | 0 |
| AX | 16 | 16 | 0 | 0 | 14 | 2 | 0 |
| SH | 15 | 15 | 0 | 0 | 13 | 2 | 0 |
| WM | 18 | 17 | 0 | 1 | 14 | 2 | 2 |
| FM | 18 | 15 | 1 | 2 | 14 | 3 | 1 |
| NC | 6 | 6 | 0 | 0 | 2 | 4 | 0 |
| ST | 8 | 7 | 0 | 1 | 6 | 1 | 1 |
| AP | 5 | 4 | 0 | 1 | 3 | 2 | 0 |
| TD | 5 | 4 | 0 | 1 | 4 | 1 | 0 |
| PR | 52 | 52 | 0 | 0 | 48 | 4 | 0 |
| FF | 78 | 78 | 0 | 0 | 77 | 1 | 0 |
| MD | 9 | 9 | 0 | 0 | 7 | 2 | 0 |
| SC | 17 | 17 | 0 | 0 | 14 | 3 | 0 |
| BK | 6 | 5 | 1 | 0 | 5 | 1 | 0 |
| TB | 5 | 5 | 0 | 0 | 5 | 0 | 0 |
| WB | 5 | 5 | 0 | 0 | 5 | 0 | 0 |
| CN | 4 | 4 | 0 | 0 | 4 | 0 | 0 |
| LY | 22 | 22 | 0 | 0 | 22 | 0 | 0 |
| SM | 11 | 11 | 0 | 0 | 8 | 3 | 0 |
| MP | 8 | 8 | 0 | 0 | 8 | 0 | 0 |
| CT | 6 | 6 | 0 | 0 | 5 | 1 | 0 |
| CA | 15 | 10 | 0 | 5 | 10 | 5 | 0 |
| LN | 13 | 9 | 0 | 4 | 7 | 3 | 3 |
| MS | 2 | 0 | 0 | 2 | 0 | 2 | 0 |
| AU | 2 | 2 | 0 | 0 | 2 | 0 | 0 |
| RG | 7 | 7 | 0 | 0 | 7 | 0 | 0 |
| HW | 7 | 7 | 0 | 0 | 6 | 1 | 0 |
| CM | 2 | 1 | 0 | 1 | 0 | 2 | 0 |
| BL | 4 | 4 | 0 | 0 | 3 | 1 | 0 |
| DP | 14 | 14 | 0 | 0 | 10 | 4 | 0 |

## Per-row detail

| code | status | tested | evidence (passing tests) |
|---|---|---|---|
| WM-16 | built | full | e2e-tt147: WM-16 the cursor is really confined by a real click, and really released; tt139-platform: WM-16 · a delta integrates into an absolute cursor and crosses a seam; tt139-platform: WM-16 · a cursor pushed past every display is clamped, not lost (+3) |
| IN-06 | built | full | tt139-platform: IN-06 · the usable band is the viewport minus the keyboard, never negative; tt139-platform: IN-06 · an implausible inset is clamped and the clamp is visible; tt139-platform: IN-06 · scroll-into-view moves the minimum needed, and reflow keeps the focused window put (+10) |
| ST-02 | built | full | e2e-tt147: ST-02 the settings index names real panels and offers only the ones this platform has; tt139-platform: ST-02 · browser detection does not confuse a Chromium fork with Chrome; tt139-platform: ST-02 · internal schemes are never linkable, and the refusal carries the text to copy (+3) |
| PR-06 | built | full | e2e-tt146: PR-06 the mail composer builds a link this browser accepts, and says what it cannot do; tt139-platform: PR-06 · RFC 6068 encoding keeps the safe characters and encodes newlines as %0D%0A; tt139-platform: PR-06 · a draft builds a valid mailto, drops invalid addresses and never emits a stray '?' (+5) |
| PR-07 | built | full | browser-session: URL guard: http(s) only, bare hosts get https, credentials and own origin refused; browser-session: restore normalisation: hostile/invalid tabs dropped, groups/perms validated, active repaired, pinned first; e2e-browser: hostile saved session: javascript:, same-origin and credential URLs are dropped on restore; no frame ever points at the shell origin (+12) |
| FF-06 | built | full | e2e-tt148: FF-06 an AVIF named .heic becomes a real thumbnail in Files — and the decoder agrees it is decodable; e2e-tt148: FF-06 a real HEIC is refused by the app and by the engine in the same page — the sentence is measured; tt139-platform: FF-06 · canPlayType's three answers map to three different states (+3) |
| SC-06 | built | full | tt139-platform: SC-06 · the guard hides on every trigger and says which one fired; tt139-platform: SC-06 · the guarantee is never overstated, and the tiles cover the area; tt140-cast-privacy: SC-06 · the protection statement never claims more than the platform allows (+4) |
| MS-01 | built | full | e2e: mount: messages; tt139-platform: MS-01 · a plain-http bridge is refused unless it is on this machine; tt139-platform: MS-01 · requests carry the token in a header, never in the URL (+2) |
| MS-04 | built | full | tt139-platform: MS-04 · Matrix needs https and a real token, and its responses are typed; tt139-platform: MS-04 · pagination and errors are read correctly, and secrets are redacted |
| AX-06 | built | full | tt139-platform: AX-06 · dictation is off unless the user consented to cloud speech; tt139-platform: AX-06 · interim results replace the tail, finals commit, and the budget is enforced; tt139-platform: AX-06 · every stop reason is classified, and text is never discarded on stop |
| AU-04 | built | full | tt139-platform: AU-04 · a plan is built from the sentence, and a missing argument is a partial, not a guess; tt139-platform: AU-04 · an executable plan is validated against the real command table; tt139-platform: AU-04 · the module never claims a model it does not have |
| BL-04 | built | full | tt139-platform: BL-04 · a Pay button is impossible outside a real store context; tt139-platform: BL-04 · a malformed price from the store is a refusal, not 'undefined'; tt139-platform: BL-04 · there is exactly one store decision function (+1) |
| LN-02 | built | full | tt139-platform: LN-02 · the subject is the largest box plus its neighbours, and no faces means no subject; tt139-platform: LN-02 · the crop keeps the subject inside and never shrinks below the floor; tt139-platform: LN-02 · smoothing is critically damped: it approaches without overshoot and stops jittering (+12) |
| LN-12 | built | full | tt139-platform: LN-12 · the presenter bubble stays inside the stage and warns when it covers the content; tt140-cast-privacy: LN-12 · picture-in-picture keeps the camera ratio and stays on screen; tt140-cast-privacy: LN-12 · invalid presenter settings are refused, not clamped silently (+4) |
| AU-03 | built | full | e2e-tt146: AU-03 the automation panel mints a token once and never shows it again; e2e-tt89-launch: cold browser navigation opens a documented protocol intent and suppresses its duplicate queue delivery; e2e-tt89-launch: focus-existing synthetic launches restrict origin, action and app ids (+16) |
| TD-04 | built | full | tt139-platform: TD-04 · sort is stable, numeric like sort -n, and unique is not a set; tt139-platform: TD-04 · uniq only collapses adjacent duplicates, which is the real semantics; tt139-platform: TD-04 · cut, paste and wc follow POSIX counting (+1) |
| HW-06 | built | full | tt139-platform: HW-06 · windows are centred in the work area, never under a taskbar; tt139-platform: HW-06 · presentation prefers an external screen, and DPI changes are described |
| HW-07 | built | full | e2e-tt147: HW-07 the peripheral card lists every bus this engine has, and counts only what is granted; tt139-platform: HW-07 · each transport's availability is its own answer, gated on a secure context; tt139-platform: HW-07 · over-broad filters are refused before a picker opens (+2) |
| HW-09b | built | untested |  |
| HW-10 | built | full | tt139-platform: HW-10 · WASM probes are real modules, and threads without isolation is reported as blocked; tt141-browser: Monitor: WASM SIMD is decided by real module validation, not a user-agent string; tt146-core: HW-10 the assembled module is real SIMD and reproduces its own constant (+2) |
| HW-11 | built | full | e2e-tt110-shell: the screen wake lock is really taken and really released; tt139-platform: HW-11 · a wake lock is a lease with a visible state, not a boolean hope |
| CT-03b | built | untested |  |
| DP-07 | built | full | a11y-unit: DP-07 gate: the shell's own surface tokens clear the AA floor, and the gate is what decides; e2e: no non-resource console errors across all module mounts; tt116-density: every control whose caption was removed still answers to its full name (+13) |
| SR-26 | built | full | tt139-engines: SR-26 · the query grammar parses every operator and reports bad input; tt139-engines: SR-26 · ranking prefers a title match and length-normalises long bodies; tt139-engines: SR-26 · filters are conjunctive and negation scans every field (+2) |
| CSV-01 | built | full | tt139-engines: CSV-03 · delimiter detection scores consistency, not frequency |
| CG-01 | built | full | tt139-engines: CG-01 · WCAG contrast matches the published extremes and thresholds; tt139-engines: CG-01 · lightness behaves as perception, not as HSL: a red/blue swap is not 'equal brightness'; tt139-engines: CG-01 · colour-vision simulation is deterministic, monotone in severity and keeps greys grey (+2) |
| IN-09 | built | full | tt139-engines: IN-09 · chord normalisation is order-independent and platform-aware; tt139-engines: IN-09 · scope precedence resolves a dialog Escape without closing the window; tt139-engines: IN-09 · reserved chords and conflicts are reported, never silently accepted (+1) |
| CK-09 | built | full | tt139-engines: CK-09 · civil day numbers agree with Date.UTC across four centuries; tt139-engines: CK-09 · weekday and ISO week match known calendar facts; tt139-engines: CK-09 · a wall time that does not exist is a gap, and one that happens twice is an overlap (+2) |
| CV-04 | built | full | tt139-engines: CV-04 · defined factors are exact to double precision; tt139-engines: CV-04 · a dimensionally impossible conversion is refused with the reason; tt139-engines: CV-04 · free-text quantities parse the forms people type |
| ED-11 | built | full | tt139-engines: ED-11 · matching honours case, whole-word and Unicode boundaries; tt139-engines: ED-11 · a pathological regex is refused or bounded rather than freezing; tt139-engines: ED-11 · replace-all is literal in literal mode and expands groups in regex mode (+1) |
| HW-13 | built | full | tt135-core-engines: HW-13 · slow-2g sample classifies as minimal; tt135-core-engines: HW-13 · 4g with good downlink classifies as high; tt135-core-engines: HW-13 · saveData forces minimal even on 4g (+4) |
| RG-08 | built | full | tt135-core-engines: RG-08 · input kind maps to user-blocking; tt135-core-engines: RG-08 · background work uses idle when hidden; tt135-core-engines: RG-08 · postTask unavailable downgrades with reason (+3) |
| HW-12 | built | full | tt135-core-engines: HW-12 · quantum at 48kHz is 2.67ms; tt135-core-engines: HW-12 · suspended context reports not ok; tt135-core-engines: HW-12 · running context with good latency grades excellent (+4) |
| PR-14 | built | full | tt135-text-encoding: PR-14 · valid UTF-8 decodes with strict confidence; tt135-text-encoding: PR-14 · UTF-8 BOM is detected; tt135-text-encoding: PR-14 · invalid UTF-8 falls back to Latin-1, flagged lossy (+14) |
| FM-21 | built | full | tt135-files-engines: FM-21 · simple pattern replaces {name}; tt135-files-engines: FM-21 · {n} pads to two digits; tt135-files-engines: FM-21 · {upper} applies to everything to its right (+7) |
| FM-22 | built | full | tt135-files-engines: FM-22 · items older than retention are purged; tt135-files-engines: FM-22 · pinned items are never purged; tt135-files-engines: FM-22 · unknown timestamps are never purged (+3) |
| PR-15 | built | full | tt135-files-engines: PR-15 · nameFromUrl extracts filename from URL path; tt135-files-engines: PR-15 · nameFromUrl rejects non-http URLs; tt135-files-engines: PR-15 · createEntry produces a queued download (+11) |
| CT-07 | built | full | tt135-system-engines: CT-07 · makePayload validates app id and title; tt135-system-engines: CT-07 · makePayload rejects invalid app id; tt135-system-engines: CT-07 · makePayload rejects oversized props (+6) |
| BL-07 | built | full | tt135-system-engines: BL-07 · parseManifest validates digest formats; tt135-system-engines: BL-07 · parseManifest rejects mixed algorithms; tt135-system-engines: BL-07 · manifestBody is deterministic (+4) |
| RH-04 | built | full | tt135-system-engines: RH-04 · validateRoutine checks step count; tt135-system-engines: RH-04 · planFire returns fire=true when due; tt135-system-engines: RH-04 · planFire returns fire=false when not due (+4) |
| CO-03 | built | full | tt135-system-engines: CO-03 · route allows same-origin direct fetch; tt135-system-engines: CO-03 · route blocks non-HTTP protocols; tt135-system-engines: CO-03 · route blocks URLs with credentials (+6) |
| BL-06 | built | untested |  |
| WM-20 | built | full | tt135-system-engines: WM-20 · makeGroup validates member count; tt135-system-engines: WM-20 · makeGroup rejects duplicate members; tt135-system-engines: WM-20 · minimizeGroup sets minimised on all members (+3) |
| SH-16 | built | full | tt135-system-engines: SH-16 · leaseFor creates a valid lease; tt135-system-engines: SH-16 · claim succeeds when no lease exists; tt135-system-engines: SH-16 · claim fails when another tab holds the lease (+3) |
| ST-18 | built | full | tt135-system-engines: ST-18 · all four profiles exist with valid hit sizes; tt135-system-engines: ST-18 · touch profile does not apply on mouse pointer; tt135-system-engines: ST-18 · precision profile applies on mouse (+2) |
| FM-23 | built | full | tt135-files-engines: FM-23 · check grants read inside folder; tt135-files-engines: FM-23 · check denies read outside folder; tt135-files-engines: FM-23 · check denies missing permission (+4) |
| ST-17 | built | full | tt135-files-engines: ST-17 · parsePlaylist parses basic M3U8; tt135-files-engines: ST-17 · parsePlaylist detects byte ranges; tt135-files-engines: ST-17 · parsePlaylist detects live playlists (+4) |
| NT-19 | built | full | e2e-tt134-workflows-notes: NT-19: native collection download/file import round-trips fields into new indexed IDs; invalid/cancelled import changes nothing; tt134-workflows-core: Copy-only batch validates all rows, forbids identities/unknowns, enforces 32 rows and UTF-8 budget; tt134-workflows-core: Portable note copies round-trip editable fields only; unknown envelopes and identities are refused (+3) |
| NT-20 | built | full | e2e-tt134-workflows-notes: NT-20: merge checked saved snapshots into a new note; an unsaved source draft and both original records remain exact; tt134-workflows-core: Copy-only batch validates all rows, forbids identities/unknowns, enforces 32 rows and UTF-8 budget; tt134-workflows-core: Merge creates a separate saved-body composition, preserves inputs and rejects oversized output (+2) |
| NT-21 | built | full | e2e-tt134-workflows-notes: NT-21: split the current draft at real top-level headings, ignore fenced headings, preserve every source character and support cancellation; tt134-workflows-core: Copy-only batch validates all rows, forbids identities/unknowns, enforces 32 rows and UTF-8 budget; tt134-workflows-core: Heading splits ignore fenced headings and preserve the exact CRLF source when rejoined (+2) |
| NT-22 | built | full | e2e-tt134-workflows-notes: NT-22: native find-next selects/wraps actual textarea matches; literal replace saves exact Unicode and empty find is refused; e2e-tt134-workflows-notes: NT-22/23 patch attack: a CRLF source find selects the visible Unicode match and link replacement preserves every other source byte; tt134-workflows-core: Literal replace is exact/case-sensitive, supports deletion, and refuses explosive expansion before construction (+1) |
| NT-23 | built | full | e2e-tt134-workflows-notes: NT-23: real selection + link form inserts a safe encoded Markdown anchor; active schemes fail without altering the draft; e2e-tt134-workflows-notes: NT-22/23 patch attack: a CRLF source find selects the visible Unicode match and link replacement preserves every other source byte; tt134-workflows-core: Link construction replaces only the selected range, rejects active schemes/bracket labels, encodes URL parentheses (+1) |
| NT-24 | built | full | e2e-tt134-workflows-notes: NT-24: table builder validates dimensions; native saved preview renders escaped cells/alignment without interpreting HTML; tt134-workflows-core: Pipe tables parse escaped pipes/backslashes and alignment, keep HTML as text and bound rows/columns |
| NT-25 | built | full | e2e-tt134-workflows-notes: NT-25: save a real VFS template and instantiate its local text tokens into a distinct indexed note without rewriting source/template; tt134-workflows-core: Templates expand only three plain tokens using the supplied real clock; no expression execution or recursive evaluation; tt134-workflows-core: Template budget includes the complete wrapper: exact 4 MiB roundtrip, one byte over refused |
| NT-26 | built | full | e2e-tt134-workflows-notes: NT-26: compare with a real concurrent saved winner; modal contains keyboard focus/blocks live tiling and never silently accepts its revision; e2e-tt134-workflows-notes: Large-text patch attack: the real async comparison heading follows saved 125/200 percent settings and remains closeable; tt134-workflows-core: Saved-body/clipboard line diff exactly reconstructs each side, including empty/CRLF/Unicode; it is not an LCS claim (+1) |
| NT-27 | built | full | e2e-tt134-workflows-notes: NT-27: cross-note saved task rollup ignores fences, commits exact task markers and rejects a stale row instead of overwriting a real winner; e2e-tt134-workflows-notes: NT-27 patch attack: an own Save inserting a line cannot retarget the old rollup checkbox to another source line |
| CB-04 | built | full | e2e-tt134-workflows-clipboard: CB-04: native inspector exposes full exact text and copies only the real Unicode selection; source remains intact; e2e-tt134-workflows-clipboard: CB-04 patch attack: CRLF excerpts retain source bytes; bisected Unicode ranges refuse; async focus loss cannot strand Escape; e2e-tt134-workflows-clipboard: Sensitive native Vault copy is masked and every new inspect/edit/export/compare command is disabled (+4) |
| CB-05 | built | full | e2e-tt134-workflows-clipboard: CB-05: editing creates a new native clipboard/history copy while retaining the original text and pin; e2e-tt134-workflows-clipboard: Sensitive native Vault copy is masked and every new inspect/edit/export/compare command is disabled; tt134-workflows-core: Clipboard tools refuse sensitive/oversized/invalid text without discarding original entries |
| CB-06 | built | full | e2e-tt134-workflows-clipboard: CB-06: save a clipboard entry through its real form into a separately indexed public note; blank title cannot commit; e2e-tt134-workflows-clipboard: Sensitive native Vault copy is masked and every new inspect/edit/export/compare command is disabled; tt134-workflows-core: Clipboard tools refuse sensitive/oversized/invalid text without discarding original entries |
| CB-07 | built | full | e2e-tt134-workflows-clipboard: CB-07: create-only public file transfer preserves exact bytes; Private paths and an existing-file overwrite are refused; e2e-tt134-workflows-clipboard: Sensitive native Vault copy is masked and every new inspect/edit/export/compare command is disabled; tt134-workflows-core: Clipboard tools refuse sensitive/oversized/invalid text without discarding original entries (+1) |
| CB-08 | built | full | e2e-tt134-workflows-clipboard: CB-08: check two real captures and compare their exact changed lines; one capture cannot launch a comparison; e2e-tt134-workflows-clipboard: CB-08 patch attack: repeated native keyboard/pointer toggles keep both independent checks and release comparison focus; e2e-tt134-workflows-clipboard: CB-08 readiness attack: a checked identity stays checked when same-prefix native captures arrive (+6) |
| SR-20 | built | full | e2e-tt134-workflows-find: SR-20: real UTC controls constrain canonical modification days and replay with every resource field after a reload; e2e-tt134-workflows-find: Private resource-filter refusal never sends the query to the host, in text and metadata modes; tt134-workflows-core: Resource filters validate exact UTC calendar days, half-open intervals and canonical safe byte ranges (+3) |
| SR-21 | built | full | e2e-tt134-workflows-find: SR-21: inclusive byte controls distinguish Unicode file bytes and note-body bytes; bad intervals cannot search or export stale results; e2e-tt134-workflows-find: Private resource-filter refusal never sends the query to the host, in text and metadata modes; tt134-workflows-core: Resource filters validate exact UTC calendar days, half-open intervals and canonical safe byte ranges (+3) |
| SR-22 | built | full | e2e-tt134-workflows-find: SR-22: native query-folder exclusion removes only the literal subtree, composes with scope, and works in live metadata; e2e-tt134-workflows-find: Private resource-filter refusal never sends the query to the host, in text and metadata modes; tt134-workflows-core: Folder exclusion is canonical, rejects traversal and retains SQL wildcard characters as literal path data (+3) |
| SR-23 | built | full | e2e-tt134-workflows-find: SR-23: real JSON/CSV downloads contain the current visible ordered hit and completed query, independently parsed; editing query invalidates export; e2e-tt134-workflows-find: Private export uses real encrypted storage/local search, explicit plaintext consent/cancel and actual lock clearing; Private preview stays disabled; tt134-workflows-core: Result JSON is lossless for visible rows/query; CSV neutralizes spreadsheet formulas and independently parses quotes/newlines |
| SR-24 | built | full | e2e-tt134-workflows-find: SR-24: actual result preview fetches fresh bounded text safely, restores focus, and reports a now-missing result instead of its stale snippet; e2e-tt134-workflows-find: Private export uses real encrypted storage/local search, explicit plaintext consent/cancel and actual lock clearing; Private preview stays disabled; tt134-workflows-http: Preview reads current bounded public text, not stale index snippets; binary/Private/trashed/excluded/missing cases stay safe |
| SR-25 | built | full | e2e-tt134-workflows-find: SR-25: native continuation retrieves the second real page, deduplicates fixed-index rows, keeps one history entry and invalidates after changing input; e2e-tt134-workflows-find: Private resource-filter refusal never sends the query to the host, in text and metadata modes; tt134-workflows-core: Literal paging allows exactly four bounded public offsets, rejects ranked/metadata/invalid continuations (+1) |
| NT-08 | built | full | e2e-tt133-boundaries: Real quota: failed Don't save retains modal and dirty text; native modal shortcuts cannot save behind it; Cancel/export/Save still work; e2e-tt133-boundaries: Real quota: explicit Discard edits is separately confirmed, preserves the saved note and cannot resurrect a delayed recovery draft; e2e-tt133-notes-find: NT-08: changing notes asks; Cancel preserves all edits, Save commits before navigation and no delayed draft resurrects (+6) |
| NT-09 | built | full | e2e-tt133-boundaries: Real quota: failed Don't save retains modal and dirty text; native modal shortcuts cannot save behind it; Cancel/export/Save still work; e2e-tt133-boundaries: Real quota: explicit Discard edits is separately confirmed, preserves the saved note and cannot resurrect a delayed recovery draft; e2e-tt133-notes-find: NT-09: a real sessionStorage draft survives reload, restores exact text with its old revision, and Save clears it (+5) |
| NT-10 | built | full | e2e-tt133-notes-find: NT-10: another real HTTP writer wins; stale UI save is refused, editor text remains, and confirmed Reload obtains the winner; e2e-tt134-ownership: Notes Orbit clean-load attack: Pin, Duplicate and Delete work without a prior editor Save, and do not adopt unrelated revisions; e2e-tt134-ownership: Notes Orbit Save→Pin uses its own acknowledged new revision, retains edited text and performs exactly two commits (+14) |
| NT-11 | built | full | e2e-tt133-notes-find: NT-11: local full-text filtering composes with stored-tag filtering, preserves selection, and has a real empty state; tt133-core: Note filter is NFKC/case-normalized, ANDs terms across title/body/tags, and preserves original order/data |
| NT-12 | built | full | e2e-tt133-notes-find: NT-12: preview renders a safe Markdown subset without executing raw HTML, loading remote images, or enabling javascript links; tt133-core: Markdown blocks: headings, fenced code, quotes, list items and task lines, with explicit line budget; tt133-core: Inline view uses text-only tokens; executable/relative/data URLs are not links and unmatched delimiters are linear-bounded |
| NT-13 | built | full | e2e-tt133-notes-find: NT-13: native file input imports fatal UTF-8 Markdown into a persisted indexed note; invalid UTF-8 cannot add a note; e2e-tt134-ownership: Notes Orbit Save→Duplicate copies the newly saved body and a 500-code-unit Unicode title without splitting its last surrogate pair; tt133-core: Markdown import: fatal UTF-8, byte cap and NUL rejection; exact CRLF body and first heading title (+1) |
| NT-14 | built | full | e2e-tt133-notes-find: NT-14: real wiki navigation and reverse backlinks open the correct notes; absent and ambiguous destinations cannot choose an arbitrary record; e2e-tt133-notes-find: NT-14 saved-identity attack: an unsaved rename keeps the real backlink, and borrowing another saved title cannot impersonate its destination; tt133-core: Wiki-link graph refuses duplicate saved titles in both directions; backlinks reverse only actual unambiguous navigation edges (+1) |
| NT-15 | built | full | e2e-tt133-notes-find: NT-15: outline is clickable, fence-aware and shares exact preview line IDs, including indented headings far below the fold; tt133-core: Markdown blocks: headings, fenced code, quotes, list items and task lines, with explicit line budget |
| NT-16 | built | full | e2e-tt133-notes-find: NT-16: native textarea selection creates an exact independent note, leaves its source unchanged, and an empty selection cannot extract; tt133-core: Excerpt extraction is an exact UTF-16 selection, never modifies its source, and refuses empty/out-of-range selections |
| NT-17 | built | full | e2e-tt133-notes-find: NT-17: interactive checklist checks and unchecks the right source marker; saving/reopening preserves other lines exactly; tt133-core: Checklist edits change exactly one marker, preserve CRLF and unrelated text, and refuse stale line numbers |
| NT-18 | built | full | e2e-tt133-boundaries: Real quota: failed Don't save retains modal and dirty text; native modal shortcuts cannot save behind it; Cancel/export/Save still work; e2e-tt133-notes-find: NT-18: an actual browser download is self-contained UTF-8 Markdown, includes unsaved text and cannot write a VFS file |
| SR-13 | built | full | e2e-tt133-notes-find: SR-13: the actual source control changes the native request and excludes other kinds, including an empty wrong source; tt133-core: Search inputs reject malformed source/mode/strategies/scopes, normalize only documented folder/suffix forms; tt133-http: Source/metadata/suffix/mode validation runs before search work and refuses nonsensical combinations |
| SR-14 | built | full | e2e-tt133-notes-find: SR-14: title and reference orders rearrange only the returned result set deterministically; e2e-tt134-workflows-find: Filter-state patch attack: native text/regex/case/order controls retain their independent scalar values without another host search; tt133-core: Result order is deterministic, copies rather than mutates, and uses source/reference tie-breaks |
| SR-15 | built | full | e2e-tt133-notes-find: SR-15: literal matching keeps internal whitespace and SQL wildcard characters literal, without ranked/fuzzy matches; tt133-core: Private/RAM literal search preserves whitespace and punctuation; extension filters apply before limit; tt133-http: Literal search keeps SQL wildcard characters literal, returns numeric ranks and excludes fuzzy-only names |
| SR-16 | built | full | e2e-tt133-notes-find: SR-16: file suffix control is case-insensitive and literal, and a non-file source disables/clears it; tt133-core: Search inputs reject malformed source/mode/strategies/scopes, normalize only documented folder/suffix forms; tt133-core: Private/RAM literal search preserves whitespace and punctuation; extension filters apply before limit (+3) |
| SR-17 | built | full | e2e-tt133-notes-find: SR-17: native confirmation cancels without a rebuild, then a real confirmed rebuild preserves source bytes; tt133-core: Index prefix agrees with code-point slicing and cannot emit a split surrogate at the 50,000 boundary; tt133-http: Every note/file index prefix is 50,000 Unicode code points, matches real PostgreSQL left(), and never splits a surrogate (+4) |
| SR-18 | built | full | e2e-tt133-notes-find: SR-18: path diagnosis shows an indexed real file, a nonexistent file, and invalid path refusal without hiding a previous diagnosis; tt133-core: Missing-path validator does not normalize traversal, trailing separators or private-name aliases; tt133-http: Current exclusions are literal folder boundaries in fast search, live metadata and diagnostics (underscore cannot hide its neighbour) (+1) |
| SR-19 | built | full | e2e-tt133-boundaries: Native Find mount purges canonical and malformed legacy Private history from actual localStorage but preserves a public neighbour; e2e-tt133-boundaries: Native locked-Private search stays local and outside automatic history; saving a named Private query requires explicit plaintext-profile consent; e2e-tt133-boundaries: Native corrupt-history attack: truncated JSON containing a Private query is erased rather than left as unparseable plaintext (+5) |
| SV-02 | built | full | e2e-tt133-boundaries: Native locked-Private search stays local and outside automatic history; saving a named Private query requires explicit plaintext-profile consent; e2e-tt133-notes-find: SV-02: saved profiles replay every control instead of inheriting current phrase/field/source/filter state; e2e-tt134-workflows-find: SR-20: real UTC controls constrain canonical modification days and replay with every resource field after a reload (+3) |
| SV-03 | built | full | e2e-tt133-boundaries: Native profile import warns about plaintext Private queries before replacing; cancel preserves the list, and malformed Unicode/unknown fields are refused atomically; e2e-tt133-notes-find: SV-03: native JSON download → delete → file import restores complete profiles; cancelled and invalid imports leave the list untouched; tt133-core: Portable profiles round-trip canonically; malformed, future, oversized and duplicate records are refused atomically |
| ED-10 | built | full | e2e-tt125: ED-09/ED-10/WR-02: case rewrites only the selection; the now-button stamps the caret; reading time appears in Word Count; e2e-tt128-editor: a delayed selection restore cannot undo a newer caret position or erase later text; e2e-tt128-editor: timestamp replaces only the selected span (+2) |
| ED-09 | built | full | e2e-tt125: ED-09/ED-10/WR-02: case rewrites only the selection; the now-button stamps the caret; reading time appears in Word Count; e2e-tt128-editor: a delayed selection restore cannot undo a newer caret position or erase later text; e2e-tt128-editor: case expansion preserves the whole transformed selection (+2) |
| PD-03 | built | full | tt125-core: PD-03 pdfPageText: lines by y, spans by x, blanks dropped |
| WR-02 | built | full | e2e-tt125: ED-09/ED-10/WR-02: case rewrites only the selection; the now-button stamps the caret; reading time appears in Word Count; tt125-core: WR-02 reading time: 238 wpm, rounds up, empty says so |
| BM-03 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: BM-03 filterSessions: matches transport, target or state; empty query keeps all |
| DV-03 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: DV-03 estimateText: both, one, or neither number shared |
| VA-03 | built | full | tt125-core: VA-03 reuseGroups: only digests compared, labels sorted, report honest |
| PL-10 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: PL-10 doneTasksText: done only, list order, empty stated |
| TM-08 | built | full | tt125-core: TM-08 alias: parse validates, expansion is first-token one-pass |
| SSH-04 | built | untested |  |
| RC-43 | built | full | tt125-core: RC-43 recallHitsText: newest first, timestamped |
| PK-04 | built | full | e2e-tt125: PK-04: Copy strings lifts ASCII runs from a binary; tt125-core: PK-04 asciiRuns: min length honoured, runs split on any non-printable |
| WB-08 | built | partial | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render |
| LN-19 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: LN-19/LN-20 zoomOptions from capabilities; torch is a capability, never assumed; tt125-density: screenshots: editor stamp toolbar + lens capability row |
| LN-20 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: LN-19/LN-20 zoomOptions from capabilities; torch is a capability, never assumed |
| AP-08 | built | full | tt125-core: AP-08 pushRecent: newest first, deduped, capped |
| CB-03 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: CB-03 mergeClipTexts: shown order, blank clips dropped, separator explicit |
| TG-03 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: TG-03 participantsText: hosts first, then alphabetical, empty stated |
| ST-16 | built | full | e2e-tt125: honest placements: zoom/torch gated, selection export disabled, merge needs two clips, roster and shortcuts copy render; tt125-core: ST-16 shortcutsText: keys then purpose, one per line |
| BK-13 | built | full | tt125-core: BK-13 bookPositionText: fraction and chapter stated, absences honest |
| ED-08 | built | full | e2e-tt124: ED-08/WR-01/PD-02: indent changes the buffer and selection; goal badge appears; page jump clamps; e2e-tt128-editor: indent, dedent, and unchanged edits keep the affected selection; e2e: mount: editor (+2) |
| CK-08 | built | full | e2e-tt124: MD-12/CK-08/SP-03: A–B label cycles; copy buttons exist on clock, spec, beam, contacts, messages, photos-editor, vector, ssh, together, routines; e2e: mount: clock; tt124-core: CK-08 world times: displayed order kept, offsets in parentheses |
| PD-02 | built | full | e2e-tt124: ED-08/WR-01/PD-02: indent changes the buffer and selection; goal badge appears; page jump clamps; e2e: mount: pdf; tt124-core: PD-02 page jump: 1-based clamp, garbage refused |
| PK-02 | built | full | e2e-tt124: PK-02/MN-02/LN-17 controls render: hex head on a binary, in-flight toggle, resolution pick; e2e: mount: peek; tt124-core: PK-02 hex head: 16-per-line, ascii gutter, truncation stated |
| LN-17 | built | full | e2e-tt124: PK-02/MN-02/LN-17 controls render: hex head on a binary, in-flight toggle, resolution pick; e2e: mount: lens; tt124-core: LN-17/CP-02 resolution pick: one engine, two cameras |
| MN-02 | built | full | e2e-tt124: PK-02/MN-02/LN-17 controls render: hex head on a binary, in-flight toggle, resolution pick; e2e: mount: monitor; tt124-core: MN-02 in-flight view: finished rows filtered, journal untouched |
| WR-01 | built | full | e2e-tt124: ED-08/WR-01/PD-02: indent changes the buffer and selection; goal badge appears; page jump clamps; e2e: mount: writer; tt124-core: WR-01 word goal: net writing, clamped, done flag (+1) |
| IE-01 | built | full | e2e-tt131-image-viewport: zoomed image viewport exposes a named keyboard focus target and arrow-key panning; e2e-tt131-image-viewport: modified arrows are not consumed by the viewport handler; e2e-tt131-image-viewport: viewport focus keeps existing editor shortcuts available (+7) |
| MD-12 | built | full | e2e-tt124: MD-12/CK-08/SP-03: A–B label cycles; copy buttons exist on clock, spec, beam, contacts, messages, photos-editor, vector, ssh, together, routines; e2e: mount: media; tt124-core: MD-12 A–B loop: A→B→off cycle, B before A re-sets A, seek at B |
| CN-10 | built | full | e2e: mount: contacts; tt124-core: CN-10 email list: deduped, sorted, empties dropped |
| MS-06 | built | full | e2e: mount: messages; tt124-core: MS-06 conversation text: timestamped lines, empty stated |
| PH-08 | built | full | e2e-tt124: PH-08: opening a photo offers Copy info with honest absences; e2e: mount: photos; tt124-core: PH-08 photo info: absences say 'not in index' |
| VT-02 | built | full | e2e: mount: vector; tt124-core: VT-02 SVG markup: existing exporter's output is clipboard-ready |
| CP-02 | built | full | e2e: mount: capture; tt124-core: LN-17/CP-02 resolution pick: one engine, two cameras; tt124-core: CP-02 resolution: ideals only, max adds nothing |
| TG-01 | built | full | e2e: mount: together; tt124-core: TG-01 room code: prefix, length, unambiguous alphabet |
| RT-03 | built | full | e2e: mount: routines; tt124-core: RT-03 duplicate name: collisions get numbered copies |
| SP-03 | built | full | e2e-tt124: MD-12/CK-08/SP-03: A–B label cycles; copy buttons exist on clock, spec, beam, contacts, messages, photos-editor, vector, ssh, together, routines; e2e: mount: spec; tt124-core: SP-03 family text: worst first, same engine as the strip (+1) |
| BM-02 | built | full | e2e: mount: beam; tt124-core: BM-02 session text: newest first, active rows carry elapsed |
| SSH-02 | built | full | e2e: mount: ssh; tt124-core: SSH-02 conn line: default port omitted, state in words; tt124-density: TT124 register: all twenty codes built, register grew past TT123's 567 |
| AX-26 | built | full | tt124-density: AX-26: indent and compare glyphs render on their buttons |
| WB-07 | built | full | e2e-tt123: TM-06/SSH-01/WB-07: history builtin exists; font buttons render; PNG export offered; e2e: mount: whiteboard; tt123-core: WB-07/VT-01 raster size: scale honoured, pixel cap scales down and says so (+1) |
| VT-01 | built | full | e2e: mount: vector; tt123-core: WB-07/VT-01 raster size: scale honoured, pixel cap scales down and says so |
| BM-01 | built | full | e2e: mount: beam; tt123-core: BM-01 elapsed: derived from instants, hours when needed |
| AL-01 | built | full | e2e: mount: privacy; tt123-core: AL-01 access filter: spans app/action/result |
| SSH-01 | built | full | e2e-tt123: TM-06/SSH-01/WB-07: history builtin exists; font buttons render; PNG export offered; e2e-tt133-openssh: Native ResizeObserver/font-size publication reaches the real PTY: stty rows equal rendered rows; size changes do not corrupt later input; e2e: mount: ssh (+1) |
| CK-07 | built | full | e2e-tt123: ED-07/NT-07/CK-07: find steps to a match; tag filter lists; offset sort toggles; e2e: mount: clock; tt123-core: CK-07 zone offsets: Intl-derived, sorted west to east, labels |
| ED-07 | built | full | e2e-tt123: ED-07/NT-07/CK-07: find steps to a match; tag filter lists; offset sort toggles; e2e: mount: editor; tt123-core: ED-07 match nav: next/prev with honest wrap reporting |
| NT-07 | built | full | e2e-tt123: ED-07/NT-07/CK-07: find steps to a match; tag filter lists; offset sort toggles; e2e: mount: notes; tt123-core: NT-07 note tags: facets from stored lists, untagged explicit |
| BK-11 | built | full | e2e-tt123: BK-11/DV-02/PH-07/SL-01 controls render: prune, copy info, no-date view, go-to box; e2e: mount: backup; tt123-core: BK-11 prune plan: only dated files, keeps N newest |
| TM-06 | built | full | e2e-tt123: TM-06/SSH-01/WB-07: history builtin exists; font buttons render; PNG export offered; e2e: mount: terminal; tt123-core: TM-06 cmd history: consecutive dup collapse, cap, numbering |
| CV-03 | built | full | e2e: mount: calculator; tt123-core: CV-03 history text: chronological worked calculation |
| MS-05 | built | full | e2e: mount: messages; tt123-core: MS-05 message search: sender+text, loaded messages only |
| PH-07 | built | full | e2e-tt123: BK-11/DV-02/PH-07/SL-01 controls render: prune, copy info, no-date view, go-to box; e2e-tt128-photos: a failed real image read is not cached as missing metadata and a reload retries; e2e-tt128-photos: No date retains a PNG with no capture metadata after indexing (+3) |
| PL-08 | built | full | e2e: mount: planner; tt123-core: PL-08 overdue text: open only, oldest first, whole days |
| SR-12 | built | full | e2e-tt133-notes-find: Regex patch attack: three genuine metadata pages accumulate 65 matches; all pass the worker's 50-text messages under one total budget; e2e: mount: find; tt123-core: SR-12 phrase query: wrapped, embedded quotes doubled not stripped |
| DV-02 | built | full | e2e-tt123: BK-11/DV-02/PH-07/SL-01 controls render: prune, copy info, no-date view, go-to box; e2e: mount: devices; tt123-core: DV-02 device info: absences stated, memory caveated (+1) |
| SL-01 | built | full | e2e-tt123: BK-11/DV-02/PH-07/SL-01 controls render: prune, copy info, no-date view, go-to box; e2e: mount: slides; tt123-core: SL-01 slide nav: 1-based clamp, garbage refused |
| CN-09 | built | full | e2e: mount: contacts; tt123-core: CN-09 family sort: structured N first, display-name fallback |
| AX-25 | built | full | tt123-density: AX-25: shuffle and wrap glyphs render beside their labels; tt123-density: screenshots: devices + spec |
| FM-19 | built | full | e2e: mount: files; tt123-core: FM-19 names list: screen order, names only; tt123-density: TT123 register: all twenty codes built, register grew past TT122's 547 |
| PK-01 | built | full | e2e-tt122: PK-01/ED-06: peek facts agree with wc; editor wrap changes the textarea style; e2e: mount: peek; tt122-core: PK-01 file facts: text counted with wc rules, binary never invents lines |
| CP-01 | built | full | e2e-tt122: DV-01/CP-01/BK-10/SP-02 controls render: battery card, capture delay, backup inventory, family progress; e2e: mount: capture; tt122-core: CP-01 capture delay: ladder snapped, labels honest |
| DV-01 | built | full | e2e-tt122: DV-01/CP-01/BK-10/SP-02 controls render: battery card, capture delay, backup inventory, family progress; e2e: mount: devices; tt122-core: DV-01 battery: clamped percent, unknown times stated |
| MN-01 | built | full | e2e: mount: monitor; tt122-core: MN-01 job sort: copies, three orders |
| RT-02 | built | full | e2e: mount: routines; tt122-core: RT-02 routine filter: name+actions, order preserved |
| AR-01 | built | full | e2e: mount: archive; tt122-core: AR-01 archive filter: name match keeps folder context |
| LN-16 | built | full | e2e: mount: lens; tt122-core: LN-16 facing: auto omits the constraint entirely |
| ED-06 | built | full | e2e-tt122: PK-01/ED-06: peek facts agree with wc; editor wrap changes the textarea style; e2e: mount: editor; tt122-core: ED-06 wrap: style pair consistent, storage read guarded |
| CK-06 | built | full | e2e-tt122: NT-06/MD-11/CK-06: bundle export lands in Files; loop toggles the element; laps copy appears; e2e: mount: clock; tt122-core: CK-06 laps text: splits from cumulative, fastest marked |
| NT-06 | built | full | e2e-tt122: NT-06/MD-11/CK-06: bundle export lands in Files; loop toggles the element; laps copy appears; e2e: mount: notes; tt122-core: NT-06 notes bundle: title order, solo-export rendering reused |
| CN-08 | built | full | e2e: mount: contacts; tt122-core: CN-08 contact card: slug filename, serializer round-trips |
| BK-10 | built | full | e2e-tt122: DV-01/CP-01/BK-10/SP-02 controls render: battery card, capture delay, backup inventory, family progress; e2e: mount: backup; tt122-core: BK-10 backup inventory: dated sorted newest-first, undated unknown |
| MD-11 | built | full | e2e-tt122: NT-06/MD-11/CK-06: bundle export lands in Files; loop toggles the element; laps copy appears; e2e: mount: media; tt122-core: MD-11 loop: label states state, toggle flips |
| ST-11 | built | full | e2e: mount: storage; tt122-core: ST-11 reclaim summary: only real duplicate groups count |
| SP-02 | built | full | e2e-tt122: DV-01/CP-01/BK-10/SP-02 controls render: battery card, capture delay, backup inventory, family progress; e2e: mount: spec; tt122-core: SP-02 family progress: built share per family, sorted |
| AP-07 | built | full | e2e: mount: apps; tt122-core: AP-07 app sort: registry group order, alpha within group |
| MU-05 | built | full | e2e: mount: music; tt122-core: MU-05 library stats: per-kind counts from the shared library |
| PH-06 | built | full | e2e: mount: photos; tt122-core: PH-06 shuffle: permutation, seeded determinism, identity detection |
| PL-07 | built | full | e2e-tt128-time: Planner: week columns and completion counts survive midnight DST transition; e2e: mount: planner; tt122-core: PL-07 completion stats: today/week windows, undated kept separate (+1) |
| LD-01 | built | full | e2e: mount: localdisk; tt122-core: LD-01 sync summary: conflicts never read as clean |
| AX-24 | built | partial | e2e: mount: devices; tt123-density: density whiteboard: words<=260; tt123-density: density vector: words<=320 (+34) |
| CV-02 | built | full | e2e-tt121: CV-02/CK-05: calculator memory recalls into the expression; timer preset sets 25:00; e2e: mount: calculator; tt121-core: CV-02 calculator memory: register transitions, NaN refused |
| ED-05 | built | full | e2e-tt121: ED-05/TM-05: editor sorts the buffer; terminal sort reads a real file; e2e: mount: editor; tt121-core: ED-05 line ops: sort/dedupe keep termination, natural order |
| CK-05 | built | full | e2e-tt121: CV-02/CK-05: calculator memory recalls into the expression; timer preset sets 25:00; e2e: mount: clock; tt121-core: CK-05 timer presets: fixed ladder, lookup exact |
| MD-10 | built | full | e2e-tt121: MD-10/NT-05/CN-07/AX-23: speed select, note sort, contact facet, drawn star; e2e: mount: media; tt121-core: MD-10 playback rate: snapped to the portable ladder |
| SC-19 | built | full | e2e-tt121: SC-19/PL-06/SR-11 controls exist and act: vault strength, agenda copy, find copy; e2e: mount: vault; tt121-core: SC-19 passphrase: strength is pool-based, generator deterministic under injected RNG |
| NC-07 | built | full | e2e: mount: alerts; tt121-core: NC-07 alert facets: unread count derived, unread-only + query compose |
| CB-02 | built | full | e2e: mount: clipboard; tt121-core: CB-02 clip kinds: whole-entry classification only |
| MP-09 | built | full | e2e: mount: maps; tt121-core: MP-09 coordinates: decimal interchange + unambiguous DMS |
| EB-01 | built | full | e2e: mount: books; tt121-core: EB-01 book progress: clamped, smooth, chapter label honest |
| PD-01 | built | full | e2e: mount: pdf; tt121-core: PD-01/WB-06 zoom ladder: steps snap, ends clamp, label rounds |
| WB-06 | built | full | e2e: mount: whiteboard; tt121-core: PD-01/WB-06 zoom ladder: steps snap, ends clamp, label rounds |
| PL-06 | built | full | e2e-tt121: SC-19/PL-06/SR-11 controls exist and act: vault strength, agenda copy, find copy; e2e: mount: planner; tt121-core: PL-06 agenda text: day-scoped, sorted, done marked not dropped |
| SR-11 | built | full | e2e-tt121: SC-19/PL-06/SR-11 controls exist and act: vault strength, agenda copy, find copy; e2e: mount: find; tt121-core: SR-11 results as text: one line per hit, snippets excluded |
| MU-04 | built | full | e2e: mount: music; tt121-core: MU-04 library sort: stable, added order untouched |
| PH-05 | built | full | e2e-tt128-photos: delayed EXIF reordering cannot change an active editor walk; reopening takes the new order; e2e: mount: photos; tt121-core: PH-05 photo sort: name/size/date, missing values last ascending, copy sorted (+1) |
| CN-07 | built | full | e2e-tt121: MD-10/NT-05/CN-07/AX-23: speed select, note sort, contact facet, drawn star; e2e: mount: contacts; tt121-core: CN-07 contact facets: blank vCard fields do not count as present |
| BK-09 | built | full | e2e: mount: backup; tt121-core: BK-09 backup filename: local date, strict round-trip |
| TM-05 | built | full | e2e-tt121: ED-05/TM-05: editor sorts the buffer; terminal sort reads a real file; e2e: mount: terminal; tt121-core: TM-05 terminal sort/uniq: numeric mode, adjacent vs global uniq |
| NT-05 | built | full | e2e-tt121: MD-10/NT-05/CN-07/AX-23: speed select, note sort, contact facet, drawn star; e2e: mount: notes; tt121-core: NT-05 note sort: pinned lead, title case-insensitive, updated newest first |
| AP-06 | built | full | e2e: mount: apps; tt121-core: AP-06 app filter: group facet exact, query spans title+group+summary |
| AX-23 | built | full | e2e-tt121: MD-10/NT-05/CN-07/AX-23: speed select, note sort, contact facet, drawn star; e2e: mount: browser |
| ED-04 | built | full | e2e-tt120: ED-04/TM-04: editor stats count the buffer; terminal tail reads a real file; e2e: mount: editor; tt120-core: ED-04 line nav + stats: clamped, wc-consistent |
| NT-04 | built | full | e2e: mount: notes; tt120-core: NT-04 note export: filename cannot escape, front-matter stands alone |
| PL-05 | built | full | e2e: mount: planner; tt120-core: PL-05 due presets: local end-of-day, +1/+7 days |
| WD-04 | built | full | e2e-tt120: WD-04: world clock rows carry a business-hours verdict; e2e: mount: clock; tt120-core: WD-04 zone status: weekday 09-17 open, weekend closed |
| TM-04 | built | full | e2e-tt120: ED-04/TM-04: editor stats count the buffer; terminal tail reads a real file; e2e: mount: terminal; tt120-core: TM-04 head/tail: whole file when short, -n parsing |
| BK-08 | built | full | e2e: mount: backup; tt120-core: BK-08 freshness: never/fresh/stale against the stated threshold |
| SR-10 | built | full | e2e-tt133-notes-find: Regex repair: native Worker times out hostile backtracking while the UI continues painting, then a corrected filter recovers; e2e-tt133-notes-find: Regex patch attack: three genuine metadata pages accumulate 65 matches; all pass the worker's 50-text messages under one total budget; e2e: mount: find (+1) |
| PH-04 | built | full | e2e-tt120: PH-04: next/previous walk the shown photos and stop at the end; e2e-tt128-photos: delayed EXIF reordering cannot change an active editor walk; reopening takes the new order; e2e-tt128-photos: a navigation click survives the current image finishing its real load between pointer down and up (+5) |
| MU-03 | built | full | e2e: mount: music; tt120-core: MU-03 provider facet: counts, all explicit, unknown matches nothing |
| CN-06 | built | full | e2e-tt120: CN-06: starring a contact persists and filters; e2e: mount: contacts; tt120-core: CN-06 stars: validated set, toggle round-trips |
| AX-22 | built | partial | e2e: mount: browser |
| ED-03 | built | full | e2e-tt119: ED-03/TM-03: editor replaces all; terminal wc counts a real file; e2e: mount: editor; tt119-core: ED-03 find/replace: literal, counted, nth-only, empty refused |
| NT-03 | built | full | e2e: mount: notes; tt119-core: NT-03 daily note: local title, both conventions, no guessing |
| PL-04 | built | full | e2e-tt119: PL-04: filtering to gibberish reports no match, not an empty planner; e2e: mount: planner; tt119-core: PL-04 task filter: query+status, order preserved |
| CK-04 | built | full | e2e-tt119: CK-04/WD-03: a zone can be added; the converter answers with a date; e2e: mount: clock; tt119-core: CK-04 zone list: Intl-validated, UTC pinned, capped |
| WD-03 | built | full | e2e-tt119: CK-04/WD-03: a zone can be added; the converter answers with a date; e2e-tt128-time: Clock: local date controls and explicit overlap/gap choices; e2e: mount: clock (+5) |
| TM-03 | built | full | e2e-tt119: ED-03/TM-03: editor replaces all; terminal wc counts a real file; e2e: mount: terminal; tt119-core: TM-03 wc: UTF-8 bytes, POSIX lines |
| BK-07 | built | full | e2e: mount: backup; tt119-core: BK-07 engine: folder rollup, unknown not zero; tt119-core: BK-07 bundle explorer: flat entries become a sized folder tree |
| SR-09 | built | full | e2e-tt119: PH-03/SR-09: slideshow starts on a seeded library; a search becomes recent; e2e: mount: find; tt119-core: SR-09 recents: dedup-to-front, mode validated, capped |
| PH-03 | built | full | e2e-tt119: PH-03/SR-09: slideshow starts on a seeded library; a search becomes recent; e2e: mount: photos; tt119-core: PH-03 slideshow: wraps, clamps, empty has no next (+7) |
| MU-02 | built | full | e2e: mount: music; tt119-core: MU-02 recent plays: front-dedup, validated, capped |
| AX-21 | built | partial | e2e: mount: browser |
| DF-01 | built | full | e2e-tt118: DF-01: Editor diffs a saved version against the edited buffer; e2e: mount: editor; tt118-core: DF-01 diff: line ops in order, stats, one-word change reads as one word |
| NT-02 | built | full | e2e: mount: notes; tt118-core: NT-02 tags/links: headings and URLs are not tags, backlinks reverse exactly; tt133-core: Wiki-link graph refuses duplicate saved titles in both directions; backlinks reverse only actual unambiguous navigation edges |
| PL-03 | built | full | e2e-tt118: PL-03/PH-02: agenda view and photo timeline render from real data; e2e: mount: planner; tt118-core: PL-03 agenda: buckets by whole local days, done and undated separated |
| WD-01 | built | full | e2e-tt118: CV-01/WD-01/WD-02: converter is exact; overlap and countdown render; e2e: mount: clock; tt118-core: WD-01 zone overlap: London/New_York share an afternoon; Tokyo shares none |
| WD-02 | built | full | e2e-tt118: CV-01/WD-01/WD-02: converter is exact; overlap and countdown render; e2e: mount: clock; tt118-core: WD-02 countdowns: whole days, validation |
| CV-01 | built | full | e2e-tt118: CV-01/WD-01/WD-02: converter is exact; overlap and countdown render; e2e: mount: calculator; tt118-core: CV-01 converter: exact definitions, affine temperature, cross-category refused |
| UC-01 | built | full | e2e-tt118: UC-01/TM-02: clean-link control exists; terminal suggests the real command; e2e: mount: browser; tt118-core: UC-01 clean link: trackers listed, load-bearing params kept, non-URL refused |
| ST-10 | built | full | e2e: mount: settings; tt118-core: ST-10 settings import: unknown and locked keys reported, never applied by parsing |
| BK-14 | built | full | tt118-core: BK-06 backup compare: added/removed/changed/unchanged and byte delta |
| TM-02 | built | full | e2e-tt118: UC-01/TM-02: clean-link control exists; terminal suggests the real command; e2e: mount: terminal; tt118-core: TM-02 suggestion: transposition costs one, short inputs get nothing |
| PH-02 | built | full | e2e-tt118: PL-03/PH-02: agenda view and photo timeline render from real data; e2e: mount: photos; tt118-core: PH-02 photo timeline: local months, undated counted, largest month by bytes (+1) |
| SV-01 | built | full | e2e-tt118: SV-01: a saved search persists and re-applies its query; e2e: mount: find; tt118-core: SV-01 saved searches: modes validated, duplicate names refused, sorted newest first |
| AX-20 | built | partial | e2e: mount: browser |
| CK-01 | built | full | e2e-tt117: CK-01/02/03 in Clock: add an alarm, see next fire and the date calculator; e2e-tt130-alarms: control: an open Clock window fires the same alarm; e2e-tt130-alarms: an alarm still fires in the shell after its Clock window closes (+44) |
| CK-02 | built | full | e2e: mount: clock; tt117-core: CK-02 lap splits: deltas, fastest/slowest, monotonic refusal |
| CK-03 | built | full | e2e-tt117: CK-01/02/03 in Clock: add an alarm, see next fire and the date calculator; e2e-tt128-time: Clock: local date controls and explicit overlap/gap choices; e2e: mount: clock (+3) |
| NT-01 | built | full | e2e-tt117: NT-01 in Notes: statistics follow the text being edited; e2e: mount: notes; tt117-core: NT-01 note stats: code excluded, outline, links, reading time |
| PL-01 | built | full | e2e-tt128-time: Planner: week columns and completion counts survive midnight DST transition; e2e: mount: planner; tt117-core: PL-01 recurrence: daily/weekly BYDAY/monthly clamp/count/until + RRULE round-trip (+5) |
| PL-02 | built | full | e2e: mount: planner; tt117-core: PL-01 recurrence: daily/weekly BYDAY/monthly clamp/count/until + RRULE round-trip; tt117-core: PL-02 ICS RRULE round-trip: import carries the rule, export re-emits it (+4) |
| CB-01 | built | full | e2e-tt117: CB-01/RT-01/FN-01/BR-01 controls exist with their full names; e2e: mount: clipboard; tt117-core: CB-01 clipboard export/import: sensitive refused, dedupe, malformed refused whole |
| RT-01 | built | full | e2e-tt117: CB-01/RT-01/FN-01/BR-01 controls exist with their full names; e2e: mount: routines; tt117-core: RT-01 routine io: whitelist re-validated, duplicate names skipped not overwritten |
| FN-01 | built | full | e2e-tt117: CB-01/RT-01/FN-01/BR-01 controls exist with their full names; e2e: mount: find; tt117-core: FN-01 find: literal escape, regex error, whole word, positions, cap |
| RC-40 | built | full | e2e-tt117: RC-40 in Recall: manifest controls answer to their names; e2e: mount: recall; tt117-core: RC-40/41/42 recall report: deterministic manifest, verify diff, stats, duplicates |
| RC-41 | built | full | e2e-tt117: RC-40 in Recall: manifest controls answer to their names; e2e: mount: recall; tt117-core: RC-40/41/42 recall report: deterministic manifest, verify diff, stats, duplicates |
| RC-42 | built | full | e2e-tt117: RC-40 in Recall: manifest controls answer to their names; e2e: mount: recall; tt117-core: RC-40/41/42 recall report: deterministic manifest, verify diff, stats, duplicates |
| BR-01 | built | full | e2e-tt117: CB-01/RT-01/FN-01/BR-01 controls exist with their full names; e2e: mount: browser; tt117-core: BR-01 browser session io: unsafe URLs dropped and reported, groups preserved |
| AX-19 | built | full | e2e: mount: browser; tt117-density: AX-19: Recall under 160 words, Browser under 90, both drawn not emoji |
| SP-01 | built | full | e2e-tt117: SP-01 in Spec: the register health panel renders a verdict; e2e: mount: spec; tt117-core: SP-01 register health: duplicates, missing suites, unclaimed built rows, unknown claims (+4) |
| AX-18 | built | full | tt116-density: AX-18: Recall shows fewer than 170 visible words and more than 45 drawn marks; tt116-density: every control whose caption was removed still answers to its full name; tt116-density: no shortened word sits outside the name its control answers to (+4) |
| RC-39 | built | full | e2e: mount: recall; tt114-recall-token: a publication carrying a token writes one pair and reports the digest it filed; tt114-recall-token: the client aborts mid-flight and retries: exactly one memory exists and the retry names it (+6) |
| AX-17 | built | full | e2e-tt114-density: AX-17: the memory toolbar shows at most 24 words, and every button is a drawn glyph; e2e-tt114-density: AX-17: shortening the labels cost no control its name; e2e-tt114-density: AX-17: the browser's split, tear-out and tab-side controls are named glyphs (+3) |
| AX-16 | built | full | e2e-tt113-density: recall opens as a tool, not a document; e2e-tt113-density: browser opens as a tool, not a document; e2e-tt113-density: the small print was moved, not deleted (+2) |
| RC-38 | built | full | e2e-tt112-resident: the page builds its own objects and Recall lists them without asking the origin for anything; e2e-tt112-resident: a live MediaSource is refused by name instead of being saved as a file; e2e-tt112-resident: FALSIFIER: with the origin stopped, the bytes the page built are archived byte-for-byte (+6) |
| RC-37 | built | full | e2e-tt111-recall: a page browsed inside Recall lists the media it loaded, with its type and size; e2e-tt111-recall: with the origin shut down, the human presses Save and the archive receives the publisher’s exact bytes; e2e-tt111-recall: Forget removes a held item from the pane immediately, and the switch empties it and says so (+8) |
| RC-35 | built | full | e2e-tt110-shell: a saved memory reaches the clipboard with identical pixels, honestly described, and can be handed to another app; e2e: mount: recall |
| RC-36 | built | full | e2e: mount: recall; tt110-core: the capture policy is enforced where the writing happens, not only where the buttons are; tt110-core: an unknown capture policy value cannot be smuggled into the setting (+1) |
| RC-34 | built | full | e2e-tt109-shell: a repeat save files a second memory unless the person asks to keep one copy; e2e: mount: recall; tt109-recall: an identical memory in the same folder is recognised instead of filed twice (+7) |
| RC-27 | built | full | e2e-tt107-memory: searching by save method finds the memory through the real UI; e2e-tt107-memory: a filter that matches nothing reports an honest empty result, not an error; e2e: mount: recall (+16) |
| RC-28 | built | full | e2e-tt107-memory: the integrity report shows a healthy pair with no orphans; e2e-tt107-memory: an unpaired file is listed by the audit and can be trashed from the UI; e2e-tt107-memory: widening the scope to every folder is an explicit, visible choice (+23) |
| RC-29 | built | full | e2e: mount: recall; tt107-crash: SIGKILL between the two writes leaves no half pair and no orphan metadata; tt107-crash: server restarts and the same payload then publishes the exact pair (+6) |
| RC-30 | built | full | e2e: mount: recall; tt108-engine-crash: every acknowledged publication survived the engine crash, complete and intact; tt108-engine-crash: no half pair survived the crash, including the publications in flight (+10) |
| RC-31 | built | full | e2e: mount: recall; tt108-recall: the page agent encodes already-decoded visuals and never requests a URL again; tt108-recall: every member of a batch is published as its own complete, independent pair (+4) |
| RC-32 | built | full | e2e-tt108-recall: the saving timeline shows the real days and filters the list to the chosen one; e2e-tt108-recall: the timeline says plainly that it is not a background screenshot trail; e2e: mount: recall (+8) |
| RC-33 | built | full | e2e-tt108-recall: dragging over a decoded preview reports the region without saving anything yet; e2e-tt108-recall: a dragged region is saved as its own memory, cut from the decoded preview; e2e-tt108-recall: the saved crop records the memory and rectangle it came from (+13) |
| RC-24 | built | full | e2e-tt106-memory: single-snapshot receipt inspection works in actual UI; e2e: mount: recall; tt106-lifecycle: single snapshot returns verified pair identity without media bodies (+2) |
| RC-25 | built | full | e2e-tt106-memory: cancelled trash confirmation changes nothing; e2e: mount: recall; tt106-lifecycle: paired trash removes both active files and both search entries (+4) |
| RC-26 | partial | partial | e2e-tt106-memory: save already-open frame creates native green PNG without upstream HTTP; e2e-tt106-memory: real decoded WebM video preview saves its exact current frame, no media refetch; e2e-tt106-memory: memory above the 16 MP decode bound is refused and clears the stale preview (+1) |
| RC-22 | built | full | e2e: mount: recall; tt105-atomic: one acknowledgement publishes both exact media and receipt; tt107-crash: SIGKILL between the two writes leaves no half pair and no orphan metadata (+4) |
| RC-23 | partial | partial | e2e-tt105-clicked: no pointer selection refuses without a largest fallback; e2e-tt105-clicked: native pointer chooses smaller decoded canvas without asset refetch; e2e: mount: recall |
| RC-16 | built | full | e2e-tt104-memory: native clipboard image-transfer experiment records the real permission boundary; e2e: mount: recall; tt104-memory-unit: single native File admitted without rewriting its bytes (+2) |
| RC-17 | built | full | e2e-tt104-memory: native webpage-link drag is rejected, never refetched; e2e: mount: recall; tt104-memory-unit: single native File admitted without rewriting its bytes (+1) |
| RC-18 | built | full | e2e-tt104-memory: resident file save then paged timeline opens actual stored PNG; e2e-tt104-pages: native UI loads first metadata page and refuses continuation after grouping changes; e2e: mount: recall (+2) |
| RC-19 | built | full | e2e-tt104-memory: UI receipt verification checks the stored pair; e2e: mount: recall; tt104-memory-unit: valid stored-byte receipt matches exact SHA-256 (+2) |
| RC-20 | built | full | e2e-tt104-memory: local Blob export downloads exact open bytes, no upstream request; e2e: mount: recall; tt137-recall-engines: RC-20 · exportMemory returns payload (+1) |
| RC-21 | built | full | e2e-tt104-memory: streaming discovery preserves a late first-200 visual after 2005 nonvisual elements; e2e: mount: recall; tt137-recall-engines: RC-21 · discoverSurfaces lists non-trashed |
| RC-01 | built | partial | e2e-tt103-memory: human-selected actual PNG bytes save unchanged with honest method receipt; e2e-tt113-density: recall opens as a tool, not a document; e2e-tt113-density: browser opens as a tool, not a document (+5) |
| RC-02 | built | full | e2e-tt109-shell: a copied image becomes a memory through the real paste handler, and a copied link does not; e2e-tt111-recall: a page browsed inside Recall lists the media it loaded, with its type and size; e2e: mount: recall (+1) |
| RC-03 | built | full | e2e-tt103-memory: saving loaded visual uses already rendered pixels and no asset request; e2e: mount: recall; tt137-recall-engines: RC-03 · recall by visual properties |
| RC-04 | built | full | e2e-tt110-recall: a human-authorized display snapshot really captures the screen surface and files it as a memory; e2e: mount: recall |
| RC-05 | built | partial | e2e-tt110-recall: an authorized recording encodes real frames and finishes as a playable file; e2e-tt110-recall: audio-only output does what this platform actually allows, and never substitutes the microphone; e2e-tt114-density: AX-17: the memory toolbar shows at most 24 words, and every button is a drawn glyph (+2) |
| RC-06 | built | partial | e2e-tt110-recall: an already-rendered element in this document can be captured without touching the network; e2e: mount: recall |
| RC-07 | built | full | e2e-tt103-memory: timeline actually lists saved file and replay decodes in native image element; e2e: mount: recall; tt137-recall-engines: RC-07 · timeline is chronological |
| RC-08 | built | full | e2e-tt103-memory: timeline actually lists saved file and replay decodes in native image element; e2e: mount: recall; tt137-recall-engines: RC-08 · replay returns timeline |
| RC-09 | built | full | e2e-tt103-memory: human-selected actual PNG bytes save unchanged with honest method receipt; e2e-tt112-resident: FALSIFIER: with the origin stopped, the bytes the page built are archived byte-for-byte; e2e-tt112-resident: an object larger than 8 MiB is refused where the bytes are read, and writes nothing (+3) |
| RC-10 | built | full | e2e: mount: recall; tt109-recall: grouping sends the same bytes to the folder the human chose, and cannot escape the Recall root; tt109-recall: a save outside the Recall root is refused whatever the grouping asked for (+2) |
| RC-11 | built | partial | e2e-tt103-memory: saving loaded visual uses already rendered pixels and no asset request; e2e-tt110-recall: a human-authorized display snapshot really captures the screen surface and files it as a memory; e2e-tt110-recall: the shared surface is released when the snapshot ends, and nothing is captured afterwards (+4) |
| RC-12 | partial | partial | e2e: mount: recall; tt109-recall: memories are never written into Persistent Storage, and the archive says so plainly |
| RC-13 | built | full | e2e: mount: recall; tt109-recall: deleting a memory removes the pair together and restoring brings the pair back; tt109-recall: a memory cannot be half-deleted through the pair endpoint (+8) |
| RC-14 | built | full | e2e-tt112-resident: a live MediaSource is refused by name instead of being saved as a file; e2e-tt112-resident: the receipt claims a declared label, not the publisher, and records no refetch; e2e: mount: recall (+3) |
| RC-15 | built | full | e2e: mount: recall; tt109-recall: memories are never written into Persistent Storage, and the archive says so plainly; tt109-recall: the exclusions that exist are real: query tokens are dropped and a declared label cannot smuggle them back (+3) |
| SH-01 | built | full | e2e-tt55-shell: SH-01 one registry: launcher tiles = palette app results = src/lib/registry.ts (same ids, titles, count); a tile and a palette row each open their module |
| SH-02 | built | full | e2e-tt55-shell: SH-02 shelf = windows: one shelf button per window of the active workspace (= persisted state), through open, middle-click close, and a workspace with other windows |
| SH-03 | built | partial | e2e-tt107-shell: the top bar shows a live clock in the user's own locale format; e2e-tt107-shell: the top bar exposes launcher, search, overview and quick panel as real controls; e2e-tt107-shell: the top bar reports live system status rather than a static badge |
| SH-04 | built | full | e2e-tt55-shell: SH-04 desktop icons follow the file system: a folder trashed in Files disappears from the desktop with no reload — in the same tab and in a second tab of the browser — and the icon set always equals the server listing; e2e-tt98-orbit: Desktop rectangle selects visible icons; e2e-tt98-orbit: Desktop item menu copies real VFS paths and does not open background menu (+6) |
| SH-05 | built | partial | e2e: SH-05 under full site isolation (--site-per-process): hung widget greys, shell responsive |
| SH-06 | built | full | e2e-tt67-input: SH-06 hot corner with real pointer moves: entering the top-left corner opens the launcher; after Escape, a pointer resting / jittering in the corner for 3 s does NOT reopen it; leaving and re-entering does; with Hot corners off nothing opens; e2e-tt86-pointer: SH-06 all four hot corners open their mapped shell panels once per entry; e2e-tt86-pointer: SH-06 all four viewport edges require an inward flick and open the matching panel (+16) |
| SH-07 | built | full | e2e-tt112-shell: SH-07 first run: the capability report is measured in this browser, not asserted; e2e-tt112-shell: SH-07 licence: a local trial is granted without any account, and the server holds the public key; e2e-tt112-shell: SH-07: the capability report reaches the server only when a human asks for it (+1) |
| SH-08 | built | full | e2e-tt114-tabs: PR-07r: tabs, the active tab, groups and the split survive a reload; e2e-tt48-sync: reducer 'reconcile': the newer desktop's shared data wins, this tab keeps exactly its own windows/focus, z order stays monotonic, revision never goes back; e2e-tt48-sync: a fresh tab hydrates at the row revision even when the stored state JSON lacks one, so its first save is accepted (no 409) (+6) |
| SH-09 | built | full | e2e-tt55-files: SH-09 history: double-click in, breadcrumbs, Back / Forward buttons, Alt+← / Alt+→, Backspace, mouse buttons 4 / 5 navigate the pane and never the browser tab; a new navigation clears Forward; tt55-files-unit: SH-09 back / forward history = browser model (entries + index) over 3 000 random sequences, incl. the 50-entry cap |
| SH-10 | built | full | e2e: Overview (Meta+Q) and Blackout overlay toggle; tt145-engines: SH-10 blackout: a flat single layer draws 1 fps instead of 60, every other fill is refused with a reason, and touches coalesce no faster than the display |
| SH-11 | built | full | e2e-tt72-pad: a real drag on the tab's Blackout pad moves the focused window on display 2 (DOM + persisted); the tab's window stays; e2e-tt72-pad: keys on the Blackout screen drive display 2: arrows (+Shift), Tab cycles, Enter maximises, Home shows desktop; e2e-tt72-pad: adversary on the channel: wrong recipient, malformed shapes, replayed / stale seq change nothing; a fresh message does (+8) |
| SH-12 | built | full | e2e-tt112-shell: SH-12: real long tasks drive the governor into a throttled state and the shell drops effects; e2e-tt112-shell: SH-12: the detector is a measurement, not a latch — effects return once the load stops; e2e-tt114-shell: LN-09: the scene animates when it should and stops dead when the shell is under load |
| SH-13 | built | full | e2e-tt152-boot: superseded bootstrap cannot consume a cold-start launch intent; e2e-tt85: E1 AP-01 app hub: the live module registry is launchable; real manifest handlers, display mode and origin quota are shown without inventing installed apps or OS associations; e2e-tt89-launch: cold browser navigation opens a documented protocol intent and suppresses its duplicate queue delivery (+28) |
| SH-14 | built | full | e2e-tt128-worker: successful worker install and activation; API and query URLs never enter the cache; e2e-tt128-worker: offline API reports 503 and non-desktop navigation shows the explicit fallback; e2e-tt129-offline: first installation can boot a new offline desktop without an online reload (+11) |
| WM-01 | built | full | e2e-tt114-tabs: PR-07j: tearing a tab out opens a second browser window on that page; e2e-tt98-orbit: App fallback opens, keyboard navigates, Escape restores invoking control; e2e-tt98-orbit: Native text context is not intercepted (+4) |
| WM-02 | built | full | e2e-tt110-banner: in Art layout a window does not repeat the menus the shell menu bar is already showing; e2e-tt110-banner: an unfocused window keeps its own menus, because the shell bar only shows the focused one; e2e-tt110-banner: the fonts and alignment bar fits inside the window instead of scrolling sideways (+6) |
| WM-03 | built | full | e2e-tt114-shell: WM-03: a window moves between named workspaces and only its own workspace is shown; unit: reducer is pure (input not mutated); workspaces filter without unmounting |
| WM-04 | built | full | e2e-tt114-shell: WM-04: Overview lists every live window with its real geometry, and the filter narrows it; e2e: Overview (Meta+Q) and Blackout overlay toggle |
| WM-05 | built | full | e2e-tt56: WM-05 MRU after 5 focus changes, held-chord switcher: overlay lists MRU order, chord advances, Shift reverses, release commits, Esc cancels; e2e-tt56: WM-05 modes: app mode groups windows by app (2 calculators → 1 entry), workspace mode switches workspace on release; ←/→ and 1/2/3 change mode; e2e-tt56: WM-05 modal failure test: with an ask dialog open the switcher chord does nothing (no overlay, focus unchanged) (+6) |
| WM-06 | built | full | e2e: mount: browser; tt145-engines: WM-06 broker: a blocking origin is probed once then remembered, silence is treated as blocked, a handoff is chosen for a running app, and only S1/S2/S3 claim to bring the other app in |
| WM-07 | built | full | e2e-tt112-shell: every capability claim matches what this browser actually exposes (no invented support); tt143-engines: WM-07 hotplug: park and restore are reversible, and a user move survives the round trip |
| WM-08 | built | full | tt55-files-unit: WM-08 remembered geometry: close records the normal rect per module/host (restore rect when maximized), the next open reuses it, an explicit rect wins, no exact stacking, fits a smaller viewport, bounded, closeAll records all |
| WM-09 | built | full | e2e: keyboard tiling: Meta+ArrowLeft snaps the focused window to the left half; unit: 10 000 random commands preserve every invariant |
| WM-10 | built | full | e2e-tt56: WM-10 focus mode: Meta+Shift+F sets ONE parent CSS variable; unfocused windows read it (opacity .45), the focused one stays 1; OSD; toggles back |
| WM-11 | built | full | e2e-tt109-shell: the always-on-top pop-out takes the real capability branch this browser has, with its styles carried over; tt145-engines: WM-11 PiP: a request outside the usable range clamps to the content aspect, an oversized stylesheet clone is refused, an empty adoption produces nothing, and a hidden tab closes the window instead of keeping it |
| WM-12 | built | full | e2e-tt114-shell: WM-12: two windows hold different densities and zooms at the same time; e2e-tt114-shell: WM-12: the window menu changes only its own window, and the choice survives a reload; e2e-tt114-shell: no page error was raised by any of this turn's shell work (+2) |
| WM-13 | built | full | e2e-tt70-rows: WM-13 edge-hold: a real drag held at the right edge ≥600 ms moves the window to the next workspace (no tiling on release); refused at the last workspace (half-snap still works); a 300 ms touch does nothing; the left edge hops back; tt70-edge: edge zones are 8 px at each side (inclusive); a desktop too narrow for two zones has none; NaN never matches; tt70-edge: neighbours follow list order (non-contiguous ids); none past either end or for an unknown active workspace (+3) |
| WM-14 | blocked | untested |  |
| WM-15 | built | full | e2e-tt108-shell: a canvas-backed window really is a live video source; tt143-engines: WM-15 capture: recording is ready, casting a live stream is refused, tab-audio is disclosed |
| WM-17 | built | partial | tt107-features: raw proxy re-serves a framing-refusing page without its refusal headers; tt107-features: raw proxy anchors relative subresources with a base href and defuses framebusting; tt107-features: proxy refuses non-HTML content and missing arguments |
| WM-18 | built | partial | tt107-features: proxy refuses non-HTML content and missing arguments; tt107-features: reader mode extracts the article and drops chrome, scripts and styles; tt107-features: reader mode neutralises inline handlers and javascript: links (+3) |
| WM-19 | built | untested |  |
| IN-01 | built | full | e2e-tt66-input: positive control: a real CDP Back press on a page WITHOUT the shell navigates the tab back (the guard test is not vacuous); e2e-tt66-input: desktop: Back / Forward over the wallpaper never leave the page; Files still goes back / forward in its own history on the same buttons; e2e-tt66-input: wheel: Whiteboard pans the same distance for a real pixel notch (CDP deltaY 100), a 3-line event and (page mode) one canvas height (+3) |
| IN-02 | built | full | e2e-tt67-input: IN-02 learn: Learn Back + the device's FORWARD button → Back = 4, Forward = 3 (swapped), stored, survives reload; Files then goes Back on that button and the tab never navigates; the trailing mouseup / auxclick never reach the page; e2e-tt67-input: IN-02 refusals and modality: the overlay covers the screen; the right button is refused with a reason, the dialog stays and its context menu never reaches the page; Meta+Q behind the overlay opens nothing; Escape cancels without changing the pair; tt67-input: IN-02 config: stored indices are validated (0 / 2 / non-numbers / >31 / Back = Forward fall back to 3 / 4); the server validator agrees with the client rule on every input (+3) |
| IN-03 | built | full | e2e-tt67-input: IN-03 AZERTY at the event level: Meta + the physical Q key (types "a") opens Overview and NOT the launcher; Meta + physical A (types "q") opens the launcher and NOT Overview; Escape closes; e2e-tt67-input: IN-03 labels: typing in a password field teaches NOTHING (Snap layouts keeps its label); the same AZERTY keys typed elsewhere relabel Meta+Z → Meta+W and Meta+Q → Meta+A; tt67-input: IN-03 layout property: on 5 layouts × 3 presets, a chord's physical key fires that chord and NO other (incl. the AZERTY Meta+A / Meta+Q case) (+5) |
| IN-04 | built | full | e2e-tt148: IN-04 the capture box reads the physical chord and separates browser-reserved from app-owned; e2e-tt148: IN-04 capturing a chord consumes it: the shell must not act on a key the panel is capturing; tt145-engines: IN-04 chords: a bare printable key and an OS-reserved chord are refused, a held chord latches and advances, Escape cancels, and focus loss cannot leave a modifier stuck (+1) |
| IN-05 | built | full | tt111-core: no preset collides with itself, and every browser-reserved chord ships with the reason it is reserved; unit: shortcut presets have no internal conflicts; chord matcher |
| IN-07 | built | full | e2e-tt37: gamepad pointer (IN-07) with a scripted W3C-shape pad (no physical controller exists in this sandbox — the hardware is substituted, everything from navigator.getGamepads() on is real): appears on connect, the stick steers it onto the launcher button and A opens the launcher, B (Escape) closes it, X opens the desktop menu, the right stick scrolls the window under it, RB moves keyboard focus and the pointer follows, Start turns it off and on, disconnect removes it; no page errors; e2e: mount: devices; tt141-gamepad-pointer: IN-07 · the deadzone is radial, so a diagonal inside it is still dead (+12) |
| IN-08 | blocked | untested |  |
| SR-01 | built | full | e2e-tt92-trash: Trash exposes origin, recorded deletion date, real folder bytes and its manual-retention/backup boundary; e2e-tt92-trash: restoring the selected folder in Files reveals the original files and rebuilds search; e2e: mount: find (+31) |
| SR-02 | built | partial | e2e-tt99-interactions: Find contextual Open routes a real CSV into the editor rather than window controls; e2e-tt99-interactions: a stale Find result cannot open a deleted file or silently create a document; e2e: mount: find (+2) |
| SR-03 | built | full | e2e: palette: Ctrl+Space, typo 'noets' surfaces Notes with provenance; Enter opens it; integration: SR-03 typo tolerance over HTTP: 'noets' finds the notes; junk finds nothing; unit: OSA distance counts adjacent transposition as 1 (+1) |
| SR-04 | built | full | e2e-tt58-rows: SR-04 web results: off by default — no web row and no outside request while typing; opted in — one explicit row ranked last with the provider URL, still nothing sent until it is picked |
| SR-05 | built | full | integration: search treats % and _ in queries literally; tt110-core: search can be confined to one folder, and says what it searched when it finds nothing; tt116-platform: SR-05: a scoped search excludes a matching document outside the scope (+2) |
| SR-06 | built | full | e2e-tt97-calculator-repairs: empty history is a named region; removing its role reintroduces the original axe violation; e2e-tt97-calculator-repairs: empty and populated programmer history remain axe-clean; e2e-tt97-calculator-repairs: mode colors change atomically; injecting a slow background-only transition is detected (+36) |
| SR-07 | blocked | partial | tt107-features: every capability declared blocked is still refused with a stated reason |
| SR-08 | built | full | e2e: mount: find; tt110-core: search can be confined to one folder, and says what it searched when it finds nothing; tt116-platform: SR-08: an empty query reports coverage per source instead of guessing (+2) |
| FM-01 | built | full | e2e-contacts: Files integration and launcher: a .vcf reached in Files with the keyboard alone (arrows, Space, Enter) opens in Contacts; Contacts is in the launcher; e2e-privacy: Files ▸ Remove metadata (copy) on a host .docx; overwrite mode also forgets the version that still held the author; e2e-tt55-files: FM-15 selection toolbar: click, Shift-range, Ctrl-toggle, Ctrl+A, Esc; count and size equal the server's sizes; batch trash then batch restore from Trash (+7) |
| FM-02 | built | full | e2e-tt55-files: FM-02 + FM-03 dual pane: Ctrl+C / Ctrl+V across panes copies byte-identically, a second paste picks conflict-free names, Ctrl+X moves, F5 copies to the other pane; e2e-tt55-files: FM-02 drag and drop: a row dragged onto the other pane moves it, Ctrl-drag copies, a row dropped on a folder row moves it into that folder (server-verified); e2e-tt55-files: FM-02 stress witness: repeated unselected native drags land in the folder row without a layout-shift race (+2) |
| FM-03 | partial | partial | e2e-tt55-files: FM-02 + FM-03 dual pane: Ctrl+C / Ctrl+V across panes copies byte-identically, a second paste picks conflict-free names, Ctrl+X moves, F5 copies to the other pane; e2e-tt55-files: FM-02 drag and drop: a row dragged onto the other pane moves it, Ctrl-drag copies, a row dropped on a folder row moves it into that folder (server-verified); e2e-tt93-sidecar: Files displays the destination-sidecar collision and keeps both the photo and edits intact (+122) |
| FM-04 | built | partial | e2e-ai: hostile/edge files: Illustrator data without a PDF part is not rendered; an inflate bomb and 2000+ streams finish inside the 5 s watchdog; e2e: mount: peek; integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades |
| FM-05 | built | full | e2e-tt55-files: FM-15 keyboard file operations: F2 renames, Delete trashes, Shift-range compress builds one archive (zipfile-verified), selection batch rename touches only the selection; e2e-tt79-archive: 1 AES archive: derived folders, navigation, locked preview; MODAL SHORTCUT (Delete/F2/Ctrl+A inert behind the password dialog); wrong → asked again; right → exact text; PNG preview; e2e-tt79-archive: 2 keyboard edits: Delete + F2 + New folder → Save → pyzipper decrypts the renamed entry with the ORIGINAL password; Undo restores (+16) |
| FM-06 | built | full | e2e-tt55-files: FM-06 context menu: concise vs full sets, type-to-search reaches any action, arrow keys + Enter run it, Esc closes; background menu has New / templates / Paste; e2e-tt98-orbit: Files context Copy preserves all rectangle-selected paths; e2e-tt98-orbit: Existing file menu takes precedence over app fallback (+2) |
| FM-07 | built | full | e2e-tt81: E6 Storage overview (FM-07) and Uninstall assistant (AP-02): duplicate digest detection, live per-bucket preview, confirmation gate and selective purge; e2e: mount: storage; integration: FM-11 trash → restore is exact; FM-07 finds duplicates by digest (+5) |
| FM-08 | built | full | e2e-tt87-localdisk: BK-02 real browser folder handle survives IndexedDB reload and a first sync preserves skipped names and binary data; e2e-tt87-localdisk: FM-08 import selects a conflict-free name and keeps the original Fusion file byte-for-byte; e2e-tt87-localdisk: FM-08 conditional write rejects missing preconditions, existing names and changed versions without modifying data (+2) |
| FM-09 | built | full | e2e-tt55-files: FM-09 / DP-03 origin badges: rows say where bytes live; offline, a new file shows as a 'queued' ghost row and becomes a real server row after replay; e2e-tt96-files-contrast: dark unhovered selected server badge is readable across all 13 styles; e2e-tt96-files-contrast: dark hovered selected server badge is readable across all 13 styles (+6) |
| FM-10 | blocked | untested |  |
| FM-11 | built | full | e2e-tt91-purge: confirmation states retention limits, rejects wrong text and cancellation leaves every row intact; e2e-tt91-purge: confirming permanent folder deletion removes live/history/index rows and preserves an unrelated file; e2e-tt92-trash: Trash exposes origin, recorded deletion date, real folder bytes and its manual-retention/backup boundary (+60) |
| FM-12 | blocked | partial | tt107-features: every capability declared blocked is still refused with a stated reason |
| FM-13 | built | full | e2e-tt55-files: FM-13 New from template: the menu lists /System/Templates from the server; a new file is a byte copy of the template; a second one gets a free name; e2e-tt98-orbit: New desktop folder is backed by a real directory; e2e-tt98-orbit: New text file collision cannot truncate an existing document (+3) |
| FM-14 | built | full | tt145-engines: FM-14 drop: a real download wins, a browser without DownloadURL gets an explicit button, a hidden tab and a 51-file drop are refused, and a file drop never pretends to carry text; tt146-core: FM-14 drag payloads: types we publish, drops we accept, keyboard alternative |
| FM-15 | built | full | e2e-tt55-files: FM-15 selection toolbar: click, Shift-range, Ctrl-toggle, Ctrl+A, Esc; count and size equal the server's sizes; batch trash then batch restore from Trash; e2e-tt55-files: FM-15 keyboard file operations: F2 renames, Delete trashes, Shift-range compress builds one archive (zipfile-verified), selection batch rename touches only the selection; e2e-tt98-orbit: Files rectangle selects intersecting rows without opening or clearing on release (+13) |
| FM-16 | built | full | e2e-tt55-files: FM-16 quick filter + Subfolders: deep matches equal a recursive walk of the server; % and _ are literal; dotfiles and /System stay out |
| FM-17 | built | full | e2e-tt55-files: FM-17 folder sizes: every folder row shows the size of its subtree (= a recursive walk of the server), and the cached size refreshes after a write |
| FM-18 | built | full | e2e-tt99-interactions: Editor Keep controls remain present after loading and Save persists content plus the previous version; e2e: mount: files; e2e: editor: open via terminal, edit, Ctrl+S → saved and a version snapshot exists (+61) |
| NC-01 | built | partial | e2e-tt99-interactions: Alerts object menu marks read and unread through real persisted state; e2e-tt99-interactions: Alerts pin and snooze persist without affecting another alert; e2e-tt99-interactions: Alerts context dismiss deletes only the selected alert (+1) |
| NC-02 | built | full | e2e-tt71-focus: server: rules see the live workspace / focus mode / time zone; held alerts record rule + reason; deliver releases; bad rules are refused; e2e-tt71-focus: Alerts UI: status line, held alerts listed apart with their reason, Deliver now, held test alert raises no OS notification; e2e-tt71-focus: editor: real controls build a rule; a bad workspace shows the parser's message and saves nothing; a valid rule activates; Remove clears (+9) |
| NC-03 | built | partial | e2e-tt107-shell: the quick panel opens from the top bar with its accessibility and style controls; e2e-tt107-shell: quick-panel theme is applied to the document and survives a reload; e2e-tt107-shell: quick-panel density cycles through all three settings and survives a reload (+1) |
| NC-04 | built | partial | e2e: mount: alerts |
| NC-05 | built | partial | integration: FM-03 journaled move: 6 states in order, digest preserved, source retired; tt111-core: long operations are recorded as steps that can be polled, and every one ends in a terminal state |
| NC-06 | built | full | e2e-tt56: NC-06 OSD: 20 volume changes in a burst → the pill tracks every step, the polite live region changes exactly once (settled value); e2e-tt56: WM-10 focus mode: Meta+Shift+F sets ONE parent CSS variable; unfocused windows read it (opacity .45), the focused one stays 1; OSD; toggles back; tt56-shell-unit: NC-06 settle model: 20 events 50 ms apart announce once; bursts separated by > settle announce once each; labels |
| ST-01 | built | partial | e2e-tt97-palette-actions: register keeps palette actions partial and discloses native Cast and privacy limits; e2e-tt97-palette-actions: action-mode quick note is inert while typing, stays out of search requests and creates an indexed note only on selection; e2e-tt97-palette-actions: composition Enter cannot trigger a note action; a subsequent real Enter can (+10) |
| ST-03 | built | full | e2e-tt89-launch: default-app guide changes platform, reports limits, and sends a real browser protocol request without claiming acceptance; tt137-system-engines: ST-03 · registry has system extensions; tt137-system-engines: ST-03 · getExtension finds md (+5) |
| ST-04 | built | full | e2e: mount: settings; tt111-core: the capability report is exportable and redacted: it describes the browser, not the person |
| ST-05 | built | full | e2e-tt56: ST-05 OS media queries: prefers-reduced-motion → motion token 0 ms (transitions 0 s); “Match system” theme follows prefers-color-scheme live |
| ST-06 | built | full | tt111-core: no preset collides with itself, and every browser-reserved chord ships with the reason it is reserved; unit: shortcut presets have no internal conflicts; chord matcher |
| ST-07 | built | full | e2e-tt56: ST-07 UI scale is independent of the display: device scale factor 1 vs 2 (external HiDPI display / browser-zoom emulation) gives the same CSS text size; the app's own scale changes it |
| ST-08 | blocked | untested |  |
| ST-09 | built | full | e2e-tt90-context: profiles are off initially and editing them does not change the shared appearance; e2e-tt90-context: opt-in applies the chosen profile, retains shared settings, and survives a reload; e2e-tt90-context: a real browser reacts to CDP virtual display add/remove, with an on-screen announcement (+13) |
| AP-01 | built | full | e2e-tt85: E1 AP-01 app hub: the live module registry is launchable; real manifest handlers, display mode and origin quota are shown without inventing installed apps or OS associations; e2e: mount: apps |
| AP-02 | built | full | e2e-tt81: E6 Storage overview (FM-07) and Uninstall assistant (AP-02): duplicate digest detection, live per-bucket preview, confirmation gate and selective purge; tt84-wordcount: U1 AP-02 bucket selection and purge validation refuse protected tables, duplicates, empty lists and missing DELETE confirmation; tt84-wordcount: U2 AP-02 / FM-07 preview summarization and post-purge invariant verification (+1) |
| AP-03 | blocked | partial | tt107-features: every capability declared blocked is still refused with a stated reason |
| AP-04 | built | partial | e2e-tt108-shell: the shell never takes a service-worker update without being asked; e2e-tt128-worker: failed upgrade preserves the previous activated worker and cache; e2e-tt128-worker: successful upgrade waits for consent, then activates and reloads (+5) |
| AP-05 | built | full | e2e-tt147: AP-05 the background inventory is the browser's own list, not a copy of it; e2e-tt85: E2 AP-05 inventory: actual service-worker registrations and sync tags match Chromium APIs; page callback counters are measured and clearly not OS wake counts; e2e: mount: apps (+9) |
| TD-01 | built | full | e2e: mount: terminal; e2e: terminal: write + cat through the journal; mv shows journal op |
| TD-02 | built | full | e2e: mount: terminal; e2e: terminal: write + cat through the journal; mv shows journal op |
| TD-03 | built | full | e2e-tt133-openssh: Real OpenSSH: Ed25519 login cannot start before the native UI fingerprint equals independent ssh-keygen; trust once does not persist the host key; e2e-tt133-openssh: Real shell ANSI + UTF-8: red text, combining mark, CJK and emoji render as safe spans, not HTML; e2e-tt133-openssh: Native ResizeObserver/font-size publication reaches the real PTY: stty rows equal rendered rows; size changes do not corrupt later input (+60) |
| TD-05 | blocked | partial | tt107-features: every capability declared blocked is still refused with a stated reason |
| TD-06 | built | full | unit: command log replay reproduces the identical state hash |
| PR-01 | built | full | e2e-tt99-interactions: Editor Keep controls remain present after loading and Save persists content plus the previous version; e2e: mount: editor; e2e: editor: open via terminal, edit, Ctrl+S → saved and a version snapshot exists (+4) |
| PR-02 | built | partial | e2e-tt112-shell: SH-07: the capability report reaches the server only when a human asks for it; e2e-tt97-palette-actions: register keeps palette actions partial and discloses native Cast and privacy limits; e2e-tt97-palette-actions: action-mode quick note is inert while typing, stays out of search requests and creates an indexed note only on selection (+16) |
| PR-03 | built | partial | e2e-tt129-calendar: overdue status updates when the clock passes a due time without another interaction; e2e-tt132-planner: create an undated task with literal multiline notes using the real form; e2e-tt132-planner: Enter submits the focused Planner window, not another window's duplicate global ID (+37) |
| PR-04 | built | full | e2e-tt129-calendar: preview reports known losses without inserting records; e2e-tt129-calendar: cancel is non-mutating, same-file retry imports only after confirmation, reimport deduplicates; e2e-tt132-planner: create an undated task with literal multiline notes using the real form (+58) |
| PR-05 | built | partial | e2e-contacts: create: empty book → New → fill name, e-mail, phone, birthday, two groups → Save; card links and the .vcf on disk are right; e2e-contacts: Files integration and launcher: a .vcf reached in Files with the keyboard alone (arrows, Space, Enter) opens in Contacts; Contacts is in the launcher; e2e: mount: contacts |
| PR-07a | built | full | browser-session: close: active tab hands focus to its neighbour (regression: view went blank); last tab replaced; e2e-browser: address bar refuses credential, non-http and own-origin URLs; accepts bare hosts (https); e2e-browser: Alt+T / Alt+P / Alt+1..9 / Alt+W shortcuts; pinned tabs move left; middle-click closing the active tab keeps a live tab |
| PR-07b | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07c | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07d | built | full | e2e-tt114-density: AX-17: the browser's split, tear-out and tab-side controls are named glyphs; e2e-tt114-tabs: PR-07d: a horizontal split puts two live frames side by side; e2e-tt114-tabs: no page error was raised while splitting, tearing out or restoring |
| PR-07e | built | full | e2e-tt114-tabs: PR-07e: a vertical split stacks them instead, and a third click restores one pane |
| PR-07f | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: Alt+T / Alt+P / Alt+1..9 / Alt+W shortcuts; pinned tabs move left; middle-click closing the active tab keeps a live tab |
| PR-07g | built | full | browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07h | built | full | e2e-tt35: find in page, identity and Save to Files on a real site (WP-05; PR-07h, PR-07n, PR-07m): find counts and steps through matches inside the proxied page; Mobile makes the server AND the page present a mobile browser; Save to Files writes the page's original HTML into /Downloads; e2e-tt85: E3 PR-07h per-site browser identity: desktop is the default, a mobile override is host-scoped and survives same-site navigation, and another host remains on default; tt38-unit: bridge (WP-08, PR-07h): opening through the registry reaches the independent server via the connection layer; WebSocket User-Agent comes from the target-host override rather than the session default; text and binary go both ways in order; the site sees the page's own Origin and session cookie, a 101 cookie lands in the jar, another session cannot write (410), and clean close arrives as {code, reason, wasClean} (+5) |
| PR-07i | built | full | e2e-browser: Alt+T / Alt+P / Alt+1..9 / Alt+W shortcuts; pinned tabs move left; middle-click closing the active tab keeps a live tab |
| PR-07j | built | full | e2e-tt114-tabs: PR-07j: tearing a tab out opens a second browser window on that page |
| PR-07k | built | full | e2e-tt36: Reader view in a Private proxy tab (PR-07k): a real article page (TT69: github CONTRIBUTING.md; pypi.org/help/ now 301s to docs.pypi.org, outside this sandbox) as Fusion's reader page — article text, title and reading time, no script but the runtime, opaque origin, nothing contacted but Fusion; find works in the reader; an in-article link stays in the reader with the address following; Back; 'Original page' leaves the reader and the Reader button follows; Reader off returns to the normal page; e2e-tt36: reader endpoint headers (PR-07k): the reader page is served with a CSP sandbox (no same-origin), scripts only from Fusion (no inline script), no forms; a non-page address gets a plain refusal; a private address is refused (SSRF); tt36-unit: reader vs Readability (PR-07k): on live pages from github.com and pypi.org the reader keeps everything readability-lxml calls the article (recall ≥ 0.95) and agrees on where the article starts and ends; pages a site answers with a bot challenge are skipped and named, at least 5 must be measured (+2) |
| PR-07l | built | full | browser-session: URL guard: http(s) only, bare hosts get https, credentials and own origin refused; browser-session: pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute; e2e-browser: site permissions panel writes the iframe delegation policy into the saved session |
| PR-07m | built | full | e2e-tt35: find in page, identity and Save to Files on a real site (WP-05; PR-07h, PR-07n, PR-07m): find counts and steps through matches inside the proxied page; Mobile makes the server AND the page present a mobile browser; Save to Files writes the page's original HTML into /Downloads; e2e-tt35: large downloads and media ranges through the proxy (WP-02, PR-07m): a real file bigger than the 8 MB page limit (a numpy wheel from files.pythonhosted.org) streams through whole — byte-identical to a direct download (SHA-256) — and a Range request returns 206 with exactly the requested bytes; a 9 MB upload is refused (413); e2e-tt91-browser-download: real PyPI bytes: a concurrent HTTP create after listing forces a retry without overwriting either file (+27) |
| PR-07n | built | full | e2e-tt35: find in page, identity and Save to Files on a real site (WP-05; PR-07h, PR-07n, PR-07m): find counts and steps through matches inside the proxied page; Mobile makes the server AND the page present a mobile browser; Save to Files writes the page's original HTML into /Downloads; tt139-systems: PR-07n · literal mode is case-insensitive and wraps; tt139-systems: PR-07n · whole-word uses Unicode boundaries, not \b (+10) |
| PR-07o | built | full | e2e-tt35: per-tab private profiles (WP-04, PR-07o): a cookie a page sets lives in that tab's own jar — it survives a reload and a navigation inside the tab, a second tab on the SAME site never sees it, the Cookies counter shows it, and Clear cookies forgets it; closing the tab deletes the session on the server; e2e-tt36: named profiles (PR-07o): two tabs in profile Work share one session and its cookies, a third tab on the same site (this tab only) does not; switching it to Work joins the jar, switching a Work tab to 'this tab only' leaves it; the profile is saved with the window; closing the last Work tab deletes the Work session; tt147-core: PR-07o profiles: one jar per profile, one jar per anonymous tab, and names that cannot escape (+1) |
| PR-07p | built | full | tt140-cast-privacy: PR-07p · rules match hosts exactly, never substrings; tt140-cast-privacy: PR-07p · allow wins, invalid input is refused, non-http never navigates; tt140-cast-privacy: PR-07p · rules are validated at construction (+2) |
| PR-07q | built | full | browser-session: batch actions: close others / to the right / duplicates keep pinned tabs and the anchor; e2e-browser: batch actions keep pinned tabs; groups (create, rename, collapse) and tab search in the vertical sidebar; sleep spares visible tabs |
| PR-07r | built | full | browser-session: restore normalisation: hostile/invalid tabs dropped, groups/perms validated, active repaired, pinned first; e2e-browser: hostile saved session: javascript:, same-origin and credential URLs are dropped on restore; no frame ever points at the shell origin; e2e-tt114-shell: WM-12: the window menu changes only its own window, and the choice survives a reload (+4) |
| PR-07s | built | full | tt140-cast-privacy: PR-07s · media in another document is never offered as castable; tt140-cast-privacy: PR-07s · each blocker produces its own honest reason; tt140-cast-privacy: PR-07s · the per-tab summary counts and explains |
| PR-08 | built | full | e2e-tt52-pdf: corpus files open: one thumbnail per page (= PDFium page count), page canvases carry ink — tracemonkey.pdf (14 pages), alphatrans.pdf, 160F-2019.pdf (forms); e2e-tt52-pdf: annotate + page ops + title → Ctrl+S → PDFium/pypdf see exactly those edits; original bytes are an exact prefix (incremental update); e2e-tt52-pdf: forms: Tx + checkbox + choice filled in the Forms panel → pypdf reads the values (+98) |
| PR-09 | built | full | e2e-tt96-calculator: programmer controls compute exact 64-bit and signed fixed-width expressions in the real UI; e2e-tt96-calculator: history is session-only by default, then explicit local opt-in survives reload, filters, restores mode and deletes; e2e-tt96-calculator: quota denial is visible and never reported as a confirmed saved history entry (+77) |
| PR-10 | built | full | e2e-tt130-alarms: control: an open Clock window fires the same alarm; e2e-tt130-alarms: an alarm still fires in the shell after its Clock window closes; e2e-tt132-alarms: actionable ring survives Clock close and toast expiry; dismiss leaves the schedule enabled (+22) |
| PR-11 | built | partial | e2e-tt46: welcome document renders as a paged Word document (title style, bullet markers, bordered table, page box); e2e-tt46: typing with the real keyboard: text, Enter, Shift+Arrow selection + Ctrl+B, Ctrl+Z undo, Backspace join; e2e-tt46: Save as .docx from the UI → python-docx reads the typed text, Heading 1 style, bold run and bullet list (+44) |
| PR-12 | built | full | e2e-tt57-rows: PR-12 clipboard history: Fusion copies land in the system clipboard (read back independently) and the history; same text twice = one entry moved to top; pin survives Clear; search filters; e2e: mount: clipboard; tt57-units: PR-12 hand cases: dedupe moves to top keeping the pin; sensitive never deduped/pinned; cap spares pinned; clear keeps pinned; search text+source (+1) |
| PR-13 | built | full | e2e: desktop shows sticky note widget; seeded widget has no hang button; tt139-engines: DIFF-01 · Myers distance equals an independent longest-common-subsequence count; tt139-engines: DIFF-02 · the budget reports truncation instead of pretending everything changed (+3) |
| FF-01 | built | partial | e2e: mount: peek; unit: loss report itemises drops; registry grades |
| FF-02 | built | full | e2e-tt74-office: Export CSV: the dialog lists what CSV drops; OK downloads the displayed text of the used range; Cancel downloads nothing; Import CSV adds a typed sheet and keeps =… as text; e2e-tt74-office: Writer: Export Markdown downloads heading / bold / list Markdown after the loss dialog; From Markdown opens a new document with the converted heading and list; e2e-tt74-office: Slides: Outline downloads the deck's titles, bullets and notes as Markdown after the loss dialog (+21) |
| FF-03 | built | full | e2e-tt52-pdf: corpus files open: one thumbnail per page (= PDFium page count), page canvases carry ink — tracemonkey.pdf (14 pages), alphatrans.pdf, 160F-2019.pdf (forms); e2e-tt52-pdf: annotate + page ops + title → Ctrl+S → PDFium/pypdf see exactly those edits; original bytes are an exact prefix (incremental update); e2e-tt52-pdf: forms: Tx + checkbox + choice filled in the Forms panel → pypdf reads the values (+94) |
| FF-04 | built | full | ai-format: real Illustrator output: PDF export, DOS-EPS, Illustrator 88 EPS and FreeHand AI-dialect PostScript; ai-format: constructed .ai with and without PDF compatibility (the spec's open-vs-limited split); ai-format: creator hidden in a compressed object stream, UTF-16BE strings, junk before the header (+15) |
| FF-05 | built | full | e2e-tt59: FF-05 Photos exports GIF and BMP (our encoders): Pillow decodes both bit-exact to the source pixels; Chromium re-opens the GIF; tt59-raster: BMP: 24-bit bottom-up rows with 4-byte padding (odd widths 1, 2, 3, 37) decode bit-exact in Pillow; alpha composited over white by the documented formula; tt59-raster: GIF: ≤ 255 colours are exact (2-, 16-, 200-colour images incl. 1×1 and 600×400 noise past the 4096-code LZW reset) and Pillow decodes them bit-exact (+3) |
| FF-07 | built | full | e2e-tt54: FF-07 export PNG from Photos is BIT-EXACT to the Node recipe renderer on the same pixels (browser decode → recipe → encode); e2e-tt54: FF-07 export AVIF (WebCodecs AV1 + our AVIF writer) and JPEG / WebP with curated metadata: decoded by Pillow (libavif / libjpeg / libwebp); location only when asked; Orientation reset to 1; e2e: mount: photos (+2) |
| FF-08 | built | full | e2e-image: TT78 clipping mask in the UI: 'Clip to layer below' limits a layer to the brush stroke beneath it; non-separable modes offered; image: TT78 non-separable blends: hand-computed pins (W3C §10.2 SetLum / ClipColor / SetSat); image: TT78 clipping masks: base coverage, blend onto the base colour, hidden base, base opacity, clip with no base (+20) |
| FF-09 | built | full | tt139-media: FF-09 · detection prefers content over extension; tt139-media: FF-09 · RFC 4180 CSV: quotes, embedded commas and newlines; tt139-media: FF-09 · CSV ⇄ JSON keeps column order and stringifies objects (+4) |
| FF-10 | built | full | e2e-tt75-books: B1 reflowable pages: columns paginate, Next / ArrowRight move one page width, the end of a part goes on, the position is restored on reopen; e2e-tt75-books: B2 contents: clicking an entry shows that part; e2e-tt75-books: B3 search: hits are listed; a hit opens its part with a visible <mark> (+47) |
| FF-11 | built | full | e2e-tt46: welcome document renders as a paged Word document (title style, bullet markers, bordered table, page box); e2e-tt46: typing with the real keyboard: text, Enter, Shift+Arrow selection + Ctrl+B, Ctrl+Z undo, Backspace join; e2e-tt46: Save as .docx from the UI → python-docx reads the typed text, Heading 1 style, bold run and bullet list (+34) |
| FF-12 | built | full | ai-format: FF-12 guards: inflate bomb, 1 000 streams, corrupt Flate data, damaged DOS-EPS, empty and text files; integration: FF-08/FF-10/FF-02 Forge engines via the API, with grades; integration: FM-05 extract refuses zip-slip and writes nothing (+2) |
| FF-13 | built | full | e2e-tt54: FF-13 Files grid: real thumbnails for JPEG (EXIF orientation applied), TIFF (own decoder), PNG, GIF, SVG, MP3/M4A cover art, PDF page 1, WebM frame, text; no-preview types keep the icon with a reason; e2e-tt54: FF-13 thumbnail cache: WebP nodes under /System/Cache/thumbs (content-addressed, written once); a fresh session is served from the cache without re-rendering; e2e-tt54: FF-13 Info panel: metadata of the selected file (camera, capture date, exposure, GPS) from the first-party readers (+40) |
| FF-14 | built | full | ai-format: version strings, PDF literal escapes, format registry and MIME; tt111-core: the format registry is a usable contract: engine, grade, boundary and a conversion-loss answer for every entry; tt111-core: SRT becomes WebVTT the way a browser needs it, and WebVTT is left alone (+1) |
| FF-15 | built | full | e2e-tt134-ownership: Native Writer: a real blocked recovery write exceeds the four-second close timeout; Cancel/edit/unlock cannot late-close the window or lose the newer recovery bytes; e2e-tt69-lifecycle: Spreadsheet: closing a dirty window asks Save changes? — MODAL: Delete, typing, Ctrl+Z, Ctrl+S, Alt+F4, Meta+W, a script focusing the grid and a raw click on a cell never reach the workbook; Tab stays inside; Escape cancels; Save writes the file and closes; e2e-tt69-lifecycle: Writer: typing writes a recovery draft (python-docx reads its bytes; no version snapshots); Close → Don't save keeps it; reopening offers Restore; Restore brings the text back unsaved; Save writes it and deletes the draft (+32) |
| FF-19 | built | full | e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e-tt76-sheet: modal shortcut: an untouched Condition dialog has OK disabled; Enter (in the empty value box) applies nothing; Escape closes it; e2e-tt76-sheet: Top 2 shows only the two largest; reopening pre-fills Top 2; Below average; Clear shows every row (+117) |
| FF-20 | built | full | e2e-office: save → reopen keeps styles/widths/charts; export .xlsx → server re-import keeps bold, numFmt, widths; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e-sheet-layout: TT19 defined names: Name Box defines a name for the selection and jumps to it; formulas + autocomplete use it; Name Manager lists it; survives Export .xlsx → reopen (+77) |
| FF-21 | built | full | e2e-office: save → reopen keeps styles/widths/charts; export .xlsx → server re-import keeps bold, numFmt, widths; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e-tt47: Spreadsheet renders theme colours and imported conditional formats (cellIs on a theme-tinted dxf; 3-colour scale with percentile midpoint) (+166) |
| FF-22 | built | full | e2e-tt46: welcome document renders as a paged Word document (title style, bullet markers, bordered table, page box); e2e-tt46: typing with the real keyboard: text, Enter, Shift+Arrow selection + Ctrl+B, Ctrl+Z undo, Backspace join; e2e-tt46: Save as .docx from the UI → python-docx reads the typed text, Heading 1 style, bold run and bullet list (+98) |
| FF-23 | built | full | e2e-tt51-slides: corpus decks open in the real UI with every slide in the rail and the file's content drawn: shapes.pptx (6 slides, preset shapes + text), table_test.pptx (a table with its cell text), bar-chart.pptx (chart drawn from its cache as SVG), backgrounds.pptx; e2e-tt51-slides: edit → save → python-pptx: retype the title by double-click, bold one word through the toolbar, add speaker notes, duplicate and hide a slide, insert a text box, drag a shape — the saved file carries exactly those edits, validates, and untouched parts keep their bytes; e2e-tt51-slides: slide show: Present opens a full-window show at the first visible slide; → / Space / click advance, ← goes back, HIDDEN slides are skipped, Escape ends and returns to the editor (+44) |
| FF-24 | built | full | e2e-image: marquee → crop to selection changes canvas size; image rotate; Ctrl+Z restores; invert filter through selection; e2e-image: Export PNG → reopen the PNG from the VFS as a new document; Image size dialog resizes; e2e-image: classic Quick edit mode is still available (additive merge) (+9) |
| FF-25 | built | full | e2e-vector: UI: rect/ellipse/star by drag (shift = square), exact geometry; undo/redo by keyboard; e2e-vector: UI: Save .fsvg → reopen (v2 round trip), Export SVG (re-importable, safe), Export PNG (valid 2× PNG at the declared export size); e2e: mount: vector (+8) |
| MD-01 | built | partial | e2e: mount: capture |
| MD-02 | built | partial | e2e: mount: media |
| MD-03 | built | full | e2e-image: classic Quick edit mode is still available (additive merge); e2e-tt128-photos: a thumbnail completing between pointer down and up keeps its tile geometry and click; e2e-tt128-photos: photo tiles retain keyboard activation and cancel a drag away (+98) |
| MD-04 | built | full | e2e-tt110-shell: the voice recorder writes a real encoded file into Documents; e2e: mount: devices |
| MD-05 | built | full | e2e: mount: devices; tt142-input-scan: MD-05 · a javascript: code is never navigable; tt142-input-scan: MD-05 · other install/launch schemes are refused too (+5) |
| MD-06 | built | full | e2e-tt110-shell: audio outputs are enumerated and a tone can be routed to a chosen one; e2e: mount: devices; tt137-system-engines: MD-06 · routeAudio uses defaults (+2) |
| MD-07 | built | full | e2e-tt114-shell: MD-07: the colour picker uses EyeDropper where it exists and says so plainly where it does not; e2e: mount: devices |
| MD-08 | built | full | e2e-tt53-media: MP4 (H.264 B-frames + AAC) exact-start lossless cut from the Media app: saved .mp4 verified by FFmpeg, starts at the requested time; e2e-tt53-media: MP4 with 'exact start' off snaps to the key frame (1.000 s) and says so; e2e-tt53-media: WebM (VP9 + Opus) lossless cut: start snaps to the previous key frame, the status line says where, output verified by FFmpeg (+17) |
| MD-09 | built | full | tt137-system-engines: MD-09 · addWindow registers audio state; tt137-system-engines: MD-09 · setVolume and toggleMute work; tt137-system-engines: MD-09 · reportDashboard gives summary |
| SC-01 | built | partial | e2e: mount: vault; unit: seal/open round trip; wrong passphrase and ciphertext tamper fail |
| SC-02 | built | full | e2e-tt111-recall: Forget removes a held item from the pane immediately, and the switch empties it and says so; e2e: mount: vault; tt110-core: the capture policy is enforced where the writing happens, not only where the buttons are (+6) |
| SC-03 | built | full | e2e-tt56-rows: SC-03 permission audit: Settings lists every name of the full permission list, each state equals an independent permissions.query |
| SC-04 | built | full | tt107-features: every capability declared blocked is still refused with a stated reason; tt143-engines: SC-04 egress: a deny rule blocks, an allow rule passes, and the more specific rule wins |
| SC-05 | built | full | e2e-tt72-access: Devices → Record: live microphone entry; Stop on the dashboard ends the real track and the recorder; row gets a duration; e2e-tt72-access: Lens: camera + mic live, presenter screen live; the module's own Stop camera (no 'ended' event) ends both; e2e-tt72-access: refusals and grants are logged with the module — no clipboard text or coordinates kept; Clear empties finished rows (+7) |
| SC-07 | built | full | tt139-systems: SC-07 · lifecycle: sealed → unlocked → locked → sealed; tt139-systems: SC-07 · rate limiting counts failures, not successes; tt139-systems: SC-07 · a throwing verifier is a failed attempt, not a crash (+3) |
| SC-08 | built | partial | e2e-tt113-density: the small print was moved, not deleted; integration: SR-04 / settings: locked settings refuse writes (423) |
| SC-09 | built | partial | tt107-features: every cast session is registered and closed in the database; tt107-features: a cast session cannot be opened against an unregistered target |
| BK-01 | built | full | e2e: mount: backup; integration: FM-18 overwrite snapshots the previous version; integration: BK-01 tampered backup bundle is refused before anything is written (+29) |
| BK-02 | partial | partial | e2e-privacy: TT87 conditional writes work for ordinary host files while unlocked, but never write plaintext inside Persistent Storage; e2e-tt87-localdisk: BK-02 real browser folder handle survives IndexedDB reload and a first sync preserves skipped names and binary data; e2e-tt87-localdisk: BK-02 conflict choices reject stale local and server copies; explicit resolution preserves a Fusion version (+6) |
| BK-03 | built | full | e2e-tt87-backup: BK-03 UI builds a settings-only snapshot, verifies it and downloads both plaintext and authenticated encrypted files; e2e-tt87-backup: BK-03 wrong passphrase, ciphertext mutation and plain checksum tampering are refused before any restore request; e2e-tt87-backup: BK-03 encrypted UI restore previews, can cancel, applies settings live in two tabs and never posts the passphrase (+23) |
| BK-04 | built | full | tt111-core: the new-device checklist is a real diff of two measured reports, and absent memory data is not low memory; unit: BK-04 capability diff reports lost/gained with degrade text |
| BK-05 | built | full | e2e-tt89-drill: a real downloaded recovery-key archive is selected and the drill controls are keyboard accessible; e2e-tt89-drill: wrong password and modified ciphertext fail locally, do not post, and set failed status; e2e-tt89-drill: real encrypted-file drill reads scratch state, confirms rollback, keeps live settings unchanged and persists only non-secret status (+55) |
| BK-06 | built | full | e2e-tt87-backup: BK-03 UI builds a settings-only snapshot, verifies it and downloads both plaintext and authenticated encrypted files; e2e-tt87-backup: BK-03 wrong passphrase, ciphertext mutation and plain checksum tampering are refused before any restore request; e2e-tt87-backup: BK-03 encrypted UI restore previews, can cancel, applies settings live in two tabs and never posts the passphrase (+19) |
| FF-26 | built | full | e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e: mount: sheet; office: SEQUENCE(2,3) spills all six cells with correct values (+13) |
| FF-27 | built | full | e2e: mount: sheet; office: FILTER with a broadcast boolean condition, SORT, UNIQUE, XLOOKUP; office: first-party verified semantics survive: SUM(1,"x",2) is still #VALUE! (+7) |
| FF-28 | built | full | e2e-a11y: spreadsheet grid geometry scales with the text (row height = 22 × scale) and a header drag still moves the edge 1:1 on screen; e2e-office: sample renders through numfmt + spill: currency, SUM, SORTBY spill outline/tooltip, % format on another sheet; e2e-office: autocomplete (Tab inserts NAME( ), point-mode click inserts a reference, Enter commits and recalculates (+37) |
| FF-29 | built | full | e2e-office: charts panel renders SVG chart images (bar → pie) from a dynamic-array source; e2e-tt49: imported x14 data bars (automatic bounds + border), x14-only 3Stars and a custom icon mix are drawn cell-for-cell as evaluated; e2e-tt49: CF borders, formula rules and time periods from a workbook our writer produced are drawn as evaluated (+48) |
| FF-30 | built | full | e2e-image: ORACLE: our compositor vs Chromium/Skia globalCompositeOperation — the 16 canvas blend modes (incl. hue/saturation/color/luminosity), opaque and translucent backdrops; e2e-image: new doc renders; brush drag paints a continuous line in the foreground colour; undo/redo; e2e-image: layers: new layer, paint, blend=multiply changes composite, opacity, visibility toggle, reorder, merge (+28) |
| FF-31 | built | full | e2e-image: Save PSD → VFS file decodes with our reader (layers/blend/mask) → deep-link reopen restores layers and pixels; e2e: mount: imageedit; image: TT78 PSD: groups / clipping / non-separable keys round-trip; clip to a group is reported and drawn unclipped (+12) |
| FF-32 | built | full | e2e-vector: ORACLE Chromium SVG: getBBox + getTotalLength of the ORIGINAL d vs our normalised cubics (arcs included); e2e-vector: ORACLE Chromium SVG: isPointInFill (nonzero + evenodd) vs our containment on a 31×31 grid per path; transform.baseVal; e2e-vector: ORACLE render parity: Chromium rasterises the original SVG and our import→export identically (≤0.5% pixels > 24/255) (+31) |
| FF-33 | built | full | e2e-sheet-layout: Merge & Center: upper-left-most data kept after the Excel warning, one spanning cell, selection/arrow keys treat it as one; Unmerge restores cells; e2e-sheet-layout: Freeze first column stays put on horizontal scroll; sorting a range with a merge is refused with Excel's message; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader) (+8) |
| FF-34 | built | full | e2e-sheet-layout: Borders: Outside (medium, colour) draws the four perimeter edges via the neighbours' shared edges; Inside dotted; No Border clears; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e: mount: sheet (+4) |
| FF-35 | built | full | e2e-sheet-layout: Data validation: list dropdown picks a value; Stop rejects (rolled back, Retry/Cancel); Warning lets you keep it; Circle invalid flags it; e2e-sheet-layout: Full stack: merges + borders + validation + frozen panes survive Export .xlsx → reopen the .xlsx from the VFS (server reader); e2e: mount: sheet (+5) |
| SC-10 | built | full | e2e-privacy: create Persistent Storage in the UI: Argon2id keyslots + recovery key; nothing secret reaches the host; top bar shows the unlocked state; e2e-privacy: files written by the shell into /Private reach the host as ciphertext only: no name, no content, no index entry, no audit path; e2e-privacy: TT87 conditional writes work for ordinary host files while unlocked, but never write plaintext inside Persistent Storage (+171) |
| SC-11 | built | full | e2e-privacy: create Persistent Storage in the UI: Argon2id keyslots + recovery key; nothing secret reaches the host; top bar shows the unlocked state; e2e-privacy: lock from the top bar → 423; unlock with the RECOVERY key in the UI → readable; a reload forgets the key (memory only); e2e-tt130-privacy: explicit amnesic boot refuses host writes when localStorage access throws (+6) |
| SC-12 | built | full | e2e-privacy: Remove metadata on an encrypted photo in the UI: cleaned in the browser, copy stays encrypted, Pillow confirms only Orientation remains; e2e-privacy: Files ▸ Remove metadata (copy) on a host .docx; overwrite mode also forgets the version that still held the author; e2e: mount: privacy (+6) |
| SC-13 | built | full | e2e-privacy: amnesic session: AMNESIC badge, files in RAM only, notes refused + logged, localStorage and IndexedDB leave no trace, /Private still persists; e2e-privacy: privacy headers: no-referrer, no DNS prefetch, nosniff, object-src none; API bodies are never written to the HTTP disk cache; e2e-tt87-privacy: TT87 amnesia refuses conditional writes before they reach PostgreSQL (+7) |
| SC-14 | built | full | e2e-privacy: host audit in the UI: a plaintext file planted by another client is flagged and 'Encrypt it' seals it (name + content); e2e: mount: privacy; privacy-layer: audit walks /Private on the host and flags anything stored in clear (a planted plaintext file is caught) |
| SC-15 | built | full | e2e-privacy: emergency shutdown chord: keys + RAM files gone, page blanked via location.replace (no history entry with the shell); e2e: mount: privacy |
| FF-36 | built | full | e2e-sheet-layout: TT19 defined names: Name Box defines a name for the selection and jumps to it; formulas + autocomplete use it; Name Manager lists it; survives Export .xlsx → reopen; names: name syntax follows Excel's rules (web-checked): letters/_ first, no spaces, not A1/R1C1-like, not C/R, ≤255; names: names in formulas: ranges, constants, formula names, chains; case-insensitive; unknown → #NAME? until defined (+5) |
| FF-37 | built | full | e2e-vector: TT19 Pathfinder: Unite / Minus Front on two drawn rectangles — geometry, paint and undo; vector-boolean: two rectangles: all four shape modes equal GEOS exactly; paint + stacking follow Illustrator (front paint; Minus Front keeps the back); vector-boolean: rotated rectangle (transform) × ellipse: every mode within flattening tolerance of GEOS (IoU ≥ 0.9995) (+4) |
| SC-16 | built | full | e2e-privacy: TT19 private search in the UI: the palette finds an encrypted /Private file by content; Find '/Private only' searches in the tab and sends NO search request to the host; privacy-layer: TT19 private search: /Private is searchable from an in-tab index; scoped queries never reach the host; index follows write/move/trash and dies on lock; privacy-layer: TT19 amnesic search: RAM-only files are searchable in place and hidden host files drop out of results |
| SC-17 | built | full | e2e-privacy: TT20 backup in the UI: download one encrypted file, verify it, wipe the host volume, restore it from the file — byte-identical ciphertext; privacy-backup: backup is one file holding only ciphertext: no names, no content, no tree shape; cleartext entries are skipped and reported; privacy-backup: verify opens every entry with the passphrase AND with the recovery key; wrong secret and a flipped byte are rejected (+5) |
| SC-18 | built | full | e2e-privacy: TT20 amnesic unsaved-work guard: RAM-only files listed, leaving asks first, 'Keep all' moves them into /Private encrypted; emergency shutdown never asks; privacy-backup: amnesic rescue: RAM-only files are listed and moved into /Private/Rescued encrypted; nothing lands in clear; locked refuses |
| AX-09 | built | full | a11y-unit: text-scale maths: default 125 %, Large text mode 200 %, clamps, steps; every inline font size goes through fz(); a11y-unit: token text contrast ≥4.5:1 (WCAG 1.4.3): body, muted, badges, desktop labels over the brightest wallpaper spot; a11y-unit: settings validation: text size must be an integer 100–300, wallpaper/theme/density from their lists, accent a hex colour (+10) |
| AX-10 | built | full | a11y-unit: icon contrast: every palette's glyph colour is ≥3:1 against its tile gradient across the whole glyph area (WCAG 1.4.11); a11y-unit: every registered module and every common file type has a real glyph; tile palettes exist; a11y-unit: no emoji glyphs left in the shell chrome (they render blank without a colour-emoji font) (+8) |
| AX-11 | built | full | a11y-unit: TT143 tokens: every ink and the interactive border clear the AA floor in both modes; a11y-unit: style system: every style's glyphs ≥3:1 on their tiles, chrome ink ≥4.5:1, dark+light text tokens ≥4.5:1, accent buttons ≥4.5:1; CSS emitted for each; a11y-unit: light theme: field background and status-text tokens reach ≥4.5:1; filled spreadsheet cells get automatic ink (+2) |
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
| LY-01 | built | full | e2e-layout: Settings → Layout: picking Business swaps the top bar + shelf for a bottom taskbar; persisted across a reload; e2e-layout: Business taskbar: open → minimise → restore on click, Shift+click new window, jump list, Show desktop round trip, clock → Planner; e2e-layout: Business: Start menu opens above the taskbar at bottom-left, search + Enter launches; Quick settings and toasts sit bottom-right; Windows caption buttons (+7) |
| LY-02 | built | full | e2e-layout: Quick panel → Layout: Art gives a menu bar and a centred dock holding EVERY app (+ Launchpad, Trash); no taskbar; e2e-layout: Art dock magnification: measured peak under the pointer, cosine falloff, name bubble, stable under the pointer, reset on leave; off switch; e2e-layout: Art dock: launch bounces and shows a running dot; minimise (traffic light) parks the window after the separator, click restores; right-click Quit (+7) |
| LY-03 | built | full | e2e-layout: Settings → Layout: picking Business swaps the top bar + shelf for a bottom taskbar; persisted across a reload; e2e-layout: Quick panel → Layout: Art gives a menu bar and a centred dock holding EVERY app (+ Launchpad, Trash); no taskbar; e2e-layout: API: unknown layout and dockMagnify values are refused (422); the setting is searchable by 'taskbar' and 'dock' (+2) |
| LY-04 | built | full | e2e-a11y: light + dark theme, all 13 styles: axe finds no serious violations in the chrome, Files and Spreadsheet; e2e-layout: axe-core: Business with Enterprise and Art with Graphite, dark + light, Start menu / Launchpad / menus open — no serious or critical violations; layout-unit: TT25 professional styles: Enterprise (flat, Windows-like) and Graphite (aluminium, macOS-like) with their own wallpapers |
| LY-05 | built | full | e2e-beauty: 1440×900: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations; e2e-beauty: 1280×800: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations; e2e-beauty: 1920×1080: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations (+7) |
| LY-06 | built | full | e2e-tabletop: desktop icons (classic): drag snaps to another grid cell and persists; Alt+Arrow moves; 'Sort icons by name' and 'Clean up icons' rearrange; e2e-tt96-desktop-menu: a lower-right desktop context menu stays within its usable surface and Sort can be clicked; e2e-tt96-desktop-menu: an open edge menu reclamps after the viewport shrinks (+6) |
| LY-07 | built | full | e2e-tabletop: toggle: Quick panel switch replaces the desktop with the Tabletop (persisted); Settings → Desktop view brings Classic back; e2e-tabletop: box geometry (straight-down camera): floor projected at p/(p+depth) and centred; four walls hinge on the screen edges (measured); e2e-tabletop: a wall becomes the main view: double-click unfolds it to fill the desk (others fold away, inert), Back / Esc / double-click its background return; switcher works too (+7) |
| LY-08 | built | full | e2e-tabletop: drag a card onto a card makes a pile (persisted, survives reload); click fans it out on an arc; drag a card out of the fan takes it out and the pile dissolves; e2e-tabletop: keyboard pile (WCAG 2.5.7 alternative to dragging): Shift+F10 on a card → 'Pile with …'; Enter fans the pile, Esc gathers; Alt+Arrow moves a card; e2e-tt31: on a lifted wall: move a pin along it, drop a pin on a pin to pile, click the pile to fan it along the wall, drag a card out of the fan onto the floor (+3) |
| LY-09 | built | full | e2e-tabletop: micro peek shows the real contents (Markdown heading + bullets, CSV grid with a quoted comma) and enlarges on hover / focus; tabletop-unit: micro peek: Markdown keeps headings/bullets, plain text and code, line cap, CSV with RFC 4180 quoting, JSON grid / pretty text, images, SVG, binary, sealed, empty |
| LY-10 | built | full | e2e-beauty: the pipeline catches seeded violations in the live page (tiny crowded buttons, clipped text, an off-centre dock, an un-golden card); e2e-beauty: 1440×900: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations; e2e-beauty: 1280×800: Fusion, launcher, Business, Start, Art, Launchpad, dock stack, Tabletop floor + 4 walls — no hard beauty violations (+3) |
| LY-11 | built | full | e2e-tabletop: slanted camera is the default: floor ≥ 80 % of the Tabletop by hit-sampling 1440 points (desktop + phone), the near lip is a ≥ 24 px target, Camera toggles top ↔ slant and persists; tabletop-unit: slanted camera (default): floor ≥ 80 % of the frame across a viewport sweep, lip ≥ 24 px, β = 38°, walls share the rest; tabletop-unit: slanted camera maths: floor homography = the 3D projection (< 0.01 px) and inverts (< 0.01 px); faces meet at the seams; every wall faces into the box |
| LY-12 | built | full | e2e-tabletop: walls are pinboards: drag a card onto a wall pins it (persisted, leaves the floor); the open wall shows it with a count; drag moves it on the wall; 'Put back on the table' returns it; e2e-tabletop: TT48 fast flick: pointerdown, eight pointermoves and pointerup in ONE task (no render in between) still move the card — the release must not read a stale drag; e2e-tabletop: wall piles by menu (keyboard path): 'Pin to the Apps wall' ×2, pile them on the wall, fan the wall pile, take one out; pins survive reload (+5) |
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
| LY-21 | built | full | e2e-tt29: beauty rule 'no squashed text' (TT29): under the default slanted camera every visible Tabletop text renders at an effective ≥ 9 px (font-size × projected scale, measured per element) at 1440×900 and 390×800; walls below the legibility rule show glyphs only; e2e-tt29: straight-down camera obeys the same rule: its walls are below the legibility scale too (computed), so they show glyphs + tags; no visible text under 9 px effective; the computed box model matches the DOM (each wall face's measured box = its quad's box ± 2 px); e2e-tt31: hover lifts a wall flat and true-size, docked inside the frame; pins become ≥ 24 px cards with names ≥ 9 px; leaving lets it settle; the resting camera is untouched (floor ≥ 80 %) (+1) |
| AX-14 | built | full | e2e-tt30: oracle: our accessible names and roles agree with Chromium's accessibility tree in all 40 modules × 3 layouts (thresholds declared up front: names ≥ 98 %, roles ≥ 99 %); e2e-tt30: oracle sensitivity: three mutants of the narrator source are caught (aria-label ignored → names < 98 %; buttons as generic → roles < 99 %; CSS text-transform ignored → the uppercase headings differ); e2e-tt30: behaviour: the toggle chord turns Narrator on (spoken + captioned + saved); Tab focus is announced with name and role and the cursor box surrounds the focused element; entering a window announces its dialog context; typing is echoed (+12) |
| LY-22 | built | full | e2e-tt31: hover lifts a wall flat and true-size, docked inside the frame; pins become ≥ 24 px cards with names ≥ 9 px; leaving lets it settle; the resting camera is untouched (floor ≥ 80 %); e2e-tt31: floor → resting wall: dragging a card onto the north wall spring-loads it and the card lands where it was dropped (mapped, not a free slot); a second drop further along lands further along; e2e-tt31: on a lifted wall: move a pin along it, drop a pin on a pin to pile, click the pile to fan it along the wall, drag a card out of the fan onto the floor (+15) |
| AX-15 | built | full | e2e-tt32: environment + engine choice: this Chromium has 0 system voices; Narrator (Automatic) speaks through Fusion Voice — the caption bar says so, Web Audio receives non-silent 16 kHz speech for the start-up announcement, and speechSynthesis.speak is never called; e2e-tt32: intelligibility in the browser (declared gate ≥ 75 %): focus announcements captured from Web Audio on the real page, forced choice among all captured announcements by PocketSphinx; e2e-tt32: control: Ctrl stops Fusion Voice mid-sentence (queued buffers are stopped, nothing new starts) (+10) |
| SM-05 | built | full | e2e-tt33: TIDAL (SM-05): click-to-load gate names embed.tidal.com + the 30-second/sign-in note and sends nothing before consent; against TIDAL's real bridge: Play → 'Started', Pause → 'Pause sent' (flagged assumed), a start inside the player → 'Started'; spoofed starts (our own window, a foreign pid) ignored; e2e-tt33: one player at a time (SM-08): a TIDAL video started in Video pauses the TIDAL track playing in Music through TIDAL's real bridge; Music shows 'Pause sent'; Music refuses a video link with a pointer to Video; tt33-unit: TIDAL link grammar (SM-05): tidal.com / browse / listen.tidal.com / album…track / embed.tidal.com → embed.tidal.com/<types>/<id>; kinds, heights, allow (+3) |
| SM-06 | built | full | e2e-tt33: Qobuz + Amazon Music (SM-06, SM-07): store link → widget.qobuz.com with the page's zone at 390 px with encrypted-media; Amazon Share → Embed code pasted → the issued address minus tracking; a page link → built address + the 'use Share → Embed' note; neither offers controls it cannot honour; tt33-unit: Qobuz link grammar (SM-06): widget / open / play / store pages → widget.qobuz.com with zone; track compact; heights; tt33-unit: ≥ 15 refused shapes, each with a reason (negative space) (+1) |
| SM-07 | built | full | e2e-tt33: Qobuz + Amazon Music (SM-06, SM-07): store link → widget.qobuz.com with the page's zone at 390 px with encrypted-media; Amazon Share → Embed code pasted → the issued address minus tracking; a page link → built address + the 'use Share → Embed' note; neither offers controls it cannot honour; tt145-engines: SM-07 Amazon Music: all twelve storefronts resolve with their own marketplace id, affiliate and utm parameters never survive, and a non-Amazon host is refused rather than guessed; tt33-unit: Amazon Music grammar (SM-07): Share → Embed code kept as issued (tracking params dropped); page links → embed shape flagged unverified; 12 storefronts (+2) |
| SM-08 | built | full | e2e-tt33: one player at a time (SM-08): a TIDAL video started in Video pauses the TIDAL track playing in Music through TIDAL's real bridge; Music shows 'Pause sent'; Music refuses a video link with a pointer to Video; e2e-tt33: Qobuz + Amazon Music (SM-06, SM-07): store link → widget.qobuz.com with the page's zone at 390 px with encrypted-media; Amazon Share → Embed code pasted → the issued address minus tracking; a page link → built address + the 'use Share → Embed' note; neither offers controls it cannot honour; e2e-tt33: library + modal shortcut (SM-08): TIDAL / Qobuz / Amazon links saved show their provider; Next walks them; the Rename dialog traps Escape (closes the dialog only — title unchanged, window open) and Enter renames (+2) |
| MP-06 | built | full | e2e-tt34: Maps (MP-06, MP-07, MP-08): Plus Code search (full, and short + city); a place's Plus Code; measured distance and area on the ellipsoid match the exported GPX's own points; KML export is a polygon; GPX import adds waypoints and loads the track; tt34-unit: geodesy (MP-06): inverse on WGS84 vs GeographicLib — 20 000 random pairs and 2 000 near-antipodal pairs (Vincenty's failure region, solved by shooting), all ≤ 1 mm; tt34-unit: geodesy (MP-06): direct problem (10 000 cases, up to 19 000 km) lands ≤ 1 mm from GeographicLib; poles, equator, antimeridian, coincident points; the sphere was up to ~0.5 % off (+1) |
| MP-07 | built | full | e2e-tt34: Maps (MP-06, MP-07, MP-08): Plus Code search (full, and short + city); a place's Plus Code; measured distance and area on the ellipsoid match the exported GPX's own points; KML export is a polygon; GPX import adds waypoints and loads the track; tt34-unit: Plus Codes (MP-07): every official Open Location Code vector — encoding (302, incl. degrees → integers), decoding (420), validity (25), shorten / recover (19); tt34-unit: Plus Codes (MP-07): refusals and search parsing — bad lengths, padded shortening, invalid codes; codes found in free text with a locality; recovery across the antimeridian (+1) |
| MP-08 | built | full | e2e-tt34: Maps (MP-06, MP-07, MP-08): Plus Code search (full, and short + city); a place's Plus Code; measured distance and area on the ellipsoid match the exported GPX's own points; KML export is a polygon; GPX import adds waypoints and loads the track; tt34-unit: GPX / KML export (MP-08): gpxpy and xml.etree read Fusion's files back exactly — 60 waypoints with hostile names (& < " ' ]]> emoji, tabs, spaces), a 50-point track, a route with elevations, a KML polygon; tt34-unit: GPX / KML import (MP-08): Fusion reads GPX 1.0 and 1.1 written by gpxpy, its own GPX/KML, namespaced and real-world shapes (multi-segment tracks, MultiGeometry, Folder nesting, CDATA, gx: extensions) (+1) |
| SM-09 | built | full | e2e-tt34: transport + keyboard on YouTube (SM-09, SM-10): +10 s, volume, mute, speed and playlist Next go out as IFrame-API commands and the UI follows the PLAYER's reports; keys J/L/M/>/↓/Shift+N/Shift+P work in the player and do nothing while typing; e2e-tt34: transport honesty (SM-09): Vimeo with speed disabled by its owner — setPlaybackRate is sent but the speed shown stays unreported 1×; volume uses 0–1 and follows volumechange; seek slider → setCurrentTime. SoundCloud: seek + playlist next, no volume control at all; e2e-tt34: native audio + library order (SM-09, SM-11): the transport drives <audio> (seek, volume, mute, speed, J key); Shuffle plays distinct items and Previous retraces them (+2) |
| SM-10 | built | full | e2e-tt34: transport + keyboard on YouTube (SM-09, SM-10): +10 s, volume, mute, speed and playlist Next go out as IFrame-API commands and the UI follows the PLAYER's reports; keys J/L/M/>/↓/Shift+N/Shift+P work in the player and do nothing while typing; tt34-unit: keyboard (SM-10): Space/K, J/L, arrows, M, Shift+N/P, < >, digits; nothing while typing or with modifiers; sliders keep their arrows; Space on a button stays the button's; speed stepping |
| SM-11 | built | full | e2e-tt34: native audio + library order (SM-09, SM-11): the transport drives <audio> (seek, volume, mute, speed, J key); Shuffle plays distinct items and Previous retraces them; tt34-unit: library order (SM-11): Previous wraps only with Loop; Shuffle never repeats within a round, never plays the same item twice in a row across rounds, is uniform (χ², 6 items × 6 000 draws) |
| WP-01 | built | full | e2e-tt35: pypi.org through the private proxy (WP-01, WP-02, WP-05): renders with its own CSS and images, every request the browser makes goes to the Fusion server only, the page is an opaque origin, cookies + storage work through the runtime; search FORM → site answer → Back → real LINK → Back → Forward, address bar follows; e2e-tt35: github.com through the private proxy (WP-01): its HTML renders (title, repository README) in the proxied tab; this sandbox blocks GitHub's asset CDN (github.githubassets.com), so the page is unstyled here — the toolbar names the unreachable host and why; shields count; nothing but the Fusion server is contacted; tt35-unit: URL codec (WP-01): path-preserving encode → decode round-trips 2 000 generated URLs exactly (ports, IPv6, trailing slashes, queries, unicode); refuses credentials, non-http schemes, bad session ids and smuggled hosts (+4) |
| WP-02 | built | full | e2e-tt35: pypi.org through the private proxy (WP-01, WP-02, WP-05): renders with its own CSS and images, every request the browser makes goes to the Fusion server only, the page is an opaque origin, cookies + storage work through the runtime; search FORM → site answer → Back → real LINK → Back → Forward, address bar follows; e2e-tt35: hostile-page model (WP-02, WP-06): with Fusion's in-page runtime WITHHELD, a proxied document — opened top-level, and inside Fusion's Browser frame — is an opaque origin that can neither read the desktop's API nor write a file by CSRF; an unknown session id is refused; e2e-tt35: large downloads and media ranges through the proxy (WP-02, PR-07m): a real file bigger than the 8 MB page limit (a numpy wheel from files.pythonhosted.org) streams through whole — byte-identical to a direct download (SHA-256) — and a Range request returns 206 with exactly the requested bytes; a 9 MB upload is refused (413) (+7) |
| WP-03 | built | full | e2e-tt35: github.com through the private proxy (WP-01): its HTML renders (title, repository README) in the proxied tab; this sandbox blocks GitHub's asset CDN (github.githubassets.com), so the page is unstyled here — the toolbar names the unreachable host and why; shields count; nothing but the Fusion server is contacted; tt35-unit: privacy hygiene (WP-03): tracker hosts and their subdomains match (and look-alikes do not); upstream drops the user's identity and client hints, then supplies a shared Desktop default or explicit Desktop/Mobile preset plus fixed language and Sec-GPC; responses lose Set-Cookie, CSP, XFO, HSTS, COOP, Alt-Svc; download names are sanitised |
| WP-04 | built | full | e2e-tt35: per-tab private profiles (WP-04, PR-07o): a cookie a page sets lives in that tab's own jar — it survives a reload and a navigation inside the tab, a second tab on the SAME site never sees it, the Cookies counter shows it, and Clear cookies forgets it; closing the tab deletes the session on the server; tt111-recall-tap: a closed browser session keeps nothing; tt35-unit: cookie jar (WP-04): RFC 6265 — host-only vs Domain, public-suffix refusal, domain mismatch, default-path and path matching (/docs vs /docsx), Secure only over https, Max-Age over Expires, deletion, HttpOnly hidden from (and unwritable by) scripts, __Secure- / __Host- prefixes, ordering by path length, per-domain cap (+1) |
| WP-05 | built | full | e2e-tt35: pypi.org through the private proxy (WP-01, WP-02, WP-05): renders with its own CSS and images, every request the browser makes goes to the Fusion server only, the page is an opaque origin, cookies + storage work through the runtime; search FORM → site answer → Back → real LINK → Back → Forward, address bar follows; e2e-tt35: find in page, identity and Save to Files on a real site (WP-05; PR-07h, PR-07n, PR-07m): find counts and steps through matches inside the proxied page; Mobile makes the server AND the page present a mobile browser; Save to Files writes the page's original HTML into /Downloads; e2e-tt36: Reader view in a Private proxy tab (PR-07k): a real article page (TT69: github CONTRIBUTING.md; pypi.org/help/ now 301s to docs.pypi.org, outside this sandbox) as Fusion's reader page — article text, title and reading time, no script but the runtime, opaque origin, nothing contacted but Fusion; find works in the reader; an in-article link stays in the reader with the address following; Back; 'Original page' leaves the reader and the Reader button follows; Reader off returns to the normal page |
| WP-06 | built | full | e2e-tt35: hostile-page model (WP-02, WP-06): with Fusion's in-page runtime WITHHELD, a proxied document — opened top-level, and inside Fusion's Browser frame — is an opaque origin that can neither read the desktop's API nor write a file by CSRF; an unknown session id is refused; tt108-refusal: a cross-site request is refused quickly on every body-taking route and writes nothing; tt108-refusal: the refusal body still names the reason and the refusal is not cached (+5) |
| WP-07 | built | full | e2e-tt37: Network route panel (WP-07): test a candidate SOCKS5 route on a real page, apply it — toolbar and status line follow, the Private proxy tab loads pypi.org through it (seen in the independent proxy's own log), 'New circuit' rotates the tab's isolation and reloads, the browser itself still contacts only Fusion; the Tor check result is printed as it is; e2e-tt37: a dead route is named, not blamed on the site (WP-07): with the route pointing at a port where nothing listens, the Private proxy tab shows 'The network route failed' and how to fix it; back on Direct the page loads again; e2e-tt37: everything follows the route; pages cannot change it (WP-07): with an HTTP proxy route the legacy reader for direct tabs goes through it (the proxy's log), a .onion address is refused with the reason (Tor route needed), and a cross-site PUT to /api/wp-route is refused by the CSRF guard (+8) |
| WP-08 | built | full | e2e-tt38: WebSocket in a proxied page (WP-08): the page's own `new WebSocket` reaches the site through Fusion — readyState CONNECTING→OPEN→CLOSING→CLOSED, subprotocol chat.v2, string / ArrayBuffer / Blob / typed-array sends echoed in order with binaryType 'arraybuffer', bufferedAmount counts queued bytes and drains to 0, handler and listener fire in registration order, MessageEvent.origin is the socket's origin, close(4001, 'bye ✓') ends clean; 200 server messages arrive in order; e2e-tt38: WebSocket errors exactly where a browser raises them (WP-08): SyntaxError for a non-ws scheme, a fragment, duplicate or invalid subprotocols; TypeError with no argument; InvalidStateError for send() while CONNECTING; InvalidAccessError for close(1001); SyntaxError for a 124-byte reason; an unreachable server → 'error' then close 1006 (not clean); close() while connecting → error + close 1006 and never 'open'; constants and name match the platform; e2e-tt38: what the site sees (WP-08): the WebSocket handshake carries the session's User-Agent (not the real browser's) and the PAGE's origin (the site's own, not Fusion's), and the site's own cookie from the session jar (+13) |
| WP-09 | built | full | e2e-tt38: keep-alive through the real server (WP-09): the page and its 8 images and event stream are carried over a few reused connections to the site (counted at the site), not one connection per request; e2e-tt39: TLS identity for IP-literal sites (TT39 fix): https://127.0.0.2 with a valid certificate FOR 127.0.0.2 loads through the proxy; a certificate from the same trusted CA but for "localhost" is refused for 127.0.0.2 (before the fix Node checked IP sites against "localhost" and would have accepted it); tt38-unit: Happy Eyeballs (WP-09, RFC 8305): families interleave from the resolver's first choice; a refused address hands over AT ONCE (no 250 ms wait) to a live one on real sockets; a blackholed first address loses to the second, started 250 ms later; every loser is destroyed; all refused → one error listing every address with the first code; nothing answering → ETIMEDOUT at the deadline (+7) |
| WP-10 | built | full | e2e-tt39: WP-10 oracle: the same 27-request matrix (fetch + XHR; credentials include / same-origin / omit; ACAO * vs echoed; ACAC; preflights that pass, are reused from the cache (incl. `*` entries), deny a method, deny `*` with credentials, Authorization under `*`; a JSON body; a redirect; withCredentials before and after open(); cross-site Set-Cookie; Set-Cookie with omit) gives IDENTICAL results natively in Chromium and through the proxy — failures, cookies and Origin the sites saw, Sec-Fetch-Site/Mode, readable response headers; e2e-tt39: WP-10 oracle is not vacuous: the matrix exercises both outcomes — the cross-site request with credentials carries ONLY the SameSite=None cookie (b=1, not the Lax bl=1); same-origin reads the private header, cross-origin reads only exposed ones; ACAO * with credentials, a JSON body without a preflight answer and a denied method all FAIL; the cached preflight was not repeated; e2e-tt39: WP-10 adversary inside the page: an UNTAGGED raw request (the shim's own rawFetch, bypassing tagging) and a FORGED document id both reach B with Origin "null" and no cookies; a script-fetched copy of another site's page carries no document id (+8) |
| WP-11 | built | full | e2e-tt39: WP-11 oracle: Web Workers in a proxied page behave as natively — a classic worker (importScripts, relative fetch, new Request, XHR, a cross-origin fetch with the PAGE's origin, a WebSocket, a nested worker), a module worker (static import, top-level await, import.meta.url, awaiting its first message at top level, importScripts → TypeError; a module SharedWorker), a page-made blob: worker, SharedWorker (two connections share one instance; another name gets its own) and the SecurityError for a cross-origin script: results IDENTICAL natively and through the proxy |
| WP-12 | built | full | tt39-pac: PAC helpers vs the Netscape specification's own examples: isPlainHostName, dnsDomainIs, localHostOrDomainIs, dnsDomainLevels, shExpMatch, isInNet (incl. a name resolved through DNS), dnsResolve, isResolvable, myIpAddress, convert_addr, the …Ex IPv6-extension functions; shell classes [ab] / [a-z] / [!a]; tt39-pac: PAC date/time helpers at a fixed clock (Sunday 18 Oct 2026 14:30:15 UTC): weekdayRange incl. wrap past Saturday, dateRange in all 9 Netscape forms incl. ranges across the year end, timeRange in its 4 forms incl. wrap past midnight and second-exact bounds, 'GMT' as the last argument; tt39-pac: PAC results and plumbing: 'PROXY a:1; SOCKS5 [::1]:2; DIRECT' parses (default ports, IPv6, case-insensitive types); 9 malformed entries are skipped; https:// URLs reach the script as scheme://host:port/ only (no path, no query — as Chrome); FindProxyForURLEx is preferred when both exist; DNS answers come back through re-runs (one lookup per name, cached), DNS off answers null with NO lookup; 40 concurrent decisions each get their own answer (+5) |
| WP-13 | built | full | tt39-unit: permessage-deflate negotiation (RFC 7692 §7): the client offers 'permessage-deflate; client_max_window_bits'; valid answers parse (defaults 15/15, both no_context_takeover flags, quoted "10"); 12 hostile answers fail the handshake (another extension, two elements, unknown parameter, duplicate, value on a flag, bits 7 / 16 / 08 / missing value, unterminated quote, garbage); tt39-unit: permessage-deflate interop, defaults (Python websockets 13.1 server): negotiated; text and binary messages from 0 B to 1 MiB round-trip intact; a 1 MiB repetitive text message crosses the wire COMPRESSED in both directions (bytes counted on the socket); 50 similar messages in a row (context takeover) all decode; tt39-unit: permessage-deflate interop, non-default parameters (server_no_context_takeover, client_no_context_takeover, server_max_window_bits=10, client_max_window_bits=9 — the server requires our offer of client_max_window_bits): negotiated as such; repeated identical messages (back-references across messages would break the server's fresh-context inflater) and a message repeating a 600-byte random block (a distance a 9-bit window may not use) all round-trip (+3) |
| WP-14 | built | full | tt40-proxy: SOCKS4 + HTTPS proxy live (WP-14): https://pypi.org/ through pproxy's SOCKS4 server (it logs an IPv4 address — the NAME never reached the proxy, it was resolved here through the guard) and through pproxy as an HTTPS proxy (TLS to the proxy verified against a CA in NODE_EXTRA_CA_CERTS, pypi.org named only inside that TLS); without that CA the proxy is refused at TLS and never learns the destination; tt40-proxy: PAC failover live (WP-14): "PROXY <dead>; SOCKS <pproxy>; DIRECT" — pypi.org is carried by the SECOND entry (SOCKS = v4, Chrome's reading), the failover is recorded, and a repeat request goes straight to the healthy proxy (the dead one is remembered for 5 min, no second failover); a POST of 70 KB of mixed UTF-8 / binary-safe text fails over byte-exact (echo site's SHA-256) and the dead proxy received only the proxy handshake, never a byte of the body; a proxy that ANSWERS 403 for the destination is not failed over — no DIRECT leak; tt40-unit: route parsing (WP-14): socks4:// socks4a:// https:// are routes now, with Chrome's default ports (1080 / 443) and labels; still refused: unknown schemes, bad ports, paths (+8) |
| WP-15 | built | full | tt40-proxy: KDE live (WP-15): a fresh process in a KDE session (XDG_CURRENT_DESKTOP=KDE), with no proxy variables and no gsettings, reads ~/.config/kioslaverc (here via XDG_CONFIG_HOME) written in KDE 5's "http://host port" form and sends https://pypi.org/ through the proxy it names (pproxy logs it); ProxyType=0 means direct; tt40-proxy: WPAD live (WP-15): the machine's REAL resolver — "search eng.corp.fusion-test.example" in /etc/resolv.conf, wpad.corp.fusion-test.example in /etc/hosts, the PAC file on port 80 — GNOME "auto" with an empty URL (stand-in gsettings) and KDE ProxyType=3 each DISCOVER it by devolution (wpad → wpad.eng.… fail, wpad.corp.… answers; wpad.fusion-test.example is never needed) and pypi.org goes through the SOCKS proxy it names; with nothing to discover, auto-detect falls back to DIRECT with the tried list reported; tt40-unit: Windows (WP-15): the AutoDetect bit (0x08) of DefaultConnectionSettings byte 8 is read from the Connections key; other bits do not set it; an absent / short value is no flag; socks= is SOCKS v4 unless written socks5:// (Chrome's ProxyRules); auto-detect alone is a usable setting (+9) |
| WP-16 | built | full | e2e-tt40: WP-16 oracle: the cookies, Sec-Fetch-Site and Referer that sites A, A′ and B saw for 7 markup subresources of one page (a same-origin, a same-site and a cross-site image, a cross-site stylesheet AND the image that stylesheet loads, a cross-site script, and — created by page SCRIPT, tagged by the shim — a cross-site image that sets cookies) are IDENTICAL natively in Chromium and through the proxy; so is what that cross-site image could store (SameSite=Lax refused, SameSite=None kept); e2e-tt40: WP-16 oracle is not vacuous: cross-site subresources carried ONLY b=1 (not bl / bs / bd); same-site ones carried the Strict cookie too; the stylesheet's own image counted the PAGE as its initiator; Sec-Fetch-Site took all three values; nx (Lax from a cross-site response) was refused, ny kept; the page's markup really carries the subresource tag on img / link / script and NOT on navigations; e2e-tt40: WP-16 adversary: a FORGED document id on a subresource gets only SameSite=None cookies (never more than a cross-site load); an "r" tag on a script fetch() is re-tagged by the shim and follows the script rules (no cookies with credentials same-origin cross-site); an "r" tag on a NAVIGATION is ignored (a top-level-in-frame load keeps its cookies) (+3) |
| WP-17 | built | full | e2e-tt41: WP-17 oracle: an ES-module page — root-relative, parent-relative, absolute cross-origin imports; an import map with a bare prefix AND a URL-like key; export-from; dynamic import() of a literal AND of a root-relative path computed at run time; import.meta.url and import.meta.resolve; a module worker created with new Worker(new URL("./w.js", import.meta.url)) that itself imports root-relative and reports self.location / self.origin; an inline module — yields IDENTICAL values natively and through the proxy; e2e-tt41: WP-17/18/19 adversary: page fetch() of a module gets its bytes UNCHANGED (only script / worker destinations are rewritten); a module the lexer cannot tokenise (an unterminated template) is served unchanged and labelled; an "f" (frame) tag on an image is not honoured as a frame (no frame-tree cookies, the script rules apply: none cross-site); chain flags only ever REMOVE — a tag without them is what the shim emits, so a page cannot claim more; tt41-unit: WP-17 lexer oracle: 28 edge cases module lexers are known to get wrong (strings / comments / templates / regexes containing import, member and method named import, regex after while / export default / of / return / typeof / a newline, division vs regex, hashbang, import attributes, \u escapes, export * as, string-named imports, dynamic import with options and plain templates) — the specifier ranges are IDENTICAL to acorn's (+5) |
| WP-18 | built | full | e2e-tt41: WP-18 oracle: Response.url / redirected / type after redirects, XHR responseURL, Request.url (fragment kept), redirect TAINT (A→B→C: C sees Origin "null" and must allow "null"; A→B→A: no same-origin cookies, needs CORS), mode "same-origin" leaving the origin fails, the full page URL as same-origin Referer, a classic worker's importScripts + Response.url, and a data: worker's opaque origin — the page's view AND what A / B / C saw are IDENTICAL natively and through the proxy; tt41-unit: WP-18 segments: every legal flag combination round-trips through parseSidSegment / flagString / decodeTarget in canonical order; out-of-order, repeated or unknown flags, a flag on "r" / "f", and a short document id are all rejected; tt41-unit: WP-18 redirect chains (Fetch §4.4 / §4.1): A→B→C taints the origin (Origin "null") and marks the chain cross-origin and cross-site; A→B→A taints too and keeps the request non-same-origin (no same-origin cookies, origin-only Referer, Sec-Fetch-Site cross-site); A→A stays clean; flags are sticky (never cleared by a later hop); mode same-origin refuses the cross-origin hop |
| WP-19 | built | full | e2e-tt41: WP-19 oracle: a CROSS-SITE iframe (B in A) — its navigation, its own image and its same-origin fetch get only SameSite=None cookies, and its Set-Cookie may store only SameSite=None; a SAME-SITE iframe (A′ in A) keeps every cookie and may store Lax — identical natively and through the proxy, including Sec-Fetch-Site and Referer; e2e-tt41: WP-17/18/19 adversary: page fetch() of a module gets its bytes UNCHANGED (only script / worker destinations are rewritten); a module the lexer cannot tokenise (an unterminated template) is served unchanged and labelled; an "f" (frame) tag on an image is not honoured as a frame (no frame-tree cookies, the script rules apply: none cross-site); chain flags only ever REMOVE — a tag without them is what the shim emits, so a page cannot claim more; e2e-tt42: WP-19 srcdoc frames (TT41 blocker): a STATIC srcdoc (server-rewritten: its image, its script's fetch, its inline MODULE's root-relative import, and a NESTED srcdoc's image) and DYNAMIC srcdoc set by script through the property and through setAttribute (shim-rewritten in an inert DOMParser document, runtime injected) — every resource reaches the site and every value the frames report to their parent is IDENTICAL natively and through the proxy (+2) |
| WP-20 | built | full | e2e-tt42: WP-20 oracle: computed dynamic import() — root-relative in the document AND in a module worker (where no import map applies), a colon in the first path segment (document and worker), an absolute CROSS-ORIGIN URL object (document and worker; CSP refuses the raw URL), new URL("./x", import.meta.url), a template, a relative computed path in the worker, a bare name routed by the page's map, a missing module (same rejection), a classic inline script's computed import, and an eval'd import() routed only by an import-map SCOPE — every value IDENTICAL natively and through the proxy; tt42-unit: WP-20 wrapper value semantics: for 20 run-time specifier values (root-relative, ./, ../, a colon in the first path segment, absolute http(s), protocol-relative, URL objects, an object with toString, credentials in the URL, bare names, data:, blob:, already-proxied, a non-http scheme, an unparseable string) the inline wrapper yields EXACTLY what the static rewriter yields for the same literal (or the string itself where the static rewriter leaves it); a throwing toString / a Symbol is passed through untouched so import() rejects natively; tt42-unit: WP-20 lexer: the first argument of every computed dynamic import is found with exactly acorn's source range — 19 shapes incl. nested templates, commas inside calls / arrays / objects, comments, a trailing comma, nested imports (literal inside computed, computed inside computed), import.source / import.defer — and literal imports, object / class METHODS named import and member calls are never wrapped (+3) |
| WP-21 | built | full | e2e-tt42: WP-21 browsers WITHOUT Fetch Metadata (TT41 blocker; emulated at the HTTP layer: real Chromium behind a front that removes every Sec-Fetch-* header, as Safari < 16.4 sends none): the destination is inferred from the URL tag + Accept — module scripts and module workers are still rewritten (all computed / static imports identical to native), a page fetch() of a module still gets its bytes UNCHANGED (the shim's "e" flag = destination empty), and a page fetch() of a document gets NO navigation secret (before TT42 every untagged request without Fetch Metadata counted as a navigation); tt42-unit: WP-21 destination inference without Fetch Metadata: Safari's real Accept values (document / image / stylesheet / */*) and the URL tag decide — untagged document → navigate, untagged image / css → no-cors image / style, a markup-subresource tag → its Accept or script, a script tag → script (CORS) or, with the shim's "e" flag, empty (fetch / XHR), a frame tag → iframe; ANY Fetch Metadata header present → null (the browser's own values win); "e" round-trips in canonical order after "n", is rejected out of order, and survives a redirect hop |
| WP-22 | built | full | e2e-tt43: WP-22 oracle: SharedWorker shared like Chromium's own — two tabs of one profile (Fusion split view, one proxy session) and their nested same-site frames reach ONE worker (count and connections continue across them), a tab of another session gets its own; self.name, self.location, the worker's cookie jar (cookies set by BOTH tabs of the profile, only the other tab's in the other session), a second named worker, SecurityError for another site's script, SyntaxError for a bad URL and the error event of a missing script — every value IDENTICAL natively and through the proxy; e2e-tt43: WP-22 hosts and lifecycle (proxied): one hidden host document per (session, site) — opaque origin, sandboxed — and when the last page of a session leaves the site its host is removed (after the grace), while the other session's worker keeps its state; coming back starts a fresh worker; e2e-tt43: WP-22 attacks (proxied): a page that forges a connect with a document id the server never issued, or names another site's script, gets an error and no worker; a proxied page calling the broker's server endpoints directly (__shared-who / __shared-host) cannot read them, and the server refuses such requests (403: only the Fusion window may), so it can neither learn about documents nor mint host documents (+6) |
| FF-38 | built | full | e2e-tt59: FF-38 Writer spell check in the UI: highlights painted → F7 pane Change / typed Change / Ignore All / Delete repeated word → right-click menu suggestion → Add to Dictionary persists → Escape closes only menu/pane → saved document.xml (lxml); tt59-writer-spell: en_US: every verdict equals spylls (Hunspell port) on ~22k words — forms, misspellings, case, ordinals, apostrophes, hyphens; tt59-writer-spell: hand-written dictionary (FLAG long, KEEPCASE, FORBIDDENWORD, NEEDAFFIX, NOSUGGEST, BREAK, COMPOUNDRULE ?, conditions, cross product) equals spylls (+6) |
| FF-39 | built | full | e2e-tt59: FF-39 Spreadsheet spelling + FF-28 Paste Link in the UI: F7 → 1 of 3 row-major → Change / typed Change / Delete repeated word → complete; formula untouched; Escape closes the panel only; Paste Link =$C$1 follows the source; openpyxl reads the save; tt59-sheet-spell: only text constants are checked (formulas, numbers, logicals, errors skipped); quote prefix offsets; row-major order; repeated words; tt59-sheet-spell: selection scope, Ignore All / Ignore Once, user dictionary (+3) |
| FF-40 | built | full | e2e-tt60: FF-40 Writer table revisions in the UI: tracked Row below + Delete row → change bars + Review list; Column right tracked + rejected; saved trPr ins/del verified by lxml; per-change Accept removes the row; TT64: tracked Column right listed and rejected; tt60-writer-tblrev: recording: an inserted row is w:trPr/w:ins and a deleted row w:trPr/w:del with its text as w:delText (oracle); CT_TrPr order; ids unique; python-docx opens; tt60-writer-tblrev: accept-all / reject-all (ours) equal the oracle's independent views, live and after save → re-open (+5) |
| FF-41 | built | full | e2e-tt60: FF-41 Spreadsheet spelling in all sheets: F7 → All sheets → tab order from the active sheet; Change switches to the issue's sheet; Change All covers every sheet; openpyxl reads the save; tt60-sheet-spell-all: all sheets: tab order from the starting sheet, wrapping; a selection range is ignored; single sheet unchanged; tt60-sheet-spell-all: openpyxl 3-sheet .xlsx: Change All across sheets, a fix on a non-active sheet, saved losslessly, openpyxl reads every sheet back |
| FF-42 | built | full | e2e-tt60: FF-42 Writer spelling in headers and notes: F7 lists body → Header → Footnote 1 issues; Change fixes them in place; saved file verified by python-docx and lxml; e2e-tt61: FF-42 completion: a header misspelling is underlined on the page itself — a spelling highlight range lies inside the page header box on every page (2 pages), and disappears after Change; tt60-writer-spell-stories: issues in every story: main text first, then header, footer, footnote — each with its place; spellIssues (main) unchanged (+2) |
| FF-43 | built | full | e2e-tt61: FF-43 Writer: editing a formatted footnote in the Notes panel keeps its bold / italic / underline (lxml reads the saved runs); the edit is exact and the reference mark still leads; e2e-tt61: no page errors during the suite; tt61-writer-notes-rich: fixture sanity: the lxml-written formatted note reads back as written (independent probe) and as text in our model (+6) |
| FF-44 | built | full | e2e-tt61: FF-44 Writer cell revisions in the UI: lxml-written cellIns / cellDel listed as [Table cell]; Accept the deletion removes the cell on the page; Reject All removes the inserted cell; saved file passes the oracle (tables, grid_ok, no markers); e2e-tt62: FF-44 Writer vertical-merge revisions in the UI: the proposed merge is drawn (rowspan 2), both cellMerge changes are listed with their states; Reject each → cells unmerged on the page and in the saved file (lxml oracle + XSD); e2e-tt62: FF-44: Accept all on the same proposal keeps the merge — saved file has restart / continue and no marker (lxml oracle + XSD); the page still spans (+9) |
| FF-45 | built | full | tt62-writer-schema: the oracle is a real verifier: it rejects wrong child order, an unknown element, a bad enumeration value and an unknown non-ignorable namespace; it accepts a w14 extension declared ignorable; tt62-writer-schema: randomized editing sessions: 24 sessions × 60 steps (all edit operations, Track Changes toggled) on two starting documents; every saved package (checked every 10 steps) is schema-valid; tt62-writer-schema: kitchen sink: every run property on one run, every paragraph property + style + list on one paragraph, the same again under Track Changes (rPrChange / pPrChange with everything), a table cell with shading inside a landscape A4 section with first-page header — schema-valid (+2) |
| FF-46 | built | full | tt62-sheet-schema: oracle sanity on SpreadsheetML: mergeCells before sheetData, a bad cell type enumeration and an unknown element are rejected; our fresh export of an empty workbook is valid; tt62-sheet-schema: kitchen sink (fresh export): every style / border line, merges, 6 validation types, links, freeze panes, widths, names, all 25 CF kinds, 7 chart kinds × groupings + trendlines, a PivotTable, awkward sheet names — every part schema-valid, and it reads back; tt62-sheet-schema: 20 randomized workbooks (random subsets of every feature, random sizes) — every fresh export is schema-valid (+11) |
| FF-47 | built | full | e2e-tt63: FF-47 PivotTable saved as a real Excel PivotTable from the UI: create with a report filter → Save → XSD + pandas + openpyxl oracles; reopen → source edit → Alt+F5 → Save regenerates in place; Delete → Save removes every pivot part; e2e-tt63: no uncaught page errors during the TT63 session; tt63-sheet-pivotparts: 1. fresh export: 13 pivot shapes are schema-valid, recomputed by pandas from the XML, survive openpyxl (+9) |
| FF-48 | built | full | e2e-tt64: FF-48 Writer tracked columns in the UI: Track changes → Column right (3 inserted cells, one '[Table column]' change) → Delete column (3 deleted cells, a second change) → Reject the deletion, Accept the insertion → Save → lxml oracle + XSD; a gridBefore row renders on the grid; e2e-tt64: no page errors during the TT64 session; tt64-writer-trackcols: a tracked column insert: every new cell carries w:cellIns (unique ids, author, date), the old widths go in w:tblGridChange; one '[Table column]' change; schema-valid; the file round-trips the grouping (+5) |
| FF-49 | built | full | e2e-tt65: FF-49 Track Changes in every story in the UI: tracked header Apply (struck / inserted runs on the page), a field-cutting edit refused with no phantom undo step (Ctrl+Z / Ctrl+Y), tracked Notes edit, Review by place, reject footnote items singly + Accept all → Save → lxml oracle + XSD; e2e-tt65: no page errors during the TT65 session; tt65-writer-stories: header & footer Apply under Track Changes: edited line, alignment, new and removed lines are w:ins / w:del / w:pPrChange — oracle Accept All = the untracked edit, Reject All = the original; our Accept / Reject All agree; Review names the place (+7) |
| FF-50 | built | full | e2e-tt66: CF panel → Excel 2010 rules (axis bar, 3Stars, custom icons) drawn at once → Save → saved .xlsx passes the MS-XLSX x14 schema + structural oracle and the ECMA XSDs → reopen lists and draws the same; e2e-tt66: modal-shortcut failure test: keys pressed in the new CF controls (band icon select, bar axis select, colour inputs) never edit, clear or undo the grid cell; e2e-tt66: no uncaught page errors during the session (+22) |
| FF-51 | built | full | tt67-sheet-ns: lxml equivalence: every rewritten XML part of the 353-file corpus + 15 adversarial shapes keeps its expanded names, attributes, text, comments and MCE prefix meanings, in canonical prefixes; Excel's own parts take the no-copy fast path; tt67-sheet-ns: adversarial shapes read correctly: comment / CDATA / PI lookalikes untouched, no-namespace children undeclare the default, strict prefixes canonical, value text is not a declaration, foreign namespace on the x14 prefix aliased away, x14 as the default namespace becomes x14:, MCE lists follow the renaming; tt67-sheet-ns: the 7 corpus workbooks TT66 could not read (x: / s: SpreadsheetML prefixes, prefixed mc:AlternateContent) open, and every non-empty cell equals an lxml namespace-aware reader and (where it can open the file) openpyxl; TT66 rejected 6 and read 0 cells from the 7th (+12) |
| FF-52 | built | full | e2e-tt68-sheet: FF-52 in the UI: an opened workbook shows Excel's results for empty text and an error constant (ISBLANK FALSE / TRUE, COUNTIF "#N/A" 1, COUNTA 3, "=" 1, "<>" 3, ISNA TRUE); e2e-tt68-sheet: FF-52 typing: ' makes empty text (ISBLANK FALSE), #n/a makes an error constant (ISNA TRUE); Save → lxml lists A1 and C1 as empty text, openpyxl reads C2 as an error cell; e2e-tt68-sheet: shortcut scope: Paste Special is a non-modal bar (TT60) — the grid keeps the keyboard and ArrowRight still moves the target, but typing, Delete, Backspace, F2, Enter, Ctrl+X / V / Z / D / B never edit the cell behind it, nor do keys typed into the bar's own controls; Escape closes only the bar (Spreadsheet stays open) (+9) |
| FF-53 | built | full | e2e-tt74-office: AutoFilter list hides rows (SUBTOTAL 9 and 109 skip them), Hide rows hides by hand (only 109 skips), arrows skip hidden rows; Save → openpyxl sees hidden rows + the filter; Unhide shows hand-hidden rows only; Clear shows the rest; e2e-tt74-office: modal shortcut: with the filter list open, typing, Delete, Backspace, Ctrl+V / Z / X never edit the cell behind it; Escape closes the list and the grid has the keyboard again |
| FF-54 | built | full | e2e-tt74-office: AutoFilter list hides rows (SUBTOTAL 9 and 109 skip them), Hide rows hides by hand (only 109 skips), arrows skip hidden rows; Save → openpyxl sees hidden rows + the filter; Unhide shows hand-hidden rows only; Clear shows the rest |
| FF-55 | built | full | e2e-tt74-office: Export CSV: the dialog lists what CSV drops; OK downloads the displayed text of the used range; Cancel downloads nothing; Import CSV adds a typed sheet and keeps =… as text |
| FF-56 | built | full | e2e-tt74-office: Writer: Export Markdown downloads heading / bold / list Markdown after the loss dialog; From Markdown opens a new document with the converted heading and list |
| FF-57 | built | full | e2e-tt74-office: Slides: Outline downloads the deck's titles, bullets and notes as Markdown after the loss dialog |
| FF-58 | built | full | tt75-office: T1 corpus → new package: every table written (openpyxl agrees on name / ref / header / totals / columns / filter), structured formulas keep their values after reopening, table parts schema-valid, file-form formulas; tt75-office: T2 corpus structural edits on every table: insert / delete a body row and a column inside it, delete the whole table, refuse a header-only delete — probes follow the invariants; new package and in-place save carry the geometry (openpyxl); tt75-office: T3 table rules: refusals (header row, two tables), totals row, last body row kept, removed column / table → #REF!, file form of [@Col] / name-less refs, strings untouched (+12) |
| FF-59 | built | full | tt75-office: N9 range memo is invisible: 300 random workbooks with lookups, COUNTBLANK / COUNTA, spills, INDIRECT and cycles through ranges evaluate identically with the memo on and off |
| FF-60 | built | full | e2e-tt75-books: B6 fixed layout: the 900×600 viewport is scaled to fit; a spread puts page-spread-left on the left; spread none shows one page; e2e-tt75-books: B12 roll layout: all parts are stacked in one vertical scroller; tt75-epub: N22 right-to-left spreads: page-spread-right starts a pair, page-spread-left completes it; left-to-right is the mirror image |
| FF-61 | built | full | e2e-tt75-books: B4 safety: book scripts and handlers never run, no allow-scripts, CSP meta present; an external link asks first and Cancel opens nothing; tt75-epub: W2 IDPF epub3-samples (45 books): open, every spine document prepared and safe, images / media / styles point to manifest resources, the TOC resolves into the spine; tt75-epub: N1 <script> (XHTML and SVG, any prefix) is removed (+19) |
| FF-62 | built | full | e2e-tt76-sheet: modal shortcut: an untouched Condition dialog has OK disabled; Enter (in the empty value box) applies nothing; Escape closes it; e2e-tt76-sheet: Top 2 shows only the two largest; reopening pre-fills Top 2; Below average; Clear shows every row; e2e-tt76-sheet: Custom: contains "e" Or begins with "z" (wildcards) on the name column; And with a second column's Top 5 (+15) |
| FF-63 | built | full | e2e-tt76-slides: E1 author transition + animations in the Motion panel → Ctrl+S → lxml reads exactly what was authored; e2e-tt76-slides: E2 remove + undo / redo: the effect list follows the document; e2e-tt76-slides: E3 show: Preview → shapes wait hidden → → plays Fly In (CSS animation) → → next slide enters through its transition → ← steps back built (+10) |
| FF-64 | built | full | e2e-tt78-sheet: Subtotal dialog → totals + 1-2-3 outline; level 2 shows only totals; +/− expands one group; Save → openpyxl sees levels / hidden / collapsed / SUBTOTAL; e2e-tt78-sheet: modal shortcut: Alt+Shift+→ asks Rows/Columns; a second Alt+Shift+→ while asked does nothing; Escape groups nothing; 'rows' groups; Alt+Shift+← ungroups; tt78-sheet: O1 corpus outline oracle: levels / collapsed / hidden / summary placement == openpyxl (+8) |
| FF-65 | built | full | e2e-tt78-sheet: calculated column: =A2*B2 fills the column; typing below grows the table and fills; one Ctrl+Z undoes both; Save → openpyxl calculatedColumnFormula + ref; tt78-sheet: O2 corpus calculated columns: calc == openpyxl, and calc shifted per body row == Excel's cell formulas; tt78-sheet: M3 calculated columns: F1 fill, F2 refill, E1 exception, F3 no fill, X1/X2 grow, S1 structure (+4) |
| FF-66 | built | full | e2e-tt77-pdfsig: S1 real-world BER qualified signature → valid, signer, identity disclaimer, chain; e2e-tt77-pdfsig: S2 changed after signing → 'modified'; Open signed version → that revision is valid; e2e-tt77-pdfsig: S3 tampered → Invalid (+27) |
| FF-67 | built | full | tt77-pdf: J1 JBIG2: every corpus JBIG2 image bit-exact vs PDFium (1 declared divergence); tt77-pdf: J2 JPX: every corpus JPX image within ±2 of PDFium (1 declared divergence: SMaskInData 1 pre-composited by PDFium); tt77-pdf: J3 JPX vs OpenJPEG: 40 generated codestreams — lossless = source exactly, lossy ±1 (+8) |
| FF-68 | built | full | tt77-pdf-composite: C1 fill+stroke at ca=CA=.5 is a knockout pair: interior = fill over backdrop, stroke over backdrop (not over fill); tt77-pdf-composite: C1b the same knockout pair straight on the (transparent) page, nothing under it: identical result once the paper goes under; tt77-pdf-composite: C2 fill+stroke with BM Difference over white: both halves are the complement (yellow → blue) (+15) |
| FF-69 | built | full | e2e: mount: archive; tt79-archive: C1 Python zipfile stored/deflate/bzip2/LZMA: every entry equals Python's read (bytes + CRC); tt79-archive: C2 own inflater == zlib (every deflated corpus entry + node:zlib levels 0–9 + Python entries) (+7) |
| FF-70 | built | full | e2e-tt79-archive: 5 Files integration: .zip opens Archive; server extract → 401 needPassword then extracts; compress with password → pyzipper; e2e: mount: archive; tt79-archive: V1 crypto vectors (FIPS-197, FIPS 180, RFC 6070) + 200 random cross-checks against node:crypto (+5) |
| FF-71 | built | full | e2e-tt79-archive: 1 AES archive: derived folders, navigation, locked preview; MODAL SHORTCUT (Delete/F2/Ctrl+A inert behind the password dialog); wrong → asked again; right → exact text; PNG preview; e2e-tt79-archive: 2 keyboard edits: Delete + F2 + New folder → Save → pyzipper decrypts the renamed entry with the ORIGINAL password; Undo restores; e2e-tt79-archive: 3 Extract all → Files equals pyzipper; zip-slip archive: 'unsafe' badges, only safe entries written (+6) |
| FF-72 | built | full | e2e-tt79-archive: 6 Test: every entry verified; a corrupted archive names the damaged entry; e2e: mount: archive; tt79-archive: N1–N24 negative shapes (zip-slip, symlink, duplicates, overlap, mismatch, bombs, lies, tamper, multi-volume, truncation, limits, methods) |
| FF-73 | built | full | e2e-tt79-pdf: Q1 Import .p12: wrong password asked again; Ctrl+S / Delete inert behind the dialog; identity with chain; e2e-tt79-pdf: Q2 visible signature on page 2 → Ctrl+S → pyHanko valid + trusted; widget bottom-right of page 2; drawn by Fusion; e2e-tt79-pdf: Q3 Trust this certificate → Identity trusted; survives reload; Remove → not verified (+23) |
| FF-74 | built | full | e2e-tt79-pdf: Q1 Import .p12: wrong password asked again; Ctrl+S / Delete inert behind the dialog; identity with chain; e2e-tt79-pdf: Q2 visible signature on page 2 → Ctrl+S → pyHanko valid + trusted; widget bottom-right of page 2; drawn by Fusion; e2e-tt79-pdf: Q3 Trust this certificate → Identity trusted; survives reload; Remove → not verified (+11) |
| FF-75 | built | full | e2e-tt79-pdf: Q1 Import .p12: wrong password asked again; Ctrl+S / Delete inert behind the dialog; identity with chain; e2e-tt79-pdf: Q2 visible signature on page 2 → Ctrl+S → pyHanko valid + trusted; widget bottom-right of page 2; drawn by Fusion; e2e-tt79-pdf: Q3 Trust this certificate → Identity trusted; survives reload; Remove → not verified (+8) |
| FF-76 | built | full | tt79-sheet: X1 POI Strict workbooks: every cell == openpyxl on the namespace-mapped copy; formulas recompute to the cached values; tt79-sheet: X2 t="d" cells in 1900 and 1904 workbooks == openpyxl (from_ISO8601 + to_excel); tt79-sheet: X3 edges: dateCompatibility=0, bare times, impossible dates stay text |
| FF-77 | built | full | tt79-sheet: X4 text → number coercion (numtext.ts): en-US currency, groups, %, parentheses, exponent; hex / Infinity / dates refused; tt79-sheet: X5 the 10 EverythingTests shapes fixed in TT79, rebuilt in a fresh workbook, with negative controls; tt81-core: S5 all 4158 cells across all 4 sheets of FormulaEvalTestData_Copy.xlsx agree with Excel cached values (includes G716, D872, E872, M936) |
| FF-78 | built | full | e2e-tt81: E1 Spreadsheet MODE.MULT spill in real grid, edit, save and reopen computed output; tt81-core: S1 MODE/SNGL scalar reference vs range, errors, ties and no duplicates; tt81-core: S2 MODE.MULT vertical spill, collision, clear/recalculate, xlsx round-trip and independent openpyxl formula (+3) |
| FF-79 | built | full | e2e-tt81: E2 PDF custom signature box: refuse off-page without saving, then sign valid box, save and independent pypdf geometry; tt81-core: P1 custom box geometry exact all rotations, negative crop origin and edge boxes; tt81-core: P2 refuse NaN, infinities, zero, negative, off-page, malformed geometry before signing (+1) |
| FF-80 | built | full | e2e-tt81: E3 Slides Find/Replace via Tweak menu, literal matching, undo/redo, modal shortcut isolation, save and python-pptx readback; tt81-core: L1 literal case/scope, groups and tables; no notes/master/package false hits; tt81-core: L2 cross-run replacement keeps first style, independent python-pptx reads tables/groups, untouched parts identical (+4) |
| FF-81 | built | full | e2e-tt81: E4 PDF /UserUnit reaches the live viewer, text highlights, info panel and bounded canvases; pypdf and PDF.js independently verify; tt81-core: P4 PDF /UserUnit scales page transforms, indirect refs, CropBox offsets and 4 rotations; pypdf and MuPDF independently verify dictionary and physical raster/ink |
| FF-82 | built | full | e2e-tt81: E5 Writer Word Count reports document and selected text through the real UI and excludes tracked deletions; tt84-wordcount: W1 empty text has zero counts; tt84-wordcount: W2 spaces, blank paragraphs and CRLF do not inflate words or character totals (+10) |
| CT-01 | built | full | e2e-tt70-rows: CT-01 share target: manifest share_target → / ; ?url= opens a Browser tab on it and cleans the query; a javascript: URL never runs; Notes Share passes title + body to navigator.share (injected recorder — no OS share sheet in headless Linux); tt139-media: CT-01 · payloads are validated before any target sees them; tt139-media: CT-01 · targets are matched by kind with a reason for each (+13) |
| CT-02 | built | full | e2e: mount: share; e2e: WebRTC data channel between two contexts via Postgres signalling; integration: CA-09 signalling: targeted delivery, no self-echo, kind whitelist, size cap |
| CT-03 | built | full | e2e-tt146: CT-03 a link made here opens the same desktop there, and a tampered one is refused; tt139-media: CT-03 · a superseded handoff cannot be accepted (the race); tt139-media: CT-03 · expire clears the item; an invalid offer is refused (+5) |
| CT-04 | built | full | e2e-tt114-shell: CT-04: the audience view follows the room the presenter publishes |
| CT-05 | built | full | tt143-engines: CT-05 remote: an unregistered scheme is copied, a registered one is a handoff, http is refused |
| CT-06 | built | partial | e2e: mount: devices |
| CA-01 | built | partial | e2e: mount: media; e2e: mount: beam |
| CA-02 | built | full | e2e-tt76-slides: E7 presenter view (CA-02): the audience window gets the deck and follows the console; clicks on the audience advance the presenter; notes / next / timer on the console; End closes the audience; e2e: mount: beam; integration: CA-11 Together anchor clock advances while playing and freezes on pause (+1) |
| CA-03 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-04 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-05 | built | partial | e2e: mount: beam; e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-06 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-07 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-08 | built | full | tt140-cast-privacy: CA-08 · the target is a screen that is NOT the current one; tt140-cast-privacy: CA-08 · a mirrored desk is refused, not mislabelled; tt140-cast-privacy: CA-08 · among several candidates the largest usable area wins (+4) |
| CA-09 | built | partial | e2e: mount: share; e2e: WebRTC data channel between two contexts via Postgres signalling; integration: CA-09 signalling: targeted delivery, no self-echo, kind whitelist, size cap |
| CA-10 | blocked | full | e2e: Beam lists every transport and names the missing primitive on blocked ones |
| CA-11 | built | partial | e2e: mount: together; integration: CA-11 Together anchor clock advances while playing and freezes on pause; integration: Together GET accepts lowercase room codes (casing fix) |
| CA-12 | built | full | e2e: Beam lists every transport and names the missing primitive on blocked ones; tt143-engines: CA-08/CA-12 cast: a fetchable URL is available, a blob is refused, and the blocked protocols say why |
| CA-13 | built | full | e2e: mount: share; tt139-cast-governor: CA-13 · score is bounded, monotone in each input, and zero at perfection; tt139-cast-governor: CA-13 · a single bad sample never moves the ladder (the anti-flicker rule) (+10) |
| CA-14 | built | partial | tt107-features: a never-seen cast target arrives untrusted and trust is remembered; tt107-features: trust can be withdrawn again for one target only; tt107-features: a cast session cannot be opened against an unregistered target |
| CA-15 | built | full | e2e: mount: together; integration: CA-11 Together anchor clock advances while playing and freezes on pause; tt137-system-engines: CA-15 · add and set leader (+3) |
| LN-01 | built | full | e2e: mount: lens; e2e: Lens processes frames from a (fake) camera at > 0 fps |
| LN-03 | blocked | untested |  |
| LN-04 | built | full | e2e-tt108-shell: the colour and light chain changes the rendered frame, not just a label; tt139-media: LN-04 · temperature is neutral at 0 and clamps its input; tt139-media: LN-04 · vignette darkens corners only, and is exact at strength 0 (+3) |
| LN-05 | built | full | e2e-tt109-shell: output height really rescales the pipeline, and the upscale is labelled as interpolation rather than a model; tt137-system-engines: LN-05 · planUpscale validates inputs; tt137-system-engines: LN-05 · planUpscale rejects overscale (+5) |
| LN-06 | built | full | e2e-tt109-shell: the virtual key light actually adds light to the rendered frame and can be taken away again; tt137-system-engines: LN-06 · planRelight validates sources; tt137-system-engines: LN-06 · planRelight rejects too many sources (+6) |
| LN-07 | built | full | e2e-tt108-shell: the microphone is opened with the real WebRTC processing constraints, and the track reports them applied |
| LN-08 | built | full | e2e-tt108-shell: the voice gate really runs on the audio thread and silences a signal below its threshold; tt142-voice-gate: LN-08 · silence keeps the gate shut and never leaks gain; tt142-voice-gate: LN-08 · speech opens the gate in a couple of milliseconds (+7) |
| LN-09 | built | full | e2e-tt114-shell: LN-09: a scene really paints on a canvas, and "off" paints nothing at all; e2e-tt114-shell: LN-09: the scene animates when it should and stops dead when the shell is under load; e2e-tt114-shell: no page error was raised by any of this turn's shell work (+8) |
| LN-10 | blocked | untested |  |
| LN-11 | blocked | untested |  |
| LN-13 | built | partial | e2e: mount: lens; e2e: Lens processes frames from a (fake) camera at > 0 fps |
| LN-14 | blocked | partial | e2e: mount: lens |
| LN-15 | built | partial | e2e: Lens processes frames from a (fake) camera at > 0 fps |
| MS-02 | blocked | partial | tt107-features: every capability declared blocked is still refused with a stated reason |
| MS-03 | blocked | partial | e2e: mount: messages |
| AX-01 | built | full | e2e-a11y: axe-core WCAG 2.x A/AA on every module window and the shell chrome: no serious or critical violations; e2e-tt113-density: a disclosure opens from the keyboard alone; e2e-tt114-density: AX-17: shortening the labels cost no control its name (+5) |
| AX-02 | built | partial | e2e-tt55-files: regressions: one roving tab stop in the listing, one file input, Space selects / Enter opens, axe finds no serious violations in the new chrome (tabs, toolbar, menu, tree); e2e-tt96-desktop-menu: a lower-right desktop context menu stays within its usable surface and Sort can be clicked; e2e-tt96-desktop-menu: the geometry and real click checks detect an injected old-style offscreen placement (+4) |
| AX-03 | built | full | e2e-a11y: forced colours and prefers-contrast: more are honoured (buttons get system borders, muted text brightens); tt142-browser: the desktop re-flows at 1024×640 without losing a window off-screen |
| AX-04 | built | full | e2e-tt56-rows: AX-04 focus not obscured: Tab into a control of a covered window raises that window (server focus + top z); programmatic focus does not |
| AX-05 | built | partial | e2e-tt110-banner: in Art layout a window does not repeat the menus the shell menu bar is already showing; e2e-tt110-banner: the fonts and alignment bar fits inside the window instead of scrolling sideways; e2e-tt110-banner: the fonts and alignment bar fits without scrolling in fusion layout too (+5) |
| AX-07 | built | full | tt111-core: SRT becomes WebVTT the way a browser needs it, and WebVTT is left alone; tt139-systems: AX-07 · cue model enforces the floor and no overlaps; tt139-systems: AX-07 · wrapping respects the two-line rule (+5) |
| AX-08 | built | full | a11y-unit: token text contrast ≥4.5:1 (WCAG 1.4.3): body, muted, badges, desktop labels over the brightest wallpaper spot; e2e-a11y: axe-core WCAG 2.x A/AA on every module window and the shell chrome: no serious or critical violations; e2e-a11y: light + dark theme, all 13 styles: axe finds no serious violations in the chrome, Files and Spreadsheet (+31) |
| AU-01 | built | full | e2e-tt147: AU-01 a routine is previewed, saved, rehearsed, then run — and the audit tells them apart; e2e-tt97-palette-actions: register keeps palette actions partial and discloses native Cast and privacy limits; e2e-tt97-palette-actions: action-mode quick note is inert while typing, stays out of search requests and creates an indexed note only on selection (+15) |
| AU-02 | built | full | e2e: mount: routines; integration: AU-02 presets list and delete; non-prefixed rows cannot be deleted; tt111-core: workspace presets are stored as their own rows and restoring one does not invent a viewport |
| RG-01 | built | full | e2e-tt112-shell: SH-12: real long tasks drive the governor into a throttled state and the shell drops effects; e2e: mount: monitor; e2e: governor reacts to injected long tasks (+5) |
| RG-02 | built | full | e2e-tt112-shell: every capability claim matches what this browser actually exposes (no invented support); tt139-systems: RG-02 · scheduling hints defer heavy work under pressure; tt145-engines: RG-02 budget: user-blocking slices are admitted before background ones, a non-resumable slice that does not fit is deferred whole, an overrun changes the next estimate, and an absent isInputPending is labelled a downgrade |
| RG-03 | built | full | e2e-tt56-rows: RG-03 idle: with the desktop static for 3 s, zero requestAnimationFrame callbacks run (rAF counted by an init script) |
| RG-04 | built | full | e2e: mount: monitor; e2e: governor reacts to injected long tasks; tt139-systems: RG-04 · resource report distinguishes spiky from steady |
| RG-05 | built | full | e2e-tt60: RG-05 Backup refuses on a low discharging battery (injected getBattery 12%) with the reason, Build anyway works; Monitor shows background work paused; charging builds directly; tt60-units: RG-05 heavyWorkRefusal: < 20 % and discharging refuses (says the level); 20 %, charging, unknown battery go ahead; Data Saver refuses; tt60-units: RG-05 governor snapshot: a low discharging battery pauses background work and states why; charging restores it |
| RG-06 | built | full | tt111-core: the new-device checklist is a real diff of two measured reports, and absent memory data is not low memory; tt139-systems: RG-06 · low-memory mode degrades explicitly; unit: RG-06 memory policy: absence is not low memory |
| RG-07 | built | full | e2e-tt56-rows: RG-07 capability report: ≥ 40 APIs in Settings → Capabilities, each row has detail/degrade text, sampled rows equal independent detection |
| HW-01 | built | partial | e2e: drag a window by its title bar; geometry is committed and persisted |
| HW-02 | built | full | tt139-systems: HW-02 · CPU-bound pool leaves a core for the main thread; tt139-systems: HW-02 · memory budget and load level can veto the plan; tt139-systems: HW-02 · realistic throughput is below the ideal (Amdahl honesty) (+1) |
| HW-03 | built | full | tt145-engines: HW-03 codecs: a bare family name is not turned into a profile, a mismatched profile is refused, 'maybe' keeps a fallback loaded, and an absent mediaCapabilities is unmeasured rather than guessed; tt146-core: HW-03 verdicts follow the probe's answers and never claim silicon; tt146-core: HW-03 a probe that never answers cannot hang the matrix |
| HW-04 | built | full | e2e-tt147: HW-04 the accelerator card agrees with a direct WebGPU request in the same page; tt139-platform: HW-04 · an inference tier is only certified by a timed run, with warm-up discarded; tt147-core: HW-04 an adapter that names SwiftShader is reported as software, not as a GPU |
| HW-05 | built | full | e2e-tt112-shell: every capability claim matches what this browser actually exposes (no invented support); tt139-systems: HW-05 · latency budget adds up and classifies honestly; tt139-systems: HW-05 · voice count shrinks with convolvers (+1) |
| HW-08 | built | full | e2e-tt112-shell: every capability claim matches what this browser actually exposes (no invented support); tt139-engines: HW-08 · Base64 matches RFC 4648 test vectors exactly; tt139-engines: HW-08 · Base64 handles non-Latin-1 text and rejects invalid input (+4) |
| HW-09 | built | full | e2e-tt112-shell: SH-07 first run: the capability report is measured in this browser, not asserted; e2e-tt146: HW-09 one probe re-plans every open surface: the painted gallery widens with the tier; tt139-platform: HW-09 · a cached or tiny sample is not a measurement (+6) |
| CM-01 | blocked | partial | tt107-features: every capability declared blocked is still refused with a stated reason |
| CM-02 | built | partial | tt107-features: embed probe reports a framing refusal from X-Frame-Options; tt107-features: embed probe reports a framing refusal from CSP frame-ancestors; tt107-features: embed probe clears a permissive page so it can become a window (+1) |
| BL-01 | built | full | e2e: mount: settings; integration: BL-01 licence: valid key verifies; one flipped character fails; wrong client is refused |
| BL-02 | built | full | integration: BL-01 licence: valid key verifies; one flipped character fails; wrong client is refused; tt110-core: a licence verifies offline against the published key, and the grace period is stated; tt145-engines: BL-02 entitlement: a signed grant opens offline, tampering/rollback/expiry each refuse with their own verdict, and a stale refresh cannot shorten a grant |
| BL-03 | built | partial | tt107-features: a trial grants 14 days and cannot be taken twice; tt107-features: an expired trial degrades to read-only and still shows its history; tt107-features: an unknown client is untiered rather than defaulted to paid |
| BL-05 | built | full | integration: BL-01 licence: valid key verifies; one flipped character fails; wrong client is refused; tt110-core: there is no remote wipe and no kill switch anywhere in the server |
| DP-01 | built | full | e2e-tt56-rows: DP-01 account-free: no login / auth route answers, no auth library or sign-in call in the client bundle; e2e-tt56-rows: no uncaught page errors; tt142-browser: private mode refuses a host write and says why, instead of pretending to save |
| DP-02 | built | full | e2e-tt56-rows: DP-02 no ads, feeds or upsells: zero ad/promo/upsell components or strings in src/, zero ad-SDK markers in the client bundle |
| DP-03 | built | full | e2e-tt55-files: FM-09 / DP-03 origin badges: rows say where bytes live; offline, a new file shows as a 'queued' ghost row and becomes a real server row after replay; tt142-browser: the shell labels the desktop row it is showing, before it paints; tt142-platform: DP-03 · no name means the shared desktop, so every screen shows one desktop (+5) |
| DP-04 | built | full | integration: FM-03 journaled move: 6 states in order, digest preserved, source retired; tt111-core: every write is journalled and nothing is silently mutated: a read leaves no trace, a write leaves an auditable one; tt142-browser: two tabs share one desktop through the server, and a stale revision cannot overwrite a newer one (+2) |
| DP-05 | built | full | integration: FM-18 overwrite snapshots the previous version; integration: CRITICAL regression: purging /a_b must not touch /aXb (LIKE wildcard); tt111-core: reversible by default: a trashed file comes back, and a changed setting can be put back from its own history |
| DP-06 | built | partial | e2e-tt108-shell: every control of a window is reachable by keyboard alone, with no focus trap |
| DP-08 | built | partial | e2e: mount: spec; e2e: Spec module renders the full register; integration: register has no audited row still over-claimed |
| DP-09 | built | partial | unit: SVG sanitiser strips script/handlers/foreignObject/javascript: |
| DP-10 | built | full | e2e: mount: spec; e2e: Beam lists every transport and names the missing primitive on blocked ones; integration: health + bootstrap reconcile the register (+2) |
| DP-11 | built | full | e2e-tt58-rows: DP-11 least privilege: desktop + every registered app opened — no prompting permission API is called and every permission stays 'prompt'; e2e-tt58-rows: no uncaught page errors during the TT58 rows session |
| DP-12 | built | partial | e2e-tt108-shell: choosing a file opens the real platform picker rather than an in-page imitation |
| DP-13 | built | full | e2e-tt70-rows: DP-13 density tokens: compact < balanced < touch (title bar, --fs-target), no control under 24 px, and every density offers the SAME controls by accessible name |
| DP-14 | built | full | e2e: mount: monitor; integration: FM-03 journaled move: 6 states in order, digest preserved, source retired; tt110-core: every file operation leaves an observable journal entry with its final state (+5) |
| DP-15 | built | full | tt139-engines: DP-15 · plural categories follow the CLDR rules for every family; tt139-engines: DP-15 · message formatting handles plural, select, number, date and a missing argument; tt80-banner: writer: one banner, own menu names, menus mirror the strip (+10) |

## Definitions

- **Fully built** = register status `built`: runs end to end in this build against real browser/DB APIs.
- **Partially built** = `partial` (a named sub-capability is degraded) or `probe` (runs only where the browser exposes the API).
- **Fully tested** = at least one recorded passing test was tagged `full`, and the register does not mark the feature partial/probe/skeleton. Tags and statuses are authored claims, not independent proof of complete coverage. For blocked rows a full tag tests the disclosed limitation, not the impossible feature.
- **Partially tested** = passing tests exercise only part of the row, or the register explicitly marks the row partial/probe/skeleton even if some tests have full tags.
- Mount-only smoke tests tag a module's rows `partial`: rendering without an uncaught error is evidence of integration, not of function.
