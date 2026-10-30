/**
 * FM-19 — recursive folder size over the VFS tree. Counts bytes and entries
 * per folder subtree so "where did the space go" is answerable without
 * opening Storage. A node whose size is unknown (undefined) is counted as
 * unknown, not as zero — the two are reported separately.
 */
export interface SizeNode { path: string; kind: "file" | "dir"; size?: number; children?: SizeNode[] }
export interface FolderSize { path: string; bytes: number; files: number; dirs: number; unknown: number }

export function folderSizes(root: SizeNode): FolderSize[] {
  const out: FolderSize[] = [];
  const walk = (n: SizeNode): FolderSize => {
    if (n.kind === "file") {
      const leaf: FolderSize = { path: n.path, bytes: typeof n.size === "number" ? n.size : 0, files: 1, dirs: 0, unknown: typeof n.size === "number" ? 0 : 1 };
      out.push(leaf);
      return leaf;
    }
    const acc: FolderSize = { path: n.path, bytes: 0, files: 0, dirs: 1, unknown: 0 };
    for (const c of n.children ?? []) {
      const sub = walk(c);
      acc.bytes += sub.bytes; acc.files += sub.files; acc.dirs += sub.dirs; acc.unknown += sub.unknown;
    }
    out.push(acc);
    return acc;
  };
  walk(root);
  return out.sort((a, b) => b.bytes - a.bytes);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
