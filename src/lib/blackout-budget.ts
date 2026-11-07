/**
 * TT145 (SH-10) — BlackTop: what an idle external display is actually allowed to
 * cost.
 *
 * The feature is "use a laptop's second screen as a desk surface while the
 * laptop's own panel goes black". A page cannot set brightness, cannot turn a
 * panel off, and cannot stop the compositor from presenting frames. What it can
 * do is stop *asking* for frames, and that is the only lever that shows up on a
 * watt meter. So this module is a budget calculator for that lever, plus an
 * explicit statement of what the blackout surface still owes the user.
 *
 * The three costs it models, each with the mechanism that reduces it:
 *
 *   · COMPOSITOR PRESENTATION — a `requestAnimationFrame` loop that keeps
 *     drawing presents at the display refresh rate whether or not anything
 *     changed. A blackout surface that draws at 1 Hz removes ~59 of every 60
 *     presents. It does not remove them all: a page cannot present zero frames
 *     and still be a live touchpad.
 *   · VIDEO MEMORY — a full-screen radial-gradient or a background video keeps a
 *     GPU layer resident. A flat `#000` fill on a single owned layer is the only
 *     composition that can be dropped most cheaply; the budget refuses a
 *     gradient because "black" is not the requirement, "cheap" is.
 *   · WAKE LOCK — the display must stay awake for the surface to be a surface, so
 *     the wake lock is part of the cost, not an accident. Releasing it on hide is
 *     mandatory: a wake lock held by a hidden page drains a battery for nothing.
 *
 * Touches are also budgeted: coalescing to one move per frame is the difference
 * between a touchpad and a stutter, and the engine refuses a coalescing window
 * below the frame period because it would emit faster than the screen shows.
 */

export const BLACKOUT_FILL = "#000000" as const;
/** One frame per second is the slowest rate a browser will keep a rAF chain alive at. */
export const IDLE_FPS = 1;
export const ASSUMED_REFRESH_HZ = 60;
/** A 13" panel at 60 Hz is roughly 2.5 W of backlight+panel; kept as a stated constant, not a measurement. */
export const PANEL_ESTIMATE_W = 2.5;

export type Fill = "flat" | "gradient" | "video" | "image";

export interface Plan {
  /** Frames per second the surface will request. */
  fps: number;
  /** Fraction of presentations removed relative to 60 Hz, 0..1. */
  presentsRemoved: number;
  /** Whether the surface owns exactly one compositable layer. */
  singleLayer: boolean;
  /** The sentence shown beside the blackout toggle. */
  sentence: string;
  /** Problems that must be fixed before the plan is valid. */
  refuses: string[];
}

export interface Input {
  fill: Fill;
  /** True when the surface is the element the page is scrolled to (a full-bleed layer). */
  ownsLayer: boolean;
  /** True when a CSS animation or transition is running on the surface. */
  animated: boolean;
  /** Refresh rate reported by the display, if the browser exposes one. */
  refreshHz?: number;
  /** True when the tab is hidden; a hidden blackout must release the wake lock. */
  hidden: boolean;
}

/**
 * The plan for one surface. Order of refusals is deliberate: a surface that
 * keeps a video layer resident is wrong even at 1 fps, so the fill is checked
 * before the frame rate.
 */
export function planBlackout(input: Input): Plan {
  const refuses: string[] = [];
  if (input.fill !== "flat") refuses.push(`a ${input.fill} fill keeps a GPU layer with content in it; BlackTop requires the flat ${BLACKOUT_FILL} fill`);
  if (!input.ownsLayer) refuses.push("the surface is not a full-bleed layer, so the desktop behind it is still composited and still costs presents");
  if (input.animated) refuses.push("a running animation on a blackout surface defeats the point: it requests a present every frame");
  if (input.hidden) refuses.push("the tab is hidden: release the wake lock and stop the frame chain instead of holding both for a blank screen");
  const hz = input.refreshHz && input.refreshHz >= 24 && input.refreshHz <= 480 ? input.refreshHz : ASSUMED_REFRESH_HZ;
  const fps = input.fill === "flat" && !input.animated ? IDLE_FPS : hz;
  const presentsRemoved = 1 - fps / hz;
  return {
    fps,
    presentsRemoved,
    singleLayer: input.fill === "flat" && input.ownsLayer,
    refuses,
    sentence: refuses.length
      ? refuses[0]
      : `${fps} frame${fps === 1 ? "" : "s"} per second instead of ${hz}: ${Math.round(presentsRemoved * 100)} % of presentations avoided. The panel itself is still lit — a page cannot dim it.`,
  };
}

/**
 * Touch coalescing. A blackout surface doubles as the touchpad (SH-11), so this
 * is where the two rows meet: a move event per frame is the fastest a pointer
 * can be drawn, and emitting faster is pure queue growth.
 */
export function coalesceTouches(moves: { at: number; x: number; y: number }[], frameMs: number, refreshHz = ASSUMED_REFRESH_HZ): { at: number; x: number; y: number }[] {
  // The frame period is 16.67 ms at 60 Hz, so a 16 ms window is *inside* one frame
  // and emits faster than the display can show. The floor is the frame period with a
  // nanosecond of slack so an exact multiple of 1000/hz is not rejected by float
  // rounding — the comparison that matters is against the true period, not its
  // rounded display value.
  const period = 1000 / refreshHz;
  if (!(frameMs >= period - 1e-9)) throw new Error(`a ${frameMs} ms coalescing window emits faster than a ${refreshHz} Hz display can show; the window must be at least ${period.toFixed(2)} ms`);
  const out: { at: number; x: number; y: number }[] = [];
  let last = -Infinity;
  for (const m of moves) {
    // Keep the LAST move in each window: it is the only one whose position the
    // finger was still at when the frame was drawn.
    if (m.at - last >= frameMs) { out.push(m); last = m.at; }
    else out[out.length - 1] = m;
  }
  return out;
}

/**
 * Cost model. Deliberately labelled as an ESTIMATE: the only honest unit here is
 * "fewer presents", and watts depend on the panel, the compositor and the GPU
 * driver. The function returns both so the UI cannot print one as the other.
 */
export interface Cost {
  presentsPerSecond: number;
  estimatedPanelW: number;
  /** Reads as a measured fact only because it is arithmetic on a counted quantity. */
  measured: string;
  estimated: string;
}

export function cost(plan: Plan, hours: number): Cost {
  if (!(hours >= 0) || !Number.isFinite(hours)) throw new Error("hours must be a finite non-negative number");
  return {
    presentsPerSecond: plan.fps,
    estimatedPanelW: PANEL_ESTIMATE_W,
    measured: `${plan.fps} presents/s, counted from the frame policy`,
    estimated: `${(PANEL_ESTIMATE_W * hours).toFixed(2)} Wh of panel draw over ${hours} h is an estimate, not a measurement; the browser exposes no power figure`,
  };
}

/**
 * What the blackout surface must still do, printed as a checklist so a future
 * change that removes one is visible in review.
 */
export const OBLIGATIONS = [
  "the display must stay awake while the surface is in use (wake lock held)",
  "the wake lock must be released when the tab hides, not when it is unloaded",
  "the touchpad keeps working: a black screen that ignores touches is a broken screen",
  "one way back: any keystroke restores the desktop, and it is stated on screen",
  "the panel is still lit; the only saving is presents, and the UI must not claim otherwise",
] as const;
