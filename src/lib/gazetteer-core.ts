/**
 * TT28 offline gazetteer core: pure and hook-free (unit-tested by scripts/maps-unit.mts). Written from scratch for
 * this repository: TSV parsing, name folding, ranking, qualifiers and the nearest-place grid are all original code.
 *
 * DATA: GeoNames "cities15000" (every populated place with population ≥ 15 000, or a capital), © GeoNames, licensed
 * CC BY 4.0, redistributed in the MIT-licensed npm package `cities-15000-structured` (we only read its TSV file).
 * Attribution is required and is shown in the Maps UI and in every API response.
 *
 * HONEST SCOPE: this is CITY-LEVEL geocoding. It can't find street addresses, small villages (< 15k people) or
 * points of interest, and it answers "what's near here" with the nearest such city, not an address.
 */

export const GEONAMES_ATTRIBUTION = "Place names: GeoNames (CC BY 4.0)";
export const GEONAMES_URL = "https://www.geonames.org/";

export interface City {
  id: number; name: string; ascii: string; lat: number; lng: number;
  cc: string; a1: string; pop: number; tz: string; fcode: string;
}
export interface Gazetteer {
  cities: City[];
  /** Folded search keys per city: [0] = name, [1] = ascii name, the rest = distinct alternate names. */
  keys: string[][];
  /** 1° × 1° buckets of city indexes, keyed by cellKey(). */
  grid: Map<number, number[]>;
}
export interface SearchHit { city: City; score: number; matched: string; label: string }
export interface NearHit { city: City; km: number; bearing: number; compass: string; label: string }

/* ----------------------------------------------------------------- folding */
const SPECIAL: Record<string, string> = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i", "ħ": "h" };
/** Fold a name for matching: lowercase, strip accents (Zürich → zurich), turn punctuation into single spaces. */
export function fold(raw: string): string {
  let s = String(raw ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "");
  s = s.replace(/[ßæœøłđðþıħ]/g, (c) => SPECIAL[c] ?? c);
  // "St." and "Saint" are written both ways in place names
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return s.replace(/\bst\b/g, "saint").replace(/\bste\b/g, "sainte");
}

/* ----------------------------------------------------------------- parsing */
const MAX_ALT = 48;
/** Parse the GeoNames TSV (19 tab-separated columns per row). Malformed rows are skipped, never thrown on. */
export function parseGeoNames(text: string): Gazetteer {
  const cities: City[] = []; const keys: string[][] = []; const grid = new Map<number, number[]>();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start); if (end < 0) end = text.length;
    const line = text.slice(start, end); start = end + 1;
    if (!line || line.charCodeAt(0) === 35 /* # */) continue;
    const c = line.split("\t");
    if (c.length < 15) continue;
    const lat = Number(c[4]), lng = Number(c[5]), id = Number(c[0]);
    if (!c[1] || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const city: City = {
      id: Number.isFinite(id) ? id : cities.length, name: c[1], ascii: c[2] || c[1], lat, lng,
      cc: (c[8] || "").toUpperCase(), a1: c[10] || "", pop: Math.max(0, Number(c[14]) || 0), tz: c[17] || "", fcode: c[7] || "",
    };
    const k = [fold(city.name), fold(city.ascii)];
    const seen = new Set(k);
    if (c[3]) for (const alt of c[3].split(",")) {
      if (k.length >= MAX_ALT + 2) break;
      const f = fold(alt); if (f && !seen.has(f)) { seen.add(f); k.push(f); }
    }
    const i = cities.push(city) - 1; keys.push(k);
    const ck = cellKey(lat, lng); const b = grid.get(ck); if (b) b.push(i); else grid.set(ck, [i]);
  }
  return { cities, keys, grid };
}

