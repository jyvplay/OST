/**
 * TT137 (ST-03) — Default-apps guide.
 *
 * File extension → default app mapping with protocol handlers. Pure
 * registry: no I/O, just decision logic.
 */

export type ProtocolHandler = "mailto" | "tel" | "web+fusion" | "magnet" | "ftp";

export interface DefaultApp {
  /** Module id that handles this extension. */
  module: string;
  /** Human-readable label. */
  label: string;
  /** Whether this is a system default (cannot be overridden). */
  system?: boolean;
}

export interface ProtocolBinding {
  protocol: ProtocolHandler;
  module: string;
  label: string;
}

export interface AppRegistry {
  extensions: Map<string, DefaultApp>;
  protocols: Map<ProtocolHandler, ProtocolBinding>;
  /** User overrides that shadow system defaults. */
  overrides: Map<string, string>;
}

export const SYSTEM_EXTENSIONS: Record<string, DefaultApp> = {
  md: { module: "editor", label: "Editor" },
  txt: { module: "editor", label: "Editor" },
  json: { module: "editor", label: "Editor" },
  csv: { module: "editor", label: "Editor" },
  ts: { module: "editor", label: "Editor" },
  tsx: { module: "editor", label: "Editor" },
  js: { module: "editor", label: "Editor" },
  py: { module: "editor", label: "Editor" },
  sh: { module: "terminal", label: "Terminal" },
  pdf: { module: "pdf", label: "PDF" },
  png: { module: "photos", label: "Photos" },
  jpg: { module: "photos", label: "Photos" },
  jpeg: { module: "photos", label: "Photos" },
  gif: { module: "photos", label: "Photos" },
  webp: { module: "photos", label: "Photos" },
  svg: { module: "vector", label: "Vector" },
  mp3: { module: "music", label: "Music" },
  wav: { module: "music", label: "Music" },
  ogg: { module: "music", label: "Music" },
  flac: { module: "music", label: "Music" },
  m4a: { module: "music", label: "Music" },
  mp4: { module: "video", label: "Video" },
  webm: { module: "video", label: "Video" },
  mov: { module: "video", label: "Video" },
  mkv: { module: "video", label: "Video" },
  xlsx: { module: "sheet", label: "Spreadsheet" },
  xls: { module: "sheet", label: "Spreadsheet" },
  csv_: { module: "sheet", label: "Spreadsheet" },
  docx: { module: "writer", label: "Writer" },
  doc: { module: "writer", label: "Writer" },
  odt: { module: "writer", label: "Writer" },
  pptx: { module: "slides", label: "Slides" },
  ppt: { module: "slides", label: "Slides" },
  odp: { module: "slides", label: "Slides" },
  zip: { module: "archive", label: "Archive" },
  gz: { module: "archive", label: "Archive" },
  tar: { module: "archive", label: "Archive" },
  ics: { module: "calendar", label: "Calendar" },
  vcf: { module: "contacts", label: "Contacts" },
  epub: { module: "books", label: "Books" },
};

export const SYSTEM_PROTOCOLS: Record<ProtocolHandler, ProtocolBinding> = {
  mailto: { protocol: "mailto", module: "mail", label: "Mail" },
  tel: { protocol: "tel", module: "phone", label: "Phone" },
  "web+fusion": { protocol: "web+fusion", module: "shell", label: "Fusion OS" },
  magnet: { protocol: "magnet", module: "browser", label: "Browser" },
  ftp: { protocol: "ftp", module: "browser", label: "Browser" },
};

export function createRegistry(): AppRegistry {
  return {
    extensions: new Map(Object.entries(SYSTEM_EXTENSIONS)),
    protocols: new Map(Object.entries(SYSTEM_PROTOCOLS).map(([k, v]) => [k as ProtocolHandler, v])),
    overrides: new Map(),
  };
}

export function getExtension(reg: AppRegistry, ext: string): DefaultApp | null {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (reg.overrides.has(e)) {
    const module = reg.overrides.get(e)!;
    return { module, label: module };
  }
  return reg.extensions.get(e) ?? null;
}

export function setOverride(reg: AppRegistry, ext: string, module: string): { ok: true } | { ok: false; reason: string } {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (!e) return { ok: false, reason: "Extension must not be empty" };
  if (!/^[a-z0-9]{1,8}$/.test(e)) return { ok: false, reason: "Extension must be 1…8 alphanumeric characters" };
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(module)) return { ok: false, reason: "Module id invalid" };
  reg.overrides.set(e, module);
  return { ok: true };
}

export function clearOverride(reg: AppRegistry, ext: string): { ok: true } | { ok: false; reason: string } {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (!reg.overrides.has(e)) return { ok: false, reason: "No override for this extension" };
  reg.overrides.delete(e);
  return { ok: true };
}

export function getProtocol(reg: AppRegistry, protocol: ProtocolHandler): ProtocolBinding | null {
  return reg.protocols.get(protocol) ?? null;
}

export interface AppGuide {
  extensions: { ext: string; app: DefaultApp }[];
  protocols: ProtocolBinding[];
  overrides: { ext: string; module: string }[];
}

export function buildGuide(reg: AppRegistry): AppGuide {
  return {
    extensions: [...reg.extensions.entries()].map(([ext, app]) => ({ ext, app })).sort((a, b) => a.ext.localeCompare(b.ext)),
    protocols: [...reg.protocols.values()],
    overrides: [...reg.overrides.entries()].map(([ext, module]) => ({ ext, module })),
  };
}

export function describeApp(reg: AppRegistry, path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "No extension — opens in Files";
  const ext = path.slice(dot + 1).toLowerCase();
  const app = getExtension(reg, ext);
  return app ? `${ext} → ${app.label}` : `${ext} → no default app registered`;
}
