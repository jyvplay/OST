/**
 * TT55 — Files pure models (src/lib/files/model.ts) against independent reference implementations.
 *
 *  selection  random op sequences vs a spec-literal reference (Set + anchor index; Shift = inclusive contiguous
 *             range anchor..target; Ctrl toggles; Ctrl+Shift unions the range; plain click = singleton)
 *  history    random navigate/back/forward sequences vs the browser model (entries[] + index, navigate truncates)
 *  names      copyName never collides, is the SMALLEST free candidate, strips existing "copy N" suffixes
 *  menu       concise ⊂ full, type-to-search = every query word in label+keywords, accent/case folded, order kept
 *  sort       folders first in both directions, numeric-aware names, vs a reference comparator
 *  paths      join/parent/base/crumbs round-trips over random paths
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt55-files-unit.mts
 */
import { makeHarness } from "./harness.mts";
import {
  badName, baseName, clickSelect, copyName, crumbs, emptySel, goBack, goForward, hist, joinPath, keySelect, menuView,
  navigate, parentPath, pruneSel, selectAll, sortNodes, splitExt, type MenuItem, type Sel,
} from "../src/lib/files/model.ts";
import { initialDesktop, reduce, geometryKey, type DesktopState } from "../src/lib/windowing/state.ts";

const { test: test0, finish } = makeHarness("tt55-files-unit");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
let seed = 0x5eed55;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const eqArr = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

await test("FM-15 selection model = spec-literal reference over 3 000 random click / Ctrl / Shift / Ctrl+Shift / keyboard sequences", { "FM-15": "partial" }, async () => {
  for (let trial = 0; trial < 3000; trial++) {
    const order = Array.from({ length: 1 + rnd(12) }, (_, i) => `/d/f${i}`);
    let s: Sel = emptySel();
    // reference state
    let set = new Set<string>(); let anchor: string | null = null;
    for (let step = 0; step < 10; step++) {
      const p = order[rnd(order.length)];
      const kind = rnd(5);
      if (kind === 4) {
        s = selectAll(order); set = new Set(order); anchor = order[0];
      } else {
        const ctrl = kind === 1 || kind === 3, shift = kind === 2 || kind === 3;
        s = clickSelect(s, order, p, { ctrl, shift });
        if (shift && anchor !== null) {
          const a = order.indexOf(anchor), b = order.indexOf(p);
          const range = order.filter((_, i) => i >= Math.min(a, b) && i <= Math.max(a, b));
          set = ctrl ? new Set([...set, ...range]) : new Set(range);
        } else if (ctrl) { if (set.has(p)) set.delete(p); else set.add(p); anchor = p; }
        else { set = new Set([p]); anchor = p; }
      }
      ok(s.paths.length === set.size && s.paths.every((x) => set.has(x)), `trial ${trial} step ${step}: ${JSON.stringify(s.paths)} vs ${JSON.stringify([...set])}`);
      ok(new Set(s.paths).size === s.paths.length, "duplicate paths in the selection");
      ok(s.anchor === anchor, `anchor ${s.anchor} vs ${anchor}`);
    }
  }
  // keyboard: plain arrows select the focused row; Shift extends from the anchor; Ctrl moves focus only; clamps at both ends
  const order = ["a", "b", "c", "d", "e"];
  let s = keySelect(emptySel(), order, 1, {});
  ok(eqArr(s.paths, ["a"]) && s.focus === "a", `first ArrowDown selects the first row: ${JSON.stringify(s)}`);
  s = keySelect(s, order, 1, { shift: true }); s = keySelect(s, order, 1, { shift: true });
  ok(eqArr(s.paths, ["a", "b", "c"]) && s.anchor === "a", `Shift+↓↓ extends: ${JSON.stringify(s)}`);
  s = keySelect(s, order, -1, { shift: true });
  ok(eqArr(s.paths, ["a", "b"]), `Shift+↑ shrinks: ${JSON.stringify(s)}`);
  s = keySelect(s, order, 1, { ctrl: true });
  ok(eqArr(s.paths, ["a", "b"]) && s.focus === "c", `Ctrl+↓ moves focus only: ${JSON.stringify(s)}`);
  s = keySelect(s, order, "end", {}); ok(eqArr(s.paths, ["e"]), "End");
  s = keySelect(s, order, 5, {}); ok(eqArr(s.paths, ["e"]), "clamped at the end");
  s = keySelect(s, order, "home", { shift: true }); ok(eqArr(s.paths, ["a", "b", "c", "d", "e"]), `Shift+Home from e: ${JSON.stringify(s)}`);
  ok(eqArr(pruneSel({ paths: ["a", "x"], anchor: "x", focus: "a" }, order).paths, ["a"]) && pruneSel({ paths: ["x"], anchor: "x", focus: "x" }, order).anchor === null, "prune drops invisible paths and anchors");
  ok(keySelect(emptySel(), [], 1, {}).paths.length === 0, "empty listing");
});

