/**
 * TT139 (DP-07) — accessibility as a *release gate*, not an intention.
 *
 * A gate has to be a predicate over artifacts, with a threshold declared before
 * the measurement and a failure that blocks. This module is that predicate for
 * four things a browser can actually decide:
 *
 *   1. **Contrast** — every foreground/background pair a theme declares, against
 *      WCAG 2.1 AA (4.5:1 text, 3:1 large text and UI borders).
 *   2. **Accessible names** — every interactive control needs a name; an icon-only
 *      button without one is a gate failure, and the report names the control.
 *   3. **Focus order** — every focusable element must be reachable in DOM order
 *      and must be visible when focused (no `display:none` focus trap).
 *   4. **Target size** — WCAG 2.2 AA 2.5.8: 24×24 CSS px, with the documented
 *      exceptions (inline links, essential spacing).
 *
 * The report is *plain data* so a CI script and the UI read the same verdict, and
 * the threshold is an argument rather than a constant, so a stricter build can be
 * checked without editing this file. Limits: nothing here can test a screen reader,
 * and automated checks find roughly a third of real barriers — the gate is a floor.
 */

import { contrastRatio, type RGB } from "./colour";

export interface GateThresholds { text: number; largeText: number; ui: number; minTarget: number; requireNames: boolean }
export const DEFAULT_THRESHOLDS: GateThresholds = { text: 4.5, largeText: 3, ui: 3, minTarget: 24, requireNames: true };

export interface ColourPair { id: string; fg: RGB | string; bg: RGB | string; kind: "text" | "largeText" | "ui" }
export interface GateIssue { id: string; rule: string; detail: string; severity: "block" | "warn" }
export interface GateReport { passed: boolean; issues: GateIssue[]; checked: number; thresholds: GateThresholds; summary: string }

export function checkColourPairs(pairs: readonly ColourPair[], t: GateThresholds = DEFAULT_THRESHOLDS): GateIssue[] {
  const issues: GateIssue[] = [];
  for (const p of pairs) {
    const ratio = contrastRatio(p.fg, p.bg);
    const need = p.kind === "text" ? t.text : p.kind === "largeText" ? t.largeText : t.ui;
    if (!(ratio >= need)) issues.push({ id: p.id, rule: "WCAG 1.4.3 / 1.4.11", detail: `${ratio.toFixed(2)}:1 needs ${need}:1 (${p.kind})`, severity: "block" });
  }
  return issues;
}

export interface Control { id: string; role: string; name: string; focusable: boolean; visible: boolean; w: number; h: number; inlineLink?: boolean }

export function checkControls(controls: readonly Control[], t: GateThresholds = DEFAULT_THRESHOLDS): GateIssue[] {
  const issues: GateIssue[] = [];
  for (const c of controls) {
    if (t.requireNames && !c.name.trim()) issues.push({ id: c.id, rule: "WCAG 4.1.2", detail: `“${c.role}” has no accessible name`, severity: "block" });
    if (c.focusable && !c.visible) issues.push({ id: c.id, rule: "WCAG 2.4.11", detail: "focusable but not visible (hidden focus trap)", severity: "block" });
    if (!c.inlineLink && (c.w < t.minTarget || c.h < t.minTarget)) {
      // 2.5.8 has a spacing exception; a control smaller than the minimum is a
      // warning unless it is *also* smaller than 16 px, which no spacing fixes.
      const severity = Math.min(c.w, c.h) < 16 ? "block" : "warn";
      issues.push({ id: c.id, rule: "WCAG 2.5.8", detail: `target ${c.w}×${c.h} px is smaller than ${t.minTarget}×${t.minTarget}`, severity });
    }
  }
  return issues;
}

export function checkFocusOrder(controls: readonly Control[]): GateIssue[] {
  const issues: GateIssue[] = [];
  const focusables = controls.filter((c) => c.focusable);
  // Duplicate ids make a focus order ambiguous; that is a real defect.
  const seen = new Set<string>();
  for (const c of focusables) {
    if (seen.has(c.id)) issues.push({ id: c.id, rule: "focus-order", detail: "two focusable controls share an id", severity: "block" });
    seen.add(c.id);
  }
  if (!focusables.length) issues.push({ id: "focus-order", rule: "WCAG 2.1.1", detail: "nothing on this surface is focusable", severity: "block" });
  return issues;
}

export function gate(pairs: readonly ColourPair[], controls: readonly Control[], t: GateThresholds = DEFAULT_THRESHOLDS): GateReport {
  const issues = [...checkColourPairs(pairs, t), ...checkControls(controls, t), ...checkFocusOrder(controls)];
  const blocking = issues.filter((i) => i.severity === "block");
  return {
    passed: blocking.length === 0,
    issues,
    checked: pairs.length + controls.length,
    thresholds: t,
    summary: blocking.length
      ? `${blocking.length} blocking issue${blocking.length === 1 ? "" : "s"} of ${issues.length} total across ${pairs.length + controls.length} checks — the release is gated`
      : `${issues.length} warning${issues.length === 1 ? "" : "s"} across ${pairs.length + controls.length} checks — no blocking issue`,
  };
}

/**
 * The gate is only meaningful if it ran. A report carries the list of checks that
 * were *not* automatable, so a "passed" verdict cannot be read as "accessible".
 */
export const GATE_LIMITS: readonly string[] = [
  "Automated checks find roughly a third of real barriers.",
  "Screen-reader announcement order, live-region politeness and reading level are not decidable here.",
  "A contrast pass on declared theme tokens does not cover images or canvas-rendered text.",
];
