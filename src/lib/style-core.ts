/**
 * TT22 — selectable visual styles ("poolside Miami" family). No React, server-safe: used by the root layout (to
 * emit the per-style CSS at first paint), by the icon components, by the settings validator and by the a11y unit
 * suite, which checks every colour pair below numerically (WCAG 1.4.3 text ≥ 4.5:1, 1.4.11 glyphs ≥ 3:1).
 *
 *   poolside   — sun-bleached pastels (pool aqua, flamingo, mint, lemon, lilac) on deep lagoon; soft glass sheen
 *   vice       — Miami-Vice neon: neon-sign glyphs on midnight-violet tiles with a lit tube rim
 *   oceandrive — Ocean Drive art deco: sea-glass, terracotta, sand and deco navy with a thin gold frame
 *   bubbly     — the TT21 glossy primaries, kept as an option (TT22 rule: never remove a working feature)
 *   TT23 — five more, chosen by measured reach (see docs/DESIGN-THEMES-TT23.md):
 *   liquidglass — after Apple Liquid Glass (iOS 26)        expressive — after Google Material 3 Expressive
 *   fluent      — after Microsoft Fluent / Mica (Win 11)   clouddancer — Pantone Colour of the Year 2026
 *   teal        — WGSN × Coloro Colour of the Year 2026 "Transformative Teal"
 *
 * Each style re-colours: app/file icon tiles, the Fusion logo, the default wallpaper, the accent and the chrome
 * surface tokens (dark + light). Module → palette *roles* stay the same (icon-data MODULE_ICONS), so a style is
 * only a colour mapping and can never drop an icon.
 */
import { PALETTES as BUBBLY, type Palette, type PaletteName } from "./icon-data";

export const STYLE_IDS = ["poolside", "vice", "oceandrive", "bubbly", "liquidglass", "expressive", "fluent", "clouddancer", "teal"] as const;
export type StyleId = (typeof STYLE_IDS)[number];
export const DEFAULT_STYLE: StyleId = "poolside";
export const isStyle = (v: unknown): v is StyleId => typeof v === "string" && (STYLE_IDS as readonly string[]).includes(v);

/**
 * How a tile is finished: gloss = TT21 bubble; sheen = soft glass; neon = dark tile + lit rim; deco = gold frame;
 * TT23: glass = frosted lens with a specular rim; tonal = flat tonal container on a rounder shape; mica = small-radius
 * square with a 1px top highlight; paper = one off-white stock with coloured ink glyphs; lacquer = deep teal with a
 * pearl sheen. Overlays stay above y = 11 (or on the rim) so the y 11–38 glyph-contrast sampling stays exact.
 */
export type Finish = "gloss" | "sheen" | "neon" | "deco" | "glass" | "tonal" | "mica" | "paper" | "lacquer";

export interface ChromeTokens {
  bg: string; bg2: string; panel: string; panelSolid: string; border: string; text: string; muted: string;
}
export interface LogoSpec { tileTop: string; tileBottom: string; a: [string, string]; b: [string, string]; lens: string; ring?: string }
export interface StyleSpec {
  id: StyleId; label: string; blurb: string;
  finish: Finish;
  /** primary-button background; button text is #04102b, so it must reach ≥ 4.5:1 against that */
  accent: string;
  /** frame colour for the deco finish / rim colour fallback */
  trim?: string;
  wallpaper: string;
  palettes: Record<PaletteName, Palette>;
  logo: LogoSpec;
  /** launcher pill gradient + window-button bubbles (all carry #14213d ink glyphs/text → ≥ 4.5:1) + desk label backing */
  chrome: { pill: [string, string]; win: [string, string, string]; deskLabel: string };
  dark: ChromeTokens;
  light: ChromeTokens;
}

const POOL_INK = "#0f2f38";
const p = (top: string, bottom: string, fg: string, detail: string): Palette => ({ top, bottom, fg, detail });

