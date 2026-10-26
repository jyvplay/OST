/**
 * TT57 unit checks for pure logic added this tier:
 *   PR-12 clipboard history operations vs an independent reference model (random sequences of copy / pin / remove /
 *         clear, sensitive entries, the size cap), plus hand cases.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt57-units.mts
 */
import { makeHarness } from "./harness.mts";
import { addClip, removeClip, togglePin, clearUnpinned, filterClips, ordered } from "../src/lib/cliphistory.ts";
import type { ClipEntry } from "../src/components/shell-context.tsx";

const { test, finish } = makeHarness("tt57-units");
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

await test("PR-12 hand cases: dedupe moves to top keeping the pin; sensitive never deduped/pinned; cap spares pinned; clear keeps pinned; search text+source", { "PR-12": "full" }, () => {
  const E = (text: string, at: number, from = "calc", sensitive = false): ClipEntry => ({ text, at, from, sensitive });
  let l: ClipEntry[] = [];
  l = addClip(l, E("a", 1)); l = addClip(l, E("b", 2)); l = togglePin(l, 1); l = addClip(l, E("a", 3));
  eq(l.map((c) => [c.text, c.at, !!c.pinned]), [["a", 3, true], ["b", 2, false]], "re-copy moves to top, keeps pin");
  l = addClip(l, E("••••", 4, "vault", true)); l = addClip(l, E("••••", 5, "vault", true)); l = togglePin(l, 5);
  eq(l.filter((c) => c.sensitive).map((c) => [c.at, !!c.pinned]), [[5, false], [4, false]], "sensitive: no dedupe, no pin");
  let cap: ClipEntry[] = []; cap = addClip(cap, E("p", 1), 3); cap = togglePin(cap, 1);
  for (let i = 2; i < 10; i++) cap = addClip(cap, E(`x${i}`, i), 3);
  eq(cap.map((c) => c.text), ["x9", "x8", "p"], "cap 3: pinned kept + 2 newest unpinned");
  eq(ordered(cap).map((c) => c.text), ["p", "x9", "x8"], "pinned first");
  eq(clearUnpinned(cap).map((c) => c.text), ["p"], "clear");
  eq(filterClips([E("Hello", 1, "files"), E("bye", 2, "Calculator")], "CALC").map((c) => c.text), ["bye"], "search source");
  eq(filterClips([E("Hello", 1)], " hell ").map((c) => c.text), ["Hello"], "search text trimmed, case-insensitive");
  eq(removeClip(cap, 1).map((c) => c.text), ["x9", "x8"], "remove");
});

await test("PR-12 600 random operations = independent reference model (set semantics written separately)", { "PR-12": "full" }, () => {
  let seed = 7; const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  for (let trial = 0; trial < 6; trial++) {
    const MAX = 2 + rnd(5);
    let l: ClipEntry[] = [];
    // reference: arrays of {text,at,pinned,sensitive}; recency order = descending last-touch time
    type R = { text: string; at: number; pinned: boolean; sensitive: boolean };
    let ref: R[] = [];
    let t = 0;
    for (let step = 0; step < 100; step++) {
      const op = rnd(10);
      if (op < 6) {
        const sensitive = rnd(6) === 0; const text = sensitive ? "•••" : `t${rnd(6)}`; t++;
        l = addClip(l, { text, at: t, from: "x", sensitive }, MAX);
        const old = sensitive ? undefined : ref.find((r) => !r.sensitive && r.text === text);
        ref = ref.filter((r) => r !== old);
        ref.unshift({ text, at: t, pinned: old?.pinned ?? false, sensitive });
        // evict the OLDEST unpinned entries beyond the cap
        while (ref.filter((r) => !r.pinned).length > Math.max(0, MAX - ref.filter((r) => r.pinned).length)) { const idx = ref.map((r) => !r.pinned).lastIndexOf(true); ref.splice(idx, 1); }
      } else if (op < 8 && ref.length) {
        const pick = ref[rnd(ref.length)]; l = togglePin(l, pick.at); if (!pick.sensitive) pick.pinned = !pick.pinned;
      } else if (op === 8 && ref.length) {
        const pick = ref[rnd(ref.length)]; l = removeClip(l, pick.at); ref = ref.filter((r) => r !== pick);
      } else { l = clearUnpinned(l); ref = ref.filter((r) => r.pinned); }
      eq(l.map((c) => [c.text, c.at, !!c.pinned]), ref.map((r) => [r.text, r.at, r.pinned]), `trial ${trial} step ${step} op ${op}`);
      eq(new Set(l.filter((c) => !c.sensitive).map((c) => c.text)).size, l.filter((c) => !c.sensitive).length, "no duplicate texts");
    }
  }
});

await finish();
process.exit(0);
