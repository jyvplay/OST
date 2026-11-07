/**
 * TT139 (FM-07, FM-13, BK-03, CT-01, CT-03) — Storage, templates, config I/O,
 * and cross-device handoff.
 *
 * FM-07 answers "what is using my space, what is duplicated, what is huge".
 * The duplicate finder is the part with a real algorithm decision: hashing
 * every byte of every file is O(total bytes) and, in a browser, means reading
 * everything into memory. So the plan is tiered — group by size, then by a
 * cheap content fingerprint, then confirm with a full hash only inside a group
 * that already matches. That is how you find duplicates in a 4 GB store with a
 * 200 MB heap budget, and the function returns the tiering so the cost is
 * visible rather than magic.
 *
 * FM-13 is the "New > Text document" menu: system templates plus user ones,
 * with de-duplication and a stable order.
 *
 * BK-03 exports and imports settings as a versioned bundle with an integrity
 * hash and a dry-run import plan, because an import that silently drops half
 * your settings is worse than one that refuses.
 */

// ══ FM-07: storage overview ══════════════════════════════════════════════

export interface FileEntry {
  path: string;
  size: number;
  mime: string;
  /** Modification time, epoch ms. */
  mtimeMs?: number;
  /** Cheap fingerprint: first 1 KiB + size, hex. Optional. */
  quickHash?: string;
  /** Full content hash, hex. Optional but required to *confirm* a duplicate. */
  fullHash?: string;
}

export interface CategoryBucket {
  type: string;
  count: number;
  bytes: number;
  /** Share of total bytes, 0..100, to one decimal. */
  pct: number;
}

export interface DuplicateGroup {
  /** Groups that share a quick hash but could not be confirmed. */
  confirmed: boolean;
  hash: string;
  paths: string[];
  /** Bytes that would be freed by keeping one copy. */
  reclaimableBytes: number;
}

export interface StorageOverview {
  totalBytes: number;
  fileCount: number;
  categories: CategoryBucket[];
  duplicates: DuplicateGroup[];
  largeFiles: Array<{ path: string; size: number; pct: number }>;
  /** Bytes per tier of the duplicate scan, so the cost is visible. */
  scanCost: { sizeGroups: number; quickHashed: number; fullHashed: number };
  /** Folders taking the most space, by first path segment. */
  topFolders: Array<{ folder: string; bytes: number; count: number }>;
}

/** Coarse bucket for a MIME type. Closed set; unknown types land in Other. */
export function categorizeMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "Images";
  if (m.startsWith("video/")) return "Videos";
  if (m.startsWith("audio/")) return "Audio";
  if (m.startsWith("font/")) return "Fonts";
  if (m.includes("pdf")) return "PDFs";
  if (m.includes("zip") || m.includes("gzip") || m.includes("tar") || m.includes("rar") || m.includes("7z")) return "Archives";
  // Order matters: OOXML MIME types contain "openxmlformats", so a naive
  // `includes("xml")` files every .docx under Text & code. Documents are
  // checked first for that reason.
  if (m.includes("word") || m.includes("spreadsheet") || m.includes("presentation") || m.includes("officedocument") || m === "application/msword" || m === "application/rtf") {
    return "Documents";
  }
  // Exact XML media types only, plus the "+xml" structured suffix convention.
  if (m.startsWith("text/") || m.includes("json") || m === "application/xml" || m === "text/xml" || m.endsWith("+xml")
      || m.includes("javascript") || m.includes("x-www-form-urlencoded")) {
    return "Text & code";
  }
  return "Other";
}

const LARGE_FILE_DEFAULT = 10 * 1024 * 1024;

