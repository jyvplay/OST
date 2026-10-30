"use client";
/**
 * TT21 — first-party icon system (replaces emoji, which render as blanks/tofu on systems without a colour-emoji
 * font — confirmed in this sandbox's Chromium). Every module and file type gets a "bubbly" tile: a squircle with a
 * bright two-stop gradient, a glossy top highlight and a chunky rounded glyph.
 *
 * Accessibility (WCAG 2.1 SC 1.4.11 non-text contrast): the glyph colour must reach ≥ 3:1 against the tile colour
 * wherever the glyph sits (gradient positions 0.25 and 0.80). Light tiles use a dark ink glyph, deep tiles a white
 * glyph; scripts/a11y-unit.mts checks every palette numerically. Icons are decorative next to a visible label
 * (aria-hidden) unless `label` is passed.
 */
import { useId, type ReactNode } from "react";
import { fz } from "@/lib/uiscale";

import { MODULE_ICONS, fileIconSpec, type Palette, type PaletteName, type GlyphName } from "@/lib/icon-data";
import { STYLES, paletteFor, type Finish, type StyleId } from "@/lib/style-core";
import { useStyleId } from "@/lib/style";
export { INK, WHITE, PALETTES, MODULE_ICONS, fileIconSpec } from "@/lib/icon-data";

