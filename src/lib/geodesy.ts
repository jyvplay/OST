/**
 * TT34 MP-06: geodesics on the WGS84 ellipsoid — pure, original code written from the published equations
 * (T. Vincenty, "Direct and inverse solutions of geodesics on the ellipsoid with application of nested equations",
 * Survey Review 1975; the authalic latitude from Snyder, "Map Projections — A Working Manual", USGS 1987, eq. 3-11/3-12).
 *
 * Why: the Maps measure tool used a sphere (haversine), which is off by up to ~0.5 % (≈ 3 km on a 600 km leg) — the
 * Earth is flattened. This module gives distances to sub-millimetre agreement with GeographicLib (checked by
 * scripts/tt34-unit.mts against the independent geographiclib Python package), plus geodesic areas.
 *
 *   inverse(a, b)          shortest geodesic distance (m) and the forward azimuths at both ends (degrees)
 *   direct(a, az, s)       the point reached after s metres from a on initial azimuth az
 *   polygonArea(ring)      area (m²) of the region bounded by geodesic edges (the smaller side), and perimeter
 *
 * Vincenty's inverse iteration does not converge for nearly antipodal points (the geodesic family focuses there).
 * Then the inverse problem is solved by SHOOTING with the direct problem (which converges everywhere): a damped
 * Newton search on (initial azimuth, distance) from several starting azimuths, keeping the shortest solution that
 * lands on the target. The result is flagged `method: "shooting"`.
 */

export const WGS84 = { a: 6378137, f: 1 / 298.257223563 } as const;
const A = WGS84.a, F = WGS84.f, B = A * (1 - F);
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export type LatLng = [number, number];
export interface InverseResult { s: number; az1: number; az2: number; method: "vincenty" | "shooting" | "trivial" }

