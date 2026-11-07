/**
 * TT141 — IN-07 gamepad pointer mode.
 *
 * The module exists (TT37) but had no pure test: only a browser e2e, which
 * cannot make assertions about exact numbers at 45 ms repeat boundaries. These
 * tests drive `step()` frame by frame with hand-computed expectations.
 *
 * The attacks that matter for a pointer replacement:
 *   • a stalling tab must not teleport the cursor (dt clamp)
 *   • a stick resting just outside the deadzone must not drift endlessly
 *   • releasing a button while the mode is off must not click
 *   • auto-repeat must not fire on the same frame as the initial press
 *   • the cursor must never leave the viewport
 *   • the right stick must scroll slowly at low deflection (sub-pixel carry)
 */
import { makeHarness } from "./harness.mts";
import {
  initialState, shapeStick, step,
  DEADZONE, MAX_SPEED, CURVE, SCROLL_SPEED, NUDGE, REPEAT_DELAY, REPEAT_RATE,
  type PadSnapshot, type PointerState, type PadAction,
} from "../src/lib/gamepad-pointer.ts";

const { test, finish } = makeHarness("tt141-gamepad-pointer");

/** A pad with no input, standard-mapped. */
const idle = (over: Partial<PadSnapshot> = {}): PadSnapshot => ({
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
  mapping: "standard",
  ...over,
});

/** A pad where exactly the listed button indices are pressed. */
const withButtons = (indices: number[], over: Partial<PadSnapshot> = {}): PadSnapshot => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
  for (const i of indices) buttons[i] = { pressed: true };
  return idle({ ...over, buttons });
};

const types = (a: PadAction[]) => a.map((x) => x.type);

await test("IN-07 · the deadzone is radial, so a diagonal inside it is still dead", { "IN-07": "full" }, () => {
  // Axis-aligned deadzone: each component under the threshold → dead.
  if (shapeStick(DEADZONE * 0.7, 0)[0] !== 0) throw new Error("a single axis inside the deadzone moved");
  // Radial deadzone: a diagonal whose MAGNITUDE crosses the threshold is live
  // even though each component is below it. This is the distinction a per-axis
  // deadzone gets wrong — a per-axis implementation would keep this dead.
  const each = DEADZONE * 0.8;                 // 0.12, below the 0.15 threshold
  const mag = Math.hypot(each, each);          // ≈0.1697, above it
  if (mag <= DEADZONE) throw new Error("test setup: the diagonal must exceed the deadzone");
  if (shapeStick(each, each)[0] === 0) {
    throw new Error(`a diagonal of magnitude ${mag.toFixed(3)} was treated as dead — the deadzone is per-axis, not radial`);
  }
  // Exactly at the deadzone is still dead; just past it is not.
  if (shapeStick(DEADZONE, 0)[0] !== 0) throw new Error("the deadzone boundary must be inclusive-zero");
  if (shapeStick(DEADZONE + 1e-6, 0)[0] === 0) throw new Error("just past the deadzone must move");
});

