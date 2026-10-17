"use client";
/**
 * TT25 "Art" layout — a Mac-style dock, centred and floating at the bottom, holding EVERY app.
 *  • Launchpad first, then the apps grouped (Core | Create | Connect | System) with thin separators, then the
 *    minimised windows after a separator, then Trash (Files on its trash view) — the macOS order.
 *  • Base icon size is fitted to the available width (src/lib/layout-core.ts fitIconSize); hover magnification uses
 *    a cosine falloff over the *resting* geometry (dockScales), measured from the dock's fixed centre so the dock
 *    stays stable as it widens. Keyboard focus magnifies too. Touch input never magnifies (as on macOS).
 *  • Name bubble above the hovered / focused icon, a dot under running apps, a short bounce when an app launches
 *    (none under reduced motion or Motion: off), right-click menu (window list, New window, Show all, Quit).
 *  • When even the minimum size does not fit (a phone), magnification is switched off and the dock scrolls
 *    sideways inside itself — the page never does.
 */
import { useEffect, useRef, useState } from "react";
import { MODULES, moduleById } from "@/lib/registry";
import { dockScales, dockWidth, fitIconSize, DOCK_MAX_SCALE } from "@/lib/layout-core";
import { useShell } from "./shell-context";
import { AppIcon, Tile } from "./AppIcon";
import { AutoMenu, type MenuItem } from "./chrome-bits";

type Item =
  | { kind: "launchpad"; key: string; label: string }
  | { kind: "app"; key: string; id: string; label: string }
  | { kind: "min"; key: string; winId: string; module: string; label: string }
  | { kind: "trash"; key: string; label: string }
  | { kind: "sep"; key: string };

const GROUPS = ["Core", "Create", "Connect", "System"] as const;
const GAP = 4, PAD = 7, SEP_W = 9, MIN = 24, MAX = 56;

