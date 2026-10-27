"use client";
/**
 * TT55 — one Files pane (FM-01/02/03/05/06/09/13/15/16/17, SH-09). The Files module (Files.tsx) hosts one or two of
 * these plus tabs and an optional terminal pane. Everything the TT24–TT54 single-pane module did is kept: list /
 * grid views, thumbnails, hidden files, the Info (metadata) panel, Trash with restore / purge, the journal strip,
 * every context action (open / edit / Photos / rename / duplicate / move / tag / copy path / compress / extract /
 * remove metadata / encrypt / decrypt), upload, batch rename, Terminal here and the keyboard listbox.
 *
 * Added: back AND forward history (toolbar, Alt+←/→, Backspace, mouse buttons 4/5 — handled and swallowed so the
 * browser tab never navigates), clickable breadcrumbs with an editable path, a folder tree, true column (Miller)
 * view, sortable headers, a selection toolbar (count · size · copy / cut / to other pane / compress / tag / trash),
 * Shift-range and Ctrl+A selection, Ctrl+C / X / V, Delete, F2, F5 / F6 (copy / move to the other pane), drag and
 * drop between rows, panes and the tree (Ctrl or Alt = copy) plus OS files dropped in = upload, one context-menu
 * model with concise / full sets and type-to-search (FM-06), a background menu with New ▸ templates and Paste
 * (FM-13), background folder sizes (FM-17), deep name search (FM-16) and honest origin badges (FM-09 / DP-03).
 */
import { fz } from "@/lib/uiscale";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type MouseEvent as RMouseEvent } from "react";
import { createPortal } from "react-dom";
import { api, fmtBytes, fmtTime, post, queuedFsWrites } from "@/lib/api";
import { cleanVfsFile } from "@/lib/privacy/cleanfile";
import { isPrivatePath } from "@/lib/privacy/pcrypt";
import { appForFile } from "@/lib/open-with";
import { formatFor } from "@/lib/forge";
import { fromB64, open, seal, toB64, type Envelope } from "@/lib/crypto";
import { useShell } from "../shell-context";
import { guardedButtons, mouseConfigFrom, navActionFor } from "@/lib/input";
import { Badge, Btn, Empty } from "../ui";
import { FileIcon, UiGlyph } from "../AppIcon";
import { askText, askForm } from "@/lib/ask";
import Thumb from "../Thumb";
import { photoOfSidecar } from "@/lib/photos/recipe";
import { readFileBytes } from "@/lib/thumbs/service";
import {
  badName, baseName, clickSelect, copyName, crumbs, emptySel, goBack, goForward, hist, joinPath, keySelect, menuView,
  navigate, parentPath, pruneSel, selectAll, sortNodes, type Hist, type MenuItem, type Sel, type SortKey,
} from "@/lib/files/model";
import { getClip, setClip, subscribeClip } from "@/lib/files/clipboard";

export interface FNode {
  path: string; name: string; kind: string; mime: string; size: number; sha256: string;
  tags: string; trashed: boolean; version: number; updatedAt: string;
}
interface Job { id: number; op: string; src: string; dst: string; state: string; error: string }
type View = "list" | "grid" | "column";
const DRAG_TYPE = "application/x-fusion-paths";
const TEMPLATES = "/System/Templates";

/* FM-17: folder sizes are computed server-side (one SUM over the subtree) in the background, two at a time, and
 * cached per refresh tick — a write anywhere bumps the tick, so a cached size is never older than the last write. */
const sizeCache = new Map<string, { tick: number; bytes: number; files: number; dirs: number }>();
const sizeWaiters = new Map<string, Promise<void>>();
let sizeActive = 0;
const sizeQueue: (() => void)[] = [];
const slot = () => new Promise<void>((res) => { if (sizeActive < 2) { sizeActive += 1; res(); } else sizeQueue.push(() => { sizeActive += 1; res(); }); });
const release = () => { sizeActive -= 1; sizeQueue.shift()?.(); };
function folderSize(path: string, tick: number): Promise<void> {
  const c = sizeCache.get(path);
  if (c && c.tick === tick) return Promise.resolve();
  const key = `${path}@${tick}`;
  const w = sizeWaiters.get(key);
  if (w) return w;
  const p = (async () => {
    await slot();
    try {
      const r = await api<{ folder: { bytes: number; files: number; dirs?: number } | null }>(`/api/fs?op=stat&path=${encodeURIComponent(path)}`);
      if (r.folder) sizeCache.set(path, { tick, bytes: r.folder.bytes, files: r.folder.files, dirs: r.folder.dirs ?? 0 });
    } finally { release(); sizeWaiters.delete(key); }
  })();
  sizeWaiters.set(key, p);
  return p;
}

export interface PaneProps {
  paneId: string;
  initialPath: string;
  initialTrash?: boolean;
  active: boolean;
  onActivate: () => void;
  reportId: string;
  onCwd: (id: string, path: string, trash: boolean) => void;
  /** open a folder in a new tab of the hosting Files window */
  onOpenTab?: (path: string) => void;
  /** the other pane's folder in dual-pane mode (target of F5 / F6 and "… to other pane") */
  otherCwd: string | null;
  showTree: boolean;
}