await test("SH-09 back / forward history = browser model (entries + index) over 3 000 random sequences, incl. the 50-entry cap", { "SH-09": "partial" }, async () => {
  for (let trial = 0; trial < 3000; trial++) {
    let h = hist("/");
    let entries = ["/"]; let idx = 0;
    for (let step = 0; step < 80; step++) {
      const k = rnd(4);
      if (k <= 1) {
        const to = `/p${rnd(6)}`;
        h = navigate(h, to);
        if (to !== entries[idx]) { entries = [...entries.slice(0, idx + 1), to]; idx += 1; if (idx > 50) { entries.shift(); idx -= 1; } }
      } else if (k === 2) { h = goBack(h); if (idx > 0) idx -= 1; }
      else { h = goForward(h); if (idx < entries.length - 1) idx += 1; }
      ok(h.cur === entries[idx], `trial ${trial} step ${step}: cur ${h.cur} vs ${entries[idx]}`);
      ok(eqArr(h.back, entries.slice(0, idx)), `back ${JSON.stringify(h.back)} vs ${JSON.stringify(entries.slice(0, idx))}`);
      ok(eqArr(h.fwd, entries.slice(idx + 1)), `fwd ${JSON.stringify(h.fwd)} vs ${JSON.stringify(entries.slice(idx + 1))}`);
    }
  }
});

await test("FM-03 / FM-13 conflict-free names: never in use, the smallest free candidate, copies of copies do not grow, dirs and dotfiles keep their name", { "FM-13": "partial", "FM-03": "partial" }, async () => {
  const cases: [string, string[], boolean, "copy" | "number", string][] = [
    ["a.txt", [], false, "copy", "a.txt"],
    ["a.txt", ["a.txt"], false, "copy", "a copy.txt"],
    ["a.txt", ["a.txt", "a copy.txt"], false, "copy", "a copy 2.txt"],
    ["a copy.txt", ["a.txt", "a copy.txt"], false, "copy", "a copy 2.txt"],
    ["a copy 2.txt", ["a.txt", "a copy.txt", "a copy 2.txt"], false, "copy", "a copy 3.txt"],
    ["Folder", ["Folder"], true, "copy", "Folder copy"],
    ["v1.2", ["v1.2"], true, "copy", "v1.2 copy"],
    ["a.tar.gz", ["a.tar.gz"], false, "copy", "a.tar copy.gz"],
    [".env", [".env"], false, "copy", ".env copy"],
    ["untitled.md", ["untitled.md"], false, "number", "untitled 2.md"],
    ["untitled 2.md", ["untitled.md", "untitled 2.md"], false, "number", "untitled 3.md"],
    ["New folder", ["New folder", "New folder 2"], true, "number", "New folder 3"],
    ["A.txt", ["a.txt"], false, "copy", "A.txt"], // the VFS is case-sensitive
  ];
  for (const [name, taken, dir, style, want] of cases) {
    const got = copyName(name, taken, dir, style);
    ok(got === want, `${name} / ${JSON.stringify(taken)} → ${got}, want ${want}`);
  }
  // property: random taken sets — result not taken, and every smaller candidate IS taken (minimality)
  for (let t = 0; t < 2000; t++) {
    const style = rnd(2) ? "copy" : "number";
    const taken = new Set<string>(["r.md"]);
    for (let n = 1; n <= 12; n++) if (rnd(3)) taken.add(style === "copy" ? `r copy${n === 1 ? "" : ` ${n}`}.md` : `r ${n + 1}.md`);
    const got = copyName("r.md", taken, false, style);
    ok(!taken.has(got), `collision ${got}`);
    const nOf = (s: string) => (style === "copy" ? (s === "r copy.md" ? 1 : Number(/^r copy (\d+)\.md$/.exec(s)?.[1])) : Number(/^r (\d+)\.md$/.exec(s)?.[1]) - 1);
    const n = nOf(got);
    ok(Number.isInteger(n) && n >= 1, `unexpected shape ${got}`);
    for (let m = 1; m < n; m++) ok(taken.has(style === "copy" ? `r copy${m === 1 ? "" : ` ${m}`}.md` : `r ${m + 1}.md`), `${got} is not the smallest free name`);
  }
  ok(eqArr(splitExt("a.tar.gz"), ["a.tar", ".gz"]) && eqArr(splitExt(".env"), [".env", ""]) && eqArr(splitExt("noext"), ["noext", ""]), "splitExt");
  for (const [n, bad] of [["", true], ["  ", true], [".", true], ["..", true], ["a/b", true], ["a\\b", true], ["x".repeat(256), true], ["ok name.txt", false], [".hidden", false], ["ünïcode 文件", false]] as [string, boolean][]) {
    ok(!!badName(n) === bad, `badName(${JSON.stringify(n.slice(0, 20))}) = ${badName(n)}`);
  }
});

