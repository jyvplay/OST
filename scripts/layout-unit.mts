/**
 * Suite "layout-unit" (TT25): the parts of the Business / Art layouts that can be checked without a browser.
 *   - dock magnification maths (dockScales): peak, symmetry, monotone falloff, reach, no feedback, degenerate input
 *   - dock fitting (fitIconSize / dockWidth): fits when it can, clamps, never negative
 *   - taskbar click behaviour (taskbarAction): open / minimise focused single window / cycle / bring forward
 *   - "Show desktop" reducer command: hides only visible windows of the active workspace, restores exactly those,
 *     forgets after a focus/open, survives invariants, no-op on an empty desk
 *   - settings validation for appearance.layout / appearance.dockMagnify, routine command list, seed rows
 *   - the two TT25 professional styles exist with their own finishes and wallpapers
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/layout-unit.mts
 */
import { readFileSync, existsSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { dockScales, fitIconSize, dockWidth, taskbarAction, LAYOUT_IDS, DEFAULT_LAYOUT, isLayout, layoutOf, DOCK_MAX_SCALE, DOCK_REACH } from "../src/lib/layout-core.ts";
import { initialDesktop, reduce, type DesktopState } from "../src/lib/windowing/state.ts";
import { validateSetting } from "../src/lib/settings-validate.ts";
import { ROUTINE_COMMANDS } from "../src/lib/routines.ts";
import { STYLES, STYLE_IDS } from "../src/lib/style-core.ts";
import { WALLPAPERS } from "../src/lib/appearance.ts";

const { test, finish } = makeHarness("layout-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

await test("dock magnification: peak under the pointer, symmetric, monotone cosine falloff, exact reach, 1 elsewhere", { "LY-02": "full" }, () => {
  const base = 40, gap = 4;
  const centers = Array.from({ length: 21 }, (_, i) => 10 + i * (base + gap) + base / 2);
  const p = centers[10];
  const s = dockScales(centers, p, base);
  ok(near(s[10], DOCK_MAX_SCALE), `peak ${s[10]}`);
  for (let k = 1; k <= 10; k++) ok(near(s[10 - k], s[10 + k]), `symmetry at ±${k}: ${s[10 - k]} vs ${s[10 + k]}`);
  for (let i = 10; i < 20; i++) ok(s[i] >= s[i + 1], `monotone ${i}`);
  const R = DOCK_REACH * base;
  centers.forEach((c, i) => { if (Math.abs(c - p) >= R) ok(s[i] === 1, `outside reach → 1 (icon ${i})`); else ok(s[i] > 1, `inside reach → >1 (icon ${i})`); });
  // midway between two icons both are equally enlarged and neither reaches the peak
  const mid = (centers[4] + centers[5]) / 2, m = dockScales(centers, mid, base);
  ok(near(m[4], m[5]) && m[4] < DOCK_MAX_SCALE && m[4] > 1, `midpoint ${m[4]} ${m[5]}`);
  // closed form at d = R/2 → 1 + (max-1)/2
  const half = dockScales([0], R / 2, base);
  ok(near(half[0], 1 + (DOCK_MAX_SCALE - 1) / 2), `half reach ${half[0]}`);
  // continuity: sweeping the pointer never makes any icon jump by more than a small step
  let prev = dockScales(centers, 0, base), maxJump = 0;
  for (let x = 1; x <= centers[20] + 60; x++) { const cur = dockScales(centers, x, base); cur.forEach((v, i) => { maxJump = Math.max(maxJump, Math.abs(v - prev[i])); }); prev = cur; }
  ok(maxJump < 0.05, `continuous sweep, largest 1-px jump ${maxJump.toFixed(4)}`);
});

await test("dock magnification: no pointer / bad input → all 1; depends only on resting centres (no feedback)", { "LY-02": "full" }, () => {
  const c = [20, 64, 108];
  for (const p of [null, NaN, Infinity]) ok(dockScales(c, p as number | null, 40).every((v) => v === 1), `pointer ${p}`);
  ok(dockScales(c, 64, 0).every((v) => v === 1) && dockScales(c, 64, -5).every((v) => v === 1), "non-positive base");
  ok(dockScales(c, 64, 40, 1).every((v) => v === 1), "magnification off (max = 1)");
  ok(dockScales([], 10, 40).length === 0, "empty dock");
  // same inputs → same output (pure); the grown widths are never an input
  ok(JSON.stringify(dockScales(c, 50, 40)) === JSON.stringify(dockScales(c, 50, 40)), "pure");
});

await test("dock fitting: base size fills the width when possible, clamps to [min,max], reports overflow honestly", { "LY-02": "partial" }, () => {
  const o = { gap: 4, pad: 7, separators: 4, sepWidth: 9, min: 24, max: 56 };
  for (const w of [700, 1000, 1280, 1440, 1920, 2560]) {
    const n = 40, s = fitIconSize(n, w, o), dw = dockWidth(n, s, o);
    ok(s >= 24 && s <= 56, `${w}: size ${s} in range`);
    if (s > 24 && s < 56) ok(dw <= w && dockWidth(n, s + 1, o) > w, `${w}: ${s} is the largest size that fits (${dw} ≤ ${w})`);
  }
  ok(fitIconSize(40, 320, o) === 24 && dockWidth(40, 24, o) > 320, "phone: clamps to min and reports it does not fit (dock scrolls)");
  ok(fitIconSize(3, 3000, o) === 56, "few icons: clamps to max");
  ok(fitIconSize(0, 500, o) === 56 && fitIconSize(10, -50, o) === 24, "degenerate inputs stay in range");
});

await test("taskbar click: open → focus → minimise the focused single window; several windows cycle; minimised comes back", { "LY-01": "full" }, () => {
  ok(taskbarAction([], null).kind === "open", "no window → open");
  const one = [{ id: "a", minimized: false }];
  const r1 = taskbarAction(one, "a"); ok(r1.kind === "minimize" && r1.id === "a", "focused single → minimise");
  const r2 = taskbarAction(one, "zzz"); ok(r2.kind === "focus" && r2.id === "a", "unfocused → focus");
  const r3 = taskbarAction([{ id: "a", minimized: true }], null); ok(r3.kind === "focus" && r3.id === "a", "minimised → bring back");
  const three = [{ id: "a", minimized: false }, { id: "b", minimized: false }, { id: "c", minimized: false }]; // z order, c in front
  const c1 = taskbarAction(three, "c"); ok(c1.kind === "focus" && c1.id === "b", `cycle from front → next behind (${JSON.stringify(c1)})`);
  const c2 = taskbarAction(three, "a"); ok(c2.kind === "focus" && c2.id === "c", "cycle wraps");
  const mix = [{ id: "a", minimized: false }, { id: "b", minimized: true }];
  const m1 = taskbarAction(mix, null); ok(m1.kind === "focus" && m1.id === "a", "prefers the front-most visible window");
});

const open = (s: DesktopState, id: string, ws?: number): DesktopState => {
  let n = s;
  if (ws && ws !== n.activeWorkspace) n = reduce(n, { t: "switchWorkspace", workspace: ws });
  return reduce(n, { t: "open", id, module: "notes", title: id });
};

await test("Show desktop: minimises the visible windows of this workspace, a second press restores exactly those in z-order", { "LY-01": "full" }, () => {
  let s = initialDesktop();
  ok(reduce(s, { t: "showDesktop" }) === s, "empty desk → unchanged state object (no revision bump)");
  s = open(s, "a"); s = open(s, "b"); s = open(s, "c");
  s = reduce(s, { t: "minimize", id: "b" }); // b was already minimised by the user
  s = open(s, "x", 2); s = reduce(s, { t: "switchWorkspace", workspace: 1 });
  s = reduce(s, { t: "focus", id: "a" });
  const zBefore = Object.fromEntries(s.windows.map((w) => [w.id, w.z]));
  const hidden = reduce(s, { t: "showDesktop" });
  ok(hidden.windows.filter((w) => w.workspace === 1).every((w) => w.minimized), "all of workspace 1 minimised");
  ok(!hidden.windows.find((w) => w.id === "x")!.minimized, "other workspace untouched");
  ok(JSON.stringify(hidden.peek) === JSON.stringify(["a", "c"]), `remembers only what it hid: ${JSON.stringify(hidden.peek)}`);
  ok(hidden.revision === s.revision + 1, "one revision");
  const back = reduce(hidden, { t: "showDesktop" });
  ok(!back.windows.find((w) => w.id === "a")!.minimized && !back.windows.find((w) => w.id === "c")!.minimized, "a and c back");
  ok(back.windows.find((w) => w.id === "b")!.minimized, "b stays minimised (the user minimised it, not Show desktop)");
  ok(back.focus === "a", `focus returns to the front-most restored window (${back.focus})`);
  ok(back.windows.every((w) => w.z === zBefore[w.id]), "z-order unchanged");
  ok(back.peek === undefined, "peek cleared");
});

await test("Show desktop: opening or focusing a window in between forgets the restore set; viewport changes keep it", { "LY-01": "partial" }, () => {
  let s = initialDesktop(); s = open(s, "a"); s = open(s, "b");
  const hidden = reduce(s, { t: "showDesktop" });
  ok(reduce(hidden, { t: "viewport", w: 1000, h: 700 }).peek?.length === 2, "viewport keeps it");
  const afterOpen = reduce(hidden, { t: "open", id: "c", module: "notes", title: "c" });
  ok(afterOpen.peek === undefined, "open clears it");
  const again = reduce(afterOpen, { t: "showDesktop" });
  ok(again.windows.find((w) => w.id === "c")!.minimized && JSON.stringify(again.peek) === JSON.stringify(["c"]), "next press hides the new window only");
  const afterFocus = reduce(hidden, { t: "focus", id: "a" });
  ok(afterFocus.peek === undefined && !afterFocus.windows.find((w) => w.id === "a")!.minimized, "focus clears it");
  // closed windows are skipped on restore
  const closed = reduce(hidden, { t: "close", id: "a" });
  const r = reduce(closed, { t: "showDesktop" });
  ok(!r.windows.find((w) => w.id === "b")!.minimized && r.windows.length === 1, "restores survivors only");
  // the field survives a hydrate round trip through JSON (it is persisted with the desktop state)
  const h = reduce(initialDesktop(), { t: "hydrate", state: JSON.parse(JSON.stringify(hidden)) });
  ok(h.peek?.length === 2 && !reduce(h, { t: "showDesktop" }).windows.some((w) => w.minimized), "persisted state restores after reload");
});

await test("settings, routines and seed: layout values validated, default stays Fusion, rows registered", { "LY-03": "full" }, () => {
  ok(JSON.stringify(LAYOUT_IDS) === JSON.stringify(["fusion", "business", "art"]) && DEFAULT_LAYOUT === "fusion", "ids + default");
  for (const id of LAYOUT_IDS) ok(validateSetting("appearance.layout", id) === null && isLayout(id), id);
  for (const bad of ["", "windows", "mac", "Business", "art ", "fusion;"]) ok(validateSetting("appearance.layout", bad) !== null && !isLayout(bad), `refused ${JSON.stringify(bad)}`);
  ok(layoutOf(undefined) === "fusion" && layoutOf("nope") === "fusion" && layoutOf("art") === "art", "layoutOf falls back to the default");
  ok(validateSetting("appearance.dockMagnify", "on") === null && validateSetting("appearance.dockMagnify", "off") === null && validateSetting("appearance.dockMagnify", "yes") !== null, "dockMagnify on/off");
  ok((ROUTINE_COMMANDS as readonly string[]).includes("layout"), "routine command");
  const seed = readFileSync("src/db/seed.ts", "utf8");
  ok(/key: "appearance\.layout", value: "fusion"/.test(seed) && /key: "appearance\.dockMagnify", value: "on"/.test(seed), "seed rows with defaults");
  ok(/aliases: "[^"]*taskbar[^"]*dock[^"]*"/.test(seed.split("\n").find((l) => l.includes('"appearance.layout"')) ?? ""), "searchable by taskbar/dock");
});

await test("TT25 professional styles: Enterprise (flat, Windows-like) and Graphite (aluminium, macOS-like) with their own wallpapers", { "LY-04": "full" }, () => {
  ok(STYLE_IDS.includes("enterprise") && STYLE_IDS.includes("graphite"), "ids");
  ok(STYLES.enterprise.finish === "flat" && STYLES.graphite.finish === "alu", "finishes");
  for (const id of ["enterprise", "graphite"] as const) {
    const wp = STYLES[id].wallpaper;
    ok(WALLPAPERS.some((w) => w.id === wp), `${id} wallpaper listed`);
    ok(existsSync(`public/wallpapers/${wp}.svg`), `${id} wallpaper file`);
    ok(readFileSync("src/app/globals.css", "utf8").includes(`.fs-wallpaper-${wp} {`), `${id} wallpaper class`);
    const svg = readFileSync(`public/wallpapers/${wp}.svg`, "utf8");
    ok(svg.startsWith("<svg") && !/<script|href="http|on[a-z]+=/i.test(svg), `${id} wallpaper is inert SVG`);
  }
  // professional = restrained: enterprise tiles are flat (top ≈ bottom), graphite tiles share one aluminium stock
  const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  for (const p of Object.values(STYLES.enterprise.palettes)) ok(Math.abs(lum(p.top) - lum(p.bottom)) < 48 && p.fg === "#ffffff", `flat tile ${p.top}/${p.bottom}`);
  ok(new Set(Object.values(STYLES.graphite.palettes).map((p) => p.top + p.bottom)).size === 1, "one aluminium stock");
  ok(STYLES.graphite.chrome.win.join() === "#febc2e,#28c840,#ff5f57", "macOS traffic-light colours for the Fusion-layout bubbles");
});

finish();