const wrap180 = (d: number) => { if (d > -180 && d <= 180) return d; const x = ((((d + 180) % 360) + 360) % 360) - 180; return x === -180 ? 180 : x; };
// only touch values outside [-π, π]: "(r + π) mod 2π − π" would round away ~4e-16 rad of every small difference,
// which is 0.02 m² per edge in polygonArea (found by tt34 adversary: a 16 m² triangle at 76.6°S was 0.43 % off)
const wrapPi = (r: number) => (r >= -Math.PI && r <= Math.PI ? r : ((((r + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI);

/** Series coefficients A, B of Vincenty's equations (3) and (4) for u² */
function coeffs(u2: number) {
  const k1 = (Math.sqrt(1 + u2) - 1) / (Math.sqrt(1 + u2) + 1); // Vincenty's 1976 rewrite (better conditioned)
  const Ac = (1 + (k1 * k1) / 4) / (1 - k1);
  const Bc = k1 * (1 - (3 / 8) * k1 * k1);
  return { Ac, Bc };
}

/** Δσ of Vincenty's equation (6) */
function deltaSigma(Bc: number, sinS: number, cosS: number, cos2Sm: number): number {
  return Bc * sinS * (cos2Sm + (Bc / 4) * (cosS * (-1 + 2 * cos2Sm * cos2Sm) - (Bc / 6) * cos2Sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2Sm * cos2Sm)));
}

/** Direct problem: from (lat, lng) on azimuth az1 (deg) for s metres. Converges for every input. */
export function direct(p: LatLng, az1Deg: number, s: number): { lat: number; lng: number; az2: number } {
  const phi1 = p[0] * D2R, a1 = az1Deg * D2R;
  const sinA1 = Math.sin(a1), cosA1 = Math.cos(a1);
  const tanU1 = (1 - F) * Math.tan(phi1);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosA1);
  const sinAlpha = cosU1 * sinA1, cos2Alpha = 1 - sinAlpha * sinAlpha;
  const u2 = cos2Alpha * EP2;
  const { Ac, Bc } = coeffs(u2);
  let sigma = s / (B * Ac), sigmaP: number, cos2Sm = 0, sinS = 0, cosS = 0;
  let n = 0;
  do {
    cos2Sm = Math.cos(2 * sigma1 + sigma); sinS = Math.sin(sigma); cosS = Math.cos(sigma);
    sigmaP = sigma;
    sigma = s / (B * Ac) + deltaSigma(Bc, sinS, cosS, cos2Sm);
  } while (Math.abs(sigma - sigmaP) > 1e-14 && ++n < 200);
  cos2Sm = Math.cos(2 * sigma1 + sigma); sinS = Math.sin(sigma); cosS = Math.cos(sigma);
  const x = sinU1 * sinS - cosU1 * cosS * cosA1;
  const phi2 = Math.atan2(sinU1 * cosS + cosU1 * sinS * cosA1, (1 - F) * Math.sqrt(sinAlpha * sinAlpha + x * x));
  const lambda = Math.atan2(sinS * sinA1, cosU1 * cosS - sinU1 * sinS * cosA1);
  const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
  const L = lambda - (1 - C) * F * sinAlpha * (sigma + C * sinS * (cos2Sm + C * cosS * (-1 + 2 * cos2Sm * cos2Sm)));
  const az2 = Math.atan2(sinAlpha, -x);
  return { lat: phi2 * R2D, lng: wrap180(p[1] + L * R2D), az2: az2 * R2D };
}

/** Vincenty inverse; null when the iteration does not converge (nearly antipodal points). */
function vincentyInverse(p1: LatLng, p2: LatLng): InverseResult | null {
  const L = wrapPi((p2[1] - p1[1]) * D2R);
  const tanU1 = (1 - F) * Math.tan(p1[0] * D2R), tanU2 = (1 - F) * Math.tan(p2[0] * D2R);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1;
  const cosU2 = 1 / Math.sqrt(1 + tanU2 * tanU2), sinU2 = tanU2 * cosU2;
  let lambda = L, lambdaP: number, n = 0;
  let sinL = 0, cosL = 0, sinS = 0, cosS = 0, sigma = 0, sinAlpha = 0, cos2Alpha = 0, cos2Sm = 0;
  do {
    sinL = Math.sin(lambda); cosL = Math.cos(lambda);
    const t1 = cosU2 * sinL, t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosL;
    sinS = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinS === 0) return { s: 0, az1: 0, az2: 0, method: "trivial" }; // coincident
    cosS = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinS, cosS);
    sinAlpha = (cosU1 * cosU2 * sinL) / sinS;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2Sm = cos2Alpha !== 0 ? cosS - (2 * sinU1 * sinU2) / cos2Alpha : 0; // equatorial line
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * F * sinAlpha * (sigma + C * sinS * (cos2Sm + C * cosS * (-1 + 2 * cos2Sm * cos2Sm)));
    if (Math.abs(lambda) > Math.PI + 1e-9 && n > 3) return null; // diverging (antipodal regime)
  } while (Math.abs(lambda - lambdaP) > 1e-13 && ++n < 500);
  if (n >= 500) return null;
  const u2 = cos2Alpha * EP2;
  const { Ac, Bc } = coeffs(u2);
  const s = B * Ac * (sigma - deltaSigma(Bc, sinS, cosS, cos2Sm));
  const az1 = Math.atan2(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL);
  const az2 = Math.atan2(cosU1 * sinL, -sinU1 * cosU2 + cosU1 * sinU2 * cosL);
  return { s, az1: wrap180(az1 * R2D), az2: wrap180(az2 * R2D), method: "vincenty" };
}

/** Local metric miss (m) between a landed point and the target: north and east components. */
function miss(lat: number, lng: number, t: LatLng): [number, number] {
  const phi = t[0] * D2R;
  const M = (A * (1 - E2)) / Math.pow(1 - E2 * Math.sin(phi) ** 2, 1.5); // meridional radius
  const N = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2); // prime vertical radius
  return [(lat - t[0]) * D2R * M, wrapPi((lng - t[1]) * D2R) * N * Math.cos(phi)];
}

