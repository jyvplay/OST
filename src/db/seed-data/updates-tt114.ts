/**
 * TT114 — nine rows that shipped as "built" with no test behind them now name the suite that
 * measures them, and the nuance is rewritten to say what was measured rather than what was
 * intended. Nothing is promoted here that a run did not produce a number for: where a row's
 * promise is wider than this turn's evidence (CT-04's real casting, WM-03's whole workspace
 * model), the nuance says so in the row itself instead of quietly implying coverage.
 */
export const UPDATES_TT114: Record<string, {nuance?: string; status?: string; test?: string}> = {
  'LN-09': {
    nuance: 'Procedural, parallax and user-image backgrounds, drawn on a canvas behind the desktop. Deterministic by construction: a scene is a pure function of its seed, so the same desktop redraws identically and a test can assert the drawing without a screenshot. Measured in TT114: four scene kinds reproduce exactly per seed; 2000 draws spread across the canvas with a worst decile of 190; the parallax excursion over 514 sampled seconds peaked at 0.0700, exactly the declared drift plus the 0.04 cap; the layer paints 6648 of 13473 sampled pixels of a 1480x883 canvas and is pointer-transparent, while scene "off" paints nothing; 10 frames are drawn in 900 ms and exactly 0 once effects are switched off. A hidden tab is never overridden by any other condition. User images are validated before use: four shapes accepted, nine refused.',
    test: 'tt114-core.mts + e2e-tt114-shell.mts',
  },
  'WM-12': {
    nuance: 'Per-window density and zoom, overriding the global setting for one window only. Density re-resolves the spacing tokens inside the window body; zoom scales the content and not the frame. Measured in TT114: compact resolves to calc(12px + 12*...) against touch\'s calc(24px + 24*...); a window at zoom 1.5 keeps a 560px frame, so the zoom is content-only; a per-window touch override at 1.1 leaves its neighbours untouched and survives a reload. The override is stored on the window, so it travels with the window through workspace moves.',
    test: 'e2e-tt114-shell.mts + tt114-core.mts',
  },
  'WM-04': {
    nuance: 'Overview: every window as a live card, filterable by name. Measured in TT114: four windows render in 447 ms, the filter narrows 4 -> 2 -> 0, and an empty result says "No window matches" rather than showing a blank grid. The cards are the real windows, keyed by window id, so clicking one focuses that window rather than a copy of it.',
    test: 'e2e-tt114-shell.mts',
  },
  'WM-03': {
    nuance: 'Named workspaces with per-window assignment. TT114 adds the half that was never asserted: moving a window to another workspace persists across a reload (Notes moved Desk -> Reading and came back there), alongside the existing evidence that a playing video survives two workspace switches.',
    test: 'e2e-tt114-shell.mts',
  },
  'MD-07': {
    nuance: 'Screen colour picker. Honest about the platform: the EyeDropper API is a capability probe, and where it is missing the control is replaced by a native colour input rather than a dead button. Measured in TT114: this Chromium reports EyeDropper present, the fallback input is live and adds a picked colour to the palette (0 -> 1 swatches). The fallback branch is exercised through the input; the no-EyeDropper branch cannot be proven on a runtime that has EyeDropper, and that gap is declared rather than hidden.',
    test: 'e2e-tt114-shell.mts',
  },
  'CT-04': {
    nuance: 'Present view: a second surface at /present?room= that follows a real Together room. Measured in TT114: a room created over the API and driven play -> pause is followed by the present view, which identifies itself with a stable client id. Scope stated honestly: this is a local second surface over the existing Together room, not Chromecast/AirPlay device casting, and no claim of device discovery is made.',
    test: 'e2e-tt114-shell.mts',
  },
  'PR-07d': {
    nuance: 'Horizontal split: two live proxy frames side by side in one browser window. Geometry is measured rather than counted, because two frames stacked in a column would also be "two frames": TT114 asserts 649x552 panes at x=21 and x=670, equal widths, same top edge. TT114 also made the control a glyph with the accessible name "Split view: off | side by side | stacked".',
    test: 'e2e-tt114-tabs.mts',
  },
  'PR-07e': {
    nuance: 'Vertical split: the same two frames stacked instead. Measured in TT114 as 1298x276 at y=315 above 1298x276 at y=591, with the control cycling h -> v -> off and the third click restoring a single pane.',
    test: 'e2e-tt114-tabs.mts',
  },
  'PR-07j': {
    nuance: 'Tearing a tab out into its own browser window. Measured in TT114: the torn page (http://127.0.0.1:4002/) opens in a new window whose address bar shows that URL, and the source window keeps its remaining two tabs rather than losing them. The write is debounced, so the test polls the persisted state instead of sleeping.',
    test: 'e2e-tt114-tabs.mts',
  },
  'PR-07r': {
    nuance: "AUDIT: v3.0 kept tabs in component state, so 'sessions' would have restored windows but lost tabs. Fixed by moving tab state into the reducer-owned window props (debounced 500 ms). TT114 measured the restore end to end, across a real reload: three tabs, which one is in front, a tab group, a pin and the horizontal split all survived, and the split came back as two panes rather than as a remembered flag with one frame.",
    test: 'e2e-tt114-tabs.mts',
  },
  'RC-01': {
    nuance: 'Human-selected resident media: a browser-resident file, a pasted image or a dropped file, saved without requesting the media URL again. TT113 compacted the pane around it; TT114 makes the save exactly-once across a lost answer (RC-39) — the client mints a commit token per attempt, so a retry after a dropped connection is answered by the first commit instead of writing a second memory.',
    test: 'e2e-tt100-recall.mts + e2e-tt112-resident.mts + tt114-recall-token.mts',
  },
  'RC-13': {
    nuance: 'Atomic publication: a memory and its receipt appear together or not at all, and a refused save leaves nothing behind. TT114 extends the guarantee past the end of the request: with a client-minted token the server claims the attempt as the first statement of the transaction, so eight concurrent arrivals of one token produce one write, seven replays and one file, and a token replayed with different bytes is refused 409 with nothing written. Still out of scope, and still stated: crash durability beyond PostgreSQL\'s own fsync settings, and any guarantee if the database itself is lost.',
    test: 'e2e-tt106-memory.mts + tt114-recall-token.mts',
  },
  'AX-16': {
    nuance: 'A module opens with no more than 120 words of prose that is not a control, heading, badge or list row; every limit it used to print is still present verbatim inside a keyboard-operable <details>. Re-measured in TT114 after the glyph pass: Recall opens at 75 visible prose words with 11 disclosures holding 463 words, Browser at 11 words. The count rose from 55 because TT113\'s repair restored two sentences that must stay visible — the consequence attached to Cancel, and the live "Bytes received" measurement — which is the boundary this contract is meant to respect. AX-17 covers the other half: control labels.',
    test: 'e2e-tt113-density.mts + e2e-tt114-density.mts',
  },
  'AX-01': {
    nuance: 'Keyboard and screen-reader access to every control. TT114 adds a standing guard where compaction is most likely to break it: when a label is shortened to a glyph, the former phrase must remain the accessible name. All fifteen Recall memory actions are asserted to resolve by their exact former names after the glyph pass, so the visual change costs no keyboard or screen-reader user anything.',
    test: 'e2e-tt114-density.mts',
  },
};