/* Poolside: light pastel tiles, deep-lagoon ink glyphs; detail strokes reuse the tile tone. */
const POOLSIDE: Record<PaletteName, Palette> = {
  sun: p("#fff4b8", "#ffd36e", POOL_INK, "#ffe08a"),
  orange: p("#ffdcbf", "#ffae7a", POOL_INK, "#ffc49c"),
  lime: p("#eafac0", "#bfe873", POOL_INK, "#d3f294"),
  mint: p("#c9f6e4", "#74dcb6", POOL_INK, "#9ce8cb"),
  sky: p("#cdeeff", "#82c9f7", POOL_INK, "#a6dafa"),
  blue: p("#d8e0ff", "#98abf7", POOL_INK, "#b6c4fb"),
  teal: p("#bdf3f0", "#56d6d1", POOL_INK, "#86e3df"),
  green: p("#c6f0e1", "#68caa6", POOL_INK, "#95dcc2"),
  coral: p("#ffd0d6", "#ff94a6", POOL_INK, "#ffb2bf"),
  indigo: p("#e9dbff", "#b99df5", POOL_INK, "#d0bcfa"),
  slate: p("#e7ecf1", "#b1bfcd", POOL_INK, "#cad4de"),
  lagoon: p("#b0edf5", "#46bfd8", POOL_INK, "#7bd4e6"),
  ember: p("#ffcabb", "#ff9076", POOL_INK, "#ffad98"),
};

/* Vice: midnight tiles tinted toward the neon hue; the glyph IS the neon; detail strokes cut back to the tile. */
const NIGHT = "#12062a";
const neon = (fg: string, tint: string): Palette => ({ top: tint, bottom: NIGHT, fg, detail: "#1a0a33" });
const VICE: Record<PaletteName, Palette> = {
  sun: neon("#ffe45c", "#33204a"),
  orange: neon("#ffa048", "#3a1d3f"),
  lime: neon("#c8ff4d", "#24284a"),
  mint: neon("#52ffc8", "#16294a"),
  sky: neon("#55e6ff", "#15244e"),
  blue: neon("#7cb1ff", "#1b1f52"),
  teal: neon("#33f3e2", "#13294a"),
  green: neon("#62ff90", "#172a44"),
  coral: neon("#ff5f93", "#3d1442"),
  indigo: neon("#b98bff", "#2a1658"),
  slate: neon("#ddd6ff", "#262046"),
  lagoon: neon("#3fd8ff", "#14254f"),
  ember: neon("#ff7444", "#3d1734"),
};

/* Ocean Drive: deco pastels with charcoal ink, deep deco tones with cream glyphs, thin gold frame. */
const DECO_INK = "#2a2630", CREAM = "#fbf3e4";
const OCEANDRIVE: Record<PaletteName, Palette> = {
  sun: p("#f5e3ba", "#dcbd7d", DECO_INK, "#ead09a"),
  orange: p("#efb495", "#d4805d", DECO_INK, "#e29a78"),
  lime: p("#e3e9bf", "#bcc78b", DECO_INK, "#d0d8a5"),
  mint: p("#cde9dc", "#8fc6af", DECO_INK, "#afd8c6"),
  sky: p("#d3e6f0", "#96c1d8", DECO_INK, "#b6d4e4"),
  blue: p("#3d5d84", "#233d5c", CREAM, "#5b7aa0"),
  teal: p("#3b8580", "#22605b", CREAM, "#5a9e98"),
  green: p("#4b7a60", "#2d5742", CREAM, "#6a957c"),
  coral: p("#f2c7c1", "#d9958e", DECO_INK, "#e6aea7"),
  indigo: p("#695a8c", "#433866", CREAM, "#8676a8"),
  slate: p("#59626e", "#363d48", CREAM, "#78818c"),
  lagoon: p("#3f7f99", "#265c74", CREAM, "#5e9ab2"),
  ember: p("#bf6449", "#954530", CREAM, "#d27e63"),
};

/* ---------------------------------------------------------------- TT23: five reach-backed design languages ---------
 * Chosen by verifiable reach (docs/DESIGN-THEMES-TT23.md): Apple Liquid Glass (iOS 26), Google Material 3 Expressive
 * (Android 16+), Microsoft Fluent/Mica (Windows 11), Pantone 2026 "Cloud Dancer" and WGSN×Coloro 2026 "Transformative
 * Teal". These are original interpretations in this project's own art — no vendor artwork or icons are copied.
 */