/** Inverse by shooting with the direct problem (used where Vincenty's iteration fails). */
function shootingInverse(p1: LatLng, p2: LatLng): InverseResult {
  let best: InverseResult | null = null;
  const half = Math.PI * B; // ≈ half a meridian: a start for the distance
  const dLng = wrapPi((p2[1] - p1[1]) * D2R);
  for (let k = 0; k < 24; k++) {
    let az = (dLng >= 0 ? 1 : -1) * (k * 7.5 + 0.5);
    let s = half;
    let ok = false;
    for (let it = 0; it < 60; it++) {
      const q = direct(p1, az, s);
      const [mn, me] = miss(q.lat, q.lng, p2);
      const err = Math.hypot(mn, me);
      if (err < 1e-5) { ok = true; break; }
      // numerical Jacobian of (north, east) miss w.r.t. (azimuth deg, distance m)
      const ha = 1e-6, hs = 1e-3;
      const qa = direct(p1, az + ha, s), qs = direct(p1, az, s + hs);
      const [an, ae] = miss(qa.lat, qa.lng, p2), [sn, se] = miss(qs.lat, qs.lng, p2);
      const j11 = (an - mn) / ha, j21 = (ae - me) / ha, j12 = (sn - mn) / hs, j22 = (se - me) / hs;
      const det = j11 * j22 - j12 * j21;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-18) break;
      let da = -(j22 * mn - j12 * me) / det, ds = -(-j21 * mn + j11 * me) / det;
      // damping: azimuth steps ≤ 20°, distance steps ≤ 2 000 km (the focal region is ill-conditioned in azimuth)
      const scale = Math.min(1, 20 / Math.max(1e-12, Math.abs(da)), 2e6 / Math.max(1e-12, Math.abs(ds)));
      da *= scale; ds *= scale;
      az = wrap180(az + da); s = Math.max(0, s + ds);
    }
    if (ok && (!best || s < best.s)) {
      const q = direct(p1, az, s);
      best = { s, az1: wrap180(az), az2: wrap180(q.az2), method: "shooting" };
    }
  }
  if (!best) throw new Error("geodesic inverse: no solution found");
  return best;
}

/** Shortest geodesic between two points on WGS84. */
export function inverse(p1: LatLng, p2: LatLng): InverseResult {
  if (p1[0] === p2[0] && wrap180(p1[1] - p2[1]) === 0) return { s: 0, az1: 0, az2: 0, method: "trivial" };
  // a pole's longitude is arbitrary: give it the other point's, so the geodesic is that meridian (no focal problem)
  if (Math.abs(p2[0]) === 90) p2 = [p2[0], p1[1]];
  else if (Math.abs(p1[0]) === 90) p1 = [p1[0], p2[1]];
  const v = vincentyInverse(p1, p2);
  if (v) {
    // Vincenty can "converge" onto a non-shortest solution very close to antipodal: cross-check by shooting there
    const antip = Math.abs(p1[0] + p2[0]) < 0.5 && Math.abs(Math.abs(wrapPi((p2[1] - p1[1]) * D2R)) - Math.PI) < 1 * D2R;
    if (!antip) return v;
    const sh = shootingInverse(p1, p2);
    return sh.s < v.s ? sh : v;
  }
  return shootingInverse(p1, p2);
}

export const distance = (p1: LatLng, p2: LatLng) => inverse(p1, p2).s;
export const pathLength = (pts: LatLng[]) => pts.reduce((sum, p, i) => (i ? sum + distance(pts[i - 1], p) : 0), 0);

/* ------------------------------------------------------------------------- area */

const E = Math.sqrt(E2);
/** Snyder (3-12): q(φ) */
function qOf(sinPhi: number): number {
  return (1 - E2) * (sinPhi / (1 - E2 * sinPhi * sinPhi) - (1 / (2 * E)) * Math.log((1 - E * sinPhi) / (1 + E * sinPhi)));
}
const QP = qOf(1);
/** radius of the sphere with the ellipsoid's surface area */
export const AUTHALIC_R = A * Math.sqrt(QP / 2);
/** authalic latitude β (radians) of geodetic latitude φ (degrees): equal-area mapping of the ellipsoid onto that sphere */
export const authalic = (latDeg: number) => Math.asin(Math.max(-1, Math.min(1, qOf(Math.sin(latDeg * D2R)) / QP)));
/** whole-ellipsoid surface area (m²) */
export const ELLIPSOID_AREA = 4 * Math.PI * AUTHALIC_R * AUTHALIC_R;

/**
 * Area of a polygon with geodesic edges. Each edge is densified along its geodesic (≤ `step` metres (2 km), ≤ 2 000 pieces)
 * and the area is summed on the authalic sphere (exact signed spherical excess per great-circle piece). Since the
 * authalic mapping preserves area and the pieces are short, the residual is the tiny curvature difference between a
 * short geodesic and its image chord. Returns the smaller of the two regions the ring separates.
 */
