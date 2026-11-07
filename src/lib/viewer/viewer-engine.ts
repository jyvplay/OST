/**
 * TT139 (PR-08) — PDF / image viewer state machine.
 *
 * Pure view state: page, zoom, rotation, pan, fit modes. No canvas, no pdf.js
 * call here; the caller renders and this module owns what the renderer is asked
 * for. Keeping it separate is what makes "zoom in, pan, rotate, go to page 7,
 * rotate back — is the point under the cursor still under the cursor?"
 * testable without a browser.
 *
 * The maths that is easy to get wrong and is therefore pinned here:
 *   • Zoom must be about a point, not about the origin. Zooming about (0,0)
 *     makes the thing you are looking at slide off screen; zooming about the
 *     cursor keeps it put, which is what `zoomAt` does.
 *   • Rotation swaps the effective width/height at 90° and 270°. A fit-to-page
 *     computed before rotating is wrong after, so `fitToPage` accounts for it.
 *   • Pan is clamped so the document cannot be dragged entirely off screen —
 *     an irreversible blank viewport is the classic viewer dead end.
 */

export type ViewerKind = "pdf" | "image" | "svg";

export interface ViewerViewport {
  width: number;
  height: number;
}

export interface ViewerState {
  kind: ViewerKind;
  page: number;
  pageCount: number;
  /** 1 = 100%. */
  zoom: number;
  /** Degrees clockwise: 0, 90, 180, 270. */
  rotation: 0 | 90 | 180 | 270;
  panX: number;
  panY: number;
  viewport: ViewerViewport;
  /** Intrinsic size of the current page in CSS pixels at zoom 1. */
  pageSize: ViewerViewport;
  fit: "none" | "width" | "page";
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;

export function createViewer(kind: ViewerKind, viewport: ViewerViewport, pageCount = 1): ViewerState {
  if (!(viewport.width > 0) || !(viewport.height > 0)) throw new Error("Viewport must be positive");
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("pageCount must be a positive integer");
  return {
    kind,
    page: 1,
    pageCount,
    zoom: 1,
    rotation: 0,
    panX: 0,
    panY: 0,
    viewport: { ...viewport },
    pageSize: { width: viewport.width, height: viewport.height },
    fit: "none",
    status: "idle",
  };
}

export function setPageContent(
  v: ViewerState,
  opts: { pageSize?: ViewerViewport; pageCount?: number; status?: ViewerState["status"]; error?: string },
): ViewerState {
  let next: ViewerState = { ...v };
  if (opts.pageCount !== undefined) {
    if (!Number.isInteger(opts.pageCount) || opts.pageCount < 1) throw new Error("pageCount must be positive");
    next.pageCount = opts.pageCount;
    next.page = Math.min(next.page, opts.pageCount);
  }
  if (opts.pageSize) {
    if (!(opts.pageSize.width > 0) || !(opts.pageSize.height > 0)) throw new Error("pageSize must be positive");
    next.pageSize = { ...opts.pageSize };
  }
  if (opts.status) next.status = opts.status;
  if (opts.status === "error") next.error = opts.error ?? "Unknown error";
  else if (opts.status) next.error = undefined;
  // Re-apply the fit if one is active, because the page just changed size.
  if (next.fit !== "none") next = next.fit === "width" ? fitToWidth(next) : fitToPage(next);
  return next;
}

export function setViewport(v: ViewerState, viewport: ViewerViewport): ViewerState {
  if (!(viewport.width > 0) || !(viewport.height > 0)) throw new Error("Viewport must be positive");
  const next = { ...v, viewport: { ...viewport } };
  const refit = next.fit === "none" ? next : next.fit === "width" ? fitToWidth(next) : fitToPage(next);
  return clampPan(refit);
}

export function goToPage(v: ViewerState, page: number): ViewerState {
  if (!Number.isInteger(page)) throw new Error("page must be an integer");
  if (page < 1 || page > v.pageCount) throw new Error(`Page ${page} out of range 1..${v.pageCount}`);
  return { ...v, page, panX: 0, panY: 0 };
}

export function nextPage(v: ViewerState): ViewerState {
  return v.page >= v.pageCount ? v : goToPage(v, v.page + 1);
}

export function prevPage(v: ViewerState): ViewerState {
  return v.page <= 1 ? v : goToPage(v, v.page - 1);
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) throw new Error("zoom must be finite");
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * Zoom keeping the document point under (anchorX, anchorY) fixed on screen.
 * Anchor coordinates are relative to the viewport centre, so (0,0) zooms about
 * the middle of the screen.
 */
export function zoomAt(v: ViewerState, newZoom: number, anchorX = 0, anchorY = 0): ViewerState {
  const z = clampZoom(newZoom);
  if (z === v.zoom) return v;
  const factor = z / v.zoom;
  return clampPan({
    ...v,
    zoom: z,
    fit: "none",
    panX: anchorX - (anchorX - v.panX) * factor,
    panY: anchorY - (anchorY - v.panY) * factor,
  });
}

export function zoomIn(v: ViewerState, step = 1.25): ViewerState {
  if (!(step > 1)) throw new Error("zoom step must be > 1");
  return zoomAt(v, v.zoom * step);
}

export function zoomOut(v: ViewerState, step = 1.25): ViewerState {
  if (!(step > 1)) throw new Error("zoom step must be > 1");
  return zoomAt(v, v.zoom / step);
}

export function setZoom(v: ViewerState, zoom: number): ViewerState {
  return zoomAt(v, zoom);
}

/** Rotate clockwise. Resets pan so the document re-centres rather than jumping. */
export function rotate(v: ViewerState, degrees: number): ViewerState {
  if (degrees % 90 !== 0) throw new Error("rotation must be a multiple of 90");
  const next = (((v.rotation + degrees) % 360) + 360) % 360;
  const base = { ...v, rotation: next as ViewerState["rotation"], panX: 0, panY: 0 };
  return base.fit === "none" ? base : base.fit === "width" ? fitToWidth(base) : fitToPage(base);
}

/** Effective size after rotation — 90° and 270° swap the axes. */
export function effectivePageSize(v: ViewerState): ViewerViewport {
  const swapped = v.rotation === 90 || v.rotation === 270;
  return swapped
    ? { width: v.pageSize.height, height: v.pageSize.width }
    : { width: v.pageSize.width, height: v.pageSize.height };
}

export function fitToWidth(v: ViewerState): ViewerState {
  const eff = effectivePageSize(v);
  const zoom = clampZoom(v.viewport.width / eff.width);
  return { ...v, zoom, fit: "width", panX: 0, panY: 0 };
}

export function fitToPage(v: ViewerState): ViewerState {
  const eff = effectivePageSize(v);
  const zoom = clampZoom(Math.min(v.viewport.width / eff.width, v.viewport.height / eff.height));
  return { ...v, zoom, fit: "page", panX: 0, panY: 0 };
}

export function actualSize(v: ViewerState): ViewerState {
  return { ...v, zoom: 1, fit: "none", panX: 0, panY: 0 };
}

/**
 * Keep at least a quarter of the document on screen in each axis. Without this,
 * a single fast drag can put the content entirely outside the viewport and the
 * user has no cue that anything is there.
 */
function clampPan(v: ViewerState): ViewerState {
  const eff = effectivePageSize(v);
  const contentW = eff.width * v.zoom;
  const contentH = eff.height * v.zoom;
  const maxX = Math.max(0, (contentW - v.viewport.width) / 2 + v.viewport.width / 4);
  const maxY = Math.max(0, (contentH - v.viewport.height) / 2 + v.viewport.height / 4);
  return {
    ...v,
    panX: Math.min(maxX, Math.max(-maxX, v.panX)),
    panY: Math.min(maxY, Math.max(-maxY, v.panY)),
  };
}

export function pan(v: ViewerState, dx: number, dy: number): ViewerState {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error("pan deltas must be finite");
  return clampPan({ ...v, panX: v.panX + dx, panY: v.panY + dy });
}

/** The rectangle to draw, in viewport coordinates (top-left origin). */
export function contentRect(v: ViewerState): { x: number; y: number; width: number; height: number } {
  const eff = effectivePageSize(v);
  const width = eff.width * v.zoom;
  const height = eff.height * v.zoom;
  return {
    x: (v.viewport.width - width) / 2 + v.panX,
    y: (v.viewport.height - height) / 2 + v.panY,
    width,
    height,
  };
}

/** Inverse of the draw transform: which document pixel is under a viewport point. */
export function documentPointAt(v: ViewerState, screenX: number, screenY: number): { x: number; y: number } {
  const rect = contentRect(v);
  return { x: (screenX - rect.x) / v.zoom, y: (screenY - rect.y) / v.zoom };
}

export function viewerSummary(v: ViewerState): string {
  const fitLabel = v.fit === "none" ? "" : ` · fit ${v.fit}`;
  const err = v.status === "error" ? ` · ${v.error}` : "";
  return `${v.kind} page ${v.page}/${v.pageCount} · ${Math.round(v.zoom * 100)}% · ${v.rotation}°${fitLabel} · ${v.status}${err}`;
}

export function canZoomIn(v: ViewerState): boolean {
  return v.zoom < MAX_ZOOM - 1e-9;
}

export function canZoomOut(v: ViewerState): boolean {
  return v.zoom > MIN_ZOOM + 1e-9;
}
