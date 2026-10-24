"use client";
/**
 * TT26/TT27 "Tabletop" — a 3D desktop that replaces the classic desktop surface (windows still float above it).
 *
 * TT27 camera "slant" (the default): you look down at a real desk tray at an angle (src/lib/tabletop-slant.ts).
 * The tabletop (floor) covers ≥ 80 % of the view — computed exactly and checked in the browser — the far (north)
 * wall is a band across the top, the side walls are slivers at the edges and the near (south) wall is the lip at
 * the bottom. Camera "top" is the TT26 straight-down box (kept: a working feature is never removed).
 *
 * Every surface is a board: the floor holds your /Documents files as golden-ratio cards with a *micro peek* of the
 * real contents; each wall can hold any number of pinned cards and piles, with the same moves as the floor (drag,
 * drop on a card to pile, click to fan, drag out of a fan, Alt+Arrow, Shift+F10 menu). A file lives on exactly one
 * surface. Pin by dragging a floor card onto a wall (in the box view) or from the card menu; put back the same way.
 * Each wall also keeps its built-in panel: north Windows, east Widgets, south Recent, west Apps.
 * Double-click a wall (or the switcher, or Enter on a focused wall) and it unfolds on its hinge into the main view;
 * double-click its background, Esc or "Back to the table" folds it back. Views (TT27): save the arrangement +
 * camera + main face under a name and load it again in one click. All motion is CSS transforms timed from
 * --fs-motion, so Motion: off / prefers-reduced-motion make every transition instant.
 */
import { wheelPx } from "@/lib/input";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { MODULES, moduleById } from "@/lib/registry";
import { appForFile } from "@/lib/open-with";
import { microPeek, type Peek } from "@/lib/micro-peek-core";
import {
  CARD_H, CARD_W, MAX_VIEWS, WALLS, WALL_INFO, awayTransform, boardOf, boxGeometry, deleteView, faceTransform, fanLayout, floorItems, freeSlot,
  hitItem, loadView, moveItem, moveToSurface, normalizeTable, pileJitter, pileUp, renamePile, renameView, saveView, surfacePaths, takeFromPile,
  unstack, withBoard, type Board, type Camera, type Face, type FloorItem, type TableState, type Wall,
} from "@/lib/tabletop-core";
import { apply, applyH, boxQuads, fitSlant, ident, mul, toCss, translate, wallLegibility, boxLegibility, type H3, type Mat, type P2 } from "@/lib/tabletop-slant";
import {
  LIFT_HEAD, MIN_TARGET, PITCH, ROW_SEP, WALL_BOARD_W, boardToStrip, clampPan, dockRect, elementToScreenH, fanStrip, liftMatrix, liftQuad, panToShow,
  inQuad, pinScreenSize, screenToElementH, screenToStrip, stripCss, stripFrame, stripRows, stripToBoard, surfaceAt, visibleS, type Dock, type HitVia, type StripFrame,
} from "@/lib/wall-live-core";
import { useShell } from "./shell-context";
import { AppIcon, FileIcon } from "./AppIcon";
import { askText } from "@/lib/ask";

interface FileNode { path: string; name: string; kind: string; mime: string; version: number; size: number; updatedAt: string }
type Fan = { pile: string; path: string };
/**
 * A drag. x/y (and the grab offset ox/oy) are in the SOURCE surface's display space: board px for the floor and an
 * unfolded wall, strip px (S along the wall, t across) for a wall in the overview. `target` is the surface under the
 * pointer (paint order: lifted wall > wall tag > resting wall > floor); `tpos` the drop position (board px) on it.
 */
type Drag = {
  key: string; surface: Face; fan?: Fan; sx: number; sy: number; ox: number; oy: number; x: number; y: number; moved: boolean; over: Wall | null;
  space: "board" | "strip"; target: { face: Face; via: HitVia } | null; tpos: { x: number; y: number } | null; px: number; py: number;
};
/** a wall's live strip in the overview: its pose now (resting or lifted), the pointer maps of that pose, pan and rows */
interface WallView { lifted: boolean; ew: number; eh: number; quad: P2[]; frame: StripFrame; liftFrame: StripFrame; pan: number; rows: number; toEl: H3; toSc: H3; dock: Dock; m: Mat }
const NO_PANS: Record<Wall, number> = { north: 0, east: 0, south: 0, west: 0 };
const LIFT_DELAY = 300, SETTLE_DELAY = 450, SPRING_DELAY = 350;

/** /Documents files listed on the Tabletop (micro peeks are fetched one at a time and cached per version) */
const MAX_FILES = 200;
/** enlarged peek: 260 px wide golden page + its name line */
const ZOOM_H = Math.round(260 * 1.618) + 30;
const GROUPS = ["Core", "Create", "Connect", "System"] as const;
const NAV_RESERVE = 88; // floor px kept free under the view switcher (slant camera)

