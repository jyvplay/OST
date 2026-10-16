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
  easel: (p) => <><rect x="10" y="10.5" width="28" height="20" rx="3.6" fill={p.fg} /><path d="M19.5 37.5l3-7M28.5 37.5l-3-7" {...S} stroke={p.fg} strokeWidth="3.2" /><rect x="15" y="21" width="4.4" height="6" rx="1.2" fill={p.detail} /><rect x="21.8" y="17" width="4.4" height="10" rx="1.2" fill={p.detail} /><rect x="28.6" y="14" width="4.4" height="13" rx="1.2" fill={p.detail} /></>,
  // TT22 Tables: a record table — header band with a record dot, row rules, and a narrow first column
  table: (p) => <><rect x="9.5" y="11.5" width="29" height="25" rx="4.5" fill={p.fg} /><path d="M9.5 19h29M9.5 25.6h29M9.5 31.6h29M16.5 19v17.5" stroke={p.detail} strokeWidth="2.4" /><circle cx="13" cy="15.3" r="1.9" fill={p.detail} /><path d="M19.5 15.3h14" stroke={p.detail} strokeWidth="2.4" strokeLinecap="round" /></>,
  grid: (p) => <><rect x="10.5" y="11.5" width="27" height="25" rx="4.5" fill={p.fg} /><path d="M10.5 19.6h27M10.5 28h27M19.5 11.5v25M28.5 19.6v16.9" stroke={p.detail} strokeWidth="2.6" /></>,
  eye: (p) => <><path d="M8.5 24c4.2-7.3 9.3-10.8 15.5-10.8S35.3 16.7 39.5 24c-4.2 7.3-9.3 10.8-15.5 10.8S12.7 31.3 8.5 24z" fill={p.fg} /><circle cx="24" cy="24" r="6.2" fill={p.detail} /><circle cx="24" cy="24" r="2.6" fill={p.fg} /></>,
  braces: (p) => <path d="M19 12.5c-3 0-4 1.5-4 4v3.5c0 2-1 3.5-3 4 2 .5 3 2 3 4V31.5c0 2.5 1 4 4 4M29 12.5c3 0 4 1.5 4 4v3.5c0 2 1 3.5 3 4-2 .5-3 2-3 4V31.5c0 2.5-1 4-4 4" {...S} stroke={p.fg} strokeWidth="3.6" />,
  music: (p) => <><path d="M20 32V15.5l14-3v16" {...S} stroke={p.fg} strokeWidth="3.4" /><circle cx="16.5" cy="32" r="4.2" fill={p.fg} /><circle cx="30.5" cy="28.5" r="4.2" fill={p.fg} /></>,
  box: (p) => <><path d="M11 17.5L24 11l13 6.5v13L24 37l-13-6.5z" fill={p.fg} /><path d="M11.5 17.8L24 24l12.5-6.2M24 24v12.6" {...S} stroke={p.detail} strokeWidth="2.6" /></>,
  blank: (p) => <><path d="M15 10h12.2l8.3 8.3V36a2.5 2.5 0 0 1-2.5 2.5H15a2.5 2.5 0 0 1-2.5-2.5V12.5A2.5 2.5 0 0 1 15 10z" fill={p.fg} /><path d="M27 10.4v6.4a1.6 1.6 0 0 0 1.6 1.6H35" {...S} stroke={p.detail} strokeWidth="2.4" /></>,
};

/** Module id → [palette, glyph]. Every id in the module registry must appear here (scripts/a11y-unit.mts). */

/**
 * Tile finishes (TT22): the palette *role* (sun, coral, …) is fixed per module; the active style maps it to colours
 * and picks the finish. Glyph contrast is checked per style by scripts/a11y-unit.mts over the exact data used here.
 */
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
        {spec.finish === "gloss" ? <linearGradient id={`h${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient> : null}
      </defs>
      <rect x="1.5" y="2.5" width="45" height="45" rx="14" fill="#000" opacity={spec.finish === "neon" ? ".35" : spec.finish === "gloss" ? ".22" : ".16"} />
      <rect x="1.5" y="1" width="45" height="45" rx="14" fill={`url(#g${uid})`} />
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
      <rect x="1.5" y="2.5" width="45" height="45" rx="14" fill="#000" opacity=".2" />
      <rect x="1.5" y="1" width="45" height="45" rx="14" fill={`url(#t${uid})`} />
      {finish === "deco" ? <g stroke={L.ring} strokeWidth="1" opacity=".75">{[-50, -25, 0, 25, 50].map((a) => { const r = (a - 90) * Math.PI / 180; return <path key={a} d={`M24 30L${24 + Math.cos(r) * 19} ${30 + Math.sin(r) * 19}`} />; })}</g> : null}
      <circle cx="19.5" cy="21.5" r="10" fill={`url(#s${uid})`} />
      {finish === "neon" ? <g clipPath={`url(#a${uid})`} stroke={L.tileBottom} strokeWidth="1.6">{[24, 27.2, 30].map((y) => <path key={y} d={`M8 ${y}h24`} />)}</g> : null}
      <circle cx="29.5" cy="28.5" r="10" fill={`url(#m${uid})`} />
      <circle cx="19.5" cy="21.5" r="10" fill={L.lens} clipPath={`url(#c${uid})`} />
      {finish === "gloss" ? <><path d="M9 8.6C9 5.6 11.8 3.6 15.5 3.6h17c3.7 0 6.5 2 6.5 5 0 1.5-6.7 2.4-15 2.4S9 10.1 9 8.6z" fill={`url(#h${uid})`} /><circle cx="37.6" cy="12.6" r="2.6" fill="#fff" opacity=".9" /><circle cx="41" cy="18.2" r="1.5" fill="#fff" opacity=".8" /></> : null}
      {finish === "sheen" ? <><path d="M7 41.5q4.2-3 8.4 0t8.4 0 8.4 0 8.4 0" fill="none" stroke="#fff" strokeOpacity=".75" strokeWidth="1.8" strokeLinecap="round" /><circle cx="38.5" cy="10.5" r="2.4" fill="#fff" opacity=".85" /></> : null}
      {finish === "neon" ? <rect x="2.6" y="2.1" width="42.8" height="42.8" rx="12.9" fill="none" stroke={L.ring} strokeOpacity=".9" strokeWidth="1.3" /> : null}
      {finish === "deco" ? <rect x="4.6" y="4.1" width="38.8" height="38.8" rx="10.6" fill="none" stroke={L.ring} strokeWidth="1.1" /> : null}
    </svg>
  );
}

/** Small monochrome UI glyphs for chrome buttons (currentColor, so they follow theme + contrast). */
export type UiGlyphName = "search" | "overview" | "contrast" | "sliders" | "close" | "plus" | "spark" | "tileLeft" | "tileRight" | "popout" | "minimize" | "maximize" | "up";
export function UiGlyph({ name, size = 14 }: { name: UiGlyphName; size?: number }) {
  const d: Record<string, ReactNode> = {
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
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ width: fz(size), height: fz(size), flex: "0 0 auto", display: "inline-block", verticalAlign: "middle" }}>{d[name]}</svg>;
}
