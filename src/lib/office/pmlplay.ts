/**
 * TT76 — slide-show playback of transitions and build steps as CSS (pure; no DOM). Original code.
 *
 * The show renders a slide with a per-shape style map (render.tsx ShapeFx). Shapes waiting for an entrance are
 * `visibility: hidden`; the shapes of the step being played get a CSS animation whose keyframes start from the
 * effect's "from" state (fill-mode backwards keeps that state through the effect's delay). Only the individual
 * transform properties (translate / scale) are animated, so a shape's own rotate / flip `transform` is untouched.
 * clip-path keyframes always name both ends as inset() — inset() → none is not interpolable and would flip at 50%.
 * A transition is two stacked layers (outgoing / incoming slide) with one animation on one of them.
 */
import { playSteps, stateAfter, type Effect, type From, type PlayItem, type SlideTransition, type TransKind, type Side } from "./pmlanim";

export type Css = Record<string, string | number>;
export const MOTION_CSS = `
@keyframes fsfx-appear { from, to { opacity: 0 } }
@keyframes fsfx-fade { from { opacity: 0 } }
@keyframes fsfx-fly { from { translate: var(--fx-x, 0px) var(--fx-y, 0px) } }
@keyframes fsfx-wipe { from { clip-path: var(--fx-clip) } to { clip-path: inset(0 0 0 0) } }
@keyframes fsfx-zoom { from { scale: 0; opacity: 0 } }
@keyframes fsfx-out { to { opacity: 0 } }
@keyframes fstr-fade { from { opacity: 0 } }
@keyframes fstr-in { from { translate: var(--tr-x, 0%) var(--tr-y, 0%) } }
@keyframes fstr-out { to { translate: var(--tr-x, 0%) var(--tr-y, 0%) } }
@keyframes fstr-clip-in { from { clip-path: var(--tr-clip) } to { clip-path: inset(0 0 0 0) } }
@keyframes fstr-clip-out { from { clip-path: inset(0 0 0 0) } to { clip-path: var(--tr-clip) } }
@keyframes fstr-zoom { from { scale: var(--tr-sc, .3); opacity: 0 } }
@media (prefers-reduced-motion: reduce) { .fs-motion * , .fs-motion { animation-duration: 1ms !important; animation-delay: 0ms !important } }
`;
/** wipe "from" side → the clip that hides the shape before the wipe starts */
const WIPE_CLIP: Record<From, string> = { l: "inset(0 100% 0 0)", r: "inset(0 0 0 100%)", t: "inset(0 0 100% 0)", b: "inset(100% 0 0 0)" };
export interface Geo { x: number; y: number; w: number; h: number }

/** CSS for one playing item (relative to the slide, px geometry for Fly In) */
export function itemCss(it: PlayItem, g: Geo | undefined, slide: { w: number; h: number }): Css | null {
  const t = (name: string, dur: number, fill = "backwards", ease = "cubic-bezier(.2,.7,.2,1)") => `${name} ${Math.max(1, dur)}ms ${ease} ${it.startMs}ms ${fill}`;
  if (it.kind === "foreign") return it.cls === "entr" ? { animation: t("fsfx-appear", 1) } : it.cls === "exit" ? { animation: t("fsfx-out", it.durMs || 1, "forwards") } : null;
  switch (it.kind) {
    case "appear": return { animation: t("fsfx-appear", 1, "backwards", "linear") };
    case "fade": return { animation: t("fsfx-fade", it.durMs, "backwards", "ease-out") };
    case "zoom": return { animation: t("fsfx-zoom", it.durMs) };
    case "wipe": return { animation: t("fsfx-wipe", it.durMs, "backwards", "linear"), "--fx-clip": WIPE_CLIP[it.from ?? "b"] };
    case "fly": {
      const f = it.from ?? "b"; const G = g ?? { x: 0, y: 0, w: 0, h: 0 };
      const dx = f === "l" ? -(G.x + G.w) : f === "r" ? slide.w - G.x : 0, dy = f === "t" ? -(G.y + G.h) : f === "b" ? slide.h - G.y : 0;
      return { animation: t("fsfx-fly", it.durMs), "--fx-x": `${Math.round(dx)}px`, "--fx-y": `${Math.round(dy)}px` };
    }
  }
  return null;
}

/**
 * Per-shape styles after `done` click steps; when `animate` is true the last of those steps is animated, else every
 * step is shown in its final state (stepping backwards, thumbnails). `addrOf` maps a target spid to its top-level
 * address on the slide (ids inside groups map to the group). `offsetMs` delays the animated step (e.g. until the slide's
 * transition has finished).
 */
