/**
 * The chrome glyph set — every mark `UiGlyph` can draw (24-grid, stroke-only,
 * `currentColor`). It lives here as data rather than as a TypeScript union so the
 * accessibility suite can import it without loading JSX into Node, exactly as
 * `GLYPH_NAMES` does for the tinted module tiles in `icon-data.ts`.
 *
 * The two sets are different jobs and must not be merged: a tile glyph is a 48-grid
 * picture drawn in a two-stop palette, a chrome glyph is a 24-grid monochrome mark that
 * inherits the theme's ink. `scripts/a11y-unit.mts` asserts this list has no duplicates
 * and that each name has a drawing.
 *
 * TT145 added six: claim (a device handoff), tray (trash retention), seal (a sealed
 * record), lane (an app confined to a browser lane), budget (a frame cut into slices)
 * and bucket (a measured quota). Each is an original geometric construction, chosen so
 * that a section heading can drop the word "policy" or "budget" and the shape still says
 * what is being measured.
 */
export const UI_GLYPH_NAMES = [
  "search", "overview", "contrast", "sliders", "close", "plus", "spark", "tileLeft", "tileRight", "popout",
  "minimize", "maximize", "up", "back", "forward", "chevron", "tree", "split", "terminal", "star", "starFill",
  "battery", "timer", "plugBoard", "broadcaster", "ledger", "bytes", "held", "loaded", "record", "snapshot",
  "queue", "sidebar", "tabstrip", "splitH", "splitV", "tearout", "verify", "copy", "photos", "folder", "trash",
  "export", "crop", "eraser", "undo", "refresh", "clipin", "more", "sleep", "shield", "cookie", "closeset",
  "auto", "download", "method", "host", "calendar", "scope", "device", "dedupe", "broom", "gauge", "session",
  "link", "manifest", "alarm", "repeat", "stats",
  "claim", "tray", "seal", "lane", "budget", "bucket",
  "shuffle", "wrap", "caret-up", "caret-down", "indent", "compare", "emptyNote", "emptyZip", "emptyVault",
  "emptyPlan", "outline", "diff", "units", "keycap", "meridian", "ranked", "deadkey", "plural",
  /* TT148: three hardware ideas drawn as geometry — a die with legs, a connector with
     prongs and a lead, and a pointer held inside brackets. */
  "chip", "plug", "cursor",
] as const;

export type UiGlyphName = (typeof UI_GLYPH_NAMES)[number];