type Glyph = (p: Palette) => ReactNode;
/** true when the glyph ink is dark (light tile) — picks accent colours that stay visible on either kind of tile */
const inkIsDark = (hex: string) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 128; };
const S = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** 48×48 glyphs, drawn inside the 12…36 safe area. */
export const GLYPHS: Record<GlyphName, Glyph> = {
  folder: (p) => <><path d="M10 17a3.5 3.5 0 0 1 3.5-3.5h7.2l3.3 3.6h10.5A3.5 3.5 0 0 1 38 20.6v12.9a3.5 3.5 0 0 1-3.5 3.5h-21A3.5 3.5 0 0 1 10 33.5Z" fill={p.fg} /><path d="M13 22.5h22" {...S} stroke={p.detail} strokeWidth="2.6" /></>,
  pencil: (p) => <><path d="M14.5 33.5l1.8-6.6L30 13.2a2.6 2.6 0 0 1 3.7 0l1.1 1.1a2.6 2.6 0 0 1 0 3.7L21.1 31.7z" fill={p.fg} /><path d="M27.5 15.8l4.7 4.7" {...S} stroke={p.detail} strokeWidth="2.4" /><path d="M13 38h22" {...S} stroke={p.fg} strokeWidth="3.4" /></>,
  search: (p) => <><circle cx="21.5" cy="21.5" r="8.2" {...S} stroke={p.fg} strokeWidth="4" /><path d="M27.6 27.6L35 35" {...S} stroke={p.fg} strokeWidth="5" /><circle cx="18.6" cy="18.6" r="2" fill={p.fg} opacity=".55" /></>,
  terminal: (p) => <><path d="M13.5 17.5l7 6.5-7 6.5" {...S} stroke={p.fg} strokeWidth="4" /><path d="M24.5 31h10" {...S} stroke={inkIsDark(p.fg) ? "#0a7d57" : "#7cf5c4"} strokeWidth="4" /></>,
  note: (p) => <><path d="M13 12.5h22a1.5 1.5 0 0 1 1.5 1.5v14.6L28.1 37H13a1.5 1.5 0 0 1-1.5-1.5V14a1.5 1.5 0 0 1 1.5-1.5z" fill={p.fg} /><path d="M27.8 36.6v-6.4a1.8 1.8 0 0 1 1.8-1.8h6.4" {...S} stroke={p.detail} strokeWidth="2.6" /><path d="M16.5 19h14M16.5 24.5h9" {...S} stroke={p.detail} strokeWidth="2.6" /></>,
  globe: (p) => <><circle cx="24" cy="24" r="12" {...S} stroke={p.fg} strokeWidth="3.4" /><ellipse cx="24" cy="24" rx="5.2" ry="12" {...S} stroke={p.fg} strokeWidth="2.8" /><path d="M12.8 20h22.4M12.8 28h22.4" {...S} stroke={p.fg} strokeWidth="2.8" /></>,
  play: (p) => <path d="M19 14.6v18.8a1.6 1.6 0 0 0 2.5 1.3l13.6-9.4a1.6 1.6 0 0 0 0-2.6l-13.6-9.4A1.6 1.6 0 0 0 19 14.6z" fill={p.fg} />,
  record: (p) => <><path d="M12 18v-3.5a2.5 2.5 0 0 1 2.5-2.5H18M30 12h3.5a2.5 2.5 0 0 1 2.5 2.5V18M36 30v3.5a2.5 2.5 0 0 1-2.5 2.5H30M18 36h-3.5a2.5 2.5 0 0 1-2.5-2.5V30" {...S} stroke={p.fg} strokeWidth="3.4" /><circle cx="24" cy="24" r="6" fill={p.fg} /></>,
  camera: (p) => <><rect x="10.5" y="16.5" width="27" height="19" rx="5" fill={p.fg} /><rect x="18" y="12" width="9" height="6" rx="2.4" fill={p.fg} /><circle cx="24" cy="26" r="6" fill={p.detail} /><circle cx="24" cy="26" r="2.6" fill={p.fg} /><circle cx="33" cy="20.5" r="1.4" fill={p.detail} /></>,
  broadcast: (p) => <><circle cx="24" cy="31" r="3.4" fill={p.fg} /><path d="M17.3 24.3a9.5 9.5 0 0 1 13.4 0M12.6 19.6a16 16 0 0 1 22.8 0" {...S} stroke={p.fg} strokeWidth="3.6" /><path d="M24 34.4V38" {...S} stroke={p.fg} strokeWidth="3.4" /></>,
  people: (p) => <><circle cx="18" cy="19" r="5" fill={p.fg} /><circle cx="31" cy="19.5" r="4.4" fill={p.fg} /><path d="M9.5 35.5a8.5 8.5 0 0 1 17 0z" fill={p.fg} /><path d="M24.6 35.5a7.6 7.6 0 0 1 14.4-3.4l.4 3.4z" fill={p.fg} /></>,
  chat: (p) => <><path d="M11.5 16a4.5 4.5 0 0 1 4.5-4.5h16a4.5 4.5 0 0 1 4.5 4.5v10a4.5 4.5 0 0 1-4.5 4.5h-8.6l-6.9 5.8v-5.8h0a4.5 4.5 0 0 1-5-4.5z" fill={p.fg} /><circle cx="18.2" cy="21" r="2" fill={p.detail} /><circle cx="24" cy="21" r="2" fill={p.detail} /><circle cx="29.8" cy="21" r="2" fill={p.detail} /></>,
  lock: (p) => <><path d="M17 22v-4.2a7 7 0 0 1 14 0V22" {...S} stroke={p.fg} strokeWidth="3.6" /><rect x="12.5" y="21" width="23" height="16" rx="4.5" fill={p.fg} /><circle cx="24" cy="27.6" r="2.5" fill={p.detail} /><path d="M24 29v3.4" {...S} stroke={p.detail} strokeWidth="2.6" /></>,
  shield: (p) => <><path d="M24 10.5l11.5 4.3v8.4c0 7.4-4.9 12.4-11.5 14.8-6.6-2.4-11.5-7.4-11.5-14.8v-8.4z" fill={p.fg} /><path d="M18.6 24.2l3.9 3.9 7.2-7.6" {...S} stroke={p.detail} strokeWidth="3.4" /></>,
  cloud: (p) => <><path d="M16.2 34.5a7 7 0 0 1-.9-13.9 9.4 9.4 0 0 1 18.1-1.4 7.6 7.6 0 0 1-.2 15.3z" fill={p.fg} /><path d="M24 31v-8.5M20.2 26.2L24 22.4l3.8 3.8" {...S} stroke={p.detail} strokeWidth="3" /></>,
  bell: (p) => <><path d="M24 11a8.2 8.2 0 0 1 8.2 8.2v5.6l3.2 5.2H12.6l3.2-5.2v-5.6A8.2 8.2 0 0 1 24 11z" fill={p.fg} /><circle cx="24" cy="34.4" r="3.1" fill={p.fg} /></>,
  pulse: (p) => <path d="M9.5 26h7.2l3.3-8.6 5.4 15 4-10.4 2.1 4h7" {...S} stroke={p.fg} strokeWidth="3.8" />,
  keypad: (p) => <><rect x="13.5" y="10" width="21" height="28" rx="4.5" fill={p.fg} /><rect x="17" y="13.5" width="14" height="6.2" rx="1.8" fill={p.detail} />{[19, 24, 29].flatMap((x) => [25.4, 31.6].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill={p.detail} />))}</>,
  gear: (p) => <><circle cx="24" cy="24" r="7.6" {...S} stroke={p.fg} strokeWidth="4.4" />{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => { const r = (a * Math.PI) / 180; return <path key={a} d={`M${24 + Math.cos(r) * 10.6} ${24 + Math.sin(r) * 10.6}L${24 + Math.cos(r) * 13.4} ${24 + Math.sin(r) * 13.4}`} {...S} stroke={p.fg} strokeWidth="4.6" />; })}</>,
  checklist: (p) => <><rect x="12.5" y="12" width="23" height="26" rx="4.5" fill={p.fg} /><rect x="18.5" y="9" width="11" height="6" rx="2.6" fill={p.fg} stroke={p.detail} strokeWidth="1.8" /><path d="M16.8 22.4l2.2 2.2 3.6-3.8M25.8 23h5.4M16.8 30.4l2.2 2.2 3.6-3.8M25.8 31h5.4" {...S} stroke={p.detail} strokeWidth="2.6" /></>,
  clock: (p) => <><circle cx="24" cy="24" r="12.5" fill={p.fg} /><path d="M24 16.5V24l5.2 3.2" {...S} stroke={p.detail} strokeWidth="3.4" /></>,
  calendar: (p) => <><rect x="11" y="14" width="26" height="23.5" rx="4.5" fill={p.fg} /><path d="M18 10.5v6M30 10.5v6" {...S} stroke={p.fg} strokeWidth="3.4" /><path d="M11.5 20.5h25" stroke={p.detail} strokeWidth="2.4" />{[18, 24, 30].flatMap((x) => [26, 31.6].map((y) => <rect key={`${x}-${y}`} x={x - 2} y={y - 2} width="4" height="4" rx="1.2" fill={p.detail} />))}</>,
  plug: (p) => <><path d="M20 11v6.5M28 11v6.5" {...S} stroke={p.fg} strokeWidth="3.4" /><path d="M15.5 17.5h17v5a8.5 8.5 0 0 1-17 0z" fill={p.fg} /><path d="M24 31v3a3.5 3.5 0 0 0 3.5 3.5H33" {...S} stroke={p.fg} strokeWidth="3.4" /></>,
  screenShare: (p) => <><rect x="10" y="11.5" width="28" height="20" rx="3.6" fill={p.fg} /><path d="M18 37h12M24 31.5V37" {...S} stroke={p.fg} strokeWidth="3.2" /><path d="M19 26.5l9-9M21.5 17.5H28V24" {...S} stroke={p.detail} strokeWidth="3" /></>,
  bolt: (p) => <path d="M26.6 9.5L14.2 27.2h8.9l-2.2 11.3 13-18.4h-9.2z" fill={p.fg} strokeLinejoin="round" stroke={p.fg} strokeWidth="1.6" />,
  clipboard: (p) => <><rect x="12.5" y="12" width="23" height="26" rx="4.5" fill={p.fg} /><rect x="18.5" y="9" width="11" height="6.2" rx="2.6" fill={p.fg} stroke={p.detail} strokeWidth="1.8" /><path d="M17.5 23h13M17.5 29h9" {...S} stroke={p.detail} strokeWidth="2.8" /></>,
  pie: (p) => <><circle cx="24" cy="24" r="12.5" fill={p.fg} /><path d="M24 24V11.5M24 24l10.8 6.3" {...S} stroke={p.detail} strokeWidth="3" /><path d="M24 11.5a12.5 12.5 0 0 1 10.8 18.8L24 24z" fill={p.detail} opacity=".45" /></>,
  drive: (p) => <><rect x="9.5" y="16.5" width="29" height="16" rx="4.5" fill={p.fg} /><path d="M14.5 24.5h10" {...S} stroke={p.detail} strokeWidth="2.8" /><circle cx="32.5" cy="24.5" r="2.4" fill="#4ade80" /></>,
  picture: (p) => <><rect x="10" y="12" width="28" height="24" rx="4.5" fill={p.fg} /><path d="M13 33l7.6-8.6 5 5.2 4-4.2L35.4 33z" fill={p.detail} /><circle cx="30.5" cy="19.5" r="3.4" fill="#ffd23f" /></>,
  pen: (p) => <><path d="M24 9.5l8.8 11.8-4.7 13.2h-8.2l-4.7-13.2z" fill={p.fg} /><circle cx="24" cy="22.5" r="2.4" fill={p.detail} /><path d="M24 25v7" {...S} stroke={p.detail} strokeWidth="2" /><rect x="19.2" y="34.8" width="9.6" height="3.6" rx="1.4" fill={p.fg} /></>,
  doc: (p) => <><path d="M15 10h12.2l8.3 8.3V36a2.5 2.5 0 0 1-2.5 2.5H15a2.5 2.5 0 0 1-2.5-2.5V12.5A2.5 2.5 0 0 1 15 10z" fill={p.fg} /><path d="M27 10.4v6.4a1.6 1.6 0 0 0 1.6 1.6H35" {...S} stroke={p.detail} strokeWidth="2.4" /><path d="M17.5 24.5h13M17.5 29.5h13M17.5 34h7.5" {...S} stroke={p.detail} strokeWidth="2.6" /></>,
  book: (p) => <><path d="M24 15.2C20.6 12.4 15.8 11.6 10.5 12.3v22.4c5.3-.7 10.1.1 13.5 2.9 3.4-2.8 8.2-3.6 13.5-2.9V12.3c-5.3-.7-10.1.1-13.5 2.9z" fill={p.fg} /><path d="M24 15.6v21.6" {...S} stroke={p.detail} strokeWidth="2.4" /><path d="M14.5 19.5c2.6-.2 4.8.2 6.4 1.2M14.5 25c2.6-.2 4.8.2 6.4 1.2M27.1 20.7c1.6-1 3.8-1.4 6.4-1.2M27.1 26.2c1.6-1 3.8-1.4 6.4-1.2" {...S} stroke={p.detail} strokeWidth="2.2" /></>,
  easel: (p) => <><rect x="10" y="10.5" width="28" height="20" rx="3.6" fill={p.fg} /><path d="M19.5 37.5l3-7M28.5 37.5l-3-7" {...S} stroke={p.fg} strokeWidth="3.2" /><rect x="15" y="21" width="4.4" height="6" rx="1.2" fill={p.detail} /><rect x="21.8" y="17" width="4.4" height="10" rx="1.2" fill={p.detail} /><rect x="28.6" y="14" width="4.4" height="13" rx="1.2" fill={p.detail} /></>,
  // TT23 Whiteboard: a sticky square bound to a circle by an arrow — the connector model in one picture
  // TT24 Contacts: an address card, person on the left, detail lines on the right
  contact: (p) => <><rect x="7.5" y="11" width="33" height="26" rx="5.5" fill={p.fg} /><circle cx="17.5" cy="21" r="4.4" fill={p.detail} /><path d="M10.6 33a6.9 6.9 0 0 1 13.8 0z" fill={p.detail} /><path d="M28 19.5h7.5M28 25h7.5M28 30.5h4.8" stroke={p.detail} strokeWidth="2.5" strokeLinecap="round" /></>,
  board: (p) => <><rect x="9" y="11" width="14" height="13" rx="3" fill={p.fg} /><circle cx="31.5" cy="31" r="7" fill={p.fg} /><path d="M21 22.5l5.6 4.6" {...S} stroke={p.fg} strokeWidth="2.8" /><path d="M28.6 29.6l-6.6-1.2 3.4-4.4z" fill={p.fg} /><path d="M12.5 15.5h7M12.5 19.5h4.5" stroke={p.detail} strokeWidth="2" strokeLinecap="round" /><circle cx="31.5" cy="31" r="2.6" fill={p.detail} /></>,
  // TT22 Tables: a record table — header band with a record dot, row rules, and a narrow first column
  table: (p) => <><rect x="9.5" y="11.5" width="29" height="25" rx="4.5" fill={p.fg} /><path d="M9.5 19h29M9.5 25.6h29M9.5 31.6h29M16.5 19v17.5" stroke={p.detail} strokeWidth="2.4" /><circle cx="13" cy="15.3" r="1.9" fill={p.detail} /><path d="M19.5 15.3h14" stroke={p.detail} strokeWidth="2.4" strokeLinecap="round" /></>,
  grid: (p) => <><rect x="10.5" y="11.5" width="27" height="25" rx="4.5" fill={p.fg} /><path d="M10.5 19.6h27M10.5 28h27M19.5 11.5v25M28.5 19.6v16.9" stroke={p.detail} strokeWidth="2.6" /></>,
  eye: (p) => <><path d="M8.5 24c4.2-7.3 9.3-10.8 15.5-10.8S35.3 16.7 39.5 24c-4.2 7.3-9.3 10.8-15.5 10.8S12.7 31.3 8.5 24z" fill={p.fg} /><circle cx="24" cy="24" r="6.2" fill={p.detail} /><circle cx="24" cy="24" r="2.6" fill={p.fg} /></>,
  braces: (p) => <path d="M19 12.5c-3 0-4 1.5-4 4v3.5c0 2-1 3.5-3 4 2 .5 3 2 3 4V31.5c0 2.5 1 4 4 4M29 12.5c3 0 4 1.5 4 4v3.5c0 2 1 3.5 3 4-2 .5-3 2-3 4V31.5c0 2.5-1 4-4 4" {...S} stroke={p.fg} strokeWidth="3.6" />,
  music: (p) => <><path d="M20 32V15.5l14-3v16" {...S} stroke={p.fg} strokeWidth="3.4" /><circle cx="16.5" cy="32" r="4.2" fill={p.fg} /><circle cx="30.5" cy="28.5" r="4.2" fill={p.fg} /></>,
  film: (p) => <><rect x="9.5" y="13" width="29" height="22" rx="4.5" fill={p.fg} /><path d="M21 19.5v9l7.5-4.5z" fill={p.detail} />{[16.5, 31.5].map((y) => [13.5, 18.5, 29.5, 34.5].map((x) => <rect key={`${x}-${y}`} x={x - 1.4} y={y - 1.4} width="2.8" height="2.8" rx=".8" fill={p.detail} opacity=".85" />))}</>,
  map: (p) => <><path d="M9.5 15.5l9-3.5 11 3.5 9-3.5v20.5l-9 3.5-11-3.5-9 3.5z" fill={p.fg} /><path d="M18.5 12v20.5M29.5 15.5V36" stroke={p.detail} strokeWidth="1.6" opacity=".7" /><path d="M24 30.5s-5.2-5.4-5.2-9a5.2 5.2 0 0 1 10.4 0c0 3.6-5.2 9-5.2 9z" fill={p.detail} /><circle cx="24" cy="21.4" r="2" fill={p.fg} /></>,
  trash: (p) => <><rect x="13.5" y="17" width="21" height="21.5" rx="3.5" fill={p.fg} /><rect x="11" y="12.5" width="26" height="4.6" rx="2.3" fill={p.fg} /><rect x="20" y="9.5" width="8" height="4" rx="1.8" fill={p.fg} /><path d="M19.5 22v11.5M24 22v11.5M28.5 22v11.5" {...S} stroke={p.detail} strokeWidth="2.4" /></>,
  box: (p) => <><path d="M11 17.5L24 11l13 6.5v13L24 37l-13-6.5z" fill={p.fg} /><path d="M11.5 17.8L24 24l12.5-6.2M24 24v12.6" {...S} stroke={p.detail} strokeWidth="2.6" /></>,
  blank: (p) => <><path d="M15 10h12.2l8.3 8.3V36a2.5 2.5 0 0 1-2.5 2.5H15a2.5 2.5 0 0 1-2.5-2.5V12.5A2.5 2.5 0 0 1 15 10z" fill={p.fg} /><path d="M27 10.4v6.4a1.6 1.6 0 0 0 1.6 1.6H35" {...S} stroke={p.detail} strokeWidth="2.4" /></>,
};

