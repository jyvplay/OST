"use client";
/**
 * TT51 — Slides: a lossless editor for real PowerPoint (.pptx) files (FF-23).
 * The deck is the original package (src/lib/office/pml.ts): edits change only the parts they touch and every other
 * part is written back byte-for-byte. What it shows is resolved through PowerPoint's inheritance (pmlview.ts) and
 * drawn by slides/render.tsx. Legacy .fdeck outlines open by converting to a real deck; password-protected decks
 * decrypt on this device and save encrypted again (same machinery as Writer).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fz } from "@/lib/uiscale";
import { api, post } from "@/lib/api";
import { toB64, fromB64 } from "@/lib/crypto";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import { askPassword, isEncryptedOffice, lockedProtection, saveBlocked, sealPackage, unlockOffice, type Protection } from "@/lib/office/unlock";
import * as M from "@/lib/office/pml";
import { slideView, type VSlide } from "@/lib/office/pmlview";
import { SlideCanvas } from "./slides/render";

const MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SHAPES: [M.NewShapeKind, string][] = [["rect", "Rectangle"], ["roundRect", "Rounded rectangle"], ["ellipse", "Oval"], ["triangle", "Triangle"], ["rightArrow", "Arrow"], ["diamond", "Diamond"], ["star5", "Star"], ["line", "Line"]];
const SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 54, 60, 72, 96];
type Drag = { kind: "move" | "nw" | "ne" | "sw" | "se"; addr: string; x0: number; y0: number; f: M.Xfrm; dx: number; dy: number };
const views = new WeakMap<M.PSlide, VSlide>();
const viewOf = (d: M.PptxDoc, s: M.PSlide) => { let v = views.get(s); if (!v) { v = slideView(d, s); views.set(s, v); } return v; };
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
const fromEditor = (s: string) => s.replace(/\u2028/g, "\n").split("\n");

export default function SlidesModule({ win }: ModuleProps) {
  const shell = useShell();
  const [path, setPath] = useState<string>((win.props.path as string) ?? "");
  const docRef = useRef<M.PptxDoc | null>(null);
  const encRef = useRef<Protection | null>(null);
  const undo = useRef<M.Snapshot[]>([]); const redo = useRef<M.Snapshot[]>([]);
  const [ver, setVer] = useState(0); const bump = () => setVer((v) => v + 1);
  const [cur, setCur] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ addr: string; cell?: string; text: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pop, setPop] = useState<null | "saveas">(null); const [popVal, setPopVal] = useState("");
  const [present, setPresent] = useState<number | null>(null);
  const [stageW, setStageW] = useState(720);
  const stageRef = useRef<HTMLDivElement>(null); const taRef = useRef<HTMLTextAreaElement>(null); const rootRef = useRef<HTMLDivElement>(null);
  const [notesEdit, setNotesEdit] = useState<{ k: string; t: string } | null>(null);
  const [doc, setDoc] = useState<M.PptxDoc | null>(null); // same object as docRef (mutated in place; `ver` re-renders)
  const [hist, setHist] = useState({ u: 0, r: 0 });
  const syncHist = () => setHist({ u: undo.current.length, r: redo.current.length });
  const slide = doc?.slides[cur];
  const view = useMemo(() => (doc && slide ? viewOf(doc, slide) : null), [doc, slide, ver]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ mutation plumbing */
  const mutate = useCallback((what: string, fn: (d: M.PptxDoc) => void) => {
    const d = docRef.current; if (!d) return;
    const snap = M.snapshot(d);
    try { fn(d); } catch (e) { M.restore(d, snap); shell.toast(`${what} failed: ${(e as Error).message}`, "bad"); return; }
    undo.current.push(snap); if (undo.current.length > 200) undo.current.shift(); redo.current = [];
    setDirty(true); bump(); syncHist();
  }, [shell]);
  const doUndo = () => { const d = docRef.current; const s = undo.current.pop(); if (!d || !s) return; redo.current.push(M.snapshot(d)); M.restore(d, s); setSel(null); setEdit(null); setCur((c) => Math.min(c, d.slides.length - 1)); setDirty(true); bump(); syncHist(); };
  const doRedo = () => { const d = docRef.current; const s = redo.current.pop(); if (!d || !s) return; undo.current.push(M.snapshot(d)); M.restore(d, s); setSel(null); setEdit(null); setCur((c) => Math.min(c, d.slides.length - 1)); setDirty(true); bump(); syncHist(); };

  /* ------------------------------------------------------------ load / save */
  const loadBytes = useCallback(async (bytes: Uint8Array, name: string, srcPath = "") => {
    let enc = "";
    if (isEncryptedOffice(bytes)) {
      encRef.current = lockedProtection(srcPath); // a cancelled unlock must never save plaintext over the original
      const u = await unlockOffice(bytes, name);
      if (!u) throw new Error("it is password-protected and no password was entered");
      encRef.current = { ...encRef.current, password: u.password }; bytes = u.bytes;
      enc = ` · password-protected (${u.method}${u.integrity === "verified" ? ", integrity verified" : ""}) — saves stay encrypted`;
    } else encRef.current = null;
    setLocked(!!encRef.current?.password);
    const d = await M.readPptxDoc(bytes, name);
    docRef.current = d; setDoc(d); undo.current = []; redo.current = []; syncHist(); setCur(0); setSel(null); setEdit(null);
    setStatus(`Opened ${name} · ${d.slides.length} slide${d.slides.length === 1 ? "" : "s"} · lossless engine${d.warnings.length ? ` · ${d.warnings.length} warning(s): ${d.warnings[0]}` : ""}${enc}`);
    setLoaded(true); setDirty(false); bump();
  }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const low = path.toLowerCase();
        if (low.endsWith(".pptx")) {
          const r = await api<{ node: { content: string; encoding?: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
          const bytes = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
          if (live) await loadBytes(bytes, path.split("/").pop() ?? "Presentation.pptx", path);
          return;
        }
        if (low.endsWith(".fdeck")) {
          // legacy outline format (TT≤50): { title, slides:[{title, body[], notes}] } → a real deck
          const r = await api<{ node: { content: string; encoding?: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
          const m = JSON.parse(r.node.encoding === "base64" ? new TextDecoder().decode(fromB64(r.node.content)) : r.node.content) as { title?: string; slides?: { title?: string; body?: string[]; notes?: string }[] };
          const bytes = await M.pptxFromOutline(m.title || "Presentation", (m.slides ?? []).map((s) => ({ title: s.title ?? "", body: s.body ?? [], notes: s.notes ?? "" })));
          if (!live) return; await loadBytes(bytes, `${m.title || "Presentation"}.pptx`);
          setStatus("Opened legacy .fdeck (converted to a real PowerPoint deck) — Save writes a .pptx alongside it"); setDirty(true);
          return;
        }
        const bytes = await M.blankPptx(path ? path.split("/").pop()!.replace(/\.[^.]+$/, "") : "Untitled presentation");
        if (!live) return; await loadBytes(bytes, "Untitled presentation.pptx");
        const d = docRef.current!; const k = M.shapeKids(M.spTreeOf(d.slides[0].xml));
        k.forEach((e, i) => { const ph = M.phOf(e); if (ph?.type === "ctrTitle") M.setShapeText(d, 0, String(i), ["Untitled presentation"]); else if (ph?.type === "subTitle") M.setShapeText(d, 0, String(i), ["Click Present to show · double-click any text to edit"]); });
        setStatus("New presentation (16:9) — Save writes a real .pptx"); bump();
      } catch (e) {
        shell.toast(`Could not open presentation: ${String((e as Error).message)}`, "bad");
        const bytes = await M.blankPptx(); await loadBytes(bytes, "Untitled presentation.pptx");
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveTo = useCallback(async (dest: string) => {
    const d = docRef.current; if (!d) return; const prot = encRef.current;
    if (saveBlocked(prot, dest)) { setStatus("Not saved — this password-protected file was not unlocked; the original is unchanged"); return; }
    const plain = await M.writePptxDoc(d);
    if (prot?.password) { setStatus("Encrypting…"); await new Promise((r) => setTimeout(r, 30)); }
    let bytes: Uint8Array; let sealed = false;
    try { const r = sealPackage(plain, prot); bytes = r.bytes; sealed = r.encrypted; } catch (e) { shell.toast(`Not saved: ${(e as Error).message}`, "bad"); return; }
    const replaceEncrypted = !!(prot?.removed && dest === prot.path);
    try { await post("/api/fs", { op: "upload", path: dest, content: toB64(bytes), mime: MIME_PPTX, replaceEncrypted }); } catch (e) { shell.toast(`Not saved: ${(e as Error).message}`, "bad"); return; }
    if (prot?.removed) { encRef.current = null; setLocked(false); } else if (prot && sealed) prot.path = dest;
    setDirty(false); setStatus(`Saved ${dest} (${(bytes.length / 1024).toFixed(1)} KB, lossless${sealed ? ", encrypted with your password — AES-256" : replaceEncrypted ? ", password removed" : ""})`); shell.bumpRefresh();
    if (dest !== path) { setPath(dest); shell.dispatch({ t: "setProps", id: win.id, props: { path: dest, title: dest.split("/").pop() } }); }
  }, [path, shell, win.id]);
  const save = useCallback(() => {
    if (!docRef.current) return;
    if (path.toLowerCase().endsWith(".pptx")) { void saveTo(path); return; }
    setPopVal(path ? path.replace(/\.[^./]+$/, ".pptx") : `/Documents/${(docRef.current.title || "Presentation").replace(/[\\/:*?"<>|]/g, "").trim() || "Presentation"}.pptx`); setPop("saveas");
  }, [path, saveTo]);
  const download = async () => {
    const d = docRef.current; if (!d) return;
    if (saveBlocked(encRef.current, encRef.current?.path ?? "")) { setStatus("Not downloaded — the password-protected file was not unlocked"); return; }
    let bytes: Uint8Array; try { bytes = sealPackage(await M.writePptxDoc(d), encRef.current).bytes; } catch (e) { shell.toast(`Not downloaded: ${(e as Error).message}`, "bad"); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME_PPTX }));
    a.download = (path.split("/").pop() || `${d.title || "Presentation"}.pptx`).replace(/\.fdeck$/i, ".pptx"); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const openLocal = async (f: File) => {
    if (f.size > M.MAX_PPTX) { shell.toast("The file exceeds the 64 MiB guard", "warn"); return; }
    try { await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name); setPath(""); } catch (e) { shell.toast(`Could not open ${f.name}: ${(e as Error).message}`, "bad"); }
  };

  /* ------------------------------------------------------------ stage size */
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (!doc) return; const ar = doc.size.cy / doc.size.cx; setStageW(Math.max(240, Math.min(r.width - 32, (r.height - 24) / ar))); });
    ro.observe(el); return () => ro.disconnect();
  }, [doc, loaded]);
  const scale = doc ? stageW / doc.size.cx : 1;

  /* ------------------------------------------------------------ text editing */
  const beginEdit = (addr: string, cell?: string) => {
    const d = docRef.current; const sl = d?.slides[cur]; if (!d || !sl) return; const a = cell ? `${addr}#${cell}` : addr;
    const ps = M.shapeParagraphs(sl.xml, a); setSel(addr); setEdit({ addr, cell, text: ps.map((p) => p.replace(/\v/g, "\u2028")).join("\n") });
    setTimeout(() => taRef.current?.focus(), 0);
  };
  const commitEdit = useCallback((keep = false) => {
    const e = edit; const d = docRef.current; if (!e || !d) return;
    const a = e.cell ? `${e.addr}#${e.cell}` : e.addr; const now = M.shapeParagraphs(d.slides[cur].xml, a).map((p) => p.replace(/\v/g, "\u2028")).join("\n");
    if (now !== e.text) mutate("Edit text", (dd) => M.setShapeText(dd, cur, a, fromEditor(e.text)));
    if (!keep) setEdit(null);
  }, [edit, cur, mutate]);
  /** character formatting: the textarea selection while editing, else the whole selected shape */
  const fmt = (f: M.RunFmt) => {
    const d = docRef.current; if (!d || !sel) return;
    if (edit) {
      const ta = taRef.current; const a = edit.cell ? `${edit.addr}#${edit.cell}` : edit.addr;
      const text = edit.text; const s0 = ta?.selectionStart ?? 0, s1 = ta?.selectionEnd ?? 0;
      const pos = (o: number): M.TextPos => { const before = text.slice(0, o).split("\n"); return { p: before.length - 1, o: before[before.length - 1].length }; };
      mutate("Format", (dd) => { M.setShapeText(dd, cur, a, fromEditor(text)); const tx = M.bodyAt(M.mutSlide(dd, cur).xml, a); if (tx) M.formatRange(tx, s0 === s1 ? null : pos(s0), s0 === s1 ? null : pos(s1), f); });
      setTimeout(() => { ta?.focus(); ta?.setSelectionRange(s0, s1); }, 0); return;
    }
    mutate("Format", (dd) => { const tx = M.bodyAt(M.mutSlide(dd, cur).xml, sel); if (!tx) throw new Error("this shape holds no text"); M.formatRange(tx, null, null, f); });
  };
  const pfmt = (f: M.ParaFmt) => {
    const d = docRef.current; if (!d || !sel) return;
    const a = edit ? (edit.cell ? `${edit.addr}#${edit.cell}` : edit.addr) : sel;
    let p0 = 0, p1 = 1e9;
    if (edit && taRef.current) { const t = edit.text; p0 = t.slice(0, taRef.current.selectionStart).split("\n").length - 1; p1 = t.slice(0, taRef.current.selectionEnd).split("\n").length - 1; }
    mutate("Paragraph format", (dd) => { if (edit) M.setShapeText(dd, cur, a, fromEditor(edit.text)); const tx = M.bodyAt(M.mutSlide(dd, cur).xml, a); if (!tx) throw new Error("this shape holds no text"); M.formatParas(tx, p0, p1, f); });
  };

  /* ------------------------------------------------------------ pointer: select / move / resize */
  const onStageDown = (e: React.PointerEvent) => {
    if (edit) { if ((e.target as HTMLElement).closest("textarea")) return; commitEdit(); }
    const t = (e.target as HTMLElement).closest("[data-addr]") as HTMLElement | null;
    const handle = (e.target as HTMLElement).dataset.handle as Drag["kind"] | undefined;
    const addr = handle ? sel : t?.dataset.addr ?? null;
    if (!addr || !doc || !slide) { setSel(null); return; }
    setSel(addr);
    const hit = M.shapeAt(M.spTreeOf(slide.xml), addr); if (!hit) return;
    const v = view?.shapes.find((x) => x.layer === "slide" && x.addr === addr);
    const f = v ? { x: v.x, y: v.y, cx: v.w, cy: v.h } : M.readXfrm(hit.el); if (!f) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: handle ?? "move", addr, x0: e.clientX, y0: e.clientY, f, dx: 0, dy: 0 });
  };
  const onStageMove = (e: React.PointerEvent) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 }); };
  const dragged = (g: Drag): M.Xfrm => {
    const dx = g.dx / scale, dy = g.dy / scale; const f = g.f;
    switch (g.kind) {
      case "move": return { ...f, x: f.x + dx, y: f.y + dy };
      case "se": return { ...f, cx: Math.max(45720, f.cx + dx), cy: Math.max(45720, f.cy + dy) };
      case "ne": return { ...f, y: f.y + Math.min(dy, f.cy - 45720), cx: Math.max(45720, f.cx + dx), cy: Math.max(45720, f.cy - dy) };
      case "sw": return { ...f, x: f.x + Math.min(dx, f.cx - 45720), cx: Math.max(45720, f.cx - dx), cy: Math.max(45720, f.cy + dy) };
      case "nw": return { ...f, x: f.x + Math.min(dx, f.cx - 45720), y: f.y + Math.min(dy, f.cy - 45720), cx: Math.max(45720, f.cx - dx), cy: Math.max(45720, f.cy - dy) };
    }
  };
  const onStageUp = () => {
    const g = drag; setDrag(null); if (!g || (Math.abs(g.dx) < 2 && Math.abs(g.dy) < 2)) return;
    mutate(g.kind === "move" ? "Move" : "Resize", (d) => M.setXfrm(d, cur, g.addr, dragged(g)));
  };

  /* ------------------------------------------------------------ keyboard */
  const onKey = (e: React.KeyboardEvent) => {
    if (present !== null || pop) return; // a modal owns the keyboard
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (edit) commitEdit(true); save(); return; }
    if (isField(e.target)) { if (edit && e.key === "Escape") { e.preventDefault(); commitEdit(); rootRef.current?.focus(); } return; }
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); dupSlide(); return; }
    if (e.key === "F5") { e.preventDefault(); startShow(e.shiftKey ? cur : 0); return; }
    if (sel && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); const a = sel; setSel(null); mutate("Delete shape", (d) => M.deleteShape(d, cur, a)); return; }
    if (sel && e.key === "Enter") { e.preventDefault(); beginEdit(sel); return; }
    if (sel && e.key.startsWith("Arrow")) {
      e.preventDefault(); const st = e.shiftKey ? 457200 : 45720; const v = view?.shapes.find((x) => x.layer === "slide" && x.addr === sel); if (!v) return;
      const dx = e.key === "ArrowLeft" ? -st : e.key === "ArrowRight" ? st : 0, dy = e.key === "ArrowUp" ? -st : e.key === "ArrowDown" ? st : 0; const a = sel;
      mutate("Nudge", (d) => M.setXfrm(d, cur, a, { x: v.x + dx, y: v.y + dy, cx: v.w, cy: v.h })); return;
    }
    if (e.key === "Escape") { setSel(null); return; }
    if (!sel && (e.key === "PageDown" || e.key === "ArrowDown")) { e.preventDefault(); setCur((c) => Math.min((doc?.slides.length ?? 1) - 1, c + 1)); return; }
    if (!sel && (e.key === "PageUp" || e.key === "ArrowUp")) { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); return; }
  };

  /* ------------------------------------------------------------ slide commands */
  const dupSlide = () => { let at = cur; mutate("Duplicate slide", (d) => { at = M.duplicateSlide(d, cur); }); setCur(at); setSel(null); };
  const delSlide = () => { if (!doc || doc.slides.length <= 1) { shell.toast("A deck keeps at least one slide", "warn"); return; } mutate("Delete slide", (d) => M.deleteSlide(d, cur)); setCur((c) => Math.max(0, Math.min(c, doc.slides.length - 2))); setSel(null); };
  const moveTo = (from: number, to: number) => { if (from === to || !doc) return; mutate("Move slide", (d) => M.moveSlide(d, from, to)); setCur(to); };
  const newSlide = (layout: string) => { let at = cur + 1; mutate("New slide", (d) => { at = M.addSlideFromLayout(d, cur + 1, layout); }); setCur(at); setSel(null); };
  const layouts = useMemo(() => (doc ? M.layoutsOf(doc) : []), [doc, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const insertShape = (k: M.NewShapeKind | "textbox") => {
    if (!doc) return; const w = doc.size.cx, h = doc.size.cy; let addr = "";
    const f = k === "textbox" ? { x: w * 0.3, y: h * 0.42, cx: w * 0.4, cy: h * 0.1 } : k === "line" ? { x: w * 0.35, y: h * 0.5, cx: w * 0.3, cy: 0 } : { x: w * 0.4, y: h * 0.35, cx: w * 0.2, cy: h * 0.3 };
    mutate("Insert", (d) => { addr = M.addShape(d, cur, k, f, k === "textbox" ? "Text" : ""); });
    setSel(addr); if (k === "textbox") setTimeout(() => beginEdit(addr), 0);
  };
  const insertPicture = async (file: File) => {
    if (!doc) return; const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!M.IMG_MIME[ext.replace("jpeg", "jpg")]) { shell.toast("Pictures: PNG, JPEG, GIF, BMP, SVG or WebP", "warn"); return; }
    if (file.size > 32 << 20) { shell.toast("Picture exceeds 32 MiB", "warn"); return; }
    const data = new Uint8Array(await file.arrayBuffer()); let ar = 0.75;
    try { const bmp = await createImageBitmap(new Blob([data])); ar = bmp.height / bmp.width; bmp.close(); } catch { /* svg / unknown: keep 4:3 */ }
    const cx = doc.size.cx * 0.45, cy = cx * ar; let addr = "";
    mutate("Insert picture", (d) => { addr = M.addPicture(d, cur, data, ext, { x: (d.size.cx - cx) / 2, y: Math.max(0, (d.size.cy - cy) / 2), cx, cy }, file.name.replace(/\.[^.]+$/, "")); });
    setSel(addr);
  };

  /* ------------------------------------------------------------ notes */
  const notes = doc && slide ? M.notesText(doc, cur) : "";
  const notesKey = `${slide?.uid ?? ""}:${ver}`; const notesDraft = notesEdit && notesEdit.k === notesKey ? notesEdit.t : null; // a draft belongs to one slide state
  const commitNotes = () => { if (notesDraft === null || notesDraft === notes) return; const t = notesDraft; setNotesEdit(null); mutate("Edit notes", (d) => M.setNotesText(d, cur, t)); };

  /* ------------------------------------------------------------ slideshow */
  const shown = useMemo(() => (doc ? doc.slides.map((s, i) => (M.isHidden(s) ? -1 : i)).filter((i) => i >= 0) : []), [doc, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const startShow = (from: number) => {
    if (edit) commitEdit(); if (!shown.length) { shell.toast("Every slide is hidden", "warn"); return; }
    const first = shown.find((i) => i >= from) ?? shown[0]; setPresent(first);
    setTimeout(() => { const el = document.getElementById(`slideshow-${win.id}`); el?.focus(); el?.requestFullscreen?.().catch(() => { /* windowed show still works */ }); }, 0);
  };
  const endShow = () => { setPresent(null); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); setTimeout(() => rootRef.current?.focus(), 0); };
  // while the show runs it owns the whole keyboard (capture phase on window: nothing else sees the keys)
  const showKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    if (present === null) return;
    const h = (e: KeyboardEvent) => showKeyRef.current(e);
    window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true);
  }, [present]);
  const showKey = (e: KeyboardEvent) => {
    if (present === null) return; e.preventDefault(); e.stopPropagation();
    const k = shown.indexOf(present);
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(e.key)) { if (k < shown.length - 1) setPresent(shown[k + 1]); else endShow(); }
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(e.key)) { if (k > 0) setPresent(shown[k - 1]); }
    else if (e.key === "Home") setPresent(shown[0]); else if (e.key === "End") setPresent(shown[shown.length - 1]);
    else if (e.key === "Escape") endShow();
  };  useEffect(() => { showKeyRef.current = showKey; });


  if (!loaded || !doc || !slide || !view) return <div style={{ padding: 16 }}>Loading presentation…</div>;

  const selV = sel ? view.shapes.find((x) => x.layer === "slide" && x.addr === sel) : undefined;
  const live = drag && selV && drag.addr === sel ? dragged(drag) : selV ? { x: selV.x, y: selV.y, cx: selV.w, cy: selV.h } : null;
  const hasText = !!(sel && slide && M.bodyAt(M.cloneDoc(slide.xml), edit?.cell ? `${sel}#${edit.cell}` : sel));
  const noSteal = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() }; // keep the text selection while formatting
  const thumbW = 132;
  const bar: CSSProperties = { padding: "5px 8px", gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap", alignItems: "center" };

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKey} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, outline: "none" }} aria-label="Slides editor">
      {/* ---------- file / slide row ---------- */}
      <div className="fs-row" style={bar} role="toolbar" aria-label="Presentation">
        <Btn variant="primary" onClick={() => { if (edit) commitEdit(true); save(); }} title="Save (Ctrl+S)">Save</Btn>
        <Btn variant="ghost" onClick={() => { setPopVal(path.toLowerCase().endsWith(".pptx") ? path : `/Documents/${doc.title || "Presentation"}.pptx`); setPop("saveas"); }}>Save as…</Btn>
        <Btn variant="ghost" onClick={() => void download()}>Download</Btn>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Open…<input type="file" accept=".pptx" hidden aria-label="Open a .pptx file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void openLocal(f); e.target.value = ""; }} /></label>
        <Btn variant="ghost" data-testid="slides-password" aria-pressed={locked} onClick={async () => {
          if (saveBlocked(encRef.current, encRef.current?.path ?? "")) { setStatus("Unlock the file first (reopen it and enter its password)"); return; }
          const np = await askPassword(path.split("/").pop() || doc.title || "Presentation", encRef.current, path); if (!np) return;
          encRef.current = np; setLocked(!!np.password); setDirty(true); bump();
          setStatus(np.password ? "Password set — the next save encrypts the file (AES-256)" : "Password removed — the next save writes the file without encryption");
        }}>{locked ? "Password: on" : "Password…"}</Btn>
        <span style={{ width: 8 }} />
        <Btn variant="ghost" onClick={doUndo} disabled={!hist.u} title="Undo (Ctrl+Z)" aria-label="Undo"><Ico d="M9 7 L4 12 L9 17 M4 12 H15 A5 5 0 0 1 15 22" /></Btn>
        <Btn variant="ghost" onClick={doRedo} disabled={!hist.r} title="Redo (Ctrl+Y)" aria-label="Redo"><Ico d="M15 7 L20 12 L15 17 M20 12 H9 A5 5 0 0 0 9 22" /></Btn>
        <span style={{ width: 8 }} />
        <select className="fs-input" aria-label="New slide from layout" value="" onChange={(e) => { if (e.target.value) newSlide(e.target.value); }} style={{ width: fz(150) }}>
          <option value="">+ New slide…</option>{layouts.map((l) => <option key={l.path} value={l.path}>{l.name}</option>)}
        </select>
        <Btn variant="ghost" onClick={dupSlide} title="Duplicate slide (Ctrl+D)">Duplicate</Btn>
        <Btn variant="ghost" onClick={delSlide}>Delete slide</Btn>
        <Btn variant="ghost" onClick={() => mutate("Hide slide", (d) => M.setHidden(d, cur, !M.isHidden(d.slides[cur])))} aria-pressed={M.isHidden(slide)}>{M.isHidden(slide) ? "Unhide" : "Hide"}</Btn>
        <Btn variant="primary" onClick={() => startShow(0)} title="Present from the start (F5; Shift+F5 from this slide)"><Ico d="M7 5 L19 12 L7 19 Z" fill /> Present</Btn>
        <span style={{ flex: 1 }} />
        {locked ? <Badge tone="info">encrypted</Badge> : null}
        {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
      </div>
      {/* ---------- insert / format row ---------- */}
      <div className="fs-row" style={bar} role="toolbar" aria-label="Insert and format">
        <Btn variant="ghost" {...noSteal} onClick={() => insertShape("textbox")}>Text box</Btn>
        <select className="fs-input" aria-label="Insert shape" value="" onChange={(e) => { if (e.target.value) insertShape(e.target.value as M.NewShapeKind); }} style={{ width: fz(120) }}>
          <option value="">Shape…</option>{SHAPES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Picture…<input type="file" accept="image/png,image/jpeg,image/gif,image/bmp,image/svg+xml,image/webp" hidden aria-label="Insert picture" onChange={(e) => { const f = e.target.files?.[0]; if (f) void insertPicture(f); e.target.value = ""; }} /></label>
        <span style={{ width: 8 }} />
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => fmt({ b: !curRun()?.b })} aria-label="Bold" title="Bold"><b>B</b></Btn>
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => fmt({ i: !curRun()?.i })} aria-label="Italic" title="Italic"><i>I</i></Btn>
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => fmt({ u: !curRun()?.u })} aria-label="Underline" title="Underline"><u>U</u></Btn>
        <select className="fs-input" aria-label="Font size" disabled={!hasText} value="" onMouseDown={(e) => e.stopPropagation()} onChange={(e) => { if (e.target.value) fmt({ sz: Number(e.target.value) }); }} style={{ width: fz(70) }}>
          <option value="">Size</option>{SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type="color" aria-label="Text colour" disabled={!hasText} className="fs-input" style={{ width: 34, padding: 2 }} onChange={(e) => fmt({ color: e.target.value })} />
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => pfmt({ algn: "l" })} aria-label="Align left"><Ico d="M4 6 H20 M4 10 H14 M4 14 H20 M4 18 H12" /></Btn>
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => pfmt({ algn: "ctr" })} aria-label="Centre"><Ico d="M4 6 H20 M7 10 H17 M4 14 H20 M8 18 H16" /></Btn>
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => pfmt({ algn: "r" })} aria-label="Align right"><Ico d="M4 6 H20 M10 10 H20 M4 14 H20 M12 18 H20" /></Btn>
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => pfmt({ bullet: "char" })} aria-label="Bullets">•</Btn>
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => pfmt({ bullet: "num" })} aria-label="1. Numbering" title="Numbering">1.</Btn>
        <Btn variant="ghost" {...noSteal} disabled={!hasText} onClick={() => pfmt({ bullet: "none" })} aria-label="No bullets">¶</Btn>
        <span style={{ width: 8 }} />
        <label className="fs-dim" style={{ fontSize: fz(11) }}>Fill <input type="color" aria-label="Shape fill" disabled={!sel} className="fs-input" style={{ width: 34, padding: 2 }} onChange={(e) => { const a = sel!; mutate("Fill", (d) => M.setShapeFill(d, cur, a, e.target.value)); }} /></label>
        <label className="fs-dim" style={{ fontSize: fz(11) }}>Line <input type="color" aria-label="Shape outline" disabled={!sel} className="fs-input" style={{ width: 34, padding: 2 }} onChange={(e) => { const a = sel!; mutate("Outline", (d) => M.setShapeLine(d, cur, a, e.target.value, 1.5)); }} /></label>
        <Btn variant="ghost" disabled={!sel} onClick={() => { const a = sel!; let n = a; mutate("Bring to front", (d) => { n = M.zOrder(d, cur, a, "front"); }); setSel(n); }} title="Bring to front">Front</Btn>
        <Btn variant="ghost" disabled={!sel} onClick={() => { const a = sel!; let n = a; mutate("Send to back", (d) => { n = M.zOrder(d, cur, a, "back"); }); setSel(n); }} title="Send to back">Back</Btn>
        <Btn variant="ghost" disabled={!sel} onClick={() => { const a = sel!; setSel(null); setEdit(null); mutate("Delete shape", (d) => M.deleteShape(d, cur, a)); }} title="Delete shape (Del)">Delete shape</Btn>
      </div>
      {status ? <div className="fs-dim" role="status" style={{ padding: "3px 8px", fontSize: fz(11), borderBottom: "1px solid var(--fs-border)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{status}</div> : null}
      {/* ---------- rail + stage ---------- */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div className="fs-scroll" aria-label="Slides" role="listbox" style={{ width: thumbW + 34, flex: "none", borderRight: "1px solid var(--fs-border)", padding: 8, display: "grid", gap: 8, alignContent: "start", overflowY: "auto" }}>
          {doc.slides.map((s, i) => (
            <div key={s.uid} role="option" aria-selected={i === cur} draggable
              onDragStart={(e) => e.dataTransfer.setData("text/x-slide", String(i))} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData("text/x-slide")); if (Number.isFinite(from)) moveTo(from, i); }}
              onClick={() => { if (edit) commitEdit(); setCur(i); setSel(null); }} style={{ display: "flex", gap: 6, cursor: "pointer", alignItems: "flex-start" }}>
              <span className="fs-dim" style={{ fontSize: fz(11), width: 18, textAlign: "right", textDecoration: M.isHidden(s) ? "line-through" : undefined }}><span className="fs-visually-hidden">Slide </span>{i + 1}{M.isHidden(s) ? <span className="fs-visually-hidden"> (hidden)</span> : null}</span>
              <div aria-hidden="true" style={{ outline: i === cur ? "2px solid var(--fs-accent, #2563eb)" : "1px solid var(--fs-border)", outlineOffset: 1, borderRadius: 3, opacity: M.isHidden(s) ? 0.45 : 1, pointerEvents: "none" }}>
                <SlideCanvas doc={doc} view={viewOf(doc, s)} width={thumbW} uid={`t${s.uid}`} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div ref={stageRef} style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", background: "var(--fs-surface-2, rgba(100,116,139,.12))", overflow: "auto" }}>
            <div onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={onStageUp} onDoubleClick={(e) => {
                // pointer capture retargets the event to the stage, so hit-test the point itself (topmost shape, table cell)
                const els = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[];
                const t = els.find((x) => x.dataset?.addr && !x.hasAttribute("aria-hidden")) ?? els.find((x) => x.dataset?.addr);
                const td = els.find((x) => x.tagName === "TD" && x.dataset.cell);
                if (t?.dataset.addr) beginEdit(t.dataset.addr, td?.dataset.cell);
              }}
              style={{ boxShadow: "0 10px 34px rgba(15,23,42,.28)", position: "relative", touchAction: "none" }} aria-label={`Slide ${cur + 1} canvas`}>
              <SlideCanvas doc={doc} view={view} width={stageW} uid={`m${slide.uid}`} hideText={edit && !edit.cell ? edit.addr : null}>
                {live && sel ? (
                  <div aria-hidden style={{ position: "absolute", left: live.x * scale, top: live.y * scale, width: Math.max(2, live.cx * scale), height: Math.max(2, live.cy * scale), outline: "1.5px solid #2563eb", outlineOffset: 1, pointerEvents: edit ? "none" : undefined, cursor: "move" }} data-addr={sel}>
                    {!edit ? (["nw", "ne", "sw", "se"] as const).map((h) => <span key={h} data-handle={h} style={{ position: "absolute", width: 10, height: 10, background: "#fff", border: "1.5px solid #2563eb", borderRadius: 2, left: h.endsWith("w") ? -6 : undefined, right: h.endsWith("e") ? -6 : undefined, top: h.startsWith("n") ? -6 : undefined, bottom: h.startsWith("s") ? -6 : undefined, cursor: `${h}-resize` }} />) : null}
                  </div>
                ) : null}
                {edit && live ? (
                  <textarea ref={taRef} aria-label="Edit shape text" value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} onBlur={(e) => { if (!(e.relatedTarget as HTMLElement | null)?.closest?.("[role=toolbar]")) commitEdit(); }}
                    style={{ position: "absolute", left: live.x * scale, top: live.y * scale, width: Math.max(120, live.cx * scale), height: Math.max(48, live.cy * scale), fontSize: Math.max(12, (firstRunSz() ?? 18) * 12700 * scale), lineHeight: 1.2, background: "rgba(255,255,255,.96)", color: "#111827", border: "2px solid #2563eb", borderRadius: 3, padding: 6, resize: "both", fontFamily: "Calibri, Carlito, Arial, sans-serif", zIndex: 5 }} />
                ) : null}
              </SlideCanvas>
            </div>
          </div>
          <textarea className="fs-textarea" aria-label="Speaker notes" placeholder="Click to add speaker notes" value={notesDraft ?? notes}
            onChange={(e) => setNotesEdit({ k: notesKey, t: e.target.value })} onBlur={commitNotes} style={{ height: 78, margin: 0, borderRadius: 0, borderLeft: 0, borderRight: 0, borderBottom: 0, resize: "vertical", fontSize: fz(13) }} />
        </div>
      </div>
      <div className="fs-dim" style={{ padding: "3px 8px", borderTop: "1px solid var(--fs-border)", fontSize: fz(10.5), display: "flex", gap: 10 }}>
        <span>Slide {cur + 1} of {doc.slides.length}{view.layoutName ? ` · ${view.layoutName}` : ""}{M.isHidden(slide) ? " · hidden" : ""}</span>
        <span style={{ flex: 1 }} />
        <span title="Everything the editor does not change — animations, transitions, media, SmartArt data, embedded objects, themes, masters — is written back byte-for-byte.">Lossless .pptx · animations/media kept, not played</span>
      </div>
      {/* ---------- modal: save as ---------- */}
      {pop === "saveas" ? (
        <div role="dialog" aria-modal="true" aria-label="Save as" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setPop(null); }} style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.35)", display: "grid", placeItems: "center", zIndex: 20 }}>
          <form className="fs-panel" style={{ padding: 14, display: "grid", gap: 8, minWidth: 340 }} onSubmit={(e) => { e.preventDefault(); let d = popVal.trim(); if (!d) return; if (!d.toLowerCase().endsWith(".pptx")) d += ".pptx"; setPop(null); void saveTo(d); }}>
            <label style={{ display: "grid", gap: 4, fontSize: fz(13) }}>Save presentation as<input autoFocus className="fs-input" aria-label="File path" value={popVal} onChange={(e) => setPopVal(e.target.value)} /></label>
            <div className="fs-row" style={{ gap: 6, justifyContent: "flex-end" }}><Btn variant="ghost" onClick={() => setPop(null)}>Cancel</Btn><Btn variant="primary" type="submit">Save</Btn></div>
          </form>
        </div>
      ) : null}
      {/* ---------- slideshow ---------- */}
      {present !== null && typeof document !== "undefined" ? createPortal(
        <div id={`slideshow-${win.id}`} tabIndex={0} role="dialog" aria-modal="true" aria-label={`Slide show, slide ${present + 1}`}
          onClick={() => { const k = shown.indexOf(present); if (k < shown.length - 1) setPresent(shown[k + 1]); else endShow(); }}
          style={{ position: "fixed", inset: 0, background: "#000", zIndex: 2147483000, display: "grid", placeItems: "center", outline: "none", cursor: "none" }}>
          <ShowSlide doc={doc} i={present} />
          <span className="fs-dim" style={{ position: "absolute", bottom: 8, right: 12, color: "rgba(255,255,255,.45)", fontSize: fz(12) }}>{shown.indexOf(present) + 1} / {shown.length} · Esc to end</span>
        </div>, document.body,
      ) : null}
    </div>
  );

  function curRun() { return view?.shapes.find((x) => x.layer === "slide" && x.addr === sel)?.text?.paras.flatMap((p) => p.runs).find((r) => r.text); }
  function firstRunSz() { return curRun()?.sz; }
}

function Ico({ d, fill }: { d: string; fill?: boolean }): ReactNode {
  return <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden style={{ verticalAlign: "-2px" }}><path d={d} fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth={fill ? 0 : 2} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ShowSlide({ doc, i }: { doc: M.PptxDoc; i: number }) {
  const [vp, setVp] = useState({ w: typeof window !== "undefined" ? window.innerWidth : 1280, h: typeof window !== "undefined" ? window.innerHeight : 720 });
  useEffect(() => { const f = () => setVp({ w: window.innerWidth, h: window.innerHeight }); window.addEventListener("resize", f); document.addEventListener("fullscreenchange", f); return () => { window.removeEventListener("resize", f); document.removeEventListener("fullscreenchange", f); }; }, []);
  const s = doc.slides[i]; if (!s) return null;
  const w = Math.min(vp.w, vp.h * (doc.size.cx / doc.size.cy));
  return <SlideCanvas doc={doc} view={viewOf(doc, s)} width={w} uid={`p${s.uid}`} />;
}
