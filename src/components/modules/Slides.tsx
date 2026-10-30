"use client";
/**
 * TT51 — Slides: a lossless editor for real PowerPoint (.pptx) files (FF-23).
 * The deck is the original package (src/lib/office/pml.ts): edits change only the parts they touch and every other
 * part is written back byte-for-byte. What it shows is resolved through PowerPoint's inheritance (pmlview.ts) and
 * drawn by slides/render.tsx. Legacy .fdeck outlines open by converting to a real deck; password-protected decks
 * decrypt on this device and save encrypted again (same machinery as Writer).
 */
import { AppBanner, BannerGroup } from "@/components/AppBanner";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fz } from "@/lib/uiscale";
import { api, post } from "@/lib/api";
import { toB64, fromB64 } from "@/lib/crypto";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import { clampSlide } from "@/lib/slide-nav";
import { askPassword, isEncryptedOffice, lockedProtection, saveBlocked, sealPackage, unlockOffice, type Protection } from "@/lib/office/unlock";
import * as M from "@/lib/office/pml";
import { findSlideText, replaceSlideText } from "@/lib/office/pmlsearch";
import { deckToMarkdown, deckToText } from "@/lib/office/convert-slides";
import { askForm, holdModal, isAskOpen } from "@/lib/ask";
import { lossDetail, downloadAs } from "@/lib/office/export-ask";
import { slideView, type VSlide } from "@/lib/office/pmlview";
import { SlideCanvas } from "./slides/render";
import { MotionPanel, OrderBadges, ShowStage } from "./slides/motion";
import { autoSteps, playSteps, readAnimations, readTransition, stepMs } from "@/lib/office/pmlanim";
import { PresenterConsole } from "./slides/presenter";
import { channelPort, newSid, type ShowPort } from "@/lib/office/showlink";

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
  // TT76 show state: click steps done on the current slide, whether the last one animates, the slide we came from (transition)
  const [showSt, setShowSt] = useState<{ done: number; animate: boolean; key: number; from: number | null }>({ done: 0, animate: false, key: 0, from: null });
  const [findPane, setFindPane] = useState(false);
  const [findQuery, setFindQuery] = useState(""); const [replacement, setReplacement] = useState("");
  const [findCase, setFindCase] = useState(false); const [findCurrent, setFindCurrent] = useState(false);
  const [findMessage, setFindMessage] = useState("");
  const [motion, setMotion] = useState(false);
  // TT76 (CA-02) presenter view: the audience screen is a second window running /present?show=<sid>
  const linkRef = useRef<{ port: ShowPort; win: Window | null; bytes: Uint8Array | null } | null>(null);
  const [audience, setAudience] = useState<null | "waiting" | "connected">(null);
  const [showT0, setShowT0] = useState(0);
  const [stageW, setStageW] = useState(720);
  const stageRef = useRef<HTMLDivElement>(null); const taRef = useRef<HTMLTextAreaElement>(null); const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!pop) return;
    const release = holdModal(); // stop shell-wide shortcuts even if focus leaves this dialog
    const editor = rootRef.current;
    return () => { release(); if (editor?.isConnected) editor.focus(); };
  }, [pop]);
  const [notesEdit, setNotesEdit] = useState<{ k: string; t: string } | null>(null);
  const [doc, setDoc] = useState<M.PptxDoc | null>(null); // same object as docRef (mutated in place; `ver` re-renders)
  const [hist, setHist] = useState({ u: 0, r: 0 });
  const syncHist = () => setHist({ u: undo.current.length, r: redo.current.length });
  const slide = doc?.slides[cur];
  const view = useMemo(() => (doc && slide ? viewOf(doc, slide) : null), [doc, slide, ver]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = useMemo(() => {
    try { return { hits: doc ? findSlideText(doc, findQuery, { matchCase: findCase, slide: findCurrent ? cur : undefined }) : [], error: "" }; }
    catch (e) { return { hits: [], error: (e as Error).message }; }
  }, [doc, ver, findQuery, findCase, findCurrent, cur]); // eslint-disable-line react-hooks/exhaustive-deps -- doc is mutable; ver invalidates after undo/edit
  const openFind = () => { if (edit) commitEdit(true); setFindPane((v) => !v); setFindMessage(""); };
  const replaceFound = () => {
    if (!search.hits.length || !docRef.current) return;
    mutate("Replace text", (d) => { const n = replaceSlideText(d, findQuery, replacement, { matchCase: findCase, slide: findCurrent ? cur : undefined }); setFindMessage(`Replaced ${n} match(es)`); });
    setSel(null); setEdit(null);
  };

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
  // TT74 (FF-02): outline export (Markdown / text) of exactly what Save would write; the loss report is shown first.
  // Verified against python-pptx on 83 decks / 551 slides (K1).
  const exportOutline = async () => {
    const d = docRef.current; if (!d) return;
    let bytes: Uint8Array; try { bytes = await M.writePptxDoc(d); } catch (e) { shell.toast(`Not exported: ${(e as Error).message}`, "bad"); return; }
    const stem = (path.split("/").pop() || d.title || "Presentation").replace(/\.[^.]+$/, "");
    const d2 = await M.readPptxDoc(bytes, `${stem}.pptx`);
    const preview = deckToMarkdown(d2, { notes: true, hidden: true });
    const r = await askForm({
      title: "Export outline", detail: lossDetail(preview.loss), okLabel: "Export",
      fields: [{ name: "name", label: "File name (.md or .txt)", def: `${stem}.md` }, { name: "opts", label: "Include: notes, hidden (remove a word to leave it out)", def: "notes, hidden" }],
      validate: (v) => ((v.name ?? "").trim() ? null : "Enter a file name"),
    });
    if (!r) return;
    let name = (r.name ?? "").trim().replace(/[\\/:*?"<>|]+/g, "_"); if (!/\.(md|txt)$/i.test(name)) name += ".md";
    const o = (r.opts ?? "").toLowerCase();
    const out = /\.txt$/i.test(name) ? deckToText(d2) : deckToMarkdown(d2, { notes: o.includes("notes"), hidden: o.includes("hidden") });
    downloadAs(name, "md" in out ? out.md : out.text, /\.txt$/i.test(name) ? "text/plain" : "text/markdown");
    setStatus(`Exported the outline to ${name}${out.loss.length ? ` — not carried over: ${out.loss.join("; ")}` : ""}`);
  };
  const openLocal = async (f: File) => {
    if (f.size > M.MAX_PPTX) { shell.toast("The file exceeds the 64 MiB guard", "warn"); return; }
    try { await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name); setPath(""); } catch (e) { shell.toast(`Could not open ${f.name}: ${(e as Error).message}`, "bad"); }
  };

  /* ------------------------------------------------------------ stage size */
  // TT76: measured before paint (layout effect + an immediate fit) — the old version started from a 720 px guess and
  // only corrected it on the first ResizeObserver callback, so every deck visibly jumped once after opening and a
  // click in that window landed on the wrong shape (found by a flaky e2e-tt51-slides pick).
  useLayoutEffect(() => {
    const el = stageRef.current; if (!el || !doc) return;
    const fit = () => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return; const ar = doc.size.cy / doc.size.cx; setStageW(Math.max(240, Math.min(r.width - 32, (r.height - 24) / ar))); };
    fit();
    const ro = new ResizeObserver(fit);
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
    if (present !== null || pop || isAskOpen()) return; // a modal owns the keyboard
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (edit) commitEdit(true); save(); return; }
    if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); return; }
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
    const first = shown.find((i) => i >= from) ?? shown[0]; goSlide(first, true, null);
    setTimeout(() => { const el = document.getElementById(`slideshow-${win.id}`); el?.focus(); el?.requestFullscreen?.().catch(() => { /* windowed show still works */ }); }, 0);
  };
  const endShow = () => {
    const l = linkRef.current; linkRef.current = null; setAudience(null);
    if (l) { l.port.send({ t: "end" }); setTimeout(() => { l.port.close(); try { l.win?.close(); } catch { /* already closed */ } }, 300); }
    setPresent(null); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); setTimeout(() => rootRef.current?.focus(), 0); };
  // while the show runs it owns the whole keyboard (capture phase on window: nothing else sees the keys)
  const showKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    if (present === null) return;
    const h = (e: KeyboardEvent) => showKeyRef.current(e);
    window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true);
  }, [present]);
  const effectsOf = (i: number) => (doc?.slides[i] ? readAnimations(doc.slides[i].xml).effects : []);
  /** enter slide i: forward = its auto-start step plays (after its transition); backward = fully built, no animation */
  const goSlide = (i: number, forward: boolean, from: number | null) => {
    const eff = effectsOf(i);
    setPresent(i); setShowSt((st) => ({ done: forward ? autoSteps(eff) : playSteps(eff).length, animate: forward, key: st.key + 1, from: forward ? from : null }));
  };
  const showNext = () => {
    if (present === null) return; const steps = playSteps(effectsOf(present)).length;
    if (showSt.done < steps) { setShowSt((st) => ({ done: st.done + 1, animate: true, key: st.key + 1, from: null })); return; }
    const k = shown.indexOf(present); if (k < shown.length - 1) goSlide(shown[k + 1], true, present); else endShow();
  };
  const showPrev = () => {
    if (present === null) return;
    if (showSt.done > autoSteps(effectsOf(present))) { setShowSt((st) => ({ done: st.done - 1, animate: false, key: st.key + 1, from: null })); return; }
    const k = shown.indexOf(present); if (k > 0) goSlide(shown[k - 1], false, null);
  };
  const showNextRef = useRef<() => void>(() => undefined); const showPrevRef = useRef<() => void>(() => undefined);
  const startPresenter = () => {
    const d = docRef.current; if (!d) return; if (edit) commitEdit();
    if (!shown.length) { shell.toast("Every slide is hidden", "warn"); return; }
    const sid = newSid();
    // opened synchronously inside the click so the browser counts it as user-initiated (not a blocked pop-up)
    const w = window.open(`/present?show=${sid}`, `fusion-audience-${sid}`, "popup,width=1280,height=720");
    if (!w) { shell.toast("The audience window was blocked — allow pop-ups for this site, or use Present", "warn"); return; }
    const port = channelPort(sid); const link = { port, win: w, bytes: null as Uint8Array | null }; linkRef.current = link;
    const name = (path.split("/").pop() || `${d.title || "Presentation"}.pptx`).replace(/\.fdeck$/i, ".pptx");
    const sendDeck = () => { if (link.bytes && linkRef.current === link) port.send({ t: "deck", name, bytes: link.bytes, slides: d.slides.length }); };
    port.onmsg = (m) => {
      if (linkRef.current !== link) return;
      if (m.t === "hello") sendDeck();
      else if (m.t === "ready") { setAudience("connected"); sendStateRef.current(); }
      else if (m.t === "nav") (m.dir === "next" ? showNextRef : showPrevRef).current();
    };
    void M.writePptxDoc(d).then((b) => { link.bytes = b; sendDeck(); }).catch((e: Error) => shell.toast(`Audience screen: ${e.message}`, "bad"));
    void placeOnOtherScreen(w);
    setAudience("waiting"); setShowT0(Date.now()); startShow(cur);
  };
  const sendStateRef = useRef<() => void>(() => undefined);
  // "advance after" timing: counts once every build step has played (the last step's run time included)
  const curTrans = present !== null && doc?.slides[present] ? readTransition(doc.slides[present].xml) : null;
  useEffect(() => {
    if (present === null || !curTrans || curTrans.advAfterMs === undefined) return;
    const steps = playSteps(effectsOf(present)); if (showSt.done < steps.length) return;
    const tr = showSt.from !== null ? curTrans.durMs : 0; const last = showSt.animate ? stepMs(steps[showSt.done - 1]) : 0;
    const id = setTimeout(() => showNextRef.current(), tr + last + curTrans.advAfterMs);
    return () => clearTimeout(id);
  }, [present, showSt, curTrans?.advAfterMs]); // eslint-disable-line react-hooks/exhaustive-deps
  const showKey = (e: KeyboardEvent) => {
    if (present === null) return; e.preventDefault(); e.stopPropagation();
    if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"].includes(e.key)) showNext();
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(e.key)) showPrev();
    else if (e.key === "Home") goSlide(shown[0], true, null); else if (e.key === "End") goSlide(shown[shown.length - 1], false, null);
    else if (e.key === "Escape") endShow();
  };  useEffect(() => {
    showKeyRef.current = showKey; showNextRef.current = showNext; showPrevRef.current = showPrev;
    sendStateRef.current = () => { const l = linkRef.current; if (l && present !== null) l.port.send({ t: "state", s: { i: present, ...showSt } }); };
  });
  useEffect(() => { sendStateRef.current(); }, [present, showSt]);


  if (!loaded || !doc || !slide || !view) return <div style={{ padding: 16 }}>Loading presentation…</div>;

  const selV = sel ? view.shapes.find((x) => x.layer === "slide" && x.addr === sel) : undefined;
  const live = drag && selV && drag.addr === sel ? dragged(drag) : selV ? { x: selV.x, y: selV.y, cx: selV.w, cy: selV.h } : null;
  const hasText = !!(sel && slide && M.bodyAt(M.cloneDoc(slide.xml), edit?.cell ? `${sel}#${edit.cell}` : sel));
  const noSteal = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() }; // keep the text selection while formatting
  const thumbW = 132;
  const bar: CSSProperties = { padding: "5px 8px", gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap", alignItems: "center" };

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKey} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, outline: "none" }} aria-label="Slides editor">
      {/* ---------- TT80 banner: Keep · Stage · Tweak · Put · Look · Stack over one tool strip ---------- */}
      <AppBanner label="Slides" status={<>
          {locked ? <Badge tone="info">encrypted</Badge> : null}
          {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
      </>}>
        <BannerGroup name="Keep">
          <Btn variant="primary" onClick={() => { if (edit) commitEdit(true); save(); }} title="Save (Ctrl+S)">Save</Btn>
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Open…<input type="file" accept=".pptx" hidden aria-label="Open a .pptx file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void openLocal(f); e.target.value = ""; }} /></label>
        </BannerGroup>
        <BannerGroup name="Stage">
          <Btn variant="primary" onClick={() => startShow(0)} title="Present from the start (F5; Shift+F5 from this slide)"><Ico d="M7 5 L19 12 L7 19 Z" fill /> Present</Btn>
          <Btn variant="ghost" data-testid="slides-presenter" onClick={startPresenter} title="Show the slides on a second window or screen (projector / TV) and keep notes, next slide and a timer here">Presenter view</Btn>
          <Btn variant="ghost" data-testid="slides-motion" aria-pressed={motion} onClick={() => setMotion((m) => !m)} title="Transitions and animations of this slide">Motion</Btn>
          <Btn variant="ghost" onClick={() => mutate("Hide slide", (d) => M.setHidden(d, cur, !M.isHidden(d.slides[cur])))} aria-pressed={M.isHidden(slide)}>{M.isHidden(slide) ? "Unhide" : "Hide"}</Btn>
        </BannerGroup>
        <BannerGroup name="Tweak">
          <Btn variant="ghost" data-testid="slides-find" aria-pressed={findPane} onClick={openFind} title="Find and replace (Ctrl+F)">Find</Btn>
          <Btn variant="ghost" onClick={doUndo} disabled={!hist.u} title="Undo (Ctrl+Z)" aria-label="Undo"><Ico d="M9 7 L4 12 L9 17 M4 12 H15 A5 5 0 0 1 15 22" /></Btn>
          <Btn variant="ghost" onClick={doRedo} disabled={!hist.r} title="Redo (Ctrl+Y)" aria-label="Redo"><Ico d="M15 7 L20 12 L15 17 M20 12 H9 A5 5 0 0 0 9 22" /></Btn>
        </BannerGroup>
        <BannerGroup name="Put">
          <select className="fs-input" aria-label="New slide from layout" value="" onChange={(e) => { if (e.target.value) newSlide(e.target.value); }} style={{ width: fz(150) }}>
          <option value="">+ New slide…</option>{layouts.map((l) => <option key={l.path} value={l.path}>{l.name}</option>)}
          </select>
          <Btn variant="ghost" onClick={dupSlide} title="Duplicate slide (Ctrl+D)">Duplicate</Btn>
          <Btn variant="ghost" {...noSteal} onClick={() => insertShape("textbox")}>Text box</Btn>
          <select className="fs-input" aria-label="Insert shape" value="" onChange={(e) => { if (e.target.value) insertShape(e.target.value as M.NewShapeKind); }} style={{ width: fz(120) }}>
          <option value="">Shape…</option>{SHAPES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Picture…<input type="file" accept="image/png,image/jpeg,image/gif,image/bmp,image/svg+xml,image/webp" hidden aria-label="Insert picture" onChange={(e) => { const f = e.target.files?.[0]; if (f) void insertPicture(f); e.target.value = ""; }} /></label>
        </BannerGroup>
        <BannerGroup name="Look">
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
          <label className="fs-dim" style={{ fontSize: fz(11) }} title="Shape fill">Fill <input type="color" aria-label="Shape fill" disabled={!sel} className="fs-input" style={{ width: 34, padding: 2 }} onChange={(e) => { const a = sel!; mutate("Fill", (d) => M.setShapeFill(d, cur, a, e.target.value)); }} /></label>
          <label className="fs-dim" style={{ fontSize: fz(11) }}>Line <input type="color" aria-label="Shape outline" disabled={!sel} className="fs-input" style={{ width: 34, padding: 2 }} onChange={(e) => { const a = sel!; mutate("Outline", (d) => M.setShapeLine(d, cur, a, e.target.value, 1.5)); }} /></label>
        </BannerGroup>
        <BannerGroup name="Stack">
          <Btn variant="ghost" disabled={!sel} onClick={() => { const a = sel!; let n = a; mutate("Bring to front", (d) => { n = M.zOrder(d, cur, a, "front"); }); setSel(n); }} title="Bring to front">Front</Btn>
          <Btn variant="ghost" disabled={!sel} onClick={() => { const a = sel!; let n = a; mutate("Send to back", (d) => { n = M.zOrder(d, cur, a, "back"); }); setSel(n); }} title="Send to back">Back</Btn>
        </BannerGroup>
        <BannerGroup name="Tweak">
          <Btn variant="ghost" disabled={!sel} onClick={() => { const a = sel!; setSel(null); setEdit(null); mutate("Delete shape", (d) => M.deleteShape(d, cur, a)); }} title="Delete shape (Del)">Delete shape</Btn>
          <Btn variant="ghost" onClick={delSlide}>Delete slide</Btn>
        </BannerGroup>
        <BannerGroup name="Keep">
          <Btn variant="ghost" onClick={() => { setPopVal(path.toLowerCase().endsWith(".pptx") ? path : `/Documents/${doc.title || "Presentation"}.pptx`); setPop("saveas"); }}>Save as…</Btn>
          <Btn variant="ghost" onClick={() => void download()}>Download</Btn>
          <Btn variant="ghost" data-testid="slides-export-outline" title="Export the slide text as a Markdown or plain-text outline" onClick={() => void exportOutline()}>Outline</Btn>
          <Btn variant="ghost" data-testid="slides-password" aria-pressed={locked} onClick={async () => {
          if (saveBlocked(encRef.current, encRef.current?.path ?? "")) { setStatus("Unlock the file first (reopen it and enter its password)"); return; }
          const np = await askPassword(path.split("/").pop() || doc.title || "Presentation", encRef.current, path); if (!np) return;
          encRef.current = np; setLocked(!!np.password); setDirty(true); bump();
          setStatus(np.password ? "Password set — the next save encrypts the file (AES-256)" : "Password removed — the next save writes the file without encryption");
          }}>{locked ? "Password: on" : "Password…"}</Btn>
        </BannerGroup>
      </AppBanner>
      {findPane ? <section aria-label="Find and replace slide text" data-testid="slides-search" style={{ padding: 8, borderBottom: "1px solid var(--fs-border)", maxHeight: 220, overflow: "auto", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input className="fs-input" aria-label="Find slide text" placeholder="Find slide text" value={findQuery} maxLength={4096} onChange={(e) => { setFindQuery(e.target.value); setFindMessage(""); }} />
          <input className="fs-input" aria-label="Replace slide text with" placeholder="Replace with" value={replacement} maxLength={65536} onChange={(e) => setReplacement(e.target.value)} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={findCase} onChange={(e) => setFindCase(e.target.checked)} />Match case</label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={findCurrent} onChange={(e) => setFindCurrent(e.target.checked)} />Current slide only</label>
          <Btn data-testid="slides-replace-all" disabled={!search.hits.length} onClick={replaceFound}>Replace all</Btn>
          <Btn variant="ghost" aria-label="Close slide search" onClick={() => setFindPane(false)}>Close</Btn>
        </div>
        <div role="status">{search.error || findMessage || `${search.hits.length} match(es)`}</div>
        <div className="fs-dim" style={{ fontSize: fz(11) }}>Slide-owned text, tables and groups; not notes, masters, dynamic fields or text inside pictures. Matches do not cross paragraphs or hard breaks. Replacement keeps the first run’s style.</div>
        {search.hits.slice(0, 100).map((h, i) => <button className="fs-btn" data-variant="ghost" data-testid="slides-search-hit" key={`${h.slide}-${h.segment}-${h.start}`} onClick={() => { if (edit) commitEdit(true); setCur(h.slide); setSel(null); }} style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Slide {h.slide + 1} · {i + 1}: {h.text.slice(Math.max(0, h.start - 25), Math.min(h.text.length, h.end + 40))}</button>)}
        {search.hits.length > 100 ? <div>Showing the first 100 matches; narrow the search to navigate later results. Replace all applies to all {search.hits.length} matches.</div> : null}
      </section> : null}
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
                {motion ? <OrderBadges doc={doc} view={view} slide={slide} scale={scale} /> : null}
              </SlideCanvas>
            </div>
          </div>
          <textarea className="fs-textarea" aria-label="Speaker notes" placeholder="Click to add speaker notes" value={notesDraft ?? notes}
            onChange={(e) => setNotesEdit({ k: notesKey, t: e.target.value })} onBlur={commitNotes} style={{ height: 78, margin: 0, borderRadius: 0, borderLeft: 0, borderRight: 0, borderBottom: 0, resize: "vertical", fontSize: fz(13) }} />
        </div>
        {motion ? <MotionPanel doc={doc} cur={cur} sel={sel} mutate={mutate} onSelect={(a) => { if (edit) commitEdit(); setSel(a); }} onPreview={() => startShow(cur)} onClose={() => { setMotion(false); setTimeout(() => rootRef.current?.focus(), 0); }} /> : null}
      </div>
      <div className="fs-dim" style={{ padding: "3px 8px", borderTop: "1px solid var(--fs-border)", fontSize: fz(10.5), display: "flex", gap: 10 }}>
        <span>Slide {cur + 1} of {doc.slides.length}{view.layoutName ? ` · ${view.layoutName}` : ""}{M.isHidden(slide) ? " · hidden" : ""}</span><input className="fs-input" style={{ width: fz(64) }} inputMode="numeric" placeholder="Go to" aria-label="Go to slide number" data-testid="slides-goto" onKeyDown={(e) => { if (e.key === "Enter") { const t = clampSlide((e.target as HTMLInputElement).value, doc.slides.length); if (t !== null) { if (edit) commitEdit(true); setCur(t); setSel(null); (e.target as HTMLInputElement).value = ""; } } }} /><input className="fs-input" style={{ width: fz(64) }} inputMode="numeric" placeholder="Go to" aria-label="Go to slide number" data-testid="slides-goto" onKeyDown={(e) => { if (e.key === "Enter") { const t = clampSlide((e.target as HTMLInputElement).value, doc.slides.length); if (t !== null) { if (edit) commitEdit(true); setCur(t); setSel(null); (e.target as HTMLInputElement).value = ""; } } }} /><span style={{ display: "none" }}>{""}{view.layoutName ? ` · ${view.layoutName}` : ""}{M.isHidden(slide) ? " · hidden" : ""}</span>
        <span style={{ flex: 1 }} />
        <span title="Transitions and entrance animations are edited in Motion and played in the show; other effects play approximately (entrance appears, exit hides). Everything the editor does not change — media, SmartArt data, embedded objects, themes, masters — is written back byte-for-byte.">Lossless .pptx · transitions + entrance animations play; media kept, not played</span>
      </div>
      {/* ---------- modal: save as ---------- */}
      {pop === "saveas" ? (
        <div role="dialog" aria-modal="true" aria-label="Save as" onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") { e.preventDefault(); setPop(null); return; }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") e.preventDefault();
          if (e.key === "Tab") {
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])")];
            if (!items.length) return;
            const i = items.indexOf(document.activeElement as HTMLElement);
            const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
            e.preventDefault(); items[next].focus();
          }
        }} style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.35)", display: "grid", placeItems: "center", zIndex: 20 }}>
          <form className="fs-panel" style={{ padding: 14, display: "grid", gap: 8, minWidth: 340 }} onSubmit={(e) => { e.preventDefault(); let d = popVal.trim(); if (!d) return; if (!d.toLowerCase().endsWith(".pptx")) d += ".pptx"; setPop(null); void saveTo(d); }}>
            <label style={{ display: "grid", gap: 4, fontSize: fz(13) }}>Save presentation as<input autoFocus className="fs-input" aria-label="File path" value={popVal} onChange={(e) => setPopVal(e.target.value)} /></label>
            <div className="fs-row" style={{ gap: 6, justifyContent: "flex-end" }}><Btn variant="ghost" onClick={() => setPop(null)}>Cancel</Btn><Btn variant="primary" type="submit">Save</Btn></div>
          </form>
        </div>
      ) : null}
      {/* ---------- slideshow ---------- */}
      {present !== null && typeof document !== "undefined" ? createPortal(
        <div id={`slideshow-${win.id}`} tabIndex={0} role="dialog" aria-modal="true" aria-label={`Slide show, slide ${present + 1}`}
          onClick={() => { if (curTrans && !curTrans.advClick && showSt.done >= playSteps(effectsOf(present)).length) return; showNext(); }}
          style={{ position: "fixed", inset: 0, background: "#000", zIndex: 2147483000, display: "grid", placeItems: "center", outline: "none", cursor: "none" }}>
          {audience ? <PresenterConsole doc={doc} st={{ i: present, ...showSt }} shown={shown} viewOf={(x) => viewOf(doc, x)} notes={M.notesText(doc, present)} audience={audience} t0={showT0} onNext={showNext} onPrev={showPrev} onEnd={endShow} />
            : <ShowSlide doc={doc} i={present} st={showSt} />}
          {audience ? null : <span className="fs-dim" style={{ position: "absolute", bottom: 8, right: 12, color: "rgba(255,255,255,.45)", fontSize: fz(12) }}>{shown.indexOf(present) + 1} / {shown.length} · Esc to end</span>}
        </div>, document.body,
      ) : null}
    </div>
  );

  function curRun() { return view?.shapes.find((x) => x.layer === "slide" && x.addr === sel)?.text?.paras.flatMap((p) => p.runs).find((r) => r.text); }
  function firstRunSz() { return curRun()?.sz; }
}