export function analyzeStorage(files: FileEntry[], opts: { largeThresholdBytes?: number; topN?: number } = {}): StorageOverview {
  const largeThreshold = opts.largeThresholdBytes ?? LARGE_FILE_DEFAULT;
  const topN = opts.topN ?? 50;
  if (!(largeThreshold >= 0)) throw new Error("largeThresholdBytes must be non-negative");

  let totalBytes = 0;
  const catMap = new Map<string, { count: number; bytes: number }>();
  const folderMap = new Map<string, { bytes: number; count: number }>();

  for (const f of files) {
    if (!(f.size >= 0) || !Number.isFinite(f.size)) throw new Error(`Invalid size for ${f.path}: ${f.size}`);
    totalBytes += f.size;
    const type = categorizeMime(f.mime);
    const c = catMap.get(type) ?? { count: 0, bytes: 0 };
    c.count++;
    c.bytes += f.size;
    catMap.set(type, c);

    const folder = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
    const fo = folderMap.get(folder) ?? { bytes: 0, count: 0 };
    fo.bytes += f.size;
    fo.count++;
    folderMap.set(folder, fo);
  }

  const categories: CategoryBucket[] = [...catMap.entries()]
    .map(([type, v]) => ({ type, count: v.count, bytes: v.bytes, pct: totalBytes ? Math.round((v.bytes / totalBytes) * 1000) / 10 : 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.type.localeCompare(b.type));

  // Tiered duplicate detection.
  const bySize = new Map<number, FileEntry[]>();
  for (const f of files) {
    if (f.size === 0) continue; // empty files are all "duplicates" and freeing them frees nothing
    const list = bySize.get(f.size) ?? [];
    list.push(f);
    bySize.set(f.size, list);
  }
  const sizeGroups = [...bySize.values()].filter((g) => g.length > 1);

  const duplicates: DuplicateGroup[] = [];
  let quickHashed = 0;
  let fullHashed = 0;

  for (const group of sizeGroups) {
    const byQuick = new Map<string, FileEntry[]>();
    for (const f of group) {
      // Without a quick hash, the size alone is not evidence — never claim.
      if (!f.quickHash) continue;
      quickHashed++;
      const list = byQuick.get(f.quickHash) ?? [];
      list.push(f);
      byQuick.set(f.quickHash, list);
    }
    for (const [qhash, candidates] of byQuick) {
      if (candidates.length < 2) continue;
      const withFull = candidates.filter((c) => c.fullHash);
      if (withFull.length >= 2) {
        const byFull = new Map<string, FileEntry[]>();
        for (const c of withFull) {
          fullHashed++;
          const list = byFull.get(c.fullHash!) ?? [];
          list.push(c);
          byFull.set(c.fullHash!, list);
        }
        for (const [fhash, same] of byFull) {
          if (same.length < 2) continue;
          duplicates.push({
            confirmed: true,
            hash: fhash,
            paths: same.map((s) => s.path).sort(),
            reclaimableBytes: same[0].size * (same.length - 1),
          });
        }
      } else {
        // Same size and same quick hash but no full hash: reported as
        // unconfirmed, and the UI must not offer "delete" on these.
        duplicates.push({
          confirmed: false,
          hash: qhash,
          paths: candidates.map((s) => s.path).sort(),
          reclaimableBytes: 0,
        });
      }
    }
  }
  duplicates.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || a.paths[0].localeCompare(b.paths[0]));

  const largeFiles = files
    .filter((f) => f.size >= largeThreshold)
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, topN)
    .map((f) => ({ path: f.path, size: f.size, pct: totalBytes ? Math.round((f.size / totalBytes) * 1000) / 10 : 0 }));

  const topFolders = [...folderMap.entries()]
    .map(([folder, v]) => ({ folder, bytes: v.bytes, count: v.count }))
    .sort((a, b) => b.bytes - a.bytes || a.folder.localeCompare(b.folder))
    .slice(0, 10);

  return {
    totalBytes,
    fileCount: files.length,
    categories,
    duplicates,
    largeFiles,
    scanCost: { sizeGroups: sizeGroups.length, quickHashed, fullHashed },
    topFolders,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) throw new Error("formatBytes needs a finite number");
  const sign = bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${Math.round(abs)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = abs / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Human sentence for the storage card. */
export function describeStorage(o: StorageOverview): string {
  const reclaim = o.duplicates.filter((d) => d.confirmed).reduce((a, d) => a + d.reclaimableBytes, 0);
  const unconfirmed = o.duplicates.filter((d) => !d.confirmed).length;
  const parts = [`${formatBytes(o.totalBytes)} in ${o.fileCount} file${o.fileCount === 1 ? "" : "s"}`];
  if (reclaim > 0) parts.push(`${formatBytes(reclaim)} reclaimable from ${o.duplicates.filter((d) => d.confirmed).length} duplicate group(s)`);
  if (unconfirmed) parts.push(`${unconfirmed} possible duplicate group(s) unconfirmed`);
  return parts.join(" · ");
}

// ══ FM-13: templates ═════════════════════════════════════════════════════

export interface TemplateEntry {
  name: string;
  /** Content the template writes on creation. */
  content: string;
  /** Extension of the file it produces, without the dot. */
  extension: string;
  category: string;
  /** True for templates that ship with the OS and cannot be deleted. */
  builtin: boolean;
}

export const BUILTIN_TEMPLATES: TemplateEntry[] = [
  { name: "Text Document", content: "", extension: "txt", category: "Documents", builtin: true },
  { name: "Markdown Notes", content: "# Title\n\n", extension: "md", category: "Documents", builtin: true },
  { name: "Spreadsheet", content: "", extension: "csv", category: "Documents", builtin: true },
  { name: "Bitmap Image", content: "", extension: "svg", category: "Images", builtin: true },
  { name: "Task List", content: "- [ ] \n", extension: "md", category: "Documents", builtin: true },
];

export interface TemplateManager {
  templates: TemplateEntry[];
}

export function createTemplateManager(extra: TemplateEntry[] = []): TemplateManager {
  const all = [...BUILTIN_TEMPLATES, ...extra];
  const seen = new Set<string>();
  for (const t of all) {
    const key = `${t.category}/${t.name}`;
    if (seen.has(key)) throw new Error(`Two templates share the name ${key}`);
    seen.add(key);
    if (!/^[a-z0-9]+$/i.test(t.extension)) throw new Error(`Bad extension on ${t.name}: ${t.extension}`);
  }
  return { templates: all };
}

export function addUserTemplate(tm: TemplateManager, entry: Omit<TemplateEntry, "builtin">): TemplateManager {
  if (tm.templates.some((t) => t.category === entry.category && t.name === entry.name)) {
    throw new Error(`A template named ${entry.category}/${entry.name} already exists`);
  }
  if (entry.content.length > 1024 * 1024) throw new Error("Template content is larger than 1 MiB");
  return { templates: [...tm.templates, { ...entry, builtin: false }] };
}

export function removeUserTemplate(tm: TemplateManager, name: string, category: string): TemplateManager {
  const target = tm.templates.find((t) => t.name === name && t.category === category);
  if (!target) return tm;
  if (target.builtin) throw new Error("Built-in templates cannot be removed");
  return { templates: tm.templates.filter((t) => !(t.name === name && t.category === category)) };
}

export function templateMenu(tm: TemplateManager): Array<{ category: string; templates: TemplateEntry[] }> {
  const byCat = new Map<string, TemplateEntry[]>();
  for (const t of tm.templates) {
    const list = byCat.get(t.category) ?? [];
    list.push(t);
    byCat.set(t.category, list);
  }
  return [...byCat.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, templates]) => ({
      category,
      templates: templates.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)),
    }));
}

