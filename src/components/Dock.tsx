"use client";
/**
 * TT25 "Art" layout — a Mac-style dock, centred and floating at the bottom, holding EVERY app.
 *  • Launchpad first, then the apps grouped (Core | Create | Connect | System) with thin separators, then the
 *    minimised windows after a separator, then Trash (Files on its trash view) — the macOS order.
 *  • TT26: the resting icon size is chosen for looks (layout-core idealDockIcon: 44–64 px on the 4-px grid, or the
 *    Small/Medium/Large preset) and the *content* is fitted to it (planDock): groups fold into stacks rather than the
 *    icons shrinking to slot-maxing sizes. Hover magnification uses
 *    a cosine falloff over the *resting* geometry (dockScales), measured from the dock's fixed centre so the dock
 *    stays stable as it widens. Keyboard focus magnifies too. Touch input never magnifies (as on macOS).
 *  • Name bubble above the hovered / focused icon, a dot under running apps, a short bounce when an app launches
 *    (none under reduced motion or Motion: off), right-click menu (window list, New window, Show all, Quit).
 *  • When even the minimum size does not fit (a phone), magnification is switched off and the dock scrolls
 *    sideways inside itself — the page never does.
 */
import { useEffect, useRef, useState } from "react";
import { MODULES, moduleById } from "@/lib/registry";
import { dockScales, idealDockIcon, planDock, DOCK_MAX_SCALE, DOCK_GAP, DOCK_PAD, DOCK_SEP_W } from "@/lib/layout-core";
import { fz } from "@/lib/uiscale";
import { useShell } from "./shell-context";
import { AppIcon, Tile } from "./AppIcon";
import { AutoMenu, type MenuItem } from "./chrome-bits";

type Item =
  | { kind: "launchpad"; key: string; label: string }
  | { kind: "app"; key: string; id: string; label: string }
  | { kind: "min"; key: string; winId: string; module: string; label: string }
  | { kind: "trash"; key: string; label: string }
  | { kind: "stack"; key: string; group: string; apps: string[]; label: string }
  | { kind: "sep"; key: string };

const GROUPS = ["Core", "Create", "Connect", "System"] as const;
const GAP = DOCK_GAP, PAD = DOCK_PAD, SEP_W = DOCK_SEP_W;

