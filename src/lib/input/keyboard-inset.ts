/**
 * IN-06 — virtual keyboard and IME insets.
 *
 * This is the least glamorous feature in the register and one of the most
 * likely to be visibly wrong: a chat box that the keyboard covers, a layout
 * that jumps 300 px the instant a field is focused, or a scroll position that
 * never comes back.
 *
 * Three surfaces exist and they disagree with each other:
 *
 *   1. `navigator.virtualKeyboard.overlaysContent` — the real API. When it is
 *      true the OS keyboard floats over the page, and `env(keyboard-inset-*)`
 *      gives the exact rectangle.
 *   2. `visualViewport.height` vs `window.innerHeight` — the empirical fallback.
 *      The difference is the keyboard in most mobile browsers, but it is also
 *      the URL bar collapsing and the browser's own chrome, so it overestimates.
 *   3. Nothing at all — a desktop window resize, or a browser that reports none
 *      of this. In that case the honest answer is "unknown", not zero.
 *
 * The model below is pure: the caller samples the DOM and hands in the numbers.
 * Everything here is arithmetic and policy, which is why it can be tested.
 */

/** What the caller could actually measure. Any field may be missing. */
export interface InsetProbe {
  /** `navigator.virtualKeyboard.overlaysContent`, if the API exists. */
  overlaysContent?: boolean;
  /** `env(keyboard-inset-height)` in CSS px, if the browser exposes it. */
  insetHeight?: number;
  /** `env(keyboard-inset-bottom)`. */
  insetBottom?: number;
  /** `window.innerHeight`, CSS px. */
  innerHeight?: number;
  /** `visualViewport.height`, CSS px. */
  visualHeight?: number;
  /** `visualViewport.offsetTop`, CSS px. */
  visualOffsetTop?: number;
  /** True if the active element is a text input — a keyboard is plausible. */
  textFocused?: boolean;
}

/** What the layout should reserve, and how confident we are. */
export interface InsetPlan {
  /** Pixels of bottom padding the layout should reserve. */
  bottom: number;
  /** Pixels of top offset (iOS scrolls the visual viewport). */
  top: number;
  /** Which surface the number came from. */
  source: "virtual-keyboard" | "visual-viewport" | "none";
  /** True when a keyboard is believed to be open. */
  open: boolean;
  /** Why the number should not be trusted at full value, if applicable. */
  caveat: string;
}

/** A keyboard smaller than this is almost certainly browser chrome, not a keyboard. */
export const MIN_KEYBOARD = 120;
/** Above this the "keyboard" is more likely a broken measurement than a real one. */
export const MAX_KEYBOARD = 700;

const finite = (v: number | undefined, fallback = 0): number => (Number.isFinite(v) ? (v as number) : fallback);

/**
 * Decide what the layout should reserve.
 *
 * Ordered by reliability: the real API first, the visual-viewport delta second,
 * and an explicit "I do not know" last. Returning 0 with `source: "none"` is
 * the honest answer when nothing is measurable — the alternative, guessing from
 * a window resize, is what makes a desktop layout jump when a field is focused.
 */
export function planInset(p: InsetProbe): InsetPlan {
  // 1. The real API, when the browser actually floats the keyboard.
  if (p.overlaysContent === true) {
    const h = Math.max(finite(p.insetHeight), finite(p.insetBottom));
    if (h > 0) {
      return {
        bottom: Math.min(h, MAX_KEYBOARD),
        top: 0,
        source: "virtual-keyboard",
        open: true,
        caveat: h > MAX_KEYBOARD ? `Reported inset of ${Math.round(h)} px is larger than any real keyboard; clamped.` : "",
      };
    }
    // The API exists and says the keyboard is closed. That is a real answer.
    return { bottom: 0, top: 0, source: "virtual-keyboard", open: false, caveat: "" };
  }

  // 2. The visual-viewport delta. Only meaningful while a text field has focus,
  // because without focus the delta is usually the URL bar.
  const inner = finite(p.innerHeight);
  const visual = finite(p.visualHeight);
  const top = Math.max(0, finite(p.visualOffsetTop));
  if (inner > 0 && visual > 0) {
    const delta = inner - visual - top;
    if (delta >= MIN_KEYBOARD && p.textFocused !== false) {
      return {
        bottom: Math.min(delta, MAX_KEYBOARD),
        top,
        source: "visual-viewport",
        open: true,
        // Say plainly that this is an estimate: on iOS the delta includes the
        // toolbar, so the reserved space is slightly too tall.
        caveat: "Estimated from visualViewport; may include browser chrome, so the reserved space can be a little too tall.",
      };
    }
  }

  // 3. Nothing measurable. Do not invent a number.
  return {
    bottom: 0,
    top,
    source: "none",
    open: false,
    caveat:
      p.textFocused === true
        ? "A text field is focused but this browser reports no keyboard geometry; scrolling into view is the only guarantee."
        : "",
  };
}

/**
 * How to keep a focused element visible above the keyboard.
 *
 * `scrollIntoView({block:"nearest"})` is not enough on its own: with a floating
 * keyboard the element is technically already visible, so the browser does
 * nothing and the keyboard sits on top of it. The scroll must be computed
 * against the *visible* band, which is what this returns.
 */
export function scrollToReveal(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  reserveBottom: number,
  margin = 8,
): number {
  const visibleBottom = viewportHeight - reserveBottom;
  if (rect.bottom > visibleBottom - margin) {
    // Scroll down by exactly the overhang, so the field sits `margin` above the keyboard.
    return rect.bottom - visibleBottom + margin;
  }
  if (rect.top < margin) {
    // Field is above the top edge (can happen after a scroll); bring it down.
    return rect.top - margin;
  }
  return 0;
}

/**
 * Whether a layout should switch to its compact spacing.
 *
 * Uses the reserved inset, not the window height: a phone with the keyboard
 * open has the same window height as one without, and only the inset changed.
 */
export function shouldCompact(viewportHeight: number, reserveBottom: number, compactBelow = 420): boolean {
  if (!Number.isFinite(viewportHeight)) return false;
  return viewportHeight - Math.max(0, reserveBottom) < compactBelow;
}

/** What to tell the user, in one line, about how the keyboard is being handled. */
export function describeInset(plan: InsetPlan): string {
  if (plan.source === "virtual-keyboard") {
    return plan.open
      ? `Keyboard detected by the VirtualKeyboard API — ${Math.round(plan.bottom)} px reserved.`
      : "VirtualKeyboard API present; the keyboard is closed.";
  }
  if (plan.source === "visual-viewport") {
    return `Keyboard inferred from the visual viewport — about ${Math.round(plan.bottom)} px reserved.`;
  }
  return "This browser does not report keyboard size; fields scroll into view but nothing is reserved.";
}
