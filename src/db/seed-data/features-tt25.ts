import { F, type SpecRow } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test" | "status">>;

/**
 * TT25 register changes (user request: two professional office styles after the most common desktop systems, and a
 * Business / Art main-UI layout switch in both Settings and the Quick panel). New family LY = layouts & looks.
 */
export const tt25Features: SpecRow[] = [
  F("LY-01", "LY", "Business layout (after Windows): full-width bottom taskbar with Start menu (search, Pinned, All apps), search box, Task view, pinned + running apps with underline indicators, click-to-minimise / cycle, Shift/middle-click new window, right-click jump list, system tray, stacked clock → Planner, Show desktop; Windows caption buttons; Quick settings and toasts bottom-right",
    "A", "P2", "src/components/Taskbar.tsx, LayoutLaunchers.tsx StartMenu, WindowFrame.tsx .fs-caption; layout-core taskbarAction; windowing/state.ts showDesktop (+ peek)",
    "No top bar in this layout; every top-bar function moved to the taskbar (badges, governor dot, Blackout, Quick settings, desktops). Show desktop remembers exactly the windows it hid and forgets them when you open or focus a window (as Windows does). No live window thumbnails on hover (the title list is in the tooltip and the jump list). Not screen-reader tested.",
    "built", "layout-unit.mts 'taskbar click', 'Show desktop' ×2; e2e-layout.mts 'Business taskbar', 'Business: Start menu…', 'axe-core'"),
  F("LY-02", "LY", "Art layout (after macOS): menu bar (Fusion menu, focused app name, File / Window / Help menus acting on the focused window, Spaces, Mission Control, Spotlight, Control Centre, day-date clock) and a centred floating dock with EVERY app grouped by separators, cosine hover magnification, name bubble, running dots, launch bounce, minimised windows after a separator, Trash, right-click menu (window list, New window, Show all, Quit), Launchpad; traffic-light window controls on the left (grey when inactive) with a centred title",
    "A", "P2", "src/components/MenuBar.tsx, Dock.tsx, LayoutLaunchers.tsx Launchpad, chrome-bits.tsx MenuButton (APG menu button); layout-core dockScales / fitIconSize / dockWidth",
    "Magnification is computed from the resting geometry, measured from the dock's fixed centre, so the icon under the pointer stays under it while the dock widens (checked by measured boxes). Keyboard focus magnifies too; touch never does; reduced motion / Motion off remove the bounce and transitions; a switch turns magnification off. When even 24 px icons do not fit (phones) magnification is off and the dock scrolls inside itself. Not reproduced: the genie animation, dock auto-hide, drag-to-reorder, window thumbnails for minimised windows (an app icon is shown).",
    "built", "layout-unit.mts 'dock magnification' ×2, 'dock fitting'; e2e-layout.mts 'Art dock magnification', 'Art dock: launch…', 'Art window chrome + menus', 'keyboard + motion', 'phone 360×640'"),
  F("LY-03", "LY", "Layout switch (Fusion / Business / Art) in Settings → Display and in the Quick panel, persisted as appearance.layout (validated server-side), searchable, scriptable from Routines (layout <id>), Fusion stays the default",
    "A", "P2", "chrome-bits.tsx LayoutSwitch (native radio group) used by DisplaySettings and QuickPanel; settings-validate ENUMS; seed rows appearance.layout / appearance.dockMagnify; Shell runActions 'layout'; html[data-layout]",
    "Fusion (the TT1–TT24 hybrid) stays the default so no working feature or test was removed; the other two are opt-in. The switch is live (no reload) and survives reloads.",
    "built", "layout-unit.mts 'settings, routines and seed'; e2e-layout.mts 'Settings → Layout', 'Quick panel → Layout', 'API'"),
  F("LY-04", "LY", "Two professional office styles after the two most-used desktop systems: Enterprise (after a managed Windows desktop: flat corporate tiles, neutral greys, Windows-style blue) and Graphite (after the macOS Graphite appearance: aluminium squircles, graphite ink, grey accent), each with its own original wallpaper",
    "A", "P3", "src/lib/style-core.ts ENTERPRISE / GRAPHITE + finishes flat / alu (AppIcon.tsx); public/wallpapers/enterprise.svg, graphite.svg; docs/DESIGN-THEMES-TT25.md",
    "Choice grounded on desktop OS share (StatCounter Sep 2026: Windows 76.36 %, macOS ≈16.8 % summed over its two labels; Cloudflare Radar: 73.87 % / 19.86 %). The styles are 'after' those systems, not copies: original art, no vendor assets or logos. Contrast is checked numerically for every glyph, token and accent, and by axe in both themes.",
    "built", "a11y-unit.mts 'style system'; layout-unit.mts 'TT25 professional styles'; e2e-layout.mts 'axe-core'; e2e-a11y.mts light+dark over all 11 styles"),
];

export const UPDATES_TT25: Record<string, Patch> = {};
