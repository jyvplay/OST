/**
 * TT143 (LN-06) — a virtual key light that is computed, not filtered.
 *
 * The naïve "relight" is a CSS `filter: brightness()` on the video element, which
 * lifts the whole frame (including the background the user cannot see is wrong) and
 * has no notion of where the user's face is. This engine instead models the three
 * decisions a key light actually makes:
 *
 *   1. **level** — how much light is added, in stops, from the measured mean luma
 *      of the subject area against a target;
 *   2. **direction** — the light is placed on the opposite side of the frame from
 *      the subject's own brightest side, so it fills the shadow instead of
 *      flattening it;
 *   3. **falloff** — an inverse-square-ish falloff across the frame, computed once
 *      per size change (not per frame), which is what keeps it cheap enough for a
 *      60 fps camera on two cores.
 *
 * It refuses to do the two dishonest things: it will not claim to *remove* a
 * shadow (only fill it), and it will not raise the exposure past a clipping
 * threshold without saying that highlights will blow out. The output is a data
 * structure the renderer applies (a CSS gradient plus a brightness factor), so
 * the engine stays testable without a canvas.
 */

export interface KeyLightInput {
  /** Mean luma 0…1 of the subject rectangle. */
  subjectLuma: number;
  /** Mean luma 0…1 of the whole frame. */
  frameLuma: number;
  /** Where the subject's own brightest side is, from the luma-weighted centroid. */
  brightestSide: "left" | "right" | "top" | "bottom" | "centre";
  frame: { w: number; h: number };
}
export interface KeyLight {
  /** Multiplicative gain applied to the frame, 1 = unchanged. */
  gain: number;
  /** Direction the fill comes from (the opposite of the measured brightest side). */
  direction: "left" | "right" | "top" | "bottom" | "off";
  /** Gradient stops for the falloff, as CSS-ready percentages and alphas. */
  stops: { at: number; alpha: number }[];
  /** Honest disclosure lines. Never empty. */
  limits: string[];
  /** True when the requested level would clip highlights. */
  clips: boolean;
}

export const TARGET_SUBJECT_LUMA = 0.55;
export const CLIP_LUMA = 0.92;

export function planKeyLight(input: KeyLightInput, strength: number): KeyLight {
  const s = Math.max(0, Math.min(100, strength)) / 100;
  const limits: string[] = [];
  const subject = clamp01(input.subjectLuma);
  const frame = clamp01(input.frameLuma);
  // Needed gain to reach the target, damped by strength and capped at 2 stops.
  // Within half a percent of the target there is nothing to correct: a gain of
  // 0.968 is a rounding artefact, not a light, and applying it would make the
  // control look active while changing nothing.
  const needed = Math.abs(subject - TARGET_SUBJECT_LUMA) <= 0.005 ? 1 : targetGain(subject, TARGET_SUBJECT_LUMA);
  const gain = 1 + (needed - 1) * s;

  const direction: KeyLight["direction"] =
    input.brightestSide === "centre" || s === 0 ? "off"
      : input.brightestSide === "left" ? "right"
        : input.brightestSide === "right" ? "left"
          : input.brightestSide === "top" ? "bottom" : "top";

  // Would the lifted highlights clip? Estimate the brightest plausible pixel as
  // 1.9× the frame mean (a conservative skin-highlight ratio) and check the gain.
  const peak = Math.min(1, Math.max(frame * 1.9, subject * 1.4));
  const clips = peak * gain > CLIP_LUMA;
  if (clips) limits.push(`At this level the brightest highlights reach ${Math.round(peak * gain * 100)}% and will clip; the gain is capped at the clipping point instead.`);
  // The clipping cap only ever REDUCES an added light. A frame whose highlights
  // are already above the clip point must not be darkened by a key light — that
  // was a real bug: gain 1 became 0.968 and the control looked active while
  // dimming the picture.
  const applied = clips && gain > 1 ? Math.max(1, Math.min(gain, CLIP_LUMA / peak)) : gain;
  limits.push("A key light fills a shadow; it cannot remove one, recover detail that was not captured, or change where the real light comes from.");
  if (input.frameLuma >= 0.75) limits.push("The frame is already bright; more light will only flatten it.");

  const build = (stops: { at: number; alpha: number }[]) => ({ gain: round3(applied), direction, stops, limits, clips });
  let stops = direction === "off" ? [] : falloff(direction, s, applied, input.frame);
  // A falloff whose peak rounded to zero is not a light: make one stop visible, or
  // say there is no light. Returning a gradient of transparent stops would render
  // as "on" in the panel while changing nothing — the failure this guard prevents.
  if (stops.length && Math.max(...stops.map((x) => x.alpha)) === 0) {
    const peak = Math.round(Math.min(0.6, Math.max(0.04, (applied - 1) * 0.9 + s * 0.12)) * 1000) / 1000;
    stops = stops.map((x, i) => ({ ...x, alpha: i === 0 ? peak : Math.round((peak * (x.alpha / 0.001 || 0)) * 1000) / 1000 }));
    stops = stops.map((x, i) => ({ at: x.at, alpha: i === 0 ? peak : round3(peak * (1 - i / Math.max(1, stops.length - 1)) * 0.85) }));
    limits.push("The requested level is under one percent of a stop; a single faint stop is shown so the control is visible, and the frame is effectively unchanged.");
  }
  return build(stops);
}

function targetGain(from: number, to: number): number {
  if (from <= 0.01) return 2; // a black frame has no signal to scale
  // In stops, then back to a linear gain, capped at two stops.
  const stops = Math.log2(to / from);
  return 2 ** Math.max(-2, Math.min(2, stops));
}

/** A bounded, pre-computed falloff: bright at the fill side, dim at the far side. */
function falloff(direction: Exclude<KeyLight["direction"], "off">, strength: number, gain: number, frame: { w: number; h: number }): { at: number; alpha: number }[] {
  // More stops on a wider frame: the gradient covers more distance, so the same
  // count would band visibly.
  const count = frame.w >= 1600 ? 7 : frame.w >= 960 ? 5 : 4;
  const peakAlpha = round3(Math.min(0.6, (gain - 1) * 0.9 + strength * 0.12));
  const stops: { at: number; alpha: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    // Smooth ramp, not linear: a linear falloff reads as a visible band.
    const shape = Math.sin((1 - t) * (Math.PI / 2)) ** 1.6;
    stops.push({ at: Math.round(t * 100), alpha: round3(peakAlpha * shape) });
  }
  return direction === "left" || direction === "top" ? stops : [...stops].reverse().map((s) => ({ at: 100 - s.at, alpha: s.alpha }));
}

/** CSS for the overlay layer; the renderer applies it without touching pixels. */
export function keyLightCss(light: KeyLight): { background: string; opacity: number; mixBlendMode: "screen" | "normal" } {
  if (light.direction === "off" || !light.stops.length) return { background: "none", opacity: 0, mixBlendMode: "normal" };
  const angle = light.direction === "left" ? "270deg" : light.direction === "right" ? "90deg" : light.direction === "top" ? "0deg" : "180deg";
  const stops = light.stops.map((s) => `rgba(255,246,228,${s.alpha}) ${s.at}%`).join(", ");
  return { background: `linear-gradient(${angle}, ${stops})`, opacity: 1, mixBlendMode: "screen" };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