/** Module id → [palette, glyph]. Every id in the module registry must appear here (scripts/a11y-unit.mts). */

/**
 * Tile finishes (TT22): the palette *role* (sun, coral, …) is fixed per module; the active style maps it to colours
 * and picks the finish. Glyph contrast is checked per style by scripts/a11y-unit.mts over the exact data used here.
 */
/** TT23 Material Expressive "cookie" (12-lobe) shape, generated: r(θ) = 21.6 + 1.5·cos 12θ around (24, 23.5). */
const COOKIE = "M47.10 23.50L46.78 24.69L45.94 25.81L44.88 26.81L43.94 27.74L43.42 28.70L43.39 29.80L43.73 31.07L44.16 32.47L44.33 33.86L44.01 35.05L43.13 35.93L41.85 36.47L40.43 36.80L39.15 37.14L38.21 37.71L37.64 38.65L37.30 39.93L36.97 41.35L36.43 42.63L35.55 43.51L34.36 43.83L32.97 43.66L31.57 43.23L30.30 42.89L29.20 42.92L28.24 43.44L27.31 44.38L26.31 45.44L25.19 46.28L24.00 46.60L22.81 46.28L21.69 45.44L20.69 44.38L19.76 43.44L18.80 42.92L17.70 42.89L16.43 43.23L15.03 43.66L13.64 43.83L12.45 43.51L11.57 42.63L11.03 41.35L10.70 39.93L10.36 38.65L9.79 37.71L8.85 37.14L7.57 36.80L6.15 36.47L4.87 35.93L3.99 35.05L3.67 33.86L3.84 32.47L4.27 31.07L4.61 29.80L4.58 28.70L4.06 27.74L3.12 26.81L2.06 25.81L1.22 24.69L0.90 23.50L1.22 22.31L2.06 21.19L3.12 20.19L4.06 19.26L4.58 18.30L4.61 17.20L4.27 15.93L3.84 14.53L3.67 13.14L3.99 11.95L4.87 11.07L6.15 10.53L7.57 10.20L8.85 9.86L9.79 9.29L10.36 8.35L10.70 7.07L11.03 5.65L11.57 4.37L12.45 3.49L13.64 3.17L15.03 3.34L16.43 3.77L17.70 4.11L18.80 4.08L19.76 3.56L20.69 2.62L21.69 1.56L22.81 0.72L24.00 0.40L25.19 0.72L26.31 1.56L27.31 2.62L28.24 3.56L29.20 4.08L30.30 4.11L31.57 3.77L32.97 3.34L34.36 3.17L35.55 3.49L36.43 4.37L36.97 5.65L37.30 7.07L37.64 8.35L38.21 9.29L39.15 9.86L40.43 10.20L41.85 10.53L43.13 11.07L44.01 11.95L44.33 13.14L44.16 14.53L43.73 15.93L43.39 17.20L43.42 18.30L43.94 19.26L44.88 20.19L45.94 21.19L46.78 22.31Z";
const tileRx = (f: Finish) => (f === "flat" ? 4 : f === "acrylic" ? 7.5 : f === "mica" ? 9 : f === "alu" ? 10.5 : f === "satin" ? 11 : 14);
/** The tile body (or its drop shadow when dy > 0) in the style's shape. */
function TileShape({ finish, fill, dy = 0, opacity }: { finish: Finish; fill: string; dy?: number; opacity?: number }) {
  if (finish === "tonal") return <path d={COOKIE} fill={fill} opacity={opacity} transform={dy ? `translate(0 ${dy})` : undefined} />;
  return <rect x="1.5" y={1 + dy} width="45" height="45" rx={tileRx(finish)} fill={fill} opacity={opacity} />;
}
const SHADOW: Record<Finish, number> = { gloss: .22, sheen: .16, neon: .35, deco: .16, glass: .24, tonal: .1, mica: .16, paper: .14, lacquer: .3, flat: .08, alu: .22, satin: .2, acrylic: .1 };