export default function Dock({ onLaunchpad, launchpadOpen }: { onLaunchpad: () => void; launchpadOpen: boolean }) {
  const shell = useShell();
  const { state } = shell;
  const footer = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(1200);
  const [vh, setVh] = useState(900);
  const [stackFor, setStackFor] = useState<{ group: string; x: number; lift: number } | null>(null);
  const [pointer, setPointer] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [bouncing, setBouncing] = useState<string[]>([]);
  const [menuFor, setMenuFor] = useState<{ id: string; label: string; x: number; lift: number } | null>(null);
  const magnifyOn = (shell.settings["appearance.dockMagnify"] ?? "on") !== "off";

  useEffect(() => {
    const el = footer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setAvail(Math.round(el.getBoundingClientRect().width)); setVh(window.innerHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wins = state.windows.filter((w) => w.workspace === state.activeWorkspace);
  const minimised = wins.filter((w) => w.minimized).sort((a, b) => a.z - b.z);

  const width = avail - 16;
  const groupsIn = GROUPS.map((g) => ({ id: g, apps: MODULES.filter((x) => x.group === g).map((m) => m.id) }));
  const plan = planDock(groupsIn, avail, idealDockIcon(avail, vh, shell.settings["appearance.dockSize"] ?? "auto"),
    { lead: 1, tail: 1 + minimised.length, running: [...new Set(wins.map((w) => w.module))] });
  const items: Item[] = (() => {
    const out: Item[] = [{ kind: "launchpad", key: "launchpad", label: "Launchpad" }];
    groupsIn.forEach((g, gi) => {
      if (gi > 0) out.push({ kind: "sep", key: `sep-${g.id}` });
      if (plan.folded.includes(g.id)) out.push({ kind: "stack", key: `stack-${g.id}`, group: g.id, apps: g.apps, label: `${g.id} apps` });
      for (const id of plan.visible[g.id] ?? []) out.push({ kind: "app", key: id, id, label: moduleById(id)?.title ?? id });
    });
    out.push({ kind: "sep", key: "sep-min" });
    for (const w of minimised) out.push({ kind: "min", key: `min-${w.id}`, winId: w.id, module: w.module, label: `${w.title} (minimised)` });
    out.push({ kind: "trash", key: "trash", label: "Trash" });
    return out;
  })();

  const icons = items.filter((i) => i.kind !== "sep");
  const base = plan.size;
  const rest = plan.width;
  const fits = rest <= width;
  // macOS: an open stack freezes the dock (no magnification) so its grid sits cleanly above the resting row
  const canMagnify = magnifyOn && fits && !stackFor;

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
      <nav aria-label="Dock" data-testid="dock" data-base={base} data-folded={plan.folded.join(",")} data-magnify={canMagnify ? "on" : "off"} className="fs-dock"
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
          const label = it.kind === "app" ? `${it.label}${running ? `, running${nWin > 1 ? ` (${nWin} windows)` : ""}` : ""}` : it.kind === "stack" ? `${it.group} apps, stack of ${it.apps.length}` : it.label;
          const testid = it.kind === "app" ? `dock-${it.id}` : it.kind === "min" ? `dock-min-${it.winId}` : it.kind === "stack" ? `dock-stack-${it.group}` : `dock-${it.kind}`;
          const stackOpen = it.kind === "stack" && stackFor?.group === it.group;
          return (
            <div key={it.key} className="fs-dock-slot" style={{ width: px, flex: `0 0 ${px}px`, height: base }}>
              {i === labelIdx ? <span role="tooltip" className="fs-dock-label" style={{ bottom: px + 12 }}>{it.label}</span> : null}
              <button type="button" className="fs-dock-item" data-testid={testid} data-scale={s.toFixed(3)} aria-label={label}
                {...(it.kind === "launchpad" ? { "aria-expanded": launchpadOpen, "aria-haspopup": "dialog" as const } : {})}
                {...(it.kind === "stack" ? { "aria-expanded": stackOpen, "aria-haspopup": "dialog" as const } : {})}
                data-bounce={bouncing.includes(it.kind === "app" ? it.id : it.key) || undefined}
                onFocus={() => setFocusKey(it.key)} onBlur={() => setFocusKey((k) => (k === it.key ? null : k))}
                onClick={(e) => {
                  if (it.kind === "stack") {
                    if (stackOpen) { setStackFor(null); return; }
                    const row = footer.current!.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
                    const dockTop = footer.current!.querySelector("nav")!.getBoundingClientRect().top;
                    setMenuFor(null);
                    setPointer(null);
                    setStackFor({ group: it.group, x: b.left + b.width / 2 - row.left, lift: row.bottom - dockTop + 10 });
                    return;
                  }
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
                {it.kind === "stack" ? (
                  <span className="fs-dock-stack" style={{ width: px, height: px, padding: px * 0.12, gap: px * 0.06 }}>
                    {it.apps.slice(0, 4).map((a) => <AppIcon key={a} id={a} size={10} style={{ width: px * 0.35, height: px * 0.35 }} />)}
                  </span>
                ) : null}
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
      {stackFor ? (
        <DockStack group={stackFor.group} x={stackFor.x} lift={stackFor.lift} onClose={(refocus) => {
          setStackFor(null);
          if (refocus) footer.current?.querySelector<HTMLButtonElement>(`[data-testid="dock-stack-${stackFor.group}"]`)?.focus();
        }} onLaunch={(id) => { setStackFor(null); activate(id); }} />
      ) : null}
      {menuFor ? (
        <div style={{ position: "absolute", left: `clamp(8px, ${menuFor.x}px - 110px, calc(100% - 240px))`, bottom: menuFor.lift, zIndex: 9800 }}>
          <AutoMenu label={`${menuFor.label} menu`} items={menuItems(menuFor.id)} onClose={() => setMenuFor(null)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A folded group's "stack" (macOS Dock stack, grid view): a popover above the tile with every app of the group.
 * Rendered at dock-row level (outside the possibly-scrolling dock so it is never clipped). Arrow keys move through
 * the grid, Enter/Space launch, Esc closes and returns focus to the tile, a click outside closes.
 */
function DockStack({ group, x, lift, onClose, onLaunch }: { group: string; x: number; lift: number; onClose: (refocus: boolean) => void; onLaunch: (id: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  const apps = MODULES.filter((m) => m.group === group);
  // columns: a pleasing near-φ block, but never wider than the screen (a phone gets 3, or 2 on a very narrow one)
  const screenW = typeof window !== "undefined" ? window.innerWidth : 1440;
  const cols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(apps.length * 1.6)), Math.floor((screenW - 16 - 26 + 4) / (92 + 4))));
  const popW = cols * 92 + (cols - 1) * 4 + 26; // cells + gaps + padding + border
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest(`[data-testid="dock-stack-${group}"]`)) closeRef.current(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [group]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : e.key === "ArrowUp" ? -cols : 0;
    if (d && i >= 0) { e.preventDefault(); btns[Math.max(0, Math.min(btns.length - 1, i + d))]?.focus(); }
  };
  const cell = 92;
  return (
    <div ref={ref} role="dialog" aria-label={`${group} apps`} data-testid="dock-stack-pop" className="fs-panel fs-dock-stack-pop" onKeyDown={onKey}
      style={{ position: "absolute", left: `clamp(8px, ${x}px - ${popW / 2}px, calc(100% - ${popW + 8}px))`, width: popW, boxSizing: "border-box", bottom: lift, zIndex: 9800,
        padding: 12, display: "grid", gap: 8 }}>
      <strong style={{ fontSize: fz(13), paddingInline: 4 }}>{group}</strong>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, ${cell}px)`, gap: 4 }}>
        {apps.map((m) => (
          <button key={m.id} type="button" className="fs-btn fs-dock-stack-app" data-variant="ghost" data-testid={`dock-stack-app-${m.id}`}
            title={m.title} onClick={() => onLaunch(m.id)}
            style={{ flexDirection: "column", height: "auto", minHeight: 88, padding: "8px 4px", gap: 6, whiteSpace: "normal" }}>
            <AppIcon id={m.id} size={10} style={{ width: 48, height: 48 }} />
            <span style={{ fontSize: fz(11), lineHeight: 1.25, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
