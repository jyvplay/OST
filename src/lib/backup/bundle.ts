/**
 * Portable Fusion backup format. This module runs unchanged in the browser and Node.
 * A SHA-256 checksum detects accidental modification but is NOT a signature or MAC:
 * anyone who can change an unencrypted bundle can recompute it. Encrypted downloads
 * use AES-GCM separately; the passphrase and decryption stay in the browser.
 */
export const BACKUP_VERSION = "fusion-bundle-2" as const;
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface BackupEntry {
  path: string;
  kind: "file" | "dir";
  mime: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
  tags: string;
  /** Hash of the UTF-8 encoding of the stored content string (base64 text for binary files). */
  sha256: string;
}
export interface BackupNote {
  title: string;
  body: string;
  tags: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface BackupSetting { key: string; value: string }
export interface BackupPayload {
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  kind: "data" | "config";
  entries: BackupEntry[];
  notes: BackupNote[];
  settings: BackupSetting[];
}
export interface BackupBundle extends BackupPayload {
  manifest: { algorithm: "SHA-256"; sha256: string };
}
export interface BackupFailure { path: string; reason: string }
export type BackupVerification =
  | { ok: true; payload: BackupPayload; digest: string; legacy: boolean; warnings: string[] }
  | { ok: false; failures: BackupFailure[] };

/** Stable across JSON object key order; array order is meaningful. Only JSON values are accepted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("not a JSON value");
}

export async function digestText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function makeBackup(payload: BackupPayload): Promise<BackupBundle> {
  return { ...payload, manifest: { algorithm: "SHA-256", sha256: await digestText(canonicalJson(payload)) } };
}

const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
// PostgreSQL stores UTF-8, so reject lone UTF-16 surrogates rather than silently replacing them on write.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max && !x.includes("\0") && !loneSurrogate.test(x);
const exactKeys = (x: Record<string, unknown>, keys: readonly string[]) => {
  const got = Object.keys(x);
  return got.length === keys.length && keys.every((key) => Object.hasOwn(x, key));
};
const validTime = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && !x.startsWith("0000-") && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString() === x;
const safePath = (p: unknown): p is string => text(p, 2048) && p.startsWith("/") && p !== "/" && !/[\u0000-\u001f\u007f]/.test(p)
  && p.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..") && p.split("/").length <= 65;

/** The number of actual file bytes, not the number of base64 characters. */
export function contentSize(content: string, encoding: "utf8" | "base64"): number {
  if (encoding === "utf8") return new TextEncoder().encode(content).byteLength;
  if (!BASE64.test(content)) return -1;
  return (content.length / 4) * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
}

const failure = (path: string, reason: string): BackupVerification => ({ ok: false, failures: [{ path, reason }] });

/**
 * Validate types, limits, hierarchy, and all checksums before exposing a restore payload.
 * Legacy v1 can only protect file-content strings: removed entries, names, metadata,
 * notes and settings were never covered. Callers MUST warn and require consent.
 */
export async function verifyBackup(input: unknown): Promise<BackupVerification> {
  if (!object(input)) return failure("bundle", "expected a JSON object");
  const legacy = input.version === "fusion-bundle-1";
  if (!legacy && input.version !== BACKUP_VERSION) return failure("bundle", "unknown bundle version");
  if (!validTime(input.exportedAt)) return failure("bundle", "invalid export timestamp");
  if (input.kind !== "data" && input.kind !== "config") return failure("bundle", "invalid bundle kind");
  if (!Array.isArray(input.entries) || input.entries.length > MAX_RECORDS) return failure("entries", "missing or too many entries");
  if (!legacy && (!Array.isArray(input.notes) || !Array.isArray(input.settings))) return failure("bundle", "notes and settings arrays are required");
  const rawNotes = input.notes === undefined && legacy ? [] : input.notes;
  const rawSettings = input.settings === undefined && legacy ? [] : input.settings;
  if (!Array.isArray(rawNotes) || !Array.isArray(rawSettings) || rawNotes.length > MAX_RECORDS || rawSettings.length > MAX_RECORDS) return failure("bundle", "invalid or oversized notes/settings array");
  const warnings = legacy ? ["Legacy v1 checks only file content: removed entries, paths, metadata, notes and settings are not protected. Inspect its source before restoring."] : [];
  const legacyManifest = new Map<string, { sha256: string; size: number }>();
  if (legacy) {
    if (!Array.isArray(input.manifest) || input.manifest.length > MAX_RECORDS) return failure("manifest", "legacy manifest is missing or invalid");
    for (const m of input.manifest) {
      if (!object(m) || !safePath(m.path) || typeof m.sha256 !== "string" || !HEX.test(m.sha256) || !Number.isSafeInteger(m.size) || (m.size as number) < 0 || legacyManifest.has(m.path)) return failure("manifest", "invalid or duplicate legacy manifest entry");
      legacyManifest.set(m.path, { sha256: m.sha256, size: m.size as number });
    }
  } else if (!object(input.manifest) || !exactKeys(input.manifest, ["algorithm", "sha256"]) || input.manifest.algorithm !== "SHA-256" || typeof input.manifest.sha256 !== "string" || !HEX.test(input.manifest.sha256)) {
    return failure("manifest", "missing or invalid bundle checksum");
  }
  const entries: BackupEntry[] = [];
  const paths = new Map<string, "file" | "dir">();
  for (const raw of input.entries) {
    if (!object(raw) || !safePath(raw.path)) return failure("entries", "entry has an unsafe or invalid path");
    const path = raw.path;
    if (paths.has(path)) return failure(path, "duplicate path");
    if (!legacy && !exactKeys(raw, ["path", "kind", "mime", "encoding", "content", "size", "tags", "sha256"])) return failure(path, "unexpected or missing entry fields");
    if ((raw.kind !== "file" && raw.kind !== "dir") || (raw.encoding !== "utf8" && raw.encoding !== "base64")) return failure(path, "invalid kind or encoding");
    if (!text(raw.mime, 256) || raw.mime.length === 0 || /[\u0000-\u001f\u007f]/.test(raw.mime) || !text(raw.content, MAX_BACKUP_BYTES) || !text(legacy ? raw.tags ?? "" : raw.tags, 65_536)) return failure(path, "invalid metadata or content");
    const size = contentSize(raw.content, raw.encoding);
    if (size < 0 || size > MAX_FILE_BYTES) return failure(path, "invalid base64 or file exceeds 8 MiB");
    if (raw.kind === "dir" && (raw.content !== "" || raw.encoding !== "utf8" || raw.mime !== "inode/directory")) return failure(path, "invalid directory contents or metadata");
    if (!legacy && (!Number.isSafeInteger(raw.size) || raw.size !== size)) return failure(path, "file byte count does not match content");
    const sha256 = await digestText(raw.content);
    if (legacy) {
      const m = legacyManifest.get(path);
      if (!m || m.sha256 !== sha256 || m.size !== raw.content.length || (raw.sha256 && raw.sha256 !== sha256)) return failure(path, "legacy manifest or content digest mismatch");
    } else if (raw.sha256 !== sha256) return failure(path, "content digest mismatch");
    paths.set(path, raw.kind);
    entries.push({ path, kind: raw.kind, mime: raw.mime, encoding: raw.encoding, content: raw.content, size, tags: (raw.tags ?? "") as string, sha256 });
  }
  if (legacy && legacyManifest.size !== entries.length) return failure("manifest", "legacy manifest and entries do not match");
  for (const entry of entries) {
    let at = entry.path.lastIndexOf("/");
    while (at > 0) {
      const parent = entry.path.slice(0, at);
      if (paths.get(parent) === "file") return failure(entry.path, `parent ${parent} is a file in the bundle`);
      at = parent.lastIndexOf("/");
    }
  }
  const notes: BackupNote[] = [];
  for (const n of rawNotes) {
    if (!object(n) || (!legacy && !exactKeys(n, ["title", "body", "tags", "pinned", "createdAt", "updatedAt"])) || !text(n.title, 65_536) || !text(n.body, MAX_FILE_BYTES) || !text(n.tags, 65_536) || typeof n.pinned !== "boolean" || !validTime(n.createdAt) || !validTime(n.updatedAt)) return failure("notes", "invalid note or timestamp");
    notes.push({ title: n.title, body: n.body, tags: n.tags, pinned: n.pinned, createdAt: n.createdAt, updatedAt: n.updatedAt });
  }
  const settings: BackupSetting[] = [];
  const keys = new Set<string>();
  for (const s of rawSettings) {
    if (!object(s) || (!legacy && !exactKeys(s, ["key", "value"])) || !text(s.key, 256) || !s.key || !text(s.value, MAX_FILE_BYTES) || keys.has(s.key)) return failure("settings", "invalid or duplicate setting");
    keys.add(s.key); settings.push({ key: s.key, value: s.value });
  }
  if (input.kind === "config" && (entries.length || notes.length)) return failure("bundle", "config bundle must not contain files or notes");
  if (!legacy && input.kind === "data" && settings.length) return failure("bundle", "data bundle must not contain settings");
  if (legacy && input.kind === "data" && settings.length) {
    warnings.push("Settings in a legacy data bundle are ignored; restore a config bundle to change settings.");
    settings.length = 0;
  }
  const payload: BackupPayload = { version: BACKUP_VERSION, exportedAt: input.exportedAt, kind: input.kind, entries, notes, settings };
  const digest = await digestText(canonicalJson(payload));
  if (!legacy && (input.manifest as { sha256: string }).sha256 !== digest) return failure("manifest", "bundle checksum mismatch (contents or metadata changed)");
  return { ok: true, payload, digest, legacy, warnings };
}