const t = (top: string, bottom: string, fg: string, detail: string): Palette => ({ top, bottom, fg, detail });

/* Liquid Glass: vivid iOS-system-colour lenses; ink glyphs except where white reaches 3:1 (blue, indigo). */
const GLASS_INK = "#1c1c1e", W = "#ffffff";
const LIQUIDGLASS: Record<PaletteName, Palette> = {
  sun: t("#ffe066", "#ffc300", GLASS_INK, "#fff3b0"),
  orange: t("#ffb340", "#ff8a00", GLASS_INK, "#ffd699"),
  lime: t("#d4f56a", "#a6e22e", GLASS_INK, "#ecfbb8"),
  mint: t("#7df0c8", "#34c7a0", GLASS_INK, "#c9f9e8"),
  sky: t("#8fd8ff", "#4fb3ff", GLASS_INK, "#d4efff"),
  blue: t("#3d8bff", "#0a5ce6", W, "#9cc4ff"),
  teal: t("#4dd6d6", "#16a9b3", GLASS_INK, "#bff2f2"),
  green: t("#5be37c", "#2fb556", GLASS_INK, "#c4f5cf"),
  coral: t("#ff6b8a", "#ff2d55", GLASS_INK, "#ffc2cf"),
  indigo: t("#7a6cff", "#5040e0", W, "#c3bcff"),
  slate: t("#d5d9e0", "#9aa3b2", GLASS_INK, "#eef0f4"),
  lagoon: t("#5ac8fa", "#1e9bd7", GLASS_INK, "#c4ecfd"),
  ember: t("#ff8a65", "#ff453a", GLASS_INK, "#ffd0c2"),
};

/* Material 3 Expressive: tone-90 tonal containers with tone-10 "on-container" glyphs (the M3 colour-role model). */
const EXPRESSIVE: Record<PaletteName, Palette> = {
  sun: t("#ffeaa8", "#ffdc80", "#241a00", "#ffeaa8"),
  orange: t("#ffe2d3", "#ffcdb5", "#351000", "#ffe2d3"),
  lime: t("#e4f6b4", "#cce98c", "#161f00", "#e4f6b4"),
  mint: t("#c8f6e1", "#a5eacc", "#00201a", "#c8f6e1"),
  sky: t("#d8ecff", "#badbff", "#001d33", "#d8ecff"),
  blue: t("#e0e7ff", "#c6d3ff", "#001a43", "#e0e7ff"),
  teal: t("#c3f3ef", "#9de5df", "#00201f", "#c3f3ef"),
  green: t("#d0f4d2", "#ade7b3", "#002107", "#d0f4d2"),
  coral: t("#ffe0e9", "#ffc6d7", "#3b0b1f", "#ffe0e9"),
  indigo: t("#efe4ff", "#dbc8ff", "#21005d", "#efe4ff"),
  slate: t("#e8e9f0", "#d1d4df", "#1a1c22", "#e8e9f0"),
  lagoon: t("#cfedff", "#a9defb", "#001e2c", "#cfedff"),
  ember: t("#ffe2de", "#ffc7c0", "#410002", "#ffe2de"),
};

/* Fluent / Mica: Fluent shared colours (Windows 11), white glyphs where they reach 3:1, ink on the light hues. */
const FLUENT_INK = "#1a1a1a";
const FLUENT: Record<PaletteName, Palette> = {
  sun: t("#ffd24d", "#ffb900", FLUENT_INK, "#ffe9a6"),
  orange: t("#e06c2a", "#b8460c", W, "#f5b48c"),
  lime: t("#a4d65e", "#7cb518", FLUENT_INK, "#d6efb3"),
  mint: t("#5fd9b0", "#00a87e", FLUENT_INK, "#bdf0df"),
  sky: t("#6cc6f5", "#2b9fe0", FLUENT_INK, "#c4e8fb"),
  blue: t("#2b88d8", "#005fb8", W, "#9ccbf2"),
  teal: t("#128f93", "#036b6f", W, "#8fd3d5"),
  green: t("#2e9e3a", "#107c10", W, "#a3dba9"),
  coral: t("#ec3fa3", "#bf0077", W, "#f7b0d8"),
  indigo: t("#9a7bd0", "#744da9", W, "#d5c6ee"),
  slate: t("#7f8f94", "#5c6b70", W, "#c9d1d4"),
  lagoon: t("#1f8fb3", "#006b8f", W, "#9dd2e4"),
  ember: t("#e05a5e", "#c42b1c", W, "#f4b3b5"),
};

