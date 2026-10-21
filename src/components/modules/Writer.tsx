"use client";
/**
 * Writer (TT46) — on-device WYSIWYG word processor over a lossless WordprocessingML engine.
 * - .docx opens, edits and saves in the browser (no server round-trip of document content); untouched parts and
 *   paragraphs are written back byte-for-byte, edited paragraphs keep every property the editor does not change.
 * - Paged view (page size/margins from the document), headers/footers with PAGE/NUMPAGES, footnotes, comments,
 *   tracked changes (accept/reject all), lists, tables, images, hyperlinks, styles, find/replace, undo/redo,
 *   page setup, print/PDF, navigation pane, word count, AutoSave. Legacy .fdoc files still open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fz, useUiUnit } from "@/lib/uiscale";
import { api, post } from "@/lib/api";
import { toB64, fromB64 } from "@/lib/crypto";
import { useShell, type ModuleProps } from "../shell-context";
import { Btn } from "../ui";
import { askPassword, isEncryptedOffice, lockedProtection, saveBlocked, sealPackage, unlockOffice, type Protection } from "@/lib/office/unlock";
import { allParas, blankWord, docText, effectivePara, makeImage, paraText, readWord, resizeImage, styleChain, writeWord, type Block, type Para, type Tok, type WordDoc } from "@/lib/office/wordml";
import * as E from "@/lib/office/wordedit";
import { hfLines, removeHf, setDifferentFirst, setHf, type HfAlign, type HfKind, type HfLine, type HfType } from "@/lib/office/hdrftr";
import type { XEl } from "@/lib/office/xmltree";
import { domToPos, geomOf, makeState, paginate, posToDom, renderBlocks, renderPara, cssFont } from "./writer/view";

type Panel = "none" | "find" | "review" | "nav" | "page" | "hf";
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FONTS = ["Calibri", "Cambria", "Arial", "Times New Roman", "Georgia", "Verdana", "Courier New", "Consolas", "Segoe UI", "Aptos"];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
const HIGHLIGHTS = ["yellow", "green", "cyan", "magenta", "red", "lightGray"];

/** hf: header/footer state (parts are replaced, never mutated, by setHf — a shallow copy is a true snapshot) */
interface Snap { blocks: Block[]; sel: E.Range | null; hf?: { parts: Map<string, Block[]>; sect?: XEl; page: WordDoc["page"] } }
// the final sectPr is copy-on-write (hdrftr.editSect / setPageSetup), so the snapshot holds it by reference — a clone would
// not be the node in the restored block list and writeWord would then emit a second <w:sectPr>
const hfSnap = (d: WordDoc): Snap["hf"] => ({ parts: new Map(d.parts), sect: d.finalSect, page: { ...d.page } });

