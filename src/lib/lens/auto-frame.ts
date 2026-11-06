/**
 * LN-02 — auto-frame.
 *
 * The camera crop follows the speaker without making the viewer seasick.
 *
 * The failure this exists to prevent is specific and common: a face detector
 * returns a slightly different box every 250 ms, and if the crop is drawn at
 * that box the frame jitters at the detector's rate. Most auto-framing looks
 * bad for exactly this reason, and the usual fix — a low-pass filter or an
 * exponential average — overshoots once and wobbles if it is tuned even slightly
 * wrong.
 *
 * This uses a critically damped second-order tracker (the same family as a
 * spring with ζ = 1). Critical damping is the fastest approach that does not
 * overshoot: the crop moves smoothly toward the target and cannot oscillate,
 * because any damping below critical produces overshoot and any above it makes
 * the crop lag. That is a property of the maths, not a tuned-in number, which
 * is why it holds for every frame rate and every jump size.
 *
 * Everything here is pure. The detector, the camera and the canvas live in the
 * component; this module only decides WHERE the crop should be. Truthfully: the
 * FaceDetector API it is designed for is Chromium-only, and where it is absent
 * the caller must report "centred matte" rather than imply tracking.
 */

/** A normalised face box: fractions of the source frame, origin bottom-left (as the API reports). */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the subject sits, in source-frame fractions. */
export interface Subject {
  cx: number;
  cy: number;
  /** Half-extents of the region that must stay in frame. */
  rx: number;
  ry: number;
}

/** The crop the compositor should draw, in source-frame fractions. */
export interface Crop {
  cx: number;
  cy: number;
  /** Zoom relative to a full-frame view; 1 = the whole frame. */
  zoom: number;
}

/** The tracker. Keep one per stream: it is the entire memory of the filter. */
export interface Tracker {
  /** Current position. */
  cx: number;
  cy: number;
  zoom: number;
  /** Current velocity, in fractions per second. */
  vx: number;
  vy: number;
  vz: number;
  /** True until the first real detection, so the first frame snaps rather than glides in from the centre. */
  primed: boolean;
}

/** Settling time constant, in seconds. Smaller is snappier and twitchier. */
export const SMOOTH_SECONDS = 0.35;
/** How much of the frame's height the subject should occupy when framed. */
export const FRAME_FILL = 0.55;
/** The crop never zooms in past this, however small the detected face is. */
export const MAX_ZOOM = 2.4;
/** ...nor out past this, which is the whole frame. */
export const MIN_ZOOM = 1;
/** A detector boxing the wrong thing (a poster, a doorway) can only pull the crop this far. */
export const MAX_STEP_FRACTION = 0.25;

/**
 * Combine every detection in a frame into one region to follow.
 *
 * Taking the FIRST face is what makes a camera lurch sideways whenever a second
 * person walks behind the speaker. Taking the union keeps everyone in frame,
 * which is the correct trade for a camera pointed at a group: nobody is cropped
 * out, and the crop zooms out instead of panning.
 */
export function subjectFromFaces(faces: readonly FaceBox[]): Subject | null {
  if (faces.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of faces) {
    // A degenerate or non-finite box is dropped rather than folded into the union,
    // where one NaN would poison every subsequent frame.
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.w) || !Number.isFinite(f.h)) continue;
    if (f.w <= 0 || f.h <= 0) continue;
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.w);
    maxY = Math.max(maxY, f.y + f.h);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  return { cx: minX + w / 2, cy: minY + h / 2, rx: w / 2, ry: h / 2 };
}

