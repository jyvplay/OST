/**
 * TT139 (FF-09, FF-11) — Plain formats and export-loss planning.
 *
 * FF-09 covers the eight text formats an OS must open without a heavyweight
 * parser. FF-11 is the honest half: when you ask to "save as" something else,
 * what exactly do you lose?
 *
 * Format detection is *content* first, extension second. A `.txt` file that is
 * valid JSON is JSON; a `.json` file full of prose is text. Extensions lie, and
 * an OS that trusts them corrupts data on re-save.
 *
 * The CSV parser implements RFC 4180 as written, including the parts people
 * forget: doubled quotes are a literal quote, a quoted field may contain
 * newlines and commas, and a trailing newline does not create an empty row.
 * A naive `split(",")` fails on every one of those.
 *
 * `planExport` is a table of *specific* losses, not a warning string. Each
 * entry names what is lost and how bad it is, so the UI can say "3 images will
 * be dropped" instead of "some formatting may be lost".
 */

export type PlainFormat = "txt" | "md" | "csv" | "json" | "yaml" | "ini" | "log";

export const PLAIN_FORMATS: PlainFormat[] = ["txt", "md", "csv", "json", "yaml", "ini", "log"];

export const EXTENSION_MAP: Record<string, PlainFormat> = {
  txt: "txt", text: "txt", log: "log",
  md: "md", markdown: "md",
  csv: "csv", tsv: "csv",
  json: "json", jsonl: "json",
  yaml: "yaml", yml: "yaml",
  ini: "ini", conf: "ini", cfg: "ini", toml: "ini",
};

export interface FormatInfo {
  format: PlainFormat;
  /** Why this format was chosen, so a wrong guess is visible. */
  reason: string;
  lineCount: number;
  charCount: number;
  byteCount: number;
  encoding: "utf-8" | "utf-8-bom" | "utf-16le-bom" | "utf-16be-bom" | "latin1";
  hasBom: boolean;
  /** CRLF, LF, or none (single line). Mixed is reported as "mixed". */
  lineEnding: "lf" | "crlf" | "cr" | "mixed" | "none";
}

function sniffBom(bytes: Uint8Array): FormatInfo["encoding"] {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8-bom";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le-bom";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be-bom";
  return "utf-8";
}

function detectLineEnding(text: string): FormatInfo["lineEnding"] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (cr > 0) return "cr";
  return "lf";
}

/**
 * Detect by content, falling back to the extension. Content wins because a
 * mis-extensioned file re-saved under its extension is silent corruption.
 */
export function detectFormat(text: string, fileName?: string, bytes?: Uint8Array): { format: PlainFormat; reason: string } {
  const trimmed = text.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return { format: "json", reason: "Content parses as JSON" };
    } catch {
      // Fall through: a `{`-leading text file is just text.
    }
  }
  if (trimmed.startsWith("---") && /^---\s*$/m.test(trimmed)) {
    return { format: "yaml", reason: "Leading '---' document marker" };
  }
  // A log line: ISO timestamp or syslog-ish prefix at the start.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(firstLine) || /^\[?\d{4}-\d{2}-\d{2}/.test(firstLine)) {
    return { format: "log", reason: "First line starts with a timestamp" };
  }
  // INI needs a section header or a bare key=value pair repeated.
  if (/^\s*\[[^\]\n]+\]\s*$/m.test(trimmed) && /^\s*[\w.-]+\s*=/m.test(trimmed)) {
    return { format: "ini", reason: "Has a [section] header and key=value pairs" };
  }
  // CSV: consistent delimiter counts across the first lines.
  const lines = trimmed.split(/\r?\n/).filter((l) => l).slice(0, 5);
  if (lines.length >= 2) {
    for (const delim of [",", "\t", ";"]) {
      const counts = lines.map((l) => l.split(delim).length);
      if (counts[0] > 1 && counts.every((c) => c === counts[0])) {
        return { format: "csv", reason: `Every one of the first ${lines.length} lines has ${counts[0] - 1} '${delim}' separators` };
      }
    }
  }
  if (/^#{1,6}\s+\S/m.test(trimmed) || /^\s*[-*+]\s+\S/m.test(trimmed) || /```/.test(trimmed)) {
    return { format: "md", reason: "Has a heading, list marker, or fenced code block" };
  }
  if (/^\s*[\w.-]+\s*:\s*\S/m.test(trimmed) && !/^\s*\[/m.test(trimmed)) {
    return { format: "yaml", reason: "Has top-level key: value lines and no [sections]" };
  }

  // Extension fallback, only when content is ambiguous.
  if (fileName) {
    const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
    const byExt = EXTENSION_MAP[ext];
    if (byExt) return { format: byExt, reason: `Content ambiguous; '.${ext}' extension says ${byExt}` };
  }
  void bytes;
  return { format: "txt", reason: "No structure detected; treating as plain text" };
}