/* Cloud Dancer (PANTONE 11-4201, ≈#F0EEE9): one off-white paper stock, the module colour moves into the ink. */
const PAPER_TOP = "#fbfaf7", PAPER_BOTTOM = "#e6e2da";
const ink = (fg: string, detail: string): Palette => ({ top: PAPER_TOP, bottom: PAPER_BOTTOM, fg, detail });
const CLOUDDANCER: Record<PaletteName, Palette> = {
  sun: ink("#7a5c00", "#f6dc8c"), orange: ink("#a14a12", "#f5c6a5"), lime: ink("#4f6b12", "#dbe9b0"),
  mint: ink("#1f6e55", "#bfe6d6"), sky: ink("#1d6390", "#c3dff0"), blue: ink("#2f4fa0", "#c9d4f2"),
  teal: ink("#18706d", "#bfe5e2"), green: ink("#2e6b3a", "#c6e3cb"), coral: ink("#a8405a", "#f4c4cf"),
  indigo: ink("#5b4a9a", "#d8cff0"), slate: ink("#4a5562", "#d6dbe1"), lagoon: ink("#17698a", "#bfe2ef"),
  ember: ink("#a8402a", "#f4c5b9"),
};

/* Transformative Teal (Coloro 092-37-14, ≈#2F6364): lacquered deep-teal tiles; glyphs in the WGSN A/W 26/27 companions
 * (Green Glow, Fresh Purple, Wax Paper) plus warm glows. Detail strokes cut back to the tile, like Vice. */
const TEAL_DEEP = "#123c3d";
const lac = (tint: string, fg: string): Palette => ({ top: tint, bottom: TEAL_DEEP, fg, detail: "#163f40" });
const TEAL: Record<PaletteName, Palette> = {
  sun: lac("#3a6152", "#ffe27a"), orange: lac("#465b52", "#ffb27a"), lime: lac("#33634e", "#c9f26b"),
  mint: lac("#2a6460", "#8ff0cf"), sky: lac("#2b5b69", "#9fdcff"), blue: lac("#2e536b", "#b0c8ff"),
  teal: lac("#2f6364", "#7ff0e6"), green: lac("#2f6253", "#9ef0a8"), coral: lac("#47525b", "#ffadbb"),
  indigo: lac("#3c4e66", "#cfb0ff"), slate: lac("#385859", "#efe8d8"), lagoon: lac("#2a5d6b", "#8fe3f5"),
  ember: lac("#48524c", "#ffa184"),
};

