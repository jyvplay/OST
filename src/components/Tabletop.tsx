"use client";
/**
 * TT26 "Tabletop" — a 3D desktop that replaces the classic desktop surface (windows still float above it).
 *
 * You look down into an open box: the tabletop is the floor, and four walls rise to the screen edge.
 *   floor  — your /Documents files as golden-ratio cards, each showing a *micro peek* of its real contents
 *            (src/lib/micro-peek-core.ts). Drag a card onto another card or pile to make a pile; click a pile to fan
 *            it out; drag a card out of a fan to take it out; double-click / Enter opens a file in its app.
 *   north  — Windows: every window on this workspace (click to bring it forward)
 *   east   — Widgets: clock, month calendar, table summary
 *   south  — Recent: the most recently changed files with their peeks
 *   west   — Apps: every app, grouped
 * Double-click a wall (or use the wall switcher, or Enter on a focused wall) and it unfolds on its hinge into the
 * main view; double-click its background, press Esc or "Back to the table" and it folds back. All motion is CSS
 * transforms timed from --fs-motion, so Motion: off / prefers-reduced-motion make every transition instant.
 *
 * Geometry and state are pure in src/lib/tabletop-core.ts (boxGeometry, faceTransform, piles, fan-out, hit tests).
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { fz } from "@/lib/uiscale";
import { MODULES, moduleById } from "@/lib/registry";
import { appForFile } from "@/lib/open-with";
import { microPeek, type Peek } from "@/lib/micro-peek-core";
import {
  CARD_H, CARD_W, WALLS, WALL_INFO, awayTransform, boxGeometry, faceTransform, fanLayout, floorItems, hitItem, moveItem, normalizeTable,
  pileJitter, pileUp, renamePile, takeFromPile, unstack, type Face, type FloorItem, type TableState, type Wall,
} from "@/lib/tabletop-core";
import { useShell } from "./shell-context";
import { AppIcon, FileIcon } from "./AppIcon";

interface FileNode { path: string; name: string; kind: string; mime: string; version: number; size: number; updatedAt: string }
type Drag = { key: string; fan?: { pile: string; path: string }; sx: number; sy: number; ox: number; oy: number; x: number; y: number; moved: boolean };

const MAX_FILES = 48;
/** enlarged peek: 260 px wide golden page + its name line */
const ZOOM_H = Math.round(260 * 1.618) + 30;
const GROUPS = ["Core", "Create", "Connect", "System"] as const;

