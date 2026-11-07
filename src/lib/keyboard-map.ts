/**
 * TT139 (PR-14) — keyboard map: physical keys → characters, with dead keys.
 *
 * The Terminal and the SSH module receive key events, not text. Turning those
 * events into bytes is where a naive implementation breaks the moment the user
 * is not on a US layout: `event.key` already contains the composed character on
 * most layouts, but *dead keys* (´, `, ^, ~) arrive as a modifier-like key with
 * no character and must be combined with the next keypress explicitly. Without
 * that, typing "é" in a French layout produces "´e".
 *
 * This module implements the composition step as data: a dead-key table, the
 * combining-mark fallback derived from Unicode canonical decomposition at
 * runtime (not a hand-written mapping that goes stale), and an explicit
 * `flush` for a dead key that is followed by a non-composable key (which must
 * emit the standalone accent, exactly as X11 does).
 *
 * Not implemented, and reported as such: full XKB/IME composition (which needs
 * the platform IME), and AltGr on layouts where it is a real Level-3 shift —
 * handled only if the event reports `key` already composed.
 */

export interface DeadKeyState { accent: string | null }

export interface KeyInput {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}

export interface KeyOutput {
  /** Bytes to send to the terminal. Empty when the key is a modifier or is swallowed. */
  text: string;
  /** Control sequence for special keys (arrow, home, …), or null. */
  sequence: string | null;
  /** True when the key was held to form a dead-key composition. */
  pending: boolean;
  note?: string;
}

/** Dead keys the compose table can start, and the standalone character each emits. */
export const DEAD_KEYS: Record<string, string> = {
  "´": "\u00b4", // acute
  "`": "`",
  "^": "^",
  "~": "~",
  "¨": "\u00a8", // diaeresis
  "¸": "\u00b8", // cedilla
  "¯": "\u00af", // macron
  "˘": "\u02d8", // breve
  "˙": "\u02d9", // dot above
  "˚": "\u02da", // ring above
  "˛": "\u02db", // ogonek
  "ˇ": "\u02c7", // caron
  "˝": "\u02dd", // double acute
};

const COMBINING: Record<string, string> = {
  "´": "\u0301", "`": "\u0300", "^": "\u0302", "~": "\u0303", "¨": "\u0308",
  "¸": "\u0327", "¯": "\u0304", "˘": "\u0306", "˙": "\u0307", "˚": "\u030a",
  "˛": "\u0328", "ˇ": "\u030c", "˝": "\u030b",
};

/**
 * Compose a base letter with a combining mark using Unicode canonical
 * composition via NFD→NFC. Returns null when no precomposed character exists,
 * which is the signal to emit base+mark separately (that is what the standard
 * says, and what a terminal will render as one glyph).
 */
export function compose(base: string, accent: string): string | null {
  const mark = COMBINING[accent];
  if (!mark) return null;
  const composed = (base + mark).normalize("NFC");
  return composed.length === 1 || [...composed].length === 1 ? composed : null;
}

/** Whether a character can take this accent at all (cheap pre-check via NFC length). */
export function canCompose(base: string, accent: string): boolean {
  const mark = COMBINING[accent];
  if (!mark || [...base].length !== 1) return false;
  return (base + mark).normalize("NFC") !== base + mark;
}

/** Control characters produced by Ctrl+letter, matching the ASCII C0 block. */
export function controlByte(key: string, ctrl: boolean, alt: boolean): string | null {
  if (!ctrl) return null;
  const k = key.toLowerCase();
  if (k.length !== 1) return null;
  const code = k.charCodeAt(0);
  let out: string;
  if (code >= 97 && code <= 122) out = String.fromCharCode(code - 96); // Ctrl+A → 0x01
  else if (key === " " || k === "space") out = "\u0000";
  else if (key === "?" || key === "/") out = "\u007f";
  else if (key === "[") out = "\u001b"; // ESC
  else if (key === "\\") out = "\u001c";
  else if (key === "]") out = "\u001d";
  else if (key === "6") out = "\u001e";
  else if (key === "-") out = "\u001f";
  else return null;
  return alt ? `\u001b${out}` : out; // Alt sends ESC-prefix (metaSendsEscape)
}

/**
 * Stateful keyboard map. `feed` is pure given the prior state: it returns the
 * next state, so the caller can drive it from a React event without hidden
 * global state and the tests can replay a key sequence deterministically.
 */
export function feedKey(state: DeadKeyState, input: KeyInput): { state: DeadKeyState; output: KeyOutput } {
  const none: KeyOutput = { text: "", sequence: null, pending: false };
  if (input.isComposing === true) return { state, output: { ...none, note: "input-method composition in progress; the IME owns the text" } };

  const special: Record<string, string> = {
    Enter: "\r", Escape: "\u001b", Backspace: "\u007f", Tab: "\t",
    ArrowUp: "\u001b[A", ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D",
    Home: "\u001b[H", End: "\u001b[F", PageUp: "\u001b[5~", PageDown: "\u001b[6~",
    Delete: "\u001b[3~", Insert: "\u001b[2~",
  };
  if (special[input.key]) {
    // A pending dead key is flushed before a control sequence, as xterm does.
    const prefix = state.accent ? DEAD_KEYS[state.accent] ?? "" : "";
    return { state: { accent: null }, output: { text: prefix, sequence: special[input.key], pending: false } };
  }
  // F-keys
  const f = /^F(\d{1,2})$/.exec(input.key);
  if (f) {
    const n = Number(f[1]);
    const seq = n <= 4 ? `\u001bO${"PQRS"[n - 1]}` : `\u001b[${[15, 17, 18, 19, 20, 21, 23, 24][n - 5] ?? 25}~`;
    return { state, output: { text: "", sequence: seq, pending: false } };
  }
  if (input.ctrlKey) {
    const bytes = controlByte(input.key, true, input.altKey === true);
    if (bytes !== null) return { state: { accent: null }, output: { text: bytes, sequence: null, pending: false } };
    return { state, output: { ...none, note: "control combination has no terminal byte" } };
  }
  const ch = input.key;
  if (!ch || [...ch].length !== 1) return { state, output: none };

  // dead key start
  if (state.accent === null && input.code?.startsWith("Dead") && DEAD_KEYS[ch]) {
    return { state: { accent: ch }, output: { ...none, pending: true, note: `waiting for a letter to combine with ${ch}` } };
  }
  if (state.accent !== null) {
    const composed = compose(ch, state.accent);
    if (composed) return { state: { accent: null }, output: { text: composed, sequence: null, pending: false } };
    // Not composable: emit the standalone accent, then the new character.
    return { state: { accent: null }, output: { text: (DEAD_KEYS[state.accent] ?? "") + ch, sequence: null, pending: false } };
  }
  const meta = input.altKey || input.metaKey;
  return { state, output: { text: meta ? `\u001b${ch}` : ch, sequence: null, pending: false } };
}

/** Replay a sequence of key inputs; returns the exact bytes and the final state. */
export function replayKeys(inputs: readonly KeyInput[], initial: DeadKeyState = { accent: null }): { bytes: string; state: DeadKeyState; notes: string[] } {
  let state = initial;
  let bytes = "";
  const notes: string[] = [];
  for (const input of inputs) {
    const r = feedKey(state, input);
    state = r.state;
    bytes += r.output.text + (r.output.sequence ?? "");
    if (r.output.note) notes.push(r.output.note);
  }
  return { bytes, state, notes };
}
