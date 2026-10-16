import type { Rect } from "./windowing/state";

export interface ModuleDef {
  id: string;
  title: string;
  icon: string;
  group: "Core" | "Create" | "Connect" | "System";
  summary: string;
  rect?: Partial<Rect>;
  /** feature codes this module implements — keeps the spec table honest */
  implements: string[];
}

/**
 * ONE registry. The launcher, shelf, palette, desktop icons, terminal `open`
 * and the spec cross-reference all read this array, so a module cannot exist in
 * one surface and be missing from another.
 */
export const MODULES: ModuleDef[] = [
  { id: "files", title: "Files", icon: "🗂", group: "Core", summary: "Journaled file manager over the Postgres VFS", rect: { w: 900, h: 560 }, implements: ["FM-01", "FM-03", "FM-11", "FM-18"] },
  { id: "editor", title: "Editor", icon: "📝", group: "Create", summary: "Text/Markdown editor with versions and safe-save", rect: { w: 820, h: 560 }, implements: ["PR-01", "FF-15"] },
  { id: "find", title: "Find", icon: "🔎", group: "Core", summary: "Index search with provenance and diagnostics", rect: { w: 760, h: 520 }, implements: ["SR-01", "SR-02", "SR-08"] },
  { id: "terminal", title: "Terminal", icon: "⌨️", group: "Core", summary: "Real shell over the VFS and the same journal", rect: { w: 820, h: 480 }, implements: ["TD-01", "TD-02"] },
  { id: "notes", title: "Notes", icon: "🗒", group: "Create", summary: "Local-first notes, indexed with files", rect: { w: 720, h: 520 }, implements: ["PR-02"] },
  { id: "browser", title: "Browser", icon: "🌐", group: "Core", summary: "Tabs, splits and groups with an embeddability probe", rect: { w: 1000, h: 640 }, implements: ["PR-07", "WM-06"] },
  { id: "media", title: "Media", icon: "🎞", group: "Create", summary: "Player with Media Session, PiP and Beam", rect: { w: 820, h: 540 }, implements: ["MD-02", "CA-01"] },
  { id: "capture", title: "Capture", icon: "⏺", group: "Create", summary: "Screen/window capture committed to the VFS first", rect: { w: 720, h: 520 }, implements: ["MD-01"] },
  { id: "lens", title: "Lens", icon: "🎥", group: "Create", summary: "Camera pipeline, effects, presenter mode, routes", rect: { w: 880, h: 600 }, implements: ["LN-01", "LN-13", "LN-14"] },
  { id: "beam", title: "Beam", icon: "📡", group: "Connect", summary: "Cast hub: transports, sessions, privacy", rect: { w: 820, h: 560 }, implements: ["CA-05", "CA-01", "CA-02"] },
  { id: "together", title: "Together", icon: "👥", group: "Connect", summary: "Synchronised playback with anchor-clock drift control", rect: { w: 780, h: 560 }, implements: ["CA-11", "CA-15"] },
  { id: "messages", title: "Messages", icon: "💬", group: "Connect", summary: "Bridge connector seam; iMessage/RCS limits stated", rect: { w: 720, h: 520 }, implements: ["MS-01", "MS-03"] },
  { id: "vault", title: "Vault", icon: "🔐", group: "System", summary: "Zero-knowledge secrets with WebCrypto", rect: { w: 700, h: 520 }, implements: ["SC-01", "SC-02"] },
  { id: "backup", title: "Backup", icon: "🧰", group: "System", summary: "Verified export/restore with a digest manifest", rect: { w: 760, h: 540 }, implements: ["BK-01", "BK-03", "BK-05"] },
  { id: "alerts", title: "Alerts", icon: "🔔", group: "System", summary: "First-party alert centre with rules and history", rect: { w: 700, h: 540 }, implements: ["NC-01", "NC-04"] },
  { id: "monitor", title: "Monitor", icon: "📈", group: "System", summary: "Frame cost, governor state, memory, jobs", rect: { w: 820, h: 560 }, implements: ["RG-01", "RG-04", "DP-14"] },
  { id: "calculator", title: "Calculator", icon: "🧮", group: "Core", summary: "One evaluator shared with the palette", rect: { w: 420, h: 520 }, implements: ["PR-09", "SR-06"] },
  { id: "settings", title: "Settings", icon: "⚙️", group: "System", summary: "Settings graph, capabilities, licence, shortcuts", rect: { w: 920, h: 620 }, implements: ["ST-01", "ST-04", "BL-01"] },
  { id: "spec", title: "Spec", icon: "📋", group: "System", summary: "The live feature register with nuances and status", rect: { w: 1040, h: 640 }, implements: ["DP-10", "DP-08"] },
  { id: "clock", title: "Clock", icon: "⏱", group: "Core", summary: "World clock, stopwatch, timer (anchor-based, no drift)", rect: { w: 460, h: 560 }, implements: ["PR-10"] },
  { id: "planner", title: "Planner", icon: "🗓", group: "Create", summary: "Tasks, reminders, week view, ICS import/export", rect: { w: 820, h: 560 }, implements: ["PR-03", "PR-04"] },
  { id: "devices", title: "Devices", icon: "🔌", group: "System", summary: "Voice recorder, QR scan, colour, audio, serial, HID/USB/BT, gamepad", rect: { w: 760, h: 580 }, implements: ["MD-04", "MD-05", "MD-06", "MD-07", "TD-03", "CT-06", "IN-07"] },
  { id: "share", title: "Share", icon: "🖥", group: "Connect", summary: "WebRTC peer screen share + device bridge", rect: { w: 800, h: 620 }, implements: ["CA-09", "CT-02", "CA-13"] },
  { id: "routines", title: "Routines", icon: "⚡", group: "System", summary: "Routines with dry-run, triggers, workspace presets", rect: { w: 780, h: 600 }, implements: ["AU-01", "AU-02", "PR-07r"] },
  { id: "clipboard", title: "Clipboard", icon: "📋", group: "Core", summary: "In-app clipboard history with sensitive masking", rect: { w: 620, h: 480 }, implements: ["PR-12"] },
  { id: "storage", title: "Storage", icon: "💽", group: "System", summary: "Categories, duplicates by digest, quota, persistence", rect: { w: 760, h: 580 }, implements: ["FM-07"] },
  { id: "localdisk", title: "Local disk", icon: "🖴", group: "Core", summary: "Mount a real folder; sync with a conflict inbox", rect: { w: 760, h: 560 }, implements: ["FM-08", "BK-02"] },
  { id: "imageedit", title: "Image Editor", icon: "🪄", group: "Create", summary: "Layered raster editor: brushes, selections, masks, 12 blend modes, PSD read/write; classic quick edit", rect: { w: 1100, h: 720 }, implements: ["FF-24", "MD-03", "FF-30", "FF-31"] },
  { id: "vector", title: "Vector", icon: "✒", group: "Create", summary: "Vector studio: pen/node/shape tools, transforms, gradients, groups; sanitised SVG import, SVG/PNG export", rect: { w: 1040, h: 680 }, implements: ["FF-25", "FF-04", "FF-32"] },
  { id: "writer", title: "Writer", icon: "📄", group: "Create", summary: "Structured Word document editor; DOCX import/export at grade C", rect: { w: 820, h: 620 }, implements: ["FF-22", "PR-11"] },
  { id: "slides", title: "Slides", icon: "🖼", group: "Create", summary: "Slide deck editor; PPTX import/export at grade C", rect: { w: 900, h: 640 }, implements: ["FF-23", "PR-11"] },
  { id: "sheet", title: "Spreadsheet", icon: "📊", group: "Create", summary: "Formula engine (2 oracles), dynamic arrays, formatting, charts", rect: { w: 1000, h: 640 }, implements: ["FF-19", "FF-20", "FF-21", "FF-26", "FF-27", "FF-28", "FF-29", "PR-11"] },
  { id: "peek", title: "Peek", icon: "👁", group: "Core", summary: "Sandboxed previewer with watchdog and grades", rect: { w: 760, h: 560 }, implements: ["FM-04", "FF-01", "FF-11"] },
];

export const moduleById = (id: string) => MODULES.find((m) => m.id === id);
