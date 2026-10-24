import type { SpecRow } from "./row";

/**
 * TT51 register changes — Slides becomes a lossless editor of real PowerPoint files. Evidence: scripts/tt51-slides.mts
 * (python-pptx reader oracle scripts/oracle/pptx_probe.py + package validator scripts/oracle/pptx_validate.py over the 83
 * openable decks of the 95-file Apache POI / python-pptx corpus), scripts/tt51-mutants.py (every mutant killed) and
 * scripts/e2e-tt51-slides.mts (real UI, Chromium 143, saved files re-read by python-pptx).
 */
const SLIDES = "TT51: Slides edits REAL PowerPoint files losslessly (src/lib/office/pml.ts works on the package itself, not on a "
  + "reduced model). Reading agrees with python-pptx on 83 corpus decks / 551 slides / 1,983 shapes (order, hidden flags, layouts, notes, ids, names, "
  + "geometry with placeholder inheritance, paragraph text, tables, groups) with 0 mismatches; opening and saving without edits gives back the original "
  + "bytes on 83/83, and every edit touches only the parts it must (untouched parts keep their bytes). Editing: text by double-click with run "
  + "formatting kept (typed text joins the run it lands in), bold/italic/underline/size/colour on a selection, alignment, bullets/numbering, levels; "
  + "slides: new from any layout, duplicate (charts deep-copied with their workbooks), move, hide, delete (notes, links, custom-show and section "
  + "entries cleaned up); shapes: text boxes, preset shapes, pictures, move/resize by drag or keys, fill, outline, z-order, delete with media "
  + "garbage collection; speaker notes (a notes master is created when the deck has none); exact undo/redo; password-protected decks open and save "
  + "(Agile encryption, checked with msoffcrypto-tool); full-window slide show that skips hidden slides. Drawn from the file: theme colours "
  + "(lumMod/lumOff/tint/shade…), master/layout/slide backgrounds (solid, gradient, picture), 180+ preset geometries plus custom geometry, pictures "
  + "with crop, tables with merged cells and table styles, charts from their cached values, group transforms. Hostile files are rejected with a clear "
  + "error (size, part count, zip bombs, billion laughs, path climbing). Limits: text is edited in an overlay, not inline WYSIWYG; animations, "
  + "transitions and media are kept but not played; EMF/WMF pictures show a placeholder; group rotation is not applied to children; vertical text is "
  + "approximated; SmartArt is drawn from its cached drawing only; PowerPoint/LibreOffice are not available here for an open check (PR-11).";

export function patchTT51(f: SpecRow): SpecRow {
  if (f.code === "FF-23") {
    return {
      ...f,
      status: "built",
      route: "src/lib/office/pml.ts (lossless PresentationML engine) + pmlview.ts/pmlgeom.ts (renderer) + Slides module; legacy .fdeck opens as .pptx",
      nuance: SLIDES,
      test: `${f.test ? f.test + "; " : ""}tt51-slides.mts; tt51-mutants.py; e2e-tt51-slides.mts`,
    };
  }
  return f;
}