export default function WriterModule({ win }: ModuleProps) {
  const shell = useShell();
  const unit = useUiUnit();
  const [path, setPath] = useState<string>((win.props.path as string) ?? "");
  const docRef = useRef<WordDoc | null>(null);
  /** TT47: set while the open document came from a password-protected file (Fusion decrypts but cannot re-encrypt). */
  /** TT47/48: password protection of the open document (password kept in this window's memory only). */
  const encRef = useRef<Protection | null>(null);
  const [locked, setLocked] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const selRef = useRef<E.Range | null>(null);
  const pendingFmt = useRef<Record<string, unknown> | null>(null);
  const undo = useRef<Snap[]>([]), redo = useRef<Snap[]>([]);
  const lastTyping = useRef(0);
  const composing = useRef<E.Range | null>(null);
  const [ver, setVer] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [zoom, setZoom] = useState<number | null>(null);
  const [pages, setPages] = useState(1);
  const [panel, setPanel] = useState<Panel>("none");
  const [pop, setPop] = useState<"" | "link" | "table" | "comment" | "saveas">("");
  const [popVal, setPopVal] = useState(""); const [popVal2, setPopVal2] = useState("");
  const [find, setFind] = useState({ q: "", r: "", matchCase: false, wholeWord: false, at: -1 });
  const [imgSel, setImgSel] = useState<{ pid: string; off: number; w: number; h: number } | null>(null);
  const [autosave, setAutosave] = useState(false);
  const [tick, setTick] = useState(0); // toolbar refresh on selection change
  const [docGen, setDocGen] = useState(0); // bumps when a new document (or page geometry) must be fully rendered
  const [hfGen, setHfGen] = useState(0); // bumps when undo/redo changed headers/footers (the panel reloads; the caret is NOT reset)
  const fileInput = useRef<HTMLInputElement | null>(null), imgInput = useRef<HTMLInputElement | null>(null);
  const z = zoom ?? unit;
  const bump = () => setVer((v) => v + 1);

  /* ------------------------------------------------------------ rendering */
  const layoutTimer = useRef<number | null>(null);
  const relayout = useCallback(() => {
    const doc = docRef.current, root = rootRef.current, pg = pagesRef.current;
    if (!doc || !root || !pg) return;
    const g = geomOf(doc);
    const n = paginate(root, g);
    setPages(n);
    // page boxes + headers/footers
    pg.replaceChildren();
    const hdrRid = (i: number) => (i === 0 && doc.page.titlePg ? doc.page.firstHeaderRid : doc.page.headerRid);
    const ftrRid = (i: number) => (i === 0 && doc.page.titlePg ? doc.page.firstFooterRid : doc.page.footerRid);
    for (let i = 0; i < n; i++) {
      const box = document.createElement("div");
      box.className = "wpage"; box.style.cssText = `position:absolute;left:0;top:${i * (g.pageH + g.gap)}px;width:${g.pageW}px;height:${g.pageH}px`;
      box.dataset.page = String(i + 1);
      for (const [rid, isHdr] of [[hdrRid(i), true], [ftrRid(i), false]] as const) {
        const blocks = rid ? doc.parts.get(rid) : undefined;
        if (!blocks) continue;
        const hf = document.createElement("div");
        hf.className = isHdr ? "whdr" : "wftr";
        hf.style.cssText = `position:absolute;left:${g.left}px;right:${g.right}px;${isHdr ? `top:${doc.page.header / 15}px` : `bottom:${doc.page.footer / 15}px`};pointer-events:none;color:#333`;
        const st = makeState(doc, blocks, false); st.page = { n: i + 1, total: n };
        renderBlocks(st, blocks, hf);
        box.appendChild(hf);
      }
      pg.appendChild(box);
    }
    pg.style.height = `${n * (g.pageH + g.gap)}px`;
  }, []);
  const scheduleLayout = useCallback(() => { if (layoutTimer.current) window.clearTimeout(layoutTimer.current); layoutTimer.current = window.setTimeout(relayout, 120); }, [relayout]);

  const renderAll = useCallback(() => {
    const doc = docRef.current, root = rootRef.current;
    if (!doc || !root) return;
    root.querySelectorAll("img").forEach((i) => { if (i.src.startsWith("blob:")) URL.revokeObjectURL(i.src); });
    root.replaceChildren();
    const st = makeState(doc, doc.blocks);
    renderBlocks(st, doc.blocks, root);
    // footnotes / endnotes (view; kept verbatim on save)
    const notes = doc.notes.filter((n) => allParas(n.blocks).some((p) => paraText(p).trim()));
    if (notes.length) {
      const sec = document.createElement("div"); sec.className = "wnotes"; sec.contentEditable = "false";
      const h = document.createElement("div"); h.className = "wnotes-h"; h.textContent = "Notes"; sec.appendChild(h);
      for (const n of notes) {
        const row = document.createElement("div"); row.className = "wnote";
        const num = st.noteNo.get(`${n.type}:${n.id}`);
        const b = document.createElement("sup"); b.textContent = String(num ?? n.id); row.appendChild(b);
        const nst = makeState(doc, n.blocks, false);
        const inner = document.createElement("div"); renderBlocks(nst, n.blocks, inner); row.appendChild(inner);
        sec.appendChild(row);
      }
      root.appendChild(sec);
    }
    relayout();
  }, [relayout]);
  const renderParaOnly = useCallback((pid: string) => {
    const doc = docRef.current, root = rootRef.current;
    if (!doc || !root) return;
    const old = root.querySelector(`[data-pid="${pid}"]`);
    const p = E.paraById(doc, pid);
    if (!old || !p) { renderAll(); return; }
    old.replaceWith(renderPara(makeState(doc, doc.blocks), p));
    scheduleLayout();
  }, [renderAll, scheduleLayout]);

  const setSel = useCallback((r: E.Range | null) => {
    selRef.current = r;
    const root = rootRef.current; if (!r || !root) return;
    const a = posToDom(root, r.a), b = posToDom(root, r.b);
    if (!a || !b) return;
    const s = window.getSelection(); if (!s) return;
    try { s.setBaseAndExtent(a.node, a.offset, b.node, b.offset); } catch { /* node detached */ }
    // keep the caret visible
    const el = (b.node.nodeType === 1 ? b.node : b.node.parentElement) as HTMLElement | null;
    el?.scrollIntoView?.({ block: "nearest" });
  }, []);
  const readSel = useCallback((): E.Range | null => {
    const s = window.getSelection(); const root = rootRef.current;
    if (!s || !s.rangeCount || !root || !root.contains(s.anchorNode)) return selRef.current;
    const a = domToPos(s.anchorNode!, s.anchorOffset), b = domToPos(s.focusNode!, s.focusOffset);
    if (!a || !b) return selRef.current;
    return { a, b };
  }, []);
  const curSel = (): E.Range => {
    const r = readSel() ?? selRef.current;
    if (r) return r;
    const ps = allParas(docRef.current!.blocks); const last = ps[ps.length - 1];
    return { a: { pid: last.id, off: E.plen(last) }, b: { pid: last.id, off: E.plen(last) } };
  };
  const collapsed = (r: E.Range) => r.a.pid === r.b.pid && r.a.off === r.b.off;

  /* ------------------------------------------------------------ history */
  const snapshot = (typing = false) => {
    const doc = docRef.current!; const now = Date.now();
    if (typing && now - lastTyping.current < 1200 && undo.current.length) { lastTyping.current = now; return; }
    lastTyping.current = typing ? now : 0;
    undo.current.push({ blocks: E.cloneBlocks(doc.blocks), sel: selRef.current, hf: hfSnap(doc) });
    if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
  };
  const restore = (from: React.MutableRefObject<Snap[]>, to: React.MutableRefObject<Snap[]>) => {
    const doc = docRef.current!; const s = from.current.pop(); if (!s) return;
    to.current.push({ blocks: E.cloneBlocks(doc.blocks), sel: selRef.current, hf: hfSnap(doc) });
    doc.blocks = s.blocks;
    if (s.hf) {
      // only touch header/footer state when this step actually changed it: a full re-render (docGen) here would run
      // after setSel below and drop the caret on every ordinary Ctrl+Z (regression caught by e2e-tt46)
      const hfChanged = s.hf.parts.size !== doc.parts.size || [...s.hf.parts].some(([rid, b]) => doc.parts.get(rid) !== b)
        || s.hf.sect !== doc.finalSect;
      if (hfChanged) {
        for (const [rid, b] of s.hf.parts) if (doc.parts.get(rid) !== b) doc.hf.dirty.add(rid);
        doc.parts = new Map(s.hf.parts); doc.finalSect = s.hf.sect; doc.page = { ...s.hf.page };
        setHfGen((g) => g + 1);
      }
    }
    for (const p of allParas(doc.blocks)) p.dirty = true; // conservative: restored paragraphs regenerate (still lossless per run)
    renderAll(); if (s.sel) setSel(s.sel); setDirty(true); bump();
  };
  const changed = (pid?: string, sel?: E.Range | null) => {
    if (pid) renderParaOnly(pid); else renderAll();
    if (sel) setSel(sel);
    setDirty(true); bump();
  };

  /* ------------------------------------------------------------ load / save */
  const loadBytes = useCallback(async (bytes: Uint8Array, name: string, srcPath = "") => {
    let enc = "";
    if (isEncryptedOffice(bytes)) {
      // TT47: password-protected .docx — decrypted on this device (MS-OFFCRYPTO Agile/Standard); TT48: saves re-encrypt
      encRef.current = lockedProtection(srcPath); // set first: even a cancelled/failed open must never save plaintext over it
      const u = await unlockOffice(bytes, name);
      if (!u) throw new Error("it is password-protected and no password was entered");
      encRef.current = { ...encRef.current, password: u.password };
      bytes = u.bytes; enc = ` · password-protected (${u.method}${u.integrity === "verified" ? ", integrity verified" : ""}) — saves stay encrypted with the same password`;
    } else encRef.current = null;
    setLocked(!!encRef.current?.password);
    const d = await readWord(bytes, name);
    docRef.current = d; undo.current = []; redo.current = [];
    const fid = fidelity(d);
    setStatus(`Opened ${name} · lossless engine${fid ? ` · view-only: ${fid}` : ""}${d.warnings.length ? ` · ${d.warnings.length} warning(s)` : ""}${enc}`);
    setLoaded(true); setDirty(false); bump();
    setDocGen((g) => g + 1);
  }, [renderAll]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (path.toLowerCase().endsWith(".docx")) {
          const r = await api<{ node: { content: string; encoding?: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
          const bytes = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
          if (live) await loadBytes(bytes, path.split("/").pop() ?? "document.docx", path);
          return;
        }
        const d = await blankWord(path ? path.split("/").pop()!.replace(/\.[^.]+$/, "") : "Untitled");
        if (path.toLowerCase().endsWith(".fdoc")) {
          // legacy native format (TT≤45): JSON { title, blocks:[{kind:"paragraph",style,runs}|{kind:"table",rows}] }
          try {
            const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
            importLegacy(d, JSON.parse(r.node.content));
            setStatus("Opened legacy .fdoc — Save writes a .docx alongside it");
          } catch { /* new file */ }
        } else if (!path) seedWelcome(d);
        if (!live) return;
        docRef.current = d; setLoaded(true); bump();
        setDocGen((g) => g + 1);
      } catch (e) {
        shell.toast(`Could not open document: ${String((e as Error).message)}`, "bad");
        const d = await blankWord(); docRef.current = d; setLoaded(true); bump(); setDocGen((g) => g + 1);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveTo = useCallback(async (dest0: string) => {
    const doc = docRef.current!;
    const dest = dest0; const prot = encRef.current;
    if (saveBlocked(prot, dest)) { setStatus("Not saved — this password-protected file was not unlocked; the original is unchanged"); return; }
    const plain = await writeWord(doc);
    if (prot?.password) { setStatus(prot.key ? "Encrypting…" : "Encrypting (deriving the key from your password)…"); await new Promise((r) => setTimeout(r, 30)); }
    let bytes: Uint8Array; let sealed = false;
    try { const r = sealPackage(plain, prot); bytes = r.bytes; sealed = r.encrypted; }
    catch (e) { shell.toast(`Not saved: ${(e as Error).message}`, "bad"); return; }
    // removing the password is explicit (Password… dialog): only then may plaintext replace the encrypted original
    const replaceEncrypted = !!(prot?.removed && dest === prot.path);
    try { await post("/api/fs", { op: "upload", path: dest, content: toB64(bytes), mime: MIME_DOCX, replaceEncrypted }); }
    catch (e) { shell.toast(`Not saved: ${(e as Error).message}`, "bad"); return; }
    if (prot?.removed) { encRef.current = null; setLocked(false); }
    else if (prot && sealed) prot.path = dest;
    // edited paragraphs stay dirty: their original XML is not replaced, so they must be re-serialised on the next save too
    setDirty(false); setStatus(`Saved ${dest} (${(bytes.length / 1024).toFixed(1)} KB, lossless${sealed ? ", encrypted with your password — AES-256" : replaceEncrypted ? ", password removed" : ""})`); shell.bumpRefresh();
    if (dest !== path) { setPath(dest); shell.dispatch({ t: "setProps", id: win.id, props: { path: dest, title: dest.split("/").pop() } }); }
  }, [path, shell, win.id]);
  const save = useCallback(async () => {
    if (!docRef.current) return;
    if (path.toLowerCase().endsWith(".docx")) return saveTo(path);
    setPopVal(path ? path.replace(/\.[^./]+$/, ".docx") : `/Documents/${(docRef.current.title || "Document").replace(/[\\/:*?"<>|]/g, "").trim() || "Document"}.docx`);
    setPop("saveas");
  }, [path, saveTo]);
  useEffect(() => {
    if (!autosave || !dirty || !path.toLowerCase().endsWith(".docx") || (encRef.current && !encRef.current.password)) return;
    const t = window.setTimeout(() => { void saveTo(path); }, 4000);
    return () => window.clearTimeout(t);
  }, [autosave, dirty, path, saveTo, ver]);

  const download = async () => {
    const doc = docRef.current!;
    if (saveBlocked(encRef.current, encRef.current?.path ?? "")) { setStatus("Not downloaded — the password-protected file was not unlocked"); return; }
    let bytes: Uint8Array;
    try { bytes = sealPackage(await writeWord(doc), encRef.current).bytes; } // a protected document downloads encrypted
    catch (e) { shell.toast(`Not downloaded: ${(e as Error).message}`, "bad"); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME_DOCX }));
    a.download = (path.split("/").pop() || `${doc.title || "Document"}.docx`).replace(/\.fdoc$/i, ".docx"); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const exportText = (kind: "txt" | "html") => {
    const doc = docRef.current!; const root = rootRef.current!;
    const body = kind === "txt" ? docText(doc) : `<!doctype html><meta charset="utf-8"><title>${esc(doc.title)}</title><body style="max-width:48rem;margin:2rem auto">${cleanHtml(root)}</body>`;
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: kind === "txt" ? "text/plain" : "text/html" }));
    a.download = `${doc.title || "Document"}.${kind}`; a.click();
  };
  const print = () => {
    const doc = docRef.current!; const root = rootRef.current!; const p = doc.page;
    const w = window.open("", "_blank", "noopener=no,width=900,height=1000");
    if (!w) { shell.toast("Allow pop-ups to print / save as PDF", "warn"); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(doc.title)}</title><style>@page{size:${p.w / 1440}in ${p.h / 1440}in;margin:${p.top / 1440}in ${p.right / 1440}in ${p.bottom / 1440}in ${p.left / 1440}in}body{margin:0}${PRINT_CSS}</style><body>${cleanHtml(root)}</body>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };

  /* ------------------------------------------------------------ editing primitives */
  const doc = docRef.current;
  const typeText = (text: string) => {
    const d = docRef.current!; let r = curSel();
    snapshot(true);
    let at = r.a;
    if (!collapsed(r)) { at = E.deleteRange(d, r); r = { a: at, b: at }; }
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let pos = at;
    const multi = lines.length > 1;
    lines.forEach((line, i) => { if (i > 0) pos = E.splitParagraph(d, pos); if (line) pos = E.insertText(d, pos, line, pendingFmt.current ?? undefined); });
    pendingFmt.current = null;
    changed(multi || at.pid !== r.b.pid ? undefined : pos.pid, { a: pos, b: pos });
  };
  const delRange = (r: E.Range) => { snapshot(true); const at = E.deleteRange(docRef.current!, r); changed(undefined, { a: at, b: at }); };

  const onBeforeInput = useCallback((ev: InputEvent) => {
    const d = docRef.current; if (!d) return;
    const t = ev.inputType;
    if (t === "insertCompositionText") return; // IME: committed on compositionend
    ev.preventDefault();
    const r = curSel();
    const target = ev.getTargetRanges?.()[0];
    const tr = target ? (() => { const a = domToPos(target.startContainer, target.startOffset), b = domToPos(target.endContainer, target.endOffset); return a && b ? { a, b } : null; })() : null;
    switch (t) {
      case "insertText": case "insertReplacementText": {
        const text = ev.data ?? ev.dataTransfer?.getData("text/plain") ?? "";
        if (t === "insertReplacementText" && tr) setSel(tr);
        typeText(text); break;
      }
      case "insertParagraph": {
        snapshot(); let at = r.a; if (!collapsed(r)) at = E.deleteRange(d, r);
        const np = E.splitParagraph(d, at); changed(undefined, { a: np, b: np }); break;
      }
      case "insertLineBreak": typeText("\n"); break;
      case "deleteContentBackward": case "deleteContentForward": case "deleteWordBackward": case "deleteWordForward": case "deleteSoftLineBackward": case "deleteSoftLineForward": case "deleteHardLineBackward": case "deleteHardLineForward": case "deleteContent": case "deleteByCut": {
        if (!collapsed(r)) { delRange(r); break; }
        if (tr && !collapsed(tr)) { delRange(tr); break; }
        const back = t.includes("Backward");
        const p = E.paraById(d, r.a.pid)!;
        if (back) {
          if (r.a.off > 0) delRange({ a: { pid: p.id, off: r.a.off - 1 }, b: r.a });
          else { snapshot(); const at = E.joinBackward(d, p.id); if (at) changed(undefined, { a: at, b: at }); }
        } else {
          if (r.a.off < E.plen(p)) delRange({ a: r.a, b: { pid: p.id, off: r.a.off + 1 } });
          else { const ps = allParas(d.blocks); const nx = ps[ps.indexOf(p) + 1]; if (nx) delRange({ a: r.a, b: { pid: nx.id, off: 0 } }); }
        }
        break;
      }
      case "formatBold": toggleFmt("b"); break;
      case "formatItalic": toggleFmt("i"); break;
      case "formatUnderline": toggleFmt("u"); break;
      case "historyUndo": restore(undo, redo); break;
      case "historyRedo": restore(redo, undo); break;
      default: break; // paste/drop are handled by their own events; other input types are ignored
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFmt = (k: "b" | "i" | "u" | "s" | "va-sup" | "va-sub") => {
    const d = docRef.current!; const r = curSel(); const f = E.fmtAt(d, r);
    const key = k.startsWith("va") ? "va" : k;
    const val = k === "va-sup" ? (f.va === "superscript" ? null : "superscript") : k === "va-sub" ? (f.va === "subscript" ? null : "subscript") : k === "u" ? (f.u && f.u !== "none" ? null : "single") : !f[k as "b"];
    const v = val === false ? false : val;
    if (collapsed(r)) { pendingFmt.current = { ...(pendingFmt.current ?? {}), [key]: v === null ? undefined : v }; setTick((x) => x + 1); return; }
    snapshot(); E.applyFmt(d, r, { [key]: v }); changed(undefined, r);
  };
  const applyRunFmt = (patch: Record<string, unknown>) => {
    const d = docRef.current!; const r = curSel();
    if (collapsed(r)) { pendingFmt.current = { ...(pendingFmt.current ?? {}), ...patch }; setTick((x) => x + 1); rootRef.current?.focus(); setSel(r); return; }
    snapshot(); E.applyFmt(d, r, patch); changed(undefined, r);
  };
  const paraOp = (fn: (d: WordDoc, r: E.Range) => void) => { const d = docRef.current!; const r = curSel(); snapshot(); fn(d, r); changed(undefined, r); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    if (mod && k === "s") { e.preventDefault(); void save(); return; }
    if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); restore(undo, redo); return; }
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); restore(redo, undo); return; }
    if (mod && k === "b") { e.preventDefault(); toggleFmt("b"); return; }
    if (mod && k === "i") { e.preventDefault(); toggleFmt("i"); return; }
    if (mod && k === "u") { e.preventDefault(); toggleFmt("u"); return; }
    if (mod && k === "f") { e.preventDefault(); setPanel("find"); return; }
    if (mod && k === "k") { e.preventDefault(); openLink(); return; }
    if (mod && e.key === "Enter") { e.preventDefault(); const d = docRef.current!; snapshot(); const at = E.insertPageBreak(d, curSel().b); changed(undefined, { a: at, b: at }); return; }
    if (mod && ["l", "e", "r", "j"].includes(k)) { e.preventDefault(); paraOp((d, r) => E.setParaProps(d, r, { align: { l: "left", e: "center", r: "right", j: "justify" }[k] })); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      const d = docRef.current!; const r = curSel(); const w = E.locate(d, r.a.pid);
      if (w?.cell && w.row && w.table) { // next / previous cell
        const cells = allParas(d.blocks).filter((p) => { const x = E.locate(d, p.id); return !!x && x.table === w.table && x.cell?.blocks[0] === p; });
        const cur = cells.findIndex((p) => E.locate(d, p.id)?.cell === w.cell);
        const nx = cells[cur + (e.shiftKey ? -1 : 1)];
        if (nx) setSel({ a: { pid: nx.id, off: 0 }, b: { pid: nx.id, off: E.plen(nx) } });
        else if (!e.shiftKey) { snapshot(); E.tableRowOp(d, r.a.pid, "below"); changed(); const again = allParas(d.blocks).filter((p) => E.locate(d, p.id)?.table === w.table); const last = again[again.length - cellsInRow(w.row)]; if (last) setSel({ a: { pid: last.id, off: 0 }, b: { pid: last.id, off: 0 } }); }
        return;
      }
      if (E.paraById(d, r.a.pid)?.p.num || effectivePara(d, E.paraById(d, r.a.pid)!).num) { paraOp((dd, rr) => E.indent(dd, rr, e.shiftKey ? -1 : 1)); return; }
      typeText("\t");
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html"), text = e.clipboardData.getData("text/plain");
    const d = docRef.current!;
    if (html) {
      const parsed = htmlToParas(html);
      if (parsed.length) {
        snapshot(); let r = curSel(); let pos = r.a; if (!collapsed(r)) pos = E.deleteRange(d, r);
        parsed.forEach((para, i) => {
          if (i > 0) { pos = E.splitParagraph(d, pos); const np = E.paraById(d, pos.pid)!; np.p = { ...np.p, style: undefined, num: undefined }; }
          const p = E.paraById(d, pos.pid)!;
          if (para.style) { E.setStyle(d, { a: pos, b: pos }, para.style); }
          if (para.list) p.p = { ...p.p, num: { id: para.list === "bullet" ? "~bullet" : "~decimal", lvl: 0 } };
          for (const run of para.runs) { const start = pos; pos = E.insertText(d, pos, run.text); if (pos.off > start.off) E.applyFmt(d, { a: start, b: pos }, { b: run.b ? true : null, i: run.i ? true : null, u: run.u ? "single" : null }); if (run.href && /^(https?:|mailto:|#)/i.test(run.href)) E.setLink(d, { a: start, b: pos }, run.href); }
        });
        r = { a: pos, b: pos }; changed(undefined, r); return;
      }
    }
    if (text) typeText(text);
  };
  const onCut = (e: React.ClipboardEvent) => {
    const r = curSel(); if (collapsed(r)) return;
    e.preventDefault();
    const s = window.getSelection();
    e.clipboardData.setData("text/plain", E.textInRange(docRef.current!, r));
    if (s && s.rangeCount) { const div = document.createElement("div"); div.appendChild(s.getRangeAt(0).cloneContents()); e.clipboardData.setData("text/html", div.innerHTML); }
    delRange(r);
  };
  const onCopy = (e: React.ClipboardEvent) => {
    const r = curSel(); if (collapsed(r)) return;
    e.preventDefault();
    const s = window.getSelection();
    e.clipboardData.setData("text/plain", E.textInRange(docRef.current!, r));
    if (s && s.rangeCount) { const div = document.createElement("div"); div.appendChild(s.getRangeAt(0).cloneContents()); e.clipboardData.setData("text/html", div.innerHTML); }
  };
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const link = t.closest("[data-href]") as HTMLElement | null;
    if (link && (e.ctrlKey || e.metaKey)) {
      const href = link.dataset.href ?? "";
      if (href.startsWith("#")) { const bm = rootRef.current?.querySelector(`[data-kind="bookmark"]`); bm?.scrollIntoView(); }
      else if (/^https?:/i.test(href)) shell.open("browser", { url: href });
      return;
    }
    if (t.tagName === "IMG" && t.dataset.ti !== undefined) {
      const pe = t.closest("[data-pid]") as HTMLElement;
      setImgSel({ pid: pe.dataset.pid!, off: Number(t.dataset.o), w: Math.round(t.getBoundingClientRect().width / z), h: Math.round(t.getBoundingClientRect().height / z) });
      rootRef.current?.querySelectorAll(".wimg-sel").forEach((x) => x.classList.remove("wimg-sel")); t.classList.add("wimg-sel");
    } else if (imgSel) { setImgSel(null); rootRef.current?.querySelectorAll(".wimg-sel").forEach((x) => x.classList.remove("wimg-sel")); }
  };

  useEffect(() => {
    const root = rootRef.current; if (!root || !loaded) return;
    const bi = (e: Event) => onBeforeInput(e as InputEvent);
    const cs = () => { composing.current = curSel(); };
    const ce = (e: CompositionEvent) => {
      const r = composing.current; composing.current = null;
      if (!r) return;
      const d = docRef.current!; snapshot(true);
      let at = r.a; if (!collapsed(r)) at = E.deleteRange(d, r);
      const pos = e.data ? E.insertText(d, at, e.data) : at;
      changed(undefined, { a: pos, b: pos });
    };
    root.addEventListener("beforeinput", bi);
    root.addEventListener("compositionstart", cs);
    root.addEventListener("compositionend", ce as EventListener);
    const sc = () => { const s = window.getSelection(); if (s && root.contains(s.anchorNode)) { const r = readSel(); if (r) { selRef.current = r; setTick((x) => x + 1); } } };
    document.addEventListener("selectionchange", sc);
    return () => { root.removeEventListener("beforeinput", bi); root.removeEventListener("compositionstart", cs); root.removeEventListener("compositionend", ce as EventListener); document.removeEventListener("selectionchange", sc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  useEffect(() => { if (loaded && docGen) renderAll(); }, [docGen, loaded, renderAll]);
  useEffect(() => { if (loaded) relayout(); }, [z, loaded, relayout]);

  /* ------------------------------------------------------------ commands */
  const openLink = () => { const d = docRef.current!; const r = curSel(); const p = E.paraById(d, r.a.pid); const run = p ? E.runAt(p, r.a.off) : undefined; setPopVal(run?.link?.href ?? (run?.link?.anchor ? `#${run.link.anchor}` : "https://")); setPop("link"); };
  const applyLink = (url: string | null) => {
    const r = curSel(); setPop("");
    if (url && !/^(https?:\/\/|mailto:|#)/i.test(url)) { shell.toast("Links must start with http(s)://, mailto: or #bookmark", "warn"); return; }
    if (collapsed(r) && url) { const d = docRef.current!; snapshot(); const end = E.insertText(d, r.a, url.replace(/^mailto:/, "")); E.setLink(d, { a: r.a, b: end }, url); changed(undefined, { a: end, b: end }); return; }
    paraOp((d, rr) => E.setLink(d, rr, url));
  };
  const insertTable = (rows: number, cols: number) => { const d = docRef.current!; const r = curSel(); snapshot(); const t = E.insertTableAfter(d, r.b.pid, Math.max(1, Math.min(50, rows)), Math.max(1, Math.min(20, cols))); setPop(""); changed(); if (t) { const p = allParas([t])[0]; setSel({ a: { pid: p.id, off: 0 }, b: { pid: p.id, off: 0 } }); } };
  const tableOp = (op: "above" | "below" | "rdel" | "left" | "right" | "cdel") => { const d = docRef.current!; const r = curSel(); snapshot(); const ok = op === "above" || op === "below" ? E.tableRowOp(d, r.a.pid, op) : op === "rdel" ? E.tableRowOp(d, r.a.pid, "delete") : E.tableColOp(d, r.a.pid, op === "cdel" ? "delete" : op); if (ok) changed(); };
  const insertImageFile = async (f: File) => {
    const d = docRef.current!; const data = new Uint8Array(await f.arrayBuffer());
    if (data.length > 20 * 1024 * 1024) { shell.toast("Images over 20 MB are refused", "warn"); return; }
    const mime = f.type || "image/png";
    if (!/^image\/(png|jpeg|gif|svg\+xml)$/.test(mime)) { shell.toast("Insert PNG, JPEG, GIF or SVG images", "warn"); return; }
    const dims = await new Promise<{ w: number; h: number }>((res) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth || 300, h: im.naturalHeight || 200 }); im.onerror = () => res({ w: 300, h: 200 }); im.src = URL.createObjectURL(new Blob([data], { type: mime })); });
    const maxW = (d.page.w - d.page.left - d.page.right) / 15;
    const k = Math.min(1, maxW / dims.w);
    const tok = makeImage(d, data, mime, Math.round(dims.w * k), Math.round(dims.h * k), f.name.replace(/\.[^.]+$/, ""));
    snapshot(); const at = E.insertToken(d, curSel().b, tok); changed(undefined, { a: at, b: at });
  };
  const resizeSelImage = (w: number) => {
    if (!imgSel) return; const d = docRef.current!; const p = E.paraById(d, imgSel.pid); if (!p) return;
    let acc = 0; for (const it of p.content) { if (acc === imgSel.off && it.t === "k" && it.kind === "image") { snapshot(); const ratio = imgSel.h / Math.max(1, imgSel.w); resizeImage(it as Tok, w, Math.round(w * ratio)); p.dirty = true; setImgSel({ ...imgSel, w, h: Math.round(w * ratio) }); changed(p.id); return; } acc += E.ilen(it); }
  };
  const addComment = (text: string) => { if (!text.trim()) return; const d = docRef.current!; const r = curSel(); snapshot(); E.addComment(d, collapsed(r) ? { a: { ...r.a, off: Math.max(0, r.a.off - 1) }, b: r.b } : r, text.trim(), String(shell.settings["profile.name"] ?? "Fusion user")); setPop(""); setPanel("review"); changed(); };
  const runFind = (dir: 1 | -1) => {
    const d = docRef.current!; const hits = E.findText(d, find.q, find);
    if (!hits.length) { setStatus(`“${find.q}” not found`); return; }
    const at = (find.at + dir + hits.length) % hits.length; setFind({ ...find, at });
    const h = hits[at]; rootRef.current?.focus(); setSel({ a: { pid: h.pid, off: h.off }, b: { pid: h.pid, off: h.off + h.len } }); setStatus(`Match ${at + 1} of ${hits.length}`);
  };
  const replaceOne = () => {
    const d = docRef.current!; const r = curSel(); const cur = E.textInRange(d, r);
    if (cur && (find.matchCase ? cur === find.q : cur.toLowerCase() === find.q.toLowerCase())) { snapshot(); const at = E.deleteRange(d, r); const end = E.insertText(d, at, find.r); changed(undefined, { a: end, b: end }); }
    runFind(1);
  };
  const replaceAll = () => { const d = docRef.current!; snapshot(); const n = E.replaceAll(d, find.q, find.r, find); changed(); setStatus(`Replaced ${n} occurrence(s)`); };
  const resolve = (accept: boolean) => { const d = docRef.current!; snapshot(); const n = E.resolveChanges(d, accept); changed(); setStatus(`${accept ? "Accepted" : "Rejected"} ${n} change(s)`); };

  /* ------------------------------------------------------------ derived toolbar state */
  const fmt = useMemo(() => {
    const d = docRef.current; if (!d || !loaded) return null;
    const r = selRef.current ?? curSel();
    try { return { ...E.fmtAt(d, r), ...(pendingFmt.current ?? {}) } as ReturnType<typeof E.fmtAt>; } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ver, loaded]);
  const curPara = useMemo(() => { const d = docRef.current; const r = selRef.current; return d && r ? E.paraById(d, r.a.pid) : undefined; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tick, ver]);
  const inTable = useMemo(() => { const d = docRef.current; const r = selRef.current; return !!(d && r && E.locate(d, r.a.pid)?.table); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tick, ver]);
  const counts = useMemo(() => { const d = docRef.current; if (!d) return { words: 0, chars: 0 }; const t = docText(d); return { words: (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length, chars: t.replace(/\n/g, "").length }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ver]);
  const headings = useMemo(() => { const d = docRef.current; if (!d || panel !== "nav") return []; return allParas(d.blocks).map((p) => ({ p, lvl: headingLevel(d, p) })).filter((x) => x.lvl > 0 && paraText(x.p).trim()).slice(0, 300); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ver, panel]);

  if (!loaded || !doc) return <div style={{ padding: 16 }}>Opening document…</div>;
  const g = geomOf(doc);
  const styleId = curPara?.p.style ?? E.styleChoices(doc)[0]?.id;
  const changes = panel === "review" ? E.trackedChanges(doc) : [];
  const mixed = (k: string) => fmt?.mixed.has(k);
  const tb = (on: boolean | undefined) => ({ variant: (on ? "primary" : "ghost") as "primary" | "ghost" });

  return (
    <div className="writer" style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }} data-testid="writer">
      <style>{WRITER_CSS}</style>
      {/* ---------- file / history row */}
      <div className="fs-row" style={{ padding: "4px 6px", gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap", alignItems: "center" }}>
        <Btn variant="ghost" onClick={async () => { if (dirty && !confirmLeave()) return; const d = await blankWord(); docRef.current = d; setPath(""); encRef.current = null; setLocked(false); undo.current = []; setDirty(false); bump(); setDocGen((g) => g + 1); }}>New</Btn>
        <Btn variant="ghost" onClick={() => fileInput.current?.click()}>Open…</Btn>
        <input ref={fileInput} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, ""); setPath(""); } catch (err) { shell.toast(`Cannot open ${f.name}: ${(err as Error).message}`, "bad"); } e.target.value = ""; }} />
        <Btn data-testid="writer-save" onClick={() => void save()}>{dirty ? "Save •" : "Save"}</Btn>
        <Btn variant="ghost" onClick={() => { setPopVal(path || `/Documents/${doc.title || "Document"}.docx`); setPop("saveas"); }}>Save as…</Btn>
        <Btn variant="ghost" onClick={() => void download()}>Download</Btn>
        <Btn variant="ghost" data-testid="writer-password" aria-pressed={locked} onClick={async () => {
          if (saveBlocked(encRef.current, encRef.current?.path ?? "")) { setStatus("Unlock the file first (reopen it and enter its password)"); return; }
          const np = await askPassword(path.split("/").pop() || docRef.current?.title || "Document", encRef.current, path);
          if (!np) return;
          encRef.current = np; setLocked(!!np.password); setDirty(true); bump();
          setStatus(np.password ? "Password set — the next save encrypts the file (AES-256)" : "Password removed — the next save writes the file without encryption");
        }}>{locked ? "Password: on" : "Password…"}</Btn>
        <Btn variant="ghost" onClick={print}>Print / PDF</Btn>
        <Btn variant="ghost" onClick={() => exportText("html")}>HTML</Btn>
        <Btn variant="ghost" onClick={() => exportText("txt")}>Text</Btn>
        <span style={{ width: 8 }} />
        <Btn variant="ghost" disabled={!undo.current.length} onClick={() => restore(undo, redo)} aria-label="Undo">Undo</Btn>
        <Btn variant="ghost" disabled={!redo.current.length} onClick={() => restore(redo, undo)} aria-label="Redo">Redo</Btn>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: fz(12), display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={autosave} onChange={(e) => setAutosave(e.target.checked)} disabled={!path.toLowerCase().endsWith(".docx") || !!(encRef.current && !encRef.current.password)} aria-label="AutoSave" />AutoSave</label>
        {(["nav", "find", "review", "page", "hf"] as Panel[]).map((p) => <Btn key={p} {...tb(panel === p)} onClick={() => setPanel(panel === p ? "none" : p)}>{{ nav: "Navigation", find: "Find", review: "Review", page: "Layout", hf: "Header & footer", none: "" }[p]}</Btn>)}
      </div>
      {/* ---------- formatting row */}
      <div className="fs-row" style={{ padding: "4px 6px", gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap", alignItems: "center" }} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName === "BUTTON") e.preventDefault(); }}>
        <select className="fs-select" aria-label="Paragraph style" value={styleId} style={{ width: fz(140) }} onChange={(e) => paraOp((d, r) => E.setStyle(d, r, e.target.value))}>
          {E.styleChoices(doc).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="fs-select" aria-label="Font" value={mixed("font") ? "" : fmt?.font ?? ""} style={{ width: fz(130) }} onChange={(e) => applyRunFmt({ font: e.target.value })}>
          <option value="" disabled>{mixed("font") ? "(mixed)" : "Font"}</option>
          {[...new Set([...(fmt?.font ? [fmt.font] : []), ...FONTS])].map((f) => <option key={f} value={f} style={{ fontFamily: cssFont(f) }}>{f}</option>)}
        </select>
        <select className="fs-select" aria-label="Font size" value={mixed("sz") ? "" : String((fmt?.sz ?? 22) / 2)} style={{ width: fz(64) }} onChange={(e) => applyRunFmt({ sz: Math.round(Number(e.target.value) * 2) })}>
          <option value="" disabled>–</option>
          {[...new Set([...(fmt?.sz ? [fmt.sz / 2] : []), ...SIZES])].sort((a, b) => a - b).map((s) => <option key={s} value={String(s)}>{s}</option>)}
        </select>
        <Btn {...tb(!!fmt?.b && !mixed("b"))} aria-label="Bold" aria-pressed={!!fmt?.b} onClick={() => toggleFmt("b")}><b>B</b></Btn>
        <Btn {...tb(!!fmt?.i && !mixed("i"))} aria-label="Italic" aria-pressed={!!fmt?.i} onClick={() => toggleFmt("i")}><i>I</i></Btn>
        <Btn {...tb(!!fmt?.u && fmt.u !== "none" && !mixed("u"))} aria-label="Underline" aria-pressed={!!fmt?.u} onClick={() => toggleFmt("u")}><u>U</u></Btn>
        <Btn {...tb(!!fmt?.s)} aria-label="Strikethrough" onClick={() => toggleFmt("s")}><s>S</s></Btn>
        <Btn {...tb(fmt?.va === "superscript")} aria-label="x² superscript" title="Superscript" onClick={() => toggleFmt("va-sup")}>x²</Btn>
        <Btn {...tb(fmt?.va === "subscript")} aria-label="x₂ subscript" title="Subscript" onClick={() => toggleFmt("va-sub")}>x₂</Btn>
        <label title="Text colour" style={{ display: "flex", alignItems: "center" }}><input type="color" aria-label="Text colour" value={`#${fmt?.color && /^[0-9a-f]{6}$/i.test(fmt.color) ? fmt.color : "000000"}`} onChange={(e) => applyRunFmt({ color: e.target.value.slice(1).toUpperCase() })} style={{ width: fz(28), height: fz(24), border: "none", background: "none" }} /></label>
        <select className="fs-select" aria-label="Highlight" value={fmt?.hl ?? ""} style={{ width: fz(96) }} onChange={(e) => applyRunFmt({ hl: e.target.value || null })}>
          <option value="">No highlight</option>{HIGHLIGHTS.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <span className="wsep" />
        {(["left", "center", "right", "justify"] as const).map((a) => <Btn key={a} {...tb((effectivePara(doc, curPara ?? allParas(doc.blocks)[0]).align ?? "left") === a)} aria-label={`Align ${a}`} onClick={() => paraOp((d, r) => E.setParaProps(d, r, { align: a }))}><AlignIcon a={a} /></Btn>)}
        <select className="fs-select" aria-label="Line spacing" value={String(curPara?.p.line ? curPara.p.line / 240 : "")} style={{ width: fz(70) }} onChange={(e) => paraOp((d, r) => E.setParaProps(d, r, { line: Math.round(Number(e.target.value) * 240), lineRule: "auto" }))}>
          <option value="" disabled>Spacing</option>{[1, 1.15, 1.5, 2, 2.5, 3].map((v) => <option key={v} value={String(v)}>{v.toFixed(2)}</option>)}
        </select>
        <Btn {...tb(!!curPara && E.listKind(doc, curPara) === "bullet")} aria-label="Bulleted list" onClick={() => paraOp((d, r) => E.toggleList(d, r, "bullet"))}>• List</Btn>
        <Btn {...tb(!!curPara && E.listKind(doc, curPara) === "number")} aria-label="1. List (numbered)" title="Numbered list" onClick={() => paraOp((d, r) => E.toggleList(d, r, "number"))}>1. List</Btn>
        <Btn variant="ghost" aria-label="Decrease indent" onClick={() => paraOp((d, r) => E.indent(d, r, -1))}>⇤</Btn>
        <Btn variant="ghost" aria-label="Increase indent" onClick={() => paraOp((d, r) => E.indent(d, r, 1))}>⇥</Btn>
        <span className="wsep" />
        <Btn variant="ghost" onClick={openLink}>Link</Btn>
        <Btn variant="ghost" onClick={() => imgInput.current?.click()}>Image</Btn>
        <input ref={imgInput} type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void insertImageFile(f); e.target.value = ""; }} />
        <Btn variant="ghost" onClick={() => { setPopVal("3"); setPopVal2("3"); setPop("table"); }}>Table</Btn>
        <Btn variant="ghost" onClick={() => { const d = docRef.current!; snapshot(); const at = E.insertPageBreak(d, curSel().b); changed(undefined, { a: at, b: at }); }}>Page break</Btn>
        <Btn variant="ghost" onClick={() => { setPopVal(""); setPop("comment"); }}>Comment</Btn>
        <Btn variant="ghost" aria-label="Clear formatting" onClick={() => paraOp((d, r) => E.applyFmt(d, r, { b: null, i: null, u: null, s: null, sz: null, font: null, color: null, hl: null, va: null, caps: null, smallCaps: null, shd: null }))}>Clear</Btn>
        <select className="fs-select" aria-label="Zoom" value={String(Math.round(z * 100))} style={{ width: fz(72) }} onChange={(e) => setZoom(Number(e.target.value) / 100)}>
          {[...new Set([50, 75, 100, 125, 150, 175, 200, 250, Math.round(unit * 100)])].sort((a, b) => a - b).map((v) => <option key={v} value={String(v)}>{v}%</option>)}
        </select>
      </div>
      {/* ---------- contextual rows */}
      {(inTable || imgSel) && (
        <div className="fs-row" style={{ padding: "3px 6px", gap: 4, borderBottom: "1px solid var(--fs-border)", alignItems: "center", flexWrap: "wrap", fontSize: fz(12) }} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName === "BUTTON") e.preventDefault(); }}>
          {inTable && <><span style={{ opacity: 0.7 }}>Table:</span>
            <Btn variant="ghost" onClick={() => tableOp("above")}>Row above</Btn><Btn variant="ghost" onClick={() => tableOp("below")}>Row below</Btn>
            <Btn variant="ghost" onClick={() => tableOp("left")}>Column left</Btn><Btn variant="ghost" onClick={() => tableOp("right")}>Column right</Btn>
            <Btn variant="ghost" onClick={() => tableOp("rdel")}>Delete row</Btn><Btn variant="ghost" onClick={() => tableOp("cdel")}>Delete column</Btn></>}
          {imgSel && <><span style={{ opacity: 0.7 }}>Picture width (px):</span>
            <input className="fs-input" type="number" min={16} max={2000} value={imgSel.w} aria-label="Picture width" style={{ width: fz(80) }} onChange={(e) => resizeSelImage(Math.max(16, Math.min(2000, Number(e.target.value) || 16)))} />
            <span style={{ opacity: 0.7 }}>× {imgSel.h} (aspect locked)</span></>}
        </div>
      )}
      {pop && (
        <div className="fs-row wpop" style={{ padding: 6, gap: 6, borderBottom: "1px solid var(--fs-border)", alignItems: "center", flexWrap: "wrap" }}>
          {pop === "link" && <><span>Link to</span><input className="fs-input" autoFocus aria-label="Link address" value={popVal} onChange={(e) => setPopVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") applyLink(popVal); if (e.key === "Escape") setPop(""); }} style={{ width: fz(320) }} /><Btn onClick={() => applyLink(popVal)}>Apply</Btn><Btn variant="ghost" onClick={() => applyLink(null)}>Remove link</Btn></>}
          {pop === "table" && <><span>Insert table</span><input className="fs-input" type="number" min={1} max={50} aria-label="Rows" value={popVal} onChange={(e) => setPopVal(e.target.value)} style={{ width: fz(60) }} /><span>rows ×</span><input className="fs-input" type="number" min={1} max={20} aria-label="Columns" value={popVal2} onChange={(e) => setPopVal2(e.target.value)} style={{ width: fz(60) }} /><span>columns</span><Btn onClick={() => insertTable(Number(popVal) || 1, Number(popVal2) || 1)}>Insert</Btn></>}
          {pop === "comment" && <><span>Comment</span><input className="fs-input" autoFocus aria-label="Comment text" value={popVal} onChange={(e) => setPopVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addComment(popVal); if (e.key === "Escape") setPop(""); }} style={{ width: fz(360) }} /><Btn onClick={() => addComment(popVal)}>Add</Btn></>}
          {pop === "saveas" && <><span>Save as</span><input className="fs-input" autoFocus aria-label="Save path" value={popVal} onChange={(e) => setPopVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { const p = popVal.toLowerCase().endsWith(".docx") ? popVal : `${popVal}.docx`; setPop(""); void saveTo(p); } }} style={{ width: fz(340) }} />
            <Btn onClick={() => { const p = popVal.toLowerCase().endsWith(".docx") ? popVal : `${popVal}.docx`; setPop(""); void saveTo(p); }}>Save .docx</Btn>
            <span style={{ fontSize: fz(12), opacity: 0.8 }} data-testid="writer-fidelity">Fidelity: lossless — every part of the original package is kept{fidelity(doc) ? `; shown read-only: ${fidelity(doc)}` : ""}.</span></>}
          <Btn variant="ghost" onClick={() => setPop("")}>Cancel</Btn>
        </div>
      )}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {panel === "nav" && (
          <div className="wside" aria-label="Navigation pane">
            <div className="wside-h">Headings</div>
            {headings.length ? headings.map(({ p, lvl }) => <button key={p.id} className="wnav" style={{ paddingLeft: 6 + (lvl - 1) * 12 }} onClick={() => { rootRef.current?.querySelector(`[data-pid="${p.id}"]`)?.scrollIntoView({ block: "start" }); setSel({ a: { pid: p.id, off: 0 }, b: { pid: p.id, off: 0 } }); }}>{paraText(p).slice(0, 80)}</button>) : <div style={{ opacity: 0.7, padding: 6 }}>No headings. Apply Heading 1–3 to build an outline.</div>}
          </div>
        )}
        {/* ---------- pages */}
        <div className="wcanvas" role="region" aria-label="Document pages" tabIndex={0} style={{ flex: 1, overflow: "auto", background: "var(--fs-surface-2, #e9ecef)", padding: 24 }}>
          <div style={{ width: g.pageW * z, height: pages * (g.pageH + g.gap) * z, margin: "0 auto", position: "relative" }}>
            <div style={{ transform: `scale(${z})`, transformOrigin: "0 0", width: g.pageW, position: "absolute", left: 0, top: 0 }}>
              <div ref={pagesRef} className="wpages" style={{ position: "absolute", left: 0, top: 0, width: g.pageW }} aria-hidden />
              <div ref={rootRef} className="wdoc" contentEditable suppressContentEditableWarning spellCheck role="textbox" aria-multiline aria-label="Document body"
                style={{ position: "absolute", left: g.left, top: g.top, width: g.pageW - g.left - g.right, outline: "none", color: "#111", caretColor: "#111" }}
                onKeyDown={onKeyDown} onPaste={onPaste} onCut={onCut} onCopy={onCopy} onClick={onClick} onDrop={(e) => e.preventDefault()} data-testid="writer-body" />
            </div>
          </div>
        </div>
        {panel !== "none" && panel !== "nav" && (
          <div className="wside" style={{ width: fz(290) }}>
            {panel === "find" && <>
              <div className="wside-h">Find and replace</div>
              <input className="fs-input" autoFocus aria-label="Find" placeholder="Find" value={find.q} onChange={(e) => setFind({ ...find, q: e.target.value, at: -1 })} onKeyDown={(e) => { if (e.key === "Enter") runFind(e.shiftKey ? -1 : 1); }} />
              <input className="fs-input" aria-label="Replace with" placeholder="Replace with" value={find.r} onChange={(e) => setFind({ ...find, r: e.target.value })} />
              <label><input type="checkbox" checked={find.matchCase} onChange={(e) => setFind({ ...find, matchCase: e.target.checked })} /> Match case</label>
              <label><input type="checkbox" checked={find.wholeWord} onChange={(e) => setFind({ ...find, wholeWord: e.target.checked })} /> Whole words</label>
              <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}><Btn onClick={() => runFind(1)}>Next</Btn><Btn variant="ghost" onClick={() => runFind(-1)}>Previous</Btn><Btn variant="ghost" onClick={replaceOne}>Replace</Btn><Btn variant="ghost" onClick={replaceAll}>Replace all</Btn></div>
            </>}
            {panel === "review" && <>
              <div className="wside-h">Tracked changes ({changes.length})</div>
              <div className="fs-row" style={{ gap: 4 }}><Btn disabled={!changes.length} onClick={() => resolve(true)}>Accept all</Btn><Btn variant="ghost" disabled={!changes.length} onClick={() => resolve(false)}>Reject all</Btn></div>
              {changes.slice(0, 100).map((c, i) => <div key={i} className={`wchg wchg-${c.kind}`}><b>{c.kind === "ins" ? "Inserted" : "Deleted"}</b>{c.author ? ` · ${c.author}` : ""}<div>{c.text.slice(0, 120) || "(formatting / empty)"}</div></div>)}
              <div className="wside-h" style={{ marginTop: 10 }}>Comments ({doc.comments.length})</div>
              <Btn variant="ghost" onClick={() => { setPopVal(""); setPop("comment"); }}>New comment on selection</Btn>
              {doc.comments.map((c) => <button key={c.id} className="wcom" onClick={() => { const m = rootRef.current?.querySelector(`[data-cids~="${c.id}"], .wcmt[data-cids*="${c.id}"]`); m?.scrollIntoView({ block: "center" }); }}><b>{c.author || "Unknown"}</b>{c.date ? <span style={{ opacity: 0.6 }}> · {c.date.slice(0, 10)}</span> : null}<div>{c.text}</div></button>)}
            </>}
            {panel === "hf" && <HeaderFooter doc={doc} gen={docGen * 100000 + hfGen} onApply={(fn) => { snapshot(); fn(doc); setDirty(true); bump(); setDocGen((g) => g + 1); }} />}
            {panel === "page" && <PageSetup doc={doc} onApply={(o) => { snapshot(); E.setPageSetup(doc, o); setDirty(true); bump(); setDocGen((g) => g + 1); }} />}
          </div>
        )}
      </div>
      <div className="fs-row" style={{ padding: "3px 8px", gap: 12, borderTop: "1px solid var(--fs-border)", fontSize: fz(12), opacity: 0.85 }} aria-live="polite">
        <span data-testid="writer-pages">Page count: {pages}</span><span data-testid="writer-words">{counts.words} words</span><span>{counts.chars} characters</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-testid="writer-status">{status}</span>
        <span>{path || "unsaved"}</span>
      </div>
    </div>
  );
}

