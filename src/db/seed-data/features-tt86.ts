import type { SpecRow } from "./row";

/** TT86 closes the bounded, browser-native SH-06 contract with model, real-input, and mutation evidence. */
export function patchTT86(row: SpecRow): SpecRow {
  if (row.code !== "SH-06") return row;
  return {
    ...row,
    tier: "A",
    phase: "P2",
    status: "built",
    route: "src/lib/pointer-triggers.ts (corner entry, edge flick and gesture state machines); src/components/Shell.tsx (pointerrawupdate/pointermove rAF sampler, action routing, context-menu ordering); DesktopSurface / Tabletop gesture-surface markers",
    nuance: "TT86 Class A within the web viewport contract: four 6×42 CSS-px corners (TL Launcher, TR Overview, BL Quick panel, BR Command palette); four 4 px edge rails excluding the 42 px corner bands, each requiring an 18 px inward flick within 600 ms; right-button directional gestures on blank desktop/tabletop surfaces (≥36 px and ≥1.25× axis dominance). Corners are entry-only, ignore the first position sample and zero-motion updates, and re-arm after leaving. A single ephemeral listener uses pointerrawupdate where available, pointermove otherwise, and processes queued samples once per animation frame. The shell.hotCorners preference gates corners, edges, and gestures; ordinary right-click still opens the classic desktop menu and controls/windows are not gesture targets. Coordinates are CSS pixels in the browser/PWA viewport only: no physical-display edges, OS-global pointer capture, touchpad pinch, or native system gestures are claimed. No pointer data is sent or persisted.",
    test: "tt67-input.mts (legacy one-corner entry/re-arm boundaries); e2e-tt67-input.mts (existing real-pointer launcher and preference regression); tt86-pointer.mts (all four corner/edge models, exact boundaries, timing, gesture thresholds and negative cases); e2e-tt86-pointer.mts (real Chromium/CDP: all 4 corners + 4 edges + 4 gestures, context-menu preservation, preference off, shell-control click, no page errors); tt86-pointer-mutants.py (11/11 seeded regressions killed)",
  };
}
