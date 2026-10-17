import { isWallpaper, WALLPAPERS } from "./appearance";
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN } from "./uiscale-core";
import { STYLE_IDS } from "./style-core";
import { validTileUrl } from "./maps-core";
import { LAYOUT_IDS, DOCK_SIZE_IDS } from "./layout-core";

/**
 * TT21: value validation for settings whose bad values would break the shell for everyone on the host
 * (an empty text scale renders nothing, a typo'd theme drops every token). Unknown keys keep free-form values.
 * Returns null when valid, otherwise a human-readable reason.
 */
const ENUMS: Record<string, readonly string[]> = {
  "appearance.theme": ["dark", "light"],
  "appearance.density": ["compact", "balanced", "touch"],
  "appearance.motion": ["system", "on", "off"],
  "appearance.wallpaper": WALLPAPERS.map((w) => w.id),
  "appearance.style": STYLE_IDS,
  // TT25: main-UI layout (fusion = original hybrid, business = Windows-style taskbar, art = Mac-style menu bar + dock)
  "appearance.layout": LAYOUT_IDS,
  "appearance.dockMagnify": ["on", "off"],
  "appearance.pairStyle": ["on", "off"],
  "media.embeds": ["ask", "allow"],
  "maps.tiles": ["off", "osm", "custom"],
  "appearance.dockSize": DOCK_SIZE_IDS,
  "appearance.desktopView": ["classic", "tabletop"],
};

export function validateSetting(key: string, value: string): string | null {
  if (key === "appearance.textScale") {
    if (!/^\d{2,3}$/.test(value)) return `text size must be a whole percentage (${TEXT_SCALE_MIN}–${TEXT_SCALE_MAX})`;
    const n = Number(value);
    if (n < TEXT_SCALE_MIN || n > TEXT_SCALE_MAX) return `text size must be between ${TEXT_SCALE_MIN} and ${TEXT_SCALE_MAX} %`;
    return null;
  }
  if (key === "maps.tileUrl" && value !== "" && !validTileUrl(value)) return "tile URL must be https:// and contain {z}, {x} and {y}";
  if (key === "appearance.wallpaper" && !isWallpaper(value)) return `wallpaper must be one of ${ENUMS[key].join(", ")}`;
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(value)) return `${key} must be one of ${allowed.join(", ")}`;
  if (key === "appearance.accent" && value !== "auto" && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return "accent must be \"auto\" or a #rgb / #rrggbb colour";
  return null;
}