/* --------------------------------------------------------------- countries */
const ALIASES: Record<string, string> = {
  usa: "US", "u s a": "US", "u s": "US", america: "US", "united states of america": "US",
  uk: "GB", "u k": "GB", britain: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB",
  holland: "NL", "south korea": "KR", korea: "KR", "north korea": "KP", russia: "RU", "czech republic": "CZ", uae: "AE",
  "ivory coast": "CI", burma: "MM", "vatican": "VA", turkey: "TR",
};
/** US states (and DC) by name → USPS / GeoNames admin1 code. Facts, not copied code. */
const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const nameCache = new Map<string, string>();
let display: Intl.DisplayNames | null | undefined;
/** English country name for an ISO 3166-1 alpha-2 code, from the runtime's own CLDR data (Intl.DisplayNames). */
export function countryName(cc: string): string {
  const k = (cc || "").toUpperCase(); if (!/^[A-Z]{2}$/.test(k)) return k;
  const hit = nameCache.get(k); if (hit !== undefined) return hit;
  if (display === undefined) { try { display = new Intl.DisplayNames(["en"], { type: "region" }); } catch { display = null; } }
  let n = k; try { n = display?.of(k) ?? k; } catch { /* unknown region */ }
  nameCache.set(k, n); return n;
}

/** Does one folded qualifier ("tx", "texas", "france", "us") describe this city? */
export function qualifierMatches(city: City, q: string): boolean {
  if (!q) return true;
  const cc = city.cc.toLowerCase();
  if (q === cc) return true;
  if (/^[a-z]{2,3}$/.test(q) && /^[A-Za-z]+$/.test(city.a1) && q === city.a1.toLowerCase()) return true; // "Paris, TX"
  if (ALIASES[q] === city.cc) return true;
  if (city.cc === "US" && US_STATES[q] === city.a1) return true;
  return fold(countryName(city.cc)) === q;
}

/** "Raleigh, NC, United States": the admin1 code is shown only when it's a readable letter code (US states). */
export function cityLabel(c: City): string {
  const parts = [c.name];
  if (/^[A-Z]{2}$/.test(c.a1) && c.cc === "US") parts.push(c.a1);
  parts.push(countryName(c.cc));
  return parts.join(", ");
}

/* ------------------------------------------------------------------ search */
/** Score one folded key against the folded query (0 = no match). Primary names outrank alternate names. */
function keyScore(k: string, q: string, primary: boolean): number {
  if (k === q) return primary ? 1000 : 820;
  if (k.startsWith(q)) return (primary ? 620 : 470) - Math.min(60, k.length - q.length);
  if ((" " + k).includes(" " + q)) return (primary ? 400 : 300) - Math.min(60, k.length - q.length);
  return 0;
}

/**
 * Search "name[, qualifier…]". Every qualifier (state code/name, country code/name/alias) must match. Ranking: exact >
 * prefix > word-prefix, primary name > alternate name, and then population (log scale) with a small capital bonus.
 */
export function searchCities(g: Gazetteer, raw: string, limit = 10): SearchHit[] {
  const parts = String(raw ?? "").slice(0, 200).split(",").map(fold);
  const q = parts[0] ?? ""; const quals = parts.slice(1).filter(Boolean);
  const min = /^[a-z0-9 ]*$/.test(q) ? 2 : 1; // one CJK character is already a name
  if (q.length < min) return [];
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const hits: SearchHit[] = [];
  for (let i = 0; i < g.cities.length; i++) {
    const ks = g.keys[i]; let best = 0; let matched = "";
    for (let j = 0; j < ks.length; j++) {
      const s = keyScore(ks[j], q, j < 2);
      if (s > best) { best = s; matched = ks[j]; if (s === 1000) break; }
    }
    if (!best) continue;
    const c = g.cities[i];
    if (quals.length && !quals.every((x) => qualifierMatches(c, x))) continue;
    const score = best + 12 * Math.log10(c.pop + 10) + (c.fcode === "PPLC" ? 25 : c.fcode === "PPLA" ? 8 : 0);
    hits.push({ city: c, score, matched, label: "" });
  }
  hits.sort((a, b) => b.score - a.score || b.city.pop - a.city.pop || a.city.id - b.city.id);
  return hits.slice(0, n).map((h) => ({ ...h, score: Math.round(h.score * 10) / 10, label: cityLabel(h.city) }));
}

