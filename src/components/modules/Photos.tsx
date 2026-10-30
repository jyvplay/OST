"use client";
/**
 * TT54 — MD-03 Photos: a library + non-destructive editor + exporter, entirely local.
 *
 *  library   every image outside /System (one /api/fs?op=media query), grouped by month of the EXIF capture date
 *            (DateTimeOriginal + OffsetTimeOriginal; file creation time when a photo has none — shown as such).
 *            Dates / sizes / camera / GPS are indexed in the browser (localStorage, keyed by content hash) so a
 *            photo is parsed once. Views: All, Favorites, Edited, Places (photos with coordinates).
 *  editor    rotate, flip, straighten, crop (aspect + zoom + pan), exposure, contrast, highlights, shadows,
 *            saturation, vibrance, warmth, tint, vignette, 6 presets; undo / redo; hold "Compare" for the original.
 *            The edit is a recipe in the hidden sidecar ".<name>.edit.json" beside the photo (the original bytes are
 *            never touched); thumbnails everywhere re-key on it. Rating (0–5 stars) and favourite live in the sidecar.
 *  export    JPEG / PNG / WebP via the canvas encoder, AVIF via WebCodecs AV1 + our AVIF writer when the platform has
 *            no AVIF canvas encoder, HEIC only where the platform has an HEVC encoder (otherwise refused with the
 *            reason). Optional curated EXIF (camera, exposure, capture time; Orientation reset to 1, new pixel size,
 *            MakerNote / thumbnail dropped); location only when "Include location" is ticked (off by default).
 */
import { photoTimeline } from "@/lib/photo-timeline";
import { clampInterval, nextIndex } from "@/lib/slideshow";
import { shuffleOrder } from "@/lib/shuffle-order";
import { undatedPhotos } from "@/lib/photo-dates";
import { neighbor, positionLabel } from "@/lib/photo-order";
import { AppBanner, BannerGroup } from "@/components/AppBanner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { api, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { UiGlyph } from "../AppIcon";
import { sortPhotos, type PhotoSort } from "@/lib/photo-sort";
import Thumb from "../Thumb";
import { readFileBytes, readRecipe, readRecipeForEditing, forgetThumbnail, bytesToB64, type RecipeIdentity } from "@/lib/thumbs/service";
import { PRESETS, isIdentity, isSidecar, outputSize, parseRecipe, photoOfSidecar, renderRecipe, sidecarPath, type PhotoRecipe, type PresetName } from "@/lib/photos/recipe";
import { privacy } from "@/lib/privacy/session";
import { isPrivatePath } from "@/lib/privacy/pcrypt";
import type { FileMeta } from "@/lib/meta";

interface Item { id: number; version: number; path: string; name: string; mime: string; size: number; sha256: string; createdAt: string; updatedAt: string }
interface Info { date?: string; dateSource: "exif" | "file"; w?: number; h?: number; camera?: string; lat?: number; lon?: number }
type View = "all" | "favorites" | "edited" | "places" | "undated";
const INDEX_KEY = "fusion.photos.index.v1";
const DECODABLE = /^image\/(jpeg|png|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)$/;

function loadIndex(): Record<string, Info> {
  try { const j = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}"); return j && typeof j === "object" ? j as Record<string, Info> : {}; } catch { return {}; }
}
function saveIndex(ix: Record<string, Info>) {
  const keys = Object.keys(ix); if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete ix[k];
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(ix)); } catch { /* quota: the index is a cache */ }
}
const monthLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long" });

