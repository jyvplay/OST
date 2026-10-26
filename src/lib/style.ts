/**
 * TT22 — client side of the style system (see style-core.ts). The active style lives on <html data-style="…">,
 * set from the setting `appearance.style`; icons read it through useStyleId() so a style switch re-colours every
 * icon without reloading. Server rendering uses the default style, which the root layout also puts on <html>, so
 * the first paint and hydration agree.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_STYLE, isStyle, type StyleId } from "./style-core";
export { STYLES, STYLE_IDS, DEFAULT_STYLE, isStyle, paletteFor, resolveWallpaper, type StyleId } from "./style-core";

export const STYLE_EVENT = "fs-style";

export function applyStyle(id: unknown): StyleId {
  const style: StyleId = isStyle(id) ? id : DEFAULT_STYLE;
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (root.dataset.style !== style) {
      root.dataset.style = style;
      window.dispatchEvent(new Event(STYLE_EVENT));
    }
  }
  return style;
}

const read = (): StyleId => {
  const v = typeof document === "undefined" ? undefined : document.documentElement.dataset.style;
  return isStyle(v) ? v : DEFAULT_STYLE;
};
const subscribe = (cb: () => void) => {
  window.addEventListener(STYLE_EVENT, cb);
  return () => window.removeEventListener(STYLE_EVENT, cb);
};
const server = (): StyleId => DEFAULT_STYLE;

export function useStyleId(): StyleId {
  return useSyncExternalStore(subscribe, read, server);
}