/** With the Window Management permission already granted, move the audience window onto another screen, full size. */
async function placeOnOtherScreen(w: Window) {
  try {
    const st = await navigator.permissions.query({ name: "window-management" as PermissionName }); if (st.state !== "granted") return;
    const sd = await (window as unknown as { getScreenDetails: () => Promise<{ screens: { availLeft: number; availTop: number; availWidth: number; availHeight: number }[]; currentScreen: unknown }> }).getScreenDetails();
    const other = sd.screens.find((x) => x !== sd.currentScreen); if (!other) return;
    w.moveTo(other.availLeft, other.availTop); w.resizeTo(other.availWidth, other.availHeight);
  } catch { /* no Window Management API: the user drags the window to the projector */ }
}
function Ico({ d, fill }: { d: string; fill?: boolean }): ReactNode {
  return <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden style={{ verticalAlign: "-2px" }}><path d={d} fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth={fill ? 0 : 2} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function ShowSlide({ doc, i, st }: { doc: M.PptxDoc; i: number; st: { done: number; animate: boolean; key: number; from: number | null } }) {
  const [vp, setVp] = useState({ w: typeof window !== "undefined" ? window.innerWidth : 1280, h: typeof window !== "undefined" ? window.innerHeight : 720 });
  useEffect(() => { const f = () => setVp({ w: window.innerWidth, h: window.innerHeight }); window.addEventListener("resize", f); document.addEventListener("fullscreenchange", f); return () => { window.removeEventListener("resize", f); document.removeEventListener("fullscreenchange", f); }; }, []);
  const s = doc.slides[i]; if (!s) return null;
  const w = Math.min(vp.w, vp.h * (doc.size.cx / doc.size.cy));
  return <ShowStage doc={doc} i={i} done={st.done} animate={st.animate} animKey={st.key} from={st.from} viewOf={(x) => viewOf(doc, x)} w={w} />;
}