export default function PhotosModule({ win }: ModuleProps) {
  const shell = useShell();
  const [items, setItems] = useState<Item[] | null>(null);
  const [recipes, setRecipes] = useState<Record<string, PhotoRecipe>>({});
  const [sidecars, setSidecars] = useState<Set<string>>(new Set());
  const [index, setIndex] = useState<Record<string, Info>>({});
  const [view, setView] = useState<View>("all");
  const [photoSort, setPhotoSort] = useState<PhotoSort>("captured");
  const [open, setOpen] = useState<string | null>((win.props.path as string) ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ items: Item[] }>("/api/fs?op=media").then(async (r) => {
      const photos = r.items.filter((i) => i.mime.startsWith("image/") && !isSidecar(i.path));
      const sc = new Set(r.items.filter((i) => isSidecar(i.path)).map((i) => photoOfSidecar(i.path)).filter((p): p is string => !!p));
      setItems(photos); setSidecars(sc); setIndex(loadIndex());
      // sidecars are small: read them so the library knows ratings / favourites / edits
      const entries = await Promise.all([...sc].filter((p) => photos.some((x) => x.path === p)).slice(0, 2000).map(async (p) => [p, await readRecipe(p)] as const));
      setRecipes(Object.fromEntries(entries.filter(([, v]) => v).map(([k, v]) => [k, v!])));
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { load(); }, [load, shell.refreshTick]);

  // background indexing of capture dates / sizes / GPS (two at a time, content-hash keyed)
  useEffect(() => {
    if (!items) return;
    let live = true;
    const ix = loadIndex(); const todo = items.filter((i) => !ix[i.sha256]);
    if (!todo.length) return;
    (async () => {
      const { readMetadata } = await import("@/lib/meta");
      let n = 0;
      const one = async (it: Item) => {
        const bytes = it.size <= 96 << 20 ? await readFileBytes(it.path) : null;
        const info: Info = { dateSource: "file", date: it.createdAt };
        if (bytes) {
          const m = await readMetadata(bytes, it.name).catch(() => null);
          if (m) {
            if (m.tags.dateTaken) { info.date = m.tags.dateTaken; info.dateSource = "exif"; }
            info.w = m.displayWidth ?? m.width; info.h = m.displayHeight ?? m.height;
            const cam = [m.tags.make, m.tags.model].filter(Boolean).join(" ").trim(); if (cam) info.camera = cam;
            if (m.gps) { info.lat = m.gps.lat; info.lon = m.gps.lon; }
          }
        }
        ix[it.sha256] = info; n++;
        if (live && n % 6 === 0) { saveIndex(ix); setIndex({ ...ix }); }
      };
      const queue = [...todo];
      await Promise.all([0, 1].map(async () => { while (live && queue.length) await one(queue.shift()!).catch(() => {}); }));
      saveIndex(ix); if (live) setIndex({ ...ix });
    })().catch(() => {});
    return () => { live = false; };
  }, [items]);

  const shown = useMemo(() => {
    if (!items) return [];
    const f = sortPhotos(items.filter((i) => view === "all" ? true : view === "favorites" ? recipes[i.path]?.favorite : view === "edited" ? recipes[i.path] && !isIdentity(recipes[i.path]) : view === "undated" ? undatedPhotos([i], index).length > 0 : index[i.sha256]?.lat !== undefined), photoSort);
    const dateOf = (i: Item) => index[i.sha256]?.date ?? i.createdAt;
    return [...f].sort((a, b) => Date.parse(dateOf(b)) - Date.parse(dateOf(a)));
  }, [items, view, recipes, index]);
  const groups = useMemo(() => {
    const g: { label: string; items: Item[] }[] = [];
    for (const it of shown) {
      const d = index[it.sha256]?.date ?? it.createdAt; const label = Number.isFinite(Date.parse(d)) ? monthLabel(d) : "Unknown date";
      const last = g[g.length - 1]; if (last && last.label === label) last.items.push(it); else g.push({ label, items: [it] });
    }
    return g;
  }, [shown, index]);

  const [showPlaying, setShowPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const shuffleRef = useRef<number[]>([]);
  const [showSecs, setShowSecs] = useState(4);
  useEffect(() => {
    if (!showPlaying || shown.length === 0) return;
    const t = window.setInterval(() => {
      const i = shown.findIndex((x) => x.path === open);
      if (shuffle) {
        if (shuffleRef.current.length !== shown.length) shuffleRef.current = shuffleOrder(shown.length, () => Math.random());
        const pos = shuffleRef.current.indexOf(i);
        const n = shown[shuffleRef.current[nextIndex(pos < 0 ? 0 : pos, shown.length)]];
        if (n) setOpen(n.path);
      } else {
        const n = shown[nextIndex(i, shown.length)];
        if (n) setOpen(n.path);
      }
    }, clampInterval(showSecs) * 1000);
    return () => window.clearInterval(t);
  }, [showPlaying, showSecs, shown, open, shuffle]);
  const current = items?.find((i) => i.path === open) ?? null;
  if (current) {
    return <PhotoEditor key={current.path + current.sha256} item={current} info={index[current.sha256]} showPlaying={showPlaying} onToggleShow={() => setShowPlaying((v) => !v)} onClose={() => { setShowPlaying(false); setOpen(null); }}
      nav={{ label: positionLabel(shown, current.path), prev: neighbor(shown, current.path, -1)?.item.path ?? null, next: neighbor(shown, current.path, 1)?.item.path ?? null, go: (path: string) => setOpen(path) }}
      onSaved={(r) => { setRecipes((m) => { const n = { ...m }; if (r) n[current.path] = r; else delete n[current.path]; return n; }); setSidecars((s) => { const n = new Set(s); if (r) n.add(current.path); else n.delete(current.path); return n; }); }}
      onExported={() => { load(); shell.bumpRefresh(); }} />;
  }

  const counts = { all: items?.length ?? 0, undated: items ? undatedPhotos(items, index).length : 0, favorites: items?.filter((i) => recipes[i.path]?.favorite).length ?? 0, edited: items?.filter((i) => recipes[i.path] && !isIdentity(recipes[i.path])).length ?? 0, places: items?.filter((i) => index[i.sha256]?.lat !== undefined).length ?? 0 };
  const indexed = items ? items.filter((i) => index[i.sha256]).length : 0;
  const timeline = photoTimeline((items ?? []).map((i) => ({ path: i.path, mime: i.mime, size: i.size, date: index[i.sha256]?.date ?? i.createdAt })));
  const timelineStrip = timeline.groups.length ? (
    <div className="fs-row" data-testid="photos-timeline" style={{ gap: 6, flexWrap: "wrap", padding: "4px 8px" }}>
      {timeline.groups.slice(0, 12).map((g) => <Badge key={g.month} tone="info">{g.month} · {g.count}</Badge>)}
      {timeline.undated.count ? <Badge tone="warn">undated · {timeline.undated.count}</Badge> : null}
    </div>
  ) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="photos-library">
      {timelineStrip}
      {shown.length > 1 ? <div className="fs-row" style={{ gap: 6, padding: "0 8px 6px", flexWrap: "wrap" }} data-testid="photos-slideshow">
        <Btn variant={showPlaying ? "primary" : "ghost"} aria-pressed={showPlaying} disabled={shown.length === 0} onClick={() => { if (!showPlaying && !open && shown[0]) setOpen(shown[0].path); setShowPlaying((v) => !v); }}>{showPlaying ? "Pause show" : "Play slideshow"}</Btn>
        <label style={{ fontSize: fz(11.5) }}>every <input className="fs-input" style={{ width: fz(52) }} type="number" min={1} max={60} value={showSecs} aria-label="Slideshow seconds per photo" onChange={(e) => setShowSecs(clampInterval(Number(e.target.value)))} /> s</label>
        <Btn variant={shuffle ? "primary" : "ghost"} aria-pressed={shuffle} onClick={() => setShuffle((v) => !v)} data-testid="photos-shuffle"><UiGlyph name="shuffle" size={13} /> Shuffle</Btn>
        <span className="fs-dim" style={{ fontSize: fz(11) }}>{shown.length} photos · wraps at the end</span>
      </div> : null}
      {/* TT80 banner: Glance (the library views) · Keep over one tool strip */}
      <AppBanner label="Photos" status={<>
{items && indexed < items.length ? <Badge tone="info">reading dates {indexed}/{items.length}</Badge> : null}
      </>}>
        <BannerGroup name="Glance">
        <select className="fs-select" style={{ width: "auto" }} aria-label="Sort photos" value={photoSort} onChange={(e) => setPhotoSort(e.target.value as PhotoSort)} data-testid="photos-sort">
          <option value="captured">Capture date</option><option value="name">Name A–Z</option><option value="size">Size</option>
        </select>
        {(["all", "favorites", "edited", "places", "undated"] as View[]).map((v) => (
          <Btn key={v} variant={view === v ? "primary" : "ghost"} aria-pressed={view === v} onClick={() => setView(v)}>
            {v === "all" ? "All photos" : v === "favorites" ? "Favorites" : v === "edited" ? "Edited" : v === "undated" ? "No date" : "Places"} <span className="fs-dim">({counts[v]})</span>
          </Btn>
        ))}
        </BannerGroup>
        <BannerGroup name="Keep">
<Btn variant="ghost" onClick={() => shell.open("files", { path: "/Pictures" })}>Open Pictures folder</Btn>
        </BannerGroup>
      </AppBanner>
      <div className="fs-scroll" style={{ flex: 1, minHeight: 0, padding: 10 }}>
        {error ? <Badge tone="bad">{error}</Badge> : null}
        {items === null ? <div className="fs-dim">Loading library…</div> : null}
        {items && shown.length === 0 ? <Empty title={view === "all" ? "No photos yet" : "Nothing here"} icon="🌅" hint={view === "all" ? "Upload pictures in Files (any folder) — they show up here." : undefined} /> : null}
        {groups.map((g) => (
          <section key={g.label} style={{ marginBottom: 14 }}>
            <h3 style={{ margin: "4px 2px 8px", fontSize: fz(14) }}>{g.label}</h3>
            <div role="list" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${fz(120)}, 1fr))`, gap: 6 }}>
              {g.items.map((it) => {
                const inf = index[it.sha256]; const r = recipes[it.path];
                return (
                  <button key={it.path} role="listitem" className="fs-list-item" data-photo={it.name} onClick={() => setOpen(it.path)}
                    title={`${it.name}${inf?.date ? ` — ${new Date(inf.date).toLocaleString()}${inf.dateSource === "file" ? " (file date)" : ""}` : ""}`}
                    style={{ flexDirection: "column", padding: 4, position: "relative", background: "transparent", border: "none", cursor: "pointer" }}>
                    <Thumb node={it} size="100%" iconSize={40} hasSidecar={sidecars.has(it.path)} fit="cover" radius={8} label={it.name} />
                    <span style={{ position: "absolute", top: 8, right: 10, display: "flex", gap: 3 }}>
                      {r?.favorite ? <Badge tone="warn" title="Favorite"><HeartIcon filled size={11} /></Badge> : null}
                      {r && !isIdentity(r) ? <Badge tone="info" title="Edited (non-destructive)">edited</Badge> : null}
                    </span>
                    {view === "places" && inf?.lat !== undefined ? <span className="fs-dim fs-mono" style={{ fontSize: fz(10.5) }}>{inf.lat.toFixed(4)}, {inf.lon!.toFixed(4)}</span> : null}
                    {r?.rating ? <span aria-label={`${r.rating} stars`} role="img" style={{ display: "inline-flex", gap: 1 }}>{Array.from({ length: r.rating }, (_, i) => <StarIcon key={i} filled size={11} />)}</span> : null}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== editor ======================================= */

type Raster = { width: number; height: number; data: Uint8ClampedArray };
const SLIDERS: { k: keyof PhotoRecipe; label: string; min: number; max: number; step: number }[] = [
  { k: "exposure", label: "Exposure", min: -3, max: 3, step: 0.05 }, { k: "contrast", label: "Contrast", min: -1, max: 1, step: 0.02 },
  { k: "highlights", label: "Highlights", min: -1, max: 1, step: 0.02 }, { k: "shadows", label: "Shadows", min: -1, max: 1, step: 0.02 },
  { k: "saturation", label: "Saturation", min: -1, max: 1, step: 0.02 }, { k: "vibrance", label: "Vibrance", min: -1, max: 1, step: 0.02 },
  { k: "warmth", label: "Warmth", min: -1, max: 1, step: 0.02 }, { k: "tint", label: "Tint", min: -1, max: 1, step: 0.02 },
  { k: "vignette", label: "Vignette", min: 0, max: 1, step: 0.02 }, { k: "straighten", label: "Straighten °", min: -45, max: 45, step: 0.5 },
];
const ASPECTS: { id: string; label: string; r: number | null }[] = [{ id: "free", label: "Original", r: null }, { id: "1", label: "1:1", r: 1 }, { id: "43", label: "4:3", r: 4 / 3 }, { id: "32", label: "3:2", r: 3 / 2 }, { id: "169", label: "16:9", r: 16 / 9 }, { id: "45", label: "4:5", r: 4 / 5 }];

async function decodeUpright(bytes: Uint8Array, mime: string, maxSide: number): Promise<Raster> {
  const bmp0 = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }), { imageOrientation: "from-image" });
  const k = Math.min(1, maxSide / Math.max(bmp0.width, bmp0.height));
  const w = Math.max(1, Math.round(bmp0.width * k)), h = Math.max(1, Math.round(bmp0.height * k));
  if (w * h > 40_000_000) { bmp0.close(); throw new Error("picture is larger than 40 megapixels"); }
  const c = new OffscreenCanvas(w, h); const g = c.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(bmp0, 0, 0, w, h); bmp0.close();
  const id = g.getImageData(0, 0, w, h); return { width: w, height: h, data: id.data };
}
/** any photo we can decode → upright raster: browser codecs, or our TIFF decoder (orientation applied by hand) */
async function decodePhoto(bytes: Uint8Array, meta: FileMeta, maxSide: number): Promise<Raster> {
  if (meta.format !== "tiff") return decodeUpright(bytes, meta.mime, maxSide);
  const [{ decodeTiff }, { inflateZlib }, R] = await Promise.all([import("@/lib/image/tiff"), import("@/lib/meta"), import("@/lib/photos/recipe")]);
  const t = await decodeTiff(bytes, inflateZlib);
  // EXIF/TIFF orientation 1..8 → quarter turns + flips (5 = transpose, 7 = transverse)
  const o = meta.orientation ?? 1; const turns = ({ 3: 2, 5: 1, 6: 1, 7: 3, 8: 3 } as Record<number, number>)[o] ?? 0;
  let r: Raster = R.rotateQuarter(t, turns); r = R.flipRaster(r, o === 2 || o === 5 || o === 7, o === 4);
  const k = Math.min(1, maxSide / Math.max(r.width, r.height)); if (k >= 1) return r;
  const c = rasterToCanvas(r); const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
  const d = new OffscreenCanvas(w, h); const g = d.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(c, 0, 0, w, h);
  return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}
function rasterToCanvas(r: Raster): OffscreenCanvas {
  const c = new OffscreenCanvas(r.width, r.height); c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0); return c;
}

type RecipeStore = "host" | "private" | "ram";
const recipeStore = (path: string): RecipeStore => isPrivatePath(path) ? "private" : privacy.status().amnesic ? "ram" : "host";

function PhotoEditor({ item, info, onClose, onSaved, onExported, showPlaying, onToggleShow, nav }: { item: Item; info?: Info; onClose: () => void; onSaved: (r: PhotoRecipe | null) => void; onExported: () => void; showPlaying?: boolean; onToggleShow?: () => void; nav?: { label: string; prev: string | null; next: string | null; go: (path: string) => void } }) {
  useEffect(() => {
    if (!nav) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (e.key === "ArrowLeft" && nav.prev) nav.go(nav.prev);
      if (e.key === "ArrowRight" && nav.next) nav.go(nav.next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  const shell = useShell();
  const [state, setState] = useState<{ base?: Raster; meta?: FileMeta; error?: string; note?: string; saved: PhotoRecipe | null } | null>(null);
  const [hist, setHist] = useState<{ list: PhotoRecipe[]; at: number }>({ list: [{ v: 1 }], at: 0 });
  const [compare, setCompare] = useState(false);
  const [aspect, setAspect] = useState("free");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0.5, y: 0.5 });
  const [busy, setBusy] = useState<string | null>(null);
  // Synchronous guard: state updates alone do not prevent two clicks in the
  // same render from launching conflicting writes to one recipe.
  const saving = useRef(false);
  // The token is advanced synchronously on confirmed saves, before another
  // click can start; a React render alone is not a concurrency guard.
  const loadedRecipe = useRef<{ store: RecipeStore; expected: RecipeIdentity | null } | null>(null);
  const [exp, setExp] = useState<{ format: "jpeg" | "png" | "webp" | "avif" | "heic" | "gif" | "bmp"; quality: number; size: number; meta: boolean; location: boolean } | null>(null);
  const [caps, setCaps] = useState<Record<string, boolean> | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const recipe = hist.list[hist.at];

  useEffect(() => {
    let live = true;
    (async () => {
      const store = recipeStore(item.path);
      const bytes = await readFileBytes(item.path); if (!bytes) throw new Error("could not read the photo");
      const { readMetadata } = await import("@/lib/meta");
      const meta = await readMetadata(bytes, item.name);
      const loaded = await readRecipeForEditing(item.path, store === "host");
      let base: Raster; let note: string | undefined;
      if (DECODABLE.test(meta.mime) || meta.format === "tiff") base = await decodePhoto(bytes, meta, 1400);
      else if (meta.picture) { base = await decodeUpright(meta.picture.data, meta.picture.mime, 1400); note = `${meta.format.toUpperCase()} cannot be decoded by this browser: editing shows the embedded preview, export is unavailable.`; }
      else throw new Error(`${meta.format.toUpperCase()} cannot be decoded by this browser`);
      if (!live) return;
      if (store !== recipeStore(item.path)) throw new Error("Storage mode changed while opening the photo; reopen it before editing.");
      loadedRecipe.current = { store, expected: loaded.expected };
      const saved = loaded.recipe; setState({ base, meta, note, saved }); if (saved) setHist({ list: [saved], at: 0 });
    })().catch((e: unknown) => { if (live) setState({ error: e instanceof Error ? e.message : String(e), saved: null }); });
    import("@/lib/image/encode").then((m) => m.exportCapabilities()).then((c) => { if (live) setCaps(c); }).catch(() => {});
    return () => { live = false; };
  }, [item.path, item.name]);

  // preview render (≤ 1400 px working copy; the export re-renders from the full-resolution original)
  useEffect(() => {
    const base = state?.base; const c = canvas.current; if (!base || !c) return;
    const id = requestAnimationFrame(() => {
      const out = compare ? base : renderRecipe(base, recipe);
      c.width = out.width; c.height = out.height;
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [state?.base, recipe, compare]);

  const push = (patch: Partial<PhotoRecipe>) => setHist((h) => {
    const next = parseRecipe({ ...h.list[h.at], ...patch }); const list = [...h.list.slice(0, h.at + 1), next].slice(-80);
    return { list, at: list.length - 1 };
  });
  const setCrop = (asp: string, z: number, p: { x: number; y: number }) => {
    setAspect(asp); setZoom(z); setPan(p);
    const base = state?.base; if (!base) return;
    const pre = outputSize(base.width, base.height, { ...recipe, crop: undefined });
    const ar = ASPECTS.find((a) => a.id === asp)?.r ?? pre.width / pre.height;
    let w = 1, h = (pre.width / ar) / pre.height; if (h > 1) { w = 1 / h; h = 1; }
    w /= z; h /= z;
    const crop = w >= 0.9999 && h >= 0.9999 ? undefined : { x: (1 - w) * p.x, y: (1 - h) * p.y, w, h };
    push({ crop });
  };
  const pix = (x: PhotoRecipe | null | undefined) => { const o: Record<string, unknown> = { ...(x ?? { v: 1 }) }; delete o.rating; delete o.favorite; return JSON.stringify(o); };
  const dirty = pix(recipe) !== pix(state?.saved);
  const expectedPhoto = { path: item.path, id: item.id, version: item.version, sha256: item.sha256 };

  const persistRecipe = async (r: PhotoRecipe, reason: string) => {
    const loaded = loadedRecipe.current;
    if (!loaded || loaded.store !== recipeStore(item.path)) throw new Error("Storage mode changed; reopen the photo before saving edits.");
    const precondition = loaded.store === "host" ? { expectedRecipe: loaded.expected } : {};
    const empty = isIdentity(r) && !r.rating && !r.favorite;
    const result = empty
      ? await post<{ id?: unknown; version?: unknown; sha256?: unknown }>("/api/fs", { op: "purge", path: sidecarPath(item.path), expectedPhoto, ...precondition })
      : await post<{ id?: unknown; version?: unknown; sha256?: unknown }>("/api/fs", { op: "write", path: sidecarPath(item.path), content: JSON.stringify(r, null, 1), mime: "application/json", reason, expectedPhoto, ...precondition });
    if (loaded.store !== recipeStore(item.path)) throw new Error("Storage mode changed during the save; its outcome may be unknown. Reopen the photo.");
    if (loaded.store === "host") {
      if (empty) loaded.expected = null;
      else {
        if (!Number.isSafeInteger(result.id) || Number(result.id) <= 0 || !Number.isSafeInteger(result.version) || Number(result.version) <= 0
          || typeof result.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.sha256)) {
          throw new Error("The save may have completed but its new identity was not confirmed; reopen the photo.");
        }
        loaded.expected = { id: Number(result.id), version: Number(result.version), sha256: result.sha256 };
      }
    }
  };

  const saveFlags = async (r: PhotoRecipe, patch: Partial<PhotoRecipe>) => {
    if (saving.current) return;
    saving.current = true; setBusy("Saving rating");
    try {
      await persistRecipe(r, "photo rating");
      setState((s) => s && { ...s, saved: r }); onSaved(isIdentity(r) && !r.rating && !r.favorite ? null : r);
      // Apply only the confirmed flag to the current history, preserving any
      // pixel edits made while the request was in flight.
      push(patch);
    } catch (e) {
      const queued = !!(e as { queued?: boolean }).queued;
      shell.toast(`${queued ? "Rating queued" : "Could not save the rating"}: ${(e as Error).message}`, queued ? "warn" : "bad");
    }
    finally { saving.current = false; setBusy(null); }
  };
  const save = async (r: PhotoRecipe) => {
    if (saving.current) return;
    saving.current = true; setBusy("Saving");
    try {
      await persistRecipe(r, "photo edit");
      if (isIdentity(r) && !r.rating && !r.favorite) {
        onSaved(null); setState((s) => s && { ...s, saved: null });
      } else {
        onSaved(r); setState((s) => s && { ...s, saved: r });
      }
      forgetThumbnail(item, 256, state?.saved ?? null);
      shell.toast(isIdentity(r) ? "Saved (original pixels)" : "Edit saved — the original file is untouched", "ok");
    } catch (e) {
      const queued = !!(e as { queued?: boolean }).queued;
      shell.toast(`${queued ? "Edit queued" : "Save failed"}: ${(e as Error).message}`, queued ? "warn" : "bad");
    }
    finally { saving.current = false; setBusy(null); }
  };
  // Rating/favourite update the last SAVED recipe, leaving unsaved pixel edits alone.
  const setMetaFlag = (patch: Partial<PhotoRecipe>) => { const r = parseRecipe({ ...(state?.saved ?? { v: 1 }), ...patch }); void saveFlags(r, patch); };

  const doExport = async () => {
    if (!exp || !state?.meta) return;
    setBusy("Exporting");
    try {
      const enc = await import("@/lib/image/encode");
      const bytes = await readFileBytes(item.path); if (!bytes) throw new Error("could not read the photo");
      const full = await decodePhoto(bytes, state.meta, exp.size || 1e9);
      const out = renderRecipe(full, recipe);
      const tiff = exp.meta && state.meta.exif ? enc.exportExif(state.meta.exif, { width: out.width, height: out.height, keepLocation: exp.location }) : null;
      const res = await enc.encodeImage(rasterToCanvas(out), { format: exp.format, quality: exp.quality, exif: tiff });
      const stem = item.name.replace(/\.[^.]+$/, ""); const dir = item.path.slice(0, item.path.lastIndexOf("/")) || "";
      const ext = exp.format === "jpeg" ? "jpg" : exp.format;
      let name = `${stem}-edited.${ext}`;
      const taken = async (n: string) => { const r = await fetch(`/api/fs?op=stat&path=${encodeURIComponent(`${dir}/${n}`)}`); if (!r.ok) return false; const j = await r.json().catch(() => null) as { node?: unknown } | null; return !!j?.node; };
      for (let i = 2; i < 1000 && await taken(name); i++) name = `${stem}-edited-${i}.${ext}`;
      await post("/api/fs", { op: "upload", path: `${dir}/${name}`, content: bytesToB64(res.bytes), mime: res.mime });
      shell.toast(`Exported ${name} (${out.width}×${out.height}, ${Math.round(res.bytes.length / 1024)} KB${tiff ? exp.location ? ", metadata + location" : ", metadata without location" : ", no metadata"})${res.note ? ` — ${res.note}` : ""}`, "ok");
      setExp(null); onExported();
    } catch (e) { shell.toast(`Export failed: ${(e as Error).message}`, "bad"); } finally { setBusy(null); }
  };

  const meta = state?.meta;
  const rows = useMemo(() => meta ? describeRows(meta) : [], [meta]);
  if (!state) return <div style={{ padding: 16 }} className="fs-dim">Opening {item.name}…</div>;
  if (state.error) return <div style={{ padding: 16, display: "grid", gap: 8 }}><Badge tone="bad">{state.error}</Badge><Btn onClick={onClose}>Back to library</Btn></div>;
  const r = recipe;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }} data-testid="photos-editor">
      <div className="fs-row" style={{ padding: 8, gap: 6, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={onClose} aria-label="Back to library">‹ Library</Btn>
        {onToggleShow ? <Btn variant={showPlaying ? "primary" : "ghost"} aria-pressed={!!showPlaying} onClick={onToggleShow}>{showPlaying ? "Pause show" : "Play slideshow"}</Btn> : null}
        {nav ? <span className="fs-row" style={{ gap: 4 }}>
          <Btn variant="ghost" disabled={!nav.prev} aria-label="Previous photo" onClick={() => nav.prev && nav.go(nav.prev)}>‹</Btn>
          <span className="fs-dim fs-mono" style={{ fontSize: fz(11) }}>{nav.label}</span>
          <Btn variant="ghost" disabled={!nav.next} aria-label="Next photo" onClick={() => nav.next && nav.go(nav.next)}>›</Btn>
        </span> : null}
        <strong style={{ fontSize: fz(13) }}>{item.name}</strong>
        <div style={{ flex: 1 }} />
        <span role="radiogroup" aria-label="Rating" style={{ display: "flex" }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} role="radio" disabled={!!busy} aria-checked={(r.rating ?? 0) === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} className="fs-btn" data-variant="ghost"
              style={{ minWidth: 28, color: (r.rating ?? 0) >= n ? "var(--fs-warn, #c98a00)" : undefined }} onClick={() => setMetaFlag({ rating: (r.rating ?? 0) === n ? 0 : n })}><StarIcon filled={(r.rating ?? 0) >= n} size={16} /></button>
          ))}
        </span>
        <Btn variant={r.favorite ? "primary" : "ghost"} disabled={!!busy} aria-pressed={!!r.favorite} onClick={() => setMetaFlag({ favorite: !r.favorite })}><HeartIcon filled={!!r.favorite} size={14} /> Favorite</Btn>
        <Btn variant="ghost" disabled={hist.at === 0} onClick={() => setHist((h) => ({ ...h, at: Math.max(0, h.at - 1) }))}>Undo</Btn>
        <Btn variant="ghost" disabled={hist.at >= hist.list.length - 1} onClick={() => setHist((h) => ({ ...h, at: Math.min(h.list.length - 1, h.at + 1) }))}>Redo</Btn>
        <Btn variant="ghost" onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)} title="Hold to see the original">Compare</Btn>
        <Btn variant="ghost" onClick={() => push({ ...Object.fromEntries(Object.keys(r).filter((k) => k !== "v" && k !== "rating" && k !== "favorite").map((k) => [k, undefined])) })}>Reset</Btn>
        <Btn variant="primary" disabled={!dirty || !!busy} onClick={() => void save(r)}>{busy === "Saving" ? "Saving…" : "Save edit"}</Btn>
        <Btn disabled={!!state.note || !!busy} title={state.note} onClick={() => setExp({ format: "jpeg", quality: 0.9, size: 0, meta: true, location: false })}>Export…</Btn>
      </div>
      {state.note ? <div style={{ padding: "4px 10px" }}><Badge tone="warn">{state.note}</Badge></div> : null}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "grid", gridTemplate: "minmax(0, 1fr) / minmax(0, 1fr)", padding: 14, background: "var(--fs-surface-2, rgba(0,0,0,0.04))" }}>
          <canvas ref={canvas} data-testid="photos-canvas" aria-label={`Edited preview of ${item.name}`} style={{ width: "100%", height: "100%", objectFit: "contain", filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.22))" }} />
        </div>
        <aside className="fs-scroll" style={{ width: fz(300), flex: "none", borderLeft: "1px solid var(--fs-border)", padding: 10, minHeight: 0, display: "grid", gap: 10, alignContent: "start" }}>
          <section aria-label="Presets">
            <div className="fs-dim" style={{ fontSize: fz(11), marginBottom: 4 }}>Presets</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <Btn variant={!r.preset ? "primary" : "ghost"} onClick={() => push({ preset: null })}>None</Btn>
              {(Object.keys(PRESETS) as PresetName[]).map((p) => <Btn key={p} variant={r.preset === p ? "primary" : "ghost"} aria-pressed={r.preset === p} onClick={() => push({ preset: p })}>{p[0].toUpperCase() + p.slice(1)}</Btn>)}
            </div>
          </section>
          <section aria-label="Geometry" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            <Btn variant="ghost" onClick={() => push({ rotate: (((r.rotate ?? 0) + 3) % 4) as 0 | 1 | 2 | 3, crop: undefined })}>Rotate left</Btn>
            <Btn variant="ghost" onClick={() => push({ rotate: (((r.rotate ?? 0) + 1) % 4) as 0 | 1 | 2 | 3, crop: undefined })}>Rotate right</Btn>
            <Btn variant={r.flipH ? "primary" : "ghost"} aria-pressed={!!r.flipH} onClick={() => push({ flipH: !r.flipH })}>Flip H</Btn>
            <Btn variant={r.flipV ? "primary" : "ghost"} aria-pressed={!!r.flipV} onClick={() => push({ flipV: !r.flipV })}>Flip V</Btn>
          </section>
          <section aria-label="Crop" style={{ display: "grid", gap: 4 }}>
            <div className="fs-dim" style={{ fontSize: fz(11) }}>Crop</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {ASPECTS.map((a) => <Btn key={a.id} variant={aspect === a.id ? "primary" : "ghost"} aria-pressed={aspect === a.id} onClick={() => setCrop(a.id, zoom, pan)}>{a.label}</Btn>)}
            </div>
            <Slider label="Zoom" min={1} max={4} step={0.05} value={zoom} onChange={(v) => setCrop(aspect, v, pan)} />
            <Slider label="Pan X" min={0} max={1} step={0.01} value={pan.x} onChange={(v) => setCrop(aspect, zoom, { ...pan, x: v })} />
            <Slider label="Pan Y" min={0} max={1} step={0.01} value={pan.y} onChange={(v) => setCrop(aspect, zoom, { ...pan, y: v })} />
          </section>
          <section aria-label="Adjustments" style={{ display: "grid", gap: 4 }}>
            {SLIDERS.map((s) => <Slider key={s.k} label={s.label} min={s.min} max={s.max} step={s.step} value={(r[s.k] as number | undefined) ?? 0} onChange={(v) => push({ [s.k]: v })} />)}
          </section>
          <section aria-label="Metadata" data-testid="photos-meta">
            <div className="fs-dim" style={{ fontSize: fz(11), marginBottom: 4 }}>Information{info?.dateSource === "file" ? " (no capture date in the file)" : ""}</div>
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 8px", margin: 0, fontSize: fz(11.5) }}>
              {rows.map(([k, v], i) => <div key={`${k}-${i}`} style={{ display: "contents" }}><dt className="fs-dim">{k}</dt><dd style={{ margin: 0, wordBreak: "break-word" }}>{v}</dd></div>)}
            </dl>
          </section>
        </aside>
      </div>
      {exp ? (
        <div role="dialog" aria-modal="true" aria-label="Export photo" className="fs-panel" data-testid="photos-export"
          style={{ position: "absolute", right: 16, top: 56, zIndex: 20, padding: 12, width: fz(300), display: "grid", gap: 8 }}>
          <strong>Export a copy</strong>
          <label className="fs-row" style={{ gap: 6 }}>Format
            <select className="fs-input" value={exp.format} onChange={(e) => setExp({ ...exp, format: e.target.value as typeof exp.format })}>
              {(["jpeg", "png", "webp", "avif", "heic", "gif", "bmp"] as const).map((f) => <option key={f} value={f} disabled={caps ? !caps[f] : f === "heic"}>{f.toUpperCase()}{caps && !caps[f] ? " — not available in this browser" : ""}</option>)}
            </select>
          </label>
          {exp.format !== "png" && exp.format !== "gif" && exp.format !== "bmp" ? <Slider label="Quality" min={0.3} max={1} step={0.01} value={exp.quality} onChange={(v) => setExp({ ...exp, quality: v })} /> : null}
          <label className="fs-row" style={{ gap: 6 }}>Size
            <select className="fs-input" value={exp.size} onChange={(e) => setExp({ ...exp, size: Number(e.target.value) })}>
              <option value={0}>Full resolution</option><option value={3840}>3840 px long side</option><option value={2048}>2048 px</option><option value={1080}>1080 px</option>
            </select>
          </label>
          <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={exp.meta} onChange={(e) => setExp({ ...exp, meta: e.target.checked, location: e.target.checked && exp.location })} /> Include camera metadata</label>
          <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={exp.location} disabled={!exp.meta || !meta?.gps} onChange={(e) => setExp({ ...exp, location: e.target.checked })} /> Include location{meta?.gps ? "" : " (none in this photo)"}</label>
          <div className="fs-row" style={{ gap: 6, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setExp(null)}>Cancel</Btn>
            <Btn variant="primary" disabled={!!busy || (caps ? !caps[exp.format] : false)} onClick={() => void doExport()}>{busy === "Exporting" ? "Exporting…" : "Export"}</Btn>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function describeRows(m: FileMeta): [string, string][] {
  // photo-centric subset of lib/meta describe(): what a photographer looks for first
  const r: [string, string][] = [];
  if (m.displayWidth && m.displayHeight) r.push(["Size", `${m.displayWidth} × ${m.displayHeight}`]);
  r.push(["Format", m.format.toUpperCase()]);
  const t = m.tags;
  if (t.dateTaken) r.push(["Taken", new Date(t.dateTaken).toLocaleString()]);
  const cam = [t.make, t.model].filter(Boolean).join(" "); if (cam) r.push(["Camera", cam]);
  if (t.lens) r.push(["Lens", t.lens]);
  const expo = [t.exposure && `${t.exposure} s`, t.fNumber && `f/${t.fNumber}`, t.iso && `ISO ${t.iso}`, t.focalLength && `${t.focalLength} mm`].filter(Boolean).join(" · ");
  if (expo) r.push(["Exposure", expo]);
  if (m.gps) r.push(["Location", `${m.gps.lat.toFixed(5)}, ${m.gps.lon.toFixed(5)}${m.gps.alt !== undefined ? ` · ${Math.round(m.gps.alt)} m` : ""}`]);
  if (m.orientation && m.orientation !== 1) r.push(["Orientation", `EXIF ${m.orientation} (applied)`]);
  return r;
}

function Slider({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: `${fz(86)} 1fr ${fz(40)}`, alignItems: "center", gap: 6, fontSize: fz(11.5) }}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="fs-mono fs-dim" style={{ textAlign: "right" }}>{Math.abs(value) < 1e-9 ? "0" : value.toFixed(step < 0.1 ? 2 : 1)}</span>
    </label>
  );
}

/* glyphs as SVG: Unicode ★ / ♥ render as tofu in the shell font stack */
function StarIcon({ filled, size = 14 }: { filled?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block" }}>
      <path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"
        fill={filled ? "#f5b21b" : "none"} stroke={filled ? "#d48f00" : "currentColor"} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
function HeartIcon({ filled, size = 14 }: { filled?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-2px" }}>
      <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"
        fill={filled ? "#ff5a7a" : "none"} stroke={filled ? "#e0405f" : "currentColor"} strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}
