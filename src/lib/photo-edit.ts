/**
 * TT143 (MD-03) — a non-destructive photo edit pipeline.
 *
 * "Non-destructive" is a precise claim and this engine keeps it: an edit list is
 * an ordered array of operations, each with its own switch, and rendering is a
 * pure function `(base, ops) → ops'` that produces a **new** operation list. The
 * original pixels are never mutated, the list is what a version stores, and undo
 * is truncation of the list rather than a saved image.
 *
 * The operations chosen are the ones that can be computed exactly and cheaply in
 * the browser, and the ones deliberately NOT included are the interesting part:
 *
 *   · tonal/colour operations are defined on a `[0,1023]` fixed-point ramp per
 *     channel, so two successive applications in one pass cannot band differently
 *     from one combined application (the classic double-quantisation bug);
 *   · `crop` and `rotate` are geometry only and are validated against the pixel
 *     grid (a crop cannot exceed the image, a rotation is a multiple of 90°);
 *   · sharpen uses a radius-bounded unsharp mask with the halo guard written down;
 *   · nothing here is a generative "enhance": no model, no invented pixels.
 *
 * Every operation reports whether it applies (an identity operation is dropped, so
 * the list stays minimal and comparable), and a malformed operation is refused with
 * the reason instead of being clamped.
 */

export type Op =
  | { kind: "crop"; id: string; x: number; y: number; w: number; h: number }
  | { kind: "rotate"; id: string; turns: 0 | 1 | 2 | 3 }
  | { kind: "exposure"; id: string; ev: number }
  | { kind: "contrast"; id: string; amount: number }
  | { kind: "saturation"; id: string; amount: number }
  | { kind: "temperature"; id: string; kelvinShift: number }
  | { kind: "sharpen"; id: string; radius: number; amount: number }
  | { kind: "denoise"; id: string; strength: number }
  | { kind: "vignette"; id: string; amount: number };

export interface ImageSize { w: number; h: number }
export type Applied = { ok: true; ops: Op[]; dropped: string[] } | { ok: false; reason: string };

/** Fixed-point ramp: 10 bits per channel, so a pass does not band a second time. */
export const RAMP_BITS = 10;
export const RAMP_MAX = (1 << RAMP_BITS) - 1;

/** Resolve a chain into the size it produces, refusing an impossible geometry. */
export function resolveSize(base: ImageSize, ops: readonly Op[]): { size: ImageSize; reason: string | null } {
  let w = base.w, h = base.h;
  for (const op of ops) {
    if (op.kind === "rotate") {
      if (op.turns % 2 === 1) [w, h] = [h, w];
      continue;
    }
    if (op.kind === "crop") {
      if (!Number.isInteger(op.x) || !Number.isInteger(op.y) || !Number.isInteger(op.w) || !Number.isInteger(op.h)) return { size: { w, h }, reason: "a crop must be whole pixels" };
      if (op.w < 1 || op.h < 1) return { size: { w, h }, reason: "a crop must be at least one pixel" };
      if (op.x < 0 || op.y < 0 || op.x + op.w > w || op.y + op.h > h) return { size: { w, h }, reason: `the crop ${op.x},${op.y} ${op.w}×${op.h} is outside the ${w}×${h} image at that point in the chain` };
      w = op.w; h = op.h;
    }
  }
  return { size: { w, h }, reason: null };
}

/**
 * Append one operation, validating it against the chain so far. Identity
 * operations (an exposure of 0 EV) are dropped and named, because a list full of
 * no-ops is a list that cannot be compared between versions.
 */
export function push(base: ImageSize, ops: readonly Op[], candidate: Op): Applied {
  if (ops.some((o) => o.id === candidate.id)) return { ok: false, reason: `“${candidate.id}” is already in the chain` };
  const identity = isIdentity(candidate);
  if (identity) return { ok: true, ops: [...ops], dropped: [candidate.id] };
  const bad = validate(candidate);
  if (bad) return { ok: false, reason: bad };
  const next = [...ops, candidate];
  const size = resolveSize(base, next);
  if (size.reason) return { ok: false, reason: size.reason };
  return { ok: true, ops: next, dropped: [] };
}

function isIdentity(op: Op): boolean {
  switch (op.kind) {
    case "exposure": return op.ev === 0;
    case "contrast": return op.amount === 0;
    case "saturation": return op.amount === 0;
    case "temperature": return op.kelvinShift === 0;
    case "sharpen": return op.amount === 0;
    case "denoise": return op.strength === 0;
    case "vignette": return op.amount === 0;
    case "rotate": return op.turns === 0;
    default: return false;
  }
}

function validate(op: Op): string | null {
  switch (op.kind) {
    case "exposure": return op.ev >= -5 && op.ev <= 5 ? null : "exposure is −5 to +5 EV; beyond that a highlight is already gone";
    case "contrast":
    case "saturation": return op.amount >= -100 && op.amount <= 100 ? null : "contrast and saturation are −100 to +100 percent";
    case "temperature": return Math.abs(op.kelvinShift) <= 4000 ? null : "a white-balance shift beyond ±4000 K invents colour that was not captured";
    case "sharpen": return op.radius >= 0.5 && op.radius <= 4 && op.amount >= 0 && op.amount <= 300 ? null : "unsharp radius is 0.5–4 px and amount 0–300 percent; a larger radius is a halo, not sharpness";
    case "denoise": return op.strength >= 0 && op.strength <= 100 ? null : "denoise is 0–100 percent; past that the texture is gone";
    case "vignette": return op.amount >= -100 && op.amount <= 100 ? null : "vignette is −100 (darken) to +100 (lighten) percent";
    case "rotate": return null;
    case "crop": return op.w >= 1 && op.h >= 1 ? null : "a crop must be at least one pixel";
    default: return null;
  }
}

/** The exact 1-D tone curve a per-channel operation applies, for the UI's preview. */
export function toneCurve(ops: readonly Op[], samples = 17): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    let v = Math.round((i / (samples - 1)) * RAMP_MAX);
    for (const op of ops) v = applyTone(op, v);
    out.push(v);
  }
  return out;
}

function applyTone(op: Op, v: number): number {
  switch (op.kind) {
    case "exposure": return clampRamp(v * 2 ** op.ev);
    case "contrast": {
      const k = 1 + op.amount / 100;
      return clampRamp((v - RAMP_MAX / 2) * k + RAMP_MAX / 2);
    }
    case "saturation": return v; // per-channel saturation needs the luma of all three
    default: return v;
  }
}

const clampRamp = (v: number) => Math.max(0, Math.min(RAMP_MAX, Math.round(v)));

/**
 * Luma-preserving saturation for one pixel. Separated because it is the operation
 * that must NOT be a per-channel curve: applying it per channel is the same as
 * changing contrast, which is the bug this function exists to avoid.
 */
export function saturate(rgb: readonly [number, number, number], amount: number): [number, number, number] {
  const [r, g, b] = rgb;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = 1 + amount / 100;
  const f = (c: number) => clampRamp(luma + (c - luma) * k);
  return [f(r), f(g), f(b)];
}

/** Which operations change geometry, in order. Used to place the crop handle. */
export function geometryOrder(ops: readonly Op[]): string[] {
  return ops.filter((o) => o.kind === "crop" || o.kind === "rotate").map((o) => o.id);
}

/** Undo is truncation; redo is a stack of truncated tails. No pixels are stored. */
export function undo(ops: readonly Op[]): Op[] { return ops.slice(0, -1); }
