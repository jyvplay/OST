/**
 * TT27 — the slanted Tabletop camera: you look down at a real desk tray at an angle. Pure maths, no DOM —
 * scripts/tabletop-unit.mts checks it, and scripts/e2e-tabletop.mts checks that Chromium renders exactly this.
 *
 * Model (CSS coordinates: x right, y down, z toward the viewer; units = CSS px; angles in degrees):
 *   • The root element has `perspective: P` and `perspective-origin: (W/2, oy)`. CSS projects a point (x, y, z),
 *     z < P, to  x' = ox + (x − ox)·P/(P − z),  y' = oy + (y − oy)·P/(P − z).
 *   • Every face is an absolutely positioned element at left 0 / top 0 with `transform-origin: 0 0` and
 *     `transform: matrix3d(M)`, where M (column-major, exactly CSS's matrix3d order) = Tilt · Local(face).
 *   • Local frames before the tilt: the floor is a FW × FD rectangle in the z = 0 plane whose near edge lies on
 *     y = yB. Walls stand on its edges and rise toward the viewer (+z): the north (far) wall and the two side
 *     walls show their INNER face; the south wall is the near lip, of which a viewer above the desk sees the
 *     OUTER face (as with a real tray) — so its front face points at the viewer and its text is never mirrored.
 *   • Tilt = rotateX(β) about the near edge (y = yB, z = 0): the far edge goes back (z < 0), like a desk top seen
 *     by a seated person.
 *
 * Contract (TT27): the floor must cover ≥ 80 % of the observable Tabletop area (the root rectangle W × H),
 * counting only the part of the floor that is on screen and NOT hidden behind the south lip. `slantGeometry`
 * computes that coverage exactly (convex clipping), and `fitSlant` lowers the tilt until it holds.
 */
export type Mat = number[]; // 16 numbers, column-major (CSS matrix3d order)
export type V3 = [number, number, number];
export type P2 = [number, number];

export const ident = (): Mat => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a: Mat, b: Mat): Mat {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
export const translate = (x: number, y: number, z: number): Mat => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const rad = (d: number) => (d * Math.PI) / 180;
/** CSS rotateX(a): matrix3d(1,0,0,0, 0,cos,sin,0, 0,−sin,cos,0, 0,0,0,1) */
export const rotX = (deg: number): Mat => { const c = Math.cos(rad(deg)), s = Math.sin(rad(deg)); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
/** A frame from three column vectors (local x → u, local y → v, local z → n) and a translation. */
export const frame = (u: V3, v: V3, n: V3, t: V3): Mat => [...u, 0, ...v, 0, ...n, 0, ...t, 1];
export function apply(m: Mat, p: V3): V3 {
  const [x, y, z] = p;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
}
export const toCss = (m: Mat) => `matrix3d(${m.map((v) => (Math.abs(v) < 1e-12 ? 0 : +v.toFixed(6))).join(",")})`;

/** CSS perspective projection (see the header). */
export const project = (p: V3, P: number, ox: number, oy: number): P2 => {
  const s = P / (P - p[2]);
  return [ox + (p[0] - ox) * s, oy + (p[1] - oy) * s];
};

/** Shoelace area (absolute) of a simple polygon. */
export function area(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
const signedArea = (poly: readonly P2[]) => { let a = 0; for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; } return a / 2; };

/** Sutherland–Hodgman: clip `subject` by a CONVEX `clip` polygon (either winding). */
export function clipConvex(subject: readonly P2[], clip: readonly P2[]): P2[] {
  const ccw = signedArea(clip) > 0;
  let out: P2[] = [...subject];
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p: P2) => { const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); return ccw ? c : -c; };
    const inp = out; out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- homography (plane ↔ screen) */
export type H3 = number[]; // 9, row-major
/** The projective map taking the 4 `src` points to the 4 `dst` points (solved exactly, 8×8 Gaussian elimination). */
export function homography(src: readonly P2[], dst: readonly P2[]): H3 {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
export const applyH = (h: H3, p: P2): P2 => { const w = h[6] * p[0] + h[7] * p[1] + h[8]; return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w]; };

/* ---------------------------------------------------------------- the slanted tray */
export type SlantFace = "floor" | "north" | "south" | "west" | "east";
export interface SlantGeometry {
  W: number; H: number;
  /** tilt (deg), perspective (px), perspective origin y (px) */
  beta: number; P: number; oy: number;
  /** floor size in its own plane, near-edge y, wall height, south-lip height, floor left offset */
  FW: number; FD: number; yB: number; hw: number; hs: number; x0: number;
  faces: Record<SlantFace, { w: number; h: number; m: Mat }>;
  /** projected outlines (root px) */
  quads: Record<SlantFace, P2[]>;
  /** visible floor area ÷ (W·H): on screen, minus the part behind the south lip */
  coverage: number;
  /** on-screen area share of each wall (W·H = 1) */
  wallShare: Record<Exclude<SlantFace, "floor">, number>;
  /** floor-local px → root px and back (exact for a plane under perspective) */
  toScreen: H3; toFloor: H3;
}

const fin = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);

