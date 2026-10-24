/**
 * TT54 (FF-13) — thumbnail service (browser).
 *
 *  key        sha256 of the file bytes (from the VFS row) + size + recipeKey(sidecar) → edits re-key, renames do not
 *  memory     LRU of blob: URLs (400 entries; evicted URLs are revoked)
 *  disk       WebP files in /System/Cache/thumbs/<key>.webp — written ONCE (content-addressed, so the VFS never
 *             accumulates versions); budget 48 MiB, eviction of the oldest-written entries when over budget
 *             (FIFO-by-write, not true LRU: a read does not touch the file — disclosed)
 *  render     one module Worker (OffscreenCanvas); video / SVG frames on the main thread; when Workers or
 *             OffscreenCanvas are missing everything renders on the main thread
 *  limits     files > 96 MiB are not thumbnailed; queue concurrency 2; every job has a 12 s timeout
 *  privacy    nothing leaves the machine: bytes come from /api/fs, thumbnails go back to /api/fs
 */
import { parseRecipe, recipeKey, sidecarPath, type PhotoRecipe } from "../photos/recipe";
/** bump whenever render.ts output changes for the same input */
export const RENDERER = "r2";
import type { FileMeta } from "../meta";

export const THUMB_DIR = "/System/Cache/thumbs";
export const THUMB_BUDGET = 48 << 20;
export const THUMB_MAX_SOURCE = 96 << 20;
const MEM_CAP = 400;

export interface ThumbNode { path: string; name: string; size: number; sha256?: string | null; mime?: string | null }
export interface ThumbInfo { url: string | null; reason?: string; source?: string; meta?: FileMeta; cached?: "memory" | "disk" | "fresh" }

const mem = new Map<string, Promise<ThumbInfo>>();
const stats = { memory: 0, disk: 0, fresh: 0, failed: 0 };
export const thumbStats = () => ({ ...stats, entries: mem.size });

function remember(key: string, p: Promise<ThumbInfo>) {
  mem.delete(key); mem.set(key, p);
  while (mem.size > MEM_CAP) {
    const [k, old] = mem.entries().next().value as [string, Promise<ThumbInfo>];
    mem.delete(k); old.then((t) => { if (t.url) URL.revokeObjectURL(t.url); }).catch(() => {});
  }
}

const b64ToBytes = (s: string) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const bytesToB64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

export async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const r = await fetch(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
  if (!r.ok) return null;
  const j = await r.json() as { node?: { content: string; encoding: string } };
  if (!j.node) return null;
  return j.node.encoding === "base64" ? b64ToBytes(j.node.content) : new TextEncoder().encode(j.node.content);
}
export async function readRecipe(photoPath: string): Promise<PhotoRecipe | null> {
  const r = await fetch(`/api/fs?op=read&path=${encodeURIComponent(sidecarPath(photoPath))}`);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null) as { node?: { content: string } } | null;
  if (!j?.node) return null;
  try { return parseRecipe(JSON.parse(j.node.content)); } catch { return null; }
}

// ---- worker plumbing -------------------------------------------------------------------------------------------
type WorkerReply = { id: number; blob?: Blob; source?: string; needsMain?: "video" | "svg"; none?: string; error?: string; meta?: FileMeta };
let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, (r: WorkerReply) => void>();
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") { worker = null; return worker; }
    worker = new Worker(new URL("./thumb.worker.ts", import.meta.url), { type: "module", name: "fusion-thumbs" });
    worker.onmessage = (e: MessageEvent<WorkerReply>) => { const f = waiting.get(e.data.id); waiting.delete(e.data.id); f?.(e.data); };
    worker.onerror = () => { for (const f of waiting.values()) f({ id: -1, error: "thumbnail worker crashed" }); waiting.clear(); worker?.terminate(); worker = null; };
  } catch { worker = null; }
  return worker;
}
async function renderAnywhere(bytes: Uint8Array, name: string, max: number, recipe: PhotoRecipe | null): Promise<WorkerReply> {
  const w = getWorker();
  if (w) {
    const id = ++seq;
    return new Promise<WorkerReply>((res) => { waiting.set(id, res); w.postMessage({ id, bytes, name, max, recipe }); });
  }
  const { renderThumbnail, canvasToWebp } = await import("./render");
  const r = await renderThumbnail(bytes, name, max, recipe);
  if ("canvas" in r) return { id: 0, blob: await canvasToWebp(r.canvas), source: r.source, meta: r.meta };
  if ("needsMain" in r) return { id: 0, needsMain: r.needsMain, meta: r.meta };
  return { id: 0, none: r.none, meta: r.meta };
}

// ---- queue -----------------------------------------------------------------------------------------------------
let running = 0; const queue: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((res) => queue.push(res));
  running++;
  try { return await f(); } finally { running--; queue.shift()?.(); }
}
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("thumbnail timed out")), ms))]);

