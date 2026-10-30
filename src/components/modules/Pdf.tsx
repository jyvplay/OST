"use client";
/**
 * TT52 — PDF: a first-party viewer and editor (FF-03, PR-08, FF-13). Everything runs on this device with the engine in
 * src/lib/pdf (no browser PDF plug-in: the app's CSP is object-src 'none', and nothing is uploaded anywhere).
 *  View: continuous pages drawn by our renderer, zoom / fit, rotate view, thumbnails, find with highlights, outline-free
 *        text extraction (copy page text / export .txt), document properties, password-protected files.
 *  Edit: highlight / underline / strike-out over text, freehand ink, boxes, ellipses, text boxes, sticky notes,
 *        page rotate / delete / move / insert blank, merge another PDF, extract pages, fill form fields, title/author.
 *  Save: an incremental update (the original bytes are kept verbatim; what you see is re-parsed from exactly the bytes
 *        that will be written), or a "clean copy" that rewrites only what is still reachable (removes deleted pages and
 *        old revisions). Encrypted files stay encrypted with their original key. Undo/redo by revision.
 */
import { AppBanner, BannerGroup } from "@/components/AppBanner";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fz } from "@/lib/uiscale";
import { api, post } from "@/lib/api";
import { toB64, fromB64 } from "@/lib/crypto";
import { askText } from "@/lib/ask";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import { PdfDoc, PasswordRequired, type PdfPage } from "@/lib/pdf/pdfdoc";
import { boundedPageScale, renderPage, pageTransform, type DecodedImages } from "@/lib/pdf/pdfcanvas";
import { apply, invert, type M } from "@/lib/pdf/pdfinterp";
import { pageChars, layout, search, type TLine, type Hit } from "@/lib/pdf/pdftext";
import { PdfEditor, extractPages, type AnnotSpec } from "@/lib/pdf/pdfedit";
import { PdfSignatures } from "./PdfSignatures";
import { signatureFields } from "@/lib/pdf/pdfsig";
import { askConfirm } from "@/lib/ask";
/** FreeText annotation size in PDF points — document data written into the file, not UI text (so not scaled by fz) */
const ANNOT_FONT_PT = 12;

/** text drawn directly on the light page-stage background keeps a dark ink in every theme (contrast ≥ 4.5:1 on #e8eaef) */
const STAGE_INK = "#1f2937";

export const MAX_PDF_BYTES = 256 << 20;
type Tool = "select" | "highlight" | "underline" | "strike" | "ink" | "box" | "ellipse" | "text" | "note";
const TOOLS: [Tool, string, string][] = [["select", "Select", "Select text / navigate"], ["highlight", "Highlight", "Drag across text"], ["underline", "Underline", "Drag across text"], ["strike", "Strike", "Drag across text"], ["ink", "Pen", "Freehand ink"], ["box", "Box", "Drag a rectangle"], ["ellipse", "Ellipse", "Drag an ellipse"], ["text", "Text box", "Drag, then type"], ["note", "Note", "Click to place a sticky note"]];
const COLORS: [string, [number, number, number]][] = [["Yellow", [1, 0.85, 0.1]], ["Green", [0.3, 0.85, 0.4]], ["Blue", [0.2, 0.55, 1]], ["Pink", [1, 0.4, 0.7]], ["Red", [0.9, 0.15, 0.15]], ["Black", [0, 0, 0]]];
const css3 = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
type Panel = "pages" | "find" | "forms" | "sigs" | "info";
interface Rev { bytes: Uint8Array; what: string }
/** inline SVG icons (Unicode arrows render as tofu with the app's fonts) */
function Ico({ d, label }: { d: string; label: string }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })} style={{ display: "block" }}><path d={d} /></svg>;
}
const ICON = {
  rotL: "M3 3v4h4M3.5 7A5 5 0 1 1 4 11", rotR: "M13 3v4H9M12.5 7A5 5 0 1 0 12 11",
  up: "M8 13V3M4 7l4-4 4 4", down: "M8 3v10M4 9l4 4 4-4",
};
/** text layout per document revision and page (documents are immutable: each edit opens a new PdfDoc) */
const TEXT = new WeakMap<PdfDoc, Map<number, TLine[]>>();