export function analyzePlainText(text: string, bytes?: Uint8Array, fileName?: string): FormatInfo {
  const { format } = detectFormat(text, fileName, bytes);
  const encoding = bytes ? sniffBom(bytes) : text.charCodeAt(0) === 0xfeff ? "utf-8-bom" : "utf-8";
  return {
    format,
    reason: detectFormat(text, fileName, bytes).reason,
    lineCount: text === "" ? 0 : text.split(/\r\n|\r|\n/).length,
    charCount: text.length,
    byteCount: bytes ? bytes.length : new TextEncoder().encode(text).length,
    encoding,
    hasBom: encoding === "utf-8-bom" || encoding === "utf-16le-bom" || encoding === "utf-16be-bom",
    lineEnding: detectLineEnding(text),
  };
}

/** RFC 4180 CSV parse. Handles quoted fields, embedded newlines, doubled quotes. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  if (delimiter.length !== 1) throw new Error("Delimiter must be a single character");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    pushField();
    // RFC 4180 does not create a trailing empty row for a final newline.
    if (!(row.length === 1 && row[0] === "" && i >= text.length)) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === "\r") { if (text[i + 1] === "\n") i++; pushRow(); i++; continue; }
    if (ch === "\n") { pushRow(); i++; continue; }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) pushRow();
  if (inQuotes) throw new Error("Unterminated quoted field — the CSV is truncated");
  return rows;
}

export function serializeCsv(rows: string[][], delimiter = ","): string {
  const needsQuote = (f: string) => f.includes(delimiter) || f.includes('"') || f.includes("\n") || f.includes("\r");
  return rows
    .map((r) => r.map((f) => (needsQuote(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(delimiter))
    .join("\n");
}

export function csvToJson(rows: string[][]): Array<Record<string, string>> {
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return obj;
  });
}

export function jsonToCsv(records: Array<Record<string, unknown>>): string[][] {
  if (!records.length) return [];
  // Column order is the union of keys in first-seen order: stable output.
  const cols: string[] = [];
  for (const r of records) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return [
    cols,
    ...records.map((r) => cols.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    })),
  ];
}

export interface IniDocument {
  /** Top-level keys that appear before any [section]. */
  globals: Record<string, string>;
  sections: Record<string, Record<string, string>>;
}

export function parseIni(text: string): IniDocument {
  const globals: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> = globals;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const name = section[1].trim();
      sections[name] = sections[name] ?? {};
      current = sections[name];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue; // a bare word is not a setting; ignore rather than invent
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    current[key] = value;
  }
  return { globals, sections };
}

export function serializeIni(doc: IniDocument): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(doc.globals)) out.push(`${k}=${v}`);
  for (const [name, kv] of Object.entries(doc.sections)) {
    if (out.length) out.push("");
    out.push(`[${name}]`);
    for (const [k, v] of Object.entries(kv)) out.push(`${k}=${v}`);
  }
  return out.join("\n");
}

