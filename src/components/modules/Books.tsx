"use client";
/**
 * TT75 — Books: an on-device EPUB 2 / 3 reader (FF-10). Package parsing in src/lib/epub/epub-core.ts, content
 * sanitising in src/lib/epub/epub-content.ts (both headless-tested). Each spine document is shown in a frame with
 * sandbox="allow-same-origin" and NO allow-scripts (book scripts never run), loaded from a blob: XHTML document that
 * carries its own CSP (resources only from blob:/data:). Nothing is uploaded; remote resources are not fetched.
 *
 *  Reflowable: paginated (CSS multi-column, one column per screen) or scrolled; font size, light / sepia / dark;
 *              right-to-left page progression flips the page keys; vertical writing falls back to scrolling.
 *  Fixed layout: one page per spine item at its viewport size (first <meta name="viewport">), scaled to fit;
 *              synthetic spreads in landscape following rendition:spread and page-spread-*.
 *  Navigation: contents (EPUB 3 nav or NCX), page list, internal links (to the first matching spine item; linear="no"
 *              items are reachable by link), external links only after asking, search across the book, keyboard
 *              (arrows, Page Up/Down, Home/End, Ctrl+F), the position remembered per book on this device.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fz } from "@/lib/uiscale";
import { api } from "@/lib/api";
import { fromB64 } from "@/lib/crypto";
import { askConfirm } from "@/lib/ask";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import { openEpub, chapterText, spineIndexOf, spreadGroups, progression, CORE_IMAGE, type EpubBook, type NavPoint, type ManifestItem } from "@/lib/epub/epub-core";
import { bookProgress, chapterLabel as chapterProgressLabel } from "@/lib/book-progress";
import { bookPositionText } from "@/lib/position-text";
import { prepareChapter, fxlViewport } from "@/lib/epub/epub-content";

type Theme = "light" | "sepia" | "dark";
type Mode = "paginated" | "scrolled";
interface Prefs { mode: Mode; font: number; theme: Theme; spreads: boolean }
const PREFS_KEY = "fusion.books.prefs";
const POS_KEY = (id: string) => `fusion.books.pos:${id}`;
const THEMES: Record<Theme, { bg: string; fg: string; link: string }> = {
  light: { bg: "#ffffff", fg: "#1f2328", link: "#0b57d0" },
  sepia: { bg: "#f6efdf", fg: "#3b2f1e", link: "#7a4a12" },
  dark: { bg: "#17191e", fg: "#e7e9ee", link: "#8ab4ff" },
};
const loadPrefs = (): Prefs => {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>; return { mode: p.mode === "scrolled" ? "scrolled" : "paginated", font: typeof p.font === "number" && p.font >= 60 && p.font <= 300 ? p.font : 100, theme: p.theme === "sepia" || p.theme === "dark" ? p.theme : "light", spreads: p.spreads !== false }; }
  catch { return { mode: "paginated", font: 100, theme: "light", spreads: true }; }
};
interface Hit { idx: number; occ: number; snippet: string }

/** reader CSS for reflowable documents (pagination + preferences); fixed layout gets none */
function readerCss(p: Prefs, paginated: boolean): string {
  const t = THEMES[p.theme];
  const base = `html{font-size:${p.font}% !important;background:${t.bg} !important;color:${t.fg}}body{color:${t.fg}}a{color:${t.link}}img,svg,video{max-width:100%;height:auto;box-sizing:border-box}`
    + (p.theme === "light" ? "" : `body *{background-color:transparent}`) + "mark.fusion-hit{background:#ffd54f;color:#000}";
  return paginated
    ? `${base}html{height:100vh;margin:0 !important;padding:0 !important;overflow:hidden}body{margin:0 !important;height:100vh;box-sizing:border-box;padding:5vh 6vw !important;column-width:88vw;column-gap:12vw;column-fill:auto;max-width:none !important}`
    : `${base}html{margin:0}body{margin:0 auto !important;padding:4vh 6vw !important;max-width:46em;box-sizing:border-box}`;
}