/** chars of the page's text lines that fall inside a user-space rectangle → one rectangle per line */
function textRects(lines: TLine[], r: number[]): number[][] {
  const [x0, y0, x1, y1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  const out: number[][] = [];
  for (const l of lines) {
    if (l.y1 < y0 || l.y0 > y1) continue;
    const cs = l.chars.filter((c) => c.x + c.w >= x0 && c.x <= x1 && c.u.trim());
    if (!cs.length) continue;
    const size = Math.max(...cs.map((c) => c.size)); const base = Math.min(...cs.map((c) => c.y));
    out.push([Math.min(...cs.map((c) => c.x)), base - size * 0.22, Math.max(...cs.map((c) => c.x + c.w)), base + size * 0.82]);
  }
  return out;
}

function PageCanvas({ doc, page, scale, rotate, cache, onReady }: { doc: PdfDoc; page: PdfPage; scale: number; rotate: number; cache: DecodedImages; onReady?: (warn: string[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null); const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const t = pageTransform(page, scale, rotate);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setVisible(true); }, { rootMargin: "600px" });
    io.observe(el); return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !ref.current) return; let live = true;
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const off = document.createElement("canvas");
    void renderPage(doc, page, off, { scale: scale * dpr, rotate, deadline: Date.now() + 20000 }, cache).then((r) => {
      const c = ref.current; if (!live || !c) return;
      c.width = off.width; c.height = off.height; c.getContext("2d")!.drawImage(off, 0, 0); onReady?.(r.warnings);
    }).catch((e) => onReady?.([String((e as Error).message)]));
    return () => { live = false; };
  }, [visible, doc, page, scale, rotate, cache]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={box} style={{ width: t.w, height: t.h, background: "#fff", position: "absolute", inset: 0 }}><canvas ref={ref} style={{ width: t.w, height: t.h, display: "block" }} aria-hidden="true" /></div>;
}

