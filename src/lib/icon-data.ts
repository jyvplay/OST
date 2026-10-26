/**
 * TT21 icon data (no React): palettes, the module → icon map and the file-extension map. Shared by
 * src/components/AppIcon.tsx and the a11y unit suite (contrast + coverage checks run on exactly this data).
 */
export const INK = "#14213d";
export const WHITE = "#ffffff";
export interface Palette { top: string; bottom: string; fg: string; detail: string }
export const PALETTES = {
  sun: { top: "#ffe36e", bottom: "#ffb020", fg: INK, detail: "#ffcf3f" },
  orange: { top: "#ffc06b", bottom: "#ff8a1f", fg: INK, detail: "#ffa640" },
  lime: { top: "#d9f99d", bottom: "#84cc16", fg: INK, detail: "#a3e635" },
  mint: { top: "#86efac", bottom: "#22c55e", fg: INK, detail: "#4ade80" },
  sky: { top: "#2a7cf0", bottom: "#1640b8", fg: WHITE, detail: "#2563eb" },
  blue: { top: "#4470f2", bottom: "#2638c4", fg: WHITE, detail: "#3554e6" },
  teal: { top: "#0d918f", bottom: "#0a5c66", fg: WHITE, detail: "#0d8086" },
  green: { top: "#18934f", bottom: "#0f6838", fg: WHITE, detail: "#168a4b" },
  coral: { top: "#e8434c", bottom: "#b81a35", fg: WHITE, detail: "#d93549" },
  indigo: { top: "#6464f0", bottom: "#3b2cc0", fg: WHITE, detail: "#5045dc" },
  slate: { top: "#5b6b8c", bottom: "#2b3550", fg: WHITE, detail: "#3f4b69" },
  lagoon: { top: "#0b8fb0", bottom: "#1d47c9", fg: WHITE, detail: "#1279c9" },
  ember: { top: "#e05a2b", bottom: "#b23a0a", fg: WHITE, detail: "#d9541f" },
} satisfies Record<string, Palette>;
export type PaletteName = keyof typeof PALETTES;

export const GLYPH_NAMES = ["folder", "pencil", "search", "terminal", "note", "globe", "play", "record", "camera", "broadcast", "people", "chat", "lock", "shield", "cloud", "bell", "pulse", "keypad", "gear", "checklist", "clock", "calendar", "plug", "screenShare", "bolt", "clipboard", "pie", "drive", "picture", "pen", "doc", "easel", "grid", "table", "eye", "braces", "music", "box", "board", "contact", "trash", "blank", "film", "map", "book"] as const;
export type GlyphName = (typeof GLYPH_NAMES)[number];

export const MODULE_ICONS: Record<string, [PaletteName, GlyphName]> = {
  files: ["orange", "folder"], editor: ["sky", "pencil"], find: ["teal", "search"], terminal: ["slate", "terminal"], ssh: ["lagoon", "terminal"],
  notes: ["sun", "note"], browser: ["blue", "globe"], media: ["coral", "play"], capture: ["coral", "record"],
  lens: ["indigo", "camera"], beam: ["teal", "broadcast"], together: ["orange", "people"], messages: ["green", "chat"],
  vault: ["indigo", "lock"], privacy: ["teal", "shield"], backup: ["sky", "cloud"], alerts: ["sun", "bell"],
  monitor: ["green", "pulse"], calculator: ["orange", "keypad"], settings: ["slate", "gear"], spec: ["blue", "checklist"],
  clock: ["sky", "clock"], planner: ["coral", "calendar"], devices: ["teal", "plug"], share: ["blue", "screenShare"],
  routines: ["sun", "bolt"], clipboard: ["lime", "clipboard"], storage: ["indigo", "pie"], localdisk: ["slate", "drive"],
  imageedit: ["lagoon", "picture"], photos: ["sun", "picture"], vector: ["orange", "pen"], writer: ["blue", "doc"], slides: ["ember", "easel"], pdf: ["coral", "doc"],
  sheet: ["green", "grid"], tables: ["sky", "table"], whiteboard: ["indigo", "board"], contacts: ["green", "contact"], video: ["ember", "film"], music: ["coral", "music"], maps: ["mint", "map"], peek: ["teal", "eye"], books: ["sun", "book"],
};

/** File extension → [palette, glyph] (folders use "dir"). */
export function fileIconSpec(name: string, kind: "file" | "dir" = "file"): [PaletteName, GlyphName] {
  if (kind === "dir") return ["orange", "folder"];
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["xlsx", "xls", "csv", "tsv", "ods", "fsheet"].includes(ext)) return ["green", "grid"];
  if (["docx", "doc", "odt", "rtf", "fdoc"].includes(ext)) return ["blue", "doc"];
  if (ext === "ftable") return ["sky", "table"];
  if (["pptx", "ppt", "odp", "fslides"].includes(ext)) return ["ember", "easel"];
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "psd", "avif"].includes(ext)) return ["lagoon", "picture"];
  if (ext === "fboard") return ["indigo", "board"];
  if (ext === "svg") return ["orange", "pen"];
  if (["md", "txt", "log", "markdown"].includes(ext)) return ["sky", "note"];
  if (["json", "js", "ts", "tsx", "mjs", "mts", "css", "html", "xml", "yml", "yaml", "sh", "py"].includes(ext)) return ["slate", "braces"];
  if (["mp3", "wav", "ogg", "flac", "m4a", "opus"].includes(ext)) return ["indigo", "music"];
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return ["coral", "play"];
  if (ext === "ics") return ["coral", "calendar"];
  if (["zip", "gz", "tar", "fusionbak", "7z"].includes(ext)) return ["sun", "box"];
  if (ext === "fvault") return ["indigo", "lock"];
  if (ext === "pdf") return ["coral", "doc"];
  if (ext === "epub") return ["sun", "book"];
  if (["ai", "eps", "ps"].includes(ext)) return ["orange", "pen"];
  if (["vcf", "vcard"].includes(ext)) return ["green", "contact"];
  return ["slate", "blank"];
}
