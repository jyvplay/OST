/**
 * TT145 (IN-04) — the web's "global hotkeys", implemented as far as the platform
 * allows and no further.
 *
 * A page cannot register a key combination that fires while another application
 * has focus. There is no API, and there is no plan to add one. What a page CAN do
 * is run a chord that works *whenever the app is in front*, including inside a
 * focused text field and while a modifier is held, and that is what this engine
 * specifies: a latch, not a global hook.
 *
 * The mechanism is a **hold-latch**:
 *   · a chord is a set of modifiers plus one non-modifier key;
 *   · the first keydown that matches opens the latch and `preventDefault`s;
 *   · the latch holds while ANY modifier of the chord is still down, even if the
 *     non-modifier key repeats or a second key is pressed — this is what makes
 *     Alt+Tab-style "hold to cycle" work;
 *   · a `blur` or a `visibilitychange` releases the latch, because a held chord
 *     across a focus loss is the classic stuck-modifier bug;
 *   · Escape inside the latch cancels without committing.
 *
 * Three refusals make it honest: a chord that is a bare printable key is refused
 * (it would swallow typing), a chord the OS reserves is refused with the reason,
 * and two chords with the same signature are refused as ambiguous rather than
 * resolved by order.
 */

export const MAX_CHORDS = 60;

export type Mod = "ctrl" | "alt" | "shift" | "meta";

export interface Chord {
  id: string;
  mods: Mod[];
  /** `KeyboardEvent.key` in its unshifted form, lower-cased for letters. */
  key: string;
  /** Shown in settings, e.g. "Ctrl+Shift+K". */
  label: string;
  /** Where it is allowed to fire. `field` means inside inputs and textareas too. */
  scope: "app" | "field";
}

/** Chords the operating system or the browser owns; registering them is a lie. */
export const RESERVED: { label: string; why: string }[] = [
  { label: "Ctrl+W", why: "the browser closes the tab before the page sees it" },
  { label: "Ctrl+T", why: "the browser opens a tab; the page is never asked" },
  { label: "Ctrl+N", why: "the browser owns new-window" },
  { label: "Ctrl+Tab", why: "tab switching is handled above the page" },
  { label: "Alt+F4", why: "the window manager closes the window" },
  { label: "Meta+Q", why: "the OS quits the application" },
  { label: "Meta+Space", why: "the OS spotlight/launcher owns it" },
  { label: "Ctrl+Alt+Delete", why: "the OS owns the secure attention sequence" },
];

const normKey = (k: string): string => (k.length === 1 ? k.toLowerCase() : k.toLowerCase());

export function makeChord(id: string, mods: Mod[], key: string, scope: "app" | "field" = "app"): Chord {
  if (!key) throw new Error("a chord needs a non-modifier key");
  const lower = normKey(key);
  if (["control", "alt", "shift", "meta", "os"].includes(lower)) throw new Error(`“${key}” is a modifier; a chord needs a non-modifier key as well`);
  if (!mods.length) throw new Error(`“${key}” with no modifier would swallow that character everywhere it is typed`);
  const uniq = [...new Set(mods)].sort();
  const label = [...uniq.map((m) => (m === "meta" ? "Meta" : m === "ctrl" ? "Ctrl" : m === "alt" ? "Alt" : "Shift")), key.length === 1 ? key.toUpperCase() : key].join("+");
  if (RESERVED.some((r) => r.label.toLowerCase() === label.toLowerCase())) throw new Error(`${label} cannot be registered: ${RESERVED.find((r) => r.label.toLowerCase() === label.toLowerCase())!.why}`);
  return { id, mods: uniq, key: lower, label, scope };
}

export const signature = (c: Pick<Chord, "mods" | "key">): string => `${[...c.mods].sort().join("+")}|${c.key}`;

export function register(chords: Chord[], next: Chord): { chords: Chord[]; note: string } {
  const clash = chords.find((c) => signature(c) === signature(next));
  if (clash) throw new Error(`${next.label} is already bound to “${clash.id}”; two actions on one chord is ambiguous, so it is refused rather than resolved by order`);
  if (chords.length >= MAX_CHORDS) throw new Error(`${chords.length} chords is the limit`);
  return { chords: [...chords, next], note: `${next.label} bound to ${next.id}` };
}

export interface Latch { chord: Chord; held: Mod[]; cancelled: boolean; presses: number }

/**
 * Keydown → latch transition. `inField` is supplied by the caller (it knows the
 * DOM); the engine only enforces the scope rule.
 */
export function keydown(latch: Latch | null, chords: Chord[], ev: { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; repeat: boolean; inField: boolean }, reserved: readonly string[] = RESERVED.map((r) => r.label)): { latch: Latch | null; action: "open" | "advance" | "cancel" | "ignore"; note: string } {
  const k = normKey(ev.key);
  if (latch) {
    if (k === "escape") return { latch: { ...latch, cancelled: true }, action: "cancel", note: "cancelled; releasing the modifier commits nothing" };
    // A repeat or any key while the latch is open advances the selection rather
    // than re-matching, which is what makes "hold and tap again" work.
    const stillHeld = latch.chord.mods.every((m) => (m === "ctrl" ? ev.ctrl : m === "alt" ? ev.alt : m === "shift" ? ev.shift : ev.meta));
    if (!stillHeld) return { latch: null, action: "ignore", note: "the chord's modifier was released; the latch closed with nothing committed" };
    return { latch: { ...latch, presses: latch.presses + 1 }, action: "advance", note: "advanced one item" };
  }
  const mods: Mod[] = [...(ev.ctrl ? (["ctrl"] as const) : []), ...(ev.alt ? (["alt"] as const) : []), ...(ev.shift ? (["shift"] as const) : []), ...(ev.meta ? (["meta"] as const) : [])];
  const match = chords.find((c) => c.key === k && signature({ mods, key: k }) === signature(c));
  if (!match) return { latch: null, action: "ignore", note: "no chord matched" };
  const label = [...mods, k].join("+");
  if (reserved.some((r) => r.toLowerCase() === match.label.toLowerCase())) return { latch: null, action: "ignore", note: `${match.label} is reserved above the page` };
  if (ev.inField && match.scope !== "field") return { latch: null, action: "ignore", note: `“${match.id}” is app-scoped and a text field has focus` };
  return { latch: { chord: match, held: mods, cancelled: false, presses: 1 }, action: "open", note: `${match.label} latched` };
}

/** Modifier release commits; a cancel commits nothing. Both close the latch. */
export function release(latch: Latch | null): { commit: boolean; chordId: string | null; note: string } {
  if (!latch) return { commit: false, chordId: null, note: "no latch" };
  if (latch.cancelled) return { commit: false, chordId: null, note: "cancelled by Escape" };
  return { commit: true, chordId: latch.chord.id, note: `${latch.chord.label} committed after ${latch.presses} press${latch.presses === 1 ? "" : "es"}` };
}

/** Focus loss must never leave a latch open; this is the stuck-modifier repair. */
export function blur(): { latch: null; note: string } {
  return { latch: null, note: "focus left the window; the latch is closed so no modifier stays stuck" };
}

/** The truth about what this row is, in the sentence the settings pane shows. */
export function limitsSentence(): string {
  return "chords fire while this app has focus. A page cannot register a system-wide hotkey, so nothing here works while another application is in front";
}
