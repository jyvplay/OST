"use client";
import { AppBanner, BannerGroup } from "@/components/AppBanner";
import { wheelPx } from "@/lib/input";
import { fz } from "@/lib/uiscale";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import * as W from "@/lib/whiteboard-core";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import { rasterSize } from "@/lib/raster-size";
import { zoomLabel } from "@/lib/zoom-step";

/**
 * Whiteboard (TT23): an Excalidraw/Miro-style infinite canvas on top of the pure engine in src/lib/whiteboard-core.ts.
 *
 *   • Saved as a native `.fboard` JSON document in the VFS. SVG export writes a standalone .svg next to it.
 *   • Each edit produces a new Board snapshot, so undo/redo is exact (100 steps).
 *   • During a drag the module renders a draft board and commits it once, on pointer-up.
 *   • The board surface is always light, like a page in Writer: it is document content, so it keeps its own colours
 *     in every style/theme. The surrounding chrome follows the theme.
 *   • Keyboard: tool letters V R O D S T L A P H, arrows nudge (Shift ×10), Enter edits text, Delete, Ctrl+Z/Y/D/A/G.
 *     The Layers list is a full keyboard and screen-reader route to every element.
 */
type Tool = "select" | "hand" | W.Kind;
const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "select", label: "Select", key: "V" }, { id: "hand", label: "Pan", key: "H" },
  { id: "rect", label: "Rectangle", key: "R" }, { id: "ellipse", label: "Ellipse", key: "O" },
  { id: "diamond", label: "Diamond", key: "D" }, { id: "sticky", label: "Sticky note", key: "S" },
  { id: "text", label: "Text", key: "T" }, { id: "line", label: "Line", key: "L" },
  { id: "arrow", label: "Arrow", key: "A" }, { id: "pen", label: "Pen", key: "P" },
];
const DEFAULT_SIZE: Partial<Record<W.Kind, [number, number]>> = { rect: [140, 80], ellipse: [140, 80], diamond: [140, 90], sticky: [170, 130], text: [180, 40] };
const SEL = "#1565c0";
type Drag =
  | { t: "move"; start: W.Pt; ids: string[]; base: W.Board; moved: boolean }
  | { t: "marquee"; start: W.Pt; add: string[] }
  | { t: "create"; kind: W.Kind; start: W.Pt; base: W.Board }
  | { t: "conn"; kind: W.Kind; start: W.Pt; bind: string | null; base: W.Board }
  | { t: "pen"; pts: [number, number][]; base: W.Board }
  | { t: "resize"; id: string; anchor: W.Pt; base: W.Board }
  | { t: "end"; id: string; which: "a" | "z"; base: W.Board }
  | { t: "pan"; cx: number; cy: number; cam: Cam };
interface Cam { x: number; y: number; z: number }
const fileName = (s: string) => s.replace(/[^a-z0-9-_ ]/gi, "").trim() || "board";

/** A small starter board so a new window is not an empty void (and shows a bound connector). */
function starter(): W.Board {
  let b = W.emptyBoard(); let a: string, c: string;
  [b, a] = W.addEl(b, { kind: "sticky", x: 60, y: 60, w: 170, h: 130, text: "Ideas go here\nDouble-click to edit" });
  [b, c] = W.addEl(b, { kind: "ellipse", x: 360, y: 90, w: 160, h: 80, text: "Next step" });
  [b] = W.addEl(b, { kind: "arrow", x: 145, y: 125, w: 295, h: 5, start: a, end: c });
  return b;
}