export function stepFx(effects: Effect[], done: number, animate: boolean, addrOf: (spid: string) => string | undefined, geo: (addr: string) => Geo | undefined, slide: { w: number; h: number }, offsetMs = 0): Record<string, Css> {
  const out: Record<string, Css> = {}; const steps = playSteps(effects);
  const n = Math.max(0, Math.min(done, steps.length));
  const { hidden } = stateAfter(effects, n);
  const playing = animate && n > 0 ? steps[n - 1].items : [];
  const playingAddr = new Set<string>();
  for (const it of playing) {
    const a = addrOf(it.spid); if (a === undefined || playingAddr.has(a)) continue;
    const css = itemCss(offsetMs ? { ...it, startMs: it.startMs + offsetMs } : it, geo(a), slide); if (css) { out[a] = css; playingAddr.add(a); }
  }
  for (const spid of hidden) { const a = addrOf(spid); if (a !== undefined && !playingAddr.has(a)) out[a] = { visibility: "hidden" }; }
  return out;
}

/* ---------------------------------------------------------------- transitions */
export interface TransFx { ms: number; incoming: Css; outgoing: Css | null; outgoingOnTop: boolean }
const VEC: Record<Side, [number, number]> = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };
const REVEAL: Record<Side, string> = { l: "inset(0 0 0 100%)", r: "inset(0 100% 0 0)", u: "inset(100% 0 0 0)", d: "inset(0 0 100% 0)" };
const RANDOM: TransKind[] = ["fade", "push", "wipe", "cover", "split", "zoom"];
const SIDES: Side[] = ["l", "u", "r", "d"];
/** How slide `index` enters with transition t (random picks deterministically per slide). */
export function transitionFx(t: SlideTransition, index: number): TransFx | null {
  let kind = t.kind === "other" ? t.playsAs ?? "fade" : t.kind;
  let dir: Side = t.dir ?? "l";
  if (kind === "random") { kind = RANDOM[index % RANDOM.length]; dir = SIDES[index % SIDES.length]; }
  const ms = Math.max(1, t.durMs || 500);
  const a = (name: string, fill = "both", ease = "cubic-bezier(.3,.6,.2,1)") => `${name} ${ms}ms ${ease} 0ms ${fill}`;
  const [vx, vy] = VEC[dir];
  switch (kind) {
    case "none": case "cut": return null;
    case "fade": return t.thruBlk ? { ms, incoming: { animation: `fstr-fade ${ms}ms ease-in-out ${Math.round(ms / 3)}ms both` }, outgoing: { animation: a("fsfx-out", "forwards", "ease-in") }, outgoingOnTop: true }
      : { ms, incoming: { animation: a("fstr-fade", "both", "linear") }, outgoing: {}, outgoingOnTop: false };
    case "push": return { ms, incoming: { animation: a("fstr-in"), "--tr-x": `${-vx * 100}%`, "--tr-y": `${-vy * 100}%` }, outgoing: { animation: a("fstr-out", "forwards"), "--tr-x": `${vx * 100}%`, "--tr-y": `${vy * 100}%` }, outgoingOnTop: false };
    case "cover": return { ms, incoming: { animation: a("fstr-in"), "--tr-x": `${-vx * 100}%`, "--tr-y": `${-vy * 100}%` }, outgoing: {}, outgoingOnTop: false };
    case "pull": return { ms, incoming: {}, outgoing: { animation: a("fstr-out", "forwards"), "--tr-x": `${vx * 100}%`, "--tr-y": `${vy * 100}%` }, outgoingOnTop: true };
    case "wipe": return { ms, incoming: { animation: a("fstr-clip-in", "both", "linear"), "--tr-clip": REVEAL[dir] }, outgoing: {}, outgoingOnTop: false };
    case "split": {
      const shut = (t.orient ?? "horz") === "horz" ? "inset(50% 0 50% 0)" : "inset(0 50% 0 50%)";
      return (t.inOut ?? "out") === "out" ? { ms, incoming: { animation: a("fstr-clip-in", "both", "ease-out"), "--tr-clip": shut }, outgoing: {}, outgoingOnTop: false }
        : { ms, incoming: {}, outgoing: { animation: a("fstr-clip-out", "forwards", "ease-in"), "--tr-clip": shut }, outgoingOnTop: true };
    }
    case "zoom": return { ms, incoming: { animation: a("fstr-zoom"), "--tr-sc": t.inOut === "out" ? 1.6 : 0.3 }, outgoing: {}, outgoingOnTop: false };
  }
  return { ms, incoming: { animation: a("fstr-fade", "both", "linear") }, outgoing: {}, outgoingOnTop: false };
}

/** Human summary of a transition, for the panel / status. */
export function describeTransition(t: SlideTransition): string {
  if (t.kind === "none") return "No transition";
  const name = t.kind === "other" ? `${(t.name ?? "other").replace(/^p\d*:/, "")} (kept; plays as ${t.playsAs ?? "fade"})` : t.kind === "pull" ? "Uncover" : t.kind[0].toUpperCase() + t.kind.slice(1);
  const adv = [t.advClick ? "on click" : "", t.advAfterMs !== undefined ? `after ${(t.advAfterMs / 1000).toFixed(2).replace(/\.?0+$/, "")} s` : ""].filter(Boolean).join(" or ") || "no click advance";
  return `${name}${t.kind === "cut" ? "" : ` · ${(t.durMs / 1000).toFixed(2).replace(/\.?0+$/, "")} s`} · advance ${adv}`;
}
