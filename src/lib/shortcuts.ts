export type Preset = "hybrid" | "windows" | "mac";

export interface Binding {
  id: string;
  label: string;
  /** combos per preset, in the "Mod+Key" notation used by matchChord */
  hybrid: string;
  windows: string;
  mac: string;
  /** chords the browser keeps for itself unless Keyboard Lock is active */
  reservedBy?: string;
}

export const BINDINGS: Binding[] = [
  { id: "palette", label: "Command palette", hybrid: "Ctrl+Space", windows: "Ctrl+Space", mac: "Meta+Space" },
  { id: "launcher", label: "Launcher", hybrid: "Meta+A", windows: "Meta+A", mac: "Meta+Shift+A" },
  { id: "overview", label: "Overview", hybrid: "Meta+Q", windows: "Meta+Q", mac: "Ctrl+ArrowUp" },
  { id: "switcher", label: "Window switcher", hybrid: "Ctrl+Backquote", windows: "Alt+Tab", mac: "Meta+Backquote", reservedBy: "OS window switcher (Alt+Tab) — needs Keyboard Lock in fullscreen" },
  { id: "closeWindow", label: "Close window", hybrid: "Alt+F4", windows: "Alt+F4", mac: "Meta+W", reservedBy: "Ctrl/Cmd+W closes the browser tab" },
  { id: "tileLeft", label: "Tile left", hybrid: "Meta+ArrowLeft", windows: "Meta+ArrowLeft", mac: "Ctrl+Alt+ArrowLeft" },
  { id: "tileRight", label: "Tile right", hybrid: "Meta+ArrowRight", windows: "Meta+ArrowRight", mac: "Ctrl+Alt+ArrowRight" },
  { id: "maximize", label: "Maximise / restore", hybrid: "Meta+ArrowUp", windows: "Meta+ArrowUp", mac: "Ctrl+Alt+Enter" },
  { id: "snapLayouts", label: "Snap layouts (choose a zone for the window)", hybrid: "Meta+Z", windows: "Meta+Z", mac: "Ctrl+Alt+Z" },
  { id: "minimize", label: "Minimise", hybrid: "Meta+ArrowDown", windows: "Meta+ArrowDown", mac: "Meta+M" },
  { id: "moveWindow", label: "Move window (16 px)", hybrid: "Meta+Shift+Arrows", windows: "Meta+Shift+Arrows", mac: "Ctrl+Shift+Arrows" },
  { id: "resizeWindow", label: "Resize window", hybrid: "Meta+Alt+Arrows", windows: "Meta+Alt+Arrows", mac: "Ctrl+Alt+Shift+Arrows" },
  { id: "workspaceNext", label: "Next workspace", hybrid: "Ctrl+Alt+ArrowRight", windows: "Ctrl+Alt+ArrowRight", mac: "Ctrl+ArrowRight" },
  { id: "files", label: "Open Files", hybrid: "Meta+E", windows: "Meta+E", mac: "Meta+Alt+E" },
  { id: "terminal", label: "Open Terminal", hybrid: "Ctrl+Alt+T", windows: "Ctrl+Alt+T", mac: "Ctrl+Alt+T" },
  { id: "alerts", label: "Alerts", hybrid: "Meta+N", windows: "Meta+N", mac: "Meta+Shift+N", reservedBy: "Ctrl/Cmd+N opens a browser window" },
  { id: "quickPanel", label: "Quick panel", hybrid: "Meta+I", windows: "Meta+I", mac: "Meta+Alt+I" },
  { id: "focusMode", label: "Focus mode", hybrid: "Meta+Shift+F", windows: "Meta+Shift+F", mac: "Meta+Ctrl+F" },
  { id: "emergency", label: "Emergency shutdown (privacy: drop keys, wipe RAM, leave)", hybrid: "Ctrl+Alt+Shift+Backspace", windows: "Ctrl+Alt+Shift+Backspace", mac: "Ctrl+Alt+Shift+Backspace" },
  // TT30 (AX-14): built-in screen reader — Windows Narrator's Ctrl+Win+Enter; VoiceOver's Cmd+F5 on the Mac preset
  { id: "narrator", label: "Narrator (screen reader) on / off", hybrid: "Ctrl+Meta+Enter", windows: "Ctrl+Meta+Enter", mac: "Meta+F5" },
  { id: "cheatsheet", label: "Shortcut sheet", hybrid: "Shift+Slash", windows: "Shift+Slash", mac: "Shift+Slash" },
];

export const comboFor = (b: Binding, preset: Preset) => (preset === "windows" ? b.windows : preset === "mac" ? b.mac : b.hybrid);

/** Chords that the browser itself intercepts; the editor marks them explicitly. */
export const BROWSER_RESERVED = ["Ctrl+T", "Ctrl+N", "Ctrl+W", "Ctrl+Shift+T", "Ctrl+L", "Meta+T", "Meta+N", "Meta+W", "Alt+Tab", "F11"];

export function describeKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  const code = e.code || e.key;
  const key = code.startsWith("Key") ? code.slice(3)
    : code.startsWith("Digit") ? code.slice(5)
    : code;
  parts.push(key);
  return parts.join("+");
}