/* ----------------------------------------------------------------- nearest */
export function cellKey(lat: number, lng: number): number {
  const r = Math.min(179, Math.max(0, Math.floor(lat) + 90));
  const c = ((Math.floor(lng) + 180) % 360 + 360) % 360;
  return r * 360 + c;
}
const R_KM = 6371.0088;
function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((bLng - aLng) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLng - aLng) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/**
 * Nearest cities to a point. Rings of 1° cells are scanned outward; the search stops once the distance already
 * guaranteed covered by the scanned rings exceeds the k-th best distance (so the answer is exact, not approximate).
 */
export function nearestCities(g: Gazetteer, lat: number, lng: number, k = 1): NearHit[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || !g.cities.length) return [];
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  const want = Math.max(1, Math.min(20, Math.floor(k) || 1));
  const r0 = Math.min(179, Math.max(0, Math.floor(lat) + 90)), c0 = Math.floor(lng) + 180;
  const best: { i: number; d: number }[] = []; const visited = new Set<number>();
  const consider = (key: number) => {
    if (visited.has(key)) return; visited.add(key);
    for (const i of g.grid.get(key) ?? []) {
      const c = g.cities[i]; const d = km(lat, lng, c.lat, c.lng);
      if (best.length < want || d < best[best.length - 1].d) {
        best.push({ i, d }); best.sort((a, b) => a.d - b.d); if (best.length > want) best.pop();
      }
    }
  };
  for (let ring = 0; ring <= 180; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      const row = r0 + dr; if (row < 0 || row > 179) continue;
      const edge = Math.abs(dr) === ring;
      const span = Math.min(ring, 180);
      for (let dc = -span; dc <= span; dc++) {
        if (!edge && Math.abs(dc) !== ring) continue;
        consider(row * 360 + (((c0 + dc) % 360) + 360) % 360);
      }
    }
    // Lower bound on the distance to any UNSCANNED city. Scanned cells reach ≥ ring° from the point in latitude and in
    // longitude. From haversine, h ≥ sin²(Δφ/2), so d ≥ R·Δφ; and h ≥ cosφ1·cosφ2·sin²(Δλ/2) ≥ cos²(φmax)·sin²(Δλ/2)
    // within the scanned band. (The great circle is SHORTER than the parallel, so cosφ·Δλ alone would over-claim.)
    const worstLat = Math.min(90, Math.abs(lat) + ring) * Math.PI / 180;
    const byLat = R_KM * ring * Math.PI / 180;
    const byLng = 2 * R_KM * Math.asin(Math.min(1, Math.max(0, Math.cos(worstLat)) * Math.sin(Math.min(180, ring) * Math.PI / 360)));
    if (best.length === want && best[best.length - 1].d <= Math.min(byLat, byLng)) break;
    if (visited.size >= 180 * 360) break;
  }
  return best.map(({ i, d }) => {
    const c = g.cities[i]; const b = bearingDeg(c.lat, c.lng, lat, lng);
    return { city: c, km: Math.round(d * 10) / 10, bearing: Math.round(b), compass: compass(b), label: cityLabel(c) };
  });
}

/** Human description of a point relative to its nearest city: "In Raleigh" (< 3 km) or "12 km NE of Raleigh". */
export function describeNear(h: NearHit | null | undefined, units: "metric" | "imperial" = "metric"): string {
  if (!h) return "";
  if (h.km < 3) return `In ${h.city.name}`;
  const d = units === "imperial" ? `${Math.round(h.km / 1.609344)} mi` : `${Math.round(h.km)} km`;
  return `${d} ${h.compass} of ${h.city.name}`;
}
