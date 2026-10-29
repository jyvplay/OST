/**
 * TT113 — nuance the rows the compaction actually touched. No status is promoted here that a test
 * does not now measure, and the two UI rows stay "partial" because this turn measured their text
 * density and keyboard behaviour, not the whole of what they promise.
 */
export const UPDATES_TT113: Record<string, {nuance?: string; status?: string; test?: string}> = {
  'RC-01': {
    nuance: 'Human-selected resident media: a browser-resident file, a pasted image or a dropped file, saved without requesting the media URL again. TT113: the pane around it was rewritten from prose to controls — the pathway, its 8 MiB ceiling and its "no background surveillance" statement are unchanged and now live in a keyboard-reachable disclosure (e2e-tt113-density.mts asserts all six saving controls survived and stay enabled).',
  },
  'WM-02': {
    nuance: 'Window chrome and in-window app chrome. TT112: the banner folds its overflow into a More menu in EVERY layout, not only Art — Fusion and Business used to scroll sideways, hiding roughly two thirds of Writer\u2019s tools (measured 3612px of tools in a 1307px window; now 936px in 936px). TT113: Recall and Browser chrome compacted the same way, measured at 55 and 11 visible prose words.',
    test: 'e2e-tt110-banner.mts',
  },
  'AX-05': {
    nuance: 'Readable, operable panes. TT113 adds a measured density contract (AX-16): prose that is not a control is bounded per module, the text it replaces stays verbatim in a <details> disclosure, and that disclosure is reachable and operable from the keyboard alone (focus lands on SUMMARY, Enter opens it, the body is announced). Hover-only tooltips would not satisfy this and are not used for the limits.',
    test: 'e2e-tt113-density.mts',
  },
  'SC-08': {
    nuance: 'Telemetry off by default; local logs; redacted export. TT113: the privacy statements a person must be able to read — "server copies are unencrypted in /Downloads/Recall", "there is no automatic sensitive-information filter", where the capture and media-tap switches live — are retained word for word in disclosures rather than deleted when Recall was compacted; e2e-tt113-density.mts fails if the disclosed volume drops.',
  },
  'RC-38': {
    nuance: 'Saving an object the page is holding itself. TT112 proved the pathway (origin down, bytes the origin never served, SHA-256 equality, named refusals). TT113 restated its pane as a tool: "1c \u00b7 Held by this page" with a byte-exact badge and the blob:/data: explanation in a disclosure; the Scan and Save controls are unchanged and re-verified by both e2e-tt112-resident.mts and e2e-tt113-density.mts.',
  },
};
