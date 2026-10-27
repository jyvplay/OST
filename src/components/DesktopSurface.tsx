"use client";
import { fz } from "@/lib/uiscale";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatFor } from "@/lib/forge";
import { appForFile } from "@/lib/open-with";
import { useShell } from "./shell-context";
import { FileIcon } from "./AppIcon";
import { DEFAULT_WALLPAPER, WALLPAPERS } from "@/lib/appearance";
import { cellAt, cleanUp, layoutIcons, moveIcon, nudgeIcon, sortByName, type IconPos } from "@/lib/desk-icons-core";
import { askText } from "@/lib/ask";
import { DRAG_TYPE, DESKTOP_DIR, parseFusionPaths, dropCreatesCycle, canDragOut, downloadUrlValue } from "@/lib/dnd-core";
import { post as apiPost } from "@/lib/api";

interface Item { path: string; name: string; kind: string; mime?: string }

const MAX_ICONS = 30;

/**
 * TT26: icons can be rearranged — drag (snaps to the grid, swaps with an occupied cell), Alt+Arrow keys (the
 * single-pointer / keyboard alternative WCAG 2.5.7 asks for), "Clean up" and "Sort by name" — and the positions
 * persist as grid cells in DesktopState.icons (src/lib/desk-icons-core.ts).
 *
 * SH-04. Desktop icons are VFS paths, not bookmarks: if the file is trashed the
 * icon disappears on the next refresh, so the desktop can never show a ghost
 * the filesystem has already lost.
 */
