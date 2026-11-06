/**
 * TT136 (FM-14) — extension-facing file permissions.
 *
 * FM-14 allows an extension to mount a folder and copy/stream a file out. What
 * the extension may read has to be derived from a *grant*, not from "the
 * extension asked", otherwise a request that asks for a file it does not own
 * silently succeeds.
 *
 * Root of every path is the granted folder; `..` segments are normalised away,
 * and a grant never escapes its folder. Reads are byte-bounded and the
 * caller's own quota still applies.
 */

export type Permission = "read" | "write" | "list" | "execute" | "stream";

export interface Grant {
  /** Absolute, normalised folder the grant is rooted at. */
  folder: string;
  permissions: readonly Permission[];
  /** True for a grant scoped to one file rather than a folder. */
  fileOnly?: boolean;
}

export const PATH_MAX = 2_000;

export interface FileAccess {
  path: string;
  granted: boolean;
  permission: Permission | null;
  reason: string;
  /** Resolved absolute path when granted; the caller's security boundary. */
  resolved: string | null;
}

export function normalizePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > PATH_MAX) return null;
  const parts = raw.split("/").filter((p) => p !== "");
  if (raw.includes("\u0000")) return null;
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "..") {
      if (part === "..") { if (stack.length === 0) return null; stack.pop(); }
      continue;
    }
    stack.push(part);
  }
  return "/" + stack.join("/");
}

export function normalizeFolder(raw: string): string | null {
  const norm = normalizePath(raw);
  if (norm === null || norm === "/" || norm.endsWith("/")) return norm;
  return `${norm}/`;
}

export function isInside(folder: string, candidate: string): boolean {
  return candidate === folder || candidate.startsWith(folder);
}

export function check(grant: Grant, raw: string, want: Permission): FileAccess {
  if (!grant || typeof grant.folder !== "string" || grant.folder.length === 0) throw new Error("Grant needs a folder");
  const target = normalizePath(raw);
  if (target === null) return { path: raw, granted: false, permission: null, reason: "Path is malformed or too long", resolved: null };
  const granted = normalizeFolder(grant.folder);
  if (granted === null) return { path: target, granted: false, permission: null, reason: "Grant folder is malformed", resolved: null };
  if (!grant.permissions.includes(want)) return { path: target, granted: false, permission: null, reason: `${want} is not granted to this extension`, resolved: null };

  if (grant.fileOnly) {
    const owned = target === grant.folder || target === normalizePath(grant.folder);
    if (!owned) return { path: target, granted: false, permission: null, reason: "This grant covers one file only", resolved: null };
  } else if (!isInside(granted, target)) {
    return { path: target, granted: false, permission: null, reason: "Path is outside the granted folder", resolved: null };
  }
  // A grant never applies to its own metadata folder.
  if (target.endsWith("/.fusion") || target === "/.fusion" || target.startsWith("/.fusion/")) {
    return { path: target, granted: false, permission: null, reason: "App metadata is never exposed", resolved: null };
  }
  return { path: target, granted: true, permission: want, reason: `${want} granted under ${grant.folder}`, resolved: target };
}

/** Byte-bounded read gate: a grant allows a bounded read, never an unbounded one. */
export interface ReadResult { ok: boolean; bytes: number; reason: string }

export function boundedRead(grant: Grant, raw: string, maxBytes: number): ReadResult {
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 8 * 1024 * 1024) throw new Error("Read bound must be 0…8 MiB");
  const access = check(grant, raw, "read");
  if (!access.granted) return { ok: false, bytes: 0, reason: access.reason };
  return { ok: true, bytes: Math.min(maxBytes, 8 * 1024 * 1024), reason: `Read capped at ${maxBytes} bytes` };
}

/** Streaming is a different permission: an extension must ask for it explicitly. */
export interface StreamResult { ok: boolean; limitBytes: number; reason: string }

export function stream(grant: Grant, raw: string, requestedBytes: number): StreamResult {
  const access = check(grant, raw, "stream");
  if (!access.granted) return { ok: false, limitBytes: 0, reason: access.reason };
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0 || requestedBytes > 8 * 1024 * 1024) throw new Error("Stream request must be 1…8 MiB");
  return { ok: true, limitBytes: Math.min(requestedBytes, 8 * 1024 * 1024), reason: `Streaming up to ${requestedBytes} bytes` };
}

/** Compact audit line: what the extension got, in one string. */
export function describeGrant(grant: Grant, access: FileAccess): string {
  return `${access.granted ? "granted" : "denied"} ${access.permission ?? "none"} on ${access.path} — ${access.reason}`;
}

export function describeGrantSummary(grant: Grant, files: readonly FileAccess[]): string {
  const denied = files.filter((f) => !f.granted).length;
  return `${grant.folder} · ${grant.permissions.length} permission(s) · ${files.length - denied} granted, ${denied} denied`;
}