function TileFinish({ finish, p, uid, trim }: { finish: Finish; p: Palette; uid: string; trim?: string }) {
  if (finish === "gloss") return <>
    <path d="M9 8.6C9 5.6 11.8 3.6 15.5 3.6h17c3.7 0 6.5 2 6.5 5 0 1.5-6.7 2.4-15 2.4S9 10.1 9 8.6z" fill={`url(#h${uid})`} />
    <circle cx="38.2" cy="9.4" r="1.9" fill="#fff" opacity=".65" />
  </>;
  if (finish === "sheen") return <>
    <path d="M15.5 1h17A14 14 0 0 1 46.5 15v1.5C34 9 20 7.5 1.5 12.5V15A14 14 0 0 1 15.5 1z" fill="#fff" opacity=".34" />
    <rect x="2.25" y="1.75" width="43.5" height="43.5" rx="13.25" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.5" />
  </>;
  if (finish === "neon") return <>
    <rect x="1.5" y="1" width="45" height="45" rx="14" fill="none" stroke={p.fg} strokeOpacity=".22" strokeWidth="3.4" />
    <rect x="2.6" y="2.1" width="42.8" height="42.8" rx="12.9" fill="none" stroke={p.fg} strokeOpacity=".9" strokeWidth="1.3" />
  </>;
  if (finish === "glass") return <>
    <path d="M8 9.2C8 5.6 11.4 3.4 15.5 3.4h17c4.1 0 7.5 2.2 7.5 5.8 0 1.6-7.2 1.8-16 1.8S8 10.8 8 9.2z" fill={`url(#h${uid})`} />
    <rect x="2.1" y="1.6" width="43.8" height="43.8" rx="13.4" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="1.2" />
    <path d="M9 42.6q15 3.2 30 0" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.4" strokeLinecap="round" />
  </>;
  if (finish === "tonal") return null;
  if (finish === "mica") return <>
    <path d="M10 1.9h28" stroke="#fff" strokeOpacity=".5" strokeWidth="1" strokeLinecap="round" />
    <rect x="1.5" y="1" width="45" height="45" rx="9" fill="none" stroke="#000" strokeOpacity=".14" strokeWidth="1" />
  </>;
  if (finish === "paper") return <rect x="2" y="1.5" width="44" height="44" rx="13.5" fill="none" stroke={trim ?? "#cfc8ba"} strokeWidth="1" />;
  if (finish === "flat") return null;
  if (finish === "alu") return <>
    <path d="M9 1.9h30" stroke="#fff" strokeOpacity=".95" strokeWidth="1.1" strokeLinecap="round" />
    <path d="M5 44.2q19 2.2 38 0" fill="none" stroke="#000" strokeOpacity=".16" strokeWidth="1.2" strokeLinecap="round" />
    <rect x="1.5" y="1" width="45" height="45" rx="10.5" fill="none" stroke={trim ?? "#9aa0a8"} strokeOpacity=".7" strokeWidth=".9" />
  </>;
  if (finish === "satin") return <>
    <path d="M10 2h28" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
    <rect x="2.1" y="1.6" width="43.8" height="43.8" rx="10.4" fill="none" stroke="#fff" strokeOpacity=".9" strokeWidth="1.1" />
    <rect x="1.5" y="1" width="45" height="45" rx="11" fill="none" stroke={trim ?? "#b9bec7"} strokeOpacity=".75" strokeWidth=".8" />
  </>;
  if (finish === "acrylic") return <>
    <rect x="1.5" y="1" width="45" height="45" rx="7.5" fill="none" stroke="#000" strokeOpacity=".1" strokeWidth="1" />
    <path d="M17 43.6h14" stroke={p.fg} strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" />
  </>;
  if (finish === "lacquer") return <>
    <path d="M6 9.5C10 4.5 17 2.6 26 2.6c7 0 12.5 1.6 16 4.6-9-1.2-22-.6-36 2.3z" fill="#fff" opacity=".2" />
    <rect x="2.3" y="1.8" width="43.4" height="43.4" rx="13.2" fill="none" stroke={p.fg} strokeOpacity=".32" strokeWidth="1" />
  </>;
  return <>
    <rect x="4.6" y="4.1" width="38.8" height="38.8" rx="10.6" fill="none" stroke={trim ?? "#c9a24a"} strokeWidth="1.1" />
    <path d="M21 4.1h6" stroke={trim ?? "#c9a24a"} strokeWidth="2.2" strokeLinecap="round" />
  </>;
}