await test("IN-07 · the response curve keeps direction and bounds magnitude", { "IN-07": "full" }, () => {
  // A full deflection produces unit magnitude, in the same direction as input.
  const [fx, fy] = shapeStick(1, 0);
  if (Math.abs(fx - 1) > 1e-9 || Math.abs(fy) > 1e-9) throw new Error(`full right stick → ${fx},${fy}`);
  // Direction is preserved for an arbitrary angle.
  const [ax, ay] = shapeStick(0.6, 0.8);
  if (Math.abs(ax / ay - 0.6 / 0.8) > 1e-9) throw new Error("the curve changed the stick direction");
  // Magnitude never exceeds 1 even if an engine reports >1.
  const [ox, oy] = shapeStick(3, 4);
  if (Math.hypot(ox, oy) > 1 + 1e-9) throw new Error("a >1 report produced >1 velocity");
  // The curve is monotone: more deflection is never slower.
  let prev = -1;
  for (let v = DEADZONE; v <= 1.0001; v += 0.05) {
    const m = Math.abs(shapeStick(Math.min(1, v), 0)[0]);
    if (m < prev - 1e-9) throw new Error(`curve is not monotone at ${v}`);
    prev = m;
  }
  // ... and the exponent actually does something (it is not a straight line).
  const mid = shapeStick((1 + DEADZONE) / 2, 0)[0];
  const linear = ((1 + DEADZONE) / 2 - DEADZONE) / (1 - DEADZONE);
  if (Math.abs(mid - linear) < 0.05) throw new Error(`curve ${CURVE} behaves like a straight line at the midpoint`);
  // Non-finite input is zero, not NaN propagating into the cursor position.
  if (shapeStick(NaN, 0)[0] !== 0 || shapeStick(Infinity, 0)[0] !== 0) throw new Error("non-finite stick became a number");
});

await test("IN-07 · a stalled tab cannot teleport the cursor", { "IN-07": "full" }, () => {
  const s = initialState(800, 600);
  // 100 ms is the clamp. At full deflection that is MAX_SPEED × 0.1 px.
  const tenFrames = step(s, idle({ axes: [1, 0, 0, 0] }), 100, 0, 800, 600);
  const want = Math.round(800 / 2 + MAX_SPEED * 0.1);
  if (tenFrames.state.x !== want) throw new Error(`100 ms frame moved to ${tenFrames.state.x}, want ${want}`);
  // A 5 s stall must move no further than a 100 ms frame.
  const stall = step(s, idle({ axes: [1, 0, 0, 0] }), 5000, 0, 800, 600);
  if (stall.state.x !== want) throw new Error(`a 5 s stall moved to ${stall.state.x} — dt is not clamped`);
  // A negative or non-finite dt moves nothing.
  for (const bad of [-50, NaN, Infinity]) {
    const r = step(s, idle({ axes: [1, 0, 0, 0] }), bad, 0, 800, 600);
    if (r.state.x !== s.x) throw new Error(`dt ${bad} moved the cursor`);
  }
});

await test("IN-07 · the cursor never leaves the viewport", { "IN-07": "full" }, () => {
  let s = initialState(400, 300);
  // Push right for a long time.
  for (let i = 0; i < 100; i++) s = step(s, idle({ axes: [1, 0, 0, 0] }), 100, i * 100, 400, 300).state;
  if (s.x !== 399) throw new Error(`right edge clamp → ${s.x}, want 399`);
  // And left.
  for (let i = 0; i < 100; i++) s = step(s, idle({ axes: [-1, 0, 0, 0] }), 100, i * 100, 400, 300).state;
  if (s.x !== 0) throw new Error(`left edge clamp → ${s.x}`);
  for (let i = 0; i < 100; i++) s = step(s, idle({ axes: [0, 1, 0, 0] }), 100, i * 100, 400, 300).state;
  if (s.y !== 299) throw new Error(`bottom clamp → ${s.y}`);
});

await test("IN-07 · a press is only released if its own down was sent", { "IN-07": "full" }, () => {
  // The attack: hold A, disable the mode with Start, release A, re-enable.
  // A naive edge tracker emits an "up" that no "down" ever preceded, which
  // browsers treat as a click on whatever is under the cursor.
  let s = initialState(100, 100);
  const press = step(s, withButtons([0]), 16, 0, 100, 100);
  if (!types(press.actions).includes("down")) throw new Error("A press did not emit down");
  s = press.state;
  if (!s.downSent) throw new Error("downSent not recorded");
  const release = step(s, idle(), 16, 16, 100, 100);
  if (!types(release.actions).includes("up")) throw new Error("a real release did not emit up");
  if (release.state.downSent) throw new Error("downSent not cleared");

  // Now the adversarial path: down, disable, release, enable.
  let t = step(initialState(100, 100), withButtons([0]), 16, 0, 100, 100).state;
  const disabled = step(t, withButtons([9]), 16, 16, 100, 100); // Start toggles off
  t = disabled.state;
  if (t.enabled) throw new Error("Start did not disable the mode");
  const off = step(t, idle(), 16, 32, 100, 100);
  if (types(off.actions).includes("up")) throw new Error("an up was emitted for a press this mode never released");
  // Re-enable, then press and release cleanly.
  t = step(off.state, withButtons([9]), 16, 48, 100, 100).state;
  if (!t.enabled) throw new Error("Start did not re-enable");
  const clean = step(t, withButtons([0]), 16, 64, 100, 100);
  if (!types(clean.actions).includes("down")) throw new Error("a fresh press after re-enable did not emit down");
});

