/**
 * TT28 Art "genie" minimise: keyframe geometry (pure; unit-tested in scripts/tt28-unit.mts). Original code.
 *
 * HONEST SCOPE: macOS warps the window as a mesh along a curve. The web has no mesh warp for live DOM, so this is an
 * approximation with two standard, GPU-composited properties animated by the Web Animations API:
 *   phase 1 (0 → 45 %): clip-path turns the window into a trapezoid whose bottom edge pinches to the dock tile's
 *                        width, centred over the tile (the "funnel")
 *   phase 2 (45 → 100 %): the top edge pinches too and a translate + scaleY slides the strip down into the tile
 * The last frame lands exactly on the target rect (asserted by the unit test). Under prefers-reduced-motion it isn't run.
 */
export interface Box { x: number; y: number; w: number; h: number }
export const GENIE_MS = 460;

const poly = (pts: [number, number][]) => `polygon(${pts.map(([x, y]) => `${round(x)}px ${round(y)}px`).join(", ")})`;
const round = (v: number) => Math.round(v * 100) / 100;

/** Keyframes in the ghost's own coordinates (the ghost is placed at `src`, transform-origin at its top-left). */
export function genieFrames(src: Box, dst: Box): Keyframe[] {
  const W = Math.max(1, src.w), H = Math.max(1, src.h);
  const cx = dst.x + dst.w / 2 - src.x;               // tile centre, in ghost x
  const hw = Math.max(2, dst.w / 2);
  const l = cx - hw, r = cx + hw;
  const dy = dst.y - src.y;                            // move the top edge onto the tile's top
  const sy = Math.max(0.001, dst.h / H);
  const midY = Math.max(0, Math.min(dy * 0.18, H));    // a slight drop during the funnel phase
  return [
    { offset: 0, clipPath: poly([[0, 0], [W, 0], [W, H], [0, H]]), transform: "translate(0px, 0px) scale(1, 1)", opacity: 1, easing: "cubic-bezier(.4, 0, .7, .4)" },
    { offset: 0.45, clipPath: poly([[0, 0], [W, 0], [r, H], [l, H]]), transform: `translate(0px, ${round(midY)}px) scale(1, 1)`, opacity: 1, easing: "cubic-bezier(.3, 0, .6, 1)" },
    { offset: 1, clipPath: poly([[l, 0], [r, 0], [r, H], [l, H]]), transform: `translate(0px, ${round(dy)}px) scale(1, ${round(sy * 1000) / 1000})`, opacity: 0.35 },
  ];
}

/** Where the final frame puts the visible strip (for tests): x from the clip, y/h from translate + scaleY. */
export function finalBox(src: Box, frames: Keyframe[]): Box {
  const last = frames[frames.length - 1];
  const pts = [...String(last.clipPath).matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const t = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+), (-?[\d.]+)\)/.exec(String(last.transform))!;
  const xs = pts.map((p) => p[0]);
  return { x: src.x + Math.min(...xs), y: src.y + Number(t[2]), w: Math.max(...xs) - Math.min(...xs), h: src.h * Number(t[4]) };
}