/**
 * IN-03 (TT67): letter / digit chords are PHYSICAL keys. "Meta+Q" means the key at the QWERTY Q position
 * (KeyboardEvent.code "KeyQ") on every layout, and the UI labels it with what that key types on the user's layout
 * (chordLabel). Until TT67 a letter chord matched EITHER the physical key OR the produced character, so on AZERTY one
 * press could satisfy two chords: physical KeyA (types "q") matched both Meta+A (by code) and Meta+Q (by character),
 * and Meta+Q's own key (types "a") matched Meta+A — the hybrid preset's Overview was unreachable from the keyboard.
 * The produced character is used only when the event carries no code (synthetic events, some IMEs / virtual keyboards).
 */
export function matchChord(e: KeyboardEvent, chord: string): boolean {
  const want = chord.split("+");
  const key = want[want.length - 1];
  const need = (m: string) => want.includes(m);
  if (e.ctrlKey !== need("Ctrl")) return false;
  if (e.altKey !== need("Alt")) return false;
  if (e.shiftKey !== need("Shift")) return false;
  if (e.metaKey !== need("Meta")) return false;
  if (key === "Arrows") return (e.code || e.key).startsWith("Arrow");
  if (key.length === 1) {
    if (e.code) return e.code === codeOfToken(key);
    return e.key.toUpperCase() === key.toUpperCase();
  }
  return (e.code || e.key) === key;
}

/** The KeyboardEvent.code a chord token names: "Q" → "KeyQ", "7" → "Digit7", "Slash" → "Slash". */
export function codeOfToken(tok: string): string {
  if (/^[A-Za-z]$/.test(tok)) return `Key${tok.toUpperCase()}`;
  if (/^[0-9]$/.test(tok)) return `Digit${tok}`;
  return tok;
}
/** Writing-system keys whose printed character depends on the layout (named keys like Enter / F5 / arrows don't). */
export const LAYOUT_CODE = /^(?:Key[A-Z]|Digit[0-9]|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash)$/;
export type LayoutLookup = (code: string) => string | undefined;

/**
 * The label a chord should SHOW on the user's layout: the last token is replaced by the character its physical key
 * types (upper-cased for letters, "+" spelled "Plus" so it can't be read as a separator). Unknown / multi-character
 * values (dead keys, unmapped codes) keep the layout-neutral token.
 */
export function chordLabel(chord: string, layout?: LayoutLookup): string {
  if (!layout || !chord) return chord;
  const parts = chord.split("+");
  const code = codeOfToken(parts[parts.length - 1]);
  if (!LAYOUT_CODE.test(code)) return chord;
  const ch = layout(code);
  if (!ch || [...ch].length !== 1 || /\s/.test(ch)) return chord;
  parts[parts.length - 1] = ch === "+" ? "Plus" : ch.toUpperCase();
  return parts.join("+");
}

/** Physical codes used by any preset's bindings: the only keys the layout learner ever records. */
export const BINDING_CODES: ReadonlySet<string> = new Set(
  BINDINGS.flatMap((b) => [b.hybrid, b.windows, b.mac]).map((c) => codeOfToken(c.split("+").pop() ?? "")).filter((c) => LAYOUT_CODE.test(c)));

/**
 * Learn one (code → unshifted character) pair from a real keydown, for engines without navigator.keyboard
 * (Firefox, Safari) and to follow a layout switched mid-session. Returns null for anything that does not reveal the
 * unshifted character: modified presses (Ctrl / Alt / AltGr / Meta), IME composition, shifted symbols, named keys,
 * secret fields (never learn from a password field), and codes no binding uses.
 */
export function learnLayoutPair(e: { code: string; key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean },
  secret = false, codes: ReadonlySet<string> = BINDING_CODES): [string, string] | null {
  if (secret || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;
  if (!codes.has(e.code) || [...e.key].length !== 1 || /\s/.test(e.key)) return null;
  const cased = e.key.toLowerCase() !== e.key.toUpperCase();
  if (e.shiftKey && !cased) return null; // a shifted symbol is not what the key types unshifted
  return [e.code, cased ? e.key.toLowerCase() : e.key]; // letters: CapsLock / Shift give the upper case of the same key
}

/**
 * Merge a learned pair into a layout table. A layout types each unshifted character on exactly one key, so any
 * OTHER code still mapped to the same character is stale (left from the previous layout) and is dropped — otherwise
 * two different chords could show the same label after a layout switch.
 */
export function mergeLayoutPair(table: Map<string, string>, pair: [string, string]): boolean {
  const [code, ch] = pair;
  let changed = table.get(code) !== ch;
  for (const [c, v] of table) if (c !== code && v === ch) { table.delete(c); changed = true; }
  table.set(code, ch);
  return changed;
}

export function conflicts(preset: Preset): { a: string; b: string; chord: string }[] {
  const seen = new Map<string, string>();
  const out: { a: string; b: string; chord: string }[] = [];
  for (const b of BINDINGS) {
    const chord = comboFor(b, preset);
    const prev = seen.get(chord);
    if (prev) out.push({ a: prev, b: b.id, chord });
    else seen.set(chord, b.id);
  }
  return out;
}
