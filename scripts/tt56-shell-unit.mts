/**
 * TT56 shell unit suite — WM-05 MRU model (reducer integration + switcher item modes) as a property test against an
 * independent reference model, and the NC-06 OSD settle model.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt56-shell-unit.mts
 */
import { makeHarness } from "./harness.mts";
import { reduce, initialDesktop, type DesktopState, type WindowCommand } from "../src/lib/windowing/state.ts";
import { switchItems, initialIndex, stepIndex, syncMru } from "../src/lib/windowing/mru.ts";
import { announceTimes, OSD_SETTLE_MS, volumeLabel } from "../src/lib/osd.ts";

const { test, finish } = makeHarness("tt56-shell-unit");
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
let seed = 0x56;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
const run = (s: DesktopState, cmds: WindowCommand[]) => cmds.reduce(reduce, s);
const vp = (s: DesktopState) => reduce(s, { t: "viewport", w: 1440, h: 900 });

await test("WM-05 spec acceptance: MRU order after 5 focus changes (open A–E, focus C, A, E, B, D → D B E A C)", { "WM-05": "full" }, async () => {
  let s = vp(initialDesktop());
  for (const m of ["a", "b", "c", "d", "e"]) s = reduce(s, { t: "open", id: `w-${m}`, module: m, title: m.toUpperCase() });
  const id = (t: string) => s.windows.find((w) => w.title === t)!.id;
  s = run(s, ["C", "A", "E", "B", "D"].map((t) => ({ t: "focus", id: id(t) }) as WindowCommand));
  eq(s.mru!.map((x) => s.windows.find((w) => w.id === x)!.title), ["D", "B", "E", "A", "C"], "mru");
  eq(switchItems(s, "window").map((i) => i.label), ["D", "B", "E", "A", "C"], "window-mode items");
  eq(initialIndex(5), 1, "the overlay preselects the previous window");
  // one-shot cycle (no held modifier) goes to the previous window and toggles
  const c1 = reduce(s, { t: "cycle", dir: 1 }); eq(c1.windows.find((w) => w.id === c1.focus)!.title, "B", "cycle → previous");
  const c2 = reduce(c1, { t: "cycle", dir: 1 }); eq(c2.windows.find((w) => w.id === c2.focus)!.title, "D", "cycle again toggles back");
});

await test("WM-05 property: over 400 random command sequences MRU is a permutation of the live windows, focus is its head, and it equals a reference model", { "WM-05": "full" }, async () => {
  let opens = 0;
  for (let trial = 0; trial < 400; trial++) {
    let s = vp(initialDesktop());
    let ref: string[] = [];                        // reference: newest first, maintained from the observable focus changes only
    for (let step = 0; step < 30; step++) {
      const ids = s.windows.map((w) => w.id);
      const pick = () => ids[rnd(ids.length)];
      const r = rnd(10);
      const cmd: WindowCommand | null = ids.length === 0 || r === 0 ? ({ t: "open", id: `t${trial}-${step}`, module: ["notes", "clock", "calculator"][rnd(3)], title: `w${step}` })
        : r === 1 ? { t: "close", id: pick() } : r === 2 ? { t: "minimize", id: pick() } : r === 3 ? { t: "restore", id: pick() }
        : r === 4 ? { t: "cycle", dir: rnd(2) ? 1 : -1 } : r === 5 ? { t: "switchWorkspace", workspace: 1 + rnd(3) }
        : r === 6 ? { t: "toWorkspace", id: pick(), workspace: 1 + rnd(3) } : r === 7 ? { t: "tile", id: pick(), slot: "left" } : { t: "focus", id: pick() };
      if (!cmd) continue;
      const prevFocus = s.focus;
      s = reduce(s, cmd); if (cmd.t === "open") opens++;
      // reference model: drop closed windows, append unknown, move the focused window to the front whenever it gains focus
      // or a focus-giving command targets it
      const live = new Set(s.windows.map((w) => w.id));
      ref = ref.filter((x) => live.has(x));
      for (const w of [...s.windows].sort((a, b) => b.z - a.z)) if (!ref.includes(w.id)) ref.push(w.id);
      const gives = ["open", "focus", "restore", "tile", "place"].includes(cmd.t);
      if (s.focus && (s.focus !== prevFocus || gives)) ref = [s.focus, ...ref.filter((x) => x !== s.focus)];
      const mru = s.mru ?? [];
      eq([...mru].sort(), [...live].sort(), `trial ${trial} step ${step}: mru is not a permutation`);
      if (s.focus) eq(mru[0], s.focus, `trial ${trial} step ${step}: focus is not the MRU head`);
      eq(mru, ref, `trial ${trial} step ${step} (${cmd.t}): mru ≠ reference`);
      ok(s.wsMru && s.wsMru[0] === s.activeWorkspace, "active workspace heads wsMru");
    }
  }
  ok(opens > 1000, `only ${opens} opens exercised`);
});

await test("WM-05 modes: app mode groups by module (newest window per app), workspace mode lists workspaces MRU-first; step wraps both ways", { "WM-05": "full" }, async () => {
  let s = vp(initialDesktop());
  for (const [m, t] of [["calculator", "Calc 1"], ["notes", "Notes"], ["calculator", "Calc 2"], ["clock", "Clock"]]) s = reduce(s, { t: "open", id: `w-${t}`, module: m, title: t });
  const id = (t: string) => s.windows.find((w) => w.title === t)!.id;
  s = run(s, [{ t: "focus", id: id("Calc 1") }, { t: "focus", id: id("Clock") }]);
  const apps = switchItems(s, "app", (m) => m.toUpperCase());
  eq(apps.map((a) => [a.label, a.sub, s.windows.find((w) => w.id === a.winId)!.title]), [["CLOCK", "1 window", "Clock"], ["CALCULATOR", "2 windows", "Calc 1"], ["NOTES", "1 window", "Notes"]], "app items");
  s = run(s, [{ t: "switchWorkspace", workspace: 3 }, { t: "switchWorkspace", workspace: 2 }]);
  eq(switchItems(s, "workspace").map((w) => w.workspace), [2, 3, 1], "workspace MRU");
  eq(switchItems(s, "window"), [], "workspace 2 has no windows");
  eq([stepIndex(0, 4, -1), stepIndex(3, 4, 1), stepIndex(0, 0, 1)], [3, 0, 0], "wrap");
  // a state saved before TT56 (no mru) is completed in z order
  eq(syncMru(undefined, [{ id: "a", z: 1 }, { id: "b", z: 9 }, { id: "c", z: 5 }]), ["b", "c", "a"], "z-order fallback");
  const hydrated = reduce(s, { t: "hydrate", state: { ...s, mru: undefined, wsMru: undefined } });
  eq([...hydrated.mru!].sort(), s.windows.map((w) => w.id).sort(), "hydrate rebuilds mru");
});

await test("NC-06 settle model: 20 events 50 ms apart announce once; bursts separated by > settle announce once each; labels", { "NC-06": "full" }, async () => {
  const burst = Array.from({ length: 20 }, (_, i) => 1000 + i * 50);
  eq(announceTimes(burst), [1000 + 19 * 50 + OSD_SETTLE_MS], "one announcement");
  eq(announceTimes([...burst, 5000, 5100]).length, 2, "two bursts");
  eq([volumeLabel(0.456, false), volumeLabel(0.8, true), volumeLabel(0, false)], ["Volume 46%", "Muted", "Muted"], "labels");
});

await finish();
process.exit(0);