/** TT76: footer page arrows — a 44 px target (WCAG 2.5.5 AAA) and a glyph large enough to read as an arrow. */
const PAGE_ARROW = { minWidth: 44, minHeight: 44, fontSize: fz(22), lineHeight: 1, padding: "0 10px", fontWeight: 600 } as const;

export default function BooksModule({ win }: ModuleProps) {
  const shell = useShell();
  const [path] = useState<string>((win.props.path as string) ?? "");
  const [book, setBook] = useState<EpubBook | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [idx, setIdx] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [prefs, setPrefs] = useState<Prefs>(() => (typeof localStorage === "undefined" ? { mode: "paginated", font: 100, theme: "light", spreads: true } : loadPrefs()));
  const [panel, setPanel] = useState<"toc" | "search" | "info" | null>(null);
  const [docs, setDocs] = useState<{ idx: number; url: string; vp: { width: number; height: number } | null; notes: string[]; error?: string }[]>([]);
  const [query, setQuery] = useState(""); const [hits, setHits] = useState<Hit[] | null>(null);
  const [stage, setStage] = useState({ w: 900, h: 600 });
  const stageRef = useRef<HTMLDivElement>(null);
  const frames = useRef<(HTMLIFrameElement | null)[]>([]);
  const urls = useRef(new Map<string, string>()); // resource blob URLs for the current book
  const docUrls = useRef<string[]>([]);
  const pending = useRef<{ frag?: string; page?: "last" | number; frac?: number; hit?: { query: string; occ: number } } | null>(null);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const goHrefRef = useRef<(href: string) => void>(() => {});
  useEffect(() => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage full / private mode */ } }, [prefs]);

  const revokeAll = useCallback(() => { for (const u of urls.current.values()) URL.revokeObjectURL(u); urls.current.clear(); for (const u of docUrls.current) URL.revokeObjectURL(u); docUrls.current = []; }, []);
  useEffect(() => () => revokeAll(), [revokeAll]);
  useEffect(() => { const el = stageRef.current; if (!el) return; const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); setStage({ w: el.clientWidth, h: el.clientHeight }); return () => ro.disconnect(); }, [book]);

  /* ------------------------------------------------------------ open */
  const openBytes = useCallback(async (bytes: Uint8Array, nm: string) => {
    setErr(""); revokeAll();
    try {
      const b = await openEpub(bytes);
      let start = 0, frac = 0;
      try { const p = JSON.parse(localStorage.getItem(POS_KEY(b.identifier || nm)) ?? "null") as { idx?: number; frac?: number } | null; if (p && Number.isInteger(p.idx) && p.idx! >= 0 && p.idx! < b.spine.length) { start = p.idx!; frac = Math.min(1, Math.max(0, Number(p.frac) || 0)); } } catch { /* ignore */ }
      if (!start) { const firstLinear = b.spine.findIndex((s) => s.linear); start = firstLinear >= 0 ? firstLinear : 0; }
      pending.current = frac ? { frac } : null;
      // rendition:flow sets how this book starts (the reader can still switch)
      if (b.flow === "paginated") setPrefs((p) => ({ ...p, mode: "paginated" })); else if (b.flow.startsWith("scrolled")) setPrefs((p) => ({ ...p, mode: "scrolled" }));
      setBook(b); setName(nm); setIdx(start); setPage(0); setHits(null);
    } catch (e) { setBook(null); setErr(`Could not open ${nm}: ${(e as Error).message}`); }
  }, [revokeAll]);
  useEffect(() => {
    if (!path) return; let live = true;
    (async () => {
      try {
        const r = await api<{ node: { content: string; encoding?: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
        const bytes = r.node.encoding === "base64" ? fromB64(r.node.content) : new TextEncoder().encode(r.node.content);
        if (live) await openBytes(bytes, path.split("/").pop() || "book.epub");
      } catch (e) { if (live) setErr(`Could not open ${path}: ${(e as Error).message}`); }
    })();
    return () => { live = false; };
  }, [path, openBytes]);
  const pick = async (f: File | undefined) => { if (f) await openBytes(new Uint8Array(await f.arrayBuffer()), f.name); };

  const urlFor = useCallback(async (p: string, item: ManifestItem): Promise<string | null> => {
    if (!book) return null;
    const have = urls.current.get(p); if (have) return have;
    try { const b = await book.read(p); if (!b) return null; const u = URL.createObjectURL(new Blob([b as Uint8Array<ArrayBuffer>], { type: item.mediaType || "application/octet-stream" })); urls.current.set(p, u); return u; }
    catch { return null; }
  }, [book]);

  /* ------------------------------------------------------------ which spine items are on screen */
  const fxl = book?.spine[idx]?.layout === "pre-paginated";
  const roll = book?.layout === "roll";
  const [rollH, setRollH] = useState<Record<number, number>>({});
  const landscape = stage.w > stage.h * 1.05;
  const groups = useMemo(() => (book ? spreadGroups(book, landscape && prefs.spreads) : []), [book, landscape, prefs.spreads]);
  const group = useMemo(() => groups.find((g) => g.first === idx || g.second === idx), [groups, idx]);
  const shownIdx = useMemo(() => (roll && book ? book.spine.filter((s) => s.linear).map((s) => s.index) : fxl && group ? [group.first, group.second].filter((x): x is number => x !== null) : [idx]), [roll, book, fxl, group, idx]);
  const paginated = prefs.mode === "paginated" && !fxl && !roll;

  /* ------------------------------------------------------------ build the documents */
  useEffect(() => {
    if (!book) return; let live = true;
    (async () => {
      const out: typeof docs = [];
      for (const i of shownIdx) {
        const s = book.spine[i];
        try {
          let doc: string, type: string, notes: string[] = [];
          if (s.shown) {
            const css = s.layout === "pre-paginated" ? undefined : roll ? `${readerCss(prefs, false)}html,body{margin:0 !important;padding:0 !important;max-width:none !important;overflow:hidden}img,svg{display:block;width:100%}` : readerCss(prefs, paginated);
            const p = await prepareChapter(book, s.shown.path, { urlFor, readerCss: css });
            doc = p.doc; type = p.mediaType; notes = p.notes;
          } else if (CORE_IMAGE.has(s.item.mediaType) || s.item.mediaType === "image/avif") {
            const u = await urlFor(s.item.path, s.item);
            doc = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'"/><style>html,body{margin:0;height:100%;background:${THEMES[prefs.theme].bg}}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img src="${u ?? ""}" alt=""/></body></html>`;
            type = "application/xhtml+xml";
          } else throw new Error(`this part of the book (${s.item.path}, ${s.item.mediaType || "unknown type"}) has no fallback this reader can show`);
          let vp: { width: number; height: number } | null = null;
          if (s.layout === "pre-paginated") { const raw = s.shown ? await book.readText(s.shown.path) : null; vp = raw ? fxlViewport(raw) : null; if (!vp && !s.shown) vp = { width: 1200, height: 1600 }; }
          const url = URL.createObjectURL(new Blob([doc], { type })); docUrls.current.push(url);
          out.push({ idx: i, url, vp, notes });
        } catch (e) { out.push({ idx: i, url: "", vp: null, notes: [], error: (e as Error).message }); }
      }
      if (live) setDocs(out);
    })();
    return () => { live = false; };
  }, [book, shownIdx, prefs, paginated, urlFor]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ pagination inside the frame */
  const scroller = (f: HTMLIFrameElement | null) => f?.contentDocument?.scrollingElement as HTMLElement | null | undefined;
  const measure = useCallback(() => {
    const f = frames.current[0]; const se = scroller(f); const w = f?.contentWindow?.innerWidth ?? 0;
    if (!se || !w || !paginated) { setPages(1); return 1; }
    const n = Math.max(1, Math.round(se.scrollWidth / w)); setPages(n); return n;
  }, [paginated]);
  const showPage = useCallback((n: number) => {
    const f = frames.current[0]; const se = scroller(f); const w = f?.contentWindow?.innerWidth ?? 0;
    if (!se || !paginated) return;
    const rtlDoc = f?.contentWindow ? f.contentWindow.getComputedStyle(f.contentDocument!.documentElement).direction === "rtl" : false;
    se.scrollLeft = (rtlDoc ? -1 : 1) * n * w; setPage(n);
  }, [paginated]);
  const pageOf = (el: Element) => { const f = frames.current[0]; const w = f?.contentWindow?.innerWidth ?? 1; const se = scroller(f); const x = el.getBoundingClientRect().left + Math.abs(se?.scrollLeft ?? 0); return Math.max(0, Math.floor(x / w)); };

  const onFrameLoad = useCallback((slot: number) => {
    const f = frames.current[slot]; const d = f?.contentDocument; if (!f || !d || !book) return;
    d.addEventListener("click", (ev) => {
      const a = (ev.target as Element | null)?.closest?.("a,area"); if (!a) return;
      const ext = a.getAttribute("data-epub-ext"), href = a.getAttribute("data-epub-href");
      if (ext) { ev.preventDefault(); void (async () => { const ok = await askConfirm({ title: "Open a link outside the book?", detail: `${ext}\n\nThe book wants to open this address. Nothing is loaded unless you continue.`, okLabel: /^mailto:/i.test(ext) ? "Write e-mail" : "Open in Browser" }); if (ok) { if (/^mailto:/i.test(ext)) window.open(ext, "_blank", "noopener"); else shell.open("browser", { url: ext }); } })(); return; }
      if (href) { ev.preventDefault(); goHrefRef.current(href); }
    });
    d.addEventListener("keydown", (e) => keyRef.current(e));
    if (roll) { const h = () => {
      // TT75 fix: the CONTENT height (the root element's box), not scrollHeight — scrollHeight is never less than the
      // frame's own viewport, so every part was at least one stage tall and short parts left gaps
      const root = d.documentElement; const sp = Number(f.dataset.spine); if (!root || !Number.isInteger(sp)) return;
      const hh = Math.max(1, Math.ceil(Math.max(root.getBoundingClientRect().height, d.body?.getBoundingClientRect().height ?? 0)));
      setRollH((m) => (m[sp] === hh ? m : { ...m, [sp]: hh }));
    }; h(); d.querySelectorAll("img").forEach((im) => im.addEventListener("load", h)); return; }
    if (slot !== 0) return;
    const vertical = /^vertical/.test(f.contentWindow?.getComputedStyle(d.body ?? d.documentElement).writingMode ?? "");
    if (vertical && paginated) { const st = d.getElementById("epub-reader-css"); if (st) st.textContent = readerCss(prefs, false); }
    requestAnimationFrame(() => {
      const n = measure(); const pend = pending.current; pending.current = null;
      let target = 0;
      if (pend?.hit) { const m = markHit(d, pend.hit.query, pend.hit.occ); if (m) { if (paginated) target = pageOf(m); else m.scrollIntoView({ block: "center" }); } }
      else if (pend?.frag) { const el = d.getElementById(pend.frag) ?? d.getElementsByName(pend.frag)[0]; if (el) { if (paginated) target = pageOf(el); else el.scrollIntoView({ block: "start" }); } }
      else if (pend?.page === "last") target = n - 1;
      else if (pend?.frac) { if (paginated) target = Math.min(n - 1, Math.round(pend.frac * n)); else { const se = scroller(f); if (se) se.scrollTop = pend.frac * se.scrollHeight; } }
      showPage(Math.min(target, n - 1));
    });
  }, [book, paginated, prefs, measure, showPage, shell, roll]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (paginated && docs.length) { const n = measure(); if (page >= n) showPage(n - 1); else showPage(page); } }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------ navigation */
  const savePos = useCallback((i: number, frac: number) => { if (book) try { localStorage.setItem(POS_KEY(book.identifier || name), JSON.stringify({ idx: i, frac })); } catch { /* ignore */ } }, [book, name]);
  useEffect(() => { if (book) savePos(idx, pages > 1 ? page / pages : 0); }, [book, idx, page, pages, savePos]);
  const goIdx = useCallback((i: number, how?: typeof pending.current) => { if (!book || i < 0 || i >= book.spine.length) return; pending.current = how ?? null; setPage(0); setIdx(i); }, [book]);
  const goHref = useCallback((href: string) => {
    if (!book) return; const [p, frag] = href.split("#"); const i = spineIndexOf(book, p);
    if (i < 0) { shell.toast("That link points to something outside the reading order", "warn"); return; }
    if (i === idx && frag) { const d = frames.current[0]?.contentDocument; const el = d?.getElementById(frag); if (el) { if (paginated) showPage(pageOf(el)); else el.scrollIntoView({ block: "start" }); return; } }
    goIdx(i, frag ? { frag } : null);
  }, [book, idx, paginated, goIdx, showPage, shell]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextLinear = (from: number, dir: 1 | -1) => { if (!book) return -1; for (let i = from + dir; i >= 0 && i < book.spine.length; i += dir) if (book.spine[i].linear) return i; return -1; };
  const step = useCallback((dir: 1 | -1) => {
    if (!book) return;
    if (paginated && dir === 1 && page < pages - 1) { showPage(page + 1); return; }
    if (paginated && dir === -1 && page > 0) { showPage(page - 1); return; }
    if (fxl && group) { const edge = dir === 1 ? Math.max(...shownIdx) : Math.min(...shownIdx); const n = nextLinear(edge, dir); if (n >= 0) goIdx(n); return; }
    const n = nextLinear(idx, dir); if (n >= 0) goIdx(n, dir === -1 ? { page: "last" } : null);
  }, [book, paginated, page, pages, fxl, group, shownIdx, idx, goIdx, showPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const rtl = book ? progression(book) === "rtl" : false;
  // handlers read the latest state; refs are updated after render (react-hooks/refs)
  useEffect(() => {
    goHrefRef.current = goHref;
    keyRef.current = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      const k = e.key; const mod = e.ctrlKey || e.metaKey;
      if (mod && k.toLowerCase() === "f") { e.preventDefault(); setPanel("search"); setTimeout(() => (document.getElementById(`${win.id}-bookfind`) as HTMLInputElement | null)?.focus(), 0); return; }
      if (k === "ArrowRight") { e.preventDefault(); step(rtl ? -1 : 1); }
      else if (k === "ArrowLeft") { e.preventDefault(); step(rtl ? 1 : -1); }
      else if (k === "PageDown" || (k === " " && !e.shiftKey && paginated)) { e.preventDefault(); step(1); }
      else if (k === "PageUp" || (k === " " && e.shiftKey && paginated)) { e.preventDefault(); step(-1); }
      else if (k === "Home" && mod) { e.preventDefault(); goIdx(0); }
      else if (k === "End" && mod && book) { e.preventDefault(); goIdx(book.spine.length - 1); }
    };
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { const t = e.target as Element | null; if (t?.closest?.(`[data-books-win="${win.id}"]`)) keyRef.current(e); };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [win.id]);

  /* ------------------------------------------------------------ search */
  const runSearch = useCallback(async () => {
    if (!book || !query.trim()) { setHits(null); return; }
    const q = query.trim().toLowerCase(); const out: Hit[] = [];
    for (const s of book.spine) {
      if (!s.shown || s.shown.mediaType !== "application/xhtml+xml") continue;
      const t = await book.readText(s.shown.path).catch(() => null); if (!t) continue;
      const text = chapterText(t); const low = text.toLowerCase(); let at = low.indexOf(q), occ = 0;
      while (at >= 0 && out.length < 500) { out.push({ idx: s.index, occ, snippet: `${at > 40 ? "…" : ""}${text.slice(Math.max(0, at - 40), at + q.length + 60).replace(/\s+/g, " ")}…` }); occ++; at = low.indexOf(q, at + q.length); }
    }
    setHits(out);
  }, [book, query]);

  const chapterLabel = useMemo(() => {
    if (!book) return ""; const p = book.spine[idx]?.item.path;
    const find = (ns: NavPoint[]): string | null => { for (const n of ns) { if (n.href?.split("#")[0] === p) return n.label; const c = find(n.children); if (c) return c; } return null; };
    return find(book.toc) ?? "";
  }, [book, idx]);
  const t = THEMES[prefs.theme];
  const notes = docs.flatMap((d) => d.notes);

  /* ------------------------------------------------------------ render */
  // TT75 fix: a plain render function, not a component declared inside render — a new component type on every render
  // remounted the list, so a press (which re-renders the window) and its release hit different nodes and the click was lost
  const tocList = (items: NavPoint[], depth: number): ReactNode => (
    <ul style={{ listStyle: "none", margin: 0, paddingLeft: depth ? 14 : 0 }}>
      {items.map((n, i) => (
        <li key={i}>
          {n.href && !/^[a-z]+:/i.test(n.href)
            ? <button className="fs-btn ghost" data-testid="books-toc-item" style={{ display: "block", width: "100%", textAlign: "start", fontSize: fz(13), padding: "4px 6px", fontWeight: book?.spine[idx]?.item.path === n.href.split("#")[0] ? 700 : 400 }} onClick={() => goHref(n.href!)}>{n.label}</button>
            : <div style={{ fontSize: fz(13), padding: "4px 6px", opacity: 0.8 }}>{n.label}</div>}
          {n.children.length ? tocList(n.children, depth + 1) : null}
        </li>
      ))}
    </ul>
  );
  const frameBox = (d: (typeof docs)[number], slot: number, w: number, h: number) => {
    if (d.error) return <div key={d.idx} role="alert" data-testid="books-error-part" style={{ width: w, padding: 24, fontSize: fz(14), color: t.fg }}>{d.error}</div>;
    const vp = d.vp; const scale = vp ? Math.min(w / vp.width, h / vp.height) : 1;
    return (
      <div key={d.url} style={{ width: vp ? vp.width * scale : w, height: vp ? vp.height * scale : h, overflow: "hidden", position: "relative", flex: "none", background: "#fff" }}>
        <iframe ref={(el) => { frames.current[slot] = el; }} data-testid="books-frame" data-spine={d.idx} title={`${book?.title ?? "Book"} — part ${d.idx + 1}`} src={d.url} sandbox="allow-same-origin"
          onLoad={() => onFrameLoad(slot)}
          style={{ border: 0, width: vp ? vp.width : w, height: vp ? vp.height : h, transform: vp ? `scale(${scale})` : undefined, transformOrigin: "0 0", display: "block", background: vp ? "#fff" : t.bg }} />
      </div>
    );
  };
  const stageW = Math.max(200, stage.w), stageH = Math.max(200, stage.h);
  const pair = fxl && group && !group.single && landscape && prefs.spreads;
  const ordered = (() => {
    if (!pair || !group) return docs;
    const byIdx = new Map(docs.map((d) => [d.idx, d]));
    const firstD = group.first !== null ? byIdx.get(group.first) : undefined, secondD = group.second !== null ? byIdx.get(group.second) : undefined;
    const left = rtl ? secondD : firstD, right = rtl ? firstD : secondD;
    return [left ?? null, right ?? null];
  })();

  return (
    <div data-testid="books-app" data-books-win={win.id} tabIndex={-1} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, outline: "none" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 8px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
        <label className="fs-btn" style={{ cursor: "pointer" }}>Open…<input data-testid="books-open" type="file" accept="application/epub+zip,.epub" hidden onChange={(e) => void pick(e.target.files?.[0])} /></label>
        {book ? <>
          <Btn variant={panel === "toc" ? "primary" : "ghost"} data-testid="books-toc" onClick={() => setPanel(panel === "toc" ? null : "toc")}>Contents</Btn>
          <Btn variant={panel === "search" ? "primary" : "ghost"} data-testid="books-search" onClick={() => setPanel(panel === "search" ? null : "search")}>Search</Btn>
          {book ? <><Badge tone="info" data-testid="books-progress">{chapterProgressLabel(idx, book.spine.length)} · {bookProgress(idx, book.spine.length, pages > 1 ? page / (pages - 1) : 0)}% read</Badge> <Btn variant="ghost" onClick={() => void shell.copy(bookPositionText(book.title, (bookProgress(idx, book.spine.length, pages > 1 ? page / (pages - 1) : 0)) / 100, chapterProgressLabel(idx, book.spine.length)), "books")} data-testid="books-copy-position">Copy position</Btn></> : null}
          <Btn variant={panel === "info" ? "primary" : "ghost"} data-testid="books-info" onClick={() => setPanel(panel === "info" ? null : "info")}>About</Btn>
          <span style={{ width: 1, height: 22, background: "var(--line)" }} />
          <Btn variant="ghost" data-testid="books-font-down" title="Smaller text" onClick={() => setPrefs({ ...prefs, font: Math.max(60, prefs.font - 10) })}>A−</Btn>
          <span data-testid="books-font" style={{ fontSize: fz(12), minWidth: 36, textAlign: "center" }}>{prefs.font}%</span>
          <Btn variant="ghost" data-testid="books-font-up" title="Larger text" onClick={() => setPrefs({ ...prefs, font: Math.min(300, prefs.font + 10) })}>A+</Btn>
          <select className="fs-input" data-testid="books-theme" aria-label="Page colour" value={prefs.theme} onChange={(e) => setPrefs({ ...prefs, theme: e.target.value as Theme })} style={{ width: "auto" }}>
            <option value="light">Light</option><option value="sepia">Sepia</option><option value="dark">Dark</option>
          </select>
          <select className="fs-input" data-testid="books-mode" aria-label="Layout" value={prefs.mode} onChange={(e) => setPrefs({ ...prefs, mode: e.target.value as Mode })} style={{ width: "auto" }}>
            <option value="paginated">Pages</option><option value="scrolled">Scroll</option>
          </select>
          {book.layout === "pre-paginated" || book.spine.some((s) => s.layout === "pre-paginated") ? <label style={{ fontSize: fz(12), display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" data-testid="books-spreads" checked={prefs.spreads} onChange={(e) => setPrefs({ ...prefs, spreads: e.target.checked })} />Two-page spreads</label> : null}
        </> : null}
        <span style={{ flex: 1 }} />
        {book ? <span data-testid="books-title" style={{ fontSize: fz(13), fontWeight: 600, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={book.title}>{book.title}</span> : null}
      </div>
      {err ? <div role="alert" data-testid="books-error" style={{ padding: 16, color: "var(--bad, #b42318)", fontSize: fz(14) }}>{err}</div> : null}
      {!book && !err ? <div style={{ padding: 32, fontSize: fz(15), opacity: 0.85 }}>Open an EPUB book from Files, or choose one from this device. Books are read entirely on this device; scripts inside books never run.</div> : null}
      {book ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {panel ? (
            <aside data-testid={`books-panel-${panel}`} style={{ width: 280, flex: "none", borderInlineEnd: "1px solid var(--line)", overflow: "auto", padding: 8 }}>
              {panel === "toc" ? (book.toc.length ? <nav aria-label="Contents">{tocList(book.toc, 0)}{book.pageList.length ? <><h4 style={{ fontSize: fz(13), margin: "12px 6px 4px" }}>Pages</h4>{tocList(book.pageList, 0)}</> : null}</nav> : <div style={{ fontSize: fz(13) }}>This book has no table of contents.</div>) : null}
              {panel === "search" ? (
                <div>
                  <form onSubmit={(e) => { e.preventDefault(); void runSearch(); }} style={{ display: "flex", gap: 4 }}>
                    <input id={`${win.id}-bookfind`} data-testid="books-find" className="fs-input" placeholder="Find in book" value={query} onChange={(e) => setQuery(e.target.value)} />
                    <Btn type="submit" variant="primary">Find</Btn>
                  </form>
                  {hits ? <div data-testid="books-hits" style={{ fontSize: fz(12), margin: "6px 2px" }}>{hits.length >= 500 ? "500+ matches" : `${hits.length} match${hits.length === 1 ? "" : "es"}`}</div> : null}
                  {hits?.map((h, i) => <button key={i} className="fs-btn ghost" data-testid="books-hit" style={{ display: "block", width: "100%", textAlign: "start", fontSize: fz(12), padding: "4px 6px", whiteSpace: "normal" }} onClick={() => goIdx(h.idx, { hit: { query: query.trim(), occ: h.occ } })}>{h.snippet}</button>)}
                </div>
              ) : null}
              {panel === "info" ? (
                <dl data-testid="books-meta" style={{ fontSize: fz(13), margin: 0 }}>
                  {([["Title", book.title], ["By", book.creators.join(", ")], ["Language", book.language], ["Publisher", book.publisher], ["Identifier", book.identifier], ["EPUB version", book.version], ["Layout", book.layout === "pre-paginated" ? "fixed layout" : "reflowable"], ["Page progression", book.direction], ["Parts", String(book.spine.length)]] as const).filter(([, v]) => v).map(([k, v]) => <div key={k} style={{ marginBottom: 6 }}><dt style={{ fontWeight: 600 }}>{k}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{v}</dd></div>)}
                  {book.description ? <div style={{ marginBottom: 6 }}><dt style={{ fontWeight: 600 }}>Description</dt><dd style={{ margin: 0 }}>{book.description}</dd></div> : null}
                  {[...book.warnings, ...notes].length ? <div><dt style={{ fontWeight: 600 }}>Notes</dt>{[...new Set([...book.warnings, ...notes])].map((w, i) => <dd key={i} style={{ margin: "2px 0" }}>{w}</dd>)}</div> : null}
                </dl>
              ) : null}
            </aside>
          ) : null}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div ref={stageRef} data-testid="books-stage" style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center", alignItems: "center", gap: 0, background: fxl ? "#e8eaef" : t.bg, overflow: "hidden" }}>
              {roll
                ? <div data-testid="books-roll" style={{ width: "100%", height: "100%", overflowY: "auto" }}>{docs.map((d, i) => (d.error ? frameBox(d, i, stageW, stageH) : <iframe key={d.url} ref={(el) => { frames.current[i] = el; }} data-testid="books-frame" data-spine={d.idx} title={`${book.title} — part ${d.idx + 1}`} src={d.url} sandbox="allow-same-origin" onLoad={() => onFrameLoad(i)} style={{ border: 0, display: "block", width: "100%", height: rollH[d.idx] ?? stageH, background: t.bg }} />))}</div>
                : pair
                ? ordered.map((d, i) => (d ? frameBox(d, docs.indexOf(d), stageW / 2, stageH) : <div key={`blank${i}`} style={{ width: stageW / 2 }} />))
                : docs.map((d, i) => frameBox(d, i, stageW, stageH))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderTop: "1px solid var(--line)", fontSize: fz(12) }}>
              <Btn variant="ghost" data-testid={rtl ? "books-next" : "books-prev"} aria-label={rtl ? "Next page" : "Previous page"} onClick={() => step(rtl ? 1 : -1)} style={PAGE_ARROW}>‹</Btn>
              <span data-testid="books-progress" style={{ flex: 1, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {chapterLabel ? `${chapterLabel} · ` : ""}part {idx + 1} of {book.spine.length}{paginated ? ` · page ${page + 1} of ${pages}` : ""}{book.spine[idx]?.linear === false ? " · (outside the reading order)" : ""}
              </span>
              {notes.length ? <Badge tone="info" title={notes.join("\n")}>{notes.length} note{notes.length === 1 ? "" : "s"}</Badge> : null}
              <Btn variant="ghost" data-testid={rtl ? "books-prev" : "books-next"} aria-label={rtl ? "Previous page" : "Next page"} onClick={() => step(rtl ? -1 : 1)} style={PAGE_ARROW}>›</Btn>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** wrap the occ-th case-insensitive match of q in the document's text in <mark> (namespace-aware); returns it */
function markHit(d: Document, q: string, occ: number): Element | null {
  const body = d.body ?? d.documentElement; const low = q.toLowerCase(); let seen = 0;
  const w = d.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const pe = n.parentElement; if (pe && /^(script|style)$/i.test(pe.localName)) continue;
    const s = n.data.toLowerCase(); let at = s.indexOf(low);
    while (at >= 0) {
      if (seen === occ) {
        const r = d.createRange(); r.setStart(n, at); r.setEnd(n, at + q.length);
        const m = d.createElementNS("http://www.w3.org/1999/xhtml", "mark"); m.setAttribute("class", "fusion-hit");
        try { r.surroundContents(m); } catch { return n.parentElement; }
        return m;
      }
      seen++; at = s.indexOf(low, at + low.length);
    }
  }
  return null;
}