await test("FM-06 context-menu model: concise ⊂ full, type-to-search matches every word (label + keywords, case- and accent-folded), order kept", { "FM-06": "partial" }, async () => {
  const items: MenuItem[] = [
    { id: "open", label: "Open", group: "a", concise: true },
    { id: "edit", label: "Edit", group: "a", concise: true, keywords: "text editor" },
    { id: "photos", label: "Open in Photos", group: "a", keywords: "image picture" },
    { id: "clean", label: "Remove metadata (copy)", group: "p", keywords: "exif strip privacy" },
    { id: "enc", label: "Encrypt (SC-07)…", group: "p", keywords: "password vault" },
    { id: "cafe", label: "Café tools", group: "z" },
    { id: "trash", label: "Move to trash", group: "d", concise: true, keywords: "delete" },
  ];
  const ids = (xs: MenuItem[]) => xs.map((x) => x.id).join(",");
  ok(ids(menuView(items, "concise", "")) === "open,edit,trash", ids(menuView(items, "concise", "")));
  ok(ids(menuView(items, "full", "")) === items.map((i) => i.id).join(","), "full = all, in order");
  ok(ids(menuView(items, "concise", "exif")) === "clean", "search reaches beyond the concise set (keywords)");
  ok(ids(menuView(items, "concise", "OPEN")) === "open,photos", "case-folded");
  ok(ids(menuView(items, "concise", "open pho")) === "photos", "every word must match");
  ok(ids(menuView(items, "concise", "cafe")) === "cafe" && ids(menuView(items, "concise", "CAFÉ")) === "cafe", "accent-folded both ways");
  ok(ids(menuView(items, "concise", "zzz")) === "", "no match");
  ok(ids(menuView(items, "concise", "   ")) === "open,edit,trash", "blank query = concise view");
  // property: for random queries made of label substrings, every result contains every word; nothing containing all words is dropped
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  for (let t = 0; t < 500; t++) {
    const src = items[rnd(items.length)]; const hay = `${src.label} ${src.keywords ?? ""}`;
    const a = rnd(hay.length), q = hay.slice(a, a + 1 + rnd(5)).trim();
    if (!q) continue;
    const got = new Set(menuView(items, rnd(2) ? "full" : "concise", q).map((i) => i.id));
    for (const it of items) {
      const want = fold(q).split(/\s+/).every((w) => fold(`${it.label} ${it.keywords ?? ""}`).includes(w));
      ok(got.has(it.id) === want, `query ${JSON.stringify(q)}: ${it.id} ${got.has(it.id)} vs ${want}`);
    }
  }
});