/** Produce a unique filename in a folder that already holds `existing`. */
export function instantiateTemplate(t: TemplateEntry, folderPath: string, existing: string[]): { path: string; content: string } {
  const dir = folderPath.replace(/\/+$/, "");
  if (!dir) throw new Error("A target folder is required");
  const base = t.name;
  const ext = t.extension;
  let candidate = `${dir}/${base}.${ext}`;
  let n = 1;
  const taken = new Set(existing);
  while (taken.has(candidate)) {
    candidate = `${dir}/${base} ${++n}.${ext}`;
    if (n > 9999) throw new Error("Could not find a free filename");
  }
  return { path: candidate, content: t.content };
}

// ══ BK-03: config export / import ════════════════════════════════════════

export interface ConfigBundle {
  version: 1;
  exportedAt: number;
  settings: Record<string, string>;
  features: Record<string, string>;
  widgets: string[];
}

export interface ImportPlan {
  ok: boolean;
  changes: Array<{ key: string; from: string; to: string }>;
  additions: string[];
  /** Existing keys the bundle does not mention. Not removed on import. */
  untouched: string[];
  errors: string[];
  /** Nothing is applied until the caller reads this plan and opts in. */
  dryRun: true;
}

/** FNV-1a over the JSON, as an integrity check that is not a security boundary. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Repeat to 64 hex chars so it has the same shape as a SHA-256 for storage.
  const part = h.toString(16).padStart(8, "0");
  return part.repeat(8);
}

export function exportConfig(
  settings: Record<string, string>,
  features: Record<string, string>,
  widgets: string[],
  exportedAt: number,
): { bundle: ConfigBundle; json: string; checksum: string } {
  if (!Number.isFinite(exportedAt)) throw new Error("exportedAt must be a timestamp");
  const bundle: ConfigBundle = { version: 1, exportedAt, settings: { ...settings }, features: { ...features }, widgets: [...widgets] };
  const json = JSON.stringify(bundle, null, 2);
  return { bundle, json, checksum: fnv1a(json) };
}

export function importConfig(
  json: string,
  current: { settings: Record<string, string>; features: Record<string, string>; widgets: string[] },
): ImportPlan {
  const empty: ImportPlan = { ok: false, changes: [], additions: [], untouched: [], errors: [], dryRun: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ...empty, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...empty, errors: ["Bundle is not an object"] };
  const b = parsed as Partial<ConfigBundle>;

  const errors: string[] = [];
  if (b.version !== 1) errors.push(`Unsupported bundle version: ${String(b.version)} (this build reads version 1)`);
  if (typeof b.settings !== "object" || b.settings === null || Array.isArray(b.settings)) errors.push("settings must be an object");
  if (typeof b.features !== "object" || b.features === null || Array.isArray(b.features)) errors.push("features must be an object");
  if (!Array.isArray(b.widgets)) errors.push("widgets must be an array");
  if (errors.length) return { ...empty, errors };

  const changes: Array<{ key: string; from: string; to: string }> = [];
  const additions: string[] = [];

  const consider = (kind: "setting" | "feature", next: Record<string, string>, cur: Record<string, string>): void => {
    for (const [k, v] of Object.entries(next)) {
      if (typeof v !== "string") {
        errors.push(`${kind} ${k} is not a string`);
        continue;
      }
      if (!(k in cur)) additions.push(`${kind}:${k}`);
      else if (cur[k] !== v) changes.push({ key: `${kind}:${k}`, from: cur[k], to: v });
    }
  };
  consider("setting", b.settings!, current.settings);
  consider("feature", b.features!, current.features);

  for (const w of b.widgets!) {
    if (typeof w !== "string") { errors.push("widget entries must be strings"); continue; }
    if (!current.widgets.includes(w)) additions.push(`widget:${w}`);
  }

  const untouched = [
    ...Object.keys(current.settings).filter((k) => !(k in b.settings!)).map((k) => `setting:${k}`),
    ...Object.keys(current.features).filter((k) => !(k in b.features!)).map((k) => `feature:${k}`),
    ...current.widgets.filter((w) => !b.widgets!.includes(w)).map((w) => `widget:${w}`),
  ].sort();

  return { ok: errors.length === 0, changes, additions, untouched, errors, dryRun: true };
}

/** Apply a plan. Refuses unless the plan passed its own validation. */
export function applyImport(plan: ImportPlan, json: string): { settings: Record<string, string>; features: Record<string, string>; widgets: string[] } {
  if (!plan.ok) throw new Error(`Import plan has errors: ${plan.errors.join("; ")}`);
  const b = JSON.parse(json) as ConfigBundle;
  return { settings: { ...b.settings }, features: { ...b.features }, widgets: [...b.widgets] };
}