export default function Tabletop() {
  const shell = useShell();
  const root = useRef<HTMLDivElement | null>(null);
  const floorInner = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 1440, h: 860 });
  const [pinSize, setPinSize] = useState<{ w: number; h: number } | null>(null);
  const [main, setMain] = useState<Face>("floor");
  /** TT48: false while the faces are transitioning after a main-face / camera / size change (data-settled on the root) */
  const [settled, setSettled] = useState(true);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [peeks, setPeeks] = useState<Record<string, Peek>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  // TT48: pointermove is a continuous-priority event whose state updates React batches to the next frame, while
  // pointerup is discrete and handled at once — so a release in the same frame as the last moves saw a stale `drag`
  // (moved=false) and the move was dropped. The handlers read and write this synchronous mirror; render uses state.
  const dragRef = useRef<Drag | null>(null);
  const setDragNow = (d: Drag | null) => { dragRef.current = d; setDrag(d); };
  const [fanned, setFanned] = useState<string | null>(null); // `${surface}:${pileId}`
  const [zoom, setZoom] = useState<{ path: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ key: string; surface: Face; x: number; y: number } | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [viewMsg, setViewMsg] = useState("");
  const [now, setNow] = useState(() => new Date());
  const suppress = useRef(false);
  const hoverT = useRef(0);
  // TT31 live walls: the one wall swung up to face you (overview only), each wall's pan along its strip, timers
  const [lift, setLift] = useState<Wall | null>(null);
  const [pans, setPans] = useState<Record<Wall, number>>(NO_PANS);
  const liftT = useRef(0);
  /** TT33: true while Esc hands focus back to a wall's own button — that focus must not lift the wall again */
  const quietFocus = useRef(false);
  const settling = useRef(false);
  const pendingLift = useRef<Wall | null>(null);
  const spring = useRef<{ w: Wall | null; t: number }>({ w: null, t: 0 });
  const backBtn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setSize({ w: Math.round(r.width), h: Math.round(r.height) }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the main wall's pinboard size (measured: it depends on the panel beside it and the viewport)
  useEffect(() => {
    const el = pinRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPinSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [main]);
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(t); }, []);

  useEffect(() => {
    let live = true;
    api<{ nodes: FileNode[] }>("/api/fs?op=list&path=/Documents")
      .then((r) => { if (live) setFiles(r.nodes.filter((n) => n.kind === "file" && !n.name.startsWith(".")).slice(0, MAX_FILES)); })
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
    if (main === "floor" && !fanned && !zoom && !menu && !viewsOpen && !lift) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu) setMenu(null); else if (viewsOpen) setViewsOpen(false); else if (zoom) setZoom(null); else if (fanned) setFanned(null);
      else if (main === "floor" && lift) {
        window.clearTimeout(liftT.current); setLift(null);
        // TT33: focus was inside the lifted wall (a pin) → return it to the control that lifted it, the wall's own
        // button, instead of leaving it on a pin of a wall that is now foreshortened (WAI-ARIA: Esc returns focus)
        const wallEl = document.querySelector(`[data-testid="tt-wall-${lift}"]`), ae = document.activeElement;
        const opener = document.querySelector<HTMLElement>(`[data-testid="tt-open-${lift}"]`);
        if (wallEl && ae && wallEl.contains(ae) && opener && ae !== opener) {
          quietFocus.current = true;
          try { opener.focus({ preventScroll: true }); } finally { quietFocus.current = false; }
        }
      } else setMain("floor");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [main, fanned, zoom, menu, viewsOpen, lift]);
  useEffect(() => () => { window.clearTimeout(liftT.current); window.clearTimeout(spring.current.t); }, []);

  useEffect(() => { if (main !== "floor") backBtn.current?.focus({ preventScroll: true }); }, [main]);

  const paths = files.map((f) => f.path);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const table: TableState = normalizeTable(shell.state.table, paths);
  const camera: Camera = table.camera ?? "slant";
  const commit = (t: TableState) => shell.dispatch({ t: "table", table: t });
  const peekOf = (p: string) => { const f = byPath.get(p); return f ? peeks[`${f.path}@${f.version}`] : undefined; };
  const openFile = (p: string) => { const f = byPath.get(p); if (f) shell.open(appForFile(f.name, f.mime, f.kind), { path: f.path, title: f.name }); };

  // ------------------------------------------------------------------ geometry (both cameras)
  const geo = boxGeometry(size.w, size.h);
  const slant = fitSlant(size.w, size.h);
  // TT29 legibility LOD: which walls are too foreshortened for text under the current camera (both cameras)
  const lod = camera === "slant" ? wallLegibility(slant) : boxLegibility(size.w, size.h, geo.depth, geo.floorScale);
  // the switcher floats over the south wall in the top-down box: measure it so a wall tag never lands under it
  const navRef = useRef<HTMLElement>(null);
  const [navBox, setNavBox] = useState<{ l: number; r: number; t: number; b: number } | null>(null);
  useEffect(() => {
    const el = navRef.current, rt = root.current;
    if (!el || !rt) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect(), o = rt.getBoundingClientRect();
      setNavBox({ l: r.left - o.left, r: r.right - o.left, t: r.top - o.top, b: r.bottom - o.top });
    });
    ro.observe(el); ro.observe(rt);
    return () => ro.disconnect();
  }, []);
  const s = geo.floorScale;
  const floorW = camera === "slant" ? slant.FW : Math.round(size.w * s);
  const floorH = camera === "slant" ? slant.FD : Math.round(size.h * s);
  const pinW = pinSize?.w ?? Math.round(size.w * 0.58), pinH = pinSize?.h ?? Math.max(200, size.h - 200);
  // a wall board is WALL_BOARD_W wide (6 cards a row) in every pose: rows unroll along the wall in the overview
  const area = (f: Face) => (f === "floor" ? { w: floorW, h: floorH } : { w: WALL_BOARD_W, h: pinH });
  const surfaceItems = (f: Face, t: TableState = table) => floorItems(boardOf(t, f), surfacePaths(t, f, paths), area(f).w);
  const itemsOf: Record<Face, FloorItem[]> = { floor: surfaceItems("floor"), north: surfaceItems("north"), east: surfaceItems("east"), south: surfaceItems("south"), west: surfaceItems("west") };
  const contentH = (f: Face) => Math.max(area(f).h, ...itemsOf[f].map((it) => it.y + CARD_H + (f === "floor" ? 16 : 24)));
  const floorScrolls = contentH("floor") > floorH + 1;
  /** a wall's pinboard grows by a card row whenever you pin near its bottom — there is no pin limit */
  const clampOn = (f: Face) => (x: number, y: number) => {
    const a = area(f);
    const maxY = f === "floor" ? contentH(f) - CARD_H - (camera === "slant" && !floorScrolls ? NAV_RESERVE : 0) : contentH(f);
    return { x: Math.max(0, Math.min(a.w - CARD_W, x)), y: Math.max(0, Math.min(Math.max(0, maxY), y)) };
  };

  // ------------------------------------------------------------------ TT31 live walls: strips, lift pose, pointer maps
  const lifted: Wall | null = main === "floor" ? lift : null;
  const W0 = size.w, H0 = size.h;
  const P3 = camera === "slant" ? slant.P : geo.perspective, OX = W0 / 2, OY = camera === "slant" ? slant.oy : H0 / 2;
  const topQ = boxQuads(W0, H0, geo.depth, s);
  const restQuad = (w: Wall): P2[] => (camera === "slant" ? slant.quads[w] : topQ.quads[w]);
  const restDims = (w: Wall) => (camera === "slant" ? { w: slant.faces[w].w, h: slant.faces[w].h } : topQ.faces[w]);
  const floorQuad: P2[] = camera === "slant" ? slant.quads.floor
    : [[OX - (W0 * s) / 2, OY - (H0 * s) / 2], [OX + (W0 * s) / 2, OY - (H0 * s) / 2], [OX + (W0 * s) / 2, OY + (H0 * s) / 2], [OX - (W0 * s) / 2, OY + (H0 * s) / 2]];
  // the lifted wall sits in front of every resting face (deepest z' toward the viewer + the 56 px card lift)
  let zFront = 2;
  if (camera === "slant") for (const f of ["floor", "north", "south", "west", "east"] as const) {
    const { w: fw, h: fh, m } = slant.faces[f];
    for (const [u, v] of [[0, 0], [fw, 0], [fw, fh], [0, fh]] as P2[]) zFront = Math.max(zFront, Math.ceil(apply(m, [u, v, 0])[2]) + 60);
  }
  const lipTop = camera === "slant" ? slant.quads.south[0][1] : H0;
  const wv = {} as Record<Wall, WallView>;
  for (const w of WALLS) {
    const rd = restDims(w), rot = camera === "slant" || w === "north" || w === "south" ? 0 : w === "west" ? 90 : -90;
    const dock = dockRect(w, { W: W0, H: H0, lipTop, nav: navBox });
    const m = liftMatrix(dock, P3, OX, OY, zFront);
    const liftFrame = stripFrame(dock.ew, dock.eh, 0, LIFT_HEAD);
    const isLifted = lifted === w;
    const quad = isLifted ? liftQuad(dock, m, P3, OX, OY) : restQuad(w);
    const ew = isLifted ? dock.ew : rd.w, eh = isLifted ? dock.eh : rd.h;
    const frame = isLifted ? liftFrame : stripFrame(rd.w, rd.h, rot as 0 | 90 | -90);
    const rows = stripRows(itemsOf[w].map((it) => it.y));
    wv[w] = { lifted: isLifted, ew, eh, quad, frame, liftFrame, rows, pan: clampPan(frame, rows, pans[w]), toEl: screenToElementH(quad, ew, eh), toSc: elementToScreenH(quad, ew, eh), dock, m };
  }
  const clearLiftTimer = () => { window.clearTimeout(liftT.current); settling.current = false; pendingLift.current = null; };
  const liftNow = (w: Wall) => { if (quietFocus.current) return; clearLiftTimer(); if (main === "floor" && lift !== w) setLift(w); };
  const hoverWall = (w: Wall) => { clearLiftTimer(); if (lift !== w) { pendingLift.current = w; liftT.current = window.setTimeout(() => { pendingLift.current = null; setLift(w); }, LIFT_DELAY); } };
  /**
   * Hover INTENT: only real pointer movement over a wall (or its tag) arms the lift — not the synthetic enter Chrome
   * sends when the layout changes under a resting mouse (e.g. returning to the overview with the pointer parked on a
   * tag used to swing that wall up unasked). Armed once per wall, so moving within it does not postpone the lift.
   */
  const intent = (w: Wall, e: React.PointerEvent) => {
    if (drag || main !== "floor" || e.pointerType === "touch" || !(e.movementX || e.movementY)) return;
    if (lift === w) { if (settling.current) clearLiftTimer(); return; }
    if (pendingLift.current !== w) hoverWall(w);
  };
  const leaveWall = (w: Wall, ms = SETTLE_DELAY) => {
    clearLiftTimer();
    if (lift === w) { settling.current = true; liftT.current = window.setTimeout(() => { settling.current = false; setLift((cur) => (cur === w ? null : cur)); setFanned((fk) => (fk?.startsWith(`${w}:`) ? null : fk)); }, ms); }
  };
  /**
   * Hover model (geometric, so the swing itself can never make the pointer "leave"): a lifted wall stays up while the
   * pointer is over its lifted panel OR its resting outline, and settles SETTLE_DELAY after the pointer leaves both —
   * unless keyboard focus is inside it. (A rest point at the frame edge outside the docked panel used to oscillate.)
   */
  const hoverTrack = (e: React.PointerEvent) => {
    if (drag || main !== "floor" || !lift || e.pointerType === "touch") return;
    const pt = rootPt(e.clientX, e.clientY);
    if (inQuad(pt, wv[lift].quad) || inQuad(pt, restQuad(lift))) { if (settling.current) clearLiftTimer(); return; }
    if (settling.current || root.current?.querySelector(`[data-testid=tt-wall-${lift}]`)?.contains(document.activeElement) || menu) return;
    leaveWall(lift);
  };
  const cancelSpring = () => { window.clearTimeout(spring.current.t); spring.current = { w: null, t: 0 }; };
  const springTo = (w: Wall | null) => {
    if (spring.current.w === w) return;
    cancelSpring();
    if (w && w !== lift) spring.current = { w, t: window.setTimeout(() => { clearLiftTimer(); setLift(w); }, SPRING_DELAY) };
  };
  /** change the main face; any lifted wall and every pending lift / settle / spring timer goes with the overview */
  const openFace = (f: Face) => { clearLiftTimer(); cancelSpring(); setLift(null); setMain(f); };
  const setPan = (w: Wall, p: number) => setPans((cur) => ({ ...cur, [w]: clampPan(wv[w].frame, wv[w].rows, p) }));
  const panLifted = (w: Wall, S: number) => setPans((cur) => ({ ...cur, [w]: panToShow(wv[w].liftFrame, wv[w].rows, cur[w], S) }));
  const rootPt = (clientX: number, clientY: number): P2 => { const o = root.current!.getBoundingClientRect(); return [clientX - o.left, clientY - o.top]; };
  const tagRects = () => {
    const out: Partial<Record<Wall, { x: number; y: number; w: number; h: number }>> = {};
    const o = root.current?.getBoundingClientRect();
    if (o) root.current!.querySelectorAll<HTMLElement>("[data-wall-tag]").forEach((el) => { const b = el.getBoundingClientRect(); out[el.dataset.wallTag as Wall] = { x: b.left - o.left, y: b.top - o.top, w: b.width, h: b.height }; });
    return out;
  };
  const hitSurface = (pt: P2) => surfaceAt(pt, { lifted, liftedQuad: lifted ? wv[lifted].quad : null, tags: tagRects(),
    rest: { north: restQuad("north"), south: restQuad("south"), west: restQuad("west"), east: restQuad("east") }, floor: floorQuad });
  /** is a resting pin big enough on screen to be a pointer target (WCAG 2.5.8)? Smaller ones lift the wall instead. */
  const restTarget = (v: WallView, S: number, t: number) => { const z = pinScreenSize(v.toSc, v.frame, S, t, v.pan); return z.w >= MIN_TARGET && z.h >= MIN_TARGET; };

  // ------------------------------------------------------------------ pointer handling (drag / pile / fan / pin)
  const local = (f: Face, clientX: number, clientY: number) => {
    if (f === "floor") {
      const el = floorInner.current!;
      if (camera === "slant") {
        const o = root.current!.getBoundingClientRect();
        const [u, v] = applyH(slant.toFloor, [clientX - o.left, clientY - o.top]);
        return { x: u + el.scrollLeft, y: v + el.scrollTop };
      }
      const r = el.getBoundingClientRect();
      // + scroll offset: when there are more cards than fit (e.g. a phone), the floor scrolls
      return { x: (clientX - r.left) * (floorW / r.width) + el.scrollLeft, y: (clientY - r.top) * (floorH / r.height) + el.scrollTop };
    }
    const el = pinRef.current!, r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };
  /** a pointer in a surface's display space: board px (floor, unfolded wall) or strip px (a wall in the overview) */
  const pointerOn = (f: Face, clientX: number, clientY: number) => {
    if (f === "floor" || main === f) return local(f, clientX, clientY);
    const v = wv[f], st = screenToStrip(rootPt(clientX, clientY), v.toEl, v.frame, v.pan);
    return { x: st.S, y: st.t };
  };
  /** where a card dropped at this point lands on another surface (board px, card centred on the pointer) */
  const dropPos = (target: { face: Face; via: HitVia }, clientX: number, clientY: number) => {
    if (target.via === "tag") return null; // a tag is a coarse target: next free slot
    if (target.face === "floor") { const q = local("floor", clientX, clientY); return clampOn("floor")(q.x - CARD_W / 2, q.y - CARD_H / 2); }
    const v = wv[target.face], st = screenToStrip(rootPt(clientX, clientY), v.toEl, v.frame, v.pan);
    const b = stripToBoard(st.S - CARD_W / 2, st.t - CARD_H / 2);
    return clampOn(target.face)(b.x, b.y);
  };
  const down = (e: React.PointerEvent, surface: Face, key: string, at: { x: number; y: number }, fan?: Fan) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    suppress.current = false;
    const p = pointerOn(surface, e.clientX, e.clientY), [px, py] = rootPt(e.clientX, e.clientY);
    setDragNow({ key, surface, fan, sx: e.clientX, sy: e.clientY, ox: p.x - at.x, oy: p.y - at.y, x: at.x, y: at.y, moved: false, over: null,
      space: surface !== "floor" && main !== surface ? "strip" : "board", target: null, tpos: null, px, py });
    e.currentTarget.setPointerCapture(e.pointerId);
    setZoom(null);
  };
  const move = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = pointerOn(drag.surface, e.clientX, e.clientY), pt = rootPt(e.clientX, e.clientY);
    const moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4;
    // in the overview every surface is a drop target; an unfolded wall or the floor behind it only takes its own cards
    const target = !moved ? null : main === "floor" ? hitSurface(pt) : { face: drag.surface, via: "floor" as HitVia };
    const over = target && target.face !== "floor" && target.face !== drag.surface ? (target.face as Wall) : null;
    // spring-loading: hold a card over a resting wall (or its tag) and it swings up to take the drop
    if (main === "floor") springTo(target && target.face !== "floor" && target.via !== "lifted" ? (target.face as Wall) : null);
    // edge-pan: hold near either end of a lifted wall and it scrolls along
    if (target && target.via === "lifted" && lifted) {
      const v = wv[lifted], st = screenToStrip(pt, v.toEl, v.frame, v.pan), edge = 60 / v.frame.k, vis = visibleS(v.frame);
      if (st.S - v.pan < edge && v.pan > 0) setPan(lifted, v.pan - 16 / v.frame.k);
      else if (st.S - v.pan > vis - edge) setPan(lifted, v.pan + 16 / v.frame.k);
    }
    const tpos = target && target.face !== drag.surface ? dropPos(target, e.clientX, e.clientY) : null;
    setDragNow({ ...drag, moved, over, target, tpos, px: pt[0], py: pt[1], x: p.x - drag.ox, y: p.y - drag.oy });
  };
  const pinPos = (t: TableState, w: Wall) => freeSlot(floorItems(boardOf(t, w), surfacePaths(t, w, paths), WALL_BOARD_W), WALL_BOARD_W);
  /** a card / pile / card out of a fan moved to ANOTHER surface; it piles up if it lands on something there */
  const crossDrop = (d: Drag, to: Face, pos: { x: number; y: number } | null) => {
    const f = d.surface;
    let t = table, key = d.key;
    if (d.fan) { t = withBoard(t, f, takeFromPile(boardOf(t, f), d.fan.pile, d.fan.path, { x: 0, y: 0 })); key = `card:${d.fan.path}`; if (!boardOf(t, f).piles.some((p) => p.id === d.fan!.pile)) setFanned(null); }
    else if (fanned === `${f}:${d.key.slice(5)}`) setFanned(null);
    const at = pos ?? (to === "floor" ? freeSlot(surfaceItems("floor", t), floorW) : pinPos(t, to as Wall));
    const before = new Set(boardOf(t, to).piles.map((p) => p.id));
    const moved = moveToSurface(t, key, f, to, at, paths);
    if (moved === t) return;
    t = moved;
    let mk = key;
    if (key.startsWith("pile:")) { const np = boardOf(t, to).piles.find((p) => !before.has(p.id)); if (np) mk = `pile:${np.id}`; }
    if (pos) {
      const here = surfacePaths(t, to, paths), hit = hitItem(floorItems(boardOf(t, to), here, area(to).w), at.x + CARD_W / 2, at.y + CARD_H / 2, mk);
      if (hit) t = withBoard(t, to, pileUp(boardOf(t, to), mk, hit.key, { x: hit.x, y: hit.y }, here));
    }
    commit(t);
  };
  const up = () => {
    const d = dragRef.current;
    if (!d) return;
    const f = d.surface;
    setDragNow(null);
    const sprung = spring.current.w !== null;
    cancelSpring();
    if (!d.moved) return;
    suppress.current = true;
    // a wall that swung up for this drop settles again unless the pointer is still on it
    if (lifted && !(d.target?.via === "lifted") && !sprung) leaveWall(lifted);
    if (d.target && d.target.face !== f) { crossDrop(d, d.target.face, d.tpos); return; }
    const board = boardOf(table, f), here = surfacePaths(table, f, paths);
    const raw = d.space === "strip" ? stripToBoard(d.x, d.y) : { x: d.x, y: d.y };
    const pos = clampOn(f)(raw.x, raw.y);
    const cx = pos.x + CARD_W / 2, cy = pos.y + CARD_H / 2;
    if (d.fan) {
      const own = board.piles.find((p) => p.id === d.fan!.pile);
      let b: Board = takeFromPile(board, d.fan.pile, d.fan.path, pos);
      const hit = hitItem(floorItems(b, here, area(f).w), cx, cy, `card:${d.fan.path}`);
      if (hit && hit.key !== `pile:${own?.id}`) b = pileUp(b, `card:${d.fan.path}`, hit.key, { x: hit.x, y: hit.y }, here);
      if (!b.piles.some((p) => p.id === d.fan!.pile)) setFanned(null);
      commit(withBoard(table, f, b));
      return;
    }
    const hit = hitItem(itemsOf[f], cx, cy, d.key);
    if (hit) {
      commit(withBoard(table, f, pileUp(board, d.key, hit.key, { x: hit.x, y: hit.y }, here)));
      if (fanned && (fanned === `${f}:${d.key.slice(5)}` || fanned === `${f}:${hit.key.slice(5)}`)) setFanned(null);
    } else commit(withBoard(table, f, moveItem(board, d.key, pos)));
  };
  const nudge = (f: Face, key: string, at: { x: number; y: number }, dx: number, dy: number) =>
    commit(withBoard(table, f, moveItem(boardOf(table, f), key, clampOn(f)(at.x + dx, at.y + dy))));
  const arrow = (e: React.KeyboardEvent): [number, number] | null =>
    e.altKey ? (({ ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] } as Record<string, [number, number]>)[e.key] ?? null) : null;
  const showZoom = (path: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect(), o = root.current!.getBoundingClientRect();
    setZoom({ path, x: r.left - o.left + r.width / 2, y: r.top - o.top });
  };
  const openMenu = (key: string, surface: Face, x: number, y: number) => setMenu({ key, surface, x, y });

  // ------------------------------------------------------------------ faces
  const facePose = (f: Face): React.CSSProperties => {
    const isMain = main === f;
    const W = size.w, H = size.h;
    // TT31: the lifted wall lies flat in front of the scene, docked at its own edge (exact projection: wall-live-core)
    if (f !== "floor" && lifted === f) { const v = wv[f]; return { left: 0, top: 0, width: v.dock.ew, height: v.dock.eh, transform: toCss(v.m), transformOrigin: "0 0", opacity: 1 }; }
    if (camera === "slant") {
      const sf = slant.faces[f];
      if (isMain && f !== "floor") return { left: 0, top: 0, width: W, height: H, transform: toCss(ident()), transformOrigin: "0 0", opacity: 1, zIndex: 3 };
      if (main !== "floor" && !isMain) return { left: 0, top: 0, width: sf.w, height: sf.h, transform: toCss(mul(translate(0, 0, -Math.round(H * 0.9)), sf.m)), transformOrigin: "0 0", opacity: 0, pointerEvents: "none" };
      return { left: 0, top: 0, width: sf.w, height: sf.h, transform: toCss(sf.m), transformOrigin: "0 0", opacity: 1 };
    }
    const D = geo.depth;
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
    "data-testid": `tt-wall-${w}`, "data-face": w, "data-main": main === w || undefined, "data-drop": drag?.over === w || undefined,
    "data-lifted": lifted === w || undefined,
    className: `fs-tt-face fs-tt-wall fs-tt-wall-${w}`,
    onDoubleClick: (e: React.MouseEvent) => {
      if (main === "floor") { if ((e.target as HTMLElement).closest("[data-testid=tt-pin], [data-testid=tt-wallpile], .fs-tt-strip-head button")) return; openFace(w); return; }
      if ((e.target as HTMLElement).closest("button, a, input")) return;
      openFace("floor");
    },
    // TT31 live walls: hover (300 ms), focus (at once) or a wheel turn swings the wall up; leaving lets it settle
    onPointerMove: (e: React.PointerEvent) => intent(w, e),
    onPointerLeave: () => { if (!drag && main === "floor" && lift !== w) clearLiftTimer(); },
    onPointerDown: (e: React.PointerEvent) => {
      if (main !== "floor") return;
      if (e.pointerType === "touch") { if (!(e.target as HTMLElement).closest("[data-testid=tt-pin], [data-testid=tt-wallpile]")) liftNow(w); return; }
      // TT40 (LY-22 race, root cause): a press is CLICK intent, not hover intent — a pending hover-lift must not swing
      // the wall away between the two clicks of a double-click (the second click then missed the wall's open button,
      // so the double-click was lost whenever the 300 ms deadline fell between the clicks). Movement re-arms it.
      if (pendingLift.current === w) clearLiftTimer();
    },
    // TT40 (LY-22 root cause, measured: the wall lifted 11 ms after the first press, so the second click of a
    // double-click hit the background): focus from a POINTER press must not lift — that is click intent. Keyboard focus
    // still lifts at once. :focus-visible is the platform's own keyboard-vs-pointer focus heuristic; a browser without
    // it keeps the old behaviour (lift on any focus).
    onFocus: (e: React.FocusEvent) => {
      if (main !== "floor") return;
      let keyboard = true;
      try { keyboard = (e.target as HTMLElement).matches(":focus-visible"); } catch { /* no :focus-visible support */ }
      if (keyboard) liftNow(w);
    },
    onBlur: (e: React.FocusEvent) => { if (main === "floor" && !e.currentTarget.contains(e.relatedTarget as Node | null) && menu?.surface !== w) leaveWall(w, 200); },
    onWheel: (e: React.WheelEvent) => {
      if (main !== "floor") return;
      const px = wheelPx(e, (e.currentTarget as HTMLElement).clientHeight || 800); // TT66 IN-01: deltaMode-aware
      const v = wv[w], dl = Math.abs(px.dx) > Math.abs(px.dy) ? px.dx : px.dy;
      if (!dl) return;
      if (lift !== w) liftNow(w);
      setPan(w, v.pan + dl / v.frame.k);
    },
  });

  const wins = shell.state.windows.filter((w) => w.workspace === shell.state.activeWorkspace).sort((a, b) => b.z - a.z);
  const recent = [...files].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 12);

  const card = (surface: Face, path: string, opts: { x: number; y: number; rot?: number; z?: number; interactive: boolean; key: string; fan?: Fan; dragging?: boolean; lifted?: boolean }) => {
    const f = byPath.get(path);
    if (!f) return null;
    const pk = peekOf(path);
    const menuKey = opts.fan ? `fan:${opts.fan.pile}:${path}` : `card:${path}`;
    return (
      <button key={opts.key} type="button" className="fs-tt-card" data-testid="tt-card" data-path={path} data-surface={surface} data-dragging={opts.dragging || undefined}
        data-lifted={opts.lifted || undefined} tabIndex={opts.interactive ? 0 : -1} aria-hidden={opts.interactive ? undefined : true}
        aria-describedby="tt-card-hint" title={`${f.name} — ${pk?.kind === "text" ? "text preview" : pk?.kind === "grid" ? "table preview" : pk?.kind === "image" ? "image preview" : "no preview"}`}
        style={{ left: opts.x, top: opts.y, zIndex: opts.dragging ? 900 : opts.z, ["--rot" as string]: `${opts.rot ?? 0}deg`,
          pointerEvents: opts.interactive ? "auto" : "none", transition: opts.dragging ? "transform .12s ease, box-shadow .12s ease" : undefined }}
        onPointerDown={opts.interactive ? (e) => down(e, surface, `card:${path}`, { x: opts.x, y: opts.y }, opts.fan) : undefined}
        onPointerMove={opts.interactive ? move : undefined} onPointerUp={opts.interactive ? up : undefined} onPointerCancel={() => setDragNow(null)}
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
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(), o = root.current!.getBoundingClientRect(); openMenu(menuKey, surface, r.left - o.left + 20, r.top - o.top + 30); return; }
          const a = arrow(e);
          if (a && !opts.fan) { e.preventDefault(); nudge(surface, `card:${path}`, { x: opts.x, y: opts.y }, a[0], a[1]); }
        }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const o = root.current!.getBoundingClientRect(); openMenu(menuKey, surface, e.clientX - o.left, e.clientY - o.top); }}>
        <MicroPeek peek={pk} name={f.name} />
        <span className="fs-tt-card-name"><FileIcon name={f.name} kind="file" size={14} /><span>{f.name}</span></span>
      </button>
    );
  };

  /** every card and pile of one surface (the floor, or the main wall's pinboard) */
  const boardItems = (surface: Face) => {
    const a = area(surface);
    return itemsOf[surface].flatMap((it: FloorItem) => {
      const carried = drag?.moved && drag.surface === surface && drag.key === it.key && !drag.fan;
      const elsewhere = !!(carried && drag!.target && drag!.target.face !== surface); // carried to another surface: the ghost shows it
      const dragging = carried && !elsewhere;
      const at = dragging ? { x: drag!.x, y: drag!.y } : { x: it.x, y: it.y };
      if (it.kind === "card") return [card(surface, it.path, { key: `c:${it.path}`, x: at.x, y: at.y, interactive: true, dragging, z: 1 })];
      const pile = it.pile, fk = `${surface}:${pile.id}`, isFan = fanned === fk;
      const fanPos = isFan ? fanLayout(pile.paths.length, pile, a.w, Math.max(a.h, CARD_H * 2)) : [];
      return [
        ...pile.paths.map((p, i) => {
          const fanDrag = drag?.moved && drag.surface === surface && drag.fan?.path === p && !(drag.target && drag.target.face !== surface);
          if (isFan) {
            const fp = fanPos[i] ?? { x: at.x, y: at.y, rot: 0 };
            return card(surface, p, { key: `c:${p}`, x: fanDrag ? drag!.x : fp.x, y: fanDrag ? drag!.y : fp.y, rot: fanDrag ? 0 : fp.rot, z: 20 + i, interactive: true, fan: { pile: pile.id, path: p }, dragging: fanDrag, lifted: true });
          }
          const j = pileJitter(pile.id, p, i, pile.paths.length);
          return card(surface, p, { key: `c:${p}`, x: at.x + j.dx, y: at.y + j.dy - i * 2, rot: j.rot, z: 2 + i, interactive: false, dragging });
        }),
        <button key={it.key} type="button" className="fs-tt-pile" data-testid="tt-pile" data-pile={pile.id} data-surface={surface} data-count={pile.paths.length} data-fanned={isFan || undefined}
          aria-expanded={isFan} aria-describedby="tt-pile-hint"
          style={isFan ? { left: at.x, top: at.y + CARD_H - 34, height: 34, zIndex: 60 } : { left: at.x, top: at.y - (pile.paths.length - 1) * 2, zIndex: dragging ? 901 : 40 }}
          onPointerDown={(e) => down(e, surface, it.key, { x: it.x, y: it.y })} onPointerMove={move}
          onPointerUp={() => { const wasDrag = dragRef.current?.moved; up(); if (!wasDrag) setFanned(isFan ? null : fk); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFanned(isFan ? null : fk); return; }
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(), o = root.current!.getBoundingClientRect(); openMenu(it.key, surface, r.left - o.left + 20, r.top - o.top + 30); return; }
            const ar = arrow(e);
            if (ar) { e.preventDefault(); nudge(surface, it.key, { x: it.x, y: it.y }, ar[0], ar[1]); }
          }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const o = root.current!.getBoundingClientRect(); openMenu(it.key, surface, e.clientX - o.left, e.clientY - o.top); }}>
          <span className="fs-tt-pile-badge">{pile.name} · {pile.paths.length}<span className="fs-visually-hidden"> files</span></span>
        </button>,
      ];
    });
  };

  // ------------------------------------------------------------------ menu actions (keyboard alternative to dragging)
  const menuItems = (key: string, f: Face): { label: string; run: () => void }[] => {
    const items = itemsOf[f], board = boardOf(table, f), here = surfacePaths(table, f, paths);
    const put = (b: Board) => commit(withBoard(table, f, b));
    const nearest = (x: number, y: number, except: string) => items.filter((i) => i.key !== except).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
    const moves = (k: string, t: TableState = table, from: Face = f) => [
      ...(from !== "floor" ? [{ label: "Put back on the table", run: () => commit(moveToSurface(t, k, from, "floor", freeSlot(surfaceItems("floor", t), floorW), paths)) }] : []),
      ...WALLS.filter((w) => w !== from).map((w) => ({ label: `Pin to the ${WALL_INFO[w].title} wall`, run: () => commit(moveToSurface(t, k, from, w, pinPos(t, w), paths)) })),
    ];
    if (key.startsWith("card:")) {
      const p = key.slice(5), me = items.find((i) => i.key === key);
      const near = me ? nearest(me.x, me.y, key) : undefined;
      return [
        { label: "Open", run: () => openFile(p) },
        ...board.piles.map((pl) => ({ label: `Add to “${pl.name}”`, run: () => put(pileUp(board, key, `pile:${pl.id}`, { x: pl.x, y: pl.y }, here)) })),
        ...(near && near.kind === "card" ? [{ label: `Pile with “${byPath.get(near.path)?.name ?? near.path}”`, run: () => put(pileUp(board, key, near.key, { x: near.x, y: near.y }, here)) }] : []),
        ...moves(key),
      ];
    }
    if (key.startsWith("fan:")) {
      const [, pid, ...rest] = key.split(":"); const p = rest.join(":");
      const pile = board.piles.find((x) => x.id === pid);
      const takeOut = () => { const b = takeFromPile(board, pid, p, clampOn(f)((pile?.x ?? 0) + CARD_W + 24, pile?.y ?? 0)); if (!b.piles.some((x) => x.id === pid)) setFanned(null); return withBoard(table, f, b); };
      return [
        { label: "Open", run: () => openFile(p) },
        { label: "Take out of the pile", run: () => commit(takeOut()) },
      ];
    }
    const pid = key.slice(5), pile = board.piles.find((x) => `pile:${x.id}` === key), fk = `${f}:${pid}`;
    return [
      { label: fanned === fk ? "Gather the pile" : "Fan out", run: () => setFanned(fanned === fk ? null : fk) },
      { label: "Unstack", run: () => { setFanned(null); put(unstack(board, pid)); } },
      { label: "Rename…", run: () => { void askText("Pile name", pile?.name ?? "Pile", { okLabel: "Rename" }).then((n) => { if (n) put(renamePile(board, pid, n)); }); } },
      ...moves(key),
    ];
  };

  // ------------------------------------------------------------------ saved views
  const doSave = () => {
    const n = viewName.trim();
    if (!n) { setViewMsg("Type a name for this view first."); return; }
    const t = saveView(table, n, main, new Date().toISOString());
    if (t === table) { setViewMsg(`You can keep ${MAX_VIEWS} views — delete one to save another.`); return; }
    commit(t); setViewName(""); setViewMsg(`Saved “${n}”.`);
  };
  const doLoad = (id: string) => {
    const r = loadView(table, id, paths);
    if (!r) return;
    commit(r.table); setFanned(null); setZoom(null); openFace(r.face); setViewsOpen(false);
  };
  const setCamera = (c: Camera) => commit({ ...table, camera: c });

  const T = (f: Face) => ({ ...facePose(f) });
  /** the TT29 "detail" body of a resting wall (only where the camera leaves it legible): built-in panel, inert */
  const compactBody = (w: Wall, pinCount: number, builtin: React.ReactNode) => (
    <div className="fs-tt-wall-body" data-compact data-beauty-skip inert>
      <div className="fs-tt-wall-head"><strong>{WALL_INFO[w].title}</strong>{pinCount ? <span className="fs-tt-pincount">{pinCount} pinned</span> : null}</div>
      {builtin}
    </div>
  );

  // ------------------------------------------------------------------ TT31 live wall strip (overview)
  const kindOf = (p: string) => (byPath.get(p)?.name ?? p).split(".").pop()?.toLowerCase().slice(0, 5);
  const pinKeys = (w: Wall, path: string, menuKey: string, at: { S: number; t: number }, fan?: Fan) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); openFile(path); return; }
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(), o = root.current!.getBoundingClientRect(); openMenu(menuKey, w, r.left - o.left + 20, r.top - o.top + 30); return; }
    const a = arrow(e);
    if (a && !fan) { e.preventDefault(); const b = stripToBoard(at.S, at.t); nudge(w, `card:${path}`, b, a[0], a[1]); }
  };
  /** one pinned card on a wall strip — the SAME element resting and lifted (focus survives the lift) */
  const pin = (w: Wall, v: WallView, path: string, o: { S: number; t: number; z: number; rot?: number; fan?: Fan; dragging?: boolean; away?: boolean }) => {
    const f = byPath.get(path);
    if (!f) return null;
    const big = v.lifted || restTarget(v, o.S, o.t);
    const style = { left: o.S, top: o.t, zIndex: o.dragging ? 900 : o.z, ["--rot" as string]: `${o.rot ?? 0}deg` } as React.CSSProperties;
    if (!big) return <span key={`c:${path}`} className="fs-tt-glyph fs-tt-pin" data-testid="tt-pin" data-path={path} data-surface={w} data-kind={kindOf(path)} aria-hidden="true" style={style} />;
    const menuKey = o.fan ? `fan:${o.fan.pile}:${path}` : `card:${path}`;
    return (
      <button key={`c:${path}`} type="button" className={v.lifted ? "fs-tt-card fs-tt-pincard" : "fs-tt-glyph fs-tt-pin"} data-testid="tt-pin" data-path={path} data-surface={w}
        data-kind={kindOf(path)} data-dragging={o.dragging || undefined} data-away={o.away || undefined} data-fan={o.fan ? o.fan.pile : undefined}
        aria-label={v.lifted ? undefined : `${f.name}, pinned to the ${WALL_INFO[w].title} wall`} aria-describedby="tt-card-hint" style={style}
        onPointerDown={(e) => down(e, w, `card:${path}`, { x: o.S, y: o.t }, o.fan)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setDragNow(null); cancelSpring(); }}
        onDoubleClick={(e) => { e.stopPropagation(); if (!suppress.current) openFile(path); }}
        onFocus={() => { liftNow(w); panLifted(w, o.S); }}
        onKeyDown={pinKeys(w, path, menuKey, o, o.fan)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const r = root.current!.getBoundingClientRect(); openMenu(menuKey, w, e.clientX - r.left, e.clientY - r.top); }}>
        {v.lifted ? (
          <>
            <MicroPeek peek={peekOf(path)} name={f.name} />
            <span className="fs-tt-card-name" style={{ fontSize: `max(calc(11px * var(--fs-u)), ${Math.ceil(10 / v.frame.k)}px)` }}><span>{f.name}<span className="fs-visually-hidden">, pinned to the {WALL_INFO[w].title} wall</span></span></span>
          </>
        ) : null}
      </button>
    );
  };
  const liveStrip = (w: Wall) => {
    const v = wv[w], fr = v.frame, items = itemsOf[w], title = WALL_INFO[w].title;
    const dragHere = (key: string) => drag?.moved && drag.surface === w && drag.key === key && !drag.fan;
    const away = (key: string) => !!(dragHere(key) && drag!.target && drag!.target.face !== w);
    const fannedHere = fanned?.startsWith(`${w}:`) ? fanned.slice(w.length + 1) : null;
    const out: React.ReactNode[] = [];
    for (const it of items) {
      const home = boardToStrip(it.x, it.y), live = dragHere(it.key) && !away(it.key), at = live ? { S: drag!.x, t: drag!.y } : home;
      if (it.kind === "card") { out.push(pin(w, v, it.path, { ...at, z: 1, dragging: live, away: away(it.key) })); continue; }
      const pile = it.pile, fk = `${w}:${pile.id}`, n = pile.paths.length;
      if (fannedHere === pile.id) {
        fanStrip(n, home.S).forEach((fp, i) => {
          const fd = drag?.moved && drag.surface === w && drag.fan?.path === pile.paths[i] && !(drag.target && drag.target.face !== w);
          out.push(pin(w, v, pile.paths[i], { S: fd ? drag!.x : fp.S, t: fd ? drag!.y : fp.t, rot: fd ? 0 : fp.rot, z: 20 + i, fan: { pile: pile.id, path: pile.paths[i] }, dragging: fd }));
        });
        continue;
      }
      const big = v.lifted || restTarget(v, at.S, at.t), top = pile.paths[n - 1];
      const style = { left: at.S, top: at.t, zIndex: live ? 901 : 10 } as React.CSSProperties;
      if (!big) { out.push(<span key={it.key} className="fs-tt-glyph fs-tt-pin" data-testid="tt-wallpile" data-count={n} data-pile={pile.id} aria-hidden="true" style={style} />); continue; }
      out.push(
        <button key={it.key} type="button" className={v.lifted ? "fs-tt-wallpile" : "fs-tt-glyph fs-tt-pin"} data-testid="tt-wallpile" data-pile={pile.id} data-surface={w} data-count={n}
          data-dragging={live || undefined} data-away={away(it.key) || undefined} aria-expanded={false} aria-describedby="tt-pile-hint"
          aria-label={v.lifted ? undefined : `Pile “${pile.name}”, ${n} files, on the ${title} wall`} style={style}
          onPointerDown={(e) => down(e, w, it.key, { x: at.S, y: at.t })} onPointerMove={move} onPointerCancel={() => { setDragNow(null); cancelSpring(); }}
          onPointerUp={() => { const was = dragRef.current?.moved; up(); if (!was) { liftNow(w); setFanned(fk); } }}
          onFocus={() => { liftNow(w); panLifted(w, at.S); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFanned(fk); return; }
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(), o = root.current!.getBoundingClientRect(); openMenu(it.key, w, r.left - o.left + 20, r.top - o.top + 30); return; }
            const ar = arrow(e);
            if (ar) { e.preventDefault(); nudge(w, it.key, { x: it.x, y: it.y }, ar[0], ar[1]); }
          }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const o = root.current!.getBoundingClientRect(); openMenu(it.key, w, e.clientX - o.left, e.clientY - o.top); }}>
          {v.lifted ? (
            <>
              <MicroPeek peek={peekOf(top)} name={byPath.get(top)?.name ?? top} />
              <span className="fs-tt-pile-badge" style={{ fontSize: `max(calc(11px * var(--fs-u)), ${Math.ceil(10 / fr.k)}px)` }}>{pile.name} · {n}<span className="fs-visually-hidden"> files, on the {title} wall</span></span>
            </>
          ) : null}
        </button>,
      );
    }
    const vis = visibleS(fr), canBack = v.pan > 0.5, canOn = v.pan < Math.max(0, v.rows * PITCH - ROW_SEP - vis) - 0.5;
    const n = surfacePaths(table, w, paths).length;
    return (
      <div className="fs-tt-strip" data-testid={`tt-glyphs-${w}`} data-lod={lod?.[w].lod} data-lifted={v.lifted || undefined} data-pan={Math.round(v.pan)} data-rows={v.rows}
        data-k={fr.k.toFixed(4)} style={{ width: fr.L, height: fr.T, transform: stripCss(fr) }}>
        {w === "north" && !v.lifted && wins.length ? (
          <div className="fs-tt-winglyphs" aria-hidden="true">{wins.slice(0, 12).map((x) => <span key={x.id} className="fs-tt-glyph fs-tt-glyph-win" />)}</div>
        ) : null}
        {v.lifted ? (
          <div className="fs-tt-strip-head" style={{ height: LIFT_HEAD }}>
            <strong>{title} wall</strong>
            <span className="fs-dim">{n ? `${n} pinned · drag along, onto a card to pile, or off to the table` : "Drop cards here"}</span>
            {fannedHere ? <button type="button" className="fs-tt-strip-btn" data-testid={`tt-gather-${w}`} onClick={() => setFanned(null)}>Gather</button> : null}
            <span className="fs-tt-strip-sp" />
            <button type="button" className="fs-tt-strip-btn" data-testid={`tt-pan-back-${w}`} aria-label={`Scroll the ${title} wall back`} disabled={!canBack} onClick={() => setPan(w, v.pan - vis * 0.8)}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button type="button" className="fs-tt-strip-btn" data-testid={`tt-pan-on-${w}`} aria-label={`Scroll the ${title} wall on`} disabled={!canOn} onClick={() => setPan(w, v.pan + vis * 0.8)}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        ) : null}
        <div className="fs-tt-strip-inner" style={{ transform: `translate(${fr.padU - v.pan * fr.k}px, ${fr.padV}px) scale(${fr.k})` }}>
          {v.lifted ? Array.from({ length: v.rows - 1 }, (_, r) => (
            <span key={`sep${r}`} className="fs-tt-rowsep" aria-hidden="true" style={{ left: (r + 1) * PITCH - ROW_SEP / 2 }}>
              <span style={{ fontSize: Math.ceil(10 / fr.k) }}>{r + 2}</span>
            </span>
          )) : null}
          {out}
        </div>
      </div>
    );
  };
  const wallContent = (w: Wall) => {
    const compact = main !== w;
    const pinCount = surfacePaths(table, w, paths).length;
    const builtin = (
      <>
        {w === "north" ? (
          <div className="fs-tt-grid" data-testid="tt-windows">
            {wins.length === 0 ? <p className="fs-dim fs-tt-empty">No windows are open on this workspace.</p> : null}
            {wins.map((win) => (
              <button key={win.id} type="button" className="fs-tt-tile" data-testid={`tt-win-${win.id}`}
                onClick={() => { shell.dispatch({ t: win.minimized ? "restore" : "focus", id: win.id }); openFace("floor"); }}>
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
                    <button key={m.id} type="button" className="fs-tt-app" data-testid={`tt-app-${m.id}`} title={m.title} onClick={() => { shell.open(m.id); openFace("floor"); }}>
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
      </>
    );
    const pinH2 = contentH(w);
    if (compact && main === "floor") return <>{lod?.[w].lod === "detail" && !wv[w].lifted ? compactBody(w, pinCount, builtin) : null}{liveStrip(w)}</>;
    if (compact && lod?.[w].lod === "glyph") {
      // too foreshortened for text: pinned items as shapes only; the flat wall tag carries the words
      const pins = surfacePaths(table, w, paths);
      return (
        <div className="fs-tt-wall-body fs-tt-wall-glyphs" data-lod="glyph" data-testid={`tt-glyphs-${w}`} aria-hidden="true" inert>
          {w === "north" ? wins.slice(0, 12).map((x) => <span key={x.id} className="fs-tt-glyph fs-tt-glyph-win" />) : null}
          {pins.slice(0, 60).map((p) => <span key={p} className="fs-tt-glyph" data-kind={(byPath.get(p)?.name ?? p).split(".").pop()?.toLowerCase().slice(0, 5)} />)}
        </div>
      );
    }
    return (
      <div className="fs-tt-wall-body" data-compact={compact || undefined} data-beauty-skip={compact || undefined} inert={compact}>
        <div className="fs-tt-wall-head">
          <strong>{WALL_INFO[w].title}</strong>
          {pinCount ? <span className="fs-tt-pincount" data-testid={`tt-pincount-${w}`}>{pinCount} pinned</span> : null}
          {!compact ? <span className="fs-dim">{WALL_INFO[w].blurb}. Drag cards here from the table, or use a card&rsquo;s menu (Shift+F10) to pin it.</span> : null}
        </div>
        {compact ? (
          <>
            {pinCount ? (
              <div className="fs-tt-pinchips" aria-hidden="true">
                {surfacePaths(table, w, paths).slice(0, 8).map((p) => <span key={p} className="fs-tt-pinchip"><FileIcon name={byPath.get(p)?.name ?? p} kind="file" size={12} />{byPath.get(p)?.name ?? p}</span>)}
              </div>
            ) : null}
            {builtin}
          </>
        ) : (
          <div className="fs-tt-wall-split">
            <div className="fs-tt-wall-panel">{builtin}</div>
            <section className="fs-tt-pinboard" data-testid={`tt-pinboard-${w}`} aria-label={`Pinned to the ${WALL_INFO[w].title} wall`} ref={pinRef}
              onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button")) { setFanned(null); setZoom(null); } }}>
              <div className="fs-tt-pinboard-inner" style={{ height: pinH2, minWidth: WALL_BOARD_W }}>
                {pinCount === 0 ? <p className="fs-tt-empty fs-dim" style={{ position: "absolute", left: 24, top: 24, maxWidth: 360 }}>Nothing pinned yet. Drag a card from the table onto this wall, or press Shift+F10 on a card and choose “Pin to the {WALL_INFO[w].title} wall”.</p> : null}
                {boardItems(w)}
              </div>
            </section>
          </div>
        )}
      </div>
    );
  };

  // TT48: expose "the box has finished moving" — the faces' computed transition time (0 under reduced motion) after the
  // last main/camera/size change. Pointer work that starts mid-transition is mapped through a moving transform.
  useEffect(() => {
    const el = root.current; if (!el) return;
    const face = el.querySelector<HTMLElement>(".fs-tt-face");
    const ms = face ? Math.max(0, ...getComputedStyle(face).transitionDuration.split(",").map((v) => (v.trim().endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000) || 0)) : 0;
    if (ms === 0) { setSettled(true); return; }
    setSettled(false);
    const t = window.setTimeout(() => setSettled(true), ms + 80);
    return () => window.clearTimeout(t);
  }, [main, camera, size.w, size.h]);

  const zoomFile = zoom ? byPath.get(zoom.path) : undefined;
  const views = table.views ?? [];
  return (
    <div ref={root} className="fs-tabletop" data-testid="tabletop" data-main={main} data-settled={settled ? "true" : "false"} data-camera={camera} data-depth={geo.depth} data-floor-scale={s.toFixed(4)}
      data-coverage={camera === "slant" ? slant.coverage.toFixed(4) : undefined} data-tilt={camera === "slant" ? slant.beta : undefined}
      style={{ position: "absolute", inset: 0, perspective: camera === "slant" ? slant.P : geo.perspective, perspectiveOrigin: camera === "slant" ? `50% ${slant.oy}px` : "50% 50%", overflow: "hidden",
        "--tt-w": `${size.w}px`, "--tt-h": `${size.h}px`, "--tt-lip": camera === "slant" ? `${Math.round(size.h - slant.quads.south[0][1])}px` : "0px" } as React.CSSProperties}
      onPointerDown={() => setMenu(null)} onPointerMove={hoverTrack}
      onPointerLeave={() => { if (!drag && lifted && !root.current?.querySelector(`[data-testid=tt-wall-${lifted}]`)?.contains(document.activeElement)) leaveWall(lifted); }}>
      <div className="fs-tt-scene">
        {/* floor */}
        <div className="fs-tt-face fs-tt-floor" data-testid="tt-floor" data-face="floor" style={T("floor")}
          onDoubleClick={(e) => { if (main !== "floor" && !(e.target as HTMLElement).closest("button")) openFace("floor"); }}
          onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button")) { setFanned(null); setZoom(null); } }}>
          <div ref={floorInner} className="fs-tt-floor-inner" data-testid="tt-floor-inner" inert={main !== "floor"}
            data-scrolls={floorScrolls || undefined}
            style={{ width: floorW, height: floorH, transform: camera === "slant" ? "none" : `scale(${1 / s})`, ...(floorScrolls ? { overflowX: "hidden", overflowY: "auto", transformStyle: "flat" as const } : {}) }}>
            {files.length === 0 ? <p className="fs-tt-empty fs-dim" style={{ position: "absolute", left: 24, top: 24 }}>Files you save in /Documents appear here as cards.</p> : null}
            {boardItems("floor")}
          </div>
        </div>
        {WALLS.map((w) => (
          <div key={w} {...wallProps(w)} style={T(w)} role="region" aria-label={`${WALL_INFO[w].title} wall`}
            aria-hidden={(main !== "floor" && main !== w) || undefined} inert={main !== "floor" && main !== w}>
            {main === "floor" ? (
              <button type="button" className="fs-tt-wall-open" data-testid={`tt-open-${w}`} aria-label={`Open the ${WALL_INFO[w].title} wall`}
                onClick={(e) => { if (e.detail === 0) openFace(w); }} onDoubleClick={() => openFace(w)} />
            ) : null}
            {wallContent(w)}
          </div>
        ))}
      </div>

      {/* TT29 wall tags: flat, legible labels at each foreshortened wall's on-screen centroid — click target and drop
          target. Pointer-only visuals (aria-hidden): keyboard and screen readers use the "Open the … wall" buttons. */}
      {lod && main === "floor" ? WALLS.filter((w) => lod[w].lod === "glyph" && lifted !== w).map((w) => {
        const t = lod[w], n = surfacePaths(table, w, paths).length;
        const label = [WALL_INFO[w].title, w === "north" && wins.length ? `${wins.length} open` : "", n ? `${n} pinned` : ""].filter(Boolean).join(" · ");
        const half = t.vertical ? 15 : 0;
        let x = t.vertical ? Math.min(size.w - 2 - half, Math.max(2 + half, t.x)) : t.x; // flush to the frame edge when the sliver is thinner than the spine
        // a horizontal tag in the switcher's band moves to the middle of the wider free stretch beside it
        if (!t.vertical && navBox && t.y + 16 > navBox.t - 6 && t.y - 16 < navBox.b + 6 && t.x > navBox.l - 140 && t.x < navBox.r + 140)
          x = navBox.l >= size.w - navBox.r ? navBox.l / 2 : (navBox.r + size.w) / 2;
        return (
          <div key={w} className="fs-tt-walltag" data-testid={`tt-tag-${w}`} data-wall-tag={w} data-vertical={t.vertical || undefined} data-drop={drag?.over === w || undefined}
            aria-hidden="true" title={`Open the ${WALL_INFO[w].title} wall`} style={{ left: x, top: t.y }}
            onClick={() => { if (!drag) openFace(w); }}
            onPointerMove={(e) => intent(w, e)} onPointerLeave={() => { if (!drag && lift !== w) clearLiftTimer(); }}>
            {label}
          </div>
        );
      }) : null}

      {/* TT31: a card carried to ANOTHER surface travels as a flat ghost under the pointer, at the target's scale */}
      {drag?.moved && drag.target && drag.target.face !== drag.surface ? (() => {
        const path = drag.fan ? drag.fan.path : drag.key.startsWith("card:") ? drag.key.slice(5) : (boardOf(table, drag.surface).piles.find((p) => `pile:${p.id}` === drag.key)?.paths.at(-1) ?? "");
        const tf = drag.target.face, g = tf === "floor" ? 0.8 : wv[tf as Wall].lifted ? wv[tf as Wall].frame.k : 0.5;
        const fl = byPath.get(path);
        return (
          <div className="fs-tt-ghost" data-testid="tt-ghost" data-target={tf} aria-hidden="true"
            style={{ left: drag.px - (CARD_W * g) / 2, top: drag.py - (CARD_H * g) / 2, width: CARD_W, height: CARD_H, transform: `scale(${g})` }}>
            {fl ? <MicroPeek peek={peekOf(path)} name={fl.name} /> : null}
          </div>
        );
      })() : null}

      {/* enlarged micro peek (hover / focus) — flat overlay, never intercepts the pointer */}
      {zoom && zoomFile && !drag ? (
        <div className="fs-tt-zoom" data-testid="tt-zoom" aria-hidden="true"
          style={{ left: Math.max(8, Math.min(size.w - 268, zoom.x - 130)), top: zoom.y - ZOOM_H - 12 >= 8 ? zoom.y - ZOOM_H - 12 : Math.min(size.h - ZOOM_H - 8, zoom.y + CARD_H + 8) }}>
          <MicroPeek peek={peekOf(zoom.path)} name={zoomFile.name} large />
          <span className="fs-tt-card-name"><span>{zoomFile.name}</span></span>
        </div>
      ) : null}

      {menu ? (
        <div className="fs-panel" role="menu" aria-label="Card actions" data-testid="tt-menu" style={{ position: "absolute", left: Math.min(menu.x, size.w - 250), top: Math.min(menu.y, size.h - 330), padding: 4, zIndex: 50, minWidth: 230 }}
          onPointerDown={(e) => e.stopPropagation()}>
          {menuItems(menu.key, menu.surface).map((m, i) => (
            <button key={m.label} role="menuitem" type="button" className="fs-btn" data-variant="ghost" autoFocus={i === 0} style={{ width: "100%", justifyContent: "flex-start" }}
              onClick={() => { setMenu(null); m.run(); }}>{m.label}</button>
          ))}
        </div>
      ) : null}

      {viewsOpen ? (
        <div className="fs-panel fs-tt-views" role="dialog" aria-label="Tabletop views" data-testid="tt-views-panel" onPointerDown={(e) => e.stopPropagation()}>
          <strong className="fs-tt-views-title">Saved views</strong>
          {views.length === 0 ? <p className="fs-dim fs-tt-empty">No saved views yet. A view keeps where every card and pile is, the camera and the wall you are looking at.</p> : null}
          <ul className="fs-tt-views-list">
            {views.map((v) => (
              <li key={v.id} data-testid="tt-view">
                <button type="button" className="fs-btn" data-testid={`tt-view-load-${v.id}`} onClick={() => doLoad(v.id)} title={`Load “${v.name}”`}>
                  <span className="fs-tt-view-name">{v.name}</span>
                  <span className="fs-dim fs-tt-view-meta">{v.face === "floor" ? "Table" : WALL_INFO[v.face as Wall].title} · {v.camera === "slant" ? "Slanted" : "Top-down"}</span>
                </button>
                <button type="button" className="fs-btn" data-variant="ghost" aria-label={`Rename “${v.name}”`} onClick={async () => { const n = await askText("View name", v.name, { okLabel: "Rename" }); if (n) commit(renameView(table, v.id, n)); }}>Rename</button>
                <button type="button" className="fs-btn" data-variant="ghost" aria-label={`Delete “${v.name}”`} data-testid={`tt-view-delete-${v.id}`} onClick={() => commit(deleteView(table, v.id))}>Delete</button>
              </li>
            ))}
          </ul>
          <form className="fs-tt-views-save" onSubmit={(e) => { e.preventDefault(); doSave(); }}>
            <label htmlFor="tt-view-name" className="fs-visually-hidden">View name</label>
            <input id="tt-view-name" className="fs-input" data-testid="tt-view-name" placeholder="Name this view" value={viewName} maxLength={60} onChange={(e) => { setViewName(e.target.value); setViewMsg(""); }} autoFocus />
            <button type="submit" className="fs-btn" data-variant="primary" data-testid="tt-view-save">Save view</button>
          </form>
          <p className="fs-dim fs-tt-views-msg" role="status" data-testid="tt-view-msg">{viewMsg}</p>
        </div>
      ) : null}

      <span id="tt-card-hint" hidden>Double-click or Enter opens the file. Drag it onto another card or a pile, or press Shift+F10, to make a pile or pin it to a wall. Alt+Arrow keys move it.</span>
      <span id="tt-pile-hint" hidden>Pile. Click or Enter fans it out, Esc gathers it. Drag it onto a card or pile to merge; Shift+F10 for Unstack, Rename and Pin to a wall.</span>
      {/* switcher: single-click / keyboard route to every face (double-click is never the only way) */}
      <nav ref={navRef} className="fs-tt-nav" aria-label="Tabletop views" data-testid="tt-nav">
        {(["floor", "north", "west", "east", "south"] as Face[]).map((f) => (
          <button key={f} type="button" aria-pressed={main === f} data-testid={`tt-nav-${f}`} onClick={() => openFace(f)}>
            {f === "floor" ? "Table" : WALL_INFO[f as Wall].title}
          </button>
        ))}
        <span className="fs-tt-nav-sep" aria-hidden="true" />
        <button type="button" data-testid="tt-camera" aria-pressed={camera === "slant"} title="Camera: slanted (looking down at a desk) or straight down into the box"
          onClick={() => setCamera(camera === "slant" ? "top" : "slant")}>{camera === "slant" ? "Slanted" : "Top-down"}</button>
        <button type="button" data-testid="tt-views" aria-expanded={viewsOpen} aria-haspopup="dialog" onClick={() => { setViewsOpen((o) => !o); setViewMsg(""); }}>Views{views.length ? ` · ${views.length}` : ""}</button>
        <button type="button" data-testid="tt-classic" title="Back to the classic desktop" onClick={() => void shell.setSetting("appearance.desktopView", "classic")}>Classic</button>
      </nav>
      {main !== "floor" ? (
        <button ref={backBtn} type="button" className="fs-btn fs-tt-back" data-testid="tt-back" onClick={() => openFace("floor")}>
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
