/**
 * TT142 — DP-07 accessibility as a release gate.
 *
 * The interesting part is not "does contrast pass". It is that a release gate
 * must not be able to report green while having checked nothing: a skipped
 * check is the standard way an a11y suite lies.
 */
import { makeHarness } from "./harness.mts";
import {
  evaluateGate, contrastRatio, requiredContrast, auditContrast, parseColor, over, luminance,
  type GateCheck,
} from "../src/lib/a11y/release-gate.ts";

const { test, finish } = makeHarness("tt142-a11y-gate");
const check = (over_: Partial<GateCheck> = {}): GateCheck => ({
  id: "c", property: "p", coverage: "decides", passed: true, failures: [], ...over_,
});

await test("DP-07 · a skipped check is not a pass", { "DP-07": "full" }, () => {
  // The specific lie: contrast was skipped because a palette was not found, the
  // suite reports green, and the build ships an unreadable screen.
  const v = evaluateGate([check({ id: "contrast", skipped: "palette not found" })]);
  if (v.passes) throw new Error("a build with a skipped check reported pass");
  if (v.skipped.length !== 1) throw new Error("the skip was not surfaced");
  if (!/skipped/.test(v.summary)) throw new Error(`the summary hid the skip: ${v.summary}`);
  // An explicit opt-in can allow skips, but the skip is still reported.
  const allowed = evaluateGate([check({ skipped: "no browser" })], { allowSkips: true });
  if (!allowed.passes) throw new Error("allowSkips did not allow it");
  if (!allowed.skipped.length) throw new Error("allowSkips silenced the report as well");
});

await test("DP-07 · the verdict never claims the app is accessible", { "DP-07": "full" }, () => {
  const v = evaluateGate([check({ property: "focus order", coverage: "screens" })]);
  if (!v.passes) throw new Error("a screening pass should still pass the gate");
  if (!v.needsHuman.includes("focus order")) throw new Error("a screened property was not listed as needing a human");
  if (/accessible$/i.test(v.summary)) throw new Error("the summary claimed accessibility");
  if (!/human/i.test(v.summary)) throw new Error("the summary did not name the remaining human work");
  // A decided property is settled...
  const d = evaluateGate([check({ property: "contrast ratio" })]);
  if (!d.decided.includes("contrast ratio")) throw new Error("a deciding check was not recorded as decided");
  if (d.needsHuman.length) throw new Error("a deciding check was also listed as needing a human");
});

await test("DP-07 · failures are reported with enough detail to fix", { "DP-07": "full" }, () => {
  const v = evaluateGate([check({ id: "glyph", passed: false, failures: ["gear is 2.1:1 on its tile", "note has no glyph"] })]);
  if (v.passes) throw new Error("a failing check passed the gate");
  if (!v.failureDetail.some((f) => /gear is 2\.1:1/.test(f))) throw new Error(`the failure detail was lost: ${JSON.stringify(v.failureDetail)}`);
  if (!/1 check\(s\) failed/.test(v.summary)) throw new Error(`the summary did not count it: ${v.summary}`);
  if (!/FAIL/.test(v.summary)) throw new Error("a failing gate said something other than FAIL");
});

await test("DP-07 · contrast maths matches the WCAG reference values", { "DP-07": "full" }, () => {
  // These are the canonical endpoints: identical colours are 1:1, black on
  // white is 21:1, and the mid-grey that exactly meets 4.5:1 is ~#767676.
  if (contrastRatio([0, 0, 0], [0, 0, 0]) !== 1) throw new Error("identical colours did not give 1:1");
  const bw = contrastRatio([0, 0, 0], [255, 255, 255]);
  if (Math.abs(bw - 21) > 0.01) throw new Error(`black on white gave ${bw}, want 21`);
  const grey = contrastRatio([118, 118, 118], [255, 255, 255]);
  if (grey < 4.5 || grey > 4.6) throw new Error(`#767676 on white gave ${grey}, want ~4.54`);
  // Symmetry: the order of the pair cannot change the ratio.
  if (Math.abs(contrastRatio([255, 255, 255], [0, 0, 0]) - bw) > 1e-9) throw new Error("the ratio is not symmetric");
  // Luminance endpoints.
  if (luminance(0, 0, 0) !== 0) throw new Error("black luminance is not 0");
  if (Math.abs(luminance(255, 255, 255) - 1) > 1e-9) throw new Error("white luminance is not 1");
});

await test("DP-07 · large text is held to 3:1 and body text to 4.5:1", { "DP-07": "full" }, () => {
  if (requiredContrast(16, false, "text") !== 4.5) throw new Error("16 px body text is not held to 4.5:1");
  if (requiredContrast(24, false, "text") !== 3) throw new Error("24 px regular is large text and needs only 3:1");
  if (requiredContrast(18.66, true, "text") !== 3) throw new Error("18.66 px bold is the large-text boundary");
  if (requiredContrast(18, true, "text") !== 4.5) throw new Error("18 px bold is just under the boundary and needs 4.5:1");
  // Non-text UI (a border, an icon) is 3:1 regardless of size.
  if (requiredContrast(12, false, "ui") !== 3) throw new Error("a UI component is not held to 3:1");
});

