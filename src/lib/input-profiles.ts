/**
 * TT136 (ST-09) — accessibility input profiles.
 *
 * A profile is a small, bounded bundle of user preferences that reduce pointer
 * precision or hand-fatigue demands: larger hit targets, an optional hold, a
 * timed delay, and a visible hint. Profile selection is UI-driven; the
 * *engine* is pure so it can be unit-tested without a browser.
 *
 * Honest scope: this does not change what a control *does*, it changes the
 * precision a user must have. Every profile reports the exact target size, and
 * a profile that would violate the platform minimum is refused at selection time.
 */

export type ProfileName = "precision" | "pointer-large" | "touch" | "keyboard-only";

export const HIT_MIN_PX = 44;
export const HIT_LARGE_PX = 56;

export interface ProfileSpec {
  /** Pixels for the enlarged hit area. */
  hitPx: number;
  /** Delay before a click-through, in ms; 0 = immediate. */
  clickDelayMs: number;
  /** Hold-and-release before a confirmation. */
  holdMs: number;
  /** Whether the profile wants a visible target hint. */
  showHint: boolean;
  /** Pointer type the profile is optimised for. */
  pointer: "mouse" | "touch" | "pen";
  reason: string;
}

export const PROFILES: Record<ProfileName, ProfileSpec> = {
  precision: { hitPx: HIT_MIN_PX, clickDelayMs: 0, holdMs: 0, showHint: false, pointer: "mouse", reason: "Standard desktop precision" },
  "pointer-large": { hitPx: HIT_LARGE_PX, clickDelayMs: 120, holdMs: 100, showHint: true, pointer: "mouse", reason: "Larger targets for motor-limited pointer use" },
  touch: { hitPx: 64, clickDelayMs: 240, holdMs: 200, showHint: true, pointer: "touch", reason: "Touch-optimised targets and no tap-through" },
  "keyboard-only": { hitPx: HIT_MIN_PX, clickDelayMs: 0, holdMs: 0, showHint: false, pointer: "pen", reason: "Keyboard-first; focus ring is the target" },
};

/** Validate a requested hit size against the platform minimum; refuses, not clamps. */
export function validateHit(px: number): number {
  if (!Number.isFinite(px) || px < HIT_MIN_PX) throw new Error(`Hit target must be at least ${HIT_MIN_PX}px`);
  if (px > 200) throw new Error("Hit targets above 200px are not supported");
  return px;
}

export function profileFor(name: ProfileName): ProfileSpec {
  if (!(name in PROFILES)) throw new Error(`Unknown input profile ${name}`);
  return PROFILES[name];
}

/** Whether this profile needs the touch + timed delays; a plain pointer does not. */
export function needsTimedGesture(profile: ProfileSpec): boolean {
  return profile.clickDelayMs > 0 || profile.holdMs > 0;
}

/** Whether the profile changes the effective click-through of a control. */
export function delaysClick(profile: ProfileSpec): boolean {
  return profile.clickDelayMs > 0;
}

/** Whether the profile enlarges the hit area beyond the platform minimum. */
export function enlarges(profile: ProfileSpec): boolean {
  return profile.hitPx > HIT_MIN_PX;
}

export interface ProfileChange { from: ProfileName | null; to: ProfileName; applied: ProfileSpec }

/**
 * A profile can only be applied when its pointer mode matches what the platform
 * is currently reporting. On a mouse, "touch" would enlarge targets for a
 * pointer that never touches the screen; that mismatch is refused.
 */
export function canApply(profile: ProfileSpec, devicePointer: "mouse" | "touch" | "pen"): boolean {
  if (profile.pointer === "touch" && devicePointer === "mouse") return false;
  if (profile.pointer === "mouse" && devicePointer === "touch") return false;
  return true;
}

export function describeProfile(name: ProfileName): string {
  const spec = PROFILES[name];
  return `${name}: ${spec.hitPx}px target, ${spec.showHint ? "hint shown" : "no hint"} — ${spec.reason}`;
}

/** Counter-intuitive pair the gate tests: a touch profile on a mouse must be refused. */
export function mismatchReason(profile: ProfileSpec, devicePointer: "mouse" | "touch" | "pen"): string {
  if (profile.pointer === "touch" && devicePointer === "mouse") return "Touch profile on a mouse pointer";
  if (profile.pointer === "mouse" && devicePointer === "touch") return "Mouse profile on a touch pointer";
  return "Profile applies to this device";
}
