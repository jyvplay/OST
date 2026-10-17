"use client";
import { fz } from "@/lib/uiscale";

/**
 * FF-32 / FF-25 / FF-04 Vector studio v2 (TT16). Engine: src/lib/vector (pure, oracle-tested).
 *
 * Tools: V select · A node · R rect · E ellipse · L line · S polygon/star · P pen · T text.
 * Selection: click / shift-click / marquee; move; 8 resize handles; rotate handle (shift snaps 15°).
 * Pen: click = corner, drag = smooth node, click the first node = close; Enter / Escape / double-click finishes.
 * Node tool: drag anchors (handles follow) or handles of a path.
 * Rendering: the canvas shows the SAME serialisation that Export SVG writes (allowlisted attributes only, built by our
 * own serialiser — never foreign markup), and hit-testing is done by the engine (fill-rule aware), not by the DOM.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import { apply, invert, starPoints, type Box, type Seg } from "@/lib/vector/path";
import {
  alignShapes, blankDoc, countShapes, defsToSvg, deleteShapes, distributeShapes, duplicateShapes, exportSvg, flipShapes, groupShapes,
  hitTest, importSvg, migrate, moveNode, moveShapes, nextId, pathNodes, reorder, resizeShapes, rotateShapes, selectionBounds,
  shapeToSvg, shapesInRect, toPath, ungroup, updateShape, arrowSegs, restar, IDENTITY,
  type AlignMode, type Gradient, type Shape, type Style, type VDoc, type ZMove,
} from "@/lib/vector/model";
import { BOOL_LABEL, booleanOp, type BoolOp } from "@/lib/vector/boolean";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

type Tool = "select" | "node" | "rect" | "ellipse" | "line" | "star" | "pen" | "text";
const TOOLS: { id: Tool; key: string; label: string; icon: string }[] = [
  { id: "select", key: "v", label: "Select", icon: "↖" }, { id: "node", key: "a", label: "Node", icon: "◇" },
  { id: "rect", key: "r", label: "Rect", icon: "▭" }, { id: "ellipse", key: "e", label: "Ellipse", icon: "◯" },
  { id: "line", key: "l", label: "Line", icon: "╱" }, { id: "star", key: "s", label: "Star", icon: "★" },
  { id: "pen", key: "p", label: "Pen", icon: "✒" }, { id: "text", key: "t", label: "Text", icon: "T" },
];
type Anchor = { x: number; y: number; h?: [number, number] };
type Drag =
  | { k: "move"; x0: number; y0: number; orig: VDoc; ids: string[]; doc: VDoc }
  | { k: "resize"; handle: string; box: Box; orig: VDoc; ids: string[]; doc: VDoc }
  | { k: "rotate"; cx: number; cy: number; a0: number; orig: VDoc; ids: string[]; doc: VDoc; deg: number }
  | { k: "marquee"; x0: number; y0: number; x: number; y: number; add: string[] }
  | { k: "create"; tool: Tool; x0: number; y0: number; x: number; y: number; shift: boolean }
  | { k: "node"; id: string; node: { seg: number; role: "anchor" | "in" | "out" }; orig: VDoc; doc: VDoc }
  | { k: "pen" };
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const HIST_MAX = 100;
const b64 = (u8: Uint8Array) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const slug = (s: string) => s.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-").toLowerCase() || "vector";
const r2 = (v: number) => Math.round(v * 100) / 100;
const isHex = (c: string | undefined) => !!c && /^#[0-9a-f]{6}$/i.test(c);
const toHex = (c: string | undefined, d: string) => (isHex(c) ? c! : c && /^#[0-9a-f]{3}$/i.test(c) ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : d);

function penSegs(a: Anchor[], closed: boolean): Seg[] {
  if (!a.length) return [];
  const segs: Seg[] = [{ t: "M", x: a[0].x, y: a[0].y }];
  const link = (p: Anchor, c: Anchor) => {
    if (!p.h && !c.h) segs.push({ t: "L", x: c.x, y: c.y });
    else { const [x1, y1] = p.h ?? [p.x, p.y]; const [x2, y2] = c.h ? [2 * c.x - c.h[0], 2 * c.y - c.h[1]] : [c.x, c.y]; segs.push({ t: "C", x1, y1, x2, y2, x: c.x, y: c.y }); }
  };
  for (let i = 1; i < a.length; i++) link(a[i - 1], a[i]);
  if (closed && a.length > 2) { link(a[a.length - 1], a[0]); segs.push({ t: "Z" }); }
  return segs;
}
function boxFromHandle(h: string, b: Box, x: number, y: number, keep: boolean): Box {
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  if (h.includes("w")) x0 = x; if (h.includes("e")) x1 = x; if (h.includes("n")) y0 = y; if (h.includes("s")) y1 = y;
  if (keep && b.w && b.h && h.length === 2) { const s = Math.max(Math.abs(x1 - x0) / b.w, Math.abs(y1 - y0) / b.h); if (h.includes("w")) x0 = x1 - b.w * s; else x1 = x0 + b.w * s; if (h.includes("n")) y0 = y1 - b.h * s; else y1 = y0 + b.h * s; }
  const nx = Math.min(x0, x1), ny = Math.min(y0, y1);
  return { x: nx, y: ny, w: Math.max(0.5, Math.abs(x1 - x0)), h: Math.max(0.5, Math.abs(y1 - y0)) };
}

function ToolIcon({ id }: { id: Tool }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" style={{ width: fz(16), height: fz(16), display: "block", margin: "0 auto" }}>
      {id === "select" ? <path {...p} d="M4 2 L4 15 L7.5 11.5 L10 16 L12 15 L9.5 10.5 L14 10.5 Z" fill="currentColor" /> : null}
      {id === "node" ? <><path {...p} d="M3 14 C6 3 12 3 15 14" /><rect x="1.5" y="12.5" width="3" height="3" fill="currentColor" /><rect x="13.5" y="12.5" width="3" height="3" fill="currentColor" /><circle cx="9" cy="5.5" r="1.6" fill="currentColor" /></> : null}
      {id === "rect" ? <rect {...p} x="3" y="4.5" width="12" height="9" rx="1" /> : null}
      {id === "ellipse" ? <ellipse {...p} cx="9" cy="9" rx="6.5" ry="5" /> : null}
      {id === "line" ? <path {...p} d="M3 15 L15 3" /> : null}
      {id === "star" ? <path {...p} d="M9 2 L11 7 L16 7.2 L12 10.4 L13.4 15.5 L9 12.6 L4.6 15.5 L6 10.4 L2 7.2 L7 7 Z" /> : null}
      {id === "pen" ? <><path {...p} d="M9 2 L13.5 9 L9 16 L4.5 9 Z" /><circle cx="9" cy="10" r="1.3" fill="currentColor" /></> : null}
      {id === "text" ? <path {...p} d="M3.5 4 H14.5 M9 4 V15 M7 15 H11" /> : null}
    </svg>
  );
}

export default function VectorModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hist, setHist] = useState<{ stack: VDoc[]; i: number }>(() => ({ stack: [blankDoc()], i: 0 }));
  const doc = hist.stack[hist.i];
  const [sel, setSel] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pen, setPen] = useState<Anchor[]>([]);
  const [penHover, setPenHover] = useState<[number, number] | null>(null);
  const [cur, setCur] = useState<Style>({ fill: "#5b8cff", stroke: "#1e293b", strokeWidth: 2 });
  const [star, setStar] = useState({ sides: 5, inner: 0.5 });
  const [arrow, setArrow] = useState(false);
  const [status, setStatus] = useState("");
  const [report, setReport] = useState<{ dropped: string[]; warnings: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [scale, setScale] = useState(1); // screen px per document unit
  const [zoom, setZoom] = useState<"fit" | number>("fit");

  const view = drag && "doc" in drag ? drag.doc : doc;
  const selShapes = view.shapes.filter((s) => sel.includes(s.id));
  const first = selShapes[0];
  const bbox = useMemo(() => selectionBounds(view, sel), [view, sel]);
  const px = 1 / scale; // one screen pixel in document units

  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const measure = () => { const m = svg.getScreenCTM(); if (m) setScale(Math.abs(m.a) || 1); };
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    const raf = requestAnimationFrame(measure); // viewBox changes (new document size) do not resize the element
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [zoom, doc.width, doc.height]);

  const commit = (next: VDoc, msg?: string) => {
    setHist((h) => { const stack = [...h.stack.slice(0, h.i + 1), next].slice(-HIST_MAX); return { stack, i: stack.length - 1 }; });
    setDirty(true); if (msg) setStatus(msg);
  };
  const undo = () => setHist((h) => ({ ...h, i: Math.max(0, h.i - 1) }));
  const redo = () => setHist((h) => ({ ...h, i: Math.min(h.stack.length - 1, h.i + 1) }));
  const replaceDoc = (d: VDoc, msg: string) => { setHist({ stack: [d], i: 0 }); setSel([]); setDirty(false); setStatus(msg); };

  /* ---------------------------------------------------------------- open / save */
  const openText = (text: string, name: string) => {
    if (/\.fsvg$/i.test(name)) { const d = migrate(JSON.parse(text)); replaceDoc(d, `opened ${name} (${countShapes(d.shapes)} shapes)`); setReport(null); return; }
    const r = importSvg(text, name.replace(/\.svg$/i, ""));
    replaceDoc(r.doc, `opened ${name}: ${countShapes(r.doc.shapes)} shapes${r.dropped.length ? `, ${r.dropped.length} unsupported kinds dropped` : ""}`);
    setReport(r.dropped.length || r.warnings.length ? { dropped: r.dropped, warnings: r.warnings } : null);
  };
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<{ node: { content: string; name: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (!live) return;
        try { openText(r.node.content, r.node.name || path); } catch (e) { setStatus(`Could not open ${path}: ${(e as Error).message}`); }
      })
      .catch((e) => { if (live) setStatus(`Could not open ${path}: ${(e as Error).message}`); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const write = async (dst: string, content: string, mime: string, reason: string) => {
    await post("/api/fs", { op: "write", path: dst, content, mime, reason }); shell.bumpRefresh();
  };
  const saveNative = async () => {
    const dst = /\.fsvg$/i.test(path) ? path : `/Documents/${slug(doc.title)}.fsvg`;
    try { await write(dst, JSON.stringify(doc), "application/json", "vector-save"); setDirty(false); setStatus(`saved ${dst}`); } catch (e) { shell.toast(`Save failed: ${(e as Error).message}`, "bad"); }
  };
  const exportSvgFile = async () => {
    const dst = `/Pictures/${slug(doc.title)}.svg`;
    try { await write(dst, exportSvg(doc), "image/svg+xml", "vector-export"); setStatus(`exported ${dst} (${countShapes(doc.shapes)} shapes)`); } catch (e) { shell.toast(`Export failed: ${(e as Error).message}`, "bad"); }
  };
  const exportPng = async () => {
    try {
      const url = URL.createObjectURL(new Blob([exportSvg(doc)], { type: "image/svg+xml" }));
      const img = new Image(); img.src = url; await img.decode();
      const w = Math.min(8192, Math.round(doc.width)), h = Math.min(8192, Math.round(doc.height));
      const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d")!.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/png"));
      const dst = `/Pictures/${slug(doc.title)}.png`;
      await post("/api/fs", { op: "upload", path: dst, content: b64(new Uint8Array(await blob.arrayBuffer())), mime: "image/png" });
      shell.bumpRefresh(); setStatus(`exported ${dst} (${w}×${h})`);
    } catch (e) { shell.toast(`PNG export failed: ${(e as Error).message}`, "bad"); }
  };

  /* ---------------------------------------------------------------- pointer */
  const toDoc = (e: { clientX: number; clientY: number }): [number, number] => {
    const svg = svgRef.current; const m = svg?.getScreenCTM(); if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()); return [p.x, p.y];
  };
  const makeShape = (t: Tool, x0: number, y0: number, x: number, y: number, shift: boolean, id: string): Shape | null => {
    const style: Style = { ...cur };
    if (t === "rect" || t === "ellipse") {
      let w = x - x0, h = y - y0; if (shift) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
      const bx = Math.min(x0, x0 + w), by = Math.min(y0, y0 + h), bw = Math.abs(w), bh = Math.abs(h);
      return t === "rect" ? { id, kind: "rect", transform: IDENTITY, style, x: bx, y: by, w: bw, h: bh, rx: 0, ry: 0 } : { id, kind: "ellipse", transform: IDENTITY, style, cx: bx + bw / 2, cy: by + bh / 2, rx: bw / 2, ry: bh / 2 };
    }
    if (t === "line") {
      let x2 = x, y2 = y; if (shift) { const a = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * Math.PI / 4, L = Math.hypot(x - x0, y - y0); x2 = x0 + L * Math.cos(a); y2 = y0 + L * Math.sin(a); }
      const lineStyle = { ...style, fill: "none", stroke: style.stroke === "none" ? "#000000" : style.stroke };
      if (arrow) return { id, kind: "path", transform: IDENTITY, style: { ...lineStyle, linecap: "round", linejoin: "round" }, segs: arrowSegs(x0, y0, x2, y2, Math.max(10, (style.strokeWidth ?? 1) * 4)) };
      return { id, kind: "line", transform: IDENTITY, style: lineStyle, x1: x0, y1: y0, x2, y2 };
    }
    if (t === "star") { const R = Math.hypot(x - x0, y - y0); return { id, kind: "polygon", transform: IDENTITY, style, points: starPoints(x0, y0, R, star.inner > 0 ? R * star.inner : 0, star.sides), star: { n: star.sides, inner: star.inner } }; }
    return null;
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    wrapRef.current?.focus();
    const [x, y] = toDoc(e);
    const target = e.target as Element;
    const handle = target.getAttribute("data-handle"), node = target.getAttribute("data-node");
    if (handle && bbox) {
      if (handle === "rot") { const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2; setDrag({ k: "rotate", cx, cy, a0: Math.atan2(y - cy, x - cx), orig: doc, ids: sel, doc, deg: 0 }); }
      else setDrag({ k: "resize", handle, box: bbox, orig: doc, ids: sel, doc });
      return;
    }
    if (node && first) { const [seg, role] = node.split(":"); setDrag({ k: "node", id: first.id, node: { seg: Number(seg), role: role as "anchor" | "in" | "out" }, orig: doc, doc }); return; }
    if (tool === "select" || tool === "node") {
      const id = hitTest(doc, x, y, 4 * px);
      if (id) {
        const ids = e.shiftKey ? (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]) : sel.includes(id) ? sel : [id];
        setSel(ids);
        if (tool === "node") { const s = doc.shapes.find((q) => q.id === id); if (s && s.kind !== "path") setStatus(`${s.kind}: use Arrange > To path to edit its nodes`); return; }
        if (!e.shiftKey || ids.includes(id)) setDrag({ k: "move", x0: x, y0: y, orig: doc, ids, doc });
      } else { if (!e.shiftKey) setSel([]); setDrag({ k: "marquee", x0: x, y0: y, x, y, add: e.shiftKey ? sel : [] }); }
      return;
    }
    if (tool === "pen") {
      if (pen.length >= 2 && Math.hypot(x - pen[0].x, y - pen[0].y) <= 6 * px) { finishPen(true); return; }
      setPen((p) => [...p, { x, y }]); setDrag({ k: "pen" }); return;
    }
    if (tool === "text") {
      const id = nextId(doc);
      commit({ ...doc, shapes: [...doc.shapes, { id, kind: "text", transform: IDENTITY, style: { fill: cur.fill === "none" ? "#000000" : cur.fill, stroke: "none", strokeWidth: 1, fontSize: 28, fontFamily: "sans-serif" }, x, y, text: "Text" }] }, "text added — edit it in Properties");
      setSel([id]); setTool("select"); return;
    }
    setDrag({ k: "create", tool, x0: x, y0: y, x, y, shift: e.shiftKey });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const [x, y] = toDoc(e);
    if (tool === "pen" && !drag) setPenHover([x, y]);
    if (!drag) return;
    switch (drag.k) {
      case "move": setDrag({ ...drag, doc: moveShapes(drag.orig, drag.ids, x - drag.x0, y - drag.y0) }); break;
      case "resize": setDrag({ ...drag, doc: resizeShapes(drag.orig, drag.ids, drag.box, boxFromHandle(drag.handle, drag.box, x, y, e.shiftKey)) }); break;
      case "rotate": {
        let deg = (Math.atan2(y - drag.cy, x - drag.cx) - drag.a0) * 180 / Math.PI; if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        setDrag({ ...drag, deg, doc: rotateShapes(drag.orig, drag.ids, deg, drag.cx, drag.cy) }); break;
      }
      case "marquee": setDrag({ ...drag, x, y }); break;
      case "create": setDrag({ ...drag, x, y, shift: e.shiftKey }); break;
      case "node": {
        const s = drag.orig.shapes.find((q) => q.id === drag.id); if (!s || s.kind !== "path") break;
        const [lx, ly] = apply(invert(s.transform), x, y);
        setDrag({ ...drag, doc: updateShape(drag.orig, drag.id, (q) => (q.kind === "path" ? { ...q, segs: moveNode(q.segs, drag.node, lx, ly) } : q)) }); break;
      }
      case "pen": setPen((p) => { if (!p.length) return p; const last = p[p.length - 1]; if (Math.hypot(x - last.x, y - last.y) < 2 * px) return p; return [...p.slice(0, -1), { ...last, h: [x, y] }]; }); break;
    }
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag; setDrag(null);
    if (d.k === "move" || d.k === "resize" || d.k === "rotate" || d.k === "node") {
      if (d.doc !== d.orig) commit(d.doc, d.k === "rotate" ? `rotated ${r2(d.deg)}°` : undefined);
    } else if (d.k === "marquee") {
      const r = { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
      if (r.w > 1 || r.h > 1) setSel([...new Set([...d.add, ...shapesInRect(doc, r)])]);
    } else if (d.k === "create") {
      const id = nextId(doc);
      const tiny = Math.hypot(d.x - d.x0, d.y - d.y0) < 3 * px;
      const s = tiny ? makeShape(d.tool, d.x0, d.y0, d.x0 + (d.tool === "star" ? 50 : 100), d.y0 + (d.tool === "line" ? 0 : d.tool === "star" ? 0 : 80), false, id) : makeShape(d.tool, d.x0, d.y0, d.x, d.y, d.shift, id);
      if (s) { commit({ ...doc, shapes: [...doc.shapes, s] }, `${s.kind} added`); setSel([id]); }
    }
  };
  const finishPen = (closed: boolean) => {
    const pts = pen.filter((a, i) => i === 0 || Math.hypot(a.x - pen[i - 1].x, a.y - pen[i - 1].y) > 1 * px);
    setPen([]); setPenHover(null); setDrag(null);
    if (pts.length < 2) return;
    const id = nextId(doc);
    commit({ ...doc, shapes: [...doc.shapes, { id, kind: "path", transform: IDENTITY, style: { ...cur, fill: closed ? cur.fill : "none", stroke: cur.stroke === "none" ? "#000000" : cur.stroke }, segs: penSegs(pts, closed) }] }, `path with ${pts.length} nodes${closed ? " (closed)" : ""}`);
    setSel([id]);
  };

  /* ---------------------------------------------------------------- commands */
  const styleDeep = (s: Shape, patch: Style): Shape => (s.kind === "group" ? { ...s, children: s.children.map((c) => styleDeep(c, patch)) } : { ...s, style: { ...s.style, ...patch } });
  const setStyle = (patch: Style) => {
    setCur((c) => ({ ...c, ...patch }));
    if (sel.length) commit({ ...doc, shapes: doc.shapes.map((s) => (sel.includes(s.id) ? styleDeep(s, patch) : s)) });
  };
  const patchFirst = (f: (s: Shape) => Shape) => { if (first) commit(updateShape(doc, first.id, f)); };
  const run = (name: string) => {
    if (name === "undo") return undo();
    if (name === "redo") return redo();
    if (name === "all") return setSel(doc.shapes.filter((s) => !s.locked && !s.hidden).map((s) => s.id));
    if (!sel.length) return;
    switch (name) {
      case "delete": commit(deleteShapes(doc, sel), `deleted ${sel.length}`); setSel([]); break;
      case "duplicate": { const r = duplicateShapes(doc, sel); commit(r.doc, `duplicated ${sel.length}`); setSel(r.ids); break; }
      case "group": { const r = groupShapes(doc, sel); if (r.id) { commit(r.doc, `grouped ${sel.length}`); setSel([r.id]); } break; }
      case "ungroup": { let d = doc; const ids: string[] = []; let approx = false; for (const id of sel) { const r = ungroup(d, id); d = r.doc; ids.push(...r.ids); approx ||= r.approx; } if (ids.length) { commit(d, approx ? "ungrouped (group opacity distributed to children — overlaps may look different)" : "ungrouped"); setSel(ids); } break; }
      case "topath": try { commit({ ...doc, shapes: doc.shapes.map((s) => (sel.includes(s.id) ? toPath(s) : s)) }, "converted to path"); } catch (e) { setStatus((e as Error).message); } break;
      case "unite": case "minusFront": case "intersect": case "exclude": {
        try { const r = booleanOp(doc, sel, name as BoolOp); commit(r.doc, `${BOOL_LABEL[name as BoolOp]}: ${r.rings} ring(s), area ${Math.round(r.area)}${r.approx ? " — approximate (crossing nonzero subpaths)" : ""}`); setSel([r.id]); }
        catch (e) { setStatus((e as Error).message); }
        break;
      }
      case "fliph": commit(flipShapes(doc, sel, "h")); break;
      case "flipv": commit(flipShapes(doc, sel, "v")); break;
      case "disth": commit(distributeShapes(doc, sel, "h")); break;
      case "distv": commit(distributeShapes(doc, sel, "v")); break;
      default:
        if (["front", "back", "forward", "backward"].includes(name)) commit(reorder(doc, sel, name as ZMove));
        else if (["left", "hcenter", "right", "top", "vcenter", "bottom"].includes(name)) commit(alignShapes(doc, sel, name as AlignMode), sel.length === 1 ? `aligned ${name} to the page` : `aligned ${name}`);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (tool === "pen" && pen.length && (e.key === "Enter" || e.key === "Escape")) { e.preventDefault(); finishPen(false); return; }
    if (mod) {
      const map: Record<string, string> = { z: e.shiftKey ? "redo" : "undo", y: "redo", d: "duplicate", g: e.shiftKey ? "ungroup" : "group", a: "all", "]": e.shiftKey ? "front" : "forward", "[": e.shiftKey ? "back" : "backward" };
      if (map[k]) { e.preventDefault(); run(map[k]); }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); run("delete"); return; }
    if (e.key === "Escape") { setSel([]); return; }
    const nudge: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (nudge[k] && sel.length) { e.preventDefault(); const f = e.shiftKey ? 10 : 1; commit(moveShapes(doc, sel, nudge[k][0] * f, nudge[k][1] * f)); return; }
    const tl = TOOLS.find((x) => x.key === k); if (tl) { setTool(tl.id); if (tl.id !== "pen") setPen([]); }
  };

  /* ---------------------------------------------------------------- render helpers */
  const shapesHtml = useMemo(() => defsToSvg(view) + view.shapes.map((s) => shapeToSvg(s, { ids: true })).join(""), [view]);
  const preview = drag?.k === "create" ? makeShape(drag.tool, drag.x0, drag.y0, drag.x, drag.y, drag.shift, "preview") : null;
  const penPreview = pen.length ? penSegs(penHover && drag?.k !== "pen" ? [...pen, { x: penHover[0], y: penHover[1] }] : pen, false) : null;
  const nodeShape = tool === "node" && selShapes.length === 1 && first?.kind === "path" ? first : null;
  const grads = view.gradients;
  const fillMode = !first ? (cur.fill === "none" ? "none" : "solid") : first.style.fill === "none" ? "none" : /^url\(#(.+)\)$/.exec(first.style.fill ?? "")?.[1] ?? "solid";
  const activeGrad = grads.find((g) => g.id === fillMode);
  const leaf = (sh: Shape | undefined): Shape | undefined => (sh?.kind === "group" ? leaf(sh.children[0]) : sh);
  const fs = leaf(first)?.style ?? cur;
  const setGrad = (g: Gradient) => commit({ ...doc, gradients: doc.gradients.map((x) => (x.id === g.id ? g : x)) });
  const newGradient = () => {
    const id = nextId(doc, "gr");
    const g: Gradient = { id, kind: "linear", units: "objectBoundingBox", transform: IDENTITY, spread: "pad", x1: 0, y1: 0, x2: 1, y2: 0, cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5, stops: [{ offset: 0, color: toHex(fs.fill, "#5b8cff"), opacity: 1 }, { offset: 1, color: toHex(fs.stroke, "#1e293b"), opacity: 1 }] };
    const d = { ...doc, gradients: [...doc.gradients, g], shapes: doc.shapes.map((s) => (sel.includes(s.id) ? styleDeep(s, { fill: `url(#${id})` }) : s)) };
    commit(d, `gradient ${id} applied`);
  };
  const numIn = (label: string, v: number, set: (n: number) => void, step = 1) => (
    <label className="fs-row" style={{ justifyContent: "space-between", fontSize: fz(11), gap: 4 }}>{label}
      <input aria-label={label} className="fs-input" type="number" step={step} value={r2(v)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set(n); }} style={{ width: 72 }} /></label>
  );
  const rotation = first ? r2(Math.atan2(first.transform[1], first.transform[0]) * 180 / Math.PI) : 0;
  const svgSize = zoom === "fit" ? { width: "100%", height: "100%" } : { width: doc.width * zoom, height: doc.height * zoom };

  return (
    <div ref={wrapRef} data-testid="vector-studio" data-shapes={view.shapes.length} data-selected={sel.join(",")} data-tool={tool} data-undo={hist.i}
      tabIndex={0} onKeyDown={onKey} style={{ display: "grid", gridTemplateColumns: `${fz(44)} minmax(0, 1fr) min(${fz(220)}, 34%)`, gridTemplateRows: "auto 1fr auto", height: "100%", minHeight: 0, outline: "none" }}>
      <div className="fs-row" style={{ gridColumn: "1 / 4", padding: 6, gap: 4, flexWrap: "wrap", borderBottom: "1px solid var(--fs-border)" }}>
        <input className="fs-input" style={{ width: fz(170) }} aria-label="Vector document title" value={doc.title} onChange={(e) => { setHist((h) => ({ ...h, stack: h.stack.map((d, i) => (i === h.i ? { ...d, title: e.target.value } : d)) })); setDirty(true); }} />
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Open…<input type="file" aria-label="Open SVG or fsvg" accept="image/svg+xml,.svg,.fsvg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => { try { openText(t, f.name); } catch (err) { setStatus(`Could not open ${f.name}: ${(err as Error).message}`); } }); e.target.value = ""; }} /></label>
        <Btn variant="ghost" onClick={() => replaceDoc(blankDoc(), "new document")}>New</Btn>
        <Btn variant="primary" onClick={() => void saveNative()}>Save .fsvg</Btn>
        <Btn variant="ghost" onClick={() => void exportSvgFile()}>Export SVG</Btn>
        <Btn variant="ghost" onClick={() => void exportPng()}>Export PNG</Btn>
        <Btn variant="ghost" onClick={undo} disabled={hist.i === 0}>Undo</Btn>
        <Btn variant="ghost" onClick={redo} disabled={hist.i >= hist.stack.length - 1}>Redo</Btn>
        <select className="fs-input" aria-label="Zoom" value={String(zoom)} onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))} style={{ width: fz(76) }}>
          {["fit", "0.5", "1", "2", "4"].map((z) => <option key={z} value={z}>{z === "fit" ? "Fit" : `${Number(z) * 100}%`}</option>)}
        </select>
        <Badge tone={dirty ? "warn" : "ok"}>{dirty ? "unsaved" : "saved"}</Badge>
      </div>

      <div style={{ borderRight: "1px solid var(--fs-border)", display: "grid", alignContent: "start", gap: 2, padding: 3 }}>
        {TOOLS.map((t) => (
          <button key={t.id} className="fs-list-item" data-selected={tool === t.id} aria-label={`${t.label} tool (${t.key.toUpperCase()})`} title={`${t.label} (${t.key.toUpperCase()})`}
            onClick={() => { setTool(t.id); if (t.id !== "pen") setPen([]); }} style={{ flexDirection: "column", padding: "4px 0", fontSize: fz(10), gap: 0, alignItems: "center" }}>
            <ToolIcon id={t.id} />{t.label}
          </button>
        ))}
      </div>

      <div className="fs-scroll" style={{ minHeight: 0, minWidth: 0, display: "grid", placeItems: "center", padding: 10, background: "#080d18" }}>
        <svg ref={svgRef} data-testid="vector-canvas" viewBox={`0 0 ${doc.width} ${doc.height}`} {...svgSize} role="img" aria-label={doc.title}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setPenHover(null)}
          onDoubleClick={() => { if (tool === "pen" && pen.length) finishPen(false); }}
          style={{ background: "transparent", touchAction: "none", cursor: tool === "select" ? "default" : "crosshair", maxWidth: zoom === "fit" ? "100%" : undefined, maxHeight: zoom === "fit" ? "100%" : undefined }}>
          <rect width={doc.width} height={doc.height} fill={view.background ?? "#ffffff"} pointerEvents="none" />
          <g data-testid="vector-content" dangerouslySetInnerHTML={{ __html: shapesHtml }} />
          <g pointerEvents="none" fill="none" stroke="#2563eb" strokeWidth={px}>
            {preview ? <g opacity={0.6} dangerouslySetInnerHTML={{ __html: shapeToSvg(preview) }} /> : null}
            {penPreview ? <path d={penPreview.map((s) => (s.t === "Z" ? "Z" : s.t === "C" ? `C${s.x1} ${s.y1} ${s.x2} ${s.y2} ${s.x} ${s.y}` : `${s.t}${s.x} ${s.y}`)).join(" ")} strokeWidth={1.5 * px} /> : null}
            {pen.map((a, i) => <g key={i}><rect x={a.x - 3 * px} y={a.y - 3 * px} width={6 * px} height={6 * px} fill={i === 0 ? "#2563eb" : "#fff"} />{a.h ? <><line x1={2 * a.x - a.h[0]} y1={2 * a.y - a.h[1]} x2={a.h[0]} y2={a.h[1]} /><circle cx={a.h[0]} cy={a.h[1]} r={2.5 * px} fill="#fff" /></> : null}</g>)}
            {drag?.k === "marquee" ? <rect x={Math.min(drag.x0, drag.x)} y={Math.min(drag.y0, drag.y)} width={Math.abs(drag.x - drag.x0)} height={Math.abs(drag.y - drag.y0)} strokeDasharray={`${4 * px} ${3 * px}`} fill="rgba(37,99,235,.08)" /> : null}
            {selShapes.length > 1 ? selShapes.map((s) => { const b = selectionBounds(view, [s.id]); return b ? <rect key={s.id} x={b.x} y={b.y} width={b.w} height={b.h} strokeDasharray={`${2 * px} ${2 * px}`} /> : null; }) : null}
          </g>
          {bbox ? (
            <g>
              <rect data-testid="sel-bbox" data-bbox={`${r2(bbox.x)},${r2(bbox.y)},${r2(bbox.w)},${r2(bbox.h)}`} x={bbox.x} y={bbox.y} width={bbox.w} height={bbox.h} fill="none" stroke="#2563eb" strokeWidth={px} pointerEvents="none" />
              {tool === "select" && !nodeShape ? <>
                <line x1={bbox.x + bbox.w / 2} y1={bbox.y} x2={bbox.x + bbox.w / 2} y2={bbox.y - 22 * px} stroke="#2563eb" strokeWidth={px} pointerEvents="none" />
                <circle data-handle="rot" data-testid="handle-rot" cx={bbox.x + bbox.w / 2} cy={bbox.y - 22 * px} r={5 * px} fill="#fff" stroke="#2563eb" strokeWidth={px} style={{ cursor: "grab" }} />
                {HANDLES.map((h) => {
                  const hx = bbox.x + (h.includes("w") ? 0 : h.includes("e") ? bbox.w : bbox.w / 2), hy = bbox.y + (h.includes("n") ? 0 : h.includes("s") ? bbox.h : bbox.h / 2);
                  return <rect key={h} data-handle={h} data-testid={`handle-${h}`} x={hx - 4 * px} y={hy - 4 * px} width={8 * px} height={8 * px} fill="#fff" stroke="#2563eb" strokeWidth={px} style={{ cursor: `${h}-resize` }} />;
                })}
              </> : null}
            </g>
          ) : null}
          {nodeShape ? (
            <g>
              {pathNodes(nodeShape.segs).map((n, i, all) => {
                const [x, y] = apply(nodeShape.transform, n.x, n.y);
                const anchor = all.find((q) => q.role === "anchor" && (n.role === "in" ? q.seg === n.seg : q.seg === n.seg));
                const [axp, ayp] = anchor ? apply(nodeShape.transform, anchor.x, anchor.y) : [x, y];
                return n.role === "anchor"
                  ? <rect key={i} data-node={`${n.seg}:anchor`} x={x - 4 * px} y={y - 4 * px} width={8 * px} height={8 * px} fill="#fff" stroke="#2563eb" strokeWidth={px} />
                  : <g key={i}><line x1={axp} y1={ayp} x2={x} y2={y} stroke="#94a3b8" strokeWidth={px} pointerEvents="none" /><circle data-node={`${n.seg}:${n.role}`} cx={x} cy={y} r={3.5 * px} fill="#2563eb" /></g>;
              })}
            </g>
          ) : null}
        </svg>
      </div>

      <aside className="fs-scroll" style={{ gridRow: "2 / 4", gridColumn: 3, borderLeft: "1px solid var(--fs-border)", padding: 8, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", alignContent: "start", gap: 8, fontSize: fz(11), minWidth: 0, overflowX: "hidden" }}>
        <div style={{ fontWeight: 600 }}>Properties {sel.length ? `(${sel.length} selected)` : "(new shapes)"}</div>
        <label className="fs-row" style={{ justifyContent: "space-between", gap: 4 }}>Fill
          <select className="fs-input" aria-label="Fill type" value={fillMode} style={{ width: fz(92) }} onChange={(e) => { const v = e.target.value; if (v === "none") setStyle({ fill: "none" }); else if (v === "solid") setStyle({ fill: toHex(cur.fill, "#5b8cff") }); else if (v === "+") newGradient(); else setStyle({ fill: `url(#${v})` }); }}>
            <option value="none">None</option><option value="solid">Solid</option>
            {grads.map((g) => <option key={g.id} value={g.id}>{g.kind} {g.id}</option>)}
            <option value="+">+ New gradient</option>
          </select>
          {fillMode === "solid" ? <input type="color" aria-label="Fill colour" value={toHex(fs.fill, "#5b8cff")} onChange={(e) => setStyle({ fill: e.target.value })} /> : null}
        </label>
        {activeGrad ? <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
          {activeGrad.stops.map((s, i) => <input key={i} type="color" aria-label={`Gradient stop ${i + 1}`} value={toHex(s.color, "#000000")} onChange={(e) => setGrad({ ...activeGrad, stops: activeGrad.stops.map((q, j) => (j === i ? { ...q, color: e.target.value } : q)) })} />)}
          {activeGrad.kind === "linear" ? <select className="fs-input" aria-label="Gradient angle" style={{ width: fz(70) }} value={String(Math.round(Math.atan2(activeGrad.y2 - activeGrad.y1, activeGrad.x2 - activeGrad.x1) * 180 / Math.PI))}
            onChange={(e) => { const a = Number(e.target.value) * Math.PI / 180, c = Math.cos(a) / 2, s = Math.sin(a) / 2; setGrad({ ...activeGrad, units: "objectBoundingBox", x1: r2(0.5 - c), y1: r2(0.5 - s), x2: r2(0.5 + c), y2: r2(0.5 + s) }); }}>
            {[0, 45, 90, 135, 180, -45, -90, -135].map((a) => <option key={a} value={a}>{a}°</option>)}
          </select> : null}
          <Btn variant="ghost" onClick={() => setGrad({ ...activeGrad, kind: activeGrad.kind === "linear" ? "radial" : "linear" })}>{activeGrad.kind === "linear" ? "→ radial" : "→ linear"}</Btn>
        </div> : null}
        <label className="fs-row" style={{ justifyContent: "space-between", gap: 4 }}>Stroke
          <input type="checkbox" aria-label="Stroke enabled" checked={(fs.stroke ?? "none") !== "none"} onChange={(e) => setStyle({ stroke: e.target.checked ? toHex(cur.stroke, "#1e293b") : "none" })} />
          <input type="color" aria-label="Stroke colour" value={toHex(fs.stroke, "#1e293b")} onChange={(e) => setStyle({ stroke: e.target.value })} />
        </label>
        {numIn("Stroke width", fs.strokeWidth ?? 1, (n) => setStyle({ strokeWidth: Math.max(0, n) }), 0.5)}
        {numIn("Opacity %", (fs.opacity ?? 1) * 100, (n) => setStyle({ opacity: Math.max(0, Math.min(100, n)) / 100 }))}
        <label className="fs-row" style={{ justifyContent: "space-between", gap: 4 }}>Dash
          <select className="fs-input" aria-label="Dash pattern" value={fs.dash ?? ""} style={{ width: fz(110) }} onChange={(e) => setStyle({ dash: e.target.value || undefined })}>
            {[["", "solid"], ["6 4", "dashed"], ["2 3", "dotted"], ["12 6 2 6", "dash-dot"], ...(fs.dash && !["6 4", "2 3", "12 6 2 6"].includes(fs.dash) ? [[fs.dash, `custom ${fs.dash}`]] : [])].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        <label className="fs-row" style={{ justifyContent: "space-between", gap: 4 }}>Fill rule
          <select className="fs-input" aria-label="Fill rule" value={fs.fillRule ?? "nonzero"} style={{ width: fz(110) }} onChange={(e) => setStyle({ fillRule: e.target.value as Style["fillRule"] })}><option value="nonzero">nonzero</option><option value="evenodd">evenodd</option></select></label>
        {tool === "star" ? <>{numIn("Star points", star.sides, (n) => setStar((s) => ({ ...s, sides: Math.max(3, Math.min(64, Math.round(n))) })))}{numIn("Inner ratio (0 = polygon)", star.inner, (n) => setStar((s) => ({ ...s, inner: Math.max(0, Math.min(1, n)) })), 0.05)}</> : null}
        {tool === "line" ? <label className="fs-row" style={{ justifyContent: "space-between", gap: 4 }}>Arrowhead<input type="checkbox" aria-label="Arrowhead" checked={arrow} onChange={(e) => setArrow(e.target.checked)} /></label> : null}
        {first?.kind === "polygon" && first.star && sel.length === 1 ? <>
          {numIn("Selected star points", first.star.n, (n) => patchFirst((sh) => restar(sh, n, sh.kind === "polygon" && sh.star ? sh.star.inner : 0.5)))}
          {numIn("Selected inner ratio", first.star.inner, (v) => patchFirst((sh) => restar(sh, sh.kind === "polygon" && sh.star ? sh.star.n : 5, v)), 0.05)}
        </> : null}
        {bbox ? <div style={{ display: "grid", gap: 3 }}>
          {numIn("X", bbox.x, (n) => commit(moveShapes(doc, sel, n - bbox.x, 0)))}
          {numIn("Y", bbox.y, (n) => commit(moveShapes(doc, sel, 0, n - bbox.y)))}
          {numIn("W", bbox.w, (n) => n > 0 && commit(resizeShapes(doc, sel, bbox, { ...bbox, w: n })))}
          {numIn("H", bbox.h, (n) => n > 0 && commit(resizeShapes(doc, sel, bbox, { ...bbox, h: n })))}
          {numIn("Rotation °", rotation, (n) => commit(rotateShapes(doc, sel, n - rotation)))}
        </div> : null}
        {first?.kind === "text" && sel.length === 1 ? <>
          <input className="fs-input" aria-label="Text content" value={first.text} onChange={(e) => patchFirst((s) => (s.kind === "text" ? { ...s, text: e.target.value } : s))} />
          {numIn("Font size", first.style.fontSize ?? 16, (n) => patchFirst((s) => ({ ...s, style: { ...s.style, fontSize: Math.max(1, n) } })))}
        </> : null}
        {first?.kind === "rect" && sel.length === 1 ? numIn("Corner radius", first.rx, (n) => patchFirst((s) => (s.kind === "rect" ? { ...s, rx: Math.max(0, n), ry: Math.max(0, n) } : s))) : null}

        <div style={{ fontWeight: 600 }}>Arrange</div>
        <div className="fs-row" style={{ flexWrap: "wrap", gap: 3 }}>
          {([["left", "Left"], ["hcenter", "Centre"], ["right", "Right"], ["top", "Top"], ["vcenter", "Middle"], ["bottom", "Bottom"]] as const).map(([m, ic]) => <Btn key={m} variant="ghost" title={`Align ${m}`} aria-label={`Align ${m} · ${ic}`} onClick={() => run(m)}>{ic}</Btn>)}
          <Btn variant="ghost" aria-label="Distribute horizontally · Distribute H" title="Distribute horizontally" onClick={() => run("disth")}>Distribute H</Btn><Btn variant="ghost" aria-label="Distribute vertically · Distribute V" title="Distribute vertically" onClick={() => run("distv")}>Distribute V</Btn>
        </div>
        <div className="fs-row" style={{ flexWrap: "wrap", gap: 3 }}>
          {([["front", "To front"], ["forward", "Forward"], ["backward", "Backward"], ["back", "To back"], ["group", "Group"], ["ungroup", "Ungroup"], ["duplicate", "Duplicate"], ["topath", "To path"], ["fliph", "Flip H"], ["flipv", "Flip V"]] as const).map(([c, l]) => <Btn key={c} variant="ghost" onClick={() => run(c)}>{l}</Btn>)}
          <Btn variant="danger" onClick={() => run("delete")}>Delete</Btn>
        </div>
        <div style={{ fontWeight: 600 }}>Pathfinder</div>
        <div className="fs-row" data-testid="pathfinder" style={{ flexWrap: "wrap", gap: 3 }}>
          {(["unite", "minusFront", "intersect", "exclude"] as const).map((op) => (
            <Btn key={op} variant="ghost" aria-label={BOOL_LABEL[op]} disabled={sel.length < 2}
              title={op === "minusFront" ? "Subtract the front shapes from the backmost (keeps the back paint)" : `${BOOL_LABEL[op]} the selected shapes (takes the front paint)`}
              onClick={() => { run(op); wrapRef.current?.focus({ preventScroll: true }); /* the button disables itself (1 shape left) and would drop focus to <body>, killing Ctrl+Z */ }}>{BOOL_LABEL[op]}</Btn>
          ))}
        </div>

        <div style={{ fontWeight: 600 }}>Layers ({view.shapes.length})</div>
        <div style={{ display: "grid", gap: 1 }}>
          {[...view.shapes].reverse().map((s) => (
            <div key={s.id} className="fs-list-item" data-testid="vector-layer" data-selected={sel.includes(s.id)} style={{ display: "flex", gap: 4, alignItems: "center", padding: "2px 4px" }}
              onClick={(e) => setSel(e.shiftKey ? (sel.includes(s.id) ? sel.filter((q) => q !== s.id) : [...sel, s.id]) : [s.id])}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.kind === "group" ? `▸ group (${s.children.length})` : s.kind}{s.name ? ` · ${s.name}` : ""} <span className="fs-dim">{s.id}</span></span>
              <button className="fs-btn" data-variant="ghost" aria-label={`${s.hidden ? "Show" : "Hide"} ${s.id}`} onClick={(e) => { e.stopPropagation(); commit(updateShape(doc, s.id, (q) => ({ ...q, hidden: !q.hidden }))); }}>{s.hidden ? "◌" : "●"}</button>
              <button className="fs-btn" data-variant="ghost" aria-label={`${s.locked ? "Unlock" : "Lock"} ${s.id}`} onClick={(e) => { e.stopPropagation(); commit(updateShape(doc, s.id, (q) => ({ ...q, locked: !q.locked }))); if (!s.locked) setSel(sel.filter((q) => q !== s.id)); }}>{s.locked ? "🔒" : "🔓"}</button>
            </div>
          ))}
        </div>
        {report ? <div data-testid="vector-report" style={{ border: "1px solid var(--fs-border)", borderRadius: 4, padding: 6 }}>
          <div style={{ fontWeight: 600 }}>Import report</div>
          {report.dropped.map((d) => <div key={d} className="fs-dim">dropped: {d}</div>)}
          {report.warnings.map((w) => <div key={w} className="fs-dim">note: {w}</div>)}
        </div> : null}
        <div className="fs-dim" style={{ fontSize: fz(10) }}>Import keeps rect/circle/ellipse/line/polyline/polygon/path/text/g/use + gradients; arcs become cubic Béziers (≤2.7·10⁻⁴·r error). Scripts, handlers, external refs, CSS sheets, filters, masks, clip paths, patterns, markers, images are reported and dropped. Text bounds are estimated (no font metrics). The source SVG is never overwritten.</div>
      </aside>

      <div data-testid="vector-message" className="fs-dim" style={{ gridColumn: "1 / 3", padding: "3px 8px", fontSize: fz(10.5), borderTop: "1px solid var(--fs-border)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {status || "Ready"} · {TOOLS.find((t) => t.id === tool)?.label} tool{bbox ? ` · ${r2(bbox.w)}×${r2(bbox.h)} at ${r2(bbox.x)},${r2(bbox.y)}` : ""}{tool === "pen" ? " · click = corner, drag = smooth, click first node = close, Enter = finish" : ""}
      </div>
    </div>
  );
}