export function polygonArea(ring: LatLng[], step = 2_000): { area: number; perimeter: number } {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  if (pts.length < 3) return { area: 0, perimeter: pts.length === 2 ? 2 * distance(pts[0], pts[1]) : 0 };
  const dense: LatLng[] = [];
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const g = inverse(a, b);
    perimeter += g.s;
    const n = Math.min(2000, Math.max(1, Math.ceil(g.s / step)));
    dense.push(a);
    for (let k = 1; k < n; k++) { const q = direct(a, g.az1, (g.s * k) / n); dense.push([q.lat, q.lng]); }
  }
  let excess = 0, winding = 0;
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i], q = dense[(i + 1) % dense.length];
    const b1 = authalic(p[0]), b2 = authalic(q[0]);
    const dl = wrapPi((q[1] - p[1]) * D2R);
    const t1 = Math.tan(b1 / 2), t2 = Math.tan(b2 / 2);
    excess += 2 * Math.atan2(Math.tan(dl / 2) * (t1 + t2), 1 + t1 * t2);
    winding += dl;
  }
  // Each term is the strip between an edge and the EQUATOR. A ring that winds once around a pole (Σ Δλ = ±2π) encloses
  // that pole, and the strips then add up to (hemisphere − cap): the enclosed excess is 2π·sign(W) − S. (A parallel
  // at β gives S = 2π sin β, so the cap is 2π(1 − sin β), as it must be.) Found by the tt34 polar-cap test.
  if (Math.abs(winding) > Math.PI) excess = 2 * Math.PI * Math.sign(winding) - excess;
  let area = Math.abs(excess) * AUTHALIC_R * AUTHALIC_R;
  // a ring around a pole (or its complement): fold into the smaller region
  area = area % ELLIPSOID_AREA;
  if (area > ELLIPSOID_AREA / 2) area = ELLIPSOID_AREA - area;
  return { area, perimeter };
}

/** "1.23 km²", "4 560 m²", "12.3 ha" (metric) / "2.1 mi²", "3.4 acres" (imperial) */
export function formatArea(m2: number, units: "metric" | "imperial" = "metric"): string {
  if (units === "imperial") {
    const acres = m2 / 4046.8564224, mi2 = m2 / 2589988.110336;
    if (mi2 >= 1) return `${mi2 >= 100 ? Math.round(mi2).toLocaleString("en-US") : mi2.toFixed(2)} mi²`;
    if (acres >= 1) return `${acres >= 100 ? Math.round(acres).toLocaleString("en-US") : acres.toFixed(2)} acres`;
    return `${Math.round(m2 * 10.763910417).toLocaleString("en-US")} ft²`;
  }
  if (m2 >= 1e6) return `${m2 >= 1e8 ? Math.round(m2 / 1e6).toLocaleString("en-US") : (m2 / 1e6).toFixed(2)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`;
  return `${Math.round(m2).toLocaleString("en-US")} m²`;
}

/**
 * Points along the geodesics joining `pts` (closing the ring when `closed`), at most `step` metres apart, with
 * longitudes unwrapped (continuous, may leave ±180) so a web map draws a Pacific crossing as one short curve rather
 * than a line across the whole world. Pieces per leg are capped at 512.
 */
export function geodesicLine(pts: LatLng[], closed = false, step = 50_000): LatLng[] {
  if (pts.length < 2) return pts.slice();
  const legs = closed ? [...pts, pts[0]] : pts;
  const out: LatLng[] = [[legs[0][0], legs[0][1]]];
  for (let i = 1; i < legs.length; i++) {
    const a = legs[i - 1], b = legs[i];
    const g = inverse(a, b);
    const n = Math.min(512, Math.max(1, Math.ceil(g.s / step)));
    for (let k = 1; k <= n; k++) {
      const q = k === n ? { lat: b[0], lng: b[1] } : direct(a, g.az1, (g.s * k) / n);
      const prev = out[out.length - 1][1];
      const lng = prev + wrap180(q.lng - wrap180(prev)); // continue from the previous longitude
      out.push([q.lat, lng]);
    }
  }
  return out;
}