/* ================================================================ helpers */
function cellsInRow(r: { items: unknown[] }) { return r.items.filter((c) => (c as { t?: string }).t === "tc").length; }
function confirmLeave() { return true; /* unsaved work is still in undo history; New keeps no prompt (window.confirm is a rejected pattern) */ }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function headingLevel(doc: WordDoc, p: Para): number {
  for (const s of styleChain(doc, p.p.style).reverse()) { const m = /^heading\s*(\d)$/i.exec(s.name) ?? /^Heading(\d)$/.exec(s.id); if (m) return Number(m[1]); if (s.name.toLowerCase() === "title") return 1; }
  return 0;
}
/** Read-only constructs (kept verbatim on save) — shown in the status bar and the Save-As fidelity note (FF-11). */
export function fidelity(doc: WordDoc): string {
  const c = new Map<string, number>();
  const add = (k: string) => c.set(k, (c.get(k) ?? 0) + 1);
  for (const p of allParas(doc.blocks)) for (const it of p.content) if (it.t === "k") {
    if (it.kind === "math") add("equation"); else if (it.kind === "box") add("inline control"); else if (it.kind === "field") add("field"); else if (it.kind === "other" && it.label) add("object"); else if (it.kind === "image" && /emf|wmf|tiff/.test(it.img?.mime ?? "")) add("EMF/WMF picture");
  }
  const walk = (bs: Block[]) => { for (const b of bs) { if (b.t === "x" && b.label) add("block object"); if (b.t === "box") walk(b.blocks); if (b.t === "tbl") for (const r of b.items) if ((r as { t?: string }).t === "tr") for (const cc of (r as { items: unknown[] }).items) if ((cc as { t?: string }).t === "tc") walk((cc as { blocks: Block[] }).blocks); } };
  walk(doc.blocks);
  if (doc.parts.size) add("header/footer");
  return [...c].map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ");
}
function importLegacy(d: WordDoc, m: { title?: string; blocks?: { kind: string; style?: string; runs?: { text: string; bold?: boolean; italic?: boolean; underline?: boolean }[]; rows?: string[][] }[] }) {
  if (!m || !Array.isArray(m.blocks)) return;
  d.title = m.title ?? d.title;
  const first = allParas(d.blocks)[0];
  let pos: E.Pos = { pid: first.id, off: 0 };
  m.blocks.forEach((b, i) => {
    if (b.kind === "table" && b.rows?.length) {
      const t = E.insertTableAfter(d, pos.pid, b.rows.length, Math.max(...b.rows.map((r) => r.length)));
      if (t) { const ps = allParas([t]); let k = 0; for (const row of b.rows) for (let c = 0; c < t.grid.length; c++) { const p = ps[k++]; if (p && row[c]) E.insertText(d, { pid: p.id, off: 0 }, row[c]); } const after = allParas(d.blocks); pos = { pid: after[after.indexOf(ps[ps.length - 1]) + 1].id, off: 0 }; }
      return;
    }
    if (i > 0 && E.plen(E.paraById(d, pos.pid)!) > 0) pos = E.splitParagraph(d, pos);
    const style = b.style === "ListBullet" ? undefined : b.style;
    if (style && style !== "Normal") E.setStyle(d, { a: pos, b: pos }, style);
    if (b.style === "ListBullet") { const p = E.paraById(d, pos.pid)!; p.p = { ...p.p, num: { id: "~bullet", lvl: 0 } }; }
    for (const r of b.runs ?? []) { const s = pos; pos = E.insertText(d, pos, r.text); if (pos.off > s.off) E.applyFmt(d, { a: s, b: pos }, { b: r.bold ? true : null, i: r.italic ? true : null, u: r.underline ? "single" : null }); }
  });
}
function seedWelcome(d: WordDoc) {
  importLegacy(d, { title: "Welcome to Writer", blocks: [
    { kind: "paragraph", style: "Title", runs: [{ text: "Welcome to Writer" }] },
    { kind: "paragraph", style: "Normal", runs: [{ text: "Everything here is a real Word document. Open any " }, { text: ".docx", bold: true }, { text: " and it is edited on this device and saved back without losing the parts Writer does not display." }] },
    { kind: "paragraph", style: "Heading1", runs: [{ text: "Try it" }] },
    { kind: "paragraph", style: "ListBullet", runs: [{ text: "Select text and press Ctrl+B, Ctrl+I or Ctrl+U" }] },
    { kind: "paragraph", style: "ListBullet", runs: [{ text: "Insert a table, an image, a link or a comment from the toolbar" }] },
    { kind: "paragraph", style: "ListBullet", runs: [{ text: "Ctrl+Enter starts a new page; Print / PDF uses the document's page size" }] },
    { kind: "table", rows: [["Feature", "Saved to .docx"], ["Styles, lists, tables", "Yes"], ["Images, links, comments", "Yes"]] },
  ] });
}
/** Converts clipboard HTML into paragraphs with basic formatting (b/i/u/links, h1–h3, li). */
function htmlToParas(html: string): { style?: string; list?: "bullet" | "number"; runs: { text: string; b?: boolean; i?: boolean; u?: boolean; href?: string }[] }[] {
  const dom = new DOMParser().parseFromString(html, "text/html");
  const out: { style?: string; list?: "bullet" | "number"; runs: { text: string; b?: boolean; i?: boolean; u?: boolean; href?: string }[] }[] = [];
  let cur: (typeof out)[number] | null = null;
  const BLOCK = /^(P|DIV|H[1-6]|LI|TR|BLOCKQUOTE|PRE|TABLE|UL|OL|SECTION|ARTICLE)$/;
  const walk = (n: Node, f: { b?: boolean; i?: boolean; u?: boolean; href?: string }, list?: "bullet" | "number") => {
    if (n.nodeType === 3) { const t = (n as Text).data.replace(/\s+/g, " "); if (!t.trim() && !cur) return; if (!cur) { cur = { runs: [] }; out.push(cur); } cur.runs.push({ text: t, ...f }); return; }
    if (n.nodeType !== 1) return;
    const e = n as HTMLElement; const tag = e.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "HEAD") return;
    if (tag === "BR") { cur = null; return; }
    const st = e.getAttribute("style") ?? "";
    const nf = { ...f, b: f.b || tag === "B" || tag === "STRONG" || /font-weight:\s*(bold|[6-9]00)/.test(st), i: f.i || tag === "I" || tag === "EM" || /font-style:\s*italic/.test(st), u: f.u || tag === "U" || /text-decoration[^;]*underline/.test(st), href: tag === "A" ? e.getAttribute("href") ?? undefined : f.href };
    const nl = tag === "UL" ? "bullet" : tag === "OL" ? "number" : list;
    if (BLOCK.test(tag)) {
      cur = null;
      if (tag !== "UL" && tag !== "OL" && tag !== "TABLE") { cur = { runs: [], style: /^H([1-3])$/.test(tag) ? `Heading${tag[1]}` : tag === "BLOCKQUOTE" ? "Quote" : undefined, list: tag === "LI" ? nl : undefined }; out.push(cur); }
      e.childNodes.forEach((c) => walk(c, nf, nl));
      cur = null; return;
    }
    e.childNodes.forEach((c) => walk(c, nf, nl));
  };
  walk(dom.body, {});
  return out.map((p) => ({ ...p, runs: p.runs.map((r, i, a) => ({ ...r, text: i === 0 ? r.text.replace(/^\s+/, "") : i === a.length - 1 ? r.text.replace(/\s+$/, "") : r.text })).filter((r) => r.text) })).filter((p) => p.runs.length || p.style);
}
function cleanHtml(root: HTMLElement): string {
  const c = root.cloneNode(true) as HTMLElement;
  c.querySelectorAll(".wpg-sp").forEach((e) => e.remove());
  c.querySelectorAll("[style]").forEach((e) => { (e as HTMLElement).style.marginTop = (e as HTMLElement).style.marginTop && (e as HTMLElement).classList.contains("wp") ? "" : (e as HTMLElement).style.marginTop; });
  c.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));
  c.querySelectorAll("img").forEach((img) => { /* blob: URLs die with the window; inline them */ try { const cv = document.createElement("canvas"); const src = root.querySelector(`img[data-ti="${img.dataset.ti}"]`) as HTMLImageElement | null; if (src && src.complete) { cv.width = src.naturalWidth; cv.height = src.naturalHeight; cv.getContext("2d")!.drawImage(src, 0, 0); img.src = cv.toDataURL("image/png"); } } catch { /* tainted */ } });
  c.querySelectorAll("[data-kind=page]").forEach((e) => { (e as HTMLElement).style.cssText = "display:block;break-after:page"; });
  return `<style>${PRINT_CSS}</style>${c.innerHTML}`;
}
function AlignIcon({ a }: { a: "left" | "center" | "right" | "justify" }) {
  const rows = [14, 10, 14, 8];
  return <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden>{rows.map((w, i) => { const ww = a === "justify" ? 14 : w; const x = a === "left" || a === "justify" ? 1 : a === "right" ? 15 - ww : (16 - ww) / 2; return <rect key={i} x={x} y={1 + i * 3.3} width={ww} height="1.6" rx="0.8" fill="currentColor" />; })}</svg>;
}
/** TT49: header & footer editor (src/lib/office/hdrftr.ts). One row per paragraph; locked rows are kept verbatim. */
function HeaderFooter({ doc, gen, onApply }: { doc: WordDoc; gen: number; onApply: (fn: (d: WordDoc) => void) => void }) {
  const [kind, setKind] = useState<HfKind>("header");
  const [type, setType] = useState<HfType>("default");
  const load = (k: HfKind, t: HfType) => hfLines(doc, k, t);
  const [lines, setLines] = useState<HfLine[]>(() => load("header", "default"));
  const [focus, setFocus] = useState<{ i: number; at: number } | null>(null);
  const first = doc.page.titlePg ?? false;
  const switchTo = (k: HfKind, t: HfType) => { setKind(k); setType(t); setLines(load(k, t)); setFocus(null); };
  const opened = useRef(doc);
  useEffect(() => { if (opened.current !== doc) { opened.current = doc; switchTo("header", "default"); } }); // another document was opened
  const seenGen = useRef(gen);
  useEffect(() => { if (seenGen.current !== gen) { seenGen.current = gen; setLines(load(kind, type)); } }); // undo/redo restored the parts
  const apply = (fn: (d: WordDoc) => void, k = kind, t = type) => { onApply(fn); setLines(load(k, t)); }; // onApply runs synchronously
  const exists = load(kind, type).length > 0;
  const insert = (tok: string) => {
    const i = focus && !lines[focus.i]?.locked ? focus.i : lines.findIndex((l) => !l.locked);
    if (i < 0) { setLines([...lines, { text: tok, align: "center" }]); return; }
    const at = focus && focus.i === i ? focus.at : lines[i].text.length;
    setLines(lines.map((l, j) => (j === i ? { ...l, text: l.text.slice(0, at) + tok + l.text.slice(at) } : l))); setFocus({ i, at: at + tok.length });
  };
  const name = `${type === "first" ? "First-page " : ""}${kind}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="hf-panel">
      <div className="wside-h">Header &amp; footer</div>
      <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }} role="tablist" aria-label="Header or footer">
        {(["header", "footer"] as const).map((k) => (["default", ...(first ? ["first"] : [])] as HfType[]).map((t) => (
          <Btn key={k + t} variant={kind === k && type === t ? "primary" : "ghost"} role="tab" aria-selected={kind === k && type === t} onClick={() => switchTo(k, t)}>{t === "first" ? `First-page ${k}` : k[0].toUpperCase() + k.slice(1)}</Btn>
        )))}
      </div>
      <label><input type="checkbox" checked={first} aria-label="Different first page" onChange={(e) => { const on = e.target.checked; apply((d) => setDifferentFirst(d, on)); if (!on && type === "first") switchTo(kind, "default"); }} /> Different first page</label>
      {!exists && <div style={{ fontSize: fz(12), opacity: 0.75 }}>This document has no {name} yet — type below and Apply to add one.</div>}
      {lines.map((l, i) => (
        <div key={l.id ?? `n${i}`} className="fs-row" style={{ gap: 4, alignItems: "center" }} data-testid="hf-line">
          {l.locked ? <span style={{ flex: 1, fontSize: fz(12), opacity: 0.8 }} title="Kept exactly as in the document">{l.text || "(empty)"} <em>· {l.label} — kept as is</em></span>
            : <input className="fs-input" style={{ flex: "1 1 10em", minWidth: "8em" }} aria-label={`${name} line ${i + 1}`} value={l.text} maxLength={2000}
              onChange={(e) => { const v = e.target.value; setLines(lines.map((x, j) => (j === i ? { ...x, text: v } : x))); setFocus({ i, at: e.target.selectionStart ?? v.length }); }}
              onSelect={(e) => setFocus({ i, at: e.currentTarget.selectionStart ?? 0 })} />}
          <select className="fs-select" style={{ flex: "0 0 auto", width: "auto" }} aria-label={`${name} line ${i + 1} alignment`} value={l.align ?? "left"} disabled={l.locked} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, align: e.target.value as HfAlign } : x)))}>
            <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option>
          </select>
          <Btn variant="ghost" aria-label={`Remove ${name} line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</Btn>
        </div>
      ))}
      <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={() => setLines([...lines, { text: "", align: lines.at(-1)?.align ?? "left" }])}>Add line</Btn>
        <Btn variant="ghost" onClick={() => insert("{PAGE}")}>Insert page number</Btn>
        <Btn variant="ghost" onClick={() => insert("{NUMPAGES}")}>Insert page count</Btn>
        <Btn variant="ghost" title="Tab moves focus in a text box, so this inserts a column tab (centre / right column in a three-part header)" onClick={() => insert("\t")}>Insert tab</Btn>
      </div>
      <div className="fs-row" style={{ gap: 4 }}>
        <Btn onClick={() => { const ls = lines; apply((d) => { setHf(d, kind, type, ls); }); }}>Apply {name}</Btn>
        {exists && <Btn variant="ghost" onClick={() => apply((d) => removeHf(d, kind, type))}>Remove {name}</Btn>}
      </div>
      <div style={{ fontSize: fz(12), opacity: 0.75 }}>{"{PAGE}"} and {"{NUMPAGES}"} become live page fields. Pictures, other fields and links in a line keep it locked so they are never flattened. Applies to the document&apos;s last section (sections without their own header use it, as in Word).</div>
    </div>
  );
}

