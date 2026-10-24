/**
 * TT70 WM-13 edge-hold state machine (src/lib/windowing/edge-hold.ts) — pure.
 *  1. edge zones: 8 px at each side, inclusive; nothing on a desktop too narrow for two zones; NaN never matches.
 *  2. neighbours follow list order (ids need not be contiguous); none past either end or for an unknown active id.
 *  3. arming: entering a zone with a neighbour arms; without one it does not; moving inside the zone keeps the timer;
 *     leaving disarms; jumping straight from one edge to the other re-arms for the new side.
 *  4. latch: after a hop the same edge never re-arms (one hold = one workspace) and its half-snap is suppressed; leaving
 *     the zone releases the latch, coming back arms again.
 *  5. exhaustive check over every (state, side, canHop) input: "arm" only ever happens when entering a non-latched edge
 *     with a neighbour, and the side in the state always equals the input side.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt70-edge.mts
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { EDGE_IDLE, edgeFired, edgeMove, edgeSide, neighbourWorkspace, snapSuppressed, type EdgeHold, type Side } from "../src/lib/windowing/edge-hold.ts";

const { test, finish } = makeHarness("tt70-edge");
const COV = { "WM-13": "full" } as const;

await test("edge zones are 8 px at each side (inclusive); a desktop too narrow for two zones has none; NaN never matches", COV, () => {
  const W = 1440;
  assert.equal(edgeSide(0, W), -1); assert.equal(edgeSide(8, W), -1); assert.equal(edgeSide(9, W), 0);
  assert.equal(edgeSide(W - 1, W), 1); assert.equal(edgeSide(W - 9, W), 1); assert.equal(edgeSide(W - 10, W), 0);
  assert.equal(edgeSide(-30, W), -1, "past the left edge (pointer captured outside) still counts");
  assert.equal(edgeSide(W + 30, W), 1);
  assert.equal(edgeSide(5, 16), 0); assert.equal(edgeSide(5, 0), 0);
  assert.equal(edgeSide(Number.NaN, W), 0); assert.equal(edgeSide(5, Number.NaN), 0);
});

await test("neighbours follow list order (non-contiguous ids); none past either end or for an unknown active workspace", COV, () => {
  const ws = [{ id: 1 }, { id: 4 }, { id: 2 }];
  assert.equal(neighbourWorkspace(ws, 4, 1), 2); assert.equal(neighbourWorkspace(ws, 4, -1), 1);
  assert.equal(neighbourWorkspace(ws, 1, -1), null); assert.equal(neighbourWorkspace(ws, 2, 1), null);
  assert.equal(neighbourWorkspace(ws, 9, 1), null); assert.equal(neighbourWorkspace(ws, 4, 0), null);
  assert.equal(neighbourWorkspace([], 1, 1), null);
});

await test("arming: enter with a neighbour arms, without one does not; moving inside keeps; leaving disarms; edge → other edge re-arms", COV, () => {
  let r = edgeMove(EDGE_IDLE, 1, true); assert.equal(r.timer, "arm");
  r = edgeMove(r.state, 1, true); assert.equal(r.timer, "keep", "moving within the zone keeps the running timer");
  r = edgeMove(r.state, 0, true); assert.equal(r.timer, "disarm");
  r = edgeMove(r.state, 0, true); assert.equal(r.timer, "keep");
  assert.equal(edgeMove(EDGE_IDLE, -1, false).timer, "disarm", "no neighbour: nothing armed");
  r = edgeMove(edgeMove(EDGE_IDLE, -1, true).state, 1, true); assert.equal(r.timer, "arm", "straight to the other edge re-arms");
  assert.equal(r.state.side, 1);
});

await test("latch: after a hop the same edge never re-arms and its half-snap is suppressed; leaving releases the latch", COV, () => {
  let s: EdgeHold = edgeMove(EDGE_IDLE, 1, true).state;
  s = edgeFired(s); assert.deepEqual(s, { side: 1, latched: 1 }); assert.ok(snapSuppressed(s), "release at the edge right after a hop does not tile");
  let r = edgeMove(s, 1, true); assert.equal(r.timer, "keep"); assert.ok(snapSuppressed(r.state));
  r = edgeMove(r.state, 0, true); assert.deepEqual(r.state, { side: 0, latched: 0 }); assert.ok(!snapSuppressed(r.state));
  r = edgeMove(r.state, 1, true); assert.equal(r.timer, "arm", "coming back arms again (the next workspace)");
  // latched at the right edge, then straight to the left edge: the left one arms, the latch is gone
  r = edgeMove(edgeFired(edgeMove(EDGE_IDLE, 1, true).state), -1, true); assert.equal(r.timer, "arm"); assert.equal(r.state.latched, 0);
});

await test("exhaustive: every (state, side, canHop) — 'arm' only when entering a non-latched edge with a neighbour; state.side = input side", COV, () => {
  const sides: Side[] = [-1, 0, 1];
  let n = 0;
  for (const side0 of sides) for (const latched of sides) for (const side of sides) for (const canHop of [true, false]) {
    const s: EdgeHold = { side: side0, latched };
    const r = edgeMove(s, side, canHop); n++;
    assert.equal(r.state.side, side);
    const expectArm = side !== 0 && side !== side0 && side !== (side === latched ? latched : 0) && canHop;
    assert.equal(r.timer === "arm", expectArm, JSON.stringify({ s, side, canHop, r }));
    if (side !== latched) assert.equal(r.state.latched, 0, "leaving the latched edge always clears the latch");
  }
  assert.equal(n, 54);
});

finish();