export const STYLES: Record<StyleId, StyleSpec> = {
  poolside: {
    id: "poolside", label: "Poolside", blurb: "Sun-bleached pastels on deep lagoon — aqua, flamingo, mint, lemon",
    finish: "sheen", accent: "#4fd8d2", wallpaper: "poolside", palettes: POOLSIDE,
    logo: { tileTop: "#5fe0d9", tileBottom: "#1f9fb8", a: ["#ffd0d8", "#ff8aa0"], b: ["#fff3b0", "#ffcc5c"], lens: "#fffaf0" },
    chrome: { pill: ["#ffd0d8", "#ff94a6"], win: ["#ffe08a", "#86e3df", "#ff9fb1"], deskLabel: "rgba(6, 42, 51, 0.8)" },
    dark: { bg: "#062a33", bg2: "#0a3a45", panel: "rgba(8, 44, 54, 0.9)", panelSolid: "#0b313b", border: "rgba(120, 230, 222, 0.18)", text: "#eafcfa", muted: "#a6d3d4" },
    light: { bg: "#e6f7f6", bg2: "#f4fcfb", panel: "rgba(255,255,255,0.9)", panelSolid: "#ffffff", border: "rgba(10, 70, 80, 0.16)", text: "#0c2a31", muted: "#3f6168" },
  },
  vice: {
    id: "vice", label: "Vice", blurb: "Neon-sign glyphs on midnight violet — hot pink, electric cyan, sunset orange",
    finish: "neon", accent: "#ff62a8", wallpaper: "vice", palettes: VICE,
    logo: { tileTop: "#2b0f52", tileBottom: "#0f0424", a: ["#ff8fc4", "#ff3d8f"], b: ["#8ff3ff", "#2fd6ff"], lens: "#fff1fb", ring: "#ff62a8" },
    chrome: { pill: ["#ff8fc4", "#ff4f9a"], win: ["#ffe45c", "#52ffc8", "#ff6f9e"], deskLabel: "rgba(18, 6, 42, 0.82)" },
    dark: { bg: "#11061f", bg2: "#1c0a35", panel: "rgba(26, 10, 50, 0.9)", panelSolid: "#1b0a33", border: "rgba(255, 98, 200, 0.22)", text: "#fbefff", muted: "#c8b6e6" },
    light: { bg: "#fbeef8", bg2: "#fff6fc", panel: "rgba(255,255,255,0.9)", panelSolid: "#ffffff", border: "rgba(80, 10, 70, 0.16)", text: "#22082e", muted: "#5d3f68" },
  },
  oceandrive: {
    id: "oceandrive", label: "Ocean Drive", blurb: "Art-deco sea-glass, terracotta and sand with a fine gold line",
    finish: "deco", accent: "#e8b07a", trim: "#c9a24a", wallpaper: "oceandrive", palettes: OCEANDRIVE,
    logo: { tileTop: "#2f4d6e", tileBottom: "#1b3049", a: ["#f0b79a", "#d27c58"], b: ["#cfe9dc", "#86c2aa"], lens: "#fbf3e4", ring: "#c9a24a" },
    chrome: { pill: ["#f5e3ba", "#e8b07a"], win: ["#ead09a", "#afd8c6", "#e6aea7"], deskLabel: "rgba(20, 29, 39, 0.82)" },
    dark: { bg: "#141d27", bg2: "#1d2a37", panel: "rgba(27, 38, 50, 0.92)", panelSolid: "#1b2632", border: "rgba(232, 196, 130, 0.2)", text: "#f7efe2", muted: "#c9bda8" },
    light: { bg: "#f5eee2", bg2: "#fbf7ef", panel: "rgba(255,255,255,0.9)", panelSolid: "#fffdf8", border: "rgba(70, 50, 20, 0.16)", text: "#26211b", muted: "#5d5243" },
  },
  bubbly: {
    id: "bubbly", label: "Bubbly (TT21)", blurb: "Glossy bright primaries on cobalt — the TT21 look",
    finish: "gloss", accent: "#5b8cff", wallpaper: "sunrise", palettes: BUBBLY,
    logo: { tileTop: "#3cc4ff", tileBottom: "#2347e0", a: ["#ffe873", "#ff9d1c"], b: ["#7af0b8", "#14b87a"], lens: "#fffbe6" },
    chrome: { pill: ["#ffe36e", "#ffb020"], win: ["#ffd34d", "#5ee39b", "#ff7a7a"], deskLabel: "rgba(10, 19, 48, 0.78)" },
    dark: { bg: "#0a1330", bg2: "#11204a", panel: "rgba(17, 28, 58, 0.9)", panelSolid: "#13214a", border: "rgba(130, 160, 255, 0.16)", text: "#e8edfa", muted: "#a9b6d6" },
    light: { bg: "#e9eefb", bg2: "#f5f7ff", panel: "rgba(255,255,255,0.9)", panelSolid: "#ffffff", border: "rgba(20, 40, 90, 0.14)", text: "#111a2e", muted: "#4b5a7a" },
  },
  liquidglass: {
    id: "liquidglass", label: "Liquid Glass", blurb: "Frosted lenses and specular rims in vivid system colours (after Apple iOS 26)",
    finish: "glass", accent: "#0a84ff", wallpaper: "glass", palettes: LIQUIDGLASS,
    logo: { tileTop: "#5ac8fa", tileBottom: "#0a6cff", a: ["#ffb3c4", "#ff375f"], b: ["#fff3a0", "#ffd60a"], lens: "#ffffff", ring: "#ffffff" },
    chrome: { pill: ["#e6f0ff", "#a9cdff"], win: ["#febc2e", "#28c840", "#ff5f57"], deskLabel: "rgba(20, 24, 30, 0.78)" },
    dark: { bg: "#101418", bg2: "#1a2028", panel: "rgba(30, 34, 40, 0.84)", panelSolid: "#1c2027", border: "rgba(255, 255, 255, 0.2)", text: "#f5f7fa", muted: "#b8c0cc" },
    light: { bg: "#eef2f7", bg2: "#f7f9fc", panel: "rgba(255, 255, 255, 0.8)", panelSolid: "#ffffff", border: "rgba(0, 0, 0, 0.12)", text: "#111418", muted: "#4a5260" },
  },
  expressive: {
    id: "expressive", label: "Material Expressive", blurb: "Tonal containers, round shapes, lilac primary (after Google Material 3 Expressive)",
    finish: "tonal", accent: "#d0bcff", wallpaper: "material", palettes: EXPRESSIVE,
    logo: { tileTop: "#eaddff", tileBottom: "#cbb6ff", a: ["#9a82db", "#6750a4"], b: ["#ffb1c8", "#9c4d6b"], lens: "#fef7ff" },
    chrome: { pill: ["#eaddff", "#d0bcff"], win: ["#ffe08b", "#b6f2d6", "#ffdad6"], deskLabel: "rgba(29, 27, 32, 0.8)" },
    dark: { bg: "#141218", bg2: "#1d1b20", panel: "rgba(33, 31, 38, 0.92)", panelSolid: "#211f26", border: "rgba(202, 196, 208, 0.2)", text: "#e6e0e9", muted: "#cac4d0" },
    light: { bg: "#fef7ff", bg2: "#f7f2fa", panel: "rgba(243, 237, 247, 0.92)", panelSolid: "#f3edf7", border: "rgba(73, 69, 79, 0.2)", text: "#1d1b20", muted: "#49454f" },
  },
  fluent: {
    id: "fluent", label: "Fluent", blurb: "Mica neutrals, crisp small radii and the Windows blue (after Microsoft Fluent / Windows 11)",
    finish: "mica", accent: "#60cdff", wallpaper: "fluent", palettes: FLUENT,
    logo: { tileTop: "#3aa0f3", tileBottom: "#0067c0", a: ["#ffd27a", "#ffb900"], b: ["#9ff0f5", "#00b7c3"], lens: "#ffffff" },
    chrome: { pill: ["#d6e9fa", "#99ccf3"], win: ["#ebebeb", "#ebebeb", "#f4a3aa"], deskLabel: "rgba(32, 32, 32, 0.8)" },
    dark: { bg: "#202020", bg2: "#2b2b2b", panel: "rgba(44, 44, 44, 0.9)", panelSolid: "#2c2c2c", border: "rgba(255, 255, 255, 0.1)", text: "#ffffff", muted: "#c5c5c5" },
    light: { bg: "#f3f3f3", bg2: "#f9f9f9", panel: "rgba(251, 251, 251, 0.9)", panelSolid: "#fbfbfb", border: "rgba(0, 0, 0, 0.1)", text: "#1a1a1a", muted: "#5d5d5d" },
  },
  clouddancer: {
    id: "clouddancer", label: "Cloud Dancer", blurb: "Pantone 2026 Cloud Dancer white with powdered-pastel ink — calm and airy",
    finish: "paper", accent: "#f2b8a2", trim: "#cfc8ba", wallpaper: "clouddancer", palettes: CLOUDDANCER,
    logo: { tileTop: "#fbfaf7", tileBottom: "#e3dfd6", a: ["#f6c6b6", "#d98a76"], b: ["#c3dbf2", "#6f9fcf"], lens: "#ffffff", ring: "#cfc8ba" },
    chrome: { pill: ["#faf9f6", "#e6e2da"], win: ["#f3d98a", "#b9dfcf", "#f2b8a8"], deskLabel: "rgba(31, 29, 26, 0.8)" },
    dark: { bg: "#1e1d1b", bg2: "#282724", panel: "rgba(40, 39, 36, 0.92)", panelSolid: "#2a2926", border: "rgba(240, 238, 233, 0.16)", text: "#f0eee9", muted: "#c9c4b8" },
    light: { bg: "#f0eee9", bg2: "#f7f6f2", panel: "rgba(250, 249, 246, 0.92)", panelSolid: "#faf9f6", border: "rgba(60, 50, 30, 0.14)", text: "#1f1d1a", muted: "#57524a" },
  },
  teal: {
    id: "teal", label: "Transformative Teal", blurb: "WGSN × Coloro 2026 deep teal, lacquered, with green-glow and wax-paper accents",
    finish: "lacquer", accent: "#5fd0c2", trim: "#c9f26b", wallpaper: "teal", palettes: TEAL,
    logo: { tileTop: "#3a7576", tileBottom: "#163f40", a: ["#ffe9a0", "#f2b631"], b: ["#b5f5e4", "#4fc9b3"], lens: "#f5fbf7", ring: "#c9f26b" },
    chrome: { pill: ["#d8f59a", "#8fe0d0"], win: ["#ffe27a", "#8ff0cf", "#ffadbb"], deskLabel: "rgba(12, 38, 39, 0.82)" },
    dark: { bg: "#0c2627", bg2: "#123334", panel: "rgba(16, 48, 49, 0.92)", panelSolid: "#113233", border: "rgba(127, 240, 230, 0.18)", text: "#eaf6f4", muted: "#a9cbc8" },
    light: { bg: "#edf4f2", bg2: "#f6faf9", panel: "rgba(255, 255, 255, 0.9)", panelSolid: "#ffffff", border: "rgba(15, 60, 60, 0.16)", text: "#0f2a2b", muted: "#3f5f5f" },
  },
};