await test("DP-07 · a translucent colour is composited before it is measured", { "DP-07": "full" }, () => {
  // The most common wrong hand-check: #fff on #000 is 21:1, but 60 % white on
  // black is 4.6:1 — passing body text by 0.1 and nothing more.
  const solid = contrastRatio([255, 255, 255], [0, 0, 0]);
  const composited = over([255, 255, 255], 0.6, [0, 0, 0]);
  const real = contrastRatio(composited, [0, 0, 0]);
  if (real >= solid - 1) throw new Error(`60% white on black measured ${real.toFixed(2)} against ${solid.toFixed(2)} solid — alpha was ignored`);
  // The composite really is 7.37:1, which still passes body text by a wide
  // margin; the point is that the number CHANGED, not that it failed.
  if (Math.abs(real - 7.37) > 0.02) throw new Error(`60% white on black measured ${real.toFixed(2)}, want 7.37`);
  if (Math.abs(solid - 21) > 0.01) throw new Error("solid white changed");
  // The composite itself must be right.
  const half = over([255, 255, 255], 0.5, [0, 0, 0]);
  if (half[0] !== 128) throw new Error(`50% white over black became ${half[0]}`);
  // Out-of-range alpha is clamped, not extrapolated.
  if (over([255, 255, 255], 5, [0, 0, 0])[0] !== 255) throw new Error("alpha >1 was not clamped");
  if (over([255, 255, 255], -5, [0, 0, 0])[0] !== 0) throw new Error("negative alpha was not clamped");
});

await test("DP-07 · colour parsing refuses what it cannot parse", { "DP-07": "full" }, () => {
  // A guessed colour produces a confident, wrong number, which is worse than
  // a skip. Unsupported syntax must return null.
  const cases: Array<[string, [number, number, number] | null]> = [
    ["#fff", [255, 255, 255]],
    ["#000000", [0, 0, 0]],
    ["#1e2a3b", [30, 42, 59]],
    ["#11223344", [17, 34, 51]],
    ["rgb(10, 20, 30)", [10, 20, 30]],
    ["rgba(10,20,30,0.5)", [10, 20, 30]],
    ["red", null],
    ["hsl(0 0% 50%)", null],
    ["var(--fg)", null],
    ["", null],
  ];
  for (const [input, want] of cases) {
    const got = parseColor(input);
    if (want === null) {
      if (got !== null) throw new Error(`"${input}" was parsed as ${JSON.stringify(got)} instead of refused`);
    } else if (!got || got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
      throw new Error(`"${input}" → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
  // Out-of-range channels are clamped rather than trusted.
  const clamped = parseColor("rgb(300, -20, 10)");
  if (!clamped || clamped[0] !== 255 || clamped[1] !== 0) throw new Error(`rgb clamp broken: ${JSON.stringify(clamped)}`);
});

await test("DP-07 · the audit reports each pair against its own requirement", { "DP-07": "full" }, () => {
  const findings = auditContrast([
    { label: "body", fg: [0, 0, 0], bg: [255, 255, 255], sizePx: 14, bold: false },
    // 3.2:1 at 24 px passes (large text)...
    { label: "heading", fg: [140, 140, 140], bg: [255, 255, 255], sizePx: 24, bold: false },
    // ...the same colour at 14 px does not.
    { label: "caption", fg: [140, 140, 140], bg: [255, 255, 255], sizePx: 14, bold: false },
  ]);
  if (!findings[0].passed) throw new Error("black on white failed");
  if (!findings[1].passed) throw new Error(`a 3.2:1 heading at 24 px should pass at 3:1, got ${findings[1].ratio}`);
  if (findings[2].passed) throw new Error("the same grey at 14 px must fail at 4.5:1");
  if (findings[2].required !== 4.5 || findings[1].required !== 3) throw new Error("the requirements were not differentiated");
});

await test("DP-07 · this repo's own text tokens actually pass", { "DP-07": "full" }, () => {
  // A gate that never runs against the real palette is a gate in name only.
  // These are the token values the shell uses for body and muted text.
  const body: Array<[string, string, string, number, boolean]> = [
    ["dim on panel", "#9aa4b2", "#14181d", 13, false],
    ["ink on panel", "#e6e9ee", "#14181d", 13, false],
    ["ink on desk", "#e6e9ee", "#0b0e11", 13, false],
    ["dim on desk", "#9aa4b2", "#0b0e11", 11, false],
  ];
  const findings = auditContrast(
    body.map(([label, fg, bg, sizePx, bold]) => {
      const f = parseColor(fg);
      const b = parseColor(bg);
      if (!f || !b) throw new Error(`could not parse ${fg} / ${bg} — the check would have been skipped`);
      return { label, fg: f, bg: b, sizePx, bold };
    }),
  );
  const failed = findings.filter((f) => !f.passed);
  if (failed.length) {
    throw new Error(`real text tokens fail WCAG: ${failed.map((f) => `${f.label} ${f.ratio}:1 < ${f.required}`).join(", ")}`);
  }
});

finish();
