/**
 * TT21 — one text-size knob for the whole shell (WCAG 2.1 SC 1.4.4 "Resize text" + the user's request: default
 * text and logos twice the TT20 size).
 *
 *   --fs-ts   unitless text scale, 1.25 by default (TT22; 2 = "Large text mode"), set from the setting
 *             `appearance.textScale` (percent: 100…300).
 *   --fs-u    one "design pixel" = --fs-ts × 1rem / 16. Because it is rem-based, a user who raises the browser's
 *             default font size (16 → 20 px) gets proportionally larger text too (relative units, not absolute px).
 *
 * Every inline font size in the app is written as fz(<TT20 px size>) → calc(N * var(--fs-u)). JS geometry that must
 * agree with text (spreadsheet row height, column widths) reads the same number through useUiUnit().
 */
import { useSyncExternalStore } from "react";
import { clampTextScale, DEFAULT_TEXT_SCALE } from "./uiscale-core";
export { DEFAULT_TEXT_SCALE, LARGE_TEXT_SCALE, isLargeText, TEXT_SCALE_MIN, TEXT_SCALE_MAX, TEXT_SCALE_STEPS, clampTextScale, stepTextScale } from "./uiscale-core";

export const UI_SCALE_EVENT = "fs-uiscale";

/** CSS length for a TT20 pixel size, scaled by the current text size. */
export const fz = (px: number) => `calc(${px} * var(--fs-u))`;


/** Apply a text scale (percent) to the document; returns the unitless factor. */
export function applyTextScale(percent: unknown): number {
  const ts = clampTextScale(percent) / 100;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (root.style.getPropertyValue("--fs-ts") !== String(ts)) {
      root.style.setProperty("--fs-ts", String(ts));
      window.dispatchEvent(new Event(UI_SCALE_EVENT));
    }
  }
  return ts;
}

/** Pixels per design pixel right now (text scale × root font size / 16). */
export function readUiUnit(): number {
  if (typeof window === "undefined") return DEFAULT_TEXT_SCALE / 100;
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const ts = parseFloat(cs.getPropertyValue("--fs-ts")) || DEFAULT_TEXT_SCALE / 100;
  const rootPx = parseFloat(cs.fontSize) || 16;
  return Math.round(ts * (rootPx / 16) * 1000) / 1000;
}

const subscribe = (cb: () => void) => {
  window.addEventListener(UI_SCALE_EVENT, cb);
  window.addEventListener("resize", cb);
  return () => { window.removeEventListener(UI_SCALE_EVENT, cb); window.removeEventListener("resize", cb); };
};
const serverUnit = () => DEFAULT_TEXT_SCALE / 100;

/** React hook: the current design-pixel size (e.g. 1.25 at the default 125 %). */
export function useUiUnit(): number {
  return useSyncExternalStore(subscribe, readUiUnit, serverUnit);
}