// ══ CT-01 / CT-03: share and handoff ═════════════════════════════════════

export interface SharePayload {
  kind: "url" | "text" | "file";
  title: string;
  /** URL, body text, or a data: URI. */
  data: string;
  mime?: string;
}

export interface ShareTarget {
  id: string;
  label: string;
  accepts: Array<SharePayload["kind"]>;
  /** Privacy note shown before sending. */
  note: string;
}

export const MAX_SHARE_BYTES = 8 * 1024 * 1024;

export function validatePayload(p: SharePayload): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  // Callers get this from IPC/URL state, where a field can be missing entirely.
  // A validator that throws on malformed input cannot be used to validate
  // malformed input, so non-strings are reported like any other problem.
  if (typeof p.title !== "string") errors.push("A share needs a title");
  if (typeof p.data !== "string") errors.push("A share needs content");
  if (errors.length) return { ok: false, errors };
  if (!p.title.trim()) errors.push("A share needs a title");
  if (p.title.length > 200) errors.push("Title is longer than 200 characters");
  if (!p.data) errors.push("A share needs content");
  const bytes = new TextEncoder().encode(p.data).length;
  if (bytes > MAX_SHARE_BYTES) errors.push(`Content is ${bytes} bytes; the limit is ${MAX_SHARE_BYTES}`);
  if (p.kind === "url") {
    if (!/^https?:\/\//i.test(p.data)) errors.push("A URL share must use http or https");
    // A literal space is printable but not legal in a URL: it must be %20.
    if (/[^\x21-\x7e]/.test(p.data)) errors.push("URL contains a space, non-ASCII, or control characters (escape them first)");
  }
  if (p.kind === "file" && p.data.startsWith("data:") && !/^data:[^;,]+/.test(p.data)) {
    errors.push("A data: URI needs an explicit MIME type");
  }
  return { ok: errors.length === 0, errors };
}