export default function Tabletop() {
  const shell = useShell();
  const root = useRef<HTMLDivElement | null>(null);
  const floorInner = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1440, h: 860 });
  const [main, setMain] = useState<Face>("floor");
  const [files, setFiles] = useState<FileNode[]>([]);
  const [peeks, setPeeks] = useState<Record<string, Peek>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [fanned, setFanned] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ path: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const suppress = useRef(false);
  const hoverT = useRef(0);
  const backBtn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setSize({ w: Math.round(r.width), h: Math.round(r.height) }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(t); }, []);

  useEffect(() => {
    let live = true;
    api<{ nodes: FileNode[] }>("/api/fs?op=list&path=/Documents")
      .then((r) => { if (live) setFiles(r.nodes.filter((n) => n.kind === "file").slice(0, MAX_FILES)); })
      .catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [shell.refreshTick]);

  // micro peeks: real file contents, fetched one at a time, cached per path@version
  useEffect(() => {
    let live = true;
    const todo = files.filter((f) => !peeks[`${f.path}@${f.version}`]);
    if (!todo.length) return;
    void (async () => {
      for (const f of todo) {
        if (!live) return;
        let p: Peek;
        if (f.size > 2_000_000) p = { kind: "none", label: f.name.split(".").pop()?.toUpperCase().slice(0, 6) ?? "FILE" };
        else {
          try {
            const r = await api<{ node: { content: string; encoding: string; mime: string } }>(`/api/fs?op=read&path=${encodeURIComponent(f.path)}`);
            p = microPeek({ name: f.name, mime: r.node.mime, encoding: r.node.encoding, content: r.node.content });
          } catch { p = { kind: "none", label: "?" }; }
        }
        if (!live) return;
        setPeeks((m) => ({ ...m, [`${f.path}@${f.version}`]: p }));
      }
    })();
    return () => { live = false; };
  }, [files, peeks]);

  useEffect(() => {
    if (main === "floor" && !fanned && !zoom && !menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu) setMenu(null); else if (zoom) setZoom(null); else if (fanned) setFanned(null); else setMain("floor");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [main, fanned, zoom, menu]);

  useEffect(() => { if (main !== "floor") backBtn.current?.focus({ preventScroll: true }); }, [main]);

  const geo = boxGeometry(size.w, size.h);
  const s = geo.floorScale;
  const areaW = Math.round(size.w * s), areaH = Math.round(size.h * s);
  const paths = files.map((f) => f.path);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const table: TableState = normalizeTable(shell.state.table, paths);
  const items = floorItems(table, paths, areaW);
  const commit = (t: TableState) => shell.dispatch({ t: "table", table: t });
  const peekOf = (p: string) => { const f = byPath.get(p); return f ? peeks[`${f.path}@${f.version}`] : undefined; };
  const openFile = (p: string) => { const f = byPath.get(p); if (f) shell.open(appForFile(f.name, f.mime, f.kind), { path: f.path, title: f.name }); };

  // ------------------------------------------------------------------ floor pointer handling (drag / pile / fan)
  const local = (clientX: number, clientY: number) => {
    const el = floorInner.current!, r = el.getBoundingClientRect();
    // + scroll offset: when there are more cards than fit (e.g. a phone), the floor scrolls
    return { x: (clientX - r.left) * (areaW / r.width) + el.scrollLeft, y: (clientY - r.top) * (areaH / r.height) + el.scrollTop };
  };
  const contentH = Math.max(areaH, ...items.map((it) => it.y + CARD_H + 16));
  const floorScrolls = contentH > areaH + 1;
  const clampPos = (x: number, y: number) => ({ x: Math.max(0, Math.min(areaW - CARD_W, x)), y: Math.max(0, Math.min(contentH - CARD_H, y)) });
  const down = (e: React.PointerEvent, key: string, at: { x: number; y: number }, fan?: { pile: string; path: string }) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    suppress.current = false;
    const p = local(e.clientX, e.clientY);
    setDrag({ key, fan, sx: e.clientX, sy: e.clientY, ox: p.x - at.x, oy: p.y - at.y, x: at.x, y: at.y, moved: false });
    e.currentTarget.setPointerCapture(e.pointerId);
    setZoom(null);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = local(e.clientX, e.clientY);
    const moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
    setDrag({ ...drag, moved, x: p.x - drag.ox, y: p.y - drag.oy });
  };
  const up = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) return;
    suppress.current = true;
    const pos = clampPos(d.x, d.y);
    const cx = pos.x + CARD_W / 2, cy = pos.y + CARD_H / 2;
    if (d.fan) {
      const own = table.piles.find((p) => p.id === d.fan!.pile);
      let t = takeFromPile(table, d.fan.pile, d.fan.path, pos);
      const hit = hitItem(floorItems(t, paths, areaW), cx, cy, `card:${d.fan.path}`);
      if (hit && hit.key !== `pile:${own?.id}`) t = pileUp(t, `card:${d.fan.path}`, hit.key, { x: hit.x, y: hit.y }, paths);
      if (!t.piles.some((p) => p.id === d.fan!.pile)) setFanned(null);
      commit(t);
      return;
    }
    const hit = hitItem(items, cx, cy, d.key);
    if (hit) { commit(pileUp(table, d.key, hit.key, { x: hit.x, y: hit.y }, paths)); if (fanned && (d.key === `pile:${fanned}` || hit.key === `pile:${fanned}`)) setFanned(null); }
    else commit(moveItem(table, d.key, pos));
  };
  const nudge = (key: string, at: { x: number; y: number }, dx: number, dy: number) => commit(moveItem(table, key, clampPos(at.x + dx, at.y + dy)));
  const arrow = (e: React.KeyboardEvent): [number, number] | null =>
    e.altKey ? (({ ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] } as Record<string, [number, number]>)[e.key] ?? null) : null;
  const showZoom = (path: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect(), o = root.current!.getBoundingClientRect();
    setZoom({ path, x: r.left - o.left + r.width / 2, y: r.top - o.top });
  };

  // ------------------------------------------------------------------ faces
  const facePose = (f: Face): React.CSSProperties => {
    const isMain = main === f;
    const W = size.w, H = size.h, D = geo.depth;
    const box: Record<Face, React.CSSProperties> = {
      floor: { left: 0, top: 0, width: W, height: H },
      north: { left: 0, top: 0, width: W, height: D },
      south: { left: 0, top: H - D, width: W, height: D },
      west: { left: 0, top: 0, width: D, height: H },
      east: { left: W - D, top: 0, width: D, height: H },
    };
    const ft = faceTransform(f, D);
    if (isMain && f !== "floor") return { left: 0, top: 0, width: W, height: H, transform: "none", transformOrigin: ft.origin, opacity: 1, zIndex: 3 };
    if (main !== "floor" && !isMain) return { ...box[f], transform: awayTransform(f, D), transformOrigin: ft.origin, opacity: 0, pointerEvents: "none" };
    return { ...box[f], transform: ft.transform, transformOrigin: ft.origin, opacity: 1 };
  };
  const wallProps = (w: Wall) => ({
    "data-testid": `tt-wall-${w}`, "data-face": w, "data-main": main === w || undefined,
    className: `fs-tt-face fs-tt-wall fs-tt-wall-${w}`,
    onDoubleClick: (e: React.MouseEvent) => {
      if (main === "floor") { setMain(w); return; }
      if ((e.target as HTMLElement).closest("button, a, input")) return;
      setMain("floor");
    },
  });

  const wins = shell.state.windows.filter((w) => w.workspace === shell.state.activeWorkspace).sort((a, b) => b.z - a.z);
  const recent = [...files].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 12);
  const fanPile = fanned ? table.piles.find((p) => p.id === fanned) : undefined;
  const fanPos = fanPile ? fanLayout(fanPile.paths.length, fanPile, areaW, areaH) : [];

  const card = (path: string, opts: { x: number; y: number; rot?: number; z?: number; interactive: boolean; key: string; fan?: { pile: string; path: string }; dragging?: boolean; lifted?: boolean }) => {
    const f = byPath.get(path);
    if (!f) return null;
    const pk = peekOf(path);
    return (
      <button key={opts.key} type="button" className="fs-tt-card" data-testid="tt-card" data-path={path} data-dragging={opts.dragging || undefined}
        data-lifted={opts.lifted || undefined} tabIndex={opts.interactive ? 0 : -1} aria-hidden={opts.interactive ? undefined : true}
        aria-describedby="tt-card-hint" title={`${f.name} — ${pk?.kind === "text" ? "text preview" : pk?.kind === "grid" ? "table preview" : pk?.kind === "image" ? "image preview" : "no preview"}`}
        style={{ left: opts.x, top: opts.y, zIndex: opts.dragging ? 900 : opts.z, ["--rot" as string]: `${opts.rot ?? 0}deg`,
          pointerEvents: opts.interactive ? "auto" : "none", transition: opts.dragging ? "transform .12s ease, box-shadow .12s ease" : undefined }}
        onPointerDown={opts.interactive ? (e) => down(e, opts.fan ? `card:${path}` : `card:${path}`, { x: opts.x, y: opts.y }, opts.fan) : undefined}
        onPointerMove={opts.interactive ? move : undefined} onPointerUp={opts.interactive ? up : undefined} onPointerCancel={() => setDrag(null)}
        onDoubleClick={(e) => { e.stopPropagation(); if (!suppress.current) openFile(path); }}
        onPointerEnter={(e) => {
          if (drag || e.pointerType === "touch") return;
          const el = e.currentTarget;
          window.clearTimeout(hoverT.current);
          hoverT.current = window.setTimeout(() => showZoom(path, el), 450);
        }}
        onPointerLeave={() => { window.clearTimeout(hoverT.current); setZoom((z) => (z?.path === path ? null : z)); }}
        onFocus={(e) => showZoom(path, e.currentTarget)} onBlur={() => setZoom((z) => (z?.path === path ? null : z))}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); openFile(path); return; }
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(), o = root.current!.getBoundingClientRect(); setMenu({ key: opts.fan ? `fan:${opts.fan.pile}:${path}` : `card:${path}`, x: r.left - o.left + 20, y: r.top - o.top + 30 }); return; }
          const a = arrow(e);
          if (a && !opts.fan) { e.preventDefault(); nudge(`card:${path}`, { x: opts.x, y: opts.y }, a[0], a[1]); }
        }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const o = root.current!.getBoundingClientRect(); setMenu({ key: opts.fan ? `fan:${opts.fan.pile}:${path}` : `card:${path}`, x: e.clientX - o.left, y: e.clientY - o.top }); }}>
        <MicroPeek peek={pk} name={f.name} />
        <span className="fs-tt-card-name"><FileIcon name={f.name} kind="file" size={14} /><span>{f.name}</span></span>
      </button>
    );
  };

  // ------------------------------------------------------------------ menu actions (keyboard alternative to dragging)
  const menuItems = (key: string): { label: string; run: () => void }[] => {
    const nearest = (x: number, y: number, except: string) => items.filter((i) => i.key !== except).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
    if (key.startsWith("card:")) {
      const p = key.slice(5), me = items.find((i) => i.key === key);
      const near = me ? nearest(me.x, me.y, key) : undefined;
      return [
        { label: "Open", run: () => openFile(p) },
        ...table.piles.map((pl) => ({ label: `Add to “${pl.name}”`, run: () => commit(pileUp(table, key, `pile:${pl.id}`, { x: pl.x, y: pl.y }, paths)) })),
        ...(near && near.kind === "card" ? [{ label: `Pile with “${byPath.get(near.path)?.name ?? near.path}”`, run: () => commit(pileUp(table, key, near.key, { x: near.x, y: near.y }, paths)) }] : []),
      ];
    }
    if (key.startsWith("fan:")) {
      const [, pid, ...rest] = key.split(":"); const p = rest.join(":");
      const pile = table.piles.find((x) => x.id === pid);
      return [
        { label: "Open", run: () => openFile(p) },
        { label: "Take out of the pile", run: () => { const t = takeFromPile(table, pid, p, clampPos((pile?.x ?? 0) + CARD_W + 24, pile?.y ?? 0)); if (!t.piles.some((x) => x.id === pid)) setFanned(null); commit(t); } },
      ];
    }
    const pid = key.slice(5), pile = table.piles.find((x) => `pile:${x.id}` === key);
    return [
      { label: fanned === pid ? "Gather the pile" : "Fan out", run: () => setFanned(fanned === pid ? null : pid) },
      { label: "Unstack", run: () => { setFanned(null); commit(unstack(table, pid)); } },
      { label: "Rename…", run: () => { const n = prompt("Pile name", pile?.name ?? "Pile"); if (n) commit(renamePile(table, pid, n)); } },
    ];
  };

  const T = (f: Face) => ({ ...facePose(f) });
  const wallContent = (w: Wall) => {
    const compact = main !== w;
    return (
      <div className="fs-tt-wall-body" data-compact={compact || undefined} data-beauty-skip={compact || undefined} inert={compact}>
        <div className="fs-tt-wall-head">
          <strong>{WALL_INFO[w].title}</strong>
          {!compact ? <span className="fs-dim">{WALL_INFO[w].blurb}</span> : null}
        </div>
        {w === "north" ? (
          <div className="fs-tt-grid" data-testid="tt-windows">
            {wins.length === 0 ? <p className="fs-dim fs-tt-empty">No windows are open on this workspace.</p> : null}
            {wins.map((win) => (
              <button key={win.id} type="button" className="fs-tt-tile" data-testid={`tt-win-${win.id}`}
                onClick={() => { shell.dispatch({ t: win.minimized ? "restore" : "focus", id: win.id }); setMain("floor"); }}>
                <AppIcon id={win.module} size={10} style={{ width: 40, height: 40 }} />
                <span className="fs-tt-tile-text"><strong>{win.title}</strong><span className="fs-dim">{moduleById(win.module)?.title ?? win.module}{win.minimized ? " · minimised" : ""}</span></span>
              </button>
            ))}
          </div>
        ) : null}
        {w === "west" ? (
          <div className="fs-tt-apps" data-testid="tt-apps">
            {GROUPS.map((g) => (
              <section key={g} aria-label={g}>
                <h3>{g}</h3>
                <div className="fs-tt-app-grid">
                  {MODULES.filter((m) => m.group === g).map((m) => (
                    <button key={m.id} type="button" className="fs-tt-app" data-testid={`tt-app-${m.id}`} title={m.title} onClick={() => { shell.open(m.id); setMain("floor"); }}>
                      <AppIcon id={m.id} size={10} style={{ width: 44, height: 44 }} />
                      <span>{m.title}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : null}
        {w === "east" ? <Widgets now={now} files={files.length} piles={table.piles.length} /> : null}
        {w === "south" ? (
          <div className="fs-tt-grid" data-testid="tt-recent">
            {recent.map((f) => (
              <button key={f.path} type="button" className="fs-tt-tile fs-tt-recent" data-testid="tt-recent-item" onClick={() => openFile(f.path)}>
                <span className="fs-tt-mini" aria-hidden="true"><MicroPeek peek={peekOf(f.path)} name={f.name} /></span>
                <span className="fs-tt-tile-text"><strong>{f.name}</strong><span className="fs-dim">{new Date(f.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span></span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const zoomFile = zoom ? byPath.get(zoom.path) : undefined;
  return (
    <div ref={root} className="fs-tabletop" data-testid="tabletop" data-main={main} data-depth={geo.depth} data-floor-scale={s.toFixed(4)}
      style={{ position: "absolute", inset: 0, perspective: geo.perspective, perspectiveOrigin: "50% 50%", overflow: "hidden", "--tt-w": `${size.w}px`, "--tt-h": `${size.h}px` } as React.CSSProperties}
      onPointerDown={() => setMenu(null)}>
      <div className="fs-tt-scene">
        {/* floor */}
        <div className="fs-tt-face fs-tt-floor" data-testid="tt-floor" data-face="floor" style={T("floor")}
          onDoubleClick={(e) => { if (main !== "floor" && !(e.target as HTMLElement).closest("button")) setMain("floor"); }}
          onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button")) { setFanned(null); setZoom(null); } }}>
          <div ref={floorInner} className="fs-tt-floor-inner" data-testid="tt-floor-inner" inert={main !== "floor"}
            data-scrolls={floorScrolls || undefined}
            style={{ width: areaW, height: areaH, transform: `scale(${1 / s})`, ...(floorScrolls ? { overflowX: "hidden", overflowY: "auto", transformStyle: "flat" as const } : {}) }}>
            {files.length === 0 ? <p className="fs-tt-empty fs-dim" style={{ position: "absolute", left: 24, top: 24 }}>Files you save in /Documents appear here as cards.</p> : null}
            {items.flatMap((it: FloorItem) => {
              const dragging = drag?.moved && drag.key === it.key && !drag.fan;
              const at = dragging ? { x: drag!.x, y: drag!.y } : { x: it.x, y: it.y };
              if (it.kind === "card") return [card(it.path, { key: `c:${it.path}`, x: at.x, y: at.y, interactive: true, dragging, z: 1 })];
              const pile = it.pile, isFan = fanned === pile.id;
              return [
                ...pile.paths.map((p, i) => {
                  const fanDrag = drag?.moved && drag.fan?.path === p;
                  if (isFan) {
                    const fp = fanPos[i] ?? { x: at.x, y: at.y, rot: 0 };
                    return card(p, { key: `c:${p}`, x: fanDrag ? drag!.x : fp.x, y: fanDrag ? drag!.y : fp.y, rot: fanDrag ? 0 : fp.rot, z: 20 + i, interactive: true, fan: { pile: pile.id, path: p }, dragging: fanDrag, lifted: true });
                  }
                  const j = pileJitter(pile.id, p, i, pile.paths.length);
                  return card(p, { key: `c:${p}`, x: at.x + j.dx, y: at.y + j.dy - i * 2, rot: j.rot, z: 2 + i, interactive: false, dragging });
                }),
                <button key={it.key} type="button" className="fs-tt-pile" data-testid="tt-pile" data-pile={pile.id} data-count={pile.paths.length} data-fanned={isFan || undefined}
                  aria-expanded={isFan} aria-describedby="tt-pile-hint"
                  style={isFan ? { left: at.x, top: at.y + CARD_H - 34, height: 34, zIndex: 60 } : { left: at.x, top: at.y - (pile.paths.length - 1) * 2, zIndex: dragging ? 901 : 40 }}
                  onPointerDown={(e) => down(e, it.key, { x: it.x, y: it.y })} onPointerMove={move}
                  onPointerUp={() => { const wasDrag = drag?.moved; up(); if (!wasDrag) setFanned(isFan ? null : pile.id); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFanned(isFan ? null : pile.id); return; }
                    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(), o = root.current!.getBoundingClientRect(); setMenu({ key: it.key, x: r.left - o.left + 20, y: r.top - o.top + 30 }); return; }
                    const a = arrow(e);
                    if (a) { e.preventDefault(); nudge(it.key, { x: it.x, y: it.y }, a[0], a[1]); }
                  }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const o = root.current!.getBoundingClientRect(); setMenu({ key: it.key, x: e.clientX - o.left, y: e.clientY - o.top }); }}>
                  <span className="fs-tt-pile-badge">{pile.name} · {pile.paths.length}<span className="fs-visually-hidden"> files</span></span>
                </button>,
              ];
            })}
          </div>
        </div>
        {WALLS.map((w) => (
          <div key={w} {...wallProps(w)} style={T(w)} role="region" aria-label={`${WALL_INFO[w].title} wall`}
            aria-hidden={(main !== "floor" && main !== w) || undefined} inert={main !== "floor" && main !== w}>
            {main === "floor" ? (
              <button type="button" className="fs-tt-wall-open" data-testid={`tt-open-${w}`} aria-label={`Open the ${WALL_INFO[w].title} wall`}
                onClick={(e) => { if (e.detail === 0) setMain(w); }} onDoubleClick={() => setMain(w)} />
            ) : null}
            {wallContent(w)}
          </div>
        ))}
      </div>

      {/* enlarged micro peek (hover / focus) — flat overlay, never intercepts the pointer */}
      {zoom && zoomFile && main === "floor" && !drag ? (
        <div className="fs-tt-zoom" data-testid="tt-zoom" aria-hidden="true"
          style={{ left: Math.max(8, Math.min(size.w - 268, zoom.x - 130)), top: zoom.y - ZOOM_H - 12 >= 8 ? zoom.y - ZOOM_H - 12 : Math.min(size.h - ZOOM_H - 8, zoom.y + CARD_H + 8) }}>
          <MicroPeek peek={peekOf(zoom.path)} name={zoomFile.name} large />
          <span className="fs-tt-card-name"><span>{zoomFile.name}</span></span>
        </div>
      ) : null}

      {menu ? (
        <div className="fs-panel" role="menu" aria-label="Card actions" data-testid="tt-menu" style={{ position: "absolute", left: Math.min(menu.x, size.w - 230), top: Math.min(menu.y, size.h - 200), padding: 4, zIndex: 50, minWidth: 210 }}
          onPointerDown={(e) => e.stopPropagation()}>
          {menuItems(menu.key).map((m, i) => (
            <button key={m.label} role="menuitem" type="button" className="fs-btn" data-variant="ghost" autoFocus={i === 0} style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={() => { setMenu(null); m.run(); }}>{m.label}</button>
          ))}
        </div>
      ) : null}

      <span id="tt-card-hint" hidden>Double-click or Enter opens the file. Drag it onto another card or a pile, or press Shift+F10, to make a pile. Alt+Arrow keys move it.</span>
      <span id="tt-pile-hint" hidden>Pile. Click or Enter fans it out, Esc gathers it. Drag it onto a card or pile to merge; Shift+F10 for Unstack and Rename.</span>
      {/* switcher: single-click / keyboard route to every face (double-click is never the only way) */}
      <nav className="fs-tt-nav" aria-label="Tabletop views" data-testid="tt-nav">
        {(["floor", "north", "west", "east", "south"] as Face[]).map((f) => (
          <button key={f} type="button" aria-pressed={main === f} data-testid={`tt-nav-${f}`} onClick={() => setMain(f)}>
            {f === "floor" ? "Table" : WALL_INFO[f as Wall].title}
          </button>
        ))}
        <button type="button" data-testid="tt-classic" title="Back to the classic desktop" onClick={() => void shell.setSetting("appearance.desktopView", "classic")}>Classic</button>
      </nav>
      {main !== "floor" ? (
        <button ref={backBtn} type="button" className="fs-btn fs-tt-back" data-testid="tt-back" onClick={() => setMain("floor")}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back to the table
        </button>
      ) : null}
    </div>
  );
}

function MicroPeek({ peek, name, large = false }: { peek: Peek | undefined; name: string; large?: boolean }) {
  const cls = `fs-tt-peek${large ? " fs-tt-peek-lg" : ""}`;
  if (!peek) return <span className={cls} data-peek="loading" aria-hidden="true"><span className="fs-tt-peek-none">…</span></span>;
  if (peek.kind === "image") return <span className={cls} data-peek="image" aria-hidden="true"><img src={peek.src} alt="" draggable={false} /></span>;
  if (peek.kind === "none") return <span className={cls} data-peek="none" aria-hidden="true"><span className="fs-tt-peek-none">{peek.label || name.split(".").pop()}</span></span>;
  if (peek.kind === "grid") return (
    <span className={cls} data-peek="grid" aria-hidden="true">
      <span className="fs-tt-peek-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, ...peek.rows.map((r) => r.length))}, minmax(0, 1fr))` }}>
        {peek.rows.flatMap((r, ri) => r.map((c, ci) => <span key={`${ri}:${ci}`} data-head={ri === 0 || undefined}>{c}</span>))}
      </span>
    </span>
  );
  return (
    <span className={cls} data-peek="text" aria-hidden="true">
      {peek.lines.map((l, i) => <span key={i} className={`fs-tt-peek-${l.role}`}>{l.t || "\u00a0"}</span>)}
    </span>
  );
}

function Widgets({ now, files, piles }: { now: Date; files: number; piles: number }) {
  const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
  const cells = [...Array.from({ length: first }, () => 0), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div className="fs-tt-widgets" data-testid="tt-widgets">
      <div className="fs-tt-widget fs-tt-clock">
        <span className="fs-tt-time" data-testid="tt-time">{now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
        <span>{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
      </div>
      <div className="fs-tt-widget">
        <strong>{now.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
        <div className="fs-tt-cal">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={`h${i}`} className="fs-dim">{d}</span>)}
          {cells.map((d, i) => <span key={i} data-today={d === now.getDate() || undefined}>{d || ""}</span>)}
        </div>
      </div>
      <div className="fs-tt-widget"><strong>On the table</strong><span>{files} files · {piles} {piles === 1 ? "pile" : "piles"}</span></div>
    </div>
  );
}