await test("IN-07 · disabling mid-press releases the page, never leaves it stuck", { "IN-07": "full" }, () => {
  let s = step(initialState(100, 100), withButtons([0]), 16, 0, 100, 100).state;
  // Press Start while A is held: the page must receive an up, because a stuck
  // pointerdown swallows every subsequent click on the page.
  const r = step(s, withButtons([0, 9]), 16, 16, 100, 100);
  if (!types(r.actions).includes("up")) throw new Error("disabling while pressed left the page with a stuck button");
  if (r.state.downSent) throw new Error("downSent survived the forced release");
  if (!types(r.actions).includes("toggle")) throw new Error("no toggle action emitted");
});

await test("IN-07 · d-pad nudges once, then repeats on its own schedule", { "IN-07": "full" }, () => {
  let s = initialState(100, 100);
  // Frame 1: d-pad right pressed for the first time.
  const first = step(s, withButtons([15]), 16, 1000, 100, 100);
  s = first.state;
  const moves = first.actions.filter((a) => a.type === "move") as Array<{ type: "move"; x: number; y: number }>;
  if (moves.length !== 1 || moves[0].x !== 51) throw new Error(`nudge → ${JSON.stringify(moves)}, want one move to x=51`);
  // Held, but before the repeat delay: no further movement.
  const heldEarly = step(s, withButtons([15]), 16, 1000 + REPEAT_DELAY - 1, 100, 100);
  if (heldEarly.actions.some((a) => a.type === "move")) throw new Error(`repeat fired before the ${REPEAT_DELAY} ms delay`);
  // At the boundary: repeats.
  const heldAt = step(s, withButtons([15]), 16, 1000 + REPEAT_DELAY, 100, 100);
  s = heldAt.state;
  if (!heldAt.actions.some((a) => a.type === "move")) throw new Error("repeat did not fire at the boundary");
  // Then every REPEAT_RATE.
  const next = step(s, withButtons([15]), 16, 1000 + REPEAT_DELAY + REPEAT_RATE, 100, 100);
  if (!next.actions.some((a) => a.type === "move")) throw new Error(`repeat did not fire again at +${REPEAT_RATE} ms`);
  // Releasing and pressing again restarts the delay, not the rate.
  const released = step(next.state, idle(), 16, 5000, 100, 100).state;
  const again = step(released, withButtons([15]), 16, 6000, 100, 100);
  if (!again.actions.some((a) => a.type === "move")) throw new Error("a fresh press after release did not nudge");
});

await test("IN-07 · the other buttons map to the documented actions", { "IN-07": "full" }, () => {
  const s = initialState(100, 100);
  const cases: Array<[number, string]> = [[1, "escape"], [2, "context"], [5, "focus"], [4, "focus"]];
  for (const [btn, want] of cases) {
    const r = step(s, withButtons([btn]), 16, 0, 100, 100);
    if (!types(r.actions).includes(want as never)) throw new Error(`button ${btn} did not emit ${want}: ${types(r.actions)}`);
  }
  // Focus direction must actually differ between the bumpers.
  const fwd = step(s, withButtons([5]), 16, 0, 100, 100).actions.find((a) => a.type === "focus") as { dir: number };
  const back = step(s, withButtons([4]), 16, 0, 100, 100).actions.find((a) => a.type === "focus") as { dir: number };
  if (fwd.dir !== 1 || back.dir !== -1) throw new Error(`focus directions ${fwd.dir}/${back.dir}`);
});