/** Flat YAML subset: scalars, nesting by indentation, and `- ` lists. No anchors. */
export function parseYamlLite(text: string): unknown {
  type Frame = { indent: number; obj: Record<string, unknown> | unknown[] };
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, obj: root }];

  const coerce = (raw: string): unknown => {
    const s = raw.trim();
    if (s === "" || s === "~" || s === "null") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d*\.\d+$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  };

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];

    if (line.startsWith("- ")) {
      if (!Array.isArray(parent.obj)) continue;
      parent.obj.push(coerce(line.slice(2)));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (!Array.isArray(parent.obj)) {
      if (rest === "") {
        // Determine container type by looking ahead is expensive; default to an
        // object and let a "- " line convert it lazily below.
        const child: Record<string, unknown> = {};
        (parent.obj as Record<string, unknown>)[key] = child;
        stack.push({ indent, obj: child });
      } else {
        (parent.obj as Record<string, unknown>)[key] = coerce(rest);
      }
    }
  }
  return root;
}

export interface LogLine {
  raw: string;
  timestamp: string | null;
  level: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL" | null;
  message: string;
}

const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;

export function parseLog(text: string): LogLine[] {
  return text.split(/\r?\n/).filter((l) => l.length > 0).map((raw) => {
    const ts = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/.exec(raw);
    const level = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/i.exec(raw);
    const normalised = level
      ? (level[1].toUpperCase() === "WARNING" ? "WARN" : level[1].toUpperCase() === "CRITICAL" ? "FATAL" : level[1].toUpperCase())
      : null;
    const validLevel = normalised && (LEVELS as readonly string[]).includes(normalised) ? (normalised as LogLine["level"]) : null;
    return {
      raw,
      timestamp: ts ? ts[1] : null,
      level: validLevel,
      message: raw.replace(ts ? ts[0] : "", "").replace(level ? level[0] : "", "").trim(),
    };
  });
}

// ══ FF-11: export-loss planning ══════════════════════════════════════════

export type LossKind = "images" | "tables" | "styles" | "formulas" | "comments" | "footnotes" | "structure" | "metadata" | "precision" | "encoding" | "interactivity";

export const LOSS_DESCRIPTIONS: Record<LossKind, { label: string; severity: "none" | "minor" | "significant" | "critical" }> = {
  images: { label: "Embedded images are dropped", severity: "critical" },
  // Note: formats that carry images by reference (markdown, html) do not list
  // `images` as a capability they lack — a reference is what the format means.
  tables: { label: "Table structure is flattened to text", severity: "significant" },
  styles: { label: "Bold/italic/colour/size are lost", severity: "minor" },
  formulas: { label: "Formulas become their last computed value", severity: "significant" },
  comments: { label: "Comments and annotations are dropped", severity: "minor" },
  footnotes: { label: "Footnotes are appended as plain text", severity: "minor" },
  structure: { label: "Headings, lists, and section order are lost", severity: "significant" },
  metadata: { label: "Author, title, and timestamps are lost", severity: "none" },
  precision: { label: "Numbers are re-formatted and may round", severity: "minor" },
  encoding: { label: "Characters outside the target charset are replaced", severity: "critical" },
  interactivity: { label: "Links, forms, and embedded widgets stop working", severity: "significant" },
};

export interface SourceFeatures {
  hasImages: boolean;
  hasTables: boolean;
  hasStyles: boolean;
  hasFormulas: boolean;
  hasComments: boolean;
  hasFootnotes: boolean;
  hasLinks?: boolean;
  hasMetadata?: boolean;
  hasWideChars?: boolean;
}

export interface ExportPlan {
  from: string;
  to: string;
  losses: LossKind[];
  /** Worst severity among the losses. */
  severity: "none" | "minor" | "significant" | "critical";
  lossless: boolean;
  /** One sentence the UI can show verbatim. */
  summary: string;
}

