/**
 * Appearance vocabulary shared by the shell, the settings validator and the Settings "Display & readability"
 * section, so the three can never disagree.
 * TT22: "auto" (the default) follows the active style's own wallpaper; the three Miami wallpapers are SVG art in
 * /public/wallpapers. The TT21 CSS wallpapers stay available.
 */
export const WALLPAPERS = [
  { id: "auto", label: "Match style" },
  { id: "poolside", label: "Poolside" },
  { id: "vice", label: "Vice sunset" },
  { id: "oceandrive", label: "Ocean Drive" },
  { id: "sunrise", label: "Sunrise" },
  { id: "aurora", label: "Aurora" },
  { id: "grid", label: "Grid" },
  { id: "slate", label: "Slate" },
] as const;
export type WallpaperId = (typeof WALLPAPERS)[number]["id"];
export const DEFAULT_WALLPAPER: WallpaperId = "auto";
export function isWallpaper(v: string): v is WallpaperId {
  return WALLPAPERS.some((w) => w.id === v);
}