export default function DesktopSurface() {
  const shell = useShell();
  const [items, setItems] = useState<Item[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement | null>(null);
  const probe = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState({ cw: 130, ch: 100, cols: 6, rows: 6 });
  const [drag, setDrag] = useState<{ path: string; sx: number; sy: number; ox: number; oy: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const el = area.current, pr = probe.current;
    if (!el || !pr) return;
    const measure = () => {
      const r = el.getBoundingClientRect(), c = pr.getBoundingClientRect();
      const cw = Math.max(40, c.width), ch = Math.max(40, c.height);
      setGrid({ cw, ch, cols: Math.max(1, Math.floor((r.width - 20) / cw)), rows: Math.max(1, Math.floor((r.height - 20) / ch)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(pr);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    api<{ nodes: Item[] }>("/api/fs?op=list&path=/Documents")
      .then((r) => setItems(r.nodes.filter((n) => !n.name.startsWith(".")).slice(0, MAX_ICONS))) // TT54: dotfiles (photo edit sidecars) stay hidden
      .catch(() => setItems([]));
  }, [shell.refreshTick]);

  useEffect(() => {
    const onDeferredContextMenu = (event: Event) => {
      const detail = (event as CustomEvent<{ x: number; y: number }>).detail;
      if (detail && Number.isFinite(detail.x) && Number.isFinite(detail.y)) setMenu({ x: detail.x, y: detail.y });
    };
    window.addEventListener("fusion:desktop-context-menu", onDeferredContextMenu);
    return () => window.removeEventListener("fusion:desktop-context-menu", onDeferredContextMenu);
  }, []);

  const [deskDrop, setDeskDrop] = useState(false);
  const saved = shell.state.icons as IconPos[] | undefined;
  const placed = layoutIcons(items.map((i) => i.path), saved, grid.cols, grid.rows);
  const byPath = new Map(items.map((i) => [i.path, i]));
  const commit = (icons: IconPos[]) => shell.dispatch({ t: "icons", icons });

  // TT87 FM-14: desktop is a drop target for Fusion drags (move/copy into /Documents) and OS files (upload)
  const onDeskDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes("Files")) {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") || e.ctrlKey || e.altKey ? "copy" : "move";
      if (!deskDrop) setDeskDrop(true);
    }
  };
  const onDeskDrop = async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      const paths = parseFusionPaths(raw);
      if (paths.length && !dropCreatesCycle(paths, DESKTOP_DIR)) {
        e.preventDefault(); e.stopPropagation(); setDeskDrop(false);
        const op = e.ctrlKey || e.altKey ? "copy" : "move";
        for (const src of paths) {
          const name = src.slice(src.lastIndexOf("/") + 1);
          const dst = `${DESKTOP_DIR}/${name}`;
          if (src === dst) continue;
          await apiPost("/api/fs", { op, src, dst }).catch(() => undefined);
        }
        shell.bumpRefresh();
        return;
      }
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault(); e.stopPropagation(); setDeskDrop(false);
      for (const f of Array.from(e.dataTransfer.files)) {
        const buf = await f.arrayBuffer();
        const b64 = Buffer.from(buf).toString("base64");
        await apiPost("/api/fs", { op: "write", path: `${DESKTOP_DIR}/${f.name}`, content: b64, encoding: "base64" }).catch(() => undefined);
      }
      shell.bumpRefresh();
    }
  };

  return (
    <div
      data-pointer-gesture-surface="classic"
      data-testid="desktop-surface"
      data-drop-active={deskDrop || undefined}
      style={{ position: "absolute", inset: 0, outline: deskDrop ? "2px dashed var(--fs-accent)" : undefined, outlineOffset: deskDrop ? -4 : undefined }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      onPointerDown={() => setMenu(null)}
      onDragOver={onDeskDragOver}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDeskDrop(false); }}
      onDrop={onDeskDrop}
    >
      <div ref={probe} aria-hidden="true" style={{ position: "absolute", visibility: "hidden", pointerEvents: "none", width: fz(104), height: fz(76) }} />
      <div ref={area} data-testid="desk-icons" data-cols={grid.cols} data-rows={grid.rows} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {placed.map((pl) => {
          const it = byPath.get(pl.path)!;
          const fmt = formatFor(it.name);
          const dragging = drag?.path === it.path && drag.moved;
          const left = dragging ? drag.x : 10 + pl.col * grid.cw + (grid.cw - grid.cw * (96 / 104)) / 2;
          const top = dragging ? drag.y : 10 + pl.row * grid.ch;
          const open = () => shell.open(appForFile(it.name, it.mime ?? "", it.kind), { path: it.path, title: it.name });
          return (
            <button key={it.path}
              draggable
              onDragStart={(e) => {
                const { encodeFusionPaths, canDragOut, downloadUrlValue } = require("@/lib/dnd-core") as typeof import("@/lib/dnd-core");
                e.dataTransfer.setData(DRAG_TYPE, encodeFusionPaths([it.path]));
                e.dataTransfer.setData("text/plain", it.path);
                e.dataTransfer.effectAllowed = "copyMove";
                if (canDragOut([it.path])) {
                  const origin = typeof window !== "undefined" ? window.location.origin : "";
                  const rawUrl = `${origin}/api/fs?op=raw&path=${encodeURIComponent(it.path)}`;
                  try { e.dataTransfer.setData("DownloadURL", downloadUrlValue(it.mime || "application/octet-stream", it.name, rawUrl)); } catch {}
                }
              }}
              onDoubleClick={() => { if (!suppressClick.current) open(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); open(); return; }
                const d = e.altKey ? ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key] : undefined;
                if (d) { e.preventDefault(); commit(nudgeIcon(placed, it.path, d[0], d[1], grid.cols, grid.rows)); }
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                suppressClick.current = false;
                const a = area.current!.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
                setDrag({ path: it.path, sx: e.clientX, sy: e.clientY, ox: e.clientX - b.left, oy: e.clientY - b.top, x: b.left - a.left, y: b.top - a.top, moved: false });
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!drag || drag.path !== it.path) return;
                const moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
                const a = area.current!.getBoundingClientRect();
                setDrag({ ...drag, moved, x: e.clientX - a.left - drag.ox, y: e.clientY - a.top - drag.oy });
              }}
              onPointerUp={(e) => {
                if (!drag || drag.path !== it.path) return;
                if (drag.moved) {
                  suppressClick.current = true;
                  const b = e.currentTarget.getBoundingClientRect(), a = area.current!.getBoundingClientRect();
                  const c = cellAt(b.left + b.width / 2 - a.left - 10, b.top + b.height / 2 - a.top - 10, grid.cw, grid.ch);
                  commit(moveIcon(placed, it.path, c.col, c.row, grid.cols, grid.rows));
                }
                setDrag(null);
              }}
              onPointerCancel={() => setDrag(null)}
              title={`${it.path}${fmt ? ` · ${fmt.label} (grade ${fmt.grade})` : ""} — drag or Alt+Arrow keys to move`}
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
              className="fs-btn fs-desk-icon" data-variant="ghost" data-testid="desk-icon" data-path={it.path} data-cell={`${pl.col},${pl.row}`}
              data-dragging={dragging || undefined}
              style={{ position: "absolute", left, top, width: fz(96), pointerEvents: "auto", touchAction: "none",
                flexDirection: "column", height: "auto", padding: `${fz(4)} 2px`, gap: fz(3), fontSize: fz(11), whiteSpace: "nowrap", overflow: "hidden",
                zIndex: dragging ? 5 : undefined, transition: dragging ? "none" : "left var(--fs-motion) ease-out, top var(--fs-motion) ease-out" }}>
              <FileIcon name={it.name} kind={it.kind === "dir" ? "dir" : "file"} size={34} />
              <span className="fs-desk-label" style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
            </button>
          );
        })}
      </div>

      {menu ? (
        <div className="fs-panel" role="menu" onPointerDown={(e) => e.stopPropagation()}
          style={{ position: "absolute", left: menu.x, top: menu.y, padding: 4, zIndex: 9500, minWidth: 190 }}>
          {[
            { label: "New text file…", run: async () => {
                const name = await askText("New text file name", "untitled.md", { okLabel: "Create", validate: (v) => (/[\\/]/.test(v) ? "A file name can't contain / or \\" : null) });
                if (!name) return;
                await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "write", path: `/Documents/${name}`, content: "" }) });
                shell.bumpRefresh();
                shell.open("editor", { path: `/Documents/${name}`, title: name });
              } },
            { label: "Clean up icons", run: () => commit(cleanUp(placed, grid.cols, grid.rows)) },
            { label: "Sort icons by name", run: () => commit(sortByName(placed, Object.fromEntries(items.map((i) => [i.path, i.name])), grid.cols, grid.rows)) },
            { label: "Switch to Tabletop (3D)", run: () => void shell.setSetting("appearance.desktopView", "tabletop") },
            { label: "Open Files", run: () => shell.open("files") },
            { label: "Open Terminal here", run: () => shell.open("terminal", { cwd: "/Documents" }) },
            { label: "Overview", run: () => shell.dispatch({ t: "cascade" }) },
            { label: "Change wallpaper", run: () => {
                const order: string[] = WALLPAPERS.map((w) => w.id);
                const cur = shell.settings["appearance.wallpaper"] ?? DEFAULT_WALLPAPER;
                void shell.setSetting("appearance.wallpaper", order[(order.indexOf(cur) + 1) % order.length]);
              } },
            { label: "Spec register", run: () => shell.open("spec") },
          ].map((item) => (
            <button key={item.label} role="menuitem" className="fs-btn" data-variant="ghost"
              style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={() => { setMenu(null); void item.run(); }}>{item.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