// ---- disk cache ------------------------------------------------------------------------------------------------
let writesSinceSweep = 0, sweptThisSession = false;
async function diskGet(key: string): Promise<string | null> {
  const r = await fetch(`/api/fs?op=read&path=${encodeURIComponent(`${THUMB_DIR}/${key}.webp`)}`);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null) as { node?: { content: string; encoding: string } } | null;
  if (!j?.node || j.node.encoding !== "base64") return null;
  return URL.createObjectURL(new Blob([b64ToBytes(j.node.content).buffer as ArrayBuffer], { type: "image/webp" }));
}
async function diskPut(key: string, blob: Blob) {
  const content = bytesToB64(new Uint8Array(await blob.arrayBuffer()));
  await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: `${THUMB_DIR}/${key}.webp`, content, encoding: "base64", mime: blob.type || "image/webp", reason: "thumbnail cache" }) });
  if (++writesSinceSweep >= 25) { writesSinceSweep = 0; void sweepThumbCache(); }
}
/** keep /System/Cache/thumbs under THUMB_BUDGET: entries of another renderer version are always purged (they can never be
 *  hit again); then the oldest-written entries go first (FIFO by write time — reads do not refresh an entry) */
export async function sweepThumbCache(budget = THUMB_BUDGET): Promise<{ before: number; after: number; removed: number }> {
  const r = await fetch(`/api/fs?op=list&path=${encodeURIComponent(THUMB_DIR)}`);
  if (!r.ok) return { before: 0, after: 0, removed: 0 };
  const j = await r.json() as { nodes?: { path: string; size: number; updatedAt: string; kind: string }[] };
  const stale = (p: string) => !p.endsWith(`-${RENDERER}.webp`);
  const items = (j.nodes ?? []).filter((i) => i.kind === "file").sort((a, b) => Number(stale(b.path)) - Number(stale(a.path)) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const before = items.reduce((s, i) => s + i.size, 0); let total = before; let removed = 0;
  for (const it of items) {
    if (total <= budget && !stale(it.path)) break;
    await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path: it.path }) });
    total -= it.size; removed++;
  }
  return { before, after: total, removed };
}
export async function clearThumbCache() {
  for (const p of mem.values()) p.then((t) => { if (t.url) URL.revokeObjectURL(t.url); }).catch(() => {});
  mem.clear();
  return sweepThumbCache(0);
}

// ---- public ----------------------------------------------------------------------------------------------------
export function thumbKey(node: ThumbNode, max: number, recipe: PhotoRecipe | null): string {
  const id = node.sha256 && /^[0-9a-f]{16,}$/i.test(node.sha256) ? node.sha256.slice(0, 32) : `p${hashStr(node.path)}`;
  // RENDERER is part of the key: a renderer change (e.g. SVGs on white paper) must not be hidden by bytes cached by an older one
  return `${id}-${node.size}-${max}-${recipeKey(recipe)}-${RENDERER}`;
}
function hashStr(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }

/**
 * `recipe`: undefined → look for the sidecar when `hasSidecar` says it exists; null → render the original.
 */
export function getThumbnail(node: ThumbNode, opts: { max?: number; recipe?: PhotoRecipe | null; hasSidecar?: boolean } = {}): Promise<ThumbInfo> {
  // once per session, on first use: purge entries of another renderer version (they can never be hit again) and trim to budget
  if (!sweptThisSession && typeof window !== "undefined") { sweptThisSession = true; void sweepThumbCache().catch(() => {}); }
  const max = opts.max ?? 256;
  if (node.size > THUMB_MAX_SOURCE) return Promise.resolve({ url: null, reason: "file too large to thumbnail" });
  const start = async (): Promise<ThumbInfo> => {
    const recipe = opts.recipe !== undefined ? opts.recipe : opts.hasSidecar ? await readRecipe(node.path) : null;
    const key = thumbKey(node, max, recipe);
    const hit = mem.get(key);
    if (hit) { stats.memory++; remember(key, hit); return hit; }
    const p = slot(async (): Promise<ThumbInfo> => {
      const cached = await diskGet(key).catch(() => null);
      if (cached) { stats.disk++; return { url: cached, cached: "disk" }; }
      const bytes = await readFileBytes(node.path);
      if (!bytes) return { url: null, reason: "file could not be read" };
      const rep = await withTimeout(renderAnywhere(bytes, node.name, max, recipe), 12000);
      let blob = rep.blob;
      if (rep.needsMain) {
        const R = await import("./render");
        const c = rep.needsMain === "video" ? await R.renderVideoThumb(bytes, node.mime ?? rep.meta?.mime ?? "video/mp4", max) : await R.renderSvgThumb(bytes, max, rep.meta);
        blob = await R.canvasToWebp(c);
      }
      if (!blob) return { url: null, reason: rep.none ?? rep.error ?? "no preview", meta: rep.meta };
      stats.fresh++;
      void diskPut(key, blob).catch(() => {});
      return { url: URL.createObjectURL(blob), source: rep.source ?? rep.needsMain, meta: rep.meta, cached: "fresh" };
    }).catch((e: unknown): ThumbInfo => { stats.failed++; mem.delete(key); return { url: null, reason: e instanceof Error ? e.message : String(e) }; });
    remember(key, p);
    return p;
  };
  return start();
}

/** for tests / the Photos module: forget the in-memory copy of one node so the next call re-reads */
export function forgetThumbnail(node: ThumbNode, max: number, recipe: PhotoRecipe | null) {
  const k = thumbKey(node, max, recipe); const p = mem.get(k); mem.delete(k);
  p?.then((t) => { if (t.url) URL.revokeObjectURL(t.url); }).catch(() => {});
}
export { bytesToB64, b64ToBytes };
