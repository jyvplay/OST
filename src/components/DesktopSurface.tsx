"use client";
import OrbitMenu from "./OrbitMenu";
import { useMarquee } from "./useMarquee";
import { getClip, setClip } from "@/lib/files/clipboard";
import { fz } from "@/lib/uiscale";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatFor } from "@/lib/forge";
import { appForFile } from "@/lib/open-with";
import { useShell } from "./shell-context";
import { FileIcon } from "./AppIcon";
import { DEFAULT_WALLPAPER, WALLPAPERS } from "@/lib/appearance";
import { cellAt, cleanUp, layoutIcons, moveIcon, nudgeIcon, sortByName, type IconPos } from "@/lib/desk-icons-core";
import { badName, baseName, copyName } from "@/lib/files/model";
import { askText, askConfirm } from "@/lib/ask";

interface Item { path: string; name: string; kind: string; mime?: string }

const MAX_ICONS = 30;
function DesktopMenuButtons({ actions, run }: { actions: { label: string; run: () => unknown }[]; run: (action: () => unknown) => void }) {
  return actions.map((item, index) => <button key={item.label} tabIndex={index === 0 ? 0 : -1} role="menuitem" className="fs-btn" data-variant="ghost"
    style={{ width: "100%", justifyContent: "flex-start", whiteSpace: "normal", textAlign: "left" }}
    onClick={() => run(item.run)}>{item.label}</button>);
}

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
  const [selectedPaths, setSelected] = useState<string[]>([]);
  const selected = selectedPaths.filter(p => items.some(i => i.path === p));
  const operationBusy = useRef(false);
  const [itemMenu, setItemMenu] = useState<{ x: number; y: number; item: Item } | null>(null);
  const closeItemMenu = useCallback(() => setItemMenu(null), []);
  const marquee = useMarquee(selected, setSelected, '[data-testid="desk-icon"]');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement | null>(null);
  const menuNode = useRef<HTMLDivElement | null>(null);
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

  // Context-menu coordinates are viewport-relative, but the desk starts below
  // the shell bar. Measure the actual menu after layout and keep it within the
  // desk, including when large text makes the menu scrollable.
  useLayoutEffect(() => {
    const node = menuNode.current, desk = area.current;
    if (!node || !desk || !menu) return;
    const place = () => {
      const b = desk.getBoundingClientRect(), m = node.getBoundingClientRect();
      node.style.left = `${Math.max(0, Math.min(menu.x - b.left, b.width - m.width))}px`;
      node.style.top = `${Math.max(0, Math.min(menu.y - b.top, b.height - m.height))}px`;
      node.style.visibility = "visible";
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(desk); observer.observe(node);
    return () => observer.disconnect();
  }, [menu]);

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

  useEffect(() => {
    if (!menu) return;
    const node = menuNode.current;
    const origin = document.activeElement as HTMLElement | null;
    node?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (e: PointerEvent) => { if (!node?.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(null); }
      if (!node?.contains(document.activeElement)) return;
      const buttons = [...node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const j = e.key === "ArrowDown" ? (i + 1) % buttons.length : e.key === "ArrowUp" ? (i - 1 + buttons.length) % buttons.length : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
      if (j >= 0) { e.preventDefault(); buttons.forEach((b, k) => { b.tabIndex = k === j ? 0 : -1; }); buttons[j]?.focus(); }
      if (e.key === "Tab") setMenu(null);
    };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key, true); if (origin?.isConnected) origin.focus(); };
  }, [menu]);

  const saved = shell.state.icons as IconPos[] | undefined;
  const placed = layoutIcons(items.map((i) => i.path), saved, grid.cols, grid.rows);
  const byPath = new Map(items.map((i) => [i.path, i]));
  const commit = (icons: IconPos[]) => shell.dispatch({ t: "icons", icons });
  // Each transfer is server-atomic and refuses overwrite; a batch is explicitly best effort.
  const operate = useCallback(async (fn: () => Promise<void>) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    try { await fn(); } catch (e) { shell.toast(e instanceof Error ? e.message : String(e), "bad"); }
    finally { operationBusy.current = false; shell.bumpRefresh(); }
  }, [shell]);
  const fs = (body: object) => api("/api/fs", { method: "POST", body: JSON.stringify(body) });
  const duplicate = (paths: string[]) => operate(async () => {
    const listing = await api<{ nodes: Item[] }>("/api/fs?op=list&path=/Documents");
    const taken = new Set(listing.nodes.map(i => i.name));
    for (const path of paths) {
      const name = copyName(baseName(path), taken, listing.nodes.find(i => i.path === path)?.kind === "dir"); taken.add(name);
      await fs({ op: "copy", src: path, dst: `/Documents/${name}` });
    }
  });
  const paste = () => operate(async () => {
    const clip = getClip(); if (!clip) return;
    const listing = await api<{ nodes: Item[] }>("/api/fs?op=list&path=/Documents");
    const taken = new Set(listing.nodes.map(i => i.name));
    const remaining = [...clip.paths];
    try {
      for (const src of clip.paths) {
        if (src === "/Documents" || "/Documents".startsWith(`${src}/`)) throw new Error("Cannot paste a folder inside itself");
        if (clip.mode === "cut" && src.slice(0, src.lastIndexOf("/")) === "/Documents") { remaining.splice(remaining.indexOf(src), 1); continue; }
        const node = await api<{ node: Item | null }>(`/api/fs?op=stat&path=${encodeURIComponent(src)}`);
        if (!node.node) throw new Error(`Source no longer exists: ${src}`);
        const name = copyName(baseName(src), taken, node.node.kind === "dir"); taken.add(name);
        await fs({ op: clip.mode === "cut" ? "move" : "copy", src, dst: `/Documents/${name}` });
        remaining.splice(remaining.indexOf(src), 1);
      }
    } finally {
      if (clip.mode === "cut" && getClip() === clip) setClip(remaining.length ? { mode: "cut", paths: remaining } : null);
    }
  });

  return (
    <div
      {...marquee.handlers}
      data-pointer-gesture-surface="classic"
      tabIndex={0}
      aria-label="Desktop"
      onKeyDown={(e) => {
        if (e.defaultPrevented || (e.target as Element).closest('[role="menu"],input,textarea,[contenteditable]')) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(items.map(i => i.path)); }
        else if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x") && selected.length) { e.preventDefault(); setClip({ mode: e.key.toLowerCase() === "x" ? "cut" : "copy", paths: selected }); }
        else if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); void paste(); }
        else if (e.key === "Escape") { setSelected([]); setMenu(null); setItemMenu(null); }
        else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault(); e.stopPropagation(); const target = e.target as HTMLElement, r = target.getBoundingClientRect();
          const it = items.find(i => i.path === target.closest<HTMLElement>('[data-path]')?.dataset.path);
          if (it) { if (!selected.includes(it.path)) setSelected([it.path]); setMenu(null); setItemMenu({ x: r.left, y: r.bottom, item: it }); }
          else { setItemMenu(null); setMenu({ x: r.left + 10, y: r.top + 10 }); }
        }
      }}
      style={{ position: "absolute", inset: 0 }}
      onContextMenu={(e) => { if (e.defaultPrevented) return; e.preventDefault(); setItemMenu(null); setMenu({ x: e.clientX, y: e.clientY }); }}
      onPointerDown={(e) => { setMenu(null); marquee.handlers.onPointerDown(e); }}
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
              aria-pressed={selected.includes(it.path)}
              onClick={(e) => { if (suppressClick.current) return; setSelected(e.ctrlKey || e.metaKey || e.shiftKey ? (selected.includes(it.path) ? selected.filter(p => p !== it.path) : [...selected, it.path]) : [it.path]); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.focus(); setMenu(null); if (!selected.includes(it.path)) setSelected([it.path]); setItemMenu({ x: e.clientX, y: e.clientY, item: it }); }}
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
              style={{ outline: selected.includes(it.path) ? "2px solid var(--fs-accent)" : undefined, background: selected.includes(it.path) ? "color-mix(in srgb, var(--fs-accent) 20%, transparent)" : undefined, position: "absolute", left, top, width: fz(96), pointerEvents: "auto", touchAction: "none",
                flexDirection: "column", height: "auto", padding: `${fz(4)} 2px`, gap: fz(3), fontSize: fz(11), whiteSpace: "nowrap", overflow: "hidden",
                zIndex: dragging ? 5 : undefined, transition: dragging ? "none" : "left var(--fs-motion) ease-out, top var(--fs-motion) ease-out" }}>
              <FileIcon name={it.name} kind={it.kind === "dir" ? "dir" : "file"} size={34} />
              <span className="fs-desk-label" style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
            </button>
          );
        })}
      </div>

      {marquee.overlay}
      {itemMenu ? <OrbitMenu x={itemMenu.x} y={itemMenu.y} close={closeItemMenu} actions={[
        { label: "Open", run: () => shell.open(appForFile(itemMenu.item.name, itemMenu.item.mime ?? "", itemMenu.item.kind), { path: itemMenu.item.path, title: itemMenu.item.name }) },
        { label: "Open containing folder", run: () => shell.open("files", { path: "/Documents" }) },
        { label: `Copy ${selected.length} item(s)`, run: () => setClip({ mode: "copy", paths: selected }) },
        { label: `Cut ${selected.length} item(s)`, run: () => setClip({ mode: "cut", paths: selected }) },
        { label: "Copy paths", run: () => shell.copy(selected.join("\n"), "desktop") },
        { label: "Rename…", disabled: selected.length !== 1, run: async () => {
          const it = itemMenu.item;
          const name = await askText("Rename", it.name, { okLabel: "Rename", validate: badName });
          if (name && name !== it.name) await operate(async () => { await fs({ op: "rename", path: it.path, name }); });
        } },
        { label: "Duplicate selection", run: () => duplicate(selected) },
        { label: "Move selection to trash…", run: async () => {
          const paths = [...selected];
          if (await askConfirm({ title: `Move ${paths.length} item(s) to Trash?`, detail: "Recoverable from Files → Trash. A batch stops on the first failure; completed items remain in Trash.", okLabel: "Move to trash" })) {
            await operate(async () => { for (const path of paths) await fs({ op: "trash", path }); });
          }
        } },
        { label: "Select all", run: () => setSelected(items.map(i => i.path)) },
        { label: "Clear selection", run: () => setSelected([]) },
      ]} /> : null}
      {menu ? (
        <div ref={menuNode} className="fs-panel" role="menu" onPointerDown={(e) => e.stopPropagation()}
          style={{ position: "absolute", left: 0, top: 0, visibility: "hidden", padding: 4, zIndex: 9500,
            width: "max-content", minWidth: "min(190px, 100%)", maxWidth: "100%", maxHeight: "100%", overflowY: "auto", boxSizing: "border-box" }}>
          <DesktopMenuButtons actions={[
            { label: "New folder…", run: async () => {
                const name = await askText("New folder name", "New folder", { okLabel: "Create", validate: badName });
                if (name) await operate(async () => { await fs({ op: "mkdir", path: `/Documents/${name}` }); });
              } },
            { label: "Paste into desktop", run: () => paste() },
            { label: "Select all icons", run: () => setSelected(items.map(i => i.path)) },
            { label: "Clear icon selection", run: () => setSelected([]) },
            { label: "New text file…", run: async () => {
                const name = await askText("New text file name", "untitled.md", { okLabel: "Create", validate: badName });
                if (!name) return;
                await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "writeIfUnchanged", path: `/Documents/${name}`, content: "", expected: null }) });
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
          ]} run={(action) => { setMenu(null); void Promise.resolve().then(action).catch((e: unknown) => shell.toast(e instanceof Error ? e.message : String(e), "bad")); }} />
        </div>
      ) : null}
    </div>
  );
}