/**
 * Build the tray for a W × H root at tilt β with side walls whose visible far end is `inset`·W wide.
 * Everything else is SOLVED, not guessed (each by bisection on a monotone function):
 *   P  — perspective, so the far edge is inset by `inset`·W on each side (that sliver is the side wall you see);
 *   hs — south-lip height, so the lip shows exactly `lip` px (≥ 24 px, the WCAG 2.5.8 minimum target) at the bottom;
 *   FD — floor depth, so the far edge projects to y = topBand (≈ 7.5 % of H: the north wall's band);
 *   hw — wall height, so the north wall's top edge reaches the top of the frame (no empty strip).
 * Vanishing point 45 % of H above the frame (a seated viewer's eye line is above the desk).
 */
export function slantGeometry(w: number, h: number, beta = 38, inset = 0.045, lipMin = 33): SlantGeometry {
  const W = Math.max(320, fin(w, 1440)), H = Math.max(240, fin(h, 900));
  const ox = W / 2, oy = -0.45 * H;
  const FW = W, x0 = 0;
  const lip = Math.max(lipMin, Math.round(H * 0.045)); // ≥ 32 px (the beauty standard's chrome floor); fitSlant drops to 24 (WCAG 2.5.8) only on very short frames
  const topBand = Math.max(24, Math.round(H * 0.075));
  const b = rad(beta), sb = Math.sin(b), cb = Math.cos(b);
  const bisect = (f: (x: number) => number, lo: number, hi: number) => { // f increasing, find f(x) = 0
    for (let i = 0; i < 64; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  const yB = H; // the near edge sits on the bottom of the frame: nothing but the lip below the floor
  const solve = (P: number) => {
    // far edge (local depth FD) lands at topBand: farY decreases with FD
    const farY = (FD: number) => project([ox, yB - FD * cb, -FD * sb], P, ox, oy)[1];
    const FD = bisect((d) => topBand - farY(d), 10, H * 8);
    const far = project([0, yB - FD * cb, -FD * sb], P, ox, oy)[0]; // x of the far-left corner
    return { FD, farInset: far / W };
  };
  // farInset falls as P grows (weaker perspective) → bisect P for the requested inset
  const P = Math.round(bisect((p) => inset - solve(p).farInset, Math.max(W, H) * 0.4, Math.max(W, H) * 40));
  const FD = Math.round(solve(P).FD);
  // lip height: its top edge (local z = hs on the near edge) lands at H − lip
  const lipTop = (hs: number) => project([ox, yB - hs * sb, hs * cb], P, ox, oy)[1];
  const hs = Math.max(8, Math.round(bisect((x) => (H - lip) - lipTop(x), 1, H * 4)));
  const topY = (hw: number) => project([ox, yB - FD * cb - hw * sb, -FD * sb + hw * cb], P, ox, oy)[1];
  const hw = Math.max(48, Math.round(bisect((x) => -topY(x), 4, H * 4)));

  const tilt = mul(translate(0, yB, 0), mul(rotX(beta), translate(0, -yB, 0)));
  const local: Record<SlantFace, Mat> = {
    floor: frame([1, 0, 0], [0, 1, 0], [0, 0, 1], [x0, yB - FD, 0]),
    north: frame([1, 0, 0], [0, 0, -1], [0, 1, 0], [x0, yB - FD, hw]),
    south: frame([1, 0, 0], [0, 0, -1], [0, 1, 0], [x0, yB, hs]),
    west: frame([0, -1, 0], [0, 0, -1], [1, 0, 0], [x0, yB, hw]),
    east: frame([0, 1, 0], [0, 0, -1], [-1, 0, 0], [x0 + FW, yB - FD, hw]),
  };
  const dims: Record<SlantFace, { w: number; h: number }> = {
    floor: { w: FW, h: FD }, north: { w: FW, h: hw }, south: { w: FW, h: hs }, west: { w: FD, h: hw }, east: { w: FD, h: hw },
  };
  const faces = {} as SlantGeometry["faces"], quads = {} as SlantGeometry["quads"];
  for (const f of Object.keys(local) as SlantFace[]) {
    const m = mul(tilt, local[f]);
    const { w: fw, h: fh } = dims[f];
    faces[f] = { ...dims[f], m };
    quads[f] = ([[0, 0], [fw, 0], [fw, fh], [0, fh]] as P2[]).map(([u, v]) => project(apply(m, [u, v, 0]), P, ox, oy));
  }
  const screen: P2[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const floorOn = clipConvex(quads.floor, screen);
  const lipOverFloor = clipConvex(clipConvex(quads.south, screen), floorOn.length >= 3 ? floorOn : screen);
  const coverage = (area(floorOn) - (lipOverFloor.length >= 3 ? area(lipOverFloor) : 0)) / (W * H);
  const share = (f: SlantFace) => { const c = clipConvex(quads[f], screen); return c.length >= 3 ? area(c) / (W * H) : 0; };
  const corners: P2[] = [[0, 0], [FW, 0], [FW, FD], [0, FD]];
  const toScreen = homography(corners, quads.floor);
  const toFloor = homography(quads.floor, corners);
  return {
    W, H, beta, P, oy, FW, FD, yB, hw, hs, x0, faces, quads, coverage,
    wallShare: { north: share("north"), south: share("south"), west: share("west"), east: share("east") }, toScreen, toFloor,
  };
}

export const MIN_FLOOR_COVERAGE = 0.8;

/**
 * The default camera: β = 38° with the widest side walls (inset 6 % … 2 % of W, 0.5 % steps) whose floor still
 * covers ≥ 81 % of the frame (1 point of margin over the 80 % contract). Falls back to the narrowest walls.
 */
export function fitSlant(w: number, h: number, beta = 38): SlantGeometry {
  // prefer a 33 px lip (the 32 px chrome-target floor + 1 px for sub-pixel layout rounding of the root); on very short frames (e.g. 800×300) the 80 % floor share wins and the
  // lip falls back to the WCAG 2.5.8 minimum of 24 px
  for (const lipMin of [33, 24]) for (let i = 60; i >= 20; i -= 5) {
    const g = slantGeometry(w, h, beta, i / 1000, lipMin);
    if (g.coverage >= MIN_FLOOR_COVERAGE + 0.01) return g;
  }
  return slantGeometry(w, h, beta, 0.02, 24);
}

/* ---------------------------------------------------------------- legibility level of detail (TT29) */
/**
 * Why: under the slanted camera the side walls are slivers and the south wall is a lip a few dozen px tall. Rendering
 * a wall's text and tiles there produced unreadable smears (found by TT29 screenshot review), and the slivers were too
 * thin to hit reliably. Rule: a wall face shows DETAIL (text, tiles) only when every part of it renders at a linear
 * scale ≥ MIN_LEGIBLE_SCALE (a 16 px label stays ≥ 9.6 px, about the smallest size still read reliably) AND its
 * projected extent is ≥ MIN_DETAIL_EXTENT px (room for a heading plus one row). Otherwise it shows GLYPHS only
 * (pinned items as shapes, no text), and a flat, unprojected wall tag at the face's on-screen centroid carries the
 * name and counts and acts as the click target and the drop target for pinning.
 *
 * Scale is the minimum singular value of the face homography's Jacobian (local px → screen px), sampled at the four
 * corners and the centre. For a homography, the Jacobian ∝ 1/w² · (affine part), with w affine in (u, v), so the
 * extremes of the scale lie on the boundary; the corners plus the centre are a sampled bound, not a proof of the minimum
 * for arbitrary shear (our wall frames have none).
 */
export const MIN_LEGIBLE_SCALE = 0.6;
export const MIN_DETAIL_EXTENT = 96;
export type WallLod = "detail" | "glyph";
export type TagWall = Exclude<SlantFace, "floor">;
export interface WallTag {
  lod: WallLod;
  /** minimum linear scale over the face (local px → screen px) */
  scale: number;
  /** smaller of the two projected mid-line lengths (px) */
  extent: number;
  /** on-screen centroid of the visible part of the face (root px) */
  x: number; y: number;
  /** the visible part is tall and thin → label it like a book spine */
  vertical: boolean;
  /** bounding box of the visible part (root px) */
  box: { x: number; y: number; w: number; h: number };
}

/** Smallest singular value of a 2×2 matrix [[a, b], [c, d]]. */
export function minSingular(a: number, b: number, c: number, d: number): number {
  const f = a * a + b * b + c * c + d * d, det = a * d - b * c;
  const disc = Math.sqrt(Math.max(0, f * f - 4 * det * det));
  return Math.sqrt(Math.max(0, (f - disc) / 2));
}

/** Minimum linear scale of the map rect(w × h) → quad, sampled at the corners and the centre (analytic Jacobian). */
export function faceScale(w: number, h: number, quad: readonly P2[]): number {
  if (!(w > 0) || !(h > 0) || quad.length !== 4) return 0;
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], quad);
  let min = Infinity;
  for (const [u, v] of [[0, 0], [w, 0], [w, h], [0, h], [w / 2, h / 2]] as P2[]) {
    const X = H[0] * u + H[1] * v + H[2], Y = H[3] * u + H[4] * v + H[5], Wt = H[6] * u + H[7] * v + H[8];
    if (!(Math.abs(Wt) > 1e-12)) return 0;
    // d(X/W)/du = (H0·W − X·H6) / W², etc.
    const w2 = Wt * Wt;
    const a = (H[0] * Wt - X * H[6]) / w2, b = (H[1] * Wt - X * H[7]) / w2;
    const c = (H[3] * Wt - Y * H[6]) / w2, d = (H[4] * Wt - Y * H[7]) / w2;
    min = Math.min(min, minSingular(a, b, c, d));
  }
  return Number.isFinite(min) ? min : 0;
}

const polyArea = (p: readonly P2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += x1 * y2 - x2 * y1; } return s / 2; };
/** Area centroid of a simple polygon (falls back to the vertex mean when degenerate). */
export function centroid(p: readonly P2[]): P2 {
  const A = polyArea(p);
  if (p.length < 3 || Math.abs(A) < 1e-9) { const n = Math.max(1, p.length); return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n]; }
  let cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; const k = x1 * y2 - x2 * y1; cx += (x1 + x2) * k; cy += (y1 + y2) * k; }
  return [cx / (6 * A), cy / (6 * A)];
}