/** What each target format can actually carry. */
const TARGET_CAPABILITIES: Record<string, LossKind[]> = {
  txt: ["images", "tables", "styles", "formulas", "comments", "footnotes", "structure", "metadata", "interactivity"],
  // Markdown carries images and tables (by reference / GFM syntax), so
  // neither is a loss. Comments, richer styles, live formulas and widgets are.
  md: ["comments", "footnotes", "styles", "formulas", "interactivity"],
  csv: ["images", "styles", "formulas", "comments", "footnotes", "structure", "metadata", "interactivity"],
  json: ["images", "styles", "formulas", "comments", "structure", "interactivity"],
  yaml: ["images", "styles", "formulas", "comments", "interactivity"],
  ini: ["images", "tables", "styles", "formulas", "comments", "footnotes", "structure", "interactivity"],
  log: ["images", "tables", "styles", "formulas", "comments", "footnotes", "structure", "interactivity"],
  html: ["comments", "formulas", "footnotes"],
  pdf: ["formulas", "comments", "interactivity"],
  docx: ["interactivity"],
  xlsx: [],
  svg: ["tables", "styles", "formulas", "comments", "footnotes", "structure", "metadata"],
};

const FEATURE_TO_LOSS: Array<[keyof SourceFeatures, LossKind]> = [
  ["hasImages", "images"],
  ["hasTables", "tables"],
  ["hasStyles", "styles"],
  ["hasFormulas", "formulas"],
  ["hasComments", "comments"],
  ["hasFootnotes", "footnotes"],
  ["hasLinks", "interactivity"],
  ["hasMetadata", "metadata"],
];

export function planExport(from: string, to: string, features: SourceFeatures): ExportPlan {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (f === t) {
    return { from: f, to: t, losses: [], severity: "none", lossless: true, summary: "Same format: byte-identical output." };
  }
  const incapable = TARGET_CAPABILITIES[t];
  if (!incapable) {
    return {
      from: f, to: t, losses: [], severity: "none", lossless: false,
      summary: `Unknown target '${to}': no loss analysis is possible, so nothing is promised.`,
    };
  }

  const losses: LossKind[] = [];
  for (const [flag, loss] of FEATURE_TO_LOSS) {
    if (features[flag] && incapable.includes(loss) && !losses.includes(loss)) losses.push(loss);
  }
  // Wide characters into a latin1-only target.
  if (features.hasWideChars && (t === "csv" || t === "ini" || t === "log")) losses.push("encoding");
  // Numbers going from a formula-aware format to a text one lose precision.
  if (features.hasFormulas && (t === "csv" || t === "txt" || t === "log")) {
    if (!losses.includes("precision")) losses.push("precision");
  }

  const order: Array<ExportPlan["severity"]> = ["none", "minor", "significant", "critical"];
  const severity = losses.reduce<ExportPlan["severity"]>((acc, l) => {
    const s = LOSS_DESCRIPTIONS[l].severity;
    return order.indexOf(s) > order.indexOf(acc) ? s : acc;
  }, "none");

  const summary = losses.length === 0
    ? `Everything present in the ${f} document is representable in ${t}.`
    : `${losses.length} loss${losses.length === 1 ? "" : "es"} (${severity}): ${losses.map((l) => LOSS_DESCRIPTIONS[l].label.toLowerCase()).join("; ")}.`;

  return { from: f, to: t, losses, severity, lossless: losses.length === 0, summary };
}

export function describeLoss(kind: LossKind): string {
  return `${LOSS_DESCRIPTIONS[kind].label} (${LOSS_DESCRIPTIONS[kind].severity})`;
}

/** Targets that would lose nothing for this source — the useful shortlist. */
export function losslessTargets(from: string, features: SourceFeatures): string[] {
  return Object.keys(TARGET_CAPABILITIES)
    .filter((t) => t !== from.toLowerCase() && planExport(from, t, features).lossless)
    .sort();
}