await test("FM-01 sort: folders first in both directions, numeric-aware names, size / date keys, vs a reference comparator", { "FM-01": "partial" }, async () => {
  const mk = (name: string, kind: string, size: number, d: number) => ({ name, kind, size, updatedAt: new Date(2026, 0, d).toISOString() });
  const nodes = [mk("file10.txt", "file", 5, 3), mk("file2.txt", "file", 50, 1), mk("Zeta", "dir", 0, 2), mk("alpha", "dir", 0, 9), mk("File1.txt", "file", 7, 7), mk("b.md", "file", 1, 5)];
  const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(",");
  ok(names(sortNodes(nodes, "name")) === "alpha,Zeta,b.md,File1.txt,file2.txt,file10.txt", names(sortNodes(nodes, "name")));
  ok(names(sortNodes(nodes, "name", true)) === "Zeta,alpha,file10.txt,file2.txt,File1.txt,b.md", `desc keeps folders first: ${names(sortNodes(nodes, "name", true))}`);
  ok(names(sortNodes(nodes, "size")) === "alpha,Zeta,b.md,file10.txt,File1.txt,file2.txt", names(sortNodes(nodes, "size")));
  ok(names(sortNodes(nodes, "date", true)) === "alpha,Zeta,File1.txt,b.md,file10.txt,file2.txt", names(sortNodes(nodes, "date", true)));
  // random property vs reference
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  for (let t = 0; t < 300; t++) {
    const xs = Array.from({ length: 2 + rnd(15) }, (_, i) => mk(`n${rnd(30)}-${i}`, rnd(3) ? "file" : "dir", rnd(100), 1 + rnd(20)));
    const key = (["name", "size", "date"] as const)[rnd(3)]; const desc = !!rnd(2);
    const got = sortNodes(xs, key, desc);
    for (let i = 1; i < got.length; i++) {
      const a = got[i - 1], b = got[i];
      if (a.kind !== b.kind) { ok(a.kind === "dir", "a file before a folder"); continue; }
      const c = key === "size" ? a.size - b.size : key === "date" ? Date.parse(a.updatedAt) - Date.parse(b.updatedAt) : 0;
      const cmp = (c || coll.compare(a.name, b.name)) * (desc ? -1 : 1);
      ok(cmp <= 0, `out of order at ${i}: ${a.name} / ${b.name} (${key}${desc ? " desc" : ""})`);
    }
  }
});

await test("FM-01 paths: join / parent / base / breadcrumbs round-trip over random paths; root never doubles or vanishes", { "FM-01": "partial" }, async () => {
  ok(joinPath("/", "a") === "/a" && joinPath("/a/", "b") === "/a/b" && parentPath("/a") === "/" && parentPath("/") === "/" && baseName("/a/b.txt") === "b.txt", "basics");
  ok(JSON.stringify(crumbs("/")) === JSON.stringify([["/", "/"]]) && JSON.stringify(crumbs("/a/b")) === JSON.stringify([["/", "/"], ["a", "/a"], ["b", "/a/b"]]), "crumbs");
  for (let t = 0; t < 2000; t++) {
    const segs = Array.from({ length: 1 + rnd(5) }, () => ["x", "y z", "ü", "a.b", "%_", "Ω"][rnd(6)]);
    const p = `/${segs.join("/")}`;
    ok(joinPath(parentPath(p), baseName(p)) === p, `round-trip ${p}`);
    const c = crumbs(p);
    ok(c[c.length - 1][1] === p && c.length === segs.length + 1 && c.every(([, q], i) => i === 0 || parentPath(q) === c[i - 1][1]), `crumbs chain ${p}`);
  }
});