await test("IN-07 · a non-standard pad still gets sticks, A and B only", { "IN-07": "full" }, () => {
  const raw: PadSnapshot = { axes: [1, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })), mapping: "" };
  const s = initialState(100, 100);
  const moved = step(s, raw, 100, 0, 100, 100);
  if (!types(moved.actions).includes("move")) throw new Error("a non-standard pad lost the left stick");
  // D-pad index 15 must NOT nudge on a pad whose layout we cannot know.
  const dpad = { ...raw, axes: [0, 0, 0, 0], buttons: withButtons([15]).buttons };
  const r = step(s, dpad, 16, 0, 100, 100);
  if (r.actions.some((a) => a.type === "move")) throw new Error("a non-standard pad drove the d-pad by index guess");
  // A and B keep working.
  if (!types(step(s, { ...raw, buttons: withButtons([0]).buttons }, 16, 0, 100, 100).actions).includes("down")) {
    throw new Error("A stopped working on a non-standard pad");
  }
  if (!types(step(s, { ...raw, buttons: withButtons([1]).buttons }, 16, 0, 100, 100).actions).includes("escape")) {
    throw new Error("B stopped working on a non-standard pad");
  }
});

await test("IN-07 · slow scrolling still moves (sub-pixel carry)", { "IN-07": "full" }, () => {
  // The bug: truncating each frame's scroll to an integer means a gentle
  // right-stick push never scrolls, because each frame is 0.4 px.
  let s = initialState(100, 100);
  let scrolled = 0;
  let frames = 0;
  const gentle = idle({ axes: [0, 0, 0, 0.25] });
  while (frames < 60 && scrolled === 0) {
    const r = step(s, gentle, 16, frames * 16, 100, 100);
    s = r.state;
    for (const a of r.actions) if (a.type === "scroll") scrolled += a.dy;
    frames++;
  }
  if (scrolled === 0) throw new Error("a 25% stick push never scrolled in 60 frames — carry is not accumulating");
  // A centred stick resets the carry, so it cannot leak between gestures.
  const centred = step(s, idle(), 16, 9999, 100, 100);
  if (centred.state.carryScroll !== 0) throw new Error(`carry not reset when the stick centres: ${centred.state.carryScroll}`);
  // Full deflection scrolls fast and downward is positive (matching the wheel).
  const full = step(initialState(100, 100), idle({ axes: [0, 0, 0, 1] }), 100, 0, 100, 100);
  const sc = full.actions.find((a) => a.type === "scroll") as { dy: number };
  if (!sc || sc.dy !== Math.trunc(SCROLL_SPEED * 0.1)) throw new Error(`full scroll → ${JSON.stringify(sc)}`);
});

await test("IN-07 · every frame is a pure function of its inputs", { "IN-07": "full" }, () => {
  const s = initialState(800, 600);
  const a = step(s, idle({ axes: [0.5, 0.5, 0, 0] }), 16, 500, 800, 600);
  const b = step(s, idle({ axes: [0.5, 0.5, 0, 0] }), 16, 500, 800, 600);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("two identical calls disagreed");
  // The caller's state object must not be mutated.
  const before = JSON.stringify(s);
  step(s, idle({ axes: [1, 1, 1, 1] }), 16, 0, 800, 600);
  if (JSON.stringify(s) !== before) throw new Error("step mutated the state it was given");
  // The documented initial position is the viewport centre.
  if (s.x !== 400 || s.y !== 300) throw new Error(`initialState → ${s.x},${s.y}`);
  if (!s.enabled) throw new Error("the mode must start enabled");
});

finish();