/** A tracker that starts from the centre of the frame, primed to snap on the first detection. */
export function initialTracker(): Tracker {
  return { cx: 0.5, cy: 0.5, zoom: MIN_ZOOM, vx: 0, vy: 0, vz: 0, primed: false };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Advance the tracker by `dt` seconds toward `subject`.
 *
 * Returns a NEW tracker; the input is never mutated, so a dropped frame cannot
 * leave the filter half-updated.
 *
 * `dt` is clamped to 100 ms. A tab that was backgrounded for five seconds must
 * not integrate five seconds of velocity in one step — that is what makes a
 * returning tab snap the crop across the room.
 */
export function track(prev: Tracker, subject: Subject | null, dt: number): Tracker {
  if (!Number.isFinite(dt) || dt <= 0) return prev;
  const h = Math.min(dt, 0.1);

  // No detection this frame: hold position and bleed off velocity, rather than
  // drifting or snapping back to centre the instant a face turns away.
  if (!subject) {
    return { ...prev, vx: prev.vx * 0.8, vy: prev.vy * 0.8, vz: prev.vz * 0.8 };
  }

  // How hard to zoom so the subject fills FRAME_FILL of the height, bounded.
  const wantZoom = clamp(Math.min(FRAME_FILL / Math.max(subject.ry * 2, 1e-4), MAX_ZOOM), MIN_ZOOM, MAX_ZOOM);

  if (!prev.primed) {
    // First real detection: jump straight there. Gliding in from the centre
    // would read as a slow pan for no reason, and the user has not seen a frame yet.
    return { cx: subject.cx, cy: subject.cy, zoom: wantZoom, vx: 0, vy: 0, vz: 0, primed: true };
  }

  // Critical damping, integrated semi-implicitly. omega = 1/tau.
  //
  // A detector that boxes the wrong thing must not be able to yank the crop to
  // the far edge in one frame. The first version of this file clamped the
  // TARGET to within MAX_STEP_FRACTION of the current position, which is a
  // different thing entirely: the tracker then converged, smoothly and
  // correctly, to a point a quarter of the frame away from the subject and
  // stayed there for as long as the bad detection lasted — a permanent offset
  // that looked exactly like a working filter. The cap belongs on how far the
  // crop may MOVE in one frame, so a distant detection is approached at a
  // bounded speed and still arrived at.
  const omega = 1 / SMOOTH_SECONDS;
  const maxTravel = MAX_STEP_FRACTION * h * 10; // MAX_STEP_FRACTION of the frame per 100 ms
  const step = (p: number, v: number, target: number) => {
    const a = omega * omega * (target - p) - 2 * omega * v;
    const nv = v + a * h;
    const np = p + nv * h;
    const travel = np - p;
    if (Math.abs(travel) <= maxTravel) return [np, nv] as const;
    const capped = Math.sign(travel) * maxTravel;
    return [p + capped, capped / h] as const;
  };

  const [cx, vx] = step(prev.cx, prev.vx, subject.cx);
  const [cy, vy] = step(prev.cy, prev.vy, subject.cy);
  const [zoom, vz] = step(prev.zoom, prev.vz, wantZoom);

  // The crop centre can never leave the frame: a subject at the very edge would
  // otherwise push the crop outside the source and leave a black bar.
  return {
    cx: clamp(cx, 0, 1),
    cy: clamp(cy, 0, 1),
    // Zoom is never allowed to overshoot below 1, which would show the letterbox.
    zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
    vx, vy, vz,
    primed: true,
  };
}

/**
 * The source rectangle the compositor must draw, in source pixels.
 *
 * A crop centred at (0.5, 0.5) with zoom 1 is the whole frame. The rectangle is
 * always inside the source: the centre is pulled inward by half the crop so a
 * tracked subject near the edge cannot select pixels that do not exist.
 */
export function cropRect(t: Tracker, srcW: number, srcH: number): { x: number; y: number; w: number; h: number } {
  const w = srcW / t.zoom;
  const h = srcH / t.zoom;
  const x = clamp(t.cx * srcW - w / 2, 0, srcW - w);
  const y = clamp(t.cy * srcH - h / 2, 0, srcH - h);
  return { x, y, w, h };
}

/**
 * How many consecutive frames the tracker is still meaningfully moving.
 *
 * The UI uses this to decide whether to show "tracking" or "steady": a camera
 * that is settling should not claim to be locked on.
 */
export function isSettled(t: Tracker, epsilon = 0.002): boolean {
  return Math.abs(t.vx) < epsilon && Math.abs(t.vy) < epsilon && Math.abs(t.vz) < epsilon;
}

/**
 * What to tell the user when there is no detector.
 *
 * LN-02 must not silently become a fixed centre crop while the toggle still
 * reads "Auto-frame (FaceDetector)" — that is the lie the honesty rule exists
 * to prevent.
 */
export function describeAutoframe(hasDetector: boolean, enabled: boolean, faces: number): string {
  if (!hasDetector) return "No FaceDetector in this browser — the matte stays centred and does not follow you.";
  if (!enabled) return "Auto-frame off — the matte uses a fixed centred position.";
  if (faces === 0) return "Auto-frame on, nobody detected — holding the last framing rather than jumping to centre.";
  return `Auto-frame on, following ${faces === 1 ? "1 person" : `${faces} people`}.`;
}
