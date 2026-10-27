/**
 * TT87 — FM-14 Drag & Drop core (pure, no DOM, no fetch, testable in Node).
 *
 * Fusion's drag payload is the custom MIME type `application/x-fusion-paths`
 * carrying a JSON array of VFS absolute paths. The same type is used
 * between Files windows, between Files and the desktop, and between Tabletop
 * walls — one code path, one security gate.
 *
 * Security: paths under /Private are ciphertext names. Leaking them to the
 * OS via DownloadURL would expose the host-visible (encrypted) name, and
 * leaking their content would break the privacy promise. Drag-out is therefore
 * refused for /Private entries; the UI must show “cannot drag private files
 * to the desktop” instead of silently doing nothing (the modal shortcut).
 *
 * OS interop:
 *  - Drag-out: where DataTransfer supports setData("DownloadURL") (Chromium)
 *    we set `mime:basename:origin/absolute/url`. The browser then offers a
 *    real file on the OS drop target. For multi-file drags we set only the
 *    drag image — DownloadURL supports one file and we must not pick a
 *    random one.
 *  - Drag-in: OS files arrive as File objects. Directories are recovered via
 *    webkitGetAsEntry() when present; the flat FileList fallback loses the
 *    tree but is still uploaded.
 *  - Text/URI drops: ignored (no silent file creation from a dragged link).
 *
 * Cross-window: Fusion windows share one browsing context (same origin, same
 * page). DataTransfer is the browser's own transport; we add no postMessage
 * bridge that could be spoofed from an embedded page (embed pages live in
 * an opaque origin and never receive the custom MIME type — see WP-02).
 */
export const DRAG_TYPE = "application/x-fusion-paths";
export const PRIVATE_ROOT = "/Private";

/** True if `p` is /Private or beneath it (the exact privacy boundary). */
export const isPrivatePath = (p: string) => p === PRIVATE_ROOT || p.startsWith(`${PRIVATE_ROOT}/`);

/** Normalised VFS absolute path check (same rule as /api/fs). */
export const isVfsPath = (p: string) => typeof p === "string" && p.startsWith("/") && !p.includes("\0") && !p.includes("//") && p !== "";

/** Parse the drag payload. Returns only valid absolute VFS paths; malformed JSON → []. */
export function parseFusionPaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && isVfsPath(x));
  } catch { return []; }
}

/** Serialise for setData — stable, minimal, no whitespace surprises. */
export const encodeFusionPaths = (paths: string[]) => JSON.stringify(paths);

/** Whether the selection may be offered to the OS (all paths outside /Private). */
export const canDragOut = (paths: string[]) => paths.length > 0 && paths.every((p) => !isPrivatePath(p));

/** DownloadURL value: “mime:filename:URL”. The URL is absolute so the OS fetch works even after navigation. */
export function downloadUrlValue(mime: string, name: string, url: string): string {
  // Chrome's format is mime:filename:url — colon in filename would break the split, so sanitise
  const safeName = name.replace(/[:/\\]/g, "_");
  const safeMime = mime && /^[a-z0-9\/\-\+\.]+$/i.test(mime) ? mime : "application/octet-stream";
  return `${safeMime}:${safeName}:${url}`;
}

/** File-drop classification returned by inspection of DataTransfer.types. */
export type DropKind = "fusion" | "files" | "mixed" | "none";
export function classifyDrop(types: readonly string[] | DOMStringList, hasFiles: boolean): DropKind {
  const hasFusion = Array.from(types as unknown as string[]).includes(DRAG_TYPE);
  if (hasFusion && hasFiles) return "mixed";
  if (hasFusion) return "fusion";
  if (hasFiles) return "files";
  return "none";
}

/**
 * Transfer intent — Ctrl (Win) / Alt (Mac) forces copy, otherwise move.
 * The caller passes e.ctrlKey || e.altKey. Keeping the rule in one place
 * prevents the Files pane and the desktop from diverging.
 */
export const intentFor = (copyKey: boolean) => (copyKey ? "copy" as const : "move" as const);

/** Guard: a drop target that is inside one of the dragged folders would create a cycle. */
export function dropCreatesCycle(dragged: string[], targetDir: string): boolean {
  const norm = (s: string) => (s.endsWith("/") ? s : s + "/");
  for (const p of dragged) {
    if (targetDir === p || targetDir.startsWith(norm(p))) return true;
  }
  return false;
}

/** Desktop drop directory — desktop icons live in /Documents in this build (visible on the desk). */
export const DESKTOP_DIR = "/Documents";

/** Human-readable refusal reasons for blocked drops (rendered in a toast/badge, never swallowed). */
export function refusalFor(paths: string[], target: string): string | null {
  if (!paths.length) return "Nothing to move.";
  if (target.startsWith("//") || /^\w+:/.test(target)) return null; // not a VFS drop
  if (dropCreatesCycle(paths, target)) return "Cannot move a folder into itself.";
  if (paths.some(isPrivatePath) && target === DESKTOP_DIR) return null; // private → desktop is allowed, the files stay private (same VFS)
  return null;
}

/** DataTransfer helpers that are testable without a real DataTransfer (the real handlers call these). */
export function shouldSetDownloadUrl(paths: string[], isPrivate: boolean): boolean {
  return paths.length === 1 && !isPrivate;
}

/** For multi-file OS drops we need to synthesise collision-free names when the FileList loses its tree. */
export function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (taken.has(`${stem} ${n}${ext}`)) n++;
  const out = `${stem} ${n}${ext}`;
  taken.add(out);
  return out;
}