export default function WhiteboardModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [hist, setHist] = useState<{ past: W.Board[]; now: W.Board; future: W.Board[] }>(() => ({ past: [], now: path ? W.emptyBoard() : starter(), future: [] }));
  const [draft, setDraft] = useState<W.Board | null>(null);
  const board = draft ?? hist.now;
  const [loaded, setLoaded] = useState(!path);
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState(() => (path ? path.split("/").pop()!.replace(/\.fboard$/i, "") : "Untitled board"));
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<string[]>([]);
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, z: 1 });
  const [grid, setGrid] = useState(true);
  const [marq, setMarq] = useState<W.Box | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [status, setStatus] = useState("");
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  /** Escape must cancel: moving focus back to the canvas blurs the editor, and blur would otherwise commit. */
  const cancelEdit = useRef(false);

  useEffect(() => {
    if (!path) return;
    let live = true;
    (async () => {
      try {
        const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
        const { board: b, repaired } = W.parseBoard(r.node.content);
        if (live) { setHist({ past: [], now: b, future: [] }); if (repaired) setStatus(`opened ${path} — repaired ${repaired} invalid value(s)`); }
      } catch (e) { if (live) setStatus(`Could not open ${path}: ${(e as Error).message} — showing an empty board`); }
      if (live) setLoaded(true);
    })();
    return () => { live = false; };
  }, [path]);
  const editingId = editing?.id ?? null;
  useEffect(() => { if (editingId) editRef.current?.focus(); }, [editingId]);

  const commit = (next: W.Board, base: W.Board = hist.now) => {
    if (next === base) return;
    setHist((h) => ({ past: [...h.past.slice(-99), base], now: next, future: [] })); setDirty(true);
  };
  const attempt = (fn: () => W.Board) => { try { commit(fn()); } catch (e) { shell.toast((e as Error).message, "bad"); } };
  const undo = () => { setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), now: h.past.at(-1)!, future: [h.now, ...h.future] } : h)); setSel([]); };
  const redo = () => { setHist((h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h)); setSel([]); };
  const live = sel.filter((id) => board.els.some((e) => e.id === id));
  const selEls = board.els.filter((e) => live.includes(e.id));
  const single = selEls.length === 1 ? selEls[0] : null;
  const snapP = (p: W.Pt): W.Pt => (grid ? { x: W.snap(p.x, 10), y: W.snap(p.y, 10) } : p);

  const toWorld = (cx: number, cy: number): W.Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - cam.x) / cam.z, y: (cy - r.top - cam.y) / cam.z };
  };

  /* ------------------------------------------------------------------ pointer */
  const onDown = (ev: React.PointerEvent<SVGSVGElement>) => {
    // (an open text editor commits through its own blur when the canvas takes focus below)
    if (ev.button !== 0 && ev.button !== 1) return;
    svgRef.current?.setPointerCapture(ev.pointerId);
    svgRef.current?.focus();
    const p = toWorld(ev.clientX, ev.clientY);
    const handle = (ev.target as Element).getAttribute("data-handle");
    if (ev.button === 1 || tool === "hand") { drag.current = { t: "pan", cx: ev.clientX, cy: ev.clientY, cam }; return; }
    if (handle && single) {
      if (handle === "a" || handle === "z") { drag.current = { t: "end", id: single.id, which: handle, base: hist.now }; return; }
      const r = W.bounds(board, single);
      const anchor = { x: handle.includes("w") ? r.x + r.w : r.x, y: handle.includes("n") ? r.y + r.h : r.y };
      drag.current = { t: "resize", id: single.id, anchor, base: hist.now }; return;
    }
    if (tool === "select") {
      const hit = W.hitTest(board, p, 6 / cam.z);
      if (hit) {
        const grp = W.expandGroups(board, [hit]);
        const next = ev.shiftKey ? (live.includes(hit) ? live.filter((x) => !grp.includes(x)) : [...live, ...grp]) : live.includes(hit) ? live : grp;
        setSel(next);
        drag.current = { t: "move", start: p, ids: next, base: hist.now, moved: false };
      } else {
        if (!ev.shiftKey) setSel([]);
        drag.current = { t: "marquee", start: p, add: ev.shiftKey ? live : [] };
      }
      return;
    }
    const s = snapP(p);
    if (tool === "line" || tool === "arrow") { drag.current = { t: "conn", kind: tool, start: p, bind: W.bindTarget(board, p), base: hist.now }; return; }
    if (tool === "pen") { drag.current = { t: "pen", pts: [[p.x, p.y]], base: hist.now }; return; }
    drag.current = { t: "create", kind: tool, start: s, base: hist.now };
  };

  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current; if (!d) return;
    const p = toWorld(ev.clientX, ev.clientY);
    if (d.t === "pan") { setCam({ ...d.cam, x: d.cam.x + ev.clientX - d.cx, y: d.cam.y + ev.clientY - d.cy }); return; }
    if (d.t === "move") {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (grid) { dx = W.snap(dx, 10); dy = W.snap(dy, 10); }
      if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = true;
      setDraft(W.move(d.base, d.ids, dx, dy)); return;
    }
    if (d.t === "marquee") { setMarq({ x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y }); return; }
    if (d.t === "create") { const s = snapP(p); setDraft(W.addEl(d.base, { kind: d.kind, x: d.start.x, y: d.start.y, w: s.x - d.start.x, h: s.y - d.start.y })[0]); return; }
    if (d.t === "conn") { setDraft(W.addEl(d.base, { kind: d.kind, x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y, start: d.bind })[0]); return; }
    if (d.t === "pen") { d.pts.push([p.x, p.y]); setDraft(W.addEl(d.base, { kind: "pen", x: 0, y: 0, pts: d.pts.slice() })[0]); return; }
    if (d.t === "resize") { const s = snapP(p); setDraft(W.resize(d.base, d.id, { x: d.anchor.x, y: d.anchor.y, w: s.x - d.anchor.x, h: s.y - d.anchor.y })); return; }
    if (d.t === "end") {
      const e = d.base.els.find((x) => x.id === d.id)!;
      const { a, z } = W.resolveConnector(d.base, e);
      const A = d.which === "a" ? p : a, Z = d.which === "z" ? p : z;
      setDraft(W.patch(d.base, [d.id], () => ({ x: A.x, y: A.y, w: Z.x - A.x, h: Z.y - A.y, ...(d.which === "a" ? { start: null } : { end: null }) })));
    }
  };

  const onUp = (ev: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    const p = toWorld(ev.clientX, ev.clientY);
    try {
      if (d.t === "move") { if (d.moved && draft) commit(draft, d.base); }
      else if (d.t === "marquee") {
        const box = marq; setMarq(null);
        if (box && Math.abs(box.w) + Math.abs(box.h) > 4) setSel(W.expandGroups(board, [...new Set([...d.add, ...W.marquee(board, box)])]));
      } else if (d.t === "create") {
        const s = snapP(p);
        let w = s.x - d.start.x, h = s.y - d.start.y;
        if (Math.abs(w) < 6 && Math.abs(h) < 6) [w, h] = DEFAULT_SIZE[d.kind] ?? [120, 80];
        const [nb, id] = W.addEl(d.base, { kind: d.kind, x: d.start.x, y: d.start.y, w, h });
        commit(nb, d.base); setSel([id]); setTool("select");
        if (d.kind === "sticky" || d.kind === "text") setEditing({ id, text: "" });
      } else if (d.t === "conn") {
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < 6) { setDraft(null); return; }
        const end = W.bindTarget(d.base, p, undefined);
        const [nb, id] = W.addEl(d.base, { kind: d.kind, x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y, start: d.bind, end: end && end !== d.bind ? end : null });
        commit(nb, d.base); setSel([id]); setTool("select");
      } else if (d.t === "pen") {
        if (d.pts.length > 1) {
          const pts = W.simplify(d.pts, 1.2 / cam.z);
          const [nb, id] = W.addEl(d.base, { kind: "pen", x: 0, y: 0, pts });
          commit(nb, d.base); setSel([id]);
        }
      } else if (d.t === "resize") { if (draft) commit(draft, d.base); }
      else if (d.t === "end") {
        if (draft) {
          const target = W.bindTarget(draft, p, undefined);
          commit(target ? W.patch(draft, [d.id], () => (d.which === "a" ? { start: target } : { end: target })) : draft, d.base);
        }
      }
    } catch (e) { shell.toast((e as Error).message, "bad"); }
    setDraft(null);
  };

  const onWheel = (ev: React.WheelEvent<SVGSVGElement>) => {
    if (ev.ctrlKey || ev.metaKey) {
      const r = svgRef.current!.getBoundingClientRect();
      zoomAt(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX - r.left, ev.clientY - r.top);
    } else { const d = wheelPx(ev, svgRef.current?.clientHeight ?? 800); setCam((c) => ({ ...c, x: c.x - d.dx, y: c.y - d.dy })); } // TT66 IN-01: line / page wheels pan as far as pixel wheels
  };
  const zoomAt = (f: number, sx: number, sy: number) => setCam((c) => {
    const z = Math.min(4, Math.max(0.2, c.z * f));
    return { z, x: sx - ((sx - c.x) / c.z) * z, y: sy - ((sy - c.y) / c.z) * z };
  });
  const zoomCenter = (f: number) => { const r = svgRef.current?.getBoundingClientRect(); zoomAt(f, (r?.width ?? 800) / 2, (r?.height ?? 500) / 2); };
  const fit = () => {
    const box = W.unionBox(board.els.map((e) => W.bounds(board, e)));
    const r = svgRef.current?.getBoundingClientRect();
    if (!box || !r) { setCam({ x: 0, y: 0, z: 1 }); return; }
    const z = Math.min(2, Math.max(0.2, Math.min((r.width - 60) / Math.max(box.w, 1), (r.height - 60) / Math.max(box.h, 1))));
    setCam({ z, x: r.width / 2 - (box.x + box.w / 2) * z, y: r.height / 2 - (box.y + box.h / 2) * z });
  };

  /* ------------------------------------------------------------------ text editing */
  const startEdit = (id: string) => { const e = board.els.find((x) => x.id === id); if (e && e.kind !== "pen") setEditing({ id, text: e.text }); };
  const commitText = () => {
    if (!editing) return;
    const e = hist.now.els.find((x) => x.id === editing.id);
    if (e && e.text !== editing.text) {
      // an empty text element is removed rather than left as an invisible box
      commit(e.kind === "text" && !editing.text.trim() ? W.remove(hist.now, [e.id]) : W.patch(hist.now, [e.id], () => ({ text: editing.text })));
    }
    setEditing(null);
  };
  const onDbl = (ev: React.MouseEvent<SVGSVGElement>) => {
    const p = toWorld(ev.clientX, ev.clientY);
    const hit = W.hitTest(board, p, 6 / cam.z);
    if (hit) { setSel([hit]); startEdit(hit); return; }
    const s = snapP(p);
    const [nb, id] = W.addEl(hist.now, { kind: "text", x: s.x - 90, y: s.y - 20, w: 180, h: 40 });
    commit(nb); setSel([id]); setEditing({ id, text: "" });
  };

  /* ------------------------------------------------------------------ keyboard */
  const del = () => { if (live.length) { commit(W.remove(hist.now, live)); setSel([]); } };
  const dup = () => { if (!live.length) return; try { const [nb, ids] = W.duplicate(hist.now, live); commit(nb); setSel(ids); } catch (e) { shell.toast((e as Error).message, "bad"); } };
  const onKey = (ev: React.KeyboardEvent<SVGSVGElement>) => {
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if (mod && k === "z") { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
    if (mod && k === "y") { ev.preventDefault(); redo(); return; }
    if (mod && k === "d") { ev.preventDefault(); dup(); return; }
    if (mod && k === "a") { ev.preventDefault(); setSel(board.els.map((e) => e.id)); return; }
    if (mod && k === "g") { ev.preventDefault(); commit(ev.shiftKey ? W.ungroup(hist.now, live) : W.group(hist.now, live)); return; }
    if (k === "delete" || k === "backspace") { ev.preventDefault(); del(); return; }
    if (k === "escape") { setSel([]); setTool("select"); return; }
    if (k === "enter" && single) { ev.preventDefault(); startEdit(single.id); return; }
    const nudge: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (nudge[k] && live.length) { ev.preventDefault(); const m = ev.shiftKey ? 10 : 1; commit(W.move(hist.now, live, nudge[k][0] * m, nudge[k][1] * m)); return; }
    if (k === "]") { commit(W.reorder(hist.now, live, mod ? "front" : "forward")); return; }
    if (k === "[") { commit(W.reorder(hist.now, live, mod ? "back" : "backward")); return; }
    if (k === "+" || k === "=") { zoomCenter(1.2); return; }
    if (k === "-") { zoomCenter(1 / 1.2); return; }
    if (k === "0") { setCam({ x: 0, y: 0, z: 1 }); return; }
    if (!mod && !ev.altKey) { const t = TOOLS.find((x) => x.key.toLowerCase() === k); if (t) setTool(t.id); }
  };

  /* ------------------------------------------------------------------ files */
  const save = async () => {
    const dest = path && path.endsWith(".fboard") ? path : `/Documents/${fileName(name)}.fboard`;
    await post("/api/fs", { op: "write", path: dest, content: W.serialize(hist.now), reason: "whiteboard-save" });
    setDirty(false); setStatus(`saved ${dest}`); shell.bumpRefresh();
    if (!path) shell.dispatch({ t: "setProps", id: win.id, props: { path: dest, title: `${fileName(name)}.fboard` } });
  };
  const exportSvg = async () => {
    const dest = (path && path.endsWith(".fboard") ? path.replace(/\.fboard$/i, "") : `/Documents/${fileName(name)}`) + ".svg";
    await post("/api/fs", { op: "write", path: dest, content: W.toSvg(hist.now), reason: "whiteboard-export" });
    setStatus(`exported ${dest}`); shell.bumpRefresh();
  };
  const exportPng = async () => {
    const dest = (path && path.endsWith(".fboard") ? path.replace(/\.fboard$/i, "") : `/Documents/${fileName(name)}`) + ".png";
    try {
      const svg = W.toSvg(hist.now);
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const img = new Image(); img.src = url; await img.decode();
      const size = rasterSize(img.naturalWidth || 1600, img.naturalHeight || 1000, 2);
      const c = document.createElement("canvas"); c.width = size.w; c.height = size.h;
      c.getContext("2d")!.drawImage(img, 0, 0, size.w, size.h); URL.revokeObjectURL(url);
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("PNG encode failed"))), "image/png"));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      await post("/api/fs", { op: "write", path: dest, content: btoa(bin), encoding: "base64", mime: "image/png", reason: "whiteboard-export-png" });
      setStatus(`exported ${dest} (${size.w}×${size.h}${size.capped ? ", scaled to the pixel cap" : ""})`); shell.bumpRefresh();
    } catch (e) { setStatus(`PNG export failed: ${String((e as Error).message)}`); }
  };

  const layers = useMemo(() => board.els.slice().reverse(), [board]);
  if (!loaded) return <div style={{ padding: 16 }}>Opening board…</div>;

  /* ------------------------------------------------------------------ render helpers */
  const textEl = (e: W.El, cx: number, cy: number, size = 16) => {
    if (!e.text || editing?.id === e.id) return null;
    const lines = e.text.split("\n");
    return (
      <text x={cx} y={cy - ((lines.length - 1) * size * 1.25) / 2} fontSize={size} fill={W.TEXT_INK} textAnchor="middle" dominantBaseline="middle" style={{ pointerEvents: "none", userSelect: "none" }} fontFamily="inherit">
        {lines.map((l, i) => <tspan key={i} x={cx} dy={i ? size * 1.25 : 0}>{l}</tspan>)}
      </text>
    );
  };
  const renderEl = (e: W.El) => {
    const c = W.center(e);
    const common = { stroke: e.stroke, strokeWidth: e.sw, fill: e.fill };
    const tag = { "data-el": e.id, "data-kind": e.kind } as Record<string, string>;
    switch (e.kind) {
      case "rect": return <g key={e.id} {...tag}><rect x={e.x} y={e.y} width={e.w} height={e.h} rx={6} {...common} />{textEl(e, c.x, c.y)}</g>;
      case "sticky": return <g key={e.id} {...tag}><rect x={e.x + 2} y={e.y + 3} width={e.w} height={e.h} rx={4} fill="#00000014" /><rect x={e.x} y={e.y} width={e.w} height={e.h} rx={4} fill={e.fill} stroke="#00000022" />{textEl(e, c.x, c.y)}</g>;
      case "ellipse": return <g key={e.id} {...tag}><ellipse cx={c.x} cy={c.y} rx={e.w / 2} ry={e.h / 2} {...common} />{textEl(e, c.x, c.y)}</g>;
      case "diamond": return <g key={e.id} {...tag}><path d={`M${c.x} ${e.y}L${e.x + e.w} ${c.y}L${c.x} ${e.y + e.h}L${e.x} ${c.y}Z`} {...common} />{textEl(e, c.x, c.y)}</g>;
      case "text": return <g key={e.id} {...tag}><rect x={e.x} y={e.y} width={e.w} height={e.h} fill="transparent" />{textEl(e, c.x, c.y, 18)}</g>;
      case "pen": return <path key={e.id} {...tag} d={(e.pts ?? []).map((p, i) => `${i ? "L" : "M"}${p[0] + e.x} ${p[1] + e.y}`).join("")} fill="none" stroke={e.stroke} strokeWidth={e.sw} strokeLinecap="round" strokeLinejoin="round" />;
      default: {
        const { a, z } = W.resolveConnector(board, e);
        return (
          <g key={e.id} {...tag} data-start={e.start ?? ""} data-end={e.end ?? ""}>
            <path d={`M${a.x} ${a.y}L${z.x} ${z.y}`} stroke={e.stroke} strokeWidth={e.sw} fill="none" strokeLinecap="round" data-line="1" />
            {e.kind === "arrow" ? <path d={W.arrowHead(a, z, 12 + e.sw * 2)} fill={e.stroke} /> : null}
            {textEl(e, (a.x + z.x) / 2, (a.y + z.y) / 2 - 12, 14)}
          </g>
        );
      }
    }
  };
  const selBox = W.unionBox(selEls.map((e) => W.bounds(board, e)));
  const hs = 9 / cam.z;
  const editEl = editing ? board.els.find((e) => e.id === editing.id) : null;
  const editBox = editEl ? W.bounds(board, editEl) : null;
  const swatch = (color: string, label: string, onPick: () => void, on: boolean) => (
    <button key={label} type="button" className="fs-btn" data-variant="ghost" aria-label={label} aria-pressed={on} title={label} onClick={onPick}
      style={{ width: fz(26), height: fz(26), minWidth: 0, padding: 0, borderRadius: 6, background: color === "transparent" ? "repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 10px 10px" : color, outline: on ? "3px solid var(--fs-accent)" : "1px solid var(--fs-border)" }} />
  );
  const shapeSel = selEls.filter((e) => W.isShape(e) || W.isConnector(e) || e.kind === "pen");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="whiteboard">
      {/* TT80 banner: Keep · Tweak · Kit · Glance over one tool strip */}
      <AppBanner label="Whiteboard" span="1 / 3" status={<>
          {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
          <span className="fs-dim" role="status" style={{ fontSize: fz(11) }} data-testid="wb-status">{status}</span>
      </>}>
        <BannerGroup name="Keep">
          <input className="fs-input" aria-label="Board name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: `0 1 ${fz(180)}`, minWidth: fz(110) }} />
          <Btn variant="primary" onClick={() => void save()}>Save .fboard</Btn>
          <Btn variant="ghost" onClick={() => void exportSvg()}>Export SVG</Btn>
          <Btn variant="ghost" onClick={() => void exportPng()} data-testid="wb-export-png">Export PNG</Btn>
          <Btn variant="ghost" disabled={!selEls.length} title={selEls.length ? "Export only the selected elements" : "Select elements first"} onClick={async () => { const dest = (path && path.endsWith(".fboard") ? path.replace(/\.fboard$/i, "") : `/Documents/${fileName(name)}`) + "-selection.png"; try { const svg = W.toSvg({ ...hist.now, els: selEls }); const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); const img = new Image(); img.src = url; await img.decode(); const size = rasterSize(img.naturalWidth || 320, img.naturalHeight || 240, 2); const c = document.createElement("canvas"); c.width = size.w; c.height = size.h; c.getContext("2d")!.drawImage(img, 0, 0, size.w, size.h); URL.revokeObjectURL(url); const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("PNG encode failed"))), "image/png")); const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ""; for (let i2 = 0; i2 < buf.length; i2 += 8192) bin += String.fromCharCode(...buf.subarray(i2, i2 + 8192)); await post("/api/fs", { op: "write", path: dest, content: btoa(bin), encoding: "base64", mime: "image/png", reason: "whiteboard-export-selection" }); setStatus(`exported ${dest} (${size.w}×${size.h}, selection only)`); shell.bumpRefresh(); } catch (e) { setStatus(`selection export failed: ${(e as Error).message}`); } }} data-testid="wb-export-selection">Export selection</Btn>
        </BannerGroup>
        <BannerGroup name="Tweak">
          <Btn variant="ghost" disabled={!hist.past.length} onClick={undo}>Undo</Btn>
          <Btn variant="ghost" disabled={!hist.future.length} onClick={redo}>Redo</Btn>
          <Btn variant="ghost" onClick={() => { commit(W.emptyBoard()); setSel([]); }}>Clear board</Btn>
        </BannerGroup>
        <BannerGroup name="Kit">
          {TOOLS.map((t) => (
          <button key={t.id} type="button" className="fs-btn" data-variant={tool === t.id ? "primary" : "ghost"} aria-pressed={tool === t.id}
          aria-keyshortcuts={t.key} title={`${t.label} (shortcut ${t.key})`} data-testid={`wb-tool-${t.id}`} onClick={() => setTool(t.id)}>{t.label}</button>
          ))}
        </BannerGroup>
        <BannerGroup name="Glance">
          <Btn variant="ghost" aria-label="Zoom out" onClick={() => zoomCenter(1 / 1.2)}>-</Btn>
          <span style={{ minWidth: fz(44), textAlign: "center", fontSize: fz(12) }} data-testid="wb-zoom">{Math.round(cam.z * 100)}%</span>
          <Btn variant="ghost" aria-label="Reset zoom to 100 percent" onClick={() => { const r = svgRef.current?.getBoundingClientRect(); setCam((c) => ({ ...c, z: 1 })); }} data-testid="wb-zoom-label">{zoomLabel(cam.z)}</Btn>
          <Btn variant="ghost" aria-label="Zoom in" onClick={() => zoomCenter(1.2)}>+</Btn>
          <Btn variant="ghost" onClick={fit}>Fit</Btn>
          <Btn variant="ghost" aria-pressed={grid} onClick={() => setGrid((g) => !g)}>{grid ? "Snap: on" : "Snap: off"}</Btn>
        </BannerGroup>
      </AppBanner>
      <div style={{ display: "grid", gridTemplateColumns: `minmax(0, 1fr) ${fz(230)}`, flex: 1, minHeight: 0 }}>
        {/* canvas */}
        <div style={{ position: "relative", minWidth: 0, minHeight: 0, overflow: "hidden", background: "#fbfbf8" }}>
          <svg ref={svgRef} role="application" aria-roledescription="whiteboard canvas" tabIndex={0} data-testid="wb-canvas"
            aria-label={`Whiteboard canvas, ${board.els.length} element(s), ${live.length} selected. Tool: ${TOOLS.find((t) => t.id === tool)!.label}. Use the Layers list to reach elements by keyboard.`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDbl} onWheel={onWheel} onKeyDown={onKey}
            style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: tool === "hand" ? "grab" : tool === "select" ? "default" : "crosshair", outline: "none" }}>
            <defs>
              <pattern id={`wbdots-${win.id}`} width={20 * cam.z} height={20 * cam.z} patternUnits="userSpaceOnUse" x={cam.x} y={cam.y}>
                <circle cx={1} cy={1} r={1} fill="#c9c9c2" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={grid ? `url(#wbdots-${win.id})` : "#fbfbf8"} />
            <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.z})`}>
              {board.els.map(renderEl)}
              {selBox ? <rect x={selBox.x - 4 / cam.z} y={selBox.y - 4 / cam.z} width={selBox.w + 8 / cam.z} height={selBox.h + 8 / cam.z} fill="none" stroke={SEL} strokeWidth={1.5 / cam.z} strokeDasharray={`${5 / cam.z} ${4 / cam.z}`} style={{ pointerEvents: "none" }} data-testid="wb-selection" /> : null}
              {single && W.isConnector(single) ? (() => {
                const { a, z } = W.resolveConnector(board, single);
                return [["a", a], ["z", z]].map(([k, p]) => <circle key={k as string} data-handle={k as string} cx={(p as W.Pt).x} cy={(p as W.Pt).y} r={hs / 1.6} fill="#fff" stroke={SEL} strokeWidth={2 / cam.z} style={{ cursor: "move" }} />);
              })() : null}
              {single && !W.isConnector(single) && selBox ? (["nw", "ne", "sw", "se"] as const).map((h) => (
                <rect key={h} data-handle={h} x={(h.includes("w") ? selBox.x : selBox.x + selBox.w) - hs / 2} y={(h.includes("n") ? selBox.y : selBox.y + selBox.h) - hs / 2} width={hs} height={hs} fill="#fff" stroke={SEL} strokeWidth={2 / cam.z} style={{ cursor: `${h}-resize` }} />
              )) : null}
              {marq ? <rect x={Math.min(marq.x, marq.x + marq.w)} y={Math.min(marq.y, marq.y + marq.h)} width={Math.abs(marq.w)} height={Math.abs(marq.h)} fill="#1565c014" stroke={SEL} strokeWidth={1 / cam.z} data-testid="wb-marquee" /> : null}
            </g>
          </svg>
          {editing && editBox ? (
            <textarea ref={editRef} aria-label="Element text" data-testid="wb-text-editor" value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              onBlur={() => { if (cancelEdit.current) { cancelEdit.current = false; return; } commitText(); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); cancelEdit.current = true; setEditing(null); svgRef.current?.focus(); }
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); svgRef.current?.focus(); /* blur commits once */ }
              }}
              style={{ position: "absolute", left: editBox.x * cam.z + cam.x, top: editBox.y * cam.z + cam.y, width: Math.max(editBox.w, 120) * cam.z, height: Math.max(editBox.h, 40) * cam.z,
                fontSize: `${16 * cam.z}px`, textAlign: "center", color: W.TEXT_INK, background: "#ffffffee", border: `2px solid ${SEL}`, borderRadius: 4, resize: "none", padding: 4, fontFamily: "inherit" }} />
          ) : null}
          <div className="fs-dim" style={{ position: "absolute", left: 8, bottom: 6, fontSize: fz(11), color: "#3d3d3a", background: "#fbfbf8cc", padding: "0 6px", borderRadius: 6, pointerEvents: "none" }} data-testid="wb-count">
            {board.els.length} element(s) · {live.length} selected · drag to draw, double-click to write
          </div>
        </div>
        {/* side panel */}
        {/* minmax(0,1fr): without it the nowrap layer names widened the implicit column past the padding (TT23 visual check) */}
        <div style={{ borderLeft: "1px solid var(--fs-border)", overflowY: "auto", overflowX: "hidden", padding: 8, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10, alignContent: "start", minWidth: 0 }}>
          {shapeSel.length ? (
            <section aria-label="Style" style={{ display: "grid", gap: 6 }}>
              <strong style={{ fontSize: fz(12) }}>Stroke</strong>
              <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
                {W.STROKE_COLORS.map((c, i) => swatch(c, `Stroke colour ${i + 1}`, () => commit(W.patch(hist.now, live, () => ({ stroke: c }))), shapeSel.every((e) => e.stroke === c)))}
              </div>
              <strong style={{ fontSize: fz(12) }}>Fill</strong>
              <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
                {swatch("transparent", "No fill", () => commit(W.patch(hist.now, live.filter((id) => board.els.find((e) => e.id === id)?.kind !== "sticky"), () => ({ fill: "transparent" }))), shapeSel.every((e) => e.fill === "transparent"))}
                {W.STICKY_COLORS.map((c, i) => swatch(c, `Fill colour ${i + 1}`, () => commit(W.patch(hist.now, live, () => ({ fill: c }))), shapeSel.every((e) => e.fill === c)))}
              </div>
              <label className="fs-row" style={{ gap: 6, fontSize: fz(12) }}>Width
                <select className="fs-select" style={{ width: fz(90) }} value={String(shapeSel[0].sw)} onChange={(e) => commit(W.patch(hist.now, live, () => ({ sw: Number(e.target.value) })))}>
                  {[0, 1, 2, 4, 6, 10].map((w) => <option key={w} value={w}>{w}px</option>)}
                </select>
              </label>
              {single && single.kind !== "pen" ? (
                <label style={{ display: "grid", gap: 3, fontSize: fz(12) }}>Text
                  <textarea className="fs-input" rows={3} value={single.text} data-testid="wb-text-field" onChange={(e) => commit(W.patch(hist.now, [single.id], () => ({ text: e.target.value })))} style={{ resize: "vertical" }} />
                </label>
              ) : null}
            </section>
          ) : <p className="fs-dim" style={{ fontSize: fz(12), margin: 0 }}>Select an element to style it. Shift-click or drag a box to select several.</p>}
          {live.length ? (
            <section aria-label="Arrange" style={{ display: "grid", gap: 4 }}>
              <strong style={{ fontSize: fz(12) }}>Arrange</strong>
              <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
                <Btn variant="ghost" onClick={() => commit(W.reorder(hist.now, live, "front"))}>To front</Btn>
                <Btn variant="ghost" onClick={() => commit(W.reorder(hist.now, live, "back"))}>To back</Btn>
                <Btn variant="ghost" onClick={dup}>Duplicate</Btn>
                <Btn variant="ghost" onClick={del}>Delete</Btn>
                {live.length > 1 ? <Btn variant="ghost" onClick={() => commit(W.group(hist.now, live))}>Group</Btn> : null}
                {selEls.some((e) => e.group) ? <Btn variant="ghost" onClick={() => commit(W.ungroup(hist.now, live))}>Ungroup</Btn> : null}
              </div>
              {live.length > 1 ? (
                <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }} role="group" aria-label="Align">
                  {([["left", "Left"], ["hcenter", "Centre"], ["right", "Right"], ["top", "Top"], ["vcenter", "Middle"], ["bottom", "Bottom"]] as const).map(([k, l]) => (
                    <Btn key={k} variant="ghost" aria-label={`Align ${l}`} onClick={() => attempt(() => W.align(hist.now, live, k))}>{l}</Btn>
                  ))}
                  {live.length > 2 ? <><Btn variant="ghost" onClick={() => attempt(() => W.distribute(hist.now, live, "h"))}>Space H</Btn><Btn variant="ghost" onClick={() => attempt(() => W.distribute(hist.now, live, "v"))}>Space V</Btn></> : null}
                </div>
              ) : null}
            </section>
          ) : null}
          <section aria-label="Layers" style={{ display: "grid", gap: 3 }}>
            <strong style={{ fontSize: fz(12) }}>Layers (top first)</strong>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2 }} data-testid="wb-layers">
              {layers.map((e) => (
                <li key={e.id} style={{ minWidth: 0 }}>
                  <button type="button" className="fs-btn" data-variant={live.includes(e.id) ? "primary" : "ghost"} aria-pressed={live.includes(e.id)}
                    onClick={(ev) => setSel(ev.shiftKey ? (live.includes(e.id) ? live.filter((x) => x !== e.id) : [...live, e.id]) : W.expandGroups(board, [e.id]))}
                    onDoubleClick={() => startEdit(e.id)}
                    style={{ width: "100%", boxSizing: "border-box", minWidth: 0, justifyContent: "flex-start", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: fz(12) }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{W.describe(board, e)}{e.group ? " (grouped)" : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
