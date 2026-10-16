import { F, type SpecRow } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "route" | "nuance" | "test">>;

/**
 * TT23 register additions — USER-DIRECTED EXTENSION ROWS. The user asked for five more major, distinct design
 * themes/palettes, chosen by honest, web-grounded popularity among internet users (see docs/DESIGN-THEMES-TT23.md for
 * the evidence and its limits), and for more modules after the UI/UX work.
 */
export const tt23Features: SpecRow[] = [
  F("AX-12", "AX", "Five reach-backed design languages as selectable styles: Liquid Glass (after Apple iOS 26), Material Expressive (after Google Material 3 Expressive), Fluent (after Microsoft Fluent/Windows 11), Cloud Dancer (Pantone 2026) and Transformative Teal (WGSN × Coloro 2026)",
    "A", "P2", "src/lib/style-core.ts (5 palettes × 13 roles, logos, chrome, dark+light tokens) + AppIcon.tsx (5 new tile finishes: glass, tonal on a 12-lobe cookie shape, mica, paper, lacquer) + public/wallpapers/{glass,material,fluent,clouddancer,teal}.svg",
    "Original interpretations in this project's own vector art. No Apple, Google or Microsoft icons, wallpapers or fonts are copied, and the app stays on Nunito. Popularity is measured by platform reach (share of devices running each design language) and by the two 2026 colour authorities. No survey ranks 'design themes' by popularity across all internet users, and the docs say so. Every glyph/tile pair, every chrome pair and both text themes are checked numerically. Translucent panels are also checked composited over pure black and pure white. axe runs on all 9 styles × light/dark.",
    "built", "a11y-unit.mts 'style system'; e2e-a11y.mts 'style switch', 'light + dark theme, all 9 styles'"),
  // ---- Whiteboard module (TT23: "add more modules after the UI/UX work") — an Excalidraw / Miro-class canvas ----
  F("WB-01", "WB", "Whiteboard canvas: rectangles, ellipses, diamonds, sticky notes, text and freehand pen (RDP-simplified) on an infinite pan/zoom canvas with optional 10-unit snap",
    "A", "P2", "src/lib/whiteboard-core.ts (addEl, hitTest on true outlines, marquee, simplify, resize, snap) + src/components/modules/Whiteboard.tsx (pointer tools, wheel / Ctrl+wheel, Fit, 20–400 % zoom)",
    "Shapes dragged up-left are normalised. Hit testing uses the real ellipse/diamond outline, not the bounding box. A 5000-element cap is enforced on add and duplicate. No rotation, no images or embeds, no auto-wrapped text (explicit line breaks only).",
    "built", "whiteboard-engine.mts 'hit testing', 'pen strokes', 'limits'; e2e-whiteboard.mts 'draw shapes'"),
  F("WB-02", "WB", "Whiteboard connectors: lines and arrows whose ends bind to shapes and stay attached (re-resolved to the shape outline on every render) when shapes move; ends can be dragged to re-bind or detach",
    "A", "P2", "whiteboard-core boundaryPoint / resolveConnector / move / remove / duplicate (bindings frozen or remapped); Whiteboard.tsx end handles",
    "Straight connectors only (no elbow or curved routing). Deleting a shape keeps its connectors, detached at their last resolved point. Duplicating keeps a binding only between copied elements.",
    "built", "whiteboard-engine.mts 'boundary points', 'bound connectors', 'delete and duplicate'; e2e-whiteboard.mts 'connector follows'"),
  F("WB-03", "WB", "Whiteboard arranging: multi-select (shift-click, marquee), move, resize, duplicate, delete, z-order (front/back/forward/backward), group/ungroup, align ×6 and distribute",
    "A", "P2", "whiteboard-core move / reorder / group / align / distribute; Whiteboard.tsx Arrange panel + shortcuts (Ctrl+D, Ctrl+G, [ ], arrows nudge)",
    "Groups are one level deep (no nested groups). Distribute needs at least 3 elements, and the outer two stay fixed.",
    "built", "whiteboard-engine.mts 'align, distribute, z-order and groups'; e2e-whiteboard.mts 'arrange'"),
  F("WB-04", "WB", "Whiteboard files: native .fboard save/open from Files (strict loader that repairs dangling bindings, bad colours and duplicate ids and reports the count) and standalone SVG export",
    "A", "P2", "whiteboard-core parseBoard / serialize / toSvg; Whiteboard.tsx Save .fboard / Export SVG; Files opens *.fboard; fileIconSpec",
    "SVG text is escaped and colours are whitelisted, so exported SVG carries no script, handlers or foreign content. No PNG or PDF export. No Excalidraw/Miro file import.",
    "built", "whiteboard-engine.mts 'SVG export…'; e2e-whiteboard.mts 'save, reopen, export'"),
  F("WB-05", "WB", "Whiteboard editing UX and access: double-click or Enter to edit text, exact undo/redo (100), tool shortcuts, a Layers list that reaches every element by keyboard with plain-language names, arrow-key nudging",
    "A", "P2", "Whiteboard.tsx (role=application canvas with a live description, Layers list buttons via describe(), text overlay)",
    "Drawing new shapes needs a pointer. Keyboard users can select, move, restyle, re-text, duplicate, arrange and delete existing elements. Not screen-reader tested.",
    "built", "whiteboard-engine.mts 'describe'; e2e-whiteboard.mts 'keyboard', 'axe'"),
];

export const UPDATES_TT23: Record<string, Patch> = {
  "AX-11": {
    name: "Selectable visual style: Poolside (default, pastel), Vice (neon), Ocean Drive (art-deco), Bubbly (TT21) and the five TT23 styles (AX-12) — each recolours every icon tile, the logo, wallpaper ('auto'), accent ('auto'), surfaces and chrome",
  },
};