/** Level of detail + tag placement for every wall of a slanted tray. */
export function wallLegibility(g: SlantGeometry): Record<TagWall, WallTag> {
  return legibilityOf(g.W, g.H, g.quads, g.faces);
}

/**
 * The same rule for the straight-down box (TT26 camera): each wall is a strip `depth` deep hinged on a screen edge and
 * meeting the floor, which projects centred at scale `s`. A plane under perspective maps to the screen by a
 * homography, and these four corner correspondences determine it exactly (corner order = the face's own u/v axes,
 * matching Tabletop's face boxes and hinge origins).
 */
export function boxQuads(W: number, H: number, depth: number, s: number): { quads: Record<TagWall, P2[]>; faces: Record<TagWall, { w: number; h: number }> } {
  const cx = W / 2, cy = H / 2, l = cx - (W * s) / 2, r = cx + (W * s) / 2, t = cy - (H * s) / 2, b = cy + (H * s) / 2;
  return {
    quads: {
      north: [[0, 0], [W, 0], [r, t], [l, t]],
      south: [[l, b], [r, b], [W, H], [0, H]],
      west: [[0, 0], [l, t], [l, b], [0, H]],
      east: [[r, t], [W, 0], [W, H], [r, b]],
    },
    faces: { north: { w: W, h: depth }, south: { w: W, h: depth }, west: { w: depth, h: H }, east: { w: depth, h: H } },
  };
}
export function boxLegibility(W: number, H: number, depth: number, s: number): Record<TagWall, WallTag> {
  const { quads, faces } = boxQuads(W, H, depth, s);
  return legibilityOf(W, H, quads, faces);
}

function legibilityOf(W: number, H: number, quads: Record<TagWall, readonly P2[]>, faces: Record<TagWall, { w: number; h: number }>): Record<TagWall, WallTag> {
  const screen: P2[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const out = {} as Record<TagWall, WallTag>;
  const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const len = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (const w of ["north", "south", "west", "east"] as TagWall[]) {
    const q = quads[w], { w: fw, h: fh } = faces[w];
    const scale = faceScale(fw, fh, q);
    const extent = Math.min(len(mid(q[0], q[1]), mid(q[3], q[2])), len(mid(q[0], q[3]), mid(q[1], q[2])));
    const vis = clipConvex(q, screen);
    const xs = vis.map((p) => p[0]), ys = vis.map((p) => p[1]);
    const box = vis.length >= 3 ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : { x: 0, y: 0, w: 0, h: 0 };
    const [cx, cy] = vis.length >= 3 ? centroid(vis) : [W / 2, H / 2];
    out[w] = { lod: scale >= MIN_LEGIBLE_SCALE && extent >= MIN_DETAIL_EXTENT ? "detail" : "glyph", scale, extent, x: cx, y: cy, vertical: box.h > box.w * 1.5, box };
  }
  return out;
}
