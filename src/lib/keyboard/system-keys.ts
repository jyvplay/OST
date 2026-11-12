/**
 * TT148 (IN-04) — the web's "global hotkeys", told honestly.
 *
 * A page can observe a key press only while it has focus. Fullscreen plus
 * Keyboard Lock is the single exception the platform offers: the browser stops
 * intercepting Escape and a short list of keys for the locked document. That is
 * not an OS-level hotkey — a user who presses the chord in another app will be
 * served by that app — so this module never says "global".
 *
 * Three details make a capture useful rather than a toy:
 *
 *   1. Chords are built from `code`, not `key`. The same physical key produces a
 *      different `key` on AZERTY, Dvorak or a Cyrillic layout; if the app
 *      recorded `key`, a shortcut would move when the user switched layouts.
 *   2. Reserved combinations are named. A capture UI that silently records
 *      Ctrl+W and then never sees it is worse than no capture UI.
 *   3. A capture is a *request*: it reports what the engine can promise and what
 *      it cannot, and conflicts with the app's own bindings are surfaced before
 *      a person tries to save something that shadows them.
 */

export interface KeyEventLike {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** `code` → the label a person reads. Unknown codes fall back to the raw code. */
const CODE_LABEL: Record<string, string> = {
  Space: "Space", Escape: "Esc", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Del",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn", Insert: "Ins",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  NumpadAdd: "Num+", NumpadSubtract: "Num-", NumpadEnter: "NumEnter",
};

/** The physical key, as a label: KeyK → K, Digit1 → 1, F5 → F5, else the code. */
export function codeLabel(code: string): string {
  if (!code) return "";
  if (CODE_LABEL[code]) return CODE_LABEL[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num${code.slice(6)}`;
  return code;
}

/**
 * Canonical chord: modifiers in a fixed order, then the key label.
 * The order is Meta → Ctrl → Alt → Shift, which is the order macOS notation
 * uses and the order this app's own binding table prints, so a chord captured
 * here can be compared with a binding string.
 */
export function chordFromEvent(e: KeyEventLike): { chord: string; label: string; modifierOnly: boolean } {
  const parts: string[] = [];
  if (e.metaKey) parts.push("Meta");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const code = e.code ?? "";
  const modifierOnly = /^(Shift|Control|Alt|Meta)(Left|Right)?$/.test(code) || (!code && !e.key);
  if (!modifierOnly) parts.push(codeLabel(code));
  return { chord: parts.join("+"), label: parts.join("+"), modifierOnly };
}

/**
 * Combinations a browser or window manager consumes before the page sees them.
 * This list is deliberately conservative: it names the ones that are the same on
 * every desktop, and it does not pretend to know a particular OS's habits.
 */
export const RESERVED_CHORDS: { chord: string; why: string }[] = [
  { chord: "Ctrl+W", why: "closes the tab" },
  { chord: "Ctrl+T", why: "opens a new tab" },
  { chord: "Ctrl+N", why: "opens a new window" },
  { chord: "Ctrl+Shift+N", why: "opens a private window" },
  { chord: "Ctrl+Shift+T", why: "reopens a closed tab" },
  { chord: "Ctrl+Tab", why: "switches tabs" },
  { chord: "Ctrl+Shift+Tab", why: "switches tabs backwards" },
  { chord: "Ctrl+Q", why: "quits the browser" },
  { chord: "Ctrl+L", why: "focuses the address bar" },
  { chord: "Ctrl+R", why: "reloads the page" },
  { chord: "Ctrl+Shift+R", why: "force-reloads the page" },
  { chord: "Ctrl+P", why: "opens the print dialog" },
  { chord: "Ctrl+S", why: "opens the save dialog" },
  { chord: "Ctrl+F", why: "opens the browser's find bar" },
  { chord: "Ctrl+D", why: "bookmarks the page" },
  { chord: "Ctrl+J", why: "opens downloads" },
  { chord: "Ctrl+H", why: "opens history" },
  { chord: "Meta+Q", why: "quits the application" },
  { chord: "Meta+W", why: "closes the window" },
  { chord: "Meta+L", why: "focuses the address bar" },
  { chord: "Meta+Tab", why: "switches applications" },
  { chord: "Alt+F4", why: "closes the window" },
  { chord: "Alt+Tab", why: "switches applications" },
  { chord: "Meta+Space", why: "opens the OS launcher on macOS" },
  { chord: "Ctrl+Alt+Delete", why: "is handled by the OS, never by a page" },
];

const RESERVED = new Map(RESERVED_CHORDS.map((r) => [r.chord.toLowerCase(), r.why]));

/** Where a chord really goes, and what that means for a capture. */
export function classifyChord(chord: string, bindings: readonly string[] = []): {
  chord: string;
  usable: boolean;
  reserved: string | null;
  conflict: string | null;
  reason: string;
} {
  if (!chord) return { chord, usable: false, reserved: null, conflict: null, reason: "waiting for a key" };
  const why = RESERVED.get(chord.toLowerCase()) ?? null;
  if (why) return { chord, usable: false, reserved: why, conflict: null, reason: `the browser consumes ${chord} — it ${why}` };
  const clash = bindings.find((b) => b.toLowerCase() === chord.toLowerCase()) ?? null;
  if (clash) return { chord, usable: false, reserved: null, conflict: clash, reason: `${chord} is already this app's own binding` };
  return { chord, usable: true, reserved: null, conflict: null, reason: `${chord} reaches the page while it has focus` };
}

export interface CapturePlan {
  canCapture: boolean;
  /** Keys the browser lets through only inside Keyboard Lock. */
  lockedKeys: string[];
  reason: string;
}

/**
 * What a capture surface can promise.
 *
 * Keyboard Lock is the only API that stops the browser intercepting Escape and
 * the other locked keys, it needs fullscreen, and it is Chromium-only. Outside
 * it, a capture still works for every *unreserved* chord — which is most of
 * them — so the plan says which of the two situations applies instead of
 * refusing to work at all.
 */
export function capturePlan(opts: { keyboardLockAvailable: boolean; fullscreen: boolean; hasPageFocus: boolean }): CapturePlan {
  if (!opts.hasPageFocus) {
    return { canCapture: false, lockedKeys: [], reason: "the page has no focus, so no key press can be observed" };
  }
  if (opts.keyboardLockAvailable && opts.fullscreen) {
    return {
      canCapture: true,
      lockedKeys: ["Escape", "Tab", "Meta", "Alt", "Ctrl", "Shift"],
      reason: "fullscreen with Keyboard Lock: the browser stops consuming the locked keys, so even Esc and Tab arrive here",
    };
  }
  return {
    canCapture: true,
    lockedKeys: [],
    reason: opts.keyboardLockAvailable
      ? "not in fullscreen: reserved browser keys still reach the browser, everything else arrives here"
      : "this engine has no Keyboard Lock: reserved browser keys always reach the browser",
  };
}

/** One line for a settings row: who will see this chord next time. */
export function describeChordCapture(chord: string, plan: CapturePlan): string {
  if (!chord) return plan.reason;
  return plan.lockedKeys.length
    ? `${chord} arrives while this window is fullscreen; outside fullscreen the browser may take it first`
    : `${chord} arrives only while this page has focus; other applications never see it, and it never sees them`;
}