export function Tile({ palette, glyph, size = 20, label, style, styleId: forced }: { palette: PaletteName; glyph: GlyphName; size?: number; label?: string; style?: React.CSSProperties; styleId?: StyleId }) {
  const uid = useId().replace(/:/g, "");
  const active = useStyleId();
  const styleId = forced ?? active;
  const spec = STYLES[styleId];
  const p = paletteFor(styleId, palette);
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      data-icon={glyph} data-palette={palette} data-style={styleId} focusable="false"
      style={{ width: fz(size), height: fz(size), flex: "0 0 auto", display: "inline-block", verticalAlign: "middle", ...style }}>
      <defs>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2={spec.finish === "sheen" ? ".35" : "0"} y2="1"><stop offset="0" stopColor={p.top} /><stop offset="1" stopColor={p.bottom} /></linearGradient>
        {spec.finish === "gloss" || spec.finish === "glass" ? <linearGradient id={`h${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient> : null}
      </defs>
      <TileShape finish={spec.finish} fill="#000" dy={1.5} opacity={SHADOW[spec.finish]} />
      <TileShape finish={spec.finish} fill={`url(#g${uid})`} />
      <TileFinish finish={spec.finish} p={p} uid={uid} trim={spec.trim} />
      <g transform="translate(0 .4)">{GLYPHS[glyph](p)}</g>
    </svg>
  );
}

export function AppIcon({ id, size = 20, label, style, styleId }: { id: string; size?: number; label?: string; style?: React.CSSProperties; styleId?: StyleId }) {
  const [pal, gl] = MODULE_ICONS[id] ?? ["slate", "blank"];
  return <Tile palette={pal} glyph={gl} size={size} label={label} style={style} styleId={styleId} />;
}

export function FileIcon({ name, kind = "file", size = 20 }: { name: string; kind?: "file" | "dir"; size?: number }) {
  const [pal, gl] = fileIconSpec(name, kind);
  return <Tile palette={pal} glyph={gl} size={size} />;
}

/**
 * The Fusion mark: two discs fusing into a bright lens (the "fusion"), re-coloured per style.
 *   poolside — flamingo + lemon discs on a pool-aqua tile with a ripple line
 *   vice     — neon pink + cyan on midnight with a lit rim and sunset stripes through the pink disc
 *   deco     — terracotta + sea-glass on deco navy inside a fine gold frame with a sunburst
 *   bubbly   — the TT21 glossy mark
 *   TT23: glass — frosted lens + white specular rim; tonal — on the Material "cookie" shape; mica — small-radius tile
 *   with a 1px top highlight; paper — Cloud Dancer stock with a hairline and a soft ripple; lacquer — deep teal with a
 *   Green Glow rim and a pearl sheen.
 *   TT25: flat — a plain small-radius corporate square, no effects; alu — aluminium squircle with a specular top edge.
 */
export function FusionLogo({ size = 20, label = "Fusion", styleId: forced }: { size?: number; label?: string; styleId?: StyleId }) {
  const uid = useId().replace(/:/g, "");
  const active = useStyleId();
  const styleId = forced ?? active;
  const { logo: L, finish } = STYLES[styleId];
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" focusable="false" data-icon="fusion-logo" data-style={styleId}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      style={{ width: fz(size), height: fz(size), flex: "0 0 auto", display: "inline-block", verticalAlign: "middle" }}>
      <defs>
        <linearGradient id={`t${uid}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={L.tileTop} /><stop offset="1" stopColor={L.tileBottom} /></linearGradient>
        <linearGradient id={`s${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={L.a[0]} /><stop offset="1" stopColor={L.a[1]} /></linearGradient>
        <linearGradient id={`m${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={L.b[0]} /><stop offset="1" stopColor={L.b[1]} /></linearGradient>
        <linearGradient id={`h${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".5" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <clipPath id={`c${uid}`}><circle cx="29.5" cy="28.5" r="10" /></clipPath>
        <clipPath id={`a${uid}`}><circle cx="19.5" cy="21.5" r="10" /></clipPath>
      </defs>
      <TileShape finish={finish} fill="#000" dy={1.5} opacity={.2} />
      <TileShape finish={finish} fill={`url(#t${uid})`} />
      {finish === "deco" ? <g stroke={L.ring} strokeWidth="1" opacity=".75">{[-50, -25, 0, 25, 50].map((a) => { const r = (a - 90) * Math.PI / 180; return <path key={a} d={`M24 30L${24 + Math.cos(r) * 19} ${30 + Math.sin(r) * 19}`} />; })}</g> : null}
      <circle cx="19.5" cy="21.5" r="10" fill={`url(#s${uid})`} />
      {finish === "neon" ? <g clipPath={`url(#a${uid})`} stroke={L.tileBottom} strokeWidth="1.6">{[24, 27.2, 30].map((y) => <path key={y} d={`M8 ${y}h24`} />)}</g> : null}
      <circle cx="29.5" cy="28.5" r="10" fill={`url(#m${uid})`} />
      <circle cx="19.5" cy="21.5" r="10" fill={L.lens} clipPath={`url(#c${uid})`} />
      {finish === "gloss" ? <><path d="M9 8.6C9 5.6 11.8 3.6 15.5 3.6h17c3.7 0 6.5 2 6.5 5 0 1.5-6.7 2.4-15 2.4S9 10.1 9 8.6z" fill={`url(#h${uid})`} /><circle cx="37.6" cy="12.6" r="2.6" fill="#fff" opacity=".9" /><circle cx="41" cy="18.2" r="1.5" fill="#fff" opacity=".8" /></> : null}
      {finish === "sheen" ? <><path d="M7 41.5q4.2-3 8.4 0t8.4 0 8.4 0 8.4 0" fill="none" stroke="#fff" strokeOpacity=".75" strokeWidth="1.8" strokeLinecap="round" /><circle cx="38.5" cy="10.5" r="2.4" fill="#fff" opacity=".85" /></> : null}
      {finish === "neon" ? <rect x="2.6" y="2.1" width="42.8" height="42.8" rx="12.9" fill="none" stroke={L.ring} strokeOpacity=".9" strokeWidth="1.3" /> : null}
      {finish === "deco" ? <rect x="4.6" y="4.1" width="38.8" height="38.8" rx="10.6" fill="none" stroke={L.ring} strokeWidth="1.1" /> : null}
      {finish === "glass" ? <><path d="M8 9.2C8 5.6 11.4 3.4 15.5 3.4h17c4.1 0 7.5 2.2 7.5 5.8 0 1.6-7.2 1.8-16 1.8S8 10.8 8 9.2z" fill={`url(#h${uid})`} /><rect x="2.1" y="1.6" width="43.8" height="43.8" rx="13.4" fill="none" stroke={L.ring} strokeOpacity=".75" strokeWidth="1.2" /><circle cx="15.5" cy="17" r="2.2" fill="#fff" opacity=".85" /></> : null}
      {finish === "mica" ? <><path d="M10 1.9h28" stroke="#fff" strokeOpacity=".55" strokeWidth="1" strokeLinecap="round" /><rect x="1.5" y="1" width="45" height="45" rx="9" fill="none" stroke="#000" strokeOpacity=".16" strokeWidth="1" /></> : null}
      {finish === "paper" ? <><rect x="2" y="1.5" width="44" height="44" rx="13.5" fill="none" stroke={L.ring} strokeWidth="1" /><path d="M8 40.5c3-2.6 6.4-2.6 9 0s6 2.6 9 0 6-2.6 9 0" fill="none" stroke={L.ring} strokeWidth="1.2" strokeLinecap="round" /></> : null}
      {finish === "satin" ? <><path d="M10 2h28" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" /><rect x="2.1" y="1.6" width="43.8" height="43.8" rx="10.4" fill="none" stroke="#fff" strokeOpacity=".9" strokeWidth="1.1" /><rect x="1.5" y="1" width="45" height="45" rx="11" fill="none" stroke={L.ring} strokeOpacity=".8" strokeWidth=".8" /></> : null}
      {finish === "acrylic" ? <rect x="1.5" y="1" width="45" height="45" rx="7.5" fill="none" stroke="#000" strokeOpacity=".14" strokeWidth="1" /> : null}
      {finish === "alu" ? <><path d="M9 1.9h30" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" /><rect x="1.5" y="1" width="45" height="45" rx="10.5" fill="none" stroke={L.ring} strokeOpacity=".8" strokeWidth=".9" /></> : null}
      {finish === "lacquer" ? <><path d="M6 9.5C10 4.5 17 2.6 26 2.6c7 0 12.5 1.6 16 4.6-9-1.2-22-.6-36 2.3z" fill="#fff" opacity=".2" /><rect x="2.3" y="1.8" width="43.4" height="43.4" rx="13.2" fill="none" stroke={L.ring} strokeOpacity=".8" strokeWidth="1.1" /><circle cx="37.5" cy="11" r="2.1" fill={L.ring} /></> : null}
    </svg>
  );
}

/** Small monochrome UI glyphs for chrome buttons (currentColor, so they follow theme + contrast). */
export type UiGlyphName = "search" | "overview" | "contrast" | "sliders" | "close" | "plus" | "spark" | "tileLeft" | "tileRight" | "popout" | "minimize" | "maximize" | "up" | "back" | "forward" | "chevron" | "tree" | "split" | "terminal" | "star" | "starFill" | "battery" | "timer"
  // TT114: concept glyphs for Recall and the browser chrome. Each one is a plain geometric
  // construction drawn here - a frame, a bracket, an arrow - chosen so the shape states the
  // idea without a caption, which is what let the two modules drop another third of their words.
  | "bytes" | "held" | "loaded" | "record" | "snapshot" | "queue" | "sidebar" | "tabstrip" | "splitH" | "splitV" | "tearout"
  | "verify" | "copy" | "photos" | "folder" | "trash" | "export" | "crop" | "eraser" | "undo" | "refresh" | "clipin" | "more" |
  /* TT115 browser-chrome glyphs */
  "sleep" | "shield" | "cookie" | "closeset" | "auto" | "download" |
  /* TT116: the filter row, the device row and the retention control. Each is a
     concept drawn as geometry - a funnel is narrowing, a calendar is a dated grid,
     a broom is a swept edge - so the row can lose its captions without losing its
     meaning. */
  "method" | "host" | "calendar" | "scope" | "device" | "dedupe" | "broom" | "gauge" | "session" | "link"
  /* TT117: an archive manifest (a checked list), an alarm bell, a repeating cycle and rising bars */
  | "manifest" | "alarm" | "repeat" | "stats"
  /* TT123: crossed shuffle arrows, and a wrapped line turning back on itself */
  | "shuffle" | "wrap" | "caret-up" | "caret-down";
export function UiGlyph({ name, size = 14 }: { name: UiGlyphName; size?: number }) {
  const d: Record<string, ReactNode> = {
    /* TT116 concept glyphs. Same construction rules: stroke-only, 24x24, currentColor,
       no glyph reusing another's silhouette. */
    // save method: a stamp pressed onto a line - "how this got here"
    method: <><rect x="4.5" y="4.5" width="15" height="9" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M8 9h8" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M4.5 18.5h15" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // page host: a globe reduced to one meridian and one parallel
    host: <><circle cx="12" cy="12" r="7.5" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M4.5 12h15" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M12 4.5c2.6 2.6 2.6 12.4 0 15-2.6-2.6-2.6-12.4 0-15Z" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    // a date: a grid with a torn-off header
    calendar: <><rect x="4" y="5.5" width="16" height="14" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M4 10h16" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M8.5 3.5v4M15.5 3.5v4" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M8 14h3" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // scope: brackets closing around a region
    scope: <><path d="M8.5 4.5H5.5a1 1 0 0 0-1 1v3M15.5 4.5h3a1 1 0 0 1 1 1v3M8.5 19.5H5.5a1 1 0 0 1-1-1v-3M15.5 19.5h3a1 1 0 0 0 1-1v-3" {...S} stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="12" r="2.5" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // this device: a slab with a foot
    device: <><rect x="3.5" y="5" width="17" height="11" rx="1.8" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M9 19h6" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M12 16v3" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // keep one copy: two identical squares collapsing into one
    dedupe: <><rect x="4.5" y="4.5" width="10" height="10" rx="1.8" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M9.5 19.5h8a2 2 0 0 0 2-2v-8" {...S} stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.6 2.4" /><path d="m7.5 9.5 2 2 4-4.2" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // retention: a swept edge gathering what is past
    broom: <><path d="M14.5 3.5 9 9" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="m7 11 6-6 4 4-6 6Z" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M11 15 5 21M9 13l-4 8M13 17l-4 4" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    // how full: a dial with a needle
    gauge: <><path d="M4.5 16.5a7.5 7.5 0 1 1 15 0" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="m12 16.5 4-5" {...S} stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="16.5" r="1.4" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    // a session that comes back: an arrow returning into a frame
    session: <><rect x="4" y="5.5" width="16" height="13" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M9 12h6" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="m12 9 3 3-3 3" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // an address: two links of a chain
    link: <><path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.54 3.54 0 0 0-5-5L11.5 7.5" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0L6 13a3.54 3.54 0 0 0 5 5l1.5-1.5" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // TT117 manifest: a list whose last line is a tick — a checked inventory
    manifest: <><path d="M8 5.5h11M8 10h11M8 14.5h6" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="m3.8 14 1.4 1.4L8 12.6" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="m15.5 17.5 1.8 1.8 3.5-3.8" {...S} stroke="currentColor" strokeWidth="1.8" /><circle cx="4.7" cy="5.5" r="1" fill="currentColor" /><circle cx="4.7" cy="10" r="1" fill="currentColor" /></>,
    // TT117 alarm: a bell with two short sound arcs
    alarm: <><path d="M12 4a5.5 5.5 0 0 1 5.5 5.5v3.6l1.8 3.4H4.7l1.8-3.4V9.5A5.5 5.5 0 0 1 12 4Z" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M10 19.5a2.2 2.2 0 0 0 4 0" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 4.5 5 6M20.5 4.5 19 6" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // TT117 repeat: two arrows chasing each other around a cycle
    repeat: <><path d="M5.5 9.5A7 7 0 0 1 18 6.2M18.5 14.5A7 7 0 0 1 6 17.8" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M18.4 3.4v3.4h-3.4M5.6 20.6v-3.4h3.4" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // TT123 shuffle: two arrows crossing over each other, each landing opposite
    shuffle: <><path d="M4 7c4 0 6.5 10 11 10h5M4 17c3 0 5-4 7.5-6.8M18.5 9.2C16.8 7 15.2 7 13.5 7H9" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M17.2 4.2 20.2 7l-3 2.8M17.2 14.2l3 2.8-3 2.8" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // TT123 carets: a chevron stepping away from its baseline — match stepping
    "caret-up": <><path d="M6 14.5 12 8.5l6 6" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M6 18.5h12" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    "caret-down": <><path d="M6 9.5 12 15.5l6-6" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M6 5.5h12" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    // TT123 wrap: a line that reaches the edge and turns back, arrow pointing home
    wrap: <><path d="M20 6H7a3 3 0 0 0-3 3v1" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M20 11H9a3 3 0 0 0-3 3v1" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M9.5 17.8 6 20.5l-1-3.6" {...S} stroke="currentColor" strokeWidth="1.8" transform="rotate(90 6.8 18.6)" /></>,
    // TT117 stats: three rising columns on a baseline
    stats: <><path d="M4 20h16" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M7 20v-5M12 20V9M17 20v-8" {...S} stroke="currentColor" strokeWidth="2.4" /></>,
    /* TT114 concept glyphs. Stroke-only, 24x24, currentColor, so they inherit theme and contrast. */
    // verify a receipt: a seal with a tick inside it
    verify: <><path d="M12 3.5 19 6v6.2c0 3.9-2.7 7.1-7 8.3-4.3-1.2-7-4.4-7-8.3V6l7-2.5Z" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="m8.8 12.2 2.2 2.2 4.2-4.6" {...S} stroke="currentColor" strokeWidth="2" /></>,
    // copy: one sheet lifted off another
    copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M15.5 5.5H6a1.5 1.5 0 0 0-1.5 1.5v9.5" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // photos: a framed picture with a horizon and a sun
    photos: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><circle cx="8.6" cy="10" r="1.6" fill="currentColor" /><path d="M4.5 16.5 9.5 12l3.2 2.8L16 11.5l4 4.2" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // folder
    folder: <><path d="M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h7.5A1.5 1.5 0 0 1 20 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // trash
    trash: <><path d="M5.5 7h13M10 7V5.2h4V7M7 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h5.2a1.5 1.5 0 0 0 1.5-1.4L17 7" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M10.5 11v6M13.5 11v6" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    // export: out of a tray, upwards
    export: <><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M12 15.5v-11m0 0-3.4 3.4M12 4.5l3.4 3.4" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    // crop: the photographer's two overlapping rules
    crop: <><path d="M7.5 3v13.5H21M3 7.5h13.5V21" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    // eraser: a block sweeping a line clean
    eraser: <><path d="m9.5 19.5-4.6-4.6a1.6 1.6 0 0 1 0-2.3l7.3-7.3a1.6 1.6 0 0 1 2.3 0l4.6 4.6a1.6 1.6 0 0 1 0 2.3l-7.3 7.3Z" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M5 20h14" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // undo: a path turning back on itself
    undo: <><path d="M4.5 9.5h9.3a5.2 5.2 0 0 1 0 10.4H8" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M8 5 4 9.5 8 14" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    // refresh: a loop that closes
    refresh: <><path d="M19.2 11a7.2 7.2 0 1 0-1.6 5.4" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M19.6 5.6V11h-5.4" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    // from the clipboard: a board with something dropping into it
    clipin: <><path d="M9 5.5H7A1.5 1.5 0 0 0 5.5 7v12A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V7A1.5 1.5 0 0 0 17 5.5h-2" {...S} stroke="currentColor" strokeWidth="1.8" /><rect x="9" y="3.5" width="6" height="3.4" rx="1.1" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M12 10.5v5m0 0 2-2m-2 2-2-2" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // more: the next page of a list
    sleep: <><path d="M20 14.5A7.5 7.5 0 0 1 9.5 4a7.5 7.5 0 1 0 10.5 10.5Z" /><path d="M15 3h4l-4 4h4" /></>,
    shield: <><path d="M12 3l7 3v5c0 4.2-2.8 7.6-7 9-4.2-1.4-7-4.8-7-9V6Z" /><path d="M9 12l2.2 2.2L15.5 10" /></>,
    cookie: <><circle cx="12" cy="12" r="8.5" /><circle cx="9.5" cy="9.5" r="1.1" /><circle cx="14.5" cy="11" r="1.1" /><circle cx="11" cy="15" r="1.1" /></>,
    closeset: <><rect x="3.5" y="6.5" width="10" height="11" rx="1.6" /><path d="M7 10.5l3.5 3.5M10.5 10.5L7 14" /><path d="M16.5 5.5h4v13h-4" /></>,
    auto: <><circle cx="12" cy="12" r="3.2" /><path d="M12 4.5v2.2M12 17.3v2.2M4.5 12h2.2M17.3 12h2.2M6.7 6.7l1.6 1.6M15.7 15.7l1.6 1.6M17.3 6.7l-1.6 1.6M8.3 15.7l-1.6 1.6" /></>,
    download: <><path d="M12 4v10" /><path d="M8.2 10.4L12 14.2l3.8-3.8" /><path d="M5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-2" /></>,
    more: <><path d="M4.5 7h15M4.5 12h15" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M8.6 16.4 12 19.8l3.4-3.4" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    // original bytes: a file with an arrow arriving into it from the wire above
    bytes: <><path d="M7 21h10a1.5 1.5 0 0 0 1.5-1.5V9L13 3.5H7A1.5 1.5 0 0 0 5.5 5v14.5A1.5 1.5 0 0 0 7 21Z" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M13 3.5V9h5.5" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M12 11.5v5m0 0 2-2m-2 2-2-2" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    // held by this page: two brackets closed around a solid object
    held: <><path d="M8 4.5H5.5v15H8M16 4.5h2.5v15H16" {...S} stroke="currentColor" strokeWidth="1.9" /><rect x="9.5" y="9.5" width="5" height="5" rx="1.2" fill="currentColor" /></>,
    // loaded by this page: a stack that has finished arriving
    loaded: <><path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h8" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M14.5 17.5l2 2 3.5-4" {...S} stroke="currentColor" strokeWidth="2" /></>,
    // live recording: the universal ring and dot, drawn rather than borrowed
    record: <><circle cx="12" cy="12" r="8" {...S} stroke="currentColor" strokeWidth="1.9" /><circle cx="12" cy="12" r="3.6" fill="currentColor" /></>,
    // snapshot: a viewfinder's four corners around a single pixel
    snapshot: <><path d="M4.5 9V5.5H8M16 5.5h3.5V9M19.5 15v3.5H16M8 18.5H4.5V15" {...S} stroke="currentColor" strokeWidth="1.9" /><rect x="10.5" y="10.5" width="3" height="3" rx="0.8" fill="currentColor" /></>,
    // queue: items waiting, shortest last, with the next one marked
    queue: <><path d="M8 6.5h11M8 12h11M8 17.5h7" {...S} stroke="currentColor" strokeWidth="1.9" /><circle cx="4.6" cy="6.5" r="1.5" fill="currentColor" /><circle cx="4.6" cy="12" r="1.5" fill="currentColor" opacity=".55" /><circle cx="4.6" cy="17.5" r="1.5" fill="currentColor" opacity=".3" /></>,
    // tab sidebar: a pane with its list down the left
    sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M9 4.5v15" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M5.6 8.5h1.8M5.6 12h1.8M5.6 15.5h1.8" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    // tab strip: the same pane with its list along the top
    tabstrip: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 9.5h17" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M6.5 6.2v1.6M10.5 6.2v1.6M14.5 6.2v1.6" {...S} stroke="currentColor" strokeWidth="1.6" /></>,
    // split side by side
    splitH: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M12 4.5v15" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // split stacked
    splitV: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 12h17" {...S} stroke="currentColor" strokeWidth="1.8" /></>,
    // tear out: a pane, and one thing leaving it
    tearout: <><path d="M13.5 4.5H5.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-8" {...S} stroke="currentColor" strokeWidth="1.8" /><path d="M13.5 10.5 20 4m0 0h-4.6M20 4v4.6" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6" {...S} stroke="currentColor" strokeWidth="2.4" /><path d="M15 15l5 5" {...S} stroke="currentColor" strokeWidth="2.8" /></>,
    overview: <><rect x="3.5" y="4" width="7.5" height="7" rx="2" fill="currentColor" /><rect x="13" y="4" width="7.5" height="7" rx="2" fill="currentColor" opacity=".7" /><rect x="3.5" y="13" width="7.5" height="7" rx="2" fill="currentColor" opacity=".7" /><rect x="13" y="13" width="7.5" height="7" rx="2" fill="currentColor" /></>,
    contrast: <><circle cx="12" cy="12" r="8" {...S} stroke="currentColor" strokeWidth="2.2" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>,
    sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" {...S} stroke="currentColor" strokeWidth="2.2" /><circle cx="15" cy="7" r="2.4" {...S} stroke="currentColor" strokeWidth="2.2" /><circle cx="9" cy="17" r="2.4" {...S} stroke="currentColor" strokeWidth="2.2" /></>,
    close: <path d="M6 6l12 12M18 6L6 18" {...S} stroke="currentColor" strokeWidth="2.6" />,
    plus: <path d="M12 5v14M5 12h14" {...S} stroke="currentColor" strokeWidth="2.6" />,
    spark: <path d="M12 3l2.2 6.3L21 12l-6.8 2.7L12 21l-2.2-6.3L3 12l6.8-2.7z" fill="currentColor" />,
    tileLeft: <><rect x="4" y="5" width="16" height="14" rx="3" {...S} stroke="currentColor" strokeWidth="2.2" /><rect x="5.5" y="6.5" width="6" height="11" rx="1.4" fill="currentColor" /></>,
    tileRight: <><rect x="4" y="5" width="16" height="14" rx="3" {...S} stroke="currentColor" strokeWidth="2.2" /><rect x="12.5" y="6.5" width="6" height="11" rx="1.4" fill="currentColor" /></>,
    popout: <><path d="M13 5h6v6M19 5l-8 8" {...S} stroke="currentColor" strokeWidth="2.4" /><path d="M17 14v3.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 17.5v-9A1.5 1.5 0 0 1 6.5 7H10" {...S} stroke="currentColor" strokeWidth="2.2" /></>,
    minimize: <path d="M6 12.5h12" {...S} stroke="currentColor" strokeWidth="3" />,
    maximize: <rect x="6" y="6" width="12" height="12" rx="3" {...S} stroke="currentColor" strokeWidth="2.6" />,
    up: <path d="M12 19V6M6 11.5L12 5.5l6 6" {...S} stroke="currentColor" strokeWidth="2.6" />,
    back: <path d="M19 12H6M11.5 6L5.5 12l6 6" {...S} stroke="currentColor" strokeWidth="2.6" />,
    forward: <path d="M5 12h13M12.5 6l6 6-6 6" {...S} stroke="currentColor" strokeWidth="2.6" />,
    chevron: <path d="M9.5 6l6 6-6 6" {...S} stroke="currentColor" strokeWidth="2.6" />,
    tree: <><path d="M6 4v14h5M6 9h5" {...S} stroke="currentColor" strokeWidth="2.2" /><rect x="12" y="6.5" width="8" height="5" rx="1.5" fill="currentColor" /><rect x="12" y="15.5" width="8" height="5" rx="1.5" fill="currentColor" opacity=".7" /></>,
    split: <><rect x="3.5" y="5" width="17" height="14" rx="3" {...S} stroke="currentColor" strokeWidth="2.2" /><path d="M12 5v14" {...S} stroke="currentColor" strokeWidth="2.2" /></>,
    star: <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" {...S} stroke="currentColor" strokeWidth="1.9" />,
    starFill: <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor" />,
    battery: <><rect x="3" y="8" width="15" height="8" rx="2" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M21 11v2" {...S} stroke="currentColor" strokeWidth="1.9" /><rect x="5.5" y="10.5" width="6" height="3" rx="1" fill="currentColor" /></>,
    timer: <><circle cx="12" cy="13" r="7" {...S} stroke="currentColor" strokeWidth="1.9" /><path d="M12 9.5V13l2.5 1.5M9.5 3.5h5" {...S} stroke="currentColor" strokeWidth="1.9" /></>,
    terminal: <><rect x="3.5" y="5" width="17" height="14" rx="3" {...S} stroke="currentColor" strokeWidth="2.2" /><path d="M7.5 10l3 2.5-3 2.5M12.5 15.5h4" {...S} stroke="currentColor" strokeWidth="2.2" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ width: fz(size), height: fz(size), flex: "0 0 auto", display: "inline-block", verticalAlign: "middle" }}>{d[name]}</svg>;
}