function PageSetup({ doc, onApply }: { doc: WordDoc; onApply: (o: { paper?: string; landscape?: boolean; margins?: { top: number; right: number; bottom: number; left: number } }) => void }) {
  const p = doc.page;
  const cur = Object.entries(E.PAPER).find(([, [w, h]]) => (Math.abs(w - Math.min(p.w, p.h)) < 30 && Math.abs(h - Math.max(p.w, p.h)) < 30))?.[0] ?? "Custom";
  const [m, setM] = useState({ top: p.top / 1440, right: p.right / 1440, bottom: p.bottom / 1440, left: p.left / 1440 });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="wside-h">Page setup</div>
      <label>Paper <select className="fs-select" value={cur} onChange={(e) => onApply({ paper: e.target.value })} aria-label="Paper size">{[...Object.keys(E.PAPER), ...(cur === "Custom" ? ["Custom"] : [])].map((k) => <option key={k}>{k}</option>)}</select></label>
      <label>Orientation <select className="fs-select" value={p.landscape || p.w > p.h ? "landscape" : "portrait"} onChange={(e) => onApply({ landscape: e.target.value === "landscape" })} aria-label="Orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
      <div className="wside-h">Margins (inches)</div>
      {(["top", "right", "bottom", "left"] as const).map((k) => <label key={k} style={{ display: "flex", justifyContent: "space-between" }}>{k[0].toUpperCase() + k.slice(1)} <input className="fs-input" type="number" step={0.05} min={0} max={4} value={m[k]} aria-label={`${k} margin`} onChange={(e) => setM({ ...m, [k]: Number(e.target.value) })} style={{ width: 80 }} /></label>)}
      <Btn onClick={() => onApply({ margins: { top: Math.round(m.top * 1440), right: Math.round(m.right * 1440), bottom: Math.round(m.bottom * 1440), left: Math.round(m.left * 1440) } })}>Apply margins</Btn>
      <div style={{ fontSize: fz(12), opacity: 0.75 }}>{(p.w / 1440).toFixed(2)}″ × {(p.h / 1440).toFixed(2)}″ · {p.cols && p.cols > 1 ? `${p.cols} columns (shown as one)` : "1 column"}</div>
    </div>
  );
}
const PRINT_CSS = `.wp{margin:0}.wtbl{border-collapse:collapse;table-layout:fixed;margin:2px 0}.wtbl td{vertical-align:top;padding:2px 6px}.wtbl-b td{border:1px solid #444}.wtok-fieldcode,.wtok-bookmark,.wtok-comment{display:none}.wtok-note{vertical-align:super;font-size:70%}.wtok-del{text-decoration:line-through;color:#b00020}.wtok-ins{text-decoration:underline;color:#0a5}.wlink{color:#0563c1;text-decoration:underline}.wnotes{border-top:1px solid #999;margin-top:18px;padding-top:6px;font-size:9pt}.wnotes-h{font-weight:600}`;
const WRITER_CSS = `
.writer .wpage{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18),0 6px 18px rgba(0,0,0,.08);border-radius:2px}
.writer .wdoc{font-family:${cssFont("Calibri")};font-size:11pt;line-height:1.17}
.writer .wdoc .wp{margin:0;min-height:1em}
.writer .wtbl{border-collapse:collapse;table-layout:fixed;margin:2px 0}
.writer .wtbl td{vertical-align:top;padding:2px 6px;border:1px dashed #d0d4da}
.writer .wtbl.wtbl-b td{border:1px solid #444}
.writer .wtok-fieldcode,.writer .wtok-bookmark,.writer .wtok-comment,.writer .wtok-page,.writer .wtok-column{display:inline-block;width:0;overflow:hidden;vertical-align:baseline}
.writer .wtok-page{display:inline-block;width:100%;border-top:1px dashed #9aa4b2;height:0;margin-top:4px}
.writer .wtok-note{vertical-align:super;font-size:70%;color:#1f4fbf;cursor:help;padding:0 1px}
.writer .wtok-commentRef{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f2b705;vertical-align:super;margin:0 1px}
.writer .wtok-del{text-decoration:line-through;color:#b00020}
.writer .wtok-ins{text-decoration:underline;color:#0a7a3f}
.writer .wtok-math,.writer .wtok-box,.writer .wtok-field,.writer .wtok-other,.writer .wtok-sym{background:#eef2f7;border-radius:3px;padding:0 2px}
.writer .wtok:empty:not(img):not(.wtok-page):not(.wtok-commentRef){display:inline;padding:0;background:none;width:0}
.writer .wtok-image{display:inline-block}
.writer .wtok-noprev{display:inline-flex;align-items:center;justify-content:center;background:#f3f4f6;border:1px dashed #9ca3af;color:#4b5563;font-size:9pt}
.writer img.wimg-sel{outline:2px solid #2563eb;outline-offset:1px}
.writer .wlink{color:#0563c1;text-decoration:underline;cursor:text}
.writer .wcmt{background:rgba(242,183,5,.22)}
.writer .wbox{border-left:2px solid #c7d2fe;padding-left:3px}
.writer .wopq{background:#f3f4f6;color:#4b5563;border:1px dashed #cbd5e1;padding:2px 6px;margin:2px 0;font-size:9pt;border-radius:3px}
.writer .wnotes{border-top:1px solid #9ca3af;margin-top:18px;padding-top:6px;font-size:9pt;color:#222}
.writer .wnotes-h{font-weight:600;margin-bottom:4px}.writer .wnote{display:flex;gap:6px}
.writer .wside{width:220px;overflow:auto;border-left:1px solid var(--fs-border);border-right:1px solid var(--fs-border);padding:8px;display:flex;flex-direction:column;gap:6px;font-size:${fz(13)}}
.writer .wside-h{font-weight:600;opacity:.85}
.writer .wnav{all:unset;cursor:pointer;padding:3px 6px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.writer .wnav:hover,.writer .wcom:hover{background:var(--fs-hover, rgba(0,0,0,.06))}
.writer .wcom{all:unset;cursor:pointer;display:block;padding:6px;border-radius:6px;border:1px solid var(--fs-border)}
.writer .wchg{padding:4px 6px;border-radius:6px;border-left:3px solid #0a7a3f;background:rgba(10,122,63,.06)}
.writer .wchg-del{border-left-color:#b00020;background:rgba(176,0,32,.06)}
.writer .wsep{width:1px;align-self:stretch;background:var(--fs-border);margin:0 2px}
`;