export default function FilesPane({ paneId, initialPath, initialTrash, active, onActivate, reportId, onCwd, onOpenTab, otherCwd, showTree }: PaneProps) {
  const shell = useShell();
  const [h, setH] = useState<Hist>(() => hist(initialPath || "/"));
  const cwd = h.cur;
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [nodes, setNodes] = useState<FNode[]>([]);
  const [sel, setSel] = useState<Sel>(emptySel);
  const [filter, setFilter] = useState("");
  const [deep, setDeep] = useState(false);
  const [deepHits, setDeepHits] = useState<{ q: string; nodes: FNode[]; truncated: boolean } | null>(null);
  const [view, setView] = useState<View>("list");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [showTrash, setShowTrash] = useState(initialTrash === true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: FNode | null; query: string; full: boolean } | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [info, setInfo] = useState<{ path: string; rows: [string, string][]; error?: string } | null>(null);
  const [sizes, setSizes] = useState(0); // bumps when a background folder size lands
  const [tree, setTree] = useState<string[]>([]);
  const [cols, setCols] = useState<Record<string, FNode[]>>({});
  const [templates, setTemplates] = useState<FNode[] | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [queued, setQueued] = useState(() => queuedFsWrites());
  const clip = useSyncExternalStore(subscribeClip, getClip, () => null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tick = shell.refreshTick;

  const fetchAll = useCallback(async () => {
    const r = showTrash
      ? await api<{ nodes: FNode[] }>("/api/fs?op=trash")
      : await api<{ nodes: FNode[] }>(`/api/fs?op=list&path=${encodeURIComponent(cwd)}`);
    const j = await api<{ ops: Job[] }>("/api/jobs?limit=8");
    return { nodes: r.nodes, ops: j.ops };
  }, [cwd, showTrash]);
  const load = useCallback(async () => {
    try { const d = await fetchAll(); setNodes(d.nodes); setJobs(d.ops); setQueued(queuedFsWrites()); }
    catch (e) { shell.toast(String((e as Error).message), "bad"); }
  }, [fetchAll, shell]);
  // the live-guard also stops a slow listing of the previous folder from overwriting the current one
  useEffect(() => {
    let live = true;
    fetchAll().then((d) => { if (live) { setNodes(d.nodes); setJobs(d.ops); setQueued(queuedFsWrites()); } })
      .catch((e: unknown) => { if (live) shell.toast(String((e as Error).message), "bad"); });
    return () => { live = false; };
  }, [fetchAll, shell, tick]);
  useEffect(() => { onCwd(reportId, cwd, showTrash); }, [reportId, cwd, showTrash, onCwd]);

  // folder tree (op=tree) — fetched when shown and after every write
  useEffect(() => {
    if (!showTree) return;
    let live = true;
    void api<{ dirs: string[] }>("/api/fs?op=tree").then((r) => { if (live) setTree(r.dirs); }).catch(() => undefined);
    return () => { live = false; };
  }, [showTree, tick]);

  // column view: one listing per ancestor of the current folder
  const ancestors = useMemo(() => crumbs(cwd).map(([, p]) => p).slice(0, -1), [cwd]);
  useEffect(() => {
    if (view !== "column" || showTrash) return;
    let live = true;
    void Promise.all(ancestors.map((p) => api<{ nodes: FNode[] }>(`/api/fs?op=list&path=${encodeURIComponent(p)}`).then((r) => [p, r.nodes] as const)))
      .then((pairs) => { if (live) setCols(Object.fromEntries(pairs)); }).catch(() => undefined);
    return () => { live = false; };
  }, [view, showTrash, ancestors, tick]);

  // deep (subfolder) name search, debounced
  useEffect(() => {
    const q = filter.trim();
    if (!deep || !q || showTrash) return;
    let live = true;
    const t = window.setTimeout(() => {
      void api<{ nodes: FNode[]; truncated: boolean }>(`/api/fs?op=find&path=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}${showHidden ? "&hidden=1" : ""}`)
        .then((r) => { if (live) setDeepHits({ q, nodes: r.nodes, truncated: r.truncated }); })
        .catch((e: unknown) => shell.toast(String((e as Error).message), "bad"));
    }, 220);
    return () => { live = false; window.clearTimeout(t); };
  }, [deep, filter, cwd, showHidden, showTrash, shell, tick]);

  const deepMode = deep && !!filter.trim() && !showTrash;
  const visibleNodes = useMemo(() => {
    if (deepMode) return deepHits && deepHits.q === filter.trim() ? deepHits.nodes : [];
    const f = filter.toLowerCase();
    return nodes.filter((n) => (showHidden || !n.name.startsWith(".") || filter.startsWith(".")) && (!f || n.name.toLowerCase().includes(f)));
  }, [deepMode, deepHits, nodes, filter, showHidden]);
  const shown = useMemo(() => (deepMode ? visibleNodes : sortNodes(visibleNodes, sort.key, sort.desc)), [deepMode, visibleNodes, sort]);
  const order = useMemo(() => shown.map((n) => n.path), [shown]);
  const selNow = useMemo(() => pruneSel(sel, order), [sel, order]);
  const selected = useMemo(() => new Set(selNow.paths), [selNow]);
  const selNodes = useMemo(() => shown.filter((n) => selected.has(n.path)), [shown, selected]);
  // FM-09 / DP-03: writes still in the offline queue for this folder, not yet on the server
  const ghosts = useMemo(() => (showTrash || deepMode ? [] : queued.filter((q) => parentPath(q.path) === cwd && !nodes.some((n) => n.path === q.path))), [queued, cwd, nodes, showTrash, deepMode]);

  // Ordinary folder sizes exclude trash. In Trash, aggregate the already-fetched
  // trashed rows instead, so a deleted folder is not misleadingly shown as 0 B.
  const trashSizes = useMemo(() => {
    const totals = new Map<string, { tick: number; bytes: number; files: number; dirs: number }>();
    if (!showTrash) return totals;
    for (const n of nodes) if (n.kind === "dir") totals.set(n.path, { tick, bytes: 0, files: 0, dirs: 0 });
    for (const n of nodes) {
      let parent = parentPath(n.path);
      while (parent !== "/") {
        const total = totals.get(parent);
        if (total) { if (n.kind === "file") { total.bytes += n.size; total.files += 1; } else if (n.kind === "dir") total.dirs += 1; }
        parent = parentPath(parent);
      }
    }
    return totals;
  }, [nodes, showTrash, tick]);
  useEffect(() => {
    if (showTrash) return;
    const dirs = shown.filter((n) => n.kind === "dir").slice(0, 60).map((n) => n.path);
    let live = true;
    for (const d of dirs) void folderSize(d, tick).then(() => { if (live) setSizes((x) => x + 1); }).catch(() => undefined);
    return () => { live = false; };
  }, [shown, tick, showTrash]);
  const sizeOf = (n: FNode) => (n.kind === "dir" ? (showTrash ? trashSizes.get(n.path) : sizeCache.get(n.path)) : undefined);
  const selectedBytes = selNodes.reduce((a, n) => a + (n.kind === "dir" ? (sizeOf(n)?.tick === tick ? sizeOf(n)!.bytes : 0) : n.size), 0);
  const selSizePending = selNodes.some((n) => n.kind === "dir" && sizeOf(n)?.tick !== tick);
  void sizes;

  const edited = useMemo(() => new Set(nodes.map((n) => photoOfSidecar(n.path)).filter((p): p is string => !!p)), [nodes]);
  const infoPath = infoOpen ? selNodes.find((n) => n.kind === "file")?.path ?? null : null;
  useEffect(() => {
    if (!infoPath) return;
    let live = true;
    (async () => {
      const bytes = await readFileBytes(infoPath);
      if (!bytes) throw new Error("could not read the file");
      const { readMetadata, describe } = await import("@/lib/meta");
      const m = await readMetadata(bytes, baseName(infoPath));
      if (live) setInfo({ path: infoPath, rows: describe(m) });
    })().catch((e: unknown) => { if (live) setInfo({ path: infoPath, rows: [], error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [infoPath]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); await load(); shell.bumpRefresh(); }
    catch (e) {
      const q = (e as { queued?: boolean }).queued;
      shell.toast(`${label}: ${String((e as Error).message)}`, q ? "warn" : "bad");
      if (q) setQueued(queuedFsWrites());
    }
    finally { setBusy(null); }
  };

  const go = (path: string) => { setH((x) => navigate(x, path)); setSel(emptySel()); setShowTrash(false); setPathDraft(null); setMenu(null); };
  const back = () => { setH(goBack); setSel(emptySel()); setShowTrash(false); };
  const forward = () => { setH(goForward); setSel(emptySel()); setShowTrash(false); };
  const up = () => go(parentPath(cwd));

  const takenIn = async (dir: string): Promise<Set<string>> => {
    if (dir === cwd && !showTrash) return new Set(nodes.map((n) => n.name));
    const r = await api<{ nodes: FNode[] }>(`/api/fs?op=list&path=${encodeURIComponent(dir)}`);
    return new Set(r.nodes.map((n) => n.name));
  };
  /** copy or move `paths` into `dir`, choosing conflict-free names (the server never overwrites) */
  const transfer = (paths: string[], dir: string, mode: "copy" | "move") => run(mode === "copy" ? "copy" : "move", async () => {
    const taken = await takenIn(dir);
    let done = 0; const skipped: string[] = [];
    for (const src of paths) {
      if (dir === src || dir.startsWith(`${src}/`)) { skipped.push(`${baseName(src)} (into itself)`); continue; }
      if (mode === "move" && parentPath(src) === dir) { skipped.push(`${baseName(src)} (already here)`); continue; }
      const isDir = nodes.find((n) => n.path === src)?.kind === "dir";
      const name = copyName(baseName(src), taken, isDir);
      taken.add(name);
      await post("/api/fs", { op: mode, src, dst: joinPath(dir, name) });
      done += 1;
    }
    shell.toast(`${mode === "copy" ? "Copied" : "Moved"} ${done} item(s) to ${dir}${skipped.length ? ` · skipped ${skipped.join(", ")}` : ""}`, skipped.length ? "warn" : "ok");
  });
  const paste = () => {
    const c = getClip();
    if (!c || !c.paths.length || showTrash) return;
    void transfer(c.paths, cwd, c.mode === "cut" ? "move" : "copy").then(() => { if (c.mode === "cut") setClip(null); });
  };
  const toClip = (mode: "copy" | "cut", paths = selNow.paths) => {
    if (!paths.length) return;
    setClip({ mode, paths });
    shell.toast(`${paths.length} item(s) ${mode === "cut" ? "cut" : "copied"} — paste with Ctrl+V or the Paste button`, "info");
  };
  const trashPaths = (paths: string[]) => run("trash", async () => { for (const p of paths) await post("/api/fs", { op: "trash", path: p }); });
  const restorePaths = (paths: string[]) => run("restore", async () => { for (const p of paths) await post("/api/fs", { op: "restore", path: p }); });
  const purgePaths = async (paths: string[]) => {
    const ok = await askText(`Permanently delete ${paths.length} item(s)?`, "", {
      okLabel: "Delete permanently", detail: "Removes these Fusion files, saved versions and search entries from the current database. Backups, database logs, replicas and disk remnants may remain; this is not secure erasure. Type delete to confirm.",
      validate: (v) => (v.trim().toLowerCase() === "delete" ? null : "Type delete to confirm."),
    });
    if (ok !== null) void run("purge", async () => { for (const p of paths) await post("/api/fs", { op: "purge", path: p }); });
  };
  const rename = async (n: FNode) => {
    const name = await askText("Rename", n.name, { okLabel: "Rename", validate: (v) => badName(v) ?? (v !== n.name && nodes.some((x) => x.name === v) ? `“${v}” already exists here.` : null) });
    if (name && name !== n.name) void run("rename", () => post("/api/fs", { op: "rename", path: n.path, name }));
  };
  const newItem = async (kind: "dir" | "file") => {
    const taken = new Set(nodes.map((n) => n.name));
    const def = copyName(kind === "dir" ? "New folder" : "untitled.md", taken, kind === "dir", "number");
    const name = await askText(kind === "dir" ? "New folder name" : "New file name", def, { okLabel: "Create", validate: (v) => badName(v) ?? (taken.has(v) ? `“${v}” already exists here.` : null) });
    if (!name) return;
    void run(kind === "dir" ? "mkdir" : "write", () => post("/api/fs", kind === "dir" ? { op: "mkdir", path: joinPath(cwd, name) } : { op: "write", path: joinPath(cwd, name), content: "" }));
  };
  const loadTemplates = useCallback(async () => {
    try { setTemplates((await api<{ nodes: FNode[] }>(`/api/fs?op=list&path=${encodeURIComponent(TEMPLATES)}`)).nodes.filter((n) => n.kind === "file" && !n.name.startsWith("."))); }
    catch { setTemplates([]); }
  }, []);
  const fromTemplate = (t: FNode) => run("new from template", async () => {
    const name = copyName(t.name, new Set(nodes.map((n) => n.name)), false, "number");
    await post("/api/fs", { op: "copy", src: t.path, dst: joinPath(cwd, name) });
    shell.toast(`Created ${name} from the “${t.name}” template`, "ok");
  });
  const compressSel = (paths: string[]) => run("compress", async () => {
    const taken = new Set(nodes.map((n) => n.name));
    const name = copyName(paths.length === 1 ? `${baseName(paths[0])}.zip` : "Archive.zip", taken, false, "number");
    const r = await post<{ entries: number; path: string }>("/api/fs", { op: "compress", paths, dst: joinPath(parentPath(paths[0]), name) });
    shell.toast(`Archived ${r.entries} file(s) into ${r.path}`, "ok");
  });
  const tagSel = async (list: FNode[]) => {
    const tags = await askText(list.length === 1 ? "Tags (comma separated)" : `Tags for ${list.length} items (comma separated)`, list.length === 1 ? list[0].tags : "", { okLabel: "Save tags" });
    if (tags !== null) void run("tag", async () => { for (const n of list) await post("/api/fs", { op: "tag", path: n.path, tags }); });
  };
  const batchRename = async (only: FNode[] | null) => {
    const pattern = await askText("Batch rename pattern", "{n}-{name}.{ext}", { detail: `Tokens: {n} = running number, {name} = old name, {ext} = extension. Applies to ${only ? `the ${only.length} selected file(s)` : "every file in this folder"}.`, okLabel: "Rename all" });
    if (pattern) void run("batchRename", () => post("/api/fs", { op: "batchRename", path: cwd, pattern, start: 1, ...(only ? { paths: only.map((n) => n.path) } : {}) }));
  };
  const moveTo = async (list: FNode[]) => {
    const dst = await askText(list.length === 1 ? "Move to (destination path)" : `Move ${list.length} items to folder`, list.length === 1 ? list[0].path : cwd, { okLabel: "Move" });
    if (!dst) return;
    if (list.length === 1) void run("move", () => post("/api/fs", { op: "move", src: list[0].path, dst }));
    else void transfer(list.map((n) => n.path), dst, "move");
  };

  const upload = async (files: FileList | File[] | null, dir = cwd) => {
    const arr = files ? Array.from(files) : [];
    if (!arr.length) return;
    const taken = await takenIn(dir);
    for (const f of arr) {
      const buf = await f.arrayBuffer();
      const b64 = toB64(new Uint8Array(buf)); // FIX: spread overflowed the stack on files > ~100 KB
      const name = copyName(f.name, taken, false, "number"); taken.add(name);
      await run(`upload ${f.name}`, () => post("/api/fs", { op: "upload", path: joinPath(dir, name), content: b64, mime: f.type || undefined }));
    }
  };

  const openNode = (n: FNode) => {
    if (showTrash) return;
    if (n.kind === "dir") go(n.path);
    else shell.open(appForFile(n.name, n.mime, n.kind), { path: n.path, title: n.name });
  };

  /* ---------------------------------------------------------------- context menu model (FM-06) */
  const menuItems = (n: FNode | null): (MenuItem & { run: () => unknown })[] => {
    if (!n) {
      return [
        { id: "new-folder", label: "New folder", group: "new", concise: true, keywords: "mkdir create directory", run: () => newItem("dir") },
        { id: "new-file", label: "New file", group: "new", concise: true, keywords: "create touch", run: () => newItem("file") },
        ...(templates ?? []).map((t) => ({ id: `tpl:${t.name}`, label: `New from template: ${t.name}`, group: "new", concise: true, keywords: "template create", run: () => fromTemplate(t) })),
        ...(clip ? [{ id: "paste", label: `Paste ${clip.paths.length} item(s)`, group: "clip", concise: true, keywords: "clipboard ctrl+v", run: paste }] : []),
        { id: "select-all", label: "Select all", group: "sel", concise: true, keywords: "ctrl+a", run: () => setSel(selectAll(order)) },
        { id: "hidden", label: showHidden ? "Hide hidden files" : "Show hidden files", group: "view", keywords: "dotfiles", run: () => setShowHidden((v) => !v) },
        { id: "refresh", label: "Refresh", group: "view", keywords: "reload", run: () => void load() },
        { id: "terminal", label: "Open terminal here", group: "tools", keywords: "shell console", run: () => shell.open("terminal", { cwd }) },
        { id: "batch", label: "Batch rename all files…", group: "tools", keywords: "rename pattern", run: () => batchRename(null) },
        { id: "copy-path", label: "Copy folder path", group: "tools", keywords: "clipboard", run: () => void shell.copy(cwd, "files") },
      ];
    }
    const multi = selNodes.length > 1 && selected.has(n.path) ? selNodes : [n];
    const paths = multi.map((x) => x.path);
    if (showTrash) {
      return [
        { id: "restore", label: multi.length > 1 ? `Restore ${multi.length} items` : "Restore", group: "trash", concise: true, run: () => restorePaths(paths) },
        { id: "purge", label: "Delete permanently", group: "trash", concise: true, danger: true, keywords: "remove erase", run: () => purgePaths(paths) },
      ];
    }
    const file = n.kind === "file";
    return [
      { id: "open", label: "Open", group: "open", concise: true, run: () => (n.kind === "dir" ? go(n.path) : shell.open("peek", { path: n.path, title: n.name })) },
      ...(file ? [{ id: "edit", label: "Edit", group: "open", concise: true, keywords: "text editor", run: () => shell.open("editor", { path: n.path, title: n.name }) }] : []),
      ...(/^image\//.test(n.mime) ? [{ id: "photos", label: "Open in Photos", group: "open", keywords: "image picture edit", run: () => shell.open("photos", { path: n.path, title: "Photos" }) }] : []),
      ...(n.kind === "dir" && onOpenTab ? [{ id: "new-tab", label: "Open in new tab", group: "open", concise: true, keywords: "tab middle-click", run: () => onOpenTab(n.path) }] : []),
      ...(n.kind === "dir" ? [{ id: "terminal", label: "Open terminal here", group: "open", keywords: "shell console", run: () => shell.open("terminal", { cwd: n.path }) }] : []),
      { id: "info", label: "Info", group: "open", keywords: "metadata properties exif", run: () => { setSel({ paths: [n.path], anchor: n.path, focus: n.path }); setInfoOpen(true); } },
      { id: "copy", label: multi.length > 1 ? `Copy ${multi.length} items` : "Copy", group: "clip", concise: true, keywords: "clipboard ctrl+c", run: () => toClip("copy", paths) },
      { id: "cut", label: multi.length > 1 ? `Cut ${multi.length} items` : "Cut", group: "clip", concise: true, keywords: "clipboard ctrl+x move", run: () => toClip("cut", paths) },
      ...(otherCwd ? [
        { id: "copy-other", label: "Copy to other pane", group: "clip", keywords: "f5 dual", run: () => transfer(paths, otherCwd, "copy") },
        { id: "move-other", label: "Move to other pane", group: "clip", keywords: "f6 dual", run: () => transfer(paths, otherCwd, "move") },
      ] : []),
      ...(multi.length === 1 ? [{ id: "rename", label: "Rename…", group: "edit", concise: true, keywords: "f2", run: () => rename(n) }] : [{ id: "batch-sel", label: `Batch rename ${multi.filter((x) => x.kind === "file").length} files…`, group: "edit", concise: true, keywords: "rename pattern", run: () => batchRename(multi.filter((x) => x.kind === "file")) }]),
      { id: "duplicate", label: "Duplicate", group: "edit", keywords: "copy clone", run: () => transfer(paths, parentPath(n.path), "copy") },
      { id: "move", label: "Move to…", group: "edit", run: () => moveTo(multi) },
      { id: "tag", label: "Tag…", group: "edit", keywords: "label colour", run: () => tagSel(multi) },
      { id: "copy-path", label: "Copy path", group: "edit", keywords: "clipboard", run: () => void shell.copy(paths.join("\n"), "files") },
      { id: "compress", label: "Compress to .zip", group: "archive", keywords: "archive zip", run: () => compressSel(paths) },
      ...(n.name.toLowerCase().endsWith(".zip") ? [{ id: "extract", label: "Extract here", group: "archive", keywords: "unzip archive", run: () => run("extract", async () => {
        // TT79: encrypted archives (ZipCrypto / WinZip AES) — the server answers needPassword; ask and retry
        let password: string | undefined;
        for (;;) {
          try {
            const r = await post<{ written: number; dest: string }>("/api/fs", { op: "extract", path: n.path, ...(password !== undefined ? { password } : {}) });
            shell.toast(`Extracted ${r.written} file(s) into ${r.dest} (${password !== undefined ? "decrypted, " : ""}CRC verified)`, "ok"); break;
          } catch (e) {
            if (!(e as { data?: { needPassword?: boolean } }).data?.needPassword) throw e;
            const v = await askText("Archive password", "", { secret: true, title: `“${n.name}” is encrypted`, okLabel: "Extract", detail: password !== undefined ? "That password did not open it — try again." : "Enter the password to extract." });
            if (v === null) return; password = v;
          }
        }
      }) }, { id: "archive-open", label: "Open in Archive", group: "archive", keywords: "browse zip contents", run: () => { shell.open("archive", { path: n.path }); } }] : []),
      { id: "compress-pw", label: "Compress with password…", group: "archive", keywords: "encrypt zip aes", run: () => run("compress", async () => {
        const v = await askForm({ title: "Compress with a password", detail: "WinZip AES-256 (opens in 7-Zip, WinZip, macOS Archive Utility). The file names stay visible; the contents are encrypted.", okLabel: "Compress",
          fields: [{ name: "pw", label: "Password", def: "", secret: true }, { name: "pw2", label: "Repeat password", def: "", secret: true }],
          validate: (x) => (!x.pw ? "Enter a password." : x.pw !== x.pw2 ? "The passwords differ." : null) });
        if (!v) return;
        const name = paths.length === 1 ? `${baseName(paths[0])}.zip` : "Archive.zip";
        const r = await post<{ entries: number; path: string }>("/api/fs", { op: "compress", paths, dst: joinPath(parentPath(paths[0]), name), password: v.pw, encryption: "aes256" });
        shell.toast(`Encrypted ${r.entries} file(s) into ${name} (AES-256)`, "ok"); shell.bumpRefresh();
      }) },
      ...(file && /\.(jpe?g|png|webp|gif|svg|docx|xlsx|pptx)$/i.test(n.name) ? [{ id: "clean", label: "Remove metadata (copy)", group: "privacy", keywords: "exif strip clean privacy", run: () => run("metadata", async () => {
        const r = await cleanVfsFile(n.path);
        if (!r.written) shell.toast(r.report.supported ? "No metadata found — nothing written" : "Not supported — file unchanged", "info");
        else shell.toast(`Removed ${r.report.removed.length} items, clean copy: ${baseName(r.written)}`, "ok");
      }) }] : []),
      ...(file && !n.name.endsWith(".fvault") ? [{ id: "encrypt", label: "Encrypt (SC-07)…", group: "privacy", keywords: "password vault lock", run: () => run("encrypt", async () => {
        const r0 = await askForm({
          title: `Encrypt “${n.name}”`, okLabel: "Encrypt",
          detail: "An encrypted copy (.fvault) is written next to the original. There is no recovery if you lose the passphrase.",
          fields: [{ name: "pass", label: "Passphrase (8+ characters)", secret: true }, { name: "again", label: "Repeat passphrase", secret: true }],
          validate: (v) => (v.pass.length < 8 ? "The passphrase needs at least 8 characters." : v.pass !== v.again ? "The two passphrases don't match." : null),
        });
        if (!r0) return;
        const r = await api<{ node: { content: string; encoding: string; mime: string } }>(`/api/fs?op=read&path=${encodeURIComponent(n.path)}`);
        const bytes = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
        const env = await seal(bytes, r0.pass);
        await post("/api/fs", { op: "write", path: `${n.path}.fvault`, content: JSON.stringify({ ...env, mime: r.node.mime, encoding: r.node.encoding }), reason: "encrypt" });
        shell.toast(`Encrypted copy written: ${n.name}.fvault (original untouched)`, "ok");
      }) }] : []),
      ...(n.name.endsWith(".fvault") ? [{ id: "decrypt", label: "Decrypt…", group: "privacy", keywords: "password vault unlock", run: () => run("decrypt", async () => {
        const pass = await askText("Passphrase", "", { secret: true, title: `Decrypt “${n.name}”`, okLabel: "Decrypt" });
        if (!pass) return;
        const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(n.path)}`);
        const env = JSON.parse(r.node.content) as Envelope & { encoding?: string; mime?: string };
        const plain = await open(env, pass);
        const out = n.path.replace(/\.fvault$/, "");
        await post("/api/fs", env.encoding === "base64"
          ? { op: "upload", path: out, content: toB64(plain), mime: env.mime }
          : { op: "write", path: out, content: new TextDecoder().decode(plain), reason: "decrypt" });
        shell.toast(`Decrypted to ${out}`, "ok");
      }) }] : []),
      { id: "trash", label: multi.length > 1 ? `Move ${multi.length} items to trash` : "Move to trash", group: "danger", concise: true, danger: true, keywords: "delete remove", run: () => trashPaths(paths) },
    ];
  };
  const openMenu = (x: number, y: number, node: FNode | null) => {
    if (!node && templates === null) void loadTemplates();
    if (node && !selected.has(node.path)) setSel({ paths: [node.path], anchor: node.path, focus: node.path });
    setNewOpen(false);
    setMenu({ x, y, node, query: "", full: false });
  };
  const allItems = menu ? menuItems(menu.node) : [];
  const items = menu ? menuView(allItems, menu.full ? "full" : "concise", menu.query) : [];
  const menuKey = menu ? `${menu.x},${menu.y},${menu.node?.path ?? ""}` : null;
  // Esc / a press outside close the menu wherever focus is (clicking "More actions…" unmounts the focused button)
  useEffect(() => {
    if (!menuKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setMenu(null); } };
    const onDown = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null); };
    document.addEventListener("keydown", onKey); document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown, true); };
  }, [menuKey]);
  useEffect(() => { if (menuKey) menuRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }, [menuKey]);

  /* ---------------------------------------------------------------- keyboard (listing) */
  const focusRow = (path: string | null) => {
    if (!path) return;
    listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const cur = shown.find((n) => n.path === selNow.focus) ?? null;
    const move = (d: number | "home" | "end") => { e.preventDefault(); const s = keySelect(selNow, order, d, { shift: e.shiftKey, ctrl: mod }); setSel(s); focusRow(s.focus); };
    const perRow = view === "grid" ? Math.max(1, Math.round((listRef.current?.clientWidth ?? 600) / (listRef.current?.querySelector<HTMLElement>('[role="option"]')?.offsetWidth ?? 120))) : 1;
    if (k === "ArrowDown") move(perRow);
    else if (k === "ArrowUp") move(-perRow);
    else if (k === "ArrowRight" && !e.altKey) move(1);
    else if (k === "ArrowLeft" && !e.altKey) move(-1);
    else if (k === "Home") move("home");
    else if (k === "End") move("end");
    else if (k === "Enter" && cur) { e.preventDefault(); openNode(cur); }
    else if (k === " " && cur) { e.preventDefault(); setSel(clickSelect(selNow, order, cur.path, { ctrl: mod })); }
    else if (mod && k.toLowerCase() === "a") { e.preventDefault(); setSel(selectAll(order)); }
    else if (mod && k.toLowerCase() === "c" && !showTrash) { e.preventDefault(); toClip("copy"); }
    else if (mod && k.toLowerCase() === "x" && !showTrash) { e.preventDefault(); toClip("cut"); }
    else if (mod && k.toLowerCase() === "v") { e.preventDefault(); paste(); }
    else if (k === "Delete" && selNow.paths.length) { e.preventDefault(); if (showTrash || e.shiftKey) void purgePaths(selNow.paths); else void trashPaths(selNow.paths); }
    else if (k === "F2" && cur && !showTrash) { e.preventDefault(); void rename(cur); }
    else if (k === "F5" && otherCwd && selNow.paths.length && !showTrash) { e.preventDefault(); void transfer(selNow.paths, otherCwd, "copy"); }
    else if (k === "F6" && otherCwd && selNow.paths.length && !showTrash) { e.preventDefault(); void transfer(selNow.paths, otherCwd, "move"); }
    else if (k === "Escape" && selNow.paths.length) { e.preventDefault(); setSel(emptySel()); }
    else if (k === "ContextMenu" || (k === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = (document.activeElement as HTMLElement | null)?.getBoundingClientRect();
      openMenu((r?.left ?? 40) + 24, r?.bottom ?? 40, cur);
    }
  };
  // pane-wide keys (work from the toolbar too)
  const onPaneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable=true]");
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); back(); }
    else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); forward(); }
    else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); up(); }
    else if (e.key === "Backspace" && !typing) { e.preventDefault(); back(); }
    else if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); filterRef.current?.focus(); filterRef.current?.select(); }
    else if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); setPathDraft(cwd); }
  };
  // SH-09: mouse buttons 4 / 5 navigate THIS pane; the event is swallowed so the browser tab never goes back
  // TT67 IN-02: which index means Back / Forward follows what the user taught Settings → Shortcuts → Mouse buttons
  const mouseCfg = mouseConfigFrom(shell.settings);
  const onMouseUp = (e: RMouseEvent) => {
    const act = navActionFor(mouseCfg, e.button);
    if (act === "back") { e.preventDefault(); e.stopPropagation(); back(); }
    else if (act === "forward") { e.preventDefault(); e.stopPropagation(); forward(); }
  };
  const swallowAux = (e: RMouseEvent) => { if (guardedButtons(mouseCfg).includes(e.button)) { e.preventDefault(); e.stopPropagation(); } };

  /* ---------------------------------------------------------------- drag and drop */
  const onDragStart = (e: DragEvent, n: FNode) => {
    const paths = selected.has(n.path) ? selNow.paths : [n.path];
    // deferred: a re-render inside dragstart (the selection bar appearing shifts the rows) makes Chromium abort the drag
    if (!selected.has(n.path)) window.setTimeout(() => setSel({ paths: [n.path], anchor: n.path, focus: n.path }), 0);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.setData("text/plain", paths.join("\n"));
    e.dataTransfer.effectAllowed = "copyMove";
  };
  const canDrop = (e: DragEvent) => !showTrash && (e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes("Files"));
  const dragOver = (e: DragEvent, target: string) => {
    if (!canDrop(e)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") || e.ctrlKey || e.altKey ? "copy" : "move";
    if (dropOn !== target) setDropOn(target);
  };
  const drop = (e: DragEvent, dir: string) => {
    if (!canDrop(e)) return;
    e.preventDefault(); e.stopPropagation(); setDropOn(null); onActivate();
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      let paths: string[] = [];
      try { paths = (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === "string"); } catch { /* foreign payload */ }
      if (paths.length) void transfer(paths, dir, e.ctrlKey || e.altKey ? "copy" : "move");
    } else if (e.dataTransfer.files.length) void upload(e.dataTransfer.files, dir);
  };

  /* ---------------------------------------------------------------- rendering helpers */
  const origin = (p: string) => (isPrivatePath(p) ? { label: "encrypted", tone: "ok" as const, title: "Persistent Storage: encrypted in this browser before it reaches the server" } : { label: "server", tone: undefined, title: "Stored on this Fusion server (DP-03)" });
  const sizeLabel = (n: FNode) => {
    if (n.kind !== "dir") return fmtBytes(n.size);
    const c = sizeOf(n);
    return c && c.tick === tick ? fmtBytes(c.bytes) : "…";
  };
  const sizeTitle = (n: FNode) => {
    const c = sizeOf(n);
    const sizeNote = showTrash && isPrivatePath(n.path) ? " · stored size may include encryption overhead" : "";
    return n.kind === "dir" ? (c && c.tick === tick ? `${c.files} file(s) · ${c.dirs} folder(s) · ${fmtBytes(c.bytes)}${sizeNote}` : "calculating…") : `${n.size} bytes${sizeNote}`;
  };
  const focusPath = selNow.focus ?? selNow.paths[0] ?? shown[0]?.path;
  const clickRow = (e: RMouseEvent, n: FNode) => { onActivate(); setSel(clickSelect(selNow, order, n.path, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })); };
  const sortBtn = (key: SortKey, label: string, width?: number) => (
    <button className="fs-btn" data-variant="ghost" style={{ fontSize: fz(11), justifyContent: width ? "flex-end" : "flex-start", width: width ? fz(width) : undefined, flex: width ? "none" : 1, minHeight: fz(24), padding: "0 6px" }}
      aria-label={`${label}${sort.key === key ? `, sorted ${sort.desc ? "descending" : "ascending"}` : ""}`} data-sort={sort.key === key ? (sort.desc ? "desc" : "asc") : undefined} title={`Sort by ${label.toLowerCase()}`}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }))}>
      {label}{sort.key === key ? <span aria-hidden="true" style={{ display: "inline-flex", transform: `rotate(${sort.desc ? 90 : -90}deg)` }}><UiGlyph name="chevron" size={11} /></span> : null}
    </button>
  );

  const row = (n: FNode) => {
    const fmt = formatFor(n.name);
    const isSel = selected.has(n.path);
    const o = origin(n.path);
    return (
      <div key={n.path} className="fs-list-item" data-selected={isSel} data-path={n.path} data-kind={n.kind} data-drop={dropOn === n.path || undefined}
        role="option" aria-selected={isSel} tabIndex={n.path === focusPath ? 0 : -1}
        draggable={!showTrash}
        onDragStart={(e) => onDragStart(e, n)}
        onDragOver={n.kind === "dir" ? (e) => dragOver(e, n.path) : undefined}
        onDragLeave={n.kind === "dir" ? () => setDropOn((d) => (d === n.path ? null : d)) : undefined}
        onDrop={n.kind === "dir" ? (e) => drop(e, n.path) : undefined}
        style={view === "grid" ? { flexDirection: "column", minHeight: fz(96), textAlign: "center" } : undefined}
        onClick={(e) => clickRow(e, n)}
        onDoubleClick={() => openNode(n)}
        onAuxClick={n.kind === "dir" && onOpenTab ? (e) => { if (e.button === 1) { e.preventDefault(); onOpenTab(n.path); } } : undefined}
        onFocus={() => { if (selNow.focus !== n.path) setSel((s) => ({ ...s, focus: n.path })); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onActivate(); openMenu(e.clientX, e.clientY, n); }}
      >
        {view === "grid" && n.kind !== "dir" && !showTrash
          ? <Thumb node={n} size={fz(72)} iconSize={34} hasSidecar={edited.has(n.path)} />
          : <FileIcon name={n.name} kind={n.kind === "dir" ? "dir" : "file"} size={view === "grid" ? 34 : 18} />}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fz(12) }} title={deepMode || showTrash ? n.path : n.name}>
          {n.name}{deepMode || showTrash ? <span className="fs-dim" style={{ fontSize: fz(11) }}> — {parentPath(n.path)}</span> : null}
        </span>
        {view !== "grid" ? (
          <>
            {fmt ? <Badge tone={fmt.grade === "A" ? "ok" : fmt.grade === "X" ? "bad" : "info"} title={fmt.boundary}>grade {fmt.grade}</Badge> : null}
            {n.tags ? <Badge>{n.tags}</Badge> : null}
            <span className="fs-dim" data-size={n.kind === "dir" ? (sizeOf(n)?.tick === tick ? sizeOf(n)!.bytes : "pending") : n.size} title={sizeTitle(n)}
              style={{ fontSize: fz(11), width: fz(70), textAlign: "right", flex: "none" }}>{sizeLabel(n)}</span>
            <span className="fs-dim" title={showTrash ? "Recorded when moved to Trash (not the original modification time)" : "Last modified"} style={{ fontSize: fz(11), width: fz(112), textAlign: "right", flex: "none" }}>{fmtTime(n.updatedAt)}</span>
            <Badge tone={o.tone ?? "default"} title={o.title} data-origin={o.label}>{o.label}</Badge>
          </>
        ) : null}
      </div>
    );
  };

  const listing = (
    <div ref={listRef} role="listbox" aria-label={`${showTrash ? "Trash" : deepMode ? `Search results under ${cwd}` : cwd} — Enter opens, Space selects`} aria-multiselectable="true"
      style={view === "grid" ? { display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${fz(118)},1fr))`, gap: 6 } : { display: "grid", gap: 1 }}>
      {shown.map(row)}
    </div>
  );

  const ghostRows = ghosts.length ? (
    <div aria-label="Waiting to upload" style={{ display: "grid", gap: 1, opacity: 0.75 }}>
      {ghosts.map((g) => (
        <div key={`${g.path}@${g.at}`} className="fs-list-item" data-origin="queued" data-ghost={g.path}>
          <FileIcon name={baseName(g.path)} kind={g.op === "mkdir" ? "dir" : "file"} size={18} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fz(12) }}>{baseName(g.path)}</span>
          <span className="fs-dim" style={{ fontSize: fz(11) }}>{g.op} · {fmtTime(new Date(g.at).toISOString())}</span>
          <Badge tone="warn" title="Offline: this write is queued in this browser and is replayed through the journal when the server is reachable again" data-origin="queued">queued</Badge>
        </div>
      ))}
    </div>
  ) : null;

  const columnView = (
    <div style={{ display: "flex", gap: 0, height: "100%", minHeight: 0, overflowX: "auto" }} data-testid="files-columns">
      {ancestors.map((a, i) => {
        const next = ancestors[i + 1] ?? cwd;
        const list = sortNodes((cols[a] ?? []).filter((n) => showHidden || !n.name.startsWith(".")), "name");
        return (
          <nav key={a} aria-label={`Column ${a}`} className="fs-scroll" style={{ width: fz(190), flex: "none", borderRight: "1px solid var(--fs-border)", padding: 4, minHeight: 0 }}>
            {list.map((n) => (
              <button key={n.path} className="fs-list-item" data-col-path={n.path} aria-current={n.path === next ? "true" : undefined}
                data-selected={n.path === next} style={{ width: "100%", border: 0, background: n.path === next ? undefined : "transparent", color: "inherit", textAlign: "left" }}
                onClick={() => (n.kind === "dir" ? go(n.path) : openNode(n))}
                onDragOver={n.kind === "dir" ? (e) => dragOver(e, n.path) : undefined} onDrop={n.kind === "dir" ? (e) => drop(e, n.path) : undefined}>
                <FileIcon name={n.name} kind={n.kind === "dir" ? "dir" : "file"} size={16} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fz(12) }}>{n.name}</span>
                {n.kind === "dir" ? <UiGlyph name="chevron" size={11} /> : null}
              </button>
            ))}
          </nav>
        );
      })}
      <div className="fs-scroll" style={{ width: fz(260), flex: "none", padding: 4, minHeight: 0 }}>{listing}{ghostRows}</div>
    </div>
  );

  const treeDirs = useMemo(() => ["/", ...tree.filter((d) => d !== "/" && (showHidden || !d.split("/").some((s) => s.startsWith("."))))], [tree, showHidden]);
  const nothing = shown.length === 0 && !ghosts.length;

  return (
    <div className="fs-files-pane" data-pane={paneId} data-active={active || undefined} data-cwd={cwd}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, flex: 1, outline: active ? "2px solid color-mix(in srgb, var(--fs-accent) 45%, transparent)" : undefined, outlineOffset: -2 }}
      onFocusCapture={onActivate} onMouseDownCapture={onActivate} onKeyDown={onPaneKey} onMouseUp={onMouseUp} onAuxClick={swallowAux}
      onClick={() => { setMenu(null); setNewOpen(false); }}>
      {/* navigation + view row */}
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={back} disabled={!h.back.length} title="Back (Alt+←, Backspace, mouse button 4)" aria-label="Back"><UiGlyph name="back" /></Btn>
        <Btn variant="ghost" onClick={forward} disabled={!h.fwd.length} title="Forward (Alt+→, mouse button 5)" aria-label="Forward"><UiGlyph name="forward" /></Btn>
        <Btn variant="ghost" onClick={up} disabled={cwd === "/"} title="Up (Alt+↑)" aria-label="Up one folder"><UiGlyph name="up" /></Btn>
        {pathDraft === null ? (
          <nav aria-label="Breadcrumbs" className="fs-row" data-testid="files-crumbs" style={{ flex: 1, minWidth: fz(160), gap: 0, flexWrap: "nowrap", overflow: "hidden" }}
            onDoubleClick={() => setPathDraft(cwd)}>
            {crumbs(cwd).map(([label, p], i, all) => {
              const last = i === all.length - 1;
              // deep paths: Home › … › grandparent › parent › current (the … opens the path editor); every crumb stays a DOM node so
              // drop targets and data-crumb lookups keep working, the collapsed ones are just not rendered visibly
              const hidden = all.length > 4 && i > 0 && i < all.length - 3;
              if (hidden) return i === 1 ? (
                <span key="ellipsis" style={{ display: "inline-flex", alignItems: "center", flex: "none" }}>
                  <span className="fs-dim" aria-hidden="true" style={{ display: "inline-flex" }}><UiGlyph name="chevron" size={11} /></span>
                  <button className="fs-btn" data-variant="ghost" aria-label={`Show the full path ${cwd}`} title={all.slice(1, -3).map(([l]) => l).join(" / ")}
                    style={{ fontSize: fz(12), padding: "0 6px", minHeight: fz(26) }} onClick={() => setPathDraft(cwd)}>…</button>
                  {all.slice(1, -3).map(([, q]) => <span key={q} data-crumb={q} hidden />)}
                </span>
              ) : null;
              return (
                <span key={p} style={{ display: "inline-flex", alignItems: "center", minWidth: 0, flex: last ? "0 1 auto" : "none" }}>
                  {i > 0 ? <span className="fs-dim" aria-hidden="true" style={{ display: "inline-flex", flex: "none" }}><UiGlyph name="chevron" size={11} /></span> : null}
                  <button className="fs-btn" data-variant="ghost" data-crumb={p} aria-current={last ? "location" : undefined} title={p}
                    style={{ fontSize: fz(12), padding: "0 6px", minHeight: fz(26), fontWeight: last ? 600 : undefined, minWidth: 0, maxWidth: fz(180), flexShrink: last ? 1 : 0 }}
                    onClick={() => go(p)} onDragOver={(e) => dragOver(e, p)} onDrop={(e) => drop(e, p)}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{i === 0 ? "Home" : label}</span>
                  </button>
                </span>
              );
            })}
            <button className="fs-btn" data-variant="ghost" style={{ fontSize: fz(11), marginLeft: "auto", minHeight: fz(26) }} onClick={() => setPathDraft(cwd)} title="Type a path (Ctrl+L)">Edit path</button>
          </nav>
        ) : (
          // autofocus: the path field only exists after the user asked to type a path
          <input className="fs-input fs-mono" style={{ flex: 1, minWidth: fz(160) }} value={pathDraft} autoFocus
            onChange={(e) => setPathDraft(e.target.value)} onBlur={() => setPathDraft(null)}
            onKeyDown={(e) => { if (e.key === "Enter") go(pathDraft.trim() || "/"); else if (e.key === "Escape") setPathDraft(null); }} aria-label="Path" />
        )}
        <input ref={filterRef} className="fs-input" style={{ width: fz(130) }} placeholder={deep ? "Search subfolders" : "Filter"} value={filter}
          onChange={(e) => setFilter(e.target.value)} aria-label="Quick filter"
          onKeyDown={(e) => { if (e.key === "Escape") { setFilter(""); setDeep(false); } else if (e.key === "ArrowDown") { e.preventDefault(); focusRow(shown[0]?.path ?? null); } }} />
        <Btn variant={deep ? "primary" : "ghost"} aria-pressed={deep} title="Also search inside subfolders (by name)" onClick={() => setDeep((v) => !v)}>Subfolders</Btn>
        {(["list", "grid", "column"] as View[]).map((v) => (
          <Btn key={v} variant={view === v ? "primary" : "ghost"} aria-pressed={view === v} title={`${v} view`} onClick={() => setView(v)}>{v === "list" ? "List" : v === "grid" ? "Grid" : "Columns"}</Btn>
        ))}
        <Btn variant={showHidden ? "primary" : "ghost"} aria-pressed={showHidden} title="Show hidden files (names starting with a dot, e.g. photo edit sidecars)" onClick={() => setShowHidden((v) => !v)}>Hidden</Btn>
        <Btn variant={infoOpen ? "primary" : "ghost"} aria-pressed={infoOpen} title="Show metadata of the selected file" onClick={() => setInfoOpen((v) => !v)}>Info</Btn>
        <Btn variant={showTrash ? "primary" : "ghost"} aria-pressed={showTrash} title="Show trash" onClick={() => { setShowTrash((t) => !t); setSel(emptySel()); }}>Trash</Btn>
      </div>

      {/* actions row */}
      <div className="fs-row" style={{ padding: "4px 6px", gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap", position: "relative" }}>
        <Btn variant="ghost" onClick={() => void newItem("dir")}>New folder</Btn>
        <Btn variant="ghost" onClick={() => void newItem("file")}>New file</Btn>
        <Btn variant="ghost" aria-haspopup="menu" aria-expanded={newOpen} title="New from a template in /System/Templates"
          onClick={(e) => { e.stopPropagation(); if (templates === null) void loadTemplates(); setNewOpen((v) => !v); setMenu(null); }}>From template</Btn>
        {newOpen ? (
          <div role="menu" aria-label="New from template" className="fs-panel" style={{ position: "absolute", top: "100%", left: fz(160), zIndex: 30, padding: 4, minWidth: fz(200) }} onClick={(e) => e.stopPropagation()}>
            {templates === null ? <button role="menuitem" disabled className="fs-btn" data-variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }}>Loading…</button> : templates.length === 0
              ? <button role="menuitem" disabled className="fs-btn" data-variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }}>No templates — put files in {TEMPLATES}</button>
              : templates.map((t) => (
                <button key={t.path} role="menuitem" className="fs-btn" data-variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }}
                  onClick={() => { setNewOpen(false); void fromTemplate(t); }}><FileIcon name={t.name} kind="file" size={16} /> {t.name}</button>
              ))}
            <button role="menuitem" className="fs-btn" data-variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => { setNewOpen(false); go(TEMPLATES); }}>Manage templates…</button>
          </div>
        ) : null}
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>
          Upload<input type="file" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
        </label>
        <Btn variant="ghost" disabled={!clip || showTrash} onClick={paste} title={clip ? `Paste ${clip.paths.length} item(s) (${clip.mode}) — Ctrl+V` : "Nothing to paste"}>Paste{clip ? ` ${clip.paths.length}` : ""}</Btn>
        <Btn variant="ghost" onClick={() => void batchRename(null)}>Batch rename</Btn>
        <Btn variant="ghost" onClick={() => shell.open("terminal", { cwd })}>Terminal here</Btn>
        <div style={{ flex: 1 }} />
        {busy ? <Badge tone="warn">{busy}…</Badge> : null}
      </div>

      {/* body: tree · listing · info */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {showTree ? (
          <nav aria-label="Folder tree" className="fs-scroll" data-testid="files-tree" style={{ width: fz(190), flex: "none", borderRight: "1px solid var(--fs-border)", padding: 4, minHeight: 0 }}>
            {treeDirs.map((d) => {
              const depth = d === "/" ? 0 : d.split("/").length - 1;
              const here = d === cwd && !showTrash;
              return (
                <button key={d} className="fs-list-item" data-tree-path={d} aria-current={here ? "location" : undefined} data-selected={here} data-drop={dropOn === `tree:${d}` || undefined}
                  style={{ width: "100%", border: 0, background: here ? undefined : "transparent", color: "inherit", textAlign: "left", paddingLeft: 6 + depth * 12, minHeight: fz(26) }}
                  onClick={() => go(d)} onDragOver={(e) => dragOver(e, `tree:${d}`)} onDragLeave={() => setDropOn(null)} onDrop={(e) => drop(e, d)}>
                  <FileIcon name={d} kind="dir" size={14} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fz(12) }}>{d === "/" ? "Home" : baseName(d)}</span>
                </button>
              );
            })}
          </nav>
        ) : null}
        {/* focusable (tabIndex -1) so that after a click on empty space Ctrl+V / Ctrl+A / Backspace still reach the pane */}
        <div className="fs-scroll" data-testid="files-listing" data-drop={dropOn === "bg" || undefined} tabIndex={-1} onKeyDown={onListKey}
          style={{ flex: 1, minHeight: 0, minWidth: 0, padding: view === "column" ? 0 : 6, outline: dropOn === "bg" ? "2px dashed var(--fs-accent)" : undefined, outlineOffset: -4 }}
          onDragOver={(e) => dragOver(e, "bg")} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropOn(null); }} onDrop={(e) => drop(e, cwd)}
          onContextMenu={(e) => { if (showTrash) return; e.preventDefault(); onActivate(); openMenu(e.clientX, e.clientY, null); }}
          onClick={(e) => { if (e.target === e.currentTarget) { setSel(emptySel()); e.currentTarget.focus(); } }}>
          {view === "column" && !showTrash && !deepMode ? columnView : (
            <>
              {showTrash ? <div data-testid="trash-retention" className="fs-dim" style={{ fontSize: fz(11), padding: "4px 8px" }}>Items stay in Trash until restored or permanently deleted. Regular backups do not include Trash; permanent deletion does not erase copies or database logs.</div> : null}
              {nothing ? <Empty title={showTrash ? "Trash is empty" : deepMode ? (deepHits?.q === filter.trim() ? "No matches in this folder or below" : "Searching…") : "Empty folder"} icon="🗂"
                hint={showTrash || deepMode ? undefined : "Create a file, upload one, drop files here, or run `write` in the terminal."} /> : null}
              {deepMode && deepHits?.truncated ? <Badge tone="warn">Showing the first 200 matches — refine the search</Badge> : null}
              {view === "list" && !deepMode && shown.length > 1 ? (
                <div className="fs-row" data-testid="files-sort" style={{ gap: 8, padding: "0 8px 2px 34px", flexWrap: "nowrap" }}>
                  {sortBtn("name", "Name")}{sortBtn("size", "Size", 70)}{sortBtn("date", showTrash ? "Trashed" : "Modified", 112)}<span style={{ width: fz(56), flex: "none" }} />
                </div>
              ) : null}
              {listing}
              {ghostRows}
            </>
          )}
        </div>
        {infoOpen ? (
          <aside className="fs-scroll" aria-label="File information" data-testid="files-info"
            style={{ width: fz(280), flex: "none", borderLeft: "1px solid var(--fs-border)", padding: 10, minHeight: 0 }}>
            {!infoPath ? <div className="fs-dim" style={{ fontSize: fz(12) }}>Select a file to see its metadata.</div> : (() => {
              const n = shown.find((x) => x.path === infoPath)!;
              const cur = info && info.path === infoPath ? info : null;
              return (
                <div style={{ display: "grid", gap: 8 }}>
                  <Thumb node={n} size={fz(240)} iconSize={64} max={512} hasSidecar={edited.has(n.path)} radius={10} />
                  <div style={{ fontWeight: 600, fontSize: fz(13), wordBreak: "break-all" }}>{n.name}</div>
                  {!cur ? <div className="fs-dim" style={{ fontSize: fz(12) }}>Reading metadata…</div> : cur.error ? <Badge tone="bad">{cur.error}</Badge> : (
                    <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", margin: 0, fontSize: fz(12) }}>
                      {cur.rows.map(([k, v], i) => (
                        <div key={`${k}-${i}`} style={{ display: "contents" }}>
                          <dt className="fs-dim">{k}</dt><dd style={{ margin: 0, wordBreak: "break-word" }}>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {/^image\//.test(n.mime) ? <Btn onClick={() => shell.open("photos", { path: n.path, title: "Photos" })}>Open in Photos</Btn> : null}
                </div>
              );
            })()}
          </aside>
        ) : null}
      </div>

      {/* FM-15 selection toolbar — BELOW the listing: inserted above the rows it shifted them under the pointer (the 2nd
          click of a double-click opened the next row); floating over the rows it covered them in narrow panes */}
      {selNow.paths.length ? (
        <div role="toolbar" aria-label="Selection" data-testid="files-selbar"
          className="fs-row fs-selbar" style={{ padding: "4px 6px", gap: 4, borderTop: "1px solid var(--fs-border)", flexWrap: "nowrap", overflowX: "auto", background: "color-mix(in srgb, var(--fs-accent) 10%, transparent)" }}>
          <Badge tone="info" data-testid="files-selcount">{selNow.paths.length} selected · {fmtBytes(selectedBytes)}{selSizePending ? " +" : ""}</Badge>
          {showTrash ? (
            <>
              <Btn variant="ghost" onClick={() => void restorePaths(selNow.paths)}>Restore</Btn>
              <Btn variant="ghost" onClick={() => void purgePaths(selNow.paths)}>Delete permanently</Btn>
            </>
          ) : (
            <>
              <Btn variant="ghost" onClick={() => toClip("copy")} title="Ctrl+C">Copy</Btn>
              <Btn variant="ghost" onClick={() => toClip("cut")} title="Ctrl+X">Cut</Btn>
              {otherCwd ? <Btn variant="ghost" onClick={() => void transfer(selNow.paths, otherCwd, "copy")} title={`F5 — copy to ${otherCwd}`}>Copy to other pane</Btn> : null}
              {otherCwd ? <Btn variant="ghost" onClick={() => void transfer(selNow.paths, otherCwd, "move")} title={`F6 — move to ${otherCwd}`}>Move to other pane</Btn> : null}
              <Btn variant="ghost" onClick={() => void moveTo(selNodes)}>Move to…</Btn>
              <Btn variant="ghost" onClick={() => void compressSel(selNow.paths)}>Compress</Btn>
              <Btn variant="ghost" onClick={() => void tagSel(selNodes)}>Tag…</Btn>
              <Btn variant="ghost" onClick={() => void trashPaths(selNow.paths)} title="Delete">Move to trash</Btn>
            </>
          )}
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={() => setSel(selectAll(order))} title="Ctrl+A">Select all</Btn>
          <Btn variant="ghost" onClick={() => setSel(emptySel())} title="Esc">Clear</Btn>
        </div>
      ) : null}

      {/* journal strip — the same rows the ops engine writes (FM-03 / NC-05) */}
      <div className="fs-row" style={{ gap: 6, padding: "4px 8px", borderTop: "1px solid var(--fs-border)", overflowX: "auto" }}>
        <span className="fs-dim" style={{ fontSize: fz(10.5) }}>journal:</span>
        {jobs.slice(0, 5).map((j) => (
          <Badge key={j.id} tone={j.state === "COMPLETE" ? "ok" : j.state === "FAILED" ? "bad" : "warn"} title={`${j.op} ${j.src} → ${j.dst} ${j.error}`}>{j.op} {j.state}</Badge>
        ))}
        {jobs.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(10.5) }}>no operations yet</span> : null}
        <div style={{ flex: 1 }} />
        <span className="fs-dim" style={{ fontSize: fz(10.5), whiteSpace: "nowrap" }} data-testid="files-status">
          {showTrash ? "trash" : `${shown.length} item(s)`}{clip ? ` · clipboard: ${clip.paths.length} (${clip.mode})` : ""}
        </span>
      </div>

      {menu && typeof document !== "undefined" ? createPortal(
        <div ref={menuRef} className="fs-panel" data-testid="files-menu"
          style={{ position: "fixed", left: Math.max(4, Math.min(menu.x, window.innerWidth - 250)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 420)), zIndex: 9999, padding: 4, minWidth: fz(220), maxHeight: "min(70vh, 520px)", overflowY: "auto" }}
          onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            const btns = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
            const i = btns.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "Escape") { e.preventDefault(); setMenu(null); listRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
            else if (e.key === "ArrowUp") { e.preventDefault(); (i <= 0 ? menuRef.current?.querySelector<HTMLInputElement>("input") : btns[i - 1])?.focus(); }
            else if (e.key === "Home" && i >= 0) { e.preventDefault(); btns[0]?.focus(); }
            else if (e.key === "End" && i >= 0) { e.preventDefault(); btns[btns.length - 1]?.focus(); }
            else if (i >= 0 && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
              // type-to-search from anywhere in the menu: the keystroke goes to the search box
              e.preventDefault(); setMenu((m) => (m ? { ...m, query: m.query + e.key } : m)); menuRef.current?.querySelector<HTMLInputElement>("input")?.focus();
            }
          }}>
          <input className="fs-input" aria-label="Search actions" placeholder="Type to search actions" value={menu.query} style={{ width: "100%", marginBottom: 4 }}
            onChange={(e) => setMenu((m) => (m ? { ...m, query: e.target.value } : m))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && items[0]) { e.preventDefault(); setMenu(null); void items[0].run(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }
            }} />
          {!items.length ? <div className="fs-dim" role="status" style={{ fontSize: fz(12), padding: 6 }}>No action matches “{menu.query}”</div> : null}
          <div role="menu" aria-label={menu.node ? `Actions for ${menu.node.name}` : "Folder actions"} style={{ display: "grid" }}>
          {items.flatMap((item, i) => [
            ...(i > 0 && items[i - 1].group !== item.group ? [<div key={`sep-${item.id}`} role="separator" style={{ borderTop: "1px solid var(--fs-border)", margin: "3px 0" }} />] : []),
            <button key={item.id} role="menuitem" className="fs-btn" data-variant="ghost" data-item={item.id} disabled={item.disabled}
              style={{ width: "100%", justifyContent: "flex-start", color: item.danger ? "var(--fs-bad, #c0392b)" : undefined }}
              onClick={() => { setMenu(null); void (allItems.find((x) => x.id === item.id) ?? item).run(); }}>{item.label}</button>,
          ])}
          {!menu.query && allItems.length > items.length ? (
            <button role="menuitem" className="fs-btn" data-variant="ghost" data-item="more" style={{ width: "100%", justifyContent: "flex-start", fontSize: fz(12) }}
              onClick={() => setMenu((m) => (m ? { ...m, full: true } : m))}>More actions ({allItems.length - items.length})…</button>
          ) : null}
          {!menu.query && menu.full ? (
            <button role="menuitem" className="fs-btn" data-variant="ghost" data-item="less" style={{ width: "100%", justifyContent: "flex-start", fontSize: fz(12) }}
              onClick={() => setMenu((m) => (m ? { ...m, full: false } : m))}>Fewer actions</button>
          ) : null}
          </div>
        </div>, document.body) : null}
    </div>
  );
}