export const paletteFor = (style: StyleId, name: PaletteName): Palette => STYLES[style].palettes[name] ?? BUBBLY[name];

const tokenCss = (t: ChromeTokens) =>
  `--fs-bg:${t.bg};--fs-bg-2:${t.bg2};--fs-panel:${t.panel};--fs-panel-solid:${t.panelSolid};--fs-border:${t.border};--fs-text:${t.text};--fs-muted:${t.muted};`;

/**
 * CSS for every style, emitted once by the root layout. Wrapped in `not (prefers-contrast: more)` so the AX-03
 * high-contrast overrides in globals.css always win; forced-colors replaces colours anyway. The accent is set
 * on a separate custom property (--fs-style-accent) so a user-picked accent (inline --fs-accent) still wins.
 */
export function styleCss(): string {
  const blocks = STYLE_IDS.map((id) => {
    const s = STYLES[id];
    const c = s.chrome;
    const chrome = `--fs-pill-a:${c.pill[0]};--fs-pill-b:${c.pill[1]};--fs-win-min:${c.win[0]};--fs-win-max:${c.win[1]};--fs-win-close:${c.win[2]};--fs-desk-label:${c.deskLabel};`;
    return `:root[data-style="${id}"]{${tokenCss(s.dark)}--fs-style-accent:${s.accent};${chrome}}` +
      `:root[data-style="${id}"][data-theme="light"]{${tokenCss(s.light)}}`;
  }).join("");
  return `@media not (prefers-contrast: more){${blocks}}`;
}

/** "auto" wallpaper → the style's own wallpaper. */
export const resolveWallpaper = (wallpaper: string | undefined, style: StyleId): string =>
  !wallpaper || wallpaper === "auto" ? STYLES[style].wallpaper : wallpaper;
