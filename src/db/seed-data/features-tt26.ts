import { F, type SpecRow } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test" | "status">>;

/**
 * TT26 register changes (user request: dock buttons at a visually appealing size instead of slot-maxing, desktop
 * icon rearrangement, a 3D "Tabletop" desktop with piles and micro peeks, and a beauty-standard checker).
 */
export const tt26Features: SpecRow[] = [
  F("LY-05", "LY", "Aesthetic dock sizing: the Art dock picks a pleasing resting icon size (44–64 px on the 4-px grid from the screen size, or Small/Medium/Large) and fits the content to it by folding whole app groups into macOS-style stacks (grid popover, arrow keys, Esc) instead of shrinking icons to fit every slot; running and pinned apps of a folded group stay visible",
    "A", "P2", "src/lib/layout-core.ts idealDockIcon / planDock / DOCK_* constants; src/components/Dock.tsx DockStack; settings appearance.dockSize",
    "Replaces TT25's fit-everything sizing (≈30 px icons on a 1440 screen). Every app stays one click from the dock (direct or via its stack). Only when every group is folded and the dock still does not fit does the size step down to 32 px, then the dock scrolls inside itself. Band grounded on Apple HIG 44 pt / Material 48 dp targets; the 5.5 % of screen height heuristic is our own choice.",
    "built", "tabletop-unit.mts 'idealDockIcon', 'planDock', 'planDock on a phone'; e2e-layout.mts 'Art dock: aesthetic size + stacks'; e2e-beauty.mts '<viewport>: Fusion, launcher, …' (dock-band, dock rhythm/equilibrium)"),
  F("LY-06", "LY", "Rearrangeable desktop icons: drag to any grid cell (snaps, swaps with an occupied cell), Alt+Arrow keys move the focused icon, Enter opens it, desktop menu 'Clean up icons' / 'Sort icons by name'; positions persist as grid cells in the desktop state",
    "A", "P2", "src/lib/desk-icons-core.ts layoutIcons / moveIcon / nudgeIcon / cleanUp / sortByName; DesktopSurface.tsx; DesktopState.icons",
    "Cells, not pixels, so positions survive text-size and window changes. Icons stay VFS paths (SH-04): a trashed file's saved position is dropped. Keyboard moving is the WCAG 2.5.7 alternative to dragging. Desktop double-click now uses the same open-with routing as Files (src/lib/open-with.ts).",
    "built", "tabletop-unit.mts 'desktop icons: column-major …', 'desktop icons: drag moves …'; e2e-tabletop.mts 'desktop icons (classic)'"),
  F("LY-07", "LY", "Tabletop 3D desktop: replaces the desktop with an open box seen from above — the floor holds file cards, the four walls hold Windows, Apps, Widgets and Recent; double-click a wall (or the switcher / Enter) and it unfolds on its hinge into the main view, double-click its background / Esc / Back folds it away; toggle in Settings, Quick panel, desktop menu, Routines (view tabletop)",
    "A", "P2", "src/components/Tabletop.tsx; src/lib/tabletop-core.ts boxGeometry / faceTransform / awayTransform; setting appearance.desktopView; Shell.tsx",
    "Pure CSS 3D (perspective + preserve-3d), no WebGL. The floor counter-scales its content by the projection factor so text on it renders at its true size. All motion is transform/size transitions timed from --fs-motion: instant under Motion off or prefers-reduced-motion. Windows keep floating above the box. Not reproduced: free camera orbit, physics.",
    "built", "tabletop-unit.mts 'tabletop box geometry', 'open-with routing …'; e2e-tabletop.mts 'toggle', 'box geometry', 'a wall becomes the main view', 'walls work', 'reduced motion', 'axe-core'; e2e-beauty.mts Tabletop floor + 4 walls"),
  F("LY-08", "LY", "Tabletop piles: drop a card (or a pile) on a card or pile to stack them (deterministic messy-stack jitter, count badge), click a pile to fan it out on an arc, drag a card out of the fan to take it out, Unstack / Rename / Add to pile from the context menu or Shift+F10 (keyboard alternative); floor positions and piles persist and are validated against the files that exist",
    "A", "P2", "src/lib/tabletop-core.ts normalizeTable / floorItems / hitItem / pileUp / takeFromPile / unstack / pileJitter / fanLayout; DesktopState.table",
    "Pile membership is by VFS path; a pile left with one card dissolves; missing files drop out on the next load (no ghosts). Cards keep their DOM identity across pile/fan changes so moves animate.",
    "built", "tabletop-unit.mts 'tabletop state', 'tabletop piles', 'tabletop geometry'; e2e-tabletop.mts 'drag a card onto a card makes a pile', 'keyboard pile'"),
  F("LY-09", "LY", "Micro peek: every Tabletop card shows its file's real contents in miniature (Markdown with headings/bullets, plain text and code, CSV/TSV and JSON row grids, raster images and SVG as images, an extension badge otherwise); hover or focus enlarges it",
    "A", "P2", "src/lib/micro-peek-core.ts microPeek / parseDelimited; Tabletop.tsx MicroPeek",
    "Reads at most the first 4096 characters (images: the stored data); files over 2 MB get a badge. SVG is shown through <img>, which never runs script or loads external references. Peeks are aria-hidden decoration: the card is named by its visible file name, its title says what kind of preview it is, and a shared description explains Enter / drag / Shift+F10.",
    "built", "tabletop-unit.mts 'micro peek'; e2e-tabletop.mts 'micro peek shows the real contents'"),
  F("LY-10", "LY", "Beauty standard checker: scripts/e2e-beauty.mts measures every main view (Fusion, Business, Art, Start menu, Launchpad, a dock stack, desktop icons, the Tabletop floor and each wall as the main view) at several screen sizes and checks hard rules (WCAG 2.5.8 target size with its spacing exception, chrome targets ≥32 px, no overlapping targets, no clipped text, chrome on-screen, square icons, dock band, row rhythm, equilibrium, paragraph line-height, golden cards) and reports soft ones (pleasing proportions φ/5:3/3:2/√2, type-scale economy, Ngo balance)",
    "A", "P2", "src/lib/beauty-core.ts; scripts/e2e-beauty.mts; docs/BEAUTY-REPORT.md; docs/DESIGN-TABLETOP-TT26.md",
    "Golden-ratio evidence is mixed, so φ is a soft, reported band — never a pass/fail rule — except for our own golden cards, whose drift would be a regression. Hard rules come from WCAG 2.2 and Ngo/Teo/Byrne's layout measures made binary. It measures geometry; it is not a substitute for people judging beauty.",
    "built", "tabletop-unit.mts 'beauty rules: each hard rule catches a seeded violation'; e2e-beauty.mts 'the pipeline catches seeded violations', '<viewport>: …' ×4"),
];

export const UPDATES_TT26: Record<string, Patch> = {};
