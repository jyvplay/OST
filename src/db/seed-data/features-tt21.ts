import { F, type SpecRow, type Status } from "./row";
import { platformFeatures } from "./features-platform";

/**
 * TT21 register additions — USER-DIRECTED EXTENSION ROWS. The user asked for text and logos twice as large by default,
 * cheerful graphics, visual checks, and California disability rules for digital text (ADA Title II/III + Unruh Act +
 * Gov Code 11546.7 all benchmark WCAG 2.x AA; WCAG sets no minimum px size, it requires 1.4.4 resize to 200 %,
 * 1.4.3 / 1.4.11 contrast, 1.4.10 reflow, 1.4.12 text spacing).
 */
export const tt21Features: SpecRow[] = [
  F("AX-09", "AX", "Text size setting: default 200 % of the TT20 sizes (smallest UI text 20 px at a 16 px browser default), 100–300 % in Settings, Quick panel A−/A+ and the 'textsize' routine command",
    "A", "P1", "src/lib/uiscale.ts (--fs-ts / --fs-u, fz(), useUiUnit) + globals.css tokens + appearance.textScale setting (validated 100–300 by PUT /api/settings) + Settings 'Display & readability' + QuickPanel",
    "Every inline UI font size is fz(n) = n × scale × 1rem/16, so the browser's own default-font-size preference still multiplies in (relative units, WCAG 1.4.4); titlebars, targets, radii, the shelf, top bar, launcher, Spreadsheet grid geometry and default window sizes scale with it. Document content (a Writer heading, a Vector text shape) is model data and is NOT scaled — it keeps its document size. Limits: some fixed-px panel widths (side bars) only grow with the window, not with the text.",
    "built", "a11y-unit.mts; e2e-a11y.mts 'computed sizes', '300 % and reflow'"),
  F("AX-10", "AX", "Icon and logo system: every module, file type and shell control is an SVG tile (gradient squircle, white or ink glyph) with ≥3:1 glyph contrast; the logo is two fused bubbles",
    "A", "P2", "src/components/AppIcon.tsx (AppIcon / FileIcon / FusionLogo / UiGlyph) + public/icon*.svg/png + manifest.webmanifest",
    "Replaces emoji icons, which rendered blank or as tofu wherever the system lacks a colour-emoji font (seen in the TT21 'before' screenshots: blank shelf, blank launcher icons and invisible tile/pop-out/maximise/close buttons). Glyph contrast is checked numerically against the gradient at two positions (WCAG 1.4.11).",
    "built", "a11y-unit.mts 'icon contrast', 'every module has an icon'; e2e-a11y.mts 'icons are SVG', 'manifest icons'"),
];

type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };
const ax03 = platformFeatures.find((f) => f.code === "AX-03");
const ax08 = platformFeatures.find((f) => f.code === "AX-08");
export const UPDATES_TT21: Record<string, Patch> = ax03 && ax08 ? {
  "AX-03": { status: "built", route: `${ax03.route} — TT21: the forced-colors and prefers-contrast queries now actually exist in globals.css (TT21 found the row claimed them but there were none), plus the AX-09 text scale`,
    test: "e2e-a11y.mts 'forced colours + more contrast'" },
  "AX-08": { status: "built", route: "axe-core 4.14 (MPL-2.0) run headless against every module window, WCAG 2.0/2.1/2.2 A+AA tags; plus unit assertions over icons, contrast and the scale maths",
    nuance: "External verifier: axe-core is Deque's rules engine, not this repo's code. It cannot judge everything (meaningful alt text, reading order quality); those stay manual.",
    test: "e2e-a11y.mts 'axe per module'; a11y-unit.mts" },
} : {};
