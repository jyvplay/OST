import { F, type SpecRow, type Status } from "./row";

/**
 * TT16 register additions: image editing (layered raster + PSD) and vector v2.
 * Every claim names the evidence that verifies it; gaps are listed in the nuance.
 */
export const tt16Features: SpecRow[] = [
  F("FF-30", "FF", "Layered raster image editor: layers (12 separable W3C blend modes, opacity, masks, offsets, visibility), brush/eraser/bucket/gradient/eyedropper, rect/ellipse/magic-wand selections, merge/flatten/crop/rotate/resize, undo history",
    "A", "P2", "src/lib/image/{doc,paint,history,raster}.ts (pure) + ImageStudio.tsx; classic quick edit kept as a tab",
    "Compositor verified against TWO independent implementations: Chromium/Skia globalCompositeOperation (exact-input oracle: |Δ| 0 for 9 modes, 1 for color-dodge/burn/soft-light on opaque backdrops; ≤2 on translucent, inside the premultiplied-storage bound) and psd-tools' compositor (Δmax 1 over 12 modes with masks/hidden/offset layers). Visual inspection found and fixed two UI bugs (clipped tool-rail labels; ellipse selection drawn as a rectangle). Gaps: no non-separable blends (hue/saturation/color/luminosity), no adjustment/smart/type layers or effects, no group blending/clipping; wand and combined selections outline their bounds.",
    "built", "image-engine.mts (12), e2e-image.mts (10, Skia oracle), oracle-psd.mts"),
  F("FF-31", "FF", "PSD codec: read/write 8-bit RGB(A)/Grayscale PSD with layers, names (luni + MacRoman Pascal), blend keys, opacity, visibility, masks, RLE/ZIP/raw channels, merged composite",
    "A", "P2", "src/lib/image/psd.ts; /api/forge decodes PSD server-side (grade B layer list) with header-only fallback (grade E)",
    "Interop proven in both directions with psd-tools 1.25 (Python): it reads our files byte-exact per layer (raw/RLE/ZIP) and our merged image with Δ0; we read files it writes byte-exact. Found and fixed: Pascal layer names are MacRoman, not Latin-1. Gaps (all warned in the UI): PSB, 16/32-bit, CMYK/Lab/Indexed, adjustment/smart/type layers, layer effects, vector masks, group folders. No Photoshop available to verify.",
    "built", "oracle-psd.mts (8), image-engine.mts PSD tests, integration.mts layers.psd grade B"),
  F("FF-32", "FF", "Vector studio v2: full SVG path grammar, exact geometry engine (bounds, length, fill rules, hit test), pen + node editing, shape tools, move/resize/rotate/flip, align/distribute, z-order, group/ungroup, gradients, layers; sanitising SVG import, SVG/PNG export, .fsvg v2 with v1 migration",
    "A", "P2", "src/lib/vector/{xml,path,model}.ts (pure) + Vector.tsx; canvas renders our own export serialisation; hit-testing by the engine",
    "Geometry verified against TWO independent SVG implementations: svgelements (24 tricky paths incl. compact arc flags, '1.5.5', S/T chains, radius scaling: L/C/Q bounds exact to 1e-17, arcs ≤1.6e-4 relative; 13 transform lists identical) and Chromium (getBBox/getTotalLength ≤1.5e-4; 8,538 isPointInFill samples agree; transform.baseVal identical). Chromium arbitrated a svgelements deviation (rx=0 arc length 0 vs the spec's straight line — we follow the spec). Render parity: original vs import→export rasterised by Chromium differ on 0.10% of pixels, all along arcs, each by one Skia supersample coverage step (arcs become cubics: ≤2.7e-4·r). Hostile SVG (script, on*, foreignObject, javascript:, external use/image, CSS) is reported and never reaches the DOM (e2e-verified). Gaps: no boolean path operations, no text-to-outline (no glyph data), text bounds estimated (0.6 em advance), no markers/patterns/filters/masks/clipPaths, nested <svg> viewport clipping not reproduced.",
    "built", "vector-engine.mts (17), oracle-svg.mts (4), e2e-vector.mts (10)"),
];

