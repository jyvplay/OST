import type { SpecRow } from "./row";

/** TT97 records partial palette actions and numeric/accessibility repairs without claiming full parity. */
export function patchTT97(row: SpecRow): SpecRow {
  if (row.code === "SR-06") return {
    ...row,
    status: "partial",
    route: "Command palette actions scope + shared calculator + Notes + Settings + routine executor",
    nuance: "The palette calculates and converts through the shared Number evaluator. Its explicit Actions scope creates a host Note only on selection, toggles focus, opens a filtered Settings graph, and lists/runs enabled saved routines after rechecking them. Command text typed in Actions is not sent to the search endpoint; normal search uses the app backend. Host Notes and saved routines are unavailable in amnesic sessions; note POST failures are reported as an uncertain outcome and are not automatically queued. Routine actions are not an atomic transaction and the enabled recheck does not prevent a later concurrent change. Native Google Cast is not implemented by these actions. Full feature, engine and device coverage is not established.",
    test: "tt97-palette-commands.mts checks explicit bounded grammar; e2e-tt97-palette-actions.mts exercises real browser/DB note creation and search isolation, amnesia, offline, a deliberately lost response after a real commit, focus/settings, enabled and stale-disabled routines, repeated activation, and composition-flagged DOM events. This is not physical IME or native Cast verification.",
  };
  if (row.code === "PR-09") return {
    ...row,
    nuance: `${row.nuance} Unit conversion avoids unnecessary intermediate overflow and rejects non-finite results; results are still binary64 with rounding and underflow.`,
    test: `${row.test} tt96-scientific-units.mts checks numeric boundaries against 1,300 independent Decimal references; e2e-tt97-calculator-repairs.mts checks empty/populated history, ARIA detection and scientific/palette agreement.`,
  };
  if (row.code === "FM-09") return {
    ...row,
    test: `${row.test}; e2e-tt97-files-empty-a11y.mts opens an empty folder, requires the scroll region to be keyboard reachable and axe-clean, then injects the pre-repair non-tabbable element and requires detection. Only an empty local folder and one Chromium were exercised.`,
  };
  if (row.code === "AX-08") return {
    ...row,
    test: `${row.test}; e2e-tt97-calculator-repairs.mts detects the prior empty-history ARIA error and a deliberately reintroduced low-contrast transition; tt97-svg-attributes.mts statically rejects CSS calc()/var() in SVG geometry attributes, a class of defect that produced console errors on every banner render (verified to fail on the pre-repair source).`,
  };
  return row;
}