export default function Dock({ onLaunchpad, launchpadOpen }: { onLaunchpad: () => void; launchpadOpen: boolean }) {
  const shell = useShell();
  const { state } = shell;
  const footer = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(1200);
  const [pointer, setPointer] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [bouncing, setBouncing] = useState<string[]>([]);
  const [menuFor, setMenuFor] = useState<{ id: string; label: string; x: number; lift: number } | null>(null);
  const magnifyOn = (shell.settings["appearance.dockMagnify"] ?? "on") !== "off";

  useEffect(() => {
    const el = footer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wins = state.windows.filter((w) => w.workspace === state.activeWorkspace);
  const minimised = wins.filter((w) => w.minimized).sort((a, b) => a.z - b.z);

  const items: Item[] = (() => {
    const out: Item[] = [{ kind: "launchpad", key: "launchpad", label: "Launchpad" }];
    GROUPS.forEach((g, gi) => {
      if (gi > 0) out.push({ kind: "sep", key: `sep-${g}` });
      for (const m of MODULES.filter((x) => x.group === g)) out.push({ kind: "app", key: m.id, id: m.id, label: m.title });
    });
    out.push({ kind: "sep", key: "sep-min" });
    for (const w of minimised) out.push({ kind: "min", key: `min-${w.id}`, winId: w.id, module: w.module, label: `${w.title} (minimised)` });
    out.push({ kind: "trash", key: "trash", label: "Trash" });
    return out;
  })();

  const icons = items.filter((i) => i.kind !== "sep");
  const seps = items.length - icons.length;
  const width = avail - 16;
  const base = fitIconSize(icons.length, width, { gap: GAP, pad: PAD, separators: seps, sepWidth: SEP_W, min: MIN, max: MAX });
  const rest = dockWidth(icons.length, base, { gap: GAP, pad: PAD, separators: seps, sepWidth: SEP_W });
  const fits = rest <= width;
  const canMagnify = magnifyOn && fits;

  // resting centres (dock-local px), computed from the same constants the CSS uses
  const centers: number[] = [];
  { let x = PAD; for (const it of items) { if (it.kind === "sep") { x += SEP_W + GAP; continue; } centers.push(x + base / 2); x += base + GAP; } }
  const focusIdx = focusKey ? icons.findIndex((i) => i.key === focusKey) : -1;
  const probe = pointer ?? (focusIdx >= 0 ? centers[focusIdx] : null);
  const scales = dockScales(centers, canMagnify ? probe : null, base, DOCK_MAX_SCALE);
  const hoverIdx = probe === null ? -1 : centers.reduce((best, c, i) => (Math.abs(c - probe) < Math.abs(centers[best] - probe) ? i : best), 0);
  const labelIdx = pointer !== null ? (Math.abs(centers[hoverIdx] - pointer) <= base / 2 + GAP ? hoverIdx : -1) : focusIdx;

  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType === "touch" || !footer.current) return;
    const r = footer.current.getBoundingClientRect();
    // measured from the footer centre (fixed) against the resting width → no feedback from the growing dock
    setPointer(e.clientX - (r.left + r.width / 2 - rest / 2));
  };

  const bounce = (key: string) => {
    setBouncing((b) => [...b, key]);
    window.setTimeout(() => setBouncing((b) => b.filter((k) => k !== key)), 1300);
  };
  const activate = (id: string) => {
    const mine = wins.filter((w) => w.module === id).sort((a, b) => b.z - a.z);
    if (!mine.length) { bounce(id); shell.open(id); return; }
    const top = mine.find((w) => !w.minimized) ?? mine[0];
    shell.dispatch({ t: top.minimized ? "restore" : "focus", id: top.id });
  };
  const menuItems = (id: string): MenuItem[] => {
    const mine = wins.filter((w) => w.module === id);
    const m = moduleById(id);
    return [
      ...mine.map((w) => ({ label: w.title + (w.minimized ? " (minimised)" : ""), checked: state.focus === w.id && !w.minimized, onSelect: () => shell.dispatch({ t: w.minimized ? "restore" : "focus", id: w.id }) })),
      ...(mine.length ? [{ label: "", separator: true }] : []),
      { label: "New window", onSelect: () => { bounce(id); shell.open(id); }, testid: `dock-new-${id}` },
      ...(mine.length > 1 ? [{ label: "Show all windows", onSelect: () => mine.forEach((w) => shell.dispatch({ t: "focus", id: w.id })) }] : []),
      ...(mine.length ? [{ label: `Quit ${m?.title ?? id}`, onSelect: () => mine.forEach((w) => shell.dispatch({ t: "close", id: w.id })), testid: `dock-quit-${id}` }] : []),
    ];
  };

  let iconNo = -1;
  return (
    <div ref={footer} data-testid="dock-row" style={{ height: base + 2 * PAD + 10, flex: "0 0 auto", display: "flex", justifyContent: "center", alignItems: "flex-end", paddingBottom: 6, position: "relative", zIndex: 60 }}>
      <nav aria-label="Dock" data-testid="dock" data-base={base} data-magnify={canMagnify ? "on" : "off"} className="fs-dock"
        onPointerMove={onMove} onPointerLeave={() => setPointer(null)}
        style={{ height: base + 2 * PAD, padding: `0 ${PAD}px`, gap: GAP, maxWidth: width, overflowX: fits ? "visible" : "auto", overflowY: fits ? "visible" : "hidden" }}>
        {items.map((it) => {
          if (it.kind === "sep") return <div key={it.key} aria-hidden="true" className="fs-dock-sep" style={{ width: SEP_W, height: base * 0.8, flex: `0 0 ${SEP_W}px` }} />;
          iconNo += 1;
          const i = iconNo;
          const s = scales[i] ?? 1;
          const px = Math.round(base * s * 10) / 10;
          const running = it.kind === "app" && wins.some((w) => w.module === it.id);
          const nWin = it.kind === "app" ? wins.filter((w) => w.module === it.id).length : 0;
          const label = it.kind === "app" ? `${it.label}${running ? `, running${nWin > 1 ? ` (${nWin} windows)` : ""}` : ""}` : it.label;
          const testid = it.kind === "app" ? `dock-${it.id}` : it.kind === "min" ? `dock-min-${it.winId}` : `dock-${it.kind}`;
          return (
            <div key={it.key} className="fs-dock-slot" style={{ width: px, flex: `0 0 ${px}px`, height: base }}>
              {i === labelIdx ? <span role="tooltip" className="fs-dock-label" style={{ bottom: px + 12 }}>{it.label}</span> : null}
              <button type="button" className="fs-dock-item" data-testid={testid} data-scale={s.toFixed(3)} aria-label={label}
                {...(it.kind === "launchpad" ? { "aria-expanded": launchpadOpen, "aria-haspopup": "dialog" as const } : {})}
                data-bounce={bouncing.includes(it.kind === "app" ? it.id : it.key) || undefined}
                onFocus={() => setFocusKey(it.key)} onBlur={() => setFocusKey((k) => (k === it.key ? null : k))}
                onClick={() => {
                  if (it.kind === "launchpad") onLaunchpad();
                  else if (it.kind === "app") activate(it.id);
                  else if (it.kind === "min") shell.dispatch({ t: "restore", id: it.winId });
                  else if (it.kind === "trash") { const w = shell.open("files", { trash: true, title: "Trash" }); if (w) bounce("trash"); }
                }}
                onContextMenu={(e) => {
                  if (it.kind !== "app") return;
                  e.preventDefault();
                  // rendered at dock-row level: the dock scrolls (overflow) on narrow screens and would clip it
                  const row = footer.current!.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
                  setMenuFor({ id: it.id, label: it.label, x: b.left + b.width / 2 - row.left, lift: row.bottom - b.top + 8 });
                }}
                style={{ width: px, height: px }}>
                {it.kind === "launchpad" ? <Tile palette="slate" glyph="grid" size={10} style={{ width: px, height: px }} /> : null}
                {it.kind === "app" ? <AppIcon id={it.id} size={10} style={{ width: px, height: px }} /> : null}
                {it.kind === "trash" ? <Tile palette="slate" glyph="trash" size={10} style={{ width: px, height: px }} /> : null}
                {it.kind === "min" ? (
                  <span className="fs-dock-min" style={{ width: px, height: px }}>
                    <AppIcon id={it.module} size={10} style={{ width: px * 0.62, height: px * 0.62 }} />
                  </span>
                ) : null}
              </button>
              {running ? <span aria-hidden="true" className="fs-dock-dot" /> : null}
            </div>
          );
        })}
      </nav>
      {menuFor ? (
        <div style={{ position: "absolute", left: `clamp(8px, ${menuFor.x}px - 110px, calc(100% - 240px))`, bottom: menuFor.lift, zIndex: 9800 }}>
          <AutoMenu label={`${menuFor.label} menu`} items={menuItems(menuFor.id)} onClose={() => setMenuFor(null)} />
        </div>
      ) : null}
    </div>
  );
}