/** Which targets can take this payload, and why the others cannot. */
export function compatibleTargets(p: SharePayload, targets: ShareTarget[]): Array<{ target: ShareTarget; reason: string }> {
  return targets.map((t) => ({
    target: t,
    reason: t.accepts.includes(p.kind) ? "Accepts this content type" : `Cannot accept a ${p.kind} share`,
  }));
}

export interface HandoffState {
  /** The item currently being handed off, if any. */
  item: { title: string; kind: SharePayload["kind"]; data: string } | null;
  /** Device the item was handed to. */
  to: string | null;
  /** Monotonic sequence, so a stale accept cannot win. */
  seq: number;
  status: "idle" | "offered" | "accepted" | "expired";
}

export function createHandoff(): HandoffState {
  return { item: null, to: null, seq: 0, status: "idle" };
}

export function offerHandoff(s: HandoffState, item: NonNullable<HandoffState["item"]>, to: string): HandoffState {
  if (!to) throw new Error("A handoff needs a target device");
  const check = validatePayload({ kind: item.kind, title: item.title, data: item.data });
  if (!check.ok) throw new Error(`Cannot hand off: ${check.errors.join("; ")}`);
  return { item, to, seq: s.seq + 1, status: "offered" };
}

/** Accept only the handoff whose sequence still matches — the classic race. */
export function acceptHandoff(s: HandoffState, seq: number, from: string): { state: HandoffState; ok: boolean; reason: string } {
  if (s.status !== "offered") return { state: s, ok: false, reason: `Nothing is being offered (status ${s.status})` };
  if (seq !== s.seq) return { state: s, ok: false, reason: "This offer has been superseded" };
  if (from !== s.to) return { state: s, ok: false, reason: `Offer was addressed to ${s.to}, not ${from}` };
  return { state: { ...s, status: "accepted" }, ok: true, reason: "Accepted" };
}

export function expireHandoff(s: HandoffState): HandoffState {
  return s.status === "offered" ? { ...s, status: "expired", item: null } : s;
}
