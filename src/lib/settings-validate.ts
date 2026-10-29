import { parseRules } from "./focus-rules";
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
  // TT110 (RC-36): a policy switch that really disables the capture pathways, enforced server-side.
  "privacy.screenCapture": ["on", "off"],
  // TT111 (RC-37): keep media the in-app browser loads in memory, so it can be saved without a refetch.
  "privacy.recallMediaTap": ["on", "off"],
  "appearance.theme": ["dark", "light", "system"],
  "appearance.density": ["compact", "balanced", "touch"],
  "appearance.motion": ["system", "on", "off"],
  "appearance.wallpaper": WALLPAPERS.map((w) => w.id),
  "appearance.style": STYLE_IDS,
  // TT25: main-UI layout (fusion = original hybrid, business = Windows-style taskbar, art = Mac-style menu bar + dock)
  "appearance.layout": LAYOUT_IDS,
  "appearance.dockMagnify": ["on", "off"],
  "appearance.dockAutoHide": ["on", "off"],
  "appearance.pairStyle": ["on", "off"],
  "media.embeds": ["ask", "allow"],
  "maps.tiles": ["off", "osm", "custom"],
  "appearance.dockSize": DOCK_SIZE_IDS,
  "appearance.desktopView": ["classic", "tabletop"],
  // TT30 (AX-14): the built-in screen reader
  "accessibility.narrator": ["on", "off"],
  "accessibility.narratorRate": ["0.75", "1", "1.25", "1.5", "2"],
  "accessibility.narratorCaptions": ["on", "off"],
  "accessibility.narratorSpeech": ["on", "off"],
  "accessibility.narratorVoice": ["auto", "system", "fusion"],
  "accessibility.fusionVoice": ["standard", "bright", "high"],
};

export function validateSetting(key: string, value: string): string | null {
  // TT71 NC-02: focus rules are validated in full (the server evaluates them for every alert)
  if (key === "alerts.focusRules") { const r = parseRules(value); return "error" in r ? r.error : null; }
  if (key === "alerts.timeZone" && value !== "") {
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value) && value !== "UTC") return "time zone must be an IANA name such as America/New_York";
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); } catch { return `unknown time zone ${value}`; }
  }
  if (key === "appearance.textScale") {
    if (!/^\d{2,3}$/.test(value)) return `text size must be a whole percentage (${TEXT_SCALE_MIN}–${TEXT_SCALE_MAX})`;
    const n = Number(value);
    if (n < TEXT_SCALE_MIN || n > TEXT_SCALE_MAX) return `text size must be between ${TEXT_SCALE_MIN} and ${TEXT_SCALE_MAX} %`;
    return null;
  }
  // TT67 IN-02: learned mouse Back / Forward indices — 0..31 except 0 (main) and 2 (secondary); same rule as input.ts LEARNABLE
  if ((key === "input.mouseBack" || key === "input.mouseForward") && !/^(?:1|[3-9]|[12][0-9]|3[01])$/.test(value)) {
    return "mouse button must be a button index from 1 to 31, not 0 (main) or 2 (secondary)";
  }
  if (key === "maps.tileUrl" && value !== "" && !validTileUrl(value)) return "tile URL must be https:// and contain {z}, {x} and {y}";
  if (key === "appearance.wallpaper" && !isWallpaper(value)) return `wallpaper must be one of ${ENUMS[key].join(", ")}`;
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(value)) return `${key} must be one of ${allowed.join(", ")}`;
  if (key === "appearance.accent" && value !== "auto" && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return "accent must be \"auto\" or a #rgb / #rrggbb colour";
  return null;
}