await test("WM-08 remembered geometry: close records the normal rect per module|host (restore rect when maximized), the next open reuses it, an explicit rect wins, no exact stacking, fits a smaller viewport, bounded, closeAll records all", { "WM-08": "full" }, async () => {
  let st: DesktopState = { ...initialDesktop(), viewport: { w: 1600, h: 1000 } };
  const open = (id: string, module: string, extra: Record<string, unknown> = {}) => { st = reduce(st, { t: "open", id, module, title: module, ...extra } as never); return st.windows.find((w) => w.id === id)!; };
  const w1 = open("e1", "editor");
  st = reduce(st, { t: "move", id: "e1", x: 333, y: 222 }); st = reduce(st, { t: "resize", id: "e1", w: 901, h: 611 });
  st = reduce(st, { t: "close", id: "e1" });
  ok(JSON.stringify(st.geometry?.[geometryKey("editor", "tab")]) === JSON.stringify({ x: 333, y: 222, w: 901, h: 611 }), `recorded ${JSON.stringify(st.geometry)}`);
  const w2 = open("e2", "editor");
  ok(w2.x === 333 && w2.y === 222 && w2.w === 901 && w2.h === 611, `reopened at the remembered rect: ${JSON.stringify(w2)} (first default was ${w1.x},${w1.y})`);
  const w3 = open("e3", "editor");
  ok(w3.x === 361 && w3.y === 250 && w3.w === 901, `a second window is offset, not stacked: ${w3.x},${w3.y}`);
  const other = open("c1", "clock");
  ok(other.w === 760 && other.h === 520, "another module keeps the defaults");
  const pip = open("p1", "editor", { host: "pip" });
  ok(pip.w === 760, "a different host kind has its own memory");
  const exp = open("x1", "editor", { rect: { x: 10, y: 20, w: 500, h: 400 } });
  ok(exp.x === 10 && exp.y === 20 && exp.w === 500, "an explicit rect wins");
  // registry defaults (what Shell.open passes for every module) must NOT beat the remembered geometry …
  const def = open("d1", "editor", { defaults: { w: 640, h: 480 } });
  ok(def.w === 901 && def.h === 611, `registry defaults lose to remembered geometry: ${def.w}×${def.h}`);
  // … but apply when nothing is remembered; and a partial explicit rect (size only) disables the remembered position
  const fresh = open("f1", "notes", { defaults: { w: 640, h: 480 } });
  ok(fresh.w === 640 && fresh.h === 480, "defaults used when nothing is remembered");
  const before = st.windows.length;
  const part = open("pz", "editor", { rect: { w: 555, h: 444 } });
  ok(part.w === 555 && part.x === 80 + (before % 6) * 36 && part.y === 70 + (before % 6) * 28, `a size-only explicit rect uses the cascade, not the remembered position: ${part.x},${part.y}`);
  // maximized: the restore rect is remembered, not the full-screen one
  st = reduce(st, { t: "move", id: "e2", x: 120, y: 90 }); st = reduce(st, { t: "toggleMax", id: "e2" });
  ok(st.windows.find((w) => w.id === "e2")!.maximized, "maximized");
  st = reduce(st, { t: "close", id: "e2" });
  ok(JSON.stringify(st.geometry?.[geometryKey("editor", "tab")]) === JSON.stringify({ x: 120, y: 90, w: 901, h: 611 }), `restore rect remembered: ${JSON.stringify(st.geometry?.[geometryKey("editor", "tab")])}`);
  // a smaller screen: the remembered rect is fitted inside the desktop
  st = reduce(st, { t: "closeAll" });
  ok(Object.keys(st.geometry ?? {}).length >= 3 && st.geometry?.[geometryKey("clock", "tab")]?.w === 760, `closeAll recorded every window: ${Object.keys(st.geometry ?? {})}`);
  st = { ...st, viewport: { w: 800, h: 600 } };
  const small = open("e9", "editor");
  ok(small.x + small.w <= 800 && small.y + small.h <= 600 && small.w <= 800, `fitted: ${JSON.stringify(small)}`);
  // bounded memory
  for (let i = 0; i < 80; i++) { open(`m${i}`, `mod${i}`); st = reduce(st, { t: "close", id: `m${i}` }); }
  ok(Object.keys(st.geometry ?? {}).length === 64 && !!st.geometry?.[geometryKey("mod79", "tab")] && !st.geometry?.[geometryKey("mod0", "tab")], "bounded to 64, oldest dropped");
});

finish();
