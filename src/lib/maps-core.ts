/**
 * TT27 Maps core — pure, hook-free (unit-tested by scripts/maps-unit.mts). Original code.
 *
 * The Maps module draws an offline world (Natural Earth admin-0 countries via world-atlas, public domain / ISC) with
 * Leaflet (BSD-2-Clause). Street tiles from tile.openstreetmap.org are opt-in (they reveal your IP and the area you
 * view to the OSM Foundation, whose tile policy also asks heavy users to arrange access) — a custom tile URL can be set.
 */

export type LatLng = [number, number]; // [lat, lng]

export interface Place { id: string; name: string; lat: number; lng: number; note: string; color: string; added: string }
export interface Places { v: 1; places: Place[] }
export const PLACES_MAX = 2000;
export const PLACE_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0a84ff", "#8e4ec6", "#d6409f", "#5b5bd6"] as const;
export const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius

const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
/** Wrap a longitude into [-180, 180). */
export const wrapLng = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
export const validLatLng = (lat: unknown, lng: unknown): boolean =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Great-circle distance (haversine) in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const pathLength = (pts: LatLng[]): number => pts.reduce((s, p, i) => (i ? s + haversine(pts[i - 1], p) : 0), 0);

/** Initial bearing a → b in degrees (0 = north, clockwise). */
export function bearing(a: LatLng, b: LatLng): number {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

export function formatDistance(m: number, units: "metric" | "imperial" = "metric"): string {
  if (units === "imperial") {
    const ft = m * 3.28084;
    return ft < 1000 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(m < 160934 ? 2 : 0)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 100000 ? 2 : 0)} km`;
}

/** 35.7796, -78.6382 → "35.7796° N, 78.6382° W" (dd) or "35°46′46.6″ N, 78°38′17.5″ W" (dms). */
export function formatLatLng(lat: number, lng: number, mode: "dd" | "dms" = "dd"): string {
  const one = (v: number, pos: string, neg: string) => {
    const h = v >= 0 ? pos : neg, a = Math.abs(v);
    if (mode === "dd") return `${a.toFixed(4)}° ${h}`;
    let d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 600) / 10;
    if (s >= 60) { s = 0; m += 1; } if (m >= 60) { m = 0; d += 1; }
    return `${d}°${m}′${s.toFixed(1)}″ ${h}`;
  };
  return `${one(lat, "N", "S")}, ${one(lng, "E", "W")}`;
}

/**
 * Parse what people paste: "35.78, -78.64", "35.78 -78.64", "35°46'46\"N 78°38'17\"W", "35.78N 78.64W",
 * geo:35.78,-78.64 URIs (RFC 5870), OpenStreetMap links (#map=z/lat/lng or ?mlat=&mlon=) and
 * Google Maps links (@lat,lng,zoomz). Returns null when nothing matches.
 */
export function parseLatLng(raw: string): { lat: number; lng: number; zoom?: number } | null {
  const s = raw.trim();
  if (!s) return null;
  const fin = (lat: number, lng: number, zoom?: number) => (validLatLng(lat, lng) ? { lat, lng, ...(zoom !== undefined && Number.isFinite(zoom) ? { zoom: Math.max(0, Math.min(19, Math.round(zoom))) } : {}) } : null);
  let m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(s);
  if (m) return fin(+m[1], +m[2]);
  m = /#map=(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(s);
  if (m) return fin(+m[2], +m[3], +m[1]);
  m = /[?&]mlat=(-?\d+(?:\.\d+)?).*?[?&]mlon=(-?\d+(?:\.\d+)?)/.exec(s);
  if (m) return fin(+m[1], +m[2]);
  m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/.exec(s);
  if (m) return fin(+m[1], +m[2], m[3] ? +m[3] : undefined);
  // DMS / hemisphere-suffixed
  const part = String.raw`(\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′m]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|''|s)\s*)?\s*([NSEW])`;
  m = new RegExp(`^${part}[\\s,;]+${part}$`, "i").exec(s);
  if (m) {
    const val = (d: string, mi?: string, se?: string) => +d + (mi ? +mi / 60 : 0) + (se ? +se / 3600 : 0);
    let a = val(m[1], m[2], m[3]) * (/[SW]/i.test(m[4]) ? -1 : 1);
    let b = val(m[5], m[6], m[7]) * (/[SW]/i.test(m[8]) ? -1 : 1);
    if (/[EW]/i.test(m[4]) && /[NS]/i.test(m[8])) [a, b] = [b, a];
    else if (/[EW]/i.test(m[4]) === /[EW]/i.test(m[8])) return null; // both latitudes or both longitudes
    return fin(a, b);
  }
  m = /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (m) return fin(+m[1], +m[2]);
  return null;
}

/* ---------------------------------------------------------------- geometry */

/** Ray-casting point-in-ring (ring as [lng, lat] pairs, GeoJSON order). */
export function inRing(pt: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
type Geom = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] } | { type: string; coordinates?: unknown };
/** Point in a GeoJSON Polygon / MultiPolygon (outer ring minus holes). `pt` is [lng, lat]. */
export function inGeometry(pt: [number, number], g: Geom | null | undefined): boolean {
  if (!g) return false;
  const poly = (rings: number[][][]) => rings.length > 0 && inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h));
  if (g.type === "Polygon") return poly(g.coordinates as number[][][]);
  if (g.type === "MultiPolygon") return (g.coordinates as number[][][][]).some(poly);
  return false;
}
export interface Feature { type: "Feature"; id?: string | number; properties: Record<string, unknown> | null; geometry: Geom | null }
/** First feature containing the point, or null (used for "which country is this?"). */
export function featureAt(features: Feature[], lat: number, lng: number): Feature | null {
  for (const f of features) if (inGeometry([lng, lat], f.geometry)) return f;
  return null;
}
/**
 * Rings that cross the antimeridian (Russia's Chukotka, Fiji, …) jump from +180 to −180 between neighbouring points;
 * drawn as-is a renderer strokes a line across the whole world. Unwrap each ring so consecutive longitudes never
 * differ by more than 180° (the ring may then extend past ±180, which Web-Mercator renderers draw correctly).
 */
export function unwrapRing(ring: number[][]): number[][] {
  const out: number[][] = [];
  let shift = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i];
    if (i) { const prev = ring[i - 1][0]; const d = x - prev; if (d > 180) shift -= 360; else if (d < -180) shift += 360; }
    out.push([x + shift, y]);
  }
  return out;
}
export function unwrapGeometry<G extends Geom | null>(g: G): G {
  if (!g) return g;
  if (g.type === "Polygon") return { ...g, coordinates: (g.coordinates as number[][][]).map(unwrapRing) } as G;
  if (g.type === "MultiPolygon") return { ...g, coordinates: (g.coordinates as number[][][][]).map((p) => p.map(unwrapRing)) } as G;
  return g;
}

/** [[south, west], [north, east]] of a geometry (antimeridian-naive). */
export function bbox(g: Geom | null | undefined): [LatLng, LatLng] | null {
  if (!g || !("coordinates" in g)) return null;
  let s = 90, w = 180, n = -90, e = -180, any = false;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") { const [x, y] = c as number[]; any = true; s = Math.min(s, y); n = Math.max(n, y); w = Math.min(w, x); e = Math.max(e, x); }
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(g.coordinates);
  return any ? [[s, w], [n, e]] : null;
}
/**
 * Bounds of the largest polygon (by planar bbox area) — "fly to France" should frame metropolitan France, not the
 * Atlantic between it and French Guiana. Falls back to bbox() for single polygons.
 */
export function mainBbox(g: Geom | null | undefined): [LatLng, LatLng] | null {
  if (!g || g.type !== "MultiPolygon") return bbox(g);
  let best: [LatLng, LatLng] | null = null, area = -1;
  for (const poly of g.coordinates as number[][][][]) {
    const b = bbox({ type: "Polygon", coordinates: poly });
    if (!b) continue;
    const a = (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]);
    if (a > area) { area = a; best = b; }
  }
  return best;
}
/** Case- and accent-insensitive name search; exact > prefix > substring. */
export function searchFeatures(features: Feature[], q: string, limit = 8): Feature[] {
  const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const n = fold(q.trim());
  if (!n) return [];
  const scored: [number, Feature][] = [];
  for (const f of features) {
    const name = fold(String(f.properties?.name ?? ""));
    if (!name) continue;
    const sc = name === n ? 0 : name.startsWith(n) ? 1 : name.includes(n) ? 2 : -1;
    if (sc >= 0) scored.push([sc, f]);
  }
  return scored.sort((a, b) => a[0] - b[0] || String(a[1].properties?.name).localeCompare(String(b[1].properties?.name))).slice(0, limit).map((x) => x[1]);
}

/* ------------------------------------------------------------------ places */

export const emptyPlaces = (): Places => ({ v: 1, places: [] });

/** Accepts our GeoJSON FeatureCollection (or the bare {places} shape); keeps valid Points only. */
export function normalizePlaces(raw: unknown): Places {
  const out: Place[] = [];
  const push = (name: unknown, lat: unknown, lng: unknown, note: unknown, color: unknown, id: unknown, added: unknown) => {
    if (!validLatLng(lat, lng) || out.length >= PLACES_MAX) return;
    out.push({
      id: typeof id === "string" && id ? id.slice(0, 40) : typeof id === "number" ? String(id) : `p${out.length}`,
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : `Place ${out.length + 1}`,
      lat: lat as number, lng: lng as number,
      note: typeof note === "string" ? note.slice(0, 2000) : "",
      color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : PLACE_COLORS[out.length % PLACE_COLORS.length],
      added: typeof added === "string" ? added : new Date(0).toISOString(),
    });
  };
  const r = raw as { type?: string; features?: unknown[]; places?: unknown[] } | null;
  if (r && r.type === "FeatureCollection" && Array.isArray(r.features)) {
    for (const f of r.features as Feature[]) {
      if (f?.geometry?.type !== "Point") continue;
      const c = (f.geometry as { coordinates?: unknown }).coordinates as number[] | undefined;
      if (!Array.isArray(c)) continue;
      const p = f.properties ?? {};
      push(p.name ?? p.title, c[1], c[0], p.note ?? p.description, p["marker-color"] ?? p.color, f.id ?? p.id, p.added);
    }
  } else if (r && Array.isArray(r.places)) {
    for (const p of r.places as Place[]) push(p?.name, p?.lat, p?.lng, p?.note, p?.color, p?.id, p?.added);
  }
  return { v: 1, places: out };
}

/** GeoJSON (RFC 7946) FeatureCollection; `marker-color` follows the simplestyle convention so other tools colour pins. */
export function placesToGeoJSON(p: Places): string {
  return JSON.stringify({
    type: "FeatureCollection",
    features: p.places.map((x) => ({
      type: "Feature", id: x.id,
      properties: { name: x.name, note: x.note, "marker-color": x.color, added: x.added },
      geometry: { type: "Point", coordinates: [Math.round(x.lng * 1e7) / 1e7, Math.round(x.lat * 1e7) / 1e7] },
    })),
  }, null, 1);
}

export function addPlace(p: Places, place: Omit<Place, "color"> & { color?: string }): Places {
  if (!validLatLng(place.lat, place.lng) || p.places.length >= PLACES_MAX) return p;
  const color = place.color && /^#[0-9a-f]{6}$/i.test(place.color) ? place.color : PLACE_COLORS[p.places.length % PLACE_COLORS.length];
  return { v: 1, places: [...p.places, { ...place, name: place.name.trim().slice(0, 120) || `Place ${p.places.length + 1}`, lat: clampLat(place.lat), lng: wrapLng(place.lng), color }] };
}
export const updatePlace = (p: Places, id: string, patch: Partial<Pick<Place, "name" | "note" | "color" | "lat" | "lng">>): Places => ({
  v: 1, places: p.places.map((x) => {
    if (x.id !== id) return x;
    const next = { ...x, ...patch };
    return validLatLng(next.lat, next.lng) ? { ...next, name: next.name.trim().slice(0, 120) || x.name } : x;
  }),
});
export const removePlace = (p: Places, id: string): Places => ({ v: 1, places: p.places.filter((x) => x.id !== id) });

/** A custom tile template must be https and contain {z}, {x} and {y} (optionally {s} / {r}). */
export function validTileUrl(t: string): boolean {
  if (!/^https:\/\/[^\s"'<>]+$/.test(t)) return false;
  if (!t.includes("{z}") || !t.includes("{x}") || !t.includes("{y}")) return false;
  return !/\{(?!z\}|x\}|y\}|s\}|r\})[^}]*\}/.test(t);
}
