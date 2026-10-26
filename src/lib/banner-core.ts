/**
 * TT80 — Fusion's own top-level menu vocabulary for app banners and the shell menu bar.
 *
 * The user asked for top-level menu names that are "your own creation, no similarities with existing systems". Every
 * name below was checked against the top-level menus of: macOS / iWork (File Edit Insert Slide Table Organize Format
 * Arrange View Play Share Window Help, Preview's Go / Tools), Microsoft Office menus and ribbon tabs (File Home Insert
 * Draw Design Layout References Mailings Review View Help Formulas Data Transitions Animations "Slide Show" Record),
 * Google Docs / Sheets / Slides (… Extensions, Slide, Arrange, Data), LibreOffice (… Styles Sheet Form Tools),
 * Photoshop / Illustrator / InDesign (Image Layer Type Select Filter Object Effect Plugins), GIMP (Layers Colors
 * Filters Windows), Inkscape (Path Text Extensions), Affinity (Document Arrange), Figma (Object Text Vector Widgets
 * Preferences), Sketch (Prototyping), Blender (Render, editor headers: Add Object Select), Final Cut Pro (Trim Mark
 * Clip Modify), Premiere (Sequence Markers Graphics), Acrobat (Sign), browsers (History Bookmarks Profiles Tab) and
 * IDEs (Selection Go Run Terminal Navigate Product Debug "Source Control"). None of ours appears there.
 *
 * Each name has ONE meaning in every app, so the same word always finds the same kind of command.
 */
export const BANNER_MENUS = {
  Keep: "start, open, save, export, print and protect the document",
  Tweak: "undo, redo, find, replace, select, delete",
  Put: "place new things into the document (tables, pictures, links, slides, shapes, breaks)",
  Look: "how the selection looks: type, colour, alignment, borders, number formats",
  Glance: "how you see the document: zoom, panels, modes, navigation",
  Polish: "proofing and review: spelling, comments, tracked changes, notes",
  Crunch: "work with data: sort, filter, group, outline, summarise",
  Stage: "present: slideshow, presenter view, motion",
  Stack: "front-to-back order, layers and pages",
  Kit: "the pointer and drawing tools",
  Ink: "marks on a page: highlight, underline, strike, pen, notes",
} as const;
export type BannerMenu = keyof typeof BANNER_MENUS;

/** a menu lists at most this many items; a longer group is served compact (no inlined list options) and scrolls */
export const MENU_ITEM_CAP = 40;

/** the shell menu bar's own menus (Art layout): the window you are in, and help */
export const SHELL_MENUS = { Frame: "the focused window: new, close, minimise, zoom, tile, every open window", Guide: "shortcuts, command search, the feature register" } as const;

/** top-level menu names of existing systems that Fusion must not use (case-insensitive, whole name) */
export const FOREIGN_MENU_NAMES = [
  "File", "Edit", "View", "Insert", "Format", "Tools", "Tool", "Table", "Window", "Windows", "Help", "Home", "Design", "Layout",
  "Page Layout", "References", "Mailings", "Review", "Data", "Formulas", "Arrange", "Share", "Image", "Layer", "Layers", "Select",
  "Selection", "Filter", "Filters", "Type", "Object", "Effect", "Slide", "Slide Show", "Slideshow", "Play", "Go", "Bookmarks",
  "History", "Develop", "Developer", "Draw", "Transitions", "Animations", "Extensions", "Add-ons", "Plugins", "Text", "Organize",
  "Sheet", "Styles", "Form", "Colors", "Path", "Document", "Vector", "Widgets", "Preferences", "Prototyping", "Add", "Render",
  "Trim", "Mark", "Clip", "Modify", "Sequence", "Markers", "Graphics", "Sign", "Profiles", "Tab", "Run", "Terminal", "Navigate",
  "Product", "Debug", "Source Control", "Record", "Shape", "Pages", "Insert & Format", "Presentation", "Annotate", "Drawing tools",
] as const;

export const isForeignMenuName = (name: string) => FOREIGN_MENU_NAMES.some((f) => f.toLowerCase() === name.trim().toLowerCase());
