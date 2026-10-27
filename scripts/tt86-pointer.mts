import { makeHarness } from "./harness.mts";
import { createPointerTriggerTracker, pointerGestureAction, type PointerAction, type PointerSample } from "../src/lib/pointer-triggers.ts";

const { test, finish } = makeHarness("tt86-pointer");
const ok = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const eq = (actual: unknown, expected: unknown, message: string) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: got ${a}, expected ${e}`);
};

function sample(x: number, y: number, at: number, prev?: { x: number; y: number }, buttons = 0): PointerSample {
  return { x, y, width: 800, height: 600, at, buttons,
    movementX: prev ? x - prev.x : 0, movementY: prev ? y - prev.y : 0 };
}
function path(points: [number, number, number][]) {
  const tracker = createPointerTriggerTracker();
  let prev: { x: number; y: number } | undefined;
  const out: (PointerAction | null)[] = [];
  for (const [x, y, at] of points) { out.push(tracker(sample(x, y, at, prev))); prev = { x, y }; }
  return out;
}

await test("SH-06 corner model: four actions, first sample only arms, exact 6×42 boundaries, entry-only and independent re-arm", { "SH-06": "partial" }, () => {
  const result = path([
    [400, 300, 0],
    [6, 20, 10], [6, 0, 20], [5, 42, 25], // x=6 and y=42 remain outside
    [5, 41, 30], [3, 40, 40], // TL entry, then jitter: one action
    [400, 300, 50], [2, 20, 60], // leave + re-enter
    [794, 20, 70], [798, 10, 80], // top-right
    [400, 300, 90], [4, 557, 100], [4, 558, 105], [5, 599, 110], // bottom-left starts at y=558
    [400, 300, 120], [797, 599, 130], [798, 598, 140], // bottom-right
  ]);
  eq(result, [null, null, null, null, "launcher", null, null, "launcher", "overview", null, null, null, "quickPanel", null, null, "palette", null], "corner trace");

  const alreadyInside = createPointerTriggerTracker();
  eq([alreadyInside(sample(2, 20, 0)), alreadyInside(sample(3, 21, 10, { x: 2, y: 20 })),
    alreadyInside(sample(300, 300, 20, { x: 3, y: 21 })), alreadyInside(sample(2, 20, 30, { x: 300, y: 300 }))],
  [null, null, null, "launcher"], "a pointer resting inside at tracker start is not an entry");
  const synthetic = createPointerTriggerTracker();
  eq([synthetic(sample(300, 300, 0)), synthetic({ ...sample(2, 20, 10, { x: 300, y: 300 }), movementX: 0, movementY: 0 }),
    synthetic(sample(300, 300, 20, { x: 2, y: 20 })), synthetic(sample(2, 20, 30, { x: 300, y: 300 }))],
  [null, null, null, "launcher"], "zero-movement synthetic entry does not fire but re-arms after leaving");
  const held = createPointerTriggerTracker();
  eq([held(sample(300, 300, 0)), held({ ...sample(2, 20, 10, { x: 300, y: 300 }), buttons: 1 }),
    held(sample(2, 20, 20, { x: 2, y: 20 })), held(sample(300, 300, 30, { x: 2, y: 20 })),
    held(sample(2, 20, 40, { x: 300, y: 300 }))],
  [null, null, null, null, "launcher"], "button-held corner entry is not replayed on release; a fresh entry is required");
});

await test("SH-06 edge model: all four rails require an inward 18 px flick within 600 ms, exclude corners, and re-arm on a fresh edge entry", { "SH-06": "partial" }, () => {
  const tracker = createPointerTriggerTracker();
  let prev = { x: 400, y: 300 };
  const step = (x: number, y: number, at: number) => { const r = tracker(sample(x, y, at, prev)); prev = { x, y }; return r; };
  eq([step(400, 300, 0), step(3, 300, 10), step(20, 300, 20), step(21, 300, 30)], [null, null, null, "launcher"], "left entry vs threshold");
  eq([step(400, 300, 31), step(3, 300, 32), step(21, 300, 33)], [null, null, "launcher"], "same edge re-arms after a fresh entry");
  eq(step(400, 300, 40), null, "leave left edge");
  eq([step(797, 300, 50), step(779, 300, 60)], [null, "overview"], "right edge exact threshold");
  eq(step(400, 300, 70), null, "leave right edge");
  eq([step(400, 3, 80), step(400, 21, 90)], [null, "quickPanel"], "top edge exact threshold");
  eq(step(400, 300, 100), null, "leave top edge");
  eq([step(400, 597, 110), step(400, 579, 120)], [null, "palette"], "bottom edge exact threshold");

  const timeout = createPointerTriggerTracker();
  eq([timeout(sample(400, 300, 0)), timeout(sample(2, 300, 1, { x: 400, y: 300 })),
    timeout(sample(30, 300, 602, { x: 2, y: 300 }))], [null, null, null], "expired edge arm does not fire");
  const exactWindow = createPointerTriggerTracker();
  eq([exactWindow(sample(400, 300, 0)), exactWindow(sample(3, 300, 1, { x: 400, y: 300 })),
    exactWindow(sample(21, 300, 601, { x: 3, y: 300 }))], [null, null, "launcher"], "600 ms window is inclusive");

  const pressed = createPointerTriggerTracker();
  eq([pressed(sample(400, 300, 0)), pressed({ ...sample(3, 300, 10, { x: 400, y: 300 }), buttons: 1 }),
    pressed(sample(21, 300, 20, { x: 3, y: 300 })), pressed(sample(400, 300, 30, { x: 21, y: 300 })),
    pressed(sample(3, 300, 40, { x: 400, y: 300 })), pressed(sample(21, 300, 50, { x: 3, y: 300 }))],
  [null, null, null, null, null, "launcher"], "held pointer button does not arm/activate; fresh unpressed entry does");

  const corner = createPointerTriggerTracker();
  eq([corner(sample(400, 300, 0)), corner(sample(2, 20, 1, { x: 400, y: 300 })),
    corner(sample(25, 20, 20, { x: 2, y: 20 }))], [null, "launcher", null], "corner activation is not also an edge activation");
  const armedCorner = createPointerTriggerTracker();
  eq([armedCorner(sample(400, 300, 0)), armedCorner(sample(3, 300, 10, { x: 400, y: 300 })),
    armedCorner(sample(2, 20, 20, { x: 3, y: 300 })), armedCorner(sample(21, 20, 30, { x: 2, y: 20 }))],
  [null, null, "launcher", null], "entering a corner discards the edge arm and produces only the corner action");
});

await test("SH-06 right-drag model: direction, minimum distance, 1.25× axis dominance, ties, and non-right buttons", { "SH-06": "partial" }, () => {
  eq([
    pointerGestureAction(2, -36, 0), pointerGestureAction(2, 36, 0),
    pointerGestureAction(2, 0, -36), pointerGestureAction(2, 0, 36),
    pointerGestureAction(2, -35, 0), pointerGestureAction(2, 40, 40),
    pointerGestureAction(2, 50, 40), pointerGestureAction(2, 40, 50),
    pointerGestureAction(2, 50, 39), pointerGestureAction(2, 39, 50),
    pointerGestureAction(2, 50, 41), pointerGestureAction(2, 41, 50),
    pointerGestureAction(0, -100, 0), pointerGestureAction(1, 0, -100),
  ], ["launcher", "overview", "quickPanel", "palette", null, null, "overview", "palette", "overview", "palette", null, null, null, null], "gesture truth table");
});

await finish();
