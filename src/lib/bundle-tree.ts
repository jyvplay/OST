/**
 * BK-07 — bundle contents explorer. Turns a built bundle's flat entry list
 * into the folder tree FM-19's rollup understands, so the Export pane can
 * show where a backup's bytes live before anyone downloads it. Directory
 * entries contribute structure, not bytes.
 */
import type { SizeNode } from "./folder-size";

export interface BundleEntryLike { path: string; kind: "file" | "dir"; size?: number }

export function bundleTree(entries: BundleEntryLike[]): SizeNode {
  const root: SizeNode = { path: "/", kind: "dir", children: [] };
  const dirs = new Map<string, SizeNode>([["/", root]]);
  const ensureDir = (path: string): SizeNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const parent = ensureDir(parentPath);
    const node: SizeNode = { path, kind: "dir", children: [] };
    parent.children!.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const e of entries) {
    const parentPath = e.path.slice(0, e.path.lastIndexOf("/")) || "/";
    if (e.kind === "dir") { ensureDir(e.path); continue; }
    ensureDir(parentPath).children!.push({ path: e.path, kind: "file", size: e.size });
  }
  return root;
}
