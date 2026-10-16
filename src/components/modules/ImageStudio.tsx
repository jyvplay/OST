"use client";
import { fz } from "@/lib/uiscale";

/**
 * FF-30 / FF-31 Image Studio (TT16): layered raster editor over src/lib/image (pure, headless-tested engine).
 * Tools: move, brush, eraser, paint bucket, gradient, eyedropper, rectangular/elliptical marquee, magic wand.
 * Layers: 12 W3C separable blend modes, opacity, visibility, lock, masks (paint/enable/apply), reorder, duplicate,
 * merge down (warns when Photoshop semantics change the picture), flatten. Adjustments/filters on the active layer
 * through the selection. Image: crop to selection, rotate/flip canvas, flip layer, resize image/canvas.
 * Files: PSD read/write (native format; verified against psd-tools), PNG/JPEG/WebP/GIF open, PNG/JPEG export,
 * place image as layer. Undo/redo: snapshot history with a unique-buffer byte budget.
 * Headless test hooks: data-testid="image-studio" (data-doc-w/-h/-layers/-active/-tool/-undo) and the canvas
 * (getImageData is readable: all sources are same-origin blobs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtBytes, post } from "@/lib/api";
import {
  BLEND_MODES, addLayer, clipRect, composite, compositeRegion, cropCanvas, duplicateLayer, flatten, flattenOnto, flipDoc,
  growLayerTo, hex, makeLayer, mergeChangesAppearance, mergeDown, newDoc, normRect, parseHex, patchLayer, removeLayer,
  reorderLayer, resizeCanvas, resizeImage, rotateDoc, type BlendMode, type ImageDoc, type Layer, type Rect,
} from "@/lib/image/doc";
import {
  clearSelection, combineSelections, copySelection, floodFill, invertSelection, linearGradient, magicWand, sampleAverage,
  selectAll, selectEllipse, selectRect, selectionEmpty, strokeSegment, type BrushOpts, type Selection,
} from "@/lib/image/paint";
import { readPsd, writePsd } from "@/lib/image/psd";
import { createHistory, pushHistory, redoHistory, undoHistory, uniqueBufferBytes, type History } from "@/lib/image/history";
import * as R from "@/lib/image/raster";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

type Tool = "move" | "brush" | "eraser" | "fill" | "gradient" | "eyedropper" | "marquee" | "ellipse" | "wand";
const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "move", label: "Move", key: "V" }, { id: "marquee", label: "Rect select", key: "M" }, { id: "ellipse", label: "Ellipse select", key: "" },
  { id: "wand", label: "Magic wand", key: "W" }, { id: "brush", label: "Brush", key: "B" }, { id: "eraser", label: "Eraser", key: "E" },
  { id: "fill", label: "Bucket", key: "G" }, { id: "gradient", label: "Gradient", key: "" }, { id: "eyedropper", label: "Eyedropper", key: "I" },
];
const FILTERS: { id: string; label: string; param?: { min: number; max: number; def: number; step?: number; label: string } }[] = [
  { id: "brightness", label: "Brightness", param: { min: 0, max: 200, def: 120, label: "%" } },
  { id: "contrast", label: "Contrast", param: { min: 0, max: 200, def: 130, label: "%" } },
  { id: "saturation", label: "Saturation", param: { min: 0, max: 300, def: 150, label: "%" } },
  { id: "hue", label: "Hue shift", param: { min: -180, max: 180, def: 90, label: "°" } },
  { id: "levels", label: "Levels (gamma)", param: { min: 20, max: 300, def: 140, label: "γ×100" } },
  { id: "blur", label: "Blur", param: { min: 1, max: 20, def: 3, label: "px" } },
  { id: "sharpen", label: "Sharpen", param: { min: 1, max: 30, def: 15, label: "×10" } },
  { id: "motion", label: "Motion blur", param: { min: 2, max: 40, def: 10, label: "px" } },
  { id: "grayscale", label: "Grayscale" }, { id: "invert", label: "Invert" }, { id: "sepia", label: "Sepia" }, { id: "equalize", label: "Equalize" },
  { id: "posterize", label: "Posterize", param: { min: 2, max: 16, def: 4, label: "levels" } },
  { id: "threshold", label: "Threshold", param: { min: 0, max: 255, def: 128, label: "" } },
  { id: "edges", label: "Edge detect" },
  { id: "pixelate", label: "Pixelate", param: { min: 2, max: 64, def: 8, label: "px" } },
  { id: "noise", label: "Noise", param: { min: 1, max: 100, def: 24, label: "" } },
  { id: "vignette", label: "Vignette", param: { min: 1, max: 100, def: 60, label: "%" } },
  { id: "oil", label: "Oil paint", param: { min: 1, max: 8, def: 3, label: "r" } },
];
const HISTORY_BYTES = 192 * 1024 * 1024;

function applyFilter(r: R.Raster, id: string, v: number): R.Raster {
  switch (id) {
    case "brightness": return R.adjust(r, { brightness: v / 100 });
    case "contrast": return R.adjust(r, { contrast: v / 100 });
    case "saturation": return R.adjust(r, { saturation: v / 100 });
    case "hue": return R.hueShift(r, v);
    case "levels": return R.levels(r, 0, 255, v / 100);
    case "blur": return R.blur(r, v);
    case "sharpen": return R.sharpen(r, v / 10);
    case "motion": return R.motionBlur(r, v, 0);
    case "grayscale": return R.adjust(r, { grayscale: true });
    case "invert": return R.adjust(r, { invert: true });
    case "sepia": return R.sepia(r);
    case "equalize": return R.equalize(r);
    case "posterize": return R.posterize(r, v);
    case "threshold": return R.threshold(r, v);
    case "edges": return R.edgeDetect(r);
    case "pixelate": return R.pixelate(r, v);
    case "noise": return R.addNoise(r, v);
    case "vignette": return R.vignette(r, v / 100);
    case "oil": return R.oilPaint(r, v, 20);
    default: return r;
  }
}

const b64 = (u8: Uint8Array) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const stem = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-") || "image";

async function decodeImage(blob: Blob): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    if (bmp.width * bmp.height > 36_000_000) throw new Error(`${bmp.width}×${bmp.height} exceeds the 36 MP guard`);
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
  } finally { bmp.close(); }
}
async function encodeCanvas(rgba: Uint8ClampedArray, w: number, h: number, type: "image/png" | "image/jpeg"): Promise<Blob> {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), type, 0.92));
}
function download(blob: Blob, name: string) { const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); }

interface Stroke { kind: Tool; start: { x: number; y: number }; last: { x: number; y: number }; carry: number; working?: Layer; moved?: boolean; base?: ImageDoc }

export default function ImageStudio({ win }: ModuleProps) {
  const shell = useShell();
  const [hist, setHist] = useState<History<ImageDoc>>(() => createHistory(newDoc(800, 600)));
  const doc = hist.present;
  const [activeId, setActiveId] = useState(() => hist.present.layers[0].id);
  const [tool, setTool] = useState<Tool>("brush");
  const [fg, setFg] = useState("#e5484d");
  const [bg, setBg] = useState("#ffffff");
  const [size, setSize] = useState(24);
  const [hardness, setHardness] = useState(0.8);
  const [flow, setFlow] = useState(1);
  const [tolerance, setTolerance] = useState(32);
  const [contiguous, setContiguous] = useState(true);
  const [target, setTarget] = useState<"pixels" | "mask">("pixels");
  const [sel, setSelRaw] = useState<Selection | null>(null);
  // Outline shape of the current selection, so an elliptical marquee is drawn as an ellipse (TT16 screenshot finding);
  // wand/combined/inverted selections are drawn by their bounds and labelled as such.
  const [selShape, setSelShape] = useState<"rect" | "ellipse" | "region">("rect");
  const setSel = useCallback((s: Selection | null, shape: "rect" | "ellipse" | "region" = "region") => { setSelRaw(s); setSelShape(shape); }, []);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fit, setFit] = useState(1);
  const [name, setName] = useState("Untitled");
  const [path, setPath] = useState((win.props.path as string) ?? "");
  const [status, setStatus] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cursor, setCursor] = useState<{ x: number; y: number; c: number[] } | null>(null);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [guide, setGuide] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [filter, setFilter] = useState("brightness");
  const [filterVal, setFilterVal] = useState(120);
  const [busy, setBusy] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const compRef = useRef<Uint8ClampedArray | null>(null);

  const active = doc.layers.find((l) => l.id === activeId) ?? doc.layers[doc.layers.length - 1];
  const scale = zoom === "fit" ? fit : zoom;

  const commit = useCallback((next: ImageDoc, label?: string) => {
    setHist((h) => pushHistory(h, next, { maxStates: 60, maxBytes: HISTORY_BYTES, sizeOf: uniqueBufferBytes }));
    if (label) setStatus(label);
  }, []);
  const replaceDoc = useCallback((next: ImageDoc, label: string, warn: string[] = []) => {
    setHist(createHistory(next)); setActiveId(next.layers[next.layers.length - 1].id); setSel(null); setWarnings(warn); setStatus(label);
  }, [setSel]);

  /* ---------------------------------------------------------------- render composite */
  const paintAll = useCallback((d: ImageDoc) => {
    const c = canvasRef.current; if (!c) return;
    if (c.width !== d.width) c.width = d.width;
    if (c.height !== d.height) c.height = d.height;
    const ctx = c.getContext("2d", { willReadFrequently: true }); if (!ctx) return;
    const rgba = composite(d);
    compRef.current = rgba;
    ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, d.width, d.height), 0, 0);
  }, []);
  const paintRect = useCallback((d: ImageDoc, r: Rect | null) => {
    const c = canvasRef.current; if (!c || !r) return;
    const k = clipRect(r, { x: 0, y: 0, w: d.width, h: d.height }); if (!k) return;
    const ctx = c.getContext("2d", { willReadFrequently: true }); if (!ctx) return;
    ctx.putImageData(new ImageData(compositeRegion(d, k) as Uint8ClampedArray<ArrayBuffer>, k.w, k.h), k.x, k.y);
  }, []);
  useEffect(() => { paintAll(doc); }, [doc, paintAll]);

  useEffect(() => {
    const el = viewRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setFit(Math.max(0.05, Math.min(4, (r.width - 24) / doc.width, (r.height - 24) / doc.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc.width, doc.height]);

  /* ---------------------------------------------------------------- open */
  const openBytes = useCallback(async (bytes: Uint8Array, fileName: string, mime: string) => {
    setBusy("Opening…");
    try {
      if (/\.psd$/i.test(fileName) || mime === "image/vnd.adobe.photoshop" || (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53)) {
        const r = await readPsd(bytes);
        replaceDoc(r.doc, `opened ${fileName}: ${r.doc.width}×${r.doc.height}, ${r.doc.layers.length} layer(s), ${fmtBytes(bytes.length)}`, r.warnings);
      } else {
        const img = await decodeImage(new Blob([bytes as BlobPart], { type: mime || "image/png" }));
        const l = makeLayer("Background", img.w, img.h); l.data.set(img.data);
        replaceDoc({ width: img.w, height: img.h, layers: [l] }, `opened ${fileName}: ${img.w}×${img.h}, ${fmtBytes(bytes.length)}`);
      }
      setName(stem(fileName));
    } catch (e) { shell.toast(`Could not open ${fileName}: ${(e as Error).message}`, "bad"); }
    finally { setBusy(""); }
  }, [replaceDoc, shell]);

  useEffect(() => {
    if (!path) return;
    let live = true;
    api<{ node: { content: string; encoding: string; mime: string; name: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`)
      .then((r) => { if (live) void openBytes(r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content), r.node.name, r.node.mime); })
      .catch((e) => { if (live) setStatus(`Could not open ${path}: ${(e as Error).message}`); });
    return () => { live = false; };
  }, [path, openBytes]);

  /* ---------------------------------------------------------------- save / export */
  const saveToVfs = async (bytes: Uint8Array, dst: string, mime: string) => {
    if (bytes.length > 8 * 1024 * 1024) { download(new Blob([bytes as BlobPart], { type: mime }), dst.split("/").pop()!); setStatus(`${fmtBytes(bytes.length)} exceeds the 8 MB VFS cap — downloaded instead`); return false; }
    await post("/api/fs", { op: "upload", path: dst, content: b64(bytes), mime });
    shell.bumpRefresh();
    return true;
  };
  const savePsd = async () => {
    setBusy("Saving PSD…");
    try {
      const bytes = await writePsd(doc, { compression: "rle" });
      const dst = path && /\.psd$/i.test(path) ? path : `/Pictures/${stem(name)}.psd`;
      if (await saveToVfs(bytes, dst, "image/vnd.adobe.photoshop")) setStatus(`saved ${dst} (${fmtBytes(bytes.length)}, ${doc.layers.length} layers, RLE)`);
    } catch (e) { shell.toast(`PSD save failed: ${(e as Error).message}`, "bad"); }
    finally { setBusy(""); }
  };
  const exportFlat = async (type: "image/png" | "image/jpeg") => {
    setBusy("Exporting…");
    try {
      const rgba = composite(doc);
      const blob = await encodeCanvas(type === "image/jpeg" ? flattenOnto(rgba, parseHex(bg)) : rgba, doc.width, doc.height, type);
      const dst = `/Pictures/${stem(name)}.${type === "image/png" ? "png" : "jpg"}`;
      if (await saveToVfs(new Uint8Array(await blob.arrayBuffer()), dst, type)) setStatus(`exported ${dst} (${fmtBytes(blob.size)})`);
    } catch (e) { shell.toast(`Export failed: ${(e as Error).message}`, "bad"); }
    finally { setBusy(""); }
  };
  const placeFile = async (f: File) => {
    try {
      const img = await decodeImage(f);
      const l = makeLayer(stem(f.name), img.w, img.h); l.data.set(img.data);
      l.x = Math.round((doc.width - img.w) / 2); l.y = Math.round((doc.height - img.h) / 2);
      commit(addLayer(doc, l, active.id), `placed ${f.name} as a layer`); setActiveId(l.id);
    } catch (e) { shell.toast(`Place failed: ${(e as Error).message}`, "bad"); }
  };

  /* ---------------------------------------------------------------- history */
  const undo = useCallback(() => setHist((h) => undoHistory(h)), []);
  const redo = useCallback(() => setHist((h) => redoHistory(h)), []);
  // (a stale activeId — e.g. after undoing a layer's creation — falls back to the top layer via `active` above)

  /* ---------------------------------------------------------------- pointer → document coordinates */
  const toDoc = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * doc.width, y: (e.clientY - r.top) / r.height * doc.height };
  };
  const brushOpts = (mode: BrushOpts["mode"]): BrushOpts => ({ size, hardness, flow, color: parseHex(fg), mode });
  const editable = (l: Layer) => { if (l.locked) { shell.toast(`"${l.name}" is locked`, "warn"); return false; } if (!l.visible) { shell.toast(`"${l.name}" is hidden — show it to paint`, "warn"); return false; } return true; };
  const workingCopy = (l: Layer): Layer => {
    const grown = growLayerTo(l, { x: 0, y: 0, w: doc.width, h: doc.height });
    return { ...grown, data: grown === l ? new Uint8ClampedArray(l.data) : grown.data, mask: grown.mask ? (grown === l ? new Uint8ClampedArray(grown.mask) : grown.mask) : undefined };
  };
  const withLayer = (d: ImageDoc, l: Layer): ImageDoc => ({ ...d, layers: d.layers.map((x) => (x.id === l.id ? l : x)) });

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !canvasRef.current) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toDoc(e);
    if (tool === "eyedropper" || e.altKey && (tool === "brush" || tool === "fill")) {
      const rgba = compRef.current ?? composite(doc);
      const c = sampleAverage(rgba, doc.width, doc.height, p.x, p.y, 1);
      setFg(hex(c)); setStatus(`sampled ${hex(c)} at ${Math.floor(p.x)},${Math.floor(p.y)}`); return;
    }
    if (tool === "fill") {
      if (!editable(active)) return;
      const w = workingCopy(active);
      floodFill(w, p.x, p.y, parseHex(fg), { tolerance, contiguous }, sel);
      commit(withLayer(doc, w), `filled at ${Math.floor(p.x)},${Math.floor(p.y)} (tolerance ${tolerance})`); return;
    }
    if (tool === "wand") {
      const rgba = compRef.current ?? composite(doc);
      const s = magicWand(rgba, doc, p.x, p.y, tolerance, contiguous);
      const next = e.shiftKey && sel ? combineSelections(sel, s, "add") : e.altKey && sel ? combineSelections(sel, s, "subtract") : s;
      setSel(selectionEmpty(next) ? null : next); setStatus(`selection ${next.bounds.w}×${next.bounds.h}`); return;
    }
    const st: Stroke = { kind: tool, start: p, last: p, carry: -1 };
    if (tool === "brush" || tool === "eraser") {
      if (!editable(active)) return;
      let w = workingCopy(active);
      if (target === "mask" && !w.mask) w = { ...w, mask: new Uint8ClampedArray(w.w * w.h).fill(255), maskEnabled: true };
      st.working = w;
      const mode: BrushOpts["mode"] = target === "mask" ? (tool === "eraser" ? "mask-reveal" : "mask-hide") : tool === "eraser" ? "erase" : "paint";
      const r = strokeSegment(w, p, p, brushOpts(mode), -1, sel);
      st.carry = r.carry;
      paintRect(withLayer(doc, w), r.dirty);
    }
    if (tool === "move") { if (active.locked) { shell.toast(`"${active.name}" is locked`, "warn"); return; } st.base = doc; }
    strokeRef.current = st;
  };
  const onMove = (e: React.PointerEvent) => {
    const p = toDoc(e);
    const fx = Math.floor(p.x), fy = Math.floor(p.y);
    if (fx >= 0 && fy >= 0 && fx < doc.width && fy < doc.height && compRef.current) {
      const i = (fy * doc.width + fx) * 4; const c = compRef.current;
      setCursor({ x: fx, y: fy, c: [c[i], c[i + 1], c[i + 2], c[i + 3]] });
    }
    const st = strokeRef.current; if (!st) return;
    if ((st.kind === "brush" || st.kind === "eraser") && st.working) {
      const mode: BrushOpts["mode"] = target === "mask" ? (st.kind === "eraser" ? "mask-reveal" : "mask-hide") : st.kind === "eraser" ? "erase" : "paint";
      const r = strokeSegment(st.working, st.last, p, brushOpts(mode), st.carry, sel);
      st.carry = r.carry; st.last = p;
      paintRect(withLayer(doc, st.working), r.dirty);
      return;
    }
    if (st.kind === "move" && st.base) {
      const dx = Math.round(p.x - st.start.x), dy = Math.round(p.y - st.start.y);
      st.moved = dx !== 0 || dy !== 0; st.last = p;
      paintAll(withLayer(st.base, { ...active, x: active.x + dx, y: active.y + dy }));
      setDrag(null);
      return;
    }
    if (st.kind === "marquee" || st.kind === "ellipse" || st.kind === "gradient") {
      st.last = p; setDrag(normRect(st.start.x, st.start.y, p.x, p.y));
      if (st.kind === "gradient") setGuide({ x1: st.start.x, y1: st.start.y, x2: p.x, y2: p.y });
    }
  };
  const onUp = () => {
    const st = strokeRef.current; strokeRef.current = null; setDrag(null); setGuide(null);
    if (!st) return;
    if ((st.kind === "brush" || st.kind === "eraser") && st.working) { commit(withLayer(doc, st.working), `${st.kind === "brush" ? "painted" : "erased"} on ${active.name}${target === "mask" ? " (mask)" : ""}`); return; }
    if (st.kind === "move" && st.base && st.moved) {
      const dx = Math.round(st.last.x - st.start.x), dy = Math.round(st.last.y - st.start.y);
      commit(patchLayer(st.base, active.id, { x: active.x + dx, y: active.y + dy }), `moved ${active.name} by ${dx},${dy}`); return;
    }
    if (st.kind === "marquee" || st.kind === "ellipse") {
      const r = normRect(st.start.x, st.start.y, st.last.x, st.last.y);
      if (Math.hypot(st.last.x - st.start.x, st.last.y - st.start.y) < 2) { setSel(null); setStatus("deselected"); return; }
      const s = st.kind === "marquee" ? selectRect(doc, r) : selectEllipse(doc, r);
      setSel(selectionEmpty(s) ? null : s, st.kind === "marquee" ? "rect" : "ellipse"); setStatus(`selection ${s.bounds.w}×${s.bounds.h}`); return;
    }
    if (st.kind === "gradient") {
      if (!editable(active)) return;
      const w = workingCopy(active);
      const a = parseHex(fg), b = parseHex(bg);
      linearGradient(w, st.start, st.last, [a[0], a[1], a[2], 255], [b[0], b[1], b[2], 255], sel);
      commit(withLayer(doc, w), "gradient applied");
    }
  };

  /* ---------------------------------------------------------------- layer + image commands */
  const L = {
    add: () => { const l = makeLayer(`Layer ${doc.layers.length + 1}`, doc.width, doc.height); commit(addLayer(doc, l, active.id), "new layer"); setActiveId(l.id); },
    dup: () => { const r = duplicateLayer(doc, active.id); commit(r.doc, "duplicated layer"); setActiveId(r.id); },
    del: () => { try { commit(removeLayer(doc, active.id), `deleted ${active.name}`); } catch (e) { shell.toast((e as Error).message, "warn"); } },
    up: () => commit(reorderLayer(doc, active.id, 1)),
    down: () => commit(reorderLayer(doc, active.id, -1)),
    merge: () => {
      try {
        if (mergeChangesAppearance(doc, active.id) && !confirm("Merging these layers changes how the image looks (blend mode/opacity of the layers involved). Merge anyway?")) return;
        commit(mergeDown(doc, active.id), "merged down");
      } catch (e) { shell.toast((e as Error).message, "warn"); }
    },
    flatten: () => commit(flatten(doc), "flattened"),
    patch: (patch: Partial<Layer>) => commit(patchLayer(doc, active.id, patch)),
    addMask: () => commit(patchLayer(doc, active.id, { mask: sel ? layerMaskFromSelection(active, sel) : new Uint8ClampedArray(active.w * active.h).fill(255), maskEnabled: true }), sel ? "mask from selection" : "mask added (reveal all)"),
    applyMask: () => {
      if (!active.mask) return;
      const data = new Uint8ClampedArray(active.data);
      if (active.maskEnabled !== false) for (let i = 0; i < active.w * active.h; i++) data[i * 4 + 3] = Math.round(data[i * 4 + 3] * active.mask[i] / 255);
      commit(patchLayer(doc, active.id, { data, mask: undefined, maskEnabled: undefined }), "mask applied"); setTarget("pixels");
    },
    dropMask: () => { commit(patchLayer(doc, active.id, { mask: undefined, maskEnabled: undefined }), "mask deleted"); setTarget("pixels"); },
    viaCopy: (cut: boolean) => {
      if (!sel) { shell.toast("Make a selection first", "warn"); return; }
      const piece = copySelection(active, sel); if (!piece) return;
      const l: Layer = { ...makeLayer(`${active.name} ${cut ? "cut" : "copy"}`, piece.w, piece.h), x: piece.x, y: piece.y, data: piece.data };
      let next = doc;
      if (cut) { const w = workingCopy(active); clearSelection(w, sel); next = withLayer(doc, w); }
      commit(addLayer(next, l, active.id), cut ? "layer via cut" : "layer via copy"); setActiveId(l.id);
    },
    clear: () => { if (!sel || !editable(active)) return; const w = workingCopy(active); clearSelection(w, sel); commit(withLayer(doc, w), "cleared selection"); },
    fillSel: () => {
      if (!sel || !editable(active)) return;
      const w = workingCopy(active); const c = parseHex(fg);
      linearGradient(w, { x: 0, y: 0 }, { x: 1, y: 0 }, [c[0], c[1], c[2], 255], [c[0], c[1], c[2], 255], sel);
      commit(withLayer(doc, w), "filled selection");
    },
  };
  const applyLayerFilter = () => {
    if (!editable(active)) return;
    setBusy("Filtering…");
    setTimeout(() => {
      try {
        const out = applyFilter({ width: active.w, height: active.h, data: active.data }, filter, filterVal);
        const data = out.data;
        if (sel) { // blend filtered result through the selection
          for (let y = 0; y < active.h; y++) for (let x = 0; x < active.w; x++) {
            const X = x + active.x, Y = y + active.y;
            const s = X >= 0 && Y >= 0 && X < sel.width && Y < sel.height ? sel.mask[Y * sel.width + X] / 255 : 0;
            const i = (y * active.w + x) * 4;
            for (let c = 0; c < 4; c++) data[i + c] = Math.round(active.data[i + c] + (data[i + c] - active.data[i + c]) * s);
          }
        }
        commit(patchLayer(doc, active.id, { data }), `${FILTERS.find((f) => f.id === filter)?.label} applied to ${active.name}${sel ? " (selection)" : ""}`);
      } catch (e) { shell.toast(`Filter failed: ${(e as Error).message}`, "bad"); }
      finally { setBusy(""); }
    }, 10);
  };
  const image = {
    crop: () => { if (!sel) { shell.toast("Select the area to keep first", "warn"); return; } commit(cropCanvas(doc, sel.bounds), `cropped to ${sel.bounds.w}×${sel.bounds.h}`); setSel(null); },
    rotate: (t: number) => { commit(rotateDoc(doc, t), `rotated ${t * 90}°`); setSel(null); },
    flip: (axis: "horizontal" | "vertical", layerOnly: boolean) => commit(flipDoc(doc, axis, layerOnly ? active.id : undefined), `flipped ${layerOnly ? "layer" : "image"} ${axis}`),
    resize: () => {
      const v = prompt("New image size (W×H), aspect not locked", `${doc.width}x${doc.height}`); if (!v) return;
      const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(v.trim()); if (!m) return;
      try { commit(resizeImage(doc, Number(m[1]), Number(m[2])), `resized to ${m[1]}×${m[2]}`); setSel(null); } catch (e) { shell.toast((e as Error).message, "bad"); }
    },
    canvas: () => {
      const v = prompt("Canvas size (W×H), centred", `${doc.width}x${doc.height}`); if (!v) return;
      const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(v.trim()); if (!m) return;
      try { commit(resizeCanvas(doc, Number(m[1]), Number(m[2])), `canvas ${m[1]}×${m[2]}`); setSel(null); } catch (e) { shell.toast((e as Error).message, "bad"); }
    },
    newDoc: () => {
      const v = prompt("New image (W×H)", "1024x768"); if (!v) return;
      const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(v.trim()); if (!m) return;
      try { replaceDoc(newDoc(Number(m[1]), Number(m[2])), `new ${m[1]}×${m[2]}`); setName("Untitled"); setPath(""); } catch (e) { shell.toast((e as Error).message, "bad"); }
    },
  };

  /* ---------------------------------------------------------------- keyboard (scoped to the module) */
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && k === "z") { handled(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === "y") { handled(); redo(); return; }
    if (mod && k === "a") { handled(); setSel(selectAll(doc), "rect"); return; }
    if (mod && k === "d") { handled(); setSel(null); return; }
    if (mod && e.shiftKey && k === "i") { handled(); if (sel) setSel(invertSelection(sel)); return; }
    if (mod && k === "j") { handled(); if (sel) L.viaCopy(false); else L.dup(); return; }
    if (mod && k === "e") { handled(); L.merge(); return; }
    if (mod && e.shiftKey && k === "n") { handled(); L.add(); return; }
    if (mod) return;
    if (k === "delete" || k === "backspace") { handled(); L.clear(); return; }
    if (k === "[") { handled(); setSize((s) => Math.max(1, Math.round(s / 1.25))); return; }
    if (k === "]") { handled(); setSize((s) => Math.min(500, Math.round(s * 1.25))); return; }
    if (k === "x") { handled(); setFg(bg); setBg(fg); return; }
    if (k === "d") { handled(); setFg("#000000"); setBg("#ffffff"); return; }
    const tl = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (tl) { handled(); setTool(tl.id); }
  };

  const hist256 = useMemo(() => {
    const bins = new Array<number>(64).fill(0);
    const c = composite(doc);
    const step = Math.max(1, Math.floor(c.length / 4 / 200_000));
    for (let i = 0; i < c.length; i += 4 * step) if (c[i + 3]) bins[Math.min(63, (0.2126 * c[i] + 0.7152 * c[i + 1] + 0.0722 * c[i + 2]) >> 2)]++;
    const max = Math.max(1, ...bins);
    return bins.map((b) => b / max);
  }, [doc]);

  const selBox = drag ?? sel?.bounds ?? null;
  const filterDef = FILTERS.find((f) => f.id === filter);

  return (
    <div data-testid="image-studio" data-doc-w={doc.width} data-doc-h={doc.height} data-layers={doc.layers.length} data-active={active.name} data-tool={tool} data-undo={hist.past.length} data-selection={sel ? `${sel.bounds.x},${sel.bounds.y},${sel.bounds.w},${sel.bounds.h}` : ""}
      tabIndex={0} onKeyDown={onKey} style={{ display: "grid", gridTemplateColumns: `${fz(46)} minmax(0, 1fr) min(${fz(230)}, 34%)`, gridTemplateRows: "auto 1fr auto", height: "100%", minHeight: 0, outline: "none" }}>
      {/* top bar */}
      <div className="fs-row" style={{ gridColumn: "1 / 4", gap: 4, padding: 6, flexWrap: "wrap", borderBottom: "1px solid var(--fs-border)" }}>
        <Btn variant="ghost" onClick={image.newDoc}>New</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Open…<input aria-label="Open image or PSD" type="file" accept="image/*,.psd" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.arrayBuffer().then((b) => openBytes(new Uint8Array(b), f.name, f.type)); e.target.value = ""; }} /></label>
        <Btn variant="ghost" onClick={() => { const p = prompt("VFS path (PNG/JPEG/WebP/GIF/PSD)", "/Pictures/"); if (p) setPath(p); }}>Open from Files…</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Place…<input aria-label="Place image as layer" type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void placeFile(f); e.target.value = ""; }} /></label>
        <Btn variant="primary" onClick={() => void savePsd()} disabled={!!busy}>Save PSD</Btn>
        <Btn variant="ghost" onClick={() => void exportFlat("image/png")} disabled={!!busy}>Export PNG</Btn>
        <Btn variant="ghost" onClick={() => void exportFlat("image/jpeg")} disabled={!!busy}>Export JPEG</Btn>
        <span style={{ width: 8 }} />
        <Btn variant="ghost" onClick={undo} disabled={!hist.past.length} title="Undo (Ctrl+Z)">Undo</Btn>
        <Btn variant="ghost" onClick={redo} disabled={!hist.future.length} title="Redo (Ctrl+Shift+Z)">Redo</Btn>
        <select className="fs-input" aria-label="Zoom" value={String(zoom)} onChange={(e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value))} style={{ width: 90 }}>
          <option value="fit">Fit</option>{[0.25, 0.5, 1, 2, 4, 8].map((z) => <option key={z} value={z}>{z * 100}%</option>)}
        </select>
        <input className="fs-input" aria-label="Document name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />
        {busy ? <Badge tone="info">{busy}</Badge> : null}
        {warnings.length ? <Badge tone="warn" title={warnings.join("\n")}>{warnings.length} import note(s)</Badge> : null}
      </div>

      {/* tool rail */}
      <div role="toolbar" aria-label="Tools" style={{ display: "grid", alignContent: "start", gap: 2, padding: 3, borderRight: "1px solid var(--fs-border)" }}>
        {TOOLS.map((t) => (
          <button key={t.id} className="fs-btn" data-variant={tool === t.id ? "primary" : "ghost"} aria-pressed={tool === t.id} title={`${t.label}${t.key ? ` (${t.key})` : ""}`} aria-label={t.label}
            onClick={() => setTool(t.id)} style={{ padding: "4px 2px", fontSize: fz(10), lineHeight: 1.15, whiteSpace: "normal", textAlign: "center" }}>{t.label}</button>
        ))}
        <div title="Foreground / background (X swaps, D resets)" style={{ display: "grid", gap: 2, marginTop: 6 }}>
          <input type="color" aria-label="Foreground colour" value={fg} onChange={(e) => setFg(e.target.value)} style={{ width: "100%", height: 26 }} />
          <input type="color" aria-label="Background colour" value={bg} onChange={(e) => setBg(e.target.value)} style={{ width: "100%", height: 18 }} />
        </div>
      </div>

      {/* canvas */}
      <div ref={viewRef} className="fs-scroll" style={{ position: "relative", minHeight: 0, background: "#060a14", display: "grid", placeItems: "center", padding: 12 }}>
        <div style={{ position: "relative", width: doc.width * scale, height: doc.height * scale, boxShadow: "0 0 0 1px #334" }}>
          <canvas ref={canvasRef} data-testid="studio-canvas" aria-label={`Canvas ${doc.width}×${doc.height}`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setCursor(null)}
            style={{ width: "100%", height: "100%", display: "block", touchAction: "none", imageRendering: scale >= 2 ? "pixelated" : "auto", cursor: tool === "move" ? "move" : "crosshair",
              backgroundImage: "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)", backgroundSize: "16px 16px", backgroundPosition: "0 0,0 8px,8px -8px,-8px 0", backgroundColor: "#fff" }} />
          {selBox && selBox.w > 0 ? (
            <svg data-testid="selection-box" aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} viewBox={`0 0 ${doc.width} ${doc.height}`} preserveAspectRatio="none">
              {(drag ? tool === "ellipse" : selShape === "ellipse")
                ? <ellipse cx={selBox.x + selBox.w / 2} cy={selBox.y + selBox.h / 2} rx={selBox.w / 2} ry={selBox.h / 2} fill="none" stroke="#000" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
                : guide
                  ? <line x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2} stroke="#000" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
                  : <rect x={selBox.x} y={selBox.y} width={selBox.w} height={selBox.h} fill="none" stroke="#000" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
              <rect x={selBox.x} y={selBox.y} width={selBox.w} height={selBox.h} fill="none" stroke="#fff" strokeDasharray="4 4" strokeDashoffset={4} vectorEffect="non-scaling-stroke" />
            </svg>
          ) : null}
        </div>
      </div>

      {/* right panel */}
      <aside className="fs-scroll" style={{ borderLeft: "1px solid var(--fs-border)", padding: 6, display: "grid", alignContent: "start", gap: 8, fontSize: fz(11) }}>
        <Panel title={`${TOOLS.find((t) => t.id === tool)?.label} options`}>
          {(tool === "brush" || tool === "eraser") ? <>
            <Range label="Size" value={size} min={1} max={300} onChange={setSize} />
            <Range label="Hardness" value={Math.round(hardness * 100)} min={0} max={100} onChange={(v) => setHardness(v / 100)} />
            <Range label="Flow" value={Math.round(flow * 100)} min={1} max={100} onChange={(v) => setFlow(v / 100)} />
            <div className="fs-row" style={{ gap: 4 }}>Paint on
              <Btn variant={target === "pixels" ? "primary" : "ghost"} onClick={() => setTarget("pixels")}>Pixels</Btn>
              <Btn variant={target === "mask" ? "primary" : "ghost"} onClick={() => setTarget("mask")} title="Brush hides, eraser reveals">Mask</Btn>
            </div>
          </> : null}
          {(tool === "fill" || tool === "wand") ? <>
            <Range label="Tolerance" value={tolerance} min={0} max={255} onChange={setTolerance} />
            <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.target.checked)} aria-label="Contiguous" />Contiguous</label>
          </> : null}
          {tool === "wand" || tool === "marquee" || tool === "ellipse" ? <div className="fs-dim">Shift-click adds (wand), Alt-click subtracts. Ctrl+A all · Ctrl+D none · Ctrl+Shift+I invert.</div> : null}
          {tool === "gradient" ? <div className="fs-dim">Drag: foreground → background colour, linear, through the selection.</div> : null}
          {tool === "move" ? <div className="fs-dim">Drag to move the active layer (integer pixels).</div> : null}
          {tool === "eyedropper" ? <div className="fs-dim">Click to sample the merged image into the foreground colour (Alt-click with brush/bucket too).</div> : null}
          <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={() => setSel(selectAll(doc), "rect")}>All</Btn>
            <Btn variant="ghost" onClick={() => setSel(null)} disabled={!sel}>None</Btn>
            <Btn variant="ghost" onClick={() => sel && setSel(invertSelection(sel))} disabled={!sel}>Invert</Btn>
            <Btn variant="ghost" onClick={L.clear} disabled={!sel}>Clear</Btn>
            <Btn variant="ghost" onClick={L.fillSel} disabled={!sel}>Fill</Btn>
          </div>
        </Panel>

        <Panel title={`Layers (${doc.layers.length})`}>
          <div className="fs-row" style={{ gap: 4 }}>
            <select className="fs-input" aria-label="Blend mode" value={active.blend} onChange={(e) => L.patch({ blend: e.target.value as BlendMode })} style={{ flex: 1 }}>
              {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <Range label="Opacity" value={Math.round(active.opacity * 100)} min={0} max={100} onChange={(v) => L.patch({ opacity: v / 100 })} aria="Layer opacity" />
          <div role="group" aria-label="Layers" style={{ display: "grid", gap: 2 }}>
            {[...doc.layers].reverse().map((l) => (
              <div key={l.id} data-testid="layer-row" data-name={l.name} data-active={l.id === active.id} onClick={() => setActiveId(l.id)}
                className="fs-row" style={{ gap: 4, padding: "3px 4px", borderRadius: 4, cursor: "pointer", background: l.id === active.id ? "var(--fs-accent-soft, rgba(91,140,255,.25))" : "transparent" }}>
                <input type="checkbox" checked={l.visible} aria-label={`Visible ${l.name}`} onClick={(e) => e.stopPropagation()} onChange={(e) => commit(patchLayer(doc, l.id, { visible: e.target.checked }))} />
                <Thumb layer={l} doc={doc} />
                <button type="button" aria-pressed={l.id === active.id} title="Select layer (double-click to rename)"
                  onClick={(e) => { e.stopPropagation(); setActiveId(l.id); }}
                  style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: 0, color: "inherit", font: "inherit", padding: 0, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  onDoubleClick={() => { const n = prompt("Layer name", l.name); if (n) commit(patchLayer(doc, l.id, { name: n.slice(0, 255) })); }}>{l.name}</button>
                {l.mask ? <Badge tone={l.maskEnabled === false ? "default" : "info"}>mask</Badge> : null}
                {l.locked ? <Badge tone="warn">lock</Badge> : null}
                <span className="fs-dim">{l.blend === "normal" ? "" : l.blend.slice(0, 5)} {Math.round(l.opacity * 100)}%</span>
              </div>
            ))}
          </div>
          <div className="fs-row" style={{ gap: 3, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={L.add} title="Ctrl+Shift+N">New</Btn>
            <Btn variant="ghost" onClick={L.dup} title="Ctrl+J">Duplicate</Btn>
            <Btn variant="ghost" onClick={L.del}>Delete</Btn>
            <Btn variant="ghost" onClick={L.up}>Up</Btn>
            <Btn variant="ghost" onClick={L.down}>Down</Btn>
            <Btn variant="ghost" onClick={L.merge} title="Ctrl+E">Merge down</Btn>
            <Btn variant="ghost" onClick={L.flatten}>Flatten</Btn>
            <Btn variant="ghost" onClick={() => L.patch({ locked: !active.locked })}>{active.locked ? "Unlock" : "Lock"}</Btn>
            <Btn variant="ghost" onClick={() => L.viaCopy(false)} disabled={!sel}>Layer via copy</Btn>
            <Btn variant="ghost" onClick={() => L.viaCopy(true)} disabled={!sel}>Layer via cut</Btn>
          </div>
          <div className="fs-row" style={{ gap: 3, flexWrap: "wrap" }}>
            {!active.mask ? <Btn variant="ghost" onClick={L.addMask}>Add mask{sel ? " from selection" : ""}</Btn> : <>
              <Btn variant="ghost" onClick={() => L.patch({ maskEnabled: active.maskEnabled === false })}>{active.maskEnabled === false ? "Enable mask" : "Disable mask"}</Btn>
              <Btn variant="ghost" onClick={L.applyMask}>Apply mask</Btn>
              <Btn variant="ghost" onClick={L.dropMask}>Delete mask</Btn>
            </>}
          </div>
        </Panel>

        <Panel title="Adjust active layer">
          <select className="fs-input" aria-label="Filter" value={filter} onChange={(e) => { setFilter(e.target.value); const d = FILTERS.find((f) => f.id === e.target.value)?.param?.def; if (d !== undefined) setFilterVal(d); }}>
            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          {filterDef?.param ? <Range label={filterDef.param.label || "Amount"} value={filterVal} min={filterDef.param.min} max={filterDef.param.max} onChange={setFilterVal} aria="Filter amount" /> : null}
          <Btn variant="primary" onClick={applyLayerFilter} disabled={!!busy}>Apply{sel ? " to selection" : ""}</Btn>
        </Panel>

        <Panel title="Image">
          <div className="fs-row" style={{ gap: 3, flexWrap: "wrap" }}>
            <Btn variant="ghost" onClick={image.crop} disabled={!sel}>Crop to selection</Btn>
            <Btn variant="ghost" onClick={() => image.rotate(1)}>Rotate 90° CW</Btn>
            <Btn variant="ghost" onClick={() => image.rotate(3)}>Rotate 90° CCW</Btn>
            <Btn variant="ghost" onClick={() => image.rotate(2)}>Rotate 180°</Btn>
            <Btn variant="ghost" onClick={() => image.flip("horizontal", false)}>Flip image H</Btn>
            <Btn variant="ghost" onClick={() => image.flip("vertical", false)}>Flip image V</Btn>
            <Btn variant="ghost" onClick={() => image.flip("horizontal", true)}>Flip layer H</Btn>
            <Btn variant="ghost" onClick={image.resize}>Image size…</Btn>
            <Btn variant="ghost" onClick={image.canvas}>Canvas size…</Btn>
          </div>
          <svg aria-label="Luminance histogram" viewBox="0 0 64 20" preserveAspectRatio="none" style={{ width: "100%", height: 40, background: "#0b1222", borderRadius: 3 }}>
            {hist256.map((v, i) => <rect key={i} x={i} y={20 - v * 20} width={1} height={v * 20} fill="#8aa4ff" />)}
          </svg>
        </Panel>
      </aside>

      {/* status bar */}
      <div data-testid="studio-status" className="fs-row fs-dim" style={{ gridColumn: "1 / 4", gap: 12, padding: "3px 8px", borderTop: "1px solid var(--fs-border)", fontSize: fz(10.5) }}>
        <span>{doc.width}×{doc.height}</span><span>{Math.round(scale * 100)}%</span>
        <span>{cursor ? `x ${cursor.x} y ${cursor.y} · rgba(${cursor.c.join(",")})` : "—"}</span>
        <span>{sel ? `selection ${sel.bounds.w}×${sel.bounds.h}${selShape === "region" ? " (region, outline shows bounds)" : ""}` : "no selection"}</span>
        <span>history {hist.past.length}/{hist.past.length + hist.future.length}</span>
        <span style={{ marginLeft: "auto" }} data-testid="studio-message">{status}</span>
      </div>
    </div>
  );
}

function layerMaskFromSelection(l: Layer, sel: Selection): Uint8ClampedArray {
  const m = new Uint8ClampedArray(l.w * l.h);
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) {
    const X = x + l.x, Y = y + l.y;
    m[y * l.w + x] = X >= 0 && Y >= 0 && X < sel.width && Y < sel.height ? sel.mask[Y * sel.width + X] : 0;
  }
  return m;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="fs-panel" style={{ padding: 6, display: "grid", gap: 5 }}><strong style={{ fontSize: fz(11) }}>{title}</strong>{children}</section>;
}
function Range({ label, value, min, max, onChange, aria }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void; aria?: string }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: `${fz(62)} minmax(0, 1fr) ${fz(34)}`, gap: 4, alignItems: "center" }}>{label}
      <input type="range" aria-label={aria ?? label} min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="fs-mono">{value}</span>
    </label>
  );
}
/** 28×20 thumbnail of a layer drawn into a tiny canvas (effect-driven, no refs read during render). */
function Thumb({ layer, doc }: { layer: Layer; doc: ImageDoc }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const tw = 28, th = 20, s = Math.min(tw / doc.width, th / doc.height);
    const img = new ImageData(tw, th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const X = Math.floor(x / s) - layer.x, Y = Math.floor(y / s) - layer.y;
      if (X < 0 || Y < 0 || X >= layer.w || Y >= layer.h) continue;
      const i = (Y * layer.w + X) * 4, o = (y * tw + x) * 4;
      img.data[o] = layer.data[i]; img.data[o + 1] = layer.data[i + 1]; img.data[o + 2] = layer.data[i + 2]; img.data[o + 3] = layer.data[i + 3];
    }
    ctx.clearRect(0, 0, tw, th); ctx.putImageData(img, 0, 0);
  }, [layer, doc.width, doc.height]);
  return <canvas ref={ref} width={28} height={20} aria-hidden style={{ background: "#ddd", borderRadius: 2, flex: "none" }} />;
}
