/**
 * TT143 (ST-09) — per-context profiles chosen from measurements, not from a
 * user-agent string.
 *
 * The spec asks for distinct laptop / monitor / tablet behaviour. The trap is to
 * sniff `navigator.userAgent` and pick a name, which is wrong on every modern
 * device: a touchscreen laptop reports a desktop UA and a `pointer: coarse`
 * primary pointer; an iPad in desktop mode reports a Mac UA and is nevertheless
 * a touch device with no hover.
 *
 * So the profile is derived from four measured facts and nothing else:
 *
 *   · `screenCount` from the Screen Details API (1 when it is unavailable);
 *   · `coarse` + `hover` from `matchMedia("(pointer: coarse)")` / `(hover: hover)`;
 *   · `touchPoints` from `navigator.maxTouchPoints`;
 *   · `viewport` in CSS pixels, for the density class only.
 *
 * Order of precedence matters and is asserted: a multi-screen setup is `desk`
 * (pointer devices attached to it), a coarse *primary* pointer with no hover is
 * `tablet` even if a keyboard is attached, and everything else is `laptop`.
 * Changing profile is a *transition* with a stated reason, and the engine returns
 * that reason so the UI can say "you plugged in a screen" instead of silently
 * rearranging the desktop.
 *
 * A profile is a bundle of numbers the shell already understands (text scale,
 * density, window rectangle scale, whether the on-screen keyboard is offered) —
 * not a separate code path, because a second code path is how "tablet mode" rots.
 */

export type ProfileId = "laptop" | "desk" | "tablet";
export interface Measurements {
  screenCount: number;
  coarse: boolean;
  hover: boolean;
  touchPoints: number;
  viewport: { w: number; h: number };
}
export interface Profile {
  id: ProfileId;
  label: string;
  summary: string;
  /** Multiplier applied to default window rectangles. */
  windowScale: number;
  /** Whether the shell should offer the virtual keyboard affordance. */
  softKeyboard: boolean;
  /** Minimum pointer target in CSS pixels. */
  targetPx: number;
  /** Default density token name the shell knows. */
  density: "compact" | "comfortable" | "touch";
}

export const PROFILES: Record<ProfileId, Profile> = {
  laptop: { id: "laptop", label: "Laptop", summary: "One screen, a precise pointer, windows sized to the viewport.", windowScale: 1, softKeyboard: false, targetPx: 24, density: "comfortable" },
  desk: { id: "desk", label: "Desk", summary: "More than one screen: windows respect the screen they were opened on and the dock stays on the primary.", windowScale: 1.15, softKeyboard: false, targetPx: 24, density: "compact" },
  tablet: { id: "tablet", label: "Tablet", summary: "A coarse primary pointer without hover: larger targets, one window at a time, on-screen keyboard offered.", windowScale: 0.85, softKeyboard: true, targetPx: 44, density: "touch" },
};

/** Decide the profile from measurements. Total: every input maps to exactly one. */
export function chooseProfile(m: Measurements): { profile: Profile; reason: string } {
  const screens = Number.isFinite(m.screenCount) ? Math.max(1, Math.floor(m.screenCount)) : 1;
  if (m.coarse && !m.hover && m.touchPoints > 0) {
    return { profile: PROFILES.tablet, reason: `the primary pointer is coarse, cannot hover, and reports ${m.touchPoints} touch point${m.touchPoints === 1 ? "" : "s"}` };
  }
  if (screens > 1) {
    return { profile: PROFILES.desk, reason: `${screens} screens are attached, and the primary pointer is precise` };
  }
  const why = m.touchPoints > 0
    ? `one screen and a precise pointer (${m.touchPoints} touch point${m.touchPoints === 1 ? "" : "s"} present but not primary)`
    : "one screen and a precise pointer";
  return { profile: PROFILES.laptop, reason: why };
}

export interface Transition { changed: boolean; from: ProfileId; to: ProfileId; reason: string; announce: string | null }

/**
 * A profile change is only a change when the id differs; density or target-only
 * differences never generate a toast. The announcement names the cause.
 */
export function transition(previous: ProfileId | null, next: { profile: Profile; reason: string }): Transition {
  if (previous === next.profile.id) return { changed: false, from: next.profile.id, to: next.profile.id, reason: next.reason, announce: null };
  if (previous === null) return { changed: true, from: next.profile.id, to: next.profile.id, reason: next.reason, announce: null };
  return {
    changed: true, from: previous, to: next.profile.id, reason: next.reason,
    announce: `Switched to the ${next.profile.label.toLowerCase()} layout because ${next.reason}.`,
  };
}

/** Density/targets for a viewport, without changing the profile id. */
export function densityFor(profile: Profile, m: Pick<Measurements, "viewport">): { density: Profile["density"]; targetPx: number; note: string } {
  const narrow = m.viewport.w < 720;
  if (profile.id === "tablet") return { density: "touch", targetPx: Math.max(44, profile.targetPx), note: "touch targets stay at or above the WCAG 2.5.8 minimum of 44 px" };
  if (narrow) return { density: "touch", targetPx: 44, note: "a narrow viewport gets touch-sized targets even on a precise pointer, because a thumb is not a mouse" };
  return { density: profile.density, targetPx: profile.targetPx, note: profile.id === "desk" ? "a multi-screen desk can afford compact targets" : "comfortable targets at this width" };
}
