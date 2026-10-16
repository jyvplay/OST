"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatFor } from "@/lib/forge";
import { useShell } from "./shell-context";
import { FileIcon } from "./AppIcon";
import { DEFAULT_WALLPAPER, WALLPAPERS } from "@/lib/appearance";

interface Item { path: string; name: string; kind: string }

/**
 * SH-04. Desktop icons are VFS paths, not bookmarks: if the file is trashed the
 * icon disappears on the next refresh, so the desktop can never show a ghost
 * the filesystem has already lost.
 */
export default function DesktopSurface({ onLauncher }: { onLauncher: () => void }) {
  const shell = useShell();
  const [items, setItems] = useState<Item[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hot = useRef(0);

  useEffect(() => {
    api<{ nodes: Item[] }>("/api/fs?op=list&path=/Documents")
      .then((r) => setItems(r.nodes.slice(0, 10)))
      .catch(() => setItems([]));
  }, [shell.refreshTick]);

  // SH-06 hot corners: pointerrawupdate survives coalescing at 120 Hz
  useEffect(() => {
    if ((shell.settings["shell.hotCorners"] ?? "on") !== "on") return;
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (e.clientX < 6 && e.clientY < 42 && now - hot.current > 1200) {
        hot.current = now;
        onLauncher();
      }
    };
    window.addEventListener("pointerrawupdate" in window ? "pointerrawupdate" : "pointermove", onMove as EventListener);
    return () => window.removeEventListener("pointerrawupdate" in window ? "pointerrawupdate" : "pointermove", onMove as EventListener);
  }, [onLauncher, shell.settings]);

  return (
    <div
      style={{ position: "absolute", inset: 0 }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      onPointerDown={() => setMenu(null)}
    >
      <div style={{ position: "absolute", top: 10, left: 10, display: "grid", gap: fz(3), width: fz(96) }}>
        {items.map((it) => {
          const fmt = formatFor(it.name);
          return (
            <button key={it.path}
              onDoubleClick={() => shell.open(it.kind === "dir" ? "files" : "editor", { path: it.path, title: it.name })}
              title={`${it.path}${fmt ? ` · ${fmt.label} (grade ${fmt.grade})` : ""}`}
              className="fs-btn fs-desk-icon" data-variant="ghost"
              style={{ flexDirection: "column", height: "auto", padding: `${fz(4)} 2px`, gap: fz(3), fontSize: fz(11), whiteSpace: "nowrap", overflow: "hidden" }}>
              <FileIcon name={it.name} kind={it.kind === "dir" ? "dir" : "file"} size={34} />
              <span className="fs-desk-label" style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
            </button>
          );
        })}
      </div>

      {menu ? (
        <div className="fs-panel" role="menu"
          style={{ position: "absolute", left: menu.x, top: menu.y, padding: 4, zIndex: 9500, minWidth: 190 }}>
          {[
            { label: "New text file…", run: async () => {
                const name = prompt("File name", "untitled.md");
                if (!name) return;
                await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "write", path: `/Documents/${name}`, content: "" }) });
                shell.bumpRefresh();
                shell.open("editor", { path: `/Documents/${name}`, title: name });
              } },
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