type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };
export const UPDATES_TT16: Record<string, Patch> = {
  // TT16 audit: these rows were marked built while Browser.tsx had no UI for them. Now implemented via
  // src/lib/browserSession.ts (pareto-superior parts of the competitor's browserState.ts) and verified.
  "PR-07b": { status: "built", route: "Vertical sidebar renderer of the same tab model: group headers (rename/collapse/ungroup), tab search", test: "e2e-browser.mts batch/groups/search test" },
  "PR-07c": { status: "built", route: "browserSession.ts groups: named, coloured, collapsible (collapsed tabs hidden unless active); ungroup never closes", test: "browser-session.mts; e2e-browser.mts" },
  "PR-07f": { status: "built", route: "Pin/Unpin (button, Alt+P): pinned tabs sort left, compact, never batch-closed or slept", test: "browser-session.mts; e2e-browser.mts shortcuts test" },
  "PR-07i": { status: "built", route: "Alt+T new, Alt+W close, Alt+P pin, Alt+1..8/9 switch — when focus is in the Browser window",
    nuance: "Ctrl+T/W/N/Tab are reserved by the host browser and cannot be captured by a page (Keyboard Lock only applies in fullscreen); shortcuts do not fire while focus is inside a cross-origin frame (the frame receives the keys)." , test: "e2e-browser.mts shortcuts test" },
  "PR-07l": { status: "built", route: "Site permissions panel → per-host iframe allow= delegation (camera, microphone, geolocation, fullscreen, clipboard-write, autoplay, payment, display-capture); default explicit 'none'",
    nuance: "Delegation only: allow= can pass a feature this shell already holds to an embedded origin or deny it, never grant what the top-level document lacks; the browser still prompts the user. Persisted in the session.", test: "browser-session.mts; e2e-browser.mts permissions test" },
  "PR-07q": { status: "built", route: "Close others / to the right / duplicates (pinned tabs kept), Sleep other tabs", test: "browser-session.mts; e2e-browser.mts" },
  "PR-07": { status: "built", route: "Browser host container over src/lib/browserSession.ts: URL guard (http(s) only, no userinfo, never the shell origin), untrusted-session normalisation, embeddability probe + 3 fallbacks",
    nuance: "TT16 security fix: typed/restored URLs were not validated — a crafted session could load shell-origin content into a frame with allow-scripts + allow-same-origin, which can remove its own sandbox. Now refused and reported (e2e-browser hostile-session test). Also fixed: closing the active tab left a blank view.", test: "e2e-browser.mts; browser-session.mts" },
  "FF-24": { status: "built", route: "Image Editor: Layers tab (Image Studio, FF-30/31) + Quick edit tab (crop/rotate/flip/adjust, recipe sidecar)",
    nuance: "TT16: the single-layer quick editor is kept unchanged as a tab; the layered editor (FF-30) and PSD codec (FF-31) cover layers/selections/blend modes. Original files are never overwritten; outputs over the 8 MB VFS cap are downloaded instead.",
    test: "e2e-image.mts; image-engine.mts" },
  "FF-25": { status: "built", route: "Vector studio v2 (FF-32): shapes, paths, text, groups, gradients; sanitising import; SVG/PNG export",
    nuance: "TT16: superseded by FF-32 — paths, polygons, gradients, groups and <use> are now imported and editable instead of dropped; v1 .fsvg files migrate on open.",
    test: "e2e-vector.mts; vector-engine.mts" },
  "FF-04": { status: "partial", route: "Vector studio (FF-32) for SVG; .ai not handled",
    nuance: "TT16: SVG render + edit is fully built (FF-32, Chromium-verified, hostile-SVG e2e test). Downgraded from built to partial (TT16 audit): the row also promises .ai detection, and no .ai detection or renderer exists in this build (grep of src/lib/forge.ts finds none).",
    test: "e2e-vector.mts hostile SVG test" },
};
