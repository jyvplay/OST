/**
 * TT139 (CG-01) — colour engine: conversion, contrast, colour-vision simulation.
 *
 * The shell's theme system, the Lens colour picker, Photos' adjustment panel and
 * the accessibility gate all need the same arithmetic. Doing it in four places
 * is how a palette passes one check and fails another, so it lives here once.
 *
 * Everything is sRGB (IEC 61966-2-1) with the standard D65 white point. The
 * functions say which space they operate in, because "brightness" that silently
 * means HSL lightness is the most common source of "why is my text unreadable".
 *
 * Colour-vision deficiency simulation uses the Brettel/Viénot LMS linear
 * approximation with an explicit severity, and is *labelled as a simulation*:
 * it models dichromacy/anomaly in one standard observer, not the vision of any
 * particular person.
 */

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function normaliseHex(input: string): string | null {
  const s = String(input ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(s)) return `#${s.slice(0, 6).toLowerCase()}`; // drop alpha, reported by caller
  return null;
}

export function hexToRgb(hex: string): RGB {
  const n = normaliseHex(hex);
  if (!n) throw new Error(`colour: "${hex}" is not a hex colour`);
  return { r: parseInt(n.slice(1, 3), 16), g: parseInt(n.slice(3, 5), 16), b: parseInt(n.slice(5, 7), 16) };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** HSL with h∈[0,360), s/l∈[0,1]. */
export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h: h % 360, s, l };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hh = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: Math.round(hue(hh + 1 / 3) * 255), g: Math.round(hue(hh) * 255), b: Math.round(hue(hh - 1 / 3) * 255) };
}

/** Exact sRGB transfer function (IEC 61966-2-1), not the 2.2 power approximation. */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(s) * 255);
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(c: RGB): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG contrast ratio, always ≥ 1. Order does not matter. */
export function contrastRatio(a: RGB | string, b: RGB | string): number {
  const ca = typeof a === "string" ? hexToRgb(a) : a;
  const cb = typeof b === "string" ? hexToRgb(b) : b;
  const la = relativeLuminance(ca), lb = relativeLuminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastLevel = "fail" | "AA-large" | "AA" | "AAA";

/** Classify against WCAG 2.1 SC 1.4.3 and 1.4.6 for normal and large text. */
export function contrastLevel(ratio: number, largeText = false): ContrastLevel {
  if (largeText) {
    if (ratio >= 4.5) return "AAA";
    if (ratio >= 3) return "AA";
    return "fail";
  }
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA-large";
  return "fail";
}

/** CIE L*a*b* (D65) — for perceptual ΔE, not for display. */
export function rgbToLab(c: RGB): { L: number; a: number; b: number } {
  const r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x), fy = f(y), fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 ΔE — cheap, adequate for "are these two swatches distinguishable". */
export function deltaE76(a: RGB, b: RGB): number {
  const la = rgbToLab(a), lb = rgbToLab(b);
  return Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
}

export type VisionType = "protanopia" | "deuteranopia" | "tritanopia" | "protanomaly" | "deuteranomaly" | "tritanomaly" | "achromatopsia";

/**
 * Simulate a colour-vision deficiency at a given severity (0 = normal vision,
 * 1 = full dichromacy). Uses the Brettel–Viénot LMS projection for dichromats
 * and interpolates toward it for anomalies, in linear-light RGB.
 */
export function simulateVision(c: RGB, type: VisionType, severity = 1): RGB {
  const t = clamp01(severity);
  if (t === 0) return c;
  const lin = { r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b) };
  // linear sRGB → Hunt-Pointer-Estevez LMS (Viénot 1999 matrices)
  const L = 17.8824 * lin.r + 43.5161 * lin.g + 4.11935 * lin.b;
  const M = 3.45565 * lin.r + 27.1554 * lin.g + 3.86714 * lin.b;
  const S = 0.0299566 * lin.r + 0.184309 * lin.g + 1.46709 * lin.b;
  let L2 = L, M2 = M, S2 = S;
  // Which cone is *missing* decides which linear combination replaces it. Each
  // projection holds the two healthy cones fixed: replacing a healthy cone with
  // a combination of all three (an easy transcription slip) is not a projection
  // of colour space onto the dichromat's plane, and it wrecks neutral greys: a
  // grey of 128 came out as {r: 0, g: 153, b: 129} before this was fixed.
  switch (type) {
    case "protanopia": case "protanomaly": L2 = 2.02344 * M - 2.52581 * S; break;
    case "deuteranopia": case "deuteranomaly": M2 = 0.494207 * L + 1.24827 * S; break;
    case "tritanopia": case "tritanomaly": S2 = -0.395913 * L + 0.801109 * M; break;
    case "achromatopsia": { const y = 0.2126 * lin.r + 0.7152 * lin.g + 0.0722 * lin.b; return { r: linearToSrgb(y), g: linearToSrgb(y), b: linearToSrgb(y) }; }
  }
  const blend = (orig: number, simulated: number) => orig + (simulated - orig) * t;
  L2 = blend(L, L2); M2 = blend(M, M2); S2 = blend(S, S2);
  const r = 0.0809444479 * L2 - 0.130504409 * M2 + 0.116721066 * S2;
  const g = -0.0102485335 * L2 + 0.0540193266 * M2 - 0.113614708 * S2;
  const b = -0.000365296938 * L2 - 0.00412161469 * M2 + 0.693511405 * S2;
  return { r: linearToSrgb(clamp01(r)), g: linearToSrgb(clamp01(g)), b: linearToSrgb(clamp01(b)) };
}

