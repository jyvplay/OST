/**
 * TT72 SH-11 pad link (src/lib/windowing/pad-link.ts) — pure.
 *  1. parseMsg rejects 24 malformed / hostile shapes and accepts the four message kinds; numbers are clamped and rounded.
 *  2. acceptSeq: per-sender strictly increasing; replays, duplicates and out-of-order messages dropped; memory bounded.
 *  3. padCommands: the full key table (incl. Shift), no focus / minimized focus, zero moves.
 *  4. safety, exhaustive over 2 000 generated (op, desktop) pairs: a command only ever names the focused, visible window.
 *  5. through the real reducer: a pad move / arrow / Enter / Tab changes the desktop exactly like the local command.
 *  6. pickTarget: newest presenting screen, never itself, never a tab / pip.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt72-padlink.mts
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { acceptSeq, KEY_STEP, KEY_STEP_BIG, MAX_STEP, PAD_KEYS, padCommands, padKeyOf, parseMsg, pickTarget, type PadOp } from "../src/lib/windowing/pad-link.ts";
import { initialDesktop, reduce, type DesktopState } from "../src/lib/windowing/state.ts";

const { test, finish } = makeHarness("tt72-padlink");
const COV = { "SH-11": "full" } as const;
const pad = (op: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, kind: "pad", from: "default", to: "display-2", seq: 5, op, ...extra });

await test("parseMsg rejects 24 malformed / hostile shapes, accepts the four kinds, clamps and rounds numbers", COV, () => {
  const bad: unknown[] = [
    null, 7, "pad", [], {}, { v: 2, kind: "who", from: "a" }, { v: 1, kind: "who" }, { v: 1, kind: "who", from: "" }, { v: 1, kind: "who", from: "a b" },
    { v: 1, kind: "who", from: "x".repeat(65) }, { v: 1, kind: "nope", from: "a" }, { v: 1, kind: "presence", from: "a", host: "window" },
    pad({ t: "move", dx: 1 }), pad({ t: "move", dx: NaN, dy: 0 }), pad({ t: "move", dx: Infinity, dy: 0 }), pad({ t: "move", dx: "5", dy: 0 }),
    pad({ t: "key", key: "a" }), pad({ t: "key", key: "Delete" }), pad({ t: "type", text: "rm -rf" }), pad(null), pad({ t: "move", dx: 1, dy: 1 }, { to: "../x" }),
    pad({ t: "move", dx: 1, dy: 1 }, { seq: -1 }), pad({ t: "move", dx: 1, dy: 1 }, { seq: 1.5 }), { v: 1, kind: "pad-ack", from: "a", to: "b", seq: "1" },
  ];
  assert.equal(bad.length, 24);
  for (const b of bad) assert.equal(parseMsg(b), null, JSON.stringify(b));
  assert.deepEqual(parseMsg(pad({ t: "move", dx: 3.6, dy: -9999 })), { v: 1, kind: "pad", from: "default", to: "display-2", seq: 5, op: { t: "move", dx: 4, dy: -MAX_STEP } });
  assert.deepEqual(parseMsg(pad({ t: "key", key: "Tab", shift: 1 })), { v: 1, kind: "pad", from: "default", to: "display-2", seq: 5, op: { t: "key", key: "Tab", shift: false } }, "shift must be exactly true");
  assert.deepEqual(parseMsg({ v: 1, kind: "presence", from: "display-2", host: "screen", bye: "yes", extra: 1 }), { v: 1, kind: "presence", from: "display-2", host: "screen" });
  assert.deepEqual(parseMsg({ v: 1, kind: "presence", from: "d", host: "tab", bye: true }), { v: 1, kind: "presence", from: "d", host: "tab", bye: true });
  assert.deepEqual(parseMsg({ v: 1, kind: "pad-ack", from: "a", to: "b", seq: 3, moved: "x".repeat(500) }), { v: 1, kind: "pad-ack", from: "a", to: "b", seq: 3, moved: "x".repeat(120) });
  assert.deepEqual(parseMsg({ v: 1, kind: "who", from: "preset:a_b-1" }), { v: 1, kind: "who", from: "preset:a_b-1" });
  for (const k of PAD_KEYS) assert.equal(padKeyOf(k), k);
  for (const k of ["a", "Escape", "Delete", "F5", "tab", ""]) assert.equal(padKeyOf(k), null);
});

await test("acceptSeq: per sender strictly increasing — replays, duplicates and out-of-order dropped; 64 senders max", COV, () => {
  const m = new Map<string, number>();
  assert.equal(acceptSeq(m, "a", 1), true); assert.equal(acceptSeq(m, "a", 1), false, "duplicate");
  assert.equal(acceptSeq(m, "a", 3), true); assert.equal(acceptSeq(m, "a", 2), false, "out of order");
  assert.equal(acceptSeq(m, "b", 1), true, "per sender");
  assert.equal(acceptSeq(m, "a", 1_700_000_000_000), true, "a reloaded pad seeds from the clock and is accepted");
  for (let i = 0; i < 200; i++) acceptSeq(m, `s${i}`, 1);
  assert.ok(m.size <= 65, `bounded: ${m.size}`);
});

const desk = (n: number, focusIdx: number | null, minimized = false): DesktopState => {
  let s = initialDesktop(); s = reduce(s, { t: "viewport", w: 1440, h: 900 });
  for (let i = 0; i < n; i++) s = reduce(s, { t: "open", id: `w${i}`, module: "notes", title: `Win ${i}`, rect: { x: 100 + i * 30, y: 80 + i * 20, w: 500, h: 360 } });
  if (focusIdx !== null && n) { s = reduce(s, { t: "focus", id: `w${focusIdx}` }); if (minimized) s = reduce(s, { t: "minimize", id: `w${focusIdx}` }); }
  return s;
};

await test("padCommands: key table incl. Shift; nothing focused / focused window minimized; zero moves", COV, () => {
  const s = desk(3, 1);
  const f = s.focus!;
  assert.deepEqual(padCommands({ t: "move", dx: 5, dy: -2 }, s), [{ t: "nudge", id: f, dx: 5, dy: -2 }]);
  assert.deepEqual(padCommands({ t: "move", dx: 0, dy: 0 }, s), []);
  const k = (key: PadOp & { t: "key" }) => padCommands(key, s);
  assert.deepEqual(k({ t: "key", key: "ArrowLeft", shift: false }), [{ t: "nudge", id: f, dx: -KEY_STEP, dy: 0 }]);
  assert.deepEqual(k({ t: "key", key: "ArrowRight", shift: true }), [{ t: "nudge", id: f, dx: KEY_STEP_BIG, dy: 0 }]);
  assert.deepEqual(k({ t: "key", key: "ArrowUp", shift: false }), [{ t: "nudge", id: f, dx: 0, dy: -KEY_STEP }]);
  assert.deepEqual(k({ t: "key", key: "ArrowDown", shift: true }), [{ t: "nudge", id: f, dx: 0, dy: KEY_STEP_BIG }]);
  assert.deepEqual(k({ t: "key", key: "Tab", shift: false }), [{ t: "cycle", dir: 1 }]);
  assert.deepEqual(k({ t: "key", key: "Tab", shift: true }), [{ t: "cycle", dir: -1 }]);
  assert.deepEqual(k({ t: "key", key: "Enter", shift: false }), [{ t: "toggleMax", id: f }]);
  assert.deepEqual(k({ t: "key", key: "Home", shift: false }), [{ t: "showDesktop" }]);
  const none = desk(0, null);
  assert.deepEqual(padCommands({ t: "move", dx: 5, dy: 5 }, none), []);
  assert.deepEqual(padCommands({ t: "key", key: "Enter", shift: false }, none), []);
  assert.deepEqual(padCommands({ t: "key", key: "Tab", shift: false }, none), [{ t: "cycle", dir: 1 }]);
  const mini = desk(2, 0, true);
  const mf = mini.windows.find((w) => w.minimized)!.id;
  for (const c of padCommands({ t: "move", dx: 9, dy: 9 }, { ...mini, focus: mf })) assert.notEqual((c as { id?: string }).id, mf, "a minimized window is never driven");
});

await test("safety over 2 000 generated (op, desktop) pairs: a command only names the focused, visible window", COV, () => {
  let seed = 11; const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  let cmds = 0;
  for (let i = 0; i < 2000; i++) {
    const n = rnd(5); const s = desk(n, n ? rnd(n) : null, rnd(4) === 0);
    const focus = rnd(6) === 0 ? "ghost" : s.focus;
    const st = { ...s, focus };
    const op: PadOp = rnd(2) ? { t: "move", dx: rnd(801) - 400, dy: rnd(801) - 400 } : { t: "key", key: PAD_KEYS[rnd(PAD_KEYS.length)], shift: !!rnd(2) };
    for (const c of padCommands(op, st)) {
      cmds++;
      if ("id" in c) {
        const w = st.windows.find((x) => x.id === c.id);
        assert.ok(w && c.id === focus && !w.minimized, `${JSON.stringify(op)} → ${JSON.stringify(c)} with focus ${focus}`);
      } else assert.ok(c.t === "cycle" || c.t === "showDesktop", JSON.stringify(c));
    }
  }
  assert.ok(cmds > 800, `exercised ${cmds} commands`);
});

await test("through the real reducer: pad ops change the desktop exactly like the local commands (clamped like any move)", COV, () => {
  let s = desk(2, 0);
  const x0 = s.windows.find((w) => w.id === s.focus)!.x;
  for (const c of padCommands({ t: "move", dx: 40, dy: 10 }, s)) s = reduce(s, c);
  assert.equal(s.windows.find((w) => w.id === "w0")!.x, x0 + 40);
  for (const c of padCommands({ t: "key", key: "ArrowLeft", shift: true }, s)) s = reduce(s, c);
  assert.equal(s.windows.find((w) => w.id === "w0")!.x, x0 + 40 - KEY_STEP_BIG);
  for (let i = 0; i < 20; i++) for (const c of padCommands({ t: "move", dx: MAX_STEP, dy: MAX_STEP }, s)) s = reduce(s, c);
  const w = s.windows.find((x) => x.id === "w0")!;
  assert.ok(w.x <= 1440 && w.y <= 900, `clamped inside the desktop: ${w.x},${w.y}`);
  for (const c of padCommands({ t: "key", key: "Enter", shift: false }, s)) s = reduce(s, c);
  assert.equal(s.windows.find((x) => x.id === "w0")!.maximized, true);
  const before = s.focus;
  for (const c of padCommands({ t: "key", key: "Tab", shift: false }, s)) s = reduce(s, c);
  assert.notEqual(s.focus, before, "Tab cycles focus");
});

await test("pickTarget: the newest presenting screen, never itself, never a tab or pip", COV, () => {
  const p = new Map([["default", { host: "tab" as const, at: 9 }], ["pip-1", { host: "pip" as const, at: 8 }], ["display-2", { host: "screen" as const, at: 3 }], ["display-3", { host: "screen" as const, at: 5 }]]);
  assert.equal(pickTarget(p, "default"), "display-3");
  assert.equal(pickTarget(p, "display-3"), "display-2");
  assert.equal(pickTarget(new Map([["default", { host: "tab" as const, at: 1 }]]), "x"), null);
  assert.equal(pickTarget(new Map(), "default"), null);
});

finish();