export default function PdfModule({ win }: ModuleProps) {
  const shell = useShell();
  const [path, setPath] = useState<string>((win.props.path as string) ?? "");
  const [name, setName] = useState("document.pdf");
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const pwRef = useRef<string | undefined>(undefined);
  const undo = useRef<Rev[]>([]); const redo = useRef<Rev[]>([]);
  const [hist, setHist] = useState({ u: 0, r: 0 });
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState(path ? "" : "Open a PDF from Files, or choose one from this device");
  const [err, setErr] = useState("");
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [viewRot, setViewRot] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<[number, number, number]>(COLORS[0][1]);
  const [cur, setCur] = useState(0);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [panel, setPanel] = useState<Panel>("pages");
  const [query, setQuery] = useState(""); const [hits, setHits] = useState<Hit[]>([]); const [hitIdx, setHitIdx] = useState(0);
  const [drag, setDrag] = useState<{ page: number; pts: number[] } | null>(null);
  const [stageW, setStageW] = useState(800);
  const [warn, setWarn] = useState<string[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgCache = useMemo<DecodedImages>(() => new Map(), [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = useMemo(() => doc?.pages() ?? [], [doc]);
  const linesOf = useCallback((i: number) => {
    if (!doc) return [];
    let m = TEXT.get(doc); if (!m) { m = new Map(); TEXT.set(doc, m); }
    let l = m.get(i); if (!l) { try { l = layout(pageChars(doc, pages[i], { deadline: Date.now() + 5000 })); } catch { l = []; } m.set(i, l); }
    return l ?? [];
  }, [doc, pages]);

  useEffect(() => { const el = stageRef.current; if (!el) return; const ro = new ResizeObserver(() => setStageW(el.clientWidth)); ro.observe(el); setStageW(el.clientWidth); return () => ro.disconnect(); }, []);
  const scaleFor = (p: PdfPage) => {
    const sideways = ((p.rotate + viewRot) % 180) !== 0;
    const w = Math.max(1, (sideways ? p.crop[3] - p.crop[1] : p.crop[2] - p.crop[0]) * p.userUnit);
    const requested = zoom === "fit" ? (stageW - 48) / w : zoom;
    return boundedPageScale(p, requested, viewRot);
  };

  /* ------------------------------------------------------------ open */
  const openBytes = useCallback(async (bytes: Uint8Array, nm: string) => {
    if (bytes.length > MAX_PDF_BYTES) throw new Error("the file exceeds the 256 MiB guard");
    let pw: string | undefined; let d: PdfDoc | null = null;
    for (let attempt = 0; attempt < 4 && !d; attempt++) {
      try { d = PdfDoc.open(bytes, pw); }
      catch (e) {
        if (!(e instanceof PasswordRequired)) throw e;
        const v = await askText(attempt ? "Wrong password — try again" : `"${nm}" is password-protected`, "", { secret: true, okLabel: "Open", detail: "The password is used on this device only; it is never sent or stored." });
        if (v === null) throw new Error("it is password-protected and no password was entered"); pw = v;
      }
    }
    if (!d) throw new Error("wrong password");
    pwRef.current = pw; undo.current = [{ bytes, what: "open" }]; redo.current = []; setHist({ u: 0, r: 0 });
    setDoc(d); setName(nm); setCur(0); setSel(new Set()); setHits([]); setDirty(false); setErr(""); setWarn(d.warnings.map((w) => `PDF: ${w}`));
    const n = d.pages().length; const perms = d.sec?.permissions;
    setStatus(`Opened ${nm} · ${n} page${n === 1 ? "" : "s"} · PDF ${d.version}${d.sec ? ` · encrypted (${d.sec.unlockedAs ?? "user"} password${perms && !perms.modify ? "; the author restricts editing" : ""})` : ""}${d.recovered ? " · damaged cross-reference rebuilt" : ""}`);
  }, []);
  useEffect(() => {
    if (!path) return;
    let live = true;
    (async () => {
      try {
        const r = await api<{ node: { content: string; encoding?: string; name: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
        const bytes = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
        if (live) await openBytes(bytes, path.split("/").pop() || "document.pdf");
      } catch (e) { if (live) { setErr(`Could not open ${path}: ${(e as Error).message}`); } }
    })();
    return () => { live = false; };
  }, [path, openBytes]);

  /* ------------------------------------------------------------ edits: every edit is a new incremental revision */
  const apply_ = useCallback((what: string, fn: (ed: PdfEditor) => void, after?: (d: PdfDoc) => void) => {
    if (!doc) return false;
    try {
      const ed = new PdfEditor(doc); fn(ed);
      const bytes = ed.save(); const nd = PdfDoc.open(bytes, pwRef.current);
      undo.current.push({ bytes, what }); if (undo.current.length > 40) undo.current.splice(1, 1); redo.current = [];
      setHist({ u: undo.current.length - 1, r: 0 }); setDoc(nd); setDirty(true); setStatus(`${what} · ${(bytes.length / 1024).toFixed(1)} KB`); after?.(nd);
      return true;
    } catch (e) { shell.toast(`${what} failed: ${(e as Error).message}`, "bad"); return false; }
  }, [doc, shell]);
  const step = (dir: -1 | 1) => {
    if (dir < 0 && undo.current.length > 1) { redo.current.push(undo.current.pop()!); }
    else if (dir > 0 && redo.current.length) { undo.current.push(redo.current.pop()!); } else return;
    const top = undo.current[undo.current.length - 1]; setDoc(PdfDoc.open(top.bytes, pwRef.current)); setDirty(undo.current.length > 1);
    setHist({ u: undo.current.length - 1, r: redo.current.length }); setStatus(dir < 0 ? "Undone" : "Redone");
  };
  const curBytes = () => undo.current[undo.current.length - 1]?.bytes ?? null;
  /** a revision produced outside PdfEditor (signing): the bytes are kept exactly as produced */
  const pushRevision = (bytes: Uint8Array, what: string) => {
    let nd: PdfDoc; try { nd = PdfDoc.open(bytes, pwRef.current); } catch (e) { shell.toast(`${what} failed: ${(e as Error).message}`, "bad"); return; }
    undo.current.push({ bytes, what }); if (undo.current.length > 40) undo.current.splice(1, 1); redo.current = [];
    setHist({ u: undo.current.length - 1, r: 0 }); setDoc(nd); setDirty(true); setStatus(`${what} · ${(bytes.length / 1024).toFixed(1)} KB`);
  };
  const openRevision = async (bytes: Uint8Array, label: string) => {
    if (dirty && !(await askConfirm({ title: "Open the signed version?", detail: "Unsaved changes in this window will be discarded.", okLabel: "Open" }))) return;
    try { await openBytes(bytes, `${name.replace(/\.pdf$/i, "")} — ${label}.pdf`); setPath(""); setPanel("sigs"); } catch (e) { shell.toast(`Could not open: ${(e as Error).message}`, "bad"); }
  };
  const signedNames = useMemo(() => { if (!doc) return new Set<string>(); try { return new Set(signatureFields(doc).map((f) => f.name)); } catch { return new Set<string>(); } }, [doc]);
  const sigCount = signedNames.size;

  /* ------------------------------------------------------------ save */
  const writeFile = async (dest: string, bytes: Uint8Array, label: string) => {
    try { await post("/api/fs", { op: "upload", path: dest, content: toB64(bytes), mime: "application/pdf" }); }
    catch (e) { shell.toast(`Not saved: ${(e as Error).message}`, "bad"); return false; }
    setStatus(`${label} ${dest} (${(bytes.length / 1024).toFixed(1)} KB)`); shell.bumpRefresh(); return true;
  };
  const save = async () => {
    const b = curBytes(); if (!b) return;
    let dest = path;
    if (!dest) { const v = await askText("Save PDF as", `/Documents/${name.replace(/\.pdf$/i, "")}.pdf`, { okLabel: "Save" }); if (!v) return; dest = v.endsWith(".pdf") ? v : `${v}.pdf`; }
    if (await writeFile(dest, b, "Saved (incremental update, original bytes kept)")) { setDirty(false); if (dest !== path) { setPath(dest); shell.dispatch({ t: "setProps", id: win.id, props: { path: dest, title: dest.split("/").pop() } }); } }
  };
  const saveClean = async () => {
    if (!doc) return; const v = await askText("Save a clean copy as", (path || `/Documents/${name}`).replace(/\.pdf$/i, "") + " (clean).pdf", { okLabel: "Save copy", detail: "Rewrites only what is still in the document: deleted pages, removed annotations and earlier revisions are left out of the copy." });
    if (!v) return; try { await writeFile(v.endsWith(".pdf") ? v : `${v}.pdf`, new PdfEditor(doc).saveClean(), "Saved clean copy"); } catch (e) { shell.toast(`Not saved: ${(e as Error).message}`, "bad"); }
  };
  const download = () => { const b = curBytes(); if (!b) return; const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([b as Uint8Array<ArrayBuffer>], { type: "application/pdf" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  const pick = (f: File | undefined) => { if (!f) return; void f.arrayBuffer().then((ab) => openBytes(new Uint8Array(ab), f.name)).then(() => setPath("")).catch((e) => shell.toast(`Could not open ${f.name}: ${(e as Error).message}`, "bad")); };

  /* ------------------------------------------------------------ page operations */
  const targets = () => (sel.size ? [...sel].sort((a, b) => a - b) : [cur]);
  const rotatePages = (d: number) => apply_(`Rotate ${targets().length} page(s)`, (ed) => targets().forEach((i) => ed.rotate(i, d)));
  const deletePages = () => { const t = targets(); if (t.length >= pages.length) { shell.toast("A PDF keeps at least one page", "warn"); return; } if (apply_(`Delete ${t.length} page(s)`, (ed) => ed.deletePages(t))) { setSel(new Set()); setCur((c) => Math.min(c, pages.length - t.length - 1)); } };
  const movePage = (d: -1 | 1) => { const to = cur + d; if (to < 0 || to >= pages.length) return; if (apply_("Move page", (ed) => ed.movePage(cur, to))) { setCur(to); setSel(new Set()); } };
  const insertBlank = () => { const p = pages[cur]; apply_("Insert blank page", (ed) => ed.insertBlank(cur + 1, p ? p.media[2] - p.media[0] : 612, p ? p.media[3] - p.media[1] : 792)); };
  const merge = async (f: File | undefined) => {
    if (!f || !doc) return; let other: PdfDoc;
    try { other = PdfDoc.open(new Uint8Array(await f.arrayBuffer())); } catch (e) { shell.toast(`Cannot merge ${f.name}: ${(e as Error).message}`, "bad"); return; }
    apply_(`Merge ${f.name} (${other.pages().length} pages)`, (ed) => ed.importPages(other, other.pages().map((_, i) => i)));
  };
  const extract = async () => {
    if (!doc) return; const t = targets();
    const v = await askText(`Extract ${t.length} page(s) to a new PDF`, (path || `/Documents/${name}`).replace(/\.pdf$/i, "") + ` (pages ${t.map((i) => i + 1).join(",")}).pdf`, { okLabel: "Extract" });
    if (!v) return; try { await writeFile(v.endsWith(".pdf") ? v : `${v}.pdf`, extractPages(doc, t), "Extracted to"); } catch (e) { shell.toast(`Extract failed: ${(e as Error).message}`, "bad"); }
  };

  /* ------------------------------------------------------------ find */
  const runFind = (q: string) => {
    setQuery(q); if (!doc || !q.trim()) { setHits([]); return; }
    const all: Hit[] = []; for (let i = 0; i < pages.length && all.length < 2000; i++) all.push(...search(linesOf(i), q, i));
    setHits(all); setHitIdx(0); if (all[0]) goTo(all[0].page);
  };
  const goTo = (i: number) => { setCur(i); document.getElementById(`${win.id}-pdfpage-${i}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const copyText = async () => { if (!doc) return; const t = linesOf(cur).map((l) => l.text).join("\n"); try { await navigator.clipboard.writeText(t); setStatus(`Copied the text of page ${cur + 1} (${t.length} characters)`); } catch { shell.toast("Clipboard access was refused", "warn"); } };
  const exportText = async () => { if (!doc) return; const all = pages.map((_, i) => linesOf(i).map((l) => l.text).join("\n")).join("\n\f\n"); const v = await askText("Export the text as", (path || `/Documents/${name}`).replace(/\.pdf$/i, ".txt"), { okLabel: "Export" }); if (!v) return; try { await post("/api/fs", { op: "write", path: v, content: all }); setStatus(`Exported text to ${v} (${all.length} characters)`); shell.bumpRefresh(); } catch (e) { shell.toast(`Not exported: ${(e as Error).message}`, "bad"); } };

  /* ------------------------------------------------------------ annotation input */
  const toUser = (pi: number, e: React.PointerEvent) => { const p = pages[pi]; const t = pageTransform(p, scaleFor(p), viewRot); const inv = invert(t.m as M); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return inv ? apply(inv, e.clientX - r.left, e.clientY - r.top) : [0, 0]; };
  const down = (pi: number, e: React.PointerEvent) => {
    setCur(pi); if (tool === "select") return; e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = toUser(pi, e);
    if (tool === "note") { void (async () => { const t = await askText("Note", "", { okLabel: "Add note" }); if (t === null) return; apply_("Add note", (ed) => ed.addAnnotation(pi, { type: "Text", rect: [x, y - 20, x + 20, y], contents: t, color })); })(); return; }
    setDrag({ page: pi, pts: [x, y, x, y] });
  };
  const move = (pi: number, e: React.PointerEvent) => { if (!drag || drag.page !== pi) return; const [x, y] = toUser(pi, e); setDrag((d) => d && (tool === "ink" ? { ...d, pts: [...d.pts, x, y] } : { ...d, pts: [d.pts[0], d.pts[1], x, y] })); };
  const up = (pi: number) => {
    const d = drag; setDrag(null); if (!d || d.page !== pi) return;
    const [x0, y0] = d.pts; const x1 = d.pts[d.pts.length - 2], y1 = d.pts[d.pts.length - 1];
    const r = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    if (tool === "ink") { if (d.pts.length >= 6) apply_("Draw", (ed) => ed.addAnnotation(pi, { type: "Ink", ink: [d.pts.slice(2)], color, width: 2 })); return; }
    if (tool === "highlight" || tool === "underline" || tool === "strike") {
      let rects = textRects(linesOf(pi), r); if (!rects.length) { if (r[2] - r[0] < 3 || r[3] - r[1] < 3) return; rects = [r]; }
      const type: AnnotSpec["type"] = tool === "highlight" ? "Highlight" : tool === "underline" ? "Underline" : "StrikeOut";
      apply_(type === "StrikeOut" ? "Strike out" : type, (ed) => ed.addAnnotation(pi, { type, rects, color: tool === "highlight" ? color : color[0] + color[1] + color[2] > 2.4 ? [0.9, 0.15, 0.15] : color }));
      return;
    }
    if (r[2] - r[0] < 4 || r[3] - r[1] < 4) return;
    if (tool === "box" || tool === "ellipse") { apply_(tool === "box" ? "Box" : "Ellipse", (ed) => ed.addAnnotation(pi, { type: tool === "box" ? "Square" : "Circle", rect: r, color, width: 2 })); return; }
    if (tool === "text") void (async () => { const t = await askText("Text box", "", { okLabel: "Add" }); if (!t) return; apply_("Text box", (ed) => ed.addAnnotation(pi, { type: "FreeText", rect: r, contents: t, color: color[0] + color[1] + color[2] > 2.4 ? [0, 0, 0] : color, fontSize: ANNOT_FONT_PT })); })();
  };

  /* ------------------------------------------------------------ forms + info */
  const fields = useMemo(() => { if (!doc) return []; try { return new PdfEditor(doc).fields(); } catch { return []; } }, [doc]);
  const fill = (fname: string, v: string | boolean) => apply_(`Fill "${fname}"`, (ed) => { if (!ed.fillField(fname, v)) throw new Error("the field is read-only or unknown"); });
  const info = useMemo(() => (doc ? doc.info() : {}), [doc]);
  const editInfo = async (k: "Title" | "Author" | "Subject" | "Keywords") => { const v = await askText(k, info[k] ?? "", { okLabel: "Set" }); if (v === null) return; apply_(`Set ${k.toLowerCase()}`, (ed) => ed.setInfo({ [k]: v })); };

  /* ------------------------------------------------------------ keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!t?.closest?.(`[data-pdf-win="${win.id}"]`)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); step(e.shiftKey ? 1 : -1); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); step(1); }
      else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
      else if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); setPanel("find"); setTimeout(() => (document.getElementById(`${win.id}-pdffind`) as HTMLInputElement | null)?.focus(), 0); }
      else if (e.key === "PageDown") { e.preventDefault(); goTo(Math.min(pages.length - 1, cur + 1)); }
      else if (e.key === "PageUp") { e.preventDefault(); goTo(Math.max(0, cur - 1)); }
      else if (e.key === "Escape") { setTool("select"); setDrag(null); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });

  /* ------------------------------------------------------------ render */
  const bar: CSSProperties = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "6px 8px", borderBottom: "1px solid var(--fs-border)" };
  const curHit = hits[hitIdx];
  return (
    <div data-testid="pdf-app" data-pdf-win={win.id} tabIndex={-1} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, outline: "none" }}>
      {/* TT80 banner: Keep · Tweak · Ink · Glance over one tool strip */}
      <AppBanner label="PDF">
        <BannerGroup name="Keep">
          <label className="fs-btn" style={{ cursor: "pointer" }}>Open…<input data-testid="pdf-open" type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files?.[0])} /></label>
          <Btn data-testid="pdf-save" variant="primary" onClick={() => void save()} disabled={!doc}>Save</Btn>
          <Btn data-testid="pdf-clean" onClick={() => void saveClean()} disabled={!doc} title="Rewrite without deleted content or earlier revisions">Clean copy</Btn>
          <Btn onClick={download} disabled={!doc}>Download</Btn>
        </BannerGroup>
        <BannerGroup name="Tweak">
          <Btn data-testid="pdf-undo" onClick={() => step(-1)} disabled={!hist.u} title="Undo (Ctrl+Z)">Undo</Btn>
          <Btn data-testid="pdf-redo" onClick={() => step(1)} disabled={!hist.r} title="Redo (Ctrl+Y)">Redo</Btn>
        </BannerGroup>
        <BannerGroup name="Ink">
          {TOOLS.map(([id, label, tip]) => <Btn key={id} data-testid={`pdf-tool-${id}`} variant={tool === id ? "primary" : "ghost"} onClick={() => setTool(id)} title={tip} disabled={!doc}>{label}</Btn>)}
          {COLORS.map(([n, c]) => <button key={n} type="button" aria-label={`${n} colour`} aria-pressed={color === c} onClick={() => setColor(c)} style={{ width: 24, height: 24, borderRadius: 12, background: css3(c), border: color === c ? "3px solid var(--fs-accent)" : "1.5px solid rgba(255,255,255,.55)", cursor: "pointer" }} />)}
        </BannerGroup>
        <BannerGroup name="Glance">
          <Btn onClick={() => setZoom((z) => Math.max(0.25, +((z === "fit" ? scaleFor(pages[cur] ?? pages[0]) : z) / 1.2).toFixed(2)))} disabled={!doc} title="Zoom out" aria-label="Zoom out">−</Btn>
          <span data-testid="pdf-zoom" style={{ minWidth: 48, textAlign: "center", fontSize: fz(12) }}>{zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
          <Btn onClick={() => setZoom((z) => Math.min(4, +((z === "fit" ? scaleFor(pages[cur] ?? pages[0]) : z) * 1.2).toFixed(2)))} disabled={!doc} title="Zoom in" aria-label="Zoom in">+</Btn>
          <Btn onClick={() => setZoom("fit")} disabled={!doc}>Fit width</Btn>
          <Btn onClick={() => setZoom(1)} disabled={!doc}>100%</Btn>
          <Btn onClick={() => setViewRot((r) => (r + 90) % 360)} disabled={!doc} title="Rotate the view (does not change the file)" aria-label="Rotate the view"><span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>View <Ico d={ICON.rotR} label="" /></span></Btn>
        </BannerGroup>
      </AppBanner>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside style={{ width: 248, borderRight: "1px solid var(--fs-border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: 2, padding: 4 }}>
            {(["pages", "find", "forms", "sigs", "info"] as Panel[]).map((p) => <Btn key={p} role="tab" aria-selected={panel === p} data-testid={`pdf-panel-${p}`} variant={panel === p ? "primary" : "ghost"} onClick={() => setPanel(p)}>{p === "pages" ? "Pages" : p === "find" ? "Find" : p === "forms" ? `Forms${fields.length ? ` (${fields.length})` : ""}` : p === "sigs" ? `Signatures${sigCount ? ` (${sigCount})` : ""}` : "Info"}</Btn>)}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 6, minHeight: 0 }}>
            {panel === "pages" && doc ? (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                  <Btn data-testid="pdf-rot-left" onClick={() => rotatePages(-90)} title="Rotate left" aria-label="Rotate left"><Ico d={ICON.rotL} label="Rotate left" /></Btn>
                  <Btn data-testid="pdf-rot-right" onClick={() => rotatePages(90)} title="Rotate right" aria-label="Rotate right"><Ico d={ICON.rotR} label="Rotate right" /></Btn>
                  <Btn data-testid="pdf-move-up" onClick={() => movePage(-1)} disabled={cur === 0} title="Move page up" aria-label="Move page up"><Ico d={ICON.up} label="Move page up" /></Btn>
                  <Btn data-testid="pdf-move-down" onClick={() => movePage(1)} disabled={cur >= pages.length - 1} title="Move page down" aria-label="Move page down"><Ico d={ICON.down} label="Move page down" /></Btn>
                  <Btn data-testid="pdf-insert" onClick={insertBlank} title="Insert a blank page after this one">+ Blank</Btn>
                  <Btn data-testid="pdf-delete" variant="danger" onClick={deletePages}>Delete</Btn>
                  <label className="fs-btn" style={{ cursor: "pointer" }}>Merge…<input data-testid="pdf-merge" type="file" accept="application/pdf,.pdf" hidden onChange={(e) => void merge(e.target.files?.[0])} /></label>
                  <Btn data-testid="pdf-extract" onClick={() => void extract()}>Extract</Btn>
                </div>
                <div className="fs-dim" style={{ fontSize: fz(11), marginBottom: 4 }}>Ctrl/Shift-click to select several pages</div>
                {pages.map((p, i) => {
                  const ts = 150 / Math.max(1, (p.rotate % 180 ? p.crop[3] - p.crop[1] : p.crop[2] - p.crop[0]) * p.userUnit); const t = pageTransform(p, ts, 0);
                  return (
                    <button key={`${i}-${p.ref?.num ?? i}`} type="button" data-testid="pdf-thumb" aria-label={`Page ${i + 1}`} aria-current={i === cur} onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) setSel((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; }); else { setSel(new Set()); goTo(i); } }}
                      style={{ display: "block", margin: "0 auto 8px", padding: 3, border: i === cur ? "2px solid var(--fs-accent)" : sel.has(i) ? "2px dashed var(--fs-accent)" : "2px solid transparent", borderRadius: 6, background: "none", cursor: "pointer" }}>
                      <div style={{ position: "relative", width: t.w, height: t.h, boxShadow: "0 1px 4px rgba(0,0,0,.2)" }}><PageCanvas doc={doc} page={p} scale={ts} rotate={0} cache={imgCache} /></div>
                      <div style={{ fontSize: fz(11), textAlign: "center" }}>{i + 1}</div>
                    </button>
                  );
                })}
              </>
            ) : null}
            {panel === "find" && doc ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input id={`${win.id}-pdffind`} data-testid="pdf-find" className="fs-input" placeholder="Find in document" value={query} onChange={(e) => runFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && hits.length) { const n = (hitIdx + (e.shiftKey ? hits.length - 1 : 1)) % hits.length; setHitIdx(n); goTo(hits[n].page); } }} aria-label="Find in document" />
                <div data-testid="pdf-hits" style={{ fontSize: fz(12) }}>{query ? `${hits.length} match${hits.length === 1 ? "" : "es"}${hits.length ? ` · ${hitIdx + 1} of ${hits.length}` : ""}` : ""}</div>
                <div style={{ display: "flex", gap: 4 }}><Btn onClick={() => { if (!hits.length) return; const n = (hitIdx + hits.length - 1) % hits.length; setHitIdx(n); goTo(hits[n].page); }}>Previous</Btn><Btn onClick={() => { if (!hits.length) return; const n = (hitIdx + 1) % hits.length; setHitIdx(n); goTo(hits[n].page); }}>Next</Btn></div>
                <Btn data-testid="pdf-copytext" onClick={() => void copyText()}>Copy page text</Btn>
                <Btn data-testid="pdf-exporttext" onClick={() => void exportText()}>Export text (.txt)</Btn>
                {hits.slice(0, 200).map((h, k) => { const l = linesOf(h.page)[h.line]; return <button key={k} type="button" onClick={() => { setHitIdx(k); goTo(h.page); }} style={{ textAlign: "left", fontSize: fz(11.5), background: k === hitIdx ? "var(--fs-hover)" : "none", border: 0, padding: "3px 4px", cursor: "pointer", color: "inherit" }}><b>p{h.page + 1}</b> {l?.text.slice(Math.max(0, h.start - 24), h.end + 24)}</button>; })}
              </div>
            ) : null}
            {panel === "forms" && doc ? (
              <div data-testid="pdf-forms" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {!fields.length ? <div className="fs-dim" style={{ fontSize: fz(12) }}>This document has no form fields.</div> : null}
                {fields.map((f) => (
                  <label key={f.name} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: fz(12) }}>
                    <span>{f.name}{f.flags & 1 ? " (read-only)" : ""}</span>
                    {f.type === "Btn" && !(f.flags & (1 << 16)) ? <input type="checkbox" data-testid="pdf-field" checked={!!f.value && f.value !== "Off"} disabled={!!(f.flags & 1)} onChange={(e) => fill(f.name, e.target.checked)} />
                      : f.type === "Ch" ? <select className="fs-input" data-testid="pdf-field" value={f.value} disabled={!!(f.flags & 1)} onChange={(e) => fill(f.name, e.target.value)}>{["", ...f.options].map((o) => <option key={o} value={o}>{o || "—"}</option>)}</select>
                      : f.type === "Tx" ? <input className="fs-input" data-testid="pdf-field" defaultValue={f.value} disabled={!!(f.flags & 1)} onBlur={(e) => { if (e.target.value !== f.value) fill(f.name, e.target.value); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                      : f.type === "Sig" ? <button type="button" data-testid="pdf-field-sig" onClick={() => setPanel("sigs")} style={{ background: "none", border: 0, padding: 0, color: "inherit", textAlign: "left", cursor: "pointer", textDecoration: "underline" }}>{signedNames.has(f.name) ? "signed — see Signatures" : "empty signature field — sign in Signatures"}</button>
                      : <span className="fs-dim">button</span>}
                  </label>
                ))}
              </div>
            ) : null}
            {panel === "sigs" && doc ? <PdfSignatures doc={doc} dirty={dirty} page={cur} onSigned={pushRevision} onOpenRevision={(b, l) => void openRevision(b, l)} toast={shell.toast} /> : null}
            {panel === "info" && doc ? (
              <dl data-testid="pdf-info" style={{ fontSize: fz(12), margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 8px" }}>
                {(["Title", "Author", "Subject", "Keywords"] as const).map((k) => <Fragment key={k}><dt style={{ fontWeight: 600 }}>{k}</dt><dd style={{ margin: 0 }}><button type="button" data-testid={`pdf-info-${k}`} onClick={() => void editInfo(k)} style={{ background: "none", border: 0, padding: 0, color: "inherit", textAlign: "left", cursor: "pointer", textDecoration: "underline dotted" }}>{info[k] || "—"}</button></dd></Fragment>)}
                {(["Creator", "Producer", "CreationDate", "ModDate"] as const).map((k) => <Fragment key={k}><dt style={{ fontWeight: 600 }}>{k}</dt><dd style={{ margin: 0, wordBreak: "break-word" }}>{info[k] || "—"}</dd></Fragment>)}
                <dt style={{ fontWeight: 600 }}>Pages</dt><dd style={{ margin: 0 }}>{pages.length}</dd>
                <dt style={{ fontWeight: 600 }}>Version</dt><dd style={{ margin: 0 }}>PDF {doc.version}</dd>
                <dt style={{ fontWeight: 600 }}>Page unit</dt><dd style={{ margin: 0 }}>{pages[cur]?.userUnit ?? 1} × 1/72 in</dd>
                <dt style={{ fontWeight: 600 }}>Security</dt><dd style={{ margin: 0 }}>{doc.sec ? `encrypted, R${(doc.sec as unknown as { R: number }).R}` : "none"}</dd>
                <dt style={{ fontWeight: 600 }}>Revisions</dt><dd style={{ margin: 0 }}>{hist.u} unsaved edit(s)</dd>
              </dl>
            ) : null}
          </div>
        </aside>
        <div ref={stageRef} data-testid="pdf-stage" style={{ flex: 1, overflow: "auto", background: "var(--fs-surface-2, #e8eaef)", minHeight: 0, minWidth: 0 }}>
          {err ? <div role="alert" style={{ padding: 16, color: STAGE_INK }}><Badge tone="bad">Error</Badge> {err}</div> : null}
          {!doc && !err ? <div style={{ padding: 24, fontSize: fz(14), color: STAGE_INK }}>{status || "Loading…"}</div> : null}
          {doc ? pages.map((p, i) => {
            const s = scaleFor(p); const t = pageTransform(p, s, viewRot);
            const toDev = (x: number, y: number) => apply(t.m as M, x, y);
            const rectPts = (r: number[]) => { const a = toDev(r[0], r[1]), b = toDev(r[2], r[3]); return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }; };
            const pageHits = hits.filter((h) => h.page === i);
            return (
              <div key={`${i}-${p.ref?.num ?? i}`} id={`${win.id}-pdfpage-${i}`} data-testid="pdf-page" data-page={i} style={{ position: "relative", width: t.w, height: t.h, margin: "16px auto", boxShadow: "0 2px 10px rgba(0,0,0,.18)" }}>
                <PageCanvas doc={doc} page={p} scale={s} rotate={viewRot} cache={imgCache} onReady={(w) => { if (w.length) setWarn((o) => (o.length > 20 ? o : [...o, ...w.map((x) => `p${i + 1}: ${x}`)])); }} />
                <svg width={t.w} height={t.h} style={{ position: "absolute", inset: 0, cursor: tool === "select" ? "default" : "crosshair", touchAction: "none" }}
                  onPointerDown={(e) => down(i, e)} onPointerMove={(e) => move(i, e)} onPointerUp={() => up(i)} aria-label={`Page ${i + 1}`} role="img">
                  {pageHits.map((h, k) => h.rects.map((r, j) => { const q = rectPts(r); return <rect key={`${k}-${j}`} x={q.x} y={q.y} width={q.w} height={q.h} fill={h === curHit ? "rgba(255,140,0,.45)" : "rgba(255,220,0,.35)"} />; }))}
                  {drag && drag.page === i ? (tool === "ink"
                    ? <polyline points={Array.from({ length: (drag.pts.length - 2) / 2 }, (_, k) => toDev(drag.pts[2 + k * 2], drag.pts[3 + k * 2]).join(",")).join(" ")} fill="none" stroke={css3(color)} strokeWidth={2 * s} strokeLinecap="round" strokeLinejoin="round" />
                    : (() => { const q = rectPts(drag.pts); return tool === "ellipse" ? <ellipse cx={q.x + q.w / 2} cy={q.y + q.h / 2} rx={q.w / 2} ry={q.h / 2} fill="none" stroke={css3(color)} strokeWidth={2} strokeDasharray="4 3" /> : <rect x={q.x} y={q.y} width={q.w} height={q.h} fill={tool === "highlight" ? css3(color) : "none"} fillOpacity={0.3} stroke={css3(color)} strokeWidth={1.5} strokeDasharray="4 3" />; })()) : null}
                </svg>
              </div>
            );
          }) : null}
        </div>
      </div>
      <div data-testid="pdf-status" role="status" style={{ padding: "4px 10px", borderTop: "1px solid var(--fs-border)", fontSize: fz(12), display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span>{status}</span>{dirty ? <Badge tone="warn">unsaved</Badge> : null}
        {doc ? <span className="fs-dim">page {cur + 1} / {pages.length}</span> : null}
        {warn.length ? <span title={warn.join("\n")}><Badge tone="info">{warn.length} PDF note(s)</Badge></span> : null}
      </div>
    </div>
  );
}