/**
 * Pick the foreground that maximises contrast against `bg`, preferring the
 * supplied candidates in order when they tie. Used by the theme resolver so a
 * generated palette cannot ship unreadable labels.
 */
export function bestForeground(bg: RGB | string, candidates: string[], minRatio = 4.5): { hex: string; ratio: number; metMinimum: boolean } {
  const background = typeof bg === "string" ? hexToRgb(bg) : bg;
  let best = { hex: candidates[0] ?? "#000000", ratio: 0 };
  for (const c of candidates) {
    const r = contrastRatio(background, c);
    if (r > best.ratio) best = { hex: c, ratio: r };
    if (r >= minRatio && best.ratio >= minRatio) break;
  }
  return { ...best, metMinimum: best.ratio >= minRatio };
}

/** Named palette generation for themes: analogous, monochrome-safe by construction. */
export function generateHarmony(seed: string, kind: "complement" | "triad" | "analogous" | "split", count = 5): string[] {
  const base = rgbToHsl(hexToRgb(seed));
  const offsets: Record<typeof kind, number[]> = {
    complement: [0, 180], triad: [0, 120, 240], analogous: [-30, 0, 30, 60], split: [0, 150, 210, 180],
  };
  const picks = offsets[kind];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const off = picks[i % picks.length];
    const cycle = Math.floor(i / picks.length);
    const l = Math.min(0.92, Math.max(0.08, base.l + (cycle % 2 === 0 ? 0.1 : -0.1) * (cycle + 1) * 0.5));
    out.push(rgbToHex(hslToRgb({ h: base.h + off, s: base.s, l })));
  }
  return out;
}

/** Parse the CSS colour syntaxes users actually paste, without a DOM. */
export function parseCssColor(input: string): { rgb: RGB; alpha: number } | null {
  const s = String(input ?? "").trim().toLowerCase();
  const hex = normaliseHex(s);
  if (hex) return { rgb: hexToRgb(hex), alpha: /^#[0-9a-f]{8}$/i.test(s.trim()) ? parseInt(s.trim().slice(7), 16) / 255 : 1 };
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (rgb) {
    const chan = (v: string) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v));
    const alphaRaw = rgb[4];
    return {
      rgb: { r: Math.round(chan(rgb[1])), g: Math.round(chan(rgb[2])), b: Math.round(chan(rgb[3])) },
      alpha: alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw),
    };
  }
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg|grad|rad|turn)?\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s);
  if (hsl) {
    const alphaRaw = hsl[4];
    return {
      rgb: hslToRgb({ h: parseFloat(hsl[1]), s: parseFloat(hsl[2]) / 100, l: parseFloat(hsl[3]) / 100 }),
      alpha: alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw),
    };
  }
  return null;
}

/** Composite a translucent foreground over an opaque background (CSS 'over'). */
export function compositeOver(fg: RGB, alpha: number, bg: RGB): RGB {
  const a = clamp01(alpha);
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
}

/** Perceptual distance in ΔE, used to reject near-duplicate palette entries. */
export function isDistinct(a: string, b: string, threshold = 5): boolean {
  return deltaE76(hexToRgb(a), hexToRgb(b)) >= threshold;
}
