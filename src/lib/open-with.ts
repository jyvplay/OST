import { formatFor } from "./forge";

/**
 * Which app opens a file (the Files app's double-click routing, shared by Files, the desktop icons and the
 * Tabletop since TT26 so the three can never disagree). Pure.
 */
export function appForFile(name: string, mime: string, kind: string = "file"): string {
  const n = name.toLowerCase();
  const fmt = formatFor(name);
  if (kind === "dir") return "files";
  if (n.endsWith(".svg") || n.endsWith(".fsvg")) return "vector";
  if (mime.startsWith("image/")) return "imageedit";
  if (n.endsWith(".docx") || n.endsWith(".fdoc")) return "writer";
  if (n.endsWith(".ftable")) return "tables";
  if (n.endsWith(".fboard")) return "whiteboard";
  if (/\.(vcf|vcard)$/i.test(n)) return "contacts";
  if (/\.(geojson|gpx|kml)$/i.test(n)) return "maps"; // TT34 MP-08: GPX / KML open in Maps too
  if (n.endsWith(".pptx") || n.endsWith(".fdeck")) return "slides";
  if (n.endsWith(".epub") || mime === "application/epub+zip") return "books"; // TT75: FF-10 on-device EPUB reader
  if (n.endsWith(".pdf") || mime === "application/pdf") return "pdf"; // TT52: first-party PDF viewer/editor
  if ([".fsheet", ".fworkbook", ".xlsx"].some((ext) => n.endsWith(ext))) return "sheet";
  if (fmt && fmt.grade === "A" && fmt.editable) return "editor";
  return "peek";
}
