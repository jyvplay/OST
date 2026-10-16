/**
 * TT22 — selectable visual styles ("poolside Miami" family). No React, server-safe: used by the root layout (to
 * emit the per-style CSS at first paint), by the icon components, by the settings validator and by the a11y unit
 * suite, which checks every colour pair below numerically (WCAG 1.4.3 text ≥ 4.5:1, 1.4.11 glyphs ≥ 3:1).
 *
 *   poolside   — sun-bleached pastels (pool aqua, flamingo, mint, lemon, lilac) on deep lagoon; soft glass sheen
 *   vice       — Miami-Vice neon: neon-sign glyphs on midnight-violet tiles with a lit tube rim
 *   oceandrive — Ocean Drive art deco: sea-glass, terracotta, sand and deco navy with a thin gold frame
 *   bubbly     — the TT21 glossy primaries, kept as an option (TT22 rule: never remove a working feature)
 *
 * Each style re-colours: app/file icon tiles, the Fusion logo, the default wallpaper, the accent and the chrome
 * surface tokens (dark + light). Module → palette *roles* stay the same (icon-data MODULE_ICONS), so a style is
 * only a colour mapping and can never drop an icon.
 */
import { PALETTES as BUBBLY, type Palette, type PaletteName } from "./icon-data";

export const STYLE_IDS = ["poolside", "vice", "oceandrive", "bubbly"] as const;
export type StyleId = (typeof STYLE_IDS)[number];
export const DEFAULT_STYLE: StyleId = "poolside";
export const isStyle = (v: unknown): v is StyleId => typeof v === "string" && (STYLE_IDS as readonly string[]).includes(v);

/** How a tile is finished: gloss = TT21 bubble; sheen = soft glass; neon = dark tile + lit rim; deco = gold frame. */
export type Finish = "gloss" | "sheen" | "neon" | "deco";

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
