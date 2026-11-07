/**
 * DP-07 — accessibility is a release gate, not a review note.
 *
 * The claim being made here has to be precise, because it is the kind of claim
 * that is usually false. "Accessible" cannot be established by a script: no
 * automated check can tell whether a label is meaningful, whether a focus order
 * follows the task, or whether a live region announces at the right moment.
 * What CAN be established mechanically is a set of necessary conditions, and a
 * release gate is exactly the right place for necessary conditions.
 *
 * So the gate below enforces what is checkable and REFUSES to bless the rest.
 * Each check declares its own coverage:
 *
 *   "decides"  — a pass is genuinely sufficient for that property (contrast
 *                ratio, glyph presence, a missing alt attribute).
 *   "screens"  — a pass only rules out the mechanical failure; a human still
 *                has to judge (focus order, label wording).
 *
 * The return value never says "accessible". It says which checks passed and
 * which properties remain unverified by this gate, so a green build cannot be
 * mistaken for a finished audit.
 */

/** How much a passing check actually proves. */
export type Coverage = "decides" | "screens";

/** One mechanical check. */
export interface GateCheck {
  id: string;
  /** What property it is about. */
  property: string;
  coverage: Coverage;
  /** Whether it passed. */
  passed: boolean;
  /** What failed, in enough detail to fix it. */
  failures: readonly string[];
  /** Checks that were skipped and why — never silently counted as passes. */
  skipped?: string;
}

export interface GateVerdict {
  /** True if nothing failed. Says nothing about whether the app is accessible. */
  passes: boolean;
  /** Properties this gate genuinely settles when green. */
  decided: string[];
  /** Properties this gate only screens; still need a person. */
  needsHuman: string[];
  /** Checks that were not run. A green build with skips is not a green build. */
  skipped: string[];
  /** Every failure with its detail, so a build log can be acted on. */
  failureDetail: string[];
  /** The one-line statement to print in the build log. */
  summary: string;
}

/**
 * Aggregate the checks into a verdict.
 *
 * A skipped check is NOT a pass. This is the single most important rule here:
 * an a11y suite that silently skips the contrast check because a palette was
 * not found reports green, and the green is a lie. Skips are surfaced and, by
 * default, keep the gate from passing.
 */
export function evaluateGate(checks: readonly GateCheck[], options: { allowSkips?: boolean } = {}): GateVerdict {
  const failures: string[] = [];
  const decided: string[] = [];
  const needsHuman: string[] = [];
  const skipped: string[] = [];

  for (const c of checks) {
    if (c.skipped) {
      skipped.push(`${c.id}: ${c.skipped}`);
      continue;
    }
    if (!c.passed) {
      failures.push(`${c.id} (${c.property}): ${c.failures.length ? c.failures.slice(0, 3).join("; ") : "failed"}`);
      continue;
    }
    if (c.coverage === "decides") decided.push(c.property);
    else needsHuman.push(c.property);
  }

  const passes = failures.length === 0 && (options.allowSkips === true || skipped.length === 0);
  return { passes, decided, needsHuman, skipped, failureDetail: failures, summary: summarise(passes, failures, needsHuman, skipped) };
  // (failures carry file-level detail; the summary only counts them so a build
  // log stays one line, but GateVerdict does not drop them)
}

function summarise(passes: boolean, failures: string[], needsHuman: string[], skipped: string[]): string {
  const parts: string[] = [];
  parts.push(passes ? "A11Y GATE: pass" : "A11Y GATE: FAIL");
  if (failures.length) parts.push(`${failures.length} check(s) failed`);
  if (skipped.length) parts.push(`${skipped.length} check(s) skipped`);
  // The honesty clause. Without it, "A11Y GATE: pass" is read as "accessible".
  parts.push(
    needsHuman.length
      ? `${needsHuman.length} property/properties still need a human: ${needsHuman.slice(0, 4).join(", ")}`
      : "no unverified properties recorded",
  );
  return parts.join(" · ");
}

/**
 * Slice a string at a code-point boundary.
 *
 * `slice(0, max)` can cut an astral character in half, leaving a lone
 * surrogate that renders as a replacement glyph. A bounded string must still
 * be a valid string.
 */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join("");
}

/** WCAG 2.1 relative luminance. Inputs are 0–255 sRGB channels. */
export function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two sRGB colours, 1..21. */
export function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = luminance(a[0], a[1], a[2]);
  const lb = luminance(b[0], b[1], b[2]);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The contrast a piece of text actually needs.
 *
 * 4.5:1 for body text, 3:1 for large text (≥18.66px bold or ≥24px regular) and
 * for non-text UI components and graphical objects. Getting this wrong in the
 * strict direction fails designs that are fine; getting it wrong in the lenient
 * direction ships 3:1 body copy, which is the common real failure.
 */
export function requiredContrast(sizePx: number, bold: boolean, kind: "text" | "ui"): number {
  if (kind === "ui") return 3;
  const large = bold ? sizePx >= 18.66 : sizePx >= 24;
  return large ? 3 : 4.5;
}

export interface ContrastFinding {
  label: string;
  ratio: number;
  required: number;
  passed: boolean;
}

/** Evaluate a list of colour pairs against their required ratios. */
export function auditContrast(
  pairs: ReadonlyArray<{
    label: string;
    fg: readonly [number, number, number];
    bg: readonly [number, number, number];
    sizePx: number;
    bold: boolean;
    kind?: "text" | "ui";
  }>,
): ContrastFinding[] {
  return pairs.map((p) => {
    const ratio = contrastRatio(p.fg, p.bg);
    const required = requiredContrast(p.sizePx, p.bold, p.kind ?? "text");
    return { label: p.label, ratio: Math.round(ratio * 100) / 100, required, passed: ratio + 1e-9 >= required };
  });
}

/**
 * Parse a CSS colour into sRGB channels.
 *
 * Only the forms this codebase actually uses are supported, and an unsupported
 * form returns null rather than a guessed black — a contrast check against a
 * guessed colour is worse than a skipped one, because it reports a number.
 */
export function parseColor(css: string): [number, number, number] | null {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  const rgb = /^rgba?\(\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)/.exec(s);
  if (rgb) {
    const ch = (v: string) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
    };
    const r = ch(rgb[1]);
    const g = ch(rgb[2]);
    const b = ch(rgb[3]);
    return r === null || g === null || b === null ? null : [r, g, b];
  }
  return null;
}

/**
 * Compose a translucent foreground over an opaque background.
 *
 * Alpha is the most common reason a hand-checked contrast ratio is wrong: the
 * designer checked #fff on #000 and shipped 60 % white on black, which is 4.6:1
 * and not 21:1.
 */
export function over(fg: readonly [number, number, number], alpha: number, bg: readonly [number, number, number]): [number, number, number] {
  const a = Math.max(0, Math.min(1, alpha));
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
  ];
}
